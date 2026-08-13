import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrameLoadingController } from "../src/controllers/frame_loading_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link FrameLoadingController}, driven by simulated Turbo
 * fetch events and a mocked clock: the aria-busy / data hook + skeleton toggle, the
 * inert content guard, focus retreat and restore, the min-duration floor, the
 * error safety net, idempotent start, and teardown.
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
  /** Turbo caches the page from a document-level event, not one aimed at the frame. */
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

  it("rewinds the frame's hooks for the cached snapshot", async () => {
    await mount('data-stimeo--frame-loading-min-duration-value="1000"');
    const ends: string[] = [];
    frame().addEventListener("stimeo--frame-loading:end", () => ends.push("end"));
    const inside = query("#inside") as HTMLButtonElement;
    inside.focus();
    fire("turbo:before-fetch-request");

    document.dispatchEvent(new Event("turbo:before-cache"));
    // A snapshot taken mid-fetch would restore a frame that is busy, inert and
    // skeletoned with nothing left to finish it. State only: no `end`, and focus
    // stays put because the load did not complete.
    expect(frame().hasAttribute("aria-busy")).toBe(false);
    expect(frame().hasAttribute("data-frame-loading")).toBe(false);
    expect(skeleton().hidden).toBe(true);
    expect(content().hasAttribute("inert")).toBe(false);
    expect(ends).toEqual([]);
    expect(document.activeElement).not.toBe(inside);
  });

  it("rewinds an overlay for the cached snapshot too", async () => {
    await mount(
      "",
      '<div data-stimeo--frame-loading-target="overlay" hidden></div><div data-stimeo--frame-loading-target="content">c</div>',
    );
    const overlay = query("[data-stimeo--frame-loading-target='overlay']");
    fire("turbo:before-fetch-request");
    expect(overlay.hidden).toBe(false);
    document.dispatchEvent(new Event("turbo:before-cache"));
    // Both optional targets are the controller's to hide, so a snapshot must not
    // keep an overlay up over content that is no longer loading.
    expect(overlay.hidden).toBe(true);
  });

  it("leaves an idle frame's markup alone on the cached snapshot", async () => {
    await mount(
      "",
      '<div data-stimeo--frame-loading-target="skeleton"></div><div data-stimeo--frame-loading-target="content">c</div>',
    );
    // No fetch has started, so the visible skeleton is the consumer's own render.
    // The rewind only undoes what this controller applied.
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(skeleton().hidden).toBe(false);
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
    // State only, like the snapshot rewind: the load never completed.
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

  it("drops a held finish when the snapshot rewinds the load", async () => {
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
    cacheSnapshot();
    const retreatedTo = document.activeElement;

    vi.advanceTimersByTime(1000);
    // The rewind abandoned the load, so a finish it was holding must not surface
    // afterwards as an end, a completion announcement, or a focus move.
    expect(ends).toEqual([]);
    expect(messages).toEqual([]);
    expect(document.activeElement).toBe(retreatedTo);
  });

  it("starts a fresh load after the snapshot on a page that survives the visit", async () => {
    await mount();
    fire("turbo:before-fetch-request");
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(frame().hasAttribute("aria-busy")).toBe(false);

    // A cancelled visit leaves this page live, so the next fetch has to raise the
    // loading state again rather than find it already claimed.
    fire("turbo:before-fetch-request");
    expect(frame().getAttribute("aria-busy")).toBe("true");
    expect(frame().getAttribute("data-frame-loading")).toBe("true");
    expect(skeleton().hidden).toBe(false);
    expect(content().hasAttribute("inert")).toBe(true);
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

  it("leaves targets that arrive while idle alone", async () => {
    await mount();
    await renderFrame(
      '<div data-stimeo--frame-loading-target="skeleton"></div><div data-stimeo--frame-loading-target="content">fresh</div>',
    );
    // Nothing is loading, so the visible skeleton is the consumer's own render.
    expect(skeleton().hidden).toBe(false);
    expect(content().hasAttribute("inert")).toBe(false);
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

  it("announces nothing while rewinding for the snapshot", async () => {
    const messages = captureAnnouncements();
    await mount(
      'data-stimeo--frame-loading-announce-text-value="Loading" data-stimeo--frame-loading-announce-ready-text-value="Ready"',
    );
    const ends: string[] = [];
    frame().addEventListener("stimeo--frame-loading:end", () => ends.push("end"));

    fire("turbo:before-fetch-request");
    cacheSnapshot();
    // The load never finished; freezing the page is not a lifecycle the consumer sees.
    expect(ends).toEqual([]);
    expect(messages).toEqual(["Loading"]);
  });

  it("leaves an idle frame's own busy flag untouched when the snapshot is taken", async () => {
    await mount('aria-busy="true"');
    cacheSnapshot();
    // Not loading, so the busy flag is the consumer's to keep.
    expect(frame().getAttribute("aria-busy")).toBe("true");
  });

  it("stops rewinding for the snapshot once disconnected", async () => {
    await mount();
    const el = frame();
    fire("turbo:before-fetch-request");
    el.remove();
    await vi.advanceTimersByTimeAsync(0);
    el.setAttribute("aria-busy", "true");

    cacheSnapshot();
    // The detached element is nobody's business anymore.
    expect(el.getAttribute("aria-busy")).toBe("true");
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
