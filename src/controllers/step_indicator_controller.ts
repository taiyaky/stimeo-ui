import { Controller } from "@hotwired/stimulus";

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

  /** Renders the initial state from the `current` value. */
  override connect(): void {
    this.#render();
  }

  /**
   * Updates the current step from an external event (`detail.current`, 0-based)
   * and dispatches `change`. Out-of-range indices are clamped to the step set.
   */
  setCurrent(event: CustomEvent<{ current?: number }>): void {
    const next = event.detail?.current;
    if (typeof next !== "number" || !Number.isFinite(next)) return;
    const clamped = this.#clamp(next);
    if (clamped === this.currentValue) return;
    this.currentValue = clamped;
    this.#render();
    this.dispatch("change", {
      detail: { current: clamped, total: this.stepTargets.length },
    });
  }

  /** Applies `data-state`, `aria-current`, and the progress ratio custom property. */
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

  /** Constrains an index to `[0, total-1]` (or `0` when there are no steps). */
  #clamp(index: number): number {
    const last = this.stepTargets.length - 1;
    if (last < 0) return 0;
    return Math.min(last, Math.max(0, Math.trunc(index)));
  }
}
