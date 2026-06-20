import { Controller } from "@hotwired/stimulus";

/**
 * Headless **Aspect Ratio** helper. No APG pattern — a pure layout utility with
 * no role or state.
 *
 * Markup contract (identifier: `stimeo--aspect-ratio`):
 *   <div data-controller="stimeo--aspect-ratio"
 *        data-stimeo--aspect-ratio-ratio-value="16/9">
 *     <img src="/cover.jpg" alt="Cover"
 *          data-stimeo--aspect-ratio-target="content" />
 *   </div>
 *
 * Supplies the requested ratio as the `--stimeo-aspect-ratio` custom property on
 * the host so consumer CSS can drive the box (`aspect-ratio: var(--stimeo-aspect-ratio)`)
 * or a padding-hack fallback. The drawing itself — `aspect-ratio`, `object-fit`,
 * cropping — stays in the consumer's stylesheet.
 *
 * @remarks
 * Behavior only. The value accepts the CSS `<ratio>` forms `"16/9"` and a bare
 * number string (`"1.5"`); it is normalized to `"w / h"` (or the number) and an
 * unparseable value falls back to the default `1 / 1` rather than writing garbage
 * into the custom property. The reflection re-runs when the value changes.
 */
export class AspectRatioController extends Controller<HTMLElement> {
  static override targets = ["content"];
  static override values = {
    ratio: { type: String, default: "1/1" },
  };

  declare ratioValue: string;

  /** Applies the ratio on connect and whenever the value changes. */
  ratioValueChanged(): void {
    this.element.style.setProperty("--stimeo-aspect-ratio", this.#normalizeRatio(this.ratioValue));
  }

  /**
   * Normalizes a ratio string to a valid CSS `<ratio>`:
   * - `"16/9"` / `"16 / 9"` → `"16 / 9"` (both parts must be positive numbers)
   * - `"1.5"` → `"1.5"` (a bare positive number)
   * - anything else → `"1 / 1"` (the default), so the custom property is always valid.
   */
  #normalizeRatio(raw: string): string {
    const value = raw.trim();
    if (value.includes("/")) {
      const [w, h] = value.split("/").map((part) => Number.parseFloat(part.trim()));
      if (this.#isPositive(w) && this.#isPositive(h)) return `${w} / ${h}`;
      return "1 / 1";
    }
    const single = Number.parseFloat(value);
    return this.#isPositive(single) ? String(single) : "1 / 1";
  }

  #isPositive(value: number | undefined): value is number {
    return value !== undefined && Number.isFinite(value) && value > 0;
  }
}
