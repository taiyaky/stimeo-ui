import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextMenuController } from "../src/controllers/context_menu_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ContextMenuController}: contextmenu/keyboard
 * opening, pointer-coordinate reflection as CSS custom properties, roving focus,
 * activation, and Escape / Tab / outside-click closing.
 */
describe("ContextMenuController", () => {
  let application: Application;

  const start = async () => {
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--context-menu">
          <div id="region" data-stimeo--context-menu-target="region" tabindex="0"
               aria-haspopup="menu" aria-controls="ctx"
               data-action="contextmenu->stimeo--context-menu#open
                            keydown->stimeo--context-menu#onRegionKeydown">Area</div>
          <ul id="ctx" role="menu" data-stimeo--context-menu-target="menu" hidden>
            <li role="none"><button id="copy" role="menuitem" tabindex="-1"
                  data-stimeo--context-menu-target="item"
                  data-action="click->stimeo--context-menu#activate
                               keydown->stimeo--context-menu#onItemKeydown">Copy</button></li>
            <li role="none"><button id="paste" role="menuitem" tabindex="-1"
                  data-stimeo--context-menu-target="item"
                  data-action="click->stimeo--context-menu#activate
                               keydown->stimeo--context-menu#onItemKeydown">Paste</button></li>
            <li role="none"><button id="del" role="menuitem" tabindex="-1"
                  data-stimeo--context-menu-target="item"
                  data-action="click->stimeo--context-menu#activate
                               keydown->stimeo--context-menu#onItemKeydown">Delete</button></li>
          </ul>
        </div>
        <button id="outside">Outside</button>
      </main>`;
    application = Application.start();
    application.register("stimeo--context-menu", ContextMenuController);
    await tick();
  };

  beforeEach(() => start());

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const region = () => query("#region");
  const menu = () => query("#ctx");
  const contextmenu = (x: number, y: number) =>
    region().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: x, clientY: y }),
    );

  it("starts closed with collapsed state", () => {
    expect(menu().hidden).toBe(true);
    expect(region().getAttribute("data-state")).toBe("closed");
  });

  it("opens at the pointer coordinate, reflecting CSS custom properties", () => {
    contextmenu(120, 80);
    expect(menu().hidden).toBe(false);
    expect(region().getAttribute("data-state")).toBe("open");
    expect(menu().style.getPropertyValue("--stimeo-context-menu-x")).toBe("120px");
    expect(menu().style.getPropertyValue("--stimeo-context-menu-y")).toBe("80px");
    expect(document.activeElement).toBe(query("#copy"));
  });

  it("suppresses the browser's native context menu", () => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    region().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("opens via Shift+F10 from the region and focuses the first item", () => {
    region().dispatchEvent(
      new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
    );
    expect(menu().hidden).toBe(false);
    expect(document.activeElement).toBe(query("#copy"));
  });

  it("opens via the ContextMenu key", () => {
    region().dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true }));
    expect(menu().hidden).toBe(false);
  });

  const press = (el: Element, key: string): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event;
  };

  it("moves focus with ArrowDown/ArrowUp, wrapping", () => {
    contextmenu(0, 0);
    const copy = query("#copy");
    const paste = query("#paste");
    const del = query("#del");
    expect(press(copy, "ArrowDown").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(paste);
    expect(press(paste, "ArrowDown").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(del);
    expect(press(del, "ArrowDown").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(copy);
    expect(press(copy, "ArrowUp").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(del);
  });

  it("jumps to first/last with Home/End", () => {
    contextmenu(0, 0);
    const copy = query("#copy");
    const del = query("#del");
    del.focus();
    expect(press(del, "Home").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(copy);
    expect(press(copy, "End").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(del);
  });

  it("closes and restores focus to the region when an item is activated", () => {
    contextmenu(0, 0);
    query<HTMLButtonElement>("#copy").click();
    expect(menu().hidden).toBe(true);
    expect(region().getAttribute("data-state")).toBe("closed");
    expect(document.activeElement).toBe(region());
  });

  it("closes and restores focus on Escape", () => {
    contextmenu(0, 0);
    query("#copy").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(region());
  });

  it("defers Tab closing so the browser can move focus first", async () => {
    contextmenu(0, 0);
    query("#copy").dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(menu().hidden).toBe(false);
    await tick();
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).not.toBe(region());
  });

  it("closes on an outside click without stealing focus from its destination", () => {
    contextmenu(0, 0);
    const outside = query("#outside");
    outside.focus();
    outside.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(outside);
  });

  it("closes when a contextmenu event occurs outside the controller", () => {
    contextmenu(0, 0);
    query("#outside").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(menu().hidden).toBe(true);
  });

  it("removes the document pointer listeners on disconnect", () => {
    const instance = application.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--context-menu']"),
      "stimeo--context-menu",
    ) as ContextMenuController;
    instance.disconnect();
    // Opening still works through data-action, but both outside guards are gone.
    contextmenu(0, 0);
    query("#outside").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menu().hidden).toBe(false);
    query("#outside").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(menu().hidden).toBe(false);
  });

  it("cancels a pending Tab close on disconnect", async () => {
    const instance = application.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--context-menu']"),
      "stimeo--context-menu",
    ) as ContextMenuController;
    contextmenu(0, 0);
    press(query("#copy"), "Tab");

    instance.disconnect();
    await tick();

    expect(menu().hidden).toBe(false);
  });
});

describe("ContextMenuController disabled items", () => {
  let application: Application;

  beforeEach(async () => {
    // The first item is aria-disabled and the second is hidden; roving must skip both.
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--context-menu">
          <div id="region" data-stimeo--context-menu-target="region" tabindex="0"
               aria-haspopup="menu" aria-controls="ctx"
               data-action="contextmenu->stimeo--context-menu#open
                            keydown->stimeo--context-menu#onRegionKeydown">Area</div>
          <ul id="ctx" role="menu" data-stimeo--context-menu-target="menu" hidden>
            <li role="none"><button id="copy" role="menuitem" tabindex="-1"
                  aria-disabled="true"
                  data-stimeo--context-menu-target="item"
                  data-action="click->stimeo--context-menu#activate
                               keydown->stimeo--context-menu#onItemKeydown">Copy</button></li>
            <li role="none"><button id="hidden" role="menuitem" tabindex="-1" hidden
                  data-stimeo--context-menu-target="item"
                  data-action="keydown->stimeo--context-menu#onItemKeydown">Hidden</button></li>
            <li role="none"><button id="paste" role="menuitem" tabindex="-1"
                  data-stimeo--context-menu-target="item"
                  data-action="keydown->stimeo--context-menu#onItemKeydown">Paste</button></li>
            <li role="none"><button id="cut" role="menuitem" tabindex="-1" disabled
                  data-stimeo--context-menu-target="item"
                  data-action="keydown->stimeo--context-menu#onItemKeydown">Cut</button></li>
            <li role="none"><button id="del" role="menuitem" tabindex="-1"
                  data-stimeo--context-menu-target="item"
                  data-action="keydown->stimeo--context-menu#onItemKeydown">Delete</button></li>
          </ul>
        </div>
      </main>`;
    application = Application.start();
    application.register("stimeo--context-menu", ContextMenuController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const region = () => query("#region");
  const menu = () => query("#ctx");
  const press = (el: Element, key: string): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event;
  };
  const contextmenu = () =>
    region().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 0, clientY: 0 }),
    );

  it("focuses the first navigable item on open", () => {
    contextmenu();
    expect(menu().hidden).toBe(false);
    expect(document.activeElement).toBe(query("#paste"));
  });

  it("skips disabled items moving down with ArrowDown", () => {
    contextmenu(); // focus Paste
    press(query("#paste"), "ArrowDown"); // skip Cut → Delete
    expect(document.activeElement).toBe(query("#del"));
  });

  it("skips disabled items wrapping with ArrowUp", () => {
    contextmenu(); // focus Paste
    press(query("#paste"), "ArrowUp"); // wrap past disabled/hidden to Delete
    expect(document.activeElement).toBe(query("#del"));
  });

  it("End jumps to the last navigable item, Home to the first", () => {
    contextmenu();
    press(query("#paste"), "End");
    expect(document.activeElement).toBe(query("#del"));
    press(query("#del"), "Home");
    expect(document.activeElement).toBe(query("#paste"));
  });

  it("recovers roving focus when the current target is disabled", () => {
    contextmenu();
    const disabled = query<HTMLButtonElement>("#copy");

    disabled.focus();
    expect(press(disabled, "ArrowDown").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(query("#paste"));

    disabled.focus();
    expect(press(disabled, "ArrowUp").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(query("#del"));
  });

  it("keeps the menu open when every item is disabled or hidden", () => {
    query<HTMLButtonElement>("#paste").disabled = true;
    query<HTMLButtonElement>("#del").disabled = true;
    region().focus();

    contextmenu();

    expect(menu().hidden).toBe(false);
    expect(document.activeElement).toBe(region());
  });

  it("blocks aria-disabled activation before consumer handlers", () => {
    const disabled = query<HTMLButtonElement>("#copy");
    let consumerActivations = 0;
    disabled.addEventListener("click", () => consumerActivations++);
    contextmenu();

    disabled.click();

    expect(consumerActivations).toBe(0);
    expect(menu().hidden).toBe(false);
    expect(region().getAttribute("data-state")).toBe("open");
  });

  it("removes the disabled activation blocker on disconnect", () => {
    const disabled = query<HTMLButtonElement>("#copy");
    let consumerActivations = 0;
    disabled.addEventListener("click", () => consumerActivations++);
    const instance = application.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--context-menu']"),
      "stimeo--context-menu",
    ) as ContextMenuController;

    instance.disconnect();
    disabled.click();

    expect(consumerActivations).toBe(1);
  });

  it("includes a dynamically added target in roving focus", async () => {
    contextmenu();
    const item = document.createElement("button");
    item.id = "share";
    item.setAttribute("role", "menuitem");
    item.tabIndex = -1;
    item.setAttribute("data-stimeo--context-menu-target", "item");
    item.textContent = "Share";
    menu().append(item);
    await tick();

    press(query("#del"), "ArrowDown");

    expect(document.activeElement).toBe(item);
  });
});

