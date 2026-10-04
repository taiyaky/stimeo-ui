import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { AttributeLease } from "../utils/attribute_lease";
import { setDefaultAttribute } from "../utils/default_attribute";
import { DetachGate } from "../utils/detach_gate";
import { MinDurationFloor } from "../utils/min_duration_floor";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
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
 *   the controller then ends it as `stop` would; `hide` follows only if it was shown.
 *
 * `hide`, `show`, `timeout`, and `reconcile` dispatch `{}`. The last of those
 * reports that a connection returned to idle a cycle no instance was running — a page
 * restored from the Turbo cache in the middle of a load.
 *
 * @remarks
 * Behavior only — the visual spinner is the consumer's, alongside the text and
 * `aria-hidden="true"`. Both timers are owned by `SafeTimeout`, kept across
 * an in-page move and dropped on a real detach via `DetachGate`. A load in progress is
 * never undone on `turbo:before-cache`, which Turbo also dispatches on pages that stay
 * (a promoted frame navigation, a state-less `popstate`, a refresh of a cached URL, a
 * `data-turbo-permanent` element carried to the next page): the load is still running
 * there, and its `stop` still hides the spinner and announces the result.
 */
export class SpinnerController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override targets = ["indicator", "region", "message"];
  static override values = {
    announceText: { type: String, default: "" },
    announceReadyText: { type: String, default: "" },
    delay: { type: Number, default: 0 },
    minDuration: { type: Number, default: 0 },
    timeout: { type: Number, default: 0 },
  };

  static valueConstraints = {
    delay: NUMBER_BOUNDS.timer,
    minDuration: NUMBER_BOUNDS.timer,
    timeout: NUMBER_BOUNDS.timer,
  } satisfies NumberValueConstraints<typeof SpinnerController.values>;
  static actions = ["start", "stop"] as const;
  static events = ["hide", "show", "timeout", "reconcile"] as const;

  declare readonly indicatorTarget: HTMLElement;
  declare readonly indicatorTargets: HTMLElement[];
  declare readonly regionTarget: HTMLElement;
  declare readonly regionTargets: HTMLElement[];
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
  /** Owns the `aria-busy` written on each region, so one that departs gets its own back. */
  readonly #busyLease = new AttributeLease<HTMLElement>("aria-busy", this.identifier);
  /** Owns the `hidden` written on each indicator, so one that departs gets its own back. */
  readonly #hiddenLease = new AttributeLease<HTMLElement>("hidden", this.identifier);
  /** Whether `connect()` has run and `disconnect()` has not since. */
  #connected = false;
  /**
   * Whether this instance runs the cycle `data-state` reports: set when `start()` leaves
   * idle, cleared when the cycle returns to idle or its timers are dropped.
   */
  #cycling = false;

  /** Pending show-delay timer id, or `null` when no start is awaiting its delay. */
  #delayTimerId: number | null = null;
  /** Pending safety-net timer id, or `null` when `timeout` is off or not armed. */
  #timeoutTimerId: number | null = null;

  override connect(): void {
    this.#connected = true;
    this.#gate.cancel();
    if (this.#state !== "idle" && !this.#cycling) {
      // `pending` and `loading` live exactly as long as the cycle that wrote them.
      // Reading one back with no cycle of this instance behind it means the markup
      // outlived the cycle — a page restored from Turbo's cache, or an element
      // re-attached too late to count as a move — so nothing is left to advance or end
      // it and `start()` would refuse every later load. Fall back to idle, giving the
      // busy flag and the indicator their idle values, and report it: `hide` would
      // claim the load finished.
      this.#setBusy(false);
      this.#showIndicator(false);
      this.element.setAttribute("data-state", "idle");
      this.dispatch("reconcile", { detail: {} });
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
    this.#hiddenLease.write(target, this.#state === "loading" ? null : "");
  }

  /**
   * Gives an indicator that no longer resolves its own `hidden` back, even after
   * `disconnect()`, and while connected re-applies the current phase to the one that stays.
   */
  indicatorTargetDisconnected(indicator: HTMLElement): void {
    if (!this.indicatorTargets.includes(indicator)) this.#hiddenLease.return(indicator);
    if (this.#connected) this.#showIndicator(this.#state === "loading");
  }

  /** Applies the current busy state to a region inserted or replaced after `connect()`. */
  regionTargetConnected(region: HTMLElement): void {
    if (this.#connected) this.#busyLease.write(region, String(this.#busy));
  }

  /**
   * Gives a region that no longer resolves its own `aria-busy` back, even after
   * `disconnect()`, and while connected resyncs the region that stays.
   */
  regionTargetDisconnected(region: HTMLElement): void {
    if (!this.regionTargets.includes(region)) this.#busyLease.return(region);
    if (this.#connected) this.#setBusy(this.#busy);
  }

  override disconnect(): void {
    // Symmetric with `connect()` regardless of why the disconnect came: an in-page
    // move re-subscribes, and only the timers are held back for the reconnect.
    this.#connected = false;
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
    this.#cycling = true;
    this.#setBusy(true);
    // A hide held back from a previous cycle is now stale.
    this.#floor.cancel();
    this.#armTimeout();
    if (this.#safeDelay > 0) {
      this.element.setAttribute("data-state", "pending");
      this.#delayTimerId = this.#timers.set(() => {
        this.#delayTimerId = null;
        this.#show();
      }, this.#safeDelay);
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
      this.#cycling = false;
      this.#setBusy(false);
      this.element.setAttribute("data-state", "idle");
      return;
    }
    if (state !== "loading") return;

    this.#setBusy(false);
    this.#floor.schedule(this.#safeMinDuration, () => this.#hide());
  }

  /**
   * Reveals the indicator, marks the moment shown, and announces via the live region.
   *
   * @stimeoRuntimeOnly `announceText` is the wording of the one announcement this show makes.
   */
  #show(): void {
    this.#floor.begin();
    this.#showIndicator(true);
    this.element.setAttribute("data-state", "loading");
    this.dispatch("show", { detail: {} });
    // loading ↔ ready is the transition worth reading; the spinner itself is
    // visual and carries no words.
    announce(fillTemplate(this.announceTextValue, {}));
  }

  /**
   * Hides the indicator and returns to the idle state.
   *
   * @stimeoRuntimeOnly `announceReadyText` is the wording of the one announcement this hide makes.
   */
  #hide(): void {
    this.#cycling = false;
    this.#showIndicator(false);
    this.element.setAttribute("data-state", "idle");
    this.dispatch("hide", { detail: {} });
    announce(fillTemplate(this.announceReadyTextValue, {}));
  }

  /**
   * Drops the timers on a real detach, and with them the cycle. The markup keeps
   * whatever it last held: an element on its way out of the document has no reader
   * left, and one whose `data-controller` dropped the identifier no longer resolves its
   * own targets, so the rollback could only ever be partial; the indicator's `hidden`
   * and a region's `aria-busy` are the exceptions, given back by their target
   * callbacks. A copy of the markup that connects again — a page restored from the
   * cache — is returned to idle by `connect()`.
   */
  #teardown(): void {
    this.#timers.clearAll();
    this.#delayTimerId = null;
    this.#timeoutTimerId = null;
    this.#cycling = false;
  }

  /** Shows or hides the indicator (if present). */
  #showIndicator(shown: boolean): void {
    if (this.hasIndicatorTarget) this.#hiddenLease.write(this.indicatorTarget, shown ? null : "");
  }

  /** Reflects busy state onto the controlled region (if present). */
  #setBusy(busy: boolean): void {
    if (this.hasRegionTarget) this.#busyLease.write(this.regionTarget, String(busy));
  }

  /**
   * Arms the safety net so a `stop` that never arrives cannot strand the spinner.
   * Off by default: the consumer owns the async work, so only it knows whether a
   * ceiling makes sense. Re-arming on a restart measures from the newest start.
   */
  #armTimeout(): void {
    this.#cancelTimeout();
    if (this.#safeTimeout <= 0) return;
    this.#timeoutTimerId = this.#timers.set(() => {
      this.#timeoutTimerId = null;
      this.dispatch("timeout", { detail: {} });
      this.stop();
    }, this.#safeTimeout);
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

  /**
   * Whether the region reads busy now: a load waits out its show delay, or shows with
   * no hide held back by `minDuration`.
   */
  get #busy(): boolean {
    const state = this.#state;
    return state === "pending" || (state === "loading" && !this.#floor.pending);
  }
  /** Current `delay` declaration resolved against its numeric contract. */
  get #safeDelay(): number {
    return this.#numbers.read(
      this,
      "delay",
      this.delayValue,
      SpinnerController.values.delay.default,
      SpinnerController.valueConstraints.delay,
    );
  }

  /** Current `minDuration` declaration resolved against its numeric contract. */
  get #safeMinDuration(): number {
    return this.#numbers.read(
      this,
      "minDuration",
      this.minDurationValue,
      SpinnerController.values.minDuration.default,
      SpinnerController.valueConstraints.minDuration,
    );
  }

  /** Current `timeout` declaration resolved against its numeric contract. */
  get #safeTimeout(): number {
    return this.#numbers.read(
      this,
      "timeout",
      this.timeoutValue,
      SpinnerController.values.timeout.default,
      SpinnerController.valueConstraints.timeout,
    );
  }
}
