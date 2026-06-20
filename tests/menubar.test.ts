import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MenubarController } from "../src/controllers/menubar_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link MenubarController}: the APG menubar — roving across
 * top items, opening menus with the keyboard, in-menu navigation/typeahead,
 * jumping to adjacent menus, and Escape/Tab/outside-click/activation closing with
 * focus returned to the owning top item.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const item = (id: string, label: string) => `
  <li role="none">
    <button id="${id}" role="menuitem" tabindex="-1" data-stimeo--menubar-target="item"
            data-action="click->stimeo--menubar#activate
                         keydown->stimeo--menubar#onItemKeydown">${label}</button>
  </li>`;

const markup = `
  <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
    <button id="file" role="menuitem" aria-haspopup="menu" aria-expanded="false"
            aria-controls="m-file" data-stimeo--menubar-target="top"
            data-action="click->stimeo--menubar#toggle
                         keydown->stimeo--menubar#onTopKeydown">File</button>
    <ul id="m-file" role="menu" aria-label="File" hidden data-stimeo--menubar-target="menu">
      ${item("new", "New")}${item("open", "Open")}${item("save", "Save")}
    </ul>
    <button id="edit" role="menuitem" aria-haspopup="menu" aria-expanded="false"
            aria-controls="m-edit" data-stimeo--menubar-target="top"
            data-action="click->stimeo--menubar#toggle
                         keydown->stimeo--menubar#onTopKeydown">Edit</button>
    <ul id="m-edit" role="menu" aria-label="Edit" hidden data-stimeo--menubar-target="menu">
      ${item("cut", "Cut")}${item("copy", "Copy")}
    </ul>
  </div>`;

describe("MenubarController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--menubar", MenubarController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const expanded = (id: string) => byId(id).getAttribute("aria-expanded");
  const menuHidden = (id: string) => byId(id).hidden;
  const topKey = (id: string, key: string) =>
    byId(id).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  const itemKey = (id: string, key: string) =>
    byId(id).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

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
    topKey("file", "ArrowDown");
    expect(document.activeElement).toBe(byId("new"));
    byId("file").click(); // close
    topKey("file", "ArrowUp");
    expect(document.activeElement).toBe(byId("save"));
  });

  it("roves between top items with ArrowRight/ArrowLeft when closed", () => {
    topKey("file", "ArrowRight");
    expect(document.activeElement).toBe(byId("edit"));
    expect(byId("edit").tabIndex).toBe(0);
    expect(byId("file").tabIndex).toBe(-1);
    expect(menuHidden("m-edit")).toBe(true); // closed: just moves, does not open
    topKey("edit", "ArrowLeft");
    expect(document.activeElement).toBe(byId("file"));
  });

  it("moves within a menu with arrows (wrapping) and Home/End", () => {
    byId("file").click(); // focus new
    itemKey("new", "ArrowDown");
    expect(document.activeElement).toBe(byId("open"));
    itemKey("open", "ArrowUp");
    expect(document.activeElement).toBe(byId("new"));
    itemKey("new", "ArrowUp"); // wrap to last
    expect(document.activeElement).toBe(byId("save"));
    itemKey("save", "ArrowDown"); // wrap to first
    expect(document.activeElement).toBe(byId("new"));
    itemKey("new", "End");
    expect(document.activeElement).toBe(byId("save"));
    itemKey("save", "Home");
    expect(document.activeElement).toBe(byId("new"));
  });

  it("jumps to the adjacent menu with ArrowRight/ArrowLeft inside a menu", () => {
    byId("file").click(); // open File, focus new
    itemKey("new", "ArrowRight"); // -> open Edit, focus first
    expect(menuHidden("m-file")).toBe(true);
    expect(menuHidden("m-edit")).toBe(false);
    expect(document.activeElement).toBe(byId("cut"));
    itemKey("cut", "ArrowLeft"); // -> wrap back to File
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
    itemKey("new", "Escape");
    expect(menuHidden("m-file")).toBe(true);
    expect(document.activeElement).toBe(byId("file"));
  });

  it("closes on Tab without forcing focus back", () => {
    byId("file").click();
    itemKey("new", "Tab");
    expect(menuHidden("m-file")).toBe(true);
  });

  it("closes on an outside click", () => {
    byId("file").click();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menuHidden("m-file")).toBe(true);
  });

  it("supports typeahead within the open menu", () => {
    byId("file").click(); // focus new
    itemKey("new", "o"); // -> Open
    expect(document.activeElement).toBe(byId("open"));
  });

  it("does not consume Space for typeahead (leaves native button activation)", () => {
    byId("file").click(); // open File, focus New
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    byId("new").dispatchEvent(event);
    // Space must not be preventDefault-ed, so the button's native Enter/Space →
    // click activation still runs.
    expect(event.defaultPrevented).toBe(false);
  });

  it("resets the typeahead buffer after a pause", () => {
    vi.useFakeTimers();
    try {
      byId("file").click();
      itemKey("new", "s"); // Save
      expect(document.activeElement).toBe(byId("save"));
      vi.advanceTimersByTime(600);
      itemKey("save", "o"); // fresh buffer -> Open
      expect(document.activeElement).toBe(byId("open"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the document listener on disconnect", () => {
    byId("file").click();
    const root = document.querySelector("[data-controller='stimeo--menubar']") as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(root, "stimeo--menubar");
    controller?.disconnect();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menuHidden("m-file")).toBe(false); // a surviving listener would have closed it
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
});
