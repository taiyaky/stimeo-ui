import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilterController } from "../src/controllers/filter_controller";
import { ToggleGroupController } from "../src/controllers/toggle_group_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link FilterController}: initial all-visible state, AND/ANY
 * token matching, native-change reactivity, the apply/clear actions, group + empty
 * syncing, the change event payload, machine a11y, and disconnect teardown.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("FilterController", () => {
  let application: Application;

  const mount = async (inner: string, attrs = "") => {
    document.body.innerHTML = `<div data-controller="stimeo--filter" ${attrs}>${inner}</div>`;
    application = Application.start();
    application.register("stimeo--filter", FilterController);
    await tick();
  };

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () => query<HTMLElement>("[data-controller='stimeo--filter']");
  const items = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--filter-target='item']"));
  const controllerFor = () =>
    application.getControllerForElementAndIdentifier(root(), "stimeo--filter") as FilterController;
  // A checkbox control whose token is its data-value; toggling it bubbles a change.
  const control = (token: string) =>
    `<input type="checkbox" data-stimeo--filter-target="control" data-value="${token}">`;
  const item = (tokens: string) =>
    `<div data-stimeo--filter-target="item" data-stimeo--filter-tokens="${tokens}"></div>`;

  const setChecked = (el: HTMLInputElement, checked: boolean) => {
    el.checked = checked;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  it("shows every item while no control is active", async () => {
    await mount(`${control("a")}${item("a")}${item("b")}`);
    expect(items().every((node) => !node.hidden)).toBe(true);
  });

  it("hides items that lack the active token (single facet)", async () => {
    await mount(`${control("a")}${item("a")}${item("b")}`);
    setChecked(query<HTMLInputElement>("input"), true);

    expect(items()[0]?.hidden).toBe(false);
    expect(items()[1]?.hidden).toBe(true);
  });

  it("combines multiple active tokens with AND by default (match=all)", async () => {
    await mount(`${control("a")}${control("b")}${item("a b")}${item("a")}`);
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
    for (const input of inputs) setChecked(input, true);

    expect(items()[0]?.hidden).toBe(false); // has both a and b
    expect(items()[1]?.hidden).toBe(true); // missing b
  });

  it("combines with OR when match='any'", async () => {
    await mount(
      `${control("a")}${control("b")}${item("a")}${item("c")}`,
      'data-stimeo--filter-match-value="any"',
    );
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
    for (const input of inputs) setChecked(input, true);

    expect(items()[0]?.hidden).toBe(false); // matches a
    expect(items()[1]?.hidden).toBe(true); // matches neither a nor b
  });

  it("reads aria-pressed button controls when apply() is invoked", async () => {
    await mount(
      `<button type="button" aria-pressed="false" data-value="a"
               data-stimeo--filter-target="control">A</button>
       ${item("a")}${item("b")}`,
    );
    // Buttons emit no native change; the consumer wires their event to apply().
    query<HTMLButtonElement>("button").setAttribute("aria-pressed", "true");
    controllerFor().apply();

    expect(items()[0]?.hidden).toBe(false);
    expect(items()[1]?.hidden).toBe(true);
  });

  it("hides a group with no visible item and reveals the empty element", async () => {
    await mount(
      `${control("a")}
       <section data-stimeo--filter-target="group">${item("b")}</section>
       <p data-stimeo--filter-target="empty" hidden>none</p>`,
    );
    setChecked(query<HTMLInputElement>("input"), true);

    expect(query<HTMLElement>("[data-stimeo--filter-target='group']").hidden).toBe(true);
    expect(query<HTMLElement>("[data-stimeo--filter-target='empty']").hidden).toBe(false);
  });

  it("clear() turns every control off and restores all items", async () => {
    await mount(`${control("a")}${item("a")}${item("b")}`);
    const checkbox = query<HTMLInputElement>("input");
    setChecked(checkbox, true);
    expect(items()[1]?.hidden).toBe(true);

    controllerFor().clear();

    expect(checkbox.checked).toBe(false);
    expect(items().every((node) => !node.hidden)).toBe(true);
  });

  it("dispatches stimeo--filter:change with the active tokens and counts", async () => {
    await mount(`${control("a")}${item("a")}${item("b")}`);
    // Attach after connect so we capture only the change-driven evaluation.
    const onChange = vi.fn();
    root().addEventListener("stimeo--filter:change", onChange);
    setChecked(query<HTMLInputElement>("input"), true);

    expect(onChange).toHaveBeenCalled();
    const detail = onChange.mock.calls[0]?.[0]?.detail;
    expect(detail?.active).toEqual(["a"]);
    expect(detail?.visible).toBe(1);
    expect(detail?.total).toBe(2);
  });

  it("clear() un-presses aria-pressed button controls (not just checkboxes)", async () => {
    await mount(
      `<button type="button" aria-pressed="false" data-value="a"
               data-stimeo--filter-target="control">A</button>
       ${item("a")}${item("b")}`,
    );
    const button = query<HTMLButtonElement>("button");
    button.setAttribute("aria-pressed", "true");
    controllerFor().apply();
    expect(items()[1]?.hidden).toBe(true);

    controllerFor().clear();

    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(items().every((node) => !node.hidden)).toBe(true);
  });

  it("resolves a control's token from data-stimeo--filter-token, then the value", async () => {
    await mount(
      `<input type="checkbox" data-stimeo--filter-target="control"
              data-stimeo--filter-token="a">
       <input type="checkbox" value="b" data-stimeo--filter-target="control">
       ${item("a")}${item("b")}`,
      'data-stimeo--filter-match-value="any"',
    );
    const explicit = query<HTMLInputElement>("[data-stimeo--filter-token='a']");
    const valueOnly = query<HTMLInputElement>("input[value='b']");

    // Explicit data-stimeo--filter-token wins.
    setChecked(explicit, true);
    expect(items()[0]?.hidden).toBe(false);
    expect(items()[1]?.hidden).toBe(true);

    // With no data-* token, the control falls back to its `value` attribute.
    setChecked(explicit, false);
    setChecked(valueOnly, true);
    expect(items()[0]?.hidden).toBe(true);
    expect(items()[1]?.hidden).toBe(false);
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount(
      `<div role="group" aria-label="Filters">
         <button type="button" aria-pressed="true" data-value="a"
                 data-stimeo--filter-target="control">Tag A</button>
       </div>
       <ul>
         <li data-stimeo--filter-target="item" data-stimeo--filter-tokens="a">Item A</li>
         <li data-stimeo--filter-target="item" data-stimeo--filter-tokens="b">Item B</li>
       </ul>
       <p role="status" data-stimeo--filter-target="empty" hidden>No matches</p>`,
    );
    await expectNoA11yViolations(root());
  });

  it("removes its change listener on disconnect (teardown)", async () => {
    await mount(`${control("a")}${item("a")}${item("b")}`);
    controllerFor().disconnect();

    // After teardown, toggling a control + firing change must NOT re-filter.
    const checkbox = query<HTMLInputElement>("input");
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    expect(items().every((node) => !node.hidden)).toBe(true);
  });
});

