import { beforeEach, describe, expect, it, vi } from "vitest";
import { MicrotaskCoalescer } from "../../src/utils/microtask_coalescer";

/**
 * Tests for {@link MicrotaskCoalescer}.
 *
 * Three things are worth pinning: the coalescing itself (N callbacks → one
 * pass), the *scheduling* guard (initial target callbacks arrive before
 * `connect()`), and the generation contract across a disconnect that happens
 * while a pass is already queued.
 */
describe("MicrotaskCoalescer", () => {
  let runs: number;
  let coalescer: MicrotaskCoalescer;

  /** Lets every queued microtask drain. */
  const settle = () => Promise.resolve();

  beforeEach(() => {
    runs = 0;
    coalescer = new MicrotaskCoalescer(() => {
      runs += 1;
    });
  });

  describe("coalescing", () => {
    it("runs once for a whole batch of schedules", async () => {
      coalescer.activate();
      for (let i = 0; i < 20; i += 1) coalescer.schedule();
      await settle();
      expect(runs).toBe(1);
    });

    it("runs again for the next batch", async () => {
      coalescer.activate();
      coalescer.schedule();
      await settle();
      coalescer.schedule();
      await settle();
      expect(runs).toBe(2);
    });

    it("does not run until the microtask drains", () => {
      // Reconciling synchronously would run once per element against a
      // half-applied DOM, which is the thing the microtask exists to avoid.
      coalescer.activate();
      coalescer.schedule();
      expect(runs).toBe(0);
    });
  });

  describe("the scheduling guard (before connect)", () => {
    it("ignores schedules before activate", async () => {
      // Stimulus delivers the *initial* target callbacks ahead of `connect()`.
      // Reconciling there would compute a fallback against uninitialised state,
      // and `connect()` is about to do a full pass anyway.
      coalescer.schedule();
      await settle();
      expect(runs).toBe(0);
    });

    it("does not replay pre-activate schedules once activated", async () => {
      coalescer.schedule();
      coalescer.activate();
      await settle();
      expect(runs).toBe(0);
    });
  });

  describe("the generation contract (disconnect while queued)", () => {
    it("drops a pass that was queued before cancel", async () => {
      // Stimulus fires a callback for *every* target during teardown, so a
      // microtask queued moments earlier would otherwise run against a detached
      // tree and a controller that has released its listeners.
      coalescer.activate();
      coalescer.schedule();
      coalescer.cancel();
      await settle();
      expect(runs).toBe(0);
    });

    it("ignores schedules after cancel", async () => {
      coalescer.activate();
      coalescer.cancel();
      coalescer.schedule();
      await settle();
      expect(runs).toBe(0);
    });

    it("does not let a stale microtask fire into a fresh generation", async () => {
      // disconnect → reconnect inside one task: the pass queued by the *old*
      // generation must not be honoured by the new one, or a reconnect would
      // reconcile twice — once for a batch that no longer exists.
      coalescer.activate();
      coalescer.schedule(); // generation 1 queues
      coalescer.cancel(); // teardown
      coalescer.activate(); // reconnect in the same task
      await settle();
      expect(runs).toBe(0);

      // The new generation still works normally.
      coalescer.schedule();
      await settle();
      expect(runs).toBe(1);
    });

    it("does not let a stale microtask consume a fresh generation's queued pass", async () => {
      let freshBatchSettled = false;
      const observedHorizons: boolean[] = [];
      const reconnecting = new MicrotaskCoalescer(() => {
        observedHorizons.push(freshBatchSettled);
      });

      reconnecting.activate();
      reconnecting.schedule(); // generation 1 queues
      reconnecting.cancel();
      reconnecting.activate(); // generation 2 starts before generation 1 drains

      // The fresh pass must remain behind its own batch horizon even though the
      // stale callback is already ahead of both microtasks in the queue.
      queueMicrotask(() => {
        freshBatchSettled = true;
      });
      reconnecting.schedule();

      await settle();
      expect(observedHorizons).toEqual([true]);
    });

    it("survives a cancel with nothing queued", () => {
      coalescer.activate();
      expect(() => coalescer.cancel()).not.toThrow();
    });
  });

  it("uses a microtask, not a timer", async () => {
    // The horizon matters: Stimulus drives these callbacks from a
    // MutationObserver whose own callback is already a microtask, so one more
    // lands after the batch's last sibling and still before paint.
    const timer = vi.spyOn(globalThis, "setTimeout");
    coalescer.activate();
    coalescer.schedule();
    await settle();
    expect(runs).toBe(1);
    expect(timer).not.toHaveBeenCalled();
    timer.mockRestore();
  });
});
