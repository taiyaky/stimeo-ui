import { describe, expect, it } from "vitest";
import { erbElements, erbRanges, neutralizeErb } from "../../src/inspector/erb";

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

describe("erbRanges", () => {
  it("reports each tag's span so a value can be tested for interpolation", () => {
    const source = `<a title="<%= x %>">`;
    expect(erbRanges(source)).toEqual([[source.indexOf("<%"), source.indexOf("%>") + 2]]);
  });
});

/**
 * Tests for the elements recovered from Rails helper calls. The contract is
 * narrow on purpose: only an output tag naming a `data:` option becomes an
 * element, so a template without one parses exactly as it always did.
 */
describe("erbElements", () => {
  it("recovers a helper's data: hash as attributes", () => {
    const source = `<%= f.text_area :body, data: { "stimeo--menu-target": "item" } %>`;
    const [element] = erbElements(source);
    expect(element?.attrs.map((a) => [a.name, a.value])).toEqual([
      ["data-stimeo--menu-target", "item"],
    ]);
    expect(element?.start).toBe(0);
    expect(element?.container).toBe(false);
    expect(element?.opaque).toBe(false);
  });

  it("marks a value the helper computes as dynamic", () => {
    const [element] = erbElements(`<%= tag.div data: { controller: kind } %>`);
    expect(element?.attrs[0]?.dynamicValue).toBe(true);
  });

  it("spans a block helper through its matching end tag", () => {
    const source = `<%= form_with url: "/x", data: { controller: "stimeo--menu" } do |f| %>\n<% end %>`;
    const [element] = erbElements(source);
    expect(element?.container).toBe(true);
    expect(element?.end).toBe(source.length);
  });

  it("is not fooled by an intervening block that is not the helper's", () => {
    const source = [
      `<%= form_with url: "/x", data: { controller: "stimeo--menu" } do |f| %>`,
      `<% if cond %>`,
      `<% end %>`,
      `<% end %>`,
      `<div></div>`,
    ].join("\n");
    const [element] = erbElements(source);
    // The second `end` closes the helper; the div that follows stays outside it.
    expect(element?.end).toBe(source.lastIndexOf("<% end %>") + "<% end %>".length);
  });

  it("leaves an unclosed block a leaf rather than swallowing the file", () => {
    const source = `<%= form_with url: "/x", data: { controller: "stimeo--menu" } do |f| %>\n<div></div>`;
    const [element] = erbElements(source);
    expect(element?.container).toBe(false);
  });

  /**
   * Which markup a helper scopes is decided by where its block ends, so the
   * pairing has to survive every spelling of a block that is not one.
   */
  describe("block pairing", () => {
    /** Where the helper's container ends, or `null` when it stays a leaf. */
    function containerEnd(source: string): number | null {
      const [element] = erbElements(source);
      return element?.container ? (element?.end ?? null) : null;
    }

    it("keeps a block that opens and closes inside one tag out of the pairing", () => {
      const source = [
        `<%= form_with url: "/x", data: { controller: "stimeo--menu" } do |f| %>`,
        `<% if cond; audit!; end %>`,
        `<% end %>`,
      ].join("\n");
      expect(containerEnd(source)).toBe(source.length);
    });

    it("reads a modifier if as the qualifier it is, not as a block", () => {
      const source = [
        `<%= form_with url: "/x", data: { controller: "stimeo--menu" } do |f| %>`,
        `<% render "row" if cond %>`,
        `<% end %>`,
      ].join("\n");
      expect(containerEnd(source)).toBe(source.length);
    });

    it("does not open a block on a symbol that spells a keyword", () => {
      // `mode: :do` names a value; the `<% end %>` belongs to the `<% if %>`.
      const source = [
        `<% if show %>`,
        `<%= render "menu", data: { controller: "stimeo--menu" }, mode: :do %>`,
        `<% end %>`,
      ].join("\n");
      expect(containerEnd(source)).toBeNull();
    });

    it("keeps the container when a comment follows the do", () => {
      const source = [
        `<%= form_with url: "/x", data: { controller: "stimeo--menu" } do |f| # the form %>`,
        `<% end %>`,
      ].join("\n");
      expect(containerEnd(source)).toBe(source.length);
    });

    it("counts a brace block, and lets a hash literal cancel itself out", () => {
      const braced = `<%= tag.div data: { controller: "stimeo--menu" } %>`;
      expect(containerEnd(braced)).toBeNull();
      const block = [
        `<% items.each { |i| %>`,
        `<%= tag.div data: { controller: "stimeo--menu" } %>`,
        `<% } %>`,
      ].join("\n");
      expect(containerEnd(block)).toBeNull();
    });

    it("does not count the do that belongs to a while header", () => {
      const source = [
        `<% while more? do %>`,
        `<%= tag.div data: { controller: "stimeo--menu" } %>`,
        `<% end %>`,
      ].join("\n");
      expect(containerEnd(source)).toBeNull();
    });
  });

  it("ignores tags that render nothing", () => {
    // A non-output tag puts no element on the page, and a comment is not code.
    expect(erbElements(`<% x = { data: { controller: "stimeo--menu" } } %>`)).toEqual([]);
    expect(erbElements(`<%# data: { controller: "stimeo--menu" } %>`)).toEqual([]);
  });

  it("ignores an output tag that names no data: option", () => {
    expect(erbElements(`<%= render "components/menu" %>`)).toEqual([]);
  });

  it("flags a helper whose data: option cannot be enumerated", () => {
    const [element] = erbElements(`<%= f.text_area :body, data: field_attrs %>`);
    expect(element?.opaque).toBe(true);
    expect(element?.attrs).toEqual([]);
  });

  it("positions attributes at the hash key in the original template", () => {
    const source = `<div>\n  <%= tag.span data: { controller: "stimeo--menu" } %>\n</div>`;
    const [element] = erbElements(source);
    expect(element?.attrs[0]).toMatchObject({ line: 2, column: 24 });
  });

  it("spans the tokens the source holds, not the names they render as", () => {
    const source = `<%= tag.span data: { "stimeo--menu-target": "item" } %>`;
    const [element] = erbElements(source);
    expect(element?.sourceLength).toBe("<%=".length);
    expect(element?.attrs[0]?.sourceLength).toBe(`"stimeo--menu-target"`.length);
  });
});