/**
 * Integration: the real cross-controller wiring the catalog relies on — a
 * toggle-group chip click dispatches `stimeo--toggle-group:change`, which a
 * `data-action` on the filter root routes to `stimeo--filter#apply`. Unit tests
 * above prove each controller in isolation; this proves they compose in the
 * exact shape used in practice (chip = toggle-group item AND filter control).
 */
describe("FilterController + ToggleGroupController wiring", () => {
  let application: Application;

  const items = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--filter-target='item']"));

  const mount = async (inner: string) => {
    document.body.innerHTML = `
      <div data-controller="stimeo--filter" data-stimeo--filter-match-value="all"
           data-action="stimeo--toggle-group:change->stimeo--filter#apply">${inner}</div>`;
    application = Application.start();
    application.register("stimeo--filter", FilterController);
    application.register("stimeo--toggle-group", ToggleGroupController);
    await tick();
  };

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  it("filters items when a chip is clicked (custom event → apply)", async () => {
    await mount(
      `<div role="group" aria-label="Tags" data-controller="stimeo--toggle-group">
         <button type="button" class="chip" aria-pressed="false" tabindex="0" data-value="a"
                 data-stimeo--toggle-group-target="item"
                 data-stimeo--filter-target="control"
                 data-action="click->stimeo--toggle-group#toggle
                              keydown->stimeo--toggle-group#onKeydown">A</button>
       </div>
       <div data-stimeo--filter-target="item" data-stimeo--filter-tokens="a"></div>
       <div data-stimeo--filter-target="item" data-stimeo--filter-tokens="b"></div>`,
    );
    const chip = query<HTMLButtonElement>(".chip");
    expect(items().every((node) => !node.hidden)).toBe(true);

    // Real click: toggle-group flips aria-pressed and dispatches its change event,
    // which the root data-action routes to filter#apply.
    chip.click();
    await tick();

    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(items()[0]?.hidden).toBe(false); // token "a" kept
    expect(items()[1]?.hidden).toBe(true); // token "b" filtered out

    // Clicking again releases the chip → every item returns.
    chip.click();
    await tick();

    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(items().every((node) => !node.hidden)).toBe(true);
  });
});
