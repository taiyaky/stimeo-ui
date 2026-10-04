import { Controller } from "@hotwired/stimulus";
import { authoredInteger } from "../utils/authored_integer";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { prefersReducedMotion } from "../utils/reduced_motion";

/** The animation length used when `duration` falls outside its domain. */
const DEFAULT_DURATION = 1200;

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
 * a finished run across Turbo cache restores). `from` and `duration` are read as
 * a run starts: a running animation keeps the values it began with, the next run
 * reads the new ones, and a change on its own starts nothing.
 *
 * Only the text node holding the number is animated, so sibling markup — a unit
 * in a `<small>`, a label in a `<b>` — is left where the author put it.
 *
 * `end` dispatches `{ value }`.
 *
 * @remarks
 * Behavior only — no formatting is imposed: the authored text is read for the
 * integer it displays and restored verbatim at the end; intermediate frames
 * render plain integers. Accessibility: when the user prefers reduced motion the
 * animation is skipped entirely (the value just stays final — WCAG 2.3.3).
 * During a run the ticking number is wrapped in a `role="img"` element named
 * with the authored text, which is where a name is allowed to live — the host
 * keeps whatever semantics it had, so a `<dd>` stays a definition. That wrapper
 * doubles as the interrupted-run record `connect()` restores from after a Turbo
 * cache snapshot taken mid-animation. The animation frame is canceled on
 * `disconnect()` (Turbo navigation included) and the authored text restored.
 */
export class CountUpController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override values = {
    duration: { type: Number, default: DEFAULT_DURATION },
    from: { type: Number, default: 0 },
    once: { type: Boolean, default: true },
  };

  static valueConstraints = {
    duration: NUMBER_BOUNDS.positive,
    from: NUMBER_BOUNDS.finite,
  } satisfies NumberValueConstraints<typeof CountUpController.values>;
  static actions = ["start"] as const;
  static events = ["end"] as const;

  declare durationValue: number;
  declare fromValue: number;
  declare onceValue: boolean;

  #frame: number | null = null;

  /** The animation length, with a declaration outside its domain read as the default. */
  get #duration(): number {
    return this.#safeDuration;
  }

  /** The starting value, with a declaration that is not a finite number read as zero. */
  get #from(): number {
    return this.#safeFrom;
  }

  override connect(): void {
    // Turbo snapshots the page BEFORE the body swap, so a cached page can hold
    // a mid-animation frame (disconnect()'s settle runs too late for it). The
    // wrapper this controller owns flags the interrupted run and carries the
    // authored text in the name it published.
    const ticker = this.#ownedTicker();
    if (ticker === null) return;
    const authored = ticker.getAttribute("aria-label");
    this.#unwrap(ticker, authored);
    if (authored !== null) this.element.setAttribute("data-count-up-done", "true");
  }

  override disconnect(): void {
    // Cancel the live run and restore the element's authored text.
    if (this.#frame !== null) this.#settle();
  }

  /**
   * Starts the animation (typically from `stimeo--intersection:enter` via
   * `data-action`). No-ops while running, and after a finished run when `once`.
   * The run keeps the `from` and `duration` read here to its last frame.
   */
  start(): void {
    if (this.#frame !== null) return;
    if (this.onceValue && this.element.hasAttribute("data-count-up-done")) return;

    const node = this.#numericNode();
    if (node === null) return;
    const authored = node.data;
    const target = authoredInteger(authored) as number;

    // Reduced motion: no ticking, just the final value (WCAG 2.3.3).
    if (prefersReducedMotion()) {
      this.element.setAttribute("data-count-up-done", "true");
      this.dispatch("end", { detail: { value: target } });
      return;
    }

    // A name may not live on every host — a `<span>` prohibits one, and a role
    // that permits naming would cost a `<dd>` its own semantics — so the ticking
    // number gets a wrapper that permits naming, and the name carries the
    // authored text AT should hear instead of the ticks.
    const ticker = this.#wrap(node, authored);
    const from = this.#from;
    const duration = this.#duration;
    const started = performance.now();
    const step = (now: number): void => {
      const t = Math.min((now - started) / duration, 1);
      const eased = 1 - (1 - t) ** 3; // ease-out cubic
      ticker.textContent = String(Math.round(from + (target - from) * eased));
      if (t < 1) {
        this.#frame = requestAnimationFrame(step);
      } else {
        this.#settle();
        this.dispatch("end", { detail: { value: target } });
      }
    };
    this.#frame = requestAnimationFrame(step);
  }

  /** The first text node that displays a number, or null when the host has none. */
  #numericNode(): Text | null {
    const walker = document.createTreeWalker(this.element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node !== null && authoredInteger(node.data) === null) {
      node = walker.nextNode() as Text | null;
    }
    return node;
  }

  /** The wrapper this controller published, if one outlived its run. */
  #ownedTicker(): HTMLElement | null {
    return this.element.querySelector<HTMLElement>("[data-count-up-label]");
  }

  /** Publishes the ticking number inside a named wrapper, replacing `node`. */
  #wrap(node: Text, authored: string): HTMLElement {
    const ticker = document.createElement("span");
    ticker.setAttribute("data-count-up-label", "true");
    ticker.setAttribute("role", "img");
    ticker.setAttribute("aria-label", authored);
    node.replaceWith(ticker);
    ticker.append(node);
    return ticker;
  }

  /** Puts `text` back where the wrapper stood, leaving the rest of the host alone. */
  #unwrap(ticker: HTMLElement, text: string | null): void {
    ticker.replaceWith(document.createTextNode(text ?? ticker.textContent ?? ""));
  }

  /** Ends the run: cancels the frame and restores the authored presentation. */
  #settle(): void {
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
    const ticker = this.#ownedTicker();
    if (ticker !== null) this.#unwrap(ticker, ticker.getAttribute("aria-label"));
    this.element.setAttribute("data-count-up-done", "true");
  }
  /** Current `duration` declaration resolved against its numeric contract. */
  get #safeDuration(): number {
    return this.#numbers.read(
      this,
      "duration",
      this.durationValue,
      CountUpController.values.duration.default,
      CountUpController.valueConstraints.duration,
    );
  }

  /** Current `from` declaration resolved against its numeric contract. */
  get #safeFrom(): number {
    return this.#numbers.read(
      this,
      "from",
      this.fromValue,
      CountUpController.values.from.default,
      CountUpController.valueConstraints.from,
    );
  }
}
