/**
 * Numeric coercion for controllers that accept a number through a Value, an action
 * param, or an event detail.
 *
 * Stimulus decodes action params as JSON when possible and leaves other text
 * untouched. CustomEvent detail can also supply a number or numeric string.
 * The reader accepts those two types while rejecting blank and non-finite input.
 */

import { matchesNumberBounds, type NumberBounds } from "./number_bounds";

/**
 * Reads a finite number or nonblank numeric string; other input returns `null`.
 * Blank strings cannot silently reset a value to zero.
 */
export function toFiniteNumber(raw: unknown): number | null {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  if (typeof raw === "string" && raw.trim().length === 0) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Returns an accepted decoded Number Value or the caller's fallback unchanged.
 * The caller owns the fallback contract; this reader does not parse or write a Value.
 */
export function readNumber(raw: number, fallback: number, bounds: NumberBounds): number {
  return matchesNumberBounds(raw, bounds) ? raw : fallback;
}
