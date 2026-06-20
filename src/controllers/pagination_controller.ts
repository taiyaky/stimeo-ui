import { Controller } from "@hotwired/stimulus";

/**
 * Headless, accessible pagination behavior.
 *
 * Markup contract (identifier: `stimeo--pagination`):
 *   <nav data-controller="stimeo--pagination" aria-label="Pagination"
 *        data-stimeo--pagination-page-value="1"
 *        data-stimeo--pagination-total-value="5">
 *     <button type="button" data-stimeo--pagination-target="prev"
 *             data-action="stimeo--pagination#prev">Prev</button>
 *     <button type="button" data-page="1" aria-current="page"
 *             data-stimeo--pagination-target="page"
 *             data-action="stimeo--pagination#select">1</button>
 *     <!-- more page buttons -->
 *     <button type="button" data-stimeo--pagination-target="next"
 *             data-action="stimeo--pagination#next">Next</button>
 *   </nav>
 *
 * There is no dedicated APG pattern; this uses a navigation landmark plus
 * `aria-current="page"`. The controller owns current-page state, the
 * `aria-current` sync, boundary disabling of prev/next, and the change event.
 * Generating/eliding the page buttons and fetching data stay with the consumer.
 *
 * @remarks
 * Behavior only — each control is in the natural Tab order (no roving). When a
 * boundary disables the button that currently has focus, focus is moved first so
 * it is never lost to a `disabled` element.
 *
 * Behavior provided:
 * - `select` reads the clicked button's `data-page` and makes it current.
 * - `prev`/`next` step by one, clamped to `[1, total]`.
 * - The current page button gets `aria-current="page"` (removed from the rest);
 *   `prev` is `disabled` at page 1 and `next` at `total`.
 * - Every change dispatches `stimeo--pagination:change`.
 */
export class PaginationController extends Controller<HTMLElement> {
  static override targets = ["page", "prev", "next"];
  static override values = {
    page: { type: Number, default: 1 },
    total: { type: Number, default: 1 },
  };
  static actions = ["next", "prev", "select"] as const;
  static events = ["change"] as const;

  declare readonly pageTargets: HTMLElement[];
  declare readonly prevTarget: HTMLButtonElement;
  declare readonly nextTarget: HTMLButtonElement;
  declare readonly hasPrevTarget: boolean;
  declare readonly hasNextTarget: boolean;
  declare pageValue: number;
  declare totalValue: number;

  /** Normalizes out-of-range initial values and renders the initial state. */
  override connect(): void {
    this.totalValue = Math.max(1, Math.trunc(this.totalValue));
    this.pageValue = Math.min(this.totalValue, Math.max(1, Math.trunc(this.pageValue)));
    this.#render();
  }

  /** Makes the clicked page button (its `data-page`) current. */
  select(event: Event): void {
    const button = event.currentTarget as HTMLElement;
    const page = Number(button.dataset.page);
    if (!Number.isFinite(page)) return;
    this.#goto(page);
  }

  /** Steps to the previous page. */
  prev(): void {
    this.#goto(this.pageValue - 1);
  }

  /** Steps to the next page. */
  next(): void {
    this.#goto(this.pageValue + 1);
  }

  /** Moves to `page` (clamped to `[1, total]`), re-renders, and dispatches `change`. */
  #goto(page: number): void {
    // Normalize total first so a stray total<=0 can't clamp the 1-based page to 0.
    const total = Math.max(1, Math.trunc(this.totalValue));
    const target = Math.min(total, Math.max(1, Math.trunc(page)));
    if (target === this.pageValue) return;
    const previous = this.pageValue;
    this.pageValue = target;
    this.#render();
    this.dispatch("change", {
      detail: { page: target, total: this.totalValue, previous },
    });
  }

  /** Syncs `aria-current` on the page buttons and the prev/next `disabled` state. */
  #render(): void {
    for (const button of this.pageTargets) {
      if (Number(button.dataset.page) === this.pageValue) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    }
    this.#setDisabled(this.hasPrevTarget ? this.prevTarget : null, this.pageValue <= 1);
    this.#setDisabled(
      this.hasNextTarget ? this.nextTarget : null,
      this.pageValue >= this.totalValue,
    );
  }

  /**
   * Sets `disabled` on a boundary button, first moving focus off it if it is the
   * active element so disabling never strands focus.
   */
  #setDisabled(button: HTMLButtonElement | null, disabled: boolean): void {
    if (!button) return;
    if (disabled && button === document.activeElement) {
      this.#moveFocusAwayFrom(button);
    }
    button.disabled = disabled;
  }

  /** Moves focus to the opposite enabled control, falling back to the current page. */
  #moveFocusAwayFrom(button: HTMLButtonElement): void {
    const opposite =
      button === (this.hasPrevTarget ? this.prevTarget : null)
        ? this.hasNextTarget
          ? this.nextTarget
          : null
        : this.hasPrevTarget
          ? this.prevTarget
          : null;
    const currentPage = this.pageTargets.find(
      (candidate) => Number(candidate.dataset.page) === this.pageValue,
    );
    const destination = opposite && !opposite.disabled ? opposite : currentPage;
    if (destination) {
      destination.focus();
      return;
    }
    // Degenerate config (e.g. a lone boundary button, no page buttons): keep focus
    // inside the pagination landmark instead of letting the browser drop it to
    // <body> when the button disables. The root is made programmatically focusable
    // just-in-time with `tabindex="-1"`, which is not a Tab stop.
    if (!this.element.hasAttribute("tabindex")) this.element.setAttribute("tabindex", "-1");
    this.element.focus();
  }
}
