import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { LayoutObserver } from "../../src/utils/layout_observer";
import { tick } from "../helpers/timing";

/** Uses native weak references while observer test setup pins the global constructor. */
const NativeWeakRef = runInNewContext("WeakRef", Object.create(null)) as typeof WeakRef;

/** Releases a container from a reusable watcher without observing a replacement. */
function releaseContainer() {
  const container = document.createElement("div");
  const watcher = new LayoutObserver(() => {});
  watcher.observeDescendantLoads(container);
  watcher.unobserveDescendantLoads();
  return { watcher, target: new NativeWeakRef(container) };
}

it("releases a former load container while its layout watcher remains retained", async () => {
  const probe = releaseContainer();
  const free = (() => new NativeWeakRef({}))();
  const held = {};
  const heldReference = new NativeWeakRef(held);
  const runtime = globalThis as unknown as {
    Bun?: { gc?: (full: boolean) => void };
    gc?: () => void;
  };
  for (let attempt = 0; attempt < 20; attempt++) {
    await tick();
    if (runtime.Bun?.gc) runtime.Bun.gc(true);
    else if (runtime.gc) runtime.gc();
    else throw new Error("This test requires explicit garbage-collection support.");
  }
  expect(free.deref()).toBeUndefined();
  expect(heldReference.deref()).toBe(held);
  expect(probe.target.deref()).toBeUndefined();
  probe.watcher.disconnect();
});
