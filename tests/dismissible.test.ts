import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { DismissibleController } from "../src/controllers/dismissible_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { byId, query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link DismissibleController}: removal vs. hide modes,
 * the `dismiss` event, Escape handling, and — its core a11y job — moving focus
 * to a safe place before the close button is removed (WCAG 2.4.3).
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("DismissibleController", () => {
  let application: Application;

  const start = async (markup: string) => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--dismissible", DismissibleController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const remove_markup = `
    <button id="before">Before</button>
    <div data-controller="stimeo--dismissible">
      <div data-stimeo--dismissible-target="root" role="status">
        <p>Saved.</p>
        <button id="close" type="button" aria-label="Close"
                data-action="stimeo--dismissible#dismiss">×</button>
      </div>
    </div>
    <button id="after">After</button>`;

  const host = () => query("[data-controller='stimeo--dismissible']");
  /** Nullable — used to assert the root is removed in `remove` mode. */
  const maybeRoot = () =>
    document.querySelector<HTMLElement>("[data-stimeo--dismissible-target='root']");
  /** The root, asserted present (`hide` mode and pre-dismiss lookups). */
  const root = () => query("[data-stimeo--dismissible-target='root']");

  it("removes the root from the DOM in remove mode", async () => {
    await start(remove_markup);
    byId("close").click();
    expect(maybeRoot()).toBeNull();
  });

  it("hides (not removes) the root in hide mode", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide">
        <div data-stimeo--dismissible-target="root" role="status">
          <button id="close" type="button" data-action="stimeo--dismissible#dismiss">×</button>
        </div>
      </div>`);
    byId("close").click();
    expect(maybeRoot()).not.toBeNull();
    expect(root().hidden).toBe(true);
    expect(root().getAttribute("data-state")).toBe("closing");
  });

  it("dispatches a dismiss event with the mode", async () => {
    await start(remove_markup);
    let mode: string | null = null;
    host().addEventListener("stimeo--dismissible:dismiss", (event) => {
      mode = (event as CustomEvent<{ mode: string }>).detail.mode;
    });
    byId("close").click();
    expect(mode).toBe("remove");
  });

  it("moves focus to the next focusable element when focus was inside", async () => {
    await start(remove_markup);
    const close = byId("close");
    close.focus();
    close.click();
    expect(document.activeElement).toBe(byId("after"));
  });

  it("retreats to the fallback target when provided", async () => {
    await start(`
      <button id="far-away">Far</button>
      <div data-controller="stimeo--dismissible">
        <div data-stimeo--dismissible-target="root" role="status">
          <button id="close" type="button" data-action="stimeo--dismissible#dismiss">×</button>
        </div>
        <button id="fallback" data-stimeo--dismissible-target="fallback">Undo</button>
      </div>`);
    const close = byId("close");
    close.focus();
    close.click();
    expect(document.activeElement).toBe(byId("fallback"));
  });

  it("does not move focus when focus was outside the element", async () => {
    await start(remove_markup);
    const before = byId("before");
    before.focus();
    // Dismiss programmatically (not via the close button) so focus stays outside.
    const instance = application.getControllerForElementAndIdentifier(
      host(),
      "stimeo--dismissible",
    ) as DismissibleController;
    instance.dismiss();
    expect(document.activeElement).toBe(before);
  });

  it("dismisses on Escape only when closeOnEscape is set and focus is inside", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide"
           data-stimeo--dismissible-close-on-escape-value="true">
        <div data-stimeo--dismissible-target="root" role="status">
          <button id="close" type="button" data-action="stimeo--dismissible#dismiss">×</button>
        </div>
      </div>`);
    byId("close").focus();
    host().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root().hidden).toBe(true);
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(remove_markup);
    await expectNoA11yViolations(document.body, { rules: { region: { enabled: false } } });
  });

  it("announces the notice content before dismissal", async () => {
    await start(remove_markup);
    const spoken = await captureSpeech({ container: root(), steps: 0 });
    expect(spoken).toEqual(["status"]);
  });

  // `disconnect()` must remove the manually-bound Escape listener (it is not a
  // Stimulus `data-action`). Driven directly because `application.stop()` leaves
  // controllers connected — only element detachment / disconnect tears them down.
  it("removes the Escape listener on disconnect", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide"
           data-stimeo--dismissible-close-on-escape-value="true">
        <div data-stimeo--dismissible-target="root" role="status">
          <button id="close" type="button" data-action="stimeo--dismissible#dismiss">×</button>
        </div>
      </div>`);
    const instance = application.getControllerForElementAndIdentifier(
      host(),
      "stimeo--dismissible",
    ) as DismissibleController;
    instance.disconnect();

    byId("close").focus();
    host().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root().hidden).toBe(false);
  });
});
