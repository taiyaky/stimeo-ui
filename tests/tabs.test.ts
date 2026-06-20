import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TabsController } from "../src/controllers/tabs_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link TabsController}: `aria-selected`, roving
 * `tabindex`, panel visibility, and automatic-activation arrow navigation.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("TabsController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--tabs">
        <div role="tablist">
          <button role="tab" id="t1" aria-controls="p1"
                  data-stimeo--tabs-target="tab"
                  data-action="stimeo--tabs#select keydown->stimeo--tabs#onKeydown">One</button>
          <button role="tab" id="t2" aria-controls="p2"
                  data-stimeo--tabs-target="tab"
                  data-action="stimeo--tabs#select keydown->stimeo--tabs#onKeydown">Two</button>
          <button role="tab" id="t3" aria-controls="p3"
                  data-stimeo--tabs-target="tab"
                  data-action="stimeo--tabs#select keydown->stimeo--tabs#onKeydown">Three</button>
        </div>
        <div role="tabpanel" id="p1" aria-labelledby="t1" data-stimeo--tabs-target="panel">Panel one</div>
        <div role="tabpanel" id="p2" aria-labelledby="t2" data-stimeo--tabs-target="panel">Panel two</div>
        <div role="tabpanel" id="p3" aria-labelledby="t3" data-stimeo--tabs-target="panel">Panel three</div>
      </div>`;
    application = Application.start();
    application.register("stimeo--tabs", TabsController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const tabs = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("[data-stimeo--tabs-target='tab']"));
  const panels = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--tabs-target='panel']"));

  it("selects the first tab by default with roving tabindex", () => {
    expect(tabs()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs()[0]?.tabIndex).toBe(0);
    expect(tabs()[1]?.tabIndex).toBe(-1);
    expect(panels()[0]?.hidden).toBe(false);
    expect(panels()[1]?.hidden).toBe(true);
  });

  it("selects a tab on click", () => {
    tabs()[1]?.click();
    expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs()[0]?.getAttribute("aria-selected")).toBe("false");
    expect(panels()[1]?.hidden).toBe(false);
  });

  it("activates and focuses the next tab on ArrowRight", () => {
    tabs()[0]?.focus();
    tabs()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs()[1]);
  });

  it("wraps to the first tab from the last on ArrowRight", () => {
    tabs()[2]?.focus();
    tabs()[2]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(tabs()[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("jumps to the last tab on End and the first on Home", () => {
    tabs()[0]?.focus();
    tabs()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(tabs()[2]?.getAttribute("aria-selected")).toBe("true");
    tabs()[2]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(tabs()[0]?.getAttribute("aria-selected")).toBe("true");
  });

  const root = () => {
    const element = document.querySelector<HTMLElement>("[data-controller='stimeo--tabs']");
    if (!element) throw new Error("tabs not found");
    return element;
  };

  // Layer ① — machine-detectable a11y in the connected (first tab selected) state.
  it("has no machine-detectable a11y violations", async () => {
    await expectNoA11yViolations(root());
  });

  // Layer ③ — speech-order regression: roving selection must move with arrow
  // navigation. The whole ordered tablist + active panel announcement is pinned so
  // a lost role, a flipped aria-selected, or a desynced panel surfaces as a diff.
  it("announces selection and roving order before and after arrow navigation", async () => {
    const before = await captureSpeech({ container: root(), steps: 5 });
    expect(before).toEqual([
      "tablist, orientated horizontally",
      "tab, One, selected, 1 control, position 1, set size 3",
      "tab, Two, not selected, 1 control, position 2, set size 3",
      "tab, Three, not selected, 1 control, position 3, set size 3",
      "end of tablist, orientated horizontally",
      "tabpanel, One",
    ]);

    tabs()[0]?.focus();
    tabs()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const after = await captureSpeech({ container: root(), steps: 5 });
    expect(after).toEqual([
      "tablist, orientated horizontally",
      "tab, One, not selected, 1 control, position 1, set size 3",
      "tab, Two, selected, 1 control, position 2, set size 3",
      "tab, Three, not selected, 1 control, position 3, set size 3",
      "end of tablist, orientated horizontally",
      "tabpanel, Two",
    ]);
  });

  // Disconnect-teardown regression. The controller holds no timers, observers, or
  // document/window listeners (only Stimulus-managed data-action bindings), so
  // teardown means: after application.stop() the tabs are inert — a click no
  // longer reselects and arrow navigation no longer moves or activates.
  it("becomes inert after disconnect (no lingering side effects)", () => {
    application.stop();
    tabs()[1]?.click();
    expect(tabs()[1]?.getAttribute("aria-selected")).toBe("false");
    expect(tabs()[0]?.getAttribute("aria-selected")).toBe("true");

    tabs()[0]?.focus();
    tabs()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(tabs()[1]?.getAttribute("aria-selected")).toBe("false");
    expect(document.activeElement).toBe(tabs()[0]);
  });
});
