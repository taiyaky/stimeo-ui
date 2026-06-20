import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";

/**
 * Headless **debounced auto-submit** for forms (no dedicated APG pattern). Submits
 * the form a configurable delay after `input`/`change`, so Rails search/filter
 * forms refresh via Turbo without a submit button.
 *
 * Markup contract (identifier: `stimeo--auto-submit`):
 *   <form data-controller="stimeo--auto-submit"
 *         data-stimeo--auto-submit-debounce-value="300"
 *         data-action="input->stimeo--auto-submit#submit
 *                      change->stimeo--auto-submit#submit">
 *     <input type="search" name="q">
 *   </form>
 *
 *   <!-- Or with the form as a target nested under the controller element: -->
 *   <div data-controller="stimeo--auto-submit">
 *     <form data-stimeo--auto-submit-target="form"> … </form>
 *   </div>
 *
 * @remarks
 * Behavior only — it owns *triggering* the submit (debounce + `requestSubmit`),
 * never the submit itself (Turbo / native form submission) or validation. It
 * **never moves focus** (WCAG 2.2 3.2.2 / 4.1.3): auto-submitting must not yank the
 * caret out of the field. While a result swap is silent for screen-reader users,
 * setting `announce` bridges the completion to the shared `stimeo--announcer`
 * as a safety net; apps can also listen for `stimeo--auto-submit:done`
 * and announce richer text themselves. `aria-busy` marks the in-flight window and
 * `data-auto-submit-pending` the debounce window, for consumer CSS. During IME
 * composition it holds the submit until `compositionend` (the confirmed
 * conversion) so it does not fire on each intermediate keystroke. The debounce
 * timer and the `turbo:submit-end`/composition listeners are torn down on
 * `disconnect()`.
 */
export class AutoSubmitController extends Controller<HTMLElement> {
  static override targets = ["form"];
  static override values = {
    debounce: { type: Number, default: 300 },
    on: { type: String, default: "input change" },
    announce: { type: Boolean, default: false },
    message: { type: String, default: "" },
  };
  static actions = ["submit"] as const;
  static events = ["submit", "done"] as const;

  declare readonly formTarget: HTMLFormElement;
  declare readonly hasFormTarget: boolean;

  declare debounceValue: number;
  declare onValue: string;
  declare announceValue: boolean;
  declare messageValue: string;

  /** Debounce timer registry; one `clearAll()` in disconnect tears it down. */
  readonly #timers = new SafeTimeout();
  /** Id of the pending debounce timer, so a new keystroke can reset it. */
  #pendingId = 0;

  /** Clears `aria-busy` and emits completion once Turbo finishes the submit. */
  readonly #onSubmitEnd = (): void => {
    this.#form.removeAttribute("aria-busy");
    const message = this.messageValue;
    this.dispatch("done", { detail: { message: message || undefined } });
    // Bridge the silent result swap to the shared Announcer so SR users hear it.
    if (this.announceValue && message) {
      window.dispatchEvent(new CustomEvent("stimeo--announcer:announce", { detail: { message } }));
    }
  };

  /** True while an IME composition is in progress on one of the form's fields. */
  #composing = false;

  /** Marks composition active so `input` events mid-conversion don't submit. */
  readonly #onCompositionStart = (): void => {
    this.#composing = true;
  };

  /**
   * Composition finished (the IME conversion is confirmed): clear the flag and
   * schedule a submit as if `input` fired, so the settled text triggers a submit
   * even on browsers whose post-composition `input` still reads `isComposing`.
   */
  readonly #onCompositionEnd = (event: Event): void => {
    this.#composing = false;
    if (this.#triggers("input")) this.#schedule((event.target as HTMLElement | null) ?? null);
  };

  override connect(): void {
    this.#form.addEventListener("turbo:submit-end", this.#onSubmitEnd);
    this.#form.addEventListener("compositionstart", this.#onCompositionStart);
    this.#form.addEventListener("compositionend", this.#onCompositionEnd);
  }

  override disconnect(): void {
    this.#timers.clearAll();
    this.#pendingId = 0;
    // Reset so a same-instance reconnect (e.g. Turbo cache restore mid-composition)
    // never starts with submits suppressed.
    this.#composing = false;
    this.#form.removeAttribute("data-auto-submit-pending");
    this.#form.removeEventListener("turbo:submit-end", this.#onSubmitEnd);
    this.#form.removeEventListener("compositionstart", this.#onCompositionStart);
    this.#form.removeEventListener("compositionend", this.#onCompositionEnd);
  }

  /**
   * Schedules a debounced submit. Wired to `input`/`change`; the `on` value is an
   * allowlist so a configured subset (e.g. only `change`) is honored even when both
   * are bound in markup. Coalesces rapid events into a single `requestSubmit`.
   */
  submit(event: Event): void {
    if (!this.#triggers(event.type)) return;
    // Ignore `input` events fired mid-IME-composition (e.g. typing kana before the
    // Japanese conversion is confirmed); the confirmed text submits on
    // `compositionend` and the browser's final post-composition `input`.
    if (event.type === "input" && (this.#composing || (event as InputEvent).isComposing)) return;
    this.#schedule((event.target as HTMLElement | null) ?? null);
  }

  /** Schedules (and coalesces) the debounced submit for the given trigger. */
  #schedule(trigger: HTMLElement | null): void {
    this.#form.setAttribute("data-auto-submit-pending", "true");
    if (this.#pendingId) this.#timers.clear(this.#pendingId);

    this.#pendingId = this.#timers.set(() => {
      this.#pendingId = 0;
      this.#form.removeAttribute("data-auto-submit-pending");
      this.dispatch("submit", { detail: { trigger } });
      // `requestSubmit()` runs native constraint validation. If the form is
      // invalid the actual submit never happens — the browser blocks it (or, when
      // a `stimeo--form-validation` set `novalidate`, that controller cancels the
      // submit) — so no `turbo:submit-end` arrives to clear `aria-busy`. Only mark
      // the form busy when the submit will really proceed; still call
      // `requestSubmit()` either way so the validation surfaces to the user.
      if (this.#form.checkValidity()) {
        this.#form.setAttribute("aria-busy", "true");
      }
      this.#form.requestSubmit();
    }, this.debounceValue);
  }

  /** Resolves the form element (explicit `form` target, else the controller root). */
  get #form(): HTMLFormElement {
    return this.hasFormTarget ? this.formTarget : (this.element as HTMLFormElement);
  }

  /** Whether `type` is one of the whitespace-separated event types in `on`. */
  #triggers(type: string): boolean {
    return this.onValue.split(/\s+/).filter(Boolean).includes(type);
  }
}
