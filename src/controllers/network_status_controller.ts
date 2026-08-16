import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
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
  static override targets = ["offline", "online"];
  static override values = {
    announceText: { type: String, default: "" },
    announceOnlineText: { type: String, default: "" },
    onlineAutoHide: { type: Number, default: 0 },
  };
  static events = ["change"] as const;

  declare readonly offlineTarget: HTMLElement;
  declare readonly onlineTarget: HTMLElement;
  declare readonly hasOfflineTarget: boolean;
  declare readonly hasOnlineTarget: boolean;

  declare onlineAutoHideValue: number;
  declare announceTextValue: string;
  declare announceOnlineTextValue: string;

  readonly #timers = new SafeTimeout();

  /** Last known connectivity; guards against duplicate-state re-announcements. */
  #online = true;

  readonly #handleOnline = (): void => this.#update(true);
  readonly #handleOffline = (): void => this.#update(false);

  override connect(): void {
    // Normalize initial visibility so a missing `hidden` in the markup cannot
    // strand a stale banner (e.g. an offline notice showing while online).
    if (this.hasOfflineTarget) this.offlineTarget.hidden = true;
    if (this.hasOnlineTarget) this.onlineTarget.hidden = true;

    this.#online = navigator.onLine;
    // On connect, surface only the offline state; do not flash a "back online"
    // banner just because the page loaded while connected.
    this.element.setAttribute("data-state", this.#online ? "online" : "offline");
    if (!this.#online) this.#showOffline();

    window.addEventListener("online", this.#handleOnline);
    window.addEventListener("offline", this.#handleOffline);
  }

  override disconnect(): void {
    window.removeEventListener("online", this.#handleOnline);
    window.removeEventListener("offline", this.#handleOffline);
    this.#timers.clearAll();
  }

  /**
   * Applies a connectivity transition, guarded against duplicate states.
   *
   * The event goes out last, so a listener reading `data-state` or a banner's
   * visibility sees the state the transition landed on rather than the previous one.
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
    if (this.hasOnlineTarget) this.onlineTarget.hidden = true;
    if (this.hasOfflineTarget) this.offlineTarget.hidden = false;
  }

  /** Shows the recovery banner, optionally auto-hiding it after `onlineAutoHide`. */
  #showOnline(): void {
    if (this.hasOfflineTarget) this.offlineTarget.hidden = true;
    if (!this.hasOnlineTarget) return;
    this.onlineTarget.hidden = false;
    if (this.onlineAutoHideValue > 0) {
      this.#timers.set(() => {
        this.onlineTarget.hidden = true;
      }, this.onlineAutoHideValue);
    }
  }
}
