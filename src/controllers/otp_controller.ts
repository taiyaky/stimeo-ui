import { Controller } from "@hotwired/stimulus";

/**
 * Headless, accessible One-Time Password / PIN input logic.
 *
 * Markup contract (identifier: `stimeo--otp`):
 *   <div data-controller="stimeo--otp"
 *        data-stimeo--otp-length-value="6"
 *        data-stimeo--otp-pattern-value="[0-9]"
 *        role="group" aria-label="One-time passcode">
 *     <input data-stimeo--otp-target="field" inputmode="numeric" maxlength="1"
 *            data-action="input->stimeo--otp#onInput
 *                         keydown->stimeo--otp#onKeydown
 *                         paste->stimeo--otp#onPaste" />
 *     <input type="hidden" data-stimeo--otp-target="value" />
 *   </div>
 *
 * Implements highly polished UX conventions for single-digit field groups:
 * - Dynamic autofocus advancement upon valid inputs.
 * - Auto-selection `select()` upon gaining focus to enable frictionless digit overwrites.
 * - Retroactive Backspace key focus stepping to clear preceding values safely.
 * - Clipboard intercepting paste division across fields with trailing focus positioning.
 * - Hidden form sync and complete/change event dispatching.
 *
 * @remarks
 * Behavior only. The controller binds events dynamically to pre-rendered inputs,
 * updates `data-filled` and hidden value bindings, and emits Stimulus custom events.
 */
export class OtpController extends Controller<HTMLElement> {
  static override targets = ["field", "value", "error"];
  static override values = {
    length: { type: Number, default: 6 },
    pattern: { type: String, default: "[0-9]" },
  };
  static actions = ["onInput", "onKeydown", "onPaste"] as const;
  static events = ["change", "complete", "invalid"] as const;

  declare readonly fieldTargets: HTMLInputElement[];
  declare readonly valueTarget: HTMLInputElement;
  declare readonly errorTarget: HTMLElement;
  declare readonly hasValueTarget: boolean;
  declare readonly hasErrorTarget: boolean;

  declare lengthValue: number;
  declare patternValue: string;

  #isComposing = new Map<HTMLInputElement, boolean>();

