import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleController } from "../src/controllers/idle_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link IdleController}, driven by a mocked clock: the idle
 * timeout, activity resetting the clock, the two-stage prompt warning, the
 * `active` recovery event, visibility handling, and listener/timer teardown.
 */

describe("IdleController", () => {
  let application: Application;

  const mount = async (attrs = "") => {
    document.body.innerHTML = `<div data-controller="stimeo--idle" ${attrs}></div>`;
    application = Application.start();
    application.register("stimeo--idle", IdleController);
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

  const root = () => query("[data-controller='stimeo--idle']");

  /** Simulates a user activity event on the document (capture listener catches it). */
  const activity = (type = "mousemove") => document.dispatchEvent(new Event(type));

  const collect = (type: "prompt" | "idle" | "active") => {
    const events: CustomEvent[] = [];
    root().addEventListener(`stimeo--idle:${type}`, (e) => events.push(e as CustomEvent));
    return events;
  };

  it("fires idle and marks the element after the timeout elapses", async () => {
    await mount('data-stimeo--idle-timeout-value="1000"');
    const idle = collect("idle");

    vi.advanceTimersByTime(999);
    expect(idle).toHaveLength(0);
    expect(root().hasAttribute("data-idle")).toBe(false);

    vi.advanceTimersByTime(1);
    expect(idle).toHaveLength(1);
    expect(root().getAttribute("data-idle")).toBe("true");
  });

  it("resets the clock on activity so idle never fires while active", async () => {
    await mount('data-stimeo--idle-timeout-value="1000"');
    const idle = collect("idle");

    vi.advanceTimersByTime(900);
    activity();
    vi.advanceTimersByTime(900); // 1800 total, but only 900 since last activity
    expect(idle).toHaveLength(0);

    vi.advanceTimersByTime(100); // 1000 since last activity
    expect(idle).toHaveLength(1);
  });

  it("fires idle exactly one timeout after the last of many activity events", async () => {
    await mount('data-stimeo--idle-timeout-value="1000"');
    const idle = collect("idle");
    // Hammer activity past the original deadline; the self-rescheduling timer must
    // keep tracking the last activity rather than firing at the initial arm time.
    for (let t = 0; t < 1500; t += 100) {
      vi.advanceTimersByTime(100);
      activity(); // last activity lands at t = 1500
    }
    expect(idle).toHaveLength(0);
    vi.advanceTimersByTime(999);
    expect(idle).toHaveLength(0);
    vi.advanceTimersByTime(1); // 1000 after the final activity
    expect(idle).toHaveLength(1);
  });

  it("fires prompt before idle when promptBefore is set", async () => {
    await mount(
      'data-stimeo--idle-timeout-value="1000" data-stimeo--idle-prompt-before-value="300"',
    );
    const prompt = collect("prompt");
    const idle = collect("idle");

    vi.advanceTimersByTime(700); // timeout - promptBefore
    expect(prompt).toHaveLength(1);
    expect(prompt[0]?.detail).toEqual({ remaining: 300 });
    expect(idle).toHaveLength(0);

    vi.advanceTimersByTime(300); // full timeout
    expect(idle).toHaveLength(1);
  });

  it("fires active and clears the marker when the user returns after idle", async () => {
    await mount('data-stimeo--idle-timeout-value="1000"');
    const active = collect("active");

    vi.advanceTimersByTime(1000);
    expect(root().getAttribute("data-idle")).toBe("true");

    activity();
    expect(active).toHaveLength(1);
    expect(root().hasAttribute("data-idle")).toBe(false);
  });

  it("fires active when the user responds during the prompt window (before idle)", async () => {
    await mount(
      'data-stimeo--idle-timeout-value="1000" data-stimeo--idle-prompt-before-value="300"',
    );
    const active = collect("active");
    const idle = collect("idle");

    vi.advanceTimersByTime(700); // prompt fired, not idle yet
    activity();
    expect(active).toHaveLength(1);

    // Re-arming starts a fresh full cycle, so idle has not fired yet.
    vi.advanceTimersByTime(999);
    expect(idle).toHaveLength(0);
  });

  it("does not fire active without a preceding prompt or idle", async () => {
    await mount('data-stimeo--idle-timeout-value="1000"');
    const active = collect("active");
    vi.advanceTimersByTime(500);
    activity();
    expect(active).toHaveLength(0);
  });

  it("treats returning to a visible tab as activity", async () => {
    await mount('data-stimeo--idle-timeout-value="1000"');
    const active = collect("active");
    vi.advanceTimersByTime(1000); // idle
    expect(root().getAttribute("data-idle")).toBe("true");

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(active).toHaveLength(1);
    expect(root().hasAttribute("data-idle")).toBe(false);
  });

  it("ignores a custom activity event list outside it", async () => {
    await mount(
      'data-stimeo--idle-timeout-value="1000" data-stimeo--idle-events-value=\'["keydown"]\'',
    );
    const idle = collect("idle");
    vi.advanceTimersByTime(900);
    activity("mousemove"); // not in the list → does not reset
    vi.advanceTimersByTime(100);
    expect(idle).toHaveLength(1);
  });

  it("stops timers and listeners after disconnect", async () => {
    await mount('data-stimeo--idle-timeout-value="1000"');
    const idle = collect("idle");
    root().remove();
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(2000);
    expect(idle).toHaveLength(0);
    // Activity after teardown must not throw or re-arm.
    expect(() => activity()).not.toThrow();
  });

  it("has no a11y violations", async () => {
    // axe schedules real microtasks/timers, so run this case on the real clock.
    vi.useRealTimers();
    document.body.innerHTML = `<div data-controller="stimeo--idle"
      data-stimeo--idle-timeout-value="1000"></div>`;
    application = Application.start();
    application.register("stimeo--idle", IdleController);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expectNoA11yViolations(root());
  });
});
