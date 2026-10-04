import { Controller } from "@hotwired/stimulus";
import { intlFormatter } from "../utils/intl_format";
import { resolveLocale } from "../utils/locale";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { SafeTimeout } from "../utils/safe_timeout";

/** A time scale: the upper bound (seconds) it covers and its `Intl` unit/divisor. */
interface TimeScale {
  limit: number;
  unit: Intl.RelativeTimeFormatUnit;
  ms: number;
}

/** Coarsest scale, used as the fallback for anything a year or older. */
const YEAR_SCALE: TimeScale = { limit: Number.POSITIVE_INFINITY, unit: "year", ms: 31_557_600_000 };

/** Boundaries (in seconds) and the `Intl` unit/divisor used at each scale. */
const UNITS: readonly TimeScale[] = [
  { limit: 60, unit: "second", ms: 1000 },
  { limit: 3600, unit: "minute", ms: 60_000 },
  { limit: 86_400, unit: "hour", ms: 3_600_000 },
  { limit: 604_800, unit: "day", ms: 86_400_000 },
  { limit: 2_629_800, unit: "week", ms: 604_800_000 },
  { limit: 31_557_600, unit: "month", ms: 2_629_800_000 },
  YEAR_SCALE,
];

/** The relative phrasing every pass asks for ("yesterday", not "1 day ago"). */
const RELATIVE_OPTIONS: Intl.RelativeTimeFormatOptions = { numeric: "auto" };

/** Suffix of the record of the authored text; see the class remarks. */
const TEXT_RECORD = "text";

/**
 * Headless relative-time behavior: renders an absolute timestamp as "3 minutes
 * ago" / "in 2 days" and keeps it fresh. No dedicated APG pattern; it follows
 * the HTML `<time>` semantics.
 *
 * Markup contract (identifier: `stimeo--relative-time`):
 *   <time data-controller="stimeo--relative-time"
 *         datetime="2026-05-30T12:00:00+09:00" title="2026-05-30 12:00"
 *         data-stimeo--relative-time-locale-value="ja">2026-05-30 12:00</time>
 *
 * Computes the difference from `datetime` to now and formats it with
 * `Intl.RelativeTimeFormat` (a browser standard — no added dependency). The
 * polling interval widens as the timestamp ages (seconds → minutes → hours →
 * days). Past a `threshold`, it falls back to the authored absolute text.
 *
 * @remarks
 * Behavior only. The machine-readable `datetime` attribute is left untouched
 * while only the visible text updates, and the element is intentionally **not**
 * a live region (silent updates, no announcement interruptions). The polling
 * timer is owned by `SafeTimeout` and torn down on `disconnect()` (Turbo
 * navigation included).
 *
 * Render inputs are followed at runtime: a morph that swaps `locale`, `threshold`,
 * or `tickInterval` on the live element repaints through one coalesced pass
 * (`MorphRenderWatcher`) rather than leaving the reading frozen. While the element
 * shows the relative form it records the authored absolute text on itself as
 * `data-<identifier>-text` (a JSON string), so a copy of it — a page Turbo restores from
 * its cache — keeps the threshold fallback: the connection that adopts the copy takes
 * the authored text from the record, never the relative form on display. Nothing is
 * written back on `turbo:before-cache`, which Turbo also dispatches on pages that stay,
 * where the reading must stay current.
 */
