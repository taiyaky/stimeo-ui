/** What ended an owned pointer session. */
export type OwnedPointerSessionEnd = "up" | "cancel" | "teardown";

/** Callbacks driven by one owned pointer until it ends or is cancelled. */
export interface OwnedPointerSessionHandlers {
  /** Receives movement from the initiating pointer only. */
  readonly move: (event: PointerEvent) => void;
  /**
   * Runs once after every listener and pointer capture have been released,
   * naming what ended the session.
   */
  readonly end?: (kind: OwnedPointerSessionEnd) => void;
}

/**
 * Owns one pointer across document-level movement and termination events.
 *
 * A controller may have at most one instance at a time. The session filters
 * every event by the initiating `pointerId` and binds all document listeners to
 * one abort signal, so exactly one callback runs when the session ends.
 *
 * **Pointer capture is delivery, not lifetime.** It is taken when the DOM
 * implementation supports it, and losing it — a consumer re-inserting the owner
 * mid-gesture, another element claiming the pointer — never ends the session:
 * the document listeners receive the pointer either way, because a captured
 * event still bubbles to the document and an uncaptured one fires there anyway.
 * An owner that actually left the tree is the owner's own business; every
 * consumer already answers that question with its own detach probe, and a
 * second answer here would cut gestures the consumer means to keep.
 */
export class OwnedPointerSession {
  readonly #pointerId: number;
  readonly #owner: HTMLElement;
  readonly #handlers: OwnedPointerSessionHandlers;
  readonly #abort = new AbortController();
  #active = true;

  constructor(start: PointerEvent, owner: HTMLElement, handlers: OwnedPointerSessionHandlers) {
    this.#pointerId = start.pointerId;
    this.#owner = owner;
    this.#handlers = handlers;

    const { signal } = this.#abort;
    owner.ownerDocument.addEventListener("pointermove", this.#onMove, { signal });
    owner.ownerDocument.addEventListener("pointerup", this.#onEndEvent, { signal });
    owner.ownerDocument.addEventListener("pointercancel", this.#onEndEvent, { signal });

    // Pointer capture is progressive here: happy-dom and older DOM shims may not
    // implement it, while the document listeners still preserve ownership.
    try {
      owner.setPointerCapture?.(this.#pointerId);
    } catch {
      // A synthetic or already-ended pointer cannot be captured; filtering and
      // AbortController teardown remain sufficient for that environment.
    }
  }

  /** Releases capture and listeners, then reports the end exactly once. */
  end(): void {
    this.#finish("teardown");
  }

  #finish(kind: OwnedPointerSessionEnd): void {
    if (!this.#active) return;
    this.#active = false;
    this.#abort.abort();
    try {
      this.#owner.releasePointerCapture?.(this.#pointerId);
    } catch {
      // Losing capture because the owner detached is already an ended session.
    }
    this.#handlers.end?.(kind);
  }

  #owns(event: PointerEvent): boolean {
    return this.#active && event.pointerId === this.#pointerId;
  }

  readonly #onMove = (event: PointerEvent): void => {
    if (this.#owns(event)) this.#handlers.move(event);
  };

  readonly #onEndEvent = (event: PointerEvent): void => {
    if (this.#owns(event)) this.#finish(event.type === "pointerup" ? "up" : "cancel");
  };
}
