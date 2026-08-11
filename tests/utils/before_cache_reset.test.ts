import { afterEach, describe, expect, it, vi } from "vitest";
import { BeforeCacheReset } from "../../src/utils/before_cache_reset";

/**
 * Behavioral tests for {@link BeforeCacheReset}: the subscription itself, the
 * symmetry between `activate()` / `deactivate()`, the idempotence both hooks
 * promise, and the single shared document listener that backs many instances.
 */
describe("BeforeCacheReset", () => {
  const beforeCache = "turbo:before-cache";
  const created: BeforeCacheReset[] = [];

  afterEach(() => {
    for (const subscription of created) subscription.deactivate();
    created.length = 0;
  });

  /** A subscription plus the counter its rewind pass increments. */
  const subscription = () => {
    const calls = { count: 0 };
    const instance = new BeforeCacheReset(() => {
      calls.count += 1;
    });
    created.push(instance);
    return { instance, calls };
  };

  const cache = () => document.dispatchEvent(new Event(beforeCache));

  it("runs the rewind pass on turbo:before-cache", () => {
    const { instance, calls } = subscription();
    instance.activate();
    cache();
    expect(calls.count).toBe(1);
  });

  it("does nothing before activate", () => {
    // The consumer subscribes from `connect()`; an instance that was constructed
    // as a field initialiser must stay inert until then.
    const { calls } = subscription();
    cache();
    expect(calls.count).toBe(0);
  });

  it("stops running the pass after deactivate", () => {
    const { instance, calls } = subscription();
    instance.activate();
    instance.deactivate();
    cache();
    expect(calls.count).toBe(0);
  });

  it("runs again on a later navigation while still subscribed", () => {
    // A cached page can be visited and left repeatedly without reconnecting.
    const { instance, calls } = subscription();
    instance.activate();
    cache();
    cache();
    expect(calls.count).toBe(2);
  });

  it("resubscribes after a deactivate", () => {
    const { instance, calls } = subscription();
    instance.activate();
    instance.deactivate();
    instance.activate();
    cache();
    expect(calls.count).toBe(1);
  });

  describe("idempotence", () => {
    it("does not run the pass twice after a repeated activate", () => {
      const { instance, calls } = subscription();
      instance.activate();
      instance.activate();
      cache();
      expect(calls.count).toBe(1);
    });

    it("installs one document listener however many times activate is called", () => {
      // Idempotence is a property of this util, not of the DOM's own listener
      // de-duplication: the registration itself must happen once.
      const add = vi.spyOn(document, "addEventListener");
      const { instance } = subscription();
      instance.activate();
      instance.activate();
      expect(add.mock.calls.filter(([type]) => type === beforeCache)).toHaveLength(1);
      add.mockRestore();
    });

    it("survives a deactivate on an instance that never subscribed", () => {
      const { instance, calls } = subscription();
      expect(() => instance.deactivate()).not.toThrow();
      cache();
      expect(calls.count).toBe(0);
    });

    it("survives a repeated deactivate", () => {
      const { instance, calls } = subscription();
      instance.activate();
      instance.deactivate();
      instance.deactivate();
      cache();
      expect(calls.count).toBe(0);
    });
  });

  describe("many instances on one listener", () => {
    it("runs every subscriber's pass", () => {
      const first = subscription();
      const second = subscription();
      first.instance.activate();
      second.instance.activate();
      cache();
      expect([first.calls.count, second.calls.count]).toEqual([1, 1]);
    });

    it("installs the document listener only once for several instances", () => {
      const add = vi.spyOn(document, "addEventListener");
      const first = subscription();
      const second = subscription();
      first.instance.activate();
      second.instance.activate();
      expect(add.mock.calls.filter(([type]) => type === beforeCache)).toHaveLength(1);
      add.mockRestore();
    });

    it("keeps the listener while another instance is still subscribed", () => {
      // One controller disconnecting must not silence the ones still on the page:
      // the shared listener belongs to the whole set, not to whoever installed it.
      const first = subscription();
      const second = subscription();
      first.instance.activate();
      second.instance.activate();
      first.instance.deactivate();
      cache();
      expect([first.calls.count, second.calls.count]).toEqual([0, 1]);
    });

    it("removes the document listener once the last instance leaves", () => {
      const remove = vi.spyOn(document, "removeEventListener");
      const removals = () => remove.mock.calls.filter(([type]) => type === beforeCache).length;
      const first = subscription();
      const second = subscription();
      first.instance.activate();
      second.instance.activate();
      first.instance.deactivate();
      expect(removals()).toBe(0);
      second.instance.deactivate();
      expect(removals()).toBe(1);
      remove.mockRestore();
    });
  });
});
