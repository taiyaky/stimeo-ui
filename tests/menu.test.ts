import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MenuController } from "../src/controllers/menu_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
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
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(menu().hidden).toBe(false);
    expect(document.activeElement).toBe(items()[2]);
  });

  it("leaves a modified arrow on the trigger to the browser", () => {
    // A chorded arrow belongs to the browser, so the menu neither claims the press
    // nor opens. Cancelable, or `defaultPrevented` could not report the claim.
    trigger().focus();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    trigger().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });

  it("opens and focuses the first item on ArrowDown", () => {
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(menu().hidden).toBe(false);
    expect(document.activeElement).toBe(items()[0]);
  });

  it("does not handle Enter/Space on the trigger (left to the native button click)", () => {
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    // keydown alone does not open; the browser's synthesized click would.
    expect(menu().hidden).toBe(true);
  });

  it("leaves a modified arrow on an item to the browser", () => {
    // Both the per-element action and the delegated listener run this key, and
    // neither may claim it or move the roving focus.
    trigger().click(); // open, focus the first item
    expect(document.activeElement).toBe(items()[0]);

    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    items()[0]?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(items()[0]);
    expect(menu().hidden).toBe(false);
  });

  it("moves focus between items with ArrowDown (wrapping)", () => {
    trigger().click();
    items()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(items()[1]);
    items()[2]?.focus();
    items()[2]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(items()[0]);
  });

  it("closes on Escape and returns focus to the trigger", () => {
    trigger().click();
    items()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("defers Tab closing so the browser can move focus first", async () => {
    trigger().click();
    items()[0]?.focus();
    items()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    // Still open at the synchronous point: hiding the focused item before the
    // browser's default Tab action would restart traversal at the document head.
    expect(menu().hidden).toBe(false);
    await tick();
    expect(menu().hidden).toBe(true);
    // Tab lets focus move on naturally; it is not pulled back to the trigger.
    expect(document.activeElement).not.toBe(trigger());
  });

  it("discards a pending Tab close when the menu is reopened in the same task", async () => {
    trigger().click();
    items()[0]?.focus();
    items()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    trigger().click(); // close synchronously …
    trigger().click(); // … and reopen before the deferred close fires
    expect(menu().hidden).toBe(false);
    await tick();
    // The stale Tab close must not slam the reopened menu shut.
    expect(menu().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
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

    child.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );

    expect(document.activeElement).toBe(child);
  });

  it("yields a trigger key already consumed by a descendant", () => {
    const child = document.createElement("span");
    child.tabIndex = -1;
    trigger().appendChild(child);
    child.addEventListener("keydown", (event) => event.preventDefault());
    child.focus();

    child.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );

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
    items()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

    const controller = application.getControllerForElementAndIdentifier(root(), "stimeo--menu");
    if (!controller) throw new Error("menu controller not found");
    controller.disconnect();
    await tick();

    // The deferred close must not fire against a disconnected controller.
    expect(menu().hidden).toBe(false);
  });

  const itemKey = (index: number, key: string) =>
    items()[index]?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

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

  it("closes when the trigger is clicked a second time", () => {
    trigger().click();
    expect(menu().hidden).toBe(false);
    trigger().click(); // toggle → close
    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
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
    items()[index]?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

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
    disabledItem.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
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
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(items()[4]); // Rename, not the disabled Archive
  });

  it("End jumps to the last navigable item, Home to the first", () => {
    trigger().click();
    itemKey(0, "End");
    expect(document.activeElement).toBe(items()[4]); // Rename
    itemKey(4, "Home");
    expect(document.activeElement).toBe(items()[0]); // Edit (aria-disabled)
  });

  it("blocks aria-disabled click activation before consumer handlers", () => {
    trigger().click();
    const disabledItem = items()[2] as HTMLButtonElement;
    let consumerActivations = 0;
    disabledItem.addEventListener("click", () => consumerActivations++);

    disabledItem.click();

    expect(consumerActivations).toBe(0);
    expect(menu().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
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
});

/**
 * Item handling is delegated from the controller element, so membership in the
 * `item` target is enough — no per-element `data-action` required. This is what
 * makes an item that only becomes one at runtime (Overflow Menu banks toolbar
 * controls into a menu the author never wrote them inside) operable.
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
              data-stimeo--menu-target="item"><span id="label">Duplicate</span></button></li>
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
  const key = (el: Element, k: string) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

  it("moves roving focus from an item that has no per-element action", () => {
    trigger().click();
    expect(document.activeElement).toBe(items()[0]);

    key(items()[0] as Element, "ArrowDown");
    expect(document.activeElement).toBe(items()[1]);

    key(items()[1] as Element, "ArrowUp");
    expect(document.activeElement).toBe(items()[0]);
  });

  it("jumps to the last item on End without a per-element action", () => {
    trigger().click();
    key(items()[0] as Element, "End");
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
    key(items()[2] as Element, "ArrowDown");
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
    expect(document.activeElement).toBe(items()[1]); // the descendant kept the key
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
});

/**
 * The per-element form is supported as well. What "both bindings" means differs by
 * event: a focus-moving key is claimed by whichever handler runs first, so it runs
 * once; `activate` has no claim protocol and runs on both paths, which is safe only
 * while it stays idempotent. These pin both halves of that contract.
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
  const key = (el: Element, k: string) => {
    const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event;
  };

  it("lets the action claim a focus-moving key so the delegate stands down", () => {
    trigger().click();
    const event = key(items()[0] as Element, "ArrowDown");
    // The claim is the mechanism the single step depends on; assert it directly, or
    // the step below would also pass with both handlers running on the same index.
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items()[1]); // not items()[2]
  });

  it("moves one step per ArrowUp with both bindings present", () => {
    trigger().click();
    key(items()[0] as Element, "ArrowUp");
    expect(document.activeElement).toBe(items()[2]); // wrapped once, not twice
  });

  it("defers the Tab close to a single pending task", async () => {
    trigger().click();
    const event = key(items()[0] as Element, "Tab");
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

    // `hidden` and `aria-expanded` are public state hooks, so a second `close()`
    // is observable even though it lands on the same value: an identical reassign still
    // queues a MutationRecord. One gesture must produce one write of each.
    expect(seen).toEqual(["menu.hidden", "menu-trigger.aria-expanded"]);
  });

  it("stays consistent when activate runs on both paths", () => {
    trigger().click();
    // No claim protocol on click: `activate` runs twice here. The contract is that
    // the second pass is unobservable, not that it does not happen.
    items()[1]?.click();
    expect(menu().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });
});
