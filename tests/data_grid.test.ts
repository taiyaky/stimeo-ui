import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { DataGridController } from "../src/controllers/data_grid_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link DataGridController}: the APG Grid contract —
 * `aria-sort` cycling with the `sort` event, single/multiple row selection with
 * `aria-selected` and `selectionchange`, and roving keyboard cell navigation.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const markup = (selection = "none") => `
  <table data-controller="stimeo--data-grid" role="grid" aria-label="Users"
         data-stimeo--data-grid-selection-value="${selection}">
    <thead>
      <tr role="row">
        <th role="columnheader" aria-sort="none" tabindex="-1"
            data-stimeo--data-grid-target="columnHeader"
            data-action="click->stimeo--data-grid#sort keydown->stimeo--data-grid#onKeydown">Name</th>
        <th role="columnheader" aria-sort="none" tabindex="-1"
            data-stimeo--data-grid-target="columnHeader"
            data-action="click->stimeo--data-grid#sort keydown->stimeo--data-grid#onKeydown">Email</th>
      </tr>
    </thead>
    <tbody>
      <tr role="row" aria-selected="false" data-stimeo--data-grid-target="row">
        <td role="gridcell" tabindex="0" data-stimeo--data-grid-target="cell"
            data-action="keydown->stimeo--data-grid#onKeydown">Jane</td>
        <td role="gridcell" tabindex="-1" data-stimeo--data-grid-target="cell"
            data-action="keydown->stimeo--data-grid#onKeydown">jane@example.com</td>
      </tr>
      <tr role="row" aria-selected="false" data-stimeo--data-grid-target="row">
        <td role="gridcell" tabindex="-1" data-stimeo--data-grid-target="cell"
            data-action="keydown->stimeo--data-grid#onKeydown">John</td>
        <td role="gridcell" tabindex="-1" data-stimeo--data-grid-target="cell"
            data-action="keydown->stimeo--data-grid#onKeydown">john@example.com</td>
      </tr>
    </tbody>
  </table>`;

