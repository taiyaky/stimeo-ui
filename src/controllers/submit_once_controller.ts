import { Controller } from "@hotwired/stimulus";
import { announce } from "../utils/announce";
import { AttributeLease } from "../utils/attribute_lease";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { DetachGate } from "../utils/detach_gate";
import { SafeTimeout } from "../utils/safe_timeout";

/** Native controls that can submit a form. */
type SubmitControl = HTMLButtonElement | HTMLInputElement;

/** Why an active submission returned to idle. */
type CompletionReason = "canceled" | "manual" | "timeout" | "turbo";

/** A text/value write that cannot be represented by an {@link AttributeLease}. */
type LabelWrite =
  | {
      readonly channel: "text";
      readonly control: HTMLButtonElement;
      readonly original: string;
      readonly written: string;
    }
  | {
      readonly channel: "value";
      readonly control: HTMLInputElement;
      readonly original: string;
      readonly written: string;
    };

/** One form's independent in-flight submission. */
interface SubmissionSession {
  readonly form: HTMLFormElement;
  readonly submitter: SubmitControl | null;
  readonly submitterHadFocus: boolean;
  readonly controls: Set<SubmitControl>;
  timeoutId: number | null;
  labelWrite: LabelWrite | null;
  idlePart: HTMLElement | null;
  busyPart: HTMLElement | null;
}

/** Per-button override for the controller's default busy label. */
const BUTTON_BUSY_LABEL = "data-submit-once-busy-label";

/**
 * Headless form-scoped double-submit guard (identifier:
 * `stimeo--submit-once`). It disables every native submit control associated
 * with the submitting form, publishes busy state, and restores only the state
 * it still owns when the operation finishes.
 *
 * Turbo forms need no `data-action`: the controller observes
 * `turbo:submit-start` and `turbo:submit-end` itself.
 *
 * A non-Turbo async form owns its own lifecycle and declares each transition:
 * `submit->stimeo--submit-once#start` applies the busy state synchronously,
 * before the request is issued, and `#finish` / `#cancel` end it. Cancelling the
 * event's default is how such a form suppresses the native navigation, so it
 * never means the submission died — only `#cancel` does. A submit already
 * cancelled by an earlier listener never starts a session at all.
 *
 * ```html
 * <form data-controller="stimeo--submit-once"
 *       data-action="submit->stimeo--submit-once#start
 *                    save:complete->stimeo--submit-once#finish
 *                    save:error->stimeo--submit-once#cancel">
 *   <button type="submit">Save</button>
 * </form>
 * ```
 *
 * A form whose submit a later listener vetoes needs `#cancel` wired to that
 * veto, or a non-zero `timeout`, to leave the busy state.
 *
 * Plain text buttons can use `busyLabel` (overridden by
 * `data-submit-once-busy-label`). A button with authored structure instead uses
 * an `idle` / `busy` target pair inside that button, so icons and descendants
 * are never replaced with `textContent`:
 *
 * ```html
 * <form data-controller="stimeo--submit-once"
 *       data-stimeo--submit-once-announce-text-value="Saving…"
 *       data-stimeo--submit-once-announce-ready-text-value="Saved.">
 *   <button type="submit" data-stimeo--submit-once-target="submit">
 *     <span data-stimeo--submit-once-target="idle">Save</span>
 *     <span data-stimeo--submit-once-target="busy" hidden>Saving…</span>
 *   </button>
 * </form>
 * ```
 *
 * Events:
 * - `stimeo--submit-once:start` — `{ form, submitter }`.
 * - `stimeo--submit-once:reconcile` — `{ forms: HTMLFormElement[] }`, the forms
 *   whose in-flight submission the Turbo cache rewind abandoned. `end` would
 *   claim the submission resolved, so the rewind reports itself instead.
 * - `stimeo--submit-once:end` — `{ form, submitter, reason, success? }`, where
 *   `reason` is `"turbo"`, `"timeout"`, `"manual"`, or `"canceled"`. Only
 *   `"canceled"` skips the completion announcement, because no operation ran.
 *
 * @remarks
 * Behavior only: the consumer owns every visual, label, and announcement
 * string. `announceText` / `announceReadyText` are empty by default and speak
 * through the page's shared `stimeo--announcer` only on real state transitions.
 * Attribute writes use {@link AttributeLease}, so a consumer mutation made
 * while busy wins over restoration. {@link DetachGate} preserves an in-flight
 * session across an in-page move, while {@link BeforeCacheReset} rewinds the
 * snapshot before Turbo caches it. Cache/detach rewinds are silent and never
 * move focus.
 */
