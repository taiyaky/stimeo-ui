import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DialogController } from "../src/controllers/dialog_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link DialogController}: the APG modal contract — focus
 * moves into the dialog, scroll locks, Escape closes and restores focus.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("DialogController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <p id="background">Background content</p>
      <div data-controller="stimeo--dialog">
        <button id="trigger" data-stimeo--dialog-target="trigger"
                data-action="stimeo--dialog#open">Open</button>
        <div data-stimeo--dialog-target="dialog" role="dialog" aria-modal="true"
             aria-labelledby="title"
             data-action="click->stimeo--dialog#closeOnBackdrop" hidden>
          <h2 id="title">Confirm</h2>
          <button id="ok">OK</button>
          <button id="cancel" data-action="stimeo--dialog#close">Cancel</button>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--dialog", DialogController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  const trigger = () => document.getElementById("trigger") as HTMLButtonElement;
  const dialog = () =>
    document.querySelector<HTMLElement>("[data-stimeo--dialog-target='dialog']") as HTMLElement;

  it("starts hidden", () => {
    expect(dialog().hidden).toBe(true);
  });

  it("opens, moves focus inside, and locks body scroll", () => {
    trigger().focus();
    trigger().click();
    expect(dialog().hidden).toBe(false);
    expect(document.getElementById("ok")).toBe(document.activeElement);
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("closes on Escape, restores focus and scroll", () => {
    trigger().focus();
    trigger().click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(dialog().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
    expect(document.body.style.overflow).toBe("");
  });

  it("closes when a close button is activated", () => {
    trigger().click();
    document.getElementById("cancel")?.click();
    expect(dialog().hidden).toBe(true);
  });

  it("closes when the backdrop itself is clicked", () => {
    trigger().click();
    dialog().click();
    expect(dialog().hidden).toBe(true);
  });

  it("traps Tab focus from the last focusable back to the first", () => {
    trigger().click();
    const cancel = document.getElementById("cancel") as HTMLButtonElement;
    cancel.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(document.getElementById("ok"));
  });

  it("marks background siblings inert while open and restores them on close", () => {
    const background = document.getElementById("background") as HTMLElement;
    expect(background.inert).toBe(false);
    trigger().click();
    expect(background.inert).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(background.inert).toBe(false);
  });

  it("restores scroll and background when disconnected while open", () => {
    const background = document.getElementById("background") as HTMLElement;
    const root = document.querySelector("[data-controller='stimeo--dialog']") as HTMLElement;
    trigger().click();
    expect(document.body.style.overflow).toBe("hidden");
    expect(background.inert).toBe(true);
    const controller = application.getControllerForElementAndIdentifier(root, "stimeo--dialog");
    if (!controller) throw new Error("dialog controller not found");
    controller.disconnect();
    expect(document.body.style.overflow).toBe("");
    expect(background.inert).toBe(false);
  });

  // Layer ① — machine-detectable a11y (asserted in the open/modal state, the
  // interesting accessibility tree for this widget).
  it("has no machine-detectable a11y violations while open (modal)", async () => {
    trigger().click();
    expect(dialog().hidden).toBe(false);
    await expectNoA11yViolations(document.body);
  });

  // Layer ③ — speech-order regression. Captured before AND after the open state
  // change: the modal dialog and its contents only enter the accessibility tree
  // once it is shown, so the whole ordered phrase array pins role/name/state.
  it("does not announce the dialog while closed", async () => {
    const root = document.querySelector("[data-controller='stimeo--dialog']") as HTMLElement;
    const phrases = await captureSpeech({ container: root, steps: 1 });
    expect(phrases).toEqual(["button, Open", "button, Open"]);
  });

  it("announces the dialog role, name, modal state, and contents in order when open", async () => {
    trigger().click();
    const phrases = await captureSpeech({ container: dialog(), steps: 3 });
    expect(phrases).toEqual([
      "dialog, Confirm, modal",
      "dialog, Confirm, modal",
      "heading, Confirm, level 2",
      "button, OK",
      "button, Cancel",
    ]);
  });

  // Teardown regression: disconnect() must drop the document-level keydown
  // listener and revert the modal side effects (scroll lock, background inert)
  // even though it leaves the markup as-is. A surviving listener would still act
  // on the detached controller, so Escape closing the dialog would surface the
  // leak. Invoked directly to avoid happy-dom's flaky async MutationObserver
  // lifecycle (see scrollspy/resizable suites).
  it("releases the global keydown listener and modal side effects on disconnect", () => {
    const background = document.getElementById("background") as HTMLElement;
    const root = document.querySelector("[data-controller='stimeo--dialog']") as HTMLElement;
    trigger().click();
    expect(dialog().hidden).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");
    expect(background.inert).toBe(true);

    const controller = application.getControllerForElementAndIdentifier(root, "stimeo--dialog");
    if (!controller) throw new Error("dialog controller not found");
    controller.disconnect();

    expect(document.body.style.overflow).toBe("");
    expect(background.inert).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(dialog().hidden).toBe(false);
  });
});