  override connect(): void {
    // Dynamically bind auto-selection and IME tracking logic to all connected inputs
    for (const field of this.fieldTargets) {
      field.addEventListener("focus", this.#onFieldFocus);
      field.addEventListener("compositionstart", this.#onCompositionStart);
      field.addEventListener("compositionend", this.#onCompositionEnd);
    }
  }

  override disconnect(): void {
    for (const field of this.fieldTargets) {
      field.removeEventListener("focus", this.#onFieldFocus);
      field.removeEventListener("compositionstart", this.#onCompositionStart);
      field.removeEventListener("compositionend", this.#onCompositionEnd);
    }
    this.#isComposing.clear();
  }

  /**
   * Stimulus lifecycle callback when a new field target enters the DOM.
   * Ensures new additions are also wired with overwriting support.
   */
  fieldTargetConnected(element: HTMLInputElement): void {
    element.addEventListener("focus", this.#onFieldFocus);
    element.addEventListener("compositionstart", this.#onCompositionStart);
    element.addEventListener("compositionend", this.#onCompositionEnd);
  }

  /** Removes focus listeners when fields are dropped. */
  fieldTargetDisconnected(element: HTMLInputElement): void {
    element.removeEventListener("focus", this.#onFieldFocus);
    element.removeEventListener("compositionstart", this.#onCompositionStart);
    element.removeEventListener("compositionend", this.#onCompositionEnd);
    this.#isComposing.delete(element);
  }

  /** Handles keystroke inputs and advances focus to the next field. */
  onInput(event: Event): void {
    const input = event.currentTarget as HTMLInputElement | null;
    if (!input) return;

    // Guard during active composition to prevent premature focus switching
    if (this.#isComposing.get(input)) return;

    this.#handleInputValidation(input);
  }

  /** Handles Backspace retreating, arrows, and home/end navigation. */
  onKeydown(event: KeyboardEvent): void {
    const input = event.currentTarget as HTMLInputElement | null;
    if (!input) return;

    const index = this.fieldTargets.indexOf(input);
    if (index === -1) return;

    // Do not trigger keydown actions during composition
    if (this.#isComposing.get(input)) return;

    switch (event.key) {
      case "Backspace":
        if (!input.value) {
          // Empty field: step backward, wipe previous digit, and focus it
          if (index > 0) {
            event.preventDefault();
            const prevField = this.fieldTargets[index - 1];
            if (prevField) {
              prevField.value = "";
              prevField.removeAttribute("data-filled");
              prevField.focus();
              this.#clearError();
              this.#syncAndDispatch();
            }
          }
        } else {
          // Filled field: clear current value
          input.value = "";
          input.removeAttribute("data-filled");
          this.#clearError();
          this.#syncAndDispatch();
        }
        break;

      case "ArrowLeft":
        if (index > 0) {
          event.preventDefault();
          this.fieldTargets[index - 1]?.focus();
        }
        break;

      case "ArrowRight":
        if (index < this.lengthValue - 1) {
          event.preventDefault();
          this.fieldTargets[index + 1]?.focus();
        }
        break;

      case "Home":
        event.preventDefault();
        this.fieldTargets[0]?.focus();
        break;

      case "End":
        event.preventDefault();
        this.fieldTargets[this.lengthValue - 1]?.focus();
        break;

      default:
        break;
    }
  }

  /** Divides pasted string characters across available input fields. */
  onPaste(event: ClipboardEvent): void {
    const input = event.currentTarget as HTMLInputElement | null;
    if (!input) return;

    const startIndex = this.fieldTargets.indexOf(input);
    if (startIndex === -1) return;

    event.preventDefault();

    const rawText = event.clipboardData?.getData("text") || "";
    const text = this.#normalizeValue(rawText);
    const regex = new RegExp(`^${this.patternValue}$`);
    const validChars = Array.from(text).filter((char) => regex.test(char));

    if (validChars.length === 0) {
      this.#showError();
      return;
    }

    const limit = Math.min(validChars.length, this.lengthValue - startIndex);
    let lastFocusedIndex = startIndex;

    for (let i = 0; i < limit; i++) {
      const fieldIndex = startIndex + i;
      const field = this.fieldTargets[fieldIndex];
      const char = validChars[i];

      if (field && char) {
        field.value = char;
        field.setAttribute("data-filled", "true");
        lastFocusedIndex = fieldIndex;
      }
    }

    this.#clearError();

    // Set trailing focus position to the last filled box (or next empty if one exists)
    const focusTargetIndex =
      lastFocusedIndex < this.lengthValue - 1 ? lastFocusedIndex + 1 : lastFocusedIndex;
    this.fieldTargets[focusTargetIndex]?.focus();

    this.#syncAndDispatch();
  }

  readonly #onFieldFocus = (event: FocusEvent): void => {
    const input = event.currentTarget as HTMLInputElement | null;
    if (input) {
      // Auto-selection enables effortless character overwrites
      input.select();
    }
  };

  readonly #onCompositionStart = (event: CompositionEvent): void => {
    const input = event.currentTarget as HTMLInputElement;
    this.#isComposing.set(input, true);
  };

  readonly #onCompositionEnd = (event: CompositionEvent): void => {
    const input = event.currentTarget as HTMLInputElement;
    this.#isComposing.set(input, false);

    // Force validation after IME conversion finishes
    this.#handleInputValidation(input);
  };

  #handleInputValidation(input: HTMLInputElement): void {
    const index = this.fieldTargets.indexOf(input);
    if (index === -1) return;

    const rawValue = input.value;
    const normalized = this.#normalizeValue(rawValue);
    const regex = new RegExp(`^${this.patternValue}$`);

    if (normalized && regex.test(normalized)) {
      input.value = normalized;
      input.setAttribute("data-filled", "true");
      this.#clearError();

      // Step focus forward
      if (index < this.lengthValue - 1) {
        const nextField = this.fieldTargets[index + 1];
        nextField?.focus();
      }
    } else if (normalized) {
      input.value = "";
      input.removeAttribute("data-filled");
      this.#showError();
    } else {
      input.removeAttribute("data-filled");
    }

    this.#syncAndDispatch();
  }

  #normalizeValue(val: string): string {
    // Replaces full-width numbers (０-９) with standard half-width ones (0-9)
    return val.replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0));
  }

  #showError(): void {
    if (this.hasErrorTarget) {
      this.errorTarget.removeAttribute("hidden");
    }
    // Behavior only: emit a neutral payload and let the consumer compose/localize
    // the user-facing message. The pattern is reported so consumers can word it.
    this.dispatch("invalid", { detail: { pattern: this.patternValue } });
  }

  #clearError(): void {
    if (this.hasErrorTarget) {
      this.errorTarget.setAttribute("hidden", "true");
    }
  }

  #syncAndDispatch(): void {
    const fields = this.fieldTargets;
    const combinedValue = fields.map((f) => f.value).join("");

    if (this.hasValueTarget) {
      this.valueTarget.value = combinedValue;
    }

    this.dispatch("change", { detail: { value: combinedValue } });

    // Completed state when all fields contain a digit
    const isCompleted =
      fields.every((f) => f.value.length > 0) && combinedValue.length === this.lengthValue;
    if (isCompleted) {
      this.dispatch("complete", { detail: { value: combinedValue } });
    }
  }
}
