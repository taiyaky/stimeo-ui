import { Controller } from "@hotwired/stimulus";

/**
 * Headless, accessible stepper / wizard navigation behavior.
 *
 * Markup contract (identifier: `stimeo--stepper`):
 *   <ol data-controller="stimeo--stepper" data-stimeo--stepper-index-value="0">
 *     <li data-stimeo--stepper-target="step">
 *       <button aria-current="step" data-stimeo--stepper-index-param="0"
 *               data-action="click->stimeo--stepper#goto">Account</button>
 *     </li>
 *     <!-- more steps -->
 *   </ol>
 *
 * There is no dedicated APG widget; the current step is expressed with
 * `aria-current="step"` on the operable `<button>`. Each step `<li>` also gets a
 * `data-state` (`complete`/`current`/`upcoming`) derived from the current index.
 * For a read-only progress display use
 * {@link StepIndicatorController | Step Indicator}; for panel switching use Tabs.
 *
 * @remarks
 * Behavior only. The controller never traps or restores focus — each step button
 * is in the natural Tab order. `data-state` is purely derived from `index`
 * (completion is not persisted).
 *
 * Behavior provided:
 * - `next`/`prev` move one step, ignoring moves past either end.
 * - `goto` jumps to the step in its `index` action param.
 * - With `linear=true`, `goto` may not skip more than one step ahead of the
 *   current one (moving backward is always allowed).
 * - Each move re-derives `data-state`/`aria-current` and dispatches
 *   `stimeo--stepper:change`.
 */
export class StepperController extends Controller<HTMLElement> {
  static override targets = ["step"];
  static override values = {
    index: { type: Number, default: 0 },
    linear: { type: Boolean, default: false },
  };
  static actions = ["goto", "next", "prev"] as const;
  static events = ["change"] as const;

  declare readonly stepTargets: HTMLElement[];
  declare indexValue: number;
  declare linearValue: boolean;

  /** Normalizes an out-of-range initial `index` and renders the initial state. */
  override connect(): void {
    this.indexValue = this.#clampIndex(this.indexValue);
    this.#render();
  }

  /** Advances to the next step (ignored at the last step). */
  next(): void {
    this.#moveTo(this.indexValue + 1);
  }

  /** Returns to the previous step (ignored at the first step). */
  prev(): void {
    this.#moveTo(this.indexValue - 1);
  }

  /** Jumps to the step carried in the action's `index` param. */
  goto(event: { params: { index?: number } }): void {
    const target = Number(event.params.index);
    if (!Number.isFinite(target)) return;
    this.#moveTo(target);
  }

  /**
   * Moves the current step to `target` when allowed: in range, not a no-op, and
   * — under `linear` — not skipping more than one step ahead. Re-renders and
   * dispatches `change`.
   */
  #moveTo(target: number): void {
    const total = this.stepTargets.length;
    if (target < 0 || target >= total) return;
    if (target === this.indexValue) return;
    if (this.linearValue && target > this.indexValue + 1) return;

    const previous = this.indexValue;
    this.indexValue = target;
    this.#render();
    this.dispatch("change", {
      detail: { index: target, previous, step: this.stepTargets[target] },
    });
  }

  /**
   * Derives each step's `data-state` and the current button's `aria-current`.
   *
   * `aria-current="step"` is placed on the step's **first** `<button>`; the markup
   * contract assumes one operable button per step. If a step needs multiple
   * buttons, mark the navigational one first (or this would target the wrong one).
   */
  #render(): void {
    const current = this.indexValue;
    this.stepTargets.forEach((step, index) => {
      step.dataset.state =
        index < current ? "complete" : index === current ? "current" : "upcoming";
      const button = step.querySelector<HTMLElement>("button");
      if (!button) return;
      if (index === current) {
        button.setAttribute("aria-current", "step");
      } else {
        button.removeAttribute("aria-current");
      }
    });
  }

  /** Constrains an index to `[0, total-1]` (or `0` when there are no steps). */
  #clampIndex(index: number): number {
    const last = this.stepTargets.length - 1;
    if (last < 0) return 0;
    return Math.min(last, Math.max(0, Math.trunc(index)));
  }
}
