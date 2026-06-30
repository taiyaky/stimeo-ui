import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";

/** Submit-capable controls this controller can disable. */
type SubmitButton = HTMLButtonElement | HTMLInputElement;

/** Attribute the original label is parked in while busy (survives a cache restore). */
const ORIGINAL_LABEL = "data-submit-once-original-label";
/** Marker on buttons this controller disabled (so we never re-enable authored-disabled ones). */
const DISABLED_MARKER = "data-submit-once-disabled";
/** Per-button override for the busy label (a plain attribute, not a Stimulus Value). */
const BUTTON_BUSY_LABEL = "data-submit-once-busy-label";

/**
 * Headless "submit once" behavior: disables the form's submit button(s) on submit
 * to prevent a double submission, optionally swaps in a busy label, and restores
 * on completion. The Headless superset of Rails' `disable_with` (no dedicated APG
 * pattern; follows the WCAG "status messages" practice via `aria-busy`).
 *
 * Markup contract (identifier: `stimeo--submit-once`):
 *   <form data-controller="stimeo--submit-once"
 *         data-stimeo--submit-once-busy-label-value="Submitting…">
 *     <button type="submit" data-stimeo--submit-once-target="submit">Send</button>
 *   </form>
 *
 * Zero wiring for Turbo forms: `connect()` subscribes to `turbo:submit-start`
 * itself (symmetric with the `turbo:submit-end` it already listens for), so no
 * `data-action` is required. The public {@link start} action is kept for back-compat
 * and for **non-Turbo** forms, where you bind it to the native event yourself:
 * `data-action="submit->stimeo--submit-once#start"`. Re-entrancy is guarded — once
 * busy, a second `start` (auto + manual, or a duplicate event) no-ops.
 *
 * On submit it disables every `submit` target (or, with none, the form's native
 * `button[type=submit]` / `input[type=submit]`), sets `aria-busy` on them and
 * `data-submitting` on the form, and swaps the **triggering** button's visible
 * label for the busy label (per-button `data-submit-once-busy-label` overrides the
 * form's `busyLabel` Value). It restores on Turbo's `turbo:submit-end`, or after
 * `timeout` ms, re-enabling the buttons and putting the labels back.
 *
 * @remarks
 * Behavior only — no spinner is drawn (pair with {@link "spinner"}). The submit-end
 * listener and the timeout are torn down on `disconnect()` (Turbo navigation
 * included), and `connect()` clears any stale busy state parked in a restored cache
 * snapshot so a button is never left disabled. Non-Turbo caveat: the buttons are
 * disabled synchronously inside the `submit` handler, and a plain HTML submission
 * builds its entry list *after* that event — so a disabled submitter's `name`/`value`
 * is excluded from the payload. Turbo is unaffected (it appends the submitter's
 * name/value from attributes when building `FormData`); mirror the value into a
 * hidden field when a non-Turbo form depends on it.
 */
export class SubmitOnceController extends Controller<HTMLElement> {
  static override targets = ["submit"];
  static override values = {
    busyLabel: { type: String, default: "" },
    timeout: { type: Number, default: 0 },
    restoreFocus: { type: Boolean, default: false },
  };
  static actions = ["start"] as const;
  static events = ["start", "end"] as const;

  declare readonly submitTargets: SubmitButton[];
  declare readonly hasSubmitTarget: boolean;

  declare busyLabelValue: string;
  declare timeoutValue: number;
  declare restoreFocusValue: boolean;

  readonly #timeouts = new SafeTimeout();
  #timeoutId: number | null = null;
  #busy = false;
  #submitter: SubmitButton | null = null;

