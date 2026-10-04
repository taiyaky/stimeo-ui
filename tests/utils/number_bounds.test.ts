import { describe, expect, expectTypeOf, it } from "vitest";
import {
  decodeNumberValue,
  matchesNumberBounds,
  NUMBER_BOUNDS,
  type NumberBounds,
  type NumberValueConstraints,
} from "../../src/utils/number_bounds";

/** Numeric contracts apply to decoded Values without rounding or clamping. */
describe("matchesNumberBounds", () => {
  it("requires finite numbers even without an explicit finite flag", () => {
    for (const bounds of [{}, { finite: true }] as const) {
      for (const value of [0, -1.5, Number.MAX_VALUE]) {
        expect(matchesNumberBounds(value, bounds)).toBe(true);
      }
      for (const value of [Number.NaN, Infinity, -Infinity]) {
        expect(matchesNumberBounds(value, bounds)).toBe(false);
      }
    }
  });

  it.each([
    [{ min: 1 }, [1, 1.25], [0.75]],
    [{ max: 1 }, [0.75, 1], [1.25]],
    [{ exclusiveMin: 1 }, [1.25], [0.75, 1]],
    [{ min: -1, max: 1 }, [-1, 0, 1], [-1.25, 1.25]],
    [{ min: 0, exclusiveMin: 1, max: 2 }, [1.5, 2], [0, 1, 2.5]],
    [{ integer: true }, [-1, 0, 1], [-0.5, 0.5]],
    [{ integer: false }, [-0.5, 0.5], []],
    [{ allowedValues: [12, 24] }, [12, 24], [0, 13, 12.5]],
    [{ allowedValues: [] }, [], [0]],
    [{ min: 13, allowedValues: [12, 24] }, [24], [12]],
  ] satisfies [NumberBounds, number[], number[]][])(
    "checks the complete contract %j",
    (bounds, accepted, rejected) => {
      for (const value of accepted) expect(matchesNumberBounds(value, bounds)).toBe(true);
      for (const value of rejected) expect(matchesNumberBounds(value, bounds)).toBe(false);
    },
  );

  it("admits only the explicit infinity direction through JSON round trips", () => {
    for (const [allowInfinity, negative, positive] of [
      ["negative", true, false],
      ["positive", false, true],
      ["both", true, true],
    ] as const) {
      const bounds: NumberBounds = JSON.parse(JSON.stringify({ finite: true, allowInfinity }));
      expect(matchesNumberBounds(-Infinity, bounds)).toBe(negative);
      expect(matchesNumberBounds(Infinity, bounds)).toBe(positive);
      expect(matchesNumberBounds(Number.NaN, bounds)).toBe(false);
      expect(matchesNumberBounds(3, bounds)).toBe(true);
    }
  });

  it("does not let an infinity sentinel bypass other constraints", () => {
    expect(matchesNumberBounds(Infinity, { allowInfinity: "positive", max: 10 })).toBe(false);
    expect(matchesNumberBounds(-Infinity, { allowInfinity: "negative", min: 0 })).toBe(false);
    expect(matchesNumberBounds(-Infinity, { allowInfinity: "negative", exclusiveMin: 0 })).toBe(
      false,
    );
    expect(matchesNumberBounds(Infinity, { allowInfinity: "positive", integer: true })).toBe(false);
    expect(matchesNumberBounds(Infinity, { allowInfinity: "positive", allowedValues: [1] })).toBe(
      false,
    );
  });

  it("provides reusable finite, boundary, integer and timer contracts", () => {
    expect(matchesNumberBounds(-0.5, NUMBER_BOUNDS.finite)).toBe(true);
    expect(matchesNumberBounds(0, NUMBER_BOUNDS.nonNegative)).toBe(true);
    expect(matchesNumberBounds(-0.5, NUMBER_BOUNDS.nonNegative)).toBe(false);
    expect(matchesNumberBounds(0.5, NUMBER_BOUNDS.positive)).toBe(true);
    expect(matchesNumberBounds(0, NUMBER_BOUNDS.positive)).toBe(false);
    expect(matchesNumberBounds(0, NUMBER_BOUNDS.nonNegativeInteger)).toBe(true);
    expect(matchesNumberBounds(0.5, NUMBER_BOUNDS.nonNegativeInteger)).toBe(false);
    expect(matchesNumberBounds(1, NUMBER_BOUNDS.positiveInteger)).toBe(true);
    expect(matchesNumberBounds(0, NUMBER_BOUNDS.positiveInteger)).toBe(false);
    expect(matchesNumberBounds(-Infinity, NUMBER_BOUNDS.lowerBound)).toBe(true);
    expect(matchesNumberBounds(Infinity, NUMBER_BOUNDS.lowerBound)).toBe(false);
    expect(matchesNumberBounds(Infinity, NUMBER_BOUNDS.upperBound)).toBe(true);
    expect(matchesNumberBounds(-Infinity, NUMBER_BOUNDS.upperBound)).toBe(false);
    for (const bounds of [NUMBER_BOUNDS.timer, NUMBER_BOUNDS.positiveTimer]) {
      expect(matchesNumberBounds(0.5, bounds)).toBe(true);
      expect(matchesNumberBounds(2_147_483_647, bounds)).toBe(true);
      expect(matchesNumberBounds(2_147_483_648, bounds)).toBe(false);
      expect(matchesNumberBounds(-1, bounds)).toBe(false);
    }
    expect(matchesNumberBounds(0, NUMBER_BOUNDS.timer)).toBe(true);
    expect(matchesNumberBounds(0, NUMBER_BOUNDS.positiveTimer)).toBe(false);
  });
});

/** Value decoding follows the Number Value grammar, independently of params. */
describe("decodeNumberValue", () => {
  it.each([
    ["1_000", 1000],
    ["_1__2_", 12],
    ["", 0],
    ["  ", 0],
    [" 1.25 ", 1.25],
    ["1e2", 100],
    ["0x10", 16],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
  ])("decodes %j as %s", (raw, expected) => {
    expect(decodeNumberValue(raw)).toBe(expected);
  });

  it.each(["true", "null", '"12"', "12px", "NaN"])("rejects %j", (raw) => {
    expect(decodeNumberValue(raw)).toBeNaN();
  });
});

/** Static contracts cover exactly the Number Value keys. */
describe("NumberValueConstraints", () => {
  it("requires shorthand and descriptor numbers while excluding other Value types", () => {
    const values = {
      count: Number,
      delay: { type: Number, default: 0 },
      label: String,
      enabled: { type: Boolean, default: false },
    };
    type Constraints = NumberValueConstraints<typeof values>;
    expectTypeOf<Constraints>().toEqualTypeOf<{
      readonly count: NumberBounds;
      readonly delay: NumberBounds;
    }>();
    expectTypeOf<{ count: NumberBounds }>().not.toExtend<Constraints>();
    expectTypeOf<"label" | "enabled">().not.toExtend<keyof Constraints>();
    expectTypeOf<{ finite: false }>().not.toExtend<NumberBounds>();
    expectTypeOf<{ allowInfinity: "unbounded" }>().not.toExtend<NumberBounds>();
    const contracts = {
      count: NUMBER_BOUNDS.nonNegativeInteger,
      delay: NUMBER_BOUNDS.timer,
    } satisfies Constraints;
    expect(matchesNumberBounds(0, contracts.count)).toBe(true);
  });
});
