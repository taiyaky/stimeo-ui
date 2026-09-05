import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { SafeTimeout } from "../utils/safe_timeout";
import {
  type ConfirmedCableSubscription,
  createConfirmedSubscription,
  parseSubscriptionParams,
} from "./consumer";

/** Milliseconds of silence after which a typer is dropped. */
const DEFAULT_TIMEOUT = 3000;
/** Minimum milliseconds between outgoing typing signals. */
const DEFAULT_THROTTLE = 2000;

/**
 * Fills `%{token}` placeholders in a status template, in one pass.
 *
 * The values come off the wire — another client's display name — so they must never
 * reach a replacement *string*, where `$&`, `` $` ``, `$'` and `$$` expand into the
 * template's own text. A single pass also stops a name that happens to contain a token
 * from being re-substituted by a later one. Every occurrence is filled; a token this
 * call has no value for is left as authored, which keeps a typo visible instead of
 * blanking the word.
 */
const fillTokens = (template: string, values: Record<string, string>): string =>
  template.replace(/%\{(name|names|count)\}/g, (match, token: string) => values[token] ?? match);

/**
 * Headless **typing indicator** — a *server-bound* behavior: a controller whose
 * state lives on the server stream, not in client memory. Typing in the composer
 * throttle-broadcasts a `typing` signal over an Action Cable channel; received
 * signals from *other* clients render "X is typing…" into a visible `status` slot
 * and auto-clear after `timeout` ms of silence. The whole behavior is HTML + a
 * broadcast — no app JS, no client store, no reconciler. Ships in the opt-in
 * `stimeo-ui/cable` subpath (`@rails/actioncable` optional peer); the core stays
 * zero-dep.
 *
 * Markup contract (identifier: `stimeo--typing-indicator`):
 *   <div data-controller="stimeo--typing-indicator"
 *        data-stimeo--typing-indicator-channel-value="TypingChannel"
 *        data-stimeo--typing-indicator-params-value='{"room":"chat_42"}'
 *        data-stimeo--typing-indicator-name-value="Alice"
 *        data-stimeo--typing-indicator-announce-one-text-value="{name} is typing">
 *     <textarea data-stimeo--typing-indicator-target="input"></textarea>
 *     <p data-stimeo--typing-indicator-target="status"
 *        data-one="%{name} is typing…" data-many="%{names} are typing…"></p>
 *   </div>
 *
 * Server contract (a trivial rebroadcast channel):
 *   class TypingChannel < ApplicationCable::Channel
 *     def subscribed = stream_from "typing:#{params[:room]}"
 *     def typing(data) = ActionCable.server.broadcast("typing:#{params[:room]}",
 *                                                     { name: data["name"] })
 *   end
 *
 * The `status` target is a plain visible slot, not a live region: assistive tech is
 * reached through the page's shared announcer instead, so a set that settles is sent
 * there as `announceOneText` / `announceManyText` (`{name}` / `{names}` / `{count}`,
 * debounced). Both default to empty, and an empty message announces nothing — a page
 * that wants the indicator seen but not heard simply leaves them off.
 *
 * `change` dispatches `{ names }`.
 *
 * @remarks
 * Behavior only — the indicator's look is the consumer's CSS, keyed off the
 * `data-typing` hook; the copy is localizable through the `data-one` /
 * `data-many` templates (`%{name}` / `%{names}` / `%{count}`, terse English
 * fallback — the same channel design as `stimeo--sortable`). The own echo is
 * dropped by comparing the broadcast `name` against `name` (a same-name guard,
 * not authentication — identity belongs to the server). Sending tracks the full
 * subscription lifecycle (via the shared confirmation-aware subscription):
 * signals are dropped before confirmation and while the connection is down, so
 * an outage never burns the throttle window on undeliverable sends. A refused
 * subscription publishes the `data-typing-indicator-rejected` hook (cleared on
 * `connect()` — rejection is transient server state), mirroring
 * `data-live-counter-rejected`. Typing state is transient by nature:
 * `connect()` resets the hook and the status slot (a Turbo cache snapshot must
 * not resurrect a stale "X is typing…"), and re-population happens naturally
 * from the stream. The subscription, the per-typer timers, and the delegated
 * `input` listener are all released on `disconnect()` (Turbo navigation
 * included).
 */
