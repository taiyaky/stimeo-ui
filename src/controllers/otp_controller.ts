import { Controller } from "@hotwired/stimulus";
import { ensureId } from "../utils/aria_ids";
import { isReservedArrowChord, logicalArrowKey } from "../utils/arrow_step";
import { AttributeLease } from "../utils/attribute_lease";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { CompositionTracker } from "../utils/composition_tracker";
import { toHalfWidth } from "../utils/half_width";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";

/** Single-character pattern used when a `pattern` declaration cannot compile. */
const DEFAULT_PATTERN = "[0-9]";

/** Compiles one anchored single-character matcher, or `null` for a broken source. */
function compilePattern(source: string): RegExp | null {
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return null;
  }
}

/** Whether a press carries a modifier, which makes it the document's to handle. */
function hasModifier(event: KeyboardEvent): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

/**
 * Headless, accessible One-Time Password / PIN input logic.
 *
 * Markup contract (identifier: `stimeo--otp`):
 *   <div data-controller="stimeo--otp"
 *        data-stimeo--otp-pattern-value="[0-9]"
 *        role="group" aria-label="One-time passcode">
 *     <input data-stimeo--otp-target="field" inputmode="numeric" maxlength="1"
 *            autocomplete="one-time-code" aria-label="Digit 1"
 *            data-action="input->stimeo--otp#onInput
 *                         keydown->stimeo--otp#onKeydown
 *                         paste->stimeo--otp#onPaste
 *                         pointerdown->stimeo--otp#onPointerDown" />
 *     <!-- repeat one field per digit -->
 *     <p data-stimeo--otp-target="error" hidden>Digits only.</p>
 *     <input type="hidden" data-stimeo--otp-target="value" name="otp" />
 *   </div>
 *
 * The passcode length is the number of connected `field` targets, so nothing has
 * to declare it twice and fields added or removed at runtime are absorbed.
 *
 * Entry rules:
 * - Text carrying more than one accepted character — an OS `one-time-code`
 *   autofill, a password manager, an IME committing several digits, a paste —
 *   is spread across the following writable fields from the entry point.
 * - `disabled` and `readonly` fields keep their value: they are never written
 *   and never receive auto-advance focus, matching what the platform allows a
 *   user to do by hand.
 * - Input that lands nowhere rolls the field back to the digit it last
 *   committed, and is the only thing that reports `invalid` or reveals the
 *   `error` target. Discarding a separator inside otherwise usable text
 *   (`"1234-56"`) is a successful entry.
 * - Pointing at an empty field ahead of an earlier empty one lands on the
 *   earliest empty field instead, so a passcode fills in order. Keyboard focus
 *   is never redirected.
 *
 * `change` and `complete` dispatch `{ value: string }` and fire only when the
 * combined value actually moves — one confirmed IME character emits one event,
 * and a passcode re-completed with a different digit reports the new value.
 * A value moved by adding or removing fields is the page's doing rather than an
 * edit, so it is reported as `reconcile` with the same `{ value: string }`.
 * `invalid` dispatches `{ pattern: string }` carrying the compiled pattern.
 *
 * Controller-owned output: `data-filled` on each entered field, `data-state`
 * (`empty` / `partial` / `complete`) on the root, and — while input is being
 * reported invalid — `aria-invalid`, `aria-errormessage`, `aria-describedby`,
 * and the `error` target's `hidden`. Those four are leased, so authored values
 * return on teardown and before the page is cached.
 *
 * @remarks
 * Behavior only. `connect()` reads the fields back as the source of truth, which
 * is what restores consistency after a `type="password"` field returns from the
 * Turbo cache emptied, or after a native form reset. A `pattern` that cannot
 * compile falls back to `[0-9]`; the compiled matcher is built once per
 * declaration rather than per keystroke.
 */
export class OtpController extends Controller<HTMLElement> {
  static override targets = ["field", "value", "error"];
  static override values = {
    pattern: { type: String, default: DEFAULT_PATTERN },
  };
  static actions = ["onInput", "onKeydown", "onPaste", "onPointerDown", "clear"] as const;
  static events = ["change", "complete", "invalid", "reconcile"] as const;

