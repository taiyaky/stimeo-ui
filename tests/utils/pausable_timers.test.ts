import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PausableTimers } from "../../src/utils/pausable_timers";

/**
 * Behavioral tests for {@link PausableTimers}: that a hold stops the timer and
 * banks what is left, that every reason has to be released before it runs again,
 * that a hold is recorded whether or not the key has a timer, and above all that
 * holding is never what makes the callback run.
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

    // Released first: a pause would record a hold and make the key tracked.
    expect(timers.resume("absent", "hover")).toBe(false);
    expect(timers.tracks("absent")).toBe(false);
    expect(timers.pause("absent", "hover")).toBe(false);
  });

  it("holds a key that has no timer, and forgets it once released", () => {
    const timers = new PausableTimers<string>();

    expect(timers.pause("a", "focus")).toBe(false);
    expect(timers.isHeld("a")).toBe(true);
    expect(timers.tracks("a")).toBe(true);

    // Nothing was running, so the release has nothing to start again.
    expect(timers.resume("a", "focus")).toBe(false);
    expect(timers.isHeld("a")).toBe(false);
    expect(timers.tracks("a")).toBe(false);
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
  });

  it("holds back a timer set on a key that was held first", () => {
    const timers = new PausableTimers<string>();
    const ran = vi.fn();

    timers.pause("a", "hover");
    timers.set("a", ran, 1000);
    vi.advanceTimersByTime(5000);
    expect(ran).not.toHaveBeenCalled();

    expect(timers.resume("a", "hover")).toBe(true);
    vi.advanceTimersByTime(999);
    expect(ran).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ran).toHaveBeenCalledOnce();
  });

  it("answers isHeld from the reasons, whether or not a timer runs", () => {
    const timers = new PausableTimers<string>();

    timers.set("a", () => {}, 1000);
    expect(timers.isHeld("a")).toBe(false);

    timers.pause("a", "hover");
    timers.pause("a", "focus");
    timers.resume("a", "hover");
    expect(timers.isHeld("a")).toBe(true);

    timers.resume("a", "focus");
    expect(timers.isHeld("a")).toBe(false);
    expect(timers.isHeld("absent")).toBe(false);
  });

  it("disarms a held key, keeping the hold and dropping the timer", () => {
    const timers = new PausableTimers<string>();
    const ran = vi.fn();

    timers.set("a", ran, 1000);
    timers.pause("a", "focus");
    timers.disarm("a");
    expect(timers.isHeld("a")).toBe(true);
    expect(timers.tracks("a")).toBe(true);

    expect(timers.resume("a", "focus")).toBe(false);
    expect(timers.tracks("a")).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(ran).not.toHaveBeenCalled();
  });

  it("disarms a key nothing holds by forgetting it", () => {
    const timers = new PausableTimers<string>();
    const ran = vi.fn();

    timers.set("a", ran, 1000);
    timers.disarm("a");
    expect(timers.tracks("a")).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(ran).not.toHaveBeenCalled();
  });

  it("leaves a key it does not track alone on disarm", () => {
    const timers = new PausableTimers<string>();

    timers.disarm("absent");

    expect(timers.tracks("absent")).toBe(false);
    expect(timers.isHeld("absent")).toBe(false);
  });

  it("arms a disarmed key again with the timer set while it is held", () => {
    const timers = new PausableTimers<string>();
    const first = vi.fn();
    const second = vi.fn();

    timers.set("a", first, 1000);
    timers.pause("a", "hover");
    timers.disarm("a");
    timers.set("a", second, 700);
    vi.advanceTimersByTime(5000);
    expect(second).not.toHaveBeenCalled();

    expect(timers.resume("a", "hover")).toBe(true);
    vi.advanceTimersByTime(700);
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it("drops a hold on a key with no timer on clear and on clearAll", () => {
    const timers = new PausableTimers<string>();

    timers.pause("a", "hover");
    timers.pause("b", "focus");
    timers.clear("a");
    expect(timers.isHeld("a")).toBe(false);
    expect(timers.tracks("a")).toBe(false);
    expect(timers.isHeld("b")).toBe(true);

    timers.clearAll();
    expect(timers.isHeld("b")).toBe(false);
    expect(timers.tracks("b")).toBe(false);
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

  it("replaces a running timer, so only the new callback runs, on the new delay", () => {
    const timers = new PausableTimers<string>();
    const replaced = vi.fn();
    const current = vi.fn();

    timers.set("a", replaced, 1000);
    vi.advanceTimersByTime(600);
    timers.set("a", current, 1000);

    vi.advanceTimersByTime(999);
    expect(current).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(current).toHaveBeenCalledOnce();
    expect(replaced).not.toHaveBeenCalled();
  });

  it("keeps a key held when a reason it was never given is released", () => {
    const timers = new PausableTimers<string>();
    const ran = vi.fn();

    timers.set("a", ran, 1000);
    timers.pause("a", "hover");
    expect(timers.resume("a", "focus")).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(ran).not.toHaveBeenCalled();

    expect(timers.resume("a", "hover")).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(ran).toHaveBeenCalledOnce();
  });

  it("tracks a key while it is held and until its timer fires", () => {
    const timers = new PausableTimers<string>();

    timers.set("a", () => {}, 1000);
    timers.pause("a", "hover");
    vi.advanceTimersByTime(5000);
    expect(timers.tracks("a")).toBe(true);

    timers.resume("a", "hover");
    expect(timers.tracks("a")).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(timers.tracks("a")).toBe(false);
  });

  it("forgets the key before the callback runs, so the callback may arm it again", () => {
    const timers = new PausableTimers<string>();
    const seen: boolean[] = [];
    let rounds = 0;
    const tick = (): void => {
      seen.push(timers.tracks("a"));
      rounds += 1;
      if (rounds < 2) timers.set("a", tick, 1000);
    };

    timers.set("a", tick, 1000);
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([false]);
    expect(timers.tracks("a")).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([false, false]);
    expect(timers.tracks("a")).toBe(false);
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
