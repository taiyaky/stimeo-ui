import { describe, expect, it } from "vitest";
import { ComboboxController } from "../src/controllers/combobox_controller";
import { CommandPaletteController } from "../src/controllers/command_palette_controller";
import { FilterController } from "../src/controllers/filter_controller";
import { MultiSelectController } from "../src/controllers/multi_select_controller";
import { press } from "./helpers/keyboard";
import {
  type HiddenOptionCase,
  measureHiddenOption,
  measureOptionAttributes,
  type OptionAttributeCase,
  optionAttributeRows,
} from "./helpers/option_attributes";

/** Reports a page-written field value through the component's input action. */
const typeInto = (input: HTMLElement, value: string): void => {
  (input as HTMLInputElement).value = value;
  input.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }),
  );
};

/** The departing target receives a stable id while the remaining elements keep theirs. */
const filterCase = (departs: "item" | "group" | "empty"): OptionAttributeCase => {
  const departing = { item: "item-a", group: "group-a", empty: "empty" }[departs];
  const id = (name: string) => (name === departing ? "departing" : name);
  return {
    identifier: "stimeo--filter",
    controller: FilterController,
    markup: `<div id="host" data-controller="stimeo--filter">
      <input id="facet-b" type="checkbox" value="b" data-stimeo--filter-target="control">
      <input id="facet-c" type="checkbox" value="c" data-stimeo--filter-target="control">
      <section id="${id("group-a")}" data-stimeo--filter-target="group">
        <p id="${id("item-a")}" data-stimeo--filter-target="item" data-stimeo--filter-tokens="a">A</p>
      </section>
      <p id="item-b" data-stimeo--filter-target="item" data-stimeo--filter-tokens="b">B</p>
      <p id="${id("empty")}" data-stimeo--filter-target="empty" hidden>Nothing</p>
    </div>`,
    target: departs,
    watch: Object.fromEntries(
      ["item-a", "group-a", "item-b", "empty"].map((name) => [id(name), ["hidden"]]),
    ),
    arrange: (byId) => byId(departs === "empty" ? "facet-c" : "facet-b").click(),
  };
};

/** The query filters out the first combobox option, or navigation highlights a visible one. */
const comboboxCase = (
  arrange: "filtered out" | "active",
  authored: "none" | "aria-selected" | "hidden" = "none",
): OptionAttributeCase => ({
  identifier: "stimeo--combobox",
  controller: ComboboxController,
  markup: `<div id="host" data-controller="stimeo--combobox">
    <input id="input" type="text" role="combobox" aria-expanded="false" aria-autocomplete="list"
           aria-controls="list" data-stimeo--combobox-target="input"
           data-action="input->stimeo--combobox#filter keydown->stimeo--combobox#onKeydown">
    <ul id="list" role="listbox" data-stimeo--combobox-target="list" hidden>
      <li id="departing" role="option" data-stimeo--combobox-target="option"
          ${{ none: "", "aria-selected": 'aria-selected="false"', hidden: "hidden" }[authored]}>Apple</li>
      <li id="other" role="option" data-stimeo--combobox-target="option">Banana</li>
    </ul>
    <p id="empty" data-stimeo--combobox-target="empty" hidden>No match</p>
  </div>`,
  target: "option",
  watch:
    arrange === "active"
      ? {
          departing: ["aria-selected", "hidden"],
          other: ["aria-selected", "hidden"],
          input: ["aria-expanded", "aria-activedescendant"],
          list: ["hidden"],
          empty: ["hidden"],
          host: ["data-stimeo--combobox-empty"],
        }
      : { departing: ["hidden"], other: ["hidden"] },
  marks: ["data-stimeo--combobox-empty"],
  arrange: (byId) => {
    if (arrange === "active") press(byId("input"), "ArrowDown");
    else typeInto(byId("input"), "ban");
  },
});

