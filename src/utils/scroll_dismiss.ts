/**
 * Invokes `onScroll` when the page — or any scrollable ancestor of `element` —
 * scrolls, returning a cleanup that detaches every listener.
 *
 * `scroll` events do not bubble, and a single capture-phase listener on
 * `window`/`document` is unreliable for descendant scroll containers — so this
 * attaches a `scroll` listener directly to each scroll-parent ancestor (walking
 * `parentElement` and checking `overflow`) plus the window. That mirrors the
 * *intent* of `@floating-ui/dom`'s `autoUpdate` scroll tracking; it is a
 * deliberately simple resolver and does not cross shadow roots. This is precisely
 * the case a consumer cannot cover with `data-action` alone, which is why the
 * surface controllers own it.
 *
 * The listeners are `passive` (the handler never calls `preventDefault`), so they
 * never delay scrolling. Pass the surface's anchor/root so the relevant scroll
 * parents are found even when the floating element is portaled elsewhere.
 */
export function observeScrollDismiss(element: Element, onScroll: () => void): () => void {
  const targets: Array<Element | Window> = [...scrollParents(element), window];
  const handler = (): void => onScroll();
  for (const target of targets) {
    target.addEventListener("scroll", handler, { passive: true });
  }
  return () => {
    for (const target of targets) target.removeEventListener("scroll", handler);
  };
}

/** The scrollable ancestors of `element`, nearest first (window excluded). */
function scrollParents(element: Element): Element[] {
  const parents: Element[] = [];
  let node = element.parentElement;
  while (node) {
    if (isScrollable(node)) parents.push(node);
    node = node.parentElement;
  }
  return parents;
}

/** Whether `element` is a scroll container (any axis `auto`/`scroll`/`overlay`). */
function isScrollable(element: Element): boolean {
  const style = getComputedStyle(element);
  return /auto|scroll|overlay/.test(style.overflow + style.overflowX + style.overflowY);
}
