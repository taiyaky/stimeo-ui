/** Normalized scroll position and maximum distance on one logical axis. */
export interface LogicalScrollMetrics {
  position: number;
  max: number;
}

/**
 * Whether horizontal scrolling on `element` follows right-to-left inline flow.
 *
 * Resolved from the **computed** `direction`, so the authoring contract is the
 * usual `dir="rtl"` (or a stylesheet) on the element or any ancestor.
 *
 * Scope: horizontal writing modes. A vertical writing mode (`writing-mode:
 * vertical-rl`) also inverts the horizontal axis, which this check does not
 * model — vertical writing modes are out of scope for the scroll utilities
 * (their consumers describe axes as horizontal/vertical, not inline/block).
 */
export function isRtl(element: Element): boolean {
  return window.getComputedStyle(element).direction === "rtl";
}

/**
 * Returns scroll distance from the logical start edge.
 *
 * CSSOM View exposes standards-mode RTL horizontal offsets as `0` at the inline
 * start (right) and increasingly negative values toward the inline end (left).
 * The normalized position is always clamped to `[0, max]`, which also absorbs
 * Safari's elastic overscroll values.
 */
export function logicalScrollMetrics(
  element: HTMLElement,
  horizontal: boolean,
): LogicalScrollMetrics {
  const max = Math.max(
    0,
    horizontal
      ? element.scrollWidth - element.clientWidth
      : element.scrollHeight - element.clientHeight,
  );
  const raw = horizontal ? element.scrollLeft : element.scrollTop;
  const position = horizontal && isRtl(element) ? -raw : raw;
  return { position: Math.min(max, Math.max(0, position)), max };
}

/**
 * Converts a logical start/end delta to the physical value accepted by
 * `Element.scrollBy`.
 */
export function physicalScrollDelta(
  element: HTMLElement,
  horizontal: boolean,
  logicalDelta: number,
): number {
  return horizontal && isRtl(element) ? -logicalDelta : logicalDelta;
}
