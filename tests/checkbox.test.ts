import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckboxController } from "../src/controllers/checkbox_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link CheckboxController}: the tri-state parent/child
 * "select all" contract — `indeterminate` derivation, the parent→children
 * cascade, the `data-state` aggregate, and the `change` event.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CheckboxController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <fieldset data-controller="stimeo--checkbox" role="group" aria-labelledby="all-label">
        <label id="all-label">
          <input type="checkbox" data-stimeo--checkbox-target="parent"
                 data-action="change->stimeo--checkbox#onParentChange" /> Select all
        </label>
        <label><input type="checkbox" data-stimeo--checkbox-target="child"
                 data-action="change->stimeo--checkbox#onChildChange" /> A</label>
        <label><input type="checkbox" data-stimeo--checkbox-target="child"
                 data-action="change->stimeo--checkbox#onChildChange" /> B</label>
      </fieldset>`;
    application = Application.start();
    application.register("stimeo--checkbox", CheckboxController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--checkbox']") as HTMLElement;
  const parent = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--checkbox-target='parent']",
    ) as HTMLInputElement;
  const children = () =>
    Array.from(
      document.querySelectorAll<HTMLInputElement>("[data-stimeo--checkbox-target='child']"),
    );
  const changeChild = (index: number, checked: boolean) => {
    const child = children()[index] as HTMLInputElement;
    child.checked = checked;
    child.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const changeParent = (checked: boolean) => {
    parent().checked = checked;
    parent().dispatchEvent(new Event("change", { bubbles: true }));
  };

  it("starts in the 'none' aggregate state", () => {
    expect(root().getAttribute("data-state")).toBe("none");
    expect(parent().indeterminate).toBe(false);
    expect(parent().checked).toBe(false);
  });

  it("cascades a parent check to every child", () => {
    changeParent(true);
    expect(children().every((child) => child.checked)).toBe(true);
    expect(parent().indeterminate).toBe(false);
    expect(root().getAttribute("data-state")).toBe("all");
  });

  it("derives the indeterminate (partial) state from a single child", () => {
    changeChild(0, true);
    expect(parent().indeterminate).toBe(true);
    expect(parent().checked).toBe(false);
    expect(root().getAttribute("data-state")).toBe("partial");
  });

  it("derives the checked (all) state when every child is checked", () => {
    changeChild(0, true);
    changeChild(1, true);
    expect(parent().indeterminate).toBe(false);
    expect(parent().checked).toBe(true);
    expect(root().getAttribute("data-state")).toBe("all");
  });

  it("dispatches change with the aggregate detail", () => {
    const details: Array<{ checked: boolean; indeterminate: boolean; state: string }> = [];
    root().addEventListener("stimeo--checkbox:change", (event) => {
      details.push((event as CustomEvent).detail);
    });

    changeChild(0, true);
    changeParent(true);

    expect(details).toEqual([
      { checked: false, indeterminate: true, state: "partial" },
      { checked: true, indeterminate: false, state: "all" },
    ]);
  });

  it("stops reacting after disconnect", () => {
    application.stop();
    changeChild(0, true);
    expect(parent().indeterminate).toBe(false);
    expect(root().getAttribute("data-state")).toBe("none");
  });

  it("announces the group, each checkbox role, and accessible names in order", async () => {
    // The virtual screen reader derives checked/mixed state from attributes, but a
    // native checkbox exposes its checked/indeterminate state through IDL
    // properties — which real screen readers map to the accessibility tree, yet
    // happy-dom's simulation does not. Forcing `aria-checked` onto a native
    // checkbox to satisfy the simulation would violate the APG, so this pins the
    // durable semantics the simulation *can* observe: the group role+name and
    // every checkbox role+name, in reading order. A lost role, dropped name, or
    // reordering surfaces as a diff; native tri-state announcement is covered by
    // the real-SR layers.
    const speech = await captureSpeech({ container: root(), steps: 7 });
    expect(speech).toEqual([
      "group, Select all",
      "checkbox, Select all, not checked",
      "Select all",
      "checkbox, A, not checked",
      "A",
      "checkbox, B, not checked",
      "B",
      "end of group, Select all",
    ]);
  });

  it("has no machine-detectable a11y violations", async () => {
    await expectNoA11yViolations(root());
  });
});

/**
 * Reflecting server-rendered child states on connect, and the lone tri-state
 * checkbox whose `indeterminate` is set externally.
 */
describe("CheckboxController initial reflection", () => {
  let application: Application;

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const start = async () => {
    application = Application.start();
    application.register("stimeo--checkbox", CheckboxController);
    await tick();
  };

  it("reflects a partial state rendered by the server", async () => {
    document.body.innerHTML = `
      <fieldset data-controller="stimeo--checkbox" role="group" aria-label="Items">
        <label><input type="checkbox" checked data-stimeo--checkbox-target="parent"
                 data-action="change->stimeo--checkbox#onParentChange" /> All</label>
        <label><input type="checkbox" checked data-stimeo--checkbox-target="child"
                 data-action="change->stimeo--checkbox#onChildChange" /> A</label>
        <label><input type="checkbox" data-stimeo--checkbox-target="child"
                 data-action="change->stimeo--checkbox#onChildChange" /> B</label>
      </fieldset>`;
    await start();

    const parent = document.querySelector<HTMLInputElement>(
      "[data-stimeo--checkbox-target='parent']",
    ) as HTMLInputElement;
    expect(parent.indeterminate).toBe(true);
    expect(parent.checked).toBe(false);
    expect(
      document.querySelector<HTMLElement>("[data-controller]")?.getAttribute("data-state"),
    ).toBe("partial");
  });

  it("does not clobber an externally set indeterminate on a lone checkbox", async () => {
    document.body.innerHTML = `
      <span data-controller="stimeo--checkbox">
        <label><input type="checkbox" data-stimeo--checkbox-target="parent" /> Subscribe</label>
      </span>`;
    const lone = document.querySelector<HTMLInputElement>(
      "[data-stimeo--checkbox-target='parent']",
    ) as HTMLInputElement;
    lone.indeterminate = true;
    await start();

    expect(lone.indeterminate).toBe(true);
    expect(
      document.querySelector<HTMLElement>("[data-controller]")?.getAttribute("data-state"),
    ).toBe("partial");
  });

  it("reflects a fully-checked lone parent as the 'all' state", async () => {
    document.body.innerHTML = `
      <span data-controller="stimeo--checkbox">
        <label><input type="checkbox" checked data-stimeo--checkbox-target="parent" /> Subscribe</label>
      </span>`;
    await start();
    expect(
      document.querySelector<HTMLElement>("[data-controller]")?.getAttribute("data-state"),
    ).toBe("all");
  });

  it("clears every child and the state when the parent is unchecked", async () => {
    document.body.innerHTML = `
      <fieldset data-controller="stimeo--checkbox">
        <label><input type="checkbox" checked data-stimeo--checkbox-target="parent"
                 data-action="change->stimeo--checkbox#onParentChange" /> All</label>
        <label><input type="checkbox" checked data-stimeo--checkbox-target="child"
                 data-action="change->stimeo--checkbox#onChildChange" /> A</label>
        <label><input type="checkbox" checked data-stimeo--checkbox-target="child"
                 data-action="change->stimeo--checkbox#onChildChange" /> B</label>
      </fieldset>`;
    await start();
    const parent = document.querySelector<HTMLInputElement>(
      "[data-stimeo--checkbox-target='parent']",
    ) as HTMLInputElement;
    parent.checked = false;
    parent.dispatchEvent(new Event("change", { bubbles: true }));

    const children = Array.from(
      document.querySelectorAll<HTMLInputElement>("[data-stimeo--checkbox-target='child']"),
    );
    expect(children.every((child) => !child.checked)).toBe(true);
    expect(
      document.querySelector<HTMLElement>("[data-controller]")?.getAttribute("data-state"),
    ).toBe("none");
  });

  it("aggregates children with no parent target and dispatches the change", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--checkbox">
        <label><input type="checkbox" data-stimeo--checkbox-target="child"
                 data-action="change->stimeo--checkbox#onChildChange" /> A</label>
        <label><input type="checkbox" data-stimeo--checkbox-target="child"
                 data-action="change->stimeo--checkbox#onChildChange" /> B</label>
      </div>`;
    await start();
    const root = document.querySelector<HTMLElement>("[data-controller]") as HTMLElement;
    const details: Array<{ checked: boolean; indeterminate: boolean; state: string }> = [];
    root.addEventListener("stimeo--checkbox:change", (event) =>
      details.push((event as CustomEvent).detail),
    );

    const first = root.querySelector<HTMLInputElement>(
      "[data-stimeo--checkbox-target='child']",
    ) as HTMLInputElement;
    first.checked = true;
    first.dispatchEvent(new Event("change", { bubbles: true }));

    expect(root.getAttribute("data-state")).toBe("partial");
    expect(details).toEqual([{ checked: false, indeterminate: false, state: "partial" }]);
  });
});
