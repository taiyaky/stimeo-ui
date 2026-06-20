import { Controller } from "@hotwired/stimulus";

/**
 * Headless **bulk select / batch action bar** (no dedicated APG pattern — a
 * composition of a checkbox group and a toolbar). Mirrors the Gmail/admin UX where
 * checking one or more rows reveals a sticky action bar with the selected count,
 * select-all, and clear. Data Grid owns per-row `aria-selected`; this is the
 * contextual action-bar layer on top.
 *
 * Markup contract (identifier: `stimeo--bulk-select`):
 *   <div data-controller="stimeo--bulk-select"
 *        data-stimeo--bulk-select-total-count-value="128">
 *     <input type="checkbox" data-stimeo--bulk-select-target="all">
 *     <!-- rows (may be added dynamically; handled via event delegation) -->
 *     <input type="checkbox" data-stimeo--bulk-select-target="item">
 *     <input type="checkbox" data-stimeo--bulk-select-target="item">
 *     <div data-stimeo--bulk-select-target="bar" hidden role="toolbar" aria-live="polite">
 *       <span data-stimeo--bulk-select-target="count"></span> selected
 *       <button data-stimeo--bulk-select-target="selectAllPages"
 *               data-action="click->stimeo--bulk-select#selectAllPages">Select all</button>
 *       <button data-action="click->stimeo--bulk-select#clear">Clear</button>
 *     </div>
 *   </div>
 *
 * @remarks
 * Behavior only — it never runs the batch action (that is the consumer's
 * form/Turbo) nor fetches/pages rows. Selection lives **only** in each checkbox's
 * `checked` (no module-scope set), so `connect()` recomputes idempotently from the
 * DOM after a Turbo swap. Row `change` is handled by **delegation** on the
 * container, so dynamically-added rows work without per-row `data-action`.
 * Showing the bar never steals focus
 * (WCAG 2.2 2.4.3); the count rides the bar's own `aria-live` region (WCAG 2.2
 * 4.1.3) — the bar is revealed *before* the count text is written so the change is
 * observed and announced. The delegated listener is removed on `disconnect()`.
 */
export class BulkSelectController extends Controller<HTMLElement> {
  static override targets = ["all", "item", "bar", "count", "selectAllPages"];
  static override values = {
    totalCount: { type: Number, default: 0 },
    announce: { type: Boolean, default: true },
  };
  static actions = ["clear", "selectAllPages"] as const;
  static events = ["change"] as const;

  declare readonly allTarget: HTMLInputElement;
  declare readonly barTarget: HTMLElement;
  declare readonly countTarget: HTMLElement;
  declare readonly hasAllTarget: boolean;
  declare readonly hasBarTarget: boolean;
  declare readonly hasCountTarget: boolean;

  declare totalCountValue: number;
  declare announceValue: boolean;

  /** All-pages mode is a transient UI state; mirrored to `data-all-pages` so it
   *  survives a Turbo swap and `connect()` can rehydrate it. */
  #allPagesMode = false;
  /** Last emitted figures, so a recompute dispatches `change` only on real change. */
  #lastCount = -1;
  #lastAllPages = false;

  /** Delegated `change` handler covering the select-all box and every row. */
  readonly #onChange = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (this.hasAllTarget && target === this.allTarget) {
      this.#applyAll();
    } else if (target.matches('[data-stimeo--bulk-select-target="item"]')) {
      this.#exitAllPages();
      this.#recompute(true);
    }
  };

  override connect(): void {
    this.#allPagesMode = this.element.dataset.allPages === "true";
    this.element.addEventListener("change", this.#onChange);
    this.#recompute(false);
  }

  override disconnect(): void {
    this.element.removeEventListener("change", this.#onChange);
  }

  /** Clears every selection (rows + select-all) and exits all-pages mode. */
  clear(): void {
    for (const item of this.#items) item.checked = false;
    if (this.hasAllTarget) {
      this.allTarget.checked = false;
      this.allTarget.indeterminate = false;
    }
    this.#exitAllPages();
    this.#recompute(true);
  }

  /** Enters "select all across pages" mode (count shows `totalCount`). */
  selectAllPages(): void {
    this.#allPagesMode = true;
    this.#recompute(true);
  }

  /** Mirrors the select-all box to every row, then recomputes. */
  #applyAll(): void {
    if (!this.hasAllTarget) return;
    const { checked } = this.allTarget;
    for (const item of this.#items) item.checked = checked;
    this.#exitAllPages();
    this.#recompute(true);
  }

  #exitAllPages(): void {
    this.#allPagesMode = false;
  }

  /**
   * Recomputes the count, the select-all checked/indeterminate state, and the bar
   * visibility from the current DOM. Dispatches `change` (when `notify`) only if
   * the emitted count or all-pages flag actually changed.
   */
  #recompute(notify: boolean): void {
    const items = this.#items;
    const total = items.length;
    const checked = items.filter((item) => item.checked).length;
    const allPages = this.#allPagesMode;

    if (this.hasAllTarget) {
      this.allTarget.checked = total > 0 && checked === total;
      this.allTarget.indeterminate = checked > 0 && checked < total;
    }

    const count = allPages ? this.totalCountValue : checked;
    const show = allPages || checked > 0;

    // Reveal the bar BEFORE writing the count so its aria-live region observes the
    // text change (a region revealed after its content changed may not announce).
    if (this.hasBarTarget) {
      this.barTarget.hidden = !show;
      this.barTarget.setAttribute("aria-live", this.announceValue ? "polite" : "off");
    }
    if (this.hasCountTarget) this.countTarget.textContent = String(count);

    this.element.setAttribute("data-selected-count", String(checked));
    if (allPages) this.element.setAttribute("data-all-pages", "true");
    else this.element.removeAttribute("data-all-pages");

    const changed = count !== this.#lastCount || allPages !== this.#lastAllPages;
    this.#lastCount = count;
    this.#lastAllPages = allPages;
    if (notify && changed) {
      this.dispatch("change", { detail: { count, allPages } });
    }
  }

  /** Live list of row checkboxes, queried from the DOM so dynamic rows count. */
  get #items(): HTMLInputElement[] {
    return Array.from(
      this.element.querySelectorAll<HTMLInputElement>('[data-stimeo--bulk-select-target="item"]'),
    );
  }
}
