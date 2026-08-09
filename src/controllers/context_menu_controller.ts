import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord } from "../utils/arrow_step";
import { claimsWhileFocusWithin, EscapeLayer } from "../utils/escape_layer";
import { SafeTimeout } from "../utils/safe_timeout";

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
 * - Activating an enabled item (click / native `Enter`/`Space` on the button)
 *   closes the menu and restores focus to the region. `aria-disabled` activation
 *   is blocked before consumer click handlers run.
 * - `Escape` closes and restores focus to the region. While open the menu is a
 *   layer on the shared {@link EscapeLayer} stack; it claims a press only while
 *   focus is inside the controller or fell to the body, so one keypress closes
 *   exactly one layer. `Tab` lets the browser move focus first, then closes on
 *   the next task. An outside click or context-menu invocation closes without
 *   stealing focus from its destination.
 *
 * Roving focus skips `hidden` and natively `disabled` items. An
 * `aria-disabled="true"` item stays reachable by arrow keys — APG marks that
 * attribute precisely for controls that must remain discoverable — while its
 * activation is suppressed, so it announces itself and does nothing.
 */
export class ContextMenuController extends Controller<HTMLElement> {
  static override targets = ["region", "menu", "item"];
  static actions = ["activate", "onItemKeydown", "onRegionKeydown", "open"] as const;

  declare readonly regionTarget: HTMLElement;
  declare readonly menuTarget: HTMLElement;
  declare readonly itemTargets: HTMLButtonElement[];
  declare readonly hasRegionTarget: boolean;
  declare readonly hasMenuTarget: boolean;

  readonly #timers = new SafeTimeout();

  /** Escape-stack membership while open; the shared resolver dismisses via it. */
  readonly #escapeLayer = new EscapeLayer();

  /** Starts closed and registers delegated activation and outside-pointer listeners. */
  override connect(): void {
    this.#closeMenu();
    this.element.addEventListener("click", this.#onItemClickCapture, true);
    document.addEventListener("click", this.#onOutsidePointer, true);
    document.addEventListener("contextmenu", this.#onOutsidePointer, true);
  }

  /** Releases the listeners, stack membership, and pending Tab-close task. */
  override disconnect(): void {
    this.#timers.clearAll();
    this.#escapeLayer.deactivate();
    this.element.removeEventListener("click", this.#onItemClickCapture, true);
    document.removeEventListener("click", this.#onOutsidePointer, true);
    document.removeEventListener("contextmenu", this.#onOutsidePointer, true);
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
    // A descendant widget that already claimed the key (a grabbed drag handle, a
    // nested menu) must not ALSO act on it — composition depends on this yield.
    if (event.defaultPrevented) return;
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
    // A descendant widget that already claimed the key (a grabbed drag handle, a
    // nested menu) must not ALSO act on it — composition depends on this yield.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    const items = this.#navigableItems;
    const currentIndex = items.indexOf(event.currentTarget as HTMLButtonElement);

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (items.length > 0) {
          const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
          items[nextIndex]?.focus();
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (items.length > 0) {
          const previousIndex = currentIndex < 0 ? items.length - 1 : currentIndex - 1;
          items[(previousIndex + items.length) % items.length]?.focus();
        }
        break;
      case "Home":
        event.preventDefault();
        items[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        items[items.length - 1]?.focus();
        break;
      case "Tab":
        // Closing synchronously removes the focused item before the browser's
        // default Tab action, which can restart traversal at the document head.
        this.#timers.clearAll();
        this.#timers.set(() => this.#closeMenu(), 0);
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
    this.#timers.clearAll();
    this.#escapeLayer.activate(document, {
      onDismiss: () => this.#closeAndRestore(),
      claims: claimsWhileFocusWithin(this.element),
    });
    this.menuTarget.style.setProperty("--stimeo-context-menu-x", `${x}px`);
    this.menuTarget.style.setProperty("--stimeo-context-menu-y", `${y}px`);
    this.menuTarget.hidden = false;
    if (this.hasRegionTarget) this.regionTarget.setAttribute("data-state", "open");
    this.#navigableItems[0]?.focus();
  }

  /** Hides the menu and reflects the collapsed state on the region. */
  #closeMenu(): void {
    this.#timers.clearAll();
    this.#escapeLayer.deactivate();
    if (!this.hasMenuTarget) return;
    this.menuTarget.hidden = true;
    if (this.hasRegionTarget) this.regionTarget.setAttribute("data-state", "closed");
  }

  /** Closes the menu and returns focus to the region (Escape / activation). */
  #closeAndRestore(): void {
    this.#closeMenu();
    if (this.hasRegionTarget) this.regionTarget.focus();
  }

  /**
   * Closes when a click or context-menu invocation lands outside this instance.
   * Both subscriptions observe in the capture phase, so the target is judged
   * against the tree the user actually pressed even when a consumer handler
   * detaches it, and application code that stops bubbling cannot leave the menu
   * open.
   */
  readonly #onOutsidePointer = (event: MouseEvent): void => {
    if (this.#isOpen && !this.element.contains(event.target as Node)) this.#closeMenu();
  };

  /**
   * Captures clicks so `aria-disabled` commands cannot reach consumer handlers.
   * Native Enter/Space activation also synthesizes a click and is blocked here.
   */
  readonly #onItemClickCapture = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    const disabled = this.itemTargets.some(
      (item) => item.getAttribute("aria-disabled") === "true" && item.contains(target),
    );
    if (!disabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  /** Menu items eligible for roving focus (excludes hidden / natively disabled). */
  get #navigableItems(): HTMLButtonElement[] {
    return this.itemTargets.filter((item) => this.#isNavigable(item));
  }

  /**
   * An item can take roving focus unless it is `hidden` or a natively `disabled`
   * form control. CSS-only visibility is not detectable here and is the
   * consumer's responsibility.
   *
   * **`aria-disabled="true"` stays reachable.** APG separates the two attributes
   * by intent: `disabled` is for controls whose existence can be inferred from a
   * neighbour (a greyed Next next to a Prev), while `aria-disabled` marks a
   * control that must stay *discoverable* — and it names menu items as the
   * example. Skipping it would hide the command's existence from a keyboard user
   * entirely. Activation is suppressed separately, so the item announces itself
   * and does nothing.
   */
  #isNavigable(item: HTMLButtonElement): boolean {
    if (item.hasAttribute("hidden")) return false;
    return !item.disabled;
  }

  /** Whether the menu is currently visible. */
  get #isOpen(): boolean {
    return this.hasMenuTarget && !this.menuTarget.hidden;
  }
}
