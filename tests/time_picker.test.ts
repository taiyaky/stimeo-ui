import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimePickerController } from "../src/controllers/time_picker_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link TimePickerController}: per-segment spinbutton
 * stepping with wrap/carry, inter-segment focus, Home/End jumps, direct digit
 * entry, 12-hour meridiem handling, the composed `HH:MM[:SS]` field, and the
 * `change` event.
 */

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
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    vi.restoreAllMocks();
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

  it("reverses the horizontal arrows under RTL, leaving the value pair alone", async () => {
    // Logical direction. `dir="rtl"` is the authoring contract, but happy-dom
    // does not resolve it into the computed style, so the direction is set as an
    // inline style instead.
    // The segments lay out as an inline row, so RTL mirrors them and "next
    // segment" is to the left. `ArrowUp` / `ArrowDown`
    // change the value and must not follow the direction.
    await mount24();
    root().style.direction = "rtl";
    const before = field().value;

    key(seg("hour"), "ArrowLeft"); // "next segment" under RTL
    expect(document.activeElement).toBe(seg("minute"));

    key(seg("minute"), "ArrowRight"); // "previous segment"
    expect(document.activeElement).toBe(seg("hour"));

    key(seg("hour"), "ArrowUp"); // still "more", regardless of direction
    expect(field().value).not.toBe(before);
  });

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
    key(seg("hour"), "ArrowUp");
    expect(seg("hour").getAttribute("aria-valuenow")).toBe("10");
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

  it("leaves a modified arrow to the browser", async () => {
    // A modified arrow belongs to the browser, not the widget: the segment is
    // neither stepped nor is the composed field touched.
    await mount24();
    seg("minute").focus();

    const event = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    seg("minute").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(seg("minute").getAttribute("aria-valuenow")).toBe("30");
    expect(field().value).toBe("09:30");
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
    expect(seg("meridiem").getAttribute("aria-valuetext")).toBe("AM");
    key(seg("meridiem"), "ArrowUp"); // AM → PM
    expect(seg("meridiem").getAttribute("aria-valuetext")).toBe("PM");
    expect(field().value).toBe("21:30");
    key(seg("meridiem"), "ArrowUp"); // PM → AM
    expect(seg("meridiem").getAttribute("aria-valuetext")).toBe("AM");
    expect(field().value).toBe("09:30");
  });

  it("does not treat a digit on the meridiem segment as a value", async () => {
    await mount12({ hour: 9, minute: 30, meridiem: 0 });

    key(seg("meridiem"), "9");

    expect(seg("meridiem").getAttribute("aria-valuenow")).toBe("0");
    expect(field().value).toBe("09:30");
  });

  it("starts a fresh digit buffer when direct entry moves to another segment", async () => {
    await mount24({ hour: 9, minute: 30 });

    key(seg("hour"), "1");
    key(seg("minute"), "4");

    expect(seg("hour").getAttribute("aria-valuenow")).toBe("1");
    expect(seg("minute").getAttribute("aria-valuenow")).toBe("4");
    expect(field().value).toBe("01:04");
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

  it("dispatches a bubbling native change from the mirrored field", async () => {
    await mount24();
    const targets: EventTarget[] = [];
    root().addEventListener("change", (event) => targets.push(event.target as EventTarget));

    key(seg("minute"), "ArrowUp");

    expect(targets).toEqual([field()]);
  });

  it("keeps the widget change event when no mirrored field is present", async () => {
    await mount24();
    field().remove();
    await tick();
    const values: string[] = [];
    root().addEventListener("stimeo--time-picker:change", (event) => {
      values.push((event as CustomEvent<{ value: string }>).detail.value);
    });

    key(seg("minute"), "ArrowUp");

    expect(values).toEqual(["09:31"]);
  });

  it("does not dispatch native change while composing the initial field", async () => {
    const changes: Event[] = [];
    const onChange = (event: Event) => changes.push(event);
    document.addEventListener("change", onChange);

    await mount24();

    expect(changes).toEqual([]);
    document.removeEventListener("change", onChange);
  });

  it("does not dispatch change when the composed value is unchanged", async () => {
    await mount24({ hour: 0, minute: 0 });
    const values: string[] = [];
    const nativeChanges: Event[] = [];
    root().addEventListener("stimeo--time-picker:change", (e) => {
      values.push((e as CustomEvent).detail.value);
    });
    field().addEventListener("change", (event) => nativeChanges.push(event));
    key(seg("hour"), "Home"); // already at 0 → no value change
    expect(values).toEqual([]);
    expect(nativeChanges).toEqual([]);
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

  it("falls back to the segment minimum for a non-numeric seeded value", async () => {
    await mount24({ hour: Number.NaN, minute: 30 });

    expect(seg("hour").getAttribute("aria-valuenow")).toBe("0");
    expect(field().value).toBe("00:30");
  });

  it("ignores malformed segment targets and key events outside a segment", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    document.body.innerHTML =
      '<div data-controller="stimeo--time-picker" role="group" aria-label="Time" ' +
      'data-action="keydown->stimeo--time-picker#onKeydown">' +
      '<span data-segment="zone" data-stimeo--time-picker-target="segment" aria-valuenow="5">' +
      "Zone</span>" +
      '<input type="hidden" data-stimeo--time-picker-target="field"></div>';
    application = Application.start();
    application.register("stimeo--time-picker", TimePickerController);
    await tick();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });

    root().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(field().value).toBe("00:00");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount24();
    await expectNoA11yViolations(root());
  });

  // Speech-order regression for a single segment: pins the spinbutton role, the
  // accessible name, and the zero-padded value text.
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
