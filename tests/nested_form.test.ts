import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { NestedFormController } from "../src/controllers/nested_form_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link NestedFormController}: template cloning with index
 * renumbering, persisted vs unsaved removal, min/max constraints + state hooks,
 * focus movement, the add/remove events, delegation for dynamic rows, the
 * announce bridge, and teardown.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("NestedFormController", () => {
  let application: Application;

  const MARKUP = (attrs = "", existing = "") => `
    <div data-controller="stimeo--nested-form" ${attrs}>
      <div data-stimeo--nested-form-target="list">${existing}</div>
      <template data-stimeo--nested-form-target="template">
        <fieldset class="row">
          <input type="text" name="order[items_attributes][__INDEX__][name]">
          <button type="button" data-stimeo--nested-form-target="remove">Remove</button>
        </fieldset>
      </template>
      <button type="button" data-stimeo--nested-form-target="add"
              data-action="click->stimeo--nested-form#add">Add</button>
    </div>`;

  const start = async (markup: string) => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--nested-form", NestedFormController);
    await tick();
  };

  afterEach(() => {
    application?.stop();
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--nested-form']");
  const list = () => query("[data-stimeo--nested-form-target='list']");
  const addButton = () => query<HTMLButtonElement>("[data-stimeo--nested-form-target='add']");
  const rows = () => Array.from(list().children) as HTMLElement[];
  const visibleRows = () => rows().filter((r) => !r.hidden);

  it("adds a row from the template with the placeholder replaced", async () => {
    await start(MARKUP());
    addButton().click();
    expect(rows()).toHaveLength(1);
    const input = query<HTMLInputElement>("input", list());
    expect(input.name).toMatch(/order\[items_attributes\]\[\d+\]\[name\]/);
    expect(input.name).not.toContain("__INDEX__");
    expect(root().getAttribute("data-nested-count")).toBe("1");
  });

  it("gives each added row a unique index", async () => {
    await start(MARKUP());
    addButton().click();
    addButton().click();
    const names = Array.from(list().querySelectorAll("input")).map((i) => i.name);
    expect(names[0]).not.toEqual(names[1]);
  });

  it("moves focus to the first control of the new row", async () => {
    await start(MARKUP());
    addButton().click();
    const input = query<HTMLInputElement>("input", list());
    expect(document.activeElement).toBe(input);
  });

  it("removes an unsaved row from the DOM", async () => {
    await start(MARKUP());
    addButton().click();
    addButton().click();
    expect(rows()).toHaveLength(2);
    query<HTMLButtonElement>("[data-stimeo--nested-form-target='remove']", list()).click();
    expect(rows()).toHaveLength(1);
  });

  it("flags and hides a persisted row instead of deleting it", async () => {
    const persisted = `
      <fieldset class="row">
        <input type="hidden" name="order[items_attributes][0][_destroy]" value="0"
               data-stimeo--nested-form-target="destroyFlag">
        <input type="text" name="order[items_attributes][0][name]">
        <button type="button" data-stimeo--nested-form-target="remove">Remove</button>
      </fieldset>`;
    await start(MARKUP("", persisted));
    query<HTMLButtonElement>("[data-stimeo--nested-form-target='remove']", list()).click();
    const row = query<HTMLElement>(".row", list());
    expect(row.hidden).toBe(true);
    const flag = query<HTMLInputElement>("[data-stimeo--nested-form-target='destroyFlag']");
    expect(flag.value).toBe("1");
    // The destroyed row no longer counts toward the effective total.
    expect(root().getAttribute("data-nested-count")).toBe("0");
  });

  it("does not remove below the min and reflects data-nested-at-min", async () => {
    await start(MARKUP(`data-stimeo--nested-form-min-value="1"`));
    addButton().click();
    expect(root().getAttribute("data-nested-at-min")).toBe("true");
    query<HTMLButtonElement>("[data-stimeo--nested-form-target='remove']", list()).click();
    // At the minimum, the remove is a no-op.
    expect(visibleRows()).toHaveLength(1);
  });

  it("stops adding at the max and disables the add button", async () => {
    await start(MARKUP(`data-stimeo--nested-form-max-value="2"`));
    addButton().click();
    addButton().click();
    expect(rows()).toHaveLength(2);
    expect(root().getAttribute("data-nested-at-max")).toBe("true");
    expect(addButton().disabled).toBe(true);
    addButton().click();
    expect(rows()).toHaveLength(2);
  });

  it("dispatches add and remove events", async () => {
    await start(MARKUP());
    const events: string[] = [];
    root().addEventListener("stimeo--nested-form:add", (event) => {
      events.push(`add:${(event as CustomEvent<{ index: number }>).detail.index > 0}`);
    });
    root().addEventListener("stimeo--nested-form:remove", (event) => {
      events.push(`remove:${(event as CustomEvent<{ persisted: boolean }>).detail.persisted}`);
    });
    addButton().click();
    query<HTMLButtonElement>("[data-stimeo--nested-form-target='remove']", list()).click();
    expect(events).toEqual(["add:true", "remove:false"]);
  });

  it("handles remove on rows added after connect via delegation", async () => {
    await start(MARKUP());
    addButton().click();
    addButton().click();
    addButton().click();
    expect(rows()).toHaveLength(3);
    // Remove the last (most recently appended) row — its button was never wired
    // individually; the delegated container listener handles it.
    const removeButtons = list().querySelectorAll<HTMLButtonElement>(
      "[data-stimeo--nested-form-target='remove']",
    );
    removeButtons[removeButtons.length - 1]?.click();
    expect(rows()).toHaveLength(2);
  });

  it("bridges the count to the announcer when announce + countMessage are set", async () => {
    await start(MARKUP(`data-stimeo--nested-form-count-message-value="{count} rows"`));
    const messages: string[] = [];
    const onAnnounce = (event: Event) => {
      messages.push((event as CustomEvent<{ message: string }>).detail.message);
    };
    window.addEventListener("stimeo--announcer:announce", onAnnounce);
    addButton().click();
    addButton().click();
    window.removeEventListener("stimeo--announcer:announce", onAnnounce);
    expect(messages).toEqual(["1 rows", "2 rows"]);
  });

  it("recomputes the count idempotently from existing rows on connect", async () => {
    const existing = `
      <fieldset class="row"><input name="order[items_attributes][0][name]"></fieldset>
      <fieldset class="row"><input name="order[items_attributes][1][name]"></fieldset>`;
    await start(MARKUP("", existing));
    expect(root().getAttribute("data-nested-count")).toBe("2");
  });

  it("stops handling removes after disconnect", async () => {
    await start(MARKUP());
    addButton().click();
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--nested-form",
    ) as NestedFormController;
    controller.disconnect();
    query<HTMLButtonElement>("[data-stimeo--nested-form-target='remove']", list()).click();
    // The delegated listener is gone: the row remains.
    expect(rows()).toHaveLength(1);
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(`
      <main>
        <div data-controller="stimeo--nested-form">
          <div data-stimeo--nested-form-target="list"></div>
          <template data-stimeo--nested-form-target="template">
            <fieldset class="row">
              <label>Item
                <input type="text" name="order[items_attributes][__INDEX__][name]">
              </label>
              <button type="button" data-stimeo--nested-form-target="remove">Remove</button>
            </fieldset>
          </template>
          <button type="button" data-stimeo--nested-form-target="add"
                  data-action="click->stimeo--nested-form#add">Add</button>
        </div>
      </main>`);
    addButton().click();
    await expectNoA11yViolations(document.body);
  });
});
