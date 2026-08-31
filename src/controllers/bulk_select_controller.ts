import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";

/** The selection figures every report carries. */
type SelectionDetail = { count: number; allPages: boolean };

/**
 * Headless **bulk select / batch action bar** (no dedicated APG pattern — a
 * composition of a checkbox group and a toolbar). Mirrors the Gmail/admin UX where
 * checking one or more rows reveals a sticky action bar with the selected count,
 * select-all, and clear. Data Grid owns per-row `aria-selected`; this is the
 * contextual action-bar layer on top.
 *
 * Markup contract (identifier: `stimeo--bulk-select`):
 *   <div data-controller="stimeo--bulk-select"
 *        data-stimeo--bulk-select-total-count-value="128"
 *        data-stimeo--bulk-select-announce-text-value="{count} selected">
 *     <input type="checkbox" data-stimeo--bulk-select-target="all">
 *     <!-- rows (may be added dynamically; handled via event delegation) -->
 *     <input type="checkbox" data-stimeo--bulk-select-target="item">
 *     <input type="checkbox" data-stimeo--bulk-select-target="item">
 *     <div data-stimeo--bulk-select-target="bar" hidden role="toolbar"
 *          data-controller="stimeo--toolbar" aria-label="Bulk actions">
 *       <span data-stimeo--bulk-select-target="count"></span> selected
 *       <button data-stimeo--bulk-select-target="selectAllPages"
 *               data-stimeo--toolbar-target="control"
 *               data-action="click->stimeo--bulk-select#selectAllPages">Select all</button>
 *       <button data-stimeo--toolbar-target="control"
 *               data-action="click->stimeo--bulk-select#clear">Clear</button>
 *     </div>
 *   </div>
 *
 * The bar carries `role="toolbar"`, so it is composed with `stimeo--toolbar` to get
 * the arrow-key movement and single tab stop that role calls for.
 *
 * `change` and `reconcile` both dispatch `{ count, allPages }`.
 *
 * Selection is two-stage. The select-all box covers the rows on this page; the
 * optional `selectAllPages` control extends the selection to `totalCount` rows
 * across every page, checking each row here as it does so. Touching any single row
 * leaves that mode, because the selection is no longer the whole set.
 *
 * @remarks
 * Behavior only — it never runs the batch action (that is the consumer's
 * form/Turbo) nor fetches/pages rows. Selection lives **only** in each checkbox's
 * `checked` (no module-scope set), so `connect()` recomputes idempotently from the
 * DOM after a Turbo swap. Row `change` is handled by **delegation** on the
 * container, so dynamically-added rows work without per-row `data-action`, while
 * rows arriving or leaving on their own are picked up by the target callbacks and
 * coalesced into one repair per batch.
 *
 * `change` is dispatched when the user moves the selection; `reconcile` when the
 * controller repairs the figures itself — a row added or removed by the page, or a
 * render input changing at runtime. Both carry the same detail.
 *
 * The count reaches assistive tech through the page's shared `stimeo--announcer`,
 * worded by the consumer via `announceText` (`{count}` expands to the figure being
 * shown; an empty template stays silent, keeping announcements opt-in and
 * i18n-neutral).
 *
 * Showing the bar never steals focus (WCAG 2.2 2.4.3). Hiding it hands focus to
 * the select-all box first when the bar holds it, so the keyboard user keeps a Tab
 * position instead of falling back to the document.
 *
 * A non-finite `totalCount` falls back to the Value's default and is written back
 * to the attribute, so the count never renders as `NaN`.
 *
 * The delegated listener and the pending repair are both released on `disconnect()`.
 */
export class BulkSelectController extends Controller<HTMLElement> {
  static override targets = ["all", "item", "bar", "count", "selectAllPages"];
  static override values = {
    totalCount: { type: Number, default: 0 },
    announceText: { type: String, default: "" },
  };
  static actions = ["clear", "selectAllPages"] as const;
  static events = ["change", "reconcile"] as const;

  declare readonly allTarget: HTMLInputElement;
  declare readonly barTarget: HTMLElement;
  declare readonly countTarget: HTMLElement;
  declare readonly itemTargets: HTMLInputElement[];
  declare readonly hasAllTarget: boolean;
  declare readonly hasBarTarget: boolean;
  declare readonly hasCountTarget: boolean;

  declare totalCountValue: number;
  declare announceTextValue: string;

  /** All-pages mode is a transient UI state, mirrored to `data-all-pages` so a
   *  `connect()` over markup that already carries the attribute rehydrates the
   *  mode — a morph, a Turbo Stream, a server that renders it back, or a restore
   *  visit, whose cached snapshot carries the attribute too. */
  #allPagesMode = false;
  /** Last emitted figures, so a recompute reports only on a real change. */
  #lastCount = -1;
  #lastAllPages = false;

  /** Collapses every signal from one DOM or Value update into one repair. */
  readonly #reconcile = new MicrotaskCoalescer(() => this.#reconcileNow());

