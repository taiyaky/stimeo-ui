import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord, logicalArrowKey } from "../utils/arrow_step";
import { commitField, writeField } from "../utils/field_mirror";
import { isRtl } from "../utils/logical_scroll";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { OwnedPointerSession } from "../utils/owned_pointer_session";
import { rangeFraction } from "../utils/range";
import { type SteppedRange, snapSteppedValue, stepSteppedValue } from "../utils/stepped_value";

/** CSS custom properties exposing each thumb's position (0..1) to the consumer. */
const START_PROPERTY = "--stimeo--range-slider-start";
const END_PROPERTY = "--stimeo--range-slider-end";
const DEFAULT_MIN = 0;
const DEFAULT_MAX = 100;

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
 *     <input type="hidden" name="price_min" data-stimeo--range-slider-target="startField" />
 *     <input type="hidden" name="price_max" data-stimeo--range-slider-target="endField" />
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
 * selected range from the fractions). Only the horizontal orientation is handled.
 * Each thumb's movable range is bounded by the *other* thumb's current value,
 * reflected on its `aria-valuemin`/`aria-valuemax` so assistive tech announces the
 * live constraint.
 *
 * Behavior provided (per focused thumb):
 * - `ArrowRight`/`ArrowUp` increase and `ArrowLeft`/`ArrowDown` decrease by one
 *   step; `Home`/`End` jump to that thumb's movable min/max; `PageUp`/`PageDown`
 *   move by ten steps. A thumb never crosses the other.
 * - Pointer press/drag on the track moves the nearest thumb.
 *   When the thumbs overlap, a press above their shared value selects `end`
 *   and a press below selects `start`, so the pair remains expandable.
 * - `min`, `max`, `start`, and `end` must be finite. Invalid runtime endpoints
 *   fall back to `0`/`100`; invalid thumb Values fall back to the corresponding
 *   effective endpoint. A `max` below `min` collapses the range to `min`.
 * - `step` must be finite and positive; invalid runtime input falls back to `1`.
 *   Finite movable endpoints remain allowed off the shared step grid.
 *
 * `change` and `reconcile` dispatch `{ start: number, end: number }`.
 *
 * The Values are inputs. A declared pair that is reversed, off the step grid or
 * outside the range stays in its attributes as the page wrote it; the thumbs'
 * ARIA, the fractions and the fields publish the normalized, ordered pair
 * instead, and only a move the user makes writes `start` / `end`. `change`
 * reports a move the user made that left the pair somewhere other than the pair
 * last published. When a Value the page changes at runtime — a Turbo morph or
 * application code — moves the published pair, `reconcile` reports it once per
 * batch with the same detail, so a consumer can tell its user's move from the
 * page's. Connecting reports neither. A move handled before a page write to
 * either end is repainted reads the written pair, so its `change` covers the
 * write as well, and a move that ends on the pair last published reports
 * nothing. An event dispatched from script runs every listener with no
 * microtask between them, so a write made just before it, or by a listener
 * that runs ahead of the range slider, is handled that way. An event the
 * browser dispatches runs microtasks between the listeners it calls
 * separately, so a write made by one called ahead of the range slider's — a
 * capture listener on an ancestor or on `document`, a `:capture` action, or a
 * listener added to a thumb or the track before the range slider's action was
 * bound — is repainted, and reported as `reconcile`, before the move is
 * measured from it. Stimulus calls the actions an element declares for one
 * event and one set of listener options from a single listener, in declaration
 * order, so a write made by an action declared before the range slider's own
 * on a thumb or the track is handled like a write within an event dispatched
 * from script.
 *
 * The optional `startField` / `endField` targets mirror the normalized pair so
 * the range can be submitted and read server-side. An end the user moved emits
 * a native bubbling `change` from its own field, the way a form control does,
 * so `stimeo--auto-submit` and form-level validation hear it; the end that did
 * not move stays quiet. Both mirrors are refreshed silently on connect, on a
 * replacement field, and whenever a morph or application code writes a Value.
 *
 * The fractions are value ratios, not positions, so only the consumer knows
 * whether their track mirrors under RTL. Set `logicalTrack` to declare that it
 * does: the pointer mapping and the horizontal arrow pair then follow the
 * writing direction. Left unset, nothing here reads `direction`.
 */
