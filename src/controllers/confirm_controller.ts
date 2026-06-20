import { Controller } from "@hotwired/stimulus";
import { FocusTrap } from "../utils/focus_trap";

/** The slice of Turbo's form config this controller swaps the confirm method on. */
interface TurboFormsConfig {
  confirm?: (message: string, element?: HTMLElement) => boolean | Promise<boolean>;
}
interface TurboLike {
  config?: { forms?: TurboFormsConfig };
}

/**
 * Headless **confirm bridge** — replaces the native `window.confirm()` Turbo uses
 * for `data-turbo-confirm` with an accessible **Alert Dialog** (WAI-ARIA APG Alert
 * Dialog pattern). Reuses the shared {@link FocusTrap}; the consumer only writes the
 * dialog markup and "what to do on confirm".
 *
 * Markup contract (identifier: `stimeo--confirm`):
 *   <div data-controller="stimeo--confirm">
 *     <div data-stimeo--confirm-target="dialog" role="alertdialog" aria-modal="true"
 *          aria-labelledby="ct" aria-describedby="cm" hidden>
 *       <h2 id="ct" data-stimeo--confirm-target="title">Are you sure?</h2>
 *       <p id="cm" data-stimeo--confirm-target="message"></p>
 *       <button data-stimeo--confirm-target="cancel"
 *               data-action="click->stimeo--confirm#cancel"></button>
 *       <button data-stimeo--confirm-target="confirm"
 *               data-action="click->stimeo--confirm#confirm"></button>
 *     </div>
 *   </div>
 *
 *   <!-- Driven automatically through Turbo's confirm hook: -->
 *   <form data-turbo-confirm="Delete this item?" action="/items/1" method="post">…</form>
 *   <!-- Or intercept any link/button directly: -->
 *   <a href="/items/1" data-action="click->stimeo--confirm#request"
 *      data-stimeo--confirm-message-param="Delete this item?">Delete</a>
 *
 * @remarks
 * Behavior only — the dialog's a11y (focus trap, restore, roles) is delegated to
 * the shared {@link FocusTrap}; this controller adds the Turbo bridge and the
 * confirm/cancel resolution. On `connect()` it swaps `Turbo.config.forms.confirm`
 * for a Promise-returning method and restores the original on `disconnect()` (Turbo
 * navigation included), so registration never leaks or stacks. Escape cancels
 * (returns `false`); when no dialog target exists it degrades to native
 * `window.confirm`. The least-destructive button (cancel, by default) takes initial
 * focus.
 */
export class ConfirmController extends Controller<HTMLElement> {
  static override targets = ["dialog", "title", "message", "confirm", "cancel"];
  static override values = {
    confirmLabel: { type: String, default: "OK" },
    cancelLabel: { type: String, default: "Cancel" },
    initialFocus: { type: String, default: "cancel" },
  };
  static actions = ["confirm", "cancel", "request"] as const;
  static events = ["open", "resolve"] as const;

  declare readonly dialogTarget: HTMLElement;
  declare readonly titleTarget: HTMLElement;
  declare readonly messageTarget: HTMLElement;
  declare readonly confirmTarget: HTMLElement;
  declare readonly cancelTarget: HTMLElement;
  declare readonly hasDialogTarget: boolean;
  declare readonly hasMessageTarget: boolean;
  declare readonly hasConfirmTarget: boolean;
  declare readonly hasCancelTarget: boolean;

  declare confirmLabelValue: string;
  declare cancelLabelValue: string;
  declare initialFocusValue: string;

  /** Resolver for the in-flight confirmation Promise (one dialog at a time). */
  #pending: ((confirmed: boolean) => void) | null = null;
  /** Turbo's forms config and its original confirm method, for restore. */
  #turboForms: TurboFormsConfig | null = null;
  #previousConfirm: TurboFormsConfig["confirm"] = undefined;

