import { Controller } from "@hotwired/stimulus";
import { SafeInterval } from "../utils/safe_timeout";

/**
 * Headless countdown/timer behavior built on the live-region `role="timer"`
 * practice (no dedicated APG pattern).
 *
 * Markup contract (identifier: `stimeo--countdown`):
 *   <div data-controller="stimeo--countdown" role="timer" aria-live="off"
 *        data-stimeo--countdown-deadline-value="2026-12-31T23:59:59+09:00"
 *        data-action="countdown:pause->stimeo--countdown#pause
 *                     countdown:resume->stimeo--countdown#resume">
 *     <span data-stimeo--countdown-target="days">0</span>
 *     <span data-stimeo--countdown-target="hours">00</span>
 *     <span data-stimeo--countdown-target="minutes">00</span>
 *     <span data-stimeo--countdown-target="seconds">00</span>
 *   </div>
 *
 * Computes the time remaining to `deadline` (or elapsed since it, in
 * `direction="up"`), formats it into the day/hour/minute/second slots, and ticks
 * on `interval`. `aria-live="off"` is recommended so the timer is not announced
 * every second; only the milestone (completion) is surfaced — via the optional
 * `status` live region when a `completeLabel` is provided, or the `complete`
 * event for the consumer to handle.
 *
 * @remarks
 * Behavior only — slot text is updated, not styled. Pause/resume shifts an
 * internal time anchor so the displayed amount is preserved across a pause. The
 * interval is owned by {@link SafeInterval} and torn down on `disconnect()`
 * (Turbo navigation included).
 */
export class CountdownController extends Controller<HTMLElement> {
  static override targets = ["days", "hours", "minutes", "seconds", "status"];
  static override values = {
    deadline: { type: String, default: "" },
    interval: { type: Number, default: 1000 },
    direction: { type: String, default: "down" },
    autostart: { type: Boolean, default: true },
    completeLabel: { type: String, default: "" },
  };
  static actions = ["pause", "reset", "resume", "start"] as const;
  static events = ["complete", "tick"] as const;

  declare readonly daysTarget: HTMLElement;
  declare readonly hoursTarget: HTMLElement;
  declare readonly minutesTarget: HTMLElement;
  declare readonly secondsTarget: HTMLElement;
  declare readonly statusTarget: HTMLElement;
  declare readonly hasDaysTarget: boolean;
  declare readonly hasHoursTarget: boolean;
  declare readonly hasMinutesTarget: boolean;
  declare readonly hasSecondsTarget: boolean;
  declare readonly hasStatusTarget: boolean;

  declare deadlineValue: string;
  declare intervalValue: number;
  declare directionValue: string;
  declare autostartValue: boolean;
  declare completeLabelValue: string;

  readonly #intervals = new SafeInterval();
  #intervalId: number | null = null;

  /** Epoch-ms anchor: the deadline (down) or the count-up origin (up). */
  #reference = 0;
  /** Amount (ms) captured at pause, so resume can restore the same display. */
  #pausedAmount = 0;

  override connect(): void {
    this.#initReference();
    this.#render(this.#currentAmount());
    if (this.autostartValue && this.#isValidDeadline) {
      this.start();
    } else {
      this.element.setAttribute("data-state", "paused");
    }
  }

  override disconnect(): void {
    this.#intervals.clearAll();
    this.#intervalId = null;
  }

