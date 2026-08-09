import { Controller } from "@hotwired/stimulus";
import { type ConfirmedCableSubscription, createConfirmedSubscription } from "./consumer";

/**
 * Marker on triggers this controller disabled (mirroring submit-once's
 * marker): `disabled` is a shared attribute, so only marked ones are ever
 * re-enabled — an authored-disabled trigger stays untouched.
 */
const DISABLED_MARKER = "data-live-counter-disabled";

/**
 * Headless **live counter** — a *server-bound* behavior: a number bound to an
 * Action Cable stream (likes, views, active users) that ticks across every
 * connected client. A local action applies an **optimistic** increment
 * immediately, then reconciles with the broadcast; the own echo of a delta
 * broadcast is deduped so the increment is never applied twice. Ships in the
 * opt-in `stimeo-ui/cable` subpath (`@rails/actioncable` optional peer).
 *
 * Markup contract (identifier: `stimeo--live-counter`):
 *   <div data-controller="stimeo--live-counter"
 *        data-stimeo--live-counter-channel-value="LikesChannel"
 *        data-stimeo--live-counter-params-value='{"post":42}'
 *        data-stimeo--live-counter-id-value="<%= SecureRandom.uuid %>">
 *     <span data-stimeo--live-counter-target="value">128</span>
 *     <button type="button" data-action="stimeo--live-counter#increment"
 *             data-stimeo--live-counter-target="trigger">♥</button>
 *   </div>
 *
 * Wire contract — the broadcast is either **authoritative** or a **delta**:
 * `{ count: 129 }` sets the absolute value (naturally idempotent; preferred —
 * the server owns the number), while `{ delta: 1, by: "17" }` adds to it,
 * skipped when `by` matches this client's `id` (the optimistic increment
 * already applied it). `increment` performs `increment` on the channel with
 * `{ id, delta }`; the server persists and broadcasts. Without an own `id`
 * the delta echo is indistinguishable from a foreign delta, so the optimistic
 * bump is skipped and the broadcast applies the increment exactly once — set
 * `id` (any per-client string, e.g. `SecureRandom.uuid`) for optimistic UX.
 *
 * @remarks
 * Behavior only — the displayed number IS the state, and the **DOM is the
 * source of truth**: the server renders the initial count into the `value`
 * target (the element itself without one), so a Turbo cache restore needs no
 * reconciliation and `connect()` only (re)subscribes. Sending tracks the full
 * subscription lifecycle (via the shared confirmation-aware subscription):
 * increments are dropped before confirmation AND while the connection is down
 * (`disconnected` shuts the gate until Action Cable re-confirms), so the
 * display never advances past what the server can receive. A refused
 * subscription publishes the `data-live-counter-rejected` hook (cleared on
 * `connect()` — rejection is transient server state) so the consumer's CSS can
 * disable the trigger. Optional `trigger` targets make that declarative: they
 * carry the real `disabled` attribute exactly while an increment would be
 * dropped (before confirmation, during an outage, after a rejection) — no CSS
 * required, and a disabled form control is announced as such by AT. An
 * authored `disabled` (set by the consumer for its own reasons) is respected:
 * only a disabled this controller applied — tracked via a marker attribute —
 * is ever lifted. Channel-less (local-only) counters never disable their
 * triggers. There are no timers; the subscription is released on
 * `disconnect()` (Turbo navigation included).
 */
export class LiveCounterController extends Controller<HTMLElement> {
  static override targets = ["value", "trigger"];
  static override values = {
    channel: { type: String, default: "" },
    params: { type: Object, default: {} },
    id: { type: String, default: "" },
  };
  static actions = ["increment"] as const;
  static events = ["change"] as const;

  declare readonly hasValueTarget: boolean;
  declare readonly valueTarget: HTMLElement;
  declare readonly triggerTargets: HTMLElement[];
  declare channelValue: string;
  declare paramsValue: Record<string, unknown>;
  declare idValue: string;

  #subscription: ConfirmedCableSubscription | null = null;

