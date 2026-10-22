import { Controller } from "@hotwired/stimulus";
import {
  type CompositionSignal,
  CompositionTracker,
  isCompositionInputType,
} from "../utils/composition_tracker";
import { halfWidthChar } from "../utils/half_width";
import { intlFormatter } from "../utils/intl_format";
import { ListenerSet } from "../utils/listener_set";
import { resolveLocale } from "../utils/locale";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import type { NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { OwnedText } from "../utils/owned_text";

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

/** The display's text read with the separators it was written in. */
interface Reading {
  scan: Scan;
  /** The significant characters before the caret, counted with the same separators. */
  anchor: number | null;
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
 * fixed-precision rounding is applied on `blur`, never mid-entry; one asked for
 * mid-composition is applied with the text the composition confirms or leaves.
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
 * `srValue` / `display` targets are re-synced on connection; one that arrives
 * behind the target in charge is re-synced when that target leaves. Only the
 * display in charge — the first `display` target — is read: an input, blur or
 * composition in a display behind it is never taken as the user's edit.
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
 * A display already focused when first acquired or reconnected may carry a
 * composition whose start was missed. Its text and selection stay untouched,
 * including non-IME autofocus, until its `compositionend` or a non-composing
 * `input` with a non-composition `inputType`. A bare input, a direct `onInput()`
 * call, and blur alone provide no confirmation. While held, submission and the
 * accessible output retain this instance's accepted value; with no accepted value,
 * the page's hidden field and accessible text stay unchanged, even when empty.
 * Neither the draft nor the hidden field seeds the comparison baseline. Connect
 * before focusing if synchronous initialization is needed, and provide initial
 * submission and accessible values in markup when early focus is possible.
 *
 * Honest a11y note: a hidden `<input>` is not exposed to assistive tech, so the
 * normalized value is *also* published as text in the `srValue` span referenced
 * by the display's `aria-describedby` — that, not the hidden field, is what a
 * screen reader announces.
 */
export class CurrencyInputController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override targets = ["display", "field", "srValue"];
  static override values = {
    locale: { type: String, default: "" },
    currency: { type: String, default: "" },
    precision: { type: Number, default: 2 },
  };

  static valueConstraints = {
    precision: { finite: true, integer: true, min: 0, max: 100 },
  } satisfies NumberValueConstraints<typeof CurrencyInputController.values>;
  static actions = ["format", "onInput"] as const;
  static events = ["change", "reconcile"] as const;

  declare readonly displayTarget: HTMLInputElement;
  declare readonly displayTargets: HTMLInputElement[];
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
  /** A focused arrival whose text has not supplied a non-composing edit or an end. */
  #unsettled: HTMLInputElement | null = null;
  /** Formatter preparation is independent of accepting the display's text. */
  #configured = false;
  readonly #listeners = new ListenerSet();
  /**
   * Whether the declarations the page carries differ, by value, from the ones taken in,
   * as the last mid-composition pass read them. Passes read the declarations, the end
   * of a composition does not, so the language around an empty locale is read only
   * where it always is. Taking the declarations in clears it.
   */
  #declarationsHeld = false;
  /** Only live evidence can accompany this instance's held number and separators. */
  readonly #displayText = new OwnedText<HTMLInputElement>(
    `data-${this.identifier}-display-text`,
    "value",
  );
  /** The display associated with the committed value and active separators. */
  #renderedDisplay: HTMLInputElement | null = null;
  /**
   * The display rendered last, once it has left the display targets. The first
   * classification after it is back in charge, whichever entry point runs it, treats it
   * as an arrival when it shows other text than that rendering, and forgets it.
   */
  #departed: HTMLInputElement | null = null;
  /**
   * A rounding `format` asked for while a composition ran, held for that composition. Its
   * owner is the display the composition runs in: the one the tracker follows when it
   * heard the composition start (`heard`), else the display the event reporting the
   * composition came from, or the display in charge for an event with no target.
   *
   * It is applied once, by the owner's `compositionend` (confirming or cancelling), or by
   * the reading of the text the owner's composition leaves when a move or disconnect ends
   * it or the user starts composing in another display. It lapses, never applied, at any
   * other end: a `compositionend` in another display (one composition runs at a time),
   * the owner leaving the display targets with no composition the tracker follows going on
   * in it, an end with no `compositionend`, a connection, a rounding applied at once, and
   * — for one the tracker never heard start — the next start the tracker hears.
   */
  #formatHeld: { readonly display: EventTarget; readonly heard: boolean } | null = null;

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
   * The confirmed text is formatted once, and what the composition held back is
   * applied after it.
   *
   * When it ends, what is owed is read from what differs from the last rendering
   * ({@link #owed}): only the declarations are compared on each pass, by value, so a pass
   * that changed nothing can never discard a change, and a change taken back owes
   * nothing.
   *
   * Only the display in charge holds the user's confirmed text. A composition that
   * ends on a display behind it confirms nothing this controller reads: what is owed
   * is applied, and the display in charge is never reported as that user's edit.
   *
   * A composition that ends without `compositionend` confirmed nothing; what is owed
   * applies before the key, edit or blur that showed the end is handled, and waits on
   * for a composition that has started since. Text a write left in the display is the
   * page's, read with the declarations the page carries. Text the composition left in
   * place was typed against the declarations in force, so it is read as a move leaves
   * it before the change applies.
   *
   * When a composition starts before the one before it was heard ending, what that
   * one owes is read before the new draft arrives, so the new one confirms the user's
   * edit alone. Text it left in place in the display in charge was typed against the
   * declarations in force: it is read now, unless the new one goes on in that same
   * display, which carries it to its own end. Text the page wrote into the display in
   * charge is read as the page's ({@link #readPageText}).
   *
   * A rounding `format` asked for meanwhile ({@link #formatHeld}) is applied by the
   * `compositionend` itself, with the confirmed text or the text a cancel left, in
   * one reading of the display in charge — or, for a composition in a display behind
   * it, after what is owed. A move or disconnect, or a composition the user starts in
   * another display, rounds what it reads ({@link #endUntrackedComposition}); any other
   * end with no `compositionend` drops it — the user may go on typing in place, and the
   * next blur rounds.
   */
  readonly #composition = new CompositionTracker({
    onEnd: (event) => {
      const display = event.currentTarget;
      if (this.#unsettled === display) this.#unsettled = null;
      const round = this.#takeFormatHeld(display);
      if (this.#inCharge(display)) this.#reformat(round, "edit");
      if (this.#owed(display)) this.#applyValueChange();
      if (round && !this.#inCharge(display)) this.#reformat(true, "edit");
    },
    onAbandon: (display, inPlace) => {
      const next = this.#composition.composingElement();
      // What was held for the composition that ended is settled before anything is
      // reported, so a rounding asked for in response is held for the next one.
      if (inPlace && next !== null && next !== display) {
        // The user composes in another display now and will not edit this one further.
        this.#endUntrackedComposition(display);
      } else {
        this.#formatHeld = null;
      }
      if ((next === display && inPlace) || !this.#owed(display)) return;
      if (next !== null) {
        this.#readPageText(next);
        return;
      }
      if (inPlace) this.#endUntrackedComposition(display);
      if (this.#owed(display)) this.#applyValueChange();
    },
    // A start the tracker hears ends any composition it never heard start.
    onStart: (event) => {
      if (this.#unsettled === event.target) this.#unsettled = null;
      if (this.#formatHeld?.heard === false) this.#formatHeld = null;
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
   * While any display is composing, its text is the IME's: the pass reads no display
   * and takes no declaration in, so the confirmed text is read with the separators
   * it was typed against. It only notes, by value, whether the declarations moved, and
   * the end of the composition applies whatever is owed ({@link #owed}). The pass
   * restores the derived output from the last committed value in the declarations
   * still in force, without touching the composing display or caret.
   *
   * A display the user is in keeps its caret by significant characters. The
   * re-render can land right before an edit — a composition the page's write
   * ended shows only then — and the edit lands where the user put the caret.
   *
   * @stimeoRenderRoot
   */
  #applyValueChange(): void {
    // The next connect takes the declarations in before reading, or waits for the end
    // of a conversion a display moved here with.
    if (!this.#started) return;
    if (this.#holdUnsettled(false)) return;
    if (this.#composition.isComposing()) {
      this.#declarationsHeld = this.#declarationsChanged();
      this.#resync();
      return;
    }
    // With nothing to read, the next display takes the declarations in before reading.
    if (!this.hasDisplayTarget) return;
    const { scan, anchor } = this.#readDisplay();
    if (document.activeElement === this.displayTarget) {
      const formatted = this.#render(scan.parts);
      this.#showAtCaret(formatted, anchor);
      this.#reflect(scan.value, formatted, "reconcile");
    } else {
      this.#renderFixed(scan.value, "reconcile");
    }
  }

  /**
   * Reads the display and takes in the declarations the page carries now. This
   * controller's own rendering was written with the separators in force, so it
   * is read before they change; any other text is the page's, written for the
   * declarations it carries, so it is read after.
   */
  #readDisplay(): Reading {
    const text = this.displayTarget.value;
    const own = this.#showsOwnRendering(this.displayTarget) ? this.#read(text) : null;
    this.#revalidate();
    return own ?? this.#read(text);
  }

  /** Whether `display` is the one this controller rendered last and still shows that text. */
  #showsOwnRendering(display: HTMLInputElement): boolean {
    return display === this.#renderedDisplay && this.#displayText.owns(display, { source: "live" });
  }

  /**
   * Whether an event from `source` speaks for the display in charge — the first display
   * target. One with no source, such as a direct call, acts on the display in charge.
   */
  #inCharge(source: EventTarget | null): boolean {
    return source === null || (this.hasDisplayTarget && source === this.displayTarget);
  }

  /** Scans `text` and counts the caret's significant characters with the separators in force. */
  #read(text: string): Reading {
    return {
      scan: this.#scan(text),
      anchor: this.#significantBefore(text, this.displayTarget.selectionStart),
    };
  }

  readonly #morph = new MorphRenderWatcher(() => this.#applyValueChange());

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
    this.#morph.observe(this.element);
    this.#listeners.add(this.element, "turbo:before-morph-attribute", this.#protectUnsettled);
    this.#started = true;
    if (!this.#configured) this.#revalidate();
    // A display that moved here with its conversion keeps it; a change the move carried
    // in waits for the conversion's end, which reads what was typed against the
    // declarations in force before it applies.
    if (this.#composition.isComposing()) {
      this.#applyValueChange();
      return;
    }
    // The fixed-precision rendering below rounds whatever `format` asked for.
    this.#formatHeld = null;
    if (this.#holdUnsettled(true)) return;
    this.#revalidate();
    if (!this.hasDisplayTarget) return;
    if (this.#showsOwnRendering(this.displayTarget)) {
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
   * `compositionend` once they are gone, so it ends here; what it held back is
   * taken in on the next `connect()`. A display that keeps focus through the move
   * keeps its conversion for the reconnect, and its text is left alone.
   */
  override disconnect(): void {
    this.#morph.disconnect();
    this.#listeners.dispose();
    const composing = this.#composition.composingElement();
    this.#composition.disconnect();
    if (this.#composition.composingElement() !== composing) {
      this.#endUntrackedComposition(composing);
    }
    this.#started = false;
  }

  /**
   * Tracks composition on an arriving (or swapped-in) display and normalizes it
   * under the declarations the page carries now, reading this controller's own
   * rendering with the separators it was written under; an amount that differs
   * from the committed one is the page's, so it is reported as `reconcile`.
   * A display that arrives behind the one in charge is only tracked: the one
   * ahead may be composing against the declarations in force, and the arrival
   * is read when that one leaves. One that arrives in charge while a display
   * composes is a mid-composition pass: it is read once the conversion ends,
   * however it ends, because it is not the display rendered last. One moved with
   * its conversion is the one rendered last, so it owes nothing.
   *
   * One that arrives in charge already focused, with no composition the tracker
   * follows in it, may carry a composition whose start was missed, so it is held
   * instead of read: another element, or the display rendered last coming back
   * without that rendering. Its text and selection stay as they are, it is not
   * rounded, and the hidden field and the accessible text keep the committed value
   * (the page's own while none was committed); its own `compositionend`, or an
   * ordinary `input` that releases it, reads it as the user's edit, reported as
   * `change`. The display rendered last coming back with that rendering is read as
   * above. The arrival is held by whichever reading notices it first, so a declaration
   * change, a morph, `format()` or a blur that runs before this callback holds it too:
   * one that blurs before this callback keeps its rounding for its own `compositionend`.
   */
  displayTargetConnected(target: HTMLInputElement): void {
    this.#composition.observe(target);
    if (!this.#started || !this.hasDisplayTarget || this.displayTarget !== target) return;
    this.#applyValueChange();
  }

  /**
   * Stops tracking a display that leaves. A composition running on it hears no
   * `compositionend` any more, so it ends here — unless the display kept focus
   * through a move, which keeps the conversion; a change it held waits for the
   * next display to be read. A composition running on another display still hears
   * its own `compositionend`, so its text is left to it. A display that stays is
   * read again as a declaration change reads it, so an amount it holds that
   * differs from the committed one is the page's and is reported as `reconcile`;
   * one still composing is read when the conversion ends if it is no longer the
   * display rendered last, and otherwise has nothing new to read. One left in charge
   * that is focused, is not the display rendered last and has no composition the
   * tracker follows in it is held as a focused arrival is: neither read nor rounded,
   * the hidden field and the accessible text keep the committed value, and its own
   * `compositionend`, or an ordinary `input` that releases it, reads it as `change`.
   * The display rendered last that leaves is remembered until it is next classified in
   * charge, so it comes back as an arrival whichever callback reads it first. One that only
   * moved within the same mutation batch while the controller stayed connected, already
   * back in charge, is not remembered; one that leaves with the controller element is.
   */
  displayTargetDisconnected(target: HTMLInputElement): void {
    if (
      target === this.#renderedDisplay &&
      !(this.#started && this.hasDisplayTarget && this.displayTarget === target)
    ) {
      this.#departed = target;
    }
    const composing = this.#composition.composingElement() === target;
    this.#composition.unobserve(target);
    if (composing && this.#composition.composingElement() !== target) {
      this.#endUntrackedComposition(target);
    }
    // A display that leaves takes the rounding asked of it along, unless it composes on.
    if (this.#formatHeld?.display === target && this.#composition.composingElement() !== target) {
      this.#formatHeld = null;
    }
    this.#applyValueChange();
  }

  /**
   * Ends a composition no `compositionend` will reach. A display still in place —
   * one a move re-inserted, the display of a controller that moves, or one whose
   * composition the engine stopped — holds the text the composition left, typed
   * against the declarations in force, so it is read as `compositionend` would read
   * it and becomes this controller's own rendering — rounded in the same reading when
   * a blur or `format()` asked for that meanwhile, since nothing else will. Nothing
   * confirmed that text, so a value it moves is reported as `reconcile`. A display
   * that left takes its composition, and the rounding asked of it, along.
   */
  #endUntrackedComposition(display: EventTarget | null): void {
    const round = this.#takeFormatHeld(display);
    if (this.hasDisplayTarget && this.displayTarget === display) {
      this.#reformat(round, "reconcile");
    }
  }

  /** Syncs a late-arriving hidden field without touching the display or events. */
  fieldTargetConnected(): void {
    if (this.#started) this.#resync();
  }

  /** Syncs the hidden field that stays when an earlier one leaves, silently. */
  fieldTargetDisconnected(): void {
    if (this.#started) this.#resync();
  }

  /** Syncs a late-arriving screen-reader span the same way. */
  srValueTargetConnected(): void {
    if (this.#started) this.#resync();
  }

  /** Syncs the screen-reader span that stays when an earlier one leaves, silently. */
  srValueTargetDisconnected(): void {
    if (this.#started) this.#resync();
  }

  /**
   * Re-groups digits as the user types, preserving the caret position. Only an edit
   * of the display in charge is the user's: a display behind it is not read, and the
   * end of a composition its edit shows was settled before this runs. An edit the
   * event or the tracker reports as composing is the IME's draft, read when the
   * composition ends. Called without an event, it re-groups the display in charge —
   * while a composition runs, it leaves the draft and caret alone, since the end of
   * the composition re-groups what it confirms.
   */
  onInput(event?: Event): void {
    const source = event?.target ?? null;
    if (!this.#inCharge(source)) return;
    this.#holdUnsettled(false);
    if (event && this.#composition.consumesConfirmedInput(event)) return;
    const input = event as InputEvent | undefined;
    if (this.#composition.isComposing(input) || isCompositionInputType(input?.inputType)) {
      if (this.#composition.composingElement() === null && this.hasDisplayTarget) {
        this.#beginUnsettled(this.displayTarget);
      }
      return;
    }
    const unsettled = this.#unsettled !== null;
    if (unsettled) {
      if (source !== this.#unsettled || input?.isComposing !== false || !input.inputType) return;
      this.#unsettled = null;
      this.#formatHeld = null;
    }
    this.#reformat(false, "edit");
    if (unsettled && this.#owed(source)) this.#applyValueChange();
  }

  /**
   * Applies the fixed-precision rounding on blur — of the display in charge only. Called
   * without an event, it rounds the display in charge. While a composition runs — the
   * event or the tracker says so — the draft, the caret and the committed outputs stay
   * as they are, and the rounding is held: the `compositionend` that confirms or
   * cancels the composition rounds once; a move or disconnect that ends it, or a
   * composition the user starts in another display, rounds the text it leaves in the
   * same reading, reported as `reconcile`; any other end no `compositionend` reports
   * drops the rounding, and the next blur rounds. The rounding is held for the composition
   * running when it was asked, in the display that composition runs in, and never rounds
   * another one: it lapses when another display's composition ends, and goes with its
   * display when that display leaves with no composition the tracker follows going on in
   * it. A rounding applied at once spends one held for a composition only the event
   * reported.
   */
  format(event?: Event): void {
    if (!this.#inCharge(event?.target ?? null)) return;
    // The classification below forgets the display rendered last once it is back in charge.
    const returned = this.hasDisplayTarget && this.displayTarget === this.#departed;
    this.#holdUnsettled(false);
    // A blur can precede the target callback that would notice this arrival.
    if (
      this.hasDisplayTarget &&
      (this.displayTarget !== this.#renderedDisplay ||
        (returned && !this.#showsOwnRendering(this.displayTarget))) &&
      (event?.type === "blur" || event?.type === "focusout") &&
      this.#composition.composingElement() !== this.displayTarget
    ) {
      this.#beginUnsettled(this.displayTarget);
    }
    if (this.#unsettled !== null) {
      this.#formatHeld = { display: this.#unsettled, heard: false };
      return;
    }
    if (this.#composition.isComposing(event as CompositionSignal | undefined)) {
      const composing = this.#composition.composingElement();
      const display =
        composing ?? event?.target ?? (this.hasDisplayTarget ? this.displayTarget : null);
      this.#formatHeld = display === null ? null : { display, heard: composing !== null };
      if (composing === null && this.hasDisplayTarget && display === this.displayTarget) {
        this.#beginUnsettled(this.displayTarget);
      }
    } else {
      this.#formatHeld = null;
      this.#reformat(true, "edit");
    }
  }

  /** Takes the rounding held for the composition in `display`, and drops one held for another. */
  #takeFormatHeld(display: EventTarget | null): boolean {
    const held = this.#formatHeld;
    this.#formatHeld = null;
    return held !== null && held.display === display;
  }

  /**
   * Reads the page's text in the display in charge as a composition starts in it,
   * before its draft arrives: the composition before ended unheard, while every read
   * was held back, and the page wrote the text meanwhile — into a display that came
   * in charge, or into the one the user composes in again. It is read with the
   * declarations the page carries and reported as `reconcile`, without writing the
   * display, so the new composition goes on. Text still showing this controller's own
   * rendering, or a composition in a display behind, waits for that composition's end.
   */
  #readPageText(composing: EventTarget): void {
    if (
      this.#unsettled !== null ||
      !this.#inCharge(composing) ||
      this.#showsOwnRendering(this.displayTarget)
    )
      return;
    const { scan } = this.#readDisplay();
    this.#displayText.remember(this.displayTarget, this.displayTarget.value);
    this.#renderedDisplay = this.displayTarget;
    this.#reflect(scan.value, this.#render(scan.parts), "reconcile");
  }

  /**
   * Parses the display value, rewrites it grouped (optionally at fixed
   * precision), keeps the caret stable by significant characters, and syncs the
   * field, the screen-reader span, and the event `cause` selects.
   */
  #reformat(fixedPrecision: boolean, cause: Cause): void {
    if (!this.hasDisplayTarget || this.#unsettled === this.displayTarget) return;
    const raw = this.displayTarget.value;
    const { parts, value } = this.#scan(raw);

    if (fixedPrecision) {
      // Blur with no digits (an abandoned sign or dot) clears the entry.
      this.#renderFixed(value, cause);
      return;
    }

    const formatted = this.#render(parts);
    this.#showAtCaret(formatted, this.#significantBefore(raw, this.displayTarget.selectionStart));
    this.#reflect(value, formatted, cause);
  }

  /**
   * Writes `formatted` to the display as this controller's own rendering. Text
   * that moves keeps the caret just after the `anchor`-th significant character;
   * text that stays leaves the caret and any selection alone.
   */
  #showAtCaret(formatted: string, anchor: number | null): void {
    if (formatted !== this.displayTarget.value) {
      this.displayTarget.value = formatted;
      if (anchor !== null) this.#restoreCaret(formatted, anchor);
    }
    this.#displayText.remember(this.displayTarget, formatted);
    this.#renderedDisplay = this.displayTarget;
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
    this.#displayText.write(this.displayTarget, text);
    this.#renderedDisplay = this.displayTarget;
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
   * (a mid-string sign, a second decimal mark) must not shift the anchor. A host
   * that exposes no caret has no anchor.
   */
  #significantBefore(text: string, caret: number | null): number | null {
    if (caret === null) return null;
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
    const unsettled = this.#trackUnsettled(false);
    if (this.#renderedDisplay === null) return;
    const value =
      unsettled || this.#composition.isComposing()
        ? this.#lastValue
        : this.#scan(this.displayTarget.value).value;
    this.#write(value);
  }

  /**
   * Keeps an unknown focused arrival out of parsing and rendering. A known accepted
   * value can repair derived output; without one the page's output stays untouched.
   * Losing focus alone supplies no confirmation and keeps this quarantine in place.
   */
  #holdUnsettled(arriving: boolean): boolean {
    if (!this.#trackUnsettled(arriving)) return false;
    this.#declarationsHeld = this.#declarationsChanged();
    this.#resync();
    return true;
  }

  /**
   * Classifies the current owner before any entry point reads a focused arrival. The
   * display rendered last that has left and come back in charge is an arrival here,
   * once, when it shows other text than that rendering.
   */
  #trackUnsettled(arriving: boolean): boolean {
    this.#forgetUnsettledOwner();
    if (!this.hasDisplayTarget) return false;
    const display = this.displayTarget;
    const returned = display === this.#departed;
    if (returned) this.#departed = null;
    if (
      this.#unsettled === null &&
      document.activeElement === display &&
      (arriving ||
        display !== this.#renderedDisplay ||
        (returned && !this.#showsOwnRendering(display))) &&
      this.#composition.composingElement() !== display
    ) {
      this.#beginUnsettled(display);
    }
    return this.#unsettled !== null;
  }

  /** Prepares only a first unknown entry, preserving held or accepted separators. */
  #beginUnsettled(display: HTMLInputElement): void {
    if (this.#unsettled === null && this.#renderedDisplay === null && this.#declarationsChanged()) {
      this.#revalidate();
    }
    this.#unsettled = display;
  }

  /** Pending text and rounding belong to one display, never its successor. */
  #forgetUnsettledOwner(): void {
    if (
      this.#unsettled !== null &&
      this.hasDisplayTarget &&
      this.#unsettled !== this.displayTarget
    ) {
      if (this.#formatHeld?.display === this.#unsettled) this.#formatHeld = null;
      this.#unsettled = null;
    }
  }

  /** A pending entry owns its text even when its composition start was not heard. */
  readonly #protectUnsettled = (event: Event): void => {
    this.#holdUnsettled(false);
    if (this.#unsettled === null || event.target !== this.#unsettled) return;
    const detail: { readonly attributeName?: unknown } | null = (event as CustomEvent).detail;
    if (detail?.attributeName === "value") event.preventDefault();
  };

  /**
   * The declarations the page carries now, validated: each falls back to its Value's
   * default when it cannot be interpreted (a malformed locale or currency tag, a
   * precision outside `Intl`'s 0–100 integer range). An empty locale is the language
   * around the controller.
   */
  #declared(): { locale: string | undefined; currency: string; precision: number } {
    const resolved = resolveLocale(this.element, this.localeValue);
    const usable = intlFormatter(Intl.NumberFormat, resolved, {});
    const locale = usable === null ? FALLBACK_LOCALE : resolved;
    let currency = "";
    if (this.currencyValue !== "") {
      const declaredCurrency = intlFormatter(Intl.NumberFormat, locale, {
        style: "currency",
        currency: this.currencyValue,
      });
      // An unknown code falls through to the plain-number accessible text.
      if (declaredCurrency !== null) currency = this.currencyValue;
    }
    return { locale, currency, precision: this.#safePrecision };
  }

  /**
   * What the end of a composition owes: whether reading the display in charge would
   * change what the last rendering applied. It would when a pass found the declarations
   * changed, when the display in charge is not the one rendered last, or when it shows
   * other text than that rendering left — a write the page made while the composition
   * held every read back. The display `composed` in is exempt from that last check: its
   * text is the composition's, read by its end or left to the next edit. A change taken
   * back, or a display that left and came back untouched, owes nothing.
   */
  #owed(composed: EventTarget | null): boolean {
    if (this.#declarationsHeld) return true;
    if (!this.hasDisplayTarget) return false;
    const display = this.displayTarget;
    return (
      display !== this.#renderedDisplay ||
      (display !== composed && !this.#showsOwnRendering(display))
    );
  }

  /** Whether the declarations the page carries differ, by value, from the ones taken in. */
  #declarationsChanged(): boolean {
    const { locale, currency, precision } = this.#declared();
    return locale !== this.#locale || currency !== this.#currency || precision !== this.#precision;
  }

  /** Takes in the validated declarations and rebuilds the cached formatters from them. */
  #revalidate(): void {
    this.#configured = true;
    this.#declarationsHeld = false;
    const declared = this.#declared();
    this.#locale = declared.locale;
    this.#currency = declared.currency;
    this.#precision = declared.precision;

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
  /** Current `precision` declaration resolved against its numeric contract. */
  get #safePrecision(): number {
    return this.#numbers.read(
      this,
      "precision",
      this.precisionValue,
      CurrencyInputController.values.precision.default,
      CurrencyInputController.valueConstraints.precision,
    );
  }
}

/** Rounds `value` to `precision` decimal places, avoiding `-0`; overflow keeps `value`. */
function round(value: number, precision: number): number {
  const factor = 10 ** Math.max(0, precision);
  const rounded = Math.round(value * factor) / factor;
  if (!Number.isFinite(rounded)) return value;
  return rounded === 0 ? 0 : rounded;
}
