import { describe, expect, it } from "vitest";
import { neutralizeErb } from "../../src/inspector/erb";

/**
 * Tests for ERB neutralization: tags must be blanked while line/column layout
 * is preserved so downstream diagnostics keep accurate positions.
 */
describe("neutralizeErb", () => {
  it("replaces output tags with position-preserving spaces", () => {
    const input = `<a title="<%= t("x") %>">`;
    const output = neutralizeErb(input);
    expect(output.length).toBe(input.length);
    expect(output).not.toContain("<%");
    expect(output.startsWith(`<a title="`)).toBe(true);
    expect(output.endsWith(`">`)).toBe(true);
    // The neutralized span between the quotes is all whitespace.
    expect(output.slice(10, -2).trim()).toBe("");
  });

  it("preserves newlines inside multi-line ERB so line numbers are stable", () => {
    const input = "<% if cond\n   thing %>\n<div></div>";
    const output = neutralizeErb(input);
    // The newline inside the ERB block is kept; only non-newline chars blanked.
    expect(output.split("\n")).toHaveLength(3);
    expect(output.endsWith("<div></div>")).toBe(true);
  });

  it("handles comment and trim variants", () => {
    expect(neutralizeErb("<%# secret %>x")).toBe("             x");
    expect(neutralizeErb("<%- a -%>x")).toBe("         x");
  });

  it("leaves non-ERB markup untouched", () => {
    const input = `<div data-controller="stimeo--menu"></div>`;
    expect(neutralizeErb(input)).toBe(input);
  });
});
