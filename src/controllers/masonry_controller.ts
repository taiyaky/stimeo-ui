import { Controller } from "@hotwired/stimulus";
import { LayoutObserver } from "../utils/layout_observer";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";

/** CSS custom property exposing the current column count to consumer CSS. */
const COLUMNS_PROPERTY = "--stimeo--masonry-columns";

/** Column width assumed when the declaration is absent or unreadable. */
const DEFAULT_MIN_COLUMN_WIDTH = 240;
/** Item spacing assumed when the declaration is absent or unreadable. */
const DEFAULT_GAP = 16;

/**
 * Returns `value` when it is a number the column arithmetic can use, else
 * `fallback`.
 *
 * A unit suffix is the ordinary authoring slip here (`"240px"`), and Stimulus'
 * Number reader answers `NaN` rather than raising — which would reach the column
 * count and make the column bookkeeping impossible to allocate, leaving the grid
 * with no hooks at all. An infinity is rejected for the same reason: it divides
 * into itself as `NaN`.
 */
function usableNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

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
 * element as the `--stimeo--masonry-columns` custom property and each item gets a
 * `data-column` index, so the consumer's CSS owns the actual placement.
 *
 * `layout` dispatches `{ columns: number }` whenever the published result moves —
 * the column count changed, or some item landed in a different column. A pass that
 * reproduces the previous result stays silent.
 *
 * @remarks
 * Behavior only. **DOM order is never changed** — reading order and focus order
 * stay the source markup order (WCAG 1.3.2). The visual packing is purely the
 * column assignment a consumer reads from `data-column`; this controller writes no
 * positioning styles. Use only for independent cards whose visual order carries no
 * meaning.
 *
 * Re-layout runs on connect, on resize ({@link LayoutObserver}), on item
 * add/remove ({@link MutationObserver}), on an item joining or leaving the target
 * set, when a declared number changes, and when a descendant resource loads.
 * Everything but the first pass is folded into one microtask, so a burst of
 * triggers costs one pass. The observers, the `load` listener and any pending pass
 * are released on `disconnect()` (Turbo navigation included).
 *
 * Consumer contract:
 * - A declaration that cannot be read as a number (`"240px"`, an infinity) falls
 *   back to that Value's default and the grid keeps working; `0` and negatives are
 *   readable numbers and collapse to a single column instead.
 * - `data-column` belongs to this controller: it is written on every item it owns
 *   and taken back from an element that stops being one.
 */
export class MasonryController extends Controller<HTMLElement> {
  static override targets = ["item"];
  static override values = {
    minColumnWidth: { type: Number, default: DEFAULT_MIN_COLUMN_WIDTH },
    gap: { type: Number, default: DEFAULT_GAP },
  };
  static events = ["layout"] as const;

  declare readonly itemTargets: HTMLElement[];
  declare minColumnWidthValue: number;
  declare gapValue: number;

  /**
   * The declared numbers after validation, so the layout path never sees a value
   * it cannot compute with. Both are resolved once per declaration change rather
   * than on every pass.
   */
  #minColumnWidth = DEFAULT_MIN_COLUMN_WIDTH;
  #gap = DEFAULT_GAP;

  /**
   * Collapses every re-layout trigger of one DOM mutation into a single pass, and
   * refuses to run before `connect()` or after `disconnect()`.
   *
   * The triggers arrive in bursts — a resize stream, a morph that syncs several
   * attributes, a batch of rows — and each pass measures every item, so folding
   * them keeps the work proportional to the batch rather than to the events in it.
   */
  readonly #reconcile = new MicrotaskCoalescer(() => this.#relayout());

  /** Items that left the target set and still carry the column hook. */
  readonly #released = new Set<HTMLElement>();

  readonly #layout = new LayoutObserver(() => this.#reconcile.schedule());
  #mutationObserver: MutationObserver | null = null;
  /** Last published column count, so `layout` fires only on real changes. */
  #lastColumns = 0;

  /**
   * Re-pack when a descendant resource finishes loading. Images/iframes report a
   * height of 0 until loaded, which would skew the shortest-column packing if the
   * first pass ran before they settled; `load` does not bubble, so this is bound in
   * the capture phase to catch every descendant.
   */
  readonly #onLoad = (): void => this.#reconcile.schedule();

