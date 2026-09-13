import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CableSubscriptionMixin } from "../src/cable/consumer";
import { setCableConsumer } from "../src/cable/consumer";
import { LiveCounterController } from "../src/cable/live_counter_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
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
  /** Every mixin the double was asked to create, in order (one per wire subscription). */
  let mixins: CableSubscriptionMixin[] = [];
  /** Every channel descriptor the double was asked to subscribe with, in order. */
  let descriptors: Array<string | Record<string, unknown>> = [];
  const performMock = vi.fn();
  const unsubscribeMock = vi.fn();

  beforeEach(() => {
    mixin = null;
    mixins = [];
    descriptors = [];
    performMock.mockClear();
    unsubscribeMock.mockClear();
    setCableConsumer({
      subscriptions: {
        create(channel, subscriptionMixin) {
          mixin = subscriptionMixin;
          mixins.push(subscriptionMixin);
          descriptors.push(channel);
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
    displayed = "128",
  } = {}) => {
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--live-counter" ${attrs}>
          <span data-stimeo--live-counter-target="value">${displayed}</span>
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
    disconnectAndStopApplication(application);
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
  const trigger = () => document.querySelector("button") as HTMLButtonElement;
  const controller = () =>
    root()
      ? (application?.getControllerForElementAndIdentifier(
          root(),
          "stimeo--live-counter",
        ) as LiveCounterController | null)
      : null;
  it("reads a formatted server-rendered count as the number it displays", async () => {
    await mount({ displayed: "1,200 likes" });
    (document.querySelector("button") as HTMLButtonElement).click();
    expect(value().textContent).toBe("1201");
  });

  it("reads a hyphen in the display as prose, not as a sign", async () => {
    await mount({ displayed: "Sign-ups: 1,200" });
    (document.querySelector("button") as HTMLButtonElement).click();
    expect(value().textContent).toBe("1201"); // never counts up from -1200
  });

  it("counts a display holding no number as zero", async () => {
    await mount({ displayed: "No likes yet" });
    (document.querySelector("button") as HTMLButtonElement).click();
    expect(value().textContent).toBe("1");
  });

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

  it("applies a foreign delta, and the echo of its own outstanding guess", async () => {
    await mount();
    mixin?.received?.({ delta: 1, by: "bob" });
    expect(value().textContent).toBe("129");

    (document.querySelector("button") as HTMLButtonElement).click();
    expect(value().textContent).toBe("130"); // the guess
    mixin?.received?.({ delta: 1, by: "alice" }); // its echo: already applied
    expect(value().textContent).toBe("130");
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

    it("shares one confirmed subscription between two counters for the same channel", async () => {
      const counter = (id: string) => `
        <div id="${id}" data-controller="stimeo--live-counter"
             data-stimeo--live-counter-channel-value="LikesChannel"
             data-stimeo--live-counter-id-value="alice">
          <span data-stimeo--live-counter-target="value">128</span>
          <button type="button" aria-label="Like ${id}" ${TRIGGER}
                  data-action="stimeo--live-counter#increment">♥</button>
        </div>`;
      document.body.innerHTML = `<main>${counter("a")}${counter("b")}</main>`;
      application = Application.start();
      application.register("stimeo--live-counter", LiveCounterController);
      await tick();
      // The server confirms an identifier once and ignores a repeated subscribe for it.
      expect(mixins).toHaveLength(1);
      const second = document.querySelector("#b button") as HTMLButtonElement;
      expect(second.disabled).toBe(true);
      mixins[0]?.connected?.();
      expect(second.disabled).toBe(false);
      second.click();
      expect(performMock).toHaveBeenCalledWith("increment", { id: "alice", delta: 1 });
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

  // --- Only whole numbers ever reach the display ----------------------------

  it("ignores a broadcast whose count is not a whole number", async () => {
    await mount();
    for (const count of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 1e21]) {
      mixin?.received?.({ count });
    }
    expect(value().textContent).toBe("128");
  });

  it("ignores a delta that is not a whole number, silently", async () => {
    await mount();
    const counts: number[] = [];
    root().addEventListener("stimeo--live-counter:change", (event) => {
      counts.push((event as CustomEvent<{ count: number }>).detail.count);
    });
    mixin?.received?.({ delta: Number.NaN, by: "bob" });
    mixin?.received?.({ delta: 0.5, by: "bob" });
    expect(value().textContent).toBe("128");
    expect(counts).toEqual([]);
  });

  it("falls back to a whole step for a fractional delta param", async () => {
    await mount({ buttonAttrs: 'data-stimeo--live-counter-delta-param="0.5"' });
    (document.querySelector("button") as HTMLButtonElement).click();
    // Screen and server move by the same amount, and the display stays whole.
    expect(value().textContent).toBe("129");
    expect(performMock).toHaveBeenCalledWith("increment", { id: "alice", delta: 1 });
  });

  // --- The send gate follows the declaration, not the subscription object ----

  it("subscribes when a channel arrives at runtime, and keeps the gate shut until it confirms", async () => {
    await mount({
      attrs: 'data-stimeo--live-counter-id-value="alice"',
      buttonAttrs: 'data-stimeo--live-counter-target="trigger"',
    });
    expect(descriptors).toHaveLength(0);

    root().setAttribute("data-stimeo--live-counter-channel-value", "LikesChannel");
    await tick();
    expect(descriptors).toEqual([{ channel: "LikesChannel" }]);
    expect(trigger().hasAttribute("disabled")).toBe(true);

    trigger().click();
    expect(value().textContent).toBe("128"); // not bumped: the server cannot hear it yet
    expect(performMock).not.toHaveBeenCalled();

    mixin?.connected?.();
    trigger().click();
    expect(value().textContent).toBe("129");
  });

  it("keeps the gate shut when the subscription cannot be created", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {}); // the diagnostic is the point
    setCableConsumer({
      subscriptions: {
        create() {
          throw new Error("no consumer");
        },
      },
    });
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--live-counter"
             data-stimeo--live-counter-channel-value="LikesChannel"
             data-stimeo--live-counter-id-value="alice">
          <span data-stimeo--live-counter-target="value">128</span>
          <button type="button" aria-label="Like" data-stimeo--live-counter-target="trigger"
                  data-action="stimeo--live-counter#increment">♥</button>
        </div>
      </main>`;
    application = Application.start();
    application.register("stimeo--live-counter", LiveCounterController);
    await tick();

    expect(trigger().hasAttribute("disabled")).toBe(true);
    trigger().click();
    expect(value().textContent).toBe("128");
    expect(performMock).not.toHaveBeenCalled();
  });

  // --- What the gate borrows, it returns ------------------------------------

  it("returns the disabled it applied when the controller goes away", async () => {
    await mount({ confirm: false, buttonAttrs: 'data-stimeo--live-counter-target="trigger"' });
    expect(trigger().hasAttribute("disabled")).toBe(true);

    controller()?.disconnect();
    expect(trigger().hasAttribute("disabled")).toBe(false);
    expect(trigger().hasAttribute("data-live-counter-disabled")).toBe(false);
  });

  it("leaves an authored disabled alone when the controller goes away", async () => {
    await mount({
      confirm: false,
      buttonAttrs: 'disabled data-stimeo--live-counter-target="trigger"',
    });
    controller()?.disconnect();
    expect(trigger().hasAttribute("disabled")).toBe(true); // never ours to lift
  });

  it("returns the disabled when a trigger stops being a target", async () => {
    await mount({ confirm: false, buttonAttrs: 'data-stimeo--live-counter-target="trigger"' });
    expect(trigger().hasAttribute("disabled")).toBe(true);

    trigger().removeAttribute("data-stimeo--live-counter-target");
    await tick();
    expect(trigger().hasAttribute("disabled")).toBe(false);
  });

  it("gives back a deferred disable when the controller goes away", async () => {
    await mount({ buttonAttrs: 'data-stimeo--live-counter-target="trigger"' });
    trigger().focus();
    mixin?.disconnected?.(); // the gate shuts while the trigger holds focus
    expect(trigger().hasAttribute("disabled")).toBe(false); // held back

    controller()?.disconnect();
    trigger().blur();
    expect(trigger().hasAttribute("disabled")).toBe(false); // the deferral went with it
  });

  it("gives back a deferred disable when the trigger stops being a target", async () => {
    await mount({ buttonAttrs: 'data-stimeo--live-counter-target="trigger"' });
    trigger().focus();
    mixin?.disconnected?.();

    trigger().removeAttribute("data-stimeo--live-counter-target");
    await tick();
    trigger().blur();
    expect(trigger().hasAttribute("disabled")).toBe(false);
  });

  it("waits for a focused trigger to blur before disabling it", async () => {
    await mount({ buttonAttrs: 'data-stimeo--live-counter-target="trigger"' });
    trigger().focus();
    expect(document.activeElement).toBe(trigger());

    mixin?.disconnected?.(); // the connection drops while the trigger holds focus
    expect(trigger().hasAttribute("disabled")).toBe(false); // focus is not taken away
    expect(document.activeElement).toBe(trigger());

    trigger().blur();
    expect(trigger().hasAttribute("disabled")).toBe(true);
  });

  // --- The echo belongs to the send that caused it ---------------------------

  it("lets a sibling counter catch up on the echo of its neighbour's increment", async () => {
    document.body.innerHTML = `
      <main>
        <div id="a" data-controller="stimeo--live-counter"
             data-stimeo--live-counter-channel-value="LikesChannel"
             data-stimeo--live-counter-id-value="alice">
          <span data-stimeo--live-counter-target="value">128</span>
          <button type="button" aria-label="Like" data-action="stimeo--live-counter#increment">♥</button>
        </div>
        <div id="b" data-controller="stimeo--live-counter"
             data-stimeo--live-counter-channel-value="LikesChannel"
             data-stimeo--live-counter-id-value="alice">
          <span data-stimeo--live-counter-target="value">128</span>
        </div>
      </main>`;
    application = Application.start();
    application.register("stimeo--live-counter", LiveCounterController);
    await tick();
    for (const m of mixins) m.connected?.();

    (document.querySelector("#a button") as HTMLButtonElement).click();
    const texts = () =>
      [...document.querySelectorAll("[data-stimeo--live-counter-target=value]")].map(
        (n) => n.textContent,
      );
    expect(texts()).toEqual(["129", "128"]); // only the clicked one guessed

    for (const m of mixins) m.received?.({ delta: 1, by: "alice" });
    expect(texts()).toEqual(["129", "129"]); // the other one catches up on the echo
  });

  it("applies an own-id delta when nothing optimistic is outstanding", async () => {
    await mount();
    mixin?.received?.({ delta: 1, by: "alice" }); // e.g. this user's other tab
    expect(value().textContent).toBe("129");
  });

  it("drops an outstanding guess when the server states the count", async () => {
    await mount();
    (document.querySelector("button") as HTMLButtonElement).click();
    expect(value().textContent).toBe("129");

    mixin?.received?.({ count: 129 }); // server truth settles the guess
    mixin?.received?.({ delta: 1, by: "alice" }); // a later echo is nobody's guess
    expect(value().textContent).toBe("130");
  });

  it("does not apply the echo of its own subtracting step twice", async () => {
    await mount({ buttonAttrs: 'data-stimeo--live-counter-delta-param="-1"' });
    trigger().click();
    expect(value().textContent).toBe("127"); // the guess
    expect(performMock).toHaveBeenCalledWith("increment", { id: "alice", delta: -1 });

    mixin?.received?.({ delta: -1, by: "alice" }); // its echo
    expect(value().textContent).toBe("127");
  });

  it("applies an own-id delta that no guess of that size is waiting for", async () => {
    await mount();
    trigger().click(); // guessed +1
    mixin?.received?.({ delta: -1, by: "alice" }); // this user's other tab took one away
    expect(value().textContent).toBe("128");

    mixin?.received?.({ delta: 1, by: "alice" }); // now the echo of the guess
    expect(value().textContent).toBe("128"); // and the server agrees: 128 + 1 - 1
  });

  it("applies a foreign delta even while a guess of that size is outstanding", async () => {
    await mount();
    trigger().click(); // guessed +1
    mixin?.received?.({ delta: 1, by: "bob" }); // someone else's, not an echo of ours
    expect(value().textContent).toBe("130");

    mixin?.received?.({ delta: 1, by: "alice" }); // now the echo of the guess
    expect(value().textContent).toBe("130"); // and the server agrees: 128 + 1 + 1
  });

  it("converges counters sharing an id that step by different amounts", async () => {
    document.body.innerHTML = `
      <main>
        <div id="a" data-controller="stimeo--live-counter"
             data-stimeo--live-counter-channel-value="LikesChannel"
             data-stimeo--live-counter-id-value="alice">
          <span data-stimeo--live-counter-target="value">128</span>
          <button type="button" aria-label="Like" data-action="stimeo--live-counter#increment">♥</button>
        </div>
        <div id="b" data-controller="stimeo--live-counter"
             data-stimeo--live-counter-channel-value="LikesChannel"
             data-stimeo--live-counter-id-value="alice">
          <span data-stimeo--live-counter-target="value">128</span>
          <button type="button" aria-label="Like x2" data-stimeo--live-counter-delta-param="2"
                  data-action="stimeo--live-counter#increment">♥♥</button>
        </div>
      </main>`;
    application = Application.start();
    application.register("stimeo--live-counter", LiveCounterController);
    await tick();
    for (const m of mixins) m.connected?.();

    (document.querySelector("#a button") as HTMLButtonElement).click();
    (document.querySelector("#b button") as HTMLButtonElement).click();
    const texts = () =>
      [...document.querySelectorAll("[data-stimeo--live-counter-target=value]")].map(
        (n) => n.textContent,
      );
    expect(texts()).toEqual(["129", "130"]); // each one guessed its own step

    // The server took both and relays them; each echo cancels the guess of its size.
    for (const m of mixins) m.received?.({ delta: 2, by: "alice" });
    for (const m of mixins) m.received?.({ delta: 1, by: "alice" });
    expect(texts()).toEqual(["131", "131"]); // 128 + 2 + 1, on both
  });

  // --- The identifier follows the declaration -------------------------------

  it("re-subscribes when the params change at runtime", async () => {
    await mount({
      attrs: `data-stimeo--live-counter-channel-value="LikesChannel"
              data-stimeo--live-counter-params-value='{"post":1}'
              data-stimeo--live-counter-id-value="alice"`,
    });
    expect(descriptors).toEqual([{ channel: "LikesChannel", post: 1 }]);

    root().setAttribute("data-stimeo--live-counter-params-value", '{"post":2}');
    await tick();
    expect(descriptors).toEqual([
      { channel: "LikesChannel", post: 1 },
      { channel: "LikesChannel", post: 2 },
    ]);
    expect(unsubscribeMock).toHaveBeenCalled();
  });

  it("re-subscribes when the channel changes at runtime", async () => {
    await mount();
    root().setAttribute("data-stimeo--live-counter-channel-value", "OtherChannel");
    await tick();
    expect(descriptors).toEqual([{ channel: "LikesChannel" }, { channel: "OtherChannel" }]);
  });

  it("drops an outstanding guess with the identifier it belonged to", async () => {
    await mount();
    trigger().click(); // guessed +1 on the old identifier
    root().setAttribute("data-stimeo--live-counter-channel-value", "OtherChannel");
    await tick();
    mixins[1]?.connected?.();

    mixins[1]?.received?.({ delta: 1, by: "alice" }); // on the new identifier, nobody's guess
    expect(value().textContent).toBe("130");
  });

  it("clears a rejected hook when the identifier changes", async () => {
    await mount({ confirm: false });
    mixin?.rejected?.();
    expect(root().getAttribute("data-live-counter-rejected")).toBe("true");

    root().setAttribute("data-stimeo--live-counter-channel-value", "OtherChannel");
    await tick();
    expect(root().hasAttribute("data-live-counter-rejected")).toBe(false);
  });

  it("keeps the declared channel when the params name one too", async () => {
    await mount({
      attrs: `data-stimeo--live-counter-channel-value="LikesChannel"
              data-stimeo--live-counter-params-value='{"channel":"Other","post":7}'`,
    });
    expect(descriptors).toEqual([{ channel: "LikesChannel", post: 7 }]);
  });

  // --- Reading the display ---------------------------------------------------

  it("falls back to a delta of one for a param that is not a number", async () => {
    await mount({ buttonAttrs: 'data-stimeo--live-counter-delta-param="abc"' });
    (document.querySelector("button") as HTMLButtonElement).click();
    expect(performMock).toHaveBeenCalledWith("increment", { id: "alice", delta: 1 });
  });

  it("counts on the element itself when there is no value target", async () => {
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--live-counter"
             data-stimeo--live-counter-channel-value="LikesChannel"
             data-stimeo--live-counter-id-value="alice">128</div>
      </main>`;
    application = Application.start();
    application.register("stimeo--live-counter", LiveCounterController);
    await tick();
    mixin?.connected?.();
    mixin?.received?.({ count: 300 });
    expect(root().textContent).toBe("300");
  });

  it("counts a display holding no number as zero", async () => {
    await mount({ displayed: "many" });
    (document.querySelector("button") as HTMLButtonElement).click();
    expect(value().textContent).toBe("1");
  });

  // --- Opt-in announcement ---------------------------------------------------

  /** Collects everything handed to the page's shared announcer while `run` executes. */
  const announcements = async (run: () => void) => {
    const spoken: string[] = [];
    const onAnnounce = (event: Event) => {
      spoken.push((event as CustomEvent<{ message: string }>).detail.message);
    };
    window.addEventListener("stimeo--announcer:announce", onAnnounce);
    // Driven off a mocked clock: the debounce window is a contract, not a delay
    // the suite should sit through, and a real one is only ever "long enough".
    vi.useFakeTimers();
    run();
    await vi.advanceTimersByTimeAsync(260); // past the debounce
    vi.useRealTimers();
    window.removeEventListener("stimeo--announcer:announce", onAnnounce);
    return spoken;
  };

  /** A counter that opted into announcements. */
  const announcing = `data-stimeo--live-counter-channel-value="LikesChannel"
              data-stimeo--live-counter-id-value="alice"
              data-stimeo--live-counter-announce-text-value="{count} likes"`;

  it("announces a reconciled count when the consumer asked for it", async () => {
    await mount({ attrs: announcing });
    const spoken = await announcements(() => {
      mixin?.received?.({ count: 200 });
      mixin?.received?.({ count: 201 });
    });
    expect(spoken).toEqual(["201 likes"]); // one announcement for the burst
  });

  it("says nothing without an announcement template", async () => {
    await mount();
    const spoken = await announcements(() => {
      mixin?.received?.({ count: 200 });
    });
    expect(spoken).toEqual([]);
  });

  it("says nothing for an optimistic bump, which the server has yet to confirm", async () => {
    await mount({ attrs: announcing });
    const spoken = await announcements(() => {
      trigger().click();
    });
    expect(spoken).toEqual([]); // reading a guess out would only be corrected later
    expect(value().textContent).toBe("129");
  });

  it("drops a pending announcement on disconnect", async () => {
    await mount({ attrs: announcing });
    const spoken = await announcements(() => {
      mixin?.received?.({ count: 200 });
      controller()?.disconnect();
    });
    expect(spoken).toEqual([]);
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount();
    await expectNoA11yViolations(document.body);
  });

  // --- Speech order -----------------------------------------------------------

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
