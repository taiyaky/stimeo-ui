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
  const performMock = vi.fn();
  const unsubscribeMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    createdWith = null;
    mixin = null;
    performMock.mockClear();
    unsubscribeMock.mockClear();
    setCableConsumer({
      subscriptions: {
        create(channel, subscriptionMixin) {
          createdWith = channel;
          mixin = subscriptionMixin;
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
      <p role="status" data-stimeo--typing-indicator-target="status"></p>
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
    });
  });

  describe("receiving", () => {
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
          <p role="status" data-stimeo--typing-indicator-target="status">Bob is typing…</p>
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

  it("has no machine-detectable a11y violations", async () => {
    await mount(`<main>${fixture}</main>`);
    receive("Bob");
    vi.useRealTimers(); // axe schedules its own timers; fake timers stall it
    await expectNoA11yViolations(document.body);
  });

  // --- Speech-order regression ------------------------------------------------

  it("announces a typing peer through the status live region only", async () => {
    await mount();
    confirm();
    vi.useRealTimers(); // the virtual reader awaits real async work
    const container = root();
    const quiet = await captureSpeech({ container, steps: 2 });
    // Freeze the whole ordered array: composer label + input + an empty status.
    expect(quiet).toEqual(["Message", "textbox, Message", "status"]);

    receive("Bob");
    expect(status().textContent).toBe("Bob is typing…");
    const typing = await captureSpeech({ container, steps: 3 });
    expect(typing).toEqual(["Message", "textbox, Message", "status", "Bob is typing…"]);
  });
});
