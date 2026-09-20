import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LayoutObserver } from "../../src/utils/layout_observer";

/**
 * Unit tests for {@link LayoutObserver}. A fake {@link ResizeObserver} keeps the
 * element-resize path deterministic (happy-dom does not synthesize real resize
 * notifications), while the viewport path is driven by dispatching `resize`.
 */

/** Minimal controllable ResizeObserver double that records observed elements. */
class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed = new Set<Element>();
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.add(element);
  }

  unobserve(element: Element): void {
    this.observed.delete(element);
  }

  disconnect(): void {
    this.observed.clear();
    this.disconnected = true;
  }

  /** Test helper: simulate a notification for an element still being observed. */
  trigger(element?: Element): void {
    if (element && !this.observed.has(element)) return;
    this.callback([], this);
  }
}

describe("LayoutObserver", () => {
  beforeEach(() => {
    FakeResizeObserver.instances = [];
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  const makeObserver = (callback: () => void) =>
    new LayoutObserver(callback, {
      resizeObserverFactory: (cb) => new FakeResizeObserver(cb),
    });

  describe("viewport", () => {
    it("invokes the callback on window resize", () => {
      const spy = vi.fn();
      const observer = new LayoutObserver(spy);
      observer.observeViewport();

      window.dispatchEvent(new Event("resize"));
      expect(spy).toHaveBeenCalledTimes(1);
      observer.disconnect();
    });

    it("registers the viewport listener only once", () => {
      const spy = vi.fn();
      const observer = new LayoutObserver(spy);
      observer.observeViewport();
      observer.observeViewport();

      window.dispatchEvent(new Event("resize"));
      expect(spy).toHaveBeenCalledTimes(1);
      observer.disconnect();
    });

    it("stops invoking the callback after disconnect", () => {
      const spy = vi.fn();
      const observer = new LayoutObserver(spy);
      observer.observeViewport();
      observer.disconnect();

      window.dispatchEvent(new Event("resize"));
      expect(spy).not.toHaveBeenCalled();
    });

    it("unobserveViewport removes only the viewport listener", () => {
      const spy = vi.fn();
      const observer = new LayoutObserver(spy);
      observer.observeViewport();
      observer.unobserveViewport();

      window.dispatchEvent(new Event("resize"));
      expect(spy).not.toHaveBeenCalled();
    });

    it("unobserveViewport leaves element resize observation active", () => {
      const spy = vi.fn();
      const observer = makeObserver(spy);
      const element = document.createElement("div");
      observer.observe(element);
      observer.observeViewport();
      observer.unobserveViewport();

      window.dispatchEvent(new Event("resize"));
      expect(spy).not.toHaveBeenCalled();
      FakeResizeObserver.instances[0]?.trigger(element);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe("element resize", () => {
    it("observes an element and invokes the callback on resize", () => {
      const spy = vi.fn();
      const observer = makeObserver(spy);
      const element = document.createElement("div");

      observer.observe(element);
      const ro = FakeResizeObserver.instances[0];
      expect(ro?.observed.has(element)).toBe(true);

      ro?.trigger();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("reuses a single ResizeObserver for multiple elements", () => {
      const observer = makeObserver(vi.fn());
      observer.observe(document.createElement("div"));
      observer.observe(document.createElement("div"));

      expect(FakeResizeObserver.instances).toHaveLength(1);
    });

    it("unobserve stops watching a single element", () => {
      const observer = makeObserver(vi.fn());
      const element = document.createElement("div");
      observer.observe(element);
      observer.unobserve(element);

      expect(FakeResizeObserver.instances[0]?.observed.has(element)).toBe(false);
    });

    it("unobserve leaves callbacks active for other observed elements", () => {
      const spy = vi.fn();
      const observer = makeObserver(spy);
      const removed = document.createElement("div");
      const remaining = document.createElement("div");
      observer.observe(removed);
      observer.observe(remaining);
      observer.unobserve(removed);

      const ro = FakeResizeObserver.instances[0];
      ro?.trigger(removed);
      expect(spy).not.toHaveBeenCalled();
      ro?.trigger(remaining);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("disconnect tears down the ResizeObserver", () => {
      const observer = makeObserver(vi.fn());
      observer.observe(document.createElement("div"));
      observer.disconnect();

      expect(FakeResizeObserver.instances[0]?.disconnected).toBe(true);
    });

    it("creates a fresh ResizeObserver after disconnect (reconnect)", () => {
      const observer = makeObserver(vi.fn());
      observer.observe(document.createElement("div"));
      observer.disconnect();
      observer.observe(document.createElement("div"));

      expect(FakeResizeObserver.instances).toHaveLength(2);
      expect(FakeResizeObserver.instances[1]?.disconnected).toBe(false);
    });

    it("no-ops when no ResizeObserver implementation is available", () => {
      const original = globalThis.ResizeObserver;
      // @ts-expect-error deliberately removing the global for this assertion
      globalThis.ResizeObserver = undefined;
      try {
        const bare = new LayoutObserver(vi.fn());
        expect(() => bare.observe(document.createElement("div"))).not.toThrow();
        expect(() => bare.disconnect()).not.toThrow();
      } finally {
        globalThis.ResizeObserver = original;
      }
    });
  });

  describe("descendant loads", () => {
    /** A container holding one image, both attached so events propagate for real. */
    const container = (id: string): { root: HTMLElement; image: HTMLElement } => {
      const root = document.createElement("div");
      root.id = id;
      const image = document.createElement("img");
      root.append(image);
      document.body.append(root);
      return { root, image };
    };

    /** `load` does not bubble, which is the whole reason the listener is a capture one. */
    const fireLoad = (element: HTMLElement): void => {
      element.dispatchEvent(new Event("load"));
    };

    it("reports a load from a descendant", () => {
      const spy = vi.fn();
      const observer = makeObserver(spy);
      const { root, image } = container("content");

      observer.observeDescendantLoads(root);
      fireLoad(image);

      expect(spy).toHaveBeenCalledTimes(1);
      observer.disconnect();
    });

    it("ignores a load outside the container", () => {
      const spy = vi.fn();
      const observer = makeObserver(spy);
      const { root } = container("content");
      const { image: outside } = container("elsewhere");

      observer.observeDescendantLoads(root);
      fireLoad(outside);

      expect(spy).not.toHaveBeenCalled();
      observer.disconnect();
    });

    it("moves the observation, leaving the container it let go inert", () => {
      // The release lives here because the consumer never names it: pointing at
      // the new container is the only thing a swapped target has to do.
      const spy = vi.fn();
      const observer = makeObserver(spy);
      const first = container("first");
      const second = container("second");

      observer.observeDescendantLoads(first.root);
      observer.observeDescendantLoads(second.root);
      fireLoad(first.image);
      expect(spy).not.toHaveBeenCalled();

      fireLoad(second.image);
      expect(spy).toHaveBeenCalledTimes(1);
      observer.disconnect();
    });

    it("reports once when the same container is named again", () => {
      const spy = vi.fn();
      const observer = makeObserver(spy);
      const { root, image } = container("content");

      observer.observeDescendantLoads(root);
      observer.observeDescendantLoads(root);
      fireLoad(image);

      expect(spy).toHaveBeenCalledTimes(1);
      observer.disconnect();
    });

    it("stops reporting after unobserveDescendantLoads, which is safe to call unarmed", () => {
      const spy = vi.fn();
      const observer = makeObserver(spy);
      const { root, image } = container("content");

      expect(() => observer.unobserveDescendantLoads()).not.toThrow();
      observer.observeDescendantLoads(root);
      observer.unobserveDescendantLoads();
      observer.unobserveDescendantLoads();
      fireLoad(image);

      expect(spy).not.toHaveBeenCalled();
      observer.disconnect();
    });

    it("leaves element and viewport observation alone", () => {
      const spy = vi.fn();
      const observer = makeObserver(spy);
      const element = document.createElement("div");
      const { root } = container("content");
      observer.observe(element);
      observer.observeViewport();
      observer.observeDescendantLoads(root);

      observer.unobserveDescendantLoads();

      FakeResizeObserver.instances[0]?.trigger(element);
      window.dispatchEvent(new Event("resize"));
      expect(spy).toHaveBeenCalledTimes(2);
      observer.disconnect();
    });
  });

  describe("combined teardown", () => {
    it("disconnect releases both element and viewport observation", () => {
      const spy = vi.fn();
      const observer = makeObserver(spy);
      observer.observe(document.createElement("div"));
      observer.observeViewport();

      observer.disconnect();

      const ro = FakeResizeObserver.instances[0];
      expect(ro?.disconnected).toBe(true);
      window.dispatchEvent(new Event("resize"));
      expect(spy).not.toHaveBeenCalled();
    });

    it("is safe to disconnect twice", () => {
      const observer = makeObserver(vi.fn());
      observer.observe(document.createElement("div"));
      observer.observeViewport();

      observer.disconnect();
      expect(() => observer.disconnect()).not.toThrow();
    });

    it("disconnect releases descendant loads, and they can be observed again", () => {
      const spy = vi.fn();
      const observer = makeObserver(spy);
      const root = document.createElement("div");
      const image = document.createElement("img");
      root.append(image);
      document.body.append(root);
      observer.observeDescendantLoads(root);

      observer.disconnect();
      image.dispatchEvent(new Event("load"));
      expect(spy).not.toHaveBeenCalled();

      observer.observeDescendantLoads(root);
      image.dispatchEvent(new Event("load"));
      expect(spy).toHaveBeenCalledTimes(1);
      observer.disconnect();
    });

    it("can re-observe the viewport after disconnect", () => {
      const spy = vi.fn();
      const observer = makeObserver(spy);
      observer.observeViewport();
      observer.disconnect();

      observer.observeViewport();
      window.dispatchEvent(new Event("resize"));
      expect(spy).toHaveBeenCalledTimes(1);
      observer.disconnect();
    });
  });
});
