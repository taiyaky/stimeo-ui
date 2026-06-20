import { describe, expect, it } from "vitest";
import {
  parseISODateString,
  parseISOMonthString,
  toISODateString,
  toISOMonthString,
} from "../../src/utils/dates";

/**
 * Unit tests for the shared local-time date helpers used by the calendar-family
 * controllers. The focus is the round-trip contract and the rejection of
 * calendar-invalid strings (so a rolled-over `Date` never leaks downstream).
 */
describe("dates util", () => {
  it("round-trips a valid date through ISO and back", () => {
    const date = parseISODateString("2026-06-15");
    expect(date).not.toBeNull();
    expect(toISODateString(date as Date)).toBe("2026-06-15");
    expect(toISOMonthString(date as Date)).toBe("2026-06");
  });

  it("rejects a calendar-invalid date instead of rolling over", () => {
    // 2026 is not a leap year, so Feb 29 / Feb 31 must be rejected, not
    // silently shifted to March.
    expect(parseISODateString("2026-02-29")).toBeNull();
    expect(parseISODateString("2026-02-31")).toBeNull();
    expect(parseISODateString("2026-13-01")).toBeNull();
  });

  it("accepts a real leap day", () => {
    expect(parseISODateString("2024-02-29")).not.toBeNull();
  });

  it("rejects malformed or empty strings", () => {
    expect(parseISODateString("")).toBeNull();
    expect(parseISODateString("2026-6-1")).toBeNull();
    expect(parseISODateString("not-a-date")).toBeNull();
  });

  it("parses a month and rejects out-of-range months", () => {
    expect(parseISOMonthString("2026-06")).toEqual({ year: 2026, month: 6 });
    expect(parseISOMonthString("2026-00")).toBeNull();
    expect(parseISOMonthString("2026-13")).toBeNull();
    expect(parseISOMonthString("")).toBeNull();
  });
});
