import { Controller } from "@hotwired/stimulus";
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
 * timer is owned by {@link SafeTimeout} and torn down on `disconnect()` (Turbo
 * navigation included).
 */
export class RelativeTimeController extends Controller<HTMLElement> {
  static override values = {
    locale: { type: String, default: "" },
    threshold: { type: Number, default: 0 },
    tickInterval: { type: Number, default: 60_000 },
  };

  declare localeValue: string;
  declare thresholdValue: number;
  declare tickIntervalValue: number;

  readonly #timers = new SafeTimeout();

  /** Epoch ms parsed from `datetime`; `NaN` when absent or invalid. */
  #targetMs = Number.NaN;
  /** The authored absolute text, restored when the threshold fallback kicks in. */
  #absoluteText = "";

  override connect(): void {
    // Don't adopt already-rendered relative text as the absolute fallback: after a
    // Turbo morph that preserved the live "3 minutes ago" text, a fresh re-connect
    // would otherwise capture that relative string as `#absoluteText`. Only read the
    // authored textContent before the element has been rendered to a relative form.
    if (this.element.getAttribute("data-state") !== "relative") {
      this.#absoluteText = (this.element.textContent ?? "").trim();
    }
    this.#targetMs = Date.parse(this.element.getAttribute("datetime") ?? "");
    if (Number.isNaN(this.#targetMs)) return;
    this.#schedule();
  }

  override disconnect(): void {
    this.#timers.clearAll();
  }

  /** Renders the current representation and reschedules unless it is now absolute. */
  #schedule(): void {
    const nextDelay = this.#applyAndComputeDelay();
    if (nextDelay !== null) {
      this.#timers.set(() => this.#schedule(), nextDelay);
    }
  }

  /**
   * Updates the visible text and returns the next poll delay (ms), or `null`
   * once the absolute fallback is shown (which never changes, so stop polling).
   */
  #applyAndComputeDelay(): number | null {
    const deltaMs = this.#targetMs - Date.now();
    const absSeconds = Math.abs(deltaMs) / 1000;

    // Only switch to the absolute fallback when we actually hold authored absolute
    // text; otherwise (e.g. it could not be recovered after a morph) keep rendering
    // the relative form rather than blanking the element.
    if (this.thresholdValue > 0 && absSeconds >= this.thresholdValue && this.#absoluteText) {
      this.element.textContent = this.#absoluteText;
      this.element.setAttribute("data-state", "absolute");
      return null;
    }

    const scale = UNITS.find((u) => absSeconds < u.limit) ?? YEAR_SCALE;
    const value = Math.round(deltaMs / scale.ms);
    this.element.textContent = this.#formatter.format(value, scale.unit);
    this.element.setAttribute("data-state", "relative");

    // Poll no finer than the configured minimum; widen for coarser units so an
    // hours-old stamp is not re-rendered every minute.
    const unitFloor = scale.unit === "second" || scale.unit === "minute" ? 60_000 : scale.ms;
    return Math.max(this.tickIntervalValue, Math.min(unitFloor, 86_400_000));
  }

  /** A `RelativeTimeFormat` for the resolved locale (`numeric: "auto"`). */
  get #formatter(): Intl.RelativeTimeFormat {
    return new Intl.RelativeTimeFormat(this.#locale, { numeric: "auto" });
  }

  /** Locale precedence: the value, then the element's `lang`, then the document's. */
  get #locale(): string | undefined {
    return this.localeValue || this.element.lang || document.documentElement.lang || undefined;
  }
}
