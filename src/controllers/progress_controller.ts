import { Controller } from "@hotwired/stimulus";
import { toFiniteNumber } from "../utils/coerce";

/**
 * Event shape `setValue` accepts: an action param `amount` or a `detail.value`.
 * Both are typed `number | string` because, while Stimulus coerces numeric action
 * params to numbers, a `progress:set` CustomEvent (or a non-numeric-looking param)
 * may carry a string; {@link ProgressController.setValue} normalizes either form.
 */
type SetValueEvent = Event & {
  params?: { amount?: number | string };
  detail?: { value?: number | string };
};

/**
 * Headless progress-bar behavior backed by the WAI-ARIA `progressbar` role.
 *
 * Markup contract (identifier: `stimeo--progress`):
 *   <div data-controller="stimeo--progress" role="progressbar"
 *        aria-label="Upload" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"
 *        data-stimeo--progress-value-value="0"
 *        data-action="progress:set->stimeo--progress#setValue">
 *     <div data-stimeo--progress-target="bar"></div>
 *   </div>
 *
 * This is the *progress over time* role (a task advancing toward completion),
 * deliberately distinct from {@link MeterController}'s point-in-time `meter`. The
 * controller owns value normalization and ARIA value-attribute synchronization;
 * the bar's width/animation is the consumer's, driven off the
 * `--stimeo-progress-ratio` (0–1) custom property and `data-state`.
 *
 * @remarks
 * Behavior only — no styling is emitted. An indeterminate bar drops
 * `aria-valuenow` (per ARIA) so assistive tech announces "busy" rather than a
 * stale value; the consumer animates the indeterminate look off
 * `data-state="indeterminate"`.
 */
export class ProgressController extends Controller<HTMLElement> {
  static override targets = ["bar"];
  static override values = {
    value: { type: Number, default: 0 },
    min: { type: Number, default: 0 },
    max: { type: Number, default: 100 },
    indeterminate: { type: Boolean, default: false },
    valueText: { type: String, default: "" },
  };
  static actions = ["setValue"] as const;
  static events = ["change", "complete"] as const;

  declare readonly barTarget: HTMLElement;
  declare readonly hasBarTarget: boolean;

  declare valueValue: number;
  declare minValue: number;
  declare maxValue: number;
  declare indeterminateValue: boolean;
  declare valueTextValue: string;

  override connect(): void {
    this.#render();
  }

  /**
   * Updates the progress value from an action param (`amount`) or a
   * `detail.value` CustomEvent, normalizes it into range, syncs ARIA, and
   * dispatches `change` (always) plus `complete` when `max` is reached.
   */
  setValue(event: SetValueEvent): void {
    const next = toFiniteNumber(event.params?.amount ?? event.detail?.value);
    if (next === null) return;
    const value = this.#clamp(next);
    this.valueValue = value;
    this.indeterminateValue = false;
    this.#render();
    this.dispatch("change", { detail: { value, ratio: this.#ratio } });
    if (value >= this.maxValue) {
      this.dispatch("complete", { detail: { value } });
    }
  }

  /** Re-render when the indeterminate flag is toggled via its data attribute. */
  indeterminateValueChanged(): void {
    // Stimulus fires this once during initialization (before `connect`), where
    // touching the DOM is still safe; guard nothing.
    this.#render();
  }

  /** Clamps `raw` into the configured `[min, max]` range. */
  #clamp(raw: number): number {
    return Math.min(this.maxValue, Math.max(this.minValue, raw));
  }

  /** Current fraction of the range in `[0, 1]`; `0` when the range is empty. */
  get #ratio(): number {
    const span = this.maxValue - this.minValue;
    if (span <= 0) return 0;
    // Clamp first so an out-of-range value (e.g. an initial value past `max`)
    // can never push the ratio — and thus the bar width / percent — outside 0–1.
    return (this.#clamp(this.valueValue) - this.minValue) / span;
  }

  /** Reflects value/range/indeterminate onto ARIA, `data-state`, and the ratio. */
  #render(): void {
    this.element.setAttribute("aria-valuemin", String(this.minValue));
    this.element.setAttribute("aria-valuemax", String(this.maxValue));

    if (this.indeterminateValue) {
      this.element.removeAttribute("aria-valuenow");
      this.element.removeAttribute("aria-valuetext");
      this.element.style.removeProperty("--stimeo-progress-ratio");
      this.element.setAttribute("data-state", "indeterminate");
      return;
    }

    const value = this.#clamp(this.valueValue);
    this.element.setAttribute("aria-valuenow", String(value));
    this.element.style.setProperty("--stimeo-progress-ratio", String(this.#ratio));
    this.element.setAttribute("data-state", "determinate");
    this.#applyValueText(value);
  }

  /**
   * Sets `aria-valuetext` from the consumer-provided template, substituting
   * `{value}` and `{percent}`. Left to the consumer so the human-readable text
   * stays i18n-neutral in the library; cleared when no template is given.
   */
  #applyValueText(value: number): void {
    if (this.valueTextValue.length === 0) {
      this.element.removeAttribute("aria-valuetext");
      return;
    }
    const percent = Math.round(this.#ratio * 100);
    const text = this.valueTextValue
      .replaceAll("{value}", String(value))
      .replaceAll("{percent}", String(percent));
    this.element.setAttribute("aria-valuetext", text);
  }
}
