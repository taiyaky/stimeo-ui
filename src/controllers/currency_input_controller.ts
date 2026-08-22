import { Controller } from "@hotwired/stimulus";
import { CompositionTracker } from "../utils/composition_tracker";
import { halfWidthChar } from "../utils/half_width";

/** The number-shaped pieces of an in-progress entry, in typing order. */
interface EntryParts {
  /** The leading sign exactly as typed (`""` when none). */
  sign: "" | "-" | "+";
  /** Integer digits with grouping stripped (may be empty mid-entry). */
  int: string;
  /** Whether a decimal mark was typed. */
  hasDot: boolean;
  /** Fraction digits exactly as typed; rounding happens only on blur. */
  frac: string;
}

/** One scan of the display text: its structure and the numeric value it holds. */
interface Scan {
  parts: EntryParts;
  /** The finite value, or `null` while no digit has been typed yet. */
  value: number | null;
}

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
 * `change` dispatches `{ value: number | null, formatted: string }` — `null`
 * (with an empty `formatted`) when the amount is cleared, so consumers hear
 * every transition of the numeric value, including back to empty.
 *
 * @remarks
 * Behavior only — no styling, no validation (range/required belong to the
 * consumer or Form Field). The display field is the sole Tab stop and keeps its
 * native text-editing behavior; this controller never steals focus.
 *
 * While typing, the entry is preserved as typed: grouping is applied to the
 * integer digits per locale, a leading sign and a trailing decimal mark stay in
 * place, fraction digits are kept verbatim, and the caret is restored after the
 * same significant character it followed. Negative amounts are in scope. The
 * fixed-precision rounding is applied on `blur`, never mid-entry.
 * Full-width digits, signs, and marks (an IME confirming ０-９／．／－) are
 * normalized to their ASCII forms rather than stripped; the locale's own
 * digits (a non-Latin default numbering system such as ar-EG's) are mapped
 * back the same way; and U+2212 MINUS SIGN is read as a sign. An ASCII "."
 * only counts as a decimal mark in locales where it is not the grouping
 * separator. Together these keep the controller's own output re-parseable to
 * the same value in every locale. Events fired mid-IME-composition are
 * ignored; the confirmed text is formatted once on `compositionend`.
 *
 * A malformed `locale`, `currency`, or `precision` declaration falls back to
 * that Value's default instead of throwing: each is validated once in its
 * `<name>ValueChanged`, and the hot path only ever sees validated values
 * through cached `Intl.NumberFormat` instances (rebuilt on Value changes, never
 * per keystroke). Late-arriving or swapped `field` / `srValue` / `display`
 * targets are re-synced on connection. The composition listeners are released
 * on `disconnect()`.
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
  #started = false;

  /** Validated mirrors of the Values; the hot path never reads a raw Value. */
  #locale = "en-US";
  #currency = "";
  #precision = 2;

  /** Formatters rebuilt only when a Value changes, never per keystroke. */
  #grouping!: Intl.NumberFormat;
  #fixed!: Intl.NumberFormat;
  #accessible!: Intl.NumberFormat;
  #group = ",";
  #decimal = ".";
  /** The locale's non-Latin digits mapped back to ASCII (empty for Latin locales). */
  readonly #digits = new Map<string, string>();

  /** Holds mid-composition input so the IME's uncommitted text is never rewritten. */
  readonly #composition = new CompositionTracker({
    onEnd: () => this.#reformat(false),
  });

  /** Re-validates on declaration changes and re-renders the committed display. */
  localeValueChanged(): void {
    this.#applyValueChange();
  }

  currencyValueChanged(): void {
    this.#applyValueChange();
  }

  precisionValueChanged(): void {
    this.#applyValueChange();
  }

  /**
   * Scans the display under the *outgoing* configuration (its separators wrote
   * that text), then revalidates and re-renders under the new one — so a locale
   * switch re-interprets the value, never the old text with new separators.
   */
  #applyValueChange(): void {
    const scan =
      this.#started && this.hasDisplayTarget ? this.#scan(this.displayTarget.value) : null;
    this.#revalidate();
    if (!scan || !this.hasDisplayTarget) return;
    if (document.activeElement === this.displayTarget) {
      const formatted = this.#render(scan.parts);
      this.displayTarget.value = formatted;
      this.#reflect(scan.value, formatted);
    } else if (scan.value === null) {
      this.displayTarget.value = "";
      this.#reflect(null, "");
    } else {
      const rounded = round(scan.value, this.#precision);
      const formatted = this.#fixed.format(rounded);
      this.displayTarget.value = formatted;
      this.#reflect(rounded, formatted);
    }
  }

  /** Normalizes any pre-filled display value to its fixed-precision form. */
  override connect(): void {
    this.#started = true;
    if (!this.hasDisplayTarget) return;
    // Seed lastValue with the *rounded* initial value so the idempotent
    // connect-time reformat does not dispatch a spurious `change`.
    const { value } = this.#scan(this.displayTarget.value);
    this.#lastValue = value === null ? null : round(value, this.#precision);
    if (value === null) {
      this.displayTarget.value = "";
      this.#reflect(null, "");
    } else {
      this.#reformat(true);
    }
  }

  override disconnect(): void {
    this.#started = false;
    this.#composition.disconnect();
  }

  /** Tracks composition on an arriving (or swapped-in) display and normalizes it. */
  displayTargetConnected(target: HTMLInputElement): void {
    this.#composition.observe(target);
    if (this.#started) this.#reformat(true);
  }

  displayTargetDisconnected(target: HTMLInputElement): void {
    this.#composition.unobserve(target);
  }

  /** Syncs a late-arriving hidden field without touching the display or events. */
  fieldTargetConnected(): void {
    if (this.#started) this.#resync();
  }

  /** Syncs a late-arriving screen-reader span the same way. */
  srValueTargetConnected(): void {
    if (this.#started) this.#resync();
  }

  /** Re-groups digits as the user types, preserving the caret position. */
  onInput(event: Event): void {
    if (this.#composition.isComposing(event as InputEvent)) return;
    this.#reformat(false);
  }

  /** Applies the fixed-precision rounding on blur. */
  format(): void {
    this.#reformat(true);
  }

  /**
   * Parses the display value, rewrites it grouped (optionally at fixed
   * precision), keeps the caret stable by significant characters, and syncs the
   * field, the screen-reader span, and the `change` event.
   *
   * @stimeoRenderRoot
   */
  #reformat(fixedPrecision: boolean): void {
    if (!this.hasDisplayTarget) return;
    const raw = this.displayTarget.value;
    const { parts, value } = this.#scan(raw);

    if (fixedPrecision) {
      if (value === null) {
        // Blur with no digits (an abandoned sign or dot) clears the entry.
        this.displayTarget.value = "";
        this.#reflect(null, "");
        return;
      }
      const rounded = round(value, this.#precision);
      const formatted = this.#fixed.format(rounded);
      this.displayTarget.value = formatted;
      this.#reflect(rounded, formatted);
      return;
    }

    const formatted = this.#render(parts);
    if (formatted !== raw) {
      const caret = this.displayTarget.selectionStart;
      const anchor = caret === null ? null : this.#significantBefore(raw, caret);
      this.displayTarget.value = formatted;
      if (anchor !== null) this.#restoreCaret(formatted, anchor);
    }
    // The display may hold an in-progress "-", but a null value always rides
    // with an empty `formatted` so consumers can treat the pair as "cleared".
    this.#reflect(value, value === null ? "" : formatted);
  }

  /**
   * The in-progress rendering: grouped integer, sign and fraction as typed.
   *
   * @stimeoRenderRoot
   */
  #render(parts: EntryParts): string {
    const int = parts.int === "" ? "" : this.#grouping.format(BigInt(parts.int));
    const frac = parts.hasDot ? this.#decimal + parts.frac : "";
    return parts.sign + int + frac;
  }

  /** Restores the caret to sit just after the n-th significant character. */
  #restoreCaret(formatted: string, significantBefore: number): void {
    let seen = 0;
    let position = formatted.length;
    for (let i = 0; i < formatted.length; i++) {
      if (seen >= significantBefore) {
        position = i;
        break;
      }
      if (this.#isSignificant(formatted[i] as string)) seen += 1;
    }
    try {
      this.displayTarget.setSelectionRange(position, position);
    } catch {
      // Some hosts disallow selection on certain input states; the value is
      // already correct, so a failed caret restore is non-fatal.
    }
  }

  /**
   * Counts the characters before `caret` that survive into the rendering,
   * applying the same acceptance rules as {@link #scan} — a rejected keystroke
   * (a mid-string sign, a second decimal mark) must not shift the anchor.
   */
  #significantBefore(text: string, caret: number): number {
    let count = 0;
    let sawSign = false;
    let sawDigit = false;
    let sawDot = false;
    for (const ch of this.#normalize(text.slice(0, caret))) {
      if (ch >= "0" && ch <= "9") {
        count += 1;
        sawDigit = true;
      } else if ((ch === "-" || ch === "+") && !sawSign && !sawDigit && !sawDot) {
        count += 1;
        sawSign = true;
      } else if (this.#isDecimalMark(ch) && !sawDot) {
        count += 1;
        sawDot = true;
      }
    }
    return count;
  }

  /** Digits, signs, and the decimal mark anchor the caret; grouping does not. */
  #isSignificant(ch: string): boolean {
    if (ch >= "0" && ch <= "9") return true;
    if (ch === "-" || ch === "+") return true;
    return ch === this.#decimal || (ch === "." && this.#group !== ".");
  }

  /** Writes the normalized value to the field, the SR span, and the empty hook. */
  #write(value: number | null): void {
    const isEmpty = value === null;
    if (this.hasFieldTarget) this.fieldTarget.value = isEmpty ? "" : String(value);
    if (this.hasSrValueTarget) {
      this.srValueTarget.textContent = isEmpty ? "" : this.#accessible.format(value);
    }
    this.element.toggleAttribute("data-stimeo--currency-input-empty", isEmpty);
  }

  /** {@link #write}, then reports a moved value as `change` (`""` rides with `null`). */
  #reflect(value: number | null, formatted: string): void {
    this.#write(value);
    if (value !== this.#lastValue) {
      this.#lastValue = value;
      this.dispatch("change", { detail: { value, formatted } });
    }
  }

  /**
   * Scans arbitrary input text into its number-shaped parts and value. Keeps
   * digits, one leading sign, one decimal mark, and the fraction verbatim;
   * everything else (grouping, symbols, words) is dropped. An ASCII "." is only
   * a decimal mark where it is not the locale's grouping separator. Precision
   * plays no part here — rounding belongs to the blur-time format.
   */
  #scan(text: string): Scan {
    let sign: EntryParts["sign"] = "";
    let int = "";
    let hasDot = false;
    let frac = "";
    for (const ch of this.#normalize(text)) {
      if (ch >= "0" && ch <= "9") {
        if (hasDot) frac += ch;
        else int += ch;
      } else if ((ch === "-" || ch === "+") && sign === "" && int === "" && !hasDot) {
        sign = ch;
      } else if (this.#isDecimalMark(ch) && !hasDot) {
        hasDot = true;
      }
    }
    const parts: EntryParts = { sign, int, hasDot, frac };
    // `Number` accepts "12." and ".5" alike, so one dotted form covers every
    // shape — and a digit-less entry ("", "-", ".") reads as NaN, hence null.
    const value = Number(`${sign}${int}.${frac}`);
    return { parts, value: Number.isFinite(value) ? value : null };
  }

  /** Whether `ch` reads as this locale's decimal mark. */
  #isDecimalMark(ch: string): boolean {
    return ch === this.#decimal || (ch === "." && this.#group !== ".");
  }

  /** Re-syncs field / srValue / hook from the current display without dispatching. */
  #resync(): void {
    if (!this.hasDisplayTarget) return;
    this.#write(this.#scan(this.displayTarget.value).value);
  }

  /**
   * Validates the declared Values, falling back to each Value's default when a
   * declaration cannot be interpreted (a malformed locale or currency tag, a
   * precision outside `Intl`'s 0–100 integer range), and rebuilds the cached
   * formatters from the validated set.
   */
  #revalidate(): void {
    this.#locale = "en-US";
    try {
      new Intl.NumberFormat(this.localeValue);
      this.#locale = this.localeValue;
    } catch {
      // Fall through to the default locale.
    }

    const precision = this.precisionValue;
    this.#precision =
      Number.isInteger(precision) && precision >= 0 && precision <= 100 ? precision : 2;

    this.#currency = "";
    if (this.currencyValue !== "") {
      try {
        new Intl.NumberFormat(this.#locale, { style: "currency", currency: this.currencyValue });
        this.#currency = this.currencyValue;
      } catch {
        // Fall through to the plain-number accessible text.
      }
    }

    this.#grouping = new Intl.NumberFormat(this.#locale, {
      useGrouping: true,
      maximumFractionDigits: 0,
    });
    this.#fixed = new Intl.NumberFormat(this.#locale, {
      useGrouping: true,
      minimumFractionDigits: this.#precision,
      maximumFractionDigits: this.#precision,
    });
    this.#accessible = this.#currency
      ? new Intl.NumberFormat(this.#locale, { style: "currency", currency: this.#currency })
      : this.#fixed;

    const parts = new Intl.NumberFormat(this.#locale).formatToParts(11111.1);
    this.#group = parts.find((p) => p.type === "group")?.value ?? ",";
    this.#decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";

    // Locales whose default numbering system is not Latin (ar-EG, fa-IR, …)
    // format with their own digits; mapping them back keeps the controller's
    // own output re-parseable to the same value.
    this.#digits.clear();
    const digitFormatter = new Intl.NumberFormat(this.#locale, { useGrouping: false });
    for (let i = 0; i <= 9; i++) {
      const digit = digitFormatter.format(i);
      if (digit !== String(i)) this.#digits.set(digit, String(i));
    }
  }

  /**
   * Maps the locale's own digits to ASCII, folds full-width forms (the digits,
   * signs, and marks an IME confirms as ０-９＋－．，) through the shared
   * half-width mapping, and reads U+2212 MINUS SIGN as "-", which some locales'
   * formatted output uses for negatives.
   */
  #normalize(text: string): string {
    let out = "";
    for (const ch of text) {
      const mapped = this.#digits.get(ch);
      if (mapped !== undefined) {
        out += mapped;
      } else if (ch === "−") {
        out += "-";
      } else {
        out += halfWidthChar(ch);
      }
    }
    return out;
  }
}

/** Rounds `value` to `precision` decimal places, avoiding `-0`; overflow keeps `value`. */
function round(value: number, precision: number): number {
  const factor = 10 ** Math.max(0, precision);
  const rounded = Math.round(value * factor) / factor;
  if (!Number.isFinite(rounded)) return value;
  return rounded === 0 ? 0 : rounded;
}
