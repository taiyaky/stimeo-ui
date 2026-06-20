import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";

/** Parks the field's original `aria-invalid` while we override it for over-limit. */
const ORIGINAL_INVALID = "data-character-counter-original-invalid";

/**
 * Headless character-counter behavior for a text field (no dedicated APG
 * pattern; follows the WCAG 2.2 "status messages" practice, 4.1.3).
 *
 * Markup contract (identifier: `stimeo--character-counter`):
 *   <div data-controller="stimeo--character-counter"
 *        data-stimeo--character-counter-max-value="140">
 *     <textarea data-stimeo--character-counter-target="input"
 *               aria-describedby="cc"></textarea>
 *     <span id="cc" data-stimeo--character-counter-target="output"
 *           aria-live="polite"></span>
 *   </div>
 *
 * Watches the field's length, writes the remaining/used count into `output`, and
 * toggles the `data-near-limit` / `data-over-limit` state hooks (plus
 * `aria-invalid` on the field once the limit is exceeded). The field is the
 * `input` target, or — when the controller is attached straight onto an
 * `<input>`/`<textarea>` — the controller element itself.
 *
 * @remarks
 * Behavior only — the count text is updated, not styled. Outside IME composition
 * the non-text state (`data-*` hooks, `aria-invalid`, and the `change` event)
 * updates **immediately** on every input so styling and consumers stay responsive,
 * while the visible count — in the `aria-live="polite"` region — is written on a
 * short debounce so a screen reader is not flooded during fast typing (it hears the
 * settled count when the user pauses). During IME composition both are deferred to
 * `compositionend`, so they reflect the confirmed characters rather than the
 * intermediate (pre-conversion) kana. The debounce timer is owned by
 * {@link SafeTimeout} and torn down on `disconnect()` (Turbo navigation included);
 * `connect()` re-reads the field so the count is correct after a cache restore.
 */
export class CharacterCounterController extends Controller<HTMLElement> {
  static override targets = ["input", "output"];
  static override values = {
    max: { type: Number, default: 0 },
    warnAt: { type: Number, default: 0 },
    mode: { type: String, default: "remaining" },
  };
  static events = ["change"] as const;

  declare readonly inputTarget: HTMLInputElement | HTMLTextAreaElement;
  declare readonly outputTarget: HTMLElement;
  declare readonly hasInputTarget: boolean;
  declare readonly hasOutputTarget: boolean;

  declare maxValue: number;
  declare warnAtValue: number;
  declare modeValue: string;

  /** Delay (ms) before the live-region count is written, to throttle SR flooding. */
  static readonly #announceDelay = 200;

  readonly #timeouts = new SafeTimeout();
  #announceId: number | null = null;

  /** True while an IME composition is active; intermediate input is skipped. */
  #composing = false;

  readonly #onInput = (event: Event): void => {
    // During IME composition the field holds unconverted text; defer the count to
    // `compositionend` so it reflects the confirmed characters, not each keystroke.
    if (this.#composing || (event as InputEvent).isComposing) return;
    this.#update();
  };

  readonly #onCompositionStart = (): void => {
    this.#composing = true;
  };

  readonly #onCompositionEnd = (): void => {
    this.#composing = false;
    this.#update();
  };

  override connect(): void {
    const field = this.#field;
    if (!field) return;
    field.addEventListener("input", this.#onInput);
    field.addEventListener("compositionstart", this.#onCompositionStart);
    field.addEventListener("compositionend", this.#onCompositionEnd);
    // Initial render is synchronous (no announce debounce): reflect the current
    // value on connect/cache-restore without queueing a screen-reader message.
    this.#update({ announce: false });
  }

  override disconnect(): void {
    const field = this.#field;
    field?.removeEventListener("input", this.#onInput);
    field?.removeEventListener("compositionstart", this.#onCompositionStart);
    field?.removeEventListener("compositionend", this.#onCompositionEnd);
    this.#timeouts.clearAll();
    this.#announceId = null;
    // Reset so a same-instance reconnect (e.g. Turbo cache restore mid-composition)
    // never starts with input suppressed.
    this.#composing = false;
  }

  /**
   * Recomputes length-derived state. Non-text state (data hooks, `aria-invalid`)
   * and the `change` event apply immediately; the live-region count text is
   * debounced unless `announce` is `false` (initial render).
   */
  #update(options: { announce?: boolean } = {}): void {
    const field = this.#field;
    if (!field) return;

    const length = field.value.length;
    const hasLimit = this.maxValue > 0;
    const remaining = hasLimit ? this.maxValue - length : null;
    const over = hasLimit && length > this.maxValue;
    const near =
      hasLimit &&
      this.warnAtValue > 0 &&
      !over &&
      remaining !== null &&
      remaining <= this.warnAtValue;

    this.#toggle("data-over-limit", over);
    this.#toggle("data-near-limit", near);
    // `aria-invalid` is a shared attribute (Form Field / server validation also use
    // it), so we never clobber an authored value: park the original when flagging
    // over-limit and restore it once back within the limit.
    if (hasLimit && over) {
      if (!field.hasAttribute(ORIGINAL_INVALID)) {
        field.setAttribute(ORIGINAL_INVALID, field.getAttribute("aria-invalid") ?? "");
      }
      field.setAttribute("aria-invalid", "true");
    } else if (field.hasAttribute(ORIGINAL_INVALID)) {
      const original = field.getAttribute(ORIGINAL_INVALID);
      if (original) {
        field.setAttribute("aria-invalid", original);
      } else {
        field.removeAttribute("aria-invalid");
      }
      field.removeAttribute(ORIGINAL_INVALID);
    }

    const text = this.#format(length, remaining);
    if (options.announce === false) {
      // Initial render (connect / cache-restore): reflect the current state without
      // emitting a change event or queueing a screen-reader announcement.
      this.#writeOutput(text);
      return;
    }

    this.dispatch("change", { detail: { length, remaining, over } });
    if (this.#announceId !== null) this.#timeouts.clear(this.#announceId);
    this.#announceId = this.#timeouts.set(() => {
      this.#writeOutput(text);
      this.#announceId = null;
    }, CharacterCounterController.#announceDelay);
  }

  /** Builds the count text for the active `mode`. */
  #format(length: number, remaining: number | null): string {
    if (remaining === null) return String(length); // no limit → used count only
    switch (this.modeValue) {
      case "used":
        return String(length);
      case "both":
        return `${length}/${this.maxValue}`;
      default:
        return String(remaining); // "remaining"
    }
  }

  #writeOutput(text: string): void {
    if (this.hasOutputTarget) this.outputTarget.textContent = text;
  }

  /** Sets a presence-style boolean data hook (attribute present when `on`). */
  #toggle(name: string, on: boolean): void {
    if (on) {
      this.element.setAttribute(name, "true");
    } else {
      this.element.removeAttribute(name);
    }
  }

  /** The watched field: the `input` target, or the element itself when it is one. */
  get #field(): HTMLInputElement | HTMLTextAreaElement | null {
    if (this.hasInputTarget) return this.inputTarget;
    const el: HTMLElement = this.element;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      return el;
    }
    return null;
  }
}
