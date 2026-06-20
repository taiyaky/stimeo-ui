import { Controller } from "@hotwired/stimulus";

/** CSS custom properties exposing each thumb's position (0..1) to the consumer. */
const START_PROPERTY = "--stimeo-range-start";
const END_PROPERTY = "--stimeo-range-end";

/**
 * Headless, accessible **two-thumb range slider** behavior (APG Slider —
 * Multi-Thumb). A derivative of {@link SliderController}: it manages two thumbs
 * (`start` ≤ `end`) that constrain each other.
 *
 * Markup contract (identifier: `stimeo--range-slider`):
 *   <div data-controller="stimeo--range-slider"
 *        data-stimeo--range-slider-min-value="0"
 *        data-stimeo--range-slider-max-value="100"
 *        data-stimeo--range-slider-step-value="1"
 *        data-stimeo--range-slider-start-value="20"
 *        data-stimeo--range-slider-end-value="80">
 *     <div data-stimeo--range-slider-target="track"
 *          data-action="pointerdown->stimeo--range-slider#onPointerDown">
 *       <div role="slider" tabindex="0" aria-label="Minimum"
 *            data-stimeo--range-slider-target="startThumb"
 *            data-action="keydown->stimeo--range-slider#onKeydown"></div>
 *       <div role="slider" tabindex="0" aria-label="Maximum"
 *            data-stimeo--range-slider-target="endThumb"
 *            data-action="keydown->stimeo--range-slider#onKeydown"></div>
 *     </div>
 *   </div>
 *
 * @remarks
 * Behavior only — the consumer owns all layout (positioning the thumbs and the
 * selected range from the fractions). Only the horizontal orientation is handled
 * in this MVP. Each thumb's movable range is bounded by the *other* thumb's
 * current value, reflected on its `aria-valuemin`/`aria-valuemax` so assistive
 * tech announces the live constraint.
 *
 * Behavior provided (per focused thumb):
 * - `ArrowRight`/`ArrowUp` increase and `ArrowLeft`/`ArrowDown` decrease by one
 *   step; `Home`/`End` jump to that thumb's movable min/max; `PageUp`/`PageDown`
 *   move by ten steps. A thumb never crosses the other.
 * - Pointer press/drag on the track moves the nearest thumb.
 */
export class RangeSliderController extends Controller<HTMLElement> {
  static override targets = ["track", "startThumb", "endThumb"];
  static override values = {
    min: { type: Number, default: 0 },
    max: { type: Number, default: 100 },
    step: { type: Number, default: 1 },
    start: { type: Number, default: 0 },
    end: { type: Number, default: 100 },
  };
  static actions = ["onKeydown", "onPointerDown"] as const;
  static events = ["change"] as const;

  declare readonly trackTarget: HTMLElement;
  declare readonly startThumbTarget: HTMLElement;
  declare readonly endThumbTarget: HTMLElement;
  declare readonly hasTrackTarget: boolean;
  declare readonly hasStartThumbTarget: boolean;
  declare readonly hasEndThumbTarget: boolean;
  declare minValue: number;
  declare maxValue: number;
  declare stepValue: number;
  declare startValue: number;
  declare endValue: number;

  /** Aborts in-progress pointer-drag listeners when the drag ends or on teardown. */
  #dragAbort: AbortController | null = null;

  /** Normalizes the initial pair (clamped, snapped, ordered) and renders. */
  override connect(): void {
    // Order the initial pair up front so a reversed start/end is corrected by
    // swapping (preserving both values) rather than collapsing one onto the other.
    const lo = Math.min(this.startValue, this.endValue);
    const hi = Math.max(this.startValue, this.endValue);
    this.#commit(lo, hi, false);
  }

  /** Cancels any active pointer drag so document listeners never leak. */
  override disconnect(): void {
    this.#dragAbort?.abort();
    this.#dragAbort = null;
  }

  /** Keyboard stepping for whichever thumb is focused (the action's element). */
  onKeydown(event: KeyboardEvent): void {
    const thumb = event.currentTarget as HTMLElement;
    const isStart = this.hasStartThumbTarget && thumb === this.startThumbTarget;
    const current = isStart ? this.startValue : this.endValue;
    // The opposing thumb caps this one's travel so the two never cross.
    const lower = isStart ? this.minValue : this.startValue;
    const upper = isStart ? this.endValue : this.maxValue;
    const big = this.stepValue * 10;

    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = current + this.stepValue;
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = current - this.stepValue;
        break;
      case "PageUp":
        next = current + big;
        break;
      case "PageDown":
        next = current - big;
        break;
      case "Home":
        next = lower;
        break;
      case "End":
        next = upper;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.#moveThumb(isStart, next);
  }