describe("DataGridController", () => {
  let application: Application;

  const start = async (selection = "none") => {
    document.body.innerHTML = markup(selection);
    application = Application.start();
    application.register("stimeo--data-grid", DataGridController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--data-grid']") as HTMLElement;
  const headers = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>("[data-stimeo--data-grid-target='columnHeader']"),
    );
  const rows = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--data-grid-target='row']"));
  const cells = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--data-grid-target='cell']"));
  const at = (list: HTMLElement[], index: number): HTMLElement => {
    const el = list[index];
    if (!el) throw new Error(`Element at index ${index} not found`);
    return el;
  };
  const header = (index: number) => at(headers(), index);
  const row = (index: number) => at(rows(), index);
  const cell = (index: number) => at(cells(), index);
  const press = (el: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));

  it("keeps a single tab stop across cells and headers on connect", async () => {
    await start();
    const tabbable = [...headers(), ...cells()].filter((el) => el.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(cell(0));
  });

  it("cycles aria-sort none → ascending → descending on click and emits sort", async () => {
    await start();
    const detail: string[] = [];
    root().addEventListener("stimeo--data-grid:sort", (event) => {
      detail.push((event as CustomEvent<{ direction: string }>).detail.direction);
    });
    const name = header(0);
    name.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(name.getAttribute("aria-sort")).toBe("ascending");
    name.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(name.getAttribute("aria-sort")).toBe("descending");
    name.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(name.getAttribute("aria-sort")).toBe("none");
    expect(detail).toEqual(["ascending", "descending", "none"]);
  });

  it("advances to ascending from an unexpected aria-sort value", async () => {
    await start();
    // An ARIA-only / unknown value must not stall the cycle on the first sort.
    header(0).setAttribute("aria-sort", "other");
    header(0).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(header(0).getAttribute("aria-sort")).toBe("ascending");
  });

  it("resets other columns to none when a new column is sorted", async () => {
    await start();
    header(0).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    header(1).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(header(0).getAttribute("aria-sort")).toBe("none");
    expect(header(1).getAttribute("aria-sort")).toBe("ascending");
  });

  it("moves the active cell with arrow keys (roving tabindex)", async () => {
    await start();
    press(cell(0), "ArrowRight");
    expect(document.activeElement).toBe(cell(1));
    expect(cell(1).tabIndex).toBe(0);
    expect(cell(0).tabIndex).toBe(-1);

    press(cell(1), "ArrowDown");
    expect(document.activeElement).toBe(cell(3)); // second row, email column
  });

  it("clamps at the grid edges", async () => {
    await start();
    press(cell(0), "ArrowLeft"); // already first column
    expect(document.activeElement).toBe(cell(0));
    press(cell(0), "ArrowUp"); // header row is above; clamp keeps column
    expect(document.activeElement).toBe(header(0));
  });

  it("jumps within a row with Home/End and across the grid with Ctrl+Home/End", async () => {
    await start();
    press(cell(0), "End");
    expect(document.activeElement).toBe(cell(1));
    press(cell(1), "Home");
    expect(document.activeElement).toBe(cell(0));

    press(cell(0), "End", { ctrlKey: true });
    expect(document.activeElement).toBe(cell(3)); // last cell of grid
    press(cell(3), "Home", { ctrlKey: true });
    expect(document.activeElement).toBe(header(0)); // first cell of grid
  });

  it("sorts a header via the keyboard with Enter/Space", async () => {
    await start();
    press(header(0), "Enter");
    expect(header(0).getAttribute("aria-sort")).toBe("ascending");
    press(header(0), " ");
    expect(header(0).getAttribute("aria-sort")).toBe("descending");
  });

  it("does not select rows when selection is none", async () => {
    await start("none");
    press(cell(0), "Enter");
    expect(row(0).getAttribute("aria-selected")).toBe("false");
  });

  it("toggles a single selected row and emits selectionchange", async () => {
    await start("single");
    const detail: number[] = [];
    root().addEventListener("stimeo--data-grid:selectionchange", (event) => {
      detail.push((event as CustomEvent<{ rows: HTMLElement[] }>).detail.rows.length);
    });
    press(cell(0), "Enter"); // selects row 0
    expect(row(0).getAttribute("aria-selected")).toBe("true");

    press(cell(2), "Enter"); // selects row 1, row 0 cleared (single)
    expect(row(0).getAttribute("aria-selected")).toBe("false");
    expect(row(1).getAttribute("aria-selected")).toBe("true");
    expect(detail).toEqual([1, 1]);
  });

  it("keeps multiple rows selected in multiple mode", async () => {
    await start("multiple");
    press(cell(0), " ");
    press(cell(2), " ");
    expect(row(0).getAttribute("aria-selected")).toBe("true");
    expect(row(1).getAttribute("aria-selected")).toBe("true");
  });

  it("sets aria-multiselectable only in multiple selection mode", async () => {
    await start("multiple");
    expect(root().getAttribute("aria-multiselectable")).toBe("true");
  });

  it("does not set aria-multiselectable for single or none selection", async () => {
    await start("single");
    expect(root().hasAttribute("aria-multiselectable")).toBe(false);
    application.stop();
    await start("none");
    expect(root().hasAttribute("aria-multiselectable")).toBe(false);
  });

  it("follows a runtime change to the selection value", async () => {
    // The selection logic reads `selectionValue` live, so aria-multiselectable must
    // track Value changes (not only the connect-time value).
    await start("single");
    expect(root().hasAttribute("aria-multiselectable")).toBe(false);
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--data-grid",
    ) as DataGridController;
    // The value-changed callback runs off the attribute mutation (async in happy-dom).
    controller.selectionValue = "multiple";
    await tick();
    expect(root().getAttribute("aria-multiselectable")).toBe("true");
    controller.selectionValue = "none";
    await tick();
    expect(root().hasAttribute("aria-multiselectable")).toBe(false);
  });

  it("removes a stale aria-multiselectable on connect when not multiple", async () => {
    // Authored markup may carry a contradictory attribute (e.g. after a mode
    // change); connect re-syncs it to the actual selection value.
    document.body.innerHTML = markup("single").replace(
      'role="grid"',
      'role="grid" aria-multiselectable="true"',
    );
    application = Application.start();
    application.register("stimeo--data-grid", DataGridController);
    await tick();
    expect(root().hasAttribute("aria-multiselectable")).toBe(false);
  });

  it("has no machine-detectable a11y violations", async () => {
    await start();
    await expectNoA11yViolations(root());
  });

  // Layer ③ — speech-order regression over the grid: roles, sort state, and cell
  // names are announced in a stable order so a lost role/state shows up as a diff.
  it("announces the grid roles and the sortable header state", async () => {
    await start();
    const phrases = await captureSpeech({ container: root(), steps: 4 });
    // Freeze the whole ordered array (not a name-only `toContain`) so a lost role,
    // dropped sort state, or reordering surfaces as a diff.
    expect(phrases).toEqual([
      "grid, Users",
      "rowgroup",
      "row, Name Email",
      "columnheader, Name, no defined sort order",
      "columnheader, Email, no defined sort order",
    ]);
  });
});