/** A click selects the first option, or the query excludes it. */
const multiSelectCase = (
  authored: boolean,
  arrange: "selected" | "filtered out",
): OptionAttributeCase => ({
  identifier: "stimeo--multi-select",
  controller: MultiSelectController,
  markup: `<div id="host" data-controller="stimeo--multi-select">
    <ul data-stimeo--multi-select-target="tags" aria-label="Selected"></ul>
    <input id="input" type="text" role="combobox" aria-expanded="false" aria-autocomplete="list"
           aria-controls="list" data-stimeo--multi-select-target="input"
           data-action="input->stimeo--multi-select#filter keydown->stimeo--multi-select#onKeydown">
    <ul id="list" role="listbox" aria-multiselectable="true" hidden
        data-stimeo--multi-select-target="list">
      <li id="departing" role="option" data-value="apple" ${authored ? 'aria-selected="false"' : ""}
          data-stimeo--multi-select-target="option"
          data-action="click->stimeo--multi-select#toggleOption">Apple</li>
      <li id="other" role="option" data-value="banana" ${authored ? 'aria-selected="false"' : ""}
          data-stimeo--multi-select-target="option"
          data-action="click->stimeo--multi-select#toggleOption">Banana</li>
    </ul>
  </div>`,
  target: "option",
  watch: {
    departing: ["aria-selected", "hidden", "data-active"],
    other: ["aria-selected", "hidden", "data-active"],
  },
  marks: ["data-active"],
  arrange: (byId) => {
    if (arrange === "selected") {
      press(byId("input"), "ArrowDown");
      byId("departing").click();
    } else {
      typeInto(byId("input"), "ban");
    }
  },
});

/** An open palette highlights, filters, or disables its first option. */
const commandPaletteCase = (
  arrange: "active" | "filtered out" | "disabled",
  authored = false,
  fullWatch = false,
): OptionAttributeCase => ({
  identifier: "stimeo--command-palette",
  controller: CommandPaletteController,
  markup: `<div id="host" data-controller="stimeo--command-palette">
    <button id="opener" type="button" data-action="click->stimeo--command-palette#open">Open</button>
    <div id="dialog" role="dialog" aria-modal="true" aria-label="Commands" hidden
         data-stimeo--command-palette-target="dialog">
      <input id="input" role="combobox" aria-expanded="false" aria-controls="list"
             aria-autocomplete="list" aria-label="Search" data-stimeo--command-palette-target="input"
             data-action="input->stimeo--command-palette#filter keydown->stimeo--command-palette#onKeydown">
      <ul id="list" role="listbox" data-stimeo--command-palette-target="list">
        <li id="departing" role="option" ${authored ? 'aria-selected="false"' : ""}
            ${arrange === "disabled" ? 'data-disabled="true"' : ""}
            data-stimeo--command-palette-target="option">New file</li>
        <li id="other" role="option" data-stimeo--command-palette-target="option">Open recent</li>
      </ul>
    </div>
  </div>`,
  target: "option",
  watch: fullWatch
    ? {
        departing: [
          "aria-selected",
          "hidden",
          "data-active",
          "aria-disabled",
          "data-command-palette-original-aria-disabled",
        ],
        other: ["aria-selected", "hidden", "data-active"],
        dialog: ["hidden"],
        input: ["aria-expanded", "aria-activedescendant"],
      }
    : arrange === "disabled"
      ? { departing: ["aria-disabled", "data-command-palette-original-aria-disabled"] }
      : { departing: ["hidden"], other: ["hidden"] },
  marks: ["data-active", "data-command-palette-original-aria-disabled"],
  arrange: (byId) => {
    byId("opener").click();
    if (arrange === "filtered out") typeInto(byId("input"), "open");
  },
});

