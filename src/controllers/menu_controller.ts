import { Controller } from "@hotwired/stimulus";
import { claimsWhileFocusWithin, EscapeLayer } from "../utils/escape_layer";
import { SafeTimeout } from "../utils/safe_timeout";

/**
 * Headless, accessible menu button behavior.
 *
 * Markup contract (identifier: `stimeo--menu`):
 *   <div data-controller="stimeo--menu">
 *     <button id="menu-trigger" data-stimeo--menu-target="trigger"
 *             data-action="click->stimeo--menu#toggle
 *                          keydown->stimeo--menu#onTriggerKeydown"
 *             aria-haspopup="menu" aria-expanded="false" aria-controls="menu">
 *       Actions
 *     </button>
 *     <ul id="menu" role="menu" aria-labelledby="menu-trigger"
 *         data-stimeo--menu-target="menu" hidden>
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
 * Behavior only — the core controller owns no placement. Consumers can use static
 * CSS or compose the menu with the opt-in `stimeo-ui/positioning` entrypoint for
 * viewport-aware placement. State is exposed via `aria-expanded` and the menu's
 * `hidden` attribute.
 *
 * Behavior provided:
 * - Click the trigger to toggle; `ArrowDown`/`ArrowUp` open and focus the
 *   first/last item.
 * - Within the menu, `ArrowDown`/`ArrowUp` move focus (wrapping), `Home`/`End`
 *   jump to the first/last item, `Tab` lets the browser move focus first and
 *   then closes on the next task, and activating an enabled item closes the menu.
 * - `Escape` closes and returns focus to the trigger. While open the menu is a
 *   layer on the shared {@link EscapeLayer} stack; it claims a press only while
 *   focus is inside the controller or fell to the body, so one keypress closes
 *   exactly one layer (the shared layered-Escape contract) and a newer layer
 *   (e.g. a tooltip shown over an item) is dismissed first.
 * - A click outside the controller closes the menu without moving focus away
 *   from the clicked element.
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

  readonly #timers = new SafeTimeout();

  /** Escape-stack membership while open; the shared resolver dismisses via it. */
  readonly #escapeLayer = new EscapeLayer();

  /** Starts closed and registers delegated listeners. */
  override connect(): void {
    this.close();
    this.element.addEventListener("click", this.#onItemClickCapture, true);
    document.addEventListener("click", this.#onOutsideClick);
  }

  /** Releases the listeners, stack membership, and any pending Tab-close task. */
  override disconnect(): void {
    this.#timers.clearAll();
    this.#escapeLayer.deactivate();
    this.element.removeEventListener("click", this.#onItemClickCapture, true);
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
    // A reopen must discard a pending Tab close, or the stale task would slam
    // the freshly opened menu shut on the next tick.
    this.#timers.clearAll();
    if (!this.hasMenuTarget) return;
    this.#escapeLayer.activate(document, {
      onDismiss: () => this.#closeAndRestore(),
      claims: claimsWhileFocusWithin(this.element),
    });
    this.menuTarget.hidden = false;
    if (this.hasTriggerTarget) this.triggerTarget.setAttribute("aria-expanded", "true");
  }

  /** Closes the menu and reflects the collapsed state on the trigger. */
  close(): void {
    this.#timers.clearAll();
    this.#escapeLayer.deactivate();
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
      case "Tab":
        // Per APG, Tab closes the menu but focus moves on naturally (it is not
        // returned to the trigger — that is Escape's job). Closing synchronously
        // would remove the focused item before the browser's default Tab action,
        // which can restart traversal at the document head, so the close is
        // deferred to the next task.
        this.#timers.clearAll();
        this.#timers.set(() => this.close(), 0);
        break;
      default:
        break;
    }
  }

  /** Closes the menu after an item is activated. Bound via `data-action`. */
  activate(): void {
    this.#closeAndRestore();
  }

  /** Closes and returns focus to the trigger (Escape / item-activation path). */
  #closeAndRestore(): void {
    this.close();
    if (this.hasTriggerTarget) this.triggerTarget.focus();
  }

  /** Closes the menu when a click lands outside the controller's element. */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    if (this.#isOpen && !this.element.contains(event.target as Node)) this.close();
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
