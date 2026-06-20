import { Controller } from "@hotwired/stimulus";

/**
 * Headless, accessible dropdown menu behavior.
 *
 * Markup contract (identifier: `stimeo--dropdown`):
 *   <div data-controller="stimeo--dropdown">
 *     <button data-stimeo--dropdown-target="trigger"
 *             data-action="stimeo--dropdown#toggle">Menu</button>
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
 * - Click the trigger to toggle the menu (`aria-expanded` + `hidden` reflect state).
 * - `Escape` closes the menu and returns focus to the trigger.
 * - A click outside the controller element closes the menu.
 */
export class DropdownController extends Controller<HTMLElement> {
  static override targets = ["trigger", "menu"];
  static actions = ["close", "open", "toggle"] as const;

  declare readonly triggerTarget: HTMLButtonElement;
  declare readonly menuTarget: HTMLElement;
  declare readonly hasMenuTarget: boolean;
  declare readonly hasTriggerTarget: boolean;

  /** Closes the menu when a click lands outside the controller's element. */
  readonly #onOutsideClick = (event: MouseEvent): void => {
    if (!this.element.contains(event.target as Node)) {
      this.close();
    }
  };

  /** Closes the menu on `Escape` and restores focus to the trigger. */
  readonly #onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.#isOpen) {
      this.close();
      if (this.hasTriggerTarget) this.triggerTarget.focus();
    }
  };

  /**
   * Starts in the closed state and registers the document-level listeners that
   * power outside-click and `Escape` handling.
   */
  override connect(): void {
    this.close();
    document.addEventListener("click", this.#onOutsideClick);
    document.addEventListener("keydown", this.#onKeydown);
  }

  /** Removes the document-level listeners registered in {@link connect}. */
  override disconnect(): void {
    document.removeEventListener("click", this.#onOutsideClick);
    document.removeEventListener("keydown", this.#onKeydown);
  }

  /** Toggles the menu between open and closed. Bound via `data-action`. */
  toggle(): void {
    if (this.#isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  /** Reveals the menu and reflects the open state on the trigger. */
  open(): void {
    if (!this.hasMenuTarget) return;
    this.menuTarget.hidden = false;
    if (this.hasTriggerTarget) {
      this.triggerTarget.setAttribute("aria-expanded", "true");
    }
  }

  /** Hides the menu and reflects the closed state on the trigger. */
  close(): void {
    if (!this.hasMenuTarget) return;
    this.menuTarget.hidden = true;
    if (this.hasTriggerTarget) {
      this.triggerTarget.setAttribute("aria-expanded", "false");
    }
  }

  /** Whether the menu is currently visible. */
  get #isOpen(): boolean {
    return this.hasMenuTarget && !this.menuTarget.hidden;
  }
}
