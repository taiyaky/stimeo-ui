import { Controller } from "@hotwired/stimulus";
import { SafeInterval, SafeTimeout } from "../utils/safe_timeout";

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
 * a custom `role="spinbutton"` host, and deterministic under happy-dom.
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
 *   `stimeo--number-input:change` is dispatched on every committed change.
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
  static events = ["change"] as const;

  declare readonly inputTarget: HTMLInputElement;
  declare readonly hasInputTarget: boolean;
  declare readonly incrementTarget: HTMLButtonElement;
  declare readonly hasIncrementTarget: boolean;
  declare readonly decrementTarget: HTMLButtonElement;
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

  /** Aborts the pointer listeners on disconnect so none outlive the element. */
  #guards: AbortController | null = null;
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

  /** Normalizes any initial value and wires the focus/hold pointer guards. */
  override connect(): void {
    if (!this.hasInputTarget) return;
    if (this.inputTarget.value.trim() !== "") {
      this.#write(this.#normalize(this.#currentValue()));
    } else {
      this.#updateButtons(this.#currentValue());
    }
    this.#guards = new AbortController();
    const { signal } = this.#guards;
    if (this.hasIncrementTarget) this.#wireButton(this.incrementTarget, this.stepValue, signal);
    if (this.hasDecrementTarget) this.#wireButton(this.decrementTarget, -this.stepValue, signal);
    // A pointer released or focus lost anywhere stops a running hold, even when
    // the button stopped receiving its own pointerup (e.g. it became disabled at
    // the bound, or the pointer was released off it).
    window.addEventListener("pointerup", this.#stopHold, { signal });
    window.addEventListener("pointercancel", this.#stopHold, { signal });
    window.addEventListener("blur", this.#stopHold, { signal });
  }

  /** Releases the pointer guards and tears down every pending timer and hold state. */
  override disconnect(): void {
    this.#guards?.abort();
    this.#guards = null;
    this.#holdActive = false;
    this.#repeatedDuringHold = false;
    this.#suppressNextClick = false;
    this.#holdTimeouts.clearAll();
    this.#holdIntervals.clearAll();
  }

  /** Increases by one step. Bound via `data-action` (click). */
  increment(): void {
    if (this.#consumeSuppressedClick()) return;
    this.#commit(this.#currentValue() + this.stepValue);
    this.inputTarget.focus();
  }

  /** Decreases by one step. Bound via `data-action` (click). */
  decrement(): void {
    if (this.#consumeSuppressedClick()) return;
    this.#commit(this.#currentValue() - this.stepValue);
    this.inputTarget.focus();
  }

  /** Clamps and snaps a typed value. Bound via `data-action` (change). */
  onInput(): void {
    if (this.inputTarget.value.trim() === "") return;
    this.#commit(this.#currentValue());
  }

  /** Keyboard stepping per the APG spinbutton model. */
  onKeydown(event: KeyboardEvent): void {
    const page = this.pageStepValue > 0 ? this.pageStepValue : this.stepValue * 10;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowUp":
        next = this.#currentValue() + this.stepValue;
        break;
      case "ArrowDown":
        next = this.#currentValue() - this.stepValue;
        break;
      case "PageUp":
        next = this.#currentValue() + page;
        break;
      case "PageDown":
        next = this.#currentValue() - page;
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
  #wireButton(button: HTMLButtonElement, delta: number, signal: AbortSignal): void {
    button.addEventListener("pointerdown", (event) => this.#armHold(event, button, delta), {
      signal,
    });
    button.addEventListener("pointerleave", this.#stopHold, { signal });
  }

  /** Starts a hold: focus the input, then schedule the first repeat after a delay. */
  #armHold(event: Event, button: HTMLButtonElement, delta: number): void {
    // Ignore secondary buttons (right/middle) when the event exposes one.
    const pointerButton = (event as PointerEvent).button;
    if (typeof pointerButton === "number" && pointerButton !== 0) return;
    if (button.disabled) return;
    event.preventDefault(); // keep focus on the input rather than the button
    this.inputTarget.focus();

    this.#stopHold();
    this.#holdActive = true;
    this.#repeatedDuringHold = false;
    this.#suppressNextClick = false;
    this.#holdTimeouts.set(() => {
      if (!this.#commit(this.#currentValue() + delta)) {
        this.#stopHold();
        return;
      }
      this.#repeatedDuringHold = true;
      this.#holdIntervals.set(() => {
        if (!this.#commit(this.#currentValue() + delta)) this.#stopHold();
      }, NumberInputController.#HOLD_REPEAT_MS);
    }, NumberInputController.#HOLD_DELAY_MS);
  }

  /**
   * Stops the current hold (idempotent). When the hold actually repeated, the
   * trailing synthetic `click` must be ignored, so it is suppressed until the
   * click consumes it or a short safety-net timeout clears it.
   */
  readonly #stopHold = (): void => {
    if (!this.#holdActive) return;
    this.#holdActive = false;
    this.#holdTimeouts.clearAll();
    this.#holdIntervals.clearAll();
    if (this.#repeatedDuringHold) {
      this.#suppressNextClick = true;
      this.#holdTimeouts.set(() => {
        this.#suppressNextClick = false;
      }, NumberInputController.#SUPPRESS_RESET_MS);
    }
  };

  /** Consumes a pending trailing-click suppression; returns true if the click was swallowed. */
  #consumeSuppressedClick(): boolean {
    if (!this.#suppressNextClick) return false;
    this.#suppressNextClick = false;
    this.#holdTimeouts.clearAll();
    return true;
  }

  /**
   * Normalizes `raw`, reflects it, and dispatches `change` only when the
   * displayed value actually changes.
   *
   * @returns Whether the value changed (drives the auto-repeat's bound stop).
   */
  #commit(raw: number): boolean {
    const value = this.#normalize(raw);
    const changed = this.inputTarget.value !== String(value);
    this.#write(value);
    if (changed) this.dispatch("change", { detail: { value } });
    return changed;
  }

  /** Reflects `value` on the input (and ARIA for non-native hosts) and the buttons. */
  #write(value: number): void {
    this.inputTarget.value = String(value);
    if (this.inputTarget.getAttribute("role") === "spinbutton") {
      this.inputTarget.setAttribute("aria-valuenow", String(value));
      if (Number.isFinite(this.minValue)) {
        this.inputTarget.setAttribute("aria-valuemin", String(this.minValue));
      }
      if (Number.isFinite(this.maxValue)) {
        this.inputTarget.setAttribute("aria-valuemax", String(this.maxValue));
      }
    }
    this.#updateButtons(value);
  }

  /** Disables a step button at its bound, returning focus to the input first. */
  #updateButtons(value: number): void {
    if (this.hasIncrementTarget) this.#toggleButton(this.incrementTarget, value < this.maxValue);
    if (this.hasDecrementTarget) this.#toggleButton(this.decrementTarget, value > this.minValue);
  }

  /**
   * Enables or disables a step button at its bound, never disabling one while it
   * holds focus. Owns only the `disabled` it sets itself via a marker
   * (`data-number-input-disabled`, like `conditional-fields`/`submit-once`), so an
   * author-disabled button (e.g. the whole control disabled) is never re-enabled.
   */
  #toggleButton(button: HTMLButtonElement, enabled: boolean): void {
    if (enabled) {
      if (button.hasAttribute("data-number-input-disabled")) {
        button.disabled = false;
        button.removeAttribute("data-number-input-disabled");
      }
      return;
    }
    if (button.disabled) return; // already disabled (possibly by the author) — leave it
    if (document.activeElement === button) this.inputTarget.focus();
    button.disabled = true;
    button.setAttribute("data-number-input-disabled", "");
  }

  /** The current numeric value, falling back to a finite min (else 0) when blank. */
  #currentValue(): number {
    const parsed = Number(this.inputTarget.value);
    if (Number.isFinite(parsed) && this.inputTarget.value.trim() !== "") return parsed;
    return Number.isFinite(this.minValue) ? this.minValue : 0;
  }

  /** Clamps to `[min, max]` and snaps to the step grid anchored at a finite min (else 0). */
  #normalize(raw: number): number {
    const clamped = Math.min(this.maxValue, Math.max(this.minValue, raw));
    if (this.stepValue <= 0) return clamped;
    const base = Number.isFinite(this.minValue) ? this.minValue : 0;
    const stepped = Math.round((clamped - base) / this.stepValue) * this.stepValue + base;
    return Math.min(this.maxValue, Math.max(this.minValue, stepped));
  }
}
