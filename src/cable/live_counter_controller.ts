import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { authoredInteger } from "../utils/authored_integer";
import { BlurDeferral } from "../utils/blur_deferral";
import { SafeTimeout } from "../utils/safe_timeout";
import { TransientHooks } from "../utils/transient_hooks";
import {
  type ConfirmedCableSubscription,
  createConfirmedSubscription,
  parseSubscriptionParams,
} from "./consumer";

/** The hook a connection may find written by an earlier, now-gone one. */
const TRANSIENT = new TransientHooks({ attributes: ["data-live-counter-rejected"] });

/**
 * Marker on triggers this controller disabled: `disabled` is a shared
 * attribute, so only marked ones are ever re-enabled — an authored-disabled
 * trigger stays untouched. The marker lives in the DOM rather than in a lease
 * held by the instance, so it survives a Turbo cache snapshot.
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
 *     <button type="button" data-action="click->stimeo--live-counter#increment"
 *             data-stimeo--live-counter-target="trigger">♥</button>
 *   </div>
 *
 * Wire contract — the broadcast is either **authoritative** or a **delta**:
 * `{ count: 129 }` sets the absolute value (naturally idempotent; preferred —
 * the server owns the number), while `{ delta: 1, by: "17" }` adds to it,
 * skipped when `by` matches this client's `id` **and its amount matches an
 * optimistic bump this client is still waiting to see echoed**. A counter
 * holding no such guess — a sibling on the page, this user's other tab, one
 * stepping by a different amount — applies the delta like any other, so every
 * display converges. Only whole numbers are accepted: the
 * display is the state, and a value that cannot be read back from text is not
 * a count. `increment` performs `increment` on the channel with `{ id, delta }`;
 * the server persists and broadcasts. Without an own `id` the delta echo is
 * indistinguishable from a foreign delta, so the optimistic bump is skipped and
 * the broadcast applies the increment exactly once — set `id` (any per-client,
 * per-tab string, e.g. `SecureRandom.uuid`) for optimistic UX. Comparing `by`
 * to `id` is an echo guard, not authentication — identity belongs to the server.
 *
 * `change` dispatches `{ count }`.
 *
 * @remarks
 * Behavior only — the displayed number IS the state, and the **DOM is the
 * source of truth**: the server renders the initial count into the `value`
 * target (the element itself without one), so a Turbo cache restore needs no
 * reconciliation and `connect()` only (re)subscribes. Sending tracks the full
 * subscription lifecycle (via the shared confirmation-aware subscription):
 * increments are dropped before confirmation AND while the connection is down
 * (`disconnected` shuts the gate until Action Cable re-confirms), so the
 * display never advances past what the server can receive. The gate reads the
 * declaration, not the subscription object: while a `channel` is declared it
 * stays shut until that subscription confirms, including the window where one
 * has yet to be opened. A refused
 * subscription publishes the `data-live-counter-rejected` hook (cleared on
 * `connect()` — rejection is transient server state) so the consumer's CSS can
 * disable the trigger. Optional `trigger` targets make that declarative: they
 * carry the real `disabled` attribute exactly while an increment would be
 * dropped (before confirmation, during an outage, after a rejection) — no CSS
 * required, and a disabled form control is announced as such by AT. An
 * authored `disabled` (set by the consumer for its own reasons) is respected:
 * only a disabled this controller applied — tracked via a marker attribute —
 * is ever lifted, and it is given back when the controller or the target goes
 * away. A trigger that holds focus keeps it: the disable waits for it to blur,
 * since taking focus away mid-outage strands a keyboard user. Channel-less
 * (local-only) counters never disable their triggers. `announceText` is opt-in
 * and empty by default; when set, reconciled counts reach the page's shared
 * announcer, debounced so a burst is one message. The subscription follows the
 * declaration — a `channel` or `params` change moves it — and is released on
 * `disconnect()` (Turbo navigation included) along with any pending
 * announcement.
 */
export class LiveCounterController extends Controller<HTMLElement> {
  static override targets = ["value", "trigger"];
  static override values = {
    channel: { type: String, default: "" },
    params: { type: String, default: "" },
    id: { type: String, default: "" },
    announceText: { type: String, default: "" },
  };
  /** Collapses a burst of broadcasts into one announcement. */
  static #announceDelay = 200;
  static actions = ["increment"] as const;
  static events = ["change"] as const;

  declare readonly hasValueTarget: boolean;
  declare readonly valueTarget: HTMLElement;
  declare readonly triggerTargets: HTMLElement[];
  declare channelValue: string;
  declare paramsValue: string;
  declare idValue: string;
  declare announceTextValue: string;

  /** Identifier parameters parsed once from their declaration, never in the hot path. */
  #params: Record<string, unknown> = {};

