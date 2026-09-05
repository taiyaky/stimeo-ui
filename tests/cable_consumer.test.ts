import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CableSubscriptionMixin } from "../src/cable/consumer";
import {
  createConfirmedSubscription,
  getCableConsumer,
  parseSubscriptionParams,
  setCableConsumer,
} from "../src/cable/consumer";
import { flushMicrotasks } from "./helpers/timing";

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
  let createCount = 0;
  let createdWith: Record<string, unknown> | string | null = null;
  const performMock = vi.fn();
  const unsubscribeMock = vi.fn();

  beforeEach(() => {
    inner = null;
    createCount = 0;
    createdWith = null;
    performMock.mockClear();
    unsubscribeMock.mockClear();
    setCableConsumer({
      subscriptions: {
        create(channel, mixin) {
          createdWith = channel;
          inner = mixin;
          createCount += 1;
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

  describe("one wire subscription per identifier", () => {
    // The server confirms an identifier once and ignores a repeated subscribe for it,
    // so every caller with the same channel + params has to ride one wire subscription.
    const room = { channel: "Channel", room: "doc_7" };

    it("shares one wire subscription between callers with the same identifier", () => {
      const a = createConfirmedSubscription(room, {});
      const b = createConfirmedSubscription({ ...room }, {});
      expect(createCount).toBe(1);
      inner?.connected?.();
      expect(a.confirmed).toBe(true);
      expect(b.confirmed).toBe(true);
      b.perform("typing", { name: "b" });
      expect(performMock).toHaveBeenCalledWith("typing", { name: "b" });
    });

    it("treats a bare channel name and { channel } as the same identifier", () => {
      createConfirmedSubscription("Channel", {});
      createConfirmedSubscription({ channel: "Channel" }, {});
      expect(createCount).toBe(1);
    });

    it("keeps different identifiers on separate wire subscriptions", () => {
      createConfirmedSubscription(room, {});
      createConfirmedSubscription({ channel: "Channel", room: "doc_8" }, {});
      expect(createCount).toBe(2);
    });

    it("fans connected and disconnected out to every member", () => {
      const a = { connected: vi.fn(), disconnected: vi.fn() };
      const b = { connected: vi.fn(), disconnected: vi.fn() };
      createConfirmedSubscription(room, a);
      createConfirmedSubscription(room, b);
      inner?.connected?.();
      inner?.disconnected?.();
      expect(a.connected).toHaveBeenCalledOnce();
      expect(b.connected).toHaveBeenCalledOnce();
      expect(a.disconnected).toHaveBeenCalledOnce();
      expect(b.disconnected).toHaveBeenCalledOnce();
    });

    it("fans a refusal out to every member and shuts every gate", () => {
      const a = { rejected: vi.fn() };
      const b = { rejected: vi.fn() };
      const first = createConfirmedSubscription(room, a);
      const second = createConfirmedSubscription(room, b);
      inner?.rejected?.();
      expect(a.rejected).toHaveBeenCalledOnce();
      expect(b.rejected).toHaveBeenCalledOnce();
      expect(first.rejected).toBe(true);
      expect(second.rejected).toBe(true);
      expect(second.confirmed).toBe(false);
    });

    it("fans received broadcasts out to every member", () => {
      const a = vi.fn();
      const b = vi.fn();
      createConfirmedSubscription(room, { received: a });
      createConfirmedSubscription(room, { received: b });
      inner?.received?.({ name: "Bob" });
      expect(a).toHaveBeenCalledWith({ name: "Bob" });
      expect(b).toHaveBeenCalledWith({ name: "Bob" });
    });

    it("confirms a member joining a confirmed identifier at once, and tells it connected after the call returns", async () => {
      createConfirmedSubscription(room, {});
      inner?.connected?.();
      const connected = vi.fn();
      const late = createConfirmedSubscription(room, { connected });
      expect(createCount).toBe(1);
      expect(late.confirmed).toBe(true);
      // Not synchronous: the caller has not stored the returned subscription yet.
      expect(connected).not.toHaveBeenCalled();
      await flushMicrotasks();
      expect(connected).toHaveBeenCalledOnce();
    });

    it("tells a late member connected exactly once when the wire reconfirms before the catch-up runs", async () => {
      createConfirmedSubscription(room, {});
      inner?.connected?.();
      const connected = vi.fn();
      createConfirmedSubscription(room, { connected });
      inner?.disconnected?.();
      inner?.connected?.();
      await flushMicrotasks();
      expect(connected).toHaveBeenCalledOnce();
    });

    it("drops the catch-up when the wire drops before it is delivered", async () => {
      createConfirmedSubscription(room, {});
      inner?.connected?.();
      const connected = vi.fn();
      const late = createConfirmedSubscription(room, { connected });
      inner?.disconnected?.();
      await flushMicrotasks();
      expect(connected).not.toHaveBeenCalled();
      expect(late.confirmed).toBe(false);
    });

    it("owes nothing to a late member that leaves before the catch-up runs", async () => {
      // A controller can connect and disconnect within one task (a Turbo swap); a
      // callback landing after its teardown would act on a dead instance.
      createConfirmedSubscription(room, {});
      inner?.connected?.();
      const connected = vi.fn();
      const late = createConfirmedSubscription(room, { connected });
      late.unsubscribe();
      await flushMicrotasks();
      expect(connected).not.toHaveBeenCalled();
    });

    it("reports a refusal to a member joining after it, without a new wire subscription", async () => {
      createConfirmedSubscription(room, {});
      inner?.rejected?.();
      const rejected = vi.fn();
      const connected = vi.fn();
      const late = createConfirmedSubscription(room, { rejected, connected });
      expect(createCount).toBe(1);
      expect(late.rejected).toBe(true);
      expect(late.confirmed).toBe(false);
      expect(rejected).not.toHaveBeenCalled();
      await flushMicrotasks();
      expect(rejected).toHaveBeenCalledOnce();
      expect(connected).not.toHaveBeenCalled();
    });

    it("unsubscribes the wire only when the last member leaves", () => {
      const a = createConfirmedSubscription(room, {});
      const b = createConfirmedSubscription(room, {});
      a.unsubscribe();
      expect(unsubscribeMock).not.toHaveBeenCalled();
      b.unsubscribe();
      expect(unsubscribeMock).toHaveBeenCalledOnce();
    });

    it("ignores a second unsubscribe from the same member", () => {
      const a = createConfirmedSubscription(room, {});
      const b = createConfirmedSubscription(room, {});
      a.unsubscribe();
      a.unsubscribe();
      expect(unsubscribeMock).not.toHaveBeenCalled();
      b.unsubscribe();
      expect(unsubscribeMock).toHaveBeenCalledOnce();
    });

    it("lets a stale unsubscribe neither evict a later member nor unsubscribe the wire twice", () => {
      const first = createConfirmedSubscription(room, {});
      first.unsubscribe();
      expect(unsubscribeMock).toHaveBeenCalledOnce();
      const next = createConfirmedSubscription(room, {});
      first.unsubscribe(); // stale: its wire is gone and `next` owns the identifier now
      expect(unsubscribeMock).toHaveBeenCalledOnce();
      inner?.connected?.();
      expect(next.confirmed).toBe(true);
      createConfirmedSubscription(room, {});
      expect(createCount).toBe(2); // the newcomer still rides the wire `next` opened
    });

    it("stops delivering to a member that left", () => {
      const a = vi.fn();
      const b = vi.fn();
      const first = createConfirmedSubscription(room, { received: a });
      createConfirmedSubscription(room, { received: b });
      first.unsubscribe();
      inner?.received?.({ name: "Bob" });
      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledOnce();
    });

    it("starts a fresh wire subscription once every member has left", () => {
      const first = createConfirmedSubscription(room, {});
      inner?.connected?.();
      first.unsubscribe();
      const next = createConfirmedSubscription(room, {});
      expect(createCount).toBe(2);
      expect(next.confirmed).toBe(false);
    });

    it("keeps one registry per consumer", () => {
      createConfirmedSubscription(room, {});
      const otherCreate = vi.fn(() => ({ perform: vi.fn(), unsubscribe: vi.fn() }));
      setCableConsumer({ subscriptions: { create: otherCreate } });
      createConfirmedSubscription(room, {});
      expect(createCount).toBe(1);
      expect(otherCreate).toHaveBeenCalledOnce();
    });
  });
});

describe("getCableConsumer", () => {
  afterEach(() => {
    setCableConsumer(null);
  });

  it("creates one Action Cable consumer lazily when none was injected, and keeps it", () => {
    setCableConsumer(null);
    const consumer = getCableConsumer();
    expect(consumer).toBeTruthy();
    expect(getCableConsumer()).toBe(consumer);
  });
});

describe("parseSubscriptionParams", () => {
  it("reads a JSON object into identifier parameters", () => {
    expect(parseSubscriptionParams('{"room":"chat_42","tier":2}')).toEqual({
      room: "chat_42",
      tier: 2,
    });
  });

  it("falls back to no parameters when the declaration is absent", () => {
    expect(parseSubscriptionParams("")).toEqual({});
  });

  it("falls back to no parameters when the declaration is unparseable", () => {
    // Stimulus' own Object reader throws here, and the throw would take the whole
    // subscription with it; the identifier has to keep naming the channel instead.
    expect(parseSubscriptionParams("{")).toEqual({});
    expect(parseSubscriptionParams("room: chat_42")).toEqual({});
  });

  it("falls back to no parameters for JSON that cannot name parameters", () => {
    expect(parseSubscriptionParams("null")).toEqual({});
    expect(parseSubscriptionParams("42")).toEqual({});
    expect(parseSubscriptionParams('"chat_42"')).toEqual({});
    expect(parseSubscriptionParams('["chat_42"]')).toEqual({});
  });
});
