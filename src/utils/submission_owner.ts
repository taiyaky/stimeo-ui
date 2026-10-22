/** The optional identity and result carried by a Turbo submission event. */
interface SubmissionDetail {
  readonly formSubmission?: unknown;
  readonly success?: unknown;
}

/** One event source's latest submission, including an unnamed synthetic one. */
interface OwnedSubmission {
  readonly source: EventTarget | null;
  readonly token: unknown;
}

/**
 * Owns the latest submission start and consumes its matching terminal once.
 *
 * Both the event source and the submission token must match. A missing or null
 * token pairs synthetic events from that same source, independently of named
 * submissions. Only `success: true` confirms a consumed terminal; every other
 * result is a failure. Callers own snapshots, UI effects, and the lifetime of
 * this owner, and clear it when that lifetime ends.
 */
export class SubmissionOwner {
  readonly #synthetic = Symbol("synthetic submission");
  #active: OwnedSubmission | null = null;

  /** Gives the event's submission ownership, superseding any previous start. */
  begin(event: Event): void {
    this.#active = { source: event.target, token: this.#tokenOf(event) };
  }

  /** Consumes a matching terminal before returning its result, or ignores it. */
  resolve(event: Event): boolean | null {
    if (
      this.#active === null ||
      this.#active.source !== event.target ||
      this.#active.token !== this.#tokenOf(event)
    ) {
      return null;
    }
    this.clear();
    return this.#detailOf(event)?.success === true;
  }

  /** Drops ownership without resolving a submission or producing side effects. */
  clear(): void {
    this.#active = null;
  }

  #tokenOf(event: Event): unknown {
    return this.#detailOf(event)?.formSubmission ?? this.#synthetic;
  }

  #detailOf(event: Event): SubmissionDetail | null | undefined {
    return (event as CustomEvent<SubmissionDetail | null | undefined>).detail;
  }
}
