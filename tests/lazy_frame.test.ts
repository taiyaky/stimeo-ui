import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LazyFrameController } from "../src/controllers/lazy_frame_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link LazyFrameController}, with a mocked IntersectionObserver:
 * load on intersection (src written from the held url), the focus fallback, once-disconnect,
 * once=false reload, cache-restore idempotence, the no-url guard, and teardown.
 */

/** Controllable IntersectionObserver stub: capture the callback and fire entries. */
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  readonly cb: IntersectionObserverCallback;
  /** The options the controller asked for, so their propagation is observable. */
  readonly init: IntersectionObserverInit | undefined;
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
  root = null;
  rootMargin = "0px";
  thresholds = [0];

  constructor(cb: IntersectionObserverCallback, init?: IntersectionObserverInit) {
    this.cb = cb;
    this.init = init;
    MockIntersectionObserver.instances.push(this);
  }

  fire(...states: boolean[]): void {
    this.cb(
      states.map((isIntersecting) => ({ isIntersecting }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }

  /** Leaves the observed area and comes back — what "re-entry" means. */
  reenter(): void {
    this.fire(false);
    this.fire(true);
  }

  static last(): MockIntersectionObserver {
    const last = MockIntersectionObserver.instances.at(-1);
    if (!last) throw new Error("no IntersectionObserver was created");
    return last;
  }
}

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
    disconnectAndStopApplication(application);
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  const frame = () => query("#f");
  const controller = () =>
    application?.getControllerForElementAndIdentifier(
      frame(),
      "stimeo--lazy-frame",
    ) as LazyFrameController | null;

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

    observer.reenter(); // leaves the area and comes back: reload
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
    observer.reenter();
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

  // --- Focus is the first-load fallback, never a reload trigger --------------

  it("does not reload when focus moves inside an already-loaded frame", async () => {
    await mount(
      'data-stimeo--lazy-frame-url-value="/comments" data-stimeo--lazy-frame-once-value="false"',
    );
    const reload = vi.fn();
    (frame() as HTMLElement & { reload: () => void }).reload = reload;
    MockIntersectionObserver.last().fire(true); // loaded
    const loads: Array<{ url: string }> = [];
    frame().addEventListener("stimeo--lazy-frame:load", (e) =>
      loads.push((e as CustomEvent).detail),
    );

    frame().dispatchEvent(new Event("focusin", { bubbles: true }));
    expect(reload).not.toHaveBeenCalled(); // focus started the load; it has no further job
    expect(loads).toEqual([]);
  });

  it("stays quiet across repeated focus moves inside a loaded frame", async () => {
    await mount(
      'data-stimeo--lazy-frame-url-value="/comments" data-stimeo--lazy-frame-once-value="false"',
    );
    const reload = vi.fn();
    (frame() as HTMLElement & { reload: () => void }).reload = reload;
    MockIntersectionObserver.last().fire(true);

    for (let i = 0; i < 3; i += 1) {
      frame().dispatchEvent(new Event("focusin", { bubbles: true }));
    }
    expect(reload).not.toHaveBeenCalled();
  });

  it("treats the first intersection after a focus-started load as the same visit", async () => {
    await mount(
      'data-stimeo--lazy-frame-url-value="/comments" data-stimeo--lazy-frame-once-value="false"',
    );
    const reload = vi.fn();
    (frame() as HTMLElement & { reload: () => void }).reload = reload;
    MockIntersectionObserver.last().fire(false); // starts off-screen, as a lazy frame does
    // Focus starts the load while the frame is off-screen; focusing scrolls it
    // into view, so the intersection that follows is not a re-entry.
    frame().dispatchEvent(new Event("focusin", { bubbles: true }));
    expect(frame().getAttribute("src")).toBe("/comments");

    MockIntersectionObserver.last().fire(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("announces the reload it performed on a genuine re-entry", async () => {
    await mount(
      'data-stimeo--lazy-frame-url-value="/comments" data-stimeo--lazy-frame-once-value="false"',
    );
    const reload = vi.fn();
    (frame() as HTMLElement & { reload: () => void }).reload = reload;
    const observer = MockIntersectionObserver.last();
    observer.fire(true);
    const loads: Array<{ url: string }> = [];
    frame().addEventListener("stimeo--lazy-frame:load", (e) =>
      loads.push((e as CustomEvent).detail),
    );

    observer.reenter();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(loads).toEqual([{ url: "/comments" }]);
  });

  it("coalesces a leave and a return inside one batch into a single reload", async () => {
    await mount(
      'data-stimeo--lazy-frame-url-value="/comments" data-stimeo--lazy-frame-once-value="false"',
    );
    const reload = vi.fn();
    (frame() as HTMLElement & { reload: () => void }).reload = reload;
    const observer = MockIntersectionObserver.last();
    observer.fire(true);

    observer.fire(false, true); // both states delivered in one callback
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("releases the focus listener once the frame has loaded", async () => {
    await mount();
    const released: string[] = [];
    const original = frame().removeEventListener.bind(frame());
    frame().removeEventListener = ((type: string, ...rest: unknown[]) => {
      released.push(type);
      return (original as (...args: unknown[]) => void)(type, ...rest);
    }) as HTMLElement["removeEventListener"];

    MockIntersectionObserver.last().fire(true);
    expect(released).toContain("focusin"); // the fallback is done, not left attached
  });

  // --- Cache restore keeps the mode the frame was configured with -------------

  it("re-arms a restored frame when once is false", async () => {
    await mount(
      'data-stimeo--lazy-frame-url-value="/comments" data-stimeo--lazy-frame-once-value="false"',
      'data-lazy-loaded="true" src="/comments"',
    );
    const reload = vi.fn();
    (frame() as HTMLElement & { reload: () => void }).reload = reload;
    expect(MockIntersectionObserver.instances).toHaveLength(1); // watching again

    const observer = MockIntersectionObserver.last();
    observer.fire(true); // already in view on restore: the same visit, no reload
    expect(reload).not.toHaveBeenCalled();

    observer.reenter();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("starts the visit where a restored frame sits, even out of view", async () => {
    await mount(
      'data-stimeo--lazy-frame-url-value="/comments" data-stimeo--lazy-frame-once-value="false"',
      'data-lazy-loaded="true" src="/comments"',
    );
    const reload = vi.fn();
    (frame() as HTMLElement & { reload: () => void }).reload = reload;

    const observer = MockIntersectionObserver.last();
    observer.fire(false); // where the observer finds it, not a departure
    observer.fire(true); // so scrolling to it for the first time is the same visit
    expect(reload).not.toHaveBeenCalled();

    observer.reenter();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("re-establishes the baseline when a frame that had left reconnects", async () => {
    await mount(
      'data-stimeo--lazy-frame-url-value="/comments" data-stimeo--lazy-frame-once-value="false"',
    );
    const reload = vi.fn();
    (frame() as HTMLElement & { reload: () => void }).reload = reload;
    MockIntersectionObserver.last().fire(true); // loaded
    MockIntersectionObserver.last().fire(false); // and then left the observed area

    controller()?.disconnect();
    controller()?.connect();
    MockIntersectionObserver.last().fire(true); // a restore that lands in view
    expect(reload).not.toHaveBeenCalled();

    MockIntersectionObserver.last().reenter();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("leaves a restored frame alone when once is true", async () => {
    await mount(
      'data-stimeo--lazy-frame-url-value="/comments"',
      'data-lazy-loaded="true" src="/comments"',
    );
    expect(MockIntersectionObserver.instances).toHaveLength(0);
  });

  // --- The load event names the url that was actually fetched -----------------

  it("points the frame at a url that changed, and announces that url", async () => {
    await mount(
      'data-stimeo--lazy-frame-url-value="/a" data-stimeo--lazy-frame-once-value="false"',
    );
    const observer = MockIntersectionObserver.last();
    observer.fire(true);
    expect(frame().getAttribute("src")).toBe("/a");

    frame().setAttribute("data-stimeo--lazy-frame-url-value", "/b");
    await tick();
    const loads: Array<{ url: string }> = [];
    frame().addEventListener("stimeo--lazy-frame:load", (e) =>
      loads.push((e as CustomEvent).detail),
    );

    observer.reenter();
    expect(frame().getAttribute("src")).toBe("/b");
    expect(loads).toEqual([{ url: "/b" }]);
  });

  it("never writes an empty src when the url is taken away", async () => {
    await mount();
    const observer = MockIntersectionObserver.last();
    frame().setAttribute("data-stimeo--lazy-frame-url-value", "");
    // Stimulus delivers value callbacks asynchronously, so the load path can run
    // between the attribute changing and the frame being disarmed: it reads the
    // held url where it uses it.
    observer.fire(true);
    expect(frame().hasAttribute("src")).toBe(false);
    expect(frame().hasAttribute("data-lazy-loaded")).toBe(false);

    await tick();
    observer.fire(true);
    expect(frame().hasAttribute("src")).toBe(false);
  });

  // --- Runtime configuration --------------------------------------------------

  it("arms a frame whose url arrives after it connected", async () => {
    await mount("");
    expect(MockIntersectionObserver.instances).toHaveLength(0);

    frame().setAttribute("data-stimeo--lazy-frame-url-value", "/late");
    await tick();
    expect(MockIntersectionObserver.instances).toHaveLength(1);

    MockIntersectionObserver.last().fire(true);
    expect(frame().getAttribute("src")).toBe("/late");
  });

  it("disarms a frame whose url is taken away, and arms it again when one arrives", async () => {
    const armed = MockIntersectionObserver.last;
    await mount();
    const observer = armed();

    frame().setAttribute("data-stimeo--lazy-frame-url-value", "");
    await tick();
    expect(observer.disconnect).toHaveBeenCalled(); // an empty url holds no triggers
    frame().dispatchEvent(new Event("focusin", { bubbles: true }));
    expect(frame().hasAttribute("src")).toBe(false);

    frame().setAttribute("data-stimeo--lazy-frame-url-value", "/late");
    await tick();
    armed().fire(true);
    expect(frame().getAttribute("src")).toBe("/late");
  });

  it("passes rootMargin to the observer and follows a runtime change", async () => {
    await mount(
      'data-stimeo--lazy-frame-url-value="/comments" data-stimeo--lazy-frame-root-margin-value="200px"',
    );
    expect(MockIntersectionObserver.last().init?.rootMargin).toBe("200px");

    frame().setAttribute("data-stimeo--lazy-frame-root-margin-value", "1200px");
    await tick();
    expect(MockIntersectionObserver.last().init?.rootMargin).toBe("1200px");
  });

  it("releases the focus listener on disconnect", async () => {
    await mount();
    controller()?.disconnect();
    frame().dispatchEvent(new Event("focusin", { bubbles: true }));
    expect(frame().hasAttribute("src")).toBe(false);
  });

  it("has no a11y violations", async () => {
    await mount();
    await expectNoA11yViolations(frame());
  });
});
