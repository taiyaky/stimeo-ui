import { Controller } from "@hotwired/stimulus";
import { parseISODateString, parseISOMonthString, toISODateString } from "../utils/dates";
import { SafeTimeout } from "../utils/safe_timeout";

/**
 * Headless, highly accessible calendar grid behavior.
 *
 * Markup contract (identifier: `stimeo--calendar`):
 *   <div data-controller="stimeo--calendar"
 *        data-stimeo--calendar-month-value="2026-05"
 *        data-stimeo--calendar-selected-value="2026-05-31">
 *     <button data-action="stimeo--calendar#prev">Previous</button>
 *     <span data-stimeo--calendar-target="label">May 2026</span>
 *     <button data-action="stimeo--calendar#next">Next</button>
 *     <table role="grid">
 *       <tbody data-stimeo--calendar-target="grid"
 *              data-action="keydown->stimeo--calendar#onKeydown
 *                           click->stimeo--calendar#selectByClick">
 *         <!-- Markup must contain exactly 42 day targets (7 days x 6 rows) -->
 *         <tr role="row">
 *           <td role="gridcell" data-stimeo--calendar-target="day" tabindex="-1"></td>
 *         </tr>
 *       </tbody>
 *     </table>
 *   </div>
 *
 * Implements the WAI-ARIA APG **Date Picker Dialog** grid navigation pattern:
 * - Local-aware month/year labels using native `Intl.DateTimeFormat`.
 * - Roving tabindex focus tracking (exactly one focusable day at any time).
 * - Full grid keyboard controls (arrows, PageUp/Down, Home/End, Shift+PageUp/Down).
 * - Automatic month wrapping and date clamping for missing dates (e.g. leap years, 31st to 30th).
 *
 * @remarks
 * Behavior only. The controller updates classes, attributes (aria-selected, data-outside, etc.),
 * and text contents dynamically on 42 pre-allocated `day` targets.
 */
export class CalendarController extends Controller<HTMLElement> {
  static override targets = ["label", "grid", "day"];
  static override values = {
    month: { type: String, default: "" },
    selected: { type: String, default: "" },
    min: { type: String, default: "" },
    max: { type: String, default: "" },
    weekStart: { type: Number, default: 0 }, // 0 = Sunday, 1 = Monday, etc.
  };
  static actions = ["next", "onKeydown", "prev", "selectByClick"] as const;
  static events = ["monthchange", "select"] as const;

  declare readonly labelTarget: HTMLElement;
  declare readonly gridTarget: HTMLElement;
  declare readonly dayTargets: HTMLElement[];
  declare readonly hasLabelTarget: boolean;
  declare readonly hasGridTarget: boolean;

  declare monthValue: string;
  declare selectedValue: string;
  declare minValue: string;
  declare maxValue: string;
  declare weekStartValue: number;

  /** The date currently receiving focus in the grid (local time). */
  focusedDate: Date = new Date();

  /**
   * Deferred focus moves scheduled after an asynchronous month transition.
   * Tracked so {@link disconnect} can cancel any pending move and a detached
   * controller never steals focus after the element leaves the DOM (Turbo).
   */
  #focusTimer = new SafeTimeout();

  override connect(): void {
    // Initialize monthValue to current month if not provided
    if (!this.monthValue) {
      const today = new Date();
      const monthStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
      this.monthValue = monthStr;
      return;
    }

    this.#initializeFocusedDate();
    this.render();
  }

  /** Cancels any pending deferred focus so it never fires on a detached element. */
  override disconnect(): void {
    this.#focusTimer.clearAll();
  }

  /**
   * Stimulus lifecycle callback triggered automatically when the monthValue changes.
   * Forces a re-render of the date grid and updates labels.
   */
  monthValueChanged(): void {
    if (!this.monthValue) return;
    this.#syncFocusedDateWithMonth();
    this.render();
    this.dispatch("monthchange", { detail: { month: this.monthValue } });
  }

  /**
   * Stimulus lifecycle callback triggered automatically when the selectedValue changes.
   * Re-renders grid cells to update `aria-selected` indicators.
   */
  selectedValueChanged(): void {
    if (this.selectedValue) {
      const selected = parseISODateString(this.selectedValue);
      if (selected) {
        this.focusedDate = selected;
      }
    }
    this.render();
  }

  /** Navigates to the previous month. */
  prev(event?: Event): void {
    if (event) event.preventDefault();
    this.#shiftMonth(-1);
  }

  /** Navigates to the next month. */
  next(event?: Event): void {
    if (event) event.preventDefault();
    this.#shiftMonth(1);
  }

  /** Handles day selection when a gridcell is clicked. */
  selectByClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const dayElement = target.closest("[data-stimeo--calendar-target='day']") as HTMLElement | null;
    if (!dayElement) return;

