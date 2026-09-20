import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { KeyedTimers } from "../utils/keyed_timers";
import { MAX_TIMER_DELAY_MS, SafeInterval, SafeTimeout } from "../utils/safe_timeout";
import {
  type ConfirmedCableSubscription,
  createConfirmedSubscription,
  identifierOf,
  parseSubscriptionParams,
} from "./consumer";

/** A peer currently present (another client in the same room). */
interface Peer {
  name: string;
}

/**
 * Minimum ms between outgoing beacons. The steady state is the `heartbeat`
 * interval; this guard only bounds the *extra* beacons sent in response to
 * newly seen peers (see the roster-convergence note in the class doc), so a
 * burst of joiners cannot make this client flood the channel.
 */
const BEACON_THROTTLE_MS = 2000;

/** Heartbeat period used when the declared one names no interval. */
const DEFAULT_HEARTBEAT_MS = 15_000;

/** Peer expiry used when the declared one names no delay. */
const DEFAULT_TIMEOUT_MS = 40_000;

/**
 * How many connected controllers currently speak for each peer, keyed by the
 * channel identifier and the peer's own id.
 *
 * The leaving notice says that a *peer* is gone, so only the last element
 * claiming that peer may send it. The shared subscription counts the members of
 * a wire identifier, which is a different set: elements claiming other ids —
 * and the other cable controllers — ride the same wire, and letting them speak
 * for this peer would either drop a peer that is still here or keep a departed
 * one in every roster until it expires.
 */
const speakers = new Map<string, number>();

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
 * The notice speaks for a *peer*, not for a wire subscription: on `disconnect()`
 * only the last element claiming a given `id` on a given identifier sends it, so a
 * sibling that stays mounted keeps the peer in every roster. `pagehide` takes the
 * whole page with it, so there every element sends and peers absorb the duplicates.
 *
 * Roster convergence: a late joiner would otherwise see peers only as their
 * next heartbeats arrive, so on hearing a beacon from an *unknown* peer, each
 * client re-announces itself (at most one such answer every 2s) — the
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
 * `join` dispatches `{ id, name }`; `leave` dispatches `{ id }`; `change` dispatches
 * `{ users }`.
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
 * `leave` / `change` events or a server-rendered Turbo Stream. A `template` holds
 * one root element: the clone appended for a peer, and the node removed when the
 * peer goes, are that same element. Roster changes reach assistive tech only when
 * the consumer opts in through `announceJoinText` / `announceLeaveText` — reading
 * out every entry and exit of a busy room is noise, so silence is the default. The `id`
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
 * beacon), and the stream re-populates; a `count` or `list` target swapped in by a
 * Stream or a morph arrives empty and is drawn from the roster as it connects; the subscription, heartbeat interval,
 * per-peer expiry timers, and the `pagehide` listener are all released on
 * `disconnect()` (Turbo navigation included).
 */
export class PresenceController extends Controller<HTMLElement> {
  static override targets = ["count", "list", "template"];
  static override values = {
    channel: { type: String, default: "" },
    params: { type: String, default: "" },
    id: { type: String, default: "" },
    name: { type: String, default: "" },
    heartbeat: { type: Number, default: DEFAULT_HEARTBEAT_MS },
    timeout: { type: Number, default: DEFAULT_TIMEOUT_MS },
    announceJoinText: { type: String, default: "" },
    announceLeaveText: { type: String, default: "" },
  };
  static events = ["join", "leave", "change"] as const;

  declare readonly hasCountTarget: boolean;
  declare readonly countTarget: HTMLElement;
  declare readonly hasListTarget: boolean;
  declare readonly listTarget: HTMLElement;
  declare readonly hasTemplateTarget: boolean;
  declare readonly templateTarget: HTMLTemplateElement;
  declare channelValue: string;
  declare paramsValue: string;
  declare idValue: string;
  declare nameValue: string;
  declare heartbeatValue: number;
  declare timeoutValue: number;
  declare announceJoinTextValue: string;
  declare announceLeaveTextValue: string;

  /** Delay (ms) before one roster change is sent to the shared announcer. */
  static readonly #announceDelay = 200;

  /** Identifier parameters parsed once from their declaration, never in the hot path. */
  #params: Record<string, unknown> = {};

  #subscription: ConfirmedCableSubscription | null = null;
  /** Present peers keyed by id (insertion order = join order). */
  readonly #peers = new Map<string, Peer>();
  /** Each peer's auto-expiry timer, restarted by every beacon from that peer. */
  readonly #expiry = new KeyedTimers<string>();
  readonly #timers = new SafeTimeout();
  readonly #intervals = new SafeInterval();
  /** Epoch ms of the last outgoing beacon, for the convergence throttle. */
  #lastBeaconAt = 0;
  /** Pending trailing-edge convergence beacon (at most one queued). */
  #pendingBeacon: number | null = null;
  /** The one outstanding announcement, so a newer roster change supersedes it. */
  #announceId: number | null = null;
  /** The `speakers` key this element holds, recomputed on every `connect()`. */
  #speakerKey = "";

  /**
   * Re-parses the identifier parameters when the declaration changes.
   *
   * A malformed declaration falls back to no parameters, so the identifier keeps
   * naming the channel instead of the subscription never being created at all.
   */
  paramsValueChanged(): void {
    this.#params = parseSubscriptionParams(this.paramsValue);
  }

