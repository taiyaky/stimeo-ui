import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord } from "../utils/arrow_step";
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
 *                 data-stimeo--menu-target="item">…</button>
 *       </li>
 *     </ul>
 *   </div>
 *
 * The trigger's two actions are required. Items need none: their click and key
 * handling is delegated from the controller element, so an item added, moved, or
 * server-rendered after connect works without the consumer wiring anything onto
 * it. The per-element form (`click->stimeo--menu#activate` /
 * `keydown->stimeo--menu#onItemKeydown`) is supported alongside it. A
 * focus-moving key runs once (the action claims it and the delegate stands
 * down), and `activate`, reachable on both paths, claims the click so one
 * gesture activates once. See {@link #onDelegatedItemClick}.
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
 *   exactly one layer and a newer layer (e.g. a tooltip shown over an item) is
 *   dismissed first.
 * - A click outside the controller closes the menu without moving focus away
 *   from the clicked element.
 *
 * Roving focus skips `hidden` and natively `disabled` items. An
 * `aria-disabled="true"` item remains discoverable by arrow-key focus, while its
 * activation is suppressed in the capture phase.
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

  /**
   * The item a click started on, recorded in the capture pass. Read once by the
   * delegated bubble listener, which must not re-derive it: consumer handlers run
   * in between and may detach the item.
   */
  #clickOwner: HTMLButtonElement | null = null;

  /** Clicks already turned into an activation, so the two paths run it once. */
  readonly #activated = new WeakSet<Event>();

  /** Starts closed and registers activation / outside-click listeners. */
  override connect(): void {
    this.close();
    this.element.addEventListener("click", this.#onItemClickCapture, true);
    this.element.addEventListener("click", this.#onDelegatedItemClick);
    this.element.addEventListener("keydown", this.#onDelegatedItemKeydown);
    document.addEventListener("click", this.#onOutsideClick, true);
  }

  /** Releases the listeners, stack membership, and any pending Tab-close task. */
  override disconnect(): void {
    this.#timers.clearAll();
    this.#escapeLayer.deactivate();
    this.element.removeEventListener("click", this.#onItemClickCapture, true);
    this.element.removeEventListener("click", this.#onDelegatedItemClick);
    this.element.removeEventListener("keydown", this.#onDelegatedItemKeydown);
    document.removeEventListener("click", this.#onOutsideClick, true);
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
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
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
    this.#handleItemKeydown(event, event.currentTarget);
  }

  /**
   * The roving-focus body, shared by the per-element action and its delegated
   * twin. `from` is the item the key belongs to: the bound element for the
   * action, the resolved owner of the event target for the delegate.
   */
  #handleItemKeydown(event: KeyboardEvent, from: EventTarget | null): void {
    // A descendant widget that already claimed the key must not also move the
    // menu's roving focus — composition depends on this yield. It is also what
    // makes the per-element action and the delegated listener idempotent:
    // whichever runs first calls `preventDefault()`, and the other one bows out.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    const items = this.#navigableItems;
    const currentIndex = items.indexOf(from as HTMLButtonElement);

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
        // deferred to the next task. The key is deliberately left unclaimed, so
        // this is the one branch both handlers can run: rescheduling the same
        // one-shot close is idempotent.
        this.#timers.clearAll();
        this.#timers.set(() => this.close(), 0);
        break;
      default:
        break;
    }
  }

  /**
   * Closes the menu after an item is activated. Bound via `data-action`, and
   * also reached from the delegated listener.
   *
   * Markup that carries the per-element action *and* gets the delegate would run
   * this twice for one gesture. `close()` writes the state hooks (`hidden`,
   * `aria-expanded`), and an identical reassign still queues a MutationRecord,
   * so a second pass is observable to anyone watching them. The event is
   * therefore claimed: the path that gets there first does the work, the other
   * one finds it claimed and returns. A programmatic call with no event always
   * runs.
   */
  activate(event?: Event): void {
    if (event !== undefined) {
      if (this.#activated.has(event)) return;
      this.#activated.add(event);
    }
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
   * Delegated twin of {@link onItemKeydown}, bound on the controller element.
   *
   * An item that arrives *after* connect — Overflow Menu moves toolbar controls
   * into this menu at runtime — carries whatever `data-action` its author wrote,
   * and that is exactly the binding a consumer forgets, because the markup that
   * declares the item lives nowhere near the menu. Listening on the container
   * makes membership in the `item` target enough to be operable. The per-element
   * action stays supported and is not double-handled: see
   * {@link #handleItemKeydown}.
   */
  readonly #onDelegatedItemKeydown = (event: KeyboardEvent): void => {
    const item = this.#itemFrom(event.target);
    if (item === null) return; // the trigger and menu chrome own their own keys
    this.#handleItemKeydown(event, item);
  };

  /**
   * Delegated twin of {@link activate}, for the same reason as the keydown one.
   *
   * It works from the item the capture pass recorded, not from a fresh lookup:
   * by the time a click bubbles up here, a consumer handler may already have
   * detached the row it lives in, and `itemTargets` is a live query that would
   * then resolve nothing — the activation would be lost and the menu left open
   * over an item that no longer exists. `aria-disabled` items never reach this
   * listener at all: the capture pass stops the click outright.
   */
  readonly #onDelegatedItemClick = (event: MouseEvent): void => {
    const item = this.#clickOwner;
    this.#clickOwner = null;
    if (item === null) return;
    this.activate(event);
  };

  /** The item target that is, or contains, `node`; `null` when it is neither. */
  #itemFrom(node: EventTarget | null): HTMLButtonElement | null {
    if (!(node instanceof Node)) return null;
    return this.itemTargets.find((item) => item === node || item.contains(node)) ?? null;
  }

  /**
   * First look at every click inside the controller, and the only point at which
   * the DOM is still the one the user clicked. Two jobs: record which item owns
   * the click for the delegate above, and stop an `aria-disabled` command before
   * it reaches consumer handlers (native Enter/Space activation synthesizes a
   * click and is blocked here too).
   */
  readonly #onItemClickCapture = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Node)) {
      this.#clickOwner = null;
      return;
    }
    const item = this.#itemFrom(target);
    this.#clickOwner = item;
    if (item === null || item.getAttribute("aria-disabled") !== "true") return;
    this.#clickOwner = null;
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
   * An item can take roving focus unless it is `hidden` or a natively `disabled`
   * form control. `aria-disabled` remains focusable for discoverability; capture
   * suppresses activation. CSS-only visibility is the consumer's responsibility.
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
