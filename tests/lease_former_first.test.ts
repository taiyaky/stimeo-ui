import { afterEach, vi } from "vitest";
import { AlertDialogController } from "../src/controllers/alert_dialog_controller";
import { AvatarController } from "../src/controllers/avatar_controller";
import { BulkSelectController } from "../src/controllers/bulk_select_controller";
import { CarouselController } from "../src/controllers/carousel_controller";
import { CollapsibleController } from "../src/controllers/collapsible_controller";
import { ComboboxController } from "../src/controllers/combobox_controller";
import { CommandPaletteController } from "../src/controllers/command_palette_controller";
import { ConfirmController } from "../src/controllers/confirm_controller";
import { ContextMenuController } from "../src/controllers/context_menu_controller";
import { DateRangePickerController } from "../src/controllers/date_range_picker_controller";
import { DialogController } from "../src/controllers/dialog_controller";
import { DrawerController } from "../src/controllers/drawer_controller";
import { DropdownController } from "../src/controllers/dropdown_controller";
import { EditableController } from "../src/controllers/editable_controller";
import { FileDropzoneController } from "../src/controllers/file_dropzone_controller";
import { HoverCardController } from "../src/controllers/hover_card_controller";
import { ListboxController } from "../src/controllers/listbox_controller";
import { MenuController } from "../src/controllers/menu_controller";
import { MultiSelectController } from "../src/controllers/multi_select_controller";
import { NestedFormController } from "../src/controllers/nested_form_controller";
import { NetworkStatusController } from "../src/controllers/network_status_controller";
import { NumberInputController } from "../src/controllers/number_input_controller";
import { PasswordRevealController } from "../src/controllers/password_reveal_controller";
import { PopoverController } from "../src/controllers/popover_controller";
import { ScrollVisibilityController } from "../src/controllers/scroll_visibility_controller";
import { SidebarController } from "../src/controllers/sidebar_controller";
import { SkeletonController } from "../src/controllers/skeleton_controller";
import { SpinnerController } from "../src/controllers/spinner_controller";
import { StickyObserverController } from "../src/controllers/sticky_observer_controller";
import { describeFormerFirst, type FormerFirstCase, host, option } from "./helpers/former_first";
import { tick } from "./helpers/timing";

/** The callback of the last `IntersectionObserver` built, which a case drives by hand. */
let intersections: ((entries: IntersectionObserverEntry[]) => void) | null = null;

/** Stands in for `IntersectionObserver`, which happy-dom does not implement. */
function stubIntersections(): void {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        intersections = callback;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
}

afterEach(() => {
  intersections = null;
});

/**
 * The singular targets of the components, run through {@link describeFormerFirst}: each one
 * authored with a value the component replaces on connect.
 */