const rows = [
  ...optionAttributeRows("filter item", filterCase("item"), ["token", "identifier"]),
  ...optionAttributeRows("filter group", filterCase("group"), ["token", "identifier"]),
  ...optionAttributeRows("filter empty", filterCase("empty"), ["token", "identifier"]),
  ...optionAttributeRows(
    "combobox option filtered out",
    comboboxCase("filtered out"),
    ["token", "identifier"],
    ["token", "identifier"],
  ),
  ...optionAttributeRows(
    "multi-select option, authored",
    multiSelectCase(true, "selected"),
    ["token", "identifier"],
    ["token", "identifier"],
  ),
  ...optionAttributeRows(
    "multi-select option, not authored",
    multiSelectCase(false, "selected"),
    ["token", "identifier"],
    ["token", "identifier"],
  ),
  ...optionAttributeRows(
    "multi-select option filtered out",
    multiSelectCase(false, "filtered out"),
    ["token", "identifier"],
    ["token", "identifier"],
  ),
  ...optionAttributeRows(
    "command-palette option filtered out",
    commandPaletteCase("filtered out"),
    ["token", "identifier"],
    ["token", "identifier"],
  ),
  ...optionAttributeRows(
    "command-palette option data-disabled",
    commandPaletteCase("disabled"),
    ["token", "identifier"],
    ["token", "identifier"],
  ),
];

const activeRows = [
  ...optionAttributeRows(
    "combobox active option without authored attributes",
    comboboxCase("active"),
    ["token", "identifier", "removal"],
    ["token", "identifier"],
  ),
  ...optionAttributeRows(
    "combobox active option with authored aria-selected",
    comboboxCase("active", "aria-selected"),
    ["identifier", "removal"],
    ["identifier"],
  ),
  ...optionAttributeRows(
    "combobox active option with an authored hidden candidate",
    comboboxCase("active", "hidden"),
    ["token", "identifier", "removal"],
    ["token", "identifier"],
  ),
];

const paletteActiveRows = [
  ...optionAttributeRows(
    "command palette active option with authored aria-selected",
    commandPaletteCase("active", true, true),
    ["identifier", "removal"],
    ["identifier"],
  ),
  ...optionAttributeRows(
    "command palette active option without authored attributes",
    commandPaletteCase("active", false, true),
    ["token", "identifier", "removal"],
    ["token", "identifier"],
  ),
  ...optionAttributeRows(
    "command palette filtered option on root removal",
    commandPaletteCase("filtered out", false, true),
    ["removal"],
  ),
  ...optionAttributeRows(
    "command palette disabled option on root removal",
    commandPaletteCase("disabled", false, true),
    ["removal"],
  ),
];

