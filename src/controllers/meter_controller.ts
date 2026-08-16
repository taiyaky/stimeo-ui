import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { toFiniteNumber } from "../utils/coerce";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { rangeFraction } from "../utils/range";

/**
 * Event shape `setValue` accepts: an action param `amount` or a `detail.value`.
 * Both are typed `number | string` because, while Stimulus coerces numeric action
 * params to numbers, a `meter:set` CustomEvent (or a non-numeric-looking param)
 * may carry a string; {@link MeterController.setValue} normalizes either form.
 */
type SetValueEvent = Event & {
  params?: { amount?: number | string };
  detail?: { value?: number | string };
};

/** Threshold segment a value falls into, reflected on `data-state`. */
type MeterState = "low" | "medium" | "high";

/** One point-in-time reading: the clamped value with the ratio and segment it implies. */
type MeterReading = { value: number; ratio: number; state: MeterState };

/**
 * Marks an `aria-valuetext` this controller wrote, so a render takes back only
 * its own text. `aria-valuetext` is shared: a consumer may author it instead of
 * supplying a template, and that text is what carries the threshold segment to
 * readers who cannot see the colour — clearing it would take the segment with it.
 */
const OWNED_VALUE_TEXT = "data-stimeo--meter-owns-valuetext";

/**
 * Headless meter behavior backed by the WAI-ARIA `meter` role.
 *
 * Markup contract (identifier: `stimeo--meter`):
 *   <div data-controller="stimeo--meter" role="meter" aria-label="Disk usage"
 *        aria-valuemin="0" aria-valuemax="100" aria-valuenow="72"
 *        data-stimeo--meter-value-value="72"
 *        data-stimeo--meter-low-value="50" data-stimeo--meter-high-value="80">
 *     <div data-stimeo--meter-target="bar"></div>
 *   </div>
 *
 * A `meter` is a *point-in-time* scalar within a known range (disk usage,
 * battery, score) — distinct from {@link ProgressController}'s task progress.
 * The controller syncs the ARIA value attributes and, when `low`/`high`
 * thresholds are present, classifies the value into a `low`/`medium`/`high`
 * segment on `data-state` so the consumer can color the bar.
 *
 * `change` dispatches `{ value: number, ratio: number, state: string }`.
 *
 * @remarks
 * Behavior only. Because state must not be conveyed by color alone (WCAG 1.4.1),
 * a consumer-provided `valueText` template feeds `aria-valuetext` so the segment
 * is also available as text; a consumer that authors `aria-valuetext` itself keeps
 * it instead (see {@link OWNED_VALUE_TEXT}). Threshold presence is read from the
 * *attributes* (an absent attribute means "no threshold"), not from a sentinel value.
 */
export class MeterController extends Controller<HTMLElement> {
  static override targets = ["bar"];
  static override values = {
    announceText: { type: String, default: "" },
    value: { type: Number, default: 0 },
    min: { type: Number, default: 0 },
    max: { type: Number, default: 100 },
    low: { type: Number, default: 0 },
    high: { type: Number, default: 0 },
    optimum: { type: Number, default: 0 },
    valueText: { type: String, default: "" },
  };
  static actions = ["setValue"] as const;
  static events = ["change"] as const;

  declare readonly barTarget: HTMLElement;
  declare readonly hasBarTarget: boolean;

  declare valueValue: number;
  declare minValue: number;
  declare maxValue: number;
  declare lowValue: number;
  declare highValue: number;
  declare optimumValue: number;
  declare valueTextValue: string;
  declare announceTextValue: string;

