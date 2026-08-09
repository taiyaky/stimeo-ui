/**
 * Shared bookkeeping for a `tabindex` a controller lends an element temporarily.
 *
 * A controller that must move focus somewhere the author never made focusable
 * (a landmark root, a scroll destination) reaches for the same trick: add a
 * `tabindex` just-in-time and hand it back once it is no longer needed. The
 * borrow is the easy half; the return is what the two conditions below are for.
 *
 * **Returning needs two conditions, not one.** Owning the borrow is not enough:
 * the attribute must also still hold the value this instance wrote. A consumer
 * that changed it afterwards — `tabindex="0"` to make the root its own Tab stop
 * — owns it now, and removing it there silently discards authored markup. The
 * bookkeeping is dropped either way, since the loan is over regardless of who
 * ends up owning the value.
 *
 * **Never borrow over an existing value.** An element that already carries a
 * `tabindex` is the author's to control, so there is nothing to lend and nothing
 * to return.
 *
 * The registry is keyed by element, so a controller borrowing on a single
 * element (`this.element`) and one borrowing across a changing set of targets
 * use the same API — the single-element case is a set of one. It holds no
 * opinion about *when* to borrow or where focus goes next; that stays in the
 * controller.
 *
 * **The API is deliberately two methods.** This file's own doc block is dropped
 * from `dist`, but every member comment is inlined into **each** consumer entry
 * (`tsup` builds with `splitting: false`), so rationale belongs here, only the
 * contract belongs on the members, and every method no consumer calls is still
 * paid for once per consumer entry.
 *
 * @example
 * ```ts
 * readonly #tabindex = new TabindexLoan();
 *
 * #rescueFocus() {
 *   this.#tabindex.lend(this.element);
 *   this.element.focus();
 * }
 *
 * disconnect() {
 *   this.#tabindex.returnAll();
 * }
 * ```
 */
export class TabindexLoan<T extends HTMLElement = HTMLElement> {
  readonly #value: string;
  readonly #lent = new Set<T>();

  /**
   * @param value - the `tabindex` to lend. `"-1"` (the default) is
   *   programmatically focusable but not a Tab stop; `"0"` is a real Tab stop,
   *   which a scroll region with no focusable content of its own needs.
   */
  constructor(value: string = "-1") {
    this.#value = value;
  }

  /** Lends `element` the value; no-ops when it already carries a `tabindex`. */
  lend(element: T): void {
    if (element.hasAttribute("tabindex")) return;
    element.setAttribute("tabindex", this.#value);
    this.#lent.add(element);
  }

  /** Takes back every loan whose value is still the one that was lent. */
  returnAll(): void {
    for (const element of this.#lent) {
      if (element.getAttribute("tabindex") === this.#value) element.removeAttribute("tabindex");
    }
    this.#lent.clear();
  }
}
