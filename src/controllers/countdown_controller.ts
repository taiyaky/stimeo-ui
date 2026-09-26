import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { SafeInterval } from "../utils/safe_timeout";

/** Display granularity: the slots render whole seconds, so amounts snap to these. */
const SECOND_MS = 1000;

/**
 * Suffix of the marker on the text this controller wrote into the `status` slot;
 * the marker holds that text as its value. The slot is this controller's only while
 * it shows that text and nothing else: the two still agree, and the slot holds no
 * element. While the marker holds text, a slot the consumer rewrites or empties
 * afterwards is theirs; a marker with an empty value owns the empty slot, including
 * one the consumer empties again after writing into it. An element the consumer
 * puts in the slot makes it theirs either way, for as long as it is there. A
 * restored page carries the claim along with the text.
 */
const OWNED_STATUS = "owns-status";

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
 * every second; only the milestone (completion) is surfaced — read out through
 * `announceText`, shown in the optional `status` slot when a `completeLabel` is
 * provided, and handed to the consumer as the `complete` event. Keep the `status`
 * slot free of live-region semantics: with `announceText` set it would say the
 * same thing twice.
 *
 * The slot is shared with the consumer. Completion writes the label in force and
 * marks it with `data-<identifier>-owns-status`, whose value is that text; while
 * the slot still shows that text and nothing else, the controller keeps it on the
 * current `completeLabel` and takes it back once the timer leaves the complete
 * state — `reset`, `start()` counting on from it, or a completion the new reading
 * does not settle (a deadline moved forward or a count turned `up`, in place or
 * before a restore). All but `start()` leave it `paused`, so `resume()` counts
 * again.
 * An empty label puts no text there, so it never displaces what the slot already
 * holds; completing with one claims an empty slot — no text and no element — with
 * an empty marker, which owns the slot whenever it is empty. Text the consumer put
 * there stays theirs while it is there, and so does a slot they put an element in,
 * whatever its text: the label is neither followed into it nor taken back out of
 * it, and its marker stays, until the element is gone. Only a completion with a
 * label writes over either.
 *
 * `complete` dispatches `{}`; `tick` dispatches
 * `{ remaining: number, direction: "down" | "up" }`, where `remaining` is in
 * milliseconds.
 *
 * @remarks
 * Behavior only — slot text is updated, not styled. Pause/resume shifts an
 * internal time anchor so the displayed amount is preserved across a pause, down
 * to the second actually on screen: resuming continues from that reading rather
 * than from the fraction behind it, so the first tick after a resume steps by one
 * unit like every other. The run state lives in `data-state` and the markup is its
 * source of truth — `autostart` only decides the state of a timer whose markup does
 * not carry one. The interval is owned by `SafeInterval` and torn down on
 * `disconnect()` (Turbo navigation included); nothing else needs carrying across,
 * because every reading is re-derived from `deadline` and the wall clock.
 */
