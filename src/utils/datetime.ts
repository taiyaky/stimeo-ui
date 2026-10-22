/** Complete Gregorian dates with an optional clock and numeric UTC offset. */
const DATETIME =
  /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Reads a complete Gregorian `datetime` as epoch milliseconds, or `null`.
 *
 * Dates and clocks without a zone use UTC; explicit offsets retain their meaning.
 * Surrounding whitespace is tolerated, fractions are truncated to milliseconds,
 * and 24:00 is allowed only when every smaller unit is zero. Invalid civil dates,
 * incomplete fields, and instants outside the Date range return `null`, and the caller
 * keeps what the element shows.
 */
export function readDatetime(element: Element): number | null {
  const raw = element.getAttribute("datetime");
  if (raw === null) return null;
  const match = DATETIME.exec(raw.trim());
  if (match === null) return null;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText = "00",
    minuteText = "00",
    secondText = "00",
    fraction = "",
    zone = "Z",
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0)) return null;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour === 24 && (minute !== 0 || second !== 0 || /[1-9]/.test(fraction))) return null;
  let offset = zone;
  if (zone !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    const offsetHour = digits.slice(0, 2);
    const offsetMinute = digits.slice(2);
    offset = `${zone[0]}${offsetHour}:${offsetMinute}`;
  }
  const milliseconds = fraction.slice(0, 3).padEnd(3, "0");
  const canonical = `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}.${milliseconds}${offset}`;
  const instant = Date.parse(canonical);
  return Number.isNaN(instant) ? null : instant;
}
