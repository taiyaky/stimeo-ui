import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TransitionCompletion } from "../../src/utils/transition_completion";
import { tick } from "../helpers/timing";

/** Uses the native weak reference rather than the observer setup's strong holder. */
const NativeWeakRef = runInNewContext("WeakRef", Object.create(null)) as typeof WeakRef;

/** A transition's minimal element interface without happy-dom's document-owned roots. */
function makeTarget(): HTMLElement {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    addEventListener: (type: string, listener: EventListener) => {
      let registered = listeners.get(type);
      if (!registered) {
        registered = new Set<EventListener>();
        listeners.set(type, registered);
      }
      registered.add(listener);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    },
  } as unknown as HTMLElement;
}

/** Forces a full collection under the supported test runtimes. */
function forceFullGc(): void {
  const runtime = globalThis as unknown as {
    Bun?: { gc?: (fullCollection?: boolean) => void };
    gc?: () => void;
  };
  if (typeof runtime.Bun?.gc === "function") runtime.Bun.gc(true);
  else if (typeof runtime.gc === "function") runtime.gc();
  else throw new Error("This test requires explicit garbage-collection support.");
}

/** Allows callback jobs and native weak-reference retention to expire before collection. */
async function collected(target: WeakRef<object>): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt++) {
    await tick();
    forceFullGc();
    await tick();
    if (target.deref() === undefined) return true;
  }
  return false;
}

/** Owns no reference to its payload after returning, except through the live wait. */
function makeWait(mode: "pending" | "cancelled" | "finished"): {
  transition: TransitionCompletion;
  payload: WeakRef<object>;
  element: WeakRef<object>;
} {
  const transition = new TransitionCompletion();
  const element = makeTarget();
  const payload = { completed: false };
  transition.wait(
    element,
    () => {
      payload.completed = true;
    },
    { timeoutMs: mode === "finished" ? 1 : 60_000 },
  );
  if (mode === "cancelled") transition.cancel();
  return { transition, payload: new NativeWeakRef(payload), element: new NativeWeakRef(element) };
}

/** A collector control with no strong owner after its construction returns. */
function makeUnreferenced(): WeakRef<object> {
  return new NativeWeakRef({});
}

const originalGetComputedStyle = window.getComputedStyle;

describe("TransitionCompletion resource release", () => {
  beforeEach(() => {
    window.getComputedStyle = () =>
      ({
        transitionProperty: "opacity",
        transitionDuration: "10s",
        transitionDelay: "0s",
      }) as CSSStyleDeclaration;
  });

  afterEach(() => {
    window.getComputedStyle = originalGetComputedStyle;
  });

  it("retains callback data only while a wait is pending", async () => {
    const pending = makeWait("pending");
    try {
      expect(await collected(makeUnreferenced())).toBe(true);
      expect(await collected(pending.payload)).toBe(false);
      pending.transition.cancel();
      expect(await collected(pending.payload)).toBe(true);
    } finally {
      pending.transition.cancel();
    }
  });

  it("releases callback data after completion even while the utility remains alive", async () => {
    const finished = makeWait("finished");
    expect(await collected(makeUnreferenced())).toBe(true);
    expect(await collected(finished.payload)).toBe(true);
    expect(await collected(finished.element)).toBe(true);
    finished.transition.cancel();
  });

  it("releases the former element on cancel while keeping a pending element alive", async () => {
    const pending = makeWait("pending");
    const cancelled = makeWait("cancelled");
    try {
      expect(await collected(makeUnreferenced())).toBe(true);
      expect(await collected(pending.element)).toBe(false);
      expect(await collected(cancelled.element)).toBe(true);
      pending.transition.cancel();
      expect(await collected(pending.element)).toBe(true);
    } finally {
      pending.transition.cancel();
      cancelled.transition.cancel();
    }
  });
});
