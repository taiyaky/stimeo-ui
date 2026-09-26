import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord, logicalArrowKey } from "../utils/arrow_step";
import {
  monthLabelFormatter,
  parseISODateString,
  parseISOMonthString,
  toISODateString,
  toISOMonthString,
} from "../utils/dates";
import { commitField, writeField } from "../utils/field_mirror";
import { resolveLocale } from "../utils/locale";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { targetSelector } from "../utils/target_selector";

/**
 * Suffix of the marker on an `aria-disabled` this controller wrote, so a re-paint
 * takes back only its own. A consumer marks holidays and booked days with the same
 * attribute; without the marker a paint would clear their intent.
 *
 * The marker is scoped to the date the cell currently shows, not to the cell: the
 * 42 cells are recycled, so a value that outlived its date would disable a
 * different day. A consumer's value belongs to its date as well: a repaint that
 * moves the date to another cell carries the value along, and a date that leaves
 * the grid loses it. A consumer that marks specific dates applies them once for
 * the month the grid opens on, then again after `stimeo--calendar:monthchange`,
 * which reports a move to a different month.
 */
const OWNED_DISABLED = "owns-disabled";

/**
 * Headless, highly accessible calendar grid behavior.
 *
 * Markup contract (identifier: `stimeo--calendar`):
 *   <div data-controller="stimeo--calendar"
 *        data-stimeo--calendar-month-value="2026-05"
 *        data-stimeo--calendar-selected-value="2026-05-31">
 *     <input type="hidden" name="on" data-stimeo--calendar-target="field" />
 *     <input type="hidden" name="month" data-stimeo--calendar-target="monthField" />
 *     <button data-action="click->stimeo--calendar#prev">Previous</button>
 *     <span data-stimeo--calendar-target="label">May 2026</span>
 *     <button data-action="click->stimeo--calendar#next">Next</button>
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
 * - Locale-aware month/year labels using native `Intl.DateTimeFormat`, taken from
 *   the `locale` Value, else the nearest `lang` up the ancestor chain, else the
 *   runtime default; a malformed language tag falls back to English so the grid
 *   still paints.
 * - Without a `month`, the grid opens on the month of the selected day, else on
 *   the current month, when an instance first connects, and stays on the month
 *   it shows until a month step or the page writes `month` — a later connection
 *   of the same instance, after an in-page move or with the identifier added
 *   back, keeps it too. Opening on a month writes nothing to `month`.
 * - Roving tabindex focus tracking (exactly one focusable day at any time). The
 *   tab stop opens on the selected day, else on today when the shown month
 *   holds it, else on the 1st of the shown month; a selected day the grid does
 *   not show leaves it on the 1st.
 * - Full grid keyboard controls (arrows, PageUp/Down, Home/End, Shift+PageUp/Down).
 * - Automatic month wrapping and date clamping for missing dates (e.g. leap years, 31st to 30th).
 * - `min`, `max` and `weekStart` changed at runtime repaint the month on screen
 *   once connected, and DOM focus in the grid stays on the day it was on while
 *   that day is still shown.
 * - A `month` that moves the painted month — written by application code, a
 *   morph, or the grid's own month steps — takes DOM focus in the grid to the
 *   tab stop of the new month. A key that crosses into another month makes the
 *   day it moved to that tab stop, so focus lands there.
 * - An `aria-disabled` the consumer wrote on a day stays with that date while
 *   the grid shows it, in whichever cell a repaint moves the date to.
 *
 * `selected` is a request: the grid publishes it as the selection only while
 * `min` / `max` allow that day. A day outside them is neither `aria-selected`
 * nor mirrored into `field`, and it comes back once the bounds allow it again;
 * the Value itself is never rewritten.
 *
 * `monthchange` dispatches `{ month: string }`; `select` dispatches `{ date: string }`.
 * `reconcile` dispatches `{ date: string }` — the selection now published, empty
 * when there is none — once per paint in which a change the page made after
 * connect moved the published selection: `selected` written by application
 * code or a morph, or `min` / `max` withholding the requested day or giving it
 * back. A selection the user picks is reported as `select` alone. Connecting,
 * or connecting again, reports neither `monthchange` nor `reconcile`, whichever
 * month the grid opens on.
 *
 * Two optional fields carry the grid's state into a form, so a server can serve
 * the days it is showing: `field` mirrors the published selection (`YYYY-MM-DD`,
 * empty when nothing is selected) and `monthField` the month being painted
 * (`YYYY-MM`). A move the user made — the previous/next controls, a month
 * crossing by keyboard, picking a day — emits a native bubbling `change` from
 * the field that moved, the way a form control does, so `stimeo--auto-submit`
 * and form-level validation hear it. A repaint driven by the Values, by a
 * replacement field, or by the initial paint refreshes both mirrors silently,
 * and so does a move of the selection a change the page made, which `reconcile`
 * reports even in a paint the user's own move asked for.
 *
 * A day `min` / `max` exclude cannot be picked, even before a paint has marked
 * its cell. A pick is painted — `aria-selected` and both fields — before
 * anything reports it: each field that moved, then `monthchange` when the paint
 * moved the month, then `select`. A listener that replaces the selection before
 * these reports are all out — by picking another day, or with a paint in which
 * `min` / `max` withhold this one — has the newer selection report itself, and
 * what is still pending for the replaced pick is not sent.
 *
 * @remarks
 * Behavior only. The controller updates attributes (`aria-selected`, `data-outside`,
 * `tabindex`, …) and text content on the 42 pre-allocated `day` targets.
 */
