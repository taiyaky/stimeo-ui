import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PausableTimers } from "../../src/utils/pausable_timers";

/**
 * Behavioral tests for {@link PausableTimers}: that a hold stops the timer and
 * banks what is left, that every reason has to be released before it runs again,
 * and above all that holding is never what makes the callback run.
 */
describe("PausableTimers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the callback once after the delay", () => {
    const timers = new PausableTimers<string>();
    const ran = vi.fn();

    timers.set("a", ran, 1000);
    expect(timers.tracks("a")).toBe(true);

    vi.advanceTimersByTime(1000);

    expect(ran).toHaveBeenCalledOnce();
    expect(timers.tracks("a")).toBe(false);
  });

  it("reports nothing to do for a key it does not track", () => {
    const timers = new PausableTimers<string>();

    expect(timers.pause("absent", "hover")).toBe(false);
    expect(timers.resume("absent", "hover")).toBe(false);
    expect(timers.tracks("absent")).toBe(false);
  });

  it("banks the time left on the first reason and ignores the next one", () => {
    const timers = new PausableTimers<string>();
    const ran = vi.fn();

    timers.set("a", ran, 1000);
    vi.advanceTimersByTime(600);
    expect(timers.pause("a", "hover")).toBe(true);

    // A second reason must not re-measure the bank against a timer already stopped.
    vi.advanceTimersByTime(300);
    expect(timers.pause("a", "focus")).toBe(false);

    expect(timers.resume("a", "hover")).toBe(false);
    expect(timers.resume("a", "focus")).toBe(true);
    vi.advanceTimersByTime(399);
    expect(ran).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ran).toHaveBeenCalledOnce();
  });

  it("reports nothing to do for a resume on a running key", () => {
    const timers = new PausableTimers<string>();
    const ran = vi.fn();

    timers.set("a", ran, 1000);
    expect(timers.resume("a", "hover")).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(ran).toHaveBeenCalledOnce();
  });

  it("stays held while any reason is left", () => {
    const timers = new PausableTimers<string>();
    const ran = vi.fn();

    timers.set("a", ran, 1000);
    timers.pause("a", "hover");
    timers.pause("a", "focus");

    expect(timers.resume("a", "hover")).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(ran).not.toHaveBeenCalled();

    expect(timers.resume("a", "focus")).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(ran).toHaveBeenCalledOnce();
  });

  it("never runs the callback while the key is held", () => {
    const timers = new PausableTimers<string>();
    const ran = vi.fn();

    timers.set("a", ran, 1000);
    vi.advanceTimersByTime(600);
    timers.pause("a", "hover");
    vi.advanceTimersByTime(60_000);

    expect(ran).not.toHaveBeenCalled();
  });

  it("banks one millisecond for a deadline that lapsed before the hold arrived", () => {
    const timers = new PausableTimers<string>();
    const ran = vi.fn();

    timers.set("a", ran, 1000);
    // The deadline passed while the timer sat queued (a throttled tab, a long task).
    vi.setSystemTime(Date.now() + 1500);
    expect(timers.pause("a", "hover")).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(ran).not.toHaveBeenCalled();

    timers.resume("a", "hover");
    vi.advanceTimersByTime(1);
    expect(ran).toHaveBeenCalledOnce();
  });

  it("keeps the lapsed deadline banked across two reasons", () => {
    const timers = new PausableTimers<string>();
    const ran = vi.fn();

    timers.set("a", ran, 1000);
    vi.setSystemTime(Date.now() + 1500);
    timers.pause("a", "hover");
    timers.pause("a", "focus");
    timers.resume("a", "hover");
    vi.advanceTimersByTime(5000);
    expect(ran).not.toHaveBeenCalled();

    timers.resume("a", "focus");
    vi.advanceTimersByTime(1);
    expect(ran).toHaveBeenCalledOnce();
  });

  it("banks again on a second hold", () => {
    const timers = new PausableTimers<string>();
    const ran = vi.fn();

    timers.set("a", ran, 1000);
    vi.advanceTimersByTime(300);
    timers.pause("a", "hover");
    timers.resume("a", "hover");
    vi.advanceTimersByTime(300);
    timers.pause("a", "hover");
    timers.resume("a", "hover");

    vi.advanceTimersByTime(399);
    expect(ran).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ran).toHaveBeenCalledOnce();
  });

  it("arms a held key without releasing it, and resumes with the new delay", () => {
    const timers = new PausableTimers<string>();
    const first = vi.fn();
    const second = vi.fn();

    timers.set("a", first, 1000);
    timers.pause("a", "hover");
    timers.set("a", second, 700);
    vi.advanceTimersByTime(5000);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    timers.resume("a", "hover");
    vi.advanceTimersByTime(699);
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it("drops the hold along with the key", () => {
    const timers = new PausableTimers<string>();
    const abandoned = vi.fn();
    const later = vi.fn();

    timers.set("a", abandoned, 1000);
    timers.pause("a", "hover");
    timers.clear("a");
    expect(timers.tracks("a")).toBe(false);

    // The key starts over: no reason survives to hold the new timer back.
    timers.set("a", later, 1000);
    vi.advanceTimersByTime(1000);
    expect(abandoned).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledOnce();
  });

  it("drops every hold on clearAll and can be used again afterwards", () => {
    const timers = new PausableTimers<string>();
    const abandoned = vi.fn();
    const later = vi.fn();

    timers.set("a", abandoned, 1000);
    timers.pause("a", "hover");
    timers.set("b", abandoned, 1000);
    timers.clearAll();
    expect(timers.tracks("a")).toBe(false);
    expect(timers.tracks("b")).toBe(false);

    timers.set("a", later, 1000);
    vi.advanceTimersByTime(1000);
    expect(abandoned).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledOnce();
  });
});
