import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadingProgressController } from "../src/controllers/reading_progress_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ReadingProgressController}: the scroll math
 * (stubbed geometry — happy-dom has no layout), the custom property on the
 * element + document root, rAF throttling, change/complete events, the
 * short-article branch, and listener/property teardown.
 */

const PROP = "--stimeo--reading-progress";

/** Minimal controllable ResizeObserver double that records observed elements. */
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
  /** Test helper: notify as the platform would when an observed box changes. */
  trigger(element: Element): void {
    if (this.observed.has(element)) this.callback([], this);
  }
}

describe("ReadingProgressController", () => {
  let application: Application;
  let frames: FrameRequestCallback[] = [];
  /** Stubbed article geometry, moved by the "scroll" driver below. */
  let rect = { top: 400, height: 2600, width: 800 };

  beforeEach(() => {
    frames = [];
    rect = { top: 400, height: 2600, width: 800 };
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {
      frames = [];
    });
    vi.stubGlobal("innerHeight", 600);
    FakeResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });

  const mount = async () => {
    document.body.innerHTML = `
      <main><article id="a" data-controller="stimeo--reading-progress"><p>Body</p></article></main>`;
    const article = document.querySelector("#a") as HTMLElement;
    vi.spyOn(article, "getBoundingClientRect").mockImplementation(
      () => ({ top: rect.top, height: rect.height, width: rect.width }) as DOMRect,
    );
    application = Application.start();
    application.register("stimeo--reading-progress", ReadingProgressController);
    await tick();
  };

  /** Scrolls to `top` and flushes the rAF-throttled measure. */
  const scrollTo = (top: number) => {
    rect.top = top;
    window.dispatchEvent(new Event("scroll"));
    const pending = frames;
    frames = [];
    for (const cb of pending) cb(0);
  };

  afterEach(async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("style");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await tick();
  });

  /** Runs whatever frames are pending, the way a paint would. */
  const flushFrames = () => {
    const pending = frames;
    frames = [];
    for (const cb of pending) cb(0);
  };
  const rootProp = () => document.documentElement.style.getPropertyValue(PROP);
  /** Records both public events in order, with the change payload. */
  const record = (): string[] => {
    const seen: string[] = [];
    el().addEventListener("stimeo--reading-progress:change", (event) =>
      seen.push(`change:${(event as CustomEvent<{ progress: number }>).detail.progress}`),
    );
    el().addEventListener("stimeo--reading-progress:complete", () => seen.push("complete"));
    return seen;
  };
  const resizeObserver = () => FakeResizeObserver.instances[0] as FakeResizeObserver;

  const el = () => document.querySelector("#a") as HTMLElement;
  const controller = () =>
    el()
      ? (application?.getControllerForElementAndIdentifier(
          el(),
          "stimeo--reading-progress",
        ) as ReadingProgressController | null)
      : null;

  it("publishes 0 before the article top reaches the viewport top", async () => {
    await mount();
    expect(el().style.getPropertyValue(PROP)).toBe("0");
    expect(document.documentElement.style.getPropertyValue(PROP)).toBe("0");
  });

  it("tracks the scroll through the article ((height - viewport) denominator)", async () => {
    await mount();
    scrollTo(-500); // 500 / (2600 - 600) = 0.25
    expect(el().style.getPropertyValue(PROP)).toBe("0.25");
    scrollTo(-1000);
    expect(document.documentElement.style.getPropertyValue(PROP)).toBe("0.5");
    scrollTo(-2000); // bottom fits the viewport
    expect(el().style.getPropertyValue(PROP)).toBe("1");
    scrollTo(-3000); // past the article: clamped
    expect(el().style.getPropertyValue(PROP)).toBe("1");
  });

  it("coalesces a burst of scroll events into one rAF measure", async () => {
    await mount();
    rect.top = -500;
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("scroll"));
    expect(frames).toHaveLength(1);
  });

  it("dispatches change on movement and complete once it reaches 1", async () => {
    await mount();
    const events: string[] = [];
    el().addEventListener("stimeo--reading-progress:change", () => events.push("change"));
    el().addEventListener("stimeo--reading-progress:complete", () => events.push("complete"));
    scrollTo(-1000);
    scrollTo(-1000); // unchanged: no event
    scrollTo(-2000);
    expect(events).toEqual(["change", "change", "complete"]);
  });

  it("treats an article shorter than the viewport as binary", async () => {
    rect = { top: 400, height: 300, width: 800 };
    await mount();
    expect(el().style.getPropertyValue(PROP)).toBe("0");
    scrollTo(-10);
    expect(el().style.getPropertyValue(PROP)).toBe("1");
  });

  it("removes the listeners on disconnect", async () => {
    await mount();
    scrollTo(-1000);
    const events: string[] = [];
    el().addEventListener("stimeo--reading-progress:change", () => events.push("change"));
    controller()?.disconnect();
    scrollTo(-2000); // no listener left: nothing is measured or published
    expect(events).toHaveLength(0);
  });

  describe("an article with no layout box", () => {
    it("publishes nothing while the article is not laid out", async () => {
      // A collapsed <details>, an inactive tab panel, a display:none ancestor —
      // all report an empty rect at the document origin. There is no reading
      // position to read off it, so nothing is published and the consumer's own
      // `var(--stimeo--reading-progress, 0)` fallback stands.
      rect = { top: 0, height: 0, width: 0 };
      await mount();
      expect(el().style.getPropertyValue(PROP)).toBe("");
      expect(rootProp()).toBe("");
    });

    it("does not report a half-read article as finished when it is hidden", async () => {
      // The empty rect's `top` of 0 would otherwise satisfy the short-article
      // branch and read as "reached the end" — a completion the reader never made.
      await mount();
      const seen = record();
      scrollTo(-500); // 25% in
      expect(el().style.getPropertyValue(PROP)).toBe("0.25");

      rect = { top: 0, height: 0, width: 0 }; // the reader collapses the section
      scrollTo(0);
      expect(seen).toEqual(["change:0.25"]);
      expect(el().style.getPropertyValue(PROP)).toBe("0.25");
    });
  });

  describe("re-measuring when the article's own box changes", () => {
    it("re-measures when the article grows after connect", async () => {
      // Images and fonts settle after the first measurement. Without watching
      // the article's own box, a short-at-connect article stays reported as
      // read to the end until something else happens to scroll.
      rect = { top: 0, height: 300, width: 800 }; // shorter than the viewport → binary 1
      await mount();
      expect(rootProp()).toBe("1");

      rect.height = 2600; // the images arrived
      resizeObserver().trigger(el());
      flushFrames();
      expect(rootProp()).toBe("0");
    });

    it("stops watching the box on disconnect", async () => {
      await mount();
      const observer = resizeObserver();
      expect(observer.observed.has(el())).toBe(true);
      controller()?.disconnect();
      expect(observer.observed.has(el())).toBe(false);
    });
  });

  describe("the baseline window", () => {
    it("treats a scroll that lands in the connect frame as the baseline", async () => {
      // Stimulus connects before the page's scroll position is restored, so the
      // restore arrives as a 0 -> 1 move the reader never made. Everything that
      // lands in the first frame is still the baseline.
      await mount();
      const seen = record();
      rect.top = -2000; // the restore puts the reader at the bottom
      window.dispatchEvent(new Event("scroll"));
      flushFrames();
      expect(seen).toEqual(["change:1"]);
    });

    it("still reports an arrival once the window has closed", async () => {
      await mount();
      flushFrames(); // the baseline window closes
      const seen = record();
      scrollTo(-1000);
      scrollTo(-2000);
      expect(seen).toEqual(["change:0.5", "change:1", "complete"]);
    });
  });

  describe("returning the property", () => {
    it("returns both faces and restores an authored root value", async () => {
      document.documentElement.style.setProperty(PROP, "0.87");
      await mount();
      scrollTo(-1000);
      expect(el().style.getPropertyValue(PROP)).toBe("0.5");
      expect(rootProp()).toBe("0.5");

      controller()?.disconnect();
      expect(el().style.getPropertyValue(PROP)).toBe("");
      expect(rootProp()).toBe("0.87");
    });

    it("leaves a value another writer put there after ours", async () => {
      await mount();
      scrollTo(-1000);
      document.documentElement.style.setProperty(PROP, "0.9"); // someone else wins
      controller()?.disconnect();
      expect(rootProp()).toBe("0.9");
    });

    it("returns the property for the cache snapshot and republishes after it", async () => {
      await mount();
      scrollTo(-1000);
      document.dispatchEvent(new Event("turbo:before-cache"));
      expect(rootProp()).toBe("");
      expect(el().style.getPropertyValue(PROP)).toBe("");

      // The visit can be cancelled and leave the page on screen: the next
      // measurement has to publish again rather than sit behind the same-value guard.
      scrollTo(-1000);
      expect(rootProp()).toBe("0.5");
    });
  });

  describe("the contract the suite has to hold", () => {
    it("releases a pending frame on disconnect", async () => {
      await mount();
      flushFrames(); // close the baseline window
      rect.top = -2000;
      window.dispatchEvent(new Event("scroll")); // queued, not yet run
      const events: string[] = [];
      el().addEventListener("stimeo--reading-progress:change", () => events.push("change"));

      controller()?.disconnect();
      flushFrames(); // whatever survived the teardown would run here
      expect(events).toHaveLength(0);
      expect(rootProp()).toBe("");
    });

    it("republishes from the current position when it reconnects", async () => {
      await mount();
      scrollTo(-1000);
      const instance = controller();
      instance?.disconnect();
      expect(rootProp()).toBe("");

      instance?.connect(); // a Turbo restore, or an in-page move
      expect(rootProp()).toBe("0.5");
      expect(el().style.getPropertyValue(PROP)).toBe("0.5");
    });

    it("does not report a completion for an article that is already read on connect", async () => {
      // The page comes back at the bottom: the first measurement establishes
      // where the reader is, it does not announce that they got there.
      rect = { top: -2000, height: 2600, width: 800 };
      const events: string[] = [];
      document.addEventListener("stimeo--reading-progress:complete", () => events.push("complete"));
      await mount();
      flushFrames();
      expect(el().style.getPropertyValue(PROP)).toBe("1");
      expect(events).toHaveLength(0);
      document.removeEventListener("stimeo--reading-progress:complete", () => {});
    });

    it("carries the progress in the change detail", async () => {
      await mount();
      const details: unknown[] = [];
      el().addEventListener("stimeo--reading-progress:change", (event) =>
        details.push((event as CustomEvent).detail),
      );
      scrollTo(-1000);
      expect(details).toEqual([{ progress: 0.5 }]);
    });

    it("re-measures when the viewport resizes", async () => {
      await mount();
      flushFrames();
      vi.stubGlobal("innerHeight", 1600); // the viewport grew: the span halved
      window.dispatchEvent(new Event("resize"));
      flushFrames();
      expect(rootProp()).toBe("0"); // top is still 400, so still before the start
      rect.top = -500;
      window.dispatchEvent(new Event("resize"));
      flushFrames();
      expect(rootProp()).toBe("0.5"); // 500 / (2600 - 1600)
    });

    it("measures a scroll that never bubbles out of its own container", async () => {
      // An article inside an overflow container: `scroll` does not bubble, so a
      // listener that is not in the capture phase never hears it.
      await mount();
      flushFrames();
      const scroller = document.createElement("div");
      el().before(scroller);
      rect.top = -1000;
      scroller.dispatchEvent(new Event("scroll")); // bubbles: false by default
      flushFrames();
      expect(rootProp()).toBe("0.5");
    });

    it("reaches 1 exactly when a short article's top reaches the viewport top", async () => {
      rect = { top: 1, height: 300, width: 800 };
      await mount();
      flushFrames();
      expect(el().style.getPropertyValue(PROP)).toBe("0");
      scrollTo(0); // the boundary itself counts as reached
      expect(el().style.getPropertyValue(PROP)).toBe("1");
    });
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount();
    await expectNoA11yViolations(document.body);
  });

  // --- Speech-order regression ------------------------------------------------

  it("keeps the announcement order unchanged while the progress moves", async () => {
    await mount();
    // Demo-shaped consumer: the bar driven by the custom property is decorative
    // (aria-hidden) and must never enter the announcement order.
    const bar = document.createElement("div");
    bar.setAttribute("aria-hidden", "true");
    el().before(bar);
    const container = document.querySelector("main") as HTMLElement;
    const before = await captureSpeech({ container, steps: 3 });
    // Freeze the whole ordered array: the bar is silent, the article is plain content.
    expect(before).toEqual(["main", "article", "paragraph", "Body"]);
    // Scrolling only moves a CSS custom property — the announcement must not change.
    scrollTo(-1000);
    const after = await captureSpeech({ container, steps: 3 });
    expect(after).toEqual(before);
  });
});
