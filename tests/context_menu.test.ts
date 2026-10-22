import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenuController } from "../src/controllers/context_menu_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { keyEvent, press as pressKey } from "./helpers/keyboard";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents } from "./helpers/state_events";
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
               role="group" aria-label="Files"
               aria-keyshortcuts="Shift+F10" aria-controls="ctx"
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
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const region = () => query("#region");
  const menu = () => query("#ctx");
  const contextmenu = (x: number, y: number) =>
    region().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: x, clientY: y }),
    );

  it.each(
    (["Home", "End"] as const).flatMap((key) =>
      (
        [
          ["Alt", { altKey: true }],
          ["Ctrl", { ctrlKey: true }],
          ["Meta", { metaKey: true }],
          ["Shift", { shiftKey: true }],
          ["Ctrl+Shift", { ctrlKey: true, shiftKey: true }],
        ] as const
      ).map(([modifier, init]) => [key, modifier, init] as const),
    ),
  )("yields an unassigned Home/End chord (%s, %s)", async (key, _modifier, init) => {
    contextmenu(0, 0);
    const current = query("#paste");
    current.focus();
    const element = region().closest<HTMLElement>("[data-controller]");
    if (!element) throw new Error("Expected context menu root");
    const events: Event[] = [];
    for (const name of ["stimeo--context-menu:open", "stimeo--context-menu:close"]) {
      element.addEventListener(name, (event) => events.push(event));
    }
    const before = element.outerHTML;
    const rejected = pressKey(current, key, init);
    expect(rejected.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(current);
    expect(element.outerHTML).toBe(before);
    expect(events).toEqual([]);
    expect(region().getAttribute("data-state")).toBe("open");
    expect(menu().hidden).toBe(false);
    expect(pressKey(current, key).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(query(key === "Home" ? "#copy" : "#del"));
  });

  it("yields a key a descendant widget already consumed", () => {
    // A composed widget that claims the key must not ALSO act on it —
    // composition depends on this yield.
    pressKey(region(), "ContextMenu", { bubbles: true });
    const focused = document.activeElement as HTMLElement;
    const inner = document.createElement("span");
    inner.tabIndex = -1;
    focused.append(inner);
    inner.addEventListener("keydown", (event) => event.preventDefault());

    pressKey(inner, "ArrowDown", { bubbles: true, cancelable: true });

    expect(document.activeElement).toBe(inner);
  });

  it("yields a region key a descendant widget already consumed", () => {
    // The controller has TWO guards — `onItemKeydown` (covered above) and
    // `onRegionKeydown`, the keyboard entry point for `ContextMenu` / `Shift+F10`.
    // Each needs its own case. The shape here is a nested widget that opens its
    // own menu on the same chord: the outer menu must not ALSO open and steal
    // focus.
    const inner = document.createElement("span");
    inner.tabIndex = -1;
    region().append(inner);
    inner.addEventListener("keydown", (event) => event.preventDefault());

    const event = keyEvent("F10", { shiftKey: true, bubbles: true, cancelable: true });
    const notCanceled = !pressKey(inner, event).defaultPrevented;

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
    expect(menu().style.getPropertyValue("--stimeo--context-menu-x")).toBe("120px");
    expect(menu().style.getPropertyValue("--stimeo--context-menu-y")).toBe("80px");
    expect(document.activeElement).toBe(query("#copy"));
  });

  it("suppresses the browser's native context menu", () => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    region().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("opens via Shift+F10 from the region and focuses the first item", () => {
    pressKey(region(), "F10", { shiftKey: true, bubbles: true });
    expect(menu().hidden).toBe(false);
    expect(document.activeElement).toBe(query("#copy"));
  });

  it("opens via the ContextMenu key", () => {
    pressKey(region(), "ContextMenu", { bubbles: true });
    expect(menu().hidden).toBe(false);
  });

  const press = (el: HTMLElement, key: string): KeyboardEvent => {
    const event = keyEvent(key, { bubbles: true, cancelable: true });
    pressKey(el, event);
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

    const event = keyEvent("ArrowDown", { altKey: true, bubbles: true, cancelable: true });
    pressKey(copy, event);

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
    pressKey(query("#copy"), "Escape", { bubbles: true });
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(region());
  });

  it("defers Tab closing so the browser can move focus first", async () => {
    contextmenu(0, 0);
    pressKey(query("#copy"), "Tab", { bubbles: true });
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

  it("leaves Escape to the page after disconnect", () => {
    const instance = application.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--context-menu']"),
      "stimeo--context-menu",
    ) as ContextMenuController;
    contextmenu(0, 0);

    instance.disconnect();
    const pressed = press(query("#copy"), "Escape");

    expect(pressed.defaultPrevented).toBe(false);
    expect(menu().hidden).toBe(false);
  });

  it("keeps a reopened menu open when a Tab close was still pending", async () => {
    contextmenu(0, 0);
    press(query("#copy"), "Tab");

    contextmenu(40, 40);
    await tick();

    expect(menu().hidden).toBe(false);
    expect(region().getAttribute("data-state")).toBe("open");
  });

  it("keeps one pending close for repeated Tab presses", () => {
    vi.useFakeTimers();
    contextmenu(0, 0);

    press(query("#copy"), "Tab");
    press(query("#copy"), "Tab");

    expect(vi.getTimerCount()).toBe(1);
    vi.runAllTimers();
    expect(menu().hidden).toBe(true);
  });

  it("drops the pending Tab close when the menu closes another way first", () => {
    vi.useFakeTimers();
    contextmenu(0, 0);
    press(query("#copy"), "Tab");
    expect(vi.getTimerCount()).toBe(1);

    press(query("#copy"), "Escape");

    expect(menu().hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  // --- A region or a menu that takes over ---

  /**
   * The open state lives on the region (`data-state`) and the menu (`hidden`, and the
   * pointer coordinate it was opened at). A region or a menu that takes over — in one
   * task, or after an earlier one leaves in a later task — carries that state, silently.
   */
  describe("a region or a menu that takes over", () => {
    const root = () => query("[data-controller='stimeo--context-menu']");
    const controller = (): ContextMenuController => {
      const instance = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--context-menu",
      );
      if (!(instance instanceof ContextMenuController)) throw new Error("controller not found");
      return instance;
    };
    /** A server-rendered copy of the region that still reads closed. */
    const staleRegion = (): HTMLElement => {
      const copy = region().cloneNode(true) as HTMLElement;
      copy.removeAttribute("id");
      copy.setAttribute("data-state", "closed");
      return copy;
    };
    /** A server-rendered copy of the menu with `hidden` as given and no coordinate. */
    const staleMenu = (hidden: boolean): HTMLElement => {
      const copy = menu().cloneNode(true) as HTMLElement;
      copy.id = "ctx-successor";
      copy.removeAttribute("style");
      copy.hidden = hidden;
      for (const item of copy.querySelectorAll("[id]")) item.removeAttribute("id");
      return copy;
    };
    const coordinate = (el: HTMLElement) => [
      el.style.getPropertyValue("--stimeo--context-menu-x"),
      el.style.getPropertyValue("--stimeo--context-menu-y"),
    ];

    it("reflects the open menu into a region replaced in one task", async () => {
      contextmenu(10, 20);
      const successor = staleRegion();
      region().replaceWith(successor);
      await tick();

      expect(successor.getAttribute("data-state")).toBe("open");
    });

    it("reflects the open menu into the region that stays after an earlier one leaves", async () => {
      contextmenu(10, 20);
      const original = region();
      const successor = staleRegion();
      original.after(successor);
      await tick();
      original.remove();
      await tick();

      expect(successor.getAttribute("data-state")).toBe("open");
    });

    it("keeps the menu open where it was opened on a menu replaced in one task", async () => {
      contextmenu(10, 20);
      const successor = staleMenu(true);
      menu().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(false);
      expect(coordinate(successor)).toEqual(["10px", "20px"]);
      expect(region().getAttribute("data-state")).toBe("open");
    });

    it("keeps the menu open where it was opened on the menu that stays after an earlier one leaves", async () => {
      contextmenu(10, 20);
      const original = menu();
      const successor = staleMenu(true);
      original.after(successor);
      await tick();
      original.remove();
      await tick();

      expect(successor.hidden).toBe(false);
      expect(coordinate(successor)).toEqual(["10px", "20px"]);
      expect(region().getAttribute("data-state")).toBe("open");
    });

    it("leaves focus where it was when a menu is replaced in one task", async () => {
      contextmenu(10, 20);
      region().focus();
      const successor = staleMenu(true);
      menu().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(false);
      expect(document.activeElement).toBe(region());
    });

    it("leaves focus where it was when the menu that stays takes over after an earlier one leaves", async () => {
      contextmenu(10, 20);
      region().focus();
      const original = menu();
      const successor = staleMenu(true);
      original.after(successor);
      await tick();
      original.remove();
      await tick();

      expect(successor.hidden).toBe(false);
      expect(document.activeElement).toBe(region());
    });

    it("keeps the menu closed on a menu that takes over authored open", async () => {
      const successor = staleMenu(false);
      menu().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(true);
      expect(region().getAttribute("data-state")).toBe("closed");
    });

    it("leaves the Escape stack and reads closed once the only menu leaves", async () => {
      contextmenu(10, 20);
      menu().remove();
      await tick();

      expect(region().getAttribute("data-state")).toBe("closed");
      region().focus();
      const dismissal = keyEvent("Escape", { bubbles: true, cancelable: true });
      pressKey(region(), dismissal);
      expect(dismissal.defaultPrevented).toBe(false);
    });

    it("brings a region that arrives after the only one left to the open state", async () => {
      contextmenu(10, 20);
      const late = staleRegion();
      region().remove();
      await tick();

      root().prepend(late);
      await tick();

      expect(late.getAttribute("data-state")).toBe("open");
    });

    it("closes a menu that arrives after the only one left, even one authored open", async () => {
      contextmenu(10, 20);
      const late = staleMenu(false);
      menu().remove();
      await tick();

      root().append(late);
      await tick();

      expect(late.hidden).toBe(true);
      expect(coordinate(late)).toEqual(["", ""]);
      expect(region().getAttribute("data-state")).toBe("closed");
    });

    it("keeps the menu open when the region and the menu are replaced together", async () => {
      contextmenu(10, 20);
      const newRegion = staleRegion();
      const newMenu = staleMenu(true);
      region().replaceWith(newRegion);
      menu().replaceWith(newMenu);
      await tick();

      expect(newMenu.hidden).toBe(false);
      expect(coordinate(newMenu)).toEqual(["10px", "20px"]);
      expect(newRegion.getAttribute("data-state")).toBe("open");
    });

    it("keeps closed a menu the page closed, when it is then replaced", async () => {
      contextmenu(10, 20);
      menu().hidden = true;
      const successor = staleMenu(false);
      menu().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(true);
      expect(coordinate(successor)).toEqual(["", ""]);
      expect(region().getAttribute("data-state")).toBe("closed");
    });

    it("brings the region to a menu the page hid when another menu arrives behind it", async () => {
      contextmenu(10, 20);
      menu().hidden = true;
      menu().after(staleMenu(true));
      await tick();

      expect(region().getAttribute("data-state")).toBe("closed");
    });

    it("leaves a hidden value the page wrote on the menu alone when another menu arrives behind it", async () => {
      contextmenu(10, 20);
      menu().setAttribute("hidden", "until-found");
      menu().after(staleMenu(true));
      await tick();

      expect(menu().getAttribute("hidden")).toBe("until-found");
    });

    it("writes nothing when a region or a menu arrives behind the current one", async () => {
      contextmenu(10, 20);
      const writes: MutationRecord[] = [];
      const observer = new MutationObserver((records) => writes.push(...records));
      observer.observe(root(), { attributes: true, subtree: true });
      const behindRegion = staleRegion();
      const behindMenu = staleMenu(true);
      region().after(behindRegion);
      menu().after(behindMenu);
      await tick();
      writes.push(...observer.takeRecords());
      observer.disconnect();

      expect(writes.map((write) => write.attributeName)).toEqual([]);
      expect(behindRegion.getAttribute("data-state")).toBe("closed");
      expect(behindMenu.hidden).toBe(true);
    });

    it("reports nothing while it moves the open state", async () => {
      contextmenu(10, 20);
      const events = captureStateEvents("stimeo--context-menu");
      const changes: Event[] = [];
      const onChange = (event: Event): void => {
        changes.push(event);
      };
      document.addEventListener("change", onChange);
      const original = menu();
      original.after(staleMenu(true));
      region().after(staleRegion());
      await tick();
      original.remove();
      region().remove();
      await tick();

      expect(events.seen).toEqual([]);
      expect(changes).toEqual([]);
      events.stop();
      document.removeEventListener("change", onChange);
    });

    it("tolerates the removal of the only region and the only menu", () => {
      contextmenu(10, 20);
      const onlyRegion = region();
      const onlyMenu = menu();
      onlyRegion.remove();
      onlyMenu.remove();

      // The test stays synchronous: it calls the target callbacks directly instead of waiting
      // for the MutationObserver delivery, so a throw from either one fails this case.
      expect(() => controller().regionTargetDisconnected(onlyRegion)).not.toThrow();
      expect(() => controller().menuTargetDisconnected(onlyMenu)).not.toThrow();
    });

    it("writes nothing into the region or the menu that stay once it has disconnected", async () => {
      const original = region();
      const successorRegion = staleRegion();
      original.after(successorRegion);
      const originalMenu = menu();
      const successorMenu = staleMenu(true);
      originalMenu.after(successorMenu);
      await tick();
      contextmenu(10, 20);
      const instance = controller();
      instance.disconnect();
      original.remove();
      originalMenu.remove();
      instance.regionTargetDisconnected(original);
      instance.menuTargetDisconnected(originalMenu);
      instance.regionTargetConnected();
      instance.menuTargetConnected();
      await tick();

      expect(successorRegion.getAttribute("data-state")).toBe("closed");
      expect(successorMenu.hidden).toBe(true);
      expect(coordinate(successorMenu)).toEqual(["", ""]);
    });

    it("gives a region that stops being the region its own data-state back", async () => {
      contextmenu(10, 20);
      const former = region();
      const successor = staleRegion();
      former.after(successor);
      await tick();

      // The element stays; only the attribute naming it the region goes.
      former.removeAttribute("data-stimeo--context-menu-target");
      await tick();

      expect(former.hasAttribute("data-state")).toBe(false);
      expect(successor.getAttribute("data-state")).toBe("open");
    });

    it("gives a menu that stops being the menu its own hidden back", async () => {
      contextmenu(10, 20);
      const former = menu();
      const successor = staleMenu(true);
      former.after(successor);
      await tick();

      former.removeAttribute("data-stimeo--context-menu-target");
      await tick();

      expect(former.hidden).toBe(true);
      expect(successor.hidden).toBe(false);
    });

    it("gives the region and the menu their own values back when the widget loses its controller", async () => {
      contextmenu(10, 20);
      const departedRegion = region();
      const departedMenu = menu();

      root().removeAttribute("data-controller");
      await tick();

      expect(departedRegion.hasAttribute("data-state")).toBe(false);
      expect(departedMenu.hidden).toBe(true);
    });

    it("keeps values the page wrote on a region and a menu that stop being targets", async () => {
      contextmenu(10, 20);
      const former = region();
      const formerMenu = menu();
      former.setAttribute("data-state", "busy");
      formerMenu.setAttribute("hidden", "until-found");

      root().removeAttribute("data-controller");
      await tick();

      expect(former.getAttribute("data-state")).toBe("busy");
      expect(formerMenu.getAttribute("hidden")).toBe("until-found");
    });

    it("keeps what it wrote on a region and a menu that move within the widget", async () => {
      contextmenu(10, 20);
      const movingRegion = region();
      const movingMenu = menu();
      const writes: MutationRecord[] = [];
      const observer = new MutationObserver((records) => writes.push(...records));
      observer.observe(root(), {
        attributes: true,
        subtree: true,
        attributeFilter: ["data-state", "hidden", "style"],
      });

      root().append(movingRegion);
      root().prepend(movingMenu);
      await tick();
      writes.push(...observer.takeRecords());
      observer.disconnect();

      expect(movingRegion.getAttribute("data-state")).toBe("open");
      expect(movingMenu.hidden).toBe(false);
      expect(coordinate(movingMenu)).toEqual(["10px", "20px"]);
      expect(writes.map((write) => write.attributeName)).toEqual([]);
    });

    it("keeps what it wrote when the whole widget leaves the page", async () => {
      contextmenu(10, 20);
      const keptRegion = region();
      const keptMenu = menu();

      root().remove();
      await tick();

      expect(keptRegion.getAttribute("data-state")).toBe("open");
      expect(keptMenu.hidden).toBe(false);
    });
  });

  // --- State events ---

  describe("state events", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    const openAtPointer = () =>
      region().dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 8 }),
      );

    beforeEach(() => {
      capture = captureStateEvents("stimeo--context-menu");
    });

    afterEach(() => {
      capture.stop();
    });

    it("reports a contextmenu open as user, after the state attributes are written", () => {
      const states: string[] = [];
      query("[data-controller='stimeo--context-menu']").addEventListener(
        "stimeo--context-menu:open",
        () => {
          states.push(`${query("#ctx").hidden} ${region().getAttribute("data-state")}`);
        },
      );

      openAtPointer();

      expect(capture.names()).toEqual(["open"]);
      expect(capture.reasons()).toEqual(["user"]);
      expect(states).toEqual(["false open"]);
      expect(capture.seen[0]?.bubbles).toBe(true);
      expect(capture.seen[0]?.cancelable).toBe(false);
    });

    it("reports a keyboard open as user", () => {
      pressKey(region(), "ContextMenu", { bubbles: true });

      expect(capture.reasons()).toEqual(["user"]);
    });

    it("reports activating an item as select", () => {
      openAtPointer();
      capture.clear();

      query<HTMLButtonElement>("#copy").click();

      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["select"]);
    });

    it("reports an outside click as outside", () => {
      openAtPointer();
      capture.clear();

      query<HTMLButtonElement>("#outside").click();

      expect(capture.reasons()).toEqual(["outside"]);
    });

    it("reports Escape as escape", () => {
      openAtPointer();
      capture.clear();

      pressKey(query("#copy"), "Escape", { bubbles: true });

      expect(capture.reasons()).toEqual(["escape"]);
    });

    it("reports the deferred Tab close as focus", async () => {
      openAtPointer();
      capture.clear();

      pressKey(query("#copy"), "Tab", { bubbles: true });
      expect(capture.seen).toEqual([]);
      await tick();

      expect(capture.reasons()).toEqual(["focus"]);
    });

    it("stays silent for a repeated open at a new coordinate", () => {
      openAtPointer();
      capture.clear();

      openAtPointer();

      expect(capture.seen).toEqual([]);
    });

    it("stays silent while connect normalizes an authored-open menu", async () => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = `
        <div data-controller="stimeo--context-menu">
          <div id="region" data-stimeo--context-menu-target="region" data-state="open"></div>
          <ul id="ctx" role="menu" data-stimeo--context-menu-target="menu"></ul>
        </div>`;
      const fresh = captureStateEvents("stimeo--context-menu");
      application = Application.start();
      application.register("stimeo--context-menu", ContextMenuController);
      await tick();

      expect(query("#ctx").hidden).toBe(true);
      expect(fresh.seen).toEqual([]);
      fresh.stop();
    });

    it("stays silent through a disconnect and a Turbo-style reconnect", async () => {
      openAtPointer();
      capture.clear();

      const element = query("[data-controller='stimeo--context-menu']");
      element.remove();
      await tick();
      document.body.append(element);
      await tick();

      expect(query("#ctx").hidden).toBe(true);
      expect(capture.seen).toEqual([]);
    });
  });

  // --- Re-entry from a subscriber ---

  describe("re-entry from a subscriber", () => {
    it("leaves no focus inside the menu when the open handler closes it again", () => {
      const host = query("[data-controller='stimeo--context-menu']");
      const instance = application.getControllerForElementAndIdentifier(
        host,
        "stimeo--context-menu",
      );
      if (!(instance instanceof ContextMenuController)) throw new Error("controller not found");
      host.addEventListener("stimeo--context-menu:open", () => instance.activate());

      region().dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 8 }),
      );

      expect(query("#ctx").hidden).toBe(true);
      expect(query("#ctx").contains(document.activeElement)).toBe(false);
    });
  });
  describe("element action source", () => {
    const instance = () => {
      const value = application.getControllerForElementAndIdentifier(
        query("[data-controller='stimeo--context-menu']"),
        "stimeo--context-menu",
      );
      if (!(value instanceof ContextMenuController)) throw new Error("Context menu not connected");
      return value;
    };

    it.each([true, false])(
      "uses the region geometry only when its target exists (%s)",
      (present) => {
        const anchor = region();
        vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 40, 80, 100));
        if (!present) anchor.removeAttribute("data-stimeo--context-menu-target");
        instance().open();
        expect(menu().style.getPropertyValue("--stimeo--context-menu-x")).toBe(
          present ? "60px" : "0px",
        );
        expect(menu().style.getPropertyValue("--stimeo--context-menu-y")).toBe(
          present ? "90px" : "0px",
        );
        expect(document.activeElement).toBe(query("#copy"));
        instance().activate();
        const key = keyEvent("ContextMenu", { cancelable: true });
        instance().onRegionKeydown(key);
        expect(key.defaultPrevented).toBe(true);
        expect(menu().hidden).toBe(false);
        expect(menu().style.getPropertyValue("--stimeo--context-menu-x")).toBe(
          present ? "60px" : "0px",
        );
        expect(menu().style.getPropertyValue("--stimeo--context-menu-y")).toBe(
          present ? "90px" : "0px",
        );
      },
    );

    it.each(["open", "close"])("tolerates a removed menu target when asked to %s", (operation) => {
      instance().open();
      expect(menu().hidden).toBe(false);
      instance().activate();
      expect(menu().hidden).toBe(true);
      const removed = menu();
      removed.removeAttribute("data-stimeo--context-menu-target");
      expect(() =>
        operation === "open" ? instance().open() : instance().activate(),
      ).not.toThrow();
      expect(removed.hidden).toBe(true);
    });

    it.each(["unowned", "owned"])(
      "moves up from an %s key host with a normal forward control",
      (kind) => {
        instance().open();
        const host = kind === "owned" ? query("#paste") : query("#outside");
        host.addEventListener("probe", (event) => instance().onItemKeydown(event as KeyboardEvent));
        host.dispatchEvent(new KeyboardEvent("probe", { key: "ArrowUp", cancelable: true }));
        expect(document.activeElement).toBe(query(kind === "owned" ? "#copy" : "#del"));
        pressKey(query("#copy"), "ArrowDown", { bubbles: true });
        expect(document.activeElement).toBe(query("#paste"));
      },
    );

    it("opens from an external anchor as api and focuses the new menu", () => {
      const seen = captureStateEvents("stimeo--context-menu");
      try {
        contextmenu(20, 30);
        expect(seen.reasons()).toEqual(["user"]);
        pressKey(query("#copy"), "Escape", { bubbles: true });
        expect(menu().hidden).toBe(true);
        seen.clear();
        query("#outside").focus();
        instance().open(query("#outside"));
        expect(menu().hidden).toBe(false);
        expect(document.activeElement).toBe(query("#copy"));
        expect(seen.reasons()).toEqual(["api"]);
      } finally {
        seen.stop();
      }
    });

    it("opens with no argument using the region center", () => {
      instance().open();
      expect(menu().hidden).toBe(false);
      expect(document.activeElement).toBe(query("#copy"));
    });
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
               role="group" aria-label="Files"
               aria-keyshortcuts="Shift+F10" aria-controls="ctx"
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
  const press = (el: HTMLElement, key: string): KeyboardEvent => {
    const event = keyEvent(key, { bubbles: true, cancelable: true });
    pressKey(el, event);
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

  it("blocks aria-disabled activation before the handlers inside the controller element", () => {
    const disabled = query<HTMLButtonElement>("#copy");
    let consumerActivations = 0;
    disabled.addEventListener("click", () => consumerActivations++);
    contextmenu();

    disabled.click();

    expect(consumerActivations).toBe(0);
    expect(menu().hidden).toBe(false);
    expect(region().getAttribute("data-state")).toBe("open");
  });

  it("cancels the default action of an aria-disabled item", () => {
    // A command item that is a link or a submit button would otherwise still
    // navigate or submit while announcing itself as unavailable.
    contextmenu();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });

    query("#copy").dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
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

  /**
   * `activate` refuses an item that cannot be activated on every path that reaches it.
   * A refused call leaves the menu open, dispatches nothing, moves no focus and leaves
   * the event uncancelled. The click is the reference row: the capture pass stops it on
   * an `aria-disabled` item and the platform does not deliver it to a natively disabled
   * one. A `probe` event stands for any other binding, read on the item itself and on
   * an ancestor it bubbles to.
   */
  describe("activation refused on every path", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    beforeEach(() => {
      capture = captureStateEvents("stimeo--context-menu");
    });

    afterEach(() => {
      capture.stop();
    });

    const routes = ["click", "probe on the item", "probe bubbled to the menu"] as const;
    type Route = (typeof routes)[number];
    const constrained = {
      "aria-disabled": "#copy",
      "natively disabled": "#cut",
      hidden: "#hidden",
    } as const;
    type Constraint = keyof typeof constrained;
    const constraints = Object.keys(constrained) as Constraint[];

    const controller = () => {
      const instance = application.getControllerForElementAndIdentifier(
        query("[data-controller='stimeo--context-menu']"),
        "stimeo--context-menu",
      );
      if (!(instance instanceof ContextMenuController)) throw new Error("controller not found");
      return instance;
    };

    /** Binds the click action on an item whose fixture markup carries only the keydown one. */
    const bindClick = async (item: HTMLElement) => {
      const actions = item.getAttribute("data-action") ?? "";
      if (actions.includes("click->")) return;
      item.setAttribute("data-action", `click->stimeo--context-menu#activate ${actions}`);
      await tick();
    };

    /** Delivers one gesture on `item` along `route` and returns the event dispatched. */
    const deliver = (route: Route, item: HTMLElement): Event => {
      if (route === "click") {
        const click = new MouseEvent("click", { bubbles: true, cancelable: true });
        item.dispatchEvent(click);
        return click;
      }
      const receiver = route === "probe on the item" ? item : menu();
      receiver.addEventListener("probe", (event) => controller().activate(event), { once: true });
      const probe = new Event("probe", { bubbles: true, cancelable: true });
      item.dispatchEvent(probe);
      return probe;
    };

    const expectClosedBySelect = () => {
      expect(menu().hidden).toBe(true);
      expect(region().getAttribute("data-state")).toBe("closed");
      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["select"]);
      expect(document.activeElement).toBe(region());
    };

    it.each(routes)("closes as select for an enabled item reached by %s", async (route) => {
      const item = query("#paste");
      await bindClick(item);
      contextmenu();
      capture.clear();

      const event = deliver(route, item);

      expectClosedBySelect();
      expect(event.defaultPrevented).toBe(false);
    });

    it.each(
      constraints.flatMap((constraint) => routes.map((route) => [constraint, route] as const)),
    )("does nothing for the %s item reached by %s", async (constraint, route) => {
      const item = query(constrained[constraint]);
      await bindClick(item);
      contextmenu();
      const focused = document.activeElement;
      capture.clear();
      const root = query("[data-controller='stimeo--context-menu']");
      const above = vi.fn();
      root.addEventListener("probe", above);

      const event = deliver(route, item);

      root.removeEventListener("probe", above);
      expect(menu().hidden).toBe(false);
      expect(region().getAttribute("data-state")).toBe("open");
      expect(capture.seen).toEqual([]);
      expect(document.activeElement).toBe(focused);
      // Only the capture pass cancels anything, and only a click on an aria-disabled item.
      expect(event.defaultPrevented).toBe(route === "click" && constraint === "aria-disabled");
      // A refused probe still bubbles past its receiver to the controller element.
      expect(above).toHaveBeenCalledTimes(route === "click" ? 0 : 1);
    });

    it("closes as select for a call with no event while an aria-disabled item has focus", () => {
      contextmenu();
      expect(document.activeElement).toBe(query("#copy"));
      capture.clear();

      controller().activate();

      expectClosedBySelect();
    });

    it("closes as select for an event that resolves to no item", () => {
      contextmenu();
      capture.clear();
      menu().addEventListener("probe", (event) => controller().activate(event), { once: true });

      menu().dispatchEvent(new Event("probe", { bubbles: true }));

      expectClosedBySelect();
    });
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

/**
 * A click is judged once, in the capture pass, before the handlers inside the
 * controller element run, and `activate` acts on that verdict when the item it resolves
 * is among those the verdict was taken for. A consumer handler that marks the item
 * unavailable while the click runs — a guard against a second submission — therefore
 * does not take back the activation the click started. An item the verdict was not
 * taken for — a handler moved the target into another item — is judged when `activate`
 * runs, as is any other event.
 */
describe("ContextMenuController activation judged when a click starts", () => {
  let application: Application;
  let capture: ReturnType<typeof captureStateEvents>;

  beforeEach(async () => {
    // The items carry no click action of their own; a test binds one after its own
    // handler, so that handler runs first on the item.
    document.body.innerHTML = `
      <div data-controller="stimeo--context-menu">
        <div id="region" data-stimeo--context-menu-target="region" tabindex="0"
             role="group" aria-label="Files"
             aria-keyshortcuts="Shift+F10" aria-controls="ctx"
             data-action="contextmenu->stimeo--context-menu#open
                          keydown->stimeo--context-menu#onRegionKeydown">Area</div>
        <ul id="ctx" role="menu" data-stimeo--context-menu-target="menu" hidden>
          <li role="none"><button id="save" role="menuitem" tabindex="-1"
                data-stimeo--context-menu-target="item"
                data-action="keydown->stimeo--context-menu#onItemKeydown"><span
                id="save-label">Save</span></button></li>
          <li role="none"><button id="export" role="menuitem" tabindex="-1" aria-disabled="true"
                data-stimeo--context-menu-target="item"
                data-action="keydown->stimeo--context-menu#onItemKeydown">Export</button></li>
          <li role="none"><button id="print" role="menuitem" tabindex="-1"
                data-stimeo--context-menu-target="item"
                data-action="keydown->stimeo--context-menu#onItemKeydown">Print</button></li>
        </ul>
      </div>`;
    application = Application.start();
    application.register("stimeo--context-menu", ContextMenuController);
    await tick();
    capture = captureStateEvents("stimeo--context-menu");
  });

  afterEach(() => {
    capture.stop();
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const region = () => query("#region");
  const menu = () => query("#ctx");
  const save = () => query<HTMLButtonElement>("#save");

  const controller = () => {
    const instance = application.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--context-menu']"),
      "stimeo--context-menu",
    );
    if (!(instance instanceof ContextMenuController)) throw new Error("controller not found");
    return instance;
  };

  const marks = {
    disabled: (item: HTMLButtonElement) => {
      item.disabled = true;
    },
    "aria-disabled": (item: HTMLButtonElement) => item.setAttribute("aria-disabled", "true"),
  } as const;
  type Mark = keyof typeof marks;
  const markNames = Object.keys(marks) as Mark[];

  /** Binds Save's click action after `handler` was added, so the handler runs first. */
  const wire = async (handler: (event: Event) => void): Promise<void> => {
    save().addEventListener("click", handler);
    save().setAttribute(
      "data-action",
      "click->stimeo--context-menu#activate keydown->stimeo--context-menu#onItemKeydown",
    );
    await tick();
  };

  const open = () => {
    region().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 0, clientY: 0 }),
    );
    capture.clear();
  };

  const expectClosedBySelect = () => {
    expect(menu().hidden).toBe(true);
    expect(region().getAttribute("data-state")).toBe("closed");
    expect(capture.names()).toEqual(["close"]);
    expect(capture.reasons()).toEqual(["select"]);
    expect(document.activeElement).toBe(region());
  };

  const expectUntouched = (focused: Element | null) => {
    expect(menu().hidden).toBe(false);
    expect(region().getAttribute("data-state")).toBe("open");
    expect(capture.seen).toEqual([]);
    expect(document.activeElement).toBe(focused);
  };

  it.each(markNames)(
    "closes as select when a handler marks the item %s during its click",
    async (mark) => {
      const command = vi.fn(() => marks[mark](save()));
      await wire(command);
      open();

      save().click();

      expect(command).toHaveBeenCalledOnce();
      expectClosedBySelect();
    },
  );

  it("closes as select when the handler changes nothing", async () => {
    const command = vi.fn();
    await wire(command);
    open();

    save().click();

    expect(command).toHaveBeenCalledOnce();
    expectClosedBySelect();
  });

  it("keeps refusing a click that started on a hidden item a handler shows", async () => {
    const command = vi.fn(() => {
      save().hidden = false;
    });
    await wire(command);
    open();
    save().hidden = true;
    const focused = document.activeElement;

    save().click();

    expect(command).toHaveBeenCalledOnce();
    expectUntouched(focused);
  });

  it.each(markNames)(
    "refuses a probe whose handler marks the item %s before activate runs",
    (mark) => {
      open();
      const focused = document.activeElement;
      save().addEventListener("probe", () => marks[mark](save()));
      save().addEventListener("probe", (event) => controller().activate(event));

      save().dispatchEvent(new Event("probe", { bubbles: true }));

      expectUntouched(focused);
    },
  );

  it.each([
    ["refuses", "an aria-disabled", "#export"],
    ["closes for", "an enabled", "#print"],
  ] as const)(
    "%s %s item a handler moves the click target into before activate runs",
    async (outcome, _state, destination) => {
      const label = query("#save-label");
      // The capture pass judged Save; `activate` then resolves the item the target now
      // lies in, which it judges when it runs.
      label.addEventListener("click", () => query(destination).append(label));
      await wire(() => {});
      open();
      const focused = document.activeElement;

      label.click();

      if (outcome === "refuses") expectUntouched(focused);
      else expectClosedBySelect();
    },
  );
});

