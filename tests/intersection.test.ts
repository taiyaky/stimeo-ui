import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntersectionController } from "../src/controllers/intersection_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
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
  boundingClientRect: { top: number; bottom: number; width: number; height: number };
  rootBounds: { top: number } | null;
};

/**
 * Entry factories, each named for a shape a real observer actually delivers —
 * the geometry and `isIntersecting` are kept consistent with the ratio so a
 * test cannot assert on a state the platform never produces.
 */
const visible = (ratio = 1): Entry => ({
  isIntersecting: true,
  intersectionRatio: ratio,
  boundingClientRect: { top: 300, bottom: 400, width: 200, height: 100 },
  rootBounds: { top: 0 },
});
const hiddenAfter = (): Entry => ({
  isIntersecting: false,
  intersectionRatio: 0,
  boundingClientRect: { top: 800, bottom: 900, width: 200, height: 100 },
  rootBounds: { top: 0 },
});
const hiddenBefore = (): Entry => ({
  isIntersecting: false,
  intersectionRatio: 0,
  boundingClientRect: { top: -150, bottom: -50, width: 200, height: 100 },
  rootBounds: { top: 0 },
});
/**
 * Mid-departure across the root's start edge: the element still overlaps the
 * root (`isIntersecting` stays true) while its top is already above the edge,
 * so only part of it remains visible. This is the shape a non-zero `threshold`
 * sees at the moment visibility drops below its line.
 */
const leavingViaStart = (ratio = 0.25): Entry => ({
  isIntersecting: true,
  intersectionRatio: ratio,
  boundingClientRect: { top: -150, bottom: 50, width: 200, height: 200 },
  rootBounds: { top: 0 },
});
/** An unrendered element: no layout box, reported at the origin. */
const unrendered = (): Entry => ({
  isIntersecting: false,
  intersectionRatio: 0,
  boundingClientRect: { top: 0, bottom: 0, width: 0, height: 0 },
  rootBounds: { top: 0 },
});

