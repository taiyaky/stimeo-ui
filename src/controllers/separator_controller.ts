import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord } from "../utils/arrow_step";

/**
 * Headless **Separator** behavior. The normative source depends on the case:
 * a decorative divider follows the WAI-ARIA `separator` role
 * (https://www.w3.org/TR/wai-aria-1.2/#separator), while the focusable,
 * value-bearing divider follows the APG Window Splitter pattern
 * (https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/).
 *
 * Markup contract (identifier: `stimeo--separator`):
 *   <!-- decorative -->
 *   <div data-controller="stimeo--separator" role="separator"
 *        data-stimeo--separator-orientation-value="horizontal"></div>
 *
 *   <!-- focusable, value-bearing -->
 *   <div data-controller="stimeo--separator" role="separator" tabindex="0"
 *        aria-labelledby="sidebar-heading" aria-controls="sidebar"
 *        aria-orientation="vertical"
 *        aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"
 *        data-stimeo--separator-focusable-value="true"
 *        data-action="keydown->stimeo--separator#onKeydown"></div>
 *
 * Most separators are static (`role="separator"` + `aria-orientation`); this
 * controller adds those semantics and, for the optional **focusable** variant,
 * keeps `aria-valuenow` in sync and emits arrow-key value changes. The actual
 * pane resize/drag is out of scope — that belongs to {@link ResizableController}.
 *
 * @remarks
 * Behavior only — line drawing is the consumer's CSS. The axis follows Window
 * Splitter: a vertical divider takes ArrowLeft/ArrowRight, a horizontal one
 * takes ArrowUp/ArrowDown. Which end counts as an increase is not defined
 * there, so it follows the slider convention (ArrowRight/ArrowUp increase).
 * Home/End are optional in the pattern and are implemented here; F6 is not.
 *
 * Because no position is ever applied here, two Window Splitter requirements
 * fall to the consumer: `aria-controls` naming the **primary** pane — the one
 * whose size the value reports — and `Enter` to toggle collapse/restore, since
 * collapsing applies a position — {@link ResizableController} implements that
 * key for the same divider. Because the increment direction is fixed, the primary pane can only
 * be the left one for a vertical splitter and the bottom one for a horizontal
 * splitter: those are the panes that grow as ArrowRight/ArrowUp raise the value.
 */
export class SeparatorController extends Controller<HTMLElement> {
  static override values = {
    orientation: { type: String, default: "horizontal" },
    focusable: { type: Boolean, default: false },
    step: { type: Number, default: 1 },
  };
  static actions = ["onKeydown"] as const;
  static events = ["change"] as const;

  declare orientationValue: string;
  declare focusableValue: boolean;
  declare stepValue: number;

  override connect(): void {
    if (!this.element.hasAttribute("role")) {
      this.element.setAttribute("role", "separator");
    }
    if (!this.element.hasAttribute("aria-orientation")) {
      this.element.setAttribute("aria-orientation", this.orientationValue);
    }

    if (this.focusableValue) {
      if (!this.element.hasAttribute("tabindex")) {
        this.element.setAttribute("tabindex", "0");
      }
      // A value-bearing separator needs a bounded range; default it if the
      // consumer left any bound off so arrow keys have something to clamp to.
      this.#setDefault("aria-valuemin", "0");
      this.#setDefault("aria-valuemax", "100");
      this.#setDefault("aria-valuenow", String(this.#clamp(this.#value)));
    }
  }

  /** Adjusts the value on arrow / Home / End keys (focusable variant only). */
  onKeydown(event: KeyboardEvent): void {
    if (isReservedArrowChord(event)) return;
    if (!this.focusableValue) return;

    // `aria-orientation` is the source of truth (connect seeds it from the
    // orientation value when the consumer left it off), so the focusable variant
    // that sets the attribute directly drives the axis correctly.
    const horizontal = this.element.getAttribute("aria-orientation") !== "vertical";
    let next: number | null = null;
    switch (event.key) {
      case "ArrowUp":
        if (horizontal) next = this.#value + this.stepValue;
        break;
      case "ArrowDown":
        if (horizontal) next = this.#value - this.stepValue;
        break;
      case "ArrowRight":
        if (!horizontal) next = this.#value + this.stepValue;
        break;
      case "ArrowLeft":
        if (!horizontal) next = this.#value - this.stepValue;
        break;
      case "Home":
        next = this.#min;
        break;
      case "End":
        next = this.#max;
        break;
      default:
        return;
    }
    if (next === null) return;

    event.preventDefault();
    const clamped = this.#clamp(next);
    if (clamped === this.#value) return;

    this.element.setAttribute("aria-valuenow", String(clamped));
    this.dispatch("change", { detail: { value: clamped } });
  }

  get #value(): number {
    return this.#numericAttr("aria-valuenow", 0);
  }

  get #min(): number {
    return this.#numericAttr("aria-valuemin", 0);
  }

  get #max(): number {
    return this.#numericAttr("aria-valuemax", 100);
  }

  #clamp(value: number): number {
    return Math.min(this.#max, Math.max(this.#min, value));
  }

  #numericAttr(name: string, fallback: number): number {
    const parsed = Number.parseFloat(this.element.getAttribute(name) ?? "");
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  #setDefault(name: string, value: string): void {
    if (!this.element.hasAttribute(name)) {
      this.element.setAttribute(name, value);
    }
  }
}
