import { Controller } from "@hotwired/stimulus";
import { DetachGate } from "../utils/detach_gate";
import { ListenerSet } from "../utils/listener_set";

/** Records that this controller wrote `hidden`, and the authored value to put back. */
const HIDDEN_MARKER = "data-optimistic-toggled";

/** The same record for `aria-busy` on the controller element. */
const BUSY_MARKER = "data-optimistic-busy";

/** Marker value standing for "the attribute was not there". */
const AUTHORED_ABSENT = "absent";

/** Marker prefix carrying the authored attribute value that follows it. */
const AUTHORED_VALUE = "value:";

/**
 * Stands in for the submission a synthetic lifecycle event does not name. Turbo
 * puts a `formSubmission` on both events, so this only ever pairs hand-dispatched
 * events with each other — one shared instance, so a start and its end match.
 */
const SYNTHETIC_SUBMISSION = {};

/** The submission a Turbo lifecycle event belongs to. */
function submissionOf(event: Event): unknown {
  const detail = (event as CustomEvent<{ formSubmission?: unknown }>).detail;
  return detail?.formSubmission ?? SYNTHETIC_SUBMISSION;
}

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
 * target hidden, the element gains `data-optimistic="true"` + `aria-busy="true"`,
 * and the submission named by the event takes ownership of that state. On
 * `turbo:submit-end`: the terminal of any *other* submission is ignored; the
 * owner's terminal clears the pending hook and, on success, dispatches `commit`
 * (the toggled state stays — the server response owns the final DOM), or on
 * failure restores the authored markup and dispatches `rollback`.
 *
 * **Every write records what it displaced.** A target this controller hides or
 * reveals carries the authored `hidden` value in `data-optimistic-toggled`, and
 * the element carries the authored `aria-busy` in `data-optimistic-busy`, so a
 * rollback puts back exactly what the author wrote — not the inverse of whatever
 * the attribute says at that moment. The record lives in the DOM rather than in
 * memory because a Turbo cache snapshot has to carry it: `connect()` is what
 * rewinds a restored page.
 *
 * @remarks
 * Behavior only — what "optimistic" looks like is the author's markup (the
 * show/hide pair) and CSS (`[data-optimistic="true"]`). Pairs with
 * `stimeo--submit-once` (double-submit guard) and `stimeo--live-counter`
 * (optimistic numbers). The listeners are delegated on the element, so a form
 * nested under it (or swapped for a new one) keeps working, and the submission
 * ownership is what keeps a sibling form's terminal from resolving this state.
 * With several submissions in flight the newest start owns the optimistic state,
 * so a submission whose terminal never arrives — its form replaced mid-flight —
 * cannot strand the element. `connect()` is idempotent: a Turbo cache snapshot
 * taken mid-submit is rewound, since no submission can be in flight across a
 * restore, while an in-page move (where the submission *does* survive) keeps it.
 * On a real detach the listeners go with the element.
 */
export class OptimisticController extends Controller<HTMLElement> {
  static override targets = ["show", "hide"];
  static events = ["commit", "rollback"] as const;

  declare readonly showTargets: HTMLElement[];
  declare readonly hideTargets: HTMLElement[];

  /** The submission that owns the applied optimistic state, if any. */
  #pending: unknown = null;

  readonly #gate = new DetachGate();
  readonly #listeners = new ListenerSet();

  /** True between `connect()` and `disconnect()`, so a repeat connect rewinds nothing. */
  #connected = false;

  override connect(): void {
    // Only a page this instance did not apply the state to can be holding a stale
    // one: a restored snapshot. An in-page move and a repeat connect both leave a
    // live submission behind, so neither may rewind — the gate names the first and
    // the connected flag the second.
    const restored = !this.#connected && !this.#gate.pending;
    this.#gate.cancel();
    this.#connected = true;
    if (restored && this.element.hasAttribute("data-optimistic")) this.#revert();
    this.#listeners.add(this.element, "turbo:submit-start", this.#onSubmitStart);
    this.#listeners.add(this.element, "turbo:submit-end", this.#onSubmitEnd);
  }

