import { describe, expect, it } from "vitest";
import { toFiniteNumber } from "../../src/utils/coerce";

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
  });

  it("rejects anything that is not a finite number", () => {
    expect(toFiniteNumber("abc")).toBeNull();
    expect(toFiniteNumber("12px")).toBeNull();
    expect(toFiniteNumber(Number.NaN)).toBeNull();
    expect(toFiniteNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
