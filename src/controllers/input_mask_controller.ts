import { Controller } from "@hotwired/stimulus";
import { CompositionTracker } from "../utils/composition_tracker";
import { inheritsFieldsetDisabled } from "../utils/focus_candidate";
import { halfWidthChar } from "../utils/half_width";

/** Default placeholder tokens → single-char regex sources (user tokens merge over these). */
const DEFAULT_TOKENS: Readonly<Record<string, string>> = {
  "9": "\\d",
  a: "[A-Za-z]",
  "*": "[A-Za-z0-9]",
};

/** Attribute marking the hidden raw-value sink; its value may name the paired input's `id`. */
const UNMASK_ATTR = "data-stimeo--input-mask-unmask";

/** Which neighbour a deleting keystroke aimed at, when the platform names one. */
type Deletion = "backward" | "forward";

/** Who moved the value: the user editing the field, or the controller re-deciding it. */
type Cause = "edit" | "reconcile";

/** The outcome of applying a fixed mask to a raw string. */
export interface MaskResult {
  /** The formatted (masked) string. */
  readonly masked: string;
  /** The significant characters only (literals/separators removed). */
  readonly unmasked: string;
  /** Whether every token slot in the pattern is filled. */
  readonly complete: boolean;
  /** Per-output-char flag: true where the char fills a token (not a literal). */
  readonly tokenFlags: readonly boolean[];
}

/**
 * The form of `char` this token takes: as typed when the token accepts it, else
 * its half-width form when *that* is what the token accepts, else `null` for a
 * rejected character. Trying the character as typed first keeps a token written
 * for full-width text (or for text an IME leaves as kana) authoritative.
 */
function acceptedForm(regex: RegExp, char: string): string | null {
  if (regex.test(char)) return char;
  const half = halfWidthChar(char);
  return half !== char && regex.test(half) ? half : null;
}

/**
 * Applies a fixed mask `pattern` to `value` using `tokens` (placeholder → regex).
 * Non-matching input characters are rejected (skipped); literals are auto-inserted
 * and a typed literal that matches is consumed. A character an IME confirmed in
 * full-width form fills a token — or consumes a literal — when its half-width
 * form is the one the mask asked for, and the half-width form is what the output
 * carries. Pure and exported for direct testing.
 */
export function applyMask(
  value: string,
  pattern: string,
  tokens: ReadonlyMap<string, RegExp>,
): MaskResult {
  let masked = "";
  let unmasked = "";
  const tokenFlags: boolean[] = [];
  let valueIndex = 0;
  let totalTokens = 0;

  for (const patternChar of pattern) {
    const regex = tokens.get(patternChar);
    if (regex) totalTokens += 1;
    if (valueIndex >= value.length) continue;

    if (regex) {
      // Skip rejected characters until one fills this token (or input runs out).
      let taken: string | null = null;
      while (valueIndex < value.length) {
        taken = acceptedForm(regex, value[valueIndex] ?? "");
        if (taken !== null) break;
        valueIndex += 1;
      }
      if (taken === null) continue;
      masked += taken;
      unmasked += taken;
      tokenFlags.push(true);
      valueIndex += 1;
    } else {
      masked += patternChar;
      tokenFlags.push(false);
      // The literal is already in the output, so the typed character only has to
      // be the one that renders it — in either width.
      if (halfWidthChar(value[valueIndex] ?? "") === halfWidthChar(patternChar)) valueIndex += 1;
    }
  }

  return {
    masked,
    unmasked,
    complete: totalTokens > 0 && unmasked.length === totalTokens,
    tokenFlags,
  };
}

/**
 * The token map a `tokens` declaration selects: the defaults with the declared
 * single-char regex sources merged over. A declaration that is not a JSON object
 * of string sources falls back to the defaults, and an individual source that is
 * not a valid regex is skipped, so a broken declaration keeps the field working
 * instead of taking the mask (and every later keystroke) down with it.
 */
function compileTokens(declaration: string): Map<string, RegExp> {
  const map = new Map<string, RegExp>();
  for (const [key, source] of Object.entries({ ...DEFAULT_TOKENS, ...parseTokens(declaration) })) {
    try {
      map.set(key, new RegExp(`^(?:${source})$`));
    } catch {
      /* skip an invalid token regex rather than breaking the whole mask */
    }
  }
  return map;
}