  /** Delegated `change` handler covering the select-all box and every row. */
  readonly #onChange = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (this.hasAllTarget && target === this.allTarget) {
      this.#applyAll();
    } else if (this.itemTargets.some((item) => item === target)) {
      this.#exitAllPages();
      this.#reportChange(this.#recompute());
    }
  };

  override connect(): void {
    this.#allPagesMode = this.element.dataset.allPages === "true";
    this.#reconcile.activate();
    this.element.addEventListener("change", this.#onChange);
    this.#recompute();
  }

  override disconnect(): void {
    this.element.removeEventListener("change", this.#onChange);
    this.#reconcile.cancel();
  }

  /** Repairs the figures for a row that arrived at runtime. */
  itemTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Repairs the figures after a row leaves, so a removed selection stops counting. */
  itemTargetDisconnected(): void {
    this.#reconcile.schedule();
  }

  /** Reflects the current selection onto a select-all box added at runtime. */
  allTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Repairs the figures after the select-all box leaves. */
  allTargetDisconnected(): void {
    this.#reconcile.schedule();
  }

  /** Repaints the count for a total that changed at runtime, rejecting non-finite ones. */
  totalCountValueChanged(): void {
    if (!Number.isFinite(this.totalCountValue)) {
      this.totalCountValue = 0;
      return;
    }
    this.#reconcile.schedule();
  }

  /** Repaints so wording changed at runtime is used by the next announcement. */
  announceTextValueChanged(): void {
    this.#reconcile.schedule();
  }

  /** Clears every selection (rows + select-all) and exits all-pages mode. */
  clear(): void {
    for (const item of this.itemTargets) item.checked = false;
    if (this.hasAllTarget) {
      this.allTarget.checked = false;
      this.allTarget.indeterminate = false;
    }
    this.#exitAllPages();
    this.#reportChange(this.#recompute());
  }

  /**
   * Enters "select all across pages" mode: the count shows `totalCount`, and every
   * row on this page is checked.
   *
   * The mode's claim is that the whole set is selected, so leaving a visible row
   * unchecked would put the page and the count in open disagreement.
   */
  selectAllPages(): void {
    this.#allPagesMode = true;
    this.#checkEveryRow();
    this.#reportChange(this.#recompute());
  }

  /** Marks every row on this page selected. */
  #checkEveryRow(): void {
    for (const item of this.itemTargets) item.checked = true;
  }

  /** Mirrors the select-all box to every row, then recomputes. */
  #applyAll(): void {
    if (!this.hasAllTarget) return;
    const { checked } = this.allTarget;
    for (const item of this.itemTargets) item.checked = checked;
    this.#exitAllPages();
    this.#reportChange(this.#recompute());
  }

  #exitAllPages(): void {
    this.#allPagesMode = false;
  }

  /** Repairs the derived state after the page moved rows or a render input. */
  #reconcileNow(): void {
    // A row that arrives while the whole set is selected is one of the rows the
    // mode already claims, so it lands checked instead of contradicting the count.
    if (this.#allPagesMode) this.#checkEveryRow();
    const detail = this.#recompute();
    if (!detail) return;
    this.dispatch("reconcile", { detail });
    this.#announce(detail);
  }

  /** Reports a selection the user moved. */
  #reportChange(detail: SelectionDetail | null): void {
    if (!detail) return;
    this.dispatch("change", { detail });
    this.#announce(detail);
  }

  /** Hands the count to the shared announcer, worded by the consumer. */
  #announce(detail: SelectionDetail): void {
    announce(fillTemplate(this.announceTextValue, { count: detail.count }));
  }

  /**
   * Recomputes the count, the select-all checked/indeterminate state, and the bar
   * visibility from the current DOM. Returns the figures when the emitted count or
   * all-pages flag actually moved, and `null` when they did not.
   *
   * @stimeoRenderRoot
   */
  #recompute(): SelectionDetail | null {
    const items = this.itemTargets;
    const total = items.length;
    const checked = items.filter((item) => item.checked).length;
    const allPages = this.#allPagesMode;

    if (this.hasAllTarget) {
      this.allTarget.checked = total > 0 && checked === total;
      this.allTarget.indeterminate = checked > 0 && checked < total;
    }

    const count = allPages ? this.totalCountValue : checked;
    const show = allPages || checked > 0;

    if (this.hasBarTarget) {
      // Hand the Tab position over before the bar leaves, or focus falls to the
      // document and the keyboard user loses their place.
      if (!show && this.hasAllTarget && this.barTarget.contains(document.activeElement)) {
        this.allTarget.focus();
      }
      this.barTarget.hidden = !show;
    }
    if (this.hasCountTarget) this.countTarget.textContent = String(count);

    this.element.setAttribute("data-selected-count", String(checked));
    if (allPages) this.element.setAttribute("data-all-pages", "true");
    else this.element.removeAttribute("data-all-pages");

    const changed = count !== this.#lastCount || allPages !== this.#lastAllPages;
    this.#lastCount = count;
    this.#lastAllPages = allPages;
    return changed ? { count, allPages } : null;
  }
}
