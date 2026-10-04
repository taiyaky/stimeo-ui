import { Controller } from "@hotwired/stimulus";
import { validSelector } from "../utils/declared_value";
import { FrameCoalescer } from "../utils/frame_coalescer";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { resolveScrollSource, type ScrollSource, scrollOffset } from "../utils/scroll_source";

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
 * snapshot must not restore a hidden header at scroll top). The scroll source
 * follows a runtime change: a `containerSelector` that names another container,
 * or a morph that reaches the header after replacing the container its selector
 * names, moves the listener to the container resolved now, and the position
 * found there is a baseline rather than a scroll in either direction.
 * `containerSelector` and `offset` changed in one batch are applied in a single
 * pass after it.
 */
export class SmartStickyHeaderController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override values = {
    containerSelector: { type: String, default: "" },
    offset: { type: Number, default: DEFAULT_OFFSET },
    tolerance: { type: Number, default: 4 },
  };

  static valueConstraints = {
    offset: NUMBER_BOUNDS.finite,
    tolerance: NUMBER_BOUNDS.nonNegative,
  } satisfies NumberValueConstraints<typeof SmartStickyHeaderController.values>;
  static events = ["change"] as const;

  declare containerSelectorValue: string;
  declare offsetValue: number;
  declare toleranceValue: number;

  /** Coalesces scroll bursts into one measurement per frame. */
  readonly #frames = new FrameCoalescer();
  /**
   * The scroll source the listener is on — disconnect and a move to another
   * source must unbind the SAME node.
   */
  #scrollerEl: ScrollSource = window;
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
    return this.#safeOffset;
  }

  readonly #onScroll = (): void => this.#frames.schedule(() => this.#measure());

  /**
   * Focus inside a hidden header must reveal it (WCAG 2.4.7 / 2.4.11); the
   * hold while focus *stays* inside is the `#apply` hide invariant.
   */
  readonly #onFocusin = (): void => this.#apply(false);

  /**
   * Validates `containerSelector` once, so no resolve parses a selector that
   * throws, then asks for a pass that follows the container it names.
   */
  containerSelectorValueChanged(): void {
    this.#containerSelector = validSelector(this.element, this.containerSelectorValue, "");
    this.#morphRender.schedule();
  }

  /** Asks for a pass when application code (or a Turbo morph) changes `offset`. */
  offsetValueChanged(): void {
    this.#morphRender.schedule();
  }

  /**
   * One pass for a retained-element morph and for the Values a batch changes:
   * follow the scroll source the declaration names now, then decide again.
   */
  readonly #morphRender = new MorphRenderWatcher(() => {
    this.#followSource();
    this.#measure();
  });

  override connect(): void {
    this.#morphRender.observe(this.element);
    // The hook is scroll-derived: recompute from the live scroll position
    // instead of trusting a cached snapshot (which may say hidden at y=0).
    this.#hidden = null;
    this.#listenTo(resolveScrollSource(this.#containerSelector));
    this.element.addEventListener("focusin", this.#onFocusin);
    this.#apply(false, false);
  }

  override disconnect(): void {
    this.#morphRender.disconnect();
    this.#scrollerEl.removeEventListener("scroll", this.#onScroll);
    this.element.removeEventListener("focusin", this.#onFocusin);
    this.#frames.cancel();
  }

  /**
   * Moves the listener to the scroll source the declaration resolves to now,
   * when that is another node: released from the old one first, then added once
   * to the new one. A pass that resolves to the source already held keeps it,
   * and with it the position a pending scroll is measured from.
   */
  #followSource(): void {
    const source = resolveScrollSource(this.#containerSelector);
    if (source === this.#scrollerEl) return;
    this.#scrollerEl.removeEventListener("scroll", this.#onScroll);
    this.#listenTo(source);
  }

  /**
   * Listens to `source`, taking its current position as the baseline: a
   * position on a source not listened to before is where it is, not a scroll.
   */
  #listenTo(source: ScrollSource): void {
    this.#scrollerEl = source;
    this.#lastY = scrollOffset(source);
    source.addEventListener("scroll", this.#onScroll, { passive: true });
  }

  /** @stimeoRenderRoot */
  #measure(): void {
    const y = scrollOffset(this.#scrollerEl);
    // The offset zone decides before the jitter guard: a move small enough to
    // be jitter can still be the one that re-enters the zone, and a header
    // left hidden there cannot be scrolled back into view.
    if (y <= this.#offset) {
      this.#lastY = y;
      this.#apply(false);
      return;
    }

    const delta = y - this.#lastY;
    if (this.#isJitter(delta)) {
      this.#apply(this.#hidden ?? false);
      return;
    }
    this.#lastY = y;
    this.#apply(delta > 0);
  }

  /**
   * Whether one scroll step is too small to act on.
   *
   * @stimeoRuntimeOnly `tolerance` is the allowance one scroll step is compared against; the
   *   header's state at rest does not depend on it.
   */
  #isJitter(delta: number): boolean {
    return Math.abs(delta) < this.#safeTolerance;
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
    const changed = hidden !== this.#hidden;
    this.#hidden = hidden;
    this.element.setAttribute("data-header-hidden", hidden ? "true" : "false");
    if (notify && changed) this.dispatch("change", { detail: { hidden } });
  }
  /** Current `offset` declaration resolved against its numeric contract. */
  get #safeOffset(): number {
    return this.#numbers.read(
      this,
      "offset",
      this.offsetValue,
      SmartStickyHeaderController.values.offset.default,
      SmartStickyHeaderController.valueConstraints.offset,
    );
  }

  /** Current `tolerance` declaration resolved against its numeric contract. */
  get #safeTolerance(): number {
    return this.#numbers.read(
      this,
      "tolerance",
      this.toleranceValue,
      SmartStickyHeaderController.values.tolerance.default,
      SmartStickyHeaderController.valueConstraints.tolerance,
    );
  }
}
