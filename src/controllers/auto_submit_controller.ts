import { Controller } from "@hotwired/stimulus";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { CompositionTracker } from "../utils/composition_tracker";
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
 * `submit` dispatches `{ trigger }`; `done` dispatches `{ message? }`.
 * `reconcile` dispatches `{}` when the Turbo cache rewind drops a submission
 * that was pending or in flight — `done` would claim a response arrived.
 *
 * @remarks
 * Behavior only — it owns *triggering* the submit (debounce + `requestSubmit`),
 * never the submit itself (Turbo / native form submission) or validation. It
 * **never moves focus** (WCAG 2.2 3.2.2 / 4.1.3): auto-submitting must not yank the
 * caret out of the field. While a result swap is silent for screen-reader users,
 * setting `announce` bridges the completion to the shared `stimeo--announcer`
 * as a safety net; apps can also listen for `stimeo--auto-submit:done`
 * and announce richer text themselves. `aria-busy` marks the in-flight window and
 * `data-auto-submit-pending` the debounce window, for consumer CSS; both hooks are
 * rewound just before Turbo caches the page so they never burn into a snapshot.
 * The `turbo:submit-end`/composition subscriptions follow the `form` target as it
 * is added, replaced, or removed at runtime; unbinding a form drops its pending
 * debounced submit, since that submit described a form that is going away. With
 * no resolvable form (no target and a non-`<form>` root) the controller is inert.
 * During IME composition it holds the submit until `compositionend` (the confirmed
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
  static events = ["submit", "done", "reconcile"] as const;

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
  /** The form the listeners are attached to; target callbacks rebind it. */
  #boundForm: HTMLFormElement | null = null;
  /** Rewinds the transient state hooks just before Turbo snapshots the page. */
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindForCache());

  /** Clears `aria-busy` and emits completion once Turbo finishes the submit. */
  readonly #onSubmitEnd = (): void => {
    this.#boundForm?.removeAttribute("aria-busy");
    const message = this.messageValue;
    this.dispatch("done", { detail: { message: message || undefined } });
    // Bridge the silent result swap to the shared Announcer so SR users hear it.
    if (this.announceValue && message) {
      window.dispatchEvent(new CustomEvent("stimeo--announcer:announce", { detail: { message } }));
    }
  };

  /** Owns delegated IME lifecycle state and submits confirmed input text. */
  readonly #composition = new CompositionTracker({
    onEnd: (event) => {
      if (this.#triggers("input")) this.#schedule((event.target as HTMLElement | null) ?? null);
    },
  });

  override connect(): void {
    this.#beforeCache.activate();
    this.#bindForm(this.#resolveForm());
  }

  override disconnect(): void {
    this.#beforeCache.deactivate();
    this.#bindForm(null);
    this.#composition.disconnect();
    this.#timers.clearAll();
    this.#pendingId = 0;
  }

  /** Follows a `form` target added (or swapped in) at runtime. */
  formTargetConnected(): void {
    this.#bindForm(this.#resolveForm());
  }

  /** Follows a `form` target removed (or swapped out) at runtime. */
  formTargetDisconnected(): void {
    this.#bindForm(this.#resolveForm());
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
    if (event.type === "input" && this.#composition.isComposing(event as InputEvent)) return;
    this.#schedule((event.target as HTMLElement | null) ?? null);
  }

  /** Schedules (and coalesces) the debounced submit for the given trigger. */
  #schedule(trigger: HTMLElement | null): void {
    const form = this.#boundForm;
    if (!form) return;
    form.setAttribute("data-auto-submit-pending", "true");
    this.#cancelPending();

    this.#pendingId = this.#timers.set(() => {
      this.#pendingId = 0;
      form.removeAttribute("data-auto-submit-pending");
      this.dispatch("submit", { detail: { trigger } });
      // `requestSubmit()` runs native constraint validation. If the form is
      // invalid the actual submit never happens — the browser blocks it (or, when
      // a `stimeo--form-validation` set `novalidate`, that controller cancels the
      // submit) — so no `turbo:submit-end` arrives to clear `aria-busy`. Only mark
      // the form busy when the submit will really proceed; still call
      // `requestSubmit()` either way so the validation surfaces to the user.
      if (form.checkValidity()) {
        form.setAttribute("aria-busy", "true");
      }
      form.requestSubmit();
    }, this.debounceValue);
  }

  /** Cancels the pending debounced submit, if any (`clear` no-ops on unknown ids). */
  #cancelPending(): void {
    this.#timers.clear(this.#pendingId);
    this.#pendingId = 0;
  }

  /**
   * Replaces the subscribed form symmetrically. The outgoing form loses the
   * `turbo:submit-end`/composition listeners, its pending hook, and any pending
   * debounced submit (which described the outgoing form). An in-flight `aria-busy`
   * is left for `turbo:submit-end` or the pre-cache rewind — removing it here
   * would wipe a legitimately in-progress submission.
   */
  #bindForm(form: HTMLFormElement | null): void {
    if (form === this.#boundForm) return;
    const previous = this.#boundForm;
    if (previous) {
      this.#cancelPending();
      previous.removeAttribute("data-auto-submit-pending");
      previous.removeEventListener("turbo:submit-end", this.#onSubmitEnd);
      this.#composition.unobserve(previous);
    }
    this.#boundForm = form;
    if (!form) return;
    form.addEventListener("turbo:submit-end", this.#onSubmitEnd);
    this.#composition.observe(form);
  }

  /** Resolves the form: the explicit `form` target, else a `<form>` root, else null. */
  #resolveForm(): HTMLFormElement | null {
    if (this.hasFormTarget) return this.formTarget;
    return this.element instanceof HTMLFormElement ? this.element : null;
  }

  /** Returns the transient state hooks to their initial (absent) state. */
  #rewindForCache(): void {
    const inProgress = this.#pendingId !== 0 || this.#boundForm?.hasAttribute("aria-busy") === true;
    this.#cancelPending();
    this.#boundForm?.removeAttribute("data-auto-submit-pending");
    this.#boundForm?.removeAttribute("aria-busy");
    if (inProgress) this.dispatch("reconcile", { detail: {} });
  }

  /** Whether `type` is one of the whitespace-separated event types in `on`. */
  #triggers(type: string): boolean {
    return this.onValue.split(/\s+/).filter(Boolean).includes(type);
  }
}
