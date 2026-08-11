import process from "node:process";
import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { LocalTimeController } from "../src/controllers/local_time_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link LocalTimeController}: UTC→locale/zone formatting,
 * timezone conversion, locale/timeZone overrides, date-only output, the optional
 * title, `datetime` preservation, graceful fallbacks, and the format event.
 *
 * Display output is asserted against a reference `Intl.DateTimeFormat` built with
 * the same options, so the tests verify the controller wires the options through
 * without pinning brittle, ICU-version-specific strings.
 */

/** The fixed UTC instant under test (12:30 UTC on 2026-06-08). */
const ISO = "2026-06-08T12:30:00Z";

/** A second UTC instant, for the cases that swap `datetime` on a live element. */
const SWAPPED_ISO = "2020-01-01T00:00:00Z";

/** Reference format for an arbitrary instant — mirrors the controller. */
const refFor = (
  iso: string,
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): string => new Intl.DateTimeFormat(locale, options).format(new Date(iso));

/** Reference format for `ISO` under the given options — mirrors the controller. */
const ref = (locale: string | undefined, options: Intl.DateTimeFormatOptions): string =>
  refFor(ISO, locale, options);

/**
 * Runs `body` with the runtime's own timezone moved off UTC, then puts it back.
 *
 * The suite runs in UTC, where "read as UTC" and "read in the runtime's local
 * zone" resolve to the *same* instant — so any assertion about that distinction
 * is unfalsifiable until the runtime zone actually differs.
 *
 * Restoring assigns the previous value back rather than deleting the variable:
 * assignment is what makes the runtime re-read its zone, while after a `delete`
 * the zone stays frozen at the moved value and every later assignment is ignored
 * — which would silently leave the following cases in the wrong zone. What goes
 * back is the raw `TZ` when there was one, since the resolved zone can carry a
 * different name than the value that produced it, and otherwise the zone the
 * runtime resolved on entry.
 */
const withRuntimeTimeZone = async (timeZone: string, body: () => Promise<void>): Promise<void> => {
  const previous = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = timeZone;
  try {
    await body();
  } finally {
    process.env.TZ = previous;
  }
};

describe("withRuntimeTimeZone", () => {
  it("moves the runtime zone and puts it back", async () => {
    const before = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let inside = "";
    await withRuntimeTimeZone("America/New_York", async () => {
      inside = Intl.DateTimeFormat().resolvedOptions().timeZone;
    });
    // Both halves are load-bearing: the cases below observe a contract only while
    // the zone really moves, and the ones after them only while it really goes back.
    expect(inside).toBe("America/New_York");
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(before);
  });

  it("restores the TZ value it found, not the zone the runtime resolved from it", async () => {
    // The gap between the variable and the resolved zone is what makes "the raw value
    // comes back" observable at all, and a value no runtime can resolve keeps that gap
    // open on every ICU build: what `resolvedOptions()` reports is always a real zone,
    // so it never equals this string. (An alias such as `Asia/Calcutta` only opens the
    // gap where ICU canonicalizes it, which is not everywhere.) The runtime keeps the
    // zone it last resolved and honours the next valid value, so nothing is stranded.
    await withRuntimeTimeZone("Not/AZone", async () => {
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).not.toBe("Not/AZone");
      await withRuntimeTimeZone("America/New_York", async () => {});
      expect(process.env.TZ).toBe("Not/AZone");
    });
  });
});

