import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { DateRangePickerController } from "../src/controllers/date_range_picker_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link DateRangePickerController}: two-point range
 * selection with auto-swap, in-progress preview, presets, grid keyboard
 * navigation with roving focus, Escape-to-cancel, and the `change` event.
 *
 * The hidden fields are pre-filled so the view month and confirmed range are
 * deterministic (no dependence on the current date), except where a preset is
 * exercised explicitly.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Builds a six-row grid of 7 cell targets each (42 total). */
function gridRows(): string {
  let rows = "";
  for (let r = 0; r < 6; r++) {
    let cells = "";
    for (let c = 0; c < 7; c++) {
      cells += `<button type="button" role="gridcell" tabindex="-1"
        data-stimeo--date-range-picker-target="cell"
        data-action="click->stimeo--date-range-picker#selectDate
                     mouseenter->stimeo--date-range-picker#previewTo
                     focus->stimeo--date-range-picker#previewTo
                     keydown->stimeo--date-range-picker#onKeydown"></button>`;
    }
    rows += `<div role="row">${cells}</div>`;
  }
  return rows;
}

describe("DateRangePickerController", () => {
  let application: Application;

  const mount = async ({ start = "2026-06-10", end = "2026-06-20" } = {}) => {
    document.body.innerHTML = `
      <div data-controller="stimeo--date-range-picker">
        <button type="button" data-action="stimeo--date-range-picker#prev">Prev</button>
        <span id="drp-month" aria-live="polite"
              data-stimeo--date-range-picker-target="monthLabel"></span>
        <button type="button" data-action="stimeo--date-range-picker#next">Next</button>
        <div role="grid" aria-labelledby="drp-month"
             data-stimeo--date-range-picker-target="grid">
          ${gridRows()}
        </div>
        <div role="group" aria-label="Presets">
          <button type="button" data-range="today"
                  data-action="stimeo--date-range-picker#applyPreset">Today</button>
          <button type="button" data-range="last7"
                  data-action="stimeo--date-range-picker#applyPreset">Last 7</button>
          <button type="button" data-range="thisMonth"
                  data-action="stimeo--date-range-picker#applyPreset">This month</button>
          <button type="button" data-range="nope"
                  data-action="stimeo--date-range-picker#applyPreset">Unknown</button>
        </div>
        <span role="status" aria-live="polite"
              data-stimeo--date-range-picker-target="status"></span>
        <input type="hidden" value="${start}" data-stimeo--date-range-picker-target="startField" />
        <input type="hidden" value="${end}" data-stimeo--date-range-picker-target="endField" />
      </div>`;
    application = Application.start();
    application.register("stimeo--date-range-picker", DateRangePickerController);
    await tick();
  };

  afterEach(() => {
    application?.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>(
      "[data-controller='stimeo--date-range-picker']",
    ) as HTMLElement;
  const monthLabel = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--date-range-picker-target='monthLabel']",
    ) as HTMLElement;
  const navButton = (action: "prev" | "next") =>
    document.querySelector<HTMLElement>(
      `[data-action='stimeo--date-range-picker#${action}']`,
    ) as HTMLElement;
  const cell = (iso: string) =>
    document.querySelector<HTMLElement>(`[data-date='${iso}']`) as HTMLElement;
  const preset = (name: string) =>
    document.querySelector<HTMLElement>(`[data-range='${name}']`) as HTMLElement;
  const status = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--date-range-picker-target='status']",
    ) as HTMLElement;
  const field = (which: "start" | "end") =>
    document.querySelector<HTMLInputElement>(
      `[data-stimeo--date-range-picker-target='${which}Field']`,
    ) as HTMLInputElement;
  const click = (iso: string) =>
    cell(iso).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const hover = (iso: string) =>
    cell(iso).dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  const key = (el: HTMLElement, k: string) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  it("renders the confirmed range: ends selected, inner cells in range", async () => {
    await mount();
    expect(cell("2026-06-10").getAttribute("aria-selected")).toBe("true");
    expect(cell("2026-06-20").getAttribute("aria-selected")).toBe("true");
    expect(cell("2026-06-10").hasAttribute("data-range-start")).toBe(true);
    expect(cell("2026-06-20").hasAttribute("data-range-end")).toBe(true);
    expect(cell("2026-06-15").hasAttribute("data-in-range")).toBe(true);
    expect(cell("2026-06-15").getAttribute("aria-selected")).toBe("false");
    // Boundaries are excluded from the inner-range hook.
    expect(cell("2026-06-10").hasAttribute("data-in-range")).toBe(false);
  });

  it("selects a fresh range over two clicks and dispatches change", async () => {
    await mount();
    const detail: Array<{ start: string; end: string }> = [];
    root().addEventListener("stimeo--date-range-picker:change", (e) => {
      detail.push((e as CustomEvent).detail);
    });

    click("2026-06-05"); // pending start
    expect(cell("2026-06-05").hasAttribute("data-range-start")).toBe(true);
    expect(detail).toEqual([]); // not confirmed yet

    click("2026-06-08"); // confirm end
    expect(detail).toEqual([{ start: "2026-06-05", end: "2026-06-08" }]);
    expect(field("start").value).toBe("2026-06-05");
    expect(field("end").value).toBe("2026-06-08");
    expect(status().textContent).toBe("2026-06-05 – 2026-06-08");
  });

  it("auto-swaps when the second click precedes the first", async () => {
    await mount();
    click("2026-06-08");
    click("2026-06-05");
    expect(field("start").value).toBe("2026-06-05");
    expect(field("end").value).toBe("2026-06-08");
  });

  it("previews the range up to a hovered cell while selecting", async () => {
    await mount();
    click("2026-06-05"); // pending start
    hover("2026-06-09");
    expect(cell("2026-06-07").hasAttribute("data-in-range")).toBe(true);
    expect(cell("2026-06-09").hasAttribute("data-range-end")).toBe(true);
  });

  it("cancels an in-progress selection on Escape, restoring the confirmed range", async () => {
    await mount();
    click("2026-06-05"); // pending start replaces preview
    key(cell("2026-06-05"), "Escape");
    // Confirmed range is shown again; the abandoned start is no longer marked.
    expect(cell("2026-06-05").hasAttribute("data-range-start")).toBe(false);
    expect(cell("2026-06-10").getAttribute("aria-selected")).toBe("true");
    expect(field("start").value).toBe("2026-06-10");
  });

  it("moves roving focus with the arrow keys", async () => {
    await mount();
    expect(cell("2026-06-10").getAttribute("tabindex")).toBe("0");
    key(cell("2026-06-10"), "ArrowRight");
    expect(cell("2026-06-11").getAttribute("tabindex")).toBe("0");
    expect(cell("2026-06-10").getAttribute("tabindex")).toBe("-1");
    key(cell("2026-06-11"), "ArrowDown");
    expect(cell("2026-06-18").getAttribute("tabindex")).toBe("0");
  });

  it("re-rolls the roving tab stop when focus lands on a non-stop cell", async () => {
    await mount();
    expect(cell("2026-06-10").getAttribute("tabindex")).toBe("0"); // initial stop

    // External focus (Tab / click / programmatic) onto a different, non-stop cell
    // must move the roving tab stop to it, not leave it stale until the next paint.
    cell("2026-06-15").dispatchEvent(new FocusEvent("focus"));
    expect(cell("2026-06-15").getAttribute("tabindex")).toBe("0");
    expect(cell("2026-06-10").getAttribute("tabindex")).toBe("-1");
  });

  it("leaves the roving stop untouched when focus lands on the current stop", async () => {
    // The guard re-rolls only for a non-stop cell. After the grid's own arrow
    // navigation focuses the new stop, that focus event must be a no-op (the cell
    // is already the tab stop) — this is what prevents a redundant double-render.
    await mount();
    key(cell("2026-06-10"), "ArrowRight"); // roving stop → 06-11, which is focused
    expect(cell("2026-06-11").getAttribute("tabindex")).toBe("0");

    cell("2026-06-11").dispatchEvent(new FocusEvent("focus")); // the focus a real focus() fires
    // Still the only stop; nothing shifted.
    expect(cell("2026-06-11").getAttribute("tabindex")).toBe("0");
    expect(cell("2026-06-10").getAttribute("tabindex")).toBe("-1");
  });

  it("confirms a single-day range from the today preset", async () => {
    await mount();
    const detail: Array<{ start: string; end: string }> = [];
    root().addEventListener("stimeo--date-range-picker:change", (e) => {
      detail.push((e as CustomEvent).detail);
    });
    document
      .querySelector<HTMLElement>("[data-range='today']")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(detail).toHaveLength(1);
    expect(detail[0]?.start).toBe(detail[0]?.end);
  });

  it("disables out-of-bounds cells", async () => {
    document.body.innerHTML = "";
    application = Application.start();
    application.register("stimeo--date-range-picker", DateRangePickerController);
    document.body.innerHTML = `
      <div data-controller="stimeo--date-range-picker"
           data-stimeo--date-range-picker-min-value="2026-06-05"
           data-stimeo--date-range-picker-max-value="2026-06-25">
        <span id="m" data-stimeo--date-range-picker-target="monthLabel"></span>
        <div role="grid" aria-labelledby="m"
             data-stimeo--date-range-picker-target="grid">${gridRows()}</div>
        <input type="hidden" value="2026-06-10" data-stimeo--date-range-picker-target="startField" />
        <input type="hidden" value="2026-06-20" data-stimeo--date-range-picker-target="endField" />
      </div>`;
    await tick();
    expect(cell("2026-06-04").getAttribute("aria-disabled")).toBe("true");
    expect(cell("2026-06-10").hasAttribute("aria-disabled")).toBe(false);
    // A click on a disabled cell does not start a selection.
    click("2026-06-04");
    expect(cell("2026-06-04").hasAttribute("data-range-start")).toBe(false);
  });

  it("renders a localized month label and navigates with prev/next", async () => {
    await mount();
    expect(monthLabel().textContent).toBe("June 2026");
    navButton("prev").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(monthLabel().textContent).toBe("May 2026");
    expect(cell("2026-05-15")).not.toBeNull();
    navButton("next").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    navButton("next").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(monthLabel().textContent).toBe("July 2026");
  });

  it("confirms a range over two cells via Enter, moving focus with arrows", async () => {
    await mount();
    const detail: Array<{ start: string; end: string }> = [];
    root().addEventListener("stimeo--date-range-picker:change", (e) => {
      detail.push((e as CustomEvent).detail);
    });
    key(cell("2026-06-10"), "Enter"); // pending start
    key(cell("2026-06-10"), "ArrowRight"); // roving focus → 06-11
    expect(cell("2026-06-11").getAttribute("tabindex")).toBe("0");
    key(cell("2026-06-11"), " "); // Space confirms
    expect(detail).toEqual([{ start: "2026-06-10", end: "2026-06-11" }]);
  });

  it("moves to week edges with Home/End", async () => {
    await mount();
    // 2026-06-10 is a Wednesday; the week runs Sun 06-07 … Sat 06-13.
    key(cell("2026-06-10"), "Home");
    expect(cell("2026-06-07").getAttribute("tabindex")).toBe("0");
    key(cell("2026-06-07"), "End");
    expect(cell("2026-06-13").getAttribute("tabindex")).toBe("0");
  });

  it("moves up a week and crosses months with PageUp", async () => {
    await mount();
    key(cell("2026-06-10"), "ArrowUp"); // → 06-03
    expect(cell("2026-06-03").getAttribute("tabindex")).toBe("0");
    key(cell("2026-06-03"), "PageUp"); // → 05-03 (month transition, deferred focus)
    await tick();
    expect(monthLabel().textContent).toBe("May 2026");
    expect(cell("2026-05-03").getAttribute("tabindex")).toBe("0");
  });

  it("applies the last-7-days preset as a 7-day range ending today", async () => {
    await mount();
    const detail: Array<{ start: string; end: string }> = [];
    root().addEventListener("stimeo--date-range-picker:change", (e) => {
      detail.push((e as CustomEvent).detail);
    });
    // Mirror the controller's own date math so the test is timezone/run-date safe.
    const today = new Date();
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const start = new Date(today);
    start.setDate(today.getDate() - 6);

    preset("last7").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(detail).toEqual([{ start: iso(start), end: iso(today) }]);
  });

  it("applies the this-month preset spanning the whole current month", async () => {
    await mount();
    const detail: Array<{ start: string; end: string }> = [];
    root().addEventListener("stimeo--date-range-picker:change", (e) => {
      detail.push((e as CustomEvent).detail);
    });
    const today = new Date();
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    preset("thisMonth").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(detail).toEqual([{ start: iso(first), end: iso(last) }]);
  });

  it("ignores an unknown preset name", async () => {
    await mount();
    const detail: unknown[] = [];
    root().addEventListener("stimeo--date-range-picker:change", (e) => {
      detail.push((e as CustomEvent).detail);
    });
    preset("nope").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(detail).toEqual([]);
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount();
    await expectNoA11yViolations(root());
  });

  // Layer ③ — speech-order regression scoped to a range endpoint. Pins the
  // gridcell role, the accessible name (the day number), and the selected state
  // so a lost role/name or a dropped aria-selected surfaces as a diff.
  it("announces the endpoint cell's role, name, and selected state", async () => {
    await mount();
    const spoken = await captureSpeech({ container: cell("2026-06-10"), steps: 0 });
    expect(spoken).toEqual(["gridcell, 10, selected"]);
  });
});
