import { Controller } from "@hotwired/stimulus";
import { CompositionTracker } from "../utils/composition_tracker";
import { halfWidthChar } from "../utils/half_width";
import { intlFormatter } from "../utils/intl_format";
import { resolveLocale } from "../utils/locale";

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

/** Who moved the value: the user editing the display, or the page. */
type Cause = "edit" | "reconcile";

/**
 * The locale a declaration falls back to when `Intl` rejects it, so a broken tag
 * still leaves a field that formats and parses the same way every time.
 */
const FALLBACK_LOCALE = "en-US";

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
 * `change` and `reconcile` dispatch `{ value: number | null, formatted: string }`
 * — `null` (with an empty `formatted`) when the amount is cleared, so consumers
 * hear every transition of the numeric value, including back to empty. `change`
 * is the user's edit: typing, or the rounding applied on `blur`. `reconcile` is a
 * value the page moved: a `locale`, `currency` or `precision` change that
 * re-rounds the committed amount, a display target swapped in holding another
 * amount, a reconnect that rounds an entry left unrounded mid-typing, or a move
 * that ends a composition before its `compositionend`. Connecting over a
 * server-rendered value reports neither.
 *
 * @remarks
 * Behavior only — no styling, no validation (range/required belong to the
 * consumer or `stimeo--form-field`). The display field is the sole Tab stop and keeps its
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
 * ignored; the confirmed text is formatted once on `compositionend`. A
 * `locale` / `currency` / `precision` change that arrives mid-composition
 * leaves the uncommitted text alone and applies right after that confirmed
 * text has been read. A composition this controller stops hearing — its display
 * leaves, or the controller disconnects, before `compositionend` — ends there:
 * a display still in place is read as `compositionend` would read it, and a
 * value that moves is reported as `reconcile`. A field or screen-reader span
 * arriving mid-composition takes the committed value.
 *
 * Display text is read with the declarations it was written for. This
 * controller's own rendering was written with the separators in force, so a
 * declaration change reads it before they change. Any other text is the page's
 * — a display swapped in, or text written into the display alongside a
 * declaration change — written for the declarations the page carries, so it is
 * read with those.
 *
 * With no `locale` declared the field formats in the nearest `lang` up the
 * ancestor chain, else in the runtime default. A malformed `locale` falls back
 * to `en-US`, and a malformed `currency` or `precision` to that Value's default,
 * instead of throwing. The declarations, the nearest `lang` among them, are
 * read and validated before a display is read after they may have moved — on a
 * Value change, when the controller connects, and when a display arrives; the
 * hot path only ever sees validated values through cached `Intl.NumberFormat`
 * instances, never built per keystroke. Late-arriving or swapped `field` /
 * `srValue` / `display` targets are re-synced on connection.
 *
 * Reconnecting starts from the committed value: a display still showing this
 * controller's own rendering is not read back but re-rendered from that value
 * under the current declarations, so a `locale` changed while the element was
 * away never re-reads its separators. The re-render is the fixed-precision
 * form, so it rounds whenever the value has more places than the current
 * `precision` allows — because `precision` changed while the element was away,
 * or because the entry was left unrounded mid-typing (`1.555` becomes `1.56`) —
 * and a value it moves is reported as `reconcile`. The composition listeners
 * are released on `disconnect()`.
 *
 * Honest a11y note: a hidden `<input>` is not exposed to assistive tech, so the
 * normalized value is *also* published as text in the `srValue` span referenced
 * by the display's `aria-describedby` — that, not the hidden field, is what a
 * screen reader announces.
 */
export class CurrencyInputController extends Controller<HTMLElement> {
  static override targets = ["display", "field", "srValue"];
  static override values = {
    locale: { type: String, default: "" },
    currency: { type: String, default: "" },
    precision: { type: Number, default: 2 },
  };
  static actions = ["format", "onInput"] as const;
  static events = ["change", "reconcile"] as const;

