import { describe, expect, it } from "vitest";
import {
  monthLabelFormatter,
  parseISODateString,
  parseISOMonthString,
  toISODateString,
  toISOMonthString,
} from "../../src/utils/dates";

/**
 * Unit tests for the shared date helpers used by the calendar-family
 * controllers. The focus is the round-trip contract of the local-time
 * conversions and the rejection of calendar-invalid strings (so a rolled-over
 * `Date` never leaks downstream); the month label formatter has its own block
 * at the end of the file.
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

  it("rejects a month string that does not match the shape at all", () => {
    // Distinct from the out-of-range cases above: those still match the pattern,
    // so only a non-matching string exercises the shape rejection. Without it the
    // destructure of a null match would throw instead of returning null.
    expect(parseISOMonthString("not-a-month")).toBeNull();
    expect(parseISOMonthString("2026-6")).toBeNull();
  });
});

/**
 * The month label is the one piece of locale-dependent text the calendar-family
 * controllers write themselves, from a `<html lang>` the host page authored. A
 * tag `Intl` rejects must not stop the grid paint that follows the label, while
 * any other failure of the formatter has to stay visible.
 */
describe("monthLabelFormatter", () => {
  const may = new Date(2026, 4, 1);

  it("formats the long month name and the numeric year in the given locale", () => {
    expect(monthLabelFormatter("en").format(may)).toBe("May 2026");
    expect(monthLabelFormatter("ja").format(may)).toBe("2026年5月");
  });

  it("falls back to English when the tag is not a well-formed language tag", () => {
    // `en_US` is what a server-side locale setting looks like when it is written
    // into `<html lang>` unchanged; `Intl` rejects it with a RangeError.
    for (const tag of ["en_US", "x-", "en-US-invalid!"]) {
      expect(monthLabelFormatter(tag).format(may)).toBe("May 2026");
    }
  });

  it("rethrows a failure that is not a locale problem", () => {
    const NativeDateTimeFormat = Intl.DateTimeFormat;
    const ThrowingDateTimeFormat = new Proxy(NativeDateTimeFormat, {
      construct(target, argumentsList, newTarget) {
        if (argumentsList[0] === "type-error") throw new TypeError("formatter failed");
        return Reflect.construct(target, argumentsList, newTarget);
      },
    });
    Object.defineProperty(Intl, "DateTimeFormat", {
      configurable: true,
      writable: true,
      value: ThrowingDateTimeFormat,
    });
    try {
      expect(() => monthLabelFormatter("type-error")).toThrow(TypeError);
    } finally {
      Object.defineProperty(Intl, "DateTimeFormat", {
        configurable: true,
        writable: true,
        value: NativeDateTimeFormat,
      });
    }
  });
});
