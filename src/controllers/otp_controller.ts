import { Controller } from "@hotwired/stimulus";
import { ensureId } from "../utils/aria_ids";
import { hasModifierChord, isReservedArrowChord, logicalArrowKey } from "../utils/arrow_step";
import { AttributeLease } from "../utils/attribute_lease";
import { CompositionTracker, isCompositionInputType } from "../utils/composition_tracker";
import { compileRegExp } from "../utils/declared_value";
import { FormResetWatcher } from "../utils/form_reset_watcher";
import { toHalfWidth } from "../utils/half_width";
import { KeyedTimers } from "../utils/keyed_timers";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import { MoveCounter } from "../utils/move_counter";

/** The error attributes this component writes on each field while input is rejected. */
type ErrorAttribute = "aria-invalid" | "aria-errormessage" | "aria-describedby";

/**
 * Each error attribute's lease, kept on the field itself.
 *
 * These records travel with the markup, so any connection can give the authored
 * value back — and only while the
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

/**
 * The field's own description tokens with the error id appended once, dropping the
 * id of an earlier error target this component pointed the field at.
 */
function describedByWith(
  described: string | null,
  errorId: string,
  earlier: string | null,
): string {
  const tokens = (described ?? "")
    .split(/\s+/)
    .filter((token) => token.length > 0 && token !== errorId && token !== earlier);
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

/** The edit a normal beforeinput announces, before interrupted text is reconciled. */
interface InputBaseline {
  readonly field: HTMLInputElement;
  readonly before: string;
  readonly dropHeld: boolean;
  interrupted: boolean;
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
 * An interrupted conversion is not a confirmation: only an empty residual or
 * one whole-pattern character, after full-width normalization, is retained.
 * Other residuals return to the prior accepted character, or empty if the current
 * pattern rejects it. No characters are distributed and focus stays. Locked
 * fields and a new conversion keep their DOM text; publication counts the validated
 * character until that text is superseded. Page writes are read as page writes,
 * never rolled back as an old residual. This cleanup reports only `reconcile`,
 * and only if the combined value or state moved. A following ordinary input or
 * real compositionend still reports its own edit, independently of that cleanup;
 * the cleanup keeps the selection of a field it rewrites, so that input lands where
 * the user put it. A real compositionend still owed survives a move that keeps its
 * field focused within one turn (`moveBefore`); it goes when the field is released
 * or returns without focus, stays out past the turn, or a `change` publishes a value
 * that already carries the residual, after which the end is compared with that value.
 * Until the conversion's end is observed, only its own field waits: a key in another
 * field is handled as a key, a script's input there is distributed past the field
 * still composing without moving focus, and a paste fills every writable field from
 * its own, conversion text included, then advances focus.
 * A `pattern` drop held for a conversion applies, reported as `reconcile`, ahead of
 * the next key, edit or paste — to every field but one still composing, which keeps
 * its text for its own end and counts a committed character only if the pattern
 * accepts it or the field is locked. A listener that answers that `reconcile`
 * synchronously with another operation — another edit or reconciliation,
 * disconnecting the group, removing the field, starting or ending a conversion —
 * supersedes the gesture.
 * Completeness belongs to that state: dropping a trailing empty field completes
 * a passcode whose combined value never moved, and that transition is reported
 * too, so a consumer reading `data-state` is never left behind a silent move.
 * `invalid` dispatches `{ pattern: string }` carrying the compiled pattern.
 *
 * Controller-owned output: `data-filled` and a `data-stimeo--otp-interrupted`
 * projection marker on a field whose DOM text must be preserved, `data-state`
 * (`empty` / `partial` / `complete`) on the root, and — while input is being
 * reported invalid — `aria-invalid`, `aria-errormessage`, `aria-describedby`,
 * and the `error` target's `hidden`. Authored values return on teardown: the
 * three ARIA attributes keep their lease on the field itself, so a connection
 * that adopts a restored DOM can give them back too, and the `hidden` is leased.
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
  /** Identifies the latest published state transition. */
  readonly #moves = new MoveCounter();

  static override targets = ["field", "value", "error"];
  static override values = {
    pattern: { type: String, default: DEFAULT_PATTERN },
  };
  static actions = ["onInput", "onKeydown", "onPaste", "onPointerDown", "clear"] as const;
  static events = ["change", "complete", "invalid", "reconcile"] as const;

  declare readonly fieldTargets: HTMLInputElement[];
  declare readonly valueTarget: HTMLInputElement;
  declare readonly errorTarget: HTMLElement;
  declare readonly errorTargets: HTMLElement[];
  declare readonly hasValueTarget: boolean;
  declare readonly hasErrorTarget: boolean;

  declare patternValue: string;

  /** Validated matcher; the hot path never compiles a raw declaration. */
  #pattern = DEFAULT_MATCHER;
  /** Source of {@link #pattern}, reported in `invalid` so consumers can word it. */
  #patternSource = DEFAULT_PATTERN;
  /** The published state carried by the last dispatch; keeps a no-op sync silent. */
  #published: OtpState | null = null;
  /** True between connect and disconnect, so pre-connect Value changes stay silent. */
  #connected = false;
  /** Digit each field last committed, restored when rejected input replaced it. */
  readonly #committed = new WeakMap<HTMLInputElement, string>();
  /** Validated publication while a locked field or a new conversion keeps its own DOM text. */
  readonly #retained = new WeakMap<
    HTMLInputElement,
    { readonly text: string; readonly value: string }
  >();
  /** One ordinary edit's comparison basis, independent of an intervening reconciliation. */
  readonly #inputBaselines = new Map<HTMLInputElement, InputBaseline>();
  readonly #inputExpiry = new KeyedTimers<HTMLInputElement>();
  /** A formal end can arrive after the ordinary input window has expired. */
  readonly #endBaselines = new Map<
    HTMLInputElement,
    { readonly text: string; readonly baseline: InputBaseline }
  >();
  /**
   * Fields released while they kept focus, until the turn ends: a move with
   * `moveBefore`, which Stimulus releases and observes again in one mutation batch,
   * keeps the formal end a field owes; anything else is leaving.
   */
  readonly #away = new Set<HTMLInputElement>();
  /**
   * The field a composition began in and the text it held then, which tells a
   * cancelled composition from a commit when it ends. Whether a field is composing
   * now is the tracker's to say.
   */
  #composing: { readonly field: HTMLInputElement; readonly before: string } | null = null;
  /** A `pattern` change whose rejected characters wait for the composition to end. */
  #dropHeld = false;
  /**
   * The pattern the entered digits were last judged by. A connection that finds
   * another one declared judges them again, as the change does while connected.
   */
  #judgedBy: string | null = null;

  /**
   * Collapses one batch of page changes — field and value target and `pattern`
   * callbacks, a form reset, a Turbo morph of the group or its subtree — into a
   * single reconciliation. A morph can empty a retained `value` target whose new
   * markup carries no value while the digits keep theirs; the pass rewrites it.
   */
  readonly #reconcile = new MorphRenderWatcher(() => this.#reconcileFields());

  readonly #errorHidden = new AttributeLease<HTMLElement>("hidden", this.identifier);
  readonly #state = new AttributeLease<HTMLElement>("data-state", this.identifier);

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
      this.#clearInputBaseline();
      if (field) this.#endBaselines.delete(field);
      if (field && this.#composition.composingElement() === field) {
        this.#composing = { field, before: field.value };
      }
    },
    onEnd: (event) => {
      const input = this.#fieldFrom(event);
      if (!input) return;
      const baseline = this.#inputBaselines.get(input) ?? this.#endBaselines.get(input)?.baseline;
      this.#clearEdits(input);
      const composing = this.#composing;
      if (!this.#composition.isComposing()) this.#composing = null;
      // `maxlength` has already cut the field down to one character, but the
      // commit itself carries the whole confirmed string — so a conversion that
      // ends in several characters still reaches the fields after this one.
      const data = (event as CompositionEvent).data ?? "";
      const text = data.length <= input.value.length ? input.value : data;
      // A composition that ends on the text the field held when it began was
      // cancelled: the user entered nothing, so there is nothing to take.
      const commit = composing?.field !== input || text !== composing.before;
      if (commit) this.#accept(input, text, baseline?.interrupted ? baseline : undefined);
      else {
        this.#restoreRetained(input);
        if (this.#dropHeld) this.#reconcileFields();
      }
    },
    onAbandon: (element, inPlace) => {
      this.#composing = null;
      if (inPlace && element instanceof HTMLInputElement && this.fieldTargets.includes(element)) {
        const baseline = this.#inputBaselines.get(element) ?? {
          field: element,
          before: this.#committed.get(element) ?? "",
          dropHeld: this.#dropHeld,
          interrupted: true,
        };
        baseline.interrupted = true;
        this.#settleResidual(element);
        this.#endBaselines.set(element, { text: element.value, baseline });
        this.#reconcileFields();
      } else if (this.#dropHeld) {
        // A write may be the input about to run; its value is not a page reconciliation yet.
        this.#reconcile.schedule();
      }
    },
  });

  override connect(): void {
    this.#connected = true;
    for (const field of this.fieldTargets) this.#bind(field);
    this.#formReset.observe();
    this.#reconcile.observe(this.element);
    this.#adopt();
    this.#sync();
    // A pattern that changed while the group was away — moved with the change, or
    // with a drop a composition still holds — drops what it rejects now, or once
    // the composition the group kept through the move ends.
    this.#judgedBy ??= this.#patternSource;
    if (this.#judgedBy !== this.#patternSource) {
      if (this.#composition.isComposing()) this.#dropHeld = true;
      else if (this.#dropRejected()) this.#reconcile.schedule();
    }
  }

  override disconnect(): void {
    this.#connected = false;
    for (const field of this.fieldTargets) this.#unbind(field);
    this.#composition.disconnect();
    this.#clearInputBaseline();
    // Only a field that keeps focus through the move still owes its end to this group
    for (const field of this.#endBaselines.keys())
      if (!this.#away.has(field)) this.#endBaselines.delete(field);
    this.#formReset.disconnect();
    this.#reconcile.disconnect();
    // A drop a composition held goes with the connection, like a pending pass; the
    // next connection judges the digits again by the pattern it finds.
    this.#dropHeld = false;
    this.#clearError();
    this.#state.return(this.element);
  }

  /**
   * Stimulus lifecycle callback when a new field target enters the DOM.
   * Wires the new field and reads it at once, so its mark and the digit a rejected
   * keystroke restores hold before anything else runs, then folds the wider digit
   * count into one reconciliation, which stays inert until `connect()` opens the
   * window.
   */
  fieldTargetConnected(element: HTMLInputElement): void {
    this.#bind(element);
    this.#adoptField(element);
    this.#reconcile.schedule();
  }

  /**
   * Releases a dropped field's listeners and leases, then reconciles the rest. A
   * field that only moved within the group stays a field and keeps what it shows.
   */
  fieldTargetDisconnected(element: HTMLInputElement): void {
    this.#unbind(element);
    if (!this.fieldTargets.includes(element)) this.#returnLeases(element);
    this.#reconcile.schedule();
  }

  /** Writes the combined value into a value field that arrives, in the next reconciliation. */
  valueTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Writes the combined value into the value field that stays when an earlier one leaves. */
  valueTargetDisconnected(): void {
    this.#reconcile.schedule();
  }

  /**
   * Moves rejected input still being reported onto the first error target as one arrives,
   * and hides the first one while nothing is reported.
   */
  errorTargetConnected(): void {
    this.#followError();
  }

  /**
   * Gives an error target that no longer resolves as one its own `hidden` back — after
   * `disconnect()` too, since dropping the identifier leaves the element on the page —
   * and shows rejected input still being reported on the error target that stays, or
   * hides it while nothing is reported.
   */
  errorTargetDisconnected(element: HTMLElement): void {
    if (!this.errorTargets.includes(element)) this.#errorHidden.return(element);
    this.#followError();
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
    if (this.#composition.isComposing()) {
      this.#dropHeld = true;
      return;
    }
    if (this.#dropRejected()) this.#reconcile.schedule();
  }

  /**
   * Empties every writable field holding a character the pattern rejects; whether one did.
   * A field still `composing` keeps its text, the IME's until the conversion ends, and
   * only stops counting a committed character the pattern rejects — unless it is locked,
   * since a locked field keeps its characters; its text is judged, and the digits marked
   * judged, when the drop applies again after that end.
   */
  #dropRejected(composing: EventTarget | null = null): boolean {
    if (composing === null) this.#judgedBy = this.#patternSource;
    let dropped = false;
    for (const field of this.fieldTargets) {
      if (field === composing) {
        const committed = this.#committed.get(field) ?? "";
        if (committed === "" || !this.#isWritable(field) || this.#pattern.test(committed)) continue;
        this.#committed.set(field, "");
        dropped = true;
        continue;
      }
      const value = this.#settledText(field);
      if (value === "" || !this.#isWritable(field)) continue;
      if (this.#pattern.test(value)) continue;
      if (this.#retained.has(field)) this.#holdText(field, "");
      else this.#writeField(field, "");
      dropped = true;
    }
    return dropped;
  }

  /** Handles keystroke inputs, distributes autofilled text, and advances focus. */
  onInput(event: Event): void {
    const input = this.#fieldFrom(event);
    if (!input) return;
    const baseline = this.#inputBaselines.get(input);
    this.#clearEdits(input);

    // The browser may follow a commit with one more `input` carrying the same
    // text; running it again would spread the commit twice.
    if (this.#composition.consumesConfirmedInput(event)) return;

    // The IME's own draft waits for its end; an edit in another field is not the conversion's
    if (this.#composition.owns(event as InputEvent)) return;

    this.#accept(input, input.value, baseline?.interrupted ? baseline : undefined);
  }

  /** Handles Backspace clearing, arrows, and home/end navigation. */
  onKeydown(event: KeyboardEvent): void {
    this.#clearInputBaseline();
    if (isReservedArrowChord(event)) return;
    const input = this.#fieldFrom(event);
    if (!input) return;

    // Keys belong to the IME in the field it composes in, and only there
    if (this.#composition.owns(event)) return;

    if (!this.#prepareEdit(input)) return;

    const index = this.fieldTargets.indexOf(input);
    const fields = this.fieldTargets;
    // Logical, not physical: `logicalArrowKey` swaps the key under RTL, so each branch
    // keeps its own direction's helper (`#focusableBefore` / `#focusableAfter`).
    switch (logicalArrowKey(event.key, this.element)) {
      case "Backspace":
        if (hasModifierChord(event)) break;
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
        if (hasModifierChord(event)) break;
        const first = fields.find((field) => this.#isFocusable(field));
        if (first) {
          event.preventDefault();
          first.focus();
        }
        break;
      }

      case "End": {
        if (hasModifierChord(event)) break;
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
    if (this.#prepareEdit(input))
      this.#distribute(input, toHalfWidth(event.clipboardData?.getData("text") ?? ""), false);
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

  /** Captures an ordinary edit before the tracker reconciles any composition it interrupts. */
  readonly #onBeforeInput = (event: InputEvent): void => {
    const field = event.currentTarget as HTMLInputElement;
    this.#clearEdits(field);
    if (event.isComposing || !event.inputType || isCompositionInputType(event.inputType)) return;
    this.#inputBaselines.set(field, {
      field,
      before: this.#committed.get(field) ?? "",
      dropHeld: this.#dropHeld,
      interrupted: false,
    });
    this.#inputExpiry.set(field, () => this.#clearInputBaseline(field), 0);
  };

  /** Expires a beforeinput that produced no input, or was superseded by another gesture. */
  #clearInputBaseline(field?: HTMLInputElement): void {
    if (field) {
      this.#inputBaselines.delete(field);
      this.#inputExpiry.clear(field);
    } else {
      this.#inputBaselines.clear();
      this.#inputExpiry.clearAll();
    }
  }

  /** Consumes an edit or releases its field, including any still-owed formal end. */
  #clearEdits(field: HTMLInputElement): void {
    this.#clearInputBaseline(field);
    this.#endBaselines.delete(field);
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

  /**
   * Listens for focus and ordinary edits on one field and hands it to the composition
   * tracker; a field back from a move keeps the end it owes only while it holds focus.
   *
   * @stimeoListenerLifetime element each field is bound when it arrives and unbound by
   *   `#unbind` when it leaves or the controller disconnects.
   */
  #bind(field: HTMLInputElement): void {
    field.addEventListener("focus", this.#onFieldFocus);
    field.addEventListener("beforeinput", this.#onBeforeInput, true);
    // A field back from a move owes its end only if it still holds focus
    if (this.#away.delete(field) && document.activeElement !== field)
      this.#endBaselines.delete(field);
    this.#composition.observe(field);
  }

  /** Lets a field go; one that keeps focus through a move keeps the formal end it owes. */
  #unbind(field: HTMLInputElement): void {
    field.removeEventListener("focus", this.#onFieldFocus);
    field.removeEventListener("beforeinput", this.#onBeforeInput, true);
    this.#clearInputBaseline(field);
    if (document.activeElement === field) this.#holdAway(field);
    else this.#endBaselines.delete(field);
    this.#composition.unobserve(field);
  }

  /** Keeps the end a released field owes until the turn ends, for a move to bring it back. */
  #holdAway(field: HTMLInputElement): void {
    this.#away.add(field);
    queueMicrotask(() => {
      if (this.#away.delete(field)) this.#endBaselines.delete(field);
    });
  }

  /**
   * Reads every field back so a restored or reset group starts consistent: nothing has
   * been rejected yet, whatever error surface the restored DOM carries.
   */
  #adopt(): void {
    for (const field of this.fieldTargets) this.#adoptField(field);
    this.#clearError();
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
    // A field that moved here with its conversion keeps the character it committed.
    if (this.#composition.composingElement() === field) return;
    const value = this.#settledText(field);
    this.#committed.set(field, value);
    this.#markFilled(field, value);
  }

  /**
   * Absorbs one batch of page changes — fields added or removed, entered digits a
   * new `pattern` rejects, fields a native form reset restored, digits a Turbo
   * morph rewrote — as one state transition. Every field but one mid-composition
   * is read back first, so its `data-filled` mark and the character a rejected
   * keystroke restores follow what the page left in it; a field mid-composition
   * keeps the character it had committed and is marked by that.
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
  #reconcileFields(): boolean {
    // Asking ends a composition a write already ended, so its field reads as written.
    const composing = this.#composition.composingElement();
    if (this.#dropHeld && composing === null) {
      this.#dropHeld = false;
      this.#dropRejected();
    }
    for (const field of this.fieldTargets) {
      if (field === composing) this.#markFilled(field, this.#publishedText(field));
      else this.#adoptField(field);
    }
    const previous = this.#published;
    const current = this.#sync();
    if (previous && !statesDiffer(previous, current)) return true;
    const token = this.#moves.record();
    this.dispatch("reconcile", { detail: { value: current.value } });
    return this.#moves.isLatest(token);
  }

  /**
   * Validates the text an entry point received and distributes what it accepts.
   * `text` defaults to the field's own value; a confirmation passes the string it
   * committed, which `maxlength` would otherwise have truncated.
   */
  #accept(input: HTMLInputElement, text: string = input.value, baseline?: InputBaseline): void {
    if (!this.#prepareEdit(input, true)) return;
    const before = baseline
      ? this.fieldTargets
          .map((field) =>
            field === input
              ? baseline.dropHeld && !this.#pattern.test(baseline.before)
                ? ""
                : baseline.before
              : this.#publishedText(field),
          )
          .join("")
      : undefined;
    const raw = toHalfWidth(text);
    if (raw === "") {
      // Emptying a field is a legitimate edit, not rejected input
      this.#writeField(input, "");
      this.#clearError();
      this.#syncAndDispatch(before);
      return;
    }

    this.#distribute(input, raw, true, before);
  }

  /**
   * Fills `text`'s accepted characters into writable fields at and after the
   * entry point, preserving any other field's composition and its focus. Without
   * an active composition, focus advances past the last field filled.
   *
   * A paste passes `spare` false: it lands in the focused field, so no other field can
   * still be composing, whatever end the tracker has yet to see, and the paste replaces
   * what its own field holds. It fills every writable field and advances focus.
   */
  #distribute(from: HTMLInputElement, text: string, spare = true, before?: string): void {
    const accepted = Array.from(text).filter((char) => this.#pattern.test(char));
    let reached = false;
    const composing = spare ? this.#composition.composingElement() : null;
    const slots = this.fieldTargets.filter((field) => {
      reached ||= field === from;
      return reached && field !== composing && this.#isWritable(field);
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
    if (last && composing === null) (this.#writableAfter(last) ?? last).focus();

    this.#clearError();
    this.#syncAndDispatch(before);
  }

  /**
   * Applies page-declared drops a conversion held, ahead of a user's key, edit or paste
   * in `input`; whether that gesture still applies. A conversion still running elsewhere
   * keeps its text for its own end, and every other field takes the drop. `edit` says
   * the field's text is already the incoming edit, which the drop reads by the prior
   * slot instead. A listener that answers the drop's `reconcile` synchronously with
   * another operation — a newer edit or reconciliation, disconnecting the group,
   * removing the field, starting or ending a conversion — supersedes the gesture.
   */
  #prepareEdit(input: HTMLInputElement, edit = false): boolean {
    if (!this.#dropHeld) return true;
    if (edit) this.#holdText(input, this.#committed.get(input) ?? "");
    // A conversion still running keeps its own text; every other field takes the drop now
    const composing = this.#composition.composingElement();
    if (composing !== null) this.#dropRejected(composing);
    return (
      this.#reconcileFields() &&
      this.#connected &&
      this.fieldTargets.includes(input) &&
      this.#composition.composingElement() === composing
    );
  }

  /** Validates the whole residual as one slot, without distribution or focus changes. */
  #settleResidual(field: HTMLInputElement): void {
    const raw = toHalfWidth(field.value);
    const previous = this.#committed.get(field) ?? "";
    const accepts = (text: string) => Array.from(text).length === 1 && this.#pattern.test(text);
    const value = raw === "" || accepts(raw) ? raw : accepts(previous) ? previous : "";
    if (this.#isWritable(field) && this.#composition.composingElement() !== field) {
      // The edit that showed the end lands where the user put it
      const { selectionStart, selectionEnd } = field;
      this.#writeField(field, value);
      if (selectionStart !== null && selectionEnd !== null)
        field.setSelectionRange(selectionStart, selectionEnd);
    } else this.#holdText(field, value);
  }

  /** Keeps a validated publication separate from DOM text this pass must leave alone. */
  #holdText(field: HTMLInputElement, value: string): void {
    const retained = { text: field.value, value };
    this.#retained.set(field, retained);
    field.setAttribute(this.#retainedMarker, JSON.stringify(retained));
    this.#committed.set(field, value);
  }

  /** A page write supersedes a retained projection; unchanged residual DOM keeps it. */
  #settledText(field: HTMLInputElement): string {
    const ending = this.#endBaselines.get(field);
    if (ending && ending.text !== field.value) this.#clearEdits(field);
    const retained = this.#retained.get(field) ?? this.#readRetained(field);
    if (retained?.text === field.value) {
      this.#retained.set(field, retained);
      const marker = JSON.stringify(retained);
      if (field.getAttribute(this.#retainedMarker) !== marker)
        field.setAttribute(this.#retainedMarker, marker);
      return retained.value;
    }
    this.#retained.delete(field);
    field.removeAttribute(this.#retainedMarker);
    return field.value;
  }

  /** The projection travels with a copied field, without treating authored values as residuals. */
  get #retainedMarker(): string {
    return `data-${this.identifier}-interrupted`;
  }

  /** Reads only a complete projection; unrelated or malformed markup remains a page value. */
  #readRetained(field: HTMLInputElement): { readonly text: string; readonly value: string } | null {
    try {
      const record: unknown = JSON.parse(field.getAttribute(this.#retainedMarker) ?? "null");
      if (
        typeof record === "object" &&
        record !== null &&
        "text" in record &&
        "value" in record &&
        typeof record.text === "string" &&
        typeof record.value === "string"
      ) {
        return { text: record.text, value: record.value };
      }
    } catch {
      return null;
    }
    return null;
  }

  /** A cancelled restart restores its validated slot after composition ends. */
  #restoreRetained(field: HTMLInputElement): void {
    const retained = this.#retained.get(field);
    if (retained?.text === field.value && this.#isWritable(field))
      this.#writeField(field, retained.value);
  }

  /** Restores the digit a field committed before rejected input replaced it. */
  #restore(field: HTMLInputElement): void {
    this.#writeField(field, this.#committed.get(field) ?? "");
  }

  /** Commits one field's value and the derived hook that reports it as entered. */
  #writeField(field: HTMLInputElement, value: string): void {
    this.#retained.delete(field);
    this.#endBaselines.delete(field);
    field.removeAttribute(this.#retainedMarker);
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

  /**
   * A field's text as the combined value counts it: a composing field by its committed
   * character.
   */
  #publishedText(field: HTMLInputElement): string {
    return field === this.#composition.composingElement()
      ? (this.#committed.get(field) ?? "")
      : this.#settledText(field);
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

  #syncAndDispatch(before?: string): void {
    const previous = this.#published;
    const current = this.#sync();
    const combined = current.value;
    if ((before ?? previous?.value) === combined) {
      if (previous && statesDiffer(previous, current)) {
        this.#moves.record();
        this.dispatch("reconcile", { detail: { value: combined } });
      }
      return;
    }

    const token = this.#moves.record();
    // The value published now carries every residual a late formal end would confirm
    this.#endBaselines.clear();
    this.dispatch("change", { detail: { value: combined } });
    if (!this.#moves.isLatest(token)) return;

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
      if (errorId) this.#pointAtError(field, errorId);
    }
    if (this.hasErrorTarget) this.#errorHidden.write(this.errorTarget, null);

    // Behavior only: emit a neutral payload and let the consumer compose/localize
    // the user-facing message. The pattern is reported so consumers can word it.
    this.dispatch("invalid", { detail: { pattern: this.#patternSource } });
  }

  /** Points one field's error message and description at the error target `errorId` names. */
  #pointAtError(field: HTMLInputElement, errorId: string): void {
    const earlier = readLease(field, LEASE_MARKERS["aria-errormessage"])?.written ?? null;
    this.#lease(field, "aria-errormessage", errorId);
    // Assistive tech without aria-errormessage support still reads a description
    const described = field.getAttribute("aria-describedby");
    this.#lease(field, "aria-describedby", describedByWith(described, errorId, earlier));
  }

  /**
   * While connected, brings the error targets in line with the report the fields carry. A
   * report still standing — the fields it marked invalid carry their record — moves onto the
   * error target that is now first: it shows, and those fields point at it. With nothing
   * reported, the first error target is hidden and any other gives its own `hidden` back.
   * Nothing is dispatched.
   */
  #followError(): void {
    if (!this.#connected) return;
    const reported = this.fieldTargets.filter(
      (field) => readLease(field, LEASE_MARKERS["aria-invalid"]) !== null,
    );
    if (reported.length === 0) {
      this.#hideErrors();
      return;
    }
    if (!this.hasErrorTarget) return;
    const errorId = ensureId(this.errorTarget, "stimeo--otp-error");
    for (const field of reported) this.#pointAtError(field, errorId);
    this.#errorHidden.write(this.errorTarget, null);
  }

  /**
   * Ends a report: every field's error attributes go back to what the author wrote. While
   * connected the first error target is hidden again and any other gives its own `hidden`
   * back; teardown gives every error target its own `hidden` back.
   */
  #clearError(): void {
    for (const field of this.fieldTargets) this.#returnLeases(field);
    if (!this.#connected) {
      this.#errorHidden.returnAll();
      return;
    }
    this.#hideErrors();
  }

  /** Hides the first error target and gives any other its own `hidden` back. */
  #hideErrors(): void {
    const [first, ...others] = this.errorTargets;
    for (const other of others) this.#errorHidden.return(other);
    if (first) this.#errorHidden.write(first, "");
  }
}
