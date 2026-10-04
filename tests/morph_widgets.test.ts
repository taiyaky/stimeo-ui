import { Application, type ControllerConstructor } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkSelectController } from "../src/controllers/bulk_select_controller";
import { CalendarController } from "../src/controllers/calendar_controller";
import { CharacterCounterController } from "../src/controllers/character_counter_controller";
import { ColorPickerController } from "../src/controllers/color_picker_controller";
import { CurrencyInputController } from "../src/controllers/currency_input_controller";
import { DataGridController } from "../src/controllers/data_grid_controller";
import { DateRangePickerController } from "../src/controllers/date_range_picker_controller";
import { InputMaskController } from "../src/controllers/input_mask_controller";
import { ListboxController } from "../src/controllers/listbox_controller";
import { MenubarController } from "../src/controllers/menubar_controller";
import { MultiSelectController } from "../src/controllers/multi_select_controller";
import { NumberInputController } from "../src/controllers/number_input_controller";
import { PaginationController } from "../src/controllers/pagination_controller";
import { PasswordStrengthController } from "../src/controllers/password_strength_controller";
import { RadioGroupController } from "../src/controllers/radio_group_controller";
import { RangeSliderController } from "../src/controllers/range_slider_controller";
import { RatingController } from "../src/controllers/rating_controller";
import { RovingController } from "../src/controllers/roving_controller";
import { SliderController } from "../src/controllers/slider_controller";
import { StepIndicatorController } from "../src/controllers/step_indicator_controller";
import { StepperController } from "../src/controllers/stepper_controller";
import { TagsInputController } from "../src/controllers/tags_input_controller";
import { ThemeController } from "../src/controllers/theme_controller";
import { TimePickerController } from "../src/controllers/time_picker_controller";
import { ToggleGroupController } from "../src/controllers/toggle_group_controller";
import { ToolbarController } from "../src/controllers/toolbar_controller";
import { TreeViewController } from "../src/controllers/tree_view_controller";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

interface Fixture {
  id: string;
  controller: ControllerConstructor;
  markup: string;
  selector: string;
  attribute?: string;
  property?: "value" | "textContent";
  expected: string;
}

/** Builds retained targets without declaring any derived output. */
const target = (id: string, name: string, content = "", tag = "span", attrs = "") =>
  `<${tag} ${tag === "button" ? 'type="button"' : ""} data-stimeo--${id}-target="${name}" ${attrs}>${content}</${tag}>`;
const field = (id: string, name = "field", attrs = "") =>
  `<input type="hidden" data-stimeo--${id}-target="${name}" ${attrs}>`;
const root = (id: string, content: string, attrs = "") =>
  `<div data-controller="stimeo--${id}" ${attrs}>${content}</div>`;
const selector = (id: string, name: string) => `[data-stimeo--${id}-target="${name}"]`;
const cells = (id: string, name: string) =>
  Array.from({ length: 42 }, () => target(id, name, "", "button", 'tabindex="-1"')).join("");