/** The `{ token: source }` pairs a declaration holds; anything else reads as none. */
function parseTokens(declaration: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(declaration);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const tokens: Record<string, string> = {};
  for (const [key, source] of Object.entries(parsed)) {
    if (typeof source === "string") tokens[key] = source;
  }
  return tokens;
}

/** The direction an `input` event deleted in, or `null` when it is not a deletion. */
function deletionOf(event: Event | undefined): Deletion | null {
  const inputType = event instanceof InputEvent ? event.inputType : "";
  if (!inputType.startsWith("delete")) return null;
  // Word, line, and content deletions all name their direction; the ones that
  // name none (a cut, a drag-out) took a selection, so read them as backward.
  return inputType.endsWith("Forward") ? "forward" : "backward";
}

/** The offset of the `n`-th token char in a masked string, or `-1` when there is none. */
function tokenCharOffset(tokenFlags: readonly boolean[], n: number): number {
  let seen = 0;
  for (let i = 0; i < tokenFlags.length; i += 1) {
    if (!tokenFlags[i]) continue;
    seen += 1;
    if (seen === n) return i;
  }
  return -1;
}

/**
 * Headless **input mask** — formats a field in place against a fixed pattern
 * (`9`=digit, `a`=letter, `*`=alphanumeric, others literal), preserving the caret,
 * rejecting invalid characters, and syncing the raw value to a hidden field. No
 * dedicated APG pattern; Currency Input owns money-specific formatting.
 *
 * Markup contract (identifier: `stimeo--input-mask`, on the `<input>`):
 *   <input type="text" inputmode="numeric"
 *          data-controller="stimeo--input-mask"
 *          data-stimeo--input-mask-pattern-value="999-9999"
 *          data-action="input->stimeo--input-mask#format">
 *   <input type="hidden" name="zip" data-stimeo--input-mask-unmask>
 *
 * `change` and `reconcile` dispatch `{ masked, unmasked, complete }`.
 *
 * @remarks
 * Behavior only and **idempotent** — the formatted value lives only in the input and
 * the hidden field (no module-scope state), so `connect()` re-formats the existing
 * value and is stable across Turbo restore/morph. The controller sits on the
 * `<input>` itself (a void element), so the raw-value sink is not a Stimulus target;
 * it is the `[data-stimeo--input-mask-unmask]` field resolved nearest-first among
 * the associated form's own controls (an explicit pairing by the sink attribute's
 * value naming the input's `id` wins; otherwise the closest ancestor's value-less
 * sink) — when one form holds several masked inputs, wrap each input+sink pair in a
 * container or pair them by `id`.
 *
 * Formatting never steals keys: it rejects disallowed characters silently and keeps
 * the caret on insert, Backspace, and range replacement (WCAG 2.2 3.3.2 / 1.3.5;
 * the expected format is the consumer's `aria-describedby`). The caret anchors on
 * the token slots the text before it fills, so a rejected character leaves it
 * exactly where it was. Backspace and Delete always progress: when the keystroke
 * only removed literals the mask re-inserts, the significant character it aimed at
 * goes instead. Events fired mid-IME-composition are ignored; the confirmed text is
 * formatted once on `compositionend`.
 *
 * It reflects `data-mask-complete` / `data-mask-empty`, dispatches
 * `stimeo--input-mask:change` only when a user edit moves the committed value, and
 * `stimeo--input-mask:reconcile` when the controller itself decides that value —
 * a server-rendered or restored value normalized on connection, or a re-format
 * after `pattern` / `tokens` / `unmaskToHidden` changed. A malformed `tokens`
 * declaration falls back to the default tokens: it is parsed once in
 * `tokensValueChanged`, and the hot path only ever sees the validated map. A field
 * the user cannot edit (`readonly`, `disabled`, or inside a disabled `<fieldset>`)
 * keeps the value the page authored — the sink and the state hooks still follow it,
 * but the field itself is never rewritten. The composition listener is released on
 * `disconnect()`.
 */