  override connect(): void {
    // Rejection is transient server state: a Turbo cache snapshot must not
    // resurrect the hook — the fresh subscription below re-decides it.
    this.element.removeAttribute("data-live-counter-rejected");
    if (this.channelValue) {
      this.#subscription = createConfirmedSubscription(
        { channel: this.channelValue, ...this.paramsValue },
        {
          connected: () => this.#syncTriggers(),
          // A drop closes the send window (the shared subscription tracks it)
          // until Action Cable reconnects and re-confirms — an increment during
          // the outage would bump the display while its perform() is silently
          // discarded by the closed socket.
          disconnected: () => this.#syncTriggers(),
          // The server refused the subscription (auth, bad params): the gate
          // stays shut for good, and the hook lets the consumer's CSS disable
          // or hide the trigger instead of leaving a silently dead button.
          rejected: () => {
            this.element.setAttribute("data-live-counter-rejected", "true");
            this.#syncTriggers();
          },
          received: (data: unknown) => this.#onReceived(data),
        },
      );
    }
    // Also covers a Turbo cache restore that snapshotted a disabled trigger:
    // the fresh (unconfirmed or absent) subscription re-decides the state.
    this.#syncTriggers();
  }

  override disconnect(): void {
    this.#subscription?.unsubscribe();
    this.#subscription = null;
    this.element.removeAttribute("data-live-counter-rejected");
  }

  /** Late-added triggers (e.g. via a Turbo Stream) pick up the current gate. */
  triggerTargetConnected(target: HTMLElement): void {
    this.#syncTrigger(target);
  }

  /**
   * Optimistic local increment: bumps the display immediately, then asks the
   * server to persist and broadcast. The step comes from the action param
   * (`data-stimeo--live-counter-delta-param`), default 1. Bound via `data-action`.
   */
  increment(event?: Event & { params?: { delta?: number } }): void {
    // Before the confirmed subscription — and while the connection is down —
    // a perform() is silently dropped by Action Cable: bumping the display
    // then would diverge from the server, so the whole increment is dropped
    // (screen and server stay consistent).
    if (this.#subscription && !this.#subscription.confirmed) return;
    // Action params arrive as authored strings; normalize and ignore garbage.
    const raw = Number(event?.params?.delta ?? 1);
    const delta = Number.isFinite(raw) ? raw : 1;
    // Without an own `id` the delta echo cannot be deduped: skip the optimistic
    // bump and let the broadcast apply the increment exactly once. Channel-less
    // (local-only) counters have no echo, so they always bump.
    if (!this.#subscription || this.idValue !== "") {
      this.#write(this.#current + delta);
    }
    this.#subscription?.perform("increment", { id: this.idValue, delta });
  }

  /** Reconciles a broadcast: absolute `count` wins; own-echo deltas are skipped. */
  #onReceived(data: unknown): void {
    const message = data as { count?: unknown; delta?: unknown; by?: unknown } | null;
    if (typeof message?.count === "number") {
      this.#write(message.count);
      return;
    }
    if (typeof message?.delta === "number") {
      // The own echo: this client already applied the delta optimistically.
      if (typeof message.by === "string" && message.by !== "" && message.by === this.idValue) {
        return;
      }
      this.#write(this.#current + message.delta);
    }
  }

  /** True while an increment would go through (channel-less counters always are). */
  get #ready(): boolean {
    return !this.#subscription || this.#subscription.confirmed;
  }

  /**
   * Reflects the send gate onto the optional `trigger` targets as the real
   * `disabled` attribute — the declarative alternative to styling off the
   * `data-live-counter-rejected` hook (a disabled control is also skipped by
   * keyboard focus and announced by AT, which CSS alone cannot do).
   */
  #syncTriggers(): void {
    for (const trigger of this.triggerTargets) this.#syncTrigger(trigger);
  }

  /**
   * `disabled` is a shared attribute: only disable what is currently enabled
   * (marking it ours), and only lift a disabled carrying our marker — so an
   * authored-disabled trigger ("disabled until valid", say) is never
   * re-enabled by the gate. A marked disabled restored from a Turbo cache
   * snapshot is recognized as ours and lifted once the gate opens.
   */
  #syncTrigger(trigger: HTMLElement): void {
    if (this.#ready) {
      if (trigger.hasAttribute(DISABLED_MARKER)) {
        trigger.removeAttribute("disabled");
        trigger.removeAttribute(DISABLED_MARKER);
      }
    } else if (!trigger.hasAttribute("disabled")) {
      trigger.setAttribute("disabled", "");
      trigger.setAttribute(DISABLED_MARKER, "");
    }
  }

  /** The displayed element: the `value` target, else the controller element. */
  get #display(): HTMLElement {
    return this.hasValueTarget ? this.valueTarget : this.element;
  }

  /** The current count, parsed from the DOM (the single source of truth). */
  get #current(): number {
    // Strip separators/suffixes ("1,200 likes") like count-up, so a formatted
    // server-rendered value doesn't collapse to its first digit group.
    const parsed = Number.parseInt((this.#display.textContent ?? "").replace(/[^0-9-]/g, ""), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  #write(count: number): void {
    if (count === this.#current) return;
    this.#display.textContent = String(count);
    this.dispatch("change", { detail: { count } });
  }
}
