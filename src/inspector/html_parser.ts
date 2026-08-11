/**
 * A minimal, dependency-free HTML tokenizer/tree builder.
 *
 * The Inspector deliberately ships **zero runtime dependencies** beyond the
 * Stimulus peer, so rather than pull in a DOM library we build just enough of a
 * tree to answer the only questions the checker asks:
 * "which `stimeo--*` attributes exist, where, and inside which controller
 * scope?". The parser is intentionally lenient — real-world ERB output has
 * unclosed tags and stray markup — and never throws.
 *
 * It is **not** a spec-compliant HTML parser and should not be used for
 * anything beyond static attribute inspection.
 */

/** A parsed attribute, with the source position of its name. */
export interface ParsedAttr {
  /** Lowercased attribute name (HTML attribute names are case-insensitive). */
  readonly name: string;
  /** Attribute value (without surrounding quotes); empty for boolean attrs. */
  readonly value: string;
  /** 1-based line of the attribute name. */
  readonly line: number;
  /** 1-based column of the attribute name. */
  readonly column: number;
  /**
   * Length of the token at {@link column} **as the source spells it**, when
   * that differs from {@link name} — the Ruby key a `data:` hash entry was
   * written as, whose rendered attribute name appears nowhere in the file.
   * `undefined` on parsed markup, where the two are the same text.
   */
  readonly sourceLength?: number;
  /**
   * Absolute source offset where the value text begins (inside the quotes);
   * absent for boolean attributes. ERB neutralization preserves offsets, so a
   * consumer can map the range back onto the *raw* source — this is how the
   * checker tells an authored value from a dynamically-generated one.
   */
  readonly valueStart?: number;
  /** Absolute source offset just past the value text; see {@link valueStart}. */
  readonly valueEnd?: number;
  /**
   * Set on {@link SyntheticElement} attributes, whose value cannot be judged by
   * the ERB-overlap test: their source range lies *inside* an ERB tag whether
   * or not the value itself is a literal. `undefined` on parsed markup, leaving
   * that test in charge.
   */
  readonly dynamicValue?: boolean;
}

/** Where a node came from; see {@link ElementNode.origin}. */
export type NodeOrigin = "markup" | "erb";

/** Tag name given to every {@link SyntheticElement}. */
export const ERB_ELEMENT_TAG = "#erb";

/**
 * An element the caller decodes from something this parser cannot read — a
 * Rails helper call whose `data:` hash renders as attributes — and asks to have
 * spliced into the tree at its source offset.
 *
 * Splicing at parse time rather than rewriting the source keeps every reported
 * position pointing at the template: the offsets below are raw-source offsets,
 * and the surrounding markup is parsed exactly as it was written.
 */
export interface SyntheticElement {
  readonly tag: string;
  readonly attrs: readonly ParsedAttr[];
  /** Absolute source offset where the node begins. */
  readonly start: number;
  /** See {@link ElementNode.sourceLength}. */
  readonly sourceLength: number;
  /** Absolute source offset just past the node (and its children, if any). */
  readonly end: number;
  /** Whether markup between {@link start} and {@link end} nests inside the node. */
  readonly container: boolean;
  /** See {@link ElementNode.opaque}. */
  readonly opaque: boolean;
}

/** An element node in the lenient tree. */
export interface ElementNode {
  /** Lowercased tag name; the synthetic root uses `#root`. */
  readonly tag: string;
  readonly attrs: readonly ParsedAttr[];
  readonly children: ElementNode[];
  parent: ElementNode | null;
  /** 1-based line of the tag's `<`. */
  readonly line: number;
  /** 1-based column of the tag's `<`. */
  readonly column: number;
  /**
   * Length of the token at {@link column} **as the source spells it**, when the
   * node has no `<tag` to underline — an `erb` node is introduced by its ERB
   * delimiter and nothing else. `undefined` on parsed markup.
   */
  readonly sourceLength?: number;
  /**
   * Whether the node was parsed from markup or spliced in from a
   * {@link SyntheticElement}. An `erb` node knows its `data-*` attributes and
   * nothing else — it has no real tag name, no `role`, no `aria-*` — so a rule
   * reading any other attribute must skip it rather than read the absence as
   * authored.
   */
  readonly origin: NodeOrigin;
  /**
   * Whether the node's `data-*` set may be **incomplete**: a helper whose
   * `data:` option is an expression, or a hash this parser's caller could not
   * enumerate. Such an element may carry wiring nobody can name, so an absence
   * around it proves nothing.
   */
  readonly opaque: boolean;
}

