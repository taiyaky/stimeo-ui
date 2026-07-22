import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { ComboboxController } from "../src/controllers/combobox_controller";
import { DialogController } from "../src/controllers/dialog_controller";
import { DismissibleController } from "../src/controllers/dismissible_controller";
import { DropdownController } from "../src/controllers/dropdown_controller";
import { HoverCardController } from "../src/controllers/hover_card_controller";
import { MenuController } from "../src/controllers/menu_controller";
import { PopoverController } from "../src/controllers/popover_controller";
import { TooltipController } from "../src/controllers/tooltip_controller";
import { byId } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Integration tests for the **layered-Escape contract** shared by every Escape
 * consumer: a handler ignores
 * an Escape that is already `defaultPrevented`, and the handler that owns the
 * press calls `preventDefault()`. Focus-local handlers use DOM bubbling for inner
 * priority; document-level layers use activation order.
 *
 * Unit suites prove each controller's contract in isolation; these tests prove
 * the controllers *compose* — nesting, simultaneous display, differing listener
 * registration order, and re-registration after a simulated Turbo reconnect all
 * resolve to "one keypress closes exactly one layer".
 */
describe("Escape layering across controllers", () => {
  let application: Application;

  const start = async (markup: string, register: (app: Application) => void) => {
    document.body.innerHTML = markup;
    application = Application.start();
    register(application);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  /** Dispatches a cancelable Escape keydown from `origin`, like a real keypress. */
  const pressEscape = (origin: EventTarget = document): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    origin.dispatchEvent(event);
    return event;
  };

  it("lets an element-level inner layer own the press over an outer popover", async () => {
    await start(
      `
      <div data-controller="stimeo--popover">
        <button id="pop-trigger" data-stimeo--popover-target="trigger"
                aria-haspopup="dialog" aria-expanded="false" aria-controls="pop"
                data-action="click->stimeo--popover#toggle">Edit</button>
        <div id="pop" data-stimeo--popover-target="panel" role="dialog" aria-label="Edit" hidden>
          <div data-controller="stimeo--dismissible"
               data-stimeo--dismissible-mode-value="hide"
               data-stimeo--dismissible-close-on-escape-value="true">
            <div id="note" data-stimeo--dismissible-target="root">
              <button id="note-close" type="button" aria-label="Close"
                      data-action="stimeo--dismissible#dismiss">×</button>
            </div>
          </div>
        </div>
      </div>`,
      (app) => {
        app.register("stimeo--popover", PopoverController);
        app.register("stimeo--dismissible", DismissibleController);
      },
    );

    byId("pop-trigger").click();
    byId("note-close").focus();

    // The dismissible handler runs first on the inner element and consumes the
    // press before it bubbles to the popover root.
    const event = pressEscape(byId("note-close"));

    expect(event.defaultPrevented).toBe(true);
    expect(byId("note").hidden).toBe(true);
    expect(byId("pop").hidden).toBe(false);
    expect(byId("pop-trigger").getAttribute("aria-expanded")).toBe("true");

    // The next press is unowned, so the popover (focus still inside) takes it.
    pressEscape(byId("note-close"));
    expect(byId("pop").hidden).toBe(true);
  });

  it("lets a nested popover own the press over its containing dropdown", async () => {
    await start(
      `
      <div data-controller="stimeo--dropdown">
        <button id="dd-trigger" data-stimeo--dropdown-target="trigger"
                data-action="stimeo--dropdown#toggle">Menu</button>
        <div id="dd-menu" data-stimeo--dropdown-target="menu" hidden>
          <div data-controller="stimeo--popover">
            <button id="pop-trigger" data-stimeo--popover-target="trigger"
                    data-action="stimeo--popover#toggle">More</button>
            <div id="pop" data-stimeo--popover-target="panel" hidden>
              <button id="pop-action">Action</button>
            </div>
          </div>
        </div>
      </div>`,
      (app) => {
        app.register("stimeo--dropdown", DropdownController);
        app.register("stimeo--popover", PopoverController);
      },
    );

    byId("dd-trigger").click();
    byId("pop-trigger").click();
    const event = pressEscape(byId("pop-action"));

    expect(event.defaultPrevented).toBe(true);
    expect(byId("pop").hidden).toBe(true);
    expect(byId("dd-menu").hidden).toBe(false);
    expect(document.activeElement).toBe(byId("pop-trigger"));
  });

  it("lets a modal trap own the press while a background dropdown stays open", async () => {
    await start(
      `
      <div id="dd-root" data-controller="stimeo--dropdown">
        <button id="dd-trigger" data-stimeo--dropdown-target="trigger"
                data-action="stimeo--dropdown#toggle">Menu</button>
        <div id="dd-menu" data-stimeo--dropdown-target="menu"><a id="dd-link" href="#">Item</a></div>
      </div>
      <div data-controller="stimeo--dialog">
        <button id="dlg-trigger" data-stimeo--dialog-target="trigger"
                data-action="stimeo--dialog#open">Open</button>
        <div id="dlg" data-stimeo--dialog-target="dialog" role="dialog" aria-modal="true"
             aria-labelledby="dlg-title" hidden>
          <h2 id="dlg-title">Confirm</h2>
          <button id="dlg-ok">OK</button>
        </div>
      </div>`,
      (app) => {
        app.register("stimeo--dropdown", DropdownController);
        app.register("stimeo--dialog", DialogController);
      },
    );

    // The dropdown opens through its action (not a click, which would close it as
    // an outside click) after the dialog, mirroring a menu left open behind a
    // modal. Its local Escape listener is outside the event path while focus is
    // in the dialog.
    byId("dlg-trigger").focus();
    byId("dlg-trigger").click();
    expect(byId("dlg").hidden).toBe(false);

    const dropdown = application.getControllerForElementAndIdentifier(
      byId("dd-root"),
      "stimeo--dropdown",
    ) as DropdownController;
    dropdown.open();
    expect(byId("dd-menu").hidden).toBe(false);

    byId("dlg-ok").focus();
    const event = pressEscape(document.activeElement ?? document);

    // The modal closes; the background dropdown neither closes nor yanks focus.
    expect(event.defaultPrevented).toBe(true);
    expect(byId("dlg").hidden).toBe(true);
    expect(byId("dd-menu").hidden).toBe(false);
    expect(document.activeElement).toBe(byId("dlg-trigger"));
  });

  it("dismisses a hover tooltip before its containing dialog", async () => {
    await start(
      `
      <div data-controller="stimeo--dialog">
        <button id="dlg-trigger" data-stimeo--dialog-target="trigger"
                data-action="stimeo--dialog#open">Open</button>
        <div id="dlg" data-stimeo--dialog-target="dialog" role="dialog"
             aria-modal="true" aria-label="Dialog" hidden>
          <button id="dlg-focus">Focused control</button>
          <span data-controller="stimeo--tooltip">
            <button id="tip-trigger" data-stimeo--tooltip-target="trigger"
                    aria-describedby="tip"
                    data-action="mouseenter->stimeo--tooltip#show">Help</button>
            <span id="tip" role="tooltip" data-stimeo--tooltip-target="content" hidden>Hint</span>
          </span>
        </div>
      </div>`,
      (app) => {
        app.register("stimeo--dialog", DialogController);
        app.register("stimeo--tooltip", TooltipController);
      },
    );

    byId("dlg-trigger").click();
    byId("dlg-focus").focus();
    byId("tip-trigger").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(byId("tip").hidden).toBe(false);

    const event = pressEscape(byId("dlg-focus"));

    expect(event.defaultPrevented).toBe(true);
    expect(byId("tip").hidden).toBe(true);
    expect(byId("dlg").hidden).toBe(false);
    expect(document.activeElement).toBe(byId("dlg-focus"));

    // Dismissing the tooltip pops it off the stack, so ownership falls back to
    // the trap and the next press closes the dialog.
    const second = pressEscape(byId("dlg-focus"));
    expect(second.defaultPrevented).toBe(true);
    expect(byId("dlg").hidden).toBe(true);
    expect(document.activeElement).toBe(byId("dlg-trigger"));
  });

  it("closes the newest layer even when a stale layer's trigger holds focus", async () => {
    await start(
      `
      <span data-controller="stimeo--tooltip">
        <button id="tip-trigger" data-stimeo--tooltip-target="trigger" aria-describedby="tip"
                data-action="mouseenter->stimeo--tooltip#show">
          Save
        </button>
        <span id="tip" role="tooltip" data-stimeo--tooltip-target="content" hidden>Hint</span>
      </span>
      <span data-controller="stimeo--hover-card"
            data-stimeo--hover-card-open-delay-value="0">
        <a id="hc-trigger" href="/u" data-stimeo--hover-card-target="trigger"
           aria-expanded="false" aria-controls="hc"
           data-action="mouseenter->stimeo--hover-card#open mouseleave->stimeo--hover-card#close">
          @user
        </a>
        <div id="hc" data-stimeo--hover-card-target="card" hidden>Profile</div>
      </span>`,
      (app) => {
        app.register("stimeo--tooltip", TooltipController);
        app.register("stimeo--hover-card", HoverCardController);
      },
    );

    // The tooltip is shown first and its trigger keeps focus; the hover card is
    // shown afterwards, so it sits on top of the stack. The press reaches the
    // tooltip's element-level action first (bubbling from the focused trigger) —
    // the action must defer so the newest layer closes first.
    byId("tip-trigger").focus();
    byId("tip-trigger").dispatchEvent(new Event("mouseenter"));
    byId("hc-trigger").dispatchEvent(new Event("mouseenter"));
    expect(byId("tip").hidden).toBe(false);
    expect(byId("hc").hidden).toBe(false);

    const first = pressEscape(byId("tip-trigger"));
    expect(first.defaultPrevented).toBe(true);
    expect(byId("hc").hidden).toBe(true);
    expect(byId("tip").hidden).toBe(false);

    // With the newer layer gone, the tooltip owns the next press again.
    const second = pressEscape(byId("tip-trigger"));
    expect(second.defaultPrevented).toBe(true);
    expect(byId("tip").hidden).toBe(true);
  });

  it("lets a modal nested inside an open dropdown close before the dropdown", async () => {
    await start(
      `
      <div id="dd-root" data-controller="stimeo--dropdown">
        <button id="dd-trigger" data-stimeo--dropdown-target="trigger"
                data-action="stimeo--dropdown#toggle">Menu</button>
        <div id="dd-menu" data-stimeo--dropdown-target="menu">
          <a id="dd-link" href="#">Item</a>
          <div data-controller="stimeo--dialog">
            <button id="dlg-trigger" data-stimeo--dialog-target="trigger"
                    data-action="stimeo--dialog#open">Confirm…</button>
            <div id="dlg" data-stimeo--dialog-target="dialog" role="dialog" aria-modal="true"
                 aria-labelledby="dlg-title" hidden>
              <h2 id="dlg-title">Confirm</h2>
              <button id="dlg-ok">OK</button>
            </div>
          </div>
        </div>
      </div>`,
      (app) => {
        app.register("stimeo--dropdown", DropdownController);
        app.register("stimeo--dialog", DialogController);
      },
    );

    // The modal lives inside the dropdown's DOM, so its keypresses bubble
    // through the dropdown root before any document listener runs. The root
    // handler must yield to the active layer nested in its own subtree.
    byId("dd-trigger").click();
    byId("dlg-trigger").focus();
    byId("dlg-trigger").click();
    expect(byId("dlg").hidden).toBe(false);
    expect(byId("dd-menu").hidden).toBe(false);

    const first = pressEscape(document.activeElement ?? document);
    expect(first.defaultPrevented).toBe(true);
    expect(byId("dlg").hidden).toBe(true);
    expect(byId("dd-menu").hidden).toBe(false);
    expect(document.activeElement).toBe(byId("dlg-trigger"));

    // With the modal gone, the next press belongs to the dropdown again.
    const second = pressEscape(document.activeElement ?? document);
    expect(second.defaultPrevented).toBe(true);
    expect(byId("dd-menu").hidden).toBe(true);
    expect(document.activeElement).toBe(byId("dd-trigger"));
  });

  it("releases document ownership when a shown layer disconnects", async () => {
    await start(
      `
      <span data-controller="stimeo--hover-card"
            data-stimeo--hover-card-open-delay-value="0">
        <a id="hc-trigger" href="/u" data-stimeo--hover-card-target="trigger"
           aria-expanded="false" aria-controls="hc"
           data-action="mouseenter->stimeo--hover-card#open mouseleave->stimeo--hover-card#close">
          @user
        </a>
        <div id="hc" data-stimeo--hover-card-target="card" hidden>Profile</div>
      </span>
      <span id="tip-root" data-controller="stimeo--tooltip">
        <button id="tip-trigger" data-stimeo--tooltip-target="trigger" aria-describedby="tip"
                data-action="mouseenter->stimeo--tooltip#show">Save</button>
        <span id="tip" role="tooltip" data-stimeo--tooltip-target="content" hidden>Hint</span>
      </span>`,
      (app) => {
        app.register("stimeo--hover-card", HoverCardController);
        app.register("stimeo--tooltip", TooltipController);
      },
    );

    // Hover card first, tooltip second: the tooltip sits on top of the stack.
    byId("hc-trigger").dispatchEvent(new Event("mouseenter"));
    byId("tip-trigger").dispatchEvent(new Event("mouseenter"));
    expect(byId("hc").hidden).toBe(false);
    expect(byId("tip").hidden).toBe(false);

    // Tearing the shown tooltip down (a Turbo removal) must release its
    // ownership; a stale top entry would block every layer below for good.
    const tooltip = application.getControllerForElementAndIdentifier(
      byId("tip-root"),
      "stimeo--tooltip",
    ) as TooltipController;
    tooltip.disconnect();

    const event = pressEscape();
    expect(event.defaultPrevented).toBe(true);
    expect(byId("hc").hidden).toBe(true);
  });

  it("closes one transient layer per press when shown simultaneously, in either order", async () => {
    const markup = `
      <span data-controller="stimeo--tooltip">
        <button id="tip-trigger" data-stimeo--tooltip-target="trigger" aria-describedby="tip"
                data-action="mouseenter->stimeo--tooltip#show mouseleave->stimeo--tooltip#hide">
          Save
        </button>
        <span id="tip" role="tooltip" data-stimeo--tooltip-target="content" hidden>Hint</span>
      </span>
      <span data-controller="stimeo--hover-card"
            data-stimeo--hover-card-open-delay-value="0">
        <a id="hc-trigger" href="/u" data-stimeo--hover-card-target="trigger"
           aria-expanded="false" aria-controls="hc"
           data-action="mouseenter->stimeo--hover-card#open mouseleave->stimeo--hover-card#close">
          @user
        </a>
        <div id="hc" data-stimeo--hover-card-target="card" hidden>Profile</div>
      </span>`;
    const register = (app: Application) => {
      app.register("stimeo--tooltip", TooltipController);
      app.register("stimeo--hover-card", HoverCardController);
    };
    const openLayers = () => [byId("tip"), byId("hc")].filter((layer) => !layer.hidden).length;

    // Activation order defines the stack: the last shown layer closes first,
    // independent of document-listener registration order.
    for (const showOrder of [
      ["tip-trigger", "hc-trigger"],
      ["hc-trigger", "tip-trigger"],
    ]) {
      await start(markup, register);
      for (const id of showOrder) byId(id).dispatchEvent(new Event("mouseenter"));
      expect(openLayers()).toBe(2);

      expect(pressEscape().defaultPrevented).toBe(true);
      expect(openLayers()).toBe(1);
      const lastShown = showOrder[1] === "tip-trigger" ? byId("tip") : byId("hc");
      expect(lastShown.hidden).toBe(true);

      expect(pressEscape().defaultPrevented).toBe(true);
      expect(openLayers()).toBe(0);

      disconnectAndStopApplication(application);
      document.body.innerHTML = "";
    }
  });

  it("dismisses a hover tooltip before its containing dropdown", async () => {
    await start(
      `
      <div data-controller="stimeo--dropdown">
        <button id="dd-trigger" data-stimeo--dropdown-target="trigger"
                data-action="stimeo--dropdown#toggle">Menu</button>
        <div id="dd-menu" data-stimeo--dropdown-target="menu" hidden>
          <button id="dd-item">Item</button>
          <span data-controller="stimeo--tooltip">
            <button id="tip-trigger" data-stimeo--tooltip-target="trigger" aria-describedby="tip"
                    data-action="mouseenter->stimeo--tooltip#show">Help</button>
            <span id="tip" role="tooltip" data-stimeo--tooltip-target="content" hidden>Hint</span>
          </span>
        </div>
      </div>`,
      (app) => {
        app.register("stimeo--dropdown", DropdownController);
        app.register("stimeo--tooltip", TooltipController);
      },
    );

    // Focus rests on a menu item while another item's hint is hover-shown: the
    // tooltip is the newest layer, so it must close first even though the press
    // bubbles through the dropdown holding focus.
    byId("dd-trigger").click();
    byId("dd-item").focus();
    byId("tip-trigger").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(byId("tip").hidden).toBe(false);

    const first = pressEscape(byId("dd-item"));
    expect(first.defaultPrevented).toBe(true);
    expect(byId("tip").hidden).toBe(true);
    expect(byId("dd-menu").hidden).toBe(false);

    // With the hint gone, the dropdown owns the next press again.
    const second = pressEscape(byId("dd-item"));
    expect(second.defaultPrevented).toBe(true);
    expect(byId("dd-menu").hidden).toBe(true);
    expect(document.activeElement).toBe(byId("dd-trigger"));
  });

  it("closes a hover card before its containing popover", async () => {
    await start(
      `
      <div data-controller="stimeo--popover">
        <button id="pop-trigger" data-stimeo--popover-target="trigger"
                aria-haspopup="dialog" aria-expanded="false" aria-controls="pop"
                data-action="click->stimeo--popover#toggle">Edit</button>
        <div id="pop" data-stimeo--popover-target="panel" role="dialog" aria-label="Edit" hidden>
          <button id="pop-focus">Focused control</button>
          <span data-controller="stimeo--hover-card" data-stimeo--hover-card-open-delay-value="0">
            <a id="hc-trigger" href="/u" data-stimeo--hover-card-target="trigger"
               aria-expanded="false" aria-controls="hc"
               data-action="mouseenter->stimeo--hover-card#open mouseleave->stimeo--hover-card#close">
              @user
            </a>
            <div id="hc" data-stimeo--hover-card-target="card" hidden>Profile</div>
          </span>
        </div>
      </div>`,
      (app) => {
        app.register("stimeo--popover", PopoverController);
        app.register("stimeo--hover-card", HoverCardController);
      },
    );

    byId("pop-trigger").click();
    byId("pop-focus").focus();
    byId("hc-trigger").dispatchEvent(new Event("mouseenter"));
    expect(byId("hc").hidden).toBe(false);

    const first = pressEscape(byId("pop-focus"));
    expect(first.defaultPrevented).toBe(true);
    expect(byId("hc").hidden).toBe(true);
    expect(byId("pop").hidden).toBe(false);

    const second = pressEscape(byId("pop-focus"));
    expect(second.defaultPrevented).toBe(true);
    expect(byId("pop").hidden).toBe(true);
    expect(document.activeElement).toBe(byId("pop-trigger"));
  });

  it("closes only the tooltip when a menu item doubles as its trigger", async () => {
    await start(
      `
      <div data-controller="stimeo--menu">
        <button id="menu-trigger" data-stimeo--menu-target="trigger"
                data-action="click->stimeo--menu#toggle keydown->stimeo--menu#onTriggerKeydown"
                aria-haspopup="menu" aria-expanded="false" aria-controls="menu">Actions</button>
        <ul id="menu" role="menu" aria-labelledby="menu-trigger"
            data-stimeo--menu-target="menu" hidden>
          <li role="none">
            <span data-controller="stimeo--tooltip">
              <button id="item-1" role="menuitem" tabindex="-1"
                      data-stimeo--menu-target="item" data-stimeo--tooltip-target="trigger"
                      aria-describedby="tip"
                      data-action="mouseenter->stimeo--tooltip#show
                                   click->stimeo--menu#activate
                                   keydown->stimeo--menu#onItemKeydown">Rename</button>
              <span id="tip" role="tooltip" data-stimeo--tooltip-target="content" hidden>Hint</span>
            </span>
          </li>
        </ul>
      </div>`,
      (app) => {
        app.register("stimeo--menu", MenuController);
        app.register("stimeo--tooltip", TooltipController);
      },
    );

    // The tooltip is shown for the focused item itself. One press must close
    // exactly one layer — the tooltip (newest) — never both at once.
    byId("menu-trigger").click();
    byId("item-1").focus();
    byId("item-1").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(byId("tip").hidden).toBe(false);

    const first = pressEscape(byId("item-1"));
    expect(first.defaultPrevented).toBe(true);
    expect(byId("tip").hidden).toBe(true);
    expect(byId("menu").hidden).toBe(false);

    const second = pressEscape(byId("item-1"));
    expect(second.defaultPrevented).toBe(true);
    expect(byId("menu").hidden).toBe(true);
    expect(document.activeElement).toBe(byId("menu-trigger"));
  });

  it("lets the dialog close over a focused combobox whose list is closed", async () => {
    await start(
      `
      <div data-controller="stimeo--dialog">
        <button id="dlg-trigger" data-stimeo--dialog-target="trigger"
                data-action="stimeo--dialog#open">Open</button>
        <div id="dlg" data-stimeo--dialog-target="dialog" role="dialog"
             aria-modal="true" aria-label="Dialog" hidden>
          <div data-controller="stimeo--combobox">
            <input id="cb-input" type="text" role="combobox" aria-expanded="false"
                   aria-autocomplete="list" aria-controls="cb-list" aria-label="Fruit"
                   data-stimeo--combobox-target="input"
                   data-action="keydown->stimeo--combobox#onKeydown" />
            <ul id="cb-list" role="listbox" data-stimeo--combobox-target="list" hidden>
              <li role="option" id="cb-apple" data-value="apple"
                  data-stimeo--combobox-target="option">Apple</li>
            </ul>
          </div>
        </div>
      </div>`,
      (app) => {
        app.register("stimeo--dialog", DialogController);
        app.register("stimeo--combobox", ComboboxController);
      },
    );

    // A widget-local handler owns Escape only while it has something to close:
    // with the list closed the press must pass through to the resolver, so the
    // dialog is still keyboard-dismissable from the focused input.
    byId("dlg-trigger").click();
    byId("cb-input").focus();
    expect(byId("cb-list").hidden).toBe(true);

    const event = pressEscape(byId("cb-input"));
    expect(event.defaultPrevented).toBe(true);
    expect(byId("dlg").hidden).toBe(true);
    expect(document.activeElement).toBe(byId("dlg-trigger"));
  });

  it("closes the combobox list first, then the dialog", async () => {
    await start(
      `
      <div data-controller="stimeo--dialog">
        <button id="dlg-trigger" data-stimeo--dialog-target="trigger"
                data-action="stimeo--dialog#open">Open</button>
        <div id="dlg" data-stimeo--dialog-target="dialog" role="dialog"
             aria-modal="true" aria-label="Dialog" hidden>
          <div data-controller="stimeo--combobox">
            <input id="cb-input" type="text" role="combobox" aria-expanded="false"
                   aria-autocomplete="list" aria-controls="cb-list" aria-label="Fruit"
                   data-stimeo--combobox-target="input"
                   data-action="keydown->stimeo--combobox#onKeydown" />
            <ul id="cb-list" role="listbox" data-stimeo--combobox-target="list" hidden>
              <li role="option" id="cb-apple" data-value="apple"
                  data-stimeo--combobox-target="option">Apple</li>
            </ul>
          </div>
        </div>
      </div>`,
      (app) => {
        app.register("stimeo--dialog", DialogController);
        app.register("stimeo--combobox", ComboboxController);
      },
    );

    byId("dlg-trigger").click();
    byId("cb-input").focus();
    // Open the list the keyboard way (ArrowDown), like a user inside the dialog.
    byId("cb-input").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    expect(byId("cb-list").hidden).toBe(false);

    // While the list is open the widget-local handler is the deepest owner …
    const first = pressEscape(byId("cb-input"));
    expect(first.defaultPrevented).toBe(true);
    expect(byId("cb-list").hidden).toBe(true);
    expect(byId("dlg").hidden).toBe(false);

    // … and once it has nothing left to close, the resolver owns the press.
    const second = pressEscape(byId("cb-input"));
    expect(second.defaultPrevented).toBe(true);
    expect(byId("dlg").hidden).toBe(true);
  });

  it("dismisses a shown tooltip while a closed combobox holds focus", async () => {
    await start(
      `
      <div data-controller="stimeo--combobox">
        <input id="cb-input" type="text" role="combobox" aria-expanded="false"
               aria-autocomplete="list" aria-controls="cb-list" aria-label="Fruit"
               data-stimeo--combobox-target="input"
               data-action="keydown->stimeo--combobox#onKeydown" />
        <ul id="cb-list" role="listbox" data-stimeo--combobox-target="list" hidden>
          <li role="option" id="cb-apple" data-value="apple"
              data-stimeo--combobox-target="option">Apple</li>
        </ul>
      </div>
      <span data-controller="stimeo--tooltip">
        <button id="tip-trigger" data-stimeo--tooltip-target="trigger" aria-describedby="tip"
                data-action="mouseenter->stimeo--tooltip#show">Help</button>
        <span id="tip" role="tooltip" data-stimeo--tooltip-target="content" hidden>Hint</span>
      </span>`,
      (app) => {
        app.register("stimeo--combobox", ComboboxController);
        app.register("stimeo--tooltip", TooltipController);
      },
    );

    byId("cb-input").focus();
    byId("tip-trigger").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(byId("tip").hidden).toBe(false);

    const event = pressEscape(byId("cb-input"));
    expect(event.defaultPrevented).toBe(true);
    expect(byId("tip").hidden).toBe(true);
    expect(document.activeElement).toBe(byId("cb-input"));
  });

  it("closes a dropdown opened over an already-shown tooltip first", async () => {
    await start(
      `
      <span data-controller="stimeo--tooltip">
        <button id="tip-trigger" data-stimeo--tooltip-target="trigger" aria-describedby="tip"
                data-action="mouseenter->stimeo--tooltip#show">Help</button>
        <span id="tip" role="tooltip" data-stimeo--tooltip-target="content" hidden>Hint</span>
      </span>
      <div data-controller="stimeo--dropdown">
        <button id="dd-trigger" data-stimeo--dropdown-target="trigger"
                data-action="stimeo--dropdown#toggle">Menu</button>
        <div id="dd-menu" data-stimeo--dropdown-target="menu" hidden>
          <a id="dd-link" href="#">Item</a>
        </div>
      </div>`,
      (app) => {
        app.register("stimeo--tooltip", TooltipController);
        app.register("stimeo--dropdown", DropdownController);
      },
    );

    // The reverse activation order: the hover layer is shown BEFORE the
    // disclosure opens on top of it. The dropdown activated last, so it must
    // close first, then the older tooltip.
    byId("tip-trigger").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(byId("tip").hidden).toBe(false);
    byId("dd-trigger").focus();
    byId("dd-trigger").click();
    expect(byId("dd-menu").hidden).toBe(false);

    const first = pressEscape(byId("dd-trigger"));
    expect(first.defaultPrevented).toBe(true);
    expect(byId("dd-menu").hidden).toBe(true);
    expect(byId("tip").hidden).toBe(false);

    const second = pressEscape(document.activeElement ?? document);
    expect(second.defaultPrevented).toBe(true);
    expect(byId("tip").hidden).toBe(true);
  });

  it("keeps ownership on the focused layer after a reconnect reorders the listeners", async () => {
    await start(
      `
      <div id="dd-a" data-controller="stimeo--dropdown">
        <button id="dd-a-trigger" data-stimeo--dropdown-target="trigger"
                data-action="stimeo--dropdown#toggle">A</button>
        <div id="dd-a-menu" data-stimeo--dropdown-target="menu"><a id="dd-a-link" href="#">A1</a></div>
      </div>
      <div id="dd-b" data-controller="stimeo--dropdown">
        <button id="dd-b-trigger" data-stimeo--dropdown-target="trigger"
                data-action="stimeo--dropdown#toggle">B</button>
        <div id="dd-b-menu" data-stimeo--dropdown-target="menu"><a id="dd-b-link" href="#">B1</a></div>
      </div>`,
      (app) => app.register("stimeo--dropdown", DropdownController),
    );

    const instance = (id: string) =>
      application.getControllerForElementAndIdentifier(
        byId(id),
        "stimeo--dropdown",
      ) as DropdownController | null;
    const a = instance("dd-a");
    const b = instance("dd-b");
    if (!a || !b) throw new Error("dropdown controllers not found");

    // Both open (via the action, so no outside-click closes the sibling); the
    // press belongs to the instance holding focus, not the first registered.
    a.open();
    b.open();
    byId("dd-b-link").focus();
    pressEscape(byId("dd-b-link"));
    expect(byId("dd-b-menu").hidden).toBe(true);
    expect(byId("dd-a-menu").hidden).toBe(false);

    // Simulate a Turbo reconnect of A. Local bubbling keeps ownership tied to
    // the focused subtree regardless of reconnect order.
    a.disconnect();
    a.connect();
    a.open();
    b.open();
    byId("dd-a-link").focus();
    pressEscape(byId("dd-a-link"));
    expect(byId("dd-a-menu").hidden).toBe(true);
    expect(byId("dd-b-menu").hidden).toBe(false);
  });
});
