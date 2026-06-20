import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlertDialogController } from "../src/controllers/alert_dialog_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link AlertDialogController}: the APG alert-dialog
 * contract — initial focus on the least-destructive action, focus trap, no
 * backdrop close, and confirm/cancel events (cancel tagged user vs. escape).
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AlertDialogController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <p id="background">Background content</p>
      <div data-controller="stimeo--alert-dialog">
        <button id="trigger" data-stimeo--alert-dialog-target="trigger"
                data-action="stimeo--alert-dialog#open">Delete…</button>
        <div data-stimeo--alert-dialog-target="dialog" role="alertdialog"
             aria-modal="true" aria-labelledby="ad-title" aria-describedby="ad-desc"
             hidden>
          <h2 id="ad-title">Delete this item?</h2>
          <p id="ad-desc">This cannot be undone.</p>
          <button id="cancel" data-stimeo--alert-dialog-target="initialFocus"
                  data-action="stimeo--alert-dialog#cancel">Cancel</button>
          <button id="confirm" data-action="stimeo--alert-dialog#confirm">Delete</button>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--alert-dialog", AlertDialogController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  const trigger = () => document.getElementById("trigger") as HTMLButtonElement;
  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--alert-dialog']") as HTMLElement;
  const dialog = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--alert-dialog-target='dialog']",
    ) as HTMLElement;

  it("starts hidden", () => {
    expect(dialog().hidden).toBe(true);
  });

  it("opens, focuses the initialFocus target, and locks body scroll", () => {
    trigger().focus();
    trigger().click();
    expect(dialog().hidden).toBe(false);
    expect(document.activeElement).toBe(document.getElementById("cancel"));
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("does NOT close when its own element (backdrop area) is clicked", () => {
    trigger().click();
    dialog().click();
    expect(dialog().hidden).toBe(false); // alert dialogs never dismiss on backdrop
  });

  it("confirm closes and dispatches the confirm event", () => {
    const events: Event[] = [];
    root().addEventListener("stimeo--alert-dialog:confirm", (e) => events.push(e));
    trigger().focus();
    trigger().click();
    document.getElementById("confirm")?.click();
    expect(events).toHaveLength(1);
    expect(dialog().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("cancel closes and dispatches cancel with reason 'user'", () => {
    const reasons: string[] = [];
    root().addEventListener("stimeo--alert-dialog:cancel", (e) => {
      reasons.push((e as CustomEvent).detail.reason);
    });
    trigger().focus();
    trigger().click();
    document.getElementById("cancel")?.click();
    expect(reasons).toEqual(["user"]);
    expect(dialog().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("Escape closes and dispatches cancel with reason 'escape'", () => {
    const reasons: string[] = [];
    root().addEventListener("stimeo--alert-dialog:cancel", (e) => {
      reasons.push((e as CustomEvent).detail.reason);
    });
    trigger().focus();
    trigger().click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(reasons).toEqual(["escape"]);
    expect(dialog().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("traps Tab focus from the last focusable back to the first", () => {
    trigger().click();
    document.getElementById("confirm")?.focus(); // last
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(document.getElementById("cancel")); // first
  });

  it("marks background siblings inert while open and restores them on close", () => {
    const background = document.getElementById("background") as HTMLElement;
    trigger().click();
    expect(background.inert).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(background.inert).toBe(false);
  });

  it("restores scroll and background when disconnected while open", () => {
    const background = document.getElementById("background") as HTMLElement;
    const root = document.querySelector("[data-controller='stimeo--alert-dialog']") as HTMLElement;
    trigger().click();
    expect(document.body.style.overflow).toBe("hidden");
    const controller = application.getControllerForElementAndIdentifier(
      root,
      "stimeo--alert-dialog",
    );
    controller?.disconnect();
    expect(document.body.style.overflow).toBe("");
    expect(background.inert).toBe(false);
  });

  // Layer ① — machine-detectable a11y (asserted in the open/modal state).
  it("has no machine-detectable a11y violations while open (modal)", async () => {
    trigger().click();
    await expectNoA11yViolations(document.body);
  });

  // Layer ③ — speech-order regression: role, name, modal state, and the
  // describing message must enter the accessibility tree in order when open.
  it("announces the alertdialog role, name, and message in order when open", async () => {
    trigger().click();
    const phrases = await captureSpeech({ container: dialog(), steps: 4 });
    expect(phrases).toEqual([
      "alertdialog, Delete this item?, This cannot be undone., modal",
      "alertdialog, Delete this item?, This cannot be undone., modal",
      "heading, Delete this item?, level 2",
      "paragraph",
      "This cannot be undone.",
      "end of paragraph",
    ]);
  });

  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--alert-dialog",
    ) as AlertDialogController;

  it("re-opening an already-open dialog is a no-op", () => {
    trigger().click();
    expect(dialog().hidden).toBe(false);
    // Second open() must short-circuit on the isOpen guard (no throw, stays open).
    controller().open();
    expect(dialog().hidden).toBe(false);
  });

  it("confirm and cancel are inert while the dialog is closed", () => {
    const events: string[] = [];
    root().addEventListener("stimeo--alert-dialog:confirm", () => events.push("confirm"));
    root().addEventListener("stimeo--alert-dialog:cancel", () => events.push("cancel"));
    // Never opened → both guard on isOpen and dispatch nothing.
    controller().confirm();
    controller().cancel();
    expect(events).toEqual([]);
  });
});
