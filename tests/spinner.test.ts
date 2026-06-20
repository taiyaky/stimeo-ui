import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpinnerController } from "../src/controllers/spinner_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link SpinnerController}: show-delay suppression, the
 * min-duration floor, `aria-busy` mirroring, the live-region announcement, and
 * timer teardown on disconnect.
 */

describe("SpinnerController", () => {
  let application: Application;

  const start = async (attrs = "") => {
    document.body.innerHTML = `
      <div data-controller="stimeo--spinner" ${attrs}>
        <div role="status" aria-live="polite" hidden
             data-stimeo--spinner-target="indicator">
          <span data-stimeo--spinner-target="message">Loading…</span>
        </div>
        <div aria-busy="false" data-stimeo--spinner-target="region"></div>
      </div>`;
    application = Application.start();
    application.register("stimeo--spinner", SpinnerController);
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    application.stop();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--spinner']");
  const indicator = () => query("[data-stimeo--spinner-target='indicator']");
  const region = () => query("[data-stimeo--spinner-target='region']");
  const instance = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--spinner",
    ) as SpinnerController;

  it("starts idle", async () => {
    await start();
    expect(root().getAttribute("data-state")).toBe("idle");
    expect(indicator().hidden).toBe(true);
  });

  it("shows the spinner immediately with no delay", async () => {
    await start();
    instance().start();
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(indicator().hidden).toBe(false);
    expect(region().getAttribute("aria-busy")).toBe("true");
  });

  it("suppresses the spinner for operations that finish within the delay", async () => {
    await start('data-stimeo--spinner-delay-value="150"');
    instance().start();
    expect(root().getAttribute("data-state")).toBe("pending");
    expect(indicator().hidden).toBe(true);
    // Finish before the delay elapses: the spinner must never appear.
    instance().stop();
    vi.advanceTimersByTime(200);
    expect(root().getAttribute("data-state")).toBe("idle");
    expect(indicator().hidden).toBe(true);
  });

  it("shows the spinner once the delay elapses", async () => {
    await start('data-stimeo--spinner-delay-value="150"');
    instance().start();
    vi.advanceTimersByTime(150);
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(indicator().hidden).toBe(false);
  });

  it("keeps the spinner visible for at least minDuration", async () => {
    await start('data-stimeo--spinner-min-duration-value="500"');
    instance().start();
    vi.advanceTimersByTime(100);
    instance().stop();
    // aria-busy clears at once, but the indicator stays until minDuration.
    expect(region().getAttribute("aria-busy")).toBe("false");
    expect(indicator().hidden).toBe(false);
    vi.advanceTimersByTime(400);
    expect(indicator().hidden).toBe(true);
    expect(root().getAttribute("data-state")).toBe("idle");
  });

  it("keeps the spinner shown when restarted during the min-duration wait", async () => {
    await start('data-stimeo--spinner-min-duration-value="500"');
    instance().start();
    vi.advanceTimersByTime(100);
    instance().stop(); // schedules a hide after the remaining min-duration
    expect(indicator().hidden).toBe(false);
    expect(region().getAttribute("aria-busy")).toBe("false");
    // A new load arrives before the hide fires: it must cancel the stale hide,
    // restore busy, and keep the spinner visible instead of flickering it away.
    instance().start();
    expect(region().getAttribute("aria-busy")).toBe("true");
    vi.advanceTimersByTime(500);
    expect(indicator().hidden).toBe(false);
    expect(root().getAttribute("data-state")).toBe("loading");
  });

  it("hides immediately when minDuration has already elapsed", async () => {
    await start('data-stimeo--spinner-min-duration-value="100"');
    instance().start();
    vi.advanceTimersByTime(200);
    instance().stop();
    expect(indicator().hidden).toBe(true);
  });

  it("dispatches show and hide events", async () => {
    await start();
    const events: string[] = [];
    root().addEventListener("stimeo--spinner:show", () => events.push("show"));
    root().addEventListener("stimeo--spinner:hide", () => events.push("hide"));
    instance().start();
    instance().stop();
    expect(events).toEqual(["show", "hide"]);
  });

  it("ignores start while already loading and stop while idle", async () => {
    await start();
    instance().stop();
    expect(root().getAttribute("data-state")).toBe("idle");
    instance().start();
    instance().start();
    expect(root().getAttribute("data-state")).toBe("loading");
  });

  it("clears pending timers on disconnect (no show after teardown)", async () => {
    await start('data-stimeo--spinner-delay-value="150"');
    instance().start();
    const el = indicator();
    // Invoke disconnect() directly (as number-input's teardown test does) rather
    // than removing the element and flushing Stimulus' async MutationObserver —
    // that flush timing was environment-sensitive (esp. under coverage).
    instance().disconnect();
    vi.advanceTimersByTime(300);
    // The pending show timer was cleared; nothing flips the indicator to loading.
    expect(el.hidden).toBe(true);
  });
});

/**
 * Layer ① (axe) and layer ③ (speech-order) checks run under real timers so the
 * virtual screen reader's own async work is not stalled by fake timers.
 */
describe("SpinnerController accessibility", () => {
  let application: Application;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  const start = async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--spinner">
        <div role="status" aria-live="polite" hidden
             data-stimeo--spinner-target="indicator">
          <span data-stimeo--spinner-target="message">Loading…</span>
        </div>
        <div aria-busy="false" data-stimeo--spinner-target="region"></div>
      </div>`;
    application = Application.start();
    application.register("stimeo--spinner", SpinnerController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--spinner']");
  const indicator = () => query("[data-stimeo--spinner-target='indicator']");
  const instance = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--spinner",
    ) as SpinnerController;

  it("has no machine-detectable a11y violations while loading", async () => {
    await start();
    instance().start();
    await expectNoA11yViolations(document.body, { rules: { region: { enabled: false } } });
  });

  it("announces the loading status through the live region", async () => {
    await start();
    instance().start();
    const spoken = await captureSpeech({ container: indicator(), steps: 1 });
    // Freeze the whole ordered array (not a name-only `toContain`): the live region
    // must keep its `status` role and announce the loading message, in order.
    expect(spoken).toEqual(["status", "Loading…"]);
  });
});
