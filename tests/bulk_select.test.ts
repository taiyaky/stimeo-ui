import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { BulkSelectController } from "../src/controllers/bulk_select_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link BulkSelectController}: item/select-all linkage,
 * indeterminate state, bar visibility + count, clear, the change event, all-pages
 * mode, delegation for dynamically-added rows, Turbo-idempotent connect, the
 * announce hook, focus preservation, and teardown.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("BulkSelectController", () => {
  let application: Application;

  const MARKUP = (attrs = "", rows = 3) => `
    <div data-controller="stimeo--bulk-select" ${attrs}>
      <input type="checkbox" data-stimeo--bulk-select-target="all">
      <ul data-list>
        ${Array.from({ length: rows })
          .map(() => `<li><input type="checkbox" data-stimeo--bulk-select-target="item"></li>`)
          .join("")}
      </ul>
      <div data-stimeo--bulk-select-target="bar" hidden role="toolbar" aria-live="polite">
        <span data-stimeo--bulk-select-target="count"></span>
        <button data-stimeo--bulk-select-target="selectAllPages"
                data-action="click->stimeo--bulk-select#selectAllPages">All pages</button>
        <button data-action="click->stimeo--bulk-select#clear">Clear</button>
      </div>
    </div>`;

  const start = async (markup: string) => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--bulk-select", BulkSelectController);
    await tick();
  };

  afterEach(() => {
    application?.stop();
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--bulk-select']");
  const all = () => query<HTMLInputElement>("[data-stimeo--bulk-select-target='all']");
  const items = () =>
    Array.from(
      document.querySelectorAll<HTMLInputElement>("[data-stimeo--bulk-select-target='item']"),
    );
  /** Definite row accessor (the lint bans `!`, and indexing is `| undefined`). */
  const itemAt = (index: number): HTMLInputElement => {
    const box = items()[index];
    if (!box) throw new Error(`No item at index ${index}`);
    return box;
  };
  const bar = () => query("[data-stimeo--bulk-select-target='bar']");
  const count = () => query("[data-stimeo--bulk-select-target='count']");

  /** Checks (or unchecks) a checkbox and fires a bubbling change, as a click would. */
  const setChecked = (box: HTMLInputElement, checked: boolean) => {
    box.checked = checked;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  };

  it("hides the bar with nothing selected and reveals it on first selection", async () => {
    await start(MARKUP());
    expect(bar().hidden).toBe(true);
    setChecked(itemAt(0), true);
    expect(bar().hidden).toBe(false);
    expect(count().textContent).toBe("1");
  });

  it("reflects the selected count and hides the bar when cleared back to zero", async () => {
    await start(MARKUP());
    setChecked(itemAt(0), true);
    setChecked(itemAt(1), true);
    expect(count().textContent).toBe("2");
    setChecked(itemAt(0), false);
    setChecked(itemAt(1), false);
    expect(bar().hidden).toBe(true);
  });

  it("select-all checks every row and sets count to the total", async () => {
    await start(MARKUP());
    setChecked(all(), true);
    expect(items().every((i) => i.checked)).toBe(true);
    expect(count().textContent).toBe("3");
  });

  it("sets the select-all box indeterminate on a partial selection", async () => {
    await start(MARKUP());
    setChecked(itemAt(0), true);
    expect(all().indeterminate).toBe(true);
    expect(all().checked).toBe(false);
  });

  it("checks the select-all box (not indeterminate) when every row is selected", async () => {
    await start(MARKUP());
    for (const item of items()) setChecked(item, true);
    expect(all().indeterminate).toBe(false);
    expect(all().checked).toBe(true);
  });

  it("clear unchecks everything and hides the bar", async () => {
    await start(MARKUP());
    setChecked(all(), true);
    query<HTMLButtonElement>("[data-action*='clear']").click();
    expect(items().some((i) => i.checked)).toBe(false);
    expect(all().checked).toBe(false);
    expect(bar().hidden).toBe(true);
    expect(root().getAttribute("data-selected-count")).toBe("0");
  });

  it("dispatches change with count and allPages on each selection change", async () => {
    await start(MARKUP());
    const log: Array<{ count: number; allPages: boolean }> = [];
    root().addEventListener("stimeo--bulk-select:change", (event) => {
      log.push((event as CustomEvent<{ count: number; allPages: boolean }>).detail);
    });
    setChecked(itemAt(0), true);
    setChecked(itemAt(1), true);
    setChecked(itemAt(0), false);
    expect(log).toEqual([
      { count: 1, allPages: false },
      { count: 2, allPages: false },
      { count: 1, allPages: false },
    ]);
  });

  it("enters all-pages mode showing the total count", async () => {
    await start(MARKUP(`data-stimeo--bulk-select-total-count-value="128"`));
    setChecked(all(), true);
    query<HTMLButtonElement>("[data-action*='selectAllPages']").click();
    expect(root().getAttribute("data-all-pages")).toBe("true");
    expect(count().textContent).toBe("128");
  });

  it("handles dynamically-added rows via delegation", async () => {
    await start(MARKUP());
    const list = query("[data-list]");
    const li = document.createElement("li");
    li.innerHTML = `<input type="checkbox" data-stimeo--bulk-select-target="item">`;
    list.appendChild(li);
    const added = li.querySelector("input") as HTMLInputElement;
    // No per-row data-action was bound; the delegated container listener handles it.
    setChecked(added, true);
    expect(count().textContent).toBe("1");
    expect(root().getAttribute("data-selected-count")).toBe("1");
  });

  it("recomputes idempotently from pre-checked rows on connect (Turbo swap)", async () => {
    await start(`
      <div data-controller="stimeo--bulk-select">
        <input type="checkbox" data-stimeo--bulk-select-target="all">
        <input type="checkbox" data-stimeo--bulk-select-target="item" checked>
        <input type="checkbox" data-stimeo--bulk-select-target="item" checked>
        <input type="checkbox" data-stimeo--bulk-select-target="item">
        <div data-stimeo--bulk-select-target="bar" hidden role="toolbar" aria-live="polite">
          <span data-stimeo--bulk-select-target="count"></span>
        </div>
      </div>`);
    expect(bar().hidden).toBe(false);
    expect(count().textContent).toBe("2");
    expect(all().indeterminate).toBe(true);
  });

  it("sets the bar aria-live to off when announce is disabled", async () => {
    await start(MARKUP(`data-stimeo--bulk-select-announce-value="false"`));
    setChecked(itemAt(0), true);
    expect(bar().getAttribute("aria-live")).toBe("off");
  });

  it("does not move focus when the bar appears", async () => {
    await start(MARKUP());
    const box = itemAt(0);
    box.focus();
    setChecked(box, true);
    expect(document.activeElement).toBe(box);
  });

  it("stops handling changes after disconnect", async () => {
    await start(MARKUP());
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--bulk-select",
    ) as BulkSelectController;
    controller.disconnect();
    setChecked(itemAt(0), true);
    expect(bar().hidden).toBe(true);
  });

  it("degrades gracefully with only item checkboxes (no all/bar/count targets)", async () => {
    await start(`
      <div data-controller="stimeo--bulk-select">
        <input type="checkbox" data-stimeo--bulk-select-target="item">
        <input type="checkbox" data-stimeo--bulk-select-target="item">
      </div>`);
    setChecked(itemAt(0), true);
    // No throw despite the missing optional targets; the count hook still updates.
    expect(root().getAttribute("data-selected-count")).toBe("1");
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(`
      <main>
        <div data-controller="stimeo--bulk-select">
          <label><input type="checkbox" data-stimeo--bulk-select-target="all"> Select all</label>
          <label><input type="checkbox" data-stimeo--bulk-select-target="item"> Row 1</label>
          <label><input type="checkbox" data-stimeo--bulk-select-target="item"> Row 2</label>
          <div data-stimeo--bulk-select-target="bar" hidden role="toolbar" aria-live="polite">
            <span data-stimeo--bulk-select-target="count"></span> selected
            <button data-action="click->stimeo--bulk-select#clear">Clear</button>
          </div>
        </div>
      </main>`);
    await expectNoA11yViolations(document.body);
  });

  // Layer ③ — the count must actually be announced through the bar's live region,
  // not merely written to the DOM: freeze the role + count in spoken order.
  it("announces the selection count through the bar's live region", async () => {
    await start(MARKUP());
    setChecked(itemAt(0), true);
    setChecked(itemAt(1), true);
    expect(count().textContent).toBe("2");
    expect(await captureSpeech({ container: bar(), steps: 1 })).toEqual([
      "toolbar, orientated horizontally",
      "2",
    ]);
  });
});
