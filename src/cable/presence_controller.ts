import { Controller } from "@hotwired/stimulus";
import { SafeInterval, SafeTimeout } from "../utils/safe_timeout";
import { type ConfirmedCableSubscription, createConfirmedSubscription } from "./consumer";

/** A peer currently present (another client in the same room). */
interface Peer {
  name: string;
  /** Auto-expiry timer id, restarted by every beacon. */
  timer: number;
}

/**
 * Minimum ms between outgoing beacons. The steady state is the `heartbeat`
 * interval; this guard only bounds the *extra* beacons sent in response to
 * newly seen peers (see the roster-convergence note in the class doc), so a
 * burst of joiners cannot make this client flood the channel.
 */
const BEACON_THROTTLE_MS = 2000;

/**
 * Headless **presence** — a *server-bound* behavior: online dots / a
 * "who's viewing this" stack, bound to an Action Cable channel. Like
 * `stimeo--typing-indicator`, the server stays a trivial rebroadcast channel
 * with **zero presence state**: every client heartbeats an `appear` beacon
 * (`{ id, name }`), and each client expires peers it has not heard from for
 * `timeout` ms. Leaving (`{ id, leaving: true }`) is broadcast best-effort on
 * `disconnect()` and on `pagehide` (tab close / hard navigation, where
 * `disconnect()` never runs); a lost notice is caught by the expiry. Ships in
 * the opt-in `stimeo-ui/cable` subpath (`@rails/actioncable` optional peer).
 *
 * Roster convergence: a late joiner would otherwise see peers only as their
 * next heartbeats arrive, so on hearing a beacon from an *unknown* peer, each
 * client re-announces itself (throttled to {@link BEACON_THROTTLE_MS}) — the
 * roster converges in one round-trip instead of one heartbeat period.
 *
 * Markup contract (identifier: `stimeo--presence`):
 *   <div data-controller="stimeo--presence"
 *        data-stimeo--presence-channel-value="PresenceChannel"
 *        data-stimeo--presence-params-value='{"room":"doc_7"}'
 *        data-stimeo--presence-id-value="17" data-stimeo--presence-name-value="Alice">
 *     <span data-stimeo--presence-target="count" data-other="%{count} viewing"></span>
 *     <ul data-stimeo--presence-target="list"></ul>
 *     <template data-stimeo--presence-target="template">
 *       <li><span data-presence-name></span></li>
 *     </template>
 *   </div>
 *
 * Server contract (a trivial rebroadcast channel):
 *   class PresenceChannel < ApplicationCable::Channel
 *     def subscribed = stream_from "presence:#{params[:room]}"
 *     def appear(data) = ActionCable.server.broadcast("presence:#{params[:room]}",
 *       { id: data["id"], name: data["name"], leaving: data["leaving"] })
 *   end
 *
 * @remarks
 * Behavior only — the dot/stack look is the consumer's CSS, keyed off the
 * `data-present` / `data-present-count` hooks. The roster counts and renders
 * **other** clients (`id` ≠ own `id`); rendering is optional: given a `list` +
 * `template` pair, one clone per peer is appended (elements marked
 * `data-presence-name` receive the name; the clone root is tagged
 * `data-presence-id`), and the `count` target renders through localizable
 * `data-zero` / `data-one` / `data-other` templates (`%{count}`). Richer
 * per-user rendering (avatars, links) belongs to the consumer via the `join` /
 * `leave` / `change` events or a server-rendered Turbo Stream. The `id`
 * comparison is display-level echo suppression, not authentication — identity
 * belongs to the server. Sending tracks the full subscription lifecycle (via
 * the shared confirmation-aware subscription): beacons — heartbeats, the
 * convergence answer, the leaving notice — are dropped before confirmation and
 * while the connection is down, where Action Cable would discard them anyway
 * (and a discarded beacon must not burn the convergence throttle); `connected`
 * re-fires on every reconnect and force-beacons, so the roster self-heals. A
 * refused subscription publishes the `data-presence-rejected` hook (cleared on
 * `connect()` — rejection is transient server state), mirroring
 * `data-live-counter-rejected`. Presence is transient: `connect()` clears
 * whatever a Turbo cache snapshot preserved (hooks + rendered clones), renders
 * the known-empty count (the `data-present*` hooks stay absent until the first
 * beacon), and the stream re-populates; the subscription, heartbeat interval,
 * per-peer expiry timers, and the `pagehide` listener are all released on
 * `disconnect()` (Turbo navigation included).
 */
export class PresenceController extends Controller<HTMLElement> {
  static override targets = ["count", "list", "template"];
  static override values = {
    channel: { type: String, default: "" },
    params: { type: Object, default: {} },
    id: { type: String, default: "" },
    name: { type: String, default: "" },
    heartbeat: { type: Number, default: 15_000 },
    timeout: { type: Number, default: 40_000 },
  };
  static events = ["join", "leave", "change"] as const;

