import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DropdownController } from "../src/controllers/dropdown_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { byId, query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents } from "./helpers/state_events";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

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

  it("keeps an authored aria-controls that names more than the menu", () => {
    const instance = controller();
    instance.disconnect();
    menu().id = "author-menu";
    trigger().setAttribute("aria-controls", "author-menu author-hint");

    instance.connect();

    expect(menu().id).toBe("author-menu");
    expect(trigger().getAttribute("aria-controls")).toBe("author-menu author-hint");
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

  // --- Machine-detectable a11y ---

  it("has no machine-detectable a11y violations while closed", async () => {
    await expectNoA11yViolations(root());
  });

  it("has no machine-detectable a11y violations while open", async () => {
    trigger().click();
    expect(menu().hidden).toBe(false);
    await expectNoA11yViolations(root());
  });

  // --- Speech-order regression ---

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
  // --- A trigger or a menu that takes over ---

  describe("a morph that keeps the elements", () => {
    /** Puts the server's markup back on the trigger and the menu, as Turbo's morph does. */
    const morph = () => {
      for (const element of [trigger(), menu()]) {
        for (const name of element.getAttributeNames()) {
          if (name.endsWith("-lease")) element.removeAttribute(name);
        }
      }
      menu().removeAttribute("hidden");
      menu().removeAttribute("id");
      trigger().setAttribute("aria-expanded", "false");
      trigger().removeAttribute("aria-controls");
      root().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    };

    it("keeps a closed dropdown closed and its trigger naming the menu", async () => {
      const events = captureStateEvents("stimeo--dropdown");
      morph();
      await flushMicrotasks();

      expect(menu().hidden).toBe(true);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(menu().id).not.toBe("");
      expect(trigger().getAttribute("aria-controls")).toBe(menu().id);
      expect(events.seen).toEqual([]);
      events.stop();
    });

    it("keeps an open dropdown open and described", async () => {
      trigger().click();
      expect(menu().hidden).toBe(false);
      const events = captureStateEvents("stimeo--dropdown");

      morph();
      await flushMicrotasks();

      expect(menu().hidden).toBe(false);
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(events.seen).toEqual([]);
      events.stop();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(menu().hidden).toBe(true);
    });

    it("keeps a menu that arrived after the open one left closed", async () => {
      trigger().click();
      const old = menu();
      old.remove();
      controller().menuTargetDisconnected(old);
      const arrived = document.createElement("div");
      arrived.setAttribute("data-stimeo--dropdown-target", "menu");
      root().append(arrived);
      controller().menuTargetConnected();
      expect(arrived.hidden).toBe(true);

      morph();
      await flushMicrotasks();

      expect(menu()).toBe(arrived);
      expect(arrived.hidden).toBe(true);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
    });

    it("repairs nothing when no menu is left", async () => {
      const old = menu();
      old.remove();
      controller().menuTargetDisconnected(old);
      await tick();

      root().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
      await flushMicrotasks();

      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(root().querySelector("[data-stimeo--dropdown-target='menu']")).toBeNull();
    });

    it("stops repairing once disconnected", async () => {
      controller().disconnect();
      morph();
      await flushMicrotasks();
      expect(menu().hidden).toBe(false);
    });
  });

  /**
   * The open state lives on the trigger (`aria-expanded`) and the menu (`hidden`).
   * A trigger or a menu that takes over — in one task, or after an earlier one
   * leaves in a later task — carries that state, silently.
   */
  describe("a trigger or a menu that takes over", () => {
    /** A server-rendered copy of the trigger that still reads closed and names no menu. */
    const staleTrigger = (): HTMLButtonElement => {
      const copy = trigger().cloneNode(true) as HTMLButtonElement;
      copy.setAttribute("aria-expanded", "false");
      copy.removeAttribute("aria-controls");
      return copy;
    };
    /** A server-rendered copy of the menu with `hidden` as given and no id. */
    const staleMenu = (hidden: boolean): HTMLElement => {
      const copy = menu().cloneNode(true) as HTMLElement;
      copy.removeAttribute("id");
      copy.hidden = hidden;
      return copy;
    };

    it("reflects the open menu into a trigger replaced in one task", async () => {
      controller().open();
      const successor = staleTrigger();
      trigger().replaceWith(successor);
      await tick();

      expect(trigger()).toBe(successor);
      expect(successor.getAttribute("aria-expanded")).toBe("true");
    });

    it("reflects the open menu into the trigger that stays after an earlier one leaves", async () => {
      controller().open();
      const original = trigger();
      const successor = staleTrigger();
      original.after(successor);
      await tick();
      original.remove();
      await tick();

      expect(trigger()).toBe(successor);
      expect(successor.getAttribute("aria-expanded")).toBe("true");
    });

    it("names the menu from a trigger that takes over without aria-controls", async () => {
      const successor = staleTrigger();
      trigger().replaceWith(successor);
      await tick();

      expect(successor.getAttribute("aria-controls")).toBe(menu().id);
    });

    it("keeps the menu open on a menu replaced in one task", async () => {
      controller().open();
      const successor = staleMenu(true);
      menu().replaceWith(successor);
      await tick();

      expect(menu()).toBe(successor);
      expect(successor.hidden).toBe(false);
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
    });

    it("keeps the menu open on the menu that stays after an earlier one leaves", async () => {
      controller().open();
      const original = menu();
      const successor = staleMenu(true);
      original.after(successor);
      await tick();
      original.remove();
      await tick();

      expect(menu()).toBe(successor);
      expect(successor.hidden).toBe(false);
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
    });

    it("keeps the menu closed on a menu that takes over authored open", async () => {
      const successor = staleMenu(false);
      menu().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(true);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
    });

    it("points the aria-controls it supplied at the menu that takes over", async () => {
      const successor = staleMenu(true);
      menu().replaceWith(successor);
      await tick();

      expect(successor.id).toMatch(/^stimeo--dropdown-menu-/);
      expect(trigger().getAttribute("aria-controls")).toBe(successor.id);
    });

    it("releases the Escape layer and reads closed once the only menu leaves", async () => {
      trigger().click();
      menu().remove();
      await tick();

      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      const outside = byId("outside");
      outside.focus();
      trigger().focus();
      const press = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(false);
    });

    it("brings a trigger that arrives after the only one left to the open state", async () => {
      controller().open();
      const late = staleTrigger();
      trigger().remove();
      await tick();

      root().prepend(late);
      await tick();

      expect(late.getAttribute("aria-expanded")).toBe("true");
      expect(late.getAttribute("aria-controls")).toBe(menu().id);
    });

    it("closes a menu that arrives after the only one left, even one authored open", async () => {
      controller().open();
      const late = staleMenu(false);
      menu().remove();
      await tick();

      root().append(late);
      await tick();

      expect(late.hidden).toBe(true);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(trigger().getAttribute("aria-controls")).toBe(late.id);
    });

    it("keeps the menu open when the trigger and the menu are replaced together", async () => {
      controller().open();
      const newTrigger = staleTrigger();
      const newMenu = staleMenu(true);
      trigger().replaceWith(newTrigger);
      menu().replaceWith(newMenu);
      await tick();

      expect(newMenu.hidden).toBe(false);
      expect(newTrigger.getAttribute("aria-expanded")).toBe("true");
      expect(newTrigger.getAttribute("aria-controls")).toBe(newMenu.id);
    });

    it("keeps closed a menu the page closed, when it is then replaced", async () => {
      controller().open();
      menu().hidden = true;
      const successor = staleMenu(false);
      menu().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(true);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
    });

    it("leaves an authored aria-controls alone when the menu is replaced", async () => {
      const instance = controller();
      instance.disconnect();
      menu().id = "author-menu";
      trigger().setAttribute("aria-controls", "author-menu");
      instance.connect();

      menu().replaceWith(staleMenu(true));
      await tick();

      expect(trigger().getAttribute("aria-controls")).toBe("author-menu");
    });

    it("writes nothing when a trigger or a menu arrives behind the current one", async () => {
      controller().open();
      const writes: MutationRecord[] = [];
      const observer = new MutationObserver((records) => writes.push(...records));
      observer.observe(root(), { attributes: true, subtree: true });
      const behindTrigger = staleTrigger();
      const behindMenu = staleMenu(true);
      trigger().after(behindTrigger);
      menu().after(behindMenu);
      await tick();
      writes.push(...observer.takeRecords());
      observer.disconnect();

      expect(writes.map((write) => write.attributeName)).toEqual([]);
      expect(behindTrigger.getAttribute("aria-expanded")).toBe("false");
      expect(behindMenu.hidden).toBe(true);
    });

    it("reports nothing while it moves the open state", async () => {
      controller().open();
      const events = captureStateEvents("stimeo--dropdown");
      const changes: Event[] = [];
      const onChange = (event: Event): void => {
        changes.push(event);
      };
      document.addEventListener("change", onChange);
      const original = menu();
      original.after(staleMenu(true));
      trigger().after(staleTrigger());
      await tick();
      original.remove();
      trigger().remove();
      await tick();

      expect(events.seen).toEqual([]);
      expect(changes).toEqual([]);
      events.stop();
      document.removeEventListener("change", onChange);
    });

    it("tolerates the removal of the only trigger and the only menu", () => {
      controller().open();
      const onlyTrigger = trigger();
      const onlyMenu = menu();
      onlyTrigger.remove();
      onlyMenu.remove();

      // Drive the callbacks directly: happy-dom delivers target callbacks unreliably.
      expect(() => controller().triggerTargetDisconnected(onlyTrigger)).not.toThrow();
      expect(() => controller().menuTargetDisconnected(onlyMenu)).not.toThrow();
    });

    it("writes nothing into the trigger or the menu that stay once it has disconnected", async () => {
      const original = trigger();
      const successorTrigger = staleTrigger();
      original.after(successorTrigger);
      const originalMenu = menu();
      const successorMenu = staleMenu(true);
      originalMenu.after(successorMenu);
      await tick();
      controller().open();
      const instance = controller();
      instance.disconnect();
      original.remove();
      originalMenu.remove();
      instance.triggerTargetDisconnected(original);
      instance.menuTargetDisconnected(originalMenu);
      instance.triggerTargetConnected();
      instance.menuTargetConnected();
      await tick();

      expect(successorTrigger.getAttribute("aria-expanded")).toBe("false");
      expect(successorTrigger.hasAttribute("aria-controls")).toBe(false);
      expect(successorMenu.hidden).toBe(true);
    });

    it("gives a trigger that stops being the trigger its own ARIA back", async () => {
      controller().open();
      const former = trigger();
      const successor = staleTrigger();
      former.after(successor);
      await tick();

      // The element stays; only the attribute naming it the trigger goes.
      former.removeAttribute("data-stimeo--dropdown-target");
      await tick();

      expect(former.getAttribute("aria-expanded")).toBe("false");
      expect(former.hasAttribute("aria-controls")).toBe(false);
      expect(successor.getAttribute("aria-expanded")).toBe("true");
      expect(successor.getAttribute("aria-controls")).toBe(menu().id);
    });

    it("gives a menu that stops being the menu its own hidden back", async () => {
      controller().open();
      const former = menu();
      const successor = staleMenu(true);
      former.after(successor);
      await tick();

      former.removeAttribute("data-stimeo--dropdown-target");
      await tick();

      expect(former.hidden).toBe(false);
      expect(successor.hidden).toBe(false);
    });

    it("gives the trigger and the menu their own values back when the dropdown loses its controller", async () => {
      controller().open();
      const departedTrigger = trigger();
      const departedMenu = menu();

      root().removeAttribute("data-controller");
      await tick();

      expect(departedTrigger.getAttribute("aria-expanded")).toBe("false");
      expect(departedTrigger.hasAttribute("aria-controls")).toBe(false);
      expect(departedMenu.hidden).toBe(false);
    });

    // The menu here is authored without `hidden`, so a menu given back while closed shows again.
    it("gives a closed menu that stops being the menu its own hidden back", async () => {
      const former = menu();
      expect(former.hidden).toBe(true);
      const successor = staleMenu(true);
      former.after(successor);
      await tick();

      former.removeAttribute("data-stimeo--dropdown-target");
      await tick();

      expect(former.hidden).toBe(false);
      expect(successor.hidden).toBe(true);
    });

    it("gives a closed menu its own hidden back when the dropdown loses its controller", async () => {
      const departed = menu();
      expect(departed.hidden).toBe(true);

      root().removeAttribute("data-controller");
      await tick();

      expect(departed.hidden).toBe(false);
    });

    it("keeps a closed menu that moves within the dropdown hidden", async () => {
      const moving = menu();
      root().prepend(moving);
      await tick();

      expect(moving.hidden).toBe(true);
    });

    it("brings the trigger to a menu the page hid when another menu arrives behind it", async () => {
      controller().open();
      menu().hidden = true;
      menu().after(staleMenu(true));
      await tick();

      expect(trigger().getAttribute("aria-expanded")).toBe("false");
    });

    it("leaves a hidden value the page wrote on the menu alone when another menu arrives behind it", async () => {
      controller().open();
      menu().setAttribute("hidden", "until-found");
      menu().after(staleMenu(true));
      await tick();

      expect(menu().getAttribute("hidden")).toBe("until-found");
    });

    it("leaves an aria-controls the page writes on a trigger after giving it back alone", async () => {
      const former = trigger();
      const supplied = former.getAttribute("aria-controls") as string;
      former.removeAttribute("data-stimeo--dropdown-target");
      await tick();
      expect(former.hasAttribute("aria-controls")).toBe(false);

      // The page names the menu itself, then the menu is replaced and the element is
      // the trigger again: the value is the page's, so it is not pointed elsewhere.
      former.setAttribute("aria-controls", supplied);
      menu().replaceWith(staleMenu(true));
      await tick();
      former.setAttribute("data-stimeo--dropdown-target", "trigger");
      await tick();

      expect(former.getAttribute("aria-controls")).toBe(supplied);
    });

    it("keeps values the page wrote on a trigger and a menu that stop being targets", async () => {
      controller().open();
      const former = trigger();
      const formerMenu = menu();
      former.setAttribute("aria-expanded", "mixed");
      former.setAttribute("aria-controls", "elsewhere");
      formerMenu.setAttribute("hidden", "until-found");

      root().removeAttribute("data-controller");
      await tick();

      expect(former.getAttribute("aria-expanded")).toBe("mixed");
      expect(former.getAttribute("aria-controls")).toBe("elsewhere");
      expect(formerMenu.getAttribute("hidden")).toBe("until-found");
    });

    it("keeps what it wrote on a trigger and a menu that move within the dropdown", async () => {
      controller().open();
      const movingTrigger = trigger();
      const movingMenu = menu();
      const writes: MutationRecord[] = [];
      const observer = new MutationObserver((records) => writes.push(...records));
      observer.observe(root(), {
        attributes: true,
        subtree: true,
        attributeFilter: ["aria-expanded", "aria-controls", "hidden"],
      });

      root().append(movingTrigger);
      root().prepend(movingMenu);
      await tick();
      writes.push(...observer.takeRecords());
      observer.disconnect();

      expect(movingTrigger.getAttribute("aria-expanded")).toBe("true");
      expect(movingTrigger.getAttribute("aria-controls")).toBe(movingMenu.id);
      expect(movingMenu.hidden).toBe(false);
      expect(writes.map((write) => write.attributeName)).toEqual([]);
    });

    it("keeps what it wrote when the whole dropdown leaves the page", async () => {
      controller().open();
      const keptTrigger = trigger();
      const keptMenu = menu();

      root().remove();
      await tick();

      expect(keptTrigger.getAttribute("aria-expanded")).toBe("true");
      expect(keptTrigger.getAttribute("aria-controls")).toBe(keptMenu.id);
      expect(keptMenu.hidden).toBe(false);
    });
  });

  // --- State events ---

  describe("state events", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    beforeEach(() => {
      capture = captureStateEvents("stimeo--dropdown");
    });

    afterEach(() => {
      capture.stop();
    });

    it("reports a trigger click as a user open, then a user close", () => {
      trigger().click();
      trigger().click();

      expect(capture.names()).toEqual(["open", "close"]);
      expect(capture.reasons()).toEqual(["user", "user"]);
    });

    it("dispatches after the state attributes are written", () => {
      const states: string[] = [];
      root().addEventListener("stimeo--dropdown:open", () => {
        states.push(`${menu().hidden} ${trigger().getAttribute("aria-expanded")}`);
      });

      trigger().click();

      expect(states).toEqual(["false true"]);
    });

    it("bubbles and is not cancelable", () => {
      trigger().click();

      expect(capture.seen[0]?.bubbles).toBe(true);
      expect(capture.seen[0]?.cancelable).toBe(false);
    });

    it("reports a call with no DOM event as api", () => {
      controller().open();
      controller().close();

      expect(capture.reasons()).toEqual(["api", "api"]);
    });

    it("reports an outside click as outside", () => {
      trigger().click();
      capture.clear();

      byId("outside").click();

      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["outside"]);
    });

    it("reports Escape as escape", () => {
      trigger().click();
      capture.clear();

      query<HTMLAnchorElement>("a", menu()).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );

      expect(capture.names()).toEqual(["close"]);
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

    it("stays silent while connect normalizes an authored-open menu", async () => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = `
        <div data-controller="stimeo--dropdown">
          <button data-stimeo--dropdown-target="trigger" aria-expanded="true"
                  data-action="stimeo--dropdown#toggle">Menu</button>
          <div data-stimeo--dropdown-target="menu"><a href="#">Item</a></div>
        </div>`;
      const capture2 = captureStateEvents("stimeo--dropdown");
      application = Application.start();
      application.register("stimeo--dropdown", DropdownController);
      await tick();

      expect(menu().hidden).toBe(true);
      expect(capture2.seen).toEqual([]);
      capture2.stop();
    });

    it("stays silent through a disconnect and a Turbo-style reconnect", async () => {
      trigger().click();
      capture.clear();

      const element = root();
      element.remove();
      await tick();
      document.body.append(element);
      await tick();

      expect(menu().hidden).toBe(true);
      expect(capture.seen).toEqual([]);
    });
  });
});
