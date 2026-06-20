import { Controller } from "@hotwired/stimulus";
import { FocusTrap } from "../utils/focus_trap";

/**
 * Headless, accessible modal dialog behavior.
 *
 * Markup contract (identifier: `stimeo--dialog`):
 *   <div data-controller="stimeo--dialog">
 *     <button data-stimeo--dialog-target="trigger"
 *             data-action="stimeo--dialog#open">Open</button>
 *     <div data-stimeo--dialog-target="dialog" role="dialog" aria-modal="true"
 *          aria-labelledby="title" hidden>
 *       <h2 id="title">…</h2>
 *       <button data-action="stimeo--dialog#close">Close</button>
 *     </div>
 *   </div>
 *
 * Implements the WAI-ARIA APG **Dialog (Modal)** pattern: focus moves into the
 * dialog on open and is trapped within it, `Escape` closes it, background scroll
 * is locked, and focus returns to the trigger on close.
 *
 * @remarks
 * Behavior only. The sole visual side effect is locking `document.body`'s scroll
 * while open (the minimum required by the pattern); all other styling is the
 * consumer's. Clicking the dialog backdrop (the dialog target itself, outside
 * its content) also closes it.
 *
 * The modal lifecycle — focus trap, scroll lock, background `inert`, focus
 * restore, and teardown reversal — is delegated to the shared {@link FocusTrap}
 * primitive (also used by alert-dialog and drawer). This controller only owns
 * *when* to open/close and the dialog-specific backdrop click.
 */
export class DialogController extends Controller<HTMLElement> {
  static override targets = ["trigger", "dialog"];
  static actions = ["close", "closeOnBackdrop", "open"] as const;

  declare readonly triggerTarget: HTMLElement;
  declare readonly dialogTarget: HTMLElement;
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasDialogTarget: boolean;

  /** Owns the modal side effects; Escape closes, focus falls back to the trigger. */
  readonly #trap = new FocusTrap(() => this.dialogTarget, {
    onEscape: () => this.close(),
    fallbackFocus: () => (this.hasTriggerTarget ? this.triggerTarget : null),
  });

  /** Starts closed (idempotently reflects the closed state on the markup). */
  override connect(): void {
    if (this.hasDialogTarget) this.dialogTarget.hidden = true;
  }

  /**
   * Reverts the modal side effects (scroll lock, background `inert`, keydown
   * listener) if the controller is torn down while open (e.g. a Turbo navigation
   * replaces the page while the dialog is showing). Focus is not restored on
   * teardown.
   */
  override disconnect(): void {
    this.#trap.deactivate({ restoreFocus: false });
  }

  /** Opens the dialog, traps focus, and locks background scroll. */
  open(): void {
    if (!this.hasDialogTarget || this.#isOpen) return;
    this.dialogTarget.hidden = false;
    this.#trap.activate();
  }

  /** Closes the dialog, restores scroll, and returns focus to the opener. */
  close(): void {
    if (!this.hasDialogTarget || !this.#isOpen) return;
    this.dialogTarget.hidden = true;
    this.#trap.deactivate();
  }

  /** Closes when the backdrop (the dialog target itself) is clicked. */
  closeOnBackdrop(event: MouseEvent): void {
    if (event.target === this.dialogTarget) this.close();
  }

  /** Whether the dialog is currently visible. */
  get #isOpen(): boolean {
    return this.hasDialogTarget && !this.dialogTarget.hidden;
  }
}
