import { Controller } from "@hotwired/stimulus";
import { RovingTabindex } from "../utils/roving_tabindex";

/**
 * Headless, accessible rating (star) behavior.
 *
 * Markup contract (identifier: `stimeo--rating`):
 *   <div data-controller="stimeo--rating" role="radiogroup" aria-label="Rating"
 *        data-stimeo--rating-value-value="3" data-stimeo--rating-max-value="5">
 *     <span role="radio" aria-checked="false" aria-label="1 star" tabindex="-1"
 *           data-rating-value="1" data-stimeo--rating-target="symbol"
 *           data-action="click->stimeo--rating#select
 *                        mouseenter->stimeo--rating#preview
 *                        mouseleave->stimeo--rating#endPreview
 *                        focus->stimeo--rating#preview
 *                        blur->stimeo--rating#endPreview
 *                        keydown->stimeo--rating#onKeydown">★</span>
 *     <!-- symbols 2..max; the selected one (or the first when unrated) tabindex=0 -->
 *     <input type="hidden" data-stimeo--rating-target="field" />
 *   </div>
 *
 * Implements the WAI-ARIA APG **Radio Group** pattern (an ordinal scale): exactly
 * one symbol is `aria-checked`. Unlike a generic radio group it deliberately does
 * **not** wrap — being ordinal, arrows clamp at the bounds.
 *
 * @remarks
 * Behavior only — symbols are styled by the consumer off `[aria-checked]` and the
 * `data-rating-hover` fill hook. In `readonly` mode the group becomes
 * `role="img"`: because Stimeo never emits human-readable prose, the accessible
 * name (e.g. "Rated 3 of 5") is the consumer's `aria-label`/`aria-labelledby`.
 *
 * Behavior provided:
 * - Click selects a symbol; clicking the selected symbol clears to 0 when
 *   `clearable`.
 * - `ArrowRight`/`ArrowUp` raise and `ArrowLeft`/`ArrowDown` lower the value
 *   (clamped, down to 0 when `clearable`); `Home`/`End` jump to min/max;
 *   `Space`/`Enter` select the focused symbol.
 * - Hover/focus previews a fill range via `data-rating-hover`; leaving restores
 *   the selected range. `stimeo--rating:change` is dispatched on every change.
 */
export class RatingController extends Controller<HTMLElement> {
  static override targets = ["symbol", "field"];
  static override values = {
    value: { type: Number, default: 0 },
    max: { type: Number, default: 5 },
    clearable: { type: Boolean, default: true },
    readonly: { type: Boolean, default: false },
  };
  static actions = ["endPreview", "onKeydown", "preview", "select"] as const;
  static events = ["change"] as const;

  declare readonly symbolTargets: HTMLElement[];
  declare readonly fieldTarget: HTMLInputElement;
  declare readonly hasFieldTarget: boolean;
  declare valueValue: number;
  declare maxValue: number;
  declare clearableValue: boolean;
  declare readonlyValue: boolean;

  readonly #roving = new RovingTabindex(() => this.symbolTargets);

  /** Reflects the initial value, or switches to the non-interactive readonly view. */
  override connect(): void {
    if (this.readonlyValue) {
      this.#applyReadonly();
      return;
    }
    this.#apply(this.#clamp(this.valueValue), { focus: false });
  }

  /** Selects (or clears) the clicked symbol. Bound via `data-action` (click). */
  select(event: Event): void {
    if (this.readonlyValue) return;
    // Clamp the clicked value so a malformed data-rating-value can never push the
    // roving Tab stop out of range.
    const value = this.#clamp(this.#symbolValue(event.currentTarget as HTMLElement));
    if (this.clearableValue && value === this.valueValue) {
      // Clicking the selected symbol clears the rating; focus returns to the first.
      this.#render(0, { focus: true });
    } else {
      this.#render(value, { focus: false });
    }
  }

  /** Previews a fill range on hover/focus. Bound via `data-action` (mouseenter/focus). */
  preview(event: Event): void {
    if (this.readonlyValue) return;
    this.#setFillRange(this.#clamp(this.#symbolValue(event.currentTarget as HTMLElement)));
  }