  declare readonly displayTarget: HTMLInputElement;
  declare readonly fieldTarget: HTMLInputElement;
  declare readonly srValueTarget: HTMLElement;
  declare readonly hasDisplayTarget: boolean;
  declare readonly hasFieldTarget: boolean;
  declare readonly hasSrValueTarget: boolean;
  declare localeValue: string;
  declare currencyValue: string;
  declare precisionValue: number;

  /** The numeric value last committed; both events report only a move away from it. */
  #lastValue: number | null = null;
  #started = false;
  /** A declaration change that arrived mid-composition, applied once nothing composes. */
  #changeHeld = false;
  /** The display a composition is running on, until that composition ends. */
  #composing: EventTarget | null = null;
  /**
   * The display text this controller last rendered. It tells this controller's own
   * text, written with the separators in force, from text the page wrote.
   */
  #rendered: string | null = null;

  /** Validated mirrors of the Values; the hot path never reads a raw Value. */
  #locale: string | undefined;
  #currency = "";
  #precision = 2;

  /** Formatters rebuilt when the declarations are taken in, never per keystroke. */
  #grouping!: Intl.NumberFormat;
  #fixed!: Intl.NumberFormat;
  #accessible!: Intl.NumberFormat;
  #group = ",";
  #decimal = ".";
  /** The locale's non-Latin digits mapped back to ASCII (empty for Latin locales). */
  readonly #digits = new Map<string, string>();

