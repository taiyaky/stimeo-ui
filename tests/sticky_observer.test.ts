import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StickyObserverController } from "../src/controllers/sticky_observer_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link StickyObserverController}: the sentinel
 * intersection → `data-stuck` sync, the `change` event on transitions, the
 * `rootMargin` derived from `offset`, and observer teardown on disconnect.
 *
 * `IntersectionObserver` is mocked so sentinel intersection can be driven
 * synchronously (happy-dom has no layout/scroll).
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("StickyObserverController", () => {
  let application: Application;
  type Entry = { isIntersecting: boolean };
  let observerCallback: ((entries: Entry[]) => void) | null = null;
  let observerOptions: IntersectionObserverInit | undefined;
  const observeMock = vi.fn();
  const disconnectMock = vi.fn();

  beforeEach(async () => {
    observerCallback = null;
    observerOptions = undefined;
    observeMock.mockClear();
    disconnectMock.mockClear();

    const IntersectionObserverMock = class {
      constructor(callback: (entries: Entry[]) => void, options?: IntersectionObserverInit) {
        observerCallback = callback;
        observerOptions = options;
      }
      observe = observeMock;
      unobserve = vi.fn();
      disconnect = disconnectMock;
    };
    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);

    document.body.innerHTML = `
      <div data-controller="stimeo--sticky-observer"
           data-stimeo--sticky-observer-offset-value="16">
        <div data-stimeo--sticky-observer-target="sentinel" aria-hidden="true"
             style="height: 1px;"></div>
        <header data-stimeo--sticky-observer-target="element"
                style="position: sticky; top: 16px;">Site heading</header>
        <main>content</main>
      </div>`;

    application = Application.start();
    application.register("stimeo--sticky-observer", StickyObserverController);
    await delay(20);
  });

  afterEach(async () => {
    application.stop();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    await delay(20);
  });

  const root = () =>
    document.querySelector<HTMLElement>(
      "[data-controller='stimeo--sticky-observer']",
    ) as HTMLElement;
  const element = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--sticky-observer-target='element']",
    ) as HTMLElement;

  it("observes the sentinel with a top rootMargin derived from offset", async () => {
    expect(observeMock).toHaveBeenCalledOnce();
    expect(observerOptions?.rootMargin).toBe("-16px 0px 0px 0px");
  });

  it("sets data-stuck=true when the sentinel leaves the top", async () => {
    observerCallback?.([{ isIntersecting: false }]);
    await tick();
    expect(element().getAttribute("data-stuck")).toBe("true");
  });

  it("sets data-stuck=false when the sentinel is back in view", async () => {
    observerCallback?.([{ isIntersecting: false }]);
    observerCallback?.([{ isIntersecting: true }]);
    await tick();
    expect(element().getAttribute("data-stuck")).toBe("false");
  });

  it("dispatches change only on stuck transitions", async () => {
    const changes: boolean[] = [];
    root().addEventListener("stimeo--sticky-observer:change", (event) => {
      changes.push((event as CustomEvent<{ stuck: boolean }>).detail.stuck);
    });
    observerCallback?.([{ isIntersecting: false }]); // stuck
    observerCallback?.([{ isIntersecting: false }]); // no change → no event
    observerCallback?.([{ isIntersecting: true }]); // unstuck
    await tick();
    expect(changes).toEqual([true, false]);
  });

  it("disconnects the observer and ignores late callbacks after teardown", async () => {
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--sticky-observer",
    ) as StickyObserverController;
    controller.disconnect();
    expect(disconnectMock).toHaveBeenCalledOnce();

    observerCallback?.([{ isIntersecting: false }]);
    await tick();
    expect(element().hasAttribute("data-stuck")).toBe(false);
  });

  it("has no machine-detectable a11y violations", async () => {
    await expectNoA11yViolations(root());
  });

  // --- Layer ③ speech-order regression ---------------------------------------

  it("keeps the decorative sentinel silent and the heading announceable when stuck", async () => {
    const before = await captureSpeech({ container: root(), steps: 3 });
    // Freeze the whole ordered array (not a name-only `toContain`): the aria-hidden
    // sentinel stays silent (absent here) and the heading announces inside the banner.
    expect(before).toEqual(["banner", "Site heading", "end of banner", "main"]);
    // Going stuck only flips a data-* hook — it must not alter the announcement.
    observerCallback?.([{ isIntersecting: false }]);
    await tick();
    const after = await captureSpeech({ container: root(), steps: 3 });
    expect(after).toEqual(before);
  });
});