/** Elements that never have children and so are never pushed onto the stack. */
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements whose content is raw text (no nested elements to parse). */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);

const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f"]);

/** Maps absolute string offsets to 1-based line/column positions. */
export class PositionIndex {
  readonly #lineStarts: number[] = [0];

  constructor(source: string) {
    for (let i = 0; i < source.length; i++) {
      if (source[i] === "\n") this.#lineStarts.push(i + 1);
    }
  }

  at(offset: number): { line: number; column: number } {
    // Binary search for the last line start that is <= offset.
    let lo = 0;
    let hi = this.#lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.#lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - (this.#lineStarts[lo] ?? 0) + 1 };
  }
}

/**
 * Parses HTML (already ERB-neutralized) into a lenient element tree.
 *
 * @param source - HTML source to parse.
 * @param synthetics - Elements decoded elsewhere to splice in at their source
 *   offsets, ordered by `start`. They are dropped rather than spliced where
 *   they fall inside markup that has no element boundary to sit at — within a
 *   start tag's attribute list, or inside raw-text content.
 * @returns The synthetic `#root` node whose children are the top-level elements.
 */
export function parseHtml(
  source: string,
  synthetics: readonly SyntheticElement[] = [],
): ElementNode {
  const pos = new PositionIndex(source);
  const len = source.length;
  /** Bounds-safe character access (out of range yields an empty string). */
  const ch = (k: number): string => (k >= 0 && k < len ? (source[k] as string) : "");

  const root: ElementNode = {
    tag: "#root",
    attrs: [],
    children: [],
    parent: null,
    line: 1,
    column: 1,
    origin: "markup",
    opaque: false,
  };
  const stack: ElementNode[] = [root];
  let i = 0;

  const top = (): ElementNode => stack[stack.length - 1] as ElementNode;

  /** Index of the next unconsumed synthetic. */
  let pending = 0;
  /** Where each spliced-in container closes, so the stack unwinds on time. */
  const closesAt = new Map<ElementNode, number>();

  /**
   * Consumes every synthetic that begins at or before `offset`, splicing it
   * into the tree when `splice` is set and discarding it otherwise (the
   * offsets the parser skips over wholesale have no place to put a node).
   */
  const takeSynthetics = (offset: number, splice: boolean): void => {
    while (pending < synthetics.length) {
      const synthetic = synthetics[pending] as SyntheticElement;
      if (synthetic.start > offset) return;
      pending++;
      if (!splice) continue;
      const at = pos.at(synthetic.start);
      const node: ElementNode = {
        tag: synthetic.tag,
        attrs: synthetic.attrs,
        children: [],
        parent: top(),
        line: at.line,
        column: at.column,
        sourceLength: synthetic.sourceLength,
        origin: "erb",
        opaque: synthetic.opaque,
      };
      top().children.push(node);
      if (synthetic.container) {
        closesAt.set(node, synthetic.end);
        stack.push(node);
      }
    }
  };

  /**
   * Unwinds spliced-in containers whose source range has been passed, together
   * with whatever sits above them. A container's expiry is decided by the
   * source, not by the stack: markup opened inside it and never closed (`<p>`
   * before an `<% end %>`) leaves ordinary elements on top, and leaving the
   * container open until they close would nest the rest of the file inside a
   * helper the template has already ended.
   */
  const closeSynthetics = (offset: number): void => {
    for (;;) {
      let expired = -1;
      for (let depth = stack.length - 1; depth >= 1; depth--) {
        const end = closesAt.get(stack[depth] as ElementNode);
        if (end !== undefined && end <= offset) {
          expired = depth;
          break;
        }
      }
      if (expired < 0) return;
      stack.length = expired;
    }
  };

  while (i < len) {
    closeSynthetics(i);
    takeSynthetics(i, true);
    if (ch(i) !== "<") {
      i++;
      continue;
    }

    const next = ch(i + 1);

    // Comment: <!-- ... -->
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      i = end === -1 ? len : end + 3;
      takeSynthetics(i - 1, false);
      continue;
    }
    // Markup declaration (<!DOCTYPE ...>) or processing instruction (<? ... ?>).
    if (next === "!" || next === "?") {
      const end = source.indexOf(">", i);
      i = end === -1 ? len : end + 1;
      takeSynthetics(i - 1, false);
      continue;
    }
    // End tag: </name>
    if (next === "/") {
      let j = i + 2;
      let name = "";
      while (j < len && ch(j) !== ">" && !WHITESPACE.has(ch(j))) {
        name += ch(j);
        j++;
      }
      const end = source.indexOf(">", j);
      i = end === -1 ? len : end + 1;
      takeSynthetics(i - 1, false);
      closeTag(stack, name.toLowerCase());
      continue;
    }
    // Not a tag start (e.g. a stray "<"); treat as text.
    if (!/[a-zA-Z]/.test(next)) {
      i++;
      continue;
    }

    // Start tag.
    const tagStart = i;
    let j = i + 1;
    let tagName = "";
    while (j < len && !WHITESPACE.has(ch(j)) && ch(j) !== ">" && ch(j) !== "/") {
      tagName += ch(j);
      j++;
    }
    const lowerTag = tagName.toLowerCase();
    const attrs: ParsedAttr[] = [];

    // Parse attributes until the tag closes.
    let selfClosing = false;
    while (j < len) {
      while (j < len && WHITESPACE.has(ch(j))) j++;
      if (j >= len) break;
      if (ch(j) === ">") {
        j++;
        break;
      }
      if (ch(j) === "/") {
        selfClosing = true;
        j++;
        continue;
      }

      // Attribute name.
      const nameStart = j;
      let attrName = "";
      while (j < len && !WHITESPACE.has(ch(j)) && ch(j) !== "=" && ch(j) !== ">" && ch(j) !== "/") {
        attrName += ch(j);
        j++;
      }

      let attrValue = "";
      let valueStart: number | undefined;
      let valueEnd: number | undefined;
      // Optional value.
      let k = j;
      while (k < len && WHITESPACE.has(ch(k))) k++;
      if (ch(k) === "=") {
        k++;
        while (k < len && WHITESPACE.has(ch(k))) k++;
        const quote = ch(k);
        if (quote === '"' || quote === "'") {
          k++;
          const valStart = k;
          while (k < len && ch(k) !== quote) k++;
          attrValue = source.slice(valStart, k);
          valueStart = valStart;
          valueEnd = k;
          k++; // skip closing quote
        } else {
          const valStart = k;
          while (k < len && !WHITESPACE.has(ch(k)) && ch(k) !== ">") k++;
          attrValue = source.slice(valStart, k);
          valueStart = valStart;
          valueEnd = k;
        }
        j = k;
      }

      if (attrName.length > 0) {
        const p = pos.at(nameStart);
        attrs.push({
          name: attrName.toLowerCase(),
          value: attrValue,
          line: p.line,
          column: p.column,
          valueStart,
          valueEnd,
        });
      }
    }

    const startPos = pos.at(tagStart);
    const node: ElementNode = {
      tag: lowerTag,
      attrs,
      children: [],
      parent: top(),
      line: startPos.line,
      column: startPos.column,
      origin: "markup",
      opaque: false,
    };
    top().children.push(node);

    i = j;
    // Anything inside the start tag itself is an attribute fragment, not an
    // element — a helper called there contributes to *this* tag, and splicing
    // it in as a sibling would put its wiring on the wrong element.
    takeSynthetics(i - 1, false);

    if (selfClosing || VOID_ELEMENTS.has(lowerTag)) {
      continue;
    }

    if (RAW_TEXT_ELEMENTS.has(lowerTag)) {
      // Skip raw-text content so `<` inside scripts/styles is not parsed as markup.
      const closeNeedle = `</${lowerTag}`;
      const idx = source.toLowerCase().indexOf(closeNeedle, i);
      if (idx === -1) {
        i = len;
      } else {
        const gt = source.indexOf(">", idx);
        i = gt === -1 ? len : gt + 1;
      }
      takeSynthetics(i - 1, false);
      continue;
    }

    stack.push(node);
  }

  closeSynthetics(len);
  takeSynthetics(len, true);

  return root;
}

/** Pops the stack down to (and including) the nearest matching open tag. */
function closeTag(stack: ElementNode[], name: string): void {
  for (let depth = stack.length - 1; depth >= 1; depth--) {
    if (stack[depth]?.tag === name) {
      stack.length = depth;
      return;
    }
  }
  // No matching open tag — ignore the stray end tag.
}

/** Depth-first walk over every element node (excluding the synthetic root). */
export function walk(root: ElementNode, visit: (node: ElementNode) => void): void {
  for (const child of root.children) {
    visit(child);
    walk(child, visit);
  }
}
