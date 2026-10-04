import { Controller } from "@hotwired/stimulus";
import { ensureId } from "../utils/aria_ids";
import { AttributeLease } from "../utils/attribute_lease";
import { claimsWhileFocusWithin, EscapeLayer } from "../utils/escape_layer";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import { type StateReason, stateReasonFor } from "../utils/state_reason";

/**
 * Headless, accessible dropdown menu behavior.
 *
 * Markup contract (identifier: `stimeo--dropdown`):
 *   <div data-controller="stimeo--dropdown">
 *     <button data-stimeo--dropdown-target="trigger"
 *             data-action="click->stimeo--dropdown#toggle">Menu</button>
 *     <div data-stimeo--dropdown-target="menu">...</div>
 *   </div>
 *
 * This is a **disclosure** pattern (WAI-ARIA APG): a button toggles the
 * visibility of an adjacent region. It is intentionally *not* a full APG
 * "menu" widget — there is no roving-tabindex arrow-key navigation.
 *
 * @remarks
 * The library owns behavior only (ARIA state, keyboard, focus, outside-click).
 * Visual styling is left entirely to the consumer's CSS.
 *
 * Behavior provided:
 * - The trigger is associated with the menu through `aria-controls`.
 * - Click the trigger to toggle the menu (`aria-expanded` + `hidden` reflect state).
 * - `Escape` closes the menu and returns focus to the trigger. While open the
 *   menu is a layer on the shared `EscapeLayer` stack; it claims a press
 *   only while focus is inside the controller or fell to the body (a click on
 *   non-focusable menu content), so a press aimed at another layer never closes
 *   the menu or steals focus, and one keypress closes exactly one layer.
 * - A click outside the controller element closes the menu.
 * - A trigger or a menu that takes over — in one task, or after an earlier one leaves
 *   in a later task — carries the open state, and an `aria-controls` this controller
 *   supplied names the menu that is first. With no menu left the dropdown reads
 *   closed and leaves the Escape stack. One that stops resolving as the target gets
 *   back what it carried before this controller wrote on it.
 * - A Turbo morph that keeps the elements drops the attributes the server did not
 *   send — the menu's `hidden`, the trigger's `aria-expanded` and the
 *   `aria-controls` this controller supplied. They are written back from the open
 *   state the controller holds, so a closed menu does not show up and an open one
 *   stays described.
 * - Each move of the open state is reported: `stimeo--dropdown:open` and
 *   `stimeo--dropdown:close` dispatch `{ reason: StateReason }`, after the
 *   attributes above are written. Both are informational, so neither is
 *   cancelable. A call that leaves the state where it already was, the
 *   normalization in {@link connect}, a trigger or a menu that takes over, the
 *   repair after a morph, and {@link disconnect} are all silent.
 */
export class DropdownController extends Controller<HTMLElement> {
  static override targets = ["trigger", "menu"];
  static actions = ["close", "open", "toggle"] as const;
  static events = ["close", "open"] as const;

  declare readonly triggerTarget: HTMLButtonElement;
  declare readonly triggerTargets: HTMLButtonElement[];
  declare readonly menuTarget: HTMLElement;
  declare readonly menuTargets: HTMLElement[];
  declare readonly hasMenuTarget: boolean;
  declare readonly hasTriggerTarget: boolean;

  /** Escape-stack membership while open; the shared resolver dismisses via it. */
  readonly #escapeLayer = new EscapeLayer();
  /** Borrows `hidden` on the menu, to give back when an element stops being the menu. */
  readonly #menuHidden = new AttributeLease<HTMLElement>("hidden", this.identifier);
  /** Borrows `aria-expanded` on the trigger, for the same return. */
  readonly #expanded = new AttributeLease<HTMLElement>("aria-expanded", this.identifier);
  /** The `aria-controls` this instance supplied on each trigger that has not given it back. */
  readonly #suppliedControls = new WeakMap<HTMLElement, string>();
  /** The menu the open state was last applied to. */
  #menu: HTMLElement | null = null;

  /** Whether `connect()` has run for this connection; target callbacks arrive outside it too. */
  #connected = false;

  /** Whether state moves are reported: set once `connect()` settled the baseline. */
  #reporting = false;

  /** Whether the menu is open, as the repair after a morph writes it back. */
  #openState = false;

  /** Writes the open state back after a Turbo morph dropped what the server did not send. */
  readonly #morphRender = new MorphRenderWatcher(() => this.#repair());

