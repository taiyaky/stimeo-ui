import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SeparatorController } from "../src/controllers/separator_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link SeparatorController}: the `separator` role
 * semantics for a decorative divider, plus the Window Splitter side of the
 * optional focusable/value-bearing variant — `aria-valuenow` sync and
 * arrow-key adjustment on the axis the orientation selects.
 */

describe("SeparatorController", () => {
  let application: Application;

  const start = async (markup: string) => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--separator", SeparatorController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const separator = () => query("[data-controller='stimeo--separator']");
  const key = (k: string) =>
    separator().dispatchEvent(new KeyboardEvent("keydown", { key: k, cancelable: true }));

  describe("decorative", () => {
    beforeEach(async () => {
      await start(`
        <div data-controller="stimeo--separator"
             data-stimeo--separator-orientation-value="horizontal"
             data-action="keydown->stimeo--separator#onKeydown"></div>`);
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
      const changes = vi.fn();
      separator().addEventListener("stimeo--separator:change", changes);
      key("Home");
      changes.mockClear();
      key("ArrowLeft");
      expect(separator().getAttribute("aria-valuenow")).toBe("0");
      expect(changes).not.toHaveBeenCalled();
    });

    it("dispatches a change event with the new value", () => {
      let value: number | null = null;
      separator().addEventListener("stimeo--separator:change", (event) => {
        value = (event as CustomEvent<{ value: number }>).detail.value;
      });
      key("ArrowRight");
      expect(value).toBe(51);
    });

    it("leaves a modified arrow to the browser", () => {
      // A chorded arrow is the browser's (history back/forward and the like), so
      // the separator neither consumes the key nor moves its value.
      const chord = new KeyboardEvent("keydown", {
        key: "ArrowRight",
        altKey: true,
        cancelable: true,
      });
      separator().dispatchEvent(chord);

      expect(chord.defaultPrevented).toBe(false);
      expect(separator().getAttribute("aria-valuenow")).toBe("50");
    });

    it("prevents default on a handled key", () => {
      const event = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true });
      separator().dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it("respects a custom step", async () => {
      disconnectAndStopApplication(application);
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
      <div data-controller="stimeo--separator" role="separator"
           aria-label="Resize" aria-orientation="vertical"
           data-stimeo--separator-focusable-value="true"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);
    // connect() fills in min/max/now so arrow keys have a bounded range to clamp to.
    expect(separator().getAttribute("tabindex")).toBe("0");
    expect(separator().getAttribute("aria-valuemin")).toBe("0");
    expect(separator().getAttribute("aria-valuemax")).toBe("100");
    expect(separator().getAttribute("aria-valuenow")).toBe("0");

    key("ArrowRight");
    expect(separator().getAttribute("aria-valuenow")).toBe("1");
  });

  it("hydrates authored range state and restores every attribute on disconnect", async () => {
    await start(`
      <div data-controller="stimeo--separator" role="presentation" tabindex="-1"
           aria-label="Resize" aria-orientation="vertical"
           aria-valuemin="20" aria-valuemax="80" aria-valuenow="50"
           data-stimeo--separator-focusable-value="true"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);

    expect(separator().getAttribute("role")).toBe("separator");
    expect(separator().getAttribute("tabindex")).toBe("0");
    expect(separator().getAttribute("aria-orientation")).toBe("vertical");
    expect(separator().getAttribute("aria-valuemin")).toBe("20");
    expect(separator().getAttribute("aria-valuemax")).toBe("80");
    expect(separator().getAttribute("aria-valuenow")).toBe("50");
    expect(separator().getAttribute("data-stimeo--separator-min-value")).toBe("20");
    expect(separator().getAttribute("data-stimeo--separator-max-value")).toBe("80");
    expect(separator().getAttribute("data-stimeo--separator-value-value")).toBe("50");

    application.unload("stimeo--separator");

    expect(separator().getAttribute("role")).toBe("presentation");
    expect(separator().getAttribute("tabindex")).toBe("-1");
    expect(separator().getAttribute("aria-orientation")).toBe("vertical");
    expect(separator().getAttribute("aria-valuemin")).toBe("20");
    expect(separator().getAttribute("aria-valuemax")).toBe("80");
    expect(separator().getAttribute("aria-valuenow")).toBe("50");
  });

  it("defaults the orientation when neither input spelling is authored", async () => {
    await start('<div data-controller="stimeo--separator"></div>');

    expect(separator().getAttribute("aria-orientation")).toBe("horizontal");
  });

  it("uses explicit Values as the canonical source for every rendered output", async () => {
    await start(`
      <div data-controller="stimeo--separator" role="presentation" tabindex="-1"
           aria-label="Resize" aria-orientation="vertical"
           aria-valuemin="20" aria-valuemax="80" aria-valuenow="50"
           data-stimeo--separator-orientation-value="horizontal"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-min-value="10"
           data-stimeo--separator-max-value="90"
           data-stimeo--separator-value-value="30"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);

    expect(separator().getAttribute("role")).toBe("separator");
    expect(separator().getAttribute("tabindex")).toBe("0");
    expect(separator().getAttribute("aria-orientation")).toBe("horizontal");
    expect(separator().getAttribute("aria-valuemin")).toBe("10");
    expect(separator().getAttribute("aria-valuemax")).toBe("90");
    expect(separator().getAttribute("aria-valuenow")).toBe("30");
  });

  it("writes keyboard changes back to the value Value", async () => {
    await start(`
      <div data-controller="stimeo--separator" aria-label="Resize"
           data-stimeo--separator-orientation-value="vertical"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-min-value="20"
           data-stimeo--separator-max-value="80"
           data-stimeo--separator-step-value="5"
           data-stimeo--separator-value-value="50"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);

    key("ArrowRight");

    expect(separator().getAttribute("aria-valuenow")).toBe("55");
    expect(separator().getAttribute("data-stimeo--separator-value-value")).toBe("55");
  });

  it("silently reconciles batched runtime Value changes", async () => {
    await start(`
      <div data-controller="stimeo--separator" aria-label="Resize"
           data-stimeo--separator-orientation-value="vertical"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-min-value="0"
           data-stimeo--separator-max-value="100"
           data-stimeo--separator-value-value="50"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);
    const changes = vi.fn();
    separator().addEventListener("stimeo--separator:change", changes);

    separator().setAttribute("data-stimeo--separator-orientation-value", "horizontal");
    separator().setAttribute("data-stimeo--separator-min-value", "10");
    separator().setAttribute("data-stimeo--separator-max-value", "40");
    separator().setAttribute("data-stimeo--separator-value-value", "90");
    await tick();

    expect(separator().getAttribute("aria-orientation")).toBe("horizontal");
    expect(separator().getAttribute("aria-valuemin")).toBe("10");
    expect(separator().getAttribute("aria-valuemax")).toBe("40");
    expect(separator().getAttribute("aria-valuenow")).toBe("40");
    expect(changes).not.toHaveBeenCalled();
  });

  it("removes and restores focusable semantics when focusable changes", async () => {
    await start(`
      <div data-controller="stimeo--separator" aria-label="Resize"
           data-stimeo--separator-orientation-value="vertical"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-min-value="20"
           data-stimeo--separator-max-value="80"
           data-stimeo--separator-value-value="50"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);

    separator().setAttribute("data-stimeo--separator-focusable-value", "false");
    await tick();

    expect(separator().hasAttribute("tabindex")).toBe(false);
    expect(separator().hasAttribute("aria-valuemin")).toBe(false);
    expect(separator().hasAttribute("aria-valuemax")).toBe(false);
    expect(separator().hasAttribute("aria-valuenow")).toBe(false);
    key("ArrowRight");
    expect(separator().getAttribute("data-stimeo--separator-value-value")).toBe("50");

    separator().setAttribute("data-stimeo--separator-focusable-value", "true");
    await tick();

    expect(separator().getAttribute("tabindex")).toBe("0");
    expect(separator().getAttribute("aria-valuemin")).toBe("20");
    expect(separator().getAttribute("aria-valuemax")).toBe("80");
    expect(separator().getAttribute("aria-valuenow")).toBe("50");
  });

  it("normalizes invalid and inverted runtime ranges", async () => {
    await start(`
      <div data-controller="stimeo--separator" aria-label="Resize"
           data-stimeo--separator-orientation-value="sideways"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-min-value="80"
           data-stimeo--separator-max-value="20"
           data-stimeo--separator-step-value="0"
           data-stimeo--separator-value-value="150"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);

    expect(separator().getAttribute("aria-orientation")).toBe("horizontal");
    expect(separator().getAttribute("aria-valuemin")).toBe("80");
    expect(separator().getAttribute("aria-valuemax")).toBe("80");
    expect(separator().getAttribute("aria-valuenow")).toBe("80");
    expect(separator().getAttribute("data-stimeo--separator-value-value")).toBe("80");

    separator().setAttribute("data-stimeo--separator-min-value", "0");
    separator().setAttribute("data-stimeo--separator-max-value", "100");
    separator().setAttribute("data-stimeo--separator-value-value", "10");
    await tick();
    key("ArrowUp");
    expect(separator().getAttribute("aria-valuenow")).toBe("11");
  });

  it("uses finite defaults for non-finite Value inputs", async () => {
    await start(`
      <div data-controller="stimeo--separator" aria-label="Resize"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-min-value="NaN"
           data-stimeo--separator-max-value="Infinity"
           data-stimeo--separator-value-value="NaN"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);

    expect(separator().getAttribute("aria-valuemin")).toBe("0");
    expect(separator().getAttribute("aria-valuemax")).toBe("100");
    expect(separator().getAttribute("aria-valuenow")).toBe("0");
    expect(separator().getAttribute("data-stimeo--separator-value-value")).toBe("0");
  });

  it("does not hydrate non-finite authored ARIA into Values", async () => {
    await start(`
      <div data-controller="stimeo--separator" aria-label="Resize"
           aria-valuemin="Infinity" aria-valuemax="-Infinity" aria-valuenow="Infinity"
           data-stimeo--separator-focusable-value="true"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);

    expect(separator().getAttribute("aria-valuemin")).toBe("0");
    expect(separator().getAttribute("aria-valuemax")).toBe("100");
    expect(separator().getAttribute("aria-valuenow")).toBe("0");
    expect(separator().hasAttribute("data-stimeo--separator-min-value")).toBe(false);
    expect(separator().hasAttribute("data-stimeo--separator-max-value")).toBe(false);
    expect(separator().hasAttribute("data-stimeo--separator-value-value")).toBe(false);
  });

  it("keeps off-grid finite endpoints reachable", async () => {
    await start(`
      <div data-controller="stimeo--separator" aria-label="Resize"
           data-stimeo--separator-orientation-value="vertical"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-min-value="0"
           data-stimeo--separator-max-value="94"
           data-stimeo--separator-step-value="10"
           data-stimeo--separator-value-value="94"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);

    key("ArrowLeft");
    expect(separator().getAttribute("aria-valuenow")).toBe("90");
    key("ArrowRight");
    expect(separator().getAttribute("aria-valuenow")).toBe("94");
  });

  it("returns managed attributes before Turbo caches the page", async () => {
    await start(`
      <div data-controller="stimeo--separator" role="presentation" tabindex="-1"
           aria-label="Resize" aria-orientation="vertical"
           aria-valuemin="1" aria-valuemax="9" aria-valuenow="4"
           data-stimeo--separator-orientation-value="horizontal"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-min-value="10"
           data-stimeo--separator-max-value="90"
           data-stimeo--separator-value-value="30"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);

    expect(separator().getAttribute("role")).toBe("separator");
    expect(separator().getAttribute("tabindex")).toBe("0");
    expect(separator().getAttribute("aria-orientation")).toBe("horizontal");
    expect(separator().getAttribute("aria-valuemin")).toBe("10");
    expect(separator().getAttribute("aria-valuemax")).toBe("90");
    expect(separator().getAttribute("aria-valuenow")).toBe("30");

    // A morph can queue a repaint immediately before Turbo snapshots the page.
    // The rewind must invalidate that pending pass as well as return the leases.
    separator().setAttribute("data-stimeo--separator-value-value", "40");
    document.dispatchEvent(new CustomEvent("turbo:before-cache"));
    await tick();

    expect(separator().getAttribute("role")).toBe("presentation");
    expect(separator().getAttribute("tabindex")).toBe("-1");
    expect(separator().getAttribute("aria-orientation")).toBe("vertical");
    expect(separator().getAttribute("aria-valuemin")).toBe("1");
    expect(separator().getAttribute("aria-valuemax")).toBe("9");
    expect(separator().getAttribute("aria-valuenow")).toBe("4");
  });

  it("keeps multiple separator instances independent", async () => {
    await start(`
      <div data-controller="stimeo--separator" aria-label="First"
           data-stimeo--separator-orientation-value="vertical"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-value-value="20"
           data-action="keydown->stimeo--separator#onKeydown"></div>
      <div data-controller="stimeo--separator" aria-label="Second"
           data-stimeo--separator-orientation-value="vertical"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-value-value="70"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);
    const separators = Array.from(
      document.querySelectorAll<HTMLElement>("[data-controller='stimeo--separator']"),
    );

    separators[1]?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true }),
    );

    expect(separators[0]?.getAttribute("aria-valuenow")).toBe("20");
    expect(separators[1]?.getAttribute("aria-valuenow")).toBe("71");
  });

  it("becomes inert after disconnect", async () => {
    await start(`
      <div data-controller="stimeo--separator" role="separator" tabindex="0"
           aria-label="Resize" aria-orientation="vertical"
           aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"
           data-stimeo--separator-focusable-value="true"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);
    application.unload("stimeo--separator");
    key("ArrowRight");
    expect(separator().getAttribute("aria-valuenow")).toBe("50");
  });
});
