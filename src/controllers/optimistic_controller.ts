import { Controller } from "@hotwired/stimulus";

/** Marker recording that this controller toggled the element's `hidden`. */
const TOGGLED_MARKER = "data-optimistic-toggled";

/**
 * Headless **optimistic UI** for Turbo form submissions — the one server-bound
 * behavior that needs no Action Cable: it wraps a Turbo form
 * and applies a *declared* optimistic state the moment the submission starts,
 * keeps it when the server confirms, and **rolls it back** when the submission
 * fails. The pattern: flip the like button instantly; the success response (a
 * Turbo Stream) replaces the fragment with the server truth anyway, so the
 * client only needs the instant flip and the failure rollback. Core (zero
 * dependencies — it rides Turbo's own `turbo:submit-*` events).
 *
 * Markup contract (identifier: `stimeo--optimistic`):
 *   <form data-controller="stimeo--optimistic" method="post" action="/likes">
 *     <button type="submit" aria-label="Like">
 *       <span data-stimeo--optimistic-target="hide">♡</span>
 *       <span hidden data-stimeo--optimistic-target="show">♥</span>
 *     </button>
 *   </form>
 *
 * On `turbo:submit-start`, every `show` target is unhidden and every `hide`
 * target hidden (each mutation marker-tracked, so already-correct states are
 * untouched), the element gains `data-optimistic="true"` + `aria-busy="true"`.
 * On `turbo:submit-end`: success clears the pending hook and dispatches
 * `commit` (the toggled state stays — the server response owns the final DOM);
 * failure reverts exactly the mutations this controller made and dispatches
 * `rollback`.
 *
 * @remarks
 * Behavior only — what "optimistic" looks like is the author's markup (the
 * show/hide pair) and CSS (`[data-optimistic="true"]`). Pairs with
 * `stimeo--submit-once` (double-submit guard) and `stimeo--live-counter`
 * (optimistic numbers). The listeners are delegated on the element (nested or
 * swapped forms keep working) and removed on `disconnect()`; `connect()` is
 * idempotent — a Turbo cache snapshot taken mid-submit is rolled back, since
 * no submission can be in flight across a restore.
 */
export class OptimisticController extends Controller<HTMLElement> {
  static override targets = ["show", "hide"];
  static events = ["commit", "rollback"] as const;

  declare readonly showTargets: HTMLElement[];
  declare readonly hideTargets: HTMLElement[];

  override connect(): void {
    // A submission cannot be in flight across a navigation: revert whatever a
    // Turbo cache snapshot preserved mid-submit (idempotent reconnect).
    if (this.element.hasAttribute("data-optimistic")) this.#revert();
    this.element.addEventListener("turbo:submit-start", this.#onSubmitStart);
    this.element.addEventListener("turbo:submit-end", this.#onSubmitEnd);
  }

  override disconnect(): void {
    this.element.removeEventListener("turbo:submit-start", this.#onSubmitStart);
    this.element.removeEventListener("turbo:submit-end", this.#onSubmitEnd);
  }

  readonly #onSubmitStart = (): void => {
    this.element.setAttribute("data-optimistic", "true");
    this.element.setAttribute("aria-busy", "true");
    for (const target of this.showTargets) this.#toggleHidden(target, false);
    for (const target of this.hideTargets) this.#toggleHidden(target, true);
  };

  readonly #onSubmitEnd = (event: Event): void => {
    const success = (event as CustomEvent<{ success?: boolean }>).detail?.success === true;
    this.element.removeAttribute("aria-busy");
    if (success) {
      // Keep the optimistic state (the server response owns the final DOM;
      // markers are dropped so a later failure cannot revert a confirmed state).
      this.element.removeAttribute("data-optimistic");
      for (const target of [...this.showTargets, ...this.hideTargets]) {
        target.removeAttribute(TOGGLED_MARKER);
      }
      this.dispatch("commit");
    } else {
      this.#revert();
      this.dispatch("rollback");
    }
  };

  /** Sets `hidden` only when it actually changes, marker-tracking the mutation. */
  #toggleHidden(target: HTMLElement, hidden: boolean): void {
    if (target.hidden === hidden) return;
    target.hidden = hidden;
    target.setAttribute(TOGGLED_MARKER, "true");
  }

  /** Reverts exactly the mutations this controller made (marker-owned only). */
  #revert(): void {
    this.element.removeAttribute("data-optimistic");
    this.element.removeAttribute("aria-busy");
    for (const target of [...this.showTargets, ...this.hideTargets]) {
      if (target.hasAttribute(TOGGLED_MARKER)) {
        target.hidden = !target.hidden;
        target.removeAttribute(TOGGLED_MARKER);
      }
    }
  }
}
