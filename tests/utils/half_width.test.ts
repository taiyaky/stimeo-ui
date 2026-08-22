import { describe, expect, it } from "vitest";
import { halfWidthChar, toHalfWidth } from "../../src/utils/half_width";

/**
 * Unit tests for the full-width → half-width mapping shared by the input
 * controllers: the shifted block, the ideographic space, and everything the
 * mapping must leave alone.
 */

describe("halfWidthChar", () => {
  it("shifts the full-width ASCII block to its half-width twin", () => {
    expect(halfWidthChar("１")).toBe("1");
    expect(halfWidthChar("Ａ")).toBe("A");
    expect(halfWidthChar("ａ")).toBe("a");
    expect(halfWidthChar("－")).toBe("-");
    expect(halfWidthChar("＋")).toBe("+");
    expect(halfWidthChar("．")).toBe(".");
    // The block's first and last members pin the range itself.
    expect(halfWidthChar("！")).toBe("!");
    expect(halfWidthChar("～")).toBe("~");
  });

  it("maps the ideographic space to a plain space", () => {
    expect(halfWidthChar("　")).toBe(" ");
  });

  it("returns characters that have no half-width form unchanged", () => {
    // Half-width input, kana, a code point below the block, and an astral
    // character (two code units, so a naive range test could mangle it).
    expect(halfWidthChar("1")).toBe("1");
    expect(halfWidthChar("A")).toBe("A");
    expect(halfWidthChar("あ")).toBe("あ");
    expect(halfWidthChar("￥")).toBe("￥");
    expect(halfWidthChar("😀")).toBe("😀");
  });
});

describe("toHalfWidth", () => {
  it("rewrites every mapped character and keeps the rest", () => {
    expect(toHalfWidth("０９Ａｚ－　あ")).toBe("09Az- あ");
  });

  it("leaves an already half-width string alone", () => {
    expect(toHalfWidth("09Az- ")).toBe("09Az- ");
  });
});
