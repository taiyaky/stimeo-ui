import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord } from "../utils/arrow_step";
import { AttributeLease } from "../utils/attribute_lease";
import { CompositionTracker } from "../utils/composition_tracker";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { SafeInterval, SafeTimeout } from "../utils/safe_timeout";
import { snapSteppedValue, stepSteppedValue } from "../utils/stepped_value";

/** Marks a `disabled` state derived and therefore removable by this controller. */
const OWNED_DISABLED = "data-number-input-disabled";

/**
 * Headless, accessible number / spin-button behavior.
 *
 * Markup contract (identifier: `stimeo--number-input`):
 *   <div data-controller="stimeo--number-input"
 *        data-stimeo--number-input-min-value="0"
 *        data-stimeo--number-input-max-value="100"
 *        data-stimeo--number-input-step-value="1">
 *     <button type="button" aria-label="Decrease" tabindex="-1"
 *             data-stimeo--number-input-target="decrement"
 *             data-action="click->stimeo--number-input#decrement">−</button>
 *     <input type="number" min="0" max="100" step="1" value="0"
 *            data-stimeo--number-input-target="input"
 *            data-action="change->stimeo--number-input#onInput
 *                         keydown->stimeo--number-input#onKeydown" />
 *     <button type="button" aria-label="Increase" tabindex="-1"
 *             data-stimeo--number-input-target="increment"
 *             data-action="click->stimeo--number-input#increment">+</button>
 *   </div>
 *
 * Implements the WAI-ARIA APG **Spinbutton** pattern. The arrow/step logic is
 * fully owned by the controller (not delegated to the browser's native number
 * stepping) so the behavior is identical for a native `<input type="number">` and
 * a custom `role="spinbutton"` host.
 *
 * @remarks
 * Behavior only — the consumer styles the field and buttons. The input is the
 * sole Tab stop; the buttons are `tabindex="-1"` and keep focus on the input
 * (pointerdown is suppressed), so stepping never moves focus away.
 *
 * Behavior provided:
 * - `ArrowUp`/`ArrowDown` step by `step`; `PageUp`/`PageDown` by `pageStep`
 *   (default `step × 10`); `Home`/`End` jump to a finite `min`/`max`.
 * - Increment/decrement buttons step too, and are `disabled` at the bounds (focus
 *   is returned to the input before a focused button is disabled).
 * - **Press-and-hold auto-repeat**: holding a step button steps once, then after a
 *   short delay repeats until release, the bound is reached, or the element
 *   disconnects. The `click` binding stays the single-step path (a quick click, a
 *   synthesized/programmatic click, or assistive activation), so a normal click
 *   never double-steps — the trailing click after a hold is swallowed.
 * - Typed input is clamped and snapped to the step grid on `change`;
 *   `stimeo--number-input:change` is dispatched once for each changed committed
 *   numeric value with `{ value: number }` detail. When a runtime `min`/`max`/
 *   `step` change pulls the committed value with it, that same detail arrives as
 *   `stimeo--number-input:reconcile` instead, so a consumer can tell its own edit
 *   from the controller's repair. Neither event fires on connect.
 * - `step` must be finite and positive; invalid runtime input falls back to `1`,
 *   while finite range endpoints remain reachable off the grid.
 */
export class NumberInputController extends Controller<HTMLElement> {
  static override targets = ["input", "increment", "decrement"];
  static override values = {
    min: { type: Number, default: Number.NEGATIVE_INFINITY },
    max: { type: Number, default: Number.POSITIVE_INFINITY },
    step: { type: Number, default: 1 },
    pageStep: { type: Number, default: 0 },
  };
  static actions = ["decrement", "increment", "onInput", "onKeydown"] as const;
  static events = ["change", "reconcile"] as const;

  declare readonly inputTarget: HTMLInputElement;
  declare readonly hasInputTarget: boolean;
  declare readonly incrementTarget: HTMLButtonElement;
  declare readonly incrementTargets: HTMLButtonElement[];
  declare readonly hasIncrementTarget: boolean;
  declare readonly decrementTarget: HTMLButtonElement;
  declare readonly decrementTargets: HTMLButtonElement[];
  declare readonly hasDecrementTarget: boolean;
  declare minValue: number;
  declare maxValue: number;
  declare stepValue: number;
  declare pageStepValue: number;

