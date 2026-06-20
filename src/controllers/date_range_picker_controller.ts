import { Controller } from "@hotwired/stimulus";
import {
  parseISODateString,
  parseISOMonthString,
  toISODateString,
  toISOMonthString,
} from "../utils/dates";
import { SafeTimeout } from "../utils/safe_timeout";

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
 *        data-stimeo--date-range-picker-max-value="2026-12-31">
 *     <button data-action="stimeo--date-range-picker#prev">Prev</button>
 *     <span data-stimeo--date-range-picker-target="monthLabel" aria-live="polite"></span>
 *     <button data-action="stimeo--date-range-picker#next">Next</button>
 *     <div role="grid" data-stimeo--date-range-picker-target="grid">
 *       <!-- exactly 42 cell targets (7 days × 6 rows) -->
 *       <button role="gridcell" tabindex="-1"
 *               data-stimeo--date-range-picker-target="cell"
 *               data-action="click->stimeo--date-range-picker#selectDate
 *                            mouseenter->stimeo--date-range-picker#previewTo
 *                            focus->stimeo--date-range-picker#previewTo
 *                            keydown->stimeo--date-range-picker#onKeydown"></button>
 *     </div>
 *     <button data-range="last7" data-action="stimeo--date-range-picker#applyPreset">…</button>
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
 * confirmed range is also mirrored to the live `status` region.
 *
 * Selection model: the first click/Enter sets a *pending* start and enters
 * "selecting" mode (preview follows the pointer/focus); the second confirms the
 * end (auto-swapped if earlier than the start) and dispatches `change`. Escape
 * abandons an in-progress selection, restoring the last confirmed range.
 */
export class DateRangePickerController extends Controller<HTMLElement> {
  static override targets = ["grid", "monthLabel", "cell", "status", "startField", "endField"];
  static override values = {
    min: { type: String, default: "" },
    max: { type: String, default: "" },
  };
  static actions = ["applyPreset", "next", "onKeydown", "prev", "previewTo", "selectDate"] as const;
  static events = ["change"] as const;

  declare readonly gridTarget: HTMLElement;
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

  /** Seeds the range from any pre-filled hidden fields and renders the grid. */
  override connect(): void {
    this.#startDate = this.hasStartFieldTarget ? normalizeISO(this.startFieldTarget.value) : "";
    this.#endDate = this.hasEndFieldTarget ? normalizeISO(this.endFieldTarget.value) : "";

    const anchor =
      parseISODateString(this.#startDate) ?? this.#clampToBounds(new Date()) ?? new Date();
    this.#focusedDate = anchor;
    this.#viewMonth = toISOMonthString(anchor);
    this.#render();
  }

  /** Cancels any pending deferred focus so it never fires on a detached element. */
  override disconnect(): void {
    this.#focusTimer.clearAll();
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
    if (!date || cell.getAttribute("aria-disabled") === "true") return;
    this.#choose(date);
  }

  /** Previews the range up to a hovered/focused cell while selecting. */
  previewTo(event: Event): void {
    const cell = this.#cellFrom(event.target);
    if (!cell) return;
    const date = cell.getAttribute("data-date");
    if (!date) return;
    // Focus moves the roving tabindex; hover does not.
    if (event.type.startsWith("focus")) {
      const parsed = parseISODateString(date);
      if (parsed) this.#focusedDate = parsed;
      // Re-roll the roving tab stop only when focus landed on a cell that is not
      // already the tab stop — e.g. Tab/click/programmatic focus from outside the
      // grid's own keyboard navigation (which already rendered the new stop). This
      // guard avoids a redundant double-render on the controller's own arrow moves
      // (onKeydown → #render focuses the new stop, which then fires this focus).
      if (!this.#pendingStart && cell.getAttribute("tabindex") !== "0") {
        this.#render();
      }
    }
    if (this.#pendingStart) {
      this.#previewDate = date;
      this.#render();
    }
  }

  /** Applies a named preset (`today` / `last7` / `last30` / `thisMonth`). */
  applyPreset(event: Event): void {
    const button = (event.target as HTMLElement | null)?.closest("[data-range]");
    const name = button?.getAttribute("data-range");
    if (!name) return;
    const range = computePreset(name);
    if (!range) return;

    const start = this.#clampISO(range.start);
    const end = this.#clampISO(range.end);
    if (!start || !end) return;

    this.#startDate = start;
    this.#endDate = end;
    this.#pendingStart = "";
    this.#previewDate = "";
    const endDate = parseISODateString(end);
    if (endDate) this.#focusedDate = endDate;
    this.#commitFields();
    this.#transitionTo(toISOMonthString(parseISODateString(end) ?? new Date()), end);
    this.#announce();
    this.dispatch("change", { detail: { start, end } });
  }

  /** Grid keyboard navigation, selection (Enter/Space), and Escape-to-cancel. */
  onKeydown(event: KeyboardEvent): void {
    const cell = this.#cellFrom(event.target);
    if (!cell) return;
    const dateStr = cell.getAttribute("data-date");
    const date = dateStr ? parseISODateString(dateStr) : null;
    if (!date) return;

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (dateStr && cell.getAttribute("aria-disabled") !== "true") this.#choose(dateStr);
      return;
    }
    if (event.key === "Escape") {
      if (this.#pendingStart) {
        event.preventDefault();
        this.#pendingStart = "";
        this.#previewDate = "";
        this.#render();
      }
      return;
    }

    let next: Date | null = null;
    switch (event.key) {
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
        next = shiftMonthClamped(date, -1);
        break;
      case "PageDown":
        next = shiftMonthClamped(date, 1);
        break;
      default:
        return;
    }
    event.preventDefault();
    this.#moveFocusTo(next);
  }

