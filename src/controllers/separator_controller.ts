import { Controller } from "@hotwired/stimulus";

/**
 * Headless **Separator** behavior (APG Separator pattern).
 *
 * Markup contract (identifier: `stimeo--separator`):
 *   <!-- decorative -->
 *   <div data-controller="stimeo--separator" role="separator"
 *        data-stimeo--separator-orientation-value="horizontal"></div>
 *
 *   <!-- focusable, value-bearing -->
 *   <div data-controller="stimeo--separator" role="separator" tabindex="0"
 *        aria-label="Resize sidebar" aria-orientation="vertical"
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
 * Behavior only — line drawing is the consumer's CSS. Increment direction
 * follows the slider convention: ArrowUp/ArrowRight increase, ArrowDown/ArrowLeft
 * decrease, scoped to the relevant axis for the orientation.
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
