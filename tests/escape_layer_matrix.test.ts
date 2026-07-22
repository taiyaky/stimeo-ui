import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { ContextMenuController } from "../src/controllers/context_menu_controller";
import { DialogController } from "../src/controllers/dialog_controller";
import { DropdownController } from "../src/controllers/dropdown_controller";
import { HoverCardController } from "../src/controllers/hover_card_controller";
import { MenuController } from "../src/controllers/menu_controller";
import { MenubarController } from "../src/controllers/menubar_controller";
import { NavigationMenuController } from "../src/controllers/navigation_menu_controller";
import { PopoverController } from "../src/controllers/popover_controller";
import { TooltipController } from "../src/controllers/tooltip_controller";
import { byId } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Table-driven pair matrix for the layered-Escape contract: for every
 * (outer, inner) overlay-kind pair, an inner layer opened from within an open
 * outer layer must close on the first press (it activated last) and the outer
 * on the second — one layer per press, newest first.
 *
 * The point of the table is coverage of the *pairs nobody thought to write by
 * hand*: the historical Escape regressions were each a pair-wise hole
 * (tooltip-in-dropdown, modal-in-dropdown, …) that the per-scenario suites
 * missed. Adding an overlay kind here extends the sweep automatically.
 */

/** One overlay kind the matrix can compose. */
interface LayerKind {
  kind: string;
  register: (app: Application) => void;
  /** Whether this kind can wrap arbitrary overlay content (usable as outer). */
  container: boolean;
  /** Markup with `${p}-overlay` as the overlay region; `slot` is injected inside it. */
  markup: (p: string, slot: string) => string;
  /** Opens the layer; for an inner layer this runs with the outer already open. */
  open: (p: string) => void;
  isOpen: (p: string) => boolean;
}

/** Focuses then clicks, mirroring a real pointer/keyboard activation order. */
const focusClick = (id: string): void => {
  byId(id).focus();
  byId(id).click();
};

