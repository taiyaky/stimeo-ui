import { describe, expect, it } from "vitest";
import { flushMicrotasks, tick } from "./timing";

/**
 * Pins the semantic difference between the two waiting primitives, so a
 * refactor cannot silently collapse the microtask flush into a macrotask
 * wait (or vice versa).
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
