import { Controller } from "@hotwired/stimulus";

/** Default placeholder tokens → single-char regex sources (user tokens merge over these). */
const DEFAULT_TOKENS: Readonly<Record<string, string>> = {
  "9": "\\d",
  a: "[A-Za-z]",
  "*": "[A-Za-z0-9]",
};

/** Attribute marking the hidden raw-value sink; its value may name the paired input's `id`. */
const UNMASK_ATTR = "data-stimeo--input-mask-unmask";

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
 * Applies a fixed mask `pattern` to `value` using `tokens` (placeholder → regex).
 * Non-matching input characters are rejected (skipped); literals are auto-inserted
 * and a typed literal that matches is consumed. Pure and exported for direct testing.
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
      // Skip rejected characters until one matches this token (or input runs out).
      while (valueIndex < value.length && !regex.test(value[valueIndex] ?? "")) valueIndex += 1;
      const char = value[valueIndex];
      if (char === undefined) continue;
      masked += char;
      unmasked += char;
      tokenFlags.push(true);
      valueIndex += 1;
    } else {
      masked += patternChar;
      tokenFlags.push(false);
      if (value[valueIndex] === patternChar) valueIndex += 1;
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
 * @remarks
 * Behavior only and **idempotent** — the formatted value lives only in the input and
 * the hidden field (no module-scope state), so `connect()` re-formats the existing
 * value and is stable across Turbo restore/morph. The controller sits on the
 * `<input>` itself (a void element), so the raw-value sink is not a Stimulus target;
 * it is the `[data-stimeo--input-mask-unmask]` field resolved nearest-first within
 * the same form (an explicit pairing by the sink attribute's value naming the
 * input's `id` wins; otherwise the closest ancestor's value-less sink) — when one
 * form holds several masked inputs, wrap each input+sink pair in a container or
 * pair them by `id`. Formatting never steals keys: it rejects disallowed characters
 * silently and keeps the caret on insert, Backspace, and range replacement
 * (WCAG 2.2 3.3.2 / 1.3.5; the expected format is the consumer's `aria-describedby`).
 * It reflects `data-mask-complete` / `data-mask-empty` and dispatches
 * `stimeo--input-mask:change` only when the value actually changes.
 */
export class InputMaskController extends Controller<HTMLInputElement> {
  static override values = {
    pattern: { type: String, default: "" },
    tokens: { type: Object, default: {} },
    unmaskToHidden: { type: Boolean, default: true },
  };
  static actions = ["format"] as const;
  static events = ["change"] as const;

  declare patternValue: string;
  declare tokensValue: Record<string, string>;
  declare unmaskToHiddenValue: boolean;

  override connect(): void {
    // Re-format any server-rendered/restored value so the field is consistent.
    this.#apply();
  }

  /** Formats the field on input, preserving the caret. Bound via `data-action`. */
  format(): void {
    this.#apply();
  }

  /** Core reformat: mask the current value, restore the caret, sync, and announce. */
  #apply(): void {
    // No pattern → act as a pass-through. Without this guard `applyMask` would
    // produce an empty string and blank a misconfigured field's value.
    if (!this.patternValue) return;

    const input = this.element;
    const previous = input.value;
    const caret = input.selectionStart ?? previous.length;
    const tokens = this.#tokenRegexes();

    const significant = this.#countSignificant(previous.slice(0, caret), tokens);
    const result = applyMask(previous, this.patternValue, tokens);

    input.value = result.masked;
    this.#restoreCaret(input, result.tokenFlags, significant);

    if (this.unmaskToHiddenValue) {
      const unmask = this.#unmaskField();
      if (unmask) unmask.value = result.unmasked;
    }
    this.#flag("data-mask-complete", result.complete);
    this.#flag("data-mask-empty", result.masked.length === 0);

    if (result.masked !== previous) {
      this.dispatch("change", {
        detail: { masked: result.masked, unmasked: result.unmasked, complete: result.complete },
      });
    }
  }

  /** Places the caret after the `n`-th token char (skipping following literals). */
  #restoreCaret(input: HTMLInputElement, tokenFlags: readonly boolean[], n: number): void {
    let position: number;
    if (n <= 0) {
      // Sit after any leading literals, before the first token slot.
      let i = 0;
      while (i < tokenFlags.length && !tokenFlags[i]) i += 1;
      position = i;
    } else {
      let seen = 0;
      position = tokenFlags.length;
      for (let i = 0; i < tokenFlags.length; i += 1) {
        if (!tokenFlags[i]) continue;
        seen += 1;
        if (seen === n) {
          let j = i + 1;
          while (j < tokenFlags.length && !tokenFlags[j]) j += 1;
          position = j;
          break;
        }
      }
    }
    try {
      input.setSelectionRange(position, position);
    } catch {
      /* selection unsupported for this input type — value formatting still applies */
    }
  }

  /**
   * The hidden raw-value sink for this input, resolved so several masked inputs
   * can coexist in one form:
   *
   * 1. **Explicit pairing** — a sink whose attribute value names this input's
   *    `id` (`data-stimeo--input-mask-unmask="zip"`), looked up across the form
   *    (or the document when the input is form-less).
   * 2. **Nearest container** — otherwise, walking up from the input (stopping at
   *    the form boundary), the first *value-less* sink in the closest ancestor.
   *    Wrapped input+sink pairs each find their own sink, and the single
   *    form-level sink keeps working unchanged. A sink claimed by another
   *    input's id is never matched here.
   */
  #unmaskField(): HTMLInputElement | null {
    // Runs on every keystroke (via format → #apply), so each step is a single
    // engine-side `querySelector` scoped to `input` — no candidate loops in JS.
    const id = this.element.id;
    if (id.length > 0) {
      const scope: ParentNode = this.element.form ?? document;
      // Escape `"` / `\` so an authored id cannot break out of the quoted selector.
      const quoted = id.replace(/["\\]/g, "\\$&");
      const paired = scope.querySelector<HTMLInputElement>(`input[${UNMASK_ATTR}="${quoted}"]`);
      if (paired) return paired;
    }
    // `[attr=""]` matches bare (value-less) attributes, so a sink naming another
    // input's id can never be claimed by this fallback.
    for (let node = this.element.parentElement; node !== null; node = node.parentElement) {
      const sink = node.querySelector<HTMLInputElement>(`input[${UNMASK_ATTR}=""]`);
      if (sink) return sink;
      if (node === this.element.form) break;
    }
    return null;
  }

  /** Counts characters in `text` that fill any token (the caret-significant chars). */
  #countSignificant(text: string, tokens: ReadonlyMap<string, RegExp>): number {
    let count = 0;
    for (const char of text) {
      for (const regex of tokens.values()) {
        if (regex.test(char)) {
          count += 1;
          break;
        }
      }
    }
    return count;
  }

  /** Compiles the effective token map (defaults with the user `tokens` merged over). */
  #tokenRegexes(): Map<string, RegExp> {
    const map = new Map<string, RegExp>();
    for (const [key, source] of Object.entries({ ...DEFAULT_TOKENS, ...this.tokensValue })) {
      try {
        map.set(key, new RegExp(`^(?:${source})$`));
      } catch {
        /* skip an invalid token regex rather than breaking the whole mask */
      }
    }
    return map;
  }

  /** Sets a boolean `data-*` flag to `"true"` when `on`, else removes it. */
  #flag(name: string, on: boolean): void {
    if (on) this.element.setAttribute(name, "true");
    else this.element.removeAttribute(name);
  }
}
