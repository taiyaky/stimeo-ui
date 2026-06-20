import { Controller } from "@hotwired/stimulus";
import { RovingTabindex } from "../utils/roving_tabindex";
import { SafeTimeout } from "../utils/safe_timeout";

/** How long (ms) typed characters accumulate into one typeahead query. */
const TYPEAHEAD_TIMEOUT = 500;

/**
 * Headless, accessible single-select tree view.
 *
 * Markup contract (identifier: `stimeo--tree-view`):
 *   <ul data-controller="stimeo--tree-view" role="tree" aria-label="Files">
 *     <li role="treeitem" aria-expanded="false" aria-selected="false" tabindex="0"
 *         data-stimeo--tree-view-target="item"
 *         data-action="keydown->stimeo--tree-view#onKeydown
 *                      click->stimeo--tree-view#onClick">
 *       <span>src</span>
 *       <ul role="group" data-stimeo--tree-view-target="group" hidden>
 *         <li role="treeitem" aria-selected="false" tabindex="-1"
 *             data-stimeo--tree-view-target="item" data-action="…">…</li>
 *       </ul>
 *     </li>
 *   </ul>
 *
 * Implements the WAI-ARIA APG **Tree View** (single-select) pattern. Parent/child
 * structure is read from the DOM nesting (`treeitem` → child `group`). The whole
 * tree is one Tab stop (roving tabindex); arrows navigate visible items, expand /
 * collapse, and move between parent and child.
 *
 * Behavior provided:
 * - `ArrowDown`/`ArrowUp` move between visible items; `Home`/`End` jump to the
 *   first / last visible item; printable characters typeahead by label prefix.
 * - `ArrowRight` expands a collapsed parent or steps into its first child;
 *   `ArrowLeft` collapses an expanded parent or steps to the parent item.
 * - `Enter`/`Space`/click select the item (single selection via `aria-selected`).
 * - `aria-expanded` and each child `group`'s `hidden` stay in sync, dispatching
 *   `stimeo--tree-view:toggle`; selection dispatches `stimeo--tree-view:select`.
 */
export class TreeViewController extends Controller<HTMLElement> {
  static override targets = ["item", "group"];
  static actions = ["onClick", "onKeydown"] as const;
  static events = ["select", "toggle"] as const;

  declare readonly itemTargets: HTMLElement[];

  readonly #roving = new RovingTabindex(() => this.itemTargets);
  #typeahead = "";
  #typeaheadTimer = 0;
  readonly #timers = new SafeTimeout();

  /** Establishes the single tab stop (keeps an existing one, else the first). */
  override connect(): void {
    const active = this.#roving.activeIndex;
    this.#roving.setActive(active === -1 ? 0 : active);
  }

  /** Clears the pending typeahead-reset timer. */
  override disconnect(): void {
    this.#timers.clearAll();
  }

