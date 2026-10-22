import { describe, expect, it } from "vitest";
import {
  dateInMonthClamped,
  monthGridDays,
  monthLabelFormatter,
  parseISODateString,
  parseISOMonthString,
  shiftMonthClamped,
  shiftYearClamped,
  toISODateString,
  toISOMonthString,
} from "../../src/utils/dates";

/**
 * Unit tests for the shared date helpers used by the calendar-family
 * controllers. The focus is the round-trip contract of the local-time
 * conversions, civil-date grids, non-mutating clamped navigation and the
 * rejection of calendar-invalid strings. The month label formatter has its
 * own block at the end of the file.
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

describe("monthGridDays", () => {
  it.each([
    [0, "2026-05-31", "2026-07-11"],
    [1, "2026-06-01", "2026-07-12"],
    [2, "2026-05-26", "2026-07-06"],
    [3, "2026-05-27", "2026-07-07"],
    [4, "2026-05-28", "2026-07-08"],
    [5, "2026-05-29", "2026-07-09"],
    [6, "2026-05-30", "2026-07-10"],
  ] as const)(
    "starts on weekday %s and includes 42 independent dates",
    (weekStart, first, last) => {
      const dates = monthGridDays(2026, 6, weekStart);
      expect(dates).toHaveLength(42);
      expect(dates[0]?.getDay()).toBe(weekStart);
      expect(dates.map(toISODateString).at(0)).toBe(first);
      expect(dates.map(toISODateString).at(-1)).toBe(last);
      expect(new Set(dates).size).toBe(42);
      const second = dates[1];
      const initialSecond = second?.getTime();
      dates[0]?.setDate(15);
      expect(second?.getTime()).toBe(initialSecond);
    },
  );

  it.each([
    [2024, 2, "2024-01-28", "2024-03-09"],
    [2027, 1, "2026-12-27", "2027-02-06"],
  ] as const)("includes neighbouring months for %s-%s", (year, month, first, last) => {
    const dates = monthGridDays(year, month, 0);
    expect(dates.map(toISODateString).at(0)).toBe(first);
    expect(dates.map(toISODateString).at(-1)).toBe(last);
  });

  it.each([
    [3, 8, 9, 23],
    [11, 1, 2, 25],
  ] as const)(
    "follows civil days through the month %s clock change",
    (month, before, after, nyHours) => {
      const nativeBefore = new Date(2026, month - 1, before);
      const nativeAfter = new Date(2026, month - 1, after);
      const nativeHours = (nativeAfter.getTime() - nativeBefore.getTime()) / 3_600_000;
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (zone === "America/New_York") expect(nativeHours).toBe(nyHours);
      else if (zone === "UTC" || zone === "Asia/Tokyo") expect(nativeHours).toBe(24);
      const dates = monthGridDays(2026, month, 0);
      const beforeDate = dates.find(
        (date) => date.getMonth() === month - 1 && date.getDate() === before,
      );
      const afterDate = dates.find(
        (date) => date.getMonth() === month - 1 && date.getDate() === after,
      );
      expect(beforeDate?.getTime()).toBe(nativeBefore.getTime());
      expect(afterDate?.getTime()).toBe(nativeAfter.getTime());
      expect(dates.every((date) => date.getHours() === 0)).toBe(true);
    },
  );
});

describe("dateInMonthClamped", () => {
  it.each([
    [2026, 2, "2026-02-28"],
    [2024, 2, "2024-02-29"],
    [2026, 4, "2026-04-30"],
    [2026, 12, "2026-12-31"],
    [2026, 13, "2027-01-31"],
    [2026, 0, "2025-12-31"],
  ] as const)("puts the source day into %s-%s with month-end clamping", (year, month, expected) => {
    const source = new Date(2025, 7, 31, 17, 23, 45, 123);
    const originalTime = source.getTime();
    const result = dateInMonthClamped(source, year, month);
    expect(toISODateString(result)).toBe(expected);
    expect([
      result.getHours(),
      result.getMinutes(),
      result.getSeconds(),
      result.getMilliseconds(),
    ]).toEqual([0, 0, 0, 0]);
    expect(result).not.toBe(source);
    expect(source.getTime()).toBe(originalTime);
  });

  it("preserves a non-month-end day and returns a new date for the same month", () => {
    const source = new Date(2026, 5, 15, 18);
    const result = dateInMonthClamped(source, 2026, 6);
    expect(toISODateString(result)).toBe("2026-06-15");
    expect(result).not.toBe(source);
    expect(source.getHours()).toBe(18);
  });
});

describe("clamped date shifts", () => {
  it("keeps numeric year construction independent of month overflow", () => {
    const source = new Date(100, 1, 28);
    expect(toISODateString(shiftYearClamped(source, -1))).toBe("1999-02-28");
    expect(toISODateString(shiftMonthClamped(source, -12))).toBe("99-02-28");
    expect(source.getFullYear()).toBe(100);
  });

  it.each([
    [2026, 1, 31, 1, "2026-02-28"],
    [2024, 1, 31, 1, "2024-02-29"],
    [2026, 3, 31, -1, "2026-02-28"],
    [2026, 12, 31, 1, "2027-01-31"],
    [2026, 1, 31, -1, "2025-12-31"],
    [2026, 5, 15, 0, "2026-05-15"],
    [2026, 5, 31, 13, "2027-06-30"],
    [2026, 5, 31, -13, "2025-04-30"],
  ] as const)("shifts %s-%s-%s by %s months", (year, month, day, delta, expected) => {
    const source = new Date(year, month - 1, day, 17);
    const originalTime = source.getTime();
    const result = shiftMonthClamped(source, delta);
    expect(toISODateString(result)).toBe(expected);
    expect(result).not.toBe(source);
    expect(source.getTime()).toBe(originalTime);
  });

  it.each([
    [2024, 2, 29, 1, "2025-02-28"],
    [2024, 2, 29, -1, "2023-02-28"],
    [2024, 2, 29, 4, "2028-02-29"],
    [2026, 12, 31, -2, "2024-12-31"],
    [2026, 5, 15, 0, "2026-05-15"],
  ] as const)("shifts %s-%s-%s by %s years", (year, month, day, delta, expected) => {
    const source = new Date(year, month - 1, day, 17);
    const originalTime = source.getTime();
    const result = shiftYearClamped(source, delta);
    expect(toISODateString(result)).toBe(expected);
    expect(result).not.toBe(source);
    expect(source.getTime()).toBe(originalTime);
  });
});

/**
 * The month label is the one piece of locale-dependent text the calendar-family
 * controllers write themselves, from a language tag the page authors (the `locale`
 * Value or the nearest `lang`). A tag `Intl` rejects must not stop the grid paint
 * that follows the label, while any other failure of the formatter has to stay
 * visible.
 */
describe("monthLabelFormatter", () => {
  const may = new Date(2026, 4, 1);

  it("formats the long month name and the numeric year in the given locale", () => {
    expect(monthLabelFormatter("en").format(may)).toBe("May 2026");
    expect(monthLabelFormatter("ja").format(may)).toBe("2026年5月");
  });

  it("asks the runtime for its own locale when none is resolved", () => {
    // A component with no declaration and no `lang` in scope formats the way
    // the viewer's runtime does, which is not the same thing as English.
    const reference = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

    expect(monthLabelFormatter(undefined).format(may)).toBe(reference.format(may));
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
