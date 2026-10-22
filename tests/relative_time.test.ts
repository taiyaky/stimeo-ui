import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelativeTimeController } from "../src/controllers/relative_time_controller";
import { MorphRenderWatcher } from "../src/utils/morph_render_watcher";
import { MAX_TIMER_DELAY_MS, SafeTimeout } from "../src/utils/safe_timeout";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { withRuntimeTimeZone } from "./helpers/runtime_time_zone";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link RelativeTimeController}, driven by a mocked clock:
 * relative formatting (past/future), locale selection, adaptive updates, the
 * threshold fallback to absolute text, timer teardown on disconnect, and the fallback
 * across Turbo's cache.
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

  it("repaints without rewriting its unchanged absolute-text record", async () => {
    await start("2026-06-06T11:57:00Z");
    const marker = "data-stimeo--relative-time-text";
    const record = el().getAttribute(marker);
    expect(record).toBe('"absolute"');
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(el(), { attributes: true, attributeFilter: [marker] });
    try {
      // The same-value DOM assignment is the positive control for this observer.
      el().setAttribute(marker, record ?? "");
      expect(observer.takeRecords()).toHaveLength(1);
      instance().localeValueChanged();
      await vi.advanceTimersByTimeAsync(0);
      records.push(...observer.takeRecords());
      expect(records).toHaveLength(0);
      expect(el().getAttribute(marker)).toBe(record);
    } finally {
      observer.disconnect();
    }
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

  it.each([
    ["integer boundary", NOW.getTime(), 3_600_000, 3600],
    ["fractional boundary", NOW.getTime(), 258_795, 258.795],
    ["distant boundary", -337_437_817_115_933, 8_977_437_817_115_933, 8_977_437_817_115.934],
  ] as const)(
    "requests a positive derived timeout at the %s",
    async (_name, now, delta, threshold) => {
      vi.setSystemTime(now);
      const original = SafeTimeout.prototype.set;
      /** Keeps an invalid zero request from spinning the fake clock; the spy records it unchanged. */
      const schedule = vi.spyOn(SafeTimeout.prototype, "set").mockImplementation(function (
        this: SafeTimeout,
        callback: () => void,
        delay: number,
      ) {
        return original.call(this, callback, Math.max(1, delay));
      });
      try {
        await start(
          new Date(now + delta).toISOString(),
          `data-stimeo--relative-time-threshold-value="${threshold}"`,
        );
        expect(el().getAttribute("data-state")).toBe("absolute");
        expect(schedule.mock.calls.length).toBeGreaterThan(0);
        for (const [, delay] of schedule.mock.calls) expect(delay).toBe(1);

        vi.advanceTimersByTime(2);
        expect(el().getAttribute("data-state")).toBe("relative");
        for (const [, delay] of schedule.mock.calls) {
          expect(delay).toBeGreaterThanOrEqual(1);
          expect(delay).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
        }
        instance().disconnect();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        schedule.mockRestore();
      }
    },
  );

  it.each([
    ["huge threshold", Number.MAX_VALUE, "relative"],
    ["distant future", 3600, "absolute"],
  ] as const)("keeps the derived poll bounded for a %s", async (_name, threshold, state) => {
    const schedule = vi.spyOn(SafeTimeout.prototype, "set");
    try {
      await start(
        "+275760-09-13T00:00:00.000Z",
        `data-stimeo--relative-time-threshold-value="${threshold}" data-stimeo--relative-time-tick-interval-value="${MAX_TIMER_DELAY_MS}"`,
      );
      expect(el().getAttribute("data-state")).toBe(state);
      expect(schedule.mock.calls.length).toBeGreaterThan(0);
      for (const [, delay] of schedule.mock.calls) expect(delay).toBe(MAX_TIMER_DELAY_MS);
      vi.advanceTimersByTime(MAX_TIMER_DELAY_MS);
      expect(el().getAttribute("data-state")).toBe(state);
      for (const [, delay] of schedule.mock.calls) expect(delay).toBe(MAX_TIMER_DELAY_MS);
      instance().disconnect();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      schedule.mockRestore();
    }
  });

  it("keeps the relative reading through turbo:before-cache", async () => {
    await start(
      "2026-06-06T11:57:00Z", // 3 minutes ago
      'data-stimeo--relative-time-threshold-value="600"', // 10 minutes
      "2026-06-06 11:57",
    );
    // Turbo dispatches it on pages that stay as well, where the reading must stay current.
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(el().textContent).toBe("3 minutes ago");
    expect(el().getAttribute("data-state")).toBe("relative");
    vi.advanceTimersByTime(60_000);
    expect(el().textContent).toBe("4 minutes ago");
  });

  it("records the authored text while it shows the relative form", async () => {
    await start(
      "2026-06-06T11:57:00Z",
      'data-stimeo--relative-time-threshold-value="600"',
      "2026-06-06 11:57",
    );
    expect(el().getAttribute("data-stimeo--relative-time-text")).toBe('"2026-06-06 11:57"');

    vi.advanceTimersByTime(8 * 60_000); // past the threshold: the authored text is on display
    expect(el().getAttribute("data-state")).toBe("absolute");
    expect(el().hasAttribute("data-stimeo--relative-time-text")).toBe(false);
  });

  it("keeps the threshold contract after a cached page is restored", async () => {
    await start(
      "2026-06-06T11:57:00Z",
      'data-stimeo--relative-time-threshold-value="600"',
      "2026-06-06 11:57",
    );
    expect(el().textContent).toBe("3 minutes ago");
    const snapshot = document.body.innerHTML;
    document.body.innerHTML = "";
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(8 * 60_000); // away long enough to age past the threshold
    document.body.innerHTML = snapshot;
    await vi.advanceTimersByTimeAsync(0);
    // The restored element shows the relative form and records the authored text, so the
    // reconnected controller has a fallback to switch to — the stamp is 11 minutes old
    // against a 10 minute threshold.
    expect(el().getAttribute("data-state")).toBe("absolute");
    expect(el().textContent).toBe("2026-06-06 11:57");
  });

  it("takes no fallback from a record that is not a JSON string", async () => {
    for (const record of ["{", "5"]) {
      document.body.innerHTML = `
        <time data-controller="stimeo--relative-time" datetime="2026-06-06T11:49:00Z"
              data-stimeo--relative-time-threshold-value="600" data-state="relative"
              data-stimeo--relative-time-text='${record}'>3 minutes ago</time>`;
      application = Application.start();
      application.register("stimeo--relative-time", RelativeTimeController);
      await vi.advanceTimersByTimeAsync(0);

      // 11 minutes old against a 10 minute threshold, and no authored text to fall back to.
      expect(el().textContent).toBe("11 minutes ago");
      disconnectAndStopApplication(application);
    }
  });

  it("keeps rendering relatively on a restored page with no authored text to fall back to", async () => {
    await start("2026-06-06T11:57:00Z", 'data-stimeo--relative-time-threshold-value="600"', "   ");
    expect(el().textContent).toBe("3 minutes ago");
    const snapshot = document.body.innerHTML;
    document.body.innerHTML = "";
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(8 * 60_000);
    document.body.innerHTML = snapshot;
    await vi.advanceTimersByTimeAsync(0);
    // The rendered text is never taken for the fallback: with none recorded, the
    // element keeps the relative form instead of blanking or freezing.
    expect(el().textContent).toBe("11 minutes ago");
    expect(el().getAttribute("data-state")).toBe("relative");
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

  it("drops the pending poll when a Value swap re-arms it", async () => {
    await start("2026-06-06T11:57:00Z"); // 3 minutes ago, polled every minute
    vi.advanceTimersByTime(30_000);
    el().setAttribute("data-stimeo--relative-time-threshold-value", "3600");
    await vi.advanceTimersByTimeAsync(0);
    expect(el().textContent).toBe("3 minutes ago");
    // The swap re-armed the poll a minute from now; the one it replaced would have
    // re-rendered thirty seconds from now.
    vi.advanceTimersByTime(40_000);
    expect(el().textContent).toBe("3 minutes ago");
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

  it.each(["UTC", "Asia/Tokyo", "America/New_York"])(
    "reads timezone-less datetimes as UTC in %s",
    async (zone) => {
      await withRuntimeTimeZone(zone, async () => {
        expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
        const raw = "2026-06-06T11:57:00";
        const native = Date.parse(raw);
        const expected = Date.UTC(2026, 5, 6, 11, 57);
        if (zone === "UTC") expect(native).toBe(expected);
        else expect(native).not.toBe(expected);
        await start(raw);
        expect(el().textContent).toBe("3 minutes ago");
        expect(el().getAttribute("datetime")).toBe(raw);
      });
    },
  );

  it.each([
    "2026-06-06 11:57",
    "2026-06-06 11:57:00Z",
    "2026-06-06T20:57:00+09:00",
    "2026-06-06 20:57:00+0900",
    "2026-06-06T07:57:00-04:00",
    "2026-06-06 07:57:00-0400",
    " \t2026-06-06T11:57:00Z\n ",
  ])("reads the same instant from %j without changing its attribute", async (raw) => {
    await withRuntimeTimeZone("America/New_York", async () => {
      await start(raw);
      expect(el().textContent).toBe("3 minutes ago");
      expect(el().getAttribute("datetime")).toBe(raw);
      expect(vi.getTimerCount()).toBe(1);
    });
  });

  it.each([
    "2026-02-30T11:57:00Z",
    "2026",
    "2026-06",
    "Sat, 06 Jun 2026 11:57:00 GMT",
    "2026-06-06 11:57:00 UTC",
    "2026-06-06  11:57:00Z",
    "2026-06-06t11:57:00z",
    "2026-06-06T24:00:00.0001Z",
  ])("keeps authored text and stays inert for %j", async (raw) => {
    await start(raw, 'title="server title"', "server fallback");
    expect(el().textContent).toBe("server fallback");
    expect(el().getAttribute("title")).toBe("server title");
    expect(el().getAttribute("datetime")).toBe(raw);
    expect(el().hasAttribute("data-state")).toBe(false);
    expect(el().hasAttribute("data-stimeo--relative-time-text")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("follows a live datetime change and retains only one poll", async () => {
    await start("2026-06-06T11:57:00Z");
    vi.advanceTimersByTime(30_000);
    el().setAttribute("datetime", "2026-06-06T12:03:30");
    await vi.advanceTimersByTimeAsync(0);
    expect(el().textContent).toBe("in 3 minutes");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(40_000);
    expect(el().textContent).toBe("in 3 minutes");
    vi.advanceTimersByTime(20_000);
    expect(el().textContent).toBe("in 2 minutes");
  });

  it("stops an invalidated poll and resumes from the preserved fallback", async () => {
    await start(
      "2026-06-06T11:57:00Z",
      'data-stimeo--relative-time-threshold-value="600" title="authored title"',
      "authored absolute",
    );
    const marker = "data-stimeo--relative-time-text";
    expect(el().getAttribute(marker)).toBe('"authored absolute"');
    el().setAttribute("datetime", "not-a-date");
    el().textContent = "server fallback";
    await vi.advanceTimersByTimeAsync(0);
    expect(el().textContent).toBe("server fallback");
    expect(vi.getTimerCount()).toBe(0);
    expect(el().getAttribute(marker)).toBe('"authored absolute"');
    expect(el().title).toBe("authored title");
    vi.advanceTimersByTime(180_000);
    expect(el().textContent).toBe("server fallback");
    el().setAttribute("datetime", "2026-06-06T12:06:00Z");
    await vi.advanceTimersByTimeAsync(0);
    expect(el().textContent).toBe("in 3 minutes");
    expect(vi.getTimerCount()).toBe(1);
    expect(el().getAttribute(marker)).toBe('"authored absolute"');
    el().setAttribute("datetime", "2026-06-06T11:00:00Z");
    await vi.advanceTimersByTimeAsync(0);
    expect(el().textContent).toBe("authored absolute");
    expect(el().getAttribute("data-state")).toBe("absolute");
    expect(el().hasAttribute(marker)).toBe(false);
    expect(el().title).toBe("authored title");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts from an initially invalid datetime once the live input becomes valid", async () => {
    await start("not-a-date", "", "authored absolute");
    el().setAttribute("datetime", "2026-06-06 11:57:00");
    await vi.advanceTimersByTimeAsync(0);
    expect(el().textContent).toBe("3 minutes ago");
    expect(el().getAttribute("data-stimeo--relative-time-text")).toBe('"authored absolute"');
    expect(vi.getTimerCount()).toBe(1);
  });

  it("restarts a terminal past fallback when the live instant changes", async () => {
    await start(
      "2026-06-06T11:00:00Z",
      'data-stimeo--relative-time-threshold-value="600"',
      "authored",
    );
    expect(el().textContent).toBe("authored");
    expect(vi.getTimerCount()).toBe(0);
    el().setAttribute("datetime", "2026-06-06T12:03:00Z");
    await vi.advanceTimersByTimeAsync(0);
    expect(el().textContent).toBe("in 3 minutes");
    expect(vi.getTimerCount()).toBe(1);
  });

  /** A retained-element morph brings server attributes and text, without this controller's hooks. */
  const morphTo = async (datetime: string, text: string): Promise<void> => {
    el().setAttribute("datetime", datetime);
    el().removeAttribute("data-state");
    el().removeAttribute("data-stimeo--relative-time-text");
    el().textContent = text;
    el().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
  };

  it("falls back to the text a morph brings with a new instant past the threshold", async () => {
    await start(
      "2026-06-06T11:57:00Z",
      'data-stimeo--relative-time-threshold-value="600"',
      "June 6 11:57",
    );
    expect(el().textContent).toBe("3 minutes ago");
    await morphTo("2026-06-05T08:00:00Z", "June 5 08:00");
    expect(el().textContent).toBe("June 5 08:00");
    expect(el().getAttribute("data-state")).toBe("absolute");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("records the text a morph brings with a new instant until it passes the threshold", async () => {
    await start(
      "2026-06-06T11:57:00Z",
      'data-stimeo--relative-time-threshold-value="600"',
      "June 6 11:57",
    );
    await morphTo("2026-06-06T12:03:00Z", "June 6 12:03");
    expect(el().textContent).toBe("in 3 minutes");
    expect(el().getAttribute("data-stimeo--relative-time-text")).toBe('"June 6 12:03"');
    vi.advanceTimersByTime(14 * 60_000);
    expect(el().textContent).toBe("June 6 12:03");
    expect(el().getAttribute("data-state")).toBe("absolute");
  });

  it("keeps the poll deadline for an equivalent datetime and a repair-only morph", async () => {
    await start("2026-06-06T11:57:00Z");
    vi.advanceTimersByTime(30_000);
    el().setAttribute("datetime", "2026-06-06 20:57:00+0900");
    el().textContent = "server output";
    el().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(el().textContent).toBe("3 minutes ago");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(el().textContent).toBe("4 minutes ago");
  });

  it("coalesces datetime, Values, and morph into one render", async () => {
    await start("2026-06-06T11:57:00Z");
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(el(), { childList: true });
    el().setAttribute("datetime", "2026-06-06T12:03:00Z");
    el().setAttribute("data-stimeo--relative-time-locale-value", "ja");
    el().setAttribute("data-stimeo--relative-time-threshold-value", "600");
    el().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    records.push(...observer.takeRecords());
    observer.disconnect();
    expect(records.filter((record) => record.addedNodes.length > 0)).toHaveLength(1);
    expect(el().textContent).toBe(
      new Intl.RelativeTimeFormat("ja", { numeric: "auto" }).format(3, "minute"),
    );
    expect(vi.getTimerCount()).toBe(1);
  });

  it("releases the datetime observer synchronously on disconnect", async () => {
    await start("2026-06-06T11:57:00Z");
    const scheduled = vi.spyOn(MorphRenderWatcher.prototype, "schedule");
    try {
      el().setAttribute("datetime", "2026-06-06T12:03Z");
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduled).toHaveBeenCalledTimes(1);
      scheduled.mockClear();
      instance().disconnect();
      el().setAttribute("datetime", "2026-06-06T12:05Z");
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduled).not.toHaveBeenCalled();
    } finally {
      scheduled.mockRestore();
    }
  });

  it("drops pending datetime observation on disconnect and rereads on reconnect", async () => {
    await start("2026-06-06T11:57:00Z");
    const controller = instance();
    /** Observe callback entry before the disconnected render guard can ignore it. */
    const scheduled = vi.spyOn(MorphRenderWatcher.prototype, "schedule");
    try {
      el().setAttribute("datetime", "2026-06-06T11:58:00");
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduled).toHaveBeenCalledTimes(1);
      expect(el().textContent).toBe("2 minutes ago");
      scheduled.mockClear();

      el().setAttribute("datetime", "2026-06-06T12:03:00");
      controller.disconnect();
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduled).not.toHaveBeenCalled();
      expect(el().textContent).toBe("2 minutes ago");
      expect(vi.getTimerCount()).toBe(0);

      el().setAttribute("datetime", "2026-06-06T12:05:00");
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduled).not.toHaveBeenCalled();
      expect(el().textContent).toBe("2 minutes ago");
      expect(vi.getTimerCount()).toBe(0);

      controller.connect();
      expect(el().textContent).toBe("in 5 minutes");
      expect(vi.getTimerCount()).toBe(1);
      el().setAttribute("datetime", "2026-06-06T12:07:00");
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduled).toHaveBeenCalledTimes(1);
      expect(el().textContent).toBe("in 7 minutes");
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      scheduled.mockRestore();
    }
  });

  it("reconnects directly without retaining duplicate or invalidated polls", async () => {
    await start("2026-06-06T11:57:00Z");
    instance().connect();
    expect(vi.getTimerCount()).toBe(1);
    el().setAttribute("datetime", "not-a-date");
    instance().connect();
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
    // Invoke disconnect() directly for a deterministic teardown, with no reliance on
    // the async MutationObserver flush.
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

  // Cursor navigation reads the current phrase without an update live region.
  it("exposes the current relative phrase to cursor navigation", async () => {
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
    // Freeze the entire role and text sequence for cursor navigation.
    expect(spoken).toEqual(["time", "3 minutes ago"]);
    expect(
      document.querySelector("[aria-live], [role='alert'], [role='status'], [role='log']"),
    ).toBeNull();
  });
});
