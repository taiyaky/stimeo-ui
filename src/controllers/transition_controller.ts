import { Controller } from "@hotwired/stimulus";
import { BeforeCacheReset } from "../utils/before_cache_reset";
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
 * `enter()` unhides the element, applies `enter` + `enterFrom`, commits that frame,
 * then on the next frame swaps `enterFrom` → `enterTo` so the CSS transition runs, and
 * settles to `entered` once the transition completes. `leave()` mirrors it and re-applies `hidden`.
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
 * lives solely in `hidden` / `data-transition-state`, and `connect()` reconciles it to
 * the element's visibility. Only the classes this controller applied are ever removed:
 * a stage token already on the element is the consumer's standing class, so it is
 * neither claimed nor stripped — declare a token as a stage Value *or* author it, not
 * both, because a token held by the consumer cannot be staged and the property it
 * drives then resolves from their CSS alone. A half-applied stage is rewound on
 * `turbo:before-cache` so it never reaches a snapshot. The terminal-event listeners,
 * rAF, and fallback timer are released on `disconnect()` (Turbo navigation included).
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
  /** Rewinds a half-applied stage before Turbo copies the page into its snapshot. */
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindForCache());
  #rafId: number | null = null;
  /**
   * Stage classes this controller put on the element. Removing by declaration
   * instead would take a token the consumer also authored, and would strand the
   * token that was applied when a Value changes mid-transition.
   */
  readonly #staged = new Set<string>();

  override connect(): void {
    this.#beforeCache.activate();
    // Settle the state hook to match the element's current visibility. Nothing is
    // stripped here: a stage token present at connect was not staged by this
    // instance, so it belongs to the consumer.
    this.#settleState();
  }

  override disconnect(): void {
    this.#beforeCache.deactivate();
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
    // Commit the "from" frame before the swap: a rAF callback runs before this
    // frame's style is computed, and an element arriving from `display: none` has no
    // before-change style, so the transition would never start and completion would
    // always fall back to the timer.
    void this.element.offsetWidth;
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

  /** Writes the state hook the element's visibility implies. */
  #settleState(): void {
    this.element.setAttribute("data-transition-state", this.element.hidden ? "left" : "entered");
  }

  /**
   * Returns the element to a settled state before Turbo copies the page.
   *
   * The snapshot is taken while the controller is still connected, so stripping on
   * the next `connect()` would only repair the page after it has been painted from
   * the cache. The pass is silent: `connect()` derives the state again on restore.
   */
  #rewindForCache(): void {
    this.#cancel();
    this.#settleState();
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

  /**
   * Applies the stage tokens this controller does not already find on the
   * element, and claims exactly those.
   *
   * A token already on the element is left unclaimed: it is either the consumer's
   * standing class or one an earlier stage of this transition already claimed, and
   * in neither case may this call take ownership of it. That is what keeps a
   * standing class the consumer also named as a stage Value; the cost is that such
   * a token cannot be staged, so the property it drives resolves from their CSS.
   */
  #add(...lists: string[]): void {
    for (const token of lists.flatMap(tokensOf)) {
      if (this.element.classList.contains(token)) continue;
      this.element.classList.add(token);
      this.#staged.add(token);
    }
  }

  /** Drops the named tokens that are this controller's to drop. */
  #remove(...lists: string[]): void {
    for (const token of lists.flatMap(tokensOf)) {
      if (!this.#staged.delete(token)) continue;
      this.element.classList.remove(token);
    }
  }

  /** Removes every stage class this controller applied, so none lingers. */
  #strip(): void {
    this.element.classList.remove(...this.#staged);
    this.#staged.clear();
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
