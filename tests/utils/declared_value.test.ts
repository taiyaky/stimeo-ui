import { describe, expect, it } from "vitest";
import {
  compileRegExp,
  parseDeclared,
  parseJsonObject,
  validSelector,
} from "../../src/utils/declared_value";

/**
 * Unit tests for the shared declaration readers: a value that parses passes
 * through unchanged, a value that does not falls back to the caller's default,
 * and the probe never lets the parser's exception escape.
 */
describe("parseDeclared", () => {
  it("returns what the parser produces", () => {
    expect(parseDeclared("42", Number, 0)).toBe(42);
  });

  it("falls back when the parser throws, without letting the throw escape", () => {
    const parse = (raw: string): string => {
      throw new SyntaxError(`unreadable: ${raw}`);
    };
    expect(() => parseDeclared("x", parse, "default")).not.toThrow();
    expect(parseDeclared("x", parse, "default")).toBe("default");
  });

  it("hands the raw text to the parser verbatim", () => {
    expect(parseDeclared("  padded ", (raw) => raw, "")).toBe("  padded ");
  });
});

describe("validSelector", () => {
  // happy-dom memoizes a selector parse per element and stops throwing for a
  // selector that already failed on that element, so each rejection case gets an
  // element of its own. A browser throws every time.
  const fresh = (): Element => document.createElement("div");

  it("returns a selector the engine parses, whether or not it matches the element", () => {
    const element = fresh();
    expect(validSelector(element, "div", "")).toBe("div");
    expect(validSelector(element, "#somewhere-else > .row", "")).toBe("#somewhere-else > .row");
  });

  it("falls back for a selector the engine rejects", () => {
    expect(validSelector(fresh(), "[[", "body")).toBe("body");
    expect(validSelector(fresh(), "#panel[", "")).toBe("");
  });

  it("falls back for an empty declaration", () => {
    expect(validSelector(fresh(), "", "body")).toBe("body");
  });
});

describe("compileRegExp", () => {
  it("compiles a source as written by default", () => {
    const compiled = compileRegExp("[0-9]");
    expect(compiled?.source).toBe("[0-9]");
    expect(compiled?.test("a5")).toBe(true);
  });

  it("anchors the whole input in the exact form, so an alternation cannot escape", () => {
    const compiled = compileRegExp("a|b", "exact");
    expect(compiled?.source).toBe("^(?:a|b)$");
    expect(compiled?.test("a")).toBe(true);
    expect(compiled?.test("ab")).toBe(false);
  });

  it("returns null for a source that does not compile", () => {
    expect(compileRegExp("[0-9")).toBeNull();
    expect(compileRegExp("(", "exact")).toBeNull();
  });

  it("rejects a source that only compiles because the wrapper closes it", () => {
    // `0)|(1` is a SyntaxError on its own, but `^(?:0)|(1)$` parses: the source's
    // `)` closes the wrapper's `(?:` and the wrapper's `)` closes the source's
    // `(`. Accepting it would both admit a broken declaration and leave the
    // alternation unanchored.
    expect(compileRegExp("0)|(1", "exact")).toBeNull();
    expect(compileRegExp("a)(b", "exact")).toBeNull();
  });
});

describe("parseJsonObject", () => {
  it("returns the object a JSON declaration holds, values as parsed", () => {
    expect(parseJsonObject('{"9": "\\\\d", "n": 1}')).toEqual({ "9": "\\d", n: 1 });
  });

  it("returns null for text that is not JSON", () => {
    expect(parseJsonObject("{broken")).toBeNull();
    expect(parseJsonObject("")).toBeNull();
  });

  it("returns null for JSON that is not a plain object", () => {
    expect(parseJsonObject("null")).toBeNull();
    expect(parseJsonObject('["a"]')).toBeNull();
    expect(parseJsonObject('"a"')).toBeNull();
    expect(parseJsonObject("1")).toBeNull();
  });
});
