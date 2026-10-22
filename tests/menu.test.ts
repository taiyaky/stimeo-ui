import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MenuController } from "../src/controllers/menu_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { keyEvent, press as pressKey, typeKey } from "./helpers/keyboard";
import { recordListeners } from "./helpers/listeners";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents } from "./helpers/state_events";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link MenuController}: the APG Menu Button contract —
 * `aria-expanded`, roving focus across `role="menuitem"`, Escape/outside-click.
 */

describe("MenuController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--menu">
        <button id="menu-trigger" data-stimeo--menu-target="trigger"
                data-action="click->stimeo--menu#toggle keydown->stimeo--menu#onTriggerKeydown"
                aria-haspopup="menu" aria-expanded="false" aria-controls="menu">Actions</button>
        <ul id="menu" role="menu" aria-labelledby="menu-trigger"
            data-stimeo--menu-target="menu" hidden>
          <li role="none"><button role="menuitem" tabindex="-1"
              data-stimeo--menu-target="item"
              data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">Edit</button></li>
          <li role="none"><button role="menuitem" tabindex="-1"
              data-stimeo--menu-target="item"
              data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">Duplicate</button></li>
          <li role="none"><button role="menuitem" tabindex="-1"
              data-stimeo--menu-target="item"
              data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">Delete</button></li>
        </ul>
      </div>
      <a href="#" id="outside">outside</a>`;
    application = Application.start();
    application.register("stimeo--menu", MenuController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const trigger = () =>
    document.querySelector<HTMLButtonElement>(
      "[data-stimeo--menu-target='trigger']",
    ) as HTMLButtonElement;
  const menu = () => document.getElementById("menu") as HTMLElement;
  const items = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("[data-stimeo--menu-target='item']"));
  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--menu']") as HTMLElement;

  it.each(
    (["Home", "End"] as const).flatMap((key) =>
      (
        [
          ["Alt", { altKey: true }],
          ["Ctrl", { ctrlKey: true }],
          ["Meta", { metaKey: true }],
          ["Shift", { shiftKey: true }],
          ["Ctrl+Shift", { ctrlKey: true, shiftKey: true }],
        ] as const
      ).map(([modifier, init]) => [key, modifier, init] as const),
    ),
  )("yields an unassigned Home/End chord (%s, %s)", async (key, _modifier, init) => {
    trigger().click();
    const current = items()[1];
    if (!current) throw new Error("Expected middle item");
    current.focus();
    const element = root();
    const events: Event[] = [];
    for (const name of ["stimeo--menu:open", "stimeo--menu:close"]) {
      element.addEventListener(name, (event) => events.push(event));
    }
    const before = element.outerHTML;
    const rejected = pressKey(current, key, init);
    expect(rejected.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(current);
    expect(element.outerHTML).toBe(before);
    expect(events).toEqual([]);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(menu().hidden).toBe(false);
    expect(pressKey(current, key).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items()[key === "Home" ? 0 : 2]);
  });

  it("starts closed", () => {
    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens and focuses the first item on click", () => {
    trigger().click();
    expect(menu().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(items()[0]);
  });

  it("opens and focuses the last item on ArrowUp", () => {
    pressKey(trigger(), "ArrowUp", { bubbles: true });
    expect(menu().hidden).toBe(false);
    expect(document.activeElement).toBe(items()[2]);
  });

  it("leaves End on the trigger of an open menu to the browser", () => {
    trigger().click();
    expect(menu().hidden).toBe(false);
    const event = pressKey(trigger(), "End");
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it("leaves a modified arrow on the trigger to the browser", () => {
    // A chorded arrow belongs to the browser, so the menu neither claims the press
    // nor opens. Cancelable, or `defaultPrevented` could not report the claim.
    trigger().focus();
    const event = keyEvent("ArrowDown", { altKey: true, bubbles: true, cancelable: true });
    pressKey(trigger(), event);

    expect(event.defaultPrevented).toBe(false);
    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });

  it("opens and focuses the first item on ArrowDown", () => {
    pressKey(trigger(), "ArrowDown", { bubbles: true });
    expect(menu().hidden).toBe(false);
    expect(document.activeElement).toBe(items()[0]);
  });

  it("claims ArrowDown and ArrowUp on the trigger", () => {
    const down = keyEvent("ArrowDown", { bubbles: true, cancelable: true });
    pressKey(trigger(), down);
    expect(down.defaultPrevented).toBe(true);

    trigger().click(); // close again
    const up = keyEvent("ArrowUp", { bubbles: true, cancelable: true });
    pressKey(trigger(), up);
    expect(up.defaultPrevented).toBe(true);
    expect(menu().hidden).toBe(false);
  });

  it("does not handle Enter/Space on the trigger (left to the native button click)", () => {
    pressKey(trigger(), "Enter", { bubbles: true });
    pressKey(trigger(), " ", { bubbles: true });
    // keydown alone does not open; the browser's synthesized click would.
    expect(menu().hidden).toBe(true);
  });

  it("leaves a modified arrow on an item to the browser", () => {
    // Both the per-element action and the delegated listener run this key, and
    // neither may claim it or move the roving focus.
    trigger().click(); // open, focus the first item
    expect(document.activeElement).toBe(items()[0]);

    const event = keyEvent("ArrowDown", { altKey: true, bubbles: true, cancelable: true });
    pressKey(items()[0] as HTMLElement, event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(items()[0]);
    expect(menu().hidden).toBe(false);
  });

  it("moves focus between items with ArrowDown (wrapping)", () => {
    trigger().click();
    pressKey(items()[0] as HTMLElement, "ArrowDown", { bubbles: true });
    expect(document.activeElement).toBe(items()[1]);
    items()[2]?.focus();
    pressKey(items()[2] as HTMLElement, "ArrowDown", { bubbles: true });
    expect(document.activeElement).toBe(items()[0]);
  });

  it("claims ArrowUp, Home and End on an item", () => {
    trigger().click();
    for (const key of ["ArrowUp", "Home", "End"]) {
      const event = keyEvent(key, { bubbles: true, cancelable: true });
      pressKey(items()[0] as HTMLElement, event);
      expect(event.defaultPrevented, key).toBe(true);
    }
  });

  it("moves roving focus through the per-element action when an ancestor stops the key", () => {
    trigger().click();
    // The key never reaches the controller element, so only the action bound on the
    // item itself can handle it.
    items()[0]?.parentElement?.addEventListener("keydown", (event) => event.stopPropagation());

    pressKey(items()[0] as HTMLElement, "ArrowDown", { bubbles: true, cancelable: true });

    expect(document.activeElement).toBe(items()[1]);
  });

  it("closes on Escape and returns focus to the trigger", () => {
    trigger().click();
    pressKey(items()[0] as HTMLElement, "Escape", { bubbles: true });
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("defers Tab closing so the browser can move focus first", async () => {
    trigger().click();
    items()[0]?.focus();
    pressKey(items()[0] as HTMLElement, "Tab", { bubbles: true });
    // Still open at the synchronous point: hiding the focused item before the
    // browser's default Tab action would restart traversal at the document head.
    expect(menu().hidden).toBe(false);
    await tick();
    expect(menu().hidden).toBe(true);
    // Tab lets focus move on naturally; it is not pulled back to the trigger.
    expect(document.activeElement).not.toBe(trigger());
  });

  it("keeps one pending close when both key handlers see the same Tab", () => {
    vi.useFakeTimers();
    try {
      trigger().click();
      items()[0]?.focus();
      const tab = () =>
        !pressKey(items()[0] as HTMLElement, "Tab", { bubbles: true }).defaultPrevented;
      tab();
      tab();

      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a pending Tab close when the menu is reopened in the same task", async () => {
    trigger().click();
    items()[0]?.focus();
    pressKey(items()[0] as HTMLElement, "Tab", { bubbles: true });
    trigger().click(); // close synchronously …
    trigger().click(); // … and reopen before the deferred close fires
    expect(menu().hidden).toBe(false);
    await tick();
    // The stale Tab close must not slam the reopened menu shut.
    expect(menu().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("discards a pending Tab close when open() runs on the open menu", async () => {
    const controller = application.getControllerForElementAndIdentifier(root(), "stimeo--menu");
    if (!(controller instanceof MenuController)) throw new Error("menu controller not found");
    trigger().click();
    items()[0]?.focus();
    pressKey(items()[0] as HTMLElement, "Tab", { bubbles: true });

    controller.open();
    await tick();

    expect(menu().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("discards a pending Tab close when another path closes the menu first", async () => {
    trigger().click();
    items()[0]?.focus();
    pressKey(items()[0] as HTMLElement, "Tab", { bubbles: true });
    (document.getElementById("outside") as HTMLElement).click();
    expect(menu().hidden).toBe(true);

    // The hooks move only when they change, so the page showing the menu again by hand
    // is what makes a deferred close that still fired observable.
    menu().hidden = false;
    await tick();

    expect(menu().hidden).toBe(false);
  });

  it("closes when an item is activated", () => {
    trigger().click();
    items()[1]?.click();
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on an outside click", () => {
    trigger().click();
    const outside = document.getElementById("outside") as HTMLAnchorElement;
    outside.focus();
    outside.click();
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(outside);
  });

  it("keeps an open menu when an inside click removes its own target", () => {
    trigger().click();
    const inside = document.createElement("span");
    root().appendChild(inside);
    inside.addEventListener("click", () => inside.remove());

    inside.click();

    expect(menu().hidden).toBe(false);
  });

  it("closes the previous instance when another menu trigger opens", async () => {
    const second = document.createElement("div");
    second.innerHTML = `
      <div data-controller="stimeo--menu">
        <button id="second-trigger" data-stimeo--menu-target="trigger"
          data-action="click->stimeo--menu#toggle" aria-expanded="false">Other</button>
        <div id="second-menu" role="menu" data-stimeo--menu-target="menu" hidden>
          <button role="menuitem" tabindex="-1" data-stimeo--menu-target="item"
            data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">Other item</button>
        </div>
      </div>`;
    document.body.appendChild(second);
    await tick();
    trigger().click();

    (document.getElementById("second-trigger") as HTMLButtonElement).click();

    expect(menu().hidden).toBe(true);
    expect((document.getElementById("second-menu") as HTMLElement).hidden).toBe(false);
  });

  it("yields an item key already consumed by a descendant", () => {
    trigger().click();
    const item = items()[0] as HTMLButtonElement;
    const child = document.createElement("span");
    child.tabIndex = -1;
    item.appendChild(child);
    child.addEventListener("keydown", (event) => event.preventDefault());
    child.focus();

    pressKey(child, "ArrowDown", { bubbles: true, cancelable: true });

    expect(document.activeElement).toBe(child);
  });

  it("yields a trigger key already consumed by a descendant", () => {
    const child = document.createElement("span");
    child.tabIndex = -1;
    trigger().appendChild(child);
    child.addEventListener("keydown", (event) => event.preventDefault());
    child.focus();

    pressKey(child, "ArrowDown", { bubbles: true, cancelable: true });

    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(child);
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

  // --- Speech order ---

  it("announces role, name, and state in roving order when open", async () => {
    trigger().click();
    const phrases = await captureSpeech({ container: menu(), steps: 4 });
    expect(phrases).toEqual([
      "menu, Actions, orientated vertically",
      "menuitem, Edit, position 1, set size 3",
      "menuitem, Duplicate, position 2, set size 3",
      "menuitem, Delete, position 3, set size 3",
      "end of menu, Actions, orientated vertically",
    ]);
  });

  // --- Disconnect teardown ---

  it("properly disconnect without errors even when menu is open", async () => {
    trigger().click();
    expect(menu().hidden).toBe(false);

    const root = document.querySelector("[data-controller='stimeo--menu']") as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(root, "stimeo--menu");
    if (!controller) throw new Error("menu controller not found");

    controller.disconnect();

    // After disconnect, outside click should not toggle menu (listener removed)
    document.body.click();
    expect(menu().hidden).toBe(false);
  });

  it("cancels a pending Tab close on disconnect", async () => {
    trigger().click();
    items()[0]?.focus();
    pressKey(items()[0] as HTMLElement, "Tab", { bubbles: true });

    const controller = application.getControllerForElementAndIdentifier(root(), "stimeo--menu");
    if (!controller) throw new Error("menu controller not found");
    controller.disconnect();
    await tick();

    // The deferred close must not fire against a disconnected controller.
    expect(menu().hidden).toBe(false);
  });

  it("removes every listener it adds to its element and the document", () => {
    const controller = application.getControllerForElementAndIdentifier(root(), "stimeo--menu");
    if (!controller) throw new Error("menu controller not found");
    controller.disconnect();

    const ledger = recordListeners();
    const held = () => [...ledger.live(root()), ...ledger.live(document)];
    try {
      controller.connect();
      expect(held().length).toBeGreaterThan(0);

      controller.disconnect();

      expect(held()).toEqual([]);
    } finally {
      ledger.restore();
    }
  });

  const itemKey = (index: number, key: string) =>
    !pressKey(items()[index] as HTMLElement, key, { bubbles: true }).defaultPrevented;

  it("moves focus up between items with ArrowUp (wrapping to the last)", () => {
    trigger().click(); // open, focus item 0
    itemKey(0, "ArrowUp");
    expect(document.activeElement).toBe(items()[2]); // wrapped
  });

  it("jumps to the first item on Home and the last on End", () => {
    trigger().click();
    itemKey(0, "End");
    expect(document.activeElement).toBe(items()[2]);
    itemKey(2, "Home");
    expect(document.activeElement).toBe(items()[0]);
  });

  it("ignores other keys on an item (no focus move)", () => {
    trigger().click();
    itemKey(0, "a");
    expect(document.activeElement).toBe(items()[0]);
  });

  it("skips a hidden item in the roving order", () => {
    (items()[1] as HTMLButtonElement).hidden = true;
    trigger().click();
    itemKey(0, "ArrowDown");
    expect(document.activeElement).toBe(items()[2]);
    itemKey(2, "ArrowUp");
    expect(document.activeElement).toBe(items()[0]);
  });

  it("closes when the trigger is clicked a second time", () => {
    trigger().click();
    expect(menu().hidden).toBe(false);
    trigger().click(); // toggle → close
    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  // --- A trigger or a menu that takes over ---

  /**
   * The open state lives on the trigger (`aria-expanded`) and the menu (`hidden`).
   * A trigger or a menu that takes over — in one task, or after an earlier one
   * leaves in a later task — carries that state, silently.
   */
  describe("a trigger or a menu that takes over", () => {
    const controller = () => {
      const instance = application.getControllerForElementAndIdentifier(root(), "stimeo--menu");
      if (!(instance instanceof MenuController)) throw new Error("menu controller not found");
      return instance;
    };
    /** A server-rendered copy of the trigger that still reads closed. */
    const staleTrigger = (): HTMLButtonElement => {
      const copy = trigger().cloneNode(true) as HTMLButtonElement;
      copy.removeAttribute("id");
      copy.setAttribute("aria-expanded", "false");
      return copy;
    };
    /** A server-rendered copy of the menu with `hidden` as given and items of its own. */
    const staleMenu = (hidden: boolean): HTMLElement => {
      const copy = menu().cloneNode(true) as HTMLElement;
      copy.id = "menu-successor";
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

    it("keeps the menu open on a menu replaced in one task", async () => {
      controller().open();
      const successor = staleMenu(true);
      menu().replaceWith(successor);
      await tick();

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

      expect(successor.hidden).toBe(false);
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
    });

    it("leaves focus where it was when a menu is replaced in one task", async () => {
      controller().open();
      trigger().focus();
      const successor = staleMenu(true);
      menu().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(false);
      expect(document.activeElement).toBe(trigger());
    });

    it("leaves focus where it was when the menu that stays takes over after an earlier one leaves", async () => {
      controller().open();
      trigger().focus();
      const original = menu();
      const successor = staleMenu(true);
      original.after(successor);
      await tick();
      original.remove();
      await tick();

      expect(successor.hidden).toBe(false);
      expect(document.activeElement).toBe(trigger());
    });

    it("keeps the menu closed on a menu that takes over authored open", async () => {
      const successor = staleMenu(false);
      menu().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(true);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
    });

    it("leaves the Escape stack and reads closed once the only menu leaves", async () => {
      trigger().click();
      menu().remove();
      await tick();

      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      trigger().focus();
      const press = keyEvent("Escape", { bubbles: true, cancelable: true });
      pressKey(trigger(), press);
      expect(press.defaultPrevented).toBe(false);
    });

    it("lets a pending Tab close close the menu that took over", async () => {
      trigger().click();
      pressKey(items()[0] as HTMLButtonElement, "Tab", { bubbles: true });
      const successor = staleMenu(true);
      menu().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(true);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
    });

    it("brings a trigger that arrives after the only one left to the open state", async () => {
      controller().open();
      const late = staleTrigger();
      trigger().remove();
      await tick();

      root().prepend(late);
      await tick();

      expect(late.getAttribute("aria-expanded")).toBe("true");
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
      const events = captureStateEvents("stimeo--menu");
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

      // The test stays synchronous, so it calls the Stimulus target callbacks directly
      // instead of waiting for the MutationObserver delivery, and a throw fails this case.
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
      expect(successorMenu.hidden).toBe(true);
    });

    it("gives a trigger that stops being the trigger its own aria-expanded back", async () => {
      controller().open();
      const former = trigger();
      const successor = staleTrigger();
      former.after(successor);
      await tick();

      // The element stays; only the attribute naming it the trigger goes.
      former.removeAttribute("data-stimeo--menu-target");
      await tick();

      expect(former.getAttribute("aria-expanded")).toBe("false");
      expect(successor.getAttribute("aria-expanded")).toBe("true");
    });

    it("gives a menu that stops being the menu its own hidden back", async () => {
      controller().open();
      const former = menu();
      const successor = staleMenu(true);
      former.after(successor);
      await tick();

      former.removeAttribute("data-stimeo--menu-target");
      await tick();

      expect(former.hidden).toBe(true);
      expect(successor.hidden).toBe(false);
    });

    it("gives the trigger and the menu their own values back when the menu button loses its controller", async () => {
      controller().open();
      const departedTrigger = trigger();
      const departedMenu = menu();

      root().removeAttribute("data-controller");
      await tick();

      expect(departedTrigger.getAttribute("aria-expanded")).toBe("false");
      expect(departedMenu.hidden).toBe(true);
    });

    it("keeps values the page wrote on a trigger and a menu that stop being targets", async () => {
      controller().open();
      const former = trigger();
      const formerMenu = menu();
      former.setAttribute("aria-expanded", "mixed");
      formerMenu.setAttribute("hidden", "until-found");

      root().removeAttribute("data-controller");
      await tick();

      expect(former.getAttribute("aria-expanded")).toBe("mixed");
      expect(formerMenu.getAttribute("hidden")).toBe("until-found");
    });

    it("keeps what it wrote on a trigger and a menu that move within the menu button", async () => {
      controller().open();
      const movingTrigger = trigger();
      const movingMenu = menu();
      const writes: MutationRecord[] = [];
      const observer = new MutationObserver((records) => writes.push(...records));
      observer.observe(root(), {
        attributes: true,
        subtree: true,
        attributeFilter: ["aria-expanded", "hidden"],
      });

      root().append(movingTrigger);
      root().prepend(movingMenu);
      await tick();
      writes.push(...observer.takeRecords());
      observer.disconnect();

      expect(movingTrigger.getAttribute("aria-expanded")).toBe("true");
      expect(movingMenu.hidden).toBe(false);
      expect(writes.map((write) => write.attributeName)).toEqual([]);
    });

    it("keeps what it wrote when the whole menu button leaves the page", async () => {
      controller().open();
      const keptTrigger = trigger();
      const keptMenu = menu();

      root().remove();
      await tick();

      expect(keptTrigger.getAttribute("aria-expanded")).toBe("true");
      expect(keptMenu.hidden).toBe(false);
    });
  });

  // --- State events ---

  describe("state events", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    const controller = () => {
      const instance = application.getControllerForElementAndIdentifier(root(), "stimeo--menu");
      if (!(instance instanceof MenuController)) throw new Error("menu controller not found");
      return instance;
    };

    beforeEach(() => {
      capture = captureStateEvents("stimeo--menu");
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

    it("dispatches after the state attributes are written, bubbling and not cancelable", () => {
      const states: string[] = [];
      root().addEventListener("stimeo--menu:open", () => {
        states.push(`${menu().hidden} ${trigger().getAttribute("aria-expanded")}`);
      });

      trigger().click();

      expect(states).toEqual(["false true"]);
      expect(capture.seen[0]?.bubbles).toBe(true);
      expect(capture.seen[0]?.cancelable).toBe(false);
    });

    it("reports an arrow-key open as user", () => {
      pressKey(trigger(), "ArrowDown", { bubbles: true });

      expect(capture.reasons()).toEqual(["user"]);
    });

    it("reports a call with no DOM event as api", () => {
      controller().open();
      controller().close();

      expect(capture.reasons()).toEqual(["api", "api"]);
    });

    it("reports activating an item as select", () => {
      trigger().click();
      capture.clear();

      items()[1]?.click();

      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["select"]);
    });

    it("reports an outside click as outside", () => {
      trigger().click();
      capture.clear();

      (document.getElementById("outside") as HTMLElement).click();

      expect(capture.reasons()).toEqual(["outside"]);
    });

    it("reports Escape as escape", () => {
      trigger().click();
      capture.clear();

      pressKey(items()[0] as HTMLElement, "Escape", { bubbles: true });

      expect(capture.reasons()).toEqual(["escape"]);
    });

    it("reports the deferred Tab close as focus", async () => {
      trigger().click();
      capture.clear();

      pressKey(items()[0] as HTMLElement, "Tab", { bubbles: true });
      expect(capture.seen).toEqual([]);
      await tick();

      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["focus"]);
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
        <div data-controller="stimeo--menu">
          <button id="menu-trigger" data-stimeo--menu-target="trigger"
                  aria-haspopup="menu" aria-expanded="true" aria-controls="menu">Actions</button>
          <ul id="menu" role="menu" data-stimeo--menu-target="menu"></ul>
        </div>`;
      const fresh = captureStateEvents("stimeo--menu");
      application = Application.start();
      application.register("stimeo--menu", MenuController);
      await tick();

      expect(menu().hidden).toBe(true);
      expect(fresh.seen).toEqual([]);
      fresh.stop();
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

  // --- Re-entry from a subscriber ---

  describe("re-entry from a subscriber", () => {
    it("leaves no focus inside the menu when the open handler closes it again", () => {
      const instance = application.getControllerForElementAndIdentifier(root(), "stimeo--menu");
      if (!(instance instanceof MenuController)) throw new Error("menu controller not found");
      root().addEventListener("stimeo--menu:open", () => instance.close());

      trigger().click();

      expect(menu().hidden).toBe(true);
      expect(menu().contains(document.activeElement)).toBe(false);
    });

    it("leaves no focus on the last item when ArrowUp opens and the handler closes", () => {
      const instance = application.getControllerForElementAndIdentifier(root(), "stimeo--menu");
      if (!(instance instanceof MenuController)) throw new Error("menu controller not found");
      root().addEventListener("stimeo--menu:open", () => instance.close());

      pressKey(trigger(), "ArrowUp", { bubbles: true });

      expect(menu().hidden).toBe(true);
      expect(menu().contains(document.activeElement)).toBe(false);
    });
  });
});

