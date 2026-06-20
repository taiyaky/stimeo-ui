import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SliderController } from "../src/controllers/slider_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link SliderController}: the APG Slider contract —
 * `aria-valuenow` bounds/stepping, keyboard control, and the
 * `--stimeo--slider-fraction` custom property exposed to the consumer's CSS.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SliderController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--slider"
           data-stimeo--slider-min-value="0"
           data-stimeo--slider-max-value="100"
           data-stimeo--slider-step-value="10"
           data-stimeo--slider-value-value="40">
        <div data-stimeo--slider-target="track"
             data-action="pointerdown->stimeo--slider#onPointerDown">
          <div data-stimeo--slider-target="thumb" role="slider" tabindex="0"
               aria-label="Volume"
               data-action="keydown->stimeo--slider#onKeydown"></div>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--slider", SliderController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--slider']") as HTMLElement;
  const thumb = () =>
    document.querySelector<HTMLElement>("[data-stimeo--slider-target='thumb']") as HTMLElement;
  const press = (key: string) =>
    thumb().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  const fraction = () => root().style.getPropertyValue("--stimeo--slider-fraction");

  it("reflects the initial value and fraction", () => {
    expect(thumb().getAttribute("aria-valuenow")).toBe("40");
    expect(thumb().getAttribute("aria-valuemin")).toBe("0");
    expect(thumb().getAttribute("aria-valuemax")).toBe("100");
    expect(fraction()).toBe("0.4");
  });

  it("dispatches change with the new value on a real change, not at connect or bounds", () => {
    const values: number[] = [];
    root().addEventListener("stimeo--slider:change", (e) =>
      values.push((e as CustomEvent).detail.value),
    );
    press("ArrowRight"); // 40 -> 50
    expect(values).toEqual([50]);
    press("End"); // -> 100
    press("ArrowRight"); // already at max: no change, no event
    expect(values).toEqual([50, 100]);
  });

  it("increments by one step on ArrowRight", () => {
    press("ArrowRight");
    expect(thumb().getAttribute("aria-valuenow")).toBe("50");
    expect(fraction()).toBe("0.5");
  });

  it("decrements by one step on ArrowDown", () => {
    press("ArrowDown");
    expect(thumb().getAttribute("aria-valuenow")).toBe("30");
  });

  it("clamps at the maximum", () => {
    for (let i = 0; i < 10; i += 1) press("ArrowRight");
    expect(thumb().getAttribute("aria-valuenow")).toBe("100");
    expect(fraction()).toBe("1");
  });

  it("jumps to min on Home and max on End", () => {
    press("Home");
    expect(thumb().getAttribute("aria-valuenow")).toBe("0");
    press("End");
    expect(thumb().getAttribute("aria-valuenow")).toBe("100");
  });

  it("moves by ten steps on PageDown", () => {
    press("PageDown");
    expect(thumb().getAttribute("aria-valuenow")).toBe("0");
  });

  it("moves by ten steps on PageUp (clamped at max)", () => {
    press("PageUp"); // 40 + 10*10 = 140 → clamped to 100
    expect(thumb().getAttribute("aria-valuenow")).toBe("100");
  });

  it("ignores unrelated keys without preventing default", () => {
    const event = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    thumb().dispatchEvent(event);
    expect(thumb().getAttribute("aria-valuenow")).toBe("40");
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores a pointer press when the track has zero width", () => {
    const track = document.querySelector<HTMLElement>("[data-stimeo--slider-target='track']");
    if (!track) throw new Error("track not found");
    track.getBoundingClientRect = () =>
      ({
        left: 0,
        width: 0,
        top: 0,
        height: 0,
        right: 0,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    track.dispatchEvent(new PointerEvent("pointerdown", { clientX: 150, bubbles: true }));
    expect(thumb().getAttribute("aria-valuenow")).toBe("40"); // unchanged
  });

  it("sets the value from a pointer press on the track", () => {
    const track = document.querySelector<HTMLElement>("[data-stimeo--slider-target='track']");
    if (!track) throw new Error("track not found");
    // happy-dom returns a zero-size rect; stub geometry so the math is exercised.
    track.getBoundingClientRect = () =>
      ({
        left: 0,
        width: 200,
        top: 0,
        height: 10,
        right: 200,
        bottom: 10,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    track.dispatchEvent(new PointerEvent("pointerdown", { clientX: 150, bubbles: true }));
    expect(thumb().getAttribute("aria-valuenow")).toBe("80");
  });

  // Layer ① — machine-detectable a11y.
  it("has no machine-detectable a11y violations", async () => {
    await expectNoA11yViolations(root());
  });

  // Layer ③ — speech-order regression. Scoping to the thumb (the `role="slider"`
  // element) yields a single, deterministic announcement; capturing it before
  // and after a keyboard step pins role, accessible name, bounds, and the
  // announced value so a lost role/name or a stale value surfaces as a diff.
  it("announces the slider role, name, bounds, and value before and after a step", async () => {
    const before = await captureSpeech({ container: thumb(), steps: 0 });
    expect(before).toEqual([
      "slider, Volume, orientated horizontally, max value 100, min value 0, 40",
    ]);

    press("ArrowRight");

    const after = await captureSpeech({ container: thumb(), steps: 0 });
    expect(after).toEqual([
      "slider, Volume, orientated horizontally, max value 100, min value 0, 50",
    ]);
  });

  // Disconnect-teardown regression: the drag's `document` listeners are bound to
  // an AbortController aborted in disconnect(), so a pointermove after teardown
  // must not move the value (no leaked listener).
  it("removes drag listeners on disconnect so a later pointermove is ignored", () => {
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--slider",
    ) as SliderController;
    const track = document.querySelector<HTMLElement>("[data-stimeo--slider-target='track']");
    if (!track) throw new Error("track not found");
    track.getBoundingClientRect = () =>
      ({
        left: 0,
        width: 200,
        top: 0,
        height: 10,
        right: 200,
        bottom: 10,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    track.dispatchEvent(new PointerEvent("pointerdown", { clientX: 150, bubbles: true }));
    expect(thumb().getAttribute("aria-valuenow")).toBe("80");

    // Tearing the controller down mid-drag (the path application.stop() also
    // triggers) must abort the document drag listeners.
    controller.disconnect();

    document.dispatchEvent(new PointerEvent("pointermove", { clientX: 0, bubbles: true }));
    expect(thumb().getAttribute("aria-valuenow")).toBe("80");
  });
});
