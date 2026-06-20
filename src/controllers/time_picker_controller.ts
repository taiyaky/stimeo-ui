import { Controller } from "@hotwired/stimulus";

/** A time segment kind, as declared by `data-segment` on each spinbutton. */
type SegmentKind = "hour" | "minute" | "second" | "meridiem";

/** Meridiem encoding: 0 = AM, 1 = PM. */
const AM = 0;
const PM = 1;

/**
 * Headless, accessible **time picker** behavior. Each segment (hour, minute,
 * optional second, optional AM/PM) is an APG **Spinbutton**; the controller
 * composes them into an `HH:MM[:SS]` value mirrored to a hidden field.
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
 * @remarks
 * Behavior only — no styling, no locale formatting. Every segment is its own Tab
 * stop (multi-tabstop, *not* roving); `ArrowLeft`/`ArrowRight` are an auxiliary
 * move between segments. `ArrowUp`/`ArrowDown` step the focused segment, wrapping
 * (and, when `wrap` is set, carrying minutes→hours and seconds→minutes). Typing
 * digits enters a value directly and advances after two digits. AM/PM is modeled
 * as a `meridiem` spinbutton that toggles; the hidden field is always 24-hour.
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
  static events = ["change"] as const;

  declare readonly segmentTargets: HTMLElement[];
  declare readonly fieldTarget: HTMLInputElement;
  declare readonly hasFieldTarget: boolean;
  declare hourCycleValue: number;
  declare stepValue: number;
  declare secondsValue: boolean;
  declare wrapValue: boolean;

  /** Current numeric value per segment kind (hours are the *displayed* hours). */
  #state: Record<SegmentKind, number> = { hour: 0, minute: 0, second: 0, meridiem: AM };
  /** Direct-entry digit buffer and the segment it belongs to. */
  #typeBuffer = "";
  #typeSegment: SegmentKind | null = null;
  /** Last composed field value, to suppress duplicate `change` dispatches. */
  #lastValue = "";

  /** Seeds each segment from its initial `aria-valuenow` and syncs the field. */
  override connect(): void {
    for (const segment of this.segmentTargets) {
      const kind = this.#kindOf(segment);
      if (!kind) continue;
      const now = Number(segment.getAttribute("aria-valuenow"));
      const { min, max } = this.#bounds(kind);
      // Clamp the seeded value so malformed markup (out-of-range aria-valuenow)
      // never propagates into the rendered state or the composed field.
      this.#state[kind] = Number.isFinite(now) ? Math.min(max, Math.max(min, now)) : min;
    }
    for (const segment of this.segmentTargets) this.#renderSegment(segment);
    this.#syncField(false);
  }

  /** Handles stepping, inter-segment focus moves, jumps, and direct entry. */
  onKeydown(event: KeyboardEvent): void {
    const segment = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-stimeo--time-picker-target='segment']",
    );
    const kind = segment ? this.#kindOf(segment) : null;
    if (!segment || !kind) return;

    switch (event.key) {
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
        this.#set(kind, this.#bounds(kind).min);
        break;
      case "End":
        event.preventDefault();
        this.#set(kind, this.#bounds(kind).max);
        break;
      default:
        if (/^[0-9]$/.test(event.key)) {
          event.preventDefault();
          this.#typeDigit(segment, kind, event.key);
        }
        return;
    }
    // Any non-digit action ends the current direct-entry sequence.
    this.#typeBuffer = "";
    this.#typeSegment = null;
  }

  /** The per-step delta: minutes step by `step`, others by 1, meridiem toggles. */
  #delta(kind: SegmentKind): number {
    return kind === "minute" ? this.stepValue : 1;
  }

  /** Steps a segment, wrapping at its bounds and carrying over when enabled. */
  #step(kind: SegmentKind, delta: number): void {
    if (kind === "meridiem") {
      this.#set("meridiem", this.#state.meridiem === AM ? PM : AM);
      return;
    }
    const { min, max } = this.#bounds(kind);
    const span = max - min + 1;
    const raw = this.#state[kind] + delta;

    if (raw > max || raw < min) {
      if (!this.wrapValue) {
        this.#set(kind, Math.min(max, Math.max(min, raw)));
        return;
      }
      // Wrap within the segment, carrying the overflow into the larger unit.
      const wrapped = ((((raw - min) % span) + span) % span) + min;
      const carry = Math.floor((raw - min) / span);
      this.#set(kind, wrapped);
      this.#carry(kind, carry);
      return;
    }
    this.#set(kind, raw);
  }

  /** Propagates a wrap carry from `kind` into the next larger segment. */
  #carry(kind: SegmentKind, amount: number): void {
    if (amount === 0) return;
    if (kind === "second") this.#step("minute", amount);
    else if (kind === "minute") this.#step("hour", amount);
    // Hours wrap on their own (no day rollover); meridiem has no carry.
  }

  /**
   * Sets a segment's value (clamped to its `[min, max]` bounds), re-renders it,
   * and resyncs the composed field. Clamping here guards the direct-entry path:
   * typing `0` into a 12-hour hour (min 1) must not commit an out-of-range
   * `aria-valuenow="0"`. The stepping path already passes in-bounds values, so
   * the clamp is a no-op there.
   */
  #set(kind: SegmentKind, value: number): void {
    const { min, max } = this.#bounds(kind);
    this.#state[kind] = Math.min(max, Math.max(min, value));
    const segment = this.segmentTargets.find((s) => this.#kindOf(s) === kind);
    if (segment) this.#renderSegment(segment);
    this.#syncField(true);
  }

  /** Accumulates a typed digit, committing and advancing after two digits. */
  #typeDigit(segment: HTMLElement, kind: SegmentKind, digit: string): void {
    if (kind === "meridiem") return;
    if (this.#typeSegment !== kind) this.#typeBuffer = "";
    this.#typeSegment = kind;

    const { max } = this.#bounds(kind);
    const candidate = Number(`${this.#typeBuffer}${digit}`);
    if (candidate <= max) this.#typeBuffer = `${this.#typeBuffer}${digit}`;
    else this.#typeBuffer = digit; // restart from this digit when it overflows

    this.#set(kind, Number(this.#typeBuffer));

    // Two digits (or a value that can't grow further) completes the segment.
    if (this.#typeBuffer.length >= 2 || Number(this.#typeBuffer) * 10 > max) {
      this.#typeBuffer = "";
      this.#typeSegment = null;
      this.#focusSibling(segment, 1);
    }
  }

  /** Moves focus to the previous/next segment, if one exists. */
  #focusSibling(segment: HTMLElement, direction: 1 | -1): void {
    const index = this.segmentTargets.indexOf(segment);
    const next = this.segmentTargets[index + direction];
    next?.focus();
  }

  /** Reflects a segment's current value onto its ARIA/text representation. */
  #renderSegment(segment: HTMLElement): void {
    const kind = this.#kindOf(segment);
    if (!kind) return;
    const value = this.#state[kind];

    if (kind === "meridiem") {
      const text = value === PM ? "PM" : "AM";
      segment.setAttribute("aria-valuenow", String(value));
      segment.setAttribute("aria-valuetext", text);
      segment.setAttribute("aria-valuemin", String(AM));
      segment.setAttribute("aria-valuemax", String(PM));
      segment.textContent = text;
      return;
    }

    const { min, max } = this.#bounds(kind);
    const text = String(value).padStart(2, "0");
    segment.setAttribute("aria-valuenow", String(value));
    segment.setAttribute("aria-valuetext", text);
    segment.setAttribute("aria-valuemin", String(min));
    segment.setAttribute("aria-valuemax", String(max));
    segment.textContent = text;
  }

  /** Composes `HH:MM[:SS]` (24-hour) into the hidden field; dispatches `change`. */
  #syncField(notify: boolean): void {
    const h24 = this.#hours24();
    const parts = [pad(h24), pad(this.#state.minute)];
    if (this.secondsValue) parts.push(pad(this.#state.second));
    const value = parts.join(":");

    if (this.hasFieldTarget && this.fieldTarget.value !== value) {
      this.fieldTarget.value = value;
    }
    // Dispatch only when the composed value actually changed, so a no-op step
    // (e.g. Home at the minimum) does not emit a redundant event.
    if (notify && value !== this.#lastValue) this.dispatch("change", { detail: { value } });
    this.#lastValue = value;
  }

  /** Converts the displayed hour (+ meridiem in 12-hour mode) to 24-hour. */
  #hours24(): number {
    if (this.hourCycleValue !== 12) return this.#state.hour;
    const base = this.#state.hour % 12; // 12 → 0
    return base + (this.#state.meridiem === PM ? 12 : 0);
  }

  /** The inclusive `[min, max]` bounds for a segment kind. */
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

  /** Reads a segment's declared kind, or null when absent/invalid. */
  #kindOf(segment: HTMLElement): SegmentKind | null {
    const kind = segment.getAttribute("data-segment");
    if (kind === "hour" || kind === "minute" || kind === "second" || kind === "meridiem") {
      return kind;
    }
    return null;
  }
}

/** Zero-pads a number to two digits. */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}
