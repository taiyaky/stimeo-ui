/**
 * Date helpers shared by the calendar-family controllers
 * (`calendar`, `date-range-picker`): local month grids, clamped month/year
 * navigation, bare ISO conversions and month-label formatting.
 *
 * The conversions are intentionally **local time** (not UTC): the grid a user
 * sees is built from `Date` components in their own timezone, so round-tripping
 * through ISO strings must use the same frame to avoid off-by-one-day drift near
 * midnight. Strings are bare `YYYY-MM-DD` / `YYYY-MM` with no time or zone.
 */

import { intlFormatter } from "./intl_format";

/**
 * Formats a {@link Date} as a local-time `YYYY-MM-DD` string. The year is written
 * unpadded, so the four-digit shape holds for the years 1000 through 9999.
 */
export function toISODateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Parses a `YYYY-MM-DD` string into a local-time {@link Date}, or `null`.
 *
 * Rejects calendar-invalid dates (e.g. `2026-02-31`): the constructed `Date`
 * would silently roll over to another day, so the parsed components are checked
 * back against it and a mismatch returns `null`.
 */
export function parseISODateString(dateStr: string): Date | null {
  if (!dateStr) return null;
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

/**
 * Parses a `YYYY-MM` string into its year/month (1-based) parts, or `null`.
 * Rejects months outside `1..12`.
 */
export function parseISOMonthString(monthStr: string): { year: number; month: number } | null {
  if (!monthStr) return null;
  const match = monthStr.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const [, y, m] = match;
  const month = Number(m);
  if (month < 1 || month > 12) return null;
  return { year: Number(y), month };
}

/**
 * Formats a {@link Date} as the local-time `YYYY-MM` string of its month, with the
 * year unpadded as in {@link toISODateString}.
 */
export function toISOMonthString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Builds 42 independent local dates for a six-week month grid.
 *
 * @param year - The local year, interpreted by the numeric Date constructor.
 * @param month - The 1-based integer local month.
 * @param weekStart - The caller's normalized starting weekday, from 0 (Sunday) to 6.
 * @remarks
 * Civil days advance with `setDate`, so a daylight-saving transition does not
 * repeat or omit a date. Each cell receives its own Date instance.
 */
export function monthGridDays(year: number, month: number, weekStart: number): Date[] {
  const first = new Date(year, month - 1, 1);
  const offset = (first.getDay() - weekStart + 7) % 7;
  const current = new Date(first);
  current.setDate(first.getDate() - offset);
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    days.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }
  return days;
}

/**
 * Places `date`'s day in a specified local month, clamped to that month's end.
 *
 * @param date - Supplies the day only; the input is not mutated.
 * @param year - The local year, interpreted by the numeric Date constructor.
 * @param month - The 1-based integer local month; Date normalizes month overflow.
 * @returns A new Date with the target month's numeric-constructor time normalization.
 */
export function dateInMonthClamped(date: Date, year: number, month: number): Date {
  const target = new Date(year, month - 1, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), lastDay));
  return target;
}

/** Shifts a local date by an integer `delta` of months, clamping its day without mutating it. */
export function shiftMonthClamped(date: Date, delta: number): Date {
  return dateInMonthClamped(date, date.getFullYear(), date.getMonth() + 1 + delta);
}

/** Shifts a local date by an integer `delta` of years, clamping its day without mutating it. */
export function shiftYearClamped(date: Date, delta: number): Date {
  return dateInMonthClamped(date, date.getFullYear() + delta, date.getMonth() + 1);
}

/** The long month name and the numeric year, e.g. `May 2026`. */
const MONTH_LABEL_OPTIONS: Intl.DateTimeFormatOptions = { month: "long", year: "numeric" };

/**
 * Creates the formatter for a month label such as `May 2026`: the long month
 * name and the numeric year in `locale`.
 *
 * `locale` is the one the caller resolved, and `undefined` asks for the runtime
 * default. A tag `Intl` rejects (a `RangeError`, e.g. `en_US`) is replaced by
 * `"en"`, so a malformed declaration still yields a label and the grid paint
 * that follows it is never skipped. Any other failure of the constructor is a
 * programming fault and propagates.
 */
export function monthLabelFormatter(locale: string | undefined): Intl.DateTimeFormat {
  return intlFormatter(Intl.DateTimeFormat, locale, MONTH_LABEL_OPTIONS, "en");
}
