import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { setDefaultAttribute } from "../utils/default_attribute";
import { DetachGate } from "../utils/detach_gate";
import { MinDurationFloor } from "../utils/min_duration_floor";
import { SafeTimeout } from "../utils/safe_timeout";

/**
 * Headless loading-indicator behavior built on the `aria-busy` practice (no
 * dedicated APG pattern).
 *
 * Markup contract (identifier: `stimeo--spinner`):
 *   <div data-controller="stimeo--spinner"
 *        data-stimeo--spinner-delay-value="150"
 *        data-stimeo--spinner-min-duration-value="500"
 *        data-stimeo--spinner-timeout-value="0"
 *        data-stimeo--spinner-announce-text-value="Loading…"
 *        data-stimeo--spinner-announce-ready-text-value="Loading finished."
 *        data-action="loading:start->stimeo--spinner#start
 *                     loading:stop->stimeo--spinner#stop">
 *     <div hidden data-stimeo--spinner-target="indicator">
 *       <span data-stimeo--spinner-target="message">Loading…</span>
 *     </div>
 *     <div aria-busy="false" data-stimeo--spinner-target="region"></div>
 *   </div>
 *
 * The indicator is the visual half — its text plus a spinner the consumer marks
 * `aria-hidden="true"` — and the controlled `region` mirrors the busy state via
 * `aria-busy`. Assistive tech hears the transition through `announceText` /
 * `announceReadyText`, which go to the page's announcer: an indicator that only
 * becomes visible at the moment of the change is not reliably read, and giving it
 * live-region semantics on top of the announcement would say it twice. Two timers
 * tame flicker: `delay` suppresses the spinner for fast operations, and
 * `minDuration` keeps it visible long enough to be perceived once shown.
 * `timeout` is the opt-in safety net for the case the consumer's `stop` never
 * arrives.
 *
 * Events (all with an empty `detail`):
 * - `stimeo--spinner:show` — the indicator became visible, after `delay`.
 * - `stimeo--spinner:hide` — the indicator went away, after `minDuration`.
 * - `stimeo--spinner:timeout` — `timeout` elapsed with the load still running;
 *   the controller then ends it exactly as `stop` would, so a `hide` follows.
 *
 * @remarks
 * Behavior only — the visual spinner is the consumer's, alongside the text and
 * `aria-hidden="true"`. Both timers are owned by {@link SafeTimeout}, kept across
 * an in-page move and dropped on a real detach via {@link DetachGate}, while the
 * loading state a cached page would freeze is rewound by {@link BeforeCacheReset}.
 */
export class SpinnerController extends Controller<HTMLElement> {
  static override targets = ["indicator", "region", "message"];
  static override values = {
    announceText: { type: String, default: "" },
    announceReadyText: { type: String, default: "" },
    delay: { type: Number, default: 0 },
    minDuration: { type: Number, default: 0 },
    timeout: { type: Number, default: 0 },
  };
  static actions = ["start", "stop"] as const;
  static events = ["hide", "show", "timeout"] as const;

  declare readonly indicatorTarget: HTMLElement;
  declare readonly regionTarget: HTMLElement;
  declare readonly messageTarget: HTMLElement;
  declare readonly hasIndicatorTarget: boolean;
  declare readonly hasRegionTarget: boolean;
  declare readonly hasMessageTarget: boolean;

  declare delayValue: number;
  declare minDurationValue: number;
  declare timeoutValue: number;
  declare announceTextValue: string;
  declare announceReadyTextValue: string;

