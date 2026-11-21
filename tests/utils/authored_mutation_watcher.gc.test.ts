import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { AuthoredMutationWatcher } from "../../src/utils/authored_mutation_watcher";
import { tick } from "../helpers/timing";

/** Uses native weak references while observer test setup pins the global constructor. */
const NativeWeakRef = runInNewContext("WeakRef", Object.create(null)) as typeof WeakRef;

/** Removes a claimed node before releasing a watcher that remains retained by its consumer. */
function disconnectWithClaimedNode() {
  const root = document.createElement("div");
  const child = document.createElement("span");
  root.append(child);
  const watcher = new AuthoredMutationWatcher(() => {});
  watcher.observe(root, { attributes: ["data-state"], subtree: true, childList: true });
  watcher.claim(child, "data-state", "own");
  child.setAttribute("data-state", "own");
  child.remove();
  watcher.disconnect();
  return { watcher, target: new NativeWeakRef(child) };
}

it("releases claimed detached nodes while a disconnected watcher remains retained", async () => {
  const probe = disconnectWithClaimedNode();
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
  expect(probe.watcher.take()).toEqual([]);
});

/** Retains observer handles independently of the utility's lifetime ownership. */
function retainObservers(): MutationObserver[] {
  const BaseObserver = MutationObserver;
  const observers: MutationObserver[] = [];
  class RetainedObserver extends BaseObserver {
    constructor(callback: MutationCallback) {
      super(callback);
      observers.push(this);
    }
  }
  vi.stubGlobal("MutationObserver", RetainedObserver);
  return observers;
}

/** Leaves an actual write's target reachable only through claims before release. */
function disconnectWithRetainedObserver(kind: "attribute" | "child-list") {
  const root = document.createElement("div");
  const target = document.createElement("span");
  const watcher = new AuthoredMutationWatcher(() => {});
  watcher.observe(root, { attributes: ["data-state"], subtree: true, childList: true });
  if (kind === "attribute") {
    watcher.claim(target, "data-state", "own");
    target.setAttribute("data-state", "own");
    root.setAttribute("data-state", "pending");
  } else {
    root.replaceChildren(target);
    watcher.claimChildList(root, [target], []);
    root.replaceChildren();
  }
  watcher.disconnect();
  return { watcher, target: new NativeWeakRef(target) };
}

/** A write made after disconnection cannot acquire ownership of a detached node. */
function claimAfterDisconnect() {
  const root = document.createElement("div");
  const target = document.createElement("span");
  const watcher = new AuthoredMutationWatcher(() => {});
  watcher.observe(root, { attributes: ["data-state"] });
  watcher.disconnect();
  watcher.claim(target, "data-state", "own");
  target.setAttribute("data-state", "own");
  return { watcher, target: new NativeWeakRef(target) };
}

/** Verifies collection while retaining a separate live positive control. */
async function collectAndCheckControls() {
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
}

afterEach(() => vi.unstubAllGlobals());

it.each(["attribute", "child-list"] as const)(
  "releases %s claim nodes while a retired observer remains retained",
  async (kind) => {
    const observers = retainObservers();
    const probe = disconnectWithRetainedObserver(kind);
    await collectAndCheckControls();
    expect(probe.target.deref()).toBeUndefined();
    expect(probe.watcher.take()).toEqual([]);
    expect(observers[0]?.takeRecords()).toEqual([]);
  },
);

it("does not retain nodes claimed after disconnection", async () => {
  const probe = claimAfterDisconnect();
  await collectAndCheckControls();
  expect(probe.target.deref()).toBeUndefined();
  expect(probe.watcher.take()).toEqual([]);
});