export class SubmitOnceController extends Controller<HTMLElement> {
  static override targets = ["submit", "idle", "busy"];
  static override values = {
    announceText: { type: String, default: "" },
    announceReadyText: { type: String, default: "" },
    busyLabel: { type: String, default: "" },
    timeout: { type: Number, default: 0 },
    restoreFocus: { type: Boolean, default: false },
  };
  static actions = ["cancel", "finish", "start"] as const;
  static events = ["start", "end", "reconcile"] as const;

  declare readonly submitTargets: SubmitControl[];
  declare readonly idleTargets: HTMLElement[];
  declare readonly busyTargets: HTMLElement[];

  declare announceTextValue: string;
  declare announceReadyTextValue: string;
  declare busyLabelValue: string;
  declare timeoutValue: number;
  declare restoreFocusValue: boolean;

  readonly #timers = new SafeTimeout();
  readonly #gate = new DetachGate();
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindForCache());
  readonly #sessions = new Map<HTMLFormElement, SubmissionSession>();

  readonly #disabled = new AttributeLease<SubmitControl>("disabled");
  readonly #controlBusy = new AttributeLease<SubmitControl>("aria-busy");
  readonly #formBusy = new AttributeLease<HTMLFormElement>("aria-busy");
  readonly #submitting = new AttributeLease<HTMLFormElement>("data-submitting");
  readonly #ariaLabel = new AttributeLease<HTMLButtonElement>("aria-label");
  readonly #hidden = new AttributeLease<HTMLElement>("hidden");

  readonly #onSubmitStart = (event: Event): void => {
    this.start(event);
  };

  readonly #onSubmitEnd = (event: Event): void => {
    this.#complete(this.#eventForm(event), "turbo", this.#eventSuccess(event));
  };

  /** Blocks a later native submit while one for the same form is still active. */
  readonly #onNativeSubmit = (event: Event): void => {
    // The submit event's target is its form. This listener runs in capture so it
    // always observes that first event before a public `start` action creates the
    // session, while a later event sees the session and is canceled here.
    const session = this.#sessionFor(event.target);
    if (!session) return;
    this.#syncControls(session);
    event.preventDefault();
  };

  override connect(): void {
    this.#gate.cancel();
    this.#beforeCache.activate();
    this.element.addEventListener("submit", this.#onNativeSubmit, true);
    this.element.addEventListener("turbo:submit-start", this.#onSubmitStart);
    this.element.addEventListener("turbo:submit-end", this.#onSubmitEnd);
  }

  override disconnect(): void {
    this.element.removeEventListener("submit", this.#onNativeSubmit, true);
    this.element.removeEventListener("turbo:submit-start", this.#onSubmitStart);
    this.element.removeEventListener("turbo:submit-end", this.#onSubmitEnd);
    this.#beforeCache.deactivate();
    this.#gate.disconnected(this, () => this.#teardown());
  }

  /**
   * Begins the submission represented by `event`.
   *
   * Native `submit` events are intended for non-Turbo async forms. Turbo calls
   * this path through its auto-subscribed `turbo:submit-start` event. An event
   * whose default an earlier listener already cancelled carries no submission,
   * so it starts nothing.
   */
  start(event: Event): void {
    if (event.defaultPrevented) return;
    const form = this.#eventForm(event);
    if (!form || this.#sessions.has(form)) return;

    const controls = this.#submitControls(form);
    const submitter = this.#resolveSubmitter(event, controls);
    const session: SubmissionSession = {
      form,
      submitter,
      submitterHadFocus: submitter !== null && document.activeElement === submitter,
      controls: new Set(),
      timeoutId: null,
      labelWrite: null,
      idlePart: null,
      busyPart: null,
    };
    this.#sessions.set(form, session);

    this.#formBusy.write(form, "true");
    this.#submitting.write(form, "true");
    this.#syncControls(session, controls);
    this.#enterLabel(session);
    this.dispatch("start", { detail: { form, submitter } });

    if (this.timeoutValue > 0) {
      session.timeoutId = this.#timers.set(
        () => this.#complete(form, "timeout", false),
        this.timeoutValue,
      );
    }

    announce(this.announceTextValue);
  }

  /**
   * Completes a non-Turbo async submission for the form associated with
   * `event`. When called directly with no event, it completes the controller's
   * sole active form (or the controller element itself when it is a form).
   */
  finish(event?: Event): void {
    const form = event ? this.#eventForm(event) : this.#defaultForm();
    this.#complete(form, "manual", event ? this.#eventSuccess(event) : undefined);
  }

  /**
   * Abandons the submission for the form associated with `event` because it
   * never reached the network — a veto from validation, or a request the
   * consumer gave up before sending. With no event it targets the controller's
   * sole active form, exactly like {@link finish}.
   *
   * The distinction from `finish` is observable: a request that ran and failed
   * is `finish` with `success: false` and still announces completion, while a
   * submission that never happened announces nothing.
   */
  cancel(event?: Event): void {
    const form = event ? this.#eventForm(event) : this.#defaultForm();
    this.#complete(form, "canceled", false);
  }

  /** Disables a newly connected explicit submit target during its form's session. */
  submitTargetConnected(target: SubmitControl): void {
    const session = this.#sessionFor(target.form);
    if (!session || !this.#isNativeSubmitControl(target)) return;
    this.#enterControl(session, target);
  }

  /** Ends one session, restores owned state, and reports the observable completion. */
  #complete(form: HTMLFormElement | null, reason: CompletionReason, success?: boolean): void {
    const session = this.#sessionFor(form);
    if (!session) return;
    this.#sessions.delete(session.form);
    this.#returnSessionState(session);

    const detail =
      success === undefined
        ? { form: session.form, submitter: session.submitter, reason }
        : { form: session.form, submitter: session.submitter, reason, success };
    this.dispatch("end", { detail });
    this.#restoreFocus(session);
    if (reason !== "canceled") announce(this.announceReadyTextValue);
  }

  /** Applies the busy state to every current native/explicit control exactly once. */
  #syncControls(session: SubmissionSession, controls = this.#submitControls(session.form)): void {
    for (const control of controls) this.#enterControl(session, control);
  }

  /** Temporarily disables one enabled submit control while retaining authored state. */
  #enterControl(session: SubmissionSession, control: SubmitControl): void {
    if (session.controls.has(control) || control.matches(":disabled")) return;
    session.controls.add(control);
    this.#disabled.write(control, "");
    this.#controlBusy.write(control, "true");
  }

  /** Swaps only the triggering control's safe label channel. */
  #enterLabel(session: SubmissionSession): void {
    const control = session.submitter;
    if (!control) return;

    const idlePart = this.#partInside(control, this.idleTargets);
    const busyPart = this.#partInside(control, this.busyTargets);
    if (idlePart && busyPart) {
      session.idlePart = idlePart;
      session.busyPart = busyPart;
      this.#hidden.write(idlePart, "");
      this.#hidden.write(busyPart, null);
    }

    const label = control.getAttribute(BUTTON_BUSY_LABEL) ?? this.busyLabelValue;
    if (label.length === 0) return;
    if (control instanceof HTMLInputElement) {
      // `input[type=image]#value` is submitted data, not a visible label.
      if (control.type !== "submit") return;
      session.labelWrite = {
        channel: "value",
        control,
        original: control.value,
        written: label,
      };
      control.value = label;
      return;
    }
    if (control.hasAttribute("aria-label")) {
      this.#ariaLabel.write(control, label);
      return;
    }
    // A structured button needs the explicit idle/busy pair above. Replacing its
    // textContent would destroy icons, counters, and application-owned listeners.
    if (control.childElementCount > 0) return;
    session.labelWrite = {
      channel: "text",
      control,
      original: control.textContent ?? "",
      written: label,
    };
    control.textContent = label;
  }

  /** Returns labels, controls, and form hooks, respecting intervening consumer writes. */
  #returnSessionState(session: SubmissionSession): void {
    if (session.timeoutId !== null) {
      this.#timers.clear(session.timeoutId);
      session.timeoutId = null;
    }

    if (session.labelWrite?.channel === "value") {
      const { control, original, written } = session.labelWrite;
      if (control.value === written) control.value = original;
    } else if (session.labelWrite?.channel === "text") {
      const { control, original, written } = session.labelWrite;
      if (control.childElementCount === 0 && control.textContent === written) {
        control.textContent = original;
      }
    }
    session.labelWrite = null;

    if (session.submitter instanceof HTMLButtonElement) {
      this.#ariaLabel.return(session.submitter);
    }
    if (session.idlePart) this.#hidden.return(session.idlePart);
    if (session.busyPart) this.#hidden.return(session.busyPart);
    session.idlePart = null;
    session.busyPart = null;

    for (const control of session.controls) {
      this.#controlBusy.return(control);
      this.#disabled.return(control);
    }
    session.controls.clear();
    this.#submitting.return(session.form);
    this.#formBusy.return(session.form);
  }

  /** Restores focus only when disabling the focused submitter actually stranded it. */
  #restoreFocus(session: SubmissionSession): void {
    const submitter = session.submitter;
    if (!this.restoreFocusValue || !session.submitterHadFocus || !submitter?.isConnected) return;
    const active = document.activeElement;
    if (active === null || active === document.body || active === document.documentElement) {
      submitter.focus();
    }
  }

  /** Silently abandons every session before caching or on a real detach. */
  #abandonSessions(): void {
    this.#timers.clearAll();
    for (const session of this.#sessions.values()) {
      session.timeoutId = null;
      this.#returnSessionState(session);
    }
    this.#sessions.clear();
  }

  /** Keeps Turbo's cached snapshot idle, without events, announcements, or focus moves. */
  #rewindForCache(): void {
    const forms = [...this.#sessions.keys()];
    this.#abandonSessions();
    // A submission in flight dies with the navigation, so a consumer still
    // painting "submitting" from `start` would never be released.
    if (forms.length > 0) this.dispatch("reconcile", { detail: { forms } });
  }

  /** Tears down a true detach; an in-page move is canceled by the next `connect()`. */
  #teardown(): void {
    this.#gate.cancel();
    this.#abandonSessions();
  }

  /** All native controls associated with `form`, plus valid explicit targets. */
  #submitControls(form: HTMLFormElement): SubmitControl[] {
    const controls = new Set<SubmitControl>();
    for (const element of Array.from(form.elements)) {
      if (this.#isNativeSubmitControl(element)) controls.add(element);
    }
    // Browsers historically omit input[type=image] from form.elements. Search
    // the form's tree root as well so descendant and external `form=` image
    // submitters receive the same guard without broadening into sibling forms.
    const root = form.getRootNode() as ParentNode;
    for (const image of root.querySelectorAll<HTMLInputElement>('input[type="image"]')) {
      if (image.form === form) controls.add(image);
    }
    return Array.from(controls);
  }

  /** Resolves the real submitter, falling back to the first enabled submit control. */
  #resolveSubmitter(event: Event, controls: SubmitControl[]): SubmitControl | null {
    const submitter = this.#eventSubmitter(event);
    if (submitter && controls.includes(submitter)) return submitter;
    return controls.find((control) => !control.matches(":disabled")) ?? controls[0] ?? null;
  }

  /** Reads a native or Turbo submitter without assuming `SubmitEvent` exists. */
  #eventSubmitter(event: Event): SubmitControl | null {
    if (typeof SubmitEvent !== "undefined" && event instanceof SubmitEvent) {
      return this.#isNativeSubmitControl(event.submitter) ? event.submitter : null;
    }
    const detail = (event as CustomEvent<{ formSubmission?: { submitter?: HTMLElement | null } }>)
      .detail;
    const submitter = detail?.formSubmission?.submitter;
    return this.#isNativeSubmitControl(submitter) ? submitter : null;
  }

  /** Finds the form represented by an action/Turbo event and verifies this scope owns it. */
  #eventForm(event: Event): HTMLFormElement | null {
    const detail = (
      event as CustomEvent<{
        form?: HTMLFormElement;
        formSubmission?: { formElement?: HTMLFormElement; submitter?: HTMLElement | null };
      }>
    ).detail;
    const target = event.target;
    const candidate =
      (target instanceof HTMLFormElement ? target : null) ??
      (target instanceof Element ? target.closest("form") : null) ??
      detail?.formSubmission?.formElement ??
      detail?.form ??
      this.#eventSubmitter(event)?.form ??
      (this.element instanceof HTMLFormElement ? this.element : null);
    return candidate && this.#ownsForm(candidate) ? candidate : null;
  }

  /** The only unambiguous form for a direct `finish()` call. */
  #defaultForm(): HTMLFormElement | null {
    if (this.element instanceof HTMLFormElement && this.#ownsForm(this.element))
      return this.element;
    if (this.#sessions.size === 1) return this.#sessions.keys().next().value ?? null;
    return null;
  }

  /** Prevents an ancestor controller from also taking over a nested instance's form. */
  #ownsForm(form: HTMLFormElement): boolean {
    let candidate: Element | null = form;
    while (candidate) {
      const identifiers = (candidate.getAttribute("data-controller") ?? "").split(/\s+/);
      if (identifiers.includes(this.identifier)) return candidate === this.element;
      candidate = candidate.parentElement;
    }
    return false;
  }

  /** Returns the active session for a form-shaped external event value. */
  #sessionFor(candidate: unknown): SubmissionSession | undefined {
    if (!(candidate instanceof HTMLFormElement)) return undefined;
    return this.#sessions.get(candidate);
  }

  /** Effective native submit controls, including implicit buttons and image inputs. */
  #isNativeSubmitControl(element: unknown): element is SubmitControl {
    if (element instanceof HTMLButtonElement) return element.type === "submit";
    return (
      element instanceof HTMLInputElement && (element.type === "submit" || element.type === "image")
    );
  }

  /** Finds a structured label part belonging to this button, not a nested control. */
  #partInside(control: SubmitControl, parts: HTMLElement[]): HTMLElement | null {
    return (
      parts.find(
        (part) =>
          control.contains(part) &&
          part.closest("button, input[type=submit], input[type=image]") === control,
      ) ?? null
    );
  }

  /** Reads an optional boolean `success` from Turbo or a manual completion event. */
  #eventSuccess(event: Event): boolean | undefined {
    const success = (event as CustomEvent<{ success?: unknown }>).detail?.success;
    return typeof success === "boolean" ? success : undefined;
  }
}
