import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkeletonController } from "../src/controllers/skeleton_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link SkeletonController}: the initial loading state,
 * the `ready` swap, `aria-busy` mirroring, the min-duration floor, the
 * announcement of the ready transition, survival across an in-page move, and
 * teardown on a real detach.
 */

describe("SkeletonController", () => {
  let application: Application;

  const start = async (attrs = "") => {
    document.body.innerHTML = `
      <div data-controller="stimeo--skeleton" aria-busy="true" ${attrs}
           data-action="content:ready->stimeo--skeleton#ready">
        <div aria-hidden="true" data-stimeo--skeleton-target="placeholder">…</div>
        <div hidden data-stimeo--skeleton-target="content">Loaded</div>
      </div>`;
    application = Application.start();
    application.register("stimeo--skeleton", SkeletonController);
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

  const root = () => query("[data-controller='stimeo--skeleton']");
  const placeholder = () => query("[data-stimeo--skeleton-target='placeholder']");
  const content = () => query("[data-stimeo--skeleton-target='content']");
  const instance = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--skeleton",
    ) as SkeletonController;

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

  it("starts in the loading state", async () => {
    await start();
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(root().getAttribute("aria-busy")).toBe("true");
    expect(placeholder().hidden).toBe(false);
    expect(content().hidden).toBe(true);
  });

  it("swaps to the content on ready", async () => {
    await start();
    instance().ready();
    expect(root().getAttribute("data-state")).toBe("ready");
    expect(root().getAttribute("aria-busy")).toBe("false");
    expect(placeholder().hidden).toBe(true);
    expect(content().hidden).toBe(false);
  });

  it("dispatches a ready event carrying an empty detail", async () => {
    await start();
    // Freeze the whole ordered array (not a name-only flag): the events table
    // declares an empty detail, so a leaked payload must fail here.
    const events: { type: string; detail: unknown }[] = [];
    root().addEventListener("stimeo--skeleton:ready", (event) => {
      events.push({ type: event.type, detail: (event as CustomEvent<unknown>).detail });
    });
    instance().ready();
    expect(events).toEqual([{ type: "stimeo--skeleton:ready", detail: {} }]);
  });

  it("ignores ready once the content is already shown", async () => {
    await start();
    instance().ready();
    const events: string[] = [];
    root().addEventListener("stimeo--skeleton:ready", (event) => events.push(event.type));
    instance().ready();
    // The swap already happened, so there is no second reveal to announce.
    expect(events).toEqual([]);
    expect(placeholder().hidden).toBe(true);
    expect(content().hidden).toBe(false);
  });

  it("keeps the placeholder up for at least minDuration", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    vi.advanceTimersByTime(100);
    instance().ready();
    // Too soon: still loading.
    expect(content().hidden).toBe(true);
    vi.advanceTimersByTime(200);
    expect(content().hidden).toBe(false);
    expect(root().getAttribute("data-state")).toBe("ready");
  });

  it("reveals immediately when minDuration has elapsed", async () => {
    await start('data-stimeo--skeleton-min-duration-value="100"');
    vi.advanceTimersByTime(200);
    instance().ready();
    expect(content().hidden).toBe(false);
  });

  it("queues a single reveal when ready repeats during the min-duration wait", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    const events: string[] = [];
    root().addEventListener("stimeo--skeleton:ready", (event) => events.push(event.type));
    instance().ready();
    vi.advanceTimersByTime(100);
    instance().ready();
    vi.advanceTimersByTime(200);
    expect(content().hidden).toBe(false);
    vi.advanceTimersByTime(200);
    // Both signals measure the floor from the same loading start, so a reveal
    // stacked behind the first lands in the same tick; the extra time only
    // widens the window. Either way it would swap — and announce — twice.
    expect(events).toEqual(["stimeo--skeleton:ready"]);
  });

  it("keeps the first queued reveal when a repeat would extend the wait", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    instance().ready();
    vi.advanceTimersByTime(100);
    // The first signal owns the reveal. Without that guard the repeat replaces
    // the held finish, and a floor raised in between pushes it out again — a
    // stream of ready events would postpone the swap indefinitely.
    instance().minDurationValue = 1000;
    instance().ready();
    vi.advanceTimersByTime(250);
    expect(root().getAttribute("data-state")).toBe("ready");
    expect(content().hidden).toBe(false);
  });

  it("cancels a pending reveal on reset", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    instance().ready();
    instance().reset();
    // An orphaned reveal timer would undo the reset once it fires.
    vi.advanceTimersByTime(400);
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(content().hidden).toBe(true);
  });

  it("returns to loading on reset", async () => {
    await start();
    instance().ready();
    instance().reset();
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(root().getAttribute("aria-busy")).toBe("true");
    expect(placeholder().hidden).toBe(false);
    expect(content().hidden).toBe(true);
  });

  it("keeps a restored ready state on connect", async () => {
    // A Turbo snapshot taken after the swap carries the ready state on the
    // element; re-entering loading would hide content the consumer already has.
    document.body.innerHTML = `
      <div data-controller="stimeo--skeleton" aria-busy="false" data-state="ready">
        <div hidden aria-hidden="true" data-stimeo--skeleton-target="placeholder">…</div>
        <div data-stimeo--skeleton-target="content">Loaded</div>
      </div>`;
    const events: string[] = [];
    root().addEventListener("stimeo--skeleton:ready", (event) => events.push(event.type));
    application = Application.start();
    application.register("stimeo--skeleton", SkeletonController);
    await vi.advanceTimersByTimeAsync(0);

    expect(root().getAttribute("data-state")).toBe("ready");
    expect(root().getAttribute("aria-busy")).toBe("false");
    expect(placeholder().hidden).toBe(true);
    expect(content().hidden).toBe(false);
    // Reconnecting is not a new reveal, so nothing is announced again.
    expect(events).toEqual([]);
  });

  it("announces the ready transition once when wording is supplied", async () => {
    const spoken = await captureAnnouncements(async () => {
      await start('data-stimeo--skeleton-announce-ready-text-value="Content loaded"');
      instance().ready();
      // The transition is the news. Re-asserting a state the region is already
      // in has nothing to report, so a repeat must stay silent.
      instance().ready();
    });
    expect(spoken).toEqual(["Content loaded"]);
  });

  it("announces again once a reset has put the region back into loading", async () => {
    const spoken = await captureAnnouncements(async () => {
      await start('data-stimeo--skeleton-announce-ready-text-value="Content loaded"');
      instance().ready();
      instance().reset();
      instance().ready();
    });
    expect(spoken).toEqual(["Content loaded", "Content loaded"]);
  });

  it("stays silent when no announcement wording is set", async () => {
    const spoken = await captureAnnouncements(async () => {
      await start();
      instance().ready();
    });
    expect(spoken).toEqual([]);
  });

  it("keeps a pending reveal alive across an in-page move", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    instance().ready();
    // A consumer re-inserting the element (a sortable, a teleport) disconnects
    // and reconnects the SAME instance, so the held reveal must survive: the
    // ready signal already arrived and nothing will send it again.
    instance().disconnect();
    instance().connect();
    // Let the microtask checkpoint drain: the reconnect has to disarm the probe
    // the disconnect queued, or the deferred teardown drops the reveal anyway.
    await vi.advanceTimersByTimeAsync(400);
    expect(root().getAttribute("data-state")).toBe("ready");
    expect(content().hidden).toBe(false);
  });

  it("keeps the min-duration floor measuring from the same moment across a move", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    vi.advanceTimersByTime(300);
    // The placeholder never left the screen, so the floor has already elapsed
    // and the reveal is due at once. Restarting it on reconnect would hold the
    // content back for a second full minDuration.
    instance().disconnect();
    instance().connect();
    instance().ready();
    expect(content().hidden).toBe(false);
  });

  it("re-arms after a real detach interrupted the min-duration wait", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    const controller = instance();
    const el = root();
    const parent = el.parentElement as HTMLElement;
    controller.ready();
    // Remove the element first, then invoke disconnect() directly: that is the
    // definite-detach path, so teardown runs synchronously and the test does not
    // wait on Stimulus' MutationObserver, whose flush timing varies by
    // environment (especially under coverage).
    el.remove();
    controller.disconnect();
    parent.appendChild(el);
    controller.connect();
    // A held reveal left behind by the teardown would make every later ready()
    // a no-op, stranding the skeleton for the rest of the session.
    controller.ready();
    vi.advanceTimersByTime(400);
    expect(content().hidden).toBe(false);
  });

  it("clears the pending reveal once the element really leaves", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    const controller = instance();
    const host = root();
    const el = content();
    const events: string[] = [];
    host.addEventListener("stimeo--skeleton:ready", (event) => events.push(event.type));
    controller.ready();
    host.remove();
    controller.disconnect();
    vi.advanceTimersByTime(400);
    // A node on its way out of the document keeps the markup it had, and the
    // dropped timer must not swap it in after the teardown.
    expect(el.hidden).toBe(true);
    expect(host.getAttribute("data-state")).toBe("loading");
    expect(events).toEqual([]);
  });
});

