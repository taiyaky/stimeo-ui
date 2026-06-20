import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { MultiSelectController } from "../src/controllers/multi_select_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link MultiSelectController}: substring filtering with
 * activedescendant roving, multi toggle (`aria-selected` + chips), the `max`
 * cap, chip removal/Backspace, focus management, dismissal, and the
 * `change`/`filter` events.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const option = (value: string, label: string) => `
  <li id="ms-${value}" role="option" aria-selected="false" data-value="${value}"
      data-stimeo--multi-select-target="option"
      data-action="click->stimeo--multi-select#toggleOption">${label}</li>`;

const markup = (attrs = "") => `
  <div data-controller="stimeo--multi-select" ${attrs}>
    <ul data-stimeo--multi-select-target="tags" aria-label="Selected"></ul>
    <input type="text" role="combobox" aria-expanded="false" aria-autocomplete="list"
           aria-controls="ms-list" aria-activedescendant="" aria-label="Fruits"
           data-stimeo--multi-select-target="input"
           data-action="input->stimeo--multi-select#filter
                        keydown->stimeo--multi-select#onKeydown
                        focus->stimeo--multi-select#open" />
    <ul id="ms-list" role="listbox" aria-multiselectable="true" aria-label="Options" hidden
        data-stimeo--multi-select-target="list">
      ${option("apple", "Apple")}
      ${option("banana", "Banana")}
      ${option("cherry", "Cherry")}
    </ul>
    <span role="status" aria-live="polite" class="visually-hidden"
          data-stimeo--multi-select-target="status"></span>
    <template data-stimeo--multi-select-target="tagTemplate">
      <li data-stimeo--multi-select-target="tag">
        <span data-multi-select-slot="label"></span>
        <button type="button" tabindex="-1">×</button>
      </li>
    </template>
  </div>`;

