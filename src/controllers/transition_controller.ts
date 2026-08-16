import { Controller } from "@hotwired/stimulus";
import { prefersReducedMotion } from "../utils/reduced_motion";
import { TransitionCompletion } from "../utils/transition_completion";

/** Splits a space-separated class-list value into individual, non-empty tokens. */
const tokensOf = (value: string): string[] => value.split(/\s+/).filter(Boolean);

/**
 * Headless **enter/leave transition base**: stages CSS classes for showing and hiding
 * an element (the shared substrate other widgets can lean on instead of hand-rolling
 * it). No APG pattern; honors WCAG 2.2 **2.3.3** via `prefers-reduced-motion` and keeps
 * the visual state in sync with `hidden`.
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
 * swaps `enterFrom` → `enterTo` so the CSS transition runs, and settles to `entered`
 * once the transition completes. `leave()` mirrors it and re-applies `hidden`.
 * `toggle()` reverses the current direction. The element carries `data-transition-state`
 * (`entering` / `entered` / `leaving` / `left`) and `entered` / `left` events fire on
 * completion.
 *
 * `entered` and `left` dispatch `{}`.
 *
 * @remarks
 * Behavior only — the animation itself is the consumer's CSS; this controls *when* the
 * stage classes are applied. Completion is owned by the shared
 * {@link TransitionCompletion}: every declared transition property must settle
 * (`transitionend` / `transitioncancel`, pseudo-element events excluded) with a
 * `max(duration + delay) + 50ms` bounded fallback, and a computed 0ms transition
 * settles synchronously at the staging frame. A positive `timeout` Value replaces the
 * fallback verbatim and keeps the wait armed even for a computed 0ms transition.
 * Under `prefers-reduced-motion: reduce` it switches instantly (no staging). An
 * interrupting call cancels the in-flight transition and starts the new one. State
 * lives solely in `hidden` / `data-transition-state`, and `connect()` reconciles to a
 * stable state (stripping any half-applied stage classes from a Turbo cache); the
 * terminal-event listeners, rAF, and fallback timer are released on `disconnect()`
 * (Turbo navigation included).
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

  /** Owns the cancellable completion wait (terminal events + bounded fallback). */
  readonly #transition = new TransitionCompletion();
  #rafId: number | null = null;

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

    if (prefersReducedMotion()) {
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
      // The consumer's `timeout` Value (positive) replaces the auto-computed
      // fallback so an author-declared budget always wins over computed styles.
      this.#transition.wait(this.element, () => this.#finish(kind), {
        timeoutMs: this.timeoutValue,
      });
    });
  }

  /** Settles the element into the completed state, clearing the stage classes. */
  #finish(kind: "enter" | "leave"): void {
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

  /** Cancels any in-flight transition (interruption / teardown). */
  #cancel(): void {
    if (this.#rafId !== null) {
      this.#cancelRaf(this.#rafId);
      this.#rafId = null;
    }
    this.#transition.cancel();
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
}
