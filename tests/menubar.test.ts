import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MenubarController } from "../src/controllers/menubar_controller";
import { EscapeLayer } from "../src/utils/escape_layer";
import { auditA11y, expectNoA11yViolations } from "./helpers/a11y";
import { press as keyboardPress, keyEvent, typeKey } from "./helpers/keyboard";
import { recordListeners } from "./helpers/listeners";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents } from "./helpers/state_events";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link MenubarController}: the APG menubar — roving across
 * top items, opening menus with the keyboard, in-menu navigation/typeahead,
 * jumping to adjacent menus, and Escape/Tab/outside-click/activation closing with
 * focus returned to the owning top item.
 */

/** One `role="menuitem"` command; `attributes` injects edge-case state (disabled, hidden). */
const item = (id: string, label: string, attributes = "") => `
  <li role="none">
    <button id="${id}" role="menuitem" tabindex="-1" ${attributes}
            data-stimeo--menubar-target="item"
            data-action="click->stimeo--menubar#activate
                         keydown->stimeo--menubar#onItemKeydown">${label}</button>
  </li>`;

/**
 * One top item. Passing `null` for `menuId` builds a **plain command** — a top
 * item with no popup at all, which the markup contract allows next to
 * popup-bearing tops. It therefore carries none of the popup ARIA
 * (`aria-haspopup` / `aria-expanded` / `aria-controls`): advertising a popup it
 * does not have is exactly what the contract forbids.
 */
const top = (id: string, label: string, menuId: string | null, attributes = "") => `
  <button id="${id}" role="menuitem" ${attributes}
          ${menuId ? `aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}"` : ""}
          data-stimeo--menubar-target="top"
          data-action="click->stimeo--menubar#toggle
                       keydown->stimeo--menubar#onTopKeydown">${label}</button>`;

/** A `role="menu"` popup holding `items`; `attributes` injects state (`aria-busy`). */
const menu = (id: string, label: string, items: string, attributes = "") => `
  <ul id="${id}" role="menu" aria-label="${label}" hidden ${attributes}
      data-stimeo--menubar-target="menu">
    ${items}
  </ul>`;

const markup = `
  <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
    ${top("file", "File", "m-file")}
    ${menu("m-file", "File", `${item("new", "New")}${item("open", "Open")}${item("save", "Save")}`)}
    ${top("edit", "Edit", "m-edit")}
    ${menu("m-edit", "Edit", `${item("cut", "Cut")}${item("copy", "Copy")}${item("paste", "Paste")}`)}
  </div>`;

/** Mounts `html` and starts a Stimulus application with the controller registered. */
const mount = async (html: string): Promise<Application> => {
  document.body.innerHTML = html;
  const application = Application.start();
  application.register("stimeo--menubar", MenubarController);
  await tick();
  return application;
};

const byId = (id: string) => document.getElementById(id) as HTMLElement;
const expanded = (id: string) => byId(id).getAttribute("aria-expanded");
const menuHidden = (id: string) => byId(id).hidden;
/** The top items currently in the Tab sequence — the roving contract allows 0 or 1. */
const tabStops = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--menubar-target='top']")).filter(
    (element) => element.tabIndex === 0,
  );
/**
 * Focuses an element and dispatches a bubbling, **cancelable** `keydown` (top item or menu
 * item alike) and returns the event. Cancelable matters: `defaultPrevented` is the
 * only observable proof that the arrow keys suppress the browser's own scrolling,
 * and a non-cancelable event would report `false` no matter what the handler does.
 */
const key = (id: string, k: string): KeyboardEvent => keyboardPress(byId(id), k);
/**
 * Places real DOM focus on `id` before dispatching the key: the handler then reads
 * the same `document.activeElement` a browser would, and "where did focus land"
 * becomes a meaningful assertion.
 */
const pressOn = (id: string, k: string): KeyboardEvent => keyboardPress(byId(id), k);

/** The controller instance on the page's first menubar. */
const menubarOf = (application: Application): MenubarController => {
  const root = document.querySelector("[data-controller='stimeo--menubar']");
  const instance =
    root && application.getControllerForElementAndIdentifier(root, "stimeo--menubar");
  if (!(instance instanceof MenubarController)) throw new Error("Expected menubar controller");
  return instance;
};