  /** Closes the menu when a click lands outside the controller's element. */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    if (!this.element.contains(event.target as Node)) {
      this.#close("outside");
    }
  };

  /** Starts in the closed state and registers outside-click handling. */
  override connect(): void {
    this.#associateTriggerWithMenu();
    this.#close("api");
    document.addEventListener("click", this.#onOutsideClick, true);
    this.#morphRender.observe(this.element);
    this.#connected = true;
    this.#reporting = true;
  }

  /** Removes the listeners registered in {@link connect}. */
  override disconnect(): void {
    this.#connected = false;
    this.#reporting = false;
    this.#escapeLayer.deactivate();
    document.removeEventListener("click", this.#onOutsideClick, true);
    this.#morphRender.disconnect();
  }

  /** Brings a trigger that arrives after connect to the open state and names the menu from it. */
  triggerTargetConnected(): void {
    if (this.#connected) this.#reflectTrigger();
  }

  /**
   * Gives a trigger that no longer resolves as one its own `aria-expanded` and `aria-controls`
   * back — after `disconnect()` too, since dropping the identifier leaves the element on the
   * page — and brings the trigger that stays to the open state.
   */
  triggerTargetDisconnected(trigger: HTMLButtonElement): void {
    if (!this.triggerTargets.includes(trigger)) {
      this.#expanded.return(trigger);
      this.#withdrawControls(trigger);
    }
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

  /** Toggles the menu between open and closed. Bound via `data-action`. */
  toggle(event?: Event): void {
    if (this.#isOpen) {
      this.close(event);
    } else {
      this.open(event);
    }
  }

  /** Reveals the menu and reflects the open state on the trigger. */
  open(event?: Event): void {
    this.#open(stateReasonFor(event));
  }

  /** Hides the menu and reflects the closed state on the trigger. */
  close(event?: Event): void {
    this.#close(stateReasonFor(event));
  }

  /** Reveals the menu, reflects the open state, and reports a move. */
  #open(reason: StateReason): void {
    if (!this.hasMenuTarget) return;
    const menu = this.menuTarget;
    const was = this.#isOpen;
    this.#escapeLayer.activate(document, {
      onDismiss: () => this.#closeAndRestore(),
      claims: claimsWhileFocusWithin(this.element),
    });
    this.#menuHidden.write(menu, null);
    this.#menu = menu;
    this.#openState = true;
    if (this.hasTriggerTarget) this.#expanded.write(this.triggerTarget, "true");
    if (!was && this.#reporting) this.dispatch("open", { detail: { reason }, cancelable: false });
  }

  /** Hides the menu, reflects the closed state, and reports a move. */
  #close(reason: StateReason): void {
    const was = this.#isOpen;
    this.#escapeLayer.deactivate();
    this.#openState = false;
    const menu = this.hasMenuTarget ? this.menuTarget : null;
    this.#menu = menu;
    if (!menu) return;
    this.#menuHidden.write(menu, "");
    if (this.hasTriggerTarget) this.#expanded.write(this.triggerTarget, "false");
    if (was && this.#reporting) this.dispatch("close", { detail: { reason }, cancelable: false });
  }

  /**
   * Moves the open state onto the menu that is now first, when that menu changed: one that took
   * over carries the state of the menu before it, and one that arrives with none before it
   * arrives closed. With none left, the dropdown leaves the Escape stack. The trigger then reads
   * the menu, changed or not. Nothing is dispatched.
   */
  #adoptMenu(): void {
    if (!this.#connected) return;
    const menu = this.hasMenuTarget ? this.menuTarget : null;
    const previous = this.#menu;
    this.#menu = menu;
    if (!menu) {
      this.#escapeLayer.deactivate();
      this.#openState = false;
    } else if (menu !== previous) {
      this.#menuHidden.write(menu, (previous?.hidden ?? true) ? "" : null);
    }
    this.#reflectTrigger();
  }

  /** Writes the open state onto the trigger that is first and names the menu from it. */
  #reflectTrigger(): void {
    if (!this.hasTriggerTarget) return;
    this.#expanded.write(this.triggerTarget, String(this.#isOpen));
    this.#associateTriggerWithMenu();
  }

  /** Writes the open state back onto the menu and the trigger, without reporting. */
  #repair(): void {
    if (!this.hasMenuTarget) return;
    this.#menuHidden.write(this.menuTarget, this.#openState ? null : "");
    this.#reflectTrigger();
  }

  /** Closes and restores focus to the trigger (the keyboard-dismissal path). */
  #closeAndRestore(): void {
    this.#close("escape");
    if (this.hasTriggerTarget) this.triggerTarget.focus();
  }

  /** Whether the menu is currently visible. */
  get #isOpen(): boolean {
    return this.hasMenuTarget && !this.menuTarget.hidden;
  }

  /**
   * Associates the disclosure trigger and controlled region without clobbering
   * authored markup: a trigger with no `aria-controls` is given the menu's id, and
   * one this instance gave it keeps naming the menu that is first.
   */
  #associateTriggerWithMenu(): void {
    if (!this.hasTriggerTarget || !this.hasMenuTarget) return;
    const trigger = this.triggerTarget;
    const controls = trigger.getAttribute("aria-controls");
    if (controls !== null && controls !== this.#suppliedControls.get(trigger)) return;
    const id = ensureId(this.menuTarget, "stimeo--dropdown-menu");
    if (controls === id) return;
    trigger.setAttribute("aria-controls", id);
    this.#suppliedControls.set(trigger, id);
  }

  /** Takes the `aria-controls` this instance supplied back off a trigger still carrying it. */
  #withdrawControls(trigger: HTMLElement): void {
    const supplied = this.#suppliedControls.get(trigger);
    this.#suppliedControls.delete(trigger);
    if (supplied !== undefined && trigger.getAttribute("aria-controls") === supplied) {
      trigger.removeAttribute("aria-controls");
    }
  }
}