  /**
   * Routes tree keyboard interaction. Because `treeitem`s nest, only the handler
   * on the nearest item to the event target acts; the same keydown bubbling to an
   * ancestor item's handler is ignored to avoid double moves / selections.
   */
  onKeydown(event: KeyboardEvent): void {
    const item = event.currentTarget as HTMLElement;
    if ((event.target as HTMLElement).closest('[role="treeitem"]') !== item) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.#moveBy(item, 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        this.#moveBy(item, -1);
        break;
      case "ArrowRight":
        event.preventDefault();
        this.#expandOrEnter(item);
        break;
      case "ArrowLeft":
        event.preventDefault();
        this.#collapseOrLeave(item);
        break;
      case "Home":
        event.preventDefault();
        this.#focusEdge(0);
        break;
      case "End":
        event.preventDefault();
        this.#focusEdge(-1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        this.#select(item);
        break;
      default:
        if (this.#isPrintable(event)) {
          event.preventDefault();
          this.#typeaheadTo(item, event.key);
        }
        break;
    }
  }

  /** Selects the clicked item (nearest to the target only). */
  onClick(event: Event): void {
    const item = event.currentTarget as HTMLElement;
    if ((event.target as HTMLElement).closest('[role="treeitem"]') !== item) return;
    this.#focusItem(item);
    this.#select(item);
  }

  /** Moves focus to the next (`delta=1`) or previous visible item, if any. */
  #moveBy(item: HTMLElement, delta: number): void {
    const visible = this.#visibleItems;
    const current = visible.indexOf(item);
    const next = visible[current + delta];
    if (next) this.#focusItem(next);
  }

  /** `ArrowRight`: expand a collapsed parent, else step into the first child. */
  #expandOrEnter(item: HTMLElement): void {
    const group = this.#childGroup(item);
    if (!group) return;
    if (this.#isExpanded(item)) {
      const firstChild = group.querySelector<HTMLElement>(':scope > [role="treeitem"]');
      if (firstChild) this.#focusItem(firstChild);
    } else {
      this.#setExpanded(item, true);
    }
  }

  /** `ArrowLeft`: collapse an expanded parent, else step out to the parent item. */
  #collapseOrLeave(item: HTMLElement): void {
    if (this.#childGroup(item) && this.#isExpanded(item)) {
      this.#setExpanded(item, false);
      return;
    }
    const parent = this.#parentItem(item);
    if (parent) this.#focusItem(parent);
  }

  /** Focuses the first (`0`) or last (`-1`) visible item. */
  #focusEdge(index: number): void {
    const visible = this.#visibleItems;
    const target = index < 0 ? visible[visible.length - 1] : visible[index];
    if (target) this.#focusItem(target);
  }

  /** Applies single selection and dispatches `select`. */
  #select(item: HTMLElement): void {
    for (const candidate of this.itemTargets) {
      candidate.setAttribute("aria-selected", candidate === item ? "true" : "false");
    }
    this.dispatch("select", { detail: { item } });
  }

  /** Toggles `aria-expanded` + the child group's `hidden`, dispatching `toggle`. */
  #setExpanded(item: HTMLElement, expanded: boolean): void {
    const group = this.#childGroup(item);
    if (!group) return;
    item.setAttribute("aria-expanded", String(expanded));
    group.hidden = !expanded;
    this.dispatch("toggle", { detail: { item, expanded } });
  }

  /** Makes `item` the single tab stop and moves DOM focus to it. */
  #focusItem(item: HTMLElement): void {
    const index = this.itemTargets.indexOf(item);
    if (index !== -1) this.#roving.setActive(index, { focus: true });
  }

  /** Advances the typeahead buffer and focuses the next matching visible item. */
  #typeaheadTo(item: HTMLElement, char: string): void {
    this.#timers.clear(this.#typeaheadTimer);
    this.#typeahead += char.toLowerCase();
    this.#typeaheadTimer = this.#timers.set(() => {
      this.#typeahead = "";
    }, TYPEAHEAD_TIMEOUT);

    // Search from just after the current item, wrapping, so repeats cycle matches.
    const visible = this.#visibleItems;
    const start = visible.indexOf(item);
    for (let offset = 1; offset <= visible.length; offset += 1) {
      const candidate = visible[(start + offset) % visible.length];
      if (candidate && this.#label(candidate).startsWith(this.#typeahead)) {
        this.#focusItem(candidate);
        return;
      }
    }
  }

  /** The visible items: those with no collapsed (`hidden`) ancestor group. */
  get #visibleItems(): HTMLElement[] {
    return this.itemTargets.filter((item) => {
      let node = item.parentElement;
      while (node && node !== this.element) {
        if (node.matches('[role="group"]') && (node as HTMLElement).hidden) return false;
        node = node.parentElement;
      }
      return true;
    });
  }

  /** The child `group` owned directly by `item`, or `null` for a leaf. */
  #childGroup(item: HTMLElement): HTMLElement | null {
    return item.querySelector<HTMLElement>(':scope > [role="group"]');
  }

  /** The nearest ancestor `treeitem`, or `null` at the root level. */
  #parentItem(item: HTMLElement): HTMLElement | null {
    return item.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? null;
  }

  /** Whether a parent item is currently expanded. */
  #isExpanded(item: HTMLElement): boolean {
    return item.getAttribute("aria-expanded") === "true";
  }

  /** `item`'s own label text (excluding any nested child group), lowercased. */
  #label(item: HTMLElement): string {
    let text = "";
    for (const node of Array.from(item.childNodes)) {
      if (node.nodeType === Node.ELEMENT_NODE && (node as Element).matches('[role="group"]')) {
        continue;
      }
      text += node.textContent ?? "";
    }
    return text.trim().toLowerCase();
  }

  /** Whether `event.key` is a single printable character (no modifier chord). */
  #isPrintable(event: KeyboardEvent): boolean {
    return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
  }
}
