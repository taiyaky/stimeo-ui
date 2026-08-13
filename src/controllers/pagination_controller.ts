import { Controller } from "@hotwired/stimulus";
import { canTakeFocus } from "../utils/focus_candidate";
import { TabindexLoan } from "../utils/tabindex_loan";

/**
 * Headless, accessible pagination behavior.
 *
 * Markup contract (identifier: `stimeo--pagination`):
 *   <nav data-controller="stimeo--pagination" aria-label="Pagination"
 *        data-stimeo--pagination-page-value="1"
 *        data-stimeo--pagination-total-value="5">
 *     <button type="button" data-stimeo--pagination-target="prev"
 *             data-action="click->stimeo--pagination#prev">Prev</button>
 *     <button type="button" data-page="1" aria-current="page"
 *             data-stimeo--pagination-target="page"
 *             data-action="click->stimeo--pagination#select">1</button>
 *     <!-- more page buttons -->
 *     <button type="button" data-stimeo--pagination-target="next"
 *             data-action="click->stimeo--pagination#next">Next</button>
 *   </nav>
 *
 * There is no dedicated APG pattern; this uses a navigation landmark plus
 * `aria-current="page"`. The controller owns current-page state, the
 * `aria-current` sync, boundary disabling of prev/next, and the change event.
 * Generating/eliding the page buttons and fetching data stay with the consumer.
 *
 * `prev`/`next` must be real `<button>` elements: the boundary state is applied
 * through the native `disabled` property, which no other element honors.
 *
 * @remarks
 * Behavior only — each control is in the natural Tab order (no roving). When a
 * boundary disables the button that currently has focus, focus is moved first so
 * it is never lost to a `disabled` element.
 *
 * Behavior provided:
 * - `select` reads the clicked button's `data-page` and makes it current. The
 *   value must parse as an integer; blank/fractional/non-numeric ones are ignored.
 * - `prev`/`next` step by one, clamped to `[1, total]`.
 * - The current page button gets `aria-current="page"` (removed from the rest);
 *   `prev` is `disabled` at page 1 and `next` at `total`.
 * - `page`/`total` are normalized (`total` to a finite integer >= 1, `page` into
 *   `[1, total]`) on connect **and** on every runtime Value change, so JS-driven
 *   updates re-render. Normalization never dispatches `change`: it is a display
 *   correction, not a user navigation, and the initial render is consumer-owned.
 * - Page/boundary buttons swapped in at runtime re-render through the Stimulus
 *   target callbacks, so a consumer-regenerated button list stays in sync.
 * - Every navigation dispatches `stimeo--pagination:change`, whose `detail.total`
 *   is the same normalized total the boundary state is derived from.
 *
 * The boundary `disabled` is **owned**: the controller marks what it disabled
 * with `data-stimeo--pagination-boundary-disabled` and releases only that. A
 * button already disabled by the consumer is never marked when it overlaps a
 * boundary, so loading / permission state survives both entering and leaving the
 * boundary. The marker lives in the DOM rather than in a field so ownership
 * survives a Turbo cache restore, where a fresh instance would otherwise either
 * strand or steal the flag.
 */
export class PaginationController extends Controller<HTMLElement> {
  static override targets = ["page", "prev", "next"];
  static override values = {
    page: { type: Number, default: 1 },
    total: { type: Number, default: 1 },
  };
  static actions = ["next", "prev", "select"] as const;
  static events = ["change"] as const;

  /** Marks a `disabled` this controller applied at a boundary (ownership flag). */
  static readonly #BOUNDARY_ATTR = "data-stimeo--pagination-boundary-disabled";

  declare readonly pageTargets: HTMLElement[];
  declare readonly prevTarget: HTMLButtonElement;
  declare readonly nextTarget: HTMLButtonElement;
  declare readonly hasPrevTarget: boolean;
  declare readonly hasNextTarget: boolean;
  declare pageValue: number;
  declare totalValue: number;

  #isConnected = false;
  /** The `tabindex` this instance lends the root for the focus fallback. */
  readonly #tabindex = new TabindexLoan();

  /** Normalizes out-of-range initial values and renders the initial state. */
  override connect(): void {
    this.#isConnected = true;
    this.#normalizeAndRender();
  }

  /** Reverts the one attribute the controller adds outside its state hooks. */
  override disconnect(): void {
    this.#isConnected = false;
    this.#tabindex.returnAll();
  }

