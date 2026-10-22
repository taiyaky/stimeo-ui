import { Controller } from "@hotwired/stimulus";
import { hasModifierChord, isReservedArrowChord, logicalArrowKey } from "../utils/arrow_step";
import { setAttributeIfChanged } from "../utils/attribute_write";
import { AuthoredMutationWatcher } from "../utils/authored_mutation_watcher";
import { commitField, writeField } from "../utils/field_mirror";
import { ListenerSet } from "../utils/listener_set";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import { MoveCounter } from "../utils/move_counter";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { targetSelector } from "../utils/target_selector";

/** A time segment kind, as declared by `data-segment` on each spinbutton. */
type SegmentKind = "hour" | "minute" | "second" | "meridiem";

/** The numeric hour presentation, independent of labels and canonical time. */
type HourMode = "h11" | "h12" | "h23";

/** Canonical controller state. Hours are always stored on the 24-hour clock. */
interface TimeState {
  hour: number;
  minute: number;
  second: number;
}

/** Meridiem encoding exposed through the meridiem spinbutton. */
const AM = 0;
const PM = 1;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;

/**
 * Headless, accessible **time picker** behavior. Each segment (hour, minute,
 * optional second, optional AM/PM) is an APG **Spinbutton**; the controller
 * composes them into an `HH:MM[:SS]` value mirrored to an optional hidden field.
 *
 * Markup contract (identifier: `stimeo--time-picker`):
 *   <div data-controller="stimeo--time-picker"
 *        data-stimeo--time-picker-hour-cycle-value="24"
 *        role="group" aria-label="Time">
 *     <span role="spinbutton" aria-label="Hours" tabindex="0"
 *           aria-valuenow="9" aria-valuemin="0" aria-valuemax="23" aria-valuetext="09"
 *           data-segment="hour" data-stimeo--time-picker-target="segment"
 *           data-action="keydown->stimeo--time-picker#onKeydown">09</span>
 *     <span aria-hidden="true">:</span>
 *     <span role="spinbutton" aria-label="Minutes" tabindex="0"
 *           data-segment="minute" data-stimeo--time-picker-target="segment"
 *           data-action="keydown->stimeo--time-picker#onKeydown">30</span>
 *     <input type="hidden" data-stimeo--time-picker-target="field" />
 *   </div>
 *
 * `reconcile` dispatches `{ value: string }`.
 *
 * All published state is settled before its reports. A synchronous listener
 * that confirms another value leaves that newer confirmation to report itself;
 * reports still pending for the replaced value are not sent. A listener that
 * disconnects the controller ends the reports still pending. A read-only listener
 * or a confirmation that moves no published value leaves pending reports intact.
 * An event already being dispatched still reaches its remaining listeners.
 *
 * @remarks
 * `segment` targets declare the spinbuttons; the optional `field` target receives
 * the composed form value. `hourCycle` selects 12- or 24-hour presentation
 * (default 24), `step` is the positive integer minute step (default 1), `seconds`
 * includes seconds in the composed value (default false), and `wrap` controls
 * whether stepping crosses segment bounds (default true). The author decides
 * which optional segment targets are present; `seconds` does not create or hide
 * markup.
 *
 * Every segment is its own Tab stop (multi-tabstop, *not* roving), while
 * `ArrowLeft`/`ArrowRight` provide auxiliary movement. `ArrowUp`/`ArrowDown`
 * step the focused spinbutton; wrapping seconds or minutes carries into the next
 * unit, and 12-hour stepping crosses AM/PM at noon and midnight. Typing digits
 * enters a value directly and advances after completion. The digit buffer is
 * discarded on another action, a segment target change, a page write taken in
 * from a segment, or focus departure.
 *
 * A user action that changes the composed value dispatches one bubbling native
 * `change` from the field, when present, then one `stimeo--time-picker:change` with
 * `{ value: string }` unless a listener of that native `change` has confirmed another
 * value or disconnected the controller. Retained
 * `aria-valuenow`/`data-segment` changes, runtime targets, and
 * `hourCycle`/`seconds` Value changes are reconciled for Turbo morph
 * compatibility; when such a pass moves the composed value — dropping a `second`
 * segment, say — it reports `stimeo--time-picker:reconcile` with the same detail
 * instead, so a consumer can tell its own edit from this controller's repair.
 * Initial connection reports neither.
 * `amLabel` and `pmLabel` supply the visible and accessible meridiem text,
 * defaulting to `AM` and `PM`. Label changes preserve the composed time and
 * do not dispatch value-change events.
 * `hour12ZeroBased` selects hours 0–11 when `hourCycle` is 12; its default
 * false keeps hours 1–12. It has no effect on a 24-hour presentation.
 * A change of the hour range (`hourCycle` or `hour12ZeroBased`) discards partial
 * digit entry and preserves the instant. A 12-hour presentation without a
 * `meridiem` segment reads as morning.
 * During a simultaneous DOM update, an untouched retained hour keeps its time;
 * an explicitly written or replacement hour is read in the new range.
 */
