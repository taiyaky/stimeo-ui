import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollVisibilityController } from "../src/controllers/scroll_visibility_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { delay, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ScrollVisibilityController}: offset-threshold and
 * direction modes, the `hidden`/`data-state` reflection, the `change` event,
 * `toTop` (scroll + focus move), and scroll-listener teardown.
 *
 * `window.scrollY` is stubbed and `scroll` dispatched to drive the rAF-coalesced
 * measurement; `window.scrollTo` is mocked since happy-dom has no real scrolling.
 */

const settle = () => delay(30);

describe("ScrollVisibilityController", () => {
  let application: Application;
  let reducedMotion = false;

  beforeEach(() => {
    reducedMotion = false;
    vi.stubGlobal("scrollTo", vi.fn());
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion") && reducedMotion,
    }));
    setScrollY(0);
  });

  const start = async (html: string) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--scroll-visibility", ScrollVisibilityController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
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
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    const main = document.getElementById("main") as HTMLElement;
    expect(main.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(main);
  });

  it("removes a focus tabindex it added when the controller disconnects", async () => {
    await start(`
      <div data-controller="stimeo--scroll-visibility"
           data-stimeo--scroll-visibility-focus-selector-value="#main">
        <button type="button" data-stimeo--scroll-visibility-target="element"
                data-action="stimeo--scroll-visibility#toTop">Top</button>
      </div>
      <main id="main">Content</main>`);
    element().click();
    const main = document.getElementById("main") as HTMLElement;
    expect(main.getAttribute("tabindex")).toBe("-1");

    application.unload("stimeo--scroll-visibility");
    expect(main.hasAttribute("tabindex")).toBe(false);
  });

  it("preserves an authored focus tabindex when the controller disconnects", async () => {
    await start(`
      <div data-controller="stimeo--scroll-visibility"
           data-stimeo--scroll-visibility-focus-selector-value="#main">
        <button type="button" data-stimeo--scroll-visibility-target="element"
                data-action="stimeo--scroll-visibility#toTop">Top</button>
      </div>
      <main id="main" tabindex="-1">Content</main>`);
    element().click();
    const main = document.getElementById("main") as HTMLElement;
    expect(document.activeElement).toBe(main);

    application.unload("stimeo--scroll-visibility");
    expect(main.getAttribute("tabindex")).toBe("-1");
  });

  it("preserves a focus tabindex changed after the controller adds it", async () => {
    await start(`
      <div data-controller="stimeo--scroll-visibility"
           data-stimeo--scroll-visibility-focus-selector-value="#main">
        <button type="button" data-stimeo--scroll-visibility-target="element"
                data-action="stimeo--scroll-visibility#toTop">Top</button>
      </div>
      <main id="main">Content</main>`);
    element().click();
    const main = document.getElementById("main") as HTMLElement;
    expect(main.getAttribute("tabindex")).toBe("-1");
    main.setAttribute("tabindex", "0");

    application.unload("stimeo--scroll-visibility");
    expect(main.getAttribute("tabindex")).toBe("0");
  });

  it("scrolls instantly when reduced motion is requested", async () => {
    reducedMotion = true;
    await start(offsetMarkup);
    element().click();
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "instant" });
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

  // --- Event contract ---------------------------------------------------------

  it("does not announce anything when connecting alone", async () => {
    const changes: boolean[] = [];
    // The controller dispatches on its root element, which doesn't exist until
    // mount; listen on document (and clean up) to catch any connect-time event.
    const onChange = (event: Event) => {
      changes.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
    };
    document.addEventListener("stimeo--scroll-visibility:change", onChange);
    try {
      await start(offsetMarkup);
      // Connecting reflects the state the markup already carries; it is not a
      // transition, so a Turbo restore must not replay it.
      expect(changes).toEqual([]);
      expect(root().getAttribute("data-state")).toBe("hidden");
    } finally {
      document.removeEventListener("stimeo--scroll-visibility:change", onChange);
    }
  });

  it("announces a transition once, not on every scroll that keeps the state", async () => {
    await start(offsetMarkup);
    const changes: boolean[] = [];
    root().addEventListener("stimeo--scroll-visibility:change", (event) => {
      changes.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
    });
    await scrollToY(500);
    await scrollToY(600);
    await scrollToY(700);
    expect(changes).toEqual([true]);
    await scrollToY(100);
    expect(changes).toEqual([true, false]);
  });

  it("stops the coalesced measurement so a burst cannot outlive disconnect", async () => {
    await start(offsetMarkup);
    const changes: boolean[] = [];
    root().addEventListener("stimeo--scroll-visibility:change", (event) => {
      changes.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
    });
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--scroll-visibility",
    );
    // Two events in one burst must coalesce into a single pending frame, so the
    // one cancel in disconnect is enough to leave nothing running.
    setScrollY(800);
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("scroll"));
    controller?.disconnect();
    await settle();
    expect(element().hidden).toBe(true);
    expect(changes).toEqual([]);
  });

  // --- Value declarations ------------------------------------------------------

  it("falls back to the documented defaults when no value is declared", async () => {
    await start(`
      <div data-controller="stimeo--scroll-visibility">
        <button type="button" hidden
                data-stimeo--scroll-visibility-target="element"
                data-action="stimeo--scroll-visibility#toTop">Back to top</button>
      </div>`);
    // offset defaults to 400 …
    await scrollToY(399);
    expect(element().hidden).toBe(true);
    await scrollToY(401);
    expect(element().hidden).toBe(false);
    // … and mode defaults to the amount threshold, not the direction one, so
    // scrolling further down keeps it revealed.
    await scrollToY(900);
    expect(element().hidden).toBe(false);
  });

  it("reads an unparsable root selector as absent instead of dying on it", async () => {
    await start(`
      <div data-controller="stimeo--scroll-visibility"
           data-stimeo--scroll-visibility-root-value="#broken[["
           data-stimeo--scroll-visibility-offset-value="400">
        <button type="button" hidden
                data-stimeo--scroll-visibility-target="element"
                data-action="stimeo--scroll-visibility#toTop">Back to top</button>
      </div>`);
    expect(root().getAttribute("data-state")).toBe("hidden");
    await scrollToY(500);
    expect(element().hidden).toBe(false);
  });

  it("reads an unparsable focus selector as absent instead of throwing per click", async () => {
    await start(`
      <div data-controller="stimeo--scroll-visibility"
           data-stimeo--scroll-visibility-focus-selector-value="#broken(("
           data-stimeo--scroll-visibility-offset-value="400">
        <button type="button" data-stimeo--scroll-visibility-target="element"
                data-action="stimeo--scroll-visibility#toTop">Top</button>
      </div>
      <main id="main">Content</main>`);
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--scroll-visibility",
    ) as unknown as { toTop: () => void };
    expect(() => controller.toTop()).not.toThrow();
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("reads a non-numeric offset as the default threshold", async () => {
    await start(`
      <div data-controller="stimeo--scroll-visibility"
           data-stimeo--scroll-visibility-offset-value="lots">
        <button type="button" hidden
                data-stimeo--scroll-visibility-target="element"
                data-action="stimeo--scroll-visibility#toTop">Back to top</button>
      </div>`);
    await scrollToY(500);
    expect(element().hidden).toBe(false);
  });

  it("keeps the near-top reveal guarantee when the offset is non-numeric", async () => {
    await start(`
      <div data-controller="stimeo--scroll-visibility"
           data-stimeo--scroll-visibility-offset-value="lots"
           data-stimeo--scroll-visibility-mode-value="direction">
        <header data-stimeo--scroll-visibility-target="element">Site header</header>
      </div>`);
    // Scrolling *down* inside the near-top band still reveals: the guarantee has
    // to win over the direction reading, which a NaN threshold cannot do.
    await scrollToY(50);
    expect(element().hidden).toBe(false);
    await scrollToY(1200); // past the default threshold, heading down → hidden
    expect(element().hidden).toBe(true);
  });

  it("re-renders when the offset changes at runtime", async () => {
    await start(offsetMarkup);
    await scrollToY(200);
    expect(element().hidden).toBe(true);
    root().setAttribute("data-stimeo--scroll-visibility-offset-value", "100");
    await tick();
    expect(element().hidden).toBe(false);
  });

  it("re-renders when the mode changes at runtime", async () => {
    await start(offsetMarkup);
    await scrollToY(200);
    expect(element().hidden).toBe(true); // below the amount threshold
    // Direction mode always reveals near the very top, so the same position
    // resolves the other way.
    root().setAttribute("data-stimeo--scroll-visibility-mode-value", "direction");
    await tick();
    expect(element().hidden).toBe(false);
  });

  it("keeps the state when a mode change lands where direction has no answer", async () => {
    await start(offsetMarkup);
    await scrollToY(500);
    expect(element().hidden).toBe(false);
    // Past the threshold and with no movement since, direction mode has no
    // direction to read, so the visible state stands until the next scroll.
    root().setAttribute("data-stimeo--scroll-visibility-mode-value", "direction");
    await tick();
    expect(element().hidden).toBe(false);
    await scrollToY(900); // now there is a downward movement to read
    expect(element().hidden).toBe(true);
  });

  // --- Focus retention ---------------------------------------------------------

  it("holds a hide back while the control itself owns focus", async () => {
    await start(offsetMarkup);
    const changes: boolean[] = [];
    root().addEventListener("stimeo--scroll-visibility:change", (event) => {
      changes.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
    });
    await scrollToY(500);
    element().focus();
    expect(document.activeElement).toBe(element());

    await scrollToY(100);
    // Still reachable: hiding it here would drop focus to the document body.
    expect(element().hidden).toBe(false);
    expect(changes).toEqual([true]);

    element().blur();
    await settle();
    expect(element().hidden).toBe(true);
    expect(changes).toEqual([true, false]);
  });

  it("re-decides a held-back hide from the scroll position at blur time", async () => {
    await start(offsetMarkup);
    await scrollToY(500);
    element().focus();
    await scrollToY(100); // deferred
    await scrollToY(700); // back past the threshold before focus leaves
    element().blur();
    await settle();
    expect(element().hidden).toBe(false);
  });

  it("applies a hide deferred by a focused descendant once that descendant blurs", async () => {
    await start(`
      <div data-controller="stimeo--scroll-visibility"
           data-stimeo--scroll-visibility-offset-value="400">
        <div hidden data-stimeo--scroll-visibility-target="element">
          <button type="button" id="nested"
                  data-action="stimeo--scroll-visibility#toTop">Back to top</button>
        </div>
      </div>`);
    const panel = element();
    const nested = document.getElementById("nested") as HTMLElement;
    await scrollToY(500);
    expect(panel.hidden).toBe(false);

    // `blur` does not bubble, so the deferral has to ride the focused button
    // itself: a listener on the panel would never fire and the hide would be
    // held forever.
    nested.focus();
    await scrollToY(100);
    expect(panel.hidden).toBe(false);

    nested.blur();
    await settle();
    expect(panel.hidden).toBe(true);
  });

  it("reflects state without a control to show, and without consulting focus", async () => {
    // The host may carry only `data-state` and let CSS do the showing. Nothing
    // on the path may reach for a target that was never declared.
    await start(`
      <div data-controller="stimeo--scroll-visibility"
           data-stimeo--scroll-visibility-offset-value="400"></div>`);
    const changes: boolean[] = [];
    root().addEventListener("stimeo--scroll-visibility:change", (event) => {
      changes.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
    });
    await scrollToY(500);
    expect(root().getAttribute("data-state")).toBe("visible");
    expect(changes).toEqual([true]);
  });

  // --- Target lifecycle --------------------------------------------------------

  it("drops a hide held by a descendant when the target is disconnected", async () => {
    await start(`
      <div data-controller="stimeo--scroll-visibility"
           data-stimeo--scroll-visibility-offset-value="400">
        <div hidden data-stimeo--scroll-visibility-target="element">
          <button type="button" id="nested">Back to top</button>
        </div>
      </div>`);
    const panel = element();
    const nested = document.getElementById("nested") as HTMLElement;
    await scrollToY(500);
    nested.focus();
    await scrollToY(100); // held back while the nested button owns focus
    expect(panel.hidden).toBe(false);

    const changes: boolean[] = [];
    root().addEventListener("stimeo--scroll-visibility:change", (event) => {
      changes.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
    });
    panel.remove();
    await settle();
    // The held-back hide left with its target: blurring the detached button must
    // not drive the host from off-page state.
    nested.blur();
    await settle();
    expect(changes).toEqual([]);
    expect(root().getAttribute("data-state")).toBe("visible");
  });

  it("writes the current visibility onto a control that arrives after connect", async () => {
    await start(offsetMarkup);
    await scrollToY(500);
    expect(element().hidden).toBe(false);
    // A Turbo Stream replaces the control with its authored (hidden) markup.
    root().innerHTML = `
      <button type="button" hidden
              data-stimeo--scroll-visibility-target="element"
              data-action="stimeo--scroll-visibility#toTop">Back to top</button>`;
    await settle();
    expect(element().hidden).toBe(false);
    expect(root().getAttribute("data-state")).toBe("visible");
  });

  // --- Direction mode edges ----------------------------------------------------

  it("keeps the current visibility when a scroll carries no vertical movement", async () => {
    await start(`
      <div data-controller="stimeo--scroll-visibility"
           data-stimeo--scroll-visibility-offset-value="100"
           data-stimeo--scroll-visibility-mode-value="direction">
        <header data-stimeo--scroll-visibility-target="element">Site header</header>
      </div>`);
    await scrollToY(600); // down → hidden
    await scrollToY(300); // up → shown
    expect(element().hidden).toBe(false);
    // A horizontal scroll fires `scroll` without moving scrollY: no direction.
    await scrollToY(300);
    expect(element().hidden).toBe(false);
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(offsetMarkup);
    await scrollToY(500);
    await expectNoA11yViolations(root());
  });

  // --- Speech-order regression ------------------------------------------------

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
