import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord } from "../utils/arrow_step";
import { AttributeLease } from "../utils/attribute_lease";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { type SteppedRange, snapSteppedValue, stepSteppedValue } from "../utils/stepped_value";

const DEFAULT_MIN = 0;
const DEFAULT_MAX = 100;

/**
 * Headless **Separator** behavior. The normative source depends on the case:
 * a decorative divider follows the WAI-ARIA `separator` role
 * (https://www.w3.org/TR/wai-aria-1.2/#separator), while the focusable,
 * value-bearing divider follows the APG Window Splitter pattern
 * (https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/).
 *
 * Markup contract (identifier: `stimeo--separator`):
 *   <!-- decorative -->
 *   <div data-controller="stimeo--separator"
 *        data-stimeo--separator-orientation-value="horizontal"></div>
 *
 *   <!-- focusable, value-bearing -->
 *   <div data-controller="stimeo--separator"
 *        aria-labelledby="sidebar-heading" aria-controls="sidebar"
 *        data-stimeo--separator-orientation-value="vertical"
 *        data-stimeo--separator-focusable-value="true"
 *        data-stimeo--separator-min-value="0"
 *        data-stimeo--separator-max-value="100"
 *        data-stimeo--separator-step-value="1"
 *        data-stimeo--separator-value-value="50"
 *        data-action="keydown->stimeo--separator#onKeydown"></div>
 *
 * The Stimulus Values are the live inputs. The controller reflects them as
 * `role`, `tabindex`, `aria-orientation`, and the range ARIA while connected,
 * then restores the attributes it displaced on disconnect and before Turbo
 * caches the page. Existing finite range ARIA is hydrated into otherwise
 * absent Values once, which preserves progressively enhanced server markup
 * without leaving two live sources of truth.
 *
 * `change` dispatches `{ value: number }`.
 *
 * @remarks
 * Behavior only — line drawing is the consumer's CSS. The axis follows Window
 * Splitter: a vertical divider takes ArrowLeft/ArrowRight, a horizontal one
 * takes ArrowUp/ArrowDown. Which end counts as an increase is not defined
 * there, so it follows the slider convention (ArrowRight/ArrowUp increase).
 * Home/End are optional in the pattern and are implemented here; F6 is not.
 *
 * Runtime Value changes repaint silently. A maximum below the effective
 * minimum collapses to that minimum; non-finite bounds use `0`/`100`, and an
 * invalid or non-positive step uses `1`. Finite endpoints remain reachable even
 * when they do not align to the step grid.
 *
 * Because no position is ever applied here, two Window Splitter requirements
 * fall to the consumer: `aria-controls` naming the **primary** pane — the one
 * whose size the value reports — and `Enter` to toggle collapse/restore, since
 * collapsing applies a position — {@link ResizableController} implements that
 * key for the same divider. Because the increment direction is fixed, the
 * primary pane can only be the left one for a vertical splitter and the bottom
 * one for a horizontal splitter: those are the panes that grow as
 * ArrowRight/ArrowUp raise the value.
 */
export class SeparatorController extends Controller<HTMLElement> {
  static override values = {
    orientation: { type: String, default: "horizontal" },
    focusable: { type: Boolean, default: false },
    min: { type: Number, default: DEFAULT_MIN },
    max: { type: Number, default: DEFAULT_MAX },
    step: { type: Number, default: 1 },
    value: { type: Number, default: DEFAULT_MIN },
  };
  static actions = ["onKeydown"] as const;
  static events = ["change"] as const;

  declare orientationValue: string;
  declare focusableValue: boolean;
  declare minValue: number;
  declare maxValue: number;
  declare stepValue: number;
  declare valueValue: number;

  readonly #role = new AttributeLease<HTMLElement>("role");
  readonly #tabindex = new AttributeLease<HTMLElement>("tabindex");
  readonly #orientation = new AttributeLease<HTMLElement>("aria-orientation");
  readonly #minimum = new AttributeLease<HTMLElement>("aria-valuemin");
  readonly #maximum = new AttributeLease<HTMLElement>("aria-valuemax");
  readonly #current = new AttributeLease<HTMLElement>("aria-valuenow");

  /** Collapses a morph that changes several render Values into one silent repaint. */
  readonly #repaint = new MicrotaskCoalescer(() => this.#render());