const hiddenCandidates: (readonly [string, HiddenOptionCase])[] = [
  [
    "combobox",
    {
      identifier: "stimeo--combobox",
      controller: ComboboxController,
      markup: `<div id="host" data-controller="stimeo--combobox">
        <input id="input" type="text" role="combobox" aria-expanded="false" aria-autocomplete="list"
               aria-controls="list" data-stimeo--combobox-target="input"
               data-action="input->stimeo--combobox#filter keydown->stimeo--combobox#onKeydown">
        <ul id="list" role="listbox" data-stimeo--combobox-target="list" hidden>
          <li id="authored" role="option" data-stimeo--combobox-target="option" hidden>Apricot</li>
          <li id="probe" role="option" data-stimeo--combobox-target="option">Banana</li>
        </ul>
      </div>`,
      steps: [
        [
          "open",
          (byId) => {
            press(byId("input"), "ArrowDown");
          },
        ],
        ["query matching it", (byId) => typeInto(byId("input"), "ap")],
        ["query cleared", (byId) => typeInto(byId("input"), "")],
        [
          "close",
          (byId) => {
            press(byId("input"), "Escape");
          },
        ],
      ],
    },
  ],
  [
    "multi-select",
    {
      identifier: "stimeo--multi-select",
      controller: MultiSelectController,
      markup: `<div id="host" data-controller="stimeo--multi-select">
        <input id="input" type="text" role="combobox" aria-expanded="false" aria-autocomplete="list"
               aria-controls="list" data-stimeo--multi-select-target="input"
               data-action="input->stimeo--multi-select#filter keydown->stimeo--multi-select#onKeydown">
        <ul id="list" role="listbox" aria-multiselectable="true" hidden
            data-stimeo--multi-select-target="list">
          <li id="authored" role="option" data-value="apricot" hidden
              data-stimeo--multi-select-target="option">Apricot</li>
          <li id="probe" role="option" data-value="banana"
              data-stimeo--multi-select-target="option">Banana</li>
        </ul>
      </div>`,
      steps: [
        [
          "open",
          (byId) => {
            press(byId("input"), "ArrowDown");
          },
        ],
        ["query matching it", (byId) => typeInto(byId("input"), "ap")],
        ["query cleared", (byId) => typeInto(byId("input"), "")],
        [
          "close",
          (byId) => {
            press(byId("input"), "Escape");
          },
        ],
      ],
    },
  ],
  [
    "command-palette",
    {
      identifier: "stimeo--command-palette",
      controller: CommandPaletteController,
      markup: `<div id="host" data-controller="stimeo--command-palette">
        <button id="opener" type="button" data-action="click->stimeo--command-palette#open">Open</button>
        <div id="dialog" role="dialog" aria-modal="true" aria-label="Commands" hidden
             data-stimeo--command-palette-target="dialog">
          <input id="input" role="combobox" aria-expanded="false" aria-controls="list"
                 aria-autocomplete="list" aria-label="Search" data-stimeo--command-palette-target="input"
                 data-action="input->stimeo--command-palette#filter keydown->stimeo--command-palette#onKeydown">
          <ul id="list" role="listbox" data-stimeo--command-palette-target="list">
            <li id="authored" role="option" hidden data-stimeo--command-palette-target="option">Apricot</li>
            <li id="probe" role="option" data-stimeo--command-palette-target="option">Banana</li>
          </ul>
        </div>
      </div>`,
      steps: [
        ["open", (byId) => byId("opener").click()],
        ["query matching it", (byId) => typeInto(byId("input"), "ap")],
        ["query cleared", (byId) => typeInto(byId("input"), "")],
        [
          "close",
          (byId) => {
            press(byId("input"), "Escape");
          },
        ],
        ["reopen", (byId) => byId("opener").click()],
      ],
    },
  ],
  [
    "filter",
    {
      identifier: "stimeo--filter",
      controller: FilterController,
      markup: `<div id="host" data-controller="stimeo--filter">
        <input id="facet-a" type="checkbox" value="a" data-stimeo--filter-target="control">
        <button id="clear" type="button" data-action="stimeo--filter#clear">Clear</button>
        <p id="authored" hidden data-stimeo--filter-target="item" data-stimeo--filter-tokens="a">A</p>
        <p id="probe" data-stimeo--filter-target="item" data-stimeo--filter-tokens="b">B</p>
      </div>`,
      steps: [
        ["facet matching it", (byId) => byId("facet-a").click()],
        ["clear", (byId) => byId("clear").click()],
      ],
    },
  ],
];

/** Option attributes return to their author when target or controller ownership ends. */
describe("option attribute ownership", () => {
  it.each(
    rows.map(
      (row) => [`${row.name}: ${row.departure}${row.restored ? ", restored" : ""}`, row] as const,
    ),
  )("%s", async (_name, row) => {
    expect(await measureOptionAttributes(row)).toEqual([]);
  });
});

describe("active candidate attribute ownership", () => {
  it.each(
    activeRows.map(
      (row) => [`${row.name}: ${row.departure}${row.restored ? ", restored" : ""}`, row] as const,
    ),
  )("%s", async (_name, row) => {
    expect(await measureOptionAttributes(row)).toEqual([]);
  });
});

/** Active ARIA returns on departure and survives a root detached with its options. */
describe("command palette candidate attribute ownership", () => {
  it.each(
    paletteActiveRows.map(
      (row) => [`${row.name}: ${row.departure}${row.restored ? ", restored" : ""}`, row] as const,
    ),
  )("%s", async (_name, row) => {
    expect(await measureOptionAttributes(row)).toEqual([]);
  });
});

/** Filtering only adds hidden state and preserves the author's hidden candidates. */
describe("authored-hidden candidates", () => {
  it.each(hiddenCandidates)("%s stays hidden through filtering and reset", async (_name, item) => {
    expect(await measureHiddenOption(item)).toEqual([]);
  });
});
