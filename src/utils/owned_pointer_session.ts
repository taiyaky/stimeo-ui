/** Callbacks driven by one owned pointer until it ends or is cancelled. */
export interface OwnedPointerSessionHandlers {
  /** Receives movement from the initiating pointer only. */
  readonly move: (event: PointerEvent) => void;
  /** Runs once after every listener and pointer capture have been released. */
  readonly end?: () => void;
}

/**
 * Owns one pointer across document-level movement and termination events.
 *
 * A controller may have at most one instance at a time. The session filters
 * every event by the initiating `pointerId`, captures the pointer when the DOM
 * implementation supports it, and binds all fallback document listeners to one
 * abort signal. Calling {@link OwnedPointerSession.end} is idempotent.
 */
export class OwnedPointerSession {
  readonly pointerId: number;
  readonly #owner: HTMLElement;
  readonly #handlers: OwnedPointerSessionHandlers;
  readonly #abort = new AbortController();
  #active = true;

  constructor(start: PointerEvent, owner: HTMLElement, handlers: OwnedPointerSessionHandlers) {
    this.pointerId = start.pointerId;
    this.#owner = owner;
    this.#handlers = handlers;

    const { signal } = this.#abort;
    owner.ownerDocument.addEventListener("pointermove", this.#onMove, { signal });
    owner.ownerDocument.addEventListener("pointerup", this.#onEndEvent, { signal });
    owner.ownerDocument.addEventListener("pointercancel", this.#onEndEvent, { signal });
    owner.addEventListener("lostpointercapture", this.#onLostCapture, { signal });

    // Pointer capture is progressive here: happy-dom and older DOM shims may not
    // implement it, while the document listeners still preserve ownership.
    try {
      owner.setPointerCapture?.(this.pointerId);
    } catch {
      // A synthetic or already-ended pointer cannot be captured; filtering and
      // AbortController teardown remain sufficient for that environment.
    }
  }

  /** Whether this session still owns its pointer and listeners. */
  get active(): boolean {
    return this.#active;
  }

  /** Whether `event` belongs to the initiating pointer of the live session. */
  owns(event: PointerEvent): boolean {
    return this.#active && event.pointerId === this.pointerId;
  }

  /** Releases capture/listeners and invokes the end callback exactly once. */
  end(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#abort.abort();
    try {
      this.#owner.releasePointerCapture?.(this.pointerId);
    } catch {
      // Losing capture because the owner detached is already an ended session.
    }
    this.#handlers.end?.();
  }

  readonly #onMove = (event: PointerEvent): void => {
    if (this.owns(event)) this.#handlers.move(event);
  };

  readonly #onEndEvent = (event: PointerEvent): void => {
    if (this.owns(event)) this.end();
  };

  readonly #onLostCapture = (event: Event): void => {
    const pointerId = (event as PointerEvent).pointerId;
    if (typeof pointerId === "number" && pointerId !== this.pointerId) return;
    this.end();
  };
}
