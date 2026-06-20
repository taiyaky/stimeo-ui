import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { ProgressController } from "../src/controllers/progress_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link ProgressController}: ARIA value-attribute sync,
 * `--stimeo-progress-ratio`, the indeterminate state, and the change/complete
 * events.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ProgressController", () => {
  let application: Application;

  const start = async (attrs = "", inner = "") => {
    document.body.innerHTML = `
      <div data-controller="stimeo--progress" role="progressbar" aria-label="Upload"
           aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" ${attrs}
           data-action="progress:set->stimeo--progress#setValue">
        <div data-stimeo--progress-target="bar"></div>
        ${inner}
      </div>`;
    application = Application.start();
    application.register("stimeo--progress", ProgressController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--progress']");
  const instance = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--progress",
    ) as ProgressController;

  it("reflects the initial value onto ARIA and the ratio on connect", async () => {
    await start('data-stimeo--progress-value-value="40"');
    expect(root().getAttribute("aria-valuenow")).toBe("40");
    expect(root().style.getPropertyValue("--stimeo-progress-ratio")).toBe("0.4");
    expect(root().getAttribute("data-state")).toBe("determinate");
  });

  it("updates the value from an event detail and syncs ARIA", async () => {
    await start();
    root().dispatchEvent(new CustomEvent("progress:set", { detail: { value: 25 } }));
    expect(root().getAttribute("aria-valuenow")).toBe("25");
    expect(root().style.getPropertyValue("--stimeo-progress-ratio")).toBe("0.25");
  });

  it("clamps out-of-range values into [min, max]", async () => {
    await start();
    instance().setValue({ params: { amount: 250 } } as unknown as Event);
    expect(root().getAttribute("aria-valuenow")).toBe("100");
    instance().setValue({ params: { amount: -10 } } as unknown as Event);
    expect(root().getAttribute("aria-valuenow")).toBe("0");
  });

  // Action params arrive as strings (`data-...-amount-param`); cover the string
  // form so a regression in the coercion path is caught.
  it("accepts a string action-param amount", async () => {
    await start();
    instance().setValue({ params: { amount: "60" } } as unknown as Event);
    expect(root().getAttribute("aria-valuenow")).toBe("60");
    expect(root().style.getPropertyValue("--stimeo-progress-ratio")).toBe("0.6");
  });

  it("clamps an out-of-range initial value when computing the ratio", async () => {
    await start('data-stimeo--progress-value-value="250"');
    expect(root().getAttribute("aria-valuenow")).toBe("100");
    expect(root().style.getPropertyValue("--stimeo-progress-ratio")).toBe("1");
  });

  it("honors custom min/max when normalizing the ratio", async () => {
    await start(
      'data-stimeo--progress-min-value="0" data-stimeo--progress-max-value="200" data-stimeo--progress-value-value="50"',
    );
    expect(root().style.getPropertyValue("--stimeo-progress-ratio")).toBe("0.25");
  });

  it("dispatches change on every update with value and ratio", async () => {
    await start();
    let detail: { value: number; ratio: number } | null = null;
    root().addEventListener("stimeo--progress:change", (event) => {
      detail = (event as CustomEvent<{ value: number; ratio: number }>).detail;
    });
    instance().setValue({ params: { amount: 60 } } as unknown as Event);
    expect(detail).toEqual({ value: 60, ratio: 0.6 });
  });

  it("dispatches complete when the value reaches max", async () => {
    await start();
    let completed = false;
    root().addEventListener("stimeo--progress:complete", () => {
      completed = true;
    });
    instance().setValue({ params: { amount: 100 } } as unknown as Event);
    expect(completed).toBe(true);
  });

  it("drops aria-valuenow in the indeterminate state", async () => {
    await start('data-stimeo--progress-indeterminate-value="true"');
    expect(root().hasAttribute("aria-valuenow")).toBe(false);
    expect(root().getAttribute("data-state")).toBe("indeterminate");
  });

  it("leaving the indeterminate state via setValue restores aria-valuenow", async () => {
    await start('data-stimeo--progress-indeterminate-value="true"');
    instance().setValue({ detail: { value: 30 } } as unknown as Event);
    expect(root().getAttribute("aria-valuenow")).toBe("30");
    expect(root().getAttribute("data-state")).toBe("determinate");
  });

  it("fills aria-valuetext from the template", async () => {
    await start(
      'data-stimeo--progress-value-value="40" data-stimeo--progress-value-text-value="{percent}% uploaded"',
    );
    expect(root().getAttribute("aria-valuetext")).toBe("40% uploaded");
  });

  it("ignores missing and non-numeric updates", async () => {
    await start('data-stimeo--progress-value-value="40"');
    instance().setValue({ detail: {} } as unknown as Event);
    instance().setValue({ params: { amount: "abc" } } as unknown as Event);
    instance().setValue({ detail: { value: "" } } as unknown as Event);
    expect(root().getAttribute("aria-valuenow")).toBe("40");
  });

  it("has no machine-detectable a11y violations", async () => {
    await start('data-stimeo--progress-value-value="40"');
    await expectNoA11yViolations(document.body, { rules: { region: { enabled: false } } });
  });

  it("announces the progressbar role, name, and value", async () => {
    await start('data-stimeo--progress-value-value="40"');
    const spoken = await captureSpeech({ container: root(), steps: 0 });
    // Freeze the whole ordered array (not a name-only `toContain`): the progressbar
    // role, name, and value range are all the AT announces.
    expect(spoken).toEqual(["progressbar, Upload, max value 100, min value 0, current value 40%"]);
  });
});
