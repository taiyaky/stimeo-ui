import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";
import { type ConfirmedCableSubscription, createConfirmedSubscription } from "./consumer";

/**
 * Headless **typing indicator** — the first *server-bound* behavior: a
 * controller whose state lives on the server stream, not in client
 * memory. Typing in the composer throttle-broadcasts a `typing` signal over an
 * Action Cable channel; received signals from *other* clients render "X is
 * typing…" into a `status` live region and auto-clear after `timeout` ms of
 * silence. The whole behavior is HTML + a broadcast — no app JS, no client
 * store, no reconciler. Ships in the opt-in `stimeo-ui/cable` subpath
 * (`@rails/actioncable` optional peer); the core stays zero-dep.
 *
 * Markup contract (identifier: `stimeo--typing-indicator`):
 *   <div data-controller="stimeo--typing-indicator"
 *        data-stimeo--typing-indicator-channel-value="TypingChannel"
 *        data-stimeo--typing-indicator-params-value='{"room":"chat_42"}'
 *        data-stimeo--typing-indicator-name-value="Alice">
 *     <textarea data-stimeo--typing-indicator-target="input"></textarea>
 *     <p role="status" data-stimeo--typing-indicator-target="status"
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
 * `connect()` resets the hook and the live region (a Turbo cache snapshot must
 * not resurrect a stale "X is typing…"), and re-population happens naturally
 * from the stream. The subscription, the per-typer timers, and the delegated
 * `input` listener are all released on `disconnect()` (Turbo navigation
 * included).
 */
export class TypingIndicatorController extends Controller<HTMLElement> {
  static override targets = ["input", "status"];
  static override values = {
    channel: { type: String, default: "" },
    params: { type: Object, default: {} },
    name: { type: String, default: "" },
    timeout: { type: Number, default: 3000 },
    // Must stay below `timeout`: the throttle is leading-edge only (no trailing
    // send), so a receiver's display survives continuous typing only while a
    // fresh signal lands within its timeout window.
    throttle: { type: Number, default: 2000 },
  };
  static events = ["change"] as const;

  declare readonly hasStatusTarget: boolean;
  declare readonly statusTarget: HTMLElement;
  declare channelValue: string;
  declare paramsValue: Record<string, unknown>;
  declare nameValue: string;
  declare timeoutValue: number;
  declare throttleValue: number;

  #subscription: ConfirmedCableSubscription | null = null;
  /** Names currently typing (other clients), each with its auto-clear timer id. */
  readonly #typers = new Map<string, number>();
  readonly #timers = new SafeTimeout();
  /** Epoch ms of the last broadcast, for leading-edge throttling. */
  #lastSentAt = 0;

  override connect(): void {
    // Typing state is transient: a Turbo cache snapshot must not resurrect a
    // stale indicator, and the live stream re-populates naturally. Rejection is
    // transient server state too — the fresh subscription re-decides the hook.
    this.element.removeAttribute("data-typing");
    this.element.removeAttribute("data-typing-indicator-rejected");
    if (this.hasStatusTarget) this.statusTarget.textContent = "";

    // Delegated on the container so the composer needs no per-input data-action
    // (and swapped/appended inputs keep working — lifecycle Rule A′).
    this.element.addEventListener("input", this.#onInput);
    if (this.channelValue) {
      // Confirmation tracking (connected / disconnected / rejected) lives in
      // the shared subscription; #onInput gates on its `confirmed` so an
      // outage doesn't burn the throttle window on dropped sends.
      this.#subscription = createConfirmedSubscription(
        { channel: this.channelValue, ...this.paramsValue },
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
    if (now - this.#lastSentAt < this.throttleValue) return;
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
      this.#timers.set(() => this.#untrack(name), this.timeoutValue),
    );
    if (added) this.#render();
  }

  #untrack(name: string): void {
    this.#typers.delete(name);
    this.#render();
  }

  /** Reflects the typer set onto the hook + live region and emits `change`. */
  #render(): void {
    const names = [...this.#typers.keys()];
    this.element.setAttribute("data-typing", names.length > 0 ? "true" : "false");
    if (this.hasStatusTarget) {
      this.statusTarget.textContent = this.#message(names);
    }
    this.dispatch("change", { detail: { names } });
  }

  /**
   * Builds the live-region copy. Localizable through `data-one` / `data-many`
   * templates on the status target (`%{name}` / `%{names}` / `%{count}`); terse
   * English is the fallback.
   */
  #message(names: string[]): string {
    if (names.length === 0) return "";
    const joined = names.join(", ");
    if (names.length === 1) {
      const template = this.statusTarget.dataset.one;
      const name = names[0] ?? "";
      return template ? template.replace("%{name}", name) : `${name} is typing…`;
    }
    const template = this.statusTarget.dataset.many;
    return template
      ? template.replace("%{names}", joined).replace("%{count}", String(names.length))
      : `${joined} are typing…`;
  }
}
