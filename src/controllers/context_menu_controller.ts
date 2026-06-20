import { Controller } from "@hotwired/stimulus";

/**
 * Headless, accessible **context menu** behavior.
 *
 * Markup contract (identifier: `stimeo--context-menu`):
 *   <div data-controller="stimeo--context-menu">
 *     <div data-stimeo--context-menu-target="region" tabindex="0"
 *          aria-haspopup="menu" aria-controls="ctx"
 *          data-action="contextmenu->stimeo--context-menu#open
 *                       keydown->stimeo--context-menu#onRegionKeydown">…</div>
 *     <ul id="ctx" role="menu" data-stimeo--context-menu-target="menu" hidden>
 *       <li role="none">
 *         <button role="menuitem" tabindex="-1"
 *                 data-stimeo--context-menu-target="item"
 *                 data-action="click->stimeo--context-menu#activate
 *                              keydown->stimeo--context-menu#onItemKeydown">…</button>
 *       </li>
 *     </ul>
 *   </div>
 *
 * Implements the WAI-ARIA APG **Menu** pattern; the only differences from
 * `stimeo--menu` are the *trigger* (a `contextmenu` event or `Shift+F10` /
 * `ContextMenu` key, not a button click) and that the menu is shown at the
 * pointer coordinate.
 *
 * @remarks
 * Behavior only — the controller reflects the click coordinate as the CSS custom
 * properties `--stimeo-context-menu-x` / `--stimeo-context-menu-y` on the menu
 * so the consumer's CSS can place it (works standalone, no positioning module
 * required). Viewport-edge flip/shift is delegated to the opt-in
 * `stimeo-ui/positioning` module, which this controller never imports.
 *
 * Open state is exposed on the region as `data-state` (`open`/`closed`) — a CSS
 * hook, not an ARIA one. `aria-expanded` is deliberately *not* set on the region
 * because it is a generic container, not a role that supports that state (doing so
 * is an ARIA violation); the region's static `aria-haspopup="menu"` advertises the
 * popup, and assistive tech perceives the open state when focus moves into the
 * `role="menu"`.
 *
 * Behavior provided:
 * - `contextmenu` on the region suppresses the browser menu and opens this one at
 *   the pointer; `Shift+F10` / `ContextMenu` opens it at the region's center.
 * - On open, focus moves to the first item; the region's `data-state` syncs.
 * - Roving focus inside the menu: `ArrowUp`/`ArrowDown` (wrapping), `Home`/`End`.
 * - Activating an item (click / native `Enter`/`Space` on the button) closes the
 *   menu and restores focus to the region.
 * - `Escape` closes and restores focus to the region; `Tab` closes without
 *   restoring (focus moves on naturally); an outside click closes.
 *
 * Roving focus skips items that are not navigable — `hidden`, natively
 * `disabled`, or `aria-disabled="true"` — so the keyboard never lands focus on an
 * inert command (matching `stimeo--menu` / `stimeo--command-palette`).
 */
export class ContextMenuController extends Controller<HTMLElement> {
  static override targets = ["region", "menu", "item"];
  static actions = ["activate", "onItemKeydown", "onRegionKeydown", "open"] as const;

  declare readonly regionTarget: HTMLElement;
  declare readonly menuTarget: HTMLElement;
  declare readonly itemTargets: HTMLButtonElement[];
  declare readonly hasRegionTarget: boolean;
  declare readonly hasMenuTarget: boolean;

  /** Starts closed and registers the outside-click listener. */
  override connect(): void {
    this.#closeMenu();
    document.addEventListener("click", this.#onOutsideClick);
  }

  /** Removes the document-level listener registered in {@link connect}. */
  override disconnect(): void {
    document.removeEventListener("click", this.#onOutsideClick);
  }

  /**
   * Opens the menu from a `contextmenu` event: suppresses the native menu and
   * places this one at the pointer coordinate.
   */
  open(event: MouseEvent): void {
    event.preventDefault();
    this.#openAt(event.clientX, event.clientY);
  }

  /** Keyboard entry on the region: `Shift+F10` / `ContextMenu` open at center. */
  onRegionKeydown(event: KeyboardEvent): void {
    const isContextKey = event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
    if (!isContextKey) return;
    event.preventDefault();
    const rect = this.hasRegionTarget
      ? this.regionTarget.getBoundingClientRect()
      : { left: 0, top: 0, width: 0, height: 0 };
    this.#openAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  /** Roving focus and closing keys inside the menu. */
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
        this.#closeAndRestore();
        break;
      case "Tab":
        // Per APG, Tab closes the menu but lets focus move on naturally.
        this.#closeMenu();
        break;
      default:
        break;
    }
  }

  /** Closes after an item is activated and restores focus to the region. */
  activate(): void {
    this.#closeAndRestore();
  }

  /** Opens the menu at viewport coordinates `(x, y)` and focuses the first item. */
  #openAt(x: number, y: number): void {
    if (!this.hasMenuTarget) return;
    this.menuTarget.style.setProperty("--stimeo-context-menu-x", `${x}px`);
    this.menuTarget.style.setProperty("--stimeo-context-menu-y", `${y}px`);
    this.menuTarget.hidden = false;
    if (this.hasRegionTarget) this.regionTarget.setAttribute("data-state", "open");
    this.#navigableItems[0]?.focus();
  }

  /** Hides the menu and reflects the collapsed state on the region. */
  #closeMenu(): void {
    if (!this.hasMenuTarget) return;
    this.menuTarget.hidden = true;
    if (this.hasRegionTarget) this.regionTarget.setAttribute("data-state", "closed");
  }

  /** Closes the menu and returns focus to the region (Escape / activation). */
  #closeAndRestore(): void {
    this.#closeMenu();
    if (this.hasRegionTarget) this.regionTarget.focus();
  }

  /** Closes the menu when a click lands outside the controller's element. */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    if (this.#isOpen && !this.element.contains(event.target as Node)) this.#closeMenu();
  };

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
