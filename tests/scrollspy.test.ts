import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollspyController } from "../src/controllers/scrollspy_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

const tick = () => new Promise((r) => setTimeout(r, 0));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ScrollspyController", () => {
  let application: Application;
  type MockIntersectionEntry = {
    target: { id: string };
    isIntersecting: boolean;
    boundingClientRect: { top: number };
  };
  let observerCallback: ((entries: MockIntersectionEntry[]) => void) | null = null;
  const observeMock = vi.fn();
  const unobserveMock = vi.fn();
  const disconnectMock = vi.fn();

  beforeEach(async () => {
    observerCallback = null;
    observeMock.mockClear();
    unobserveMock.mockClear();
    disconnectMock.mockClear();

    const IntersectionObserverMock = class {
      constructor(
        callback: (entries: MockIntersectionEntry[]) => void,
        options?: IntersectionObserverInit,
      ) {
        observerCallback = callback;
        // Expose options to the mock for assertions if needed
        (IntersectionObserverMock as unknown as { mock?: { calls: unknown[][] } }).mock = {
          calls: [[callback, options]],
        };
      }
      observe = observeMock;
      unobserve = unobserveMock;
      disconnect = disconnectMock;
    };

    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);

    document.body.innerHTML = `
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80">
        <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
        <a id="link-usage" href="#usage" data-stimeo--scrollspy-target="link">Usage</a>
        <a id="link-api" href="#api" data-stimeo--scrollspy-target="link">API</a>
      </nav>

      <section id="intro">Intro Section</section>
      <section id="usage">Usage Section</section>
      <section id="api">API Section</section>
    `;

    application = Application.start();
    application.handleError = (error) => {
      console.error("=== REAL STIMULUS ERROR ===", error.message, error.stack);
    };
    application.register("stimeo--scrollspy", ScrollspyController);
    await delay(50);
  });

  afterEach(async () => {
    application.stop();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await delay(50);
  });

  it("initializes and observes target section elements", async () => {
    const observer = window.IntersectionObserver as unknown as {
      mock?: { calls: Array<[unknown, IntersectionObserverInit]> };
    };
    const mockCalls = observer.mock?.calls ?? [];
    expect(mockCalls.length).toBe(1);
    const options = mockCalls[0]?.[1];

    // Verify offsetValue conversion: -80px top margin
    expect(options?.rootMargin).toBe("-80px 0px -80% 0px");

    // Must observe all three sections mapped by active href targets
    expect(observeMock).toHaveBeenCalledTimes(3);
    const sections = Array.from(observeMock.mock.calls.map((call) => call[0].id));
    expect(sections).toContain("intro");
    expect(sections).toContain("usage");
    expect(sections).toContain("api");
  });

  it("toggles aria-current on links according to intersection visibility states", async () => {
    const nav = document.getElementById("scrollspy") as HTMLElement;
    const linkIntro = document.getElementById("link-intro") as HTMLElement;
    const linkUsage = document.getElementById("link-usage") as HTMLElement;

    const changeHandler = vi.fn();
    nav.addEventListener("stimeo--scrollspy:change", changeHandler);

    expect(observerCallback).not.toBeNull();

    // 1. Simulate intro section intersecting closest to the trigger
    observerCallback?.([
      {
        target: { id: "intro" },
        isIntersecting: true,
        boundingClientRect: { top: 90 }, // distance = |90 - 80| = 10px (closest)
      },
      {
        target: { id: "usage" },
        isIntersecting: true,
        boundingClientRect: { top: 250 }, // distance = |250 - 80| = 170px
      },
    ]);
    await tick();

    expect(linkIntro.getAttribute("aria-current")).toBe("location");
    expect(linkUsage.getAttribute("aria-current")).toBeNull();
    expect(changeHandler).toHaveBeenCalledOnce();
    expect(changeHandler.mock.calls[0]?.[0]?.detail).toEqual({ id: "intro", link: linkIntro });

    // 2. Simulate usage section becoming closer
    observerCallback?.([
      {
        target: { id: "intro" },
        isIntersecting: true,
        boundingClientRect: { top: -100 }, // distance = |-100 - 80| = 180px
      },
      {
        target: { id: "usage" },
        isIntersecting: true,
        boundingClientRect: { top: 85 }, // distance = |85 - 80| = 5px (now closest)
      },
    ]);
    await tick();

    expect(linkIntro.getAttribute("aria-current")).toBeNull();
    expect(linkUsage.getAttribute("aria-current")).toBe("location");
    expect(changeHandler).toHaveBeenCalledTimes(2);
    expect(changeHandler.mock.calls[1]?.[0]?.detail).toEqual({ id: "usage", link: linkUsage });
  });

  it("measures the trigger line from a nested rootSelector container, not the viewport top", async () => {
    // Rebuild with a nested scroll container that is offset down the viewport.
    document.body.innerHTML = `
      <nav id="scrollspy" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80"
           data-stimeo--scrollspy-root-selector-value=".content">
        <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
        <a id="link-usage" href="#usage" data-stimeo--scrollspy-target="link">Usage</a>
      </nav>
      <div class="content">
        <section id="intro">Intro Section</section>
        <section id="usage">Usage Section</section>
      </div>
    `;

    // The container sits 200px down the viewport, so the trigger line is 200 + 80 = 280.
    const container = document.querySelector(".content") as HTMLElement;
    container.getBoundingClientRect = () =>
      ({ top: 200, left: 0, width: 800, height: 600 }) as DOMRect;

    application.stop();
    application = Application.start();
    application.register("stimeo--scrollspy", ScrollspyController);
    await delay(50);

    const linkIntro = document.getElementById("link-intro") as HTMLElement;
    const linkUsage = document.getElementById("link-usage") as HTMLElement;

    // Against a bare offset (80), intro (top 100) would win; against the
    // container-relative line (280), usage (top 285) is correctly closest.
    observerCallback?.([
      { target: { id: "intro" }, isIntersecting: true, boundingClientRect: { top: 100 } },
      { target: { id: "usage" }, isIntersecting: true, boundingClientRect: { top: 285 } },
    ]);
    await tick();

    expect(linkUsage.getAttribute("aria-current")).toBe("location");
    expect(linkIntro.getAttribute("aria-current")).toBeNull();
  });

  it("cleans up observers upon disconnection", () => {
    const controller = application.getControllerForElementAndIdentifier(
      document.getElementById("scrollspy") as HTMLElement,
      "stimeo--scrollspy",
    ) as ScrollspyController;

    expect(disconnectMock).not.toHaveBeenCalled();

    // Directly invoke disconnect to avoid flaky async MutationObserver lifecycle in happy-dom
    controller.disconnect();

    expect(disconnectMock).toHaveBeenCalledOnce();
  });

  // --- Layer ① machine a11y ---------------------------------------------------

  it("has no machine-detectable a11y violations", async () => {
    await expectNoA11yViolations(document.getElementById("scrollspy") as HTMLElement);
  });

  // --- Layer ③ speech-order regression ---------------------------------------

  it("announces the active link's current-location state in document order", async () => {
    const nav = document.getElementById("scrollspy") as HTMLElement;

    // No section is active yet: links announce as plain links, in order.
    expect(await captureSpeech({ container: nav, steps: 4 })).toEqual([
      "navigation, On this page",
      "link, Intro",
      "link, Usage",
      "link, API",
      "end of navigation, On this page",
    ]);

    // Activating the intro section flips only its link to "current location".
    observerCallback?.([
      { target: { id: "intro" }, isIntersecting: true, boundingClientRect: { top: 90 } },
      { target: { id: "usage" }, isIntersecting: true, boundingClientRect: { top: 250 } },
    ]);
    await tick();

    expect(await captureSpeech({ container: nav, steps: 4 })).toEqual([
      "navigation, On this page",
      "link, Intro, current location",
      "link, Usage",
      "link, API",
      "end of navigation, On this page",
    ]);
  });

  // --- Disconnect teardown regression ----------------------------------------

  it("ignores a late intersection callback delivered after teardown", async () => {
    const linkIntro = document.getElementById("link-intro") as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(
      document.getElementById("scrollspy") as HTMLElement,
      "stimeo--scrollspy",
    ) as ScrollspyController;

    controller.disconnect();
    expect(disconnectMock).toHaveBeenCalledOnce();

    // A queued callback firing after disconnect must not resurrect aria-current.
    observerCallback?.([
      { target: { id: "intro" }, isIntersecting: true, boundingClientRect: { top: 90 } },
    ]);
    await tick();

    expect(linkIntro.getAttribute("aria-current")).toBeNull();
  });
});
