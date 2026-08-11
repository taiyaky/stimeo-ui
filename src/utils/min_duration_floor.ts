import type { SafeTimeout } from "./safe_timeout";

/**
 * Holds a transient state visible for a minimum time before letting it end.
 *
 * A loading indicator that appears and disappears within a few frames reads as a
 * flicker rather than as feedback, so several controllers keep one up for a floor
 * of `minDuration` milliseconds measured from the moment it became visible. The
 * shape is always the same: note the moment, and when the end signal arrives
 * either run it now, because the floor has already passed, or hold it on a timer
 * for whatever is left.
 *
 * The floor **borrows** a {@link SafeTimeout} instead of owning one, so a
 * controller that also schedules other work (a show delay) keeps every timer in a
 * single registry and one `clearAll()` in its teardown still drops them all.
 * Cancelling after such a bulk clear is safe: the registry no-ops on an id it no
 * longer holds.
 *
 * Scope is the floor itself. **When an end signal is allowed to arrive at all
 * stays with the controller**, because the answers differ — one keeps the first
 * queued finish and ignores repeats, another lets the newest replace it — and
 * flattening that into a shared default would silently change what the consumers
 * already promise.
 *
 * @example
 * ```ts
 * readonly #timers = new SafeTimeout();
 * readonly #floor = new MinDurationFloor(this.#timers);
 *
 * #show()  { this.#floor.begin(); … }
 * stop()   { this.#floor.schedule(this.minDurationValue, () => this.#hide()); }
 * ```
 */
export class MinDurationFloor {
  readonly #timers: SafeTimeout;

  /** Pending finish timer id, or `null` when nothing is held back. */
  #timerId: number | null = null;

  /** Epoch ms the floor is measured from. */
  #since = 0;

  /** @param timers - the controller's registry; the floor schedules into it. */
  constructor(timers: SafeTimeout) {
    this.#timers = timers;
  }

  /** Starts the floor: call when the state being held becomes visible. */
  begin(): void {
    this.#since = Date.now();
  }

  /** True while a finish is held back waiting for the floor to elapse. */
  get pending(): boolean {
    return this.#timerId !== null;
  }

  /**
   * Runs `finish` once the floor has elapsed, immediately when it already has.
   *
   * A held-back finish is **replaced**, never stacked: only the most recently
   * queued id is cancellable, so a second timer would outlive every cancel and
   * end a state that has since restarted. Controllers that want the first signal
   * to win guard on {@link pending} before calling.
   */
  schedule(minDuration: number, finish: () => void): void {
    this.cancel();
    const remaining = minDuration - (Date.now() - this.#since);
    if (remaining > 0) {
      this.#timerId = this.#timers.set(() => {
        this.#timerId = null;
        finish();
      }, remaining);
    } else {
      finish();
    }
  }

  /** Drops a held-back finish. Safe when none is queued, or after a bulk clear. */
  cancel(): void {
    if (this.#timerId !== null) {
      this.#timers.clear(this.#timerId);
      this.#timerId = null;
    }
  }
}
