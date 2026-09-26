import { Controller } from "@hotwired/stimulus";
import { FocusTrap } from "../utils/focus_trap";
import { type StateReason, stateReasonFor } from "../utils/state_reason";

/**
 * Headless, accessible modal dialog behavior.
 *
 * Markup contract (identifier: `stimeo--dialog`):
 *   <div data-controller="stimeo--dialog">
 *     <button data-stimeo--dialog-target="trigger"
 *             data-action="click->stimeo--dialog#open">Open</button>
 *     <div data-stimeo--dialog-target="dialog" role="dialog" aria-modal="true"
 *          aria-labelledby="title" hidden>
 *       <h2 id="title">…</h2>
 *       <button data-action="click->stimeo--dialog#close">Close</button>
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
 * restore, and teardown reversal — is delegated to the shared `FocusTrap`
 * primitive (also used by `stimeo--alert-dialog` and `stimeo--drawer`). This controller only owns
 * *when* to open/close and the dialog-specific backdrop click.
 *
 * Each move of the open state is reported: `stimeo--dialog:open` and
 * `stimeo--dialog:close` dispatch `{ reason: StateReason }`, after the dialog's
 * `hidden` attribute is written and before focus moves. Both are informational,
 * so neither is cancelable. A call that leaves the state where it already was,
 * the normalization in {@link connect}, and {@link disconnect} are all silent.
 */
export class DialogController extends Controller<HTMLElement> {
  static override targets = ["trigger", "dialog"];
  static actions = ["close", "closeOnBackdrop", "open"] as const;
  static events = ["close", "open"] as const;

  declare readonly triggerTarget: HTMLElement;
  declare readonly dialogTarget: HTMLElement;
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasDialogTarget: boolean;

  /** Owns the modal side effects; Escape closes, focus falls back to the trigger. */
  readonly #trap = new FocusTrap(() => this.dialogTarget, {
    onEscape: () => this.#close("escape"),
    fallbackFocus: () => (this.hasTriggerTarget ? this.triggerTarget : null),
  });

  /** Whether state moves are reported: set once `connect()` settled the baseline. */
  #reporting = false;

  /** Starts closed (idempotently reflects the closed state on the markup). */
  override connect(): void {
    if (this.hasDialogTarget) this.dialogTarget.hidden = true;
    this.#reporting = true;
  }

  /**
   * Reverts the modal side effects (scroll lock, background `inert`, keydown
   * listener) if the controller is torn down while open (e.g. a Turbo navigation
   * replaces the page while the dialog is showing). Focus is not restored on
   * teardown.
   */
  override disconnect(): void {
    this.#reporting = false;
    this.#trap.deactivate({ restoreFocus: false });
  }

  /** Opens the dialog, traps focus, and locks background scroll. */
  open(event?: Event): void {
    this.#open(stateReasonFor(event));
  }

  /** Closes the dialog, restores scroll, and returns focus to the opener. */
  close(event?: Event): void {
    this.#close(stateReasonFor(event));
  }

  /** Closes when the backdrop (the dialog target itself) is clicked. */
  closeOnBackdrop(event: MouseEvent): void {
    if (event.target === this.dialogTarget) this.#close("outside");
  }

  /** Reveals the dialog, reports a move, then traps focus and locks scroll. */
  #open(reason: StateReason): void {
    if (!this.hasDialogTarget || this.#isOpen) return;
    this.dialogTarget.hidden = false;
    if (this.#reporting) this.dispatch("open", { detail: { reason }, cancelable: false });
    // A subscriber may close it again from the handler above. Everything below
    // applies to an element that is open; run it against a closed one and the
    // side effects have no path back — the later `close()` returns early.
    if (!this.#isOpen) return;
    this.#trap.activate();
  }

  /** Hides the dialog, reports a move, then restores scroll and focus. */
  #close(reason: StateReason): void {
    if (!this.hasDialogTarget || !this.#isOpen) return;
    this.dialogTarget.hidden = true;
    if (this.#reporting) this.dispatch("close", { detail: { reason }, cancelable: false });
    // A subscriber may reopen it from the handler above, in which case the trap it
    // just activated is the live one — tearing it down here would strip the modal
    // side effects off a dialog that is on screen.
    if (this.#isOpen) return;
    this.#trap.deactivate();
  }

  /** Whether the dialog is currently visible. */
  get #isOpen(): boolean {
    return this.hasDialogTarget && !this.dialogTarget.hidden;
  }
}
