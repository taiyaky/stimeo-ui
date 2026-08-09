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

describe("ReadingProgressController", () => {
  let application: Application;
  let frames: FrameRequestCallback[] = [];
  /** Stubbed article geometry, moved by the "scroll" driver below. */
  let rect = { top: 400, height: 2600 };

  beforeEach(() => {
    frames = [];
    rect = { top: 400, height: 2600 };
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {
      frames = [];
    });
    vi.stubGlobal("innerHeight", 600);
  });

  const mount = async () => {
    document.body.innerHTML = `
      <main><article id="a" data-controller="stimeo--reading-progress"><p>Body</p></article></main>`;
    const article = document.querySelector("#a") as HTMLElement;
    vi.spyOn(article, "getBoundingClientRect").mockImplementation(
      () => ({ top: rect.top, height: rect.height }) as DOMRect,
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await tick();
  });

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
    rect = { top: 400, height: 300 };
    await mount();
    expect(el().style.getPropertyValue(PROP)).toBe("0");
    scrollTo(-10);
    expect(el().style.getPropertyValue(PROP)).toBe("1");
  });

  it("removes listeners and the root property on disconnect", async () => {
    await mount();
    scrollTo(-1000);
    controller()?.disconnect();
    expect(document.documentElement.style.getPropertyValue(PROP)).toBe("");
    scrollTo(-2000); // no listener left: element property unchanged
    expect(el().style.getPropertyValue(PROP)).toBe("0.5");
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