  declare readonly fieldTargets: HTMLInputElement[];
  declare readonly valueTarget: HTMLInputElement;
  declare readonly errorTarget: HTMLElement;
  declare readonly hasValueTarget: boolean;
  declare readonly hasErrorTarget: boolean;

  declare patternValue: string;

  /** Validated matcher; the hot path never compiles a raw declaration. */
  #pattern = new RegExp(`^${DEFAULT_PATTERN}$`);
  /** Source of {@link #pattern}, reported in `invalid` so consumers can word it. */
  #patternSource = DEFAULT_PATTERN;
  /** Combined value carried by the last dispatch; keeps a no-op sync silent. */
  #lastValue: string | null = null;
  /** Field whose confirming `input` after `compositionend` is already handled. */
  #confirmedField: HTMLInputElement | null = null;
  /** True between connect and disconnect, so pre-connect Value changes stay silent. */
  #connected = false;
  /** Digit each field last committed, restored when rejected input replaced it. */
  readonly #committed = new WeakMap<HTMLInputElement, string>();

  /** Collapses one batch of field target callbacks into a single reconciliation. */
  readonly #reconcile = new MicrotaskCoalescer(() => this.#reconcileFields());

  readonly #ariaInvalid = new AttributeLease<HTMLInputElement>("aria-invalid");
  readonly #ariaErrorMessage = new AttributeLease<HTMLInputElement>("aria-errormessage");
  readonly #ariaDescribedBy = new AttributeLease<HTMLInputElement>("aria-describedby");
  readonly #errorHidden = new AttributeLease<HTMLElement>("hidden");
  readonly #state = new AttributeLease<HTMLElement>("data-state");

  /** Rewinds the transient error surface before Turbo freezes the page. */
  readonly #beforeCache = new BeforeCacheReset(() => this.#clearError());