  /** Delay (ms) a button must be held before auto-repeat starts. */
  static readonly #HOLD_DELAY_MS = 400;
  /** Interval (ms) between auto-repeat steps once a hold has started. */
  static readonly #HOLD_REPEAT_MS = 80;
  /**
   * Window (ms) after a hold ends during which the trailing synthetic `click` is
   * swallowed. A safety net for the (rare) case where that click never arrives
   * (e.g. the pointer was released off the button): the flag self-clears instead
   * of poisoning the next legitimate click.
   */
  static readonly #SUPPRESS_RESET_MS = 250;

  /** Aborts global pointer guards on disconnect so none outlive the element. */
  #globalGuards: AbortController | null = null;
  /** Per-target guards allow an old button to be released without touching its replacement. */
  readonly #buttonGuards = new Map<HTMLButtonElement, AbortController>();
  /** Tracks IME lifecycle on the current input, including confirming keys without a signal. */
  readonly #composition = new CompositionTracker();
  /** Restores authored custom-spinbutton ARIA when a target leaves or the controller stops. */
  readonly #ariaValueNow = new AttributeLease<HTMLInputElement>("aria-valuenow");
  readonly #ariaValueMin = new AttributeLease<HTMLInputElement>("aria-valuemin");
  readonly #ariaValueMax = new AttributeLease<HTMLInputElement>("aria-valuemax");
  /** Last reconciled or user-committed numeric value. */
  #lastValue: number | null = null;
  /** Timers for the hold delay and the suppress-reset safety net. */
  readonly #holdTimeouts = new SafeTimeout();
  /** The running auto-repeat interval (one at a time). */
  readonly #holdIntervals = new SafeInterval();
  /** True while a hold is armed/running, making `#stopHold` idempotent. */
  #holdActive = false;
  /** True once a hold actually produced a repeated step (vs. a quick click). */
  #repeatedDuringHold = false;
  /** True when the next `click` is the trailing one after a hold and must be ignored. */
  #suppressNextClick = false;
  /** Button and pointer that own the current hold, so other instances/pointers cannot end it. */
  #holdButton: HTMLButtonElement | null = null;
  #holdPointerId: number | null = null;
  /** Collapses runtime range/step changes into one input reconciliation. */
  readonly #repaint = new MicrotaskCoalescer(() => this.#reconcile());

