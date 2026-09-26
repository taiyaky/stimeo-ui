import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarController } from "../src/controllers/calendar_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureFieldCommits } from "./helpers/field_commits";
import { press } from "./helpers/keyboard";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { delay, tick } from "./helpers/timing";

// The month label is formatted in the resolved locale, so a case that declares
// no language would otherwise read the runner's. Pin one for the whole file and
// let the cases that care declare their own.
beforeEach(() => {
  document.documentElement.lang = "en";
});

afterEach(() => {
  document.documentElement.removeAttribute("lang");
});

describe("CalendarController", () => {
  let application: Application;

  // Helper to generate 42 empty cells markup
  const generateCellsHTML = () => {
    let html = "";
    for (let i = 0; i < 6; i++) {
      html += '<tr role="row">';
      for (let j = 0; j < 7; j++) {
        html += '<td role="gridcell" data-stimeo--calendar-target="day" tabindex="-1"></td>';
      }
      html += "</tr>";
    }
    return html;
  };

  beforeEach(async () => {
    document.body.innerHTML = `
      <div id="calendar" data-controller="stimeo--calendar"
           data-stimeo--calendar-month-value="2026-05"
           data-stimeo--calendar-selected-value="2026-05-31"
           data-stimeo--calendar-min-value="2026-05-01"
           data-stimeo--calendar-max-value="2026-06-15"
           data-stimeo--calendar-week-start-value="0">
        <div>
          <button id="btn-prev" data-action="click->stimeo--calendar#prev">‹</button>
          <span id="label" data-stimeo--calendar-target="label"></span>
          <button id="btn-next" data-action="click->stimeo--calendar#next">›</button>
        </div>
        <table role="grid" aria-labelledby="label">
          <tbody data-stimeo--calendar-target="grid"
                 data-action="keydown->stimeo--calendar#onKeydown click->stimeo--calendar#selectByClick">
            ${generateCellsHTML()}
          </tbody>
        </table>
      </div>
    `;

    application = Application.start();
    application.register("stimeo--calendar", CalendarController);
    await delay(150);
  });

  afterEach(async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    await delay(50);
  });

  it("initializes month grid cells correctly", () => {
    const days = document.querySelectorAll("[data-stimeo--calendar-target='day']");
    expect(days).toHaveLength(42);

    // 2026-05-01 is Friday. Since weekStart is 0 (Sunday), the grid starts on April 26.
    expect(days[0]?.getAttribute("data-date")).toBe("2026-04-26");
    expect(days[0]?.textContent).toBe("26");
    expect(days[0]?.getAttribute("data-outside")).toBe("true");

    // 2026-05-01 cell (Index 5)
    expect(days[5]?.getAttribute("data-date")).toBe("2026-05-01");
    expect(days[5]?.textContent).toBe("1");
    expect(days[5]?.getAttribute("data-outside")).toBe("false");

    // Selected cell 2026-05-31 (Index 35)
    expect(days[35]?.getAttribute("data-date")).toBe("2026-05-31");
    expect(days[35]?.getAttribute("aria-selected")).toBe("true");
    expect(days[35]?.getAttribute("tabindex")).toBe("0"); // roving focus should sit on the selected day

    // Out of bounds cell (min: 2026-05-01, max: 2026-06-15)
    // April 26 is below min, should be disabled
    expect(days[0]?.getAttribute("aria-disabled")).toBe("true");
    // The 42 cells run April 26 (0) … April 30 (4), May 1 (5) … May 31 (35),
    // June 1 (36) … June 6 (41), so the last cell is still inside max 06-15.
    expect(days[41]?.getAttribute("data-date")).toBe("2026-06-06");
    expect(days[41]?.getAttribute("aria-disabled")).toBeNull();
  });

  it("navigates months with prev/next buttons", async () => {
    const controller = application.getControllerForElementAndIdentifier(
      document.getElementById("calendar") as HTMLElement,
      "stimeo--calendar",
    ) as CalendarController;
    const label = document.getElementById("label");

    expect(label?.textContent).toContain("May 2026");

    // Go to next month (June 2026). `next` writes the month Value and its callback
    // repaints; the callback is called directly so the assertion does not wait on
    // the value observer.
    controller.next();
    controller.monthValueChanged();

    expect(label?.textContent).toContain("June 2026");

    // Go back two months (April 2026)
    controller.prev();
    controller.monthValueChanged();
    controller.prev();
    controller.monthValueChanged();

    expect(label?.textContent).toContain("April 2026");
  });

  it("handles day selection and select event dispatching", async () => {
    const controller = application.getControllerForElementAndIdentifier(
      document.getElementById("calendar") as HTMLElement,
      "stimeo--calendar",
    ) as CalendarController;
    const calendar = document.getElementById("calendar");
    const selectHandler = vi.fn();
    calendar?.addEventListener("stimeo--calendar:select", selectHandler);

    // May 15 is index 19 (April 26 + 19 days = May 15)
    const days = document.querySelectorAll("[data-stimeo--calendar-target='day']");
    const targetCell = days[19] as HTMLElement;

    expect(targetCell.getAttribute("data-date")).toBe("2026-05-15");
    expect(targetCell.getAttribute("aria-selected")).toBe("false");

    // Selecting repaints in the same call, so the grid is read straight after it.
    controller.selectDayElement(targetCell);

    expect(targetCell.getAttribute("aria-selected")).toBe("true");
    expect(selectHandler).toHaveBeenCalledOnce();
    expect(selectHandler.mock.calls[0]?.[0]?.detail).toEqual({ date: "2026-05-15" });

    // Disabled day cannot be selected
    const disabledCell = days[0] as HTMLElement; // April 26 (disabled)
    controller.selectDayElement(disabledCell);
    expect(disabledCell.getAttribute("aria-selected")).toBe("false");
  });

  it.each([
    ["is padded with whitespace", " day "],
    ["lists a second name", "day label"],
  ])(
    "selects and navigates through a cell whose target declaration %s",
    async (_label, declaration) => {
      // The target attribute is a space-separated token list, so an element is a
      // day whenever the name is one of its tokens — not only when it is the
      // whole attribute value.
      const days = document.querySelectorAll<HTMLElement>("[data-stimeo--calendar-target='day']");
      const cell = days[19] as HTMLElement; // 2026-05-15
      expect(cell.getAttribute("data-date")).toBe("2026-05-15");
      cell.setAttribute("data-stimeo--calendar-target", declaration);

      const selected: string[] = [];
      document.getElementById("calendar")?.addEventListener("stimeo--calendar:select", (event) => {
        selected.push((event as CustomEvent<{ date: string }>).detail.date);
      });

      cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await delay(20);

      expect(selected).toEqual(["2026-05-15"]);
      expect(cell.getAttribute("aria-selected")).toBe("true");

      // The keyboard route resolves the cell the same way the click does.
      press(cell, "ArrowRight");
      await delay(20);

      const roving = Array.from(document.querySelectorAll<HTMLElement>('[role="gridcell"]')).filter(
        (day) => day.getAttribute("tabindex") === "0",
      );
      expect(roving.map((day) => day.getAttribute("data-date"))).toEqual(["2026-05-16"]);
    },
  );

  it("keyboard navigation wraps and manages month changes with date clamping", async () => {
    await delay(50);
    const days = document.querySelectorAll("[data-stimeo--calendar-target='day']");
    const startCell = days[35] as HTMLElement; // May 31 (tabindex="0")

    startCell.focus();

    // ArrowRight from May 31 should transition to June 1st and trigger month change automatically
    const rightEvent = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true });
    startCell.dispatchEvent(rightEvent);
    await tick();

    const label = document.getElementById("label");
    expect(label?.textContent).toContain("June 2026");

    // Ensure focus moves to June 1st
    const activeCell = document.activeElement;
    expect(activeCell?.getAttribute("data-date")).toBe("2026-06-01");
    expect(activeCell?.getAttribute("tabindex")).toBe("0");

    // Shift+PageDown (Next year) from June 1st should go to June 1st, 2027
    const shiftPageDown = new KeyboardEvent("keydown", {
      key: "PageDown",
      shiftKey: true,
      bubbles: true,
    });
    activeCell?.dispatchEvent(shiftPageDown);
    await tick();

    expect(label?.textContent).toContain("June 2027");
    expect(document.activeElement?.getAttribute("data-date")).toBe("2027-06-01");

    // Testing date clamping: March 31st to April (which has 30 days)
    // First set calendar to March 31st
    const controller = application.getControllerForElementAndIdentifier(
      document.getElementById("calendar") as HTMLElement,
      "stimeo--calendar",
    ) as CalendarController;
    controller.selectedValue = "2026-03-31";
    controller.monthValue = "2026-03";
    controller.focusedDate = new Date(2026, 2, 31);
    // The month Value's callback repaints; it is called directly rather than
    // waiting on the value observer.
    controller.monthValueChanged();

    expect(label?.textContent).toContain("March 2026");
    const currentActive = document.querySelector("[tabindex='0']") as HTMLElement;
    expect(currentActive.getAttribute("data-date")).toBe("2026-03-31");

    // Press PageDown (Next month) from March 31st. Should clamp to April 30th.
    const pageDown = new KeyboardEvent("keydown", { key: "PageDown", bubbles: true });
    currentActive.dispatchEvent(pageDown);
    await tick();

    expect(label?.textContent).toContain("April 2026");
    expect(document.activeElement?.getAttribute("data-date")).toBe("2026-04-30");
  });

  it("handles t/T keyboard shortcut to focus today's date", async () => {
    await delay(50);
    const days = document.querySelectorAll("[data-stimeo--calendar-target='day']");
    const activeCell = days[35] as HTMLElement; // May 31
    activeCell.focus();

    // Trigger 't' key down
    const tEvent = new KeyboardEvent("keydown", { key: "t", bubbles: true });
    activeCell.dispatchEvent(tEvent);
    await tick();

    // Expected today YYYY-MM-DD string resolved from local timezone
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    const expectedTodayStr = `${y}-${m}-${d}`;

    expect(document.activeElement?.getAttribute("data-date")).toBe(expectedTodayStr);
    expect(document.activeElement?.getAttribute("tabindex")).toBe("0");
  });

  it("renders the grid only once per automatic month transition (no double render)", async () => {
    await delay(50);
    // Every paint writes the month label once, so the label's additions count
    // the paints.
    const label = document.getElementById("label") as HTMLElement;
    const labelRecords: MutationRecord[] = [];
    const labelObserver = new MutationObserver((records) => labelRecords.push(...records));
    labelObserver.observe(label, { childList: true });
    const monthChanges: string[] = [];
    document.getElementById("calendar")?.addEventListener("stimeo--calendar:monthchange", (e) => {
      monthChanges.push((e as CustomEvent<{ month: string }>).detail.month);
    });

    const days = document.querySelectorAll("[data-stimeo--calendar-target='day']");
    const startCell = days[35] as HTMLElement; // May 31 (tabindex="0")
    startCell.focus();

    // ArrowRight crosses into June: assigning monthValue drives the single
    // re-render via monthValueChanged — the controller must not also render
    // synchronously, or the month would paint twice.
    startCell.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await tick();
    labelRecords.push(...labelObserver.takeRecords());
    labelObserver.disconnect();

    expect(label.textContent).toContain("June 2026");
    expect(document.activeElement?.getAttribute("data-date")).toBe("2026-06-01");
    expect(labelRecords.filter((record) => record.addedNodes.length > 0)).toHaveLength(1);
    expect(monthChanges).toEqual(["2026-06"]);
  });

  it("has no machine-detectable a11y violations", async () => {
    await expectNoA11yViolations(document.getElementById("calendar") as HTMLElement);
  });

  it("announces selected gridcell role, state, and label in order before and after selection", async () => {
    const days = document.querySelectorAll("[data-stimeo--calendar-target='day']");
    const initialSelected = days[35] as HTMLElement; // May 31 (initially selected)

    // captureSpeech returns (steps + 1) phrases; steps=0 captures exactly the initial
    // focus announcement — the cell's composite phrase "role, text, state".
    const beforePhrases = await captureSpeech({ container: initialSelected, steps: 0 });
    expect(beforePhrases).toEqual(["gridcell, 31, selected"]);

    const controller = application.getControllerForElementAndIdentifier(
      document.getElementById("calendar") as HTMLElement,
      "stimeo--calendar",
    ) as CalendarController;

    // Select a different day (May 15, index 19). Selecting repaints in the same call.
    const newTarget = days[19] as HTMLElement;
    controller.selectDayElement(newTarget);

    // After selection, May 15 is selected and May 31 is no longer selected.
    const afterSelectedPhrases = await captureSpeech({ container: newTarget, steps: 0 });
    const afterDeselectedPhrases = await captureSpeech({ container: initialSelected, steps: 0 });

    expect(afterSelectedPhrases).toEqual(["gridcell, 15, selected"]);
    // Previously-selected cell announces "not selected" after deselection.
    expect(afterDeselectedPhrases).toEqual(["gridcell, 31, not selected"]);
  });

  it("moves no focus once disconnected, even when the month paint arrives after", async () => {
    const days = document.querySelectorAll("[data-stimeo--calendar-target='day']");
    const startCell = days[35] as HTMLElement; // May 31 (tabindex="0")
    startCell.focus();

    const controller = application.getControllerForElementAndIdentifier(
      document.getElementById("calendar") as HTMLElement,
      "stimeo--calendar",
    ) as CalendarController;

    // Spy to detect any .focus() call the controller makes after it disconnects.
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      // ArrowRight from May 31 crosses into June: the key writes the month
      // Value, and the paint of June — the step that moves focus — arrives
      // later through the Value callback.
      startCell.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      const callsBeforeDisconnect = focusSpy.mock.calls.length;

      // Disconnecting the controller directly leaves Stimulus's Value observer
      // running, so the month callback still arrives: June is painted, and that
      // paint must not reach for focus on behalf of a disconnected controller.
      controller.disconnect();

      await delay(50);
      expect(document.getElementById("label")?.textContent).toContain("June 2026");
      expect(focusSpy.mock.calls.length).toBe(callsBeforeDisconnect);
    } finally {
      focusSpy.mockRestore();
    }
  });

  const roving = () =>
    document.querySelector<HTMLElement>("[data-stimeo--calendar-target='day'][tabindex='0']");
  // The controller reads the active day cell, so drive keys from the roving cell.
  const sendKey = (key: string) => {
    const cell = roving();
    if (cell) press(cell, key);
  };

  it("reverses the horizontal arrows under RTL, leaving the week jump alone", async () => {
    // Logical direction: the columns mirror under RTL, so "next" is to the left.
    // `dir="rtl"` is the authoring contract, but happy-dom does not resolve it
    // into the computed style, so the direction is set inline instead.
    (
      document.querySelector("[data-controller='stimeo--calendar']") as HTMLElement
    ).style.direction = "rtl";
    // Roving starts on 2026-05-31, so the assertions move *backwards* first to
    // stay inside the rendered month.
    expect(roving()?.getAttribute("data-date")).toBe("2026-05-31");

    sendKey("ArrowRight"); // "previous day" under RTL
    expect(roving()?.getAttribute("data-date")).toBe("2026-05-30");

    sendKey("ArrowLeft"); // "next day"
    expect(roving()?.getAttribute("data-date")).toBe("2026-05-31");

    sendKey("ArrowUp"); // -7 days regardless of direction
    expect(roving()?.getAttribute("data-date")).toBe("2026-05-24");
  });

  it("PageDown moves the roving focus into the next month, PageUp into the previous", async () => {
    // Roving starts on the selected day, 2026-05-31.
    expect(roving()?.getAttribute("data-date")).toBe("2026-05-31");

    sendKey("PageDown");
    await delay(20);
    expect(roving()?.getAttribute("data-date")?.startsWith("2026-06")).toBe(true);

    sendKey("PageUp");
    await delay(20);
    expect(roving()?.getAttribute("data-date")?.startsWith("2026-05")).toBe(true);
  });

  it("Enter selects the currently focused in-bounds day", async () => {
    sendKey("ArrowLeft"); // 2026-05-31 → 2026-05-30
    await delay(20);
    expect(roving()?.getAttribute("data-date")).toBe("2026-05-30");

    const details: Array<{ date: string }> = [];
    document
      .getElementById("calendar")
      ?.addEventListener("stimeo--calendar:select", (event) =>
        details.push((event as CustomEvent).detail),
      );
    sendKey("Enter");
    await delay(20);
    const focused = roving();
    expect(focused?.getAttribute("aria-selected")).toBe("true");
    expect(details.map((d) => d.date)).toEqual(["2026-05-30"]);
  });

  it("ignores a click on an out-of-bounds (disabled) day", async () => {
    const days = document.querySelectorAll<HTMLElement>("[data-stimeo--calendar-target='day']");
    const disabled = days[0]; // 2026-04-26, below min → aria-disabled
    expect(disabled?.getAttribute("aria-disabled")).toBe("true");

    const details: unknown[] = [];
    document
      .getElementById("calendar")
      ?.addEventListener("stimeo--calendar:select", (event) => details.push(event));
    disabled?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(details).toEqual([]);
    expect(disabled?.getAttribute("aria-selected")).not.toBe("true");
  });
  it("keeps exactly one focusable day when selected sits outside the shown month", async () => {
    // Roving tabindex is the grid's only way in: the paint gives tabindex="0" to
    // the cell matching focusedDate, so a focusedDate outside the 42 rendered
    // days leaves every cell at -1 and the grid unreachable by Tab.
    document.body.innerHTML = `
      <div id="cal2" data-controller="stimeo--calendar"
           data-stimeo--calendar-month-value="2026-05"
           data-stimeo--calendar-selected-value="2026-06-20">
        <table role="grid">
          <tbody data-stimeo--calendar-target="grid"
                 data-action="keydown->stimeo--calendar#onKeydown click->stimeo--calendar#selectByClick">
            ${generateCellsHTML()}
          </tbody>
        </table>
      </div>`;
    await delay(150);

    const focusable = document.querySelectorAll(
      "#cal2 [data-stimeo--calendar-target='day'][tabindex='0']",
    );
    expect(focusable).toHaveLength(1);
  });

  it("opens the tab stop on the 1st of a month that holds neither the selection nor today", async () => {
    // Today is pinned to a day other than the 1st, in another month. The Value
    // callbacks Stimulus runs before connect() paint from today's day of the
    // month, so the 1st comes from the paint connect() makes itself.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 23));
    try {
      document.body.innerHTML = `
        <div id="cal4" data-controller="stimeo--calendar"
             data-stimeo--calendar-month-value="2026-05">
          <table role="grid">
            <tbody data-stimeo--calendar-target="grid"
                   data-action="keydown->stimeo--calendar#onKeydown click->stimeo--calendar#selectByClick">
              ${generateCellsHTML()}
            </tbody>
          </table>
        </div>`;
      await delay(150);
    } finally {
      vi.useRealTimers();
    }

    const stops = document.querySelectorAll<HTMLElement>(
      "#cal4 [data-stimeo--calendar-target='day'][tabindex='0']",
    );
    expect(Array.from(stops, (cell) => cell.dataset.date)).toEqual(["2026-05-01"]);
  });

  it("keeps exactly one focusable day when selected is changed from outside", async () => {
    const controller = application.getControllerForElementAndIdentifier(
      document.getElementById("calendar") as HTMLElement,
      "stimeo--calendar",
    ) as CalendarController;

    controller.selectedValue = "2026-08-15";
    await delay(50);

    const focusable = document.querySelectorAll(
      "#calendar [data-stimeo--calendar-target='day'][tabindex='0']",
    );
    expect(focusable).toHaveLength(1);
  });

  it("ignores a keydown an outer handler already consumed", async () => {
    // Yield a key a descendant already consumed.
    const before = roving()?.getAttribute("data-date");
    const claim = (event: Event) => event.preventDefault();
    document.addEventListener("keydown", claim, true);
    try {
      roving()?.focus();
      roving()?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      );
      await delay(20);
    } finally {
      document.removeEventListener("keydown", claim, true);
    }
    expect(roving()?.getAttribute("data-date")).toBe(before);
  });

  // One case per modifier the guard tests, so dropping any single disjunct of
  // `ctrlKey || metaKey || altKey` fails here (Cmd+T is the macOS binding).
  it.each([["ctrlKey"], ["metaKey"], ["altKey"]] as const)(
    "leaves a %s chord over a printable key to the browser",
    async (modifier) => {
      const before = roving()?.getAttribute("data-date");
      const cell = roving() as HTMLElement;
      cell.focus();
      const event = new KeyboardEvent("keydown", {
        key: "t",
        [modifier]: true,
        bubbles: true,
        cancelable: true,
      });
      cell.dispatchEvent(event);
      await delay(20);

      expect(event.defaultPrevented).toBe(false);
      expect(roving()?.getAttribute("data-date")).toBe(before);
    },
  );

  it.each([
    ["ArrowDown", "2026-06-07"],
    ["ArrowUp", "2026-05-24"],
    ["Home", "2026-05-31"],
    ["End", "2026-06-06"],
  ])("%s moves the roving focus to %s from 2026-05-31", async (key, expected) => {
    expect(roving()?.getAttribute("data-date")).toBe("2026-05-31");
    sendKey(key as string);
    await delay(20);
    expect(roving()?.getAttribute("data-date")).toBe(expected);
  });

  it("leaves a modified arrow to the browser", async () => {
    // Alt+Arrow is a browser binding: the grid neither moves the roving focus
    // nor calls preventDefault().
    const before = roving()?.getAttribute("data-date");
    const event = press(roving() as HTMLElement, "ArrowRight", { altKey: true });
    await delay(20);

    expect(event.defaultPrevented).toBe(false);
    expect(roving()?.getAttribute("data-date")).toBe(before);
  });

  it("Shift+PageUp moves back one year", async () => {
    const cell = roving() as HTMLElement;
    cell.focus();
    cell.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", shiftKey: true, bubbles: true }),
    );
    await delay(50);
    expect(roving()?.getAttribute("data-date")).toBe("2025-05-31");
  });

  it("Space selects the focused day, like Enter", async () => {
    const details: Array<{ date: string }> = [];
    document.getElementById("calendar")?.addEventListener("stimeo--calendar:select", (event) => {
      details.push((event as CustomEvent<{ date: string }>).detail);
    });

    sendKey(" ");
    await delay(20);

    expect(details).toEqual([{ date: "2026-05-31" }]);
    expect(roving()?.getAttribute("aria-selected")).toBe("true");
  });

  it("T jumps to today, transitioning the month when needed", async () => {
    sendKey("T");
    await delay(50);

    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate(),
    ).padStart(2, "0")}`;
    expect(roving()?.getAttribute("data-date")).toBe(iso);
    expect(roving()?.getAttribute("data-today")).toBe("true");
  });

  it("marks exactly one cell as today when the shown month contains it", async () => {
    sendKey("T");
    await delay(50);
    const flagged = document.querySelectorAll(
      "[data-stimeo--calendar-target='day'][data-today='true']",
    );
    expect(flagged).toHaveLength(1);
  });

  it("disables days past max as well as days before min", async () => {
    // The fixture's max (2026-06-15) sits beyond the May grid, so drive to a
    // month where the upper bound actually bites.
    sendKey("PageDown");
    await delay(50);

    const days = Array.from(
      document.querySelectorAll<HTMLElement>("[data-stimeo--calendar-target='day']"),
    );
    const past = days.find((el) => (el.getAttribute("data-date") ?? "") > "2026-06-15");
    expect(past).toBeDefined();
    expect(past?.getAttribute("aria-disabled")).toBe("true");

    const within = days.find((el) => el.getAttribute("data-date") === "2026-06-10");
    expect(within?.getAttribute("aria-disabled")).toBeNull();
  });

  it("honours weekStart when laying out the grid and resolving Home", async () => {
    document.body.innerHTML = `
      <div id="cal3" data-controller="stimeo--calendar"
           data-stimeo--calendar-month-value="2026-05"
           data-stimeo--calendar-selected-value="2026-05-20"
           data-stimeo--calendar-week-start-value="1">
        <table role="grid">
          <tbody data-stimeo--calendar-target="grid"
                 data-action="keydown->stimeo--calendar#onKeydown click->stimeo--calendar#selectByClick">
            ${generateCellsHTML()}
          </tbody>
        </table>
      </div>`;
    await delay(150);

    const cells = document.querySelectorAll<HTMLElement>(
      "#cal3 [data-stimeo--calendar-target='day']",
    );
    // Monday-first: 2026-05-01 is a Friday, so the grid opens on 2026-04-27.
    expect(cells[0]?.getAttribute("data-date")).toBe("2026-04-27");

    const focused = document.querySelector<HTMLElement>(
      "#cal3 [data-stimeo--calendar-target='day'][tabindex='0']",
    );
    focused?.focus();
    focused?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await delay(20);
    expect(
      document
        .querySelector("#cal3 [data-stimeo--calendar-target='day'][tabindex='0']")
        ?.getAttribute("data-date"),
    ).toBe("2026-05-18");
  });

  describe("attribute ownership and malformed input", () => {
    const days = () =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--calendar-target='day']"));

    it("marks only the aria-disabled it wrote itself", () => {
      // Ownership has to be observable for the take-back to be possible at all:
      // an out-of-bounds day carries the controller's marker, a consumer-marked
      // day does not — so a later paint can tell the two apart.
      const owned = days().find((el) => el.dataset.date === "2026-04-28") as HTMLElement;
      expect(owned.getAttribute("aria-disabled")).toBe("true");
      expect(owned.hasAttribute("data-stimeo--calendar-owns-disabled")).toBe(true);

      // Same month, re-painted: the authored value describes a date the cell still
      // shows, so it survives.
      const authored = days().find((el) => el.dataset.date === "2026-05-20") as HTMLElement;
      authored.setAttribute("aria-disabled", "true");
      (document.getElementById("calendar") as HTMLElement).setAttribute(
        "data-stimeo--calendar-selected-value",
        "2026-05-21",
      );

      const again = days().find((el) => el.dataset.date === "2026-05-20") as HTMLElement;
      expect(again.hasAttribute("data-stimeo--calendar-owns-disabled")).toBe(false);
      expect(again.getAttribute("aria-disabled")).toBe("true");
    });

    it("keeps a consumer-authored aria-disabled across a same-month repaint", async () => {
      // Selecting another day repaints the same month, so the await is
      // load-bearing: reading the DOM synchronously after a Value change lands
      // before the repaint and would assert nothing.
      const target = days().find((el) => el.dataset.date === "2026-05-20") as HTMLElement;
      target.setAttribute("aria-disabled", "true");

      (days().find((el) => el.dataset.date === "2026-05-21") as HTMLElement).click();
      await delay(50);

      const again = days().find((el) => el.dataset.date === "2026-05-20") as HTMLElement;
      expect(again.getAttribute("aria-disabled")).toBe("true");
      expect(again.hasAttribute("data-stimeo--calendar-owns-disabled")).toBe(false);
      expect(again.getAttribute("aria-selected")).toBe("false");
    });

    it("lets a monthchange listener re-apply the mark on the new month", async () => {
      // The date-scoped reclaim shifts a responsibility to the consumer, so the
      // hook it depends on has to actually work: `monthchange` fires after the
      // repaint, late enough for the listener to find the new cells.
      const root = document.getElementById("calendar") as HTMLElement;
      root.addEventListener("stimeo--calendar:monthchange", () => {
        const cell = days().find((el) => el.dataset.date === "2026-06-10");
        cell?.setAttribute("aria-disabled", "true");
      });

      (document.getElementById("btn-next") as HTMLElement).click();
      await delay(50);

      const marked = days().find((el) => el.dataset.date === "2026-06-10") as HTMLElement;
      expect(marked.getAttribute("aria-disabled")).toBe("true");
      expect(marked.hasAttribute("data-stimeo--calendar-owns-disabled")).toBe(false);
    });

    it("does not carry a consumer-authored aria-disabled onto a different date", async () => {
      // The 42 cells are recycled every month. An `aria-disabled` the consumer
      // wrote describes the date the cell showed *then*, so carrying it over
      // silently disables an unrelated day. Awaiting each month change matters:
      // a synchronous next/prev pair never observes the intermediate month.
      // 2026-05-05 lands on 2026-06-09 next month, which is inside `max` — so a
      // leftover `aria-disabled` cannot be confused with one the controller sets
      // for being out of bounds.
      const target = days().find((el) => el.dataset.date === "2026-05-05") as HTMLElement;
      const index = days().indexOf(target);
      target.setAttribute("aria-disabled", "true");

      (document.getElementById("btn-next") as HTMLElement).click();
      await delay(50);

      const sameCell = days()[index] as HTMLElement;
      expect(sameCell.dataset.date).toBe("2026-06-09");
      expect(sameCell.hasAttribute("aria-disabled")).toBe(false);
    });

    it("keeps a consumer-authored aria-disabled on a date the next month still shows", async () => {
      // 2026-06-01 trails the May grid and opens the second cell of June's, so the
      // month move takes the date to another cell while it stays on screen.
      const before = days().find((el) => el.dataset.date === "2026-06-01") as HTMLElement;
      before.setAttribute("aria-disabled", "true");

      (document.getElementById("btn-next") as HTMLElement).click();
      await delay(50);

      const after = days().find((el) => el.dataset.date === "2026-06-01") as HTMLElement;
      expect(after).not.toBe(before);
      expect(after.getAttribute("aria-disabled")).toBe("true");
      expect(after.hasAttribute("data-stimeo--calendar-owns-disabled")).toBe(false);
    });

    it("keeps the grid operable when it connects with a malformed month", async () => {
      // A malformed month must still paint: with nothing painted there is no
      // `aria-selected` anywhere and no tab stop, so a Value typo drops the grid
      // out of the Tab sequence. Mounting is the moment that matters — a later
      // typo still has the previous paint to fall back on.
      disconnectAndStopApplication(application);
      document.body.innerHTML = `
        <div id="calendar2" data-controller="stimeo--calendar"
             data-stimeo--calendar-month-value="not-a-month">
          <table role="grid" aria-label="Days">
            <tbody data-stimeo--calendar-target="grid"
                   data-action="keydown->stimeo--calendar#onKeydown">
              ${generateCellsHTML()}
            </tbody>
          </table>
        </div>`;
      application = Application.start();
      application.register("stimeo--calendar", CalendarController);
      await delay(150);

      const cells = Array.from(
        document.querySelectorAll<HTMLElement>("[data-stimeo--calendar-target='day']"),
      );
      expect(cells.filter((el) => el.getAttribute("tabindex") === "0").length).toBe(1);
      expect(cells.every((el) => el.hasAttribute("aria-selected"))).toBe(true);
    });
  });

  // --- Hidden form fields ---

  describe("hidden form fields", () => {
    let commits: ReturnType<typeof captureFieldCommits>;

    const withFields = async () => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = `
        <div id="calendar" data-controller="stimeo--calendar"
             data-stimeo--calendar-month-value="2026-05"
             data-stimeo--calendar-selected-value="2026-05-31"
             data-stimeo--calendar-week-start-value="0">
          <input type="hidden" name="on" data-stimeo--calendar-target="field" />
          <input type="hidden" name="month" data-stimeo--calendar-target="monthField" />
          <button id="btn-prev" data-action="click->stimeo--calendar#prev">‹</button>
          <span id="label" data-stimeo--calendar-target="label"></span>
          <button id="btn-next" data-action="click->stimeo--calendar#next">›</button>
          <table role="grid" aria-labelledby="label">
            <tbody data-stimeo--calendar-target="grid"
                   data-action="click->stimeo--calendar#selectByClick">
              ${generateCellsHTML()}
            </tbody>
          </table>
        </div>`;
      application = Application.start();
      application.register("stimeo--calendar", CalendarController);
      await delay(150);
    };

    const field = () =>
      document.querySelector<HTMLInputElement>(
        "[data-stimeo--calendar-target='field']",
      ) as HTMLInputElement;
    const monthField = () =>
      document.querySelector<HTMLInputElement>(
        "[data-stimeo--calendar-target='monthField']",
      ) as HTMLInputElement;
    const cellFor = (date: string) =>
      document.querySelector<HTMLElement>(`[data-date="${date}"]`) as HTMLElement;

    beforeEach(() => {
      commits = captureFieldCommits();
    });

    afterEach(() => {
      commits.stop();
    });

    it("seeds both fields from the painted month and selection, silently", async () => {
      await withFields();

      expect(field().value).toBe("2026-05-31");
      expect(monthField().value).toBe("2026-05");
      expect(commits.seen).toEqual([]);
    });

    it("reports the month the previous control moved to", async () => {
      await withFields();
      commits.clear();

      (document.getElementById("btn-prev") as HTMLButtonElement).click();
      await delay(50);

      expect(monthField().value).toBe("2026-04");
      expect(commits.seen).toEqual([monthField()]);
    });

    it("reports the day the user picked", async () => {
      await withFields();
      commits.clear();

      cellFor("2026-05-14").click();
      await delay(50);

      expect(field().value).toBe("2026-05-14");
      expect(commits.seen).toEqual([field()]);
    });

    it("writes a month changed by application code without reporting a commit", async () => {
      await withFields();
      commits.clear();

      (document.getElementById("calendar") as HTMLElement).setAttribute(
        "data-stimeo--calendar-month-value",
        "2026-07",
      );
      await delay(150);

      expect(monthField().value).toBe("2026-07");
      expect(commits.seen).toEqual([]);
    });
  });
});

/**
 * The grid sits on a `tbody`, so pointer and key events reach it from places that
 * are not a day cell, and its Values can be handed anything a template can print.
 * Neither may surface as an error or leave the grid unusable.
 */
describe("CalendarController off-contract input", () => {
  let application: Application;
  let errors: Error[];

  const cells = () => {
    let html = "";
    for (let row = 0; row < 6; row++) {
      html += '<tr role="row">';
      for (let column = 0; column < 7; column++) {
        html += '<td role="gridcell" data-stimeo--calendar-target="day" tabindex="-1"></td>';
      }
      html += "</tr>";
    }
    return html;
  };

  const mount = async (month: string, wrapperLang = "", locale = "") => {
    const open = wrapperLang === "" ? "" : `<div lang="${wrapperLang}">`;
    const close = wrapperLang === "" ? "" : "</div>";
    document.body.innerHTML = `
      ${open}
      <div id="cal" data-controller="stimeo--calendar"
           ${locale === "" ? "" : `data-stimeo--calendar-locale-value="${locale}"`}
           data-stimeo--calendar-month-value="${month}">
        <span id="cal-label" data-stimeo--calendar-target="label"></span>
        <table role="grid" aria-labelledby="cal-label">
          <tbody data-stimeo--calendar-target="grid"
                 data-action="keydown->stimeo--calendar#onKeydown
                              click->stimeo--calendar#selectByClick">${cells()}</tbody>
        </table>
      </div>
      ${close}`;
    application = Application.start();
    application.register("stimeo--calendar", CalendarController);
    errors = [];
    // Stimulus reports a handler's exception instead of rethrowing it, so an
    // assertion on the DOM alone cannot tell a guard from a crash.
    application.handleError = (error) => {
      errors.push(error as Error);
    };
    await delay(150);
  };

  const controller = () =>
    application.getControllerForElementAndIdentifier(
      document.getElementById("cal") as HTMLElement,
      "stimeo--calendar",
    ) as CalendarController;

  const grid = () =>
    document.querySelector<HTMLElement>("[data-stimeo--calendar-target='grid']") as HTMLElement;
  const days = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--calendar-target='day']"));

  afterEach(async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    document.documentElement.lang = "";
    await delay(50);
  });

  it("navigates when the month buttons are wired to call the actions directly", async () => {
    // `prev` / `next` are documented as actions but take the event optionally, so
    // application code can drive the grid without synthesizing one.
    await mount("2026-05");
    controller().next();
    await delay(50);
    expect(document.getElementById("cal-label")?.textContent).toContain("June 2026");
    controller().prev();
    await delay(50);
    expect(document.getElementById("cal-label")?.textContent).toContain("May 2026");
  });

  it("claims the month-button press so an enclosing form is not submitted", async () => {
    // The natural markup is a bare <button> inside the surrounding form, whose
    // implicit type is `submit`.
    await mount("2026-05");
    for (const step of ["prev", "next"] as const) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      controller()[step](event);
      expect(event.defaultPrevented, `${step} should claim the press`).toBe(true);
    }
  });

  it("moves the roving tab stop in the same tick as the click", async () => {
    // Waiting on the value observer would leave the grid a frame behind the
    // pointer, so the selection repaints synchronously.
    await mount("2026-05");
    const target = days().find((cell) => cell.dataset.date === "2026-05-14") as HTMLElement;
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const stops = days().filter((cell) => cell.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
    expect(stops[0]?.dataset.date).toBe("2026-05-14");
  });

  it("follows a selected value the consumer sets at runtime", async () => {
    await mount("2026-05");
    const root = document.getElementById("cal") as HTMLElement;
    root.setAttribute("data-stimeo--calendar-selected-value", "2026-05-22");
    await delay(50);

    const stops = days().filter((cell) => cell.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
    expect(stops[0]?.dataset.date).toBe("2026-05-22");
    expect(stops[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("ignores a click and a keypress that miss a day cell", async () => {
    await mount("2026-05");
    const before = days().map((cell) => cell.getAttribute("tabindex"));

    grid().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    grid().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await delay(50);

    expect(errors).toEqual([]);
    expect(days().some((cell) => cell.getAttribute("aria-selected") === "true")).toBe(false);
    expect(days().map((cell) => cell.getAttribute("tabindex"))).toEqual(before);
  });

  it("stays where it is when asked to shift a malformed month", async () => {
    // The grid falls back to a paint it can render, so the month Value keeps the
    // typo. Shifting from there has no month to shift.
    await mount("not-a-month");
    const label = document.getElementById("cal-label")?.textContent;
    controller().next();
    await delay(50);
    expect(document.getElementById("cal-label")?.textContent).toBe(label);
    expect(errors).toEqual([]);
  });

  it("keeps the grid operable when the selected value is malformed", async () => {
    await mount("2026-05");
    const root = document.getElementById("cal") as HTMLElement;
    root.setAttribute("data-stimeo--calendar-selected-value", "31-05-2026");
    await delay(50);

    expect(errors).toEqual([]);
    expect(days().filter((cell) => cell.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(days().every((cell) => cell.hasAttribute("aria-selected"))).toBe(true);
    expect(days()[5]?.getAttribute("data-date")).toBe("2026-05-01");
  });

  it("labels the month in the language of the nearest ancestor", async () => {
    // `lang` is inherited, so the language that applies to the grid is the
    // nearest one above it — not the document element's.
    await mount("2026-05", "ja");

    expect(errors).toEqual([]);
    expect(document.getElementById("cal-label")?.textContent).toBe("2026年5月");
  });

  it("lets a nearer ancestor language win over a farther one", async () => {
    document.documentElement.lang = "ja";
    await mount("2026-05", "en");

    expect(document.getElementById("cal-label")?.textContent).toBe("May 2026");
  });

  it("asks for the runtime locale, not English, when nothing declares a language", async () => {
    // The runner's own locale is what an undeclared language resolves to, and it
    // may well be English — so the case states which locale the formatter is
    // asked for rather than comparing the rendered label.
    document.documentElement.removeAttribute("lang");
    const asked: unknown[] = [];
    const NativeDateTimeFormat = Intl.DateTimeFormat;
    const RecordingDateTimeFormat = new Proxy(NativeDateTimeFormat, {
      construct(target, argumentsList, newTarget) {
        asked.push(argumentsList[0]);
        return Reflect.construct(target, argumentsList, newTarget);
      },
    });
    Object.defineProperty(Intl, "DateTimeFormat", {
      configurable: true,
      writable: true,
      value: RecordingDateTimeFormat,
    });

    try {
      await mount("2026-05");
    } finally {
      Object.defineProperty(Intl, "DateTimeFormat", {
        configurable: true,
        writable: true,
        value: NativeDateTimeFormat,
      });
    }

    expect(errors).toEqual([]);
    expect(asked).toContain(undefined);
    expect(asked).not.toContain("en");
  });

  it("lets a declared locale win over every lang in scope", async () => {
    await mount("2026-05", "en", "ja");

    expect(document.getElementById("cal-label")?.textContent).toBe("2026年5月");
  });

  it("repaints the label when the declared locale changes at runtime", async () => {
    await mount("2026-05", "en");
    expect(document.getElementById("cal-label")?.textContent).toBe("May 2026");

    controller().localeValue = "ja";
    await delay(50);

    expect(errors).toEqual([]);
    expect(document.getElementById("cal-label")?.textContent).toBe("2026年5月");
  });

  it("keeps painting and labelling in English when the document language tag is malformed", async () => {
    // `<html lang>` is written by the host page, and a server-side locale such
    // as `en_US` is not a language tag `Intl` accepts. The label is formatted
    // before the cells are painted, so a formatter that throws would leave the
    // grid without dates and without a tab stop.
    document.documentElement.lang = "en_US";
    await mount("2026-05");

    expect(errors).toEqual([]);
    expect(document.getElementById("cal-label")?.textContent).toBe("May 2026");
    expect(days().filter((cell) => cell.hasAttribute("data-date"))).toHaveLength(42);
    expect(days().filter((cell) => cell.getAttribute("tabindex") === "0")).toHaveLength(1);

    // Every repaint formats the label again from the same `lang`, so month
    // navigation keeps working rather than only the first paint — and the
    // announcement at the end of the paint is reached, so a listener that
    // refetches inventory still hears the move.
    const months: string[] = [];
    document.getElementById("cal")?.addEventListener("stimeo--calendar:monthchange", (event) => {
      months.push((event as CustomEvent<{ month: string }>).detail.month);
    });
    controller().next();
    await delay(50);

    expect(errors).toEqual([]);
    expect(document.getElementById("cal-label")?.textContent).toBe("June 2026");
    expect(days().filter((cell) => cell.hasAttribute("data-date"))).toHaveLength(42);
    expect(days().filter((cell) => cell.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(months).toEqual(["2026-06"]);
  });

  it("reports a formatter failure that is not a locale problem instead of masking it", async () => {
    // Only a rejected language tag is absorbed. Any other failure of the
    // formatter is a programming fault and has to surface. Stimulus reports an
    // action's exception through `handleError`, so the repaint is driven by a
    // key move inside the shown month, which repaints synchronously.
    await mount("2026-05");
    const NativeDateTimeFormat = Intl.DateTimeFormat;
    const ThrowingDateTimeFormat = new Proxy(NativeDateTimeFormat, {
      construct(target, argumentsList, newTarget) {
        if (argumentsList[0] === "type-error") throw new TypeError("formatter failed");
        return Reflect.construct(target, argumentsList, newTarget);
      },
    });
    Object.defineProperty(Intl, "DateTimeFormat", {
      configurable: true,
      writable: true,
      value: ThrowingDateTimeFormat,
    });
    document.documentElement.lang = "type-error";
    const label = document.getElementById("cal-label")?.textContent;

    try {
      const cell = days().find((el) => el.dataset.date === "2026-05-14") as HTMLElement;
      cell.focus();
      cell.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    } finally {
      Object.defineProperty(Intl, "DateTimeFormat", {
        configurable: true,
        writable: true,
        value: NativeDateTimeFormat,
      });
    }

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(TypeError);
    expect(errors[0]?.message).toBe("formatter failed");
    expect(document.getElementById("cal-label")?.textContent).toBe(label);
  });
});

/**
 * The documented markup is exactly 42 day cells. A consumer's loop can still
 * emit a different number, and both directions have to degrade rather than break:
 * too few and the paint runs out of cells, too many and the extras never receive
 * a `data-date` — yet the grid must stay reachable by Tab and stay quiet.
 */
describe("CalendarController off-contract cell counts", () => {
  let application: Application;
  let errors: Error[];

  const cells = (count: number) => {
    let html = "";
    for (let index = 0; index < count; index++) {
      html += '<td role="gridcell" data-stimeo--calendar-target="day" tabindex="-1"></td>';
    }
    return `<tr role="row">${html}</tr>`;
  };

  const mount = async (count: number, extraValues = "") => {
    document.body.innerHTML = `
      <div id="cal" data-controller="stimeo--calendar"
           data-stimeo--calendar-month-value="2026-05" ${extraValues}>
        <span id="cal-label" data-stimeo--calendar-target="label"></span>
        <table role="grid" aria-labelledby="cal-label">
          <tbody data-stimeo--calendar-target="grid"
                 data-action="keydown->stimeo--calendar#onKeydown
                              click->stimeo--calendar#selectByClick">${cells(count)}</tbody>
        </table>
      </div>`;
    application = Application.start();
    application.register("stimeo--calendar", CalendarController);
    errors = [];
    application.handleError = (error) => {
      errors.push(error as Error);
    };
    await delay(150);
  };

  const days = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--calendar-target='day']"));

  afterEach(async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    await delay(50);
  });

  it("keeps the grid reachable when the markup is short of 42 cells", async () => {
    // `selected` names a day outside May, so no cell matches during the paint and
    // the tab stop comes from the fallback *after* the loop. A paint that dies on
    // the missing 42nd cell never reaches it, and the grid leaves the Tab order.
    await mount(41, 'data-stimeo--calendar-selected-value="2026-08-10"');

    expect(errors).toEqual([]);
    expect(days()).toHaveLength(41);
    expect(days().every((cell) => cell.hasAttribute("data-date"))).toBe(true);
    expect(days().filter((cell) => cell.getAttribute("tabindex") === "0")).toHaveLength(1);
  });

  it("ignores a keypress on a cell the paint never reached", async () => {
    await mount(43);
    const spare = days()[42] as HTMLElement;
    expect(spare.hasAttribute("data-date")).toBe(false);

    const before = days().findIndex((cell) => cell.getAttribute("tabindex") === "0");
    const label = document.getElementById("cal-label")?.textContent;
    spare.focus();
    spare.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await delay(50);

    expect(errors).toEqual([]);
    expect(document.getElementById("cal-label")?.textContent).toBe(label);
    expect(days().findIndex((cell) => cell.getAttribute("tabindex") === "0")).toBe(before);
  });

  it("ignores a click on a cell the paint never reached", async () => {
    await mount(43);
    const selected: string[] = [];
    document.getElementById("cal")?.addEventListener("stimeo--calendar:select", (event) => {
      selected.push((event as CustomEvent<{ date: string }>).detail.date);
    });

    (days()[42] as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await delay(50);

    expect(errors).toEqual([]);
    expect(selected).toEqual([]);
    expect(
      document.getElementById("cal")?.hasAttribute("data-stimeo--calendar-selected-value"),
    ).toBe(false);
  });
});

/**
 * `monthchange` reports a navigation, so a listener that refetches inventory or
 * pushes history must not hear one for the month the grid opened on. The listener
 * is attached before the application starts — attaching it afterwards cannot see
 * the announcement that arrives while the grid is settling.
 */
describe("CalendarController month announcements", () => {
  let application: Application;
  const months: string[] = [];

  const cells = () => {
    let html = "";
    for (let row = 0; row < 6; row++) {
      html += '<tr role="row">';
      for (let column = 0; column < 7; column++) {
        html += '<td role="gridcell" data-stimeo--calendar-target="day" tabindex="-1"></td>';
      }
      html += "</tr>";
    }
    return html;
  };

  const record = (event: Event) => {
    months.push((event as CustomEvent<{ month: string }>).detail.month);
  };

  const mount = async (monthAttribute: string) => {
    document.body.innerHTML = `
      <div id="cal" data-controller="stimeo--calendar" ${monthAttribute}>
        <button id="next" data-action="click->stimeo--calendar#next">›</button>
        <span id="cal-label" data-stimeo--calendar-target="label"></span>
        <table role="grid" aria-labelledby="cal-label">
          <tbody data-stimeo--calendar-target="grid"
                 data-action="keydown->stimeo--calendar#onKeydown
                              click->stimeo--calendar#selectByClick">${cells()}</tbody>
        </table>
      </div>`;
    document.addEventListener("stimeo--calendar:monthchange", record);
    application = Application.start();
    application.register("stimeo--calendar", CalendarController);
    await delay(150);
  };

  afterEach(async () => {
    document.removeEventListener("stimeo--calendar:monthchange", record);
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    months.length = 0;
    await delay(50);
  });

  it("stays silent while settling on an authored month", async () => {
    await mount('data-stimeo--calendar-month-value="2026-05"');
    expect(document.getElementById("cal-label")?.textContent).toContain("May 2026");
    expect(months).toEqual([]);
  });

  it("stays silent while settling on the month it derives itself", async () => {
    // With no attribute the controller picks the month itself, and leaves the
    // Value as the page wrote it.
    await mount("");
    expect(document.getElementById("cal-label")?.textContent).toBeTruthy();
    expect(document.getElementById("cal")?.hasAttribute("data-stimeo--calendar-month-value")).toBe(
      false,
    );
    expect(months).toEqual([]);
  });

  it("opens on the month of the selected day when no month is declared, and stays silent", async () => {
    // The Value callbacks Stimulus delivers before connect() paint from the
    // selection, and connect() then settles the month; both are the grid
    // describing itself, whichever month each of them shows.
    await mount('data-stimeo--calendar-selected-value="2020-02-10"');

    expect(months).toEqual([]);
    expect(document.getElementById("cal-label")?.textContent).toContain("February 2020");
    expect(document.getElementById("cal")?.hasAttribute("data-stimeo--calendar-month-value")).toBe(
      false,
    );
    expect(
      document
        .querySelector("[data-stimeo--calendar-target='day'][tabindex='0']")
        ?.getAttribute("data-date"),
    ).toBe("2020-02-10");
  });

  it("opens on the month of the selected day whichever Value callback paints first", async () => {
    // With `locale` ahead of `selected`, the callback Stimulus delivers for
    // `locale` before connect() paints the current month first.
    await mount(
      'data-stimeo--calendar-locale-value="en" data-stimeo--calendar-selected-value="2020-02-10"',
    );

    expect(document.getElementById("cal-label")?.textContent).toContain("February 2020");
    expect(months).toEqual([]);
  });

  it("steps from the month it opened on when no month is declared", async () => {
    await mount('data-stimeo--calendar-selected-value="2020-02-10"');
    const root = document.getElementById("cal") as HTMLElement;

    document.getElementById("next")?.click();
    await delay(50);

    expect(document.getElementById("cal-label")?.textContent).toContain("March 2020");
    expect(months).toEqual(["2020-03"]);
    // A month step is the user's move, so it writes the month it moved to.
    expect(root.getAttribute("data-stimeo--calendar-month-value")).toBe("2020-03");
  });

  it("moves keyboard focus inside the month it opened on in the same tick, writing no month", async () => {
    await mount('data-stimeo--calendar-selected-value="2020-02-10"');
    const root = document.getElementById("cal") as HTMLElement;
    const cell = (date: string) =>
      document.querySelector<HTMLElement>(`[data-date="${date}"]`) as HTMLElement;

    press(cell("2020-02-10"), "ArrowRight");

    expect(document.activeElement).toBe(cell("2020-02-11"));
    expect(root.hasAttribute("data-stimeo--calendar-month-value")).toBe(false);
    expect(months).toEqual([]);
  });

  it("keeps the month on screen through a later repaint once the page clears month", async () => {
    await mount('data-stimeo--calendar-month-value="2026-05"');
    const root = document.getElementById("cal") as HTMLElement;

    // Moves the focused day into August while May is on screen.
    root.setAttribute("data-stimeo--calendar-selected-value", "2026-08-10");
    await delay(50);
    root.setAttribute("data-stimeo--calendar-month-value", "");
    await delay(50);
    root.setAttribute("data-stimeo--calendar-min-value", "2026-05-02");
    await delay(50);

    expect(document.getElementById("cal-label")?.textContent).toContain("May 2026");
    expect(months).toEqual([]);
  });

  it("stays silent when it reconnects on a month that changed while it was detached", async () => {
    await mount('data-stimeo--calendar-month-value="2026-05"');
    const root = document.getElementById("cal") as HTMLElement;
    const parent = root.parentElement as HTMLElement;

    root.remove();
    await delay(50);
    root.setAttribute("data-stimeo--calendar-month-value", "2026-07");
    parent.append(root);
    await delay(50);

    expect(document.getElementById("cal-label")?.textContent).toContain("July 2026");
    expect(months).toEqual([]);

    // Once connected again, a move is reported as before.
    document.getElementById("next")?.click();
    await delay(50);
    expect(months).toEqual(["2026-08"]);
  });

  it("announces the month once navigation moves it", async () => {
    await mount('data-stimeo--calendar-month-value="2026-05"');
    document.getElementById("next")?.click();
    await delay(50);
    expect(months).toEqual(["2026-06"]);
  });

  it("reports the month it paints, not a malformed Value", async () => {
    // A malformed `month` paints the focused date's month instead. Reporting the
    // raw string would name a month that is not on screen and would not be the
    // `YYYY-MM` the detail contract promises.
    await mount('data-stimeo--calendar-month-value="2026-05"');
    const root = document.getElementById("cal") as HTMLElement;

    // Moves the focus into August while the Value still paints May.
    root.setAttribute("data-stimeo--calendar-selected-value", "2026-08-10");
    await delay(50);
    expect(months).toEqual([]);

    root.setAttribute("data-stimeo--calendar-month-value", "not-a-month");
    await delay(50);

    expect(document.getElementById("cal-label")?.textContent).toContain("August 2026");
    expect(months).toEqual(["2026-08"]);
  });

  it("announces the month a fallback repaint moves to", async () => {
    // While a malformed `month` falls back, the `month` Value is no longer what
    // decides the month on screen: `selected` moves the focused date, and the
    // label moves with it. A listener that refetches inventory has to hear that
    // move, and it has to hear it as the month the grid is actually showing.
    await mount('data-stimeo--calendar-month-value="2026-05"');
    const root = document.getElementById("cal") as HTMLElement;

    root.setAttribute("data-stimeo--calendar-month-value", "not-a-month");
    await delay(50);
    expect(document.getElementById("cal-label")?.textContent).toContain("May 2026");
    expect(months).toEqual([]);

    root.setAttribute("data-stimeo--calendar-selected-value", "2026-08-10");
    await delay(50);

    expect(document.getElementById("cal-label")?.textContent).toContain("August 2026");
    expect(months).toEqual(["2026-08"]);
  });

  it("does not repeat a fallback month on a later repaint that leaves it alone", async () => {
    // The announced month tracks the paint, so once the fallback month has been
    // reported a repaint that lands on the same month stays silent.
    await mount('data-stimeo--calendar-month-value="2026-05"');
    const root = document.getElementById("cal") as HTMLElement;

    root.setAttribute("data-stimeo--calendar-month-value", "not-a-month");
    await delay(50);
    root.setAttribute("data-stimeo--calendar-selected-value", "2026-08-10");
    await delay(50);
    expect(months).toEqual(["2026-08"]);

    root.setAttribute("data-stimeo--calendar-month-value", "another-non-month");
    await delay(50);

    expect(document.getElementById("cal-label")?.textContent).toContain("August 2026");
    expect(months).toEqual(["2026-08"]);
  });

  it("announces the month a selection outside the shown one falls back to", async () => {
    // Selection is a third route into the paint. Under the fallback it takes the
    // grid with it, so it reports like the other two.
    await mount('data-stimeo--calendar-month-value="2026-05"');
    const root = document.getElementById("cal") as HTMLElement;

    root.setAttribute("data-stimeo--calendar-month-value", "not-a-month");
    await delay(50);
    expect(months).toEqual([]);

    // The grid opens on May 2026, whose leading cells belong to April.
    const outside = Array.from(
      document.querySelectorAll<HTMLElement>("[data-stimeo--calendar-target='day']"),
    ).find((cell) => cell.getAttribute("data-outside") === "true");
    outside?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await delay(50);

    expect(document.getElementById("cal-label")?.textContent).toContain("April 2026");
    expect(months).toEqual(["2026-04"]);
  });

  it("ignores a cleared month Value instead of repainting", async () => {
    // Clearing the Value is not a navigation. Treating it as one would repaint on
    // the focused date's month, moving the grid somewhere the consumer never asked
    // for and reporting that move as a change.
    await mount('data-stimeo--calendar-month-value="2026-05"');
    const root = document.getElementById("cal") as HTMLElement;

    root.setAttribute("data-stimeo--calendar-selected-value", "2026-08-10");
    await delay(50);

    root.setAttribute("data-stimeo--calendar-month-value", "");
    await delay(50);

    expect(document.getElementById("cal-label")?.textContent).toContain("May 2026");
    expect(months).toEqual([]);
  });

  it("stays silent when a malformed Value leaves the painted month alone", async () => {
    await mount('data-stimeo--calendar-month-value="2026-05"');
    (document.getElementById("cal") as HTMLElement).setAttribute(
      "data-stimeo--calendar-month-value",
      "not-a-month",
    );
    await delay(50);

    expect(document.getElementById("cal-label")?.textContent).toContain("May 2026");
    expect(months).toEqual([]);
  });

  it("stays silent when the month is re-applied unchanged", async () => {
    // Turbo restores a cached page by replaying the value callbacks against the
    // month already on screen; re-announcing it would refetch on every restore.
    await mount('data-stimeo--calendar-month-value="2026-05"');
    const controller = application.getControllerForElementAndIdentifier(
      document.getElementById("cal") as HTMLElement,
      "stimeo--calendar",
    ) as CalendarController;
    controller.monthValueChanged();
    expect(months).toEqual([]);
  });
});

/**
 * `min` and `max` decide which days are disabled, and `weekStart` decides which
 * cell each date lands in. A runtime change — from application code, or from a
 * Turbo morph that swaps the attribute on an element it keeps, where `connect()`
 * does not run again — has to reach the grid on screen without moving the
 * month, reporting anything, or losing the place the user's focus was on.
 */
describe("CalendarController runtime bounds and week start", () => {
  let application: Application | undefined;
  let labelObserver: MutationObserver | undefined;
  let labelRecords: MutationRecord[] = [];

  const cells = () => {
    let html = "";
    for (let row = 0; row < 6; row++) {
      html += '<tr role="row">';
      for (let column = 0; column < 7; column++) {
        html += '<td role="gridcell" data-stimeo--calendar-target="day" tabindex="-1"></td>';
      }
      html += "</tr>";
    }
    return html;
  };

  const mount = async (controllerClass: typeof CalendarController = CalendarController) => {
    document.body.innerHTML = `
      <div id="cal" data-controller="stimeo--calendar"
           data-stimeo--calendar-month-value="2026-05"
           data-stimeo--calendar-selected-value="2026-05-31"
           data-stimeo--calendar-min-value="2026-05-01"
           data-stimeo--calendar-max-value="2026-06-15"
           data-stimeo--calendar-week-start-value="0">
        <input type="hidden" name="on" data-stimeo--calendar-target="field" />
        <input type="hidden" name="month" data-stimeo--calendar-target="monthField" />
        <button id="next" type="button" data-action="click->stimeo--calendar#next">›</button>
        <span id="cal-label" data-stimeo--calendar-target="label"></span>
        <table role="grid" aria-labelledby="cal-label">
          <tbody data-stimeo--calendar-target="grid"
                 data-action="keydown->stimeo--calendar#onKeydown
                              click->stimeo--calendar#selectByClick">${cells()}</tbody>
        </table>
      </div>`;
    // Every paint writes the month label once, so the label's additions count
    // the paints. The observer is in place before the controller connects.
    labelRecords = [];
    labelObserver = new MutationObserver((records) => labelRecords.push(...records));
    labelObserver.observe(document.getElementById("cal-label") as HTMLElement, {
      childList: true,
    });
    application = Application.start();
    application.register("stimeo--calendar", controllerClass);
    await delay(150);
  };

  const paints = () => {
    labelRecords.push(...(labelObserver?.takeRecords() ?? []));
    return labelRecords.filter((record) => record.addedNodes.length > 0).length;
  };

  const root = () => document.getElementById("cal") as HTMLElement;
  const days = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--calendar-target='day']"));
  const cellFor = (date: string) =>
    document.querySelector<HTMLElement>(`[data-date="${date}"]`) as HTMLElement;
  const field = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--calendar-target='field']",
    ) as HTMLInputElement;
  const monthField = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--calendar-target='monthField']",
    ) as HTMLInputElement;
  const controller = () =>
    application?.getControllerForElementAndIdentifier(
      root(),
      "stimeo--calendar",
    ) as CalendarController;
  const setValue = (name: string, value: string) => {
    root().setAttribute(`data-stimeo--calendar-${name}-value`, value);
  };

  afterEach(async () => {
    labelObserver?.disconnect();
    vi.restoreAllMocks();
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    await delay(50);
  });

  it("follows min and weekStart on a calendar that declares no month", async () => {
    document.body.innerHTML = `
      <div id="cal" data-controller="stimeo--calendar">
        <span data-stimeo--calendar-target="label"></span>
        <table role="grid"><tbody data-stimeo--calendar-target="grid">${cells()}</tbody></table>
      </div>`;
    application = Application.start();
    application.register("stimeo--calendar", CalendarController);
    await delay(150);
    // With no month declared the grid shows the current month, and the Value
    // stays empty.
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    expect(root().hasAttribute("data-stimeo--calendar-month-value")).toBe(false);
    const date = (day: number) => `${month}-${String(day).padStart(2, "0")}`;
    const firstCell = days()[0]?.dataset.date;

    setValue("min", date(15));
    setValue("week-start", "1");
    await tick();

    expect(cellFor(date(14)).getAttribute("aria-disabled")).toBe("true");
    expect(cellFor(date(15)).hasAttribute("aria-disabled")).toBe(false);
    expect(days()[0]?.dataset.date).not.toBe(firstCell);
  });

  it("disables and releases days as min moves, leaving a consumer's mark in place", async () => {
    await mount();
    const owned = "data-stimeo--calendar-owns-disabled";
    // A consumer marks a day that the new bound is about to cover as well.
    const marked = cellFor("2026-05-05");
    marked.setAttribute("aria-disabled", "true");

    setValue("min", "2026-05-10");
    await tick();

    expect(cellFor("2026-05-09").getAttribute("aria-disabled")).toBe("true");
    expect(cellFor("2026-05-09").hasAttribute(owned)).toBe(true);
    expect(cellFor("2026-05-10").hasAttribute("aria-disabled")).toBe(false);
    expect(marked.getAttribute("aria-disabled")).toBe("true");
    expect(marked.hasAttribute(owned)).toBe(false);

    setValue("min", "2026-05-01");
    await tick();

    expect(cellFor("2026-05-09").hasAttribute("aria-disabled")).toBe(false);
    expect(cellFor("2026-05-09").hasAttribute(owned)).toBe(false);
    expect(marked.getAttribute("aria-disabled")).toBe("true");
  });

  it("follows max as it moves, and lifts the bound once it is cleared", async () => {
    await mount();

    setValue("max", "2026-05-20");
    await tick();

    expect(cellFor("2026-05-21").getAttribute("aria-disabled")).toBe("true");
    expect(cellFor("2026-05-20").hasAttribute("aria-disabled")).toBe(false);

    setValue("max", "");
    await tick();

    expect(cellFor("2026-05-21").hasAttribute("aria-disabled")).toBe(false);
  });

  it("moves every date to its new column when weekStart changes", async () => {
    await mount();
    expect(days()[0]?.dataset.date).toBe("2026-04-26");

    setValue("week-start", "1");
    await tick();

    // Monday first: 2026-05-01 is a Friday, so the grid opens on Monday 04-27.
    expect(days()[0]?.dataset.date).toBe("2026-04-27");
    expect(days()[4]?.dataset.date).toBe("2026-05-01");
    // A recycled cell takes the bound of the date it shows now.
    expect(days()[0]?.getAttribute("aria-disabled")).toBe("true");
    expect(
      days()
        .filter((cell) => cell.getAttribute("tabindex") === "0")
        .map((cell) => cell.dataset.date),
    ).toEqual(["2026-05-31"]);
    await expectNoA11yViolations(root());
  });

  it("keeps a consumer's mark on its date when weekStart moves the date to another cell", async () => {
    await mount();
    const owned = "data-stimeo--calendar-owns-disabled";
    const heard: string[] = [];
    for (const type of ["stimeo--calendar:monthchange", "stimeo--calendar:select"]) {
      root().addEventListener(type, () => heard.push(type));
    }
    const commits = captureFieldCommits(root());
    try {
      const before = cellFor("2026-05-05");
      before.setAttribute("aria-disabled", "true");

      setValue("week-start", "1");
      await tick();

      const after = cellFor("2026-05-05");
      expect(after).not.toBe(before);
      expect(after.getAttribute("aria-disabled")).toBe("true");
      expect(after.hasAttribute(owned)).toBe(false);
      // The cell the date left shows the next day now, which nobody marked.
      expect(before.dataset.date).toBe("2026-05-06");
      expect(before.hasAttribute("aria-disabled")).toBe(false);

      after.click();
      expect(after.getAttribute("aria-selected")).toBe("false");
      expect(heard).toEqual([]);
      expect(commits.seen).toEqual([]);

      // The same click on a day nobody marked selects it, so the refusal above
      // is the mark's.
      before.click();
      expect(before.getAttribute("aria-selected")).toBe("true");
      expect(heard).toEqual(["stimeo--calendar:select"]);
    } finally {
      commits.stop();
    }
  });

  it("drops a consumer's mark once weekStart moves its date out of the grid", async () => {
    // Saturday first, the grid runs 04-25 … 06-05, so 06-06 leaves at the end.
    await mount();
    const leaving = cellFor("2026-06-06");
    leaving.setAttribute("aria-disabled", "true");

    setValue("week-start", "6");
    await tick();

    expect(document.querySelector('[data-date="2026-06-06"]')).toBeNull();
    expect(leaving.dataset.date).toBe("2026-06-05");
    expect(leaving.hasAttribute("aria-disabled")).toBe(false);

    // Back on screen, the date comes without the mark it left with.
    setValue("week-start", "0");
    await tick();

    expect(cellFor("2026-06-06").hasAttribute("aria-disabled")).toBe(false);
  });

  it("still takes back only its own marks once weekStart has moved both kinds", async () => {
    await mount();
    const owned = "data-stimeo--calendar-owns-disabled";
    // The new min covers the consumer's day too, so both kinds of mark sit in the
    // grid when weekStart moves them.
    cellFor("2026-05-05").setAttribute("aria-disabled", "true");
    setValue("min", "2026-05-10");
    await tick();

    setValue("week-start", "1");
    await tick();

    expect(days()[0]?.dataset.date).toBe("2026-04-27");
    expect(cellFor("2026-05-05").getAttribute("aria-disabled")).toBe("true");
    expect(cellFor("2026-05-05").hasAttribute(owned)).toBe(false);
    expect(cellFor("2026-05-09").getAttribute("aria-disabled")).toBe("true");
    expect(cellFor("2026-05-09").hasAttribute(owned)).toBe(true);

    setValue("min", "2026-05-01");
    await tick();

    expect(cellFor("2026-05-09").hasAttribute("aria-disabled")).toBe(false);
    expect(cellFor("2026-05-09").hasAttribute(owned)).toBe(false);
    expect(cellFor("2026-05-05").getAttribute("aria-disabled")).toBe("true");
  });

  it("repaints once when a morph swaps min, max and weekStart together, reporting only the selection it withheld", async () => {
    await mount();
    const heard: string[] = [];
    const repairs: unknown[] = [];
    for (const type of ["stimeo--calendar:monthchange", "stimeo--calendar:select"]) {
      root().addEventListener(type, () => heard.push(type));
    }
    root().addEventListener("stimeo--calendar:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });
    const commits = captureFieldCommits(root());
    try {
      const before = paints();

      setValue("min", "2026-05-10");
      setValue("max", "2026-05-20");
      setValue("week-start", "1");
      await tick();

      expect(paints()).toBe(before + 1);
      expect(days()[0]?.dataset.date).toBe("2026-04-27");
      expect(cellFor("2026-05-09").getAttribute("aria-disabled")).toBe("true");
      expect(cellFor("2026-05-21").getAttribute("aria-disabled")).toBe("true");
      // The new max leaves the selected 2026-05-31 behind: one batch, one report,
      // and the field follows without a native change. The month on screen and
      // its field stay where they were.
      expect(repairs).toEqual([{ date: "" }]);
      expect(field().value).toBe("");
      expect(monthField().value).toBe("2026-05");
      expect(heard).toEqual([]);
      expect(commits.seen).toEqual([]);

      // The same listeners hear a move the user makes, so the silence above
      // is the grid's own.
      (document.getElementById("next") as HTMLButtonElement).click();
      await tick();
      expect(heard).toEqual(["stimeo--calendar:monthchange"]);
      expect(commits.seen).toEqual([monthField()]);
      expect(repairs).toEqual([{ date: "" }]);
    } finally {
      commits.stop();
    }
  });

  it("paints nothing for min, max or weekStart delivered before it connects", async () => {
    // Stimulus delivers every Value callback once before connect(), authored and
    // default Values alike. connect() paints the grid itself, so these three
    // leave nothing behind: no paint then, and no repaint queued for later.
    const early: string[] = [];
    let connected = false;
    let paintsAtConnect = Number.NaN;
    for (const name of ["minValueChanged", "maxValueChanged", "weekStartValueChanged"] as const) {
      const deliver = CalendarController.prototype[name];
      vi.spyOn(CalendarController.prototype, name).mockImplementation(function (
        this: CalendarController,
      ) {
        const before = paints();
        deliver.call(this);
        if (!connected) early.push(`${name} painted ${paints() - before}`);
      });
    }
    class ConnectProbe extends CalendarController {
      override connect(): void {
        connected = true;
        super.connect();
        paintsAtConnect = paints();
      }
    }

    await mount(ConnectProbe);

    expect(early).toHaveLength(3);
    expect(early).toEqual(
      expect.arrayContaining([
        "minValueChanged painted 0",
        "maxValueChanged painted 0",
        "weekStartValueChanged painted 0",
      ]),
    );
    expect(paints()).toBe(paintsAtConnect);

    // Once connected, the same delivery repaints.
    setValue("min", "2026-05-10");
    await tick();
    expect(paints()).toBe(paintsAtConnect + 1);
  });

  it("keeps focus on the day it was on when weekStart moves that day to another cell", async () => {
    await mount();
    const before = cellFor("2026-05-31");
    before.focus();

    setValue("week-start", "1");
    await tick();

    const after = cellFor("2026-05-31");
    expect(after).not.toBe(before);
    expect(document.activeElement).toBe(after);
    expect(after.getAttribute("tabindex")).toBe("0");
  });

  it("follows the focused day rather than the tab stop", async () => {
    // Pressing a day that cannot be selected leaves focus on it without moving
    // the tab stop. 2026-04-28 is before min and stays in the grid either way.
    await mount();
    const pressed = cellFor("2026-04-28");
    pressed.focus();

    setValue("week-start", "1");
    await tick();

    expect(document.activeElement).not.toBe(pressed);
    expect(document.activeElement).toBe(cellFor("2026-04-28"));
    expect(cellFor("2026-05-31").getAttribute("tabindex")).toBe("0");
  });

  it("moves focus to the tab stop when the day it was on leaves the grid", async () => {
    await mount();
    // 2026-04-26 opens the Sunday-first grid and is not in the Monday-first one.
    cellFor("2026-04-26").focus();

    setValue("week-start", "1");
    await tick();

    expect(document.querySelector('[data-date="2026-04-26"]')).toBeNull();
    expect(document.activeElement).toBe(cellFor("2026-05-31"));
    expect(cellFor("2026-05-31").getAttribute("tabindex")).toBe("0");
  });

  it("leaves focus on a day that a tightened bound disables", async () => {
    // A disabled day stays focusable, so focus has nowhere it needs to go —
    // and is not asked to go there again: `focus()` scrolls its target into
    // view, so a repaint that leaves focus in place calls nothing.
    await mount();
    const focused = cellFor("2026-05-31");
    focused.focus();
    const focusCalls = vi.spyOn(HTMLElement.prototype, "focus");

    setValue("max", "2026-05-20");
    await tick();

    expect(focused.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(focused);
    expect(focused.getAttribute("tabindex")).toBe("0");
    expect(focusCalls).not.toHaveBeenCalled();
  });

  it("does not pull focus into the grid", async () => {
    await mount();
    const next = document.getElementById("next") as HTMLButtonElement;
    next.focus();

    setValue("week-start", "1");
    await tick();

    expect(days()[0]?.dataset.date).toBe("2026-04-27");
    expect(document.activeElement).toBe(next);
  });

  it("drops a repaint still queued when it disconnects, and follows nothing after", async () => {
    await mount();
    const calendar = controller();

    setValue("min", "2026-05-10");
    calendar.minValueChanged();
    calendar.disconnect();
    await tick();

    expect(cellFor("2026-05-09").hasAttribute("aria-disabled")).toBe(false);

    setValue("week-start", "1");
    await tick();

    expect(days()[0]?.dataset.date).toBe("2026-04-26");
  });

  it("follows the Values again once it reconnects", async () => {
    // An in-page move disconnects and reconnects the same instance.
    await mount();
    const calendar = controller();
    calendar.disconnect();
    calendar.connect();

    setValue("min", "2026-05-10");
    await tick();

    expect(cellFor("2026-05-09").getAttribute("aria-disabled")).toBe("true");
  });
});

/**
 * `selected` is the page's request, and `min` / `max` decide whether the grid
 * publishes it: a day outside them is neither announced as selected nor
 * submitted, and it comes back once they allow it again. A move of the
 * published selection that the bounds made is reported as `reconcile`; `select`
 * stays the user's, and nothing is reported while the grid connects.
 */
describe("CalendarController selection held to the bounds", () => {
  let application: Application | undefined;
  let heard: Array<{ type: string; detail: unknown }> = [];
  let commits: ReturnType<typeof captureFieldCommits> | undefined;

  const EVENTS = [
    "stimeo--calendar:monthchange",
    "stimeo--calendar:reconcile",
    "stimeo--calendar:select",
  ];

  const cells = () => {
    let html = "";
    for (let row = 0; row < 6; row++) {
      html += '<tr role="row">';
      for (let column = 0; column < 7; column++) {
        html += '<td role="gridcell" data-stimeo--calendar-target="day" tabindex="-1"></td>';
      }
      html += "</tr>";
    }
    return html;
  };

  const record = (event: Event) => {
    heard.push({ type: event.type, detail: (event as CustomEvent).detail });
  };

  const mount = async (values: Record<string, string>) => {
    const attributes = Object.entries(values)
      .map(([name, value]) => `data-stimeo--calendar-${name}-value="${value}"`)
      .join(" ");
    document.body.innerHTML = `
      <div id="cal" data-controller="stimeo--calendar" ${attributes}>
        <input type="hidden" name="on" data-stimeo--calendar-target="field" />
        <span id="cal-label" data-stimeo--calendar-target="label"></span>
        <table role="grid" aria-labelledby="cal-label">
          <tbody data-stimeo--calendar-target="grid"
                 data-action="keydown->stimeo--calendar#onKeydown
                              click->stimeo--calendar#selectByClick">${cells()}</tbody>
        </table>
      </div>`;
    // Listening before the application starts is what lets a report made while
    // the grid connects be heard at all.
    for (const type of EVENTS) document.addEventListener(type, record);
    commits = captureFieldCommits();
    application = Application.start();
    application.register("stimeo--calendar", CalendarController);
    await delay(150);
  };

  afterEach(async () => {
    for (const type of EVENTS) document.removeEventListener(type, record);
    commits?.stop();
    heard = [];
    vi.useRealTimers();
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    await delay(50);
  });

  const root = () => document.getElementById("cal") as HTMLElement;
  const controller = () =>
    application?.getControllerForElementAndIdentifier(
      root(),
      "stimeo--calendar",
    ) as CalendarController;
  const field = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--calendar-target='field']",
    ) as HTMLInputElement;
  const cellFor = (date: string) =>
    document.querySelector<HTMLElement>(`[data-date="${date}"]`) as HTMLElement;
  const datesWhere = (attribute: string, value: string) =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        `[data-stimeo--calendar-target='day'][${attribute}='${value}']`,
      ),
      (cell) => cell.dataset.date,
    );
  const selected = () => datesWhere("aria-selected", "true");
  const stops = () => datesWhere("tabindex", "0");
  const setValue = (name: string, value: string) => {
    root().setAttribute(`data-stimeo--calendar-${name}-value`, value);
  };
  const reconciled = (date: string) => ({ type: "stimeo--calendar:reconcile", detail: { date } });

  it("withdraws a selection max moves past, reports reconcile once, and restores it when max relaxes", async () => {
    await mount({ month: "2026-05", selected: "2026-05-31", max: "2026-06-15" });
    expect(selected()).toEqual(["2026-05-31"]);
    expect(field().value).toBe("2026-05-31");

    setValue("max", "2026-05-20");
    await tick();

    expect(selected()).toEqual([]);
    expect(cellFor("2026-05-31").getAttribute("aria-selected")).toBe("false");
    expect(field().value).toBe("");
    expect(heard).toEqual([reconciled("")]);
    expect(commits?.seen).toEqual([]);
    // The request itself is left as the page wrote it.
    expect(root().getAttribute("data-stimeo--calendar-selected-value")).toBe("2026-05-31");

    setValue("max", "2026-06-15");
    await tick();

    expect(selected()).toEqual(["2026-05-31"]);
    expect(field().value).toBe("2026-05-31");
    expect(heard).toEqual([reconciled(""), reconciled("2026-05-31")]);
    expect(commits?.seen).toEqual([]);
  });

  it("withdraws a selection min moves past", async () => {
    await mount({ month: "2026-05", selected: "2026-05-12", min: "2026-05-01" });

    setValue("min", "2026-05-13");
    await tick();

    expect(selected()).toEqual([]);
    expect(field().value).toBe("");
    expect(heard).toEqual([reconciled("")]);
    expect(commits?.seen).toEqual([]);
  });

  it("stays silent when a bound moves without reaching the selection", async () => {
    await mount({ month: "2026-05", selected: "2026-05-31", max: "2026-06-15" });

    setValue("max", "2026-06-01");
    await tick();

    expect(cellFor("2026-06-02").getAttribute("aria-disabled")).toBe("true");
    expect(selected()).toEqual(["2026-05-31"]);
    expect(field().value).toBe("2026-05-31");
    expect(heard).toEqual([]);
  });

  it("publishes no selection for an out-of-bounds selected it connects with, and says nothing", async () => {
    await mount({ month: "2026-05", selected: "2026-05-31", max: "2026-05-20" });

    expect(selected()).toEqual([]);
    expect(field().value).toBe("");
    expect(heard).toEqual([]);
    expect(commits?.seen).toEqual([]);
  });

  it("withholds a selection a bound moved past while detached, silently, when the same grid reconnects", async () => {
    await mount({ month: "2026-05", selected: "2026-05-31", max: "2026-06-15" });
    expect(selected()).toEqual(["2026-05-31"]);
    const calendar = root();
    const instance = controller();

    calendar.remove();
    await delay(50);
    calendar.setAttribute("data-stimeo--calendar-max-value", "2026-05-20");
    document.body.append(calendar);
    await delay(50);

    // The reconnected grid is the instance that published 2026-05-31 before it left.
    expect(controller()).toBe(instance);
    expect(selected()).toEqual([]);
    expect(field().value).toBe("");
    expect(cellFor("2026-05-31").getAttribute("aria-disabled")).toBe("true");
    expect(heard).toEqual([]);
    expect(commits?.seen).toEqual([]);

    // Connected again, a bound that gives the day back is reported.
    setValue("max", "2026-06-15");
    await tick();

    expect(selected()).toEqual(["2026-05-31"]);
    expect(heard).toEqual([reconciled("2026-05-31")]);
    expect(commits?.seen).toEqual([]);
  });

  it("publishes no selection for a selected that names no day", async () => {
    await mount({ month: "2026-05", selected: "31-05-2026" });

    expect(selected()).toEqual([]);
    expect(field().value).toBe("");
    expect(heard).toEqual([]);
  });

  it("opens the tab stop on today when the bounds withhold the selection", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 4, 12));
    await mount({ month: "2026-05", selected: "2026-05-31", max: "2026-05-20" });

    expect(stops()).toEqual(["2026-05-12"]);
  });

  it("opens the tab stop on the 1st when the bounds withhold the selection and today is elsewhere", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 23));
    await mount({ month: "2026-05", selected: "2026-05-31", max: "2026-05-20" });

    expect(stops()).toEqual(["2026-05-01"]);
  });

  it("opens on the current month, silently, when no month is declared and the bounds withhold the selection", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 23));
    await mount({ selected: "2020-02-10", max: "2020-01-31" });

    expect(document.getElementById("cal-label")?.textContent).toContain("September 2026");
    expect(root().hasAttribute("data-stimeo--calendar-month-value")).toBe(false);
    expect(selected()).toEqual([]);
    expect(field().value).toBe("");
    expect(stops()).toEqual(["2026-09-23"]);
    expect(heard).toEqual([]);
  });

  it("reports a selected the page writes past a bound as withheld, and keeps the tab stop", async () => {
    await mount({ month: "2026-05", selected: "2026-05-10", max: "2026-05-20" });

    setValue("selected", "2026-05-25");
    await tick();

    expect(selected()).toEqual([]);
    expect(field().value).toBe("");
    expect(stops()).toEqual(["2026-05-10"]);
    expect(heard).toEqual([reconciled("")]);
    expect(commits?.seen).toEqual([]);
  });

  it("reports a selected the page writes inside the bounds as reconcile", async () => {
    await mount({ month: "2026-05", selected: "2026-05-10", max: "2026-05-20" });

    setValue("selected", "2026-05-15");
    await tick();

    expect(selected()).toEqual(["2026-05-15"]);
    expect(field().value).toBe("2026-05-15");
    expect(stops()).toEqual(["2026-05-15"]);
    expect(heard).toEqual([reconciled("2026-05-15")]);
    expect(commits?.seen).toEqual([]);
  });

  it("reports a selection the page clears as reconcile", async () => {
    await mount({ month: "2026-05", selected: "2026-05-10" });

    setValue("selected", "");
    await tick();

    expect(selected()).toEqual([]);
    expect(field().value).toBe("");
    expect(heard).toEqual([reconciled("")]);
    expect(commits?.seen).toEqual([]);
  });

  it("stays silent when the page moves a request the bounds keep withholding", async () => {
    await mount({ month: "2026-05", selected: "2026-05-31", max: "2026-05-20" });

    setValue("selected", "2026-05-25");
    await tick();

    expect(selected()).toEqual([]);
    expect(field().value).toBe("");
    expect(heard).toEqual([]);
  });

  it("reports one batch that moves selected and max together once", async () => {
    await mount({ month: "2026-05", selected: "2026-05-10", max: "2026-05-20" });

    setValue("selected", "2026-05-25");
    setValue("max", "2026-05-31");
    await tick();

    expect(selected()).toEqual(["2026-05-25"]);
    expect(field().value).toBe("2026-05-25");
    expect(heard).toEqual([reconciled("2026-05-25")]);
    expect(commits?.seen).toEqual([]);
  });

  it("reports a pick a reconcile listener makes as select, measured from the reported day", async () => {
    await mount({ month: "2026-05", selected: "2026-05-10" });
    // On the document after the recorder, so the report is recorded before the
    // listener answers it.
    const listening = new AbortController();
    let answered = false;
    document.addEventListener(
      "stimeo--calendar:reconcile",
      () => {
        if (answered) return;
        answered = true;
        cellFor("2026-05-18").click();
      },
      { signal: listening.signal },
    );

    setValue("selected", "2026-05-15");
    await tick();
    listening.abort();

    expect(selected()).toEqual(["2026-05-18"]);
    expect(field().value).toBe("2026-05-18");
    expect(heard).toEqual([
      reconciled("2026-05-15"),
      { type: "stimeo--calendar:select", detail: { date: "2026-05-18" } },
    ]);
    expect(commits?.seen).toEqual([field()]);
  });

  it("reports a pick the user makes with select alone", async () => {
    await mount({ month: "2026-05", selected: "2026-05-31", max: "2026-05-20" });

    cellFor("2026-05-14").click();
    await tick();

    expect(selected()).toEqual(["2026-05-14"]);
    expect(field().value).toBe("2026-05-14");
    expect(heard).toEqual([{ type: "stimeo--calendar:select", detail: { date: "2026-05-14" } }]);
    expect(commits?.seen).toEqual([field()]);
  });

  it("does not report a withheld selection a monthchange listener has already replaced", async () => {
    await mount({ month: "2026-05", selected: "2026-05-10", min: "2026-05-01" });
    root().addEventListener("stimeo--calendar:monthchange", () => {
      controller().selectDayElement(cellFor("2026-06-10"));
    });

    // One batch: the paint of June already sees the min that withholds 05-10.
    setValue("min", "2026-05-15");
    setValue("month", "2026-06");
    await tick();

    expect(selected()).toEqual(["2026-06-10"]);
    expect(heard).toContainEqual({
      type: "stimeo--calendar:select",
      detail: { date: "2026-06-10" },
    });
    expect(heard.filter((entry) => entry.type === "stimeo--calendar:reconcile")).toEqual([]);
  });

  it("fills a field inserted at runtime with the published selection, not the withheld request", async () => {
    await mount({ month: "2026-05", selected: "2026-05-31", max: "2026-05-20" });
    const inserted = document.createElement("input");
    inserted.type = "hidden";
    inserted.value = "stale";
    inserted.setAttribute("data-stimeo--calendar-target", "field");
    root().append(inserted);
    // Target callbacks are delivered unreliably under happy-dom, so the one
    // Stimulus makes for the inserted field is made here directly.
    controller().fieldTargetConnected(inserted);

    expect(inserted.value).toBe("");
  });
});

/**
 * The `month` Value is shared with the page: application code and a Turbo morph
 * write it, and so do the grid's own month steps. Whichever wrote it, the paint
 * recycles the 42 cells, so the element DOM focus was on now shows another day.
 * Focus in the grid therefore goes to the tab stop; focus anywhere else is left
 * alone.
 */
describe("CalendarController month moves and focus", () => {
  let application: Application | undefined;

  const cells = () => {
    let html = "";
    for (let row = 0; row < 6; row++) {
      html += '<tr role="row">';
      for (let column = 0; column < 7; column++) {
        html += '<td role="gridcell" data-stimeo--calendar-target="day" tabindex="-1"></td>';
      }
      html += "</tr>";
    }
    return html;
  };

  const mount = async () => {
    document.body.innerHTML = `
      <div id="cal" data-controller="stimeo--calendar"
           data-stimeo--calendar-month-value="2026-05"
           data-stimeo--calendar-selected-value="2026-05-31"
           data-stimeo--calendar-min-value="2026-05-01"
           data-stimeo--calendar-max-value="2026-06-15"
           data-stimeo--calendar-week-start-value="0">
        <button id="next" type="button" data-action="click->stimeo--calendar#next">›</button>
        <span id="cal-label" data-stimeo--calendar-target="label"></span>
        <table role="grid" aria-labelledby="cal-label">
          <tbody data-stimeo--calendar-target="grid"
                 data-action="keydown->stimeo--calendar#onKeydown
                              click->stimeo--calendar#selectByClick">${cells()}</tbody>
        </table>
      </div>`;
    application = Application.start();
    application.register("stimeo--calendar", CalendarController);
    await delay(150);
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    await delay(50);
  });

  const root = () => document.getElementById("cal") as HTMLElement;
  const controller = () =>
    application?.getControllerForElementAndIdentifier(
      root(),
      "stimeo--calendar",
    ) as CalendarController;
  const cellFor = (date: string) =>
    document.querySelector<HTMLElement>(`[data-date="${date}"]`) as HTMLElement;
  const stops = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>("[data-stimeo--calendar-target='day'][tabindex='0']"),
      (cell) => cell.dataset.date,
    );
  const setValue = (name: string, value: string) => {
    root().setAttribute(`data-stimeo--calendar-${name}-value`, value);
  };

  it("moves focus from the tab stop to the new tab stop when the month Value moves", async () => {
    await mount();
    cellFor("2026-05-31").focus();

    setValue("month", "2026-06");
    await tick();

    // June has no 31st, so the tab stop comes to rest on June's last day.
    expect(stops()).toEqual(["2026-06-30"]);
    expect(document.activeElement).toBe(cellFor("2026-06-30"));
  });

  it("moves focus to the tab stop from a day that was not the tab stop", async () => {
    await mount();
    cellFor("2026-05-20").focus();

    setValue("month", "2026-06");
    await tick();

    expect(document.activeElement).toBe(cellFor("2026-06-30"));
  });

  it("goes to the tab stop even when the day focus was on is still shown", async () => {
    // 2026-06-03 trails May's grid and is part of June's too.
    await mount();
    cellFor("2026-06-03").focus();

    setValue("month", "2026-06");
    await tick();

    expect(document.activeElement).toBe(cellFor("2026-06-30"));
  });

  it.each([
    ["month first", ["month", "week-start"]],
    ["weekStart first", ["week-start", "month"]],
  ] as const)(
    "moves focus to the tab stop when the month and weekStart change in one batch, %s",
    async (_label, order) => {
      await mount();
      cellFor("2026-05-20").focus();

      for (const name of order) setValue(name, name === "month" ? "2026-06" : "1");
      await tick();

      // Monday first, June 2026 opens on its 1st.
      expect(cellFor("2026-06-01")).toBe(
        document.querySelector("[data-stimeo--calendar-target='day']"),
      );
      expect(stops()).toEqual(["2026-06-30"]);
      expect(document.activeElement).toBe(cellFor("2026-06-30"));
    },
  );

  it.each([
    ["month first", ["month", "selected"]],
    ["selected first", ["selected", "month"]],
  ] as const)(
    "moves focus to the tab stop the batch settles on when month and selected change together, %s",
    async (_label, order) => {
      await mount();
      cellFor("2026-05-20").focus();

      for (const name of order) setValue(name, name === "month" ? "2026-06" : "2026-06-10");
      await tick();

      expect(stops()).toEqual(["2026-06-10"]);
      expect(document.activeElement).toBe(cellFor("2026-06-10"));
    },
  );

  it("moves focus to the tab stop when a locale change paints the new month before its callback", async () => {
    // The locale callback runs first and already paints June, with the tab stop
    // May left behind; the month callback moves the tab stop after it.
    await mount();
    cellFor("2026-05-20").focus();

    setValue("locale", "ja");
    setValue("month", "2026-06");
    await tick();

    expect(stops()).toEqual(["2026-06-30"]);
    expect(document.activeElement).toBe(cellFor("2026-06-30"));
  });

  it("leaves focus outside the grid where it is", async () => {
    await mount();
    const next = document.getElementById("next") as HTMLButtonElement;
    next.focus();

    setValue("month", "2026-06");
    await tick();

    expect(stops()).toEqual(["2026-06-30"]);
    expect(document.activeElement).toBe(next);
  });

  it("leaves focus where a monthchange listener put it", async () => {
    await mount();
    const next = document.getElementById("next") as HTMLButtonElement;
    root().addEventListener("stimeo--calendar:monthchange", () => next.focus());
    cellFor("2026-05-31").focus();

    setValue("month", "2026-06");
    await tick();

    expect(document.activeElement).toBe(next);
  });

  it("keeps focus on its day, calling nothing, when a month Value leaves the month on screen", async () => {
    // A malformed month falls back to the month of the tab stop, which is the
    // month already painted, so no date moves.
    await mount();
    const held = cellFor("2026-05-20");
    held.focus();
    const focusCalls = vi.spyOn(HTMLElement.prototype, "focus");

    setValue("month", "not-a-month");
    await tick();

    expect(document.getElementById("cal-label")?.textContent).toContain("May 2026");
    expect(held.dataset.date).toBe("2026-05-20");
    expect(document.activeElement).toBe(held);
    expect(focusCalls).not.toHaveBeenCalled();
  });

  it("lands keyboard focus on the day a key moves to in the next month", async () => {
    await mount();

    press(cellFor("2026-05-31"), "PageDown");
    await tick();

    expect(document.getElementById("cal-label")?.textContent).toContain("June 2026");
    expect(stops()).toEqual(["2026-06-30"]);
    expect(document.activeElement).toBe(cellFor("2026-06-30"));
  });

  it("moves keyboard focus inside the month in the same tick as the key", async () => {
    await mount();

    press(cellFor("2026-05-20"), "ArrowRight");

    expect(stops()).toEqual(["2026-05-21"]);
    expect(document.activeElement).toBe(cellFor("2026-05-21"));
  });

  it("drops a focus move still pending when it disconnects", async () => {
    await mount();
    cellFor("2026-05-31").focus();
    const calendar = controller();

    // The paint has landed and the focus move waits for the end of the batch.
    root().setAttribute("data-stimeo--calendar-month-value", "2026-06");
    calendar.monthValueChanged();
    const focusCalls = vi.spyOn(HTMLElement.prototype, "focus");
    calendar.disconnect();
    await tick();

    expect(document.getElementById("cal-label")?.textContent).toContain("June 2026");
    expect(focusCalls).not.toHaveBeenCalled();
  });

  it("moves focus with the month again once it reconnects", async () => {
    // An in-page move disconnects and reconnects the same instance, and a
    // paint Stimulus delivers in between, with focus in the grid, has no focus
    // move coming.
    await mount();
    cellFor("2026-05-31").focus();
    const calendar = controller();
    calendar.disconnect();
    setValue("month", "2026-06");
    await tick();
    calendar.connect();

    const stop = document.querySelector<HTMLElement>(
      "[data-stimeo--calendar-target='day'][tabindex='0']",
    ) as HTMLElement;
    expect(stop.dataset.date).toBe("2026-05-31");
    stop.focus();
    setValue("month", "2026-07");
    await tick();

    expect(document.activeElement).toBe(cellFor("2026-07-31"));
  });
});

/**
 * A pick is painted first — `aria-selected` and both fields — and then
 * reported: each field that moved, `monthchange` when the paint moved the
 * month, then `select`. A bound a listener moves meanwhile is applied by the
 * repaint its Value callback runs, after `select`, as `reconcile`. A listener
 * that replaces the selection before these reports are all out — by picking
 * another day, or with a paint that withholds this one — has the newer
 * selection report itself, and what is still pending for the replaced pick is
 * not sent.
 */
describe("CalendarController reports of a pick", () => {
  let application: Application | undefined;

  /** One report, with what the grid showed as it went out. */
  interface Report {
    type: string;
    detail: unknown;
    field: string;
    month: string;
    selected: string[];
  }

  let reports: Report[] = [];

  const TYPES = [
    "change",
    "stimeo--calendar:monthchange",
    "stimeo--calendar:reconcile",
    "stimeo--calendar:select",
  ];

  const cells = () => {
    let html = "";
    for (let row = 0; row < 6; row++) {
      html += '<tr role="row">';
      for (let column = 0; column < 7; column++) {
        html += '<td role="gridcell" data-stimeo--calendar-target="day" tabindex="-1"></td>';
      }
      html += "</tr>";
    }
    return html;
  };

  const mount = async (values: Record<string, string>) => {
    const attributes = Object.entries(values)
      .map(([name, value]) => `data-stimeo--calendar-${name}-value="${value}"`)
      .join(" ");
    document.body.innerHTML = `
      <div id="cal" data-controller="stimeo--calendar" ${attributes}>
        <input type="hidden" name="on" data-stimeo--calendar-target="field" />
        <input type="hidden" name="month" data-stimeo--calendar-target="monthField" />
        <span id="cal-label" data-stimeo--calendar-target="label"></span>
        <table role="grid" aria-labelledby="cal-label">
          <tbody data-stimeo--calendar-target="grid"
                 data-action="keydown->stimeo--calendar#onKeydown
                              click->stimeo--calendar#selectByClick">${cells()}</tbody>
        </table>
      </div>`;
    application = Application.start();
    application.register("stimeo--calendar", CalendarController);
    await delay(150);
  };

  const root = () => document.getElementById("cal") as HTMLElement;
  const input = (name: "field" | "monthField") =>
    document.querySelector<HTMLInputElement>(
      `[data-stimeo--calendar-target='${name}']`,
    ) as HTMLInputElement;
  const cellFor = (date: string) =>
    document.querySelector<HTMLElement>(`[data-date="${date}"]`) as HTMLElement;
  const selected = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-stimeo--calendar-target='day'][aria-selected='true']",
      ),
      (cell) => cell.dataset.date ?? "",
    );
  const setValue = (name: string, value: string) => {
    root().setAttribute(`data-stimeo--calendar-${name}-value`, value);
  };

  // Captured on the document ahead of every other listener, so each entry is
  // the state the report was sent with, before a listener could move it.
  const record = (event: Event) => {
    const entry = (type: string, detail: unknown): Report => ({
      type,
      detail,
      field: input("field").value,
      month: input("monthField").value,
      selected: selected(),
    });
    if (event instanceof CustomEvent) {
      reports.push(entry(event.type.replace("stimeo--calendar:", ""), event.detail));
      return;
    }
    const name = (event.target as HTMLElement).getAttribute("data-stimeo--calendar-target");
    if (name) reports.push(entry(`${name}:change`, (event.target as HTMLInputElement).value));
  };

  /** What the grid shows while it publishes `day` and paints `month`. */
  const showing = (day: string, month: string) => ({
    field: day,
    month,
    selected: day ? [day] : [],
  });

  /**
   * Runs `listener` for the first event only. happy-dom calls a `once`
   * listener again from a dispatch nested in its own callback, which a
   * listener that picks another day makes.
   */
  const firstOnly = (listener: () => void) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      listener();
    };
  };

  beforeEach(() => {
    reports = [];
    for (const type of TYPES) document.addEventListener(type, record, true);
  });

  afterEach(async () => {
    for (const type of TYPES) document.removeEventListener(type, record, true);
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    await delay(50);
  });

  it("reports a pick after painting it, and a bound tightened meanwhile after select", async () => {
    await mount({ month: "2026-05", selected: "2026-05-10" });
    input("field").addEventListener(
      "change",
      firstOnly(() => setValue("max", "2026-05-15")),
    );

    cellFor("2026-05-20").click();
    await tick();

    expect(reports).toEqual([
      { type: "field:change", detail: "2026-05-20", ...showing("2026-05-20", "2026-05") },
      { type: "select", detail: { date: "2026-05-20" }, ...showing("2026-05-20", "2026-05") },
      { type: "reconcile", detail: { date: "" }, ...showing("", "2026-05") },
    ]);
  });

  it("leaves a pick a field listener replaced to the pick that replaced it", async () => {
    await mount({ month: "2026-05", selected: "2026-05-10" });
    input("field").addEventListener(
      "change",
      firstOnly(() => cellFor("2026-05-25").click()),
    );

    cellFor("2026-05-20").click();
    await tick();

    expect(reports).toEqual([
      { type: "field:change", detail: "2026-05-20", ...showing("2026-05-20", "2026-05") },
      { type: "field:change", detail: "2026-05-25", ...showing("2026-05-25", "2026-05") },
      { type: "select", detail: { date: "2026-05-25" }, ...showing("2026-05-25", "2026-05") },
    ]);
  });

  it("sends no select for a pick a listener's own paint withheld", async () => {
    await mount({ month: "2026-05", selected: "2026-05-10" });
    input("field").addEventListener(
      "change",
      firstOnly(() => {
        setValue("max", "2026-05-15");
        press(cellFor("2026-05-20"), "ArrowRight");
      }),
    );

    cellFor("2026-05-20").focus();
    cellFor("2026-05-20").click();
    await tick();

    // The field the bound emptied is reported as the repair, not as the key's move.
    expect(reports).toEqual([
      { type: "field:change", detail: "2026-05-20", ...showing("2026-05-20", "2026-05") },
      { type: "reconcile", detail: { date: "" }, ...showing("", "2026-05") },
    ]);
    // Focus stays on the day the listener's key moved it to.
    expect(document.activeElement).toBe(cellFor("2026-05-21"));
  });

  it("refuses a day a bound moved past in the same task, before its cell is painted", async () => {
    await mount({ month: "2026-05", selected: "2026-05-10" });

    setValue("max", "2026-05-15");
    cellFor("2026-05-20").click();
    await tick();

    expect(reports).toEqual([]);
    expect(selected()).toEqual(["2026-05-10"]);
    expect(input("field").value).toBe("2026-05-10");
    expect(cellFor("2026-05-20").getAttribute("aria-disabled")).toBe("true");
  });

  it("leaves the month a replaced pick painted to the pick that moved it on", async () => {
    // A malformed `month` falls back to the focused day's month, so a pick of
    // a neighbouring month's cell moves the painted month.
    await mount({ month: "2026-13", selected: "2026-05-10" });
    input("field").addEventListener(
      "change",
      firstOnly(() => cellFor("2026-07-03").click()),
    );

    cellFor("2026-06-02").focus();
    cellFor("2026-06-02").click();
    await tick();

    const july = showing("2026-07-03", "2026-07");
    expect(reports).toEqual([
      { type: "field:change", detail: "2026-06-02", ...showing("2026-06-02", "2026-06") },
      { type: "field:change", detail: "2026-07-03", ...july },
      { type: "monthField:change", detail: "2026-07", ...july },
      { type: "monthchange", detail: { month: "2026-07" }, ...july },
      { type: "select", detail: { date: "2026-07-03" }, ...july },
    ]);
    expect(input("monthField").value).toBe("2026-07");
    // The painted month moved under the focused cell, so focus goes to the tab stop.
    expect(document.activeElement).toBe(cellFor("2026-07-03"));
  });
});

/**
 * A grid that declares no `month` picks the month it opens on when it first
 * connects. The same instance connects again when its identifier is added back
 * or its element moves to another parent, and the month on screen stays — even
 * after the page moved the selection into another month, which the grid reports
 * as `reconcile` without leaving its month. A snapshot that renders again is a
 * new instance, and it opens on the month of its selection.
 */
describe("CalendarController reconnecting without a month", () => {
  let application: Application;
  const reports: string[] = [];

  const TYPES = [
    "stimeo--calendar:monthchange",
    "stimeo--calendar:reconcile",
    "stimeo--calendar:select",
  ];

  const cells = () => {
    let html = "";
    for (let row = 0; row < 6; row++) {
      html += '<tr role="row">';
      for (let column = 0; column < 7; column++) {
        html += '<td role="gridcell" data-stimeo--calendar-target="day" tabindex="-1"></td>';
      }
      html += "</tr>";
    }
    return html;
  };

  const record = (event: Event) => {
    const type = event.type.replace("stimeo--calendar:", "");
    reports.push(`${type} ${JSON.stringify((event as CustomEvent).detail)}`);
  };

  const start = async () => {
    application = Application.start();
    application.register("stimeo--calendar", CalendarController);
    await delay(150);
  };

  beforeEach(async () => {
    document.body.innerHTML = `
      <div id="host"><div id="cal" data-controller="stimeo--calendar"
           data-stimeo--calendar-selected-value="2026-09-10">
        <span id="cal-label" data-stimeo--calendar-target="label"></span>
        <input type="hidden" id="month-field" data-stimeo--calendar-target="monthField" />
        <table role="grid" aria-labelledby="cal-label">
          <tbody data-stimeo--calendar-target="grid">${cells()}</tbody>
        </table>
      </div></div>
      <div id="elsewhere"></div>`;
    for (const type of TYPES) document.addEventListener(type, record);
    await start();
  });

  afterEach(async () => {
    for (const type of TYPES) document.removeEventListener(type, record);
    reports.length = 0;
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    await delay(50);
  });

  const root = () => document.getElementById("cal") as HTMLElement;
  const label = () => document.getElementById("cal-label")?.textContent;
  const monthField = () => (document.getElementById("month-field") as HTMLInputElement).value;
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--calendar",
    ) as CalendarController;

  /** The page moves the selection into November while the grid shows September. */
  const moveSelectionToNovember = async () => {
    expect(label()).toContain("September 2026");
    root().setAttribute("data-stimeo--calendar-selected-value", "2026-11-05");
    await delay(50);
    expect(label()).toContain("September 2026");
    expect(reports).toEqual(['reconcile {"date":"2026-11-05"}']);
  };

  /** The ways the same instance connects again: its identifier, and a move in the page. */
  const reconnects: Array<[string, () => Promise<void>]> = [
    [
      "its identifier is added back",
      async () => {
        root().removeAttribute("data-controller");
        await delay(50);
        root().setAttribute("data-controller", "stimeo--calendar");
      },
    ],
    [
      "its element moves to another parent",
      async () => {
        document.getElementById("elsewhere")?.append(root());
      },
    ],
  ];

  it.each(reconnects)(
    "keeps the month on screen when the same instance connects again after %s",
    async (_how, reconnect) => {
      const instance = controller();
      await moveSelectionToNovember();

      await reconnect();
      await delay(50);

      expect(controller()).toBe(instance);
      expect(label()).toContain("September 2026");
      expect(monthField()).toBe("2026-09");
      expect(root().hasAttribute("data-stimeo--calendar-month-value")).toBe(false);
      expect(reports).toEqual(['reconcile {"date":"2026-11-05"}']);
    },
  );

  it.each(reconnects)(
    "keeps the month on screen after the page clears a declared month, when the same instance connects again after %s",
    async (_how, reconnect) => {
      // A new instance, whose first connection declares May.
      disconnectAndStopApplication(application);
      root().setAttribute("data-stimeo--calendar-month-value", "2026-05");
      root().setAttribute("data-stimeo--calendar-selected-value", "2026-05-10");
      await start();
      const instance = controller();

      root().setAttribute("data-stimeo--calendar-month-value", "");
      await delay(50);
      // The selection moves into August while May is on screen.
      root().setAttribute("data-stimeo--calendar-selected-value", "2026-08-10");
      await delay(50);
      expect(label()).toContain("May 2026");
      expect(reports).toEqual(['reconcile {"date":"2026-08-10"}']);

      await reconnect();
      await delay(50);

      expect(controller()).toBe(instance);
      expect(label()).toContain("May 2026");
      expect(monthField()).toBe("2026-05");
      expect(root().getAttribute("data-stimeo--calendar-month-value")).toBe("");
      expect(reports).toEqual(['reconcile {"date":"2026-08-10"}']);
    },
  );

  it("opens a snapshot rendered again on the month of its selection, as a new instance", async () => {
    await moveSelectionToNovember();
    const snapshot = document.getElementById("host")?.innerHTML ?? "";

    disconnectAndStopApplication(application);
    (document.getElementById("host") as HTMLElement).innerHTML = snapshot;
    await start();

    expect(label()).toContain("November 2026");
    expect(monthField()).toBe("2026-11");
    expect(reports).toEqual(['reconcile {"date":"2026-11-05"}']);
  });
});
