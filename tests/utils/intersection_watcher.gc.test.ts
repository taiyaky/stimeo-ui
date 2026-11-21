import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { IntersectionWatcher } from "../../src/utils/intersection_watcher";
import { tick } from "../helpers/timing";

/** Uses collectable references independently of the observer setup's strong holder. */
const NativeWeakRef = runInNewContext("WeakRef", Object.create(null)) as typeof WeakRef;

/** Makes a partial native observation fail while retaining only its watcher. */
function failedObservation() {
  const PlatformObserver = globalThis.IntersectionObserver;
  const failure = new Error("partial observation failed");
  let observer: WeakRef<IntersectionObserver> | undefined;
  class FailingObserver extends PlatformObserver {
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      super(callback, options);
      observer = new NativeWeakRef(this);
    }

    override observe(target: Element): void {
      super.observe(target);
      throw failure;
    }
  }
  vi.stubGlobal("IntersectionObserver", FailingObserver);
  const watcher = new IntersectionWatcher(() => {});
  const target = document.createElement("div");
  let caught: unknown;
  try {
    watcher.start(target);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(failure);
  return { watcher, observer };
}

afterEach(() => vi.unstubAllGlobals());

it("releases a failed observer while its reusable watcher remains retained", async () => {
  const probe = failedObservation();
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
  expect(probe.observer).toBeDefined();
  expect(probe.observer?.deref()).toBeUndefined();
  expect(probe.watcher.active).toBe(false);
  expect(probe.watcher.usingPlatformDefaults).toBe(false);
  probe.watcher.stop();
});
