import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmartStickyHeaderController } from "../src/controllers/smart_sticky_header_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link SmartStickyHeaderController}: direction-based
 * hide/reveal with the offset and tolerance guards, the focus-reveal a11y
 * path, the change event, cache-restore reset, and teardown.
 */

describe("SmartStickyHeaderController", () => {
  let application: Application;
  let frames: FrameRequestCallback[] = [];
  let scrollY = 0;

  beforeEach(() => {
    frames = [];
    scrollY = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {
      frames = [];
    });
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollY });
  });

  const mount = async (attrs = "") => {
    document.body.innerHTML = `
      <header data-controller="stimeo--smart-sticky-header" ${attrs}>
        <nav aria-label="Site"><a href="#top">Home</a></nav>
      </header>
      <main><p>Content</p></main>`;
    application = Application.start();
    application.register("stimeo--smart-sticky-header", SmartStickyHeaderController);
    await tick();
  };

  /** Scrolls to `y` and flushes the rAF-throttled measure. */
  const scrollTo = (y: number) => {
    scrollY = y;
    window.dispatchEvent(new Event("scroll"));
    const pending = frames;
    frames = [];
    for (const cb of pending) cb(0);
  };

  afterEach(async () => {
    controller()?.disconnect();
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    await tick();
  });

  const header = () => document.querySelector("header") as HTMLElement;
  const hidden = () => header().getAttribute("data-header-hidden");
  const controller = () =>
    header()
      ? (application?.getControllerForElementAndIdentifier(
          header(),
          "stimeo--smart-sticky-header",
        ) as SmartStickyHeaderController | null)
      : null;

  it("starts visible and hides on a scroll-down past the offset", async () => {
    await mount();
    expect(hidden()).toBe("false");
    scrollTo(200); // down, past the default 80px offset
    expect(hidden()).toBe("true");
  });

  it("reveals on any scroll-up", async () => {
    await mount();
    scrollTo(400);
    expect(hidden()).toBe("true");
    scrollTo(360);
    expect(hidden()).toBe("false");
  });

  it("never hides within the offset zone near the top", async () => {
    await mount();
    scrollTo(60); // down, but still above offset 80
    expect(hidden()).toBe("false");
  });

  it("ignores jitter below the tolerance", async () => {
    await mount();
    scrollTo(400);
    expect(hidden()).toBe("true");
    scrollTo(398); // up 2px < default tolerance 4: still hidden
    expect(hidden()).toBe("true");
  });

  it("reveals when focus enters the header (keyboard reachability)", async () => {
    await mount();
    scrollTo(400);
    expect(hidden()).toBe("true");
    header().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(hidden()).toBe("false");
  });

  it("keeps the header visible while focus stays inside it", async () => {
    await mount();
    (document.querySelector("header a") as HTMLAnchorElement).focus();
    scrollTo(400); // down, past the offset — but the header owns the focus
    expect(hidden()).toBe("false");

    (document.activeElement as HTMLElement).blur();
    scrollTo(500); // focus released: direction-based hiding resumes
    expect(hidden()).toBe("true");
  });

  it("dispatches change only on transitions", async () => {
    await mount();
    const states: boolean[] = [];
    header().addEventListener("stimeo--smart-sticky-header:change", (event) => {
      states.push((event as CustomEvent<{ hidden: boolean }>).detail.hidden);
    });
    scrollTo(200);
    scrollTo(400); // still hidden: no event
    scrollTo(300);
    expect(states).toEqual([true, false]);
  });

  it("tracks a scroll container via containerSelector", async () => {
    document.body.innerHTML = `
      <div id="frame">
        <header data-controller="stimeo--smart-sticky-header"
                data-stimeo--smart-sticky-header-container-selector-value="#frame">
          <nav aria-label="Site"><a href="#top">Home</a></nav>
        </header>
      </div>`;
    const frame = document.querySelector("#frame") as HTMLElement;
    Object.defineProperty(frame, "scrollTop", {
      configurable: true,
      get: () => scrollY, // reuse the driver variable as the frame's position
    });
    application = Application.start();
    application.register("stimeo--smart-sticky-header", SmartStickyHeaderController);
    await tick();

    scrollY = 200;
    frame.dispatchEvent(new Event("scroll"));
    const pending = frames;
    frames = [];
    for (const cb of pending) cb(0);
    expect(hidden()).toBe("true");
  });

  it("resets a stale hidden hook from a Turbo cache snapshot", async () => {
    await mount('data-header-hidden="true"');
    expect(hidden()).toBe("false");
  });

  it("stops reacting after disconnect", async () => {
    await mount();
    controller()?.disconnect();
    scrollTo(400);
    expect(hidden()).toBe("false"); // unchanged from connect
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount();
    await expectNoA11yViolations(document.body);
  });

  // --- Layer ③ speech-order regression ---------------------------------------

  it("keeps the banner announcement identical while hidden (data hook only)", async () => {
    await mount();
    const before = await captureSpeech({ container: header(), steps: 4 });
    // Freeze the whole ordered array: the header stays a banner with its nav link.
    expect(before).toEqual([
      "banner",
      "navigation, Site",
      "link, Home",
      "end of navigation, Site",
      "end of banner",
    ]);
    // Hiding only flips data-header-hidden — the slide-away is consumer CSS, so
    // the accessibility tree (and the announcement) must not change.
    scrollTo(200);
    expect(hidden()).toBe("true");
    const after = await captureSpeech({ container: header(), steps: 4 });
    expect(after).toEqual(before);
  });
});
