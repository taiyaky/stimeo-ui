import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { toFiniteNumber } from "../utils/coerce";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { SafeTimeout } from "../utils/safe_timeout";
import { parseStringList } from "../utils/string_list";

/**
 * Event shape {@link PasswordStrengthController.setScore} accepts: an action param
 * `score` or a `detail.score`. Both are typed `number | string` because, while
 * Stimulus coerces numeric action params to numbers, a `CustomEvent` (or a
 * non-numeric-looking param) may carry a string.
 */
type SetScoreEvent = Event & {
  params?: { score?: number | string };
  detail?: { score?: number | string };
};

/** One scoring pass: the level it lands on plus everything drawn from it. */
interface StrengthReading {
  readonly score: number;
  readonly level: string;
  readonly max: number;
  readonly meetsMin: boolean;
  readonly band: string;
}

/** The public derived state `change` and `reconcile` both carry. */
type PasswordStrengthDetail = Pick<StrengthReading, "score" | "level" | "max" | "meetsMin">;

/** Character classes that contribute to password variety (one point each beyond the first). */
const CLASS_PATTERNS: readonly RegExp[] = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/];

/** Strength labels used unless the consumer declares its own scale. */
const DEFAULT_LEVELS = ["weak", "fair", "good", "strong"];

/** Length milestones that each add a strength point. */
const LENGTH_MILESTONES: readonly number[] = [8, 12, 16];

/** Upper bound of the raw heuristic points, used to bucket into the level scale. */
const MAX_POINTS = LENGTH_MILESTONES.length + (CLASS_PATTERNS.length - 1);

/**
 * Fixed, locale-independent styling bands `data-strength` is drawn from. Kept
 * separate from the (localizable) `levels` labels so `data-strength` stays a
 * stable CSS hook (e.g. `[data-strength="weak"]`) even when `levels` is
 * translated. Ascending: weakest → strongest.
 */
const STRENGTH_BANDS = ["weak", "fair", "good", "strong"] as const;

/**
 * Fewest labels an ordered scale can carry. One label orders nothing and none
 * leaves the meter a zero-width range, so a shorter declaration resolves to
 * {@link DEFAULT_LEVELS} — which also makes `max >= 2` an invariant every
 * consumer of the scale can rely on.
 */
const MIN_LEVELS = 2;

/**
 * Headless password-strength behavior: scores the field with a lightweight
 * zero-dependency heuristic and drives a meter plus a visible level readout. No
 * dedicated APG pattern; the meter display follows {@link MeterController}.
 *
 * Markup contract (identifier: `stimeo--password-strength`):
 *   <div data-controller="stimeo--password-strength"
 *        data-stimeo--password-strength-announce-text-value="Password strength: {level}">
 *     <input type="password" data-stimeo--password-strength-target="input"
 *            data-action="input->stimeo--password-strength#evaluate" aria-describedby="pw">
 *     <div data-stimeo--password-strength-target="meter" role="meter"
 *          aria-label="Password strength" aria-valuemin="0" aria-valuemax="4"></div>
 *     <span id="pw" data-stimeo--password-strength-target="label"></span>
 *   </div>
 *
 * On each input the controller scores the password (length milestones + character
 * variety, capped for trivial repetition), syncs the meter's `aria-valuenow`,
 * reflects a stable band on `data-strength`, the `0–1` fill on
 * `--stimeo--password-strength`, and (when `minScore` is set) `data-below-min`,
 * and writes the level label into the label target.
 *
 * `change` and `reconcile` dispatch `{ score, level, max, meetsMin }`.
 *
 * @remarks
 * Behavior only — the meter/bar look is the consumer's, keyed off the data hooks.
 * `data-strength` is one of the fixed {@link STRENGTH_BANDS} (not the localizable
 * `levels` text), so consumers can style by it regardless of locale; the visible
 * label receives the matching `levels` entry. Every visible and non-text output
 * updates on the keystroke that caused it, so the readout never trails the meter.
 *
 * Assistive notification is opt-in and i18n-neutral: `announceText` accepts
 * `{level}`, `{score}`, `{max}` and `{band}`, and one settled message is handed to
 * the page's shared `stimeo--announcer` after a short debounce. Only a level the
 * reader has not already heard is sent, so typing inside one level stays quiet.
 * The label target is plain visible output and is not itself a live region.
 *
 * The score is a pure function of the field value (no module-scope state), so
 * `connect()` re-evaluates idempotently; the initial reflection never dispatches
 * or announces. Runtime Value and target changes repaint on a microtask and
 * dispatch `reconcile` only when the public derived state actually moves. Because
 * the field value is not part of a Turbo snapshot, everything derived from it is
 * rewound on `turbo:before-cache` — silently, since `connect()` derives it again
 * after a restore. The estimator is intentionally not a dictionary/zxcvbn-grade
 * one (kept zero-dep); a consumer that needs a stronger one computes the score
 * itself and hands it over through {@link setScore}.
 */
