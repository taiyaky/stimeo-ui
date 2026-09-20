import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrameCoalescer } from "../../src/utils/frame_coalescer";

/**
 * Behavioral tests for {@link FrameCoalescer}: that a burst costs one frame and
 * runs the work requested first, that a frame released by running lets the next
 * burst take its own, and that cancelling drops the pending frame and touches
 * nothing when there is none.
 */
describe("FrameCoalescer", () => {
  /** Requested callbacks by handle; cancelling really removes one, as an engine does. */
  let frames: Map<number, FrameRequestCallback>;
  let cancelled: number[];
  let nextHandle: number;

  beforeEach(() => {
    frames = new Map();
    cancelled = [];
    nextHandle = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      cancelled.push(handle);
      frames.delete(handle);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Runs every frame still requested, the way a paint would. */
  const paint = (): void => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };

  it("costs one frame for a burst and runs the work once", () => {
    const coalescer = new FrameCoalescer();
    const run = vi.fn();

    coalescer.schedule(run);
    coalescer.schedule(run);
    coalescer.schedule(run);

    expect(frames.size).toBe(1);
    paint();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs the work requested first, not the last of the burst", () => {
    // A caller that queues a special first pass and then receives scrolls has to
    // get that first pass; the scrolls it swallows would measure the same frame.
    const coalescer = new FrameCoalescer();
    const first = vi.fn();
    const later = vi.fn();

    coalescer.schedule(first);
    coalescer.schedule(later);
    paint();

    expect(first).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();
  });

  it("takes a new frame for the next burst", () => {
    const coalescer = new FrameCoalescer();
    const run = vi.fn();

    coalescer.schedule(run);
    paint();
    coalescer.schedule(run);
    paint();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("lets the work request the following frame", () => {
    const coalescer = new FrameCoalescer();
    const again = vi.fn();
    coalescer.schedule(() => coalescer.schedule(again));

    paint();
    expect(again).not.toHaveBeenCalled();

    paint();
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("drops the pending frame on cancel, releasing the handle it holds", () => {
    const coalescer = new FrameCoalescer();
    const run = vi.fn();

    coalescer.schedule(run);
    coalescer.cancel();
    paint();

    expect(run).not.toHaveBeenCalled();
    expect(cancelled).toEqual([1]);
  });

  it("never reaches the platform when there is nothing to drop", () => {
    // `cancelAnimationFrame` takes an `unsigned long`, so no handle value can mean
    // "nothing pending": a placeholder arrives as a number the same allocator can
    // hand to someone else, and dropping that frame is not this object's to do.
    // An idle cancel therefore has to stay out of the platform's registry.
    const coalescer = new FrameCoalescer();

    expect(() => coalescer.cancel()).not.toThrow();
    expect(cancelled).toEqual([]);

    coalescer.schedule(vi.fn());
    coalescer.cancel();
    expect(() => coalescer.cancel()).not.toThrow();

    expect(cancelled).toEqual([1]);
  });

  it("schedules again after a cancel", () => {
    const coalescer = new FrameCoalescer();
    const run = vi.fn();

    coalescer.schedule(vi.fn());
    coalescer.cancel();
    coalescer.schedule(run);
    paint();

    expect(run).toHaveBeenCalledTimes(1);
  });
});