export class RelativeTimeController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override values = {
    locale: { type: String, default: "" },
    threshold: { type: Number, default: 0 },
    tickInterval: { type: Number, default: 60_000 },
  };

  static valueConstraints = {
    threshold: NUMBER_BOUNDS.nonNegative,
    tickInterval: NUMBER_BOUNDS.timer,
  } satisfies NumberValueConstraints<typeof RelativeTimeController.values>;
  declare localeValue: string;
  declare thresholdValue: number;
  declare tickIntervalValue: number;

  readonly #timers = new SafeTimeout();
  /** Collapses a morph that swaps several render inputs at once into one repaint. */
  readonly #resync = new MorphRenderWatcher(() => {
    if (this.#valuesDirty) {
      this.#valuesDirty = false;
      this.#resyncToValues();
    } else if (!Number.isNaN(this.#targetMs)) {
      this.#applyAndComputeDelay();
    }
  });
  #valuesDirty = false;

  /** Epoch ms parsed from `datetime`; `NaN` when absent or invalid. */
  #targetMs = Number.NaN;
  /** The authored absolute text, restored when the threshold fallback kicks in. */
  #absoluteText = "";

  override connect(): void {
    this.#valuesDirty = false;
    this.#resync.observe(this.element);
    // Don't adopt already-rendered relative text as the absolute fallback: on a
    // re-connect against a tree that still holds the live "3 minutes ago" text, that
    // relative string would otherwise become `#absoluteText`. The authored text is the
    // record such a tree carries, or the textContent before any relative render.
    if (this.element.getAttribute("data-state") !== "relative") {
      this.#absoluteText = (this.element.textContent ?? "").trim();
    } else {
      const recorded = this.#recordedText();
      if (recorded !== null) this.#absoluteText = recorded;
    }
    this.#targetMs = Date.parse(this.element.getAttribute("datetime") ?? "");
    if (Number.isNaN(this.#targetMs)) return;
    this.#schedule();
  }

  override disconnect(): void {
    this.#resync.disconnect();
    this.#timers.clearAll();
  }

  /** The record of the authored text, in this controller's namespace. */
  get #textRecord(): string {
    return `data-${this.identifier}-${TEXT_RECORD}`;
  }

  /** The authored text the element records, or `null` when it records none it could. */
  #recordedText(): string | null {
    try {
      const parsed: unknown = JSON.parse(this.element.getAttribute(this.#textRecord) ?? "null");
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Repaints when application code (or a Turbo morph) changes `locale` at runtime. */
  localeValueChanged(): void {
    this.#valuesDirty = true;
    this.#resync.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `threshold` at runtime. */
  thresholdValueChanged(): void {
    this.#valuesDirty = true;
    this.#resync.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `tickInterval` at runtime. */
  tickIntervalValueChanged(): void {
    this.#valuesDirty = true;
    this.#resync.schedule();
  }

  /**
   * Renders against the current Values and re-arms the poll from now.
   *
   * Render only: it emits no event, and clearing first keeps the single self-arming
   * timer single — scheduling on top of a pending one would double the poll rate for
   * the rest of the session. A stamp whose `datetime` never parsed has nothing to
   * render, and one that already reached its terminal fallback simply renders it
   * again and stops.
   */
  #resyncToValues(): void {
    if (Number.isNaN(this.#targetMs)) return;
    this.#timers.clearAll();
    this.#schedule();
  }

  /** Renders the current representation and reschedules unless polling can stop. */
  #schedule(): void {
    const nextDelay = this.#applyAndComputeDelay();
    if (nextDelay !== null) {
      this.#timers.set(() => this.#schedule(), nextDelay);
    }
  }

  /**
   * Updates the visible text and returns the next poll delay (ms), or `null` when
   * polling can stop: a *past* timestamp that fell back to the absolute text can
   * never leave it again, and a locale the runtime rejects has nothing to render
   * until that value is corrected. A fallback-boundary hop waits at least 1ms:
   * subtracting a fractional threshold can round the computed delay down to zero.
   *
   * @stimeoRenderRoot
   */
  #applyAndComputeDelay(): number | null {
    const deltaMs = this.#targetMs - Date.now();
    const absSeconds = Math.abs(deltaMs) / 1000;

    const scale = UNITS.find((u) => absSeconds < u.limit) ?? YEAR_SCALE;
    // Poll no finer than the configured minimum; widen for coarser units so an
    // hours-old stamp is not re-rendered every minute.
    const unitFloor = scale.unit === "second" || scale.unit === "minute" ? 60_000 : scale.ms;
    const nextDelay = Math.max(this.#safeTickInterval, Math.min(unitFloor, 86_400_000));

    // Only switch to the absolute fallback when we actually hold authored absolute
    // text; otherwise (e.g. it could not be recovered after a morph) keep rendering
    // the relative form rather than blanking the element.
    if (this.#safeThreshold > 0 && absSeconds >= this.#safeThreshold && this.#absoluteText) {
      this.element.textContent = this.#absoluteText;
      this.element.setAttribute("data-state", "absolute");
      this.element.removeAttribute(this.#textRecord);
      // A past stamp only ages further, so its fallback is final and polling stops. A
      // future one moves back under the threshold, so keep polling and land 1ms past
      // the crossing: the poll cadence is far coarser than the instant the fallback
      // stops being the correct representation, and the floor does not apply to a hop
      // that exists to leave the fallback rather than to refresh a reading.
      if (deltaMs <= 0) return null;
      return Math.max(1, Math.min(nextDelay, deltaMs - this.#safeThreshold * 1000 + 1));
    }

    const formatter = this.#formatter;
    // Nothing to render in a locale the runtime rejects: leaving the element as
    // authored beats blanking it or guessing at another language.
    if (formatter === null) return null;
    const value = Math.round(deltaMs / scale.ms);
    this.element.textContent = formatter.format(value, scale.unit);
    this.element.setAttribute("data-state", "relative");
    const record = JSON.stringify(this.#absoluteText);
    if (this.element.getAttribute(this.#textRecord) !== record) {
      this.element.setAttribute(this.#textRecord, record);
    }
    return nextDelay;
  }

  /**
   * A `RelativeTimeFormat` for the resolved locale (`numeric: "auto"`), or `null`
   * when the runtime rejects that locale.
   */
  get #formatter(): Intl.RelativeTimeFormat | null {
    // A malformed locale must not break the page: the authored absolute text stays
    // as the graceful fallback, and a corrected value renders on the next pass.
    return intlFormatter(
      Intl.RelativeTimeFormat,
      resolveLocale(this.element, this.localeValue),
      RELATIVE_OPTIONS,
    );
  }
  /** Current `threshold` declaration resolved against its numeric contract. */
  get #safeThreshold(): number {
    return this.#numbers.read(
      this,
      "threshold",
      this.thresholdValue,
      RelativeTimeController.values.threshold.default,
      RelativeTimeController.valueConstraints.threshold,
    );
  }

  /** Current `tickInterval` declaration resolved against its numeric contract. */
  get #safeTickInterval(): number {
    return this.#numbers.read(
      this,
      "tickInterval",
      this.tickIntervalValue,
      RelativeTimeController.values.tickInterval.default,
      RelativeTimeController.valueConstraints.tickInterval,
    );
  }
}
