import { Controller } from "@hotwired/stimulus";

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
 * clamped. The property is written on the controller element **and** on
 * `document.documentElement`, so a fixed bar anywhere in the page can consume
 * it without being a descendant. The `:root` copy makes this a
 * one-instance-per-page contract (two articles would fight last-writer-wins);
 * `complete` fires on *reaching* 1 — a connect-time measurement that is
 * already 1 (e.g. a Turbo restore at the bottom) only establishes the
 * baseline and does not fire it.
 *
 * @remarks
 * Behavior only — the bar itself (and hiding it, e.g. before any scroll) is
 * the consumer's CSS; the progress value carries no ARIA (a decorative
 * indicator — mark the bar `aria-hidden`; a *semantic* progress belongs to
 * `stimeo--progress`). Scroll/resize work is rAF-throttled; the listeners and
 * any pending frame are released and the root custom property removed on
 * `disconnect()` (Turbo navigation included).
 */
export class ReadingProgressController extends Controller<HTMLElement> {
  static events = ["change", "complete"] as const;

  #frame: number | null = null;
  /** Last published progress, so `change`/`complete` fire only on movement. */
  #progress = -1;

  readonly #onScroll = (): void => {
    if (this.#frame !== null) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.#measure();
    });
  };

  override connect(): void {
    this.#progress = -1;
    // Capture phase: element scrolls do not bubble, but they ARE observable at
    // the window in capture — so an article inside an overflow container still
    // drives the progress.
    window.addEventListener("scroll", this.#onScroll, { passive: true, capture: true });
    window.addEventListener("resize", this.#onScroll, { passive: true });
    this.#measure();
  }

  override disconnect(): void {
    window.removeEventListener("scroll", this.#onScroll, { capture: true });
    window.removeEventListener("resize", this.#onScroll);
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
    document.documentElement.style.removeProperty(PROGRESS_PROPERTY);
  }

  /** Computes and publishes the progress; emits on movement only. */
  #measure(): void {
    const rect = this.element.getBoundingClientRect();
    const span = rect.height - window.innerHeight;
    // Shorter than the viewport: reading it is binary (reached or not).
    const raw = span > 0 ? -rect.top / span : rect.top <= 0 ? 1 : 0;
    const progress = Math.min(1, Math.max(0, raw));
    if (progress === this.#progress) return;

    const previous = this.#progress;
    this.#progress = progress;
    const value = String(progress);
    this.element.style.setProperty(PROGRESS_PROPERTY, value);
    document.documentElement.style.setProperty(PROGRESS_PROPERTY, value);
    this.dispatch("change", { detail: { progress } });
    if (progress === 1 && previous !== -1) this.dispatch("complete");
  }
}
