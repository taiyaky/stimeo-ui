import { Controller } from "@hotwired/stimulus";
import { FocusTrap } from "../utils/focus_trap";

/** Reason carried by the `cancel` event: an explicit cancel vs. the Escape key. */
type CancelReason = "user" | "escape";

/**
 * Headless, accessible **alert dialog** behavior.
 *
 * Markup contract (identifier: `stimeo--alert-dialog`):
 *   <div data-controller="stimeo--alert-dialog">
 *     <button data-stimeo--alert-dialog-target="trigger"
 *             data-action="click->stimeo--alert-dialog#open">Delete…</button>
 *     <div data-stimeo--alert-dialog-target="dialog" role="alertdialog"
 *          aria-modal="true" aria-labelledby="t" aria-describedby="d" hidden>
 *       <h2 id="t">…</h2><p id="d">…</p>
 *       <button data-stimeo--alert-dialog-target="initialFocus"
 *               data-action="click->stimeo--alert-dialog#cancel">Cancel</button>
 *       <button data-action="click->stimeo--alert-dialog#confirm">Delete</button>
 *     </div>
 *   </div>
 *
 * Implements the WAI-ARIA APG **Alert Dialog** pattern. It is the same modal as
 * `stimeo--dialog` with two deliberate differences that suit an *interrupting
 * confirmation*: it never closes on a backdrop click (an accidental dismissal
 * would be dangerous), and it exposes explicit {@link confirm}/{@link cancel}
 * actions that emit events so the consumer only writes the message and "what to
 * do on confirm".
 *
 * @remarks
 * Behavior only. The modal lifecycle (focus trap, scroll lock, background
 * `inert`, focus restore, teardown reversal) is delegated to the shared
 * {@link FocusTrap}. The only closing affordances are the confirm/cancel actions
 * and `Escape` (which cancels) — there is intentionally no backdrop close.
 *
 * Behavior provided:
 * - {@link open} shows the dialog and moves focus to the `initialFocus` target
 *   (the least destructive action, by convention), else the first focusable
 *   element.
 * - `Tab`/`Shift+Tab` cycle focus within the dialog (focus trap).
 * - {@link confirm} closes and dispatches `stimeo--alert-dialog:confirm`.
 * - {@link cancel} and `Escape` close and dispatch `stimeo--alert-dialog:cancel`
 *   with a `reason` of `"user"` / `"escape"`. Focus returns to the opener.
 */
export class AlertDialogController extends Controller<HTMLElement> {
  static override targets = ["trigger", "dialog", "initialFocus"];
  static actions = ["cancel", "confirm", "open"] as const;
  static events = ["cancel", "confirm"] as const;

  declare readonly triggerTarget: HTMLElement;
  declare readonly dialogTarget: HTMLElement;
  declare readonly initialFocusTarget: HTMLElement;
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasDialogTarget: boolean;
  declare readonly hasInitialFocusTarget: boolean;

  /**
   * Owns the modal side effects. Escape is routed through {@link cancel} so it
   * emits the same event as the cancel button (tagged `"escape"`); focus falls
   * back to the trigger when nothing was focused before opening.
   */
  readonly #trap = new FocusTrap(() => this.dialogTarget, {
    onEscape: () => this.#requestCancel("escape"),
    initialFocus: () => (this.hasInitialFocusTarget ? this.initialFocusTarget : null),
    fallbackFocus: () => (this.hasTriggerTarget ? this.triggerTarget : null),
  });

  /** Starts closed (idempotently reflects the closed state on the markup). */
  override connect(): void {
    if (this.hasDialogTarget) this.dialogTarget.hidden = true;
  }

  /** Reverts the modal side effects if torn down while open (Turbo navigation). */
  override disconnect(): void {
    this.#trap.deactivate({ restoreFocus: false });
  }

  /** Opens the dialog, traps focus, and locks background scroll. */
  open(): void {
    if (!this.hasDialogTarget || this.#isOpen) return;
    this.dialogTarget.hidden = false;
    this.#trap.activate();
  }

  /** Confirms: closes and dispatches `confirm`. Bound via `data-action`. */
  confirm(): void {
    if (!this.#isOpen) return;
    this.dispatch("confirm");
    this.#closeDialog();
  }

  /** Cancels (user action): closes and dispatches `cancel` with `reason: "user"`. */
  cancel(): void {
    this.#requestCancel("user");
  }

  /** Shared cancel path used by both the cancel action and the Escape key. */
  #requestCancel(reason: CancelReason): void {
    if (!this.#isOpen) return;
    this.dispatch("cancel", { detail: { reason } });
    this.#closeDialog();
  }

  /** Hides the dialog and reverts the modal side effects (restoring focus). */
  #closeDialog(): void {
    this.dialogTarget.hidden = true;
    this.#trap.deactivate();
  }

  /** Whether the dialog is currently visible. */
  get #isOpen(): boolean {
    return this.hasDialogTarget && !this.dialogTarget.hidden;
  }
}
