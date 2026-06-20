import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { MeterController } from "../src/controllers/meter_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link MeterController}: ARIA value-attribute sync, the
 * `--stimeo-meter-ratio`, threshold-based `data-state` segmentation, the
 * `aria-valuetext` template, and the change event.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MeterController", () => {
  let application: Application;

  const start = async (attrs = "") => {
    document.body.innerHTML = `
      <div data-controller="stimeo--meter" role="meter" aria-label="Disk usage"
           aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" ${attrs}
           data-action="meter:set->stimeo--meter#setValue">
        <div data-stimeo--meter-target="bar"></div>
      </div>`;
    application = Application.start();
    application.register("stimeo--meter", MeterController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--meter']");
  const instance = () =>
    application.getControllerForElementAndIdentifier(root(), "stimeo--meter") as MeterController;

  it("reflects the initial value onto ARIA and the ratio", async () => {
    await start('data-stimeo--meter-value-value="72"');
    expect(root().getAttribute("aria-valuenow")).toBe("72");
    expect(root().style.getPropertyValue("--stimeo-meter-ratio")).toBe("0.72");
  });

  it("classifies values into low/medium/high by threshold", async () => {
    await start(
      'data-stimeo--meter-value-value="30" data-stimeo--meter-low-value="50" data-stimeo--meter-high-value="80"',
    );
    expect(root().getAttribute("data-state")).toBe("low");
    // Action-param amounts can arrive as strings (`data-...-amount-param`).
    instance().setValue({ params: { amount: "65" } } as unknown as Event);
    expect(root().getAttribute("data-state")).toBe("medium");
    instance().setValue({ params: { amount: "90" } } as unknown as Event);
    expect(root().getAttribute("data-state")).toBe("high");
  });

  it("is medium everywhere when no thresholds are set", async () => {
    await start('data-stimeo--meter-value-value="10"');
    expect(root().getAttribute("data-state")).toBe("medium");
  });

  it("dispatches change with value, ratio, and state", async () => {
    await start('data-stimeo--meter-high-value="80"');
    let detail: { value: number; ratio: number; state: string } | null = null;
    root().addEventListener("stimeo--meter:change", (event) => {
      detail = (event as CustomEvent<{ value: number; ratio: number; state: string }>).detail;
    });
    root().dispatchEvent(new CustomEvent("meter:set", { detail: { value: 90 } }));
    expect(detail).toEqual({ value: 90, ratio: 0.9, state: "high" });
  });

  it("fills aria-valuetext from the template including the segment", async () => {
    await start(
      'data-stimeo--meter-value-value="72" data-stimeo--meter-high-value="80" data-stimeo--meter-value-text-value="{percent}% ({state})"',
    );
    expect(root().getAttribute("aria-valuetext")).toBe("72% (medium)");
  });

  it("clamps out-of-range values (including the string form)", async () => {
    await start('data-stimeo--meter-value-value="0"');
    instance().setValue({ params: { amount: 500 } } as unknown as Event);
    expect(root().getAttribute("aria-valuenow")).toBe("100");
    instance().setValue({ params: { amount: "-20" } } as unknown as Event);
    expect(root().getAttribute("aria-valuenow")).toBe("0");
  });

  it("has no machine-detectable a11y violations", async () => {
    await start('data-stimeo--meter-value-value="72"');
    await expectNoA11yViolations(document.body, { rules: { region: { enabled: false } } });
  });

  it("announces the meter role, name, and value", async () => {
    await start('data-stimeo--meter-value-value="72"');
    const spoken = await captureSpeech({ container: root(), steps: 0 });
    // Freeze the whole ordered array (not a name-only `toContain`): the meter role,
    // name, and value range are all the AT announces.
    expect(spoken).toEqual(["meter, Disk usage, min value 0, max value 100, 72"]);
  });
});
