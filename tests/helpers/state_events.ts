/**
 * Captures the state events a controller dispatches while a test drives it.
 *
 * A state event is an assertion about a move, so a test has to be able to say
 * "nothing was dispatched" as easily as "one `close` with this reason". Reading
 * a shared list makes both the same assertion, and keeps the order visible when
 * a single interaction closes one panel and opens another.
 */

/** One dispatched event, reduced to what the contract promises. */
export interface CapturedStateEvent {
  /** The event name without the controller's identifier prefix. */
  readonly name: string;
  readonly detail: Record<string, unknown>;
  readonly cancelable: boolean;
  readonly bubbles: boolean;
}

/** A live recording that a test reads, resets, and finally detaches. */
export interface StateEventCapture {
  /** Every event seen so far, in dispatch order. */
  readonly seen: CapturedStateEvent[];
  /** The names seen so far, in dispatch order. */
  names(): string[];
  /** Each event's `detail.reason`, in dispatch order. */
  reasons(): unknown[];
  /** Drops everything seen so far, so the next assertion starts from zero. */
  clear(): void;
  /** Detaches every listener this capture added. */
  stop(): void;
}

/**
 * Records the named events of one controller identifier.
 *
 * @param identifier - The controller identifier, e.g. `stimeo--dropdown`.
 * @param names - Event names to record, without the identifier prefix.
 * @param target - Where to listen. The document catches every instance; pass a
 *   root element to scope the recording to one.
 */
export function captureStateEvents(
  identifier: string,
  names: readonly string[] = ["open", "close"],
  target: EventTarget = document,
): StateEventCapture {
  const seen: CapturedStateEvent[] = [];
  const detach = names.map((name) => {
    const type = `${identifier}:${name}`;
    const listener = (event: Event): void => {
      seen.push({
        name,
        detail: ((event as CustomEvent).detail ?? {}) as Record<string, unknown>,
        cancelable: event.cancelable,
        bubbles: event.bubbles,
      });
    };
    target.addEventListener(type, listener);
    return (): void => target.removeEventListener(type, listener);
  });

  return {
    seen,
    names: () => seen.map((entry) => entry.name),
    reasons: () => seen.map((entry) => entry.detail.reason),
    clear: () => {
      seen.length = 0;
    },
    stop: () => {
      for (const off of detach) off();
    },
  };
}