  readonly #timers = new SafeTimeout();
  readonly #floor = new MinDurationFloor(this.#timers);
  readonly #gate = new DetachGate();
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindForCache());

  /** Pending show-delay timer id, or `null` when no start is awaiting its delay. */
  #delayTimerId: number | null = null;
  /** Pending safety-net timer id, or `null` when `timeout` is off or not armed. */
  #timeoutTimerId: number | null = null;

  override connect(): void {
    this.#gate.cancel();
    this.#beforeCache.activate();
    if (this.#state === "pending" && this.#delayTimerId === null) {
      // `pending` lives exactly as long as its show-delay timer. Reading it back with
      // no timer of this instance behind it means the markup outlived the timer — a
      // restored snapshot, or an element re-attached too late to count as a move — so
      // nothing is left to advance it and `start()` would refuse every later load.
      // Fall back to idle, dropping the busy flag the interrupted `start()` set.
      this.#setBusy(false);
      this.element.setAttribute("data-state", "idle");
      return;
    }
    setDefaultAttribute(this.element, "data-state", "idle");
  }

  /**
   * Re-applies the current phase to an indicator that arrived after `connect()`.
   *
   * A Turbo Stream can swap the indicator for a fresh node mid-load, and that node
   * carries the markup contract's `hidden`. Without this the spinner would vanish
   * while `data-state` still says `loading`, and nothing but the next cycle would
   * bring it back.
   */
  indicatorTargetConnected(target: HTMLElement): void {
    target.hidden = this.#state !== "loading";
  }

  override disconnect(): void {
    // Symmetric with `connect()` regardless of why the disconnect came: an in-page
    // move re-subscribes, and only the timers are held back for the reconnect.
    this.#beforeCache.deactivate();
    this.#gate.disconnected(this, () => this.#teardown());
  }

  /** Begins loading. Honors `delay` before the spinner actually appears. */
  start(): void {
    if (this.#state === "loading") {
      // Already shown (possibly waiting out `minDuration` after a stop): a quick
      // stop→start within that window must keep the spinner visible. Restore the
      // busy state and cancel the pending hide instead of returning a no-op, which
      // would let the stale hide fire and flicker the spinner away mid-load.
      this.#setBusy(true);
      this.#floor.cancel();
      this.#armTimeout();
      return;
    }
    if (this.#state !== "idle") return;
    this.#setBusy(true);
    // A hide held back from a previous cycle is now stale.
    this.#floor.cancel();
    this.#armTimeout();
    if (this.delayValue > 0) {
      this.element.setAttribute("data-state", "pending");
      this.#delayTimerId = this.#timers.set(() => {
        this.#delayTimerId = null;
        this.#show();
      }, this.delayValue);
    } else {
      this.#show();
    }
  }

  /** Ends loading. Honors `minDuration` so a shown spinner does not flicker. */
  stop(): void {
    const state = this.#state;
    this.#cancelTimeout();
    if (state === "pending") {
      // The delay never elapsed — the spinner never appeared, so just cancel.
      this.#cancelDelay();
      this.#setBusy(false);
      this.element.setAttribute("data-state", "idle");
      return;
    }
    if (state !== "loading") return;

    this.#setBusy(false);
    this.#floor.schedule(this.minDurationValue, () => this.#hide());
  }

  /** Reveals the indicator, marks the moment shown, and announces via the live region. */
  #show(): void {
    this.#floor.begin();
    // A visible spinner always means a busy region. Re-asserting it costs nothing on
    // the direct path and closes the one where a snapshot rewind cleared the flag
    // while the show-delay timer it deliberately spared was still armed.
    this.#setBusy(true);
    if (this.hasIndicatorTarget) this.indicatorTarget.hidden = false;
    this.element.setAttribute("data-state", "loading");
    this.dispatch("show", { detail: {} });
    // loading ↔ ready is the transition worth reading; the spinner itself is
    // visual and carries no words.
    announce(fillTemplate(this.announceTextValue, {}));
  }

  /** Hides the indicator and returns to the idle state. */
  #hide(): void {
    if (this.hasIndicatorTarget) this.indicatorTarget.hidden = true;
    this.element.setAttribute("data-state", "idle");
    this.dispatch("hide", { detail: {} });
    announce(fillTemplate(this.announceReadyTextValue, {}));
  }

  /**
   * Drops both timers on a real detach. The markup keeps whatever it last held: an
   * element on its way out of the document has no reader left, and one whose
   * `data-controller` dropped the identifier no longer resolves its own targets, so
   * the rollback could only ever be partial. The snapshot is rewound where it is
   * still whole, on `turbo:before-cache`.
   */
  #teardown(): void {
    this.#gate.cancel();
    this.#timers.clearAll();
    this.#delayTimerId = null;
    this.#timeoutTimerId = null;
    this.#floor.cancel();
  }

  /**
   * Returns the loading state to idle for the snapshot Turbo is about to take,
   * so a page reached with the Back button is not restored mid-load with a
   * spinner nothing can stop. State only: `data-state`, the indicator's `hidden`,
   * and `aria-busy`. No `hide` is dispatched — the load was never observed to
   * finish, and a snapshot rewind is not a lifecycle event the consumer can act
   * on. The live page keeps its timers, so a navigation that never completes
   * leaves the running cycle intact.
   */
  #rewindForCache(): void {
    this.#cancelTimeout();
    this.#setBusy(false);
    if (this.hasIndicatorTarget) this.indicatorTarget.hidden = true;
    this.element.setAttribute("data-state", "idle");
  }

  /** Reflects busy state onto the controlled region (if present). */
  #setBusy(busy: boolean): void {
    if (this.hasRegionTarget) {
      this.regionTarget.setAttribute("aria-busy", String(busy));
    }
  }

  /**
   * Arms the safety net so a `stop` that never arrives cannot strand the spinner.
   * Off by default: the consumer owns the async work, so only it knows whether a
   * ceiling makes sense. Re-arming on a restart measures from the newest start.
   */
  #armTimeout(): void {
    this.#cancelTimeout();
    if (this.timeoutValue <= 0) return;
    this.#timeoutTimerId = this.#timers.set(() => {
      this.#timeoutTimerId = null;
      this.dispatch("timeout", { detail: {} });
      this.stop();
    }, this.timeoutValue);
  }

  #cancelTimeout(): void {
    if (this.#timeoutTimerId !== null) {
      this.#timers.clear(this.#timeoutTimerId);
      this.#timeoutTimerId = null;
    }
  }

  #cancelDelay(): void {
    if (this.#delayTimerId !== null) {
      this.#timers.clear(this.#delayTimerId);
      this.#delayTimerId = null;
    }
  }

  /** Current lifecycle phase as reflected on `data-state`. */
  get #state(): string {
    return this.element.getAttribute("data-state") ?? "idle";
  }
}
