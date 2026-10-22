import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { eventNumber, type NumericValueEvent } from "../utils/coerce";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { clampRange, rangeFraction } from "../utils/range";
import { TemplateAttributeLease } from "../utils/template_attribute_lease";

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
 * deliberately distinct from `stimeo--meter`'s point-in-time `meter`. The
 * controller owns value normalization and ARIA value-attribute synchronization;
 * the bar's width/animation is the consumer's, driven off the
 * `--stimeo--progress-ratio` (0–1) custom property and `data-state`.
 *
 * `change` dispatches `{ value: number, ratio: number }`; `complete` dispatches
 * `{ value: number }`.
 *
 * @remarks
 * Behavior only — no styling is emitted. An indeterminate bar drops
 * `aria-valuenow` (per ARIA) so assistive tech treats the bar as indeterminate
 * rather than reading a stale value; the consumer animates the indeterminate look off
 * `data-state="indeterminate"`.
 */
export class ProgressController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  readonly #valueText = new TemplateAttributeLease<HTMLElement>("aria-valuetext", this.identifier);

  static override targets = ["bar"];
  static override values = {
    value: { type: Number, default: 0 },
    min: { type: Number, default: 0 },
    max: { type: Number, default: 100 },
    indeterminate: { type: Boolean, default: false },
    valueText: { type: String, default: "" },
    announceText: { type: String, default: "" },
  };

  static valueConstraints = {
    value: NUMBER_BOUNDS.finite,
    min: NUMBER_BOUNDS.finite,
    max: NUMBER_BOUNDS.finite,
  } satisfies NumberValueConstraints<typeof ProgressController.values>;
  static actions = ["setValue"] as const;
  static events = ["change", "complete"] as const;

  declare readonly barTarget: HTMLElement;
  declare readonly hasBarTarget: boolean;

  declare valueValue: number;
  declare minValue: number;
  declare maxValue: number;
  declare indeterminateValue: boolean;
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
   * Updates the progress value from an action param (`amount`) or a
   * `detail.value` CustomEvent, normalizes it into range, syncs ARIA, and
   * dispatches `change` (always) plus `complete` when `max` is reached.
   */
  setValue(event: NumericValueEvent): void {
    const next = eventNumber(event);
    if (next === null) return;
    const value = this.#clamp(next);
    this.valueValue = value;
    this.indeterminateValue = false;
    this.#render();
    this.dispatch("change", { detail: { value, ratio: this.#ratio } });
    if (value >= this.#safeMax) {
      this.dispatch("complete", { detail: { value } });
      // Reaching the end is the transition worth reading out; the running numbers in
      // between are state the consumer can see, not news.
      announce(
        fillTemplate(this.announceTextValue, { value, percent: Math.round(this.#ratio * 100) }),
      );
    }
  }

  /** Repaints when application code (or a Turbo morph) changes `indeterminate` at runtime. */
  indeterminateValueChanged(): void {
    this.#repaint.schedule();
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

  /** Repaints when application code (or a Turbo morph) changes `valueText` at runtime. */
  valueTextValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Clamps `raw` into the configured `[min, max]` range. */
  #clamp(raw: number): number {
    return clampRange(raw, this.#safeMin, this.#safeMax);
  }

  /** Current fraction of the range in `[0, 1]`; `0` when the range is empty. */
  get #ratio(): number {
    return rangeFraction(this.#safeValue, this.#safeMin, this.#safeMax);
  }

  /**
   * Reflects value/range/indeterminate onto ARIA, `data-state`, and the ratio.
   *
   * @stimeoRenderRoot
   */
  #render(): void {
    this.element.setAttribute("aria-valuemin", String(this.#safeMin));
    this.element.setAttribute("aria-valuemax", String(this.#safeMax));

    if (this.indeterminateValue) {
      this.element.removeAttribute("aria-valuenow");
      // `aria-valuetext` outranks `aria-valuenow` for assistive tech, so a text
      // this controller derived from a value would announce the very number the
      // indeterminate state drops.
      this.#valueText.render(this.element, this.valueTextValue, null);
      this.element.style.removeProperty("--stimeo--progress-ratio");
      this.element.setAttribute("data-state", "indeterminate");
      return;
    }

    const value = this.#clamp(this.#safeValue);
    this.element.setAttribute("aria-valuenow", String(value));
    this.element.style.setProperty("--stimeo--progress-ratio", String(this.#ratio));
    this.element.setAttribute("data-state", "determinate");
    this.#applyValueText(value);
  }

  /** Renders the template-derived text while preserving the author's attribute ownership. */
  #applyValueText(value: number): void {
    this.#valueText.render(
      this.element,
      this.valueTextValue,
      fillTemplate(this.valueTextValue, { value, percent: Math.round(this.#ratio * 100) }),
    );
  }

  /** Current `value` declaration resolved against its numeric contract. */
  get #safeValue(): number {
    return this.#numbers.read(
      this,
      "value",
      this.valueValue,
      ProgressController.values.value.default,
      ProgressController.valueConstraints.value,
    );
  }

  /** Current `min` declaration resolved against its numeric contract. */
  get #safeMin(): number {
    return this.#numbers.read(
      this,
      "min",
      this.minValue,
      ProgressController.values.min.default,
      ProgressController.valueConstraints.min,
    );
  }

  /** Current `max` declaration resolved against its numeric contract. */
  get #safeMax(): number {
    return this.#numbers.read(
      this,
      "max",
      this.maxValue,
      ProgressController.values.max.default,
      ProgressController.valueConstraints.max,
    );
  }
}
