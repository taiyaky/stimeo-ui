import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SafeInterval,
  SafeTimeout,
  TaskTimeout,
  type TimeoutTask,
} from "../../src/utils/safe_timeout";
import { installRecyclingTimers } from "../helpers/timing";

/**
 * Unit tests for {@link SafeTimeout} and {@link SafeInterval}: the self-cleaning
 * timer registries. Fake timers make scheduling deterministic.
 */
describe("SafeTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the callback after the delay", () => {
    const timers = new SafeTimeout();
    const spy = vi.fn();
    timers.set(spy, 1000);

    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("tracks pending timers and forgets them once fired", () => {
    const timers = new SafeTimeout();
    timers.set(() => {}, 1000);
    timers.set(() => {}, 2000);
    expect(timers.size).toBe(2);

    vi.advanceTimersByTime(1000);
    expect(timers.size).toBe(1);

    vi.advanceTimersByTime(1000);
    expect(timers.size).toBe(0);
  });

  it("clear cancels a single pending timer", () => {
    const timers = new SafeTimeout();
    const spy = vi.fn();
    const id = timers.set(spy, 1000);

    timers.clear(id);
    expect(timers.size).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(spy).not.toHaveBeenCalled();
  });

  it("clear leaves a timer it never owned running", () => {
    const timers = new SafeTimeout();
    const callback = vi.fn();
    const id = window.setTimeout(callback, 1000);

    timers.clear(id);
    vi.advanceTimersByTime(1000);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("clearAll cancels every pending timer", () => {
    const timers = new SafeTimeout();
    const a = vi.fn();
    const b = vi.fn();
    timers.set(a, 1000);
    timers.set(b, 2000);

    timers.clearAll();
    expect(timers.size).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("is reusable after clearAll (Stimulus disconnect → reconnect)", () => {
    const timers = new SafeTimeout();
    timers.set(() => {}, 1000);
    timers.clearAll();

    const spy = vi.fn();
    timers.set(spy, 500);
    expect(timers.size).toBe(1);
    vi.advanceTimersByTime(500);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("SafeInterval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the callback repeatedly", () => {
    const intervals = new SafeInterval();
    const spy = vi.fn();
    intervals.set(spy, 1000);

    vi.advanceTimersByTime(3000);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("keeps tracking the interval across firings (no auto-forget)", () => {
    const intervals = new SafeInterval();
    intervals.set(() => {}, 1000);
    expect(intervals.size).toBe(1);

    vi.advanceTimersByTime(5000);
    expect(intervals.size).toBe(1);
  });

  it("clear stops a single interval", () => {
    const intervals = new SafeInterval();
    const spy = vi.fn();
    const id = intervals.set(spy, 1000);

    vi.advanceTimersByTime(1000);
    expect(spy).toHaveBeenCalledTimes(1);

    intervals.clear(id);
    vi.advanceTimersByTime(3000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(intervals.size).toBe(0);
  });

  it("clearAll stops every interval", () => {
    const intervals = new SafeInterval();
    const a = vi.fn();
    const b = vi.fn();
    intervals.set(a, 1000);
    intervals.set(b, 500);

    intervals.clearAll();
    expect(intervals.size).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("is reusable after clearAll (Stimulus disconnect → reconnect)", () => {
    const intervals = new SafeInterval();
    intervals.set(() => {}, 1000);
    intervals.clearAll();

    const spy = vi.fn();
    intervals.set(spy, 1000);
    vi.advanceTimersByTime(2000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(intervals.size).toBe(1);
  });
});

/** Registration handles expire with their task, even when the platform recycles ids. */
describe("TaskTimeout handles", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("expires before calling back and forgets the timer", () => {
    const timers = new TaskTimeout();
    const observed: [boolean, number][] = [];
    const task = timers.setTask(() => observed.push([task.pending, timers.size]), 100);
    expect(task.pending).toBe(true);
    expect(timers.size).toBe(1);
    vi.advanceTimersByTime(100);
    expect(observed).toEqual([[false, 0]]);
    expect(task.pending).toBe(false);
    task.cancel();
    expect(timers.size).toBe(0);
  });

  it("cancels only its task and tolerates repeated cancellation", () => {
    const timers = new TaskTimeout();
    const cancelled = vi.fn();
    const other = vi.fn();
    const task = timers.setTask(cancelled, 100);
    timers.set(other, 100);
    task.cancel();
    task.cancel();
    expect(task.pending).toBe(false);
    expect(timers.size).toBe(1);
    vi.advanceTimersByTime(100);
    expect(cancelled).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledOnce();
  });

  it("numeric clear expires the handle belonging to that registration", () => {
    const recycling = installRecyclingTimers();
    const timers = new TaskTimeout();
    try {
      const complete = vi.fn();
      const task = timers.setTask(complete, 100);
      timers.clear(recycling.handed[0] ?? -1);
      expect(task.pending).toBe(false);
      expect(timers.size).toBe(0);
      vi.advanceTimersByTime(100);
      expect(complete).not.toHaveBeenCalled();
    } finally {
      timers.clearAll();
      recycling.restore();
    }
  });

  it("an old handle cannot cancel a numeric timer reusing its bulk-cleared id", () => {
    const recycling = installRecyclingTimers();
    const timers = new TaskTimeout();
    try {
      const task = timers.setTask(vi.fn(), 100);
      timers.clearAll();
      expect(task.pending).toBe(false);
      const other = vi.fn();
      timers.set(other, 100);
      expect(recycling.handed).toEqual([recycling.handed[0], recycling.handed[0]]);
      task.cancel();
      expect(timers.size).toBe(1);
      vi.advanceTimersByTime(100);
      expect(other).toHaveBeenCalledOnce();
    } finally {
      timers.clearAll();
      recycling.restore();
    }
  });

  it.each(["cancel", "bulk clear"] as const)(
    "an old handle cannot cancel a new task reusing its id after %s",
    (release) => {
      const recycling = installRecyclingTimers();
      const timers = new TaskTimeout();
      try {
        const first = timers.setTask(vi.fn(), 100);
        if (release === "cancel") first.cancel();
        else timers.clearAll();
        const complete = vi.fn();
        const current = timers.setTask(complete, 100);
        expect(recycling.handed).toEqual([recycling.handed[0], recycling.handed[0]]);
        first.cancel();
        expect(first.pending).toBe(false);
        expect(current.pending).toBe(true);
        vi.advanceTimersByTime(100);
        expect(complete).toHaveBeenCalledOnce();
      } finally {
        timers.clearAll();
        recycling.restore();
      }
    },
  );

  it("a fired handle cannot cancel a task armed by its callback with the same id", () => {
    const recycling = installRecyclingTimers();
    const timers = new TaskTimeout();
    try {
      const later = vi.fn();
      let current: TimeoutTask | undefined;
      const first = timers.setTask(() => {
        expect(first.pending).toBe(false);
        expect(timers.size).toBe(0);
        current = timers.setTask(later, 100);
      }, 100);
      vi.advanceTimersByTime(100);
      expect(recycling.handed).toEqual([recycling.handed[0], recycling.handed[0]]);
      first.cancel();
      expect(current?.pending).toBe(true);
      vi.advanceTimersByTime(100);
      expect(later).toHaveBeenCalledOnce();
      expect(current?.pending).toBe(false);
    } finally {
      timers.clearAll();
      recycling.restore();
    }
  });

  it("bulk clear expires every handle beside numeric timers and remains reusable", () => {
    const timers = new TaskTimeout();
    const abandoned = vi.fn();
    const first = timers.setTask(abandoned, 100);
    const second = timers.setTask(abandoned, 100);
    timers.set(abandoned, 100);
    timers.clearAll();
    expect(first.pending).toBe(false);
    expect(second.pending).toBe(false);
    expect(timers.size).toBe(0);
    const complete = vi.fn();
    const current = timers.setTask(complete, 100);
    first.cancel();
    second.cancel();
    vi.advanceTimersByTime(100);
    expect(abandoned).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(current.pending).toBe(false);
  });
});

/** Supplies only platform primitives, without superclass cancellation or registration work. */
class CustomTaskTimeout extends TaskTimeout {
  protected override schedule(callback: () => void, delay: number): number {
    return window.setTimeout(callback, delay);
  }

  protected override cancel(id: number): void {
    window.clearTimeout(id);
  }
}

/** Bookkeeping remains separate from the protected platform primitives. */
describe("TaskTimeout with custom platform primitives", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps numeric cancellation working with custom platform primitives", () => {
    const timers = new CustomTaskTimeout();
    const complete = vi.fn();
    const id = timers.set(complete, 100);
    timers.clear(id);
    vi.advanceTimersByTime(100);
    expect(complete).not.toHaveBeenCalled();
    expect(timers.size).toBe(0);
  });

  it.each(["cancel", "bulk clear"] as const)(
    "expires task handles independently of custom primitives after %s",
    (release) => {
      const timers = new CustomTaskTimeout();
      const complete = vi.fn();
      const task = timers.setTask(complete, 100);
      if (release === "cancel") task.cancel();
      else timers.clearAll();
      expect(task.pending).toBe(false);
      vi.advanceTimersByTime(100);
      expect(complete).not.toHaveBeenCalled();
      expect(timers.size).toBe(0);
    },
  );
});
