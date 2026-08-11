import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelativeTimeController } from "../src/controllers/relative_time_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

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
    disconnectAndStopApplication(application);
    vi.useRealTimers();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("lang");
  });

  const el = () => query("[data-controller='stimeo--relative-time']");

  const instance = () =>
    application.getControllerForElementAndIdentifier(
      el(),
      "stimeo--relative-time",
    ) as RelativeTimeController;

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
    // `lang="en"` on the element makes this pin the *precedence* too: the value
    // outranks the element's own language, not just the document's.
    await start("2026-06-06T11:57:00Z", 'lang="en" data-stimeo--relative-time-locale-value="ja"');
    expect(el().textContent).toContain("分");
  });

  it("falls back to the document's lang when nothing closer sets one", async () => {
    document.documentElement.lang = "ja";
    await start("2026-06-06T11:57:00Z");
    expect(el().textContent).toContain("分");
  });

  it("falls back to the element's lang before the document's", async () => {
    // `document.documentElement.lang` is "en" here, so a Japanese phrase can only
    // come from the element's own `lang`.
    await start("2026-06-06T11:57:00Z", 'lang="ja"');
    expect(el().textContent).toContain("分");
  });

  it("updates as time passes", async () => {
    await start("2026-06-06T11:59:10Z"); // 50 seconds ago
    expect(el().textContent).toBe("50 seconds ago");
    vi.advanceTimersByTime(60_000); // a minute later -> 110 s ago
    expect(el().textContent).toBe("2 minutes ago");
  });

  it("widens the poll interval for coarser units", async () => {
    await start("2026-06-06T10:31:00Z"); // 89 minutes ago -> the hour scale
    expect(el().textContent).toBe("1 hour ago");
    // The stamp turns two hours old, but the hourly poll has not come round yet.
    vi.advanceTimersByTime(31 * 60_000);
    expect(el().textContent).toBe("1 hour ago");
    vi.advanceTimersByTime(29 * 60_000); // an hour after connect: the poll fires
    expect(el().textContent).toBe("2 hours ago");
  });

  it("caps the poll interval at one day for the coarse units", async () => {
    // ~45 days old: the month scale would otherwise ask for a 30-day timeout,
    // which overflows the platform's 32-bit delay and fires immediately.
    await start(new Date(NOW.getTime() - 3_900_000_000).toISOString());
    expect(el().textContent).toBe("last month");
    vi.advanceTimersByTime(86_400_000);
    expect(el().textContent).toBe("2 months ago");
  });

  it("keeps the one-minute floor below the seconds scale even with a smaller tickInterval", async () => {
    await start("2026-06-06T11:59:50Z", 'data-stimeo--relative-time-tick-interval-value="1000"');
    expect(el().textContent).toBe("10 seconds ago");
    // `tickInterval` is a floor, not a cadence: seconds are never re-rendered
    // sub-minute, so a one-second setting cannot make the text churn.
    vi.advanceTimersByTime(5000);
    expect(el().textContent).toBe("10 seconds ago");
    vi.advanceTimersByTime(55_000);
    expect(el().textContent).toBe("1 minute ago");
  });

  it("stretches the poll interval when tickInterval is coarser than the unit", async () => {
    await start("2026-06-06T11:59:50Z", 'data-stimeo--relative-time-tick-interval-value="300000"');
    expect(el().textContent).toBe("10 seconds ago");
    vi.advanceTimersByTime(60_000); // the unit floor alone would have re-rendered
    expect(el().textContent).toBe("10 seconds ago");
    vi.advanceTimersByTime(240_000);
    expect(el().textContent).toBe("5 minutes ago");
  });

  it("falls back to the absolute text past the threshold", async () => {
    await start(
      "2026-06-06T10:00:00Z", // 2 hours ago
      'data-stimeo--relative-time-threshold-value="3600"', // 1 hour
      "2026-06-06 10:00",
    );
    expect(el().textContent).toBe("2026-06-06 10:00");
    expect(el().getAttribute("data-state")).toBe("absolute");
    // A past stamp can only age further, so the fallback is terminal: no timer is
    // left pending and a day of wall clock leaves the text alone.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(24 * 3_600_000);
    expect(el().textContent).toBe("2026-06-06 10:00");
  });

  it("returns to the relative form when a future timestamp comes within the threshold", async () => {
    await start(
      "2026-06-06T14:00:00Z", // 2 hours out
      'data-stimeo--relative-time-threshold-value="3600"', // 1 hour
      "2026-06-06 14:00",
    );
    expect(el().textContent).toBe("2026-06-06 14:00");
    expect(el().getAttribute("data-state")).toBe("absolute");

    // The gap shrinks below the threshold, so the fallback is no longer the
    // correct representation: a future stamp must go back to the relative form.
    // The poll that leaves the fallback lands a millisecond past the crossing, so
    // every later one sits on that same offset — hence the `+ 1` on the wait.
    vi.advanceTimersByTime(90 * 60_000 + 1);
    expect(el().getAttribute("data-state")).toBe("relative");
    expect(el().textContent).toBe("in 30 minutes");
  });

  it("leaves the fallback the moment the gap stops exceeding the threshold", async () => {
    await start(
      "2026-06-06T14:00:00Z", // 2 hours out
      'data-stimeo--relative-time-threshold-value="3600"', // 1 hour
      "2026-06-06 14:00",
    );
    vi.advanceTimersByTime(3_600_000);
    // A gap of exactly the threshold has not gone under it, so the fallback stands.
    expect(el().getAttribute("data-state")).toBe("absolute");
    vi.advanceTimersByTime(1);
    // One millisecond inside it has, and the poll cadence — a minute at its finest —
    // is no reason to keep claiming a threshold that is no longer exceeded.
    expect(el().getAttribute("data-state")).toBe("relative");
    expect(el().textContent).toBe("in 60 minutes");
  });

  it("puts the authored absolute text back for the Turbo snapshot", async () => {
    await start(
      "2026-06-06T11:57:00Z", // 3 minutes ago
      'data-stimeo--relative-time-threshold-value="600"', // 10 minutes
      "2026-06-06 11:57",
    );
    expect(el().textContent).toBe("3 minutes ago");
    // Turbo takes its snapshot from this event, so this is the last moment a write
    // reaches the DOM the Back button restores.
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(el().textContent).toBe("2026-06-06 11:57");
    expect(el().hasAttribute("data-state")).toBe(false);
  });

  it("keeps the threshold contract after a cached page is restored", async () => {
    await start(
      "2026-06-06T11:57:00Z",
      'data-stimeo--relative-time-threshold-value="600"',
      "2026-06-06 11:57",
    );
    document.dispatchEvent(new Event("turbo:before-cache"));
    const snapshot = document.body.innerHTML;
    document.body.innerHTML = "";
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(8 * 60_000); // away long enough to age past the threshold
    document.body.innerHTML = snapshot;
    await vi.advanceTimersByTimeAsync(0);
    // The restored element carries the authored text, so the reconnected controller
    // has a fallback to switch to — the stamp is 11 minutes old against a 10 minute
    // threshold and the element is the only place that text could come from.
    expect(el().getAttribute("data-state")).toBe("absolute");
    expect(el().textContent).toBe("2026-06-06 11:57");
  });

  it("keeps the live page polling after the snapshot rewind", async () => {
    await start(
      "2026-06-06T11:57:00Z",
      'data-stimeo--relative-time-threshold-value="600"',
      "2026-06-06 11:57",
    );
    document.dispatchEvent(new Event("turbo:before-cache"));
    vi.advanceTimersByTime(60_000);
    // A page being cached is not a torn-down one: a navigation that never completes
    // has to find the reading advancing again.
    expect(el().textContent).toBe("4 minutes ago");
    expect(el().getAttribute("data-state")).toBe("relative");
  });

  it("leaves the relative marker in place when no authored text was captured", async () => {
    await start("2026-06-06T11:57:00Z", 'data-stimeo--relative-time-threshold-value="600"', "   ");
    expect(el().textContent).toBe("3 minutes ago");
    document.dispatchEvent(new Event("turbo:before-cache"));
    // There is nothing to restore, and the rendered text must not be cached as an
    // absolute fallback: the marker is what a reconnect reads to tell the two apart.
    expect(el().textContent).toBe("3 minutes ago");
    expect(el().getAttribute("data-state")).toBe("relative");
  });

  it("stops rewinding once disconnected", async () => {
    await start(
      "2026-06-06T11:57:00Z",
      'data-stimeo--relative-time-threshold-value="600"',
      "2026-06-06 11:57",
    );
    const node = el();
    instance().disconnect();
    document.dispatchEvent(new Event("turbo:before-cache"));
    // The subscription is symmetric with `connect()`, so a torn-down controller no
    // longer writes into a tree it does not own.
    expect(node.textContent).toBe("3 minutes ago");
  });

  it("follows a locale swapped in place by a morph", async () => {
    await start("2026-06-06T11:57:00Z");
    expect(el().textContent).toBe("3 minutes ago");
    // A Turbo morph keeps the element and swaps the attribute, so `connect()` never
    // runs again: without following the Value the reading stays in the old language
    // for the rest of the session.
    el().setAttribute("data-stimeo--relative-time-locale-value", "ja");
    await vi.advanceTimersByTimeAsync(0);
    expect(el().textContent).toContain("分");
  });

  it("follows a threshold swapped in place by a morph", async () => {
    await start(
      "2026-06-06T11:49:00Z", // 11 minutes ago
      'data-stimeo--relative-time-threshold-value="600"', // 10 minutes
      "2026-06-06 11:49",
    );
    expect(el().getAttribute("data-state")).toBe("absolute");
    // The past fallback is terminal, so nothing is left to notice the swap on its own.
    expect(vi.getTimerCount()).toBe(0);
    el().setAttribute("data-stimeo--relative-time-threshold-value", "0");
    await vi.advanceTimersByTimeAsync(0);
    expect(el().getAttribute("data-state")).toBe("relative");
    expect(el().textContent).toBe("11 minutes ago");
  });

  it("follows a tickInterval swapped in place by a morph", async () => {
    await start("2026-06-06T11:59:50Z", 'data-stimeo--relative-time-tick-interval-value="600000"');
    expect(el().textContent).toBe("10 seconds ago");
    el().setAttribute("data-stimeo--relative-time-tick-interval-value", "60000");
    await vi.advanceTimersByTimeAsync(0);
    // The new cadence is armed from the swap, not from the pending ten-minute poll.
    vi.advanceTimersByTime(60_000);
    expect(el().textContent).toBe("1 minute ago");
  });

  it("repaints once when a morph swaps two render inputs together", async () => {
    await start("2026-06-06T11:57:00Z", 'data-stimeo--relative-time-threshold-value="600"', "x");
    // Each render writes one text node into the element, so the additions count them.
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(el(), { childList: true });
    // A morph applies the whole batch before anything reads it, so the two swaps are
    // one repaint — not one per Value.
    el().setAttribute("data-stimeo--relative-time-locale-value", "ja");
    el().setAttribute("data-stimeo--relative-time-threshold-value", "1200");
    await vi.advanceTimersByTimeAsync(0);
    mutations.push(...observer.takeRecords());
    observer.disconnect();
    expect(mutations.filter((record) => record.addedNodes.length > 0)).toHaveLength(1);
    expect(el().textContent).toContain("分");
  });

  it("keeps the authored text when the locale cannot be used", async () => {
    // A malformed `lang` is a consumer typo, not a reason to leave the element in a
    // state nothing can advance: `Intl` rejects it, so the authored text stands.
    await start("2026-06-06T11:57:00Z", 'lang="ja_JP"', "2026-06-06 11:57");
    expect(el().textContent).toBe("2026-06-06 11:57");
    expect(el().hasAttribute("data-state")).toBe(false);
    el().setAttribute("data-stimeo--relative-time-locale-value", "ja");
    await vi.advanceTimersByTimeAsync(0);
    // A corrected locale renders on the next pass.
    expect(el().textContent).toContain("分");
  });

  it("still falls back past the threshold when the locale cannot be used", async () => {
    await start(
      "2026-06-06T10:00:00Z", // 2 hours ago
      'lang="ja_JP" data-stimeo--relative-time-threshold-value="3600"',
      "2026-06-06 10:00",
    );
    // The fallback writes the authored text, so it needs no formatter to work.
    expect(el().getAttribute("data-state")).toBe("absolute");
    expect(el().textContent).toBe("2026-06-06 10:00");
  });

  it("resolves the locale from the nearest ancestor lang", async () => {
    // `lang` is an inherited attribute in HTML, so a wrapper states the language of
    // the text inside it. `document.documentElement.lang` is "en" here, so a Japanese
    // phrase can only come from the wrapper.
    document.body.innerHTML = `
      <div lang="ja">
        <time data-controller="stimeo--relative-time" datetime="2026-06-06T11:57:00Z">absolute</time>
      </div>`;
    application = Application.start();
    application.register("stimeo--relative-time", RelativeTimeController);
    await vi.advanceTimersByTimeAsync(0);
    expect(el().textContent).toContain("分");
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

  it("treats whitespace-only authored text as no absolute fallback at all", async () => {
    // A server-rendered slot that ended up blank must not become the fallback:
    // switching to it would leave the element visually empty.
    await start("2026-06-06T10:00:00Z", 'data-stimeo--relative-time-threshold-value="3600"', "   ");
    expect(el().textContent).toBe("2 hours ago");
    expect(el().getAttribute("data-state")).toBe("relative");
  });

  it("stays inert when a morph swaps a Value on an unparsable datetime", async () => {
    await start("not-a-date", 'data-stimeo--relative-time-threshold-value="600"', "fallback");
    el().setAttribute("data-stimeo--relative-time-locale-value", "ja");
    await vi.advanceTimersByTimeAsync(0);
    // No instant was parsed, so there is no reading to repaint: the authored text
    // stands, no state is claimed, and the repaint must not reach the formatter with
    // a `NaN` amount — `Intl` rejects those.
    expect(el().textContent).toBe("fallback");
    expect(el().hasAttribute("data-state")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
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
    // the async MutationObserver flush, whose timing varies by environment).
    controller.disconnect();
    vi.advanceTimersByTime(120_000);
    // The polling timer was cleared, so the text stays at its last value.
    expect(node.textContent).toBe("50 seconds ago");
  });
});

/** The axe audit runs under real timers, independent of the polling behavior. */
describe("RelativeTimeController accessibility", () => {
  let application: Application;

  afterEach(() => {
    disconnectAndStopApplication(application);
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

  // The rendered relative phrase is what a reader announces for the <time>
  // element. A real-clock datetime keeps the assertion stable.
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
