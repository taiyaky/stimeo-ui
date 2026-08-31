import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnnouncerController } from "../src/controllers/announcer_controller";
import { PasswordStrengthController } from "../src/controllers/password_strength_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link PasswordStrengthController}: the strength heuristic
 * and its level buckets, the immediate meter ARIA / `data-strength` / custom
 * property / visible label / `change` updates, the debounced opt-in announcement
 * handed to the shared announcer (driven by a mocked clock), custom and degenerate
 * level scales, the `minScore` gate, external scores, runtime reconciliation, the
 * Turbo cache rewind, and teardown.
 */

/** Must match the controller's private announce debounce. */
const ANNOUNCE_MS = 200;

interface StrengthDetail {
  readonly score: number;
  readonly level: string;
  readonly max: number;
  readonly meetsMin: boolean;
}

describe("PasswordStrengthController", () => {
  let application: Application | null = null;
  let announcementMessages: string[] = [];

  const onAnnouncement = (event: Event): void => {
    announcementMessages.push((event as CustomEvent<{ message: string }>).detail.message);
  };

  const boot = async (markup: string) => {
    document.body.innerHTML = `
      <div data-controller="stimeo--announcer">
        <div id="ps-announcer" data-stimeo--announcer-target="polite"
             aria-live="polite" aria-atomic="true"></div>
        <div data-stimeo--announcer-target="assertive"
             aria-live="assertive" aria-atomic="true"></div>
      </div>
      ${markup}`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    application.register("stimeo--password-strength", PasswordStrengthController);
    await vi.advanceTimersByTimeAsync(0);
  };

  const start = async (rootAttrs = "", fieldAttrs = "") => {
    await boot(`
      <div data-controller="stimeo--password-strength" ${rootAttrs}>
        <input type="password" data-stimeo--password-strength-target="input"
               data-action="input->stimeo--password-strength#evaluate"
               aria-label="Password" ${fieldAttrs}>
        <div data-stimeo--password-strength-target="meter" role="meter"
             aria-valuemin="0" aria-valuemax="4" aria-label="Password strength"></div>
        <span data-stimeo--password-strength-target="label"></span>
      </div>`);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    announcementMessages = [];
    window.addEventListener("stimeo--announcer:announce", onAnnouncement);
  });

  afterEach(() => {
    window.removeEventListener("stimeo--announcer:announce", onAnnouncement);
    if (application) disconnectAndStopApplication(application);
    application = null;
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--password-strength']");
  const input = () => query<HTMLInputElement>("input[type='password']");
  const meter = () => query("[role='meter']");
  const label = () => query("[data-stimeo--password-strength-target='label']");
  const announcer = () => query<HTMLElement>("#ps-announcer");
  const instance = () =>
    application?.getControllerForElementAndIdentifier(
      root(),
      "stimeo--password-strength",
    ) as PasswordStrengthController;

  /** Sets the field value and fires the `input` event the action listens for. */
  const type = (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  };

  /** Captures the component's public event detail in dispatch order. */
  const capture = (name: "change" | "reconcile"): StrengthDetail[] => {
    const seen: StrengthDetail[] = [];
    root().addEventListener(`stimeo--password-strength:${name}`, (event) => {
      seen.push((event as CustomEvent<StrengthDetail>).detail);
    });
    return seen;
  };

  it("still renders when the levels declaration is malformed", async () => {
    // Stimulus's own Array reader throws out of the value observer before any
    // callback runs, which would stop the meter connecting at all.
    await start('data-stimeo--password-strength-levels-value="[not json"');
    expect(meter().getAttribute("aria-valuenow")).toBe("0");

    type("abc");
    // Falls back to the four default labels rather than an empty scale.
    expect(meter().getAttribute("aria-valuemax")).toBe("4");
    expect(meter().getAttribute("aria-valuenow")).toBe("1");
  });

  it("falls back to the default scale when fewer than two levels are declared", async () => {
    // A scale needs two labels to order anything; a shorter declaration would
    // leave the meter with a zero-width range and no reachable band.
    await start("data-stimeo--password-strength-levels-value='[]'");
    type("Password1!");
    expect(meter().getAttribute("aria-valuemax")).toBe("4");
    expect(meter().getAttribute("aria-valuenow")).toBe("3");
    expect(root().getAttribute("data-strength")).toBe("good");
    expect(label().textContent).toBe("good");

    root().setAttribute("data-stimeo--password-strength-levels-value", '["only"]');
    await vi.advanceTimersByTimeAsync(0);
    expect(meter().getAttribute("aria-valuemax")).toBe("4");
  });

  it("reflects an empty field as level 0 on connect", async () => {
    await start();
    expect(meter().getAttribute("aria-valuenow")).toBe("0");
    expect(root().hasAttribute("data-strength")).toBe(false);
    expect(root().hasAttribute("data-below-min")).toBe(false); // no minimum configured
    expect(root().style.getPropertyValue("--stimeo--password-strength")).toBe("0");
    expect(label().textContent).toBe("");
  });

  it("buckets the heuristic into weak / fair / good / strong", async () => {
    await start();
    type("abc"); // short, single class → weakest non-empty
    expect(meter().getAttribute("aria-valuenow")).toBe("1");
    expect(root().getAttribute("data-strength")).toBe("weak");

    type("Password1"); // length 9, three classes
    expect(meter().getAttribute("aria-valuenow")).toBe("2");
    expect(root().getAttribute("data-strength")).toBe("fair");

    type("Password1!"); // length 10, four classes
    expect(meter().getAttribute("aria-valuenow")).toBe("3");
    expect(root().getAttribute("data-strength")).toBe("good");

    type("Password1!longer"); // length 16, four classes
    expect(meter().getAttribute("aria-valuenow")).toBe("4");
    expect(root().getAttribute("data-strength")).toBe("strong");
  });

  it("caps trivial repetition as the weakest regardless of length", async () => {
    await start();
    // 16 identical characters clear every length milestone, so without the cap
    // this scores 2 — the fixture separates the cap from the length points.
    type("aaaaaaaaaaaaaaaa");
    expect(meter().getAttribute("aria-valuenow")).toBe("1");
    expect(root().getAttribute("data-strength")).toBe("weak");
  });

  it("normalizes the level onto the custom property (0–1)", async () => {
    await start();
    type("Password1"); // score 2 of 4
    expect(root().style.getPropertyValue("--stimeo--password-strength")).toBe("0.5");
    type("Password1!longer"); // score 4 of 4
    expect(root().style.getPropertyValue("--stimeo--password-strength")).toBe("1");
  });

  it("clears the level hooks when the field is emptied", async () => {
    await start();
    type("Password1!");
    expect(root().getAttribute("data-strength")).toBe("good");
    type("");
    expect(root().hasAttribute("data-strength")).toBe(false);
    expect(meter().getAttribute("aria-valuenow")).toBe("0");
    expect(root().style.getPropertyValue("--stimeo--password-strength")).toBe("0");
  });

  it("dispatches change immediately with score, level, max, and meetsMin", async () => {
    await start();
    const changes = capture("change");
    type("Password1");
    // Fires before any timer advance.
    expect(changes.at(-1)).toEqual({ score: 2, level: "fair", max: 4, meetsMin: true });
  });

  it("writes the level into the visible label on the same keystroke as the meter", async () => {
    await start();
    type("Password1!");
    // The readout is visible output, not a live region, so it never lags the meter.
    expect(meter().getAttribute("aria-valuenow")).toBe("3");
    expect(label().textContent).toBe("good");
  });

  it("reflects a server-rendered field value synchronously on connect", async () => {
    await start("", 'value="Password1!"');
    expect(meter().getAttribute("aria-valuenow")).toBe("3");
    expect(root().getAttribute("data-strength")).toBe("good");
    expect(label().textContent).toBe("good");
  });

  it("neither dispatches nor announces on the initial reflection", async () => {
    const changes: StrengthDetail[] = [];
    // The listener sits on `document` because the root does not exist yet, so it
    // is removed here rather than left for the next case to inherit.
    const onChange = (event: Event): void => {
      changes.push((event as CustomEvent<StrengthDetail>).detail);
    };
    document.addEventListener("stimeo--password-strength:change", onChange);
    try {
      await start(
        'data-stimeo--password-strength-announce-text-value="{level}"',
        'value="Password1!"',
      );
      await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
      expect(changes).toEqual([]);
      expect(announcementMessages).toEqual([]);
    } finally {
      document.removeEventListener("stimeo--password-strength:change", onChange);
    }
  });

  it("reports meetsMin against the configured minimum", async () => {
    await start('data-stimeo--password-strength-min-score-value="3"');
    const changes = capture("change");
    type("Password1"); // score 2 < 3
    expect(changes.at(-1)?.meetsMin).toBe(false);
    type("Password1!"); // score 3 >= 3
    expect(changes.at(-1)?.meetsMin).toBe(true);
  });

  it("maps a custom levels scale to labels while keeping a stable data-strength band", async () => {
    await start('data-stimeo--password-strength-levels-value=\'["low","mid","high"]\'');
    expect(meter().getAttribute("aria-valuemax")).toBe("3");
    type("Password1!"); // four classes, length 10 → middle of three
    expect(meter().getAttribute("aria-valuenow")).toBe("2");
    // data-strength stays one of the fixed bands (locale-independent), not the label.
    expect(root().getAttribute("data-strength")).toBe("good");
    expect(label().textContent).toBe("mid"); // the custom label is what's shown
  });

  it("anchors both ends of the band scale whatever the level count", async () => {
    await start('data-stimeo--password-strength-levels-value=\'["low","mid","high"]\'');
    type("abc"); // weakest non-empty score, 1 of 3
    expect(meter().getAttribute("aria-valuenow")).toBe("1");
    // Without a bottom anchor the weakest password would style as "fair" and a
    // consumer's danger rule would never match on a three-level scale.
    expect(root().getAttribute("data-strength")).toBe("weak");

    type("Password1!longer"); // strongest score, 3 of 3
    expect(meter().getAttribute("aria-valuenow")).toBe("3");
    expect(root().getAttribute("data-strength")).toBe("strong");
  });

  it("keeps data-strength a stable band when the levels are localized", async () => {
    await start(
      'data-stimeo--password-strength-levels-value=\'["弱い","普通","強い","非常に強い"]\'',
    );
    type("Password1!longer"); // score 4 of 4
    // The styling hook stays English/stable even though the labels are translated.
    expect(root().getAttribute("data-strength")).toBe("strong");
    expect(label().textContent).toBe("非常に強い");
  });

  it("flags data-below-min under the minimum and never lets an empty field meet it", async () => {
    await start('data-stimeo--password-strength-min-score-value="2"');
    const changes = capture("change");
    type("abc"); // score 1 < 2
    expect(changes.at(-1)?.meetsMin).toBe(false);
    expect(root().hasAttribute("data-below-min")).toBe(true);
    type("Password1"); // score 2 >= 2
    expect(changes.at(-1)?.meetsMin).toBe(true);
    expect(root().hasAttribute("data-below-min")).toBe(false);
    // Emptying the field is pristine, not failing: `data-below-min` clears in step
    // with `meetsMin` (both exclude `score === 0`), so CSS never flags an untouched
    // field as below the minimum.
    type(""); // an empty field never meets the minimum
    expect(changes.at(-1)).toMatchObject({ score: 0, meetsMin: false });
    expect(root().hasAttribute("data-below-min")).toBe(false);
  });

  it("falls back to the default gate when minScore cannot be read", async () => {
    await start('data-stimeo--password-strength-min-score-value="abc"');
    const changes = capture("change");
    type("Password1!longer"); // the strongest score the scale carries
    // An unreadable declaration resolves to the Value's own default (`0`, gate
    // off). Comparing against the unread number instead answers false for every
    // score, which would fail even the strongest password.
    expect(changes.at(-1)).toMatchObject({ score: 4, meetsMin: true });
    expect(root().hasAttribute("data-below-min")).toBe(false);
  });

  it("follows a runtime levels swap without waiting for the next keystroke", async () => {
    await start();
    const reconciles = capture("reconcile");
    type("Password1!"); // 3 of 4
    root().setAttribute("data-stimeo--password-strength-levels-value", '["low","mid","high"]');
    await vi.advanceTimersByTimeAsync(0);
    expect(meter().getAttribute("aria-valuemax")).toBe("3");
    expect(meter().getAttribute("aria-valuenow")).toBe("2");
    expect(label().textContent).toBe("mid");
    expect(reconciles.at(-1)).toEqual({ score: 2, level: "mid", max: 3, meetsMin: true });
  });

  it("follows a runtime minScore swap without waiting for the next keystroke", async () => {
    await start();
    const reconciles = capture("reconcile");
    type("abc"); // score 1
    expect(root().hasAttribute("data-below-min")).toBe(false);
    root().setAttribute("data-stimeo--password-strength-min-score-value", "3");
    await vi.advanceTimersByTimeAsync(0);
    expect(root().getAttribute("data-below-min")).toBe("true");
    expect(reconciles.at(-1)?.meetsMin).toBe(false);
  });

  it("stays silent on a reconciliation that leaves the derived state alone", async () => {
    await start();
    const changes = capture("change");
    const reconciles = capture("reconcile");
    type("Password1!");
    changes.length = 0;
    root().setAttribute("data-stimeo--password-strength-min-score-value", "1");
    await vi.advanceTimersByTimeAsync(0);
    expect(reconciles).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("adopts input, meter, and label targets swapped in at runtime", async () => {
    await start();
    type("Password1!");

    const replacement = document.createElement("input");
    replacement.type = "password";
    replacement.value = "Password1!longer";
    replacement.setAttribute("data-stimeo--password-strength-target", "input");
    replacement.setAttribute("aria-label", "Password");
    input().replaceWith(replacement);

    const freshMeter = document.createElement("div");
    freshMeter.setAttribute("role", "meter");
    freshMeter.setAttribute("aria-label", "Password strength");
    freshMeter.setAttribute("data-stimeo--password-strength-target", "meter");
    meter().replaceWith(freshMeter);

    const freshLabel = document.createElement("span");
    freshLabel.setAttribute("data-stimeo--password-strength-target", "label");
    label().replaceWith(freshLabel);

    await vi.advanceTimersByTimeAsync(0);
    expect(freshMeter.getAttribute("aria-valuenow")).toBe("4");
    expect(freshMeter.getAttribute("aria-valuemax")).toBe("4");
    expect(freshLabel.textContent).toBe("strong");
    expect(root().getAttribute("data-strength")).toBe("strong");
  });

  it("scores and reflects with no readout to write into", async () => {
    await boot(`
      <div data-controller="stimeo--password-strength">
        <input type="password" value="Password1!" aria-label="Password"
               data-stimeo--password-strength-target="input"
               data-action="input->stimeo--password-strength#evaluate">
        <div data-stimeo--password-strength-target="meter" role="meter"
             aria-label="Password strength"></div>
      </div>`);
    expect(meter().getAttribute("aria-valuenow")).toBe("3");
    type("Password1!longer");
    expect(meter().getAttribute("aria-valuenow")).toBe("4");
    expect(root().getAttribute("data-strength")).toBe("strong");
  });

  it("keeps rendering when the input and meter targets are absent", async () => {
    await boot(`
      <div data-controller="stimeo--password-strength">
        <span data-stimeo--password-strength-target="label"></span>
      </div>`);
    // No field to read and no meter to sync: the pristine state is still drawn
    // rather than throwing out of connect.
    expect(root().hasAttribute("data-strength")).toBe(false);
    expect(root().style.getPropertyValue("--stimeo--password-strength")).toBe("0");
    expect(label().textContent).toBe("");
  });

  it("takes an externally computed score and hands scoring back on the next evaluate", async () => {
    await start('data-action="password-strength:set->stimeo--password-strength#setScore"');
    const changes = capture("change");
    root().dispatchEvent(new CustomEvent("password-strength:set", { detail: { score: 4 } }));
    expect(meter().getAttribute("aria-valuenow")).toBe("4");
    expect(root().getAttribute("data-strength")).toBe("strong");
    expect(changes.at(-1)).toEqual({ score: 4, level: "strong", max: 4, meetsMin: true });

    type("abc"); // the built-in heuristic takes over again
    expect(meter().getAttribute("aria-valuenow")).toBe("1");
  });

  it("clamps an external score into the declared scale and ignores an unusable one", async () => {
    await start();
    const setScore = (score: unknown) =>
      instance().setScore({ params: { score } } as unknown as Event);

    setScore(9);
    expect(meter().getAttribute("aria-valuenow")).toBe("4");
    setScore(-2);
    expect(meter().getAttribute("aria-valuenow")).toBe("0");
    setScore(2.4);
    expect(meter().getAttribute("aria-valuenow")).toBe("2");

    setScore("nonsense"); // unreadable: the last good score stands
    expect(meter().getAttribute("aria-valuenow")).toBe("2");
  });

  it("stays silent without an announcement template", async () => {
    await start();
    type("Password1!");
    // Nothing is even scheduled: an unset template is opt-out, not an empty message.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual([]);
    expect(label().textContent).toBe("good"); // the visible readout is unaffected
  });

  it("debounces one settled level into the shared announcer", async () => {
    await start('data-stimeo--password-strength-announce-text-value="Strength: {level}"');
    type("Password1"); // fair
    type("Password1!"); // good, inside the debounce window
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    // Only the level the typing settled on is spoken.
    expect(announcementMessages).toEqual(["Strength: good"]);
  });

  it("does not re-announce a level the reader already heard", async () => {
    await start('data-stimeo--password-strength-announce-text-value="{level}"');
    type("Password1!");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual(["good"]);

    type("Password2!"); // same score, same level
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual(["good"]);

    type("Password1!longer"); // a real transition is spoken
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual(["good", "strong"]);
  });

  it("retargets a pending announcement when the template changes under it", async () => {
    await start('data-stimeo--password-strength-announce-text-value="old {level}"');
    type("Password1!");
    // Swap the template while the debounce is still counting down.
    root().setAttribute("data-stimeo--password-strength-announce-text-value", "new {level}");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual(["new good"]);
  });

  it("does not originate an announcement from a reconciliation alone", async () => {
    await start();
    type("Password1!");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    // Declaring a template after the window closed announces nothing by itself:
    // reconciliation repaints, it does not speak.
    root().setAttribute("data-stimeo--password-strength-announce-text-value", "{level}");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual([]);
  });

  it("drops a pending announcement when the template is cleared under it", async () => {
    await start('data-stimeo--password-strength-announce-text-value="{level}"');
    type("Password1!");
    // Opting out inside the window opts out of the message already queued: an
    // undeclared template announces nothing, whenever it is withdrawn.
    root().setAttribute("data-stimeo--password-strength-announce-text-value", "");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual([]);
  });

  it("retargets a pending announcement onto a scale swapped under it", async () => {
    await start('data-stimeo--password-strength-announce-text-value="{level}"');
    type("Password1!");
    // A locale swap can replace the labels mid-window. The reader hears the label
    // that ends up shown -- never one the current scale does not carry -- and it
    // counts as the level already heard, so the same score stays quiet after.
    root().setAttribute(
      "data-stimeo--password-strength-levels-value",
      '["low","mid","high","top"]',
    );
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual(["high"]);
    expect(label().textContent).toBe("high");

    type("Password1!");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual(["high"]);
  });

  it("offers a level again after a target change blanks the readout", async () => {
    await start('data-stimeo--password-strength-announce-text-value="{level}"');
    const field = input();
    type("Password1!");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual(["good"]);

    // Losing the scored field blanks the readout exactly as emptying it does, so
    // the level typed next is news again on this path too.
    field.remove();
    await vi.advanceTimersByTimeAsync(0);
    expect(label().textContent).toBe("");
    root().prepend(field);
    await vi.advanceTimersByTimeAsync(0);

    type("Password1!");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual(["good", "good"]);

    // A reconciliation that leaves a level standing releases nothing: swapping
    // the readout does not make the level the reader just heard news again.
    label().remove();
    await vi.advanceTimersByTimeAsync(0);
    type("Password1!");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual(["good", "good"]);
  });

  it("stops the pending announcement on disconnect", async () => {
    await start('data-stimeo--password-strength-announce-text-value="{level}"');
    type("Password1!");
    root().remove(); // disconnect before the debounce fires
    await vi.advanceTimersByTimeAsync(0); // let Stimulus process the removal
    expect(() => vi.advanceTimersByTime(ANNOUNCE_MS)).not.toThrow();
    expect(announcementMessages).toEqual([]);
  });

  it("rewinds the derived state before Turbo caches the page, without an event", async () => {
    await start('data-stimeo--password-strength-min-score-value="4"');
    const changes = capture("change");
    const reconciles = capture("reconcile");
    type("Password1!");
    changes.length = 0;

    document.dispatchEvent(new Event("turbo:before-cache"));
    // The field value is not part of the snapshot, so nothing derived from it may
    // be either — otherwise the restored page shows a strength for an empty field.
    expect(root().hasAttribute("data-strength")).toBe(false);
    expect(root().hasAttribute("data-below-min")).toBe(false);
    expect(root().style.getPropertyValue("--stimeo--password-strength")).toBe("");
    expect(meter().getAttribute("aria-valuenow")).toBe("0");
    expect(label().textContent).toBe("");
    // `connect()` derives the state again after a restore, so the rewind is silent.
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([]);
  });

  it("announces the settled level through the shared polite live region", async () => {
    await start('data-stimeo--password-strength-announce-text-value="Strength: {level}"');
    type("Sup3rStr0ng!");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual(["Strength: good"]);
    await vi.advanceTimersByTimeAsync(1);

    // The virtual SR awaits real microtasks, so capture on the real clock.
    vi.useRealTimers();
    const speech = await captureSpeech({ container: announcer(), steps: 0 });
    expect(speech).toEqual(["Strength: good"]);
  });

  it("has no machine-detectable a11y violations", async () => {
    // axe schedules real microtasks/timers, so run this case on the real clock.
    vi.useRealTimers();
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--announcer">
          <div data-stimeo--announcer-target="polite" aria-live="polite" aria-atomic="true"></div>
        </div>
        <div data-controller="stimeo--password-strength"
             data-stimeo--password-strength-announce-text-value="Strength: {level}">
          <label for="pw">Password</label>
          <input type="password" id="pw" data-stimeo--password-strength-target="input"
                 data-action="input->stimeo--password-strength#evaluate"
                 aria-describedby="pw-strength">
          <div data-stimeo--password-strength-target="meter" role="meter"
               aria-valuemin="0" aria-valuemax="4" aria-label="Password strength"></div>
          <span id="pw-strength" data-stimeo--password-strength-target="label"></span>
        </div>
      </main>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    application.register("stimeo--password-strength", PasswordStrengthController);
    await tick();
    await expectNoA11yViolations(document.body);
  });
});
