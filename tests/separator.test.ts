import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SeparatorController } from "../src/controllers/separator_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link SeparatorController}: the APG Separator semantics
 * for a decorative divider, plus the optional focusable/value-bearing variant's
 * `aria-valuenow` sync and arrow-key adjustment.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SeparatorController", () => {
  let application: Application;

  const start = async (markup: string) => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--separator", SeparatorController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const separator = () => query("[data-controller='stimeo--separator']");
  const key = (k: string) =>
    separator().dispatchEvent(new KeyboardEvent("keydown", { key: k, cancelable: true }));

  describe("decorative", () => {
    beforeEach(async () => {
      await start(`
        <div data-controller="stimeo--separator"
             data-stimeo--separator-orientation-value="horizontal"></div>`);
    });

    it("adds role and aria-orientation", () => {
      expect(separator().getAttribute("role")).toBe("separator");
      expect(separator().getAttribute("aria-orientation")).toBe("horizontal");
    });

    it("is not focusable and ignores arrow keys", () => {
      expect(separator().hasAttribute("tabindex")).toBe(false);
      key("ArrowUp");
      expect(separator().hasAttribute("aria-valuenow")).toBe(false);
    });

    it("has no machine-detectable a11y violations", async () => {
      await expectNoA11yViolations(document.body, { rules: { region: { enabled: false } } });
    });
  });

  describe("focusable / value-bearing", () => {
    beforeEach(async () => {
      await start(`
        <div data-controller="stimeo--separator" role="separator" tabindex="0"
             aria-label="Resize sidebar" aria-orientation="vertical"
             aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"
             data-stimeo--separator-focusable-value="true"
             data-action="keydown->stimeo--separator#onKeydown"></div>`);
    });

    it("increases the value on ArrowRight (vertical orientation)", () => {
      key("ArrowRight");
      expect(separator().getAttribute("aria-valuenow")).toBe("51");
    });

    it("decreases the value on ArrowLeft", () => {
      key("ArrowLeft");
      expect(separator().getAttribute("aria-valuenow")).toBe("49");
    });

    it("ignores the cross-axis arrows for a vertical separator", () => {
      key("ArrowUp");
      expect(separator().getAttribute("aria-valuenow")).toBe("50");
    });

    it("jumps to min/max on Home/End", () => {
      key("Home");
      expect(separator().getAttribute("aria-valuenow")).toBe("0");
      key("End");
      expect(separator().getAttribute("aria-valuenow")).toBe("100");
    });

    it("clamps at the bounds", () => {
      key("Home");
      key("ArrowLeft");
      expect(separator().getAttribute("aria-valuenow")).toBe("0");
    });

    it("dispatches a change event with the new value", () => {
      let value: number | null = null;
      separator().addEventListener("stimeo--separator:change", (event) => {
        value = (event as CustomEvent<{ value: number }>).detail.value;
      });
      key("ArrowRight");
      expect(value).toBe(51);
    });

    it("prevents default on a handled key", () => {
      const event = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true });
      separator().dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it("respects a custom step", async () => {
      application.stop();
      await start(`
        <div data-controller="stimeo--separator" role="separator" tabindex="0"
             aria-label="Resize" aria-orientation="vertical"
             aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"
             data-stimeo--separator-focusable-value="true"
             data-stimeo--separator-step-value="10"
             data-action="keydown->stimeo--separator#onKeydown"></div>`);
      key("ArrowRight");
      expect(separator().getAttribute("aria-valuenow")).toBe("60");
    });

    it("has no machine-detectable a11y violations", async () => {
      await expectNoA11yViolations(document.body, { rules: { region: { enabled: false } } });
    });

    it("announces the separator role, name, and value", async () => {
      const spoken = await captureSpeech({ container: separator(), steps: 0 });
      expect(spoken).toEqual([
        "separator, Resize sidebar, orientated vertically, max value 100, min value 0, 50",
      ]);
    });
  });

  describe("focusable / horizontal orientation", () => {
    beforeEach(async () => {
      await start(`
        <div data-controller="stimeo--separator" role="separator" tabindex="0"
             aria-label="Resize panel" aria-orientation="horizontal"
             aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"
             data-stimeo--separator-focusable-value="true"
             data-action="keydown->stimeo--separator#onKeydown"></div>`);
    });

    it("increases on ArrowUp and decreases on ArrowDown (vertical axis)", () => {
      key("ArrowUp");
      expect(separator().getAttribute("aria-valuenow")).toBe("51");
      key("ArrowDown");
      expect(separator().getAttribute("aria-valuenow")).toBe("50");
    });

    it("ignores the cross-axis arrows for a horizontal separator", () => {
      key("ArrowRight");
      expect(separator().getAttribute("aria-valuenow")).toBe("50");
    });
  });

  it("seeds default value bounds when the consumer omits them", async () => {
    await start(`
      <div data-controller="stimeo--separator" role="separator" tabindex="0"
           aria-label="Resize" aria-orientation="vertical"
           data-stimeo--separator-focusable-value="true"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);
    // connect() fills in min/max/now so arrow keys have a bounded range to clamp to.
    expect(separator().getAttribute("aria-valuemin")).toBe("0");
    expect(separator().getAttribute("aria-valuemax")).toBe("100");
    expect(separator().getAttribute("aria-valuenow")).toBe("0");

    key("ArrowRight");
    expect(separator().getAttribute("aria-valuenow")).toBe("1");
  });

  it("becomes inert after disconnect", async () => {
    await start(`
      <div data-controller="stimeo--separator" role="separator" tabindex="0"
           aria-label="Resize" aria-orientation="vertical"
           aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"
           data-stimeo--separator-focusable-value="true"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);
    application.stop();
    key("ArrowRight");
    expect(separator().getAttribute("aria-valuenow")).toBe("50");
  });
});