describe("LocalTimeController", () => {
  let application: Application;

  const start = async (attrs = "", text = "2026-06-08 12:30 UTC", datetime = ISO) => {
    document.body.innerHTML = `<time data-controller="stimeo--local-time" datetime="${datetime}" ${attrs}>${text}</time>`;
    application = Application.start();
    application.register("stimeo--local-time", LocalTimeController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("lang");
  });

  const el = () => query("[data-controller='stimeo--local-time']");

  it("formats the UTC instant for the given locale and styles", async () => {
    await start(
      'data-stimeo--local-time-locale-value="en-US" ' +
        'data-stimeo--local-time-time-zone-value="UTC" ' +
        'data-stimeo--local-time-date-style-value="medium" ' +
        'data-stimeo--local-time-time-style-value="short"',
    );
    expect(el().textContent).toBe(
      ref("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }),
    );
  });

  it("converts the instant into the viewer's timezone (west of UTC)", async () => {
    // 12:30 UTC is 08:30 in New York (EDT, UTC-4) in June.
    await start(
      'data-stimeo--local-time-locale-value="en-US" ' +
        'data-stimeo--local-time-time-zone-value="America/New_York" ' +
        'data-stimeo--local-time-time-style-value="short"',
    );
    expect(el().textContent).toContain("8:30");
    expect(el().textContent).toContain("AM"); // morning in New York, pins the half-day
  });

  it("converts the instant into a timezone east of UTC", async () => {
    // 12:30 UTC is 21:30 in Tokyo (UTC+9) → "9:30 PM" in en-US short.
    await start(
      'data-stimeo--local-time-locale-value="en-US" ' +
        'data-stimeo--local-time-time-zone-value="Asia/Tokyo" ' +
        'data-stimeo--local-time-time-style-value="short"',
    );
    expect(el().textContent).toContain("9:30");
    expect(el().textContent).toContain("PM"); // evening in Tokyo, guards against a sign flip
  });

  it("reads a timezone-less datetime as UTC, not the runtime's local zone", async () => {
    // The runtime is moved to New York for this case: there, reading the bare
    // string locally would land on 16:30 UTC, four hours off the UTC reading.
    await withRuntimeTimeZone("America/New_York", async () => {
      await start(
        'data-stimeo--local-time-locale-value="en-US" ' +
          'data-stimeo--local-time-time-zone-value="UTC" ' +
          'data-stimeo--local-time-date-style-value="medium" ' +
          'data-stimeo--local-time-time-style-value="short"',
        "2026-06-08 12:30",
        "2026-06-08T12:30:00", // no Z / offset → must be read as UTC per the contract
      );
      // Same instant as the Z-suffixed form, so it formats identically to the UTC ref.
      expect(el().textContent).toBe(
        ref("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }),
      );
    });
  });

  it("uses the runtime timezone when no timeZone value is set", async () => {
    // The runtime is moved off UTC for this case as well: with both sides resolving
    // in UTC, a default that pinned the zone to UTC instead of leaving it to the
    // runtime would render the very same string.
    await withRuntimeTimeZone("America/New_York", async () => {
      await start('data-stimeo--local-time-locale-value="en-US"');
      // The reference passes no `timeZone` either, so both resolve in the runtime's
      // zone — pinning the empty default rather than a hard-coded zone.
      expect(el().textContent).toBe(ref("en-US", { dateStyle: "medium", timeStyle: "short" }));
      expect(el().textContent).toContain("8:30"); // 12:30 UTC in New York (EDT) in June
    });
  });

  it("reads a space-separated datetime as UTC too", async () => {
    // HTML allows a space where ISO 8601 wants `T`, and the input contract covers
    // both: the runtime is moved to New York so a local reading lands four hours off.
    await withRuntimeTimeZone("America/New_York", async () => {
      await start(
        'data-stimeo--local-time-locale-value="en-US" ' +
          'data-stimeo--local-time-time-zone-value="UTC" ' +
          'data-stimeo--local-time-date-style-value="medium" ' +
          'data-stimeo--local-time-time-style-value="short"',
        "2026-06-08 12:30",
        "2026-06-08 12:30",
      );
      expect(el().textContent).toBe(
        ref("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }),
      );
    });
  });

  it("keeps the offset of a space-separated datetime that carries one", async () => {
    // Only a value with no zone of its own is read as UTC; one that states an offset
    // keeps it, so the same instant comes out.
    await start(
      'data-stimeo--local-time-locale-value="en-US" ' +
        'data-stimeo--local-time-time-zone-value="UTC" ' +
        'data-stimeo--local-time-date-style-value="medium" ' +
        'data-stimeo--local-time-time-style-value="short"',
      "2026-06-08 21:30 +09:00",
      "2026-06-08 21:30:00+09:00",
    );
    expect(el().textContent).toBe(
      ref("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }),
    );
  });

  it("tolerates whitespace around the datetime attribute", async () => {
    await start(
      'data-stimeo--local-time-locale-value="en-US" ' +
        'data-stimeo--local-time-time-zone-value="UTC" ' +
        'data-stimeo--local-time-date-style-value="medium" ' +
        'data-stimeo--local-time-time-style-value="short"',
      "authored",
      `  ${ISO}  `,
    );
    expect(el().textContent).toBe(
      ref("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }),
    );
  });

  it("leaves the machine-readable datetime untouched", async () => {
    await start('data-stimeo--local-time-time-zone-value="UTC"');
    expect(el().getAttribute("datetime")).toBe(ISO);
  });

  it("uses the locale value for formatting", async () => {
    // `lang="en"` makes the Value's precedence over the element's own language
    // observable — without it, dropping the first term of the chain is invisible.
    await start(
      'lang="en" data-stimeo--local-time-locale-value="ja-JP" ' +
        'data-stimeo--local-time-time-zone-value="Asia/Tokyo" ' +
        'data-stimeo--local-time-date-style-value="long" ' +
        'data-stimeo--local-time-time-style-value="short"',
    );
    expect(el().textContent).toBe(
      ref("ja-JP", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Tokyo" }),
    );
    // The Japanese long date carries the 年 marker — proof the locale took effect.
    expect(el().textContent).toContain("年");
  });

  it("falls back to the element's lang when no locale value is set", async () => {
    await start(
      'lang="ja-JP" data-stimeo--local-time-time-zone-value="Asia/Tokyo" ' +
        'data-stimeo--local-time-date-style-value="long"',
    );
    expect(el().textContent).toContain("年");
  });

  it("falls back to the document's lang when nothing closer sets one", async () => {
    document.documentElement.lang = "ja-JP";
    await start(
      'data-stimeo--local-time-time-zone-value="Asia/Tokyo" ' +
        'data-stimeo--local-time-date-style-value="long"',
    );
    expect(el().textContent).toContain("年");
  });

  it("resolves the locale from the nearest ancestor lang", async () => {
    // `lang` is an inherited attribute in HTML, so a wrapper states the language of
    // the text inside it, and nothing closer to the element sets one here.
    document.body.innerHTML = `
      <div lang="ja-JP">
        <time data-controller="stimeo--local-time" datetime="${ISO}"
              data-stimeo--local-time-time-zone-value="Asia/Tokyo"
              data-stimeo--local-time-date-style-value="long">2026-06-08 12:30 UTC</time>
      </div>`;
    application = Application.start();
    application.register("stimeo--local-time", LocalTimeController);
    await tick();
    expect(el().textContent).toBe(
      ref("ja-JP", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Tokyo" }),
    );
  });

  it("shows date only when the time style is cleared", async () => {
    await start(
      'data-stimeo--local-time-locale-value="en-US" ' +
        'data-stimeo--local-time-time-zone-value="UTC" ' +
        'data-stimeo--local-time-date-style-value="medium" ' +
        'data-stimeo--local-time-time-style-value=""',
    );
    expect(el().textContent).toBe(ref("en-US", { dateStyle: "medium", timeZone: "UTC" }));
  });

  it("adds a detailed title when titleFormat is set", async () => {
    await start(
      'data-stimeo--local-time-locale-value="en-US" ' +
        'data-stimeo--local-time-time-zone-value="UTC" ' +
        'data-stimeo--local-time-title-format-value="long"',
    );
    expect(el().getAttribute("title")).toBe(
      ref("en-US", { dateStyle: "long", timeStyle: "long", timeZone: "UTC" }),
    );
  });

  it("adds no title by default", async () => {
    await start('data-stimeo--local-time-time-zone-value="UTC"');
    expect(el().hasAttribute("title")).toBe(false);
  });

  it("dispatches format with the formatted text", async () => {
    document.body.innerHTML = `<time data-controller="stimeo--local-time" datetime="${ISO}" data-stimeo--local-time-locale-value="en-US" data-stimeo--local-time-time-zone-value="UTC">x</time>`;
    const node = query("[data-controller='stimeo--local-time']");
    const formatted: string[] = [];
    node.addEventListener("stimeo--local-time:format", (event) => {
      formatted.push((event as CustomEvent<{ formatted: string }>).detail.formatted);
    });
    application = Application.start();
    application.register("stimeo--local-time", LocalTimeController);
    await tick();
    expect(formatted).toEqual([
      ref("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }),
    ]);
  });

  it("leaves the authored text when datetime is invalid", async () => {
    await start('data-stimeo--local-time-time-zone-value="UTC"', "fallback text", "not-a-date");
    expect(el().textContent).toBe("fallback text");
  });

  it("leaves the authored text when datetime is missing", async () => {
    document.body.innerHTML = `<time data-controller="stimeo--local-time">no datetime</time>`;
    application = Application.start();
    application.register("stimeo--local-time", LocalTimeController);
    await tick();
    expect(el().textContent).toBe("no datetime");
  });

  it("leaves the authored text when the timeZone is invalid (Intl throws)", async () => {
    await start('data-stimeo--local-time-time-zone-value="Not/AZone"', "authored");
    expect(el().textContent).toBe("authored");
  });

  it("leaves everything alone when neither style is usable", async () => {
    // Both styles cleared → `Intl` would otherwise fall back to its own default
    // (a bare date), silently overwriting the authored absolute text. Nothing may
    // be written: no text, no title (even though titleFormat is set), no event.
    const seen: string[] = [];
    const spy = (event: Event) => seen.push(event.type);
    document.addEventListener("stimeo--local-time:format", spy);
    try {
      await start(
        'data-stimeo--local-time-locale-value="en-US" ' +
          'data-stimeo--local-time-time-zone-value="UTC" ' +
          'data-stimeo--local-time-date-style-value="" ' +
          'data-stimeo--local-time-time-style-value="" ' +
          'data-stimeo--local-time-title-format-value="long"',
        "authored",
      );
      expect(el().textContent).toBe("authored");
      expect(el().hasAttribute("title")).toBe(false);
      expect(seen).toEqual([]);
    } finally {
      document.removeEventListener("stimeo--local-time:format", spy);
    }
  });

  it("follows a locale swapped in place by a morph", async () => {
    await start(
      'data-stimeo--local-time-locale-value="en-US" ' +
        'data-stimeo--local-time-time-zone-value="Asia/Tokyo" ' +
        'data-stimeo--local-time-date-style-value="long"',
    );
    expect(el().textContent).not.toContain("年");
    // A morph keeps the element and swaps the attribute, so `connect()` never runs
    // again: without following the Value the reading stays in the old language for
    // the rest of the session — and nothing here takes input that could repair it.
    el().setAttribute("data-stimeo--local-time-locale-value", "ja-JP");
    await tick();
    expect(el().textContent).toContain("年");
  });

  it("follows a timeZone swapped in place by a morph", async () => {
    await start(
      'data-stimeo--local-time-locale-value="en-US" ' +
        'data-stimeo--local-time-time-zone-value="UTC" ' +
        'data-stimeo--local-time-time-style-value="short"',
    );
    expect(el().textContent).toContain("12:30");
    el().setAttribute("data-stimeo--local-time-time-zone-value", "Asia/Tokyo");
    await tick();
    expect(el().textContent).toContain("9:30");
    expect(el().textContent).toContain("PM");
  });

  it("follows a dateStyle swapped in place by a morph", async () => {
    // One Value per case: swapping several at once would let the repaint any single
    // callback triggers cover for the four that were not wired up.
    await start(
      'data-stimeo--local-time-locale-value="en-US" ' +
        'data-stimeo--local-time-time-zone-value="UTC"',
    );
    el().setAttribute("data-stimeo--local-time-date-style-value", "full");
    await tick();
    expect(el().textContent).toBe(
      ref("en-US", { dateStyle: "full", timeStyle: "short", timeZone: "UTC" }),
    );
  });

  it("follows a timeStyle swapped in place by a morph", async () => {
    await start(
      'data-stimeo--local-time-locale-value="en-US" ' +
        'data-stimeo--local-time-time-zone-value="UTC"',
    );
    el().setAttribute("data-stimeo--local-time-time-style-value", "");
    await tick();
    expect(el().textContent).toBe(ref("en-US", { dateStyle: "medium", timeZone: "UTC" }));
  });

  it("follows a titleFormat swapped in place by a morph", async () => {
    await start(
      'data-stimeo--local-time-locale-value="en-US" ' +
        'data-stimeo--local-time-time-zone-value="UTC"',
    );
    expect(el().hasAttribute("title")).toBe(false);
    el().setAttribute("data-stimeo--local-time-title-format-value", "long");
    await tick();
    expect(el().getAttribute("title")).toBe(
      ref("en-US", { dateStyle: "long", timeStyle: "long", timeZone: "UTC" }),
    );
  });

  it("follows a datetime swapped in place by a morph", async () => {
    await start(
      'data-stimeo--local-time-locale-value="en-US" ' +
        'data-stimeo--local-time-time-zone-value="UTC" ' +
        'data-stimeo--local-time-date-style-value="medium" ' +
        'data-stimeo--local-time-time-style-value="short"',
    );
    // The instant itself is a render input like the Values, and it is the one a
    // stream update is most likely to swap on a `<time>` element.
    el().setAttribute("datetime", SWAPPED_ISO);
    await tick();
    expect(el().textContent).toBe(
      refFor(SWAPPED_ISO, "en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }),
    );
  });

  it("repaints once when a morph swaps several render inputs together", async () => {
    const formatted: string[] = [];
    const spy = (event: Event) => {
      formatted.push((event as CustomEvent<{ formatted: string }>).detail.formatted);
    };
    document.addEventListener("stimeo--local-time:format", spy);
    try {
      await start(
        'data-stimeo--local-time-locale-value="en-US" ' +
          'data-stimeo--local-time-time-zone-value="UTC" ' +
          'data-stimeo--local-time-date-style-value="medium" ' +
          'data-stimeo--local-time-time-style-value="short"',
      );
      formatted.length = 0;
      // A morph applies the whole batch before anything reads it, so three swaps are
      // one repaint — not one per input.
      el().setAttribute("data-stimeo--local-time-locale-value", "ja-JP");
      el().setAttribute("data-stimeo--local-time-time-zone-value", "Asia/Tokyo");
      el().setAttribute("datetime", SWAPPED_ISO);
      await tick();
      expect(formatted).toEqual([
        refFor(SWAPPED_ISO, "ja-JP", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "Asia/Tokyo",
        }),
      ]);
      expect(el().textContent).toBe(formatted[0]);
    } finally {
      document.removeEventListener("stimeo--local-time:format", spy);
    }
  });

  it("stops following render inputs once disconnected", async () => {
    await start(
      'data-stimeo--local-time-locale-value="en-US" ' +
        'data-stimeo--local-time-time-zone-value="UTC" ' +
        'data-stimeo--local-time-date-style-value="medium" ' +
        'data-stimeo--local-time-time-style-value="short"',
    );
    const rendered = el().textContent;
    disconnectAndStopApplication(application);
    el().setAttribute("datetime", "2020-01-01T00:00:00Z");
    el().setAttribute("data-stimeo--local-time-locale-value", "ja-JP");
    await tick();
    expect(el().textContent).toBe(rendered);
  });
});

describe("LocalTimeController accessibility", () => {
  let application: Application;

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("has no machine-detectable a11y violations", async () => {
    document.body.innerHTML = `
      <main>
        <p>Published
          <time data-controller="stimeo--local-time" datetime="${ISO}"
                data-stimeo--local-time-locale-value="en-US"
                data-stimeo--local-time-time-zone-value="UTC">2026-06-08 12:30 UTC</time>
        </p>
      </main>`;
    application = Application.start();
    application.register("stimeo--local-time", LocalTimeController);
    await tick();
    await expectNoA11yViolations(document.body);
  });
});
