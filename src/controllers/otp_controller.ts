import { Controller } from "@hotwired/stimulus";
import { ensureId } from "../utils/aria_ids";
import { isReservedArrowChord, logicalArrowKey } from "../utils/arrow_step";
import { AttributeLease } from "../utils/attribute_lease";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { CompositionTracker } from "../utils/composition_tracker";
import { compileRegExp } from "../utils/declared_value";
import { FormResetWatcher } from "../utils/form_reset_watcher";
import { toHalfWidth } from "../utils/half_width";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";

/** The error attributes this component writes on each field while input is rejected. */
type ErrorAttribute = "aria-invalid" | "aria-errormessage" | "aria-describedby";

/**
 * Each error attribute's lease, kept on the field itself.
 *
 * `AttributeLease` keeps its records in memory, which the connection that adopts
 * a restored DOM does not have. These records travel with the markup instead,
 * so any connection can give the authored value back — and only while the
 * attribute still holds what this component last wrote there, so a value a
 * consumer changed in the meantime is theirs and stays.
 */
const LEASE_MARKERS: Readonly<Record<ErrorAttribute, string>> = {
  "aria-invalid": "data-otp-invalid-lease",
  "aria-errormessage": "data-otp-errormessage-lease",
  "aria-describedby": "data-otp-describedby-lease",
};

/** What an error attribute carried before this component wrote it, and what it wrote. */
interface ErrorLease {
  readonly authored: string | null;
  readonly written: string;
}

/** Whether a parsed marker holds a lease this component could have recorded. */
function isErrorLease(value: unknown): value is ErrorLease {
  const lease = value as Partial<Record<keyof ErrorLease, unknown>> | null;
  return (
    typeof lease?.written === "string" &&
    (lease.authored === null || typeof lease.authored === "string")
  );
}

