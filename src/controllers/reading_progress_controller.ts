import { Controller } from "@hotwired/stimulus";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { LayoutObserver } from "../utils/layout_observer";
import { StylePropertyLease } from "../utils/style_property_lease";

/** Name of the CSS custom property exposing the reading progress (0..1). */
const PROGRESS_PROPERTY = "--stimeo--reading-progress";

/**
 * Headless **reading progress**: how far the reader has scrolled *through* this
 * element (an article), published as a CSS custom property and a `change`
 * event stream — the classic top-of-page progress bar.
 * `IntersectionObserver` alone cannot express this (the ratio is constant
 * while a tall article scrolls through the viewport), so this controller owns
 * the scroll math; compose with `stimeo--intersection` when you also need
 * enter/exit triggers. Core (zero dependencies).
 *
 * Markup contract (identifier: `stimeo--reading-progress`):
 *   <article data-controller="stimeo--reading-progress">…</article>
 *   <div class="progress-bar" aria-hidden="true"></div>
 *   <!-- .progress-bar { width: calc(var(--stimeo--reading-progress, 0) * 100%); } -->
 *
 * Progress is `0` before the article's top reaches the viewport top and `1`
 * once its bottom fits the viewport: `-top / (height - viewportHeight)`,
 * clamped. An article no taller than the viewport has no such span, so reading
 * it is binary: `1` from the moment its top reaches the viewport top. An
 * article with no layout box at all — a `display: none` ancestor, a collapsed
 * `<details>`, an inactive tab panel — is not measured: an empty rect sits at
 * the document origin and carries no reading position, so publishing anything
 * for it would report a place the reader never reached.
 *
 * The property is written on the controller element **and** on
 * `document.documentElement`, so a fixed bar anywhere in the page can consume
 * it without being a descendant. Both are written through a lease, so an
 * authored declaration comes back on teardown and a later writer is left alone.
 * `complete` fires on *reaching* 1, and never during the baseline: the frame in
 * which the controller connects belongs to establishing where the reader
 * already is (a restored scroll position lands there), not to reading.
 *
 * `change` dispatches `{ progress }`.
 *
 * @remarks
 * Behavior only — the bar itself (and hiding it, e.g. before any scroll) is
 * the consumer's CSS; the progress value carries no ARIA (a decorative
 * indicator — mark the bar `aria-hidden`; a *semantic* progress belongs to
 * `stimeo--progress`). The article's own box is watched as well as the
 * viewport, so content that settles late (images, fonts) re-measures instead of
 * leaving a stale span. Scroll and layout work is rAF-throttled; the listeners,
 * the observers, any pending frame and both leased declarations are released on
 * `disconnect()` and returned again for a `turbo:before-cache` snapshot.
 */
export class ReadingProgressController extends Controller<HTMLElement> {
  static events = ["change", "complete"] as const;

  /** Owns both faces of the published property so teardown can hand them back. */
  readonly #lease = new StylePropertyLease(PROGRESS_PROPERTY);
  /** The article's own box and the viewport: either changes the span. */
  readonly #layout = new LayoutObserver(() => this.#onScroll());
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindForCache());
  #frame: number | null = null;
  /** Last published progress, so `change`/`complete` fire only on movement. */
  #progress = -1;
  /** False until the connect frame has run: `complete` needs real reading. */
  #baselined = false;

  readonly #onScroll = (): void => {
    if (this.#frame !== null) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.#measure();
    });
  };

  override connect(): void {
    this.#progress = -1;
    this.#baselined = false;
    // Capture phase: element scrolls do not bubble, but they ARE observable at
    // the window in capture — so an article inside an overflow container still
    // drives the progress.
    window.addEventListener("scroll", this.#onScroll, { passive: true, capture: true });
    this.#layout.observe(this.element);
    this.#layout.observeViewport();
    this.#beforeCache.activate();
    this.#measure();
    // The page's scroll position is restored *after* the controller connects,
    // so that jump arrives as a move the reader never made. Everything up to
    // the end of this frame is still the baseline — a restored scroll coalesces
    // into the frame below, and no reader can cross an article inside one.
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.#measure();
      this.#baselined = true;
    });
  }

  override disconnect(): void {
    window.removeEventListener("scroll", this.#onScroll, { capture: true });
    this.#layout.disconnect();
    this.#beforeCache.deactivate();
    this.#cancelFrame();
    this.#lease.returnAll();
  }

  /**
   * Hands both declarations back before the page is snapshotted, so a restored
   * page starts from the authored DOM rather than from someone else's progress.
   * The baseline goes back with them: a cancelled visit leaves this page on
   * screen, and the next measurement has to publish afresh rather than match a
   * value that has already been handed back.
   */
  #rewindForCache(): void {
    this.#cancelFrame();
    this.#lease.returnAll();
    this.#progress = -1;
  }

  #cancelFrame(): void {
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
  }

  /** Computes and publishes the progress; emits on movement only. */
  #measure(): void {
    const rect = this.element.getBoundingClientRect();
    // No layout box (a `display: none` ancestor, a collapsed `<details>`): the
    // empty rect sits at the document origin, where the binary branch below
    // would read its `top` of 0 as "the reader reached it". There is no reading
    // position to publish, so the last one stands until the article is laid out
    // again — which the box observer reports.
    if (rect.width === 0 && rect.height === 0) return;

    const span = rect.height - window.innerHeight;
    // Shorter than the viewport: reading it is binary (reached or not).
    const raw = span > 0 ? -rect.top / span : rect.top <= 0 ? 1 : 0;
    const progress = Math.min(1, Math.max(0, raw));
    if (progress === this.#progress) return;

    const previous = this.#progress;
    this.#progress = progress;
    const value = String(progress);
    this.#lease.write(this.element, value);
    this.#lease.write(document.documentElement, value);
    this.dispatch("change", { detail: { progress } });
    if (progress === 1 && previous !== -1 && this.#baselined) this.dispatch("complete");
  }
}