  /**
   * Holds mid-composition input so the IME's uncommitted text is never rewritten.
   * The confirmed text is formatted once, and a declaration change the composition
   * held back is applied after it.
   */
  readonly #composition = new CompositionTracker({
    onStart: (event) => {
      this.#composing = event.currentTarget;
    },
    onEnd: () => {
      this.#composing = null;
      this.#reformat(false, "edit");
      this.#applyHeldChange();
    },
  });

  /**
   * Re-validates on declaration changes and re-renders the committed display,
   * reporting a value the re-render moved as `reconcile`.
   */
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
   * Reads the display with the declarations its text was written for, then
   * re-renders it under the new ones — so a locale switch re-interprets the
   * value, never the old text with new separators, and text the page wrote for
   * the declarations it changes is never read with the old ones.
   *
   * While the display is composing, its text is the IME's: the change is held,
   * configuration and all, until the composition ends, so the confirmed text is
   * read with the separators it was typed against before the change applies.
   *
   * @stimeoRenderRoot
   */
  #applyValueChange(): void {
    if (this.#composition.isComposing()) {
      this.#changeHeld = true;
      return;
    }
    // With nothing to read, the next display or the next connect takes the
    // declarations in before reading.
    if (!this.#started || !this.hasDisplayTarget) return;
    const scan = this.#readDisplay();
    if (document.activeElement === this.displayTarget) {
      const formatted = this.#render(scan.parts);
      this.#show(formatted);
      this.#reflect(scan.value, formatted, "reconcile");
    } else {
      this.#renderFixed(scan.value, "reconcile");
    }
  }

  /** Applies a declaration change a composition held back. */
  #applyHeldChange(): void {
    if (!this.#changeHeld) return;
    this.#changeHeld = false;
    this.#applyValueChange();
  }

  /**
   * Reads the display and takes in the declarations the page carries now. This
   * controller's own rendering was written with the separators in force, so it
   * is read before they change; any other text is the page's, written for the
   * declarations it carries, so it is read after.
   */
  #readDisplay(): Scan {
    const text = this.displayTarget.value;
    const own = text === this.#rendered ? this.#scan(text) : null;
    this.#takeInDeclarations();
    return own ?? this.#scan(text);
  }

  /** Takes in the declarations the page carries now, a change a composition held among them. */
  #takeInDeclarations(): void {
    this.#changeHeld = false;
    this.#revalidate();
  }

  /**
   * Takes in the declarations the page carries now and normalizes the display
   * to its fixed-precision form.
   *
   * A display still showing this controller's own last rendering is not read
   * back: its separators may belong to declarations that changed while the
   * controller was away, and the committed value is known anyway. That value is
   * re-rendered at the current fixed precision, which rounds it whether
   * `precision` changed meanwhile or the entry was left unrounded mid-typing, and
   * a move the rounding causes is reported as `reconcile`. Any other text is the
   * page's, written for the declarations it carries, so it is read with them.
   */
  override connect(): void {
    this.#started = true;
    this.#takeInDeclarations();
    if (!this.hasDisplayTarget) return;
    if (this.displayTarget.value === this.#rendered) {
      this.#renderFixed(this.#lastValue, "reconcile");
      return;
    }
    // Seed the baseline with the *rounded* initial value: the idempotent
    // connect-time reformat describes the value the page rendered, so it
    // reports nothing.
    const { value } = this.#scan(this.displayTarget.value);
    this.#lastValue = value === null ? null : round(value, this.#precision);
    this.#renderFixed(value, "reconcile");
  }

  /**
   * Releases the composition listeners. A composition still running hears no
   * `compositionend` once they are gone, so it ends here; a change it held is
   * taken in on the next `connect()`.
   */
  override disconnect(): void {
    this.#endUntrackedComposition();
    this.#composition.disconnect();
    this.#started = false;
  }

  /**
   * Tracks composition on an arriving (or swapped-in) display and normalizes it
   * under the declarations the page carries now, reading this controller's own
   * rendering with the separators it was written under; an amount that differs
   * from the committed one is the page's, so it is reported as `reconcile`.
   */
  displayTargetConnected(target: HTMLInputElement): void {
    this.#composition.observe(target);
    if (!this.#started) return;
    this.#renderFixed(this.#readDisplay().value, "reconcile");
  }

  /**
   * Stops tracking a display that leaves. A composition running on it hears no
   * `compositionend` any more, so it ends here; a change it held waits for the
   * next display to be read.
   */
  displayTargetDisconnected(target: HTMLInputElement): void {
    this.#composition.unobserve(target);
    this.#endUntrackedComposition();
  }

  /**
   * Ends a composition no `compositionend` will reach. A display still in place —
   * one a move re-inserted, or the display of a controller that moves — holds the
   * text the composition left, typed against the declarations in force, so it is
   * read as `compositionend` would read it and becomes this controller's own
   * rendering. The page's move ended the composition, so a value it moves is
   * reported as `reconcile`. A display that left takes its composition along.
   */
  #endUntrackedComposition(): void {
    const display = this.#composing;
    this.#composing = null;
    if (this.hasDisplayTarget && this.displayTarget === display) {
      this.#reformat(false, "reconcile");
    }
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
    this.#reformat(false, "edit");
  }

  /** Applies the fixed-precision rounding on blur. */
  format(): void {
    this.#reformat(true, "edit");
  }

  /**
   * Parses the display value, rewrites it grouped (optionally at fixed
   * precision), keeps the caret stable by significant characters, and syncs the
   * field, the screen-reader span, and the event `cause` selects.
   */
  #reformat(fixedPrecision: boolean, cause: Cause): void {
    if (!this.hasDisplayTarget) return;
    const raw = this.displayTarget.value;
    const { parts, value } = this.#scan(raw);

    if (fixedPrecision) {
      // Blur with no digits (an abandoned sign or dot) clears the entry.
      this.#renderFixed(value, cause);
      return;
    }

    const formatted = this.#render(parts);
    if (formatted !== raw) {
      const caret = this.displayTarget.selectionStart;
      const anchor = caret === null ? null : this.#significantBefore(raw, caret);
      this.displayTarget.value = formatted;
      if (anchor !== null) this.#restoreCaret(formatted, anchor);
    }
    this.#rendered = formatted;
    this.#reflect(value, formatted, cause);
  }

  /**
   * Shows `value` at the fixed precision — an empty display for no value — and
   * reports a move under the event `cause` selects.
   */
  #renderFixed(value: number | null, cause: Cause): void {
    if (value === null) {
      this.#show("");
      this.#reflect(null, "", cause);
      return;
    }
    const rounded = round(value, this.#precision);
    const formatted = this.#fixed.format(rounded);
    this.#show(formatted);
    this.#reflect(rounded, formatted, cause);
  }

  /** Writes `text` to the display as this controller's own rendering. */
  #show(text: string): void {
    this.displayTarget.value = text;
    this.#rendered = text;
  }

  /**
   * The in-progress rendering: grouped integer, sign and fraction as typed.
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
    this.element.toggleAttribute(`data-${this.identifier}-empty`, isEmpty);
  }

  /**
   * {@link #write}, then reports a moved value under the event `cause` selects:
   * `change` for the user's edit, `reconcile` for a move the page caused. The
   * display may hold an in-progress `-`, but a `null` value always rides with an
   * empty `formatted`, whichever event reports it, so consumers can treat the
   * pair as cleared.
   */
  #reflect(value: number | null, formatted: string, cause: Cause): void {
    this.#write(value);
    if (value === this.#lastValue) return;
    this.#lastValue = value;
    const detail = { value, formatted: value === null ? "" : formatted };
    if (cause === "edit") this.dispatch("change", { detail });
    else this.dispatch("reconcile", { detail });
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

  /**
   * Re-syncs field / srValue / hook without dispatching: from the display, or —
   * while it is composing, when its text is not committed yet — from the value
   * last committed.
   */
  #resync(): void {
    if (!this.hasDisplayTarget) return;
    const value = this.#composition.isComposing()
      ? this.#lastValue
      : this.#scan(this.displayTarget.value).value;
    this.#write(value);
  }

  /**
   * Validates the declared Values, falling back to each Value's default when a
   * declaration cannot be interpreted (a malformed locale or currency tag, a
   * precision outside `Intl`'s 0–100 integer range), and rebuilds the cached
   * formatters from the validated set.
   */
  #revalidate(): void {
    const resolved = resolveLocale(this.element, this.localeValue);
    const usable = intlFormatter(Intl.NumberFormat, resolved, {});
    this.#locale = usable === null ? FALLBACK_LOCALE : resolved;

    const precision = this.precisionValue;
    this.#precision =
      Number.isInteger(precision) && precision >= 0 && precision <= 100 ? precision : 2;

    this.#currency = "";
    if (this.currencyValue !== "") {
      const declaredCurrency = intlFormatter(Intl.NumberFormat, this.#locale, {
        style: "currency",
        currency: this.currencyValue,
      });
      // An unknown code falls through to the plain-number accessible text.
      if (declaredCurrency !== null) this.#currency = this.currencyValue;
    }

    this.#grouping = intlFormatter(
      Intl.NumberFormat,
      this.#locale,
      { useGrouping: true, maximumFractionDigits: 0 },
      FALLBACK_LOCALE,
    );
    this.#fixed = intlFormatter(
      Intl.NumberFormat,
      this.#locale,
      {
        useGrouping: true,
        minimumFractionDigits: this.#precision,
        maximumFractionDigits: this.#precision,
      },
      FALLBACK_LOCALE,
    );
    this.#accessible = this.#currency
      ? intlFormatter(
          Intl.NumberFormat,
          this.#locale,
          { style: "currency", currency: this.#currency },
          FALLBACK_LOCALE,
        )
      : this.#fixed;

    const parts = intlFormatter(Intl.NumberFormat, this.#locale, {}, FALLBACK_LOCALE).formatToParts(
      11111.1,
    );
    this.#group = parts.find((p) => p.type === "group")?.value ?? ",";
    this.#decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";

    // Locales whose default numbering system is not Latin (ar-EG, fa-IR, …)
    // format with their own digits; mapping them back keeps the controller's
    // own output re-parseable to the same value.
    this.#digits.clear();
    const digitFormatter = intlFormatter(
      Intl.NumberFormat,
      this.#locale,
      { useGrouping: false },
      FALLBACK_LOCALE,
    );
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
