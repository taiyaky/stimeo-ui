import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StickyObserverController } from "../src/controllers/sticky_observer_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link StickyObserverController}: directional stuck
 * detection, ordered observer batches, dynamic Stimulus lifecycle changes, the
 * initial snapshot contract, event detail, and Turbo-safe teardown.
 *
 * `IntersectionObserver` is mocked because happy-dom has no layout engine. Each
 * entry still carries real directional geometry so the test can distinguish a
 * sentinel above the root from one that has not reached the root yet.
 */

interface ObserverRecord {
  callback: (entries: IntersectionObserverEntry[]) => void;
  options: IntersectionObserverInit | undefined;
  observed: Element[];
  disconnectCount: number;
}

describe("StickyObserverController", () => {
  let application: Application | undefined;
  let observers: ObserverRecord[];

  beforeEach(() => {
    observers = [];

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
  });

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  const fixture = (targets = true, values = true): string => `
    <div id="scroll-root">
      <div data-controller="stimeo--sticky-observer"
           ${values ? 'data-stimeo--sticky-observer-offset-value="16" data-stimeo--sticky-observer-root-selector-value="#scroll-root"' : ""}>
        ${
          targets
            ? `<div data-stimeo--sticky-observer-target="sentinel"
                    aria-hidden="true"></div>
               <header data-stimeo--sticky-observer-target="element">Site heading</header>`
            : ""
        }
        <main>content</main>
      </div>
    </div>`;

  const start = async (markup = fixture()): Promise<void> => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--sticky-observer", StickyObserverController);
    await tick();
  };

  const requireElement = <T extends Element>(selector: string): T => {
    const found = document.querySelector<T>(selector);
    if (!found) throw new Error(`Fixture element missing: ${selector}`);
    return found;
  };

  const root = (): HTMLElement =>
    requireElement<HTMLElement>("[data-controller='stimeo--sticky-observer']");

  const sentinel = (): HTMLElement =>
    requireElement<HTMLElement>("[data-stimeo--sticky-observer-target='sentinel']");

  const element = (): HTMLElement =>
    requireElement<HTMLElement>("[data-stimeo--sticky-observer-target='element']");

  const controller = (): StickyObserverController => {
    const instance = application?.getControllerForElementAndIdentifier(
      root(),
      "stimeo--sticky-observer",
    );
    if (!(instance instanceof StickyObserverController)) {
      throw new Error("Sticky observer controller missing");
    }
    return instance;
  };

  const currentObserver = (): ObserverRecord => {
    const observer = observers[observers.length - 1];
    if (!observer) throw new Error("IntersectionObserver was not created");
    return observer;
  };

  const entry = ({
    isIntersecting,
    bottom,
    rootTop = 0,
    target = sentinel(),
  }: {
    isIntersecting: boolean;
    bottom: number;
    rootTop?: number | null;
    target?: Element;
  }): IntersectionObserverEntry => ({
    boundingClientRect: new DOMRect(0, bottom - 1, 1, 1),
    intersectionRatio: isIntersecting ? 1 : 0,
    intersectionRect: isIntersecting ? new DOMRect(0, bottom - 1, 1, 1) : new DOMRect(),
    isIntersecting,
    rootBounds: rootTop === null ? null : new DOMRect(0, rootTop, 100, 100),
    target,
    time: 0,
  });

  it("observes the sentinel with the configured root, offset, and threshold", async () => {
    await start();

    expect(currentObserver().observed).toEqual([sentinel()]);
    expect(currentObserver().options).toMatchObject({
      root: requireElement("#scroll-root"),
      rootMargin: "-16px 0px 0px 0px",
      threshold: [0],
    });
  });

  it("uses the viewport and a numeric zero margin for default Values", async () => {
    await start(fixture(true, false));

    expect(currentObserver().options).toMatchObject({
      root: null,
      rootMargin: "0px 0px 0px 0px",
      threshold: [0],
    });
  });

  it("marks stuck only after the sentinel passes the root's top edge", async () => {
    await start();

    currentObserver().callback([entry({ isIntersecting: false, bottom: 140, rootTop: 40 })]);
    expect(element().getAttribute("data-stuck")).toBe("false");

    currentObserver().callback([entry({ isIntersecting: false, bottom: 40, rootTop: 40 })]);
    expect(element().getAttribute("data-stuck")).toBe("true");

    currentObserver().callback([entry({ isIntersecting: true, bottom: 41, rootTop: 40 })]);
    expect(element().getAttribute("data-stuck")).toBe("false");
  });

  it("falls back to the viewport origin when rootBounds is unavailable", async () => {
    await start();

    currentObserver().callback([entry({ isIntersecting: false, bottom: 0, rootTop: null })]);
    expect(element().getAttribute("data-stuck")).toBe("true");
  });

  it("never marks an unrendered sentinel as stuck (empty rect)", async () => {
    await start();

    // A sentinel with no layout box (hidden tab panel, collapsed section, an
    // undisplayed Turbo Frame) is reported at the origin with a 0x0 rect: its
    // `bottom` of 0 satisfies `bottom <= rootTop` for a viewport-origin root and
    // would invent a stuck state for an element that never scrolled anywhere.
    currentObserver().callback([
      {
        boundingClientRect: new DOMRect(),
        intersectionRatio: 0,
        intersectionRect: new DOMRect(),
        isIntersecting: false,
        rootBounds: new DOMRect(0, 0, 100, 100),
        target: sentinel(),
        time: 0,
      },
    ]);
    expect(element().getAttribute("data-stuck")).toBe("false");

    // The same coordinates with a real 1px rect still resolve to stuck, so this
    // case fails if the empty-rect guard is dropped.
    currentObserver().callback([entry({ isIntersecting: false, bottom: 0, rootTop: 0 })]);
    expect(element().getAttribute("data-stuck")).toBe("true");
  });

  it("stops mid-batch when a change listener disconnects the controller", async () => {
    await start();
    const changes: boolean[] = [];
    root().addEventListener("stimeo--sticky-observer:change", (event) => {
      changes.push((event as CustomEvent<{ stuck: boolean }>).detail.stuck);
      // A consumer that swaps the region on the first notification (a Turbo
      // pattern) tears the controller down while the batch is still being
      // processed; the remaining entries must not touch the detached element.
      controller().disconnect();
    });

    currentObserver().callback([
      entry({ isIntersecting: false, bottom: 40, rootTop: 40 }),
      entry({ isIntersecting: false, bottom: 140, rootTop: 40 }),
    ]);

    expect(changes).toEqual([true]);
    expect(element().getAttribute("data-stuck")).toBe("true");
  });

  it("processes every entry in a batch and publishes the final snapshot", async () => {
    await start();
    const changes: boolean[] = [];
    root().addEventListener("stimeo--sticky-observer:change", (event) => {
      changes.push((event as CustomEvent<{ stuck: boolean }>).detail.stuck);
    });

    currentObserver().callback([
      entry({ isIntersecting: true, bottom: 41, rootTop: 40 }),
      entry({ isIntersecting: false, bottom: 40, rootTop: 40 }),
      entry({ isIntersecting: false, bottom: 140, rootTop: 40 }),
    ]);
    currentObserver().callback([]);

    expect(changes).toEqual([false, true, false]);
    expect(element().getAttribute("data-stuck")).toBe("false");
  });

  it("dispatches the initial snapshot once and then only state transitions", async () => {
    await start();
    const changes: boolean[] = [];
    root().addEventListener("stimeo--sticky-observer:change", (event) => {
      changes.push((event as CustomEvent<{ stuck: boolean }>).detail.stuck);
    });

    const visible = entry({ isIntersecting: true, bottom: 41, rootTop: 40 });
    const above = entry({ isIntersecting: false, bottom: 40, rootTop: 40 });
    currentObserver().callback([visible]);
    currentObserver().callback([visible]);
    currentObserver().callback([above]);
    currentObserver().callback([above]);

    expect(changes).toEqual([false, true]);
  });

  it("publishes a fresh initial snapshot after a Turbo-style reconnect", async () => {
    await start();
    const changes: boolean[] = [];
    root().addEventListener("stimeo--sticky-observer:change", (event) => {
      changes.push((event as CustomEvent<{ stuck: boolean }>).detail.stuck);
    });
    const instance = controller();

    currentObserver().callback([entry({ isIntersecting: true, bottom: 41, rootTop: 40 })]);
    instance.disconnect();
    instance.connect();
    currentObserver().callback([entry({ isIntersecting: true, bottom: 41, rootTop: 40 })]);

    expect(changes).toEqual([false, false]);
  });

  it("starts, transfers, and stops observation as the sentinel target changes", async () => {
    await start(fixture(false));
    expect(observers).toHaveLength(0);

    const first = document.createElement("div");
    first.setAttribute("data-stimeo--sticky-observer-target", "sentinel");
    root().prepend(first);
    await tick();
    expect(currentObserver().observed).toEqual([first]);

    const second = document.createElement("div");
    second.setAttribute("data-stimeo--sticky-observer-target", "sentinel");
    first.replaceWith(second);
    await tick();
    expect(currentObserver().observed).toEqual([second]);
    expect(observers[0]?.disconnectCount).toBe(1);

    second.remove();
    await tick();
    expect(currentObserver().disconnectCount).toBe(1);
  });

  it("publishes without an element target and reflects the state when one appears", async () => {
    await start(`
      <div data-controller="stimeo--sticky-observer">
        <div data-stimeo--sticky-observer-target="sentinel"></div>
      </div>`);
    const changes: boolean[] = [];
    root().addEventListener("stimeo--sticky-observer:change", (event) => {
      changes.push((event as CustomEvent<{ stuck: boolean }>).detail.stuck);
    });

    currentObserver().callback([entry({ isIntersecting: false, bottom: 0, rootTop: 0 })]);
    expect(changes).toEqual([true]);

    const lateElement = document.createElement("header");
    lateElement.setAttribute("data-stimeo--sticky-observer-target", "element");
    root().append(lateElement);
    await tick();
    expect(lateElement.getAttribute("data-stuck")).toBe("true");
  });

  it("rebuilds observation for runtime Values and normalizes offset numerically", async () => {
    await start();
    const alternateRoot = document.createElement("div");
    alternateRoot.id = "alternate-root";
    document.body.append(alternateRoot);
    const instance = controller();

    instance.offsetValue = -4;
    instance.offsetValueChanged();
    expect(currentObserver().options?.rootMargin).toBe("4px 0px 0px 0px");

    instance.offsetValue = Number.NaN;
    instance.offsetValueChanged();
    expect(currentObserver().options?.rootMargin).toBe("0px 0px 0px 0px");

    instance.rootSelectorValue = "#alternate-root";
    instance.rootSelectorValueChanged();
    expect(currentObserver().options?.root).toBe(alternateRoot);
  });

  it("does not restart observation when the primary sentinel is unchanged", async () => {
    await start();
    expect(observers).toHaveLength(1);

    // A morph that appends another sentinel (or drops a non-primary one) fires the
    // target callbacks, but `sentinelTarget` still resolves to the same node — the
    // dedupe guard must keep the live observer instead of stop/start churning it,
    // which would also replay an initial snapshot on every morph.
    const extra = document.createElement("div");
    extra.setAttribute("data-stimeo--sticky-observer-target", "sentinel");
    root().appendChild(extra);
    await tick();
    expect(observers).toHaveLength(1);

    extra.remove();
    await tick();
    expect(observers).toHaveLength(1);
    expect(currentObserver().observed).toEqual([sentinel()]);
  });

  it("keeps two instances independent, including after one disconnects", async () => {
    await start(`
      <div id="first-root">
        <div data-controller="stimeo--sticky-observer"
             data-stimeo--sticky-observer-root-selector-value="#first-root">
          <div id="first-sentinel" data-stimeo--sticky-observer-target="sentinel"></div>
          <header id="first-element" data-stimeo--sticky-observer-target="element">One</header>
        </div>
      </div>
      <div id="second-root">
        <div data-controller="stimeo--sticky-observer"
             data-stimeo--sticky-observer-root-selector-value="#second-root">
          <div id="second-sentinel" data-stimeo--sticky-observer-target="sentinel"></div>
          <header id="second-element" data-stimeo--sticky-observer-target="element">Two</header>
        </div>
      </div>`);

    const [first, second] = observers;
    if (!first || !second) throw new Error("Expected one observer per instance");
    expect(first.observed).toEqual([requireElement("#first-sentinel")]);
    expect(second.observed).toEqual([requireElement("#second-sentinel")]);

    // Driving one instance leaves the other's hook untouched.
    first.callback([
      entry({
        isIntersecting: false,
        bottom: 40,
        rootTop: 40,
        target: requireElement("#first-sentinel"),
      }),
    ]);
    expect(requireElement("#first-element").getAttribute("data-stuck")).toBe("true");
    // The second instance has had no delivery yet, so its hook is still absent —
    // one instance's batch must not write through to the other's element.
    expect(requireElement("#second-element").getAttribute("data-stuck")).toBeNull();

    // Tearing down the first instance must not disturb the second one's observation.
    const firstController = application?.getControllerForElementAndIdentifier(
      requireElement("#first-root [data-controller='stimeo--sticky-observer']"),
      "stimeo--sticky-observer",
    );
    if (!(firstController instanceof StickyObserverController)) {
      throw new Error("First sticky observer controller missing");
    }
    firstController.disconnect();
    expect(first.disconnectCount).toBe(1);
    expect(second.disconnectCount).toBe(0);

    second.callback([
      entry({
        isIntersecting: false,
        bottom: 40,
        rootTop: 40,
        target: requireElement("#second-sentinel"),
      }),
    ]);
    expect(requireElement("#second-element").getAttribute("data-stuck")).toBe("true");
  });

  it("disconnects the observer and ignores its late callbacks", async () => {
    await start();
    const observed = currentObserver();

    controller().disconnect();
    expect(observed.disconnectCount).toBe(1);
    observed.callback([entry({ isIntersecting: false, bottom: 0 })]);

    expect(element().hasAttribute("data-stuck")).toBe(false);
  });

  it("has no machine-detectable a11y violations", async () => {
    await start();
    await expectNoA11yViolations(root());
  });

  it("keeps the decorative sentinel silent and the heading announceable when stuck", async () => {
    await start();
    const before = await captureSpeech({ container: root(), steps: 3 });
    expect(before).toEqual(["banner", "Site heading", "end of banner", "main"]);

    currentObserver().callback([entry({ isIntersecting: false, bottom: 0, rootTop: 0 })]);
    const after = await captureSpeech({ container: root(), steps: 3 });
    expect(after).toEqual(before);
  });
});
