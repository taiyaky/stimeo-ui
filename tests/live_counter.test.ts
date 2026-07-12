import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CableSubscriptionMixin } from "../src/cable/consumer";
import { setCableConsumer } from "../src/cable/consumer";
import { LiveCounterController } from "../src/cable/live_counter_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link LiveCounterController}: the DOM-sourced count,
 * optimistic increment + perform (gated on the confirmed subscription),
 * absolute-count reconciliation, delta broadcasts with own-echo dedupe, the
 * id-less mode (no optimistic bump), the declarative `trigger` disabling
 * (mirroring the send gate as the real `disabled` attribute), the change
 * event, and teardown.
 */

describe("LiveCounterController", () => {
  let application: Application;
  let mixin: CableSubscriptionMixin | null = null;
  const performMock = vi.fn();
  const unsubscribeMock = vi.fn();

  beforeEach(() => {
    mixin = null;
    performMock.mockClear();
    unsubscribeMock.mockClear();
    setCableConsumer({
      subscriptions: {
        create(_channel, subscriptionMixin) {
          mixin = subscriptionMixin;
          return { perform: performMock, unsubscribe: unsubscribeMock };
        },
      },
    });
  });

  const mount = async ({
    attrs = `data-stimeo--live-counter-channel-value="LikesChannel"
             data-stimeo--live-counter-id-value="alice"`,
    confirm = true,
    buttonAttrs = "",
  } = {}) => {
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--live-counter" ${attrs}>
          <span data-stimeo--live-counter-target="value">128</span>
          <button type="button" aria-label="Like" ${buttonAttrs}
                  data-action="stimeo--live-counter#increment">♥</button>
        </div>
      </main>`;
    application = Application.start();
    application.register("stimeo--live-counter", LiveCounterController);
    await tick();
    // Mirrors Action Cable's subscription confirmation, opening the send gate
    // (the double is synchronous, so no extra tick is needed).
    if (confirm) mixin?.connected?.();
  };

  afterEach(async () => {
    controller()?.disconnect();
    application.stop();
    document.body.innerHTML = "";
    setCableConsumer(null);
    await tick();
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--live-counter']") as HTMLElement;
  const value = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--live-counter-target='value']",
    ) as HTMLElement;
  const controller = () =>
    root()
      ? (application?.getControllerForElementAndIdentifier(
          root(),
          "stimeo--live-counter",
        ) as LiveCounterController | null)
      : null;
  it("increments optimistically and performs on the channel", async () => {
    await mount();
    (document.querySelector("button") as HTMLButtonElement).click();
    expect(value().textContent).toBe("129");
    expect(performMock).toHaveBeenCalledWith("increment", { id: "alice", delta: 1 });
  });

  it("drops increments until the subscription is confirmed", async () => {
    await mount({ confirm: false });
    const button = document.querySelector("button") as HTMLButtonElement;
    button.click(); // pre-confirmation: perform() would be silently dropped
    expect(value().textContent).toBe("128");
    expect(performMock).not.toHaveBeenCalled();

    mixin?.connected?.();
    button.click();
    expect(value().textContent).toBe("129");
    expect(performMock).toHaveBeenCalledOnce();
  });

  it("closes the send gate while the connection is down, reopening on reconfirm", async () => {
    await mount();
    const button = document.querySelector("button") as HTMLButtonElement;
    button.click();
    expect(value().textContent).toBe("129");

    mixin?.disconnected?.();
    button.click(); // outage: perform() would be silently discarded
    expect(value().textContent).toBe("129");
    expect(performMock).toHaveBeenCalledOnce();

    mixin?.connected?.(); // Action Cable reconnects and re-confirms
    button.click();
    expect(value().textContent).toBe("130");
    expect(performMock).toHaveBeenCalledTimes(2);
  });

  it("publishes the rejected hook and keeps increments dropped", async () => {
    await mount({ confirm: false });
    mixin?.rejected?.();
    expect(root().getAttribute("data-live-counter-rejected")).toBe("true");

    (document.querySelector("button") as HTMLButtonElement).click();
    expect(value().textContent).toBe("128");
    expect(performMock).not.toHaveBeenCalled();

    controller()?.disconnect();
    expect(root().hasAttribute("data-live-counter-rejected")).toBe(false);
  });

  it("clears a stale rejected hook from a Turbo cache snapshot", async () => {
    await mount({
      attrs: `data-stimeo--live-counter-channel-value="LikesChannel"
              data-stimeo--live-counter-id-value="alice"
              data-live-counter-rejected="true"`,
    });
    // The fresh subscription re-decides rejection; the snapshot must not.
    expect(root().hasAttribute("data-live-counter-rejected")).toBe(false);
  });

  it("skips the optimistic bump without an own id (the broadcast applies once)", async () => {
    await mount({ attrs: `data-stimeo--live-counter-channel-value="LikesChannel"` });
    (document.querySelector("button") as HTMLButtonElement).click();
    // No id: the delta echo could not be deduped, so nothing bumps locally…
    expect(value().textContent).toBe("128");
    expect(performMock).toHaveBeenCalledWith("increment", { id: "", delta: 1 });
    // …and the server's own-echo broadcast applies the increment exactly once.
    mixin?.received?.({ delta: 1, by: "" });
    expect(value().textContent).toBe("129");
  });

  it("still bumps locally without a channel (optimistic-only mode)", async () => {
    await mount({ attrs: "" });
    (document.querySelector("button") as HTMLButtonElement).click();
    expect(value().textContent).toBe("129");
    expect(performMock).not.toHaveBeenCalled();
  });

  it("reconciles an absolute count broadcast (server truth wins)", async () => {
    await mount();
    mixin?.received?.({ count: 200 });
    expect(value().textContent).toBe("200");
  });

  it("applies a foreign delta but dedupes the own echo", async () => {
    await mount();
    mixin?.received?.({ delta: 1, by: "bob" });
    expect(value().textContent).toBe("129");
    mixin?.received?.({ delta: 1, by: "alice" }); // own echo: already applied
    expect(value().textContent).toBe("129");
  });

  it("dispatches change with the new count", async () => {
    await mount();
    const counts: number[] = [];
    root().addEventListener("stimeo--live-counter:change", (event) => {
      counts.push((event as CustomEvent<{ count: number }>).detail.count);
    });
    mixin?.received?.({ count: 130 });
    mixin?.received?.({ count: 130 }); // unchanged: no event
    expect(counts).toEqual([130]);
  });

  it("parses a formatted display and normalizes string deltas", async () => {
    await mount();
    value().textContent = "1,200 likes";
    const button = document.querySelector("button") as HTMLButtonElement;
    button.setAttribute("data-stimeo--live-counter-delta-param", "2");
    button.click();
    expect(value().textContent).toBe("1202"); // 1,200 parsed whole, +2 (string param)
    expect(performMock).toHaveBeenCalledWith("increment", { id: "alice", delta: 2 });
  });

  it("ignores malformed broadcasts", async () => {
    await mount();
    mixin?.received?.(null);
    mixin?.received?.({ count: "NaN" });
    mixin?.received?.({ delta: "1" });
    expect(value().textContent).toBe("128");
  });

  it("unsubscribes on disconnect", async () => {
    await mount();
    controller()?.disconnect();
    expect(unsubscribeMock).toHaveBeenCalledOnce();
    mixin?.received?.({ count: 999 }); // guarded by unsubscribe in real cable;
    // the DOM value is the source of truth either way — no crash.
  });

  describe("declarative trigger disabling", () => {
    const TRIGGER = `data-stimeo--live-counter-target="trigger"`;
    const button = () => document.querySelector("button") as HTMLButtonElement;

    it("disables triggers until the subscription confirms", async () => {
      await mount({ confirm: false, buttonAttrs: TRIGGER });
      expect(button().disabled).toBe(true); // an increment now would be dropped
      mixin?.connected?.();
      expect(button().disabled).toBe(false);
    });

    it("re-disables triggers during an outage, re-enabling on reconfirm", async () => {
      await mount({ buttonAttrs: TRIGGER });
      expect(button().disabled).toBe(false);
      mixin?.disconnected?.();
      expect(button().disabled).toBe(true);
      mixin?.connected?.();
      expect(button().disabled).toBe(false);
    });

    it("keeps triggers disabled for good after a rejection", async () => {
      await mount({ confirm: false, buttonAttrs: TRIGGER });
      mixin?.rejected?.();
      expect(button().disabled).toBe(true);
      expect(root().getAttribute("data-live-counter-rejected")).toBe("true");
    });

    it("never disables triggers on a channel-less (local-only) counter", async () => {
      await mount({ attrs: "", buttonAttrs: TRIGGER });
      expect(button().disabled).toBe(false);
      button().click(); // local counters always accept the increment
      expect(value().textContent).toBe("129");
    });

    it("clears a snapshotted gate-disabled trigger when no gate applies", async () => {
      // A Turbo cache snapshot may have preserved a disabled the gate applied
      // (recognizable by the marker); connect() re-decides it from the fresh
      // (here: absent) subscription and lifts it.
      await mount({ attrs: "", buttonAttrs: `${TRIGGER} disabled data-live-counter-disabled` });
      expect(button().disabled).toBe(false);
      expect(button().hasAttribute("data-live-counter-disabled")).toBe(false);
    });

    it("respects an authored disabled trigger (never re-enables it)", async () => {
      // disabled is a shared attribute: one the consumer authored (no marker)
      // must survive the gate opening — only gate-applied disableds are lifted.
      await mount({ confirm: false, buttonAttrs: `${TRIGGER} disabled` });
      mixin?.connected?.();
      expect(button().disabled).toBe(true);
      mixin?.disconnected?.();
      mixin?.connected?.();
      expect(button().disabled).toBe(true); // an outage round-trip changes nothing
    });

    it("applies the current gate to a late-added trigger", async () => {
      await mount({ confirm: false });
      const late = document.createElement("button");
      // Driven directly: happy-dom's MutationObserver delivers target
      // callbacks unreliably, and the callback's contract is what matters.
      controller()?.triggerTargetConnected(late);
      expect(late.hasAttribute("disabled")).toBe(true);

      mixin?.connected?.();
      const afterConfirm = document.createElement("button");
      controller()?.triggerTargetConnected(afterConfirm);
      expect(afterConfirm.hasAttribute("disabled")).toBe(false);
    });
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount();
    await expectNoA11yViolations(document.body);
  });

  // --- Layer ③ speech-order regression ---------------------------------------

  it("announces the count as plain text, before and after a broadcast", async () => {
    await mount();
    const container = document.querySelector("main") as HTMLElement;
    const before = await captureSpeech({ container, steps: 2 });
    // Freeze the whole ordered array: the value target reads as its text, the
    // trigger as a named button.
    expect(before).toEqual(["main", "128", "button, Like"]);

    // A broadcast reconciliation only rewrites the value target's text.
    mixin?.received?.({ count: 200 });
    const after = await captureSpeech({ container, steps: 2 });
    expect(after).toEqual(["main", "200", "button, Like"]);
  });
});
