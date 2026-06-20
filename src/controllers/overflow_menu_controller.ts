import { Controller } from "@hotwired/stimulus";
import { LayoutObserver } from "../utils/layout_observer";
import { SafeTimeout } from "../utils/safe_timeout";

/**
 * Headless **overflow / priority menu**: items that no longer fit their container are
 * moved into a "More" dropdown (lowest `data-priority` first) and moved back as space
 * returns, watched with a {@link ResizeObserver} (no dedicated APG pattern — a
 * composition; the menu's a11y is delegated to Menu, so it is not re-implemented).
 *
 * Markup contract (identifier: `stimeo--overflow-menu`):
 *   <div data-controller="stimeo--overflow-menu" role="toolbar">
 *     <div data-stimeo--overflow-menu-target="items">
 *       <a data-priority="1">Save</a><a data-priority="2">Duplicate</a><a>Delete</a>
 *     </div>
 *     <div data-controller="stimeo--menu" data-stimeo--overflow-menu-target="more" hidden>
 *       <button data-stimeo--menu-target="trigger">More</button>
 *       <ul role="menu" data-stimeo--menu-target="menu" hidden></ul>
 *     </div>
 *   </div>
 *
 * On connect (and every debounced resize) it measures the items against the container
 * width and, when they overflow, banks the lowest-priority ones into the More menu —
 * giving each `role="menuitem"` / `tabindex="-1"` and the menu's `item` target so Menu
 * drives it — until the rest fit beside the More button. When nothing overflows the
 * More button is `hidden`. The controller element carries `data-overflowing` /
 * `data-overflow-count`, and a `change` event fires on each transition.
 *
 * @remarks
 * Items are *moved* (not cloned). When a focused item retreats into the (collapsed)
 * menu it would otherwise be hidden and lose focus, so focus is redirected to the More
 * trigger. Priority: lower `data-priority` is kept longer; items without one drop first.
 * Behavior only — no styling. The `ResizeObserver` and debounce timer are released on
 * `disconnect()` (Turbo navigation included); state is derived from the DOM each pass
 * (no module-scope state), so `connect()` re-syncs after a Turbo morph. Captures the
 * managed item set at connect; call the `update` action to re-measure after adding
 * items dynamically.
 */
export class OverflowMenuController extends Controller<HTMLElement> {
  static override targets = ["items", "more"];
  static override values = {
    moreLabel: { type: String, default: "More" },
    debounce: { type: Number, default: 100 },
  };
  static actions = ["update"] as const;
  static events = ["change"] as const;

  declare readonly itemsTarget: HTMLElement;
  declare readonly moreTarget: HTMLElement;
  declare readonly hasItemsTarget: boolean;
  declare readonly hasMoreTarget: boolean;

  declare moreLabelValue: string;
  declare debounceValue: number;

  readonly #layout = new LayoutObserver(() => this.#scheduleUpdate());
  readonly #timers = new SafeTimeout();
  /** The managed items in canonical (authored) order, captured at connect. */
  #items: HTMLElement[] = [];
  #index = new WeakMap<HTMLElement, number>();
  /**
   * Cached bar-context width per item. An item's natural width is location-independent,
   * so this lets a measure pass read only the items currently in the bar (menu items
   * reuse their last value) instead of pulling everything back to measure — one reflow,
   * not two.
   */
  #widths = new WeakMap<HTMLElement, number>();
  /** Last reported overflow count, so `change` fires only on transitions. */
  #lastHidden: number | null = null;

  override connect(): void {
    if (!this.hasItemsTarget || !this.hasMoreTarget) return;

    const trigger = this.#trigger();
    if (trigger && (trigger.textContent ?? "").trim() === "") {
      trigger.textContent = this.moreLabelValue;
    }

    this.#layout.observe(this.element);
    this.#layout.observeViewport();
    this.update();
  }

  override disconnect(): void {
    this.#layout.disconnect();
    this.#timers.clearAll();
    this.#lastHidden = null;
  }

