import { Application } from "@hotwired/stimulus";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DialogController } from "../src/controllers/dialog_controller";
import { DrawerController } from "../src/controllers/drawer_controller";
import { byId } from "./helpers/dom";
import { separateCopy } from "./helpers/separate_copy";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { delay, tick } from "./helpers/timing";

/**
 * A dialog inside an open drawer, the two controllers imported together, as the barrel brings
 * them, and from their own entries, each of which runs its own copy of the focus trap and the
 * Escape resolver. Either way one Escape closes the dialog alone, `Tab` stays inside the
 * dialog, the drawer's content is background while the dialog is open, and the page behind
 * the drawer stays background until the drawer closes too.
 */
interface Pair {
  readonly Drawer: typeof DrawerController;
  readonly Dialog: typeof DialogController;
}

const SOURCES: ReadonlyArray<readonly [string, () => Promise<Pair>]> = [
  ["imported together", async () => ({ Drawer: DrawerController, Dialog: DialogController })],
  [
    "imported from their own entries",
    async () => {
      const drawer = await separateCopy(() => import("../src/controllers/drawer_controller"));
      const dialog = await separateCopy(() => import("../src/controllers/dialog_controller"));
      return { Drawer: drawer.DrawerController, Dialog: dialog.DialogController };
    },
  ],
];

const MARKUP = `
  <p id="page">Page</p>
  <div data-controller="stimeo--drawer">
    <button type="button" id="drawer-trigger" data-stimeo--drawer-target="trigger"
            data-action="stimeo--drawer#open">Open panel</button>
    <div id="drawer-overlay" data-stimeo--drawer-target="overlay" hidden>
      <div id="drawer-panel" data-stimeo--drawer-target="panel" role="dialog" aria-modal="true"
           aria-label="Settings" data-state="closed" hidden>
        <button type="button" id="drawer-first">Save</button>
        <div data-controller="stimeo--dialog">
          <button type="button" id="dialog-trigger" data-stimeo--dialog-target="trigger"
                  data-action="click->stimeo--dialog#open">Open dialog</button>
          <div id="dialog" role="dialog" aria-modal="true" aria-label="Confirm"
               data-stimeo--dialog-target="dialog" hidden>
            <button type="button" id="dialog-first">Keep</button>
            <button type="button" id="dialog-last" data-action="click->stimeo--dialog#close">Close dialog</button>
          </div>
        </div>
      </div>
    </div>
  </div>`;

describe.each(SOURCES)("a dialog inside an open drawer, %s", (_, load) => {
  let application: Application;
  let pair: Pair;

  beforeAll(async () => {
    pair = await load();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    document.body.removeAttribute("style");
  });

  /** Lets the controllers act and the transitions they wait for settle. */
  const settle = async () => {
    await tick();
    await delay(30);
  };
  const press = async (key: string) => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
    await settle();
  };
  const openBoth = async () => {
    document.body.innerHTML = MARKUP;
    application = Application.start();
    application.register("stimeo--drawer", pair.Drawer);
    application.register("stimeo--dialog", pair.Dialog);
    await tick();
    byId("drawer-trigger").click();
    await settle();
    byId("dialog-trigger").click();
    await settle();
    expect(byId("dialog").hidden).toBe(false);
  };

  it("closes the dialog alone on one Escape, and the drawer on the next", async () => {
    await openBoth();

    await press("Escape");
    expect([byId("dialog").hidden, byId("drawer-panel").getAttribute("data-state")]).toEqual([
      true,
      "open",
    ]);
    expect([byId("drawer-first").closest("[inert]"), byId("page").inert]).toEqual([null, true]);
    await press("Escape");

    expect(byId("drawer-panel").getAttribute("data-state")).toBe("closed");
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    expect(document.body.style.overflow).toBe("");
  });

  it("keeps Tab inside the dialog and the drawer's content background while it is open", async () => {
    await openBoth();
    byId("dialog-last").focus();

    await press("Tab");

    expect(document.activeElement?.id).toBe("dialog-first");
    expect([byId("dialog").closest("[inert]"), byId("drawer-first").inert]).toEqual([null, true]);
    expect(document.body.style.overflow).toBe("hidden");
  });
});