  /** Restores authored semantics before Turbo snapshots the element. */
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindForCache());

  /** Hydrates legacy ARIA input once, normalizes the current Value, and renders. */
  override connect(): void {
    this.#hydrateValues();
    this.#repaint.activate();
    this.#beforeCache.activate();
    const value = this.#currentValue();
    if (!Object.is(this.valueValue, value)) this.valueValue = value;
    this.#render();
  }

  /** Cancels repaint work and returns every semantic attribute this instance controlled. */
  override disconnect(): void {
    this.#repaint.cancel();
    this.#beforeCache.deactivate();
    this.#returnAttributes();
  }

  /** Silently repaints an orientation changed by application code or a Turbo morph. */
  orientationValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Silently adds or removes the focusable range semantics at runtime. */
  focusableValueChanged(): void {
    this.#repaint.schedule();
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

  /** Silently repaints a current value changed by application code or a Turbo morph. */
  valueValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Adjusts the value on arrow / Home / End keys (focusable variant only). */
  onKeydown(event: KeyboardEvent): void {
    if (isReservedArrowChord(event) || !this.focusableValue) return;

    const horizontal = this.#effectiveOrientation === "horizontal";
    const range = this.#effectiveRange;
    const current = snapSteppedValue(this.valueValue, range);
    let next: number | null = null;
    switch (event.key) {
      case "ArrowUp":
        if (horizontal) next = stepSteppedValue(current, 1, range);
        break;
      case "ArrowDown":
        if (horizontal) next = stepSteppedValue(current, -1, range);
        break;
      case "ArrowRight":
        if (!horizontal) next = stepSteppedValue(current, 1, range);
        break;
      case "ArrowLeft":
        if (!horizontal) next = stepSteppedValue(current, -1, range);
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
    if (next === null) return;

    event.preventDefault();
    this.#commit(next, current);
  }

  /** Stores a normalized user value, renders immediately, and reports real changes. */
  #commit(raw: number, previous: number): void {
    const value = snapSteppedValue(raw, this.#effectiveRange);
    if (!Object.is(this.valueValue, value)) this.valueValue = value;
    this.#render();
    if (value !== previous) this.dispatch("change", { detail: { value } });
  }

  /**
   * Reflects live Values into the connected element without dispatching.
   *
   * @stimeoRenderRoot
   */
  #render(): void {
    const range = this.#effectiveRange;
    const value = snapSteppedValue(this.valueValue, range);
    this.#role.write(this.element, "separator");
    this.#orientation.write(this.element, this.#effectiveOrientation);

    if (!this.focusableValue) {
      this.#tabindex.write(this.element, null);
      this.#minimum.write(this.element, null);
      this.#maximum.write(this.element, null);
      this.#current.write(this.element, null);
      return;
    }

    this.#tabindex.write(this.element, "0");
    this.#minimum.write(this.element, String(range.min));
    this.#maximum.write(this.element, String(range.max));
    this.#current.write(this.element, String(value));
  }

  /** Effective orientation; unknown strings fall back to the horizontal contract. */
  get #effectiveOrientation(): "horizontal" | "vertical" {
    return this.orientationValue === "vertical" ? "vertical" : "horizontal";
  }

  /** Finite, ordered range shared by rendering and keyboard stepping. */
  get #effectiveRange(): SteppedRange {
    const min = Number.isFinite(this.minValue) ? this.minValue : DEFAULT_MIN;
    const candidateMax = Number.isFinite(this.maxValue) ? this.maxValue : DEFAULT_MAX;
    return {
      min,
      max: Math.max(min, candidateMax),
      step: this.stepValue,
      base: min,
    };
  }

  /** Current normalized value derived from the live declarative inputs. */
  #currentValue(): number {
    return snapSteppedValue(this.valueValue, this.#effectiveRange);
  }

  /** Copies valid authored ARIA into Values only when no explicit Value exists. */
  #hydrateValues(): void {
    if (!this.#hasInput("orientation")) {
      const orientation = this.element.getAttribute("aria-orientation");
      if (orientation === "horizontal" || orientation === "vertical") {
        this.orientationValue = orientation;
      }
    }

    const min = this.#finiteAttribute("aria-valuemin");
    if (!this.#hasInput("min") && min !== null) this.minValue = min;
    const max = this.#finiteAttribute("aria-valuemax");
    if (!this.#hasInput("max") && max !== null) this.maxValue = max;
    const value = this.#finiteAttribute("aria-valuenow");
    if (!this.#hasInput("value") && value !== null) this.valueValue = value;
  }

  /** Whether the author supplied the namespaced Value instead of using its default. */
  #hasInput(name: "orientation" | "min" | "max" | "value"): boolean {
    return this.element.hasAttribute(`data-${this.identifier}-${name}-value`);
  }

  /** Strict finite-number parser for the one-time progressive-enhancement bridge. */
  #finiteAttribute(name: string): number | null {
    const raw = this.element.getAttribute(name);
    if (raw === null || raw.trim() === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  /** Returns attributes without overwriting values a consumer changed after render. */
  #returnAttributes(): void {
    this.#role.return(this.element);
    this.#tabindex.return(this.element);
    this.#orientation.return(this.element);
    this.#minimum.return(this.element);
    this.#maximum.return(this.element);
    this.#current.return(this.element);
  }

  /** Prevents a queued Value repaint from racing Turbo's restored snapshot. */
  #rewindForCache(): void {
    this.#repaint.cancel();
    this.#returnAttributes();
  }
}
