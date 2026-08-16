import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord, logicalArrowKey } from "../utils/arrow_step";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";

/** A time segment kind, as declared by `data-segment` on each spinbutton. */
type SegmentKind = "hour" | "minute" | "second" | "meridiem";

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

/** Modifier keys that reserve document/browser shortcuts outside the widget. */
const hasModifier = (event: KeyboardEvent): boolean =>
  event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;

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
 * discarded on another action, target replacement, or focus departure.
 *
 * A user action that changes the composed value dispatches exactly one bubbling
 * native `change` from the field, when present, and one
 * `stimeo--time-picker:change` with `{ value: string }`. Retained
 * `aria-valuenow`/`data-segment` changes, runtime targets, and
 * `hourCycle`/`seconds` Value changes are reconciled for Turbo morph
 * compatibility; when such a pass moves the composed value — dropping a `second`
 * segment, say — it reports `stimeo--time-picker:reconcile` with the same detail
 * instead, so a consumer can tell its own edit from this controller's repair.
 * Initial connection reports neither.
 */
export class TimePickerController extends Controller<HTMLElement> {
  static override targets = ["segment", "field"];
  static override values = {
    hourCycle: { type: Number, default: 24 },
    step: { type: Number, default: 1 },
    seconds: { type: Boolean, default: false },
    wrap: { type: Boolean, default: true },
  };
  static actions = ["onKeydown"] as const;
  static events = ["change", "reconcile"] as const;

  declare readonly segmentTargets: HTMLElement[];
  declare readonly fieldTarget: HTMLInputElement;
  declare readonly hasFieldTarget: boolean;
  declare hourCycleValue: number;
  declare stepValue: number;
  declare secondsValue: boolean;
  declare wrapValue: boolean;

  /** Collapses target, Value, and retained-attribute morphs into one silent render. */
  readonly #reconcile = new MicrotaskCoalescer(() => this.#reconcileDom());
  /** Canonical state; the displayed hour and meridiem are derived from this value. */
  #state: TimeState = { hour: 0, minute: 0, second: 0 };
  /** Direct-entry digit buffer and the segment it belongs to. */
  #typeBuffer = "";
  #typeSegment: SegmentKind | null = null;
  /** Last composed value, used to suppress duplicate user notifications. */
  #lastValue = "";
  #observer: MutationObserver | null = null;
  #connected = false;
  #domDirty = false;

  /** Seeds state from the DOM, renders canonical ARIA, and starts morph observation. */
  override connect(): void {
    this.#connected = true;
    this.#reconcile.activate();
    this.element.addEventListener("focusout", this.#onFocusOut);
    this.#domDirty = false;
    this.#adoptDomState();
    this.#render();
    this.#observeMutations();
  }

  /** Releases the observer, listener, queued reconciliation, and transient input state. */
  override disconnect(): void {
    this.#connected = false;
    this.#reconcile.cancel();
    this.element.removeEventListener("focusout", this.#onFocusOut);
    this.#observer?.disconnect();
    this.#observer = null;
    this.#domDirty = false;
    this.#clearTypeBuffer();
    this.#lastValue = "";
  }

  /** Re-renders the canonical instant when 12/24-hour presentation changes at runtime. */
  hourCycleValueChanged(): void {
    this.#reconcile.schedule();
  }

  /** Recomposes the optional seconds portion after a runtime Value change. */
  secondsValueChanged(): void {
    this.#reconcile.schedule();
  }

  /** Adopts a segment inserted or replaced by a Turbo morph. */
  segmentTargetConnected(): void {
    this.#domDirty = true;
    this.#clearTypeBuffer();
    this.#reconcile.schedule();
  }

  /** Rebuilds state after a segment leaves the retained controller element. */
  segmentTargetDisconnected(): void {
    this.#domDirty = true;
    this.#clearTypeBuffer();
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
      "[data-stimeo--time-picker-target~='segment']",
    );
    if (!segment || !this.segmentTargets.includes(segment)) return;
    const kind = this.#kindOf(segment);
    if (!kind) return;

    const key = logicalArrowKey(event.key, this.element);
    if ((key === "Home" || key === "End") && hasModifier(event)) return;

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
        if (kind !== "meridiem" && /^[0-9]$/.test(event.key) && !hasModifier(event)) {
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
      "[data-stimeo--time-picker-target~='segment']",
    );
    if (!segment || !this.segmentTargets.includes(segment)) return;
    this.#clearTypeBuffer();
  };

  /** Uses the normalized positive-integer minute step; other segments step by one. */
  #delta(kind: SegmentKind): number {
    if (kind !== "minute") return 1;
    const step = Math.trunc(this.stepValue);
    return Number.isFinite(step) && step > 0 ? step : 1;
  }