/** Reads the lease a field carries; a marker holding anything else is not one. */
function readLease(field: Element, marker: string): ErrorLease | null {
  try {
    const parsed: unknown = JSON.parse(field.getAttribute(marker) ?? "null");
    return isErrorLease(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The field's own description tokens with the error id appended once. */
function describedByWith(described: string | null, errorId: string): string {
  const tokens = (described ?? "")
    .split(/\s+/)
    .filter((token) => token.length > 0 && token !== errorId);
  return [...tokens, errorId].join(" ");
}

/** Single-character pattern used when a `pattern` declaration cannot compile. */
const DEFAULT_PATTERN = "[0-9]";

/**
 * {@link DEFAULT_PATTERN} compiled, in the same whole-input form
 * `compileRegExp(…, "exact")` produces. A literal character class always
 * compiles, so the fallback is a value rather than another parse.
 */
const DEFAULT_MATCHER = new RegExp(`^(?:${DEFAULT_PATTERN})$`);

/** Whether a press carries a modifier, which makes it the document's to handle. */
function hasModifier(event: KeyboardEvent): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

/**
 * The controller-derived state a consumer can observe.
 *
 * The combined value alone does not identify it: the same string spread over a
 * different number of fields reads as a different `data-state`, so completeness
 * is carried alongside the value rather than inferred from it.
 */
interface OtpState {
  readonly value: string;
  readonly state: string;
}

/** Compares exactly the derived state the root publishes. */
function statesDiffer(left: OtpState, right: OtpState): boolean {
  return left.value !== right.value || left.state !== right.state;
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
 * State moved by adding or removing fields, by a `pattern` change dropping
 * entered digits it no longer accepts, or by a native form reset restoring the
 * fields is not an edit of the passcode, so it is reported as `reconcile` with
 * the same `{ value: string }` — once per change, after it settles — and never
 * as `change` or `complete`. While a field is composing, the IME's uncommitted
 * text is neither read nor written: a change already in the DOM — fields added
 * or removed, a reset — is reported at once, counting that field by the
 * character it had committed, while a `pattern` change's drop waits for the
 * composition to end and is then applied and reported before the commit is
 * taken. A composition that ends on the text the field held when it began was
 * cancelled: no edit, so it reports nothing and focus stays.
 * Completeness belongs to that state: dropping a trailing empty field completes
 * a passcode whose combined value never moved, and that transition is reported
 * too, so a consumer reading `data-state` is never left behind a silent move.
 * `invalid` dispatches `{ pattern: string }` carrying the compiled pattern.
 *
 * Controller-owned output: `data-filled` on each entered field, `data-state`
 * (`empty` / `partial` / `complete`) on the root, and — while input is being
 * reported invalid — `aria-invalid`, `aria-errormessage`, `aria-describedby`,
 * and the `error` target's `hidden`. Authored values return on teardown and
 * before the page is cached: the three ARIA attributes keep their lease on the
 * field itself, so a connection that adopts a restored DOM can give them back
 * too, and the `hidden` is leased.
 *
 * @remarks
 * Behavior only. `connect()` reads the fields back as the source of truth, which
 * is what restores consistency after a `type="password"` field returns from the
 * Turbo cache emptied; a native form reset is read back the same way once the
 * browser has restored the fields. A `pattern` that cannot compile falls back to
 * `[0-9]`; the compiled matcher is built once per declaration rather than per
 * keystroke.
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
  #pattern = DEFAULT_MATCHER;
  /** Source of {@link #pattern}, reported in `invalid` so consumers can word it. */
  #patternSource = DEFAULT_PATTERN;
  /** Public state carried by the last dispatch; keeps a no-op sync silent. */
  #published: OtpState | null = null;
  /** True between connect and disconnect, so pre-connect Value changes stay silent. */
  #connected = false;
  /** Digit each field last committed, restored when rejected input replaced it. */
  readonly #committed = new WeakMap<HTMLInputElement, string>();
  /** The field being composed, and the text it held when the composition began. */
  #composing: { readonly field: HTMLInputElement; readonly before: string } | null = null;
  /** A `pattern` change whose rejected characters wait for the composition to end. */
  #dropHeld = false;

  /**
   * Collapses one batch of page changes — field target and `pattern` callbacks, a
   * form reset — into a single reconciliation.
   */
  readonly #reconcile = new MicrotaskCoalescer(() => this.#reconcileFields());

  readonly #errorHidden = new AttributeLease<HTMLElement>("hidden");
  readonly #state = new AttributeLease<HTMLElement>("data-state");

  /** Rewinds the transient error surface before Turbo freezes the page. */
  readonly #beforeCache = new BeforeCacheReset(() => this.#clearError());
  /** Reads the fields back once a native reset restored them, as a reconciliation. */
  readonly #formReset = new FormResetWatcher(
    (form) => this.#ownedBy(form),
    () => {
      this.#adopt();
      this.#reconcile.schedule();
    },
  );

  /**
   * Owns IME lifecycle state across every digit field. When a composition ends, a
   * `pattern` drop it held back applies first — it was declared first — and the
   * user's commit is taken after it.
   */
  readonly #composition = new CompositionTracker({
    onStart: (event) => {
      const field = this.#fieldFrom(event);
      if (field) this.#composing = { field, before: field.value };
    },
    onEnd: (event) => {
      const composing = this.#composing;
      this.#composing = null;
      const input = this.#fieldFrom(event);
      // `maxlength` has already cut the field down to one character, but the
      // commit itself carries the whole confirmed string — so a conversion that
      // ends in several characters still reaches the fields after this one.
      const data = (event as CompositionEvent).data ?? "";
      const text = input && data.length <= input.value.length ? input.value : data;
      // A composition that ends on the text the field held when it began was
      // cancelled: the user entered nothing, so there is nothing to take.
      const commit = input !== null && (composing?.field !== input || text !== composing.before);
      if (this.#dropHeld) {
        // The drop judges what the fields had committed; the commit waits aside.
        if (input && commit) input.value = this.#committed.get(input) ?? "";
        this.#reconcileFields();
      }
      if (input && commit) this.#accept(input, text);
    },
  });

  override connect(): void {
    this.#connected = true;
    for (const field of this.fieldTargets) this.#bind(field);
    this.#formReset.observe();
    this.#beforeCache.activate();
    this.#reconcile.activate();
    this.#adopt();
    this.#sync();
  }

  override disconnect(): void {
    this.#connected = false;
    for (const field of this.fieldTargets) this.#unbind(field);
    this.#composition.disconnect();
    this.#formReset.disconnect();
    this.#beforeCache.deactivate();
    this.#reconcile.cancel();
    // A drop a composition held goes with the connection, like a pending pass.
    this.#dropHeld = false;
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
    this.#returnLeases(element);
    this.#reconcile.schedule();
  }

  /**
   * Re-validates a changed `pattern` declaration once and drops any entered digit
   * the new pattern no longer accepts, so the combined value stays interpretable.
   * The page changed the declaration, so the move joins the same reconciliation
   * as fields added or removed in that mutation. While a field is composing, its
   * text is the IME's, and the drop waits for the composition to end.
   */
  patternValueChanged(): void {
    const compiled = compileRegExp(this.patternValue, "exact");
    this.#patternSource = compiled ? this.patternValue : DEFAULT_PATTERN;
    this.#pattern = compiled ?? DEFAULT_MATCHER;
    if (!this.#connected) return;
    if (this.#composing !== null) {
      this.#dropHeld = true;
      return;
    }
    if (this.#dropRejected()) this.#reconcile.schedule();
  }

  /** Empties every writable field holding a character the pattern rejects; whether one did. */
  #dropRejected(): boolean {
    let dropped = false;
    for (const field of this.fieldTargets) {
      if (field.value === "" || !this.#isWritable(field)) continue;
      if (this.#pattern.test(field.value)) continue;
      this.#writeField(field, "");
      dropped = true;
    }
    return dropped;
  }

  /** Handles keystroke inputs, distributes autofilled text, and advances focus. */
  onInput(event: Event): void {
    const input = this.#fieldFrom(event);
    if (!input) return;

    // The browser may follow a commit with one more `input` carrying the same
    // text; running it again would spread the commit twice.
    if (this.#composition.consumesConfirmedInput(event)) return;

    // Guard during active composition to prevent premature focus switching
    if (this.#composition.isComposing(event as InputEvent)) return;

    this.#accept(input);
  }

  /** Handles Backspace clearing, arrows, and home/end navigation. */
  onKeydown(event: KeyboardEvent): void {
    if (isReservedArrowChord(event)) return;
    const input = this.#fieldFrom(event);
    if (!input) return;

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
    // A field that leaves mid-composition never ends that composition here.
    if (this.#composing?.field === field) this.#composing = null;
  }

  /** Reads every field back so a restored or reset group starts consistent. */
  #adopt(): void {
    for (const field of this.fieldTargets) this.#adoptField(field);
    this.#clearError();
    // Nothing has been rejected yet, whatever visibility the restored DOM carries
    if (this.hasErrorTarget) this.errorTarget.setAttribute("hidden", "");
  }

  /** Writes one error attribute, keeping the first authored value it displaces. */
  #lease(field: HTMLInputElement, attribute: ErrorAttribute, value: string): void {
    const marker = LEASE_MARKERS[attribute];
    const held = readLease(field, marker);
    const authored = held ? held.authored : field.getAttribute(attribute);
    field.setAttribute(marker, JSON.stringify({ authored, written: value }));
    field.setAttribute(attribute, value);
  }

  /** Gives one field's error attributes back where they still hold what this wrote. */
  #returnLeases(field: HTMLInputElement): void {
    for (const [attribute, marker] of Object.entries(LEASE_MARKERS)) {
      const held = readLease(field, marker);
      if (!held) continue;
      field.removeAttribute(marker);
      if (field.getAttribute(attribute) !== held.written) continue;
      if (held.authored === null) field.removeAttribute(attribute);
      else field.setAttribute(attribute, held.authored);
    }
  }

  /** Takes one field's current value as the truth behind its derived state. */
  #adoptField(field: HTMLInputElement): void {
    this.#committed.set(field, field.value);
    this.#markFilled(field, field.value);
  }

  /**
   * Absorbs one batch of page changes — fields added or removed, entered digits a
   * new `pattern` rejects, fields a native form reset restored — as one state
   * transition.
   *
   * Nobody edited the passcode here, so the move is reported as `reconcile`:
   * automation listening for `change` must not read a re-render or a reset as an
   * edit, and a passcode that happens to end up full must not fire the
   * `complete` that submits it.
   *
   * Completeness moves on its own when the field count changes: dropping a
   * trailing empty field completes a passcode whose combined value never moved,
   * and adding one un-completes it. Comparing the whole derived state, not the
   * string it contains, is what makes those transitions reportable.
   *
   * A change already in the DOM — a field added or removed, a reset — is
   * published at once, even while a field is composing: that field counts by the
   * character it had committed, never by the IME's uncommitted text. Only a
   * `pattern` drop waits for the composition to end.
   */
  #reconcileFields(): void {
    if (this.#dropHeld && this.#composing === null) {
      this.#dropHeld = false;
      this.#dropRejected();
    }
    const previous = this.#published;
    const current = this.#sync();
    if (previous && !statesDiffer(previous, current)) return;
    this.dispatch("reconcile", { detail: { value: current.value } });
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
    return this.fieldTargets.map((field) => this.#publishedText(field)).join("");
  }

  /** Every field carries a character, and there is at least one field. */
  #isComplete(): boolean {
    const fields = this.fieldTargets;
    return fields.length > 0 && fields.every((field) => this.#publishedText(field).length > 0);
  }

  /** A field's text as the combined value counts it: a composing field by its committed character. */
  #publishedText(field: HTMLInputElement): string {
    return field === this.#composing?.field ? (this.#committed.get(field) ?? "") : field.value;
  }

  /**
   * Mirrors the combined value into the form and the root's readable state, and
   * records what was published so the next pass can compare against it.
   */
  #sync(): OtpState {
    const combined = this.#combinedValue();

    if (this.hasValueTarget) {
      this.valueTarget.value = combined;
    }
    const state = this.#stateName(combined);
    this.#state.write(this.element, state);

    const published: OtpState = { value: combined, state };
    this.#published = published;
    return published;
  }

  #stateName(combined: string): string {
    if (combined.length === 0) return "empty";
    return this.#isComplete() ? "complete" : "partial";
  }

  #syncAndDispatch(): void {
    const previous = this.#published;
    const { value: combined } = this.#sync();
    if (previous?.value === combined) return;

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
      this.#lease(field, "aria-invalid", "true");
      if (!errorId) continue;
      this.#lease(field, "aria-errormessage", errorId);
      // Assistive tech without aria-errormessage support still reads a description
      const described = field.getAttribute("aria-describedby");
      this.#lease(field, "aria-describedby", describedByWith(described, errorId));
    }
    if (this.hasErrorTarget) this.#errorHidden.write(this.errorTarget, null);

    // Behavior only: emit a neutral payload and let the consumer compose/localize
    // the user-facing message. The pattern is reported so consumers can word it.
    this.dispatch("invalid", { detail: { pattern: this.#patternSource } });
  }

  /** Returns every error lease, restoring the authored error surface. */
  #clearError(): void {
    for (const field of this.fieldTargets) this.#returnLeases(field);
    this.#errorHidden.returnAll();
  }
}
