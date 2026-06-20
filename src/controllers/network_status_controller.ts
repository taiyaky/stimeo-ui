import { Controller } from "@hotwired/stimulus";
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
 * is flaky), the controller re-writes the banner's text on each transition,
 * guarded so an unchanged state never re-announces. The event listeners and the
 * auto-hide timer are removed/cleared on `disconnect()` (Turbo included).
 */
export class NetworkStatusController extends Controller<HTMLElement> {
  static override targets = ["offline", "online"];
  static override values = {
    onlineAutoHide: { type: Number, default: 0 },
  };
  static events = ["change"] as const;

  declare readonly offlineTarget: HTMLElement;
  declare readonly onlineTarget: HTMLElement;
  declare readonly hasOfflineTarget: boolean;
  declare readonly hasOnlineTarget: boolean;

  declare onlineAutoHideValue: number;

  readonly #timers = new SafeTimeout();

  /** Last known connectivity; guards against duplicate-state re-announcements. */
  #online = true;
  /** Banner text captured from the markup so transitions can re-write it. */
  #offlineMessage = "";
  #onlineMessage = "";

  readonly #handleOnline = (): void => this.#update(true);
  readonly #handleOffline = (): void => this.#update(false);

  override connect(): void {
    this.#offlineMessage = this.hasOfflineTarget
      ? (this.offlineTarget.textContent ?? "").trim()
      : "";
    this.#onlineMessage = this.hasOnlineTarget ? (this.onlineTarget.textContent ?? "").trim() : "";

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

  /** Applies a connectivity transition, guarded against duplicate states. */
  #update(online: boolean): void {
    if (online === this.#online) return;
    this.#online = online;
    this.element.setAttribute("data-state", online ? "online" : "offline");
    if (online) {
      this.#showOnline();
    } else {
      this.#showOffline();
    }
    this.dispatch("change", { detail: { online } });
  }

  /** Shows the offline banner and hides the recovery banner. */
  #showOffline(): void {
    this.#timers.clearAll();
    if (this.hasOnlineTarget) this.onlineTarget.hidden = true;
    if (this.hasOfflineTarget) {
      this.offlineTarget.textContent = this.#offlineMessage;
      this.offlineTarget.hidden = false;
    }
  }

  /** Shows the recovery banner, optionally auto-hiding it after `onlineAutoHide`. */
  #showOnline(): void {
    if (this.hasOfflineTarget) this.offlineTarget.hidden = true;
    if (!this.hasOnlineTarget) return;
    this.onlineTarget.textContent = this.#onlineMessage;
    this.onlineTarget.hidden = false;
    if (this.onlineAutoHideValue > 0) {
      this.#timers.set(() => {
        this.onlineTarget.hidden = true;
      }, this.onlineAutoHideValue);
    }
  }
}
