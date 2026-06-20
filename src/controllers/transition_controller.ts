import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";

/** Splits a space-separated class-list value into individual, non-empty tokens. */
const tokensOf = (value: string): string[] => value.split(/\s+/).filter(Boolean);

/** First `<time>` of a computed `transition-duration` / `-delay` value, in ms. */
const firstTimeMs = (value: string): number => {
  const first = value.split(",")[0]?.trim() ?? "";
  const amount = Number.parseFloat(first);
  if (Number.isNaN(amount)) return 0;
  return first.endsWith("ms") ? amount : amount * 1000;
};

/**
 * Headless **enter/leave transition base**: stages CSS classes for showing and hiding
 * an element (the shared substrate other widgets can lean on instead of hand-rolling
 * it). Counterpart to Headless UI `Transition` / Alpine `x-transition` (no APG pattern;
 * honors WCAG 2.2 **2.3.3** via `prefers-reduced-motion` and keeps the visual state in
 * sync with `hidden`).
 *
 * Markup contract (identifier: `stimeo--transition`):
 *   <div data-controller="stimeo--transition"
 *        data-stimeo--transition-enter-value="ease-out duration-200"
 *        data-stimeo--transition-enter-from-value="opacity-0"
 *        data-stimeo--transition-enter-to-value="opacity-100"
 *        data-stimeo--transition-leave-value="ease-in duration-150"
 *        data-stimeo--transition-leave-from-value="opacity-100"
 *        data-stimeo--transition-leave-to-value="opacity-0" hidden>…</div>
 *
 * `enter()` unhides the element, applies `enter` + `enterFrom`, then on the next frame
 * swaps `enterFrom` → `enterTo` so the CSS transition runs, and on `transitionend` (or
 * a safety timeout) settles to `entered`. `leave()` mirrors it and re-applies `hidden`.
 * `toggle()` reverses the current direction. The element carries `data-transition-state`
 * (`entering` / `entered` / `leaving` / `left`) and `entered` / `left` events fire on
 * completion.
 *
 * @remarks
 * Behavior only — the animation itself is the consumer's CSS; this controls *when* the
 * stage classes are applied. Under `prefers-reduced-motion: reduce` it switches
 * instantly (no staging). An interrupting call cancels the in-flight transition and
 * starts the new one. State lives solely in `hidden` / `data-transition-state`, and
 * `connect()` reconciles to a stable state (stripping any half-applied stage classes
 * from a Turbo cache); the `transitionend` listener, rAF, and safety timer are released
 * on `disconnect()` (Turbo navigation included).
 */
export class TransitionController extends Controller<HTMLElement> {
  static override values = {
    enter: { type: String, default: "" },
    enterFrom: { type: String, default: "" },
    enterTo: { type: String, default: "" },
    leave: { type: String, default: "" },
    leaveFrom: { type: String, default: "" },
    leaveTo: { type: String, default: "" },
    timeout: { type: Number, default: 0 },
  };
  static actions = ["enter", "leave", "toggle"] as const;
  static events = ["entered", "left"] as const;

  declare enterValue: string;
  declare enterFromValue: string;
  declare enterToValue: string;
  declare leaveValue: string;
  declare leaveFromValue: string;
  declare leaveToValue: string;
  declare timeoutValue: number;

  readonly #timers = new SafeTimeout();
  #rafId: number | null = null;
  #endListener: ((event: Event) => void) | null = null;

  override connect(): void {
    // Drop any half-applied stage classes a cache may have captured, then settle the
    // state hook to match the element's current visibility.
    this.#strip();
    this.element.setAttribute("data-transition-state", this.element.hidden ? "left" : "entered");
  }

  override disconnect(): void {
    this.#cancel();
  }

  /** Shows the element with the enter transition. */
  enter(): void {
    this.#run("enter");
  }

  /** Hides the element with the leave transition. */
  leave(): void {
    this.#run("leave");
  }

  /** Reverses the current direction (enter when hidden/leaving, else leave). */
  toggle(): void {
    const state = this.element.getAttribute("data-transition-state");
    if (state === "entered" || state === "entering") this.leave();
    else this.enter();
  }

  #run(kind: "enter" | "leave"): void {
    this.#cancel();
    const isEnter = kind === "enter";
    if (isEnter) this.element.hidden = false;
    this.element.setAttribute("data-transition-state", isEnter ? "entering" : "leaving");

    if (this.#prefersReducedMotion()) {
      this.#finish(kind);
      return;
    }

    const base = isEnter ? this.enterValue : this.leaveValue;
    const from = isEnter ? this.enterFromValue : this.leaveFromValue;
    const to = isEnter ? this.enterToValue : this.leaveToValue;

    this.#add(base, from);
    this.#rafId = this.#raf(() => {
      this.#rafId = null;
      this.#remove(from);
      this.#add(to);
      this.#awaitEnd(() => this.#finish(kind));
    });
  }

  /** Settles the element into the completed state, clearing the stage classes. */
  #finish(kind: "enter" | "leave"): void {
    this.#cleanupEnd();
    this.#strip();
    if (kind === "enter") {
      this.element.setAttribute("data-transition-state", "entered");
      this.dispatch("entered", { detail: {} });
    } else {
      this.element.hidden = true;
      this.element.setAttribute("data-transition-state", "left");
      this.dispatch("left", { detail: {} });
    }
  }

  /** Resolves on the element's own `transitionend`, with a safety timeout fallback. */
  #awaitEnd(done: () => void): void {
    this.#endListener = (event: Event): void => {
      if (event.target === this.element) done();
    };
    this.element.addEventListener("transitionend", this.#endListener);
    const ms = this.timeoutValue > 0 ? this.timeoutValue : this.#duration();
    this.#timers.set(done, ms);
  }

  #cleanupEnd(): void {
    if (this.#endListener) {
      this.element.removeEventListener("transitionend", this.#endListener);
      this.#endListener = null;
    }
    this.#timers.clearAll();
  }

  /** Cancels any in-flight transition (interruption / teardown). */
  #cancel(): void {
    if (this.#rafId !== null) {
      this.#cancelRaf(this.#rafId);
      this.#rafId = null;
    }
    this.#cleanupEnd();
    this.#strip();
  }

  #add(...lists: string[]): void {
    const tokens = lists.flatMap(tokensOf);
    if (tokens.length > 0) this.element.classList.add(...tokens);
  }

  #remove(...lists: string[]): void {
    const tokens = lists.flatMap(tokensOf);
    if (tokens.length > 0) this.element.classList.remove(...tokens);
  }

  /** Removes every stage class so no half-applied state lingers. */
  #strip(): void {
    this.#remove(
      this.enterValue,
      this.enterFromValue,
      this.enterToValue,
      this.leaveValue,
      this.leaveFromValue,
      this.leaveToValue,
    );
  }

  /** Auto-computed safety duration (transition time + delay, with a small buffer). */
  #duration(): number {
    if (typeof window.getComputedStyle !== "function") return 0;
    const style = window.getComputedStyle(this.element);
    const total = firstTimeMs(style.transitionDuration) + firstTimeMs(style.transitionDelay);
    return total > 0 ? total + 50 : 0;
  }

  #raf(callback: () => void): number {
    if (typeof window.requestAnimationFrame === "function") {
      return window.requestAnimationFrame(() => callback());
    }
    return window.setTimeout(callback, 0);
  }

  #cancelRaf(id: number): void {
    if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(id);
    else window.clearTimeout(id);
  }

  #prefersReducedMotion(): boolean {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }
}
