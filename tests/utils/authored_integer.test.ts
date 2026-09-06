import { describe, expect, it } from "vitest";
import { authoredInteger } from "../../src/utils/authored_integer";

/**
 * The rule the shared reader implements: first numeric token, group separators
 * dropped, fraction truncated toward zero, `-` only where it opens the token.
 */
describe("authoredInteger", () => {
  it("drops group separators and trailing prose", () => {
    expect(authoredInteger("1,200 users")).toBe(1200);
    expect(authoredInteger("1 234 567,89")).toBe(1234567);
  });

  it("reads a hyphen inside a label as prose, not as a sign", () => {
    expect(authoredInteger("Sign-ups: 1,200")).toBe(1200);
    expect(authoredInteger("Top-10 users: 1,200")).toBe(10);
  });

  it("reads a hyphen that opens the token as a sign", () => {
    expect(authoredInteger("-40°C")).toBe(-40);
    expect(authoredInteger("down -40 today")).toBe(-40);
    expect(authoredInteger("(-40)")).toBe(-40);
  });

  it("truncates the fraction toward zero", () => {
    expect(authoredInteger("99.9%")).toBe(99);
    expect(authoredInteger("99.9 %")).toBe(99);
    expect(authoredInteger("1.2 million")).toBe(1);
    expect(authoredInteger("$1,299.99")).toBe(1299);
    expect(authoredInteger("1.299,99")).toBe(1299);
    expect(authoredInteger("-0.4")).toBe(0); // never a negative zero
  });

  it("reads a leading zero as an integer part, not as a group head", () => {
    expect(authoredInteger("0.500")).toBe(0);
    expect(authoredInteger("0.999 uptime")).toBe(0);
  });

  it("reads a separator that does not group as a decimal point", () => {
    expect(authoredInteger("1,2345")).toBe(1);
    expect(authoredInteger("12,34")).toBe(12);
    expect(authoredInteger("1,,2")).toBe(1);
  });

  it("stops the token at the last digit", () => {
    expect(authoredInteger("1.")).toBe(1);
    expect(authoredInteger("12-24 hours: 1,200")).toBe(12);
  });

  it("returns null when the string holds no digits", () => {
    expect(authoredInteger("No users yet")).toBeNull();
    expect(authoredInteger("")).toBeNull();
    expect(authoredInteger("１，２００")).toBeNull(); // full-width digits are out of scope
  });
});
