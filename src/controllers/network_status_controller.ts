import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { AttributeLease } from "../utils/attribute_lease";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { SafeTimeout } from "../utils/safe_timeout";

/**
 * Headless online/offline banner behavior built on the live-region practice (no
 * dedicated APG pattern).
 *
 * Markup contract (identifier: `stimeo--network-status`):
 *   <div data-controller="stimeo--network-status"
 *        data-stimeo--network-status-announce-text-value="You are offline."
 *        data-stimeo--network-status-announce-online-text-value="Back online.">
 *     <div hidden data-stimeo--network-status-target="offline">
 *       You are offline.
 *     </div>
 *     <div hidden data-stimeo--network-status-target="online">
 *       Back online.
 *     </div>
 *   </div>
 *
 * Reads `navigator.onLine` on connect and subscribes to the `window`
 * `online`/`offline` events, toggling the matching banner. The banners are the
 * visual half; assistive tech hears the transition through `announceText`
 * (assertive, because losing connectivity is urgent) and `announceOnlineText`
 * (polite), which go to the page's announcer.
 *
 * `change` dispatches `{ online: boolean }`.
 *
 * @remarks
 * Behavior only. `navigator.onLine` is the browser's *guess* — it does not
 * guarantee server reachability, which stays the consumer's job. A banner that is
 * merely un-hidden at the moment of the change is not reliably read, which is why
 * the wording goes to the page's announcer — a region that stands in the document
 * independently of this component. The transition is guarded so an unchanged
 * state never re-announces. The event listeners and the auto-hide timer are
 * removed/cleared on `disconnect()` (Turbo included).
 */
export class NetworkStatusController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override targets = ["offline", "online"];
  static override values = {
    announceText: { type: String, default: "" },
    announceOnlineText: { type: String, default: "" },
    onlineAutoHide: { type: Number, default: 0 },
  };

  static valueConstraints = {
    onlineAutoHide: NUMBER_BOUNDS.timer,
  } satisfies NumberValueConstraints<typeof NetworkStatusController.values>;
  static events = ["change"] as const;

  declare readonly offlineTarget: HTMLElement;
  declare readonly offlineTargets: HTMLElement[];
  declare readonly onlineTarget: HTMLElement;
  declare readonly onlineTargets: HTMLElement[];
  declare readonly hasOfflineTarget: boolean;
  declare readonly hasOnlineTarget: boolean;

  declare onlineAutoHideValue: number;
  declare announceTextValue: string;
  declare announceOnlineTextValue: string;

  readonly #timers = new SafeTimeout();
  /** Owns the `hidden` written on each banner, so one that departs gets its own back. */
  readonly #hidden = new AttributeLease<HTMLElement>("hidden", this.identifier);
  /** Whether `connect()` has run and `disconnect()` has not since. */
  #connected = false;

  /** Last known connectivity; guards against duplicate-state re-announcements. */
  #online = true;
  /** Whether the recovery banner is up: from a recovery until a drop or its auto-hide. */
  #recoveryShown = false;

  readonly #handleOnline = (): void => this.#update(true);
  readonly #handleOffline = (): void => this.#update(false);

  override connect(): void {
    this.#connected = true;
    this.#online = navigator.onLine;
    // On connect, surface only the offline state; do not flash a "back online"
    // banner just because the page loaded while connected. Both banners are written,
    // so a missing `hidden` in the markup cannot strand a stale one (e.g. an offline
    // notice showing while online).
    this.#recoveryShown = false;
    this.element.setAttribute("data-state", this.#online ? "online" : "offline");
    this.#paint();

    window.addEventListener("online", this.#handleOnline);
    window.addEventListener("offline", this.#handleOffline);
  }

  override disconnect(): void {
    this.#connected = false;
    window.removeEventListener("online", this.#handleOnline);
    window.removeEventListener("offline", this.#handleOffline);
    this.#timers.clearAll();
  }

  /** Shows or hides an offline banner that arrives at runtime as connectivity calls for. */
  offlineTargetConnected(): void {
    if (this.#connected) this.#paint();
  }

  /**
   * Gives an offline banner that no longer resolves its own `hidden` back, even after
   * `disconnect()`, and while connected repaints the banner that stays.
   */
  offlineTargetDisconnected(banner: HTMLElement): void {
    if (!this.offlineTargets.includes(banner)) this.#hidden.return(banner);
    if (this.#connected) this.#paint();
  }

  /** Shows or hides a recovery banner that arrives at runtime as the recovery calls for. */
  onlineTargetConnected(): void {
    if (this.#connected) this.#paint();
  }

  /**
   * Gives a recovery banner that no longer resolves its own `hidden` back, even after
   * `disconnect()`, and while connected repaints the banner that stays.
   */
  onlineTargetDisconnected(banner: HTMLElement): void {
    if (!this.onlineTargets.includes(banner)) this.#hidden.return(banner);
    if (this.#connected) this.#paint();
  }

  /**
   * Applies a connectivity transition, guarded against duplicate states.
   *
   * The event goes out last, so a listener reading `data-state` or a banner's
   * visibility sees the state the transition landed on rather than the previous one.
   *
   * @stimeoRuntimeOnly The texts word the one announcement of this transition; the state it shows
   *   comes from the browser.
   */
  #update(online: boolean): void {
    if (online === this.#online) return;
    this.#online = online;
    this.element.setAttribute("data-state", online ? "online" : "offline");
    if (online) {
      this.#showOnline();
    } else {
      this.#showOffline();
    }
    // The banner is the visual half; reading it out is the announcer's job, because
    // a region that is only revealed at the moment of the change is not reliably read.
    announce(fillTemplate(online ? this.announceOnlineTextValue : this.announceTextValue, {}), {
      assertive: !online,
    });
    this.dispatch("change", { detail: { online } });
  }

  /** Shows the offline banner and hides the recovery banner. */
  #showOffline(): void {
    this.#timers.clearAll();
    this.#recoveryShown = false;
    this.#paint();
  }

  /**
   * Shows the recovery banner, optionally auto-hiding it after `onlineAutoHide`. The
   * deadline belongs to the recovery, so a banner that arrives before it is hidden then too.
   *
   * @stimeoRuntimeOnly `onlineAutoHide` is the delay of the one timer that hides the banner this
   *   transition shows.
   */
  #showOnline(): void {
    this.#recoveryShown = true;
    this.#paint();
    if (this.#safeOnlineAutoHide > 0) {
      this.#timers.set(() => {
        this.#recoveryShown = false;
        this.#paint();
      }, this.#safeOnlineAutoHide);
    }
  }

  /** Writes the visibility connectivity and the recovery call for onto the first banners. */
  #paint(): void {
    if (this.hasOfflineTarget) this.#hidden.write(this.offlineTarget, this.#online ? "" : null);
    if (this.hasOnlineTarget)
      this.#hidden.write(this.onlineTarget, this.#recoveryShown ? null : "");
  }
  /** Current `onlineAutoHide` declaration resolved against its numeric contract. */
  get #safeOnlineAutoHide(): number {
    return this.#numbers.read(
      this,
      "onlineAutoHide",
      this.onlineAutoHideValue,
      NetworkStatusController.values.onlineAutoHide.default,
      NetworkStatusController.valueConstraints.onlineAutoHide,
    );
  }
}
