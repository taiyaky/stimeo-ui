import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertDialogController } from "../../src/controllers/alert_dialog_controller";
import { CommandPaletteController } from "../../src/controllers/command_palette_controller";
import { ConfirmController } from "../../src/controllers/confirm_controller";
import { DialogController } from "../../src/controllers/dialog_controller";
import { DrawerController } from "../../src/controllers/drawer_controller";
import { FocusController } from "../../src/controllers/focus_controller";
import { SidebarController } from "../../src/controllers/sidebar_controller";
import { byId } from "./dom";
import { disconnectAndStopApplication } from "./stimulus";
import { tick } from "./timing";

/**
 * The containers × inner-widgets table for the focus trap's Tab handling.
 *
 * Each container here is a controller that builds a focus trap. It wraps an inner
 * widget between two stops, `${p}-first` and `${p}-next`, inside the element the trap
 * holds. An inner widget handles `Tab` itself (it closes its popup, sometimes a task
 * later) and leaves the key unconsumed; the trap then moves focus. The table pins that
 * the two compose: one press closes the inner widget, moves focus exactly once to the
 * stop after it, and is consumed.
 */

/** A controller that holds a focus trap while it is open. */
export interface TrapContainer {
  kind: string;
  register: (app: Application) => void;
  /** Markup whose trapped element holds `${p}-first`, `slot`, `${p}-next` in that order. */
  markup: (p: string, slot: string) => string;
  /** Activates the trap. */
  open: (p: string) => void;
  /** Runs before the controllers connect. */
  prepare?: () => void;
}

/** A widget that handles `Tab` itself while it is open. */
export interface TabInner {
  kind: string;
  register: (app: Application) => void;
  markup: (p: string) => string;
  /** Opens the widget and leaves focus where a person would press `Tab`. */
  open: (p: string) => void;
  isOpen: (p: string) => boolean;
}

/** Focuses then clicks, the order a real activation produces. */
export const focusClick = (id: string): void => {
  byId(id).focus();
  byId(id).click();
};

/** A `matchMedia` whose every query reports `false`: the sidebar's overlay width. */
const stubNarrowViewport = (): void => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
};

const stops = (p: string, slot: string): string => `
  <button type="button" id="${p}-first">First</button>
  ${slot}
  <button type="button" id="${p}-next">Next</button>`;