  /** Begins a pointer drag on the track, moving the thumb nearest the press. */
  onPointerDown(event: PointerEvent): void {
    if (!this.hasTrackTarget) return;
    const value = this.#valueFromClientX(event.clientX);
    if (value === null) return;
    event.preventDefault();

    // Pick the nearer thumb; ties go to the start thumb so a press exactly
    // between them stays deterministic. Only read the target getter behind its
    // has*Target guard — Stimulus throws when an absent target is accessed.
    const useStart = Math.abs(value - this.startValue) <= Math.abs(value - this.endValue);
    if (useStart) {
      if (this.hasStartThumbTarget) this.startThumbTarget.focus();
    } else if (this.hasEndThumbTarget) {
      this.endThumbTarget.focus();
    }
    this.#moveThumb(useStart, value);

    this.#dragAbort?.abort();
    const abort = new AbortController();
    this.#dragAbort = abort;
    const onMove = (move: PointerEvent): void => {
      const moved = this.#valueFromClientX(move.clientX);
      if (moved !== null) this.#moveThumb(useStart, moved);
    };
    const onUp = (): void => {
      abort.abort();
      this.#dragAbort = null;
    };
    document.addEventListener("pointermove", onMove, { signal: abort.signal });
    document.addEventListener("pointerup", onUp, { signal: abort.signal });
    // pointercancel fires when the gesture is interrupted (OS gesture, scroll
    // takeover, device switch); clean up the same way so no listener leaks.
    document.addEventListener("pointercancel", onUp, { signal: abort.signal });
  }

  /** Maps a pointer X coordinate to a raw value using the track geometry. */
  #valueFromClientX(clientX: number): number | null {
    const rect = this.trackTarget.getBoundingClientRect();
    if (rect.width === 0) return null;
    const fraction = (clientX - rect.left) / rect.width;
    return this.minValue + fraction * (this.maxValue - this.minValue);
  }

  /** Moves one thumb to a new raw value, keeping the pair ordered. */
  #moveThumb(isStart: boolean, raw: number): void {
    if (isStart) {
      this.#commit(raw, this.endValue, true);
    } else {
      this.#commit(this.startValue, raw, true);
    }
  }

  /**
   * Clamps and snaps `start`/`end`, enforces `start ≤ end`, stores the pair, and
   * reflects it onto the thumbs' ARIA attributes and the range custom
   * properties. Dispatches `change` only on user-driven updates (`notify`).
   */
  #commit(start: number, end: number, notify: boolean): void {
    const prevStart = this.startValue;
    const prevEnd = this.endValue;

    let nextStart = this.#snap(start);
    let nextEnd = this.#snap(end);
    // Keep them ordered: a thumb pushed past its partner stops at the partner.
    if (nextStart > nextEnd) {
      if (isUserMovingStart(start, prevStart, end, prevEnd)) nextStart = nextEnd;
      else nextEnd = nextStart;
    }

    this.startValue = nextStart;
    this.endValue = nextEnd;
    this.#render(nextStart, nextEnd);

    if (notify && (nextStart !== prevStart || nextEnd !== prevEnd)) {
      this.dispatch("change", { detail: { start: nextStart, end: nextEnd } });
    }
  }

  /** Reflects the current pair onto thumb ARIA attributes and CSS properties. */
  #render(start: number, end: number): void {
    if (this.hasStartThumbTarget) {
      this.startThumbTarget.setAttribute("aria-valuemin", String(this.minValue));
      this.startThumbTarget.setAttribute("aria-valuemax", String(end));
      this.startThumbTarget.setAttribute("aria-valuenow", String(start));
    }
    if (this.hasEndThumbTarget) {
      this.endThumbTarget.setAttribute("aria-valuemin", String(start));
      this.endThumbTarget.setAttribute("aria-valuemax", String(this.maxValue));
      this.endThumbTarget.setAttribute("aria-valuenow", String(end));
    }
    const span = this.maxValue - this.minValue;
    this.element.style.setProperty(
      START_PROPERTY,
      String(span > 0 ? (start - this.minValue) / span : 0),
    );
    this.element.style.setProperty(
      END_PROPERTY,
      String(span > 0 ? (end - this.minValue) / span : 0),
    );
  }

  /** Clamps `raw` to `[min, max]` and snaps it to the nearest step from `min`. */
  #snap(raw: number): number {
    const clamped = Math.min(this.maxValue, Math.max(this.minValue, raw));
    if (this.stepValue <= 0) return clamped;
    const stepped =
      Math.round((clamped - this.minValue) / this.stepValue) * this.stepValue + this.minValue;
    return Math.min(this.maxValue, Math.max(this.minValue, stepped));
  }
}

/**
 * Decides which thumb yields when a move would cross the pair. The moving thumb
 * is the one whose requested value differs from its previous value; it stops at
 * the partner rather than dragging the partner along.
 */
function isUserMovingStart(
  start: number,
  prevStart: number,
  end: number,
  prevEnd: number,
): boolean {
  return start !== prevStart && end === prevEnd;
}
