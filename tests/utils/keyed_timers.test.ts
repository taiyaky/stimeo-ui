import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyedTimers } from "../../src/utils/keyed_timers";
import { installRecyclingTimers } from "../helpers/timing";

/**
 * Behavioral tests for {@link KeyedTimers}: that one key carries one timer, that
 * an entry never outlives the timer it names, and that neither a released id nor
 * a discarded ledger can reach another key's timer.
 */
describe("KeyedTimers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the callback once after the delay and forgets the key", () => {
    const timers = new KeyedTimers<string>();
    const ran = vi.fn();

    timers.set("a", ran, 100);
    expect(timers.has("a")).toBe(true);

    vi.advanceTimersByTime(100);

    expect(ran).toHaveBeenCalledOnce();
    expect(timers.has("a")).toBe(false);
  });

  it("keeps one timer per key, measured from the latest arming", () => {
    const timers = new KeyedTimers<string>();
    const first = vi.fn();
    const second = vi.fn();

    timers.set("a", first, 100);
    vi.advanceTimersByTime(60);
    timers.set("a", second, 100);

    // The first deadline would land here if it had survived the second arming.
    vi.advanceTimersByTime(40);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("holds keys independently, including element keys", () => {
    const timers = new KeyedTimers<Element>();
    const kept = document.createElement("div");
    const released = document.createElement("div");
    const onKept = vi.fn();
    const onReleased = vi.fn();

    timers.set(kept, onKept, 100);
    timers.set(released, onReleased, 100);
    timers.clear(released);
    vi.advanceTimersByTime(100);

    expect(onKept).toHaveBeenCalledOnce();
    expect(onReleased).not.toHaveBeenCalled();
  });

  it("lets the callback arm the same key again", () => {
    const timers = new KeyedTimers<string>();
    const rounds: boolean[] = [];
    const again = vi.fn();

    timers.set(
      "a",
      () => {
        rounds.push(timers.has("a"));
        timers.set("a", again, 100);
      },
      100,
    );
    vi.advanceTimersByTime(100);

    // The entry is gone before the callback runs, so the second arming is not
    // cancelled by the one that scheduled it.
    expect(rounds).toEqual([false]);
    vi.advanceTimersByTime(100);
    expect(again).toHaveBeenCalledOnce();
  });

  it("does not cancel another key's timer through a released id", () => {
    const recycling = installRecyclingTimers();
    try {
      const timers = new KeyedTimers<string>();
      const fired = vi.fn();
      const other = vi.fn();

      timers.set("a", fired, 100);
      vi.advanceTimersByTime(100);
      expect(fired).toHaveBeenCalledOnce();

      // `b` is handed the id `a` released by firing.
      timers.set("b", other, 100);
      expect(recycling.handed).toEqual([recycling.handed[0], recycling.handed[0]]);

      timers.clear("a");
      vi.advanceTimersByTime(100);

      expect(other).toHaveBeenCalledOnce();
    } finally {
      recycling.restore();
    }
  });

  it("does not cancel a timer armed after clearAll through a released id", () => {
    const recycling = installRecyclingTimers();
    try {
      const timers = new KeyedTimers<string>();
      const abandoned = vi.fn();
      const other = vi.fn();

      timers.set("a", abandoned, 100);
      timers.clearAll();
      // `b` is handed the id `a` released by the bulk teardown.
      timers.set("b", other, 100);
      expect(recycling.handed).toEqual([recycling.handed[0], recycling.handed[0]]);

      timers.clear("a");
      vi.advanceTimersByTime(100);

      expect(abandoned).not.toHaveBeenCalled();
      expect(other).toHaveBeenCalledOnce();
    } finally {
      recycling.restore();
    }
  });

  it("cancels every pending timer and can be used again afterwards", () => {
    const timers = new KeyedTimers<string>();
    const first = vi.fn();
    const second = vi.fn();
    const later = vi.fn();

    timers.set("a", first, 100);
    timers.set("b", second, 100);
    timers.clearAll();
    timers.clearAll();
    vi.advanceTimersByTime(100);

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(timers.has("a")).toBe(false);

    timers.set("a", later, 100);
    vi.advanceTimersByTime(100);
    expect(later).toHaveBeenCalledOnce();
  });

  it("ignores a clear for a key it does not hold", () => {
    const timers = new KeyedTimers<string>();
    const ran = vi.fn();

    timers.set("a", ran, 100);
    timers.clear("never-armed");
    timers.clear("a");
    timers.clear("a");
    vi.advanceTimersByTime(100);

    expect(ran).not.toHaveBeenCalled();
  });

  it("releases the previous timer at the platform when a key is armed again", () => {
    const timers = new KeyedTimers<string>();
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const setTimeout = vi.spyOn(window, "setTimeout");

    timers.set("a", () => {}, 100);
    const first = setTimeout.mock.results[0]?.value;
    timers.set("a", () => {}, 100);

    expect(clearTimeout).toHaveBeenCalledWith(first);
  });
});