const cases: readonly (readonly [string, FormerFirstCase])[] = [
  [
    "dialog: dialog",
    {
      identifier: "stimeo--dialog",
      controller: DialogController,
      markup: host(
        "dialog",
        `<button data-stimeo--dialog-target="trigger">Open</button>
         <div id="former" data-stimeo--dialog-target="dialog" role="dialog" aria-modal="true" aria-label="D"><button>Close</button></div>`,
      ),
      target: "dialog",
      attributes: ["hidden"],
    },
  ],
  [
    "alert-dialog: dialog",
    {
      identifier: "stimeo--alert-dialog",
      controller: AlertDialogController,
      markup: host(
        "alert-dialog",
        `<button data-stimeo--alert-dialog-target="trigger">Delete</button>
         <div id="former" data-stimeo--alert-dialog-target="dialog" role="alertdialog" aria-modal="true" aria-label="A"><button>Cancel</button></div>`,
      ),
      target: "dialog",
      attributes: ["hidden"],
    },
  ],
  [
    "confirm: dialog",
    {
      identifier: "stimeo--confirm",
      controller: ConfirmController,
      markup: host(
        "confirm",
        `<div id="former" data-stimeo--confirm-target="dialog" role="alertdialog" aria-modal="true" aria-label="C">
           <button data-stimeo--confirm-target="cancel">Cancel</button>
           <button data-stimeo--confirm-target="confirm">OK</button>
         </div>`,
      ),
      target: "dialog",
      attributes: ["hidden"],
    },
  ],
  [
    "dropdown: menu",
    {
      identifier: "stimeo--dropdown",
      controller: DropdownController,
      markup: host(
        "dropdown",
        `<button data-stimeo--dropdown-target="trigger">Menu</button>
         <div id="former" data-stimeo--dropdown-target="menu"><a href="#a">A</a></div>`,
      ),
      target: "menu",
      attributes: ["hidden"],
    },
  ],
  [
    "dropdown: trigger",
    {
      identifier: "stimeo--dropdown",
      controller: DropdownController,
      markup: host(
        "dropdown",
        `<button id="former" data-stimeo--dropdown-target="trigger">Menu</button>
         <div data-stimeo--dropdown-target="menu" hidden><a href="#a">A</a></div>`,
      ),
      target: "trigger",
      attributes: ["aria-expanded"],
    },
  ],
  [
    "menu: menu",
    {
      identifier: "stimeo--menu",
      controller: MenuController,
      markup: host(
        "menu",
        `<button id="menu-trigger" data-stimeo--menu-target="trigger" aria-haspopup="menu" aria-expanded="false">Actions</button>
         <ul id="former" role="menu" aria-labelledby="menu-trigger" data-stimeo--menu-target="menu">
           <li role="none"><button role="menuitem" tabindex="-1" data-stimeo--menu-target="item">One</button></li>
         </ul>`,
      ),
      target: "menu",
      attributes: ["hidden"],
    },
  ],
  [
    "menu: trigger",
    {
      identifier: "stimeo--menu",
      controller: MenuController,
      markup: host(
        "menu",
        `<button id="former" data-stimeo--menu-target="trigger" aria-haspopup="menu">Actions</button>
         <ul role="menu" aria-label="Actions" data-stimeo--menu-target="menu" hidden>
           <li role="none"><button role="menuitem" tabindex="-1" data-stimeo--menu-target="item">One</button></li>
         </ul>`,
      ),
      target: "trigger",
      attributes: ["aria-expanded"],
    },
  ],
  [
    "popover: trigger",
    {
      identifier: "stimeo--popover",
      controller: PopoverController,
      markup: host(
        "popover",
        `<button id="former" data-stimeo--popover-target="trigger" aria-haspopup="dialog">Edit</button>
         <div data-stimeo--popover-target="panel" role="dialog" aria-label="Edit" hidden>Panel</div>`,
      ),
      target: "trigger",
      attributes: ["aria-expanded"],
    },
  ],
  [
    "hover-card: trigger",
    {
      identifier: "stimeo--hover-card",
      controller: HoverCardController,
      markup: host(
        "hover-card",
        `<a id="former" href="#u" data-stimeo--hover-card-target="trigger">@jane</a>
         <div data-stimeo--hover-card-target="card" hidden>Card</div>`,
      ),
      target: "trigger",
      attributes: ["aria-expanded"],
    },
  ],
  [
    "listbox: list",
    {
      identifier: "stimeo--listbox",
      controller: ListboxController,
      markup: host(
        "listbox",
        `<button type="button" role="combobox" aria-haspopup="listbox" aria-label="Fruit" data-stimeo--listbox-target="trigger"><span data-stimeo--listbox-target="value">Choose</span></button>
         <ul id="former" role="listbox" aria-label="Options" data-stimeo--listbox-target="list">${option("listbox", 1)}</ul>`,
      ),
      target: "list",
      attributes: ["hidden"],
    },
  ],
  [
    "listbox: trigger",
    {
      identifier: "stimeo--listbox",
      controller: ListboxController,
      markup: host(
        "listbox",
        `<button id="former" type="button" role="combobox" aria-haspopup="listbox" aria-label="Fruit" data-stimeo--listbox-target="trigger"><span data-stimeo--listbox-target="value">Choose</span></button>
         <ul role="listbox" aria-label="Options" hidden data-stimeo--listbox-target="list">${option("listbox", 1)}</ul>`,
      ),
      target: "trigger",
      attributes: ["aria-expanded"],
    },
  ],
  [
    "combobox: list",
    {
      identifier: "stimeo--combobox",
      controller: ComboboxController,
      markup: host(
        "combobox",
        `<input type="text" role="combobox" aria-label="Fruit" aria-expanded="false" aria-autocomplete="list" data-stimeo--combobox-target="input" />
         <ul id="former" role="listbox" aria-label="Options" data-stimeo--combobox-target="list">${option("combobox", 1)}</ul>`,
      ),
      target: "list",
      attributes: ["hidden"],
    },
  ],
  [
    "combobox: input",
    {
      identifier: "stimeo--combobox",
      controller: ComboboxController,
      markup: host(
        "combobox",
        `<input id="former" type="text" role="combobox" aria-label="Fruit" aria-autocomplete="list" data-stimeo--combobox-target="input" />
         <ul role="listbox" aria-label="Options" hidden data-stimeo--combobox-target="list">${option("combobox", 1)}</ul>`,
      ),
      target: "input",
      attributes: ["aria-expanded"],
    },
  ],
  [
    "command-palette: dialog",
    {
      identifier: "stimeo--command-palette",
      controller: CommandPaletteController,
      markup: host(
        "command-palette",
        `<div id="former" data-stimeo--command-palette-target="dialog" role="dialog" aria-modal="true" aria-label="Commands" hidden>
           <input data-stimeo--command-palette-target="input" role="combobox" aria-expanded="false" aria-label="Search" />
           <ul data-stimeo--command-palette-target="list" role="listbox" aria-label="Commands">${option("command-palette", 1)}</ul>
         </div>`,
      ),
      target: "dialog",
      attributes: ["hidden"],
      arrange: (controller) => (controller.open as () => void).call(controller),
    },
  ],
  [
    "command-palette: input",
    {
      identifier: "stimeo--command-palette",
      controller: CommandPaletteController,
      markup: host(
        "command-palette",
        `<div data-stimeo--command-palette-target="dialog" role="dialog" aria-modal="true" aria-label="Commands" hidden>
           <input id="former" data-stimeo--command-palette-target="input" role="combobox" aria-label="Search" />
           <ul data-stimeo--command-palette-target="list" role="listbox" aria-label="Commands">${option("command-palette", 1)}</ul>
         </div>`,
      ),
      target: "input",
      attributes: ["aria-expanded"],
    },
  ],
  [
    "context-menu: menu",
    {
      identifier: "stimeo--context-menu",
      controller: ContextMenuController,
      markup: host(
        "context-menu",
        `<div data-stimeo--context-menu-target="region" tabindex="0" aria-haspopup="menu">Region</div>
         <ul id="former" role="menu" aria-label="Actions" data-stimeo--context-menu-target="menu">
           <li role="none"><button role="menuitem" tabindex="-1" data-stimeo--context-menu-target="item">One</button></li>
         </ul>`,
      ),
      target: "menu",
      attributes: ["hidden"],
    },
  ],
  [
    "context-menu: region",
    {
      identifier: "stimeo--context-menu",
      controller: ContextMenuController,
      markup: host(
        "context-menu",
        `<div id="former" data-stimeo--context-menu-target="region" tabindex="0" aria-haspopup="menu">Region</div>
         <ul role="menu" aria-label="Actions" data-stimeo--context-menu-target="menu" hidden>
           <li role="none"><button role="menuitem" tabindex="-1" data-stimeo--context-menu-target="item">One</button></li>
         </ul>`,
      ),
      target: "region",
      attributes: ["data-state"],
    },
  ],
  [
    "date-range-picker: grid",
    {
      identifier: "stimeo--date-range-picker",
      controller: DateRangePickerController,
      markup: host(
        "date-range-picker",
        `<div id="former" role="grid" data-stimeo--date-range-picker-target="grid">${Array.from(
          { length: 42 },
          () =>
            `<button role="gridcell" tabindex="-1" data-stimeo--date-range-picker-target="cell"></button>`,
        ).join("")}</div>`,
        'data-stimeo--date-range-picker-month-value="2026-05"',
      ),
      target: "grid",
      attributes: ["aria-multiselectable"],
    },
  ],
  [
    "drawer: panel",
    {
      identifier: "stimeo--drawer",
      controller: DrawerController,
      markup: host(
        "drawer",
        `<button data-stimeo--drawer-target="trigger">Open</button>
         <div data-stimeo--drawer-target="overlay" hidden>
           <div id="former" data-stimeo--drawer-target="panel" role="dialog" aria-modal="true" aria-label="Panel"><button>Close</button></div>
         </div>`,
        'data-stimeo--drawer-placement-value="left"',
      ),
      target: "panel",
      attributes: ["data-state", "hidden", "data-placement"],
    },
  ],
  [
    "drawer: overlay",
    {
      identifier: "stimeo--drawer",
      controller: DrawerController,
      markup: host(
        "drawer",
        `<button data-stimeo--drawer-target="trigger">Open</button>
         <div id="former" data-stimeo--drawer-target="overlay">
           <div data-stimeo--drawer-target="panel" role="dialog" aria-modal="true" aria-label="Panel" data-state="closed" hidden><button>Close</button></div>
         </div>`,
      ),
      target: "overlay",
      attributes: ["data-state", "hidden"],
    },
  ],
  [
    "editable: input",
    {
      identifier: "stimeo--editable",
      controller: EditableController,
      markup: host(
        "editable",
        `<button type="button" aria-label="Edit title" data-stimeo--editable-target="display">Title</button>
         <input id="former" type="text" aria-label="Title" data-stimeo--editable-target="input" />`,
      ),
      target: "input",
      attributes: ["hidden"],
    },
  ],
  [
    "collapsible: trigger",
    {
      identifier: "stimeo--collapsible",
      controller: CollapsibleController,
      markup: host(
        "collapsible",
        `<button id="former" data-stimeo--collapsible-target="trigger">Details</button>
         <div data-stimeo--collapsible-target="content" data-state="closed" hidden>More</div>`,
      ),
      target: "trigger",
      attributes: ["aria-expanded"],
    },
  ],
  [
    "collapsible: content",
    {
      identifier: "stimeo--collapsible",
      controller: CollapsibleController,
      markup: host(
        "collapsible",
        `<button data-stimeo--collapsible-target="trigger" aria-expanded="false">Details</button>
         <div id="former" data-stimeo--collapsible-target="content">More</div>`,
      ),
      target: "content",
      attributes: ["hidden", "data-state"],
    },
  ],
  [
    "carousel: viewport",
    {
      identifier: "stimeo--carousel",
      controller: CarouselController,
      markup: `<section data-controller="stimeo--carousel" aria-roledescription="carousel" aria-label="Featured" data-stimeo--carousel-autoplay-value="false">
         <div id="former" data-stimeo--carousel-target="viewport">
           <div data-stimeo--carousel-target="slide">One</div>
           <div data-stimeo--carousel-target="slide">Two</div>
         </div>
         <button data-stimeo--carousel-target="prev">Prev</button>
         <button data-stimeo--carousel-target="next">Next</button>
       </section>`,
      target: "viewport",
      attributes: ["aria-live", "aria-atomic"],
    },
  ],
  [
    "avatar: image",
    {
      identifier: "stimeo--avatar",
      controller: AvatarController,
      markup: `<span data-controller="stimeo--avatar" role="img" aria-label="Jane" data-stimeo--avatar-src-value="/u/1.jpg">
         <img id="former" alt="" aria-hidden="true" data-stimeo--avatar-target="image" />
         <span aria-hidden="true" data-stimeo--avatar-target="fallback">JD</span>
       </span>`,
      target: "image",
      attributes: ["src", "hidden"],
    },
  ],
  [
    "avatar: fallback",
    {
      identifier: "stimeo--avatar",
      controller: AvatarController,
      markup: `<span data-controller="stimeo--avatar" role="img" aria-label="Jane" data-stimeo--avatar-src-value="/u/1.jpg">
         <img alt="" aria-hidden="true" data-stimeo--avatar-target="image" />
         <span id="former" aria-hidden="true" data-stimeo--avatar-target="fallback">JD</span>
       </span>`,
      target: "fallback",
      attributes: ["hidden"],
    },
  ],
  [
    "bulk-select: bar",
    {
      identifier: "stimeo--bulk-select",
      controller: BulkSelectController,
      markup: host(
        "bulk-select",
        `<input type="checkbox" aria-label="All" data-stimeo--bulk-select-target="all">
         <input type="checkbox" aria-label="One" data-stimeo--bulk-select-target="item">
         <div id="former" data-stimeo--bulk-select-target="bar" aria-label="Bulk actions"><span data-stimeo--bulk-select-target="count"></span></div>`,
      ),
      target: "bar",
      attributes: ["hidden"],
    },
  ],
  [
    "multi-select: list",
    {
      identifier: "stimeo--multi-select",
      controller: MultiSelectController,
      markup: host(
        "multi-select",
        `<ul data-stimeo--multi-select-target="tags" aria-label="Selected"></ul>
         <input type="text" role="combobox" aria-label="Fruit" aria-expanded="false" aria-autocomplete="list" data-stimeo--multi-select-target="input" />
         <ul id="former" role="listbox" aria-label="Options" aria-multiselectable="true" data-stimeo--multi-select-target="list">${option("multi-select", 1)}</ul>`,
      ),
      target: "list",
      attributes: ["hidden"],
    },
  ],
  [
    "nested-form: add",
    {
      identifier: "stimeo--nested-form",
      controller: NestedFormController,
      markup: host(
        "nested-form",
        `<div data-stimeo--nested-form-target="list"><fieldset><input aria-label="Name" name="n"></fieldset></div>
         <template data-stimeo--nested-form-target="template"><fieldset><input aria-label="Name" name="n"></fieldset></template>
         <button id="former" type="button" data-stimeo--nested-form-target="add">Add</button>`,
        'data-stimeo--nested-form-max-value="1"',
      ),
      target: "add",
      attributes: ["disabled"],
    },
  ],
  [
    "network-status: offline",
    {
      identifier: "stimeo--network-status",
      controller: NetworkStatusController,
      markup: host(
        "network-status",
        `<div id="former" data-stimeo--network-status-target="offline">You are offline.</div>
         <div hidden data-stimeo--network-status-target="online">Back online.</div>`,
      ),
      target: "offline",
      attributes: ["hidden"],
    },
  ],
  [
    "number-input: input",
    {
      identifier: "stimeo--number-input",
      controller: NumberInputController,
      markup: host(
        "number-input",
        `<input id="former" type="text" role="spinbutton" inputmode="numeric" value="3" aria-label="Quantity" data-stimeo--number-input-target="input" />`,
        'data-stimeo--number-input-min-value="0" data-stimeo--number-input-max-value="10"',
      ),
      target: "input",
      attributes: ["aria-valuenow", "aria-valuemin", "aria-valuemax"],
    },
  ],
  [
    "password-reveal: toggle",
    {
      identifier: "stimeo--password-reveal",
      controller: PasswordRevealController,
      markup: host(
        "password-reveal",
        `<input type="password" aria-label="Password" data-stimeo--password-reveal-target="input">
         <button id="former" type="button" aria-label="Show password" data-stimeo--password-reveal-target="toggle">Show</button>`,
      ),
      target: "toggle",
      attributes: ["aria-pressed"],
    },
  ],
  [
    "password-reveal: input, the first, revealed",
    {
      identifier: "stimeo--password-reveal",
      controller: PasswordRevealController,
      markup: host(
        "password-reveal",
        `<input id="former" type="password" aria-label="Password" data-stimeo--password-reveal-target="input">
         <button type="button" aria-pressed="false" aria-label="Show password" data-stimeo--password-reveal-target="toggle">Show</button>`,
      ),
      target: "input",
      attributes: ["type"],
      // A field is masked once another field is first, so only the first arrives revealed.
      ahead: false,
      arrange: (controller) => (controller.toggle as () => void).call(controller),
    },
  ],
  [
    "sidebar: trigger",
    {
      identifier: "stimeo--sidebar",
      controller: SidebarController,
      markup: host(
        "sidebar",
        `<button id="former" data-stimeo--sidebar-target="trigger" aria-controls="sb">Menu</button>
         <div data-stimeo--sidebar-target="backdrop" hidden></div>
         <aside id="sb" data-stimeo--sidebar-target="panel" aria-label="Main" data-mode="inline" data-state="expanded"><a href="#x">X</a></aside>`,
        'data-stimeo--sidebar-breakpoint-value="0"',
      ),
      target: "trigger",
      attributes: ["aria-expanded"],
    },
  ],
  [
    "sidebar: panel",
    {
      identifier: "stimeo--sidebar",
      controller: SidebarController,
      markup: host(
        "sidebar",
        `<button data-stimeo--sidebar-target="trigger" aria-expanded="true">Menu</button>
         <div data-stimeo--sidebar-target="backdrop" hidden></div>
         <aside id="former" data-stimeo--sidebar-target="panel" aria-label="Main"><a href="#x">X</a></aside>`,
        'data-stimeo--sidebar-breakpoint-value="0"',
      ),
      target: "panel",
      attributes: ["data-state", "data-mode"],
    },
  ],
  [
    "skeleton: placeholder",
    {
      identifier: "stimeo--skeleton",
      controller: SkeletonController,
      markup: `<div data-controller="stimeo--skeleton" aria-busy="true">
         <div id="former" aria-hidden="true" hidden data-stimeo--skeleton-target="placeholder"></div>
         <div hidden data-stimeo--skeleton-target="content">Content</div>
       </div>`,
      target: "placeholder",
      attributes: ["hidden"],
    },
  ],
  [
    "spinner: region",
    {
      identifier: "stimeo--spinner",
      controller: SpinnerController,
      markup: host(
        "spinner",
        `<div hidden data-stimeo--spinner-target="indicator">Loading</div>
         <div id="former" data-stimeo--spinner-target="region"></div>`,
        'data-stimeo--spinner-delay-value="0" data-stimeo--spinner-min-duration-value="0"',
      ),
      target: "region",
      attributes: ["aria-busy"],
      arrange: (controller) => (controller.start as () => void).call(controller),
    },
  ],
  [
    "scroll-visibility: element",
    {
      identifier: "stimeo--scroll-visibility",
      controller: ScrollVisibilityController,
      markup: host(
        "scroll-visibility",
        `<button id="former" type="button" data-stimeo--scroll-visibility-target="element">Back to top</button>`,
        'data-stimeo--scroll-visibility-offset-value="400"',
      ),
      target: "element",
      attributes: ["hidden"],
    },
  ],
  [
    "command-palette: empty",
    {
      identifier: "stimeo--command-palette",
      controller: CommandPaletteController,
      markup: host(
        "command-palette",
        `<div data-stimeo--command-palette-target="dialog" role="dialog" aria-modal="true" aria-label="Commands" hidden>
           <input data-stimeo--command-palette-target="input" role="combobox" aria-expanded="false" aria-label="Search" />
           <ul data-stimeo--command-palette-target="list" role="listbox" aria-label="Commands">${option("command-palette", 1)}</ul>
           <p id="former" data-stimeo--command-palette-target="empty">No commands</p>
         </div>`,
      ),
      target: "empty",
      attributes: ["hidden"],
      arrange: (controller) => (controller.filter as () => void).call(controller),
    },
  ],
  [
    "sidebar: panel, in overlay mode",
    {
      identifier: "stimeo--sidebar",
      controller: SidebarController,
      markup: host(
        "sidebar",
        `<button data-stimeo--sidebar-target="trigger" aria-expanded="false">Menu</button>
         <div data-stimeo--sidebar-target="backdrop" hidden></div>
         <aside id="former" data-stimeo--sidebar-target="panel" aria-label="Main" data-mode="overlay" data-state="collapsed"><a href="#x">X</a></aside>`,
        'data-stimeo--sidebar-breakpoint-value="100000"',
      ),
      target: "panel",
      attributes: ["hidden"],
    },
  ],
  [
    "sidebar: backdrop",
    {
      identifier: "stimeo--sidebar",
      controller: SidebarController,
      markup: host(
        "sidebar",
        `<button data-stimeo--sidebar-target="trigger" aria-expanded="true">Menu</button>
         <div id="former" data-stimeo--sidebar-target="backdrop"></div>
         <aside data-stimeo--sidebar-target="panel" aria-label="Main" data-mode="inline" data-state="expanded"><a href="#x">X</a></aside>`,
        'data-stimeo--sidebar-breakpoint-value="0"',
      ),
      target: "backdrop",
      attributes: ["hidden"],
    },
  ],
  [
    "editable: display",
    {
      identifier: "stimeo--editable",
      controller: EditableController,
      markup: host(
        "editable",
        `<button id="former" type="button" aria-label="Edit title" hidden data-stimeo--editable-target="display">Title</button>
         <input type="text" aria-label="Title" hidden data-stimeo--editable-target="input" />`,
      ),
      target: "display",
      attributes: ["hidden"],
    },
  ],
  [
    "network-status: online",
    {
      identifier: "stimeo--network-status",
      controller: NetworkStatusController,
      markup: host(
        "network-status",
        `<div hidden data-stimeo--network-status-target="offline">You are offline.</div>
         <div id="former" data-stimeo--network-status-target="online">Back online.</div>`,
      ),
      target: "online",
      attributes: ["hidden"],
    },
  ],
  [
    "skeleton: content",
    {
      identifier: "stimeo--skeleton",
      controller: SkeletonController,
      markup: `<div data-controller="stimeo--skeleton" aria-busy="true">
         <div aria-hidden="true" data-stimeo--skeleton-target="placeholder"></div>
         <div id="former" data-stimeo--skeleton-target="content">Content</div>
       </div>`,
      target: "content",
      attributes: ["hidden"],
    },
  ],
  [
    "sticky-observer: element",
    {
      identifier: "stimeo--sticky-observer",
      controller: StickyObserverController,
      markup: host(
        "sticky-observer",
        `<div data-stimeo--sticky-observer-target="sentinel" aria-hidden="true"></div>
         <header id="former" data-stimeo--sticky-observer-target="element">Heading</header>`,
      ),
      target: "element",
      attributes: ["data-stuck"],
      setup: stubIntersections,
      arrange: () => {
        const sentinel = document.querySelector(
          '[data-stimeo--sticky-observer-target="sentinel"]',
        ) as Element;
        intersections?.([
          {
            boundingClientRect: new DOMRect(0, -10, 1, 1),
            intersectionRatio: 0,
            intersectionRect: new DOMRect(),
            isIntersecting: false,
            rootBounds: new DOMRect(0, 0, 100, 100),
            target: sentinel,
            time: 0,
          },
        ]);
      },
    },
  ],
  [
    "file-dropzone: zone",
    {
      identifier: "stimeo--file-dropzone",
      controller: FileDropzoneController,
      markup: host(
        "file-dropzone",
        `<div id="former" data-stimeo--file-dropzone-target="zone">
           <input type="file" aria-label="Files" data-stimeo--file-dropzone-target="input" />
         </div>
         <ul data-stimeo--file-dropzone-target="list" aria-label="Selected files"></ul>`,
      ),
      target: "zone",
      attributes: ["data-dragover"],
      arrange: (controller) =>
        (controller.onDragOver as (event: Event) => void).call(
          controller,
          new Event("dragover", { cancelable: true }),
        ),
    },
  ],
  [
    "listbox: trigger, with an active option",
    {
      identifier: "stimeo--listbox",
      controller: ListboxController,
      markup: host(
        "listbox",
        `<button id="former" type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-label="Fruit" data-stimeo--listbox-target="trigger"><span data-stimeo--listbox-target="value">Choose</span></button>
         <ul role="listbox" aria-label="Options" hidden data-stimeo--listbox-target="list">${option("listbox", 1)}</ul>`,
      ),
      target: "trigger",
      attributes: ["aria-activedescendant"],
      arrange: (controller) => (controller.open as () => void).call(controller),
    },
  ],
  [
    "combobox: input, with an active option",
    {
      identifier: "stimeo--combobox",
      controller: ComboboxController,
      markup: host(
        "combobox",
        `<input id="former" type="text" role="combobox" aria-label="Fruit" aria-expanded="false" aria-autocomplete="list" data-stimeo--combobox-target="input" />
         <ul role="listbox" aria-label="Options" hidden data-stimeo--combobox-target="list">${option("combobox", 1)}</ul>`,
      ),
      target: "input",
      attributes: ["aria-activedescendant"],
      arrange: (controller) => {
        (controller.open as () => void).call(controller);
        (controller.onKeydown as (event: KeyboardEvent) => void).call(
          controller,
          new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }),
        );
      },
    },
  ],
  [
    "command-palette: input, with an active option",
    {
      identifier: "stimeo--command-palette",
      controller: CommandPaletteController,
      markup: host(
        "command-palette",
        `<div data-stimeo--command-palette-target="dialog" role="dialog" aria-modal="true" aria-label="Commands" hidden>
           <input id="former" data-stimeo--command-palette-target="input" role="combobox" aria-expanded="false" aria-label="Search" />
           <ul data-stimeo--command-palette-target="list" role="listbox" aria-label="Commands">${option("command-palette", 1)}</ul>
         </div>`,
      ),
      target: "input",
      attributes: ["aria-activedescendant"],
      arrange: (controller) => (controller.filter as () => void).call(controller),
    },
  ],
  [
    "collapsible: trigger, its labels",
    {
      identifier: "stimeo--collapsible",
      controller: CollapsibleController,
      markup: host(
        "collapsible",
        `<button id="former" data-stimeo--collapsible-target="trigger" aria-expanded="false">
           <span data-stimeo--collapsible-target="collapsedLabel">Show</span>
           <span data-stimeo--collapsible-target="expandedLabel">Hide</span>
         </button>
         <div data-stimeo--collapsible-target="content" data-state="closed" hidden>More</div>`,
      ),
      target: "trigger",
      attributes: [],
      regions: "span",
    },
  ],
  [
    "collapsible: trigger, its labels, one of them hidden by the page while it was open",
    {
      identifier: "stimeo--collapsible",
      controller: CollapsibleController,
      markup: host(
        "collapsible",
        `<button id="former" data-stimeo--collapsible-target="trigger" aria-expanded="false">
           <span data-stimeo--collapsible-target="collapsedLabel">Show</span>
           <span id="hide" data-stimeo--collapsible-target="expandedLabel">Hide</span>
         </button>
         <div data-stimeo--collapsible-target="content" data-state="closed" hidden>More</div>`,
      ),
      target: "trigger",
      attributes: [],
      regions: "span",
      arrange: async (controller) => {
        (controller.toggle as () => void).call(controller);
        await tick();
        (document.getElementById("hide") as HTMLElement).hidden = true;
        (controller.toggle as () => void).call(controller);
      },
    },
  ],
  [
    "password-reveal: toggle, its labels",
    {
      identifier: "stimeo--password-reveal",
      controller: PasswordRevealController,
      markup: host(
        "password-reveal",
        `<input type="password" aria-label="Password" data-stimeo--password-reveal-target="input">
         <button id="former" type="button" aria-pressed="false" aria-label="Show password" data-stimeo--password-reveal-target="toggle">
           <span data-stimeo--password-reveal-target="offLabel">Show</span>
           <span data-stimeo--password-reveal-target="onLabel">Hide</span>
         </button>`,
      ),
      target: "toggle",
      attributes: [],
      regions: "span",
    },
  ],
  [
    "skeleton: placeholder, the first, once ready",
    {
      identifier: "stimeo--skeleton",
      controller: SkeletonController,
      markup: `<div data-controller="stimeo--skeleton" aria-busy="true">
         <div id="former" aria-hidden="true" data-stimeo--skeleton-target="placeholder"></div>
         <div hidden data-stimeo--skeleton-target="content">Content</div>
       </div>`,
      target: "placeholder",
      attributes: ["hidden"],
      ahead: false,
      arrange: (controller) => (controller.ready as () => void).call(controller),
    },
  ],
  [
    "spinner: region, the first, once stopped",
    {
      identifier: "stimeo--spinner",
      controller: SpinnerController,
      markup: host(
        "spinner",
        `<div hidden data-stimeo--spinner-target="indicator">Loading</div>
         <div id="former" data-stimeo--spinner-target="region"></div>`,
        'data-stimeo--spinner-delay-value="0" data-stimeo--spinner-min-duration-value="0"',
      ),
      target: "region",
      attributes: ["aria-busy"],
      ahead: false,
      arrange: (controller) => {
        (controller.start as () => void).call(controller);
        (controller.stop as () => void).call(controller);
      },
    },
  ],
];

describeFormerFirst(cases);
