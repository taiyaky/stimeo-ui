/**
 * Numeric coercion shared by the value-bearing status controllers (progress,
 * meter).
 *
 * Stimulus already coerces numeric action params to numbers, but a value can also
 * arrive as a string — via a `*:set` CustomEvent `detail`, or an action param
 * whose attribute does not look numeric. Centralizing the parse keeps `setValue`
 * tolerant of either form while rejecting anything that is not a finite number.
 */

/**
 * Coerces `raw` to a finite number, or returns `null` when it is absent, empty,
 * or not parseable. Empty strings are treated as "no value" rather than `0`, so a
 * stray blank param cannot silently reset the value.
 */
export function toFiniteNumber(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : null;
}
