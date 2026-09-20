/**
 * Shared timing helpers for tests.
 *
 * Two waiting semantics exist and must not be conflated:
 *
 * - {@link tick} waits one **macrotask** (`setTimeout(0)`). Use it for
 *   "next task" boundaries: Stimulus connecting controllers through its
 *   `MutationObserver`, or work the controller scheduled with `setTimeout`.
 * - {@link flushMicrotasks} yields to pending **microtasks** only. Use it to
 *   verify a contract that promises completion within a microtask (e.g.
 *   `queueMicrotask` or a resolved-promise chain): awaiting `tick()` there
 *   would keep the test green even if the implementation regressed to
 *   `setTimeout`.
 *
 * Fake-timers caveat: while `vi.useFakeTimers()` is active, `tick()` and
 * `delay()` never resolve on their own — advance the mocked clock (e.g.
 * `vi.advanceTimersByTimeAsync(0)`) instead of awaiting them.
 *
 * {@link installRecyclingTimers} is a different kind of control: it does not wait,
 * it changes which handle the next timer is given, so a suite can state what a
 * registry does with an entry whose timer is already gone.
 */

/** Resolves after one macrotask (`setTimeout(0)`); see the module docs. */
export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Resolves after `ms` milliseconds of real (unmocked) timer time. */
export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Yields to pending microtasks without waiting a macrotask; see the module docs. */
export const flushMicrotasks = () => Promise.resolve();

/**
 * Installs `setTimeout` / `clearTimeout` wrappers that hand out recycled timer
 * handles, the way a browser may — a handle freed by `clearTimeout` or by the
 * timeout firing is given to the next caller. Vitest's fake timers and happy-dom
 * both hand out a fresh handle every time instead, so a ledger entry left behind
 * for a released timer can never collide with a live one under the plain clock,
 * and a registry that keeps stale entries passes unchallenged.
 *
 * `handed` records the handles in the order they were given out, so a test can
 * state that the collision it relies on actually happened.
 *
 * @example
 * ```ts
 * const timers = installRecyclingTimers();
 * try {
 *   // … arm, release, arm again; assert on `timers.handed`
 * } finally {
 *   timers.restore();
 * }
 * ```
 */
export const installRecyclingTimers = (): { handed: number[]; restore: () => void } => {
  const realSet = window.setTimeout;
  const realClear = window.clearTimeout;
  const live = new Map<number, number>();
  const free: number[] = [];
  const handed: number[] = [];
  let next = 1;

  window.setTimeout = ((handler: () => void, delay?: number) => {
    const handle = free.pop() ?? next++;
    handed.push(handle);
    const real = (realSet as (h: () => void, d?: number) => number)(() => {
      live.delete(handle);
      free.push(handle);
      handler();
    }, delay);
    live.set(handle, real);
    return handle;
  }) as unknown as typeof window.setTimeout;

  window.clearTimeout = ((handle?: number) => {
    if (handle === undefined) return;
    const real = live.get(handle);
    if (real === undefined) return;
    (realClear as (h: number) => void)(real);
    live.delete(handle);
    free.push(handle);
  }) as unknown as typeof window.clearTimeout;

  return {
    handed,
    restore: () => {
      window.setTimeout = realSet;
      window.clearTimeout = realClear;
    },
  };
};
