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

  it("clears timers once the frame really leaves", async () => {
    await mount('data-stimeo--frame-loading-min-duration-value="1000"');
    const el = frame();
    const ends: string[] = [];
    el.addEventListener("stimeo--frame-loading:end", () => ends.push("end"));
    fire("turbo:before-fetch-request");
    expect(el.getAttribute("aria-busy")).toBe("true");

    el.remove();
    await vi.advanceTimersByTimeAsync(0);
    fire("turbo:frame-load", el); // would hold a finish for the remaining floor
    vi.advanceTimersByTime(2000);
    // A detached frame keeps the markup it had — the page being cached is rewound at
    // `turbo:before-cache`, where the frame is still whole — but nothing may fire
    // against it afterwards.
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
