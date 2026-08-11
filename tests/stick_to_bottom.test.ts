import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StickToBottomController } from "../src/controllers/stick_to_bottom_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link StickToBottomController}. happy-dom has no layout, so the
 * scroll geometry is stubbed and `scrollTo` is mocked: pinned detection, the opt-in
 * `pinOnConnect` start (instant jump, whatever `behavior` says), follow-on-append while
 * pinned, the has-new flag + event while unpinned, scroll-driven re-pin, the
 * scrollToBottom action, reduced-motion behavior, and teardown. Real scrolling needs a
 * real browser and is not asserted here.
 */

let originalMatchMedia: typeof window.matchMedia;
const setReducedMotion = (reduce: boolean) => {
  window.matchMedia = ((q: string) => ({
    media: q,
    matches: reduce && q.includes("prefers-reduced-motion"),
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;
};

/** Minimal controllable ResizeObserver double, so the deferred jump is observable. */
class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed = new Set<Element>();

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
  }
  /** Test helper: notify as if the observed element gained (or changed) its box. */
  trigger(): void {
    this.callback([], this);
  }
}

describe("StickToBottomController", () => {
  let application: Application;
  let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;

  const setup = (attrs = "") => {
    document.body.innerHTML = `
      <div id="box" data-controller="stimeo--stick-to-bottom" ${attrs}>
        <ul id="content" data-stimeo--stick-to-bottom-target="content"><li>1</li></ul>
      </div>`;
  };
  const start = async () => {
    application = Application.start();
    application.register("stimeo--stick-to-bottom", StickToBottomController);
    await tick();
  };

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    setReducedMotion(false);
    document.body.innerHTML = "";
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    window.matchMedia = originalMatchMedia;
    document.body.innerHTML = "";
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
      originalResizeObserver = undefined;
    }
    FakeResizeObserver.instances = [];
  });

  /** Installs the double so a container with no box can be given one mid-test. */
  const stubResizeObserver = () => {
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof globalThis.ResizeObserver;
  };

  const box = () => query("#box");
  const content = () => query("#content");

  /** Stubs the scroll geometry; distance-from-bottom = scrollHeight - clientHeight - scrollTop. */
  const setGeom = (scrollHeight: number, clientHeight: number, scrollTop: number) => {
    for (const [key, value] of Object.entries({ scrollHeight, clientHeight, scrollTop })) {
      Object.defineProperty(box(), key, { configurable: true, value });
    }
  };
  const appendChild = async () => {
    content().appendChild(document.createElement("li"));
    await tick();
  };
  /**
   * Replaces `scrollTo` with a spy. Install it *before* `start()` to observe the
   * connect-time jump: happy-dom's own `scrollTo` writes `scrollTop`, which `setGeom`
   * has redefined as a non-writable property.
   */
  const spyOnScrollTo = () => {
    const spy = vi.fn();
    box().scrollTo = spy;
    return spy;
  };
  /**
   * Replaces `scrollTo` with a spy that *lands* the scroll: it writes the requested offset
   * onto the stubbed geometry, clamped to the maximum the way an engine does. A bare
   * `vi.fn()` models the opposite — a request the container never honors.
   */
  const spyOnLandingScrollTo = () => {
    const spy = vi.fn((options?: ScrollToOptions | number) => {
      const el = box();
      const top = typeof options === "object" ? (options?.top ?? 0) : (options ?? 0);
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      Object.defineProperty(el, "scrollTop", { configurable: true, value: Math.min(top, max) });
    });
    box().scrollTo = spy;
    return spy;
  };
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      box(),
      "stimeo--stick-to-bottom",
    ) as StickToBottomController;
  const recordPins = () => {
    const pins: Array<{ pinned: boolean }> = [];
    box().addEventListener("stimeo--stick-to-bottom:pin", (e) =>
      pins.push((e as CustomEvent).detail),
    );
    return pins;
  };

  it("marks pinned on connect when near the bottom", async () => {
    setup();
    setGeom(1000, 400, 600); // distance 0 ≤ 80
    await start();
    expect(box().getAttribute("data-pinned")).toBe("true");
  });

  it("is not pinned on connect when scrolled up", async () => {
    setup();
    setGeom(1000, 400, 100); // distance 500 > 80
    await start();
    expect(box().hasAttribute("data-pinned")).toBe(false);
  });

  it("re-syncs stale hooks from a cache restore on connect", async () => {
    // The cached DOM brings back data-pinned/has-new, but the geometry says unpinned.
    setup('data-pinned="true" data-has-new="true"');
    setGeom(1000, 400, 100); // distance 500 > 80 → not pinned
    await start();
    expect(box().hasAttribute("data-pinned")).toBe(false); // stale value dropped
  });

  it("starts at the bottom, pinned, with pinOnConnect", async () => {
    setup('data-stimeo--stick-to-bottom-pin-on-connect-value="true"');
    setGeom(1000, 400, 0); // rendered at the top: distance 1000 > 80, so unpinned by geometry
    const scrollTo = spyOnLandingScrollTo();
    await start();

    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "instant" });
    expect(box().scrollTop).toBe(600); // clamped to scrollHeight - clientHeight
    expect(box().getAttribute("data-pinned")).toBe("true");
  });

  it("stays unpinned when the pinOnConnect jump does not move the container", async () => {
    // An engine that refuses the request leaves the container where it was, and a pinned
    // state asserted over it would swallow the very first append.
    setup('data-stimeo--stick-to-bottom-pin-on-connect-value="true"');
    setGeom(1000, 400, 0);
    spyOnScrollTo();
    await start();

    expect(box().hasAttribute("data-pinned")).toBe(false);
    await appendChild();
    expect(box().getAttribute("data-has-new")).toBe("true");
  });

  it("follows the first append after pinning on connect", async () => {
    setup('data-stimeo--stick-to-bottom-pin-on-connect-value="true"');
    setGeom(1000, 400, 0);
    const scrollTo = spyOnLandingScrollTo();
    await start();
    Object.defineProperty(box(), "scrollHeight", { configurable: true, value: 1100 });

    await appendChild();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1100, behavior: "auto" });
    expect(box().hasAttribute("data-has-new")).toBe(false);
  });

  it("leaves the scroll position alone on connect without pinOnConnect", async () => {
    setup();
    setGeom(1000, 400, 0); // same geometry, no pin-on-connect value
    const scrollTo = spyOnScrollTo();
    await start();

    expect(scrollTo).not.toHaveBeenCalled();
    expect(box().hasAttribute("data-pinned")).toBe(false);
  });

  it("keeps the pinOnConnect jump instant while following smoothly", async () => {
    setup(
      'data-stimeo--stick-to-bottom-pin-on-connect-value="true" ' +
        'data-stimeo--stick-to-bottom-behavior-value="smooth"',
    );
    setGeom(1000, 400, 0);
    const scrollTo = spyOnLandingScrollTo();
    await start();
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "instant" });

    Object.defineProperty(box(), "scrollHeight", { configurable: true, value: 1100 });
    await appendChild();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1100, behavior: "smooth" });
  });

  /**
   * A container that is not rendered yet — a chat log inside a closed panel — reports
   * every metric as 0, which reads as "already at the bottom". Settling the pin there
   * would have it come into view at the top still claiming to be at the bottom.
   */
  describe("pinOnConnect before the container has a box", () => {
    /** Connects with no layout, then hands the container one. */
    const connectUnlaidOut = async () => {
      stubResizeObserver();
      setup('data-stimeo--stick-to-bottom-pin-on-connect-value="true"');
      setGeom(0, 0, 0); // display:none → no box to scroll and nothing to measure
      const scrollTo = spyOnLandingScrollTo();
      await start();
      return scrollTo;
    };

    it("holds the jump until the container is laid out", async () => {
      const scrollTo = await connectUnlaidOut();
      expect(scrollTo).not.toHaveBeenCalled();

      setGeom(1000, 400, 0); // revealed
      FakeResizeObserver.instances[0]?.trigger();
      expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "instant" });
      expect(box().scrollTop).toBe(600);
      expect(box().getAttribute("data-pinned")).toBe("true");
    });

    it("stays quiet while the container is still unmeasurable", async () => {
      const scrollTo = await connectUnlaidOut();
      FakeResizeObserver.instances[0]?.trigger(); // still display:none
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("releases the layout watch on disconnect", async () => {
      await connectUnlaidOut();
      const observer = FakeResizeObserver.instances[0];
      expect(observer?.observed.size).toBe(1);
      disconnectAndStopApplication(application);
      expect(observer?.observed.size).toBe(0);
    });

    it("does not watch layout when the container is measurable at connect", async () => {
      stubResizeObserver();
      setup('data-stimeo--stick-to-bottom-pin-on-connect-value="true"');
      setGeom(1000, 400, 0);
      spyOnLandingScrollTo();
      await start();
      expect(FakeResizeObserver.instances).toHaveLength(0);
    });
  });

  it("pins on connect even when the content does not overflow", async () => {
    setup('data-stimeo--stick-to-bottom-pin-on-connect-value="true"');
    setGeom(300, 400, 0); // shorter than the container: there is nowhere to scroll
    const scrollTo = spyOnLandingScrollTo();
    await start();

    expect(scrollTo).toHaveBeenCalledWith({ top: 300, behavior: "instant" });
    expect(box().scrollTop).toBe(0); // the maximum offset of a box with no overflow
    expect(box().getAttribute("data-pinned")).toBe("true");
  });

  it("follows appended content to the bottom while pinned", async () => {
    setup();
    setGeom(1000, 400, 600); // pinned
    await start();
    box().scrollTo = vi.fn();
    Object.defineProperty(box(), "scrollHeight", { configurable: true, value: 1100 });

    await appendChild();
    expect(box().scrollTo).toHaveBeenCalledWith({ top: 1100, behavior: "auto" });
    expect(box().hasAttribute("data-has-new")).toBe(false);
  });

  it("flags new content without scrolling while unpinned", async () => {
    setup();
    setGeom(1000, 400, 100); // unpinned
    await start();
    box().scrollTo = vi.fn();
    const news: Array<{ count: number }> = [];
    box().addEventListener("stimeo--stick-to-bottom:new", (e) =>
      news.push((e as CustomEvent).detail),
    );

    await appendChild();
    expect(box().scrollTo).not.toHaveBeenCalled();
    expect(box().getAttribute("data-has-new")).toBe("true");
    expect(news).toEqual([{ count: 1 }]);
  });

  it("re-pins and clears has-new when the user scrolls back to the bottom", async () => {
    setup();
    setGeom(1000, 400, 100); // unpinned
    await start();
    box().scrollTo = vi.fn();
    await appendChild(); // sets data-has-new
    expect(box().getAttribute("data-has-new")).toBe("true");

    const pins: Array<{ pinned: boolean }> = [];
    box().addEventListener("stimeo--stick-to-bottom:pin", (e) =>
      pins.push((e as CustomEvent).detail),
    );
    setGeom(1100, 400, 700); // distance 0 → pinned
    box().dispatchEvent(new Event("scroll"));

    expect(box().getAttribute("data-pinned")).toBe("true");
    expect(box().hasAttribute("data-has-new")).toBe(false);
    expect(pins).toEqual([{ pinned: true }]);
  });

  it("jumps to the bottom and re-pins via the scrollToBottom action", async () => {
    setup();
    setGeom(1000, 400, 100); // unpinned
    await start();
    const scrollTo = spyOnLandingScrollTo();
    await appendChild();
    const pins = recordPins();

    controller().scrollToBottom();
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });
    expect(box().hasAttribute("data-has-new")).toBe(false);
    expect(box().getAttribute("data-pinned")).toBe("true");
    expect(pins).toEqual([{ pinned: true }]);
  });

  it("stays unpinned when the jump cannot move the container", async () => {
    setup();
    setGeom(1000, 400, 100); // unpinned, and the stubbed geometry never moves
    await start();
    box().scrollTo = vi.fn();
    await appendChild();
    const pins = recordPins();

    controller().scrollToBottom();
    expect(box().scrollTo).toHaveBeenCalled();
    expect(box().hasAttribute("data-pinned")).toBe(false); // never reached, never claimed
    expect(pins).toEqual([]);

    // Still unpinned, so the next arrival raises the flag again instead of being
    // swallowed by a pinned state that would silently follow nothing.
    const news: Array<{ count: number }> = [];
    box().addEventListener("stimeo--stick-to-bottom:new", (e) =>
      news.push((e as CustomEvent).detail),
    );
    await appendChild();
    expect(box().getAttribute("data-has-new")).toBe("true");
    expect(news).toEqual([{ count: 1 }]);
  });

  it("defers re-pinning until a smooth jump lands", async () => {
    setup('data-stimeo--stick-to-bottom-behavior-value="smooth"');
    setGeom(1000, 400, 100); // unpinned
    await start();
    box().scrollTo = vi.fn(); // a smooth scroll is still in flight when the call returns
    await appendChild();
    const pins = recordPins();

    controller().scrollToBottom();
    expect(box().hasAttribute("data-has-new")).toBe(false); // the arrival is acknowledged
    expect(box().hasAttribute("data-pinned")).toBe(false); // but the container is not there yet
    expect(pins).toEqual([]);

    setGeom(1100, 400, 700); // the animation arrives at the bottom
    box().dispatchEvent(new Event("scroll"));
    expect(box().getAttribute("data-pinned")).toBe("true");
    expect(pins).toEqual([{ pinned: true }]);
  });

  it("forces instant behavior under reduced motion", async () => {
    setReducedMotion(true);
    setup('data-stimeo--stick-to-bottom-behavior-value="smooth"');
    setGeom(1000, 400, 600); // pinned
    await start();
    box().scrollTo = vi.fn();
    Object.defineProperty(box(), "scrollHeight", { configurable: true, value: 1100 });
    await appendChild();
    expect(box().scrollTo).toHaveBeenCalledWith({ top: 1100, behavior: "instant" });
  });

  it("stops observing and listening on disconnect", async () => {
    setup();
    setGeom(1000, 400, 100); // unpinned
    await start();
    box().scrollTo = vi.fn();
    const el = box();
    const contentEl = content();
    el.remove();
    await tick();

    const news: number[] = [];
    el.addEventListener("stimeo--stick-to-bottom:new", () => news.push(1));
    contentEl.appendChild(document.createElement("li"));
    await tick();
    expect(news).toEqual([]); // observer severed
  });

  it("has no a11y violations", async () => {
    setup();
    await start();
    await expectNoA11yViolations(box());
  });
});