  declare readonly hasCountTarget: boolean;
  declare readonly countTarget: HTMLElement;
  declare readonly hasListTarget: boolean;
  declare readonly listTarget: HTMLElement;
  declare readonly hasTemplateTarget: boolean;
  declare readonly templateTarget: HTMLTemplateElement;
  declare channelValue: string;
  declare paramsValue: Record<string, unknown>;
  declare idValue: string;
  declare nameValue: string;
  declare heartbeatValue: number;
  declare timeoutValue: number;

  #subscription: ConfirmedCableSubscription | null = null;
  /** Present peers keyed by id (insertion order = join order). */
  readonly #peers = new Map<string, Peer>();
  readonly #timers = new SafeTimeout();
  readonly #intervals = new SafeInterval();
  /** Epoch ms of the last outgoing beacon, for the convergence throttle. */
  #lastBeaconAt = 0;
  /** Pending trailing-edge convergence beacon (at most one queued). */
  #pendingBeacon: number | null = null;

  override connect(): void {
    // Presence is transient: drop whatever a Turbo cache snapshot preserved
    // (hooks + rendered clones); the live stream re-populates the roster.
    // Rejection is transient server state too — the fresh subscription below
    // re-decides the hook.
    this.#reset();
    this.element.removeAttribute("data-presence-rejected");
    // The roster is known-empty here, so the count target can say so right
    // away instead of sitting blank until the first roster change. The
    // data-present* hooks intentionally stay absent until the first beacon.
    if (this.hasCountTarget) this.countTarget.textContent = this.#countMessage(0);

    if (!this.channelValue) return;
    this.#subscription = createConfirmedSubscription(
      { channel: this.channelValue, ...this.paramsValue },
      {
        // The first beacon must wait for the confirmed subscription — a
        // perform() before that is silently dropped by Action Cable. Fires
        // again on every reconnect, so the roster self-heals after an outage.
        connected: () => this.#beacon(true),
        // The server refused the subscription: no beacon will ever go through,
        // and the hook lets the consumer's CSS reflect the dead stream.
        rejected: () => {
          this.element.setAttribute("data-presence-rejected", "true");
        },
        received: (data: unknown) => this.#onReceived(data),
      },
    );
    this.#intervals.set(() => this.#beacon(true), this.heartbeatValue);
    window.addEventListener("pagehide", this.#onPageHide);
  }

  override disconnect(): void {
    window.removeEventListener("pagehide", this.#onPageHide);
    // Best-effort graceful leave; a lost notice is caught by peers' expiry
    // timers instead.
    this.#sendLeaveNotice();
    this.#subscription?.unsubscribe();
    this.#subscription = null;
    this.#intervals.clearAll();
    this.#reset();
    this.element.removeAttribute("data-presence-rejected");
  }

  /**
   * Sends the best-effort leaving notice (skipped without an own `id`, and
   * outside the confirmed window, where Action Cable would discard it anyway).
   */
  #sendLeaveNotice(): void {
    if (!this.#subscription?.confirmed || !this.idValue) return;
    this.#subscription.perform("appear", { id: this.idValue, leaving: true });
  }

  /**
   * `pagehide` covers the leaves `disconnect()` cannot see: closing the tab or
   * a hard (non-Turbo) navigation destroys the page without running Stimulus
   * teardown, so this listener is the only chance to announce them. Best-effort
   * by nature (the socket may close before the frame flushes); peers' expiry
   * timers stay the safety net. If the page enters the bfcache and is restored
   * instead, the next heartbeat re-announces this client, so an over-eager
   * leave self-heals.
   */
  readonly #onPageHide = (): void => {
    this.#sendLeaveNotice();
  };

