import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { ColorPickerController } from "../src/controllers/color_picker_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ColorPickerController}: per-channel APG Slider
 * values, HSL↔hex two-way sync, the `--stimeo--color` custom property, the hidden
 * field mirror, `aria-valuetext`, and the `change` event.
 */

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
         data-action="keydown->stimeo--color-picker#onKeydown
                      pointerdown->stimeo--color-picker#onPointerDown"></div>
    <div role="slider" aria-label="Lightness" data-channel="lightness" tabindex="0"
         aria-valuemin="0" aria-valuemax="100"
         data-stimeo--color-picker-target="slider"
         data-action="keydown->stimeo--color-picker#onKeydown
                      pointerdown->stimeo--color-picker#onPointerDown"></div>
    ${
      alpha
        ? `<div role="slider" aria-label="Alpha" data-channel="alpha" tabindex="0"
         aria-valuemin="0" aria-valuemax="100"
         data-stimeo--color-picker-target="slider"
         data-action="keydown->stimeo--color-picker#onKeydown
                      pointerdown->stimeo--color-picker#onPointerDown"></div>`
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
    disconnectAndStopApplication(application);
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
  const preview = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--color-picker-target='preview']",
    ) as HTMLElement;
  const color = (element: HTMLElement = root()) =>
    element.style.getPropertyValue("--stimeo--color");
  const press = (el: HTMLElement, key: string) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  const declaredValue = () => root().getAttribute("data-stimeo--color-picker-value-value");
  /** Gives a channel slider a 360px track so a client X maps to a round fraction. */
  const track = (channel: string, width = 360) => {
    const element = slider(channel);
    element.getBoundingClientRect = () => new DOMRect(0, 0, width, 10);
    return element;
  };
  const pointerDown = (el: HTMLElement, init: PointerEventInit) => {
    const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(event);
    return event;
  };
  const pointerMove = (init: PointerEventInit) =>
    document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, ...init }));
  const pointerUp = (init: PointerEventInit = {}) =>
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, ...init }));
  /** Collects errors Stimulus catches, so a throwing handler is not silently green. */
  const captureErrors = () => {
    const errors: unknown[] = [];
    application.handleError = (error) => {
      errors.push(error);
    };
    return errors;
  };

  /** A hue-only picker whose range attributes are supplied verbatim by the case. */
  const startWithHueRange = async (range: string) => {
    document.body.innerHTML = `
      <div data-controller="stimeo--color-picker" data-stimeo--color-picker-value-value="#ff0000">
        <div role="slider" aria-label="Hue" data-channel="hue" tabindex="0" ${range}
             data-stimeo--color-picker-target="slider"
             data-action="keydown->stimeo--color-picker#onKeydown"></div>
        <input type="text" aria-label="Hex color" data-stimeo--color-picker-target="hex"
               data-action="change->stimeo--color-picker#onHexInput" />
      </div>`;
    application = Application.start();
    application.register("stimeo--color-picker", ColorPickerController);
    await tick();
  };

  it("seeds every channel and surface from the initial hex value", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    expect(slider("hue").getAttribute("aria-valuenow")).toBe("0");
    expect(slider("saturation").getAttribute("aria-valuenow")).toBe("100");
    expect(slider("lightness").getAttribute("aria-valuenow")).toBe("50");
    expect(hex().value).toBe("#ff0000");
    expect(field().value).toBe("#ff0000");
    expect(color()).toBe("#ff0000");
    expect(color(preview())).toBe("#ff0000");
  });

  it("starts from the default value when the markup names no color", async () => {
    // Black is the achromatic edge of the HSL conversion: a division by the zero
    // chroma would surface here as NaN in the hex.
    await start();
    expect(hex().value).toBe("#000000");
    expect(field().value).toBe("#000000");
    expect(color()).toBe("#000000");
    expect(color(preview())).toBe("#000000");
    expect(slider("saturation").getAttribute("aria-valuenow")).toBe("0");
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

  it("leaves a modified arrow to the browser", async () => {
    // Alt+Arrow is a browser binding: the slider neither steps its channel nor
    // calls preventDefault().
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    slider("hue").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(slider("hue").getAttribute("aria-valuenow")).toBe("0");
    expect(hex().value).toBe("#ff0000");
  });

  it("jumps to channel bounds with Home and End", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    press(slider("hue"), "End");
    expect(slider("hue").getAttribute("aria-valuenow")).toBe("360");
    press(slider("hue"), "Home");
    expect(slider("hue").getAttribute("aria-valuenow")).toBe("0");
  });

  it("falls back to the channel range when a slider omits aria-valuemin/max", async () => {
    await startWithHueRange("");
    // The resolved pair is announced, so a reader never hears the slider role's
    // 0–100 default over a hue that reaches 360.
    expect(slider("hue").getAttribute("aria-valuemin")).toBe("0");
    expect(slider("hue").getAttribute("aria-valuemax")).toBe("360");
    press(slider("hue"), "End");
    expect(slider("hue").getAttribute("aria-valuenow")).toBe("360");
    // Clamping still applies against the fallback maximum.
    press(slider("hue"), "ArrowRight");
    expect(slider("hue").getAttribute("aria-valuenow")).toBe("360");
    press(slider("hue"), "Home");
    expect(slider("hue").getAttribute("aria-valuenow")).toBe("0");
  });

  it("falls back to the channel range when aria-valuemax is blank", async () => {
    // A blank attribute coerces to 0 just like an absent one, so presence alone
    // cannot decide whether the author supplied a bound.
    await startWithHueRange('aria-valuemin="" aria-valuemax=""');
    expect(slider("hue").getAttribute("aria-valuemax")).toBe("360");
    press(slider("hue"), "End");
    expect(slider("hue").getAttribute("aria-valuenow")).toBe("360");
  });

  it("keeps an authored range as the operable one", async () => {
    await startWithHueRange('aria-valuemin="0" aria-valuemax="180"');
    press(slider("hue"), "End");
    expect(slider("hue").getAttribute("aria-valuenow")).toBe("180");
    expect(slider("hue").getAttribute("aria-valuemax")).toBe("180");
  });

  it("moves by a larger step on PageUp/PageDown", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    press(slider("saturation"), "PageDown");
    expect(slider("saturation").getAttribute("aria-valuenow")).toBe("90");
    press(slider("lightness"), "PageUp");
    expect(slider("lightness").getAttribute("aria-valuenow")).toBe("60");
  });

  it("steps down with the descending arrows", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    press(slider("saturation"), "ArrowDown");
    expect(slider("saturation").getAttribute("aria-valuenow")).toBe("99");
    press(slider("lightness"), "ArrowLeft");
    expect(slider("lightness").getAttribute("aria-valuenow")).toBe("49");
  });

  it("steps even when an ancestor already prevented the key", async () => {
    // Modified arrows are left to the browser, but a consumer that blanket-prevents
    // keydown does not disable the picker's own stepping.
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    root().addEventListener("keydown", (event) => event.preventDefault(), { capture: true });

    press(slider("hue"), "ArrowRight");

    expect(slider("hue").getAttribute("aria-valuenow")).toBe("1");
  });

  it("fills aria-valuetext from a slider's own template", async () => {
    // The announced wording belongs to the consumer, so a localized page is not
    // stuck with the built-in English.
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    slider("hue").setAttribute("data-value-text", "色相 {value} 度");

    press(slider("hue"), "ArrowRight");

    expect(slider("hue").getAttribute("aria-valuetext")).toBe("色相 1 度");
    expect(slider("saturation").getAttribute("aria-valuetext")).toBe("Saturation 100 percent");
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
    press(slider("lightness"), "Home"); // lightness 50 -> 0 turns the color black
    expect(detail.at(-1)?.value).toBe("#000000");
    expect(detail.at(-1)?.rgba).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it("stays quiet when a key leaves the committed color where it is", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    const details: Array<{ value: string }> = [];
    root().addEventListener("stimeo--color-picker:change", (event) => {
      details.push((event as CustomEvent<{ value: string }>).detail);
    });

    // Hue 360 renders the same red as hue 0, and Home at hue 0 does not move at
    // all. Neither is a color the user changed.
    press(slider("hue"), "End");
    press(slider("hue"), "Home");
    expect(details).toEqual([]);

    press(slider("lightness"), "End"); // lightness 50 -> 100 is white: a real move
    expect(details.map((detail) => detail.value)).toEqual(["#ffffff"]);
  });

  it("stays quiet when the same hex is confirmed again", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    const details: Array<{ value: string }> = [];
    root().addEventListener("stimeo--color-picker:change", (event) => {
      details.push((event as CustomEvent<{ value: string }>).detail);
    });

    hex().value = "#ff0000";
    hex().dispatchEvent(new Event("change", { bubbles: true }));
    expect(details).toEqual([]);

    hex().value = "#00ff00";
    hex().dispatchEvent(new Event("change", { bubbles: true }));
    expect(details.map((detail) => detail.value)).toEqual(["#00ff00"]);
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
    press(slider("lightness"), "Home"); // any move of the color; rgba.a must be 1 (opaque)
    expect(detail.at(-1)?.rgba.a).toBe(1);
  });

  it("keeps the alpha of an #RRGGBBAA value while the channel is enabled", async () => {
    await start(
      'data-stimeo--color-picker-value-value="#ff000080" data-stimeo--color-picker-alpha-value="true"',
      { alpha: true },
    );
    expect(slider("alpha").getAttribute("aria-valuenow")).toBe("50");
    expect(hex().value).toBe("#ff000080");
  });

  it("refuses slider edits on alpha while the channel is disabled", async () => {
    // The markup authors an alpha slider without enabling the channel: moving it
    // would leave the model translucent behind an opaque #RRGGBB.
    await start('data-stimeo--color-picker-value-value="#ffffff"', { alpha: true });
    expect(slider("alpha").getAttribute("aria-valuenow")).toBe("100");

    press(slider("alpha"), "ArrowDown");
    press(slider("alpha"), "PageDown");
    const press2 = pointerDown(track("alpha"), { clientX: 90, pointerId: 21 });

    expect(slider("alpha").getAttribute("aria-valuenow")).toBe("100");
    expect(press2.defaultPrevented).toBe(false);

    const detail: Array<{ value: string; rgba: { a: number } }> = [];
    root().addEventListener("stimeo--color-picker:change", (event) => {
      detail.push((event as CustomEvent<{ value: string; rgba: { a: number } }>).detail);
    });
    press(slider("lightness"), "Home");
    expect(detail.at(-1)?.value).toBe("#000000");
    expect(detail.at(-1)?.rgba.a).toBe(1);
  });

  it("drops the alpha the model carried when the channel is disabled at runtime", async () => {
    await start(
      'data-stimeo--color-picker-value-value="#ff0000" data-stimeo--color-picker-alpha-value="true"',
      { alpha: true },
    );
    press(slider("alpha"), "PageDown");
    expect(hex().value).toBe("#ff0000e6");

    const repairs: Array<{ value: string; rgba: { a: number } }> = [];
    root().addEventListener("stimeo--color-picker:reconcile", (event) => {
      repairs.push((event as CustomEvent<{ value: string; rgba: { a: number } }>).detail);
    });
    root().setAttribute("data-stimeo--color-picker-alpha-value", "false");
    await tick();

    expect(hex().value).toBe("#ff0000");
    expect(repairs.at(-1)?.rgba.a).toBe(1);
    expect(slider("alpha").getAttribute("aria-valuenow")).toBe("100");
  });

  it("sets a channel from a pointer press on the slider", async () => {
    await start('data-stimeo--color-picker-value-value="#000000"');
    const hue = slider("hue");
    hue.getBoundingClientRect = () => new DOMRect(0, 0, 360, 10);
    hue.dispatchEvent(new PointerEvent("pointerdown", { clientX: 180, bubbles: true }));
    expect(slider("hue").getAttribute("aria-valuenow")).toBe("180");
  });

  it("owns the initiating pointer through movement and termination", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    const hue = track("hue");
    pointerDown(hue, { clientX: 180, pointerId: 7 });
    expect(hue.getAttribute("aria-valuenow")).toBe("180");

    // A second finger neither steers the drag nor cuts it short.
    pointerMove({ clientX: 0, pointerId: 8 });
    pointerUp({ pointerId: 8 });
    expect(hue.getAttribute("aria-valuenow")).toBe("180");

    // An off-centre coordinate also pins the direction of the mapping.
    pointerMove({ clientX: 90, pointerId: 7 });
    expect(hue.getAttribute("aria-valuenow")).toBe("90");

    pointerUp({ pointerId: 7 });
    pointerMove({ clientX: 0, pointerId: 7 });
    expect(hue.getAttribute("aria-valuenow")).toBe("90");
  });

  it("ends the drag when its own pointer is cancelled", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    const hue = track("hue");
    pointerDown(hue, { clientX: 180, pointerId: 9 });

    document.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 9, bubbles: true }));
    pointerMove({ clientX: 0, pointerId: 9 });

    expect(hue.getAttribute("aria-valuenow")).toBe("180");
  });

  it("ignores a secondary pointer button without moving or focusing", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    const hue = track("hue");

    const event = pointerDown(hue, { button: 2, clientX: 180, pointerId: 10 });

    expect(event.defaultPrevented).toBe(false);
    expect(hue.getAttribute("aria-valuenow")).toBe("0");
    expect(document.activeElement).not.toBe(hue);
  });

  it("keeps a live drag on its own slider when another slider is pressed", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    const hue = track("hue");
    const saturation = track("saturation");
    pointerDown(hue, { clientX: 180, pointerId: 11 });

    pointerDown(saturation, { clientX: 90, pointerId: 12 });
    expect(saturation.getAttribute("aria-valuenow")).toBe("100");

    pointerMove({ clientX: 90, pointerId: 11 });
    expect(hue.getAttribute("aria-valuenow")).toBe("90");
  });

  it("ends a drag whose slider stops being a target", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    const hue = track("hue");
    pointerDown(hue, { clientX: 180, pointerId: 13 });
    expect(hex().value).toBe("#00ffff");

    hue.remove();
    await tick();
    pointerMove({ clientX: 0, pointerId: 13 });

    expect(hex().value).toBe("#00ffff");
  });

  it("frees the picker for the next drag as soon as its slider leaves", async () => {
    // Waiting for a move to notice the removal would keep the gesture nominally
    // live, and the next press on another channel would be refused.
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    pointerDown(track("hue"), { clientX: 180, pointerId: 18 });
    slider("hue").remove();
    await tick();

    const saturation = track("saturation");
    pointerDown(saturation, { clientX: 90, pointerId: 19 });

    expect(saturation.getAttribute("aria-valuenow")).toBe("25");
  });

  it("keeps a drag alive when a different slider leaves", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    const hue = track("hue");
    pointerDown(hue, { clientX: 180, pointerId: 17 });

    slider("lightness").remove();
    await tick();
    pointerMove({ clientX: 90, pointerId: 17 });

    expect(hue.getAttribute("aria-valuenow")).toBe("90");
  });

  it("leaves a press on a zero-width track to the page", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    const hue = track("hue", 0);

    const event = pointerDown(hue, { clientX: 40, pointerId: 14 });
    expect(event.defaultPrevented).toBe(false);
    expect(hue.getAttribute("aria-valuenow")).toBe("0");

    // No drag opened, so a later move does not reach the model either.
    hue.getBoundingClientRect = () => new DOMRect(0, 0, 360, 10);
    pointerMove({ clientX: 90, pointerId: 14 });
    expect(hue.getAttribute("aria-valuenow")).toBe("0");
  });

  it("ignores a slider whose data-channel is not a channel", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    const errors = captureErrors();
    const stray = track("saturation");
    stray.setAttribute("data-channel", "chroma");

    press(stray, "ArrowRight");
    pointerDown(stray, { clientX: 90, pointerId: 15 });
    press(slider("hue"), "ArrowRight"); // a repaint that must skip the stray slider

    expect(stray.getAttribute("aria-valuenow")).toBe("100");
    expect(errors).toEqual([]);
  });

  it("ignores a slider whose data-channel names an inherited object key", async () => {
    // `toString` lives on Object.prototype: a prototype-aware lookup would index
    // the model with a function and announce its source.
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    const errors = captureErrors();
    const stray = track("saturation");
    stray.setAttribute("data-channel", "toString");

    press(stray, "ArrowRight");
    pointerDown(stray, { clientX: 90, pointerId: 16 });
    press(slider("hue"), "ArrowRight");

    expect(stray.getAttribute("aria-valuenow")).toBe("100");
    expect(stray.getAttribute("aria-valuetext")).toBe("Saturation 100 percent");
    expect(errors).toEqual([]);
  });

  it("survives a hex confirmation when the markup has no hex input", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--color-picker" data-stimeo--color-picker-value-value="#ff0000">
        <div role="slider" aria-label="Hue" data-channel="hue" tabindex="0"
             data-stimeo--color-picker-target="slider"
             data-action="keydown->stimeo--color-picker#onKeydown"></div>
        <input type="text" aria-label="Hex color"
               data-action="change->stimeo--color-picker#onHexInput" />
      </div>`;
    application = Application.start();
    application.register("stimeo--color-picker", ColorPickerController);
    await tick();
    const errors = captureErrors();

    const input = document.querySelector("input") as HTMLInputElement;
    input.value = "#00ff00";
    input.dispatchEvent(new Event("change", { bubbles: true }));

    expect(errors).toEqual([]);
    expect(slider("hue").getAttribute("aria-valuenow")).toBe("0");
  });

  it("removes drag listeners on disconnect so a later pointermove is ignored", async () => {
    await start('data-stimeo--color-picker-value-value="#000000"');
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--color-picker",
    ) as ColorPickerController;
    const hue = slider("hue");
    hue.getBoundingClientRect = () => new DOMRect(0, 0, 360, 10);
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

  // A gradient written `to right` does not mirror, so nothing may follow the
  // writing direction unless the consumer says their tracks do. `dir="rtl"` is
  // the authoring contract, but happy-dom does not resolve it into the computed
  // style, so the direction is set as an inline style instead.
  describe("writing direction", () => {
    /** One complete press: a drag stays owned until its own pointer ends it. */
    const pressHue = (clientX: number) => {
      pointerDown(track("hue"), { clientX, pointerId: 1 });
      pointerUp({ pointerId: 1 });
    };

    it("ignores RTL when the tracks were not declared logical", async () => {
      await start('data-stimeo--color-picker-value-value="#000000"');
      root().style.direction = "rtl";

      pressHue(180);
      expect(slider("hue").getAttribute("aria-valuenow")).toBe("180");

      press(slider("hue"), "ArrowLeft");
      expect(slider("hue").getAttribute("aria-valuenow")).toBe("179");
    });

    it("reads the pointer from the right edge on logical tracks under RTL", async () => {
      await start(
        'data-stimeo--color-picker-value-value="#000000" data-stimeo--color-picker-logical-track-value="true"',
      );
      root().style.direction = "rtl";

      pressHue(180);
      expect(slider("hue").getAttribute("aria-valuenow")).toBe("180");

      pressHue(0);
      expect(slider("hue").getAttribute("aria-valuenow")).toBe("360");
    });

    it("trades the horizontal arrows on logical tracks under RTL", async () => {
      await start(
        'data-stimeo--color-picker-value-value="#000000" data-stimeo--color-picker-logical-track-value="true"',
      );
      root().style.direction = "rtl";

      press(slider("hue"), "ArrowLeft");
      expect(slider("hue").getAttribute("aria-valuenow")).toBe("1");

      press(slider("hue"), "ArrowRight");
      expect(slider("hue").getAttribute("aria-valuenow")).toBe("0");

      // The vertical pair names an axis the writing direction does not mirror.
      press(slider("hue"), "ArrowUp");
      expect(slider("hue").getAttribute("aria-valuenow")).toBe("1");
    });
  });

  // Speech-order regression: each channel announces its slider role, name,
  // bounds, and value text, so a dropped role/name surfaces as a diff.
  it("announces the hue slider role, name, and value text", async () => {
    await start('data-stimeo--color-picker-value-value="#ff0000"');
    const phrases = await captureSpeech({ container: slider("hue"), steps: 0 });
    expect(phrases).toEqual([
      "slider, Hue, orientated horizontally, max value 360, min value 0, current value Hue 0 degrees",
    ]);
  });

  it("follows alpha swapped in place by a morph", async () => {
    // Turning alpha off drops it from the emitted hex, and a morph is the one path
    // where `connect()` does not run again.
    await start(
      'data-stimeo--color-picker-value-value="#3366ccff" data-stimeo--color-picker-alpha-value="true"',
    );
    expect(hex().value.length).toBe(9);
    root().setAttribute("data-stimeo--color-picker-alpha-value", "false");
    await tick();
    expect(hex().value.length).toBe(7);
  });

  it("reports a color dropped by a runtime alpha switch as reconcile, not change", async () => {
    await start(
      'data-stimeo--color-picker-value-value="#3366ccff" data-stimeo--color-picker-alpha-value="true"',
    );
    const changes: unknown[] = [];
    const repairs: Array<{ value: string }> = [];
    root().addEventListener("stimeo--color-picker:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    root().addEventListener("stimeo--color-picker:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });

    root().setAttribute("data-stimeo--color-picker-alpha-value", "false");
    await tick();

    // The alpha channel left the model by configuration, not by a drag or a type.
    expect(repairs.map((detail) => detail.value)).toEqual(["#3366cc"]);
    expect(changes).toEqual([]);
  });

  it("emits nothing at connect, so a mount is never read as an edit", async () => {
    const events: string[] = [];
    document.addEventListener("stimeo--color-picker:change", () => events.push("change"));
    document.addEventListener("stimeo--color-picker:reconcile", () => events.push("reconcile"));

    await start('data-stimeo--color-picker-value-value="#3366cc"');

    expect(events).toEqual([]);
  });

  it("normalizes the declared value at connect without reporting it", async () => {
    const events: string[] = [];
    document.addEventListener("stimeo--color-picker:change", () => events.push("change"));
    document.addEventListener("stimeo--color-picker:reconcile", () => events.push("reconcile"));

    await start('data-stimeo--color-picker-value-value="#0F0"');

    expect(declaredValue()).toBe("#00ff00");
    expect(events).toEqual([]);
  });

  it("announces the channel range even when the markup omits the bounds", async () => {
    await startWithHueRange("");
    const phrases = await captureSpeech({ container: slider("hue"), steps: 0 });
    expect(phrases).toEqual([
      "slider, Hue, orientated horizontally, max value 360, min value 0, current value Hue 0 degrees",
    ]);
  });

  describe("declarative color", () => {
    it("writes the settled color back into the value Value", async () => {
      await start('data-stimeo--color-picker-value-value="#ff0000"');

      press(slider("lightness"), "End"); // white

      expect(declaredValue()).toBe("#ffffff");
      expect(field().value).toBe("#ffffff");
    });

    it("keeps the color the user picked across a Turbo cache restore", async () => {
      await start('data-stimeo--color-picker-value-value="#3366cc"');
      hex().value = "#ff0000";
      hex().dispatchEvent(new Event("change", { bubbles: true }));

      // Turbo snapshots the live DOM and replays that markup on the way back.
      const snapshot = root().outerHTML;
      disconnectAndStopApplication(application);
      document.body.innerHTML = snapshot;
      application = Application.start();
      application.register("stimeo--color-picker", ColorPickerController);
      await tick();

      expect(hex().value).toBe("#ff0000");
      expect(field().value).toBe("#ff0000");
      expect(slider("hue").getAttribute("aria-valuenow")).toBe("0");
      expect(slider("saturation").getAttribute("aria-valuenow")).toBe("100");
      expect(color()).toBe("#ff0000");
    });

    it("adopts a color a morph put in the value Value and reports reconcile", async () => {
      await start('data-stimeo--color-picker-value-value="#ff0000"');
      const changes: unknown[] = [];
      const repairs: Array<{
        value: string;
        rgba: { r: number; g: number; b: number; a: number };
      }> = [];
      root().addEventListener("stimeo--color-picker:change", (event) => {
        changes.push((event as CustomEvent).detail);
      });
      root().addEventListener("stimeo--color-picker:reconcile", (event) => {
        repairs.push((event as CustomEvent).detail);
      });

      root().setAttribute("data-stimeo--color-picker-value-value", "#00ff00");
      await tick();

      expect(slider("hue").getAttribute("aria-valuenow")).toBe("120");
      expect(hex().value).toBe("#00ff00");
      expect(color()).toBe("#00ff00");
      expect(repairs.map((detail) => detail.value)).toEqual(["#00ff00"]);
      // The repair detail carries the same shape a user edit reports.
      expect(repairs.at(-1)?.rgba).toEqual({ r: 0, g: 255, b: 0, a: 1 });
      expect(changes).toEqual([]);
    });

    it("stays quiet when a morph restates the color already shown", async () => {
      await start('data-stimeo--color-picker-value-value="#00ff00"');
      const events: string[] = [];
      root().addEventListener("stimeo--color-picker:change", () => events.push("change"));
      root().addEventListener("stimeo--color-picker:reconcile", () => events.push("reconcile"));

      root().setAttribute("data-stimeo--color-picker-value-value", "#0f0");
      await tick();

      expect(declaredValue()).toBe("#00ff00");
      expect(events).toEqual([]);
    });

    it("keeps a gray's hue and saturation while the user edits it", async () => {
      // Black serializes to `#000000` whatever its hue is, so re-seeding from the
      // controller's own write-back would silently reset the other channels.
      await start('data-stimeo--color-picker-value-value="#ff0000"');
      press(slider("lightness"), "Home"); // black, hue and saturation still 0/100
      await tick();

      expect(slider("hue").getAttribute("aria-valuenow")).toBe("0");
      expect(slider("saturation").getAttribute("aria-valuenow")).toBe("100");

      press(slider("lightness"), "End"); // back up to white through the same hue
      expect(hex().value).toBe("#ffffff");
      expect(slider("saturation").getAttribute("aria-valuenow")).toBe("100");
    });
  });

  describe("runtime targets", () => {
    /** A channel slider built at runtime, as a lazily rendered form would insert it. */
    const buildSlider = (channel: string, label: string) => {
      const element = document.createElement("div");
      element.setAttribute("role", "slider");
      element.setAttribute("aria-label", label);
      element.setAttribute("data-channel", channel);
      element.setAttribute("tabindex", "0");
      element.setAttribute("aria-valuenow", "7");
      element.setAttribute("data-stimeo--color-picker-target", "slider");
      return element;
    };

    it("hydrates a channel slider added at runtime", async () => {
      await start('data-stimeo--color-picker-value-value="#ff0000"');
      const added = buildSlider("hue", "Hue");

      root().append(added);
      await tick();

      expect(added.getAttribute("aria-valuenow")).toBe("0");
      expect(added.getAttribute("aria-valuetext")).toBe("Hue 0 degrees");
      expect(added.getAttribute("aria-valuemin")).toBe("0");
      expect(added.getAttribute("aria-valuemax")).toBe("360");
    });

    it("hydrates a channel slider swapped in place", async () => {
      await start('data-stimeo--color-picker-value-value="#ff0000"');
      const replacement = buildSlider("saturation", "Saturation");

      slider("saturation").replaceWith(replacement);
      await tick();

      expect(replacement.getAttribute("aria-valuenow")).toBe("100");
      expect(replacement.getAttribute("aria-valuetext")).toBe("Saturation 100 percent");
    });

    it("fills a hex input, form field, and preview added at runtime", async () => {
      await start('data-stimeo--color-picker-value-value="#ff0000"');
      hex().remove();
      const input = document.createElement("input");
      input.type = "text";
      input.setAttribute("data-stimeo--color-picker-target", "hex");
      const submitted = document.createElement("input");
      submitted.type = "hidden";
      submitted.setAttribute("data-stimeo--color-picker-target", "field");
      const swatch = document.createElement("div");
      swatch.setAttribute("data-stimeo--color-picker-target", "preview");

      root().append(input, submitted, swatch);
      await tick();

      expect(input.value).toBe("#ff0000");
      expect(submitted.value).toBe("#ff0000");
      expect(color(swatch)).toBe("#ff0000");
    });
  });
});
