import { Controller } from "@hotwired/stimulus";
import { LayoutObserver } from "../utils/layout_observer";

/** CSS custom property exposing the current column count to consumer CSS. */
const COLUMNS_PROPERTY = "--stimeo-masonry-columns";

/**
 * Headless **Masonry** layout helper: assigns each item to the shortest column so
 * variable-height cards pack without vertical gaps. There is no APG widget — this
 * is a layout-only utility that emits state hooks, never visual structure.
 *
 * Markup contract (identifier: `stimeo--masonry`):
 *   <div data-controller="stimeo--masonry"
 *        data-stimeo--masonry-min-column-width-value="240"
 *        data-stimeo--masonry-gap-value="16">
 *     <div data-stimeo--masonry-target="item">…</div>
 *     <div data-stimeo--masonry-target="item">…</div>
 *   </div>
 *
 * The column count is derived responsively from the container width and
 * `minColumnWidth`; each item is then placed into whichever column is currently
 * shortest (measured from item heights). The count is published on the controller
 * element as the `--stimeo-masonry-columns` custom property and each item gets a
 * `data-column` index, so the consumer's CSS owns the actual placement.
 *
 * @remarks
 * Behavior only. **DOM order is never changed** — reading order and focus order
 * stay the source markup order (WCAG 1.3.2). The visual packing is purely the
 * column assignment a consumer reads from `data-column`; this controller writes no
 * positioning styles. Re-layout runs on connect, on resize ({@link LayoutObserver}),
 * and on item add/remove ({@link MutationObserver}); both observers are released on
 * `disconnect()` (Turbo navigation included). Use only for independent cards whose
 * visual order carries no meaning.
 */
export class MasonryController extends Controller<HTMLElement> {
  static override targets = ["item"];
  static override values = {
    minColumnWidth: { type: Number, default: 240 },
    gap: { type: Number, default: 16 },
  };
  static events = ["layout"] as const;

  declare readonly itemTargets: HTMLElement[];
  declare minColumnWidthValue: number;
  declare gapValue: number;

  readonly #layout = new LayoutObserver(() => this.#relayout());
  #mutationObserver: MutationObserver | null = null;
  /** Last published column count, so `layout` fires only on real changes. */
  #lastColumns = 0;

  /**
   * Re-pack when a descendant resource finishes loading. Images/iframes report a
   * height of 0 until loaded, which would skew the shortest-column packing if the
   * first pass ran before they settled; `load` does not bubble, so this is bound in
   * the capture phase to catch every descendant.
   */
  readonly #onLoad = (): void => this.#relayout();

  /** Observes size/content changes and performs the first layout pass. */
  override connect(): void {
    this.#layout.observe(this.element);
    this.#layout.observeViewport();

    if (typeof MutationObserver !== "undefined") {
      this.#mutationObserver = new MutationObserver(() => this.#relayout());
      this.#mutationObserver.observe(this.element, { childList: true, subtree: true });
    }
    this.element.addEventListener("load", this.#onLoad, true);
    this.#relayout();
  }

  /** Releases both observers and the load listener so nothing fires after detach. */
  override disconnect(): void {
    this.#layout.disconnect();
    this.#mutationObserver?.disconnect();
    this.#mutationObserver = null;
    this.element.removeEventListener("load", this.#onLoad, true);
    this.#lastColumns = 0;
  }

  /**
   * Recomputes the column count and assigns every item to the shortest column.
   * Runs automatically on connect, on resize, on item add/remove, and when a
   * descendant resource loads (private — there is no public action; the observers
   * and the capture-phase `load` listener drive it). Items are walked in DOM
   * order; each lands in the column with the least accumulated height, which
   * keeps the packing balanced without reordering the DOM.
   */
  #relayout(): void {
    const items = this.itemTargets;
    const columns = this.#columnCount();

    const heights = new Array<number>(columns).fill(0);
    for (const item of items) {
      let shortest = 0;
      for (let col = 1; col < columns; col++) {
        if ((heights[col] ?? 0) < (heights[shortest] ?? 0)) shortest = col;
      }
      item.setAttribute("data-column", String(shortest));
      heights[shortest] =
        (heights[shortest] ?? 0) + item.getBoundingClientRect().height + this.gapValue;
    }

    this.element.style.setProperty(COLUMNS_PROPERTY, String(columns));

    if (columns !== this.#lastColumns) {
      this.#lastColumns = columns;
      this.dispatch("layout", { detail: { columns } });
    }
  }

  /**
   * Derives how many columns fit: `floor((width + gap) / (minColumnWidth + gap))`,
   * never fewer than one. When the width is unmeasurable (detached, or a layout
   * engine that reports `0`), it falls back to a single column so every item still
   * gets a valid `data-column`.
   */
  #columnCount(): number {
    const width = this.element.getBoundingClientRect().width;
    const denominator = this.minColumnWidthValue + this.gapValue;
    if (width <= 0 || denominator <= 0) return 1;
    return Math.max(1, Math.floor((width + this.gapValue) / denominator));
  }
}
