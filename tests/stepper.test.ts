import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { StepperController } from "../src/controllers/stepper_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link StepperController}: `next`/`prev`/`goto`
 * navigation, derived `data-state`/`aria-current`, out-of-range and `linear`
 * guards, and the `change` event.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const markup = (attrs = "") => `
  <ol data-controller="stimeo--stepper" ${attrs}>
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
  </ol>`;

describe("StepperController", () => {
  let application: Application;

  const start = async (attrs = "") => {
    document.body.innerHTML = markup(attrs);
    application = Application.start();
    application.register("stimeo--stepper", StepperController);
    await tick();
  };

  afterEach(() => {
    application.stop();
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

  const controller = () =>
    application.getControllerForElementAndIdentifier(root(), "stimeo--stepper") as unknown as {
      next(): void;
      prev(): void;
    };

  it("advances and retreats with next/prev, completing passed steps", async () => {
    await start();
    controller().next();
    expect(states()).toEqual(["complete", "current", "upcoming"]);
    expect(currents()).toEqual([null, "step", null]);
    controller().prev();
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
  });

  it("ignores moves past either end", async () => {
    await start();
    controller().prev(); // already at the first step
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    controller().next();
    controller().next();
    controller().next(); // already at the last step
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
    const details: Array<{ index: number; previous: number }> = [];
    root().addEventListener("stimeo--stepper:change", (event) => {
      const detail = (event as CustomEvent).detail;
      details.push({ index: detail.index, previous: detail.previous });
      expect(detail.step).toBe(steps()[detail.index]);
    });
    buttons()[1]?.click();
    expect(details).toEqual([{ index: 1, previous: 0 }]);
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