export class PasswordStrengthController extends Controller<HTMLElement> {
  static override targets = ["input", "meter", "label"];
  static override values = {
    minScore: { type: Number, default: 0 },
    // A JSON list read through `parseStringList` rather than Stimulus's `Array`
    // type: that reader throws out of the value observer before any callback
    // runs, so one malformed attribute would stop the meter connecting.
    levels: { type: String, default: "" },
    announceText: { type: String, default: "" },
  };
  static actions = ["evaluate", "setScore"] as const;
  static events = ["change", "reconcile"] as const;

  declare readonly inputTarget: HTMLInputElement;
  declare readonly meterTarget: HTMLElement;
  declare readonly labelTarget: HTMLElement;
  declare readonly hasInputTarget: boolean;
  declare readonly hasMeterTarget: boolean;
  declare readonly hasLabelTarget: boolean;

  declare minScoreValue: number;
  declare levelsValue: string;
  declare announceTextValue: string;

  /** Delay (ms) before one settled level is sent to the shared announcer. */
  static readonly #announceDelay = 200;

  readonly #timers = new SafeTimeout();
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindForCache());
  readonly #repaint = new MicrotaskCoalescer(() => this.#reconcile());
  #levels: string[] = [...DEFAULT_LEVELS];
  #announceId: number | null = null;
  #announcedLevel: string | null = null;
  #externalScore: number | null = null;
  #lastDetail: PasswordStrengthDetail | null = null;

  /** Reflects the current DOM state and opens the reconciliation window. */
  override connect(): void {
    this.#repaint.activate();
    this.#beforeCache.activate();
    // Reflect the current value synchronously (no event, no announcement): an
    // autofilled or cache-restored field shows the right strength without
    // queuing a screen-reader message.
    this.#lastDetail = this.#detail(this.#render());
  }

  /** Releases the reconciliation window, the cache subscription and the debounce. */
  override disconnect(): void {
    this.#repaint.cancel();
    this.#beforeCache.deactivate();
    this.#cancelAnnouncement();
    this.#announcedLevel = null;
    this.#externalScore = null;
    this.#lastDetail = null;
  }

  /** Re-evaluates strength from the input. Bound via `data-action` (`input`). */
  evaluate(): void {
    this.#externalScore = null;
    this.#commit();
  }

  /**
   * Adopts a score computed outside the built-in heuristic, clamped into the
   * declared scale. An unreadable value leaves the current score standing, and
   * the next `evaluate` hands scoring back to the heuristic.
   */
  setScore(event: SetScoreEvent): void {
    const next = toFiniteNumber(event.params?.score ?? event.detail?.score);
    if (next === null) return;
    this.#externalScore = next;
    this.#commit();
  }

  /** Re-reads the scale when application code or a Turbo morph changes `levels`. */
  levelsValueChanged(): void {
    this.#levels = this.#readLevels();
    this.#repaint.schedule();
  }

  /** Repaints when application code or a Turbo morph changes `minScore`. */
  minScoreValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Repaints when application code or a Turbo morph changes `announceText`. */
  announceTextValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Scores the field added or replaced at runtime. */
  inputTargetConnected(): void {
    this.#repaint.schedule();
  }

  /** Falls back to the pristine state after the scored field is removed. */
  inputTargetDisconnected(): void {
    this.#repaint.schedule();
  }

  /** Syncs a meter added or replaced at runtime, which carries no value yet. */
  meterTargetConnected(): void {
    this.#repaint.schedule();
  }

  /** Repaints the remaining output after a meter is removed. */
  meterTargetDisconnected(): void {
    this.#repaint.schedule();
  }

  /** Fills a readout added or replaced at runtime. */
  labelTargetConnected(): void {
    this.#repaint.schedule();
  }

  /** Repaints the remaining output after a readout is removed. */
  labelTargetDisconnected(): void {
    this.#repaint.schedule();
  }

  /** Reflects one confirmed scoring pass and offers its level to the reader. */
  #commit(): void {
    const reading = this.#render();
    this.#lastDetail = this.#detail(reading);
    this.dispatch("change", { detail: this.#lastDetail });
    this.#scheduleAnnouncement(reading);
  }

  /** Repaints one mutation batch and reports a changed controller-derived state. */
  #reconcile(): void {
    const previous = this.#lastDetail;
    // An edit inside the debounce window has already earned an announcement.
    // Reconciliation never originates one, but it must not carry a stale one
    // through either: the pending message is built from the level and the
    // template that held when it was queued, and both can move here. It is
    // retargeted at the settled reading so the reader hears what ends up shown.
    const owed = this.#announceId !== null;
    this.#cancelAnnouncement();
    const reading = this.#render();
    const detail = this.#detail(reading);
    this.#lastDetail = detail;
    // A blank readout has no level left to have been heard, here as much as on
    // the keystroke that empties the field, so the next level typed is news.
    if (reading.score === 0) this.#announcedLevel = null;
    if (owed) this.#scheduleAnnouncement(reading);
    if (previous && this.#detailsDiffer(previous, detail)) {
      this.dispatch("reconcile", { detail });
    }
  }

  /**
   * Synchronizes the meter ARIA, the root state hooks, the fill custom property
   * and the visible level readout.
   *
   * @stimeoRenderRoot
   */
  #render(): StrengthReading {
    const max = this.#levels.length;
    const score = this.#currentScore(max);
    const level = this.#levels[score - 1] ?? "";
    const meetsMin = score > 0 && score >= this.#minScore;
    const band = this.#band(score, max);

    this.#reflectMeter(score, max);
    this.#reflectRoot(score, max, band, meetsMin);
    this.#writeLabel(level);
    return { score, level, max, meetsMin, band };
  }

  /**
   * The declared minimum, or the Value's default (`0`, an inert gate) when the
   * declaration cannot be read as a number. Every comparison against an unread
   * number answers false, which would fail even the strongest password instead
   * of leaving the gate off, so the unreadable declaration is confined to its
   * own Value the way an unreadable scale is.
   */
  get #minScore(): number {
    return Number.isFinite(this.minScoreValue) ? this.minScoreValue : 0;
  }

  /** The externally supplied score when one stands, else the heuristic's. */
  #currentScore(max: number): number {
    if (this.#externalScore !== null) {
      return Math.min(max, Math.max(0, Math.round(this.#externalScore)));
    }
    return this.#score(this.hasInputTarget ? this.inputTarget.value : "", max);
  }

  /** Syncs the meter target's ARIA value attributes (`0..levels.length`). */
  #reflectMeter(score: number, max: number): void {
    if (!this.hasMeterTarget) return;
    this.meterTarget.setAttribute("aria-valuemin", "0");
    this.meterTarget.setAttribute("aria-valuemax", String(max));
    this.meterTarget.setAttribute("aria-valuenow", String(score));
  }

  /**
   * Reflects the level onto the root: the stable `data-strength` band (absent when
   * empty), the `data-below-min` hook when the score is under `minScore`, and the
   * `0–1` fill the consumer's CSS turns into the bar width.
   */
  #reflectRoot(score: number, max: number, band: string, meetsMin: boolean): void {
    this.#toggle("data-strength", band, band.length > 0);
    // Empty/pristine input (`score === 0`) is never "below min": that would let CSS
    // flag an untouched field as failing. The hook mirrors the event's `meetsMin`,
    // so it only marks a *non-empty* password under the threshold. `minScore`
    // defaults to 0, leaving the hook inert until set positive.
    this.#toggle("data-below-min", "true", score > 0 && !meetsMin);
    this.element.style.setProperty("--stimeo--password-strength", String(score / max));
  }

  /** Writes the visible readout only when its text actually changed. */
  #writeLabel(text: string): void {
    if (!this.hasLabelTarget || this.labelTarget.textContent === text) return;
    this.labelTarget.textContent = text;
  }

  /**
   * Locale-independent styling band (one of {@link STRENGTH_BANDS}) for `score`
   * out of `max`. Empty input → `""`. Maps the position within the declared scale
   * onto the position within the fixed bands, so both ends stay anchored on any
   * level count: the weakest score is always `weak` and the strongest `strong`,
   * and only the middle collapses when the scales differ in size.
   */
  #band(score: number, max: number): string {
    if (score <= 0) return "";
    const index = Math.round(((score - 1) / (max - 1)) * (STRENGTH_BANDS.length - 1));
    // A scored password always lands inside the band list; an unplaceable one
    // takes the weakest rather than claiming strength it was not measured to have.
    return STRENGTH_BANDS[index] ?? STRENGTH_BANDS[0];
  }

  /** Sets `name` to `value` when `on`, else removes it (value/presence data hook). */
  #toggle(name: string, value: string, on: boolean): void {
    if (on) {
      this.element.setAttribute(name, value);
    } else {
      this.element.removeAttribute(name);
    }
  }

  /** The declared level labels, or the defaults when the scale cannot order. */
  #readLevels(): string[] {
    const declared = parseStringList(this.levelsValue, DEFAULT_LEVELS);
    return declared.length >= MIN_LEVELS ? declared : [...DEFAULT_LEVELS];
  }

  /**
   * Lightweight zero-dependency strength heuristic returning an integer in
   * `[0, max]` (`max` = number of levels). Empty input is `0` (no level); any
   * non-empty password is at least `1`. Points accrue from length milestones and
   * character-class variety, then bucket into the level scale. A tiny alphabet
   * (≤ 2 distinct characters, e.g. "aaaa") is capped as the weakest, so length
   * alone cannot mask trivial repetition.
   */
  #score(password: string, max: number): number {
    if (password.length === 0) return 0;

    let points = 0;
    for (const milestone of LENGTH_MILESTONES) {
      if (password.length >= milestone) points += 1;
    }
    // The first present character class is free; each additional one adds a point.
    points += CLASS_PATTERNS.filter((re) => re.test(password)).length - 1;

    if (new Set(password).size <= 2) points = 0; // trivial repetition → weakest

    const bucketed = Math.round((points / MAX_POINTS) * max);
    return Math.min(max, Math.max(1, bucketed));
  }

  /** Debounces one i18n-neutral message for a level transition into the announcer. */
  #scheduleAnnouncement(reading: StrengthReading): void {
    this.#cancelAnnouncement();
    if (reading.score === 0) {
      // An emptied field has no level to read, and the next one typed is news.
      this.#announcedLevel = null;
      return;
    }
    if (reading.level === this.#announcedLevel) return;

    const message = fillTemplate(this.announceTextValue, {
      level: reading.level,
      score: reading.score,
      max: reading.max,
      band: reading.band,
    });
    if (message.trim().length === 0) return;

    this.#announceId = this.#timers.set(() => {
      this.#announcedLevel = reading.level;
      announce(message);
      this.#announceId = null;
    }, PasswordStrengthController.#announceDelay);
  }

  /** Cancels the one outstanding message without touching visible output. */
  #cancelAnnouncement(): void {
    if (this.#announceId !== null) this.#timers.clear(this.#announceId);
    this.#announceId = null;
  }

  /**
   * Returns every output derived from the field value to its pristine form.
   *
   * The value itself is not carried in a Turbo snapshot, so a band, a fill or a
   * readout left behind would describe a password the restored page no longer
   * holds. The pass is silent: `connect()` derives the state again from whatever
   * the restored field contains.
   */
  #rewindForCache(): void {
    this.#cancelAnnouncement();
    this.#announcedLevel = null;
    this.#externalScore = null;
    this.#lastDetail = null;
    this.#reflectMeter(0, this.#levels.length);
    this.#toggle("data-strength", "", false);
    this.#toggle("data-below-min", "true", false);
    this.element.style.removeProperty("--stimeo--password-strength");
    this.#writeLabel("");
  }

  /** Selects the public event state from the richer internal reading. */
  #detail(reading: StrengthReading): PasswordStrengthDetail {
    return {
      score: reading.score,
      level: reading.level,
      max: reading.max,
      meetsMin: reading.meetsMin,
    };
  }

  /** Compares exactly the state carried by `change` and `reconcile`. */
  #detailsDiffer(left: PasswordStrengthDetail, right: PasswordStrengthDetail): boolean {
    return (
      left.score !== right.score ||
      left.level !== right.level ||
      left.max !== right.max ||
      left.meetsMin !== right.meetsMin
    );
  }
}
