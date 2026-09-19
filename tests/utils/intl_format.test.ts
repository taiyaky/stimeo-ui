import { describe, expect, it } from "vitest";
import { intlFormatter } from "../../src/utils/intl_format";

/**
 * Unit tests for the shared `Intl` construction: which failures are answered
 * with a fallback locale, which are answered with `null`, which propagate, and
 * that a repeated request reuses the formatter it already built.
 */
describe("intlFormatter", () => {
  const may = new Date(2026, 4, 1);
  const MONTH: Intl.DateTimeFormatOptions = { month: "long", year: "numeric" };

  it("builds a formatter for a well-formed tag", () => {
    expect(intlFormatter(Intl.DateTimeFormat, "ja", MONTH, "en").format(may)).toBe("2026年5月");
  });

  it("resolves an omitted locale to the runtime default rather than failing", () => {
    expect(intlFormatter(Intl.DateTimeFormat, undefined, MONTH)).not.toBeNull();
  });

  it("rebuilds under the fallback locale when the tag is malformed", () => {
    for (const tag of ["en_US", "x-", "en-US-invalid!"]) {
      expect(intlFormatter(Intl.DateTimeFormat, tag, MONTH, "en").format(may)).toBe("May 2026");
    }
  });

  it("answers a malformed tag with null when no fallback is offered", () => {
    expect(intlFormatter(Intl.DateTimeFormat, "en_US", MONTH)).toBeNull();
    expect(
      intlFormatter(Intl.NumberFormat, "en", { style: "currency", currency: "XXXXX" }),
    ).toBeNull();
  });

  it("treats an unusable option the same way, since Intl reports it the same way", () => {
    // A time zone Intl does not know is a RangeError from the constructor, like a
    // malformed tag — the declaration is what is wrong in both cases.
    expect(intlFormatter(Intl.DateTimeFormat, "en", { timeZone: "Not/AZone" })).toBeNull();
  });

  it("reuses the formatter it already built for the same request", () => {
    const first = intlFormatter(Intl.DateTimeFormat, "en-GB", MONTH, "en");
    expect(intlFormatter(Intl.DateTimeFormat, "en-GB", MONTH, "en")).toBe(first);
  });

  it("keeps requests that differ in locale, options, or fallback apart", () => {
    const base = intlFormatter(Intl.DateTimeFormat, "en-AU", MONTH, "en");
    expect(intlFormatter(Intl.DateTimeFormat, "en-NZ", MONTH, "en")).not.toBe(base);
    expect(intlFormatter(Intl.DateTimeFormat, "en-AU", { month: "short" }, "en")).not.toBe(base);
    expect(intlFormatter(Intl.DateTimeFormat, "en-AU", MONTH, "ja")).not.toBe(base);
  });

  it("reads an option left undefined as one that was omitted", () => {
    // Assigning `undefined` is how a caller says "no time zone", and the
    // constructor reads it that way too, so the two must not key apart.
    const first = intlFormatter(Intl.DateTimeFormat, "en-IE", MONTH, "en");
    const second = intlFormatter(
      Intl.DateTimeFormat,
      "en-IE",
      { ...MONTH, timeZone: undefined },
      "en",
    );
    expect(second).toBe(first);
  });

  it("keeps two constructors' caches apart", () => {
    const dates = intlFormatter(Intl.DateTimeFormat, "en-ZA", {}, "en");
    const numbers = intlFormatter(Intl.NumberFormat, "en-ZA", {}, "en");
    expect(numbers).not.toBe(dates);
    expect(numbers).toBeInstanceOf(Intl.NumberFormat);
  });

  it("propagates a failure that is not a problem with the declaration", () => {
    const failing = new Proxy(Intl.DateTimeFormat, {
      construct(target, args, newTarget) {
        if (args[0] === "type-error") throw new TypeError("formatter failed");
        return Reflect.construct(target, args, newTarget);
      },
    });
    expect(() => intlFormatter(failing, "type-error", MONTH, "en")).toThrow(TypeError);
    expect(() => intlFormatter(failing, "type-error", MONTH)).toThrow(TypeError);
  });

  it("lets the fallback locale's own failure surface", () => {
    expect(() => intlFormatter(Intl.DateTimeFormat, "en_US", MONTH, "also_broken")).toThrow(
      RangeError,
    );
  });
});
