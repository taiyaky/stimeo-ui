import { Controller } from "@hotwired/stimulus";

/** The depth that never hides, used when `offset` is not a finite number. */
const DEFAULT_OFFSET = 80;

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
 * point `containerSelector` at it (the header usually sits inside it too). A
 * declaration that cannot be parsed as a selector reads as the window, so a
 * typo costs the container binding rather than the whole header.
 *   <!-- [data-header-hidden="true"] { transform: translateY(-100%); } -->
 *
 * Scrolling down past `offset` px sets `data-header-hidden="true"`, and a
 * scroll-up beyond the `tolerance` jitter guard reveals it again. Within the
 * `offset` zone the header is always revealed, decided ahead of that jitter
 * guard: a header stranded off-screen near the top cannot be scrolled back
 * into view. Focus reaching the header always reveals it, and while focus
 * stays inside the header a scroll-down never hides it — a keyboard user must
 * be able to see where focus went AND keep seeing the element that owns it
 * (WCAG 2.4.7 / 2.4.11).
 *
 * `change` dispatches `{ hidden }` on transitions only: the reflection
 * `connect()` performs is the current state rather than a change.
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
    offset: { type: Number, default: DEFAULT_OFFSET },
    tolerance: { type: Number, default: 4 },
  };
  static events = ["change"] as const;

  declare containerSelectorValue: string;
  declare offsetValue: number;
  declare toleranceValue: number;

  #connected = false;
  #frame: number | null = null;
  /** The scroll source resolved at connect — disconnect must unbind the SAME node. */
  #scrollerEl: HTMLElement | Window = window;
  /** The validated `containerSelector`, or `""` when the declaration cannot be parsed. */
  #containerSelector = "";
  #lastY = 0;
  /** Last published state, so `change` fires only on transitions. */
  #hidden: boolean | null = null;

  /**
   * The depth that never hides. A declaration that is not a finite number reads
   * as the default, so the comparison path never sees `NaN` — which would
   * answer `false` to every comparison and hide the header inside the very
   * zone the value exists to protect.
   */
  get #offset(): number {
    return Number.isFinite(this.offsetValue) ? this.offsetValue : DEFAULT_OFFSET;
  }

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

  /** Validates `containerSelector` once so connect never parses a selector that throws. */
  containerSelectorValueChanged(): void {
    this.#containerSelector = this.#validSelector(this.containerSelectorValue);
  }

  /** Re-decides when application code (or a Turbo morph) changes `offset` at runtime. */
  offsetValueChanged(): void {
    if (this.#connected) this.#measure();
  }

  override connect(): void {
    // The hook is scroll-derived: recompute from the live scroll position
    // instead of trusting a cached snapshot (which may say hidden at y=0).
    this.#hidden = null;
    this.#scrollerEl = this.#resolveScroller();
    this.#lastY = this.#scrollY;
    this.#scrollerEl.addEventListener("scroll", this.#onScroll, { passive: true });
    this.element.addEventListener("focusin", this.#onFocusin);
    this.#apply(false, false);
    this.#connected = true;
  }

  override disconnect(): void {
    this.#connected = false;
    this.#scrollerEl.removeEventListener("scroll", this.#onScroll);
    this.element.removeEventListener("focusin", this.#onFocusin);
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
  }

  /** Resolves the scroll source: the `containerSelector` match, else the window. */
  #resolveScroller(): HTMLElement | Window {
    if (this.#containerSelector) {
      const container = document.querySelector<HTMLElement>(this.#containerSelector);
      if (container) return container;
    }
    return window;
  }

  /** Returns `declared` when it parses as a selector, and `""` when it does not. */
  #validSelector(declared: string): string {
    if (declared.length > 0) {
      try {
        this.element.matches(declared);
        return declared;
      } catch {
        // Unparsable selector: fall through to the default below.
      }
    }
    return "";
  }

  get #scrollY(): number {
    const scroller = this.#scrollerEl;
    // Identity check, not `instanceof Window` — cross-realm/test DOMs fail it.
    return scroller === window ? window.scrollY : (scroller as HTMLElement).scrollTop;
  }

  #measure(): void {
    const y = this.#scrollY;
    // The offset zone decides before the jitter guard: a move small enough to
    // be jitter can still be the one that re-enters the zone, and a header
    // left hidden there cannot be scrolled back into view.
    if (y <= this.#offset) {
      this.#lastY = y;
      this.#apply(false);
      return;
    }

    const delta = y - this.#lastY;
    if (Math.abs(delta) < this.toleranceValue) return;
    this.#lastY = y;
    this.#apply(delta > 0);
  }

  /**
   * Reflects the state onto the hook and emits `change` on transitions.
   *
   * @param notify - whether a transition announces itself. The reflection
   *   `connect()` performs is the current state, not a change.
   */
  #apply(hidden: boolean, notify = true): void {
    // Invariant: a header holding focus is never hidden — `focusin` revealed
    // it, and no transition may slide the focus owner away mid-interaction
    // (WCAG 2.4.7 / 2.4.11). Vetoed here at the single state-transition choke
    // point (not in each caller), so any future hide path — a timer, an
    // action — cannot bypass it. Reveals are never vetoed.
    if (hidden && this.element.contains(document.activeElement)) return;
    if (hidden === this.#hidden) return;
    this.#hidden = hidden;
    this.element.setAttribute("data-header-hidden", hidden ? "true" : "false");
    if (notify) this.dispatch("change", { detail: { hidden } });
  }
}
