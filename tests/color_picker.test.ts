import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { ColorPickerController } from "../src/controllers/color_picker_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link ColorPickerController}: per-channel APG Slider
 * values, HSL↔hex two-way sync, the `--stimeo-color` custom property, the hidden
 * field mirror, `aria-valuetext`, and the `change` event.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const markup = (attrs = "", { alpha = false } = {}) => `
  <div data-controller="stimeo--color-picker" ${attrs}>
    <div role="slider" aria-label="Hue" data-channel="hue" tabindex="0"
         aria-valuemin="0" aria-valuemax="360"
         data-stimeo--color-picker-target="slider"
         data-action="keydown->stimeo--color-picker#onKeydown
                      pointerdown->stimeo--color-picker#onPointerDown"></div>
    <div role="slider" aria-label="Saturation" data-channel="saturation" tabindex="0"
         aria-valuemin="0" aria-valuemax="100"
         data-stimeo--color-picker-target="slider"
         data-action="keydown->stimeo--color-picker#onKeydown"></div>
    <div role="slider" aria-label="Lightness" data-channel="lightness" tabindex="0"
         aria-valuemin="0" aria-valuemax="100"
         data-stimeo--color-picker-target="slider"
         data-action="keydown->stimeo--color-picker#onKeydown"></div>
    ${
      alpha
        ? `<div role="slider" aria-label="Alpha" data-channel="alpha" tabindex="0"
         aria-valuemin="0" aria-valuemax="100"
         data-stimeo--color-picker-target="slider"
         data-action="keydown->stimeo--color-picker#onKeydown"></div>`
        : ""
    }
    <input type="text" aria-label="Hex color" data-stimeo--color-picker-target="hex"
           data-action="change->stimeo--color-picker#onHexInput" />
    <div data-stimeo--color-picker-target="preview" aria-hidden="true"></div>
    <input type="hidden" data-stimeo--color-picker-target="field" />
  </div>`;

