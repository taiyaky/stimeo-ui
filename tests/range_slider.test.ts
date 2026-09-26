import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RangeSliderController } from "../src/controllers/range_slider_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureFieldCommits } from "./helpers/field_commits";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents, type StateEventCapture } from "./helpers/state_events";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link RangeSliderController}: the APG multi-thumb Slider
 * contract — per-thumb stepping, the mutual `start ≤ end` constraint reflected on
 * each thumb's `aria-valuemin`/`aria-valuemax`, pointer selection of the nearest
 * thumb, and the `--stimeo--range-slider-start`/`--stimeo--range-slider-end`
 * custom properties.
 */

describe("RangeSliderController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--range-slider"
           data-stimeo--range-slider-min-value="0"
           data-stimeo--range-slider-max-value="100"
           data-stimeo--range-slider-step-value="10"
           data-stimeo--range-slider-start-value="20"
           data-stimeo--range-slider-end-value="80">
        <div data-stimeo--range-slider-target="track"
             data-action="pointerdown->stimeo--range-slider#onPointerDown">
          <div data-stimeo--range-slider-target="startThumb" role="slider" tabindex="0"
               aria-label="Minimum"
               data-action="keydown->stimeo--range-slider#onKeydown"></div>
          <div data-stimeo--range-slider-target="endThumb" role="slider" tabindex="0"
               aria-label="Maximum"
               data-action="keydown->stimeo--range-slider#onKeydown"></div>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--range-slider", RangeSliderController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--range-slider']") as HTMLElement;
  const startThumb = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--range-slider-target='startThumb']",
    ) as HTMLElement;
  const endThumb = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--range-slider-target='endThumb']",
    ) as HTMLElement;
  const track = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--range-slider-target='track']",
    ) as HTMLElement;
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--range-slider",
    ) as RangeSliderController;
  const press = (thumb: HTMLElement, key: string) =>
    thumb.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

  it("orders a reversed initial start/end by swapping (not collapsing)", async () => {
    const events = captureStateEvents("stimeo--range-slider", ["change", "reconcile"]);
    document.body.innerHTML = `
      <div data-controller="stimeo--range-slider"
           data-stimeo--range-slider-min-value="0"
           data-stimeo--range-slider-max-value="100"
           data-stimeo--range-slider-step-value="10"
           data-stimeo--range-slider-start-value="80"
           data-stimeo--range-slider-end-value="20">
        <div data-stimeo--range-slider-target="track">
          <div data-stimeo--range-slider-target="startThumb" role="slider" tabindex="0"
               aria-label="Minimum"></div>
          <div data-stimeo--range-slider-target="endThumb" role="slider" tabindex="0"
               aria-label="Maximum"></div>
        </div>
      </div>`;
    await tick();
    // Both values are preserved, just ordered — not collapsed to a single point.
    expect(startThumb().getAttribute("aria-valuenow")).toBe("20");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("80");
    // The ordering is published, not written back: the declaration stays as the
    // page wrote it, and connecting reports nothing.
    expect(root().getAttribute("data-stimeo--range-slider-start-value")).toBe("80");
    expect(root().getAttribute("data-stimeo--range-slider-end-value")).toBe("20");
    expect(events.seen).toEqual([]);
    events.stop();
  });

  it("reflects the initial pair, mutual bounds, and fractions", () => {
    expect(startThumb().getAttribute("aria-valuenow")).toBe("20");
    expect(startThumb().getAttribute("aria-valuemin")).toBe("0");
    expect(startThumb().getAttribute("aria-valuemax")).toBe("80");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("80");
    expect(endThumb().getAttribute("aria-valuemin")).toBe("20");
    expect(endThumb().getAttribute("aria-valuemax")).toBe("100");
    expect(root().style.getPropertyValue("--stimeo--range-slider-start")).toBe("0.2");
    expect(root().style.getPropertyValue("--stimeo--range-slider-end")).toBe("0.8");
    expect(root().style.getPropertyValue("--stimeo-range-start")).toBe("");
    expect(root().style.getPropertyValue("--stimeo-range-end")).toBe("");
  });

  it("uses the public Value defaults when every data Value is omitted", async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = `
      <div data-controller="stimeo--range-slider">
        <div data-stimeo--range-slider-target="track">
          <div data-stimeo--range-slider-target="startThumb" role="slider" tabindex="0"
               aria-label="Minimum"></div>
          <div data-stimeo--range-slider-target="endThumb" role="slider" tabindex="0"
               aria-label="Maximum"></div>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--range-slider", RangeSliderController);
    await tick();

    expect(startThumb().getAttribute("aria-valuemin")).toBe("0");
    expect(startThumb().getAttribute("aria-valuenow")).toBe("0");
    expect(endThumb().getAttribute("aria-valuemax")).toBe("100");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("100");
  });

  it("reports every render Value swapped in one morph as one reconcile", async () => {
    const events = captureStateEvents("stimeo--range-slider", ["change", "reconcile"]);
    root().setAttribute("data-stimeo--range-slider-min-value", "10");
    root().setAttribute("data-stimeo--range-slider-max-value", "94");
    root().setAttribute("data-stimeo--range-slider-step-value", "10");
    root().setAttribute("data-stimeo--range-slider-start-value", "31");
    root().setAttribute("data-stimeo--range-slider-end-value", "94");
    controller().minValueChanged();
    controller().maxValueChanged();
    controller().stepValueChanged();
    controller().startValueChanged();
    controller().endValueChanged();
    await flushMicrotasks();

    expect(startThumb().getAttribute("aria-valuemin")).toBe("10");
    expect(startThumb().getAttribute("aria-valuenow")).toBe("30");
    expect(endThumb().getAttribute("aria-valuemax")).toBe("94");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("94");
    expect(root().style.getPropertyValue("--stimeo--range-slider-end")).toBe("1");
    expect(events.seen.map(({ name, detail }) => ({ name, detail }))).toEqual([
      { name: "reconcile", detail: { start: 30, end: 94 } },
    ]);
    events.stop();
  });

  it("reports a pair the shrunk range clamps as reconcile, without writing Values back", async () => {
    const events = captureStateEvents("stimeo--range-slider", ["change", "reconcile"]);
    root().setAttribute("data-stimeo--range-slider-min-value", "40");
    root().setAttribute("data-stimeo--range-slider-max-value", "60");
    controller().minValueChanged();
    controller().maxValueChanged();
    await flushMicrotasks();

    expect(startThumb().getAttribute("aria-valuemin")).toBe("40");
    expect(startThumb().getAttribute("aria-valuenow")).toBe("40");
    expect(startThumb().getAttribute("aria-valuemax")).toBe("60");
    expect(endThumb().getAttribute("aria-valuemin")).toBe("40");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("60");
    expect(endThumb().getAttribute("aria-valuemax")).toBe("60");
    expect(root().getAttribute("data-stimeo--range-slider-start-value")).toBe("20");
    expect(root().getAttribute("data-stimeo--range-slider-end-value")).toBe("80");
    expect(events.seen.map(({ name, detail }) => ({ name, detail }))).toEqual([
      { name: "reconcile", detail: { start: 40, end: 60 } },
    ]);
    events.stop();
  });

  it("publishes only finite ordered ARIA for invalid runtime numeric Values", async () => {
    root().setAttribute("data-stimeo--range-slider-min-value", "NaN");
    root().setAttribute("data-stimeo--range-slider-max-value", "Infinity");
    root().setAttribute("data-stimeo--range-slider-start-value", "Infinity");
    root().setAttribute("data-stimeo--range-slider-end-value", "-Infinity");
    controller().minValueChanged();
    controller().maxValueChanged();
    controller().startValueChanged();
    controller().endValueChanged();
    await flushMicrotasks();

    expect(startThumb().getAttribute("aria-valuemin")).toBe("0");
    expect(startThumb().getAttribute("aria-valuenow")).toBe("0");
    expect(startThumb().getAttribute("aria-valuemax")).toBe("100");
    expect(endThumb().getAttribute("aria-valuemin")).toBe("0");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("100");
    expect(endThumb().getAttribute("aria-valuemax")).toBe("100");
    expect(root().style.getPropertyValue("--stimeo--range-slider-start")).toBe("0");
    expect(root().style.getPropertyValue("--stimeo--range-slider-end")).toBe("1");
  });

  it("collapses a reversed runtime range to its finite minimum", async () => {
    root().setAttribute("data-stimeo--range-slider-min-value", "80");
    root().setAttribute("data-stimeo--range-slider-max-value", "20");
    controller().minValueChanged();
    controller().maxValueChanged();
    await flushMicrotasks();

    expect(startThumb().getAttribute("aria-valuemin")).toBe("80");
    expect(startThumb().getAttribute("aria-valuenow")).toBe("80");
    expect(startThumb().getAttribute("aria-valuemax")).toBe("80");
    expect(endThumb().getAttribute("aria-valuemin")).toBe("80");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("80");
    expect(endThumb().getAttribute("aria-valuemax")).toBe("80");
  });

  it("hydrates replacement thumbs with the current mutual ARIA bounds", async () => {
    const replacement = document.createElement("div");
    replacement.setAttribute("data-stimeo--range-slider-target", "startThumb");
    replacement.setAttribute("role", "slider");
    replacement.setAttribute("tabindex", "0");
    replacement.setAttribute("aria-label", "Minimum");
    startThumb().replaceWith(replacement);

    controller().startThumbTargetConnected(replacement);
    await flushMicrotasks();

    expect(replacement.getAttribute("aria-valuemin")).toBe("0");
    expect(replacement.getAttribute("aria-valuemax")).toBe("80");
    expect(replacement.getAttribute("aria-valuenow")).toBe("20");
  });

  it("transfers focus to a replacement start thumb during its active drag", () => {
    const activeTrack = track();
    const previousThumb = startThumb();
    activeTrack.getBoundingClientRect = () => stubRect(200);
    activeTrack.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 40, pointerId: 11, bubbles: true }),
    );
    const replacement = previousThumb.cloneNode(true) as HTMLElement;
    previousThumb.replaceWith(replacement);

    controller().startThumbTargetDisconnected(previousThumb);
    controller().startThumbTargetConnected(replacement);

    expect(document.activeElement).toBe(replacement);
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 11, bubbles: true }));
  });

  it("transfers focus to a replacement end thumb during its active drag", () => {
    const activeTrack = track();
    const previousThumb = endThumb();
    activeTrack.getBoundingClientRect = () => stubRect(200);
    activeTrack.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 160, pointerId: 12, bubbles: true }),
    );
    const replacement = previousThumb.cloneNode(true) as HTMLElement;
    previousThumb.replaceWith(replacement);

    controller().endThumbTargetDisconnected(previousThumb);
    controller().endThumbTargetConnected(replacement);

    expect(document.activeElement).toBe(replacement);
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 12, bubbles: true }));
  });

  it("steps the start thumb and updates the end thumb's lower bound", () => {
    press(startThumb(), "ArrowRight");
    expect(startThumb().getAttribute("aria-valuenow")).toBe("30");
    expect(endThumb().getAttribute("aria-valuemin")).toBe("30");
  });

  it("leaves a modified arrow to the browser", () => {
    // A chorded arrow belongs to the browser (history navigation and friends):
    // the thumb neither consumes it nor steps.
    const chord = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
      altKey: true,
    });
    startThumb().dispatchEvent(chord);

    expect(chord.defaultPrevented).toBe(false);
    expect(startThumb().getAttribute("aria-valuenow")).toBe("20");
    expect(endThumb().getAttribute("aria-valuemin")).toBe("20");
  });

  it("ignores a keyboard action dispatched by a non-thumb element", async () => {
    const unrelated = document.createElement("button");
    unrelated.setAttribute("data-action", "keydown->stimeo--range-slider#onKeydown");
    root().append(unrelated);
    await tick();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });

    unrelated.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(startThumb().getAttribute("aria-valuenow")).toBe("20");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("80");
  });

  it("does not let the start thumb cross the end thumb", () => {
    for (let i = 0; i < 10; i += 1) press(startThumb(), "ArrowRight");
    // start clamps at the current end value (80), never past it.
    expect(startThumb().getAttribute("aria-valuenow")).toBe("80");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("80");
  });

  it("does not let the end thumb cross the start thumb", () => {
    for (let i = 0; i < 10; i += 1) press(endThumb(), "ArrowLeft");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("20");
    expect(startThumb().getAttribute("aria-valuenow")).toBe("20");
  });

  it("jumps each thumb to its movable bound on Home/End", () => {
    press(startThumb(), "Home");
    expect(startThumb().getAttribute("aria-valuenow")).toBe("0");
    press(startThumb(), "End");
    // End for the start thumb is the end thumb's value (80).
    expect(startThumb().getAttribute("aria-valuenow")).toBe("80");

    press(endThumb(), "End");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("100");
    press(endThumb(), "Home");
    // Home for the end thumb is the start thumb's value (80).
    expect(endThumb().getAttribute("aria-valuenow")).toBe("80");
  });

  it("moves by ten steps on PageUp/PageDown", async () => {
    // A ten-step move on the shared fixture's step=10 spans the whole range, so
    // both keys saturate at the partner thumb and the count itself stays
    // unobservable. A unit step leaves room to read the magnitude off the pair.
    root().setAttribute("data-stimeo--range-slider-step-value", "1");
    controller().stepValueChanged();
    await flushMicrotasks();

    press(startThumb(), "PageUp");
    expect(startThumb().getAttribute("aria-valuenow")).toBe("30");
    press(endThumb(), "PageDown");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("70");
  });

  it("dispatches change with the new pair", () => {
    const detail: Array<{ start: number; end: number }> = [];
    root().addEventListener("stimeo--range-slider:change", (e) => {
      detail.push((e as CustomEvent).detail);
    });
    press(startThumb(), "ArrowRight");
    expect(detail).toEqual([{ start: 30, end: 80 }]);
  });

  it("reports nothing for a key at a thumb's edge or a press that lands on a thumb's value", () => {
    const detail: Array<{ start: number; end: number }> = [];
    root().addEventListener("stimeo--range-slider:change", (e) => {
      detail.push((e as CustomEvent).detail);
    });
    track().getBoundingClientRect = () => stubRect(200);

    press(startThumb(), "Home"); // 20 -> 0
    press(startThumb(), "Home");
    press(startThumb(), "ArrowLeft");
    press(endThumb(), "End"); // 80 -> 100
    press(endThumb(), "End");
    press(endThumb(), "PageUp");
    // The right end of the track is the value the end thumb already holds.
    track().dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 200, pointerId: 42, bubbles: true }),
    );
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 42, bubbles: true }));

    expect(detail).toEqual([
      { start: 0, end: 80 },
      { start: 0, end: 100 },
    ]);
  });

  it("moves the nearest thumb on a track pointer press", () => {
    const track = document.querySelector<HTMLElement>("[data-stimeo--range-slider-target='track']");
    if (!track) throw new Error("track not found");
    track.getBoundingClientRect = () => stubRect(200);
    // X=180 → value 90, nearer the end thumb (80) than the start (20).
    track.dispatchEvent(new PointerEvent("pointerdown", { clientX: 180, bubbles: true }));
    expect(endThumb().getAttribute("aria-valuenow")).toBe("90");
    expect(startThumb().getAttribute("aria-valuenow")).toBe("20");
  });

  it("snaps a raw pointer coordinate to the authored step grid", () => {
    track().getBoundingClientRect = () => stubRect(200);

    // X=146 maps to 73, then snaps to 70 on the min-anchored step=10 grid.
    track().dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 146, pointerId: 20, bubbles: true }),
    );

    expect(startThumb().getAttribute("aria-valuenow")).toBe("20");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("70");
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 20, bubbles: true }));
  });

  it("keeps an ordinary midpoint tie deterministic on the start thumb", () => {
    track().getBoundingClientRect = () => stubRect(200);

    track().dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 100, pointerId: 21, bubbles: true }),
    );

    expect(startThumb().getAttribute("aria-valuenow")).toBe("50");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("80");
    expect(document.activeElement).toBe(startThumb());
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 21, bubbles: true }));
  });

  it("expands an overlapped pair upward with the end thumb", async () => {
    root().setAttribute("data-stimeo--range-slider-start-value", "80");
    root().setAttribute("data-stimeo--range-slider-end-value", "80");
    controller().startValueChanged();
    controller().endValueChanged();
    await flushMicrotasks();
    track().getBoundingClientRect = () => stubRect(200);

    track().dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 180, pointerId: 22, bubbles: true }),
    );

    expect(startThumb().getAttribute("aria-valuenow")).toBe("80");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("90");
    expect(document.activeElement).toBe(endThumb());
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 22, bubbles: true }));
  });

  it("expands an overlapped pair downward with the start thumb", async () => {
    root().setAttribute("data-stimeo--range-slider-start-value", "20");
    root().setAttribute("data-stimeo--range-slider-end-value", "20");
    controller().startValueChanged();
    controller().endValueChanged();
    await flushMicrotasks();
    track().getBoundingClientRect = () => stubRect(200);

    track().dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 20, pointerId: 23, bubbles: true }),
    );

    expect(startThumb().getAttribute("aria-valuenow")).toBe("10");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("20");
    expect(document.activeElement).toBe(startThumb());
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 23, bubbles: true }));
  });

  it("focuses the start thumb when the pointer selects it", () => {
    track().getBoundingClientRect = () => stubRect(200);

    track().dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 20, pointerId: 13, bubbles: true }),
    );

    expect(document.activeElement).toBe(startThumb());
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 13, bubbles: true }));
  });

  it("ignores a pointer press when the track has zero width", () => {
    track().getBoundingClientRect = () => new DOMRect();
    const event = new PointerEvent("pointerdown", {
      clientX: 100,
      pointerId: 14,
      bubbles: true,
      cancelable: true,
    });

    track().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(startThumb().getAttribute("aria-valuenow")).toBe("20");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("80");
  });

  it("ignores secondary pointer buttons without moving or focusing", () => {
    track().getBoundingClientRect = () => stubRect(200);
    const event = new PointerEvent("pointerdown", {
      button: 2,
      clientX: 180,
      pointerId: 2,
      bubbles: true,
      cancelable: true,
    });

    track().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(endThumb().getAttribute("aria-valuenow")).toBe("80");
    expect(document.activeElement).not.toBe(endThumb());
  });

  it("owns the initiating pointer through move and termination", () => {
    track().getBoundingClientRect = () => stubRect(200);
    track().dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 180, pointerId: 7, bubbles: true }),
    );
    expect(endThumb().getAttribute("aria-valuenow")).toBe("90");
    expect(document.activeElement).toBe(endThumb());

    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 0, pointerId: 8, bubbles: true }),
    );
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 8, bubbles: true }));
    expect(endThumb().getAttribute("aria-valuenow")).toBe("90");

    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 100, pointerId: 7, bubbles: true }),
    );
    expect(endThumb().getAttribute("aria-valuenow")).toBe("50");

    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, bubbles: true }));
    track().dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 0, pointerId: 9, bubbles: true }),
    );
    expect(startThumb().getAttribute("aria-valuenow")).toBe("0");
  });

  it("keeps the drag alive when the track loses pointer capture", () => {
    track().getBoundingClientRect = () => stubRect(200);
    track().dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 180, pointerId: 13, bubbles: true }),
    );
    expect(endThumb().getAttribute("aria-valuenow")).toBe("90");

    // Pointer capture is delivery, not lifetime: a consumer re-inserting the
    // owner mid-gesture releases it, and the document listeners keep the pointer.
    track().dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 13, bubbles: true }));
    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 100, pointerId: 13, bubbles: true }),
    );
    expect(endThumb().getAttribute("aria-valuenow")).toBe("50");

    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 13, bubbles: true }));
  });

  it("keeps simultaneous drags isolated between controller instances", async () => {
    const secondRoot = root().cloneNode(true) as HTMLElement;
    secondRoot.setAttribute("data-stimeo--range-slider-start-value", "10");
    secondRoot.setAttribute("data-stimeo--range-slider-end-value", "50");
    document.body.append(secondRoot);
    await tick();

    const secondTrack = secondRoot.querySelector<HTMLElement>(
      "[data-stimeo--range-slider-target='track']",
    );
    const secondStart = secondRoot.querySelector<HTMLElement>(
      "[data-stimeo--range-slider-target='startThumb']",
    );
    if (!secondTrack || !secondStart) throw new Error("second range slider is incomplete");
    track().getBoundingClientRect = () => stubRect(200);
    secondTrack.getBoundingClientRect = () => stubRect(200);

    track().dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 180, pointerId: 31, bubbles: true }),
    );
    secondTrack.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 40, pointerId: 32, bubbles: true }),
    );
    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 100, pointerId: 31, bubbles: true }),
    );

    expect(endThumb().getAttribute("aria-valuenow")).toBe("50");
    expect(secondStart.getAttribute("aria-valuenow")).toBe("20");

    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 0, pointerId: 32, bubbles: true }),
    );
    expect(endThumb().getAttribute("aria-valuenow")).toBe("50");
    expect(secondStart.getAttribute("aria-valuenow")).toBe("0");

    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 31, bubbles: true }));
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 32, bubbles: true }));
  });

  it("ends safely when the active track is removed mid-drag", () => {
    const activeTrack = track();
    const activeEnd = endThumb();
    activeTrack.getBoundingClientRect = () => stubRect(200);
    activeTrack.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 180, pointerId: 4, bubbles: true }),
    );
    expect(activeEnd.getAttribute("aria-valuenow")).toBe("90");

    activeTrack.remove();
    controller().trackTargetDisconnected(activeTrack);

    expect(() =>
      document.dispatchEvent(
        new PointerEvent("pointermove", { clientX: 0, pointerId: 4, bubbles: true }),
      ),
    ).not.toThrow();
    expect(activeEnd.getAttribute("aria-valuenow")).toBe("90");
  });

  it("ends when the live track remains connected but ceases to be a target", () => {
    const activeTrack = track();
    const activeEnd = endThumb();
    activeTrack.getBoundingClientRect = () => stubRect(200);
    activeTrack.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 180, pointerId: 15, bubbles: true }),
    );
    expect(activeEnd.getAttribute("aria-valuenow")).toBe("90");

    activeTrack.removeAttribute("data-stimeo--range-slider-target");
    controller().trackTargetDisconnected(activeTrack);
    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 0, pointerId: 15, bubbles: true }),
    );

    expect(activeEnd.getAttribute("aria-valuenow")).toBe("90");
  });

  it("reaches an off-grid maximum from keyboard and pointer input", async () => {
    root().setAttribute("data-stimeo--range-slider-max-value", "94");
    root().setAttribute("data-stimeo--range-slider-end-value", "90");
    controller().maxValueChanged();
    controller().endValueChanged();
    await flushMicrotasks();

    press(endThumb(), "End");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("94");
    expect(root().style.getPropertyValue("--stimeo--range-slider-end")).toBe("1");
    press(endThumb(), "ArrowLeft");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("90");
    press(endThumb(), "ArrowRight");
    expect(endThumb().getAttribute("aria-valuenow")).toBe("94");

    track().getBoundingClientRect = () => stubRect(200);
    track().dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 200, pointerId: 5, bubbles: true }),
    );
    expect(endThumb().getAttribute("aria-valuenow")).toBe("94");
  });

  it("avoids repeated DOM writes while a snapped pair stays unchanged", () => {
    track().getBoundingClientRect = () => stubRect(200);
    const attributeWrites = vi.spyOn(endThumb(), "setAttribute");
    const fractionWrites = vi.spyOn(root().style, "setProperty");
    track().dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 160, pointerId: 6, bubbles: true }),
    );
    for (let index = 0; index < 20; index += 1) {
      document.dispatchEvent(
        new PointerEvent("pointermove", { clientX: 180, pointerId: 6, bubbles: true }),
      );
    }

    expect(attributeWrites.mock.calls.filter(([name]) => name === "aria-valuenow")).toHaveLength(1);
    expect(
      fractionWrites.mock.calls.filter(([name]) => name === "--stimeo--range-slider-end"),
    ).toHaveLength(1);
  });

  it("has no machine-detectable a11y violations", async () => {
    await expectNoA11yViolations(root());
  });

  // Speech-order regression scoped to each thumb. Pins role, name, the live
  // mutual bounds, and the value so a lost role/name or a stale bound surfaces
  // as a diff.
  it("announces each thumb's role, name, bounds, and value", async () => {
    const start = await captureSpeech({ container: startThumb(), steps: 0 });
    expect(start).toEqual([
      "slider, Minimum, orientated horizontally, max value 80, min value 0, 20",
    ]);
    const end = await captureSpeech({ container: endThumb(), steps: 0 });
    expect(end).toEqual([
      "slider, Maximum, orientated horizontally, max value 100, min value 20, 80",
    ]);
  });

  it("removes drag listeners on disconnect so a later pointermove is ignored", () => {
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--range-slider",
    ) as RangeSliderController;
    const track = document.querySelector<HTMLElement>("[data-stimeo--range-slider-target='track']");
    if (!track) throw new Error("track not found");
    track.getBoundingClientRect = () => stubRect(200);

    track.dispatchEvent(new PointerEvent("pointerdown", { clientX: 180, bubbles: true }));
    expect(endThumb().getAttribute("aria-valuenow")).toBe("90");

    controller.disconnect();
    document.dispatchEvent(new PointerEvent("pointermove", { clientX: 0, bubbles: true }));
    expect(endThumb().getAttribute("aria-valuenow")).toBe("90");
  });

  // A track built from physical CSS does not mirror, so nothing may follow the
  // writing direction unless the consumer says their track does. `dir="rtl"` is
  // the authoring contract, but happy-dom does not resolve it into the computed
  // style, so the direction is set as an inline style instead.
  describe("writing direction", () => {
    const pressTrack = (clientX: number) => {
      const track = document.querySelector<HTMLElement>(
        "[data-stimeo--range-slider-target='track']",
      );
      if (!track) throw new Error("track not found");
      track.getBoundingClientRect = () => stubRect(200);
      track.dispatchEvent(new PointerEvent("pointerdown", { clientX, bubbles: true }));
    };
    const pressEnd = (key: string) =>
      endThumb().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

    it("ignores RTL when the track was not declared logical", () => {
      root().style.direction = "rtl";

      pressTrack(180);
      expect(endThumb().getAttribute("aria-valuenow")).toBe("90");

      pressEnd("ArrowLeft");
      expect(endThumb().getAttribute("aria-valuenow")).toBe("80");
    });

    it("reads the pointer from the right edge on a logical track under RTL", () => {
      root().setAttribute("data-stimeo--range-slider-logical-track-value", "true");
      root().style.direction = "rtl";

      // 180 / 200 mirrors to 0.1, which lands nearest the start thumb.
      pressTrack(180);
      expect(startThumb().getAttribute("aria-valuenow")).toBe("10");
      expect(endThumb().getAttribute("aria-valuenow")).toBe("80");
    });

    it("trades the horizontal arrows on a logical track under RTL", () => {
      root().setAttribute("data-stimeo--range-slider-logical-track-value", "true");
      root().style.direction = "rtl";

      pressEnd("ArrowLeft");
      expect(endThumb().getAttribute("aria-valuenow")).toBe("90");

      pressEnd("ArrowRight");
      expect(endThumb().getAttribute("aria-valuenow")).toBe("80");

      // The vertical pair names an axis the writing direction does not mirror.
      pressEnd("ArrowUp");
      expect(endThumb().getAttribute("aria-valuenow")).toBe("90");
    });
  });

  it.each([
    ["min", "10", () => startThumb().getAttribute("aria-valuemin"), "10"],
    ["max", "300", () => endThumb().getAttribute("aria-valuemax"), "300"],
  ])("follows %s swapped in place by a morph", async (name, next, read, expected) => {
    // A morph keeps the element and swaps the attribute, so `connect()` never runs
    // again and the thumbs would keep advertising the old range.
    root().setAttribute(`data-stimeo--range-slider-${name}-value`, next);
    await tick();
    expect(read()).toBe(expected);
  });

  // --- Hidden form fields ---

  describe("hidden form fields", () => {
    let commits: ReturnType<typeof captureFieldCommits>;

    const mount = async () => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = `
        <div data-controller="stimeo--range-slider"
             data-stimeo--range-slider-min-value="0" data-stimeo--range-slider-max-value="100"
             data-stimeo--range-slider-step-value="10"
             data-stimeo--range-slider-start-value="20" data-stimeo--range-slider-end-value="80">
          <input type="hidden" name="min" data-stimeo--range-slider-target="startField" />
          <input type="hidden" name="max" data-stimeo--range-slider-target="endField" />
          <div data-stimeo--range-slider-target="track">
            <div data-stimeo--range-slider-target="startThumb" role="slider" tabindex="0"
                 aria-label="Minimum" data-action="keydown->stimeo--range-slider#onKeydown"></div>
            <div data-stimeo--range-slider-target="endThumb" role="slider" tabindex="0"
                 aria-label="Maximum" data-action="keydown->stimeo--range-slider#onKeydown"></div>
          </div>
        </div>`;
      application = Application.start();
      application.register("stimeo--range-slider", RangeSliderController);
      await tick();
    };

    const startField = () =>
      document.querySelector<HTMLInputElement>(
        "[data-stimeo--range-slider-target='startField']",
      ) as HTMLInputElement;
    const endField = () =>
      document.querySelector<HTMLInputElement>(
        "[data-stimeo--range-slider-target='endField']",
      ) as HTMLInputElement;

    beforeEach(() => {
      commits = captureFieldCommits();
    });

    afterEach(() => {
      commits.stop();
    });

    it("seeds both fields without reporting a commit", async () => {
      await mount();

      expect([startField().value, endField().value]).toEqual(["20", "80"]);
      expect(commits.seen).toEqual([]);
    });

    it("reports only the end the user moved", async () => {
      await mount();
      commits.clear();

      startThumb().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));

      expect([startField().value, endField().value]).toEqual(["30", "80"]);
      expect(commits.seen).toEqual([startField()]);
    });

    it("writes a pair changed by application code without reporting a commit", async () => {
      await mount();
      commits.clear();
      const events = captureStateEvents("stimeo--range-slider", ["change", "reconcile"]);

      controller().endValue = 60;
      controller().endValueChanged();
      await tick();
      await flushMicrotasks();

      expect(endField().value).toBe("60");
      expect(commits.seen).toEqual([]);
      expect(events.seen.map(({ name, detail }) => ({ name, detail }))).toEqual([
        { name: "reconcile", detail: { start: 20, end: 60 } },
      ]);
      events.stop();
    });

    it.each([
      ["startField", "20"],
      ["endField", "80"],
    ] as const)(
      "fills a %s inserted after connect without reporting a commit",
      async (target, expected) => {
        await mount();
        const previous = target === "startField" ? startField() : endField();
        previous.remove();
        commits.clear();
        const events = captureStateEvents("stimeo--range-slider", ["change", "reconcile"]);

        // Each field arrives on its own, so only its own callback can fill it.
        const late = document.createElement("input");
        late.type = "hidden";
        late.setAttribute("data-stimeo--range-slider-target", target);
        root().append(late);
        // Drive the callback directly: happy-dom delivers target callbacks unreliably.
        if (target === "startField") controller().startFieldTargetConnected();
        else controller().endFieldTargetConnected();
        await flushMicrotasks();

        expect(late.value).toBe(expected);
        expect(commits.seen).toEqual([]);
        expect(events.seen).toEqual([]);
        events.stop();
      },
    );
  });

  // --- Page-driven reconciliation ---

  describe("page-driven reconciliation", () => {
    let events: StateEventCapture;

    const mount = async (start: string, end: string) => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = `
        <div data-controller="stimeo--range-slider"
             data-stimeo--range-slider-min-value="0" data-stimeo--range-slider-max-value="100"
             data-stimeo--range-slider-step-value="10"
             data-stimeo--range-slider-start-value="${start}"
             data-stimeo--range-slider-end-value="${end}">
          <div data-stimeo--range-slider-target="track"
               data-action="pointerdown->stimeo--range-slider#onPointerDown">
            <div data-stimeo--range-slider-target="startThumb" role="slider" tabindex="0"
                 aria-label="Minimum" data-action="keydown->stimeo--range-slider#onKeydown"></div>
            <div data-stimeo--range-slider-target="endThumb" role="slider" tabindex="0"
                 aria-label="Maximum" data-action="keydown->stimeo--range-slider#onKeydown"></div>
          </div>
        </div>`;
      application = Application.start();
      application.register("stimeo--range-slider", RangeSliderController);
      await tick();
    };

    const declared = () => [
      root().getAttribute("data-stimeo--range-slider-start-value"),
      root().getAttribute("data-stimeo--range-slider-end-value"),
    ];
    const reports = () => events.seen.map(({ name, detail }) => ({ name, detail }));
    /** Writes `end` the way a morph does and delivers its callback directly. */
    const declareEnd = async (end: string) => {
      root().setAttribute("data-stimeo--range-slider-end-value", end);
      controller().endValueChanged();
      await flushMicrotasks();
    };

    beforeEach(() => {
      events = captureStateEvents("stimeo--range-slider", ["change", "reconcile"]);
    });

    afterEach(() => {
      events.stop();
    });

    it("keeps an off-grid declaration on connect and publishes the snapped pair silently", async () => {
      await mount("23", "77");

      expect(declared()).toEqual(["23", "77"]);
      expect(startThumb().getAttribute("aria-valuenow")).toBe("20");
      expect(endThumb().getAttribute("aria-valuenow")).toBe("80");
      expect(reports()).toEqual([]);
    });

    it("reports a move once, so a later pass that finds the same pair stays silent", async () => {
      await mount("20", "80");

      await declareEnd("60");
      controller().endValueChanged();
      await flushMicrotasks();

      expect(reports()).toEqual([{ name: "reconcile", detail: { start: 20, end: 60 } }]);
    });

    it("takes a new baseline silently when it connects again after the declaration moved", async () => {
      await mount("20", "80");

      controller().disconnect();
      root().setAttribute("data-stimeo--range-slider-end-value", "60");
      controller().connect();
      controller().endValueChanged();
      await flushMicrotasks();

      expect(endThumb().getAttribute("aria-valuenow")).toBe("60");
      expect(reports()).toEqual([]);
    });

    it("stays silent when a page change leaves the published pair where it was", async () => {
      await mount("20", "80");

      // A minimum of 10 keeps 20 and 80 on the grid, and 83 snaps back onto 80.
      root().setAttribute("data-stimeo--range-slider-min-value", "10");
      controller().minValueChanged();
      await declareEnd("83");

      expect(startThumb().getAttribute("aria-valuemin")).toBe("10");
      expect(startThumb().getAttribute("aria-valuenow")).toBe("20");
      expect(endThumb().getAttribute("aria-valuenow")).toBe("80");
      expect(reports()).toEqual([]);
    });

    it("reports a user's move as change only, and the pass its Value writes start stays silent", async () => {
      await mount("20", "80");

      press(startThumb(), "ArrowRight");
      controller().startValueChanged();
      controller().endValueChanged();
      await flushMicrotasks();

      expect(declared()).toEqual(["30", "80"]);
      expect(reports()).toEqual([{ name: "change", detail: { start: 30, end: 80 } }]);
    });

    it("moves from the published pair when the declared pair is reversed", async () => {
      await mount("80", "20");

      // The lower thumb shows 20, the declared `end`; the user's move writes an
      // ordered pair back.
      press(startThumb(), "ArrowRight");

      expect(startThumb().getAttribute("aria-valuenow")).toBe("30");
      expect(endThumb().getAttribute("aria-valuenow")).toBe("80");
      expect(declared()).toEqual(["30", "80"]);
      expect(reports()).toEqual([{ name: "change", detail: { start: 30, end: 80 } }]);
    });

    it("reports a move a reconcile subscriber makes on the next pass, from the new baseline", async () => {
      await mount("20", "80");
      let redirected = false;
      root().addEventListener("stimeo--range-slider:reconcile", () => {
        if (redirected) return;
        redirected = true;
        root().setAttribute("data-stimeo--range-slider-start-value", "40");
        controller().startValueChanged();
      });

      await declareEnd("60");
      await tick();

      expect(startThumb().getAttribute("aria-valuenow")).toBe("40");
      expect(reports()).toEqual([
        { name: "reconcile", detail: { start: 20, end: 60 } },
        { name: "reconcile", detail: { start: 40, end: 60 } },
      ]);
    });

    it("keeps the baseline in step when a change subscriber moves again synchronously", async () => {
      await mount("20", "80");
      let again = true;
      // Registered after the capture, so the capture records each report before
      // this subscriber answers it.
      const moveAgain = (): void => {
        if (!again) return;
        again = false;
        press(endThumb(), "ArrowLeft");
      };
      document.addEventListener("stimeo--range-slider:change", moveAgain);

      press(startThumb(), "ArrowRight");
      controller().startValueChanged();
      controller().endValueChanged();
      await flushMicrotasks();
      document.removeEventListener("stimeo--range-slider:change", moveAgain);

      expect(declared()).toEqual(["30", "70"]);
      expect(reports()).toEqual([
        { name: "change", detail: { start: 30, end: 80 } },
        { name: "change", detail: { start: 30, end: 70 } },
      ]);
    });

    it("drops a pass queued before disconnect", async () => {
      await mount("20", "80");

      root().setAttribute("data-stimeo--range-slider-end-value", "60");
      controller().endValueChanged();
      controller().disconnect();
      await flushMicrotasks();

      expect(reports()).toEqual([]);
    });

    it.each([
      ["a script writes the other end just before the key", false],
      ["a keydown listener ahead of the thumb writes the other end", true],
    ] as const)(
      "reports a page write folded into a key once, as that key's change, when %s",
      async (_case, ahead) => {
        // The lower thumb already sits at the minimum, so the key moves nothing by itself.
        await mount("0", "80");
        const write = (): void => {
          root().setAttribute("data-stimeo--range-slider-end-value", "60");
        };
        const writeAhead = (event: Event): void => {
          if ((event as KeyboardEvent).key === "Home") write();
        };
        if (ahead) document.addEventListener("keydown", writeAhead, true);
        else write();

        press(startThumb(), "Home");
        document.removeEventListener("keydown", writeAhead, true);
        controller().endValueChanged();
        await flushMicrotasks();

        expect(endThumb().getAttribute("aria-valuenow")).toBe("60");
        expect(reports()).toEqual([{ name: "change", detail: { start: 0, end: 60 } }]);
      },
    );

    it("reports a page write folded into a pointer press once, as that press's change", async () => {
      await mount("0", "80");
      track().getBoundingClientRect = () => stubRect(200);

      // The press lands on the lower thumb's own value while the page moves the upper one.
      root().setAttribute("data-stimeo--range-slider-end-value", "60");
      track().dispatchEvent(
        new PointerEvent("pointerdown", { clientX: 0, pointerId: 52, bubbles: true }),
      );
      document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 52, bubbles: true }));
      controller().endValueChanged();
      await flushMicrotasks();

      expect(endThumb().getAttribute("aria-valuenow")).toBe("60");
      expect(reports()).toEqual([{ name: "change", detail: { start: 0, end: 60 } }]);
    });

    it("reports nothing when a page write and a key in one task end on the pair last published", async () => {
      await mount("20", "80");

      root().setAttribute("data-stimeo--range-slider-start-value", "30");
      press(startThumb(), "ArrowLeft");
      controller().startValueChanged();
      await flushMicrotasks();

      expect(startThumb().getAttribute("aria-valuenow")).toBe("20");
      expect(reports()).toEqual([]);
    });

    it("keeps a key pressed inside a reconcile listener a change, and reports nothing after it", async () => {
      await mount("20", "80");
      let spent = false;
      // Registered after the capture, so the recording keeps dispatch order.
      const pressOnce = (): void => {
        if (spent) return;
        spent = true;
        press(startThumb(), "ArrowRight");
      };
      document.addEventListener("stimeo--range-slider:reconcile", pressOnce);

      await declareEnd("60");
      controller().startValueChanged();
      controller().endValueChanged();
      await flushMicrotasks();
      document.removeEventListener("stimeo--range-slider:reconcile", pressOnce);

      expect(startThumb().getAttribute("aria-valuenow")).toBe("30");
      expect(reports()).toEqual([
        { name: "reconcile", detail: { start: 20, end: 60 } },
        { name: "change", detail: { start: 30, end: 60 } },
      ]);
    });
  });
});

/** A non-zero DOMRect so happy-dom's zero-size geometry doesn't short-circuit. */
function stubRect(width: number): DOMRect {
  return new DOMRect(0, 0, width, 10);
}
