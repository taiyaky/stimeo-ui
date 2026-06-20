import { Controller } from "@hotwired/stimulus";

/**
 * Headless empty-state behavior: shows an "empty" placeholder when a list has no
 * items and hides it once one arrives (and vice-versa), watching the list with a
 * `MutationObserver` (no dedicated APG pattern; follows the WCAG "status messages"
 * practice when announcing).
 *
 * Markup contract (identifier: `stimeo--empty-state`):
 *   <div data-controller="stimeo--empty-state">
 *     <ul data-stimeo--empty-state-target="list"><!-- Turbo Stream rows --></ul>
 *     <p data-stimeo--empty-state-target="empty" hidden>No items</p>
 *   </div>
 *
 * Counts `list`'s child items (all element children, or those matching
 * `itemSelector`) on connect and on every childList mutation, toggles `hidden` on
 * `list` / `empty` at the 0 ↔ 1+ boundary, and reflects `data-empty` / `data-count`
 * on the controller element. Crossing the boundary dispatches `change`.
 *
 * @remarks
 * Behavior only — the placeholder's look/copy is the consumer's. State is derived
 * from the DOM (no module-scope state), so `connect()` re-syncs after a Turbo
 * Stream insertion. The `MutationObserver` is severed on `disconnect()` (Turbo
 * navigation included). With `announce`, the `empty` target is made a polite live
 * region (only if the author hasn't already), so showing it is announced — SR
 * support for unhiding a live region varies; pair with Announcer for a guarantee.
 *
 * Ownership note: this controller deliberately owns `hidden` on the `list` / `empty`
 * targets as its single source of truth for which one is shown, rather than only
 * emitting `data-empty` and delegating visibility to consumer CSS. The toggle is
 * unconditional (set every sync), so there is nothing to save/restore and no
 * authored `hidden` to preserve — the displayed half is always a pure function of
 * the item count. Consumers wanting CSS-driven visibility should not also set
 * `hidden` on these targets themselves.
 */
export class EmptyStateController extends Controller<HTMLElement> {
  static override targets = ["list", "empty"];
  static override values = {
    itemSelector: { type: String, default: "" },
    announce: { type: Boolean, default: false },
  };
  static events = ["change"] as const;

  declare readonly listTarget: HTMLElement;
  declare readonly emptyTarget: HTMLElement;
  declare readonly hasListTarget: boolean;
  declare readonly hasEmptyTarget: boolean;

  declare itemSelectorValue: string;
  declare announceValue: boolean;

  #observer: MutationObserver | null = null;
  /** Last applied empty state; `null` until the first sync so connect emits nothing. */
  #empty: boolean | null = null;

  override connect(): void {
    if (!this.hasListTarget) return;
    if (this.announceValue && this.hasEmptyTarget && !this.#isLiveRegion(this.emptyTarget)) {
      this.emptyTarget.setAttribute("role", "status");
      this.emptyTarget.setAttribute("aria-live", "polite");
    }
    if (typeof MutationObserver !== "undefined") {
      this.#observer = new MutationObserver(() => this.#apply());
      this.#observer.observe(this.listTarget, { childList: true });
    }
    this.#apply();
  }

  override disconnect(): void {
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /** Recomputes the count and syncs visibility, hooks, and the change event. */
  #apply(): void {
    if (!this.hasListTarget) return;
    const count = this.#count();
    const empty = count === 0;

    this.element.setAttribute("data-count", String(count));
    if (empty) {
      this.element.setAttribute("data-empty", "true");
    } else {
      this.element.removeAttribute("data-empty");
    }
    this.listTarget.hidden = empty;
    if (this.hasEmptyTarget) this.emptyTarget.hidden = !empty;

    // Emit only when the 0 ↔ 1+ boundary is crossed (not on the initial sync, and
    // not for count changes that stay non-empty, e.g. 2 → 3).
    if (this.#empty !== null && empty !== this.#empty) {
      this.dispatch("change", { detail: { count, empty } });
    }
    this.#empty = empty;
  }

  /** Item count: element children matching `itemSelector`, or all element children. */
  #count(): number {
    const selector = this.itemSelectorValue;
    if (selector.length === 0) return this.listTarget.childElementCount;
    try {
      return Array.from(this.listTarget.children).filter((child) => child.matches(selector)).length;
    } catch {
      // An invalid selector (author typo) must not crash the controller — count all.
      return this.listTarget.childElementCount;
    }
  }

  #isLiveRegion(el: HTMLElement): boolean {
    if (el.hasAttribute("aria-live")) return true;
    const role = el.getAttribute("role");
    return role === "status" || role === "alert";
  }
}
