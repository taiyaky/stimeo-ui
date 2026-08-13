import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";

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
 * `itemSelector`) on connect and on every mutation that can change that count,
 * toggles `hidden` on `list` / `empty` at the 0 ↔ 1+ boundary, and reflects
 * `data-empty` / `data-count` on the controller element. Crossing the boundary
 * dispatches `change` after the display is updated, so a listener reads the
 * state the crossing produced.
 *
 * @remarks
 * Behavior only — the placeholder's look/copy is the consumer's. State is derived
 * from the DOM (no module-scope state), so `connect()` re-syncs after a Turbo
 * Stream insertion. Both targets are re-resolved at runtime: a `list` element
 * swapped in re-points the observation, and a swapped-in `empty` element is
 * re-synced — including when the replacement is inserted while the original is
 * still in the document. The `MutationObserver` is severed on `disconnect()`
 * (Turbo navigation included). `announceText` / `announceFilledText` are read at
 * the crossing and handed to the page's announcer.
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
    announceText: { type: String, default: "" },
    announceFilledText: { type: String, default: "" },
  };
  static events = ["change"] as const;

  declare readonly listTarget: HTMLElement;
  declare readonly emptyTarget: HTMLElement;
  declare readonly hasListTarget: boolean;
  declare readonly hasEmptyTarget: boolean;

  declare itemSelectorValue: string;
  declare announceTextValue: string;
  declare announceFilledTextValue: string;

  #observer: MutationObserver | null = null;
  /** Whether the controller is between `connect()` and `disconnect()`. */
  #connected = false;
  /** Last applied empty state; `null` until the first sync so connect emits nothing. */
  #empty: boolean | null = null;

  override connect(): void {
    this.#connected = true;
    this.#syncObservation();
    this.#update();
  }

  override disconnect(): void {
    this.#connected = false;
    this.#stopObserving();
  }

  /** Follows a `list` element swapped in at runtime (Turbo Stream `replace` / morph). */
  listTargetConnected(): void {
    this.#resync();
  }

  /** Releases the observation when the `list` element leaves the target set. */
  listTargetDisconnected(): void {
    this.#resync();
  }

  /** Syncs an `empty` element that arrives — or is replaced — at runtime. */
  emptyTargetConnected(): void {
    this.#resync();
  }

  /**
   * Syncs the `empty` element that remains when one leaves the target set. A
   * single-target getter resolves to the first `empty` element in document order,
   * so a swap that inserts the replacement *before* removing the original (Turbo
   * Stream `after` / `before` / `append` followed by `remove`) leaves the
   * replacement untouched until the original goes — this callback is that moment.
   */
  emptyTargetDisconnected(): void {
    this.#resync();
  }

  /** Re-renders when application code (or a Turbo morph) changes `itemSelector` at runtime. */
  itemSelectorValueChanged(): void {
    this.#resync();
  }

  /**
   * Re-points the observation and re-renders after a target or selector change.
   * The `#connected` guard is load-bearing: Stimulus runs value and target
   * callbacks for the initial markup *before* `connect()` and runs target
   * callbacks during teardown *after* `disconnect()`, and re-observing there
   * would outlive the controller.
   */
  #resync(): void {
    if (!this.#connected) return;
    this.#syncObservation();
    this.#update();
  }

  /**
   * Points the mutation observation at the current `list` target — re-resolved on
   * every sync rather than captured at connect, so an element swapped in at
   * runtime is observed instead of the detached original.
   *
   * The observation covers exactly what the count predicate reads. With no
   * `itemSelector` the count is the child element count, which only `childList`
   * can change. With one, the predicate reads the children themselves, so
   * attribute and descendant mutations are watched too — and the controller's own
   * writes are filtered back out, or toggling `hidden` would re-enter the render.
   */
  #syncObservation(): void {
    this.#stopObserving();
    if (!this.hasListTarget || typeof MutationObserver === "undefined") return;
    const watchesItems = this.itemSelectorValue.length > 0;
    this.#observer = new MutationObserver((records) => {
      if (records.some((record) => this.#affectsCount(record))) this.#update();
    });
    this.#observer.observe(this.listTarget, {
      childList: true,
      subtree: watchesItems,
      attributes: watchesItems,
    });
  }

  #stopObserving(): void {
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /**
   * Whether a mutation can change the item count. An attribute written on a
   * target this controller owns is its own echo — `hidden` on `list` / `empty`,
   * and the hooks on the controller element when the list *is* that element.
   */
  #affectsCount(record: MutationRecord): boolean {
    if (record.type !== "attributes") return true;
    const own =
      record.target === this.listTarget ||
      (this.hasEmptyTarget && record.target === this.emptyTarget);
    return !own;
  }

  /**
   * Renders the count, then reports a crossed boundary. The announcement copy is
   * read here rather than while rendering: it is the wording of the report, not
   * an input to what is displayed.
   */
  #update(): void {
    const count = this.#render();
    if (count === null) return;
    const empty = count === 0;
    // Report only when the 0 ↔ 1+ boundary is crossed (not on the initial sync,
    // and not for count changes that stay non-empty, e.g. 2 → 3).
    const crossed = this.#empty !== null && empty !== this.#empty;
    this.#empty = empty;
    if (!crossed) return;

    this.dispatch("change", { detail: { count, empty } });
    // The crossing is the news, and the page's announcer reads it: a region that
    // only becomes live when the empty state appears is not reliably announced.
    announce(
      fillTemplate(empty ? this.announceTextValue : this.announceFilledTextValue, { count }),
    );
  }

  /**
   * Syncs visibility and the state hooks to the current item count, and returns
   * it. `null` when there is no `list` target to count.
   *
   * @stimeoRenderRoot
   */
  #render(): number | null {
    if (!this.hasListTarget) return null;
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
    return count;
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
}
