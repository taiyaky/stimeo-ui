import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DropdownController } from "../src/controllers/dropdown_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link DropdownController}, run in happy-dom (browserless).
 * They assert the disclosure contract: ARIA state, open/close toggling, and the
 * keyboard/outside-click affordances — not any visual styling.
 */

/** Flushes the microtask/timer queue so Stimulus can connect controllers. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("DropdownController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--dropdown">
        <button data-stimeo--dropdown-target="trigger"
                aria-controls="dd-menu" aria-expanded="false"
                data-action="stimeo--dropdown#toggle">Menu</button>
        <div id="dd-menu" data-stimeo--dropdown-target="menu"><a href="#">Item</a></div>
      </div>
      <a href="#" id="outside">outside</a>`;
    application = Application.start();
    application.register("stimeo--dropdown", DropdownController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  /** Resolves a required element or throws, keeping the assertions strictly typed. */
  const requireElement = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`Element not found: ${selector}`);
    return element;
  };

  const trigger = () =>
    requireElement<HTMLButtonElement>("[data-stimeo--dropdown-target='trigger']");
  const menu = () => requireElement<HTMLElement>("[data-stimeo--dropdown-target='menu']");
  const root = () => requireElement<HTMLElement>("[data-controller='stimeo--dropdown']");

  it("starts closed with aria-expanded=false", () => {
    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens when the trigger is clicked", () => {
    trigger().click();
    expect(menu().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("toggles closed on a second click", () => {
    trigger().click();
    trigger().click();
    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on an outside click", () => {
    trigger().click();
    document.getElementById("outside")?.click();
    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape", () => {
    trigger().click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
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

  it("announces trigger and disclosed content in order when open", async () => {
    trigger().click();
    const phrases = await captureSpeech({ container: root(), steps: 1 });
    expect(phrases).toEqual(["button, Menu, 1 control, expanded", "link, Item"]);
  });

  // --- Disconnect teardown regression ---

  it("properly disconnect without errors even when menu is open", async () => {
    trigger().click();
    expect(menu().hidden).toBe(false);

    const root = document.querySelector("[data-controller='stimeo--dropdown']") as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(root, "stimeo--dropdown");
    if (!controller) throw new Error("dropdown controller not found");

    controller.disconnect();

    // After disconnect, outside click should not close menu (listener removed)
    document.body.click();
    expect(menu().hidden).toBe(false);

    // After disconnect, Escape should not close menu (listener removed)
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu().hidden).toBe(false);
  });
});
