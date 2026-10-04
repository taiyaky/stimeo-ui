import { Controller } from "@hotwired/stimulus";
import { AttributeLease } from "../utils/attribute_lease";
import { FocusTrap } from "../utils/focus_trap";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";

/** The slice of Turbo's form config this controller swaps the confirm method on. */
interface TurboFormsConfig {
  confirm?: (
    message: string,
    form?: HTMLFormElement,
    submitter?: HTMLElement,
  ) => boolean | Promise<boolean>;
}
interface TurboLike {
  config?: { forms?: TurboFormsConfig };
}
/** The text one prompt shows: its message and the two button labels. */
interface Wording {
  readonly message: string;
  readonly confirm: string;
  readonly cancel: string;
}

/**
 * Headless **confirm bridge** — replaces the native `window.confirm()` Turbo uses
 * for `data-turbo-confirm` with an accessible **Alert Dialog** (WAI-ARIA APG Alert
 * Dialog pattern). Reuses the shared `FocusTrap`; the consumer only writes the
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
 * `open` dispatches `{ message }`; `resolve` dispatches `{ confirmed }`. An `open`
 * subscriber may settle the prompt at once; the dialog then stays closed with no modal
 * side effects. A prompt asked while the controller is disconnected, including one a
 * `resolve` subscriber asks while `disconnect()` settles the pending prompt, settles
 * `false` at once without opening the dialog or dispatching either event.
 * A pending prompt carries its trap and its text onto a dialog, message or button that
 * replaces the current one, and settles `false` when no dialog is left to answer it.
 *
 * @remarks
 * Behavior only — the dialog's a11y (focus trap, restore, roles) is delegated to
 * the shared `FocusTrap`; this controller adds the Turbo bridge and the
 * confirm/cancel resolution. On `connect()` it swaps `Turbo.config.forms.confirm`
 * for a Promise-returning method and restores the original on `disconnect()` (Turbo
 * navigation included), so registration never leaks or stacks; it does not ask again
 * for a submission a confirmed `request` continues. Escape cancels
 * (returns `false`); when no dialog target exists it degrades to native
 * `window.confirm`. The least-destructive button (cancel, by default) takes initial
 * focus. A Turbo morph that puts the server's markup back over an open prompt is answered
 * by writing the prompt back: the dialog is shown with its text.
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
  declare readonly dialogTargets: HTMLElement[];
  /**
   * Static heading slot naming the dialog (via `aria-labelledby`). Never written
   * by the controller — the accessible name is author-owned; only `message` and
   * the button labels are injected per prompt.
   */
  declare readonly titleTarget: HTMLElement;
  declare readonly messageTargets: HTMLElement[];
  declare readonly confirmTargets: HTMLElement[];
  declare readonly cancelTargets: HTMLElement[];
  declare readonly hasDialogTarget: boolean;

  declare confirmLabelValue: string;
  declare cancelLabelValue: string;
  declare initialFocusValue: string;

  /** Resolver for the in-flight confirmation Promise (one dialog at a time). */
  #pending: ((confirmed: boolean) => void) | null = null;
  /** Turbo's forms config and its original confirm method, for restore. */
  #turboForms: TurboFormsConfig | null = null;
  #previousConfirm: TurboFormsConfig["confirm"] = undefined;
  /** The form a confirmed request is submitting, while its `requestSubmit` runs. */
  #continuing: HTMLFormElement | null = null;
  /** Whether a prompt may open: set by `connect()`, cleared first thing in `disconnect()`. */
  #connected = false;
  /** Counts prompts asked, so one a later prompt overtook while it cancelled the previous stands down. */
  #asked = 0;
  /** The dialog the open state was last applied to. */
  #dialog: HTMLElement | null = null;
  /** Borrows `hidden` on each dialog, to give back when one stops being the target. */
  readonly #hidden = new AttributeLease<HTMLElement>("hidden", this.identifier);
  /** The open prompt's text, `null` while no prompt is pending (so whenever disconnected). */
  #wording: Wording | null = null;

  readonly #trap = new FocusTrap(() => this.dialogTarget, {
    onEscape: () => this.#resolve(false),
    initialFocus: () => this.#initialFocusElement(),
  });

  /** Writes the open prompt back after a Turbo morph put the server's markup in its place. */
  readonly #morphRender = new MorphRenderWatcher(() => this.#repair());

  override connect(): void {
    this.#trap.connect();
    this.#connected = true;
    if (this.hasDialogTarget) this.#hidden.write(this.dialogTarget, "");
    this.#dialog = this.hasDialogTarget ? this.dialogTarget : null;
    this.#installTurboHook();
    this.#morphRender.observe(this.element);
  }

  /**
   * Shows the dialog, with the prompt's text, while a prompt is pending and hides it
   * otherwise, silently: what a Turbo morph that put the server's markup in place of the
   * open prompt needs.
   */
  #repair(): void {
    if (!this.hasDialogTarget) return;
    this.#hidden.write(this.dialogTarget, this.#pending ? null : "");
    this.#applyWording();
  }

  override disconnect(): void {
    this.#connected = false;
    if (this.#turboForms) {
      this.#turboForms.confirm = this.#previousConfirm;
      this.#turboForms = null;
    }
    // Settle any pending confirmation as cancelled WITHOUT restoring focus: a Turbo
    // teardown must not move focus. The trap is active only while a confirmation is
    // pending, and a prompt its `resolve` subscriber asks during this call opens
    // nothing, so this releases every modal side effect; the trap then keeps or takes
    // back a tabindex it kept on a dialog that held focus, as the detach decides.
    this.#resolve(false, false);
    this.#trap.disconnect(this);
    this.#morphRender.disconnect();
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

  /** Writes the pending prompt's message into a message slot that arrives in front. */
  messageTargetConnected(): void {
    this.#applyWording();
  }

  /** Writes the pending prompt's message into the slot left when an earlier one leaves. */
  messageTargetDisconnected(): void {
    this.#applyWording();
  }

  /** Writes the pending prompt's confirm label into a button that arrives in front. */
  confirmTargetConnected(): void {
    this.#applyWording();
  }

  /** Writes the pending prompt's confirm label into the button left when an earlier one leaves. */
  confirmTargetDisconnected(): void {
    this.#applyWording();
  }

  /** Writes the pending prompt's cancel label into a button that arrives in front. */
  cancelTargetConnected(): void {
    this.#applyWording();
  }

  /** Writes the pending prompt's cancel label into the button left when an earlier one leaves. */
  cancelTargetDisconnected(): void {
    this.#applyWording();
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
   * Intercepts an element's action, shows the confirm dialog, and continues that
   * action only when confirmed: a link navigates to its `href`; a submit button
   * (`<button type="submit">`, `<input type="submit">`, `<input type="image">`)
   * submits its form with itself as the submitter, so its `name` / `value` and
   * `formaction` apply; a form, when this is bound to its `submit`, submits with the
   * submitter that started it. Any other element (`<button type="button">`, a reset
   * button, a `span`) submits nothing itself, so nothing is continued; `resolve` still
   * reports `{ confirmed }`. The submission goes through `requestSubmit`, so
   * validation, `submit` listeners and Turbo see it as the user's own, and this action
   * lets that `submit` through.
   *
   * The message is the `message` action param exactly as written, else the
   * `data-turbo-confirm` Turbo would ask with (for a submission, the submitter's, then
   * the form's); an empty param counts as absent.
   */
  request(event: Event): void {
    const element = (event.currentTarget ?? event.target) as HTMLElement | null;
    if (!element || element === this.#continuing) return;
    event.preventDefault();

    const submitter = (event as Partial<SubmitEvent>).submitter ?? null;
    void this.#prompt(this.#messageOf(element, submitter)).then((confirmed) => {
      if (confirmed) this.#continue(element, submitter);
    });
  }

  /**
   * Opens the dialog for `message` and resolves once the user confirms or cancels.
   * Degrades to native `window.confirm` when no dialog target is present.
   *
   * @stimeoRuntimeOnly The labels word the one dialog this call opens; every opening writes both
   *   labels again, and the dialog stays hidden between prompts.
   */
  #prompt(message: string): Promise<boolean> {
    // A controller that is not connected asks nothing: no dialog, no events, cancelled.
    if (!this.#connected) return Promise.resolve(false);
    if (!this.hasDialogTarget) return Promise.resolve(window.confirm(message));
    const asked = ++this.#asked;
    // A second prompt while one is open cancels the first to keep a single dialog.
    this.#resolve(false);
    // A `resolve` subscriber of the cancelled prompt may have asked a newer one, which
    // now owns the dialog; this prompt settles cancelled without opening.
    if (asked !== this.#asked) return Promise.resolve(false);

    this.#wording = { message, confirm: this.confirmLabelValue, cancel: this.cancelLabelValue };
    this.#applyWording();

    return new Promise<boolean>((resolve) => {
      this.#pending = resolve;
      this.#hidden.write(this.dialogTarget, null);
      this.dispatch("open", { detail: { message } });
      // An `open` subscriber may have settled it; a trap activated now is never released.
      if (this.#pending !== resolve) return;
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
    this.#wording = null;

    if (this.hasDialogTarget) this.#hidden.write(this.dialogTarget, "");
    this.#trap.deactivate({ restoreFocus });
    this.dispatch("resolve", { detail: { confirmed } });
    pending(confirmed);
  }

  /**
   * Writes the pending prompt's text into the first message slot and buttons inside the
   * dialog; while no prompt is pending, the page's text stands.
   */
  #applyWording(): void {
    const wording = this.#wording;
    if (!wording) return;
    this.#word(this.messageTargets, wording.message);
    this.#word(this.confirmTargets, wording.confirm);
    this.#word(this.cancelTargets, wording.cancel);
  }

  /** Writes `text` into the first of `targets` inside the dialog, when there is one. */
  #word(targets: HTMLElement[], text: string): void {
    const slot = this.#inDialog(targets);
    if (slot) slot.textContent = text;
  }

  /**
   * The first of `targets` inside the dialog, or `null`: a slot the page left outside it, or
   * inside a dialog that only lost its target token, is not this prompt's.
   */
  #inDialog(targets: HTMLElement[]): HTMLElement | null {
    if (!this.hasDialogTarget) return null;
    const dialog = this.dialogTarget;
    return targets.find((element) => dialog.contains(element)) ?? null;
  }

  /**
   * Applies the open state to the dialog that is now first, when that dialog changed. With a
   * prompt pending, its text is written into that dialog's slots and the modal trap moves onto
   * it, keeping the trap's place among the page's modals and the opener focus returns to; focus
   * moves inside unless it is already there or a modal opened over this one takes `Tab`. A
   * pending prompt left with no dialog settles as cancelled, as
   * {@link ConfirmController.cancel | cancel} would.
   */
  #adoptDialog(): void {
    const dialog = this.hasDialogTarget ? this.dialogTarget : null;
    if (dialog === this.#dialog) return;
    this.#dialog = dialog;
    if (!this.#pending) {
      if (dialog) this.#hidden.write(dialog, "");
      return;
    }
    if (!dialog) {
      this.#resolve(false);
      return;
    }
    this.#hidden.write(dialog, null);
    this.#applyWording();
    this.#trap.refreshContainer();
  }

  /**
   * The `message` action param as written, else `data-turbo-confirm` on the submitter
   * (or `element`), then on the form it submits. Not `event.params`: Stimulus parses it
   * as JSON.
   */
  #messageOf(element: HTMLElement, submitter: HTMLElement | null): string {
    return (
      element.getAttribute(`data-${this.identifier}-message-param`) ||
      (submitter ?? element).getAttribute("data-turbo-confirm") ||
      ConfirmController.#formOf(element)?.getAttribute("data-turbo-confirm") ||
      ""
    );
  }

  /** Continues the intercepted action; {@link ConfirmController.request | request} lists which. */
  #continue(element: HTMLElement, submitter: HTMLElement | null): void {
    if (element instanceof HTMLAnchorElement && element.href) {
      window.location.href = element.href;
      return;
    }
    const form = ConfirmController.#formOf(element);
    if (form) this.#submit(form, element === form ? submitter : element);
  }

  /** The form `element` submits: itself, a submit button's form owner, or none. */
  static #formOf(element: HTMLElement): HTMLFormElement | null {
    if (element instanceof HTMLFormElement) return element;
    return ConfirmController.#isSubmitButton(element) ? element.form : null;
  }

  /**
   * Submits `form` with `submitter` when it is one of the form's submit buttons
   * (`requestSubmit` throws for any other element). The `submit` fires synchronously,
   * so the pass through `request` lasts only for this call.
   */
  #submit(form: HTMLFormElement, submitter: HTMLElement | null): void {
    const button =
      ConfirmController.#isSubmitButton(submitter) && submitter.form === form
        ? submitter
        : undefined;
    this.#continuing = form;
    try {
      form.requestSubmit(button);
    } finally {
      this.#continuing = null;
    }
  }

  /** Whether `element` is a submit button (`button[type=submit]`, `input[type=submit|image]`). */
  static #isSubmitButton(element: Element | null): element is HTMLButtonElement | HTMLInputElement {
    if (element instanceof HTMLButtonElement) return element.type === "submit";
    return (
      element instanceof HTMLInputElement && (element.type === "submit" || element.type === "image")
    );
  }

  /** Swaps Turbo's confirm method for a Promise-returning bridge to this dialog. */
  #installTurboHook(): void {
    const turbo = (window as Window & { Turbo?: TurboLike }).Turbo;
    const forms = turbo?.config?.forms;
    if (!forms) return;
    this.#turboForms = forms;
    this.#previousConfirm = forms.confirm;
    forms.confirm = (message: string, form?: HTMLFormElement) => this.#askForTurbo(message, form);
  }

  /**
   * Turbo's confirm method. Turbo asks it inside `requestSubmit`, so a submission a
   * confirmed request continues arrives already confirmed.
   */
  #askForTurbo(message: string, form?: HTMLFormElement): Promise<boolean> {
    if (this.#continuing && form === this.#continuing) return Promise.resolve(true);
    return this.#prompt(message);
  }

  /** The button inside the dialog to focus on open: the least-destructive (cancel) by default. */
  #initialFocusElement(): HTMLElement | null {
    const confirm =
      this.initialFocusValue === "confirm" ? this.#inDialog(this.confirmTargets) : null;
    return confirm ?? this.#inDialog(this.cancelTargets);
  }
}
