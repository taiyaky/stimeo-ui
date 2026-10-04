import { Application, type ControllerConstructor } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertDialogController } from "../src/controllers/alert_dialog_controller";
import { CommandPaletteController } from "../src/controllers/command_palette_controller";
import { ConfirmController } from "../src/controllers/confirm_controller";
import { DialogController } from "../src/controllers/dialog_controller";
import { DrawerController } from "../src/controllers/drawer_controller";
import { FocusController } from "../src/controllers/focus_controller";
import { SidebarController } from "../src/controllers/sidebar_controller";
import { FocusTrap } from "../src/utils/focus_trap";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Every controller that holds a {@link FocusTrap} hands it its lifecycle: `connect()` calls the
 * trap's `connect()`, and `disconnect()` calls the trap's `disconnect()` with the controller,
 * whose element and identifier tell an in-page move from a detach. What the trap does with
 * them is covered by its own suite.
 */
describe("FocusTrap consumers", () => {
  let application: Application | null = null;

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = null;
    document.body.innerHTML = "";
    document.body.style.overflow = "";
    vi.restoreAllMocks();
  });

  const consumers: ReadonlyArray<readonly [string, ControllerConstructor, string]> = [
    [
      "stimeo--dialog",
      DialogController,
      '<div data-stimeo--dialog-target="dialog" hidden><button>Close</button></div>',
    ],
    [
      "stimeo--alert-dialog",
      AlertDialogController,
      '<div data-stimeo--alert-dialog-target="dialog" hidden><button>OK</button></div>',
    ],
    [
      "stimeo--confirm",
      ConfirmController,
      '<div data-stimeo--confirm-target="dialog" hidden><button>OK</button></div>',
    ],
    [
      "stimeo--drawer",
      DrawerController,
      '<div data-stimeo--drawer-target="panel" hidden><button>Close</button></div>',
    ],
    [
      "stimeo--command-palette",
      CommandPaletteController,
      '<div data-stimeo--command-palette-target="dialog" hidden><input aria-label="Search" data-stimeo--command-palette-target="input"></div>',
    ],
    [
      "stimeo--sidebar",
      SidebarController,
      '<aside data-stimeo--sidebar-target="panel" aria-label="Main"><a href="#a">A</a></aside>',
    ],
    ["stimeo--focus", FocusController, "<button>Inside</button>"],
  ];

  it.each(consumers)(
    "%s hands its trap its connect and, with itself as the host, its disconnect",
    async (identifier, controllerClass, inner) => {
      const connect = vi.spyOn(FocusTrap.prototype, "connect");
      const disconnect = vi.spyOn(FocusTrap.prototype, "disconnect");
      document.body.innerHTML = `<div id="root" data-controller="${identifier}">${inner}</div>`;
      application = Application.start();
      application.register(identifier, controllerClass);
      await tick();
      const root = document.getElementById("root") as HTMLElement;
      const controller = application.getControllerForElementAndIdentifier(root, identifier);
      expect(controller).not.toBeNull();
      expect(connect).toHaveBeenCalledTimes(1);
      expect(disconnect).not.toHaveBeenCalled();

      document.body.append(document.createElement("hr"), root);
      await tick();

      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalledWith(controller);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(application.getControllerForElementAndIdentifier(root, identifier)).toBe(controller);
    },
  );
});
