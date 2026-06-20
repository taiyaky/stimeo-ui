import { Controller } from "@hotwired/stimulus";
import { toFiniteNumber } from "../utils/coerce";

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
 * @remarks
 * Behavior only. Because state must not be conveyed by color alone (WCAG 1.4.1),
 * a consumer-provided `valueText` template feeds `aria-valuetext` so the segment
 * is also available as text. Threshold presence is read from the *attributes*
 * (an absent attribute means "no threshold"), not from a sentinel value.
 */
export class MeterController extends Controller<HTMLElement> {
  static override targets = ["bar"];
  static override values = {
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

  override connect(): void {
    this.#render();
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
    this.#render();
    this.dispatch("change", {
      detail: { value: this.valueValue, ratio: this.#ratio, state: this.#state },
    });
  }

  /** Clamps `raw` into the configured `[min, max]` range. */
  #clamp(raw: number): number {
    return Math.min(this.maxValue, Math.max(this.minValue, raw));
  }

  /** Current fraction of the range in `[0, 1]`; `0` when the range is empty. */
  get #ratio(): number {
    const span = this.maxValue - this.minValue;
    if (span <= 0) return 0;
    return (this.#clamp(this.valueValue) - this.minValue) / span;
  }

  /** Whether a threshold attribute is present (absent = no threshold). */
  #hasThreshold(name: "low" | "high"): boolean {
    return this.element.hasAttribute(`data-stimeo--meter-${name}-value`);
  }

  /**
   * Classifies the value into a `low`/`medium`/`high` segment. Values at or
   * below `low` are `low`; at or above `high` are `high`; otherwise `medium`.
   * With neither threshold present, everything is `medium`.
   */
  get #state(): MeterState {
    const value = this.#clamp(this.valueValue);
    if (this.#hasThreshold("low") && value <= this.lowValue) return "low";
    if (this.#hasThreshold("high") && value >= this.highValue) return "high";
    return "medium";
  }

  /** Reflects value/range onto ARIA, the segment onto `data-state`, and the ratio. */
  #render(): void {
    const value = this.#clamp(this.valueValue);
    this.element.setAttribute("aria-valuemin", String(this.minValue));
    this.element.setAttribute("aria-valuemax", String(this.maxValue));
    this.element.setAttribute("aria-valuenow", String(value));
    this.element.style.setProperty("--stimeo-meter-ratio", String(this.#ratio));
    this.element.setAttribute("data-state", this.#state);
    this.#applyValueText(value);
  }

  /**
   * Sets `aria-valuetext` from the consumer-provided template, substituting
   * `{value}`, `{percent}`, and `{state}`. Kept i18n-neutral in the library;
   * cleared when no template is given.
   */
  #applyValueText(value: number): void {
    if (this.valueTextValue.length === 0) {
      this.element.removeAttribute("aria-valuetext");
      return;
    }
    const percent = Math.round(this.#ratio * 100);
    const text = this.valueTextValue
      .replaceAll("{value}", String(value))
      .replaceAll("{percent}", String(percent))
      .replaceAll("{state}", this.#state);
    this.element.setAttribute("aria-valuetext", text);
  }
}
