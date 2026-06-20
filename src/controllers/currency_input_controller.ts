import { Controller } from "@hotwired/stimulus";

/**
 * Headless currency / amount input behavior: groups digits for display while
 * keeping a machine-readable number in a hidden field, and mirrors the
 * normalized value to a visually-hidden span so assistive tech reads the real
 * amount rather than the grouped display string.
 *
 * Markup contract (identifier: `stimeo--currency-input`):
 *   <div data-controller="stimeo--currency-input"
 *        data-stimeo--currency-input-locale-value="en-US"
 *        data-stimeo--currency-input-currency-value="USD"
 *        data-stimeo--currency-input-precision-value="2">
 *     <input type="text" inputmode="decimal"
 *            aria-describedby="amt-sr"
 *            data-stimeo--currency-input-target="display"
 *            data-action="input->stimeo--currency-input#onInput
 *                         blur->stimeo--currency-input#format" />
 *     <span id="amt-sr" class="visually-hidden"
 *           data-stimeo--currency-input-target="srValue"></span>
 *     <input type="hidden" data-stimeo--currency-input-target="field" />
 *   </div>
 *
 * @remarks
 * Behavior only — no styling, no validation (range/required belong to the
 * consumer or Form Field). The display field is the sole Tab stop and keeps its
 * native text-editing behavior; this controller never steals focus. Grouping is
 * applied on every input while preserving the caret (counted by digits to its
 * left), and the fixed-precision rounding is applied on `blur`.
 *
 * Honest a11y note: a hidden `<input>` is not exposed to assistive tech, so the
 * normalized value is *also* published as text in the `srValue` span referenced
 * by the display's `aria-describedby` — that, not the hidden field, is what a
 * screen reader announces.
 */
export class CurrencyInputController extends Controller<HTMLElement> {
  static override targets = ["display", "field", "srValue"];
  static override values = {
    locale: { type: String, default: "en-US" },
    currency: { type: String, default: "" },
    precision: { type: Number, default: 2 },
  };
  static actions = ["format", "onInput"] as const;
  static events = ["change"] as const;

  declare readonly displayTarget: HTMLInputElement;
  declare readonly fieldTarget: HTMLInputElement;
  declare readonly srValueTarget: HTMLElement;
  declare readonly hasDisplayTarget: boolean;
  declare readonly hasFieldTarget: boolean;
  declare readonly hasSrValueTarget: boolean;
  declare localeValue: string;
  declare currencyValue: string;
  declare precisionValue: number;

  /** Last committed numeric value, to suppress duplicate `change` dispatches. */
  #lastValue: number | null = null;

  /** Normalizes any pre-filled display value to its fixed-precision form. */
  override connect(): void {
    if (!this.hasDisplayTarget) return;
    // Seed lastValue with the *rounded* initial value so the idempotent
    // connect-time reformat does not dispatch a spurious `change`.
    const parsed = this.#parse(this.displayTarget.value);
    this.#lastValue = parsed === null ? null : round(parsed, this.precisionValue);
    if (this.displayTarget.value.trim() !== "") {
      this.#reformat(true);
    } else {
      this.#reflect(null, "");
    }
  }

  /** Re-groups digits as the user types, preserving the caret position. */
  onInput(): void {
    this.#reformat(false);
  }

  /** Applies the fixed-precision rounding on blur. */
  format(): void {
    this.#reformat(true);
  }

  /**
   * Parses the display value, rewrites it grouped (optionally at fixed
   * precision), keeps the caret stable by digit count, and syncs the field,
   * the screen-reader span, and the `change` event.
   */
  #reformat(fixedPrecision: boolean): void {
    if (!this.hasDisplayTarget) return;
    const raw = this.displayTarget.value;
    const number = this.#parse(raw);

    if (number === null) {
      this.displayTarget.value = "";
      this.#reflect(null, "");
      return;
    }

    const value = fixedPrecision ? round(number, this.precisionValue) : number;
    const caret = this.displayTarget.selectionStart;
    const digitsBeforeCaret = typeof caret === "number" ? countDigits(raw.slice(0, caret)) : null;

