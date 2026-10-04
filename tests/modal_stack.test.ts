import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandPaletteController } from "../src/controllers/command_palette_controller";
import { ConfirmController } from "../src/controllers/confirm_controller";
import { DialogController } from "../src/controllers/dialog_controller";
import { byId } from "./helpers/dom";
import { typeKey } from "./helpers/keyboard";
import { TARGET_SWAPS } from "./helpers/modal_stack";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * A modal opened over another modal it is not nested in: the page's one confirm bridge
 * at the end of `<body>`, asked by Turbo from inside an open dialog, and the command
 * palette opened with its hotkey over that dialog. The upper modal's content is not
 * `inert` and takes focus and `Tab`; the dialog below is background until the upper
 * modal closes, and then operable again with its own background still `inert`.
 */

interface TurboStub {
  config: { forms: { confirm?: (message: string) => Promise<boolean> } };
}

const MARKUP = `
  <main>
    <section id="page">
      <button id="search">Search</button>
      <div data-controller="stimeo--dialog">
        <button id="edit-trigger" data-stimeo--dialog-target="trigger"
                data-action="stimeo--dialog#open">Edit item</button>
        <div id="edit-dialog" data-stimeo--dialog-target="dialog" role="dialog"
             aria-modal="true" aria-label="Edit item" hidden>
          <input id="edit-name" aria-label="Name" value="Item" />
          <button id="edit-delete">Delete item</button>
          <button id="edit-close" data-action="stimeo--dialog#close">Close</button>
        </div>
      </div>
    </section>
    <div data-controller="stimeo--command-palette">
      <div id="palette" data-stimeo--command-palette-target="dialog" role="dialog"
           aria-modal="true" aria-label="Command palette" hidden>
        <input id="palette-input" data-stimeo--command-palette-target="input" role="combobox"
               aria-expanded="false" aria-controls="palette-list" aria-autocomplete="list"
               aria-label="Search commands"
               data-action="input->stimeo--command-palette#filter
                            keydown->stimeo--command-palette#onKeydown" />
        <ul id="palette-list" role="listbox" aria-label="Commands"
            data-stimeo--command-palette-target="list">
          <li role="option" data-value="new" data-stimeo--command-palette-target="option">New</li>
        </ul>
        <button id="palette-help">Help</button>
      </div>
    </div>
  </main>
  <div data-controller="stimeo--confirm">
    <div id="confirm-dialog" data-stimeo--confirm-target="dialog" role="alertdialog"
         aria-modal="true" aria-label="Confirm" hidden>
      <p data-stimeo--confirm-target="message"></p>
      <button id="confirm-cancel" data-stimeo--confirm-target="cancel"
              data-action="click->stimeo--confirm#cancel">Cancel</button>
      <button id="confirm-ok" data-stimeo--confirm-target="confirm"
              data-action="click->stimeo--confirm#confirm">Delete</button>
    </div>
  </div>`;