export class RangeSliderController extends Controller<HTMLElement> {
  static override targets = ["track", "startThumb", "endThumb", "startField", "endField"];
  static override values = {
    min: { type: Number, default: DEFAULT_MIN },
    max: { type: Number, default: DEFAULT_MAX },
    step: { type: Number, default: 1 },
    start: { type: Number, default: 0 },
    end: { type: Number, default: 100 },
    logicalTrack: { type: Boolean, default: false },
  };
  static actions = ["onKeydown", "onPointerDown"] as const;
  static events = ["change", "reconcile"] as const;

  declare readonly trackTarget: HTMLElement;
  declare readonly startThumbTarget: HTMLElement;
  declare readonly endThumbTarget: HTMLElement;
  declare readonly startFieldTarget: HTMLInputElement;
  declare readonly endFieldTarget: HTMLInputElement;
  declare readonly hasTrackTarget: boolean;
  declare readonly hasStartThumbTarget: boolean;
  declare readonly hasEndThumbTarget: boolean;
  declare readonly hasStartFieldTarget: boolean;
  declare readonly hasEndFieldTarget: boolean;
  declare minValue: number;
  declare maxValue: number;
  declare stepValue: number;
  declare startValue: number;
  declare endValue: number;
  declare logicalTrackValue: boolean;

  /** One initiating pointer owns each live drag and its stable target snapshot. */
  #drag: RangeSliderDrag | null = null;

  /**
   * The pair last published: taken on connect, then moved by each user commit
   * and by each repaint that reports a page-driven move.
   */
  #settled: RangePair = { start: DEFAULT_MIN, end: DEFAULT_MAX };