describe("MultiSelectController", () => {
  let application: Application;

  const mount = async (attrs = "") => {
    document.body.innerHTML = markup(attrs);
    application = Application.start();
    application.register("stimeo--multi-select", MultiSelectController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--multi-select']") as HTMLElement;
  const input = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--multi-select-target='input']",
    ) as HTMLInputElement;
  const list = () =>
    document.querySelector<HTMLElement>("[data-stimeo--multi-select-target='list']") as HTMLElement;
  const options = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>("[data-stimeo--multi-select-target='option']"),
    );
  const tags = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--multi-select-target='tag']"));
  const buttons = () =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "[data-stimeo--multi-select-target='tags'] button",
      ),
    );
  const selected = () => options().map((o) => o.getAttribute("aria-selected"));
  const active = () => input().getAttribute("aria-activedescendant");
  const key = (k: string) =>
    input().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  const filterTo = (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("starts closed", async () => {
    await mount();
    expect(list().hidden).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("filters options by substring and dispatches filter", async () => {
    await mount();
    const queries: string[] = [];
    root().addEventListener("stimeo--multi-select:filter", (event) => {
      queries.push((event as CustomEvent).detail.query);
    });
    filterTo("an"); // matches Banana only
    expect(list().hidden).toBe(false);
    expect(options().map((o) => o.hidden)).toEqual([true, false, true]);
    expect(active()).toBe("ms-banana");
    expect(queries).toEqual(["an"]);
  });

  it("flags an empty result set", async () => {
    await mount();
    filterTo("zzz");
    expect(root().hasAttribute("data-stimeo--multi-select-empty")).toBe(true);
    expect(active()).toBeNull();
  });

  it("opens and moves the active option with arrows (wrapping)", async () => {
    await mount();
    key("ArrowDown"); // open, active apple
    expect(active()).toBe("ms-apple");
    key("ArrowDown");
    expect(active()).toBe("ms-banana");
    key("ArrowUp");
    expect(active()).toBe("ms-apple");
    key("ArrowUp"); // wrap to last
    expect(active()).toBe("ms-cherry");
    key("Home");
    expect(active()).toBe("ms-apple");
    key("End");
    expect(active()).toBe("ms-cherry");
  });

  it("toggles selection with Enter and keeps the list open, adding a chip", async () => {
    await mount();
    const changes: string[][] = [];
    root().addEventListener("stimeo--multi-select:change", (event) => {
      changes.push((event as CustomEvent).detail.values);
    });
    key("ArrowDown"); // active apple
    key("Enter"); // select apple
    expect(selected()).toEqual(["true", "false", "false"]);
    expect(list().hidden).toBe(false);
    expect(tags().map((t) => t.dataset.value)).toEqual(["apple"]);
    expect(buttons()[0]?.getAttribute("aria-label")).toBe("Remove Apple");
    key("Enter"); // toggle apple off
    expect(selected()).toEqual(["false", "false", "false"]);
    expect(tags()).toHaveLength(0);
    expect(changes).toEqual([["apple"], []]);
  });

  it("selects options by click", async () => {
    await mount();
    input().dispatchEvent(new FocusEvent("focus"));
    options()[1]?.click(); // Banana
    options()[2]?.click(); // Cherry
    expect(selected()).toEqual(["false", "true", "true"]);
    expect(tags().map((t) => t.dataset.value)).toEqual(["banana", "cherry"]);
  });

  it("enforces the max selection cap", async () => {
    await mount('data-stimeo--multi-select-max-value="1"');
    input().dispatchEvent(new FocusEvent("focus"));
    options()[0]?.click();
    options()[1]?.click(); // blocked by max=1
    expect(selected()).toEqual(["true", "false", "false"]);
    expect(tags()).toHaveLength(1);
  });

  it("removes the last chip on Backspace when the input is empty", async () => {
    await mount();
    input().dispatchEvent(new FocusEvent("focus"));
    options()[0]?.click();
    options()[1]?.click();
    input().value = "";
    key("Backspace");
    expect(selected()).toEqual(["true", "false", "false"]);
    expect(tags().map((t) => t.dataset.value)).toEqual(["apple"]);
  });

  it("removes a chip by its button, deselecting the option and re-homing focus", async () => {
    await mount();
    input().dispatchEvent(new FocusEvent("focus"));
    options()[0]?.click();
    options()[1]?.click();
    buttons()[0]?.click(); // remove apple
    expect(selected()).toEqual(["false", "true", "false"]);
    expect(tags().map((t) => t.dataset.value)).toEqual(["banana"]);
    expect(document.activeElement).toBe(buttons()[0]);
  });

  it("navigates chips and returns to the input past the end", async () => {
    await mount();
    input().dispatchEvent(new FocusEvent("focus"));
    options()[0]?.click();
    options()[1]?.click();
    input().value = "";
    key("ArrowLeft"); // focus last chip
    expect(document.activeElement).toBe(buttons()[1]);
    buttons()[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(input());
  });

  it("closes on Escape and on outside click", async () => {
    await mount();
    key("ArrowDown");
    expect(list().hidden).toBe(false);
    key("Escape");
    expect(list().hidden).toBe(true);
    key("ArrowDown");
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(list().hidden).toBe(true);
  });

  it("removes aria-activedescendant when closed", async () => {
    await mount();
    key("ArrowDown");
    expect(input().hasAttribute("aria-activedescendant")).toBe(true);
    key("Escape");
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("releases the outside-click listener on disconnect", async () => {
    await mount();
    key("ArrowDown");
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--multi-select",
    );
    controller?.disconnect();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(list().hidden).toBe(false); // a surviving listener would have closed it
  });

  it("has no machine-detectable a11y violations (closed, open, selected)", async () => {
    await mount();
    await expectNoA11yViolations(root());
    key("ArrowDown");
    key("Enter");
    await expectNoA11yViolations(root());
  });

  it("announces the combobox by its accessible name", async () => {
    await mount();
    const phrases = await captureSpeech({ container: root(), steps: 2 });
    expect(phrases).toEqual([
      "list, Selected",
      "combobox, Fruits, has popup listbox, not expanded, autocomplete in list, 1 control",
      "status",
    ]);
  });

  it("rebuilds chips from pre-selected options without duplicating on re-connect", async () => {
    // Banana starts selected (aria-selected="true") with no chip rendered yet.
    document.body.innerHTML = markup().replace(
      'id="ms-banana" role="option" aria-selected="false"',
      'id="ms-banana" role="option" aria-selected="true"',
    );
    application = Application.start();
    application.register("stimeo--multi-select", MultiSelectController);
    await tick();
    expect(tags().map((t) => t.dataset.value)).toEqual(["banana"]);

    // A Turbo cache restore / morph re-connects with the chip already present;
    // connect() must rebuild idempotently rather than append a duplicate.
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--multi-select",
    );
    controller?.disconnect();
    controller?.connect();
    expect(tags().map((t) => t.dataset.value)).toEqual(["banana"]);
  });

  it("supports options without data-value, keying chips and announce by label", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--multi-select">
        <ul data-stimeo--multi-select-target="tags" aria-label="Selected"></ul>
        <input type="text" role="combobox" aria-expanded="false" aria-autocomplete="list"
               aria-controls="ms-list2" aria-activedescendant="" aria-label="Fruits"
               data-stimeo--multi-select-target="input"
               data-action="input->stimeo--multi-select#filter
                            keydown->stimeo--multi-select#onKeydown
                            focus->stimeo--multi-select#open" />
        <ul id="ms-list2" role="listbox" aria-multiselectable="true" aria-label="Options" hidden
            data-stimeo--multi-select-target="list">
          <li id="ms-x" role="option" aria-selected="false"
              data-stimeo--multi-select-target="option"
              data-action="click->stimeo--multi-select#toggleOption">Apple</li>
        </ul>
        <span role="status" aria-live="polite" class="visually-hidden"
              data-stimeo--multi-select-target="status"></span>
        <template data-stimeo--multi-select-target="tagTemplate">
          <li data-stimeo--multi-select-target="tag">
            <span data-multi-select-slot="label"></span>
            <button type="button" tabindex="-1">×</button>
          </li>
        </template>
      </div>`;
    application = Application.start();
    application.register("stimeo--multi-select", MultiSelectController);
    await tick();

    input().dispatchEvent(new FocusEvent("focus"));
    options()[0]?.click(); // select Apple (no data-value)
    expect(tags().map((t) => t.dataset.value)).toEqual(["Apple"]); // chip keyed by label
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");

    const status = document.querySelector<HTMLElement>(
      "[data-stimeo--multi-select-target='status']",
    );
    buttons()[0]?.click(); // remove the chip
    expect(options()[0]?.getAttribute("aria-selected")).toBe("false"); // option found by label
    expect(status?.textContent).toBe("Apple"); // announce uses the display label
  });

  it("jumps the active option to the first on Home and the last on End", async () => {
    await mount();
    input().focus();
    key("ArrowDown"); // open, active first
    key("End");
    expect(active()).toBe("ms-cherry");
    key("Home");
    expect(active()).toBe("ms-apple");
  });

  it("closes the list on Tab", async () => {
    await mount();
    input().focus();
    key("ArrowDown");
    expect(list().hidden).toBe(false);
    key("Tab");
    expect(list().hidden).toBe(true);
  });

  it("removes a focused chip with the Delete key", async () => {
    await mount();
    options()[0]?.click(); // chip: Apple
    options()[1]?.click(); // chip: Banana
    expect(tags().length).toBe(2);

    const lastButton = buttons()[buttons().length - 1];
    lastButton?.focus();
    // Delete on the focused chip button bubbles to the tags-container listener.
    lastButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(tags().length).toBe(1);
  });

  it("removes a focused chip with the Backspace key", async () => {
    await mount();
    options()[0]?.click();
    options()[1]?.click();
    expect(tags().length).toBe(2);
    const lastButton = buttons()[buttons().length - 1];
    lastButton?.focus();
    lastButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    expect(tags().length).toBe(1);
  });

  it("still deselects an already-selected option when the max cap is reached", async () => {
    await mount('data-stimeo--multi-select-max-value="2"');
    options()[0]?.click(); // Apple
    options()[1]?.click(); // Banana → at cap (2)
    expect(tags().length).toBe(2);
    // The cap only blocks *new* selections; toggling a selected one off still works.
    options()[0]?.click();
    expect(options()[0]?.getAttribute("aria-selected")).toBe("false");
    expect(tags().length).toBe(1);
  });

  it("clears the active option when Escape closes the list", async () => {
    await mount();
    input().focus();
    key("ArrowDown"); // open + move active onto an option
    expect(active()).toBeTruthy();
    key("Escape");
    expect(list().hidden).toBe(true);
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  });
});
