import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { DismissibleController } from "../src/controllers/dismissible_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { byId, query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link DismissibleController}: removal vs. hide modes,
 * the `dismiss` event, Escape handling, and — its core a11y job — moving focus
 * to a safe place before the close button is removed (WCAG 2.4.3).
 */

describe("DismissibleController", () => {
  let application: Application;

  const start = async (markup: string) => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--dismissible", DismissibleController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
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
  const controller = (element = host()): DismissibleController => {
    const instance = application.getControllerForElementAndIdentifier(
      element,
      "stimeo--dismissible",
    );
    if (!(instance instanceof DismissibleController)) {
      throw new Error("DismissibleController instance not found");
    }
    return instance;
  };
  /** Nullable — used to assert the root is removed in `remove` mode. */
  const maybeRoot = () =>
    document.querySelector<HTMLElement>("[data-stimeo--dismissible-target='root']");
  /** The root, asserted present (`hide` mode and pre-dismiss lookups). */
  const root = () => query("[data-stimeo--dismissible-target='root']");

  it("removes the root from the DOM in remove mode", async () => {
    await start(remove_markup);
    expect(root().getAttribute("data-state")).toBe("open");
    byId("close").click();
    expect(maybeRoot()).toBeNull();
  });

  it("preserves an author-provided initial data-state", async () => {
    await start(`
      <div data-controller="stimeo--dismissible">
        <div data-stimeo--dismissible-target="root" data-state="custom">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
        </div>
      </div>`);

    expect(root().getAttribute("data-state")).toBe("custom");
  });

  it("removes the host when the root target is omitted", async () => {
    await start(`
      <div id="dismissible" data-controller="stimeo--dismissible">
        <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
      </div>`);

    byId("close").click();

    expect(document.getElementById("dismissible")).toBeNull();
  });

  it("hides (not removes) the root in hide mode", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide">
        <div data-stimeo--dismissible-target="root" role="status">
          <button id="close" type="button" data-action="stimeo--dismissible#dismiss">×</button>
        </div>
      </div>`);
    let mode: string | null = null;
    host().addEventListener("stimeo--dismissible:dismiss", (event) => {
      mode = (event as CustomEvent<{ mode: string }>).detail.mode;
    });

    byId("close").click();

    expect(maybeRoot()).not.toBeNull();
    expect(root().hidden).toBe(true);
    expect(root().getAttribute("data-state")).toBe("closing");
    expect(mode).toBe("hide");
  });

  it("dispatches the resolved mode before removing the root", async () => {
    await start(remove_markup);
    let mode: string | null = null;
    let connectedDuringEvent = false;
    host().addEventListener("stimeo--dismissible:dismiss", (event) => {
      mode = (event as CustomEvent<{ mode: string }>).detail.mode;
      connectedDuringEvent = root().isConnected;
    });
    byId("close").click();
    expect(mode).toBe("remove");
    expect(connectedDuringEvent).toBe(true);
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
        <button id="near">Near</button>
        <button id="fallback" data-stimeo--dismissible-target="fallback">Undo</button>
      </div>`);
    const close = byId("close");
    close.focus();
    close.click();
    expect(document.activeElement).toBe(byId("fallback"));
  });

  it("skips an unfocusable fallback and unavailable following candidates", async () => {
    await start(`
      <div data-controller="stimeo--dismissible">
        <div data-stimeo--dismissible-target="root">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
        </div>
        <div id="fallback" data-stimeo--dismissible-target="fallback">Unavailable</div>
        <div hidden><button id="hidden-descendant">Hidden</button></div>
        <div inert><button id="inert-descendant">Inert</button></div>
        <input id="hidden-input" type="hidden">
        <button id="available">Available</button>
      </div>`);
    byId("close").focus();

    byId("close").click();

    expect(document.activeElement).toBe(byId("available"));
  });

  it("ignores a fallback target inside the root", async () => {
    await start(`
      <div data-controller="stimeo--dismissible">
        <div data-stimeo--dismissible-target="root">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
          <button id="fallback" data-stimeo--dismissible-target="fallback">Inside</button>
        </div>
      </div>
      <button id="after">After</button>`);
    byId("close").focus();

    byId("close").click();

    expect(document.activeElement).toBe(byId("after"));
  });

  it("moves focus to the previous focusable element when none follows", async () => {
    await start(`
      <button id="before">Before</button>
      <div data-controller="stimeo--dismissible">
        <div data-stimeo--dismissible-target="root">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
        </div>
      </div>`);
    byId("close").focus();

    byId("close").click();

    expect(document.activeElement).toBe(byId("before"));
  });

  it("falls back to document.body when no focusable element remains", async () => {
    await start(`
      <div data-controller="stimeo--dismissible">
        <div data-stimeo--dismissible-target="root">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
        </div>
      </div>`);
    byId("close").focus();

    byId("close").click();

    expect(document.activeElement).toBe(document.body);
  });

  it("does not move focus when focus was outside the element", async () => {
    await start(remove_markup);
    const before = byId("before");
    before.focus();
    // Dismiss programmatically (not via the close button) so focus stays outside.
    controller().dismiss();
    expect(document.activeElement).toBe(before);
  });

  it("dismisses on Escape when closeOnEscape is set and focus is inside", async () => {
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

  it("does not dismiss on an Escape that cancels an IME composition", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide"
           data-stimeo--dismissible-close-on-escape-value="true">
        <div data-stimeo--dismissible-target="root" role="status">
          <button id="close" type="button" data-action="stimeo--dismissible#dismiss">×</button>
        </div>
      </div>`);
    byId("close").focus();
    // Widget-local half of the shared layered-Escape contract: a composing press
    // steers the IME conversion (e.g. in a text field inside this element),
    // never the element itself.
    host().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true }),
    );
    expect(root().hidden).toBe(false);
  });

  it("does not dismiss on Escape when closeOnEscape has its false default", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide">
        <div data-stimeo--dismissible-target="root">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
        </div>
      </div>`);
    byId("close").focus();

    host().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(controller().closeOnEscapeValue).toBe(false);
    expect(root().hidden).toBe(false);
  });

  it("does not dismiss on Escape when focus is outside", async () => {
    await start(`
      <button id="outside">Outside</button>
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide"
           data-stimeo--dismissible-close-on-escape-value="true">
        <div data-stimeo--dismissible-target="root">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
        </div>
      </div>`);
    byId("outside").focus();

    host().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(root().hidden).toBe(false);
    expect(document.activeElement).toBe(byId("outside"));
  });

  it("ignores non-Escape keys and an already-handled Escape", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide"
           data-stimeo--dismissible-close-on-escape-value="true">
        <div data-stimeo--dismissible-target="root">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
        </div>
      </div>`);
    byId("close").focus();
    host().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const handledEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    handledEscape.preventDefault();

    host().dispatchEvent(handledEscape);

    expect(root().hidden).toBe(false);
  });

  it("starts handling Escape when closeOnEscape changes to true", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide">
        <div data-stimeo--dismissible-target="root">
          <button id="close">Close</button>
        </div>
      </div>`);
    host().setAttribute("data-stimeo--dismissible-close-on-escape-value", "true");
    controller().closeOnEscapeValueChanged();
    byId("close").focus();

    host().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(root().hidden).toBe(true);
  });

  it("stops handling Escape when closeOnEscape changes to false", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide"
           data-stimeo--dismissible-close-on-escape-value="true">
        <div data-stimeo--dismissible-target="root">
          <button id="close">Close</button>
        </div>
      </div>`);
    host().setAttribute("data-stimeo--dismissible-close-on-escape-value", "false");
    controller().closeOnEscapeValueChanged();
    byId("close").focus();

    host().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(root().hidden).toBe(false);
  });

  it("normalizes an unknown mode to remove in behavior and event detail", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="unknown">
        <div data-stimeo--dismissible-target="root">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
        </div>
      </div>`);
    let mode: string | null = null;
    host().addEventListener("stimeo--dismissible:dismiss", (event) => {
      mode = (event as CustomEvent<{ mode: string }>).detail.mode;
    });

    byId("close").click();

    expect(mode).toBe("remove");
    expect(maybeRoot()).toBeNull();
  });

  it("keeps Escape handling isolated between multiple instances", async () => {
    await start(`
      <div id="first-host" data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide"
           data-stimeo--dismissible-close-on-escape-value="true">
        <div id="first-root" data-stimeo--dismissible-target="root">
          <button id="first-close">First</button>
        </div>
      </div>
      <div id="second-host" data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide"
           data-stimeo--dismissible-close-on-escape-value="true">
        <div id="second-root" data-stimeo--dismissible-target="root">
          <button id="second-close">Second</button>
        </div>
      </div>`);
    byId("first-close").focus();

    byId("first-close").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    expect(byId("first-root").hidden).toBe(true);
    expect(byId("second-root").hidden).toBe(false);
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(remove_markup);
    await expectNoA11yViolations(document.body, { rules: { region: { enabled: false } } });
  });

  it("announces the notice content before dismissal", async () => {
    await start(remove_markup);
    const spoken = await captureSpeech({ container: root(), steps: 4 });
    expect(spoken).toEqual(["status", "paragraph", "Saved.", "end of paragraph", "button, Close"]);
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
    controller().disconnect();

    byId("close").focus();
    host().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root().hidden).toBe(false);
  });
});
