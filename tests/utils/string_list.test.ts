import { describe, expect, it } from "vitest";
import { parseStringList } from "../../src/utils/string_list";

/**
 * Unit tests for {@link parseStringList}: the parse that keeps a malformed list
 * declaration from taking its controller down, and the boundary between "declare
 * nothing" and "declare an empty list".
 */
describe("parseStringList", () => {
  it("parses a JSON array of strings", () => {
    expect(parseStringList('["a", "b"]')).toEqual(["a", "b"]);
  });

  it("falls back on absent text", () => {
    expect(parseStringList("", ["password"])).toEqual(["password"]);
    expect(parseStringList("   ", ["password"])).toEqual(["password"]);
  });

  it("falls back on malformed JSON instead of throwing", () => {
    expect(parseStringList("[not json", ["password"])).toEqual(["password"]);
    expect(parseStringList("[", ["password"])).toEqual(["password"]);
  });

  it("falls back when the JSON is not an array", () => {
    expect(parseStringList('{"a": 1}', ["password"])).toEqual(["password"]);
    expect(parseStringList('"a"', ["password"])).toEqual(["password"]);
    expect(parseStringList("null", ["password"])).toEqual(["password"]);
  });

  it("honours an explicit empty list rather than falling back", () => {
    // The only way to declare "none" against a non-empty default.
    expect(parseStringList("[]", ["password"])).toEqual([]);
  });

  it("keeps only the string entries of a mixed array", () => {
    expect(parseStringList('["a", 1, null, "b"]')).toEqual(["a", "b"]);
  });

  it("defaults the fallback to an empty list", () => {
    expect(parseStringList("[nope")).toEqual([]);
  });

  it("returns a copy, so a caller cannot mutate the fallback", () => {
    const fallback = ["password"];
    const parsed = parseStringList("", fallback);
    parsed.push("token");
    expect(fallback).toEqual(["password"]);
  });
});
