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

  it("yields a key a descendant widget already consumed", () => {
    // A composed widget that claims the key must not ALSO act on it —
    // composition depends on this yield.
    region().dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true }));
    const focused = document.activeElement as HTMLElement;
    const inner = document.createElement("span");
    focused.append(inner);
    inner.addEventListener("keydown", (event) => event.preventDefault());

    inner.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );

    expect(document.activeElement).toBe(focused);
  });

  it("yields a region key a descendant widget already consumed", () => {
    // The controller has TWO guards — `onItemKeydown` (covered above) and
    // `onRegionKeydown`, the keyboard entry point for `ContextMenu` / `Shift+F10`.
    // Each needs its own case. The shape here is a nested widget that opens its
    // own menu on the same chord: the outer menu must not ALSO open and steal
    // focus.
    const inner = document.createElement("span");
    region().append(inner);
    inner.addEventListener("keydown", (event) => event.preventDefault());

    const event = new KeyboardEvent("keydown", {
      key: "F10",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    const notCanceled = inner.dispatchEvent(event);

    expect(notCanceled).toBe(false); // the claim really took (a non-cancelable event would not)
    expect(menu().hidden).toBe(true);
    expect(region().getAttribute("data-state")).toBe("closed");
  });

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

  it("leaves a modified arrow to the browser", () => {
    // A bare arrow roves the menu; a chorded one does not. Alt plus a horizontal
    // arrow is the browser's history shortcut, and a menu that swallows any
    // chord makes the shortcut work or not depending on where focus sits.
    contextmenu(0, 0);
    const copy = query("#copy");
    expect(document.activeElement).toBe(copy);

    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    copy.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(copy);
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

  it("stays open when an inside click removes the clicked node first", () => {
    // The failure mode that decides the listener phase. On bubble, the inner
    // handler runs first and detaches the node, so by the time the document
    // listener runs `event.target` is outside the tree and `contains()` says
    // "outside" — closing on what was an *inside* click. On capture the
    // document observes it first, against the tree the user actually clicked.
    contextmenu(0, 0);
    const item = document.createElement("button");
    menu().append(item);
    item.addEventListener("click", () => item.remove());

    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(menu().hidden).toBe(false);
  });

  it("stays open when an inside contextmenu handler removes the pressed node first", () => {
    // The contextmenu twin of the click case above: the outside guard is shared,
    // so both phases must match or an inside right-click on a self-detaching node
    // reads as outside.
    contextmenu(0, 0);
    const cell = document.createElement("span");
    region().append(cell);
    cell.addEventListener("contextmenu", () => cell.remove());

    cell.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));

    expect(menu().hidden).toBe(false);
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
    // The first item is aria-disabled and the second is hidden. Roving skips the
    // hidden one and the natively `disabled` Cut, but KEEPS the aria-disabled
    // Copy reachable — APG marks that attribute for controls that must stay
    // discoverable, and hiding a command's existence from a keyboard user is
    // worse than letting them land on an inert one.
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
    // Copy is aria-disabled but reachable, so it is the first navigable item.
    expect(document.activeElement).toBe(query("#copy"));
  });

  it("skips hidden and natively disabled items moving down with ArrowDown", () => {
    contextmenu(); // focus Copy (aria-disabled, still reachable)
    press(query("#copy"), "ArrowDown"); // skip the hidden one → Paste
    expect(document.activeElement).toBe(query("#paste"));
    press(query("#paste"), "ArrowDown"); // skip natively disabled Cut → Delete
    expect(document.activeElement).toBe(query("#del"));
  });

  it("skips hidden and natively disabled items wrapping with ArrowUp", () => {
    contextmenu(); // focus Copy
    press(query("#copy"), "ArrowUp"); // wrap past hidden/disabled to Delete
    expect(document.activeElement).toBe(query("#del"));
  });

  it("End jumps to the last navigable item, Home to the first", () => {
    contextmenu();
    press(query("#copy"), "End");
    expect(document.activeElement).toBe(query("#del"));
    press(query("#del"), "Home");
    expect(document.activeElement).toBe(query("#copy"));
  });

  it("roves onward from an aria-disabled item the user landed on", () => {
    // The other half of keeping it reachable: focus can rest there, so the arrow
    // keys have to keep working from it. A natively `disabled` item cannot be
    // focused at all, so there is no equivalent case for that attribute.
    contextmenu();
    const inert = query<HTMLButtonElement>("#copy");
    expect(document.activeElement).toBe(inert);

    expect(press(inert, "ArrowDown").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(query("#paste"));

    inert.focus();
    expect(press(inert, "ArrowUp").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(query("#del"));
  });

  it("keeps the menu open when every item is disabled or hidden", () => {
    query<HTMLButtonElement>("#copy").disabled = true; // natively, on top of aria-disabled
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

  it("hands over between instances even when the new region stops propagation", () => {
    query("#second-region").addEventListener("contextmenu", (event) => event.stopPropagation());
    query("#first-region").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(query<HTMLElement>("#first-menu").hidden).toBe(false);

    query("#second-region").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    // The outside guard observes before the consumer handler, so the first menu
    // still comes down; the second opens from its own same-element action, which
    // stopPropagation does not suppress.
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
