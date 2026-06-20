import { Controller } from "@hotwired/stimulus";
import { RovingTabindex } from "../utils/roving_tabindex";
import { SafeTimeout } from "../utils/safe_timeout";

/** Where to land focus when a menu opens. */
type OpenFocus = "first" | "last";

/** Milliseconds of idle after which the typeahead buffer resets. */
const TYPEAHEAD_RESET_MS = 500;

/**
 * Headless, accessible **menubar** behavior.
 *
 * Markup contract (identifier: `stimeo--menubar`):
 *   <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
 *     <button role="menuitem" aria-haspopup="menu" aria-expanded="false"
 *             aria-controls="m-file" data-stimeo--menubar-target="top"
 *             data-action="click->stimeo--menubar#toggle
 *                          keydown->stimeo--menubar#onTopKeydown">File</button>
 *     <ul id="m-file" role="menu" data-stimeo--menubar-target="menu" hidden>
 *       <li role="none">
 *         <button role="menuitem" tabindex="-1" data-stimeo--menubar-target="item"
 *                 data-action="click->stimeo--menubar#activate
 *                              keydown->stimeo--menubar#onItemKeydown">New</button>
 *       </li>
 *     </ul>
 *     <!-- more top items + menus -->
 *   </div>
 *
 * Implements the WAI-ARIA APG **Menubar** pattern (single level): the top items
 * form one Tab stop via roving tabindex and the arrow keys move between them;
 * `ArrowDown`/`Enter`/`Space` open a menu (`ArrowUp` opens it at the last item),
 * the arrow keys then move within the menu, and pressing `ArrowLeft`/`ArrowRight`
 * while a menu is open jumps to the adjacent top menu. `Escape` closes and
 * returns focus to the owning top item; `Tab` and an outside click close.
 *
 * @remarks
 * Behavior only. Each top item↔menu pair is linked by `aria-controls`/`id` (not by
 * position), so the markup order is free. Menu placement and viewport-edge
 * collision are out of scope — static placement is the consumer's CSS, and dynamic
 * placement is delegated to the opt-in `stimeo-ui/positioning` module (never
 * imported here, keeping the core zero-dependency). Roving mechanics across the top
 * items are delegated to {@link RovingTabindex}.
 */
export class MenubarController extends Controller<HTMLElement> {
  static override targets = ["top", "menu", "item"];
  static actions = ["activate", "onItemKeydown", "onTopKeydown", "toggle"] as const;

  declare readonly topTargets: HTMLElement[];
  declare readonly menuTargets: HTMLElement[];
  declare readonly itemTargets: HTMLElement[];

  /** Roving tabindex across the top-level menuitems (one Tab stop). */
  readonly #roving = new RovingTabindex(() => this.topTargets);
  /** Typeahead buffer and its idle-reset timer (scoped to the open menu). */
  #typeahead = "";
  #typeaheadId = 0;
  readonly #timers = new SafeTimeout();

