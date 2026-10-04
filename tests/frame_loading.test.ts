import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrameLoadingController } from "../src/controllers/frame_loading_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link FrameLoadingController}, driven by simulated Turbo
 * fetch events and a mocked clock: the aria-busy / data hook + skeleton toggle, the
 * inert content guard, focus retreat and restore, the min-duration floor, the
 * error safety net, idempotent start, teardown, and a load across Turbo's cache.
 */

describe("FrameLoadingController", () => {
  let application: Application;

  const mount = async (
    attrs = "",
    inner = '<div data-stimeo--frame-loading-target="skeleton" hidden></div><div data-stimeo--frame-loading-target="content"><button id="inside">x</button></div>',
  ) => {
    document.body.innerHTML = `<div data-controller="stimeo--frame-loading" ${attrs}>${inner}</div>`;
    application = Application.start();
    application.register("stimeo--frame-loading", FrameLoadingController);
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

  const frame = () => query("[data-controller='stimeo--frame-loading']");
  const skeleton = () => query("[data-stimeo--frame-loading-target='skeleton']");
  const content = () => query("[data-stimeo--frame-loading-target='content']");
  const fire = (type: string, on: Element = frame()) =>
    on.dispatchEvent(new Event(type, { bubbles: true }));
  /**
   * Turbo dispatches it on the document, not at the frame, and also on pages that stay.
   */
  const cacheSnapshot = () => document.dispatchEvent(new Event("turbo:before-cache"));
  /**
   * What Turbo's frame renderer does: empty the frame, then insert the response's
   * children. The frame element itself survives, so the controller is not
   * reconnected — only the targets are new.
   */
  const renderFrame = async (html: string) => {
    const range = document.createRange();
    range.selectNodeContents(frame());
    range.deleteContents();
    frame().insertAdjacentHTML("beforeend", html);
    await vi.advanceTimersByTimeAsync(0);
  };
  /** Messages handed to the shared announcer, in order. */
  const captureAnnouncements = () => {
    const messages: string[] = [];
    window.addEventListener("stimeo--announcer:announce", (event) => {
      messages.push((event as CustomEvent<{ message: string }>).detail.message);
    });
    return messages;
  };

  it("enters the loading state on a frame fetch", async () => {
    await mount();
    const events: string[] = [];
    frame().addEventListener("stimeo--frame-loading:start", () => events.push("start"));

    fire("turbo:before-fetch-request");
    expect(frame().getAttribute("aria-busy")).toBe("true");
    expect(frame().getAttribute("data-frame-loading")).toBe("true");
    expect(skeleton().hidden).toBe(false);
    expect(content().hasAttribute("inert")).toBe(true);
    expect(events).toEqual(["start"]);
  });

  it("leaves the loading state on frame-load", async () => {
    await mount();
    const events: string[] = [];
    frame().addEventListener("stimeo--frame-loading:end", () => events.push("end"));

    fire("turbo:before-fetch-request");
    fire("turbo:frame-load");
    expect(frame().hasAttribute("aria-busy")).toBe(false);
    expect(frame().hasAttribute("data-frame-loading")).toBe(false);
    expect(skeleton().hidden).toBe(true);
    expect(content().hasAttribute("inert")).toBe(false);
    expect(events).toEqual(["end"]);
  });

  it("toggles an optional overlay target while loading", async () => {
    await mount(
      "",
      '<div data-stimeo--frame-loading-target="overlay" hidden></div><div data-stimeo--frame-loading-target="content">c</div>',
    );
    const overlay = query("[data-stimeo--frame-loading-target='overlay']");
    fire("turbo:before-fetch-request");
    expect(overlay.hidden).toBe(false);
    fire("turbo:frame-load");
    expect(overlay.hidden).toBe(true);
  });

  it("reacts to a fetch that bubbles up from a descendant link", async () => {
    await mount("", '<div data-stimeo--frame-loading-target="content"><a id="link">go</a></div>');
    fire("turbo:before-fetch-request", query("#link"));
    expect(frame().getAttribute("aria-busy")).toBe("true");
  });

  it("retreats focus while loading and restores it on completion", async () => {
    await mount();
    const inside = query("#inside") as HTMLButtonElement;
    inside.focus();
    expect(document.activeElement).toBe(inside);

    fire("turbo:before-fetch-request");
    expect(document.activeElement).not.toBe(inside); // blurred away from stale content

    fire("turbo:frame-load");
    expect(document.activeElement).toBe(inside); // restored
  });

  it("restores focus to the same-id element when the load replaced the content", async () => {
    await mount();
    const content = query("[data-stimeo--frame-loading-target='content']");
    (query("#inside") as HTMLButtonElement).focus();

    fire("turbo:before-fetch-request");
    // Simulate a content-replacing frame load: the old #inside is gone, a fresh control
    // with the same id is rendered (as Turbo frames typically do).
    content.innerHTML = '<button id="inside">x</button>';
    fire("turbo:frame-load");
    expect(document.activeElement).toBe(query("#inside")); // the new, re-rendered node
  });

  it("leaves focus put when a replaced control had no id to re-find", async () => {
    await mount("", '<div data-stimeo--frame-loading-target="content"><button>x</button></div>');
    const button = query("button") as HTMLButtonElement;
    button.focus();

    fire("turbo:before-fetch-request");
    query("[data-stimeo--frame-loading-target='content']").innerHTML = "<button>y</button>";
    fire("turbo:frame-load");
    // No id to match → no surprise focus jump; focus stays off the frame (on body).
    expect(document.activeElement).not.toBe(query("button"));
  });

  it("does not touch focus when restoreFocus is false", async () => {
    await mount('data-stimeo--frame-loading-restore-focus-value="false"');
    const inside = query("#inside") as HTMLButtonElement;
    inside.focus();

    fire("turbo:before-fetch-request");
    // Focus is left as-is (no explicit retreat); restore is a no-op too.
    fire("turbo:frame-load");
    expect(document.activeElement).toBe(inside);
  });

  it("holds the loading state for at least minDuration", async () => {
    await mount('data-stimeo--frame-loading-min-duration-value="1000"');
    fire("turbo:before-fetch-request");

    vi.advanceTimersByTime(300);
    fire("turbo:frame-load"); // completes early
    expect(frame().getAttribute("aria-busy")).toBe("true"); // still held
    expect(skeleton().hidden).toBe(false);

    vi.advanceTimersByTime(699);
    expect(frame().getAttribute("aria-busy")).toBe("true");
    vi.advanceTimersByTime(1);
    expect(frame().hasAttribute("aria-busy")).toBe(false);
    expect(skeleton().hidden).toBe(true);
  });

  it("keeps loading when a new fetch starts during the min-duration hold", async () => {
    await mount('data-stimeo--frame-loading-min-duration-value="1000"');
    const ends: number[] = [];
    frame().addEventListener("stimeo--frame-loading:end", () => ends.push(Date.now()));

    fire("turbo:before-fetch-request");
    vi.advanceTimersByTime(300);
    fire("turbo:frame-load"); // schedules finish at +700

    fire("turbo:before-fetch-request"); // new fetch cancels the pending finish
    vi.advanceTimersByTime(1000);
    expect(frame().getAttribute("aria-busy")).toBe("true"); // still loading
    expect(ends).toEqual([]);

    fire("turbo:frame-load");
    vi.advanceTimersByTime(1000);
    expect(frame().hasAttribute("aria-busy")).toBe(false);
    expect(ends).toHaveLength(1);
  });

  // --- `minDuration` belongs to one held finish --------------------------------------

  /**
   * Rewrites `minDuration` and delivers its Value callback directly when the
   * controller defines one, since happy-dom does not reliably run it for an attribute
   * write.
   */
  const declareMinDuration = (value: number) => {
    frame().setAttribute("data-stimeo--frame-loading-min-duration-value", String(value));
    const owner = application.getControllerForElementAndIdentifier(
      frame(),
      "stimeo--frame-loading",
    );
    const callback: unknown = Reflect.get(owner ?? {}, "minDurationValueChanged");
    if (typeof callback === "function") callback.call(owner);
  };

  it.each([
    { direction: "shrinks", next: 50 },
    { direction: "grows", next: 5000 },
  ])(
    "keeps a held finish's deadline when minDuration $direction, and floors the next load anew",
    async ({ next }) => {
      await mount('data-stimeo--frame-loading-min-duration-value="1000"');
      const ends: string[] = [];
      frame().addEventListener("stimeo--frame-loading:end", () => ends.push("end"));
      fire("turbo:before-fetch-request");
      vi.advanceTimersByTime(300);
      fire("turbo:frame-load"); // held back until t=1000

      declareMinDuration(next);
      vi.advanceTimersByTime(699);
      expect(frame().getAttribute("aria-busy")).toBe("true");
      vi.advanceTimersByTime(1);
      expect(frame().hasAttribute("aria-busy")).toBe(false);
      expect(ends).toEqual(["end"]);

      fire("turbo:before-fetch-request"); // the next load measures from here
      fire("turbo:frame-load");
      vi.advanceTimersByTime(next - 1);
      expect(frame().getAttribute("aria-busy")).toBe("true");
      vi.advanceTimersByTime(1);
      expect(frame().hasAttribute("aria-busy")).toBe(false);
      expect(ends).toEqual(["end", "end"]);
    },
  );

  it("measures the floor from the fetch start when minDuration changes before the load ends", async () => {
    await mount('data-stimeo--frame-loading-min-duration-value="1000"');
    fire("turbo:before-fetch-request");
    vi.advanceTimersByTime(300);
    declareMinDuration(400);
    fire("turbo:frame-load"); // 100 ms of the new floor are left, counted from the fetch start
    vi.advanceTimersByTime(99);
    expect(frame().getAttribute("aria-busy")).toBe("true");
    vi.advanceTimersByTime(1);
    expect(frame().hasAttribute("aria-busy")).toBe(false);
  });

  it("finishes and reports nothing from a minDuration change alone", async () => {
    await mount('data-stimeo--frame-loading-min-duration-value="1000"');
    const events: string[] = [];
    for (const type of ["start", "end", "reconcile"]) {
      frame().addEventListener(`stimeo--frame-loading:${type}`, () => events.push(type));
    }
    fire("turbo:before-fetch-request");
    declareMinDuration(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(frame().getAttribute("aria-busy")).toBe("true");
    expect(skeleton().hidden).toBe(false);
    expect(events).toEqual(["start"]);
  });

  it("ends the loading state on a fetch error (safety net)", async () => {
    await mount();
    fire("turbo:before-fetch-request");
    fire("turbo:fetch-request-error");
    expect(frame().hasAttribute("aria-busy")).toBe(false);
  });

  it("ignores a repeated fetch start while already loading", async () => {
    await mount();
    let starts = 0;
    frame().addEventListener("stimeo--frame-loading:start", () => {
      starts += 1;
    });
    fire("turbo:before-fetch-request");
    fire("turbo:before-fetch-request");
    expect(starts).toBe(1);
  });

  it("tidies the hooks and clears timers once the frame really leaves", async () => {
    await mount('data-stimeo--frame-loading-min-duration-value="1000"');
    const el = frame();
    const bars = skeleton();
    const ends: string[] = [];
    el.addEventListener("stimeo--frame-loading:end", () => ends.push("end"));
    fire("turbo:before-fetch-request");
    vi.advanceTimersByTime(300);
    fire("turbo:frame-load"); // a finish is queued for +700 and must not outlive the detach
    expect(el.getAttribute("aria-busy")).toBe("true");
    expect(bars.hidden).toBe(false);

    el.remove();
    await vi.advanceTimersByTimeAsync(0);
    expect(el.hasAttribute("aria-busy")).toBe(false);
    expect(el.hasAttribute("data-frame-loading")).toBe(false);
    expect(bars.hidden).toBe(true);
    expect(query("[data-stimeo--frame-loading-target='content']", el).hasAttribute("inert")).toBe(
      false,
    );

    // Nothing may write to the frame afterwards: a surviving timer would reinstate
    // the hooks and announce an end nobody is listening for.
    el.setAttribute("aria-busy", "keep");
    fire("turbo:frame-load", el);
    vi.advanceTimersByTime(2000);
    expect(el.getAttribute("aria-busy")).toBe("keep");
    expect(ends).toEqual([]);
  });

  it("keeps a load in flight through turbo:before-cache and ends it at frame-load", async () => {
    await mount(
      "",
      '<div data-stimeo--frame-loading-target="skeleton" hidden></div><div data-stimeo--frame-loading-target="overlay" hidden></div><div data-stimeo--frame-loading-target="content"><button id="inside">x</button></div>',
    );
    const events: string[] = [];
    for (const name of ["end", "reconcile"]) {
      frame().addEventListener(`stimeo--frame-loading:${name}`, () => events.push(name));
    }
    const overlay = query("[data-stimeo--frame-loading-target='overlay']");
    fire("turbo:before-fetch-request");

    // Turbo dispatches it on pages that stay as well, where the fetch is still running
    // and the stale content must stay blocked.
    cacheSnapshot();
    expect(frame().getAttribute("aria-busy")).toBe("true");
    expect(frame().getAttribute("data-frame-loading")).toBe("true");
    expect(skeleton().hidden).toBe(false);
    expect(overlay.hidden).toBe(false);
    expect(content().hasAttribute("inert")).toBe(true);
    expect(events).toEqual([]);

    fire("turbo:frame-load");
    expect(frame().hasAttribute("aria-busy")).toBe(false);
    expect(skeleton().hidden).toBe(true);
    expect(overlay.hidden).toBe(true);
    expect(content().hasAttribute("inert")).toBe(false);
    expect(events).toEqual(["end"]);
  });

  it("records the author's values and the load's of the hooks on the elements a load writes", async () => {
    await mount();
    fire("turbo:before-fetch-request");

    // A copy of the page taken now still knows what the author wrote and what the load wrote.
    expect(frame().getAttribute("data-stimeo--frame-loading-aria-busy-lease")).toBe(
      '[null,"true"]',
    );
    expect(frame().getAttribute("data-stimeo--frame-loading-data-frame-loading-lease")).toBe(
      '[null,"true"]',
    );
    expect(skeleton().getAttribute("data-stimeo--frame-loading-hidden-lease")).toBe('["",null]');
    expect(content().getAttribute("data-stimeo--frame-loading-inert-lease")).toBe('[null,""]');

    fire("turbo:frame-load");
    expect(
      [frame(), skeleton(), content()].flatMap((element) =>
        element.getAttributeNames().filter((name) => name.endsWith("-lease")),
      ),
    ).toEqual([]);
  });

  it("gives an authored busy flag back when the load ends", async () => {
    await mount('aria-busy="false"');
    fire("turbo:before-fetch-request");
    expect(frame().getAttribute("aria-busy")).toBe("true");

    fire("turbo:frame-load");
    expect(frame().getAttribute("aria-busy")).toBe("false");
  });

  it("leaves an idle frame's markup alone on turbo:before-cache", async () => {
    await mount(
      "",
      '<div data-stimeo--frame-loading-target="skeleton"></div><div data-stimeo--frame-loading-target="content">c</div>',
    );
    // No fetch has started, so the visible skeleton is the consumer's own render.
    cacheSnapshot();
    expect(skeleton().hidden).toBe(false);
  });

  it("reports a restored page that shows a load no instance is running", async () => {
    await mount();
    fire("turbo:before-fetch-request");
    const reports: unknown[] = [];
    document.addEventListener("stimeo--frame-loading:reconcile", (e) =>
      reports.push((e as CustomEvent).detail),
    );

    application = await restoreFromCache(
      application,
      (restored) => restored.register("stimeo--frame-loading", FrameLoadingController),
      () => vi.advanceTimersByTimeAsync(0),
    );

    // `end` would claim the frame arrived; the load died with the page it ran on.
    expect(reports).toEqual([{}]);
  });

  it("reports nothing for a restored page that was idle", async () => {
    await mount();
    fire("turbo:before-fetch-request");
    fire("turbo:frame-load");
    const reports: unknown[] = [];
    document.addEventListener("stimeo--frame-loading:reconcile", (e) =>
      reports.push((e as CustomEvent).detail),
    );

    application = await restoreFromCache(
      application,
      (restored) => restored.register("stimeo--frame-loading", FrameLoadingController),
      () => vi.advanceTimersByTimeAsync(0),
    );

    expect(reports).toEqual([]);
  });

  /** Starts a fresh controller on a copy of the page, as Turbo renders one it restores. */
  const restore = async (): Promise<void> => {
    application = await restoreFromCache(
      application,
      (restored) => restored.register("stimeo--frame-loading", FrameLoadingController),
      () => vi.advanceTimersByTimeAsync(0),
    );
  };
  /** The lease records `elements` carry. */
  const records = (...elements: Element[]): string[] =>
    elements.flatMap((element) =>
      element.getAttributeNames().filter((name) => name.endsWith("-lease")),
    );

  it("gives a page restored in the middle of a load the author's aria-busy, data-frame-loading, hidden and inert back", async () => {
    await mount(
      'aria-busy="false"',
      '<div data-stimeo--frame-loading-target="skeleton" hidden></div><div id="overlay" data-stimeo--frame-loading-target="overlay" hidden></div><div data-stimeo--frame-loading-target="content"><button id="inside">x</button></div>',
    );
    fire("turbo:before-fetch-request");
    expect(skeleton().hidden).toBe(false);

    await restore();

    const overlay = query("#overlay");
    expect(frame().getAttribute("aria-busy")).toBe("false");
    expect(frame().hasAttribute("data-frame-loading")).toBe(false);
    expect(skeleton().hidden).toBe(true);
    expect(overlay.hidden).toBe(true);
    expect(content().hasAttribute("inert")).toBe(false);
    expect(records(frame(), skeleton(), overlay, content())).toEqual([]);

    // The next load runs from the author's values as usual.
    fire("turbo:before-fetch-request");
    expect(frame().getAttribute("aria-busy")).toBe("true");
    fire("turbo:frame-load");
    expect(frame().getAttribute("aria-busy")).toBe("false");
    expect(skeleton().hidden).toBe(true);
  });

  it("keeps an inert the author wrote on the content of a page restored in the middle of a load", async () => {
    await mount(
      "",
      '<div data-stimeo--frame-loading-target="skeleton" hidden></div><div data-stimeo--frame-loading-target="content" inert>c</div>',
    );
    fire("turbo:before-fetch-request");

    await restore();

    expect(content().hasAttribute("inert")).toBe(true);
    expect(records(content())).toEqual([]);
  });

  it("keeps a load in flight across an in-page move", async () => {
    await mount('data-stimeo--frame-loading-min-duration-value="1000"');
    const ends: string[] = [];
    frame().addEventListener("stimeo--frame-loading:end", () => ends.push("end"));
    fire("turbo:before-fetch-request");

    // A consumer re-inserting the frame disconnects and reconnects the SAME
    // instance; the fetch is still running, so the loading state has to survive.
    const controller = application.getControllerForElementAndIdentifier(
      frame(),
      "stimeo--frame-loading",
    ) as FrameLoadingController;
    controller.disconnect();
    controller.connect();
    expect(frame().getAttribute("aria-busy")).toBe("true");

    fire("turbo:frame-load");
    vi.advanceTimersByTime(1000);
    expect(frame().hasAttribute("aria-busy")).toBe(false);
    expect(ends).toEqual(["end"]);
  });

  it("keeps the held finish across an in-page move", async () => {
    await mount('data-stimeo--frame-loading-min-duration-value="1000"');
    fire("turbo:before-fetch-request");
    vi.advanceTimersByTime(300);
    fire("turbo:frame-load"); // holds the finish until +700

    const controller = application.getControllerForElementAndIdentifier(
      frame(),
      "stimeo--frame-loading",
    ) as FrameLoadingController;
    controller.disconnect();
    controller.connect();
    vi.advanceTimersByTime(700);
    // Losing this timer strands the frame busy and inert for the rest of the session.
    expect(frame().hasAttribute("aria-busy")).toBe(false);
    expect(skeleton().hidden).toBe(true);
  });

  it("keeps a load in flight once an in-page move has settled", async () => {
    await mount();
    fire("turbo:before-fetch-request");
    const controller = application.getControllerForElementAndIdentifier(
      frame(),
      "stimeo--frame-loading",
    ) as FrameLoadingController;

    controller.disconnect();
    controller.connect();
    await vi.advanceTimersByTimeAsync(0);

    expect(frame().getAttribute("aria-busy")).toBe("true");
    expect(skeleton().hidden).toBe(false);
    expect(content().hasAttribute("inert")).toBe(true);
  });

  it("returns the frame to its idle form when the identifier leaves a live element", async () => {
    await mount('data-stimeo--frame-loading-min-duration-value="1000"');
    const el = frame();
    const ends: string[] = [];
    el.addEventListener("stimeo--frame-loading:end", () => ends.push("end"));
    fire("turbo:before-fetch-request");
    expect(el.getAttribute("aria-busy")).toBe("true");

    // A morph can drop the identifier while leaving the element in place: no
    // reconnect will come, so nothing is left that could finish the load.
    el.setAttribute("data-controller", "");
    await vi.advanceTimersByTimeAsync(0);
    expect(el.hasAttribute("aria-busy")).toBe(false);
    expect(el.hasAttribute("data-frame-loading")).toBe(false);
    expect(skeleton().hidden).toBe(true);
    expect(content().hasAttribute("inert")).toBe(false);
    // State only: the load never completed.
    expect(ends).toEqual([]);
  });

  it("leaves focus alone when the identifier leaves a live element", async () => {
    await mount();
    const el = frame();
    const inside = query("#inside") as HTMLButtonElement;
    inside.focus();
    fire("turbo:before-fetch-request");
    const retreatedTo = document.activeElement;
    expect(retreatedTo).not.toBe(inside);

    el.setAttribute("data-controller", "");
    await vi.advanceTimersByTimeAsync(0);
    // The element is leaving this controller's care; moving focus anywhere now
    // would be an unexplained jump, so it stays exactly where the retreat left it.
    expect(document.activeElement).toBe(retreatedTo);
  });

  it("finishes a held load through turbo:before-cache: end, announcement and focus", async () => {
    const messages = captureAnnouncements();
    await mount(
      'data-stimeo--frame-loading-min-duration-value="1000" data-stimeo--frame-loading-announce-ready-text-value="Ready"',
    );
    const ends: string[] = [];
    frame().addEventListener("stimeo--frame-loading:end", () => ends.push("end"));
    const inside = query("#inside") as HTMLButtonElement;
    inside.focus();

    fire("turbo:before-fetch-request");
    vi.advanceTimersByTime(300);
    fire("turbo:frame-load"); // the floor holds the finish until +700
    // A promoted frame navigation dispatches it now, on the page that stays.
    cacheSnapshot();

    vi.advanceTimersByTime(700);
    expect(ends).toEqual(["end"]);
    expect(messages).toEqual(["Ready"]);
    expect(document.activeElement).toBe(inside);
  });

  it("treats a fetch after turbo:before-cache as part of the load still running", async () => {
    await mount();
    const starts: string[] = [];
    frame().addEventListener("stimeo--frame-loading:start", () => starts.push("start"));
    fire("turbo:before-fetch-request");
    cacheSnapshot();

    fire("turbo:before-fetch-request");
    expect(starts).toEqual(["start"]);
    expect(frame().getAttribute("aria-busy")).toBe("true");
    fire("turbo:frame-load");
    expect(frame().hasAttribute("aria-busy")).toBe(false);
  });

  it("re-shows a skeleton the frame render replaced mid-load", async () => {
    await mount();
    fire("turbo:before-fetch-request");
    expect(skeleton().hidden).toBe(false);

    // The response ships its skeleton in the authored (hidden) form, and only the
    // controller knows the frame is still busy.
    await renderFrame(
      '<div data-stimeo--frame-loading-target="skeleton" hidden></div><div data-stimeo--frame-loading-target="content">fresh</div>',
    );
    expect(skeleton().hidden).toBe(false);

    fire("turbo:frame-load");
    expect(skeleton().hidden).toBe(true);
  });

  it("re-shows an overlay the frame render replaced mid-load", async () => {
    await mount(
      "",
      '<div data-stimeo--frame-loading-target="overlay" hidden></div><div data-stimeo--frame-loading-target="content">c</div>',
    );
    const overlay = () => query("[data-stimeo--frame-loading-target='overlay']");
    fire("turbo:before-fetch-request");

    await renderFrame(
      '<div data-stimeo--frame-loading-target="overlay" hidden></div><div data-stimeo--frame-loading-target="content">fresh</div>',
    );
    expect(overlay().hidden).toBe(false);

    fire("turbo:frame-load");
    expect(overlay().hidden).toBe(true);
  });

  it("re-blocks a content element the frame render replaced mid-load", async () => {
    await mount();
    fire("turbo:before-fetch-request");
    expect(content().hasAttribute("inert")).toBe(true);

    await renderFrame(
      '<div data-stimeo--frame-loading-target="skeleton" hidden></div><div data-stimeo--frame-loading-target="content">fresh</div>',
    );
    expect(content().hasAttribute("inert")).toBe(true);

    // The replacement is this controller's to release on completion.
    fire("turbo:frame-load");
    expect(content().hasAttribute("inert")).toBe(false);
  });

  it("keeps an inert a mid-load replacement authored", async () => {
    await mount();
    fire("turbo:before-fetch-request");

    await renderFrame('<div data-stimeo--frame-loading-target="content" inert>fresh</div>');
    fire("turbo:frame-load");
    // Ownership is decided per element: this one arrived inert on its own.
    expect(content().hasAttribute("inert")).toBe(true);
  });

  it("hands a content moved out mid-load back usable when its replacement arrives", async () => {
    await mount();
    fire("turbo:before-fetch-request");
    const departed = content();
    const replacement = document.createElement("div");
    replacement.setAttribute("data-stimeo--frame-loading-target", "content");
    const controller = application.getControllerForElementAndIdentifier(
      frame(),
      "stimeo--frame-loading",
    ) as FrameLoadingController;

    departed.replaceWith(replacement);
    document.body.append(departed);
    controller.contentTargetConnected();

    expect(departed.hasAttribute("inert")).toBe(false);
    expect(replacement.hasAttribute("inert")).toBe(true);

    fire("turbo:frame-load");
    expect(departed.hasAttribute("inert")).toBe(false);
    expect(replacement.hasAttribute("inert")).toBe(false);
  });

  it("leaves targets that arrive while idle alone", async () => {
    await mount();
    await renderFrame(
      '<div data-stimeo--frame-loading-target="skeleton"></div><div data-stimeo--frame-loading-target="content">fresh</div>',
    );
    // Nothing is loading, so the visible skeleton is the consumer's own render.
    expect(skeleton().hidden).toBe(false);
    expect(content().hasAttribute("inert")).toBe(false);
  });

  describe("targets that stay after an earlier one leaves", () => {
    const ALL_TARGETS =
      '<div data-stimeo--frame-loading-target="skeleton" hidden></div><div data-stimeo--frame-loading-target="overlay" hidden></div><div data-stimeo--frame-loading-target="content"><button id="inside">x</button></div>';
    const overlay = () => query("[data-stimeo--frame-loading-target='overlay']");
    const controller = () =>
      application.getControllerForElementAndIdentifier(
        frame(),
        "stimeo--frame-loading",
      ) as FrameLoadingController;
    /** Inserts a server-fresh copy after `original`, in the form the markup authors. */
    const insertSuccessor = (original: HTMLElement) => {
      const successor = original.cloneNode(false) as HTMLElement;
      if (successor.getAttribute("data-stimeo--frame-loading-target") !== "content") {
        successor.hidden = true;
      }
      successor.removeAttribute("inert");
      original.after(successor);
      return successor;
    };
    /** Inserts a successor, then removes `original` a task later. */
    const leaveBehindSuccessor = async (original: HTMLElement) => {
      const successor = insertSuccessor(original);
      await vi.advanceTimersByTimeAsync(0);
      original.remove();
      await vi.advanceTimersByTimeAsync(0);
      return successor;
    };

    it("reveals a skeleton and an overlay that arrive mid-load where there were none", async () => {
      await mount("", '<div data-stimeo--frame-loading-target="content">c</div>');
      fire("turbo:before-fetch-request");
      // Nothing departs here, so the arrivals are the only callbacks that can reveal them.
      frame().insertAdjacentHTML(
        "afterbegin",
        '<div data-stimeo--frame-loading-target="skeleton" hidden></div><div data-stimeo--frame-loading-target="overlay" hidden></div>',
      );
      await vi.advanceTimersByTimeAsync(0);

      expect([skeleton().hidden, overlay().hidden]).toEqual([false, false]);

      fire("turbo:frame-load");
      expect([skeleton().hidden, overlay().hidden]).toEqual([true, true]);
    });

    it("reveals a skeleton that stays after an earlier one leaves mid-load", async () => {
      await mount("", ALL_TARGETS);
      fire("turbo:before-fetch-request");
      const successor = await leaveBehindSuccessor(skeleton());

      expect(skeleton()).toBe(successor);
      expect(successor.hidden).toBe(false);

      fire("turbo:frame-load");
      expect(successor.hidden).toBe(true);
    });

    it("reveals an overlay that stays after an earlier one leaves mid-load", async () => {
      await mount("", ALL_TARGETS);
      fire("turbo:before-fetch-request");
      const successor = await leaveBehindSuccessor(overlay());

      expect(overlay()).toBe(successor);
      expect(successor.hidden).toBe(false);

      fire("turbo:frame-load");
      expect(successor.hidden).toBe(true);
    });

    it("blocks a content element that stays after an earlier one leaves mid-load", async () => {
      await mount("", ALL_TARGETS);
      fire("turbo:before-fetch-request");
      const successor = await leaveBehindSuccessor(content());

      expect(content()).toBe(successor);
      expect(successor.hasAttribute("inert")).toBe(true);

      fire("turbo:frame-load");
      expect(successor.hasAttribute("inert")).toBe(false);
    });

    it("hides a skeleton and an overlay that only lose their target mark mid-load", async () => {
      await mount("", ALL_TARGETS);
      fire("turbo:before-fetch-request");
      const departing = [skeleton(), overlay()];
      const successors = departing.map(insertSuccessor);
      await vi.advanceTimersByTimeAsync(0);
      // The elements stay in the frame; only the attribute naming them a target goes.
      for (const element of departing) {
        element.removeAttribute("data-stimeo--frame-loading-target");
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(departing.map((element) => element.hidden)).toEqual([true, true]);
      expect(successors.map((element) => element.hidden)).toEqual([false, false]);

      fire("turbo:frame-load");
      expect(departing.map((element) => element.hidden)).toEqual([true, true]);
      expect(successors.map((element) => element.hidden)).toEqual([true, true]);
    });

    it("leaves a shown skeleton and overlay it did not reveal alone when they lose their mark mid-load", async () => {
      await mount(
        "",
        `${ALL_TARGETS}<div id="own-skeleton" data-stimeo--frame-loading-target="skeleton"></div><div id="own-overlay" data-stimeo--frame-loading-target="overlay"></div>`,
      );
      fire("turbo:before-fetch-request");
      // The consumer shows these later targets itself; the load revealed the first ones.
      const consumers = [query("#own-skeleton"), query("#own-overlay")];
      for (const element of consumers) {
        element.removeAttribute("data-stimeo--frame-loading-target");
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(consumers.map((element) => element.hidden)).toEqual([false, false]);
      expect([skeleton().hidden, overlay().hidden]).toEqual([false, false]);
    });

    it("hands an element that lost its mark mid-load back to the page for good", async () => {
      await mount("", ALL_TARGETS);
      fire("turbo:before-fetch-request");
      const departing = [skeleton(), overlay()];
      for (const element of departing) {
        element.removeAttribute("data-stimeo--frame-loading-target");
      }
      await vi.advanceTimersByTimeAsync(0);
      // The page puts the returned elements to its own use before the load ends.
      for (const element of departing) element.hidden = false;

      fire("turbo:frame-load");
      expect(departing.map((element) => element.hidden)).toEqual([false, false]);
    });

    it("releases a content element that only loses its target mark mid-load", async () => {
      await mount("", ALL_TARGETS);
      fire("turbo:before-fetch-request");
      const departing = content();
      const successor = insertSuccessor(departing);
      await vi.advanceTimersByTimeAsync(0);
      departing.removeAttribute("data-stimeo--frame-loading-target");
      await vi.advanceTimersByTimeAsync(0);

      expect(departing.hasAttribute("inert")).toBe(false);
      expect(successor.hasAttribute("inert")).toBe(true);

      fire("turbo:frame-load");
      expect(departing.hasAttribute("inert")).toBe(false);
      expect(successor.hasAttribute("inert")).toBe(false);
    });

    it("reveals and blocks nothing when earlier targets leave while idle", async () => {
      await mount("", ALL_TARGETS);
      const originals = [skeleton(), overlay(), content()];
      const successors = originals.map(insertSuccessor);
      await vi.advanceTimersByTimeAsync(0);
      for (const original of originals) original.remove();
      await vi.advanceTimersByTimeAsync(0);

      expect(successors.map((element) => element.hidden)).toEqual([true, true, false]);
      expect(successors[2]?.hasAttribute("inert")).toBe(false);
    });

    it("says nothing when it re-arms the targets that stay", async () => {
      const messages = captureAnnouncements();
      await mount('data-stimeo--frame-loading-announce-text-value="Loading"', ALL_TARGETS);
      fire("turbo:before-fetch-request");
      messages.length = 0;
      const events: string[] = [];
      const listening = new AbortController();
      for (const type of [
        "stimeo--frame-loading:start",
        "stimeo--frame-loading:end",
        "stimeo--frame-loading:reconcile",
        "change",
      ]) {
        frame().addEventListener(type, () => events.push(type), { signal: listening.signal });
      }
      const originals = [skeleton(), overlay(), content()];
      const successors = originals.map(insertSuccessor);
      await vi.advanceTimersByTimeAsync(0);
      for (const original of originals) original.remove();
      await vi.advanceTimersByTimeAsync(0);
      listening.abort();

      expect(successors.map((element) => element.hidden)).toEqual([false, false, false]);
      expect(events).toEqual([]);
      expect(messages).toEqual([]);
    });

    it("keeps loading when its only targets leave", async () => {
      await mount("", ALL_TARGETS);
      fire("turbo:before-fetch-request");
      const departing = [skeleton(), overlay(), content()] as const;
      for (const element of departing) element.remove();
      await vi.advanceTimersByTimeAsync(0);

      expect(() => controller().skeletonTargetDisconnected(departing[0])).not.toThrow();
      expect(() => controller().overlayTargetDisconnected(departing[1])).not.toThrow();
      expect(() => controller().contentTargetDisconnected(departing[2])).not.toThrow();
      expect(frame().getAttribute("aria-busy")).toBe("true");
    });

    it("leaves the targets untouched when they are still there as it disconnects mid-load", async () => {
      await mount("", ALL_TARGETS);
      fire("turbo:before-fetch-request");
      const targets = [skeleton(), overlay(), content()] as const;
      const writes = new MutationObserver(() => {});
      for (const element of targets) writes.observe(element, { attributes: true });
      const instance = controller();

      // An in-page move: Stimulus delivers every target's departure after
      // `disconnect()`, while the targets still resolve inside the frame.
      instance.disconnect();
      instance.skeletonTargetDisconnected(targets[0]);
      instance.overlayTargetDisconnected(targets[1]);
      instance.contentTargetDisconnected(targets[2]);
      const records = writes.takeRecords();
      writes.disconnect();
      instance.connect();

      expect(records).toEqual([]);
      expect(targets.map((element) => element.hidden)).toEqual([false, false, false]);
      expect(targets[2].hasAttribute("inert")).toBe(true);
    });

    it("keeps the state of targets that move within the frame mid-load", async () => {
      await mount("", `${ALL_TARGETS}<div id="elsewhere"></div>`);
      fire("turbo:before-fetch-request");
      const targets = [skeleton(), overlay(), content()] as const;

      query("#elsewhere").append(...targets);
      await vi.advanceTimersByTimeAsync(0);

      expect([skeleton(), overlay(), content()]).toEqual(targets);
      expect(targets.map((element) => element.hidden)).toEqual([false, false, false]);
      expect(targets[2].hasAttribute("inert")).toBe(true);

      fire("turbo:frame-load");
      expect(targets.map((element) => element.hidden)).toEqual([true, true, false]);
      expect(targets[2].hasAttribute("inert")).toBe(false);
    });

    it("returns every target to its idle form when the identifier leaves mid-load", async () => {
      await mount("", ALL_TARGETS);
      fire("turbo:before-fetch-request");
      const targets = [skeleton(), overlay(), content()] as const;

      frame().removeAttribute("data-controller");
      await vi.advanceTimersByTimeAsync(0);

      expect(targets.map((element) => element.hidden)).toEqual([true, true, false]);
      expect(targets[2].hasAttribute("inert")).toBe(false);
    });

    it("hides a skeleton and an overlay it revealed once arrivals ahead of them take over", async () => {
      await mount("", ALL_TARGETS);
      fire("turbo:before-fetch-request");
      const displaced = [skeleton(), overlay()];
      const arrivals = displaced.map((element) => {
        const arrival = element.cloneNode(false) as HTMLElement;
        arrival.hidden = true;
        element.before(arrival);
        return arrival;
      });
      await vi.advanceTimersByTimeAsync(0);

      expect([skeleton(), overlay()]).toEqual(arrivals);
      expect(arrivals.map((element) => element.hidden)).toEqual([false, false]);
      expect(displaced.map((element) => element.hidden)).toEqual([true, true]);

      // Once the displaced elements lose their mark, nothing the load wrote stays on them.
      for (const element of displaced) {
        element.removeAttribute("data-stimeo--frame-loading-target");
      }
      await vi.advanceTimersByTimeAsync(0);
      fire("turbo:frame-load");
      expect(displaced.map((element) => element.hidden)).toEqual([true, true]);
      expect(arrivals.map((element) => element.hidden)).toEqual([true, true]);
    });
  });

  it("announces the loading and ready text through the shared announcer", async () => {
    const messages = captureAnnouncements();
    await mount(
      'data-stimeo--frame-loading-announce-text-value="Loading" data-stimeo--frame-loading-announce-ready-text-value="Ready"',
    );

    fire("turbo:before-fetch-request");
    expect(messages).toEqual(["Loading"]);
    fire("turbo:frame-load");
    expect(messages).toEqual(["Loading", "Ready"]);
  });

  it("leaves an idle frame's own busy flag untouched on turbo:before-cache", async () => {
    await mount('aria-busy="true"');
    cacheSnapshot();
    // Not loading, so the busy flag is the consumer's to keep.
    expect(frame().getAttribute("aria-busy")).toBe("true");
  });

  it("ignores a frame load that arrives while idle", async () => {
    await mount();
    const ends: string[] = [];
    frame().addEventListener("stimeo--frame-loading:end", () => ends.push("end"));

    fire("turbo:frame-load");
    fire("turbo:fetch-request-error");
    // Nothing was started, so nothing may be reported as finished.
    expect(ends).toEqual([]);
    expect(frame().hasAttribute("aria-busy")).toBe(false);
    expect(skeleton().hidden).toBe(true);
  });

  it("queues a single finish when the end signal repeats during the min-duration hold", async () => {
    await mount('data-stimeo--frame-loading-min-duration-value="1000"');
    const ends: string[] = [];
    frame().addEventListener("stimeo--frame-loading:end", () => ends.push("end"));

    fire("turbo:before-fetch-request");
    vi.advanceTimersByTime(300);
    fire("turbo:frame-load"); // schedules the finish at +700
    fire("turbo:fetch-request-error"); // a second end signal replaces it rather than stacking

    vi.advanceTimersByTime(1000);
    expect(ends).toEqual(["end"]);
  });

  it("enters the loading state again on the fetch after a completed one", async () => {
    await mount();
    const starts: string[] = [];
    frame().addEventListener("stimeo--frame-loading:start", () => starts.push("start"));

    fire("turbo:before-fetch-request");
    fire("turbo:frame-load");
    fire("turbo:before-fetch-request");

    expect(starts).toEqual(["start", "start"]);
    expect(frame().getAttribute("aria-busy")).toBe("true");
    expect(skeleton().hidden).toBe(false);
  });

  it("dispatches start and end events carrying an empty detail", async () => {
    await mount();
    const seen: { type: string; detail: unknown }[] = [];
    for (const type of ["stimeo--frame-loading:start", "stimeo--frame-loading:end"]) {
      frame().addEventListener(type, (event) => {
        seen.push({ type: event.type, detail: (event as CustomEvent).detail });
      });
    }

    fire("turbo:before-fetch-request");
    fire("turbo:frame-load");
    // The whole payload is pinned, so an added detail key breaks this too.
    expect(seen).toEqual([
      { type: "stimeo--frame-loading:start", detail: {} },
      { type: "stimeo--frame-loading:end", detail: {} },
    ]);
  });

  it("keeps an inert the consumer wrote on the content", async () => {
    await mount(
      "",
      '<div data-stimeo--frame-loading-target="content" inert><button>x</button></div>',
    );
    fire("turbo:before-fetch-request");
    fire("turbo:frame-load");
    // The controller only removes the inert it applied itself.
    expect(content().hasAttribute("inert")).toBe(true);
  });

  it("releases the inert it owns so the consumer can take it over", async () => {
    await mount();
    fire("turbo:before-fetch-request");
    fire("turbo:frame-load");
    expect(content().hasAttribute("inert")).toBe(false);

    // Ownership went back to the consumer with that removal; a second cycle must not
    // strip an inert this controller did not apply.
    content().setAttribute("inert", "");
    fire("turbo:before-fetch-request");
    fire("turbo:frame-load");
    expect(content().hasAttribute("inert")).toBe(true);
  });

  it("runs a full cycle on a frame that has no content target", async () => {
    await mount("", '<div data-stimeo--frame-loading-target="skeleton" hidden></div>');
    fire("turbo:before-fetch-request");
    expect(frame().getAttribute("aria-busy")).toBe("true");
    expect(skeleton().hidden).toBe(false);

    fire("turbo:frame-load");
    expect(frame().hasAttribute("aria-busy")).toBe(false);
    expect(skeleton().hidden).toBe(true);
  });

  it("leaves focus put when restoreFocus is turned off during the load", async () => {
    await mount();
    const inside = query("#inside") as HTMLButtonElement;
    inside.focus();

    fire("turbo:before-fetch-request");
    expect(document.activeElement).not.toBe(inside);
    frame().setAttribute("data-stimeo--frame-loading-restore-focus-value", "false");
    await vi.advanceTimersByTimeAsync(0);

    fire("turbo:frame-load");
    // The value is read when the load completes, not when it started.
    expect(document.activeElement).not.toBe(inside);
  });

  it("restores focus to a surviving control that has no id", async () => {
    await mount(
      "",
      '<div data-stimeo--frame-loading-target="content"><button>anonymous</button></div>',
    );
    const button = query("button") as HTMLButtonElement;
    button.focus();

    fire("turbo:before-fetch-request");
    expect(document.activeElement).not.toBe(button);
    // The fetch failed, so nothing was replaced: the saved node is the only way back,
    // since an id lookup has nothing to match on.
    fire("turbo:fetch-request-error");
    expect(document.activeElement).toBe(button);
  });

  it("leaves focus outside the frame where it is", async () => {
    document.body.innerHTML =
      '<button id="outside">o</button><div tabindex="-1" data-controller="stimeo--frame-loading"><div data-stimeo--frame-loading-target="content">c</div></div>';
    application = Application.start();
    application.register("stimeo--frame-loading", FrameLoadingController);
    await vi.advanceTimersByTimeAsync(0);
    const outside = query("#outside") as HTMLButtonElement;

    outside.focus();
    fire("turbo:before-fetch-request");
    // Only the content going stale justifies moving focus; the rest of the page is
    // still usable, so taking focus from it would be an unexplained jump.
    expect(document.activeElement).toBe(outside);
  });

  it("leaves focus on the frame element itself where it is", async () => {
    await mount('tabindex="-1"', '<div data-stimeo--frame-loading-target="content">c</div>');
    const el = frame() as HTMLElement;
    el.focus();
    fire("turbo:before-fetch-request");
    // The frame itself is not part of the content being replaced.
    expect(document.activeElement).toBe(el);
  });

  it("keeps a sibling frame's fetch out of this one", async () => {
    document.body.innerHTML =
      '<div id="a" data-controller="stimeo--frame-loading"><div data-stimeo--frame-loading-target="skeleton" hidden></div></div>' +
      '<div id="b" data-controller="stimeo--frame-loading"><div data-stimeo--frame-loading-target="skeleton" hidden></div></div>';
    application = Application.start();
    application.register("stimeo--frame-loading", FrameLoadingController);
    await vi.advanceTimersByTimeAsync(0);

    // Turbo's events all bubble, so a subscription above the frame would see every
    // frame's fetch on the page.
    fire("turbo:before-fetch-request", query("#b"));
    expect(query("#b").getAttribute("aria-busy")).toBe("true");
    expect(query("#a").hasAttribute("aria-busy")).toBe(false);
    expect(query("[data-stimeo--frame-loading-target='skeleton']", query("#a")).hidden).toBe(true);
  });

  it("stops reacting to fetch events once disconnected in place", async () => {
    await mount();
    const el = frame();
    // The element stays put and only the controller leaves: nothing is left that
    // could finish a load it would start.
    application.unload(["stimeo--frame-loading"]);
    await vi.advanceTimersByTimeAsync(0);

    fire("turbo:before-fetch-request", el);
    expect(el.hasAttribute("aria-busy")).toBe(false);
    expect(el.hasAttribute("data-frame-loading")).toBe(false);
    expect(content().hasAttribute("inert")).toBe(false);
  });

  it("has no a11y violations", async () => {
    vi.useRealTimers();
    document.body.innerHTML =
      '<div data-controller="stimeo--frame-loading"><div data-stimeo--frame-loading-target="content">content</div></div>';
    application = Application.start();
    application.register("stimeo--frame-loading", FrameLoadingController);
    await tick();
    await expectNoA11yViolations(frame());
  });
});
