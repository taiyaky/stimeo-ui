import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizableController } from "../src/controllers/resizable_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("ResizableController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div id="resizable" data-controller="stimeo--resizable"
           data-stimeo--resizable-min-value="20"
           data-stimeo--resizable-max-value="80"
           data-stimeo--resizable-value-value="50">
        <div id="pane-1" data-stimeo--resizable-target="primary">Primary</div>
        <div role="separator" id="splitter" tabindex="0" aria-orientation="vertical"
             aria-controls="pane-1" aria-label="Resize"
             data-stimeo--resizable-target="separator"
             data-action="pointerdown->stimeo--resizable#onPointerDown
                          keydown->stimeo--resizable#onKeydown"></div>
        <div data-stimeo--resizable-target="secondary">Secondary</div>
      </div>
    `;

    application = Application.start();
    application.register("stimeo--resizable", ResizableController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  it("initializes ARIA properties and CSS custom properties", () => {
    const root = document.getElementById("resizable") as HTMLElement;
    const splitter = document.getElementById("splitter") as HTMLElement;

    expect(root.style.getPropertyValue("--stimeo--resizable-fraction")).toBe("0.5");
    expect(splitter.getAttribute("aria-valuenow")).toBe("50");
    expect(splitter.getAttribute("aria-valuemin")).toBe("20");
    expect(splitter.getAttribute("aria-valuemax")).toBe("80");
  });

  // Layer ① — machine-detectable a11y.
  it("has no machine-detectable a11y violations", async () => {
    const root = document.getElementById("resizable") as HTMLElement;
    await expectNoA11yViolations(root);
  });

  // Layer ③ — speech-order regression. The separator announces its state
  // (`role="separator"` + aria-valuenow), so capturing the phrase before and
  // after a keyboard step pins role, accessible name, bounds, and the announced
  // value; a lost role/name or a stale value surfaces as a diff.
  it("announces the separator role, name, bounds, and value before and after a step", async () => {
    const splitter = document.getElementById("splitter") as HTMLElement;

    const before = await captureSpeech({ container: splitter, steps: 0 });
    expect(before).toEqual([
      "separator, Resize, orientated vertically, max value 80, min value 20, 50",
    ]);

    splitter.focus();
    splitter.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await tick();

    const after = await captureSpeech({ container: splitter, steps: 0 });
    expect(after).toEqual([
      "separator, Resize, orientated vertically, max value 80, min value 20, 51",
    ]);
  });

  it("clamping on initialization works properly", async () => {
    // Set value value out of bounds
    document.body.innerHTML = `
      <div id="resizable" data-controller="stimeo--resizable"
           data-stimeo--resizable-min-value="20"
           data-stimeo--resizable-max-value="80"
           data-stimeo--resizable-value-value="95">
        <div id="pane-1" data-stimeo--resizable-target="primary">Primary</div>
        <div role="separator" id="splitter" tabindex="0" aria-orientation="vertical"
             aria-controls="pane-1"
             data-stimeo--resizable-target="separator"
             data-action="pointerdown->stimeo--resizable#onPointerDown"></div>
      </div>
    `;
    application.stop();
    application = Application.start();
    application.register("stimeo--resizable", ResizableController);
    await tick();

    const root = document.getElementById("resizable") as HTMLElement;
    const splitter = document.getElementById("splitter") as HTMLElement;

    // Should clamp value 95 to max 80
    expect(root.style.getPropertyValue("--stimeo--resizable-fraction")).toBe("0.8");
    expect(splitter.getAttribute("aria-valuenow")).toBe("80");
  });

  it("keyboard navigation adjusts size and fires change event", async () => {
    const root = document.getElementById("resizable") as HTMLElement;
    const splitter = document.getElementById("splitter") as HTMLElement;

    const changeHandler = vi.fn();
    root.addEventListener("stimeo--resizable:change", changeHandler);

    splitter.focus();

    // ArrowRight increases the vertical pane size
    const right = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true });
    splitter.dispatchEvent(right);
    await tick();

    expect(root.style.getPropertyValue("--stimeo--resizable-fraction")).toBe("0.51"); // step is 1%
    expect(splitter.getAttribute("aria-valuenow")).toBe("51");
    expect(changeHandler).toHaveBeenCalledOnce();
    expect(changeHandler.mock.calls[0]?.[0]?.detail).toEqual({ value: 51, fraction: 0.51 });

    // ArrowLeft decreases size
    const left = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true });
    splitter.dispatchEvent(left);
    await tick();

    expect(splitter.getAttribute("aria-valuenow")).toBe("50");

    // End jumps to max limits (80)
    const end = new KeyboardEvent("keydown", { key: "End", bubbles: true });
    splitter.dispatchEvent(end);
    await tick();
    expect(splitter.getAttribute("aria-valuenow")).toBe("80");

    // Home jumps to min limits (20)
    const home = new KeyboardEvent("keydown", { key: "Home", bubbles: true });
    splitter.dispatchEvent(home);
    await tick();
    expect(splitter.getAttribute("aria-valuenow")).toBe("20");
  });

  it("keyboard navigation works for horizontal orientation (vertical split)", async () => {
    const splitter = document.getElementById("splitter") as HTMLElement;
    splitter.setAttribute("aria-orientation", "horizontal");
    // Initial value is 50.
    splitter.focus();
    // ArrowDown increases the horizontal pane size
    const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true });
    splitter.dispatchEvent(down);
    await tick();
    expect(splitter.getAttribute("aria-valuenow")).toBe("51");
    // ArrowUp decreases size
    const up = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true });
    splitter.dispatchEvent(up);
    await tick();
    expect(splitter.getAttribute("aria-valuenow")).toBe("50");
  });

  it("toggle action collapses and restores sizes dynamically", async () => {
    const root = document.getElementById("resizable") as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(
      root,
      "stimeo--resizable",
    ) as ResizableController;

    expect(controller.valueValue).toBe(50);

    // Call toggle() (simulates Enter or double click). Should collapse to min (20).
    controller.toggle();
    await tick();
    expect(controller.valueValue).toBe(20);

    // Toggle again. Should restore to previously held value (50).
    controller.toggle();
    await tick();
    expect(controller.valueValue).toBe(50);
  });

  it("pointerdrag simulates dragging accurately using setPointerCapture", async () => {
    const root = document.getElementById("resizable") as HTMLElement;
    const splitter = document.getElementById("splitter") as HTMLElement;

    const changeHandler = vi.fn();
    root.addEventListener("stimeo--resizable:change", changeHandler);

    // Mock parent client rect size: left=0, width=500px.
    // That means coordinate clientX = 250px is 50%, clientX = 350px is 70% etc.
    root.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 500,
        height: 100,
      }) as DOMRect;

    // Spy on Pointer Capture APIs
    const captureSpy = vi.spyOn(splitter, "setPointerCapture");
    const releaseSpy = vi.spyOn(splitter, "releasePointerCapture");

    // 1. pointerdown (starts drag)
    const pointerdown = new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      pointerId: 42,
    });
    splitter.dispatchEvent(pointerdown);
    await tick();

    expect(captureSpy).toHaveBeenCalledWith(42);
    expect(root.getAttribute("data-dragging")).toBe("true");

    // 2. pointermove (drag to clientX = 350px -> 350/500 = 70% fraction)
    const pointermove = new PointerEvent("pointermove", {
      bubbles: true,
      clientX: 350,
      pointerId: 42,
    });
    splitter.dispatchEvent(pointermove);
    await tick();

    expect(root.style.getPropertyValue("--stimeo--resizable-fraction")).toBe("0.7");
    expect(splitter.getAttribute("aria-valuenow")).toBe("70");

    // 3. pointerup (ends drag)
    const pointerup = new PointerEvent("pointerup", {
      bubbles: true,
      pointerId: 42,
    });
    splitter.dispatchEvent(pointerup);
    await tick();

    expect(releaseSpy).toHaveBeenCalledWith(42);
    expect(root.getAttribute("data-dragging")).toBeNull();
    expect(changeHandler).toHaveBeenCalledOnce();
    expect(changeHandler.mock.calls[0]?.[0]?.detail).toEqual({ value: 70, fraction: 0.7 });
  });

  it("focuses the separator on pointerdown so arrow keys work after a click", async () => {
    const splitter = document.getElementById("splitter") as HTMLElement;

    // preventDefault in onPointerDown suppresses implicit focus, so the controller
    // must focus the separator explicitly; otherwise click-then-arrow silently fails.
    const pointerdown = new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      pointerId: 7,
    });
    splitter.dispatchEvent(pointerdown);
    await tick();

    expect(document.activeElement).toBe(splitter);
  });

  it("removes drag listeners on disconnect so a later pointermove is ignored", async () => {
    const root = document.getElementById("resizable") as HTMLElement;
    const splitter = document.getElementById("splitter") as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(
      root,
      "stimeo--resizable",
    ) as ResizableController;

    root.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 100 }) as DOMRect;

    splitter.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 9 }),
    );
    await tick();

    // Tearing the controller down mid-drag must abort the drag listeners.
    controller.disconnect();

    splitter.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, clientX: 350, pointerId: 9 }),
    );
    await tick();

    // Fraction stays at the initial 0.5; the stale move did not adjust it.
    expect(root.style.getPropertyValue("--stimeo--resizable-fraction")).toBe("0.5");
  });

  it("writes the clamped value back to valueValue on initialization", async () => {
    document.body.innerHTML = `
      <div id="resizable" data-controller="stimeo--resizable"
           data-stimeo--resizable-min-value="20"
           data-stimeo--resizable-max-value="80"
           data-stimeo--resizable-value-value="95">
        <div id="pane-1" data-stimeo--resizable-target="primary">Primary</div>
        <div role="separator" id="splitter" tabindex="0" aria-orientation="vertical"
             aria-controls="pane-1"
             data-stimeo--resizable-target="separator"
             data-action="pointerdown->stimeo--resizable#onPointerDown"></div>
      </div>
    `;
    application.stop();
    application = Application.start();
    application.register("stimeo--resizable", ResizableController);
    await tick();

    const root = document.getElementById("resizable") as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(
      root,
      "stimeo--resizable",
    ) as ResizableController;

    // value/ARIA/CSS must never diverge: the out-of-range 95 is persisted as 80.
    expect(controller.valueValue).toBe(80);
  });
});
