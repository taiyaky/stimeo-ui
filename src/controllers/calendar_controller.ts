import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord, logicalArrowKey } from "../utils/arrow_step";
import {
  parseISODateString,
  parseISOMonthString,
  toISODateString,
  toISOMonthString,
} from "../utils/dates";
import { SafeTimeout } from "../utils/safe_timeout";

/**
 * Marks an `aria-disabled` this controller wrote, so a re-paint takes back only
 * its own. A consumer marks holidays and booked days with the same attribute;
 * without the marker a paint would clear their intent.
 *
 * The marker is scoped to the date the cell currently shows, not to the cell: the
 * 42 cells are recycled every month, so a value that outlived its date would
 * disable a different day. A consumer that marks specific dates applies them once
 * for the month the grid opens on, then re-applies after
 * `stimeo--calendar:monthchange`, which reports a move to a different month.
 */
const OWNED_DISABLED = "data-stimeo--calendar-owns-disabled";

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
 * `monthchange` dispatches `{ month: string }`; `select` dispatches `{ date: string }`.
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

  /**
   * The painted month the last `monthchange` reported, or `null` before the first
   * paint. Settling on the initial month — whether it comes from the attribute or
   * is derived here — is the grid describing itself, not a navigation, so it must
   * not reach a listener that refetches inventory or pushes history.
   */
  #announcedMonth: string | null = null;

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
    const dayElement = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-stimeo--calendar-target='day']",
    );
    if (!dayElement) return;

    this.selectDayElement(dayElement);
  }

  /** Handles grid cell keyboard navigation and triggers selection. */
  onKeydown(event: KeyboardEvent): void {
    // A widget that already claimed the key (a nested control, an enclosing
    // composite) must not ALSO move the roving focus or select a day.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    const dayElement = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-stimeo--calendar-target='day']",
    );
    if (!dayElement) return;

    // A cell the paint never reached carries no `data-date`, and an empty string
    // parses to null — one exit covers both.
    const date = parseISODateString(dayElement.getAttribute("data-date") ?? "");
    if (!date) return;

    let handled = true;
    let nextDate = new Date(date);

    // Logical, not physical. The key is normalised rather than the
    // delta negated: these two branches are not mirror images — their guards
    // differ — so swapping the key keeps each guard with its own direction.
    switch (logicalArrowKey(event.key, this.element)) {
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
        // A single printable key must not be claimed out of a modifier chord:
        // Ctrl/Cmd/Alt+T belongs to the browser, not to the grid.
        if (event.ctrlKey || event.metaKey || event.altKey) {
          handled = false;
          break;
        }
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

  /**
   * First day of the month the grid paints: the `month` Value when it parses,
   * otherwise the focused date's month.
   *
   * A malformed `month` falls back instead of stopping the paint: every cell
   * keeps its `aria-selected` and the grid keeps its tab stop, so a Value typo
   * still leaves the grid reachable by Tab and the author can see what they
   * typed. Every consumer of "which month is on screen" reads it from here, so
   * the paint and the `monthchange` report cannot name different months.
   */
  #paintedMonthStart(): Date {
    const monthInfo = parseISOMonthString(this.monthValue);
    return monthInfo
      ? new Date(monthInfo.year, monthInfo.month - 1, 1)
      : new Date(this.focusedDate.getFullYear(), this.focusedDate.getMonth(), 1);
  }

  /**
   * Renders the grid days and updates the month/year label, then reports the
   * painted month once it differs from the one already announced.
   *
   * The report belongs to the paint, not to the `month` Value: the Value is only
   * one of the things that decide the month on screen. While a malformed `month`
   * falls back, changing `selected` and selecting a neighbouring month's cell
   * move the painted month too, and both repaint from here. Reading the report
   * off the paint keeps the event naming the month the grid shows, in the
   * `YYYY-MM` the detail contract promises, whichever route repainted.
   */
  render(): void {
    const monthStart = this.#paintedMonthStart();
    const year = monthStart.getFullYear();
    const month = monthStart.getMonth() + 1;

    // Update label with localized month/year
    if (this.hasLabelTarget) {
      const lang = document.documentElement.lang || "en";
      const formatter = new Intl.DateTimeFormat(lang, { month: "long", year: "numeric" });
      this.labelTarget.textContent = formatter.format(monthStart);
    }

    const days = this.#calculateGridDays(year, month);
    const dayElements = this.dayTargets;

    // Driven by the dates, so every iteration has one. A short `day` target set
    // is the consumer's markup contradicting the documented 42 cells: paint the
    // ones that exist rather than dropping the grid out of the tab order.
    for (const [index, date] of days.entries()) {
      const el = dayElements[index];
      if (!el) continue;

      const dateStr = toISODateString(date);
      // The 42 cells are recycled across months, so an `aria-disabled` the
      // consumer wrote describes the date the cell showed before this paint.
      // Carrying it over would silently disable an unrelated day, so a date change
      // resets the attribute to whatever this render decides below.
      if (el.getAttribute("data-date") !== dateStr) {
        el.removeAttribute("aria-disabled");
        el.removeAttribute(OWNED_DISABLED);
      }
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

      // min/max limits. Only the value this controller wrote comes back off: a
      // consumer marks holidays and booked days with the same attribute, and
      // clearing it on every paint would silently throw their intent away.
      const isDisabled = this.#isDateOutOfBounds(dateStr);
      if (isDisabled) {
        if (!el.hasAttribute("aria-disabled")) el.setAttribute(OWNED_DISABLED, "");
        el.setAttribute("aria-disabled", "true");
      } else if (el.hasAttribute(OWNED_DISABLED)) {
        el.removeAttribute("aria-disabled");
        el.removeAttribute(OWNED_DISABLED);
      }
    }

    // Roving contract: exactly one focusable cell, always. `focusedDate` can sit
    // outside the rendered range — `selected` names a day in another month, and
    // nothing forces the two Values to agree — in which case no cell matched
    // above and the grid would be unreachable by Tab. Fall back to the first day
    // of the shown month so there is always a way in; arrow navigation reads the
    // date off the focused cell, so it continues from wherever the tab stop is.
    if (!dayElements.some((el) => el.getAttribute("tabindex") === "0")) {
      const fallback =
        dayElements.find((el) => el.getAttribute("data-outside") === "false") ?? dayElements[0];
      fallback?.setAttribute("tabindex", "0");
    }

    // Post-paint, so a listener that re-marks holidays and booked days sees the
    // cells of the month it is being told about.
    const painted = toISOMonthString(monthStart);
    const previous = this.#announcedMonth;
    this.#announcedMonth = painted;
    if (previous !== null && previous !== painted) {
      this.dispatch("monthchange", { detail: { month: painted } });
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
    // navigation handler re-renders directly. `selectedValueChanged` covers
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
