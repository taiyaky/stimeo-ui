import { Controller } from "@hotwired/stimulus";
import { ensureId } from "../utils/aria_ids";
import { claimsWhileFocusWithin, EscapeLayer } from "../utils/escape_layer";
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
 * - Each move of the open state is reported: `stimeo--dropdown:open` and
 *   `stimeo--dropdown:close` dispatch `{ reason: StateReason }`, after the
 *   attributes above are written. Both are informational, so neither is
 *   cancelable. A call that leaves the state where it already was, the
 *   normalization in {@link connect}, and {@link disconnect} are all silent.
 */
export class DropdownController extends Controller<HTMLElement> {
  static override targets = ["trigger", "menu"];
  static actions = ["close", "open", "toggle"] as const;
  static events = ["close", "open"] as const;

  declare readonly triggerTarget: HTMLButtonElement;
  declare readonly menuTarget: HTMLElement;
  declare readonly hasMenuTarget: boolean;
  declare readonly hasTriggerTarget: boolean;

  /** Escape-stack membership while open; the shared resolver dismisses via it. */
  readonly #escapeLayer = new EscapeLayer();

  /** Whether state moves are reported: set once `connect()` settled the baseline. */
  #reporting = false;

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
    this.#reporting = true;
  }

  /** Removes the listeners registered in {@link connect}. */
  override disconnect(): void {
    this.#reporting = false;
    this.#escapeLayer.deactivate();
    document.removeEventListener("click", this.#onOutsideClick, true);
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
    const was = this.#isOpen;
    this.#escapeLayer.activate(document, {
      onDismiss: () => this.#closeAndRestore(),
      claims: claimsWhileFocusWithin(this.element),
    });
    this.menuTarget.hidden = false;
    if (this.hasTriggerTarget) {
      this.triggerTarget.setAttribute("aria-expanded", "true");
    }
    if (!was && this.#reporting) this.dispatch("open", { detail: { reason }, cancelable: false });
  }

  /** Hides the menu, reflects the closed state, and reports a move. */
  #close(reason: StateReason): void {
    const was = this.#isOpen;
    this.#escapeLayer.deactivate();
    if (!this.hasMenuTarget) return;
    this.menuTarget.hidden = true;
    if (this.hasTriggerTarget) {
      this.triggerTarget.setAttribute("aria-expanded", "false");
    }
    if (was && this.#reporting) this.dispatch("close", { detail: { reason }, cancelable: false });
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
   * authored markup.
   */
  #associateTriggerWithMenu(): void {
    if (!this.hasTriggerTarget || !this.hasMenuTarget) return;
    if (this.triggerTarget.hasAttribute("aria-controls")) return;

    this.triggerTarget.setAttribute(
      "aria-controls",
      ensureId(this.menuTarget, "stimeo--dropdown-menu"),
    );
  }
}
