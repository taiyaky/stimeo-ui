import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverflowIndicatorController } from "../src/controllers/overflow_indicator_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link OverflowIndicatorController}: the
 * `data-overflow-start`/`data-overflow-end` sync from scroll geometry, the
 * `change` event, the button `disabled` mirroring, `scrollByPage` direction
 * handling, and resize teardown.
 *
 * happy-dom has no layout, so `scrollLeft`/`scrollWidth`/`clientWidth` are stubbed
 * and a viewport resize drives the controller; `scrollBy` is mocked.
 */

const markup = `
  <div data-controller="stimeo--overflow-indicator"
       data-stimeo--overflow-indicator-orientation-value="horizontal">
    <button type="button" aria-label="Prev"
            data-stimeo--overflow-indicator-direction-param="start"
            data-action="click->stimeo--overflow-indicator#scrollByPage">‹</button>
    <div data-stimeo--overflow-indicator-target="viewport"
         data-action="scroll->stimeo--overflow-indicator#update"
         tabindex="0" role="region" aria-label="Products"
         style="overflow-x: auto;"><span>items</span></div>
    <button type="button" aria-label="Next"
            data-stimeo--overflow-indicator-direction-param="end"
            data-action="click->stimeo--overflow-indicator#scrollByPage">›</button>
  </div>`;

const originalMatchMedia = window.matchMedia;

/** Installs a matchMedia stub for the reduced-motion preference. */
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

/** Controllable ResizeObserver double for viewport/content resize coverage. */
class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.add(element);
  }

  unobserve(element: Element): void {
    this.observed.delete(element);
  }

  disconnect(): void {
    this.observed.clear();
  }

  trigger(): void {
    this.callback([], this);
  }
}