  readonly #trap = new FocusTrap(() => this.dialogTarget, {
    onEscape: () => this.#resolve(false),
    initialFocus: () => this.#initialFocusElement(),
  });

  override connect(): void {
    if (this.hasDialogTarget) this.dialogTarget.hidden = true;
    this.#installTurboHook();
  }

  override disconnect(): void {
    if (this.#turboForms) {
      this.#turboForms.confirm = this.#previousConfirm;
      this.#turboForms = null;
    }
    // Settle any pending confirmation as cancelled WITHOUT restoring focus: a Turbo
    // teardown must not move focus. The trailing deactivate covers the (defensive)
    // case where the trap is active with nothing pending.
    this.#resolve(false, false);
    this.#trap.deactivate({ restoreFocus: false });
  }

  /** Confirms the pending request (resolves `true`). Bound via `data-action`. */
  confirm(): void {
    this.#resolve(true);
  }

  /** Cancels the pending request (resolves `false`). Bound via `data-action`. */
  cancel(): void {
    this.#resolve(false);
  }

  /**
   * Intercepts a link/button click, shows the confirm dialog, and continues the
   * original action (form submit or navigation) only when confirmed. The message
   * comes from the `message` action param or the element's `data-turbo-confirm`.
   */
  request(event: Event): void {
    const element = (event.currentTarget ?? event.target) as HTMLElement | null;
    if (!element) return;
    event.preventDefault();

    const params = (event as { params?: Record<string, unknown> }).params;
    const fromParam = typeof params?.message === "string" ? params.message : null;
    const message = fromParam ?? element.getAttribute("data-turbo-confirm") ?? "";

    void this.#prompt(message).then((confirmed) => {
      if (confirmed) this.#continue(element);
    });
  }

  /**
   * Opens the dialog for `message` and resolves once the user confirms or cancels.
   * Degrades to native `window.confirm` when no dialog target is present.
   */
  #prompt(message: string): Promise<boolean> {
    if (!this.hasDialogTarget) return Promise.resolve(window.confirm(message));
    // A second prompt while one is open cancels the first to keep a single dialog.
    this.#resolve(false);

    if (this.hasMessageTarget) this.messageTarget.textContent = message;
    if (this.hasConfirmTarget) this.confirmTarget.textContent = this.confirmLabelValue;
    if (this.hasCancelTarget) this.cancelTarget.textContent = this.cancelLabelValue;

    return new Promise<boolean>((resolve) => {
      this.#pending = resolve;
      this.dialogTarget.hidden = false;
      this.dispatch("open", { detail: { message } });
      this.#trap.activate();
    });
  }

  /**
   * Settles the pending Promise, closes the dialog, and emits `resolve`.
   * `restoreFocus` is forwarded to the trap so teardown (disconnect) can settle a
   * pending confirmation without moving focus.
   */
  #resolve(confirmed: boolean, restoreFocus = true): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;

    if (this.hasDialogTarget) this.dialogTarget.hidden = true;
    this.#trap.deactivate({ restoreFocus });
    this.dispatch("resolve", { detail: { confirmed } });
    pending(confirmed);
  }

  /** Continues the intercepted action when confirmed: submit a form, else navigate. */
  #continue(element: HTMLElement): void {
    if (element instanceof HTMLAnchorElement && element.href) {
      window.location.href = element.href;
      return;
    }
    const form = element instanceof HTMLFormElement ? element : element.closest("form");
    if (form) {
      form.requestSubmit(element instanceof HTMLButtonElement ? element : undefined);
    }
  }

  /** Swaps Turbo's confirm method for a Promise-returning bridge to this dialog. */
  #installTurboHook(): void {
    const turbo = (window as Window & { Turbo?: TurboLike }).Turbo;
    const forms = turbo?.config?.forms;
    if (!forms) return;
    this.#turboForms = forms;
    this.#previousConfirm = forms.confirm;
    forms.confirm = (message: string) => this.#prompt(message);
  }

  /** The button to focus on open — the least-destructive one (cancel) by default. */
  #initialFocusElement(): HTMLElement | null {
    if (this.initialFocusValue === "confirm" && this.hasConfirmTarget) return this.confirmTarget;
    return this.hasCancelTarget ? this.cancelTarget : null;
  }
}
