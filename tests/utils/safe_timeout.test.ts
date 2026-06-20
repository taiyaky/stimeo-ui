import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SafeInterval, SafeTimeout } from "../../src/utils/safe_timeout";

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

  it("clear is a no-op for unknown ids", () => {
    const timers = new SafeTimeout();
    expect(() => timers.clear(999)).not.toThrow();
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
