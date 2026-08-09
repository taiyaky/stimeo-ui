/**
 * Reflects a single **active option** across an option set, writing only where
 * the value actually changes.
 *
 * Every controller that drives a virtually-focused list answers the same question
 * on each keystroke and each arrow repeat: *which one option is the active
 * candidate, and what does the rest of the set look like now?* Answering it by
 * writing `aria-selected` to **every** option is the obvious implementation, and
 * the one this helper exists to replace.
 *
 * **The write count is the point.** At most two options change per move (the old
 * active and the new one), while the option count is authored — a consumer can
 * render hundreds, and filtering re-runs this on each input event. An
 * unconditional pass costs one attribute mutation per option per keypress, each
 * one an observable DOM change that `MutationObserver`s and the a11y tree react
 * to. Comparing before writing turns O(n) mutations into O(1) without changing
 * what the DOM ends up saying.
 *
 * **`aria-selected` here means "active candidate", not "committed selection".**
 * That distinction decides where this helper may be used: in a combobox the
 * committed value lives *outside* the popup (the input's text), so
 * `aria-selected` is free to track virtual focus; in a listbox or a grid it is
 * the selection itself and must not be repurposed. Only the former kind belongs
 * here — which is why `listbox` marks its active row with `data-active` instead
 * and is deliberately not a consumer of this helper.
 *
 * Scope is deliberately narrow: this owns the option-set write and nothing else.
 * `aria-activedescendant` on the host, scrolling the active option into view, and
 * the `data-active` marker stay in the controllers, because each one differs
 * (different host element, different scroll container, and not every consumer
 * uses `data-active` at all). Folding them in would mean a helper with three
 * optional behaviours — more surface than the duplication it removes.
 *
 * This file's own doc block is dropped from `dist`, but every member comment is
 * inlined into each consumer entry (`tsup` builds with `splitting: false`), so
 * rationale belongs here and only the contract belongs on the members.
 *
 * @example
 * ```ts
 * #setActive(option: HTMLElement | null): void {
 *   syncActiveOption(this.optionTargets, option);
 *   // host-specific parts stay here: aria-activedescendant, scrolling, data-active
 * }
 * ```
 */

/**
 * Writes `aria-selected` across `options` so that exactly `active` reads `"true"`.
 *
 * Skips every option already holding the right value, so a move mutates only the
 * two that changed. Pass `null` to clear the whole set — the state a closed or
 * empty-filtered popup needs.
 *
 * `options` must be the **full** set, not the currently visible subset: an option
 * hidden by filtering while it was active would otherwise keep a stale
 * `aria-selected="true"` and resurface as selected when the filter widens.
 *
 * @param options - every option in the set, visible or not
 * @param active - the one option to mark active, or `null` to clear
 * @returns how many attributes were actually written
 */
export function syncActiveOption(
  options: Iterable<HTMLElement>,
  active: HTMLElement | null,
): number {
  let written = 0;
  for (const option of options) {
    const next = option === active ? "true" : "false";
    if (option.getAttribute("aria-selected") === next) continue;
    option.setAttribute("aria-selected", next);
    written += 1;
  }
  return written;
}