  readonly #onSubmitStart = (event: Event): void => {
    this.start(event);
  };

  readonly #onSubmitEnd = (event: Event): void => {
    const success = (event as CustomEvent<{ success?: boolean }>).detail?.success;
    this.#restore(success);
  };

  override connect(): void {
    // Auto-subscribe to both ends of a Turbo submission so a drop-in form needs
    // no `data-action`. `turbo:submit-start` bubbles from the <form>, so this
    // works whether the controller is mounted on the form or an ancestor. The
    // re-entrancy guard in `start` keeps a manual `submit->#start` (non-Turbo)
    // from double-firing.
    this.element.addEventListener("turbo:submit-start", this.#onSubmitStart);
    this.element.addEventListener("turbo:submit-end", this.#onSubmitEnd);
    // Idempotent: drop any busy state carried over in a restored snapshot so a
    // cached, disabled button does not stay stuck.
    this.#clearStaleBusy();
  }

  override disconnect(): void {
    this.element.removeEventListener("turbo:submit-start", this.#onSubmitStart);
    this.element.removeEventListener("turbo:submit-end", this.#onSubmitEnd);
    this.#clearTimeout();
  }

  /**
   * Enters the busy state for the submission started by `event`. Accepts both a
   * native `SubmitEvent` (manual `submit->#start` on non-Turbo forms) and Turbo's
   * `turbo:submit-start` CustomEvent (auto-subscribed in `connect`).
   */
  start(event: Event): void {
    if (this.#busy) return;
    this.#busy = true;
    const buttons = this.#buttons;
    const submitter = this.#resolveSubmitter(event, buttons);
    this.#submitter = submitter;
    for (const button of buttons) {
      this.#enterBusy(button, button === submitter);
    }
    this.element.setAttribute("data-submitting", "true");
    this.element.setAttribute("aria-busy", "true");
    this.dispatch("start", { detail: {} });
    if (this.timeoutValue > 0) {
      this.#timeoutId = this.#timeouts.set(() => this.#restore(false), this.timeoutValue);
    }
  }

  /** Restores the non-busy state, re-enabling buttons and putting labels back. */
  #restore(success?: boolean): void {
    if (!this.#busy) return;
    this.#busy = false;
    this.#clearTimeout();
    for (const button of this.#buttons) {
      this.#exitBusy(button);
    }
    this.element.removeAttribute("data-submitting");
    this.element.removeAttribute("aria-busy");
    this.dispatch("end", { detail: { success } });
    if (this.restoreFocusValue && this.#submitter) {
      this.#submitter.focus();
    }
    this.#submitter = null;
  }

  /** Disables a button, marks it busy, and swaps the trigger's label. */
  #enterBusy(button: SubmitButton, isTrigger: boolean): void {
    // Only disable (and mark) buttons that were enabled, so an authored-disabled
    // submit button — e.g. "disabled until valid" — is left untouched and is never
    // re-enabled by us on restore.
    if (!button.disabled) {
      button.disabled = true;
      button.setAttribute(DISABLED_MARKER, "true");
      button.setAttribute("aria-busy", "true");
    }
    if (!isTrigger) return;
    const label = button.getAttribute(BUTTON_BUSY_LABEL) ?? this.busyLabelValue;
    if (label.length === 0) return;
    if (!button.hasAttribute(ORIGINAL_LABEL)) {
      button.setAttribute(ORIGINAL_LABEL, this.#getLabel(button));
    }
    this.#setLabel(button, label);
  }

  /** Re-enables a button we disabled and restores its parked label, if any. */
  #exitBusy(button: SubmitButton): void {
    if (button.hasAttribute(DISABLED_MARKER)) {
      button.disabled = false;
      button.removeAttribute(DISABLED_MARKER);
      button.removeAttribute("aria-busy");
    }
    const original = button.getAttribute(ORIGINAL_LABEL);
    if (original !== null) {
      this.#setLabel(button, original);
      button.removeAttribute(ORIGINAL_LABEL);
    }
  }

  /** Resets busy state left in a restored cache snapshot without firing events. */
  #clearStaleBusy(): void {
    this.#busy = false;
    if (this.element.hasAttribute("data-submitting")) {
      this.element.removeAttribute("data-submitting");
      this.element.removeAttribute("aria-busy");
    }
    for (const button of this.#buttons) {
      this.#exitBusy(button);
    }
  }

  /** The triggering button: the event's submitter when ours, else the first button. */
  #resolveSubmitter(event: Event, buttons: SubmitButton[]): SubmitButton | null {
    const submitter = this.#eventSubmitter(event);
    if (submitter && this.#isSubmitButton(submitter) && buttons.includes(submitter)) {
      return submitter;
    }
    return buttons[0] ?? null;
  }

  /**
   * Reads the submitter from a native `SubmitEvent` (`event.submitter`) or from
   * Turbo's `turbo:submit-start` detail (`detail.formSubmission.submitter`), so
   * the busy label swaps onto the right button under either path.
   */
  #eventSubmitter(event: Event): HTMLElement | null {
    // Guard the `instanceof` with a typeof check: `SubmitEvent` is absent in some
    // non-browser/older runtimes, where a bare reference would throw ReferenceError.
    if (typeof SubmitEvent !== "undefined" && event instanceof SubmitEvent) {
      return event.submitter;
    }
    const detail = (event as CustomEvent<{ formSubmission?: { submitter?: HTMLElement } }>).detail;
    return detail?.formSubmission?.submitter ?? null;
  }

  /** The controlled buttons: `submit` targets, or the form's native submit controls. */
  get #buttons(): SubmitButton[] {
    if (this.hasSubmitTarget) return this.submitTargets;
    return Array.from(
      this.element.querySelectorAll<SubmitButton>('button[type="submit"], input[type="submit"]'),
    );
  }

  #isSubmitButton(el: HTMLElement): el is SubmitButton {
    return el instanceof HTMLButtonElement || el instanceof HTMLInputElement;
  }

  /** Reads a button's visible label (input value, aria-label, or text). */
  #getLabel(button: SubmitButton): string {
    if (button instanceof HTMLInputElement) return button.value;
    const aria = button.getAttribute("aria-label");
    if (aria !== null) return aria;
    return button.textContent ?? "";
  }

  /** Writes a button's visible label through the same channel it was read from. */
  #setLabel(button: SubmitButton, text: string): void {
    if (button instanceof HTMLInputElement) {
      button.value = text;
      return;
    }
    if (button.hasAttribute("aria-label")) {
      button.setAttribute("aria-label", text);
      return;
    }
    button.textContent = text;
  }

  #clearTimeout(): void {
    if (this.#timeoutId !== null) {
      this.#timeouts.clear(this.#timeoutId);
      this.#timeoutId = null;
    }
  }
}
