import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord, logicalArrowKey } from "../utils/arrow_step";
import { BeforeCacheReset } from "../utils/before_cache_reset";
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
import { SafeTimeout } from "../utils/safe_timeout";
import { parseStringList } from "../utils/string_list";
import { targetSelector } from "../utils/target_selector";

/** Number of cells in a six-week month grid (7 × 6). */
const GRID_SIZE = 42;

/**
 * Headless, accessible **date range picker** behavior. A derivative of
 * {@link CalendarController}: it reuses the month-grid navigation model and adds
 * two-point range selection, in-progress range preview, and presets.
 *
 * Markup contract (identifier: `stimeo--date-range-picker`):
 *   <div data-controller="stimeo--date-range-picker"
 *        data-stimeo--date-range-picker-min-value="2026-01-01"
 *        data-stimeo--date-range-picker-max-value="2026-12-31"
 *        data-stimeo--date-range-picker-disabled-dates-value='["2026-06-15"]'>
 *     <button data-action="click->stimeo--date-range-picker#prev">Prev</button>
 *     <span data-stimeo--date-range-picker-target="monthLabel" aria-live="polite"></span>
 *     <button data-action="click->stimeo--date-range-picker#next">Next</button>
 *     <div role="grid" data-stimeo--date-range-picker-target="grid">
 *       <!-- exactly 42 cell targets (7 days × 6 rows) -->
 *       <button role="gridcell" tabindex="-1"
 *               data-stimeo--date-range-picker-target="cell"
 *               data-action="click->stimeo--date-range-picker#selectDate
 *                            mouseenter->stimeo--date-range-picker#previewTo
 *                            focus->stimeo--date-range-picker#previewTo
 *                            keydown->stimeo--date-range-picker#onKeydown"></button>
 *     </div>
 *     <button data-range="last7" data-action="click->stimeo--date-range-picker#applyPreset">…</button>
 *     <span role="status" aria-live="polite" data-stimeo--date-range-picker-target="status"></span>
 *     <input type="hidden" data-stimeo--date-range-picker-target="startField" />
 *     <input type="hidden" data-stimeo--date-range-picker-target="endField" />
 *   </div>
 *
 * @remarks
 * Behavior only — the consumer styles the grid and renders the range using the
 * `data-range-start` / `data-in-range` / `data-range-end` hooks. Assistive tech
 * is told the two confirmed endpoints via `aria-selected`; inner cells use
 * `data-in-range` (visual only) so the announcement stays to the two ends. The
 * range the user confirms is also announced in the live `status` region.
 *
 * Selection model: the first click/Enter sets a *pending* start and enters
 * "selecting" mode (preview follows the pointer/focus); the second confirms the
 * end (auto-swapped if earlier than the start), and a preset confirms its range
 * in one step. Escape abandons an in-progress selection, restoring the last
 * confirmed range.
 *
 * A confirmed range is painted — the cells, both hidden fields and the status —
 * before anything reports it. Each hidden field that moved then emits a native
 * bubbling `change`, the way a form control does, so `stimeo--auto-submit` and
 * form-level validation hear it; `monthchange` follows when the paint moved the
 * month, and last `change` dispatches `{ start: string, end: string }`, the ISO
 * range the picker holds. A bound a listener moves meanwhile is applied by the
 * repaint its Value callback runs, so the `reconcile` it causes follows the
 * `change`. A listener that replaces the range before these reports are all out
 * — by confirming another range, or with a repaint that narrows this one — has
 * the replacing range report itself: what is still pending for the replaced
 * range is not sent, and focus stays where the replacing move put it. The seed
 * `connect()` reads out of the hidden fields is written back silently.
 *
 * Availability is declarative on both axes: `min` / `max` bound the selectable
 * interval and `disabledDates` excludes individual dates inside it. Both are
 * render inputs, so a cell's `aria-disabled` is derived during the paint that
 * needs it rather than written back afterwards — selection, preview, and the
 * grid paint all read one predicate and cannot disagree. A painted-month
 * navigation dispatches `monthchange` with `{ month }` as a notification (for
 * fetching a month's availability, say); the fetched result comes back in
 * through `disabledDates`, which repaints on its own.
 *
 * The same predicate holds the confirmed range. When a change to `min`, `max`
 * or `disabledDates` leaves an end unselectable, the paint narrows the range:
 * each end moves inward to the nearest day that can still be chosen, and a
 * range with no such day left is cleared. The hidden fields follow without a
 * native `change`, the status keeps announcing what the user confirmed, and
 * `reconcile` dispatches `{ start: string, end: string }` — the narrowed range,
 * empty strings once cleared — rather than `change`, which stays the user's.
 * `connect()` narrows the range it reads from the fields the same way,
 * silently. An in-progress selection whose start becomes unselectable is
 * dropped, as Escape would drop it, and the next pick starts a new one.
 */
