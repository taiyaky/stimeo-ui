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

  /** Test helper: simulate a resize notification. */
  trigger(): void {
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
