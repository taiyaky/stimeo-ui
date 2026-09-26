import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SliderController } from "../src/controllers/slider_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureFieldCommits } from "./helpers/field_commits";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents, type StateEventCapture } from "./helpers/state_events";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link SliderController}: the APG Slider contract —
 * `aria-valuenow` bounds/stepping, keyboard control, and the
 * `--stimeo--slider-fraction` custom property exposed to the consumer's CSS.
 */

describe("SliderController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--slider"
           data-stimeo--slider-min-value="0"
           data-stimeo--slider-max-value="100"
           data-stimeo--slider-step-value="10"
           data-stimeo--slider-value-value="40">
        <div data-stimeo--slider-target="track"
             data-action="pointerdown->stimeo--slider#onPointerDown">
          <div data-stimeo--slider-target="thumb" role="slider" tabindex="0"
               aria-label="Volume"
               data-action="keydown->stimeo--slider#onKeydown"></div>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--slider", SliderController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--slider']") as HTMLElement;
  const thumb = () =>
    document.querySelector<HTMLElement>("[data-stimeo--slider-target='thumb']") as HTMLElement;
  const track = () =>
    document.querySelector<HTMLElement>("[data-stimeo--slider-target='track']") as HTMLElement;
  const controller = () =>
    application.getControllerForElementAndIdentifier(root(), "stimeo--slider") as SliderController;
  const press = (key: string) =>
    thumb().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  const fraction = () => root().style.getPropertyValue("--stimeo--slider-fraction");

  it("reflects the initial value and fraction", () => {
    expect(thumb().getAttribute("aria-valuenow")).toBe("40");
    expect(thumb().getAttribute("aria-valuemin")).toBe("0");
    expect(thumb().getAttribute("aria-valuemax")).toBe("100");
    expect(fraction()).toBe("0.4");
  });

  it("uses the public Value defaults when every data Value is omitted", async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = `
      <div data-controller="stimeo--slider">
        <div data-stimeo--slider-target="track"
             data-action="pointerdown->stimeo--slider#onPointerDown">
          <div data-stimeo--slider-target="thumb" role="slider" tabindex="0"
               aria-label="Volume"
               data-action="keydown->stimeo--slider#onKeydown"></div>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--slider", SliderController);
    await tick();

    expect(thumb().getAttribute("aria-valuemin")).toBe("0");
    expect(thumb().getAttribute("aria-valuemax")).toBe("100");
    expect(thumb().getAttribute("aria-valuenow")).toBe("0");
    expect(fraction()).toBe("0");
  });

  it("reports a batch of render Values swapped by a morph as one reconcile", async () => {
    const events = captureStateEvents("stimeo--slider", ["change", "reconcile"]);
    root().setAttribute("data-stimeo--slider-min-value", "10");
    root().setAttribute("data-stimeo--slider-max-value", "94");
    root().setAttribute("data-stimeo--slider-step-value", "10");
    root().setAttribute("data-stimeo--slider-value-value", "94");

    // Drive the callback contract directly: happy-dom may drop the Stimulus
    // MutationObserver delivery under full-suite load.
    controller().minValueChanged();
    controller().maxValueChanged();
    controller().stepValueChanged();
    controller().valueValueChanged();
    await flushMicrotasks();

    expect(thumb().getAttribute("aria-valuemin")).toBe("10");
    expect(thumb().getAttribute("aria-valuemax")).toBe("94");
    expect(thumb().getAttribute("aria-valuenow")).toBe("94");
    expect(fraction()).toBe("1");
    expect(events.seen.map(({ name, detail }) => ({ name, detail }))).toEqual([
      { name: "reconcile", detail: { value: 94 } },
    ]);
    events.stop();
  });

  it("hydrates a replacement thumb with current ARIA without dispatching change", async () => {
    const changes = vi.fn();
    root().addEventListener("stimeo--slider:change", changes);
    const replacement = document.createElement("div");
    replacement.setAttribute("data-stimeo--slider-target", "thumb");
    replacement.setAttribute("role", "slider");
    replacement.setAttribute("tabindex", "0");
    replacement.setAttribute("aria-label", "Volume");
    thumb().replaceWith(replacement);

    controller().thumbTargetConnected(replacement);
    await flushMicrotasks();

    expect(replacement.getAttribute("aria-valuemin")).toBe("0");
    expect(replacement.getAttribute("aria-valuemax")).toBe("100");
    expect(replacement.getAttribute("aria-valuenow")).toBe("40");
    expect(changes).not.toHaveBeenCalled();
  });

  it("transfers focus to a replacement thumb during an active drag", () => {
    const activeTrack = track();
    const previousThumb = thumb();
    activeTrack.getBoundingClientRect = () => new DOMRect(0, 0, 200, 10);
    activeTrack.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 80, pointerId: 11, bubbles: true }),
    );
    const replacement = previousThumb.cloneNode(true) as HTMLElement;
    previousThumb.replaceWith(replacement);

    controller().thumbTargetDisconnected(previousThumb);
    controller().thumbTargetConnected(replacement);

    expect(document.activeElement).toBe(replacement);
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 11, bubbles: true }));
  });

  it("dispatches change with the new value on a real change, not at connect or bounds", () => {
    const values: number[] = [];
    root().addEventListener("stimeo--slider:change", (e) =>
      values.push((e as CustomEvent).detail.value),
    );
    press("ArrowRight"); // 40 -> 50
    expect(values).toEqual([50]);
    press("End"); // -> 100
    press("ArrowRight"); // already at max: no change, no event
    expect(values).toEqual([50, 100]);
  });

  it("reports nothing for a key at the lower edge or a press that lands on the current value", () => {
    const values: number[] = [];
    root().addEventListener("stimeo--slider:change", (e) =>
      values.push((e as CustomEvent).detail.value),
    );
    track().getBoundingClientRect = () => new DOMRect(0, 0, 200, 10);

    press("Home"); // 40 -> 0
    press("Home");
    press("ArrowLeft");
    press("PageDown");
    // The left end of the track maps to the minimum the thumb already holds.
    track().dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 0, pointerId: 41, bubbles: true }),
    );
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 41, bubbles: true }));

    expect(values).toEqual([0]);
  });

  it("increments by one step on ArrowRight", () => {
    press("ArrowRight");
    expect(thumb().getAttribute("aria-valuenow")).toBe("50");
    expect(fraction()).toBe("0.5");
  });

  it("decrements by one step on ArrowDown", () => {
    press("ArrowDown");
    expect(thumb().getAttribute("aria-valuenow")).toBe("30");
  });

  it("clamps at the maximum", () => {
    for (let i = 0; i < 10; i += 1) press("ArrowRight");
    expect(thumb().getAttribute("aria-valuenow")).toBe("100");
    expect(fraction()).toBe("1");
  });

  it("jumps to min on Home and max on End", () => {
    press("Home");
    expect(thumb().getAttribute("aria-valuenow")).toBe("0");
    press("End");
    expect(thumb().getAttribute("aria-valuenow")).toBe("100");
  });

  it("moves by ten steps on PageDown", () => {
    press("PageDown");
    expect(thumb().getAttribute("aria-valuenow")).toBe("0");
  });

  it("moves by ten steps on PageUp (clamped at max)", () => {
    press("PageUp"); // 40 + 10*10 = 140 → clamped to 100
    expect(thumb().getAttribute("aria-valuenow")).toBe("100");
  });

  it("leaves a modified arrow to the browser", () => {
    // A chorded arrow is the browser's (history back/forward and the like), so
    // the slider neither consumes the key nor steps its value.
    const chord = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    thumb().dispatchEvent(chord);

    expect(chord.defaultPrevented).toBe(false);
    expect(thumb().getAttribute("aria-valuenow")).toBe("40");
    expect(fraction()).toBe("0.4");
  });

  it("ignores unrelated keys without preventing default", () => {
    const event = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    thumb().dispatchEvent(event);
    expect(thumb().getAttribute("aria-valuenow")).toBe("40");
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores a pointer press when the track has zero width", () => {
    const track = document.querySelector<HTMLElement>("[data-stimeo--slider-target='track']");
    if (!track) throw new Error("track not found");
    track.getBoundingClientRect = () => new DOMRect();
    track.dispatchEvent(new PointerEvent("pointerdown", { clientX: 150, bubbles: true }));
    expect(thumb().getAttribute("aria-valuenow")).toBe("40"); // unchanged
  });

  it("sets the value from a pointer press on the track", () => {
    const track = document.querySelector<HTMLElement>("[data-stimeo--slider-target='track']");
    if (!track) throw new Error("track not found");
    // happy-dom returns a zero-size rect; stub geometry so the math is exercised.
    track.getBoundingClientRect = () => new DOMRect(0, 0, 200, 10);
    track.dispatchEvent(new PointerEvent("pointerdown", { clientX: 150, bubbles: true }));
    expect(thumb().getAttribute("aria-valuenow")).toBe("80");
  });

  it("moves focus to the thumb when a primary pointer interaction starts", () => {
    track().getBoundingClientRect = () => new DOMRect(0, 0, 200, 10);

    track().dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 150, pointerId: 1, bubbles: true }),
    );

    expect(document.activeElement).toBe(thumb());
  });

  it("ignores secondary pointer buttons without moving or focusing", () => {
    track().getBoundingClientRect = () => new DOMRect(0, 0, 200, 10);
    const event = new PointerEvent("pointerdown", {
      button: 2,
      clientX: 180,
      pointerId: 2,
      bubbles: true,
      cancelable: true,
    });

    track().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(thumb().getAttribute("aria-valuenow")).toBe("40");
    expect(document.activeElement).not.toBe(thumb());
  });

  it("owns the initiating pointer through move and termination", () => {
    track().getBoundingClientRect = () => new DOMRect(0, 0, 200, 10);
    track().dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 20, pointerId: 7, bubbles: true }),
    );
    expect(thumb().getAttribute("aria-valuenow")).toBe("10");

    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 180, pointerId: 8, bubbles: true }),
    );
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 8, bubbles: true }));
    expect(thumb().getAttribute("aria-valuenow")).toBe("10");

    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 100, pointerId: 7, bubbles: true }),
    );
    expect(thumb().getAttribute("aria-valuenow")).toBe("50");
  });

  it("keeps the drag alive when the track loses pointer capture", () => {
    track().getBoundingClientRect = () => new DOMRect(0, 0, 200, 10);
    track().dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 20, pointerId: 13, bubbles: true }),
    );
    expect(thumb().getAttribute("aria-valuenow")).toBe("10");

    // Pointer capture is delivery, not lifetime: a consumer re-inserting the
    // owner mid-gesture releases it, and the document listeners keep the pointer.
    track().dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 13, bubbles: true }));
    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 100, pointerId: 13, bubbles: true }),
    );
    expect(thumb().getAttribute("aria-valuenow")).toBe("50");

    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 13, bubbles: true }));
  });

  it("keeps simultaneous sliders isolated by pointer identity", async () => {
    const second = root().cloneNode(true) as HTMLElement;
    second.setAttribute("data-stimeo--slider-value-value", "90");
    root().after(second);
    await tick();
    const roots = [...document.querySelectorAll<HTMLElement>("[data-controller='stimeo--slider']")];
    const tracks = roots.map((element) =>
      element.querySelector<HTMLElement>("[data-stimeo--slider-target='track']"),
    );
    const thumbs = roots.map((element) =>
      element.querySelector<HTMLElement>("[data-stimeo--slider-target='thumb']"),
    );
    if (!tracks[0] || !tracks[1] || !thumbs[0] || !thumbs[1]) throw new Error("fixture missing");
    tracks[0].getBoundingClientRect = () => new DOMRect(0, 0, 200, 10);
    tracks[1].getBoundingClientRect = () => new DOMRect(0, 0, 200, 10);
    tracks[0].dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 20, pointerId: 1, bubbles: true }),
    );
    tracks[1].dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 180, pointerId: 2, bubbles: true }),
    );

    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 100, pointerId: 1, bubbles: true }),
    );

    expect(thumbs[0].getAttribute("aria-valuenow")).toBe("50");
    expect(thumbs[1].getAttribute("aria-valuenow")).toBe("90");
  });

  it("ends safely when the active track is removed mid-drag", () => {
    const activeTrack = track();
    const activeThumb = thumb();
    activeTrack.getBoundingClientRect = () => new DOMRect(0, 0, 200, 10);
    activeTrack.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 160, pointerId: 4, bubbles: true }),
    );
    expect(activeThumb.getAttribute("aria-valuenow")).toBe("80");

    activeTrack.remove();
    controller().trackTargetDisconnected(activeTrack);

    expect(() =>
      document.dispatchEvent(
        new PointerEvent("pointermove", { clientX: 0, pointerId: 4, bubbles: true }),
      ),
    ).not.toThrow();
    expect(activeThumb.getAttribute("aria-valuenow")).toBe("80");
  });

  it("ends when the live track remains connected but ceases to be a target", () => {
    const activeTrack = track();
    const activeThumb = thumb();
    activeTrack.getBoundingClientRect = () => new DOMRect(0, 0, 200, 10);
    activeTrack.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 160, pointerId: 12, bubbles: true }),
    );
    expect(activeThumb.getAttribute("aria-valuenow")).toBe("80");

    activeTrack.removeAttribute("data-stimeo--slider-target");
    controller().trackTargetDisconnected(activeTrack);
    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 0, pointerId: 12, bubbles: true }),
    );

    expect(activeThumb.getAttribute("aria-valuenow")).toBe("80");
  });

  it("reaches an off-grid maximum from keyboard and pointer input", async () => {
    root().setAttribute("data-stimeo--slider-max-value", "94");
    root().setAttribute("data-stimeo--slider-value-value", "90");
    controller().maxValueChanged();
    controller().valueValueChanged();
    await flushMicrotasks();

    press("End");
    expect(thumb().getAttribute("aria-valuenow")).toBe("94");
    expect(fraction()).toBe("1");
    press("ArrowLeft");
    expect(thumb().getAttribute("aria-valuenow")).toBe("90");
    press("ArrowRight");
    expect(thumb().getAttribute("aria-valuenow")).toBe("94");

    track().getBoundingClientRect = () => new DOMRect(0, 0, 200, 10);
    track().dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 200, pointerId: 5, bubbles: true }),
    );
    expect(thumb().getAttribute("aria-valuenow")).toBe("94");
  });

  it("falls back to step one when the authored step is invalid", async () => {
    root().setAttribute("data-stimeo--slider-step-value", "0");
    root().setAttribute("data-stimeo--slider-value-value", "2.6");
    controller().stepValueChanged();
    controller().valueValueChanged();
    await flushMicrotasks();

    expect(thumb().getAttribute("aria-valuenow")).toBe("3");
    press("ArrowRight");
    expect(thumb().getAttribute("aria-valuenow")).toBe("4");
  });

  it("avoids repeated DOM writes while a snapped value stays unchanged", () => {
    const activeTrack = track();
    const activeThumb = thumb();
    activeTrack.getBoundingClientRect = () => new DOMRect(0, 0, 200, 10);
    const attributeWrites = vi.spyOn(activeThumb, "setAttribute");
    const fractionWrites = vi.spyOn(root().style, "setProperty");
    activeTrack.dispatchEvent(
      new PointerEvent("pointerdown", { clientX: 80, pointerId: 6, bubbles: true }),
    );
    for (let index = 0; index < 20; index += 1) {
      document.dispatchEvent(
        new PointerEvent("pointermove", { clientX: 100, pointerId: 6, bubbles: true }),
      );
    }

    expect(attributeWrites.mock.calls.filter(([name]) => name === "aria-valuenow")).toHaveLength(1);
    expect(
      fractionWrites.mock.calls.filter(([name]) => name === "--stimeo--slider-fraction"),
    ).toHaveLength(1);
  });

  // Machine-detectable a11y.
  it("has no machine-detectable a11y violations", async () => {
    await expectNoA11yViolations(root());
  });

  // Speech-order regression. Scoping to the thumb (the `role="slider"` element)
  // yields a single, deterministic announcement; capturing it before and after a
  // keyboard step pins role, accessible name, bounds, and the announced value so
  // a lost role/name or a stale value surfaces as a diff.
  it("announces the slider role, name, bounds, and value before and after a step", async () => {
    const before = await captureSpeech({ container: thumb(), steps: 0 });
    expect(before).toEqual([
      "slider, Volume, orientated horizontally, max value 100, min value 0, 40",
    ]);

    press("ArrowRight");

    const after = await captureSpeech({ container: thumb(), steps: 0 });
    expect(after).toEqual([
      "slider, Volume, orientated horizontally, max value 100, min value 0, 50",
    ]);
  });

  // Disconnect-teardown regression: the drag's `document` listeners are bound to
  // an AbortController aborted in disconnect(), so a pointermove after teardown
  // must not move the value (no leaked listener).
  it("removes drag listeners on disconnect so a later pointermove is ignored", () => {
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--slider",
    ) as SliderController;
    const track = document.querySelector<HTMLElement>("[data-stimeo--slider-target='track']");
    if (!track) throw new Error("track not found");
    track.getBoundingClientRect = () => new DOMRect(0, 0, 200, 10);

    track.dispatchEvent(new PointerEvent("pointerdown", { clientX: 150, bubbles: true }));
    expect(thumb().getAttribute("aria-valuenow")).toBe("80");

    // Tearing the controller down mid-drag must abort the document drag listeners.
    controller.disconnect();

    document.dispatchEvent(new PointerEvent("pointermove", { clientX: 0, bubbles: true }));
    expect(thumb().getAttribute("aria-valuenow")).toBe("80");
  });

  // A track built from physical CSS does not mirror, so nothing may follow the
  // writing direction unless the consumer says their track does. `dir="rtl"` is
  // the authoring contract, but happy-dom does not resolve it into the computed
  // style, so the direction is set as an inline style instead.
  describe("writing direction", () => {
    const pressTrack = (clientX: number) => {
      const track = document.querySelector<HTMLElement>("[data-stimeo--slider-target='track']");
      if (!track) throw new Error("track not found");
      track.getBoundingClientRect = () => new DOMRect(0, 0, 200, 10);
      track.dispatchEvent(
        new PointerEvent("pointerdown", { clientX, pointerId: 1, bubbles: true }),
      );
      document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
    };

    it("ignores RTL when the track was not declared logical", () => {
      root().style.direction = "rtl";

      pressTrack(200);
      expect(thumb().getAttribute("aria-valuenow")).toBe("100");

      press("ArrowLeft");
      expect(thumb().getAttribute("aria-valuenow")).toBe("90");
    });

    it("reads the pointer from the right edge on a logical track under RTL", () => {
      root().setAttribute("data-stimeo--slider-logical-track-value", "true");
      root().style.direction = "rtl";

      pressTrack(200);
      expect(thumb().getAttribute("aria-valuenow")).toBe("0");

      pressTrack(0);
      expect(thumb().getAttribute("aria-valuenow")).toBe("100");
    });

    it("trades the horizontal arrows on a logical track under RTL", () => {
      root().setAttribute("data-stimeo--slider-logical-track-value", "true");
      root().style.direction = "rtl";

      // The greater value sits at the visual left, so ArrowLeft must increase.
      press("ArrowLeft");
      expect(thumb().getAttribute("aria-valuenow")).toBe("50");

      press("ArrowRight");
      expect(thumb().getAttribute("aria-valuenow")).toBe("40");

      // The vertical pair names an axis the writing direction does not mirror.
      press("ArrowUp");
      expect(thumb().getAttribute("aria-valuenow")).toBe("50");
    });

    it("leaves a logical track alone under LTR", () => {
      root().setAttribute("data-stimeo--slider-logical-track-value", "true");

      pressTrack(200);
      expect(thumb().getAttribute("aria-valuenow")).toBe("100");

      press("ArrowLeft");
      expect(thumb().getAttribute("aria-valuenow")).toBe("90");
    });
  });

  // --- Hidden form field ---

  describe("hidden form field", () => {
    let commits: ReturnType<typeof captureFieldCommits>;

    const mount = async (value = "40") => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = `
        <div data-controller="stimeo--slider"
             data-stimeo--slider-min-value="0" data-stimeo--slider-max-value="100"
             data-stimeo--slider-step-value="10" data-stimeo--slider-value-value="${value}">
          <input type="hidden" name="volume" data-stimeo--slider-target="field" />
          <div data-stimeo--slider-target="track">
            <div data-stimeo--slider-target="thumb" role="slider" tabindex="0" aria-label="Volume"
                 data-action="keydown->stimeo--slider#onKeydown"></div>
          </div>
        </div>`;
      application = Application.start();
      application.register("stimeo--slider", SliderController);
      await tick();
    };

    const field = () =>
      document.querySelector<HTMLInputElement>(
        "[data-stimeo--slider-target='field']",
      ) as HTMLInputElement;

    beforeEach(() => {
      commits = captureFieldCommits();
    });

    afterEach(() => {
      commits.stop();
    });

    it("seeds the field from the value without reporting a commit", async () => {
      await mount();

      expect(field().value).toBe("40");
      expect(commits.seen).toEqual([]);
    });

    it("writes and reports once per key the user pressed", async () => {
      await mount();
      commits.clear();

      press("ArrowRight");

      expect(field().value).toBe("50");
      expect(commits.seen).toEqual([field()]);
    });

    it("stays silent at a bound where the value cannot move", async () => {
      await mount("100");
      commits.clear();

      press("ArrowRight");

      expect(field().value).toBe("100");
      expect(commits.seen).toEqual([]);
    });

    it("writes a value changed by application code without reporting a commit", async () => {
      await mount();
      commits.clear();
      const events = captureStateEvents("stimeo--slider", ["change", "reconcile"]);

      controller().valueValue = 70;
      controller().valueValueChanged();
      await tick();
      await flushMicrotasks();

      expect(field().value).toBe("70");
      expect(commits.seen).toEqual([]);
      expect(events.names()).toEqual(["reconcile"]);
      events.stop();
    });

    it("fills a field inserted after connect without reporting a commit", async () => {
      await mount();
      field().remove();
      commits.clear();

      const late = document.createElement("input");
      late.type = "hidden";
      late.setAttribute("data-stimeo--slider-target", "field");
      root().append(late);
      // Drive the callback directly: happy-dom delivers target callbacks unreliably.
      controller().fieldTargetConnected();
      await flushMicrotasks();

      expect(late.value).toBe("40");
      expect(commits.seen).toEqual([]);
    });
  });

  // --- Page-driven reconciliation ---

  describe("page-driven reconciliation", () => {
    let events: StateEventCapture;

    const mount = async (value: string) => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = `
        <div data-controller="stimeo--slider"
             data-stimeo--slider-min-value="0" data-stimeo--slider-max-value="100"
             data-stimeo--slider-step-value="5" data-stimeo--slider-value-value="${value}">
          <input type="hidden" name="volume" data-stimeo--slider-target="field" />
          <div data-stimeo--slider-target="track"
               data-action="pointerdown->stimeo--slider#onPointerDown">
            <div data-stimeo--slider-target="thumb" role="slider" tabindex="0" aria-label="Volume"
                 data-action="keydown->stimeo--slider#onKeydown"></div>
          </div>
        </div>`;
      application = Application.start();
      application.register("stimeo--slider", SliderController);
      await tick();
    };

    const field = () =>
      document.querySelector<HTMLInputElement>(
        "[data-stimeo--slider-target='field']",
      ) as HTMLInputElement;
    const declared = () => root().getAttribute("data-stimeo--slider-value-value");
    const reports = () => events.seen.map(({ name, detail }) => ({ name, detail }));
    /** Writes `value` the way a morph does and delivers its callback directly. */
    const declare = async (value: string) => {
      root().setAttribute("data-stimeo--slider-value-value", value);
      controller().valueValueChanged();
      await flushMicrotasks();
    };

    beforeEach(() => {
      events = captureStateEvents("stimeo--slider", ["change", "reconcile"]);
    });

    afterEach(() => {
      events.stop();
    });

    it("keeps an off-grid declaration on connect and publishes the snapped value silently", async () => {
      await mount("47.3");

      expect(declared()).toBe("47.3");
      expect(thumb().getAttribute("aria-valuenow")).toBe("45");
      expect(field().value).toBe("45");
      expect(fraction()).toBe("0.45");
      expect(reports()).toEqual([]);
    });

    it("reports a declaration that snaps to a new published value once as reconcile", async () => {
      await mount("40");

      await declare("47.3");

      expect(declared()).toBe("47.3");
      expect(thumb().getAttribute("aria-valuenow")).toBe("45");
      expect(field().value).toBe("45");
      expect(reports()).toEqual([{ name: "reconcile", detail: { value: 45 } }]);
    });

    it("reports a move once, so a later pass that finds the same value stays silent", async () => {
      await mount("40");

      await declare("60");
      controller().valueValueChanged();
      await flushMicrotasks();

      expect(reports()).toEqual([{ name: "reconcile", detail: { value: 60 } }]);
    });

    it("takes a new baseline silently when it connects again after the declaration moved", async () => {
      await mount("40");

      controller().disconnect();
      root().setAttribute("data-stimeo--slider-value-value", "70");
      controller().connect();
      controller().valueValueChanged();
      await flushMicrotasks();

      expect(thumb().getAttribute("aria-valuenow")).toBe("70");
      expect(reports()).toEqual([]);
    });

    it("stays silent when a page change leaves the published value where it was", async () => {
      await mount("40");

      // 41 snaps back onto 40, and a lower maximum still contains it.
      await declare("41");
      root().setAttribute("data-stimeo--slider-max-value", "90");
      controller().maxValueChanged();
      await flushMicrotasks();

      expect(thumb().getAttribute("aria-valuenow")).toBe("40");
      expect(thumb().getAttribute("aria-valuemax")).toBe("90");
      expect(reports()).toEqual([]);
    });

    it("reports a user's move as change only, and the pass its Value write starts stays silent", async () => {
      await mount("40");

      press("ArrowRight");
      controller().valueValueChanged();
      await flushMicrotasks();

      expect(declared()).toBe("45");
      expect(reports()).toEqual([{ name: "change", detail: { value: 45 } }]);
    });

    it("steps from the published value when the declaration is off the grid", async () => {
      await mount("47.3");

      press("ArrowRight");

      expect(thumb().getAttribute("aria-valuenow")).toBe("50");
      expect(declared()).toBe("50");
      expect(reports()).toEqual([{ name: "change", detail: { value: 50 } }]);
    });

    it("reports a move a reconcile subscriber makes on the next pass, from the new baseline", async () => {
      await mount("40");
      let redirected = false;
      root().addEventListener("stimeo--slider:reconcile", () => {
        if (redirected) return;
        redirected = true;
        root().setAttribute("data-stimeo--slider-value-value", "80");
        controller().valueValueChanged();
      });

      await declare("60");
      await tick();

      expect(thumb().getAttribute("aria-valuenow")).toBe("80");
      expect(reports()).toEqual([
        { name: "reconcile", detail: { value: 60 } },
        { name: "reconcile", detail: { value: 80 } },
      ]);
    });

    it("keeps the baseline in step when a change subscriber moves again synchronously", async () => {
      await mount("40");
      let again = true;
      // Registered after the capture, so the capture records each report before
      // this subscriber answers it.
      const moveAgain = (): void => {
        if (!again) return;
        again = false;
        press("ArrowRight");
      };
      document.addEventListener("stimeo--slider:change", moveAgain);

      press("ArrowRight");
      controller().valueValueChanged();
      await flushMicrotasks();
      document.removeEventListener("stimeo--slider:change", moveAgain);

      expect(thumb().getAttribute("aria-valuenow")).toBe("50");
      expect(reports()).toEqual([
        { name: "change", detail: { value: 45 } },
        { name: "change", detail: { value: 50 } },
      ]);
    });

    it("drops a pass queued before disconnect", async () => {
      await mount("40");

      root().setAttribute("data-stimeo--slider-value-value", "60");
      controller().valueValueChanged();
      controller().disconnect();
      await flushMicrotasks();

      expect(reports()).toEqual([]);
    });

    it.each([
      ["a script writes the value just before the key", false],
      ["a keydown listener ahead of the slider writes the value", true],
    ] as const)(
      "reports a page write folded into a key once, as that key's change, when %s",
      async (_case, ahead) => {
        await mount("40");
        const commits = captureFieldCommits();
        const write = (): void => {
          root().setAttribute("data-stimeo--slider-value-value", "100");
        };
        const writeAhead = (event: Event): void => {
          if ((event as KeyboardEvent).key === "End") write();
        };
        if (ahead) document.addEventListener("keydown", writeAhead, true);
        else write();

        press("End");
        document.removeEventListener("keydown", writeAhead, true);
        controller().valueValueChanged();
        await flushMicrotasks();

        expect(thumb().getAttribute("aria-valuenow")).toBe("100");
        expect(reports()).toEqual([{ name: "change", detail: { value: 100 } }]);
        // The field reports the same move once, as the user's commit.
        expect(commits.values()).toEqual(["100"]);
        commits.stop();
      },
    );

    it("reports a page write folded into a pointer press once, as that press's change", async () => {
      await mount("40");
      track().getBoundingClientRect = () => new DOMRect(0, 0, 200, 10);

      // The press lands on the value the page has just declared.
      root().setAttribute("data-stimeo--slider-value-value", "70");
      track().dispatchEvent(
        new PointerEvent("pointerdown", { clientX: 140, pointerId: 51, bubbles: true }),
      );
      document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 51, bubbles: true }));
      controller().valueValueChanged();
      await flushMicrotasks();

      expect(thumb().getAttribute("aria-valuenow")).toBe("70");
      expect(reports()).toEqual([{ name: "change", detail: { value: 70 } }]);
    });

    it("reports nothing when a page write and a key in one task end on the value last published", async () => {
      await mount("40");
      const commits = captureFieldCommits();

      root().setAttribute("data-stimeo--slider-value-value", "45");
      press("ArrowLeft");
      controller().valueValueChanged();
      await flushMicrotasks();

      expect(thumb().getAttribute("aria-valuenow")).toBe("40");
      expect(reports()).toEqual([]);
      expect(commits.seen).toEqual([]);
      commits.stop();
    });

    it("keeps a key pressed inside a reconcile listener a change, and reports nothing after it", async () => {
      await mount("40");
      let spent = false;
      // Registered after the capture, so the recording keeps dispatch order.
      const pressOnce = (): void => {
        if (spent) return;
        spent = true;
        press("ArrowRight");
      };
      document.addEventListener("stimeo--slider:reconcile", pressOnce);

      await declare("60");
      controller().valueValueChanged();
      await flushMicrotasks();
      document.removeEventListener("stimeo--slider:reconcile", pressOnce);

      expect(thumb().getAttribute("aria-valuenow")).toBe("65");
      expect(reports()).toEqual([
        { name: "reconcile", detail: { value: 60 } },
        { name: "change", detail: { value: 65 } },
      ]);
    });
  });
});
