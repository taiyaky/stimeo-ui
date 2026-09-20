import { describe, expect, it, vi } from "vitest";
import { flushMicrotasks, installRecyclingTimers, tick } from "./timing";

/**
 * Pins the semantic difference between the two waiting primitives, so a
 * refactor cannot silently collapse the microtask flush into a macrotask
 * wait (or vice versa), and the one property every suite that installs the
 * recycling clock leans on: a released handle reaches the next caller.
 */
describe("timing helpers", () => {
  it("flushMicrotasks resolves before any macrotask runs", async () => {
    const order: string[] = [];
    setTimeout(() => order.push("macrotask"), 0);
    queueMicrotask(() => order.push("microtask"));

    await flushMicrotasks();

    expect(order).toEqual(["microtask"]);
  });

  it("tick waits for the next macrotask", async () => {
    const order: string[] = [];
    setTimeout(() => order.push("macrotask"), 0);
    queueMicrotask(() => order.push("microtask"));

    await tick();

    expect(order).toEqual(["microtask", "macrotask"]);
  });
});

/**
 * The recycling clock is what lets a suite observe a stale registry entry, so a
 * wrapper that quietly stopped recycling would turn those suites green without
 * touching them.
 */
describe("installRecyclingTimers", () => {
  it("hands a released handle to the next caller", () => {
    vi.useFakeTimers();
    const timers = installRecyclingTimers();
    try {
      const first = window.setTimeout(() => {}, 100);
      window.clearTimeout(first);
      const second = window.setTimeout(() => {}, 100);

      expect(second).toBe(first);
      expect(timers.handed).toEqual([first, second]);
    } finally {
      timers.restore();
      vi.useRealTimers();
    }
  });

  it("recycles a handle whose timeout already fired, and still runs the callbacks", () => {
    vi.useFakeTimers();
    const timers = installRecyclingTimers();
    const ran: string[] = [];
    try {
      const first = window.setTimeout(() => ran.push("first"), 100);
      vi.advanceTimersByTime(100);
      const second = window.setTimeout(() => ran.push("second"), 100);
      vi.advanceTimersByTime(100);

      expect(second).toBe(first);
      expect(ran).toEqual(["first", "second"]);
    } finally {
      timers.restore();
      vi.useRealTimers();
    }
  });

  it("restores the original scheduling functions", () => {
    const before = window.setTimeout;
    const timers = installRecyclingTimers();
    expect(window.setTimeout).not.toBe(before);

    timers.restore();

    expect(window.setTimeout).toBe(before);
  });
});
