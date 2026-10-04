import { describe, expect, it } from "vitest";
import { withinTimeLimit } from "./time_limit";

/**
 * Pins both sides of the guard the scanner suites rely on: a call that returns
 * passes its value through untouched, and a call that never returns is stopped
 * where it spins, even though the loop lives outside the guarded script.
 */
describe("withinTimeLimit", () => {
  it("returns what a finished call returns", () => {
    const value = { parsed: ["div"] };
    expect(withinTimeLimit(() => value)).toBe(value);
  });

  it("stops a call that never returns", () => {
    // The counter stays within 0..6, so the condition never fails.
    const spin = (): number => {
      let turns = 0;
      while (turns >= 0) turns = (turns + 1) % 7;
      return turns;
    };
    expect(() => withinTimeLimit(spin, 50)).toThrow(/timed out/);
  });
});
