import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CountdownController } from "../src/controllers/countdown_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link CountdownController}, driven by a mocked clock:
 * remaining-time formatting, ticking, pause/resume accounting, completion,
 * count-up mode, and interval teardown on disconnect.
 */

/** Fixed "now" so deadlines are deterministic across the suite. */
const NOW = new Date("2026-06-06T00:00:00Z");

describe("CountdownController", () => {
  let application: Application;

  const start = async (attrs: string) => {
    document.body.innerHTML = `
      <div data-controller="stimeo--countdown" role="timer" aria-live="off" ${attrs}
           data-action="countdown:pause->stimeo--countdown#pause
                        countdown:resume->stimeo--countdown#resume">
        <span data-stimeo--countdown-target="days">0</span>
        <span data-stimeo--countdown-target="hours">00</span>
        <span data-stimeo--countdown-target="minutes">00</span>
        <span data-stimeo--countdown-target="seconds">00</span>
        <span role="status" data-stimeo--countdown-target="status"></span>
      </div>`;
    application = Application.start();
    application.register("stimeo--countdown", CountdownController);
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    application.stop();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--countdown']");
  const slot = (name: string) => query(`[data-stimeo--countdown-target='${name}']`);
  const instance = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--countdown",
    ) as CountdownController;

  it("renders the initial remaining time into the slots", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T01:02:03Z"');
    expect(slot("days").textContent).toBe("0");
    expect(slot("hours").textContent).toBe("01");
    expect(slot("minutes").textContent).toBe("02");
    expect(slot("seconds").textContent).toBe("03");
    expect(root().getAttribute("data-state")).toBe("running");
  });

  it("ticks down each interval", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z"');
    expect(slot("seconds").textContent).toBe("10");
    vi.advanceTimersByTime(1000);
    expect(slot("seconds").textContent).toBe("09");
    vi.advanceTimersByTime(3000);
    expect(slot("seconds").textContent).toBe("06");
  });

  it("emits tick with the remaining ms and direction", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z"');
    const ticks: Array<{ remaining: number; direction: string }> = [];
    root().addEventListener("stimeo--countdown:tick", (event) => {
      ticks.push((event as CustomEvent<{ remaining: number; direction: string }>).detail);
    });
    vi.advanceTimersByTime(2000);
    expect(ticks).toEqual([
      { remaining: 9000, direction: "down" },
      { remaining: 8000, direction: "down" },
    ]);
  });

  it("reports direction=up in tick detail when counting up", async () => {
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-06T00:00:00Z" data-stimeo--countdown-direction-value="up"',
    );
    let detail: { remaining: number; direction: string } | null = null;
    root().addEventListener("stimeo--countdown:tick", (event) => {
      detail = (event as CustomEvent<{ remaining: number; direction: string }>).detail;
    });
    vi.advanceTimersByTime(1000);
    expect(detail).toEqual({ remaining: 1000, direction: "up" });
  });

  it("completes at zero, emits complete, and writes the status label", async () => {
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z" data-stimeo--countdown-complete-label-value="Time up"',
    );
    let completed = false;
    root().addEventListener("stimeo--countdown:complete", () => {
      completed = true;
    });
    vi.advanceTimersByTime(2000);
    expect(completed).toBe(true);
    expect(root().getAttribute("data-state")).toBe("complete");
    expect(slot("seconds").textContent).toBe("00");
    expect(slot("status").textContent).toBe("Time up");
  });

  it("completes immediately when the deadline is already past", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-05T23:59:59Z"');
    expect(root().getAttribute("data-state")).toBe("complete");
  });

  it("pauses and resumes, preserving the displayed amount", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z"');
    vi.advanceTimersByTime(3000);
    expect(slot("seconds").textContent).toBe("07");
    instance().pause();
    expect(root().getAttribute("data-state")).toBe("paused");
    // Time passes while paused: the display must not move.
    vi.advanceTimersByTime(5000);
    expect(slot("seconds").textContent).toBe("07");
    instance().resume();
    expect(root().getAttribute("data-state")).toBe("running");
    vi.advanceTimersByTime(1000);
    expect(slot("seconds").textContent).toBe("06");
  });

  it("does not autostart when autostart is false", async () => {
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z" data-stimeo--countdown-autostart-value="false"',
    );
    expect(root().getAttribute("data-state")).toBe("paused");
    // No interval runs, so the display stays frozen at its initial render…
    vi.advanceTimersByTime(3000);
    expect(slot("seconds").textContent).toBe("10");
    // …until start() begins ticking against the (now closer) absolute deadline.
    instance().start();
    vi.advanceTimersByTime(1000);
    expect(slot("seconds").textContent).toBe("06");
  });

  it("counts up from the deadline in direction=up", async () => {
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-06T00:00:00Z" data-stimeo--countdown-direction-value="up"',
    );
    expect(slot("seconds").textContent).toBe("00");
    vi.advanceTimersByTime(3000);
    expect(slot("seconds").textContent).toBe("03");
  });

  it("clamps count-up to zero before the deadline is reached", async () => {
    // Deadline 10s in the future: elapsed-since-deadline is negative, so up-mode
    // shows 0 until the deadline passes, then counts up.
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z" data-stimeo--countdown-direction-value="up"',
    );
    expect(slot("seconds").textContent).toBe("00");
    vi.advanceTimersByTime(3000);
    expect(slot("seconds").textContent).toBe("00");
    vi.advanceTimersByTime(10_000); // now 3s past the deadline
    expect(slot("seconds").textContent).toBe("03");
  });

  it("reset re-anchors to the deadline in up-mode (discarding a pause offset)", async () => {
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-06T00:00:00Z" data-stimeo--countdown-direction-value="up"',
    );
    vi.advanceTimersByTime(3000);
    expect(slot("seconds").textContent).toBe("03");
    // Pause holds the elapsed display at 03 while four more wall-seconds pass…
    instance().pause();
    vi.advanceTimersByTime(4000);
    instance().resume();
    expect(slot("seconds").textContent).toBe("03");
    // …reset discards the offset and re-syncs to the absolute deadline: seven
    // wall-seconds have elapsed since it, so the display jumps to 07.
    instance().reset();
    expect(slot("seconds").textContent).toBe("07");
  });

  it("re-anchors to the true deadline on reset (discarding a pause offset)", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z"');
    vi.advanceTimersByTime(2000);
    expect(slot("seconds").textContent).toBe("08");
    // Pause holds the display at 08 while four more seconds of wall-clock pass…
    instance().pause();
    vi.advanceTimersByTime(4000);
    instance().resume();
    expect(slot("seconds").textContent).toBe("08");
    // …reset throws that offset away and re-syncs to the real deadline: six
    // seconds of wall-clock have elapsed, so four remain.
    instance().reset();
    expect(slot("seconds").textContent).toBe("04");
  });

  it("keeps ticking after resetting a running countdown", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z"');
    vi.advanceTimersByTime(3000);
    expect(slot("seconds").textContent).toBe("07");
    // Resetting a *running* timer must re-arm the interval, not render once and freeze.
    // Regression: teardownInterval() left data-state="running", so the follow-up start()
    // no-op'd and the display stuck at the reset value while the clock kept advancing.
    instance().reset();
    expect(root().getAttribute("data-state")).toBe("running");
    expect(slot("seconds").textContent).toBe("07");
    vi.advanceTimersByTime(2000);
    expect(slot("seconds").textContent).toBe("05");
  });

  it("stays paused when reset while paused, then resumes from the reset amount", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z"');
    vi.advanceTimersByTime(3000);
    expect(slot("seconds").textContent).toBe("07");
    instance().pause();
    expect(root().getAttribute("data-state")).toBe("paused");
    // Reset while paused must re-sync the display but NOT auto-restart — it stays paused
    // until the user resumes (reset reads the run state from the DOM, not `autostart`).
    instance().reset();
    expect(root().getAttribute("data-state")).toBe("paused");
    expect(slot("seconds").textContent).toBe("07");
    // Still paused → no ticking as wall-clock advances.
    vi.advanceTimersByTime(3000);
    expect(slot("seconds").textContent).toBe("07");
    // Resume continues from the reset amount (not from 0, which would complete at once).
    instance().resume();
    expect(root().getAttribute("data-state")).toBe("running");
    vi.advanceTimersByTime(1000);
    expect(slot("seconds").textContent).toBe("06");
  });

  it("clears the completion status when reset after completing", async () => {
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z" data-stimeo--countdown-complete-label-value="Time up"',
    );
    vi.advanceTimersByTime(2000);
    expect(root().getAttribute("data-state")).toBe("complete");
    expect(slot("status").textContent).toBe("Time up");
    // Reset must not leave the stale completion text in the status live region.
    instance().reset();
    expect(slot("status").textContent).toBe("");
  });

  it("clears the interval on disconnect", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:01:00Z"');
    const secondsEl = slot("seconds");
    // Invoke disconnect() directly for a deterministic teardown (no reliance on
    // the async MutationObserver flush, which was environment-sensitive).
    instance().disconnect();
    vi.advanceTimersByTime(5000);
    // No tick should mutate the slot past its initial value after teardown.
    expect(secondsEl.textContent).toBe("00");
  });
});

