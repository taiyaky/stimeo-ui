import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarController } from "../src/controllers/calendar_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { press } from "./helpers/keyboard";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { delay, tick } from "./helpers/timing";

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

    // Go to next month (June 2026)
    controller.next();
    controller.render();

    expect(label?.textContent).toContain("June 2026");

    // Go back two months (April 2026)
    controller.prev();
    controller.render();
    controller.prev();
    controller.render();

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

    controller.selectDayElement(targetCell);
    controller.render();

    expect(targetCell.getAttribute("aria-selected")).toBe("true");
    expect(selectHandler).toHaveBeenCalledOnce();
    expect(selectHandler.mock.calls[0]?.[0]?.detail).toEqual({ date: "2026-05-15" });

    // Disabled day cannot be selected
    const disabledCell = days[0] as HTMLElement; // April 26 (disabled)
    controller.selectDayElement(disabledCell);
    controller.render();
    expect(disabledCell.getAttribute("aria-selected")).toBe("false");
  });

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
    controller.render();

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
    const controller = application.getControllerForElementAndIdentifier(
      document.getElementById("calendar") as HTMLElement,
      "stimeo--calendar",
    ) as CalendarController;

    const renderSpy = vi.spyOn(controller, "render");
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

    expect(document.getElementById("label")?.textContent).toContain("June 2026");
    expect(document.activeElement?.getAttribute("data-date")).toBe("2026-06-01");
    expect(renderSpy).toHaveBeenCalledTimes(1);
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

    // Select a different day (May 15, index 19).
    const newTarget = days[19] as HTMLElement;
    controller.selectDayElement(newTarget);
    controller.render();

    // After selection, May 15 is selected and May 31 is no longer selected.
    const afterSelectedPhrases = await captureSpeech({ container: newTarget, steps: 0 });
    const afterDeselectedPhrases = await captureSpeech({ container: initialSelected, steps: 0 });

    expect(afterSelectedPhrases).toEqual(["gridcell, 15, selected"]);
    // Previously-selected cell announces "not selected" after deselection.
    expect(afterDeselectedPhrases).toEqual(["gridcell, 31, not selected"]);
  });

  it("cancels deferred focus on disconnect so a detached controller never steals focus", async () => {
    const days = document.querySelectorAll("[data-stimeo--calendar-target='day']");
    const startCell = days[35] as HTMLElement; // May 31 (tabindex="0")
    startCell.focus();

    const controller = application.getControllerForElementAndIdentifier(
      document.getElementById("calendar") as HTMLElement,
      "stimeo--calendar",
    ) as CalendarController;

    // Spy to detect any .focus() call made by the deferred-focus timer.
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      // ArrowRight from May 31 crosses into June — triggers a month transition
      // and schedules focusTimer.set(focusTarget, 0) inside the controller.
      startCell.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      const callsBeforeDisconnect = focusSpy.mock.calls.length;

      // Disconnect synchronously — what Stimulus does when the element detaches —
      // before yielding to the event loop, so disconnect()'s focusTimer.clearAll()
      // cancels the pending 0ms timer deterministically (no reliance on the
      // MutationObserver/timer ordering happy-dom does not guarantee).
      controller.disconnect();

      await delay(50); // the cancelled timer must never fire
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
    // Roving tabindex is the grid's only way in: render() gives tabindex="0" to
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

  const mount = async (month: string) => {
    document.body.innerHTML = `
      <div id="cal" data-controller="stimeo--calendar"
           data-stimeo--calendar-month-value="${month}">
        <span id="cal-label" data-stimeo--calendar-target="label"></span>
        <table role="grid" aria-labelledby="cal-label">
          <tbody data-stimeo--calendar-target="grid"
                 data-action="keydown->stimeo--calendar#onKeydown
                              click->stimeo--calendar#selectByClick">${cells()}</tbody>
        </table>
      </div>`;
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
    // With no attribute the controller picks the current month and assigns it,
    // which drives the same callback by a different route.
    await mount("");
    expect(document.getElementById("cal-label")?.textContent).toBeTruthy();
    expect(months).toEqual([]);
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
