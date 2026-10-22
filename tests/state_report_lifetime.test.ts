import { Application, type ControllerConstructor } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { DataGridController } from "../src/controllers/data_grid_controller";
import { ListboxController } from "../src/controllers/listbox_controller";
import { RadioGroupController } from "../src/controllers/radio_group_controller";
import { SwitchController } from "../src/controllers/switch_controller";
import { TimePickerController } from "../src/controllers/time_picker_controller";
import { ToggleGroupController } from "../src/controllers/toggle_group_controller";
import { TreeViewController } from "../src/controllers/tree_view_controller";
import { press } from "./helpers/keyboard";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/** A native subscriber can end a connection before the pending custom report is delivered. */
type Mode = "connected" | "disconnect" | "unload" | "reconnect";

/** One controller's user move, settled DOM, and notification surface. */
interface Fixture {
  name: string;
  constructor: ControllerConstructor;
  markup: string;
  fieldSelector: string;
  event?: string;
  operate(root: HTMLElement): void;
  read(root: HTMLElement): unknown;
  expected: unknown;
}

/** Requires the element used by a fixture instead of silently skipping the user move. */
function element<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Missing fixture element: ${selector}`);
  return found;
}

const fixtures: Fixture[] = [
  {
    name: "listbox",
    constructor: ListboxController,
    markup: `<div data-controller="stimeo--listbox">
      <button type="button" role="combobox" aria-haspopup="listbox" aria-expanded="true"
        aria-controls="fruit-list" aria-label="Fruit" data-stimeo--listbox-target="trigger">
        <span data-stimeo--listbox-target="value">Choose</span></button>
      <ul role="listbox" id="fruit-list" data-stimeo--listbox-target="list">
        <li role="option" aria-selected="false" id="apple" data-value="apple"
          data-stimeo--listbox-target="option" data-action="click->stimeo--listbox#select">Apple</li>
      </ul><input type="hidden" data-stimeo--listbox-target="field"></div>`,
    fieldSelector: "input",
    operate: (root) => element(root, "[role='option']").click(),
    read: (root) => ({
      selected: element(root, "[role='option']").getAttribute("aria-selected"),
      field: element<HTMLInputElement>(root, "input").value,
    }),
    expected: { selected: "true", field: "apple" },
  },
  {
    name: "data-grid",
    constructor: DataGridController,
    markup: `<div data-controller="stimeo--data-grid" role="grid" aria-label="Rows"
      data-stimeo--data-grid-selection-value="multiple">
      <div role="row" aria-selected="false" data-value="row1" data-stimeo--data-grid-target="row"
        data-action="click->stimeo--data-grid#toggleSelect">
        <div role="gridcell" tabindex="0" data-stimeo--data-grid-target="cell">Row one</div></div>
      <div data-stimeo--data-grid-target="fields"></div></div>`,
    fieldSelector: "[data-stimeo--data-grid-target='fields']",
    event: "selectionchange",
    operate: (root) => element(root, "[role='row']").click(),
    read: (root) => ({
      selected: element(root, "[role='row']").getAttribute("aria-selected"),
      field: element<HTMLInputElement>(root, "input").value,
    }),
    expected: { selected: "true", field: "row1" },
  },
  {
    name: "tree-view",
    constructor: TreeViewController,
    markup: `<div data-controller="stimeo--tree-view" role="tree" aria-label="Files">
      <div role="treeitem" aria-selected="false" tabindex="0" data-value="readme"
        data-stimeo--tree-view-target="item" data-action="click->stimeo--tree-view#select">Readme</div>
      <input type="hidden" data-stimeo--tree-view-target="field"></div>`,
    fieldSelector: "input",
    event: "select",
    operate: (root) => element(root, "[role='treeitem']").click(),
    read: (root) => ({
      selected: element(root, "[role='treeitem']").getAttribute("aria-selected"),
      field: element<HTMLInputElement>(root, "input").value,
    }),
    expected: { selected: "true", field: "readme" },
  },
  {
    name: "radio-group",
    constructor: RadioGroupController,
    markup: `<div data-controller="stimeo--radio-group" role="radiogroup" aria-label="Plan">
      <div role="radio" aria-checked="true" tabindex="0" data-value="basic"
        data-stimeo--radio-group-target="radio">Basic</div>
      <div role="radio" aria-checked="false" tabindex="-1" data-value="pro"
        data-stimeo--radio-group-target="radio">Pro</div>
      <input type="hidden" data-stimeo--radio-group-target="field"></div>`,
    fieldSelector: "[data-stimeo--radio-group-target='field']",
    operate: (root) => element(root, "[data-value='pro']").click(),
    read: (root) => ({
      checked: element(root, "[data-value='pro']").getAttribute("aria-checked"),
      field: element<HTMLInputElement>(root, "input").value,
    }),
    expected: { checked: "true", field: "pro" },
  },
  {
    name: "switch",
    constructor: SwitchController,
    markup: `<div data-controller="stimeo--switch" role="switch" tabindex="0"
      aria-checked="false" data-action="click->stimeo--switch#toggle">Switch
      <input type="hidden" data-stimeo--switch-target="field"></div>`,
    fieldSelector: "[data-stimeo--switch-target='field']",
    operate: (root) => root.click(),
    read: (root) => ({
      checked: root.getAttribute("aria-checked"),
      field: element<HTMLInputElement>(root, "input").value,
    }),
    expected: { checked: "true", field: "true" },
  },
  {
    name: "toggle-group",
    constructor: ToggleGroupController,
    markup: `<div data-controller="stimeo--toggle-group" role="group" aria-label="Text style">
      <button type="button" aria-pressed="false" data-value="bold"
        data-stimeo--toggle-group-target="item">Bold</button>
      <div data-stimeo--toggle-group-target="fields"></div></div>`,
    fieldSelector: "[data-stimeo--toggle-group-target='fields']",
    operate: (root) => element<HTMLButtonElement>(root, "button").click(),
    read: (root) => ({
      pressed: element(root, "button").getAttribute("aria-pressed"),
      field: element<HTMLInputElement>(root, "input").value,
    }),
    expected: { pressed: "true", field: "bold" },
  },
  {
    name: "time-picker",
    constructor: TimePickerController,
    markup: `<div data-controller="stimeo--time-picker" role="group" aria-label="Time">
      <span role="spinbutton" aria-label="Hours" aria-valuenow="9" aria-valuemin="0"
        aria-valuemax="23" tabindex="0" data-segment="hour" data-stimeo--time-picker-target="segment"
        data-action="keydown->stimeo--time-picker#onKeydown">09</span>
      <span role="spinbutton" aria-label="Minutes" aria-valuenow="30" aria-valuemin="0"
        aria-valuemax="59" tabindex="0" data-segment="minute" data-stimeo--time-picker-target="segment"
        data-action="keydown->stimeo--time-picker#onKeydown">30</span>
      <input type="hidden" data-stimeo--time-picker-target="field"></div>`,
    fieldSelector: "[data-stimeo--time-picker-target='field']",
    operate: (root) => press(element(root, "[data-segment='minute']"), "ArrowUp"),
    read: (root) => ({
      minute: element(root, "[data-segment='minute']").getAttribute("aria-valuenow"),
      field: element<HTMLInputElement>(root, "input").value,
    }),
    expected: { minute: "31", field: "09:31" },
  },
];

describe("state reports across connected lifetimes", () => {
  let application: Application | undefined;

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    document.body.innerHTML = "";
  });

  for (const fixture of fixtures) {
    it.each<Mode>(["connected", "disconnect", "unload", "reconnect"])(
      `${fixture.name} ends pending custom reports when native subscribers %s`,
      async (mode) => {
        document.body.innerHTML = fixture.markup;
        const app = Application.start();
        application = app;
        const identifier = `stimeo--${fixture.name}`;
        app.register(identifier, fixture.constructor);
        await tick();
        const root = element(document, "[data-controller]");
        const field = element(root, fixture.fieldSelector);
        const controller = app.getControllerForElementAndIdentifier(root, identifier);
        if (!controller) throw new Error(`Missing controller: ${identifier}`);
        const trace: string[] = [];
        const nativeStates: unknown[] = [];
        const customStates: unknown[] = [];
        field.addEventListener("change", () => {
          trace.push("native:first");
          nativeStates.push(fixture.read(root));
          if (mode === "disconnect") controller.disconnect();
          if (mode === "unload") app.unload(identifier);
          if (mode === "reconnect") {
            controller.disconnect();
            controller.connect();
          }
          trace.push(mode === "connected" ? "retained" : "ended");
        });
        field.addEventListener("change", () => trace.push("native:remaining"));
        root.addEventListener(`${identifier}:${fixture.event ?? "change"}`, () => {
          trace.push("custom");
          customStates.push(fixture.read(root));
        });

        fixture.operate(root);
        await tick();

        expect(nativeStates).toEqual([fixture.expected]);
        expect(fixture.read(root)).toEqual(fixture.expected);
        expect(trace).toEqual([
          "native:first",
          mode === "connected" ? "retained" : "ended",
          "native:remaining",
          ...(mode === "connected" ? ["custom"] : []),
        ]);
        expect(customStates).toEqual(mode === "connected" ? [fixture.expected] : []);
        if (mode === "unload") expect(app.controllers).toHaveLength(0);
      },
    );
  }
});
