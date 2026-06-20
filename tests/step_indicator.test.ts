import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { StepIndicatorController } from "../src/controllers/step_indicator_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link StepIndicatorController}: the read-only progress
 * indicator — derived `data-state`/`aria-current`, the progress-ratio custom
 * property, `setCurrent` updates, and the `change` event.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const markup = (current = 1) => `
  <ol data-controller="stimeo--step-indicator" aria-label="Checkout progress"
      data-stimeo--step-indicator-current-value="${current}"
      data-action="step:set->stimeo--step-indicator#setCurrent">
    <li data-stimeo--step-indicator-target="step">Cart</li>
    <li data-stimeo--step-indicator-target="step">Shipping</li>
    <li data-stimeo--step-indicator-target="step">Payment</li>
  </ol>`;

describe("StepIndicatorController", () => {
  let application: Application;

  const start = async (current = 1) => {
    document.body.innerHTML = markup(current);
    application = Application.start();
    application.register("stimeo--step-indicator", StepIndicatorController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>(
      "[data-controller='stimeo--step-indicator']",
    ) as HTMLElement;
  const steps = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>("[data-stimeo--step-indicator-target='step']"),
    );
  const states = () => steps().map((step) => step.dataset.state);
  const currents = () => steps().map((step) => step.getAttribute("aria-current"));
  const setStep = (current: number) =>
    root().dispatchEvent(new CustomEvent("step:set", { detail: { current } }));

  it("derives data-state and aria-current from the initial current value", async () => {
    await start(1);
    expect(states()).toEqual(["complete", "current", "upcoming"]);
    expect(currents()).toEqual([null, "step", null]);
  });

  it("exposes the progress ratio as a custom property", async () => {
    await start(0);
    expect(root().style.getPropertyValue("--stimeo-step-indicator-ratio")).toBe("0");
    setStep(2);
    expect(root().style.getPropertyValue("--stimeo-step-indicator-ratio")).toBe("1");
    setStep(1);
    expect(root().style.getPropertyValue("--stimeo-step-indicator-ratio")).toBe("0.5");
  });

  it("updates state when setCurrent fires", async () => {
    await start(0);
    setStep(2);
    expect(states()).toEqual(["complete", "complete", "current"]);
    expect(currents()).toEqual([null, null, "step"]);
  });

  it("clamps an out-of-range current to the step set", async () => {
    await start(0);
    setStep(99);
    expect(states()).toEqual(["complete", "complete", "current"]);
  });

  it("dispatches change with current and total", async () => {
    await start(0);
    const details: Array<{ current: number; total: number }> = [];
    root().addEventListener("stimeo--step-indicator:change", (event) => {
      details.push((event as CustomEvent).detail);
    });
    setStep(1);
    expect(details).toEqual([{ current: 1, total: 3 }]);
  });

  it("announces the current step on its list item", async () => {
    await start(1);
    const phrases = await captureSpeech({ container: root(), steps: 5 });
    expect(phrases).toEqual([
      "list, Checkout progress",
      "listitem, level 1, position 1, set size 3",
      "Cart",
      "end of listitem, level 1, position 1, set size 3",
      "listitem, level 1, current step, position 2, set size 3",
      "Shipping",
    ]);
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(1);
    await expectNoA11yViolations(root());
  });
});
