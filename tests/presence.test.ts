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
});
