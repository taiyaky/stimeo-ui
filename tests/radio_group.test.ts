import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RadioGroupController } from "../src/controllers/radio_group_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link RadioGroupController}: the APG Radio Group contract
 * for custom radios — single selection via `aria-checked`, roving `tabindex`,
 * arrow navigation with selection-follows-focus, and the hidden-field mirror.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("RadioGroupController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--radio-group" role="radiogroup" aria-label="Plan">
        <div role="radio" aria-checked="true" tabindex="0" data-value="basic"
             data-stimeo--radio-group-target="radio"
             data-action="click->stimeo--radio-group#select
                          keydown->stimeo--radio-group#onKeydown">Basic</div>
        <div role="radio" aria-checked="false" tabindex="-1" data-value="pro"
             data-stimeo--radio-group-target="radio"
             data-action="click->stimeo--radio-group#select
                          keydown->stimeo--radio-group#onKeydown">Pro</div>
        <div role="radio" aria-checked="false" tabindex="-1" data-value="max"
             data-stimeo--radio-group-target="radio"
             data-action="click->stimeo--radio-group#select
                          keydown->stimeo--radio-group#onKeydown">Max</div>
        <input type="hidden" data-stimeo--radio-group-target="field" />
      </div>`;
    application = Application.start();
    application.register("stimeo--radio-group", RadioGroupController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--radio-group']") as HTMLElement;
  const radios = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--radio-group-target='radio']"));
  const field = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--radio-group-target='field']",
    ) as HTMLInputElement;
  const checkedValues = () => radios().map((radio) => radio.getAttribute("aria-checked"));
  const tabindexes = () => radios().map((radio) => radio.tabIndex);
  const key = (index: number, k: string) =>
    radios()[index]?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  it("sets up roving from the preselected radio and mirrors the field", () => {
    expect(tabindexes()).toEqual([0, -1, -1]);
    expect(field().value).toBe("basic");
  });

  it("selects on click and updates roving, field, and aria-checked", () => {
    radios()[1]?.click();
    expect(checkedValues()).toEqual(["false", "true", "false"]);
    expect(tabindexes()).toEqual([-1, 0, -1]);
    expect(field().value).toBe("pro");
  });

  it("fires a native change on the field when the selection changes", () => {
    const changes: string[] = [];
    field().addEventListener("change", () => changes.push(field().value));
    radios()[1]?.click();
    expect(changes).toEqual(["pro"]);
    // Re-selecting the same radio does not re-fire (value unchanged).
    radios()[1]?.click();
    expect(changes).toEqual(["pro"]);
  });

  it("does not fire a native change for the connect-time reflection", () => {
    // The preselected radio is mirrored on connect, but that is not a user edit:
    // a listener attached after connect must not see a change until interaction.
    const changes: string[] = [];
    field().addEventListener("change", () => changes.push(field().value));
    expect(changes).toEqual([]);
  });

  it("moves and selects with ArrowDown, wrapping at the end", () => {
    key(0, "ArrowDown");
    expect(checkedValues()).toEqual(["false", "true", "false"]);
    expect(document.activeElement).toBe(radios()[1]);

    key(1, "ArrowDown");
    key(2, "ArrowDown"); // wrap back to first
    expect(checkedValues()).toEqual(["true", "false", "false"]);
    expect(document.activeElement).toBe(radios()[0]);
  });

  it("wraps backward with ArrowUp and jumps with Home/End", () => {
    key(0, "ArrowUp"); // wrap to last
    expect(document.activeElement).toBe(radios()[2]);
    expect(field().value).toBe("max");

    key(2, "Home");
    expect(document.activeElement).toBe(radios()[0]);
    key(0, "End");
    expect(document.activeElement).toBe(radios()[2]);
  });

  it("selects the focused radio on Space", () => {
    radios()[2]?.focus();
    key(2, " ");
    expect(checkedValues()).toEqual(["false", "false", "true"]);
    expect(field().value).toBe("max");
  });

  it("dispatches change with the value and the radio element", () => {
    const details: Array<{ value: string; radio: HTMLElement }> = [];
    root().addEventListener("stimeo--radio-group:change", (event) => {
      details.push((event as CustomEvent).detail);
    });
    radios()[1]?.click();
    expect(details).toHaveLength(1);
    expect(details[0]?.value).toBe("pro");
    expect(details[0]?.radio).toBe(radios()[1]);
  });

  it("announces role, name, and state in order", async () => {
    const before = await captureSpeech({ container: root(), steps: 4 });
    expect(before).toEqual([
      "radiogroup, Plan",
      "radio, Basic, checked, position 1, set size 3",
      "radio, Pro, not checked, position 2, set size 3",
      "radio, Max, not checked, position 3, set size 3",
      "end of radiogroup, Plan",
    ]);

    radios()[1]?.click();
    const after = await captureSpeech({ container: root(), steps: 4 });
    expect(after).toEqual([
      "radiogroup, Plan",
      "radio, Basic, not checked, position 1, set size 3",
      "radio, Pro, checked, position 2, set size 3",
      "radio, Max, not checked, position 3, set size 3",
      "end of radiogroup, Plan",
    ]);
  });

  it("has no machine-detectable a11y violations", async () => {
    await expectNoA11yViolations(root());
  });
});

/**
 * With no radio preselected, the first radio is the (unchecked) Tab entry point.
 */
describe("RadioGroupController with no initial selection", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--radio-group" role="radiogroup" aria-label="Plan">
        <div role="radio" aria-checked="false" tabindex="-1" data-value="a"
             data-stimeo--radio-group-target="radio"
             data-action="keydown->stimeo--radio-group#onKeydown">A</div>
        <div role="radio" aria-checked="false" tabindex="-1" data-value="b"
             data-stimeo--radio-group-target="radio"
             data-action="keydown->stimeo--radio-group#onKeydown">B</div>
      </div>`;
    application = Application.start();
    application.register("stimeo--radio-group", RadioGroupController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  it("makes the first radio tabbable without checking it", () => {
    const radios = Array.from(
      document.querySelectorAll<HTMLElement>("[data-stimeo--radio-group-target='radio']"),
    );
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "false"]);
  });
});