export class DateRangePickerController extends Controller<HTMLElement> {
  static override targets = ["grid", "monthLabel", "cell", "status", "startField", "endField"];
  static override values = {
    min: { type: String, default: "" },
    max: { type: String, default: "" },
    // A JSON list read through `parseStringList` rather than Stimulus's `Array`
    // type: that reader throws out of the value observer before any callback
    // runs, so one malformed attribute would stop the picker from connecting.
    disabledDates: { type: String, default: "" },
    locale: { type: String, default: "" },
  };
  static actions = ["applyPreset", "next", "onKeydown", "prev", "previewTo", "selectDate"] as const;
  static events = ["change", "monthchange", "reconcile"] as const;

  declare readonly gridTarget: HTMLElement;
  declare readonly hasGridTarget: boolean;
  declare readonly monthLabelTarget: HTMLElement;
  declare readonly cellTargets: HTMLElement[];
  declare readonly statusTarget: HTMLElement;
  declare readonly startFieldTarget: HTMLInputElement;
  declare readonly endFieldTarget: HTMLInputElement;
  declare readonly hasMonthLabelTarget: boolean;
  declare readonly hasStatusTarget: boolean;
  declare readonly hasStartFieldTarget: boolean;
  declare readonly hasEndFieldTarget: boolean;
  declare minValue: string;
  declare maxValue: string;
  declare disabledDatesValue: string;
  declare localeValue: string;

  /** The month currently rendered, as `YYYY-MM`. */
  #viewMonth = "";
  /** The confirmed range endpoints (ISO), or "" when unset. */
  #startDate = "";
  #endDate = "";
  /** The first endpoint of an in-progress selection (ISO), or "" when idle. */
  #pendingStart = "";
  /** The hovered/focused date previewed while selecting (ISO), or "". */
  #previewDate = "";
  /** The roving-focus date in the grid (local time). */
  #focusedDate = new Date();

  /** Deferred focus after an async month transition (cancelled on teardown). */
  readonly #focusTimer = new SafeTimeout();

  /**
   * How many times the confirmed range has moved — a commit or a narrowing — so
   * a report still pending for a range a listener has since replaced can tell.
   */
  #rangeMoves = 0;

  /** How many month transitions have started, so one a listener starts mid-paint keeps its focus. */
  #transitions = 0;

  /** The declared unavailable dates, indexed for the per-cell paint lookup. */
  #disabledDates = new Set<string>();