describe("modal stack", () => {
  let application: Application;

  beforeEach(async () => {
    (window as unknown as { Turbo: TurboStub }).Turbo = { config: { forms: {} } };
    document.body.innerHTML = MARKUP;
    application = Application.start();
    application.register("stimeo--dialog", DialogController);
    application.register("stimeo--confirm", ConfirmController);
    application.register("stimeo--command-palette", CommandPaletteController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    document.body.style.overflow = "";
    (window as unknown as { Turbo?: TurboStub }).Turbo = undefined;
  });

  const inert = (id: string): boolean => byId(id).closest("[inert]") !== null;
  const press = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    (document.activeElement ?? document.body).dispatchEvent(event);
    return event;
  };
  const openDialog = (): void => {
    byId("edit-trigger").focus();
    byId("edit-trigger").click();
    expect(document.activeElement).toBe(byId("edit-name"));
  };
  const dialogController = (): DialogController =>
    application.getControllerForElementAndIdentifier(
      byId("edit-dialog").parentElement as HTMLElement,
      "stimeo--dialog",
    ) as DialogController;
  const openPalette = (): void => {
    press("k", { ctrlKey: true });
    if (byId("palette").hidden) press("k", { metaKey: true });
    expect(document.activeElement).toBe(byId("palette-input"));
  };
  const turboConfirm = (message: string): Promise<boolean> => {
    const confirm = (window as unknown as { Turbo: TurboStub }).Turbo.config.forms.confirm;
    if (!confirm) throw new Error("the confirm bridge did not install its hook");
    return confirm(message);
  };

  it("keeps a confirm Turbo opens from inside a dialog operable, and the dialog after it", async () => {
    openDialog();
    byId("edit-delete").focus();
    const answer = turboConfirm("Delete this item?");

    expect(byId("confirm-dialog").hidden).toBe(false);
    expect(inert("confirm-dialog")).toBe(false);
    expect(document.activeElement).toBe(byId("confirm-cancel"));
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId("confirm-ok"));
    expect(inert("edit-dialog")).toBe(true);

    press("Escape");
    await expect(answer).resolves.toBe(false);
    expect(document.activeElement).toBe(byId("edit-delete"));
    expect(inert("edit-dialog")).toBe(false);
    expect(inert("edit-trigger")).toBe(true);
    expect(inert("confirm-dialog")).toBe(true);
    press("Tab");
    expect(document.activeElement).toBe(byId("edit-close"));
  });

  it.each(TARGET_SWAPS)(
    "keeps a confirm Turbo opens from inside a dialog on top when the dialog is replaced %s",
    async (_, swap) => {
      openDialog();
      byId("edit-delete").focus();
      const answer = turboConfirm("Delete this item?");
      const successor = byId("edit-dialog").cloneNode(true) as HTMLElement;
      for (const node of [successor, ...Array.from(successor.querySelectorAll("[id]"))]) {
        node.id = `next-${node.id}`;
      }
      successor.hidden = true;
      await swap(byId("edit-dialog"), successor);

      expect(inert("confirm-dialog")).toBe(false);
      expect(document.activeElement).toBe(byId("confirm-cancel"));
      expect(press("Tab").defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(byId("confirm-ok"));
      expect(inert("next-edit-dialog")).toBe(true);

      press("Escape");
      await expect(answer).resolves.toBe(false);
      expect(document.activeElement).toBe(byId("next-edit-name"));
      expect(successor.hidden).toBe(false);
      expect(inert("next-edit-dialog")).toBe(false);
      expect(inert("edit-trigger")).toBe(true);
      typeKey(document, "Escape");
      expect(successor.hidden).toBe(true);
      expect(document.activeElement).toBe(byId("edit-trigger"));
    },
  );

  it("keeps the command palette opened over a dialog operable, and the dialog after it", () => {
    openDialog();
    press("k", { ctrlKey: true });
    if (byId("palette").hidden) press("k", { metaKey: true });

    expect(byId("palette").hidden).toBe(false);
    expect(inert("palette")).toBe(false);
    expect(document.activeElement).toBe(byId("palette-input"));
    press("Tab");
    expect(document.activeElement).toBe(byId("palette-help"));
    expect(inert("edit-dialog")).toBe(true);

    press("Escape");
    expect(byId("palette").hidden).toBe(true);
    expect(document.activeElement).toBe(byId("edit-name"));
    expect(inert("edit-dialog")).toBe(false);
    expect(inert("edit-trigger")).toBe(true);
  });

  it("keeps the upper modal isolated when the dialog below closes first", () => {
    openDialog();
    press("k", { ctrlKey: true });
    if (byId("palette").hidden) press("k", { metaKey: true });
    expect(document.activeElement).toBe(byId("palette-input"));

    const dialog = application.getControllerForElementAndIdentifier(
      byId("edit-dialog").parentElement as HTMLElement,
      "stimeo--dialog",
    ) as DialogController;
    dialog.close();

    expect(byId("edit-dialog").hidden).toBe(true);
    expect(inert("palette")).toBe(false);
    expect(inert("edit-trigger")).toBe(true);
    expect(inert("confirm-dialog")).toBe(true);
    byId("palette-input").focus();
    press("Tab");
    expect(document.activeElement).toBe(byId("palette-help"));

    press("Escape");
    expect(document.querySelectorAll("[inert]").length).toBe(0);
  });

  it("returns focus from the command palette to the dialog's opener when the dialog below closed first", () => {
    openDialog();
    openPalette();

    dialogController().close();
    expect(document.activeElement).toBe(byId("palette-input"));

    press("Escape");
    expect(byId("palette").hidden).toBe(true);
    expect(document.activeElement).toBe(byId("edit-trigger"));
  });

  it("returns focus from a dialog a palette command opened to the dialog's trigger, past the closed palette", () => {
    document.addEventListener("stimeo--command-palette:select", () => dialogController().open(), {
      once: true,
    });
    byId("search").focus();
    openPalette();

    press("Enter");
    expect(byId("palette").hidden).toBe(true);
    expect(byId("edit-dialog").hidden).toBe(false);
    expect(document.activeElement).toBe(byId("edit-name"));

    typeKey(document, "Escape");
    expect(byId("edit-dialog").hidden).toBe(true);
    expect(document.activeElement).toBe(byId("edit-trigger"));
  });
});
