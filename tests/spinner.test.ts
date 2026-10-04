import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpinnerController } from "../src/controllers/spinner_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link SpinnerController}: show-delay suppression, the
 * min-duration floor, `aria-busy` mirroring, the live-region announcement, timer
 * teardown on disconnect, and a load across Turbo's cache.
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

  it("keeps the region busy through the show delay and clears it when a stop cancels the delay", async () => {
    await start('data-stimeo--spinner-delay-value="150"');
    instance().start();
    expect(root().getAttribute("data-state")).toBe("pending");
    expect(region().getAttribute("aria-busy")).toBe("true");

    instance().stop();

    expect(root().getAttribute("data-state")).toBe("idle");
    expect(region().getAttribute("aria-busy")).toBe("false");
  });

  it("shows the spinner once the delay elapses", async () => {
    await start('data-stimeo--spinner-delay-value="150"');
    instance().start();
    vi.advanceTimersByTime(150);
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(indicator().hidden).toBe(false);
  });

  it("keeps the delay a start scheduled when delay changes, and reads it anew at the next start", async () => {
    await start('data-stimeo--spinner-delay-value="150"');
    instance().start();
    root().setAttribute("data-stimeo--spinner-delay-value", "500");
    await Promise.resolve();
    vi.advanceTimersByTime(150);
    expect(root().getAttribute("data-state")).toBe("loading");

    instance().stop();
    vi.advanceTimersByTime(0);
    instance().start();
    vi.advanceTimersByTime(150);
    expect(root().getAttribute("data-state")).toBe("pending");
    vi.advanceTimersByTime(350);
    expect(root().getAttribute("data-state")).toBe("loading");
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

  it("cancels a queued hide when the page returns the phase to idle before a restart", async () => {
    await start('data-stimeo--spinner-min-duration-value="500"');
    const hide = vi.fn();
    root().addEventListener("stimeo--spinner:hide", hide);
    instance().start();
    vi.advanceTimersByTime(100);
    instance().stop();
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(indicator().hidden).toBe(false);
    expect(region().getAttribute("aria-busy")).toBe("false");

    root().setAttribute("data-state", "idle");
    instance().start();
    vi.advanceTimersByTime(500);

    expect(root().getAttribute("data-state")).toBe("loading");
    expect(indicator().hidden).toBe(false);
    expect(region().getAttribute("aria-busy")).toBe("true");
    expect(hide).not.toHaveBeenCalled();
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
    await start('data-stimeo--spinner-delay-value="150"', 'data-state="pending"');
    expect(root().getAttribute("data-state")).toBe("idle");
    expect(region().getAttribute("aria-busy")).toBe("false");
    instance().start();
    vi.advanceTimersByTime(200);
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(indicator().hidden).toBe(false);
  });

  it("clears the busy flag a restored pending snapshot carries", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--spinner" data-state="pending">
        <div hidden data-stimeo--spinner-target="indicator"></div>
        <div aria-busy="true" data-stimeo--spinner-target="region"></div>
      </div>`;
    application = Application.start();
    application.register("stimeo--spinner", SpinnerController);
    await vi.advanceTimersByTimeAsync(0);

    expect(root().getAttribute("data-state")).toBe("idle");
    expect(region().getAttribute("aria-busy")).toBe("false");
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

  it("keeps a pending load alive once the detach probe of an in-page move has settled", async () => {
    await start('data-stimeo--spinner-delay-value="150"');
    instance().start();
    instance().disconnect();
    instance().connect();
    await flushMicrotasks();

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
    // left for the writes, and a copy that connects again returns to idle then.
    expect(el.hidden).toBe(false);
    expect(host.getAttribute("data-state")).toBe("loading");
    expect(events).toEqual([]);
  });

  /** Puts a restored copy of the page in place, as Turbo renders one from its cache. */
  const restore = async () => {
    application = await restoreFromCache(
      application,
      (restored) => restored.register("stimeo--spinner", SpinnerController),
      () => vi.advanceTimersByTimeAsync(0),
    );
  };

  /** Every `reconcile` that reaches the document, which outlives a restored body. */
  const reconcilesOnDocument = (): unknown[] => {
    const seen: unknown[] = [];
    document.addEventListener("stimeo--spinner:reconcile", (e) =>
      seen.push((e as CustomEvent).detail),
    );
    return seen;
  };

  it("keeps a running load through turbo:before-cache, and its stop still hides", async () => {
    await start('data-stimeo--spinner-announce-ready-text-value="Done"');
    const events: string[] = [];
    for (const name of ["hide", "reconcile"]) {
      root().addEventListener(`stimeo--spinner:${name}`, () => events.push(name));
    }
    instance().start();

    // Turbo dispatches it on pages that stay as well, where the load is still running.
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(indicator().hidden).toBe(false);
    expect(region().getAttribute("aria-busy")).toBe("true");

    const spoken = await captureAnnouncements(() => instance().stop());
    expect(events).toEqual(["hide"]);
    expect(spoken).toEqual(["Done"]);
    expect(root().getAttribute("data-state")).toBe("idle");
  });

  it("keeps a pending start and its safety net through turbo:before-cache", async () => {
    await start('data-stimeo--spinner-delay-value="150" data-stimeo--spinner-timeout-value="1000"');
    const events: string[] = [];
    root().addEventListener("stimeo--spinner:timeout", () => events.push("timeout"));
    instance().start();
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(root().getAttribute("data-state")).toBe("pending");
    expect(region().getAttribute("aria-busy")).toBe("true");

    vi.advanceTimersByTime(150);
    expect(root().getAttribute("data-state")).toBe("loading");
    vi.advanceTimersByTime(1000);
    expect(events).toEqual(["timeout"]);
  });

  it("returns a page restored in the middle of a load to idle", async () => {
    await start();
    instance().start();
    const reports = reconcilesOnDocument();

    await restore();

    // The load does not survive the copy: nothing on the restored page could end it.
    expect(root().getAttribute("data-state")).toBe("idle");
    expect(indicator().hidden).toBe(true);
    expect(region().getAttribute("aria-busy")).toBe("false");
    expect(reports).toEqual([{}]);
  });

  it("returns a page restored during the show delay to idle", async () => {
    await start('data-stimeo--spinner-delay-value="150"');
    instance().start();
    const reports = reconcilesOnDocument();

    await restore();

    expect(root().getAttribute("data-state")).toBe("idle");
    expect(region().getAttribute("aria-busy")).toBe("false");
    expect(reports).toEqual([{}]);
  });

  it("neither hides nor announces when a restored page discards a load", async () => {
    await start('data-stimeo--spinner-announce-ready-text-value="Done"');
    instance().start();
    const hides: string[] = [];
    document.addEventListener("stimeo--spinner:hide", () => hides.push("hide"));

    // The load never finished — its page was copied — so no lifecycle event is replayed.
    const spoken = await captureAnnouncements(() => restore());

    expect(hides).toEqual([]);
    expect(spoken).toEqual([]);
  });

  it("runs a new load on a restored page from start to hide", async () => {
    await start();
    instance().start();
    await restore();
    const events: string[] = [];
    root().addEventListener("stimeo--spinner:hide", () => events.push("hide"));

    instance().start();
    expect(indicator().hidden).toBe(false);
    instance().stop();

    expect(events).toEqual(["hide"]);
    expect(indicator().hidden).toBe(true);
  });

  it("stays silent when a restored page was idle", async () => {
    await start();
    instance().start();
    instance().stop();
    const reports = reconcilesOnDocument();

    await restore();

    expect(reports).toEqual([]);
  });

  it("keeps a running load across an in-page move", async () => {
    await start();
    instance().start();

    instance().disconnect();
    instance().connect();
    await flushMicrotasks();

    expect(root().getAttribute("data-state")).toBe("loading");
    expect(indicator().hidden).toBe(false);
  });

  it("returns a load to idle once its element comes back after a real detach", async () => {
    await start();
    const controller = instance();
    const host = root();
    const reports: unknown[] = [];
    host.addEventListener("stimeo--spinner:reconcile", (e) =>
      reports.push((e as CustomEvent).detail),
    );
    controller.start();
    host.remove();
    controller.disconnect();

    document.body.append(host);
    controller.connect();

    expect(host.getAttribute("data-state")).toBe("idle");
    expect(reports).toEqual([{}]);
  });

  it("returns a restored load to idle on a spinner with no targets", async () => {
    // Both targets are optional in the markup contract, so the reduced form has to
    // come back to idle as well as the full one.
    document.body.innerHTML = `<div data-controller="stimeo--spinner"></div>`;
    application = Application.start();
    application.register("stimeo--spinner", SpinnerController);
    await vi.advanceTimersByTimeAsync(0);
    instance().start();
    expect(root().getAttribute("data-state")).toBe("loading");

    await restore();

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

  it("measures the timeout from start, not from a delayed show", async () => {
    await start('data-stimeo--spinner-timeout-value="1000" data-stimeo--spinner-delay-value="300"');
    instance().start();
    vi.advanceTimersByTime(999);
    expect(root().getAttribute("data-state")).toBe("loading");
    vi.advanceTimersByTime(1);
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

  // --- `delay`, `minDuration` and `timeout` belong to one cycle ------------------------

  /**
   * Rewrites a timing Value and delivers its Value callback directly when the
   * controller defines one, since happy-dom does not reliably run it for an attribute
   * write.
   */
  const declareTiming = (name: "delay" | "min-duration" | "timeout", value: number) => {
    root().setAttribute(`data-stimeo--spinner-${name}-value`, String(value));
    const camel = name === "min-duration" ? "minDuration" : name;
    const callback: unknown = Reflect.get(instance(), `${camel}ValueChanged`);
    if (typeof callback === "function") callback.call(instance());
  };

  it.each([
    { direction: "shrinks", next: 50 },
    { direction: "grows", next: 5000 },
  ])(
    "keeps a pending start's show deadline when delay $direction, and delays the next start anew",
    async ({ next }) => {
      await start('data-stimeo--spinner-delay-value="300"');
      instance().start();
      vi.advanceTimersByTime(100);

      declareTiming("delay", next);
      vi.advanceTimersByTime(199);
      expect(root().getAttribute("data-state")).toBe("pending");
      vi.advanceTimersByTime(1);
      expect(root().getAttribute("data-state")).toBe("loading");

      instance().stop();
      instance().start();
      vi.advanceTimersByTime(next - 1);
      expect(root().getAttribute("data-state")).toBe("pending");
      vi.advanceTimersByTime(1);
      expect(root().getAttribute("data-state")).toBe("loading");
    },
  );

  it.each([
    { direction: "shrinks", next: 50 },
    { direction: "grows", next: 5000 },
  ])(
    "keeps a held hide's deadline when minDuration $direction, and floors the next load anew",
    async ({ next }) => {
      await start('data-stimeo--spinner-min-duration-value="500"');
      instance().start();
      vi.advanceTimersByTime(100);
      instance().stop(); // held back until t=500

      declareTiming("min-duration", next);
      vi.advanceTimersByTime(399);
      expect(indicator().hidden).toBe(false);
      vi.advanceTimersByTime(1);
      expect(indicator().hidden).toBe(true);

      instance().start();
      instance().stop();
      vi.advanceTimersByTime(next - 1);
      expect(indicator().hidden).toBe(false);
      vi.advanceTimersByTime(1);
      expect(indicator().hidden).toBe(true);
    },
  );

  it.each([
    { direction: "shrinks", next: 50 },
    { direction: "grows", next: 5000 },
  ])(
    "keeps a running load's safety net when timeout $direction, and arms the next start anew",
    async ({ next }) => {
      await start('data-stimeo--spinner-timeout-value="1000"');
      const timeouts: number[] = [];
      root().addEventListener("stimeo--spinner:timeout", () => timeouts.push(Date.now()));
      instance().start();
      vi.advanceTimersByTime(100);

      declareTiming("timeout", next);
      vi.advanceTimersByTime(899);
      expect(root().getAttribute("data-state")).toBe("loading");
      vi.advanceTimersByTime(1);
      expect(root().getAttribute("data-state")).toBe("idle");
      expect(timeouts).toHaveLength(1);

      instance().start();
      vi.advanceTimersByTime(next - 1);
      expect(root().getAttribute("data-state")).toBe("loading");
      vi.advanceTimersByTime(1);
      expect(root().getAttribute("data-state")).toBe("idle");
      expect(timeouts).toHaveLength(2);
    },
  );

  it("starts, ends and reports nothing from a timing change alone", async () => {
    await start();
    const events: string[] = [];
    for (const type of ["show", "hide", "timeout", "reconcile"]) {
      root().addEventListener(`stimeo--spinner:${type}`, () => events.push(type));
    }
    declareTiming("delay", 20);
    declareTiming("min-duration", 20);
    declareTiming("timeout", 20);
    await vi.advanceTimersByTimeAsync(1000);
    expect(root().getAttribute("data-state")).toBe("idle");
    expect(region().getAttribute("aria-busy")).toBe("false");
    expect(events).toEqual([]);

    // A load started with no ceiling is not given one by a later declaration.
    declareTiming("timeout", 0);
    declareTiming("delay", 0);
    instance().start();
    declareTiming("timeout", 20);
    await vi.advanceTimersByTimeAsync(1000);
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(events).toEqual(["show"]);
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

  /** Inserts a copy of the indicator after the current one and lets Stimulus connect it. */
  const addSuccessor = async (): Promise<{ original: HTMLElement; successor: HTMLElement }> => {
    const original = indicator();
    const successor = original.cloneNode(true) as HTMLElement;
    original.after(successor);
    await vi.advanceTimersByTimeAsync(0);
    return { original, successor };
  };

  it("shows an indicator that stays after an earlier one leaves once a load starts", async () => {
    await start();
    const { original, successor } = await addSuccessor();
    instance().start();
    original.remove();
    await vi.advanceTimersByTimeAsync(0);

    expect(indicator()).toBe(successor);
    expect(successor.hidden).toBe(false);
  });

  it("hides an indicator that stays after an earlier one leaves once a load ends", async () => {
    await start();
    instance().start();
    const { original, successor } = await addSuccessor();
    expect(successor.hidden).toBe(false);
    instance().stop();
    await vi.advanceTimersByTimeAsync(0);
    original.remove();
    await vi.advanceTimersByTimeAsync(0);

    expect(indicator()).toBe(successor);
    expect(successor.hidden).toBe(true);
    expect(root().getAttribute("data-state")).toBe("idle");
  });

  it("brings the staying indicator up to date without an event or an announcement", async () => {
    await start('data-stimeo--spinner-announce-text-value="Loading…"');
    const { original } = await addSuccessor();
    instance().start();
    const events: string[] = [];
    for (const type of ["show", "hide", "timeout", "reconcile"]) {
      root().addEventListener(`stimeo--spinner:${type}`, () => events.push(type));
    }
    root().addEventListener("change", () => events.push("native change"));

    const spoken = await captureAnnouncements(async () => {
      original.remove();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(events).toEqual([]);
    expect(spoken).toEqual([]);
  });

  it("keeps working when its only indicator leaves", async () => {
    await start();
    const errors: unknown[] = [];
    application.handleError = (error) => {
      errors.push(error);
    };
    indicator().remove();
    await vi.advanceTimersByTimeAsync(0);
    instance().start();

    expect(errors).toEqual([]);
    expect(root().getAttribute("data-state")).toBe("loading");
  });

  describe("indicator that stops resolving", () => {
    /** Drops only the indicator token from `element`, which stays where it is. */
    const dropIndicatorToken = async (element: HTMLElement) => {
      element.removeAttribute("data-stimeo--spinner-target");
      await vi.advanceTimersByTimeAsync(0);
    };

    it("gives an indicator that stops being one back the hidden it was authored with", async () => {
      await start('data-stimeo--spinner-announce-text-value="Loading…"');
      instance().start();
      const departed = indicator();
      expect(departed.hidden).toBe(false);
      const events: string[] = [];
      for (const type of ["show", "hide", "timeout", "reconcile"]) {
        root().addEventListener(`stimeo--spinner:${type}`, () => events.push(type));
      }

      const spoken = await captureAnnouncements(() => dropIndicatorToken(departed));

      expect(departed.hidden).toBe(true);
      expect(root().getAttribute("data-state")).toBe("loading");
      expect(events).toEqual([]);
      expect(spoken).toEqual([]);
    });

    it("gives the departed indicator its own hidden back while the indicator that stays shows the load", async () => {
      await start();
      const { original, successor } = await addSuccessor();
      instance().start();
      expect([original.hidden, successor.hidden]).toEqual([false, true]);

      await dropIndicatorToken(original);

      expect(indicator()).toBe(successor);
      expect(original.hidden).toBe(true);
      expect(successor.hidden).toBe(false);
    });

    it("removes the hidden it wrote on a departed indicator that was authored without one", async () => {
      document.body.innerHTML = `
        <div data-controller="stimeo--spinner">
          <div data-stimeo--spinner-target="indicator">Loading…</div>
        </div>`;
      application = Application.start();
      application.register("stimeo--spinner", SpinnerController);
      await vi.advanceTimersByTimeAsync(0);
      const departed = indicator();
      expect(departed.hidden).toBe(true);

      await dropIndicatorToken(departed);

      expect(departed.hasAttribute("hidden")).toBe(false);
    });

    it("keeps a hidden the page wrote on an indicator after the last write", async () => {
      await start();
      const departed = indicator();
      expect(departed.hidden).toBe(true);
      departed.hidden = false;

      await dropIndicatorToken(departed);

      expect(departed.hidden).toBe(false);
    });

    it("keeps an indicator that moves within the spinner shown", async () => {
      await start();
      instance().start();
      const moving = indicator();

      root().append(moving);
      await vi.advanceTimersByTimeAsync(0);

      expect(indicator()).toBe(moving);
      expect(moving.hidden).toBe(false);
    });

    it("gives the indicator back its own hidden when the spinner loses its controller", async () => {
      await start();
      instance().start();
      const departed = indicator();

      root().removeAttribute("data-controller");
      await vi.advanceTimersByTimeAsync(0);

      expect(departed.hidden).toBe(true);
    });

    it("keeps what it wrote on the indicator when the whole spinner leaves the page", async () => {
      await start();
      instance().start();
      const kept = indicator();

      root().remove();
      await vi.advanceTimersByTimeAsync(0);

      expect(kept.hidden).toBe(false);
    });

    it("writes nothing onto the indicator while Stimulus tears the controller down", async () => {
      await start();
      expect(indicator().hidden).toBe(true);
      // A value the page wrote after the last write stays where it was left.
      indicator().hidden = false;

      application.unload("stimeo--spinner");

      expect(indicator().hidden).toBe(false);
    });
  });

  describe("region target", () => {
    /** A region like the current one, reading not busy. */
    const freshRegion = () => {
      const fresh = region().cloneNode(true) as HTMLElement;
      fresh.setAttribute("aria-busy", "false");
      return fresh;
    };
    const settle = () => vi.advanceTimersByTimeAsync(0);

    it("marks a region that replaces the current one mid-load as busy", async () => {
      await start();
      instance().start();
      const successor = freshRegion();

      region().replaceWith(successor);
      await settle();

      expect(region()).toBe(successor);
      expect(successor.getAttribute("aria-busy")).toBe("true");
    });

    it("marks a region that stays after an earlier one leaves as busy once a load starts", async () => {
      await start();
      const original = region();
      const successor = freshRegion();
      original.after(successor);
      await settle();
      instance().start();
      original.remove();
      await settle();

      expect(region()).toBe(successor);
      expect(successor.getAttribute("aria-busy")).toBe("true");
    });

    it("clears a region that stays after an earlier one leaves once a load ends", async () => {
      await start();
      instance().start();
      const original = region();
      const successor = original.cloneNode(true) as HTMLElement;
      original.after(successor);
      await settle();
      instance().stop();
      await settle();
      original.remove();
      await settle();

      expect(region()).toBe(successor);
      expect(successor.getAttribute("aria-busy")).toBe("false");
    });

    it("marks a region that arrives while the show delay runs as busy", async () => {
      await start('data-stimeo--spinner-delay-value="150"');
      instance().start();
      const incoming = freshRegion();

      region().before(incoming);
      await settle();

      expect(root().getAttribute("data-state")).toBe("pending");
      expect(incoming.getAttribute("aria-busy")).toBe("true");
    });

    it("leaves a region that arrives while a stopped load waits out minDuration not busy", async () => {
      await start('data-stimeo--spinner-min-duration-value="500"');
      instance().start();
      instance().stop();
      const incoming = region().cloneNode(true) as HTMLElement;
      expect(incoming.getAttribute("aria-busy")).toBe("false");
      incoming.setAttribute("aria-busy", "true");

      region().before(incoming);
      await settle();

      expect(root().getAttribute("data-state")).toBe("loading");
      expect(incoming.getAttribute("aria-busy")).toBe("false");
    });

    it("brings a region up to date without an event or an announcement", async () => {
      await start('data-stimeo--spinner-announce-text-value="Loading…"');
      instance().start();
      const events: string[] = [];
      for (const type of ["show", "hide", "timeout", "reconcile"]) {
        root().addEventListener(`stimeo--spinner:${type}`, () => events.push(type));
      }
      root().addEventListener("change", () => events.push("native change"));
      const successor = freshRegion();

      const spoken = await captureAnnouncements(async () => {
        region().replaceWith(successor);
        await settle();
      });

      expect(successor.getAttribute("aria-busy")).toBe("true");
      expect(events).toEqual([]);
      expect(spoken).toEqual([]);
    });

    it("keeps working when its only region leaves", async () => {
      await start();
      const errors: unknown[] = [];
      application.handleError = (error) => {
        errors.push(error);
      };
      instance().start();
      region().remove();
      await settle();
      instance().stop();

      expect(errors).toEqual([]);
      expect(root().getAttribute("data-state")).toBe("idle");
    });

    it("gives a region that stops being one back the aria-busy it was authored with", async () => {
      await start();
      instance().start();
      const departed = region();

      departed.removeAttribute("data-stimeo--spinner-target");
      await settle();

      expect(departed.getAttribute("aria-busy")).toBe("false");
    });

    it("removes the aria-busy it wrote on a departed region that was authored without one", async () => {
      await start();
      region().removeAttribute("aria-busy");
      instance().start();
      const departed = region();
      expect(departed.getAttribute("aria-busy")).toBe("true");

      departed.removeAttribute("data-stimeo--spinner-target");
      await settle();

      expect(departed.hasAttribute("aria-busy")).toBe(false);
    });

    it("keeps an aria-busy the page wrote on a region after the last write", async () => {
      await start();
      instance().start();
      const departed = region();
      departed.setAttribute("aria-busy", "maybe");

      departed.removeAttribute("data-stimeo--spinner-target");
      await settle();

      expect(departed.getAttribute("aria-busy")).toBe("maybe");
    });

    it("keeps a region that moves within the spinner busy without touching it", async () => {
      await start();
      instance().start();
      const moving = region();
      const writes: string[] = [];
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.attributeName === "aria-busy") writes.push(String(record.oldValue));
        }
      }).observe(moving, { attributes: true, attributeOldValue: true });

      root().prepend(moving);
      await settle();

      expect(region()).toBe(moving);
      expect(moving.getAttribute("aria-busy")).toBe("true");
      expect(writes).toEqual([]);
    });

    it("leaves a region's authored aria-busy alone while it connects", async () => {
      document.body.innerHTML = `
        <div data-controller="stimeo--spinner">
          <div hidden data-stimeo--spinner-target="indicator">Loading…</div>
          <div data-stimeo--spinner-target="region"></div>
        </div>`;
      application = Application.start();
      application.register("stimeo--spinner", SpinnerController);
      await settle();

      expect(region().hasAttribute("aria-busy")).toBe(false);
    });

    it("writes nothing onto the region while Stimulus tears the controller down", async () => {
      await start();
      instance().start();
      // A value the page wrote after the last write stays where it was left.
      region().setAttribute("aria-busy", "false");

      application.unload("stimeo--spinner");

      expect(region().getAttribute("aria-busy")).toBe("false");
    });

    it("gives the region back its own aria-busy when the spinner loses its controller", async () => {
      await start();
      instance().start();
      const departed = region();

      root().removeAttribute("data-controller");
      await settle();

      expect(departed.getAttribute("aria-busy")).toBe("false");
    });

    it("keeps what it wrote on the region when the whole spinner leaves the page", async () => {
      await start();
      instance().start();
      const kept = region();

      root().remove();
      await settle();

      expect(kept.getAttribute("aria-busy")).toBe("true");
    });
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
