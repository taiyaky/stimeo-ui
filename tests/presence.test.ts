import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CableSubscriptionMixin } from "../src/cable/consumer";
import { createConfirmedSubscription, setCableConsumer } from "../src/cable/consumer";
import { PresenceController } from "../src/cable/presence_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { delay } from "./helpers/timing";

/**
 * Behavioral tests for {@link PresenceController}: subscription wiring, the
 * confirmed-subscription beacon + heartbeat, the confirmation gate (heartbeats
 * and the leaving notice are dropped before confirmation and during an outage,
 * without burning the convergence throttle), the leaving notice (disconnect
 * and best-effort pagehide), peer tracking (upsert / expiry / graceful leave /
 * own-echo suppression), roster convergence (answering an unknown peer), the
 * `data-present*` hooks, the rejected hook, the known-empty count rendered
 * from connect, count templates, list/template clone rendering,
 * join/leave/change events, and Turbo teardown/reconnect resilience.
 *
 * The Action Cable consumer is a double injected via {@link setCableConsumer};
 * broadcasts are driven by calling the captured `received` mixin directly, and
 * the subscription lifecycle by calling `connected` / `disconnected` /
 * `rejected`.
 */

describe("PresenceController", () => {
  let application: Application;
  let createdWith: Record<string, unknown> | string | null = null;
  let mixin: CableSubscriptionMixin | null = null;
  /** Every mixin the double was asked to create, in order (one per wire subscription). */
  let mixins: CableSubscriptionMixin[] = [];
  const performMock = vi.fn();
  const unsubscribeMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    createdWith = null;
    mixin = null;
    mixins = [];
    performMock.mockClear();
    unsubscribeMock.mockClear();
    setCableConsumer({
      subscriptions: {
        create(channel, subscriptionMixin) {
          createdWith = channel;
          mixin = subscriptionMixin;
          mixins.push(subscriptionMixin);
          return { perform: performMock, unsubscribe: unsubscribeMock };
        },
      },
    });
  });

  const fixture = `
    <div data-controller="stimeo--presence"
         data-stimeo--presence-channel-value="PresenceChannel"
         data-stimeo--presence-params-value='{"room":"doc_7"}'
         data-stimeo--presence-id-value="alice" data-stimeo--presence-name-value="Alice"
         data-stimeo--presence-heartbeat-value="15000"
         data-stimeo--presence-timeout-value="40000">
      <span data-stimeo--presence-target="count"></span>
      <ul aria-label="Currently viewing" data-stimeo--presence-target="list"></ul>
      <template data-stimeo--presence-target="template">
        <li><span data-presence-name></span></li>
      </template>
    </div>`;

  /** Mounts the fixture; fake timers require a manual Stimulus connect flush. */
  const mount = async (html = fixture) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--presence", PresenceController);
    await vi.advanceTimersByTimeAsync(20);
  };

  afterEach(async () => {
    controller()?.disconnect();
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    setCableConsumer(null);
    vi.useRealTimers();
    await delay(20);
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--presence']") as HTMLElement;
  const count = () =>
    document.querySelector<HTMLElement>("[data-stimeo--presence-target='count']") as HTMLElement;
  const list = () =>
    document.querySelector<HTMLElement>("[data-stimeo--presence-target='list']") as HTMLElement;
  const controller = () =>
    root()
      ? (application?.getControllerForElementAndIdentifier(
          root(),
          "stimeo--presence",
        ) as PresenceController | null)
      : null;
  const confirm = () => mixin?.connected?.();
  const drop = () => mixin?.disconnected?.();
  const reject = () => mixin?.rejected?.();
  const receive = (id: string, name = "", leaving = false) =>
    mixin?.received?.(leaving ? { id, leaving: true } : { id, name });
  const renderedNames = () =>
    Array.from(list().querySelectorAll("[data-presence-id]")).map((el) =>
      (el.textContent ?? "").trim(),
    );

  describe("subscription + beacons", () => {
    it("subscribes with the channel plus the params object", async () => {
      await mount();
      expect(createdWith).toEqual({ channel: "PresenceChannel", room: "doc_7" });
    });

    it("beacons only once the subscription is confirmed", async () => {
      await mount();
      expect(performMock).not.toHaveBeenCalled(); // perform before confirm is dropped
      confirm();
      expect(performMock).toHaveBeenCalledWith("appear", { id: "alice", name: "Alice" });
    });

    it("shares one confirmed subscription between two widgets for the same room", async () => {
      await mount(fixture + fixture);
      // The server confirms an identifier once and ignores a repeated subscribe for it.
      expect(mixins).toHaveLength(1);
      mixins[0]?.connected?.();
      expect(performMock).toHaveBeenCalledWith("appear", { id: "alice", name: "Alice" });
      mixins[0]?.received?.({ id: "bob", name: "Bob" });
      const names = [...document.querySelectorAll('[data-stimeo--presence-target="list"]')].map(
        (each) =>
          Array.from(each.querySelectorAll("[data-presence-id]")).map((el) =>
            (el.textContent ?? "").trim(),
          ),
      );
      expect(names).toEqual([["Bob"], ["Bob"]]);
    });

    it("heartbeats on the configured interval", async () => {
      await mount();
      confirm();
      performMock.mockClear();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(performMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(performMock).toHaveBeenCalledTimes(3);
    });

    it("never beacons without an own id", async () => {
      await mount(`
        <div data-controller="stimeo--presence"
             data-stimeo--presence-channel-value="PresenceChannel"></div>`);
      confirm();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(performMock).not.toHaveBeenCalled();
    });

    it("broadcasts a leaving notice and unsubscribes on disconnect", async () => {
      await mount();
      confirm();
      controller()?.disconnect();
      expect(performMock).toHaveBeenLastCalledWith("appear", { id: "alice", leaving: true });
      expect(unsubscribeMock).toHaveBeenCalledOnce();
    });

    it("broadcasts a leaving notice on pagehide (tab close / hard navigation)", async () => {
      // disconnect() never runs there — pagehide is the only leave signal.
      await mount();
      confirm();
      performMock.mockClear();
      window.dispatchEvent(new Event("pagehide"));
      expect(performMock).toHaveBeenCalledWith("appear", { id: "alice", leaving: true });
    });

    it("removes the pagehide listener on disconnect", async () => {
      await mount();
      confirm();
      controller()?.disconnect();
      performMock.mockClear();
      window.dispatchEvent(new Event("pagehide"));
      expect(performMock).not.toHaveBeenCalled();
    });

    it("unregisters the pagehide listener it registered", async () => {
      const added = vi.spyOn(window, "addEventListener");
      const removed = vi.spyOn(window, "removeEventListener");
      try {
        await mount();
        const onPageHide = added.mock.calls.find(([type]) => type === "pagehide")?.[1];
        expect(onPageHide).toBeDefined();

        controller()?.disconnect();
        expect(removed).toHaveBeenCalledWith("pagehide", onPageHide);
      } finally {
        added.mockRestore();
        removed.mockRestore();
      }
    });

    it("leaves no heartbeat running after disconnect", async () => {
      await mount();
      const pending = vi.getTimerCount(); // the heartbeat interval among them
      controller()?.disconnect();
      expect(vi.getTimerCount()).toBe(pending - 1);
    });
  });

  describe("confirmation gating", () => {
    it("does not heartbeat before the subscription confirms", async () => {
      // The interval ticks regardless, but every beacon it fires is gated —
      // Action Cable would discard the perform() anyway.
      await mount();
      await vi.advanceTimersByTimeAsync(31_000); // two heartbeat ticks, unconfirmed
      expect(performMock).not.toHaveBeenCalled();
    });

    it("gates heartbeats during an outage and re-announces on reconfirm", async () => {
      await mount();
      confirm();
      performMock.mockClear();
      drop();
      await vi.advanceTimersByTimeAsync(31_000); // outage ticks: all gated
      expect(performMock).not.toHaveBeenCalled();

      confirm(); // reconnect: the forced beacon re-announces immediately
      expect(performMock).toHaveBeenCalledWith("appear", { id: "alice", name: "Alice" });
    });

    it("gates a queued convergence answer that comes due during an outage", async () => {
      await mount();
      confirm(); // the initial beacon burns the throttle window
      performMock.mockClear();
      receive("bob", "Bob"); // unknown peer inside the window: answer queued
      drop();
      await vi.advanceTimersByTimeAsync(2100); // the queued answer fires offline…
      expect(performMock).not.toHaveBeenCalled(); // …and is gated
    });

    it("skips the leaving notice when the subscription never confirmed", async () => {
      await mount();
      controller()?.disconnect(); // pre-confirmation teardown
      expect(performMock).not.toHaveBeenCalled();
      expect(unsubscribeMock).toHaveBeenCalledOnce();
    });

    it("skips the pagehide leaving notice during an outage", async () => {
      await mount();
      confirm();
      performMock.mockClear();
      drop();
      window.dispatchEvent(new Event("pagehide")); // undeliverable: gated
      expect(performMock).not.toHaveBeenCalled();
    });

    it("publishes the rejected hook and keeps beacons gated for good", async () => {
      await mount();
      reject();
      expect(root().getAttribute("data-presence-rejected")).toBe("true");
      await vi.advanceTimersByTimeAsync(31_000); // heartbeats stay gated
      expect(performMock).not.toHaveBeenCalled();

      controller()?.disconnect();
      expect(root().hasAttribute("data-presence-rejected")).toBe(false);
    });

    it("clears a stale rejected hook from a Turbo cache snapshot", async () => {
      await mount(`
        <div data-controller="stimeo--presence" data-presence-rejected="true"
             data-stimeo--presence-channel-value="PresenceChannel"
             data-stimeo--presence-id-value="alice"></div>`);
      // The fresh subscription re-decides rejection; the snapshot must not.
      expect(root().hasAttribute("data-presence-rejected")).toBe(false);
    });
  });

  describe("peer tracking", () => {
    it("tracks a peer, flips the hooks, and renders its clone", async () => {
      await mount();
      receive("bob", "Bob");
      expect(root().getAttribute("data-present")).toBe("true");
      expect(root().getAttribute("data-present-count")).toBe("1");
      expect(count().textContent).toBe("1");
      expect(renderedNames()).toEqual(["Bob"]);
    });

    it("drops the own echo (same id)", async () => {
      await mount();
      receive("alice", "Alice");
      expect(root().hasAttribute("data-present")).toBe(false);
      expect(renderedNames()).toEqual([]);
    });

    it("answers an unknown peer's beacon so its roster converges", async () => {
      await mount();
      confirm();
      performMock.mockClear();
      await vi.advanceTimersByTimeAsync(3000); // clear the initial-beacon throttle window
      receive("bob", "Bob");
      expect(performMock).toHaveBeenCalledWith("appear", { id: "alice", name: "Alice" });

      performMock.mockClear();
      receive("carol", "Carol"); // within the throttle window: deferred, not dropped
      expect(performMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2100); // trailing edge fires exactly once
      expect(performMock).toHaveBeenCalledTimes(1);

      performMock.mockClear();
      await vi.advanceTimersByTimeAsync(3000);
      receive("bob", "Bob"); // known peer: never answered
      expect(performMock).not.toHaveBeenCalled();
    });

    it("expires a silent peer after timeout, keeping beaconing peers", async () => {
      await mount();
      receive("bob", "Bob");
      await vi.advanceTimersByTimeAsync(20_000);
      receive("carol", "Carol");
      await vi.advanceTimersByTimeAsync(25_000); // bob: 45s silent; carol: 25s
      expect(renderedNames()).toEqual(["Carol"]);

      await vi.advanceTimersByTimeAsync(20_000);
      expect(renderedNames()).toEqual([]);
      expect(root().getAttribute("data-present")).toBe("false");
      expect(root().getAttribute("data-present-count")).toBe("0");
    });

    it("restarts a peer's expiry timer on every beacon", async () => {
      await mount();
      receive("bob", "Bob");
      await vi.advanceTimersByTimeAsync(30_000);
      receive("bob", "Bob");
      await vi.advanceTimersByTimeAsync(30_000); // 60s since first, 30s since last
      expect(renderedNames()).toEqual(["Bob"]);
    });

    it("removes a peer immediately on a leaving notice", async () => {
      await mount();
      receive("bob", "Bob");
      receive("bob", "", true);
      expect(renderedNames()).toEqual([]);
      expect(root().getAttribute("data-present")).toBe("false");
    });

    it("leaves no expiry pending for a peer that leaves", async () => {
      await mount();
      receive("bob", "Bob"); // arms bob's expiry
      const pending = vi.getTimerCount();
      receive("bob", "", true);
      expect(vi.getTimerCount()).toBe(pending - 1);
    });

    it("updates the rendered name when a peer renames", async () => {
      await mount();
      receive("bob", "Bob");
      receive("bob", "Robert");
      expect(renderedNames()).toEqual(["Robert"]);
    });

    it("ignores malformed beacons", async () => {
      await mount();
      mixin?.received?.(null);
      mixin?.received?.({});
      mixin?.received?.({ id: 42 });
      expect(root().hasAttribute("data-present")).toBe(false);
    });
  });

  describe("presentation channels", () => {
    it("renders the known-empty count immediately on connect", async () => {
      await mount(`
        <div data-controller="stimeo--presence"
             data-stimeo--presence-channel-value="PresenceChannel"
             data-stimeo--presence-id-value="alice">
          <span data-stimeo--presence-target="count" data-zero="No one else is here"></span>
        </div>`);
      expect(count().textContent).toBe("No one else is here");
      // The data-present* hooks stay absent until the first beacon (contract).
      expect(root().hasAttribute("data-present")).toBe(false);
    });

    it("localizes the count via data-zero / data-one / data-other templates", async () => {
      await mount();
      count().setAttribute("data-zero", "誰も見ていません");
      count().setAttribute("data-one", "%{count} 人が閲覧中");
      count().setAttribute("data-other", "%{count} 人が閲覧中");
      receive("bob", "Bob");
      expect(count().textContent).toBe("1 人が閲覧中");
      receive("carol", "Carol");
      expect(count().textContent).toBe("2 人が閲覧中");
      receive("bob", "", true);
      receive("carol", "", true);
      expect(count().textContent).toBe("誰も見ていません");
    });

    it("dispatches join / leave / change with the roster", async () => {
      await mount();
      const events: Array<[string, unknown]> = [];
      for (const name of ["join", "leave", "change"]) {
        root().addEventListener(`stimeo--presence:${name}`, (event) => {
          events.push([name, (event as CustomEvent).detail]);
        });
      }
      receive("bob", "Bob");
      receive("bob", "", true);
      expect(events).toEqual([
        ["change", { users: [{ id: "bob", name: "Bob" }] }],
        ["join", { id: "bob", name: "Bob" }],
        ["change", { users: [] }],
        ["leave", { id: "bob" }],
      ]);
    });

    it("reports a rename through change", async () => {
      await mount();
      receive("bob", "Bob");
      const changes: unknown[] = [];
      root().addEventListener("stimeo--presence:change", (event) => {
        changes.push((event as CustomEvent).detail);
      });
      receive("bob", "Robert");
      expect(changes).toEqual([{ users: [{ id: "bob", name: "Robert" }] }]);
    });

    it("works without any rendering targets (hooks + events only)", async () => {
      await mount(`
        <div data-controller="stimeo--presence"
             data-stimeo--presence-channel-value="PresenceChannel"
             data-stimeo--presence-id-value="alice"></div>`);
      receive("bob", "Bob");
      expect(root().getAttribute("data-present")).toBe("true");
      expect(root().getAttribute("data-present-count")).toBe("1");
    });
  });

  describe("Turbo resilience", () => {
    it("clears stale presence state a cache restore may have snapshotted", async () => {
      await mount(`
        <div data-controller="stimeo--presence" data-present="true" data-present-count="2"
             data-stimeo--presence-channel-value="PresenceChannel"
             data-stimeo--presence-id-value="alice">
          <span data-stimeo--presence-target="count">2</span>
          <ul aria-label="Currently viewing" data-stimeo--presence-target="list">
            <li data-presence-id="bob">Bob</li>
          </ul>
          <template data-stimeo--presence-target="template"><li></li></template>
        </div>`);
      expect(root().hasAttribute("data-present")).toBe(false);
      // The snapshotted "2" is replaced by the known-empty count (bare number
      // fallback — the fixture's count target carries no templates).
      expect(count().textContent).toBe("0");
      expect(renderedNames()).toEqual([]);
    });

    it("stops timers and clears the roster on disconnect", async () => {
      await mount();
      receive("bob", "Bob");
      controller()?.disconnect();
      expect(root().hasAttribute("data-present")).toBe(false);
      expect(renderedNames()).toEqual([]);

      performMock.mockClear();
      await vi.advanceTimersByTimeAsync(60_000); // no heartbeat survives teardown
      expect(performMock).not.toHaveBeenCalled();
    });
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount(`<main>${fixture}</main>`);
    receive("bob", "Bob");
    vi.useRealTimers(); // axe schedules its own timers; fake timers stall it
    await expectNoA11yViolations(document.body);
  });

  // --- Speech-order regression ------------------------------------------------

  it("announces a joining peer through the count text and the roster list", async () => {
    await mount();
    vi.useRealTimers(); // the virtual reader awaits real async work
    const container = root();
    const empty = await captureSpeech({ container, steps: 1 });
    // Freeze the whole ordered array: an empty roster announces just its shell.
    expect(empty).toEqual(["0", "list, Currently viewing"]);

    receive("bob", "Bob");
    const joined = await captureSpeech({ container, steps: 4 });
    expect(joined).toEqual([
      "1",
      "list, Currently viewing",
      "listitem, level 1, position 1, set size 1",
      "Bob",
      "end of listitem, level 1, position 1, set size 1",
    ]);
  });
  // --- Speaking for a peer (multiple elements on one identifier) --------------

  describe("the leaving notice", () => {
    /** Two elements on one channel, so both ride the same wire subscription. */
    const pair = (firstId: string, secondId: string) => `
      <div data-controller="stimeo--presence" data-testid="first"
           data-stimeo--presence-channel-value="PresenceChannel"
           data-stimeo--presence-params-value='{"room":"doc_7"}'
           data-stimeo--presence-id-value="${firstId}"></div>
      <div data-controller="stimeo--presence" data-testid="second"
           data-stimeo--presence-channel-value="PresenceChannel"
           data-stimeo--presence-params-value='{"room":"doc_7"}'
           data-stimeo--presence-id-value="${secondId}"></div>`;
    const at = (testid: string) =>
      application?.getControllerForElementAndIdentifier(
        document.querySelector(`[data-testid='${testid}']`) as Element,
        "stimeo--presence",
      ) as PresenceController | null;
    const leaveNotices = () =>
      performMock.mock.calls.filter(
        ([, data]) => (data as { leaving?: unknown })?.leaving === true,
      );

    it("stays silent while a sibling still speaks for the same peer", async () => {
      await mount(pair("alice", "alice"));
      expect(mixins).toHaveLength(1); // one wire subscription for the identifier
      confirm();
      performMock.mockClear();

      at("first")?.disconnect();
      expect(leaveNotices()).toEqual([]);
      expect(unsubscribeMock).not.toHaveBeenCalled();
    });

    it("goes out when the last element speaking for the peer leaves", async () => {
      await mount(pair("alice", "alice"));
      confirm();
      at("first")?.disconnect();
      performMock.mockClear();

      at("second")?.disconnect();
      expect(leaveNotices()).toEqual([["appear", { id: "alice", leaving: true }]]);
      expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    });

    it("claims its voice again when the same element reconnects after a move", async () => {
      await mount(pair("alice", "alice"));
      confirm();
      const first = document.querySelector("[data-testid='first']") as HTMLElement;
      // An in-page move: Stimulus disconnects and reconnects the same instance.
      document.body.appendChild(first);
      await vi.advanceTimersByTimeAsync(20);
      performMock.mockClear();

      at("second")?.disconnect();
      expect(leaveNotices()).toEqual([]); // the moved element still speaks for alice

      at("first")?.disconnect();
      expect(leaveNotices()).toEqual([["appear", { id: "alice", leaving: true }]]);
    });

    it("spends its claim on release, so a channel-less reconnect speaks for nobody", async () => {
      await mount(`
        <div data-controller="stimeo--presence" data-testid="stale"
             data-stimeo--presence-channel-value="PresenceChannel"
             data-stimeo--presence-params-value='{"room":"doc_7"}'
             data-stimeo--presence-id-value="alice"></div>`);
      confirm();
      const stale = document.querySelector("[data-testid='stale']") as HTMLElement;
      stale.removeAttribute("data-stimeo--presence-channel-value");
      document.body.appendChild(stale); // reconnects with no channel: claims nothing
      await vi.advanceTimersByTimeAsync(20);

      document.body.insertAdjacentHTML("beforeend", pair("alice", "alice"));
      await vi.advanceTimersByTimeAsync(20);
      mixins.at(-1)?.connected?.();
      performMock.mockClear();

      stale.remove(); // must not spend a voice the two siblings own
      await vi.advanceTimersByTimeAsync(20);
      at("first")?.disconnect();
      expect(leaveNotices()).toEqual([]); // "second" still speaks for alice
    });

    it("goes out per peer when siblings on one channel claim different ids", async () => {
      await mount(pair("alice", "bob"));
      expect(mixins).toHaveLength(1); // still one wire subscription
      confirm();
      performMock.mockClear();

      at("first")?.disconnect();
      expect(leaveNotices()).toEqual([["appear", { id: "alice", leaving: true }]]);
      performMock.mockClear();

      at("second")?.disconnect();
      expect(leaveNotices()).toEqual([["appear", { id: "bob", leaving: true }]]);
    });

    it("goes out when another controller shares the identifier's wire", async () => {
      await mount(`
        <div data-controller="stimeo--presence" data-testid="first"
             data-stimeo--presence-channel-value="PresenceChannel"
             data-stimeo--presence-params-value='{"room":"doc_7"}'
             data-stimeo--presence-id-value="alice"></div>`);
      // A second rider on the same identifier — a typing indicator, a live counter —
      // is a member of the wire subscription but speaks for no presence peer.
      const lodger = createConfirmedSubscription({ channel: "PresenceChannel", room: "doc_7" }, {});
      expect(mixins).toHaveLength(1);
      confirm();
      performMock.mockClear();

      at("first")?.disconnect();
      expect(leaveNotices()).toEqual([["appear", { id: "alice", leaving: true }]]);
      lodger.unsubscribe();
    });

    it("still sends from every element on pagehide, where the whole page goes", async () => {
      await mount(pair("alice", "alice"));
      confirm();
      performMock.mockClear();

      window.dispatchEvent(new Event("pagehide"));
      expect(leaveNotices()).toEqual([
        ["appear", { id: "alice", leaving: true }],
        ["appear", { id: "alice", leaving: true }],
      ]);
    });

    it("sends nothing for an element that never claimed a peer", async () => {
      await mount(`
        <div data-controller="stimeo--presence"
             data-stimeo--presence-channel-value="PresenceChannel"></div>`);
      confirm();
      performMock.mockClear();
      controller()?.disconnect();
      expect(performMock).not.toHaveBeenCalled();
    });
  });

  // --- Identifier parameters --------------------------------------------------

  describe("the subscription identifier", () => {
    it("keeps the declared channel when params name one too", async () => {
      await mount(`
        <div data-controller="stimeo--presence"
             data-stimeo--presence-channel-value="PresenceChannel"
             data-stimeo--presence-params-value='{"channel":"OtherChannel","room":"doc_7"}'
             data-stimeo--presence-id-value="alice"></div>`);
      expect(createdWith).toEqual({ channel: "PresenceChannel", room: "doc_7" });
      // Key order decides the identifier Action Cable derives, so pin it.
      expect(Object.keys(createdWith as Record<string, unknown>)).toEqual(["channel", "room"]);
    });

    it("subscribes to nothing when only params name a channel", async () => {
      await mount(`
        <div data-controller="stimeo--presence"
             data-stimeo--presence-params-value='{"channel":"OtherChannel"}'
             data-stimeo--presence-id-value="alice"></div>`);
      expect(createdWith).toBeNull();
    });

    it("falls back to no parameters when the declaration is not an object", async () => {
      await mount(`
        <div data-controller="stimeo--presence"
             data-stimeo--presence-channel-value="PresenceChannel"
             data-stimeo--presence-params-value='{'
             data-stimeo--presence-id-value="alice"></div>`);
      expect(createdWith).toEqual({ channel: "PresenceChannel" });
    });
  });

  // --- Declared delays --------------------------------------------------------

  describe("heartbeat and timeout", () => {
    const withDelays = (heartbeat: string, timeout: string) => `
      <div data-controller="stimeo--presence"
           data-stimeo--presence-channel-value="PresenceChannel"
           data-stimeo--presence-id-value="alice"
           data-stimeo--presence-heartbeat-value="${heartbeat}"
           data-stimeo--presence-timeout-value="${timeout}"></div>`;
    const beacons = () =>
      performMock.mock.calls.filter(
        ([, data]) => (data as { leaving?: unknown })?.leaving !== true,
      );

    it("honours declared delays that differ from the defaults", async () => {
      await mount(withDelays("5000", "12000"));
      confirm();
      performMock.mockClear();
      await vi.advanceTimersByTimeAsync(11_000); // two of the declared 5 s heartbeats
      expect(beacons()).toHaveLength(2);

      receive("bob", "Bob");
      await vi.advanceTimersByTimeAsync(11_500); // still inside the declared 12 s silence
      expect(root().getAttribute("data-present")).toBe("true");
      await vi.advanceTimersByTimeAsync(1000); // past it
      expect(root().getAttribute("data-present")).toBe("false");
    });

    it("keeps the largest delay a timer can actually hold", async () => {
      await mount(withDelays("2147483647", "2147483647"));
      confirm();
      performMock.mockClear();

      await vi.advanceTimersByTimeAsync(15_500); // the default heartbeat would have fired
      expect(beacons()).toHaveLength(0);
      receive("bob", "Bob");
      await vi.advanceTimersByTimeAsync(40_500); // and the default expiry would have run
      expect(root().getAttribute("data-present")).toBe("true");
    });

    for (const declared of ["abc", "-1", "0", "1e12"]) {
      it(`falls back to the defaults when the delays are declared as ${declared}`, async () => {
        await mount(withDelays(declared, declared));
        confirm();
        performMock.mockClear();

        await vi.advanceTimersByTimeAsync(14_000); // before the default 15 s heartbeat
        expect(beacons()).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1500);
        expect(beacons()).toHaveLength(1);

        receive("bob", "Bob");
        await vi.advanceTimersByTimeAsync(39_000); // 39 s of silence: not yet expired
        expect(root().getAttribute("data-present")).toBe("true");
        await vi.advanceTimersByTimeAsync(1500); // past the default 40 s expiry
        expect(root().getAttribute("data-present")).toBe("false");
      });
    }
  });

  // --- Opt-in announcements ---------------------------------------------------

  describe("announcements", () => {
    const announcements: string[] = [];
    const listen = (event: Event) => {
      announcements.push((event as CustomEvent<{ message: string }>).detail.message);
    };
    beforeEach(() => {
      announcements.length = 0;
      window.addEventListener("stimeo--announcer:announce", listen);
    });
    afterEach(() => {
      window.removeEventListener("stimeo--announcer:announce", listen);
    });

    const withTemplates = (join: string, leave: string) => `
      <div data-controller="stimeo--presence"
           data-stimeo--presence-channel-value="PresenceChannel"
           data-stimeo--presence-id-value="alice"
           data-stimeo--presence-announce-join-text-value="${join}"
           data-stimeo--presence-announce-leave-text-value="${leave}"></div>`;

    it("says nothing at all while both templates are undeclared", async () => {
      await mount();
      receive("bob", "Bob");
      await vi.advanceTimersByTimeAsync(500);
      receive("bob", "", true);
      await vi.advanceTimersByTimeAsync(500);
      expect(announcements).toEqual([]);
    });

    it("announces a join and a leave through the shared announcer", async () => {
      await mount(withTemplates("{name} joined, {count} here", "{name} left, {count} here"));
      receive("bob", "Bob");
      await vi.advanceTimersByTimeAsync(500);
      expect(announcements).toEqual(["Bob joined, 1 here"]);

      receive("bob", "", true);
      await vi.advanceTimersByTimeAsync(500);
      expect(announcements).toEqual(["Bob joined, 1 here", "Bob left, 0 here"]);
    });

    it("collapses a burst into one announcement", async () => {
      await mount(withTemplates("{name} joined, {count} here", ""));
      receive("bob", "Bob");
      receive("carol", "Carol");
      await vi.advanceTimersByTimeAsync(500);
      expect(announcements).toEqual(["Carol joined, 2 here"]);
    });

    it("drops an announcement still pending when the element disconnects", async () => {
      await mount(withTemplates("{name} joined, {count} here", ""));
      receive("bob", "Bob");
      controller()?.disconnect();
      await vi.advanceTimersByTimeAsync(500);
      expect(announcements).toEqual([]);
    });

    it("keeps an undeclared direction from cancelling the other one", async () => {
      await mount(withTemplates("{name} joined, {count} here", ""));
      receive("bob", "Bob");
      receive("bob", "", true); // a leave with no template must not swallow the join
      await vi.advanceTimersByTimeAsync(500);
      expect(announcements).toEqual(["Bob joined, 1 here"]);
    });
  });

  // --- Target replacement -----------------------------------------------------

  describe("replaced targets", () => {
    it("draws the roster into a list target swapped in empty", async () => {
      await mount();
      receive("bob", "Bob");
      receive("carol", "Carol");
      const replacement = document.createElement("ul");
      replacement.setAttribute("data-stimeo--presence-target", "list");
      list().replaceWith(replacement);
      await vi.advanceTimersByTimeAsync(20);
      expect(renderedNames()).toEqual(["Bob", "Carol"]);
    });

    it("paints the roster size into a count target swapped in blank", async () => {
      await mount();
      receive("bob", "Bob");
      const replacement = document.createElement("span");
      replacement.setAttribute("data-stimeo--presence-target", "count");
      count().replaceWith(replacement);
      await vi.advanceTimersByTimeAsync(20);
      expect(count().textContent).toBe("1");
    });

    it("clears clones a replacement carries that the roster does not know", async () => {
      await mount();
      const replacement = document.createElement("ul");
      replacement.setAttribute("data-stimeo--presence-target", "list");
      replacement.innerHTML = `<li data-presence-id="ghost">Ghost</li>`;
      list().replaceWith(replacement);
      await vi.advanceTimersByTimeAsync(20);
      expect(renderedNames()).toEqual([]);
    });
  });

  it("draws the roster into count and list targets that arrive where there were none", async () => {
    await mount(`
      <div data-controller="stimeo--presence"
           data-stimeo--presence-channel-value="PresenceChannel"
           data-stimeo--presence-id-value="alice">
        <template data-stimeo--presence-target="template">
          <li><span data-presence-name></span></li>
        </template>
      </div>`);
    receive("bob", "Bob");
    // Nothing departs here, so the arrivals are the only callbacks that can draw them.
    const lateCount = document.createElement("span");
    lateCount.setAttribute("data-stimeo--presence-target", "count");
    const lateList = document.createElement("ul");
    lateList.setAttribute("data-stimeo--presence-target", "list");
    root().append(lateCount, lateList);
    await vi.advanceTimersByTimeAsync(20);

    expect(lateCount.textContent).toBe("1");
    expect(renderedNames()).toEqual(["Bob"]);
  });

  describe("targets that stay after an earlier one leaves", () => {
    /** Inserts an empty copy after `original`, then removes `original` a task later. */
    const leaveBehindSuccessor = async (original: HTMLElement) => {
      const successor = original.cloneNode(false) as HTMLElement;
      original.after(successor);
      await vi.advanceTimersByTimeAsync(20);
      original.remove();
      await vi.advanceTimersByTimeAsync(20);
      return successor;
    };

    it("paints the roster size into the count target that stays", async () => {
      await mount();
      receive("bob", "Bob");
      const successor = await leaveBehindSuccessor(count());

      expect(count()).toBe(successor);
      expect(successor.textContent).toBe("1");
    });

    it("draws the roster into the list target that stays", async () => {
      await mount();
      receive("bob", "Bob");
      receive("carol", "Carol");
      const successor = await leaveBehindSuccessor(list());

      expect(list()).toBe(successor);
      expect(renderedNames()).toEqual(["Bob", "Carol"]);
    });

    it("says nothing when it draws the count and list targets that stay", async () => {
      await mount();
      receive("bob", "Bob");
      const events: string[] = [];
      const listening = new AbortController();
      for (const type of [
        "stimeo--presence:join",
        "stimeo--presence:leave",
        "stimeo--presence:change",
        "stimeo--presence:reconcile",
        "change",
      ]) {
        root().addEventListener(type, () => events.push(type), { signal: listening.signal });
      }
      await leaveBehindSuccessor(count());
      await leaveBehindSuccessor(list());
      listening.abort();

      expect(count().textContent).toBe("1");
      expect(renderedNames()).toEqual(["Bob"]);
      expect(events).toEqual([]);
    });

    it("keeps the hooks when its only count and list targets leave", async () => {
      await mount();
      receive("bob", "Bob");
      count().remove();
      list().remove();
      await vi.advanceTimersByTimeAsync(20);

      expect(() => controller()?.countTargetDisconnected()).not.toThrow();
      expect(() => controller()?.listTargetDisconnected()).not.toThrow();
      expect(root().getAttribute("data-present-count")).toBe("1");
    });

    it("leaves the blanked count alone for a departure delivered after disconnect", async () => {
      await mount();
      receive("bob", "Bob");
      const instance = controller() as PresenceController;
      instance.disconnect();

      instance.countTargetDisconnected();

      expect(count().textContent).toBe("");
    });

    it("leaves the list alone for a departure delivered after disconnect", async () => {
      await mount();
      const instance = controller() as PresenceController;
      instance.disconnect();
      // The page renders its own roster once the controller is gone; the departure
      // Stimulus delivers after `disconnect()` must not clear it.
      list().innerHTML = `<li data-presence-id="bob">Bob</li>`;

      instance.listTargetDisconnected();

      expect(renderedNames()).toEqual(["Bob"]);
    });
  });

  // --- Clone bookkeeping ------------------------------------------------------

  describe("clones", () => {
    it("appends the template root alone, leaving no stray nodes behind", async () => {
      await mount();
      receive("bob", "Bob");
      receive("carol", "Carol");
      receive("dave", "Dave");
      // The template is authored across lines, so a fragment append would carry
      // its surrounding whitespace text nodes into the list as well.
      expect(list().children).toHaveLength(3);
      expect(list().childNodes).toHaveLength(3);
    });

    it("appends nothing when the template holds no element", async () => {
      await mount(`
        <div data-controller="stimeo--presence"
             data-stimeo--presence-channel-value="PresenceChannel"
             data-stimeo--presence-id-value="alice">
          <ul data-stimeo--presence-target="list"></ul>
          <template data-stimeo--presence-target="template">just text</template>
        </div>`);
      receive("bob", "Bob");
      expect(list().childNodes).toHaveLength(0);
      expect(root().getAttribute("data-present-count")).toBe("1");
    });

    it("writes the name onto a clone root that is its own name slot", async () => {
      await mount(`
        <div data-controller="stimeo--presence"
             data-stimeo--presence-channel-value="PresenceChannel"
             data-stimeo--presence-id-value="alice">
          <ul data-stimeo--presence-target="list"></ul>
          <template data-stimeo--presence-target="template"><li data-presence-name></li></template>
        </div>`);
      receive("bob", "Bob");
      expect(renderedNames()).toEqual(["Bob"]);
      receive("bob", "Bobby");
      expect(renderedNames()).toEqual(["Bobby"]);
    });

    it("tracks a peer with no list target at all", async () => {
      await mount(`
        <div data-controller="stimeo--presence"
             data-stimeo--presence-channel-value="PresenceChannel"
             data-stimeo--presence-id-value="alice"></div>`);
      receive("bob", "Bob");
      expect(root().getAttribute("data-present-count")).toBe("1");
      receive("bob", "", true);
      expect(root().getAttribute("data-present-count")).toBe("0");
    });
  });

  // --- Beacon shape -----------------------------------------------------------

  describe("incoming beacons", () => {
    it("renders an empty name when the beacon carries a non-string one", async () => {
      await mount();
      mixin?.received?.({ id: "bob", name: 42 });
      expect(renderedNames()).toEqual([""]);
      expect(root().getAttribute("data-present-count")).toBe("1");
    });

    it("ignores a leaving notice for a peer it never saw", async () => {
      await mount();
      const seen: unknown[] = [];
      root().addEventListener("stimeo--presence:leave", (event) => {
        seen.push((event as CustomEvent).detail);
      });
      receive("ghost", "", true);
      expect(seen).toEqual([]);
      expect(root().hasAttribute("data-present")).toBe(false);
    });
  });

  // --- Count copy -------------------------------------------------------------

  describe("count templates", () => {
    const withCopy = (attrs: string) => `
      <div data-controller="stimeo--presence"
           data-stimeo--presence-channel-value="PresenceChannel"
           data-stimeo--presence-id-value="alice">
        <span data-stimeo--presence-target="count" ${attrs}></span>
      </div>`;

    it("falls back to the other copy when only it is declared", async () => {
      await mount(withCopy(`data-other="%{count} viewing"`));
      expect(count().textContent).toBe("0 viewing");
      receive("bob", "Bob");
      expect(count().textContent).toBe("1 viewing");
    });

    it("uses the one copy for a single peer and the other copy beyond it", async () => {
      await mount(withCopy(`data-one="one person" data-other="%{count} people"`));
      receive("bob", "Bob");
      expect(count().textContent).toBe("one person");
      receive("carol", "Carol");
      expect(count().textContent).toBe("2 people");
    });

    it("uses the zero copy for an empty roster", async () => {
      await mount(withCopy(`data-zero="nobody" data-other="%{count} people"`));
      expect(count().textContent).toBe("nobody");
      receive("bob", "Bob");
      expect(count().textContent).toBe("1 people");
    });

    it("blanks the count copy on teardown", async () => {
      await mount(withCopy(`data-other="%{count} viewing"`));
      receive("bob", "Bob");
      expect(count().textContent).toBe("1 viewing");
      controller()?.disconnect();
      expect(count().textContent).toBe("");
    });
  });

  // --- Following the declaration ----------------------------------------------

  describe("a declaration that changes while connected", () => {
    /** One wire subscription the double opened. */
    interface Wire {
      descriptor: Record<string, unknown> | string;
      mixin: CableSubscriptionMixin;
    }
    let wires: Wire[] = [];
    /** Every send and release across the wires, in order, as `<wire>:<what>`. */
    let log: string[] = [];

    beforeEach(() => {
      wires = [];
      log = [];
      setCableConsumer({
        subscriptions: {
          create(channel, subscriptionMixin) {
            const index = wires.length;
            wires.push({ descriptor: channel, mixin: subscriptionMixin });
            return {
              perform: (action: string, data?: Record<string, unknown>) => {
                log.push(`${index}:${action}:${JSON.stringify(data)}`);
              },
              unsubscribe: () => {
                log.push(`${index}:unsubscribe`);
              },
            };
          },
        },
      });
    });

    const wire = (index: number) => wires[index]?.mixin;
    const leaving = (index: number, id: string) =>
      `${index}:appear:${JSON.stringify({ id, leaving: true })}`;
    const beacon = (index: number, id: string, name = "Alice") =>
      `${index}:appear:${JSON.stringify({ id, name })}`;

    /**
     * Rewrites a declaration on `element` and delivers its Value callback directly,
     * since happy-dom does not reliably run it for an attribute write. A Value
     * without a callback is left to whatever reads it next.
     */
    const declare = (name: string, value: string, element = root()) => {
      element.setAttribute(`data-stimeo--presence-${name}-value`, value);
      const owner = application.getControllerForElementAndIdentifier(element, "stimeo--presence");
      const callback: unknown = Reflect.get(owner ?? {}, `${name}ValueChanged`);
      if (typeof callback === "function") callback.call(owner);
    };
    /** Lets the batch of callbacks settle into the pass it schedules. */
    const settle = () => vi.advanceTimersByTimeAsync(0);
    const events = () => {
      const seen: string[] = [];
      for (const name of ["join", "leave", "change"]) {
        root().addEventListener(`stimeo--presence:${name}`, () => seen.push(name));
      }
      return seen;
    };

    it("moves a confirmed subscription to the identifier new params name", async () => {
      await mount();
      wire(0)?.connected?.();
      wire(0)?.received?.({ id: "bob", name: "Bob" });
      log.length = 0;
      const seen = events();

      declare("params", '{"room":"doc_8"}');
      await settle();
      expect(wires.map((each) => each.descriptor)).toEqual([
        { channel: "PresenceChannel", room: "doc_7" },
        { channel: "PresenceChannel", room: "doc_8" },
      ]);
      // The leaving notice goes out on the identifier being left, before it is released.
      expect(log).toEqual([leaving(0, "alice"), "0:unsubscribe"]);
      // The old room's roster is not a fact of the new one, and dropping it reports nothing.
      expect(renderedNames()).toEqual([]);
      expect(root().hasAttribute("data-present")).toBe(false);
      expect(count().textContent).toBe("0");
      expect(seen).toEqual([]);

      wire(1)?.connected?.();
      expect(log.at(-1)).toBe(beacon(1, "alice"));
    });

    it("releases an unconfirmed subscription without a leaving notice", async () => {
      await mount();
      declare("channel", "RoomChannel");
      await settle();
      expect(log).toEqual(["0:unsubscribe"]);
      expect(wires[1]?.descriptor).toEqual({ channel: "RoomChannel", room: "doc_7" });

      wire(0)?.connected?.(); // the identifier it left confirms late
      expect(log).toEqual(["0:unsubscribe"]);
    });

    it("sends no leaving notice from a subscription whose connection is down", async () => {
      await mount();
      wire(0)?.connected?.();
      wire(0)?.disconnected?.();
      log.length = 0;

      declare("channel", "RoomChannel");
      await settle();
      expect(log).toEqual(["0:unsubscribe"]);
    });

    it("keeps a message from the identifier it left out of the new roster", async () => {
      await mount();
      wire(0)?.connected?.();
      declare("params", '{"room":"doc_8"}');
      await settle();

      wire(0)?.received?.({ id: "bob", name: "Bob" });
      expect(renderedNames()).toEqual([]);
      wire(1)?.received?.({ id: "carol", name: "Carol" });
      expect(renderedNames()).toEqual(["Carol"]);
    });

    it("counts a peer of the room it left as a newcomer in the new one", async () => {
      await mount();
      wire(0)?.received?.({ id: "bob", name: "Bob" });
      declare("params", '{"room":"doc_8"}');
      await settle();
      const seen = events();

      wire(1)?.received?.({ id: "bob", name: "Bob" });
      expect(renderedNames()).toEqual(["Bob"]);
      expect(seen).toEqual(["change", "join"]);
    });

    it("leaves no expiry of the room it left pending", async () => {
      await mount();
      wire(0)?.received?.({ id: "bob", name: "Bob" }); // arms bob's expiry
      const pending = vi.getTimerCount();

      declare("channel", "RoomChannel");
      await settle();
      expect(vi.getTimerCount()).toBe(pending - 1); // the heartbeat is re-armed, the expiry gone
    });

    it("ignores a rejection that arrives for the identifier it left", async () => {
      await mount();
      declare("params", '{"room":"doc_8"}');
      await settle();

      wire(0)?.rejected?.();
      expect(root().hasAttribute("data-presence-rejected")).toBe(false);
      wire(1)?.rejected?.();
      expect(root().getAttribute("data-presence-rejected")).toBe("true");
    });

    it("clears the rejected hook when the identifier changes", async () => {
      await mount();
      wire(0)?.rejected?.();
      declare("channel", "RoomChannel");
      await settle();
      expect(root().hasAttribute("data-presence-rejected")).toBe(false);
    });

    it("lets no expiry or announcement of the old room reach the new one", async () => {
      await mount(`
        <div data-controller="stimeo--presence"
             data-stimeo--presence-channel-value="PresenceChannel"
             data-stimeo--presence-id-value="alice"
             data-stimeo--presence-timeout-value="5000"
             data-stimeo--presence-announce-join-text-value="{name} joined">
          <ul data-stimeo--presence-target="list"></ul>
          <template data-stimeo--presence-target="template"><li data-presence-name></li></template>
        </div>`);
      const announced: string[] = [];
      const onAnnounce = (event: Event) => {
        announced.push((event as CustomEvent<{ message: string }>).detail.message);
      };
      window.addEventListener("stimeo--announcer:announce", onAnnounce);
      try {
        wire(0)?.received?.({ id: "bob", name: "Bob" }); // arms bob's expiry and an announcement
        declare("channel", "RoomChannel");
        await settle();
        const seen = events();
        await vi.advanceTimersByTimeAsync(6000); // past both
        expect(announced).toEqual([]);
        expect(seen).toEqual([]); // no expiry of bob runs in the new room
      } finally {
        window.removeEventListener("stimeo--announcer:announce", onAnnounce);
      }
    });

    it("moves once when several declarations change together", async () => {
      await mount();
      wire(0)?.connected?.();
      log.length = 0;

      declare("channel", "RoomChannel");
      declare("params", '{"room":"doc_8"}');
      declare("id", "bob");
      declare("heartbeat", "4000");
      await settle();
      expect(wires.map((each) => each.descriptor)).toEqual([
        { channel: "PresenceChannel", room: "doc_7" },
        { channel: "RoomChannel", room: "doc_8" },
      ]);
      // The notice names the id peers knew, not the one declared in the same batch.
      expect(log).toEqual([leaving(0, "alice"), "0:unsubscribe"]);

      wire(1)?.connected?.();
      expect(log.at(-1)).toBe(beacon(1, "bob"));
      log.length = 0;
      await vi.advanceTimersByTimeAsync(4000); // the new subscription beats on the new period
      expect(log).toEqual([beacon(1, "bob")]);
    });

    it("keeps everything when a callback repeats the declaration", async () => {
      await mount();
      wire(0)?.connected?.();
      wire(0)?.received?.({ id: "bob", name: "Bob" });
      log.length = 0;

      const repeated: Array<[string, string]> = [
        ["channel", "PresenceChannel"],
        ["params", '{"room":"doc_7"}'],
        ["id", "alice"],
        ["heartbeat", "15000"],
      ];
      for (const [name, value] of repeated) declare(name, value);
      await settle();
      expect(wires).toHaveLength(1);
      expect(log).toEqual([]);
      expect(renderedNames()).toEqual(["Bob"]);
    });

    it("opens a subscription when a channel is declared later", async () => {
      await mount(`
        <div data-controller="stimeo--presence"
             data-stimeo--presence-id-value="alice" data-stimeo--presence-name-value="Alice"></div>`);
      expect(wires).toHaveLength(0);

      declare("channel", "PresenceChannel");
      await settle();
      expect(wires.map((each) => each.descriptor)).toEqual([{ channel: "PresenceChannel" }]);
      wire(0)?.connected?.();
      expect(log).toEqual([beacon(0, "alice")]);

      window.dispatchEvent(new Event("pagehide"));
      expect(log.at(-1)).toBe(leaving(0, "alice"));
    });

    it("closes the subscription when the channel is removed", async () => {
      await mount();
      wire(0)?.connected?.();
      wire(0)?.received?.({ id: "bob", name: "Bob" });
      log.length = 0;

      declare("channel", "");
      await settle();
      expect(log).toEqual([leaving(0, "alice"), "0:unsubscribe"]);
      expect(renderedNames()).toEqual([]);

      log.length = 0;
      await vi.advanceTimersByTimeAsync(60_000); // no heartbeat outlives the subscription
      window.dispatchEvent(new Event("pagehide"));
      expect(log).toEqual([]);
    });

    it("leaves from the identifier it moved to", async () => {
      await mount();
      wire(0)?.connected?.();
      declare("params", '{"room":"doc_8"}');
      await settle();
      wire(1)?.connected?.();
      log.length = 0;

      controller()?.disconnect();
      expect(log).toEqual([leaving(1, "alice"), "1:unsubscribe"]);
    });

    it("leaves a sibling on the identifier it left undisturbed", async () => {
      await mount(`
        <div data-controller="stimeo--presence" data-testid="mover"
             data-stimeo--presence-channel-value="PresenceChannel"
             data-stimeo--presence-id-value="alice"></div>
        <div data-controller="stimeo--presence" data-testid="stayer"
             data-stimeo--presence-channel-value="PresenceChannel"
             data-stimeo--presence-id-value="bob">
          <span data-stimeo--presence-target="count"></span>
        </div>`);
      const mover = document.querySelector("[data-testid='mover']") as HTMLElement;
      const stayer = document.querySelector("[data-testid='stayer'] span") as HTMLElement;
      wire(0)?.connected?.();
      log.length = 0;

      declare("channel", "RoomChannel", mover);
      await settle();
      // alice left the room; the wire stays open for the sibling that is still in it.
      expect(log).toEqual([leaving(0, "alice")]);
      wire(0)?.received?.({ id: "carol", name: "Carol" });
      expect(stayer.textContent).toBe("1");
    });

    it("joins an identifier a sibling already confirmed", async () => {
      await mount(`
        <div data-controller="stimeo--presence" data-testid="mover"
             data-stimeo--presence-channel-value="PresenceChannel"
             data-stimeo--presence-id-value="alice"></div>
        <div data-controller="stimeo--presence"
             data-stimeo--presence-channel-value="RoomChannel"
             data-stimeo--presence-id-value="bob"></div>`);
      wire(1)?.connected?.();
      log.length = 0;

      declare(
        "channel",
        "RoomChannel",
        document.querySelector("[data-testid='mover']") as HTMLElement,
      );
      await settle();
      expect(wires).toHaveLength(2); // no second wire for an identifier already open
      expect(log).toEqual(["0:unsubscribe", beacon(1, "alice", "")]);
    });

    it("moves its voice to a changed id without leaving the subscription", async () => {
      await mount();
      wire(0)?.connected?.();
      wire(0)?.received?.({ id: "bob", name: "Bob" });
      log.length = 0;
      const seen = events();

      declare("id", "dave");
      await settle();
      expect(wires).toHaveLength(1);
      expect(log).toEqual([leaving(0, "alice"), beacon(0, "dave")]);
      expect(renderedNames()).toEqual(["Bob"]); // the same room: its roster stays
      expect(seen).toEqual([]);
    });

    it("releases the old voice once, so a sibling still speaking for it stays", async () => {
      await mount(`
        <div data-controller="stimeo--presence" data-testid="first"
             data-stimeo--presence-channel-value="PresenceChannel"
             data-stimeo--presence-id-value="alice"></div>
        <div data-controller="stimeo--presence" data-testid="second"
             data-stimeo--presence-channel-value="PresenceChannel"
             data-stimeo--presence-id-value="alice"></div>`);
      const at = (testid: string) =>
        document.querySelector(`[data-testid='${testid}']`) as HTMLElement;
      const instance = (testid: string) =>
        application.getControllerForElementAndIdentifier(at(testid), "stimeo--presence");
      wire(0)?.connected?.();
      log.length = 0;

      declare("id", "bob", at("first"));
      await settle();
      expect(log).toEqual([beacon(0, "bob", "")]); // "second" still speaks for alice

      log.length = 0;
      instance("second")?.disconnect();
      expect(log).toEqual([leaving(0, "alice")]);
      log.length = 0;
      instance("first")?.disconnect();
      expect(log).toEqual([leaving(0, "bob"), "0:unsubscribe"]);
    });

    it("moves its voice without a notice or a beacon before confirmation", async () => {
      await mount();
      declare("id", "dave");
      await settle();
      expect(log).toEqual([]);

      wire(0)?.connected?.();
      expect(log).toEqual([beacon(0, "dave")]);
    });

    it("stops beaconing, and leaves, when the id is cleared", async () => {
      await mount();
      wire(0)?.connected?.();
      log.length = 0;

      declare("id", "");
      await settle();
      expect(log).toEqual([leaving(0, "alice")]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(log).toEqual([leaving(0, "alice")]); // an observer sends nothing
    });

    it("stops counting a peer whose id it takes, without reporting a departure", async () => {
      await mount();
      wire(0)?.connected?.();
      wire(0)?.received?.({ id: "bob", name: "Bob" });
      wire(0)?.received?.({ id: "carol", name: "Carol" });
      const seen = events();

      declare("id", "bob");
      await settle();
      expect(renderedNames()).toEqual(["Carol"]);
      expect(root().getAttribute("data-present-count")).toBe("1");
      expect(count().textContent).toBe("1");
      expect(seen).toEqual([]);

      await vi.advanceTimersByTimeAsync(40_000); // bob's expiry went with the entry
      expect(seen).toEqual(["change", "leave"]); // carol's, and only hers
    });

    it("leaves no expiry pending for a peer it stops counting", async () => {
      await mount();
      wire(0)?.connected?.();
      await vi.advanceTimersByTimeAsync(3000); // past the throttle: the answer below is not queued
      wire(0)?.received?.({ id: "bob", name: "Bob" }); // arms bob's expiry
      const pending = vi.getTimerCount();

      declare("id", "bob");
      await settle();
      expect(vi.getTimerCount()).toBe(pending - 1);
    });

    it("lets the new id's beacon stand in for a queued convergence answer", async () => {
      await mount();
      wire(0)?.connected?.(); // the initial beacon opens the throttle window
      wire(0)?.received?.({ id: "bob", name: "Bob" }); // answer queued at its trailing edge
      log.length = 0;

      declare("id", "dave");
      await settle();
      expect(log).toEqual([leaving(0, "alice"), beacon(0, "dave")]);
      await vi.advanceTimersByTimeAsync(2100);
      expect(log).toEqual([leaving(0, "alice"), beacon(0, "dave")]);
    });

    it("answers an unknown peer that arrives after the new id's beacon took a queued answer's place", async () => {
      await mount();
      wire(0)?.connected?.(); // the initial beacon opens the throttle window
      wire(0)?.received?.({ id: "bob", name: "Bob" }); // answer queued at its trailing edge
      await vi.advanceTimersByTimeAsync(500);
      declare("id", "dave");
      await settle(); // the new id's beacon stands in for it and opens a new window
      log.length = 0;

      await vi.advanceTimersByTimeAsync(500);
      wire(0)?.received?.({ id: "carol", name: "Carol" }); // inside that window: queued again
      expect(log).toEqual([]);
      await vi.advanceTimersByTimeAsync(2100);
      expect(log).toEqual([beacon(0, "dave")]);
    });

    it("keeps the running heartbeat's rhythm when the id moves or the period is delivered again", async () => {
      await mount(); // the heartbeat beats every 15 s from the connection
      wire(0)?.connected?.();
      await vi.advanceTimersByTimeAsync(10_000);

      declare("id", "dave");
      declare("heartbeat", "15000");
      await settle();
      log.length = 0;
      await vi.advanceTimersByTimeAsync(5100); // past the 15 s the connection armed
      expect(log).toEqual([beacon(0, "dave")]);
      await vi.advanceTimersByTimeAsync(9800); // short of the next beat
      expect(log).toEqual([beacon(0, "dave")]);
    });

    it("re-arms a running heartbeat on a changed period", async () => {
      await mount();
      wire(0)?.connected?.();
      log.length = 0;
      await vi.advanceTimersByTimeAsync(5000);

      declare("heartbeat", "4000");
      await settle();
      await vi.advanceTimersByTimeAsync(3900);
      expect(log).toEqual([]);
      await vi.advanceTimersByTimeAsync(200); // 4 s after the change
      expect(log).toEqual([beacon(0, "alice")]);
      await vi.advanceTimersByTimeAsync(6000); // past where the 15 s period would have beaten
      expect(log).toEqual([beacon(0, "alice"), beacon(0, "alice")]);
    });

    it("keeps each peer's deadline and applies a changed timeout from its next beacon", async () => {
      await mount(); // timeout 40000
      wire(0)?.received?.({ id: "bob", name: "Bob" });
      await vi.advanceTimersByTimeAsync(10_000);

      declare("timeout", "5000");
      await settle();
      await vi.advanceTimersByTimeAsync(20_000); // 30 s since bob's beacon: its 40 s still holds
      expect(renderedNames()).toEqual(["Bob"]);

      wire(0)?.received?.({ id: "bob", name: "Bob" }); // armed on the declared 5 s
      await vi.advanceTimersByTimeAsync(4900);
      expect(renderedNames()).toEqual(["Bob"]);
      await vi.advanceTimersByTimeAsync(200);
      expect(renderedNames()).toEqual([]);
    });

    it("does not stretch a pending deadline when the timeout grows", async () => {
      await mount();
      declare("timeout", "12000");
      wire(0)?.received?.({ id: "bob", name: "Bob" });
      await vi.advanceTimersByTimeAsync(1000);

      declare("timeout", "60000");
      await settle();
      await vi.advanceTimersByTimeAsync(11_500); // 12.5 s since bob's beacon
      expect(renderedNames()).toEqual([]);
    });

    it("leaves nothing of the old room behind when a join subscriber moves it", async () => {
      await mount();
      wire(0)?.connected?.(); // the initial beacon opens the throttle window
      log.length = 0;
      root().addEventListener("stimeo--presence:join", () => declare("channel", "RoomChannel"), {
        once: true,
      });

      // The expiry is armed before the event and the convergence answer queued after it.
      wire(0)?.received?.({ id: "bob", name: "Bob" });
      await settle();
      expect(renderedNames()).toEqual([]);
      expect(root().hasAttribute("data-present")).toBe(false);
      expect(log).toEqual([leaving(0, "alice"), "0:unsubscribe"]);

      const seen = events();
      await vi.advanceTimersByTimeAsync(41_000);
      expect(seen).toEqual([]);
      expect(log).toEqual([leaving(0, "alice"), "0:unsubscribe"]); // the answer went with the room
    });

    it("opens nothing for a callback delivered after disconnect", async () => {
      await mount();
      controller()?.disconnect();
      declare("channel", "RoomChannel");
      await settle();
      expect(wires).toHaveLength(1);
    });

    it("opens one subscription per connection, whatever callbacks precede it", async () => {
      // Stimulus delivers every Value callback before connect(), and the defaults of
      // undeclared Values again on each reconnect.
      await mount();
      expect(wires).toHaveLength(1);
      document.body.appendChild(root()); // an in-page move reconnects the same instance
      await vi.advanceTimersByTimeAsync(20);
      expect(wires).toHaveLength(2);
      expect(log).toEqual(["0:unsubscribe"]);
    });
  });
});
