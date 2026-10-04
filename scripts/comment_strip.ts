/**
 * Removes comments from the emitted JavaScript, as a tsup plugin.
 *
 * Every entry is bundled on its own (`splitting: false`), so each one inlines the
 * shared utilities together with their TSDoc, and the same comments repeat across the
 * dist tree. The declaration files keep that TSDoc: they are emitted by a separate
 * pass this plugin never sees, and they are where an editor reads it from.
 *
 * The output stays unminified. Only comments go, and a comment a tool reads stays:
 * - an annotation a bundler reads for tree shaking (`@__PURE__`, `@__NO_SIDE_EFFECTS__`,
 *   `@__KEY__`, also spelled with `#`);
 * - a legal comment, as esbuild recognises one (`/*!`, `//!`, `@license`, `@preserve`);
 * - a `sourceMappingURL` or `sourceURL` directive.
 *
 * Comments are found by parsing the chunk with the TypeScript compiler and scanning
 * only the trivia between its tokens, so text that looks like a comment inside a
 * string, a template or a regular expression is never touched. The stripped chunk is
 * parsed again, and the build fails unless both parse without a syntax error, their
 * token streams are equal — the same kinds and text, with a line break before the same
 * tokens — and the comments left are exactly the kept ones. The chunk's source map is
 * moved along with the code.
 */

import type { Options } from "tsup";
import ts from "typescript";
import { decodeMappingsLine, encodeVlq, type RawSourceMap } from "./source_map";

export type { RawSourceMap } from "./source_map";

/** A tsup plugin; tsup exports the shape only through `Options`. */
type TsupPlugin = NonNullable<Options["plugins"]>[number];

/** A span of the input the strip removes, and the text it leaves in its place. */
export interface StripEdit {
  readonly start: number;
  readonly end: number;
  readonly insert: string;
}

/** A token of a chunk, with the start of the trivia before it. */
interface TokenSpan {
  readonly kind: ts.SyntaxKind;
  readonly fullStart: number;
  readonly start: number;
  readonly end: number;
}

/** One comment of a chunk. */
interface CommentSpan {
  readonly start: number;
  readonly end: number;
  readonly kept: boolean;
}

/** A chunk read as tokens and the comments between them. */
interface ChunkReading {
  readonly tokens: readonly TokenSpan[];
  readonly comments: readonly CommentSpan[];
}

