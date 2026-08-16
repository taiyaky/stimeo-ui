import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";

type VisitDecision =
  | { readonly kind: "block" }
  | { readonly kind: "confirm"; readonly message: string }
  | null;

interface VisitParticipant {
  readonly form: HTMLFormElement;
  readonly evaluate: (event: Event) => VisitDecision;
}

interface SubmitAttempt {
  readonly event: Event;
  snapshot: string;
}

interface TurboSubmitDetail {
  readonly formSubmission?: unknown;
  readonly success?: boolean;
}

type SerializedControl = readonly [
  type: string,
  name: string,
  value: string | readonly string[],
  checked?: 0 | 1,
];

/**
 * Coordinates native Turbo confirmations for every dirty form in one document.
 *
 * The weak document registry owns no dirty baseline or durable form state. Each
 * controller remains the source of truth for its own state and unregisters on
 * disconnect; the shared coordinator only gives one navigation event a single,
 * deterministic decision point.
 */
const visitCoordinators = new WeakMap<Document, TurboVisitCoordinator>();

class TurboVisitCoordinator {
  readonly #document: Document;
  readonly #participants = new Set<VisitParticipant>();

  readonly #onBeforeVisit = (event: Event): void => {
    let blocked = event.defaultPrevented;
    let message: string | undefined;

    // Every eligible form gets its public guard event before a native prompt.
    // A later consumer can therefore block the visit without an earlier form
    // opening a redundant confirm first.
    for (const participant of this.#participantsInDomOrder()) {
      if (!participant.form.isConnected) continue;
      const decision = participant.evaluate(event);
      blocked ||= event.defaultPrevented;
      if (decision === null) continue;
      if (decision.kind === "block") {
        blocked = true;
      } else {
        message ??= decision.message;
      }
    }

    if (blocked) {
      event.preventDefault();
      return;
    }
    if (message === undefined) return;
    if (!this.#document.defaultView?.confirm(message)) event.preventDefault();
  };

  constructor(document: Document) {
    this.#document = document;
  }

  add(participant: VisitParticipant): void {
    if (this.#participants.size === 0) {
      this.#document.addEventListener("turbo:before-visit", this.#onBeforeVisit);
    }
    this.#participants.add(participant);
  }

  /** Removes a participant and reports whether the coordinator became empty. */
  remove(participant: VisitParticipant): boolean {
    this.#participants.delete(participant);
    if (this.#participants.size > 0) return false;
    this.#document.removeEventListener("turbo:before-visit", this.#onBeforeVisit);
    return true;
  }

  #participantsInDomOrder(): VisitParticipant[] {
    return Array.from(this.#participants)
      .filter(
        (participant) =>
          participant.form.isConnected && participant.form.ownerDocument === this.#document,
      )
      .sort((left, right) => {
        const position = left.form.compareDocumentPosition(right.form);
        return (
          Number(Boolean(position & Node.DOCUMENT_POSITION_PRECEDING)) -
          Number(Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING))
        );
      });
  }
}

function registerVisitParticipant(document: Document, participant: VisitParticipant): () => void {
  const coordinator = visitCoordinators.get(document) ?? new TurboVisitCoordinator(document);
  visitCoordinators.set(document, coordinator);
  coordinator.add(participant);

  return () => {
    if (coordinator.remove(participant)) visitCoordinators.delete(document);
  };
}

/**
 * Headless "unsaved changes" guard for a form (no dedicated APG pattern; supports
 * WCAG 2.2 error-prevention 3.3.4 / 3.3.6 by preventing accidental data loss).
 *
 * Markup contract (identifier: `stimeo--dirty-form`):
 *   <form data-controller="stimeo--dirty-form">
 *     …fields…
 *   </form>
 *
 * Snapshots the form's field values on connect, marks the form `data-dirty` once a
 * value changes, and — while dirty — guards both a full unload (`beforeunload`) and
 * a Turbo visit (`turbo:before-visit`). On a Turbo visit it dispatches a cancelable
 * `guard` event for each eligible form; if a consumer cancels one (or any form uses
 * `confirmBridge`) the visit is blocked, otherwise the document falls back to one
 * native `confirm(message)`, using the first eligible form in live DOM order. While a
 * submit is in flight the guard is suppressed until another edit occurs (so a
 * legitimate submit never prompts); the browser's `formdata` event captures the exact
 * revision Turbo materializes, and a successful `turbo:submit-end` accepts only that
 * revision, preserving any later edits as dirty. A failed submit re-arms the guard;
 * `markClean` clears it manually (e.g. after a custom save), while `acceptRestore`
 * adopts a restored draft only while no user edit is already dirty.
 *
 * `dirty` dispatches `{ dirty }`; `guard` dispatches `{ event }`.
 *
 * @remarks
 * Behavior only — it renders no confirmation UI (pair with a Confirm Bridge) and
 * does not persist input (pair with Persist). The dirty baseline is read from the
 * DOM on `connect()` (no module-scope state) — which also clears a stale
 * `data-dirty` left in a Turbo cache snapshot, since the restored values are the
 * new baseline — `beforeunload` is wired only while dirty, and every listener is
 * removed on `disconnect()` (Turbo navigation included) so a stale guard never
 * outlives the form.
 */
