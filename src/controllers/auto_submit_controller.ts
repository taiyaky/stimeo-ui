import { Controller } from "@hotwired/stimulus";
import { announce } from "../utils/announce";
import { AttributeLease } from "../utils/attribute_lease";
import { CompositionTracker } from "../utils/composition_tracker";
import { DetachGate } from "../utils/detach_gate";
import { ListenerSet } from "../utils/listener_set";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { SafeTimeout } from "../utils/safe_timeout";
import { TransientHooks } from "../utils/transient_hooks";

/**
 * The debounce-window hook. It lives as long as the debounce timer of the instance
 * that wrote it, and unbinding a form drops both, so a connection that finds it on its
 * form found it on a copy of the page.
 */
const PENDING = new TransientHooks({ attributes: ["data-auto-submit-pending"] });

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
 * `reconcile` dispatches `{}` when a connection drops the pending hook, or gives back
 * the in-flight `aria-busy`, it finds on its form — a page restored from the Turbo cache
 * inside the debounce window or while a submit was in flight, whose submit will never
 * fire or answer. `done` would claim a response arrived.
 *
 * @remarks
 * Behavior only — it owns *triggering* the submit (debounce + `requestSubmit`),
 * never the submit itself (Turbo / native form submission) or validation. It
 * **never moves focus** (WCAG 2.2 3.2.2 / 4.1.3): auto-submitting must not yank the
 * caret out of the field. While a result swap is silent for screen-reader users,
 * setting `announce` bridges the completion to the shared `stimeo--announcer`
 * as a safety net; apps can also listen for `stimeo--auto-submit:done`
 * and announce richer text themselves. `aria-busy` marks the in-flight window and
 * `data-auto-submit-pending` the debounce window, for consumer CSS. `aria-busy` is
 * leased, so the end of a submit gives the form back the value its author wrote, and
 * that value is recorded on the form for a copy of it to find. Neither hook, and
 * neither the pending submit, is undone on `turbo:before-cache`, which Turbo also
 * dispatches on pages that stay (a promoted frame navigation, a state-less `popstate`,
 * a refresh of a cached URL): the query the user typed there still submits.
 * The `turbo:submit-end`/composition subscriptions follow the `form` target as it
 * is added, replaced, or removed at runtime; unbinding a form drops its pending
 * debounced submit, since that submit described a form that is going away. With
 * no resolvable form (no target and a non-`<form>` root) the controller is inert.
 * During IME composition it holds the submit until `compositionend` (the confirmed
 * conversion) so it does not fire on each intermediate keystroke. The debounce
 * timer and the `turbo:submit-end`/composition listeners are torn down once the
 * element is really detached; an in-page move, and a `data-turbo-permanent` form Turbo
 * carries to the next page, reconnect the same instance with the pending submit still
 * due.
 */
