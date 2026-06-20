import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";

/**
 * Headless password show/hide (unmask) toggle behavior.
 *
 * Markup contract (identifier: `stimeo--password-reveal`):
 *   <div data-controller="stimeo--password-reveal">
 *     <input type="password" aria-label="Password"
 *            data-stimeo--password-reveal-target="input">
 *     <button type="button" aria-pressed="false" aria-label="Show password"
 *             data-stimeo--password-reveal-target="toggle"
 *             data-action="stimeo--password-reveal#toggle"></button>
 *   </div>
 *
 * No dedicated APG pattern; this follows the toggle **Button** practice. The
 * accessible name stays state-independent ("Show password") while the pressed
 * state is conveyed by `aria-pressed`.
 *
 * @remarks
 * Behavior only — icon rendering is the consumer's, keyed off `aria-pressed` /
 * `data-state` (`hidden` / `visible`). Flipping `input.type` can drop focus and
 * the caret, so when (and only when) the input was the focused element its focus
 * and selection are restored afterward; when the toggle button holds focus
 * (keyboard use) focus is left on the button. An optional `autoHide` re-masks
 * after a delay, and that timer is torn down on disconnect (Turbo).
 */
export class PasswordRevealController extends Controller<HTMLElement> {
  static override targets = ["input", "toggle"];
  static override values = {
    autoHide: { type: Number, default: 0 },
  };
  static actions = ["toggle"] as const;
  static events = ["toggle"] as const;

  declare readonly inputTarget: HTMLInputElement;
  declare readonly toggleTarget: HTMLElement;
  declare readonly hasInputTarget: boolean;
  declare readonly hasToggleTarget: boolean;

  declare autoHideValue: number;

  /** Auto re-mask timer; torn down on disconnect. */
  #timers = new SafeTimeout();

  override connect(): void {
    this.#reflect(this.#isVisible);
  }

  override disconnect(): void {
    this.#timers.clearAll();
  }

  /** Toggles the input between masked and revealed. Bound via `data-action`. */
  toggle(): void {
    this.#setVisible(!this.#isVisible);
  }

  /** Whether the input is currently revealed (`type="text"`). */
  get #isVisible(): boolean {
    return this.hasInputTarget && this.inputTarget.type === "text";
  }

  /** Switches the masked/revealed state, preserving focus and caret. */
  #setVisible(visible: boolean): void {
    if (!this.hasInputTarget) return;
    const input = this.inputTarget;

    // Only the input's *own* focus is restored across the type change; if the
    // toggle button (keyboard) holds focus, it is left untouched.
    const restoreInputFocus = document.activeElement === input;
    const selectionStart = input.selectionStart;
    const selectionEnd = input.selectionEnd;

    input.type = visible ? "text" : "password";

    if (restoreInputFocus) {
      input.focus();
      // `selectionStart` / `selectionEnd` are `number | null` (null for input
      // types that don't expose a selection); only restore when both are present.
      if (selectionStart !== null && selectionEnd !== null) {
        try {
          input.setSelectionRange(selectionStart, selectionEnd);
        } catch {
          // Some input types reject selection access; focus alone is enough.
        }
      }
    }

    this.#reflect(visible);
    this.dispatch("toggle", { detail: { visible } });

    this.#timers.clearAll();
    if (visible && this.autoHideValue > 0) {
      this.#timers.set(() => this.#setVisible(false), this.autoHideValue);
    }
  }

  /** Reflects the visible state onto `aria-pressed` and `data-state`. */
  #reflect(visible: boolean): void {
    if (this.hasToggleTarget) {
      this.toggleTarget.setAttribute("aria-pressed", visible ? "true" : "false");
    }
    this.element.setAttribute("data-state", visible ? "visible" : "hidden");
  }
}