describe("ContextMenuController multiple instances", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = ["first", "second"]
      .map(
        (id) => `
          <div data-controller="stimeo--context-menu" id="${id}">
            <div id="${id}-region" data-stimeo--context-menu-target="region" tabindex="0"
                 data-action="contextmenu->stimeo--context-menu#open">${id}</div>
            <div id="${id}-menu" role="menu" data-stimeo--context-menu-target="menu" hidden>
              <button role="menuitem" tabindex="-1"
                      data-stimeo--context-menu-target="item">Action</button>
            </div>
          </div>`,
      )
      .join("");
    application = Application.start();
    application.register("stimeo--context-menu", ContextMenuController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("closes the first menu when another instance opens", () => {
    query("#first-region").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(query<HTMLElement>("#first-menu").hidden).toBe(false);

    query("#second-region").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    expect(query<HTMLElement>("#first-menu").hidden).toBe(true);
    expect(query<HTMLElement>("#second-menu").hidden).toBe(false);
  });
});

describe("ContextMenuController accessibility", () => {
  let application: Application;

  const startReal = async () => {
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--context-menu">
          <div data-stimeo--context-menu-target="region" tabindex="0"
               aria-haspopup="menu" aria-controls="ctx3" aria-label="File actions"
               data-action="contextmenu->stimeo--context-menu#open">Right-click for actions</div>
          <ul id="ctx3" role="menu" aria-label="File actions"
              data-stimeo--context-menu-target="menu" hidden>
            <li role="none"><button role="menuitem" tabindex="-1"
                  data-stimeo--context-menu-target="item">Copy</button></li>
            <li role="none"><button role="menuitem" tabindex="-1"
                  data-stimeo--context-menu-target="item">Delete</button></li>
          </ul>
        </div>
      </main>`;
    application = Application.start();
    application.register("stimeo--context-menu", ContextMenuController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("has no machine-detectable a11y violations when open", async () => {
    await startReal();
    query("[data-stimeo--context-menu-target='region']").dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
    );
    await expectNoA11yViolations(document.body);
  });

  it("announces the menu and its items", async () => {
    await startReal();
    query("[data-stimeo--context-menu-target='region']").dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
    );
    const spoken = await captureSpeech({ container: query("main"), steps: 6 });
    // Freeze the whole ordered array (not a name-only `toContain`) so a lost menu
    // role, dropped item, or reordering surfaces as a diff.
    expect(spoken).toEqual([
      "main",
      "File actions, 1 control",
      "Right-click for actions",
      "end, File actions, 1 control",
      "menu, File actions, orientated vertically",
      "menuitem, Copy, position 1, set size 2",
      "menuitem, Delete, position 2, set size 2",
    ]);
  });
});
