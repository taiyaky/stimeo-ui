/**
 * Range normalization shared by the value-bearing controllers (progress, meter,
 * slider, range-slider).
 *
 * Each of them publishes "where the value sits inside `[min, max]`" as a CSS
 * custom property the consumer multiplies a track by, and each has to answer the
 * same degenerate cases: empty and inverted ranges cannot express progress, and
 * malformed Number Values can produce `NaN`. Keeping the rule in one place is
 * what makes those answers identical across the four.
 */

/**
 * Fraction of `[min, max]` that `value` occupies, always within `[0, 1]`.
 *
 * `value` is clamped into the range first, so a value outside it reports a full
 * or empty track rather than pushing the fraction past the ends.
 *
 * An empty, inverted, or non-numeric range yields `0`. That is a deliberate
 * floor rather than a computed result: `min === max` would produce `NaN`, and
 * `min > max` would report a full track for a value that is really out of range.
 * Non-finite results are floored for the same reason. These results reach
 * assistive tech, because the same fraction drives the percentage substituted
 * into `aria-valuetext`.
 */
export function rangeFraction(value: number, min: number, max: number): number {
  const span = max - min;
  if (!(span > 0)) return 0;

  const clamped = Math.min(max, Math.max(min, value));
  let fraction: number;
  if (Number.isFinite(span)) {
    fraction = (clamped - min) / span;
  } else {
    // Scaling preserves the ratio when two finite endpoints straddle zero so
    // widely that their subtraction overflows to Infinity.
    const scale = Math.max(Math.abs(min), Math.abs(max));
    fraction = (clamped / scale - min / scale) / (max / scale - min / scale);
  }

  if (!Number.isFinite(fraction)) return 0;
  return Math.min(1, Math.max(0, fraction));
}
