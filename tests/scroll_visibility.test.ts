import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollVisibilityController } from "../src/controllers/scroll_visibility_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link ScrollVisibilityController}: offset-threshold and
 * direction modes, the `hidden`/`data-state` reflection, the `change` event,
 * `toTop` (scroll + focus move), and scroll-listener teardown.
 *
 * `window.scrollY` is stubbed and `scroll` dispatched to drive the rAF-coalesced
 * measurement; `window.scrollTo` is mocked since happy-dom has no real scrolling.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("ScrollVisibilityController", () => {
  let application: Application;

  beforeEach(() => {
    vi.stubGlobal("scrollTo", vi.fn());
    setScrollY(0);
  });

  const start = async (html: string) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--scroll-visibility", ScrollVisibilityController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  const setScrollY = (y: number) => {
    Object.defineProperty(window, "scrollY", { configurable: true, value: y });
  };

  /** Updates the simulated scroll offset and lets the rAF-coalesced handler run. */
  const scrollToY = async (y: number) => {
    setScrollY(y);
    window.dispatchEvent(new Event("scroll"));
    await settle();
  };

  const root = () =>
    document.querySelector<HTMLElement>(
      "[data-controller='stimeo--scroll-visibility']",
    ) as HTMLElement;
  const element = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--scroll-visibility-target='element']",
    ) as HTMLElement;

  const offsetMarkup = `
    <div data-controller="stimeo--scroll-visibility"
         data-stimeo--scroll-visibility-offset-value="400"
         data-stimeo--scroll-visibility-mode-value="offset">
      <button type="button" hidden
              data-stimeo--scroll-visibility-target="element"
              data-action="stimeo--scroll-visibility#toTop">Back to top</button>
    </div>`;

  it("starts hidden below the offset", async () => {
    await start(offsetMarkup);
    expect(element().hidden).toBe(true);
    expect(root().getAttribute("data-state")).toBe("hidden");
  });

  it("reveals the element once scrolled past the offset", async () => {
    await start(offsetMarkup);
    const changes: boolean[] = [];
    root().addEventListener("stimeo--scroll-visibility:change", (event) => {
      changes.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
    });
    await scrollToY(500);
    expect(element().hidden).toBe(false);
    expect(root().getAttribute("data-state")).toBe("visible");
    expect(changes).toContain(true);
  });

  it("hides again when scrolling back above the offset", async () => {
    await start(offsetMarkup);
    await scrollToY(500);
    expect(element().hidden).toBe(false);
    await scrollToY(100);
    expect(element().hidden).toBe(true);
    expect(root().getAttribute("data-state")).toBe("hidden");
  });

  it("tracks scroll direction in direction mode", async () => {
    await start(`
      <div data-controller="stimeo--scroll-visibility"
           data-stimeo--scroll-visibility-offset-value="100"
           data-stimeo--scroll-visibility-mode-value="direction">
        <header data-stimeo--scroll-visibility-target="element">Site header</header>
      </div>`);
    await scrollToY(600); // scrolled down → hide
    expect(element().hidden).toBe(true);
    await scrollToY(300); // scrolled up → show
    expect(element().hidden).toBe(false);
    await scrollToY(50); // near the top → always shown
    expect(element().hidden).toBe(false);
  });

  it("scrolls to top and moves focus to the focus target on toTop", async () => {
    await start(`
      <div data-controller="stimeo--scroll-visibility"
           data-stimeo--scroll-visibility-offset-value="400"
           data-stimeo--scroll-visibility-focus-selector-value="#main">
        <button type="button"
                data-stimeo--scroll-visibility-target="element"
                data-action="stimeo--scroll-visibility#toTop">Top</button>
      </div>
      <main id="main">Content</main>`);
    element().click();
    expect(window.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
    const main = document.getElementById("main") as HTMLElement;
    expect(main.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(main);
  });

  it("stops reacting to scroll after disconnect", async () => {
    await start(offsetMarkup);
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--scroll-visibility",
    );
    controller?.disconnect();
    await scrollToY(800);
    expect(element().hidden).toBe(true); // never revealed
  });

  // --- Scroll-container root (page does not scroll on the window) -------------

  const containerMarkup = `
    <div id="scroller"
         data-controller="stimeo--scroll-visibility"
         data-stimeo--scroll-visibility-root-value="#scroller"
         data-stimeo--scroll-visibility-offset-value="400"
         data-stimeo--scroll-visibility-mode-value="offset">
      <button type="button" hidden
              data-stimeo--scroll-visibility-target="element"
              data-action="stimeo--scroll-visibility#toTop">Back to top</button>
    </div>`;

  const scroller = () => document.getElementById("scroller") as HTMLElement;

  /** Scrolls the container element (not the window) and lets the handler run. */
  const scrollContainerTo = async (y: number) => {
    const el = scroller();
    el.scrollTop = y;
    el.dispatchEvent(new Event("scroll"));
    await settle();
  };

  it("reveals the element from the container's scroll, not the window", async () => {
    await start(containerMarkup);
    // The window never scrolls in a fixed-shell layout: it must be ignored.
    await scrollToY(800);
    expect(element().hidden).toBe(true);
    // Scrolling the container past the offset reveals the control.
    await scrollContainerTo(500);
    expect(element().hidden).toBe(false);
    expect(scroller().getAttribute("data-state")).toBe("visible");
  });

  it("scrolls the container (not the window) to the top on toTop", async () => {
    await start(containerMarkup);
    const containerScrollTo = vi.fn();
    scroller().scrollTo = containerScrollTo as unknown as HTMLElement["scrollTo"];
    await scrollContainerTo(500);
    element().click();
    expect(containerScrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("falls back to the window when the root selector matches nothing", async () => {
    await start(`
      <div data-controller="stimeo--scroll-visibility"
           data-stimeo--scroll-visibility-root-value="#missing"
           data-stimeo--scroll-visibility-offset-value="400"
           data-stimeo--scroll-visibility-mode-value="offset">
        <button type="button" hidden
                data-stimeo--scroll-visibility-target="element"
                data-action="stimeo--scroll-visibility#toTop">Back to top</button>
      </div>`);
    await scrollToY(500);
    expect(element().hidden).toBe(false);
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(offsetMarkup);
    await scrollToY(500);
    await expectNoA11yViolations(root());
  });

  // --- Layer ③ speech-order regression ---------------------------------------

  it("removes the control from the announcement order while hidden, and restores it when shown", async () => {
    await start(offsetMarkup);
    // Freeze the whole ordered array (not a name-only `not.toContain`): hidden below
    // the offset the button is fully out of the accessibility tree, so nothing announces.
    const hidden = await captureSpeech({ container: root(), steps: 1 });
    expect(hidden).toEqual([]);
    // Scrolled past the offset: the button re-enters the order and announces by name.
    await scrollToY(500);
    const shown = await captureSpeech({ container: root(), steps: 1 });
    expect(shown).toEqual(["button, Back to top", "button, Back to top"]);
  });
});