/** The axe audit runs under real timers, independent of the timing behavior. */
describe("SkeletonController accessibility", () => {
  let application: Application;

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("has no machine-detectable a11y violations in either state", async () => {
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--skeleton" aria-busy="true"
             data-action="content:ready->stimeo--skeleton#ready">
          <div aria-hidden="true" data-stimeo--skeleton-target="placeholder">…</div>
          <div hidden data-stimeo--skeleton-target="content"><p>Loaded</p></div>
        </div>
      </main>`;
    application = Application.start();
    application.register("stimeo--skeleton", SkeletonController);
    await tick();
    await expectNoA11yViolations(document.body);

    const root = query("[data-controller='stimeo--skeleton']");
    const controller = application.getControllerForElementAndIdentifier(
      root,
      "stimeo--skeleton",
    ) as SkeletonController;
    controller.ready();
    await expectNoA11yViolations(document.body);
  });

  // The decorative placeholder is aria-hidden, so the skeleton is never announced;
  // once ready, the real content is exposed to the reader.
  it("keeps the skeleton silent and announces the content once ready", async () => {
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--skeleton" aria-busy="true"
             data-action="content:ready->stimeo--skeleton#ready">
          <div aria-hidden="true" data-stimeo--skeleton-target="placeholder">
            <span>shimmer placeholder</span>
          </div>
          <div hidden data-stimeo--skeleton-target="content">
            <h3>Article title</h3>
          </div>
        </div>
      </main>`;
    application = Application.start();
    application.register("stimeo--skeleton", SkeletonController);
    await tick();

    const root = query("[data-controller='stimeo--skeleton']");
    // Freeze the whole ordered array (not a name-only `not.toContain`): while loading,
    // the aria-hidden placeholder text is silent and only the busy region announces.
    const loadingSpeech = await captureSpeech({ container: root, steps: 2 });
    expect(loadingSpeech).toEqual(["busy", "busy", "busy"]);

    const controller = application.getControllerForElementAndIdentifier(
      root,
      "stimeo--skeleton",
    ) as SkeletonController;
    controller.ready();

    // Freeze the whole ordered array (not a name-only `toContain`): once ready, the
    // busy state clears and the revealed content heading announces in order.
    const readySpeech = await captureSpeech({ container: root, steps: 2 });
    expect(readySpeech).toEqual(["not busy", "heading, Article title, level 3", "end, not busy"]);
  });
});
