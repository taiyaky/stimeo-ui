/**
 * Low-level roving-tabindex primitive shared by composite-widget controllers.
 *
 * The APG roving-tabindex pattern keeps a composite widget a single Tab stop:
 * exactly one item is in the Tab sequence (`tabindex="0"`) while the rest are
 * removed from it (`tabindex="-1"`), and the arrow keys move both DOM focus and
 * that single tabbable position together. {@link RovingTabindex} owns *only* that
 * mechanical bookkeeping — "which one item is tabbable, and move focus there".
 *
 * It is intentionally **policy-free**. Orientation, wrapping vs. clamping,
 * selection-follows-focus, typeahead, and `Home`/`End` semantics differ per APG
 * pattern (Radio Group, Toolbar, Rating, …); folding them into one helper would
 * flatten those widgets to a lowest common denominator and lose each pattern's
 * correctness. Those decisions therefore stay in each controller, which calls
 * {@link RovingTabindex.setActive} with an index it computed itself (optionally
 * via the pure {@link rovingMove} helper).
 *
 * @remarks
 * Items are read lazily through a getter so a controller can add or remove
 * targets (Stimulus re-scans the DOM) without re-wiring this helper.
 */
export class RovingTabindex {
  /** Returns the current ordered item elements; called on every operation. */
  readonly #getItems: () => HTMLElement[];

  /**
   * @param getItems - Returns the current ordered item elements. Called on every
   *   operation so the live target list is always used.
   */
  constructor(getItems: () => HTMLElement[]) {
    this.#getItems = getItems;
  }

  /** Index of the currently tabbable item (`tabindex="0"`), or `-1` if none. */
  get activeIndex(): number {
    return this.#getItems().findIndex((item) => item.tabIndex === 0);
  }

  /**
   * Makes exactly the item at `index` tabbable (`tabindex="0"`) and removes every
   * other item from the Tab sequence (`tabindex="-1"`). An out-of-range `index`
   * (e.g. `-1`) leaves all items at `-1`, which a controller can use to express
   * "nothing is currently tabbable".
   *
   * @param index - Position of the item to make tabbable.
   * @param options - Pass `{ focus: true }` to also move DOM focus to that item.
   */
  setActive(index: number, { focus = false }: { focus?: boolean } = {}): void {
    const items = this.#getItems();
    items.forEach((item, i) => {
      item.tabIndex = i === index ? 0 : -1;
    });
    if (focus) items[index]?.focus();
  }
}

/** Edge behavior for {@link rovingMove}: cycle past the ends, or stop at them. */
export type RovingWrap = "wrap" | "clamp";

/**
 * Pure helper that resolves the target index for a one-step directional move.
 *
 * Keyboard/orientation mapping stays in the caller: it decides that a key means
 * `delta` `+1` (next) or `-1` (previous) and whether the widget should `"wrap"`
 * (Radio Group, Toolbar) or `"clamp"` at the ends.
 *
 * @param current - The index focus is moving from.
 * @param length - Number of items in the set.
 * @param delta - `+1` to move to the next item, `-1` for the previous.
 * @param wrap - `"wrap"` cycles around the ends; `"clamp"` stops at them.
 * @returns The resolved index, or `-1` when there are no items.
 */
export function rovingMove(
  current: number,
  length: number,
  delta: number,
  wrap: RovingWrap,
): number {
  if (length === 0) return -1;
  const next = current + delta;
  if (wrap === "wrap") return (next + length) % length;
  return Math.min(length - 1, Math.max(0, next));
}
