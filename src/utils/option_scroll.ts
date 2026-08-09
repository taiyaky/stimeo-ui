/**
 * Scroll-follow for virtually-focused listbox options.
 *
 * Listbox-style widgets that track their active option with
 * `aria-activedescendant` keep DOM focus on the input/trigger, so the
 * browser's native "scroll the focused element into view" never runs — in a
 * scrollable list (`max-height` + `overflow`) the active option can walk right
 * out of sight on ArrowDown/ArrowUp. This helper keeps it visible.
 *
 * It adjusts the LIST's own `scrollTop` only — deliberately not
 * `scrollIntoView({ block: "nearest" })`, which may also scroll ancestor
 * scrolling boxes (the page) when a floating popup pokes past a viewport
 * edge, desyncing anchored/marker-composed placements. (Command-palette uses
 * `scrollIntoView` because its page is scroll-locked behind the modal;
 * page-floating popups must use this helper instead.)
 */

/**
 * Scrolls `option` into view within `list` by minimally adjusting
 * `list.scrollTop`. No-ops when the list does not actually scroll. Never
 * touches any other scrolling box.
 *
 * @param list - The scrollable listbox container.
 * @param option - The (virtually focused) option to keep visible.
 */
export function scrollOptionIntoView(list: HTMLElement, option: HTMLElement): void {
  if (list.scrollHeight <= list.clientHeight) return;
  const listRect = list.getBoundingClientRect();
  const optionRect = option.getBoundingClientRect();
  if (optionRect.top < listRect.top) {
    list.scrollTop -= listRect.top - optionRect.top;
  } else if (optionRect.bottom > listRect.bottom) {
    list.scrollTop += optionRect.bottom - listRect.bottom;
  }
}
