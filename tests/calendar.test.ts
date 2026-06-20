import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarController } from "../src/controllers/calendar_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

const tick = () => new Promise((r) => setTimeout(r, 0));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    application.stop();
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
    // June 16 is index 42-1=41. Index 41 is 2026-06-06. Wait, May has 31 days.
    // April 26 (Index 0) -> April 30 (Index 4)
    // May 1 (Index 5) -> May 31 (Index 35)
    // June 1 (Index 36) -> June 6 (Index 41).
    // All in-range for max 06-15. Let's inspect June 6.
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
    // synchronously (which previously double-rendered).
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
    cell?.focus();
    cell?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  };

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
});
