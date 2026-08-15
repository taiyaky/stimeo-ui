import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleController } from "../src/controllers/idle_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link IdleController}, driven by a mocked clock: the idle
 * timeout, activity resetting the clock, the two-stage prompt warning, the
 * `active` recovery event, visibility handling, and listener/timer teardown.
 */

describe("IdleController", () => {
  let application: Application | undefined;

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
    // A case that only reads a static declaration never mounts, so the teardown is
    // conditional; clearing the reference afterwards keeps each case from inheriting
    // an Application an earlier one started.
    if (application) disconnectAndStopApplication(application);
    application = undefined;
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

  /**
   * Counts the timer scheduling the controller does, by wrapping the platform
   * `setTimeout` its timer registry calls (install after `mount()` so the arming
   * `connect()` does is not counted).
   *
   * The invariants below — "an activity event schedules nothing" and "a lapsed check
   * reschedules exactly once for the time remaining" — are statements about timer
   * operations, and both have the same observable outcome as the code that breaks
   * them: re-arming per event and rescheduling with 0 instead of the remaining time
   * still put `idle` / `prompt` at the same instant. The count is the only reading
   * that separates them.
   */
  const countScheduling = () => {
    const original = window.setTimeout;
    const counter = {
      calls: 0,
      restore: () => {
        window.setTimeout = original;
      },
    };
    window.setTimeout = ((...args: unknown[]) => {
      counter.calls += 1;
      return (original as (...a: unknown[]) => number)(...args);
    }) as unknown as typeof window.setTimeout;
    return counter;
  };

  it("still arms when the activity-events declaration is malformed", async () => {
    // Stimulus's own Array reader throws out of the value observer before any
    // callback runs, which would stop the controller connecting at all.
    await mount(
      'data-stimeo--idle-timeout-value="1000" data-stimeo--idle-events-value="[not json"',
    );

    vi.advanceTimersByTime(1000);
    expect(root().hasAttribute("data-idle")).toBe(true);

    // The default activity signals are still bound, so a real event recovers.
    document.dispatchEvent(new Event("keydown"));
    expect(root().hasAttribute("data-idle")).toBe(false);
  });

  it("fires idle and marks the element after the timeout elapses", async () => {
    await mount('data-stimeo--idle-timeout-value="1000"');
    const idle = collect("idle");

    vi.advanceTimersByTime(999);
    expect(idle).toHaveLength(0);
    expect(root().hasAttribute("data-idle")).toBe(false);

    vi.advanceTimersByTime(1);
    expect(idle).toHaveLength(1);
    expect(idle.map((e) => e.detail)).toEqual([{}]);
    expect(root().getAttribute("data-idle")).toBe("true");
  });

  it("falls back to the documented default timeout", async () => {
    await mount();
    const idle = collect("idle");

    vi.advanceTimersByTime(899_999);
    expect(idle).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(idle).toHaveLength(1);
  });

  it.each(["mousemove", "mousedown", "keydown", "wheel", "touchstart", "scroll"])(
    "treats the default-list %s event as activity",
    async (type) => {
      await mount('data-stimeo--idle-timeout-value="1000"');
      const idle = collect("idle");

      vi.advanceTimersByTime(900);
      activity(type);
      vi.advanceTimersByTime(900); // 1800 total, 900 since the activity
      expect(idle).toHaveLength(0);
      vi.advanceTimersByTime(100);
      expect(idle).toHaveLength(1);
    },
  );

  it("sees a non-bubbling activity event raised on a descendant", async () => {
    await mount('data-stimeo--idle-timeout-value="1000"');
    root().innerHTML = "<div id='inner'></div>";
    const idle = collect("idle");

    vi.advanceTimersByTime(900);
    // `scroll` does not bubble, so only the capture-phase document listener sees it.
    query("#inner").dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(900);
    expect(idle).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(idle).toHaveLength(1);
  });

  it("schedules no timer per activity event and reschedules the idle check once", async () => {
    await mount('data-stimeo--idle-timeout-value="1000"');
    const idle = collect("idle");
    const timers = countScheduling();
    try {
      // Ten activity events across 900ms: the hot path is a timestamp write, so the
      // armed timers are left alone rather than torn down and re-created each time.
      for (let i = 0; i < 10; i += 1) {
        vi.advanceTimersByTime(90);
        activity();
      }
      expect(timers.calls).toBe(0);

      // The idle check lapses at t = 1000 with 900ms left since the last activity and
      // reschedules itself for exactly that, so it fires once, at t = 1900.
      vi.advanceTimersByTime(1000);
      expect(idle).toHaveLength(1);
      expect(timers.calls).toBe(1);
    } finally {
      timers.restore();
    }
  });

  it("reschedules the prompt check once for its remaining time", async () => {
    await mount(
      'data-stimeo--idle-timeout-value="1000" data-stimeo--idle-prompt-before-value="300"',
    );
    const prompt = collect("prompt");
    const idle = collect("idle");
    const timers = countScheduling();
    try {
      vi.advanceTimersByTime(600);
      activity();
      expect(timers.calls).toBe(0);

      // Both checks lapse against a newer baseline and each reschedules once: the
      // prompt at t = 700 for 600ms, the idle check at t = 1000 for 600ms.
      vi.advanceTimersByTime(1000);
      expect(prompt).toHaveLength(1);
      expect(idle).toHaveLength(1);
      expect(timers.calls).toBe(2);
    } finally {
      timers.restore();
    }
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

  it("re-arms after waking so a later idle period fires again", async () => {
    await mount('data-stimeo--idle-timeout-value="1000"');
    const idle = collect("idle");

    vi.advanceTimersByTime(1000);
    expect(idle).toHaveLength(1);

    activity();
    expect(root().hasAttribute("data-idle")).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(idle).toHaveLength(2);
    expect(root().getAttribute("data-idle")).toBe("true");
  });

  it("emits no prompt while promptBefore keeps its default of 0", async () => {
    await mount('data-stimeo--idle-timeout-value="1000"');
    const prompt = collect("prompt");
    const idle = collect("idle");

    vi.advanceTimersByTime(1000);
    expect(prompt).toHaveLength(0);
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

  it("pushes the prompt back when activity resets the clock", async () => {
    await mount(
      'data-stimeo--idle-timeout-value="1000" data-stimeo--idle-prompt-before-value="300"',
    );
    const prompt = collect("prompt");

    vi.advanceTimersByTime(500);
    activity();
    vi.advanceTimersByTime(200); // t = 700 overall, but only 200 since the activity
    expect(prompt).toHaveLength(0);

    vi.advanceTimersByTime(500); // 700 since the activity
    expect(prompt).toHaveLength(1);
  });

  it("emits idle once when activity interrupts the prompt window", async () => {
    await mount(
      'data-stimeo--idle-timeout-value="1000" data-stimeo--idle-prompt-before-value="300"',
    );
    const prompt = collect("prompt");
    const idle = collect("idle");

    vi.advanceTimersByTime(700);
    expect(prompt).toHaveLength(1);

    // Waking mid-prompt leaves the idle check still pending; re-arming must replace it
    // rather than run a second chain alongside the fresh one.
    activity();
    vi.advanceTimersByTime(1000);
    expect(prompt).toHaveLength(2);
    expect(idle).toHaveLength(1);
  });

  it("fires active and clears the marker when the user returns after idle", async () => {
    await mount('data-stimeo--idle-timeout-value="1000"');
    const active = collect("active");

    vi.advanceTimersByTime(1000);
    expect(root().getAttribute("data-idle")).toBe("true");

    activity();
    expect(active).toHaveLength(1);
    expect(active.map((e) => e.detail)).toEqual([{}]);
    expect(root().hasAttribute("data-idle")).toBe(false);
  });

  it("clears a stale idle marker carried in by a restored snapshot", async () => {
    // A page cached mid-idle is restored with the marker already set, while the
    // controller starts a brand-new cycle.
    await mount('data-stimeo--idle-timeout-value="1000" data-idle="true"');
    const active = collect("active");

    expect(root().hasAttribute("data-idle")).toBe(false);
    activity();
    expect(active).toHaveLength(0);

    vi.advanceTimersByTime(1000);
    expect(root().getAttribute("data-idle")).toBe("true");
  });

  it("emits active once per return, not once per activity event", async () => {
    // Waking clears both flags, so a burst of activity is one return: the hot path stays
    // a timestamp write and the timers are not re-armed on every event.
    await mount(
      'data-stimeo--idle-timeout-value="1000" data-stimeo--idle-prompt-before-value="300"',
    );
    const active = collect("active");

    vi.advanceTimersByTime(700); // prompt fired, not idle yet
    activity();
    activity();
    activity();
    expect(active).toHaveLength(1);

    vi.advanceTimersByTime(1000); // prompt then idle, measured from the last activity
    expect(root().getAttribute("data-idle")).toBe("true");
    activity();
    activity();
    activity();
    expect(active).toHaveLength(2);
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

  it("keeps the clock running while the tab is hidden", async () => {
    await mount('data-stimeo--idle-timeout-value="1000"');
    const idle = collect("idle");
    const active = collect("active");

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      vi.advanceTimersByTime(900);
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(100);

      expect(active).toHaveLength(0);
      expect(idle).toHaveLength(1);
    } finally {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    }
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

  it("removes the activity listeners it registered even after the events Value changed", async () => {
    await mount(
      'data-stimeo--idle-timeout-value="1000" data-stimeo--idle-events-value=\'["mousemove"]\'',
    );
    const element = root();
    const active = collect("active");

    vi.advanceTimersByTime(1000);
    expect(element.getAttribute("data-idle")).toBe("true");

    element.setAttribute("data-stimeo--idle-events-value", '["keydown"]');
    element.remove();
    await vi.advanceTimersByTimeAsync(0);

    activity("mousemove");
    expect(active).toHaveLength(0);
    expect(element.getAttribute("data-idle")).toBe("true");
  });

  it("stops watching visibility after disconnect", async () => {
    await mount('data-stimeo--idle-timeout-value="1000"');
    const element = root();
    const active = collect("active");

    vi.advanceTimersByTime(1000);
    expect(element.getAttribute("data-idle")).toBe("true");

    element.remove();
    await vi.advanceTimersByTimeAsync(0);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(active).toHaveLength(0);
    expect(element.getAttribute("data-idle")).toBe("true");
  });

  it("stops timers and listeners after disconnect", async () => {
    await mount('data-stimeo--idle-timeout-value="1000"');
    const idle = collect("idle");
    root().remove();
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(2000);
    expect(idle).toHaveLength(0);
  });

  it("starts a fresh cycle when the element is moved in-page while idle", async () => {
    // Stimulus reuses the controller instance across an in-page move, so the internal
    // idle flags outlive the disconnect and must be re-synced with the marker.
    await mount('data-stimeo--idle-timeout-value="1000"');
    const element = root();
    const active = collect("active");

    vi.advanceTimersByTime(1000);
    expect(element.getAttribute("data-idle")).toBe("true");

    const parent = element.parentElement as HTMLElement;
    element.remove();
    await vi.advanceTimersByTimeAsync(0);
    parent.appendChild(element);
    await vi.advanceTimersByTimeAsync(0);

    expect(element.hasAttribute("data-idle")).toBe(false);
    activity();
    expect(active).toHaveLength(0);
  });

  it("starts a fresh cycle when the element is moved in-page during the prompt window", async () => {
    // The instance survives an in-page move with the prompt already raised, and the
    // fresh cycle owes no recovery for it: the next activity is the start of a new
    // window, not a return from the previous one.
    await mount(
      'data-stimeo--idle-timeout-value="1000" data-stimeo--idle-prompt-before-value="300"',
    );
    const element = root();
    const prompt = collect("prompt");
    const active = collect("active");

    vi.advanceTimersByTime(700); // prompt fired, not idle yet
    expect(prompt).toHaveLength(1);

    const parent = element.parentElement as HTMLElement;
    element.remove();
    await vi.advanceTimersByTimeAsync(0);
    parent.appendChild(element);
    await vi.advanceTimersByTimeAsync(0);

    activity();
    expect(active).toHaveLength(0);

    // The re-armed cycle still warns on its own schedule, measured from the move.
    vi.advanceTimersByTime(700);
    expect(prompt).toHaveLength(2);
  });

  it("declares the three public events the Inspector manifest reflects", () => {
    // `static events` is a pure declaration, so no behavioral test can reach it: the
    // manifest reads it verbatim, and losing an entry silently drops that event from
    // the published contract.
    expect(IdleController.events).toEqual(["prompt", "idle", "active"]);
  });

  it("has no a11y violations", async () => {
    // axe schedules real microtasks/timers, so run this case on the real clock.
    vi.useRealTimers();
    document.body.innerHTML = `<div data-controller="stimeo--idle"
      data-stimeo--idle-timeout-value="1000"></div>`;
    application = Application.start();
    application.register("stimeo--idle", IdleController);
    await tick();
    await expectNoA11yViolations(root());
  });
});