  /**
   * Broadcasts this client's beacon (skipped without an own `id`). A throttled
   * convergence answer is deferred to the trailing edge rather than dropped —
   * otherwise a peer joining right after a heartbeat would not learn about
   * this client until the next full heartbeat period.
   *
   * Gated on the confirmed subscription: before confirmation and during an
   * outage Action Cable silently discards perform(), so a beacon sent then is
   * pure waste — worse, it would burn `#lastBeaconAt` and delay the next real
   * convergence answer by up to the throttle window. The heartbeat interval
   * keeps ticking regardless; `connected` re-fires on reconfirm and
   * force-beacons immediately, so a gated tick is never missed for long.
   */
  #beacon(force: boolean): void {
    if (!this.#subscription?.confirmed || !this.idValue) return;
    const now = Date.now();
    const wait = BEACON_THROTTLE_MS - (now - this.#lastBeaconAt);
    if (!force && wait > 0) {
      if (this.#pendingBeacon === null) {
        this.#pendingBeacon = this.#timers.set(() => {
          this.#pendingBeacon = null;
          this.#beacon(true);
        }, wait);
      }
      return;
    }
    this.#lastBeaconAt = now;
    this.#subscription.perform("appear", { id: this.idValue, name: this.nameValue });
  }

  /**
   * Tracks a broadcast beacon: upserts the peer (restarting its expiry timer),
   * removes it on a `leaving` notice, and re-announces this client when the
   * peer was unknown (roster convergence — see the class doc).
   */
  #onReceived(data: unknown): void {
    const beacon = data as { id?: unknown; name?: unknown; leaving?: unknown } | null;
    const id = beacon?.id;
    if (typeof id !== "string" || id === "" || id === this.idValue) return;

    if (beacon?.leaving === true) {
      this.#drop(id);
      return;
    }

    const name = typeof beacon?.name === "string" ? beacon.name : "";
    const existing = this.#peers.get(id);
    if (existing !== undefined) this.#timers.clear(existing.timer);
    const timer = this.#timers.set(() => this.#drop(id), this.timeoutValue);
    this.#peers.set(id, { name, timer });

    if (existing === undefined) {
      this.#appendClone(id, name);
      this.#render();
      this.dispatch("join", { detail: { id, name } });
      this.#beacon(false); // answer an unknown peer so its roster converges
    } else if (existing.name !== name) {
      this.#updateClone(id, name);
      this.#render();
    }
  }

  /** Removes a peer (expiry or graceful leave) and reflects the change. */
  #drop(id: string): void {
    const peer = this.#peers.get(id);
    if (peer === undefined) return;
    this.#timers.clear(peer.timer);
    this.#peers.delete(id);
    this.#removeClone(id);
    this.#render();
    this.dispatch("leave", { detail: { id } });
  }

  /** Reflects the roster onto the hooks + count target and emits `change`. */
  #render(): void {
    const users = [...this.#peers.entries()].map(([id, peer]) => ({ id, name: peer.name }));
    this.element.setAttribute("data-present", users.length > 0 ? "true" : "false");
    this.element.setAttribute("data-present-count", String(users.length));
    if (this.hasCountTarget) this.countTarget.textContent = this.#countMessage(users.length);
    this.dispatch("change", { detail: { users } });
  }

  /**
   * Builds the count copy. Localizable through `data-zero` / `data-one` /
   * `data-other` templates on the count target (`%{count}`); the bare number is
   * the fallback (copy-free, so nothing to localize by default).
   */
  #countMessage(count: number): string {
    const templates = this.countTarget.dataset;
    const template =
      (count === 0 ? templates.zero : count === 1 ? templates.one : templates.other) ??
      templates.other;
    return template ? template.replace("%{count}", String(count)) : String(count);
  }

  /** Appends one template clone for a newly present peer (list + template only). */
  #appendClone(id: string, name: string): void {
    if (!this.hasListTarget || !this.hasTemplateTarget) return;
    const clone = this.templateTarget.content.cloneNode(true) as DocumentFragment;
    const root = clone.firstElementChild;
    if (!root) return;
    root.setAttribute("data-presence-id", id);
    this.#fillName(root, name);
    this.listTarget.appendChild(clone);
  }

  #updateClone(id: string, name: string): void {
    const root = this.#cloneFor(id);
    if (root) this.#fillName(root, name);
  }

  #removeClone(id: string): void {
    this.#cloneFor(id)?.remove();
  }

  #cloneFor(id: string): Element | null {
    if (!this.hasListTarget) return null;
    // Attribute selectors cannot escape arbitrary ids reliably; match manually.
    for (const child of this.listTarget.querySelectorAll("[data-presence-id]")) {
      if (child.getAttribute("data-presence-id") === id) return child;
    }
    return null;
  }

  /** Writes the peer's name into the clone's `data-presence-name` slots. */
  #fillName(root: Element, name: string): void {
    const slots = root.querySelectorAll("[data-presence-name]");
    for (const slot of slots) slot.textContent = name;
    if (slots.length === 0 && root.hasAttribute("data-presence-name")) {
      root.textContent = name;
    }
  }

  /** Clears the transient roster state (connect reset + disconnect teardown). */
  #reset(): void {
    this.#timers.clearAll();
    this.#pendingBeacon = null;
    this.#peers.clear();
    this.#lastBeaconAt = 0;
    this.element.removeAttribute("data-present");
    this.element.removeAttribute("data-present-count");
    if (this.hasCountTarget) this.countTarget.textContent = "";
    if (this.hasListTarget) {
      for (const child of this.listTarget.querySelectorAll("[data-presence-id]")) {
        child.remove();
      }
    }
  }
}