  /** Mutates one complete action and then renders/notifies its final value once. */
  #step(kind: SegmentKind, delta: number): void {
    if (kind === "meridiem" && this.wrapValue) {
      this.#state.hour = modulo(this.#state.hour + 12, 24);
    } else if (this.wrapValue) {
      const scale = kind === "hour" ? SECONDS_PER_HOUR : kind === "minute" ? SECONDS_PER_MINUTE : 1;
      this.#setFromSeconds(this.#secondsOfDay + delta * scale);
    } else if (kind === "hour") {
      // The displayed hour is a projection of the canonical one, so stepping it
      // moves the instant: 11 → 12 crosses noon or midnight even here, where the
      // step never leaves the segment's own bounds. Clamping on the canonical
      // clock is what "no wrapping" means — the day is not crossed.
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
    this.#commitRender();

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

  /** Reconciles one coalesced target, Value, or retained-attribute mutation batch. */
  #reconcileDom(): void {
    if (this.#domDirty) {
      this.#domDirty = false;
      this.#clearTypeBuffer();
      this.#adoptDomState();
    }
    this.#render();
  }

  /** Rebuilds canonical state from the targets; an absent hour represents midnight. */
  #adoptDomState(): void {
    let displayedHour = 0;
    let meridiem = AM;
    let minute = 0;
    let second = 0;

    for (const segment of this.segmentTargets) {
      const kind = this.#kindOf(segment);
      if (!kind) continue;
      const value = this.#authoredValue(segment, kind);
      if (kind === "hour") displayedHour = value;
      else if (kind === "minute") minute = value;
      else if (kind === "second") second = value;
      else meridiem = value;
    }

    this.#state = {
      hour:
        this.hourCycleValue === 12
          ? (displayedHour % 12) + (meridiem === PM ? 12 : 0)
          : displayedHour,
      minute,
      second,
    };
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
        this.hourCycleValue === 12 ? (value % 12) + (this.#state.hour >= 12 ? 12 : 0) : value;
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
  #renderSegments(): void {
    this.#withoutObservation(() => {
      for (const segment of this.segmentTargets) this.#renderSegment(segment);
    });
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
      this.dispatch("reconcile", { detail: { value } });
    }
  }

  /** Reflects one completed user action and dispatches its final change exactly once. */
  #commitRender(): void {
    this.#renderSegments();
    const value = this.#composedValue;
    const fieldChanged = this.#writeField(value);
    if (fieldChanged) this.fieldTarget.dispatchEvent(new Event("change", { bubbles: true }));
    if (value !== this.#lastValue) this.dispatch("change", { detail: { value } });
    this.#lastValue = value;
  }

  /** Reflects one segment's value and controller-owned ARIA bounds/text. */
  #renderSegment(segment: HTMLElement): void {
    const kind = this.#kindOf(segment);
    if (!kind) return;
    const value = this.#displayValue(kind);
    const text = kind === "meridiem" ? (value === PM ? "PM" : "AM") : pad(value);
    const { min, max } = this.#bounds(kind);

    segment.setAttribute("aria-valuenow", String(value));
    segment.setAttribute("aria-valuetext", text);
    segment.setAttribute("aria-valuemin", String(min));
    segment.setAttribute("aria-valuemax", String(max));
    segment.textContent = text;
  }

  /** Writes a composed value to the optional form field and reports whether it changed. */
  #writeField(value: string): boolean {
    if (!this.hasFieldTarget || this.fieldTarget.value === value) return false;
    this.fieldTarget.value = value;
    return true;
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
      return this.hourCycleValue === 12 ? this.#state.hour % 12 || 12 : this.#state.hour;
    }
    if (kind === "meridiem") return this.#state.hour >= 12 ? PM : AM;
    return this.#state[kind];
  }

  /** The inclusive controller-owned bounds for a segment kind. */
  #bounds(kind: SegmentKind): { min: number; max: number } {
    switch (kind) {
      case "hour":
        return this.hourCycleValue === 12 ? { min: 1, max: 12 } : { min: 0, max: 23 };
      case "minute":
      case "second":
        return { min: 0, max: 59 };
      case "meridiem":
        return { min: AM, max: PM };
    }
  }

  /** Watches retained segment state while excluding this controller's own reflections. */
  #observeMutations(): void {
    const observer = new MutationObserver((records) => {
      const changed = records.some(
        ({ target }) => target instanceof HTMLElement && this.segmentTargets.includes(target),
      );
      if (!changed) return;
      this.#domDirty = true;
      this.#clearTypeBuffer();
      this.#reconcile.schedule();
    });
    this.#observer = observer;
    this.#observeWith(observer);
  }

  /** Registers retained attribute observation on the controller subtree. */
  #observeWith(observer: MutationObserver): void {
    observer.observe(this.element, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-valuenow", "data-segment"],
    });
  }

  /** Temporarily pauses observation so derived ARIA writes cannot become DOM input. */
  #withoutObservation(run: () => void): void {
    const observer = this.#observer;
    observer?.disconnect();
    try {
      run();
    } finally {
      if (observer && this.#connected) this.#observeWith(observer);
    }
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
}

/** Positive modulo for wrapping values in both keyboard directions. */
function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/** Zero-pads a number to two digits. */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}
