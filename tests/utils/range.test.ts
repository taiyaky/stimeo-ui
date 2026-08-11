import { describe, expect, it } from "vitest";
import { rangeFraction } from "../../src/utils/range";

/**
 * Unit tests for the range normalization shared by progress, meter, slider, and
 * range-slider. The contracts that matter are the ones a consuming controller
 * cannot restate for itself: a non-zero `min` shifts the origin, invalid ranges
 * are floored to `0`, and even an overflowing finite span stays normalized.
 */
describe("rangeFraction", () => {
  it("normalizes against the span", () => {
    expect(rangeFraction(25, 0, 100)).toBe(0.25);
    expect(rangeFraction(50, 0, 200)).toBe(0.25);
  });

  // With `min = 0` the numerator is the raw value, so only a non-zero `min`
  // distinguishes a shifted origin from an unshifted one.
  it("subtracts a non-zero min from the value", () => {
    expect(rangeFraction(45, 20, 120)).toBe(0.25);
    expect(rangeFraction(-5, -10, 10)).toBe(0.25);
  });

  it("reports the ends exactly", () => {
    expect(rangeFraction(20, 20, 120)).toBe(0);
    expect(rangeFraction(120, 20, 120)).toBe(1);

    const limit = Number.MAX_VALUE;
    expect(rangeFraction(-limit, -limit, limit)).toBe(0);
    expect(rangeFraction(0, -limit, limit)).toBe(0.5);
    expect(rangeFraction(limit, -limit, limit)).toBe(1);
  });

  it("clamps an out-of-range value instead of leaving [0, 1]", () => {
    expect(rangeFraction(250, 0, 100)).toBe(1);
    expect(rangeFraction(-10, 20, 120)).toBe(0);
    expect(rangeFraction(Number.POSITIVE_INFINITY, 0, 100)).toBe(1);
    expect(rangeFraction(Number.NEGATIVE_INFINITY, 0, 100)).toBe(0);
    expect(rangeFraction(Number.NaN, 0, 100)).toBe(0);
  });

  // An empty range divides by zero and an inverted one divides by a negative
  // span; both would otherwise surface through `aria-valuetext`.
  it("floors an empty range to 0 rather than NaN", () => {
    expect(rangeFraction(5, 5, 5)).toBe(0);
  });

  it("floors an inverted or non-finite range to 0", () => {
    expect(rangeFraction(50, 80, 20)).toBe(0);
    // Stimulus parses malformed Number Values as `NaN`; non-finite endpoints
    // likewise cannot describe a finite track.
    expect(rangeFraction(50, Number.NaN, 100)).toBe(0);
    expect(rangeFraction(50, 0, Number.NaN)).toBe(0);
    expect(rangeFraction(50, Number.NEGATIVE_INFINITY, 100)).toBe(0);
    expect(rangeFraction(50, 0, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
