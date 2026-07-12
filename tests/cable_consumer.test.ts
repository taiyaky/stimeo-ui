import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CableSubscriptionMixin } from "../src/cable/consumer";
import { createConfirmedSubscription, setCableConsumer } from "../src/cable/consumer";

/**
 * Contract tests for {@link createConfirmedSubscription}: the confirmation
 * lifecycle (`confirmed` / `rejected` flags flipping on `connected` /
 * `disconnected` / `rejected`), flag-before-callback ordering (a caller's
 * handler reading `subscription.confirmed` sees the post-transition state),
 * mixin pass-through, and perform/unsubscribe delegation.
 *
 * The Action Cable consumer is a double injected via {@link setCableConsumer};
 * lifecycle events are driven by calling the captured inner mixin directly.
 */

describe("createConfirmedSubscription", () => {
  let inner: CableSubscriptionMixin | null = null;
  let createdWith: Record<string, unknown> | string | null = null;
  const performMock = vi.fn();
  const unsubscribeMock = vi.fn();

  beforeEach(() => {
    inner = null;
    createdWith = null;
    performMock.mockClear();
    unsubscribeMock.mockClear();
    setCableConsumer({
      subscriptions: {
        create(channel, mixin) {
          createdWith = channel;
          inner = mixin;
          return { perform: performMock, unsubscribe: unsubscribeMock };
        },
      },
    });
  });

  afterEach(() => {
    setCableConsumer(null);
  });

  it("starts unconfirmed and unrejected", () => {
    const subscription = createConfirmedSubscription("Channel", {});
    expect(subscription.confirmed).toBe(false);
    expect(subscription.rejected).toBe(false);
  });

  it("passes the channel descriptor through to the consumer", () => {
    createConfirmedSubscription({ channel: "Channel", room: "doc_7" }, {});
    expect(createdWith).toEqual({ channel: "Channel", room: "doc_7" });
  });

  it("tracks the confirmation window across connect / drop / reconfirm", () => {
    const subscription = createConfirmedSubscription("Channel", {});
    inner?.connected?.();
    expect(subscription.confirmed).toBe(true);
    inner?.disconnected?.();
    expect(subscription.confirmed).toBe(false);
    inner?.connected?.();
    expect(subscription.confirmed).toBe(true);
  });

  it("shuts the gate for good and flags rejected on a refusal", () => {
    const subscription = createConfirmedSubscription("Channel", {});
    inner?.rejected?.();
    expect(subscription.confirmed).toBe(false);
    expect(subscription.rejected).toBe(true);
  });

  it("ignores connected / disconnected after a rejection (a refusal is final)", () => {
    // Action Cable never confirms a refused subscription; a late lifecycle
    // event from a misbehaving double must not reopen the gate.
    const connected = vi.fn();
    const disconnected = vi.fn();
    const subscription = createConfirmedSubscription("Channel", { connected, disconnected });
    inner?.rejected?.();
    inner?.connected?.();
    expect(subscription.confirmed).toBe(false);
    expect(subscription.rejected).toBe(true);
    expect(connected).not.toHaveBeenCalled();
    inner?.disconnected?.();
    expect(disconnected).not.toHaveBeenCalled();
  });

  it("flips the flags BEFORE the caller's handler runs", () => {
    // A handler reading `subscription.confirmed` must see the post-transition
    // state — e.g. presence force-beacons from `connected` through a gate that
    // checks the flag.
    const seen: Array<[string, boolean]> = [];
    const subscription = createConfirmedSubscription("Channel", {
      connected: () => seen.push(["connected", subscription.confirmed]),
      disconnected: () => seen.push(["disconnected", subscription.confirmed]),
      rejected: () => seen.push(["rejected", subscription.rejected]),
    });
    inner?.connected?.();
    inner?.disconnected?.();
    inner?.rejected?.();
    expect(seen).toEqual([
      ["connected", true],
      ["disconnected", false],
      ["rejected", true],
    ]);
  });

  it("passes received broadcasts through untouched", () => {
    const received = vi.fn();
    createConfirmedSubscription("Channel", { received });
    inner?.received?.({ count: 3 });
    expect(received).toHaveBeenCalledWith({ count: 3 });
  });

  it("tolerates a mixin without handlers (all optional)", () => {
    createConfirmedSubscription("Channel", {});
    expect(() => {
      inner?.connected?.();
      inner?.disconnected?.();
      inner?.rejected?.();
      inner?.received?.({});
    }).not.toThrow();
  });

  it("delegates perform and unsubscribe to the underlying subscription", () => {
    const subscription = createConfirmedSubscription("Channel", {});
    subscription.perform("appear", { id: "alice" });
    expect(performMock).toHaveBeenCalledWith("appear", { id: "alice" });
    subscription.unsubscribe();
    expect(unsubscribeMock).toHaveBeenCalledOnce();
  });
});
