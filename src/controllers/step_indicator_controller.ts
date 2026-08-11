import { Controller } from "@hotwired/stimulus";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";

/**
 * Headless, accessible **read-only** step-progress indicator.
 *
 * Markup contract (identifier: `stimeo--step-indicator`):
 *   <ol data-controller="stimeo--step-indicator" aria-label="Checkout progress"
 *       data-stimeo--step-indicator-current-value="1"
 *       data-action="step:set->stimeo--step-indicator#setCurrent">
 *     <li data-stimeo--step-indicator-target="step">Cart</li>
 *     <li data-stimeo--step-indicator-target="step">Shipping</li>
 *     <li data-stimeo--step-indicator-target="step">Payment</li>
 *   </ol>
 *
 * There is no dedicated APG widget; the current position is expressed with
 * `aria-current="step"`. This indicator is **read only** — it never moves focus
 * and the steps are not operable. For an interactive wizard whose steps are
 * `<button>`s, use {@link StepperController | Stepper}.
 *
 * @remarks
 * Behavior only. Each step `<li>` gets a `data-state` (`complete`/`current`/
 * `upcoming`) derived from the current index; the consumer draws the circles,
 * lines, and numbers from those hooks. A `--stimeo-step-indicator-ratio`
 * (0–1) custom property on the root expresses overall progress for CSS.
 *
 * Behavior provided:
 * - Reflects `current` onto each step's `data-state` and `aria-current`.
 * - Re-derives every step when the step set changes at runtime.
 * - `setCurrent` (bound to an event whose `detail.current` is the 0-based index)
 *   updates the current step and dispatches `stimeo--step-indicator:change`.
 */
export class StepIndicatorController extends Controller<HTMLElement> {
  static override targets = ["step"];
  static override values = {
    current: { type: Number, default: 0 },
  };
  static actions = ["setCurrent"] as const;
  static events = ["change"] as const;

  declare readonly stepTargets: HTMLElement[];
  declare currentValue: number;

  /**
   * Whether the target callbacks may render. Stimulus reports the authored steps
   * as connected before `connect()` and the remaining ones as disconnected after
   * `disconnect()`, so this keeps a connect at one render pass, not one per step.
   */
  /**
   * Collapses a batch of step callbacks — and a morph that swaps `current` with
   * them — into one repaint. Replacing a list of N steps delivers N callbacks, and
   * each one would otherwise rewrite every step's state.
   */
  readonly #repaint = new MicrotaskCoalescer(() => this.#render());

  /** Renders the initial state from the `current` value. */
  override connect(): void {
    this.#repaint.activate();
    this.#render();
  }

  /** Closes the window in which a queued repaint may still run. */
  override disconnect(): void {
    this.#repaint.cancel();
  }

  /** Syncs a step appended or replaced at runtime (the consumer owns the list). */
  stepTargetConnected(): void {
    this.#repaint.schedule();
  }

  /** Re-derives the remaining steps when one is removed at runtime. */
  stepTargetDisconnected(): void {
    this.#repaint.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `current` at runtime. */
  currentValueChanged(): void {
    this.#repaint.schedule();
  }

  /**
   * Updates the current step from an external event (`detail.current`, 0-based)
   * and dispatches `change`. Out-of-range indices are clamped to the step set,
   * and both sides of the no-op test are clamped, so moving onto the step an
   * out-of-range `current` already renders is not reported as a change.
   */
  setCurrent(event: CustomEvent<{ current?: number }>): void {
    const next = event.detail?.current;
    if (typeof next !== "number" || !Number.isFinite(next)) return;
    const clamped = this.#clamp(next);
    const moved = clamped !== this.#clamp(this.currentValue);
    // Normalise even when the display does not move: an out-of-range `current` left
    // in the markup would otherwise be re-clamped against a later step set and land
    // somewhere the consumer never asked for. Writing it here is the consumer-driven
    // path, the only one that owns the Value.
    this.currentValue = clamped;
    if (!moved) return;
    this.#render();
    this.dispatch("change", {
      detail: { current: clamped, total: this.stepTargets.length },
    });
  }

  /**
   * Applies `data-state`, `aria-current`, and the progress ratio custom property.
   *
   * A pure function of the step set and `current`, so running it again writes the
   * same values — which is what lets the action path paint synchronously (the event
   * goes out after the DOM is updated) while a coalesced pass may still follow.
   */
  #render(): void {
    const total = this.stepTargets.length;
    const current = this.#clamp(this.currentValue);
    this.stepTargets.forEach((step, index) => {
      step.dataset.state =
        index < current ? "complete" : index === current ? "current" : "upcoming";
      if (index === current) {
        step.setAttribute("aria-current", "step");
      } else {
        step.removeAttribute("aria-current");
      }
    });
    const ratio = total > 1 ? current / (total - 1) : 0;
    this.element.style.setProperty("--stimeo-step-indicator-ratio", String(ratio));
  }

  /**
   * Constrains an index to `[0, total-1]` (or `0` when there are no steps). A
   * non-finite index falls back to the first step: `current` is read from markup,
   * so an unparsable attribute arrives as `NaN` and would otherwise propagate
   * into every state hook.
   */
  #clamp(index: number): number {
    const last = this.stepTargets.length - 1;
    if (last < 0 || !Number.isFinite(index)) return 0;
    return Math.min(last, Math.max(0, Math.trunc(index)));
  }
}