  /** Normalizes any initial value and wires the focus/hold pointer guards. */
  override connect(): void {
    this.#repaint.activate();
    this.#globalGuards = new AbortController();
    const { signal } = this.#globalGuards;
    for (const button of this.incrementTargets) this.#wireButton(button, 1);
    for (const button of this.decrementTargets) this.#wireButton(button, -1);
    // A pointer released or focus lost anywhere stops a running hold, even when
    // the button stopped receiving its own pointerup (e.g. it became disabled at
    // the bound, or the pointer was released off it).
    window.addEventListener("pointerup", this.#onPointerEnd, { signal });
    window.addEventListener("pointercancel", this.#onPointerEnd, { signal });
    window.addEventListener("blur", this.#onWindowBlur, { signal });
    this.#reconcile();
  }

  /** Releases listeners, derived attributes, timers, and transient value state. */
  override disconnect(): void {
    this.#repaint.cancel();
    this.#composition.disconnect();
    this.#globalGuards?.abort();
    this.#globalGuards = null;
    const buttons = new Set([
      ...this.#buttonGuards.keys(),
      ...this.incrementTargets,
      ...this.decrementTargets,
    ]);
    for (const guard of this.#buttonGuards.values()) guard.abort();
    this.#buttonGuards.clear();
    for (const button of buttons) this.#releaseButtonState(button);
    this.#stopHold(false);
    this.#repeatedDuringHold = false;
    this.#suppressNextClick = false;
    this.#holdTimeouts.clearAll();
    this.#holdIntervals.clearAll();
    this.#ariaValueNow.returnAll();
    this.#ariaValueMin.returnAll();
    this.#ariaValueMax.returnAll();
    this.#lastValue = null;
  }

  /** Reconciles the value against a minimum changed by application code or a Turbo morph. */
  minValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Reconciles the value against a maximum changed by application code or a Turbo morph. */
  maxValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Reconciles the value against a step changed by application code or a Turbo morph. */
  stepValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Tracks and reconciles an input inserted or replaced at runtime. */
  inputTargetConnected(input: HTMLInputElement): void {
    this.#composition.observe(input);
    this.#repaint.schedule();
  }

  /** Releases ARIA and composition state owned by an input that left the controller. */
  inputTargetDisconnected(input: HTMLInputElement): void {
    this.#composition.unobserve(input);
    this.#releaseInputAria(input);
    this.#stopHold(false);
    this.#lastValue = null;
    this.#repaint.schedule();
  }

  /** Wires focus preservation and hold behavior on a runtime increment target. */
  incrementTargetConnected(button: HTMLButtonElement): void {
    this.#wireButton(button, 1);
    this.#repaint.schedule();
  }

  /** Releases only the increment target that actually disconnected. */
  incrementTargetDisconnected(button: HTMLButtonElement): void {
    this.#unwireButton(button);
    this.#repaint.schedule();
  }

  /** Wires focus preservation and hold behavior on a runtime decrement target. */
  decrementTargetConnected(button: HTMLButtonElement): void {
    this.#wireButton(button, -1);
    this.#repaint.schedule();
  }

  /** Releases only the decrement target that actually disconnected. */
  decrementTargetDisconnected(button: HTMLButtonElement): void {
    this.#unwireButton(button);
    this.#repaint.schedule();
  }

  /** Increases by one step. Bound via `data-action` (click). */
  increment(): void {
    if (this.#consumeSuppressedClick()) return;
    if (!this.hasInputTarget) return;
    this.#commitStep(1);
    this.inputTarget.focus();
  }

  /** Decreases by one step. Bound via `data-action` (click). */
  decrement(): void {
    if (this.#consumeSuppressedClick()) return;
    if (!this.hasInputTarget) return;
    this.#commitStep(-1);
    this.inputTarget.focus();
  }

  /** Clamps and snaps a typed value. Bound via `data-action` (change). */
  onInput(): void {
    if (!this.hasInputTarget) return;
    if (this.inputTarget.value.trim() === "") {
      this.#lastValue = null;
      this.#reflectEmpty();
      return;
    }
    this.#commit(this.#currentValue());
  }

  /** Keyboard stepping per the APG spinbutton model. */
  onKeydown(event: KeyboardEvent): void {
    if (!this.hasInputTarget) return;
    if (this.#composition.isComposing(event)) return;
    if (isReservedArrowChord(event)) return;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowUp":
        next = stepSteppedValue(this.#currentValue(), 1, this.#steppedRange);
        break;
      case "ArrowDown":
        next = stepSteppedValue(this.#currentValue(), -1, this.#steppedRange);
        break;
      case "PageUp":
        next =
          this.pageStepValue > 0
            ? this.#currentValue() + this.pageStepValue
            : stepSteppedValue(this.#currentValue(), 10, this.#steppedRange);
        break;
      case "PageDown":
        next =
          this.pageStepValue > 0
            ? this.#currentValue() - this.pageStepValue
            : stepSteppedValue(this.#currentValue(), -10, this.#steppedRange);
        break;
      case "Home":
        if (!Number.isFinite(this.minValue)) return;
        next = this.minValue;
        break;
      case "End":
        if (!Number.isFinite(this.maxValue)) return;
        next = this.maxValue;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.#commit(next);
  }

  /**
   * Wires a step button: `pointerdown` keeps focus on the input and arms the
   * hold; leaving the button while held stops it (the global listeners cover
   * release/cancel/blur).
   */
  #wireButton(button: HTMLButtonElement, direction: number): void {
    if (this.#buttonGuards.has(button)) return;
    const guard = new AbortController();
    this.#buttonGuards.set(button, guard);
    button.addEventListener("pointerdown", (event) => this.#armHold(event, button, direction), {
      signal: guard.signal,
    });
    button.addEventListener(
      "pointerleave",
      (event) => {
        if (this.#holdButton === button && this.#ownsPointer(event)) this.#stopHold();
      },
      { signal: guard.signal },
    );
  }

  /** Aborts one target's listeners and returns any state derived onto that button. */
  #unwireButton(button: HTMLButtonElement): void {
    this.#buttonGuards.get(button)?.abort();
    this.#buttonGuards.delete(button);
    if (this.#holdButton === button) this.#stopHold(false);
    this.#releaseButtonState(button);
  }

  /** Starts a hold: focus the input, then schedule the first repeat after a delay. */
  #armHold(event: Event, button: HTMLButtonElement, direction: number): void {
    // Ignore secondary buttons (right/middle) when the event exposes one.
    const pointerButton = (event as PointerEvent).button;
    if (typeof pointerButton === "number" && pointerButton !== 0) return;
    if (button.disabled || !this.hasInputTarget) return;
    event.preventDefault(); // keep focus on the input rather than the button
    this.inputTarget.focus();

    this.#stopHold(false);
    this.#holdActive = true;
    this.#holdButton = button;
    this.#holdPointerId = this.#pointerId(event);
    this.#repeatedDuringHold = false;
    this.#suppressNextClick = false;
    this.#holdTimeouts.set(() => {
      if (!this.#commitStep(direction)) {
        this.#stopHold();
        return;
      }
      this.#repeatedDuringHold = true;
      this.#holdIntervals.set(() => {
        if (!this.#commitStep(direction)) this.#stopHold();
      }, NumberInputController.#HOLD_REPEAT_MS);
    }, NumberInputController.#HOLD_DELAY_MS);
  }

  /**
   * Stops the current hold (idempotent). When the hold actually repeated, the
   * trailing synthetic `click` must be ignored, so it is suppressed until the
   * click consumes it or a short safety-net timeout clears it.
   */
  #stopHold(suppressTrailingClick = true): void {
    if (!this.#holdActive) return;
    this.#holdActive = false;
    this.#holdButton = null;
    this.#holdPointerId = null;
    this.#holdTimeouts.clearAll();
    this.#holdIntervals.clearAll();
    if (suppressTrailingClick && this.#repeatedDuringHold) {
      this.#suppressNextClick = true;
      this.#holdTimeouts.set(() => {
        this.#suppressNextClick = false;
      }, NumberInputController.#SUPPRESS_RESET_MS);
    } else if (!suppressTrailingClick) {
      this.#suppressNextClick = false;
    }
  }

  /** Ends a hold only for its initiating pointer (legacy/synthetic events remain accepted). */
  readonly #onPointerEnd = (event: Event): void => {
    if (this.#ownsPointer(event)) this.#stopHold();
  };

  /** Window deactivation is global and always ends the active hold. */
  readonly #onWindowBlur = (): void => {
    this.#stopHold();
  };

  /** Extracts pointer identity when the runtime event exposes it. */
  #pointerId(event: Event): number | null {
    return (event as Partial<PointerEvent>).pointerId ?? null;
  }

  /** Whether `event` belongs to the active pointer, with a synthetic-event fallback. */
  #ownsPointer(event: Event): boolean {
    const pointerId = this.#pointerId(event);
    return (
      this.#holdActive &&
      (this.#holdPointerId === null || pointerId === null || pointerId === this.#holdPointerId)
    );
  }

  /** Consumes a pending trailing-click suppression; returns true if the click was swallowed. */
  #consumeSuppressedClick(): boolean {
    if (!this.#suppressNextClick) return false;
    this.#suppressNextClick = false;
    this.#holdTimeouts.clearAll();
    return true;
  }

  /**
   * Normalizes `raw`, reflects it, and dispatches `{ value: number }` only when
   * the committed numeric value differs from the last reconciled value.
   *
   * @returns Whether the value changed (drives the auto-repeat's bound stop).
   */
  #commit(raw: number): boolean {
    const value = this.#normalize(raw);
    const changed = this.#lastValue === null || value !== this.#lastValue;
    this.#write(value);
    this.#lastValue = value;
    if (changed) this.dispatch("change", { detail: { value } });
    return changed;
  }

  /** Commits an adjacent endpoint/grid value and reports whether it moved. */
  #commitStep(count: number): boolean {
    if (!this.hasInputTarget) return false;
    return this.#commit(stepSteppedValue(this.#currentValue(), count, this.#steppedRange));
  }

  /**
   * Reflects the current value after a range or step morph, reporting a moved
   * value as `reconcile`.
   *
   * @stimeoRenderRoot
   */
  #reconcile(): void {
    if (!this.hasInputTarget) {
      this.#lastValue = null;
      return;
    }
    if (this.inputTarget.value.trim() !== "") {
      const previous = this.#lastValue;
      const value = this.#normalize(this.#currentValue());
      this.#write(value);
      this.#lastValue = value;
      // A range or step the consumer moved at runtime can pull the committed
      // number with it. That is this controller's decision, so it is reported
      // apart from `change`, which stays reserved for user edits.
      if (previous !== null && value !== previous) {
        this.dispatch("reconcile", { detail: { value } });
      }
    } else {
      this.#lastValue = null;
      this.#reflectEmpty();
    }
  }

  /** Reflects `value` on the input (and ARIA for non-native hosts) and the buttons. */
  #write(value: number): void {
    const input = this.inputTarget;
    input.value = String(value);
    this.#syncInputAria(input, value);
    this.#updateButtons(value);
  }

  /** Reflects a blank value without inventing a numeric `aria-valuenow`. */
  #reflectEmpty(): void {
    this.#syncInputAria(this.inputTarget, null);
    this.#updateButtons(this.#currentValue());
  }

  /** Synchronizes controller-derived ARIA while preserving authored teardown values. */
  #syncInputAria(input: HTMLInputElement, value: number | null): void {
    if (input.getAttribute("role") !== "spinbutton") {
      this.#releaseInputAria(input);
      return;
    }
    this.#ariaValueNow.write(input, value === null ? null : String(value));
    this.#ariaValueMin.write(input, Number.isFinite(this.minValue) ? String(this.minValue) : null);
    this.#ariaValueMax.write(input, Number.isFinite(this.maxValue) ? String(this.maxValue) : null);
  }

