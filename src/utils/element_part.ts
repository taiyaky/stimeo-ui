/**
 * The element a selector names within `root`, which may be `root` itself.
 *
 * A target declaration is a space-separated token list, so one element can name
 * several at once: a row built from a `<template>` is its own row target, its own
 * label, and its own button where the author writes it that way. `querySelector`
 * never returns its receiver, so resolving a part with it alone reaches nothing on
 * such a row and leaves it rendered but inert.
 *
 * The selector is composed by the caller, so a tag name written into it still
 * narrows the match — a row that is not a `<button>` does not answer for one.
 *
 * @example
 * ```ts
 * const button = matchingPart<HTMLButtonElement>(row, `button${selector("remove")}`);
 * ```
 */
export function matchingPart<E extends HTMLElement = HTMLElement>(
  root: HTMLElement,
  selector: string,
): E | null {
  return root.matches(selector) ? (root as unknown as E) : root.querySelector<E>(selector);
}

/**
 * Writes `text` as the label of `slot`, keeping the elements nested inside it.
 *
 * A row that names itself its own label holds the rest of the row inside the
 * element the text goes into — the remove button among them. Replacing the whole
 * subtree takes those with it and leaves a chip that is rendered but has nothing to
 * press, so only the slot's own text moves: the first text node carries the value
 * and the rest go, which puts the label where the template left room for it. A slot
 * holding nothing but text is written whole, which is the ordinary row.
 */
export function writeLabel(slot: HTMLElement, text: string): void {
  if (slot.childElementCount === 0) {
    slot.textContent = text;
    return;
  }
  let first: ChildNode | null = null;
  for (const node of Array.from(slot.childNodes)) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    if (first) node.remove();
    else first = node;
  }
  if (first) first.nodeValue = text;
  else slot.prepend(text);
}

/**
 * Reads back the label {@link writeLabel} wrote, without what sits beside it.
 *
 * The same row that holds the remove button inside its label slot returns that
 * button's glyph from `textContent`, which is enough to make a comparison
 * against the authored label never match — so every pass rewrites a label that
 * did not change — and to put the glyph into an announcement. Only the slot's
 * own text nodes carry the label, which on the ordinary row — a slot holding
 * nothing but text — is the whole of it.
 */
export function readLabel(slot: HTMLElement | null): string {
  if (!slot) return "";
  let text = "";
  for (const node of Array.from(slot.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) text += node.nodeValue ?? "";
  }
  return text.trim();
}
