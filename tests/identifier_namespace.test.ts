import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { CurrencyInputController } from "../src/controllers/currency_input_controller";
import { NestedFormController } from "../src/controllers/nested_form_controller";
import { PaginationController } from "../src/controllers/pagination_controller";
import { TagsInputController } from "../src/controllers/tags_input_controller";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Every attribute a controller reads or writes in its own namespace follows the
 * name it was registered under, the way Stimulus already derives
 * `data-<identifier>-target` from that name.
 *
 * A registration under a second name is a supported Stimulus configuration, and
 * a hardcoded `data-stimeo--…` would leave the widget silently inert there: its
 * parts resolve to nothing and its state hooks land on an attribute no
 * stylesheet is watching. These cases cover each shape the derivation takes —
 * row parts, a state hook, a marker the controller owns, and a delegated
 * selector — so the derived spelling is shown to drive the behavior rather than
 * merely to be spelled that way.
 */
describe("attributes follow the registered identifier", () => {
  let application: Application;
  const ALIAS = "widgets--chips";

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const start = async (html: string, identifier: string, ctor: never) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register(identifier, ctor as unknown as typeof TagsInputController);
    await tick();
  };

  it("resolves row parts and the full hook under a second registration", async () => {
    await start(
      `<div data-controller="${ALIAS}" data-${ALIAS}-max-value="1">
        <ul data-${ALIAS}-target="tags"></ul>
        <input type="text" data-${ALIAS}-target="input" data-action="keydown->${ALIAS}#onKeydown" />
        <div data-${ALIAS}-target="fields"></div>
        <template data-${ALIAS}-target="tagTemplate">
          <li data-${ALIAS}-target="tag">
            <span data-${ALIAS}-target="label"></span>
            <button type="button" aria-label="Remove {label}" data-${ALIAS}-target="remove">x</button>
          </li>
        </template>
      </div>`,
      ALIAS,
      TagsInputController as never,
    );
    const input = document.querySelector<HTMLInputElement>(
      `[data-${ALIAS}-target='input']`,
    ) as HTMLInputElement;
    input.value = "Rails";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();

    const row = document.querySelector<HTMLElement>(`[data-${ALIAS}-target='tags']`) as HTMLElement;
    const host = document.querySelector<HTMLElement>(`[data-controller='${ALIAS}']`) as HTMLElement;
    expect(row.children).toHaveLength(1);
    expect(row.querySelector("button")?.getAttribute("aria-label")).toBe("Remove Rails");
    // The `max` state hook lands in the same namespace as the parts.
    expect(host.hasAttribute(`data-${ALIAS}-full`)).toBe(true);
    expect(host.hasAttribute("data-stimeo--tags-input-full")).toBe(false);
  });

  it("writes a state hook under a second registration", async () => {
    const alias = "money--field";
    await start(
      `<div data-controller="${alias}">
        <input id="amount" type="text" inputmode="decimal"
               data-${alias}-target="display"
               data-action="input->${alias}#onInput blur->${alias}#format" />
        <input type="hidden" data-${alias}-target="field" />
      </div>`,
      alias,
      CurrencyInputController as never,
    );
    const host = document.querySelector<HTMLElement>(`[data-controller='${alias}']`) as HTMLElement;
    const display = document.querySelector<HTMLInputElement>(
      `[data-${alias}-target='display']`,
    ) as HTMLInputElement;

    display.value = "12";
    display.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(host.hasAttribute(`data-${alias}-empty`)).toBe(false);

    display.value = "";
    display.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(host.hasAttribute(`data-${alias}-empty`)).toBe(true);
    expect(host.hasAttribute("data-stimeo--currency-input-empty")).toBe(false);
  });

  it("marks an owned attribute under a second registration", async () => {
    const alias = "pager";
    await start(
      `<nav data-controller="${alias}" data-${alias}-page-value="1" data-${alias}-total-value="3">
        <button type="button" data-${alias}-target="prev" data-action="click->${alias}#prev">Prev</button>
        <button type="button" data-${alias}-target="next" data-action="click->${alias}#next">Next</button>
      </nav>`,
      alias,
      PaginationController as never,
    );
    const prev = document.querySelector<HTMLButtonElement>(
      `[data-${alias}-target='prev']`,
    ) as HTMLButtonElement;

    expect(prev.disabled).toBe(true);
    expect(prev.hasAttribute(`data-${alias}-boundary-disabled`)).toBe(true);
    expect(prev.hasAttribute("data-stimeo--pagination-boundary-disabled")).toBe(false);
  });

  it("delegates to a row part under a second registration", async () => {
    const alias = "rows";
    await start(
      `<div data-controller="${alias}">
        <div data-${alias}-target="list"></div>
        <template data-${alias}-target="template">
          <fieldset>
            <input type="text" name="order[items][__INDEX__][name]" />
            <button type="button" data-${alias}-target="remove">Remove</button>
          </fieldset>
        </template>
        <button type="button" data-${alias}-target="add" data-action="click->${alias}#add">Add</button>
      </div>`,
      alias,
      NestedFormController as never,
    );
    const list = document.querySelector<HTMLElement>(
      `[data-${alias}-target='list']`,
    ) as HTMLElement;
    const add = document.querySelector<HTMLElement>(`[data-${alias}-target='add']`) as HTMLElement;

    add.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(list.children).toHaveLength(1);

    // The remove button is resolved by a delegated selector in the same namespace.
    list.querySelector<HTMLButtonElement>(`[data-${alias}-target='remove']`)?.click();
    await tick();
    expect(list.children).toHaveLength(0);
  });
});
