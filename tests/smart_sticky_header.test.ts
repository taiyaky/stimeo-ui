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
  // The container's position is driven separately from the window's, so a read
  // that goes to the wrong source is visible instead of coincidentally equal.
  let containerY = 0;

  beforeEach(() => {
    frames = [];
    scrollY = 0;
    containerY = 0;
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

  /** Runs whatever frames are pending, the way a browser would service them. */
  const flush = () => {
    const pending = frames;
    frames = [];
    for (const cb of pending) cb(0);
  };

  /** Scrolls to `y` and flushes the rAF-throttled measure. */
  const scrollTo = (y: number) => {
    scrollY = y;
    window.dispatchEvent(new Event("scroll"));
    flush();
  };

  /** Mounts a header whose scroll source is a container, and returns that container. */
  const mountInContainer = async (attrs = "") => {
    document.body.innerHTML = `
      <div id="frame">
        <header data-controller="stimeo--smart-sticky-header"
                data-stimeo--smart-sticky-header-container-selector-value="#frame" ${attrs}>
          <nav aria-label="Site"><a href="#top">Home</a></nav>
        </header>
      </div>`;
    const frame = document.querySelector("#frame") as HTMLElement;
    Object.defineProperty(frame, "scrollTop", { configurable: true, get: () => containerY });
    application = Application.start();
    application.register("stimeo--smart-sticky-header", SmartStickyHeaderController);
    await tick();
    return frame;
  };

  /** Scrolls the container to `y` and flushes the rAF-throttled measure. */
  const scrollContainerTo = (frame: HTMLElement, y: number) => {
    containerY = y;
    frame.dispatchEvent(new Event("scroll"));
    flush();
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

  it("reveals at the offset boundary itself", async () => {
    await mount();
    scrollTo(80); // exactly the offset: still the zone that never hides
    expect(hidden()).toBe("false");
  });

  it("ignores jitter below the tolerance", async () => {
    await mount();
    scrollTo(400);
    expect(hidden()).toBe("true");
    scrollTo(398); // up 2px < default tolerance 4: still hidden
    expect(hidden()).toBe("true");
  });

  it("acts on a movement of exactly the tolerance", async () => {
    await mount();
    scrollTo(400);
    expect(hidden()).toBe("true");
    scrollTo(396); // up exactly 4px: the guard ignores movement *below* tolerance
    expect(hidden()).toBe("false");
  });

  it("reveals inside the offset zone even when the move that re-enters it is jitter", async () => {
    await mount();
    scrollTo(82); // just past the offset, hidden
    expect(hidden()).toBe("true");
    scrollTo(80); // 2px up (< tolerance) but back inside the offset zone
    // A header stranded off-screen here cannot be scrolled back into view: the
    // zone decides before the jitter guard can swallow the move.
    expect(hidden()).toBe("false");
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

  it("stays silent while connecting, on a first connect and on a reconnect", async () => {
    const states: boolean[] = [];
    // Listening from before the mount: the reflection connect() performs is the
    // current state, not a change, so it announces nothing either time.
    document.addEventListener("stimeo--smart-sticky-header:change", (event) => {
      states.push((event as CustomEvent<{ hidden: boolean }>).detail.hidden);
    });
    await mount();
    expect(states).toEqual([]);

    controller()?.disconnect();
    controller()?.connect();
    expect(states).toEqual([]);
  });

  it("resumes from the scroll position it connects at", async () => {
    scrollY = 500;
    await mount();
    scrollTo(498); // 2px up from where it connected: jitter, not a scroll-down
    expect(hidden()).toBe("false");
  });

  it("coalesces a burst of scrolls into a single measure", async () => {
    await mount();
    scrollY = 200;
    window.dispatchEvent(new Event("scroll"));
    scrollY = 300;
    window.dispatchEvent(new Event("scroll"));
    scrollY = 400;
    window.dispatchEvent(new Event("scroll"));
    expect(frames).toHaveLength(1); // one frame for the whole burst
    flush();
    expect(hidden()).toBe("true");
  });

  it("tracks a scroll container via containerSelector", async () => {
    const frame = await mountInContainer();
    scrollContainerTo(frame, 200);
    expect(hidden()).toBe("true");
  });

  it("reads the container's position, not the window's", async () => {
    const frame = await mountInContainer();
    scrollY = 0; // the window never moves
    scrollContainerTo(frame, 400);
    expect(hidden()).toBe("true");
  });

  it("falls back to the window when containerSelector cannot be parsed", async () => {
    await mount('data-stimeo--smart-sticky-header-container-selector-value="#:::not-a-selector"');
    expect(hidden()).toBe("false"); // the element is alive, not killed by the declaration
    scrollTo(400);
    expect(hidden()).toBe("true");
  });

  it("re-renders when offset changes at runtime", async () => {
    await mount('data-stimeo--smart-sticky-header-offset-value="200"');
    scrollTo(300);
    expect(hidden()).toBe("true");

    header().setAttribute("data-stimeo--smart-sticky-header-offset-value", "400");
    await tick(); // no scroll: the new offset alone must re-decide
    expect(hidden()).toBe("false");
  });

  it("reads a non-numeric offset as the default", async () => {
    await mount('data-stimeo--smart-sticky-header-offset-value="abc"');
    scrollTo(50); // inside the default 80px zone: NaN must not defeat the guarantee
    expect(hidden()).toBe("false");
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

  it("releases the focusin listener on disconnect", async () => {
    await mount();
    scrollTo(400);
    expect(hidden()).toBe("true");
    controller()?.disconnect();
    header().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(hidden()).toBe("true"); // no reveal from a listener that should be gone
  });

  it("drops a pending frame on disconnect", async () => {
    await mount();
    scrollY = 400;
    window.dispatchEvent(new Event("scroll")); // a frame is now pending
    controller()?.disconnect();
    flush(); // the cancelled frame must not be waiting to run
    expect(hidden()).toBe("false");
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount();
    await expectNoA11yViolations(document.body);
  });

  // --- Speech-order regression ------------------------------------------------

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
