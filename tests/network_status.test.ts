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

  const OFFLINE_BANNER = `<div role="alert" hidden data-stimeo--network-status-target="offline">Offline</div>`;
  const ONLINE_BANNER = `<div role="status" hidden data-stimeo--network-status-target="online">Back online</div>`;

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
        <div role="alert" data-stimeo--network-status-target="offline">Offline</div>
        <div role="status" data-stimeo--network-status-target="online">Back online</div>
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
        <div role="alert" hidden data-stimeo--network-status-target="offline">Offline</div>
        <div role="status" hidden data-stimeo--network-status-target="online">Back online</div>
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
        <div role="alert" hidden data-stimeo--network-status-target="offline">Offline</div>
        <div role="status" hidden data-stimeo--network-status-target="online">Back online</div>
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

  // Going offline must announce the alert text through its live region.
  it("announces the offline alert through the live region", async () => {
    await start();
    window.dispatchEvent(new Event("offline"));
    const spoken = await captureSpeech({ container: offline(), steps: 1 });
    // Freeze the whole ordered array (not a name-only `toContain`): the live region
    // must keep its `alert` role and announce the offline message, in order.
    expect(spoken).toEqual(["alert", "Offline"]);
  });

  // Coming back online must announce the recovery text through its polite region.
  it("announces the recovery message through the live region", async () => {
    setOnline(false);
    await start();
    window.dispatchEvent(new Event("online"));
    const spoken = await captureSpeech({ container: online(), steps: 1 });
    // The polite counterpart of the alert case: role kept, message written.
    expect(spoken).toEqual(["status", "Back online"]);
  });

  it("has no machine-detectable a11y violations", async () => {
    setOnline(false);
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--network-status">
          <div role="alert" hidden data-stimeo--network-status-target="offline">Offline</div>
          <div role="status" hidden data-stimeo--network-status-target="online">Back online</div>
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
    // Nothing rewrites the banner any more: children and spacing are the consumer's.
    await startWith(
      `<div role="alert" hidden data-stimeo--network-status-target="offline">Offline. <button type="button" id="retry">Retry</button></div>`,
    );
    window.dispatchEvent(new Event("offline"));
    await tick();
    expect(offline().textContent).toBe("Offline. Retry");
    expect(offline().querySelector("#retry")).not.toBeNull();
  });
});