export class CalendarController extends Controller<HTMLElement> {
  /** The marker above, in the namespace this controller is registered under. */
  get #ownedDisabled(): string {
    return `data-${this.identifier}-${OWNED_DISABLED}`;
  }

  static override targets = ["label", "grid", "day", "field", "monthField"];
  static override values = {
    month: { type: String, default: "" },
    selected: { type: String, default: "" },
    min: { type: String, default: "" },
    max: { type: String, default: "" },
    weekStart: { type: Number, default: 0 }, // 0 = Sunday, 1 = Monday, etc.
    locale: { type: String, default: "" },
  };
  static actions = ["next", "onKeydown", "prev", "selectByClick"] as const;
  static events = ["monthchange", "reconcile", "select"] as const;

  declare readonly labelTarget: HTMLElement;
  declare readonly gridTarget: HTMLElement;
  declare readonly dayTargets: HTMLElement[];
  declare readonly fieldTarget: HTMLInputElement;
  declare readonly monthFieldTarget: HTMLInputElement;
  declare readonly hasLabelTarget: boolean;
  declare readonly hasGridTarget: boolean;
  declare readonly hasFieldTarget: boolean;
  declare readonly hasMonthFieldTarget: boolean;

  declare monthValue: string;
  declare selectedValue: string;
  declare minValue: string;
  declare maxValue: string;
  declare weekStartValue: number;
  declare localeValue: string;

  /** The date currently receiving focus in the grid (local time). */
  focusedDate: Date = new Date();

  /**
   * Whether `connect()` has run and `disconnect()` has not since. The paints
   * before and during `connect()` describe the grid, so they report nothing.
   */
  #connected = false;

  /**
   * The selection the last paint published — a `YYYY-MM-DD` day, or `""` — which
   * the next move of the selection is measured from. A pick records its own day
   * here before painting it.
   */
  #published = "";

  /**
   * How many times a pick or a change the page made has moved the selection, so
   * a report still pending for a selection a listener has since replaced can tell.
   */
  #selectionMoves = 0;

  /**
   * The month the last paint showed (`YYYY-MM`), or `""` before the first paint.
   * Only a connected grid reports a paint that moves it: settling on the initial
   * month — before `connect()` or in it, from the attribute or derived here — is
   * the grid describing itself, not a navigation, so it must not reach a
   * listener that refetches inventory or pushes history.
   *
   * While `month` is empty this is also the month the next paint shows, so the
   * grid stays where it is; the first `connect()` of this instance sets it to the
   * month the grid opens on.
   */
  #paintedMonth = "";

  /**
   * Whether this instance has connected before. Only its first connection picks
   * the month a grid with no `month` opens on. A later one keeps the month on
   * screen, and so do the paints Stimulus runs before it.
   */
  #opened = false;

  /**
   * Whether the paint about to run was asked for by this grid's own controls.
   * The `month` and `selected` Values are shared with the page — application
   * code and a Turbo morph write them too — so the field mirrors take their
   * "did the user commit this" answer from the route, not from the Value.
   */
  #movedByUser = false;

  /**
   * Repaints the month on screen after `min`, `max` or `weekStart` changed.
   *
   * A morph that swaps several of them repaints once, and the delivery Stimulus
   * makes before `connect()` is refused, because the grid is painted on
   * connect. None of these Values decides the month on screen; `min` and `max`
   * decide whether the requested day is published.
   */
  readonly #repaint = new MicrotaskCoalescer(() => {
    this.#repaintKeepingFocus();
  });

  /**
   * The cell DOM focus was on, its day and the month on screen, recorded by the
   * first repaint of a batch for the pass that settles focus after it.
   */
  #focusOrigin: { cell: HTMLElement; date: string | null; month: string } | null = null;

  /**
   * Settles DOM focus once, after the last repaint of a batch. The callbacks of
   * one mutation repaint one by one and each reads every Value as it stands, so
   * a `selected` or `locale` callback can paint a month before that month's own
   * callback has moved the tab stop into it. Outside a connection no pass is
   * scheduled, so a grid that is not connected moves no focus.
   */
  readonly #settleFocus = new MicrotaskCoalescer(() => {
    this.#restoreFocus();
  });

  override connect(): void {
    this.#repaint.activate();
    this.#settleFocus.activate();
    // A record a paint left outside the connection has no pass coming.
    this.#focusOrigin = null;
    // No month declared: the first connection opens the grid on the month of the
    // published selection, else on the current one, and a later one keeps the
    // month on screen. The Value stays as the page wrote it.
    if (!this.monthValue && !this.#opened) {
      this.#paintedMonth = toISOMonthString(parseISODateString(this.#selection) ?? new Date());
    }
    this.#opened = true;
    this.#initializeFocusedDate();
    this.#render();
    this.#connected = true;
  }

  /**
   * Drops a pending repaint and a pending focus move, and stops reporting, so
   * nothing reaches for a grid that is not connected.
   */
  override disconnect(): void {
    this.#connected = false;
    this.#repaint.cancel();
    this.#settleFocus.cancel();
  }

  /**
   * Paints the month `month` names, whether application code, a morph or the
   * grid's own navigation wrote it; focus in the grid follows to the tab stop.
   */
  monthValueChanged(): void {
    if (!this.monthValue) return;
    this.#syncFocusedDateWithMonth();
    this.#repaintKeepingFocus();
  }

  /**
   * Repaints the label when application code changes `locale` at runtime.
   *
   * Stimulus runs this for the initial Value too, before `connect()`. The paint
   * it triggers is idempotent — the month comes from `month` (or, while that is
   * still empty, from `focusedDate`) — and a grid that has not connected
   * reports nothing, so that paint never reports a month.
   */
  localeValueChanged(): void {
    this.#repaintKeepingFocus();
  }

  /**
   * Repaints `aria-selected` and the field when the requested day changes, and
   * moves the tab stop to the day the grid now publishes. A request `min` /
   * `max` withhold is not published, so the tab stop stays where it was.
   */
  selectedValueChanged(): void {
    const selection = parseISODateString(this.#selection);
    if (selection) this.focusedDate = selection;
    this.#repaintKeepingFocus();
  }

  /** Repaints when `min` changes after connect, so the disabled days and the selection follow. */
  minValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Repaints when `max` changes after connect, so the disabled days and the selection follow. */
  maxValueChanged(): void {
    this.#repaint.schedule();
  }

  /**
   * Lays the grid out again when `weekStart` changes after connect, so every
   * date moves to the column of its weekday.
   *
   * Only the day cells are painted: column headers are author markup, so the
   * author updates them together with the Value.
   */
  weekStartValueChanged(): void {
    this.#repaint.schedule();
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
      targetSelector(this.identifier, "day"),
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
      targetSelector(this.identifier, "day"),
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
   * First day of the month the grid paints: the `month` Value when it parses —
   * while it is empty, the month on screen — otherwise the focused date's month.
   *
   * A malformed `month` falls back instead of stopping the paint: every cell
   * keeps its `aria-selected` and the grid keeps its tab stop, so a Value typo
   * still leaves the grid reachable by Tab and the author can see what they
   * typed. Every consumer of "which month is on screen" reads it from here, so
   * the paint and the `monthchange` report cannot name different months.
   */
  #paintedMonthStart(): Date {
    const monthInfo = parseISOMonthString(this.#monthRequest);
    return monthInfo
      ? new Date(monthInfo.year, monthInfo.month - 1, 1)
      : new Date(this.focusedDate.getFullYear(), this.focusedDate.getMonth(), 1);
  }

  /**
   * The month the grid is asked to paint: `month`, or while that is empty the
   * month on screen, which `connect()` opens on the month of the published
   * selection, else on the current one.
   */
  get #monthRequest(): string {
    return this.monthValue || this.#paintedMonth;
  }

  /**
   * Renders the grid days and updates the month/year label, mirrors both
   * fields, then reports each field the user's move moved and — once connected
   * — a painted month that differs from the last one painted, and a published
   * selection that a change the page made moved.
   *
   * The report belongs to the paint, not to the `month` Value: the Value is only
   * one of the things that decide the month on screen. While a malformed `month`
   * falls back, changing `selected` and selecting a neighbouring month's cell
   * move the painted month too, and both repaint from here. Reading the report
   * off the paint keeps the event naming the month the grid shows, in the
   * `YYYY-MM` the detail contract promises, whichever route repainted.
   *
   * @stimeoRenderRoot
   */
  #render(): void {
    const monthStart = this.#paintedMonthStart();
    const year = monthStart.getFullYear();
    const month = monthStart.getMonth() + 1;
    const selection = this.#selection;

    // Update label with localized month/year
    if (this.hasLabelTarget) {
      const locale = resolveLocale(this.element, this.localeValue);
      this.labelTarget.textContent = monthLabelFormatter(locale).format(monthStart);
    }

    const days = this.#calculateGridDays(year, month);
    const dayElements = this.dayTargets;

    // A consumer's `aria-disabled` belongs to the date its cell shows, so every
    // one is read off before this paint moves any date to another cell. Values
    // this controller wrote carry its marker and are left out.
    const consumerDisabled = new Map<string, string>();
    for (const el of dayElements) {
      const shown = el.getAttribute("data-date");
      const value = el.getAttribute("aria-disabled");
      if (!shown || value === null || el.hasAttribute(this.#ownedDisabled)) continue;
      consumerDisabled.set(shown, value);
    }

    // Driven by the dates, so every iteration has one. A short `day` target set
    // is the consumer's markup contradicting the documented 42 cells: paint the
    // ones that exist rather than dropping the grid out of the tab order.
    for (const [index, date] of days.entries()) {
      const el = dayElements[index];
      if (!el) continue;

      const dateStr = toISODateString(date);
      // The 42 cells are recycled, so the `aria-disabled` a cell carries describes
      // the date it showed before this paint; left in place, it would disable an
      // unrelated day. A cell that now shows another date drops it, then takes the
      // consumer's value for its new date before the bounds below decide. A date
      // that left the grid has no cell to take its value, so the value is gone.
      if (el.getAttribute("data-date") !== dateStr) {
        el.removeAttribute("aria-disabled");
        el.removeAttribute(this.#ownedDisabled);
        const kept = consumerDisabled.get(dateStr);
        if (kept !== undefined) el.setAttribute("aria-disabled", kept);
      }
      el.setAttribute("data-date", dateStr);
      el.textContent = String(date.getDate());

      // outside current month
      const isOutside = date.getFullYear() !== year || date.getMonth() !== month - 1;
      el.setAttribute("data-outside", String(isOutside));

      // today
      const todayStr = toISODateString(new Date());
      el.setAttribute("data-today", String(dateStr === todayStr));

      // selection state: the day the grid publishes, which a bound can withhold
      el.setAttribute("aria-selected", String(dateStr === selection));

      // roving tabindex
      const isFocused = toISODateString(this.focusedDate) === dateStr;
      el.setAttribute("tabindex", isFocused ? "0" : "-1");

      // min/max limits. Only the value this controller wrote comes back off: a
      // consumer marks holidays and booked days with the same attribute, and
      // clearing it on every paint would silently throw their intent away.
      const isDisabled = this.#isDateOutOfBounds(dateStr);
      if (isDisabled) {
        if (!el.hasAttribute("aria-disabled")) el.setAttribute(this.#ownedDisabled, "");
        el.setAttribute("aria-disabled", "true");
      } else if (el.hasAttribute(this.#ownedDisabled)) {
        el.removeAttribute("aria-disabled");
        el.removeAttribute(this.#ownedDisabled);
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
    // cells of the month it is being told about. State is settled — the month,
    // the published selection and both fields — before any report goes out. A
    // listener of one may replace the selection before the next goes out; the
    // newer selection then reports itself, so a field only reports while it
    // holds the value this paint wrote to it.
    const painted = toISOMonthString(monthStart);
    const previous = this.#paintedMonth;
    this.#paintedMonth = painted;
    const reconciled = this.#settleSelection(selection);
    const move = this.#selectionMoves;
    for (const [field, value] of this.#mirrorFields(painted, selection, reconciled)) {
      if (field.value === value) commitField(field);
    }
    // A listener that picked a day in another month has painted and reported
    // that month already.
    if (this.#connected && previous !== painted && this.#paintedMonth === painted) {
      this.dispatch("monthchange", { detail: { month: painted } });
    }
    // A listener of an earlier report that moved the selection on — a
    // `monthchange` listener that picked a day, say — has had that selection
    // reported, so a report of the move this paint found would be stale.
    if (reconciled && move === this.#selectionMoves) {
      this.dispatch("reconcile", { detail: { date: selection } });
    }
  }

  /**
   * Records the selection a paint publishes and says whether it moved from the
   * one published before, which a connected grid reports as `reconcile`. A pick
   * records its own day before its paint, so that paint finds no move, and
   * nothing counts before the grid connects. A move counts as a move of the
   * selection.
   */
  #settleSelection(selection: string): boolean {
    const published = this.#published;
    this.#published = selection;
    if (!this.#connected || selection === published) return false;
    this.#selectionMoves += 1;
    return true;
  }

  /**
   * Repaints the grid for a Value callback or a pick. The first repaint of a
   * batch records where DOM focus stood on a day, for the settle pass; focus
   * outside the grid is left alone.
   */
  #repaintKeepingFocus(): void {
    if (!this.#focusOrigin) {
      const cell = this.dayTargets.find((day) => day === document.activeElement);
      if (cell) {
        this.#focusOrigin = {
          cell,
          date: cell.getAttribute("data-date"),
          month: this.#paintedMonth,
        };
        this.#settleFocus.schedule();
      }
    }
    this.#render();
  }

  /**
   * Puts DOM focus back on a day it can stay on once a batch of repaints has
   * landed.
   *
   * While the painted month stays, a bound only toggles `aria-disabled` and a
   * disabled day stays focusable, so nothing is called (`focus()` would scroll
   * the day into view); `weekStart` moves every date to another cell, so focus
   * follows its date, or goes to the tab stop once the date has left the grid.
   * When the painted month moves, every cell shows another day, and focus goes
   * to the tab stop of the new month. Focus a listener of the paint's events
   * moved off the recorded cell stays where it went.
   */
  #restoreFocus(): void {
    const origin = this.#focusOrigin;
    this.#focusOrigin = null;
    if (!origin || document.activeElement !== origin.cell) return;
    const moved = this.#paintedMonth !== origin.month;
    if (!moved && origin.cell.getAttribute("data-date") === origin.date) return;
    const destination =
      (moved
        ? undefined
        : this.dayTargets.find((cell) => cell.getAttribute("data-date") === origin.date)) ??
      this.dayTargets.find((cell) => cell.getAttribute("tabindex") === "0");
    destination?.focus();
  }

  /** Fills a selected-day field inserted or replaced at runtime with the published selection. */
  fieldTargetConnected(field: HTMLInputElement): void {
    writeField(field, this.#selection);
  }

  /** Fills a painted-month field inserted or replaced at runtime. */
  monthFieldTargetConnected(field: HTMLInputElement): void {
    writeField(field, toISOMonthString(this.#paintedMonthStart()));
  }

  /**
   * Mirrors the painted month and the published selection into their optional
   * fields.
   *
   * @param reconciled - Whether a change the page made moved the selection in
   *   this paint, which `reconcile` reports rather than the field.
   * @returns Each field this grid's own controls moved, with the value written
   *   to it, for the paint to report.
   */
  #mirrorFields(
    painted: string,
    selection: string,
    reconciled: boolean,
  ): [HTMLInputElement, string][] {
    const byUser = this.#movedByUser;
    this.#movedByUser = false;
    const moved: [HTMLInputElement, string][] = [];
    if (this.hasFieldTarget && writeField(this.fieldTarget, selection) && !reconciled) {
      moved.push([this.fieldTarget, selection]);
    }
    if (this.hasMonthFieldTarget && writeField(this.monthFieldTarget, painted)) {
      moved.push([this.monthFieldTarget, painted]);
    }
    return byUser ? moved : [];
  }

  selectDayElement(dayElement: HTMLElement): void {
    if (dayElement.getAttribute("aria-disabled") === "true") return;

    // A day the bounds exclude is refused even before a paint marks its cell,
    // so the pick and the paint that follows give the same answer.
    const dateStr = dayElement.getAttribute("data-date");
    if (!dateStr || this.#isDateOutOfBounds(dateStr)) return;

    this.selectedValue = dateStr;
    // Reflect the selection synchronously (move roving focus to the selected day and
    // repaint aria-selected) instead of waiting on the async value observer, so a
    // click or Enter updates the grid in the same tick — consistent with how the
    // navigation handler re-renders directly. `selectedValueChanged` covers
    // external (consumer-driven) value changes.
    const selected = parseISODateString(dateStr);
    if (selected) this.focusedDate = selected;
    this.#movedByUser = true;
    this.#selectionMoves += 1;
    const move = this.#selectionMoves;
    // The pick is the user's move: recorded as published before the paint, so
    // the paint reports it through the field and `select`, never as `reconcile`.
    this.#published = dateStr;
    this.#repaintKeepingFocus();
    // A listener of the paint's reports that picked another day, or made a
    // paint that withheld this one, has had the newer selection reported.
    if (move !== this.#selectionMoves) return;
    this.dispatch("select", { detail: { date: dateStr } });
  }

  #focusAndNavigateToDate(date: Date): void {
    this.focusedDate = date;
    const targetMonthStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

    this.#movedByUser = true;
    if (targetMonthStr !== this.#monthRequest) {
      // Another month: writing the Value runs `monthValueChanged`, which paints
      // that month once and keeps `focusedDate`, since it lies in that month.
      // The date is therefore the tab stop of the new month, and focus, still
      // on the cell the key was pressed on, goes there once that paint has
      // landed. Painting here as well would paint the month twice.
      this.monthValue = targetMonthStr;
      return;
    }

    this.#render();
    const dateStr = toISODateString(date);
    this.dayTargets.find((el) => el.getAttribute("data-date") === dateStr)?.focus();
  }

  #isDateOutOfBounds(dateStr: string): boolean {
    if (this.minValue && dateStr < this.minValue) return true;
    if (this.maxValue && dateStr > this.maxValue) return true;
    return false;
  }

  /** The day `selected` requests: the Value when it names a real day, else `""`. */
  get #requestedDay(): string {
    return parseISODateString(this.selectedValue) ? this.selectedValue : "";
  }

  /** The selection published for `requested`: the day while `min` / `max` allow it, else `""`. */
  #publishable(requested: string): string {
    return requested && !this.#isDateOutOfBounds(requested) ? requested : "";
  }

  /** The selection the grid publishes now. */
  get #selection(): string {
    return this.#publishable(this.#requestedDay);
  }

  #shiftMonth(delta: number): void {
    const monthInfo = parseISOMonthString(this.#monthRequest);
    if (!monthInfo) return;

    this.#movedByUser = true;
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

  /**
   * Opens the tab stop on the published selection, else on today when the shown
   * month holds it, else on the 1st of the shown month. A selection the grid
   * does not show falls back to the 1st in the paint.
   */
  #initializeFocusedDate(): void {
    const selection = parseISODateString(this.#selection);
    if (selection) {
      this.focusedDate = selection;
      return;
    }

    const monthInfo = parseISOMonthString(this.#monthRequest);
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