    this.selectDayElement(dayElement);
  }

  /** Handles grid cell keyboard navigation and triggers selection. */
  onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const dayElement = target.closest("[data-stimeo--calendar-target='day']") as HTMLElement | null;
    if (!dayElement) return;

    const dateStr = dayElement.getAttribute("data-date");
    if (!dateStr) return;
    const date = parseISODateString(dateStr);
    if (!date) return;

    let handled = true;
    let nextDate = new Date(date);

    switch (event.key) {
      case "ArrowLeft":
        nextDate.setDate(nextDate.getDate() - 1);
        break;
      case "ArrowRight":
        nextDate.setDate(nextDate.getDate() + 1);
        break;
      case "ArrowUp":
        nextDate.setDate(nextDate.getDate() - 7);
        break;
      case "ArrowDown":
        nextDate.setDate(nextDate.getDate() + 7);
        break;
      case "PageUp":
        if (event.shiftKey) {
          nextDate = this.#calculateShiftedYearDate(date, -1);
        } else {
          nextDate = this.#calculateShiftedMonthDate(date, -1);
        }
        break;
      case "PageDown":
        if (event.shiftKey) {
          nextDate = this.#calculateShiftedYearDate(date, 1);
        } else {
          nextDate = this.#calculateShiftedMonthDate(date, 1);
        }
        break;
      case "Home":
        nextDate = this.#getStartOfWeekDate(date);
        break;
      case "End":
        nextDate = this.#getEndOfWeekDate(date);
        break;
      case "t":
      case "T": {
        const now = new Date();
        nextDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      }
      case "Enter":
      case " ":
        event.preventDefault();
        this.selectDayElement(dayElement);
        return;
      default:
        handled = false;
        break;
    }

    if (handled) {
      event.preventDefault();
      this.#focusAndNavigateToDate(nextDate);
    }
  }

  /** Renders the grid days and updates the month/year label. */
  render(): void {
    const monthInfo = parseISOMonthString(this.monthValue);
    if (!monthInfo) return;

    const { year, month } = monthInfo;

    // Update label with localized month/year
    if (this.hasLabelTarget) {
      const lang = document.documentElement.lang || "en";
      const labelDate = new Date(year, month - 1, 1);
      const formatter = new Intl.DateTimeFormat(lang, { month: "long", year: "numeric" });
      this.labelTarget.textContent = formatter.format(labelDate);
    }

    const days = this.#calculateGridDays(year, month);
    const dayElements = this.dayTargets;

    // Iterate through pre-allocated day targets and bind state
    for (let i = 0; i < 42; i++) {
      const el = dayElements[i];
      if (!el) continue;

      const date = days[i];
      if (!date) continue;

      const dateStr = toISODateString(date);
      el.setAttribute("data-date", dateStr);
      el.textContent = String(date.getDate());

      // outside current month
      const isOutside = date.getFullYear() !== year || date.getMonth() !== month - 1;
      el.setAttribute("data-outside", String(isOutside));

      // today
      const todayStr = toISODateString(new Date());
      el.setAttribute("data-today", String(dateStr === todayStr));

      // selection state
      const isSelected = dateStr === this.selectedValue;
      el.setAttribute("aria-selected", String(isSelected));

      // roving tabindex
      const isFocused = toISODateString(this.focusedDate) === dateStr;
      el.setAttribute("tabindex", isFocused ? "0" : "-1");

      // min/max limits
      const isDisabled = this.#isDateOutOfBounds(dateStr);
      if (isDisabled) {
        el.setAttribute("aria-disabled", "true");
      } else {
        el.removeAttribute("aria-disabled");
      }
    }
  }

  selectDayElement(dayElement: HTMLElement): void {
    if (dayElement.getAttribute("aria-disabled") === "true") return;

    const dateStr = dayElement.getAttribute("data-date");
    if (!dateStr) return;

    this.selectedValue = dateStr;
    // Reflect the selection synchronously (move roving focus to the selected day and
    // repaint aria-selected) instead of waiting on the async value observer, so a
    // click or Enter updates the grid in the same tick — consistent with how the
    // navigation handler re-renders directly. selectedValueChanged remains for
    // external (consumer-driven) value changes.
    const selected = parseISODateString(dateStr);
    if (selected) this.focusedDate = selected;
    this.render();
    this.dispatch("select", { detail: { date: dateStr } });
  }

  #focusAndNavigateToDate(date: Date): void {
    this.focusedDate = date;
    const targetMonthStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const isMonthTransition = targetMonthStr !== this.monthValue;

    if (isMonthTransition) {
      // Automatic month transition: assigning monthValue triggers
      // `monthValueChanged`, which re-renders the grid and keeps the already-set
      // focusedDate (it sits in the target month, so `#syncFocusedDateWithMonth`
      // is a no-op). Do NOT render synchronously here too — that double-renders;
      // focus is deferred below until after that async re-render lands.
      this.monthValue = targetMonthStr;
    } else {
      this.render();
    }

    const focusTarget = () => {
      const dateStr = toISODateString(date);
      const targetEl = this.dayTargets.find((el) => el.getAttribute("data-date") === dateStr);
      targetEl?.focus();
    };

    if (isMonthTransition) {
      // Defer focus until Stimulus async lifecycle (monthValueChanged) has fully resolved
      this.#focusTimer.set(focusTarget, 0);
    } else {
      focusTarget();
    }
  }

  #isDateOutOfBounds(dateStr: string): boolean {
    if (this.minValue && dateStr < this.minValue) return true;
    if (this.maxValue && dateStr > this.maxValue) return true;
    return false;
  }

  #shiftMonth(delta: number): void {
    const monthInfo = parseISOMonthString(this.monthValue);
    if (!monthInfo) return;

    const nextMonthDate = new Date(monthInfo.year, monthInfo.month - 1 + delta, 1);
    this.monthValue = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, "0")}`;
  }

  #calculateShiftedMonthDate(baseDate: Date, delta: number): Date {
    const targetDate = new Date(baseDate.getFullYear(), baseDate.getMonth() + delta, 1);
    const lastDayInTarget = new Date(
      targetDate.getFullYear(),
      targetDate.getMonth() + 1,
      0,
    ).getDate();
    const clampedDay = Math.min(baseDate.getDate(), lastDayInTarget);
    targetDate.setDate(clampedDay);
    return targetDate;
  }

  #calculateShiftedYearDate(baseDate: Date, delta: number): Date {
    const targetDate = new Date(baseDate.getFullYear() + delta, baseDate.getMonth(), 1);
    const lastDayInTarget = new Date(
      targetDate.getFullYear(),
      targetDate.getMonth() + 1,
      0,
    ).getDate();
    const clampedDay = Math.min(baseDate.getDate(), lastDayInTarget);
    targetDate.setDate(clampedDay);
    return targetDate;
  }

  #getStartOfWeekDate(date: Date): Date {
    const currentDay = date.getDay();
    const shift = (currentDay - this.weekStartValue + 7) % 7;
    const target = new Date(date);
    target.setDate(date.getDate() - shift);
    return target;
  }

  #getEndOfWeekDate(date: Date): Date {
    const start = this.#getStartOfWeekDate(date);
    const target = new Date(start);
    target.setDate(start.getDate() + 6);
    return target;
  }

  #initializeFocusedDate(): void {
    if (this.selectedValue) {
      const selected = parseISODateString(this.selectedValue);
      if (selected) {
        this.focusedDate = selected;
        return;
      }
    }

    const monthInfo = parseISOMonthString(this.monthValue);
    if (monthInfo) {
      const today = new Date();
      if (today.getFullYear() === monthInfo.year && today.getMonth() === monthInfo.month - 1) {
        this.focusedDate = today;
      } else {
        this.focusedDate = new Date(monthInfo.year, monthInfo.month - 1, 1);
      }
    }
  }

  #syncFocusedDateWithMonth(): void {
    const monthInfo = parseISOMonthString(this.monthValue);
    if (!monthInfo) return;

    // Only align if focusedDate is outside current monthValue
    if (
      this.focusedDate.getFullYear() !== monthInfo.year ||
      this.focusedDate.getMonth() !== monthInfo.month - 1
    ) {
      const today = new Date();
      if (today.getFullYear() === monthInfo.year && today.getMonth() === monthInfo.month - 1) {
        this.focusedDate = today;
      } else {
        // Keep same day if possible, otherwise clamp to end of target month
        const targetDate = new Date(monthInfo.year, monthInfo.month - 1, 1);
        const lastDayInTarget = new Date(monthInfo.year, monthInfo.month, 0).getDate();
        const clampedDay = Math.min(this.focusedDate.getDate(), lastDayInTarget);
        targetDate.setDate(clampedDay);
        this.focusedDate = targetDate;
      }
    }
  }

  #calculateGridDays(year: number, month: number): Date[] {
    const firstDay = new Date(year, month - 1, 1);
    const dayOfWeek = firstDay.getDay();

    // calculate offset days based on weekStartValue
    const offset = (dayOfWeek - this.weekStartValue + 7) % 7;

    const days: Date[] = [];
    const current = new Date(firstDay);
    current.setDate(firstDay.getDate() - offset);

    for (let i = 0; i < 42; i++) {
      days.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }

    return days;
  }
}