  override disconnect(): void {
    this.#connected = false;
    this.#listeners.dispose();
    // Ownership outlives an in-page move: only a real detach forgets it.
    this.#gate.disconnected(this, () => {
      this.#pending = null;
    });
  }

  readonly #onSubmitStart = (event: Event): void => {
    this.#pending = submissionOf(event);
    // Turbo owns `aria-busy` on a form and marks it before this event, so what is
    // there now is Turbo's, not the author's. Recording it would put Turbo's value
    // back on a page restored mid-submit, where no terminal ever arrives to clear it.
    if (this.element instanceof HTMLFormElement && !this.element.hasAttribute(BUSY_MARKER)) {
      this.element.setAttribute(BUSY_MARKER, AUTHORED_ABSENT);
    }
    this.#write(this.element, "aria-busy", "true", BUSY_MARKER);
    this.element.setAttribute("data-optimistic", "true");
    for (const target of this.showTargets) this.#setHidden(target, false);
    for (const target of this.hideTargets) this.#setHidden(target, true);
  };

  readonly #onSubmitEnd = (event: Event): void => {
    // A terminal always names a submission, so an element holding none (nothing
    // started, or this one already resolved) falls out here too.
    if (submissionOf(event) !== this.#pending) return;
    this.#pending = null;

    const success = (event as CustomEvent<{ success?: boolean }>).detail?.success === true;
    if (success) {
      // Keep the toggled faces (the server response owns the final DOM) but drop
      // their records, so a later failure cannot revert a confirmed state.
      this.element.removeAttribute("data-optimistic");
      this.#restore(this.element, "aria-busy", BUSY_MARKER, "true");
      for (const target of [...this.showTargets, ...this.hideTargets]) {
        target.removeAttribute(HIDDEN_MARKER);
      }
      this.dispatch("commit");
    } else {
      this.#revert();
      this.dispatch("rollback");
    }
  };

  /** Hides or reveals a target, recording the authored `hidden` on first write. */
  #setHidden(target: HTMLElement, hidden: boolean): void {
    if (target.hasAttribute("hidden") === hidden) return;
    this.#write(target, "hidden", hidden ? "" : null, HIDDEN_MARKER);
  }

  /** Writes an attribute, recording what it displaced under `marker` once. */
  #write(element: Element, attribute: string, value: string | null, marker: string): void {
    if (!element.hasAttribute(marker)) {
      const authored = element.getAttribute(attribute);
      element.setAttribute(
        marker,
        authored === null ? AUTHORED_ABSENT : `${AUTHORED_VALUE}${authored}`,
      );
    }
    if (value === null) element.removeAttribute(attribute);
    else element.setAttribute(attribute, value);
  }

  /**
   * Puts back the value `marker` recorded and drops the record.
   *
   * `written` is what this controller last put in the attribute. Anything else
   * there now belongs to whoever wrote it — Turbo owns `aria-busy` on a form and
   * clears it before the terminal arrives, and a consumer may have moved a face
   * mid-flight — so the record is dropped without touching the attribute. A
   * marker this build did not write names no authored value, so the attribute
   * goes back to being absent.
   */
  #restore(element: Element, attribute: string, marker: string, written: string | null): void {
    const recorded = element.getAttribute(marker);
    if (recorded === null) return;
    element.removeAttribute(marker);
    if (element.getAttribute(attribute) !== written) return;
    if (recorded.startsWith(AUTHORED_VALUE)) {
      element.setAttribute(attribute, recorded.slice(AUTHORED_VALUE.length));
      return;
    }
    element.removeAttribute(attribute);
  }

  /**
   * Puts back exactly the markup this controller displaced (record-owned only).
   *
   * A face can be registered on both sides, and the hide pass runs last, so what
   * this controller wrote there is `hidden` — matching it against the reveal's
   * absent value instead would read as someone else's write and leave the face
   * hidden. Each target is therefore restored once, against the write it last
   * received.
   */
  #revert(): void {
    this.element.removeAttribute("data-optimistic");
    this.#restore(this.element, "aria-busy", BUSY_MARKER, "true");
    const hidden = new Set(this.hideTargets);
    for (const target of new Set([...this.showTargets, ...this.hideTargets])) {
      this.#restore(target, "hidden", HIDDEN_MARKER, hidden.has(target) ? "" : null);
    }
  }
}
