import { Controller } from "@hotwired/stimulus";

/**
 * Headless **count-up**: animates a number from `from` up to the value already
 * in the DOM — typically started the moment the element scrolls into view by
 * composing with the `stimeo--intersection` primitive (the classic "animate
 * when visible"). Distinct from `stimeo--countdown` (time-based). Core
 * (zero dependencies).
 *
 * Markup contract (identifier: `stimeo--count-up`):
 *   <span data-controller="stimeo--intersection stimeo--count-up"
 *         data-stimeo--intersection-once-value="true"
 *         data-action="stimeo--intersection:enter->stimeo--count-up#start">1200</span>
 *
 * The **final number stays authored in the markup** (SEO / no-JS / SR read the
 * real value); `start` animates the displayed text from `from` to it over
 * `duration` ms with an ease-out curve, then restores the exact authored text.
 * With `once` (default) later starts are ignored (`data-count-up-done` records
 * a finished run across Turbo cache restores).
 *
 * @remarks
 * Behavior only — no formatting is imposed: the authored text is parsed for
 * its integer value (separators are ignored) and restored verbatim at the end;
 * intermediate frames render plain integers. Accessibility: when the user
 * prefers reduced motion the animation is skipped entirely (the value just
 * stays final — WCAG 2.3.3). The element is not a live region, so the ticking
 * intermediate numbers are never actively announced; during the run the
 * authored value is additionally kept in `aria-label` (best-effort — generic
 * roles may ignore it) and that lingering label doubles as the
 * interrupted-run marker `connect()` restores from after a Turbo cache
 * snapshot taken mid-animation. The animation frame is canceled on
 * `disconnect()` (Turbo navigation included) and the authored text restored.
 */
export class CountUpController extends Controller<HTMLElement> {
  static override values = {
    duration: { type: Number, default: 1200 },
    from: { type: Number, default: 0 },
    once: { type: Boolean, default: true },
  };
  static actions = ["start"] as const;
  static events = ["end"] as const;

  declare durationValue: number;
  declare fromValue: number;
  declare onceValue: boolean;

  #frame: number | null = null;
  /** The authored final text, restored verbatim when the run settles. */
  #finalText = "";

  override connect(): void {
    // Turbo snapshots the page BEFORE the body swap, so a cached page can hold
    // a mid-animation frame (disconnect()'s settle runs too late for it). The
    // OWN-label marker (never a bare aria-label — that may be authored) flags
    // the interrupted run: the label it owns still holds the authored text.
    if (this.element.hasAttribute("data-count-up-label")) {
      this.element.textContent =
        this.element.getAttribute("aria-label") ?? this.element.textContent;
      this.#restoreLabel();
      this.element.setAttribute("data-count-up-done", "true");
    }
  }

  override disconnect(): void {
    // A run cannot survive the element: settle instantly so the cached
    // snapshot holds the real value, never a mid-animation frame.
    if (this.#frame !== null) this.#settle();
  }

  /**
   * Starts the animation (typically from `stimeo--intersection:enter` via
   * `data-action`). No-ops while running, and after a finished run when `once`.
   */
  start(): void {
    if (this.#frame !== null) return;
    if (this.onceValue && this.element.hasAttribute("data-count-up-done")) return;

    this.#finalText = this.element.textContent ?? "";
    const target = Number.parseInt(this.#finalText.replace(/[^0-9-]/g, ""), 10);
    if (Number.isNaN(target)) return;

    // Reduced motion: no ticking, just the final value (WCAG 2.3.3).
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      this.element.setAttribute("data-count-up-done", "true");
      this.dispatch("end", { detail: { value: target } });
      return;
    }

    // AT keeps the real value while the visible text ticks. An authored
    // aria-label is parked (save-restore, never clobbered) and the override is
    // marker-owned so connect()/settle() only ever touch what this set.
    const authored = this.element.getAttribute("aria-label");
    if (authored !== null) {
      this.element.setAttribute("data-count-up-original-label", authored);
    }
    this.element.setAttribute("data-count-up-label", "true");
    this.element.setAttribute("aria-label", this.#finalText);
    const started = performance.now();
    const step = (now: number): void => {
      const t = Math.min((now - started) / this.durationValue, 1);
      const eased = 1 - (1 - t) ** 3; // ease-out cubic
      this.element.textContent = String(
        Math.round(this.fromValue + (target - this.fromValue) * eased),
      );
      if (t < 1) {
        this.#frame = requestAnimationFrame(step);
      } else {
        this.#settle();
        this.dispatch("end", { detail: { value: target } });
      }
    };
    this.#frame = requestAnimationFrame(step);
  }

  /** Ends the run: cancels the frame and restores the authored presentation. */
  #settle(): void {
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
    this.element.textContent = this.#finalText;
    this.#restoreLabel();
    this.element.setAttribute("data-count-up-done", "true");
  }

  /** Releases the marker-owned aria-label, restoring any parked authored value. */
  #restoreLabel(): void {
    if (!this.element.hasAttribute("data-count-up-label")) return;
    const original = this.element.getAttribute("data-count-up-original-label");
    if (original !== null) {
      this.element.setAttribute("aria-label", original);
      this.element.removeAttribute("data-count-up-original-label");
    } else {
      this.element.removeAttribute("aria-label");
    }
    this.element.removeAttribute("data-count-up-label");
  }
}
