import { Controller } from "@hotwired/stimulus";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";

/**
 * Headless, accessible **read-only** step-progress indicator.
 *
 * Markup contract (identifier: `stimeo--step-indicator`):
 *   <ol data-controller="stimeo--step-indicator" aria-label="Checkout progress"
 *       data-stimeo--step-indicator-index-value="1"
 *       data-action="stimeo--stepper:change->stimeo--step-indicator#setIndex">
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
 * `change` dispatches `{ index: number, previous: number, total: number }`.
 *
 * @remarks
 * Behavior only. Each step `<li>` gets a `data-state` (`complete`/`current`/
 * `upcoming`) derived from the current index; the consumer draws the circles,
 * lines, and numbers from those hooks. A `--stimeo--step-indicator-ratio`
 * (0–1) custom property on the root expresses overall progress for CSS.
 *
 * Behavior provided:
 * - Reflects `index` onto each step's `data-state` and `aria-current`.
 * - Re-derives every step when the step set changes at runtime.
 * - `setIndex` (bound to an event whose `detail.index` is the 0-based position)
 *   moves the indicator and dispatches `stimeo--step-indicator:change`. A
 *   {@link StepperController | Stepper} dispatches exactly that shape, so the two
 *   compose with one `data-action` and no glue.
 */
export class StepIndicatorController extends Controller<HTMLElement> {
  static override targets = ["step"];
  static override values = {
    index: { type: Number, default: 0 },
  };
  static actions = ["setIndex"] as const;
  static events = ["change"] as const;

  declare readonly stepTargets: HTMLElement[];
  declare indexValue: number;

  /**
   * Collapses a batch of step callbacks — and a morph that swaps `index` with
   * them — into one repaint. Replacing a list of N steps delivers N callbacks, and
   * each one would otherwise rewrite every step's state.
   */
  readonly #repaint = new MicrotaskCoalescer(() => this.#render());

  /** Renders the initial state from the `index` value. */
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

  /** Repaints when application code (or a Turbo morph) changes `index` at runtime. */
  indexValueChanged(): void {
    this.#repaint.schedule();
  }

  /**
   * Moves the indicator from an external event (`detail.index`, 0-based) and
   * dispatches `change`. Out-of-range positions are clamped to the step set,
   * and both sides of the no-op test are clamped, so moving onto the step an
   * out-of-range `index` already renders is not reported as a change.
   */
  setIndex(event: CustomEvent<{ index?: number }>): void {
    const next = event.detail?.index;
    if (typeof next !== "number" || !Number.isFinite(next)) return;
    const clamped = this.#clamp(next);
    const previous = this.#clamp(this.indexValue);
    const moved = clamped !== previous;
    // Normalise even when the display does not move: an out-of-range `index` left
    // in the markup would otherwise be re-clamped against a later step set and land
    // somewhere the consumer never asked for. Writing it here is the consumer-driven
    // path, the only one that owns the Value.
    this.indexValue = clamped;
    if (!moved) return;
    this.#render();
    this.dispatch("change", {
      detail: { index: clamped, previous, total: this.stepTargets.length },
    });
  }

  /**
   * Applies `data-state`, `aria-current`, and the progress ratio custom property.
   *
   * A pure function of the step set and `index`, so running it again writes the
   * same values — which is what lets the action path paint synchronously (the event
   * goes out after the DOM is updated) while a coalesced pass may still follow.
   *
   * @stimeoRenderRoot
   */
  #render(): void {
    const total = this.stepTargets.length;
    const current = this.#clamp(this.indexValue);
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
    this.element.style.setProperty("--stimeo--step-indicator-ratio", String(ratio));
  }

  /**
   * Constrains an index to `[0, total-1]` (or `0` when there are no steps). A
   * non-finite index falls back to the first step: `index` is read from markup,
   * so an unparsable attribute arrives as `NaN` and would otherwise propagate
   * into every state hook.
   */
  #clamp(index: number): number {
    const last = this.stepTargets.length - 1;
    if (last < 0 || !Number.isFinite(index)) return 0;
    return Math.min(last, Math.max(0, Math.trunc(index)));
  }
}
