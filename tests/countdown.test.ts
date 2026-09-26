import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CountdownController } from "../src/controllers/countdown_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

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
        <span data-stimeo--countdown-target="status"></span>
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
    disconnectAndStopApplication(application);
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

  /** Collects what the shared announcer was asked to read during `body`. */
  const captureAnnouncements = async (body: () => void | Promise<void>): Promise<string[]> => {
    const seen: string[] = [];
    const spy = (event: Event) => {
      seen.push((event as CustomEvent<{ message: string }>).detail.message);
    };
    window.addEventListener("stimeo--announcer:announce", spy);
    try {
      await body();
    } finally {
      window.removeEventListener("stimeo--announcer:announce", spy);
    }
    return seen;
  };

  it("renders the initial remaining time into the slots", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T01:02:03Z"');
    expect(slot("days").textContent).toBe("0");
    expect(slot("hours").textContent).toBe("01");
    expect(slot("minutes").textContent).toBe("02");
    expect(slot("seconds").textContent).toBe("03");
    expect(root().getAttribute("data-state")).toBe("running");
  });

  it("renders whole days into the days slot", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-08T03:04:05Z"');
    expect(slot("days").textContent).toBe("2");
    expect(slot("hours").textContent).toBe("03");
    expect(slot("minutes").textContent).toBe("04");
    expect(slot("seconds").textContent).toBe("05");
  });

  it("ticks down each interval", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z"');
    expect(slot("seconds").textContent).toBe("10");
    vi.advanceTimersByTime(1000);
    expect(slot("seconds").textContent).toBe("09");
    vi.advanceTimersByTime(3000);
    expect(slot("seconds").textContent).toBe("06");
  });

  it("ticks at the configured interval", async () => {
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z" data-stimeo--countdown-interval-value="2500"',
    );
    const ticks: number[] = [];
    root().addEventListener("stimeo--countdown:tick", (event) => {
      ticks.push((event as CustomEvent<{ remaining: number }>).detail.remaining);
    });
    // The interval Value drives the scheduling period, not just the default 1000.
    vi.advanceTimersByTime(5000);
    expect(ticks).toEqual([7500, 5000]);
    expect(slot("seconds").textContent).toBe("05");
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
    const details: unknown[] = [];
    root().addEventListener("stimeo--countdown:complete", (event) => {
      details.push((event as CustomEvent).detail);
    });
    vi.advanceTimersByTime(2000);
    // Freeze the whole detail, not just "it fired": the payload is empty, so any
    // key leaking out of the controller has to fail here.
    expect(details).toEqual([{}]);
    expect(root().getAttribute("data-state")).toBe("complete");
    expect(slot("seconds").textContent).toBe("00");
    expect(slot("status").textContent).toBe("Time up");
  });

  it("stops ticking once the countdown completes", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z"');
    const events: string[] = [];
    root().addEventListener("stimeo--countdown:tick", () => events.push("tick"));
    root().addEventListener("stimeo--countdown:complete", () => events.push("complete"));
    vi.advanceTimersByTime(2000);
    expect(events).toEqual(["tick", "tick", "complete"]);
    // Completion tears the interval down, so no further tick (nor a repeated
    // completion) may reach the consumer as wall-clock time keeps running.
    vi.advanceTimersByTime(5000);
    expect(events).toEqual(["tick", "tick", "complete"]);
    expect(root().getAttribute("data-state")).toBe("complete");
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

  it("ignores start while already running", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z"');
    const ticks: number[] = [];
    root().addEventListener("stimeo--countdown:tick", (event) => {
      ticks.push((event as CustomEvent<{ remaining: number }>).detail.remaining);
    });
    // A redundant start() must not stack a second interval on the running one: the
    // id field only remembers the last, so the first would tick on as an orphan.
    instance().start();
    vi.advanceTimersByTime(2000);
    expect(ticks).toEqual([9000, 8000]);
    expect(slot("seconds").textContent).toBe("08");
  });

  it("ignores pause while already paused", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z"');
    vi.advanceTimersByTime(3000);
    instance().pause();
    expect(slot("seconds").textContent).toBe("07");
    // A second pause must not re-read the clock: that would discard the offset the
    // first one captured, so resume() would jump to the wall-clock remainder.
    vi.advanceTimersByTime(4000);
    instance().pause();
    expect(root().getAttribute("data-state")).toBe("paused");
    expect(slot("seconds").textContent).toBe("07");
    instance().resume();
    vi.advanceTimersByTime(1000);
    expect(slot("seconds").textContent).toBe("06");
  });

  it("ignores resume while already running", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z"');
    vi.advanceTimersByTime(3000);
    expect(slot("seconds").textContent).toBe("07");
    // Resuming a running timer must not re-anchor from the stale pause amount (0
    // here, which would settle the countdown immediately).
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

  it("resumes count-up from the preserved elapsed amount", async () => {
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-06T00:00:00Z" data-stimeo--countdown-direction-value="up"',
    );
    vi.advanceTimersByTime(3000);
    expect(slot("seconds").textContent).toBe("03");
    instance().pause();
    vi.advanceTimersByTime(4000);
    instance().resume();
    // Count-up moves the anchor *back* by the preserved amount; using the countdown
    // arithmetic instead would put the origin in the future and clamp the display to 0.
    vi.advanceTimersByTime(1000);
    expect(slot("seconds").textContent).toBe("04");
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
    // Resetting a *running* timer must re-arm the interval, not render once and
    // freeze: reset tears the interval down, so the run state has to leave
    // "running" for the follow-up start() to take effect.
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

  it("re-arms the tick after reconnecting on a stale running state", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z"');
    vi.advanceTimersByTime(2000);
    expect(slot("seconds").textContent).toBe("08");
    // Turbo caches the snapshot with data-state="running" burned in, so the restored
    // element reconnects with that attribute already set. start() is a no-op while
    // "running", so connect() has to drop the stale state for autostart to re-arm.
    instance().disconnect();
    instance().connect();
    expect(root().getAttribute("data-state")).toBe("running");
    vi.advanceTimersByTime(2000);
    expect(slot("seconds").textContent).toBe("06");
  });

  it("does not re-emit complete when reconnecting on a stale complete state", async () => {
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z" data-stimeo--countdown-complete-label-value="Time up"',
    );
    const events: string[] = [];
    root().addEventListener("stimeo--countdown:complete", () => events.push("complete"));
    vi.advanceTimersByTime(2000);
    expect(events).toEqual(["complete"]);
    // Reconnecting on the cached "complete" snapshot must not announce the milestone
    // a second time: the deadline was reached in the previous visit, not now.
    instance().disconnect();
    instance().connect();
    expect(events).toEqual(["complete"]);
    expect(root().getAttribute("data-state")).toBe("complete");
    expect(slot("seconds").textContent).toBe("00");
  });

  it("resumes from the initial amount when autostart is false", async () => {
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z" data-stimeo--countdown-autostart-value="false"',
    );
    expect(root().getAttribute("data-state")).toBe("paused");
    const completions: string[] = [];
    root().addEventListener("stimeo--countdown:complete", () => completions.push("complete"));
    // The resting state connect() writes is a pause like any other, so resume() must
    // continue from the displayed amount rather than snapping the anchor to now.
    instance().resume();
    expect(completions).toEqual([]);
    expect(root().getAttribute("data-state")).toBe("running");
    vi.advanceTimersByTime(1000);
    expect(slot("seconds").textContent).toBe("09");
  });

  it("keeps the completion across a reconnect when autostart is off", async () => {
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z" data-stimeo--countdown-autostart-value="false"',
    );
    const events: string[] = [];
    root().addEventListener("stimeo--countdown:complete", () => events.push("complete"));
    instance().resume();
    vi.advanceTimersByTime(2000);
    expect(events).toEqual(["complete"]);

    // Without autostart, connect() writes the resting "paused" — but a snapshot that
    // already reached zero must keep "complete", or the next resume() crosses zero
    // again and announces the same milestone twice.
    instance().disconnect();
    instance().connect();
    expect(root().getAttribute("data-state")).toBe("complete");
    instance().resume();
    expect(events).toEqual(["complete"]);
  });

  it("re-arms a completed countdown whose deadline moved into the future", async () => {
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z" data-stimeo--countdown-autostart-value="false"',
    );
    instance().resume();
    vi.advanceTimersByTime(2000);
    expect(root().getAttribute("data-state")).toBe("complete");

    // The completion is kept only while the countdown is still settled: a deadline
    // pushed forward makes it a fresh, resumable timer again.
    root().setAttribute("data-stimeo--countdown-deadline-value", "2026-06-06T00:00:10Z");
    instance().disconnect();
    instance().connect();
    expect(root().getAttribute("data-state")).toBe("paused");
    instance().resume();
    expect(root().getAttribute("data-state")).toBe("running");
  });

  it("completes without a status target present", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--countdown" role="timer" aria-live="off"
           data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z"
           data-stimeo--countdown-complete-label-value="Time up">
        <span data-stimeo--countdown-target="seconds">00</span>
      </div>`;
    application = Application.start();
    application.register("stimeo--countdown", CountdownController);
    await vi.advanceTimersByTimeAsync(0);
    const events: string[] = [];
    root().addEventListener("stimeo--countdown:complete", () => events.push("complete"));
    // `status` is optional in the markup contract, so completing without one must
    // still announce and settle instead of throwing on a missing target.
    vi.advanceTimersByTime(2000);
    expect(events).toEqual(["complete"]);
    expect(root().getAttribute("data-state")).toBe("complete");
    expect(slot("seconds").textContent).toBe("00");
  });

  it("leaves a status message it did not write alone on reset", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z"');
    slot("status").textContent = "Bring your ticket";
    // `complete()` declines to write when `completeLabel` is empty, so reset() has
    // nothing of its own in there to take back — the text is the consumer's.
    instance().reset();
    expect(slot("status").textContent).toBe("Bring your ticket");
  });

  it("follows a deadline swapped in place by a morph", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z"');
    vi.advanceTimersByTime(2000);
    expect(slot("seconds").textContent).toBe("08");
    // A Turbo 8 morph keeps the element and swaps the attribute, so `connect()` never
    // runs again: without following the Value the timer counts to the old deadline
    // for the rest of the session.
    root().setAttribute("data-stimeo--countdown-deadline-value", "2026-06-06T00:00:30Z");
    await vi.advanceTimersByTimeAsync(0);
    expect(slot("seconds").textContent).toBe("28");
    expect(root().getAttribute("data-state")).toBe("running");
    vi.advanceTimersByTime(1000);
    expect(slot("seconds").textContent).toBe("27");
  });

  it("follows a direction swapped in place by a morph", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z"');
    vi.advanceTimersByTime(2000);
    expect(slot("seconds").textContent).toBe("08");
    root().setAttribute("data-stimeo--countdown-direction-value", "up");
    await vi.advanceTimersByTimeAsync(0);
    // Counting up from a deadline still ahead of now clamps to zero.
    expect(slot("seconds").textContent).toBe("00");
  });

  it("does not start or announce anything when a morph swaps the deadline", async () => {
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z" data-stimeo--countdown-autostart-value="false"',
    );
    const events: string[] = [];
    for (const type of ["stimeo--countdown:tick", "stimeo--countdown:complete"]) {
      root().addEventListener(type, () => events.push(type));
    }
    expect(root().getAttribute("data-state")).toBe("paused");
    root().setAttribute("data-stimeo--countdown-deadline-value", "2026-06-06T00:00:04Z");
    await vi.advanceTimersByTimeAsync(0);
    // Following a render input is a repaint, not a lifecycle event: a paused timer
    // stays paused and no milestone is replayed.
    expect(root().getAttribute("data-state")).toBe("paused");
    expect(events).toEqual([]);
    expect(slot("seconds").textContent).toBe("04");
    // The stored amount followed too, so resuming continues from the new deadline.
    instance().resume();
    vi.advanceTimersByTime(1000);
    expect(slot("seconds").textContent).toBe("03");
  });

  it("follows a completion label swapped in place after completion", async () => {
    const spoken = await captureAnnouncements(async () => {
      await start(
        'data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z" ' +
          'data-stimeo--countdown-complete-label-value="Time up" ' +
          'data-stimeo--countdown-announce-text-value="Time is up"',
      );
      vi.advanceTimersByTime(2000);
    });
    expect(spoken).toEqual(["Time is up"]);
    expect(slot("status").textContent).toBe("Time up");

    const events: string[] = [];
    for (const type of ["stimeo--countdown:tick", "stimeo--countdown:complete"]) {
      root().addEventListener(type, () => events.push(type));
    }
    // A morph keeps the completed element and swaps the attribute, so `connect()` never
    // runs again: without following the Value the slot keeps the old wording.
    const later = await captureAnnouncements(async () => {
      root().setAttribute("data-stimeo--countdown-complete-label-value", "Finished");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(slot("status").textContent).toBe("Finished");
    // Following the label is a repaint: the milestone is neither dispatched nor read
    // out a second time, and the countdown stays complete.
    expect(events).toEqual([]);
    expect(later).toEqual([]);
    expect(root().getAttribute("data-state")).toBe("complete");
  });

  it("takes back a completion label swapped after completion on reset", async () => {
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z" data-stimeo--countdown-complete-label-value="Time up"',
    );
    vi.advanceTimersByTime(2000);
    root().setAttribute("data-stimeo--countdown-complete-label-value", "Finished");
    await vi.advanceTimersByTimeAsync(0);
    // The slot shows the label now in force, so reset() still recognizes it as its own.
    instance().reset();
    expect(slot("status").textContent).toBe("");
  });

  it("withdraws its label when the completion label is removed after completion", async () => {
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z" data-stimeo--countdown-complete-label-value="Time up"',
    );
    vi.advanceTimersByTime(2000);
    expect(slot("status").textContent).toBe("Time up");
    root().removeAttribute("data-stimeo--countdown-complete-label-value");
    await vi.advanceTimersByTimeAsync(0);
    // Completion writes nothing for an empty label, so the wording on screen is withdrawn.
    expect(slot("status").textContent).toBe("");
  });

  it("writes no label ahead of completion when the label changes", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z"');
    root().setAttribute("data-stimeo--countdown-complete-label-value", "Finished");
    await vi.advanceTimersByTimeAsync(0);
    // The status holds completion wording only, and a running timer has none to show.
    expect(slot("status").textContent).toBe("");
    const events: string[] = [];
    root().addEventListener("stimeo--countdown:complete", () => events.push("complete"));
    vi.advanceTimersByTime(2000);
    // Completion writes the label in force when it happens.
    expect(events).toEqual(["complete"]);
    expect(slot("status").textContent).toBe("Finished");
  });

  it("leaves a status the consumer rewrote after completion alone", async () => {
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z" data-stimeo--countdown-complete-label-value="Time up"',
    );
    vi.advanceTimersByTime(2000);
    slot("status").textContent = "Doors open at 7";
    root().setAttribute("data-stimeo--countdown-complete-label-value", "Finished");
    await vi.advanceTimersByTimeAsync(0);
    // Only the label this controller wrote is followed; the consumer's text stays.
    expect(slot("status").textContent).toBe("Doors open at 7");
  });

  it("follows a label set after completing with an empty one", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z"');
    vi.advanceTimersByTime(2000);
    expect(root().getAttribute("data-state")).toBe("complete");
    expect(slot("status").textContent).toBe("");
    root().setAttribute("data-stimeo--countdown-complete-label-value", "Finished");
    await vi.advanceTimersByTimeAsync(0);
    // Completing with the empty label wrote no text but held the empty slot with an
    // empty marker, so the label set later reaches it.
    expect(slot("status").textContent).toBe("Finished");
  });

  it("leaves a status the consumer emptied alone when the label changes while detached", async () => {
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z" data-stimeo--countdown-complete-label-value="Time up"',
    );
    vi.advanceTimersByTime(2000);
    slot("status").textContent = "";
    const element = root();
    element.remove();
    await vi.advanceTimersByTimeAsync(0);
    element.setAttribute("data-stimeo--countdown-complete-label-value", "Finished");
    document.body.append(element);
    await vi.advanceTimersByTimeAsync(0);
    // Reconnecting delivers the swapped label ahead of connect(), which leaves it to
    // connect(); the marker still holds "Time up", which the emptied slot does not
    // show, so the slot is the consumer's and stays empty.
    expect(root().getAttribute("data-state")).toBe("complete");
    expect(slot("status").textContent).toBe("");
  });

  it("keeps the status of a restored completion as it is when connecting", async () => {
    // Stimulus delivers the label callback ahead of connect(), with the default as the
    // previous label. A completion restored from markup keeps its status as authored,
    // exactly as connect() keeps the state.
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-05T23:59:59Z" ' +
        'data-stimeo--countdown-complete-label-value="Time up" data-state="complete"',
    );
    expect(root().getAttribute("data-state")).toBe("complete");
    expect(slot("status").textContent).toBe("");
  });

  it("follows a completion label without a status target present", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--countdown" role="timer" aria-live="off"
           data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z"
           data-stimeo--countdown-complete-label-value="Time up">
        <span data-stimeo--countdown-target="seconds">00</span>
      </div>`;
    application = Application.start();
    application.register("stimeo--countdown", CountdownController);
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(2000);
    expect(root().getAttribute("data-state")).toBe("complete");
    // `status` is optional, so a label swapped after completion has nowhere to go and
    // must not throw on the missing target.
    expect(() => instance().completeLabelValueChanged()).not.toThrow();
    expect(root().getAttribute("data-state")).toBe("complete");
  });

  /** The attribute on the status recording the text this controller wrote there. */
  const OWNS_STATUS = "data-stimeo--countdown-owns-status";
  const LABEL = "data-stimeo--countdown-complete-label-value";

  /**
   * Takes the timer out of the document, runs `change` on it there, and puts it
   * back. Stimulus stops delivering Value callbacks while the element is out, and on
   * the way back it replays the changed ones ahead of `connect()`.
   */
  const whileDetached = async (change: (element: HTMLElement) => void): Promise<void> => {
    const element = root();
    element.remove();
    await vi.advanceTimersByTimeAsync(0);
    change(element);
    document.body.append(element);
    await vi.advanceTimersByTimeAsync(0);
  };

  it("marks the status it writes on completion as its own", async () => {
    await start(`data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z" ${LABEL}="Time up"`);
    vi.advanceTimersByTime(2000);
    expect(slot("status").textContent).toBe("Time up");
    // The marker holds the text itself: the slot is this controller's only while
    // the two still agree.
    expect(slot("status").getAttribute(OWNS_STATUS)).toBe("Time up");
    instance().reset();
    expect(slot("status").hasAttribute(OWNS_STATUS)).toBe(false);
  });

  it("follows a label changed while detached once it reconnects", async () => {
    await start(`data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z" ${LABEL}="Time up"`);
    vi.advanceTimersByTime(2000);
    const events: string[] = [];
    for (const type of ["stimeo--countdown:tick", "stimeo--countdown:complete"]) {
      root().addEventListener(type, () => events.push(type));
    }
    const spoken = await captureAnnouncements(() =>
      whileDetached((element) => element.setAttribute(LABEL, "Finished")),
    );
    // The callback runs ahead of connect() with the default as the previous label,
    // so connect() is what brings the status it wrote up to the label in force.
    expect(root().getAttribute("data-state")).toBe("complete");
    expect(slot("status").textContent).toBe("Finished");
    expect(slot("status").getAttribute(OWNS_STATUS)).toBe("Finished");
    // Following the label is a repaint, never a second milestone.
    expect(events).toEqual([]);
    expect(spoken).toEqual([]);
  });

  it("takes back a label changed while detached on reset", async () => {
    await start(`data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z" ${LABEL}="Time up"`);
    vi.advanceTimersByTime(2000);
    await whileDetached((element) => element.setAttribute(LABEL, "Finished"));
    instance().reset();
    expect(slot("status").textContent).toBe("");
    expect(slot("status").hasAttribute(OWNS_STATUS)).toBe(false);
  });

  it("withdraws a label emptied while detached and shows a later one again", async () => {
    await start(`data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z" ${LABEL}="Time up"`);
    vi.advanceTimersByTime(2000);
    await whileDetached((element) => element.removeAttribute(LABEL));
    expect(slot("status").textContent).toBe("");
    // The emptied slot is still this controller's, so the next label reaches it.
    root().setAttribute(LABEL, "Again");
    await vi.advanceTimersByTimeAsync(0);
    expect(slot("status").textContent).toBe("Again");
  });

  it("follows a label set while detached after completing with an empty one", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z"');
    vi.advanceTimersByTime(2000);
    await whileDetached((element) => element.setAttribute(LABEL, "Finished"));
    // Completing with an empty label wrote no text but claimed the empty slot, so the
    // label set later reaches it.
    expect(slot("status").textContent).toBe("Finished");
  });

  it("clears its own completion label when a restored completion re-arms", async () => {
    await start(`data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z" ${LABEL}="Time up"`);
    vi.advanceTimersByTime(2000);
    await whileDetached((element) =>
      element.setAttribute("data-stimeo--countdown-deadline-value", "2026-06-06T00:00:10Z"),
    );
    // A deadline moved forward hands the timer back paused, and a paused timer has no
    // completion to show.
    expect(root().getAttribute("data-state")).toBe("paused");
    expect(slot("status").textContent).toBe("");
    expect(slot("status").hasAttribute(OWNS_STATUS)).toBe(false);
  });

  const DEADLINE = "data-stimeo--countdown-deadline-value";

  it("hands a completion back paused when its deadline moves forward in place", async () => {
    await start(`${DEADLINE}="2026-06-06T00:00:02Z" ${LABEL}="Time up"`);
    vi.advanceTimersByTime(2000);
    expect(root().getAttribute("data-state")).toBe("complete");
    const events: string[] = [];
    for (const type of ["stimeo--countdown:tick", "stimeo--countdown:complete"]) {
      root().addEventListener(type, () => events.push(type));
    }
    // A morph keeps the element and swaps the attribute, so connect() never runs again:
    // the live element has to leave the completion the new deadline undoes.
    const spoken = await captureAnnouncements(async () => {
      root().setAttribute(DEADLINE, "2026-06-06T00:00:10Z");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(slot("seconds").textContent).toBe("08");
    expect(root().getAttribute("data-state")).toBe("paused");
    expect(slot("status").textContent).toBe("");
    expect(slot("status").hasAttribute(OWNS_STATUS)).toBe(false);
    // Leaving the completion is a repaint: nothing is dispatched or read out.
    expect(events).toEqual([]);
    expect(spoken).toEqual([]);
    // Paused, not complete, so resume() counts down from the new reading again.
    instance().resume();
    expect(root().getAttribute("data-state")).toBe("running");
    vi.advanceTimersByTime(1000);
    expect(slot("seconds").textContent).toBe("07");
  });

  it("leaves the consumer's status alone when a completion's deadline moves forward in place", async () => {
    await start(`${DEADLINE}="2026-06-06T00:00:02Z" ${LABEL}="Time up"`);
    vi.advanceTimersByTime(2000);
    slot("status").textContent = "Doors open at 7";
    root().setAttribute(DEADLINE, "2026-06-06T00:00:10Z");
    await vi.advanceTimersByTimeAsync(0);
    expect(root().getAttribute("data-state")).toBe("paused");
    expect(slot("status").textContent).toBe("Doors open at 7");
  });

  it("hands a completion back paused when the count flips to up in place", async () => {
    await start(`${DEADLINE}="2026-06-06T00:00:02Z" ${LABEL}="Time up"`);
    vi.advanceTimersByTime(2000);
    root().setAttribute("data-stimeo--countdown-direction-value", "up");
    await vi.advanceTimersByTimeAsync(0);
    // Only a countdown settles, exactly as connect() reads a restored completion.
    expect(root().getAttribute("data-state")).toBe("paused");
    expect(slot("status").textContent).toBe("");
    instance().resume();
    vi.advanceTimersByTime(1000);
    expect(slot("seconds").textContent).toBe("01");
  });

  it("takes its completion text back when start() counts on from the completion", async () => {
    await start(`${DEADLINE}="2026-06-06T00:00:02Z" ${LABEL}="Time up"`);
    vi.advanceTimersByTime(2000);
    expect(root().getAttribute("data-state")).toBe("complete");
    // Flipping the count to `up` and starting in the same task: start() runs ahead of
    // the direction callback, on a completion nothing has handed back yet.
    root().setAttribute("data-stimeo--countdown-direction-value", "up");
    instance().start();
    expect(root().getAttribute("data-state")).toBe("running");
    expect(slot("status").textContent).toBe("");
    expect(slot("status").hasAttribute(OWNS_STATUS)).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(1000);
    expect(root().getAttribute("data-state")).toBe("running");
    expect(slot("seconds").textContent).toBe("01");
    expect(slot("status").textContent).toBe("");
  });

  it("leaves the consumer's status alone when start() counts on from the completion", async () => {
    await start(`${DEADLINE}="2026-06-06T00:00:02Z" ${LABEL}="Time up"`);
    vi.advanceTimersByTime(2000);
    slot("status").textContent = "Doors open at 7";
    root().setAttribute("data-stimeo--countdown-direction-value", "up");
    instance().start();
    expect(root().getAttribute("data-state")).toBe("running");
    expect(slot("status").textContent).toBe("Doors open at 7");
    expect(slot("status").getAttribute(OWNS_STATUS)).toBe("Time up");
  });

  it("keeps a completion whose deadline moves but stays past", async () => {
    await start(`${DEADLINE}="2026-06-06T00:00:02Z" ${LABEL}="Time up"`);
    vi.advanceTimersByTime(2000);
    const events: string[] = [];
    root().addEventListener("stimeo--countdown:complete", () => events.push("complete"));
    root().setAttribute(DEADLINE, "2026-06-06T00:00:01Z");
    await vi.advanceTimersByTimeAsync(0);
    // Still at zero, so the milestone stands and the status keeps its label.
    expect(root().getAttribute("data-state")).toBe("complete");
    expect(slot("status").textContent).toBe("Time up");
    expect(events).toEqual([]);
  });

  it("leaves a status the consumer rewrote alone across a detached label change and reset", async () => {
    await start(`data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z" ${LABEL}="Time up"`);
    vi.advanceTimersByTime(2000);
    slot("status").textContent = "Doors open at 7";
    await whileDetached((element) => element.setAttribute(LABEL, "Finished"));
    expect(slot("status").textContent).toBe("Doors open at 7");
    instance().reset();
    expect(slot("status").textContent).toBe("Doors open at 7");
  });

  it("leaves the consumer's status alone when completing with an empty label", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z"');
    slot("status").textContent = "Bring your ticket";
    vi.advanceTimersByTime(2000);
    expect(root().getAttribute("data-state")).toBe("complete");
    // An empty label writes nothing, so it takes nothing over either.
    expect(slot("status").textContent).toBe("Bring your ticket");
    expect(slot("status").hasAttribute(OWNS_STATUS)).toBe(false);
    root().setAttribute(LABEL, "Finished");
    await vi.advanceTimersByTimeAsync(0);
    expect(slot("status").textContent).toBe("Bring your ticket");
  });

  it("owns the empty slot with an empty marker, even after the consumer empties it again", async () => {
    await start(`${DEADLINE}="2026-06-06T00:00:02Z"`);
    vi.advanceTimersByTime(2000);
    expect(slot("status").getAttribute(OWNS_STATUS)).toBe("");
    // While the slot shows the consumer's text, the text is theirs.
    slot("status").textContent = "Doors open at 7";
    root().setAttribute(LABEL, "Finished");
    await vi.advanceTimersByTimeAsync(0);
    expect(slot("status").textContent).toBe("Doors open at 7");
    // Emptied again, it is the empty slot the empty marker holds, so the next label
    // reaches it.
    slot("status").textContent = "";
    root().setAttribute(LABEL, "Time up");
    await vi.advanceTimersByTimeAsync(0);
    expect(slot("status").textContent).toBe("Time up");
  });

  it("leaves a slot the consumer rewrote and then emptied alone while the marker holds text", async () => {
    await start(`${DEADLINE}="2026-06-06T00:00:02Z" ${LABEL}="Time up"`);
    vi.advanceTimersByTime(2000);
    slot("status").textContent = "Doors open at 7";
    slot("status").textContent = "";
    root().setAttribute(LABEL, "Finished");
    await vi.advanceTimersByTimeAsync(0);
    // The marker still holds "Time up", which the emptied slot does not show.
    expect(slot("status").textContent).toBe("");
    expect(slot("status").getAttribute(OWNS_STATUS)).toBe("Time up");
  });

  it("leaves the status a restored completion brings alone on reset", async () => {
    // The markup arrives complete with the label already in the slot: that text is
    // the page's, whatever it reads, because this controller never wrote it.
    document.body.innerHTML = `
      <div data-controller="stimeo--countdown" role="timer" aria-live="off"
           data-state="complete"
           data-stimeo--countdown-deadline-value="2026-06-05T23:59:59Z"
           ${LABEL}="Time up">
        <span data-stimeo--countdown-target="seconds">00</span>
        <span data-stimeo--countdown-target="status">Time up</span>
      </div>`;
    application = Application.start();
    application.register("stimeo--countdown", CountdownController);
    await vi.advanceTimersByTimeAsync(0);
    expect(root().getAttribute("data-state")).toBe("complete");
    instance().reset();
    expect(slot("status").textContent).toBe("Time up");
  });

  it("marks the status under the identifier it is registered with", async () => {
    const alias = "event--timer";
    document.body.innerHTML = `
      <div data-controller="${alias}" role="timer" aria-live="off"
           data-${alias}-deadline-value="2026-06-06T00:00:02Z"
           data-${alias}-complete-label-value="Time up">
        <span data-${alias}-target="status"></span>
      </div>`;
    application = Application.start();
    application.register(alias, CountdownController);
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(2000);
    const status = query(`[data-${alias}-target='status']`);
    expect(status.textContent).toBe("Time up");
    expect(status.getAttribute(`data-${alias}-owns-status`)).toBe("Time up");
    expect(status.hasAttribute(OWNS_STATUS)).toBe(false);
  });

  // ---- A status the consumer adds an element to is theirs, even with the text unchanged ----

  /** A text-less element: adding it leaves the status text, and so the marker's match, as is. */
  const ICON = '<svg aria-hidden="true"><circle r="1"></circle></svg>';

  /** Empties the completion label in place. */
  const unlabel = async (): Promise<void> => {
    root().removeAttribute(LABEL);
    await vi.advanceTimersByTimeAsync(0);
  };

  /** Every path that brings a status holding this controller's text up to date. */
  const RESYNCS: ReadonlyArray<readonly [string, () => void | Promise<void>]> = [
    [
      "the completion label changes",
      async () => {
        root().setAttribute(LABEL, "Finished");
        await vi.advanceTimersByTimeAsync(0);
      },
    ],
    ["the completion label empties", unlabel],
    [
      "the label changes while detached",
      () => whileDetached((element) => element.setAttribute(LABEL, "Finished")),
    ],
    ["reset runs", () => instance().reset()],
    [
      "the deadline moves forward in place",
      async () => {
        root().setAttribute(DEADLINE, "2026-06-06T00:00:10Z");
        await vi.advanceTimersByTimeAsync(0);
      },
    ],
    [
      "the count turns up in place",
      async () => {
        root().setAttribute("data-stimeo--countdown-direction-value", "up");
        await vi.advanceTimersByTimeAsync(0);
      },
    ],
  ];

  it.each(RESYNCS)(
    "leaves a status it wrote alone once the consumer adds an element to it, when %s",
    async (_, resync) => {
      await start(`${DEADLINE}="2026-06-06T00:00:02Z" ${LABEL}="Time up"`);
      vi.advanceTimersByTime(2000);
      slot("status").insertAdjacentHTML("beforeend", ICON);
      // The text still matches the marker; the element is what makes the slot theirs.
      expect(slot("status").getAttribute(OWNS_STATUS)).toBe(slot("status").textContent);
      const authored = slot("status").outerHTML;
      await resync();
      // Neither written nor emptied, and the marker stays where it is.
      expect(slot("status").outerHTML).toBe(authored);
    },
  );

  // The label is already empty in these cases, so emptying it changes nothing and is left out.
  it.each(RESYNCS.filter(([, resync]) => resync !== unlabel))(
    "leaves an empty slot it claimed alone once the consumer adds an element to it, when %s",
    async (_, resync) => {
      await start(`${DEADLINE}="2026-06-06T00:00:02Z"`);
      vi.advanceTimersByTime(2000);
      expect(slot("status").getAttribute(OWNS_STATUS)).toBe("");
      slot("status").insertAdjacentHTML("beforeend", ICON);
      const authored = slot("status").outerHTML;
      await resync();
      expect(slot("status").outerHTML).toBe(authored);
    },
  );

  it("does not claim a slot holding an element when completing with an empty label", async () => {
    await start(`${DEADLINE}="2026-06-06T00:00:02Z"`);
    slot("status").insertAdjacentHTML("beforeend", ICON);
    const authored = slot("status").outerHTML;
    vi.advanceTimersByTime(2000);
    expect(root().getAttribute("data-state")).toBe("complete");
    // A slot holding an element is not empty, so the empty label claims nothing.
    expect(slot("status").outerHTML).toBe(authored);
    root().setAttribute(LABEL, "Finished");
    await vi.advanceTimersByTimeAsync(0);
    expect(slot("status").outerHTML).toBe(authored);
  });

  it("takes the status back once the element the consumer added is gone again", async () => {
    await start(`${DEADLINE}="2026-06-06T00:00:02Z" ${LABEL}="Time up"`);
    vi.advanceTimersByTime(2000);
    slot("status").insertAdjacentHTML("beforeend", ICON);
    root().setAttribute(LABEL, "Finished");
    await vi.advanceTimersByTimeAsync(0);
    expect(slot("status").textContent).toBe("Time up");
    // With the element gone the slot shows this controller's text alone again, so the
    // next label and reset reach it.
    slot("status").querySelector("svg")?.remove();
    root().setAttribute(LABEL, "Again");
    await vi.advanceTimersByTimeAsync(0);
    expect(slot("status").textContent).toBe("Again");
    expect(slot("status").getAttribute(OWNS_STATUS)).toBe("Again");
    instance().reset();
    expect(slot("status").textContent).toBe("");
    expect(slot("status").hasAttribute(OWNS_STATUS)).toBe(false);
  });

  // ---- A completion writes its label; a restored page carries the claim ----

  it("writes a non-empty label over whatever the status holds when it completes", async () => {
    await start(`${DEADLINE}="2026-06-06T00:00:02Z" ${LABEL}="Time up"`);
    slot("status").innerHTML = `Doors open at 7${ICON}`;
    vi.advanceTimersByTime(2000);
    expect(root().getAttribute("data-state")).toBe("complete");
    // Completion puts the label in force into the slot, text and element alike, and
    // claims it with the marker.
    expect(slot("status").innerHTML).toBe("Time up");
    expect(slot("status").getAttribute(OWNS_STATUS)).toBe("Time up");
  });

  /**
   * Connects a new instance to the markup a completed page leaves behind, as a Turbo
   * cache restore does: `data-state="complete"`, the label in force, and `status`
   * exactly as given, marker included.
   */
  const restore = async (deadline: string, status: string): Promise<void> => {
    document.body.innerHTML = `
      <div data-controller="stimeo--countdown" role="timer" aria-live="off"
           data-state="complete" ${DEADLINE}="${deadline}" ${LABEL}="Time up">
        <span data-stimeo--countdown-target="seconds">00</span>
        ${status}
      </div>`;
    application = Application.start();
    application.register("stimeo--countdown", CountdownController);
    await vi.advanceTimersByTimeAsync(0);
  };

  it("owns the status a restored page marks as its own, and follows the label into it", async () => {
    await restore(
      "2026-06-05T23:59:59Z",
      `<span data-stimeo--countdown-target="status" ${OWNS_STATUS}="Time up">Time up</span>`,
    );
    expect(root().getAttribute("data-state")).toBe("complete");
    // Ownership is read from the marker the page carries, not from what this instance
    // has written, so the label reaches the restored text.
    root().setAttribute(LABEL, "Finished");
    await vi.advanceTimersByTimeAsync(0);
    expect(slot("status").textContent).toBe("Finished");
    expect(slot("status").getAttribute(OWNS_STATUS)).toBe("Finished");
  });

  it("owns the empty status a restored page claims with an empty marker", async () => {
    await restore(
      "2026-06-05T23:59:59Z",
      `<span data-stimeo--countdown-target="status" ${OWNS_STATUS}=""></span>`,
    );
    root().setAttribute(LABEL, "Finished");
    await vi.advanceTimersByTimeAsync(0);
    expect(slot("status").textContent).toBe("Finished");
    expect(slot("status").getAttribute(OWNS_STATUS)).toBe("Finished");
  });

  it("leaves a restored status whose text differs from its marker alone", async () => {
    await restore(
      "2026-06-05T23:59:59Z",
      `<span data-stimeo--countdown-target="status" ${OWNS_STATUS}="Time up">Doors open at 7</span>`,
    );
    root().setAttribute(LABEL, "Finished");
    await vi.advanceTimersByTimeAsync(0);
    expect(slot("status").textContent).toBe("Doors open at 7");
    expect(slot("status").getAttribute(OWNS_STATUS)).toBe("Time up");
  });

  it("takes back the text a restored page marks as its own once the deadline moved forward", async () => {
    await restore(
      "2026-06-06T00:00:10Z",
      `<span data-stimeo--countdown-target="status" ${OWNS_STATUS}="Time up">Time up</span>`,
    );
    // The deadline is ahead of now, so the completion is handed back paused, and the
    // text the marker claims goes with it.
    expect(root().getAttribute("data-state")).toBe("paused");
    expect(slot("seconds").textContent).toBe("10");
    expect(slot("status").textContent).toBe("");
    expect(slot("status").hasAttribute(OWNS_STATUS)).toBe(false);
  });

  it("ignores pause once the countdown has completed", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:02Z"');
    vi.advanceTimersByTime(2000);
    expect(root().getAttribute("data-state")).toBe("complete");
    // Pausing a timer that is not running has nothing to stop: flipping the state
    // would hand a settled countdown back to resume() and let it cross zero again.
    instance().pause();
    expect(root().getAttribute("data-state")).toBe("complete");
  });

  it("steps by one unit on the first tick after a resume", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z"');
    vi.advanceTimersByTime(1000);
    expect(slot("seconds").textContent).toBe("09");
    // Pause between ticks: the display still reads 09 while the live amount is
    // already 8.5s. Storing the live amount would make the first tick after the
    // resume read 07 — a two-unit jump the user sees as a skipped second.
    vi.advanceTimersByTime(500);
    instance().pause();
    expect(slot("seconds").textContent).toBe("09");
    instance().resume();
    vi.advanceTimersByTime(1000);
    expect(slot("seconds").textContent).toBe("08");
  });

  it("keeps the user's pause across a reconnect even when autostart is on", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z"');
    vi.advanceTimersByTime(2000);
    instance().pause();
    expect(root().getAttribute("data-state")).toBe("paused");
    expect(slot("seconds").textContent).toBe("08");

    // The markup is the source of truth for the run state: `autostart` decides only
    // where a timer whose markup says nothing begins, so a snapshot cached mid-pause
    // must not resume itself behind the user's back.
    instance().disconnect();
    instance().connect();
    expect(root().getAttribute("data-state")).toBe("paused");
    vi.advanceTimersByTime(3000);
    expect(slot("seconds").textContent).toBe("08");
    instance().resume();
    vi.advanceTimersByTime(1000);
    expect(slot("seconds").textContent).toBe("07");
  });

  it("honors an authored paused state over autostart on the first render", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z" data-state="paused"');
    // Same rule seen from the other side: markup that states the run state wins, so
    // a server-rendered pause is not overridden by the declarative default.
    expect(root().getAttribute("data-state")).toBe("paused");
    vi.advanceTimersByTime(3000);
    expect(slot("seconds").textContent).toBe("10");
  });

  it("re-arms a restored running timer even when autostart is off", async () => {
    await start(
      'data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z" data-stimeo--countdown-autostart-value="false" data-state="running"',
    );
    // Nothing carries a live interval across the gap, so a restored "running" has to
    // be re-armed here — `autostart` has no say once the markup states a run state.
    expect(root().getAttribute("data-state")).toBe("running");
    vi.advanceTimersByTime(2000);
    expect(slot("seconds").textContent).toBe("08");
  });

  it("stays inert and renders zeros without a parseable deadline", async () => {
    await start("");
    expect(root().getAttribute("data-state")).toBe("paused");
    // Date.parse("") is NaN: every amount has to fall back to 0 rather than render NaN.
    expect(slot("days").textContent).toBe("0");
    expect(slot("hours").textContent).toBe("00");
    expect(slot("minutes").textContent).toBe("00");
    expect(slot("seconds").textContent).toBe("00");
    const events: string[] = [];
    root().addEventListener("stimeo--countdown:complete", () => events.push("complete"));
    root().addEventListener("stimeo--countdown:tick", () => events.push("tick"));
    // Neither entry point may arm a timer or declare completion off an unusable anchor.
    instance().start();
    instance().resume();
    vi.advanceTimersByTime(3000);
    expect(events).toEqual([]);
    expect(root().getAttribute("data-state")).toBe("paused");
    expect(slot("seconds").textContent).toBe("00");
  });

  it("clears the interval on disconnect", async () => {
    await start('data-stimeo--countdown-deadline-value="2026-06-06T00:01:00Z"');
    const secondsEl = slot("seconds");
    // Invoke disconnect() directly for a deterministic teardown, without relying
    // on the async MutationObserver flush.
    instance().disconnect();
    vi.advanceTimersByTime(5000);
    // No tick should mutate the slot past its initial value after teardown.
    expect(secondsEl.textContent).toBe("00");
  });

  it("announces the completion once the consumer supplies wording", async () => {
    // Only the transition is read out, never the ticking numbers.
    const spoken = await captureAnnouncements(async () => {
      await start(
        'data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z" ' +
          'data-stimeo--countdown-announce-text-value="Time is up"',
      );
      vi.advanceTimersByTime(11_000);
    });
    expect(spoken).toEqual(["Time is up"]);
  });

  it("stays silent about completion when no wording is set", async () => {
    const spoken = await captureAnnouncements(async () => {
      await start('data-stimeo--countdown-deadline-value="2026-06-06T00:00:10Z"');
      vi.advanceTimersByTime(11_000);
    });
    expect(spoken).toEqual([]);
  });
});

/**
 * The axe audit and the speech-order capture run under real timers so the
 * virtual screen reader's async work is not stalled by fake timers. A far-future
 * deadline keeps the (1s) interval from firing during the short test.
 */
describe("CountdownController accessibility", () => {
  let application: Application;

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
    disconnectAndStopApplication(application);
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
