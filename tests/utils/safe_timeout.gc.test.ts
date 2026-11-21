import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { SafeTimeout, TaskTimeout, type TimeoutTask } from "../../src/utils/safe_timeout";
import { tick } from "../helpers/timing";

/** Uses a native weak reference instead of the observer setup's strong holder. */
const NativeWeakRef = runInNewContext("WeakRef", Object.create(null)) as typeof WeakRef;

/** Forces collection under either supported test runtime. */
function forceFullGc(): void {
  const runtime = globalThis as unknown as {
    Bun?: { gc?: (fullCollection?: boolean) => void };
    gc?: () => void;
  };
  if (typeof runtime.Bun?.gc === "function") runtime.Bun.gc(true);
  else if (typeof runtime.gc === "function") runtime.gc();
  else throw new Error("This test requires explicit garbage-collection support.");
}

/** Yields past the current job before checking whether its weak target was collected. */
async function collected(target: WeakRef<object>): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt++) {
    await tick();
    forceFullGc();
    await tick();
    if (target.deref() === undefined) return true;
  }
  return false;
}

/** Holds a callback payload only through its registration, never through the returned handle. */
function makeTask(mode: "pending" | "cancelled" | "finished" | "bulk-cleared"): {
  timers: TaskTimeout;
  task: TimeoutTask;
  payload: WeakRef<object>;
} {
  const timers = new TaskTimeout();
  const payload = { completed: false };
  const task = timers.setTask(
    () => {
      payload.completed = true;
    },
    mode === "finished" ? 1 : 60_000,
  );
  if (mode === "cancelled") task.cancel();
  if (mode === "bulk-cleared") timers.clearAll();
  return { timers, task, payload: new NativeWeakRef(payload) };
}

/** Provides an unowned target so collection failure cannot masquerade as retention. */
function makeUnreferenced(): WeakRef<object> {
  return new NativeWeakRef({});
}

it("retains callback data while pending and releases it while keeping expired handles", async () => {
  const pending = makeTask("pending");
  const cancelled = makeTask("cancelled");
  const finished = makeTask("finished");
  const bulkCleared = makeTask("bulk-cleared");
  try {
    expect(await collected(makeUnreferenced())).toBe(true);
    expect(await collected(pending.payload)).toBe(false);
    expect(await collected(cancelled.payload)).toBe(true);
    expect(finished.task.pending).toBe(false);
    expect(finished.timers.size).toBe(0);
    expect(await collected(finished.payload)).toBe(true);
    expect(await collected(bulkCleared.payload)).toBe(true);
    pending.task.cancel();
    expect(await collected(pending.payload)).toBe(true);
    for (const entry of [pending, cancelled, finished, bulkCleared]) {
      expect(entry.task.pending).toBe(false);
      entry.task.cancel();
      expect(entry.timers.size).toBe(0);
    }
  } finally {
    for (const entry of [pending, cancelled, finished, bulkCleared]) entry.timers.clearAll();
  }
});

/** Creates a numeric timer without retaining its platform handle. */
function makePlainTimeout(): { timers: SafeTimeout; payload: WeakRef<object> } {
  const timers = new SafeTimeout();
  const payload = { completed: false };
  timers.set(() => {
    payload.completed = true;
  }, 1);
  return { timers, payload: new NativeWeakRef(payload) };
}

it("releases plain callback data after completion with the registry alive", async () => {
  const plain = makePlainTimeout();
  expect(await collected(makeUnreferenced())).toBe(true);
  expect(await collected(plain.payload)).toBe(true);
  expect(plain.timers.size).toBe(0);
});

/** Observes the returned registration object without keeping it alive through the caller. */
function makeUnownedHandle(mode: "pending" | "cancelled" | "finished" | "bulk-cleared"): {
  timers: TaskTimeout;
  task: WeakRef<object>;
} {
  const timers = new TaskTimeout();
  const task = timers.setTask(() => {}, mode === "finished" ? 1 : 60_000);
  if (mode === "cancelled") task.cancel();
  if (mode === "bulk-cleared") timers.clearAll();
  return { timers, task: new NativeWeakRef(task) };
}

it("forgets expired registration objects while preserving a pending registration", async () => {
  const pending = makeUnownedHandle("pending");
  const cancelled = makeUnownedHandle("cancelled");
  const finished = makeUnownedHandle("finished");
  const bulkCleared = makeUnownedHandle("bulk-cleared");
  try {
    expect(await collected(makeUnreferenced())).toBe(true);
    expect(await collected(pending.task)).toBe(false);
    expect(await collected(cancelled.task)).toBe(true);
    expect(await collected(finished.task)).toBe(true);
    expect(await collected(bulkCleared.task)).toBe(true);
    pending.timers.clearAll();
    expect(await collected(pending.task)).toBe(true);
    for (const entry of [pending, cancelled, finished, bulkCleared]) {
      expect(entry.timers.size).toBe(0);
    }
  } finally {
    for (const entry of [pending, cancelled, finished, bulkCleared]) entry.timers.clearAll();
  }
});
