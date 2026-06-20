import { Controller } from "@hotwired/stimulus";

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
 * `guard` event; if a consumer cancels it (or `confirmBridge` is set) the visit is
 * blocked, otherwise it falls back to a native `confirm(message)`. While a submit is
 * in flight the guard is suppressed (so a legitimate submit never prompts); the dirty
 * state is cleared only on a successful `turbo:submit-end`, and a failed submit
 * re-arms the guard. `markClean` clears it manually (e.g. after a custom save).
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
  static actions = ["markClean"] as const;
  static events = ["dirty", "guard"] as const;

  declare messageValue: string;
  declare confirmBridgeValue: boolean;

  #baseline = "";
  #dirty = false;
  #beforeunloadBound = false;
  /** True between a form `submit` and its `turbo:submit-end`, suppressing the guard. */
  #submitting = false;

  readonly #onFieldChange = (): void => {
    // Any edit means the user is actively working again, so a prior submit that
    // never resolved (e.g. one cancelled client-side, with no turbo:submit-end)
    // must not keep the guard suppressed.
    this.#submitting = false;
    this.#evaluate();
  };

  readonly #onSubmit = (): void => {
    // A real submit is leaving on purpose: suppress the guard for the in-flight
    // request. We do NOT clear the baseline yet — a failed submit must stay dirty.
    this.#submitting = true;
  };

  readonly #onBeforeVisit = (event: Event): void => {
    this.#guardVisit(event);
  };

  readonly #onSubmitEnd = (event: Event): void => {
    this.#submitting = false;
    const success = (event as CustomEvent<{ success?: boolean }>).detail?.success;
    // Only a successful submit clears the dirty state; a failure re-arms the guard.
    if (success !== false) this.markClean();
  };

  readonly #onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!this.#dirty || this.#submitting) return;
    event.preventDefault();
    // Legacy requirement: a non-empty returnValue triggers the native prompt.
    event.returnValue = this.messageValue;
  };

  override connect(): void {
    this.#baseline = this.#serialize();
    // Re-baselining means the restored values ARE the clean state, so a stale
    // data-dirty captured in a Turbo cache snapshot mid-edit must not linger
    // (the guard would not fire, but consumer CSS would keep claiming "unsaved").
    this.element.removeAttribute("data-dirty");
    this.element.addEventListener("input", this.#onFieldChange);
    this.element.addEventListener("change", this.#onFieldChange);
    this.element.addEventListener("submit", this.#onSubmit);
    this.element.addEventListener("turbo:submit-end", this.#onSubmitEnd);
    document.addEventListener("turbo:before-visit", this.#onBeforeVisit);
  }

  override disconnect(): void {
    this.element.removeEventListener("input", this.#onFieldChange);
    this.element.removeEventListener("change", this.#onFieldChange);
    this.element.removeEventListener("submit", this.#onSubmit);
    this.element.removeEventListener("turbo:submit-end", this.#onSubmitEnd);
    document.removeEventListener("turbo:before-visit", this.#onBeforeVisit);
    this.#unbindBeforeUnload();
  }

  /** Re-baselines to the current values and clears the dirty state (e.g. after a save). */
  markClean(): void {
    this.#baseline = this.#serialize();
    this.#setDirty(false);
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

  /** Guards a Turbo visit while dirty: consumer cancel → confirmBridge → confirm. */
  #guardVisit(event: Event): void {
    if (!this.#dirty || this.#submitting) return;
    const guard = this.dispatch("guard", { detail: { event }, cancelable: true });
    if (guard.defaultPrevented) {
      event.preventDefault();
      return;
    }
    if (this.confirmBridgeValue) {
      // Defer the actual prompt to a consumer-wired Confirm Bridge (via the guard
      // event); block the visit here so nothing navigates before it decides.
      event.preventDefault();
      return;
    }
    if (!window.confirm(this.messageValue)) {
      event.preventDefault();
    }
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

  /** Stable serialization of the form's controls for change detection. */
  #serialize(): string {
    const parts: string[] = [];
    for (const el of Array.from(this.element.elements)) {
      const name = this.#nameOf(el);
      if (name === null) continue;
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        parts.push(`${name}:${el.checked ? 1 : 0}`);
      } else if (el instanceof HTMLSelectElement) {
        // Single select: read `value` (robust); multi-select: join the selected values.
        const value = el.multiple
          ? Array.from(el.selectedOptions)
              .map((o) => o.value)
              .join(",")
          : el.value;
        parts.push(`${name}:${value}`);
      } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        parts.push(`${name}:${el.value}`);
      }
    }
    return parts.join("|");
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
