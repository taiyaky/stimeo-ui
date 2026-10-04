import { runInNewContext } from "node:vm";

/**
 * How long a guarded call may run before it is taken to loop forever. The
 * guarded calls finish in microseconds, but the limit is wall-clock time: a
 * garbage collection or a descheduled worker on a loaded runner counts against
 * it, so it sits far above any real run rather than just above one.
 */
export const HANG_GUARD_MS = 5_000;

/**
 * Returns what `fn` returns, or throws once it has run for `limitMs` without
 * returning.
 *
 * A synchronous loop that never ends holds the worker it runs on, and the test
 * timeout is a timer that cannot fire until the loop yields. A script time limit
 * stops the call where it spins instead, so a scanner that stops advancing fails
 * the test that called it rather than stalling every test after it.
 */
export function withinTimeLimit<T>(fn: () => T, limitMs = HANG_GUARD_MS): T {
  return runInNewContext("call()", { call: fn }, { timeout: limitMs }) as T;
}
