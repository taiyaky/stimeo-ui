import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { toFiniteNumber } from "../utils/coerce";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { rangeFraction } from "../utils/range";

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
 * Marks an `aria-valuetext` this controller wrote, so a render takes back only
 * its own text. `aria-valuetext` is shared: a consumer may author it instead of
 * supplying a template, and that text is theirs to keep across renders.
 */
const OWNED_VALUE_TEXT = "data-stimeo--progress-owns-valuetext";

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
 * `--stimeo--progress-ratio` (0–1) custom property and `data-state`.
 *
 * `change` dispatches `{ value: number, ratio: number }`; `complete` dispatches
 * `{ value: number }`.
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
    announceText: { type: String, default: "" },
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
  declare announceTextValue: string;

  /**
   * Collapses a morph that swaps several render inputs at once into one repaint.
   * A single update usually rewrites the whole set, and each Value would otherwise
   * repaint on its own.
   */
  readonly #repaint = new MicrotaskCoalescer(() => {
    this.#render();
  });

  override connect(): void {
    this.#repaint.activate();
    this.#render();
  }

  /** Closes the window in which a queued repaint may still run. */
  override disconnect(): void {
    this.#repaint.cancel();
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
    return Math.min(this.maxValue, Math.max(this.minValue, raw));
  }

  /** Current fraction of the range in `[0, 1]`; `0` when the range is empty. */
  get #ratio(): number {
    return rangeFraction(this.valueValue, this.minValue, this.maxValue);
  }

  /**
   * Reflects value/range/indeterminate onto ARIA, `data-state`, and the ratio.
   *
   * @stimeoRenderRoot
   */
  #render(): void {
    this.element.setAttribute("aria-valuemin", String(this.minValue));
    this.element.setAttribute("aria-valuemax", String(this.maxValue));

    if (this.indeterminateValue) {
      this.element.removeAttribute("aria-valuenow");
      // `aria-valuetext` outranks `aria-valuenow` for assistive tech, so a text
      // this controller derived from a value would announce the very number the
      // indeterminate state drops.
      this.#clearOwnValueText();
      this.element.style.removeProperty("--stimeo--progress-ratio");
      this.element.setAttribute("data-state", "indeterminate");
      return;
    }

    const value = this.#clamp(this.valueValue);
    this.element.setAttribute("aria-valuenow", String(value));
    this.element.style.setProperty("--stimeo--progress-ratio", String(this.#ratio));
    this.element.setAttribute("data-state", "determinate");
    this.#applyValueText(value);
  }

  /**
   * Sets `aria-valuetext` from the consumer-provided template, substituting
   * `{value}` and `{percent}`. Left to the consumer so the human-readable text
   * stays i18n-neutral in the library. With no template the attribute belongs to
   * the consumer, so only a text this controller wrote is taken back
   * ({@link OWNED_VALUE_TEXT}).
   */
  #applyValueText(value: number): void {
    if (this.valueTextValue.length === 0) {
      this.#clearOwnValueText();
      return;
    }
    const percent = Math.round(this.#ratio * 100);
    const text = this.valueTextValue
      .replaceAll("{value}", String(value))
      .replaceAll("{percent}", String(percent));
    this.element.setAttribute("aria-valuetext", text);
    this.element.setAttribute(OWNED_VALUE_TEXT, "");
  }

  /** Removes `aria-valuetext` only when this controller is the one that wrote it. */
  #clearOwnValueText(): void {
    if (!this.element.hasAttribute(OWNED_VALUE_TEXT)) return;
    this.element.removeAttribute("aria-valuetext");
    this.element.removeAttribute(OWNED_VALUE_TEXT);
  }
}