  /** Resolves the declared column width once, falling back when it is unreadable. */
  minColumnWidthValueChanged(): void {
    this.#minColumnWidth = usableNumber(this.minColumnWidthValue, DEFAULT_MIN_COLUMN_WIDTH);
    this.#reconcile.schedule();
  }

  /** Resolves the declared gap once, falling back when it is unreadable. */
  gapValueChanged(): void {
    this.#gap = usableNumber(this.gapValue, DEFAULT_GAP);
    this.#reconcile.schedule();
  }

  /** Packs an element that became an item without moving in the DOM. */
  itemTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /**
   * Queues the column hook of an element that stopped being an item for removal.
   *
   * The removal is queued rather than immediate because teardown reports every
   * target as disconnected: doing it here would strip the whole grid just before
   * a Turbo snapshot is taken. {@link MicrotaskCoalescer.cancel} drops the queue
   * with the pass, so only a genuine target change reaches it.
   */
  itemTargetDisconnected(item: HTMLElement): void {
    this.#released.add(item);
    this.#reconcile.schedule();
  }

  /** Observes size/content changes and performs the first layout pass. */
  override connect(): void {
    this.#layout.observe(this.element);
    this.#layout.observeViewport();

    if (typeof MutationObserver !== "undefined") {
      this.#mutationObserver = new MutationObserver(() => this.#reconcile.schedule());
      this.#mutationObserver.observe(this.element, { childList: true, subtree: true });
    }
    this.element.addEventListener("load", this.#onLoad, true);
    this.#relayout();
    this.#reconcile.activate();
  }

  /** Releases both observers and the load listener so nothing fires after detach. */
  override disconnect(): void {
    this.#reconcile.cancel();
    this.#released.clear();
    this.#layout.disconnect();
    this.#mutationObserver?.disconnect();
    this.#mutationObserver = null;
    this.element.removeEventListener("load", this.#onLoad, true);
    this.#lastColumns = 0;
  }

  /**
   * Recomputes the column count and assigns every item to the shortest column.
   * Runs automatically on connect, on resize, on item add/remove, when a declared
   * number changes, and when a descendant resource loads (private — there is no
   * public action; the observers, the target callbacks and the capture-phase
   * `load` listener drive it). Items are walked in DOM order; each lands in the
   * column with the least accumulated height, which keeps the packing balanced
   * without reordering the DOM.
   *
   * Every box is measured before anything is written. Interleaving the two would
   * make a consumer's `data-column` rule invalidate style once per item, and the
   * next measurement then has to settle layout again — once per item instead of
   * once per pass. The assignment is independent of the measurement because the
   * columns are uniform in width, so the order of the two passes does not change
   * the result.
   *
   * @stimeoRenderRoot
   */
  #relayout(): void {
    const items = this.itemTargets;
    const columns = this.#columnCount();
    const boxes = items.map((item) => item.getBoundingClientRect().height);

    let changed = false;
    if (this.#released.size > 0) {
      // An element that left and rejoined the target set within one batch is
      // queued here while still being an item, so ownership is decided against
      // the set this pass sees rather than against the queue alone.
      const owned = new Set(items);
      for (const released of this.#released) {
        if (owned.has(released)) continue;
        if (released.hasAttribute("data-column")) {
          released.removeAttribute("data-column");
          changed = true;
        }
      }
      this.#released.clear();
    }

    const heights = new Array<number>(columns).fill(0);
    items.forEach((item, index) => {
      let shortest = 0;
      for (let col = 1; col < columns; col++) {
        if ((heights[col] ?? 0) < (heights[shortest] ?? 0)) shortest = col;
      }
      const assigned = String(shortest);
      // Writing a value the item already carries would publish a change that did
      // not happen, and the same comparison is what tells the event whether the
      // published layout actually moved.
      if (item.getAttribute("data-column") !== assigned) {
        item.setAttribute("data-column", assigned);
        changed = true;
      }
      heights[shortest] = (heights[shortest] ?? 0) + (boxes[index] ?? 0) + this.#gap;
    });

    this.element.style.setProperty(COLUMNS_PROPERTY, String(columns));

    if (columns !== this.#lastColumns || changed) {
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
    const denominator = this.#minColumnWidth + this.#gap;
    if (width <= 0 || denominator <= 0) return 1;
    return Math.max(1, Math.floor((width + this.#gap) / denominator));
  }
}
