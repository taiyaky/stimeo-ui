import { describe, expect, it } from "vitest";
import {
  type ElementNode,
  ERB_ELEMENT_TAG,
  parseHtml,
  type SyntheticElement,
  walk,
} from "../../src/inspector/html_parser";

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

  it("records absolute value offsets (and none for boolean attributes)", () => {
    const source = `<div id="x" hidden data=y>`;
    const attrs = parseHtml(source).children[0]?.attrs ?? [];
    const [id, hidden, data] = attrs;
    expect(source.slice(id?.valueStart, id?.valueEnd)).toBe("x");
    expect(hidden?.valueStart).toBeUndefined();
    expect(source.slice(data?.valueStart, data?.valueEnd)).toBe("y");
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

  it("marks parsed markup as such", () => {
    const div = parseHtml("<div></div>").children[0];
    expect(div?.origin).toBe("markup");
    expect(div?.opaque).toBe(false);
  });

  /**
   * Splicing puts elements the parser cannot tokenize — a Rails helper's
   * rendered tag — at their source offset, so the caller's decoded wiring lands
   * in the same scope the template puts it in.
   */
  describe("spliced-in elements", () => {
    /** A synthetic element spanning `[start, end)` of the source. */
    function synthetic(start: number, end: number, container = false): SyntheticElement {
      return {
        tag: ERB_ELEMENT_TAG,
        attrs: [],
        start,
        sourceLength: 3,
        end,
        container,
        opaque: false,
      };
    }

    it("nests a leaf at the element that encloses its offset", () => {
      const source = `<div>  <span></span></div>`;
      const root = parseHtml(source, [synthetic(5, 7)]);
      const div = root.children[0];
      expect(div?.children.map((c) => c.tag)).toEqual([ERB_ELEMENT_TAG, "span"]);
      expect(div?.children[0]?.origin).toBe("erb");
    });

    it("takes the markup inside a container's span as its children", () => {
      //         0123456789…      the container covers the blanked helper + <p>
      const source = `      <p></p>     <b></b>`;
      const root = parseHtml(source, [synthetic(0, 13, true)]);
      const [container, bold] = root.children;
      expect(container?.children.map((c) => c.tag)).toEqual(["p"]);
      expect(bold?.tag).toBe("b");
    });

    it("reports the source position of its offset", () => {
      const root = parseHtml("<div>\n  x\n</div>", [synthetic(8, 9)]);
      expect(root.children[0]?.children[0]).toMatchObject({ line: 2, column: 3 });
    });

    it("drops one that falls inside a start tag, where no element boundary is", () => {
      // A helper called between attributes contributes to *that* tag; splicing
      // it as a sibling would put its wiring on the wrong element.
      const source = `<div        id="x"></div>`;
      const root = parseHtml(source, [synthetic(5, 11)]);
      expect(flatten(root).map((n) => n.tag)).toEqual(["div"]);
    });

    it("drops one that falls inside raw-text content", () => {
      const source = `<script>        </script>`;
      const root = parseHtml(source, [synthetic(9, 15)]);
      expect(flatten(root).map((n) => n.tag)).toEqual(["script"]);
    });

    it("carries the opaque flag through", () => {
      const root = parseHtml("  ", [{ ...synthetic(0, 2), opaque: true }]);
      expect(root.children[0]?.opaque).toBe(true);
    });

    it("closes a container that markup left open, together with that markup", () => {
      // The `<p>` is never closed, so the container's own end is the only thing
      // that can say where it stops; the `<b>` after it is a sibling.
      //                0123456789…       the container covers the helper + <p>
      const source = `      <p>Hint     <b></b>`;
      const root = parseHtml(source, [synthetic(0, 13, true)]);
      const [container, bold] = root.children;
      expect(container?.children.map((c) => c.tag)).toEqual(["p"]);
      expect(bold?.tag).toBe("b");
    });

    it("closes nested containers that expire at the same offset", () => {
      //               both helpers blanked   <p> unclosed   sibling
      const source = `${" ".repeat(12)}<p>x<b></b>`;
      const root = parseHtml(source, [synthetic(0, 16, true), synthetic(6, 16, true)]);
      const [outer, bold] = root.children;
      const inner = outer?.children[0];
      expect(inner?.tag).toBe(ERB_ELEMENT_TAG);
      expect(inner?.children.map((c) => c.tag)).toEqual(["p"]);
      expect(bold?.tag).toBe("b");
    });

    it("reports the source span of the token that introduced it", () => {
      const root = parseHtml("     ", [{ ...synthetic(0, 5), sourceLength: 4 }]);
      expect(root.children[0]?.sourceLength).toBe(4);
    });
  });
});
