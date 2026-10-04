import { Controller } from "@hotwired/stimulus";
import { actionSource } from "../utils/action_source";
import { isReservedArrowChord } from "../utils/arrow_step";
import { AttributeLease } from "../utils/attribute_lease";
import { claimsWhileFocusWithin, EscapeLayer } from "../utils/escape_layer";
import { SafeTimeout } from "../utils/safe_timeout";
import { type StateReason, stateReasonFor } from "../utils/state_reason";

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
 * Implements the WAI-ARIA APG **Menu** pattern. The trigger is a `contextmenu`
 * event or the `Shift+F10` / `ContextMenu` key rather than a button click, the
 * menu is shown at the pointer coordinate, open state is exposed as `data-state`
 * rather than `aria-expanded`, and each item carries its own `data-action`
 * bindings.
 *
 * @remarks
 * Behavior only — the controller reflects the click coordinate as the CSS custom
 * properties `--stimeo--context-menu-x` / `--stimeo--context-menu-y` on the menu
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
 *   layer on the shared `EscapeLayer` stack; it claims a press only while
 *   focus is inside the controller or fell to the body, so one keypress closes
 *   exactly one layer. `Tab` lets the browser move focus first, then closes on
 *   the next task. An outside click or context-menu invocation closes without
 *   stealing focus from its destination.
 * - A region or a menu that takes over — in one task, or after an earlier one
 *   leaves in a later task — carries the open state, and the menu that takes over
 *   an open one is placed where it was opened; focus stays where the swap left it.
 *   With no menu left the region reads closed and the menu leaves the Escape stack.
 *   One that stops resolving as the target gets back the `data-state` or `hidden` it
 *   carried before this controller wrote on it.
 * - Each move of the open state is reported: `stimeo--context-menu:open` and
 *   `stimeo--context-menu:close` dispatch `{ reason: StateReason }`, after the
 *   state attributes are written. Both are informational, so neither is
 *   cancelable. A call that leaves the state where it already was, the
 *   normalization in {@link connect}, a region or a menu that takes over, and
 *   {@link disconnect} are all silent.
 *
 * Roving focus skips `hidden` and natively `disabled` items. An
 * `aria-disabled="true"` item stays reachable by arrow keys — APG marks that
 * attribute precisely for controls that must remain discoverable — while its
 * activation is suppressed, so it announces itself and does nothing.
 */
export class ContextMenuController extends Controller<HTMLElement> {
  /** The custom properties that carry the coordinate the menu was opened at, x then y. */
  static readonly #COORDINATE = ["--stimeo--context-menu-x", "--stimeo--context-menu-y"] as const;

  static override targets = ["region", "menu", "item"];
  static actions = ["activate", "onItemKeydown", "onRegionKeydown", "open"] as const;
  static events = ["close", "open"] as const;

  declare readonly regionTarget: HTMLElement;
  declare readonly regionTargets: HTMLElement[];
  declare readonly menuTarget: HTMLElement;
  declare readonly menuTargets: HTMLElement[];
  declare readonly itemTargets: HTMLButtonElement[];
  declare readonly hasRegionTarget: boolean;
  declare readonly hasMenuTarget: boolean;

  readonly #timers = new SafeTimeout();

  /** Escape-stack membership while open; the shared resolver dismisses via it. */
  readonly #escapeLayer = new EscapeLayer();
  /** Borrows `hidden` on the menu, to give back when an element stops being the menu. */
  readonly #menuHidden = new AttributeLease<HTMLElement>("hidden", this.identifier);
  /** Borrows `data-state` on the region, for the same return. */
  readonly #regionState = new AttributeLease<HTMLElement>("data-state", this.identifier);
  /** The menu the open state was last applied to. */
  #menu: HTMLElement | null = null;

  /** Whether `connect()` has run for this connection; target callbacks arrive outside it too. */
  #connected = false;

  /** Whether state moves are reported: set once `connect()` settled the baseline. */
  #reporting = false;

