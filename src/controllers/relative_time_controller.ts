import { Controller } from "@hotwired/stimulus";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
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
 *
 * Render inputs are followed at runtime: a morph that swaps `locale`, `threshold`,
 * or `tickInterval` on the live element repaints through one coalesced pass
 * ({@link MicrotaskCoalescer}) rather than leaving the reading frozen. The authored
 * absolute text goes back on the element via {@link BeforeCacheReset} before Turbo
 * caches the page — a snapshot taken mid-render would carry the relative form
 * alone, and that is a form `connect()` must not adopt as the fallback.
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
  /** Collapses a morph that swaps several render inputs at once into one repaint. */
  readonly #resync = new MicrotaskCoalescer(() => this.#resyncToValues());
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindForCache());

  /** Epoch ms parsed from `datetime`; `NaN` when absent or invalid. */
  #targetMs = Number.NaN;
  /** The authored absolute text, restored when the threshold fallback kicks in. */
  #absoluteText = "";

  override connect(): void {
    this.#resync.activate();
    this.#beforeCache.activate();
    // Don't adopt already-rendered relative text as the absolute fallback: on a
    // re-connect against a tree that still holds the live "3 minutes ago" text, that
    // relative string would otherwise become `#absoluteText`. Only read the authored
    // textContent before the element has been rendered to a relative form.
    if (this.element.getAttribute("data-state") !== "relative") {
      this.#absoluteText = (this.element.textContent ?? "").trim();
    }
    this.#targetMs = Date.parse(this.element.getAttribute("datetime") ?? "");
    if (Number.isNaN(this.#targetMs)) return;
    this.#schedule();
  }

  override disconnect(): void {
    this.#resync.cancel();
    this.#beforeCache.deactivate();
    this.#timers.clearAll();
  }

  /** Repaints when application code (or a Turbo morph) changes `locale` at runtime. */
  localeValueChanged(): void {
    this.#resync.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `threshold` at runtime. */
  thresholdValueChanged(): void {
    this.#resync.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `tickInterval` at runtime. */
  tickIntervalValueChanged(): void {
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

  /**
   * Restores the authored absolute text and the pre-render state for the snapshot
   * Turbo is about to take, leaving the live page's poll timer alone.
   *
   * With no authored text held there is nothing to restore, and `data-state` has to
   * stay as it is: that marker is what tells the next `connect()` the visible text is
   * a rendered relative form rather than an absolute fallback to hold on to.
   */
  #rewindForCache(): void {
    if (!this.#absoluteText) return;
    this.element.textContent = this.#absoluteText;
    this.element.removeAttribute("data-state");
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
   * until that value is corrected.
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
    const nextDelay = Math.max(this.tickIntervalValue, Math.min(unitFloor, 86_400_000));

    // Only switch to the absolute fallback when we actually hold authored absolute
    // text; otherwise (e.g. it could not be recovered after a morph) keep rendering
    // the relative form rather than blanking the element.
    if (this.thresholdValue > 0 && absSeconds >= this.thresholdValue && this.#absoluteText) {
      this.element.textContent = this.#absoluteText;
      this.element.setAttribute("data-state", "absolute");
      // A past stamp only ages further, so its fallback is final and polling stops. A
      // future one moves back under the threshold, so keep polling and land 1ms past
      // the crossing: the poll cadence is far coarser than the instant the fallback
      // stops being the correct representation, and the floor does not apply to a hop
      // that exists to leave the fallback rather than to refresh a reading.
      if (deltaMs <= 0) return null;
      return Math.min(nextDelay, deltaMs - this.thresholdValue * 1000 + 1);
    }

    const formatter = this.#formatter;
    // Nothing to render in a locale the runtime rejects: leaving the element as
    // authored beats blanking it or guessing at another language.
    if (formatter === null) return null;
    const value = Math.round(deltaMs / scale.ms);
    this.element.textContent = formatter.format(value, scale.unit);
    this.element.setAttribute("data-state", "relative");
    return nextDelay;
  }

  /**
   * A `RelativeTimeFormat` for the resolved locale (`numeric: "auto"`), or `null`
   * when the runtime rejects that locale.
   */
  get #formatter(): Intl.RelativeTimeFormat | null {
    try {
      return new Intl.RelativeTimeFormat(this.#locale, { numeric: "auto" });
    } catch {
      // A malformed locale must not break the page: the authored absolute text stays
      // as the graceful fallback, and a corrected value renders on the next pass.
      return null;
    }
  }

  /** Locale precedence: the value, then the nearest `lang` up the ancestor chain. */
  get #locale(): string | undefined {
    return this.localeValue || this.element.closest("[lang]")?.getAttribute("lang") || undefined;
  }
}