const KINDS: LayerKind[] = [
  {
    kind: "dialog",
    container: true,
    register: (app) => app.register("stimeo--dialog", DialogController),
    markup: (p, slot) => `
      <div data-controller="stimeo--dialog">
        <button id="${p}-trigger" data-stimeo--dialog-target="trigger"
                data-action="stimeo--dialog#open">Open</button>
        <div id="${p}-overlay" data-stimeo--dialog-target="dialog" role="dialog"
             aria-modal="true" aria-label="Dialog" hidden>
          <button id="${p}-inside">Control</button>
          ${slot}
        </div>
      </div>`,
    open: (p) => focusClick(`${p}-trigger`),
    isOpen: (p) => !byId(`${p}-overlay`).hidden,
  },
  {
    kind: "dropdown",
    container: true,
    register: (app) => app.register("stimeo--dropdown", DropdownController),
    markup: (p, slot) => `
      <div data-controller="stimeo--dropdown">
        <button id="${p}-trigger" data-stimeo--dropdown-target="trigger"
                data-action="stimeo--dropdown#toggle">Menu</button>
        <div id="${p}-overlay" data-stimeo--dropdown-target="menu" hidden>
          <button id="${p}-inside">Item</button>
          ${slot}
        </div>
      </div>`,
    open: (p) => focusClick(`${p}-trigger`),
    isOpen: (p) => !byId(`${p}-overlay`).hidden,
  },
  {
    kind: "popover",
    container: true,
    register: (app) => app.register("stimeo--popover", PopoverController),
    markup: (p, slot) => `
      <div data-controller="stimeo--popover">
        <button id="${p}-trigger" data-stimeo--popover-target="trigger"
                aria-haspopup="dialog" aria-expanded="false" aria-controls="${p}-overlay"
                data-action="click->stimeo--popover#toggle">Edit</button>
        <div id="${p}-overlay" data-stimeo--popover-target="panel" role="dialog"
             aria-label="Edit" hidden>
          <button id="${p}-inside">Control</button>
          ${slot}
        </div>
      </div>`,
    open: (p) => focusClick(`${p}-trigger`),
    isOpen: (p) => !byId(`${p}-overlay`).hidden,
  },
  {
    kind: "menu",
    container: true,
    register: (app) => app.register("stimeo--menu", MenuController),
    markup: (p, slot) => `
      <div data-controller="stimeo--menu">
        <button id="${p}-trigger" data-stimeo--menu-target="trigger"
                data-action="click->stimeo--menu#toggle keydown->stimeo--menu#onTriggerKeydown"
                aria-haspopup="menu" aria-expanded="false" aria-controls="${p}-overlay">Actions</button>
        <ul id="${p}-overlay" role="menu" aria-labelledby="${p}-trigger"
            data-stimeo--menu-target="menu" hidden>
          <li role="none">
            <button id="${p}-inside" role="menuitem" tabindex="-1"
                    data-stimeo--menu-target="item"
                    data-action="click->stimeo--menu#activate
                                 keydown->stimeo--menu#onItemKeydown">Rename</button>
          </li>
          <li role="none">${slot}</li>
        </ul>
      </div>`,
    open: (p) => focusClick(`${p}-trigger`),
    isOpen: (p) => !byId(`${p}-overlay`).hidden,
  },
  {
    kind: "navigation-menu",
    container: true,
    register: (app) => app.register("stimeo--navigation-menu", NavigationMenuController),
    markup: (p, slot) => `
      <nav data-controller="stimeo--navigation-menu" aria-label="Main">
        <ul>
          <li>
            <button id="${p}-trigger" data-stimeo--navigation-menu-target="trigger"
                    aria-expanded="false" aria-controls="${p}-overlay"
                    data-action="click->stimeo--navigation-menu#toggle">Products</button>
            <div id="${p}-overlay" data-stimeo--navigation-menu-target="panel" hidden>
              <a id="${p}-inside" href="/a">Product A</a>
              ${slot}
            </div>
          </li>
        </ul>
      </nav>`,
    open: (p) => focusClick(`${p}-trigger`),
    isOpen: (p) => !byId(`${p}-overlay`).hidden,
  },
  {
    kind: "menubar",
    container: true,
    register: (app) => app.register("stimeo--menubar", MenubarController),
    markup: (p, slot) => `
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        <button id="${p}-trigger" role="menuitem" aria-haspopup="menu" aria-expanded="false"
                aria-controls="${p}-overlay" data-stimeo--menubar-target="top"
                data-action="click->stimeo--menubar#toggle
                             keydown->stimeo--menubar#onTopKeydown">File</button>
        <ul id="${p}-overlay" role="menu" aria-label="File" hidden
            data-stimeo--menubar-target="menu">
          <li role="none">
            <button id="${p}-inside" role="menuitem" tabindex="-1"
                    data-stimeo--menubar-target="item"
                    data-action="click->stimeo--menubar#activate
                                 keydown->stimeo--menubar#onItemKeydown">New</button>
          </li>
          <li role="none">${slot}</li>
        </ul>
      </div>`,
    open: (p) => focusClick(`${p}-trigger`),
    isOpen: (p) => !byId(`${p}-overlay`).hidden,
  },
  {
    kind: "context-menu",
    container: true,
    register: (app) => app.register("stimeo--context-menu", ContextMenuController),
    markup: (p, slot) => `
      <div data-controller="stimeo--context-menu">
        <div id="${p}-trigger" data-stimeo--context-menu-target="region" tabindex="0"
             aria-haspopup="menu" aria-controls="${p}-overlay"
             data-action="contextmenu->stimeo--context-menu#open
                          keydown->stimeo--context-menu#onRegionKeydown">Area</div>
        <ul id="${p}-overlay" role="menu" data-stimeo--context-menu-target="menu" hidden>
          <li role="none">
            <button id="${p}-inside" role="menuitem" tabindex="-1"
                    data-stimeo--context-menu-target="item"
                    data-action="click->stimeo--context-menu#activate
                                 keydown->stimeo--context-menu#onItemKeydown">Copy</button>
          </li>
          <li role="none">${slot}</li>
        </ul>
      </div>`,
    // Pointer invocation: a real right-click dispatches `contextmenu` at the
    // pointer position; the controller consumes it and focuses the first item.
    open: (p) =>
      byId(`${p}-trigger`).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 8, clientY: 8 }),
      ),
    isOpen: (p) => !byId(`${p}-overlay`).hidden,
  },
  {
    kind: "tooltip",
    container: false,
    register: (app) => app.register("stimeo--tooltip", TooltipController),
    markup: (p) => `
      <span data-controller="stimeo--tooltip">
        <button id="${p}-trigger" data-stimeo--tooltip-target="trigger" aria-describedby="${p}-overlay"
                data-action="mouseenter->stimeo--tooltip#show">Help</button>
        <span id="${p}-overlay" role="tooltip" data-stimeo--tooltip-target="content" hidden>Hint</span>
      </span>`,
    // Hover-shown: focus stays wherever the outer layer put it, which is the
    // historically regression-prone shape (a stale focus under a newer layer).
    open: (p) =>
      byId(`${p}-trigger`).dispatchEvent(new MouseEvent("mouseenter", { bubbles: true })),
    isOpen: (p) => !byId(`${p}-overlay`).hidden,
  },
  {
    kind: "hover-card",
    container: false,
    register: (app) => app.register("stimeo--hover-card", HoverCardController),
    markup: (p) => `
      <span data-controller="stimeo--hover-card" data-stimeo--hover-card-open-delay-value="0">
        <a id="${p}-trigger" href="/u" data-stimeo--hover-card-target="trigger"
           aria-expanded="false" aria-controls="${p}-overlay"
           data-action="mouseenter->stimeo--hover-card#open mouseleave->stimeo--hover-card#close">@user</a>
        <div id="${p}-overlay" data-stimeo--hover-card-target="card" hidden>Profile</div>
      </span>`,
    open: (p) => byId(`${p}-trigger`).dispatchEvent(new Event("mouseenter")),
    isOpen: (p) => !byId(`${p}-overlay`).hidden,
  },
];

