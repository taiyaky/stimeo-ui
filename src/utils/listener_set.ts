/**
 * Owns every listener a controller attaches for one connected lifetime and
 * releases them together, so an event name is spelled once and the release
 * cannot drift from the registration.
 *
 * Detaching by hand repeats three things at the release site — the type, the
 * handler reference and the capture flag — and any one of them drifting leaves
 * a listener alive on an element the controller no longer drives. Aborting the
 * signal a registration was created with releases it whatever it was made of,
 * so the release site names nothing.
 *
 * One set per lifetime, held as a field and never rebuilt. {@link
 * ListenerSet.dispose} is the only thing that closes a generation, and it opens
 * the next one in the same step, so the lifecycle hooks can call `add` and
 * `dispose` in any order any number of times, and no `add` ever meets an
 * already aborted signal — a DOM that registers a listener on such a signal
 * would keep it forever. Rebuilding the set instead would leak:
 * `addEventListener` matches an existing registration on target, type, callback
 * and capture alone, so re-adding the same handler while the first registration
 * is live is discarded, and that live registration keeps the signal it was
 * attached with — a set built by a second `connect()` can never release what it
 * appears to own.
 *
 * Scope is the registration only. Timers, observers, leases and the order they
 * are unwound in stay with the controller, so `dispose()` belongs exactly where
 * the `removeEventListener` block stood. A receiver that changes at runtime (a
 * swapped target) is rebound by calling `dispose()` and then `add()` again from
 * the rebind, not by a second set.
 *
 * The set must own every registration of a tuple it holds: a listener the same
 * target already carries for the same type, callback and capture flag keeps the
 * right to remove it, and this set's `add` for that tuple is discarded. A
 * subscription shared between instances behind a participant count, or one that
 * lives for less than the connection, keeps its own pair of calls.
 *
 * This file's own doc block is dropped from `dist`, but every member comment is
 * inlined into each consumer entry (`tsup` builds with `splitting: false`), so
 * rationale belongs here and only the contract belongs on the members.
 *
 * @example
 * ```ts
 * readonly #listeners = new ListenerSet();
 *
 * connect(): void {
 *   this.#listeners.add(this.element, "submit", this.#onNativeSubmit, { capture: true });
 *   this.#listeners.add(this.element, "turbo:submit-start", this.#onSubmitStart);
 *   this.#listeners.add(this.element, "turbo:submit-end", this.#onSubmitEnd);
 * }
 *
 * disconnect(): void {
 *   this.#listeners.dispose();
 * }
 * ```
 */
export class ListenerSet {
  /** The generation every `add` joins until the next `dispose()`. */
  #abort = new AbortController();

  /**
   * Attaches `handler` to the open generation, exactly as the caller spelled it.
   *
   * The set supplies the signal, so `options` carries everything else the DOM
   * accepts — `capture` included, which has to match at release time and no
   * longer has a second place to drift from.
   */
  add(
    target: EventTarget,
    type: string,
    handler: EventListener,
    options?: Omit<AddEventListenerOptions, "signal">,
  ): void {
    target.addEventListener(type, handler, { ...options, signal: this.#abort.signal });
  }

  /**
   * Releases every listener of the open generation, synchronously, and opens the
   * next one. Idempotent, and safe before anything has been added.
   */
  dispose(): void {
    this.#abort.abort();
    this.#abort = new AbortController();
  }
}
