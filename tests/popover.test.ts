import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PopoverController } from "../src/controllers/popover_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link PopoverController}: the modeless dialog contract —
 * toggle + ARIA sync, focus-into-panel on open, Escape / outside-click closing
 * (with focus restoration), and Tab-out closing (without restoration).
 */
describe("PopoverController", () => {
  let application: Application;

  const start = async (panelInner = '<input type="text" /><button id="done">Done</button>') => {
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--popover">
          <button id="trigger" data-stimeo--popover-target="trigger"
                  aria-haspopup="dialog" aria-expanded="false" aria-controls="pop"
                  data-action="click->stimeo--popover#toggle">Edit profile</button>
          <div id="pop" data-stimeo--popover-target="panel" role="dialog"
               aria-label="Edit profile" hidden>${panelInner}</div>
        </div>
        <button id="outside">Outside</button>
      </main>`;
    application = Application.start();
    application.register("stimeo--popover", PopoverController);
    await Promise.resolve();
  };

  beforeEach(() => start());

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const trigger = () => query<HTMLButtonElement>("#trigger");
  const panel = () => query("#pop");

  it("starts closed with the collapsed ARIA state", () => {
    expect(panel().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles open on trigger click and focuses the first focusable element", () => {
    trigger().click();
    expect(panel().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(query("#pop input"));
  });

  it("toggles closed on a second trigger click", () => {
    trigger().click();
    trigger().click();
    expect(panel().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("focuses the panel itself when it has no focusable children", async () => {
    application.stop();
    await start("<p>Just text</p>");
    trigger().click();
    expect(panel().getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(panel());
  });

  it("closes on Escape and restores focus to the trigger", () => {
    trigger().click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on an outside click and restores focus to the trigger", () => {
    trigger().click();
    query("#outside").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("does not close on a click inside the panel", () => {
    trigger().click();
    query("#done").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel().hidden).toBe(false);
  });

  it("closes when focus leaves the panel (Tab out) without restoring focus", () => {
    trigger().click();
    // focus moves to an element outside the controller → modeless close, no restore.
    const outside = query<HTMLButtonElement>("#outside");
    panel().dispatchEvent(new FocusEvent("focusout", { relatedTarget: outside, bubbles: true }));
    expect(panel().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("stays open when focus moves within the controller (panel → trigger)", () => {
    trigger().click();
    panel().dispatchEvent(new FocusEvent("focusout", { relatedTarget: trigger(), bubbles: true }));
    expect(panel().hidden).toBe(false);
  });

  it("removes document listeners on disconnect", () => {
    trigger().click();
    const instance = application.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--popover']"),
      "stimeo--popover",
    ) as PopoverController;
    instance.disconnect();
    // An Escape after teardown must not throw or mutate anything further.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(panel().hidden).toBe(false);
  });

  it("removes the panel focusout listener when disconnected while open (Turbo leak guard)", () => {
    // Open registers a `focusout` listener on the panel; tearing down while open
    // (e.g. a Turbo navigation) must remove it so the detached controller is not
    // re-entered by a late focusout.
    trigger().click();
    expect(panel().hidden).toBe(false);
    const instance = application.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--popover']"),
      "stimeo--popover",
    ) as PopoverController;
    instance.disconnect();

    panel().dispatchEvent(
      new FocusEvent("focusout", { relatedTarget: query("#outside"), bubbles: true }),
    );
    // If the listener leaked it would have closed the (already detached) panel.
    expect(panel().hidden).toBe(false);
  });

  it("does not dismiss on scroll unless closeOnScroll is set", () => {
    trigger().click();
    expect(panel().hidden).toBe(false);
    window.dispatchEvent(new Event("scroll"));
    expect(panel().hidden).toBe(false);
  });

  it("dismisses on scroll when closeOnScroll is set (without restoring focus)", async () => {
    application.stop();
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--popover" data-stimeo--popover-close-on-scroll-value="true">
          <button id="trigger" data-stimeo--popover-target="trigger"
                  aria-expanded="false" data-action="click->stimeo--popover#toggle">Edit</button>
          <div id="pop" data-stimeo--popover-target="panel" role="dialog" aria-label="Edit" hidden>
            <input type="text" />
          </div>
        </div>
      </main>`;
    application = Application.start();
    application.register("stimeo--popover", PopoverController);
    await Promise.resolve();

    trigger().click();
    expect(panel().hidden).toBe(false);
    window.dispatchEvent(new Event("scroll"));
    expect(panel().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    // Closing on scroll must not yank focus back to the trigger (would fight scroll).
    expect(document.activeElement).not.toBe(trigger());
  });
});

describe("PopoverController accessibility", () => {
  let application: Application;

  const startReal = async () => {
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--popover">
          <button data-stimeo--popover-target="trigger" aria-haspopup="dialog"
                  aria-expanded="false" aria-controls="pop2"
                  data-action="click->stimeo--popover#toggle">Edit profile</button>
          <div id="pop2" data-stimeo--popover-target="panel" role="dialog"
               aria-label="Edit profile" hidden>
            <label>Name <input type="text" /></label>
          </div>
        </div>
      </main>`;
    application = Application.start();
    application.register("stimeo--popover", PopoverController);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  it("has no machine-detectable a11y violations when open", async () => {
    await startReal();
    query<HTMLButtonElement>("[data-stimeo--popover-target='trigger']").click();
    await expectNoA11yViolations(document.body);
  });

  it("announces the trigger as a popup button", async () => {
    await startReal();
    const spoken = await captureSpeech({ container: query("main"), steps: 1 });
    // Freeze the whole ordered array (not a name-only `toContain`): the trigger must
    // keep its button role, name, and the popup/collapsed state.
    expect(spoken).toEqual([
      "main",
      "button, Edit profile, 1 control, not expanded, has popup dialog",
    ]);
  });
});
