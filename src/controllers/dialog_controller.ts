import { Controller } from "@hotwired/stimulus";
import { AttributeLease } from "../utils/attribute_lease";
import { FocusTrap } from "../utils/focus_trap";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
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
 * the normalization in {@link connect}, the reconciliation that follows dialog
 * churn, and {@link disconnect} are all silent. A Turbo morph that puts the
 * server's `hidden` back on an open dialog, or takes it off a closed one, is
 * answered by writing the open state back, silently.
 */
export class DialogController extends Controller<HTMLElement> {
  static override targets = ["trigger", "dialog"];
  static actions = ["close", "closeOnBackdrop", "open"] as const;
  static events = ["close", "open"] as const;

  declare readonly triggerTarget: HTMLElement;
  declare readonly dialogTarget: HTMLElement;
  declare readonly dialogTargets: HTMLElement[];
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasDialogTarget: boolean;

  /** Owns the modal side effects; Escape closes, focus falls back to the trigger. */
  readonly #trap = new FocusTrap(() => this.dialogTarget, {
    onEscape: () => this.#close("escape"),
    fallbackFocus: () => (this.hasTriggerTarget ? this.triggerTarget : null),
  });

  /** Whether state moves are reported: set once `connect()` settled the baseline. */
  #reporting = false;
  /** Whether dialog churn is applied: set by `connect()`, cleared first thing in `disconnect()`. */
  #connected = false;
  /** The dialog the open state was last applied to. */
  #dialog: HTMLElement | null = null;
  /** Borrows `hidden` on each dialog, to give back when one stops being the target. */
  readonly #hidden = new AttributeLease<HTMLElement>("hidden", this.identifier);
  /** Writes the open state back after a Turbo morph put the server's `hidden` in its place. */
  readonly #morphRender = new MorphRenderWatcher(() => this.#repair());

  /** Starts closed (idempotently reflects the closed state on the markup). */
  override connect(): void {
    this.#trap.connect();
    this.#connected = true;
    if (this.hasDialogTarget) this.#hidden.write(this.dialogTarget, "");
    this.#dialog = this.hasDialogTarget ? this.dialogTarget : null;
    this.#reporting = true;
    this.#morphRender.observe(this.element);
  }

  /**
   * Reverts the modal side effects (scroll lock, background `inert`, keydown
   * listener) if the controller is torn down while open (e.g. a Turbo navigation
   * replaces the page while the dialog is showing). Focus is not restored on
   * teardown.
   */
  override disconnect(): void {
    this.#morphRender.disconnect();
    this.#connected = false;
    this.#reporting = false;
    this.#trap.disconnect(this);
  }

  /** Shows the dialog while its trap is active and hides it otherwise. */
  #repair(): void {
    if (this.hasDialogTarget) this.#hidden.write(this.dialogTarget, this.#trap.active ? null : "");
  }

  /** Applies the open state to a dialog that arrives after connect in front of the others. */
  dialogTargetConnected(): void {
    if (this.#connected) this.#adoptDialog();
  }

  /**
   * Gives a dialog that no longer resolves as the target its own `hidden` back — after
   * `disconnect()` too, since dropping the identifier leaves the element on the page — and,
   * while connected, applies the open state to the dialog left.
   */
  dialogTargetDisconnected(dialog: HTMLElement): void {
    if (this.dialogTargets.includes(dialog)) return;
    this.#hidden.return(dialog);
    if (this.#connected) this.#adoptDialog();
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
    this.#hidden.write(this.dialogTarget, null);
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
    this.#hidden.write(this.dialogTarget, "");
    if (this.#reporting) this.dispatch("close", { detail: { reason }, cancelable: false });
    // A subscriber may reopen it from the handler above, in which case the trap it
    // just activated is the live one — tearing it down here would strip the modal
    // side effects off a dialog that is on screen.
    if (this.#isOpen) return;
    this.#trap.deactivate();
  }

  /**
   * Applies the open state to the dialog that is now first, when that dialog changed. An
   * open dialog moves its modal trap onto it, keeping the trap's place among the page's modals
   * and the opener focus returns to; focus moves inside unless it is already there or a modal
   * opened over this one takes `Tab`. An open dialog left with no dialog closes. Both are silent.
   */
  #adoptDialog(): void {
    const dialog = this.hasDialogTarget ? this.dialogTarget : null;
    if (dialog === this.#dialog) return;
    this.#dialog = dialog;
    if (!this.#trap.active) {
      if (dialog) this.#hidden.write(dialog, "");
      return;
    }
    if (!dialog) {
      this.#trap.deactivate();
      return;
    }
    this.#hidden.write(dialog, null);
    this.#trap.refreshContainer();
  }

  /** Whether the dialog is currently visible. */
  get #isOpen(): boolean {
    return this.hasDialogTarget && !this.dialogTarget.hidden;
  }
}
