import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { TimePickerController } from "../src/controllers/time_picker_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link TimePickerController}: per-segment spinbutton
 * stepping with wrap/carry, inter-segment focus, Home/End jumps, direct digit
 * entry, 12-hour meridiem handling, the composed `HH:MM[:SS]` field, and the
 * `change` event.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("TimePickerController", () => {
  let application: Application;

  /** A 24-hour hour:minute picker (optionally with seconds). */
  const mount24 = async ({ hour = 9, minute = 30, step = 1, seconds = false } = {}) => {
    document.body.innerHTML = `
      <div data-controller="stimeo--time-picker"
           data-stimeo--time-picker-hour-cycle-value="24"
           data-stimeo--time-picker-step-value="${step}"
           data-stimeo--time-picker-seconds-value="${seconds}"
           role="group" aria-label="Time">
        ${segment("Hours", "hour", hour, 0, 23)}
        <span aria-hidden="true">:</span>
        ${segment("Minutes", "minute", minute, 0, 59)}
        ${seconds ? `<span aria-hidden="true">:</span>${segment("Seconds", "second", 0, 0, 59)}` : ""}
        <input type="hidden" data-stimeo--time-picker-target="field" />
      </div>`;
    application = Application.start();
    application.register("stimeo--time-picker", TimePickerController);
    await tick();
  };

  /** A 12-hour picker with an AM/PM meridiem spinbutton. */
  const mount12 = async ({ hour = 9, minute = 30, meridiem = 0 } = {}) => {
    document.body.innerHTML = `
      <div data-controller="stimeo--time-picker"
           data-stimeo--time-picker-hour-cycle-value="12"
           role="group" aria-label="Time">
        ${segment("Hours", "hour", hour, 1, 12)}
        <span aria-hidden="true">:</span>
        ${segment("Minutes", "minute", minute, 0, 59)}
        ${segment("AM/PM", "meridiem", meridiem, 0, 1)}
        <input type="hidden" data-stimeo--time-picker-target="field" />
      </div>`;
    application = Application.start();
    application.register("stimeo--time-picker", TimePickerController);
    await tick();
  };

  afterEach(() => {
    application?.stop();
    document.body.innerHTML = "";
  });

  const seg = (kind: string) =>
    document.querySelector<HTMLElement>(`[data-segment='${kind}']`) as HTMLElement;
  const field = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--time-picker-target='field']",
    ) as HTMLInputElement;
  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--time-picker']") as HTMLElement;
  const key = (el: HTMLElement, k: string) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  it("seeds segments and composes the initial field on connect", async () => {
    await mount24();
    expect(seg("hour").getAttribute("aria-valuetext")).toBe("09");
    expect(seg("minute").getAttribute("aria-valuetext")).toBe("30");
    expect(field().value).toBe("09:30");
  });

  it("steps the focused segment with ArrowUp/ArrowDown", async () => {
    await mount24();
    key(seg("minute"), "ArrowUp");
    expect(seg("minute").getAttribute("aria-valuenow")).toBe("31");
    expect(field().value).toBe("09:31");
    key(seg("minute"), "ArrowDown");
    expect(seg("minute").getAttribute("aria-valuenow")).toBe("30");
  });

  it("uses the minute step for the minute segment", async () => {
    await mount24({ minute: 30, step: 15 });
    key(seg("minute"), "ArrowUp");
    expect(seg("minute").getAttribute("aria-valuenow")).toBe("45");
  });

  it("wraps the minute and carries into the hour", async () => {
    await mount24({ hour: 9, minute: 59 });
    key(seg("minute"), "ArrowUp");
    expect(seg("minute").getAttribute("aria-valuenow")).toBe("0");
    expect(seg("hour").getAttribute("aria-valuenow")).toBe("10");
    expect(field().value).toBe("10:00");
  });

  it("wraps the hour at 23→00 without a day rollover", async () => {
    await mount24({ hour: 23, minute: 0 });
    key(seg("hour"), "ArrowUp");
    expect(seg("hour").getAttribute("aria-valuenow")).toBe("0");
    expect(field().value).toBe("00:00");
  });

  it("clamps instead of wrapping when wrap is disabled", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--time-picker"
           data-stimeo--time-picker-hour-cycle-value="24"
           data-stimeo--time-picker-wrap-value="false"
           role="group" aria-label="Time">
        ${segment("Hours", "hour", 9, 0, 23)}
        ${segment("Minutes", "minute", 59, 0, 59)}
        <input type="hidden" data-stimeo--time-picker-target="field" />
      </div>`;
    application = Application.start();
    application.register("stimeo--time-picker", TimePickerController);
    await tick();
    key(seg("minute"), "ArrowUp");
    expect(seg("minute").getAttribute("aria-valuenow")).toBe("59");
    expect(seg("hour").getAttribute("aria-valuenow")).toBe("9");
  });

  it("moves focus between segments with ArrowLeft/ArrowRight", async () => {
    await mount24();
    seg("hour").focus();
    key(seg("hour"), "ArrowRight");
    expect(document.activeElement).toBe(seg("minute"));
    key(seg("minute"), "ArrowLeft");
    expect(document.activeElement).toBe(seg("hour"));
  });

  it("jumps to the segment bounds on Home/End", async () => {
    await mount24();
    key(seg("hour"), "End");
    expect(seg("hour").getAttribute("aria-valuenow")).toBe("23");
    key(seg("hour"), "Home");
    expect(seg("hour").getAttribute("aria-valuenow")).toBe("0");
  });

  it("accepts direct two-digit entry and advances to the next segment", async () => {
    await mount24();
    seg("hour").focus();
    key(seg("hour"), "1");
    key(seg("hour"), "4");
    expect(seg("hour").getAttribute("aria-valuenow")).toBe("14");
    expect(document.activeElement).toBe(seg("minute"));
  });

  it("composes a 24-hour field from a 12-hour picker via the meridiem", async () => {
    await mount12({ hour: 9, minute: 30, meridiem: 0 });
    expect(field().value).toBe("09:30");
    key(seg("meridiem"), "ArrowUp"); // AM → PM
    expect(seg("meridiem").getAttribute("aria-valuetext")).toBe("PM");
    expect(field().value).toBe("21:30");
  });

  it("clamps a typed hour below the 12-hour minimum (no out-of-range 0)", async () => {
    // In 12-hour mode the hour minimum is 1; typing 0 must not commit an
    // out-of-range aria-valuenow="0" (which would also alias 12 via hour % 12).
    await mount12({ hour: 9, minute: 30, meridiem: 0 });
    seg("hour").focus();
    key(seg("hour"), "0");
    expect(seg("hour").getAttribute("aria-valuenow")).toBe("1");
    expect(field().value).toBe("01:30");
  });

  it("includes seconds when enabled", async () => {
    await mount24({ hour: 9, minute: 30, seconds: true });
    expect(field().value).toBe("09:30:00");
    key(seg("second"), "ArrowUp");
    expect(field().value).toBe("09:30:01");
  });

  it("dispatches change on every committed step", async () => {
    await mount24();
    const values: string[] = [];
    root().addEventListener("stimeo--time-picker:change", (e) => {
      values.push((e as CustomEvent).detail.value);
    });
    key(seg("minute"), "ArrowUp");
    expect(values).toEqual(["09:31"]);
  });

  it("does not dispatch change when the composed value is unchanged", async () => {
    await mount24({ hour: 0, minute: 0 });
    const values: string[] = [];
    root().addEventListener("stimeo--time-picker:change", (e) => {
      values.push((e as CustomEvent).detail.value);
    });
    key(seg("hour"), "Home"); // already at 0 → no value change
    expect(values).toEqual([]);
  });

  it("clamps an out-of-range seeded value on connect", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--time-picker"
           data-stimeo--time-picker-hour-cycle-value="24"
           role="group" aria-label="Time">
        ${segment("Hours", "hour", 99, 0, 23)}
        ${segment("Minutes", "minute", 30, 0, 59)}
        <input type="hidden" data-stimeo--time-picker-target="field" />
      </div>`;
    application = Application.start();
    application.register("stimeo--time-picker", TimePickerController);
    await tick();
    expect(seg("hour").getAttribute("aria-valuenow")).toBe("23");
    expect(field().value).toBe("23:30");
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount24();
    await expectNoA11yViolations(root());
  });

  // Layer ③ — speech-order regression for a single segment: pins the spinbutton
  // role, the accessible name, and the zero-padded value text.
  it("announces the spinbutton role, name, and value text for a segment", async () => {
    await mount24();
    const spoken = await captureSpeech({ container: seg("hour"), steps: 0 });
    expect(spoken).toEqual(["spinbutton, Hours, max value 23, min value 0, current value 09"]);
  });
});

/** Builds one spinbutton segment with its initial ARIA state. */
function segment(label: string, kind: string, now: number, min: number, max: number): string {
  const text = kind === "meridiem" ? (now === 1 ? "PM" : "AM") : String(now).padStart(2, "0");
  return `<span role="spinbutton" aria-label="${label}" tabindex="0"
    aria-valuenow="${now}" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuetext="${text}"
    data-segment="${kind}" data-stimeo--time-picker-target="segment"
    data-action="keydown->stimeo--time-picker#onKeydown">${text}</span>`;
}
