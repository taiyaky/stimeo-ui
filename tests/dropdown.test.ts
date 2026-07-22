import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DropdownController } from "../src/controllers/dropdown_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { byId, query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link DropdownController}, run in happy-dom (browserless).
 * They assert the disclosure contract: ARIA state, open/close toggling, and the
 * keyboard/outside-click affordances — not any visual styling.
 */

describe("DropdownController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--dropdown">
        <button data-stimeo--dropdown-target="trigger"
                aria-expanded="false"
                data-action="stimeo--dropdown#toggle">Menu</button>
        <div data-stimeo--dropdown-target="menu"><a href="#">Item</a></div>
      </div>
      <a href="#" id="outside">outside</a>`;
    application = Application.start();
    application.register("stimeo--dropdown", DropdownController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const trigger = () => query<HTMLButtonElement>("[data-stimeo--dropdown-target='trigger']");
  const menu = () => query<HTMLElement>("[data-stimeo--dropdown-target='menu']");
  const root = () => query<HTMLElement>("[data-controller='stimeo--dropdown']");
  const controller = () => {
    const instance = application.getControllerForElementAndIdentifier(root(), "stimeo--dropdown");
    if (!(instance instanceof DropdownController)) {
      throw new Error("dropdown controller not found");
    }
    return instance;
  };

  it("starts closed with aria-expanded=false", () => {
    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("associates the trigger with the menu through aria-controls", () => {
    expect(menu().id).toMatch(/^stimeo--dropdown-menu-/);
    expect(trigger().getAttribute("aria-controls")).toBe(menu().id);
  });

  it("preserves an authored aria-controls relationship", () => {
    const instance = controller();
    instance.disconnect();
    menu().id = "author-menu";
    trigger().setAttribute("aria-controls", "author-menu");

    instance.connect();

    expect(menu().id).toBe("author-menu");
    expect(trigger().getAttribute("aria-controls")).toBe("author-menu");
  });

  it("opens when the trigger is clicked", () => {
    trigger().click();
    expect(menu().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("opens through the public open action", () => {
    controller().open();
    expect(menu().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("closes through the public close action", () => {
    trigger().click();

    controller().close();

    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles closed on a second click", () => {
    trigger().click();
    trigger().click();
    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on an outside click", () => {
    trigger().click();
    byId("outside").click();
    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on an outside click even when the consumer stops propagation", () => {
    const outside = byId("outside");
    outside.addEventListener("click", (event) => event.stopPropagation());
    trigger().click();

    outside.click();

    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("stays open when a click occurs inside the controller root", () => {
    trigger().click();

    menu().click();

    expect(menu().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("closes on Escape and restores focus to the trigger", () => {
    trigger().click();
    const item = query<HTMLAnchorElement>("a", menu());
    item.focus();

    item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });

  it("consumes the Escape it owns", () => {
    trigger().click();
    const item = query<HTMLAnchorElement>("a", menu());
    item.focus();

    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    item.dispatchEvent(event);

    // Owning the press marks it handled so outer layers skip the same Escape.
    expect(event.defaultPrevented).toBe(true);
    expect(menu().hidden).toBe(true);
  });

  it("ignores an Escape already handled by an inner layer", () => {
    trigger().click();
    const item = query<HTMLAnchorElement>("a", menu());
    item.focus();

    const handled = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    item.dispatchEvent(handled);

    expect(menu().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("does not own Escape while focus is outside the controller", () => {
    trigger().click();
    const outside = byId("outside");
    outside.focus();

    // Bubbles like a real keypress: the event must actually travel to the
    // document (past every registered listener) and still go unconsumed —
    // a non-bubbling dispatch would reach no handler and prove nothing.
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    outside.dispatchEvent(event);

    // A press aimed at another layer neither closes the menu nor yanks focus.
    expect(event.defaultPrevented).toBe(false);
    expect(menu().hidden).toBe(false);
    expect(document.activeElement).toBe(outside);
  });

  it("does not own Escape bubbling through the root while focus is outside", () => {
    trigger().click();
    byId("outside").focus();

    // A synthetic press dispatched from inside the root still fails the
    // focus-containment guard when the active element sits elsewhere.
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    menu().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(menu().hidden).toBe(false);
    expect(document.activeElement).toBe(byId("outside"));
  });

  it("rescues Escape via the document fallback after focus fell to the body", () => {
    trigger().click();
    // A click on non-focusable menu content drops focus to the body; the press
    // then starts outside the root, so only the document fallback can see it.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("handles missing targets without throwing", async () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `
        <div id="missing-menu" data-controller="stimeo--dropdown">
          <button data-stimeo--dropdown-target="trigger">Menu</button>
        </div>
        <div id="missing-trigger" data-controller="stimeo--dropdown">
          <div data-stimeo--dropdown-target="menu">Content</div>
        </div>`,
    );
    await tick();
    const missingMenuController = application.getControllerForElementAndIdentifier(
      byId("missing-menu"),
      "stimeo--dropdown",
    );
    const missingTriggerController = application.getControllerForElementAndIdentifier(
      byId("missing-trigger"),
      "stimeo--dropdown",
    );
    if (
      !(missingMenuController instanceof DropdownController) ||
      !(missingTriggerController instanceof DropdownController)
    ) {
      throw new Error("missing-target dropdown controllers not found");
    }

    expect(() => {
      missingMenuController.open();
      missingMenuController.close();
      missingMenuController.toggle();
      missingTriggerController.open();
      missingTriggerController.close();
      missingTriggerController.toggle();
    }).not.toThrow();
  });

  it("keeps multiple instances isolated", async () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `
        <div id="second-dropdown" data-controller="stimeo--dropdown">
          <button data-stimeo--dropdown-target="trigger"
                  data-action="stimeo--dropdown#toggle">Second</button>
          <div data-stimeo--dropdown-target="menu">Second content</div>
        </div>`,
    );
    await tick();
    const secondRoot = byId("second-dropdown");
    const secondTrigger = query<HTMLButtonElement>(
      "[data-stimeo--dropdown-target='trigger']",
      secondRoot,
    );
    const secondMenu = query<HTMLElement>("[data-stimeo--dropdown-target='menu']", secondRoot);

    trigger().click();
    secondTrigger.click();

    expect(menu().hidden).toBe(true);
    expect(secondMenu.hidden).toBe(false);
    expect(secondTrigger.getAttribute("aria-controls")).toBe(secondMenu.id);
    expect(secondMenu.id).not.toBe(menu().id);
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

  it("properly disconnects without errors even when the menu is open", () => {
    trigger().click();
    expect(menu().hidden).toBe(false);

    // Direct invocation makes listener removal deterministic without waiting for MutationObserver.
    controller().disconnect();

    document.body.click();
    expect(menu().hidden).toBe(false);

    query<HTMLAnchorElement>("a", menu()).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(menu().hidden).toBe(false);
  });
});