describe("ColorPickerController", () => {
  let application: Application;

  const start = async (attrs = "", options = {}) => {
    document.body.innerHTML = markup(attrs, options);
    application = Application.start();
    application.register("stimeo--color-picker", ColorPickerController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--color-picker']") as HTMLElement;
  const slider = (channel: string) =>
    document.querySelector<HTMLElement>(`[data-channel='${channel}']`) as HTMLElement;
  const hex = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--color-picker-target='hex']",
    ) as HTMLInputElement;
  const field = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--color-picker-target='field']",
    ) as HTMLInputElement;
  const color = () => root().style.getPropertyValue("--stimeo-color");
  const press = (el: HTMLElement, key: string) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

  it("seeds every channel and surface from the initial hex value", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    expect(slider("hue").getAttribute("aria-valuenow")).toBe("0");
    expect(slider("saturation").getAttribute("aria-valuenow")).toBe("100");
    expect(slider("lightness").getAttribute("aria-valuenow")).toBe("50");
    expect(hex().value).toBe("#ff0000");
    expect(field().value).toBe("#ff0000");
    expect(color()).toBe("#ff0000");
  });

  it("exposes a human-readable aria-valuetext per channel", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    expect(slider("hue").getAttribute("aria-valuetext")).toBe("Hue 0 degrees");
    expect(slider("saturation").getAttribute("aria-valuetext")).toBe("Saturation 100 percent");
    expect(slider("lightness").getAttribute("aria-valuetext")).toBe("Lightness 50 percent");
  });

  it("steps a channel with the arrow keys and recomputes the hex", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    press(slider("hue"), "ArrowRight");
    expect(slider("hue").getAttribute("aria-valuenow")).toBe("1");
    // Hue 1°, full saturation/half lightness is still essentially red.
    expect(hex().value).toBe("#ff0400");
  });

  it("jumps to channel bounds with Home and End", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    press(slider("hue"), "End");
    expect(slider("hue").getAttribute("aria-valuenow")).toBe("360");
    press(slider("hue"), "Home");
    expect(slider("hue").getAttribute("aria-valuenow")).toBe("0");
  });

  it("moves by a larger step on PageUp/PageDown", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    press(slider("saturation"), "PageDown");
    expect(slider("saturation").getAttribute("aria-valuenow")).toBe("90");
  });

  it("syncs sliders from a valid hex input", async () => {
    await start();
    hex().value = "#00ff00";
    hex().dispatchEvent(new Event("change", { bubbles: true }));
    expect(slider("hue").getAttribute("aria-valuenow")).toBe("120");
    expect(slider("saturation").getAttribute("aria-valuenow")).toBe("100");
    expect(color()).toBe("#00ff00");
  });

  it("expands shorthand hex (#RGB) on input", async () => {
    await start();
    hex().value = "#0f0";
    hex().dispatchEvent(new Event("change", { bubbles: true }));
    expect(color()).toBe("#00ff00");
  });

  it("rejects an invalid hex by restoring the last valid value", async () => {
    await start('data-stimeo--color-picker-value-value="#3366cc"');
    hex().value = "nonsense";
    hex().dispatchEvent(new Event("change", { bubbles: true }));
    expect(hex().value).toBe("#3366cc");
  });

  it("emits change with the hex value and rgba", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    const detail: Array<{ value: string; rgba: { r: number; g: number; b: number; a: number } }> =
      [];
    root().addEventListener("stimeo--color-picker:change", (event) => {
      detail.push(
        (
          event as CustomEvent<{
            value: string;
            rgba: { r: number; g: number; b: number; a: number };
          }>
        ).detail,
      );
    });
    press(slider("hue"), "End"); // hue 0 -> 360 wraps back to red
    expect(detail.at(-1)?.value).toBe("#ff0000");
    expect(detail.at(-1)?.rgba).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it("includes the alpha byte in the hex when alpha is enabled", async () => {
    await start(
      'data-stimeo--color-picker-value-value="#ff0000" data-stimeo--color-picker-alpha-value="true"',
      {
        alpha: true,
      },
    );
    expect(slider("alpha").getAttribute("aria-valuenow")).toBe("100");
    expect(hex().value).toBe("#ff0000ff");
    press(slider("alpha"), "Home");
    expect(hex().value).toBe("#ff000000");
  });

  it("drops the alpha of an #RRGGBBAA initial value when alpha is disabled", async () => {
    // alpha defaults to false: a translucent initial value must be normalized to
    // opaque so the hex and the change event's rgba.a do not disagree.
    await start('data-stimeo--color-picker-value-value="#ff000080"');
    expect(hex().value).toBe("#ff0000");
    const detail: Array<{ rgba: { a: number } }> = [];
    root().addEventListener("stimeo--color-picker:change", (event) => {
      detail.push((event as CustomEvent<{ rgba: { a: number } }>).detail);
    });
    press(slider("hue"), "End"); // any change; rgba.a must be 1 (opaque)
    expect(detail.at(-1)?.rgba.a).toBe(1);
  });

  it("sets a channel from a pointer press on the slider", async () => {
    await start('data-stimeo--color-picker-value-value="#000000"');
    const hue = slider("hue");
    hue.getBoundingClientRect = () =>
      ({
        left: 0,
        width: 360,
        top: 0,
        height: 10,
        right: 360,
        bottom: 10,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    hue.dispatchEvent(new PointerEvent("pointerdown", { clientX: 180, bubbles: true }));
    expect(slider("hue").getAttribute("aria-valuenow")).toBe("180");
  });

  it("removes drag listeners on disconnect so a later pointermove is ignored", async () => {
    await start('data-stimeo--color-picker-value-value="#000000"');
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--color-picker",
    ) as ColorPickerController;
    const hue = slider("hue");
    hue.getBoundingClientRect = () =>
      ({
        left: 0,
        width: 360,
        top: 0,
        height: 10,
        right: 360,
        bottom: 10,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    hue.dispatchEvent(new PointerEvent("pointerdown", { clientX: 180, bubbles: true }));
    expect(slider("hue").getAttribute("aria-valuenow")).toBe("180");

    controller.disconnect();
    document.dispatchEvent(new PointerEvent("pointermove", { clientX: 0, bubbles: true }));
    expect(slider("hue").getAttribute("aria-valuenow")).toBe("180");
  });

  it("has no machine-detectable a11y violations", async () => {
    await start('data-stimeo--color-picker-value-value="#3366cc"');
    await expectNoA11yViolations(root());
  });

  // Layer ③ — speech-order regression: each channel announces its slider role,
  // name, bounds, and value text, so a dropped role/name surfaces as a diff.
  it("announces the hue slider role, name, and value text", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    const phrases = await captureSpeech({ container: slider("hue"), steps: 0 });
    expect(phrases).toEqual([
      "slider, Hue, orientated horizontally, max value 360, min value 0, current value Hue 0 degrees",
    ]);
  });
});
