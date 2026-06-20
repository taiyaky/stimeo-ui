import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";

/**
 * Headless copy-to-clipboard behavior with a live-region completion notice.
 *
 * Markup contract (identifier: `stimeo--clipboard`):
 *   <div data-controller="stimeo--clipboard"
 *        data-stimeo--clipboard-feedback-duration-value="2000">
 *     <input type="text" value="https://example.com" readonly
 *            data-stimeo--clipboard-target="source">
 *     <button type="button" data-stimeo--clipboard-target="button"
 *             data-action="stimeo--clipboard#copy">Copy</button>
 *     <span role="status" aria-live="polite"
 *           data-stimeo--clipboard-target="feedback"></span>
 *   </div>
 *
 * No dedicated APG pattern; this follows the Button + live-region practice. The
 * copy uses the standard `navigator.clipboard` API (no extra dependency); when
 * it is unavailable or rejects, the failure is surfaced rather than silently
 * swallowed, and never communicated by icon alone — the `role="status"` region
 * carries text so screen readers announce the outcome.
 *
 * @remarks
 * Behavior only — icon swaps and styling are the consumer's, keyed off
 * `data-state` (`idle` / `copied` / `error`). The completion notice clears
 * itself after `feedbackDuration`; that timer is torn down on disconnect (Turbo)
 * via {@link SafeTimeout}.
 */
export class ClipboardController extends Controller<HTMLElement> {
  static override targets = ["source", "button", "feedback"];
  static override values = {
    text: { type: String, default: "" },
    feedbackDuration: { type: Number, default: 2000 },
    copiedLabel: { type: String, default: "Copied" },
    errorLabel: { type: String, default: "Copy failed" },
  };
  static actions = ["copy"] as const;
  static events = ["copy"] as const;

  declare readonly sourceTarget: HTMLElement;
  declare readonly buttonTarget: HTMLElement;
  declare readonly feedbackTarget: HTMLElement;
  declare readonly hasSourceTarget: boolean;
  declare readonly hasButtonTarget: boolean;
  declare readonly hasFeedbackTarget: boolean;

  declare textValue: string;
  declare feedbackDurationValue: number;
  declare copiedLabelValue: string;
  declare errorLabelValue: string;

  /** Auto-clear timer for the completion notice; torn down on disconnect. */
  #timers = new SafeTimeout();

  /**
   * The pending auto-clear timer id, or `null` when none is scheduled. Tracked so
   * a rapid second copy cancels the first window instead of letting a stale timer
   * reset the freshly-shown notice early.
   */
  #resetTimerId: number | null = null;

  override connect(): void {
    if (!this.element.hasAttribute("data-state")) {
      this.element.setAttribute("data-state", "idle");
    }
  }

  override disconnect(): void {
    this.#timers.clearAll();
  }

  /**
   * Copies the resolved text and reports the outcome. Bound via `data-action`
   * (click). Always dispatches `stimeo--clipboard:copy` with `{ success, text }`
   * — including on failure — so consumers can react either way.
   */
  async copy(): Promise<void> {
    const text = this.#resolveText();
    let success = false;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(text);
      success = true;
    } catch {
      success = false;
    }

    this.#reportResult(success);
    this.dispatch("copy", { detail: { success, text } });
  }

  /**
   * The text to copy: the explicit `text` value when set, otherwise the source
   * target's current value (inputs/textareas) or text content.
   */
  #resolveText(): string {
    if (this.textValue.length > 0) return this.textValue;
    if (!this.hasSourceTarget) return "";
    const source = this.sourceTarget;
    if (source instanceof HTMLInputElement || source instanceof HTMLTextAreaElement) {
      return source.value;
    }
    return source.textContent ?? "";
  }

  /** Reflects the result on `data-state`, announces it, and schedules a reset. */
  #reportResult(success: boolean): void {
    this.element.setAttribute("data-state", success ? "copied" : "error");
    if (this.hasFeedbackTarget) {
      this.feedbackTarget.textContent = success ? this.copiedLabelValue : this.errorLabelValue;
    }

    // Cancel any in-flight reset so consecutive copies restart the full window
    // rather than having the earlier timer clear the new notice prematurely.
    if (this.#resetTimerId !== null) {
      this.#timers.clear(this.#resetTimerId);
      this.#resetTimerId = null;
    }
    if (this.feedbackDurationValue > 0) {
      this.#resetTimerId = this.#timers.set(() => {
        this.#resetTimerId = null;
        this.#reset();
      }, this.feedbackDurationValue);
    }
  }

  /** Returns to the idle state and clears the completion notice. */
  #reset(): void {
    this.element.setAttribute("data-state", "idle");
    if (this.hasFeedbackTarget) {
      this.feedbackTarget.textContent = "";
    }
  }
}