const fixtures: Fixture[] = [
  {
    id: "calendar",
    controller: CalendarController,
    markup: root(
      "calendar",
      cells("calendar", "day"),
      `data-stimeo--calendar-month-value="2026-05"`,
    ),
    selector: selector("calendar", "day"),
    expected: "2026-04-26",
    attribute: "data-date",
  },
  {
    id: "date-range-picker",
    controller: DateRangePickerController,
    markup: root(
      "date-range-picker",
      cells("date-range-picker", "cell") +
        field("date-range-picker", "startField", 'value="2026-05-01"'),
    ),
    selector: selector("date-range-picker", "cell"),
    expected: "2026-04-26",
    attribute: "data-date",
  },
  {
    id: "theme",
    controller: ThemeController,
    markup: root(
      "theme",
      target("theme", "option", "Light", "button", 'data-value="light"'),
      `data-stimeo--theme-mode-value="light"`,
    ),
    selector: selector("theme", "option"),
    expected: "true",
    attribute: "aria-checked",
  },
  {
    id: "radio-group",
    controller: RadioGroupController,
    markup: root(
      "radio-group",
      target(
        "radio-group",
        "radio",
        "Basic",
        "span",
        'role="radio" aria-checked="true" data-value="basic"',
      ) + field("radio-group"),
    ),
    selector: selector("radio-group", "field"),
    expected: "basic",
    property: "value",
  },
  {
    id: "toggle-group",
    controller: ToggleGroupController,
    markup: root(
      "toggle-group",
      target("toggle-group", "item", "Bold", "button", 'aria-pressed="true" data-value="bold"'),
    ),
    selector: selector("toggle-group", "item"),
    expected: "0",
    attribute: "tabindex",
  },
  {
    id: "roving",
    controller: RovingController,
    markup: root("roving", target("roving", "item", "One", "span", 'tabindex="-1"')),
    selector: selector("roving", "item"),
    expected: "0",
    attribute: "tabindex",
  },
  {
    id: "toolbar",
    controller: ToolbarController,
    markup: root("toolbar", target("toolbar", "control", "One", "span", 'tabindex="-1"')),
    selector: selector("toolbar", "control"),
    expected: "0",
    attribute: "tabindex",
  },
  {
    id: "menubar",
    controller: MenubarController,
    markup: root("menubar", target("menubar", "top", "One", "span", 'tabindex="-1"')),
    selector: selector("menubar", "top"),
    expected: "0",
    attribute: "tabindex",
  },
  {
    id: "tree-view",
    controller: TreeViewController,
    markup: root("tree-view", target("tree-view", "item", "One", "span", 'tabindex="-1"')),
    selector: selector("tree-view", "item"),
    expected: "0",
    attribute: "tabindex",
  },
  {
    id: "rating",
    controller: RatingController,
    markup: root(
      "rating",
      target("rating", "symbol", "One", "span", 'role="radio"'),
      `data-stimeo--rating-value-value="1"`,
    ),
    selector: selector("rating", "symbol"),
    expected: "true",
    attribute: "aria-checked",
  },
  {
    id: "listbox",
    controller: ListboxController,
    markup: root(
      "listbox",
      target(
        "listbox",
        "trigger",
        target("listbox", "value", "Choose"),
        "button",
        'aria-expanded="false"',
      ) +
        target(
          "listbox",
          "list",
          target("listbox", "option", "Apple", "span", 'aria-selected="true" data-value="apple"'),
          "div",
          "hidden",
        ) +
        field("listbox"),
    ),
    selector: selector("listbox", "field"),
    expected: "apple",
    property: "value",
  },
  {
    id: "multi-select",
    controller: MultiSelectController,
    markup: root(
      "multi-select",
      target("multi-select", "input", "", "input") +
        target(
          "multi-select",
          "list",
          target(
            "multi-select",
            "option",
            "Apple",
            "span",
            'aria-selected="true" data-value="apple"',
          ),
          "div",
          "hidden",
        ) +
        target("multi-select", "fields"),
    ),
    selector: `[data-stimeo--multi-select-target="fields"] input`,
    expected: "apple",
    property: "value",
  },
  {
    id: "tags-input",
    controller: TagsInputController,
    markup: root(
      "tags-input",
      target("tags-input", "input", "", "input") +
        target(
          "tags-input",
          "tags",
          target("tags-input", "tag", "Apple", "span", 'data-value="apple"'),
        ) +
        target("tags-input", "fields"),
    ),
    selector: `[data-stimeo--tags-input-target="fields"] input`,
    expected: "apple",
    property: "value",
  },
  {
    id: "data-grid",
    controller: DataGridController,
    markup: root(
      "data-grid",
      target("data-grid", "row", "A", "div"),
      `data-stimeo--data-grid-selection-value="multiple"`,
    ),
    selector: `[data-controller="stimeo--data-grid"]`,
    expected: "true",
    attribute: "aria-multiselectable",
  },
  {
    id: "slider",
    controller: SliderController,
    markup: root("slider", target("slider", "thumb")),
    selector: selector("slider", "thumb"),
    expected: "0",
    attribute: "aria-valuenow",
  },
  {
    id: "range-slider",
    controller: RangeSliderController,
    markup: root(
      "range-slider",
      target("range-slider", "startThumb") + target("range-slider", "endThumb"),
    ),
    selector: selector("range-slider", "startThumb"),
    expected: "0",
    attribute: "aria-valuenow",
  },
  {
    id: "color-picker",
    controller: ColorPickerController,
    markup: root(
      "color-picker",
      field("color-picker"),
      `data-stimeo--color-picker-value-value="#000000"`,
    ),
    selector: selector("color-picker", "field"),
    expected: "#000000",
    property: "value",
  },
  {
    id: "time-picker",
    controller: TimePickerController,
    markup: root(
      "time-picker",
      target("time-picker", "segment", "", "span", 'data-segment="hour" aria-valuenow="8"') +
        field("time-picker"),
    ),
    selector: selector("time-picker", "field"),
    expected: "08:00",
    property: "value",
  },
  {
    id: "number-input",
    controller: NumberInputController,
    markup: root(
      "number-input",
      target("number-input", "input", "", "input", 'role="spinbutton" value="5"'),
    ),
    selector: selector("number-input", "input"),
    expected: "5",
    attribute: "aria-valuenow",
  },
  {
    id: "currency-input",
    controller: CurrencyInputController,
    markup: root(
      "currency-input",
      target("currency-input", "display", "", "input", 'value="12"') + field("currency-input"),
    ),
    selector: selector("currency-input", "field"),
    expected: "12",
    property: "value",
  },
  {
    id: "input-mask",
    controller: InputMaskController,
    markup: `<input data-controller="stimeo--input-mask" data-stimeo--input-mask-pattern-value="99" value="12">`,
    selector: `[data-controller="stimeo--input-mask"]`,
    expected: "true",
    attribute: "data-mask-complete",
  },
  {
    id: "character-counter",
    controller: CharacterCounterController,
    markup: root(
      "character-counter",
      target("character-counter", "input", "abc", "textarea") +
        target("character-counter", "output"),
    ),
    selector: selector("character-counter", "output"),
    expected: "3",
    property: "textContent",
  },
  {
    id: "password-strength",
    controller: PasswordStrengthController,
    markup: root(
      "password-strength",
      target("password-strength", "input", "", "input") + target("password-strength", "meter"),
    ),
    selector: selector("password-strength", "meter"),
    expected: "0",
    attribute: "aria-valuenow",
  },
  {
    id: "pagination",
    controller: PaginationController,
    markup: root("pagination", target("pagination", "page", "1", "button", 'data-page="1"')),
    selector: selector("pagination", "page"),
    expected: "page",
    attribute: "aria-current",
  },
  {
    id: "stepper",
    controller: StepperController,
    markup: root("stepper", target("stepper", "step", "One")),
    selector: selector("stepper", "step"),
    expected: "current",
    attribute: "data-state",
  },
  {
    id: "step-indicator",
    controller: StepIndicatorController,
    markup: root("step-indicator", target("step-indicator", "step", "One")),
    selector: selector("step-indicator", "step"),
    expected: "current",
    attribute: "data-state",
  },
  {
    id: "bulk-select",
    controller: BulkSelectController,
    markup: root(
      "bulk-select",
      field("bulk-select", "item", "checked") + target("bulk-select", "count"),
    ),
    selector: selector("bulk-select", "count"),
    expected: "1",
    property: "textContent",
  },
];