export const TRAP_CONTAINERS: TrapContainer[] = [
  {
    kind: "dialog",
    register: (app) => app.register("stimeo--dialog", DialogController),
    markup: (p, slot) => `
      <div data-controller="stimeo--dialog">
        <button type="button" id="${p}-trigger" data-stimeo--dialog-target="trigger"
                data-action="stimeo--dialog#open">Open</button>
        <div id="${p}-trap" data-stimeo--dialog-target="dialog" role="dialog"
             aria-modal="true" aria-label="Dialog" hidden>${stops(p, slot)}</div>
      </div>`,
    open: (p) => focusClick(`${p}-trigger`),
  },
  {
    kind: "alert-dialog",
    register: (app) => app.register("stimeo--alert-dialog", AlertDialogController),
    markup: (p, slot) => `
      <div data-controller="stimeo--alert-dialog">
        <button type="button" id="${p}-trigger" data-stimeo--alert-dialog-target="trigger"
                data-action="stimeo--alert-dialog#open">Delete</button>
        <div id="${p}-trap" data-stimeo--alert-dialog-target="dialog" role="alertdialog"
             aria-modal="true" aria-label="Delete" hidden>${stops(p, slot)}</div>
      </div>`,
    open: (p) => focusClick(`${p}-trigger`),
  },
  {
    kind: "confirm",
    register: (app) => app.register("stimeo--confirm", ConfirmController),
    markup: (p, slot) => `
      <div data-controller="stimeo--confirm">
        <button type="button" id="${p}-trigger" data-turbo-confirm="Sure?"
                data-action="click->stimeo--confirm#request">Delete</button>
        <div id="${p}-trap" data-stimeo--confirm-target="dialog" role="alertdialog"
             aria-modal="true" aria-label="Confirm" hidden>
          <p data-stimeo--confirm-target="message"></p>
          <button type="button" id="${p}-first" data-stimeo--confirm-target="cancel"
                  data-action="click->stimeo--confirm#cancel">Cancel</button>
          ${slot}
          <button type="button" id="${p}-next" data-stimeo--confirm-target="confirm"
                  data-action="click->stimeo--confirm#confirm">OK</button>
        </div>
      </div>`,
    open: (p) => focusClick(`${p}-trigger`),
  },
  {
    kind: "drawer",
    register: (app) => app.register("stimeo--drawer", DrawerController),
    markup: (p, slot) => `
      <div data-controller="stimeo--drawer">
        <button type="button" id="${p}-trigger" data-stimeo--drawer-target="trigger"
                data-action="stimeo--drawer#open">Open</button>
        <div data-stimeo--drawer-target="overlay">
          <div id="${p}-trap" data-stimeo--drawer-target="panel" role="dialog"
               aria-modal="true" aria-label="Drawer" data-state="closed" hidden>${stops(p, slot)}</div>
        </div>
      </div>`,
    open: (p) => focusClick(`${p}-trigger`),
  },
  {
    kind: "sidebar",
    register: (app) => app.register("stimeo--sidebar", SidebarController),
    prepare: stubNarrowViewport,
    markup: (p, slot) => `
      <div data-controller="stimeo--sidebar" data-stimeo--sidebar-breakpoint-value="768">
        <button type="button" id="${p}-trigger" data-stimeo--sidebar-target="trigger"
                data-action="click->stimeo--sidebar#toggle"
                aria-expanded="true" aria-controls="${p}-trap">Menu</button>
        <div data-stimeo--sidebar-target="backdrop" hidden></div>
        <aside id="${p}-trap" data-stimeo--sidebar-target="panel" aria-label="Sidebar"
               data-mode="inline" data-state="expanded">${stops(p, slot)}</aside>
      </div>`,
    open: (p) => focusClick(`${p}-trigger`),
  },
  {
    kind: "command-palette",
    register: (app) => app.register("stimeo--command-palette", CommandPaletteController),
    markup: (p, slot) => `
      <div data-controller="stimeo--command-palette">
        <button type="button" id="${p}-trigger"
                data-action="click->stimeo--command-palette#open">Commands</button>
        <div id="${p}-trap" data-stimeo--command-palette-target="dialog" role="dialog"
             aria-modal="true" aria-label="Command palette" hidden>
          <input id="${p}-first" data-stimeo--command-palette-target="input" role="combobox"
                 aria-expanded="false" aria-controls="${p}-commands" aria-autocomplete="list"
                 aria-label="Search commands"
                 data-action="input->stimeo--command-palette#filter
                              keydown->stimeo--command-palette#onKeydown" />
          <ul id="${p}-commands" data-stimeo--command-palette-target="list" role="listbox"
              aria-label="Commands">
            <li role="option" data-value="new" data-stimeo--command-palette-target="option">New</li>
          </ul>
          ${slot}
          <button type="button" id="${p}-next">Next</button>
        </div>
      </div>`,
    open: (p) => focusClick(`${p}-trigger`),
  },
  {
    kind: "focus",
    register: (app) => app.register("stimeo--focus", FocusController),
    // The trap turns on when the controller connects with `trap` set.
    markup: (p, slot) => `
      <div id="${p}-trap" data-controller="stimeo--focus"
           data-stimeo--focus-trap-value="true">${stops(p, slot)}</div>`,
    open: () => {},
  },
];

/**
 * Defines one case per (container, inner) pair: with the inner widget open inside an
 * open container, `Tab` closes the widget, moves focus once to `${p}-next`, and is
 * consumed; the widget's own close, a task later for some, leaves focus there.
 */
export function describeTrapTabMatrix(title: string, inners: TabInner[]): void {
  describe(title, () => {
    let application: Application | undefined;

    afterEach(() => {
      try {
        if (application) disconnectAndStopApplication(application);
      } finally {
        application = undefined;
        vi.unstubAllGlobals();
        document.body.innerHTML = "";
        document.body.style.overflow = "";
      }
    });

    for (const container of TRAP_CONTAINERS) {
      for (const inner of inners) {
        it(`moves on once from ${inner.kind} inside ${container.kind}`, async () => {
          container.prepare?.();
          document.body.innerHTML = `
            <button type="button" id="outside">Outside</button>
            ${container.markup("out", inner.markup("in"))}`;
          application = Application.start();
          container.register(application);
          inner.register(application);
          await tick();

          container.open("out");
          expect(byId("out-trap").contains(document.activeElement)).toBe(true);
          inner.open("in");
          expect(inner.isOpen("in")).toBe(true);

          let moves = 0;
          const counting = new AbortController();
          document.addEventListener("focusin", () => moves++, { signal: counting.signal });
          const press = new KeyboardEvent("keydown", {
            key: "Tab",
            bubbles: true,
            cancelable: true,
          });
          (document.activeElement ?? document.body).dispatchEvent(press);

          expect(press.defaultPrevented).toBe(true);
          expect(document.activeElement).toBe(byId("out-next"));
          await tick();
          expect(inner.isOpen("in")).toBe(false);
          expect(document.activeElement).toBe(byId("out-next"));
          counting.abort();
          expect(moves).toBe(1);
        });
      }
    }
  });
}
