import { afterEach, describe, expect, it, vi } from "vitest";
import { MorphRenderWatcher } from "../../src/utils/morph_render_watcher";
import { flushMicrotasks } from "../helpers/timing";

/** Retained-element morphs and lifecycle requests share one cancellable microtask. */
describe("MorphRenderWatcher", () => {
  const watchers: MorphRenderWatcher[] = [];
  afterEach(() => {
    for (const watcher of watchers) watcher.disconnect();
    watchers.length = 0;
  });

  function setup() {
    const run = vi.fn();
    const watcher = new MorphRenderWatcher(run);
    watchers.push(watcher);
    const root = document.createElement("div");
    const child = document.createElement("span");
    root.append(child);
    return { watcher, run, root, child };
  }

  function morph(element: Element): void {
    element.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
  }

  it("coalesces own, descendant, and explicit requests without running synchronously", async () => {
    const { watcher, run, root, child } = setup();
    watcher.observe(root);
    morph(root);
    morph(child);
    watcher.schedule();
    expect(run).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(run).toHaveBeenCalledTimes(1);
    morph(child);
    await flushMicrotasks();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not run or replay requests made before observation", async () => {
    const { watcher, run, root } = setup();
    watcher.schedule();
    morph(root);
    watcher.observe(root);
    await flushMicrotasks();
    expect(run).not.toHaveBeenCalled();
  });

  it("preserves a queued request across repeated observation of the same element", async () => {
    const { watcher, run, root } = setup();
    watcher.observe(root);
    watcher.schedule();
    watcher.observe(root);
    await flushMicrotasks();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("releases listeners and queued work on disconnect, including repeated disconnects", async () => {
    const { watcher, run, root, child } = setup();
    watcher.disconnect();
    watcher.observe(root);
    morph(child);
    watcher.disconnect();
    watcher.disconnect();
    morph(root);
    watcher.schedule();
    await flushMicrotasks();
    expect(run).not.toHaveBeenCalled();
  });

  it("replaces the observed element and discards the previous generation", async () => {
    const { watcher, run, root } = setup();
    const next = document.createElement("div");
    watcher.observe(root);
    morph(root);
    watcher.observe(next);
    morph(root);
    await flushMicrotasks();
    expect(run).not.toHaveBeenCalled();
    morph(next);
    await flushMicrotasks();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps a fresh request behind its own horizon when reconnecting before an old pass drains", async () => {
    const root = document.createElement("div");
    let settled = false;
    const observations: boolean[] = [];
    const watcher = new MorphRenderWatcher(() => observations.push(settled));
    watchers.push(watcher);
    watcher.observe(root);
    morph(root);
    watcher.disconnect();
    watcher.observe(root);
    queueMicrotask(() => {
      settled = true;
    });
    morph(root);
    await flushMicrotasks();
    expect(observations).toEqual([true]);
  });

  it("allows a running pass to schedule the next pass", async () => {
    let runs = 0;
    const watcher = new MorphRenderWatcher(() => {
      runs += 1;
      if (runs === 1) watcher.schedule();
    });
    watchers.push(watcher);
    watcher.observe(document.createElement("div"));
    watcher.schedule();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(runs).toBe(2);
  });

  it("ignores unrelated events and events outside the observed subtree", async () => {
    const { watcher, run, root } = setup();
    watcher.observe(root);
    root.dispatchEvent(new Event("change", { bubbles: true }));
    morph(document.createElement("div"));
    await flushMicrotasks();
    expect(run).not.toHaveBeenCalled();
  });
});
