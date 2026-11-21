import { describe, expect, it } from "vitest";
import { effectiveStep, snapSteppedValue, stepSteppedValue } from "../../src/utils/stepped_value";

/**
 * Locks the endpoint-plus-grid contract the stepping controllers share, so each
 * advertises the same values it can reach.
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

  it("steps one unit at a time up to the largest safe integer", () => {
    const range = { min: 0, max: Number.POSITIVE_INFINITY, step: 1 };

    expect(stepSteppedValue(5, 1, range)).toBe(6);
    expect(stepSteppedValue(2 ** 52 - 1, 1, range)).toBe(2 ** 52);
    expect(stepSteppedValue(2 ** 52, -1, range)).toBe(2 ** 52 - 1);
    expect(stepSteppedValue(Number.MAX_SAFE_INTEGER - 1, 1, range)).toBe(Number.MAX_SAFE_INTEGER);
    expect(stepSteppedValue(Number.MAX_SAFE_INTEGER, -1, range)).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(stepSteppedValue(Number.MAX_SAFE_INTEGER - 11, 10, range)).toBe(
      Number.MAX_SAFE_INTEGER - 1,
    );
  });

  it("leaves a value unchanged where the next grid value is no distinct number", () => {
    const unbounded = {
      min: Number.NEGATIVE_INFINITY,
      max: Number.POSITIVE_INFINITY,
      step: 1,
    };

    // The first unit step cannot reach a distinct number at 1e17, so a request
    // for multiple steps also stays at the current value.
    expect(stepSteppedValue(1e17, 1, unbounded)).toBe(1e17);
    expect(stepSteppedValue(1e17, -1, unbounded)).toBe(1e17);
    expect(stepSteppedValue(1e17, 10, unbounded)).toBe(1e17);
    expect(stepSteppedValue(1e17, -10, unbounded)).toBe(1e17);
    expect(stepSteppedValue(2 ** 53, 1, { ...unbounded, min: 0 })).toBe(2 ** 53);
  });

  it("does not jump to a finite endpoint when the step is below the value's precision", () => {
    const range = { min: 1e300, max: 2e300, step: 1e-18 };

    expect(stepSteppedValue(1e300, 1, range)).toBe(1e300);
    expect(stepSteppedValue(2e300, -1, range)).toBe(2e300);
  });

  it("keeps a unit step near zero when a huge finite minimum anchors the grid", () => {
    const halfOpen = { min: -1e17, max: Number.POSITIVE_INFINITY, step: 1 };
    const closed = { min: -1e17, max: 1e17, step: 1 };

    expect(snapSteppedValue(1, halfOpen)).toBe(1);
    expect(stepSteppedValue(0, 1, halfOpen)).toBe(1);
    expect(stepSteppedValue(0, -1, halfOpen)).toBe(-1);
    expect(stepSteppedValue(0, 1, closed)).toBe(1);
    expect(stepSteppedValue(0, -1, closed)).toBe(-1);
  });

  it("keeps a decimal step near zero when a huge finite minimum anchors the grid", () => {
    const range = { min: -1e14, max: Number.POSITIVE_INFINITY, step: 0.05 };
    // Whole steps taken off this minimum round by far more than a step.
    const vast = { min: -1e43, max: Number.POSITIVE_INFINITY, step: 0.01 };
    // This minimum divided by the step passes the largest number.
    const beyond = { min: -1e300, max: Number.POSITIVE_INFINITY, step: 1e-10 };

    expect(snapSteppedValue(1000, range)).toBe(1000);
    expect(stepSteppedValue(1000, 1, range)).toBe(1000.05);
    expect(stepSteppedValue(1000, -1, range)).toBe(999.95);
    expect(snapSteppedValue(0.01, vast)).toBe(0.01);
    expect(stepSteppedValue(0.01, 1, vast)).toBe(0.02);
    expect(snapSteppedValue(1, beyond)).toBe(1);
    expect(stepSteppedValue(1, 1, beyond)).toBe(1.0000000001);
  });

  it("never steps backwards where grid positions outgrow a number's integers", () => {
    const top = 4308170000000000000;
    const bottom = 13443352453235480;

    expect(stepSteppedValue(top, 1, { min: 0, max: top, step: 7 })).toBe(top);
    expect(
      stepSteppedValue(bottom, -1, { min: bottom, max: Number.POSITIVE_INFINITY, step: 0.3 }),
    ).toBe(bottom);
  });

  it("stays finite where the next grid value lies past the largest number", () => {
    const unbounded = {
      min: Number.NEGATIVE_INFINITY,
      max: Number.POSITIVE_INFINITY,
      step: 1e308,
    };
    const bounded = { min: 0, max: 1.5e308, step: 1e308 };

    expect(stepSteppedValue(1e308, 1, unbounded)).toBe(1e308);
    expect(stepSteppedValue(-1e308, -1, unbounded)).toBe(-1e308);
    expect(stepSteppedValue(0, 10, unbounded)).toBe(0);
    expect(stepSteppedValue(0, -10, unbounded)).toBe(0);
    // The finite endpoint on the other side is no landing place.
    expect(stepSteppedValue(0, 10, { ...unbounded, min: -1e308 })).toBe(0);
    expect(stepSteppedValue(0, -10, { ...unbounded, max: 1e308 })).toBe(0);
    // A finite endpoint that way is still reached, as an off-grid maximum is.
    expect(stepSteppedValue(1e308, 1, bounded)).toBe(1.5e308);
    expect(stepSteppedValue(0, 10, bounded)).toBe(1.5e308);
  });

  it.each([
    { raw: 4.7105, range: { min: -32.85, max: 7.271, step: 7 }, expected: 7.271 },
    { raw: 0.4145, range: { min: 0.384, max: 0.89, step: 0.089, base: 0 }, expected: 0.445 },
    { raw: -5.5959, range: { min: -7.6384, max: 155.7616, step: 0.1634 }, expected: -5.5142 },
    { raw: -7.0913, range: { min: -7.2636, max: -4.884, step: 0.407, base: 0 }, expected: -6.919 },
    { raw: -4.7105, range: { min: -7.271, max: 32.85, step: 7, base: 32.85 }, expected: -2.15 },
    { raw: 256.251, range: { min: 59.163, max: 257.619, step: 9.786 }, expected: 257.619 },
    {
      raw: Number("135403370.49927665"),
      range: { min: -Infinity, max: Infinity, step: 1e-7, base: -81447185.1474 },
      expected: 135403370.4992767,
    },
    {
      raw: Number("135403370.49927665"),
      range: { min: 135403370.4992766, max: 135403370.4992767, step: 1 },
      expected: 135403370.4992767,
    },
    {
      raw: Number("135403370.49927665"),
      range: { min: -Infinity, max: 135403370.4992767, step: 2e-7, base: 135403370.4992766 },
      expected: 135403370.4992767,
    },
    {
      raw: Number("135403370.49927665"),
      range: { min: 135403370.4992766, max: Infinity, step: 2e-7, base: 135403370.4992767 },
      expected: 135403370.4992767,
    },
    {
      raw: Number("672721095.75569645"),
      range: { min: -Infinity, max: 672721095.7556967, step: 3e-7, base: 2e-7 },
      expected: 672721095.7556967,
    },
  ])("resolves the decimal midpoint $raw upward to $expected", ({ raw, range, expected }) => {
    expect(snapSteppedValue(raw, range)).toBe(expected);
  });

  it("allows one representable number of error below a decimal midpoint", () => {
    const range = { min: -32.85, max: 7.271, step: 7 };

    expect(snapSteppedValue(4.710499999999999, range)).toBe(7.271);
  });

  it("keeps a value just off a midpoint on its nearer side", () => {
    const range = { min: -32.85, max: 7.271, step: 7 };

    expect(snapSteppedValue(4.71, range)).toBe(2.15);
    expect(snapSteppedValue(4.711, range)).toBe(7.271);
    expect(snapSteppedValue(0.4144, { min: 0.384, max: 0.89, step: 0.089, base: 0 })).toBe(0.384);
    expect(
      snapSteppedValue(-163.74073665781754, {
        min: -Infinity,
        max: Infinity,
        step: 2e-13,
        base: 78.201873235968,
      }),
    ).toBe(-163.7407366578176);
    expect(
      snapSteppedValue(172061199.57004285, {
        min: -Infinity,
        max: Infinity,
        step: 9e-8,
        base: 6213983.52461824,
      }),
    ).toBe(172061199.57004282);
    expect(
      snapSteppedValue(575137975.7188262, {
        min: 575137975.718826,
        max: 575137975.7188264,
        step: 4e-7,
        base: 1e-7,
      }),
    ).toBe(575137975.718826);
    // The representable-number spacing equals the grid step. An exact grid value
    // remains unchanged when snapped.
    expect(snapSteppedValue(1e17 - 16, { min: 1e17 - 32, max: 1e17, step: 16 })).toBe(1e17 - 16);
  });

  it("steps from a decimal value whose grid position carries rounding noise", () => {
    const range = { min: 0, max: 2, step: 0.1 };

    // 0.3 / 0.1 is just below 3, and 1.1 / 0.1 just above 11.
    expect(stepSteppedValue(0.3, 1, range)).toBe(0.4);
    expect(stepSteppedValue(1.1, -1, range)).toBe(1);
  });
});
