import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollVisibilityController } from "../src/controllers/scroll_visibility_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
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

  it.each(["root", "target"])(
    "repairs retained morph direction state at rest from %s",
    async (origin) => {
      await start(offsetMarkup.replace('mode-value="offset"', 'mode-value="direction"'));
      await scrollToY(600);
      expect(element().hidden).toBe(true);
      expect(root().getAttribute("data-state")).toBe("hidden");
      const changes = vi.fn();
      root().addEventListener("stimeo--scroll-visibility:change", changes);
      element().hidden = false;
      root().removeAttribute("data-state");
      (origin === "root" ? root() : element()).dispatchEvent(
        new CustomEvent("turbo:morph-element", { bubbles: true }),
      );
      await tick();
      expect(element().hidden).toBe(true);
      expect(root().getAttribute("data-state")).toBe("hidden");
      expect(changes).not.toHaveBeenCalled();
    },
  );

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

  it("gives back the focus tabindex a page restored from the cache carries", async () => {
    await start(`
      <div data-controller="stimeo--scroll-visibility"
           data-stimeo--scroll-visibility-focus-selector-value="#main">
        <button type="button" data-stimeo--scroll-visibility-target="element"
                data-action="stimeo--scroll-visibility#toTop">Top</button>
      </div>
      <main id="main">Content</main>`);
    element().click();
    expect(document.getElementById("main")?.getAttribute("tabindex")).toBe("-1");

    application = await restoreFromCache(application, (restored) =>
      restored.register("stimeo--scroll-visibility", ScrollVisibilityController),
    );

    const main = document.getElementById("main") as HTMLElement;
    expect(main.hasAttribute("tabindex")).toBe(false);
    expect(main.getAttributeNames().filter((name) => name.endsWith("-loan"))).toEqual([]);
  });

  it("gives back the focus tabindex a page restored from the cache carries on a former focus target", async () => {
    await start(`
      <div data-controller="stimeo--scroll-visibility"
           data-stimeo--scroll-visibility-focus-selector-value="#main">
        <button type="button" data-stimeo--scroll-visibility-target="element"
                data-action="stimeo--scroll-visibility#toTop">Top</button>
      </div>
      <main id="main">Content</main>
      <section id="other">Other</section>`);
    element().click();
    expect(document.getElementById("main")?.getAttribute("tabindex")).toBe("-1");
    root().setAttribute("data-stimeo--scroll-visibility-focus-selector-value", "#other");
    await tick();

    application = await restoreFromCache(application, (restored) =>
      restored.register("stimeo--scroll-visibility", ScrollVisibilityController),
    );

    const main = document.getElementById("main") as HTMLElement;
    expect(main.hasAttribute("tabindex")).toBe(false);
    expect(main.getAttributeNames().filter((name) => name.endsWith("-loan"))).toEqual([]);
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

  // --- A root that changes at runtime ------------------------------------------

  /** Two scroll containers, with the controller watching the first. */
  const twoPanesMarkup = (mode = "offset", offset = 400) => `
    <div id="pane-a"></div>
    <div id="pane-b"></div>
    <div data-controller="stimeo--scroll-visibility"
         data-stimeo--scroll-visibility-root-value="#pane-a"
         data-stimeo--scroll-visibility-offset-value="${offset}"
         data-stimeo--scroll-visibility-mode-value="${mode}">
      <button type="button" hidden
              data-stimeo--scroll-visibility-target="element"
              data-action="stimeo--scroll-visibility#toTop">Back to top</button>
    </div>`;

  const pane = (id: string) => document.getElementById(id) as HTMLElement;

  /** Scrolls `el` to `y` and lets the rAF-coalesced handler run. */
  const scrollPaneTo = async (el: HTMLElement, y: number) => {
    el.scrollTop = y;
    el.dispatchEvent(new Event("scroll"));
    await settle();
  };

  const recordChanges = () => {
    const changes: boolean[] = [];
    root().addEventListener("stimeo--scroll-visibility:change", (event) => {
      changes.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
    });
    return changes;
  };

  it("moves to the container a changed root names, and releases the one it left", async () => {
    await start(twoPanesMarkup());
    await scrollPaneTo(pane("pane-a"), 500);
    expect(element().hidden).toBe(false);
    const changes = recordChanges();

    root().setAttribute("data-stimeo--scroll-visibility-root-value", "#pane-b");
    await tick();
    // Decided from the new source's position at once, like any other change the
    // page makes to the declaration.
    expect(element().hidden).toBe(true);
    expect(changes).toEqual([false]);

    // The container it left schedules no measurement at all.
    const frame = vi.spyOn(window, "requestAnimationFrame");
    await scrollPaneTo(pane("pane-a"), 900);
    expect(frame).not.toHaveBeenCalled();
    frame.mockRestore();
    expect(element().hidden).toBe(true);
    await scrollPaneTo(pane("pane-b"), 500);
    expect(element().hidden).toBe(false);
    expect(changes).toEqual([false, true]);

    const scrollTo = vi.fn();
    pane("pane-b").scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
    element().click();
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
  });

  it("follows a root set back by a change handler, and only that source", async () => {
    await start(twoPanesMarkup());
    await scrollPaneTo(pane("pane-a"), 500);
    const changes = recordChanges();
    // A subscriber that answers the move by pointing the root straight back.
    root().addEventListener("stimeo--scroll-visibility:change", () =>
      root().setAttribute("data-stimeo--scroll-visibility-root-value", "#pane-a"),
    );
    root().setAttribute("data-stimeo--scroll-visibility-root-value", "#pane-b");
    await tick();
    await settle();
    // The move and the move back are each decided once, and it ends where it began.
    expect(changes).toEqual([false, true]);
    expect(element().hidden).toBe(false);

    const frame = vi.spyOn(window, "requestAnimationFrame");
    pane("pane-b").dispatchEvent(new Event("scroll"));
    expect(frame).not.toHaveBeenCalled();
    frame.mockRestore();
    await scrollPaneTo(pane("pane-a"), 0);
    expect(element().hidden).toBe(true);
  });

  it("releases the source it moved to on disconnect", async () => {
    await start(twoPanesMarkup());
    root().setAttribute("data-stimeo--scroll-visibility-root-value", "#pane-b");
    await tick();
    await scrollPaneTo(pane("pane-b"), 500);
    expect(element().hidden).toBe(false);
    await scrollPaneTo(pane("pane-b"), 0);

    application
      .getControllerForElementAndIdentifier(root(), "stimeo--scroll-visibility")
      ?.disconnect();
    await scrollPaneTo(pane("pane-b"), 500);
    expect(element().hidden).toBe(true);
  });

  it("reads a position on the new source as a baseline, not a movement", async () => {
    await start(twoPanesMarkup("direction", 100));
    await scrollPaneTo(pane("pane-a"), 600); // down → hidden
    expect(element().hidden).toBe(true);
    // The other container sits higher up than the first one had scrolled; that
    // is not an upward scroll, so the hidden state stands.
    pane("pane-b").scrollTop = 400;

    root().setAttribute("data-stimeo--scroll-visibility-root-value", "#pane-b");
    await tick();
    expect(element().hidden).toBe(true);
    await scrollPaneTo(pane("pane-b"), 300); // a real upward scroll reveals
    expect(element().hidden).toBe(false);
  });

  it("moves to the node that replaced the root when a morph reaches the controller", async () => {
    await start(twoPanesMarkup());
    const original = pane("pane-a");
    const replacement = document.createElement("div");
    replacement.id = "pane-a";
    original.replaceWith(replacement);

    // The selector string is unchanged; the morph that swapped the node reaches the
    // retained controller element, and the root is resolved from the DOM again.
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();
    await scrollPaneTo(replacement, 500);
    expect(element().hidden).toBe(false);
    await scrollPaneTo(original, 0);
    expect(element().hidden).toBe(false);
  });

  it("keeps the one listener when a pass resolves to the source it already has", async () => {
    await start(twoPanesMarkup());
    const add = vi.spyOn(pane("pane-a"), "addEventListener");
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    root().setAttribute("data-stimeo--scroll-visibility-offset-value", "300");
    await tick();
    expect(add).not.toHaveBeenCalled();
  });

  it("decides a root and offset changed together once, from the new source", async () => {
    await start(twoPanesMarkup());
    await scrollPaneTo(pane("pane-a"), 500);
    pane("pane-b").scrollTop = 700;
    const changes = recordChanges();

    // Measured on the old source, the new offset alone would hide the control for
    // a moment; one pass after the batch reads the new source with both.
    root().setAttribute("data-stimeo--scroll-visibility-offset-value", "600");
    root().setAttribute("data-stimeo--scroll-visibility-root-value", "#pane-b");
    await tick();
    expect(element().hidden).toBe(false);
    expect(changes).toEqual([]);
  });

  it("holds a hide the new source asks for while the control owns focus", async () => {
    await start(twoPanesMarkup());
    await scrollPaneTo(pane("pane-a"), 500);
    element().focus();

    root().setAttribute("data-stimeo--scroll-visibility-root-value", "#pane-b");
    await tick();
    expect(element().hidden).toBe(false);

    element().blur();
    await settle();
    expect(element().hidden).toBe(true);
  });

  it("does not move to a new root from a change outside the connected window", async () => {
    await start(twoPanesMarkup());
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--scroll-visibility",
    ) as ScrollVisibilityController;
    controller.disconnect();

    root().setAttribute("data-stimeo--scroll-visibility-root-value", "#pane-b");
    controller.rootValueChanged();
    await tick();
    await scrollPaneTo(pane("pane-b"), 500);
    expect(element().hidden).toBe(true);
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

  it("lets a blur of the departed control decide nothing once the target is gone", async () => {
    await start(offsetMarkup);
    const control = element();
    await scrollToY(500);
    control.focus();
    await scrollToY(100); // held back while the control owns focus
    const changes: boolean[] = [];
    root().addEventListener("stimeo--scroll-visibility:change", (event) => {
      changes.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
    });
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--scroll-visibility",
    ) as ScrollVisibilityController;

    control.remove();
    controller.elementTargetDisconnected(control);
    control.dispatchEvent(new FocusEvent("blur"));
    await settle();
    expect(changes).toEqual([]);
    expect(root().getAttribute("data-state")).toBe("visible");
  });

  it("releases a held-back hide's blur listener on disconnect", async () => {
    await start(offsetMarkup);
    const control = element();
    await scrollToY(500);
    control.focus();
    await scrollToY(100); // held back while the control owns focus
    const remove = vi.spyOn(control, "removeEventListener");
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--scroll-visibility",
    ) as ScrollVisibilityController;

    controller.disconnect();
    expect(remove.mock.calls.filter(([type]) => type === "blur")).toHaveLength(1);
    remove.mockRestore();
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

  it("writes the current visibility onto a control that arrives after the only one left", async () => {
    await start(offsetMarkup);
    await scrollToY(500);
    const arrival = element().cloneNode(true) as HTMLElement;
    arrival.hidden = true;
    element().remove();
    await tick();
    root().append(arrival);
    await tick();

    expect(arrival.hidden).toBe(false);
  });

  describe("a control that stays after an earlier one leaves", () => {
    /** Inserts a copy of the control, authored hidden, after it and lets Stimulus report it. */
    const insertSuccessor = async (): Promise<[HTMLElement, HTMLElement]> => {
      const original = element();
      const successor = original.cloneNode(true) as HTMLElement;
      successor.hidden = true;
      original.after(successor);
      await tick();
      return [original, successor];
    };

    it("carries a visibility the scroll changed while both were present", async () => {
      await start(offsetMarkup);
      await scrollToY(500);
      const [original, successor] = await insertSuccessor();
      expect(successor.hidden).toBe(false);
      await scrollToY(100); // hides the earlier control only
      original.remove();
      await tick();

      expect(element()).toBe(successor);
      expect(root().getAttribute("data-state")).toBe("hidden");
      expect(successor.hidden).toBe(true);
    });

    it("reports nothing while it synchronizes the control that stays", async () => {
      await start(offsetMarkup);
      await scrollToY(500);
      const [original] = await insertSuccessor();
      await scrollToY(100);
      const changes: boolean[] = [];
      root().addEventListener("stimeo--scroll-visibility:change", (event) => {
        changes.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
      });
      original.remove();
      await tick();

      expect(changes).toEqual([]);
    });

    it("tolerates the removal of the only control", async () => {
      await start(offsetMarkup);
      await scrollToY(500);
      const controller = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--scroll-visibility",
      ) as ScrollVisibilityController;
      const only = element();
      only.remove();

      // Drive the callback directly: happy-dom delivers target callbacks unreliably.
      expect(() => controller.elementTargetDisconnected(only)).not.toThrow();
      expect(root().getAttribute("data-state")).toBe("visible");
    });

    it("writes nothing into the control that stays once it has disconnected", async () => {
      await start(offsetMarkup);
      await scrollToY(500);
      const [original, successor] = await insertSuccessor();
      await scrollToY(100);
      const controller = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--scroll-visibility",
      ) as ScrollVisibilityController;
      controller.disconnect();
      original.remove();
      controller.elementTargetDisconnected(original);
      await tick();

      expect(successor.hidden).toBe(false);
    });
  });

  describe("a control that stops resolving", () => {
    /** Drops only the element token from `control`, which stays where it is. */
    const dropElementToken = async (control: HTMLElement) => {
      control.removeAttribute("data-stimeo--scroll-visibility-target");
      await tick();
    };

    it("gives a control that stops being one back the hidden it was authored with", async () => {
      await start(offsetMarkup);
      await scrollToY(500);
      const departed = element();
      expect(departed.hidden).toBe(false);
      const changes: unknown[] = [];
      root().addEventListener("stimeo--scroll-visibility:change", (event) => changes.push(event));

      await dropElementToken(departed);

      expect(departed.hidden).toBe(true);
      expect(root().getAttribute("data-state")).toBe("visible");
      expect(changes).toEqual([]);
    });

    it("gives the departed control its own hidden back while the control that stays shows the state", async () => {
      await start(offsetMarkup);
      await scrollToY(500);
      const departed = element();
      const successor = departed.cloneNode(true) as HTMLElement;
      departed.after(successor);
      await tick();
      expect(successor.hidden).toBe(false);

      await dropElementToken(departed);

      expect(element()).toBe(successor);
      expect(departed.hidden).toBe(true);
      expect(successor.hidden).toBe(false);
    });

    it("removes the hidden it wrote on a departed control that was authored without one", async () => {
      await start(offsetMarkup.replace("hidden\n", "\n"));
      const departed = element();
      expect(departed.hidden).toBe(true);

      await dropElementToken(departed);

      expect(departed.hasAttribute("hidden")).toBe(false);
    });

    it("keeps a hidden the page wrote on a control after the last write", async () => {
      await start(offsetMarkup);
      const departed = element();
      expect(departed.hidden).toBe(true);
      departed.hidden = false;

      await dropElementToken(departed);

      expect(departed.hidden).toBe(false);
    });

    it("keeps the visibility of a control that moves within the controller", async () => {
      await start(offsetMarkup.replace("</button>", '</button><p id="elsewhere"></p>'));
      await scrollToY(500);
      const moving = element();

      (document.getElementById("elsewhere") as HTMLElement).append(moving);
      await tick();

      expect(element()).toBe(moving);
      expect(moving.hidden).toBe(false);
    });

    it("gives the control back its own hidden when the controller loses its identifier", async () => {
      await start(offsetMarkup);
      await scrollToY(500);
      const departed = element();

      root().removeAttribute("data-controller");
      await tick();

      expect(departed.hidden).toBe(true);
    });

    it("keeps what it wrote on the control when the whole controller leaves the page", async () => {
      await start(offsetMarkup);
      await scrollToY(500);
      const kept = element();

      root().remove();
      await tick();

      expect(kept.hidden).toBe(false);
    });
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