export class TimePickerController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  readonly #moves = new MoveCounter();
  #connectionGeneration = 0;
  #move = 0;

  static override targets = ["segment", "field"];
  static override values = {
    hourCycle: { type: Number, default: 24 },
    hour12ZeroBased: { type: Boolean, default: false },
    step: { type: Number, default: 1 },
    seconds: { type: Boolean, default: false },
    wrap: { type: Boolean, default: true },
    amLabel: { type: String, default: "AM" },
    pmLabel: { type: String, default: "PM" },
  };

  static valueConstraints = {
    hourCycle: { finite: true, allowedValues: [12, 24] },
    step: NUMBER_BOUNDS.positive,
  } satisfies NumberValueConstraints<typeof TimePickerController.values>;
  static actions = ["onKeydown"] as const;
  static events = ["change", "reconcile"] as const;

  declare readonly segmentTargets: HTMLElement[];
  declare readonly fieldTarget: HTMLInputElement;
  declare readonly hasFieldTarget: boolean;
  declare hourCycleValue: number;
  declare hour12ZeroBasedValue: boolean;
  declare stepValue: number;
  declare secondsValue: boolean;
  declare wrapValue: boolean;
  declare amLabelValue: string;
  declare pmLabelValue: string;

  /**
   * Collapses target, Value, and retained-attribute morphs into one render that
   * dispatches no `change`.
   */
  readonly #reconcile = new MorphRenderWatcher(() => this.#reconcileDom());
  /** Canonical state; the displayed hour and meridiem are derived from this value. */
  #state: TimeState = { hour: 0, minute: 0, second: 0 };
  /** Direct-entry digit buffer and the segment it belongs to. */
  #typeBuffer = "";
  #typeSegment: SegmentKind | null = null;
  /** Last composed value, used to suppress duplicate user notifications. */
  #lastValue = "";
  /** Presentation provenance distinguishes untouched segments from authored writes. */
  #renderedHourMode: HourMode | null = null;
  #renderedSegments = new WeakSet<HTMLElement>();
  readonly #authoredSegments = new Set<HTMLElement>();
  readonly #observer = new AuthoredMutationWatcher((records) => {
    if (!this.#recordAuthoredSegments(records)) return;
    this.#reconcile.schedule();
  });
  /**
   * Whether the segments changed since state was last adopted from them. The next
   * adoption also discards the direct-entry buffer, and runs before any key reads it.
   */
  #domDirty = false;

  /** The listeners of one connection, released together on `disconnect()`. */
  readonly #listeners = new ListenerSet();

  /** Seeds state from the DOM, renders canonical ARIA, and starts morph observation. */
  override connect(): void {
    this.#reconcile.observe(this.element);
    this.#listeners.add(this.element, "focusout", this.#onFocusOut);
    this.#domDirty = false;
    this.#adoptDomState();
    this.#render();
    this.#observeMutations();
  }

  /** Releases the observer, listener, queued reconciliation, and transient input state. */
  override disconnect(): void {
    this.#connectionGeneration += 1;
    this.#reconcile.disconnect();
    this.#listeners.dispose();
    this.#observer.disconnect();
    this.#domDirty = false;
    this.#renderedHourMode = null;
    this.#renderedSegments = new WeakSet<HTMLElement>();
    this.#authoredSegments.clear();
    this.#clearTypeBuffer();
    this.#lastValue = "";
  }

  /** Re-renders the canonical instant when 12/24-hour presentation changes at runtime. */
  hourCycleValueChanged(): void {
    this.#reconcile.schedule();
  }

  /** Refreshes the 12-hour range while retaining the canonical time. */
  hour12ZeroBasedValueChanged(): void {
    this.#reconcile.schedule();
  }

  /** Recomposes the optional seconds portion after a runtime Value change. */
  secondsValueChanged(): void {
    this.#reconcile.schedule();
  }

  /** Refreshes the visible and accessible AM label without changing the time. */
  amLabelValueChanged(): void {
    this.#reconcile.schedule();
  }

  /** Refreshes the visible and accessible PM label without changing the time. */
  pmLabelValueChanged(): void {
    this.#reconcile.schedule();
  }

  /** Adopts a segment inserted or replaced by a Turbo morph. */
  segmentTargetConnected(): void {
    this.#domDirty = true;
    this.#reconcile.schedule();
  }

  /** Rebuilds state after a segment leaves the retained controller element. */
  segmentTargetDisconnected(segment?: HTMLElement): void {
    if (segment && !this.segmentTargets.includes(segment)) this.#renderedSegments.delete(segment);
    this.#domDirty = true;
    this.#reconcile.schedule();
  }

  /** Reflects the current composed value into a field added or replaced at runtime. */
  fieldTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Reconciles silently when the optional field leaves at runtime. */
  fieldTargetDisconnected(): void {
    this.#reconcile.schedule();
  }

  /** Handles APG stepping, inter-segment focus moves, jumps, and direct entry. */
  onKeydown(event: KeyboardEvent): void {
    if (isReservedArrowChord(event)) return;
    const segment = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      targetSelector(this.identifier, "segment"),
    );
    if (!segment || !this.segmentTargets.includes(segment)) return;
    const kind = this.#kindOf(segment);
    if (!kind) return;

    const key = logicalArrowKey(event.key, this.element);
    if ((key === "Home" || key === "End") && hasModifierChord(event)) return;

    // Taking in the page's writes consumes the records the observer would have
    // answered, so the pass it would have queued is queued here. A key that renders
    // leaves that pass nothing to report.
    if (this.#adoptPendingDom()) this.#reconcile.schedule();
    if (this.#renderedHourMode !== this.#hourMode) this.#clearTypeBuffer();
    switch (key) {
      case "ArrowUp":
        event.preventDefault();
        this.#step(kind, this.#delta(kind));
        break;
      case "ArrowDown":
        event.preventDefault();
        this.#step(kind, -this.#delta(kind));
        break;
      case "ArrowLeft":
        event.preventDefault();
        this.#focusSibling(segment, -1);
        break;
      case "ArrowRight":
        event.preventDefault();
        this.#focusSibling(segment, 1);
        break;
      case "Home":
        event.preventDefault();
        this.#setDisplayed(kind, this.#bounds(kind).min);
        this.#commitRender();
        break;
      case "End":
        event.preventDefault();
        this.#setDisplayed(kind, this.#bounds(kind).max);
        this.#commitRender();
        break;
      default:
        if (
          kind !== "meridiem" &&
          /^[0-9]$/.test(event.key) &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.metaKey
        ) {
          event.preventDefault();
          this.#typeDigit(segment, kind, event.key);
          return;
        }
        return;
    }
    this.#clearTypeBuffer();
  }

  /** Clears direct-entry state when Tab, Shift+Tab, or pointer focus leaves a segment. */
  readonly #onFocusOut = (event: FocusEvent): void => {
    const segment = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      targetSelector(this.identifier, "segment"),
    );
    if (!segment || !this.segmentTargets.includes(segment)) return;
    this.#clearTypeBuffer();
  };

  /** Uses the normalized positive-integer minute step; other segments step by one. */
  #delta(kind: SegmentKind): number {
    if (kind !== "minute") return 1;
    const step = Math.trunc(this.#safeStep);
    return step > 0 ? step : 1;
  }

  /** Mutates one complete action and then renders/notifies its final value once. */
  #step(kind: SegmentKind, delta: number): void {
    if (kind === "meridiem" && this.wrapValue) {
      this.#state.hour = modulo(this.#state.hour + 12, 24);
    } else if (this.wrapValue) {
      const scale = kind === "hour" ? SECONDS_PER_HOUR : kind === "minute" ? SECONDS_PER_MINUTE : 1;
      this.#setFromSeconds(this.#secondsOfDay + delta * scale);
    } else if (kind === "hour") {
      // Hour stepping crosses noon while clamping at the first and last hour of the day.
      this.#state.hour = Math.min(23, Math.max(0, this.#state.hour + delta));
    } else {
      const { min, max } = this.#bounds(kind);
      const displayed = this.#displayValue(kind);
      this.#setDisplayed(kind, Math.min(max, Math.max(min, displayed + delta)));
    }
    this.#commitRender();
  }

  /** Accumulates a typed digit, rendering once and advancing after completion. */
  #typeDigit(segment: HTMLElement, kind: Exclude<SegmentKind, "meridiem">, digit: string): void {
    if (this.#typeSegment !== kind) this.#typeBuffer = "";
    this.#typeSegment = kind;

    const { max } = this.#bounds(kind);
    const candidate = Number(`${this.#typeBuffer}${digit}`);
    this.#typeBuffer = candidate <= max ? `${this.#typeBuffer}${digit}` : digit;

    this.#setDisplayed(kind, Number(this.#typeBuffer));
    this.#commitRender(true);

    if (this.#typeBuffer.length >= 2 || Number(this.#typeBuffer) * 10 > max) {
      this.#clearTypeBuffer();
      this.#focusSibling(segment, 1);
    }
  }

  /** Moves focus to the previous/next valid segment, if one exists. */
  #focusSibling(segment: HTMLElement, direction: 1 | -1): void {
    const segments = this.segmentTargets.filter((candidate) => this.#kindOf(candidate) !== null);
    const index = segments.indexOf(segment);
    segments[index + direction]?.focus();
  }

  /** Clears the direct-entry buffer and its owning segment together. */
  #clearTypeBuffer(): void {
    this.#typeBuffer = "";
    this.#typeSegment = null;
  }

  /**
   * Adopts authored segment state before a synchronous user operation consumes it,
   * and reports whether it did.
   */
  #adoptPendingDom(): boolean {
    this.#recordAuthoredSegments(this.#observer.take());
    if (!this.#domDirty) return false;
    this.#domDirty = false;
    this.#clearTypeBuffer();
    this.#adoptDomState();
    return true;
  }

  /** Keeps same-value author writes distinct from the controller's own reflections. */
  #recordAuthoredSegments(records: MutationRecord[]): boolean {
    let changed = false;
    for (const { target } of records) {
      if (!(target instanceof HTMLElement) || !this.segmentTargets.includes(target)) continue;
      this.#authoredSegments.add(target);
      changed = true;
    }
    if (changed) this.#domDirty = true;
    return changed;
  }

  /** Reconciles one coalesced target, Value, or retained-attribute mutation batch. */
  #reconcileDom(): void {
    this.#adoptPendingDom();
    this.#render();
  }

  /** Rebuilds canonical state from the targets; an absent hour represents midnight. */
  #adoptDomState(): void {
    const mode = this.#hourMode;
    const presentationChanged = this.#renderedHourMode !== null && this.#renderedHourMode !== mode;
    let displayedHour = 0;
    let meridiem = AM;
    let minute = 0;
    let second = 0;

    for (const segment of this.segmentTargets) {
      const kind = this.#kindOf(segment);
      if (!kind) continue;
      const retained =
        presentationChanged &&
        this.#renderedSegments.has(segment) &&
        !this.#authoredSegments.has(segment);
      let value: number;
      if (retained && kind === "hour") {
        value = mode === "h23" ? this.#state.hour : this.#state.hour % 12;
      } else if (retained && kind === "meridiem") {
        value = this.#state.hour >= 12 ? PM : AM;
      } else {
        value = this.#authoredValue(segment, kind);
      }
      if (kind === "hour") displayedHour = value;
      else if (kind === "minute") minute = value;
      else if (kind === "second") second = value;
      else meridiem = value;
    }

    this.#state = {
      hour:
        this.#safeHourCycle === 12
          ? (displayedHour % 12) + (meridiem === PM ? 12 : 0)
          : displayedHour,
      minute,
      second,
    };
    this.#authoredSegments.clear();
  }

  /** Reads and integer-clamps one authored `aria-valuenow`. */
  #authoredValue(segment: HTMLElement, kind: SegmentKind): number {
    const raw = Number(segment.getAttribute("aria-valuenow"));
    const { min, max } = this.#bounds(kind);
    if (!Number.isFinite(raw)) return min;
    return Math.min(max, Math.max(min, Math.trunc(raw)));
  }

  /** Writes a displayed segment value back into canonical state without rendering. */
  #setDisplayed(kind: SegmentKind, raw: number): void {
    const { min, max } = this.#bounds(kind);
    const value = Math.min(max, Math.max(min, Math.trunc(raw)));
    if (kind === "hour") {
      this.#state.hour =
        this.#safeHourCycle === 12 ? (value % 12) + (this.#state.hour >= 12 ? 12 : 0) : value;
    } else if (kind === "minute" || kind === "second") {
      this.#state[kind] = value;
    } else {
      this.#state.hour = (this.#state.hour % 12) + (value === PM ? 12 : 0);
    }
  }

  /** Converts seconds with day wrapping into the canonical three-unit state. */
  #setFromSeconds(raw: number): void {
    const seconds = modulo(raw, SECONDS_PER_DAY);
    this.#state.hour = Math.floor(seconds / SECONDS_PER_HOUR);
    this.#state.minute = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    this.#state.second = seconds % SECONDS_PER_MINUTE;
  }

  /** Reflects canonical state to every segment without dispatching user events. */
  #renderSegments(preserveTypeBuffer = false): void {
    const mode = this.#hourMode;
    if (this.#renderedHourMode !== mode && !preserveTypeBuffer) this.#clearTypeBuffer();
    this.#renderedHourMode = mode;
    for (const segment of this.segmentTargets) this.#renderSegment(segment);
  }

  /**
   * Reflects canonical state during connection or DOM reconciliation.
   *
   * No user edit reaches here, so `change` never fires from this path. A pass
   * that moves the committed value reports `reconcile` instead.
   *
   * @stimeoRenderRoot
   */
  #render(): void {
    this.#renderSegments();
    const value = this.#composedValue;
    const previous = this.#lastValue;
    this.#writeField(value);
    this.#lastValue = value;
    // A reconciliation can move the committed value — dropping a `second`
    // segment recomposes without it, and a `seconds` Value change adds or
    // removes the unit. That is this controller's decision rather than the
    // user's, so it is reported apart from `change`. The empty baseline is the
    // initial connection, which reports nothing.
    if (previous !== "" && value !== previous) {
      this.#move = this.#moves.record();
      this.dispatch("reconcile", { detail: { value } });
    }
  }

  /** Reflects one completed user action and dispatches its final change at most once. */
  #commitRender(preserveTypeBuffer = false): void {
    const generation = this.#connectionGeneration;
    this.#renderSegments(preserveTypeBuffer);
    const value = this.#composedValue;
    const changed = value !== this.#lastValue;
    this.#lastValue = value;
    if (changed) this.#move = this.#moves.record();
    const move = this.#move;
    if (this.#writeField(value)) commitField(this.fieldTarget);
    if (generation !== this.#connectionGeneration || !this.#moves.isLatest(move)) return;
    if (changed) this.dispatch("change", { detail: { value } });
  }

  /** Reflects one segment's value and controller-owned ARIA bounds/text. */
  #renderSegment(segment: HTMLElement): void {
    const kind = this.#kindOf(segment);
    if (!kind) return;
    this.#renderedSegments.add(segment);
    const value = this.#displayValue(kind);
    const text =
      kind === "meridiem" ? (value === PM ? this.pmLabelValue : this.amLabelValue) : pad(value);
    const { min, max } = this.#bounds(kind);

    const serialized = String(value);
    setAttributeIfChanged(segment, "aria-valuenow", serialized, () => {
      this.#observer.claim(segment, "aria-valuenow", serialized);
    });
    segment.setAttribute("aria-valuetext", text);
    segment.setAttribute("aria-valuemin", String(min));
    segment.setAttribute("aria-valuemax", String(max));
    segment.textContent = text;
  }

  /** Writes a composed value to the optional form field and reports whether it changed. */
  #writeField(value: string): boolean {
    return this.hasFieldTarget && writeField(this.fieldTarget, value);
  }

  /** The canonical form value composed as `HH:MM[:SS]`. */
  get #composedValue(): string {
    const parts = [pad(this.#state.hour), pad(this.#state.minute)];
    if (this.secondsValue) parts.push(pad(this.#state.second));
    return parts.join(":");
  }

  /** Returns a canonical unit in the presentation form exposed by its segment. */
  #displayValue(kind: SegmentKind): number {
    if (kind === "hour") {
      const mode = this.#hourMode;
      if (mode === "h23") return this.#state.hour;
      const hour = this.#state.hour % 12;
      return mode === "h11" ? hour : hour || 12;
    }
    if (kind === "meridiem") return this.#state.hour >= 12 ? PM : AM;
    return this.#state[kind];
  }

  /** The inclusive controller-owned bounds for a segment kind. */
  #bounds(kind: SegmentKind): { min: number; max: number } {
    switch (kind) {
      case "hour":
        if (this.#hourMode === "h23") return { min: 0, max: 23 };
        return this.#hourMode === "h11" ? { min: 0, max: 11 } : { min: 1, max: 12 };
      case "minute":
      case "second":
        return { min: 0, max: 59 };
      case "meridiem":
        return { min: AM, max: PM };
    }
  }

  /** Watches retained segment state while excluding this controller's own reflections. */
  #observeMutations(): void {
    this.#observer.observe(this.element, {
      subtree: true,
      attributes: ["aria-valuenow", "data-segment"],
    });
  }

  /** Reads a segment's declared kind, or null when absent/invalid. */
  #kindOf(segment: HTMLElement): SegmentKind | null {
    const kind = segment.getAttribute("data-segment");
    if (kind === "hour" || kind === "minute" || kind === "second" || kind === "meridiem") {
      return kind;
    }
    return null;
  }

  /** Canonical state as seconds since the start of its nominal day. */
  get #secondsOfDay(): number {
    return (
      this.#state.hour * SECONDS_PER_HOUR +
      this.#state.minute * SECONDS_PER_MINUTE +
      this.#state.second
    );
  }

  /** Selects one numeric presentation without inferring a language or changing time. */
  get #hourMode(): HourMode {
    if (this.#safeHourCycle !== 12) return "h23";
    return this.hour12ZeroBasedValue ? "h11" : "h12";
  }
  /** Current `hourCycle` declaration resolved against its numeric contract. */
  get #safeHourCycle(): number {
    return this.#numbers.read(
      this,
      "hourCycle",
      this.hourCycleValue,
      TimePickerController.values.hourCycle.default,
      TimePickerController.valueConstraints.hourCycle,
    );
  }

  /** Current `step` declaration resolved against its numeric contract. */
  get #safeStep(): number {
    return this.#numbers.read(
      this,
      "step",
      this.stepValue,
      TimePickerController.values.step.default,
      TimePickerController.valueConstraints.step,
    );
  }
}

/** Positive modulo for wrapping values in both keyboard directions. */
function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/** Zero-pads a number to two digits. */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}
