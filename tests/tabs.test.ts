import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TabsController } from "../src/controllers/tabs_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link TabsController}: `aria-selected`, roving
 * `tabindex`, panel visibility, and automatic-activation arrow navigation.
 */

describe("TabsController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--tabs">
        <div role="tablist" aria-label="Example tabs" data-stimeo--tabs-target="list">
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
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const tabs = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("[data-stimeo--tabs-target='tab']"));
  const panels = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--tabs-target='panel']"));

  const tab = (index: number): HTMLButtonElement => {
    const element = tabs()[index];
    if (!element) throw new Error(`tab ${index} not found`);
    return element;
  };

  const selection = () => tabs().map((element) => element.getAttribute("aria-selected"));
  const tabIndexes = () => tabs().map((element) => element.tabIndex);
  const panelVisibility = () => panels().map((element) => !element.hidden);

  const pressKey = (element: HTMLElement, key: string): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event;
  };

  it("selects the first tab by default and synchronizes every tab and panel", () => {
    expect(selection()).toEqual(["true", "false", "false"]);
    expect(tabIndexes()).toEqual([0, -1, -1]);
    expect(panelVisibility()).toEqual([true, false, false]);
  });

  it("restores an authored preselection when the controller reconnects", async () => {
    application.unload("stimeo--tabs");
    tab(0).setAttribute("aria-selected", "false");
    tab(1).setAttribute("aria-selected", "true");
    tab(0).tabIndex = 0;
    tab(1).tabIndex = -1;
    panels()[0]?.removeAttribute("hidden");
    panels()[1]?.setAttribute("hidden", "");

    application.register("stimeo--tabs", TabsController);
    await tick();

    expect(selection()).toEqual(["false", "true", "false"]);
    expect(tabIndexes()).toEqual([-1, 0, -1]);
    expect(panelVisibility()).toEqual([false, true, false]);
  });

  it("selects a tab on click", () => {
    tab(1).click();

    expect(selection()).toEqual(["false", "true", "false"]);
    expect(tabIndexes()).toEqual([-1, 0, -1]);
    expect(panelVisibility()).toEqual([false, true, false]);
  });

  it("activates and focuses the next tab on ArrowRight", () => {
    tab(0).focus();
    const event = pressKey(tab(0), "ArrowRight");

    expect(event.defaultPrevented).toBe(true);
    expect(selection()).toEqual(["false", "true", "false"]);
    expect(tabIndexes()).toEqual([-1, 0, -1]);
    expect(panelVisibility()).toEqual([false, true, false]);
    expect(document.activeElement).toBe(tab(1));
  });

  it("wraps to the first tab from the last on ArrowRight", () => {
    tab(2).click();
    tab(2).focus();
    pressKey(tab(2), "ArrowRight");

    expect(selection()).toEqual(["true", "false", "false"]);
    expect(panelVisibility()).toEqual([true, false, false]);
    expect(document.activeElement).toBe(tab(0));
  });

  it("activates and focuses the previous tab on ArrowLeft", () => {
    tab(2).click();
    tab(2).focus();
    const event = pressKey(tab(2), "ArrowLeft");

    expect(event.defaultPrevented).toBe(true);
    expect(selection()).toEqual(["false", "true", "false"]);
    expect(tabIndexes()).toEqual([-1, 0, -1]);
    expect(panelVisibility()).toEqual([false, true, false]);
    expect(document.activeElement).toBe(tab(1));
  });

  it("wraps to the last tab from the first on ArrowLeft", () => {
    tab(0).focus();
    pressKey(tab(0), "ArrowLeft");

    expect(selection()).toEqual(["false", "false", "true"]);
    expect(panelVisibility()).toEqual([false, false, true]);
    expect(document.activeElement).toBe(tab(2));
  });

  it("moves selection, panel visibility, and focus with End and Home", () => {
    tab(1).click();
    tab(1).focus();
    const endEvent = pressKey(tab(1), "End");

    expect(endEvent.defaultPrevented).toBe(true);
    expect(selection()).toEqual(["false", "false", "true"]);
    expect(panelVisibility()).toEqual([false, false, true]);
    expect(document.activeElement).toBe(tab(2));

    const homeEvent = pressKey(tab(2), "Home");
    expect(homeEvent.defaultPrevented).toBe(true);
    expect(selection()).toEqual(["true", "false", "false"]);
    expect(panelVisibility()).toEqual([true, false, false]);
    expect(document.activeElement).toBe(tab(0));
  });

  it("does not intercept an unsupported key", () => {
    tab(0).focus();
    const event = pressKey(tab(0), "Tab");

    expect(event.defaultPrevented).toBe(false);
    expect(selection()).toEqual(["true", "false", "false"]);
    expect(panelVisibility()).toEqual([true, false, false]);
    expect(document.activeElement).toBe(tab(0));
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
      "tablist, Example tabs, orientated horizontally",
      "tab, One, selected, 1 control, position 1, set size 3",
      "tab, Two, not selected, 1 control, position 2, set size 3",
      "tab, Three, not selected, 1 control, position 3, set size 3",
      "end of tablist, Example tabs, orientated horizontally",
      "tabpanel, One",
    ]);

    tab(0).focus();
    pressKey(tab(0), "ArrowRight");
    const after = await captureSpeech({ container: root(), steps: 5 });
    expect(after).toEqual([
      "tablist, Example tabs, orientated horizontally",
      "tab, One, not selected, 1 control, position 1, set size 3",
      "tab, Two, selected, 1 control, position 2, set size 3",
      "tab, Three, not selected, 1 control, position 3, set size 3",
      "end of tablist, Example tabs, orientated horizontally",
      "tabpanel, Two",
    ]);
  });

  // Context-teardown regression. The controller holds no timers, observers, or
  // document/window listeners (only Stimulus-managed data-action bindings), so
  // unloading its identifier must make the tabs inert.
  it("becomes inert after disconnect (no lingering side effects)", () => {
    application.unload("stimeo--tabs");
    tab(1).click();
    expect(selection()).toEqual(["true", "false", "false"]);
    expect(panelVisibility()).toEqual([true, false, false]);

    tab(0).focus();
    const event = pressKey(tab(0), "ArrowRight");
    expect(event.defaultPrevented).toBe(false);
    expect(selection()).toEqual(["true", "false", "false"]);
    expect(document.activeElement).toBe(tab(0));
  });
});