export class TypingIndicatorController extends Controller<HTMLElement> {
  static override targets = ["input", "status"];
  static override values = {
    channel: { type: String, default: "" },
    params: { type: String, default: "" },
    name: { type: String, default: "" },
    timeout: { type: Number, default: DEFAULT_TIMEOUT },
    // Must stay below `timeout`: the throttle is leading-edge only (no trailing
    // send), so a receiver's display survives continuous typing only while a
    // fresh signal lands within its timeout window.
    throttle: { type: Number, default: DEFAULT_THROTTLE },
    announceOneText: { type: String, default: "" },
    announceManyText: { type: String, default: "" },
  };
  static events = ["change"] as const;

  declare readonly hasStatusTarget: boolean;
  declare readonly statusTarget: HTMLElement;
  declare channelValue: string;
  declare paramsValue: string;
  declare nameValue: string;
  declare timeoutValue: number;
  declare throttleValue: number;
  declare announceOneTextValue: string;
  declare announceManyTextValue: string;

  /** Delay (ms) before one settled typer set is sent to the shared announcer. */
  static readonly #announceDelay = 200;

  /** Identifier parameters parsed once from their declaration, never in the hot path. */
  #params: Record<string, unknown> = {};

  #subscription: ConfirmedCableSubscription | null = null;
  /** Names currently typing (other clients), each with its auto-clear timer id. */
  readonly #typers = new Map<string, number>();
  readonly #timers = new SafeTimeout();
  /** Epoch ms of the last broadcast, for leading-edge throttling. */
  #lastSentAt = 0;
  /** The one outstanding announcement, so a newer set supersedes it. */
  #announceId: number | null = null;

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
   * Paints the current copy into a `status` target that arrived at runtime.
   *
   * No event: the set of typers did not change, only the element that displays it.
   * Without this a region swapped in mid-conversation stays empty while `data-typing`
   * still says someone is typing, leaving the state in the visual hook alone. An empty
   * set needs no paint — a fresh region already shows it.
   */
  statusTargetConnected(): void {
    if (this.#typers.size > 0) this.#paint();
  }

  override connect(): void {
    // Typing state is transient: a Turbo cache snapshot must not resurrect a
    // stale indicator, and the live stream re-populates naturally. Rejection is
    // transient server state too — the fresh subscription re-decides the hook.
    this.element.removeAttribute("data-typing");
    this.element.removeAttribute("data-typing-indicator-rejected");
    if (this.hasStatusTarget) this.statusTarget.textContent = "";

    // Delegated on the container so the composer needs no per-input data-action
    // (and swapped/appended inputs keep working).
    this.element.addEventListener("input", this.#onInput);
    if (this.channelValue) {
      // Confirmation tracking (connected / disconnected / rejected) lives in
      // the shared subscription; #onInput gates on its `confirmed` so an
      // outage doesn't burn the throttle window on dropped sends.
      this.#subscription = createConfirmedSubscription(
        { channel: this.channelValue, ...this.#params },
        {
          // The server refused the subscription: the send gate stays shut for
          // good, and the hook lets the consumer's CSS reflect the dead stream.
          rejected: () => {
            this.element.setAttribute("data-typing-indicator-rejected", "true");
          },
          received: (data: unknown) => this.#onReceived(data),
        },
      );
    }
  }

  override disconnect(): void {
    this.element.removeEventListener("input", this.#onInput);
    this.#subscription?.unsubscribe();
    this.#subscription = null;
    this.#timers.clearAll();
    this.#announceId = null;
    this.#typers.clear();
    this.element.removeAttribute("data-typing");
    this.element.removeAttribute("data-typing-indicator-rejected");
    if (this.hasStatusTarget) this.statusTarget.textContent = "";
    this.#lastSentAt = 0;
  }

  /** Throttled (leading-edge) broadcast of this client's typing signal. */
  readonly #onInput = (): void => {
    // Before the confirmed subscription a perform() is silently dropped by
    // Action Cable — and recording #lastSentAt would ALSO throttle away the
    // first real send, so bail without touching the throttle state.
    if (!this.#subscription?.confirmed) return;
    const now = Date.now();
    if (now - this.#lastSentAt < this.#throttle) return;
    this.#lastSentAt = now;
    this.#subscription.perform("typing", { name: this.nameValue });
  };

  /**
   * Tracks a broadcast typer. The own echo is dropped (same `name`); every
   * further signal from a name restarts its auto-clear timer, so the indicator
   * survives continuous typing and clears `timeout` ms after the last signal.
   */
  #onReceived(data: unknown): void {
    const name = (data as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || name === "" || name === this.nameValue) return;

    const existing = this.#typers.get(name);
    if (existing !== undefined) this.#timers.clear(existing);
    const added = existing === undefined;
    this.#typers.set(
      name,
      this.#timers.set(() => this.#untrack(name), this.#timeout),
    );
    if (added) this.#render();
  }

  /**
   * The silence after which a typer is dropped, in ms: a finite, non-negative number.
   * Anything else names no delay — `setTimeout` reads `NaN`, a negative value and
   * `Infinity` alike as "now", so the typer would vanish in the same task it appeared
   * and the indicator could never be seen. Such a declaration falls back to the default.
   */
  get #timeout(): number {
    const declared = this.timeoutValue;
    return Number.isFinite(declared) && declared >= 0 ? declared : DEFAULT_TIMEOUT;
  }

  /**
   * The minimum gap between outgoing signals, in ms: a finite, non-negative number.
   * Anything else names no interval, and the gate then settles the same way at every
   * keystroke — `NaN` and a negative gap leave it open, so every keystroke broadcasts,
   * while `Infinity` is never exceeded, so nothing is ever sent. Such a declaration
   * falls back to the default.
   */
  get #throttle(): number {
    const declared = this.throttleValue;
    return Number.isFinite(declared) && declared >= 0 ? declared : DEFAULT_THROTTLE;
  }

