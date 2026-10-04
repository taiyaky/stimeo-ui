/**
 * The `mappings` field of a source map (version 3): each line of the generated file is
 * a `;`-separated group of `,`-separated segments, and each segment has one, four or five
 * Base64 VLQ fields — the generated column, then the source index, the original line
 * and the original column, then the name index. Every field is stored relative to the
 * same field of the segment before it; the generated column restarts at each line.
 */

/** The source map fields the build reads; every other field is carried over as is. */
export interface RawSourceMap {
  readonly version: number;
  readonly sources: readonly string[];
  readonly mappings: string;
  readonly [field: string]: unknown;
}

/** One segment with every field absolute and zero-based. */
export interface MappedSegment {
  readonly generatedLine: number;
  readonly generatedColumn: number;
  /** The original position; absent on a segment that maps to no source. */
  readonly original?: {
    readonly source: number;
    readonly line: number;
    readonly column: number;
    readonly name?: number;
  };
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUE = new Map([...BASE64].map((ch, i) => [ch, i]));

/** Decodes one line of a `mappings` string into the fields of each segment, still relative. */
export function decodeMappingsLine(line: string): number[][] {
  const segments: number[][] = [];
  for (const segment of line.split(",")) {
    if (segment === "") continue;
    const fields: number[] = [];
    let value = 0;
    let shift = 0;
    for (const ch of segment) {
      const digit = BASE64_VALUE.get(ch);
      if (digit === undefined) throw new Error(`invalid source map character "${ch}"`);
      value += (digit & 31) * 2 ** shift;
      if (digit & 32) {
        shift += 5;
      } else {
        fields.push(value % 2 === 1 ? -(value - 1) / 2 : value / 2);
        value = 0;
        shift = 0;
      }
    }
    segments.push(fields);
  }
  return segments;
}

/** One field as Base64 VLQ. */
export function encodeVlq(value: number): string {
  let vlq = value < 0 ? -value * 2 + 1 : value * 2;
  let out = "";
  do {
    let digit = vlq % 32;
    vlq = Math.floor(vlq / 32);
    if (vlq > 0) digit += 32;
    out += BASE64[digit];
  } while (vlq > 0);
  return out;
}

/** Every segment of `mappings`, in order, with its fields made absolute. */
export function decodeMappings(mappings: string): MappedSegment[] {
  const segments: MappedSegment[] = [];
  let source = 0;
  let line = 0;
  let column = 0;
  let name = 0;
  const lines = mappings.split(";");
  for (let generatedLine = 0; generatedLine < lines.length; generatedLine += 1) {
    let generatedColumn = 0;
    for (const fields of decodeMappingsLine(lines[generatedLine] ?? "")) {
      generatedColumn += fields[0] ?? 0;
      if (fields.length < 4) {
        segments.push({ generatedLine, generatedColumn });
        continue;
      }
      source += fields[1] ?? 0;
      line += fields[2] ?? 0;
      column += fields[3] ?? 0;
      if (fields.length >= 5) {
        name += fields[4] ?? 0;
        segments.push({ generatedLine, generatedColumn, original: { source, line, column, name } });
      } else {
        segments.push({ generatedLine, generatedColumn, original: { source, line, column } });
      }
    }
  }
  return segments;
}

/**
 * Keeps one final external source-map directive and prepares a Node CLI's shebang.
 * All generated positions before the trailing directives stay unchanged. A newly
 * prepended shebang occupies an unmapped line; source locations and names stay intact.
 * Repeating the preparation leaves both the code and the map unchanged.
 */
export function finalizeJavaScriptArtifact(
  code: string,
  map: RawSourceMap,
  sourceMapUrl: string,
  nodeCli = false,
): { code: string; map: RawSourceMap } {
  const directive = `//# sourceMappingURL=${sourceMapUrl}`;
  const lines = code.split(/(?<=\n)/);
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  let start = end;
  while (start > 0 && lines[start - 1]?.replace(/\r?\n$/, "") === directive) start -= 1;
  const finalized =
    end - start > 1
      ? [...lines.slice(0, start), lines[end - 1], ...lines.slice(end)].join("")
      : code;
  const shebang = "#!/usr/bin/env node\n";
  return nodeCli && !finalized.startsWith(shebang)
    ? { code: shebang + finalized, map: { ...map, mappings: `;${map.mappings}` } }
    : { code: finalized, map };
}