  /** Whether the consumer declared a mirroring track and the direction mirrors it. */
  get #mirrored(): boolean {
    return this.logicalTrackValue && isRtl(this.element);
  }

  /**
   * Collapses a morph that swaps render inputs into one repaint, and refuses the
   * pass Stimulus delivers before `connect()`.
   */
  readonly #repaint = new MicrotaskCoalescer(() => this.#render());

  /**
   * Renders the normalized, ordered pair without writing it back, and takes it
   * as the baseline, so connecting reports nothing.
   */
  override connect(): void {
    this.#repaint.activate();
    this.#settled = this.#currentPair(this.#effectiveRange);
    this.#render();
  }

  /** Cancels any active pointer drag so document listeners never leak. */
  override disconnect(): void {
    this.#repaint.cancel();
    this.#endDrag();
  }

  /** Repaints when application code (or a Turbo morph) changes `min` at runtime. */
  minValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `max` at runtime. */
  maxValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `step` at runtime. */
  stepValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `start` at runtime. */
  startValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `end` at runtime. */
  endValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Hydrates a replacement start thumb and restores live-drag focus ownership. */
  startThumbTargetConnected(thumb: HTMLElement): void {
    const range = this.#effectiveRange;
    const pair = this.#currentPair(range);
    this.#renderStartThumb(thumb, pair, range);
    this.#renderFractions(pair, range);
    if (this.#drag?.kind === "start" && this.#drag.thumb === null) {
      this.#drag.thumb = thumb;
      thumb.focus();
    }
    this.#repaint.schedule();
  }

  /** Drops a stale start-thumb reference without orphaning the track gesture. */
  startThumbTargetDisconnected(thumb: HTMLElement): void {
    if (this.#drag?.kind === "start" && this.#drag.thumb === thumb) this.#drag.thumb = null;
  }

  /** Hydrates a replacement end thumb and restores live-drag focus ownership. */
  endThumbTargetConnected(thumb: HTMLElement): void {
    const range = this.#effectiveRange;
    const pair = this.#currentPair(range);
    this.#renderEndThumb(thumb, pair, range);
    this.#renderFractions(pair, range);
    if (this.#drag?.kind === "end" && this.#drag.thumb === null) {
      this.#drag.thumb = thumb;
      thumb.focus();
    }
    this.#repaint.schedule();
  }

  /** Fills a start field inserted or replaced at runtime on the next repaint. */
  startFieldTargetConnected(): void {
    this.#repaint.schedule();
  }

  /** Fills an end field inserted or replaced at runtime on the next repaint. */
  endFieldTargetConnected(): void {
    this.#repaint.schedule();
  }

  /** Drops a stale end-thumb reference without orphaning the track gesture. */
  endThumbTargetDisconnected(thumb: HTMLElement): void {
    if (this.#drag?.kind === "end" && this.#drag.thumb === thumb) this.#drag.thumb = null;
  }

  /** Ends a gesture whose geometry target disappeared or ceased being a target. */
  trackTargetDisconnected(track: HTMLElement): void {
    if (this.#drag?.track === track) this.#endDrag();
  }

  /** Keyboard stepping for whichever thumb is focused (the action's element). */
  onKeydown(event: KeyboardEvent): void {
    if (isReservedArrowChord(event)) return;
    const thumb = event.currentTarget as HTMLElement;
    const isStart = this.hasStartThumbTarget && thumb === this.startThumbTarget;
    const isEnd = this.hasEndThumbTarget && thumb === this.endThumbTarget;
    const effectiveRange = this.#effectiveRange;
    const pair = this.#currentPair(effectiveRange);
    let kind: RangeThumb;
    let current: number;
    let range: { min: number; max: number; step: number; base: number };
    if (isStart) {
      kind = "start";
      current = pair.start;
      range = {
        min: effectiveRange.min,
        max: pair.end,
        step: effectiveRange.step,
        base: effectiveRange.min,
      };
    } else {
      if (!isEnd) return;
      kind = "end";
      current = pair.end;
      range = {
        min: pair.start,
        max: effectiveRange.max,
        step: effectiveRange.step,
        base: effectiveRange.min,
      };
    }

    let next: number | null = null;
    // On a mirrored track the greater value sits at the visual left, so the
    // horizontal pair trades places; `Home`/`End` name bounds, not a direction.
    switch (this.#mirrored ? logicalArrowKey(event.key, this.element) : event.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = stepSteppedValue(current, 1, range);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = stepSteppedValue(current, -1, range);
        break;
      case "PageUp":
        next = stepSteppedValue(current, 10, range);
        break;
      case "PageDown":
        next = stepSteppedValue(current, -10, range);
        break;
      case "Home":
        next = range.min;
        break;
      case "End":
        next = range.max;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.#moveThumb(kind, next);
  }

  /** Begins a pointer drag on the track, moving the thumb nearest the press. */
  onPointerDown(event: PointerEvent): void {
    if (
      event.button !== 0 ||
      this.#drag ||
      !this.hasTrackTarget ||
      !this.hasStartThumbTarget ||
      !this.hasEndThumbTarget
    ) {
      return;
    }
    const track = this.trackTarget;
    // Resolve the direction once for the whole gesture: reading it per move
    // would query computed style on every frame, and a drag that flipped
    // mid-gesture would be incoherent anyway.
    const mirrored = this.#mirrored;
    const value = this.#valueFromClientX(event.clientX, mirrored, track);
    if (value === null) return;
    event.preventDefault();

    // Pick the nearer thumb. An ordinary midpoint tie stays deterministic on
    // start; an overlapped pair uses the press direction so it can expand.
    // Only read a target getter behind its has*Target guard — Stimulus throws
    // when an absent target is accessed.
    const pair = this.#currentPair(this.#effectiveRange);
    const kind = this.#nearestThumb(value, pair);
    let thumb: HTMLElement;
    if (kind === "start") thumb = this.startThumbTarget;
    else thumb = this.endThumbTarget;
    this.#moveThumb(kind, value);
    thumb.focus();

    const drag: RangeSliderDrag = { pointer: null, track, thumb, kind };
    drag.pointer = new OwnedPointerSession(event, track, {
      move: (move) => {
        if (!track.isConnected) {
          this.#endDrag();
          return;
        }
        const moved = this.#valueFromClientX(move.clientX, mirrored, track);
        if (moved !== null) this.#moveThumb(kind, moved);
      },
      end: () => {
        if (this.#drag === drag) this.#drag = null;
      },
    });
    this.#drag = drag;
  }

  /** Maps a pointer X coordinate to a raw value using the track geometry. */
  #valueFromClientX(clientX: number, mirrored: boolean, track: HTMLElement): number | null {
    const rect = track.getBoundingClientRect();
    if (rect.width === 0) return null;
    const offset = (clientX - rect.left) / rect.width;
    const fraction = mirrored ? 1 - offset : offset;
    const range = this.#effectiveRange;
    return range.min + fraction * (range.max - range.min);
  }

  /**
   * Chooses the closest thumb while keeping an overlapped pair expandable.
   * Ordinary midpoint ties stay deterministic on `start`; at an overlap, a
   * press above the shared value selects `end` and a press below selects
   * `start`.
   */
  #nearestThumb(value: number, pair: RangePair): RangeThumb {
    const startDistance = Math.abs(value - pair.start);
    const endDistance = Math.abs(value - pair.end);
    if (endDistance < startDistance) return "end";
    if (pair.start === pair.end && value > pair.start) return "end";
    return "start";
  }

  /** Moves one thumb to a new raw value, keeping the pair ordered. */
  #moveThumb(kind: RangeThumb, raw: number): void {
    const pair = this.#currentPair(this.#effectiveRange);
    if (kind === "start") {
      this.#commit(raw, pair.end, "start");
    } else {
      this.#commit(pair.start, raw, "end");
    }
  }

  /**
   * Clamps and snaps the pair a user's move of the `moving` thumb produced,
   * stops that thumb at its partner, stores the pair, and reflects it onto the
   * thumbs' ARIA attributes and the range custom properties. The pair is
   * reported as `change` when it differs from the pair last published — not from
   * the pair the move started from — so a page write no repaint has published
   * yet is reported once, as this change, and a move that ends on the pair last
   * published reports nothing. The baseline moves before any report goes out,
   * so the repaint the Value writes schedule — and any move a subscriber makes
   * while the report is dispatched — is measured from this pair.
   */
  #commit(start: number, end: number, moving: RangeThumb): void {
    const range = this.#effectiveRange;
    let nextStart = snapSteppedValue(start, range);
    let nextEnd = snapSteppedValue(end, range);
    // Keep them ordered: a thumb pushed past its partner stops at the partner.
    if (nextStart > nextEnd) {
      if (moving === "start") nextStart = nextEnd;
      else nextEnd = nextStart;
    }

    const pair = { start: nextStart, end: nextEnd };
    const reported = this.#settled;
    this.#settled = pair;
    if (!Object.is(this.startValue, nextStart)) this.startValue = nextStart;
    if (!Object.is(this.endValue, nextEnd)) this.endValue = nextEnd;
    this.#renderPair(pair, range);
    this.#mirrorFields(pair, true);

    if (nextStart !== reported.start || nextEnd !== reported.end) {
      this.dispatch("change", { detail: { start: nextStart, end: nextEnd } });
    }
  }

  /**
   * Reflects the Values the page supplied without writing them back. A published
   * pair that moved from the last one is reported once as `reconcile`; the
   * fields follow without a native `change`.
   *
   * @stimeoRenderRoot
   */
  #render(): void {
    const range = this.#effectiveRange;
    const pair = this.#currentPair(range);
    this.#renderPair(pair, range);
    this.#mirrorFields(pair, false);
    const settled = this.#settled;
    if (pair.start === settled.start && pair.end === settled.end) return;
    this.#settled = pair;
    this.dispatch("reconcile", { detail: { start: pair.start, end: pair.end } });
  }

  /**
   * Mirrors the pair into the optional form fields, reporting only a user's
   * move. Each end is compared on its own, so dragging one thumb never reports
   * a commit from the field the other thumb owns.
   */
  #mirrorFields(pair: RangePair, notify: boolean): void {
    if (this.hasStartFieldTarget) {
      const field = this.startFieldTarget;
      if (writeField(field, String(pair.start)) && notify) commitField(field);
    }
    if (this.hasEndFieldTarget) {
      const field = this.endFieldTarget;
      if (writeField(field, String(pair.end)) && notify) commitField(field);
    }
  }

  /** Reflects one normalized pair onto both thumbs and CSS properties. */
  #renderPair(pair: RangePair, range: SteppedRange): void {
    if (this.hasStartThumbTarget) {
      this.#renderStartThumb(this.startThumbTarget, pair, range);
    }
    if (this.hasEndThumbTarget) {
      this.#renderEndThumb(this.endThumbTarget, pair, range);
    }
    this.#renderFractions(pair, range);
  }

  /** Writes only changed ARIA for the lower thumb. */
  #renderStartThumb(thumb: HTMLElement, pair: RangePair, range: SteppedRange): void {
    this.#setAria(thumb, "aria-valuemin", range.min);
    this.#setAria(thumb, "aria-valuemax", pair.end);
    this.#setAria(thumb, "aria-valuenow", pair.start);
  }

  /** Writes only changed ARIA for the upper thumb. */
  #renderEndThumb(thumb: HTMLElement, pair: RangePair, range: SteppedRange): void {
    this.#setAria(thumb, "aria-valuemin", pair.start);
    this.#setAria(thumb, "aria-valuemax", range.max);
    this.#setAria(thumb, "aria-valuenow", pair.end);
  }

  /** Writes one numeric ARIA attribute only when its serialized value changed. */
  #setAria(thumb: HTMLElement, name: string, value: number): void {
    const next = String(value);
    if (thumb.getAttribute(name) !== next) thumb.setAttribute(name, next);
  }

  /** Writes the two behavior-only fraction hooks only when they changed. */
  #renderFractions(pair: RangePair, range: SteppedRange): void {
    const start = String(rangeFraction(pair.start, range.min, range.max));
    const end = String(rangeFraction(pair.end, range.min, range.max));
    if (this.element.style.getPropertyValue(START_PROPERTY) !== start) {
      this.element.style.setProperty(START_PROPERTY, start);
    }
    if (this.element.style.getPropertyValue(END_PROPERTY) !== end) {
      this.element.style.setProperty(END_PROPERTY, end);
    }
  }

  /** Current normalized and ordered pair derived from live declarative Values. */
  #currentPair(range: SteppedRange): RangePair {
    const rawStart = Number.isFinite(this.startValue) ? this.startValue : range.min;
    const rawEnd = Number.isFinite(this.endValue) ? this.endValue : range.max;
    const start = snapSteppedValue(rawStart, range);
    const end = snapSteppedValue(rawEnd, range);
    if (start <= end) return { start, end };
    return { start: end, end: start };
  }

  /**
   * Finite ordered range used by ARIA, keyboard, pointer, and CSS reflection.
   * Invalid endpoints fall back to the public defaults; an authored `max`
   * below `min` collapses to the finite minimum.
   */
  get #effectiveRange(): SteppedRange {
    const min = Number.isFinite(this.minValue) ? this.minValue : DEFAULT_MIN;
    const authoredMax = Number.isFinite(this.maxValue) ? this.maxValue : DEFAULT_MAX;
    return { min, max: Math.max(min, authoredMax), step: this.stepValue, base: min };
  }

  /** Ends the current pointer session without dispatching another change. */
  #endDrag(): void {
    const drag = this.#drag;
    this.#drag = null;
    drag?.pointer?.end();
  }
}

/** Which thumb owns a keyboard or pointer move. */
type RangeThumb = "start" | "end";

/** One normalized pair reflected on the two public slider roles. */
interface RangePair {
  readonly start: number;
  readonly end: number;
}

/** Stable DOM and gesture state owned for the duration of one pointer drag. */
interface RangeSliderDrag {
  pointer: OwnedPointerSession | null;
  readonly track: HTMLElement;
  thumb: HTMLElement | null;
  readonly kind: RangeThumb;
}
