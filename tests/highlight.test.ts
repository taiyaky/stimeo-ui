import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HighlightController } from "../src/controllers/highlight_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link HighlightController}, driven by a mocked clock: the
 * self-highlight on connect, the timed removal, the start / end events, container
 * mode highlighting added children via a MutationObserver, reduced-motion
 * suppression, and observer / timer teardown.
 */

let originalMatchMedia: typeof window.matchMedia;

/** Installs a matchMedia whose reduce-motion result is `reduce`. */
const setReducedMotion = (reduce: boolean) => {
  window.matchMedia = ((queryString: string) => ({
    media: queryString,
    matches: reduce && queryString.includes("prefers-reduced-motion"),
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;
};

describe("HighlightController", () => {
  let application: Application;

  const mount = async (html: string) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--highlight", HighlightController);
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    originalMatchMedia = window.matchMedia;
    setReducedMotion(false);
  });

  afterEach(() => {
    application.stop();
    vi.useRealTimers();
    window.matchMedia = originalMatchMedia;
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--highlight']");
  const flush = () => vi.advanceTimersByTimeAsync(0);

  it("flags the element on connect and removes it after the default duration", async () => {
    await mount('<li data-controller="stimeo--highlight">New</li>');
    expect(root().getAttribute("data-highlight")).toBe("true");

    vi.advanceTimersByTime(1499);
    expect(root().hasAttribute("data-highlight")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(root().hasAttribute("data-highlight")).toBe(false);
  });

  it("honors a custom duration", async () => {
    await mount(
      '<li data-controller="stimeo--highlight" data-stimeo--highlight-duration-value="500">x</li>',
    );
    vi.advanceTimersByTime(499);
    expect(root().hasAttribute("data-highlight")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(root().hasAttribute("data-highlight")).toBe(false);
  });

  it("dispatches start then end carrying the highlighted element", async () => {
    // Container mode so a listener can be attached before the highlight begins.
    await mount(
      '<ul data-controller="stimeo--highlight" data-stimeo--highlight-observe-value="true"></ul>',
    );
    const events: Array<{ type: string; element: EventTarget | null }> = [];
    for (const type of ["start", "end"] as const) {
      root().addEventListener(`stimeo--highlight:${type}`, (e) => {
        events.push({ type, element: (e as CustomEvent).detail.element });
      });
    }
    const li = document.createElement("li");
    root().appendChild(li);
    await flush();
    expect(events).toEqual([{ type: "start", element: li }]);

    vi.advanceTimersByTime(1500);
    expect(events).toEqual([
      { type: "start", element: li },
      { type: "end", element: li },
    ]);
  });

  it("highlights children added in container mode but not the container", async () => {
    await mount(
      '<ul data-controller="stimeo--highlight" data-stimeo--highlight-observe-value="true"></ul>',
    );
    expect(root().hasAttribute("data-highlight")).toBe(false);

    const li = document.createElement("li");
    root().appendChild(li);
    await flush();
    expect(li.getAttribute("data-highlight")).toBe("true");
    expect(root().hasAttribute("data-highlight")).toBe(false);

    vi.advanceTimersByTime(1500);
    expect(li.hasAttribute("data-highlight")).toBe(false);
  });

  it("highlights each of several children added at once", async () => {
    await mount(
      '<ul data-controller="stimeo--highlight" data-stimeo--highlight-observe-value="true"></ul>',
    );
    const a = document.createElement("li");
    const b = document.createElement("li");
    root().append(a, b);
    await flush();
    expect(a.getAttribute("data-highlight")).toBe("true");
    expect(b.getAttribute("data-highlight")).toBe("true");
  });

  it("suppresses the highlight entirely under reduced motion", async () => {
    setReducedMotion(true);
    let started = 0;
    await mount('<li data-controller="stimeo--highlight">New</li>');
    root().addEventListener("stimeo--highlight:start", () => {
      started += 1;
    });
    expect(root().hasAttribute("data-highlight")).toBe(false);
    expect(started).toBe(0);
  });

  it("stops observing and clears timers after disconnect", async () => {
    await mount(
      '<ul data-controller="stimeo--highlight" data-stimeo--highlight-observe-value="true"></ul>',
    );
    const list = root();
    list.remove();
    await flush();

    const li = document.createElement("li");
    list.appendChild(li);
    await flush();
    expect(li.hasAttribute("data-highlight")).toBe(false);
  });

  it("clears a pending self-highlight timer on disconnect", async () => {
    await mount('<li data-controller="stimeo--highlight">New</li>');
    const li = root();
    expect(li.getAttribute("data-highlight")).toBe("true");
    li.remove();
    await flush();
    // The removal timer was cleared, so the (now detached) node keeps no stale work.
    vi.advanceTimersByTime(2000);
    expect(li.getAttribute("data-highlight")).toBe("true");
  });

  it("has no a11y violations", async () => {
    vi.useRealTimers();
    document.body.innerHTML =
      '<ul data-controller="stimeo--highlight" data-stimeo--highlight-observe-value="true"><li>a</li></ul>';
    application = Application.start();
    application.register("stimeo--highlight", HighlightController);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expectNoA11yViolations(root());
  });
});
