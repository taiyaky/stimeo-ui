/**
 * Tiny DOM lookup helpers for tests.
 *
 * Vitest assertions need concrete (non-null) elements, but the project lint bans
 * non-null assertions (`!`). These throw a readable error instead, so a missing
 * fixture fails loudly at the lookup rather than as a downstream `null` access.
 */

/** Returns the first element matching `selector`, throwing if none is found. */
export function query<T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  return element;
}

/** Returns the element with `id`, throwing if none is found. */
export function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Element not found: #${id}`);
  return element;
}
