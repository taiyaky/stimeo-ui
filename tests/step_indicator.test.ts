import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { StepIndicatorController } from "../src/controllers/step_indicator_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link StepIndicatorController}: the read-only progress
 * indicator — derived `data-state`/`aria-current`, the progress-ratio custom
 * property, `setCurrent` updates, and the `change` event.
 */

const markup = (current: number | string = 1) => `
  <ol data-controller="stimeo--step-indicator" aria-label="Checkout progress"
      data-stimeo--step-indicator-current-value="${current}"
      data-action="step:set->stimeo--step-indicator#setCurrent">
    <li data-stimeo--step-indicator-target="step">Cart</li>
    <li data-stimeo--step-indicator-target="step">Shipping</li>
    <li data-stimeo--step-indicator-target="step">Payment</li>
  </ol>`;

/** Same contract as {@link markup}, with the step count and the `current` attribute free. */
const customMarkup = (steps: number, currentAttribute = "") => `
  <ol data-controller="stimeo--step-indicator" aria-label="Checkout progress" ${currentAttribute}
      data-action="step:set->stimeo--step-indicator#setCurrent">
    ${Array.from({ length: steps }, (_, index) => `<li data-stimeo--step-indicator-target="step">Step ${index}</li>`).join("")}
  </ol>`;

