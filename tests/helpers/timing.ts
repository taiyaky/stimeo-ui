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
 */

/** Resolves after one macrotask (`setTimeout(0)`); see the module docs. */
export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Resolves after `ms` milliseconds of real (unmocked) timer time. */
export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Yields to pending microtasks without waiting a macrotask; see the module docs. */
export const flushMicrotasks = () => Promise.resolve();