  #subscription: ConfirmedCableSubscription | null = null;
  #connected = false;
  /**
   * The optimistic bumps this client has yet to see echoed back, in the order it
   * sent them. An echo belongs to the send that caused it, and the amount is what
   * names that send: a counter that guessed nothing — or guessed a different
   * amount — applies the delta like any other, so siblings and other tabs
   * converge whatever step each of them uses.
   */
  readonly #outstanding: number[] = [];
  /** Holds a disable back while the trigger owns focus, so focus is never taken away. */
  readonly #focusedTriggers = new BlurDeferral((trigger) => this.#syncTrigger(trigger));
  readonly #timers = new SafeTimeout();

  /**
   * Re-parses the identifier parameters and moves the subscription to the
   * identifier they now name.
   *
   * A malformed declaration falls back to no parameters, so the identifier keeps
   * naming the channel instead of the subscription never being created at all.
   */
  paramsValueChanged(): void {
    this.#params = parseSubscriptionParams(this.paramsValue);
    this.#resubscribe();
  }

  /** Moves the subscription when the declaration names a different channel. */
  channelValueChanged(): void {
    this.#resubscribe();
  }

  override connect(): void {
    this.#connected = true;
    this.#subscribe();
  }

  /**
   * Opens the subscription the declaration names, and reflects the gate.
   *
   * The rejected hook is transient server state: a Turbo cache snapshot must not
   * resurrect it — the fresh subscription re-decides it. An outstanding guess
   * belongs to the identifier that is going away, so it is dropped with it.
   *
   * @stimeoRuntimeOnly `channel` decides whether this call opens a subscription at all; the
   *   rejected hook it clears does not depend on it.
   */
  #subscribe(): void {
    TRANSIENT.reset(this.element);
    this.#outstanding.length = 0;
    if (this.channelValue) {
      this.#subscription = this.#open();
    }
    // Also covers a Turbo cache restore that snapshotted a disabled trigger:
    // the fresh (unconfirmed or absent) subscription re-decides the state.
    this.#syncTriggers();
  }

  /**
   * Opens the wire subscription, or returns null when it cannot be opened.
   *
   * A consumer that cannot be built (no Action Cable meta tag, a boot-order
   * mistake) would otherwise throw out of `connect()` and leave the element
   * half-wired: no gate reflected, and a trigger that looks live. The gate reads
   * the declaration, so a null subscription keeps it shut and the display never
   * moves past what the server can receive.
   *
   * @stimeoRuntimeOnly `channel` and its params choose the one subscription this call opens; `id`
   *   is read by the handlers it wires.
   */
  #open(): ConfirmedCableSubscription | null {
    try {
      return createConfirmedSubscription(this.#descriptor, {
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
      });
    } catch (error) {
      console.warn("Stimeo UI: the live counter could not open its subscription.", error);
      return null;
    }
  }

  /**
   * The identifier this declaration names.
   *
   * `channel` comes first so the identifier text matches what Action Cable
   * builds, and a `channel` key inside `params` cannot displace the declared
   * one — `params` names *additional* identifier parameters.
   */
  get #descriptor(): Record<string, unknown> {
    const { channel: _ignored, ...rest } = this.#params;
    return { channel: this.channelValue, ...rest };
  }

  /** Moves to the identifier the declaration now names. */
  #resubscribe(): void {
    if (!this.#connected) return; // value callbacks run before connect()
    this.#subscription?.unsubscribe();
    this.#subscription = null;
    this.#subscribe();
  }

  override disconnect(): void {
    this.#connected = false;
    this.#timers.clearAll();
    this.#focusedTriggers.releaseAll();
    this.#subscription?.unsubscribe();
    this.#subscription = null;
    TRANSIENT.reset(this.element);
    // `disabled` is borrowed while the gate is shut: give back what is ours.
    for (const trigger of this.triggerTargets) this.#release(trigger);
  }

  /** Late-added triggers (e.g. via a Turbo Stream) pick up the current gate. */
  triggerTargetConnected(target: HTMLElement): void {
    this.#syncTrigger(target);
  }

  /** A trigger that stops being one keeps nothing this controller lent it. */
  triggerTargetDisconnected(target: HTMLElement): void {
    this.#focusedTriggers.release(target);
    this.#release(target);
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
    // (screen and server stay consistent). A declared channel with no live
    // subscription is the same window, so the gate reads the declaration.
    if (!this.#ready) return;
    // Action params arrive as authored strings; normalize and ignore garbage.
    const raw = Number(event?.params?.delta ?? 1);
    const delta = Number.isSafeInteger(raw) ? raw : 1;
    // Channel-less (local-only) counters have no echo coming, so they always bump
    // and keep no guess: nothing would ever cancel one. Without an own `id` the
    // delta echo cannot be deduped either, so the optimistic bump is skipped and
    // the broadcast applies the increment exactly once.
    if (this.#local) {
      this.#write(this.#current + delta);
    } else if (this.idValue !== "") {
      this.#outstanding.push(delta);
      this.#write(this.#current + delta);
    }
    this.#subscription?.perform("increment", { id: this.idValue, delta });
  }

  /**
   * Reconciles a broadcast: absolute `count` wins; the echo of this client's own
   * guess is skipped.
   *
   * Only whole numbers reach the display. The wire carries values another client
   * named and the server relayed, and the display is the state this controller
   * reads back — a fraction, an infinity or a NaN would be written as text that
   * reads back as a different number, or as none at all.
   */
  #onReceived(data: unknown): void {
    const message = data as { count?: unknown; delta?: unknown; by?: unknown } | null;
    if (Number.isSafeInteger(message?.count)) {
      // Server truth settles every guess this client was still waiting on.
      this.#outstanding.length = 0;
      this.#reconcile(message?.count as number);
      return;
    }
    if (Number.isSafeInteger(message?.delta)) {
      const delta = message?.delta as number;
      const own =
        typeof message?.by === "string" && message.by !== "" && message.by === this.idValue;
      // An echo cancels the one guess it was the answer to, matched by amount. A
      // counter holding no guess of that size — a sibling on the page, this
      // user's other tab, a step someone else chose — applies it.
      const guess = own ? this.#outstanding.indexOf(delta) : -1;
      if (guess !== -1) {
        this.#outstanding.splice(guess, 1);
        return;
      }
      this.#reconcile(this.#current + delta);
    }
  }

  /** True when no channel is declared: the local-only mode, with no server to diverge from. */
  get #local(): boolean {
    return this.channelValue === "";
  }

  /** True while an increment would go through (local-only counters always are). */
  get #ready(): boolean {
    return this.#local || (this.#subscription?.confirmed ?? false);
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
   *
   * @stimeoRenderRoot
   */
  #syncTrigger(trigger: HTMLElement): void {
    if (this.#ready) {
      this.#focusedTriggers.release(trigger);
      this.#release(trigger);
      return;
    }
    if (trigger.hasAttribute("disabled")) return;
    // Disabling the control that holds focus drops it to the document body,
    // stranding a keyboard user mid-interaction. Hold the disable until it
    // blurs; the gate already refuses the increment either way.
    if (trigger.contains(document.activeElement)) {
      this.#focusedTriggers.defer(trigger);
      return;
    }
    trigger.setAttribute("disabled", "");
    trigger.setAttribute(DISABLED_MARKER, "");
  }

  /** Gives back a `disabled` this controller lent, leaving an authored one alone. */
  #release(trigger: HTMLElement): void {
    if (!trigger.hasAttribute(DISABLED_MARKER)) return;
    trigger.removeAttribute("disabled");
    trigger.removeAttribute(DISABLED_MARKER);
  }

  /** The displayed element: the `value` target, else the controller element. */
  get #display(): HTMLElement {
    return this.hasValueTarget ? this.valueTarget : this.element;
  }

  /** The current count, parsed from the DOM (the single source of truth). */
  get #current(): number {
    // A formatted server-rendered value ("1,200 likes") reads as the number it
    // displays; a display holding no number at all counts as zero.
    return authoredInteger(this.#display.textContent ?? "") ?? 0;
  }

  /**
   * Writes a whole count — every caller has already established that it is one —
   * and reports whether the display actually moved.
   */
  #write(count: number): boolean {
    if (count === this.#current) return false;
    this.#display.textContent = String(count);
    this.dispatch("change", { detail: { count } });
    return true;
  }

  /**
   * Settles the display on a count the server stated, announcing what it settled
   * on. Announcing the optimistic bump instead would read a guess out and then
   * correct it, so the announcement rides this path only.
   *
   * @stimeoRuntimeOnly The count shown is the value received; `announceText` words the one
   *   announcement of this change.
   */
  #reconcile(count: number): void {
    if (this.#write(count)) this.#announce(count);
  }

  /**
   * Hands a reconciled count to the page's shared announcer.
   *
   * Debounced: a burst of broadcasts is one announcement, not one per message,
   * and only the last one is ever sent. Wording comes from the consumer and
   * {@link announce} drops an empty message, so an undeclared template announces
   * nothing at all — a count that ticks constantly should not interrupt a reader
   * unless the page asked for it.
   */
  #announce(count: number): void {
    this.#timers.clearAll();
    this.#timers.set(() => {
      announce(fillTemplate(this.announceTextValue, { count }));
    }, LiveCounterController.#announceDelay);
  }
}
