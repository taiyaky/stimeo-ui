import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntersectionController } from "../src/controllers/intersection_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { delay, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link IntersectionController}: observer wiring
 * (threshold list, rootMargin, root selector), the enter/exit/change/passed
 * events, the `data-intersecting`/`data-passed` + ratio custom-property hooks,
 * `once` semantics, and Turbo teardown/reconnect resilience.
 *
 * `IntersectionObserver` is mocked so intersection can be driven synchronously
 * (happy-dom has no layout/scroll).
 */

/** The entry subset the controller reads, drivable from the tests. */
type Entry = {
  isIntersecting: boolean;
  intersectionRatio: number;
  boundingClientRect: { bottom: number };
  rootBounds: { top: number } | null;
};

/** Builds a visible-entry / hidden-entry with sensible geometry defaults. */
const visible = (ratio = 1): Entry => ({
  isIntersecting: true,
  intersectionRatio: ratio,
  boundingClientRect: { bottom: 400 },
  rootBounds: { top: 0 },
});
const hiddenAfter = (): Entry => ({
  isIntersecting: false,
  intersectionRatio: 0,
  boundingClientRect: { bottom: 900 },
  rootBounds: { top: 0 },
});
const hiddenBefore = (): Entry => ({
  isIntersecting: false,
  intersectionRatio: 0,
  boundingClientRect: { bottom: -50 },
  rootBounds: { top: 0 },
});

