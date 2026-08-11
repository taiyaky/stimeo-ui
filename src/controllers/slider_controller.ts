import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord, logicalArrowKey } from "../utils/arrow_step";
import { isRtl } from "../utils/logical_scroll";
import { rangeFraction } from "../utils/range";

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
 *       <div data-stimeo--slider-target="thumb" role="slider" tabindex="0"
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

  /** Aborts in-progress pointer-drag listeners when the drag ends or on teardown. */
  #dragAbort: AbortController | null = null;

  /** Whether the consumer declared a mirroring track and the direction mirrors it. */
  get #mirrored(): boolean {
    return this.logicalTrackValue && isRtl(this.element);
  }

  /** Clamps the initial value and renders the starting position. */
  override connect(): void {
    this.#setValue(this.valueValue, { silent: true });
  }

  /** Cancels any active pointer drag so document listeners never leak. */
  override disconnect(): void {
    this.#dragAbort?.abort();
    this.#dragAbort = null;
  }

  /** Handles keyboard stepping per the APG slider model. */
  onKeydown(event: KeyboardEvent): void {
    if (isReservedArrowChord(event)) return;
    const big = this.stepValue * 10;
    let next: number | null = null;
    // On a mirrored track the greater value sits at the visual left, so the
    // horizontal pair trades places; the vertical pair passes through.
    switch (this.#mirrored ? logicalArrowKey(event.key, this.element) : event.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = this.valueValue + this.stepValue;
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = this.valueValue - this.stepValue;
        break;
      case "PageUp":
        next = this.valueValue + big;
        break;
      case "PageDown":
        next = this.valueValue - big;
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
    this.#setValue(next);
  }

  /** Begins a pointer drag: sets the value and tracks subsequent movement. */
  onPointerDown(event: PointerEvent): void {
    if (!this.hasTrackTarget) return;
    event.preventDefault();
    // Resolve the direction once for the whole gesture: reading it per move
    // would query computed style on every frame, and a drag that flipped
    // mid-gesture would be incoherent anyway.
    const mirrored = this.#mirrored;
    this.#updateFromClientX(event.clientX, mirrored);
    if (this.hasThumbTarget) this.thumbTarget.focus();

    this.#dragAbort?.abort();
    const abort = new AbortController();
    this.#dragAbort = abort;
    const onMove = (move: PointerEvent): void => this.#updateFromClientX(move.clientX, mirrored);
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

  /** Maps a pointer X coordinate to a value using the track's geometry. */
  #updateFromClientX(clientX: number, mirrored: boolean): void {
    const rect = this.trackTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const offset = (clientX - rect.left) / rect.width;
    const fraction = mirrored ? 1 - offset : offset;
    this.#setValue(this.minValue + fraction * (this.maxValue - this.minValue));
  }

  /**
   * Clamps `raw` to `[min, max]`, snaps it to the nearest step, stores it, and
   * reflects the new state on the thumb's ARIA attributes and the fraction
   * custom property. Dispatches `change` (detail `{ value }`) on a real value
   * change — symmetric with `range-slider` — unless `silent` (the initial
   * connect render, which is not a user edit).
   */
  #setValue(raw: number, { silent = false }: { silent?: boolean } = {}): void {
    const clamped = Math.min(this.maxValue, Math.max(this.minValue, raw));
    const stepped =
      this.stepValue > 0
        ? Math.round((clamped - this.minValue) / this.stepValue) * this.stepValue + this.minValue
        : clamped;
    const value = Math.min(this.maxValue, Math.max(this.minValue, stepped));
    const changed = value !== this.valueValue;
    this.valueValue = value;

    if (this.hasThumbTarget) {
      this.thumbTarget.setAttribute("aria-valuemin", String(this.minValue));
      this.thumbTarget.setAttribute("aria-valuemax", String(this.maxValue));
      this.thumbTarget.setAttribute("aria-valuenow", String(value));
    }

    const fraction = rangeFraction(value, this.minValue, this.maxValue);
    this.element.style.setProperty(FRACTION_PROPERTY, String(fraction));

    if (changed && !silent) this.dispatch("change", { detail: { value } });
  }
}
