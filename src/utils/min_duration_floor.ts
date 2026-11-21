import type { TaskTimeout, TimeoutTask } from "./safe_timeout";

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
 * The floor **borrows** a {@link TaskTimeout} instead of owning one, so a
 * controller that also schedules other work (a show delay) keeps every timer in a
 * single registry and one `clearAll()` in its teardown still drops them all.
 * The finish keeps a registration handle that expires when the registry clears,
 * so a later cancel cannot reach another timer reusing the released platform id.
 *
 * Scope is the floor itself. **When an end signal is allowed to arrive at all
 * stays with the controller**, because the answers differ — one keeps the first
 * queued finish and ignores repeats, another lets the newest replace it — and
 * flattening that into a shared default would silently change what the consumers
 * already promise.
 *
 * @example
 * ```ts
 * readonly #timers = new TaskTimeout();
 * readonly #floor = new MinDurationFloor(this.#timers);
 *
 * #show()  { this.#floor.begin(); … }
 * stop()   { this.#floor.schedule(this.minDurationValue, () => this.#hide()); }
 * ```
 */
export class MinDurationFloor {
  readonly #timers: TaskTimeout;

  /** Latest finish registration; its handle expires on completion or a bulk clear. */
  #task: TimeoutTask | null = null;

  /** Epoch ms the floor is measured from. */
  #since = 0;

  /** @param timers - the controller's registry; the floor schedules into it. */
  constructor(timers: TaskTimeout) {
    this.#timers = timers;
  }

  /** Starts the floor: call when the state being held becomes visible. */
  begin(): void {
    this.#since = Date.now();
  }

  /** True while a finish is held back waiting for the floor to elapse. */
  get pending(): boolean {
    return this.#task?.pending ?? false;
  }

  /**
   * Runs `finish` once the floor has elapsed, immediately when it already has.
   *
   * Scheduling cancels the pending task before replacing it. Controllers that
   * want the first signal to win guard on {@link pending} before calling.
   */
  schedule(minDuration: number, finish: () => void): void {
    this.cancel();
    const remaining = minDuration - (Date.now() - this.#since);
    if (remaining > 0) {
      this.#task = this.#timers.setTask(finish, remaining);
    } else {
      finish();
    }
  }

  /** Drops a held-back finish. Safe when none is queued, or after a bulk clear. */
  cancel(): void {
    this.#task?.cancel();
  }
}
