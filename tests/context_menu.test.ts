import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenuController } from "../src/controllers/context_menu_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
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
    vi.useRealTimers();
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
      const dismissal = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      region().dispatchEvent(dismissal);
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

      // Drive the callbacks directly: happy-dom delivers target callbacks unreliably.
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
      region().dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true }));

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

      query("#copy").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      expect(capture.reasons()).toEqual(["escape"]);
    });

    it("reports the deferred Tab close as focus", async () => {
      openAtPointer();
      capture.clear();

      query("#copy").dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
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
        const key = new KeyboardEvent("keydown", { key: "ContextMenu", cancelable: true });
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
        query("#copy").dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
        expect(document.activeElement).toBe(query("#paste"));
      },
    );

    it("opens from an external anchor as api and focuses the new menu", () => {
      const seen = captureStateEvents("stimeo--context-menu");
      try {
        contextmenu(20, 30);
        expect(seen.reasons()).toEqual(["user"]);
        query("#copy").dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
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
