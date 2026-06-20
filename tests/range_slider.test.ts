import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RangeSliderController } from "../src/controllers/range_slider_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link RangeSliderController}: the APG multi-thumb Slider
 * contract — per-thumb stepping, the mutual `start ≤ end` constraint reflected on
 * each thumb's `aria-valuemin`/`aria-valuemax`, pointer selection of the nearest
 * thumb, and the `--stimeo-range-start`/`--stimeo-range-end` custom properties.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("RangeSliderController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--range-slider"
           data-stimeo--range-slider-min-value="0"
           data-stimeo--range-slider-max-value="100"
           data-stimeo--range-slider-step-value="10"
           data-stimeo--range-slider-start-value="20"
           data-stimeo--range-slider-end-value="80">
        <div data-stimeo--range-slider-target="track"
             data-action="pointerdown->stimeo--range-slider#onPointerDown">
          <div data-stimeo--range-slider-target="startThumb" role="slider" tabindex="0"
               aria-label="Minimum"
               data-action="keydown->stimeo--range-slider#onKeydown"></div>
          <div data-stimeo--range-slider-target="endThumb" role="slider" tabindex="0"
               aria-label="Maximum"
               data-action="keydown->stimeo--range-slider#onKeydown"></div>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--range-slider", RangeSliderController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--range-slider']") as HTMLElement;
  const startThumb = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--range-slider-target='startThumb']",
    ) as HTMLElement;
  const endThumb = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--range-slider-target='endThumb']",
    ) as HTMLElement;
  const press = (thumb: HTMLElement, key: string) =>
    thumb.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

  it("orders a reversed initial start/end by swapping (not collapsing)", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--range-slider"
           data-stimeo--range-slider-min-value="0"
           data-stimeo--range-slider-max-value="100"
           data-stimeo--range-slider-step-value="10"
           data-stimeo--range-slider-start-value="80"
           data-stimeo--range-slider-end-value="20">
        <div data-stimeo--range-slider-target="track">
          <div data-stimeo--range-slider-target="startThumb" role="slider" tabindex="0"
               aria-label="Minimum"></div>
          <div data-stimeo--range-slider-target="endThumb" role="slider" tabindex="0"
               aria-label="Maximum"></div>
        </div>
      </div>`;
    await tick();
    // Both values are preserved, just ordered — not collapsed to a single point.
    expect(startThumb().getAttribute("aria-valuenow")).toBe("20");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("80");
  });

  it("reflects the initial pair, mutual bounds, and fractions", () => {
    expect(startThumb().getAttribute("aria-valuenow")).toBe("20");
    expect(startThumb().getAttribute("aria-valuemin")).toBe("0");
    expect(startThumb().getAttribute("aria-valuemax")).toBe("80");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("80");
    expect(endThumb().getAttribute("aria-valuemin")).toBe("20");
    expect(endThumb().getAttribute("aria-valuemax")).toBe("100");
    expect(root().style.getPropertyValue("--stimeo-range-start")).toBe("0.2");
    expect(root().style.getPropertyValue("--stimeo-range-end")).toBe("0.8");
  });

  it("steps the start thumb and updates the end thumb's lower bound", () => {
    press(startThumb(), "ArrowRight");
    expect(startThumb().getAttribute("aria-valuenow")).toBe("30");
    expect(endThumb().getAttribute("aria-valuemin")).toBe("30");
  });

  it("does not let the start thumb cross the end thumb", () => {
    for (let i = 0; i < 10; i += 1) press(startThumb(), "ArrowRight");
    // start clamps at the current end value (80), never past it.
    expect(startThumb().getAttribute("aria-valuenow")).toBe("80");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("80");
  });

  it("does not let the end thumb cross the start thumb", () => {
    for (let i = 0; i < 10; i += 1) press(endThumb(), "ArrowLeft");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("20");
    expect(startThumb().getAttribute("aria-valuenow")).toBe("20");
  });

  it("jumps each thumb to its movable bound on Home/End", () => {
    press(startThumb(), "Home");
    expect(startThumb().getAttribute("aria-valuenow")).toBe("0");
    press(startThumb(), "End");
    // End for the start thumb is the end thumb's value (80).
    expect(startThumb().getAttribute("aria-valuenow")).toBe("80");
  });

  it("moves by ten steps on PageUp/PageDown", () => {
    press(endThumb(), "PageDown");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("20");
  });

  it("dispatches change with the new pair", () => {
    const detail: Array<{ start: number; end: number }> = [];
    root().addEventListener("stimeo--range-slider:change", (e) => {
      detail.push((e as CustomEvent).detail);
    });
    press(startThumb(), "ArrowRight");
    expect(detail).toEqual([{ start: 30, end: 80 }]);
  });

  it("moves the nearest thumb on a track pointer press", () => {
    const track = document.querySelector<HTMLElement>("[data-stimeo--range-slider-target='track']");
    if (!track) throw new Error("track not found");
    track.getBoundingClientRect = () => stubRect(200);
    // X=180 → value 90, nearer the end thumb (80) than the start (20).
    track.dispatchEvent(new PointerEvent("pointerdown", { clientX: 180, bubbles: true }));
    expect(endThumb().getAttribute("aria-valuenow")).toBe("90");
    expect(startThumb().getAttribute("aria-valuenow")).toBe("20");
  });

  it("has no machine-detectable a11y violations", async () => {
    await expectNoA11yViolations(root());
  });

  // Layer ③ — speech-order regression scoped to each thumb. Pins role, name,
  // the live mutual bounds, and the value so a lost role/name or a stale bound
  // surfaces as a diff.
  it("announces each thumb's role, name, bounds, and value", async () => {
    const start = await captureSpeech({ container: startThumb(), steps: 0 });
    expect(start).toEqual([
      "slider, Minimum, orientated horizontally, max value 80, min value 0, 20",
    ]);
    const end = await captureSpeech({ container: endThumb(), steps: 0 });
    expect(end).toEqual([
      "slider, Maximum, orientated horizontally, max value 100, min value 20, 80",
    ]);
  });

  it("removes drag listeners on disconnect so a later pointermove is ignored", () => {
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--range-slider",
    ) as RangeSliderController;
    const track = document.querySelector<HTMLElement>("[data-stimeo--range-slider-target='track']");
    if (!track) throw new Error("track not found");
    track.getBoundingClientRect = () => stubRect(200);

    track.dispatchEvent(new PointerEvent("pointerdown", { clientX: 180, bubbles: true }));
    expect(endThumb().getAttribute("aria-valuenow")).toBe("90");

    controller.disconnect();
    document.dispatchEvent(new PointerEvent("pointermove", { clientX: 0, bubbles: true }));
    expect(endThumb().getAttribute("aria-valuenow")).toBe("90");
  });
});

/** A non-zero DOMRect so happy-dom's zero-size geometry doesn't short-circuit. */
function stubRect(width: number): DOMRect {
  return {
    left: 0,
    width,
    top: 0,
    height: 10,
    right: width,
    bottom: 10,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}