  /** Re-renders when application code (or a Turbo morph) changes `page` at runtime. */
  pageValueChanged(): void {
    if (!this.#isConnected) return;
    this.#normalizeAndRender();
  }

  /** Re-renders when application code (or a Turbo morph) changes `total` at runtime. */
  totalValueChanged(): void {
    if (!this.#isConnected) return;
    this.#normalizeAndRender();
  }

  /** Syncs a page button appended/replaced at runtime (the consumer owns the list). */
  pageTargetConnected(): void {
    if (!this.#isConnected) return;
    this.#render();
  }

  /** Syncs a `prev` button appended/replaced at runtime. */
  prevTargetConnected(): void {
    if (!this.#isConnected) return;
    this.#render();
  }

  /** Syncs a `next` button appended/replaced at runtime. */
  nextTargetConnected(): void {
    if (!this.#isConnected) return;
    this.#render();
  }

  /** Makes the clicked page button (its `data-page`) current. */
  select(event: Event): void {
    const button = event.currentTarget as HTMLElement;
    const raw = button.dataset.page;
    if (raw === undefined || raw.trim() === "") return;
    const page = Number(raw);
    // Integer-only, matching `stimeo--stepper`: `Number("")` is 0 and `Number("2.7")`
    // truncates, so a bare finite check would accept meaningless page numbers.
    if (!Number.isInteger(page)) return;
    this.#goto(page);
  }

  /** Steps to the previous page. */
  prev(): void {
    this.#goto(this.#page - 1);
  }

  /** Steps to the next page. */
  next(): void {
    this.#goto(this.#page + 1);
  }

  /** Moves to `page` (clamped to `[1, total]`), re-renders, and dispatches `change`. */
  #goto(page: number): void {
    if (!Number.isFinite(page)) return;
    const previous = this.#page;
    const target = this.#clamp(page);
    if (target === previous) return;
    this.pageValue = target;
    this.#render();
    this.dispatch("change", {
      detail: { page: target, total: this.#total, previous },
    });
  }

  /** Writes the normalized Values back (only when they differ) and renders. */
  #normalizeAndRender(): void {
    // Stimulus setters rewrite the data attribute unconditionally, so guard the
    // no-op case to avoid waking consumer MutationObservers for nothing.
    const total = this.#total;
    if (!Object.is(total, this.totalValue)) this.totalValue = total;
    const page = this.#page;
    if (!Object.is(page, this.pageValue)) this.pageValue = page;
    this.#render();
  }

  /**
   * Syncs `aria-current` on the page buttons and the prev/next `disabled` state.
   *
   * @stimeoRenderRoot
   */
  #render(): void {
    const page = this.#page;
    for (const button of this.pageTargets) {
      if (Number(button.dataset.page) === page) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    }

    const prev = this.hasPrevTarget ? this.prevTarget : null;
    const next = this.hasNextTarget ? this.nextTarget : null;
    const atStart = page <= 1;
    const atEnd = page >= this.#total;
    // Resolve both post-render states up front: a focus hand-off must target the
    // opposite button as it will be *after* this pass, not as it is now (moving
    // between the two boundaries of a 2-page set re-enables it in the same pass).
    const prevStaysDisabled = this.#disabledAfter(prev, atStart);
    const nextStaysDisabled = this.#disabledAfter(next, atEnd);
    // Release before disabling, so the hand-off can land on a button this same
    // pass re-enables (focusing a still-`disabled` button is a no-op).
    this.#release(prev, atStart);
    this.#release(next, atEnd);
    this.#disable(prev, atStart, nextStaysDisabled ? null : next);
    this.#disable(next, atEnd, prevStaysDisabled ? null : prev);
  }

  /** Whether a boundary button will still be `disabled` once this render applies. */
  #disabledAfter(button: HTMLButtonElement | null, atBoundary: boolean): boolean {
    if (!button) return true;
    if (atBoundary) return true;
    // Away from a boundary, only the controller's own `disabled` is released.
    return button.disabled && !this.#owns(button);
  }

  /** Releases the boundary `disabled` this controller owns, once away from it. */
  #release(button: HTMLButtonElement | null, atBoundary: boolean): void {
    if (!button || atBoundary || !this.#owns(button)) return;
    button.disabled = false;
    button.removeAttribute(PaginationController.#BOUNDARY_ATTR);
  }

  /**
   * Disables a boundary button, first moving focus off it when it is the active
   * element so disabling never strands focus.
   */
  #disable(
    button: HTMLButtonElement | null,
    atBoundary: boolean,
    opposite: HTMLButtonElement | null,
  ): void {
    if (!button || !atBoundary) return;
    if (button.disabled && !this.#owns(button)) return;
    if (button === document.activeElement) this.#moveFocusAwayFrom(opposite);
    button.disabled = true;
    button.setAttribute(PaginationController.#BOUNDARY_ATTR, "");
  }

  /**
   * Moves focus to `opposite` (already resolved to `null` when it will stay
   * disabled), else to the current page button, else to the landmark itself.
   */
  #moveFocusAwayFrom(opposite: HTMLButtonElement | null): void {
    const page = this.#page;
    const currentPage = this.pageTargets.find(
      (candidate) => Number(candidate.dataset.page) === page,
    );
    // Checked before the call, never after: `hidden` and natively disabled
    // elements swallow `focus()` silently, so an unchecked destination leaves the
    // caret in the subtree that is about to disable and drops it to <body> a frame
    // later — the outcome this rescue exists to prevent.
    // Narrowed to `HTMLElement`, not `HTMLButtonElement`: `pageTargets` is typed
    // `HTMLElement[]`, so a page control can legitimately be an `<a>`. The
    // destination is only ever focused, so the wider type is the honest one.
    const destination = [opposite, currentPage].find(
      (candidate): candidate is HTMLElement => candidate != null && canTakeFocus(candidate),
    );
    if (destination) {
      destination.focus();
      return;
    }
    // Nothing left to hand focus to (a lone boundary button, or every page button
    // disabled): keep it inside the pagination landmark instead of letting the
    // browser drop it to <body> when the button disables. The root is made
    // programmatically focusable just-in-time with `tabindex="-1"`, which is not a
    // Tab stop; `disconnect()` removes it again when this controller added it.
    this.#tabindex.lend(this.element);
    this.element.focus();
  }

  /** Total pages, normalized to a finite integer >= 1. */
  get #total(): number {
    const total = this.totalValue;
    return Number.isFinite(total) ? Math.max(1, Math.trunc(total)) : 1;
  }

  /** The current page, normalized into `[1, total]`. */
  get #page(): number {
    return this.#clamp(this.pageValue);
  }

  /** Constrains `page` to `[1, total]`; a non-finite page falls back to page 1. */
  #clamp(page: number): number {
    if (!Number.isFinite(page)) return 1;
    return Math.min(this.#total, Math.max(1, Math.trunc(page)));
  }

  /** Whether the button's current `disabled` was applied by boundary control. */
  #owns(button: HTMLButtonElement): boolean {
    return button.hasAttribute(PaginationController.#BOUNDARY_ATTR);
  }
}
