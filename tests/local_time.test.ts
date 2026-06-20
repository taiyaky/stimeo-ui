import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { LocalTimeController } from "../src/controllers/local_time_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link LocalTimeController}: UTC→locale/zone formatting,
 * timezone conversion, locale/timeZone overrides, date-only output, the optional
 * title, `datetime` preservation, graceful fallbacks, and the format event.
 *
 * Display output is asserted against a reference `Intl.DateTimeFormat` built with
 * the same options, so the tests verify the controller wires the options through
 * without pinning brittle, ICU-version-specific strings.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The fixed UTC instant under test (12:30 UTC on 2026-06-08). */
const ISO = "2026-06-08T12:30:00Z";

/** Reference format for `ISO` under the given options — mirrors the controller. */
const ref = (locale: string | undefined, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(locale, options).format(new Date(ISO));

describe("LocalTimeController", () => {
  let application: Application;

  const start = async (attrs = "", text = "2026-06-08 12:30 UTC", datetime = ISO) => {
    document.body.innerHTML = `<time data-controller="stimeo--local-time" datetime="${datetime}" ${attrs}>${text}</time>`;
    application = Application.start();
    application.register("stimeo--local-time", LocalTimeController);
    await tick();
  };

  afterEach(() => {
    application.stop();
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

  it("leaves the machine-readable datetime untouched", async () => {
    await start('data-stimeo--local-time-time-zone-value="UTC"');
    expect(el().getAttribute("datetime")).toBe(ISO);
  });

  it("uses the locale value for formatting", async () => {
    await start(
      'data-stimeo--local-time-locale-value="ja-JP" ' +
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
});

describe("LocalTimeController accessibility", () => {
  let application: Application;

  afterEach(() => {
    application.stop();
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
