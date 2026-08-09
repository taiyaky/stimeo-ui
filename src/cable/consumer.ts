import { createConsumer } from "@rails/actioncable";

/**
 * Minimal structural view of an Action Cable subscription — the two members the
 * server-bound controllers use. Keeping our own narrow interface (instead of
 * re-exporting the full `@rails/actioncable` types) lets consumers hand us any
 * structurally compatible object, including test doubles.
 */
export interface CableSubscription {
  /** Invokes a channel action on the server (`ChannelName#action`). */
  perform(action: string, data?: Record<string, unknown>): void;
  /** Cancels the subscription (the channel's `unsubscribed` runs server-side). */
  unsubscribe(): void;
}

/** The mixin a controller passes to {@link CableConsumer.subscriptions}' create. */
export interface CableSubscriptionMixin {
  /** Called once the subscription is confirmed (`perform` is deliverable). */
  connected?(): void;
  /**
   * Called when the connection drops — perform() is silently undeliverable
   * until Action Cable reconnects and re-confirms (`connected` fires again).
   */
  disconnected?(): void;
  /** Called when the server refuses the subscription (it will never confirm). */
  rejected?(): void;
  /** Called with each broadcast the channel transmits to this client. */
  received?(data: unknown): void;
}

/** Minimal structural view of an Action Cable consumer (the websocket owner). */
export interface CableConsumer {
  subscriptions: {
    create(
      channel: string | Record<string, unknown>,
      mixin: CableSubscriptionMixin,
    ): CableSubscription;
  };
}

/**
 * The shared consumer. Deliberately module-scoped: an Action Cable consumer is
 * *connection infrastructure* (one websocket per app, the Rails
 * `channels/consumer.js` convention), not UI state — it must survive Turbo
 * navigations, so it is deliberately not rebuilt per `connect()` the way
 * DOM-derived state is.
 */
let sharedConsumer: CableConsumer | null = null;

/**
 * Replaces (or clears, with `null`) the shared Action Cable consumer.
 *
 * Call this once at boot when the app already owns a consumer (the usual
 * `app/javascript/channels/consumer.js`), so the server-bound controllers reuse
 * its websocket instead of opening a second one. Tests use it to inject a
 * double. With `null`, the next {@link getCableConsumer} lazily re-creates one.
 */
export function setCableConsumer(consumer: CableConsumer | null): void {
  sharedConsumer = consumer;
}

/**
 * The shared Action Cable consumer, lazily created on first use via
 * `createConsumer()` (which reads the standard `action_cable_meta_tag` URL).
 */
export function getCableConsumer(): CableConsumer {
  if (!sharedConsumer) sharedConsumer = createConsumer();
  return sharedConsumer;
}

/**
 * A {@link CableSubscription} that also tracks its confirmation lifecycle.
 * Action Cable silently drops a `perform()` sent before the subscription is
 * confirmed or while the connection is down — every server-bound controller
 * must therefore gate its sends (and their local side effects: optimistic
 * updates, throttle bookkeeping) on {@link confirmed}.
 */
export interface ConfirmedCableSubscription extends CableSubscription {
  /** True while the subscription is confirmed — `perform()` is deliverable. */
  readonly confirmed: boolean;
  /** True once the server refused the subscription (it will never confirm). */
  readonly rejected: boolean;
}

/**
 * Creates a subscription on the shared consumer with confirmation tracking
 * layered over the caller's mixin: `connected` / `disconnected` / `rejected`
 * flip the {@link ConfirmedCableSubscription.confirmed} flag *before* the
 * caller's own handler runs (so a handler reading `subscription.confirmed`
 * sees the post-transition state), and `received` passes straight through.
 *
 * This is deliberately a *tracker*, not an automatic `perform()` gate: the
 * controllers must skip the local side effects that surround a send (an
 * optimistic DOM bump, a throttle timestamp) together with the send itself,
 * which only the call site can decide — so they check `confirmed` and bail
 * before any of it.
 */
export function createConfirmedSubscription(
  channel: string | Record<string, unknown>,
  mixin: CableSubscriptionMixin,
): ConfirmedCableSubscription {
  let confirmed = false;
  let rejected = false;
  const subscription = getCableConsumer().subscriptions.create(channel, {
    // A refusal is final: Action Cable never confirms a rejected subscription,
    // so a late connected/disconnected (only possible from a misbehaving
    // consumer double) must not reopen the gate `rejected` promised shut.
    connected: () => {
      if (rejected) return;
      confirmed = true;
      mixin.connected?.();
    },
    disconnected: () => {
      if (rejected) return;
      confirmed = false;
      mixin.disconnected?.();
    },
    rejected: () => {
      confirmed = false;
      rejected = true;
      mixin.rejected?.();
    },
    received: (data: unknown) => mixin.received?.(data),
  });
  return {
    perform: (action, data) => subscription.perform(action, data),
    unsubscribe: () => subscription.unsubscribe(),
    get confirmed() {
      return confirmed;
    },
    get rejected() {
      return rejected;
    },
  };
}
