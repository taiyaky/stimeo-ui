import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CableSubscriptionMixin } from "../src/cable/consumer";
import { setCableConsumer } from "../src/cable/consumer";
import { TypingIndicatorController } from "../src/cable/typing_indicator_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { delay } from "./helpers/timing";

/**
 * Behavioral tests for {@link TypingIndicatorController}: subscription wiring
 * (channel + params identifier), the throttled typing broadcast, own-echo
 * suppression, the typer set with per-name auto-clear timers, the
 * `data-typing` hook + localized status templates, the rejected hook, and
 * Turbo teardown/reconnect resilience.
 *
 * The Action Cable consumer is a double injected via {@link setCableConsumer}
 * (no websocket in happy-dom); broadcasts are driven by calling the captured
 * `received` mixin directly.
 */

describe("TypingIndicatorController", () => {
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
    <div data-controller="stimeo--typing-indicator"
         data-stimeo--typing-indicator-channel-value="TypingChannel"
         data-stimeo--typing-indicator-params-value='{"room":"chat_42"}'
         data-stimeo--typing-indicator-name-value="Alice"
         data-stimeo--typing-indicator-timeout-value="3000"
         data-stimeo--typing-indicator-throttle-value="2000">
      <label>Message <textarea></textarea></label>
      <p data-stimeo--typing-indicator-target="status"></p>
    </div>`;

  /** Mounts the fixture; fake timers require a manual Stimulus connect flush. */
  const mount = async (html = fixture) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--typing-indicator", TypingIndicatorController);
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
    document.querySelector<HTMLElement>(
      "[data-controller='stimeo--typing-indicator']",
    ) as HTMLElement;
  const status = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--typing-indicator-target='status']",
    ) as HTMLElement;
  const textarea = () => document.querySelector("textarea") as HTMLTextAreaElement;
  const controller = () =>
    root()
      ? (application?.getControllerForElementAndIdentifier(
          root(),
          "stimeo--typing-indicator",
        ) as TypingIndicatorController | null)
      : null;
  const type = () => textarea().dispatchEvent(new Event("input", { bubbles: true }));
  /** Collects everything handed to the page's shared announcer while `run` executes. */
  const announcements = async (run: () => void | Promise<void>) => {
    const messages: string[] = [];
    const onAnnounce = (event: Event) => {
      messages.push((event as CustomEvent<{ message: string }>).detail.message);
    };
    window.addEventListener("stimeo--announcer:announce", onAnnounce);
    await run();
    await vi.advanceTimersByTimeAsync(300); // past the announce debounce
    window.removeEventListener("stimeo--announcer:announce", onAnnounce);
    return messages;
  };
  const confirm = () => mixin?.connected?.();
  const drop = () => mixin?.disconnected?.();
  const receive = (name: string) => mixin?.received?.({ name });

  describe("subscription wiring", () => {
    it("subscribes with the channel plus the params object", async () => {
      await mount();
      expect(createdWith).toEqual({ channel: "TypingChannel", room: "chat_42" });
    });

    it("does not subscribe without a channel", async () => {
      await mount(`
        <div data-controller="stimeo--typing-indicator">
          <textarea aria-label="Message"></textarea>
        </div>`);
      expect(createdWith).toBeNull();
      type(); // no subscription: typing must not throw or perform
      expect(performMock).not.toHaveBeenCalled();
    });

    it("unsubscribes on disconnect", async () => {
      await mount();
      controller()?.disconnect();
      expect(unsubscribeMock).toHaveBeenCalledOnce();
    });
  });

  describe("sending (throttled broadcast)", () => {
    it("performs typing with this client's name on input", async () => {
      await mount();
      confirm();
      type();
      expect(performMock).toHaveBeenCalledWith("typing", { name: "Alice" });
    });

    it("drops input before the confirmed subscription without burning the throttle", async () => {
      await mount();
      type(); // unconfirmed: perform would be dropped by Action Cable
      expect(performMock).not.toHaveBeenCalled();
      confirm();
      type(); // the FIRST confirmed input must send immediately (no stale throttle)
      expect(performMock).toHaveBeenCalledTimes(1);
    });

    it("re-gates sending across a network drop without burning the throttle", async () => {
      // The cable's disconnected() means perform() is silently dropped again —
      // the same hole as the pre-confirmation window, on the reconnect path.
      await mount();
      confirm();
      type();
      expect(performMock).toHaveBeenCalledTimes(1);

      drop();
      await vi.advanceTimersByTimeAsync(2100); // throttle window elapses offline
      type(); // dropped by Action Cable: must not send NOR record #lastSentAt
      expect(performMock).toHaveBeenCalledTimes(1);

      confirm(); // cable reconnected
      type(); // first online input sends immediately (no stale throttle)
      expect(performMock).toHaveBeenCalledTimes(2);
    });

    it("throttles continuous typing to one broadcast per interval", async () => {
      await mount();
      confirm();
      type();
      type();
      await vi.advanceTimersByTimeAsync(1000);
      type(); // still inside the 2000ms window
      expect(performMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1100);
      type(); // window elapsed → next leading-edge send
      expect(performMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("rejection", () => {
    it("publishes the rejected hook and keeps sends dropped", async () => {
      await mount();
      mixin?.rejected?.();
      expect(root().getAttribute("data-typing-indicator-rejected")).toBe("true");
      type(); // the subscription will never confirm: nothing must go out
      expect(performMock).not.toHaveBeenCalled();

      controller()?.disconnect();
      expect(root().hasAttribute("data-typing-indicator-rejected")).toBe(false);
    });

    it("clears a stale rejected hook from a Turbo cache snapshot", async () => {
      await mount(`
        <div data-controller="stimeo--typing-indicator"
             data-stimeo--typing-indicator-channel-value="TypingChannel"
             data-typing-indicator-rejected="true">
          <textarea aria-label="Message"></textarea>
        </div>`);
      // The fresh subscription re-decides rejection; the snapshot must not.
      expect(root().hasAttribute("data-typing-indicator-rejected")).toBe(false);
      // …and it really is a fresh subscription, not a controller that failed to connect.
      mixin?.rejected?.();
      expect(root().getAttribute("data-typing-indicator-rejected")).toBe("true");
    });
  });

  describe("receiving", () => {
    it("has a subscription to receive through", async () => {
      // The helpers below reach the controller through `mixin?.`, so a run where no
      // subscription was created would pass them all silently.
      await mount();
      expect(mixin).not.toBeNull();
    });

    it("shows a received typer and flips the data-typing hook", async () => {
      await mount();
      receive("Bob");
      expect(root().getAttribute("data-typing")).toBe("true");
      expect(status().textContent).toBe("Bob is typing…");
    });

    it("drops the own echo (same name)", async () => {
      await mount();
      receive("Alice");
      expect(root().hasAttribute("data-typing")).toBe(false);
      expect(status().textContent).toBe("");
    });

    it("ignores malformed broadcasts", async () => {
      await mount();
      mixin?.received?.(null);
      mixin?.received?.({});
      mixin?.received?.({ name: 42 });
      expect(root().hasAttribute("data-typing")).toBe(false);
    });

    it("joins multiple typers and counts them", async () => {
      await mount();
      receive("Bob");
      receive("Carol");
      expect(status().textContent).toBe("Bob, Carol are typing…");
    });

    it("clears a typer after timeout ms of silence, keeping the rest", async () => {
      await mount();
      receive("Bob");
      await vi.advanceTimersByTimeAsync(2000);
      receive("Carol");
      await vi.advanceTimersByTimeAsync(1500); // Bob: 3500ms > timeout; Carol: 1500ms
      expect(status().textContent).toBe("Carol is typing…");

      await vi.advanceTimersByTimeAsync(2000);
      expect(status().textContent).toBe("");
      expect(root().getAttribute("data-typing")).toBe("false");
    });

    it("restarts the auto-clear timer on every further signal", async () => {
      await mount();
      receive("Bob");
      await vi.advanceTimersByTimeAsync(2000);
      receive("Bob"); // keeps typing
      await vi.advanceTimersByTimeAsync(2000); // 4000ms since first, 2000 since last
      expect(status().textContent).toBe("Bob is typing…");
    });

    it("localizes the copy via data-one / data-many templates", async () => {
      await mount();
      status().setAttribute("data-one", "%{name} が入力中…");
      status().setAttribute("data-many", "%{count} 人（%{names}）が入力中…");
      receive("Bob");
      expect(status().textContent).toBe("Bob が入力中…");
      receive("Carol");
      expect(status().textContent).toBe("2 人（Bob, Carol）が入力中…");
    });

    it("dispatches change with the typer names on add and clear", async () => {
      await mount();
      const changes: string[][] = [];
      root().addEventListener("stimeo--typing-indicator:change", (event) => {
        changes.push((event as CustomEvent<{ names: string[] }>).detail.names);
      });
      receive("Bob");
      receive("Bob"); // timer restart only — no duplicate change
      await vi.advanceTimersByTimeAsync(3100);
      expect(changes).toEqual([["Bob"], []]);
    });
  });

  describe("Turbo resilience", () => {
    it("resets the transient indicator state on connect (cache restore)", async () => {
      await mount(`
        <div data-controller="stimeo--typing-indicator" data-typing="true"
             data-stimeo--typing-indicator-channel-value="TypingChannel">
          <textarea aria-label="Message"></textarea>
          <p data-stimeo--typing-indicator-target="status">Bob is typing…</p>
        </div>`);
      expect(root().hasAttribute("data-typing")).toBe(false);
      expect(status().textContent).toBe("");
    });

    it("stops timers and clears the indicator on disconnect", async () => {
      await mount();
      receive("Bob");
      expect(root().getAttribute("data-typing")).toBe("true");

      controller()?.disconnect();
      expect(root().hasAttribute("data-typing")).toBe(false);
      expect(status().textContent).toBe("");
      // No timer survives teardown: advancing time changes nothing.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(status().textContent).toBe("");
    });
  });

  describe("template substitution", () => {
    // The name comes off the wire, so it must never reach a replacement *pattern*.
    const withOne = (template: string) =>
      fixture.replace(
        'data-stimeo--typing-indicator-target="status"',
        `data-stimeo--typing-indicator-target="status" data-one="${template}"`,
      );

    it("inserts a name containing $& literally", async () => {
      await mount(withOne("%{name} is typing…"));
      receive("$&");
      expect(status().textContent).toBe("$& is typing…");
    });

    it("inserts a name containing $` and $' literally", async () => {
      await mount(withOne("[%{name}]"));
      receive("$`$'");
      expect(status().textContent).toBe("[$`$']");
    });

    it("fills every occurrence of a placeholder", async () => {
      await mount(withOne("%{name}: %{name} is typing…"));
      receive("Bob");
      expect(status().textContent).toBe("Bob: Bob is typing…");
    });

    it("does not re-substitute a name that contains a token", async () => {
      await mount();
      status().setAttribute("data-many", "%{names} (%{count})");
      receive("%{count}");
      receive("Bob");
      expect(status().textContent).toBe("%{count}, Bob (2)");
    });

    it("leaves a placeholder it has no value for as authored", async () => {
      await mount(withOne("%{name} / %{count}"));
      receive("Bob");
      expect(status().textContent).toBe("Bob / %{count}");
    });
  });

  describe("declared values", () => {
    /** The fixture with only the declarations a case needs — the rest take defaults. */
    const declaring = (attrs = "") => `
      <div data-controller="stimeo--typing-indicator"
           data-stimeo--typing-indicator-channel-value="TypingChannel"
           data-stimeo--typing-indicator-name-value="Alice" ${attrs}>
        <label>Message <textarea></textarea></label>
        <p data-stimeo--typing-indicator-target="status"></p>
      </div>`;
    const bare = declaring();

    it("subscribes to the channel alone when no params are declared", async () => {
      await mount(bare);
      expect(createdWith).toEqual({ channel: "TypingChannel" });
    });

    it("keeps the subscription when the params declaration is unparseable", async () => {
      // Stimulus' Object reader would throw here and take the subscription with it.
      await mount(declaring('data-stimeo--typing-indicator-params-value="{"'));
      expect(createdWith).toEqual({ channel: "TypingChannel" });
    });

    it("clears a typer after the default timeout of silence", async () => {
      await mount(bare);
      receive("Bob");
      await vi.advanceTimersByTimeAsync(2900);
      expect(status().textContent).toBe("Bob is typing…");
      await vi.advanceTimersByTimeAsync(200); // past the default 3000
      expect(status().textContent).toBe("");
    });

    it("throttles to the default interval when none is declared", async () => {
      await mount(bare);
      confirm();
      type();
      await vi.advanceTimersByTimeAsync(1900);
      type(); // still inside the default 2000ms window
      expect(performMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      type();
      expect(performMock).toHaveBeenCalledTimes(2);
    });

    it("honors a throttle shorter than the default", async () => {
      await mount(declaring('data-stimeo--typing-indicator-throttle-value="500"'));
      confirm();
      type();
      await vi.advanceTimersByTimeAsync(600); // past 500, still inside the default 2000
      type();
      expect(performMock).toHaveBeenCalledTimes(2);
    });

    it("honors a timeout shorter than the default", async () => {
      await mount(declaring('data-stimeo--typing-indicator-timeout-value="1000"'));
      receive("Bob");
      await vi.advanceTimersByTimeAsync(1100); // past 1000, still inside the default 3000
      expect(status().textContent).toBe("");
    });

    it.each(["abc", "-1", "Infinity"])(
      "falls back to the default interval when throttle is %s",
      async (declared) => {
        // NaN and a negative gap leave the gate open on every keystroke; Infinity is
        // never exceeded, so it would never open at all.
        await mount(declaring(`data-stimeo--typing-indicator-throttle-value="${declared}"`));
        confirm();
        type();
        type();
        expect(performMock).toHaveBeenCalledTimes(1);
      },
    );

    it.each(["abc", "-1", "Infinity"])(
      "falls back to the default silence when timeout is %s",
      async (declared) => {
        // Every one of these reaches setTimeout as "now", so the typer would vanish in
        // the task it appeared in.
        await mount(declaring(`data-stimeo--typing-indicator-timeout-value="${declared}"`));
        receive("Bob");
        await vi.advanceTimersByTimeAsync(1);
        expect(status().textContent).toBe("Bob is typing…");
      },
    );
  });

  describe("without a status target", () => {
    const hookOnly = `
      <div data-controller="stimeo--typing-indicator"
           data-stimeo--typing-indicator-channel-value="TypingChannel"
           data-stimeo--typing-indicator-name-value="Alice">
        <textarea aria-label="Message"></textarea>
      </div>`;

    it("still flips the hook and announces the change", async () => {
      await mount(hookOnly);
      const changes: string[][] = [];
      root().addEventListener("stimeo--typing-indicator:change", (event) => {
        changes.push((event as CustomEvent<{ names: string[] }>).detail.names);
      });

      receive("Bob");
      expect(root().getAttribute("data-typing")).toBe("true");
      expect(changes).toEqual([["Bob"]]);

      await vi.advanceTimersByTimeAsync(3100);
      expect(root().getAttribute("data-typing")).toBe("false");
    });
  });

  it("paints the current copy into a status target swapped in mid-conversation", async () => {
    // A Turbo Stream can replace the status slot while a peer is typing. Without a
    // repaint the fresh slot stays empty while the hook still says someone is typing,
    // leaving the state in the visual hook alone.
    await mount();
    receive("Bob");
    const fresh = status().cloneNode(false) as HTMLElement;
    status().replaceWith(fresh);
    await vi.advanceTimersByTimeAsync(20);

    expect(root().getAttribute("data-typing")).toBe("true");
    expect(status().textContent).toBe("Bob is typing…");
  });

  describe("two indicators on the same channel and room", () => {
    const indicator = (id: string) => `
      <div id="${id}" data-controller="stimeo--typing-indicator"
           data-stimeo--typing-indicator-channel-value="TypingChannel"
           data-stimeo--typing-indicator-params-value='{"room":"chat_42"}'
           data-stimeo--typing-indicator-name-value="Alice">
        <textarea aria-label="Message ${id}"></textarea>
        <p data-stimeo--typing-indicator-target="status"></p>
      </div>`;
    const statuses = () =>
      [...document.querySelectorAll('[data-stimeo--typing-indicator-target="status"]')].map(
        (element) => element.textContent,
      );

    it("shares one confirmed subscription, so the second indicator can send too", async () => {
      await mount(indicator("a") + indicator("b"));
      // The server confirms an identifier once and ignores a repeated subscribe for it.
      expect(mixins).toHaveLength(1);
      mixins[0]?.connected?.();
      const second = document.querySelector("#b textarea") as HTMLTextAreaElement;
      second.dispatchEvent(new Event("input", { bubbles: true }));
      expect(performMock).toHaveBeenCalledWith("typing", { name: "Alice" });
    });

    it("renders one broadcast into both indicators", async () => {
      await mount(indicator("a") + indicator("b"));
      mixins[0]?.received?.({ name: "Bob" });
      expect(statuses()).toEqual(["Bob is typing…", "Bob is typing…"]);
    });
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount(`<main>${fixture}</main>`);
    receive("Bob");
    vi.useRealTimers(); // axe schedules its own timers; fake timers stall it
    await expectNoA11yViolations(document.body);
  });

  // --- Speech-order regression ------------------------------------------------

  it("reads the status slot as ordinary text, not as a live region", async () => {
    // The slot is visible copy; assistive tech is reached through the shared announcer
    // instead, so nothing here carries live-region semantics.
    await mount();
    confirm();
    receive("Bob");
    expect(status().textContent).toBe("Bob is typing…");
    expect(status().getAttribute("role")).toBeNull();
    expect(status().getAttribute("aria-live")).toBeNull();

    vi.useRealTimers(); // the virtual reader awaits real async work
    const spoken = await captureSpeech({ container: root(), steps: 4 });
    // Freeze the whole ordered array: the slot reads as a plain paragraph, with no
    // live-region wording anywhere in it.
    expect(spoken).toEqual([
      "Message",
      "textbox, Message",
      "paragraph",
      "Bob is typing…",
      "end of paragraph",
    ]);
  });

  describe("announcing through the shared announcer", () => {
    const ONE = 'data-stimeo--typing-indicator-announce-one-text-value="{name} is typing"';
    const MANY =
      'data-stimeo--typing-indicator-announce-many-text-value="{count} people are typing: {names}"';
    const announcing = (attrs: string) =>
      fixture.replace(
        'data-stimeo--typing-indicator-name-value="Alice"',
        `data-stimeo--typing-indicator-name-value="Alice" ${attrs}`,
      );

    it("sends the settled single typer with the declared wording", async () => {
      await mount(announcing(ONE));
      expect(await announcements(() => receive("Bob"))).toEqual(["Bob is typing"]);
    });

    it("sends one announcement for a burst of arrivals", async () => {
      await mount(announcing(`${ONE} ${MANY}`));
      const messages = await announcements(() => {
        receive("Bob");
        receive("Carol");
      });
      expect(messages).toEqual(["2 people are typing: Bob, Carol"]);
    });

    it("announces nothing when the wording is not declared", async () => {
      await mount();
      expect(await announcements(() => receive("Bob"))).toEqual([]);
    });

    it("announces nothing when the last typer stops", async () => {
      // Both templates are declared, so an empty set reaching the many branch would
      // announce "0 people are typing: " instead of staying quiet.
      await mount(announcing(`${ONE} ${MANY}`));
      await announcements(() => receive("Bob"));
      // The set emptying is not news worth interrupting a reader for.
      const onStop = await announcements(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      expect(onStop).toEqual([]);
      expect(status().textContent).toBe("");
    });

    it("drops a pending announcement on disconnect", async () => {
      await mount(announcing(ONE));
      const messages = await announcements(() => {
        receive("Bob");
        controller()?.disconnect();
      });
      expect(messages).toEqual([]);
    });
  });
});
