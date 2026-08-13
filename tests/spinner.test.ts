import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpinnerController } from "../src/controllers/spinner_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link SpinnerController}: show-delay suppression, the
 * min-duration floor, `aria-busy` mirroring, the live-region announcement, and
 * timer teardown on disconnect.
 */

describe("SpinnerController", () => {
  let application: Application;

  const start = async (attrs = "", markupState = "") => {
    document.body.innerHTML = `
      <div data-controller="stimeo--spinner" ${attrs} ${markupState}>
        <div hidden
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
    disconnectAndStopApplication(application);
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

  it("keeps a single queued hide when stop repeats during the min-duration wait", async () => {
    await start('data-stimeo--spinner-min-duration-value="500"');
    instance().start();
    vi.advanceTimersByTime(100);
    instance().stop();
    vi.advanceTimersByTime(50);
    // A repeated stop must replace the queued hide, not add a second one: only the
    // most recently queued id is cancellable, so an extra timer outlives the restart
    // below and hides the spinner in the middle of the new load.
    instance().stop();
    const events: string[] = [];
    root().addEventListener("stimeo--spinner:hide", () => events.push("hide"));
    instance().start();
    vi.advanceTimersByTime(600);
    expect(indicator().hidden).toBe(false);
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(events).toEqual([]);
  });

  it("hides immediately when minDuration has already elapsed", async () => {
    await start('data-stimeo--spinner-min-duration-value="100"');
    instance().start();
    vi.advanceTimersByTime(200);
    instance().stop();
    expect(indicator().hidden).toBe(true);
  });

  it("dispatches show and hide events carrying an empty detail", async () => {
    await start();
    const events: { type: string; detail: unknown }[] = [];
    for (const type of ["stimeo--spinner:show", "stimeo--spinner:hide"]) {
      root().addEventListener(type, (event) =>
        events.push({ type, detail: (event as CustomEvent).detail }),
      );
    }
    instance().start();
    instance().stop();
    // Freeze the detail too, not just the order: the markup contract advertises an
    // empty payload, so a consumer reading `event.detail.x` must never start working
    // by accident.
    expect(events).toEqual([
      { type: "stimeo--spinner:show", detail: {} },
      { type: "stimeo--spinner:hide", detail: {} },
    ]);
  });

  it("ignores start while already loading and stop while idle", async () => {
    await start();
    const events: string[] = [];
    root().addEventListener("stimeo--spinner:show", () => events.push("show"));
    root().addEventListener("stimeo--spinner:hide", () => events.push("hide"));
    // A stop with nothing loading is a no-op: it must not announce a hide for a
    // spinner that was never shown.
    instance().stop();
    expect(root().getAttribute("data-state")).toBe("idle");
    expect(indicator().hidden).toBe(true);
    expect(region().getAttribute("aria-busy")).toBe("false");
    instance().start();
    instance().start();
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(events).toEqual(["show"]);
  });

  it("ignores a second start while the show delay is still pending", async () => {
    await start('data-stimeo--spinner-delay-value="150"');
    const events: string[] = [];
    root().addEventListener("stimeo--spinner:show", () => events.push("show"));
    instance().start();
    // A second start must not arm a second show timer, or the single stop below can
    // only cancel the last one and the leftover timer reveals the spinner after the
    // load already finished.
    instance().start();
    instance().stop();
    vi.advanceTimersByTime(300);
    expect(events).toEqual([]);
    expect(indicator().hidden).toBe(true);
    expect(root().getAttribute("data-state")).toBe("idle");
  });

  it("re-arms on a restored snapshot that still says pending", async () => {
    // A snapshot cached before the rewind could run brings the markup back with
    // `pending` written on it, and the show-delay timer that would advance it belongs
    // to a controller that no longer exists. Without the fallback, `start()` refuses
    // every later load because the state is neither `idle` nor `loading`.
    await start('data-stimeo--spinner-delay-value="150"', 'data-state="pending"');
    expect(root().getAttribute("data-state")).toBe("idle");
    expect(region().getAttribute("aria-busy")).toBe("false");
    instance().start();
    vi.advanceTimersByTime(200);
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(indicator().hidden).toBe(false);
  });

  it("keeps a pending load alive across an in-page move", async () => {
    await start('data-stimeo--spinner-delay-value="150"');
    instance().start();
    // A consumer re-inserting the element (a sortable, a teleport) disconnects and
    // reconnects the SAME instance, so the show-delay timer must survive: the load it
    // belongs to is still running, and nothing else will ever reveal the spinner.
    instance().disconnect();
    instance().connect();
    expect(root().getAttribute("data-state")).toBe("pending");
    vi.advanceTimersByTime(200);
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(indicator().hidden).toBe(false);
  });

  it("keeps the queued hide alive across an in-page move", async () => {
    await start('data-stimeo--spinner-min-duration-value="500"');
    instance().start();
    vi.advanceTimersByTime(100);
    instance().stop(); // queues the hide for the remaining 400ms
    instance().disconnect();
    instance().connect();
    vi.advanceTimersByTime(600);
    // Losing this timer strands the spinner on screen for the rest of the session:
    // `data-state` stays `loading`, so no later `stop()` reaches `#hide()` either.
    expect(root().getAttribute("data-state")).toBe("idle");
    expect(indicator().hidden).toBe(true);
  });

  it("clears pending timers once the element really leaves (no show after teardown)", async () => {
    await start('data-stimeo--spinner-delay-value="150"');
    const controller = instance();
    const el = indicator();
    controller.start();
    // Remove the element first, then invoke disconnect() directly: that is the
    // definite-detach path, so teardown runs synchronously and the test does not wait
    // on Stimulus' MutationObserver, whose flush timing varies by environment
    // (especially under coverage).
    root().remove();
    controller.disconnect();
    vi.advanceTimersByTime(300);
    // The pending show timer was cleared; nothing flips the indicator to loading.
    expect(el.hidden).toBe(true);
  });

  it("clears the pending min-duration hide once the element really leaves", async () => {
    await start('data-stimeo--spinner-min-duration-value="500"');
    const controller = instance();
    const el = indicator();
    const host = root();
    const events: string[] = [];
    host.addEventListener("stimeo--spinner:hide", () => events.push("hide"));
    controller.start();
    vi.advanceTimersByTime(100);
    controller.stop(); // queues the hide for the remaining 400ms
    host.remove();
    controller.disconnect();
    vi.advanceTimersByTime(600);
    // A node on its way out of the document keeps the markup it had: no reader is
    // left for the writes, and the snapshot is rewound on `turbo:before-cache`.
    expect(el.hidden).toBe(false);
    expect(host.getAttribute("data-state")).toBe("loading");
    expect(events).toEqual([]);
  });

  it("returns the loading state to idle for the Turbo snapshot", async () => {
    await start();
    instance().start();
    // Turbo takes the snapshot from this event, so this is the last moment a write
    // reaches the DOM the Back button restores. Without it the restored page keeps a
    // spinner nothing on it can stop.
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(root().getAttribute("data-state")).toBe("idle");
    expect(indicator().hidden).toBe(true);
    expect(region().getAttribute("aria-busy")).toBe("false");
  });

  it("rewinds a pending start for the Turbo snapshot too", async () => {
    await start('data-stimeo--spinner-delay-value="150"');
    instance().start();
    expect(root().getAttribute("data-state")).toBe("pending");
    document.dispatchEvent(new Event("turbo:before-cache"));
    // `pending` is as unrecoverable as `loading` in a snapshot: the show-delay
    // timer that would advance it does not survive the navigation.
    expect(root().getAttribute("data-state")).toBe("idle");
    expect(region().getAttribute("aria-busy")).toBe("false");
  });

  it("announces nothing while rewinding for the snapshot", async () => {
    await start();
    const events: string[] = [];
    root().addEventListener("stimeo--spinner:hide", () => events.push("hide"));
    instance().start();
    document.dispatchEvent(new Event("turbo:before-cache"));
    // The load never finished — the page is merely being frozen — so the rewind
    // writes state and stays silent rather than replaying a lifecycle event.
    expect(events).toEqual([]);
  });

  it("leaves the live page's timers running after the snapshot rewind", async () => {
    await start('data-stimeo--spinner-delay-value="150"');
    instance().start();
    document.dispatchEvent(new Event("turbo:before-cache"));
    vi.advanceTimersByTime(200);
    // A cached page is not a torn-down one: a navigation that never completes
    // must find the in-flight cycle intact.
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(indicator().hidden).toBe(false);
  });

  it("keeps the region busy when a spared timer reveals the spinner", async () => {
    await start('data-stimeo--spinner-delay-value="150"');
    instance().start();
    document.dispatchEvent(new Event("turbo:before-cache"));
    vi.advanceTimersByTime(200);
    // The rewind clears `aria-busy` but deliberately spares the timer, so the reveal
    // it later runs has to put the flag back: a visible spinner over a region that
    // claims not to be busy is the contradiction assistive tech would read out.
    expect(indicator().hidden).toBe(false);
    expect(region().getAttribute("aria-busy")).toBe("true");
  });

  it("stops rewinding once disconnected", async () => {
    await start();
    instance().start();
    instance().disconnect();
    document.dispatchEvent(new Event("turbo:before-cache"));
    // The subscription is symmetric with `connect()`, so a torn-down controller
    // no longer writes into a tree it does not own.
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(indicator().hidden).toBe(false);
  });

  it("rewinds a spinner that has no indicator target", async () => {
    // Both targets are optional in the markup contract, so the rewind has to hold
    // for the reduced form as well as the full one.
    document.body.innerHTML = `<div data-controller="stimeo--spinner"></div>`;
    application = Application.start();
    application.register("stimeo--spinner", SpinnerController);
    await vi.advanceTimersByTimeAsync(0);
    instance().start();
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(() => document.dispatchEvent(new Event("turbo:before-cache"))).not.toThrow();
    expect(root().getAttribute("data-state")).toBe("idle");
  });

  it("ends a load whose stop never arrives once timeout elapses", async () => {
    await start('data-stimeo--spinner-timeout-value="3000"');
    const events: string[] = [];
    for (const type of ["stimeo--spinner:timeout", "stimeo--spinner:hide"]) {
      root().addEventListener(type, () => events.push(type));
    }
    instance().start();
    vi.advanceTimersByTime(2999);
    expect(root().getAttribute("data-state")).toBe("loading");
    vi.advanceTimersByTime(1);
    // The consumer owns the async work, so a `stop` that never arrives would strand
    // the spinner and `aria-busy="true"` for the rest of the session.
    expect(events).toEqual(["stimeo--spinner:timeout", "stimeo--spinner:hide"]);
    expect(root().getAttribute("data-state")).toBe("idle");
    expect(indicator().hidden).toBe(true);
    expect(region().getAttribute("aria-busy")).toBe("false");
  });

  it("holds the timeout spinner for minDuration like any other end", async () => {
    await start(
      'data-stimeo--spinner-timeout-value="200" data-stimeo--spinner-min-duration-value="500"',
    );
    instance().start();
    vi.advanceTimersByTime(200);
    // The safety net ends the load the same way `stop` does, floor included, so it
    // cannot flicker the spinner away the moment it appeared.
    expect(indicator().hidden).toBe(false);
    vi.advanceTimersByTime(300);
    expect(indicator().hidden).toBe(true);
  });

  it("re-measures the timeout from the newest start", async () => {
    await start('data-stimeo--spinner-timeout-value="1000"');
    instance().start();
    vi.advanceTimersByTime(900);
    instance().start(); // a restart while loading
    vi.advanceTimersByTime(900);
    expect(root().getAttribute("data-state")).toBe("loading");
    vi.advanceTimersByTime(100);
    expect(root().getAttribute("data-state")).toBe("idle");
  });

  it("drops the safety net when the load ends on its own", async () => {
    await start('data-stimeo--spinner-timeout-value="1000"');
    const events: string[] = [];
    root().addEventListener("stimeo--spinner:timeout", () => events.push("timeout"));
    instance().start();
    instance().stop();
    vi.advanceTimersByTime(2000);
    // A leftover net would announce a timeout for a load that already finished.
    expect(events).toEqual([]);
  });

  it("leaves the load running when timeout is off", async () => {
    await start();
    instance().start();
    vi.advanceTimersByTime(60_000);
    // `0` is the default: no ceiling unless the consumer asks for one.
    expect(root().getAttribute("data-state")).toBe("loading");
  });

  it("re-applies the current phase to an indicator swapped in mid-load", async () => {
    await start();
    instance().start();
    expect(indicator().hidden).toBe(false);
    // A Turbo Stream renders a fresh indicator carrying the contract's `hidden`;
    // without re-applying, the spinner disappears while `data-state` says loading.
    indicator().replaceWith(
      Object.assign(document.createElement("div"), {
        hidden: true,
        innerHTML: '<span data-stimeo--spinner-target="message">Loading…</span>',
      }),
    );
    query("[data-controller='stimeo--spinner'] div").setAttribute(
      "data-stimeo--spinner-target",
      "indicator",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(indicator().hidden).toBe(false);
    expect(root().getAttribute("data-state")).toBe("loading");
  });

  it("still rewinds after connecting on a stale pending snapshot", async () => {
    // The stale-pending branch leaves `connect()` early, so the subscription has to be
    // taken before it: a page restored mid-load would otherwise stop rewinding from
    // the second navigation on.
    await start("", 'data-state="pending"');
    instance().start();
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(root().getAttribute("data-state")).toBe("idle");
    expect(indicator().hidden).toBe(true);
  });

  it("still rewinds after an in-page move", async () => {
    await start();
    instance().start();
    instance().disconnect();
    instance().connect();
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(root().getAttribute("data-state")).toBe("idle");
    expect(indicator().hidden).toBe(true);
  });

  it("announces the loading and ready transitions when wording is supplied", async () => {
    // The two transitions are the news; the spinner itself carries no words.
    const spoken = await captureAnnouncements(async () => {
      await start(
        'data-stimeo--spinner-announce-text-value="Loading" ' +
          'data-stimeo--spinner-announce-ready-text-value="Loaded"',
      );
      instance().start();
      await vi.advanceTimersByTimeAsync(500);
      instance().stop();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(spoken).toEqual(["Loading", "Loaded"]);
  });

  it("stays silent when no announcement wording is set", async () => {
    const spoken = await captureAnnouncements(async () => {
      await start();
      instance().start();
      await vi.advanceTimersByTimeAsync(500);
      instance().stop();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(spoken).toEqual([]);
  });
});

/**
 * The axe audit and the speech-order checks run under real timers so the virtual
 * screen reader's own async work is not stalled by fake timers.
 */
describe("SpinnerController accessibility", () => {
  let application: Application;

  const start = async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--spinner">
        <div hidden
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
    disconnectAndStopApplication(application);
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

  it("reads the shown indicator as plain text, not a live region", async () => {
    await start();
    instance().start();
    const spoken = await captureSpeech({ container: indicator(), steps: 1 });
    // Freeze the whole ordered array (not a name-only `toContain`): the transition is
    // read out by the shared announcer, so an indicator that also carried `status`
    // would say it twice. A generic container yields its own text and then the
    // message span's; what matters is that no live-region role is spoken.
    expect(spoken).toEqual(["Loading…", "Loading…"]);
  });
});
