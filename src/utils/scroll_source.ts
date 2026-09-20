/**
 * What a scroll-driven component listens to and measures: a scroll container
 * somewhere in the page, or the window when nothing names one.
 *
 * A component that reacts to scrolling takes a selector for the container it
 * lives in and falls back to the viewport. Resolving that, and reading how far
 * the result has scrolled, are the same two steps everywhere — and the read is
 * the one that drifts, because the window and an element expose the offset under
 * different names.
 *
 * Resolution only. A selector reaches here already validated, or empty; whether
 * a declaration parses is decided once where it is declared, not on every
 * resolve.
 */

/** A scroll container, or the window. */
export type ScrollSource = HTMLElement | Window;

/**
 * The scroll container `selector` names, or `null` for the viewport.
 *
 * `null` covers every way a container can fail to be one: an empty selector, a
 * selector that matches nothing, and a match that is not an `HTMLElement` — an
 * SVG node answers a query but does not scroll.
 *
 * `selector` must be empty or already validated: an unparsable one makes the
 * query throw rather than fall back.
 */
export function resolveScrollContainer(selector: string): HTMLElement | null {
  const match = selector ? document.querySelector(selector) : null;
  return match instanceof HTMLElement ? match : null;
}

/** The scroll source `selector` names: its container, else the window. */
export function resolveScrollSource(selector: string): ScrollSource {
  return resolveScrollContainer(selector) ?? window;
}

/**
 * How far `source` has scrolled vertically.
 *
 * The window is compared by identity rather than with `instanceof`, which a
 * cross-realm or synthetic DOM fails. Its offset is read through the modern name
 * first and the legacy one after, so a runtime that exposes only one still gives
 * a number.
 */
export function scrollOffset(source: ScrollSource): number {
  return source === window
    ? (window.scrollY ?? window.pageYOffset ?? 0)
    : (source as HTMLElement).scrollTop;
}