  /**
   * The identifier this declaration names. `params` *adds* to the identifier, so a
   * `channel` key inside it names an extra parameter and never replaces the channel
   * the element declares.
   */
  get #descriptor(): Record<string, unknown> {
    const { channel: _declared, ...rest } = this.#params;
    return { channel: this.channelValue, ...rest };
  }

  /**
   * The beacon period, in ms: a finite, positive number a timer can hold. Anything
   * else names no interval — `setInterval` reads `NaN`, a negative value, `Infinity`
   * and a value past {@link MAX_TIMER_DELAY_MS} alike as "as often as possible", so
   * the declaration would flood the channel rather than heartbeat on it. Zero is out
   * for the same reason, which is why this bound is tighter than the non-negative one
   * a throttle or a plain delay can use. Such a declaration falls back to the default.
   */
  get #heartbeat(): number {
    const declared = this.heartbeatValue;
    return Number.isFinite(declared) && declared > 0 && declared <= MAX_TIMER_DELAY_MS
      ? declared
      : DEFAULT_HEARTBEAT_MS;
  }

  /**
   * The silence after which a peer is dropped, in ms: a finite, positive number a
   * timer can hold. Anything else names no delay and every peer expires in the task
   * that records it, so the roster could never hold anyone. Such a declaration falls
   * back to the default.
   */
  get #timeout(): number {
    const declared = this.timeoutValue;
    return Number.isFinite(declared) && declared > 0 && declared <= MAX_TIMER_DELAY_MS
      ? declared
      : DEFAULT_TIMEOUT_MS;
  }

  /**
   * Draws the roster into a list target, which arrives empty from a Turbo Stream
   * replacement or a morph. Stimulus runs this before `connect()` on the first mount
   * too, where the roster is still empty and clearing whatever a cache snapshot
   * preserved is what `connect()` goes on to do anyway.
   */
  listTargetConnected(): void {
    for (const child of this.listTarget.querySelectorAll("[data-presence-id]")) {
      child.remove();
    }
    for (const [id, peer] of this.#peers) this.#appendClone(id, peer.name);
  }

  /** Paints the roster size into a count target that arrives blank, for the same reason. */
  countTargetConnected(): void {
    this.countTarget.textContent = this.#countMessage(this.#peers.size);
  }

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
    this.#claimSpeaker();
    this.#subscription = createConfirmedSubscription(this.#descriptor, {
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
    });
    this.#intervals.set(() => this.#beacon(true), this.#heartbeat);
    window.addEventListener("pagehide", this.#onPageHide);
  }

  override disconnect(): void {
    window.removeEventListener("pagehide", this.#onPageHide);
    // Best-effort graceful leave, and only from the last element speaking for
    // this peer; a lost notice is caught by peers' expiry timers instead.
    if (this.#releaseSpeaker()) this.#sendLeaveNotice();
    this.#subscription?.unsubscribe();
    this.#subscription = null;
    this.#intervals.clearAll();
    this.#reset();
    this.element.removeAttribute("data-presence-rejected");
  }

  /**
   * Registers this element as one of the voices for its peer, so a sibling on the
   * same channel claiming the same `id` keeps the peer present until they all go.
   * Whether the peer is worth announcing at all is {@link #sendLeaveNotice}'s
   * question, so an element with no own `id` claims a voice like any other and is
   * simply never heard.
   */
  #claimSpeaker(): void {
    this.#speakerKey = `${identifierOf(this.#descriptor)}\n${this.idValue}`;
    speakers.set(this.#speakerKey, (speakers.get(this.#speakerKey) ?? 0) + 1);
  }

  /**
   * Gives up the claim, reporting whether this element was the last voice for the
   * peer. The key is spent here: an element that goes on to connect without a
   * channel claims nothing, and a stale key would spend a voice its siblings own.
   */
  #releaseSpeaker(): boolean {
    const key = this.#speakerKey;
    this.#speakerKey = "";
    const remaining = (speakers.get(key) ?? 1) - 1;
    if (remaining > 0) speakers.set(key, remaining);
    else speakers.delete(key);
    return remaining <= 0;
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
    this.#expiry.set(id, () => this.#drop(id), this.#timeout);
    this.#peers.set(id, { name });

    if (existing === undefined) {
      this.#appendClone(id, name);
      this.#render();
      this.#announce(this.announceJoinTextValue, name);
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
    this.#expiry.clear(id);
    this.#peers.delete(id);
    this.#removeClone(id);
    this.#render();
    this.#announce(this.announceLeaveTextValue, peer.name);
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
   * Hands one roster change to the page's shared announcer.
   *
   * Debounced: a burst of arrivals is one announcement, not one per peer — reading
   * out every entry and exit of a busy room is the noise the default avoids. Wording
   * comes from the consumer (`{name}` / `{count}`, where the count is the roster
   * after the change), and an undeclared template does nothing at all — not even
   * cancel an announcement already pending for the other direction.
   */
  #announce(template: string, name: string): void {
    const message = fillTemplate(template, { name, count: this.#peers.size });
    if (message.trim() === "") return;
    if (this.#announceId !== null) this.#timers.clear(this.#announceId);
    this.#announceId = this.#timers.set(() => {
      announce(message);
      this.#announceId = null;
    }, PresenceController.#announceDelay);
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
    const root = this.templateTarget.content.firstElementChild?.cloneNode(true);
    if (!(root instanceof Element)) return;
    root.setAttribute("data-presence-id", id);
    this.#fillName(root, name);
    this.listTarget.appendChild(root);
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
    this.#expiry.clearAll();
    this.#pendingBeacon = null;
    this.#announceId = null;
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
