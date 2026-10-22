import { describe, expect, it } from "vitest";
import { readDatetime } from "../src/utils/datetime";
import { withRuntimeTimeZone } from "./helpers/runtime_time_zone";

/** Independent explicit-zone references for accepted complete civil inputs. */
const VALID = [
  ["2026-06-08", "2026-06-08T00:00:00Z"],
  ["2026-06-08T12:30", "2026-06-08T12:30:00Z"],
  ["2026-06-08 12:30:01", "2026-06-08T12:30:01Z"],
  ["2026-06-08T12:30:01.1", "2026-06-08T12:30:01.100Z"],
  ["2026-06-08T12:30:01.12Z", "2026-06-08T12:30:01.120Z"],
  ["2026-06-08T12:30:01.123456789Z", "2026-06-08T12:30:01.123Z"],
  ["2026-06-08T12:30:59.9999Z", "2026-06-08T12:30:59.999Z"],
  ["2026-06-08T12:30:01.1239Z", "2026-06-08T12:30:01.123Z"],
  ["2026-06-08 21:30+0900", "2026-06-08T12:30:00Z"],
  ["2026-06-08T21:30:00+09:00", "2026-06-08T12:30:00Z"],
  ["2026-06-08 08:30:00-0400", "2026-06-08T12:30:00Z"],
  ["2026-06-08T08:30-04:00", "2026-06-08T12:30:00Z"],
  ["2026-06-08T12:30-00:00", "2026-06-08T12:30:00Z"],
  ["2026-06-08T23:59+23:59", "2026-06-08T00:00:00Z"],
  ["2026-06-08T00:00-23:59", "2026-06-08T23:59:00Z"],
  [" \t2026-06-08 12:30:00Z\n ", "2026-06-08T12:30:00Z"],
  ["2024-02-29T24:00", "2024-03-01T00:00:00Z"],
  ["2000-02-29T24:00:00.000000+0000", "2000-03-01T00:00:00Z"],
  ["2026-12-31 24:00:00Z", "2027-01-01T00:00:00Z"],
  ["0000-02-29", "0000-02-29T00:00:00Z"],
  ["0001-01-01T00:00", "0001-01-01T00:00:00Z"],
  ["+000000-02-29T00:00", "0000-02-29T00:00:00Z"],
  ["-000004-02-29 12:30", "-000004-02-29T12:30:00Z"],
  ["+012026-06-08T12:30", "+012026-06-08T12:30:00Z"],
  ["+275760-09-13T23:59+23:59", "+275760-09-13T00:00:00Z"],
  ["-271821-04-19T00:01-23:59", "-271821-04-20T00:00:00Z"],
] as const;

const INVALID = [
  null,
  "",
  " \t\n ",
  "2026",
  "2026-06",
  "26-06-08",
  "2026-6-08",
  "2026-06-8",
  "2026-W24-1",
  "12:30",
  "P1D",
  "2026-00-08",
  "2026-13-08",
  "2026-06-00",
  "2026-06-31",
  "2026-02-29",
  "1900-02-29",
  "-000100-02-29",
  "2026-02-30T12:30:00Z",
  "-000000-01-01",
  "+2026-01-01",
  "+0020260-01-01",
  "+999999-01-01",
  "+275760-09-13T00:00:00.001Z",
  "-271821-04-19T23:59:59.999Z",
  "2026-06-08Z",
  "2026-06-08T",
  "2026-06-08t12:30Z",
  "2026-06-08T12:30z",
  "2026-06-08  12:30",
  "2026-06-08\t12:30",
  "2026-06-08T1:30",
  "2026-06-08T12:3",
  "2026-06-08T12",
  "2026-06-08T12:30:",
  "2026-06-08T12:30.1",
  "2026-06-08T12:30:00.",
  "2026-06-08T25:00",
  "2026-06-08T12:60",
  "2026-06-08T12:30:60",
  "2026-06-08T24:01",
  "2026-06-08T24:00:01",
  "2026-06-08T24:00:00.0001",
  "2026-06-08T12:30+24:00",
  "2026-06-08T12:30-00:60",
  "2026-06-08T12:30+09",
  "2026-06-08T12:30+9:00",
  "2026-06-08T12:30:00ZZ",
  "2026-06-08T12:30:00Zjunk",
  "2026-06-08 12:30 UTC",
  "Mon, 08 Jun 2026 12:30:00 GMT",
] as const;

describe("readDatetime", () => {
  for (const zone of ["UTC", "Asia/Tokyo", "America/New_York"]) {
    describe(zone, () => {
      it.each(VALID)(
        "reads %s as an independent explicit-zone instant",
        async (input, expected) => {
          await withRuntimeTimeZone(zone, async () => {
            expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
            const element = document.createElement("time");
            element.setAttribute("datetime", input);
            element.textContent = "authored";
            const before = element.outerHTML;
            const result = readDatetime(element);
            expect(result).toBe(Date.parse(expected));
            expect(result).not.toBeNull();
            expect(element.outerHTML).toBe(before);
          });
        },
      );
    });
  }

  it.each(INVALID)("rejects %s without touching the element", (input) => {
    const element = document.createElement("time");
    if (input !== null) element.setAttribute("datetime", input);
    element.textContent = "authored";
    element.title = "authored title";
    const before = element.outerHTML;
    expect(readDatetime(element)).toBeNull();
    expect(element.outerHTML).toBe(before);
  });

  it("reads replacement and removed attributes without remembering a previous input", () => {
    const element = document.createElement("time");
    element.setAttribute("datetime", "2026-06-08T12:30");
    expect(readDatetime(element)).toBe(Date.UTC(2026, 5, 8, 12, 30));
    element.setAttribute("datetime", "2026-06-09T12:30");
    expect(readDatetime(element)).toBe(Date.UTC(2026, 5, 9, 12, 30));
    element.removeAttribute("datetime");
    expect(readDatetime(element)).toBeNull();
  });
});
