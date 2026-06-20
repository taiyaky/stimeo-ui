import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelativeTimeController } from "../src/controllers/relative_time_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link RelativeTimeController}, driven by a mocked clock:
 * relative formatting (past/future), locale selection, adaptive updates, the
 * threshold fallback to absolute text, and timer teardown on disconnect.
 */

/** Fixed "now" so the relative arithmetic is deterministic. */
const NOW = new Date("2026-06-06T12:00:00Z");

describe("RelativeTimeController", () => {
  let application: Application;

  const start = async (datetime: string, attrs = "", text = "absolute") => {
    document.body.innerHTML = `
      <time data-controller="stimeo--relative-time" datetime="${datetime}" ${attrs}>${text}</time>`;
    application = Application.start();
    application.register("stimeo--relative-time", RelativeTimeController);
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    document.documentElement.lang = "en";
  });

  afterEach(() => {
    application.stop();
    vi.useRealTimers();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("lang");
  });

  const el = () => query("[data-controller='stimeo--relative-time']");

  it("renders a past time relatively", async () => {
    await start("2026-06-06T11:57:00Z"); // 3 minutes ago
    expect(el().textContent).toBe("3 minutes ago");
    expect(el().getAttribute("data-state")).toBe("relative");
  });

  it("renders a future time relatively", async () => {
    await start("2026-06-06T14:00:00Z"); // in 2 hours
    expect(el().textContent).toBe("in 2 hours");
  });

  it("leaves the machine-readable datetime untouched", async () => {
    await start("2026-06-06T11:57:00Z");
    expect(el().getAttribute("datetime")).toBe("2026-06-06T11:57:00Z");
  });

  it("uses the locale value for formatting", async () => {
    await start("2026-06-06T11:57:00Z", 'data-stimeo--relative-time-locale-value="ja"');
    expect(el().textContent).toContain("分");
  });

  it("updates as time passes", async () => {
    await start("2026-06-06T11:59:10Z"); // 50 seconds ago
    expect(el().textContent).toBe("50 seconds ago");
    vi.advanceTimersByTime(60_000); // a minute later -> 110 s ago
    expect(el().textContent).toBe("2 minutes ago");
  });

  it("falls back to the absolute text past the threshold", async () => {
    await start(
      "2026-06-06T10:00:00Z", // 2 hours ago
      'data-stimeo--relative-time-threshold-value="3600"', // 1 hour
      "2026-06-06 10:00",
    );
    expect(el().textContent).toBe("2026-06-06 10:00");
    expect(el().getAttribute("data-state")).toBe("absolute");
  });

  it("does not mistake preserved relative text for the absolute fallback after a morph", async () => {
    // Simulate a Turbo morph re-connect: the live text is already the relative
    // form and `data-state="relative"` is present. The fresh controller must not
    // capture "3 minutes ago" as the absolute fallback, and past the threshold it
    // must keep rendering the relative form rather than blanking the element.
    document.body.innerHTML = `
      <time data-controller="stimeo--relative-time"
            datetime="2026-06-06T10:00:00Z"
            data-stimeo--relative-time-threshold-value="3600"
            data-state="relative">3 minutes ago</time>`;
    application = Application.start();
    application.register("stimeo--relative-time", RelativeTimeController);
    await vi.advanceTimersByTimeAsync(0);

    // 2 hours ago is past the 1h threshold, but there is no recoverable absolute
    // text, so it stays relative (never blank, never the stale relative string).
    expect(el().textContent).toBe("2 hours ago");
    expect(el().getAttribute("data-state")).toBe("relative");
  });

  it("does nothing without a valid datetime", async () => {
    await start("not-a-date", "", "fallback");
    expect(el().textContent).toBe("fallback");
    expect(el().hasAttribute("data-state")).toBe(false);
  });

  it("stops updating after disconnect", async () => {
    await start("2026-06-06T11:59:10Z");
    const node = el();
    const controller = application.getControllerForElementAndIdentifier(
      node,
      "stimeo--relative-time",
    ) as RelativeTimeController;
    // Invoke disconnect() directly for a deterministic teardown (no reliance on
    // the async MutationObserver flush, which was environment-sensitive).
    controller.disconnect();
    vi.advanceTimersByTime(120_000);
    // The polling timer was cleared, so the text stays at its last value.
    expect(node.textContent).toBe("50 seconds ago");
  });
});

/** Layer ① (axe) runs under real timers, independent of the polling behavior. */
describe("RelativeTimeController accessibility", () => {
  let application: Application;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  it("has no machine-detectable a11y violations", async () => {
    document.body.innerHTML = `
      <main>
        <p>Posted
          <time data-controller="stimeo--relative-time"
                datetime="2026-06-06T11:57:00Z">2026-06-06 11:57</time>
        </p>
      </main>`;
    application = Application.start();
    application.register("stimeo--relative-time", RelativeTimeController);
    await tick();
    await expectNoA11yViolations(document.body);
  });

  // Layer ③ — the rendered relative phrase is what a reader announces for the
  // <time> element. A real-clock datetime keeps the assertion stable.
  it("announces the rendered relative phrase", async () => {
    const threeMinutesAgo = new Date(Date.now() - 180_000).toISOString();
    document.body.innerHTML = `
      <main>
        <p>Posted
          <time data-controller="stimeo--relative-time" lang="en"
                datetime="${threeMinutesAgo}">absolute</time>
        </p>
      </main>`;
    application = Application.start();
    application.register("stimeo--relative-time", RelativeTimeController);
    await tick();

    const node = query("[data-controller='stimeo--relative-time']");
    expect(node.textContent).toBe("3 minutes ago");
    const spoken = await captureSpeech({ container: node, steps: 1 });
    // Freeze the whole ordered array (not a name-only `toContain`): the rendered
    // relative phrase is what the AT announces for the time element.
    expect(spoken).toEqual(["time", "3 minutes ago"]);
  });
});
