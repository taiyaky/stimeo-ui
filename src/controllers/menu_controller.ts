import { Controller } from "@hotwired/stimulus";

/**
 * Headless, accessible menu button behavior.
 *
 * Markup contract (identifier: `stimeo--menu`):
 *   <div data-controller="stimeo--menu">
 *     <button data-stimeo--menu-target="trigger"
 *             data-action="click->stimeo--menu#toggle
 *                          keydown->stimeo--menu#onTriggerKeydown"
 *             aria-haspopup="menu" aria-expanded="false" aria-controls="menu">
 *       Actions
 *     </button>
 *     <ul id="menu" role="menu" data-stimeo--menu-target="menu" hidden>
 *       <li role="none">
 *         <button role="menuitem" tabindex="-1"
 *                 data-stimeo--menu-target="item"
 *                 data-action="click->stimeo--menu#activate
 *                              keydown->stimeo--menu#onItemKeydown">…</button>
 *       </li>
 *     </ul>
 *   </div>
 *
 * Implements the WAI-ARIA APG **Menu Button** pattern (a button that opens a menu
 * of commands). Unlike `stimeo--dropdown` (a disclosure for arbitrary content),
 * this is a true `role="menu"` widget with roving focus across `role="menuitem"`
 * children.
 *
 * @remarks
 * Behavior only — static placement is the consumer's responsibility (CSS), and
 * viewport-edge collision handling is intentionally out of scope (a future shared
 * positioning module will own it). State is exposed via `aria-expanded` and the
 * menu's `hidden` attribute.
 *
 * Behavior provided:
 * - Click the trigger to toggle; `ArrowDown`/`ArrowUp` open and focus the
 *   first/last item.
 * - Within the menu, `ArrowDown`/`ArrowUp` move focus (wrapping), `Home`/`End`
 *   jump to the first/last item, `Escape`/`Tab` close and return focus to the
 *   trigger, and activating an item closes the menu.
 * - A click outside the controller closes the menu.
 *
 * Roving focus skips items that are not navigable — `hidden`, natively
 * `disabled`, or `aria-disabled="true"` — so the keyboard never lands focus on an
 * inert command (matching `stimeo--command-palette` / `stimeo--toolbar`).
 */
export class MenuController extends Controller<HTMLElement> {
  static override targets = ["trigger", "menu", "item"];
  static actions = [
    "activate",
    "close",
    "onItemKeydown",
    "onTriggerKeydown",
    "open",
    "toggle",
  ] as const;

  declare readonly triggerTarget: HTMLButtonElement;
  declare readonly menuTarget: HTMLElement;
  declare readonly itemTargets: HTMLButtonElement[];
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasMenuTarget: boolean;

  /** Starts closed and registers the outside-click listener. */
  override connect(): void {
    this.close();
    document.addEventListener("click", this.#onOutsideClick);
  }

  /** Removes the document-level listener registered in {@link connect}. */
  override disconnect(): void {
    document.removeEventListener("click", this.#onOutsideClick);
  }

  /** Toggles the menu open/closed. Bound via `data-action` (click). */
  toggle(): void {
    if (this.#isOpen) {
      this.close();
    } else {
      this.open();
      this.#focusFirst();
    }
  }

  /** Opens the menu and reflects the expanded state on the trigger. */
  open(): void {
    if (!this.hasMenuTarget) return;
    this.menuTarget.hidden = false;
    if (this.hasTriggerTarget) this.triggerTarget.setAttribute("aria-expanded", "true");
  }

  /** Closes the menu and reflects the collapsed state on the trigger. */
  close(): void {
    if (!this.hasMenuTarget) return;
    this.menuTarget.hidden = true;
    if (this.hasTriggerTarget) this.triggerTarget.setAttribute("aria-expanded", "false");
  }

  /**
   * Opens the menu with the keyboard per the APG (Down → first, Up → last).
   *
   * Enter/Space are intentionally not handled here: on a native `<button>`
   * trigger the browser turns them into a click, which already runs
   * {@link toggle} (open + focus first item). Handling them again here would
   * open and then immediately re-toggle the menu.
   */
  onTriggerKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.open();
      this.#focusFirst();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      this.open();
      this.#focusLast();
    }
  }

  /** Implements roving focus and closing keys inside the menu. */
  onItemKeydown(event: KeyboardEvent): void {
    const items = this.#navigableItems;
    const currentIndex = items.indexOf(event.currentTarget as HTMLButtonElement);

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (items.length > 0) items[(currentIndex + 1) % items.length]?.focus();
        break;
      case "ArrowUp":
        event.preventDefault();
        if (items.length > 0) items[(currentIndex - 1 + items.length) % items.length]?.focus();
        break;
      case "Home":
        event.preventDefault();
        items[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        items[items.length - 1]?.focus();
        break;
      case "Escape":
        event.preventDefault();
        this.close();
        if (this.hasTriggerTarget) this.triggerTarget.focus();
        break;
      case "Tab":
        // Per APG, Tab closes the menu but focus moves on naturally (it is not
        // returned to the trigger — that is Escape's job).
        this.close();
        break;
      default:
        break;
    }
  }

  /** Closes the menu after an item is activated. Bound via `data-action`. */
  activate(): void {
    this.close();
    if (this.hasTriggerTarget) this.triggerTarget.focus();
  }

  /** Closes the menu when a click lands outside the controller's element. */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    if (this.#isOpen && !this.element.contains(event.target as Node)) this.close();
  };

  /** Moves focus to the first navigable item (no-op if none). */
  #focusFirst(): void {
    this.#navigableItems[0]?.focus();
  }

  /** Moves focus to the last navigable item (no-op if none). */
  #focusLast(): void {
    const items = this.#navigableItems;
    items[items.length - 1]?.focus();
  }

  /** Menu items eligible for roving focus (excludes disabled / hidden). */
  get #navigableItems(): HTMLButtonElement[] {
    return this.itemTargets.filter((item) => this.#isNavigable(item));
  }

  /**
   * An item can take roving focus unless it is `hidden`, `aria-disabled="true"`,
   * or a natively `disabled` form control. CSS-only visibility is not detectable
   * here and is the consumer's responsibility.
   */
  #isNavigable(item: HTMLButtonElement): boolean {
    if (item.hasAttribute("hidden")) return false;
    if (item.getAttribute("aria-disabled") === "true") return false;
    return !item.disabled;
  }

  /** Whether the menu is currently visible. */
  get #isOpen(): boolean {
    return this.hasMenuTarget && !this.menuTarget.hidden;
  }
}
