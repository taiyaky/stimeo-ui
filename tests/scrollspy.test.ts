import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollspyController } from "../src/controllers/scrollspy_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ScrollspyController}: the active-section
 * algorithm (trigger line, nested root, non-intersecting fallback, empty
 * rects), `aria-current` ownership, the `change` contract, the `scrollTo`
 * action (root/window geometry, reduced motion, optional focus move), dynamic
 * `link` targets, anchor re-sync, Values, and Turbo-safe teardown.
 *
 * `IntersectionObserver` is mocked because happy-dom has no layout engine, and
 * section geometry is stubbed per test: the controller measures rects **at
 * evaluation time**, so the stubbed rect — not the coordinate carried by the
 * delivered entry — is what decides the current section.
 *
 * `requestAnimationFrame` is mocked too, for the opposite reason: the
 * scroll-driven re-evaluation is *deliberately* deferred to a frame, so a test
 * has to decide when that frame runs. `flushFrames()` is that decision point,
 * and `frameRequests` makes the coalescing itself observable.
 */

interface ObserverRecord {
  callback: (entries: IntersectionObserverEntry[]) => void;
  options: IntersectionObserverInit | undefined;
  observed: Element[];
  disconnectCount: number;
}

describe("ScrollspyController", () => {
  let application: Application | undefined;
  let observers: ObserverRecord[];
  let reducedMotion = false;
  /** Errors Stimulus caught, so a test can assert a path did not throw. */
  let stimulusErrors: Error[];
  let frames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;
  /** How many frames were requested — the coalescing counter. */
  let frameRequests: number;

  beforeEach(() => {
    observers = [];
    reducedMotion = false;
    stimulusErrors = [];
    frames = new Map();
    nextFrameId = 1;
    frameRequests = 0;

    class IntersectionObserverMock {
      readonly #record: ObserverRecord;

      constructor(
        callback: (entries: IntersectionObserverEntry[]) => void,
        options?: IntersectionObserverInit,
      ) {
        this.#record = { callback, options, observed: [], disconnectCount: 0 };
        observers.push(this.#record);
      }

      observe(target: Element): void {
        this.#record.observed.push(target);
      }

      unobserve(): void {}

      disconnect(): void {
        this.#record.disconnectCount += 1;
      }
    }

    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
    vi.stubGlobal("scrollTo", vi.fn());
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
      frameRequests += 1;
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
      frames.delete(id);
    });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion") && reducedMotion,
    }));
    setScrollY(0);
  });

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Runs the frames queued so far (one pass — a frame queued by one is not re-run). */
  const flushFrames = (): void => {
    const queued = [...frames.values()];
    frames.clear();
    for (const callback of queued) callback(0);
  };

  /** Dispatches a `scroll` on the source the controller should be listening to. */
  const scrollOn = (source: EventTarget = window): void => {
    source.dispatchEvent(new Event("scroll"));
  };

  /** A scroll the reader made, delivered to the controller. */
  const scrollAndSettle = (source: EventTarget = window): void => {
    scrollOn(source);
    flushFrames();
  };

  const setScrollY = (y: number): void => {
    Object.defineProperty(window, "scrollY", { configurable: true, value: y });
  };

  /** The default table of contents: viewport root, trigger line at 0 + 80. */
  const FIXTURE = `
    <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
         data-stimeo--scrollspy-offset-value="80">
      <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link"
         data-action="click->stimeo--scrollspy#scrollTo">Intro</a>
      <a id="link-usage" href="#usage" data-stimeo--scrollspy-target="link"
         data-action="click->stimeo--scrollspy#scrollTo">Usage</a>
      <a id="link-api" href="#api" data-stimeo--scrollspy-target="link"
         data-action="click->stimeo--scrollspy#scrollTo">API</a>
    </nav>

    <section id="intro">Intro Section</section>
    <section id="usage">Usage Section</section>
    <section id="api">API Section</section>
  `;

  const start = async (markup: string = FIXTURE): Promise<void> => {
    document.body.innerHTML = markup;
    application = Application.start();
    // Keep Stimulus exceptions visible in every case (a silent handler would
    // swallow a controller error and leave the assertion to fail obscurely).
    application.handleError = (error) => {
      stimulusErrors.push(error);
      console.error("=== REAL STIMULUS ERROR ===", error.message, error.stack);
    };
    application.register("stimeo--scrollspy", ScrollspyController);
    await tick();
  };

  const requireElement = <T extends HTMLElement>(selector: string): T => {
    const found = document.querySelector<T>(selector);
    if (!found) throw new Error(`Fixture element missing: ${selector}`);
    return found;
  };

  const controllerFor = (selector = "#scrollspy"): ScrollspyController =>
    application?.getControllerForElementAndIdentifier(
      requireElement(selector),
      "stimeo--scrollspy",
    ) as ScrollspyController;

  const link = (id: string): HTMLElement => requireElement(`#link-${id}`);
  const section = (id: string): HTMLElement => requireElement(`#${id}`);
  const currentIds = (): string[] =>
    Array.from(document.querySelectorAll("[aria-current='location']")).map((el) => el.id);

  /**
   * Stubs an element's layout box. A zero-size box models an element with no
   * layout at all (`display: none`), which the controller must ignore.
   */
  const layout = (element: HTMLElement, top: number, width = 800, height = 200): void => {
    element.getBoundingClientRect = () =>
      ({
        top,
        bottom: top + height,
        left: 0,
        right: width,
        width,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
  };

  /** Positions the named sections by their top edge (viewport coordinates). */
  const layoutSections = (tops: Record<string, number>): void => {
    for (const [id, top] of Object.entries(tops)) layout(section(id), top);
  };

  /**
   * Builds an entry for `id`. `recordedTop` overrides the coordinate the entry
   * carries — the value a real browser captured when the threshold was crossed
   * — without touching the element's current rect, which is how a stale batch
   * is simulated.
   */
  const entryOf = (target: HTMLElement, isIntersecting: boolean, recordedTop?: number) => {
    const rect = target.getBoundingClientRect();
    const boundingClientRect =
      recordedTop === undefined ? rect : ({ ...rect, top: recordedTop } as DOMRect);
    return {
      target,
      isIntersecting,
      boundingClientRect,
      intersectionRatio: isIntersecting ? 1 : 0,
      intersectionRect: rect,
      rootBounds: null,
      time: 0,
    } as unknown as IntersectionObserverEntry;
  };

  const entryFor = (id: string, isIntersecting: boolean, recordedTop?: number) =>
    entryOf(section(id), isIntersecting, recordedTop);

  /** Delivers a batch through the observer at `index` (default: the newest). */
  const deliver = (entries: IntersectionObserverEntry[], index = observers.length - 1): void => {
    const record = observers[index];
    if (!record) throw new Error(`No IntersectionObserver was created (index ${index})`);
    record.callback(entries);
  };

  const clickLink = (id: string): MouseEvent => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link(id).dispatchEvent(event);
    return event;
  };

  // --- Observation setup ------------------------------------------------------

  it("initializes and observes target section elements", async () => {
    await start();

    // Exactly one observer: the `linkTarget*` callbacks Stimulus fires for the
    // links already in the markup must not rebuild what `connect()` builds.
    expect(observers).toHaveLength(1);
    expect(observers[0]?.options?.rootMargin).toBe("-80px 0px -80% 0px");
    expect(observers[0]?.options?.root ?? null).toBeNull();
    expect(observers[0]?.options?.threshold).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(observers[0]?.observed.map((el) => el.id)).toEqual(["intro", "usage", "api"]);
  });

  it("derives a viewport root and a zero-offset trigger line by default", async () => {
    await start(`
      <nav data-controller="stimeo--scrollspy" aria-label="On this page">
        <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
        <a id="link-usage" href="#usage" data-stimeo--scrollspy-target="link">Usage</a>
      </nav>
      <section id="intro">Intro</section>
      <section id="usage">Usage</section>`);

    expect(observers[0]?.options?.rootMargin).toBe("0px 0px -80% 0px");
    expect(observers[0]?.options?.root ?? null).toBeNull();

    // With offset 0 the trigger line is the viewport top, so intro (top -10)
    // beats usage (top 40).
    layoutSections({ intro: -10, usage: 40 });
    deliver([entryFor("intro", true), entryFor("usage", true)]);
    expect(currentIds()).toEqual(["link-intro"]);
  });

  it("numerically negates a negative offset when deriving rootMargin", async () => {
    await start(`
      <nav data-controller="stimeo--scrollspy" aria-label="On this page"
           data-stimeo--scrollspy-offset-value="-20">
        <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
      </nav>
      <section id="intro">Intro</section>`);

    expect(observers[0]?.options?.rootMargin).toBe("20px 0px -80% 0px");
  });

  it("normalizes a non-finite offset across observation, selection, and scrolling", async () => {
    await start(`
      <nav id="scrollspy" data-controller="stimeo--scrollspy" aria-label="On this page"
           data-stimeo--scrollspy-offset-value="not-a-number">
        <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
        <a id="link-usage" href="#usage" data-stimeo--scrollspy-target="link"
           data-action="click->stimeo--scrollspy#scrollTo">Usage</a>
      </nav>
      <section id="intro">Intro</section>
      <section id="usage">Usage</section>`);

    expect(observers[0]?.options?.rootMargin).toBe("0px 0px -80% 0px");

    // A single normalized value must drive both the trigger line and the jump;
    // otherwise observation starts but the controller still publishes no
    // location and later asks the platform to scroll to NaN.
    layoutSections({ intro: 10, usage: 100 });
    deliver([entryFor("intro", true), entryFor("usage", true)]);
    expect(currentIds()).toEqual(["link-intro"]);

    setScrollY(100);
    layoutSections({ usage: 500 });
    clickLink("usage");
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 600, behavior: "smooth" });
    expect(stimulusErrors).toEqual([]);
  });

  it("normalizes positive and negative infinite offsets", async () => {
    await start();
    const controller = controllerFor();

    for (const offset of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      controller.offsetValue = offset;
      controller.offsetValueChanged();
      expect(observers.at(-1)?.options?.rootMargin).toBe("0px 0px -80% 0px");
    }
  });

  it("prefers an explicit rootMargin over the offset-derived one", async () => {
    await start(`
      <nav data-controller="stimeo--scrollspy" aria-label="On this page"
           data-stimeo--scrollspy-offset-value="80"
           data-stimeo--scrollspy-root-margin-value="-10px 0px -50% 0px">
        <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
      </nav>
      <section id="intro">Intro</section>`);

    expect(observers[0]?.options?.rootMargin).toBe("-10px 0px -50% 0px");
  });

  it("rebuilds the observer when a Value changes", async () => {
    await start();
    const controller = application?.getControllerForElementAndIdentifier(
      requireElement("#scrollspy"),
      "stimeo--scrollspy",
    ) as ScrollspyController;

    controller.offsetValue = 200;
    controller.offsetValueChanged();
    expect(observers.at(-1)?.options?.rootMargin).toBe("-200px 0px -80% 0px");
    expect(observers[0]?.disconnectCount).toBe(1);

    document.body.insertAdjacentHTML("beforeend", `<div class="content"></div>`);
    controller.rootSelectorValue = ".content";
    controller.rootSelectorValueChanged();
    expect(observers.at(-1)?.options?.root).toBe(requireElement(".content"));
  });

  // --- Active-section algorithm -----------------------------------------------

  it("toggles aria-current on links according to intersection visibility states", async () => {
    await start();
    const changeHandler = vi.fn();
    requireElement("#scrollspy").addEventListener("stimeo--scrollspy:change", changeHandler);

    // Trigger line = 80. intro (top 90) is 10px away, usage (top 250) is 170px.
    layoutSections({ intro: 90, usage: 250, api: 600 });
    deliver([entryFor("intro", true), entryFor("usage", true)]);

    expect(currentIds()).toEqual(["link-intro"]);
    expect(changeHandler).toHaveBeenCalledOnce();
    expect(changeHandler.mock.calls[0]?.[0]?.detail).toEqual({
      id: "intro",
      link: link("intro"),
    });

    // Scrolled down: intro (top -100) is 180px away, usage (top 85) only 5px.
    layoutSections({ intro: -100, usage: 85 });
    deliver([entryFor("intro", true), entryFor("usage", true)]);

    expect(currentIds()).toEqual(["link-usage"]);
    expect(changeHandler).toHaveBeenCalledTimes(2);
    expect(changeHandler.mock.calls[1]?.[0]?.detail).toEqual({
      id: "usage",
      link: link("usage"),
    });
  });

  it("measures the trigger line from a nested rootSelector container, not the viewport top", async () => {
    await start(`
      <nav id="scrollspy" data-controller="stimeo--scrollspy" aria-label="On this page"
           data-stimeo--scrollspy-offset-value="80"
           data-stimeo--scrollspy-root-selector-value=".content">
        <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
        <a id="link-usage" href="#usage" data-stimeo--scrollspy-target="link">Usage</a>
      </nav>
      <div class="content">
        <section id="intro">Intro Section</section>
        <section id="usage">Usage Section</section>
      </div>`);

    // The container sits 200px down the viewport, so the trigger line is 280.
    layout(requireElement(".content"), 200, 800, 600);
    expect(observers[0]?.options?.root).toBe(requireElement(".content"));

    // Against a bare offset (80), intro (top 100) would win; against the
    // container-relative line (280), usage (top 285) is correctly closest.
    layoutSections({ intro: 100, usage: 285 });
    deliver([entryFor("intro", true), entryFor("usage", true)]);

    expect(currentIds()).toEqual(["link-usage"]);
  });

  it("picks the same section for the same geometry no matter how it was reached", async () => {
    await start();

    // Path A — two batches. The first records intro while it is the closest;
    // the second reports only usage and carries intro's *stale* coordinate.
    // Every rect must be re-measured, otherwise intro's remembered top (90)
    // beats usage's stale one (250) even though usage now sits on the line.
    layoutSections({ intro: 90, usage: 250, api: 800 });
    deliver([entryFor("intro", true), entryFor("usage", true), entryFor("api", false)]);
    expect(currentIds()).toEqual(["link-intro"]);

    layoutSections({ intro: -400, usage: 85, api: 300 });
    deliver([entryFor("usage", true, 250)]);
    const afterTwoBatches = currentIds();

    // Path B — the same final geometry delivered in a single batch.
    disconnectAndStopApplication(application as Application);
    await start();
    layoutSections({ intro: -400, usage: 85, api: 300 });
    deliver([entryFor("intro", false), entryFor("usage", true), entryFor("api", false)]);

    expect(afterTwoBatches).toEqual(["link-usage"]);
    expect(currentIds()).toEqual(afterTwoBatches);
  });

  // --- Scroll-driven re-evaluation --------------------------------------------

  it("follows the reader through a non-intersecting gap on scroll alone", async () => {
    await start();

    // One batch establishes the tracked set. From here the reader stays inside
    // a gap far wider than the observation band, so no section crosses a
    // threshold and a real browser delivers nothing more — `deliver()` is
    // deliberately not called again.
    layoutSections({ intro: -400, usage: 900, api: 1700 });
    deliver([entryFor("intro", false), entryFor("usage", false), entryFor("api", false)]);
    expect(currentIds()).toEqual(["link-intro"]);

    // Scrolled far enough that api is now the section on the trigger line.
    layoutSections({ intro: -1400, usage: -600, api: 200 });
    scrollAndSettle();

    expect(currentIds()).toEqual(["link-api"]);
  });

  it("reaches the same section by stepwise scrolling and by a direct jump", async () => {
    // Path A — the reader scrolls through the gap in steps.
    await start();
    layoutSections({ intro: -400, usage: 900, api: 1700 });
    deliver([entryFor("intro", false), entryFor("usage", false), entryFor("api", false)]);
    layoutSections({ intro: -900, usage: 400, api: 1200 });
    scrollAndSettle();
    layoutSections({ intro: -1400, usage: -600, api: 200 });
    scrollAndSettle();
    const stepwise = currentIds();

    // Path B — one jump to the same final geometry.
    disconnectAndStopApplication(application as Application);
    await start();
    layoutSections({ intro: -400, usage: 900, api: 1700 });
    deliver([entryFor("intro", false), entryFor("usage", false), entryFor("api", false)]);
    layoutSections({ intro: -1400, usage: -600, api: 200 });
    scrollAndSettle();

    // The position decides the current section, never the route taken to it.
    expect(stepwise).toEqual(["link-api"]);
    expect(currentIds()).toEqual(stepwise);
  });

  it("does not re-dispatch change when a scroll keeps the same section closest", async () => {
    await start();
    const changeHandler = vi.fn();
    requireElement("#scrollspy").addEventListener("stimeo--scrollspy:change", changeHandler);

    layoutSections({ intro: 90, usage: 900, api: 1700 });
    deliver([entryFor("intro", true), entryFor("usage", false), entryFor("api", false)]);
    expect(changeHandler).toHaveBeenCalledOnce();

    layoutSections({ intro: 70, usage: 880, api: 1680 });
    scrollAndSettle();
    layoutSections({ intro: 60, usage: 870, api: 1670 });
    scrollAndSettle();

    expect(changeHandler).toHaveBeenCalledOnce();
    expect(currentIds()).toEqual(["link-intro"]);
  });

  it("coalesces a scroll burst into a single re-evaluation frame", async () => {
    await start();
    layoutSections({ intro: 90, usage: 900, api: 1700 });
    deliver([entryFor("intro", true), entryFor("usage", false), entryFor("api", false)]);
    const before = frameRequests;

    scrollOn();
    scrollOn();
    scrollOn();

    // A scroll fires per rendered frame at best and far more often in practice;
    // measuring once per burst is the difference between one layout read and
    // one per event.
    expect(frameRequests - before).toBe(1);

    flushFrames();
    scrollOn();
    expect(frameRequests - before).toBe(2);
  });

  it("moves the scroll listener when the root changes instead of leaving one behind", async () => {
    await start(`
      <nav id="scrollspy" data-controller="stimeo--scrollspy" aria-label="On this page"
           data-stimeo--scrollspy-offset-value="80"
           data-stimeo--scrollspy-root-selector-value=".first">
        <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
        <a id="link-usage" href="#usage" data-stimeo--scrollspy-target="link">Usage</a>
      </nav>
      <div class="first">
        <section id="intro">Intro</section>
        <section id="usage">Usage</section>
      </div>
      <div class="second"></div>`);

    const first = requireElement(".first");
    const second = requireElement(".second");
    layout(first, 0, 800, 600);
    layout(second, 0, 800, 600);

    const controller = controllerFor();
    controller.rootSelectorValue = ".second";
    controller.rootSelectorValueChanged();

    // The rebuilt observer re-delivers the current state, as `observe()` does.
    layoutSections({ intro: -400, usage: 900 });
    deliver([entryFor("intro", false), entryFor("usage", false)]);
    expect(currentIds()).toEqual(["link-intro"]);

    // The old container is no longer the scroll source. A listener left on it
    // would keep re-evaluating against a container the reader has abandoned.
    layoutSections({ intro: -1400, usage: 60 });
    scrollAndSettle(first);
    expect(currentIds()).toEqual(["link-intro"]);

    scrollAndSettle(second);
    expect(currentIds()).toEqual(["link-usage"]);
  });

  it("stops following the scroll once disconnected", async () => {
    await start();
    layoutSections({ intro: -400, usage: 900, api: 1700 });
    deliver([entryFor("intro", false), entryFor("usage", false), entryFor("api", false)]);
    expect(currentIds()).toEqual(["link-intro"]);

    controllerFor().disconnect();
    const framesBefore = frameRequests;

    layoutSections({ intro: -1400, usage: -600, api: 200 });
    scrollAndSettle();

    // The listener itself is gone, so the scroll does not even reach the point
    // of asking for a frame. Asserting only on the DOM would pass without the
    // `removeEventListener`, because teardown also empties the tracked set —
    // the re-evaluation would run and simply find nothing to publish.
    expect(frameRequests).toBe(framesBefore);
    // And the published state is left exactly as it was: teardown neither
    // re-evaluates nor strips the attribute a Turbo snapshot may be caching.
    expect(currentIds()).toEqual(["link-intro"]);
  });

  it("cancels a re-evaluation frame that was already queued when it disconnects", async () => {
    await start();
    layoutSections({ intro: -400, usage: 900, api: 1700 });
    deliver([entryFor("intro", false), entryFor("usage", false), entryFor("api", false)]);

    scrollOn();
    expect(frames.size).toBe(1);

    controllerFor().disconnect();

    // The handle is released, not merely rendered harmless by a flag.
    expect(frames.size).toBe(0);
    layoutSections({ intro: -1400, usage: -600, api: 200 });
    flushFrames();
    expect(currentIds()).toEqual(["link-intro"]);
  });

  it("keeps the closest tracked section current when nothing intersects", async () => {
    await start();

    layoutSections({ intro: 90, usage: 250, api: 600 });
    deliver([entryFor("intro", true)]);
    expect(currentIds()).toEqual(["link-intro"]);

    // Scrolled past every section: no entry intersects, but the table of
    // contents must not go blank — api (top 120) is nearest the line at 80.
    layoutSections({ intro: -900, usage: -400, api: 120 });
    deliver([entryFor("intro", false), entryFor("usage", false), entryFor("api", false)]);

    expect(currentIds()).toEqual(["link-api"]);
  });

  it("never lets a section without a layout box win the fallback", async () => {
    await start();

    // intro is collapsed (`display: none`): an empty rect reports top 0, which
    // would otherwise sit 80px from the trigger line and beat the laid-out
    // usage section 520px away.
    layout(section("intro"), 0, 0, 0);
    layoutSections({ usage: 600, api: 900 });
    deliver([entryFor("intro", false), entryFor("usage", false), entryFor("api", false)]);

    expect(currentIds()).toEqual(["link-usage"]);
  });

  it("ignores an intersection entry whose section lost its id", async () => {
    await start();
    const changeHandler = vi.fn();
    requireElement("#scrollspy").addEventListener("stimeo--scrollspy:change", changeHandler);

    // The observer holds the node, not the id it was resolved by, and
    // `Element.id` is mutable — so a re-render that blanks an observed
    // section's id in place (the section-side twin of the in-place `href`
    // rewrite) delivers an entry with an empty id. Tracking it under `""` lets
    // a nameless section win the distance race, and an empty winner publishes
    // nothing at all: the table of contents would go blank rather than keep the
    // nearest link.
    const nameless = section("usage");
    nameless.removeAttribute("id");

    layout(nameless, 85); // right on the trigger line — it would win if tracked
    layoutSections({ intro: 300, api: 900 });
    deliver([entryFor("intro", true), entryOf(nameless, true), entryFor("api", false)]);

    expect(currentIds()).toEqual(["link-intro"]);
    expect(changeHandler).toHaveBeenCalledOnce();
  });

  it("does not re-dispatch change while the same section stays closest", async () => {
    await start();
    const changeHandler = vi.fn();
    requireElement("#scrollspy").addEventListener("stimeo--scrollspy:change", changeHandler);

    layoutSections({ intro: 90, usage: 250, api: 600 });
    deliver([entryFor("intro", true), entryFor("usage", true)]);
    expect(changeHandler).toHaveBeenCalledOnce();

    // A small scroll that keeps intro closest must stay silent.
    layoutSections({ intro: 70, usage: 230, api: 580 });
    deliver([entryFor("intro", true), entryFor("usage", true)]);

    expect(changeHandler).toHaveBeenCalledOnce();
    expect(currentIds()).toEqual(["link-intro"]);
  });

  it("adopts the current location already encoded in the DOM without re-announcing it", async () => {
    // Simulates a Turbo cache restore: the snapshot still carries aria-current.
    await start(`
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80">
        <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
        <a id="link-usage" href="#usage" data-stimeo--scrollspy-target="link"
           aria-current="location">Usage</a>
      </nav>
      <section id="intro">Intro</section>
      <section id="usage">Usage</section>`);

    const changeHandler = vi.fn();
    requireElement("#scrollspy").addEventListener("stimeo--scrollspy:change", changeHandler);

    layoutSections({ intro: -400, usage: 85 });
    deliver([entryFor("intro", false), entryFor("usage", true)]);

    expect(currentIds()).toEqual(["link-usage"]);
    expect(changeHandler).not.toHaveBeenCalled();
  });

  it("marks every link that anchors the active section", async () => {
    await start(`
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80">
        <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
        <a id="link-intro-mobile" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
        <a id="link-usage" href="#usage" data-stimeo--scrollspy-target="link">Usage</a>
      </nav>
      <section id="intro">Intro</section>
      <section id="usage">Usage</section>`);

    // A duplicated href must not be observed twice, but both links get marked.
    expect(observers[0]?.observed.map((el) => el.id)).toEqual(["intro", "usage"]);

    layoutSections({ intro: 85, usage: 600 });
    deliver([entryFor("intro", true), entryFor("usage", true)]);

    expect(currentIds()).toEqual(["link-intro", "link-intro-mobile"]);
  });

  it("reclaims only its own aria-current value from inactive links", async () => {
    await start(`
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80">
        <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link"
           aria-current="page">Intro</a>
        <a id="link-usage" href="#usage" data-stimeo--scrollspy-target="link">Usage</a>
      </nav>
      <section id="intro">Intro</section>
      <section id="usage">Usage</section>`);

    layoutSections({ intro: -400, usage: 85 });
    deliver([entryFor("intro", false), entryFor("usage", true)]);

    expect(link("usage").getAttribute("aria-current")).toBe("location");
    // The author-owned "page" value survives; only "location" is reclaimed.
    expect(link("intro").getAttribute("aria-current")).toBe("page");
  });

  // --- Edges ------------------------------------------------------------------

  it("stays inert without link targets", async () => {
    await start(`
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"></nav>
      <section id="intro">Intro</section>`);

    expect(observers).toHaveLength(0);
  });

  it("spies a single link", async () => {
    await start(`
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80">
        <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
      </nav>
      <section id="intro">Intro</section>`);

    expect(observers[0]?.observed.map((el) => el.id)).toEqual(["intro"]);
    layoutSections({ intro: 200 });
    deliver([entryFor("intro", true)]);
    expect(currentIds()).toEqual(["link-intro"]);
  });

  it("ignores links that do not anchor a same-document fragment", async () => {
    await start(`
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80">
        <a id="link-docs" href="/docs" data-stimeo--scrollspy-target="link">Docs</a>
        <a id="link-empty" href="#" data-stimeo--scrollspy-target="link">Top</a>
        <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
        <a id="link-usage" data-href="#usage" data-stimeo--scrollspy-target="link">Usage</a>
      </nav>
      <section id="intro">Intro</section>
      <section id="usage">Usage</section>`);

    // `data-href` is the fallback anchor source; a non-fragment href is skipped.
    expect(observers[0]?.observed.map((el) => el.id)).toEqual(["intro", "usage"]);

    layoutSections({ intro: -400, usage: 85 });
    deliver([entryFor("intro", true), entryFor("usage", true)]);
    expect(currentIds()).toEqual(["link-usage"]);
  });

  // --- Anchor resolution order ------------------------------------------------

  it("falls back to data-href when href must stay a real URL", async () => {
    await start(`
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80">
        <a id="link-intro" href="/guide/intro" data-href="#intro"
           data-stimeo--scrollspy-target="link">Intro</a>
        <a id="link-usage" href="/guide/usage" data-href="#usage"
           data-stimeo--scrollspy-target="link">Usage</a>
      </nav>
      <section id="intro">Intro</section>
      <section id="usage">Usage</section>`);

    // A server-rendered permalink that also spies — the shape `data-href` serves.
    // Choosing the first attribute that is *present* rather than the first that
    // is *usable* leaves this exact markup entirely unobserved.
    expect(observers[0]?.observed.map((el) => el.id)).toEqual(["intro", "usage"]);

    layoutSections({ intro: -400, usage: 85 });
    deliver([entryFor("intro", false), entryFor("usage", true)]);
    expect(currentIds()).toEqual(["link-usage"]);
  });

  it("falls back to data-href when href is only a bare hash", async () => {
    await start(`
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80">
        <a id="link-usage" href="#" data-href="#usage"
           data-stimeo--scrollspy-target="link">Usage</a>
      </nav>
      <section id="usage">Usage</section>`);

    expect(observers[0]?.observed.map((el) => el.id)).toEqual(["usage"]);
  });

  it("prefers href over data-href when both anchor a fragment", async () => {
    await start(`
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80">
        <a id="link-intro" href="#intro" data-href="#usage"
           data-stimeo--scrollspy-target="link">Intro</a>
      </nav>
      <section id="intro">Intro</section>
      <section id="usage">Usage</section>`);

    expect(observers[0]?.observed.map((el) => el.id)).toEqual(["intro"]);

    layoutSections({ intro: 85, usage: 600 });
    deliver([entryFor("intro", true)]);
    expect(currentIds()).toEqual(["link-intro"]);
  });

  it("ignores a non-fragment link even when a section is literally named null", async () => {
    await start(`
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80">
        <a id="link-guide" href="/guide" data-stimeo--scrollspy-target="link">Guide</a>
        <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
      </nav>
      <section id="null">Null</section>
      <section id="intro">Intro</section>`);

    // A link that anchors no fragment resolves to `null`, and `getElementById`
    // stringifies that to `"null"` — a perfectly legal id. Observing that
    // section would put a target in the race that no link anchors, so the batch
    // where it wins publishes an id nothing can display: the table of contents
    // goes blank instead of keeping the nearest link.
    expect(observers[0]?.observed.map((el) => el.id)).toEqual(["intro"]);

    layoutSections({ null: 85, intro: 300 });
    deliver([entryFor("intro", true)]);
    expect(currentIds()).toEqual(["link-intro"]);
  });

  it("ignores a link whose href and data-href are both non-fragments", async () => {
    await start(`
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80">
        <a id="link-docs" href="/docs" data-href="/docs.html"
           data-stimeo--scrollspy-target="link">Docs</a>
        <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
      </nav>
      <section id="intro">Intro</section>`);

    expect(observers[0]?.observed.map((el) => el.id)).toEqual(["intro"]);

    layoutSections({ intro: 85 });
    deliver([entryFor("intro", true)]);
    expect(currentIds()).toEqual(["link-intro"]);
  });

  // --- Re-sync on a link-set or anchor change ---------------------------------

  it("marks a duplicate link added at runtime without re-announcing", async () => {
    await start();
    const changeHandler = vi.fn();
    requireElement("#scrollspy").addEventListener("stimeo--scrollspy:change", changeHandler);

    layoutSections({ intro: 85, usage: 600, api: 900 });
    deliver([entryFor("intro", true), entryFor("usage", false), entryFor("api", false)]);
    expect(currentIds()).toEqual(["link-intro"]);
    expect(changeHandler).toHaveBeenCalledOnce();

    // A collapsed mobile table of contents renders while the reader has not
    // moved. The winning section never changes, so evaluation on its own would
    // leave the new link blank until the reader happened to cross a boundary.
    requireElement("#scrollspy").insertAdjacentHTML(
      "beforeend",
      `<a id="link-intro-mobile" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>`,
    );
    await tick();

    expect(currentIds()).toEqual(["link-intro", "link-intro-mobile"]);
    // Re-publishing over a new link set is not navigation.
    expect(changeHandler).toHaveBeenCalledOnce();
    // The section is observed once, not once per link that anchors it.
    expect(observers.at(-1)?.observed.map((el) => el.id)).toEqual(["intro", "usage", "api"]);
  });

  it("re-anchors observation when a morph rewrites a link's href in place", async () => {
    await start();
    expect(observers[0]?.observed.map((el) => el.id)).toEqual(["intro", "usage", "api"]);

    // Turbo 8 morphing keeps the element *and* its target marker and rewrites
    // only attributes, so Stimulus fires no target callback at all.
    document.body.insertAdjacentHTML("beforeend", `<section id="faq">FAQ Section</section>`);
    link("api").setAttribute("href", "#faq");
    await tick();

    expect(observers.at(-1)?.observed.map((el) => el.id)).toEqual(["intro", "usage", "faq"]);

    layoutSections({ intro: -900, usage: -400, faq: 85 });
    deliver([entryFor("faq", true)]);
    expect(currentIds()).toEqual(["link-api"]);
  });

  it("re-anchors observation when a morph rewrites data-href in place", async () => {
    await start(`
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80">
        <a id="link-intro" href="/guide/intro" data-href="#intro"
           data-stimeo--scrollspy-target="link">Intro</a>
      </nav>
      <section id="intro">Intro</section>
      <section id="usage">Usage</section>`);
    expect(observers[0]?.observed.map((el) => el.id)).toEqual(["intro"]);

    link("intro").setAttribute("data-href", "#usage");
    await tick();

    expect(observers.at(-1)?.observed.map((el) => el.id)).toEqual(["usage"]);
  });

  it("ignores an anchor rewrite on an element that is not a link target", async () => {
    await start(`
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80">
        <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
        <a id="plain" href="#top">Back to top</a>
      </nav>
      <section id="intro">Intro</section>`);
    expect(observers).toHaveLength(1);

    // The observer is scoped to the controller element, whose subtree also
    // holds links the author never marked as targets.
    requireElement("#plain").setAttribute("href", "#elsewhere");
    await tick();

    expect(observers).toHaveLength(1);
  });

  it("rebuilds once for a morph that rewrites several links at once", async () => {
    await start();
    expect(observers).toHaveLength(1);

    document.body.insertAdjacentHTML(
      "beforeend",
      `<section id="faq">FAQ</section><section id="changelog">Changelog</section>`,
    );
    link("usage").setAttribute("href", "#faq");
    link("api").setAttribute("href", "#changelog");
    await tick();

    expect(observers).toHaveLength(2);
    expect(observers.at(-1)?.observed.map((el) => el.id)).toEqual(["intro", "faq", "changelog"]);
  });

  it("rebuilds once when a morph adds several links at once", async () => {
    await start();
    expect(observers).toHaveLength(1);

    document.body.insertAdjacentHTML(
      "beforeend",
      `<section id="faq">FAQ</section><section id="changelog">Changelog</section>`,
    );
    requireElement("#scrollspy").insertAdjacentHTML(
      "beforeend",
      `<a id="link-faq" href="#faq" data-stimeo--scrollspy-target="link">FAQ</a>
       <a id="link-changelog" href="#changelog" data-stimeo--scrollspy-target="link">Changelog</a>`,
    );
    await tick();

    // Two target callbacks land in one mutation batch; rebuilding per callback
    // would tear down and re-create the observer once per added link.
    expect(observers).toHaveLength(2);
    expect(observers.at(-1)?.observed.map((el) => el.id)).toEqual([
      "intro",
      "usage",
      "api",
      "faq",
      "changelog",
    ]);
  });

  it("keeps the reader's location when a morph re-anchors one of the current links", async () => {
    await start(`
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80">
        <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
        <a id="link-intro-mobile" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
        <a id="link-usage" href="#usage" data-stimeo--scrollspy-target="link">Usage</a>
      </nav>
      <section id="intro">Intro</section>
      <section id="usage">Usage</section>`);
    const changeHandler = vi.fn();
    requireElement("#scrollspy").addEventListener("stimeo--scrollspy:change", changeHandler);

    layoutSections({ intro: 85, usage: 900 });
    deliver([entryFor("intro", true), entryFor("usage", false)]);
    expect(currentIds()).toEqual(["link-intro", "link-intro-mobile"]);
    expect(changeHandler).toHaveBeenCalledOnce();

    // A morph re-points the *first* of the two current links at another
    // section. The reader has not moved, so the location is still `intro`;
    // reading it back off the rewritten link instead would hand the current
    // location to a section nobody scrolled to.
    link("intro").setAttribute("href", "#usage");
    await tick();

    expect(currentIds()).toEqual(["link-intro-mobile"]);
    expect(changeHandler).toHaveBeenCalledOnce();

    // …and the rebuilt observer re-confirming the same geometry stays silent,
    // rather than announcing the correction as a journey the reader never made.
    deliver([entryFor("intro", true), entryFor("usage", false)]);
    expect(currentIds()).toEqual(["link-intro-mobile"]);
    expect(changeHandler).toHaveBeenCalledOnce();
  });

  it("reclaims its own aria-current from a link whose anchor was rewritten away", async () => {
    await start();
    layoutSections({ intro: 85, usage: 600, api: 900 });
    deliver([entryFor("intro", true), entryFor("usage", false), entryFor("api", false)]);
    expect(currentIds()).toEqual(["link-intro"]);

    // A morph re-points the marked link at a real URL. It now anchors nothing
    // in this document, so it cannot be the reader's location — and leaving the
    // attribute behind would have a screen reader announce a link to another
    // page as the current location, indefinitely.
    link("intro").setAttribute("href", "/guide/intro");
    await tick();

    expect(currentIds()).toEqual([]);
  });

  it("drops a rebuild that was queued before disconnect", async () => {
    await start();
    const controller = controllerFor();
    expect(observers).toHaveLength(1);

    // Stimulus reports a target change, and teardown happens before the queued
    // microtask drains. Rebuilding after that would re-observe the sections and
    // re-attach the scroll listener on a detached controller.
    controller.linkTargetDisconnected();
    controller.disconnect();
    await tick();

    expect(observers).toHaveLength(1);
    expect(observers[0]?.disconnectCount).toBe(1);
  });

  it("releases the anchor observer on disconnect", async () => {
    await start();
    const controller = controllerFor();

    document.body.insertAdjacentHTML("beforeend", `<section id="faq">FAQ</section>`);
    controller.disconnect();
    link("api").setAttribute("href", "#faq");
    await tick();

    // No rebuild after teardown: the observer is severed and the queued-rebuild
    // flag is cleared, so neither channel can resurrect the observation set.
    expect(observers).toHaveLength(1);
    expect(observers[0]?.disconnectCount).toBe(1);
  });

  // --- Scroll-root resolution -------------------------------------------------

  it("re-resolves a scroll root that a morph replaced before scrolling it", async () => {
    await start(`
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80"
           data-stimeo--scrollspy-root-selector-value=".content">
        <a id="link-usage" href="#usage" data-stimeo--scrollspy-target="link"
           data-action="click->stimeo--scrollspy#scrollTo">Usage</a>
      </nav>
      <div class="content"><section id="usage">Usage</section></div>`);

    const stale = requireElement(".content");
    const staleScrollTo = vi.fn();
    stale.scrollTo = staleScrollTo as unknown as HTMLElement["scrollTo"];

    // A morph replaced the container with a fresh element matching the same
    // selector. Nothing tells the controller, so the cached reference is the
    // detached node — scrolling it would move nothing the reader can see.
    const fresh = document.createElement("div");
    fresh.className = "content";
    fresh.append(section("usage"));
    stale.replaceWith(fresh);

    const freshScrollTo = vi.fn();
    fresh.scrollTo = freshScrollTo as unknown as HTMLElement["scrollTo"];
    layout(fresh, 200, 800, 400);
    fresh.scrollTop = 100;
    layoutSections({ usage: 500 });

    clickLink("usage");

    // scrollTop (100) + (target 500 - container 200) - offset 80 = 320.
    expect(freshScrollTo).toHaveBeenCalledWith({ top: 320, behavior: "smooth" });
    expect(staleScrollTo).not.toHaveBeenCalled();
  });

  it("falls back to the viewport when rootSelector is not valid CSS", async () => {
    await start(`
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80"
           data-stimeo--scrollspy-root-selector-value=":::not-a-selector">
        <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
      </nav>
      <section id="intro">Intro</section>`);

    // A typo in a data attribute must degrade to viewport spying. Letting the
    // selector error escape `connect()` leaves the controller inert instead.
    expect(stimulusErrors).toEqual([]);
    expect(observers).toHaveLength(1);
    expect(observers[0]?.options?.root ?? null).toBeNull();

    layoutSections({ intro: 85 });
    deliver([entryFor("intro", true)]);
    expect(currentIds()).toEqual(["link-intro"]);
  });

  it("falls back to the viewport when rootSelector matches a non-HTML element", async () => {
    await start(`
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80"
           data-stimeo--scrollspy-root-selector-value="svg">
        <a id="link-intro" href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
      </nav>
      <svg aria-hidden="true"><rect /></svg>
      <section id="intro">Intro</section>`);

    // An SVG node is not a scroll container — it has no scroll box to move —
    // so adopting it as the observation root would silently break the spy.
    expect(observers).toHaveLength(1);
    expect(observers[0]?.options?.root ?? null).toBeNull();
  });

  it("re-syncs observation when links are added or removed at runtime", async () => {
    await start();
    expect(observers).toHaveLength(1);

    // A Turbo Stream appends a fourth entry and its section.
    document.body.insertAdjacentHTML("beforeend", `<section id="faq">FAQ Section</section>`);
    requireElement("#scrollspy").insertAdjacentHTML(
      "beforeend",
      `<a id="link-faq" href="#faq" data-stimeo--scrollspy-target="link">FAQ</a>`,
    );
    await tick();

    expect(observers.length).toBeGreaterThan(1);
    expect(observers.at(-1)?.observed.map((el) => el.id)).toEqual(["intro", "usage", "api", "faq"]);

    layoutSections({ intro: -900, usage: -600, api: -300, faq: 85 });
    deliver([entryFor("faq", true)]);
    expect(currentIds()).toEqual(["link-faq"]);

    // Removing a link drops its section from the observation set.
    link("faq").remove();
    await tick();
    expect(observers.at(-1)?.observed.map((el) => el.id)).toEqual(["intro", "usage", "api"]);
  });

  it("keeps two instances independent", async () => {
    await start(`
      <nav id="first" aria-label="First" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80">
        <a id="link-a" href="#a" data-stimeo--scrollspy-target="link">A</a>
        <a id="link-b" href="#b" data-stimeo--scrollspy-target="link">B</a>
      </nav>
      <nav id="second" aria-label="Second" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80">
        <a id="link-c" href="#c" data-stimeo--scrollspy-target="link">C</a>
        <a id="link-d" href="#d" data-stimeo--scrollspy-target="link">D</a>
      </nav>
      <section id="a">A</section>
      <section id="b">B</section>
      <section id="c">C</section>
      <section id="d">D</section>`);

    expect(observers).toHaveLength(2);
    layoutSections({ a: 85, b: 600, c: 600, d: 85 });
    deliver([entryFor("a", true), entryFor("b", true)], 0);
    deliver([entryFor("c", true), entryFor("d", true)], 1);

    expect(currentIds()).toEqual(["link-a", "link-d"]);
  });

  // --- scrollTo action --------------------------------------------------------

  it("scrolls a nested root container to the section, honoring the offset", async () => {
    await start(`
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80"
           data-stimeo--scrollspy-root-selector-value=".content">
        <a id="link-usage" href="#usage" data-stimeo--scrollspy-target="link"
           data-action="click->stimeo--scrollspy#scrollTo">Usage</a>
      </nav>
      <div class="content">
        <section id="usage">Usage</section>
      </div>`);

    const content = requireElement(".content");
    layout(content, 200, 800, 400);
    content.scrollTop = 100;
    const containerScrollTo = vi.fn();
    content.scrollTo = containerScrollTo as unknown as HTMLElement["scrollTo"];
    layoutSections({ usage: 500 });

    const event = clickLink("usage");

    // scrollTop (100) + (target 500 - container 200) - offset 80 = 320.
    expect(containerScrollTo).toHaveBeenCalledWith({ top: 320, behavior: "smooth" });
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("scrolls the window when no root container is configured", async () => {
    await start();
    setScrollY(100);
    layoutSections({ usage: 500 });

    clickLink("usage");

    // scrollY (100) + target top (500) - offset (80) = 520.
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 520, behavior: "smooth" });
  });

  it("jumps instantly when reduced motion is requested", async () => {
    reducedMotion = true;
    await start();
    layoutSections({ usage: 500 });

    clickLink("usage");

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 420, behavior: "instant" });
  });

  it("does nothing when the link anchors a section that is not in the document", async () => {
    await start(`
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy">
        <a id="link-missing" href="#missing" data-stimeo--scrollspy-target="link"
           data-action="click->stimeo--scrollspy#scrollTo">Missing</a>
        <a id="link-empty" href="#" data-stimeo--scrollspy-target="link"
           data-action="click->stimeo--scrollspy#scrollTo">Top</a>
      </nav>`);

    // The fragment resolves to nothing: the jump is still swallowed (the page
    // must not lurch to a dangling anchor), but nothing scrolls.
    expect(clickLink("missing").defaultPrevented).toBe(true);
    expect(window.scrollTo).not.toHaveBeenCalled();
    // And it is a real no-op, not a throw Stimulus quietly absorbed: measuring
    // the element that is not there raises inside the action handler, which
    // leaves `scrollTo` uncalled for the wrong reason.
    expect(stimulusErrors).toEqual([]);

    // A link that anchors no id at all is left entirely to the browser.
    expect(clickLink("empty").defaultPrevented).toBe(false);
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("leaves focus alone unless focusSection is enabled", async () => {
    await start();
    layoutSections({ usage: 500 });

    clickLink("usage");

    expect(section("usage").hasAttribute("tabindex")).toBe(false);
    expect(document.activeElement).not.toBe(section("usage"));
  });

  /** `focusSection` opted in, with whatever `tabindex` the consumer wrote. */
  const focusSectionFixture = (sectionAttributes = ""): string => `
      <nav id="scrollspy" aria-label="On this page" data-controller="stimeo--scrollspy"
           data-stimeo--scrollspy-offset-value="80"
           data-stimeo--scrollspy-focus-section-value="true">
        <a id="link-usage" href="#usage" data-stimeo--scrollspy-target="link"
           data-action="click->stimeo--scrollspy#scrollTo">Usage</a>
      </nav>
      <section id="usage" ${sectionAttributes}>Usage</section>
      <section id="api">API</section>`;

  it("establishes a tabindex on the destination and moves focus there", async () => {
    // The fixture deliberately ships **no** `tabindex`: reading one back from a
    // fixture that already carried it would assert the fixture rather than the
    // controller, and leave the establishing branch unexecuted.
    await start(focusSectionFixture());
    layoutSections({ usage: 500 });

    clickLink("usage");

    expect(section("usage").getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(section("usage"));
  });

  it("never rewrites a tabindex the consumer already chose", async () => {
    // A section the author made tabbable on purpose must stay tabbable; the
    // controller establishes a value, it does not own the attribute.
    await start(focusSectionFixture(`tabindex="0"`));
    layoutSections({ usage: 500 });

    clickLink("usage");

    expect(section("usage").getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(section("usage"));
  });

  it("focuses the destination without cancelling the scroll it just started", async () => {
    await start(focusSectionFixture());
    layoutSections({ usage: 500 });
    const focus = vi.spyOn(section("usage"), "focus");

    clickLink("usage");

    // Focusing scrolls the element into view by default, which would cut the
    // smooth scroll started a statement earlier short.
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  // --- Machine-detectable a11y ------------------------------------------------

  it("has no machine-detectable a11y violations", async () => {
    await start();
    await expectNoA11yViolations(requireElement("#scrollspy"));

    // The published state must stay clean too, not just the initial markup.
    layoutSections({ intro: 85, usage: 600, api: 900 });
    deliver([entryFor("intro", true), entryFor("usage", true)]);
    expect(currentIds()).toEqual(["link-intro"]);
    await expectNoA11yViolations(requireElement("#scrollspy"));
  });

  // --- Speech-order regression ------------------------------------------------

  it("announces the active link's current-location state in document order", async () => {
    await start();
    const nav = requireElement("#scrollspy");

    // No section is active yet: links announce as plain links, in order.
    expect(await captureSpeech({ container: nav, steps: 4 })).toEqual([
      "navigation, On this page",
      "link, Intro",
      "link, Usage",
      "link, API",
      "end of navigation, On this page",
    ]);

    // Activating the intro section flips only its link to "current location".
    layoutSections({ intro: 90, usage: 250, api: 600 });
    deliver([entryFor("intro", true), entryFor("usage", true)]);

    expect(await captureSpeech({ container: nav, steps: 4 })).toEqual([
      "navigation, On this page",
      "link, Intro, current location",
      "link, Usage",
      "link, API",
      "end of navigation, On this page",
    ]);
  });

  // --- Disconnect teardown regression ----------------------------------------

  it("cleans up observers upon disconnection", async () => {
    await start();
    const controller = application?.getControllerForElementAndIdentifier(
      requireElement("#scrollspy"),
      "stimeo--scrollspy",
    ) as ScrollspyController;

    expect(observers[0]?.disconnectCount).toBe(0);

    // Directly invoke disconnect to avoid flaky async MutationObserver lifecycle in happy-dom
    controller.disconnect();

    expect(observers[0]?.disconnectCount).toBe(1);
  });

  it("releases the observer and the scrollTo binding on unload", async () => {
    await start();
    layoutSections({ usage: 500 });
    expect(clickLink("usage").defaultPrevented).toBe(true);

    application?.unload("stimeo--scrollspy");
    await tick();

    expect(observers[0]?.disconnectCount).toBe(1);
    // The Stimulus-managed action binding is gone, so the anchor behaves like
    // a plain fragment link again.
    expect(clickLink("usage").defaultPrevented).toBe(false);
  });

  it("ignores a late intersection callback delivered after teardown", async () => {
    await start();
    const changeHandler = vi.fn();
    requireElement("#scrollspy").addEventListener("stimeo--scrollspy:change", changeHandler);
    const controller = application?.getControllerForElementAndIdentifier(
      requireElement("#scrollspy"),
      "stimeo--scrollspy",
    ) as ScrollspyController;

    controller.disconnect();
    expect(observers[0]?.disconnectCount).toBe(1);

    // A batch the browser queued before teardown must not resurrect
    // `aria-current` on links Turbo may have cached. Two layers refuse it: the
    // watcher's active/identity guard (which this path exercises) and the
    // controller's own connected flag behind it.
    layoutSections({ intro: 90, usage: 250, api: 600 });
    deliver([entryFor("intro", true)]);

    expect(currentIds()).toEqual([]);
    expect(changeHandler).not.toHaveBeenCalled();
  });
});
