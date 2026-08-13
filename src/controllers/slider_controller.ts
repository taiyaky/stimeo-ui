import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord, logicalArrowKey } from "../utils/arrow_step";
import { isRtl } from "../utils/logical_scroll";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { OwnedPointerSession } from "../utils/owned_pointer_session";
import { rangeFraction } from "../utils/range";
import { snapSteppedValue, stepSteppedValue } from "../utils/stepped_value";

/** Name of the CSS custom property exposing the thumb position (0..1). */
const FRACTION_PROPERTY = "--stimeo--slider-fraction";

/**
 * Headless, accessible slider (single-thumb range) behavior.
 *
 * Markup contract (identifier: `stimeo--slider`):
 *   <div data-controller="stimeo--slider"
 *        data-stimeo--slider-min-value="0"
 *        data-stimeo--slider-max-value="100"
 *        data-stimeo--slider-step-value="1"
 *        data-stimeo--slider-value-value="40">
 *     <div data-stimeo--slider-target="track"
 *          data-action="pointerdown->stimeo--slider#onPointerDown">
 *       <div data-stimeo--slider-target="thumb" role="slider" tabindex="0" aria-label="Volume"
 *            aria-valuemin="0" aria-valuemax="100" aria-valuenow="40"
 *            data-action="keydown->stimeo--slider#onKeydown"></div>
 *     </div>
 *   </div>
 *
 * Implements the WAI-ARIA APG **Slider** pattern. The current value is exposed
 * to assistive tech via `aria-valuenow`/`aria-valuemin`/`aria-valuemax` on the
 * thumb, and to the consumer's CSS via the `--stimeo--slider-fraction` custom
 * property (a number in `[0, 1]`) set on the controller element — the library
 * positions nothing itself.
 *
 * @remarks
 * Behavior only. The consumer owns all layout (e.g. positioning the thumb from
 * the fraction). Only the horizontal orientation is handled.
 *
 * Behavior provided:
 * - `ArrowRight`/`ArrowUp` increase and `ArrowLeft`/`ArrowDown` decrease by one
 *   step; `Home`/`End` jump to the min/max; `PageUp`/`PageDown` move by ten steps.
 * - Pointer press/drag on the track sets the value from the pointer position.
 * - `step` must be finite and positive; invalid runtime input falls back to `1`.
 *   Finite endpoints remain allowed even when they do not align to the step grid.
 *
 * The fraction is a value ratio, not a position, so only the consumer knows
 * whether their track mirrors under RTL. Set `logicalTrack` to declare that it
 * does: the pointer mapping and the horizontal arrow pair then follow the
 * writing direction. Left unset, nothing here reads `direction`.
 */
export class SliderController extends Controller<HTMLElement> {
  static override targets = ["track", "thumb"];
  static override values = {
    min: { type: Number, default: 0 },
    max: { type: Number, default: 100 },
    step: { type: Number, default: 1 },
    value: { type: Number, default: 0 },
    logicalTrack: { type: Boolean, default: false },
  };
  static actions = ["onKeydown", "onPointerDown"] as const;
  static events = ["change"] as const;

  declare readonly trackTarget: HTMLElement;
  declare readonly thumbTarget: HTMLElement;
  declare readonly hasTrackTarget: boolean;
  declare readonly hasThumbTarget: boolean;
  declare minValue: number;
  declare maxValue: number;
  declare stepValue: number;
  declare valueValue: number;
  declare logicalTrackValue: boolean;

  /** One initiating pointer owns each live drag and its stable target snapshot. */
  #drag: SliderDrag | null = null;

  /** Collapses a morph that swaps several render Values into one silent repaint. */
  readonly #repaint = new MicrotaskCoalescer(() => this.#render());