const ANNOTATION = /[@#]__(?:PURE|NO_SIDE_EFFECTS|KEY)__/;
const LEGAL = /^\/[/*]!|@license|@preserve/;
const SOURCE_DIRECTIVE = /^\/[/*][#@]\s*source(?:Mapping)?URL=/;

/** Whether a comment, given with its delimiters, is one a tool reads and the strip keeps. */
export function isKeptComment(text: string): boolean {
  return ANNOTATION.test(text) || LEGAL.test(text) || SOURCE_DIRECTIVE.test(text);
}

function isLineTerminator(ch: string | undefined): boolean {
  return ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029";
}

/** Whitespace that does not end a line. */
function isInlineSpace(ch: string | undefined): boolean {
  return ch !== undefined && !isLineTerminator(ch) && /\s/.test(ch);
}

function hasLineTerminator(text: string): boolean {
  return /[\n\r\u2028\u2029]/.test(text);
}

/**
 * Parses `code` as JavaScript and lists its tokens, the end-of-file token included, and
 * every comment in the trivia before each of them, both in source order. Throws on a
 * syntax error, where the tokens could not be trusted.
 */
function readChunk(code: string, label: string): ChunkReading {
  const file = ts.createSourceFile(
    "chunk.js",
    code,
    { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
    false,
    ts.ScriptKind.JS,
  );
  // The parser's syntax errors are not on the public surface; a parser that stops
  // exposing them fails here rather than letting the check pass unread.
  const syntaxErrors = (file as ts.SourceFile & { parseDiagnostics?: unknown }).parseDiagnostics;
  if (!Array.isArray(syntaxErrors)) {
    throw new Error(`${label}: the TypeScript parser does not expose its syntax errors`);
  }
  if (syntaxErrors.length > 0) {
    throw new Error(`${label}: does not parse as JavaScript, so its comments cannot be found`);
  }

  const tokens: TokenSpan[] = [];
  const visit = (node: ts.Node): void => {
    const children = node.getChildren(file);
    if (children.length === 0) {
      tokens.push({
        kind: node.kind,
        fullStart: node.getFullStart(),
        start: node.getStart(file),
        end: node.getEnd(),
      });
      return;
    }
    for (const child of children) visit(child);
  };
  visit(file);

  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard);
  const comments: CommentSpan[] = [];
  for (const token of tokens) {
    if (token.start === token.fullStart) continue;
    scanner.setText(code, token.fullStart, token.start - token.fullStart);
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
      if (
        kind === ts.SyntaxKind.SingleLineCommentTrivia ||
        kind === ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        const start = scanner.getTokenStart();
        const end = scanner.getTokenEnd();
        comments.push({ start, end, kept: isKeptComment(code.slice(start, end)) });
      }
    }
  }
  return { tokens, comments };
}

/** Whether the line that ends just before `lineStart` holds nothing. */
function isBlankLineBefore(code: string, lineStart: number): boolean {
  if (lineStart === 0) return true;
  let terminator = lineStart - 1;
  if (code[terminator] === "\n" && code[terminator - 1] === "\r") terminator -= 1;
  return terminator === 0 || isLineTerminator(code[terminator - 1]);
}

/** The offset just past the line terminator at `offset`, or `offset` when there is none. */
function pastLineTerminator(code: string, offset: number): number {
  if (code[offset] === "\r" && code[offset + 1] === "\n") return offset + 2;
  return isLineTerminator(code[offset]) ? offset + 1 : offset;
}

/**
 * The edit that removes the comments from `start` to `end`, between which there is only
 * whitespace. Comments alone on their lines take those lines with them, and a blank line
 * that would then follow another blank line goes too; comments that end a line take the
 * spaces before them; anywhere else one run of whitespace stays between the tokens
 * around them, or a line break where the comments held one.
 */
function editForRun(code: string, start: number, end: number): StripEdit {
  let left = start;
  while (left > 0 && isInlineSpace(code[left - 1])) left -= 1;
  let right = end;
  while (right < code.length && isInlineSpace(code[right])) right += 1;
  const startsLine = left === 0 || isLineTerminator(code[left - 1]);
  const endsLine = right === code.length || isLineTerminator(code[right]);

  if (startsLine && endsLine) {
    let stop = pastLineTerminator(code, right);
    if (stop > right && isBlankLineBefore(code, left)) stop = pastLineTerminator(code, stop);
    return { start: left, end: stop, insert: "" };
  }
  if (endsLine) return { start: left, end: right, insert: "" };
  if (startsLine) return { start, end: right, insert: "" };
  if (hasLineTerminator(code.slice(start, end))) return { start: left, end, insert: "\n" };
  if (left < start && right > end) return { start, end: right, insert: "" };
  if (left < start || right > end) return { start, end, insert: "" };
  return { start, end, insert: " " };
}

function planFromReading(code: string, comments: readonly CommentSpan[]): StripEdit[] {
  const edits: StripEdit[] = [];
  let index = 0;
  while (index < comments.length) {
    const first = comments[index];
    index += 1;
    if (first === undefined || first.kept) continue;
    let last = first;
    for (let next = comments[index]; next !== undefined; next = comments[index]) {
      if (next.kept || !/^\s*$/.test(code.slice(last.end, next.start))) break;
      last = next;
      index += 1;
    }
    edits.push(editForRun(code, first.start, last.end));
  }
  return edits;
}

/** The edits that remove every comment of `code` the strip does not keep, in order. */
export function planCommentStrip(code: string): StripEdit[] {
  return planFromReading(code, readChunk(code, "chunk").comments);
}

/** `code` with `edits` (ordered and disjoint) applied. */
export function applyEdits(code: string, edits: readonly StripEdit[]): string {
  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    out += code.slice(cursor, edit.start) + edit.insert;
    cursor = edit.end;
  }
  return out + code.slice(cursor);
}

/**
 * One entry per token: its kind, its text, and whether a line break separates it from
 * the token before, inside a comment or not — what automatic semicolon insertion and
 * the no-line-break restrictions read. The first token has no token before it.
 */
function tokenSignature(code: string, reading: ChunkReading): string[] {
  return reading.tokens.map((token, index) => {
    const lineBreak = index > 0 && hasLineTerminator(code.slice(token.fullStart, token.start));
    return `${token.kind}:${lineBreak ? "1" : "0"}:${code.slice(token.start, token.end)}`;
  });
}

function keptComments(code: string, reading: ChunkReading): string[] {
  return reading.comments.filter((c) => c.kept).map((c) => code.slice(c.start, c.end));
}

function assertSameReading(
  before: string,
  beforeReading: ChunkReading,
  after: string,
  label: string,
): void {
  const afterReading = readChunk(after, label);
  const survivors = afterReading.comments.filter((c) => !c.kept).length;
  if (survivors > 0) throw new Error(`${label}: ${survivors} comment(s) survived the strip`);
  const keptBefore = keptComments(before, beforeReading);
  const keptAfter = keptComments(after, afterReading);
  if (keptBefore.length !== keptAfter.length || keptBefore.some((t, i) => t !== keptAfter[i])) {
    throw new Error(`${label}: the strip changed a comment it keeps`);
  }
  const a = tokenSignature(before, beforeReading);
  const b = tokenSignature(after, afterReading);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      throw new Error(
        `${label}: the strip changed token ${i}: ${JSON.stringify(a[i])} became ${JSON.stringify(b[i])}`,
      );
    }
  }
}

