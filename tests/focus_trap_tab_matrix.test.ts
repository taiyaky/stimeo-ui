import { ComboboxController } from "../src/controllers/combobox_controller";
import { ContextMenuController } from "../src/controllers/context_menu_controller";
import { ListboxController } from "../src/controllers/listbox_controller";
import { MenuController } from "../src/controllers/menu_controller";
import { MenubarController } from "../src/controllers/menubar_controller";
import { MultiSelectController } from "../src/controllers/multi_select_controller";
import { byId } from "./helpers/dom";
import { describeTrapTabMatrix, focusClick, type TabInner } from "./helpers/trap_tab_matrix";

/**
 * Table-driven pair matrix for the focus trap's Tab handling: the controllers that
 * build a trap × the widgets that handle `Tab` themselves while open. The widget
 * closes and leaves the key unconsumed; the trap moves focus to the stop after the
 * widget. A pair that composes badly shows up as a focus that does not move, moves
 * twice, or is pulled back when the widget closes a task later.
 */

const INNERS: TabInner[] = [
  {
    kind: "menu",
    register: (app) => app.register("stimeo--menu", MenuController),
    markup: (p) => `
      <div data-controller="stimeo--menu">
        <button type="button" id="${p}-trigger" data-stimeo--menu-target="trigger"
                data-action="click->stimeo--menu#toggle keydown->stimeo--menu#onTriggerKeydown"
                aria-haspopup="menu" aria-expanded="false" aria-controls="${p}-list">Actions</button>
        <ul id="${p}-list" role="menu" aria-labelledby="${p}-trigger"
            data-stimeo--menu-target="menu" hidden>
          <li role="none">
            <button type="button" id="${p}-item" role="menuitem" tabindex="-1"
                    data-stimeo--menu-target="item"
                    data-action="click->stimeo--menu#activate
                                 keydown->stimeo--menu#onItemKeydown">Rename</button>
          </li>
        </ul>
      </div>`,
    open: (p) => {
      focusClick(`${p}-trigger`);
      byId(`${p}-item`).focus();
    },
    isOpen: (p) => !byId(`${p}-list`).hidden,
  },
  {
    kind: "menubar",
    register: (app) => app.register("stimeo--menubar", MenubarController),
    markup: (p) => `
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        <button type="button" id="${p}-trigger" role="menuitem" aria-haspopup="menu"
                aria-expanded="false" aria-controls="${p}-list"
                data-stimeo--menubar-target="top"
                data-action="click->stimeo--menubar#toggle
                             keydown->stimeo--menubar#onTopKeydown">File</button>
        <ul id="${p}-list" role="menu" aria-label="File" hidden
            data-stimeo--menubar-target="menu">
          <li role="none">
            <button type="button" id="${p}-item" role="menuitem" tabindex="-1"
                    data-stimeo--menubar-target="item"
                    data-action="click->stimeo--menubar#activate
                                 keydown->stimeo--menubar#onItemKeydown">New</button>
          </li>
        </ul>
      </div>`,
    open: (p) => {
      focusClick(`${p}-trigger`);
      byId(`${p}-item`).focus();
    },
    isOpen: (p) => !byId(`${p}-list`).hidden,
  },
  {
    kind: "context-menu",
    register: (app) => app.register("stimeo--context-menu", ContextMenuController),
    markup: (p) => `
      <div data-controller="stimeo--context-menu">
        <div id="${p}-region" data-stimeo--context-menu-target="region" tabindex="0"
             aria-haspopup="menu" aria-controls="${p}-list"
             data-action="contextmenu->stimeo--context-menu#open
                          keydown->stimeo--context-menu#onRegionKeydown">Area</div>
        <ul id="${p}-list" role="menu" data-stimeo--context-menu-target="menu" hidden>
          <li role="none">
            <button type="button" id="${p}-item" role="menuitem" tabindex="-1"
                    data-stimeo--context-menu-target="item"
                    data-action="click->stimeo--context-menu#activate
                                 keydown->stimeo--context-menu#onItemKeydown">Copy</button>
          </li>
        </ul>
      </div>`,
    open: (p) => {
      byId(`${p}-region`).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 8, clientY: 8 }),
      );
      byId(`${p}-item`).focus();
    },
    isOpen: (p) => !byId(`${p}-list`).hidden,
  },
  {
    kind: "combobox",
    register: (app) => app.register("stimeo--combobox", ComboboxController),
    markup: (p) => `
      <div data-controller="stimeo--combobox">
        <input id="${p}-input" type="text" role="combobox" aria-expanded="false"
               aria-autocomplete="list" aria-controls="${p}-list" aria-label="Fruit"
               data-stimeo--combobox-target="input"
               data-action="input->stimeo--combobox#filter keydown->stimeo--combobox#onKeydown
                            focus->stimeo--combobox#open" />
        <ul id="${p}-list" role="listbox" aria-label="Fruits"
            data-stimeo--combobox-target="list" hidden>
          <li role="option" id="${p}-apple" data-value="apple"
              data-stimeo--combobox-target="option"
              data-action="click->stimeo--combobox#select">Apple</li>
        </ul>
      </div>`,
    open: (p) => byId(`${p}-input`).focus(),
    isOpen: (p) => !byId(`${p}-list`).hidden,
  },
  {
    kind: "listbox",
    register: (app) => app.register("stimeo--listbox", ListboxController),
    markup: (p) => `
      <div data-controller="stimeo--listbox">
        <button type="button" id="${p}-trigger" role="combobox" aria-haspopup="listbox"
                aria-expanded="false" aria-controls="${p}-list" aria-label="Fruit"
                data-stimeo--listbox-target="trigger"
                data-action="click->stimeo--listbox#toggle
                             keydown->stimeo--listbox#onTriggerKeydown">
          <span data-stimeo--listbox-target="value">Choose…</span>
        </button>
        <ul id="${p}-list" role="listbox" aria-label="Options" hidden
            data-stimeo--listbox-target="list">
          <li id="${p}-apple" role="option" aria-selected="false" data-value="apple"
              data-stimeo--listbox-target="option"
              data-action="click->stimeo--listbox#select">Apple</li>
        </ul>
      </div>`,
    // Opened from the keyboard: the list opens and focus stays on the trigger.
    open: (p) => {
      byId(`${p}-trigger`).focus();
      byId(`${p}-trigger`).dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
    },
    isOpen: (p) => !byId(`${p}-list`).hidden,
  },
  {
    kind: "multi-select",
    register: (app) => app.register("stimeo--multi-select", MultiSelectController),
    markup: (p) => `
      <div data-controller="stimeo--multi-select">
        <ul data-stimeo--multi-select-target="tags" aria-label="Selected"></ul>
        <input id="${p}-input" type="text" role="combobox" aria-expanded="false"
               aria-autocomplete="list" aria-controls="${p}-list" aria-label="Fruits"
               data-stimeo--multi-select-target="input"
               data-action="input->stimeo--multi-select#filter
                            keydown->stimeo--multi-select#onKeydown
                            focus->stimeo--multi-select#open" />
        <ul id="${p}-list" role="listbox" aria-multiselectable="true" aria-label="Options"
            hidden data-stimeo--multi-select-target="list">
          <li id="${p}-apple" role="option" aria-selected="false" data-value="apple"
              data-stimeo--multi-select-target="option"
              data-action="click->stimeo--multi-select#toggleOption">Apple</li>
        </ul>
        <template data-stimeo--multi-select-target="tagTemplate">
          <li data-stimeo--multi-select-target="tag">
            <span data-stimeo--multi-select-target="label"></span>
            <button type="button" tabindex="-1" aria-label="Remove {label}"
                    data-stimeo--multi-select-target="remove">×</button>
          </li>
        </template>
      </div>`,
    open: (p) => byId(`${p}-input`).focus(),
    isOpen: (p) => !byId(`${p}-list`).hidden,
  },
];

describeTrapTabMatrix(
  "Focus trap Tab pair matrix (the widget closes, the trap moves once)",
  INNERS,
);