  /** Returns all custom-spinbutton ARIA leased on `input`. */
  #releaseInputAria(input: HTMLInputElement): void {
    this.#ariaValueNow.return(input);
    this.#ariaValueMin.return(input);
    this.#ariaValueMax.return(input);
  }

  /** Disables a step button at its bound, returning focus to the input first. */
  #updateButtons(value: number): void {
    for (const button of this.incrementTargets) this.#toggleButton(button, value < this.maxValue);
    for (const button of this.decrementTargets) this.#toggleButton(button, value > this.minValue);
  }

  /**
   * Enables or disables a step button at its bound, never disabling one while it
   * holds focus. Owns only the `disabled` it sets itself via a marker
   * (`data-number-input-disabled`, like `conditional-fields`/`submit-once`), so an
   * author-disabled button (e.g. the whole control disabled) is never re-enabled.
   */
  #toggleButton(button: HTMLButtonElement, enabled: boolean): void {
    if (enabled) {
      if (button.hasAttribute(OWNED_DISABLED)) {
        button.disabled = false;
        button.removeAttribute(OWNED_DISABLED);
      }
      return;
    }
    if (button.disabled) return; // already disabled (possibly by the author) — leave it
    if (document.activeElement === button && this.hasInputTarget) this.inputTarget.focus();
    button.disabled = true;
    button.setAttribute(OWNED_DISABLED, "");
  }

  /** Returns `disabled` only when its explicit marker still identifies controller ownership. */
  #releaseButtonState(button: HTMLButtonElement): void {
    if (!button.hasAttribute(OWNED_DISABLED)) return;
    button.disabled = false;
    button.removeAttribute(OWNED_DISABLED);
  }

  /** The current numeric value, falling back to a finite min (else 0) when blank. */
  #currentValue(): number {
    const parsed = Number(this.inputTarget.value);
    if (Number.isFinite(parsed) && this.inputTarget.value.trim() !== "") return parsed;
    return Number.isFinite(this.minValue) ? this.minValue : 0;
  }

  /** Clamps to `[min, max]` and snaps to the step grid anchored at a finite min (else 0). */
  #normalize(raw: number): number {
    return snapSteppedValue(raw, this.#steppedRange);
  }

  /** Shared range configuration; finite endpoints remain allowed off the grid. */
  get #steppedRange() {
    return { min: this.minValue, max: this.maxValue, step: this.stepValue };
  }
}