describe("MenuController disabled items", () => {
  let application: Application;

  beforeEach(async () => {
    // The first item and "Delete" are aria-disabled and remain discoverable by
    // roving focus. Only the natively disabled "Archive" is skipped.
    document.body.innerHTML = `
      <div data-controller="stimeo--menu">
        <button id="menu-trigger" data-stimeo--menu-target="trigger"
                data-action="click->stimeo--menu#toggle keydown->stimeo--menu#onTriggerKeydown"
                aria-haspopup="menu" aria-expanded="false" aria-controls="menu">Actions</button>
        <ul id="menu" role="menu" aria-labelledby="menu-trigger"
            data-stimeo--menu-target="menu" hidden>
          <li role="none"><button role="menuitem" tabindex="-1" aria-disabled="true"
              data-stimeo--menu-target="item"
              data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">Edit</button></li>
          <li role="none"><button role="menuitem" tabindex="-1"
              data-stimeo--menu-target="item"
              data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">Duplicate</button></li>
          <li role="none"><button role="menuitem" tabindex="-1" aria-disabled="true"
              data-stimeo--menu-target="item"
              data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">Delete</button></li>
          <li role="none"><button role="menuitem" tabindex="-1" disabled
              data-stimeo--menu-target="item"
              data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">Archive</button></li>
          <li role="none"><button role="menuitem" tabindex="-1"
              data-stimeo--menu-target="item"
              data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">Rename</button></li>
        </ul>
      </div>`;
    application = Application.start();
    application.register("stimeo--menu", MenuController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const trigger = () =>
    document.querySelector<HTMLButtonElement>(
      "[data-stimeo--menu-target='trigger']",
    ) as HTMLButtonElement;
  const items = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("[data-stimeo--menu-target='item']"));
  const menu = () => document.getElementById("menu") as HTMLElement;
  const itemKey = (index: number, key: string) =>
    !pressKey(items()[index] as HTMLElement, key, { bubbles: true }).defaultPrevented;

  it("keeps an aria-disabled first item in the roving order", () => {
    trigger().click();
    expect(document.activeElement).toBe(items()[0]); // Edit (aria-disabled)
  });

  it("reaches aria-disabled with ArrowDown and blocks its synthesized Enter click", () => {
    trigger().click();
    const disabledItem = items()[2] as HTMLButtonElement;
    let consumerActivations = 0;
    disabledItem.addEventListener("click", () => consumerActivations++);
    items()[1]?.focus();

    itemKey(1, "ArrowDown");
    pressKey(disabledItem, "Enter", { bubbles: true, cancelable: true });
    disabledItem.click(); // happy-dom does not synthesize click from Enter

    expect(document.activeElement).toBe(disabledItem);
    expect(consumerActivations).toBe(0);
    expect(menu().hidden).toBe(false);
  });

  it("skips a natively disabled item when wrapping with ArrowUp", () => {
    trigger().click(); // open, focus aria-disabled Edit (index 0)
    itemKey(0, "ArrowUp"); // wrap past native-disabled Archive → Rename
    expect(document.activeElement).toBe(items()[4]); // Rename
  });

  it("focuses the last navigable item on ArrowUp from the trigger", () => {
    pressKey(trigger(), "ArrowUp", { bubbles: true });
    expect(document.activeElement).toBe(items()[4]); // Rename, not the disabled Archive
  });

  it("End jumps to the last navigable item, Home to the first", () => {
    trigger().click();
    itemKey(0, "End");
    expect(document.activeElement).toBe(items()[4]); // Rename
    itemKey(4, "Home");
    expect(document.activeElement).toBe(items()[0]); // Edit (aria-disabled)
  });

  it("blocks aria-disabled click activation before the handlers inside the controller element", () => {
    trigger().click();
    const disabledItem = items()[2] as HTMLButtonElement;
    let consumerActivations = 0;
    disabledItem.addEventListener("click", () => consumerActivations++);

    disabledItem.click();

    expect(consumerActivations).toBe(0);
    expect(menu().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("cancels the default action of a click on an aria-disabled item", () => {
    trigger().click();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });

    items()[2]?.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
  });

  it("removes the disabled-item activation blocker on disconnect", () => {
    const disabledItem = items()[2] as HTMLButtonElement;
    let consumerActivations = 0;
    disabledItem.addEventListener("click", () => consumerActivations++);
    const root = document.querySelector("[data-controller='stimeo--menu']") as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(root, "stimeo--menu");
    if (!controller) throw new Error("menu controller not found");

    controller.disconnect();
    disabledItem.click();

    expect(consumerActivations).toBe(1);
  });

  /**
   * `activate` refuses an item that cannot be activated on every path that reaches it.
   * A refused call leaves the menu open, dispatches nothing, moves no focus and leaves
   * the event unclaimed. The click is the reference row: the capture pass stops it on
   * an `aria-disabled` item and the platform does not deliver it to a natively disabled
   * one. A `probe` event stands for any other binding, read on the item itself and on
   * an ancestor it bubbles to.
   */
  describe("activation refused on every path", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    beforeEach(() => {
      capture = captureStateEvents("stimeo--menu");
    });

    afterEach(() => {
      capture.stop();
    });

    const routes = ["click", "probe on the item", "probe bubbled to the menu"] as const;
    type Route = (typeof routes)[number];

    /** The fixture item for each constraint; a `hidden` item is made so here. */
    const constrained = {
      "aria-disabled": () => items()[2] as HTMLButtonElement,
      "natively disabled": () => items()[3] as HTMLButtonElement,
      hidden: () => {
        const item = items()[4] as HTMLButtonElement;
        item.hidden = true;
        return item;
      },
    } as const;
    type Constraint = keyof typeof constrained;
    const constraints = Object.keys(constrained) as Constraint[];

    const root = () => menu().parentElement as HTMLElement;

    const controller = () => {
      const instance = application.getControllerForElementAndIdentifier(root(), "stimeo--menu");
      if (!(instance instanceof MenuController)) throw new Error("menu controller not found");
      return instance;
    };

    /** Delivers one gesture on `item` along `route` and returns the event dispatched. */
    const deliver = (route: Route, item: HTMLButtonElement): Event => {
      if (route === "click") {
        const click = new MouseEvent("click", { bubbles: true, cancelable: true });
        item.dispatchEvent(click);
        return click;
      }
      const receiver = route === "probe on the item" ? item : menu();
      receiver.addEventListener("probe", (event) => controller().activate(event), { once: true });
      const probe = new Event("probe", { bubbles: true, cancelable: true });
      item.dispatchEvent(probe);
      return probe;
    };

    const expectClosedBySelect = () => {
      expect(menu().hidden).toBe(true);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["select"]);
      expect(document.activeElement).toBe(trigger());
    };

    it.each(routes)("closes as select for an enabled item reached by %s", (route) => {
      trigger().click();
      capture.clear();

      const event = deliver(route, items()[1] as HTMLButtonElement);

      expectClosedBySelect();
      expect(event.defaultPrevented).toBe(false);
    });

    it.each(
      constraints.flatMap((constraint) => routes.map((route) => [constraint, route] as const)),
    )("does nothing for the %s item reached by %s", (constraint, route) => {
      const item = constrained[constraint]();
      trigger().click();
      const focused = document.activeElement;
      capture.clear();
      const above = vi.fn();
      root().addEventListener("probe", above);

      const event = deliver(route, item);

      root().removeEventListener("probe", above);
      expect(menu().hidden).toBe(false);
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(capture.seen).toEqual([]);
      expect(document.activeElement).toBe(focused);
      // Only the capture pass cancels anything, and only a click on an aria-disabled item.
      expect(event.defaultPrevented).toBe(route === "click" && constraint === "aria-disabled");
      // A refused probe still bubbles past its receiver to the controller element.
      expect(above).toHaveBeenCalledTimes(route === "click" ? 0 : 1);
    });

    it("closes as select for a call with no event while an aria-disabled item has focus", () => {
      trigger().click();
      expect(document.activeElement).toBe(items()[0]);
      capture.clear();

      controller().activate();

      expectClosedBySelect();
    });

    it("closes as select for an event that resolves to no item", () => {
      trigger().click();
      capture.clear();
      menu().addEventListener("probe", (event) => controller().activate(event), { once: true });

      menu().dispatchEvent(new Event("probe", { bubbles: true }));

      expectClosedBySelect();
    });

    it("leaves a refused event unclaimed for a later action that finds the item enabled", () => {
      const item = constrained.hidden();
      trigger().click();
      capture.clear();
      // The item's own action refuses the hidden item; its row then shows the item, and
      // the menu's action, reached later by the same event, finds it enabled.
      item.addEventListener("probe", (event) => controller().activate(event), { once: true });
      (item.parentElement as HTMLElement).addEventListener(
        "probe",
        () => {
          item.hidden = false;
        },
        { once: true },
      );
      menu().addEventListener("probe", (event) => controller().activate(event), { once: true });

      item.dispatchEvent(new Event("probe", { bubbles: true }));

      expectClosedBySelect();
    });

    it("keeps refusing a click that started on a hidden item once its row shows it", () => {
      const item = constrained.hidden();
      trigger().click();
      const focused = document.activeElement;
      capture.clear();
      // The row handler runs after the item's own action and before the delegate; both
      // act on the verdict the capture pass took when the click started.
      (item.parentElement as HTMLElement).addEventListener(
        "click",
        () => {
          item.hidden = false;
        },
        { once: true },
      );

      item.click();

      expect(menu().hidden).toBe(false);
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(capture.seen).toEqual([]);
      expect(document.activeElement).toBe(focused);
    });

    it("judges the item a click started on even when its handler detaches it", () => {
      const item = constrained.hidden();
      trigger().click();
      const focused = document.activeElement;
      capture.clear();
      // A detached target resolves to no item; the delegate still reads the one the
      // capture pass recorded, which refuses activation.
      item.addEventListener("click", () => item.remove(), { once: true });

      item.click();

      expect(menu().hidden).toBe(false);
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(capture.seen).toEqual([]);
      expect(document.activeElement).toBe(focused);
    });
  });
});

/**
 * A click is judged once, in the capture pass, before the handlers inside the
 * controller element run, and every path that activates on that click acts on that
 * verdict when the item it resolves is among those the verdict was taken for. A consumer
 * handler that marks the item unavailable while the click runs — a guard against a
 * second submission — therefore does not take back the activation the click started. An
 * item the verdict was not taken for — a handler moved the target into another item — is
 * judged when the action runs, as is any other event.
 */
describe("MenuController activation judged when a click starts", () => {
  let application: Application;
  let capture: ReturnType<typeof captureStateEvents>;

  beforeEach(async () => {
    // The items carry no click action of their own; a test binds one after its own
    // handler, so that handler runs first on the item.
    document.body.innerHTML = `
      <div data-controller="stimeo--menu">
        <button id="menu-trigger" data-stimeo--menu-target="trigger"
                data-action="click->stimeo--menu#toggle keydown->stimeo--menu#onTriggerKeydown"
                aria-haspopup="menu" aria-expanded="false" aria-controls="menu">File</button>
        <ul id="menu" role="menu" aria-labelledby="menu-trigger"
            data-stimeo--menu-target="menu" hidden>
          <li role="none"><button id="save" role="menuitem" tabindex="-1"
              data-stimeo--menu-target="item"><span id="save-label">Save</span></button></li>
          <li role="none"><button id="export" role="menuitem" tabindex="-1" aria-disabled="true"
              data-stimeo--menu-target="item">Export</button></li>
          <li role="none"><button id="print" role="menuitem" tabindex="-1"
              data-stimeo--menu-target="item">Print</button></li>
        </ul>
      </div>`;
    application = Application.start();
    application.register("stimeo--menu", MenuController);
    await tick();
    capture = captureStateEvents("stimeo--menu");
  });

  afterEach(() => {
    capture.stop();
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const trigger = () => document.getElementById("menu-trigger") as HTMLButtonElement;
  const menu = () => document.getElementById("menu") as HTMLElement;
  const save = () => document.getElementById("save") as HTMLButtonElement;
  const row = () => save().parentElement as HTMLElement;

  const controller = () => {
    const instance = application.getControllerForElementAndIdentifier(
      menu().parentElement as HTMLElement,
      "stimeo--menu",
    );
    if (!(instance instanceof MenuController)) throw new Error("menu controller not found");
    return instance;
  };

  const paths = ["the delegate", "the item's own action"] as const;
  type Path = (typeof paths)[number];

  const marks = {
    disabled: (item: HTMLButtonElement) => {
      item.disabled = true;
    },
    "aria-disabled": (item: HTMLButtonElement) => item.setAttribute("aria-disabled", "true"),
  } as const;
  type Mark = keyof typeof marks;
  const markNames = Object.keys(marks) as Mark[];

  /**
   * Readies `path` on Save after `handler` was added, so the handler runs first on the
   * item. For the item's own action the row keeps the click from the delegate, so that
   * action decides alone.
   */
  const wire = async (path: Path, handler: (event: Event) => void): Promise<void> => {
    save().addEventListener("click", handler);
    if (path === "the delegate") return;
    save().setAttribute("data-action", "click->stimeo--menu#activate");
    await tick();
    row().addEventListener("click", (event) => event.stopPropagation());
  };

  const expectClosedBySelect = () => {
    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(capture.names()).toEqual(["close"]);
    expect(capture.reasons()).toEqual(["select"]);
    expect(document.activeElement).toBe(trigger());
  };

  const expectUntouched = (focused: Element | null) => {
    expect(menu().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(capture.seen).toEqual([]);
    expect(document.activeElement).toBe(focused);
  };

  it.each(markNames.flatMap((mark) => paths.map((path) => [mark, path] as const)))(
    "closes as select when a handler marks the item %s during its click, through %s",
    async (mark, path) => {
      const command = vi.fn(() => marks[mark](save()));
      await wire(path, command);
      trigger().click();
      capture.clear();

      save().click();

      expect(command).toHaveBeenCalledOnce();
      expectClosedBySelect();
    },
  );

  it.each(paths)("closes as select through %s when the handler changes nothing", async (path) => {
    const command = vi.fn();
    await wire(path, command);
    trigger().click();
    capture.clear();

    save().click();

    expect(command).toHaveBeenCalledOnce();
    expectClosedBySelect();
  });

  it.each(paths)(
    "keeps refusing through %s a click that started on a hidden item a handler shows",
    async (path) => {
      const command = vi.fn(() => {
        save().hidden = false;
      });
      await wire(path, command);
      trigger().click();
      save().hidden = true;
      const focused = document.activeElement;
      capture.clear();

      save().click();

      expect(command).toHaveBeenCalledOnce();
      expectUntouched(focused);
    },
  );

  it.each(markNames)(
    "refuses a probe whose handler marks the item %s before the action runs",
    (mark) => {
      trigger().click();
      const focused = document.activeElement;
      capture.clear();
      save().addEventListener("probe", () => marks[mark](save()));
      save().addEventListener("probe", (event) => controller().activate(event));

      save().dispatchEvent(new Event("probe", { bubbles: true }));

      expectUntouched(focused);
    },
  );

  it.each([
    ["refuses", "an aria-disabled", "export"],
    ["closes for", "an enabled", "print"],
  ] as const)(
    "%s %s item a handler moves the click target into before the item's own action",
    async (outcome, _state, destination) => {
      const label = document.getElementById("save-label") as HTMLElement;
      // The capture pass judged Save; the action then resolves the item the target now
      // lies in, which it judges when it runs.
      label.addEventListener("click", () => document.getElementById(destination)?.append(label));
      await wire("the item's own action", () => {});
      trigger().click();
      const focused = document.activeElement;
      capture.clear();

      label.click();

      if (outcome === "refuses") expectUntouched(focused);
      else expectClosedBySelect();
    },
  );
});

/**
 * Items nested in one another. An activation is refused when any item this menu owns
 * that holds the event's target refuses it, so a `hidden`, natively `disabled` or
 * `aria-disabled` inner item refuses what lands inside it on every path — the delegate,
 * an action on either item, or one on the menu — and an outer item that refuses refuses
 * what lands inside it too. A click any `aria-disabled` item holds is stopped before
 * the handlers inside the controller element run. What lands on the outer item
 * outside the inner one is judged on the outer item alone.
 */
describe("MenuController with a nested item pair", () => {
  let application: Application;

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const trigger = () => byId("menu-trigger");
  const menu = () => byId("menu");

  const controller = () => {
    const instance = application.getControllerForElementAndIdentifier(
      menu().parentElement as HTMLElement,
      "stimeo--menu",
    );
    if (!(instance instanceof MenuController)) throw new Error("menu controller not found");
    return instance;
  };

  /** Mounts the pair, with `inner` and `outer` as the attributes each item carries. */
  const mountPair = async (inner: string, outer: string, innerActions = ""): Promise<void> => {
    document.body.innerHTML = `
      <div data-controller="stimeo--menu">
        <button id="menu-trigger" data-stimeo--menu-target="trigger"
                data-action="click->stimeo--menu#toggle keydown->stimeo--menu#onTriggerKeydown"
                aria-haspopup="menu" aria-expanded="false" aria-controls="menu">File</button>
        <div id="menu" role="menu" aria-labelledby="menu-trigger"
             data-stimeo--menu-target="menu" hidden>
          <div id="outer" role="menuitem" tabindex="-1" ${outer} data-stimeo--menu-target="item">
            <button id="inner" role="menuitem" tabindex="-1" ${inner} ${innerActions}
                    data-stimeo--menu-target="item"><span id="label">Run</span></button>
          </div>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--menu", MenuController);
    await tick();
  };

  it("swallows a click on the aria-disabled inner item", async () => {
    await mountPair(
      'aria-disabled="true"',
      "",
      'data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown"',
    );
    trigger().click();
    const inner = byId("inner");
    const command = vi.fn();
    inner.addEventListener("click", command);
    const capture = captureStateEvents("stimeo--menu");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });

    inner.dispatchEvent(click);
    capture.stop();

    expect(command).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(true);
    expect(capture.names()).toEqual([]);
    expect(menu().hidden).toBe(false);
  });

  /** The state the inner item carries; `enabled` with an enabled outer is the positive control. */
  const INNER = {
    enabled: "",
    "aria-disabled": 'aria-disabled="true"',
    hidden: "hidden",
    disabled: "disabled",
  } as const;
  type Inner = keyof typeof INNER;

  /** The state the outer item carries; its `aria-disabled` reaches the inner item too. */
  const OUTER = { enabled: "", "aria-disabled": 'aria-disabled="true"', hidden: "hidden" } as const;
  type Outer = keyof typeof OUTER;

  /**
   * Where an event lands and what receives it: the delegate on the controller element,
   * or an action on an item or on the menu. `label` is the text holder inside the inner
   * item. A natively `disabled` button is dispatched no click of its own, while happy-dom
   * delivers one dispatched on content inside it, so a click inside the inner item lands
   * on the label.
   */
  const ROUTES = {
    "a click inside the inner, through the delegate": {
      kind: "click",
      at: "label",
      receiver: "delegate",
    },
    "a click inside the inner, received by the inner": {
      kind: "click",
      at: "label",
      receiver: "inner",
    },
    "a click inside the inner, received by the outer": {
      kind: "click",
      at: "label",
      receiver: "outer",
    },
    "a probe inside the inner, received by the inner": {
      kind: "probe",
      at: "label",
      receiver: "inner",
    },
    "a probe inside the inner, received by the outer": {
      kind: "probe",
      at: "label",
      receiver: "outer",
    },
    "a probe inside the inner, received by the menu": {
      kind: "probe",
      at: "label",
      receiver: "menu",
    },
    "a click on the outer, through the delegate": {
      kind: "click",
      at: "outer",
      receiver: "delegate",
    },
    "a probe on the outer": { kind: "probe", at: "outer", receiver: "outer" },
  } as const;
  type Route = keyof typeof ROUTES;

  /** Whether `route` lands inside the inner item. */
  const insideInner = (route: Route): boolean => ROUTES[route].at !== "outer";

  /** Whether an item holding the route's target refuses activation. */
  const refuses = (inner: Inner, outer: Outer, route: Route): boolean =>
    outer !== "enabled" || (insideInner(route) && inner !== "enabled");

  /** Whether the capture pass stops `route`: a click an `aria-disabled` item holds. */
  const stops = (inner: Inner, outer: Outer, route: Route): boolean =>
    ROUTES[route].kind === "click" &&
    (outer === "aria-disabled" || (insideInner(route) && inner === "aria-disabled"));

  const ROWS = (Object.keys(INNER) as Inner[]).flatMap((inner) =>
    (Object.keys(OUTER) as Outer[]).flatMap((outer) =>
      (Object.keys(ROUTES) as Route[]).map((route) => ({
        inner,
        outer,
        route,
        outcome: refuses(inner, outer, route) ? "refuses" : "activates",
      })),
    ),
  );

  /**
   * Delivers `route`. A consumer command listens where the event lands, so a click the
   * capture pass stops shows as a command that never ran. A click received by an item
   * goes no further than the menu, so that item's action decides alone.
   */
  const deliver = (route: Route) => {
    const { kind, at, receiver } = ROUTES[route];
    const command = vi.fn();
    byId(at).addEventListener(kind, command);
    if (receiver !== "delegate") {
      byId(receiver).addEventListener(kind, (event) => controller().activate(event));
      if (kind === "click") menu().addEventListener("click", (event) => event.stopPropagation());
    }
    const event =
      kind === "click"
        ? new MouseEvent("click", { bubbles: true, cancelable: true })
        : new Event("probe", { bubbles: true, cancelable: true });
    byId(at).dispatchEvent(event);
    return { event, command };
  };

  it.each(ROWS)(
    "$outcome the $inner inner item in the $outer outer item through $route",
    async ({ inner, outer, route }) => {
      await mountPair(INNER[inner], OUTER[outer]);
      trigger().click();
      const focused = document.activeElement;
      const capture = captureStateEvents("stimeo--menu");

      const { event, command } = deliver(route);
      capture.stop();

      const stopped = stops(inner, outer, route);
      expect(event.defaultPrevented).toBe(stopped);
      expect(command).toHaveBeenCalledTimes(stopped ? 0 : 1);
      if (refuses(inner, outer, route)) {
        expect(capture.seen).toEqual([]);
        expect(menu().hidden).toBe(false);
        expect(trigger().getAttribute("aria-expanded")).toBe("true");
        expect(document.activeElement).toBe(focused);
      } else {
        expect(capture.names()).toEqual(["close"]);
        expect(capture.reasons()).toEqual(["select"]);
        expect(menu().hidden).toBe(true);
        expect(document.activeElement).toBe(trigger());
      }
    },
  );
});

/**
 * `aria-disabled="true"` on an ancestor disables the items inside it, as ARIA defines the
 * state for every focusable descendant: a click on such an item is stopped before the
 * handlers inside the controller element run, and any other event is refused. The
 * items stay in the roving order.
 */
describe("MenuController aria-disabled inherited from an ancestor", () => {
  let application: Application;
  let capture: ReturnType<typeof captureStateEvents>;

  beforeEach(async () => {
    document.body.innerHTML = `
      <section id="outer">
        <div id="root" data-controller="stimeo--menu">
          <button id="menu-trigger" data-stimeo--menu-target="trigger"
                  data-action="click->stimeo--menu#toggle keydown->stimeo--menu#onTriggerKeydown"
                  aria-haspopup="menu" aria-expanded="false" aria-controls="menu">Edit</button>
          <div id="menu" role="menu" aria-labelledby="menu-trigger"
               data-stimeo--menu-target="menu" hidden>
            <div id="group" role="group" aria-label="Clipboard">
              <button id="cut" role="menuitem" tabindex="-1"
                      data-stimeo--menu-target="item">Cut</button>
              <button id="copy" role="menuitem" tabindex="-1"
                      data-stimeo--menu-target="item">Copy</button>
            </div>
            <button id="rename" role="menuitem" tabindex="-1"
                    data-stimeo--menu-target="item">Rename</button>
          </div>
        </div>
      </section>`;
    application = Application.start();
    application.register("stimeo--menu", MenuController);
    await tick();
    capture = captureStateEvents("stimeo--menu");
  });

  afterEach(() => {
    capture.stop();
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const trigger = () => byId("menu-trigger") as HTMLButtonElement;
  const menu = () => byId("menu");

  const controller = () => {
    const instance = application.getControllerForElementAndIdentifier(byId("root"), "stimeo--menu");
    if (!(instance instanceof MenuController)) throw new Error("menu controller not found");
    return instance;
  };

  const ancestors = ["group", "menu", "root", "outer"] as const;
  const routes = ["click", "probe on the item", "probe bubbled to the menu"] as const;
  type Route = (typeof routes)[number];

  /** Delivers one gesture on `item` along `route` and returns the event dispatched. */
  const deliver = (route: Route, item: HTMLElement): Event => {
    if (route === "click") {
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      item.dispatchEvent(click);
      return click;
    }
    const receiver = route === "probe on the item" ? item : menu();
    receiver.addEventListener("probe", (event) => controller().activate(event), { once: true });
    const probe = new Event("probe", { bubbles: true, cancelable: true });
    item.dispatchEvent(probe);
    return probe;
  };

  const expectClosedBySelect = () => {
    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(capture.names()).toEqual(["close"]);
    expect(capture.reasons()).toEqual(["select"]);
    expect(document.activeElement).toBe(trigger());
  };

  /** Opens the menu with focus on `item`, then forgets the open. */
  const openOn = (item: HTMLElement) => {
    controller().open();
    item.focus();
    capture.clear();
  };

  it.each(ancestors.flatMap((ancestor) => routes.map((route) => [ancestor, route] as const)))(
    "refuses an item under an aria-disabled #%s reached by %s",
    (ancestor, route) => {
      byId(ancestor).setAttribute("aria-disabled", "true");
      const copy = byId("copy");
      openOn(copy);
      const command = vi.fn();
      copy.addEventListener("click", command);
      const above = vi.fn();
      byId("root").addEventListener("probe", above);

      const event = deliver(route, copy);

      byId("root").removeEventListener("probe", above);
      expect(menu().hidden).toBe(false);
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(capture.seen).toEqual([]);
      expect(document.activeElement).toBe(copy);
      // The capture pass stops the click before the consumer's handler and cancels it.
      expect(command).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(route === "click");
      expect(above).toHaveBeenCalledTimes(route === "click" ? 0 : 1);
    },
  );

  it.each(routes)("activates an item outside the aria-disabled group reached by %s", (route) => {
    byId("group").setAttribute("aria-disabled", "true");
    openOn(byId("rename"));

    const event = deliver(route, byId("rename"));

    expectClosedBySelect();
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(ancestors.flatMap((ancestor) => routes.map((route) => [ancestor, route] as const)))(
    'activates an item under #%s carrying aria-disabled="false" reached by %s',
    (ancestor, route) => {
      byId(ancestor).setAttribute("aria-disabled", "false");
      openOn(byId("copy"));

      deliver(route, byId("copy"));

      expectClosedBySelect();
    },
  );

  it("keeps the items of an aria-disabled group in the roving order", () => {
    byId("group").setAttribute("aria-disabled", "true");
    trigger().click();
    expect(document.activeElement).toBe(byId("cut"));

    pressKey(byId("cut"), "ArrowDown", { bubbles: true });
    expect(document.activeElement).toBe(byId("copy"));
    pressKey(byId("copy"), "ArrowDown", { bubbles: true });
    expect(document.activeElement).toBe(byId("rename"));
    pressKey(byId("rename"), "Home", { bubbles: true });
    expect(document.activeElement).toBe(byId("cut"));
    pressKey(byId("cut"), "End", { bubbles: true });
    expect(document.activeElement).toBe(byId("rename"));
  });
});

/**
 * Item handling is delegated from the controller element, so membership in the
 * `item` target is enough — no per-element `data-action` required. This is what
 * makes an item that only becomes one at runtime (`stimeo--overflow-menu` banks
 * toolbar controls into a menu the author never wrote them inside) operable.
 */
describe("MenuController delegated item handling", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--menu">
        <button id="menu-trigger" data-stimeo--menu-target="trigger"
                data-action="click->stimeo--menu#toggle keydown->stimeo--menu#onTriggerKeydown"
                aria-haspopup="menu" aria-expanded="false" aria-controls="menu">Actions</button>
        <ul id="menu" role="menu" aria-labelledby="menu-trigger"
            data-stimeo--menu-target="menu" hidden>
          <li role="none"><button role="menuitem" tabindex="-1"
              data-stimeo--menu-target="item">Edit</button></li>
          <li role="none"><button role="menuitem" tabindex="-1"
              data-stimeo--menu-target="item"><span id="label" tabindex="-1">Duplicate</span></button></li>
          <li role="none"><button role="menuitem" tabindex="-1"
              data-stimeo--menu-target="item">Delete</button></li>
        </ul>
      </div>`;
    application = Application.start();
    application.register("stimeo--menu", MenuController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const trigger = () => document.getElementById("menu-trigger") as HTMLButtonElement;
  const menu = () => document.getElementById("menu") as HTMLElement;
  const items = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("[data-stimeo--menu-target='item']"));
  const key = (el: HTMLElement, k: string) =>
    !pressKey(el, k, { bubbles: true, cancelable: true }).defaultPrevented;

  it("moves roving focus from an item that has no per-element action", () => {
    trigger().click();
    expect(document.activeElement).toBe(items()[0]);

    key(items()[0] as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(items()[1]);

    key(items()[1] as HTMLElement, "ArrowUp");
    expect(document.activeElement).toBe(items()[0]);
  });

  it("jumps to the last item on End without a per-element action", () => {
    trigger().click();
    key(items()[0] as HTMLElement, "End");
    expect(document.activeElement).toBe(items()[2]);
  });

  it("resolves the owning item when the key starts on a descendant", () => {
    trigger().click();
    const label = document.getElementById("label") as HTMLElement;
    key(label, "ArrowDown"); // the span inside item 1, not the item itself
    expect(document.activeElement).toBe(items()[2]);
  });

  it("activates and closes from an item that has no per-element action", () => {
    trigger().click();
    (items()[1] as HTMLButtonElement).click();

    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });

  it("operates an item appended after connect", async () => {
    trigger().click();
    const li = document.createElement("li");
    li.setAttribute("role", "none");
    li.innerHTML = `<button id="added" role="menuitem" tabindex="-1"
        data-stimeo--menu-target="item">Archive</button>`;
    menu().appendChild(li);
    await tick(); // Stimulus registers the new target

    const added = document.getElementById("added") as HTMLButtonElement;
    key(items()[2] as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(added);

    added.click();
    expect(menu().hidden).toBe(true);
  });

  it("yields a delegated item key already consumed by a descendant", () => {
    trigger().click();
    const label = document.getElementById("label") as HTMLElement;
    label.addEventListener("keydown", (event) => event.preventDefault());
    (items()[1] as HTMLButtonElement).focus();

    key(label, "ArrowDown");
    expect(document.activeElement).toBe(label); // the descendant kept the key
  });

  it("closes when an item removes itself in its own click handler", () => {
    trigger().click();
    const item = items()[1] as HTMLButtonElement;
    // A command whose consumer handler detaches the row it lives in is an ordinary
    // path. The delegate must not lose the activation just because the node is gone
    // by the time the click reaches the controller element.
    item.addEventListener("click", () => item.remove());

    item.click();

    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });

  it("closes when a descendant of the item detaches the item mid-click", () => {
    trigger().click();
    const item = items()[1] as HTMLButtonElement;
    const label = document.getElementById("label") as HTMLElement;
    label.addEventListener("click", () => item.remove());

    label.click();

    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("does not treat the trigger as an item", () => {
    trigger().click(); // toggle opens; the delegate must not also activate and close
    expect(menu().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("does not close on a click that lands on the menu itself", () => {
    trigger().click();
    menu().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menu().hidden).toBe(false);
  });

  it("stops handling item keys after disconnect", () => {
    trigger().click();
    const root = document.querySelector("[data-controller='stimeo--menu']") as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(root, "stimeo--menu");
    if (!controller) throw new Error("menu controller not found");

    controller.disconnect();
    const unclaimed = key(items()[0] as HTMLElement, "ArrowDown");

    expect(unclaimed).toBe(true);
    expect(document.activeElement).toBe(items()[0]);
  });
});

/**
 * The per-element form is supported as well. What "both bindings" means differs by
 * event: a focus-moving key is claimed through `preventDefault()` by whichever
 * handler runs first, so it runs once; `activate` claims the click event itself, so
 * one gesture activates once. These pin both halves of that contract.
 */
describe("MenuController per-element and delegated bindings together", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--menu">
        <button id="menu-trigger" data-stimeo--menu-target="trigger"
                data-action="click->stimeo--menu#toggle keydown->stimeo--menu#onTriggerKeydown"
                aria-haspopup="menu" aria-expanded="false" aria-controls="menu">Actions</button>
        <ul id="menu" role="menu" aria-labelledby="menu-trigger"
            data-stimeo--menu-target="menu" hidden>
          <li role="none"><button role="menuitem" tabindex="-1"
              data-stimeo--menu-target="item"
              data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">Edit</button></li>
          <li role="none"><button role="menuitem" tabindex="-1"
              data-stimeo--menu-target="item"
              data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">Duplicate</button></li>
          <li role="none"><button role="menuitem" tabindex="-1"
              data-stimeo--menu-target="item"
              data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">Delete</button></li>
        </ul>
      </div>`;
    application = Application.start();
    application.register("stimeo--menu", MenuController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const trigger = () => document.getElementById("menu-trigger") as HTMLButtonElement;
  const menu = () => document.getElementById("menu") as HTMLElement;
  const items = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("[data-stimeo--menu-target='item']"));
  /** Cancelable, and returned, so the claim itself is assertable — not just its effect. */
  const key = (el: HTMLElement, k: string) => {
    const event = keyEvent(k, { bubbles: true, cancelable: true });
    pressKey(el, event);
    return event;
  };

  it("lets the action claim a focus-moving key so the delegate stands down", () => {
    trigger().click();
    const event = key(items()[0] as HTMLElement, "ArrowDown");
    // The claim is the mechanism the single step depends on; assert it directly, or
    // the step below would also pass with both handlers running on the same index.
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items()[1]); // not items()[2]
  });

  it("moves one step per ArrowUp with both bindings present", () => {
    trigger().click();
    key(items()[0] as HTMLElement, "ArrowUp");
    expect(document.activeElement).toBe(items()[2]); // wrapped once, not twice
  });

  it("defers the Tab close to a single pending task", async () => {
    trigger().click();
    const event = key(items()[0] as HTMLElement, "Tab");
    expect(event.defaultPrevented).toBe(false); // Tab is deliberately left unclaimed
    expect(menu().hidden).toBe(false); // still open in the same task
    await tick();
    expect(menu().hidden).toBe(true);
  });

  it("writes each public state hook exactly once per activation", async () => {
    trigger().click();
    const seen: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        seen.push(`${(record.target as Element).id}.${record.attributeName}`);
      }
    });
    observer.observe(menu(), { attributes: true, attributeFilter: ["hidden"] });
    observer.observe(trigger(), { attributes: true, attributeFilter: ["aria-expanded"] });

    items()[1]?.click();
    await tick();
    observer.disconnect();

    // `hidden` and `aria-expanded` are public state hooks: one gesture must produce
    // one write of each.
    expect(seen).toEqual(["menu.hidden", "menu-trigger.aria-expanded"]);
  });

  it("keeps a menu that a handler between the two paths opens again", () => {
    trigger().click();
    const controller = application.getControllerForElementAndIdentifier(
      menu().parentElement as HTMLElement,
      "stimeo--menu",
    );
    if (!(controller instanceof MenuController)) throw new Error("menu controller not found");
    // The handler sits on the item's row, so it runs after the per-element action and
    // before the delegate on the controller element.
    const row = items()[1]?.parentElement as HTMLElement;
    row.addEventListener("click", () => controller.open(), { once: true });

    items()[1]?.click();

    expect(menu().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("stays consistent when activate is reached on both paths", () => {
    trigger().click();
    // `activate` is reached twice here and claims the click on the first path, so
    // the second finds it claimed.
    items()[1]?.click();
    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });
});

describe("MenuController without a menu target", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--menu">
        <button id="menu-trigger" data-stimeo--menu-target="trigger"
                aria-haspopup="menu" aria-expanded="false">Actions</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--menu", MenuController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("keeps open, close and toggle inert and registers no Escape layer", () => {
    const root = document.querySelector<HTMLElement>(
      "[data-controller='stimeo--menu']",
    ) as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(root, "stimeo--menu");
    if (!(controller instanceof MenuController)) throw new Error("menu controller not found");

    expect(() => {
      controller.open();
      controller.toggle();
      controller.close();
    }).not.toThrow();

    const press = keyEvent("Escape", { bubbles: true, cancelable: true });
    // No menu target can own focus; the document probe checks that no layer registered.
    typeKey(document, press);
    expect(press.defaultPrevented).toBe(false);
  });
});
