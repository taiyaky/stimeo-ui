import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";

/** Character classes that contribute to password variety (one point each beyond the first). */
const CLASS_PATTERNS: readonly RegExp[] = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/];

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
 * Headless password-strength behavior: scores the field with a lightweight
 * zero-dependency heuristic and drives a meter plus an `aria-live` label. No
 * dedicated APG pattern; the meter display follows {@link MeterController}.
 *
 * Markup contract (identifier: `stimeo--password-strength`):
 *   <div data-controller="stimeo--password-strength">
 *     <input type="password" data-stimeo--password-strength-target="input"
 *            data-action="input->stimeo--password-strength#evaluate" aria-describedby="pw">
 *     <div data-stimeo--password-strength-target="meter" role="meter"
 *          aria-valuemin="0" aria-valuemax="4"></div>
 *     <span id="pw" data-stimeo--password-strength-target="label" aria-live="polite"></span>
 *   </div>
 *
 * On each input the controller scores the password (length milestones + character
 * variety, capped for trivial repetition), syncs the meter's `aria-valuenow`,
 * reflects a stable band on `data-strength`, the `0–1` fill on
 * `--stimeo-password-strength`, and (when `minScore` is set) `data-below-min`,
 * and writes the level label into the label target.
 *
 * @remarks
 * Behavior only — the meter/bar look is the consumer's, keyed off the data hooks.
 * `data-strength` is one of the fixed {@link STRENGTH_BANDS} (not the localizable
 * `levels` text), so consumers can style by it regardless of locale; the visible
 * label receives the matching `levels` entry. Non-text state (meter ARIA,
 * `data-strength`/`data-below-min`, the custom property, and the `change` event)
 * updates **immediately** on every keystroke so styling and consumers stay
 * responsive, while the label — in an `aria-live="polite"` region — is written on
 * a short debounce so a screen reader is not flooded mid-typing. The score is a
 * pure function of the input value (no module-scope state), so `connect()`
 * re-evaluates idempotently after a Turbo cache restore; the debounce timer is
 * owned by {@link SafeTimeout} and torn down on `disconnect()` (Turbo included).
 * The estimator is intentionally not a dictionary/zxcvbn-grade one (kept
 * zero-dep); swap a stronger one in on the consumer side if needed.
 */
export class PasswordStrengthController extends Controller<HTMLElement> {
  static override targets = ["input", "meter", "label"];
  static override values = {
    minScore: { type: Number, default: 0 },
    levels: { type: Array, default: ["weak", "fair", "good", "strong"] },
  };
  static actions = ["evaluate"] as const;
  static events = ["change"] as const;

  declare readonly inputTarget: HTMLInputElement;
  declare readonly meterTarget: HTMLElement;
  declare readonly labelTarget: HTMLElement;
  declare readonly hasInputTarget: boolean;
  declare readonly hasMeterTarget: boolean;
  declare readonly hasLabelTarget: boolean;

  declare minScoreValue: number;
  declare levelsValue: string[];

  /** Delay (ms) before the polite live-region label is written, to throttle SR flooding. */
  static readonly #announceDelay = 200;

  readonly #timers = new SafeTimeout();
  #announceId: number | null = null;

  override connect(): void {
    // Reflect the current value synchronously (no announce): an autofilled or
    // cache-restored field shows the right strength without queuing an SR message.
    this.#update({ announce: false });
  }

  override disconnect(): void {
    this.#timers.clearAll();
    this.#announceId = null;
  }

  /** Re-evaluates strength from the input. Bound via `data-action` (`input`). */
  evaluate(): void {
    this.#update();
  }

  /**
   * Recomputes the strength. The meter ARIA, data hooks, the custom property and
   * the `change` event apply immediately; the live-region label text is debounced
   * unless `announce` is `false` (the initial render).
   */
  #update(options: { announce?: boolean } = {}): void {
    const password = this.hasInputTarget ? this.inputTarget.value : "";
    const labels = this.levelsValue;
    const max = labels.length;
    const score = this.#score(password, max);
    const label = score > 0 ? (labels[score - 1] ?? "") : "";

    this.#reflectMeter(score, max);
    this.#reflectRoot(score, max);

    if (options.announce === false) {
      // Initial render (connect / cache-restore): reflect without a change event
      // or a queued screen-reader announcement.
      this.#writeLabel(label);
      return;
    }

    this.dispatch("change", {
      detail: { score, level: label, max, meetsMin: score > 0 && score >= this.minScoreValue },
    });

    if (this.#announceId !== null) this.#timers.clear(this.#announceId);
    this.#announceId = this.#timers.set(() => {
      this.#writeLabel(label);
      this.#announceId = null;
    }, PasswordStrengthController.#announceDelay);
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
  #reflectRoot(score: number, max: number): void {
    const band = this.#band(score, max);
    this.#toggle("data-strength", band, band.length > 0);
    // Empty/pristine input (`score === 0`) is never "below min": that would let CSS
    // flag an untouched field as failing. Mirror the `change` event's `meetsMin`
    // (`score > 0 && …`) so the hook only marks a *non-empty* password under the
    // threshold. `minScore` defaults to 0, leaving the hook inert until set positive.
    this.#toggle("data-below-min", "true", score > 0 && score < this.minScoreValue);
    const ratio = max > 0 ? score / max : 0;
    this.element.style.setProperty("--stimeo-password-strength", String(ratio));
  }

  #writeLabel(label: string): void {
    if (this.hasLabelTarget) this.labelTarget.textContent = label;
  }

  /**
   * Locale-independent styling band (one of {@link STRENGTH_BANDS}) for `score`
   * out of `max`. Empty input → `""`. Quantizes the `score/max` ratio into the
   * four fixed bands, so a non-default level count still maps onto a stable hook.
   */
  #band(score: number, max: number): string {
    if (score <= 0 || max <= 0) return "";
    const index = Math.ceil((score / max) * STRENGTH_BANDS.length) - 1;
    return STRENGTH_BANDS[Math.min(STRENGTH_BANDS.length - 1, Math.max(0, index))] ?? "";
  }

  /** Sets `name` to `value` when `on`, else removes it (value/presence data hook). */
  #toggle(name: string, value: string, on: boolean): void {
    if (on) {
      this.element.setAttribute(name, value);
    } else {
      this.element.removeAttribute(name);
    }
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
    if (password.length === 0 || max === 0) return 0;

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
}
