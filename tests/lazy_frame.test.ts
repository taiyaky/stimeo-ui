import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LazyFrameController } from "../src/controllers/lazy_frame_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link LazyFrameController}, with a mocked IntersectionObserver:
 * load on intersection (src written from the held url), the focus fallback, once-disconnect,
 * once=false reload, cache-restore idempotence, the no-url guard, and teardown.
 */

/** Controllable IntersectionObserver stub: capture the callback and fire entries. */
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  readonly cb: IntersectionObserverCallback;
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
  root = null;
  rootMargin = "0px";
  thresholds = [0];

  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    MockIntersectionObserver.instances.push(this);
  }

  fire(isIntersecting: boolean): void {
    this.cb(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }

  static last(): MockIntersectionObserver {
    const last = MockIntersectionObserver.instances.at(-1);
    if (!last) throw new Error("no IntersectionObserver was created");
    return last;
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("LazyFrameController", () => {
  let application: Application;

  const mount = async (attrs = 'data-stimeo--lazy-frame-url-value="/comments"', extra = "") => {
    document.body.innerHTML = `<turbo-frame id="f" data-controller="stimeo--lazy-frame" ${attrs} ${extra}>Loading…</turbo-frame>`;
    application = Application.start();
    application.register("stimeo--lazy-frame", LazyFrameController);
    await tick();
  };

  beforeEach(() => {
    MockIntersectionObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    document.body.innerHTML = "";
  });

  afterEach(() => {
    application.stop();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  const frame = () => query("#f");

  it("loads the frame by writing the held url to src on intersection", async () => {
    await mount();
    const loads: Array<{ url: string }> = [];
    frame().addEventListener("stimeo--lazy-frame:load", (e) =>
      loads.push((e as CustomEvent).detail),
    );
    expect(frame().hasAttribute("src")).toBe(false); // held, not loaded yet

    MockIntersectionObserver.last().fire(true);
    expect(frame().getAttribute("src")).toBe("/comments");
    expect(frame().getAttribute("data-lazy-loaded")).toBe("true");
    expect(loads).toEqual([{ url: "/comments" }]);
  });

  it("does not load while the frame is not intersecting", async () => {
    await mount();
    MockIntersectionObserver.last().fire(false);
    expect(frame().hasAttribute("src")).toBe(false);
    expect(frame().hasAttribute("data-lazy-loaded")).toBe(false);
  });

  it("loads when focus reaches the frame before it intersects", async () => {
    await mount();
    frame().dispatchEvent(new Event("focusin", { bubbles: true }));
    expect(frame().getAttribute("src")).toBe("/comments");
    expect(frame().getAttribute("data-lazy-loaded")).toBe("true");
  });

  it("stops observing after the first load when once (default)", async () => {
    await mount();
    const observer = MockIntersectionObserver.last();
    observer.fire(true);
    expect(observer.disconnect).toHaveBeenCalled();
  });

  it("reloads on re-entry when once is false", async () => {
    await mount(
      'data-stimeo--lazy-frame-url-value="/comments" data-stimeo--lazy-frame-once-value="false"',
    );
    const reload = vi.fn();
    (frame() as HTMLElement & { reload: () => void }).reload = reload;
    const observer = MockIntersectionObserver.last();

    observer.fire(true); // first: load
    expect(frame().getAttribute("src")).toBe("/comments");
    expect(observer.disconnect).not.toHaveBeenCalled(); // keeps observing

    observer.fire(true); // re-entry: reload
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not emit load on re-entry when the host has no reload()", async () => {
    await mount(
      'data-stimeo--lazy-frame-url-value="/comments" data-stimeo--lazy-frame-once-value="false"',
    );
    const observer = MockIntersectionObserver.last();
    observer.fire(true); // first: load
    const loads: Array<{ url: string }> = [];
    frame().addEventListener("stimeo--lazy-frame:load", (e) =>
      loads.push((e as CustomEvent).detail),
    );
    // Re-entry on a host without reload(): nothing reloads, so no load is announced.
    observer.fire(true);
    expect(loads).toEqual([]);
  });

  it("respects an already-loaded frame on a cache restore", async () => {
    await mount('data-stimeo--lazy-frame-url-value="/comments"', 'data-lazy-loaded="true"');
    expect(MockIntersectionObserver.instances).toHaveLength(0); // not observed again
  });

  it("does nothing when no url is held", async () => {
    await mount("");
    expect(MockIntersectionObserver.instances).toHaveLength(0);
    frame().dispatchEvent(new Event("focusin", { bubbles: true }));
    expect(frame().hasAttribute("src")).toBe(false);
  });

  it("disconnects the observer and focus listener on disconnect", async () => {
    await mount();
    const observer = MockIntersectionObserver.last();
    frame().remove();
    await tick();
    expect(observer.disconnect).toHaveBeenCalled();
  });

  it("has no a11y violations", async () => {
    await mount();
    await expectNoA11yViolations(frame());
  });
});
