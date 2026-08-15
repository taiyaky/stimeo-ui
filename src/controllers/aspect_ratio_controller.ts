import { Controller } from "@hotwired/stimulus";

const DEFAULT_RATIO = "1 / 1";
const RATIO_PROPERTY = "--stimeo--aspect-ratio";
const CSS_NUMBER_PATTERN = /^[+-]?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Headless **Aspect Ratio** helper. No APG pattern — a pure layout utility with
 * no role or state.
 *
 * Markup contract (identifier: `stimeo--aspect-ratio`):
 *   <div data-controller="stimeo--aspect-ratio"
 *        data-stimeo--aspect-ratio-ratio-value="16/9">
 *     <img src="/cover.jpg" alt="Cover" />
 *   </div>
 *
 * Supplies the requested ratio as the `--stimeo--aspect-ratio` custom property on
 * the host so consumer CSS can drive the box (`aspect-ratio: var(--stimeo--aspect-ratio)`)
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
  static override values = {
    ratio: { type: String, default: "1/1" },
  };

  declare ratioValue: string;

  /** Applies the ratio on connect and whenever the value changes. */
  ratioValueChanged(): void {
    this.element.style.setProperty(RATIO_PROPERTY, this.#normalizeRatio(this.ratioValue));
  }

  /**
   * Normalizes a ratio string to a valid CSS `<ratio>`:
   * - `"16/9"` / `"16 / 9"` → `"16 / 9"` (both parts must be positive CSS numbers)
   * - `"1.5"` → `"1.5"` (a bare positive CSS number)
   * - anything else → `"1 / 1"` (the default), so the custom property is always valid.
   */
  #normalizeRatio(raw: string): string {
    const value = raw.trim();
    if (value.includes("/")) {
      const parts = value.split("/");
      if (parts.length !== 2) return DEFAULT_RATIO;

      const width = this.#parsePositiveNumber(parts[0] ?? "");
      const height = this.#parsePositiveNumber(parts[1] ?? "");
      return width !== undefined && height !== undefined ? `${width} / ${height}` : DEFAULT_RATIO;
    }

    const single = this.#parsePositiveNumber(value);
    return single === undefined ? DEFAULT_RATIO : String(single);
  }

  /** Parses one complete CSS `<number>` token and rejects units or trailing syntax. */
  #parsePositiveNumber(raw: string): number | undefined {
    const token = raw.trim();
    if (!CSS_NUMBER_PATTERN.test(token)) return undefined;

    const value = Number(token);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
}
