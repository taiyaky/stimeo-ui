/**
 * Local-time date helpers shared by the calendar-family controllers
 * (`calendar`, `date-range-picker`).
 *
 * All conversions are intentionally **local time** (not UTC): the grid a user
 * sees is built from `Date` components in their own timezone, so round-tripping
 * through ISO strings must use the same frame to avoid off-by-one-day drift near
 * midnight. Strings are bare `YYYY-MM-DD` / `YYYY-MM` with no time or zone.
 */

/** Formats a {@link Date} as a local-time `YYYY-MM-DD` string. */
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

/** Formats a {@link Date} as the local-time `YYYY-MM` string of its month. */
export function toISOMonthString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
