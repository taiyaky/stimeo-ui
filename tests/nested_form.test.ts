import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NestedFormController } from "../src/controllers/nested_form_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link NestedFormController}: template cloning with index
 * renumbering (custom and default placeholders), persisted vs unsaved removal
 * with the flag value as the destruction truth source, min/max constraints +
 * state hooks (including runtime Value changes), focus movement with untakeable
 * candidates skipped, the add/remove/reconcile events, delegation scoped against
 * nested instances, external-mutation reconciliation, ownership of the add
 * button's `disabled`, missing-contract diagnostics, the announce bridge, and
 * teardown.
 */

describe("NestedFormController", () => {
  let application: Application;

  const ROW = `
    <fieldset class="row">
      <input type="text" name="order[items_attributes][9][name]">
      <button type="button" data-stimeo--nested-form-target="remove">Remove</button>
    </fieldset>`;

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
    if (application) disconnectAndStopApplication(application);
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--nested-form']");
  const list = () => query("[data-stimeo--nested-form-target='list']");
  const addButton = () => query<HTMLButtonElement>("[data-stimeo--nested-form-target='add']");
  const rows = () => Array.from(list().children) as HTMLElement[];
  const visibleRows = () => rows().filter((r) => !r.hidden);
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--nested-form",
    ) as NestedFormController;

  it("adds a row from the template with the placeholder replaced", async () => {
    await start(MARKUP());
    addButton().click();
    expect(rows()).toHaveLength(1);
    const input = query<HTMLInputElement>("input", list());
    expect(input.name).toMatch(/order\[items_attributes\]\[\d+\]\[name\]/);
    expect(input.name).not.toContain("__INDEX__");
    expect(root().getAttribute("data-nested-count")).toBe("1");
  });

  it("gives each added row a unique, increasing index even in the same millisecond", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    await start(MARKUP());
    addButton().click();
    addButton().click();
    addButton().click();
    const indices = Array.from(list().querySelectorAll("input")).map((input) =>
      Number(/\[(\d+)\]/.exec(input.name)?.[1]),
    );
    expect(new Set(indices).size).toBe(3);
    expect(indices[1]).toBeGreaterThan(indices[0] ?? Number.NaN);
    expect(indices[2]).toBeGreaterThan(indices[1] ?? Number.NaN);
  });

  it("replaces a custom index placeholder and leaves the default token alone", async () => {
    await start(`
      <div data-controller="stimeo--nested-form"
           data-stimeo--nested-form-index-placeholder-value="NEW_RECORD">
        <div data-stimeo--nested-form-target="list"></div>
        <template data-stimeo--nested-form-target="template">
          <fieldset class="row">
            <input type="text" name="order[items_attributes][NEW_RECORD][name]">
            <input type="text" name="order[items_attributes][NEW_RECORD][__INDEX__]">
          </fieldset>
        </template>
        <button type="button" data-stimeo--nested-form-target="add"
                data-action="click->stimeo--nested-form#add">Add</button>
      </div>`);
    addButton().click();
    const [first, second] = Array.from(list().querySelectorAll("input"));
    expect(first?.name).toMatch(/order\[items_attributes\]\[\d+\]\[name\]/);
    // Only the configured placeholder is replaced; the default token is data.
    expect(second?.name).toMatch(/order\[items_attributes\]\[\d+\]\[__INDEX__\]/);
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

  it("counts author-hidden rows that carry no destroy flag", async () => {
    const existing = `
      <fieldset class="row"><input name="order[items_attributes][0][name]"></fieldset>
      <fieldset class="row" hidden><input name="order[items_attributes][1][name]"></fieldset>`;
    await start(MARKUP("", existing));
    // Visual hiding is the consumer's business; only the flag destroys a row.
    expect(root().getAttribute("data-nested-count")).toBe("2");
  });

  it("excludes rows whose destroy flag is already set at connect", async () => {
    const existing = `
      <fieldset class="row"><input name="order[items_attributes][0][name]"></fieldset>
      <fieldset class="row">
        <input type="hidden" value="1" data-stimeo--nested-form-target="destroyFlag">
      </fieldset>
      <fieldset class="row">
        <input type="hidden" value="true" data-stimeo--nested-form-target="destroyFlag">
      </fieldset>`;
    await start(MARKUP("", existing));
    // Both Rails-truthy spellings destroy: "1" and "true".
    expect(root().getAttribute("data-nested-count")).toBe("1");
  });

  it("completes the hiding of an already-destroyed row without an event", async () => {
    const existing = `
      <fieldset class="row live1">
        <input type="text" name="order[items_attributes][0][name]">
        <button type="button" data-stimeo--nested-form-target="remove">Remove</button>
      </fieldset>
      <fieldset class="row zombie">
        <input type="hidden" value="1" data-stimeo--nested-form-target="destroyFlag">
        <button type="button" data-stimeo--nested-form-target="remove">Remove</button>
      </fieldset>
      <fieldset class="row live2">
        <input type="text" name="order[items_attributes][2][name]">
        <button type="button" data-stimeo--nested-form-target="remove">Remove</button>
      </fieldset>`;
    await start(
      MARKUP(
        `data-stimeo--nested-form-min-value="2"
         data-stimeo--nested-form-count-message-value="{count} rows"`,
        existing,
      ),
    );
    const events: unknown[] = [];
    root().addEventListener("stimeo--nested-form:remove", (event) => events.push(event));
    const messages: unknown[] = [];
    const onAnnounce = (event: Event) => messages.push(event);
    window.addEventListener("stimeo--announcer:announce", onAnnounce);
    query<HTMLButtonElement>(".zombie [data-stimeo--nested-form-target='remove']").click();
    window.removeEventListener("stimeo--announcer:announce", onAnnounce);
    // A server re-render left the flagged row visible; the click completes the
    // hiding even at the min — the effective state does not move.
    expect(query<HTMLElement>(".zombie").hidden).toBe(true);
    expect(root().getAttribute("data-nested-count")).toBe("2");
    expect(events).toHaveLength(0);
    expect(messages).toHaveLength(0);
    // Focus lands on the following live row, not the first one.
    expect(document.activeElement).toBe(query<HTMLInputElement>(".live2 input"));
  });

  it("anchors the zombie-row rescue at the first following live row", async () => {
    const row = (cls: string, index: number) => `
      <fieldset class="row ${cls}">
        <input type="text" name="order[items_attributes][${index}][name]">
        <button type="button" data-stimeo--nested-form-target="remove">Remove</button>
      </fieldset>`;
    const zombie = `
      <fieldset class="row zombie">
        <input type="hidden" value="1" data-stimeo--nested-form-target="destroyFlag">
        <button type="button" data-stimeo--nested-form-target="remove">Remove</button>
      </fieldset>`;
    await start(MARKUP("", `${row("live1", 0)}${zombie}${row("live2", 2)}${row("live3", 3)}`));
    query<HTMLButtonElement>(".zombie [data-stimeo--nested-form-target='remove']").click();
    // Nearest following live row — not the last, not the first.
    expect(document.activeElement).toBe(query<HTMLInputElement>(".live2 input"));
  });

  it("stays quiet when the only list is removed at runtime", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await start(MARKUP());
    addButton().click();
    list().remove();
    await tick();
    // The observer rebind copes with "no list left": no Stimulus-reported error.
    expect(error).not.toHaveBeenCalled();
    addButton().click(); // and later operations degrade to the missing-target no-op
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('"list" target');
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

  it("stays a no-op at the max even when the button's disabled is bypassed", async () => {
    await start(MARKUP(`data-stimeo--nested-form-max-value="2"`));
    addButton().click();
    addButton().click();
    addButton().disabled = false;
    addButton().click();
    // The action itself refuses past the max; the disabled button is a courtesy.
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

  it("pins the add event element to the newly inserted row", async () => {
    await start(MARKUP());
    const elements: Element[] = [];
    root().addEventListener("stimeo--nested-form:add", (event) => {
      elements.push((event as CustomEvent<{ element: Element }>).detail.element);
    });
    addButton().click();
    expect(elements).toEqual([list().lastElementChild]);
  });

  it("dispatches remove with persisted: true and the flagged row", async () => {
    const persisted = `
      <fieldset class="row">
        <input type="hidden" value="0" data-stimeo--nested-form-target="destroyFlag">
        <button type="button" data-stimeo--nested-form-target="remove">Remove</button>
      </fieldset>`;
    await start(MARKUP("", persisted));
    const details: Array<{ element: Element; persisted: boolean }> = [];
    root().addEventListener("stimeo--nested-form:remove", (event) => {
      details.push((event as CustomEvent<{ element: Element; persisted: boolean }>).detail);
    });
    const row = query<HTMLElement>(".row", list());
    query<HTMLButtonElement>("[data-stimeo--nested-form-target='remove']", row).click();
    expect(details).toEqual([{ element: row, persisted: true }]);
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

  it("ignores remove buttons and flags owned by a nested inner form", async () => {
    const inner = `
      <div data-controller="stimeo--nested-form">
        <div data-stimeo--nested-form-target="list">
          <fieldset class="inner-row">
            <input type="hidden" value="0" data-stimeo--nested-form-target="destroyFlag">
            <button type="button" data-stimeo--nested-form-target="remove">Inner remove</button>
          </fieldset>
        </div>
        <template data-stimeo--nested-form-target="template"><fieldset></fieldset></template>
      </div>`;
    const existing = `
      <fieldset class="row"><input name="order[items_attributes][0][name]">${inner}</fieldset>
      <fieldset class="row"><input name="order[items_attributes][1][name]"></fieldset>`;
    await start(MARKUP("", existing));
    const outerRemoves: unknown[] = [];
    root().addEventListener("stimeo--nested-form:remove", (event) => {
      // The inner instance's own remove bubbles through here; only an event
      // dispatched on the outer root would mean the outer instance acted.
      if (event.target === root()) outerRemoves.push(event);
    });

    query<HTMLButtonElement>(".inner-row [data-stimeo--nested-form-target='remove']").click();
    await tick();
    // The inner instance hid its own row; the outer instance did not act at all.
    expect(query<HTMLElement>(".inner-row").hidden).toBe(true);
    expect(rows()).toHaveLength(2);
    expect(root().getAttribute("data-nested-count")).toBe("2");
    expect(outerRemoves).toHaveLength(0);
  });

  it("prefers the following row when returning focus after a middle removal", async () => {
    await start(MARKUP());
    addButton().click();
    addButton().click();
    addButton().click();
    const middle = rows()[1] as HTMLElement;
    query<HTMLButtonElement>("[data-stimeo--nested-form-target='remove']", middle).click();
    expect(rows()).toHaveLength(2);
    const lastRow = rows()[1] as HTMLElement;
    expect(document.activeElement).toBe(query<HTMLInputElement>("input", lastRow));
  });

  it("skips a disabled control when returning focus after removal", async () => {
    const existing = `
      <fieldset class="row surviving">
        <input type="text" disabled name="order[items_attributes][0][name]">
        <button type="button" data-stimeo--nested-form-target="remove">Remove</button>
      </fieldset>
      <fieldset class="row doomed">
        <input type="text" name="order[items_attributes][1][name]">
        <button type="button" data-stimeo--nested-form-target="remove">Remove</button>
      </fieldset>`;
    await start(MARKUP("", existing));
    query<HTMLButtonElement>(".doomed [data-stimeo--nested-form-target='remove']").click();
    // The disabled input cannot take focus; its row's remove button can.
    expect(document.activeElement).toBe(
      query<HTMLButtonElement>(".surviving [data-stimeo--nested-form-target='remove']"),
    );
  });

  it("falls back to the add button when the surviving row cannot take focus", async () => {
    const existing = `
      <fieldset class="row surviving" disabled>
        <input type="text" name="order[items_attributes][0][name]">
        <button type="button" data-stimeo--nested-form-target="remove">Remove</button>
      </fieldset>
      <fieldset class="row doomed">
        <input type="text" name="order[items_attributes][1][name]">
        <button type="button" data-stimeo--nested-form-target="remove">Remove</button>
      </fieldset>`;
    await start(MARKUP("", existing));
    query<HTMLButtonElement>(".doomed [data-stimeo--nested-form-target='remove']").click();
    // Everything inside the disabled fieldset row is untakeable.
    expect(document.activeElement).toBe(addButton());
  });

  it("borrows a tabindex and focuses the root when nothing else can take focus", async () => {
    await start(`
      <div data-controller="stimeo--nested-form">
        <div data-stimeo--nested-form-target="list">
          <fieldset class="row">
            <button type="button" data-stimeo--nested-form-target="remove">Remove</button>
          </fieldset>
        </div>
        <template data-stimeo--nested-form-target="template"><fieldset></fieldset></template>
      </div>`);
    query<HTMLButtonElement>("[data-stimeo--nested-form-target='remove']").click();
    expect(rows()).toHaveLength(0);
    expect(root().getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(root());
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

  it("stays silent when announce is false", async () => {
    await start(
      MARKUP(
        `data-stimeo--nested-form-announce-value="false"
         data-stimeo--nested-form-count-message-value="{count} rows"`,
      ),
    );
    const messages: unknown[] = [];
    const onAnnounce = (event: Event) => messages.push(event);
    window.addEventListener("stimeo--announcer:announce", onAnnounce);
    addButton().click();
    window.removeEventListener("stimeo--announcer:announce", onAnnounce);
    expect(messages).toHaveLength(0);
  });

  it("stays silent without a count message", async () => {
    await start(MARKUP());
    const messages: unknown[] = [];
    const onAnnounce = (event: Event) => messages.push(event);
    window.addEventListener("stimeo--announcer:announce", onAnnounce);
    addButton().click();
    window.removeEventListener("stimeo--announcer:announce", onAnnounce);
    expect(messages).toHaveLength(0);
  });

  it("recomputes the count idempotently from existing rows on connect", async () => {
    const existing = `
      <fieldset class="row"><input name="order[items_attributes][0][name]"></fieldset>
      <fieldset class="row"><input name="order[items_attributes][1][name]"></fieldset>`;
    await start(MARKUP("", existing));
    expect(root().getAttribute("data-nested-count")).toBe("2");
  });

  it("reconciles hooks and dispatches reconcile when rows are appended externally", async () => {
    await start(MARKUP(`data-stimeo--nested-form-max-value="2"`));
    addButton().click();
    await tick();
    const details: Array<{ count: number; atMin: boolean; atMax: boolean }> = [];
    root().addEventListener("stimeo--nested-form:reconcile", (event) => {
      details.push(
        (event as CustomEvent<{ count: number; atMin: boolean; atMax: boolean }>).detail,
      );
    });
    list().insertAdjacentHTML("beforeend", ROW); // Turbo Stream append
    await tick();
    expect(root().getAttribute("data-nested-count")).toBe("2");
    expect(root().getAttribute("data-nested-at-max")).toBe("true");
    expect(addButton().disabled).toBe(true);
    expect(details).toEqual([{ count: 2, atMin: false, atMax: true }]);
  });

  it("reconciles when rows are removed externally", async () => {
    await start(MARKUP(`data-stimeo--nested-form-min-value="1"`));
    addButton().click();
    addButton().click();
    await tick();
    const details: Array<{ count: number }> = [];
    root().addEventListener("stimeo--nested-form:reconcile", (event) => {
      details.push((event as CustomEvent<{ count: number }>).detail);
    });
    rows()[1]?.remove(); // Turbo Stream remove
    await tick();
    expect(root().getAttribute("data-nested-count")).toBe("1");
    expect(root().getAttribute("data-nested-at-min")).toBe("true");
    expect(details).toEqual([{ count: 1, atMin: true, atMax: false }]);
  });

  it("does not dispatch reconcile for its own operations", async () => {
    await start(MARKUP());
    const events: unknown[] = [];
    root().addEventListener("stimeo--nested-form:reconcile", (event) => events.push(event));
    addButton().click();
    addButton().click();
    query<HTMLButtonElement>("[data-stimeo--nested-form-target='remove']", list()).click();
    await tick();
    expect(events).toHaveLength(0);
  });

  it("re-clamps and reconciles when min or max change at runtime", async () => {
    await start(MARKUP());
    addButton().click();
    addButton().click();
    await tick();
    const details: Array<{ atMin: boolean; atMax: boolean }> = [];
    root().addEventListener("stimeo--nested-form:reconcile", (event) => {
      details.push((event as CustomEvent<{ atMin: boolean; atMax: boolean }>).detail);
    });
    root().setAttribute("data-stimeo--nested-form-max-value", "2");
    await tick();
    expect(root().getAttribute("data-nested-at-max")).toBe("true");
    expect(addButton().disabled).toBe(true);
    root().setAttribute("data-stimeo--nested-form-min-value", "2");
    await tick();
    expect(root().getAttribute("data-nested-at-min")).toBe("true");
    expect(details).toEqual([
      { count: 2, atMin: false, atMax: true },
      { count: 2, atMin: true, atMax: true },
    ]);
  });

  it("leaves an authored disabled add button alone when no max is set", async () => {
    document.body.innerHTML = MARKUP().replace(
      'data-action="click->stimeo--nested-form#add">',
      'data-action="click->stimeo--nested-form#add" disabled>',
    );
    application = Application.start();
    application.register("stimeo--nested-form", NestedFormController);
    await tick();
    expect(addButton().disabled).toBe(true);
    controller().disconnect();
    expect(addButton().disabled).toBe(true);
  });

  it("manages disabled while max is set and restores the authored value on teardown", async () => {
    document.body.innerHTML = MARKUP(`data-stimeo--nested-form-max-value="3"`).replace(
      'data-action="click->stimeo--nested-form#add">',
      'data-action="click->stimeo--nested-form#add" disabled>',
    );
    application = Application.start();
    application.register("stimeo--nested-form", NestedFormController);
    await tick();
    // Under the max the controller owns the affordance and enables the button.
    expect(addButton().disabled).toBe(false);
    controller().disconnect();
    // Teardown hands the authored disabled back.
    expect(addButton().disabled).toBe(true);
  });

  it("adds nothing and warns once when the template produces no element", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await start(`
      <div data-controller="stimeo--nested-form">
        <div data-stimeo--nested-form-target="list"></div>
        <template data-stimeo--nested-form-target="template"><!-- empty --></template>
        <button type="button" data-stimeo--nested-form-target="add"
                data-action="click->stimeo--nested-form#add">Add</button>
      </div>`);
    const events: unknown[] = [];
    root().addEventListener("stimeo--nested-form:add", (event) => events.push(event));
    addButton().click();
    addButton().click();
    expect(rows()).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("produces no element");
  });

  it("warns once and stays inert without a list target", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await start(`
      <div data-controller="stimeo--nested-form">
        <template data-stimeo--nested-form-target="template"><fieldset></fieldset></template>
        <button type="button" data-stimeo--nested-form-target="remove">Stray remove</button>
        <button type="button" data-stimeo--nested-form-target="add"
                data-action="click->stimeo--nested-form#add">Add</button>
      </div>`);
    // The connection itself names the missing contract, before any interaction.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('"list" target');
    expect(warn.mock.calls[0]?.[0]).not.toContain('"template"');
    expect(root().hasAttribute("data-nested-count")).toBe(false);
    addButton().click(); // still a safe no-op, and no second warning
    expect(() =>
      query<HTMLButtonElement>("[data-stimeo--nested-form-target='remove']").click(),
    ).not.toThrow(); // a stray remove button resolves no row instead of reading a missing target
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns naming the template when only the template is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await start(`
      <div data-controller="stimeo--nested-form">
        <div data-stimeo--nested-form-target="list"></div>
        <button type="button" data-stimeo--nested-form-target="add"
                data-action="click->stimeo--nested-form#add">Add</button>
      </div>`);
    addButton().click();
    expect(rows()).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('"template" target');
    expect(warn.mock.calls[0]?.[0]).not.toContain('"list"');
  });

  it("adopts a late-arriving list silently and reconciles from there on", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await start(`
      <div data-controller="stimeo--nested-form">
        <template data-stimeo--nested-form-target="template"><fieldset></fieldset></template>
      </div>`);
    const events: unknown[] = [];
    root().addEventListener("stimeo--nested-form:reconcile", (event) => events.push(event));
    const late = document.createElement("div");
    late.setAttribute("data-stimeo--nested-form-target", "list");
    late.innerHTML = `${ROW}${ROW}`;
    root().appendChild(late);
    await tick();
    // The first published state is a baseline, not a move: no reconcile yet.
    expect(root().getAttribute("data-nested-count")).toBe("2");
    expect(events).toHaveLength(0);
    late.firstElementChild?.remove();
    await tick();
    expect(root().getAttribute("data-nested-count")).toBe("1");
    expect(events).toHaveLength(1);
  });

  it("reconciles when a destroy flag is flipped from outside", async () => {
    const existing = `
      <fieldset class="row"><input name="order[items_attributes][0][name]"></fieldset>
      <fieldset class="row">
        <input type="hidden" value="0" data-stimeo--nested-form-target="destroyFlag">
      </fieldset>`;
    await start(MARKUP("", existing));
    expect(root().getAttribute("data-nested-count")).toBe("2");
    const events: unknown[] = [];
    root().addEventListener("stimeo--nested-form:reconcile", (event) => events.push(event));
    // A morph patches the flag attribute; no controller operation is involved.
    query<HTMLInputElement>("[data-stimeo--nested-form-target='destroyFlag']").setAttribute(
      "value",
      "1",
    );
    await tick();
    expect(root().getAttribute("data-nested-count")).toBe("1");
    expect(events).toHaveLength(1);
  });

  it("rolls back an escaped-text template and leaves the list untouched", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await start(`
      <div data-controller="stimeo--nested-form">
        <div data-stimeo--nested-form-target="list"></div>
        <template data-stimeo--nested-form-target="template">&lt;fieldset&gt;oops&lt;/fieldset&gt;</template>
        <button type="button" data-stimeo--nested-form-target="add"
                data-action="click->stimeo--nested-form#add">Add</button>
      </div>`);
    addButton().click();
    addButton().click();
    // The escaped markup parses to text; nothing may accumulate in the list.
    expect(list().childNodes).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("produces no element");
  });

  it("rejects a template with more than one root element", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await start(`
      <div data-controller="stimeo--nested-form" data-stimeo--nested-form-max-value="2">
        <div data-stimeo--nested-form-target="list">
          <fieldset class="row"><input type="text" name="order[items_attributes][0][name]"></fieldset>
        </div>
        <template data-stimeo--nested-form-target="template"><fieldset class="row"></fieldset><hr></template>
        <button type="button" data-stimeo--nested-form-target="add"
                data-action="click->stimeo--nested-form#add">Add</button>
      </div>`);
    addButton().click();
    // Inserting both roots would blow past max=2; the insertion is rolled back.
    expect(rows()).toHaveLength(1);
    expect(root().getAttribute("data-nested-count")).toBe("1");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("exactly one root element");
  });

  it("returns the authored disabled to the snapshot on turbo:before-cache", async () => {
    document.body.innerHTML = MARKUP(`data-stimeo--nested-form-max-value="3"`).replace(
      'data-action="click->stimeo--nested-form#add">',
      'data-action="click->stimeo--nested-form#add" disabled>',
    );
    application = Application.start();
    application.register("stimeo--nested-form", NestedFormController);
    await tick();
    expect(addButton().disabled).toBe(false); // under the max the controller owns it
    document.dispatchEvent(new Event("turbo:before-cache"));
    // The snapshot must carry the authored value, not the controller's write.
    expect(addButton().disabled).toBe(true);
  });

  it("follows a staggered list swap where the successor arrives first", async () => {
    await start(MARKUP(`data-stimeo--nested-form-max-value="3"`));
    addButton().click();
    addButton().click();
    addButton().click();
    await tick();
    expect(addButton().disabled).toBe(true);
    const old = list();
    const replacement = document.createElement("div");
    replacement.setAttribute("data-stimeo--nested-form-target", "list");
    replacement.innerHTML = ROW;
    root().appendChild(replacement); // the successor arrives while the old list stays
    await tick();
    old.remove(); // the old (still primary) list leaves in a later task
    await tick();
    expect(root().getAttribute("data-nested-count")).toBe("1");
    expect(addButton().disabled).toBe(false);
    // The observer moved with the primary: external changes keep reconciling.
    replacement.insertAdjacentHTML("beforeend", ROW);
    await tick();
    expect(root().getAttribute("data-nested-count")).toBe("2");
  });

  it("follows a swapped list target", async () => {
    await start(MARKUP());
    addButton().click();
    await tick();
    const replacement = document.createElement("div");
    replacement.setAttribute("data-stimeo--nested-form-target", "list");
    replacement.innerHTML = `${ROW}${ROW}${ROW}`;
    list().replaceWith(replacement);
    await tick();
    expect(root().getAttribute("data-nested-count")).toBe("3");
    // The observer moved with the target: external changes to the new list count.
    replacement.firstElementChild?.remove();
    await tick();
    expect(root().getAttribute("data-nested-count")).toBe("2");
  });

  it("stops handling removes and observing after disconnect", async () => {
    await start(MARKUP());
    addButton().click();
    controller().disconnect();
    query<HTMLButtonElement>("[data-stimeo--nested-form-target='remove']", list()).click();
    // The delegated listener is gone: the row remains.
    expect(rows()).toHaveLength(1);
    const before = root().getAttribute("data-nested-count");
    list().insertAdjacentHTML("beforeend", ROW);
    await tick();
    // The observer is gone too: external changes no longer reconcile.
    expect(root().getAttribute("data-nested-count")).toBe(before);
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
