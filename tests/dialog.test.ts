import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DialogController } from "../src/controllers/dialog_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { typeKey } from "./helpers/keyboard";
import { expectUpperModalOnTop, openUpperModal, TARGET_SWAPS } from "./helpers/modal_stack";
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

  /** What a Turbo morph does: put the server's markup back and dispatch `turbo:morph-element`. */
  const morph = async (element: Element, attributes: Record<string, string | null>) => {
    for (const [name, value] of Object.entries(attributes)) {
      if (value === null) element.removeAttribute(name);
      else element.setAttribute(name, value);
    }
    element.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();
  };

  it("keeps an open dialog open through a morph that puts the server's hidden back", async () => {
    trigger().click();
    await morph(dialog(), { hidden: "" });
    expect(dialog().hidden).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dialog().hidden).toBe(true);
  });

  it("keeps a closed dialog closed through a morph that drops its hidden", async () => {
    await morph(dialog(), { hidden: null });
    expect(dialog().hidden).toBe(true);
  });

  it("writes nothing after a morph once disconnected", async () => {
    application.unload("stimeo--dialog");
    await morph(dialog(), { hidden: null });
    expect(dialog().hidden).toBe(false);
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

  it("takes a Tab that does not wrap and moves to the next focusable itself", () => {
    trigger().click();
    const ok = document.getElementById("ok") as HTMLButtonElement;
    ok.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    ok.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.getElementById("cancel"));
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

  // --- Without a trigger ---

  describe("without a trigger target", () => {
    beforeEach(async () => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = `
        <div data-controller="stimeo--dialog">
          <div data-stimeo--dialog-target="dialog" role="dialog" aria-modal="true"
               aria-label="Notice" hidden>
            <button id="close" data-action="stimeo--dialog#close">Close</button>
          </div>
        </div>`;
      application = Application.start();
      application.register("stimeo--dialog", DialogController);
      await tick();
    });

    const controller = () => {
      const root = document.querySelector("[data-controller='stimeo--dialog']") as HTMLElement;
      const instance = application.getControllerForElementAndIdentifier(root, "stimeo--dialog");
      if (!(instance instanceof DialogController)) throw new Error("dialog controller not found");
      return instance;
    };

    it("closes without a trigger when nothing was focused before opening", () => {
      (document.activeElement as HTMLElement | null)?.blur();
      expect(document.activeElement).toBe(document.body);
      controller().open();
      expect(document.activeElement).toBe(document.getElementById("close"));

      expect(() => controller().close()).not.toThrow();
      expect(dialog().hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
    });
  });

  // --- Without a dialog target ---

  describe("without a dialog target", () => {
    it("connects and opens nothing", async () => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = `
        <p id="background">Background content</p>
        <div data-controller="stimeo--dialog">
          <button id="trigger" data-stimeo--dialog-target="trigger">Open</button>
        </div>`;
      application = Application.start();
      const errors: unknown[] = [];
      application.handleError = (error) => {
        errors.push(error);
      };
      application.register("stimeo--dialog", DialogController);
      await tick();
      const root = document.querySelector("[data-controller='stimeo--dialog']") as HTMLElement;
      const controller = application.getControllerForElementAndIdentifier(root, "stimeo--dialog");
      if (!(controller instanceof DialogController)) throw new Error("dialog controller not found");

      controller.open();

      expect(errors).toEqual([]);
      expect(document.body.style.overflow).toBe("");
      expect(document.getElementById("background")?.inert).toBe(false);
    });
  });

  // --- A dialog that replaces the current one ---

  describe("a dialog that replaces the current one", () => {
    const targetAttribute = "data-stimeo--dialog-target";
    const root = () => document.querySelector("[data-controller='stimeo--dialog']") as HTMLElement;
    const controller = () => {
      const instance = application.getControllerForElementAndIdentifier(root(), "stimeo--dialog");
      if (!(instance instanceof DialogController)) throw new Error("dialog controller not found");
      return instance;
    };
    /** A server-rendered copy of the dialog, closed as the markup contract authors it. */
    const dialogCopy = (): HTMLElement => {
      const copy = dialog().cloneNode(true) as HTMLElement;
      for (const element of [copy, ...Array.from(copy.querySelectorAll<HTMLElement>("[id]"))]) {
        if (element.id) element.id = `copy-${element.id}`;
      }
      copy.hidden = true;
      return copy;
    };
    const firstButtonIn = (container: HTMLElement) => container.querySelector("button");
    const background = () => document.getElementById("background") as HTMLElement;
    /** Collects the writes to `attributes` on `element` that `act` causes. */
    const attributeWrites = async (element: Element, attributes: string[], act: () => void) => {
      const records: MutationRecord[] = [];
      const observer = new MutationObserver((batch) => records.push(...batch));
      observer.observe(element, { attributes: true, attributeFilter: attributes });
      act();
      await tick();
      records.push(...observer.takeRecords());
      observer.disconnect();
      return records;
    };

    it("keeps the dialog open on a replacement delivered in one task", async () => {
      trigger().focus();
      controller().open();
      const successor = dialogCopy();
      dialog().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(false);
      expect(document.activeElement).toBe(firstButtonIn(successor));
      expect(document.body.style.overflow).toBe("hidden");
      expect(background().inert).toBe(true);
    });

    it("keeps the dialog open on the dialog that stays after an earlier one leaves", async () => {
      trigger().focus();
      controller().open();
      const original = dialog();
      const successor = dialogCopy();
      original.after(successor);
      await tick();
      original.remove();
      await tick();

      expect(successor.hidden).toBe(false);
      expect(document.activeElement).toBe(firstButtonIn(successor));
      expect(document.body.style.overflow).toBe("hidden");
      expect(background().inert).toBe(true);
    });

    it("still closes and returns focus to the opener after the swap", async () => {
      trigger().focus();
      controller().open();
      const original = dialog();
      const successor = dialogCopy();
      original.after(successor);
      await tick();
      original.remove();
      await tick();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      expect(successor.hidden).toBe(true);
      expect(document.activeElement).toBe(trigger());
      expect(background().inert).toBe(false);
      expect(document.body.style.overflow).toBe("");
    });

    it.each(TARGET_SWAPS)(
      "keeps a modal opened over it on top when its dialog is replaced %s",
      async (_, swap) => {
        trigger().focus();
        controller().open();
        document.getElementById("cancel")?.focus();
        const upper = openUpperModal();
        const successor = dialogCopy();
        await swap(dialog(), successor);

        expectUpperModalOnTop(upper, successor);
        expect(successor.hidden).toBe(false);
        typeKey(document, "Escape");
        expect(successor.hidden).toBe(true);
        expect(document.activeElement).toBe(trigger());
      },
    );

    it("closes a dialog that replaces the current one while closed", async () => {
      const successor = dialogCopy();
      successor.hidden = false;
      dialog().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
    });

    it("releases the modal side effects when the only dialog leaves while open", async () => {
      trigger().focus();
      controller().open();
      dialog().remove();
      await tick();

      expect(document.body.style.overflow).toBe("");
      expect(background().inert).toBe(false);
      expect(document.activeElement).toBe(trigger());
    });

    it("closes a dialog that arrives after the only one left", async () => {
      controller().open();
      const arrival = dialogCopy();
      arrival.hidden = false;
      dialog().remove();
      await tick();
      root().append(arrival);
      await tick();

      expect(arrival.hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
    });

    it("leaves focus where it is when a dialog arrives behind the current one", async () => {
      controller().open();
      const cancel = document.getElementById("cancel") as HTMLElement;
      cancel.focus();
      dialog().after(dialogCopy());
      await tick();

      expect(document.activeElement).toBe(cancel);
      expect(dialog().hidden).toBe(false);
    });

    it("leaves focus on the page when a dialog arrives behind the current one", async () => {
      controller().open();
      (document.activeElement as HTMLElement).blur();
      dialog().after(dialogCopy());
      await tick();

      expect(document.activeElement).toBe(document.body);
      expect(dialog().hidden).toBe(false);
    });

    it("reports nothing while it moves the open state or closes for a dialog that left", async () => {
      const capture = captureStateEvents("stimeo--dialog");
      controller().open();
      capture.clear();
      dialog().replaceWith(dialogCopy());
      await tick();
      const original = dialog();
      original.after(dialogCopy());
      await tick();
      original.remove();
      await tick();
      dialog().remove();
      await tick();

      expect(capture.seen).toEqual([]);
      capture.stop();
    });

    it("moves nothing once it has disconnected", async () => {
      controller().open();
      const original = dialog();
      const successor = dialogCopy();
      original.after(successor);
      await tick();
      controller().disconnect();
      // A write from here on would hide the successor the page just showed.
      successor.hidden = false;
      original.remove();
      await tick();

      expect(successor.hidden).toBe(false);
      expect(document.body.style.overflow).toBe("");
    });

    it("gives a dialog left in the page without its target token its own hidden back", async () => {
      controller().open();
      const original = dialog();
      const successor = dialogCopy();
      original.after(successor);
      await tick();
      original.removeAttribute(targetAttribute);
      await tick();

      expect(original.hidden).toBe(true);
      expect(successor.hidden).toBe(false);
      expect(document.body.style.overflow).toBe("hidden");
    });

    it("closes when the only dialog loses its target token", async () => {
      trigger().focus();
      controller().open();
      const only = dialog();
      only.removeAttribute(targetAttribute);
      await tick();

      expect(only.hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
      expect(document.activeElement).toBe(trigger());
    });

    it("gives the dialog back its own hidden when the widget loses its controller", async () => {
      trigger().focus();
      controller().open();
      const departed = dialog();
      root().removeAttribute("data-controller");
      await tick();

      expect(departed.hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
      expect(background().inert).toBe(false);
    });

    it("gives an authored-visible dialog its visibility back when the controller goes", async () => {
      const fresh = dialogCopy();
      fresh.hidden = false;
      dialog().replaceWith(fresh);
      await tick();
      expect(fresh.hidden).toBe(true);

      root().removeAttribute("data-controller");
      await tick();

      expect(fresh.hidden).toBe(false);
    });

    it("keeps a hidden value the page wrote after the controller did", async () => {
      controller().open();
      const departed = dialog();
      departed.setAttribute("hidden", "until-found");
      root().removeAttribute("data-controller");
      await tick();

      expect(departed.getAttribute("hidden")).toBe("until-found");
    });

    it("keeps the open state on a dialog that moves within the element", async () => {
      controller().open();
      const moving = dialog();

      const writes = await attributeWrites(moving, ["hidden"], () => root().append(moving));

      expect(moving.hidden).toBe(false);
      expect(writes).toEqual([]);
      expect(document.body.style.overflow).toBe("hidden");
    });
  });
});
