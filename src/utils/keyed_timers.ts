import { SafeTimeout } from "./safe_timeout";

/**
 * Keeps at most one pending timer per key, and releases them all together.
 *
 * A region, a row, a message or a speaker that is armed again while its earlier
 * timer is still pending must end up with exactly one timer deciding when its
 * state ends. Two timers on one key means the earlier deadline wins: it cuts the
 * new emphasis short, clears text written after it, or drops a speaker who is
 * still typing — and then reports an ending for a state that is already gone.
 * Arming through this registry cancels the key's earlier timer in the same step,
 * and no timer id ever reaches the caller.
 *
 * An entry lives exactly as long as its timer: it goes as the timer fires, and
 * the whole ledger goes on `clearAll()`. That is a correctness rule, not
 * tidiness — a platform may hand an id released by `clearTimeout` to the next
 * timer it creates, so an entry that outlived its timer would let a later
 * `clear()` on that key cancel whatever timer now holds the id, on some other
 * key entirely.
 *
 * The ledger is a plain `Map`, and the key may be anything. Weak keys would
 * retain nothing less: while a timer is pending the platform already holds the
 * key through the callback, and the entry is gone the moment the timer is.
 *
 * Scope is the one-per-key timer only. What the timer means, and the roster of
 * keys it is armed for, stay with the consumer, so a second kind of timer on the
 * same keys (a transition wait, an animation frame) is a second registry, and a
 * timer that belongs to no key stays on a plain `SafeTimeout`.
 *
 * @example
 * ```ts
 * readonly #expiry = new KeyedTimers<string>();
 *
 * #onSignal(name: string): void {
 *   this.#expiry.set(name, () => this.#drop(name), this.#timeout);
 * }
 *
 * disconnect(): void {
 *   this.#expiry.clearAll();
 * }
 * ```
 */
export class KeyedTimers<K> {
  readonly #timers = new SafeTimeout();

  /** The pending timer of each key; an entry lives exactly as long as its timer. */
  readonly #pending = new Map<K, number>();

  /**
   * Arms `callback` after `delay` ms for `key`, cancelling the timer `key` had
   * pending. The entry is dropped before the callback runs, so the callback sees
   * the key unarmed and may arm it again for the next round.
   */
  set(key: K, callback: () => void, delay: number): void {
    this.clear(key);
    const id = this.#timers.set(() => {
      this.#pending.delete(key);
      callback();
    }, delay);
    this.#pending.set(key, id);
  }

  /**
   * Cancels `key`'s pending timer, if it has one.
   *
   * A timer id is a positive integer, so `-1` stands for "nothing pending" and
   * the registry ignores an id it does not own — the unarmed case needs no
   * branch of its own, and no other key's timer can be reached from here.
   */
  clear(key: K): void {
    this.#timers.clear(this.#pending.get(key) ?? -1);
    this.#pending.delete(key);
  }

  /**
   * Cancels every pending timer and forgets every key. Call this from a
   * controller's `disconnect()` so no timer, and no entry, outlives the element.
   */
  clearAll(): void {
    this.#timers.clearAll();
    this.#pending.clear();
  }

  /** Whether `key` has a timer pending. */
  has(key: K): boolean {
    return this.#pending.has(key);
  }
}
