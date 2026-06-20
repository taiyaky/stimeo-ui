import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkStatusController } from "../src/controllers/network_status_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link NetworkStatusController}: the initial
 * `navigator.onLine` read, online/offline event handling, banner toggling, the
 * duplicate-state guard, auto-hide, and listener teardown on disconnect.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Overrides `navigator.onLine` for the duration of a test. */
const setOnline = (online: boolean) => {
  Object.defineProperty(navigator, "onLine", { value: online, configurable: true });
};

describe("NetworkStatusController", () => {
  let application: Application;

  const start = async (attrs = "") => {
    document.body.innerHTML = `
      <div data-controller="stimeo--network-status" ${attrs}>
        <div role="alert" hidden data-stimeo--network-status-target="offline">Offline</div>
        <div role="status" hidden data-stimeo--network-status-target="online">Back online</div>
      </div>`;
    application = Application.start();
    application.register("stimeo--network-status", NetworkStatusController);
    await tick();
  };

  beforeEach(() => {
    setOnline(true);
  });

  afterEach(() => {
    application.stop();
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

  // Layer ③ — going offline must announce the alert text through its live region.
  it("announces the offline alert through the live region", async () => {
    await start();
    window.dispatchEvent(new Event("offline"));
    const spoken = await captureSpeech({ container: offline(), steps: 1 });
    // Freeze the whole ordered array (not a name-only `toContain`): the live region
    // must keep its `alert` role and announce the offline message, in order.
    expect(spoken).toEqual(["alert", "Offline"]);
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
});
