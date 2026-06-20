import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkeletonController } from "../src/controllers/skeleton_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link SkeletonController}: the initial loading state,
 * the `ready` swap, `aria-busy` mirroring, the min-duration floor, and timer
 * teardown on disconnect.
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
    application.stop();
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

  it("dispatches a ready event", async () => {
    await start();
    let ready = false;
    root().addEventListener("stimeo--skeleton:ready", () => {
      ready = true;
    });
    instance().ready();
    expect(ready).toBe(true);
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

  it("ignores a repeated ready while a reveal is pending", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    instance().ready();
    instance().ready();
    vi.advanceTimersByTime(300);
    expect(content().hidden).toBe(false);
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

  it("clears the pending reveal timer on disconnect", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    instance().ready();
    const el = content();
    // Invoke disconnect() directly for a deterministic teardown (no reliance on
    // the async MutationObserver flush, which was environment-sensitive).
    instance().disconnect();
    vi.advanceTimersByTime(400);
    // The cancelled timer must not reveal the content after teardown.
    expect(el.hidden).toBe(true);
  });
});

/** Layer ① (axe) runs under real timers, independent of the timing behavior. */
describe("SkeletonController accessibility", () => {
  let application: Application;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    application.stop();
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

  // Layer ③ — the decorative placeholder is aria-hidden, so the skeleton is never
  // announced; once ready, the real content is exposed to the reader.
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
