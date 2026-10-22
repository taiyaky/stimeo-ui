import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarController } from "../src/controllers/calendar_controller";
import { DateRangePickerController } from "../src/controllers/date_range_picker_controller";
import { press } from "./helpers/keyboard";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * `stimeo--calendar` and `stimeo--date-range-picker` paint consecutive civil dates, clamp
 * month and year moves to the month end, and move focus without selecting.
 */
describe.each(["calendar", "date-range-picker"] as const)("%s civil dates", (component) => {
  let application: Application;
  const identifier = `stimeo--${component}`;
  const target = component === "calendar" ? "day" : "cell";
  const label = component === "calendar" ? "label" : "monthLabel";

  const root = (): HTMLElement => {
    const element = document.getElementById("dates");
    if (!element) throw new Error("Expected calendar-family root");
    return element;
  };
  const cell = (date: string): HTMLElement => {
    const element = root().querySelector<HTMLElement>(`[data-date="${date}"]`);
    if (!element) throw new Error(`Expected date cell ${date}`);
    return element;
  };
  const stops = (): string[] =>
    Array.from(
      root().querySelectorAll<HTMLElement>('[role="gridcell"][tabindex="0"]'),
      (element) => element.getAttribute("data-date") ?? "",
    );
  const fields = (): string[] =>
    Array.from(
      root().querySelectorAll<HTMLInputElement>('input[type="hidden"]'),
      (element) => element.value,
    );

  const mount = async (date: string, weekStart = 0, shownMonth = date.slice(0, 7)) => {
    const rows = Array.from(
      { length: 6 },
      () =>
        `<div role="row">${Array.from(
          { length: 7 },
          () => `<button type="button" role="gridcell" tabindex="-1"
        data-${identifier}-target="${target}"
        ${component === "date-range-picker" ? `data-action="focus->${identifier}#previewTo"` : ""}></button>`,
        ).join("")}</div>`,
    ).join("");
    const values =
      component === "calendar"
        ? `data-${identifier}-month-value="${shownMonth}" data-${identifier}-selected-value="${date}"
         data-${identifier}-week-start-value="${weekStart}"`
        : "";
    const hiddenFields =
      component === "calendar"
        ? `<input type="hidden" data-${identifier}-target="field" />`
        : `<input type="hidden" value="${date}" data-${identifier}-target="startField" />
         <input type="hidden" value="${date}" data-${identifier}-target="endField" />`;
    document.body.innerHTML = `<div id="dates" data-controller="${identifier}" ${values}>
      <button type="button" data-action="click->${identifier}#prev">Previous</button>
      <span id="dates-label" data-${identifier}-target="${label}"></span>
      <button type="button" data-action="click->${identifier}#next">Next</button>
      <div role="grid" aria-labelledby="dates-label" data-${identifier}-target="grid"
        data-action="keydown->${identifier}#onKeydown">${rows}</div>${hiddenFields}</div>`;
    application = Application.start();
    if (component === "calendar") application.register(identifier, CalendarController);
    else application.register(identifier, DateRangePickerController);
    await tick();
  };

  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2030, 6, 17));
  });
  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("lang");
    vi.useRealTimers();
  });

  it("paints all 42 consecutive civil dates across the spring clock change", async () => {
    await mount("2026-03-15");
    expect(
      Array.from(root().querySelectorAll('[role="gridcell"]'), (element) =>
        element.getAttribute("data-date"),
      ),
    ).toEqual(
      `
      2026-03-01 2026-03-02 2026-03-03 2026-03-04 2026-03-05 2026-03-06 2026-03-07
      2026-03-08 2026-03-09 2026-03-10 2026-03-11 2026-03-12 2026-03-13 2026-03-14
      2026-03-15 2026-03-16 2026-03-17 2026-03-18 2026-03-19 2026-03-20 2026-03-21
      2026-03-22 2026-03-23 2026-03-24 2026-03-25 2026-03-26 2026-03-27 2026-03-28
      2026-03-29 2026-03-30 2026-03-31 2026-04-01 2026-04-02 2026-04-03 2026-04-04
      2026-04-05 2026-04-06 2026-04-07 2026-04-08 2026-04-09 2026-04-10 2026-04-11
    `
        .trim()
        .split(/\s+/),
    );
    expect(stops()).toEqual(["2026-03-15"]);
  });

  it.each([
    ["2026-01-31", "PageDown", false, "2026-02-28"],
    ["2024-01-31", "PageDown", false, "2024-02-29"],
    ["2026-03-31", "PageUp", false, "2026-02-28"],
    ["2026-12-31", "PageDown", false, "2027-01-31"],
    ["2026-01-31", "PageUp", false, "2025-12-31"],
    ["2024-02-29", "PageDown", true, "2025-02-28"],
    ["2024-02-29", "PageUp", true, "2023-02-28"],
  ] as const)(
    "moves %s with %s (Shift=%s) to %s without selecting",
    async (date, key, shiftKey, expected) => {
      await mount(date);
      const beforeFields = fields();
      const reports: string[] = [];
      const selections: Event[] = [];
      root().addEventListener(`${identifier}:monthchange`, (event) => {
        reports.push((event as CustomEvent<{ month: string }>).detail.month);
      });
      root().addEventListener(
        `${identifier}:${component === "calendar" ? "select" : "change"}`,
        (event) => selections.push(event),
      );
      expect(press(cell(date), key, { shiftKey }).defaultPrevented).toBe(true);
      await tick();
      expect(stops()).toEqual([expected]);
      expect(document.activeElement).toBe(cell(expected));
      expect(fields()).toEqual(beforeFields);
      expect(reports).toEqual([expected.slice(0, 7)]);
      expect(selections).toEqual([]);
    },
  );

  it("keeps the button's month-end clamp separate from today's priority", async () => {
    vi.setSystemTime(new Date(2026, 5, 17));
    await mount("2026-05-31");
    const beforeFields = fields();
    const next = root().querySelector<HTMLButtonElement>(
      `[data-action="click->${identifier}#next"]`,
    );
    if (!next) throw new Error("Expected next-month button");
    next.click();
    await tick();
    expect(stops()).toEqual([component === "calendar" ? "2026-06-17" : "2026-06-30"]);
    expect(fields()).toEqual(beforeFields);
  });

  if (component === "calendar") {
    it.each([
      [0, "2026-05-31", "2026-07-11"],
      [1, "2026-06-01", "2026-07-12"],
      [2, "2026-05-26", "2026-07-06"],
      [3, "2026-05-27", "2026-07-07"],
      [4, "2026-05-28", "2026-07-08"],
      [5, "2026-05-29", "2026-07-09"],
      [6, "2026-05-30", "2026-07-10"],
    ] as const)(
      "uses week start %s for the complete six-week grid",
      async (weekStart, first, last) => {
        await mount("2026-06-15", weekStart);
        const cells = root().querySelectorAll('[role="gridcell"]');
        expect(cells).toHaveLength(42);
        expect(cells[0]?.getAttribute("data-date")).toBe(first);
        expect(cells[41]?.getAttribute("data-date")).toBe(last);
        expect(stops()).toEqual(["2026-06-15"]);
      },
    );
  } else {
    it("moves from the displayed month when focus is on a neighbouring month", async () => {
      await mount("2026-06-15");
      cell("2026-05-31").focus();
      await tick();
      expect(stops()).toEqual(["2026-05-31"]);
      const next = root().querySelector<HTMLButtonElement>(
        `[data-action="click->${identifier}#next"]`,
      );
      if (!next) throw new Error("Expected next-month button");
      next.click();
      await tick();
      expect(stops()).toEqual(["2026-07-31"]);
      expect(fields()).toEqual(["2026-06-15", "2026-06-15"]);
    });
  }
});