  /** Owns IME lifecycle state across every digit field. */
  readonly #composition = new CompositionTracker({
    onStart: () => {
      this.#confirmedField = null;
    },
    onEnd: (event) => {
      const input = this.#fieldFrom(event);
      if (!input) return;
      // The browser follows a commit with one more `input` carrying the same
      // text; marking the field lets that echo be dropped instead of rerun.
      this.#confirmedField = input;
      // `maxlength` has already cut the field down to one character, but the
      // commit itself carries the whole confirmed string — so a conversion that
      // ends in several characters still reaches the fields after this one.
      const committed = (event as CompositionEvent).data ?? "";
      this.#accept(input, committed.length > input.value.length ? committed : input.value);
    },
  });

  override connect(): void {
    this.#connected = true;
    for (const field of this.fieldTargets) this.#bind(field);
    document.addEventListener("reset", this.#onReset, true);
    this.#beforeCache.activate();
    this.#reconcile.activate();
    this.#adopt();
    this.#lastValue = this.#sync();
  }

  override disconnect(): void {
    this.#connected = false;
    for (const field of this.fieldTargets) this.#unbind(field);
    this.#composition.disconnect();
    document.removeEventListener("reset", this.#onReset, true);
    this.#beforeCache.deactivate();
    this.#reconcile.cancel();
    this.#clearError();
    this.#state.return(this.element);
  }

  /**
   * Stimulus lifecycle callback when a new field target enters the DOM.
   * Wires the new field and folds the wider digit count into one reconciliation,
   * which stays inert until `connect()` opens the window.
   */
  fieldTargetConnected(element: HTMLInputElement): void {
    this.#bind(element);
    this.#adoptField(element);
    this.#reconcile.schedule();
  }

  /** Releases a dropped field's listeners and leases, then reconciles the rest. */
  fieldTargetDisconnected(element: HTMLInputElement): void {
    this.#unbind(element);
    this.#returnFieldLeases(element);
    this.#reconcile.schedule();
  }

  /**
   * Re-validates a changed `pattern` declaration once and drops any entered digit
   * the new pattern no longer accepts, so the combined value stays interpretable.
   */
  patternValueChanged(): void {
    const compiled = compilePattern(this.patternValue);
    this.#patternSource = compiled ? this.patternValue : DEFAULT_PATTERN;
    this.#pattern = compiled ?? new RegExp(`^${DEFAULT_PATTERN}$`);
    if (!this.#connected) return;

    let dropped = false;
    for (const field of this.fieldTargets) {
      if (field.value === "" || !this.#isWritable(field)) continue;
      if (this.#pattern.test(field.value)) continue;
      this.#writeField(field, "");
      dropped = true;
    }
    if (dropped) this.#syncAndDispatch();
  }

  /** Handles keystroke inputs, distributes autofilled text, and advances focus. */
  onInput(event: Event): void {
    const input = this.#fieldFrom(event);
    if (!input) return;

    const confirmed = this.#confirmedField;
    this.#confirmedField = null;
    if (confirmed === input) return;

    // Guard during active composition to prevent premature focus switching
    if (this.#composition.isComposing(event as InputEvent)) return;

    this.#accept(input);
  }

  /** Handles Backspace clearing, arrows, and home/end navigation. */
  onKeydown(event: KeyboardEvent): void {
    if (isReservedArrowChord(event)) return;
    const input = this.#fieldFrom(event);
    if (!input) return;

    // A keyed edit always starts with this event, so no post-commit echo is pending
    this.#confirmedField = null;
    // Do not trigger keydown actions during composition
    if (this.#composition.isComposing(event)) return;

    const index = this.fieldTargets.indexOf(input);
    const fields = this.fieldTargets;
    // Logical, not physical. The key is normalised rather than the
    // delta negated: these two branches are not mirror images — their bounds
    // guards differ — so swapping the key keeps each guard with its own direction.

    switch (logicalArrowKey(event.key, this.element)) {
      case "Backspace":
        if (hasModifier(event)) break;
        if (input.value && this.#isWritable(input)) {
          // Filled field: clear it where it stands
          event.preventDefault();
          this.#writeField(input, "");
          this.#clearError();
          this.#syncAndDispatch();
        } else {
          // Empty field: step back to the previous writable digit and wipe it
          const previous = this.#writableBefore(index);
          if (previous) {
            event.preventDefault();
            this.#writeField(previous, "");
            previous.focus();
            this.#clearError();
            this.#syncAndDispatch();
          }
        }
        break;

      case "ArrowLeft": {
        const previous = this.#focusableBefore(index);
        if (previous) {
          event.preventDefault();
          previous.focus();
        }
        break;
      }

      case "ArrowRight": {
        const next = this.#focusableAfter(index);
        if (next) {
          event.preventDefault();
          next.focus();
        }
        break;
      }

      case "Home": {
        // Control+Home belongs to the document, not to the digit group
        if (hasModifier(event)) break;
        const first = fields.find((field) => this.#isFocusable(field));
        if (first) {
          event.preventDefault();
          first.focus();
        }
        break;
      }

      case "End": {
        if (hasModifier(event)) break;
        const last = fields
          .slice()
          .reverse()
          .find((field) => this.#isFocusable(field));
        if (last) {
          event.preventDefault();
          last.focus();
        }
        break;
      }

      default:
        break;
    }
  }

  /** Divides pasted string characters across the available input fields. */
  onPaste(event: ClipboardEvent): void {
    const input = this.#fieldFrom(event);
    if (!input) return;

    event.preventDefault();
    this.#confirmedField = null;
    this.#distribute(input, toHalfWidth(event.clipboardData?.getData("text") ?? ""));
  }

  /**
   * Redirects a pointer landing on an empty field to the earliest empty one, so
   * a passcode is entered in order. Filled fields stay directly reachable for
   * correction, and keyboard focus is left alone.
   */
  onPointerDown(event: Event): void {
    const input = this.#fieldFrom(event);
    if (input?.value !== "") return;

    const first = this.fieldTargets.find((field) => this.#isWritable(field) && field.value === "");
    if (!first || first === input) return;

    event.preventDefault();
    first.focus();
  }

  /** Empties every writable field and restarts entry at the first of them. */
  clear(): void {
    for (const field of this.fieldTargets) {
      if (this.#isWritable(field)) this.#writeField(field, "");
    }
    this.#clearError();
    this.fieldTargets.find((field) => this.#isWritable(field))?.focus();
    this.#syncAndDispatch();
  }

  readonly #onFieldFocus = (event: FocusEvent): void => {
    const input = event.currentTarget as HTMLInputElement | null;
    if (input) {
      // Auto-selection enables effortless character overwrites
      input.select();
    }
  };

  /** Reconciles derived state after a non-cancelled reset restores the fields. */
  readonly #onReset = (event: Event): void => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !this.#ownedBy(form)) return;
    queueMicrotask(() => {
      if (event.defaultPrevented) return;
      this.#adopt();
      this.#syncAndDispatch();
    });
  };

  /** Whether a form owns at least one field or the hidden combined value. */
  #ownedBy(form: HTMLFormElement): boolean {
    if (this.fieldTargets.some((field) => field.form === form)) return true;
    return this.hasValueTarget && this.valueTarget.form === form;
  }

  #bind(field: HTMLInputElement): void {
    field.addEventListener("focus", this.#onFieldFocus);
    this.#composition.observe(field);
  }

  #unbind(field: HTMLInputElement): void {
    field.removeEventListener("focus", this.#onFieldFocus);
    this.#composition.unobserve(field);
    if (this.#confirmedField === field) this.#confirmedField = null;
  }

  /** Reads every field back so a restored or reset group starts consistent. */
  #adopt(): void {
    for (const field of this.fieldTargets) this.#adoptField(field);
    this.#clearError();
    // Nothing has been rejected yet, whatever visibility the restored DOM carries
    if (this.hasErrorTarget) this.errorTarget.setAttribute("hidden", "");
  }

  /** Takes one field's current value as the truth behind its derived state. */
  #adoptField(field: HTMLInputElement): void {
    this.#committed.set(field, field.value);
    this.#markFilled(field, field.value);
  }

  /**
   * Absorbs a batch of field additions or removals as one value transition.
   *
   * The page, not the user, moved the value here, so it is reported as
   * `reconcile`: automation listening for `change` must not read a re-render as
   * an edit, and a passcode that happens to end up full must not fire the
   * `complete` that submits it.
   */
  #reconcileFields(): void {
    const previous = this.#lastValue;
    const combined = this.#sync();
    if (combined === previous) return;
    this.#lastValue = combined;
    this.dispatch("reconcile", { detail: { value: combined } });
  }

  /**
   * Validates the text an entry point received and distributes what it accepts.
   * `text` defaults to the field's own value; a confirmation passes the string it
   * committed, which `maxlength` would otherwise have truncated.
   */
  #accept(input: HTMLInputElement, text: string = input.value): void {
    const raw = toHalfWidth(text);
    if (raw === "") {
      // Emptying a field is a legitimate edit, not rejected input
      this.#writeField(input, "");
      this.#clearError();
      this.#syncAndDispatch();
      return;
    }

    this.#distribute(input, raw);
  }

  /**
   * Fills `text`'s accepted characters into the writable fields at and after the
   * entry point, then leaves focus on the field after the last one filled.
   */
  #distribute(from: HTMLInputElement, text: string): void {
    const accepted = Array.from(text).filter((char) => this.#pattern.test(char));
    let reached = false;
    const slots = this.fieldTargets.filter((field) => {
      reached ||= field === from;
      return reached && this.#isWritable(field);
    });
    const filled = Math.min(accepted.length, slots.length);

    if (filled === 0) {
      // Nothing landed: restore the digit the entry point had committed
      this.#restore(from);
      this.#showError();
      this.#sync();
      return;
    }

    for (let i = 0; i < filled; i++) {
      const field = slots[i];
      const char = accepted[i];
      if (field && char) this.#writeField(field, char);
    }

    const last = slots[filled - 1];
    if (last) (this.#writableAfter(last) ?? last).focus();

    this.#clearError();
    this.#syncAndDispatch();
  }

  /** Restores the digit a field committed before rejected input replaced it. */
  #restore(field: HTMLInputElement): void {
    this.#writeField(field, this.#committed.get(field) ?? "");
  }

  /** Commits one field's value and the derived hook that reports it as entered. */
  #writeField(field: HTMLInputElement, value: string): void {
    field.value = value;
    this.#committed.set(field, value);
    this.#markFilled(field, value);
  }

  #markFilled(field: HTMLInputElement, value: string): void {
    if (value) field.setAttribute("data-filled", "true");
    else field.removeAttribute("data-filled");
  }

  #isWritable(field: HTMLInputElement): boolean {
    return !field.disabled && !field.readOnly;
  }

  #isFocusable(field: HTMLInputElement): boolean {
    return !field.disabled;
  }

  #writableAfter(field: HTMLInputElement): HTMLInputElement | null {
    const fields = this.fieldTargets;
    return fields.slice(fields.indexOf(field) + 1).find((next) => this.#isWritable(next)) ?? null;
  }

  #writableBefore(index: number): HTMLInputElement | null {
    return this.#before(index).find((field) => this.#isWritable(field)) ?? null;
  }

  #focusableAfter(index: number): HTMLInputElement | null {
    return this.fieldTargets.slice(index + 1).find((field) => this.#isFocusable(field)) ?? null;
  }

  #focusableBefore(index: number): HTMLInputElement | null {
    return this.#before(index).find((field) => this.#isFocusable(field)) ?? null;
  }

  /** Fields before `index`, nearest first; empty at the first field. */
  #before(index: number): HTMLInputElement[] {
    return this.fieldTargets.slice(0, Math.max(index, 0)).reverse();
  }

  /** The event's field target, or `null` when the wiring points somewhere else. */
  #fieldFrom(event: Event): HTMLInputElement | null {
    const input = event.currentTarget;
    return this.fieldTargets.find((field) => field === input) ?? null;
  }

  #combinedValue(): string {
    return this.fieldTargets.map((field) => field.value).join("");
  }

  /** Every field carries a character, and there is at least one field. */
  #isComplete(): boolean {
    const fields = this.fieldTargets;
    return fields.length > 0 && fields.every((field) => field.value.length > 0);
  }

  /** Mirrors the combined value into the form and the root's readable state. */
  #sync(): string {
    const combined = this.#combinedValue();

    if (this.hasValueTarget) {
      this.valueTarget.value = combined;
    }
    this.#state.write(this.element, this.#stateName(combined));

    return combined;
  }

  #stateName(combined: string): string {
    if (combined.length === 0) return "empty";
    return this.#isComplete() ? "complete" : "partial";
  }

  #syncAndDispatch(): void {
    const combined = this.#sync();
    if (combined === this.#lastValue) return;
    this.#lastValue = combined;

    this.dispatch("change", { detail: { value: combined } });

    // Completed state when every field carries a character
    if (this.#isComplete()) {
      this.dispatch("complete", { detail: { value: combined } });
    }
  }

  /** Surfaces rejected input on every field and on the optional error target. */
  #showError(): void {
    const errorId = this.hasErrorTarget ? ensureId(this.errorTarget, "stimeo--otp-error") : null;

    for (const field of this.fieldTargets) {
      this.#ariaInvalid.write(field, "true");
      if (!errorId) continue;
      this.#ariaErrorMessage.write(field, errorId);
      // Assistive tech without aria-errormessage support still reads a description
      this.#ariaDescribedBy.write(field, this.#describedByWith(field, errorId));
    }
    if (this.hasErrorTarget) this.#errorHidden.write(this.errorTarget, null);

    // Behavior only: emit a neutral payload and let the consumer compose/localize
    // the user-facing message. The pattern is reported so consumers can word it.
    this.dispatch("invalid", { detail: { pattern: this.#patternSource } });
  }

  /** Returns every error lease, restoring the authored error surface. */
  #clearError(): void {
    this.#ariaInvalid.returnAll();
    this.#ariaErrorMessage.returnAll();
    this.#ariaDescribedBy.returnAll();
    this.#errorHidden.returnAll();
  }

  #returnFieldLeases(field: HTMLInputElement): void {
    this.#ariaInvalid.return(field);
    this.#ariaErrorMessage.return(field);
    this.#ariaDescribedBy.return(field);
  }

  /** The field's own description tokens with the error id appended once. */
  #describedByWith(field: HTMLInputElement, errorId: string): string {
    const tokens = (field.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter((token) => token.length > 0 && token !== errorId);
    return [...tokens, errorId].join(" ");
  }
}