/**
 * Items nested in one another. An activation is refused when any item this menu owns
 * that holds the event's target refuses it, so a `hidden`, natively `disabled` or
 * `aria-disabled` inner item refuses what lands inside it whichever element's action
 * receives the event, and an outer item that refuses refuses what lands inside it too.
 * A click any `aria-disabled` item holds is stopped before the handlers inside
 * the controller element run. What lands on the outer item outside the inner one is
 * judged on the outer item alone.
 */
describe("ContextMenuController with a nested item pair", () => {
  let application: Application;

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("swallows a click on the aria-disabled inner item", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--context-menu">
        <div id="region" data-stimeo--context-menu-target="region" tabindex="0"
             role="group" aria-label="Files" aria-keyshortcuts="Shift+F10" aria-controls="ctx"
             data-action="contextmenu->stimeo--context-menu#open">Area</div>
        <div id="ctx" role="menu" data-stimeo--context-menu-target="menu" hidden>
          <div id="outer" role="menuitem" tabindex="-1" data-stimeo--context-menu-target="item">
            <span id="inner" aria-disabled="true" data-stimeo--context-menu-target="item"
                  data-action="click->stimeo--context-menu#activate">Run</span>
          </div>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--context-menu", ContextMenuController);
    await tick();
    const region = query("#region");
    const inner = query("#inner");
    const menu = query("#ctx");
    region.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const command = vi.fn();
    inner.addEventListener("click", command);
    const capture = captureStateEvents("stimeo--context-menu");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });

    inner.dispatchEvent(click);
    capture.stop();

    expect(command).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(true);
    expect(capture.names()).toEqual([]);
    expect(menu.hidden).toBe(false);
  });

  /** The state the inner item carries; `enabled` with an enabled outer is the positive control. */
  const INNER = {
    enabled: "",
    "aria-disabled": 'aria-disabled="true"',
    hidden: "hidden",
    disabled: "disabled",
  } as const;
  type Inner = keyof typeof INNER;

  /** The state the outer item carries; its `aria-disabled` reaches the inner item too. */
  const OUTER = { enabled: "", "aria-disabled": 'aria-disabled="true"', hidden: "hidden" } as const;
  type Outer = keyof typeof OUTER;

  /**
   * Where an event lands and which element's action receives it. `label` is the text
   * holder inside the inner item. A natively `disabled` button is dispatched no click of
   * its own, while happy-dom delivers one dispatched on content inside it, so a click
   * inside the inner item lands on the label.
   */
  const ROUTES = {
    "a click inside the inner, received by the inner": {
      kind: "click",
      at: "label",
      receiver: "inner",
    },
    "a click inside the inner, received by the outer": {
      kind: "click",
      at: "label",
      receiver: "outer",
    },
    "a click inside the inner, received by the menu": {
      kind: "click",
      at: "label",
      receiver: "ctx",
    },
    "a probe inside the inner, received by the inner": {
      kind: "probe",
      at: "label",
      receiver: "inner",
    },
    "a probe inside the inner, received by the outer": {
      kind: "probe",
      at: "label",
      receiver: "outer",
    },
    "a probe inside the inner, received by the menu": {
      kind: "probe",
      at: "label",
      receiver: "ctx",
    },
    "a click on the outer": { kind: "click", at: "outer", receiver: "outer" },
    "a probe on the outer": { kind: "probe", at: "outer", receiver: "outer" },
  } as const;
  type Route = keyof typeof ROUTES;

  /** Whether `route` lands inside the inner item. */
  const insideInner = (route: Route): boolean => ROUTES[route].at !== "outer";

  /** Whether an item holding the route's target refuses activation. */
  const refuses = (inner: Inner, outer: Outer, route: Route): boolean =>
    outer !== "enabled" || (insideInner(route) && inner !== "enabled");

  /** Whether the capture pass stops `route`: a click an `aria-disabled` item holds. */
  const stops = (inner: Inner, outer: Outer, route: Route): boolean =>
    ROUTES[route].kind === "click" &&
    (outer === "aria-disabled" || (insideInner(route) && inner === "aria-disabled"));

  const ROWS = (Object.keys(INNER) as Inner[]).flatMap((inner) =>
    (Object.keys(OUTER) as Outer[]).flatMap((outer) =>
      (Object.keys(ROUTES) as Route[]).map((route) => ({
        inner,
        outer,
        route,
        outcome: refuses(inner, outer, route) ? "refuses" : "activates",
      })),
    ),
  );

  it.each(ROWS)(
    "$outcome the $inner inner item in the $outer outer item through $route",
    async ({ inner, outer, route }) => {
      document.body.innerHTML = `
        <div id="root" data-controller="stimeo--context-menu">
          <div id="region" data-stimeo--context-menu-target="region" tabindex="0"
               role="group" aria-label="Files" aria-keyshortcuts="Shift+F10" aria-controls="ctx"
               data-action="contextmenu->stimeo--context-menu#open">Area</div>
          <div id="ctx" role="menu" data-stimeo--context-menu-target="menu" hidden>
            <div id="outer" role="menuitem" tabindex="-1" ${OUTER[outer]}
                 data-stimeo--context-menu-target="item">
              <button id="inner" role="menuitem" tabindex="-1" ${INNER[inner]}
                      data-stimeo--context-menu-target="item"><span id="label">Run</span></button>
            </div>
          </div>
        </div>`;
      application = Application.start();
      application.register("stimeo--context-menu", ContextMenuController);
      await tick();
      const controller = application.getControllerForElementAndIdentifier(
        query("#root"),
        "stimeo--context-menu",
      );
      if (!(controller instanceof ContextMenuController)) throw new Error("controller not found");
      query("#region").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
      const focused = document.activeElement;
      const { kind, at, receiver } = ROUTES[route];
      // A consumer command listens where the event lands, so a click the capture pass
      // stops shows as a command that never ran.
      const command = vi.fn();
      query(`#${at}`).addEventListener(kind, command);
      query(`#${receiver}`).addEventListener(kind, (event) => controller.activate(event));
      const capture = captureStateEvents("stimeo--context-menu");
      const event =
        kind === "click"
          ? new MouseEvent("click", { bubbles: true, cancelable: true })
          : new Event("probe", { bubbles: true, cancelable: true });

      query(`#${at}`).dispatchEvent(event);
      capture.stop();

      const stopped = stops(inner, outer, route);
      expect(event.defaultPrevented).toBe(stopped);
      expect(command).toHaveBeenCalledTimes(stopped ? 0 : 1);
      if (refuses(inner, outer, route)) {
        expect(capture.seen).toEqual([]);
        expect(query("#ctx").hidden).toBe(false);
        expect(query("#region").getAttribute("data-state")).toBe("open");
        expect(document.activeElement).toBe(focused);
      } else {
        expect(capture.names()).toEqual(["close"]);
        expect(capture.reasons()).toEqual(["select"]);
        expect(query("#ctx").hidden).toBe(true);
        expect(document.activeElement).toBe(query("#region"));
      }
    },
  );
});

