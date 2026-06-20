import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NumberInputController } from "../src/controllers/number_input_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link NumberInputController}: the APG Spinbutton contract
 * — step increment/decrement, range clamping and step snapping, PageUp/PageDown,
 * Home/End, bound-disabled buttons, focus retention, and the `change` event.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("NumberInputController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--number-input"
           data-stimeo--number-input-min-value="0"
           data-stimeo--number-input-max-value="100"
           data-stimeo--number-input-step-value="10">
        <button type="button" aria-label="Decrease" tabindex="-1"
                data-stimeo--number-input-target="decrement"
                data-action="click->stimeo--number-input#decrement">−</button>
        <input type="number" min="0" max="100" step="10" value="0" aria-label="Quantity"
               data-stimeo--number-input-target="input"
               data-action="change->stimeo--number-input#onInput
                            keydown->stimeo--number-input#onKeydown" />
        <button type="button" aria-label="Increase" tabindex="-1"
                data-stimeo--number-input-target="increment"
                data-action="click->stimeo--number-input#increment">+</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--number-input", NumberInputController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--number-input']") as HTMLElement;
  const input = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--number-input-target='input']",
    ) as HTMLInputElement;
  const incrementBtn = () =>
    document.querySelector<HTMLButtonElement>(
      "[data-stimeo--number-input-target='increment']",
    ) as HTMLButtonElement;
  const decrementBtn = () =>
    document.querySelector<HTMLButtonElement>(
      "[data-stimeo--number-input-target='decrement']",
    ) as HTMLButtonElement;
  const press = (k: string) =>
    input().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  it("disables the decrement button at the minimum on connect", () => {
    expect(input().value).toBe("0");
    expect(decrementBtn().disabled).toBe(true);
    expect(incrementBtn().disabled).toBe(false);
  });

  it("never re-enables an author-disabled step button", async () => {
    application.stop();
    document.body.innerHTML = `
      <div data-controller="stimeo--number-input"
           data-stimeo--number-input-min-value="0"
           data-stimeo--number-input-max-value="100"
           data-stimeo--number-input-step-value="10">
        <button type="button" data-stimeo--number-input-target="decrement"
                data-action="click->stimeo--number-input#decrement">−</button>
        <input type="number" value="100" aria-label="Quantity"
               data-stimeo--number-input-target="input"
               data-action="keydown->stimeo--number-input#onKeydown" />
        <button type="button" disabled data-stimeo--number-input-target="increment"
                data-action="click->stimeo--number-input#increment">+</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--number-input", NumberInputController);
    await tick();
    // Step down off the max so the controller would normally re-enable increment;
    // because the author disabled it (no marker), it must stay disabled.
    decrementBtn().click();
    expect(input().value).toBe("90");
    expect(incrementBtn().disabled).toBe(true);
  });

  it("steps with the increment and decrement buttons", () => {
    incrementBtn().click();
    expect(input().value).toBe("10");
    expect(decrementBtn().disabled).toBe(false);
    decrementBtn().click();
    expect(input().value).toBe("0");
  });

  it("steps with ArrowUp and ArrowDown", () => {
    press("ArrowUp");
    expect(input().value).toBe("10");
    press("ArrowDown");
    expect(input().value).toBe("0");
  });

  it("moves by the page step with PageUp/PageDown", () => {
    press("PageUp"); // step*10 = 100, clamped to max
    expect(input().value).toBe("100");
    press("PageDown");
    expect(input().value).toBe("0");
  });

  it("jumps to min/max with Home/End", () => {
    press("End");
    expect(input().value).toBe("100");
    expect(incrementBtn().disabled).toBe(true);
    press("Home");
    expect(input().value).toBe("0");
  });

  it("clamps at the maximum and disables increment there", () => {
    press("End");
    press("ArrowUp"); // stays at max
    expect(input().value).toBe("100");
    expect(incrementBtn().disabled).toBe(true);
  });

  it("snaps a typed value to the step grid on change", () => {
    input().value = "23";
    input().dispatchEvent(new Event("change", { bubbles: true }));
    expect(input().value).toBe("20");
  });

  it("keeps focus on the input after using a step button", () => {
    incrementBtn().click();
    expect(document.activeElement).toBe(input());
  });

  it("returns focus to the input before disabling a focused button", () => {
    input().value = "90";
    input().dispatchEvent(new Event("change", { bubbles: true }));
    incrementBtn().focus();
    incrementBtn().click(); // 90 -> 100, increment becomes disabled
    expect(incrementBtn().disabled).toBe(true);
    expect(document.activeElement).toBe(input());
  });

  it("dispatches change with the committed value", () => {
    const values: number[] = [];
    root().addEventListener("stimeo--number-input:change", (event) => {
      values.push((event as CustomEvent<{ value: number }>).detail.value);
    });
    press("ArrowUp");
    press("ArrowUp");
    expect(values).toEqual([10, 20]);
  });

  it("suppresses pointerdown on buttons and releases it on disconnect", () => {
    const button = incrementBtn();
    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);

    // Invoke disconnect directly: happy-dom's async MutationObserver makes
    // application.stop()'s disconnect timing flaky (see scrollspy/slider tests).
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--number-input",
    ) as NumberInputController;
    controller.disconnect();

    const after = new Event("pointerdown", { bubbles: true, cancelable: true });
    button.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("has no machine-detectable a11y violations", async () => {
    await expectNoA11yViolations(root());
  });
});

/**
 * A custom `role="spinbutton"` host gets its `aria-valuenow`/min/max synced
 * (a native `<input type="number">` exposes those itself, so they are not added).
 */
describe("NumberInputController on a custom spinbutton host", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--number-input"
           data-stimeo--number-input-min-value="1"
           data-stimeo--number-input-max-value="5"
           data-stimeo--number-input-step-value="1">
        <input type="text" role="spinbutton" inputmode="numeric" value="3" aria-label="Level"
               data-stimeo--number-input-target="input"
               data-action="keydown->stimeo--number-input#onKeydown" />
      </div>`;
    application = Application.start();
    application.register("stimeo--number-input", NumberInputController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  it("announces the spinbutton role, name, range, and value in order", async () => {
    const input = document.querySelector<HTMLInputElement>(
      "[data-stimeo--number-input-target='input']",
    ) as HTMLInputElement;
    const before = await captureSpeech({ container: input, steps: 0 });
    expect(before).toEqual(["spinbutton, Level, max value 5, min value 1, 3"]);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    const after = await captureSpeech({ container: input, steps: 0 });
    expect(after).toEqual(["spinbutton, Level, max value 5, min value 1, 4"]);
  });

  it("syncs aria-valuenow/min/max on the spinbutton", () => {
    const input = document.querySelector<HTMLInputElement>(
      "[data-stimeo--number-input-target='input']",
    ) as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(input.value).toBe("4");
    expect(input.getAttribute("aria-valuenow")).toBe("4");
    expect(input.getAttribute("aria-valuemin")).toBe("1");
    expect(input.getAttribute("aria-valuemax")).toBe("5");
  });
});

/**
 * Press-and-hold auto-repeat (APG spinbutton convenience): holding a step button
 * steps once, then repeats after a short delay until release / the bound /
 * disconnect. The `click` binding stays the single-step path, so a held press
 * must not also double-step via its trailing click. Driven with fake timers.
 */
describe("NumberInputController press-and-hold", () => {
  let application: Application;

  beforeEach(async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div data-controller="stimeo--number-input"
           data-stimeo--number-input-min-value="0"
           data-stimeo--number-input-max-value="100"
           data-stimeo--number-input-step-value="10">
        <button type="button" aria-label="Decrease" tabindex="-1"
                data-stimeo--number-input-target="decrement"
                data-action="click->stimeo--number-input#decrement">−</button>
        <input type="number" min="0" max="100" step="10" value="0" aria-label="Quantity"
               data-stimeo--number-input-target="input"
               data-action="change->stimeo--number-input#onInput
                            keydown->stimeo--number-input#onKeydown" />
        <button type="button" aria-label="Increase" tabindex="-1"
                data-stimeo--number-input-target="increment"
                data-action="click->stimeo--number-input#increment">+</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--number-input", NumberInputController);
    // Flush Stimulus' async (MutationObserver) connection under fake timers.
    await vi.advanceTimersByTimeAsync(0);
  });

  afterEach(() => {
    application.stop();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--number-input']") as HTMLElement;
  const input = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--number-input-target='input']",
    ) as HTMLInputElement;
  const incrementBtn = () =>
    document.querySelector<HTMLButtonElement>(
      "[data-stimeo--number-input-target='increment']",
    ) as HTMLButtonElement;
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--number-input",
    ) as NumberInputController;
  const pointerdown = (button: HTMLButtonElement) =>
    button.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
  const secondaryPointerdown = (button: HTMLButtonElement) => {
    const event = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "button", { value: 2 }); // right button
    button.dispatchEvent(event);
    return event;
  };
  const releaseOutside = () => window.dispatchEvent(new Event("pointerup"));

  it("steps once immediately and does not repeat before the hold delay", () => {
    pointerdown(incrementBtn());
    expect(input().value).toBe("0"); // pointerdown alone does not step
    vi.advanceTimersByTime(399);
    expect(input().value).toBe("0"); // still under the hold threshold
    releaseOutside();
    incrementBtn().click(); // the trailing single click does the one step
    expect(input().value).toBe("10");
  });

  it("auto-repeats while held and swallows the trailing click", () => {
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(400); // first repeat -> 10
    vi.advanceTimersByTime(80 * 3); // -> 20, 30, 40
    expect(input().value).toBe("40");
    releaseOutside();
    incrementBtn().click(); // trailing click after a hold is ignored
    expect(input().value).toBe("40");
  });

  it("does not poison the next legitimate click after a hold", () => {
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(400 + 80); // -> 10, 20
    expect(input().value).toBe("20");
    releaseOutside(); // trailing click never arrives (released off the button)
    vi.advanceTimersByTime(250); // the suppression safety net clears
    incrementBtn().click(); // a fresh, legitimate click must step
    expect(input().value).toBe("30");
  });

  it("stops repeating once the bound is reached without re-dispatching change", () => {
    const values: number[] = [];
    root().addEventListener("stimeo--number-input:change", (event) => {
      values.push((event as CustomEvent<{ value: number }>).detail.value);
    });
    input().value = "80";
    input().dispatchEvent(new Event("change", { bubbles: true }));
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(400 + 80 * 5); // 90, 100, then bound stops the repeat
    expect(input().value).toBe("100");
    expect(incrementBtn().disabled).toBe(true);
    // 90 and 100 are the only changes; the no-op repeats at the bound do not fire.
    expect(values).toEqual([90, 100]);
  });

  it("ignores secondary (non-primary) pointer buttons", () => {
    const event = secondaryPointerdown(incrementBtn());
    expect(event.defaultPrevented).toBe(false); // hold was not armed
    vi.advanceTimersByTime(2000);
    expect(input().value).toBe("0"); // no step from a right-click hold
  });

  it("does not swallow the first click after a disconnect during a suppressed window", () => {
    // Hold + repeat arms the trailing-click suppression, then disconnect mid-window.
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(400 + 80); // -> 10, 20 (suppression now pending)
    releaseOutside();
    controller().disconnect();
    // Re-connect the same element (Turbo cache / detach→reattach).
    controller().connect();
    incrementBtn().click(); // the first click after reconnect must step
    expect(input().value).toBe("30");
  });

  it("dispatches change once per committed repeat step", () => {
    const values: number[] = [];
    root().addEventListener("stimeo--number-input:change", (event) => {
      values.push((event as CustomEvent<{ value: number }>).detail.value);
    });
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(400 + 80 * 2); // 10, 20, 30
    releaseOutside();
    incrementBtn().click(); // swallowed -> no extra event
    expect(values).toEqual([10, 20, 30]);
  });

  it("tears down hold timers on disconnect so none fire afterward", () => {
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(200); // arm, but before the first repeat
    controller().disconnect();
    vi.advanceTimersByTime(2000); // advancing past every timer must do nothing
    expect(input().value).toBe("0");
  });
});
