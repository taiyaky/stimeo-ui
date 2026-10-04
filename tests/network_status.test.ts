import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkStatusController } from "../src/controllers/network_status_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link NetworkStatusController}: the initial
 * `navigator.onLine` read, online/offline event handling, banner toggling, the
 * duplicate-state guard, auto-hide, and listener teardown on disconnect.
 */

/** Overrides `navigator.onLine` for the duration of a test. */
const setOnline = (online: boolean) => {
  Object.defineProperty(navigator, "onLine", { value: online, configurable: true });
};

describe("NetworkStatusController", () => {
  let application: Application;

  /**
   * Mounts `banners` inside the controller element and starts Stimulus, without
   * waiting. Fake-timer tests must use this and advance the mocked clock instead
   * — `tick()` never resolves while `vi.useFakeTimers()` is active.
   */
  const mount = (banners: string, attrs = "") => {
    document.body.innerHTML = `
      <div data-controller="stimeo--network-status" ${attrs}>${banners}</div>`;
    application = Application.start();
    application.register("stimeo--network-status", NetworkStatusController);
  };

  /** {@link mount} plus the macrotask Stimulus needs to connect. */
  const startWith = async (banners: string, attrs = "") => {
    mount(banners, attrs);
    await tick();
  };

  const OFFLINE_BANNER = `<div hidden data-stimeo--network-status-target="offline">Offline</div>`;
  const ONLINE_BANNER = `<div hidden data-stimeo--network-status-target="online">Back online</div>`;

  const start = (attrs = "") => startWith(`${OFFLINE_BANNER}${ONLINE_BANNER}`, attrs);

  beforeEach(() => {
    setOnline(true);
  });

  afterEach(() => {
    // Safety net: a fake-timer test that fails before its own `useRealTimers()`
    // would otherwise leave the clock mocked and hang every later test.
    vi.useRealTimers();
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    setOnline(true);
  });

  const root = () => query("[data-controller='stimeo--network-status']");
  const offline = () => query("[data-stimeo--network-status-target='offline']");
  const online = () => query("[data-stimeo--network-status-target='online']");

  it("shows nothing when online on connect", async () => {
    await start();
    expect(root().getAttribute("data-state")).toBe("online");
    expect(offline().hidden).toBe(true);
    expect(online().hidden).toBe(true);
  });

  it("normalizes banner visibility on connect even if the markup omits hidden", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--network-status">
        <div data-stimeo--network-status-target="offline">Offline</div>
        <div data-stimeo--network-status-target="online">Back online</div>
      </div>`;
    application = Application.start();
    application.register("stimeo--network-status", NetworkStatusController);
    await tick();
    // Online on connect: a stale offline banner must not be left visible.
    expect(offline().hidden).toBe(true);
    expect(online().hidden).toBe(true);
  });

  it("shows the offline banner when offline on connect", async () => {
    setOnline(false);
    await start();
    expect(root().getAttribute("data-state")).toBe("offline");
    expect(offline().hidden).toBe(false);
  });

  it("reacts to an offline event", async () => {
    await start();
    window.dispatchEvent(new Event("offline"));
    expect(root().getAttribute("data-state")).toBe("offline");
    expect(offline().hidden).toBe(false);
    expect(online().hidden).toBe(true);
  });

  it("shows the recovery banner when coming back online", async () => {
    setOnline(false);
    await start();
    window.dispatchEvent(new Event("online"));
    expect(root().getAttribute("data-state")).toBe("online");
    expect(offline().hidden).toBe(true);
    expect(online().hidden).toBe(false);
  });

  it("hides the recovery banner when connectivity drops again", async () => {
    setOnline(false);
    await start();
    window.dispatchEvent(new Event("online"));
    expect(online().hidden).toBe(false);
    window.dispatchEvent(new Event("offline"));
    // Only one banner is ever shown: the recovery notice must go with the drop.
    expect(online().hidden).toBe(true);
    expect(offline().hidden).toBe(false);
  });

  it("keeps working when the markup omits the offline banner", async () => {
    setOnline(false);
    await startWith(ONLINE_BANNER);
    expect(root().getAttribute("data-state")).toBe("offline");
    window.dispatchEvent(new Event("online"));
    expect(root().getAttribute("data-state")).toBe("online");
    expect(online().hidden).toBe(false);
  });

  it("keeps working when the markup omits the recovery banner", async () => {
    setOnline(false);
    await startWith(OFFLINE_BANNER);
    expect(offline().hidden).toBe(false);
    const states: boolean[] = [];
    root().addEventListener("stimeo--network-status:change", (event) => {
      states.push((event as CustomEvent<{ online: boolean }>).detail.online);
    });
    window.dispatchEvent(new Event("online"));
    expect(offline().hidden).toBe(true);
    // The transition completes: `change` fires after the banners are updated.
    expect(states).toEqual([true]);
  });

  it("dispatches change on each transition", async () => {
    await start();
    const states: boolean[] = [];
    root().addEventListener("stimeo--network-status:change", (event) => {
      states.push((event as CustomEvent<{ online: boolean }>).detail.online);
    });
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    expect(states).toEqual([false, true]);
  });

  it("stays silent on connect even when the page opens offline", async () => {
    // The event marks a transition, and opening a page while already offline is not
    // one: a listener that reacts by retrying would fire on every page load.
    setOnline(false);
    const seen: boolean[] = [];
    const spy = (event: Event) => {
      seen.push((event as CustomEvent<{ online: boolean }>).detail.online);
    };
    document.addEventListener("stimeo--network-status:change", spy);
    try {
      await start();
      expect(offline().hidden).toBe(false); // the banner still shows
      expect(seen).toEqual([]);
    } finally {
      document.removeEventListener("stimeo--network-status:change", spy);
    }
  });

  it("dispatches change after the DOM is updated", async () => {
    // A listener that reads the banner or `data-state` runs on the state the
    // transition landed on, so the event has to come after both writes.
    await start();
    // `hidden` reflects the attribute, which the DOM types as string-or-boolean.
    const seen: Array<[string | null, string | boolean]> = [];
    root().addEventListener("stimeo--network-status:change", () => {
      seen.push([root().getAttribute("data-state"), offline().hidden]);
    });
    window.dispatchEvent(new Event("offline"));
    await tick();
    expect(seen).toEqual([["offline", false]]);
  });

  it("guards against duplicate-state events", async () => {
    await start();
    let changes = 0;
    root().addEventListener("stimeo--network-status:change", () => {
      changes += 1;
    });
    window.dispatchEvent(new Event("online")); // already online -> ignored
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("offline")); // duplicate -> ignored
    expect(changes).toBe(1);
  });

  it("auto-hides the recovery banner after onlineAutoHide", async () => {
    vi.useFakeTimers();
    setOnline(false);
    document.body.innerHTML = `
      <div data-controller="stimeo--network-status"
           data-stimeo--network-status-online-auto-hide-value="1000">
        <div hidden data-stimeo--network-status-target="offline">Offline</div>
        <div hidden data-stimeo--network-status-target="online">Back online</div>
      </div>`;
    application = Application.start();
    application.register("stimeo--network-status", NetworkStatusController);
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event("online"));
    expect(online().hidden).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(online().hidden).toBe(true);
    vi.useRealTimers();
  });

  it("leaves data-state alone when the recovery banner auto-hides", async () => {
    // The two hooks answer different questions: `hidden` is the banner's visibility,
    // `data-state` is connectivity. Retiring the banner does not take the page offline.
    vi.useFakeTimers();
    setOnline(false);
    document.body.innerHTML = `
      <div data-controller="stimeo--network-status"
           data-stimeo--network-status-online-auto-hide-value="1000">
        <div hidden data-stimeo--network-status-target="offline">Offline</div>
        <div hidden data-stimeo--network-status-target="online">Back online</div>
      </div>`;
    application = Application.start();
    application.register("stimeo--network-status", NetworkStatusController);
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event("online"));
    vi.advanceTimersByTime(1000);
    expect(online().hidden).toBe(true);
    expect(root().getAttribute("data-state")).toBe("online");
    vi.useRealTimers();
  });

  it("keeps the recovery banner up when onlineAutoHide is left at its default", async () => {
    vi.useFakeTimers();
    setOnline(false);
    mount(`${OFFLINE_BANNER}${ONLINE_BANNER}`);
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event("online"));
    expect(online().hidden).toBe(false);
    // Default `0` means "never auto-hide", so no amount of time may hide it.
    vi.advanceTimersByTime(600_000);
    expect(online().hidden).toBe(false);
    vi.useRealTimers();
  });

  it("does not let a stale auto-hide timer cut short a later recovery banner", async () => {
    vi.useFakeTimers();
    setOnline(false);
    mount(
      `${OFFLINE_BANNER}${ONLINE_BANNER}`,
      `data-stimeo--network-status-online-auto-hide-value="1000"`,
    );
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event("online"));
    vi.advanceTimersByTime(600);
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    // The first banner's timer was cancelled by the drop; the second banner owns
    // a full window rather than inheriting the 400ms left on the old one.
    vi.advanceTimersByTime(400);
    expect(online().hidden).toBe(false);
    vi.advanceTimersByTime(600);
    expect(online().hidden).toBe(true);
    vi.useRealTimers();
  });

  // --- `onlineAutoHide` belongs to one recovery banner -----------------------------

  /**
   * Rewrites `onlineAutoHide` and delivers its Value callback directly when the
   * controller defines one, since happy-dom does not reliably run it for an attribute
   * write.
   */
  const declareOnlineAutoHide = (value: number) => {
    root().setAttribute("data-stimeo--network-status-online-auto-hide-value", String(value));
    const owner = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--network-status",
    );
    const callback: unknown = Reflect.get(owner ?? {}, "onlineAutoHideValueChanged");
    if (typeof callback === "function") callback.call(owner);
  };

  it.each([
    { direction: "shrinks", next: 50 },
    { direction: "grows", next: 5000 },
  ])(
    "keeps a shown banner's hide deadline when onlineAutoHide $direction, and times the next recovery anew",
    async ({ next }) => {
      vi.useFakeTimers();
      setOnline(false);
      mount(
        `${OFFLINE_BANNER}${ONLINE_BANNER}`,
        `data-stimeo--network-status-online-auto-hide-value="1000"`,
      );
      await vi.advanceTimersByTimeAsync(0);
      window.dispatchEvent(new Event("online"));
      vi.advanceTimersByTime(100);

      declareOnlineAutoHide(next);
      vi.advanceTimersByTime(899);
      expect(online().hidden).toBe(false);
      vi.advanceTimersByTime(1);
      expect(online().hidden).toBe(true);

      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("online"));
      vi.advanceTimersByTime(next - 1);
      expect(online().hidden).toBe(false);
      vi.advanceTimersByTime(1);
      expect(online().hidden).toBe(true);
      vi.useRealTimers();
    },
  );

  it("hides and reports nothing from an onlineAutoHide change alone", async () => {
    vi.useFakeTimers();
    setOnline(false);
    mount(`${OFFLINE_BANNER}${ONLINE_BANNER}`);
    await vi.advanceTimersByTimeAsync(0);
    const changes: boolean[] = [];
    root().addEventListener("stimeo--network-status:change", (event) =>
      changes.push((event as CustomEvent<{ online: boolean }>).detail.online),
    );
    window.dispatchEvent(new Event("online")); // shown with no hide promised

    declareOnlineAutoHide(20);
    await vi.advanceTimersByTimeAsync(1000);
    expect(online().hidden).toBe(false);
    expect(offline().hidden).toBe(true);
    expect(root().getAttribute("data-state")).toBe("online");
    expect(changes).toEqual([true]);
    vi.useRealTimers();
  });

  it("clears the pending auto-hide timer on disconnect", async () => {
    vi.useFakeTimers();
    setOnline(false);
    mount(
      `${OFFLINE_BANNER}${ONLINE_BANNER}`,
      `data-stimeo--network-status-online-auto-hide-value="1000"`,
    );
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event("online"));
    const banner = online();
    expect(banner.hidden).toBe(false);
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--network-status",
    ) as NetworkStatusController;
    controller.disconnect();
    // The timer was cleared, so the detached controller never touches the banner.
    vi.advanceTimersByTime(5000);
    expect(banner.hidden).toBe(false);
    vi.useRealTimers();
  });

  it("removes window listeners on disconnect", async () => {
    await start();
    const el = offline();
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--network-status",
    ) as NetworkStatusController;
    // Invoke disconnect() directly for a deterministic teardown.
    controller.disconnect();
    window.dispatchEvent(new Event("offline"));
    // The window listener was removed; the banner stays hidden.
    expect(el.hidden).toBe(true);
  });

  it("ignores a recovery after disconnect", async () => {
    setOnline(false);
    await start();
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--network-status",
    ) as NetworkStatusController;
    controller.disconnect();
    window.dispatchEvent(new Event("online"));
    expect(root().getAttribute("data-state")).toBe("offline");
    expect(online().hidden).toBe(true);
    expect(offline().hidden).toBe(false);
  });

  // The offline banner is the visual half: the announcer carries the wording, so a
  // live-region role here would say it twice.
  it("reads the shown offline banner as plain text, not a live region", async () => {
    await start();
    window.dispatchEvent(new Event("offline"));
    const spoken = await captureSpeech({ container: offline(), steps: 1 });
    // Freeze the whole ordered array (not a name-only `toContain`): a generic
    // container yields its own text and then the node's, and what matters is that no
    // live-region role is spoken alongside them.
    expect(spoken).toEqual(["Offline", "Offline"]);
  });

  // The polite counterpart: the recovery banner is visual too.
  it("reads the shown recovery banner as plain text, not a live region", async () => {
    setOnline(false);
    await start();
    window.dispatchEvent(new Event("online"));
    const spoken = await captureSpeech({ container: online(), steps: 1 });
    expect(spoken).toEqual(["Back online", "Back online"]);
  });

  it("has no machine-detectable a11y violations", async () => {
    setOnline(false);
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--network-status">
          <div hidden data-stimeo--network-status-target="offline">Offline</div>
          <div hidden data-stimeo--network-status-target="online">Back online</div>
        </div>
      </main>`;
    application = Application.start();
    application.register("stimeo--network-status", NetworkStatusController);
    await tick();
    await expectNoA11yViolations(document.body);
  });

  it("announces the transitions through the shared announcer", async () => {
    // The banner is the visual half. A region revealed at the moment of the change is
    // not reliably read, so the wording goes to the page's announcer instead.
    const seen: Array<{ message: string; assertive: boolean }> = [];
    const spy = (event: Event) => {
      seen.push((event as CustomEvent<{ message: string; assertive: boolean }>).detail);
    };
    window.addEventListener("stimeo--announcer:announce", spy);
    try {
      await start(
        'data-stimeo--network-status-announce-text-value="Offline" ' +
          'data-stimeo--network-status-announce-online-text-value="Back online"',
      );
      window.dispatchEvent(new Event("offline"));
      await tick();
      window.dispatchEvent(new Event("online"));
      await tick();
      expect(seen).toEqual([
        { message: "Offline", assertive: true },
        { message: "Back online", assertive: false },
      ]);
    } finally {
      window.removeEventListener("stimeo--announcer:announce", spy);
    }
  });

  it("stays silent when no announcement wording is set", async () => {
    const seen: string[] = [];
    const spy = (event: Event) => {
      seen.push((event as CustomEvent<{ message: string }>).detail.message);
    };
    window.addEventListener("stimeo--announcer:announce", spy);
    try {
      await start();
      window.dispatchEvent(new Event("offline"));
      await tick();
      expect(seen).toEqual([]);
    } finally {
      window.removeEventListener("stimeo--announcer:announce", spy);
    }
  });

  it("leaves the banner's own markup untouched", async () => {
    // The banner's children and spacing are the consumer's; nothing here rewrites them.
    await startWith(
      `<div role="alert" hidden data-stimeo--network-status-target="offline">Offline. <button type="button" id="retry">Retry</button></div>`,
    );
    window.dispatchEvent(new Event("offline"));
    await tick();
    expect(offline().textContent).toBe("Offline. Retry");
    expect(offline().querySelector("#retry")).not.toBeNull();
  });

  describe("banners that arrive or stay", () => {
    const TARGET = "data-stimeo--network-status-target";
    /** A banner like the current one of `name`, showing `shown`. */
    const banner = (name: "offline" | "online", shown: boolean) => {
      const fresh = query(`[${TARGET}='${name}']`).cloneNode(true) as HTMLElement;
      fresh.hidden = !shown;
      return fresh;
    };
    const goOffline = () => window.dispatchEvent(new Event("offline"));
    const goOnline = () => window.dispatchEvent(new Event("online"));

    it("shows an offline banner that replaces the current one while offline", async () => {
      setOnline(false);
      await start();
      const successor = banner("offline", false);

      offline().replaceWith(successor);
      await tick();

      expect(offline()).toBe(successor);
      expect(successor.hidden).toBe(false);
    });

    it("shows an offline banner that stays after an earlier one leaves once offline", async () => {
      await start();
      const original = offline();
      const successor = banner("offline", false);
      original.after(successor);
      await tick();
      goOffline();
      original.remove();
      await tick();

      expect(offline()).toBe(successor);
      expect(successor.hidden).toBe(false);
    });

    it("hides an offline banner that stays after an earlier one leaves once back online", async () => {
      setOnline(false);
      await start();
      const original = offline();
      const successor = banner("offline", true);
      original.after(successor);
      await tick();
      goOnline();
      original.remove();
      await tick();

      expect(offline()).toBe(successor);
      expect(successor.hidden).toBe(true);
    });

    it("shows a recovery banner that replaces the current one while it is up", async () => {
      setOnline(false);
      await start();
      goOnline();
      const successor = banner("online", false);

      online().replaceWith(successor);
      await tick();

      expect(online()).toBe(successor);
      expect(successor.hidden).toBe(false);
    });

    it("shows a recovery banner that stays after an earlier one leaves once back online", async () => {
      setOnline(false);
      await start();
      const original = online();
      const successor = banner("online", false);
      original.after(successor);
      await tick();
      goOnline();
      original.remove();
      await tick();

      expect(online()).toBe(successor);
      expect(successor.hidden).toBe(false);
    });

    it("hides a recovery banner that stays after an earlier one leaves once it auto-hides", async () => {
      vi.useFakeTimers();
      setOnline(false);
      mount(
        `${OFFLINE_BANNER}${ONLINE_BANNER}`,
        `data-stimeo--network-status-online-auto-hide-value="1000"`,
      );
      await vi.advanceTimersByTimeAsync(0);
      goOnline();
      const original = online();
      const successor = banner("online", true);
      original.after(successor);
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(1000);
      expect(original.hidden).toBe(true);
      original.remove();
      await vi.advanceTimersByTimeAsync(0);

      expect(online()).toBe(successor);
      expect(successor.hidden).toBe(true);
      vi.useRealTimers();
    });

    it("hides a recovery banner that arrives while it is up once the auto-hide ends", async () => {
      vi.useFakeTimers();
      setOnline(false);
      mount(OFFLINE_BANNER, `data-stimeo--network-status-online-auto-hide-value="1000"`);
      await vi.advanceTimersByTimeAsync(0);
      goOnline();
      root().insertAdjacentHTML("beforeend", ONLINE_BANNER);
      await vi.advanceTimersByTimeAsync(0);
      expect(online().hidden).toBe(false);

      vi.advanceTimersByTime(1000);

      expect(online().hidden).toBe(true);
      vi.useRealTimers();
    });

    it("brings a banner up to date without an event or an announcement", async () => {
      setOnline(false);
      await start(
        'data-stimeo--network-status-announce-text-value="You are offline." ' +
          'data-stimeo--network-status-announce-online-text-value="Back online."',
      );
      const events: string[] = [];
      root().addEventListener("stimeo--network-status:change", () => events.push("change"));
      root().addEventListener("change", () => events.push("native change"));
      const spoken: string[] = [];
      const spy = (event: Event) => {
        spoken.push((event as CustomEvent<{ message: string }>).detail.message);
      };
      window.addEventListener("stimeo--announcer:announce", spy);
      const successor = banner("offline", false);

      offline().replaceWith(successor);
      await tick();
      window.removeEventListener("stimeo--announcer:announce", spy);

      expect(successor.hidden).toBe(false);
      expect(root().getAttribute("data-state")).toBe("offline");
      expect(events).toEqual([]);
      expect(spoken).toEqual([]);
    });

    it.each(["offline", "online"] as const)(
      "keeps working when its only %s banner leaves",
      async (name) => {
        setOnline(false);
        await start();
        const errors: unknown[] = [];
        application.handleError = (error) => {
          errors.push(error);
        };
        query(`[${TARGET}='${name}']`).remove();
        await tick();
        goOnline();
        goOffline();
        await tick();

        expect(errors).toEqual([]);
        expect(root().getAttribute("data-state")).toBe("offline");
      },
    );

    it("shows an offline banner that arrives after the only one left", async () => {
      setOnline(false);
      await start();
      const template = banner("offline", false);
      offline().remove();
      await tick();

      root().append(template);
      await tick();

      expect(template.hidden).toBe(false);
    });

    it("shows a recovery banner that arrives after the only one left", async () => {
      setOnline(false);
      await start();
      goOnline();
      const template = banner("online", false);
      online().remove();
      await tick();

      root().append(template);
      await tick();

      expect(template.hidden).toBe(false);
    });

    it("gives a banner that stops being one back the hidden it was authored with", async () => {
      setOnline(false);
      await start();
      const departed = offline();
      expect(departed.hidden).toBe(false);

      departed.removeAttribute(TARGET);
      await tick();

      expect(departed.hidden).toBe(true);
    });

    it("removes the hidden it wrote on a departed banner that was authored without one", async () => {
      await startWith(`<div data-stimeo--network-status-target="online">Back online</div>`);
      const departed = online();
      expect(departed.hidden).toBe(true);

      departed.removeAttribute(TARGET);
      await tick();

      expect(departed.hasAttribute("hidden")).toBe(false);
    });

    it("keeps a hidden the page wrote on a banner after the last write", async () => {
      setOnline(false);
      await start();
      const departed = offline();
      departed.hidden = true;

      departed.removeAttribute(TARGET);
      await tick();
      departed.hidden = false;
      goOnline();

      expect(departed.hidden).toBe(false);
    });

    it("gives the banners back their own hidden when the widget loses its controller", async () => {
      setOnline(false);
      await start();
      goOnline();
      goOffline();
      const departed = offline();
      expect(departed.hidden).toBe(false);

      root().removeAttribute("data-controller");
      await tick();

      expect(departed.hidden).toBe(true);
    });

    it("keeps a banner that moves within the widget shown without touching it", async () => {
      setOnline(false);
      await start();
      const moving = offline();
      const writes: string[] = [];
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.attributeName === "hidden") writes.push(String(record.oldValue));
        }
      }).observe(moving, { attributes: true, attributeOldValue: true });

      root().append(moving);
      await tick();

      expect(offline()).toBe(moving);
      expect(moving.hidden).toBe(false);
      expect(writes).toEqual([]);
    });

    it("keeps what it wrote on a banner when the whole widget leaves the page", async () => {
      setOnline(false);
      await start();
      const kept = offline();

      root().remove();
      await tick();

      expect(kept.hidden).toBe(false);
    });

    it("writes nothing onto the banners while Stimulus tears the controller down", async () => {
      setOnline(false);
      await start();
      // A value the page wrote after the last write stays where it was left.
      offline().hidden = true;

      application.unload("stimeo--network-status");
      await tick();

      expect(offline().hidden).toBe(true);
    });
  });
});