  /** Re-measures and rebalances items between the bar and the More menu. */
  update(): void {
    if (!this.hasItemsTarget || !this.hasMoreTarget) return;
    this.#syncItems();

    // Reveal More so its trigger is measurable, then refresh cached widths for the items
    // currently in the bar (menu items keep their location-independent last value).
    this.moreTarget.hidden = false;
    for (const item of this.#items) {
      if (item.parentElement === this.itemsTarget) this.#widths.set(item, item.offsetWidth);
    }
    const moreWidth = (this.#trigger() ?? this.moreTarget).offsetWidth;
    const gap = this.#gap();

    const widthOf = (el: HTMLElement): number => this.#widths.get(el) ?? el.offsetWidth;
    const containerWidth = this.element.clientWidth;
    const itemsWidth = this.#items.reduce((sum, el) => sum + widthOf(el), 0);
    let visibleWidth = itemsWidth + Math.max(0, this.#items.length - 1) * gap;

    const hidden = new Set<HTMLElement>();
    if (visibleWidth > containerWidth) {
      const budget = containerWidth - moreWidth - gap; // reserve the More button + its gap
      // Drop lowest-retention first: no `data-priority` (rank ∞), then highest number;
      // ties broken right-to-left so leading items survive.
      const dropOrder = [...this.#items].sort(
        (a, b) => this.#rank(b) - this.#rank(a) || this.#indexOf(b) - this.#indexOf(a),
      );
      for (const item of dropOrder) {
        if (visibleWidth <= budget) break;
        hidden.add(item);
        visibleWidth -= widthOf(item) + gap; // dropping an item frees its width and a gap
      }
    }

    // Re-home every item in canonical order so the bar and the menu both stay correctly
    // ordered — a banked middle item returns to its original slot, not the end.
    const menu = this.#menuList();
    // If the focused item is one of the ones retreating, redirect focus to the More
    // trigger: in a collapsed menu the banked item becomes hidden and the browser would
    // otherwise drop focus to <body>. Decided before the move (not by polling
    // activeElement afterwards) so it does not race the browser's blur.
    const active = document.activeElement;
    const refocusTrigger = active instanceof HTMLElement && hidden.has(active);
    for (const item of this.#items) {
      if (hidden.has(item)) this.#toMenu(item, menu);
      else this.#toBar(item);
    }
    if (refocusTrigger) this.#trigger()?.focus();

    const count = hidden.size;
    this.moreTarget.hidden = count === 0;
    if (count > 0) this.element.setAttribute("data-overflowing", "true");
    else this.element.removeAttribute("data-overflowing");
    this.element.setAttribute("data-overflow-count", String(count));

    if (this.#lastHidden !== count) {
      this.#lastHidden = count;
      this.dispatch("change", { detail: { visible: this.#items.length - count, hidden: count } });
    }
  }

  /** The flex `column-gap` between items in px (0 when none / unsupported). */
  #gap(): number {
    if (typeof window.getComputedStyle !== "function") return 0;
    const style = window.getComputedStyle(this.itemsTarget);
    const value = Number.parseFloat(style.columnGap || style.gap || "");
    return Number.isNaN(value) ? 0 : value;
  }

  /**
   * Reconciles the managed item set with the DOM each pass: adopts items appended to the
   * bar since last time (so the documented "add items, then call `update`" flow works)
   * and drops any the consumer removed, then renumbers canonical indices. Banked items
   * live in the menu (still within the controller element) and are retained.
   */
  #syncItems(): void {
    const known = new Set(this.#items);
    for (const el of this.itemsTarget.children) {
      if (el instanceof HTMLElement && !known.has(el)) this.#items.push(el);
    }
    this.#items = this.#items.filter((el) => this.element.contains(el));
    this.#index = new WeakMap();
    this.#items.forEach((el, i) => {
      this.#index.set(el, i);
    });
  }

  /** Debounced re-measure for resize-driven churn. */
  #scheduleUpdate(): void {
    this.#timers.clearAll();
    this.#timers.set(() => this.update(), this.debounceValue);
  }

  /** Returns the menu list the items are banked into (falls back to the More wrapper). */
  #menuList(): HTMLElement {
    return (
      this.moreTarget.querySelector<HTMLElement>('[data-stimeo--menu-target="menu"]') ??
      this.moreTarget
    );
  }

  #trigger(): HTMLElement | null {
    return this.moreTarget.querySelector<HTMLElement>('[data-stimeo--menu-target="trigger"]');
  }

  /** Restores an item to the bar, stripping the menu semantics we may have added. */
  #toBar(item: HTMLElement): void {
    // Always append (in canonical-order calls) so the bar's order is rebuilt correctly.
    this.itemsTarget.appendChild(item);
    if (item.dataset.overflowMenuized === undefined) return;
    item.removeAttribute("data-stimeo--menu-target");
    this.#restoreAttr(item, "role", item.dataset.overflowOrigRole);
    this.#restoreAttr(item, "tabindex", item.dataset.overflowOrigTabindex);
    delete item.dataset.overflowMenuized;
    delete item.dataset.overflowOrigRole;
    delete item.dataset.overflowOrigTabindex;
  }

  /** Banks an item into the menu with menuitem semantics for Menu to manage. */
  #toMenu(item: HTMLElement, menu: HTMLElement): void {
    if (item.dataset.overflowMenuized === undefined) {
      item.dataset.overflowMenuized = "true";
      item.dataset.overflowOrigRole = item.getAttribute("role") ?? "";
      item.dataset.overflowOrigTabindex = item.getAttribute("tabindex") ?? "";
      item.setAttribute("role", "menuitem");
      item.setAttribute("tabindex", "-1");
      item.setAttribute("data-stimeo--menu-target", "item");
    }
    menu.appendChild(item);
  }

  /** Re-applies a saved attribute value, or removes the attribute when it was absent. */
  #restoreAttr(item: HTMLElement, name: string, original: string | undefined): void {
    if (original === undefined || original === "") item.removeAttribute(name);
    else item.setAttribute(name, original);
  }

  #indexOf(item: HTMLElement): number {
    return this.#index.get(item) ?? 0;
  }

  /** Retention rank: lower keeps longer; no `data-priority` ranks lowest (drops first). */
  #rank(item: HTMLElement): number {
    const raw = item.getAttribute("data-priority");
    if (raw === null) return Number.POSITIVE_INFINITY;
    const value = Number(raw);
    return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
  }
}
