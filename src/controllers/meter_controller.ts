import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { eventNumber, type NumericValueEvent } from "../utils/coerce";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { clampRange, rangeFraction } from "../utils/range";
import { TemplateAttributeLease } from "../utils/template_attribute_lease";

/** Threshold segment a value falls into, reflected on `data-state`. */
type MeterState = "low" | "medium" | "high";

/** One point-in-time reading: the clamped value with the ratio and segment it implies. */
type MeterReading = { value: number; ratio: number; state: MeterState };

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
 * battery, score) — distinct from `stimeo--progress`'s task progress.
 * The controller syncs the ARIA value attributes and, when `low`/`high`
 * thresholds are present, classifies the value into a `low`/`medium`/`high`
 * segment on `data-state` so the consumer can color the bar.
 *
 * `change` dispatches `{ value: number, ratio: number, state: string }`.
 *
 * @remarks
 * Behavior only. Because state must not be conveyed by color alone (WCAG 1.4.1),
 * a consumer-provided `valueText` template feeds `aria-valuetext` so the segment
 * is also available as text; with no template, a consumer that authors `aria-valuetext`
 * itself keeps it across renders. While a `valueText` template is set its text replaces an
 * authored `aria-valuetext`; clearing the template or disconnecting puts the authored value
 * back unless the page wrote its own meanwhile, which then stays. A changed template takes
 * the attribute over again. Threshold presence is read from the *attributes* (an absent
 * attribute means "no threshold"), not from a sentinel value.
 */
export class MeterController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  readonly #valueText = new TemplateAttributeLease<HTMLElement>("aria-valuetext", this.identifier);

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

  static valueConstraints = {
    value: NUMBER_BOUNDS.finite,
    min: NUMBER_BOUNDS.finite,
    max: NUMBER_BOUNDS.finite,
    low: NUMBER_BOUNDS.finite,
    high: NUMBER_BOUNDS.finite,
    optimum: NUMBER_BOUNDS.finite,
  } satisfies NumberValueConstraints<typeof MeterController.values>;
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
  readonly #repaint = new MorphRenderWatcher(() => {
    this.#render();
  });

  /** The segment shown last, so an update announces only when it moves the segment. */
  #shownState: MeterState | null = null;

  override connect(): void {
    this.#repaint.observe(this.element);
    this.#render();
  }

  /**
   * Closes the window in which a queued repaint may still run, and returns
   * `aria-valuetext` to the authored value unless the page wrote its own meanwhile.
   */
  override disconnect(): void {
    this.#repaint.disconnect();
    this.#valueText.release(this.element);
  }

  /**
   * Updates the measured value from an action param (`amount`) or a
   * `detail.value` CustomEvent, syncs ARIA and `data-state`, and dispatches
   * `change` with the value, ratio, and computed segment.
   */
  setValue(event: NumericValueEvent): void {
    const next = eventNumber(event);
    if (next === null) return;
    this.valueValue = this.#clamp(next);
    const shown = this.#shownState;
    const reading = this.#render();
    this.dispatch("change", { detail: reading });
    // Only the segment is news: reading every value would be unusable, and the
    // number itself is already exposed through `aria-valuenow`.
    if (reading.state !== shown) {
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
    return clampRange(raw, this.#safeMin, this.#safeMax);
  }

  /** Whether a threshold attribute is present (absent = no threshold). */
  #hasThreshold(name: "low" | "high"): boolean {
    return this.element.hasAttribute(`data-${this.identifier}-${name}-value`);
  }

  /**
   * Classifies `value` into a `low`/`medium`/`high` segment. Values at or below
   * `low` are `low`; at or above `high` are `high`; otherwise `medium`. With
   * neither threshold present, everything is `medium`.
   */
  #stateOf(value: number): MeterState {
    if (this.#hasThreshold("low") && value <= this.#safeLow) return "low";
    if (this.#hasThreshold("high") && value >= this.#safeHigh) return "high";
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
    const value = this.#clamp(this.#safeValue);
    const reading: MeterReading = {
      value,
      ratio: rangeFraction(value, this.#safeMin, this.#safeMax),
      state: this.#stateOf(value),
    };
    this.element.setAttribute("aria-valuemin", String(this.#safeMin));
    this.element.setAttribute("aria-valuemax", String(this.#safeMax));
    this.element.setAttribute("aria-valuenow", String(reading.value));
    this.element.style.setProperty("--stimeo--meter-ratio", String(reading.ratio));
    this.element.setAttribute("data-state", reading.state);
    this.#applyValueText(reading);
    this.#shownState = reading.state;
    return reading;
  }

  /** Renders the template-derived reading while preserving the author's attribute ownership. */
  #applyValueText({ value, ratio, state }: MeterReading): void {
    this.#valueText.render(
      this.element,
      this.valueTextValue,
      fillTemplate(this.valueTextValue, { value, percent: Math.round(ratio * 100), state }),
    );
  }

  /** Current `value` declaration resolved against its numeric contract. */
  get #safeValue(): number {
    return this.#numbers.read(
      this,
      "value",
      this.valueValue,
      MeterController.values.value.default,
      MeterController.valueConstraints.value,
    );
  }

  /** Current `min` declaration resolved against its numeric contract. */
  get #safeMin(): number {
    return this.#numbers.read(
      this,
      "min",
      this.minValue,
      MeterController.values.min.default,
      MeterController.valueConstraints.min,
    );
  }

  /** Current `max` declaration resolved against its numeric contract. */
  get #safeMax(): number {
    return this.#numbers.read(
      this,
      "max",
      this.maxValue,
      MeterController.values.max.default,
      MeterController.valueConstraints.max,
    );
  }

  /** Current `low` declaration resolved against its numeric contract. */
  get #safeLow(): number {
    return this.#numbers.read(
      this,
      "low",
      this.lowValue,
      MeterController.values.low.default,
      MeterController.valueConstraints.low,
    );
  }

  /** Current `high` declaration resolved against its numeric contract. */
  get #safeHigh(): number {
    return this.#numbers.read(
      this,
      "high",
      this.highValue,
      MeterController.values.high.default,
      MeterController.valueConstraints.high,
    );
  }
}