export class DirtyFormController extends Controller<HTMLFormElement> {
  static override values = {
    message: { type: String, default: "You have unsaved changes that will be lost." },
    confirmBridge: { type: Boolean, default: false },
  };
  static actions = ["markClean", "acceptRestore"] as const;
  static events = ["dirty", "guard"] as const;

  declare messageValue: string;
  declare confirmBridgeValue: boolean;

  #baseline = "";
  #dirty = false;
  #beforeunloadBound = false;
  readonly #timeouts = new SafeTimeout();
  /** Whether the active submission still represents the form's current values. */
  #submitting = false;
  #submitAttempt: SubmitAttempt | null = null;
  #submittedBaseline: string | null = null;
  #activeSubmission: unknown | null = null;
  #unregisterVisit: (() => void) | null = null;

  readonly #onFieldChange = (): void => {
    // An edit after submission belongs to a new unsaved revision. Keep the
    // submitted snapshot for submit-end, but stop suppressing navigation now.
    this.#submitting = false;
    this.#evaluate();
  };

  readonly #onSubmit = (event: Event): void => {
    const attempt: SubmitAttempt = { event, snapshot: this.#serialize() };
    this.#submitAttempt = attempt;
    this.#submitting = true;
    // Native navigation runs before the next task. If it does not navigate and
    // Turbo never claims the attempt, the form must not remain suppressed.
    this.#timeouts.set(() => {
      if (this.#submitAttempt !== attempt) return;
      this.#submitting = false;
    }, 0);
  };

  readonly #onFormData = (): void => {
    if (this.#submitAttempt === null) return;
    // Turbo constructs FormData after target-level submit consumers have run.
    // Capturing here reflects exactly that revision, even when an asynchronous
    // confirmation delays turbo:submit-start and the user edits in the meantime.
    this.#submitAttempt.snapshot = this.#serialize();
  };

  readonly #onSubmitStart = (event: Event): void => {
    const detail = (event as CustomEvent<TurboSubmitDetail>).detail;
    this.#activeSubmission = detail?.formSubmission ?? event;
    this.#submittedBaseline = this.#submitAttempt?.snapshot ?? this.#serialize();
    this.#submitAttempt = null;
    this.#submitting = this.#serialize() === this.#submittedBaseline;
  };

  readonly #onSubmitEnd = (event: Event): void => {
    const detail = (event as CustomEvent<TurboSubmitDetail>).detail;
    if (
      detail?.formSubmission !== undefined &&
      (this.#activeSubmission === null || detail.formSubmission !== this.#activeSubmission)
    ) {
      return;
    }
    const submittedBaseline = this.#submittedBaseline;
    this.#submitting = false;
    this.#submittedBaseline = null;
    this.#activeSubmission = null;
    if (detail?.success === false) return;
    if (submittedBaseline === null) {
      this.markClean();
      return;
    }
    // The server accepted the submitted revision, not edits made after it left.
    this.#baseline = submittedBaseline;
    this.#evaluate();
  };

  readonly #onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!this.#dirty || this.#guardSuppressed()) return;
    event.preventDefault();
    // Legacy requirement: a non-empty returnValue triggers the native prompt.
    event.returnValue = this.messageValue;
  };

  override connect(): void {
    this.#resetSubmission();
    this.#baseline = this.#serialize();
    this.#setDirty(false);
    // Re-baselining means the restored values ARE the clean state, so a stale
    // data-dirty captured in a Turbo cache snapshot mid-edit must not linger
    // (the guard would not fire, but consumer CSS would keep claiming "unsaved").
    this.element.removeAttribute("data-dirty");
    this.element.addEventListener("input", this.#onFieldChange);
    this.element.addEventListener("change", this.#onFieldChange);
    this.element.addEventListener("submit", this.#onSubmit);
    this.element.addEventListener("formdata", this.#onFormData);
    this.element.addEventListener("turbo:submit-start", this.#onSubmitStart);
    this.element.addEventListener("turbo:submit-end", this.#onSubmitEnd);
    this.#unregisterVisit = registerVisitParticipant(this.element.ownerDocument, {
      form: this.element,
      evaluate: (event) => this.#evaluateVisit(event),
    });
  }

  override disconnect(): void {
    this.element.removeEventListener("input", this.#onFieldChange);
    this.element.removeEventListener("change", this.#onFieldChange);
    this.element.removeEventListener("submit", this.#onSubmit);
    this.element.removeEventListener("formdata", this.#onFormData);
    this.element.removeEventListener("turbo:submit-start", this.#onSubmitStart);
    this.element.removeEventListener("turbo:submit-end", this.#onSubmitEnd);
    this.#unregisterVisit?.();
    this.#unregisterVisit = null;
    this.#unbindBeforeUnload();
    this.#resetSubmission();
  }

  /** Re-baselines to the current values and clears the dirty state (e.g. after a save). */
  markClean(): void {
    this.#baseline = this.#serialize();
    this.#setDirty(false);
  }

  /** Adopts restored values without erasing an already-dirty user revision. */
  acceptRestore(): void {
    if (this.#dirty) return;
    this.markClean();
  }

  /** Recomputes dirty against the baseline and flips state when it changes. */
  #evaluate(): void {
    this.#setDirty(this.#serialize() !== this.#baseline);
  }

  #setDirty(dirty: boolean): void {
    if (dirty === this.#dirty) return;
    this.#dirty = dirty;
    if (dirty) {
      this.element.setAttribute("data-dirty", "true");
      this.#bindBeforeUnload();
    } else {
      this.element.removeAttribute("data-dirty");
      this.#unbindBeforeUnload();
    }
    this.dispatch("dirty", { detail: { dirty } });
  }

  /** Evaluates this form for the document-level Turbo visit coordinator. */
  #evaluateVisit(event: Event): VisitDecision {
    if (!this.#dirty || this.#guardSuppressed()) return null;
    const guard = this.dispatch("guard", { detail: { event }, cancelable: true });
    if (guard.defaultPrevented) return { kind: "block" };
    // A guard consumer may have saved, submitted, or removed the form synchronously.
    if (!this.element.isConnected || !this.#dirty || this.#guardSuppressed()) return null;
    if (this.confirmBridgeValue) return { kind: "block" };
    return { kind: "confirm", message: this.messageValue };
  }

  #bindBeforeUnload(): void {
    if (this.#beforeunloadBound) return;
    window.addEventListener("beforeunload", this.#onBeforeUnload);
    this.#beforeunloadBound = true;
  }

  #unbindBeforeUnload(): void {
    if (!this.#beforeunloadBound) return;
    window.removeEventListener("beforeunload", this.#onBeforeUnload);
    this.#beforeunloadBound = false;
  }

  #guardSuppressed(): boolean {
    return (
      this.#submitting &&
      (this.#submitAttempt === null || !this.#submitAttempt.event.defaultPrevented)
    );
  }

  #resetSubmission(): void {
    this.#timeouts.clearAll();
    this.#submitting = false;
    this.#submitAttempt = null;
    this.#submittedBaseline = null;
    this.#activeSubmission = null;
  }

  /** Stable serialization of the form's controls for change detection. */
  #serialize(): string {
    const parts: SerializedControl[] = [];
    for (const el of Array.from(this.element.elements)) {
      const name = this.#nameOf(el);
      if (name === null) continue;
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        parts.push([el.type, name, el.value, el.checked ? 1 : 0]);
      } else if (el instanceof HTMLSelectElement) {
        // Keep multi-select values structural so option values containing commas cannot collide.
        const value = el.multiple
          ? Array.from(el.selectedOptions).map((option) => option.value)
          : el.value;
        parts.push([el.type, name, value]);
      } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        parts.push([el.type, name, el.value]);
      }
    }
    return JSON.stringify(parts);
  }

  /** A stable key for a control, or null for elements without value semantics. */
  #nameOf(el: Element): string | null {
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      return el.name || el.id || "";
    }
    return null;
  }
}
