import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { SafeTimeout } from "../utils/safe_timeout";

/**
 * Headless online/offline banner behavior built on the live-region practice (no
 * dedicated APG pattern).
 *
 * Markup contract (identifier: `stimeo--network-status`):
 *   <div data-controller="stimeo--network-status">
 *     <div role="alert" hidden data-stimeo--network-status-target="offline">
 *       You are offline.
 *     </div>
 *     <div role="status" hidden data-stimeo--network-status-target="online">
 *       Back online.
 *     </div>
 *   </div>
 *
 * Reads `navigator.onLine` on connect and subscribes to the `window`
 * `online`/`offline` events, toggling the matching banner. The offline banner is
 * `role="alert"` (assertive) because losing connectivity is urgent; the recovery
 * banner is `role="status"` (polite).
 *
 * @remarks
 * Behavior only. `navigator.onLine` is the browser's *guess* — it does not
 * guarantee server reachability, which stays the consumer's job. To make the
 * announcement reliable across assistive tech (merely un-hiding a static banner
 * is flaky), the controller reveals the banner and *then* re-writes its text on
 * each transition — a region revealed after its content changed is outside the
 * accessibility tree while the text changes, so the write has to come second —
 * guarded so an unchanged state never re-announces. The event listeners and the
 * auto-hide timer are removed/cleared on `disconnect()` (Turbo included).
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
    if (this.hasOfflineTarget) {
      // Reveal before writing: a hidden region is out of the accessibility tree,
      // so a text change made while it is still hidden is never observed.
      this.offlineTarget.hidden = false;
    }
  }

  /** Shows the recovery banner, optionally auto-hiding it after `onlineAutoHide`. */
  #showOnline(): void {
    if (this.hasOfflineTarget) this.offlineTarget.hidden = true;
    if (!this.hasOnlineTarget) return;
    // Reveal before writing, same as the offline banner.
    this.onlineTarget.hidden = false;
    if (this.onlineAutoHideValue > 0) {
      this.#timers.set(() => {
        this.onlineTarget.hidden = true;
      }, this.onlineAutoHideValue);
    }
  }
}