  /** Establishes the single tab stop and the closed baseline. */
  override connect(): void {
    const active = this.#roving.activeIndex;
    this.#roving.setActive(active === -1 ? 0 : active);
    this.#closeAllMenus();
    document.addEventListener("click", this.#onOutsideClick);
  }

  /** Removes the document listener and any pending typeahead timer. */
  override disconnect(): void {
    document.removeEventListener("click", this.#onOutsideClick);
    this.#timers.clearAll();
  }

  /** Toggles a top item's menu. Bound via `data-action` (click on the top item). */
  toggle(event: Event): void {
    const top = event.currentTarget as HTMLElement;
    if (this.#isExpanded(top)) {
      this.#closeMenu(top);
    } else {
      this.#openMenu(top, "first");
    }
  }

  /** Keyboard handling while focus is on a top item. */
  onTopKeydown(event: KeyboardEvent): void {
    const tops = this.topTargets;
    const index = tops.indexOf(event.currentTarget as HTMLElement);
    if (index === -1) return;
    const length = tops.length;
    // Whether a menu is currently open governs whether horizontal moves *open*
    // the adjacent menu or merely move the roving focus between top items.
    const anyOpen = this.#isAnyOpen;

    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        this.#gotoTop((index + 1) % length, anyOpen);
        break;
      case "ArrowLeft":
        event.preventDefault();
        this.#gotoTop((index - 1 + length) % length, anyOpen);
        break;
      case "ArrowDown":
        event.preventDefault();
        this.#openMenu(tops[index], "first");
        break;
      case "ArrowUp":
        event.preventDefault();
        this.#openMenu(tops[index], "last");
        break;
      case "Home":
        event.preventDefault();
        this.#gotoTop(0, anyOpen);
        break;
      case "End":
        event.preventDefault();
        this.#gotoTop(length - 1, anyOpen);
        break;
      case "Escape":
        if (anyOpen) {
          event.preventDefault();
          this.#closeAllMenus();
        }
        break;
      default:
        break;
    }
    // Enter/Space are intentionally left to the native button click, which runs
    // toggle() (open + focus first item) — handling them here would double-fire.
  }

  /** Keyboard handling while focus is on a menu item. */
  onItemKeydown(event: KeyboardEvent): void {
    const item = event.currentTarget as HTMLElement;
    const menu = item.closest<HTMLElement>("[role='menu']");
    if (!menu) return;
    const items = this.#itemsIn(menu);
    const index = items.indexOf(item);
    const length = items.length;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.#focusAt(items, (index + 1) % length);
        break;
      case "ArrowUp":
        event.preventDefault();
        this.#focusAt(items, (index - 1 + length) % length);
        break;
      case "Home":
        event.preventDefault();
        this.#focusAt(items, 0);
        break;
      case "End":
        event.preventDefault();
        this.#focusAt(items, length - 1);
        break;
      case "ArrowRight":
        event.preventDefault();
        this.#moveToAdjacentMenu(menu, 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        this.#moveToAdjacentMenu(menu, -1);
        break;
      case "Escape":
        event.preventDefault();
        this.#closeMenu(this.#topFor(menu));
        this.#focusTop(this.#topFor(menu));
        break;
      case "Tab":
        // Per APG, Tab closes the menubar but lets focus move on naturally.
        this.#closeAllMenus();
        break;
      default:
        if (this.#isTypeaheadKey(event)) {
          event.preventDefault();
          this.#typeaheadTo(items, index, event.key);
        }
        break;
    }
    // Enter/Space activate the item via its native button click → activate().
  }

  /** Closes the owning menu after an item is activated and refocuses its top. */
  activate(event: Event): void {
    const item = event.currentTarget as HTMLElement;
    const menu = item.closest<HTMLElement>("[role='menu']");
    const top = this.#topFor(menu);
    this.#closeAllMenus();
    this.#focusTop(top);
  }