  /** Starts closed and registers delegated activation and outside-pointer listeners. */
  override connect(): void {
    this.#closeMenu("api");
    this.element.addEventListener("click", this.#onItemClickCapture, true);
    document.addEventListener("click", this.#onOutsidePointer, true);
    document.addEventListener("contextmenu", this.#onOutsidePointer, true);
    this.#connected = true;
    this.#reporting = true;
  }

  /** Releases the listeners, stack membership, and pending Tab-close task. */
  override disconnect(): void {
    this.#connected = false;
    this.#reporting = false;
    this.#timers.clearAll();
    this.#escapeLayer.deactivate();
    this.element.removeEventListener("click", this.#onItemClickCapture, true);
    document.removeEventListener("click", this.#onOutsidePointer, true);
    document.removeEventListener("contextmenu", this.#onOutsidePointer, true);
  }

  /** Brings a region that arrives after connect to the open state. */
  regionTargetConnected(): void {
    if (this.#connected) this.#reflectRegion();
  }

  /**
   * Gives a region that no longer resolves as one its own `data-state` back — after
   * `disconnect()` too, since dropping the identifier leaves the element on the page — and
   * brings the region that stays to the open state.
   */
  regionTargetDisconnected(region: HTMLElement): void {
    if (!this.regionTargets.includes(region)) this.#regionState.return(region);
    if (this.#connected) this.#reflectRegion();
  }

  /** Applies the open state to a menu that arrives after connect in front of the others. */
  menuTargetConnected(): void {
    this.#adoptMenu();
  }

  /**
   * Applies the open state to the menu left, then gives a menu that no longer resolves as the
   * target its own `hidden` back — after `disconnect()` too, since dropping the identifier
   * leaves the element on the page. The open state is read off the departing menu first,
   * while it still carries it.
   */
  menuTargetDisconnected(menu: HTMLElement): void {
    this.#adoptMenu();
    if (!this.menuTargets.includes(menu)) this.#menuHidden.return(menu);
  }

  /**
   * Opens at a mouse event's coordinate, an explicit element's center, or the
   * region's center with no argument. Opening focuses the new menu in all paths.
   * An explicit element may be an anchor outside the controller.
   */
  open(input?: Event | HTMLElement): void {
    const source = actionSource(input);
    source.event?.preventDefault();
    if (source.event instanceof MouseEvent) {
      this.#openAt(source.event.clientX, source.event.clientY, source.reason);
      return;
    }
    const anchor = source.host ?? (this.hasRegionTarget ? this.regionTarget : null);
    const rect = anchor?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 };
    this.#openAt(rect.left + rect.width / 2, rect.top + rect.height / 2, source.reason);
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
    this.#openAt(rect.left + rect.width / 2, rect.top + rect.height / 2, stateReasonFor(event));
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
        this.#timers.set(() => this.#closeMenu("focus"), 0);
        break;
      default:
        break;
    }
  }

  /** Closes after an item is activated and restores focus to the region. */
  activate(): void {
    this.#closeAndRestore("select");
  }

  /** Opens the menu at viewport coordinates `(x, y)` and focuses the first item. */
  #openAt(x: number, y: number, reason: StateReason): void {
    if (!this.hasMenuTarget) return;
    this.#timers.clearAll();
    const menu = this.menuTarget;
    const was = this.#isOpen;
    this.#escapeLayer.activate(document, {
      onDismiss: () => this.#closeAndRestore("escape"),
      claims: claimsWhileFocusWithin(this.element),
    });
    menu.style.setProperty(ContextMenuController.#COORDINATE[0], `${x}px`);
    menu.style.setProperty(ContextMenuController.#COORDINATE[1], `${y}px`);
    this.#menuHidden.write(menu, null);
    this.#menu = menu;
    if (this.hasRegionTarget) this.#regionState.write(this.regionTarget, "open");
    if (!was && this.#reporting) this.dispatch("open", { detail: { reason }, cancelable: false });
    // A subscriber may close it again from the handler above; focusing then puts
    // the caret on an item nobody can see.
    if (!this.#isOpen) return;
    this.#navigableItems[0]?.focus();
  }

  /** Hides the menu, reflects the collapsed state on the region, and reports a move. */
  #closeMenu(reason: StateReason): void {
    this.#timers.clearAll();
    this.#escapeLayer.deactivate();
    const menu = this.hasMenuTarget ? this.menuTarget : null;
    this.#menu = menu;
    if (!menu) return;
    const was = this.#isOpen;
    this.#menuHidden.write(menu, "");
    if (this.hasRegionTarget) this.#regionState.write(this.regionTarget, "closed");
    if (was && this.#reporting) this.dispatch("close", { detail: { reason }, cancelable: false });
  }

  /**
   * Moves the open state onto the menu that is now first, when that menu changed: one that
   * takes over an open menu is shown where that one was opened, and one that arrives with none
   * before it arrives closed. With none left, the menu leaves the Escape stack. The region then
   * reads the menu, changed or not. Focus stays where the swap left it, and nothing is
   * dispatched.
   */
  #adoptMenu(): void {
    if (!this.#connected) return;
    const menu = this.hasMenuTarget ? this.menuTarget : null;
    const previous = this.#menu;
    this.#menu = menu;
    if (!menu) {
      this.#escapeLayer.deactivate();
    } else if (menu !== previous) {
      const open = previous !== null && !previous.hidden;
      if (open) {
        for (const property of ContextMenuController.#COORDINATE) {
          menu.style.setProperty(property, previous.style.getPropertyValue(property));
        }
      }
      this.#menuHidden.write(menu, open ? null : "");
    }
    this.#reflectRegion();
  }

  /** Writes the open state onto the region that is first. */
  #reflectRegion(): void {
    if (!this.hasRegionTarget) return;
    this.#regionState.write(this.regionTarget, this.#isOpen ? "open" : "closed");
  }

  /** Closes the menu and returns focus to the region (Escape / activation). */
  #closeAndRestore(reason: StateReason): void {
    this.#closeMenu(reason);
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
    if (this.#isOpen && !this.element.contains(event.target as Node)) this.#closeMenu("outside");
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
