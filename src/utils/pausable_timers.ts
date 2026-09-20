import { KeyedTimers } from "./keyed_timers";

/** What a key needs to carry on: the work, when it was last armed, and who is holding it. */
interface Entry {
  callback: () => void;
  /** Epoch ms the running timer was armed at; written only where the timer is armed. */
  startedAt: number;
  remaining: number;
  reasons: Set<string>;
}

/**
 * Keeps one self-dismissing timer per key that a person can hold open.
 *
 * A notification that takes itself away has to stop while the pointer is over it
 * or the focus is inside it, and pick up where it left off once both have gone
 * (WAI-ARIA and WCAG 2.2 call this being able to pause a time limit). Each reason
 * to hold is tracked on its own, because a pointer leaving while focus stays is
 * not a release: the time left is banked when the first reason arrives, and the
 * timer is armed again with that bank only after the last one is released.
 *
 * **Holding never dismisses.** A deadline that passed while the timer sat queued
 * — a throttled tab, a long task — is banked as one millisecond, so the
 * notification goes right after the last reason is released rather than during
 * the event that holds it. Taking it away there would remove the element under
 * the pointer, or the control that has focus, and focus would fall to the body.
 *
 * Arming a held key keeps the hold and banks the new delay for the resume, so a
 * duration that changes at runtime reaches a held notification without
 * dismissing it or releasing it.
 *
 * Scope is the timer and its hold. Whether a key may be held at all, and the
 * state hook that shows it is held, stay with the consumer.
 *
 * @example
 * ```ts
 * readonly #dismiss = new PausableTimers<HTMLElement>();
 *
 * pause(event: Event): void {
 *   const item = this.#itemFromEvent(event);
 *   if (item && this.#dismiss.pause(item, this.#pauseReason(event))) {
 *     item.setAttribute("data-paused", "true");
 *   }
 * }
 * ```
 */
export class PausableTimers<K> {
  readonly #timers = new KeyedTimers<K>();

  /** Every key armed or held; an entry goes as its timer fires, or with the key. */
  readonly #entries = new Map<K, Entry>();

  /**
   * Arms `callback` after `delay` ms for `key`, replacing whatever `key` had.
   * A held key stays held and banks `delay` for its resume.
   */
  set(key: K, callback: () => void, delay: number): void {
    const reasons = this.#entries.get(key)?.reasons ?? new Set<string>();
    const entry: Entry = { callback, startedAt: 0, remaining: delay, reasons };
    this.#entries.set(key, entry);
    if (reasons.size === 0) this.#arm(key, entry);
  }

  /**
   * Holds `key` for `reason` and banks the time left, with a floor of one
   * millisecond. Reports whether this call is the one that stopped a running
   * timer, so the caller can write its held-state hook exactly once.
   */
  pause(key: K, reason: string): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    entry.reasons.add(reason);
    if (!this.#timers.has(key)) return false;
    this.#timers.clear(key);
    entry.remaining = Math.max(1, entry.remaining - (Date.now() - entry.startedAt));
    return true;
  }

  /**
   * Releases `reason` on `key`, arming the banked time again once no reason is
   * left. Reports whether this call is the one that started the timer again.
   */
  resume(key: K, reason: string): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    entry.reasons.delete(reason);
    if (entry.reasons.size > 0 || this.#timers.has(key)) return false;
    this.#arm(key, entry);
    return true;
  }

  /** Whether `key` is armed or held — that is, whether this registry drives it at all. */
  tracks(key: K): boolean {
    return this.#entries.has(key);
  }

  /** Cancels `key`'s timer and drops its hold. */
  clear(key: K): void {
    this.#timers.clear(key);
    this.#entries.delete(key);
  }

  /**
   * Cancels every timer and forgets every key. Call this from a controller's
   * `disconnect()` so neither a timer nor a hold outlives the element.
   */
  clearAll(): void {
    this.#timers.clearAll();
    this.#entries.clear();
  }

  /** Starts `entry`'s banked time running for `key`, and drops it as it fires. */
  #arm(key: K, entry: Entry): void {
    entry.startedAt = Date.now();
    this.#timers.set(
      key,
      () => {
        this.#entries.delete(key);
        entry.callback();
      },
      entry.remaining,
    );
  }
}