  /** Moves the roving focus to top `index`, opening its menu when one was open. */
  #gotoTop(index: number, reopen: boolean): void {
    const top = this.topTargets[index];
    if (!top) return;
    if (reopen) {
      this.#openMenu(top, "first");
    } else {
      this.#roving.setActive(index, { focus: true });
    }
  }

  /** Opens `top`'s menu (closing others) and focuses its first/last item. */
  #openMenu(top: HTMLElement | null | undefined, focus: OpenFocus): void {
    if (!top) return;
    this.#closeAllMenus();
    const menu = this.#menuFor(top);
    if (!menu) return;
    menu.hidden = false;
    top.setAttribute("aria-expanded", "true");
    this.#roving.setActive(this.topTargets.indexOf(top));
    const items = this.#itemsIn(menu);
    this.#focusAt(items, focus === "first" ? 0 : items.length - 1);
  }

  /** Hides `top`'s menu and reflects the collapsed state. */
  #closeMenu(top: HTMLElement | null): void {
    if (!top) return;
    const menu = this.#menuFor(top);
    if (menu) menu.hidden = true;
    top.setAttribute("aria-expanded", "false");
  }

  /** Closes every menu and resets the typeahead buffer. */
  #closeAllMenus(): void {
    for (const top of this.topTargets) this.#closeMenu(top);
    this.#resetTypeahead();
  }

  /** Opens the menu of the top item `delta` steps from the one owning `menu`. */
  #moveToAdjacentMenu(menu: HTMLElement, delta: number): void {
    const top = this.#topFor(menu);
    if (!top) return;
    const tops = this.topTargets;
    const next = (tops.indexOf(top) + delta + tops.length) % tops.length;
    this.#openMenu(tops[next], "first");
  }

  /** Closes when a click lands outside the controller's element. */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    if (this.#isAnyOpen && !this.element.contains(event.target as Node)) this.#closeAllMenus();
  };

  /** The menu element controlled by `top` (matched by `aria-controls`/`id`). */
  #menuFor(top: HTMLElement): HTMLElement | null {
    const id = top.getAttribute("aria-controls");
    // Resolve against this controller's own menu targets (not a global id lookup)
    // so it stays scoped to this menubar instance.
    return id ? (this.menuTargets.find((menu) => menu.id === id) ?? null) : null;
  }

  /** The top item that controls `menu` (reverse of `#menuFor`). */
  #topFor(menu: HTMLElement | null): HTMLElement | null {
    if (!menu) return null;
    return this.topTargets.find((top) => top.getAttribute("aria-controls") === menu.id) ?? null;
  }

  /** The item targets that live inside `menu`, in DOM order. */
  #itemsIn(menu: HTMLElement): HTMLElement[] {
    return this.itemTargets.filter((item) => menu.contains(item));
  }

  /** Moves DOM focus to the item at `index` (no-op if out of range). */
  #focusAt(items: HTMLElement[], index: number): void {
    items[index]?.focus();
  }

  /** Returns roving focus to a top item (and makes it the single tab stop). */
  #focusTop(top: HTMLElement | null): void {
    if (!top) return;
    this.#roving.setActive(this.topTargets.indexOf(top), { focus: true });
  }

  /** Whether `top`'s menu is currently expanded. */
  #isExpanded(top: HTMLElement): boolean {
    return top.getAttribute("aria-expanded") === "true";
  }

  /** Whether any top item's menu is currently open. */
  get #isAnyOpen(): boolean {
    return this.topTargets.some((top) => this.#isExpanded(top));
  }

  /**
   * Whether the event is a single printable character usable for typeahead.
   * `Space` is excluded: on a `<button>` menuitem it natively activates the item
   * (Enter/Space → click), so swallowing it for typeahead would break activation.
   */
  #isTypeaheadKey(event: KeyboardEvent): boolean {
    return (
      event.key.length === 1 &&
      event.key !== " " &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    );
  }

  /** Advances focus to the next item in `items` matching the accumulated buffer. */
  #typeaheadTo(items: HTMLElement[], current: number, key: string): void {
    this.#typeahead += key.toLowerCase();
    this.#timers.clear(this.#typeaheadId);
    this.#typeaheadId = this.#timers.set(() => this.#resetTypeahead(), TYPEAHEAD_RESET_MS);

    const count = items.length;
    // Start the search just after the current item so repeated presses cycle.
    for (let step = 1; step <= count; step++) {
      const candidate = items[(current + step) % count];
      const label = (candidate?.textContent ?? "").trim().toLowerCase();
      if (label.startsWith(this.#typeahead)) {
        candidate?.focus();
        return;
      }
    }
  }

  /** Clears the typeahead buffer and its timer. */
  #resetTypeahead(): void {
    this.#typeahead = "";
    this.#timers.clear(this.#typeaheadId);
  }
}
