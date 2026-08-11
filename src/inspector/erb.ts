import {
  ERB_ELEMENT_TAG,
  type ParsedAttr,
  PositionIndex,
  type SyntheticElement,
} from "./html_parser";
import { type DataAttribute, readDataOption } from "./ruby_hash";
import {
  endOfLine,
  IDENT_CHAR,
  IDENT_START,
  maskHeredocs,
  readString,
  SPACE,
  skipLiteral,
} from "./ruby_scan";

/**
 * The ERB layer: what the HTML parser is allowed to see of a Rails template.
 *
 * Two complementary passes run over the same source.
 * {@link neutralizeErb} blanks every ERB tag so the parser only ever tokenizes
 * static markup, and {@link erbElements} decodes the one construct that blanking
 * would otherwise erase — a helper call whose `data:` hash renders as the
 * `data-controller` / `data-*-target` / `data-action` attributes the checker
 * exists to check.
 */

/** Matches one ERB tag of any flavor (`<% %>`, `<%= %>`, `<%# %>`, `<%- -%>`). */
const ERB_TAG = /<%[\s\S]*?%>/g;

/**
 * Neutralizes ERB so the HTML parser only ever sees static markup.
 *
 * Every ERB tag — `<% %>`, `<%= %>`, `<%# %>`, plus the whitespace-trimming
 * variants `<%- -%>` — is replaced with spaces. Newlines inside the tag are
 * preserved so that 1-based line/column positions used in diagnostics line up
 * with the original source.
 *
 * Because ERB is blanked rather than interpreted, dynamically-generated markup
 * is naturally excluded from checking: a dynamic identifier such as
 * `data-controller="<%= id %>"` collapses to an empty attribute value and a
 * dynamic attribute name such as `data-<%= x %>-target` no longer matches the
 * `stimeo--*` patterns. This is the intended "dynamic attributes are out of
 * scope" behavior. The literal `data:` hashes {@link erbElements} recovers are
 * the deliberate exception: they are markup an author wrote by hand, merely
 * spelled in Ruby.
 *
 * @param source - Raw HTML/ERB source.
 * @returns The source with all ERB tags replaced by position-preserving spaces.
 */
export function neutralizeErb(source: string): string {
  return source.replace(ERB_TAG, (match) => match.replace(/[^\n]/g, " "));
}

/**
 * `[start, end)` offsets of every ERB tag in the raw source. Neutralization
 * preserves offsets, so a consumer can test a parsed range against these to
 * tell an authored value from a generated one.
 */
export function erbRanges(source: string): Array<readonly [number, number]> {
  return [...source.matchAll(ERB_TAG)].map(
    (match) => [match.index ?? 0, (match.index ?? 0) + match[0].length] as const,
  );
}

/** One ERB tag, split into the parts the passes below need. */
interface ErbTag {
  /** Offset of `<%`. */
  readonly start: number;
  /** Offset just past `%>`. */
  readonly end: number;
  /** Whether the tag renders its expression (`<%=` / `<%==`). */
  readonly output: boolean;
  /** The Ruby source between the delimiters. */
  readonly code: string;
  /** Absolute offset of `code[0]`. */
  readonly codeStart: number;
}

/**
 * Decodes the elements a Rails helper renders from a literal `data:` hash, as
 * {@link SyntheticElement}s the HTML parser can splice into the tree.
 *
 * Only **output** tags (`<%= … %>`) that name a `data:` option produce an
 * element: they are the ones that put a tag on the page. Every other ERB tag
 * stays invisible, exactly as before — a template full of `<% if %>` and
 * `<%= t(".title") %>` parses to the same tree it always did, so the change
 * cannot move a diagnostic that does not involve a `data:` hash.
 *
 * A helper that opens a Ruby block (`form_with … do |f|`) becomes a
 * **container**: the markup up to its matching `<% end %>` nests inside it, so
 * a controller declared on the helper scopes the targets written underneath it.
 * Matching counts the block-opening and block-closing tokens inside every tag,
 * not just the shape of the tag as a whole, so neither an `<% if %>` in between
 * nor a block that opens and closes within one tag can shift the pairing.
 *
 * @param source - Raw HTML/ERB source.
 * @returns Elements ordered by source offset.
 */
export function erbElements(source: string): SyntheticElement[] {
  const tags = readErbTags(source);
  const blockEnds = matchBlocks(tags);
  const index = new PositionIndex(source);
  const elements: SyntheticElement[] = [];

  for (const [ordinal, tag] of tags.entries()) {
    if (!tag.output) continue;
    const option = readDataOption(tag.code, tag.codeStart);
    if (!option.found) continue;
    const end = blockEnds.get(ordinal) ?? tag.end;
    elements.push({
      tag: ERB_ELEMENT_TAG,
      attrs: option.attrs.map((attr) => toParsedAttr(attr, index)),
      start: tag.start,
      // The token a reader can act on is the delimiter that opens the call.
      sourceLength: tag.codeStart - tag.start,
      end,
      container: end > tag.end,
      opaque: option.opaque,
    });
  }
  return elements;
}

/**
 * Renders one decoded hash entry as the attribute the helper emits. The value
 * range is carried over when the Ruby literal is verbatim, so a machine fix
 * rewrites the string in place; `dynamicValue` states outright what the
 * ERB-overlap test cannot decide here, since every one of these offsets lies
 * inside an ERB tag whether the value is a literal or not. The anchored span
 * stays the Ruby key, which is the only spelling of the attribute the source
 * actually contains.
 */
function toParsedAttr(attr: DataAttribute, index: PositionIndex): ParsedAttr {
  const at = index.at(attr.keyStart);
  return {
    name: attr.name,
    value: attr.value ?? "",
    line: at.line,
    column: at.column,
    sourceLength: attr.keyEnd - attr.keyStart,
    valueStart: attr.valueStart,
    valueEnd: attr.valueEnd,
    dynamicValue: attr.value === null,
  };
}