describe("MenubarController", () => {
  let application: Application;

  beforeEach(async () => {
    application = await mount(markup);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

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
  )("yields an unassigned Home/End chord (%s, %s) on a top item", async (key, _modifier, init) => {
    const element = byId("file").parentElement;
    if (!element) throw new Error("Expected menubar root");
    element.insertAdjacentHTML("beforeend", top("view", "View", null));
    await tick();
    keyboardPress(byId("file"), "ArrowRight");
    const current = byId("edit");
    current.focus();
    const events: Event[] = [];
    for (const name of ["stimeo--menubar:open", "stimeo--menubar:close"]) {
      element.addEventListener(name, (event) => events.push(event));
    }
    const before = element.outerHTML;
    const rejected = keyboardPress(current, key, init);
    expect(rejected.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(current);
    expect(element.outerHTML).toBe(before);
    expect(events).toEqual([]);
    expect(tabStops()).toEqual([current]);
    expect(expanded("file")).toBe("false");
    expect(expanded("edit")).toBe("false");
    expect(keyboardPress(current, key).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId(key === "Home" ? "file" : "view"));
  });

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
  )("yields an unassigned Home/End chord (%s, %s) on a menu item", async (key, _modifier, init) => {
    byId("edit").click();
    const current = byId("copy");
    current.focus();
    const element = byId("edit").parentElement;
    if (!element) throw new Error("Expected menubar root");
    const events: Event[] = [];
    for (const name of ["stimeo--menubar:open", "stimeo--menubar:close"]) {
      element.addEventListener(name, (event) => events.push(event));
    }
    const before = element.outerHTML;
    const rejected = keyboardPress(current, key, init);
    expect(rejected.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(current);
    expect(element.outerHTML).toBe(before);
    expect(events).toEqual([]);
    expect(expanded("edit")).toBe("true");
    expect(menuHidden("m-edit")).toBe(false);
    expect(tabStops()).toEqual([byId("edit")]);
    expect(keyboardPress(current, key).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId(key === "Home" ? "cut" : "paste"));
  });

  it("sets the tab stop to a menu opened without first focusing its top item", () => {
    expect(tabStops()).toEqual([byId("file")]);
    byId("edit").click();
    expect(expanded("edit")).toBe("true");
    expect(document.activeElement).toBe(byId("cut"));
    expect(tabStops()).toEqual([byId("edit")]);
  });

  it("keeps focus that moved outside after the focused top was removed", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    byId("file").focus();
    byId("file").remove();
    outside.focus();
    expect(document.activeElement).toBe(outside);
    await tick();
    expect(document.activeElement).toBe(outside);
    expect(tabStops()).toEqual([byId("edit")]);
    byId("edit").click();
    expect(document.activeElement).toBe(byId("cut"));
    byId("m-edit").remove();
    await tick();
    expect(document.activeElement).toBe(byId("edit"));
  });

  it("does not recover an old focus after the user leaves and blurs outside", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    byId("file").focus();
    outside.focus();
    outside.blur();
    expect(document.activeElement).toBe(document.body);
    byId("file").remove();
    await tick();
    expect(document.activeElement).toBe(document.body);
    byId("edit").click();
    expect(document.activeElement).toBe(byId("cut"));
    byId("m-edit").remove();
    await tick();
    expect(document.activeElement).toBe(byId("edit"));
  });

  it("does not reconcile arriving menus after disconnect until reconnect", () => {
    const root = byId("file").parentElement;
    if (!root) throw new Error("Expected menubar");
    const instance = application.getControllerForElementAndIdentifier(root, "stimeo--menubar");
    if (!(instance instanceof MenubarController)) throw new Error("Expected menubar controller");
    instance.disconnect();
    byId("file").setAttribute("aria-expanded", "true");
    expect(menuHidden("m-file")).toBe(true);
    instance.menuTargetConnected();
    expect(expanded("file")).toBe("true");
    instance.connect();
    expect(expanded("file")).toBe("false");
  });

  it("does not navigate horizontally from a popup whose owner disappeared", () => {
    byId("file").click();
    byId("file").removeAttribute("aria-controls");
    const errors = vi.spyOn(application, "handleError").mockImplementation(() => {});
    key("new", "ArrowRight");
    expect(errors.mock.calls.length).toBe(0);
    expect(document.activeElement).toBe(byId("new"));
    expect(expanded("edit")).toBe("false");
    byId("file").setAttribute("aria-controls", "m-file");
    key("new", "ArrowRight");
    expect(expanded("edit")).toBe("true");
    expect(document.activeElement).toBe(byId("cut"));
  });

  it("leaves keys on a newly hidden top unclaimed without moving focus", () => {
    byId("file").focus();
    byId("file").hidden = true;
    /** Keep focus on the now-hidden origin while probing the reachability guard. */
    const event = typeKey(byId("file"), "ArrowRight");
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(byId("file"));
    byId("file").hidden = false;
    expect(key("file", "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId("edit"));
  });

  it("reserves a deferred Tab close only while a menu is open", () => {
    vi.useFakeTimers();
    try {
      expect(vi.getTimerCount()).toBe(0);
      pressOn("file", "Tab");
      expect(vi.getTimerCount()).toBe(0);
      byId("file").click();
      expect(expanded("file")).toBe("true");
      key("new", "Tab");
      expect(vi.getTimerCount()).toBe(1);
      expect(expanded("file")).toBe("true");
      vi.runOnlyPendingTimers();
      expect(expanded("file")).toBe("false");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not switch menus from a newly hidden owner", () => {
    byId("file").click();
    byId("file").hidden = true;
    // Preserve item focus while the hidden owner makes the synthetic key inert.
    typeKey(byId("new"), "ArrowRight");
    expect(expanded("edit")).toBe("false");
    expect(document.activeElement).toBe(byId("new"));
    byId("file").hidden = false;
    key("new", "ArrowRight");
    expect(expanded("edit")).toBe("true");
    expect(document.activeElement).toBe(byId("cut"));
  });

  it("keeps the tab stop when activating a command whose popup owner disappeared", () => {
    byId("file").click();
    byId("file").removeAttribute("aria-controls");
    byId("new").click();
    expect(tabStops()).toEqual([byId("file")]);
    expect(document.activeElement).toBe(byId("new"));
  });

  it("activates a command moved outside a popup without a missing-menu error", () => {
    const errors = vi.spyOn(application, "handleError").mockImplementation(() => {});
    byId("file").parentElement?.appendChild(byId("new"));
    byId("new").focus();
    const event = key("new", "ArrowDown");
    expect(event.defaultPrevented).toBe(false);
    expect(errors.mock.calls.length).toBe(0);
    byId("new").click();
    expect(errors.mock.calls.length).toBe(0);
    expect(tabStops()).toEqual([byId("file")]);
    expect(document.activeElement).toBe(byId("new"));
  });

  it("ignores an empty controls declaration even when a menu has no id", () => {
    byId("file").setAttribute("aria-controls", "");
    const popup = byId("m-file");
    popup.removeAttribute("id");
    byId("file").click();
    expect(popup.hidden).toBe(true);
    expect(expanded("file")).toBe("false");
  });

  it("handles Escape while a focused popup temporarily has no owner", () => {
    byId("file").click();
    byId("file").removeAttribute("aria-controls");
    const errors: unknown[] = [];
    const listener = (event: ErrorEvent) => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", listener);
    try {
      key("new", "Escape");
      expect(errors).toEqual([]);
      expect(document.activeElement).toBe(byId("new"));
      expect(tabStops()).toEqual([byId("file")]);
    } finally {
      window.removeEventListener("error", listener);
    }
  });

  it("reverses the horizontal arrows under RTL, on the bar and inside a menu", async () => {
    // Logical direction: APG describes these as "next / previous", so the pair
    // reverses with the writing direction. `dir="rtl"` is the authoring contract,
    // but happy-dom does not resolve it into the computed style, so the direction
    // is set on the style directly.
    // Three top items, not the default two: with two, wrapping makes ArrowLeft and
    // ArrowRight land on the same item, and the case could not tell the directions
    // apart.
    disconnectAndStopApplication(application);
    application = await mount(`
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        ${top("file", "File", "m-file")}
        ${menu("m-file", "File", `${item("new", "New")}`)}
        ${top("edit", "Edit", "m-edit")}
        ${menu("m-edit", "Edit", `${item("cut", "Cut")}`)}
        ${top("view", "View", "m-view")}
        ${menu("m-view", "View", `${item("zoom", "Zoom")}`)}
      </div>`);
    (document.querySelector("[role='menubar']") as HTMLElement).style.direction = "rtl";

    pressOn("file", "ArrowLeft"); // "next" top item under RTL
    expect(document.activeElement).toBe(byId("edit"));

    pressOn("edit", "ArrowRight"); // "previous" — back, not on to "view"
    expect(document.activeElement).toBe(byId("file"));

    // Inside an open menu the pair moves to the adjacent menu; same reversal.
    byId("file").click();
    pressOn("new", "ArrowLeft");
    expect(expanded("edit")).toBe("true");
    pressOn("cut", "ArrowRight");
    expect(expanded("file")).toBe("true");
    expect(document.activeElement).toBe(byId("new"));
  });

  it("starts with one tab stop, menus closed", () => {
    expect(byId("file").tabIndex).toBe(0);
    expect(byId("edit").tabIndex).toBe(-1);
    expect(menuHidden("m-file")).toBe(true);
    expect(expanded("file")).toBe("false");
  });

  it("opens a menu on click and focuses the first item", () => {
    byId("file").click();
    expect(menuHidden("m-file")).toBe(false);
    expect(expanded("file")).toBe("true");
    expect(document.activeElement).toBe(byId("new"));
  });

  it("toggles the menu closed on a second click", () => {
    byId("file").click();
    byId("file").click();
    expect(menuHidden("m-file")).toBe(true);
    expect(expanded("file")).toBe("false");
  });

  it("opens with ArrowDown (first item) and ArrowUp (last item)", () => {
    key("file", "ArrowDown");
    expect(document.activeElement).toBe(byId("new"));
    byId("file").click(); // close
    key("file", "ArrowUp");
    expect(document.activeElement).toBe(byId("save"));
  });

  it("leaves Enter/Space on a top item to the native button click", () => {
    // happy-dom does not synthesize the click a browser fires for Enter/Space on a
    // <button>, so this asserts both halves: the controller consumes neither key,
    // and the click the browser would fire opens the menu at its first item.
    for (const pressed of ["Enter", " "]) {
      const event = keyEvent(pressed);
      keyboardPress(byId("file"), event);
      expect(event.defaultPrevented).toBe(false);
      expect(menuHidden("m-file")).toBe(true);

      byId("file").click();
      expect(menuHidden("m-file")).toBe(false);
      expect(document.activeElement).toBe(byId("new"));
      byId("file").click(); // back to the closed baseline for the next key
    }
  });

  it("leaves a modified arrow on a top item to the browser", () => {
    // Alt+arrow is the browser's history shortcut; the menubar must not swallow it,
    // so neither the claim nor the single Tab stop may move.
    const event = keyboardPress(byId("file"), "ArrowRight", { altKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(byId("file"));
    expect(tabStops()).toEqual([byId("file")]);
    expect(menuHidden("m-edit")).toBe(true);
  });

  it("roves between top items with ArrowRight/ArrowLeft when closed", () => {
    key("file", "ArrowRight");
    expect(document.activeElement).toBe(byId("edit"));
    expect(byId("edit").tabIndex).toBe(0);
    expect(byId("file").tabIndex).toBe(-1);
    expect(menuHidden("m-edit")).toBe(true); // closed: just moves, does not open
    key("edit", "ArrowLeft");
    expect(document.activeElement).toBe(byId("file"));
  });

  it("roves to the first/last top item with Home/End when closed", () => {
    key("file", "ArrowRight"); // focus Edit
    key("edit", "Home");
    expect(document.activeElement).toBe(byId("file"));
    expect(byId("file").tabIndex).toBe(0);
    expect(menuHidden("m-file")).toBe(true); // closed: Home/End only move
    key("file", "End");
    expect(document.activeElement).toBe(byId("edit"));
    expect(byId("edit").tabIndex).toBe(0);
  });

  it("consumes the navigation keys it handles and leaves Tab to the browser", () => {
    // preventDefault is what stops the page from scrolling under the menubar. The
    // negative half matters just as much: Tab must stay uncancelled so the browser
    // performs its own move (the close is deferred to the next task instead).
    for (const pressed of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]) {
      expect(key("file", pressed).defaultPrevented).toBe(true);
      byId("file").focus(); // arrows may have moved focus/opened a menu
    }
    expect(key("file", "Tab").defaultPrevented).toBe(false);

    byId("file").click(); // focus the first item, then check the in-menu handler
    for (const pressed of ["ArrowDown", "ArrowUp", "Home", "End", "ArrowRight", "ArrowLeft"]) {
      const target = document.activeElement as HTMLElement;
      expect(key(target.id, pressed).defaultPrevented).toBe(true);
    }
    expect(key((document.activeElement as HTMLElement).id, "Tab").defaultPrevented).toBe(false);
  });

  it("closes every menu on Escape pressed on a top item, without moving focus", () => {
    byId("file").click(); // opens File, focus lands on New
    byId("file").focus(); // Shift+Tab back onto the top item, menu still open
    const press = key("file", "Escape");
    expect(menuHidden("m-file")).toBe(true);
    expect(expanded("file")).toBe("false");
    expect(document.activeElement).toBe(byId("file")); // focus stays where it was
    expect(press.defaultPrevented).toBe(true); // the layer owned and consumed it
  });

  it("closes every menu on Escape after focus fell to the body", () => {
    byId("file").click();
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);

    const press = keyEvent("Escape");
    // Body focus stays intact while the document fallback receives Escape.
    typeKey(document, press);
    expect(menuHidden("m-file")).toBe(true);
    expect(expanded("file")).toBe("false");
    expect(press.defaultPrevented).toBe(true);
  });

  it("opens the adjacent menu from a top item while a menu is open", () => {
    byId("file").click(); // open File
    byId("file").focus(); // Shift+Tab back onto the top item, menu still open
    key("file", "ArrowRight");
    expect(menuHidden("m-file")).toBe(true);
    expect(menuHidden("m-edit")).toBe(false);
    expect(document.activeElement).toBe(byId("cut"));
  });

  it("opens the first/last menu with Home/End while a menu is open", () => {
    byId("file").click();
    byId("file").focus();
    key("file", "End");
    expect(menuHidden("m-edit")).toBe(false);
    expect(document.activeElement).toBe(byId("cut"));
    byId("edit").focus();
    key("edit", "Home");
    expect(menuHidden("m-file")).toBe(false);
    expect(menuHidden("m-edit")).toBe(true);
    expect(document.activeElement).toBe(byId("new"));
  });

  it("leaves a modified arrow inside a menu to the browser", () => {
    // Same contract one level down: the open menu neither claims the chorded press
    // nor advances its roving focus.
    byId("file").click(); // open File, focus New
    const event = keyboardPress(byId("new"), "ArrowDown", { altKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(byId("new"));
    expect(menuHidden("m-file")).toBe(false);
  });

  it("moves within a menu with arrows (wrapping) and Home/End", () => {
    byId("file").click(); // focus new
    key("new", "ArrowDown");
    expect(document.activeElement).toBe(byId("open"));
    key("open", "ArrowUp");
    expect(document.activeElement).toBe(byId("new"));
    key("new", "ArrowUp"); // wrap to last
    expect(document.activeElement).toBe(byId("save"));
    key("save", "ArrowDown"); // wrap to first
    expect(document.activeElement).toBe(byId("new"));
    key("new", "End");
    expect(document.activeElement).toBe(byId("save"));
    key("save", "Home");
    expect(document.activeElement).toBe(byId("new"));
  });

  it("jumps to the adjacent menu with ArrowRight/ArrowLeft inside a menu", () => {
    byId("file").click(); // open File, focus new
    key("new", "ArrowRight"); // -> open Edit, focus first
    expect(menuHidden("m-file")).toBe(true);
    expect(menuHidden("m-edit")).toBe(false);
    expect(document.activeElement).toBe(byId("cut"));
    key("cut", "ArrowLeft"); // -> wrap back to File
    expect(menuHidden("m-edit")).toBe(true);
    expect(menuHidden("m-file")).toBe(false);
    expect(document.activeElement).toBe(byId("new"));
  });

  it("activates an item: closes the menu and refocuses the top item", () => {
    byId("file").click();
    byId("new").click();
    expect(menuHidden("m-file")).toBe(true);
    expect(expanded("file")).toBe("false");
    expect(document.activeElement).toBe(byId("file"));
  });

  it("closes on Escape and returns focus to the top item", () => {
    byId("file").click();
    key("new", "Escape");
    expect(menuHidden("m-file")).toBe(true);
    expect(document.activeElement).toBe(byId("file"));
  });

  it("closes on Tab from a menu item on the next task, without pulling focus back", async () => {
    byId("file").click();
    key("new", "Tab");
    // Closing synchronously would remove the focused item before the browser's own
    // Tab move and restart traversal at the document head.
    expect(menuHidden("m-file")).toBe(false);
    await tick();
    expect(menuHidden("m-file")).toBe(true);
    // Tab closes where the user is heading; it never restores focus to the top item.
    expect(document.activeElement).not.toBe(byId("file"));
  });

  it("closes on Tab pressed on a top item while a menu is open", async () => {
    byId("file").click();
    byId("file").focus(); // Shift+Tab back onto the top item, menu still open
    key("file", "Tab");
    expect(menuHidden("m-file")).toBe(false);
    await tick();
    expect(menuHidden("m-file")).toBe(true);
  });

  it("discards a pending Tab close when a menu is reopened", async () => {
    byId("file").click();
    key("new", "Tab"); // schedules the close
    byId("edit").click(); // reopen before the task runs
    await tick();
    expect(menuHidden("m-edit")).toBe(false);
    expect(document.activeElement).toBe(byId("cut"));
  });

  it("keeps a single pending Tab close when Tab is pressed again", () => {
    vi.useFakeTimers();
    try {
      byId("file").click();
      key("new", "Tab");
      key("new", "Tab");
      expect(vi.getTimerCount()).toBe(1);

      vi.runOnlyPendingTimers();
      expect(expanded("file")).toBe("false");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes on an outside click without taking focus from the clicked element", () => {
    document.body.insertAdjacentHTML("beforeend", '<button id="outside">Outside</button>');
    byId("file").click();
    const outside = byId("outside") as HTMLButtonElement;
    outside.focus();
    outside.click();
    expect(menuHidden("m-file")).toBe(true);
    expect(document.activeElement).toBe(outside);
  });

  it("stays open when a click lands inside the controller", () => {
    byId("file").click();
    byId("m-file").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menuHidden("m-file")).toBe(false);
    expect(expanded("file")).toBe("true");
  });

  it("supports typeahead within the open menu", () => {
    byId("file").click(); // focus new
    key("new", "o"); // -> Open
    expect(document.activeElement).toBe(byId("open"));
  });

  it("cycles through items sharing a first letter when the key is repeated", () => {
    byId("edit").click(); // focus Cut
    key("cut", "c"); // -> Copy
    expect(document.activeElement).toBe(byId("copy"));
    key("copy", "c"); // repeated key: cycle back to Cut, not a dead "cc" buffer
    expect(document.activeElement).toBe(byId("cut"));
  });

  it("narrows to a multi-character prefix while the buffer is fresh", () => {
    vi.useFakeTimers();
    try {
      byId("edit").click(); // focus Cut
      key("cut", "c"); // -> Copy
      expect(document.activeElement).toBe(byId("copy"));
      vi.advanceTimersByTime(400); // still under the 500ms reset
      key("copy", "u"); // buffer "cu" -> Cut (a single-char search would not move)
      expect(document.activeElement).toBe(byId("cut"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves focus alone when nothing matches the buffer", () => {
    byId("file").click(); // focus new
    key("new", "z");
    expect(document.activeElement).toBe(byId("new"));
  });

  it("does not consume Space for typeahead (leaves native button activation)", () => {
    byId("file").click(); // open File, focus New
    const event = keyEvent(" ");
    keyboardPress(byId("new"), event);
    // Space must not be preventDefault-ed, so the button's native Enter/Space →
    // click activation still runs.
    expect(event.defaultPrevented).toBe(false);
  });

  it("consumes a printable typeahead key inside a menu", () => {
    byId("file").click(); // open File, focus New
    expect(key("new", "o").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId("open"));
  });

  it("resumes narrowing after a repeated key instead of stalling on a dead query", () => {
    vi.useFakeTimers();
    try {
      byId("edit").click(); // focus Cut
      key("cut", "c"); // -> Copy
      key("copy", "c"); // repeat: the query stays "c", cycling back to Cut
      expect(document.activeElement).toBe(byId("cut"));
      key("cut", "o"); // "co" -> Copy, not the dead "cco"
      expect(document.activeElement).toBe(byId("copy"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("matches the authored aria-label rather than the visible text", async () => {
    // The shared resolver reads the accessible name, so typeahead matches what a
    // screen reader announces.
    disconnectAndStopApplication(application);
    application = await mount(`
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        ${top("file", "File", "m-file")}
        ${menu(
          "m-file",
          "File",
          `${item("new", "New")}${item("labelled", "Open", 'aria-label="Zeta"')}${item("other", "Only")}`,
        )}
      </div>`);
    vi.useFakeTimers();
    try {
      byId("file").click(); // focus New
      key("new", "z");
      expect(document.activeElement).toBe(byId("labelled")); // "Zeta", not "Open"

      // The negative direction needs a fresh query: a second press inside the idle
      // window would search "zo", which misses under either naming rule.
      vi.advanceTimersByTime(600);
      key("labelled", "o"); // "Open" is named Zeta, so only "Only" starts with "o"
      expect(document.activeElement).toBe(byId("other"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the typeahead buffer after a pause", () => {
    vi.useFakeTimers();
    try {
      byId("file").click();
      key("new", "s"); // Save
      expect(document.activeElement).toBe(byId("save"));
      vi.advanceTimersByTime(600);
      key("save", "o"); // fresh buffer -> Open
      expect(document.activeElement).toBe(byId("open"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a fresh typeahead query in each menu it opens", () => {
    vi.useFakeTimers();
    try {
      byId("file").click(); // focus New
      key("new", "s"); // -> Save
      expect(document.activeElement).toBe(byId("save"));
      key("save", "ArrowRight"); // opens Edit inside the idle window, focus Cut
      key("cut", "c"); // "c" -> Copy, not the dead "sc"
      expect(document.activeElement).toBe(byId("copy"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows items added to and removed from an open menu", async () => {
    byId("file").click();
    byId("m-file").insertAdjacentHTML("beforeend", item("archive", "Archive"));
    await tick();
    key("save", "ArrowDown"); // Save was last: the appended item is now next
    expect(document.activeElement).toBe(byId("archive"));

    byId("open").closest("li")?.remove();
    key("new", "ArrowDown"); // Open is gone: Save is next
    expect(document.activeElement).toBe(byId("save"));
    // Activation on a target that survived the mutation still closes and restores.
    byId("save").click();
    expect(menuHidden("m-file")).toBe(true);
    expect(document.activeElement).toBe(byId("file"));
  });

  it("releases the document listener, the Escape layer, and pending timers on disconnect", () => {
    vi.useFakeTimers();
    try {
      byId("file").click();
      key("new", "s"); // schedules the typeahead reset timer
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      disconnectAndStopApplication(application);

      expect(vi.getTimerCount()).toBe(0);
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(menuHidden("m-file")).toBe(false); // a surviving listener would have closed it

      const escapePress = keyEvent("Escape");
      keyboardPress(document.activeElement as HTMLElement, escapePress);
      expect(escapePress.defaultPrevented).toBe(false); // the Escape layer is deregistered
      expect(menuHidden("m-file")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a pending Tab close on disconnect", () => {
    vi.useFakeTimers();
    try {
      byId("file").click();
      key("new", "Tab");
      expect(vi.getTimerCount()).toBe(1);

      menubarOf(application).disconnect();

      expect(vi.getTimerCount()).toBe(0);
      vi.runOnlyPendingTimers();
      expect(menuHidden("m-file")).toBe(false);
      expect(expanded("file")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes every listener it adds to its own element on disconnect", () => {
    const instance = menubarOf(application);
    instance.disconnect();
    const ledger = recordListeners();
    try {
      instance.connect();
      const own = ledger
        .live(instance.element)
        .filter(({ type }) => ["click", "focusin", "focusout"].includes(type));
      expect(own.map(({ type }) => type).sort()).toEqual(["click", "focusin", "focusout"]);

      instance.disconnect();

      expect(own.filter(({ live }) => live)).toEqual([]);
    } finally {
      ledger.restore();
    }
  });

  it("stops observing its subtree on disconnect", async () => {
    const instance = menubarOf(application);
    const Native = globalThis.MutationObserver;
    let observer: MutationObserver | null = null;
    let deliveries = 0;
    class RecordingObserver extends Native {
      constructor(callback: MutationCallback) {
        super((records, self) => {
          if (self === observer) deliveries += 1;
          callback(records, self);
        });
      }
      override observe(target: Node, options?: MutationObserverInit): void {
        if (target === instance.element) observer = this;
        super.observe(target, options);
      }
    }
    vi.stubGlobal("MutationObserver", RecordingObserver);
    try {
      instance.disconnect();
      instance.connect();
      byId("edit").hidden = true;
      await tick();
      const seen = deliveries;
      expect(seen).toBeGreaterThan(0);

      instance.disconnect();
      byId("edit").hidden = false;
      await tick();

      expect(deliveries).toBe(seen);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("has no machine-detectable a11y violations (closed and open)", async () => {
    const root = document.querySelector("[data-controller='stimeo--menubar']") as HTMLElement;
    await expectNoA11yViolations(root);
    byId("file").click();
    await expectNoA11yViolations(root);
  });

  it("announces the menubar and its first top item", async () => {
    const root = document.querySelector("[data-controller='stimeo--menubar']") as HTMLElement;
    const phrases = await captureSpeech({ container: root, steps: 1 });
    expect(phrases).toEqual([
      "menubar, Main, orientated horizontally",
      "menuitem, File, 1 control, not expanded, has popup menu, position 1, set size 2",
    ]);
  });

  it("announces the open menu and its items", async () => {
    byId("file").click();
    const phrases = await captureSpeech({ container: byId("m-file"), steps: 4 });
    expect(phrases).toEqual([
      "menu, File, orientated vertically",
      "menuitem, New, position 1, set size 3",
      "menuitem, Open, position 2, set size 3",
      "menuitem, Save, position 3, set size 3",
      "end of menu, File, orientated vertically",
    ]);
  });

  // --- State events ---

  describe("state events", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    beforeEach(() => {
      capture = captureStateEvents("stimeo--menubar");
    });

    afterEach(() => {
      capture.stop();
    });

    it("reports a top click with the menu that moved, after the attributes", () => {
      const states: string[] = [];
      byId("file")
        .closest("[data-controller]")
        ?.addEventListener("stimeo--menubar:open", () => {
          states.push(`${menuHidden("m-file")} ${expanded("file")}`);
        });

      byId("file").click();

      expect(capture.names()).toEqual(["open"]);
      expect(capture.seen[0]?.detail).toEqual({ reason: "user", index: 0, menu: byId("m-file") });
      expect(states).toEqual(["false true"]);
      expect(capture.seen[0]?.bubbles).toBe(true);
      expect(capture.seen[0]?.cancelable).toBe(false);
    });

    it("reports the outgoing close before the incoming open on an adjacent move", () => {
      byId("file").click();
      capture.clear();

      keyboardPress(byId("new"), "ArrowRight");

      expect(capture.names()).toEqual(["close", "open"]);
      expect(capture.seen[0]?.detail).toEqual({ reason: "user", index: 0, menu: byId("m-file") });
      expect(capture.seen[1]?.detail).toEqual({ reason: "user", index: 1, menu: byId("m-edit") });
    });

    it("reports activating an item as select", () => {
      byId("file").click();
      capture.clear();

      byId("new").click();

      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["select"]);
    });

    it("reports Escape as escape and an outside click as outside", () => {
      byId("file").click();
      capture.clear();
      keyboardPress(byId("new"), "Escape");

      expect(capture.reasons()).toEqual(["escape"]);

      byId("file").click();
      capture.clear();
      document.body.click();

      expect(capture.reasons()).toEqual(["outside"]);
    });

    it("reports the deferred Tab close as focus", async () => {
      byId("file").click();
      capture.clear();

      keyboardPress(byId("new"), "Tab");
      expect(capture.seen).toEqual([]);
      await tick();

      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["focus"]);
    });

    it("stays silent when the menu that is already open is reopened", () => {
      byId("file").click();
      capture.clear();

      keyboardPress(byId("file"), "ArrowDown");

      expect(menuHidden("m-file")).toBe(false);
      expect(capture.seen).toEqual([]);
    });

    it("stays silent while a removed menu target is reconciled away", async () => {
      byId("file").click();
      capture.clear();

      byId("m-file").remove();
      await tick();

      expect(expanded("file")).toBe("false");
      expect(capture.seen).toEqual([]);
    });

    it("stays silent while connect normalizes an authored-open menu", async () => {
      disconnectAndStopApplication(application);
      const authored = markup
        .replace(
          'aria-expanded="false" aria-controls="m-file"',
          'aria-expanded="true" aria-controls="m-file"',
        )
        .replace(
          'id="m-file" role="menu" aria-label="File" hidden',
          'id="m-file" role="menu" aria-label="File"',
        );
      const fresh = captureStateEvents("stimeo--menubar");
      application = await mount(authored);

      expect(menuHidden("m-file")).toBe(true);
      expect(fresh.seen).toEqual([]);
      fresh.stop();
    });

    it("stays silent through a disconnect and a Turbo-style reconnect", async () => {
      byId("file").click();
      capture.clear();

      const element = document.querySelector("[data-controller='stimeo--menubar']") as HTMLElement;
      element.remove();
      await tick();
      document.body.append(element);
      await tick();

      expect(menuHidden("m-file")).toBe(true);
      expect(capture.seen).toEqual([]);
    });
  });

  // --- Re-entry from a subscriber ---

  describe("re-entry from a subscriber", () => {
    it("leaves no focus inside the menu when the open handler closes it again", () => {
      const host = byId("file").closest("[data-controller]") as HTMLElement;
      const instance = application.getControllerForElementAndIdentifier(host, "stimeo--menubar");
      if (!(instance instanceof MenubarController)) throw new Error("menubar controller not found");
      host.addEventListener("stimeo--menubar:open", () =>
        instance.activate({
          currentTarget: byId("new"),
        } as unknown as Event),
      );

      byId("file").click();

      expect(menuHidden("m-file")).toBe(true);
      expect(byId("m-file").contains(document.activeElement)).toBe(false);
    });
  });
});

describe("MenubarController with disabled and hidden entries", () => {
  let application: Application;

  beforeEach(async () => {
    // View is natively disabled and Help is aria-disabled. Under the APG rule
    // ("Disabled menu items are focusable but cannot be activated") the two are NOT
    // interchangeable: `disabled` leaves the Tab sequence and the arrow keys,
    // `aria-disabled` stays reachable and only its activation is blocked. Inside
    // File, Open (aria-disabled) is reachable while Print (disabled) and Hidden
    // (hidden) are skipped.
    application = await mount(`
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        ${top("dis-view", "View", "dis-m-view", "disabled")}
        ${menu("dis-m-view", "View", item("dis-zoom", "Zoom"))}
        ${top("dis-file", "File", "dis-m-file")}
        ${menu(
          "dis-m-file",
          "File",
          `${item("dis-new", "New")}
           ${item("dis-open", "Open", 'aria-disabled="true"')}
           ${item("dis-print", "Print", "disabled")}
           ${item("dis-hidden", "Hidden", "hidden")}
           ${item("dis-save", "Save")}`,
        )}
        ${top("dis-edit", "Edit", "dis-m-edit")}
        ${menu("dis-m-edit", "Edit", item("dis-cut", "Cut"))}
        ${top("dis-help", "Help", "dis-m-help", 'aria-disabled="true"')}
        ${menu("dis-m-help", "Help", item("dis-about", "About"))}
      </div>`);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("keeps the tab stop off a disabled top item", () => {
    // A tabindex="0" on an unfocusable button would drop the whole menubar out of
    // the Tab order. There is exactly one stop, and it is the first navigable top.
    expect(byId("dis-view").tabIndex).toBe(-1);
    expect(tabStops()).toEqual([byId("dis-file")]);
  });

  it("skips natively disabled top items when roving", () => {
    pressOn("dis-help", "ArrowRight"); // wraps past the natively disabled View
    expect(document.activeElement).toBe(byId("dis-file"));
    pressOn("dis-file", "ArrowLeft"); // backwards, also skipping View
    expect(document.activeElement).toBe(byId("dis-help"));
  });

  it("keeps aria-disabled top items reachable with the arrow keys and End", () => {
    pressOn("dis-file", "ArrowRight");
    expect(document.activeElement).toBe(byId("dis-edit"));
    pressOn("dis-edit", "ArrowRight"); // Help is aria-disabled: reachable, not skipped
    expect(document.activeElement).toBe(byId("dis-help"));
    expect(byId("dis-help").tabIndex).toBe(0);
    pressOn("dis-edit", "End");
    expect(document.activeElement).toBe(byId("dis-help")); // last navigable top
  });

  it("skips natively disabled and hidden items inside a menu", () => {
    byId("dis-file").click();
    expect(document.activeElement).toBe(byId("dis-new"));
    pressOn("dis-open", "ArrowDown"); // past Print (disabled) and Hidden (hidden)
    expect(document.activeElement).toBe(byId("dis-save"));
    pressOn("dis-save", "ArrowDown"); // wraps to the first navigable item
    expect(document.activeElement).toBe(byId("dis-new"));
  });

  it("keeps aria-disabled menu items reachable with the arrow keys", () => {
    byId("dis-file").click();
    pressOn("dis-new", "ArrowDown");
    expect(document.activeElement).toBe(byId("dis-open")); // aria-disabled, still reachable
    pressOn("dis-new", "ArrowUp"); // backwards from the first item wraps to the last
    expect(document.activeElement).toBe(byId("dis-save"));
  });

  it("blocks activation of an aria-disabled item before the handlers inside the menubar element", () => {
    byId("dis-file").click();
    let consumerActivations = 0;
    byId("dis-open").addEventListener("click", () => consumerActivations++);

    byId("dis-open").click();

    expect(consumerActivations).toBe(0);
    expect(menuHidden("dis-m-file")).toBe(false); // activate() never ran either
    expect(expanded("dis-file")).toBe("true");
  });

  it("blocks activation of an aria-disabled top item", () => {
    let consumerActivations = 0;
    byId("dis-help").addEventListener("click", () => consumerActivations++);

    byId("dis-help").click();

    expect(consumerActivations).toBe(0);
    expect(menuHidden("dis-m-help")).toBe(true);
    expect(expanded("dis-help")).toBe("false");
  });

  it("cancels the default action of a click on an aria-disabled entry only", () => {
    // The default action is what a link or a submit button would go on to perform.
    byId("dis-file").click();
    const clickOn = (id: string): MouseEvent => {
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      byId(id).dispatchEvent(click);
      return click;
    };

    expect(clickOn("dis-open").defaultPrevented).toBe(true);
    expect(clickOn("dis-help").defaultPrevented).toBe(true);
    expect(clickOn("dis-new").defaultPrevented).toBe(false);
  });

  it("never opens the menu of an aria-disabled top item with the keyboard", () => {
    // Reachable is not the same as activatable: opening the popup IS activation,
    // so the arrow keys that open a menu must do nothing here.
    expect(pressOn("dis-help", "ArrowDown").defaultPrevented).toBe(true);
    expect(menuHidden("dis-m-help")).toBe(true);
    expect(expanded("dis-help")).toBe("false");
    expect(document.activeElement).toBe(byId("dis-help"));

    expect(pressOn("dis-help", "ArrowUp").defaultPrevented).toBe(true);
    expect(menuHidden("dis-m-help")).toBe(true);
  });

  it("moves onto an aria-disabled top, closing the open menu without opening its own", () => {
    // The APG closes the open menu on a horizontal move before focus goes to the
    // next menubar item. Opening that item's submenu is activation, and an
    // aria-disabled item is "focusable but cannot be activated", so only the opening
    // half is skipped here. Leaving the old menu open would strand a popup that focus
    // has left.
    byId("dis-edit").focus();
    byId("dis-edit").click(); // open Edit, focus Cut
    key("dis-cut", "ArrowRight"); // -> Help (aria-disabled)

    expect(document.activeElement).toBe(byId("dis-help"));
    expect(menuHidden("dis-m-help")).toBe(true); // never activated
    expect(menuHidden("dis-m-edit")).toBe(true);
    expect(expanded("dis-edit")).toBe("false");
    expect(tabStops()).toEqual([byId("dis-help")]);
  });

  it("removes the activation blocker on disconnect", () => {
    let consumerActivations = 0;
    byId("dis-open").addEventListener("click", () => consumerActivations++);

    disconnectAndStopApplication(application);
    byId("dis-open").click();

    expect(consumerActivations).toBe(1);
  });

  /**
   * `toggle` and `activate` refuse an entry that is `aria-disabled`, natively
   * `disabled` or `hidden` on every route into them, and a refusal writes nothing:
   * no state event, no open or closed menu, no focus move, no Tab stop move.
   *
   * The routes are a DOM click, an explicit element, and a non-click Event handed
   * to the action. The click is the comparison: the capture listener swallows it on
   * an `aria-disabled` entry and the engine dispatches none on a natively `disabled`
   * button. A script's `click()` still reaches a `hidden` element. The other two
   * routes pass no capture listener, so only the actions themselves can refuse them.
   */
  describe("on every route into toggle and activate", () => {
    const ROUTES = ["click", "element", "probe"] as const;
    type Route = (typeof ROUTES)[number];

    /** Each constraint, on a top item and on an item of the File menu. */
    const CONSTRAINED = {
      "aria-disabled": { top: "dis-help", item: "dis-open" },
      disabled: { top: "dis-view", item: "dis-print" },
      hidden: { top: "dis-edit", item: "dis-hidden" },
    } as const;
    type Constraint = keyof typeof CONSTRAINED;

    const MATRIX = (Object.keys(CONSTRAINED) as Constraint[]).flatMap((constraint) =>
      ROUTES.map((route) => [constraint, route] as const),
    );

    let capture: ReturnType<typeof captureStateEvents>;

    beforeEach(async () => {
      byId("dis-file").click(); // opens File and focuses New
      await tick();
      capture = captureStateEvents("stimeo--menubar");
    });

    afterEach(() => {
      capture.stop();
    });

    /**
     * Drives `action` on `id` through one route. The probe bubbles and is
     * cancelable, and is returned, so a row can show the action left it alone.
     */
    const drive = (id: string, action: "toggle" | "activate", route: Route): Event | null => {
      const target = byId(id);
      const controller = menubarOf(application);
      if (route === "click") {
        target.click();
        return null;
      }
      if (route === "element") {
        controller[action](target);
        return null;
      }
      const probe = new Event("probe", { bubbles: true, cancelable: true });
      target.addEventListener("probe", (event) => controller[action](event), { once: true });
      target.dispatchEvent(probe);
      return probe;
    };

    /**
     * Drives a refused `action` and checks that the refusal neither cancelled the
     * probe nor stopped it short of the menubar root.
     */
    const driveRefused = (id: string, action: "toggle" | "activate", route: Route): void => {
      const root = menubarOf(application).element;
      const reached = vi.fn();
      root.addEventListener("probe", reached);
      const probe = drive(id, action, route);
      root.removeEventListener("probe", reached);
      if (probe) {
        expect(probe.defaultPrevented).toBe(false);
        expect(reached).toHaveBeenCalledOnce();
      }
    };

    /**
     * The top carrying `constraint`. The fixture has no `hidden` top, so Edit is
     * hidden here, and the reconciliation that write starts is let run first.
     */
    const constrainedTop = async (constraint: Constraint): Promise<string> => {
      if (constraint === "hidden") {
        byId("dis-edit").hidden = true;
        await tick();
        capture.clear();
      }
      return CONSTRAINED[constraint].top;
    };

    /** File stays open on New, nothing is reported, and the lone Tab stop stays on File. */
    const expectFileUntouched = (): void => {
      expect(capture.seen).toEqual([]);
      expect(expanded("dis-file")).toBe("true");
      expect(menuHidden("dis-m-file")).toBe(false);
      expect(document.activeElement).toBe(byId("dis-new"));
      expect(tabStops()).toEqual([byId("dis-file")]);
    };

    it.each(MATRIX)(
      "refuses toggle on the %s top through %s without closing the open menu",
      async (constraint, route) => {
        const id = await constrainedTop(constraint);

        driveRefused(id, "toggle", route);
        // A refused open writes nothing; an accepted one on a `hidden` or `disabled`
        // top would be closed again by the reconciliation its own write starts.
        await tick();

        expectFileUntouched();
        expect(expanded(id)).toBe("false");
        expect(menuHidden(byId(id).getAttribute("aria-controls") ?? "")).toBe(true);
      },
    );

    it.each(MATRIX)(
      "refuses activate on the %s item through %s without closing its menu",
      async (constraint, route) => {
        driveRefused(CONSTRAINED[constraint].item, "activate", route);
        await tick();

        expectFileUntouched();
      },
    );

    it.each(ROUTES)(
      "keeps File open through %s once File itself turned aria-disabled",
      async (route) => {
        // `aria-disabled` is not one of the attributes the reconciliation watches, so
        // the menu stays open, and closing it would be activating the top.
        byId("dis-file").setAttribute("aria-disabled", "true");
        await tick();

        driveRefused("dis-file", "toggle", route);
        await tick();

        expectFileUntouched();
      },
    );

    it.each(ROUTES)("still opens an enabled top through %s", async (route) => {
      drive("dis-edit", "toggle", route);
      await tick();

      const reason = route === "element" ? "api" : "user";
      expect(capture.names()).toEqual(["close", "open"]);
      expect(capture.reasons()).toEqual([reason, reason]);
      expect(menuHidden("dis-m-file")).toBe(true);
      expect(expanded("dis-edit")).toBe("true");
      expect(menuHidden("dis-m-edit")).toBe(false);
      expect(document.activeElement).toBe(byId("dis-cut"));
      expect(tabStops()).toEqual([byId("dis-edit")]);
    });

    it.each(ROUTES)("still activates an enabled item through %s", async (route) => {
      drive("dis-save", "activate", route);
      await tick();

      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["select"]);
      expect(menuHidden("dis-m-file")).toBe(true);
      expect(document.activeElement).toBe(byId("dis-file"));
      expect(tabStops()).toEqual([byId("dis-file")]);
    });
  });
});

/**
 * A click is judged once, when it starts: the capture listener takes the verdict
 * before any consumer handler on the entry runs, and the action the click reaches
 * keeps it when the entry it resolves is among those the verdict was taken for. A
 * consumer command that marks its own entry busy during that click (`disabled` or
 * `aria-disabled` while it runs) therefore still gets the close or open it started,
 * exactly as when its handler changes nothing — though a top whose menu that click
 * opened and that is left natively `disabled` is then closed again, silently, by the
 * reconciliation. An entry the verdict was not
 * taken for — a handler that ran first moved the target out of it — is judged when
 * the action runs, as is any other event.
 */
describe("MenubarController judging a click when it starts", () => {
  let application: Application;

  /**
   * Mounts `html` and runs `prepare` before Stimulus binds the actions, so a
   * listener `prepare` adds to an entry runs ahead of the controller's action there.
   */
  const mountWith = async (prepare: () => void, html = markup): Promise<void> => {
    document.body.innerHTML = html;
    prepare();
    application = Application.start();
    application.register("stimeo--menubar", MenubarController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  /** What a consumer command writes on its own entry; `none` is the positive control. */
  const MARKS = ["none", "disabled", "aria-disabled"] as const;
  type Mark = (typeof MARKS)[number];

  /** Adds a consumer command on `id` that marks its own entry with `mark` each time it runs. */
  const addCommand = (id: string, mark: Mark, command: () => void, type = "click"): void => {
    const entry = byId(id);
    entry.addEventListener(type, () => {
      command();
      if (mark === "aria-disabled") entry.setAttribute("aria-disabled", "true");
      else if (mark === "disabled") entry.toggleAttribute("disabled", true);
    });
  };

  it.each(MARKS)("closes the menu for an item whose click marks it %s", async (mark) => {
    const command = vi.fn();
    await mountWith(() => addCommand("open", mark, command));
    byId("file").click(); // opens File and focuses New
    const capture = captureStateEvents("stimeo--menubar");

    byId("open").click();

    expect(command).toHaveBeenCalledOnce();
    expect(capture.names()).toEqual(["close"]);
    expect(capture.reasons()).toEqual(["select"]);
    expect(menuHidden("m-file")).toBe(true);
    expect(expanded("file")).toBe("false");
    expect(document.activeElement).toBe(byId("file"));
    await tick();
    capture.stop();
    expect(capture.names()).toEqual(["close"]);
    expect(tabStops()).toEqual([byId("file")]);
  });

  it.each(MARKS)("opens the menu of a top whose click marks it %s", async (mark) => {
    const command = vi.fn();
    await mountWith(() => addCommand("edit", mark, command));
    byId("file").click();
    const capture = captureStateEvents("stimeo--menubar");

    byId("edit").click();
    capture.stop();

    // A `disabled` top is closed again, silently, by the reconciliation its own write
    // starts on delivery; the click's open itself is what this row pins.
    expect(command).toHaveBeenCalledOnce();
    expect(capture.names()).toEqual(["close", "open"]);
    expect(capture.reasons()).toEqual(["user", "user"]);
    expect(menuHidden("m-file")).toBe(true);
    expect(expanded("edit")).toBe("true");
    expect(menuHidden("m-edit")).toBe(false);
    expect(document.activeElement).toBe(byId("cut"));
    expect(tabStops()).toEqual([byId("edit")]);
  });

  it.each(MARKS)("closes the open menu of a top whose click marks it %s", async (mark) => {
    const command = vi.fn();
    await mountWith(() => addCommand("file", mark, command));
    pressOn("file", "ArrowDown"); // opens File without a click
    const capture = captureStateEvents("stimeo--menubar");

    byId("file").click();
    capture.stop();

    expect(command).toHaveBeenCalledOnce();
    expect(capture.names()).toEqual(["close"]);
    expect(capture.reasons()).toEqual(["user"]);
    expect(expanded("file")).toBe("false");
    expect(menuHidden("m-file")).toBe(true);
  });

  it.each(MARKS)(
    "judges a non-click event when activate runs, after a command marked the item %s",
    async (mark) => {
      const command = vi.fn();
      await mountWith(() => addCommand("open", mark, command, "probe"));
      byId("file").click();
      byId("open").addEventListener("probe", (event) => menubarOf(application).activate(event));
      const capture = captureStateEvents("stimeo--menubar");

      byId("open").dispatchEvent(new Event("probe", { bubbles: true, cancelable: true }));
      await tick();
      capture.stop();

      expect(command).toHaveBeenCalledOnce();
      expect(capture.names()).toEqual(mark === "none" ? ["close"] : []);
      expect(menuHidden("m-file")).toBe(mark === "none");
    },
  );

  it.each(MARKS)(
    "judges a non-click event when toggle runs, after a command marked the top %s",
    async (mark) => {
      const command = vi.fn();
      await mountWith(() => addCommand("edit", mark, command, "probe"));
      byId("file").click();
      byId("edit").addEventListener("probe", (event) => menubarOf(application).toggle(event));
      const capture = captureStateEvents("stimeo--menubar");

      byId("edit").dispatchEvent(new Event("probe", { bubbles: true, cancelable: true }));
      await tick();
      capture.stop();

      expect(command).toHaveBeenCalledOnce();
      expect(capture.names()).toEqual(mark === "none" ? ["close", "open"] : []);
      expect(expanded("edit")).toBe(mark === "none" ? "true" : "false");
      expect(menuHidden("m-file")).toBe(mark === "none");
    },
  );

  // An item nested in another item is the shape where more than one item holds the
  // click target. The capture listener records a verdict for both, and the click is
  // refused when either one refuses activation, so the action bound on the inner item
  // refuses it whichever of the two is `hidden`.
  it.each(["outer", "inner"] as const)(
    "refuses the inner item of a nested pair when its action runs (%s hidden)",
    async (hiddenOne) => {
      await mountWith(
        () => {},
        `<div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
          ${top("file", "File", "m-file")}
          <div id="m-file" role="menu" aria-label="File" hidden data-stimeo--menubar-target="menu">
            <div id="outer" role="menuitem" tabindex="-1" data-stimeo--menubar-target="item">
              <span id="inner" data-stimeo--menubar-target="item"
                    data-action="click->stimeo--menubar#activate">Run</span>
            </div>
          </div>
        </div>`,
      );
      byId("file").click();
      byId(hiddenOne).hidden = true;
      await tick();
      const capture = captureStateEvents("stimeo--menubar");

      byId("inner").click();
      await tick();
      capture.stop();

      expect(capture.names()).toEqual([]);
      expect(menuHidden("m-file")).toBe(false);
    },
  );

  it("swallows a click on the aria-disabled inner item of a nested pair", async () => {
    await mountWith(
      () => {},
      `<div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        ${top("file", "File", "m-file")}
        <div id="m-file" role="menu" aria-label="File" hidden data-stimeo--menubar-target="menu">
          <div id="outer" role="menuitem" tabindex="-1" data-stimeo--menubar-target="item">
            <span id="inner" aria-disabled="true" data-stimeo--menubar-target="item"
                  data-action="click->stimeo--menubar#activate">Run</span>
          </div>
        </div>
      </div>`,
    );
    byId("file").click();
    await tick();
    const command = vi.fn();
    byId("inner").addEventListener("click", command);
    const capture = captureStateEvents("stimeo--menubar");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });

    byId("inner").dispatchEvent(click);
    await tick();
    capture.stop();

    expect(command).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(true);
    expect(capture.names()).toEqual([]);
    expect(menuHidden("m-file")).toBe(false);
  });
});

/**
 * Entries nested in one another. An operation is refused when any entry this menubar
 * owns that holds the operation's target refuses activation — the target being the
 * event's target, or the element handed to the action. A `hidden`, natively `disabled`
 * or `aria-disabled` inner entry therefore refuses what lands inside it whichever entry
 * receives the action, and an outer entry that refuses refuses what lands inside it
 * too. What lands on the outer entry outside the inner one is judged on the outer
 * entry alone.
 */
describe("MenubarController with nested entries", () => {
  let application: Application;

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  /** The state the inner entry carries; `enabled` with an enabled outer is the positive control. */
  const INNER = {
    enabled: "",
    "aria-disabled": 'aria-disabled="true"',
    hidden: "hidden",
    disabled: "disabled",
  } as const;
  type Inner = keyof typeof INNER;

  /** The state the outer entry carries; its `aria-disabled` reaches the inner entry too. */
  const OUTER = { enabled: "", "aria-disabled": 'aria-disabled="true"', hidden: "hidden" } as const;
  type Outer = keyof typeof OUTER;

  /**
   * Where an operation lands and which entry receives the action; `label` is the text
   * holder inside the inner entry, and `element` hands the landing entry to the action.
   * A natively `disabled` button is dispatched no click of its own, while happy-dom
   * delivers one dispatched on content inside it, so a click inside the inner entry
   * lands on the label.
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
    "the inner as the element": { kind: "element", at: "inner", receiver: "inner" },
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
    "a click on the outer": { kind: "click", at: "outer", receiver: "outer" },
    "the outer as the element": { kind: "element", at: "outer", receiver: "outer" },
    "a probe on the outer": { kind: "probe", at: "outer", receiver: "outer" },
  } as const;
  type Route = keyof typeof ROUTES;

  /** Whether `route` lands inside the inner entry. */
  const insideInner = (route: Route): boolean => ROUTES[route].at !== "outer";

  /** Whether an entry holding the route's target refuses activation. */
  const refuses = (inner: Inner, outer: Outer, route: Route): boolean =>
    outer !== "enabled" || (insideInner(route) && inner !== "enabled");

  /** Whether the capture listener stops `route`: a click an `aria-disabled` entry holds. */
  const stops = (inner: Inner, outer: Outer, route: Route): boolean =>
    ROUTES[route].kind === "click" &&
    (outer === "aria-disabled" || (insideInner(route) && inner === "aria-disabled"));

  const ROWS = (Object.keys(INNER) as Inner[]).flatMap((inner) =>
    (Object.keys(OUTER) as Outer[]).flatMap((outer) =>
      (Object.keys(ROUTES) as Route[]).map((route) => ({
        inner,
        outer,
        route,
        outcome: refuses(inner, outer, route) ? "refuses" : "accepts",
      })),
    ),
  );

  /**
   * Delivers `route` to `action`. A consumer command listens where the event lands, so
   * a click the capture listener stops shows as a command that never ran.
   */
  const drive = (action: "activate" | "toggle", route: Route) => {
    const { kind, at, receiver } = ROUTES[route];
    const controller = menubarOf(application);
    const command = vi.fn();
    if (kind === "element") {
      controller[action](byId(at));
      return { event: null, command };
    }
    byId(at).addEventListener(kind, command);
    byId(receiver).addEventListener(kind, (event) => controller[action](event));
    const event =
      kind === "click"
        ? new MouseEvent("click", { bubbles: true, cancelable: true })
        : new Event("probe", { bubbles: true, cancelable: true });
    byId(at).dispatchEvent(event);
    return { event, command };
  };

  /** Only a click an `aria-disabled` entry holds is cancelled, and it reaches no consumer. */
  const expectDelivery = (
    inner: Inner,
    outer: Outer,
    route: Route,
    { event, command }: ReturnType<typeof drive>,
  ): void => {
    if (!event) return;
    const stopped = stops(inner, outer, route);
    expect(event.defaultPrevented).toBe(stopped);
    expect(command).toHaveBeenCalledTimes(stopped ? 0 : 1);
  };

  describe("activate on an item pair", () => {
    /** Mounts the pair inside File's menu and opens File, focusing its first navigable item. */
    const mountPair = async (inner: Inner, outer: Outer): Promise<void> => {
      application = await mount(`
        <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
          ${top("file", "File", "m-file")}
          <div id="m-file" role="menu" aria-label="File" hidden data-stimeo--menubar-target="menu">
            <div id="outer" role="menuitem" tabindex="-1" ${OUTER[outer]}
                 data-stimeo--menubar-target="item">
              <button id="inner" role="menuitem" tabindex="-1" ${INNER[inner]}
                      data-stimeo--menubar-target="item"><span id="label">Run</span></button>
            </div>
          </div>
        </div>`);
      byId("file").click();
      await tick();
    };

    it.each(ROWS)(
      "$outcome the $inner inner item in the $outer outer item through $route",
      async ({ inner, outer, route }) => {
        await mountPair(inner, outer);
        const focused = document.activeElement;
        const capture = captureStateEvents("stimeo--menubar");

        const delivered = drive("activate", route);
        await tick();
        capture.stop();

        expectDelivery(inner, outer, route, delivered);
        if (refuses(inner, outer, route)) {
          expect(capture.seen).toEqual([]);
          expect(expanded("file")).toBe("true");
          expect(menuHidden("m-file")).toBe(false);
          expect(document.activeElement).toBe(focused);
        } else {
          expect(capture.names()).toEqual(["close"]);
          expect(capture.reasons()).toEqual(["select"]);
          expect(menuHidden("m-file")).toBe(true);
          expect(document.activeElement).toBe(byId("file"));
        }
        expect(tabStops()).toEqual([byId("file")]);
      },
    );

    it.each(["enabled", "hidden"] as const)(
      "judges a probe dispatched at the text inside the %s inner item by the items holding it",
      async (inner) => {
        await mountPair(inner, "enabled");
        const text = byId("label").firstChild as Text;
        // Pinned: the target is a node that is not an element.
        expect(text.nodeType).toBe(Node.TEXT_NODE);
        byId("outer").addEventListener("probe", (event) => menubarOf(application).activate(event));
        const capture = captureStateEvents("stimeo--menubar");

        text.dispatchEvent(new Event("probe", { bubbles: true }));
        await tick();
        capture.stop();

        expect(capture.names()).toEqual(inner === "hidden" ? [] : ["close"]);
        expect(menuHidden("m-file")).toBe(inner !== "hidden");
      },
    );
  });

  describe("toggle on a top pair", () => {
    /** Mounts a top nested in another top, each controlling its own menu. */
    const mountPair = async (inner: Inner, outer: Outer): Promise<void> => {
      application = await mount(`
        <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
          <div id="outer" role="menuitem" ${OUTER[outer]} aria-haspopup="menu"
               aria-expanded="false" aria-controls="m-outer" data-stimeo--menubar-target="top">
            <button id="inner" role="menuitem" ${INNER[inner]} aria-haspopup="menu"
                    aria-expanded="false" aria-controls="m-inner"
                    data-stimeo--menubar-target="top"><span id="label">Run</span></button>
          </div>
          ${menu("m-outer", "Outer", item("outer-item", "Outer item"))}
          ${menu("m-inner", "Inner", item("inner-item", "Inner item"))}
        </div>`);
    };

    it.each(ROWS)(
      "$outcome the $inner inner top in the $outer outer top through $route",
      async ({ inner, outer, route }) => {
        await mountPair(inner, outer);
        const focused = document.activeElement;
        const stopsBefore = tabStops();
        const capture = captureStateEvents("stimeo--menubar");

        const delivered = drive("toggle", route);
        await tick();
        capture.stop();

        expectDelivery(inner, outer, route, delivered);
        const { kind, at, receiver } = ROUTES[route];
        const opened = kind === "element" ? at : receiver;
        const shut = opened === "inner" ? "outer" : "inner";
        if (refuses(inner, outer, route)) {
          expect(capture.seen).toEqual([]);
          expect(expanded("outer")).toBe("false");
          expect(expanded("inner")).toBe("false");
          expect(menuHidden("m-outer")).toBe(true);
          expect(menuHidden("m-inner")).toBe(true);
          expect(document.activeElement).toBe(focused);
          expect(tabStops()).toEqual(stopsBefore);
        } else {
          expect(capture.names()).toEqual(["open"]);
          expect(capture.reasons()).toEqual([kind === "element" ? "api" : "user"]);
          expect(expanded(opened)).toBe("true");
          expect(menuHidden(`m-${opened}`)).toBe(false);
          expect(expanded(shut)).toBe("false");
          expect(menuHidden(`m-${shut}`)).toBe(true);
          expect(tabStops()).toEqual([byId(opened)]);
        }
      },
    );

    it.each(["enabled", "hidden"] as const)(
      "judges a probe dispatched at the text inside the %s inner top by the tops holding it",
      async (inner) => {
        await mountPair(inner, "enabled");
        const text = byId("label").firstChild as Text;
        // Pinned: the target is a node that is not an element.
        expect(text.nodeType).toBe(Node.TEXT_NODE);
        byId("outer").addEventListener("probe", (event) => menubarOf(application).toggle(event));
        const capture = captureStateEvents("stimeo--menubar");

        text.dispatchEvent(new Event("probe", { bubbles: true }));
        await tick();
        capture.stop();

        expect(capture.names()).toEqual(inner === "hidden" ? [] : ["open"]);
        expect(menuHidden("m-outer")).toBe(inner === "hidden");
      },
    );
  });
});

/**
 * `aria-disabled="true"` extends to every focusable descendant, so an entry inside an
 * element that carries it is refused as if it carried it itself: its click is
 * swallowed before the handlers inside the menubar element run, and `toggle` /
 * `activate` refuse it through an element or any other event. It stays an arrow-key
 * destination all the same.
 */
describe("MenubarController under an aria-disabled ancestor", () => {
  let application: Application;

  beforeEach(async () => {
    application = await mount(`
      <div id="inh-outer">
        <div id="inh-bar" data-controller="stimeo--menubar" role="menubar" aria-label="Main">
          ${top("inh-file", "File", "inh-m-file")}
          ${menu("inh-m-file", "File", `${item("inh-new", "New")}${item("inh-save", "Save")}`)}
          ${top("inh-edit", "Edit", "inh-m-edit")}
          ${menu("inh-m-edit", "Edit", `${item("inh-cut", "Cut")}${item("inh-copy", "Copy")}`)}
        </div>
      </div>
      <div id="inh-other" data-controller="stimeo--menubar" role="menubar" aria-label="Other">
        ${top("inh-tools", "Tools", "inh-m-tools")}
        ${menu("inh-m-tools", "Tools", item("inh-run", "Run"))}
      </div>`);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const ROUTES = ["click", "element", "probe"] as const;
  type Route = (typeof ROUTES)[number];

  /** Entries outside each aria-disabled ancestor, which keep working beside it. */
  const CONTROLS = {
    "inh-m-edit": { top: "inh-file", menu: "inh-m-file", item: "inh-new" },
    "inh-bar": { top: "inh-tools", menu: "inh-m-tools", item: "inh-run" },
    "inh-outer": { top: "inh-tools", menu: "inh-m-tools", item: "inh-run" },
  } as const;
  type Ancestor = keyof typeof CONTROLS;
  const ANCESTORS = Object.keys(CONTROLS) as Ancestor[];

  const rows = (ancestors: readonly Ancestor[]) =>
    ancestors.flatMap((ancestor) => ROUTES.map((route) => [ancestor, route] as const));

  /** The top items of `rootId` that sit in the Tab sequence. */
  const stopsIn = (rootId: string) =>
    Array.from(
      byId(rootId).querySelectorAll<HTMLElement>("[data-stimeo--menubar-target='top']"),
    ).filter((element) => element.tabIndex === 0);

  /** What one route showed of its event: the click's or probe's fate on the page. */
  interface Seen {
    prevented: boolean;
    handled: number;
    reached: number;
  }

  /**
   * Drives `action` on `id` through `route`. A click and a probe are cancelable and
   * bubble; a consumer handler on the entry and a listener on the document report
   * whether each one got past the entry. The element route has no event to report.
   */
  const drive = (id: string, action: "toggle" | "activate", route: Route): Seen | null => {
    const entry = byId(id);
    const root = entry.closest("[data-controller~='stimeo--menubar']");
    const controller =
      root && application.getControllerForElementAndIdentifier(root, "stimeo--menubar");
    if (!(controller instanceof MenubarController)) throw new Error("Expected menubar controller");
    if (route === "element") {
      controller[action](entry);
      return null;
    }
    const seen = { prevented: false, handled: 0, reached: 0 };
    const handler = () => seen.handled++;
    const reached = () => seen.reached++;
    const type = route === "click" ? "click" : "probe";
    entry.addEventListener(type, handler);
    if (route === "probe") {
      entry.addEventListener("probe", (event) => controller[action](event), { once: true });
    }
    document.addEventListener(type, reached);
    const event =
      route === "click"
        ? new MouseEvent("click", { bubbles: true, cancelable: true })
        : new Event("probe", { bubbles: true, cancelable: true });
    entry.dispatchEvent(event);
    document.removeEventListener(type, reached);
    entry.removeEventListener(type, handler);
    seen.prevented = event.defaultPrevented;
    return seen;
  };

  /** A refused click stops short of consumer handlers; a refused probe goes on untouched. */
  const expectRefusedRoute = (route: Route, seen: Seen | null): void => {
    if (route === "click") expect(seen).toEqual({ prevented: true, handled: 0, reached: 0 });
    if (route === "probe") expect(seen).toEqual({ prevented: false, handled: 1, reached: 1 });
  };

  it.each(rows(ANCESTORS))(
    "refuses an item under an aria-disabled %s through %s",
    async (ancestor, route) => {
      byId("inh-edit").click(); // opens Edit and focuses Cut
      byId(ancestor).setAttribute("aria-disabled", "true");
      await tick();
      const capture = captureStateEvents("stimeo--menubar");

      const seen = drive("inh-cut", "activate", route);
      await tick();
      capture.stop();

      expectRefusedRoute(route, seen);
      expect(capture.seen).toEqual([]);
      expect(expanded("inh-edit")).toBe("true");
      expect(menuHidden("inh-m-edit")).toBe(false);
      expect(document.activeElement).toBe(byId("inh-cut"));
      expect(stopsIn("inh-bar")).toEqual([byId("inh-edit")]);
    },
  );

  it.each(rows(["inh-bar", "inh-outer"]))(
    "refuses a top under an aria-disabled %s through %s",
    async (ancestor, route) => {
      byId("inh-file").click(); // opens File and focuses New
      byId(ancestor).setAttribute("aria-disabled", "true");
      await tick();
      const capture = captureStateEvents("stimeo--menubar");

      const seen = drive("inh-edit", "toggle", route);
      await tick();
      capture.stop();

      expectRefusedRoute(route, seen);
      expect(capture.seen).toEqual([]);
      expect(expanded("inh-file")).toBe("true");
      expect(menuHidden("inh-m-file")).toBe(false);
      expect(expanded("inh-edit")).toBe("false");
      expect(menuHidden("inh-m-edit")).toBe(true);
      expect(document.activeElement).toBe(byId("inh-new"));
      expect(stopsIn("inh-bar")).toEqual([byId("inh-file")]);
    },
  );

  it.each(rows(ANCESTORS))(
    "still opens and activates entries outside an aria-disabled %s through %s",
    async (ancestor, route) => {
      byId(ancestor).setAttribute("aria-disabled", "true");
      await tick();
      const control = CONTROLS[ancestor];
      const capture = captureStateEvents("stimeo--menubar");

      const opened = drive(control.top, "toggle", route);
      expect(menuHidden(control.menu)).toBe(false);
      const activated = drive(control.item, "activate", route);
      capture.stop();

      expect(capture.names()).toEqual(["open", "close"]);
      expect(capture.reasons()).toEqual([route === "element" ? "api" : "user", "select"]);
      expect(menuHidden(control.menu)).toBe(true);
      if (route !== "element") {
        const passed = { prevented: false, handled: 1, reached: 1 };
        expect([opened, activated]).toEqual([passed, passed]);
      }
    },
  );

  it("keeps tops under an aria-disabled menubar reachable with the arrow keys", () => {
    byId("inh-bar").setAttribute("aria-disabled", "true");

    pressOn("inh-file", "ArrowRight");

    expect(document.activeElement).toBe(byId("inh-edit"));
    expect(stopsIn("inh-bar")).toEqual([byId("inh-edit")]);
  });

  it("opens the top of an aria-disabled menu and moves through its items", () => {
    // The top sits outside the menu, so the menu's own aria-disabled does not reach it.
    byId("inh-m-edit").setAttribute("aria-disabled", "true");

    byId("inh-edit").click();
    expect(expanded("inh-edit")).toBe("true");
    expect(document.activeElement).toBe(byId("inh-cut"));

    pressOn("inh-cut", "ArrowDown");
    expect(document.activeElement).toBe(byId("inh-copy"));
  });

  it("never opens a menu with the keyboard from a top under an aria-disabled ancestor", () => {
    byId("inh-outer").setAttribute("aria-disabled", "true");

    expect(pressOn("inh-file", "ArrowDown").defaultPrevented).toBe(true);
    expect(pressOn("inh-file", "ArrowUp").defaultPrevented).toBe(true);

    expect(menuHidden("inh-m-file")).toBe(true);
    expect(expanded("inh-file")).toBe("false");
    expect(document.activeElement).toBe(byId("inh-file"));
  });

  it("closes the open menu without opening the next when an arrow lands under an aria-disabled ancestor", async () => {
    byId("inh-file").click(); // opens File and focuses New
    byId("inh-bar").setAttribute("aria-disabled", "true");
    await tick();

    pressOn("inh-new", "ArrowRight");

    expect(document.activeElement).toBe(byId("inh-edit"));
    expect(menuHidden("inh-m-file")).toBe(true);
    expect(expanded("inh-edit")).toBe("false");
    expect(menuHidden("inh-m-edit")).toBe(true);
    expect(stopsIn("inh-bar")).toEqual([byId("inh-edit")]);
  });
});

describe("MenubarController with an existing tab stop", () => {
  let application: Application;

  beforeEach(async () => {
    // Turbo cache restore / morph: the markup comes back with the tab stop the
    // user left on the second top item.
    application = await mount(`
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        ${top("keep-file", "File", "keep-m-file", 'tabindex="-1"')}
        ${menu("keep-m-file", "File", item("keep-new", "New"))}
        ${top("keep-edit", "Edit", "keep-m-edit", 'tabindex="0"')}
        ${menu("keep-m-edit", "Edit", item("keep-cut", "Cut"))}
      </div>`);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("keeps a navigable tab stop instead of resetting it to the first top item", () => {
    expect(byId("keep-edit").tabIndex).toBe(0);
    expect(byId("keep-file").tabIndex).toBe(-1);
    expect(menuHidden("keep-m-edit")).toBe(true);
  });
});

describe("MenubarController with top items that resolve no menu", () => {
  let application: Application;

  beforeEach(async () => {
    // Gone points at an id that does not exist (broken markup); Help is a plain
    // command (a legitimate top item that simply has no popup).
    application = await mount(`
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        ${top("nm-file", "File", "nm-m-file")}
        ${menu("nm-m-file", "File", `${item("nm-new", "New")}${item("nm-save", "Save")}`)}
        ${top("nm-gone", "Gone", "nm-missing")}
        ${top("nm-help", "Help", null)}
      </div>`);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("leaves a plain command free of every popup attribute", () => {
    // Advertising a popup it does not have is the failure this contract prevents:
    // a screen reader would announce "has popup menu, collapsed" for a command.
    expect(byId("nm-help").hasAttribute("aria-expanded")).toBe(false);
    expect(byId("nm-help").hasAttribute("aria-haspopup")).toBe(false);
    expect(byId("nm-help").hasAttribute("aria-controls")).toBe(false);
  });

  it("moves to a plain command from an open menu, closing that menu", () => {
    byId("nm-file").focus();
    byId("nm-file").click(); // open File, focus New
    key("nm-new", "ArrowLeft"); // wraps to Help, the last top: a plain command

    expect(document.activeElement).toBe(byId("nm-help"));
    expect(menuHidden("nm-m-file")).toBe(true);
    expect(expanded("nm-file")).toBe("false");
    expect(tabStops()).toEqual([byId("nm-help")]);
  });

  it("moves to a plain command from a top item while closed", () => {
    pressOn("nm-file", "ArrowLeft"); // wraps to Help
    expect(document.activeElement).toBe(byId("nm-help"));
    expect(tabStops()).toEqual([byId("nm-help")]);
  });

  it("closes the open menu when a plain command is clicked", () => {
    byId("nm-file").focus();
    byId("nm-file").click();
    byId("nm-help").click();

    expect(menuHidden("nm-m-file")).toBe(true);
    expect(expanded("nm-file")).toBe("false");
    expect(document.activeElement).toBe(byId("nm-help"));
  });

  it("still roves onto a dangling top while nothing is open", () => {
    // The "leave everything untouched" contract is about the *open a menu* path.
    // With no menu open there is nothing to protect, and a top item that is a
    // target is an ordinary roving destination.
    pressOn("nm-file", "ArrowRight");
    expect(document.activeElement).toBe(byId("nm-gone"));
    expect(tabStops()).toEqual([byId("nm-gone")]);
    expect(expanded("nm-gone")).toBe("false");
  });

  it("keeps the open menu and focus when a sideways move resolves no menu", () => {
    // A *dangling* `aria-controls` is broken markup, not a plain command: the
    // contract is to leave the open/closed state and focus untouched.
    byId("nm-file").click();
    expect(document.activeElement).toBe(byId("nm-new"));

    key("nm-new", "ArrowRight"); // -> Gone, whose aria-controls resolves to nothing

    expect(menuHidden("nm-m-file")).toBe(false);
    expect(expanded("nm-file")).toBe("true");
    expect(document.activeElement).toBe(byId("nm-new"));
  });

  it("keeps the open menu when a dangling aria-controls top is activated", () => {
    byId("nm-file").click();
    byId("nm-gone").click();
    expect(menuHidden("nm-m-file")).toBe(false);
    expect(expanded("nm-gone")).toBe("false");
  });
});

describe("MenubarController with menus that hold no navigable item", () => {
  let application: Application;

  beforeEach(async () => {
    // Two shapes that look alike but are different contracts.
    //
    // Empty: a menu a consumer streams items into later. It still opens —
    // swallowing the click would leave it permanently unopenable — and while its
    // required owned `menuitem`s are absent the consumer MUST mark it
    // `aria-busy="true"` (WAI-ARIA "Required Owned Elements"). The controller
    // never infers that state; it cannot tell "still loading" from "nothing to
    // show".
    //
    // Inert: real menuitems exist, they are simply unavailable, so the menu is
    // NOT busy. Both leave focus on the top item because there is nothing to
    // move it to.
    application = await mount(`
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        ${top("ne-empty", "Empty", "ne-m-empty")}
        ${menu("ne-m-empty", "Empty", "", 'aria-busy="true"')}
        ${top("ne-inert", "Inert", "ne-m-inert")}
        ${menu(
          "ne-m-inert",
          "Inert",
          `${item("ne-off", "Off", "disabled")}
           ${item("ne-gone", "Gone", "hidden")}`,
        )}
      </div>`);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("opens an empty menu on click and keeps focus on its top item", () => {
    byId("ne-empty").focus();
    byId("ne-empty").click();
    expect(menuHidden("ne-m-empty")).toBe(false);
    expect(expanded("ne-empty")).toBe("true");
    expect(document.activeElement).toBe(byId("ne-empty"));
  });

  it("opens an empty menu with ArrowDown/ArrowUp without moving focus", () => {
    pressOn("ne-empty", "ArrowDown");
    expect(menuHidden("ne-m-empty")).toBe(false);
    expect(document.activeElement).toBe(byId("ne-empty"));

    byId("ne-empty").click(); // back to closed
    pressOn("ne-empty", "ArrowUp");
    expect(menuHidden("ne-m-empty")).toBe(false);
    expect(document.activeElement).toBe(byId("ne-empty"));
  });

  it("closes an open empty menu on Escape and on a second click", () => {
    byId("ne-empty").focus();
    byId("ne-empty").click();
    key("ne-empty", "Escape");
    expect(menuHidden("ne-m-empty")).toBe(true);
    expect(expanded("ne-empty")).toBe("false");
    expect(document.activeElement).toBe(byId("ne-empty"));

    byId("ne-empty").click();
    expect(menuHidden("ne-m-empty")).toBe(false);
    byId("ne-empty").click();
    expect(menuHidden("ne-m-empty")).toBe(true);
    expect(expanded("ne-empty")).toBe("false");
  });

  it("opens a menu whose every item is inert, leaving arrows inside it inert too", () => {
    byId("ne-inert").focus();
    byId("ne-inert").click();
    expect(menuHidden("ne-m-inert")).toBe(false);
    expect(expanded("ne-inert")).toBe("true");
    expect(document.activeElement).toBe(byId("ne-inert"));

    // The arrows are still consumed (the menubar owns them) but find no target.
    expect(key("ne-inert", "ArrowDown").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId("ne-inert"));
  });

  it("clears the required-children review on an open empty menu while it is busy", async () => {
    // `role="menu"` must own `menuitem`s. Opened empty and *not* marked busy, axe
    // holds `aria-required-children` back for human review; `aria-busy="true"` is
    // what says "they are on their way" and settles it. Scoped to that one rule
    // id because happy-dom leaves unrelated rules (colour contrast, url-valued
    // attributes) incomplete by construction, so a blanket assertion would be
    // asserting a happy-dom property rather than this contract.
    const root = document.querySelector("[data-controller='stimeo--menubar']") as HTMLElement;
    byId("ne-empty").focus();
    byId("ne-empty").click();

    expect(byId("ne-m-empty").getAttribute("aria-busy")).toBe("true");
    await expectNoA11yViolations(root);
    const results = await auditA11y(root);
    expect(results.incomplete.map((result) => result.id)).not.toContain("aria-required-children");
  });

  it("needs no aria-busy on a menu whose items exist but are all inert", async () => {
    const root = document.querySelector("[data-controller='stimeo--menubar']") as HTMLElement;
    byId("ne-inert").focus();
    byId("ne-inert").click();

    expect(byId("ne-m-inert").hasAttribute("aria-busy")).toBe(false);
    await expectNoA11yViolations(root);
    const results = await auditA11y(root);
    expect(results.incomplete.map((result) => result.id)).not.toContain("aria-required-children");
  });

  it("navigates the items a consumer streams into a busy menu", async () => {
    byId("ne-empty").focus();
    byId("ne-empty").click();

    byId("ne-m-empty").insertAdjacentHTML("beforeend", item("ne-late", "Late"));
    byId("ne-m-empty").removeAttribute("aria-busy"); // the consumer's other half
    await tick();

    pressOn("ne-empty", "ArrowDown"); // reopens at the first item, which now exists
    expect(document.activeElement).toBe(byId("ne-late"));
    expect(menuHidden("ne-m-empty")).toBe(false);
  });
});

describe("MenubarController under runtime DOM changes", () => {
  let application: Application;

  beforeEach(async () => {
    application = await mount(`
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        ${top("rt-file", "File", "rt-m-file")}
        ${menu("rt-m-file", "File", `${item("rt-new", "New")}${item("rt-save", "Save")}`)}
        ${top("rt-edit", "Edit", "rt-m-edit")}
        ${menu("rt-m-edit", "Edit", item("rt-cut", "Cut"))}
        ${top("rt-view", "View", "rt-m-view")}
        ${menu("rt-m-view", "View", item("rt-zoom", "Zoom"))}
      </div>`);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  /** Presses Escape from current focus and reports whether a document layer owned it. */
  const escapeConsumed = (): boolean => {
    const press = keyEvent("Escape");
    keyboardPress(document.activeElement as HTMLElement, press);
    return press.defaultPrevented;
  };

  it("hands the tab stop on when the top item holding it is disabled at runtime", async () => {
    expect(tabStops()).toEqual([byId("rt-file")]);

    (byId("rt-file") as HTMLButtonElement).disabled = true;
    await tick();

    // An unfocusable tabindex="0" would drop the whole menubar out of the Tab order.
    expect(tabStops()).toEqual([byId("rt-edit")]);
  });

  it("reconciles a runtime state change without writing to menus that are already closed", async () => {
    const menus = ["rt-m-file", "rt-m-edit", "rt-m-view"].map(byId);
    const records: MutationRecord[] = [];
    const watcher = new MutationObserver((batch) => records.push(...batch));
    for (const element of menus) {
      watcher.observe(element, { attributes: true, attributeFilter: ["hidden"] });
    }

    (byId("rt-view") as HTMLButtonElement).disabled = true;
    await tick();
    watcher.disconnect();

    // The controller observes `hidden` under the menubar, so even an identical write
    // onto a closed menu would schedule another reconcile pass.
    expect(records).toEqual([]);
    expect(menus.map((element) => element.hidden)).toEqual([true, true, true]);
  });

  it("hands the tab stop on when the top item holding it is hidden at runtime", async () => {
    byId("rt-file").setAttribute("hidden", "");
    await tick();
    expect(tabStops()).toEqual([byId("rt-edit")]);
  });

  it("keeps no tab stop while every top is inert, and recovers when one comes back", async () => {
    for (const id of ["rt-file", "rt-edit", "rt-view"]) {
      (byId(id) as HTMLButtonElement).disabled = true;
    }
    await tick();
    expect(tabStops()).toEqual([]);

    (byId("rt-edit") as HTMLButtonElement).disabled = false;
    await tick();
    expect(tabStops()).toEqual([byId("rt-edit")]);
  });

  it("gives the tab stop to a top item that joins by its target token while the others are inert", async () => {
    for (const id of ["rt-file", "rt-edit", "rt-view"]) {
      (byId(id) as HTMLButtonElement).disabled = true;
    }
    byId("rt-view").insertAdjacentHTML(
      "afterend",
      '<button id="rt-late" role="menuitem">Late</button>',
    );
    await tick();
    expect(tabStops()).toEqual([]);

    byId("rt-late").setAttribute("data-stimeo--menubar-target", "top");
    await tick();

    expect(tabStops()).toEqual([byId("rt-late")]);
  });

  it("keeps exactly one tab stop when a top item is added at runtime", async () => {
    // A fresh <button> is tabbable by default, which would make the menubar two
    // Tab stops — and the authored one must not move.
    byId("rt-view").insertAdjacentHTML("afterend", top("rt-help", "Help", "rt-m-help"));
    byId("rt-view").insertAdjacentHTML(
      "afterend",
      menu("rt-m-help", "Help", item("rt-faq", "FAQ")),
    );
    await tick();

    expect(tabStops()).toEqual([byId("rt-file")]);
    expect(byId("rt-help").tabIndex).toBe(-1);
  });

  it("keeps the tab stop when a top item is prepended at runtime", async () => {
    // A top inserted *before* the current stop is the case a "is anything
    // tabbable?" check cannot see: the fresh <button> is tabbable by default and
    // comes first in DOM order, so it would silently become the entry point.
    key("rt-file", "ArrowRight"); // move the stop to Edit first
    expect(tabStops()).toEqual([byId("rt-edit")]);

    byId("rt-file").insertAdjacentHTML("beforebegin", top("rt-help", "Help", "rt-m-help"));
    byId("rt-file").insertAdjacentHTML(
      "beforebegin",
      menu("rt-m-help", "Help", item("rt-faq", "FAQ")),
    );
    await tick();

    expect(tabStops()).toEqual([byId("rt-edit")]);
    expect(byId("rt-help").tabIndex).toBe(-1);
  });

  it("hands the tab stop on when the top item holding it is removed", async () => {
    byId("rt-file").remove();
    await tick();
    expect(tabStops()).toEqual([byId("rt-edit")]);
  });

  it("collapses the owner when an open menu target is replaced by a fresh one", async () => {
    // A Turbo Stream `replace` removes the menu and inserts a new element with the
    // same id, carrying the contract's `hidden`. The replacement still *resolves*,
    // so "did the menu disappear?" is not enough to notice that the top is now
    // claiming a popup nobody can see — and that it still owns the Escape layer.
    byId("rt-file").focus();
    byId("rt-file").click();
    expect(expanded("rt-file")).toBe("true");

    byId("rt-m-file").outerHTML = menu("rt-m-file", "File", item("rt-fresh", "Fresh"));
    await tick();

    expect(expanded("rt-file")).toBe("false");
    expect(menuHidden("rt-m-file")).toBe(true);
    expect(escapeConsumed()).toBe(false);

    // And the menubar is still operable: the top reopens onto the new items.
    byId("rt-file").click();
    expect(menuHidden("rt-m-file")).toBe(false);
    expect(document.activeElement).toBe(byId("rt-fresh"));
  });

  it("cleans up a top item that leaves by losing only its target token", async () => {
    // A morph can drop `data-*-target` without removing the node. Stimulus reports
    // the disconnect, but the element stays in the page — still carrying this
    // controller's `tabindex="0"` (a second Tab stop) and an `aria-expanded="true"`
    // that nothing can collapse any more.
    byId("rt-file").focus();
    byId("rt-file").click();
    expect(expanded("rt-file")).toBe("true");

    byId("rt-file").removeAttribute("data-stimeo--menubar-target");
    await tick();

    expect(byId("rt-file").tabIndex).toBe(-1);
    expect(expanded("rt-file")).toBe("false");
    expect(menuHidden("rt-m-file")).toBe(true);
    expect(tabStops()).toEqual([byId("rt-edit")]); // exactly one, on a live target
    expect(escapeConsumed()).toBe(false);
  });

  it("closes a menu that leaves by losing only its target token", async () => {
    byId("rt-file").focus();
    byId("rt-file").click();

    byId("rt-m-file").removeAttribute("data-stimeo--menubar-target");
    await tick();

    // Left visible it would be a popup no key and no click can dismiss.
    expect(menuHidden("rt-m-file")).toBe(true);
    expect(expanded("rt-file")).toBe("false");
    expect(escapeConsumed()).toBe(false);
  });

  it("cleans up a top item that loses only its target token once its open menu has settled", async () => {
    // Opening writes the menu's `hidden`, which the menubar observes; letting that
    // pass run first leaves the lost token as the only change.
    byId("rt-file").focus();
    byId("rt-file").click();
    await tick();

    byId("rt-file").removeAttribute("data-stimeo--menubar-target");
    await tick();

    expect(menuHidden("rt-m-file")).toBe(true);
    expect(tabStops()).toEqual([byId("rt-edit")]);
    expect(escapeConsumed()).toBe(false);
  });

  it("collapses the owner and releases Escape before a departing open menu's callback returns", () => {
    byId("rt-file").focus();
    byId("rt-file").click();
    const popup = byId("rt-m-file");
    popup.removeAttribute("data-stimeo--menubar-target");

    // The callback Stimulus delivers for the token just lost.
    menubarOf(application).menuTargetDisconnected(popup);

    expect(popup.hidden).toBe(true);
    expect(expanded("rt-file")).toBe("false");
    expect(escapeConsumed()).toBe(false);
  });

  it("hides a visible menu that joins by its target token without an expanded owner", async () => {
    const popup = byId("rt-m-file");
    popup.removeAttribute("data-stimeo--menubar-target");
    await tick();
    popup.hidden = false;
    await tick();
    expect(expanded("rt-file")).toBe("false");

    popup.setAttribute("data-stimeo--menubar-target", "menu");
    await tick();

    // A popup no expanded top owns is one nothing can dismiss again.
    expect(popup.hidden).toBe(true);
  });

  it.each([
    ["hidden", (top: HTMLElement) => top.setAttribute("hidden", "")],
    ["disabled", (top: HTMLElement) => ((top as HTMLButtonElement).disabled = true)],
  ])("collapses an expanded top item that becomes %s at runtime", async (_label, makeInert) => {
    // The owner going out of reach strands its popup: still on screen, with no
    // focusable element left that owns it.
    byId("rt-file").focus();
    byId("rt-file").click();
    expect(expanded("rt-file")).toBe("true");

    makeInert(byId("rt-file"));
    await tick();

    expect(expanded("rt-file")).toBe("false");
    expect(menuHidden("rt-m-file")).toBe(true);
    expect(escapeConsumed()).toBe(false);
    expect(tabStops()).toEqual([byId("rt-edit")]);
  });

  it("takes Escape ownership for a menu a morph opened in place", async () => {
    // The DOM is this controller's only source of truth, so a morph that patches
    // `aria-expanded` and `hidden` directly really has opened the menu — and the
    // menubar has to be on the Escape stack for it, or the popup cannot be closed
    // by keyboard at all.
    byId("rt-file").setAttribute("aria-expanded", "true");
    byId("rt-m-file").hidden = false;
    await tick();

    byId("rt-new").focus();
    expect(key("rt-new", "Escape").defaultPrevented).toBe(true);
    expect(menuHidden("rt-m-file")).toBe(true);
    expect(expanded("rt-file")).toBe("false");
    expect(document.activeElement).toBe(byId("rt-file"));
  });

  it("registers the Escape layer once across unrelated mutations", async () => {
    // Re-activating an active layer moves it to the top of the shared stack, so a
    // mutation that changes nothing about the open state must not re-register.
    byId("rt-file").focus();
    byId("rt-file").click();

    const outer = new EscapeLayer();
    try {
      outer.activate(document, { onDismiss: () => {} });
      byId("rt-m-file").insertAdjacentHTML("beforeend", item("rt-extra", "Extra"));
      await tick();

      // The menubar opened first, so the later layer still owns the press.
      expect(outer.ownsEscape).toBe(true);
    } finally {
      // The stack is per-document and outlives this test; a leak here would make
      // the *next* test's Escape assertions read another layer's decision.
      outer.deactivate();
    }
  });

  it("collapses the owner and releases Escape when an open menu target is removed", async () => {
    byId("rt-file").focus();
    byId("rt-file").click(); // open File, focus New
    expect(expanded("rt-file")).toBe("true");

    byId("rt-m-file").remove();
    await tick();

    expect(expanded("rt-file")).toBe("false"); // no popup left to be expanded
    expect(escapeConsumed()).toBe(false); // the Escape layer is no longer registered
  });

  it("hides an orphaned menu and releases Escape when its top item is removed", async () => {
    byId("rt-file").focus();
    byId("rt-file").click();

    byId("rt-file").remove();
    await tick();

    // Nothing can close a menu whose owner is gone, so it must not stay visible.
    expect(menuHidden("rt-m-file")).toBe(true);
    expect(escapeConsumed()).toBe(false);
    expect(tabStops()).toEqual([byId("rt-edit")]);
  });

  it("returns focus to the menubar when the focused top item is removed", async () => {
    byId("rt-file").focus();

    byId("rt-file").remove();
    await tick();

    // The tab stop moved on, and focus follows it rather than falling to <body>,
    // which would put the keyboard user back at the top of the document.
    expect(tabStops()).toEqual([byId("rt-edit")]);
    expect(document.activeElement).toBe(byId("rt-edit"));
  });

  it("returns focus to the owning top when the open menu holding focus is removed", async () => {
    byId("rt-file").focus();
    byId("rt-file").click(); // open File, focus New
    expect(document.activeElement).toBe(byId("rt-new"));

    byId("rt-m-file").remove();
    await tick();

    expect(expanded("rt-file")).toBe("false");
    expect(document.activeElement).toBe(byId("rt-file"));
  });

  it("returns focus to the menubar when the top item holding an open menu is hidden", async () => {
    byId("rt-file").focus();
    byId("rt-file").click(); // open File, focus New
    expect(document.activeElement).toBe(byId("rt-new"));

    byId("rt-file").setAttribute("hidden", "");
    await tick();

    // The menu comes down with its owner, and focus leaves before the element
    // that holds it becomes unreachable — a browser blurs a hidden element only
    // on its next style pass, which is too late to react to.
    expect(menuHidden("rt-m-file")).toBe(true);
    expect(document.activeElement).toBe(byId("rt-edit"));
  });

  it("does not pull focus back when it is already somewhere else", async () => {
    const outside = document.createElement("button");
    outside.id = "rt-outside";
    document.body.appendChild(outside);
    byId("rt-file").focus();
    outside.focus();

    byId("rt-file").remove();
    await tick();

    // The mutation made an element unreachable, but focus was never lost, so
    // moving it would be a steal rather than a rescue.
    expect(document.activeElement).toBe(outside);
  });

  it("leaves an open menu alone while unrelated items change", async () => {
    byId("rt-file").focus();
    byId("rt-file").click();

    byId("rt-m-file").insertAdjacentHTML("beforeend", item("rt-archive", "Archive"));
    await tick();

    expect(menuHidden("rt-m-file")).toBe(false);
    expect(expanded("rt-file")).toBe("true");
    expect(escapeConsumed()).toBe(true); // still owned while open
  });
});

describe("MenubarController yielding a key a descendant already consumed", () => {
  let application: Application;

  beforeEach(async () => {
    // A nested widget (an inline editor, a grabbed drag handle) inside a top item
    // or a menu item that already called preventDefault must not ALSO move the
    // menubar's roving focus.
    application = await mount(`
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        <button id="dp-file" role="menuitem" aria-haspopup="menu" aria-expanded="false"
                aria-controls="dp-m-file" data-stimeo--menubar-target="top"
                data-action="click->stimeo--menubar#toggle
                             keydown->stimeo--menubar#onTopKeydown">File <span id="dp-top-inner" tabindex="0">*</span></button>
        <ul id="dp-m-file" role="menu" aria-label="File" hidden data-stimeo--menubar-target="menu">
          <li role="none">
            <button id="dp-new" role="menuitem" tabindex="-1" data-stimeo--menubar-target="item"
                    data-action="click->stimeo--menubar#activate
                                 keydown->stimeo--menubar#onItemKeydown">New <span id="dp-item-inner" tabindex="0">*</span></button>
          </li>
          <li role="none">
            <button id="dp-open" role="menuitem" tabindex="-1" data-stimeo--menubar-target="item"
                    data-action="click->stimeo--menubar#activate
                                 keydown->stimeo--menubar#onItemKeydown">Open</button>
          </li>
        </ul>
        ${top("dp-edit", "Edit", "dp-m-edit")}
        ${menu("dp-m-edit", "Edit", item("dp-cut", "Cut"))}
      </div>`);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("does not rove the top items on a key the descendant consumed", () => {
    byId("dp-file").focus();
    byId("dp-top-inner").addEventListener("keydown", (event) => event.preventDefault());

    keyboardPress(byId("dp-top-inner"), "ArrowRight");

    expect(document.activeElement).toBe(byId("dp-top-inner"));
    expect(tabStops()).toEqual([byId("dp-file")]);
    expect(menuHidden("dp-m-edit")).toBe(true);
  });

  it("does not move inside the menu on a key the descendant consumed", () => {
    byId("dp-file").focus();
    byId("dp-file").click(); // open, focus New
    byId("dp-item-inner").addEventListener("keydown", (event) => event.preventDefault());

    keyboardPress(byId("dp-item-inner"), "ArrowDown");

    expect(document.activeElement).toBe(byId("dp-item-inner"));
  });
});

describe("MenubarController outside-click detection", () => {
  let application: Application;

  beforeEach(async () => {
    // The menu holds a non-item element a consumer handler can remove on click —
    // the case that makes the *bubble* phase wrong for outside-click detection,
    // so the listener runs in the capture phase.
    application = await mount(`
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        ${top("ph-file", "File", "ph-m-file")}
        <ul id="ph-m-file" role="menu" aria-label="File" hidden data-stimeo--menubar-target="menu">
          ${item("ph-new", "New")}
          <li role="none"><span id="ph-volatile">Dismiss the banner</span></li>
        </ul>
      </div>`);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("keeps the menu open when an inside click handler removes its own target", () => {
    byId("ph-file").focus();
    byId("ph-file").click();
    const volatileNode = byId("ph-volatile");
    volatileNode.addEventListener("click", () => volatileNode.remove());

    volatileNode.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // In the bubble phase the document listener runs *after* the node left the
    // DOM, so `element.contains(event.target)` is false and an inside click
    // closes the menu. Capture observes the click before anything can move it.
    expect(menuHidden("ph-m-file")).toBe(false);
    expect(expanded("ph-file")).toBe("true");
  });
});

describe("Multiple menubars on one page", () => {
  let application: Application;

  /** A single-menu menubar whose ids are namespaced by `prefix`. */
  const instance = (prefix: string) => `
    <div data-controller="stimeo--menubar" role="menubar" aria-label="${prefix}">
      ${top(`${prefix}-file`, "File", `${prefix}-m-file`)}
      ${menu(
        `${prefix}-m-file`,
        "File",
        `${item(`${prefix}-new`, "New")}${item(`${prefix}-save`, "Save")}`,
      )}
    </div>`;

  beforeEach(async () => {
    application = await mount(`${instance("a")}${instance("b")}`);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("opens only the menu of the instance that was operated", () => {
    byId("a-file").click();
    expect(menuHidden("a-m-file")).toBe(false);
    expect(menuHidden("b-m-file")).toBe(true);
    expect(expanded("b-file")).toBe("false");
    expect(byId("b-file").tabIndex).toBe(0); // its own tab stop is untouched
  });

  it("closes the open instance and opens the clicked one", () => {
    // The trade-off of capture-phase outside-click detection: the document listener
    // runs *before* the clicked trigger's own handler, so the close must not swallow
    // the open that follows it.
    byId("a-file").focus();
    byId("a-file").click();
    byId("b-file").focus();
    byId("b-file").click();

    expect(menuHidden("a-m-file")).toBe(true);
    expect(expanded("a-file")).toBe("false");
    expect(menuHidden("b-m-file")).toBe(false);
    expect(document.activeElement).toBe(byId("b-new"));
  });

  it("closes only the instance the Escape was pressed in", () => {
    byId("a-file").click();
    key("a-new", "Escape");
    expect(menuHidden("a-m-file")).toBe(true);
    expect(document.activeElement).toBe(byId("a-file"));

    byId("b-file").click(); // the other instance still works independently
    expect(menuHidden("b-m-file")).toBe(false);
    expect(menuHidden("a-m-file")).toBe(true);
    key("b-new", "Escape");
    expect(menuHidden("b-m-file")).toBe(true);
    expect(document.activeElement).toBe(byId("b-file"));
  });
});

/** Explicit target calls share the DOM action while retaining their own provenance. */
describe("MenubarController target API", () => {
  let application: Application;
  const element = (id: string): HTMLElement => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing API fixture ${id}`);
    return found;
  };
  const instance = (): MenubarController =>
    application.getControllerForElementAndIdentifier(
      element("api-root"),
      "stimeo--menubar",
    ) as MenubarController;
  beforeEach(async () => {
    document.body.innerHTML = `<button id="api-outside">Outside</button><div id="api-root" data-controller="stimeo--menubar" role="menubar"><button id="api-a" data-stimeo--menubar-target="top" aria-controls="api-panel-a" aria-expanded="false" data-action="click->stimeo--menubar#toggle"><span>a</span></button><div id="api-panel-a" role="menu" data-stimeo--menubar-target="menu" hidden><button role="menuitem" data-stimeo--menubar-target="item">Run</button></div><button id="api-b" data-stimeo--menubar-target="top" aria-controls="api-panel-b" aria-expanded="false" data-action="click->stimeo--menubar#toggle"><span>b</span></button><div id="api-panel-b" role="menu" data-stimeo--menubar-target="menu" hidden><button role="menuitem" data-stimeo--menubar-target="item">Run</button></div></div>`;
    application = Application.start();
    application.register("stimeo--menubar", MenubarController);
    await tick();
  });
  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("opens from a DOM click event as a positive control", () => {
    const reports: Array<{ reason?: string }> = [];
    element("api-root").addEventListener("stimeo--menubar:open", (event) => {
      reports.push((event as CustomEvent<{ reason?: string }>).detail);
    });
    element("api-b").click();
    expect(element("api-b").getAttribute("aria-expanded")).toBe("true");
    expect(reports).toHaveLength(1);
  });

  it.each([false, true])(
    "accepts an owned target or its descendant (%s) through the element API",
    (descendant) => {
      const reports: Array<{ reason?: string }> = [];
      element("api-root").addEventListener("stimeo--menubar:open", (event) => {
        reports.push((event as CustomEvent<{ reason?: string }>).detail);
      });
      element("api-b").click();
      expect(element("api-b").getAttribute("aria-expanded")).toBe("true");
      expect(reports).toHaveLength(1);
      element("api-outside").focus();
      const target = descendant ? element("api-a").querySelector("span") : element("api-a");
      if (!(target instanceof HTMLElement)) throw new Error("Missing API descendant");
      instance().toggle(target);
      expect(element("api-a").getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(element("api-outside"));
      expect(reports.at(-1)?.reason).toBe("api");
      expect(reports[0]?.reason).toBe("user");
    },
  );
  it.each(["foreign", "undeclared", "detached", "nested"])(
    "rejects %s targets through element and Event entry points before accepting an owned target",
    (kind) => {
      const reports: unknown[] = [];
      element("api-root").addEventListener("stimeo--menubar:open", (event) => {
        reports.push((event as CustomEvent<unknown>).detail);
      });
      const invalid = element("api-b").cloneNode(true);
      if (!(invalid instanceof HTMLElement)) throw new Error("Missing cloned target");
      invalid.id = "api-invalid";
      invalid.removeAttribute("data-action");
      if (kind === "foreign") document.body.append(invalid);
      if (kind === "undeclared") {
        invalid.removeAttribute("data-stimeo--menubar-target");
        element("api-root").append(invalid);
      }
      if (kind === "nested") {
        const nested = document.createElement("div");
        nested.setAttribute("data-controller", "stimeo--menubar");
        nested.append(invalid);
        element("api-a").append(nested);
      }
      element("api-outside").focus();
      const before = element("api-root").innerHTML;
      instance().toggle(invalid);
      invalid.addEventListener("probe", (event) => instance().toggle(event));
      invalid.dispatchEvent(new Event("probe"));
      expect(element("api-root").innerHTML).toBe(before);
      expect(reports).toEqual([]);
      expect(document.activeElement).toBe(element("api-outside"));
      instance().toggle(element("api-b"));
      expect(element("api-b").getAttribute("aria-expanded")).toBe("true");
      expect(reports).toHaveLength(1);
    },
  );

  it.each([
    ["focusin", "focus"],
    ["pointerenter", "pointer"],
    ["click", "user"],
  ])("retains %s Event provenance for an action bound on a target descendant", (type, reason) => {
    const reports: Array<{ reason: string }> = [];
    element("api-root").addEventListener("stimeo--menubar:open", (event) => {
      reports.push((event as CustomEvent<{ reason: string }>).detail);
    });
    const child = element("api-b").querySelector("span");
    if (!(child instanceof HTMLElement)) throw new Error("Missing action descendant");
    child.addEventListener(type, (event) => instance().toggle(event));
    child.dispatchEvent(new Event(type));
    expect(element("api-b").getAttribute("aria-expanded")).toBe("true");
    expect(reports.map((detail) => detail.reason)).toEqual([reason]);
  });

  it.each([false, true])("opens through API with internal focus movement only (%s)", (inside) => {
    (inside ? element("api-a") : element("api-outside")).focus();
    instance().toggle(element("api-b"));
    const item = element("api-panel-b").querySelector("button");
    expect(document.activeElement).toBe(inside ? item : element("api-outside"));
    expect(element("api-b").tabIndex).toBe(0);
    expect(element("api-a").tabIndex).toBe(-1);
  });

  it.each([false, true])(
    "activates an item descendant with select reason and conditional focus (%s)",
    (inside) => {
      instance().toggle(element("api-b"));
      const item = element("api-panel-b").querySelector("button");
      if (!(item instanceof HTMLElement)) throw new Error("Missing menu item");
      const child = document.createElement("span");
      item.append(child);
      (inside ? item : element("api-outside")).focus();
      const reports: Array<{ reason: string }> = [];
      element("api-root").addEventListener("stimeo--menubar:close", (event) => {
        reports.push((event as CustomEvent<{ reason: string }>).detail);
      });
      instance().activate(child);
      expect(element("api-panel-b").hidden).toBe(true);
      expect(reports.map((detail) => detail.reason)).toEqual(["select"]);
      expect(document.activeElement).toBe(inside ? element("api-b") : element("api-outside"));
      expect(element("api-b").tabIndex).toBe(0);
    },
  );

  /** Puts `constraint` on `target` the way an author writes it. */
  const constrain = (target: HTMLElement, constraint: "aria-disabled" | "disabled" | "hidden") => {
    if (constraint === "aria-disabled") target.setAttribute("aria-disabled", "true");
    else target.toggleAttribute(constraint, true);
  };
  const CONSTRAINED_SOURCES = (["aria-disabled", "disabled", "hidden"] as const).flatMap(
    (constraint) => [false, true].map((descendant) => [constraint, descendant] as const),
  );

  it.each(CONSTRAINED_SOURCES)(
    "refuses the %s top through the element API, from the top or its descendant (%s)",
    async (constraint, descendant) => {
      const opener = element("api-b");
      constrain(opener, constraint);
      await tick();
      element("api-outside").focus();
      const capture = captureStateEvents("stimeo--menubar", ["open", "close"], element("api-root"));
      const source = descendant ? opener.querySelector("span") : opener;
      if (!(source instanceof HTMLElement)) throw new Error("Missing API source");

      instance().toggle(source);
      await tick();
      capture.stop();

      expect(capture.seen).toEqual([]);
      expect(opener.getAttribute("aria-expanded")).toBe("false");
      expect(element("api-panel-b").hidden).toBe(true);
      expect(document.activeElement).toBe(element("api-outside"));
      expect(element("api-a").tabIndex).toBe(0);
      expect(opener.tabIndex).toBe(-1);
    },
  );

  it.each(CONSTRAINED_SOURCES)(
    "refuses the %s menu item through the element API, from the item or its descendant (%s)",
    async (constraint, descendant) => {
      element("api-outside").focus();
      instance().toggle(element("api-b"));
      const owned = element("api-panel-b").querySelector("button");
      if (!(owned instanceof HTMLElement)) throw new Error("Missing menu item");
      const child = document.createElement("span");
      owned.append(child);
      constrain(owned, constraint);
      await tick();
      const capture = captureStateEvents("stimeo--menubar", ["open", "close"], element("api-root"));

      instance().activate(descendant ? child : owned);
      await tick();
      capture.stop();

      expect(capture.seen).toEqual([]);
      expect(element("api-panel-b").hidden).toBe(false);
      expect(element("api-b").getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(element("api-outside"));
      expect(element("api-b").tabIndex).toBe(0);
    },
  );

  it("ignores activation from an unowned item without closing an owned menu", () => {
    instance().toggle(element("api-b"));
    const foreign = document.createElement("button");
    foreign.setAttribute("data-stimeo--menubar-target", "item");
    document.body.append(foreign);
    instance().activate(foreign);
    foreign.addEventListener("probe", (event) => instance().activate(event));
    foreign.dispatchEvent(new Event("probe"));
    expect(element("api-panel-b").hidden).toBe(false);
    expect(element("api-b").getAttribute("aria-expanded")).toBe("true");
  });

  it("rejects a nested origin even when the Event handler belongs to an owned outer target", () => {
    const nested = document.createElement("div");
    nested.setAttribute("data-controller", "stimeo--menubar");
    const child = document.createElement("span");
    child.setAttribute("data-stimeo--menubar-target", "top");
    nested.append(child);
    element("api-b").append(nested);
    const reports = vi.fn();
    element("api-root").addEventListener("stimeo--menubar:open", reports);
    const before = element("api-root").innerHTML;
    element("api-b").addEventListener("probe", (event) => instance().toggle(event));
    child.dispatchEvent(new Event("probe", { bubbles: true }));
    expect(element("api-root").innerHTML).toBe(before);
    expect(reports).not.toHaveBeenCalled();
    instance().toggle(element("api-b"));
    expect(reports).toHaveBeenCalledOnce();
  });
  it.each([
    ["api", "inside", "unchanged"],
    ["api", "inside", "outside"],
    ["event", "inside", "outside"],
    ["api", "outside", "inside"],
  ] as const)(
    "rechecks synchronous open subscriber focus for %s from %s to %s",
    (source, initial, destination) => {
      const outside = element("api-outside");
      const first = element("api-a");
      const opener = element("api-b");
      (initial === "inside" ? first : outside).focus();
      element("api-root").addEventListener("stimeo--menubar:open", () => {
        if (destination === "outside") outside.focus();
        if (destination === "inside") first.focus();
      });
      if (source === "api") instance().toggle(opener);
      else opener.click();
      const menuItem = element("api-panel-b").querySelector("button");
      const expected =
        source === "event" || destination === "unchanged"
          ? menuItem
          : destination === "outside"
            ? outside
            : first;
      expect(document.activeElement).toBe(expected);
      expect(element("api-panel-b").hidden).toBe(false);
      expect(opener.tabIndex).toBe(0);
      expect(first.tabIndex).toBe(-1);
    },
  );

  it.each(["api", "event"] as const)(
    "rechecks synchronous close subscriber focus during %s item activation",
    (source) => {
      element("api-a").focus();
      instance().toggle(element("api-b"));
      const item = element("api-panel-b").querySelector("button");
      if (!(item instanceof HTMLElement)) throw new Error("Missing menu item");
      item.focus();
      const reasons: string[] = [];
      element("api-root").addEventListener("stimeo--menubar:close", (event) => {
        reasons.push((event as CustomEvent<{ reason: string }>).detail.reason);
        element("api-outside").focus();
      });
      if (source === "api") instance().activate(item);
      else {
        item.addEventListener("probe", (event) => instance().activate(event));
        item.dispatchEvent(new Event("probe"));
      }
      expect(document.activeElement).toBe(
        source === "api" ? element("api-outside") : element("api-b"),
      );
      expect(element("api-panel-b").hidden).toBe(true);
      expect(element("api-b").tabIndex).toBe(0);
      expect(reasons).toEqual(["select"]);
    },
  );

  it.each(["api", "event"] as const)(
    "rechecks synchronous close subscriber focus when a %s plain command replaces a menu",
    (source) => {
      element("api-a").focus();
      instance().toggle(element("api-a"));
      const command = element("api-b");
      command.removeAttribute("aria-controls");
      element("api-root").addEventListener("stimeo--menubar:close", () =>
        element("api-outside").focus(),
      );
      if (source === "api") instance().toggle(command);
      else command.click();
      expect(document.activeElement).toBe(source === "api" ? element("api-outside") : command);
      expect(element("api-panel-a").hidden).toBe(true);
      expect(command.tabIndex).toBe(0);
      expect(element("api-a").tabIndex).toBe(-1);
    },
  );
  it("ignores activation of an undeclared host inside the root before accepting a menu item", () => {
    instance().toggle(element("api-b"));
    const invalid = document.createElement("span");
    element("api-root").append(invalid);
    const reports = vi.fn();
    element("api-root").addEventListener("stimeo--menubar:close", reports);
    expect(() => instance().activate(invalid)).not.toThrow();
    expect(element("api-panel-b").hidden).toBe(false);
    expect(reports).not.toHaveBeenCalled();
    const owned = element("api-panel-b").querySelector("button");
    if (!(owned instanceof HTMLElement)) throw new Error("Missing owned item");
    instance().activate(owned);
    expect(element("api-panel-b").hidden).toBe(true);
    expect(reports).toHaveBeenCalledOnce();
  });

  it("rejects unmarked activation inside a nested scope even when its nearest menu item is owned", () => {
    instance().toggle(element("api-b"));
    const owned = element("api-panel-b").querySelector("button");
    if (!(owned instanceof HTMLElement)) throw new Error("Missing owned item");
    const nested = document.createElement("div");
    nested.setAttribute("data-controller", "stimeo--menubar");
    const child = document.createElement("span");
    nested.append(child);
    owned.append(nested);
    const reports = vi.fn();
    element("api-root").addEventListener("stimeo--menubar:close", reports);
    instance().activate(child);
    expect(element("api-panel-b").hidden).toBe(false);
    expect(reports).not.toHaveBeenCalled();
    instance().activate(owned);
    expect(element("api-panel-b").hidden).toBe(true);
    expect(reports).toHaveBeenCalledOnce();
  });
});

/**
 * The item an action resolves is the one the action is bound to (the event's
 * `currentTarget`), whatever the event's target has become since. A handler that moves
 * the target out of a refused item before `activate` runs leaves the item itself to
 * judge, so the item is still refused.
 */
describe("MenubarController when the target leaves the resolved item", () => {
  let application: Application;

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const mountBar = async (openState: string): Promise<MenubarController> => {
    document.body.innerHTML = `
      <div id="bar" data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        ${top("file", "File", "m-file")}
        <ul id="m-file" role="menu" aria-label="File" hidden data-stimeo--menubar-target="menu">
          <li role="none"><button id="new" role="menuitem" tabindex="-1"
                data-stimeo--menubar-target="item">New</button></li>
          <li role="none"><button id="open" role="menuitem" tabindex="-1" ${openState}
                data-stimeo--menubar-target="item"><span id="label">Open</span></button></li>
        </ul>
      </div>`;
    application = Application.start();
    application.register("stimeo--menubar", MenubarController);
    await tick();
    byId("file").click();
    await tick();
    return application.getControllerForElementAndIdentifier(
      byId("bar"),
      "stimeo--menubar",
    ) as MenubarController;
  };

  it.each([
    ["aria-disabled", 'aria-disabled="true"', []],
    ["hidden", "hidden", []],
    ["disabled", "disabled", []],
    ["enabled", "", ["close"]],
  ] as const)(
    "judges the %s item when a handler moves the probe target out of it",
    async (_state, openState, reported) => {
      const controller = await mountBar(openState);
      byId("label").addEventListener("probe", () => byId("bar").append(byId("label")));
      byId("open").addEventListener("probe", (event) => controller.activate(event));
      const capture = captureStateEvents("stimeo--menubar");

      byId("label").dispatchEvent(new Event("probe", { bubbles: true }));
      await tick();
      capture.stop();

      expect(capture.names()).toEqual(reported);
    },
  );

  it.each([
    ["aria-disabled", 'aria-disabled="true"', []],
    ["enabled", "", ["close"]],
  ] as const)(
    "judges the %s item whose click target a document capture handler moves into another",
    async (_state, openState, reported) => {
      const controller = await mountBar(openState);
      // Runs before the controller's own capture pass, so the click is recorded for New.
      const move = () => byId("new").append(byId("label"));
      document.addEventListener("click", move, { capture: true });
      byId("open").addEventListener("click", (event) => controller.activate(event));
      const capture = captureStateEvents("stimeo--menubar");

      byId("label").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      document.removeEventListener("click", move, { capture: true });
      await tick();
      capture.stop();

      expect(capture.names()).toEqual(reported);
    },
  );
});

/**
 * A top whose event target a handler takes out of it before `toggle` runs is judged
 * itself: an element target moved elsewhere, or a text target the handler replaces.
 */
describe("MenubarController when the target leaves the resolved top", () => {
  let application: Application;

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const mountTop = async (fileState: string): Promise<MenubarController> => {
    document.body.innerHTML = `
      <div id="bar" data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        <button id="file" role="menuitem" ${fileState} aria-haspopup="menu" aria-expanded="false"
                aria-controls="m-file"
                data-stimeo--menubar-target="top"><span id="label">File</span></button>
        <ul id="m-file" role="menu" aria-label="File" hidden data-stimeo--menubar-target="menu">
          <li role="none"><button id="new" role="menuitem" tabindex="-1"
                data-stimeo--menubar-target="item">New</button></li>
        </ul>
      </div>`;
    application = Application.start();
    application.register("stimeo--menubar", MenubarController);
    await tick();
    return application.getControllerForElementAndIdentifier(
      byId("bar"),
      "stimeo--menubar",
    ) as MenubarController;
  };

  it.each([
    ["aria-disabled", 'aria-disabled="true"', []],
    ["hidden", "hidden", []],
    ["disabled", "disabled", []],
    ["enabled", "", ["open"]],
  ] as const)(
    "judges the %s top when a handler moves the probe target out of it",
    async (_state, fileState, reported) => {
      const controller = await mountTop(fileState);
      byId("label").addEventListener("probe", () => byId("bar").append(byId("label")));
      byId("file").addEventListener("probe", (event) => controller.toggle(event));
      const capture = captureStateEvents("stimeo--menubar");

      byId("label").dispatchEvent(new Event("probe", { bubbles: true }));
      await tick();
      capture.stop();

      expect(capture.names()).toEqual(reported);
    },
  );

  it.each([
    ["aria-disabled", 'aria-disabled="true"', []],
    ["hidden", "hidden", []],
    ["disabled", "disabled", []],
    ["enabled", "", ["open"]],
  ] as const)(
    "judges the %s top when a handler replaces the text node the probe started on",
    async (_state, fileState, reported) => {
      const controller = await mountTop(fileState);
      const text = byId("label").firstChild as Text;
      text.addEventListener("probe", () => {
        byId("label").textContent = "Saving";
      });
      byId("file").addEventListener("probe", (event) => controller.toggle(event));
      const capture = captureStateEvents("stimeo--menubar");

      text.dispatchEvent(new Event("probe", { bubbles: true }));
      await tick();
      capture.stop();

      expect(capture.names()).toEqual(reported);
    },
  );
});

/**
 * A click on a nested pair is judged for both items when it starts, so a handler that
 * marks either one `aria-disabled` during the click does not undo the close that click
 * started, whichever item the action is bound to.
 */
describe("MenubarController with a nested pair marked during a click", () => {
  let application: Application;

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it.each([
    ["no item", "inner", "none"],
    ["the inner item", "inner", "inner"],
    ["the inner item", "outer", "inner"],
    ["the outer item", "inner", "outer"],
    ["the outer item", "outer", "outer"],
  ] as const)(
    "closes when a handler marks %s aria-disabled, with the action on the %s item",
    async (_marked, receiver, marked) => {
      document.body.innerHTML = `
        <div id="bar" data-controller="stimeo--menubar" role="menubar" aria-label="Main">
          ${top("file", "File", "m-file")}
          <div id="m-file" role="menu" aria-label="File" hidden data-stimeo--menubar-target="menu">
            <div id="outer" role="menuitem" tabindex="-1" data-stimeo--menubar-target="item">
              <button id="inner" role="menuitem" tabindex="-1"
                      data-stimeo--menubar-target="item"><span id="label">Run</span></button>
            </div>
          </div>
        </div>`;
      application = Application.start();
      application.register("stimeo--menubar", MenubarController);
      await tick();
      const controller = application.getControllerForElementAndIdentifier(
        byId("bar"),
        "stimeo--menubar",
      ) as MenubarController;
      byId("file").click();
      await tick();
      byId("label").addEventListener("click", () => {
        if (marked !== "none") byId(marked).setAttribute("aria-disabled", "true");
      });
      byId(receiver).addEventListener("click", (event) => controller.activate(event));
      const capture = captureStateEvents("stimeo--menubar");

      byId("label").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await tick();
      capture.stop();

      expect(capture.names()).toEqual(["close"]);
    },
  );
});