describe("retained widget morph output", () => {
  let application: Application | undefined;
  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    vi.restoreAllMocks();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  for (const fixture of fixtures) {
    for (const origin of ["root", "descendant"] as const) {
      if (fixture.id === "input-mask" && origin === "descendant") continue;
      it(`${fixture.id} repairs ${origin} morph output once without publishing a move`, async () => {
        document.body.innerHTML = fixture.markup;
        const host = document.querySelector<HTMLElement>("[data-controller]");
        if (!host) throw new Error("Missing fixture host");
        const subscriptions = vi.spyOn(host, "addEventListener");
        application = Application.start();
        application.register(`stimeo--${fixture.id}`, fixture.controller);
        await tick();
        const subscription = subscriptions.mock.calls.find(
          ([type]) => type === "turbo:morph-element",
        );
        const options = subscription?.[2];
        const signal = typeof options === "object" ? options.signal : undefined;
        if (!signal) throw new Error("Missing morph subscription lifetime");
        expect(signal.aborted).toBe(false);
        const output = document.querySelector<HTMLInputElement>(fixture.selector);
        if (!host || !output) throw new Error("Missing fixture target");
        const generated = fixture.id === "tags-input" || fixture.id === "multi-select";
        const currentOutput = () =>
          document.querySelector<HTMLInputElement>(fixture.selector) ?? output;
        const read = () =>
          fixture.attribute
            ? output.getAttribute(fixture.attribute)
            : currentOutput()[fixture.property ?? "textContent"];
        expect(read()).toBe(fixture.expected);
        const instance = application.getControllerForElementAndIdentifier(
          host,
          `stimeo--${fixture.id}`,
        );
        if (!instance) throw new Error("Missing controller");
        const reconnect = vi.spyOn(instance, "connect");
        const events: string[] = [];
        for (const event of ["change", "reconcile", "select", "monthchange", "toggle", "filter"]) {
          host.addEventListener(`stimeo--${fixture.id}:${event}`, () => events.push(event));
        }
        host.addEventListener("change", () => events.push("native change"));
        const announce = () => events.push("announce");
        window.addEventListener("stimeo--announcer:announce", announce);
        try {
          const damage = () => {
            if (fixture.attribute) output.removeAttribute(fixture.attribute);
            else currentOutput()[fixture.property ?? "textContent"] = "lost";
          };
          damage();
          expect(read()).not.toBe(fixture.expected);
          const mutations: MutationRecord[] = [];
          const observer = new MutationObserver((records) => mutations.push(...records));
          observer.observe(output, {
            attributes: true,
            childList: !fixture.attribute,
            attributeFilter: fixture.attribute ? [fixture.attribute] : undefined,
          });
          const writes =
            generated && output.parentElement
              ? vi.spyOn(output.parentElement, "replaceChildren")
              : fixture.property
                ? vi.spyOn(output, fixture.property, "set")
                : null;
          const from = origin === "root" ? host : host.firstElementChild;
          if (!from) throw new Error("Missing morph origin");
          for (let n = 0; n < 3; n++)
            from.dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
          await tick();
          expect(read()).toBe(fixture.expected);
          expect(writes ? writes.mock.calls.length : mutations.length).toBe(1);
          expect(events).toEqual([]);
          expect(reconnect).not.toHaveBeenCalled();
          observer.disconnect();
          instance.disconnect();
          expect(signal.aborted).toBe(true);
          damage();
          from.dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
          await tick();
          expect(read()).not.toBe(fixture.expected);
        } finally {
          window.removeEventListener("stimeo--announcer:announce", announce);
        }
      });
    }
  }
});

