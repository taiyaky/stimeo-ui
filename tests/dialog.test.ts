import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DialogController } from "../src/controllers/dialog_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents } from "./helpers/state_events";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link DialogController}: the APG modal contract — focus
 * moves into the dialog, scroll locks, Escape closes and restores focus.
 */

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
    disconnectAndStopApplication(application);
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

  it("stays open when content inside the dialog is clicked", () => {
    // A click on a descendant bubbles up to the dialog target, but closeOnBackdrop
    // closes only when the event target IS the backdrop element itself — clicking
    // content (here the title) must leave the dialog open (the negative branch).
    // Resolve the title non-optionally: if the fixture ever loses it, `.click()`
    // throws instead of silently no-opping into a false-positive pass.
    trigger().click();
    expect(dialog().hidden).toBe(false);
    const title = document.getElementById("title") as HTMLElement;
    title.click();
    expect(dialog().hidden).toBe(false);
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

  // Machine-detectable a11y, asserted in the open/modal state — the interesting
  // accessibility tree for this widget.
  it("has no machine-detectable a11y violations while open (modal)", async () => {
    trigger().click();
    expect(dialog().hidden).toBe(false);
    await expectNoA11yViolations(document.body);
  });

  // Speech-order regression. Captured before AND after the open state change:
  // the modal dialog and its contents only enter the accessibility tree once it
  // is shown, so the whole ordered phrase array pins role/name/state.
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
  // lifecycle. This single case covers the whole disconnect contract — both the
  // side-effect restoration (scroll/inert) and the listener removal.
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

  // --- State events ---

  describe("state events", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    const controller = () => {
      const root = document.querySelector("[data-controller='stimeo--dialog']") as HTMLElement;
      const instance = application.getControllerForElementAndIdentifier(root, "stimeo--dialog");
      if (!(instance instanceof DialogController)) throw new Error("dialog controller not found");
      return instance;
    };

    beforeEach(() => {
      capture = captureStateEvents("stimeo--dialog");
    });

    afterEach(() => {
      capture.stop();
    });

    it("reports a trigger click as user, after hidden is written and before focus moves", () => {
      const states: string[] = [];
      const root = document.querySelector("[data-controller='stimeo--dialog']") as HTMLElement;
      root.addEventListener("stimeo--dialog:open", () => {
        states.push(`${dialog().hidden} ${document.activeElement?.id}`);
      });

      trigger().focus();
      trigger().click();

      expect(capture.names()).toEqual(["open"]);
      expect(capture.reasons()).toEqual(["user"]);
      expect(states).toEqual(["false trigger"]);
      expect(capture.seen[0]?.bubbles).toBe(true);
      expect(capture.seen[0]?.cancelable).toBe(false);
    });

    it("reports a call with no DOM event as api", () => {
      controller().open();
      controller().close();

      expect(capture.reasons()).toEqual(["api", "api"]);
    });

    it("reports a close button as user and a backdrop click as outside", () => {
      trigger().click();
      capture.clear();
      (document.getElementById("cancel") as HTMLButtonElement).click();

      expect(capture.reasons()).toEqual(["user"]);

      capture.clear();
      controller().open();
      capture.clear();
      dialog().click();

      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["outside"]);
    });

    it("reports Escape as escape", () => {
      trigger().click();
      capture.clear();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      expect(capture.reasons()).toEqual(["escape"]);
    });

    it("stays silent for an idempotent call in either direction", () => {
      controller().close();
      expect(capture.seen).toEqual([]);

      controller().open();
      capture.clear();
      controller().open();

      expect(capture.seen).toEqual([]);
    });

    it("stays silent while connect normalizes an authored-open dialog", async () => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = `
        <div data-controller="stimeo--dialog">
          <div data-stimeo--dialog-target="dialog" role="dialog" aria-label="Confirm"></div>
        </div>`;
      const fresh = captureStateEvents("stimeo--dialog");
      application = Application.start();
      application.register("stimeo--dialog", DialogController);
      await tick();

      expect(dialog().hidden).toBe(true);
      expect(fresh.seen).toEqual([]);
      fresh.stop();
    });

    it("stays silent through a disconnect and a Turbo-style reconnect", async () => {
      trigger().click();
      capture.clear();

      const element = document.querySelector("[data-controller='stimeo--dialog']") as HTMLElement;
      element.remove();
      await tick();
      document.body.append(element);
      await tick();

      expect(dialog().hidden).toBe(true);
      expect(capture.seen).toEqual([]);
    });
  });

  // --- Re-entry from a subscriber ---

  describe("re-entry from a subscriber", () => {
    const root = () => document.querySelector("[data-controller='stimeo--dialog']") as HTMLElement;
    const controller = () => {
      const instance = application.getControllerForElementAndIdentifier(root(), "stimeo--dialog");
      if (!(instance instanceof DialogController)) throw new Error("dialog controller not found");
      return instance;
    };

    it("drops the modal side effects when the open handler closes it again", () => {
      root().addEventListener("stimeo--dialog:open", () => controller().close());

      controller().open();

      // They must not land on a dialog that is hidden again: a later close()
      // returns early, so there would be no way back.
      expect(dialog().hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
      expect(document.getElementById("background")?.hasAttribute("inert")).toBe(false);
    });

    it("keeps the live trap when the close handler reopens it", () => {
      controller().open();
      root().addEventListener("stimeo--dialog:close", () => controller().open());

      controller().close();

      expect(dialog().hidden).toBe(false);
      expect(document.body.style.overflow).toBe("hidden");
    });
  });
});
