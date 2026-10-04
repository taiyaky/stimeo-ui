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

  it("keeps retained morph safe while the viewport target is absent", async () => {
    await start();
    layout({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 });
    expect(viewport().getAttribute("data-overflow-end")).toBe("true");
    const retained = viewport();
    retained.removeAttribute("data-stimeo--overflow-indicator-target");
    await tick();
    const changes = vi.fn();
    root().addEventListener("stimeo--overflow-indicator:change", changes);
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();
    expect(changes).not.toHaveBeenCalled();
    expect(retained.getAttribute("data-overflow-end")).toBe("true");
    retained.setAttribute("data-stimeo--overflow-indicator-target", "viewport");
    await tick();
    layout({ scrollLeft: 700, scrollWidth: 1000, clientWidth: 300 });
    expect(retained.getAttribute("data-overflow-end")).toBe("false");
  });

  it("ignores an invalid direction while a newly inserted viewport awaits connection", async () => {
    document.body.innerHTML = markup.replace(
      'data-stimeo--overflow-indicator-target="viewport"',
      'id="pending-viewport"',
    );
    application = Application.start();
    application.register("stimeo--overflow-indicator", OverflowIndicatorController);
    await tick();
    const pending = document.querySelector<HTMLElement>("#pending-viewport");
    if (!pending) throw new Error("Expected the pending viewport");
    const scroll = vi.fn();
    pending.scrollBy = scroll;
    pending.setAttribute("data-stimeo--overflow-indicator-target", "viewport");
    const invalid = button("end");
    invalid.setAttribute("data-stimeo--overflow-indicator-direction-param", "sideways");
    invalid.click();
    expect(scroll).not.toHaveBeenCalled();
    await tick();
    layout({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 });
    invalid.setAttribute("data-stimeo--overflow-indicator-direction-param", "end");
    invalid.disabled = false;
    invalid.click();
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ left: 300, behavior: "smooth" });
  });

  it("stops viewport observation when a batch removes every candidate", async () => {
    await start();
    const errors: Error[] = [];
    application.handleError = (error) => {
      errors.push(error);
    };
    layout({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 });
    const first = viewport();
    const second = document.createElement("div");
    second.setAttribute("data-stimeo--overflow-indicator-target", "viewport");
    root().append(second);
    await tick();
    expect(first.getAttribute("data-overflow-end")).toBe("true");
    second.removeAttribute("data-stimeo--overflow-indicator-target");
    first.removeAttribute("data-stimeo--overflow-indicator-target");
    await tick();
    expect(errors).toEqual([]);
    first.setAttribute("data-stimeo--overflow-indicator-target", "viewport");
    await tick();
    layout({ scrollLeft: 700, scrollWidth: 1000, clientWidth: 300 });
    expect(first.getAttribute("data-overflow-end")).toBe("false");
    expect(errors).toEqual([]);
  });

  it("cancels the old viewport frame when the same target moves within the root", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      frames.delete(handle);
    });
    await start();
    layout({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 });
    const retained = viewport();
    Object.defineProperty(retained, "scrollLeft", { configurable: true, value: 300 });
    retained.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(1);
    root().append(retained);
    await tick();
    expect(frames.size).toBe(0);
    expect(retained.getAttribute("data-overflow-start")).toBe("true");
  });

  it("does not claim a nested owner's buttons while its viewport is absent", async () => {
    await start();
    const nested = document.createElement("div");
    nested.setAttribute("data-controller", "stimeo--overflow-indicator");
    nested.innerHTML =
      '<button data-stimeo--overflow-indicator-direction-param="start">Nested start</button>';
    root().append(nested);
    await tick();
    layout({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 });
    const nestedButton = nested.querySelector<HTMLButtonElement>("button");
    expect(nestedButton?.disabled).toBe(false);
    expect(nestedButton?.hasAttribute("data-overflow-indicator-disabled")).toBe(false);
    expect(button("start").disabled).toBe(true);
  });

  it("returns stale pending ARIA before disabling an unfocused boundary button", async () => {
    document.body.innerHTML = markup;
    const restored = button("end");
    restored.setAttribute("data-overflow-indicator-pending-disabled", "");
    restored.setAttribute("data-overflow-indicator-aria-disabled", "false");
    restored.setAttribute("aria-disabled", "true");
    application = Application.start();
    application.register("stimeo--overflow-indicator", OverflowIndicatorController);
    await tick();
    expect(restored.disabled).toBe(true);
    expect(restored.getAttribute("aria-disabled")).toBe("false");
    expect(restored.hasAttribute("data-overflow-indicator-pending-disabled")).toBe(false);
    expect(restored.hasAttribute("data-overflow-indicator-aria-disabled")).toBe(false);
  });

  it("retains the authored ARIA value across repeated pending boundary measurements", async () => {
    await start();
    layout({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 300 });
    const pending = button("end");
    pending.setAttribute("aria-disabled", "false");
    pending.focus();
    layout({ scrollLeft: 700, scrollWidth: 1000, clientWidth: 300 });
    expect(pending.getAttribute("data-overflow-indicator-aria-disabled")).toBe("false");
    layout({ scrollLeft: 700, scrollWidth: 1000, clientWidth: 300 });
    expect(pending.getAttribute("data-overflow-indicator-aria-disabled")).toBe("false");
    expect(pending.disabled).toBe(false);
    viewport().focus();
    expect(pending.disabled).toBe(true);
    expect(pending.getAttribute("aria-disabled")).toBe("false");
  });

  it("keeps the observed viewport generation when an unused candidate arrives", async () => {
    await start();
    layout({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 });
    const changes = vi.fn();
    root().addEventListener("stimeo--overflow-indicator:change", changes);
    const secondary = document.createElement("div");
    secondary.setAttribute("data-stimeo--overflow-indicator-target", "viewport");
    root().append(secondary);
    await tick();
    expect(changes).not.toHaveBeenCalled();
    layout({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 300 });
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("ignores content observer callbacks from a released viewport generation", async () => {
    const NativeObserver = globalThis.MutationObserver;
    const observations: Array<{ callback: MutationCallback; observer: MutationObserver }> = [];
    class RecordingObserver extends NativeObserver {
      readonly #callback: MutationCallback;
      constructor(callback: MutationCallback) {
        super(callback);
        this.#callback = callback;
      }
      override observe(target: Node, options?: MutationObserverInit): void {
        if (options?.attributeFilter?.join(",") === "class,style,hidden") {
          observations.push({ callback: this.#callback, observer: this });
        }
        super.observe(target, options);
      }
    }
    vi.stubGlobal("MutationObserver", RecordingObserver);
    await start();
    layout({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 });
    const stale = observations.at(-1);
    const replacement = document.createElement("div");
    replacement.setAttribute("data-stimeo--overflow-indicator-target", "viewport");
    viewport().replaceWith(replacement);
    await tick();
    layout({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 });
    const current = observations.at(-1);
    if (!stale || !current || stale === current)
      throw new Error("Expected two observation generations");
    const changes = vi.fn();
    root().addEventListener("stimeo--overflow-indicator:change", changes);
    Object.defineProperty(replacement, "scrollLeft", { configurable: true, value: 300 });
    stale.callback([], stale.observer);
    expect(replacement.getAttribute("data-overflow-start")).toBe("false");
    expect(changes).not.toHaveBeenCalled();
    current.callback([], current.observer);
    expect(replacement.getAttribute("data-overflow-start")).toBe("true");
    expect(changes).toHaveBeenCalledTimes(1);
    const instance = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--overflow-indicator",
    );
    instance?.disconnect();
    replacement.setAttribute("data-overflow-start", "consumer");
    current.callback([], current.observer);
    expect(replacement.getAttribute("data-overflow-start")).toBe("consumer");
  });

  it.each(["abc", "Infinity"])(
    "keeps scroll room measurable with a %s threshold",
    async (threshold) => {
      await start();
      root().setAttribute("data-stimeo--overflow-indicator-threshold-value", threshold);
      await tick();
      layout({ scrollLeft: 10, scrollWidth: 1000, clientWidth: 300 });
      expect(viewport().getAttribute("data-overflow-start")).toBe("true");
      expect(viewport().getAttribute("data-overflow-end")).toBe("true");
    },
  );

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

  it("marks a focused boundary button with the pending hook until it blurs", async () => {
    await start();
    layout({ scrollLeft: 300, scrollWidth: 1000, clientWidth: 300 });
    button("end").focus();

    layout({ scrollLeft: 700, scrollWidth: 1000, clientWidth: 300 });
    expect(button("end").hasAttribute("data-overflow-indicator-pending-disabled")).toBe(true);

    viewport().focus();
    expect(button("end").hasAttribute("data-overflow-indicator-pending-disabled")).toBe(false);
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

    // Disconnect releases the controller-owned pending state from the live DOM.
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
    // The markup contract requires the viewport target, but a degraded / mid-morph
    // DOM must not throw: a resize and scrollByPage() simply do nothing.
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
    expect(scrollBy).toHaveBeenCalledWith({ left: 300, behavior: "instant" });
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
    expect(scrollBy).toHaveBeenCalledWith({ top: 300, behavior: "instant" });
    button("start").click();
    expect(scrollBy).toHaveBeenLastCalledWith({ top: -300, behavior: "instant" });
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

  it("rebinds layout and content observation when a new first viewport connects", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    await start();
    layout({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 });
    const oldViewport = viewport();
    const oldContent = oldViewport.firstElementChild as HTMLElement;
    const replacement = document.createElement("div");
    replacement.setAttribute("data-stimeo--overflow-indicator-target", "viewport");
    replacement.innerHTML = "<span>replacement</span>";
    Object.defineProperties(replacement, {
      scrollLeft: { configurable: true, value: 0 },
      scrollWidth: { configurable: true, value: 1000 },
      clientWidth: { configurable: true, value: 300 },
    });

    // Rebind while the old target remains connected, so its disconnected callback
    // cannot release the observations on behalf of the new target's connection.
    oldViewport.before(replacement);
    await tick();

    expect(viewport()).toBe(replacement);
    expect(replacement.getAttribute("data-overflow-end")).toBe("true");
    const observed = FakeResizeObserver.instances[0]?.observed;
    expect(observed?.has(oldViewport)).toBe(false);
    expect(observed?.has(oldContent)).toBe(false);
    expect(observed?.has(replacement)).toBe(true);
    expect(observed?.has(replacement.firstElementChild as Element)).toBe(true);
  });

  it("keeps observing the content of a viewport that moves within the root", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    await start();
    const retained = viewport();
    const content = retained.firstElementChild as HTMLElement;

    root().append(retained);
    await tick();

    const observed = FakeResizeObserver.instances[0]?.observed;
    expect(observed?.has(retained)).toBe(true);
    expect(observed?.has(content)).toBe(true);
  });

  it("follows content added to, removed from and returned to the viewport", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    await start();
    const observed = FakeResizeObserver.instances[0]?.observed;
    const content = viewport().firstElementChild as HTMLElement;
    const added = document.createElement("span");

    viewport().append(added);
    await tick();
    expect(observed?.has(added)).toBe(true);

    content.remove();
    await tick();
    expect(observed?.has(content)).toBe(false);

    viewport().append(content);
    await tick();
    expect(observed?.has(content)).toBe(true);
  });

  it("moves observation to the remaining viewport candidate when the observed one leaves", async () => {
    await start();
    layout({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 });
    const first = viewport();
    const second = document.createElement("div");
    second.setAttribute("data-stimeo--overflow-indicator-target", "viewport");
    Object.defineProperties(second, {
      scrollLeft: { configurable: true, value: 700 },
      scrollWidth: { configurable: true, value: 1000 },
      clientWidth: { configurable: true, value: 300 },
    });
    root().append(second);
    await tick();
    expect(second.hasAttribute("data-overflow-start")).toBe(false);

    first.removeAttribute("data-stimeo--overflow-indicator-target");
    await tick();

    expect(second.getAttribute("data-overflow-start")).toBe("true");
    expect(second.getAttribute("data-overflow-end")).toBe("false");
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

  // The two axes are read from different properties, so a runtime orientation
  // change has to re-measure: the geometry below is at the end horizontally and at
  // the start vertically, which is the only shape that tells the two apart.
  it("switches which axis it measures when orientation changes at runtime", async () => {
    await start();
    layout({
      scrollLeft: 700,
      scrollWidth: 1000,
      clientWidth: 300,
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 300,
    });
    expect(viewport().getAttribute("data-overflow-start")).toBe("true");
    expect(viewport().getAttribute("data-overflow-end")).toBe("false");

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
        <div id="outer-viewport" data-stimeo--overflow-indicator-target="viewport"></div>
        <div id="inner" data-controller="stimeo--overflow-indicator">
          <button id="inner-start" type="button"
                  data-stimeo--overflow-indicator-direction-param="start"
                  data-action="click->stimeo--overflow-indicator#scrollByPage">Inner start</button>
          <div id="inner-viewport" data-stimeo--overflow-indicator-target="viewport"></div>
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

  // The viewport's scroll is a measurement input the widget subscribes to itself,
  // so the buttons read the scrolled state with no action wired by the consumer.
  it("re-measures on the viewport's own scroll, without any wired action", async () => {
    await start();
    layout({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 });
    expect(viewport().getAttribute("data-overflow-start")).toBe("false");

    Object.defineProperty(viewport(), "scrollLeft", { configurable: true, value: 300 });
    viewport().dispatchEvent(new Event("scroll"));
    await tick();

    expect(viewport().getAttribute("data-overflow-start")).toBe("true");
    expect(button("start").disabled).toBe(false);
  });

  it("measures once per frame however many scrolls arrive in it", async () => {
    await start();
    layout({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 });
    const writes = vi.spyOn(viewport(), "setAttribute");
    const frames = vi.spyOn(globalThis, "requestAnimationFrame");

    Object.defineProperty(viewport(), "scrollLeft", { configurable: true, value: 300 });
    viewport().dispatchEvent(new Event("scroll"));
    viewport().dispatchEvent(new Event("scroll"));
    viewport().dispatchEvent(new Event("scroll"));
    await tick();

    expect(frames).toHaveBeenCalledOnce();
    expect(
      writes.mock.calls.filter(([attribute]) => attribute === "data-overflow-start"),
    ).toHaveLength(1);
  });

  it("stops listening to a viewport it no longer holds", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    await start();
    layout({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 });
    const oldViewport = viewport();
    const replacement = document.createElement("div");
    replacement.setAttribute("data-stimeo--overflow-indicator-target", "viewport");
    replacement.innerHTML = "<span>replacement</span>";
    Object.defineProperties(replacement, {
      scrollLeft: { configurable: true, value: 0 },
      scrollWidth: { configurable: true, value: 1000 },
      clientWidth: { configurable: true, value: 300 },
    });
    oldViewport.replaceWith(replacement);
    await tick();
    // The measurement, not the attributes, is what tells a released listener from
    // a live one: a stale listener would re-measure the *current* viewport, whose
    // geometry writes the same values the release already left behind.
    const frames = vi.spyOn(globalThis, "requestAnimationFrame");

    Object.defineProperty(oldViewport, "scrollLeft", { configurable: true, value: 300 });
    oldViewport.dispatchEvent(new Event("scroll"));
    await tick();

    expect(frames).not.toHaveBeenCalled();
    expect(oldViewport.getAttribute("data-overflow-start")).toBe("false");
    expect(replacement.getAttribute("data-overflow-start")).toBe("false");
  });

  // A frame requested before the release would otherwise run afterwards and write
  // the state hooks back onto a viewport the teardown already let go.
  it("drops a frame it requested before letting the viewport go", async () => {
    const pending = new Map<number, FrameRequestCallback>();
    let nextHandle = 1;
    const cancelled: number[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const handle = nextHandle++;
      pending.set(handle, callback);
      return handle;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      cancelled.push(handle);
      pending.delete(handle);
    });

    await start();
    layout({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 });
    Object.defineProperty(viewport(), "scrollLeft", { configurable: true, value: 300 });
    viewport().dispatchEvent(new Event("scroll"));
    expect(pending.size).toBe(1);
    const writes = vi.spyOn(viewport(), "setAttribute");

    application
      .getControllerForElementAndIdentifier(root(), "stimeo--overflow-indicator")
      ?.disconnect();

    expect(cancelled).toHaveLength(1);
    // Running whatever the engine might still deliver must write nothing.
    for (const callback of [...pending.values()]) callback(0);
    expect(writes).not.toHaveBeenCalled();
  });

  it("stops scroll, mutation, and load-driven updates after unload", async () => {
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

  it("releases the window and load listeners when the viewport leaves with no successor", async () => {
    document.body.innerHTML = markup;
    const released = viewport();
    const windowAdded = vi.spyOn(window, "addEventListener");
    const windowRemoved = vi.spyOn(window, "removeEventListener");
    const added = vi.spyOn(released, "addEventListener");
    const removed = vi.spyOn(released, "removeEventListener");
    application = Application.start();
    application.register("stimeo--overflow-indicator", OverflowIndicatorController);
    await tick();
    const onResize = windowAdded.mock.calls.find(([type]) => type === "resize");
    const onLoad = added.mock.calls.find(([type]) => type === "load");
    if (!onResize || !onLoad) throw new Error("Expected the resize and load listeners");

    released.removeAttribute("data-stimeo--overflow-indicator-target");
    await tick();

    expect(windowRemoved).toHaveBeenCalledWith(...onResize);
    expect(removed).toHaveBeenCalledWith(...onLoad);
  });

  it("stops observing mutations under the root on disconnect", async () => {
    const NativeObserver = globalThis.MutationObserver;
    let observer: MutationObserver | null = null;
    let deliveries = 0;
    class RecordingObserver extends NativeObserver {
      constructor(callback: MutationCallback) {
        super((records, self) => {
          if (self === observer) deliveries += 1;
          callback(records, self);
        });
      }
      override observe(target: Node, options?: MutationObserverInit): void {
        if (options?.attributeFilter?.join(",") === "class,style,hidden") observer = this;
        super.observe(target, options);
      }
    }
    vi.stubGlobal("MutationObserver", RecordingObserver);
    await start();
    const content = viewport().firstElementChild as HTMLElement;
    content.classList.add("wide");
    await tick();
    const seen = deliveries;
    expect(seen).toBeGreaterThan(0);

    application
      .getControllerForElementAndIdentifier(root(), "stimeo--overflow-indicator")
      ?.disconnect();
    content.classList.remove("wide");
    await tick();

    expect(deliveries).toBe(seen);
  });

  it("releases its resize observer on disconnect", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    await start();
    const resizeObserver = FakeResizeObserver.instances[0];
    if (!resizeObserver) throw new Error("Expected a resize observer");
    const released = vi.spyOn(resizeObserver, "disconnect");

    application
      .getControllerForElementAndIdentifier(root(), "stimeo--overflow-indicator")
      ?.disconnect();

    expect(released).toHaveBeenCalledOnce();
  });

  // Stimulus delivers the initial Value callbacks before `connect()` runs. Measuring
  // then would report a transition from the null state that the connection is about
  // to report again, so the very first render would announce itself twice.
  it("reports the initial state once, not once per Value callback", async () => {
    const changes: unknown[] = [];
    document.addEventListener("stimeo--overflow-indicator:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });

    await start();

    expect(changes).toHaveLength(1);
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

  // --- Speech order -----------------------------------------------------------

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