describe("StepIndicatorController", () => {
  let application: Application;

  const start = async (current: number | string = 1) => {
    document.body.innerHTML = markup(current);
    application = Application.start();
    application.register("stimeo--step-indicator", StepIndicatorController);
    await tick();
  };

  const startWith = async (html: string) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--step-indicator", StepIndicatorController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
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
  const setStep = (current: unknown) =>
    root().dispatchEvent(new CustomEvent("step:set", { detail: { current } }));
  const ratio = () => root().style.getPropertyValue("--stimeo-step-indicator-ratio");
  const recordChanges = () => {
    const seen: Array<{ current: number; total: number }> = [];
    root().addEventListener("stimeo--step-indicator:change", (event) => {
      seen.push((event as CustomEvent).detail);
    });
    return seen;
  };

  it("derives data-state and aria-current from the initial current value", async () => {
    await start(1);
    expect(states()).toEqual(["complete", "current", "upcoming"]);
    expect(currents()).toEqual([null, "step", null]);
  });

  it("exposes the progress ratio as a custom property", async () => {
    await start(0);
    expect(root().style.getPropertyValue("--stimeo-step-indicator-ratio")).toBe("0");
    setStep(2);
    expect(ratio()).toBe("1");
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

  it("starts from the declared default current when no value attribute is given", async () => {
    await startWith(customMarkup(3));
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    expect(currents()).toEqual(["step", null, null]);
    expect(ratio()).toBe("0");
  });

  it("clamps a negative current to the first step", async () => {
    await start(-4);
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    expect(ratio()).toBe("0");
  });

  // A `current` attribute the Number Value cannot read yields NaN, which would
  // otherwise reach every state hook: no step would be `current` and the ratio
  // would be published as the literal string "NaN".
  it("falls back to the first step when current is not a finite number", async () => {
    await start("abc");
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    expect(currents()).toEqual(["step", null, null]);
    expect(ratio()).toBe("0");
  });

  it("ignores a setCurrent whose detail carries no finite index", async () => {
    await start(1);
    const seen = recordChanges();
    setStep(undefined);
    setStep("2");
    setStep(Number.NaN);
    expect(states()).toEqual(["complete", "current", "upcoming"]);
    expect(seen).toEqual([]);
  });

  it("does not dispatch change when the current step is unchanged", async () => {
    await start(1);
    const seen = recordChanges();
    setStep(1);
    setStep(1.4);
    expect(states()).toEqual(["complete", "current", "upcoming"]);
    expect(seen).toEqual([]);
  });

  it("keeps the ratio at 0 when there is only one step", async () => {
    await startWith(customMarkup(1, 'data-stimeo--step-indicator-current-value="0"'));
    expect(ratio()).toBe("0");
    expect(states()).toEqual(["current"]);
  });

  it("ignores setCurrent when there are no steps", async () => {
    await startWith(customMarkup(0, 'data-stimeo--step-indicator-current-value="0"'));
    const seen = recordChanges();
    setStep(2);
    expect(seen).toEqual([]);
    expect(ratio()).toBe("0");
  });

  const appendStep = (text = "Review") => {
    const step = document.createElement("li");
    step.setAttribute("data-stimeo--step-indicator-target", "step");
    step.textContent = text;
    root().appendChild(step);
    return step;
  };

  it("derives the state of a step appended at runtime", async () => {
    await start(1);
    appendStep();
    await tick();
    expect(states()).toEqual(["complete", "current", "upcoming", "upcoming"]);
    expect(currents()).toEqual([null, "step", null, null]);
    // The ratio's denominator is the step count, so it has to follow the new one.
    expect(ratio()).toBe(String(1 / 3));
  });

  it("keeps exactly one aria-current when the current step is removed at runtime", async () => {
    await start(2);
    steps()[2]?.remove();
    await tick();
    expect(states()).toEqual(["complete", "current"]);
    expect(currents()).toEqual([null, "step"]);
    expect(ratio()).toBe("1");
  });

  it("does not dispatch change when an authored out-of-range current already renders that step", async () => {
    await start(99);
    expect(states()).toEqual(["complete", "complete", "current"]);
    const seen = recordChanges();
    setStep(2);
    expect(seen).toEqual([]);
    setStep(0);
    expect(seen).toEqual([{ current: 0, total: 3 }]);
  });

  it("stops deriving step state once the controller is unloaded", async () => {
    await start(2);
    application.unload("stimeo--step-indicator");
    steps()[2]?.remove();
    appendStep();
    await tick();
    expect(states()).toEqual(["complete", "complete", undefined]);
    expect(currents()).toEqual([null, null, null]);
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

  it("normalises an out-of-range current even when the step does not move", async () => {
    // The consumer asked for this index and never moved; leaving the raw value in
    // the markup would let a later step set re-clamp it somewhere else.
    await startWith(customMarkup(3, 'data-stimeo--step-indicator-current-value="99"'));
    setStep(2);
    await tick();
    const added = document.createElement("li");
    added.setAttribute("data-stimeo--step-indicator-target", "step");
    root().appendChild(added);
    await tick();
    expect(states()).toEqual(["complete", "complete", "current", "upcoming"]);
  });

  it("follows a current swapped in place by a morph", async () => {
    // A morph keeps the element and swaps the attribute, so `connect()` never runs
    // again: without following the Value the indicator stays on the old step.
    await startWith(customMarkup(4, 'data-stimeo--step-indicator-current-value="0"'));
    root().setAttribute("data-stimeo--step-indicator-current-value", "3");
    await tick();
    expect(states()).toEqual(["complete", "complete", "complete", "current"]);
    expect(root().style.getPropertyValue("--stimeo-step-indicator-ratio")).toBe("1");
  });

  it("repaints once when a batch of steps arrives together", async () => {
    // Stimulus reports one callback per element, and repainting per callback rewrites
    // every step's state again — quadratic in the size of the batch.
    await startWith(customMarkup(3));
    let repaints = 0;
    const style = root().style;
    const original = style.setProperty.bind(style);
    style.setProperty = (...args: Parameters<CSSStyleDeclaration["setProperty"]>) => {
      if (args[0] === "--stimeo-step-indicator-ratio") repaints += 1;
      original(...args);
    };
    const batch = document.createDocumentFragment();
    for (let i = 0; i < 5; i += 1) {
      const step = document.createElement("li");
      step.setAttribute("data-stimeo--step-indicator-target", "step");
      batch.appendChild(step);
    }
    root().appendChild(batch);
    await tick();
    expect(repaints).toBe(1);
  });
});
