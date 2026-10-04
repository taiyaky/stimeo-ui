import { Controller } from "@hotwired/stimulus";
import { toFiniteNumber } from "../utils/coerce";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";

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
 * {@link StepIndicatorController | Step Indicator}; for panel switching use
 * {@link TabsController | Tabs}.
 *
 * `change` dispatches `{ index: number, previous: number, total: number, step: HTMLElement }`,
 * and `reconcile` dispatches the same
 * `{ index: number, previous: number, total: number, step: HTMLElement }` — `previous`
 * is the position shown before — when a change the page made moves the position of
 * the current step (the clamped `index`).
 *
 * User `change` reports compare the resulting state with the last published
 * state. A pending page write handled in the same script joins that confirmation;
 * a browser-delivered listener may settle it first as `reconcile`. Confirming
 * the last published state reports nothing.
 *
 * @remarks
 * Behavior only. The controller never traps or restores focus — each step button
 * is in the natural Tab order. `data-state` is purely derived from `index` and the
 * steps present (completion is not persisted).
 *
 * Behavior provided:
 * - `next`/`prev` move one step, ignoring moves past either end.
 * - `goto` jumps to the step in its `index` action param.
 * - With `linear=true`, `goto` may not skip more than one step ahead of the
 *   current one (moving backward is always allowed).
 * - Runtime changes to the `index` Value, and steps added or removed at runtime,
 *   re-derive every step's state once per batch. Once connected, a batch that
 *   moves the current position (the clamped `index`) away from the one shown
 *   reports `stimeo--stepper:reconcile` once. A batch that leaves the position
 *   where it was reports nothing, even when another step now stands there — a
 *   step added before the current one, or the current step removed while
 *   another follows it — and only redraws `data-state`/`aria-current`;
 *   connecting reports nothing.
 * - An `index` outside the step range, fractional, or not a number at all is
 *   clamped for display only. The Value keeps what the page declared, so the
 *   declared step comes back once enough steps are present; a move the user makes
 *   is the one path that writes it.
 * - Each move re-derives `data-state`/`aria-current` and dispatches
 *   `stimeo--stepper:change`.
 */
export class StepperController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override targets = ["step"];
  static override values = {
    index: { type: Number, default: 0 },
    linear: { type: Boolean, default: false },
  };

  static valueConstraints = {
    index: NUMBER_BOUNDS.finite,
  } satisfies NumberValueConstraints<typeof StepperController.values>;
  static actions = ["goto", "next", "prev"] as const;
  static events = ["change", "reconcile"] as const;

  declare readonly stepTargets: HTMLElement[];
  declare indexValue: number;
  declare linearValue: boolean;

  /**
   * Collapses the Value and target callbacks of one mutation into one pass, and
   * refuses the ones Stimulus delivers before `connect()`, which renders itself.
   */
  readonly #repaint = new MorphRenderWatcher(() => this.#reconcileStep());

  /**
   * The position shown current last, which the next move is measured from, or
   * `null` before any step has been shown. While no step is present it keeps the
   * last one.
   */
  #shown: number | null = null;

  /** Renders the initial state from `index`, clamped into the step range. */
  override connect(): void {
    this.#repaint.observe(this.element);
    this.#shown = this.#currentStep;
    this.#render();
  }

  /** Drops a pending pass, so nothing renders or reports for a stepper that left. */
  override disconnect(): void {
    this.#repaint.disconnect();
  }

  /** Re-renders when Turbo Morph or application code changes `index` at runtime. */
  indexValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Re-derives every step's state for a step added at runtime. */
  stepTargetConnected(): void {
    this.#repaint.schedule();
  }

  /** Re-derives every step's state for a step removed at runtime. */
  stepTargetDisconnected(): void {
    this.#repaint.schedule();
  }

  /** Advances to the next step (ignored at the last step). */
  next(): void {
    this.#moveTo(this.#clampIndex(this.#safeIndex) + 1);
  }

  /** Returns to the previous step (ignored at the first step). */
  prev(): void {
    this.#moveTo(this.#clampIndex(this.#safeIndex) - 1);
  }

  /**
   * Jumps to the finite integer carried in the action's `index` param.
   * Blank strings and nonnumeric JSON values do not select a step.
   */
  goto(event: { params: { index?: unknown } }): void {
    const { index } = event.params;
    const target = toFiniteNumber(index);
    if (target === null || !Number.isInteger(target)) return;
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
    const current = this.#clampIndex(this.#safeIndex);
    if (target === current && target === this.#shown) return;
    if (this.linearValue && target > current + 1) return;

    const previous = this.#shown ?? current;
    this.indexValue = target;
    // Settled before the report, so the pass the Value write starts finds the step
    // already shown, and a listener that moves on is measured from this step.
    this.#shown = target;
    this.#render();
    if (target === previous) return;
    this.dispatch("change", {
      detail: { index: target, previous, total, step: this.stepTargets[target] },
    });
  }

  /**
   * Re-derives one settled batch of Value and target changes, and reports a
   * current position that moved from the one shown before as `reconcile`. With no
   * step present there is nothing to report, and the position shown last stays the
   * one the next move is measured from.
   */
  #reconcileStep(): void {
    const previous = this.#shown;
    const index = this.#currentStep;
    if (index !== null) this.#shown = index;
    this.#render();
    if (index === null || previous === null || index === previous) return;
    const steps = this.stepTargets;
    this.dispatch("reconcile", {
      detail: { index, previous, total: steps.length, step: steps[index] },
    });
  }

  /** The current position, clamped into the step range, or `null` when there is no step. */
  get #currentStep(): number | null {
    return this.stepTargets.length > 0 ? this.#clampIndex(this.#safeIndex) : null;
  }

  /**
   * Derives each step's `data-state` and the current button's `aria-current` from
   * `index`, clamped into the step range, without dispatching an action event.
   *
   * The clamp decides only what is shown. This body never writes `index`, so an
   * out-of-range declaration stays in the attribute as the page wrote it.
   *
   * `aria-current="step"` is placed on the step's **first** `<button>`; the markup
   * contract assumes one operable button per step. If a step needs multiple
   * buttons, mark the navigational one first (or this would target the wrong one).
   *
   * @stimeoRenderRoot
   */
  #render(): void {
    const current = this.#clampIndex(this.#safeIndex);
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
  /** Current `index` declaration resolved against its numeric contract. */
  get #safeIndex(): number {
    return this.#numbers.read(
      this,
      "index",
      this.indexValue,
      StepperController.values.index.default,
      StepperController.valueConstraints.index,
    );
  }
}