  /** Restores the fill range to the selected value. Bound via `data-action` (mouseleave/blur). */
  endPreview(): void {
    if (this.readonlyValue) return;
    this.#setFillRange(this.valueValue);
  }

  /** Arrow/Home/End/Space keyboard control, clamped (no wrap). */
  onKeydown(event: KeyboardEvent): void {
    if (this.readonlyValue) return;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = this.valueValue + 1;
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = this.valueValue - 1;
        break;
      case "Home":
        next = this.#minValue;
        break;
      case "End":
        next = this.maxValue;
        break;
      case " ":
      case "Enter":
        next = this.#symbolValue(event.currentTarget as HTMLElement);
        break;
      default:
        return;
    }
    event.preventDefault();
    this.#render(this.#clamp(next), { focus: true });
  }

  /**
   * Applies `value` (already clamped) everywhere, then dispatches `change`.
   * Use for user-driven changes; on connect call `#apply` directly so
   * initialization mirrors state without emitting an event.
   */
  #render(value: number, { focus }: { focus: boolean }): void {
    this.#apply(value, { focus });
    this.dispatch("change", { detail: { value } });
  }

  /**
   * Stores `value`, syncs `aria-checked` and the roving Tab stop, the hidden
   * field, and the fill range — without dispatching `change`. Idempotent and
   * safe on connect (and across Turbo morphing).
   */
  #apply(value: number, { focus }: { focus: boolean }): void {
    this.valueValue = value;
    this.symbolTargets.forEach((symbol) => {
      symbol.setAttribute(
        "aria-checked",
        value > 0 && this.#symbolValue(symbol) === value ? "true" : "false",
      );
    });
    // The selected symbol is the Tab stop; when unrated, the first symbol is.
    this.#roving.setActive(value > 0 ? value - 1 : 0, { focus });
    if (this.hasFieldTarget) this.fieldTarget.value = String(value);
    this.#setFillRange(value);
  }

  /** Marks symbols up to `range` with `data-rating-hover` (the consumer's fill hook). */
  #setFillRange(range: number): void {
    for (const symbol of this.symbolTargets) {
      if (this.#symbolValue(symbol) <= range && range > 0) {
        symbol.setAttribute("data-rating-hover", "");
      } else {
        symbol.removeAttribute("data-rating-hover");
      }
    }
  }

  /** Turns the group into a non-interactive `role="img"` snapshot of the value. */
  #applyReadonly(): void {
    const value = this.#clamp(this.valueValue);
    this.valueValue = value;
    this.element.setAttribute("role", "img");
    for (const symbol of this.symbolTargets) {
      // Drop the interactive radio role so the img has no nested interactive
      // descendants; aria-hidden removes them from the tree entirely.
      symbol.removeAttribute("role");
      symbol.setAttribute("aria-hidden", "true");
      symbol.tabIndex = -1;
    }
    if (this.hasFieldTarget) this.fieldTarget.value = String(value);
    this.#setFillRange(value);
  }

  /**
   * Clamps `value` to `[min, max]` (min is 0 when clearable, else 1). The upper
   * bound is also capped at the number of symbols so the roving Tab stop
   * (`value - 1`) always maps to a real symbol — even if the consumer's `max`
   * value and rendered symbol count disagree, the tabbable item is never lost.
   */
  #clamp(value: number): number {
    const max = Math.min(this.maxValue, this.symbolTargets.length);
    return Math.min(max, Math.max(this.#minValue, value));
  }

  /** Lowest selectable value: 0 when clearable, otherwise 1. */
  get #minValue(): number {
    return this.clearableValue ? 0 : 1;
  }

  /** A symbol's ordinal value (`data-rating-value`, defaulting to its position). */
  #symbolValue(symbol: HTMLElement): number {
    const raw = Number(symbol.getAttribute("data-rating-value"));
    return Number.isFinite(raw) && raw > 0 ? raw : this.symbolTargets.indexOf(symbol) + 1;
  }
}
