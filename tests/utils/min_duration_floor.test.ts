import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MinDurationFloor } from "../../src/utils/min_duration_floor";
import { TaskTimeout } from "../../src/utils/safe_timeout";
import { installRecyclingTimers } from "../helpers/timing";

/**
 * Behavioral tests for {@link MinDurationFloor}: the elapsed / not-yet-elapsed
 * split, replacement of a held-back finish, cancellation, and the borrowed
 * registry contract.
 */
describe("MinDurationFloor", () => {
  let timers: TaskTimeout;
  let floor: MinDurationFloor;

  beforeEach(() => {
    vi.useFakeTimers();
    timers = new TaskTimeout();
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
    /** The task handle expires before the finish callback runs. */
    expect(floor.pending).toBe(false);
  });

  it("replaces a held-back finish instead of stacking a second one", () => {
    const first = vi.fn();
    const second = vi.fn();
    floor.begin();
    floor.schedule(500, first);
    vi.advanceTimersByTime(100);
    floor.schedule(500, second);
    /** The floor retains one task handle. Scheduling a new finish cancels the pending task. */
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
    /** Clearing the registry invalidates the task handle and makes the later cancel safe. */
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

  it("is no longer pending as soon as the borrowed registry clears", () => {
    floor.begin();
    floor.schedule(500, vi.fn());
    timers.clearAll();
    expect(floor.pending).toBe(false);
  });

  it("does not cancel another timer reusing its bulk-cleared registration's id", () => {
    const recycling = installRecyclingTimers();
    try {
      floor.begin();
      floor.schedule(500, vi.fn());
      timers.clearAll();
      const other = vi.fn();
      timers.set(other, 100);
      expect(recycling.handed).toEqual([recycling.handed[0], recycling.handed[0]]);
      floor.cancel();
      vi.advanceTimersByTime(100);
      expect(other).toHaveBeenCalledOnce();
    } finally {
      timers.clearAll();
      recycling.restore();
    }
  });

  it("lets separate floors and an unrelated timer share one registry", () => {
    const second = new MinDurationFloor(timers);
    const firstFinished = vi.fn();
    const secondFinished = vi.fn();
    const other = vi.fn();
    floor.begin();
    second.begin();
    floor.schedule(200, firstFinished);
    second.schedule(300, secondFinished);
    timers.set(other, 100);
    floor.cancel();
    expect(floor.pending).toBe(false);
    expect(second.pending).toBe(true);
    vi.advanceTimersByTime(300);
    expect(firstFinished).not.toHaveBeenCalled();
    expect(secondFinished).toHaveBeenCalledOnce();
    expect(other).toHaveBeenCalledOnce();
    expect(second.pending).toBe(false);
  });

  it("expires the finish before a callback schedules the next floor", () => {
    const observed: boolean[] = [];
    const next = vi.fn();
    floor.begin();
    floor.schedule(100, () => {
      observed.push(floor.pending);
      floor.begin();
      floor.schedule(200, next);
    });
    vi.advanceTimersByTime(100);
    expect(observed).toEqual([false]);
    expect(floor.pending).toBe(true);
    vi.advanceTimersByTime(200);
    expect(next).toHaveBeenCalledOnce();
    expect(floor.pending).toBe(false);
  });
});
