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
 * Parses the extra identifier parameters a subscription is declared with.
 *
 * Stimulus offers an `Object` Value type, but its reader runs `JSON.parse` inside
 * the value observer — **before** the controller's `connect()` — and rethrows on
 * malformed text. The throw propagates out of the observer, so a single
 * unparseable attribute stops the subscription from ever being created and
 * leaves a controller that is connected but deaf, with nothing on the element to
 * say so. Declaring the attribute as a `String` Value and parsing it here keeps a
 * malformed declaration local to the value it declares: the identifier falls back
 * to the channel alone. The attribute text is identical either way
 * (`'{"room":"chat_42"}'`), so markup does not change with the declaration.
 *
 * Only a JSON object survives. An array, a bare number, a string or `null` cannot
 * name identifier parameters, and spreading one into the identifier would either
 * do nothing or produce index keys no channel can reproduce server-side.
 */
export function parseSubscriptionParams(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
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

/** One caller of {@link createConfirmedSubscription} riding a shared wire subscription. */
interface Member {
  readonly mixin: CableSubscriptionMixin;
  /**
   * True while a lifecycle callback the member missed (the identifier was already
   * confirmed or refused when it joined) is still owed to it. Any callback that arrives
   * from the wire in the meantime supersedes the owed one.
   */
  catchUp: boolean;
}

/** The one wire subscription an identifier has on a consumer, plus who rides it. */
interface SharedSubscription {
  readonly subscription: CableSubscription;
  readonly members: Set<Member>;
  confirmed: boolean;
  rejected: boolean;
}

/**
 * Wire subscriptions by identifier, per consumer. Keyed weakly so a replaced consumer
 * (see {@link setCableConsumer}) takes its bookkeeping with it.
 */
const sharedSubscriptions = new WeakMap<CableConsumer, Map<string, SharedSubscription>>();

/**
 * The identifier Action Cable derives for a channel descriptor: the JSON of the
 * params object, a bare channel name standing for `{ channel }`.
 */
function identifierOf(channel: string | Record<string, unknown>): string {
  return JSON.stringify(typeof channel === "string" ? { channel } : channel);
}

/**
 * Creates a subscription on the shared consumer with confirmation tracking
 * layered over the caller's mixin: `connected` / `disconnected` / `rejected`
 * flip the {@link ConfirmedCableSubscription.confirmed} flag *before* the
 * caller's own handler runs (so a handler reading `subscription.confirmed`
 * sees the post-transition state), and `received` passes straight through.
 *
 * **Callers with the same identifier (channel + params) share one wire
 * subscription.** The server confirms an identifier once and silently ignores a
 * repeated `subscribe` for it, so a second wire subscription would never be
 * confirmed — its sends would stay gated and the client would keep re-sending
 * `subscribe` until the next reconnect. Instead every caller is a member of the
 * identifier's one subscription: lifecycle callbacks and broadcasts fan out to all
 * members, a member joining an already confirmed (or refused) identifier is told
 * so on the next microtask — after its caller has stored the returned
 * subscription, the way a callback from the wire would arrive — and the wire is
 * unsubscribed when the last member leaves.
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
  const consumer = getCableConsumer();
  let registry = sharedSubscriptions.get(consumer);
  if (!registry) {
    registry = new Map();
    sharedSubscriptions.set(consumer, registry);
  }
  const identifier = identifierOf(channel);
  const member: Member = { mixin, catchUp: false };

  let shared = registry.get(identifier);
  if (!shared) {
    shared = openSharedSubscription(consumer, channel);
    registry.set(identifier, shared);
  } else if (shared.rejected || shared.confirmed) {
    // Missed lifecycle: deliver it once the caller holds the returned subscription.
    const owed = shared;
    member.catchUp = true;
    queueMicrotask(() => {
      if (!member.catchUp) return;
      member.catchUp = false;
      if (owed.rejected) mixin.rejected?.();
      else mixin.connected?.();
    });
  }
  shared.members.add(member);
  const owner = shared;
  const registered = registry;
  let active = true;

  return {
    perform: (action, data) => owner.subscription.perform(action, data),
    unsubscribe: () => {
      if (!active) return;
      active = false;
      // Nothing is owed to a member that left: a catch-up still queued must not fire.
      member.catchUp = false;
      owner.members.delete(member);
      if (owner.members.size === 0) {
        registered.delete(identifier);
        owner.subscription.unsubscribe();
      }
    },
    get confirmed() {
      return owner.confirmed;
    },
    get rejected() {
      return owner.rejected;
    },
  };
}

/** Opens the wire subscription for an identifier and wires the fan-out to its members. */
function openSharedSubscription(
  consumer: CableConsumer,
  channel: string | Record<string, unknown>,
): SharedSubscription {
  const members = new Set<Member>();
  // A callback from the wire supersedes whatever a late member was still owed.
  const fanOut = (deliver: (mixin: CableSubscriptionMixin) => void): void => {
    for (const member of [...members]) {
      member.catchUp = false;
      deliver(member.mixin);
    }
  };
  const shared: SharedSubscription = {
    members,
    confirmed: false,
    rejected: false,
    subscription: consumer.subscriptions.create(channel, {
      // A refusal is final: Action Cable never confirms a rejected subscription,
      // so a late connected/disconnected (only possible from a misbehaving
      // consumer double) must not reopen the gate `rejected` promised shut.
      connected: () => {
        if (shared.rejected) return;
        shared.confirmed = true;
        fanOut((mixin) => mixin.connected?.());
      },
      disconnected: () => {
        if (shared.rejected) return;
        shared.confirmed = false;
        fanOut((mixin) => mixin.disconnected?.());
      },
      rejected: () => {
        shared.confirmed = false;
        shared.rejected = true;
        fanOut((mixin) => mixin.rejected?.());
      },
      received: (data: unknown) => fanOut((mixin) => mixin.received?.(data)),
    }),
  };
  return shared;
}