export class CountdownController extends Controller<HTMLElement> {
  /** The status marker, in the namespace this controller is registered under. */
  get #ownedStatus(): string {
    return `data-${this.identifier}-${OWNED_STATUS}`;
  }

  static override targets = ["days", "hours", "minutes", "seconds", "status"];
  static override values = {
    deadline: { type: String, default: "" },
    interval: { type: Number, default: 1000 },
    direction: { type: String, default: "down" },
    autostart: { type: Boolean, default: true },
    completeLabel: { type: String, default: "" },
    announceText: { type: String, default: "" },
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
  declare announceTextValue: string;

  readonly #intervals = new SafeInterval();
  #intervalId: number | null = null;
  /** Collapses a morph that swaps several render inputs at once into one re-derive. */
  readonly #resync = new MicrotaskCoalescer(() => this.#resyncToValues());
  /**
   * Whether `connect()` has run for this connection. Stimulus delivers Value
   * callbacks ahead of it, while the run state is still the markup's own and not
   * yet settled; `connect()` brings the status up to date once it is.
   */
  #connected = false;

  /** Epoch-ms anchor: the deadline (down) or the count-up origin (up). */
  #reference = 0;
  /** Amount (ms) captured at pause, so resume can restore the same display. */
  #pausedAmount = 0;
  /**
   * The amount the slots are currently showing, floored to the second they render.
   * It lags {@link #currentAmount} by up to one tick, and it — not the live reading —
   * is what a pause has to preserve: storing the fraction behind the display instead
   * makes the first tick after a resume step by two units.
   */
  #renderedAmount = 0;

  override connect(): void {
    this.#connected = true;
    this.#resync.activate();
    this.#initReference();
    const amount = this.#currentAmount();
    this.#render(amount);
    // Remember what is on screen so resume() continues from it instead of snapping
    // the anchor to now (which would settle a countdown at once).
    this.#pausedAmount = this.#renderedAmount;

    const authored = this.element.getAttribute("data-state");
    // A completion that is still settled stands. Dropping it to the resting state
    // would let a later resume() cross zero a second time and announce the same
    // completion again; only a reading that no longer settles it — a deadline
    // moved forward, or a count turned `up` — re-arms it.
    const settled = authored === "complete" && this.#isSettled(amount);
    if (authored === null) {
      // Nothing to honor: this is the declarative first render, which is the only
      // thing `autostart` governs.
      if (this.autostartValue && this.#isValidDeadline) this.start();
      else this.element.setAttribute("data-state", "paused");
    } else if (!settled) {
      // A pause the user made survives the round trip, but nothing carries a live
      // timer across it — a restored "running" has to be re-armed here or it renders
      // once and freezes, because start() is a no-op while the attribute still says
      // "running".
      this.element.setAttribute("data-state", "paused");
      if (authored === "running") this.start();
    }
    // Value callbacks ran ahead of this, before the run state above was settled, so a
    // status still holding this controller's text is brought up to date here.
    this.#syncStatus();
  }

  override disconnect(): void {
    this.#connected = false;
    this.#resync.cancel();
    this.#intervals.clearAll();
    this.#intervalId = null;
  }

  /** Re-derives the display when a morph swaps the deadline in place. */
  deadlineValueChanged(): void {
    this.#resync.schedule();
  }

  /** Re-derives the display when a morph flips the counting direction in place. */
  directionValueChanged(): void {
    this.#resync.schedule();
  }

  /**
   * Follows a completion label swapped in place by a morph.
   *
   * Render only: `complete` is neither dispatched nor announced again. The status
   * changes only after the countdown has completed, and only while it still shows
   * the text this controller wrote there and nothing else, so text or an element
   * the consumer put in the slot stays. A change delivered ahead of `connect()` is
   * left to `connect()`.
   */
  completeLabelValueChanged(): void {
    if (this.#connected) this.#syncStatus();
  }

  /**
   * Keeps a status that still shows this controller's text, and nothing else, on
   * what the run state calls for: the label in force while complete; otherwise the
   * text is taken back, marker and all. A status holding anything else is the
   * consumer's and is left alone, marker included.
   *
   * @stimeoRenderRoot
   */
  #syncStatus(): void {
    if (!this.hasStatusTarget || !this.#ownsStatus(this.statusTarget)) return;
    if (this.#state === "complete") this.#writeStatus(this.statusTarget, this.completeLabelValue);
    else this.#releaseStatus(this.statusTarget);
  }

  /**
   * Points the anchor at the current `deadline` / `direction` and repaints.
   *
   * Render only: it starts no interval and emits no event, so a morph cannot make a
   * paused timer run or replay a milestone. A running one needs no restart either —
   * every tick reads the anchor, so moving it is enough. While paused the stored
   * amount follows the new reading, or resume would continue from the old deadline.
   * A completion the new reading no longer settles (a deadline moved forward, or a
   * count turned `up`) is handed back paused, as `connect()` hands back a restored
   * one, so `resume()` counts again; the completion text this controller wrote goes
   * with it, from a status slot that still shows it and nothing else.
   *
   * @stimeoRenderRoot
   */
  #resyncToValues(): void {
    this.#initReference();
    const amount = this.#currentAmount();
    this.#render(amount);
    if (this.#state === "complete" && !this.#isSettled(amount)) {
      this.element.setAttribute("data-state", "paused");
      this.#syncStatus();
    }
    if (this.#state !== "running") this.#pausedAmount = this.#renderedAmount;
  }

  /**
   * Starts (or restarts after pause) ticking toward the deadline. Counting on from a
   * completion takes this controller's completion text back out of the status.
   */
  start(): void {
    if (this.#state === "running" || !this.#isValidDeadline) return;
    if (this.#isDown && this.#currentAmount() <= 0) {
      // Already settled — a restored snapshot keeps data-state="complete". The
      // milestone was announced in the visit that reached zero, so completing again
      // here would re-emit `complete` on every reconnect.
      if (this.#state !== "complete") this.#complete();
      return;
    }
    this.#runInterval();
  }

  /** Pauses ticking, preserving the currently displayed amount. */
  pause(): void {
    if (this.#state !== "running") return;
    this.#pausedAmount = this.#renderedAmount;
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
   * not re-derived from the declarative `autostart` Value (which governs only markup
   * that states no run state at all); re-deriving it would override a user's pause —
   * the DOM, not a re-run of declarative config, is the source of truth.
   */
  reset(): void {
    const wasRunning = this.#state === "running";
    this.#teardownInterval();
    this.#initReference();
    const amount = this.#currentAmount();
    this.#render(amount);
    // teardownInterval() leaves data-state untouched; drop any lingering "running" to a
    // resting "paused" so start() (a no-op while "running") can re-arm when we resume.
    this.element.setAttribute("data-state", "paused");
    // A reset timer has left the complete state, so the completion text this
    // controller wrote leaves the status slot with it; a slot the consumer rewrote or
    // put an element in stays as it is.
    this.#syncStatus();
    if (wasRunning && this.#isValidDeadline) {
      // Was counting down: re-arm and keep running from the reset amount.
      this.#pausedAmount = 0;
      this.start();
    } else {
      // Was paused/complete: hold at the reset amount and wait for the user to resume.
      // Remember what is on screen so resume() restores it instead of snapping the
      // anchor to 0.
      this.#pausedAmount = this.#renderedAmount;
    }
  }

  /**
   * Schedules the repeating tick and marks the timer running. This is the one way
   * into `running`, and a running timer keeps none of this controller's completion
   * text in the status, so the status is settled here as on every other way out of
   * `complete`: `start()` leaves a completion directly when `direction` flips to
   * `up` and `start()` runs in the same task, ahead of the direction callback.
   *
   * @stimeoRuntimeOnly `interval` is the period of the one timer this call arms; the running state
   *   it writes does not depend on a Value.
   */
  #runInterval(): void {
    this.element.setAttribute("data-state", "running");
    this.#syncStatus();
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

  /**
   * Stops at zero, marks completion, writes the completion label, emits `complete`,
   * and announces it.
   *
   * @stimeoRenderRoot
   */
  #complete(): void {
    this.#teardownInterval();
    this.#render(0);
    this.element.setAttribute("data-state", "complete");
    this.#claimStatus();
    this.dispatch("complete", { detail: {} });
    this.#announceCompletion();
  }

  /**
   * Writes the label in force into the status slot as this controller's text. An
   * empty label puts no text there: it claims a slot that is already empty — no
   * text and no element — empties one that is still this controller's, and leaves
   * any other slot, the consumer's, alone.
   */
  #claimStatus(): void {
    if (!this.hasStatusTarget) return;
    const status = this.statusTarget;
    const label = this.completeLabelValue;
    if (label === "" && !this.#isEmpty(status) && !this.#ownsStatus(status)) return;
    this.#writeStatus(status, label);
  }

  /**
   * Whether the status slot shows the text this controller wrote there and nothing
   * else: the text matches the marker, and the slot holds no element. Writing the
   * slot's text replaces every child node, so an element the consumer puts in the
   * slot makes it theirs even while the text still matches. An empty marker
   * matches the slot whenever it is empty.
   */
  #ownsStatus(status: HTMLElement): boolean {
    return (
      status.getAttribute(this.#ownedStatus) === status.textContent &&
      status.firstElementChild === null
    );
  }

  /** Whether the status slot holds nothing at all: no text and no element. */
  #isEmpty(status: HTMLElement): boolean {
    return status.textContent === "" && status.firstElementChild === null;
  }

  /** Puts `text` into the status slot and records it as this controller's. */
  #writeStatus(status: HTMLElement, text: string): void {
    if (status.textContent !== text) status.textContent = text;
    status.setAttribute(this.#ownedStatus, text);
  }

  /** Takes this controller's text out of the status slot, marker and all. */
  #releaseStatus(status: HTMLElement): void {
    status.textContent = "";
    status.removeAttribute(this.#ownedStatus);
  }

  /**
   * Reads the completion out through the shared announcer.
   *
   * @stimeoRuntimeOnly `announceText` words the one announcement a completion makes.
   */
  #announceCompletion(): void {
    // Reaching zero is the transition; the ticking numbers in between are state
    // the consumer can see, and reading each one would be unusable.
    announce(fillTemplate(this.announceTextValue, {}));
  }

  /** Sets the time anchor from the `deadline` value. */
  #initReference(): void {
    this.#reference = Date.parse(this.deadlineValue);
  }

  /** Whether a reading of `amount` leaves nothing to count: only a countdown at zero. */
  #isSettled(amount: number): boolean {
    return this.#isDown && amount <= 0;
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
    const totalSeconds = Math.floor(amount / SECOND_MS);
    this.#renderedAmount = totalSeconds * SECOND_MS;
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