    const formatted = this.#formatNumber(value, fixedPrecision);
    this.displayTarget.value = formatted;
    if (digitsBeforeCaret !== null) this.#restoreCaret(formatted, digitsBeforeCaret);

    this.#reflect(value, formatted);
  }

  /** Restores the caret to sit just after the n-th digit of the new string. */
  #restoreCaret(formatted: string, digitsBefore: number): void {
    let seen = 0;
    let position = formatted.length;
    for (let i = 0; i < formatted.length; i++) {
      if (seen >= digitsBefore) {
        position = i;
        break;
      }
      if (/\d/.test(formatted[i] as string)) seen += 1;
    }
    try {
      this.displayTarget.setSelectionRange(position, position);
    } catch {
      // Some hosts disallow selection on certain input states; the value is
      // already correct, so a failed caret restore is non-fatal.
    }
  }

  /** Writes the normalized value to the field, the SR span, and `change`. */
  #reflect(value: number | null, formatted: string): void {
    const isEmpty = value === null;
    if (this.hasFieldTarget) this.fieldTarget.value = isEmpty ? "" : String(value);
    if (this.hasSrValueTarget) {
      this.srValueTarget.textContent = isEmpty ? "" : this.#accessibleText(value);
    }
    this.element.toggleAttribute("data-stimeo--currency-input-empty", isEmpty);

    if (value !== this.#lastValue) {
      this.#lastValue = value;
      if (!isEmpty) this.dispatch("change", { detail: { value, formatted } });
    }
  }

  /** Parses arbitrary input text into a finite number, or `null` when blank. */
  #parse(text: string): number | null {
    if (text.trim() === "") return null;
    const { decimal } = this.#separators();
    // Keep digits, a leading sign, and decimal marks; normalize the locale's
    // decimal separator to "." and drop everything else (grouping, symbols).
    let cleaned = "";
    let sawDot = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i] as string;
      if (ch >= "0" && ch <= "9") cleaned += ch;
      else if ((ch === "-" || ch === "+") && cleaned === "") cleaned += ch;
      else if ((ch === decimal || ch === ".") && !sawDot) {
        cleaned += ".";
        sawDot = true;
      }
    }
    if (cleaned === "" || cleaned === "-" || cleaned === "+" || cleaned === ".") return null;
    const value = Number(cleaned);
    return Number.isFinite(value) ? value : null;
  }

  /** Formats a number with grouping for the display field. */
  #formatNumber(value: number, fixedPrecision: boolean): string {
    const formatter = new Intl.NumberFormat(this.localeValue, {
      useGrouping: true,
      minimumFractionDigits: fixedPrecision ? this.precisionValue : 0,
      maximumFractionDigits: this.precisionValue,
    });
    return formatter.format(value);
  }

  /** The text announced to assistive tech (currency-aware when configured). */
  #accessibleText(value: number): string {
    if (this.currencyValue) {
      return new Intl.NumberFormat(this.localeValue, {
        style: "currency",
        currency: this.currencyValue,
      }).format(value);
    }
    return new Intl.NumberFormat(this.localeValue, {
      minimumFractionDigits: this.precisionValue,
      maximumFractionDigits: this.precisionValue,
    }).format(value);
  }

  /** Resolves the locale's grouping and decimal separator characters. */
  #separators(): { group: string; decimal: string } {
    const parts = new Intl.NumberFormat(this.localeValue).formatToParts(11111.1);
    const group = parts.find((p) => p.type === "group")?.value ?? ",";
    const decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";
    return { group, decimal };
  }
}

/** Counts the digit characters in a string. */
function countDigits(text: string): number {
  let count = 0;
  for (const ch of text) if (ch >= "0" && ch <= "9") count += 1;
  return count;
}

/** Rounds `value` to `precision` decimal places, avoiding `-0`. */
function round(value: number, precision: number): number {
  const factor = 10 ** Math.max(0, precision);
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}