describe("morph ownership and active input", () => {
  let application: Application | undefined;
  const mount = async (id: string) => {
    const fixture = fixtures.find((entry) => entry.id === id);
    if (!fixture) throw new Error("Missing fixture");
    document.body.innerHTML = fixture.markup;
    application = Application.start();
    application.register(`stimeo--${id}`, fixture.controller);
    await tick();
    const host = document.querySelector<HTMLElement>("[data-controller]");
    if (!host) throw new Error("Missing host");
    return host;
  };
  const morph = async (host: HTMLElement) => {
    host.dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    await tick();
  };
  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    document.body.innerHTML = "";
  });

  for (const replacement of ["New prompt", "Apple"]) {
    it(`listbox repairs lost ownership stamps and preserves ${replacement} as authored`, async () => {
      const host = await mount("listbox");
      const label = host.querySelector<HTMLElement>(selector("listbox", "value"));
      const option = host.querySelector<HTMLElement>(selector("listbox", "option"));
      const field = host.querySelector<HTMLInputElement>(selector("listbox", "field"));
      if (!label || !option || !field) throw new Error("Missing listbox target");
      const seen: string[] = [];
      host.addEventListener("stimeo--listbox:reconcile", () => seen.push("reconcile"));
      host.addEventListener("change", () => seen.push("native change"));
      label.removeAttribute("data-stimeo--listbox-owns-label");
      label.removeAttribute("data-stimeo--listbox-original-label");
      label.textContent = replacement;
      field.value = "lost";
      await morph(host);
      expect(label.textContent).toBe("Apple");
      expect(label.getAttribute("data-stimeo--listbox-owns-label")).toBe("Apple");
      expect(field.value).toBe("apple");
      expect(seen).toEqual([]);
      option.setAttribute("aria-selected", "false");
      await morph(host);
      expect(label.textContent).toBe(replacement === "Apple" ? "" : "New prompt");
      expect(field.value).toBe("");
      expect(seen).toEqual(["reconcile"]);
    });
  }

  it("listbox keeps new authored label markup when an empty selection returns", async () => {
    const host = await mount("listbox");
    const label = host.querySelector<HTMLElement>(selector("listbox", "value"));
    const option = host.querySelector<HTMLElement>(selector("listbox", "option"));
    if (!label || !option) throw new Error("Missing listbox target");
    label.innerHTML = "<strong>Server prompt</strong>";
    const authored = label.firstElementChild;
    option.setAttribute("aria-selected", "false");
    await morph(host);
    expect(label.firstElementChild).toBe(authored);
    expect(label.textContent).toBe("Server prompt");
  });

  for (const id of ["number-input", "currency-input", "input-mask"]) {
    it(`${id} preserves the selection range while repairing stable input output`, async () => {
      const host = await mount(id);
      const input =
        host instanceof HTMLInputElement ? host : host.querySelector<HTMLInputElement>("input");
      if (!input) throw new Error("Missing input");
      input.focus();
      input.setSelectionRange(0, 1, "backward");
      const value = input.value;
      const output =
        id === "number-input" ? "aria-valuenow" : id === "input-mask" ? "data-mask-complete" : null;
      if (output) input.removeAttribute(output);
      else {
        const field = host.querySelector<HTMLInputElement>(selector(id, "field"));
        if (!field) throw new Error("Missing field");
        field.value = "lost";
      }
      await morph(host);
      expect(input.value).toBe(value);
      expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([
        0,
        1,
        "backward",
      ]);
      if (output) expect(input.hasAttribute(output)).toBe(true);
      else expect(host.querySelector<HTMLInputElement>(selector(id, "field"))?.value).toBe("12");
    });

    it(`${id} leaves IME text untouched until composition ends`, async () => {
      const host = await mount(id);
      const input =
        host instanceof HTMLInputElement ? host : host.querySelector<HTMLInputElement>("input");
      if (!input) throw new Error("Missing input");
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      input.value = "３４";
      await morph(host);
      expect(input.value).toBe("３４");
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "３４" }));
      await tick();
      expect(input.value).not.toBe("３４");
    });
  }
});

describe("character counter morph ownership", () => {
  let application: Application | undefined;
  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    document.body.innerHTML = "";
  });

  it("repairs a lost invalid output while respecting a new authored invalid value", async () => {
    document.body.innerHTML = root(
      "character-counter",
      target("character-counter", "input", "abc", "textarea"),
      'data-stimeo--character-counter-max-value="2"',
    );
    application = Application.start();
    application.register("stimeo--character-counter", CharacterCounterController);
    await tick();
    const host = document.querySelector<HTMLElement>("[data-controller]");
    const input = document.querySelector<HTMLTextAreaElement>("textarea");
    if (!host || !input) throw new Error("Missing counter fixture");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const reports: string[] = [];
    host.addEventListener("stimeo--character-counter:change", () => reports.push("change"));
    host.addEventListener("stimeo--character-counter:reconcile", () => reports.push("reconcile"));
    input.removeAttribute("aria-invalid");
    host.dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    await tick();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    input.setAttribute("aria-invalid", "grammar");
    host.dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    await tick();
    expect(input.getAttribute("aria-invalid")).toBe("grammar");
    expect(reports).toEqual([]);
  });
});
