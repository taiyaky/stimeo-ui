import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StickToBottomController } from "../src/controllers/stick_to_bottom_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link StickToBottomController}. happy-dom has no layout, so the
 * scroll geometry is stubbed and `scrollTo` is mocked: pinned detection, follow-on-append
 * while pinned, the has-new flag + event while unpinned, scroll-driven re-pin, the
 * scrollToBottom action, reduced-motion behavior, and teardown. Real scrolling is covered
 * by the e2e layer.
 */

let originalMatchMedia: typeof window.matchMedia;
const setReducedMotion = (reduce: boolean) => {
  window.matchMedia = ((q: string) => ({
    media: q,
    matches: reduce && q.includes("prefers-reduced-motion"),
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("StickToBottomController", () => {
  let application: Application;

  const setup = (attrs = "") => {
    document.body.innerHTML = `
      <div id="box" data-controller="stimeo--stick-to-bottom" ${attrs}>
        <ul id="content" data-stimeo--stick-to-bottom-target="content"><li>1</li></ul>
      </div>`;
  };
  const start = async () => {
    application = Application.start();
    application.register("stimeo--stick-to-bottom", StickToBottomController);
    await tick();
  };

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    setReducedMotion(false);
    document.body.innerHTML = "";
  });

  afterEach(() => {
    application.stop();
    window.matchMedia = originalMatchMedia;
    document.body.innerHTML = "";
  });

  const box = () => query("#box");
  const content = () => query("#content");

  /** Stubs the scroll geometry; distance-from-bottom = scrollHeight - clientHeight - scrollTop. */
  const setGeom = (scrollHeight: number, clientHeight: number, scrollTop: number) => {
    for (const [key, value] of Object.entries({ scrollHeight, clientHeight, scrollTop })) {
      Object.defineProperty(box(), key, { configurable: true, value });
    }
  };
  const appendChild = async () => {
    content().appendChild(document.createElement("li"));
    await tick();
  };

  it("marks pinned on connect when near the bottom", async () => {
    setup();
    setGeom(1000, 400, 600); // distance 0 ≤ 80
    await start();
    expect(box().getAttribute("data-pinned")).toBe("true");
  });

  it("is not pinned on connect when scrolled up", async () => {
    setup();
    setGeom(1000, 400, 100); // distance 500 > 80
    await start();
    expect(box().hasAttribute("data-pinned")).toBe(false);
  });

  it("re-syncs stale hooks from a cache restore on connect", async () => {
    // The cached DOM brings back data-pinned/has-new, but the geometry says unpinned.
    setup('data-pinned="true" data-has-new="true"');
    setGeom(1000, 400, 100); // distance 500 > 80 → not pinned
    await start();
    expect(box().hasAttribute("data-pinned")).toBe(false); // stale value dropped
  });

  it("follows appended content to the bottom while pinned", async () => {
    setup();
    setGeom(1000, 400, 600); // pinned
    await start();
    box().scrollTo = vi.fn();
    Object.defineProperty(box(), "scrollHeight", { configurable: true, value: 1100 });

    await appendChild();
    expect(box().scrollTo).toHaveBeenCalledWith({ top: 1100, behavior: "auto" });
    expect(box().hasAttribute("data-has-new")).toBe(false);
  });

  it("flags new content without scrolling while unpinned", async () => {
    setup();
    setGeom(1000, 400, 100); // unpinned
    await start();
    box().scrollTo = vi.fn();
    const news: Array<{ count: number }> = [];
    box().addEventListener("stimeo--stick-to-bottom:new", (e) =>
      news.push((e as CustomEvent).detail),
    );

    await appendChild();
    expect(box().scrollTo).not.toHaveBeenCalled();
    expect(box().getAttribute("data-has-new")).toBe("true");
    expect(news).toEqual([{ count: 1 }]);
  });

  it("re-pins and clears has-new when the user scrolls back to the bottom", async () => {
    setup();
    setGeom(1000, 400, 100); // unpinned
    await start();
    box().scrollTo = vi.fn();
    await appendChild(); // sets data-has-new
    expect(box().getAttribute("data-has-new")).toBe("true");

    const pins: Array<{ pinned: boolean }> = [];
    box().addEventListener("stimeo--stick-to-bottom:pin", (e) =>
      pins.push((e as CustomEvent).detail),
    );
    setGeom(1100, 400, 700); // distance 0 → pinned
    box().dispatchEvent(new Event("scroll"));

    expect(box().getAttribute("data-pinned")).toBe("true");
    expect(box().hasAttribute("data-has-new")).toBe(false);
    expect(pins).toEqual([{ pinned: true }]);
  });

  it("jumps to the bottom and re-pins via the scrollToBottom action", async () => {
    setup();
    setGeom(1000, 400, 100); // unpinned
    await start();
    box().scrollTo = vi.fn();
    await appendChild();
    const instance = application.getControllerForElementAndIdentifier(
      box(),
      "stimeo--stick-to-bottom",
    ) as StickToBottomController;

    instance.scrollToBottom();
    expect(box().scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });
    expect(box().hasAttribute("data-has-new")).toBe(false);
    expect(box().getAttribute("data-pinned")).toBe("true");
  });

  it("forces auto behavior under reduced motion", async () => {
    setReducedMotion(true);
    setup('data-stimeo--stick-to-bottom-behavior-value="smooth"');
    setGeom(1000, 400, 600); // pinned
    await start();
    box().scrollTo = vi.fn();
    Object.defineProperty(box(), "scrollHeight", { configurable: true, value: 1100 });
    await appendChild();
    expect(box().scrollTo).toHaveBeenCalledWith({ top: 1100, behavior: "auto" });
  });

  it("stops observing and listening on disconnect", async () => {
    setup();
    setGeom(1000, 400, 100); // unpinned
    await start();
    box().scrollTo = vi.fn();
    const el = box();
    const contentEl = content();
    el.remove();
    await tick();

    const news: number[] = [];
    el.addEventListener("stimeo--stick-to-bottom:new", () => news.push(1));
    contentEl.appendChild(document.createElement("li"));
    await tick();
    expect(news).toEqual([]); // observer severed
  });

  it("has no a11y violations", async () => {
    setup();
    await start();
    await expectNoA11yViolations(box());
  });
});
