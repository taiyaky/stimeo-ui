import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";

/**
 * Headless loading-indicator behavior built on the live-region + `aria-busy`
 * practice (no dedicated APG pattern).
 *
 * Markup contract (identifier: `stimeo--spinner`):
 *   <div data-controller="stimeo--spinner"
 *        data-stimeo--spinner-delay-value="150"
 *        data-stimeo--spinner-min-duration-value="500"
 *        data-action="loading:start->stimeo--spinner#start
 *                     loading:stop->stimeo--spinner#stop">
 *     <div role="status" aria-live="polite" hidden
 *          data-stimeo--spinner-target="indicator">
 *       <span data-stimeo--spinner-target="message">Loading…</span>
 *     </div>
 *     <div aria-busy="false" data-stimeo--spinner-target="region"></div>
 *   </div>
 *
 * The indicator is a `role="status"` live region carrying *text* (never an icon
 * alone) so screen readers announce loading; the controlled `region` mirrors the
 * busy state via `aria-busy`. Two timers tame flicker: `delay` suppresses the
 * spinner for fast operations, and `minDuration` keeps it visible long enough to
 * be perceived once shown.
 *
 * @remarks
 * Behavior only — the visual spinner is the consumer's, alongside the text and
 * `aria-hidden="true"`. Both timers are owned by {@link SafeTimeout} and torn
 * down on `disconnect()` (Turbo navigation included).
 */
export class SpinnerController extends Controller<HTMLElement> {
  static override targets = ["indicator", "region", "message"];
  static override values = {
    delay: { type: Number, default: 0 },
    minDuration: { type: Number, default: 0 },
  };
  static actions = ["start", "stop"] as const;
  static events = ["hide", "show"] as const;

  declare readonly indicatorTarget: HTMLElement;
  declare readonly regionTarget: HTMLElement;
  declare readonly messageTarget: HTMLElement;
  declare readonly hasIndicatorTarget: boolean;
  declare readonly hasRegionTarget: boolean;
  declare readonly hasMessageTarget: boolean;

  declare delayValue: number;
  declare minDurationValue: number;

  readonly #timers = new SafeTimeout();

  /** Pending show-delay timer id, or `null` when no start is awaiting its delay. */
  #delayTimerId: number | null = null;
  /** Pending min-duration hide timer id, or `null` when none is scheduled. */
  #hideTimerId: number | null = null;
  /** Epoch ms when the spinner became visible, used to enforce `minDuration`. */
  #shownAt = 0;

  override connect(): void {
    if (!this.element.hasAttribute("data-state")) {
      this.element.setAttribute("data-state", "idle");
    }
  }

  override disconnect(): void {
    this.#timers.clearAll();
    this.#delayTimerId = null;
    this.#hideTimerId = null;
  }

  /** Begins loading. Honors `delay` before the spinner actually appears. */
  start(): void {
    if (this.#state === "loading") {
      // Already shown (possibly waiting out `minDuration` after a stop): a quick
      // stop→start within that window must keep the spinner visible. Restore the
      // busy state and cancel the pending hide instead of returning a no-op, which
      // would let the stale hide fire and flicker the spinner away mid-load.
      this.#setBusy(true);
      this.#cancelHide();
      return;
    }
    if (this.#state !== "idle") return;
    this.#setBusy(true);
    // A pending hide from a previous cycle is now stale.
    this.#cancelHide();
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
    if (state === "pending") {
      // The delay never elapsed — the spinner never appeared, so just cancel.
      this.#cancelDelay();
      this.#setBusy(false);
      this.element.setAttribute("data-state", "idle");
      return;
    }
    if (state !== "loading") return;

    this.#setBusy(false);
    const remaining = this.minDurationValue - (Date.now() - this.#shownAt);
    if (remaining > 0) {
      this.#hideTimerId = this.#timers.set(() => {
        this.#hideTimerId = null;
        this.#hide();
      }, remaining);
    } else {
      this.#hide();
    }
  }

  /** Reveals the indicator, marks the moment shown, and announces via the live region. */
  #show(): void {
    this.#shownAt = Date.now();
    if (this.hasIndicatorTarget) this.indicatorTarget.hidden = false;
    this.element.setAttribute("data-state", "loading");
    this.dispatch("show", { detail: {} });
  }

  /** Hides the indicator and returns to the idle state. */
  #hide(): void {
    if (this.hasIndicatorTarget) this.indicatorTarget.hidden = true;
    this.element.setAttribute("data-state", "idle");
    this.dispatch("hide", { detail: {} });
  }

  /** Reflects busy state onto the controlled region (if present). */
  #setBusy(busy: boolean): void {
    if (this.hasRegionTarget) {
      this.regionTarget.setAttribute("aria-busy", String(busy));
    }
  }

  #cancelDelay(): void {
    if (this.#delayTimerId !== null) {
      this.#timers.clear(this.#delayTimerId);
      this.#delayTimerId = null;
    }
  }

  #cancelHide(): void {
    if (this.#hideTimerId !== null) {
      this.#timers.clear(this.#hideTimerId);
      this.#hideTimerId = null;
    }
  }

  /** Current lifecycle phase as reflected on `data-state`. */
  get #state(): string {
    return this.element.getAttribute("data-state") ?? "idle";
  }
}
