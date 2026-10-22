import { ListenerSet } from "./listener_set";

/**
 * Confirms waiting elements' hover state on the next pointer movement in one document.
 *
 * A wait reads no layout and owns no pause reason. The consumer keeps a suspension
 * until this utility reports a non-hovered element. Each movement consumes the current
 * waits, including hovered elements, and detaches its capture/passive listener before
 * callbacks run. A callback may cancel other entries, dispose the batch or wait again;
 * cancelled and replaced entries are skipped, and new waits belong to the next movement.
 * Cancellation never calls the release callback. Call {@link HoverRecheck.dispose} on
 * disconnect; the same instance can then accept waits for another connection.
 *
 * The supplied document is the event source for this instance. Elements waited on must
 * belong to that document; cancel and use an instance for the destination when adopting them.
 */
export class HoverRecheck<T extends Element = Element> {
  readonly #document: Document;
  readonly #release: (element: T) => void;
  readonly #listeners = new ListenerSet();
  readonly #pending = new Set<T>();
  /** Weak tickets invalidate snapshots without retaining consumed elements. */
  #tickets = new WeakMap<T, symbol>();

  constructor(document: Document, release: (element: T) => void) {
    this.#document = document;
    this.#release = release;
  }

  /** Waits once per element; a wait during a callback replaces an older queued reading. */
  wait(element: T): void {
    this.#pending.add(element);
    this.#tickets.set(element, Symbol());
    this.#listeners.add(this.#document, "pointermove", this.#onPointerMove, {
      capture: true,
      passive: true,
    });
  }

  /** Cancels a pending or unprocessed reading without releasing the consumer's hold. */
  cancel(element: T): void {
    this.#tickets.delete(element);
    this.#pending.delete(element);
    if (this.#pending.size === 0) this.#listeners.dispose();
  }

  /** Cancels all readings and listeners, including unprocessed entries of a live callback. */
  dispose(): void {
    this.#listeners.dispose();
    this.#pending.clear();
    this.#tickets = new WeakMap();
  }

  /** Consumes the old batch before invoking callbacks, preserving their newer waits. */
  readonly #onPointerMove = (): void => {
    this.#listeners.dispose();
    const waiting = [...this.#pending].map(
      (element) => [element, this.#tickets.get(element)] as const,
    );
    this.#pending.clear();
    for (const [element, ticket] of waiting) {
      if (this.#tickets.get(element) !== ticket) continue;
      if (element.matches(":hover")) continue;
      this.#release(element);
    }
  };
}