export class AutoSubmitController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override targets = ["form"];
  static override values = {
    debounce: { type: Number, default: 300 },
    on: { type: String, default: "input change" },
    announce: { type: Boolean, default: false },
    message: { type: String, default: "" },
  };

  static valueConstraints = {
    debounce: NUMBER_BOUNDS.timer,
  } satisfies NumberValueConstraints<typeof AutoSubmitController.values>;
  static actions = ["submit"] as const;
  static events = ["submit", "done", "reconcile"] as const;

  declare readonly formTarget: HTMLFormElement;
  declare readonly hasFormTarget: boolean;

  declare debounceValue: number;
  declare onValue: string;
  declare announceValue: boolean;
  declare messageValue: string;

  /** Debounce timer registry; releasing the bound form cancels its pending timer. */
  readonly #timers = new SafeTimeout();
  /** Id of the pending debounce timer, so a new keystroke can reset it. */
  #pendingId = 0;
  /** Listeners that live with the bound form rather than with the connection. */
  readonly #formListeners = new ListenerSet();
  /** The form the listeners are attached to; target callbacks rebind it. */
  #boundForm: HTMLFormElement | null = null;
  /** Owns the in-flight `aria-busy` on the form. */
  readonly #busy = new AttributeLease<HTMLFormElement>("aria-busy", this.identifier);
  /** Tells an in-page move or a permanent carry from a real detach. */
  readonly #gate = new DetachGate();

  /**
   * Clears `aria-busy` and emits completion once Turbo finishes the submit.
   *
   * @stimeoRuntimeOnly `message` and `announce` shape the event and the announcement of one
   *   finished submit; the busy flag it clears does not depend on them.
   */
  readonly #onSubmitEnd = (): void => {
    if (this.#boundForm) this.#busy.return(this.#boundForm);
    const message = this.messageValue;
    this.dispatch("done", { detail: { message: message || undefined } });
    // Bridge the silent result swap to the shared Announcer so SR users hear it.
    if (this.announceValue) announce(message);
  };

  /** Owns delegated IME lifecycle state and submits confirmed input text. */
  readonly #composition = new CompositionTracker({
    onEnd: (event) => {
      if (this.#triggers("input")) this.#schedule((event.target as HTMLElement | null) ?? null);
    },
  });

  /**
   * Binds the form. The reconnection that completes an in-page move or a permanent carry
   * keeps the form it had bound, with its pending submit, and follows its compositions
   * afresh.
   */
  override connect(): void {
    const moved = this.#gate.pending;
    this.#gate.cancel();
    const form = this.#resolveForm();
    if (moved && form && form === this.#boundForm) {
      this.#composition.observe(form);
      return;
    }
    const stale = form?.hasAttribute("data-auto-submit-pending") === true;
    if (form) PENDING.reset(form);
    const busy = form !== null && this.#busy.return(form);
    this.#bindForm(form);
    if (stale || busy) this.dispatch("reconcile", { detail: {} });
  }

  /**
   * Forgets any composition in progress, since a move takes the field out of it, and
   * unbinds the form, dropping its pending submit, once the element is really detached.
   */
  override disconnect(): void {
    this.#composition.disconnect();
    this.#gate.disconnected(this, () => {
      this.#bindForm(null);
      this.#pendingId = 0;
    });
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

  /**
   * Schedules (and coalesces) the debounced submit for the given trigger.
   *
   * @stimeoRuntimeOnly `debounce` is the delay of the one submit timer this call arms.
   */
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
        this.#busy.write(form, "true");
      }
      form.requestSubmit();
    }, this.#safeDebounce);
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
   * is left on it — removing it here would wipe a legitimately in-progress
   * submission.
   */
  #bindForm(form: HTMLFormElement | null): void {
    if (form === this.#boundForm) return;
    const previous = this.#boundForm;
    if (previous) {
      this.#cancelPending();
      previous.removeAttribute("data-auto-submit-pending");
      this.#formListeners.dispose();
      this.#composition.unobserve(previous);
    }
    this.#boundForm = form;
    if (!form) return;
    this.#formListeners.add(form, "turbo:submit-end", this.#onSubmitEnd);
    this.#composition.observe(form);
  }

  /** Resolves the form: the explicit `form` target, else a `<form>` root, else null. */
  #resolveForm(): HTMLFormElement | null {
    if (this.hasFormTarget) return this.formTarget;
    return this.element instanceof HTMLFormElement ? this.element : null;
  }

  /** Whether `type` is one of the whitespace-separated event types in `on`. */
  #triggers(type: string): boolean {
    return this.onValue.split(/\s+/).filter(Boolean).includes(type);
  }
  /** Current `debounce` declaration resolved against its numeric contract. */
  get #safeDebounce(): number {
    return this.#numbers.read(
      this,
      "debounce",
      this.debounceValue,
      AutoSubmitController.values.debounce.default,
      AutoSubmitController.valueConstraints.debounce,
    );
  }
}