describe("OverflowIndicatorController", () => {
  let application: Application;

  const start = async () => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--overflow-indicator", OverflowIndicatorController);
    await tick();
  };

  beforeEach(() => {
    setReducedMotion(false);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    // Unstub first: a `vi.stubGlobal("matchMedia", …)` case would otherwise
    // restore this file's reduced-motion double over the real matchMedia.
    vi.unstubAllGlobals();
    window.matchMedia = originalMatchMedia;
    FakeResizeObserver.instances = [];
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>(
      "[data-controller='stimeo--overflow-indicator']",
    ) as HTMLElement;
  const viewport = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--overflow-indicator-target='viewport']",
    ) as HTMLElement;
  const button = (direction: "start" | "end") =>
    document.querySelector<HTMLButtonElement>(
      `[data-stimeo--overflow-indicator-direction-param='${direction}']`,
    ) as HTMLButtonElement;

  /** Stubs scroll geometry and notifies via a viewport resize. */
  const layout = (
    geometry: Partial<
      Record<
        | "scrollLeft"
        | "scrollWidth"
        | "clientWidth"
        | "scrollTop"
        | "scrollHeight"
        | "clientHeight",
        number
      >
    >,
  ) => {
    for (const [key, value] of Object.entries(geometry)) {
      Object.defineProperty(viewport(), key, { configurable: true, value });
    }
    window.dispatchEvent(new Event("resize"));
  };

  it("reports room toward the end when scrolled to the start", async () => {
    await start();
    layout({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 });
    expect(viewport().getAttribute("data-overflow-start")).toBe("false");
    expect(viewport().getAttribute("data-overflow-end")).toBe("true");
    expect(button("start").disabled).toBe(true);
    expect(button("end").disabled).toBe(false);
  });

  it("reports room on both sides in the middle", async () => {
    await start();
    layout({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 300 });
    expect(viewport().getAttribute("data-overflow-start")).toBe("true");
    expect(viewport().getAttribute("data-overflow-end")).toBe("true");
    expect(button("start").disabled).toBe(false);
    expect(button("end").disabled).toBe(false);
  });

  it("reports no end room once scrolled to the end", async () => {
    await start();
    layout({ scrollLeft: 700, scrollWidth: 1000, clientWidth: 300 });
    expect(viewport().getAttribute("data-overflow-start")).toBe("true");
    expect(viewport().getAttribute("data-overflow-end")).toBe("false");
    expect(button("end").disabled).toBe(true);
  });

  it("owns and removes only the native disabled state marked by the controller", async () => {
    await start();
    layout({ scrollLeft: 700, scrollWidth: 1000, clientWidth: 300 });
    expect(button("end").disabled).toBe(true);
    expect(button("end").hasAttribute("data-overflow-indicator-disabled")).toBe(true);

    layout({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 300 });
    expect(button("end").disabled).toBe(false);
    expect(button("end").hasAttribute("data-overflow-indicator-disabled")).toBe(false);
  });

  it("keeps a focused boundary button in the focus order until it blurs", async () => {
    await start();
    layout({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 300 });
    const scrollBy = vi.fn();
    viewport().scrollBy = scrollBy;
    button("end").focus();

    layout({ scrollLeft: 700, scrollWidth: 1000, clientWidth: 300 });
    expect(document.activeElement).toBe(button("end"));
    expect(button("end").disabled).toBe(false);
    expect(button("end").getAttribute("aria-disabled")).toBe("true");

    button("end").click();
    expect(scrollBy).not.toHaveBeenCalled();

    viewport().focus();
    expect(document.activeElement).toBe(viewport());
    expect(button("end").disabled).toBe(true);
    expect(button("end").hasAttribute("aria-disabled")).toBe(false);
  });

  it("releases temporary focus state when a pending button is removed", async () => {
    await start();
    layout({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 300 });
    const pending = button("end");
    pending.focus();
    layout({ scrollLeft: 700, scrollWidth: 1000, clientWidth: 300 });
    expect(pending.getAttribute("aria-disabled")).toBe("true");

    pending.remove();
    await tick();

    expect(pending.hasAttribute("aria-disabled")).toBe(false);
    expect(pending.hasAttribute("data-overflow-indicator-pending-disabled")).toBe(false);
  });

  it("restores an author-provided aria-disabled value after pending focus clears", async () => {
    await start();
    layout({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 300 });
    const pending = button("end");
    pending.setAttribute("aria-disabled", "false");
    pending.focus();
    layout({ scrollLeft: 700, scrollWidth: 1000, clientWidth: 300 });
    expect(pending.getAttribute("aria-disabled")).toBe("true");

    layout({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 300 });

    expect(pending.getAttribute("aria-disabled")).toBe("false");
    expect(pending.hasAttribute("data-overflow-indicator-pending-disabled")).toBe(false);
  });

  it("reconciles a pending marker carried in by a restored snapshot", async () => {
    // Turbo clones the page for its cache *before* `disconnect()` runs, so a
    // restored visit brings the pending markers back while the fresh instance has
    // no in-memory record of them. The marker itself must be enough to undo the
    // displaced `aria-disabled` — otherwise the button keeps announcing itself as
    // disabled forever while staying focusable.
    document.body.innerHTML = markup;
    const restored = button("end");
    restored.setAttribute("data-overflow-indicator-pending-disabled", "");
    restored.setAttribute("data-overflow-indicator-aria-disabled", "");
    restored.setAttribute("aria-disabled", "true");

    application = Application.start();
    application.register("stimeo--overflow-indicator", OverflowIndicatorController);
    await tick();
    layout({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 300 });

    expect(restored.hasAttribute("aria-disabled")).toBe(false);
    expect(restored.hasAttribute("data-overflow-indicator-pending-disabled")).toBe(false);
    expect(restored.hasAttribute("data-overflow-indicator-aria-disabled")).toBe(false);
  });

  it("gives back an author's aria-disabled recorded in a restored marker", async () => {
    // Same restore path, but the author had their own `aria-disabled="false"` when
    // the marker was created: the marker carries that value, so it comes back.
    document.body.innerHTML = markup;
    const restored = button("end");
    restored.setAttribute("data-overflow-indicator-pending-disabled", "");
    restored.setAttribute("data-overflow-indicator-aria-disabled", "false");
    restored.setAttribute("aria-disabled", "true");

    application = Application.start();
    application.register("stimeo--overflow-indicator", OverflowIndicatorController);
    await tick();
    layout({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 300 });

    expect(restored.getAttribute("aria-disabled")).toBe("false");
    expect(restored.hasAttribute("data-overflow-indicator-pending-disabled")).toBe(false);
  });

  it("drops pending focus state and its aria-disabled on teardown", async () => {
    await start();
    layout({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 300 });
    const pending = button("end");
    pending.focus();
    layout({ scrollLeft: 700, scrollWidth: 1000, clientWidth: 300 });
    expect(pending.getAttribute("aria-disabled")).toBe("true");

    // The spec requires the controller-owned pending state to be released on
    // disconnect, so a cached snapshot never keeps a half-disabled button.
    application.unload("stimeo--overflow-indicator");
    await tick();

    expect(pending.hasAttribute("aria-disabled")).toBe(false);
    expect(pending.hasAttribute("data-overflow-indicator-pending-disabled")).toBe(false);
    expect(pending.hasAttribute("data-overflow-indicator-aria-disabled")).toBe(false);

    // And a late blur cannot resurrect it.
    pending.dispatchEvent(new FocusEvent("blur"));
    expect(pending.disabled).toBe(false);
  });

  it("normalizes the threshold Value: negative becomes 0, non-finite falls back to 1", async () => {
    await start();
    // threshold 0: a single pixel of room already counts as room at the start.
    root().setAttribute("data-stimeo--overflow-indicator-threshold-value", "-5");
    await tick();
    layout({ scrollLeft: 1, scrollWidth: 1000, clientWidth: 300 });
    expect(viewport().getAttribute("data-overflow-start")).toBe("true");

    // Non-finite falls back to the default 1, so the same 1px is within tolerance.
    root().setAttribute("data-stimeo--overflow-indicator-threshold-value", "abc");
    await tick();
    layout({ scrollLeft: 1, scrollWidth: 1000, clientWidth: 300 });
    expect(viewport().getAttribute("data-overflow-start")).toBe("false");
  });

  it("treats sub-pixel distance from an edge as fully reached", async () => {
    await start();
    // 0.6px short of the end: within the default 1px tolerance, so no end room.
    layout({ scrollLeft: 699.4, scrollWidth: 1000, clientWidth: 300 });
    expect(viewport().getAttribute("data-overflow-end")).toBe("false");

    // 1.4px short: outside the tolerance, so the end button stays operable.
    layout({ scrollLeft: 698.6, scrollWidth: 1000, clientWidth: 300 });
    expect(viewport().getAttribute("data-overflow-end")).toBe("true");
  });

  it("normalizes RTL scroll offsets inherited from an ancestor", async () => {
    // The authoring contract is `dir="rtl"` / a stylesheet on an ancestor, not an
    // inline style on the viewport itself; direction is inherited, so the util must
    // resolve it from the computed style rather than the element's own declaration.
    await start();
    root().style.direction = "rtl";
    layout({ scrollLeft: -700, scrollWidth: 1000, clientWidth: 300 });

    expect(viewport().getAttribute("data-overflow-start")).toBe("true");
    expect(viewport().getAttribute("data-overflow-end")).toBe("false");
  });

  it("is a safe no-op without a viewport target", async () => {
    // Inspector requires the viewport target, but a degraded / mid-morph DOM must
    // not throw: update() and scrollByPage() simply do nothing.
    document.body.innerHTML = `
      <div data-controller="stimeo--overflow-indicator">
        <button type="button" id="lonely"
                data-stimeo--overflow-indicator-direction-param="end"
                data-action="click->stimeo--overflow-indicator#scrollByPage">›</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--overflow-indicator", OverflowIndicatorController);
    await tick();

    const lonely = document.querySelector<HTMLButtonElement>("#lonely") as HTMLButtonElement;
    expect(() => window.dispatchEvent(new Event("resize"))).not.toThrow();
    expect(() => lonely.click()).not.toThrow();
    expect(lonely.disabled).toBe(false);
  });

  it("dispatches change only when the room state transitions", async () => {
    await start();
    const events: Array<{ start: boolean; end: boolean }> = [];
    root().addEventListener("stimeo--overflow-indicator:change", (event) => {
      events.push((event as CustomEvent<{ start: boolean; end: boolean }>).detail);
    });
    layout({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 });
    layout({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 }); // identical → no event
    layout({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 300 });
    expect(events).toEqual([
      { start: false, end: true },
      { start: true, end: true },
    ]);
  });

  it("updates on the viewport scroll action", async () => {
    await start();
    Object.defineProperty(viewport(), "scrollWidth", { configurable: true, value: 1000 });
    Object.defineProperty(viewport(), "clientWidth", { configurable: true, value: 300 });
    Object.defineProperty(viewport(), "scrollLeft", { configurable: true, value: 300 });
    viewport().dispatchEvent(new Event("scroll"));
    await tick();
    expect(viewport().getAttribute("data-overflow-start")).toBe("true");
  });

  it("scrolls one page toward the requested direction", async () => {
    await start();
    // Mid-scroll so both direction buttons are enabled and can receive clicks.
    layout({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 300 });
    const scrollBy = vi.fn();
    viewport().scrollBy = scrollBy;
    button("end").click();
    expect(scrollBy).toHaveBeenCalledWith({ left: 300, behavior: "smooth" });
    button("start").click();
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -300, behavior: "smooth" });
  });

  it("uses instant page scrolling when reduced motion is preferred", async () => {
    setReducedMotion(true);
    await start();
    layout({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 300 });
    const scrollBy = vi.fn();
    viewport().scrollBy = scrollBy;
    button("end").click();
    expect(scrollBy).toHaveBeenCalledWith({ left: 300, behavior: "auto" });
  });

  it("uses logical start/end geometry and physical scroll direction in RTL", async () => {
    await start();
    viewport().style.direction = "rtl";
    layout({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 });
    expect(viewport().getAttribute("data-overflow-start")).toBe("false");
    expect(viewport().getAttribute("data-overflow-end")).toBe("true");

    layout({ scrollLeft: -300, scrollWidth: 1000, clientWidth: 300 });
    const scrollBy = vi.fn();
    viewport().scrollBy = scrollBy;
    button("end").click();
    expect(scrollBy).toHaveBeenCalledWith({ left: -300, behavior: "smooth" });
    button("start").click();
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 300, behavior: "smooth" });

    layout({ scrollLeft: -700, scrollWidth: 1000, clientWidth: 300 });
    expect(viewport().getAttribute("data-overflow-start")).toBe("true");
    expect(viewport().getAttribute("data-overflow-end")).toBe("false");
  });

  it("scrolls vertically and honors reduced motion", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    document.body.innerHTML = markup.replace(
      'data-stimeo--overflow-indicator-orientation-value="horizontal"',
      'data-stimeo--overflow-indicator-orientation-value="vertical"',
    );
    application = Application.start();
    application.register("stimeo--overflow-indicator", OverflowIndicatorController);
    await tick();
    layout({ scrollTop: 300, scrollHeight: 1000, clientHeight: 300 });

    const scrollBy = vi.fn();
    viewport().scrollBy = scrollBy;
    button("end").click();
    expect(scrollBy).toHaveBeenCalledWith({ top: 300, behavior: "auto" });
    button("start").click();
    expect(scrollBy).toHaveBeenLastCalledWith({ top: -300, behavior: "auto" });
  });

  it("never re-enables an author-disabled page button (owns only its own disabled)", async () => {
    // The author disabled the "start" button for their own reason. The controller
    // owns only the `disabled` it sets via its marker, so even when scroll room
    // appears toward the start it must not blindly re-enable that button.
    document.body.innerHTML = `
      <div data-controller="stimeo--overflow-indicator"
           data-stimeo--overflow-indicator-orientation-value="horizontal">
        <button type="button" aria-label="Prev" disabled
                data-stimeo--overflow-indicator-direction-param="start"
                data-action="click->stimeo--overflow-indicator#scrollByPage">‹</button>
        <div data-stimeo--overflow-indicator-target="viewport"
             data-action="scroll->stimeo--overflow-indicator#update"
             tabindex="0" role="region" aria-label="Products"
             style="overflow-x: auto;">items</div>
        <button type="button" aria-label="Next"
                data-stimeo--overflow-indicator-direction-param="end"
                data-action="click->stimeo--overflow-indicator#scrollByPage">›</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--overflow-indicator", OverflowIndicatorController);
    await tick();

    // There is room toward the start, which would normally enable the button.
    layout({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 300 });
    expect(viewport().getAttribute("data-overflow-start")).toBe("true");
    // …but the author-disabled button (no controller marker) is left untouched.
    expect(button("start").disabled).toBe(true);
    expect(button("start").hasAttribute("data-overflow-indicator-disabled")).toBe(false);
  });

  it("updates when direct content resizes without a DOM mutation", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    await start();
    layout({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 });
    expect(viewport().getAttribute("data-overflow-end")).toBe("false");

    const content = viewport().firstElementChild as HTMLElement;
    const resizeObserver = FakeResizeObserver.instances[0];
    expect(resizeObserver?.observed.has(viewport())).toBe(true);
    expect(resizeObserver?.observed.has(content)).toBe(true);

    Object.defineProperty(viewport(), "scrollWidth", { configurable: true, value: 1000 });
    resizeObserver?.trigger();
    expect(viewport().getAttribute("data-overflow-end")).toBe("true");
  });

  it("updates for content mutations and captured descendant load events", async () => {
    await start();
    layout({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 });
    const content = viewport().firstElementChild as HTMLElement;

    Object.defineProperty(viewport(), "scrollWidth", { configurable: true, value: 1000 });
    content.classList.add("wide");
    await tick();
    expect(viewport().getAttribute("data-overflow-end")).toBe("true");

    Object.defineProperty(viewport(), "scrollWidth", { configurable: true, value: 300 });
    content.dispatchEvent(new Event("load"));
    expect(viewport().getAttribute("data-overflow-end")).toBe("false");
  });

  it("rebinds layout and content observation when the viewport target is replaced", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    await start();
    layout({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 });
    const oldViewport = viewport();
    const replacement = document.createElement("div");
    replacement.setAttribute("data-stimeo--overflow-indicator-target", "viewport");
    replacement.setAttribute("data-action", "scroll->stimeo--overflow-indicator#update");
    replacement.innerHTML = "<span>replacement</span>";
    Object.defineProperties(replacement, {
      scrollLeft: { configurable: true, value: 0 },
      scrollWidth: { configurable: true, value: 1000 },
      clientWidth: { configurable: true, value: 300 },
    });

    oldViewport.replaceWith(replacement);
    await tick();

    expect(viewport()).toBe(replacement);
    expect(replacement.getAttribute("data-overflow-end")).toBe("true");
    const observed = FakeResizeObserver.instances[0]?.observed;
    expect(observed?.has(oldViewport)).toBe(false);
    expect(observed?.has(replacement)).toBe(true);
    expect(observed?.has(replacement.firstElementChild as Element)).toBe(true);
  });

  it("re-evaluates runtime orientation and threshold values", async () => {
    await start();
    layout({
      scrollLeft: 5,
      scrollWidth: 1000,
      clientWidth: 300,
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 300,
    });
    expect(viewport().getAttribute("data-overflow-start")).toBe("true");

    root().setAttribute("data-stimeo--overflow-indicator-threshold-value", "10");
    await tick();
    expect(viewport().getAttribute("data-overflow-start")).toBe("false");

    root().setAttribute("data-stimeo--overflow-indicator-orientation-value", "vertical");
    await tick();
    expect(viewport().getAttribute("data-overflow-start")).toBe("false");
    expect(viewport().getAttribute("data-overflow-end")).toBe("true");
  });

  it("ignores an invalid direction param without scrolling", async () => {
    await start();
    layout({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 300 });
    const scrollBy = vi.fn();
    viewport().scrollBy = scrollBy;
    const invalidButton = button("end");
    invalidButton.setAttribute("data-stimeo--overflow-indicator-direction-param", "sideways");

    invalidButton.click();

    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("does not mutate direction buttons owned by a nested instance", async () => {
    document.body.innerHTML = `
      <div id="outer" data-controller="stimeo--overflow-indicator">
        <button type="button" data-stimeo--overflow-indicator-direction-param="start"
                data-action="click->stimeo--overflow-indicator#scrollByPage">Outer start</button>
        <div id="outer-viewport" data-stimeo--overflow-indicator-target="viewport"
             data-action="scroll->stimeo--overflow-indicator#update"></div>
        <div id="inner" data-controller="stimeo--overflow-indicator">
          <button id="inner-start" type="button"
                  data-stimeo--overflow-indicator-direction-param="start"
                  data-action="click->stimeo--overflow-indicator#scrollByPage">Inner start</button>
          <div id="inner-viewport" data-stimeo--overflow-indicator-target="viewport"
               data-action="scroll->stimeo--overflow-indicator#update"></div>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--overflow-indicator", OverflowIndicatorController);
    await tick();
    const outerViewport = document.querySelector<HTMLElement>("#outer-viewport") as HTMLElement;
    const innerViewport = document.querySelector<HTMLElement>("#inner-viewport") as HTMLElement;
    for (const [element, geometry] of [
      [outerViewport, { scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 }],
      [innerViewport, { scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 }],
    ] as const) {
      for (const [key, value] of Object.entries(geometry)) {
        Object.defineProperty(element, key, { configurable: true, value });
      }
    }
    window.dispatchEvent(new Event("resize"));
    const innerStart = document.querySelector<HTMLButtonElement>(
      "#inner-start",
    ) as HTMLButtonElement;
    expect(innerStart.disabled).toBe(true);

    Object.defineProperty(outerViewport, "scrollLeft", { configurable: true, value: 300 });
    outerViewport.dispatchEvent(new Event("scroll"));
    expect(innerStart.disabled).toBe(true);
  });

  it("stops action, mutation, and load-driven updates after unload", async () => {
    await start();
    layout({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 });
    expect(viewport().getAttribute("data-overflow-end")).toBe("false");

    application.unload("stimeo--overflow-indicator");
    Object.defineProperty(viewport(), "scrollWidth", { configurable: true, value: 1000 });
    viewport().dispatchEvent(new Event("scroll"));
    (viewport().firstElementChild as HTMLElement).classList.add("wide");
    (viewport().firstElementChild as HTMLElement).dispatchEvent(new Event("load"));
    await tick();

    expect(viewport().getAttribute("data-overflow-end")).toBe("false");
  });

  it("stops reacting to resizes after disconnect", async () => {
    await start();
    layout({ scrollLeft: 0, scrollWidth: 100, clientWidth: 300 }); // no overflow
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--overflow-indicator",
    );
    controller?.disconnect();
    layout({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 }); // would overflow
    expect(viewport().getAttribute("data-overflow-end")).toBe("false");
  });

  it("has no machine-detectable a11y violations", async () => {
    await start();
    layout({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 300 });
    await expectNoA11yViolations(root());
  });

  // --- Layer ③ speech-order regression ---------------------------------------

  it("announces the page buttons and the named scroll region in order", async () => {
    await start();
    layout({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 300 }); // both buttons enabled
    const phrases = await captureSpeech({ container: root(), steps: 8 });
    expect(phrases).toEqual([
      "button, Prev",
      "‹",
      "end of button, Prev",
      "region, Products",
      "items",
      "end of region, Products",
      "button, Next",
      "›",
      "end of button, Next",
    ]);
  });
});