  /**
   * Collapses a morph that swaps several render inputs at once into one repaint.
   * A single update usually rewrites the whole set, and each Value would otherwise
   * repaint on its own.
   */
  readonly #repaint = new MicrotaskCoalescer(() => {
    this.#render();
  });

  /** The segment last announced, so only a change is read out. */
  #announcedState: MeterState | null = null;

  override connect(): void {
    this.#repaint.activate();
    this.#render();
  }

  /** Closes the window in which a queued repaint may still run. */
  override disconnect(): void {
    this.#repaint.cancel();
  }

  /**
   * Updates the measured value from an action param (`amount`) or a
   * `detail.value` CustomEvent, syncs ARIA and `data-state`, and dispatches
   * `change` with the value, ratio, and computed segment.
   */
  setValue(event: SetValueEvent): void {
    const next = toFiniteNumber(event.params?.amount ?? event.detail?.value);
    if (next === null) return;
    this.valueValue = this.#clamp(next);
    const reading = this.#render();
    this.dispatch("change", { detail: reading });
    // Only the segment is news: reading every value would be unusable, and the
    // number itself is already exposed through `aria-valuenow`.
    if (reading.state !== this.#announcedState) {
      this.#announcedState = reading.state;
      announce(
        fillTemplate(this.announceTextValue, { state: reading.state, value: reading.value }),
      );
    }
  }

  /** Repaints when application code (or a Turbo morph) changes `value` at runtime. */
  valueValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `min` at runtime. */
  minValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `max` at runtime. */
  maxValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `low` at runtime. */
  lowValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `high` at runtime. */
  highValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `valueText` at runtime. */
  valueTextValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Clamps `raw` into the configured `[min, max]` range. */
  #clamp(raw: number): number {
    return Math.min(this.maxValue, Math.max(this.minValue, raw));
  }

  /** Whether a threshold attribute is present (absent = no threshold). */
  #hasThreshold(name: "low" | "high"): boolean {
    return this.element.hasAttribute(`data-stimeo--meter-${name}-value`);
  }

  /**
   * Classifies `value` into a `low`/`medium`/`high` segment. Values at or below
   * `low` are `low`; at or above `high` are `high`; otherwise `medium`. With
   * neither threshold present, everything is `medium`.
   */
  #stateOf(value: number): MeterState {
    if (this.#hasThreshold("low") && value <= this.lowValue) return "low";
    if (this.#hasThreshold("high") && value >= this.highValue) return "high";
    return "medium";
  }

  /**
   * Reflects value/range onto ARIA, the segment onto `data-state`, and the ratio.
   * The reading is derived once and returned, so the `change` detail reports the
   * same numbers the DOM just received.
   *
   * @stimeoRenderRoot
   */
  #render(): MeterReading {
    const value = this.#clamp(this.valueValue);
    const reading: MeterReading = {
      value,
      ratio: rangeFraction(value, this.minValue, this.maxValue),
      state: this.#stateOf(value),
    };
    this.element.setAttribute("aria-valuemin", String(this.minValue));
    this.element.setAttribute("aria-valuemax", String(this.maxValue));
    this.element.setAttribute("aria-valuenow", String(reading.value));
    this.element.style.setProperty("--stimeo--meter-ratio", String(reading.ratio));
    this.element.setAttribute("data-state", reading.state);
    this.#applyValueText(reading);
    return reading;
  }

  /**
   * Sets `aria-valuetext` from the consumer-provided template, substituting
   * `{value}`, `{percent}`, and `{state}`. Kept i18n-neutral in the library.
   * With no template the attribute belongs to the consumer, so only a text this
   * controller wrote is taken back ({@link OWNED_VALUE_TEXT}).
   */
  #applyValueText({ value, ratio, state }: MeterReading): void {
    if (this.valueTextValue.length === 0) {
      if (this.element.hasAttribute(OWNED_VALUE_TEXT)) {
        this.element.removeAttribute("aria-valuetext");
        this.element.removeAttribute(OWNED_VALUE_TEXT);
      }
      return;
    }
    const percent = Math.round(ratio * 100);
    const text = this.valueTextValue
      .replaceAll("{value}", String(value))
      .replaceAll("{percent}", String(percent))
      .replaceAll("{state}", state);
    this.element.setAttribute("aria-valuetext", text);
    this.element.setAttribute(OWNED_VALUE_TEXT, "");
  }
}
