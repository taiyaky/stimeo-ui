import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverflowIndicatorController } from "../src/controllers/overflow_indicator_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link OverflowIndicatorController}: the
 * `data-overflow-start`/`data-overflow-end` sync from scroll geometry, the
 * `change` event, the button `disabled` mirroring, `scrollByPage` direction
 * handling, and resize teardown.
 *
 * happy-dom has no layout, so `scrollLeft`/`scrollWidth`/`clientWidth` are stubbed
 * and a viewport resize drives the controller; `scrollBy` is mocked.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const markup = `
  <div data-controller="stimeo--overflow-indicator"
       data-stimeo--overflow-indicator-orientation-value="horizontal">
    <button type="button" aria-label="Prev"
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

describe("OverflowIndicatorController", () => {
  let application: Application;

  const start = async () => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--overflow-indicator", OverflowIndicatorController);
    await tick();
  };

  afterEach(() => {
    application.stop();
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

  /** Stubs horizontal scroll geometry and notifies via a viewport resize. */
  const layout = (geometry: { scrollLeft: number; scrollWidth: number; clientWidth: number }) => {
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
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ left: 300 }));
    button("start").click();
    expect(scrollBy).toHaveBeenLastCalledWith(expect.objectContaining({ left: -300 }));
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
