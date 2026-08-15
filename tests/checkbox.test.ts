import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckboxController } from "../src/controllers/checkbox_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link CheckboxController}: the tri-state parent/child
 * "select all" contract — `indeterminate` derivation, the parent→children
 * cascade, the `data-state` aggregate, and the `change` event.
 */

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
    disconnectAndStopApplication(application);
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

  it("reports an aggregate derived from a runtime child as reconcile, not change", async () => {
    const changes: unknown[] = [];
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--checkbox:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    root().addEventListener("stimeo--checkbox:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });

    // The page adds an already-checked child; nobody clicked anything.
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" checked
      data-stimeo--checkbox-target="child"
      data-action="change->stimeo--checkbox#onChildChange" /> C`;
    root().appendChild(label);
    await tick();

    expect(root().getAttribute("data-state")).toBe("partial");
    expect(repairs).toEqual([{ checked: false, indeterminate: true, state: "partial" }]);
    expect(changes).toEqual([]);
  });

  it("stays quiet when a reconciliation leaves the aggregate where it was", async () => {
    const changes: unknown[] = [];
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--checkbox:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    root().addEventListener("stimeo--checkbox:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });

    // An unchecked child joins an all-unchecked group: the pass runs, but the
    // aggregate it settles on is the one already reported.
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox"
      data-stimeo--checkbox-target="child"
      data-action="change->stimeo--checkbox#onChildChange" /> C`;
    root().appendChild(label);
    await tick();

    expect(root().getAttribute("data-state")).toBe("none");
    expect(repairs).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("keeps change for a user toggle and never pairs it with reconcile", async () => {
    const changes: unknown[] = [];
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--checkbox:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    root().addEventListener("stimeo--checkbox:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });

    changeChild(0, true);
    await tick();

    expect(changes).toEqual([{ checked: false, indeterminate: true, state: "partial" }]);
    expect(repairs).toEqual([]);
  });

  it("starts in the 'none' aggregate state", () => {
    expect(root().getAttribute("data-state")).toBe("none");
    expect(parent().indeterminate).toBe(false);
    expect(parent().checked).toBe(false);
  });

  it("cascades a parent check to every child", () => {
    let childChanges = 0;
    for (const child of children()) {
      child.addEventListener("change", () => {
        childChanges += 1;
      });
    }

    changeParent(true);
    expect(children().every((child) => child.checked)).toBe(true);
    expect(childChanges).toBe(0);
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
    application.unload("stimeo--checkbox");
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
    // reordering surfaces as a diff; native tri-state announcement can only be
    // confirmed with a real screen reader.
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
    disconnectAndStopApplication(application);
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

  it("keeps a checked lone checkbox checked while indeterminate is set externally", async () => {
    document.body.innerHTML = `
      <span data-controller="stimeo--checkbox">
        <label><input type="checkbox" checked data-stimeo--checkbox-target="parent" /> Subscribe</label>
      </span>`;
    const lone = document.querySelector<HTMLInputElement>(
      "[data-stimeo--checkbox-target='parent']",
    ) as HTMLInputElement;
    lone.indeterminate = true;
    await start();

    expect(lone.checked).toBe(true);
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

  it("reflects an unchecked lone parent as the 'none' state", async () => {
    document.body.innerHTML = `
      <span data-controller="stimeo--checkbox">
        <label><input type="checkbox" data-stimeo--checkbox-target="parent" /> Subscribe</label>
      </span>`;
    await start();

    const root = document.querySelector<HTMLElement>("[data-controller]") as HTMLElement;
    const parent = root.querySelector<HTMLInputElement>(
      "[data-stimeo--checkbox-target='parent']",
    ) as HTMLInputElement;
    expect(parent.checked).toBe(false);
    expect(parent.indeterminate).toBe(false);
    expect(root.getAttribute("data-state")).toBe("none");
  });

  it("reflects an empty controller root as the 'none' state", async () => {
    document.body.innerHTML = '<div data-controller="stimeo--checkbox"></div>';
    await start();

    expect(
      document.querySelector<HTMLElement>("[data-controller]")?.getAttribute("data-state"),
    ).toBe("none");
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

  it("includes disabled child targets in aggregation and parent cascades", async () => {
    document.body.innerHTML = `
      <fieldset data-controller="stimeo--checkbox">
        <input type="checkbox" data-stimeo--checkbox-target="parent"
               data-action="change->stimeo--checkbox#onParentChange">
        <input type="checkbox" disabled data-stimeo--checkbox-target="child"
               data-action="change->stimeo--checkbox#onChildChange">
        <input type="checkbox" data-stimeo--checkbox-target="child"
               data-action="change->stimeo--checkbox#onChildChange">
      </fieldset>`;
    await start();
    const root = document.querySelector<HTMLElement>("[data-controller]") as HTMLElement;
    const parent = root.querySelector<HTMLInputElement>(
      "[data-stimeo--checkbox-target='parent']",
    ) as HTMLInputElement;
    const children = Array.from(
      root.querySelectorAll<HTMLInputElement>("[data-stimeo--checkbox-target='child']"),
    );

    parent.checked = true;
    parent.dispatchEvent(new Event("change", { bubbles: true }));
    expect(children.map((child) => child.checked)).toEqual([true, true]);
    expect(root.getAttribute("data-state")).toBe("all");

    const disabled = children[0] as HTMLInputElement;
    disabled.checked = false;
    disabled.dispatchEvent(new Event("change", { bubbles: true }));
    expect(parent.indeterminate).toBe(true);
    expect(root.getAttribute("data-state")).toBe("partial");
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
    expect(details).toEqual([{ checked: false, indeterminate: true, state: "partial" }]);
  });

  it("leaves a child-only group untouched when the parent action is invoked", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--checkbox" data-state="authored">
        <label><input type="checkbox" data-stimeo--checkbox-target="child" /> A</label>
      </div>`;
    await start();
    const root = document.querySelector<HTMLElement>("[data-controller]") as HTMLElement;
    const child = root.querySelector<HTMLInputElement>(
      "[data-stimeo--checkbox-target='child']",
    ) as HTMLInputElement;
    const controller = application.getControllerForElementAndIdentifier(
      root,
      "stimeo--checkbox",
    ) as CheckboxController;
    const details: unknown[] = [];
    root.addEventListener("stimeo--checkbox:change", (event) => {
      details.push((event as CustomEvent).detail);
    });
    root.setAttribute("data-state", "sentinel");

    expect(() => controller.onParentChange()).not.toThrow();
    expect(child.checked).toBe(false);
    expect(root.getAttribute("data-state")).toBe("sentinel");
    expect(details).toEqual([]);
  });
});

describe("CheckboxController runtime reconciliation", () => {
  let application: Application;

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const start = async (markup: string) => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--checkbox", CheckboxController);
    await tick();
  };
  const root = () => document.querySelector<HTMLElement>("[data-controller]") as HTMLElement;
  const parent = () =>
    root().querySelector<HTMLInputElement>(
      "[data-stimeo--checkbox-target='parent']",
    ) as HTMLInputElement;
  const children = () =>
    Array.from(root().querySelectorAll<HTMLInputElement>("[data-stimeo--checkbox-target='child']"));
  const child = (index: number) => children()[index] as HTMLInputElement;
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--checkbox",
    ) as CheckboxController;

  const group = (childrenMarkup: string, parentMarkup = "") => `
    <fieldset data-controller="stimeo--checkbox">
      ${parentMarkup}
      ${childrenMarkup}
    </fieldset>`;
  const parentMarkup = (attributes = "") => `
    <input type="checkbox" ${attributes} data-stimeo--checkbox-target="parent"
           data-action="change->stimeo--checkbox#onParentChange">`;
  const childMarkup = (attributes = "") => `
    <input type="checkbox" ${attributes} data-stimeo--checkbox-target="child"
           data-action="change->stimeo--checkbox#onChildChange">`;

  it("reconciles children added and removed at runtime without dispatching change", async () => {
    await start(group(childMarkup(), parentMarkup()));
    const details: unknown[] = [];
    root().addEventListener("stimeo--checkbox:change", (event) => {
      details.push((event as CustomEvent).detail);
    });

    root().insertAdjacentHTML("beforeend", childMarkup("checked"));
    await tick();
    expect(root().getAttribute("data-state")).toBe("partial");
    expect(parent().checked).toBe(false);
    expect(parent().indeterminate).toBe(true);

    children()[1]?.remove();
    await tick();
    expect(root().getAttribute("data-state")).toBe("none");
    expect(parent().indeterminate).toBe(false);
    expect(details).toEqual([]);
  });

  it("initializes a parent target added after the child-only group connected", async () => {
    await start(group(`${childMarkup("checked")}${childMarkup()}`));
    expect(root().getAttribute("data-state")).toBe("partial");

    root().insertAdjacentHTML("afterbegin", parentMarkup("checked"));
    await tick();
    expect(parent().checked).toBe(false);
    expect(parent().indeterminate).toBe(true);
    expect(root().getAttribute("data-state")).toBe("partial");
  });

  it("reconciles a parent replacement against the surviving children", async () => {
    await start(group(`${childMarkup("checked")}${childMarkup()}`, parentMarkup()));
    const previous = parent();
    previous.insertAdjacentHTML("afterend", parentMarkup("checked"));
    previous.remove();
    await tick();

    expect(parent()).not.toBe(previous);
    expect(parent().checked).toBe(false);
    expect(parent().indeterminate).toBe(true);
  });

  it("coalesces repeated target callbacks into one reflection pass", async () => {
    await start(group(childMarkup(), parentMarkup()));
    const setAttribute = vi.spyOn(root(), "setAttribute");
    child(0).checked = true;

    controller().childTargetConnected();
    controller().childTargetConnected();
    controller().parentTargetConnected();
    await flushMicrotasks();

    expect(setAttribute.mock.calls.filter(([name]) => name === "data-state")).toHaveLength(1);
    expect(root().getAttribute("data-state")).toBe("all");
  });

  it("leaves a lone tri-state parent alone when a reconciliation runs", async () => {
    await start(`
      <span data-controller="stimeo--checkbox">
        <input type="checkbox" checked data-stimeo--checkbox-target="parent">
      </span>`);
    parent().indeterminate = true;

    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await flushMicrotasks();

    expect(parent().checked).toBe(true);
    expect(parent().indeterminate).toBe(true);
    expect(root().getAttribute("data-state")).toBe("partial");
  });

  it("reports a checked content-attribute change as reconcile, not change", async () => {
    await start(group(`${childMarkup()}${childMarkup()}`, parentMarkup()));
    const changes: unknown[] = [];
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--checkbox:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    root().addEventListener("stimeo--checkbox:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });

    children()[0]?.setAttribute("checked", "");
    await tick();
    expect(root().getAttribute("data-state")).toBe("partial");
    expect(parent().indeterminate).toBe(true);
    expect(repairs).toEqual([{ checked: false, indeterminate: true, state: "partial" }]);
    expect(changes).toEqual([]);
  });

  it("reports an aggregate moved by a removed child as reconcile, not change", async () => {
    await start(group(`${childMarkup("checked")}${childMarkup()}`, parentMarkup()));
    const changes: unknown[] = [];
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--checkbox:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    root().addEventListener("stimeo--checkbox:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });
    expect(root().getAttribute("data-state")).toBe("partial");

    // Dropping the unchecked child leaves an all-checked group behind.
    children()[1]?.remove();
    await tick();

    expect(root().getAttribute("data-state")).toBe("all");
    expect(repairs).toEqual([{ checked: true, indeterminate: false, state: "all" }]);
    expect(changes).toEqual([]);
  });

  it("reconciles property-only Turbo morph state and restores data-state", async () => {
    await start(group(`${childMarkup()}${childMarkup()}`, parentMarkup()));
    const changes: unknown[] = [];
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--checkbox:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    root().addEventListener("stimeo--checkbox:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });
    child(0).checked = true;
    root().removeAttribute("data-state");

    children()[0]?.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await flushMicrotasks();

    expect(root().getAttribute("data-state")).toBe("partial");
    expect(parent().checked).toBe(false);
    expect(parent().indeterminate).toBe(true);
    expect(repairs).toEqual([{ checked: false, indeterminate: true, state: "partial" }]);
    expect(changes).toEqual([]);
  });

  it("ignores checked changes on checkboxes outside its target set", async () => {
    await start(group(`${childMarkup()}<input type="checkbox" id="unmanaged">`, parentMarkup()));
    const setAttribute = vi.spyOn(root(), "setAttribute");

    root().querySelector<HTMLInputElement>("#unmanaged")?.setAttribute("checked", "");
    await tick();

    expect(setAttribute.mock.calls.filter(([name]) => name === "data-state")).toEqual([]);
    expect(root().getAttribute("data-state")).toBe("none");
  });

  it("cancels queued work and releases morph and attribute observers on disconnect", async () => {
    await start(group(`${childMarkup()}${childMarkup()}`, parentMarkup()));
    child(0).checked = true;
    controller().childTargetConnected();
    controller().disconnect();
    root().setAttribute("data-state", "sentinel");
    children()[1]?.setAttribute("checked", "");
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();

    expect(root().getAttribute("data-state")).toBe("sentinel");
    expect(parent().checked).toBe(false);
    expect(parent().indeterminate).toBe(false);
  });
});

describe("CheckboxController form reset reconciliation", () => {
  let application: Application;

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const start = async (external = false) => {
    document.body.innerHTML = external
      ? `
        <form id="checkbox-form"></form>
        <fieldset data-controller="stimeo--checkbox">
          <input type="checkbox" form="checkbox-form" data-stimeo--checkbox-target="parent"
                 data-action="change->stimeo--checkbox#onParentChange">
          <input type="checkbox" form="checkbox-form" checked data-stimeo--checkbox-target="child"
                 data-action="change->stimeo--checkbox#onChildChange">
          <input type="checkbox" form="checkbox-form" data-stimeo--checkbox-target="child"
                 data-action="change->stimeo--checkbox#onChildChange">
        </fieldset>`
      : `
        <form id="checkbox-form">
          <fieldset data-controller="stimeo--checkbox">
            <input type="checkbox" data-stimeo--checkbox-target="parent"
                   data-action="change->stimeo--checkbox#onParentChange">
            <input type="checkbox" checked data-stimeo--checkbox-target="child"
                   data-action="change->stimeo--checkbox#onChildChange">
            <input type="checkbox" data-stimeo--checkbox-target="child"
                   data-action="change->stimeo--checkbox#onChildChange">
          </fieldset>
        </form>`;
    application = Application.start();
    application.register("stimeo--checkbox", CheckboxController);
    await tick();
  };
  const form = () => document.querySelector<HTMLFormElement>("#checkbox-form") as HTMLFormElement;
  const root = () => document.querySelector<HTMLElement>("[data-controller]") as HTMLElement;
  const parent = () =>
    root().querySelector<HTMLInputElement>(
      "[data-stimeo--checkbox-target='parent']",
    ) as HTMLInputElement;
  const children = () =>
    Array.from(root().querySelectorAll<HTMLInputElement>("[data-stimeo--checkbox-target='child']"));
  const child = (index: number) => children()[index] as HTMLInputElement;

  const selectAll = () => {
    parent().checked = true;
    parent().dispatchEvent(new Event("change", { bubbles: true }));
  };

  it("reports the aggregate a native form reset restores as reconcile", async () => {
    await start();
    const changes: unknown[] = [];
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--checkbox:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    root().addEventListener("stimeo--checkbox:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });
    selectAll();
    expect(root().getAttribute("data-state")).toBe("all");

    form().reset();
    await tick();

    expect(children().map((child) => child.checked)).toEqual([true, false]);
    expect(parent().checked).toBe(false);
    expect(parent().indeterminate).toBe(true);
    expect(root().getAttribute("data-state")).toBe("partial");
    // The user's "select all" is the only edit; the reset is the browser's.
    expect(changes).toEqual([{ checked: true, indeterminate: false, state: "all" }]);
    expect(repairs).toEqual([{ checked: false, indeterminate: true, state: "partial" }]);
  });

  it("finds targets associated to an external form", async () => {
    await start(true);
    selectAll();
    form().reset();
    await tick();

    expect(children().map((child) => child.checked)).toEqual([true, false]);
    expect(parent().indeterminate).toBe(true);
    expect(root().getAttribute("data-state")).toBe("partial");
  });

  it("does not reconcile when reset is cancelled", async () => {
    await start();
    selectAll();
    child(0).checked = false;
    form().addEventListener("reset", (event) => event.preventDefault());

    form().reset();
    await tick();

    // happy-dom resets the controls even when the reset event is cancelled. The
    // durable assertion here is the controller contract: it must not reconcile
    // that simulated reset. Chromium covers the browser's cancelled default too.
    expect(root().getAttribute("data-state")).toBe("all");
  });

  it("ignores reset events from forms that do not own its targets", async () => {
    await start();
    child(1).checked = true;
    document.body.insertAdjacentHTML(
      "beforeend",
      '<form id="unrelated-form"><input type="checkbox" checked></form>',
    );

    const unrelated = document.querySelector<HTMLFormElement>("#unrelated-form") as HTMLFormElement;
    unrelated.reset();
    await tick();

    expect(children().map((child) => child.checked)).toEqual([true, true]);
    expect(root().getAttribute("data-state")).toBe("partial");
    expect(parent().indeterminate).toBe(true);
  });

  it("removes the document reset listener on disconnect", async () => {
    await start();
    selectAll();
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--checkbox",
    ) as CheckboxController;
    controller.disconnect();
    root().setAttribute("data-state", "sentinel");

    form().reset();
    await tick();

    expect(children().map((child) => child.checked)).toEqual([true, false]);
    expect(root().getAttribute("data-state")).toBe("sentinel");
    expect(parent().indeterminate).toBe(false);
  });
});
