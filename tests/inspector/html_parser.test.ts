import { describe, expect, it } from "vitest";
import { type ElementNode, parseHtml, walk } from "../../src/inspector/html_parser";

/** Collects every element node (excluding the synthetic root) into a flat list. */
function flatten(root: ElementNode): ElementNode[] {
  const nodes: ElementNode[] = [];
  walk(root, (node) => nodes.push(node));
  return nodes;
}

/**
 * Tests for the lenient HTML parser: attribute extraction with accurate
 * positions, tolerant nesting, void/raw-text handling.
 */
describe("parseHtml", () => {
  it("builds a tree with parent/child relationships", () => {
    const root = parseHtml("<div><span></span></div>");
    expect(root.children).toHaveLength(1);
    const div = root.children[0];
    expect(div?.tag).toBe("div");
    expect(div?.children[0]?.tag).toBe("span");
    expect(div?.children[0]?.parent).toBe(div);
  });

  it("records attribute names lowercased with values and positions", () => {
    const root = parseHtml(`<div\n  data-controller="stimeo--menu">`);
    const attr = root.children[0]?.attrs[0];
    expect(attr?.name).toBe("data-controller");
    expect(attr?.value).toBe("stimeo--menu");
    expect(attr?.line).toBe(2);
    expect(attr?.column).toBe(3);
  });

  it("parses boolean attributes and unquoted values", () => {
    const root = parseHtml("<input hidden type=text>");
    const attrs = root.children[0]?.attrs ?? [];
    expect(attrs.map((a) => a.name)).toEqual(["hidden", "type"]);
    expect(attrs[0]?.value).toBe("");
    expect(attrs[1]?.value).toBe("text");
  });

  it("treats void elements as childless", () => {
    const root = parseHtml("<ul><br><li></li></ul>");
    const ul = root.children[0];
    // <br> is void, so <li> is a sibling of <br>, both children of <ul>.
    expect(ul?.children.map((c) => c.tag)).toEqual(["br", "li"]);
  });

  it("skips raw-text content so markup inside <script> is not parsed", () => {
    const root = parseHtml(
      `<div data-controller="stimeo--otp"><script>el.on('stimeo--otp:complete')</script></div>`,
    );
    const nodes = flatten(root);
    // Only <div> and <script>; the script's text yields no extra elements.
    expect(nodes.map((n) => n.tag)).toEqual(["div", "script"]);
  });

  it("tolerates unclosed and stray tags without throwing", () => {
    expect(() => parseHtml("<div><span> 1 < 2 </div>")).not.toThrow();
    const root = parseHtml("<div><p>text");
    expect(flatten(root).map((n) => n.tag)).toEqual(["div", "p"]);
  });
});
