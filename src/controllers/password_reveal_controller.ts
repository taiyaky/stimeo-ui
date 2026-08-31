import { Controller } from "@hotwired/stimulus";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { SafeTimeout } from "../utils/safe_timeout";

/** The longest delay `setTimeout` can hold; past it a delay folds to zero. */
const MAX_DELAY = 2 ** 31 - 1;

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
 * `toggle` dispatches `{ visible: boolean }`.
 *
 * @remarks
 * Behavior only — icon rendering is the consumer's, keyed off `aria-pressed` /
 * `data-state` (`hidden` / `visible`). Flipping `input.type` can drop focus and
 * the caret, so when (and only when) the input was the focused element its focus
 * and selection are restored afterward; when the toggle button holds focus
 * (keyboard use) focus is left on the button.
 *
 * The hooks are derived from the input's `type`, so they are re-derived whenever
 * a target enters or leaves — a field or button swapped in by a Turbo Stream
 * describes the state it actually has rather than the one the server rendered.
 *
 * An optional `autoHide` re-masks after a delay. The delay is armed on connect as
 * well, so a controller that reconnects onto an already revealed field still owes
 * the re-mask it promised; a value that is not a delay `setTimeout` can hold falls
 * back rather than inverting into an immediate one. Revealing is never carried
 * into a Turbo snapshot: the field is masked again before the page is cached, so
 * returning to it does not put a credential back on screen.
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

  /**
   * Whether this controller is between `connect()` and `disconnect()`.
   *
   * Target callbacks outlive the controller: Stimulus stops the target observer
   * after `disconnect()`, so a field leaving after teardown still reaches
   * {@link PasswordRevealController.inputTargetDisconnected}. Arming from there
   * would put a timer back that nothing will clear. The element staying in the
   * document does not answer this — unloading the controller leaves it there.
   */
  #connected = false;

  /** Masks the field before Turbo copies the page into its snapshot. */
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindToMasked());

  override connect(): void {
    this.#connected = true;
    const visible = this.#isVisible;
    this.#reflect(visible);
    this.#beforeCache.activate();
    // Reconnecting onto an already revealed field inherits the promise the
    // declaration made: without re-arming, the re-mask would never arrive.
    this.#arm(visible);
  }

  override disconnect(): void {
    this.#connected = false;
    this.#timers.clearAll();
    this.#beforeCache.deactivate();
  }

  /** Re-derives the hooks and the re-mask for a field swapped in after connect. */
  inputTargetConnected(): void {
    const visible = this.#connected && this.#isVisible;
    this.#reflect(visible);
    this.#arm(visible);
  }

  /**
   * Re-derives from whatever field is left rather than assuming none is. A swap
   * delivers this callback next to the arrival in either order, so a revealed
   * replacement that answered "masked" here would be described as hidden while
   * showing the password, and would carry no re-mask.
   *
   * Teardown is the one case with nothing to derive: target callbacks run after
   * `disconnect()`, so the field is still revealed and re-arming from it would
   * outlive the controller. A detached root is the signal to stand down.
   */
  inputTargetDisconnected(): void {
    const visible = this.#connected && this.element.isConnected && this.#isVisible;
    this.#reflect(visible);
    this.#arm(visible);
  }

  /** Re-derives the pressed state for a button swapped in after connect. */
  toggleTargetConnected(): void {
    this.#reflect(this.#isVisible);
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
    this.#arm(visible);
  }

  /** Schedules the auto re-mask for a revealed field, replacing any pending one. */
  #arm(visible: boolean): void {
    this.#timers.clearAll();
    const delay = this.#autoHideDelay;
    if (visible && delay > 0) {
      this.#timers.set(() => this.#setVisible(false), delay);
    }
  }

  /**
   * The auto re-mask delay, held to what `setTimeout` can carry. Past that limit
   * a delay folds to zero, turning "keep it showing" into "hide it at once" —
   * the opposite of what the declaration asked for. A value that is no delay at
   * all stays out of the positive range {@link PasswordRevealController.#arm}
   * requires, so it schedules nothing.
   */
  get #autoHideDelay(): number {
    return Math.min(this.autoHideValue, MAX_DELAY);
  }

  /**
   * Returns the field to masked before Turbo copies the page. Silent and
   * focus-free: the page is about to be frozen, so there is no one to tell and
   * nowhere for focus to go.
   */
  #rewindToMasked(): void {
    this.#timers.clearAll();
    if (!this.hasInputTarget) return;
    this.inputTarget.type = "password";
    this.#reflect(false);
  }

  /** Reflects the visible state onto `aria-pressed` and `data-state`. */
  #reflect(visible: boolean): void {
    if (this.hasToggleTarget) {
      this.toggleTarget.setAttribute("aria-pressed", visible ? "true" : "false");
    }
    this.element.setAttribute("data-state", visible ? "visible" : "hidden");
  }
}
