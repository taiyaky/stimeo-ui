import { Controller } from "@hotwired/stimulus";
import { actionSource } from "../utils/action_source";
import { canTakeFocus } from "../utils/focus_candidate";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import { MoveCounter } from "../utils/move_counter";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { type StateReason, stateReasonFor } from "../utils/state_reason";
import { TabindexLoan } from "../utils/tabindex_loan";
import { targetSelector } from "../utils/target_selector";

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
 * through the native `disabled` property, which a `<div>` or `<a>` does not honor.
 *
 * `change` dispatches `{ page: number, total: number, previous: number, reason: StateReason }`;
 * `reconcile` dispatches `{ page: number, total: number, previous: number }`
 * — `previous` is the page shown before — when a change the page made moves the
 * current page.
 *
 * User `change` reports compare the resulting state with the last published
 * state. A pending page write handled in the same script joins that confirmation;
 * a browser-delivered listener may settle it first as `reconcile`. Confirming
 * the last published state reports nothing.
 *
 * A synchronous subscriber that confirms another state replaces reports still
 * pending for the outer confirmation. Reading state or confirming it unchanged
 * does not replace them. An event already being dispatched cannot be recalled.
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
 * - `page`/`total` are read through a clamp (`total` as a finite integer >= 1,
 *   `page` into `[1, total]`) on connect **and** on every runtime Value change, so
 *   JS-driven updates re-render. The clamp is for display only: the Values keep
 *   what the page declared, so a `page` beyond the current `total` is shown as soon
 *   as a later `total` reaches it, and only a navigation writes `page`.
 * - Runtime Value changes and page/boundary buttons swapped in at runtime
 *   re-render once per batch, so a consumer-regenerated button list stays in
 *   sync. Re-rendering never dispatches `change`: it is not a user navigation.
 *   Once connected, a batch that moves the current page away from the one shown
 *   dispatches `stimeo--pagination:reconcile` once; the initial render reports
 *   nothing.
 * - A navigation that moves the published page dispatches `stimeo--pagination:change`, whose `detail.total`
 *   is the same clamped total the boundary state is derived from.
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
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  readonly #moves = new MoveCounter();
  #moveToken = 0;
  static override targets = ["page", "prev", "next"];
  static override values = {
    page: { type: Number, default: 1 },
    total: { type: Number, default: 1 },
  };

  static valueConstraints = {
    page: NUMBER_BOUNDS.finite,
    total: NUMBER_BOUNDS.finite,
  } satisfies NumberValueConstraints<typeof PaginationController.values>;
  static actions = ["next", "prev", "select"] as const;
  static events = ["change", "reconcile"] as const;

  /** Marks a `disabled` this controller applied at a boundary, in its own namespace. */
  get #boundaryAttribute(): string {
    return `data-${this.identifier}-boundary-disabled`;
  }

  declare readonly pageTargets: HTMLElement[];
  declare readonly prevTarget: HTMLButtonElement;
  declare readonly prevTargets: HTMLButtonElement[];
  declare readonly nextTarget: HTMLButtonElement;
  declare readonly nextTargets: HTMLButtonElement[];
  declare readonly hasPrevTarget: boolean;
  declare readonly hasNextTarget: boolean;
  declare pageValue: number;
  declare totalValue: number;

  /** The `tabindex` this instance lends the root for the focus fallback. */
  readonly #tabindex = new TabindexLoan("-1", this.identifier);

  /**
   * Collapses the Value and target callbacks of one mutation into one pass, and
   * refuses the ones Stimulus delivers before `connect()`, which renders itself.
   */
  readonly #repaint = new MorphRenderWatcher(() => this.#reconcilePage());

  /** The page shown last, which the next move of the current page is measured from. */
  #shown = 1;

  /** Renders the initial state from the clamped `page` and `total`. */
  override connect(): void {
    this.#tabindex.reclaim(this.element);
    this.#repaint.observe(this.element);
    this.#shown = this.#page;
    this.#render();
  }

  /** Drops a pending pass and reverts the one attribute added outside the state hooks. */
  override disconnect(): void {
    this.#repaint.disconnect();
    this.#tabindex.returnAll();
  }

  /** Re-renders when application code (or a Turbo morph) changes `page` at runtime. */
  pageValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Re-renders when application code (or a Turbo morph) changes `total` at runtime. */
  totalValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Syncs a page button appended/replaced at runtime (the consumer owns the list). */
  pageTargetConnected(): void {
    this.#repaint.schedule();
  }

  /** Syncs a `prev` button appended/replaced at runtime. */
  prevTargetConnected(): void {
    this.#repaint.schedule();
  }

  /**
   * Gives a `prev` that is no longer a target back the boundary `disabled` this
   * controller set, and brings the one that stays to the current boundary state.
   */
  prevTargetDisconnected(button: HTMLButtonElement): void {
    this.#releaseDeparted(button, this.prevTargets);
    this.#repaint.schedule();
  }

  /** Syncs a `next` button appended/replaced at runtime. */
  nextTargetConnected(): void {
    this.#repaint.schedule();
  }

  /**
   * Gives a `next` that is no longer a target back the boundary `disabled` this
   * controller set, and brings the one that stays to the current boundary state.
   */
  nextTargetDisconnected(button: HTMLButtonElement): void {
    this.#releaseDeparted(button, this.nextTargets);
    this.#repaint.schedule();
  }

  /** Makes the clicked page button (its `data-page`) current. */
  select(source: Event | HTMLElement): void {
    const { host, origin, reason } = actionSource(source);
    const button = host?.closest<HTMLElement>(targetSelector(this.identifier, "page"));
    if (!button || !this.pageTargets.includes(button)) return;
    if (origin && origin.closest(`[data-controller~="${this.identifier}"]`) !== this.element)
      return;
    const raw = button.dataset.page;
    if (raw === undefined || raw.trim() === "") return;
    const page = Number(raw);
    // Integer-only, matching `stimeo--stepper`: `Number("")` is 0 and `Number("2.7")`
    // is a fraction, so a bare finite check would accept meaningless page numbers.
    if (!Number.isInteger(page)) return;
    this.#goto(page, reason);
  }

  /** Steps to the previous page. */
  prev(event?: Event): void {
    this.#goto(this.#page - 1, stateReasonFor(event));
  }

  /** Steps to the next page. */
  next(event?: Event): void {
    this.#goto(this.#page + 1, stateReasonFor(event));
  }

  /** Moves to `page` (clamped to `[1, total]`), re-renders, and dispatches `change`. */
  #goto(page: number, reason: StateReason): void {
    const previous = this.#shown;
    const target = this.#clamp(page);
    if (target === previous && target === this.#page) return;
    this.pageValue = target;
    // Settled before the report, so the pass the Value write starts finds the page
    // already shown, and a listener that navigates on is measured from this page.
    this.#shown = target;
    const changed = target !== previous;
    if (changed) this.#moveToken = this.#moves.record();
    const token = this.#moveToken;
    this.#render();
    if (!changed || !this.#moves.isLatest(token)) return;
    this.dispatch("change", {
      detail: { page: target, total: this.#total, previous, reason },
    });
  }

  /**
   * Renders one settled batch of Value and target changes, and reports a current
   * page that moved from the one shown before as `reconcile`.
   */
  #reconcilePage(): void {
    const previous = this.#shown;
    const page = this.#page;
    this.#shown = page;
    const token = this.#moveToken;
    this.#render();
    if (page !== previous && this.#moves.isLatest(token)) {
      this.dispatch("reconcile", { detail: { page, total: this.#total, previous } });
    }
  }

  /**
   * Syncs `aria-current` on the page buttons and the prev/next `disabled` state.
   *
   * It reads `page` and `total` through their clamps and never writes either Value,
   * so a declaration outside the range stays in the attributes as the page wrote it.
   *
   * @stimeoRenderRoot
   */
  #render(): void {
    const token = this.#moveToken;
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
    // Resolve the next button's future state before disabling the previous one.
    // The previous button is already settled when the next one hands focus off.
    const nextStaysDisabled = this.#disabledAfter(next, atEnd);
    // Release before disabling, so the hand-off can land on a button this same
    // pass re-enables (focusing a still-`disabled` button is a no-op).
    this.#release(prev, atStart);
    this.#release(next, atEnd);
    this.#disable(prev, atStart, nextStaysDisabled ? null : next);
    if (!this.#moves.isLatest(token)) return;
    this.#disable(next, atEnd, prev);
  }

  /** Whether a boundary button will still be `disabled` once this render applies. */
  #disabledAfter(button: HTMLButtonElement | null, atBoundary: boolean): boolean {
    if (!button) return true;
    if (atBoundary) return true;
    // Away from a boundary, only the controller's own `disabled` is released.
    return button.disabled && !this.#owns(button);
  }

  /**
   * Releases the boundary `disabled` this controller owns on a button that has
   * stopped being a target. A button still among `targets` has only moved inside
   * the element, or is torn down along with it, and keeps its marker for the next
   * connection to read.
   */
  #releaseDeparted(button: HTMLButtonElement, targets: readonly HTMLButtonElement[]): void {
    if (!targets.includes(button)) this.#release(button, false);
  }

  /** Releases the boundary `disabled` this controller owns, once away from it. */
  #release(button: HTMLButtonElement | null, atBoundary: boolean): void {
    if (!button || atBoundary || !this.#owns(button)) return;
    button.disabled = false;
    button.removeAttribute(this.#boundaryAttribute);
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
    const token = this.#moveToken;
    if (button === document.activeElement) this.#moveFocusAwayFrom(opposite);
    if (!this.#moves.isLatest(token)) return;
    button.disabled = true;
    button.setAttribute(this.#boundaryAttribute, "");
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
    const total = this.#safeTotal;
    return Math.max(1, Math.trunc(total));
  }

  /** The current page, normalized into `[1, total]`. */
  get #page(): number {
    return this.#clamp(this.#safePage);
  }

  /** Constrains a finite page to the live `[1, total]` range. */
  #clamp(page: number): number {
    return Math.min(this.#total, Math.max(1, Math.trunc(page)));
  }

  /** Whether the button's current `disabled` was applied by boundary control. */
  #owns(button: HTMLButtonElement): boolean {
    return button.hasAttribute(this.#boundaryAttribute);
  }
  /** Current `page` declaration resolved against its numeric contract. */
  get #safePage(): number {
    return this.#numbers.read(
      this,
      "page",
      this.pageValue,
      PaginationController.values.page.default,
      PaginationController.valueConstraints.page,
    );
  }

  /** Current `total` declaration resolved against its numeric contract. */
  get #safeTotal(): number {
    return this.#numbers.read(
      this,
      "total",
      this.totalValue,
      PaginationController.values.total.default,
      PaginationController.valueConstraints.total,
    );
  }
}