/**
 * Layer ① (axe) and layer ③ (speech-order) run under real timers so the virtual
 * screen reader's async work is not stalled by fake timers. A far-future deadline
 * keeps the (1s) interval from firing during the short test.
 */
describe("CountdownController accessibility", () => {
  let application: Application;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  const startReal = async () => {
    const deadline = new Date(Date.now() + 3_600_000).toISOString();
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--countdown" role="timer" aria-live="off"
             aria-label="Sale ends in"
             data-stimeo--countdown-deadline-value="${deadline}">
          <span data-stimeo--countdown-target="days">0</span>
          <span data-stimeo--countdown-target="hours">00</span>
          <span data-stimeo--countdown-target="minutes">00</span>
          <span data-stimeo--countdown-target="seconds">00</span>
        </div>
      </main>`;
    application = Application.start();
    application.register("stimeo--countdown", CountdownController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  it("has no machine-detectable a11y violations", async () => {
    await startReal();
    await expectNoA11yViolations(document.body);
  });

  it("announces the timer role and accessible name", async () => {
    await startReal();
    const root = query("[data-controller='stimeo--countdown']");
    const spoken = await captureSpeech({ container: root, steps: 0 });
    // Freeze the whole ordered array (not a name-only `toContain`): the timer role
    // and accessible name are all the AT announces for the live region.
    expect(spoken).toEqual(["timer, Sale ends in"]);
  });
});