describe("IntersectionController", () => {
  let application: Application;
  let observerCallback: ((entries: Entry[]) => void) | null = null;
  let observerOptions: IntersectionObserverInit | undefined;
  const observeMock = vi.fn();
  const unobserveMock = vi.fn();
  const disconnectMock = vi.fn();

  beforeEach(() => {
    observerCallback = null;
    observerOptions = undefined;
    observeMock.mockClear();
    unobserveMock.mockClear();
    disconnectMock.mockClear();

    const IntersectionObserverMock = class {
      constructor(callback: (entries: Entry[]) => void, options?: IntersectionObserverInit) {
        observerCallback = callback;
        observerOptions = options;
      }
      observe = observeMock;
      unobserve = unobserveMock;
      disconnect = disconnectMock;
    };
    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
  });

  /** Mounts the fixture, registers the controller, and records its events. */
  const mount = async (html: string): Promise<Record<string, object[]>> => {
    document.body.innerHTML = html;
    const events: Record<string, object[]> = { enter: [], exit: [], change: [], passed: [] };
    for (const name of Object.keys(events)) {
      document.body.addEventListener(`stimeo--intersection:${name}`, (event) => {
        events[name]?.push((event as CustomEvent<object>).detail);
      });
    }
    application = Application.start();
    application.register("stimeo--intersection", IntersectionController);
    await delay(20);
    return events;
  };

  const defaultFixture = `
    <div data-controller="stimeo--intersection" aria-hidden="true"></div>`;

  afterEach(async () => {
    controller()?.disconnect();
    application.stop();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    await delay(20);
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--intersection']") as HTMLElement;
  const controller = () =>
    root()
      ? (application?.getControllerForElementAndIdentifier(
          root(),
          "stimeo--intersection",
        ) as IntersectionController | null)
      : null;

  describe("observer wiring", () => {
    it("observes its own element with the default options", async () => {
      await mount(defaultFixture);
      expect(observeMock).toHaveBeenCalledWith(root());
      expect(observerOptions?.rootMargin).toBe("0px");
      expect(observerOptions?.threshold).toEqual([0]);
      expect(observerOptions?.root ?? null).toBeNull();
    });

    it("passes rootMargin and resolves root from rootSelector", async () => {
      await mount(`
        <div id="scroller">
          <div data-controller="stimeo--intersection" aria-hidden="true"
               data-stimeo--intersection-root-margin-value="200px"
               data-stimeo--intersection-root-selector-value="#scroller"></div>
        </div>`);
      expect(observerOptions?.rootMargin).toBe("200px");
      expect(observerOptions?.root).toBe(document.querySelector("#scroller"));
    });

    it("expands ratioSteps into an evenly spaced threshold list", async () => {
      await mount(`
        <div data-controller="stimeo--intersection" aria-hidden="true"
             data-stimeo--intersection-ratio-steps-value="4"></div>`);
      expect(observerOptions?.threshold).toEqual([0, 0.25, 0.5, 0.75, 1]);
    });
  });

  describe("enter / exit / change", () => {
    it("fires enter and mirrors the state hooks when becoming visible", async () => {
      const events = await mount(defaultFixture);
      observerCallback?.([visible(0.4)]);
      await tick();
      expect(events.enter).toEqual([{ ratio: 0.4 }]);
      expect(root().getAttribute("data-intersecting")).toBe("true");
      expect(root().style.getPropertyValue("--stimeo--intersection-ratio")).toBe("0.4");
    });

    it("fires exit with the leave position", async () => {
      const events = await mount(defaultFixture);
      observerCallback?.([visible()]);
      observerCallback?.([hiddenAfter()]);
      await tick();
      expect(events.exit).toEqual([{ ratio: 0, position: "after" }]);
      expect(root().getAttribute("data-intersecting")).toBe("false");
    });

    it("fires change on every observed update", async () => {
      const events = await mount(defaultFixture);
      observerCallback?.([visible(0.25)]);
      observerCallback?.([visible(0.75)]);
      observerCallback?.([hiddenAfter()]);
      await tick();
      expect(events.change).toEqual([
        { intersecting: true, ratio: 0.25 },
        { intersecting: true, ratio: 0.75 },
        { intersecting: false, ratio: 0 },
      ]);
      // enter/exit stay transition-only.
      expect(events.enter).toHaveLength(1);
      expect(events.exit).toHaveLength(1);
    });

    it("establishes an initial not-visible state silently", async () => {
      const events = await mount(defaultFixture);
      observerCallback?.([hiddenAfter()]);
      await tick();
      expect(root().getAttribute("data-intersecting")).toBe("false");
      expect(events.exit).toHaveLength(0);
      expect(events.passed).toHaveLength(0);
    });

    it("applies a non-zero threshold to the ratio, not to isIntersecting", async () => {
      const events = await mount(`
        <div data-controller="stimeo--intersection" aria-hidden="true"
             data-stimeo--intersection-threshold-value="0.5"></div>`);
      observerCallback?.([visible(0.3)]); // geometrically intersecting, below the line
      await tick();
      expect(events.enter).toHaveLength(0);
      expect(root().getAttribute("data-intersecting")).toBe("false");

      observerCallback?.([visible(0.6)]);
      await tick();
      expect(events.enter).toEqual([{ ratio: 0.6 }]);
    });

    it("clamps a threshold above 1 to the observed line so intersecting stays reachable", async () => {
      // The observer clamps its own threshold to 1; the visibility test must use
      // the same clamped value or `intersecting` could never be reached.
      const events = await mount(`
        <div data-controller="stimeo--intersection" aria-hidden="true"
             data-stimeo--intersection-threshold-value="2"></div>`);
      expect(observerOptions?.threshold).toEqual([1]);

      observerCallback?.([visible(1)]);
      await tick();
      expect(events.enter).toEqual([{ ratio: 1 }]);
      expect(root().getAttribute("data-intersecting")).toBe("true");
    });

    it("tolerates subpixel rounding at threshold 1 (real observers report 0.99x)", async () => {
      // Fractional device pixels make a fully-visible element report a ratio a
      // hair below 1 at the threshold-1 crossing; a strict >= would miss it.
      const events = await mount(`
        <div data-controller="stimeo--intersection" aria-hidden="true"
             data-stimeo--intersection-threshold-value="1"></div>`);
      observerCallback?.([visible(0.995)]);
      await tick();
      expect(events.enter).toEqual([{ ratio: 0.995 }]);
      expect(root().getAttribute("data-intersecting")).toBe("true");
    });

    it("processes every entry in a batched callback (fast scroll enter→exit)", async () => {
      // A single callback can carry several transitions for one target; the last
      // entry alone would swallow the enter of an enter→exit pair.
      const events = await mount(defaultFixture);
      observerCallback?.([visible(), hiddenAfter()]);
      await tick();
      expect(events.enter).toHaveLength(1);
      expect(events.exit).toHaveLength(1);
      expect(root().getAttribute("data-intersecting")).toBe("false");
    });

    it("does not re-fire enter from the same batch after a handler calls refresh", async () => {
      // The infinite-scroll re-arm pattern: enter → append content → refresh().
      // refresh() clears the recorded state, so replaying the batch's remaining
      // entries would announce the same visibility episode twice.
      const events = await mount(defaultFixture);
      root().addEventListener("stimeo--intersection:enter", () => controller()?.refresh());
      observerCallback?.([visible(0.5), visible(0.8)]);
      await tick();
      expect(events.enter).toHaveLength(1);
    });
  });

  describe("passed", () => {
    it("fires passed when the element crosses the root's start edge", async () => {
      const events = await mount(defaultFixture);
      observerCallback?.([visible()]);
      observerCallback?.([hiddenBefore()]);
      await tick();
      expect(events.passed).toEqual([{ passed: true }]);
      expect(events.exit).toEqual([{ ratio: 0, position: "before" }]);
      expect(root().getAttribute("data-passed")).toBe("true");

      observerCallback?.([visible()]);
      await tick();
      expect(events.passed).toEqual([{ passed: true }, { passed: false }]);
      expect(root().getAttribute("data-passed")).toBe("false");
    });

    it("fires an initial passed=true for a page restored mid-scroll", async () => {
      const events = await mount(defaultFixture);
      observerCallback?.([hiddenBefore()]);
      await tick();
      expect(events.passed).toEqual([{ passed: true }]);
    });
  });

  describe("once", () => {
    it("stops observing after the first enter and ignores late callbacks", async () => {
      const events = await mount(`
        <div data-controller="stimeo--intersection" aria-hidden="true"
             data-stimeo--intersection-once-value="true"></div>`);
      observerCallback?.([visible()]);
      await tick();
      expect(events.enter).toHaveLength(1);
      expect(disconnectMock).toHaveBeenCalledOnce();

      observerCallback?.([hiddenAfter()]);
      await tick();
      expect(events.exit).toHaveLength(0);
      expect(root().getAttribute("data-intersecting")).toBe("true"); // final state kept
    });

    it("does not re-observe an element whose enter already fired (cache restore)", async () => {
      await mount(`
        <div data-controller="stimeo--intersection" aria-hidden="true"
             data-stimeo--intersection-once-value="true" data-intersecting="true"></div>`);
      expect(observeMock).not.toHaveBeenCalled();
    });
  });

  describe("refresh", () => {
    it("re-fires enter for a still-visible sentinel (the infinite-scroll re-arm)", async () => {
      const events = await mount(defaultFixture);
      observerCallback?.([visible()]);
      await tick();
      expect(events.enter).toHaveLength(1);

      // Content was appended below; the sentinel never left the viewport, so
      // without refresh() the observer would stay silent forever.
      controller()?.refresh();
      expect(unobserveMock).toHaveBeenCalledWith(root());
      expect(observeMock).toHaveBeenCalledTimes(2);
      observerCallback?.([visible()]); // observe() re-delivers the current state
      await tick();
      expect(events.enter).toHaveLength(2);
    });

    it("is a no-op once the observer is gone (once already fired)", async () => {
      const events = await mount(`
        <div data-controller="stimeo--intersection" aria-hidden="true"
             data-stimeo--intersection-once-value="true"></div>`);
      observerCallback?.([visible()]);
      await tick();
      expect(events.enter).toHaveLength(1);

      controller()?.refresh();
      expect(unobserveMock).not.toHaveBeenCalled();
      expect(root().getAttribute("data-intersecting")).toBe("true"); // final state kept
    });
  });

  describe("Turbo resilience", () => {
    it("does not re-fire enter when reconnecting against a recorded state", async () => {
      const events = await mount(`
        <div data-controller="stimeo--intersection" aria-hidden="true"
             data-intersecting="true" data-passed="false"></div>`);
      observerCallback?.([visible()]); // still visible after the restore
      await tick();
      expect(events.enter).toHaveLength(0);
      expect(events.change).toHaveLength(1); // ratio consumers still get updates
    });

    it("disconnects the observer and ignores late callbacks after teardown", async () => {
      const events = await mount(defaultFixture);
      controller()?.disconnect();
      expect(disconnectMock).toHaveBeenCalledOnce();

      observerCallback?.([visible()]);
      await tick();
      expect(events.enter).toHaveLength(0);
      expect(root().hasAttribute("data-intersecting")).toBe(false);
    });
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount(`
      <main>
        <p>Feed content</p>
        <div data-controller="stimeo--intersection" aria-hidden="true"></div>
      </main>`);
    await expectNoA11yViolations(document.body);
  });

  // --- Layer ③ speech-order regression ---------------------------------------

  it("keeps the sentinel silent before and after intersection", async () => {
    await mount(`
      <main>
        <p>Feed content</p>
        <div data-controller="stimeo--intersection" aria-hidden="true"></div>
      </main>`);
    const container = document.querySelector("main") as HTMLElement;
    const before = await captureSpeech({ container, steps: 2 });
    // Freeze the whole ordered array: the aria-hidden sentinel never announces.
    expect(before).toEqual(["main", "paragraph", "Feed content"]);
    observerCallback?.([visible()]);
    await tick();
    const after = await captureSpeech({ container, steps: 2 });
    expect(after).toEqual(before);
  });
});
