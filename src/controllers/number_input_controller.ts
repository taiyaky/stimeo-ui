import { Controller } from "@hotwired/stimulus";
import { hasModifierChord, isReservedArrowChord } from "../utils/arrow_step";
import { AttributeLease } from "../utils/attribute_lease";
import { BlurDeferral } from "../utils/blur_deferral";
import { CompositionTracker } from "../utils/composition_tracker";
import { commitField } from "../utils/field_mirror";
import { toHalfWidth } from "../utils/half_width";
import { ListenerSet } from "../utils/listener_set";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import { MoveCounter } from "../utils/move_counter";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { SafeInterval, SafeTimeout } from "../utils/safe_timeout";
import { type SteppedRange, snapSteppedValue, stepSteppedValue } from "../utils/stepped_value";

/** Marks a `disabled` state derived and therefore removable by this controller. */
const OWNED_DISABLED = "data-number-input-disabled";

/** Whether `shown` steps through the same values as `declared`. */
const sameRange = (shown: SteppedRange | undefined, declared: SteppedRange): boolean =>
  shown?.min === declared.min && shown.max === declared.max && shown.step === declared.step;

/**
 * Headless, accessible number / spin-button behavior.
 *
 * Markup contract (identifier: `stimeo--number-input`):
 *   <div data-controller="stimeo--number-input"
 *        data-stimeo--number-input-min-value="0"
 *        data-stimeo--number-input-max-value="100"
 *        data-stimeo--number-input-step-value="1">
 *     <button type="button" aria-label="Decrease" tabindex="-1"
 *             data-stimeo--number-input-target="decrement"
 *             data-action="click->stimeo--number-input#decrement">−</button>
 *     <input type="number" min="0" max="100" step="1" value="0"
 *            data-stimeo--number-input-target="input"
 *            data-action="change->stimeo--number-input#onInput
 *                         keydown->stimeo--number-input#onKeydown" />
 *     <button type="button" aria-label="Increase" tabindex="-1"
 *             data-stimeo--number-input-target="increment"
 *             data-action="click->stimeo--number-input#increment">+</button>
 *   </div>
 *
 * Implements the WAI-ARIA APG **Spinbutton** pattern. The arrow/step logic is
 * fully owned by the controller (not delegated to the browser's native number
 * stepping) so the behavior is identical for a native `<input type="number">` and
 * a custom `role="spinbutton"` host. Owning the stepping also means owning its
 * report: a step the user takes through a button, an arrow key or a press-and-hold
 * is written from script, which fires nothing, so the input reports it the way the
 * browser reports its own — one bubbling `input`, then one bubbling `change`, ahead
 * of this controller's `change`. Typing is bound to the native `change`, which the
 * browser has already reported, and is left alone. The two reports answer to
 * different questions: the native pair follows the *field's text*, the way a
 * browser reports its own control, so a step away from an entry the widget never
 * accepted is reported even though the settled number did not move; `change`
 * follows the *number*, and means the user settled on one.
 *
 * `change` dispatches `{ value: number }`; `reconcile` dispatches `{ value: number }`.
 *
 * All published state is settled before its reports. A synchronous listener
 * that confirms another value leaves that newer confirmation to report itself;
 * reports still pending for the replaced value are not sent. A read-only listener
 * or a confirmation that moves no published value leaves pending reports intact.
 * An event already being dispatched still reaches its remaining listeners.
 *
 * @remarks
 * Behavior only — the consumer styles the field and buttons. The input is the
 * sole Tab stop; the buttons are `tabindex="-1"` and keep focus on the input
 * (pointerdown is suppressed), so stepping never moves focus away.
 *
 * Behavior provided:
 * - `ArrowUp`/`ArrowDown` step by `step`; `PageUp`/`PageDown` by `pageStep`
 *   (default `step × 10`); `Home`/`End` jump to a finite `min`/`max`.
 * - Increment/decrement buttons step too, and are `disabled` at the bounds (focus
 *   is returned to the input before a focused button is disabled).
 * - **Press-and-hold auto-repeat**: holding a step button starts repeated steps
 *   after a short delay until release, the bound is reached, or the element
 *   disconnects. The `click` binding stays the single-step path (a quick click, a
 *   synthesized/programmatic click, or assistive activation), so a normal click
 *   never double-steps — the trailing click after a hold is swallowed.
 * - Typed input is clamped and snapped to the step grid on `change`;
 *   `stimeo--number-input:change` is dispatched once for each changed committed
 *   numeric value with `{ value: number }` detail. When a change the page makes —
 *   a runtime `min`/`max`/`step` that pulls the committed value with it, or an
 *   input swapped in holding another number — moves the number shown, that same
 *   detail arrives as `stimeo--number-input:reconcile` instead, so a consumer can
 *   tell its own edit from the page's. Both are measured from the number shown
 *   last, which a blank field leaves empty and a missing input leaves as it was.
 *   The same instance keeps that number when it connects again — after an
 *   in-page move, say — and takes a new one without a report from an input that
 *   is present unless that same input still carries focused, unconfirmed typing.
 *   A new instance starts with none. Neither event fires on connect. A runtime change
 *   that arrives while the input is composing (IME) leaves the uncommitted text alone.
 * - Text the user typed or a composition left stays a draft, separate from the
 *   accepted text, until the field reports change or a widget step confirms it.
 *   While the same input holds focus and that draft, morphs, reconnections and the
 *   input leaving the targets and coming back preserve its text and selection, and
 *   restore only accepted ARIA and button state; the input losing focus while the controller
 *   cannot see it ends the draft. Range declarations wait:
 *   confirmation applies the latest range once, reports a changed number as change,
 *   and adds no reconcile or native report to the browser's own change. A draft that
 *   returns to the accepted text ends, and a range that waited is reconciled then.
 *   A different page write ends this draft's protection; an identical write gives
 *   no evidence of a different origin. A replacement input is reconciled normally.
 * - A text-type spinbutton's text is read through the half-width mapping, so
 *   full-width digits and signs an IME confirms (`３４`, `－５`) count as the number
 *   they show, and the field is written back in half-width.
 * - `step` must be finite and positive; invalid runtime input falls back to `1`,
 *   while finite range endpoints remain reachable off the grid.
 */
