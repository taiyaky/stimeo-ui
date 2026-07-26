import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { StepperController } from "../src/controllers/stepper_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link StepperController}: `next`/`prev`/`goto`
 * navigation, derived `data-state`/`aria-current`, out-of-range and `linear`
 * guards, and the `change` event.
 */

const markup = (attrs = "") => `
  <div data-controller="stimeo--stepper" ${attrs}>
    <ol>
      <li data-stimeo--stepper-target="step">
        <button data-stimeo--stepper-index-param="0"
                data-action="click->stimeo--stepper#goto">Account</button>
      </li>
      <li data-stimeo--stepper-target="step">
        <button data-stimeo--stepper-index-param="1"
                data-action="click->stimeo--stepper#goto">Profile</button>
      </li>
      <li data-stimeo--stepper-target="step">
        <button data-stimeo--stepper-index-param="2"
                data-action="click->stimeo--stepper#goto">Confirm</button>
      </li>
    </ol>
    <button id="previous" data-action="stimeo--stepper#prev">Previous</button>
    <button id="next" data-action="stimeo--stepper#next">Next</button>
  </div>`;

describe("StepperController", () => {
  let application: Application;

  const start = async (attrs = "") => {
    document.body.innerHTML = markup(attrs);
    application = Application.start();
    application.register("stimeo--stepper", StepperController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--stepper']") as HTMLElement;
  const steps = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--stepper-target='step']"));
  const buttons = () => steps().map((step) => step.querySelector("button") as HTMLButtonElement);
  const states = () => steps().map((step) => step.dataset.state);
  const currents = () => buttons().map((button) => button.getAttribute("aria-current"));

  it("derives data-state and aria-current from the initial index", async () => {
    await start();
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    expect(currents()).toEqual(["step", null, null]);
  });

  const previous = () => document.getElementById("previous") as HTMLButtonElement;
  const next = () => document.getElementById("next") as HTMLButtonElement;

  it("advances and retreats with next/prev, completing passed steps", async () => {
    await start();
    next().click();
    expect(states()).toEqual(["complete", "current", "upcoming"]);
    expect(currents()).toEqual([null, "step", null]);
    previous().click();
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
  });

  it("ignores moves past either end", async () => {
    await start();
    previous().click(); // already at the first step
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    next().click();
    next().click();
    next().click(); // already at the last step
    expect(states()).toEqual(["complete", "complete", "current"]);
  });

  it("clamps an out-of-range initial index on connect", async () => {
    await start('data-stimeo--stepper-index-value="99"');
    expect(states()).toEqual(["complete", "complete", "current"]);
    expect(currents()).toEqual([null, null, "step"]);
  });

  it("goto jumps to a step via its index param", async () => {
    await start();
    buttons()[2]?.click();
    expect(states()).toEqual(["complete", "complete", "current"]);
    expect(currents()).toEqual([null, null, "step"]);
  });

  it("rejects a fractional goto param instead of rendering no current step", async () => {
    await start();
    buttons()[1]?.setAttribute("data-stimeo--stepper-index-param", "1.5");
    buttons()[1]?.click();
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    expect(currents()).toEqual(["step", null, null]);
  });

  it("ignores goto when the index param is missing or not numeric", async () => {
    await start();
    buttons()[1]?.removeAttribute("data-stimeo--stepper-index-param");
    buttons()[1]?.click();
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);

    buttons()[2]?.setAttribute("data-stimeo--stepper-index-param", "abc");
    buttons()[2]?.click();
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    expect(currents()).toEqual(["step", null, null]);
  });

  it("normalizes non-finite, fractional, and negative initial indexes", async () => {
    await start('data-stimeo--stepper-index-value="NaN"');
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    expect(root().getAttribute("data-stimeo--stepper-index-value")).toBe("0");

    disconnectAndStopApplication(application);
    await start('data-stimeo--stepper-index-value="1.9"');
    expect(states()).toEqual(["complete", "current", "upcoming"]);
    expect(root().getAttribute("data-stimeo--stepper-index-value")).toBe("1");

    disconnectAndStopApplication(application);
    await start('data-stimeo--stepper-index-value="-1"');
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    expect(root().getAttribute("data-stimeo--stepper-index-value")).toBe("0");
  });

  it("re-renders when the index value changes at runtime", async () => {
    await start();
    const changes: CustomEvent[] = [];
    root().addEventListener("stimeo--stepper:change", (event) => {
      changes.push(event as CustomEvent);
    });
    root().setAttribute("data-stimeo--stepper-index-value", "2");
    await tick();
    expect(states()).toEqual(["complete", "complete", "current"]);
    expect(currents()).toEqual([null, null, "step"]);
    // A re-derivation from a Value write is not a move: `change` must not fire.
    expect(changes).toEqual([]);
  });

  it("blocks skipping ahead under linear (but allows going back)", async () => {
    await start('data-stimeo--stepper-linear-value="true"');
    buttons()[2]?.click(); // skip from 0 to 2 is blocked
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    buttons()[1]?.click(); // one step ahead is allowed
    expect(states()).toEqual(["complete", "current", "upcoming"]);
    buttons()[0]?.click(); // going back is always allowed
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
  });

  it("dispatches change with index, previous, and the step element", async () => {
    await start();
    const details: Array<{ index: number; previous: number; step: HTMLElement }> = [];
    root().addEventListener("stimeo--stepper:change", (event) => {
      details.push(
        (event as CustomEvent<{ index: number; previous: number; step: HTMLElement }>).detail,
      );
    });
    buttons()[1]?.click();
    expect(details).toEqual([{ index: 1, previous: 0, step: steps()[1] }]);
  });

  it("does not dispatch change for no-op or blocked moves", async () => {
    await start('data-stimeo--stepper-linear-value="true"');
    const changes: CustomEvent[] = [];
    root().addEventListener("stimeo--stepper:change", (event) => {
      changes.push(event as CustomEvent);
    });

    buttons()[0]?.click(); // already current
    previous().click(); // before the first step
    buttons()[2]?.click(); // blocked by linear mode
    expect(changes).toEqual([]);
  });

  it("becomes inert after the Stimulus binding is unloaded", async () => {
    await start();
    application.unload("stimeo--stepper");
    next().click();
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    expect(currents()).toEqual(["step", null, null]);
  });

  it("announces the current step on its button", async () => {
    await start();
    const phrases = await captureSpeech({ container: root(), steps: 2 });
    expect(phrases).toEqual([
      "list",
      "listitem, level 1, position 1, set size 3",
      "button, Account, current step",
    ]);
  });

  it("has no machine-detectable a11y violations", async () => {
    await start();
    await expectNoA11yViolations(root());
  });
});