describe("Escape layer pair matrix (inner closes first, outer second)", () => {
  let application: Application | undefined;

  afterEach(() => {
    // A test failing before Application.start() must not cascade a second
    // exception out of teardown (masking the real cause), so guard the stop —
    // and clear the reference even when the stop itself throws, or the next
    // test's teardown would re-throw against the same dead application.
    try {
      if (application) disconnectAndStopApplication(application);
    } finally {
      application = undefined;
      document.body.innerHTML = "";
      document.body.style.overflow = "";
    }
  });

  const pressEscape = (): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    (document.activeElement ?? document).dispatchEvent(event);
    return event;
  };

  const outers = KINDS.filter((kind) => kind.container);

  for (const outer of outers) {
    for (const inner of KINDS) {
      it(`closes ${inner.kind} nested in ${outer.kind} first, ${outer.kind} second`, async () => {
        document.body.innerHTML = outer.markup("out", inner.markup("in", ""));
        application = Application.start();
        outer.register(application);
        if (inner.kind !== outer.kind) inner.register(application);
        await tick();

        outer.open("out");
        expect(outer.isOpen("out")).toBe(true);
        inner.open("in");
        expect(inner.isOpen("in")).toBe(true);

        const first = pressEscape();
        expect(first.defaultPrevented).toBe(true);
        expect(inner.isOpen("in")).toBe(false);
        expect(outer.isOpen("out")).toBe(true);

        const second = pressEscape();
        expect(second.defaultPrevented).toBe(true);
        expect(outer.isOpen("out")).toBe(false);
      });
    }
  }
});