export class NumberInputController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  readonly #moves = new MoveCounter();
  #move = 0;

  static override targets = ["input", "increment", "decrement"];
  static override values = {
    min: { type: Number, default: Number.NEGATIVE_INFINITY },
    max: { type: Number, default: Number.POSITIVE_INFINITY },
    step: { type: Number, default: 1 },
    pageStep: { type: Number, default: 0 },
  };

  static valueConstraints = {
    min: NUMBER_BOUNDS.lowerBound,
    max: NUMBER_BOUNDS.upperBound,
    step: NUMBER_BOUNDS.positive,
    pageStep: NUMBER_BOUNDS.nonNegative,
  } satisfies NumberValueConstraints<typeof NumberInputController.values>;
  static actions = ["decrement", "increment", "onInput", "onKeydown"] as const;
  static events = ["change", "reconcile"] as const;

  declare readonly inputTarget: HTMLInputElement;
  declare readonly inputTargets: HTMLInputElement[];
  declare readonly hasInputTarget: boolean;
  declare readonly incrementTarget: HTMLButtonElement;
  declare readonly incrementTargets: HTMLButtonElement[];
  declare readonly hasIncrementTarget: boolean;
  declare readonly decrementTarget: HTMLButtonElement;
  declare readonly decrementTargets: HTMLButtonElement[];
  declare readonly hasDecrementTarget: boolean;
  declare minValue: number;
  declare maxValue: number;
  declare stepValue: number;
  declare pageStepValue: number;

  /** Delay (ms) a button must be held before auto-repeat starts. */
  static readonly #HOLD_DELAY_MS = 400;
  /** Interval (ms) between auto-repeat steps once a hold has started. */
  static readonly #HOLD_REPEAT_MS = 80;
  /**
   * Window (ms) after a hold ends during which the trailing synthetic `click` is
   * swallowed. A safety net for the (rare) case where that click never arrives
   * (e.g. the pointer was released off the button): the flag self-clears instead
   * of poisoning the next legitimate click.
   */
  static readonly #SUPPRESS_RESET_MS = 250;

  /**
   * The pointer, focus, typing and morph-value listeners of one connection, released on
   * `disconnect()` so none outlive the element.
   */
  readonly #listeners = new ListenerSet();
  /** Per-target guards allow an old button to be released without touching its replacement. */
  readonly #buttonGuards = new Map<HTMLButtonElement, AbortController>();
  /**
   * Tracks IME lifecycle on the current input, including confirming keys without a
   * signal. A reconciliation that arrives while the input composes is held. The text
   * the composition leaves — confirmed, cancelled, or left when the engine stopped
   * composing — is the user's draft while it differs from the accepted text, so the
   * held reconciliation waits for its confirmation; back at the accepted text it runs
   * once the composition ends: after `compositionend`, or at once when a write ended
   * the composition without one.
   */
  readonly #composition = new CompositionTracker({
    onEnd: (event) => {
      if (this.hasInputTarget && event.target === this.inputTarget) {
        this.#recordDraft(this.inputTarget);
      }
    },
    onAbandon: () => {
      if (this.#reconcileHeld) this.#reconcile();
    },
  });
  /** A reconciliation owed once editing ends: the range changed while it ran. */
  #reconcileHeld = false;
  /** Restores authored custom-spinbutton ARIA when a target leaves or the controller stops. */
  readonly #ariaValueNow = new AttributeLease<HTMLInputElement>("aria-valuenow", this.identifier);
  readonly #ariaValueMin = new AttributeLease<HTMLInputElement>("aria-valuemin", this.identifier);
  readonly #ariaValueMax = new AttributeLease<HTMLInputElement>("aria-valuemax", this.identifier);
  /**
   * The number shown last — reconciled or committed by the user — which the next
   * move is measured from; `null` while the field is blank, and before this
   * instance has shown one. A disconnect keeps it for the same instance
   * connecting again.
   */
  #lastValue: number | null = null;
  /** The text accepted from one input, separate from its unconfirmed typing. */
  #accepted: { readonly input: HTMLInputElement; readonly text: string } | null = null;
  /** The last non-composing input's text, retained through a focused reconnection. */
  #draft: { readonly input: HTMLInputElement; readonly text: string } | null = null;
  /**
   * Watches the input a draft is left in while the controller cannot see it — disconnected,
   * or the input out of its targets — so losing focus meanwhile ends the draft, as it ends
   * editing in sight, and the field that comes back is the page's. The watch lasts until
   * that input blurs or the controller sees an input again — across a disconnection too:
   * nothing else sees that focus leave. The window losing focus keeps the draft and the
   * watch. In sight, editing follows focus as each pass finds it.
   */
  readonly #parked = new BlurDeferral<HTMLInputElement>((input) => {
    if (document.activeElement === input) this.#parked.defer(input);
    else if (this.#draft?.input === input) this.#draft = null;
  });
  /**
   * What the ARIA and the buttons show: the input they were shown for, the number
   * shown, the number the buttons are set for, and the range both were set in. A pass
   * that meets a conversion in that same input shows it again and compares the range.
   */
  #shown: {
    readonly input: HTMLInputElement;
    readonly value: number | null;
    readonly at: number;
    readonly range: SteppedRange;
  } | null = null;
  /**
   * Whether `connect()` has run and `disconnect()` has not since. The pass
   * `connect()` runs takes the baseline without reporting it.
   */
  #connected = false;
  /** Timers for the hold delay and the suppress-reset safety net. */
  readonly #holdTimeouts = new SafeTimeout();
  /** The running auto-repeat interval (one at a time). */
  readonly #holdIntervals = new SafeInterval();
  /** True while a hold is armed/running, making `#stopHold` idempotent. */
  #holdActive = false;
  /** Counts holds armed and stopped, so a step that outlived its hold arms nothing. */
  #holdGeneration = 0;
  /** True once a hold actually produced a repeated step (vs. a quick click). */
  #repeatedDuringHold = false;
  /** True when the next `click` is the trailing one after a hold and must be ignored. */
  #suppressNextClick = false;
  /** Button and pointer that own the current hold, so other instances/pointers cannot end it. */
  #holdButton: HTMLButtonElement | null = null;
  #holdPointerId: number | null = null;
  /** Collapses runtime range/step changes into one input reconciliation. */
  readonly #repaint = new MorphRenderWatcher(() => this.#reconcile());

  /** Normalizes any initial value and wires the focus/hold pointer guards. */
  override connect(): void {
    this.#repaint.observe(this.element);
    for (const button of this.incrementTargets) this.#wireButton(button, 1);
    for (const button of this.decrementTargets) this.#wireButton(button, -1);
    // A pointer released or focus lost anywhere stops a running hold, even when
    // the button stopped receiving its own pointerup (e.g. it became disabled at
    // the bound, or the pointer was released off it).
    this.#listeners.add(window, "pointerup", this.#onPointerEnd);
    this.#listeners.add(window, "pointercancel", this.#onPointerEnd);
    this.#listeners.add(window, "blur", this.#onWindowBlur);
    this.#listeners.add(this.element, "input", this.#onDraftInput);
    this.#listeners.add(this.element, "turbo:before-morph-attribute", this.#onBeforeMorphAttribute);
    // An input that moved here with its conversion has nothing new to read; the pass
    // waits for the conversion only if the range changed with the move.
    this.#reconcile();
    this.#connected = true;
  }

  /**
   * Releases listeners, derived attributes, timers, and the hold state. The number
   * shown last stays: the pass the next `connect()` runs takes a new one without a
   * report from a non-editing input that is present; the same focused draft keeps its
   * accepted number. With none it stays the number an
   * input arriving later is compared with.
   */
  override disconnect(): void {
    this.#connected = false;
    this.#repaint.disconnect();
    this.#composition.disconnect();
    this.#listeners.dispose();
    if (this.#draft?.input !== document.activeElement) this.#draft = null;
    if (this.#draft !== null) this.#parked.deferOnly(this.#draft.input);
    const buttons = new Set([
      ...this.#buttonGuards.keys(),
      ...this.incrementTargets,
      ...this.decrementTargets,
    ]);
    for (const guard of this.#buttonGuards.values()) guard.abort();
    this.#buttonGuards.clear();
    for (const button of buttons) this.#releaseButtonState(button);
    this.#stopHold(false);
    this.#repeatedDuringHold = false;
    this.#suppressNextClick = false;
    this.#holdTimeouts.clearAll();
    this.#ariaValueNow.returnAll();
    this.#ariaValueMin.returnAll();
    this.#ariaValueMax.returnAll();
  }

  /** Reconciles the value against a minimum changed by application code or a Turbo morph. */
  minValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Reconciles the value against a maximum changed by application code or a Turbo morph. */
  maxValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Reconciles the value against a step changed by application code or a Turbo morph. */
  stepValueChanged(): void {
    this.#repaint.schedule();
  }

  /**
   * Tracks and reconciles an input inserted or replaced at runtime. One that moved
   * here keeping its conversion is the same input: the pass shows what it showed and
   * holds nothing.
   */
  inputTargetConnected(input: HTMLInputElement): void {
    this.#composition.observe(input);
    this.#repaint.schedule();
  }

  /**
   * Releases ARIA and composition state owned by an input that left the controller.
   * The number it showed stays the baseline, so an input swapped in holding another
   * number is reported as `reconcile`. An input that moved keeping focus keeps its
   * conversion and stays the input, so nothing is released.
   */
  inputTargetDisconnected(input: HTMLInputElement): void {
    const composing = this.#composition.composingElement() === input;
    this.#composition.unobserve(input);
    if (
      composing &&
      this.#composition.composingElement() === input &&
      this.inputTargets.includes(input)
    ) {
      return;
    }
    this.#releaseInputAria(input);
    this.#stopHold(false);
    this.#repaint.schedule();
  }

  /** Wires focus preservation and hold behavior on a runtime increment target. */
  incrementTargetConnected(button: HTMLButtonElement): void {
    this.#wireButton(button, 1);
    this.#repaint.schedule();
  }

  /** Releases only the increment target that actually disconnected. */
  incrementTargetDisconnected(button: HTMLButtonElement): void {
    this.#unwireButton(button);
  }

  /** Wires focus preservation and hold behavior on a runtime decrement target. */
  decrementTargetConnected(button: HTMLButtonElement): void {
    this.#wireButton(button, -1);
    this.#repaint.schedule();
  }

  /** Releases only the decrement target that actually disconnected. */
  decrementTargetDisconnected(button: HTMLButtonElement): void {
    this.#unwireButton(button);
  }

  /** Increases by one step. Bound via `data-action` (click). */
  increment(): void {
    if (this.#consumeSuppressedClick()) return;
    if (!this.hasInputTarget) return;
    this.#commitStep(1);
    this.inputTarget.focus();
  }

  /** Decreases by one step. Bound via `data-action` (click). */
  decrement(): void {
    if (this.#consumeSuppressedClick()) return;
    if (!this.hasInputTarget) return;
    this.#commitStep(-1);
    this.inputTarget.focus();
  }

  /**
   * Records what the user types or composes in the focused input as a draft, without
   * making it a numeric confirmation.
   */
  readonly #onDraftInput = (event: Event): void => {
    if (!this.hasInputTarget) return;
    const input = this.inputTarget;
    if (event.target !== input || document.activeElement !== input) return;
    this.#recordDraft(input);
  };

  /**
   * Takes `input`'s text as the user's draft while it differs from the accepted text;
   * back at the accepted text, the draft ends and a held reconciliation resumes.
   */
  #recordDraft(input: HTMLInputElement): void {
    this.#draft =
      this.#accepted?.input === input && input.value !== this.#accepted.text
        ? { input, text: input.value }
        : null;
    if (this.#draft === null) this.#resumeHeldReconcile();
  }

  /** A value morph cannot replace text the user is still editing in this input. */
  readonly #onBeforeMorphAttribute = (event: Event): void => {
    if (!this.hasInputTarget || event.target !== this.inputTarget) return;
    const detail = (event as CustomEvent<{ attributeName?: string }>).detail;
    if (detail?.attributeName === "value" && this.#isEditing(this.inputTarget))
      event.preventDefault();
  };

  /** Distinguishes the observed draft from a later, different page write. */
  #isEditing(input: HTMLInputElement): boolean {
    return (
      this.#draft?.input === input &&
      this.#accepted?.input === input &&
      document.activeElement === input &&
      input.value === this.#draft.text &&
      input.value !== this.#accepted.text
    );
  }

  /** Clamps and snaps a typed value. Bound via `data-action` (change). */
  onInput(): void {
    if (!this.hasInputTarget) return;
    if (this.inputTarget.value.trim() === "") {
      this.#lastValue = null;
      this.#reflectEmpty();
      return;
    }
    this.#commit(this.#currentValue());
  }

  /** Keyboard stepping per the APG spinbutton model. */
  onKeydown(event: KeyboardEvent): void {
    if (!this.hasInputTarget) return;
    if (this.#composition.isComposing(event)) return;
    if (isReservedArrowChord(event)) return;
    if (
      (event.key === "Home" ||
        event.key === "End" ||
        event.key === "PageUp" ||
        event.key === "PageDown") &&
      hasModifierChord(event)
    )
      return;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowUp":
        next = stepSteppedValue(this.#currentValue(), 1, this.#steppedRange);
        break;
      case "ArrowDown":
        next = stepSteppedValue(this.#currentValue(), -1, this.#steppedRange);
        break;
      case "PageUp":
        next =
          this.#safePageStep > 0
            ? this.#currentValue() + this.#safePageStep
            : stepSteppedValue(this.#currentValue(), 10, this.#steppedRange);
        break;
      case "PageDown":
        next =
          this.#safePageStep > 0
            ? this.#currentValue() - this.#safePageStep
            : stepSteppedValue(this.#currentValue(), -10, this.#steppedRange);
        break;
      case "Home":
        if (!Number.isFinite(this.#safeMin)) return;
        next = this.#safeMin;
        break;
      case "End":
        if (!Number.isFinite(this.#safeMax)) return;
        next = this.#safeMax;
        break;
      default:
        return;
    }
    event.preventDefault();
    // `preventDefault` stops the browser's own stepping, so the edit below is
    // entirely this widget's and nothing else will report it.
    this.#commit(next, true);
  }

  /**
   * Wires a step button: `pointerdown` keeps focus on the input and arms the
   * hold; leaving the button while held stops it (the global listeners cover
   * release/cancel/blur).
   *
   * @stimeoListenerLifetime element each button holds a guard of its own, which
   *   `#unwireButton` aborts when that button leaves and `disconnect()` aborts for all;
   *   a button already wired is skipped, so a second wiring makes no second guard.
   */
  #wireButton(button: HTMLButtonElement, direction: number): void {
    if (this.#buttonGuards.has(button)) return;
    const guard = new AbortController();
    this.#buttonGuards.set(button, guard);
    button.addEventListener("pointerdown", (event) => this.#armHold(event, button, direction), {
      signal: guard.signal,
    });
    button.addEventListener(
      "pointerleave",
      (event) => {
        if (this.#holdButton === button && this.#ownsPointer(event)) this.#stopHold();
      },
      { signal: guard.signal },
    );
  }

  /** Aborts one target's listeners and returns any state derived onto that button. */
  #unwireButton(button: HTMLButtonElement): void {
    this.#buttonGuards.get(button)?.abort();
    this.#buttonGuards.delete(button);
    if (this.#holdButton === button) this.#stopHold(false);
    this.#releaseButtonState(button);
  }

  /** Starts a hold: focus the input, then schedule the first repeat after a delay. */
  #armHold(event: Event, button: HTMLButtonElement, direction: number): void {
    // Ignore secondary buttons (right/middle) when the event exposes one.
    const pointerButton = (event as PointerEvent).button;
    if (typeof pointerButton === "number" && pointerButton !== 0) return;
    if (button.disabled || !this.hasInputTarget) return;
    event.preventDefault(); // keep focus on the input rather than the button
    this.inputTarget.focus();

    this.#stopHold(false);
    this.#holdActive = true;
    this.#holdButton = button;
    this.#holdPointerId = this.#pointerId(event);
    this.#repeatedDuringHold = false;
    this.#suppressNextClick = false;
    const generation = ++this.#holdGeneration;
    this.#holdTimeouts.set(() => {
      // A listener on the step's reports may end this hold or arm another one.
      if (!this.#commitStep(direction) || generation !== this.#holdGeneration) return;
      this.#repeatedDuringHold = true;
      this.#holdIntervals.set(() => {
        if (!this.#commitStep(direction)) this.#stopHold();
      }, NumberInputController.#HOLD_REPEAT_MS);
    }, NumberInputController.#HOLD_DELAY_MS);
  }

  /**
   * Stops the current hold (idempotent). When the hold actually repeated, the
   * trailing synthetic `click` must be ignored, so it is suppressed until the
   * click consumes it or a short safety-net timeout clears it.
   */
  #stopHold(suppressTrailingClick = true): void {
    if (!this.#holdActive) return;
    this.#holdActive = false;
    this.#holdGeneration += 1;
    this.#holdButton = null;
    this.#holdPointerId = null;
    this.#holdTimeouts.clearAll();
    this.#holdIntervals.clearAll();
    if (suppressTrailingClick && this.#repeatedDuringHold) {
      this.#suppressNextClick = true;
      this.#holdTimeouts.set(() => {
        this.#suppressNextClick = false;
      }, NumberInputController.#SUPPRESS_RESET_MS);
    }
  }

  /** Ends a hold only for its initiating pointer (legacy/synthetic events remain accepted). */
  readonly #onPointerEnd = (event: Event): void => {
    if (this.#ownsPointer(event)) this.#stopHold();
  };

  /** Window deactivation is global and always ends the active hold. */
  readonly #onWindowBlur = (): void => {
    this.#stopHold();
  };

  /** Extracts pointer identity when the runtime event exposes it. */
  #pointerId(event: Event): number | null {
    return (event as Partial<PointerEvent>).pointerId ?? null;
  }

  /** Whether `event` belongs to the active pointer, with a synthetic-event fallback. */
  #ownsPointer(event: Event): boolean {
    const pointerId = this.#pointerId(event);
    return (
      this.#holdActive &&
      (this.#holdPointerId === null || pointerId === null || pointerId === this.#holdPointerId)
    );
  }

  /** Consumes a pending trailing-click suppression; returns true if the click was swallowed. */
  #consumeSuppressedClick(): boolean {
    if (!this.#suppressNextClick) return false;
    this.#suppressNextClick = false;
    this.#holdTimeouts.clearAll();
    return true;
  }

  /**
   * Normalizes `raw`, reflects it, and dispatches `{ value: number }` only when
   * the committed numeric value differs from the last reconciled value.
   *
   * @returns Whether the value changed (drives the auto-repeat's bound stop).
   */
  #commit(raw: number, report = false): boolean {
    const value = this.#normalize(raw);
    const changed = this.#lastValue === null || value !== this.#lastValue;
    // The two reports answer to different questions. The browser reports what its
    // control shows, so the native pair follows the field's own text — a step away
    // from an entry the widget never accepted moves that text even when the
    // settled number does not. `change` means the user settled on a number, so it
    // follows the number.
    const shown = this.inputTarget.value;
    this.#lastValue = value;
    if (changed) this.#move = this.#moves.record();
    const move = this.#move;
    this.#write(value);
    if (!this.#moves.isLatest(move)) return changed;
    if (report && shown !== this.inputTarget.value) {
      const input = this.inputTarget;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      if (!this.#moves.isLatest(move)) return changed;
      commitField(input);
    }
    if (!this.#moves.isLatest(move)) return changed;
    if (changed) this.dispatch("change", { detail: { value } });
    return changed;
  }

  /** Commits an adjacent endpoint/grid value and reports whether it moved. */
  #commitStep(count: number): boolean {
    if (!this.hasInputTarget) return false;
    return this.#commit(stepSteppedValue(this.#currentValue(), count, this.#steppedRange), true);
  }

  /** Schedules a held reconciliation when ordinary editing or composition ends. */
  #resumeHeldReconcile(): void {
    if (this.#reconcileHeld) this.#repaint.schedule();
  }

  /**
   * Reflects the current value after a range, step or input change, reporting a
   * number that moved from the one shown last as `reconcile`. While the input is
   * composing, its text is the IME's: the pass shows what it showed again, in the range
   * it showed it in, so ARIA and the buttons a morph wiped or swapped in come back, and
   * is owed when the composition ends only if the range changed; a pass with nothing
   * new to reconcile against holds nothing. An input that comes first again while it
   * composes, after another input was shown, has shown nothing of its own since: the
   * pass shows nothing on it and is owed when its composition ends. A conversion going
   * on in an input that is no longer the first leaves the one first now to be
   * reconciled at once. With no
   * input there is nothing to show, and the number shown last stays the baseline for
   * the input that comes next.
   *
   * A draft in the same focused input — typed, or left by a composition — keeps its
   * accepted number and range: only their display is restored, and no queued pass
   * reads or normalizes the draft. Returning to the accepted text ends the draft and
   * resumes any held range. A composition takes over the text while it runs. Once
   * that text is accepted, a pass with the same text and range only shows it again.
   * With no input, a draft whose input keeps focus stays, so the same field coming
   * back is still being edited.
   *
   * A field the user is in keeps its caret where it was. The pass can land right
   * before an edit — a composition the page's write ended shows only then — and
   * the edit lands where the user put the caret.
   *
   * @stimeoRenderRoot
   */
  #reconcile(): void {
    if (!this.hasInputTarget) {
      // An input that left the targets keeping focus may come back as the same field.
      if (this.#draft?.input !== document.activeElement) this.#draft = null;
      if (this.#draft !== null) this.#parked.deferOnly(this.#draft.input);
      return;
    }
    this.#parked.releaseAll();
    const previous = this.#lastValue;
    const input = this.inputTarget;
    if (this.#composition.composingElement() === input || this.#isEditing(input)) {
      const shown = this.#shown?.input === input ? this.#shown : null;
      this.#reconcileHeld = shown === null || !sameRange(shown.range, this.#steppedRange);
      // Editing owns the text: a morph that wiped the ARIA gets back what it showed.
      if (shown !== null) this.#show(shown.value, shown.at, shown.range);
    } else {
      this.#draft = null;
      this.#reconcileHeld = false;
      const shown = this.#shown;
      if (
        shown !== null &&
        this.#accepted?.input === input &&
        input.value === this.#accepted.text &&
        sameRange(shown.range, this.#steppedRange)
      ) {
        const move = this.#move;
        this.#show(shown.value, shown.at, shown.range);
        if (!this.#moves.isLatest(move)) return;
      } else if (input.value.trim() !== "") {
        const value = this.#normalize(this.#currentValue());
        this.#lastValue = value;
        const move = this.#move;
        this.#write(value, true);
        if (!this.#moves.isLatest(move)) return;
      } else {
        this.#lastValue = null;
        this.#reflectEmpty();
      }
    }
    // A pass that only showed the number again moved nothing, so this reports nothing.
    this.#reportMove(previous);
  }

  /**
   * Reports the number shown as `reconcile` when a change the page made moved it
   * from `previous`. The page moved it, so it is reported apart from `change`,
   * which stays reserved for user edits. A blank field reports nothing, the way a
   * user blanking it does: both events carry a number.
   */
  #reportMove(previous: number | null): void {
    const value = this.#lastValue;
    if (!this.#connected || value === null || value === previous) return;
    this.dispatch("reconcile", { detail: { value } });
  }

  /**
   * Reflects `value` on the input (and ARIA for non-native hosts) and the buttons.
   * With `keepCaret`, rewriting the field the user is in keeps the caret where it
   * was; otherwise the browser places it.
   */
  #write(value: number, keepCaret = false): void {
    const input = this.inputTarget;
    const text = String(value);
    if (input.value !== text) {
      const caret = keepCaret && input === document.activeElement ? input.selectionStart : null;
      input.value = text;
      // A host that exposes no caret reports none, and takes no selection either.
      if (caret !== null) {
        const position = Math.min(caret, text.length);
        input.setSelectionRange(position, position);
      }
    }
    this.#draft = null;
    // The latest range is applied here, so no reconciliation is owed any longer.
    this.#reconcileHeld = false;
    this.#accepted = { input, text };
    this.#show(value, value);
  }

  /** Reflects `value` in ARIA and the buttons, set for `at`, in `range`. */
  #show(value: number | null, at: number, range = this.#steppedRange): void {
    this.#shown = { input: this.inputTarget, value, at, range };
    this.#syncInputAria(this.inputTarget, value, range);
    this.#updateButtons(at, range);
  }

  /** Reflects a blank value without inventing a numeric `aria-valuenow`. */
  #reflectEmpty(): void {
    this.#draft = null;
    this.#reconcileHeld = false;
    this.#accepted = { input: this.inputTarget, text: this.inputTarget.value };
    this.#show(null, this.#currentValue());
  }

  /** Synchronizes controller-derived ARIA while preserving authored teardown values. */
  #syncInputAria(input: HTMLInputElement, value: number | null, range: SteppedRange): void {
    if (input.getAttribute("role") !== "spinbutton") {
      this.#releaseInputAria(input);
      return;
    }
    this.#ariaValueNow.write(input, value === null ? null : String(value));
    this.#ariaValueMin.write(input, Number.isFinite(range.min) ? String(range.min) : null);
    this.#ariaValueMax.write(input, Number.isFinite(range.max) ? String(range.max) : null);
  }

  /** Returns all custom-spinbutton ARIA leased on `input`. */
  #releaseInputAria(input: HTMLInputElement): void {
    this.#ariaValueNow.return(input);
    this.#ariaValueMin.return(input);
    this.#ariaValueMax.return(input);
  }

  /** Disables a step button at a bound of `range`, returning focus to the input first. */
  #updateButtons(value: number, range: SteppedRange): void {
    const move = this.#move;
    for (const button of this.incrementTargets) {
      this.#toggleButton(button, value < range.max, move);
      if (!this.#moves.isLatest(move)) return;
    }
    for (const button of this.decrementTargets) {
      this.#toggleButton(button, value > range.min, move);
      if (!this.#moves.isLatest(move)) return;
    }
  }

  /**
   * Enables or disables a step button at its bound, never disabling one while it
   * holds focus. Owns only the `disabled` it sets itself, recorded by the
   * `data-number-input-disabled` marker, so an author-disabled button (e.g. the whole
   * control disabled) is never re-enabled.
   */
  #toggleButton(button: HTMLButtonElement, enabled: boolean, move: number): void {
    if (enabled) {
      if (button.hasAttribute(OWNED_DISABLED)) {
        button.disabled = false;
        button.removeAttribute(OWNED_DISABLED);
      }
      return;
    }
    if (button.disabled) return; // already disabled (possibly by the author) — leave it
    if (document.activeElement === button && this.hasInputTarget) this.inputTarget.focus();
    if (!this.#moves.isLatest(move)) return;
    button.disabled = true;
    button.setAttribute(OWNED_DISABLED, "");
  }

  /** Returns `disabled` only when its explicit marker still identifies controller ownership. */
  #releaseButtonState(button: HTMLButtonElement): void {
    if (!button.hasAttribute(OWNED_DISABLED)) return;
    button.disabled = false;
    button.removeAttribute(OWNED_DISABLED);
  }

  /**
   * The current numeric value, falling back to a finite min (else 0) when blank.
   * Every read of the field's number comes through here, and the text is read
   * through the shared half-width mapping: a text-type spinbutton holds whatever an
   * IME confirmed, full-width digits and signs included (`３４`, `－５`), while a
   * native number field's value is already half-width or empty.
   */
  #currentValue(): number {
    const text = toHalfWidth(this.inputTarget.value);
    const parsed = Number(text);
    if (Number.isFinite(parsed) && text.trim() !== "") return parsed;
    return Number.isFinite(this.#safeMin) ? this.#safeMin : 0;
  }

  /** Clamps to `[min, max]` and snaps to the step grid anchored at a finite min (else 0). */
  #normalize(raw: number): number {
    return snapSteppedValue(raw, this.#steppedRange);
  }

  /** Shared range configuration; finite endpoints remain allowed off the grid. */
  get #steppedRange() {
    return { min: this.#safeMin, max: this.#safeMax, step: this.#safeStep };
  }
  /** Current `min` declaration resolved against its numeric contract. */
  get #safeMin(): number {
    return this.#numbers.read(
      this,
      "min",
      this.minValue,
      NumberInputController.values.min.default,
      NumberInputController.valueConstraints.min,
    );
  }

  /** Current `max` declaration resolved against its numeric contract. */
  get #safeMax(): number {
    return this.#numbers.read(
      this,
      "max",
      this.maxValue,
      NumberInputController.values.max.default,
      NumberInputController.valueConstraints.max,
    );
  }

  /** Current `step` declaration resolved against its numeric contract. */
  get #safeStep(): number {
    return this.#numbers.read(
      this,
      "step",
      this.stepValue,
      NumberInputController.values.step.default,
      NumberInputController.valueConstraints.step,
    );
  }

  /** Current `pageStep` declaration resolved against its numeric contract. */
  get #safePageStep(): number {
    return this.#numbers.read(
      this,
      "pageStep",
      this.pageStepValue,
      NumberInputController.values.pageStep.default,
      NumberInputController.valueConstraints.pageStep,
    );
  }
}
