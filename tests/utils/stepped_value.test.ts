import { describe, expect, it } from "vitest";
import { effectiveStep, snapSteppedValue, stepSteppedValue } from "../../src/utils/stepped_value";

/**
 * Locks the endpoint-plus-grid contract shared by Slider, Range Slider, and
 * Number Input so each controller advertises the same values it can reach.
 */
describe("stepped values", () => {
  it("keeps an off-grid maximum reachable", () => {
    const range = { min: 0, max: 94, step: 10 };

    expect(snapSteppedValue(94, range)).toBe(94);
    expect(snapSteppedValue(91, range)).toBe(90);
    expect(snapSteppedValue(92, range)).toBe(94); // equal distance resolves upward
  });

  it("steps between a grid value and an off-grid endpoint without skipping", () => {
    const range = { min: 0, max: 94, step: 10 };

    expect(stepSteppedValue(90, 1, range)).toBe(94);
    expect(stepSteppedValue(94, -1, range)).toBe(90);
    expect(stepSteppedValue(94, 1, range)).toBe(94);
    expect(stepSteppedValue(0, -1, range)).toBe(0);
    expect(stepSteppedValue(40, 0, range)).toBe(40);
    expect(stepSteppedValue(0, 10, range)).toBe(94);
    expect(stepSteppedValue(94, -10, range)).toBe(0);
  });

  it("treats a movable off-grid bound as an allowed range-slider endpoint", () => {
    const range = { min: 23, max: 94, step: 10, base: 0 };

    expect(stepSteppedValue(23, 1, range)).toBe(30);
    expect(stepSteppedValue(30, -1, range)).toBe(23);
    expect(stepSteppedValue(90, 1, range)).toBe(94);
    expect(stepSteppedValue(94, -1, range)).toBe(90);
  });

  it("anchors the grid at a finite non-zero minimum by default", () => {
    const range = { min: 3, max: 10, step: 2 };

    expect(snapSteppedValue(4.6, range)).toBe(5);
    expect(stepSteppedValue(5, -1, range)).toBe(3);
  });

  it("uses one for a non-positive or non-finite step", () => {
    expect(effectiveStep(0)).toBe(1);
    expect(effectiveStep(-2)).toBe(1);
    expect(effectiveStep(Number.POSITIVE_INFINITY)).toBe(1);
    expect(snapSteppedValue(2.6, { min: 0, max: 10, step: 0 })).toBe(3);
    expect(stepSteppedValue(2, 1, { min: 0, max: 10, step: -2 })).toBe(3);
  });

  it("anchors an unbounded range at zero", () => {
    const range = {
      min: Number.NEGATIVE_INFINITY,
      max: Number.POSITIVE_INFINITY,
      step: 2,
    };

    expect(snapSteppedValue(3.2, range)).toBe(4);
    expect(stepSteppedValue(4, -1, range)).toBe(2);
  });

  it("handles non-finite input and one-sided finite bounds deterministically", () => {
    const unbounded = {
      min: Number.NEGATIVE_INFINITY,
      max: Number.POSITIVE_INFINITY,
      step: 2,
    };

    expect(snapSteppedValue(Number.NaN, unbounded)).toBe(0);
    expect(snapSteppedValue(Number.POSITIVE_INFINITY, unbounded)).toBe(Number.POSITIVE_INFINITY);
    expect(snapSteppedValue(Number.NaN, { ...unbounded, max: 8 })).toBe(8);
  });

  it("does not treat an infinite distance as floating-point noise", () => {
    const range = { min: -1e308, max: 1e308, step: 1 };

    expect(snapSteppedValue(-1e308, range)).toBe(-1e308);
  });

  it("removes floating-point noise from decimal grids", () => {
    const range = { min: 0, max: 1, step: 0.1 };

    expect(snapSteppedValue(0.26, range)).toBe(0.3);
    expect(stepSteppedValue(0.2, 1, range)).toBe(0.3);
  });

  it("keeps unit grid values distinct at a large finite base", () => {
    const range = { min: 1e15, max: 1e15 + 10, step: 1 };

    expect(snapSteppedValue(1e15 + 1, range)).toBe(1e15 + 1);
    expect(stepSteppedValue(1e15, 1, range)).toBe(1e15 + 1);
    expect(stepSteppedValue(1e15 + 2, -1, range)).toBe(1e15 + 1);
  });

  it("does not collapse a valid step smaller than Number.EPSILON near zero", () => {
    const range = {
      min: Number.NEGATIVE_INFINITY,
      max: Number.POSITIVE_INFINITY,
      step: 1e-18,
    };

    expect(snapSteppedValue(0.6e-18, range)).toBe(1e-18);
    expect(stepSteppedValue(0, 1, range)).toBe(1e-18);
    expect(stepSteppedValue(0, -1, range)).toBe(-1e-18);
  });

  it("keeps steps beyond toFixed's 100-digit precision limit", () => {
    const range = {
      min: Number.NEGATIVE_INFINITY,
      max: Number.POSITIVE_INFINITY,
      step: 1e-101,
    };

    expect(snapSteppedValue(0.6e-101, range)).toBe(1e-101);
    expect(stepSteppedValue(0, 1, range)).toBe(1e-101);
  });

  it("collapses an empty range and safely floors malformed numeric input", () => {
    expect(snapSteppedValue(99, { min: 5, max: 5, step: 1 })).toBe(5);
    expect(snapSteppedValue(Number.NaN, { min: 2, max: 8, step: 1 })).toBe(2);
    expect(snapSteppedValue(3, { min: 8, max: 2, step: 1 })).toBe(8);
    expect(stepSteppedValue(3, 1, { min: 8, max: 2, step: 1 })).toBe(8);
    expect(stepSteppedValue(3, Number.POSITIVE_INFINITY, { min: 0, max: 8, step: 1 })).toBe(3);
  });
});