  /** Whether the consumer declared a mirroring track and the direction mirrors it. */
  get #mirrored(): boolean {
    return this.logicalTrackValue && isRtl(this.element);
  }

  /** Clamps the initial value and renders the starting position. */
  override connect(): void {
    this.#repaint.activate();
    this.#commit(this.valueValue, false);
  }

  /** Cancels any active pointer drag so document listeners never leak. */
  override disconnect(): void {
    this.#repaint.cancel();
    this.#endDrag();
  }

  /** Silently repaints a minimum changed by application code or a Turbo morph. */
  minValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Silently repaints a maximum changed by application code or a Turbo morph. */
  maxValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Silently repaints a step changed by application code or a Turbo morph. */
  stepValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Silently repaints a value changed by application code or a Turbo morph. */
  valueValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Hydrates a thumb inserted or replaced at runtime with the current ARIA state. */
  thumbTargetConnected(thumb: HTMLElement): void {
    const value = this.#currentValue();
    this.#renderThumb(thumb, value);
    this.#renderFraction(value);
    if (this.#drag && this.#drag.thumb === null) {
      this.#drag.thumb = thumb;
      thumb.focus();
    }
    this.#repaint.schedule();
  }

  /** Drops the stale focus owner while allowing a live track gesture to continue. */
  thumbTargetDisconnected(thumb: HTMLElement): void {
    if (this.#drag?.thumb === thumb) this.#drag.thumb = null;
  }

  /** Ends a gesture whose geometry target disappeared or ceased being a target. */
  trackTargetDisconnected(track: HTMLElement): void {
    if (this.#drag?.track === track) this.#endDrag();
  }

  /** Handles keyboard stepping per the APG slider model. */
  onKeydown(event: KeyboardEvent): void {
    if (isReservedArrowChord(event)) return;
    let next: number | null = null;
    const current = this.#currentValue();
    const range = this.#steppedRange;
    // On a mirrored track the greater value sits at the visual left, so the
    // horizontal pair trades places; the vertical pair passes through.
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
        next = this.minValue;
        break;
      case "End":
        next = this.maxValue;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.#commit(next, true);
  }

  /** Begins a pointer drag: sets the value and tracks subsequent movement. */
  onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.#drag || !this.hasTrackTarget || !this.hasThumbTarget) return;
    const track = this.trackTarget;
    const thumb = this.thumbTarget;
    // Resolve the direction once for the whole gesture: reading it per move
    // would query computed style on every frame, and a drag that flipped
    // mid-gesture would be incoherent anyway.
    const mirrored = this.#mirrored;
    const value = this.#valueFromClientX(event.clientX, mirrored, track);
    if (value === null) return;
    event.preventDefault();
    this.#commit(value, true);
    thumb.focus();

    const drag: SliderDrag = { pointer: null, track, thumb };
    drag.pointer = new OwnedPointerSession(event, track, {
      move: (move) => {
        if (!track.isConnected) {
          this.#endDrag();
          return;
        }
        const moved = this.#valueFromClientX(move.clientX, mirrored, track);
        if (moved !== null) this.#commit(moved, true);
      },
      end: () => {
        if (this.#drag === drag) this.#drag = null;
      },
    });
    this.#drag = drag;
  }

  /** Maps a pointer X coordinate to a raw value using a stable track snapshot. */
  #valueFromClientX(clientX: number, mirrored: boolean, track: HTMLElement): number | null {
    const rect = track.getBoundingClientRect();
    if (rect.width === 0) return null;
    const offset = (clientX - rect.left) / rect.width;
    const fraction = mirrored ? 1 - offset : offset;
    return this.minValue + fraction * (this.maxValue - this.minValue);
  }

  /**
   * Stores a normalized value and renders synchronously for responsive input.
   * Morph callbacks use {@link #render} instead, so they never write Values back
   * or dispatch a user-facing change event.
   */
  #commit(raw: number, notify: boolean): void {
    const previous = this.#currentValue();
    const value = snapSteppedValue(raw, this.#steppedRange);
    if (!Object.is(this.valueValue, value)) this.valueValue = value;
    this.#renderValue(value);
    if (notify && value !== previous) this.dispatch("change", { detail: { value } });
  }

  /**
   * Reflects the normalized current Value without mutating or dispatching it.
   *
   * @stimeoRenderRoot
   */
  #render(): void {
    this.#renderValue(this.#currentValue());
  }

  /** Reflects one normalized value on the current target and CSS output. */
  #renderValue(value: number): void {
    if (this.hasThumbTarget) {
      this.#renderThumb(this.thumbTarget, value);
    }
    this.#renderFraction(value);
  }

  /** Writes only ARIA values that differ, including on a replacement target. */
  #renderThumb(thumb: HTMLElement, value: number): void {
    const attributes = {
      "aria-valuemin": String(this.minValue),
      "aria-valuemax": String(this.maxValue),
      "aria-valuenow": String(value),
    };
    for (const [name, next] of Object.entries(attributes)) {
      if (thumb.getAttribute(name) !== next) thumb.setAttribute(name, next);
    }
  }

  /** Writes the behavior-only positioning hook only when its value changed. */
  #renderFraction(value: number): void {
    const fraction = rangeFraction(value, this.minValue, this.maxValue);
    const next = String(fraction);
    if (this.element.style.getPropertyValue(FRACTION_PROPERTY) !== next) {
      this.element.style.setProperty(FRACTION_PROPERTY, next);
    }
  }

  /** Current normalized value derived from the live declarative inputs. */
  #currentValue(): number {
    return snapSteppedValue(this.valueValue, this.#steppedRange);
  }

  /** Shared range configuration; finite endpoints remain allowed off the grid. */
  get #steppedRange() {
    return { min: this.minValue, max: this.maxValue, step: this.stepValue };
  }

  /** Ends the current pointer session without dispatching another change. */
  #endDrag(): void {
    const drag = this.#drag;
    this.#drag = null;
    drag?.pointer?.end();
  }
}

/** Stable DOM and gesture state owned for the duration of one pointer drag. */
interface SliderDrag {
  pointer: OwnedPointerSession | null;
  readonly track: HTMLElement;
  thumb: HTMLElement | null;
}