/**
 * `aria-disabled="true"` on an ancestor disables the items inside it, as ARIA defines the
 * state for every focusable descendant: a click on such an item is stopped before the
 * handlers inside the controller element run, and any other event is refused. The
 * items stay in the roving order.
 */
describe("ContextMenuController aria-disabled inherited from an ancestor", () => {
  let application: Application;
  let capture: ReturnType<typeof captureStateEvents>;

  beforeEach(async () => {
    const item = (id: string, label: string) => `
      <button id="${id}" role="menuitem" tabindex="-1"
              data-stimeo--context-menu-target="item"
              data-action="click->stimeo--context-menu#activate
                           keydown->stimeo--context-menu#onItemKeydown">${label}</button>`;
    document.body.innerHTML = `
      <section id="outer">
        <div id="root" data-controller="stimeo--context-menu">
          <div id="region" data-stimeo--context-menu-target="region" tabindex="0"
               role="group" aria-label="Files"
               aria-keyshortcuts="Shift+F10" aria-controls="ctx"
               data-action="contextmenu->stimeo--context-menu#open
                            keydown->stimeo--context-menu#onRegionKeydown">Area</div>
          <div id="ctx" role="menu" data-stimeo--context-menu-target="menu" hidden>
            <div id="group" role="group" aria-label="Clipboard">
              ${item("cut", "Cut")}
              ${item("copy", "Copy")}
            </div>
            ${item("rename", "Rename")}
          </div>
        </div>
      </section>`;
    application = Application.start();
    application.register("stimeo--context-menu", ContextMenuController);
    await tick();
    capture = captureStateEvents("stimeo--context-menu");
  });

  afterEach(() => {
    capture.stop();
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const region = () => query("#region");
  const menu = () => query("#ctx");

  const controller = () => {
    const instance = application.getControllerForElementAndIdentifier(
      query("#root"),
      "stimeo--context-menu",
    );
    if (!(instance instanceof ContextMenuController)) throw new Error("controller not found");
    return instance;
  };

  const ancestors = ["group", "ctx", "root", "outer"] as const;
  const routes = ["click", "probe on the item", "probe bubbled to the menu"] as const;
  type Route = (typeof routes)[number];

  /** Delivers one gesture on `item` along `route` and returns the event dispatched. */
  const deliver = (route: Route, item: HTMLElement): Event => {
    if (route === "click") {
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      item.dispatchEvent(click);
      return click;
    }
    const receiver = route === "probe on the item" ? item : menu();
    receiver.addEventListener("probe", (event) => controller().activate(event), { once: true });
    const probe = new Event("probe", { bubbles: true, cancelable: true });
    item.dispatchEvent(probe);
    return probe;
  };

  const expectClosedBySelect = () => {
    expect(menu().hidden).toBe(true);
    expect(region().getAttribute("data-state")).toBe("closed");
    expect(capture.names()).toEqual(["close"]);
    expect(capture.reasons()).toEqual(["select"]);
    expect(document.activeElement).toBe(region());
  };

  /** Opens the menu with focus on `item`, then forgets the open. */
  const openOn = (item: HTMLElement) => {
    controller().open();
    item.focus();
    capture.clear();
  };

  it.each(ancestors.flatMap((ancestor) => routes.map((route) => [ancestor, route] as const)))(
    "refuses an item under an aria-disabled #%s reached by %s",
    (ancestor, route) => {
      query(`#${ancestor}`).setAttribute("aria-disabled", "true");
      const copy = query("#copy");
      openOn(copy);
      const command = vi.fn();
      copy.addEventListener("click", command);
      const above = vi.fn();
      query("#root").addEventListener("probe", above);

      const event = deliver(route, copy);

      query("#root").removeEventListener("probe", above);
      expect(menu().hidden).toBe(false);
      expect(region().getAttribute("data-state")).toBe("open");
      expect(capture.seen).toEqual([]);
      expect(document.activeElement).toBe(copy);
      // The capture pass stops the click before the consumer's handler and cancels it.
      expect(command).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(route === "click");
      expect(above).toHaveBeenCalledTimes(route === "click" ? 0 : 1);
    },
  );

  it.each(routes)("activates an item outside the aria-disabled group reached by %s", (route) => {
    query("#group").setAttribute("aria-disabled", "true");
    openOn(query("#rename"));

    const event = deliver(route, query("#rename"));

    expectClosedBySelect();
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(ancestors.flatMap((ancestor) => routes.map((route) => [ancestor, route] as const)))(
    'activates an item under #%s carrying aria-disabled="false" reached by %s',
    (ancestor, route) => {
      query(`#${ancestor}`).setAttribute("aria-disabled", "false");
      openOn(query("#copy"));

      deliver(route, query("#copy"));

      expectClosedBySelect();
    },
  );

  it("keeps the items of an aria-disabled group in the roving order", () => {
    query("#group").setAttribute("aria-disabled", "true");
    controller().open();
    expect(document.activeElement).toBe(query("#cut"));

    pressKey(query("#cut"), "ArrowDown", { bubbles: true });
    expect(document.activeElement).toBe(query("#copy"));
    pressKey(query("#copy"), "ArrowDown", { bubbles: true });
    expect(document.activeElement).toBe(query("#rename"));
    pressKey(query("#rename"), "Home", { bubbles: true });
    expect(document.activeElement).toBe(query("#cut"));
    pressKey(query("#cut"), "End", { bubbles: true });
    expect(document.activeElement).toBe(query("#rename"));
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
               role="group" aria-label="Files"
               aria-keyshortcuts="Shift+F10" aria-controls="ctx3"
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
    // Freeze the whole ordered array (not a name-only `toContain`) so a lost
    // region role or name, a dropped key shortcut, a lost menu role, a dropped
    // item, or reordering surfaces as a diff.
    expect(spoken).toEqual([
      "main",
      "group, Files, 1 control, key shortcuts Shift+F10",
      "Right-click for actions",
      "end of group, Files, 1 control, key shortcuts Shift+F10",
      "menu, File actions, orientated vertically",
      "menuitem, Copy, position 1, set size 2",
      "menuitem, Delete, position 2, set size 2",
    ]);
  });
});