/**
 * Fails unless `after` is `before` without the comments the strip removes: the same
 * token stream, the same kept comments, and no other comment.
 */
export function assertSameProgram(before: string, after: string, label = "chunk"): void {
  assertSameReading(before, readChunk(before, label), after, label);
}

/** The offset at which each line of `code` starts; a source map's lines end at `\n`. */
function lineStarts(code: string): number[] {
  const starts = [0];
  for (let i = code.indexOf("\n"); i !== -1; i = code.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** The line holding `offset`. */
function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * `map`, a source map of `before`, moved onto `after`, which is `before` with `edits`
 * applied. Each mapped position keeps its original position; a position inside a
 * removed span is dropped. Only `mappings` changes.
 */
export function remapSourceMap(
  map: RawSourceMap,
  before: string,
  after: string,
  edits: readonly StripEdit[],
): RawSourceMap {
  const oldStarts = lineStarts(before);
  const newStarts = lineStarts(after);
  const lines: string[][] = Array.from({ length: newStarts.length }, () => []);
  // The absolute value of each relative field as read, and as last written.
  const read = { source: 0, line: 0, column: 0, name: 0 };
  const written = { source: 0, line: 0, column: 0, name: 0 };
  let writtenLine = -1;
  let writtenColumn = 0;
  let editIndex = 0;
  let delta = 0;
  let previousOffset = -1;

  const oldLines = map.mappings.split(";");
  for (let line = 0; line < oldLines.length; line += 1) {
    let column = 0;
    for (const fields of decodeMappingsLine(oldLines[line] ?? "")) {
      column += fields[0] ?? 0;
      if (fields.length >= 4) {
        read.source += fields[1] ?? 0;
        read.line += fields[2] ?? 0;
        read.column += fields[3] ?? 0;
      }
      if (fields.length >= 5) read.name += fields[4] ?? 0;

      const offset = (oldStarts[line] ?? before.length) + column;
      if (offset < previousOffset) throw new Error("the source map's segments are out of order");
      previousOffset = offset;
      for (let edit = edits[editIndex]; edit !== undefined && edit.end <= offset; ) {
        delta += edit.insert.length - (edit.end - edit.start);
        editIndex += 1;
        edit = edits[editIndex];
      }
      const pending = edits[editIndex];
      if (pending !== undefined && pending.start <= offset) continue;

      const moved = offset + delta;
      const newLine = lineOf(newStarts, moved);
      const newColumn = moved - (newStarts[newLine] ?? 0);
      if (newLine !== writtenLine) {
        writtenLine = newLine;
        writtenColumn = 0;
      }
      let segment = encodeVlq(newColumn - writtenColumn);
      writtenColumn = newColumn;
      if (fields.length >= 4) {
        segment += encodeVlq(read.source - written.source);
        segment += encodeVlq(read.line - written.line);
        segment += encodeVlq(read.column - written.column);
        written.source = read.source;
        written.line = read.line;
        written.column = read.column;
      }
      if (fields.length >= 5) {
        segment += encodeVlq(read.name - written.name);
        written.name = read.name;
      }
      lines[newLine]?.push(segment);
    }
  }
  return { ...map, mappings: lines.map((segments) => segments.join(",")).join(";") };
}

function parseMap(map: unknown): RawSourceMap | undefined {
  if (map === null || map === undefined) return undefined;
  const parsed: unknown = typeof map === "string" ? JSON.parse(map) : map;
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Partial<RawSourceMap>;
  return typeof candidate.mappings === "string" && Array.isArray(candidate.sources)
    ? (parsed as RawSourceMap)
    : undefined;
}

/**
 * `code` without the comments the strip removes, and `map` (its source map, when it has
 * one) moved to match. Throws unless the result is the same program
 * ({@link assertSameProgram}).
 */
export function stripComments(
  code: string,
  map?: unknown,
  label = "chunk",
): { code: string; map?: RawSourceMap } {
  const reading = readChunk(code, label);
  const edits = planFromReading(code, reading.comments);
  if (edits.length === 0) return { code };
  const stripped = applyEdits(code, edits);
  assertSameReading(code, reading, stripped, label);
  const parsed = parseMap(map);
  return parsed === undefined
    ? { code: stripped }
    : { code: stripped, map: remapSourceMap(parsed, code, stripped, edits) };
}

/** The tsup plugin: strips every emitted JavaScript chunk. */
export function stripCommentsPlugin(): TsupPlugin {
  return {
    name: "strip-comments",
    renderChunk(code, info) {
      if (!/\.[cm]?js$/.test(info.path)) return;
      return stripComments(code, info.map, info.path);
    },
  };
}