  #untrack(name: string): void {
    this.#typers.delete(name);
    this.#render();
  }

  /** Reflects the typer set onto the display, announces it, and emits `change`. */
  #render(): void {
    const names = this.#paint();
    this.#announce(names);
    this.dispatch("change", { detail: { names } });
  }

  /**
   * Hands the settled typer set to the page's shared announcer.
   *
   * Debounced: a burst of arrivals is one announcement, not one per name. Only a
   * non-empty set is announced — that typing stopped is not news worth interrupting
   * a reader for, and the visible copy already clears. Wording comes from the
   * consumer, and {@link announce} drops an empty message, so an undeclared template
   * announces nothing at all.
   */
  #announce(names: string[]): void {
    if (this.#announceId !== null) this.#timers.clear(this.#announceId);
    this.#announceId = null;
    if (names.length === 0) return;

    const message =
      names.length === 1
        ? fillTemplate(this.announceOneTextValue, { name: names[0] ?? "" })
        : fillTemplate(this.announceManyTextValue, {
            names: names.join(", "),
            count: names.length,
          });

    this.#announceId = this.#timers.set(() => {
      announce(message);
      this.#announceId = null;
    }, TypingIndicatorController.#announceDelay);
  }

  /** Writes the current typer set onto the hook and the status slot. */
  #paint(): string[] {
    const names = [...this.#typers.keys()];
    this.element.setAttribute("data-typing", names.length > 0 ? "true" : "false");
    if (this.hasStatusTarget) {
      this.statusTarget.textContent = this.#message(names);
    }
    return names;
  }

  /**
   * Builds the status copy. Localizable through `data-one` / `data-many`
   * templates on the status target (`%{name}` / `%{names}` / `%{count}`); terse
   * English is the fallback.
   */
  #message(names: string[]): string {
    if (names.length === 0) return "";
    const joined = names.join(", ");
    if (names.length === 1) {
      const template = this.statusTarget.dataset.one;
      const name = names[0] ?? "";
      return template ? fillTokens(template, { name }) : `${name} is typing…`;
    }
    const template = this.statusTarget.dataset.many;
    return template
      ? fillTokens(template, { names: joined, count: String(names.length) })
      : `${joined} are typing…`;
  }
}