  /** Rewinds an unfinished selection before Turbo snapshots the page. */
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindForCache());

  /** Last painted month, or `null` until the initial paint has settled. */
  #announcedMonth: string | null = null;

  /**
   * Collapses a morph that swaps render inputs into one repaint, and refuses the
   * pass Stimulus delivers before `connect()`.
   */
  readonly #repaint = new MicrotaskCoalescer(() => {
    this.#render();
  });

  /**
   * Seeds the range from optional hidden fields — ordered, and narrowed to the
   * days that can be chosen — then paints the grid, which writes the range back
   * to the fields silently.
   */
  override connect(): void {
    this.#repaint.activate();
    this.#beforeCache.activate();
    const authoredStart = this.hasStartFieldTarget ? normalizeISO(this.startFieldTarget.value) : "";
    const authoredEnd = this.hasEndFieldTarget ? normalizeISO(this.endFieldTarget.value) : "";
    [this.#startDate, this.#endDate] = this.#selectableRange(
      ...orderRange(authoredStart, authoredEnd),
    );
    this.#pendingStart = "";
    this.#previewDate = "";
    this.#announcedMonth = null;

    const anchor =
      parseISODateString(this.#startDate) ?? this.#clampToBounds(new Date()) ?? new Date();
    this.#focusedDate = anchor;
    this.#viewMonth = toISOMonthString(anchor);
    // A confirmed range can carry `aria-selected="true"` on two cells, so the
    // grid has to say that more than one is selectable — otherwise a single-select
    // grid is claiming two selections.
    if (this.hasGridTarget) this.gridTarget.setAttribute("aria-multiselectable", "true");
    this.#render();
  }

  /** Cancels any pending deferred focus so it never fires on a detached element. */
  override disconnect(): void {
    this.#repaint.cancel();
    this.#beforeCache.deactivate();
    this.#focusTimer.clearAll();
  }

  /** Repaints the label when application code changes `locale` at runtime. */
  localeValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `min` at runtime. */
  minValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `max` at runtime. */
  maxValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Re-indexes the unavailable dates and repaints when the declared set changes. */
  disabledDatesValueChanged(): void {
    this.#disabledDates = new Set(parseStringList(this.disabledDatesValue));
    this.#repaint.schedule();
  }

  /** Navigates to the previous month. */
  prev(event?: Event): void {
    event?.preventDefault();
    this.#shiftMonth(-1);
  }

  /** Navigates to the next month. */
  next(event?: Event): void {
    event?.preventDefault();
    this.#shiftMonth(1);
  }

  /** Confirms a range endpoint from a clicked cell. */
  selectDate(event: Event): void {
    const cell = this.#cellFrom(event.target);
    if (!cell) return;
    const date = cell.getAttribute("data-date");
    if (!date || !this.#isSelectable(date)) return;
    this.#choose(date);
  }

  /** Previews the range up to a hovered/focused cell while selecting. */
  previewTo(event: Event): void {
    const cell = this.#cellFrom(event.target);
    if (!cell) return;
    const date = cell.getAttribute("data-date");
    if (!date) return;
    let shouldRender = false;
    // Focus moves the roving tabindex; hover does not.
    if (event.type.startsWith("focus")) {
      const parsed = parseISODateString(date);
      if (parsed) this.#focusedDate = parsed;
      shouldRender = cell.getAttribute("tabindex") !== "0";
    }
    // An unavailable day can hold focus (APG keeps disabled cells reachable) but
    // never becomes the previewed endpoint, so the preview stays where it was.
    if (this.#pendingStart && this.#isSelectable(date) && this.#previewDate !== date) {
      this.#previewDate = date;
      shouldRender = true;
    }
    if (shouldRender) this.#render();
  }

  /** Applies a named preset (`today` / `last7` / `last30` / `thisMonth`). */
  applyPreset(event: Event): void {
    const button = (event.target as HTMLElement | null)?.closest("[data-range]");
    const range = computePreset(button?.getAttribute("data-range") ?? "");
    if (!range) return;

    const intersection = this.#intersectRange(range);
    if (!intersection) return;
    const { start, end } = intersection;
    // A preset is the consumer's own button, but what it produces is still a
    // range, and an unavailable day cannot be one of its endpoints — the same
    // rule a click or Enter obeys. Refusing keeps one answer per date instead of
    // one per entry point, and stops a cell from being the confirmed edge while
    // still painted `aria-disabled="true"`.
    if (!this.#isSelectable(start) || !this.#isSelectable(end)) return;

    const move = this.#setConfirmed(start, end);
    const endDate = parseISODateString(end);
    if (endDate) this.#focusedDate = endDate;
    this.#transitionTo(toISOMonthString(parseISODateString(end) ?? new Date()), end, true);
    this.#reportConfirmed(move);
  }

  /** Grid keyboard navigation, selection (Enter/Space), and Escape-to-cancel. */
  onKeydown(event: KeyboardEvent): void {
    // A descendant widget that already claimed the key must not ALSO move the
    // grid focus or choose a date — composition depends on this yield.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    const cell = this.#cellFrom(event.target);
    if (!cell) return;
    const dateStr = cell.getAttribute("data-date") ?? "";
    const date = parseISODateString(dateStr);
    if (!date) return;

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (this.#isSelectable(dateStr)) this.#choose(dateStr);
      return;
    }
    if (event.key === "Escape") {
      // A press an inner handler already owned is yielded at the top of this
      // handler. What is checked here is the IME half: a press during a
      // composition steers the conversion, not the range.
      if (this.#pendingStart && !event.isComposing) {
        event.preventDefault();
        this.#pendingStart = "";
        this.#previewDate = "";
        this.#render();
      }
      return;
    }

    let next: Date | null = null;
    // Logical, not physical. The key is normalised rather than the
    // delta negated: these two branches are not mirror images — their guards
    // differ — so swapping the key keeps each guard with its own direction.
    switch (logicalArrowKey(event.key, this.element)) {
      case "ArrowLeft":
        next = addDays(date, -1);
        break;
      case "ArrowRight":
        next = addDays(date, 1);
        break;
      case "ArrowUp":
        next = addDays(date, -7);
        break;
      case "ArrowDown":
        next = addDays(date, 7);
        break;
      case "Home":
        next = addDays(date, -date.getDay());
        break;
      case "End":
        next = addDays(date, 6 - date.getDay());
        break;
      case "PageUp":
        next = event.shiftKey ? shiftYearClamped(date, -1) : shiftMonthClamped(date, -1);
        break;
      case "PageDown":
        next = event.shiftKey ? shiftYearClamped(date, 1) : shiftMonthClamped(date, 1);
        break;
      default:
        return;
    }
    event.preventDefault();
    this.#moveFocusTo(next);
  }

  /** Records a chosen date as either the pending start or the confirmed end. */
  #choose(date: string): void {
    // A pending start the availability has taken away cannot become an
    // endpoint — the next paint drops it — so this pick starts a new selection.
    if (!this.#pendingStart || !this.#isSelectable(this.#pendingStart)) {
      this.#pendingStart = date;
      this.#previewDate = date;
      const parsed = parseISODateString(date);
      if (parsed) this.#focusedDate = parsed;
      this.#render();
      return;
    }
    // Second click confirms; order the two so start ≤ end.
    const [start, end] =
      date < this.#pendingStart ? [date, this.#pendingStart] : [this.#pendingStart, date];
    const move = this.#setConfirmed(start, end);
    this.#render(true);
    this.#reportConfirmed(move);
  }

  /**
   * Makes `start`–`end` the confirmed range, ending any selection in progress,
   * ahead of the paint that shows it.
   *
   * @returns The move count the range is now at, which its `change` checks.
   */
  #setConfirmed(start: string, end: string): number {
    this.#startDate = start;
    this.#endDate = end;
    this.#pendingStart = "";
    this.#previewDate = "";
    this.#rangeMoves += 1;
    return this.#rangeMoves;
  }

  /**
   * Dispatches `change` for the range confirmed at `move`, once its paint has
   * reported it through the fields. A listener of those reports that moved the
   * range on has had the range it moved to reported instead.
   */
  #reportConfirmed(move: number): void {
    if (move !== this.#rangeMoves) return;
    this.dispatch("change", { detail: { start: this.#startDate, end: this.#endDate } });
  }

  /** Moves roving focus to `date`, transitioning the month when needed. */
  #moveFocusTo(date: Date): void {
    this.#focusedDate = date;
    const iso = toISODateString(date);
    // Availability is known from the Values, not from the cells, so a target in
    // a month that has not been painted yet resolves in this same pass.
    if (this.#pendingStart && this.#isSelectable(iso)) this.#previewDate = iso;
    this.#transitionTo(toISOMonthString(date), iso);
  }

  /**
   * Renders `month`, then focuses the cell for `dateStr` (deferred if async).
   * A listener of the paint's reports that started another move has placed
   * focus itself, so this one leaves it there.
   *
   * @param confirmed - Whether the paint shows a range the user has just confirmed.
   */
  #transitionTo(month: string, dateStr: string, confirmed = false): void {
    const isTransition = month !== this.#viewMonth;
    this.#focusTimer.clearAll();
    this.#viewMonth = month;
    this.#transitions += 1;
    const transition = this.#transitions;
    this.#render(confirmed);
    if (transition !== this.#transitions) return;
    const focusCell = (): void => {
      this.cellTargets.find((c) => c.getAttribute("data-date") === dateStr)?.focus();
    };
    if (isTransition) {
      // Let the synchronous render settle before focusing the freshly bound cell.
      this.#focusTimer.set(focusCell, 0);
    } else {
      focusCell();
    }
  }

  /** Shifts the displayed month by `delta`, keeping focus within it. */
  #shiftMonth(delta: number): void {
    const info = parseISOMonthString(this.#viewMonth);
    if (!info) return;
    const target = new Date(info.year, info.month - 1 + delta, 1);
    this.#viewMonth = toISOMonthString(target);
    // Keep the same day-of-month where possible, clamped to the new month.
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(this.#focusedDate.getDate(), lastDay));
    this.#focusedDate = target;
    this.#render();
  }

  /**
   * Builds the six-week grid and binds range/roving/disabled state per cell,
   * mirrors the confirmed range to the hidden fields, then reports what the
   * paint moved.
   *
   * @param confirmed - Whether the paint shows a range the user has just
   *   confirmed, which the status then announces and each moved field reports.
   *
   * @stimeoRenderRoot
   */
  #render(confirmed = false): void {
    const info = parseISOMonthString(this.#viewMonth);
    if (!info) return;
    const { year, month } = info;

    // Tightening `min` / `max` / `disabledDates` mid-selection can strand the
    // in-progress range on a day that is no longer choosable. A stranded start
    // cannot become an endpoint, so the selection in progress is dropped, as
    // Escape drops it; a stranded preview falls back to the pending start
    // rather than advertising a range the user cannot confirm.
    if (this.#pendingStart && !this.#isSelectable(this.#pendingStart)) {
      this.#pendingStart = "";
      this.#previewDate = "";
    }
    if (this.#previewDate && !this.#isSelectable(this.#previewDate)) this.#previewDate = "";
    const narrowed = this.#narrowConfirmedRange();

    if (this.hasMonthLabelTarget) {
      const formatter = monthLabelFormatter(resolveLocale(this.element, this.localeValue));
      this.monthLabelTarget.textContent = formatter.format(new Date(year, month - 1, 1));
    }

    const [rangeStart, rangeEnd] = this.#visualRange();
    const days = gridDays(year, month);
    const focusedStr = toISODateString(this.#focusedDate);
    const todayStr = toISODateString(new Date());

    const cells = this.cellTargets;
    for (let i = 0; i < GRID_SIZE; i++) {
      const el = cells[i];
      const date = days[i];
      if (!el || !date) continue;
      const iso = toISODateString(date);

      el.setAttribute("data-date", iso);
      el.textContent = String(date.getDate());
      el.setAttribute("data-outside", String(date.getMonth() !== month - 1));
      el.setAttribute("data-today", String(iso === todayStr));
      el.setAttribute("tabindex", iso === focusedStr ? "0" : "-1");

      if (this.#isSelectable(iso)) el.removeAttribute("aria-disabled");
      else el.setAttribute("aria-disabled", "true");

      const isStart = !!rangeStart && iso === rangeStart;
      const isEnd = !!rangeEnd && iso === rangeEnd && rangeEnd !== rangeStart;
      const inside = !!rangeStart && !!rangeEnd && iso > rangeStart && iso < rangeEnd;
      el.toggleAttribute("data-range-start", isStart);
      el.toggleAttribute("data-range-end", isEnd);
      el.toggleAttribute("data-in-range", inside);
      // Selection is what the user committed, never what the pointer is hovering:
      // `aria-selected` marks the two confirmed endpoints only. The preview lives
      // in the `data-*` trio above, which styling reads and AT does not.
      el.setAttribute(
        "aria-selected",
        String(
          (!!this.#startDate && iso === this.#startDate) ||
            (!!this.#endDate && iso === this.#endDate),
        ),
      );
    }

    // Every declared cell is part of the roving composite, even when authored
    // beyond the documented 42-cell grid. Extras must never become a second stop.
    for (const extra of cells.slice(GRID_SIZE)) extra.setAttribute("tabindex", "-1");

    // Malformed short markup still gets a usable entry point. Prefer a date in
    // the displayed month so arrow navigation begins from the visible context.
    if (!cells.some((cell) => cell.getAttribute("tabindex") === "0")) {
      const fallback =
        cells.find((cell) => cell.getAttribute("data-outside") === "false") ?? cells[0];
      fallback?.setAttribute("tabindex", "0");
    }

    // Every report goes out once the grid, both fields and the status show the
    // range, so a listener of any of them reads what it is told about. A
    // listener of one may replace the range before the next goes out; the
    // replacing range then reports itself, so a field only reports while it
    // holds the value this paint wrote to it.
    const move = this.#rangeMoves;
    const moved = this.#mirrorFields();
    if (confirmed) {
      this.#announce();
      for (const [field, value] of moved) {
        if (field.value === value) commitField(field);
      }
    }

    // A month event belongs to the completed paint so a listener that reads the
    // grid sees the new dates. It reports the paint; it is not a hook the paint
    // waits on, so nothing here depends on what a listener does with it. The
    // month is recorded as it is reported, so a paint a listener makes meanwhile
    // reports a move this one has not reported yet, and this one does not
    // report it again.
    const previous = this.#announcedMonth;
    this.#announcedMonth = this.#viewMonth;
    if (previous !== null && previous !== this.#viewMonth) {
      this.dispatch("monthchange", { detail: { month: this.#viewMonth } });
    }
    // A listener of an earlier report that moved the range on — a `monthchange`
    // listener that confirmed a range, say — has had that range reported, so a
    // report of this paint's narrowing would be stale.
    if (narrowed && move === this.#rangeMoves) {
      this.dispatch("reconcile", { detail: { start: this.#startDate, end: this.#endDate } });
    }
  }

  /**
   * Narrows the confirmed range to days that can still be chosen. The paint
   * mirrors it to the fields without reporting a commit.
   *
   * @returns Whether the range moved.
   */
  #narrowConfirmedRange(): boolean {
    const [start, end] = this.#selectableRange(this.#startDate, this.#endDate);
    if (start === this.#startDate && end === this.#endDate) return false;
    this.#startDate = start;
    this.#endDate = end;
    this.#rangeMoves += 1;
    return true;
  }

  /**
   * The range `start`–`end` with each end moved inward to the nearest day that
   * can be chosen, or two empty strings when none of its days can be. A lone
   * endpoint is the one-day range it names, and stays lone.
   */
  #selectableRange(start: string, end: string): [string, string] {
    let from = parseISODateString(start || end);
    let to = parseISODateString(end || start);
    if (!from || !to) return [start, end];
    // Each walk stops at the other end, so a range with nothing selectable
    // ends with the two crossed rather than running past it.
    while (from.getTime() <= to.getTime() && !this.#isSelectable(toISODateString(from))) {
      from = addDays(from, 1);
    }
    while (to.getTime() >= from.getTime() && !this.#isSelectable(toISODateString(to))) {
      to = addDays(to, -1);
    }
    if (from.getTime() > to.getTime()) return ["", ""];
    return [start ? toISODateString(from) : "", end ? toISODateString(to) : ""];
  }

  /** The ordered [start, end] pair to paint: the preview while selecting, else confirmed. */
  #visualRange(): [string, string] {
    if (this.#pendingStart) {
      const other = this.#previewDate || this.#pendingStart;
      return this.#pendingStart <= other
        ? [this.#pendingStart, other]
        : [other, this.#pendingStart];
    }
    return [this.#startDate, this.#endDate];
  }

  /**
   * Writes the confirmed range to the hidden fields.
   *
   * @returns Each field whose value moved, with the value written to it.
   */
  #mirrorFields(): [HTMLInputElement, string][] {
    const moved: [HTMLInputElement, string][] = [];
    if (this.hasStartFieldTarget && writeField(this.startFieldTarget, this.#startDate)) {
      moved.push([this.startFieldTarget, this.#startDate]);
    }
    if (this.hasEndFieldTarget && writeField(this.endFieldTarget, this.#endDate)) {
      moved.push([this.endFieldTarget, this.#endDate]);
    }
    return moved;
  }

  /** Announces the confirmed range in the live status region. */
  #announce(): void {
    if (this.hasStatusTarget && this.#startDate && this.#endDate) {
      this.statusTarget.textContent = `${this.#startDate} – ${this.#endDate}`;
    }
  }

  /**
   * True when `iso` may be chosen as a range endpoint.
   *
   * The single availability question in the controller: the grid paint, the
   * preview, and both commit paths ask it, so a cell's `aria-disabled` and what
   * a click on that cell does are the same decision rather than two that have to
   * be kept in step.
   */
  #isSelectable(iso: string): boolean {
    return !this.#outOfBounds(iso) && !this.#disabledDates.has(iso);
  }

  /** True when `iso` falls outside the `[min, max]` bounds. */
  #outOfBounds(iso: string): boolean {
    if (this.minValue && iso < this.minValue) return true;
    if (this.maxValue && iso > this.maxValue) return true;
    return false;
  }

  /** Clamps a generated ISO date string into `[min, max]`. */
  #clampISO(iso: string): string {
    if (this.minValue && iso < this.minValue) return this.minValue;
    if (this.maxValue && iso > this.maxValue) return this.maxValue;
    return iso;
  }

  /** Clamps a Date into `[min, max]`, returning null only when unparseable. */
  #clampToBounds(date: Date): Date | null {
    const clamped = this.#clampISO(toISODateString(date));
    return parseISODateString(clamped);
  }

  /**
   * Intersects a preset with `[min, max]`, rejecting a disjoint interval.
   *
   * Only the bounds narrow a preset here: `disabledDates` excludes single days,
   * not sub-intervals, so it cannot shrink one to a still-contiguous range. A
   * day it excludes is still refused as an endpoint — the caller checks that —
   * but a preset that merely spans one keeps its span.
   */
  #intersectRange(range: { start: string; end: string }): { start: string; end: string } | null {
    const start = this.minValue && range.start < this.minValue ? this.minValue : range.start;
    const end = this.maxValue && range.end > this.maxValue ? this.maxValue : range.end;
    return start <= end ? { start, end } : null;
  }

  /** Removes provisional range state before Turbo freezes a cached snapshot. */
  #rewindForCache(): void {
    this.#focusTimer.clearAll();
    if (!this.#pendingStart && !this.#previewDate) return;
    this.#pendingStart = "";
    this.#previewDate = "";
    this.#render();
  }

  /** Resolves the cell element from an event target, or null. */
  #cellFrom(target: EventTarget | null): HTMLElement | null {
    return (
      (target as HTMLElement | null)?.closest<HTMLElement>(
        targetSelector(this.identifier, "cell"),
      ) ?? null
    );
  }
}

/** Returns a new Date `n` days from `date`. */
function addDays(date: Date, n: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + n);
  return next;
}

/** Shifts `date` by `delta` months, clamping the day to the target month length. */
function shiftMonthClamped(date: Date, delta: number): Date {
  const target = new Date(date.getFullYear(), date.getMonth() + delta, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), lastDay));
  return target;
}

/** Shifts `date` by `delta` years, clamping leap days to the target month. */
function shiftYearClamped(date: Date, delta: number): Date {
  const target = new Date(date.getFullYear() + delta, date.getMonth(), 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), lastDay));
  return target;
}

/** Builds the 42 local-time dates of a Sunday-started six-week grid for a month. */
function gridDays(year: number, month: number): Date[] {
  const first = new Date(year, month - 1, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const days: Date[] = [];
  const current = new Date(start);
  for (let i = 0; i < GRID_SIZE; i++) {
    days.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }
  return days;
}

/** Validates and re-serializes an ISO date string, returning "" when invalid. */
function normalizeISO(value: string): string {
  const date = parseISODateString(value.trim());
  return date ? toISODateString(date) : "";
}

/** Orders a complete range while preserving either valid lone endpoint. */
function orderRange(start: string, end: string): [string, string] {
  return start && end && end < start ? [end, start] : [start, end];
}

/** Computes a preset range relative to today, or null for an unknown name. */
function computePreset(name: string): { start: string; end: string } | null {
  const today = new Date();
  const todayStr = toISODateString(today);
  switch (name) {
    case "today":
      return { start: todayStr, end: todayStr };
    case "last7":
      return { start: toISODateString(addDays(today, -6)), end: todayStr };
    case "last30":
      return { start: toISODateString(addDays(today, -29)), end: todayStr };
    case "thisMonth": {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { start: toISODateString(start), end: toISODateString(end) };
    }
    default:
      return null;
  }
}
