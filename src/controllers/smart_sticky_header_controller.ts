import { Controller } from "@hotwired/stimulus";

/**
 * Headless **smart sticky header**: hides the header on scroll-down and
 * reveals it on scroll-up, published as a `data-header-hidden` hook the
 * consumer's CSS translates away (`stimeo--sticky-observer` detects *stuck*,
 * but has no direction sense; this adds it). Core (zero dependencies).
 *
 * Markup contract (identifier: `stimeo--smart-sticky-header`):
 *   <header data-controller="stimeo--smart-sticky-header"
 *           style="position: sticky; top: 0;">…</header>
 *
 * The scroll source is the window by default; inside an overflow container,
 * point `containerSelector` at it (the header usually sits inside it too).
 *   <!-- [data-header-hidden="true"] { transform: translateY(-100%); } -->
 *
 * Scrolling down past `offset` px sets `data-header-hidden="true"`; any
 * scroll-up (beyond the `tolerance` jitter guard) or returning above `offset`
 * reveals it again. Focus reaching the header always reveals it, and while
 * focus stays inside the header a scroll-down never hides it — a keyboard
 * user must be able to see where focus went AND keep seeing the element that
 * owns it (WCAG 2.4.7 / 2.4.11).
 *
 * @remarks
 * Behavior only — `position: sticky`, the translate animation, and
 * reduced-motion handling are the consumer's CSS (`prefers-reduced-motion`
 * should disable the transition, not the behavior). Scroll work is
 * rAF-throttled; listeners and any pending frame are released on
 * `disconnect()`, and `connect()` resets the transient hook (a Turbo cache
 * snapshot must not restore a hidden header at scroll top).
 */
export class SmartStickyHeaderController extends Controller<HTMLElement> {
  static override values = {
    containerSelector: { type: String, default: "" },
    offset: { type: Number, default: 80 },
    tolerance: { type: Number, default: 4 },
  };
  static events = ["change"] as const;

  declare containerSelectorValue: string;
  declare offsetValue: number;
  declare toleranceValue: number;

  #frame: number | null = null;
  /** The scroll source resolved at connect — disconnect must unbind the SAME node. */
  #scrollerEl: HTMLElement | Window = window;
  #lastY = 0;
  /** Last published state, so `change` fires only on transitions. */
  #hidden: boolean | null = null;

  readonly #onScroll = (): void => {
    if (this.#frame !== null) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.#measure();
    });
  };

  /**
   * Focus inside a hidden header must reveal it (WCAG 2.4.7 / 2.4.11); the
   * hold while focus *stays* inside is the `#apply` hide invariant.
   */
  readonly #onFocusin = (): void => this.#apply(false);

  override connect(): void {
    // The hook is scroll-derived: recompute from the live scroll position
    // instead of trusting a cached snapshot (which may say hidden at y=0).
    this.#hidden = null;
    this.#scrollerEl = this.#resolveScroller();
    this.#lastY = this.#scrollY;
    this.#scrollerEl.addEventListener("scroll", this.#onScroll, { passive: true });
    this.element.addEventListener("focusin", this.#onFocusin);
    this.#apply(false);
  }

  override disconnect(): void {
    this.#scrollerEl.removeEventListener("scroll", this.#onScroll);
    this.element.removeEventListener("focusin", this.#onFocusin);
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
  }

  /** Resolves the scroll source: the `containerSelector` match, else the window. */
  #resolveScroller(): HTMLElement | Window {
    if (this.containerSelectorValue) {
      const container = document.querySelector<HTMLElement>(this.containerSelectorValue);
      if (container) return container;
    }
    return window;
  }

  get #scrollY(): number {
    const scroller = this.#scrollerEl;
    // Identity check, not `instanceof Window` — cross-realm/test DOMs fail it.
    return scroller === window ? window.scrollY : (scroller as HTMLElement).scrollTop;
  }

  #measure(): void {
    const y = this.#scrollY;
    const delta = y - this.#lastY;
    if (Math.abs(delta) < this.toleranceValue) return;
    this.#lastY = y;

    if (y <= this.offsetValue) this.#apply(false);
    else if (delta > 0) this.#apply(true);
    else this.#apply(false);
  }

  /** Reflects the state onto the hook and emits `change` on transitions. */
  #apply(hidden: boolean): void {
    // Invariant: a header holding focus is never hidden — `focusin` revealed
    // it, and no transition may slide the focus owner away mid-interaction
    // (WCAG 2.4.7 / 2.4.11). Vetoed here at the single state-transition choke
    // point (not in each caller), so any future hide path — a timer, an
    // action — cannot bypass it. Reveals are never vetoed.
    if (hidden && this.element.contains(document.activeElement)) return;
    if (hidden === this.#hidden) return;
    this.#hidden = hidden;
    this.element.setAttribute("data-header-hidden", hidden ? "true" : "false");
    this.dispatch("change", { detail: { hidden } });
  }
}
