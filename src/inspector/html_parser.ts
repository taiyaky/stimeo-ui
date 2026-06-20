/**
 * A minimal, dependency-free HTML tokenizer/tree builder.
 *
 * The Inspector deliberately ships **zero runtime dependencies** beyond the
 * Stimulus peer (see project invariants), so rather than pull in a DOM library
 * we build just enough of a tree to answer the only questions the checker asks:
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
class PositionIndex {
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
 * @returns The synthetic `#root` node whose children are the top-level elements.
 */
export function parseHtml(source: string): ElementNode {
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
  };
  const stack: ElementNode[] = [root];
  let i = 0;

  const top = (): ElementNode => stack[stack.length - 1] as ElementNode;

  while (i < len) {
    if (ch(i) !== "<") {
      i++;
      continue;
    }

    const next = ch(i + 1);

    // Comment: <!-- ... -->
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    // Markup declaration (<!DOCTYPE ...>) or processing instruction (<? ... ?>).
    if (next === "!" || next === "?") {
      const end = source.indexOf(">", i);
      i = end === -1 ? len : end + 1;
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
          k++; // skip closing quote
        } else {
          const valStart = k;
          while (k < len && !WHITESPACE.has(ch(k)) && ch(k) !== ">") k++;
          attrValue = source.slice(valStart, k);
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
    };
    top().children.push(node);

    i = j;

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
      continue;
    }

    stack.push(node);
  }

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
