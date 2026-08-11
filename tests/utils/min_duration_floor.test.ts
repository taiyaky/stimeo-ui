import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MinDurationFloor } from "../../src/utils/min_duration_floor";
import { SafeTimeout } from "../../src/utils/safe_timeout";

/**
 * Behavioral tests for {@link MinDurationFloor}: the elapsed / not-yet-elapsed
 * split, replacement of a held-back finish, cancellation, and the borrowed
 * registry contract.
 */
describe("MinDurationFloor", () => {
  let timers: SafeTimeout;
  let floor: MinDurationFloor;

  beforeEach(() => {
    vi.useFakeTimers();
    timers = new SafeTimeout();
    floor = new MinDurationFloor(timers);
  });

  afterEach(() => {
    timers.clearAll();
    vi.useRealTimers();
  });

  it("runs the finish at once when the floor has already elapsed", () => {
    const finish = vi.fn();
    floor.begin();
    vi.advanceTimersByTime(200);
    floor.schedule(100, finish);
    // Nothing is held back, so no timer is left behind either.
    expect(finish).toHaveBeenCalledTimes(1);
    expect(floor.pending).toBe(false);
    expect(timers.size).toBe(0);
  });

  it("holds the finish back for what is left of the floor", () => {
    const finish = vi.fn();
    floor.begin();
    vi.advanceTimersByTime(100);
    floor.schedule(500, finish);
    expect(floor.pending).toBe(true);
    vi.advanceTimersByTime(399);
    expect(finish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(finish).toHaveBeenCalledTimes(1);
    // The id is forgotten once it fires, so a later cancel has nothing to do.
    expect(floor.pending).toBe(false);
  });

  it("replaces a held-back finish instead of stacking a second one", () => {
    const first = vi.fn();
    const second = vi.fn();
    floor.begin();
    floor.schedule(500, first);
    vi.advanceTimersByTime(100);
    floor.schedule(500, second);
    // Only the newest queued id is cancellable, so a stacked timer would outlive
    // every later cancel and end a state that has since restarted.
    expect(timers.size).toBe(1);
    vi.advanceTimersByTime(500);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("measures the replacement from the same begin, not from the reschedule", () => {
    const finish = vi.fn();
    floor.begin();
    vi.advanceTimersByTime(400);
    floor.schedule(500, finish);
    vi.advanceTimersByTime(50);
    floor.schedule(500, finish);
    // 450ms of the floor is already spent: rescheduling must not restart it.
    vi.advanceTimersByTime(50);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("drops a held-back finish on cancel", () => {
    const finish = vi.fn();
    floor.begin();
    floor.schedule(500, finish);
    floor.cancel();
    expect(floor.pending).toBe(false);
    expect(timers.size).toBe(0);
    vi.advanceTimersByTime(500);
    expect(finish).not.toHaveBeenCalled();
  });

  it("is a no-op to cancel with nothing held back", () => {
    expect(() => floor.cancel()).not.toThrow();
    expect(floor.pending).toBe(false);
  });

  it("stays consistent when the borrowed registry is cleared in bulk", () => {
    const finish = vi.fn();
    floor.begin();
    floor.schedule(500, finish);
    // A controller tearing down clears the whole registry at once; the floor still
    // has to forget its id so `pending` does not claim a timer that is gone.
    timers.clearAll();
    floor.cancel();
    expect(floor.pending).toBe(false);
    vi.advanceTimersByTime(500);
    expect(finish).not.toHaveBeenCalled();
  });

  it("leaves timers it does not own alone", () => {
    const other = vi.fn();
    const finish = vi.fn();
    timers.set(other, 100);
    floor.begin();
    floor.schedule(500, finish);
    floor.cancel();
    // The registry is borrowed, not owned: cancelling the floor must not disturb a
    // show delay the same controller scheduled beside it.
    vi.advanceTimersByTime(100);
    expect(other).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
  });

  it("treats a floor that never began as fully elapsed", () => {
    const finish = vi.fn();
    floor.schedule(0, finish);
    expect(finish).toHaveBeenCalledTimes(1);
  });
});