  /** Records a chosen date as either the pending start or the confirmed end. */
  #choose(date: string): void {
    if (!this.#pendingStart) {
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
    this.#startDate = start;
    this.#endDate = end;
    this.#pendingStart = "";
    this.#previewDate = "";
    this.#commitFields();
    this.#render();
    this.#announce();
    this.dispatch("change", { detail: { start, end } });
  }

  /** Moves roving focus to `date`, transitioning the month when needed. */
  #moveFocusTo(date: Date): void {
    this.#focusedDate = date;
    if (this.#pendingStart) this.#previewDate = toISODateString(date);
    this.#transitionTo(toISOMonthString(date), toISODateString(date));
  }

  /** Renders `month`, then focuses the cell for `dateStr` (deferred if async). */
  #transitionTo(month: string, dateStr: string): void {
    const isTransition = month !== this.#viewMonth;
    this.#viewMonth = month;
    this.#render();
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

  /** Builds the six-week grid and binds range/roving/disabled state per cell. */
  #render(): void {
    const info = parseISOMonthString(this.#viewMonth);
    if (!info) return;
    const { year, month } = info;

    if (this.hasMonthLabelTarget) {
      const lang = document.documentElement.lang || "en";
      const formatter = new Intl.DateTimeFormat(lang, { month: "long", year: "numeric" });
      this.monthLabelTarget.textContent = formatter.format(new Date(year, month - 1, 1));
    }

    const [rangeStart, rangeEnd] = this.#visualRange();
    const days = gridDays(year, month);
    const focusedStr = toISODateString(this.#focusedDate);
    const todayStr = toISODateString(new Date());

    for (let i = 0; i < GRID_SIZE; i++) {
      const el = this.cellTargets[i];
      const date = days[i];
      if (!el || !date) continue;
      const iso = toISODateString(date);

      el.setAttribute("data-date", iso);
      el.textContent = String(date.getDate());
      el.setAttribute("data-outside", String(date.getMonth() !== month - 1));
      el.setAttribute("data-today", String(iso === todayStr));
      el.setAttribute("tabindex", iso === focusedStr ? "0" : "-1");

      if (this.#outOfBounds(iso)) el.setAttribute("aria-disabled", "true");
      else el.removeAttribute("aria-disabled");

      const isStart = !!rangeStart && iso === rangeStart;
      const isEnd = !!rangeEnd && iso === rangeEnd && rangeEnd !== rangeStart;
      const inside = !!rangeStart && !!rangeEnd && iso > rangeStart && iso < rangeEnd;
      el.toggleAttribute("data-range-start", isStart);
      el.toggleAttribute("data-range-end", isEnd);
      el.toggleAttribute("data-in-range", inside);
      // AT hears only the two confirmed/pending endpoints as "selected".
      el.setAttribute("aria-selected", String(isStart || isEnd));
    }
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

  /** Writes the confirmed range to the hidden fields. */
  #commitFields(): void {
    if (this.hasStartFieldTarget) this.startFieldTarget.value = this.#startDate;
    if (this.hasEndFieldTarget) this.endFieldTarget.value = this.#endDate;
  }

  /** Announces the confirmed range in the live status region. */
  #announce(): void {
    if (this.hasStatusTarget && this.#startDate && this.#endDate) {
      this.statusTarget.textContent = `${this.#startDate} – ${this.#endDate}`;
    }
  }

  /** True when `iso` falls outside the `[min, max]` bounds. */
  #outOfBounds(iso: string): boolean {
    if (this.minValue && iso < this.minValue) return true;
    if (this.maxValue && iso > this.maxValue) return true;
    return false;
  }

  /** Clamps an ISO date string into `[min, max]`, or "" when unparseable. */
  #clampISO(iso: string): string {
    if (!iso) return "";
    if (this.minValue && iso < this.minValue) return this.minValue;
    if (this.maxValue && iso > this.maxValue) return this.maxValue;
    return iso;
  }

  /** Clamps a Date into `[min, max]`, returning null only when unparseable. */
  #clampToBounds(date: Date): Date | null {
    const clamped = this.#clampISO(toISODateString(date));
    return parseISODateString(clamped);
  }

  /** Resolves the cell element from an event target, or null. */
  #cellFrom(target: EventTarget | null): HTMLElement | null {
    return (
      (target as HTMLElement | null)?.closest<HTMLElement>(
        "[data-stimeo--date-range-picker-target='cell']",
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
