import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PasswordStrengthController } from "../src/controllers/password_strength_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link PasswordStrengthController}: the strength heuristic
 * and its level buckets, the immediate meter ARIA / `data-strength` / custom
 * property / `change` event updates, the debounced live-region label (driven by a
 * mocked clock), custom levels, the `minScore` gate, and timer teardown.
 */

/** Must match the controller's private announce debounce. */
const ANNOUNCE_MS = 200;

describe("PasswordStrengthController", () => {
  let application: Application;

  const start = async (rootAttrs = "", fieldAttrs = "") => {
    document.body.innerHTML = `
      <div data-controller="stimeo--password-strength" ${rootAttrs}>
        <input type="password" data-stimeo--password-strength-target="input"
               data-action="input->stimeo--password-strength#evaluate"
               aria-label="Password" ${fieldAttrs}>
        <div data-stimeo--password-strength-target="meter" role="meter"
             aria-valuemin="0" aria-valuemax="4" aria-label="Password strength"></div>
        <span data-stimeo--password-strength-target="label" aria-live="polite"></span>
      </div>`;
    application = Application.start();
    application.register("stimeo--password-strength", PasswordStrengthController);
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

  const root = () => query("[data-controller='stimeo--password-strength']");
  const input = () => query<HTMLInputElement>("input");
  const meter = () => query("[role='meter']");
  const label = () => query("[data-stimeo--password-strength-target='label']");

  /** Sets the field value and fires the `input` event the action listens for. */
  const type = (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("reflects an empty field as level 0 on connect", async () => {
    await start();
    expect(meter().getAttribute("aria-valuenow")).toBe("0");
    expect(root().hasAttribute("data-strength")).toBe(false);
    expect(root().hasAttribute("data-below-min")).toBe(false); // no minimum configured
    expect(root().style.getPropertyValue("--stimeo-password-strength")).toBe("0");
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
    type("aaaaaaaaaaaa"); // 12 identical chars
    expect(meter().getAttribute("aria-valuenow")).toBe("1");
    expect(root().getAttribute("data-strength")).toBe("weak");
  });

  it("normalizes the level onto the custom property (0–1)", async () => {
    await start();
    type("Password1"); // score 2 of 4
    expect(root().style.getPropertyValue("--stimeo-password-strength")).toBe("0.5");
    type("Password1!longer"); // score 4 of 4
    expect(root().style.getPropertyValue("--stimeo-password-strength")).toBe("1");
  });

  it("clears the level hooks when the field is emptied", async () => {
    await start();
    type("Password1!");
    expect(root().getAttribute("data-strength")).toBe("good");
    type("");
    expect(root().hasAttribute("data-strength")).toBe(false);
    expect(meter().getAttribute("aria-valuenow")).toBe("0");
    expect(root().style.getPropertyValue("--stimeo-password-strength")).toBe("0");
  });

  it("dispatches change immediately with score, level, max, and meetsMin", async () => {
    await start();
    const events: Array<{ score: number; level: string; max: number; meetsMin: boolean }> = [];
    root().addEventListener("stimeo--password-strength:change", (event) => {
      events.push((event as CustomEvent).detail);
    });
    type("Password1");
    // Fires before any timer advance.
    expect(events.at(-1)).toEqual({ score: 2, level: "fair", max: 4, meetsMin: true });
  });

  it("writes the level into the label only after the debounce", async () => {
    await start();
    type("Password1!");
    // Not yet written — the polite live region is throttled while typing.
    expect(label().textContent).toBe("");
    vi.advanceTimersByTime(ANNOUNCE_MS);
    expect(label().textContent).toBe("good");
  });

  it("reflects a server-rendered field value synchronously on connect", async () => {
    await start("", 'value="Password1!"');
    // The initial render is synchronous (no debounce) so a restored value shows.
    expect(meter().getAttribute("aria-valuenow")).toBe("3");
    expect(root().getAttribute("data-strength")).toBe("good");
    expect(label().textContent).toBe("good");
  });

  it("reports meetsMin against the configured minimum", async () => {
    await start('data-stimeo--password-strength-min-score-value="3"');
    const scores: boolean[] = [];
    root().addEventListener("stimeo--password-strength:change", (event) => {
      scores.push((event as CustomEvent).detail.meetsMin);
    });
    type("Password1"); // score 2 < 3
    expect(scores.at(-1)).toBe(false);
    type("Password1!"); // score 3 >= 3
    expect(scores.at(-1)).toBe(true);
  });

  it("maps a custom levels scale to labels while keeping a stable data-strength band", async () => {
    await start('data-stimeo--password-strength-levels-value=\'["low","mid","high"]\'');
    expect(meter().getAttribute("aria-valuemax")).toBe("3");
    type("Password1!"); // four classes, length 10 → middle of three
    expect(meter().getAttribute("aria-valuenow")).toBe("2");
    // data-strength stays one of the fixed bands (locale-independent), not the label.
    expect(root().getAttribute("data-strength")).toBe("good");
    vi.advanceTimersByTime(ANNOUNCE_MS);
    expect(label().textContent).toBe("mid"); // the custom label is what's shown
  });

  it("keeps data-strength a stable band when the levels are localized", async () => {
    await start(
      'data-stimeo--password-strength-levels-value=\'["弱い","普通","強い","非常に強い"]\'',
    );
    type("Password1!longer"); // score 4 of 4
    // The styling hook stays English/stable even though the labels are translated.
    expect(root().getAttribute("data-strength")).toBe("strong");
    vi.advanceTimersByTime(ANNOUNCE_MS);
    expect(label().textContent).toBe("非常に強い");
  });

  it("flags data-below-min under the minimum and never lets an empty field meet it", async () => {
    await start('data-stimeo--password-strength-min-score-value="2"');
    const events: Array<{ score: number; meetsMin: boolean }> = [];
    root().addEventListener("stimeo--password-strength:change", (event) => {
      events.push((event as CustomEvent).detail);
    });
    type("abc"); // score 1 < 2
    expect(events.at(-1)?.meetsMin).toBe(false);
    expect(root().hasAttribute("data-below-min")).toBe(true);
    type("Password1"); // score 2 >= 2
    expect(events.at(-1)?.meetsMin).toBe(true);
    expect(root().hasAttribute("data-below-min")).toBe(false);
    // Emptying the field is pristine, not failing: `data-below-min` clears in step
    // with `meetsMin` (both exclude `score === 0`), so CSS never flags an untouched
    // field as below the minimum.
    type(""); // an empty field never meets the minimum
    expect(events.at(-1)).toMatchObject({ score: 0, meetsMin: false });
    expect(root().hasAttribute("data-below-min")).toBe(false);
  });

  it("stops the pending label debounce on disconnect", async () => {
    await start();
    const out = label();
    type("Password1!");
    root().remove(); // disconnect before the debounce fires
    await vi.advanceTimersByTimeAsync(0); // let Stimulus process the removal
    expect(() => vi.advanceTimersByTime(ANNOUNCE_MS)).not.toThrow();
    expect(out.textContent).toBe(""); // never written
  });

  it("has no machine-detectable a11y violations", async () => {
    // axe schedules real microtasks/timers, so run this case on the real clock.
    vi.useRealTimers();
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--password-strength">
          <label for="pw">Password</label>
          <input type="password" id="pw" data-stimeo--password-strength-target="input"
                 data-action="input->stimeo--password-strength#evaluate"
                 aria-describedby="pw-strength">
          <div data-stimeo--password-strength-target="meter" role="meter"
               aria-valuemin="0" aria-valuemax="4" aria-label="Password strength"></div>
          <span id="pw-strength" data-stimeo--password-strength-target="label"
                aria-live="polite"></span>
        </div>
      </main>`;
    application = Application.start();
    application.register("stimeo--password-strength", PasswordStrengthController);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expectNoA11yViolations(document.body);
  });
});
