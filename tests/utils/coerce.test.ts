import { describe, expect, it } from "vitest";
import { readNumber, toFiniteNumber } from "../../src/utils/coerce";

/**
 * Unit tests for the numeric coercion shared by the value-bearing status
 * controllers. The contract that matters is the *string* path: a value can reach
 * `setValue` as text (a `*:set` CustomEvent detail, or an action param whose
 * attribute does not look numeric), and `Number.isFinite` does not coerce, so a
 * numeric string must be converted before it is range-checked.
 */
describe("toFiniteNumber", () => {
  it("passes finite numbers through", () => {
    expect(toFiniteNumber(42)).toBe(42);
    expect(toFiniteNumber(-1.5)).toBe(-1.5);
    expect(toFiniteNumber(0)).toBe(0);
  });

  it("converts numeric strings, including negatives and decimals", () => {
    expect(toFiniteNumber("42")).toBe(42);
    expect(toFiniteNumber("-1.5")).toBe(-1.5);
    expect(toFiniteNumber(" 7 ")).toBe(7);
  });

  it("treats absent and empty input as no value rather than zero", () => {
    expect(toFiniteNumber(null)).toBeNull();
    expect(toFiniteNumber(undefined)).toBeNull();
    expect(toFiniteNumber("")).toBeNull();
    expect(toFiniteNumber("   ")).toBeNull();
  });

  it("rejects anything that is not a finite number", () => {
    expect(toFiniteNumber("abc")).toBeNull();
    expect(toFiniteNumber("12px")).toBeNull();
    expect(toFiniteNumber(Number.NaN)).toBeNull();
    expect(toFiniteNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toFiniteNumber(true as unknown as number)).toBeNull();
    expect(toFiniteNumber([1] as unknown as number)).toBeNull();
  });
});

/** A reader returns the supplied fallback without normalizing either value. */
describe("readNumber", () => {
  it("preserves accepted fractions and negative zero", () => {
    expect(readNumber(1.25, 7, { min: 1 })).toBe(1.25);
    expect(readNumber(-0, 7, {})).toBe(-0);
  });

  it("falls back for non-numbers and out-of-contract numbers", () => {
    for (const value of [Number.NaN, Infinity, -Infinity, -1, 0.5]) {
      expect(readNumber(value, 7, { min: 0, integer: true })).toBe(7);
    }
    expect(readNumber(13, 24, { allowedValues: [12, 24] })).toBe(24);
  });

  it("leaves the caller's fallback and explicit sentinel intact", () => {
    expect(readNumber(Number.NaN, -Infinity, {})).toBe(-Infinity);
    expect(readNumber(Number.NaN, Number.NaN, {})).toBeNaN();
    expect(readNumber(Infinity, 0, { allowInfinity: "positive" })).toBe(Infinity);
    expect(readNumber(-1, -2, { min: 0 })).toBe(-2);
  });
});
