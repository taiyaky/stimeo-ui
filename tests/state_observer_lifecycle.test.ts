import { Application, type ControllerConstructor } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConditionalFieldsController } from "../src/controllers/conditional_fields_controller";
import { DataGridController } from "../src/controllers/data_grid_controller";
import { ListboxController } from "../src/controllers/listbox_controller";
import { RadioGroupController } from "../src/controllers/radio_group_controller";
import { SwitchController } from "../src/controllers/switch_controller";
import { TimePickerController } from "../src/controllers/time_picker_controller";
import { ToggleGroupController } from "../src/controllers/toggle_group_controller";
import { TreeViewController } from "../src/controllers/tree_view_controller";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/** Minimal connected hosts with one attribute retained by their state observer. */
const fixtures: ReadonlyArray<{
  id: string;
  controller: ControllerConstructor;
  attribute: string;
  children: string;
}> = [
  {
    id: "conditional-fields",
    controller: ConditionalFieldsController,
    attribute: "hidden",
    children: "",
  },
  { id: "data-grid", controller: DataGridController, attribute: "data-value", children: "" },
  {
    id: "listbox",
    controller: ListboxController,
    attribute: "data-value",
    children: `<button type="button" data-stimeo--listbox-target="trigger"></button>
      <div data-stimeo--listbox-target="list"></div>`,
  },
  { id: "radio-group", controller: RadioGroupController, attribute: "data-value", children: "" },
  { id: "switch", controller: SwitchController, attribute: "role", children: "" },
  { id: "time-picker", controller: TimePickerController, attribute: "aria-valuenow", children: "" },
  { id: "toggle-group", controller: ToggleGroupController, attribute: "data-value", children: "" },
  { id: "tree-view", controller: TreeViewController, attribute: "data-value", children: "" },
];

describe("state observer lifecycle", () => {
  let application: Application | undefined;

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it.each(fixtures)(
    "releases $id's native observation on disconnect",
    async ({ id, controller, attribute, children }) => {
      const observe = vi.spyOn(MutationObserver.prototype, "observe");
      const identifier = `stimeo--${id}`;
      document.body.innerHTML = `<div data-controller="${identifier}">${children}</div>`;
      const root = document.body.firstElementChild as HTMLElement;
      application = Application.start();
      application.register(identifier, controller);
      await tick();
      const index = observe.mock.calls.findIndex(
        ([target, options]) => target === root && options?.attributeFilter?.includes(attribute),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      const observer = observe.mock.contexts[index];
      if (!(observer instanceof MutationObserver))
        throw new Error("Expected native state observer");
      root.setAttribute(attribute, "connected");
      expect(observer.takeRecords()).toHaveLength(1);
      const instance = application.getControllerForElementAndIdentifier(root, identifier);
      if (!instance) throw new Error("Expected connected controller");
      instance.disconnect();
      root.setAttribute(attribute, "disconnected");
      expect(observer.takeRecords()).toEqual([]);
    },
  );
});