describe("IntersectionController", () => {
  let application: Application;
  let observerCallback: ((entries: Entry[]) => void) | null = null;
  let observerOptions: IntersectionObserverInit | undefined;
  let rejectedRootMargin: string | null = null;
  const observeMock = vi.fn();
  const unobserveMock = vi.fn();
  const disconnectMock = vi.fn();

  beforeEach(() => {
    observerCallback = null;
    observerOptions = undefined;
    rejectedRootMargin = null;
    observeMock.mockClear();
    unobserveMock.mockClear();
    disconnectMock.mockClear();

    const IntersectionObserverMock = class {
      constructor(callback: (entries: Entry[]) => void, options?: IntersectionObserverInit) {
        if (options?.rootMargin === rejectedRootMargin) {
          throw new SyntaxError("invalid rootMargin");
        }
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
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

    it("always observes the 0 line alongside a non-zero threshold", async () => {
      // The observer notifies at its configured lines only. With 0.5 alone the
      // last callback arrives while the element is still partly visible, so the
      // element going fully away is never reported and the state hooks freeze
      // mid-departure. Observing 0 as well keeps the departure's end line.
      await mount(`
        <div data-controller="stimeo--intersection" aria-hidden="true"
             data-stimeo--intersection-threshold-value="0.5"></div>`);
      expect(observerOptions?.threshold).toEqual([0, 0.5]);
    });

    it("merges the threshold line into the ratioSteps list", async () => {
      await mount(`
        <div data-controller="stimeo--intersection" aria-hidden="true"
             data-stimeo--intersection-threshold-value="0.3"
             data-stimeo--intersection-ratio-steps-value="4"></div>`);
      expect(observerOptions?.threshold).toEqual([0, 0.25, 0.3, 0.5, 0.75, 1]);
    });

    it("observes the viewport when rootSelector cannot be parsed", async () => {
      // A typo in a data attribute must degrade to viewport observation, not
      // leave the element unobserved with no state hooks at all.
      const events = await mount(`
        <div data-controller="stimeo--intersection" aria-hidden="true"
             data-stimeo--intersection-root-selector-value="#:::not-a-selector"></div>`);
      expect(observeMock).toHaveBeenCalledWith(root());
      expect(observerOptions?.root ?? null).toBeNull();

      observerCallback?.([visible()]);
      await tick();
      expect(events.enter).toHaveLength(1);
    });

    it("uses the effective default threshold after configured options fall back", async () => {
      rejectedRootMargin = "invalid";
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const events = await mount(`
        <div data-controller="stimeo--intersection" aria-hidden="true"
             data-stimeo--intersection-root-margin-value="invalid"
             data-stimeo--intersection-threshold-value="0.5"></div>`);

      expect(observerOptions).toEqual({ root: null });
      // A threshold-0 fallback delivers this initial overlap. It will not notify
      // again merely because the ratio later reaches the discarded authored 0.5.
      observerCallback?.([visible(0.1)]);
      await tick();

      expect(events.enter).toEqual([{ ratio: 0.1 }]);
      expect(root().getAttribute("data-intersecting")).toBe("true");
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
      expect(observerOptions?.threshold).toEqual([0, 1]);

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

    it("reports a leave across the start edge as before, not after", async () => {
      // With a non-zero threshold the element stops counting as visible while it
      // still overlaps the root, so the exit callback carries a rect that spans
      // the edge. The leave direction is decided by which edge the element is
      // crossing, not by whether it has already cleared the root entirely.
      const events = await mount(`
        <div data-controller="stimeo--intersection" aria-hidden="true"
             data-stimeo--intersection-threshold-value="0.5"></div>`);
      observerCallback?.([visible(1)]);
      observerCallback?.([leavingViaStart(0.25)]);
      await tick();
      expect(events.exit).toEqual([{ ratio: 0.25, position: "before" }]);
      // Still overlapping, so the full-crossing hook stays false.
      expect(root().getAttribute("data-passed")).toBe("false");
    });

    it("trusts the platform verdict when it reports no intersection", async () => {
      // At the outgoing crossing the observer can report the threshold's own
      // ratio with `isIntersecting` already false; the ratio alone would then
      // keep the element "visible" after it stopped intersecting.
      const events = await mount(`
        <div data-controller="stimeo--intersection" aria-hidden="true"
             data-stimeo--intersection-threshold-value="0.5"></div>`);
      observerCallback?.([visible(1)]);
      observerCallback?.([{ ...hiddenAfter(), intersectionRatio: 0.6 }]);
      await tick();
      expect(events.exit).toEqual([{ ratio: 0.6, position: "after" }]);
      expect(root().getAttribute("data-intersecting")).toBe("false");
    });

    it("gives an element with no layout box no leave direction", async () => {
      // An unrendered element is reported with an empty rect at the document
      // origin, which sits above a scroll container's start edge without the
      // element having moved anywhere. It carries no position, so the leave
      // reads as the neutral "still ahead" rather than "scrolled past".
      const events = await mount(defaultFixture);
      observerCallback?.([visible()]);
      observerCallback?.([{ ...unrendered(), rootBounds: { top: 100 } }]);
      await tick();
      expect(events.exit).toEqual([{ ratio: 0, position: "after" }]);
    });

    it("keeps publishing the ratio after the element left", async () => {
      // Consumer CSS reads the custom property unconditionally, so it has to be
      // driven back down to 0 on the way out, not frozen at the last visible value.
      await mount(defaultFixture);
      observerCallback?.([visible(0.8)]);
      await tick();
      expect(root().style.getPropertyValue("--stimeo--intersection-ratio")).toBe("0.8");

      observerCallback?.([hiddenAfter()]);
      await tick();
      expect(root().style.getPropertyValue("--stimeo--intersection-ratio")).toBe("0");
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

    it("does not report an unrendered element as passed (empty rect)", async () => {
      // display:none / a hidden ancestor reports a 0x0 rect at the origin, whose
      // `bottom === 0 <= rootBounds.top` would otherwise read as "scrolled past"
      // for an element that never moved.
      const events = await mount(defaultFixture);
      observerCallback?.([unrendered()]);
      await tick();
      expect(events.passed).toEqual([]);
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

    it("ignores the rest of the batch that carried the one-shot enter", async () => {
      // Stopping the watcher mid-batch must also abandon the entries queued
      // behind it: replaying them would undo the final state the one-shot left.
      const events = await mount(`
        <div data-controller="stimeo--intersection" aria-hidden="true"
             data-stimeo--intersection-once-value="true"></div>`);
      observerCallback?.([visible(), hiddenAfter()]);
      await tick();
      expect(events.enter).toHaveLength(1);
      expect(events.exit).toHaveLength(0);
      expect(root().getAttribute("data-intersecting")).toBe("true");
    });

    it("keeps the one-shot marker when the enter handler re-arms", async () => {
      // The infinite-scroll reflex is `enter -> append -> refresh()`. Under
      // `once` the shot is already spent when the handler runs, so re-arming
      // must not clear the marker a later reconnect reads back — otherwise the
      // element is observed again and the one-shot fires a second time.
      const events = await mount(`
        <div data-controller="stimeo--intersection" aria-hidden="true"
             data-stimeo--intersection-once-value="true"></div>`);
      root().addEventListener("stimeo--intersection:enter", () => controller()?.refresh());
      observerCallback?.([visible()]);
      await tick();
      expect(events.enter).toHaveLength(1);
      expect(root().getAttribute("data-intersecting")).toBe("true");
      expect(unobserveMock).not.toHaveBeenCalled();
      expect(observeMock).toHaveBeenCalledOnce();
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

    it("clears the recorded passed state as well", async () => {
      const events = await mount(defaultFixture);
      observerCallback?.([hiddenBefore()]);
      await tick();
      expect(events.passed).toEqual([{ passed: true }]);

      controller()?.refresh();
      expect(root().hasAttribute("data-passed")).toBe(false);
      observerCallback?.([hiddenBefore()]); // observe() re-delivers the current state
      await tick();
      expect(events.passed).toEqual([{ passed: true }, { passed: true }]);
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

    it("does not re-fire passed when reconnecting against a recorded state", async () => {
      const events = await mount(`
        <div data-controller="stimeo--intersection" aria-hidden="true"
             data-intersecting="false" data-passed="true"></div>`);
      observerCallback?.([hiddenBefore()]); // still past the edge after the restore
      await tick();
      expect(events.passed).toHaveLength(0);
      expect(root().getAttribute("data-passed")).toBe("true");
    });

    it("re-observes when threshold is morphed at runtime", async () => {
      // Turbo 8 morphing rewrites the attribute in place without a reconnect, so
      // a threshold frozen at connect would stay wrong for the page's lifetime.
      await mount(defaultFixture);
      expect(observerOptions?.threshold).toEqual([0]);

      root().setAttribute("data-stimeo--intersection-threshold-value", "0.5");
      await tick();
      expect(observerOptions?.threshold).toEqual([0, 0.5]);
      expect(observeMock).toHaveBeenCalledTimes(2);
    });

    it("does not re-observe a morphed threshold after the one-shot fired", async () => {
      const events = await mount(`
        <div data-controller="stimeo--intersection" aria-hidden="true"
             data-stimeo--intersection-once-value="true"></div>`);
      observerCallback?.([visible()]);
      await tick();
      expect(events.enter).toHaveLength(1);

      root().setAttribute("data-stimeo--intersection-threshold-value", "0.5");
      await tick();
      expect(observeMock).toHaveBeenCalledOnce();
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

  // --- Speech order -----------------------------------------------------------

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
