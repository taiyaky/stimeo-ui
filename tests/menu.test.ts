import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MenuController } from "../src/controllers/menu_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link MenuController}: the APG Menu Button contract —
 * `aria-expanded`, roving focus across `role="menuitem"`, Escape/outside-click.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MenuController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--menu">
        <button data-stimeo--menu-target="trigger"
                data-action="click->stimeo--menu#toggle keydown->stimeo--menu#onTriggerKeydown"
                aria-haspopup="menu" aria-expanded="false" aria-controls="menu">Actions</button>
        <ul id="menu" role="menu" data-stimeo--menu-target="menu" hidden>
          <li role="none"><button role="menuitem" tabindex="-1"
              data-stimeo--menu-target="item"
              data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">Edit</button></li>
          <li role="none"><button role="menuitem" tabindex="-1"
              data-stimeo--menu-target="item"
              data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">Duplicate</button></li>
          <li role="none"><button role="menuitem" tabindex="-1"
              data-stimeo--menu-target="item"
              data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">Delete</button></li>
        </ul>
      </div>
      <a href="#" id="outside">outside</a>`;
    application = Application.start();
    application.register("stimeo--menu", MenuController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const trigger = () =>
    document.querySelector<HTMLButtonElement>(
      "[data-stimeo--menu-target='trigger']",
    ) as HTMLButtonElement;
  const menu = () => document.getElementById("menu") as HTMLElement;
  const items = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("[data-stimeo--menu-target='item']"));
  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--menu']") as HTMLElement;

  it("starts closed", () => {
    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens and focuses the first item on click", () => {
    trigger().click();
    expect(menu().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(items()[0]);
  });

  it("opens and focuses the last item on ArrowUp", () => {
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(menu().hidden).toBe(false);
    expect(document.activeElement).toBe(items()[2]);
  });

  it("opens and focuses the first item on ArrowDown", () => {
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(menu().hidden).toBe(false);
    expect(document.activeElement).toBe(items()[0]);
  });

  it("does not handle Enter/Space on the trigger (left to the native button click)", () => {
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    // keydown alone does not open; the browser's synthesized click would.
    expect(menu().hidden).toBe(true);
  });

  it("moves focus between items with ArrowDown (wrapping)", () => {
    trigger().click();
    items()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(items()[1]);
    items()[2]?.focus();
    items()[2]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(items()[0]);
  });

  it("closes on Escape and returns focus to the trigger", () => {
    trigger().click();
    items()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on Tab without forcing focus back to the trigger", () => {
    trigger().click();
    items()[0]?.focus();
    items()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(menu().hidden).toBe(true);
    // Tab lets focus move on naturally; it is not pulled back to the trigger.
    expect(document.activeElement).not.toBe(trigger());
  });

  it("closes when an item is activated", () => {
    trigger().click();
    items()[1]?.click();
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on an outside click", () => {
    trigger().click();
    document.getElementById("outside")?.click();
    expect(menu().hidden).toBe(true);
  });

  // --- Layer ① machine a11y ---

  it("has no machine-detectable a11y violations while closed", async () => {
    await expectNoA11yViolations(root());
  });

  it("has no machine-detectable a11y violations while open", async () => {
    trigger().click();
    expect(menu().hidden).toBe(false);
    await expectNoA11yViolations(root());
  });

  // --- Layer ③ speech-order regression ---

  it("announces role, name, and state in roving order when open", async () => {
    trigger().click();
    const phrases = await captureSpeech({ container: menu(), steps: 4 });
    expect(phrases).toEqual([
      "menu, orientated vertically",
      "menuitem, Edit, position 1, set size 3",
      "menuitem, Duplicate, position 2, set size 3",
      "menuitem, Delete, position 3, set size 3",
      "end of menu, orientated vertically",
    ]);
  });

  // --- Disconnect teardown regression ---

  it("properly disconnect without errors even when menu is open", async () => {
    trigger().click();
    expect(menu().hidden).toBe(false);

    const root = document.querySelector("[data-controller='stimeo--menu']") as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(root, "stimeo--menu");
    if (!controller) throw new Error("menu controller not found");

    controller.disconnect();

    // After disconnect, outside click should not toggle menu (listener removed)
    document.body.click();
    expect(menu().hidden).toBe(false);
  });

  const itemKey = (index: number, key: string) =>
    items()[index]?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

  it("moves focus up between items with ArrowUp (wrapping to the last)", () => {
    trigger().click(); // open, focus item 0
    itemKey(0, "ArrowUp");
    expect(document.activeElement).toBe(items()[2]); // wrapped
  });

  it("jumps to the first item on Home and the last on End", () => {
    trigger().click();
    itemKey(0, "End");
    expect(document.activeElement).toBe(items()[2]);
    itemKey(2, "Home");
    expect(document.activeElement).toBe(items()[0]);
  });

  it("ignores other keys on an item (no focus move)", () => {
    trigger().click();
    itemKey(0, "a");
    expect(document.activeElement).toBe(items()[0]);
  });

  it("closes when the trigger is clicked a second time", () => {
    trigger().click();
    expect(menu().hidden).toBe(false);
    trigger().click(); // toggle → close
    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("MenuController disabled items", () => {
  let application: Application;

  beforeEach(async () => {
    // "Duplicate" is aria-disabled, "Delete" is natively disabled — both must be
    // skipped by roving focus.
    document.body.innerHTML = `
      <div data-controller="stimeo--menu">
        <button data-stimeo--menu-target="trigger"
                data-action="click->stimeo--menu#toggle keydown->stimeo--menu#onTriggerKeydown"
                aria-haspopup="menu" aria-expanded="false" aria-controls="menu">Actions</button>
        <ul id="menu" role="menu" data-stimeo--menu-target="menu" hidden>
          <li role="none"><button role="menuitem" tabindex="-1"
              data-stimeo--menu-target="item"
              data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">Edit</button></li>
          <li role="none"><button role="menuitem" tabindex="-1" aria-disabled="true"
              data-stimeo--menu-target="item"
              data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">Duplicate</button></li>
          <li role="none"><button role="menuitem" tabindex="-1" disabled
              data-stimeo--menu-target="item"
              data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">Delete</button></li>
          <li role="none"><button role="menuitem" tabindex="-1"
              data-stimeo--menu-target="item"
              data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">Rename</button></li>
        </ul>
      </div>`;
    application = Application.start();
    application.register("stimeo--menu", MenuController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const trigger = () =>
    document.querySelector<HTMLButtonElement>(
      "[data-stimeo--menu-target='trigger']",
    ) as HTMLButtonElement;
  const items = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("[data-stimeo--menu-target='item']"));
  const itemKey = (index: number, key: string) =>
    items()[index]?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

  it("focuses the first navigable item on open (skips none here — Edit is enabled)", () => {
    trigger().click();
    expect(document.activeElement).toBe(items()[0]); // Edit
  });

  it("skips disabled items when moving down with ArrowDown", () => {
    trigger().click(); // open, focus Edit (index 0)
    itemKey(0, "ArrowDown"); // skip Duplicate (aria-disabled) + Delete (disabled) → Rename
    expect(document.activeElement).toBe(items()[3]); // Rename
  });

  it("skips disabled items when wrapping with ArrowUp", () => {
    trigger().click(); // open, focus Edit (index 0)
    itemKey(0, "ArrowUp"); // wrap past the two disabled items to the last navigable → Rename
    expect(document.activeElement).toBe(items()[3]); // Rename
  });

  it("focuses the last navigable item on ArrowUp from the trigger", () => {
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(items()[3]); // Rename, not the disabled Delete
  });

  it("End jumps to the last navigable item, Home to the first", () => {
    trigger().click();
    itemKey(0, "End");
    expect(document.activeElement).toBe(items()[3]); // Rename
    itemKey(3, "Home");
    expect(document.activeElement).toBe(items()[0]); // Edit
  });
});