/** Splits the source into ERB tags, dropping comments (`<%# … %>`). */
function readErbTags(source: string): ErbTag[] {
  const tags: ErbTag[] = [];
  for (const match of source.matchAll(ERB_TAG)) {
    const raw = match[0];
    const start = match.index ?? 0;
    let open = 2;
    let output = false;
    if (raw[open] === "#") continue;
    if (raw[open] === "=") {
      output = true;
      open++;
      if (raw[open] === "=") open++;
    } else if (raw[open] === "-") {
      open++;
    }
    let close = raw.length - 2; // at "%>"
    if (raw[close - 1] === "-") close--;
    if (close < open) close = open;
    tags.push({
      start,
      end: start + raw.length,
      output,
      code: raw.slice(open, close),
      codeStart: start + open,
    });
  }
  return tags;
}

/**
 * Pairs every block-opening token with the tag holding the `end` that closes it.
 *
 * @returns Offsets just past the closing tag, keyed by the opener's index in
 *   `tags`. An opener the template never closes is absent, which leaves it a
 *   leaf rather than swallowing the rest of the file.
 */
function matchBlocks(tags: readonly ErbTag[]): Map<number, number> {
  const ends = new Map<number, number>();
  const open: number[] = [];
  for (const [ordinal, tag] of tags.entries()) {
    for (const event of blockEvents(tag.code)) {
      if (event === "open") {
        open.push(ordinal);
        continue;
      }
      const opener = open.pop();
      if (opener !== undefined) ends.set(opener, tag.end);
    }
  }
  return ends;
}

/** Whether a token opens a block or closes one; anything else emits nothing. */
type BlockEvent = "open" | "close";

/** Keywords that open a block wherever they appear. */
const BLOCK_OPENERS = new Set(["case", "begin", "def", "class", "module", "for"]);
/** Keywords that open a block in statement position and modify a value elsewhere. */
const BLOCK_MODIFIERS = new Set(["if", "unless", "while", "until"]);
/** Keywords that continue an open block rather than opening or closing one. */
const BLOCK_CONTINUERS = new Set(["elsif", "else", "when", "in", "then", "rescue", "ensure"]);

/**
 * The block-opening and block-closing tokens one ERB tag contributes, in source
 * order.
 *
 * Reading the tag as a whole — "does it end in `do`?" — is wrong in both
 * directions: a block that opens and closes inside one tag (`<% if a; b; end %>`)
 * would take the `<% end %>` meant for the helper around it, and a `do` that is
 * really a symbol (`mode: :do`) or is followed by a comment would gain or lose a
 * container. Counting tokens instead, with strings, symbols, comments and every
 * literal form stepped over, is what makes the pairing hold.
 */
function blockEvents(source: string): BlockEvent[] {
  const code = maskHeredocs(source);
  const events: BlockEvent[] = [];
  /** The previous significant token: `"value"` when a modifier can follow it. */
  let previous = "";
  /** Whether a `while`/`until`/`for` header is open, making its `do` syntax. */
  let loopHeader = false;
  let i = 0;

  while (i < code.length) {
    const char = code[i] as string;

    if (char === "\n" || char === ";") {
      previous = char;
      loopHeader = false;
      i++;
      continue;
    }
    if (SPACE.has(char)) {
      i++;
      continue;
    }
    if (char === "#") {
      i = endOfLine(code, i);
      previous = "\n";
      loopHeader = false;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      i = readString(code, i).end;
      previous = "value";
      continue;
    }
    // A symbol names a value, never a block: `mode: :do` opens nothing.
    if (char === ":" && IDENT_START.test(code[i + 1] ?? "")) {
      i = identifierEnd(code, i + 1);
      previous = "value";
      continue;
    }
    const literal = skipLiteral(code, i);
    if (literal >= 0) {
      i = literal;
      previous = "value";
      continue;
    }
    if (char === "{") {
      events.push("open");
      previous = "{";
      i++;
      continue;
    }
    if (char === "}") {
      events.push("close");
      previous = "value";
      i++;
      continue;
    }
    if (char === ")" || char === "]") {
      previous = "value";
      i++;
      continue;
    }
    if (!IDENT_START.test(char)) {
      previous = char;
      i++;
      continue;
    }

    const end = identifierEnd(code, i);
    const word = code.slice(i, end);
    // A hash key (`do:`) and a method name (`.end`) wear a keyword's spelling
    // without its meaning.
    const keyword = !(code[end] === ":" && code[end + 1] !== ":") && code[i - 1] !== ".";
    i = end;

    if (keyword && word === "end") {
      events.push("close");
      previous = "value";
    } else if (keyword && word === "do") {
      if (loopHeader) loopHeader = false;
      else events.push("open");
      previous = "do";
    } else if (keyword && BLOCK_OPENERS.has(word)) {
      events.push("open");
      loopHeader = word === "for";
      previous = word;
    } else if (keyword && BLOCK_MODIFIERS.has(word)) {
      // In statement position the keyword opens a block the template must
      // close; after a value it merely qualifies it and closes nothing.
      if (previous !== "value") {
        events.push("open");
        loopHeader = word !== "if" && word !== "unless";
      }
      previous = word;
    } else if (keyword && BLOCK_CONTINUERS.has(word)) {
      previous = word;
    } else {
      previous = "value";
    }
  }
  return events;
}

/** Offset just past the identifier starting at `start`. */
function identifierEnd(code: string, start: number): number {
  let end = start;
  while (end < code.length && IDENT_CHAR.test(code[end] as string)) end++;
  return end;
}
