import { Controller } from "@hotwired/stimulus";
import { DetachGate } from "../utils/detach_gate";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { prefersReducedMotion } from "../utils/reduced_motion";
import { TransitionCompletion } from "../utils/transition_completion";

/** Splits a space-separated class-list value into individual, non-empty tokens. */
const tokensOf = (value: string): string[] => value.split(/\s+/).filter(Boolean);

/** Suffix of the record of the stage classes in place; see the class remarks. */
const STAGED_RECORD = "staged";

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
 * `TransitionCompletion`: every declared transition property must settle
 * (`transitionend` / `transitioncancel`, pseudo-element events excluded) with a
 * `max(duration + delay) + 50ms` bounded fallback, and a computed 0ms transition
 * settles synchronously at the staging frame. A positive `timeout` Value replaces the
 * fallback verbatim and keeps the wait armed even for a computed 0ms transition.
 * Under `prefers-reduced-motion: reduce` it switches instantly (no staging). An
 * interrupting call cancels the in-flight transition and starts the new one. Each
 * transition runs on the stage classes and `timeout` declared when it starts; a
 * change to them applies from the next transition and on its own stages nothing. State
 * lives solely in `hidden` / `data-transition-state`, and `connect()` reconciles it to
 * the element's visibility. Only the classes this controller applied are ever removed:
 * a stage token already on the element is the consumer's standing class, so it is
 * neither claimed nor stripped — declare a token as a stage Value *or* author it, not
 * both, because a token held by the consumer cannot be staged and the property it
 * drives then resolves from their CSS alone. The stage classes in place are recorded on
 * the element as `data-<identifier>-staged` (a JSON list), so a copy of the element taken
 * mid-transition — a page Turbo restores from its cache — tells the connection that
 * adopts it which classes were staged: it strips exactly those, silently, and settles
 * the state from `hidden`. A running transition is never cancelled on
 * `turbo:before-cache`, which Turbo also dispatches on pages that stay (a promoted frame
 * navigation, a state-less `popstate`, a refresh of a cached URL), so a `leave()` still
 * hides the element and `left` still fires. The terminal-event listeners, rAF, and
 * fallback timer are released, and the stage classes stripped, once the element is
 * really detached; an in-page move, and a `data-turbo-permanent` element Turbo carries
 * to the next page, reconnect the same instance with the transition still running.
 */
export class TransitionController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override values = {
    enter: { type: String, default: "" },
    enterFrom: { type: String, default: "" },
    enterTo: { type: String, default: "" },
    leave: { type: String, default: "" },
    leaveFrom: { type: String, default: "" },
    leaveTo: { type: String, default: "" },
    timeout: { type: Number, default: 0 },
  };

  static valueConstraints = {
    timeout: NUMBER_BOUNDS.timer,
  } satisfies NumberValueConstraints<typeof TransitionController.values>;
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
  /**
   * Stage classes this controller put on the element. Removing by declaration
   * instead would take a token the consumer also authored, and would strand the
   * token that was applied when a Value changes mid-transition.
   */
  readonly #staged = new Set<string>();

  /** Tells an in-page move or a permanent carry from a real detach. */
  readonly #gate = new DetachGate();

  override connect(): void {
    const moved = this.#gate.pending;
    this.#gate.cancel();
    // The reconnection that completes a move finds its transition still running.
    if (moved) return;
    // A connection that staged nothing itself strips only what the record names: the
    // classes an earlier instance staged on the element this copy was taken from. Any
    // other stage token present is the consumer's.
    if (this.#staged.size === 0) this.#stripRecorded();
    // Settle the state hook to match the element's current visibility.
    this.#settleState();
  }

  /** Cancels the transition in flight once the element is really detached. */
  override disconnect(): void {
    this.#gate.disconnected(this, () => this.#cancel());
  }

  /** The record of the stage classes in place, in this controller's namespace. */
  get #stagedRecord(): string {
    return `data-${this.identifier}-${STAGED_RECORD}`;
  }

  /** Strips the stage classes the record names, and drops the record. */
  #stripRecorded(): void {
    const raw = this.element.getAttribute(this.#stagedRecord) ?? "null";
    this.element.removeAttribute(this.#stagedRecord);
    let recorded: unknown = null;
    try {
      recorded = JSON.parse(raw);
    } catch {
      // A record that is not JSON names no class.
    }
    if (!Array.isArray(recorded)) return;
    for (const token of recorded) {
      if (typeof token === "string" && token !== "") this.element.classList.remove(token);
    }
  }

  /** Writes the record of the stage classes in place, or drops it when there are none. */
  #record(): void {
    if (this.#staged.size === 0) this.element.removeAttribute(this.#stagedRecord);
    else this.element.setAttribute(this.#stagedRecord, JSON.stringify([...this.#staged]));
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

  /**
   * Runs one transition on the declaration as it stands when the transition starts:
   * the class lists and `timeout` are read here, so a change while it runs — before
   * or after the staging frame — applies from the next transition.
   *
   * @stimeoRuntimeOnly The class lists and `timeout` shape this one transition; `#finish` strips
   *   the classes, so none of them stays at rest.
   */
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
    const timeoutMs = this.#safeTimeout;

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
      this.#transition.wait(this.element, () => this.#finish(kind), { timeoutMs });
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
    this.#record();
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
    this.#record();
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
  /** Current `timeout` declaration resolved against its numeric contract. */
  get #safeTimeout(): number {
    return this.#numbers.read(
      this,
      "timeout",
      this.timeoutValue,
      TransitionController.values.timeout.default,
      TransitionController.valueConstraints.timeout,
    );
  }
}
