import { Controller } from "@hotwired/stimulus";
import { isAriaDisabled } from "../utils/aria_disabled";
import { hasModifierChord, isReservedArrowChord } from "../utils/arrow_step";
import { AttributeLease } from "../utils/attribute_lease";
import { ClickVerdicts } from "../utils/click_verdicts";
import { claimsWhileFocusWithin, EscapeLayer } from "../utils/escape_layer";
import { ownerOf, ownersOf } from "../utils/event_owner";
import { ListenerSet } from "../utils/listener_set";
import { SafeTimeout } from "../utils/safe_timeout";
import { type StateReason, stateReasonFor } from "../utils/state_reason";

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
 * gesture activates once.
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
 *   layer on the shared `EscapeLayer` stack; it claims a press only while
 *   focus is inside the controller or fell to the body, so one keypress closes
 *   exactly one layer and a newer layer (e.g. a tooltip shown over an item) is
 *   dismissed first.
 * - A click outside the controller closes the menu without moving focus away
 *   from the clicked element.
 * - A trigger or a menu that takes over — in one task, or after an earlier one
 *   leaves in a later task — carries the open state; focus stays where the swap
 *   left it. With no menu left the menu button reads closed and leaves the Escape
 *   stack. One that stops resolving as the target gets back what it carried before
 *   this controller wrote on it.
 * - Each move of the open state is reported: `stimeo--menu:open` and
 *   `stimeo--menu:close` dispatch `{ reason: StateReason }`, after the state
 *   attributes are written. Both are informational, so neither is cancelable. A
 *   call that leaves the state where it already was, the normalization in
 *   {@link connect}, a trigger or a menu that takes over, and {@link disconnect}
 *   are all silent.
 *
 * Roving focus skips `hidden` and natively `disabled` items. An item that carries
 * `aria-disabled="true"`, or sits inside an element that does, remains discoverable by
 * arrow-key focus; ARIA applies the state to every focusable descendant. None of these
 * is activated on any path: {@link activate} does nothing for an event whose target
 * one of them holds — items can nest, and any item holding the target that refuses
 * refuses the event — and a capture listener on the controller element also stops a
 * click an `aria-disabled` one holds before the handlers inside that element
 * run. A click is judged once, in that capture pass, so a consumer handler that
 * disables the item while the click runs does not take back the activation. The
 * verdict holds only for an item that held the click's target when it was taken: an
 * item it was not taken for — a handler moved the target into another one — is
 * judged when the action runs, as is any other event.
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
  static events = ["close", "open"] as const;

  declare readonly triggerTarget: HTMLButtonElement;
  declare readonly triggerTargets: HTMLButtonElement[];
  declare readonly menuTarget: HTMLElement;
  declare readonly menuTargets: HTMLElement[];
  declare readonly itemTargets: HTMLButtonElement[];
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasMenuTarget: boolean;

  readonly #timers = new SafeTimeout();

  /** Escape-stack membership while open; the shared resolver dismisses via it. */
  readonly #escapeLayer = new EscapeLayer();
  /** Borrows `hidden` on the menu, to give back when an element stops being the menu. */
  readonly #menuHidden = new AttributeLease<HTMLElement>("hidden", this.identifier);
  /** Borrows `aria-expanded` on the trigger, for the same return. */
  readonly #expanded = new AttributeLease<HTMLElement>("aria-expanded", this.identifier);
  /** The menu the open state was last applied to. */
  #menu: HTMLElement | null = null;

  /**
   * The outermost item a click started in, recorded in the capture pass. Read once by
   * the delegated bubble listener, which must not re-derive it: consumer handlers run
   * in between and may detach the item.
   */
  #clickOwner: HTMLButtonElement | null = null;

  /** The activation verdict the capture pass took for a click, with the items it judged. */
  readonly #clickVerdicts = new ClickVerdicts();

  /** Clicks already turned into an activation, so the two paths run it once. */
  readonly #activated = new WeakSet<Event>();

  /** Whether `connect()` has run for this connection; target callbacks arrive outside it too. */
  #connected = false;

  /** Whether state moves are reported: set once `connect()` settled the baseline. */
  #reporting = false;

  /** The listeners of one connection, released together on `disconnect()`. */
  readonly #listeners = new ListenerSet();

  /** Starts closed and registers activation / outside-click listeners. */
  override connect(): void {
    this.#close("api");
    this.#listeners.add(this.element, "click", this.#onItemClickCapture, { capture: true });
    this.#listeners.add(this.element, "click", this.#onDelegatedItemClick);
    this.#listeners.add(this.element, "keydown", this.#onDelegatedItemKeydown);
    this.#listeners.add(document, "click", this.#onOutsideClick, { capture: true });
    this.#connected = true;
    this.#reporting = true;
  }

  /** Releases the listeners, stack membership, and any pending Tab-close task. */
  override disconnect(): void {
    this.#connected = false;
    this.#reporting = false;
    this.#timers.clearAll();
    this.#escapeLayer.deactivate();
    this.#listeners.dispose();
  }

  /** Brings a trigger that arrives after connect to the open state. */
  triggerTargetConnected(): void {
    if (this.#connected) this.#reflectTrigger();
  }

  /**
   * Gives a trigger that no longer resolves as one its own `aria-expanded` back — after
   * `disconnect()` too, since dropping the identifier leaves the element on the page — and
   * brings the trigger that stays to the open state.
   */
  triggerTargetDisconnected(trigger: HTMLButtonElement): void {
    if (!this.triggerTargets.includes(trigger)) this.#expanded.return(trigger);
    if (this.#connected) this.#reflectTrigger();
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

  /** Toggles the menu open/closed. Bound via `data-action` (click). */
  toggle(event?: Event): void {
    if (this.#isOpen) {
      this.close(event);
    } else {
      this.open(event);
      this.#focusFirst();
    }
  }

  /** Opens the menu and reflects the expanded state on the trigger. */
  open(event?: Event): void {
    this.#open(stateReasonFor(event));
  }

  /** Closes the menu and reflects the collapsed state on the trigger. */
  close(event?: Event): void {
    this.#close(stateReasonFor(event));
  }

  /** Opens the menu, reflects the expanded state, and reports a move. */
  #open(reason: StateReason): void {
    // A reopen must discard a pending Tab close, or the stale task would slam
    // the freshly opened menu shut on the next tick.
    this.#timers.clearAll();
    if (!this.hasMenuTarget) return;
    const menu = this.menuTarget;
    const was = this.#isOpen;
    this.#escapeLayer.activate(document, {
      onDismiss: () => this.#closeAndRestore("escape"),
      claims: claimsWhileFocusWithin(this.element),
    });
    this.#menuHidden.write(menu, null);
    this.#menu = menu;
    if (this.hasTriggerTarget) this.#expanded.write(this.triggerTarget, "true");
    if (!was && this.#reporting) this.dispatch("open", { detail: { reason }, cancelable: false });
  }

  /** Closes the menu, reflects the collapsed state, and reports a move. */
  #close(reason: StateReason): void {
    this.#timers.clearAll();
    this.#escapeLayer.deactivate();
    const menu = this.hasMenuTarget ? this.menuTarget : null;
    this.#menu = menu;
    if (!menu) return;
    const was = this.#isOpen;
    this.#menuHidden.write(menu, "");
    if (this.hasTriggerTarget) this.#expanded.write(this.triggerTarget, "false");
    if (was && this.#reporting) this.dispatch("close", { detail: { reason }, cancelable: false });
  }

  /**
   * Moves the open state onto the menu that is now first, when that menu changed: one that took
   * over carries the state of the menu before it, and one that arrives with none before it
   * arrives closed. With none left, the menu button leaves the Escape stack. The trigger then
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
      this.#menuHidden.write(menu, (previous?.hidden ?? true) ? "" : null);
    }
    this.#reflectTrigger();
  }

  /** Writes the open state onto the trigger that is first. */
  #reflectTrigger(): void {
    if (this.hasTriggerTarget) this.#expanded.write(this.triggerTarget, String(this.#isOpen));
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
      this.open(event);
      this.#focusFirst();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      this.open(event);
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
    if ((event.key === "Home" || event.key === "End") && hasModifierChord(event)) return;
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
        this.#timers.set(() => this.#close("focus"), 0);
        break;
      default:
        break;
    }
  }

  /**
   * Closes the menu after an item is activated. Bound via `data-action`, and
   * also reached from the delegated listener.
   *
   * An event whose target lies in an item that is `hidden`, natively `disabled`, or
   * `aria-disabled="true"` itself or through an ancestor does nothing: the menu stays
   * open, nothing is dispatched, focus stays where it is, and the event is left
   * unclaimed. Every item holding the target counts, so an item nested in another one
   * refuses for both. A click is judged as its capture pass found the items, before
   * the handlers inside the controller element ran, when the item this
   * resolves was among them; an item that was not, and any other event, is judged
   * when this runs. An event that resolves to no item closes the menu, and a
   * programmatic call with no event always runs.
   *
   * Markup that carries the per-element action *and* gets the delegate would run
   * this twice for one gesture. The state hooks (`hidden`, `aria-expanded`) are
   * written only when they change, so a second pass writes nothing on its own, but
   * a page handler between the two paths — on an ancestor of the item — that opens
   * the menu again would see the second pass close it. The event is therefore
   * claimed: the path that gets there first does the work, the other one finds it
   * claimed and returns.
   */
  activate(event?: Event): void {
    if (event === undefined) this.#closeAndRestore("select");
    else this.#activateItem(this.#itemFrom(event.target), event);
  }

  /**
   * Runs one gesture's activation for `item`, the item the event resolved to or
   * `null`. An item that refuses activation is turned away before the claim, so a
   * later path of the same event that finds the item enabled still runs it; every
   * path of one click reads the same verdict.
   */
  #activateItem(item: HTMLButtonElement | null, event: Event): void {
    if (item !== null && this.#refuses(item, event)) return;
    if (this.#activated.has(event)) return;
    this.#activated.add(event);
    this.#closeAndRestore("select");
  }

  /**
   * Whether the activation `event` asks of `item` is refused: the verdict the capture
   * pass took for the click when `item` was among the items holding its target,
   * otherwise whether any item holding the event's target refuses activation now.
   */
  #refuses(item: HTMLButtonElement, event: Event): boolean {
    const recorded = this.#clickVerdicts.for(event, item);
    if (recorded !== undefined) return recorded;
    return ownersOf(this.itemTargets, event.target).some((owner) =>
      this.#isActivationDisabled(owner),
    );
  }

  /** Closes and returns focus to the trigger (Escape / item-activation path). */
  #closeAndRestore(reason: StateReason): void {
    this.#close(reason);
    if (this.hasTriggerTarget) this.triggerTarget.focus();
  }

  /** Closes the menu when a click lands outside the controller's element. */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    if (this.#isOpen && !this.element.contains(event.target as Node)) this.#close("outside");
  };

  /**
   * Delegated twin of {@link onItemKeydown}, bound on the controller element.
   *
   * An item that arrives *after* connect — `stimeo--overflow-menu` moves toolbar controls
   * into this menu at runtime — carries whatever `data-action` its author wrote,
   * and that is exactly the binding a consumer forgets, because the markup that
   * declares the item lives nowhere near the menu. Listening on the container
   * makes membership in the `item` target enough to be operable. A per-element
   * action is also accepted and is not double-handled: see
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
   * over an item that no longer exists. The recorded item is refused on the
   * verdict the capture pass took for the items holding the target, as in
   * {@link activate}; a click an `aria-disabled` item holds never gets this far,
   * because the capture pass stops it outright.
   */
  readonly #onDelegatedItemClick = (event: MouseEvent): void => {
    const item = this.#clickOwner;
    this.#clickOwner = null;
    if (item === null) return;
    this.#activateItem(item, event);
  };

  /** The item target that is, or contains, `node`; `null` when it is neither. */
  #itemFrom(node: EventTarget | null): HTMLButtonElement | null {
    return ownerOf(this.itemTargets, node);
  }

  /**
   * Sees every click inside the controller before the handlers inside the
   * controller element run, so none of them has changed the DOM the click landed in
   * yet. Three jobs: record the outermost item holding the click for the delegate
   * above, record whether any item holding it refuses activation so every path of the
   * click that resolves one of those items acts on this one verdict, and stop a
   * command any `aria-disabled` item holds — the item's own state or an ancestor's —
   * before it reaches those handlers (native Enter/Space activation synthesizes a
   * click and is blocked here too).
   */
  readonly #onItemClickCapture = (event: MouseEvent): void => {
    const items = ownersOf(this.itemTargets, event.target);
    this.#clickOwner = items[0] ?? null;
    this.#clickVerdicts.record(
      event,
      items,
      items.some((item) => this.#isActivationDisabled(item)),
    );
    if (!items.some((item) => isAriaDisabled(item))) return;
    this.#clickOwner = null;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  /** Moves focus to the first navigable item (no-op if none). */
  #focusFirst(): void {
    // A subscriber may close the menu from the `open` handler; focusing then puts
    // the caret on an item nobody can see.
    if (!this.#isOpen) return;
    this.#navigableItems[0]?.focus();
  }

  /** Moves focus to the last navigable item (no-op if none). */
  #focusLast(): void {
    // See {@link MenuController.#focusFirst}.
    if (!this.#isOpen) return;
    const items = this.#navigableItems;
    items[items.length - 1]?.focus();
  }

  /** Menu items eligible for roving focus (excludes disabled / hidden). */
  get #navigableItems(): HTMLButtonElement[] {
    return this.itemTargets.filter((item) => this.#isNavigable(item));
  }

  /**
   * An item can take roving focus unless it is `hidden` or a natively `disabled`
   * form control. `aria-disabled`, on the item or an ancestor, remains focusable for
   * discoverability while its activation is refused. CSS-only visibility is the
   * consumer's responsibility.
   */
  #isNavigable(item: HTMLButtonElement): boolean {
    if (item.hasAttribute("hidden")) return false;
    return !item.disabled;
  }

  /**
   * Whether an item refuses activation: one roving focus skips (`hidden`, natively
   * `disabled`), or one that `aria-disabled="true"` reaches.
   */
  #isActivationDisabled(item: HTMLButtonElement): boolean {
    return !this.#isNavigable(item) || isAriaDisabled(item);
  }

  /** Whether the menu is currently visible. */
  get #isOpen(): boolean {
    return this.hasMenuTarget && !this.menuTarget.hidden;
  }
}
