import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FormResetWatcher } from "../../src/utils/form_reset_watcher";

/**
 * Behavioral tests for {@link FormResetWatcher}: that ownership and cancellation
 * gate the pass, that a scripted reset settles in a microtask while a reset
 * still mid-dispatch waits for the next frame, and that teardown drops a pass
 * pending on either horizon.
 */
describe("FormResetWatcher", () => {
  let watcher: FormResetWatcher | null = null;
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
    watcher?.disconnect();
    watcher = null;
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  /** Runs every frame still requested, the way a paint would. */
  const paint = (): void => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };

  /** Lets one microtask turn run, which is the scripted reset's whole horizon. */
  const microtask = (): Promise<void> => Promise.resolve();

  const form = (): HTMLFormElement => document.querySelector("form") as HTMLFormElement;

  /**
   * Stands in for a browser-driven dispatch: the reset a user triggers is seen
   * by the pending microtask while the event is still propagating, which an own
   * property reproduces without a real activation.
   */
  const dispatchMidFlight = (target: EventTarget, cancelled = false): Event => {
    const event = new Event("reset", { bubbles: true, cancelable: true });
    if (cancelled) target.addEventListener("reset", (e) => e.preventDefault(), { once: true });
    target.dispatchEvent(event);
    Object.defineProperty(event, "eventPhase", { value: Event.CAPTURING_PHASE });
    return event;
  };

  it("reconciles a scripted reset within a microtask, without spending a frame", async () => {
    document.body.innerHTML = `<form><input type="checkbox" checked></form>`;
    const onReset = vi.fn();
    watcher = new FormResetWatcher(() => true, onReset);
    watcher.observe();

    form().reset();
    await microtask();

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it("ignores a reset from a form it does not own", async () => {
    document.body.innerHTML = `<form id="mine"></form><form id="theirs"></form>`;
    const onReset = vi.fn();
    watcher = new FormResetWatcher((candidate) => candidate.id === "mine", onReset);
    watcher.observe();

    (document.getElementById("theirs") as HTMLFormElement).reset();
    await microtask();

    expect(onReset).not.toHaveBeenCalled();
  });

  it("ignores a reset event whose target is not a form", async () => {
    document.body.innerHTML = `<div id="not-a-form"></div>`;
    const onReset = vi.fn();
    const owns = vi.fn(() => true);
    watcher = new FormResetWatcher(owns, onReset);
    watcher.observe();

    (document.getElementById("not-a-form") as HTMLElement).dispatchEvent(
      new Event("reset", { bubbles: true }),
    );
    await microtask();

    expect(owns).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });

  it("reaches a control the owner associated through the form attribute", async () => {
    document.body.innerHTML = `
      <form id="external"></form>
      <input id="outside" type="checkbox" form="external" checked>`;
    const outside = document.getElementById("outside") as HTMLInputElement;
    const onReset = vi.fn();
    watcher = new FormResetWatcher((candidate) => outside.form === candidate, onReset);
    watcher.observe();

    (document.getElementById("external") as HTMLFormElement).reset();
    await microtask();

    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("skips a scripted reset a listener cancelled", async () => {
    document.body.innerHTML = `<form></form>`;
    const onReset = vi.fn();
    watcher = new FormResetWatcher(() => true, onReset);
    watcher.observe();

    form().addEventListener("reset", (event) => event.preventDefault(), { once: true });
    form().reset();
    await microtask();

    expect(onReset).not.toHaveBeenCalled();
  });

  it("waits for the next frame when the reset is still being dispatched", async () => {
    document.body.innerHTML = `<form></form>`;
    const onReset = vi.fn();
    watcher = new FormResetWatcher(() => true, onReset);
    watcher.observe();

    dispatchMidFlight(form());
    await microtask();

    expect(onReset).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);

    paint();
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("skips a mid-dispatch reset a listener cancelled", async () => {
    document.body.innerHTML = `<form></form>`;
    const onReset = vi.fn();
    watcher = new FormResetWatcher(() => true, onReset);
    watcher.observe();

    dispatchMidFlight(form(), true);
    await microtask();
    paint();

    expect(onReset).not.toHaveBeenCalled();
  });

  it("drops a pass queued before disconnect", async () => {
    document.body.innerHTML = `<form></form>`;
    const onReset = vi.fn();
    watcher = new FormResetWatcher(() => true, onReset);
    watcher.observe();

    form().reset();
    watcher.disconnect();
    await microtask();

    expect(onReset).not.toHaveBeenCalled();
  });

  it("cancels a frame still pending at disconnect", async () => {
    document.body.innerHTML = `<form></form>`;
    const onReset = vi.fn();
    watcher = new FormResetWatcher(() => true, onReset);
    watcher.observe();

    dispatchMidFlight(form());
    await microtask();
    expect(frames.size).toBe(1);

    watcher.disconnect();
    expect(cancelled).toHaveLength(1);

    paint();
    expect(onReset).not.toHaveBeenCalled();
  });

  it("stops receiving resets after disconnect", async () => {
    document.body.innerHTML = `<form></form>`;
    const onReset = vi.fn();
    watcher = new FormResetWatcher(() => true, onReset);
    watcher.observe();
    watcher.disconnect();

    form().reset();
    await microtask();

    expect(onReset).not.toHaveBeenCalled();
  });

  it("subscribes once for repeated observe calls and re-arms after disconnect", async () => {
    document.body.innerHTML = `<form></form>`;
    const onReset = vi.fn();
    watcher = new FormResetWatcher(() => true, onReset);
    watcher.observe();
    watcher.observe();

    form().reset();
    await microtask();
    expect(onReset).toHaveBeenCalledTimes(1);

    watcher.disconnect();
    watcher.observe();

    form().reset();
    await microtask();
    expect(onReset).toHaveBeenCalledTimes(2);
  });
});