  /** Starts (or restarts after pause) ticking toward the deadline. */
  start(): void {
    if (this.#state === "running" || !this.#isValidDeadline) return;
    if (this.#isDown && this.#currentAmount() <= 0) {
      this.#complete();
      return;
    }
    this.#runInterval();
  }

  /** Pauses ticking, preserving the currently displayed amount. */
  pause(): void {
    if (this.#state !== "running") return;
    this.#pausedAmount = this.#currentAmount();
    this.#teardownInterval();
    this.element.setAttribute("data-state", "paused");
  }

  /** Resumes from a pause, continuing from the preserved amount. */
  resume(): void {
    if (this.#state !== "paused" || !this.#isValidDeadline) return;
    const now = Date.now();
    this.#reference = this.#isDown ? now + this.#pausedAmount : now - this.#pausedAmount;
    this.start();
  }

  /**
   * Re-syncs to the deadline and clears any pause offset, **preserving the current
   * run state**: a running timer keeps counting down from the reset amount, while a
   * paused (or completed) one resets the displayed amount but stays paused until the
   * user resumes — it never silently restarts. The run state is read from the DOM,
   * not re-derived from the declarative `autostart` Value (which only governs the
   * initial state on connect); re-deriving it would override a user's pause, the same
   * anti-pattern the Turbo-lifecycle guide warns about.
   */
  reset(): void {
    const wasRunning = this.#state === "running";
    this.#teardownInterval();
    this.#initReference();
    const amount = this.#currentAmount();
    this.#render(amount);
    // A prior complete() may have written a completion message into the status live
    // region; clear it so a reset timer does not keep showing (and announcing to a
    // screen reader) the stale "finished" text.
    if (this.hasStatusTarget) this.statusTarget.textContent = "";
    // teardownInterval() leaves data-state untouched; drop any lingering "running" to a
    // resting "paused" so start() (a no-op while "running") can re-arm when we resume.
    this.element.setAttribute("data-state", "paused");
    if (wasRunning && this.#isValidDeadline) {
      // Was counting down: re-arm and keep running from the reset amount.
      this.#pausedAmount = 0;
      this.start();
    } else {
      // Was paused/complete: hold at the reset amount and wait for the user to resume.
      // Remember the amount so resume() restores it instead of snapping the anchor to 0.
      this.#pausedAmount = amount;
    }
  }

  /** Schedules the repeating tick and marks the timer running. */
  #runInterval(): void {
    this.element.setAttribute("data-state", "running");
    this.#intervalId = this.#intervals.set(() => this.#tick(), this.intervalValue);
  }

  /** Cancels the repeating tick, if any. */
  #teardownInterval(): void {
    if (this.#intervalId !== null) {
      this.#intervals.clear(this.#intervalId);
      this.#intervalId = null;
    }
  }

  /** Recomputes, renders, emits `tick`, and completes when a countdown hits 0. */
  #tick(): void {
    const amount = this.#currentAmount();
    this.#render(amount);
    // `remaining` is the displayed amount (time left when counting down, elapsed
    // when counting up); `direction` lets consumers disambiguate the two.
    this.dispatch("tick", {
      detail: { remaining: amount, direction: this.#isDown ? "down" : "up" },
    });
    if (this.#isDown && this.#reference - Date.now() <= 0) {
      this.#complete();
    }
  }

  /** Stops at zero, marks completion, announces it, and emits `complete`. */
  #complete(): void {
    this.#teardownInterval();
    this.#render(0);
    this.element.setAttribute("data-state", "complete");
    if (this.hasStatusTarget && this.completeLabelValue.length > 0) {
      this.statusTarget.textContent = this.completeLabelValue;
    }
    this.dispatch("complete", { detail: {} });
  }

  /** Sets the time anchor from the `deadline` value. */
  #initReference(): void {
    this.#reference = Date.parse(this.deadlineValue);
  }

  /** Remaining (down) or elapsed (up) ms, never negative. */
  #currentAmount(): number {
    if (!this.#isValidDeadline) return 0;
    const now = Date.now();
    const raw = this.#isDown ? this.#reference - now : now - this.#reference;
    return Math.max(0, raw);
  }

  /** Writes the amount into the day/hour/minute/second slots. */
  #render(amount: number): void {
    const totalSeconds = Math.floor(amount / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (this.hasDaysTarget) this.daysTarget.textContent = String(days);
    if (this.hasHoursTarget) this.hoursTarget.textContent = this.#pad(hours);
    if (this.hasMinutesTarget) this.minutesTarget.textContent = this.#pad(minutes);
    if (this.hasSecondsTarget) this.secondsTarget.textContent = this.#pad(seconds);
  }

  /** Zero-pads a unit to two digits. */
  #pad(unit: number): string {
    return String(unit).padStart(2, "0");
  }

  get #isDown(): boolean {
    return this.directionValue !== "up";
  }

  get #isValidDeadline(): boolean {
    return !Number.isNaN(this.#reference);
  }

  /** Current lifecycle phase as reflected on `data-state`. */
  get #state(): string {
    return this.element.getAttribute("data-state") ?? "paused";
  }
}