export class InputMaskController extends Controller<HTMLInputElement> {
  static override values = {
    pattern: { type: String, default: "" },
    tokens: { type: String, default: "" },
    unmaskToHidden: { type: Boolean, default: true },
  };
  static actions = ["format"] as const;
  static events = ["change", "reconcile"] as const;

  declare patternValue: string;
  declare tokensValue: string;
  declare unmaskToHiddenValue: boolean;

  /** The value this controller last committed, and the baseline both events compare. */
  #lastValue: string | null = null;
  #started = false;

  /** Validated token map; the hot path never parses the `tokens` declaration. */
  #tokens = compileTokens("");

  /** Holds mid-composition input so the IME's uncommitted text is never rewritten. */
  readonly #composition = new CompositionTracker({ onEnd: () => this.#reformat("edit") });

  /** Re-parses the declaration and re-formats under the tokens it now selects. */
  tokensValueChanged(): void {
    this.#tokens = compileTokens(this.tokensValue);
    if (this.#started) this.#reformat("reconcile");
  }

  patternValueChanged(): void {
    if (this.#started) this.#reformat("reconcile");
  }

  /** Clears a sink it stops maintaining so a submit cannot carry a stale raw value. */
  unmaskToHiddenValueChanged(): void {
    if (!this.#started) return;
    if (!this.unmaskToHiddenValue) {
      const sink = this.#resolveSink();
      if (sink) sink.value = "";
    }
    this.#reformat("reconcile");
  }

  override connect(): void {
    this.#started = true;
    this.#composition.observe(this.element);
    // Seed the baseline from the DOM so a value that is already masked stays
    // silent, then re-format any server-rendered/restored value.
    this.#lastValue = this.element.value;
    this.#reformat("reconcile");
  }

  override disconnect(): void {
    this.#started = false;
    this.#composition.disconnect();
  }

  /** Formats the field on input, preserving the caret. Bound via `data-action`. */
  format(event?: Event): void {
    if (this.#composition.isComposing(event as InputEvent | undefined)) return;
    this.#reformat("edit", deletionOf(event));
  }

  /**
   * Core reformat: mask the current value, restore the caret, sync the sink and
   * the state hooks, and report a moved value under the event `cause` selects.
   */
  #reformat(cause: Cause, deletion: Deletion | null = null): void {
    const input = this.element;
    const raw = input.value;

    // No pattern → act as a pass-through. Without this branch `applyMask` would
    // produce an empty string and blank a misconfigured field's value; the hooks
    // still describe the field so a pattern removed at runtime cannot leave a
    // stale `data-mask-complete` behind.
    if (this.patternValue === "") {
      this.#flag("data-mask-complete", false);
      this.#flag("data-mask-empty", raw.length === 0);
      this.#lastValue = raw;
      return;
    }

    const caret = input.selectionStart ?? raw.length;
    let anchor = this.#significantBefore(raw.slice(0, caret));
    let result = applyMask(raw, this.patternValue, this.#tokens);

    // A deletion that only took literals the mask re-inserts would land back on
    // the value it started from, so that keystroke could never delete anything:
    // drop the significant character it aimed at instead.
    if (deletion !== null && result.masked === this.#lastValue) {
      const target = deletion === "backward" ? anchor : anchor + 1;
      const offset = tokenCharOffset(result.tokenFlags, target);
      if (offset >= 0) {
        anchor = target - 1;
        result = applyMask(
          result.masked.slice(0, offset) + result.masked.slice(offset + 1),
          this.patternValue,
          this.#tokens,
        );
      }
    }

    // The value of a field the user cannot edit belongs to the page: publish the
    // derived outputs against it, but never rewrite it and never report a move.
    if (input.readOnly || input.disabled || inheritsFieldsetDisabled(input)) {
      this.#publish(result, raw);
      this.#lastValue = raw;
      return;
    }

    input.value = result.masked;
    this.#restoreCaret(result.tokenFlags, anchor);
    this.#publish(result, result.masked);

    if (result.masked === this.#lastValue) return;
    this.#lastValue = result.masked;
    const detail = { masked: result.masked, unmasked: result.unmasked, complete: result.complete };
    if (cause === "edit") this.dispatch("change", { detail });
    else this.dispatch("reconcile", { detail });
  }

  /** Syncs the raw-value sink and the state hooks for the `shown` field text. */
  #publish(result: MaskResult, shown: string): void {
    if (this.unmaskToHiddenValue) {
      const sink = this.#resolveSink();
      if (sink) sink.value = result.unmasked;
    }
    this.#flag("data-mask-complete", result.complete);
    this.#flag("data-mask-empty", shown.length === 0);
  }

  /**
   * How many token slots the text before the caret fills. Masking that prefix is
   * what makes a rejected character — or a literal that also matches a token —
   * count exactly as the rendering counts it, so the caret cannot drift.
   */
  #significantBefore(prefix: string): number {
    return applyMask(prefix, this.patternValue, this.#tokens).unmasked.length;
  }

  /** Places the caret after the `n`-th token char (skipping following literals). */
  #restoreCaret(tokenFlags: readonly boolean[], n: number): void {
    let position: number;
    if (n <= 0) {
      // Sit after any leading literals, before the first token slot.
      let i = 0;
      while (i < tokenFlags.length && !tokenFlags[i]) i += 1;
      position = i;
    } else {
      const offset = tokenCharOffset(tokenFlags, n);
      if (offset < 0) {
        position = tokenFlags.length;
      } else {
        let j = offset + 1;
        while (j < tokenFlags.length && !tokenFlags[j]) j += 1;
        position = j;
      }
    }
    try {
      this.element.setSelectionRange(position, position);
    } catch {
      /* selection unsupported for this input type — value formatting still applies */
    }
  }

  /**
   * The hidden raw-value sink for this input, resolved so several masked inputs
   * can coexist in one form:
   *
   * 1. **Explicit pairing** — a sink whose attribute value names this input's
   *    `id` (`data-stimeo--input-mask-unmask="zip"`).
   * 2. **Nearest container** — otherwise, walking up from the input, the first
   *    *value-less* sink in the closest ancestor. Wrapped input+sink pairs each
   *    find their own sink, and the single form-level sink keeps working
   *    unchanged. A sink claimed by another input's id is never matched here.
   *
   * Both steps only ever consider the associated form's own controls, so a sink
   * belonging to a different form (or to none) is never written, while one the
   * `form` attribute associates from elsewhere in the document still resolves —
   * for either the input or the sink, neither of which needs to contain or be
   * contained by the form. A form-less input reads the document instead.
   */
  #resolveSink(): HTMLInputElement | null {
    const candidates = this.#sinkCandidates();
    const id = this.element.id;
    if (id.length > 0) {
      const paired = candidates.find((sink) => sink.getAttribute(UNMASK_ATTR) === id);
      if (paired) return paired;
    }

    // A bare (value-less) attribute is unclaimed, so a sink naming another
    // input's id can never be taken by this fallback.
    const free = candidates.filter((sink) => sink.getAttribute(UNMASK_ATTR) === "");
    for (let node = this.element.parentElement; node !== null; node = node.parentElement) {
      const ancestor = node;
      const sink = free.find((candidate) => ancestor.contains(candidate));
      if (sink) return sink;
    }
    return null;
  }

  /**
   * Every sink the input's form owns, in document order — one collection read per
   * resolution, so the cost tracks the form's own controls and not the depth of
   * the markup around it. `form.elements` lists controls the `form` attribute
   * associates from anywhere in the document, and lists nothing another form owns.
   */
  #sinkCandidates(): HTMLInputElement[] {
    const form = this.element.form;
    if (form === null) {
      return Array.from(document.querySelectorAll<HTMLInputElement>(`input[${UNMASK_ATTR}]`));
    }
    return Array.from(form.elements).filter(
      (element): element is HTMLInputElement =>
        element instanceof HTMLInputElement && element.hasAttribute(UNMASK_ATTR),
    );
  }

  /** Sets a boolean `data-*` flag to `"true"` when `on`, else removes it. */
  #flag(name: string, on: boolean): void {
    if (on) this.element.setAttribute(name, "true");
    else this.element.removeAttribute(name);
  }
}
