import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CarouselController } from "../src/controllers/carousel_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link CarouselController}: the APG tabbed Carousel — slide
 * navigation with `data-state`/`hidden` sync, picker `aria-selected` + roving
 * tabindex, autoplay that pauses on hover and hard-stops on focus (WCAG 2.2.2),
 * and timer teardown on disconnect.
 */

const markup = (attrs = "") => `
  <section data-controller="stimeo--carousel" aria-roledescription="carousel"
           aria-label="Featured" ${attrs}
           data-action="mouseenter->stimeo--carousel#pause
                        mouseleave->stimeo--carousel#resume
                        focusin->stimeo--carousel#pause
                        focusout->stimeo--carousel#resume">
    <button type="button" aria-label="Slide autoplay"
            data-stimeo--carousel-target="playToggle"
            data-action="stimeo--carousel#togglePlay">Play</button>
    <div data-stimeo--carousel-target="viewport">
      <div id="s1" role="tabpanel" aria-roledescription="slide" aria-label="1 of 3"
           aria-labelledby="d1" data-stimeo--carousel-target="slide">One</div>
      <div id="s2" role="tabpanel" aria-roledescription="slide" aria-label="2 of 3"
           aria-labelledby="d2" data-stimeo--carousel-target="slide" hidden>Two</div>
      <div id="s3" role="tabpanel" aria-roledescription="slide" aria-label="3 of 3"
           aria-labelledby="d3" data-stimeo--carousel-target="slide" hidden>Three</div>
    </div>
    <button type="button" aria-label="Previous" data-stimeo--carousel-target="prev"
            data-action="stimeo--carousel#prev">‹</button>
    <button type="button" aria-label="Next" data-stimeo--carousel-target="next"
            data-action="stimeo--carousel#next">›</button>
    <div role="tablist" aria-label="Slides">
      <button id="d1" role="tab" aria-selected="true" aria-controls="s1" aria-label="Slide 1"
              tabindex="0" data-stimeo--carousel-target="picker"
              data-action="stimeo--carousel#goto keydown->stimeo--carousel#onPickerKeydown"></button>
      <button id="d2" role="tab" aria-selected="false" aria-controls="s2" aria-label="Slide 2"
              tabindex="-1" data-stimeo--carousel-target="picker"
              data-action="stimeo--carousel#goto keydown->stimeo--carousel#onPickerKeydown"></button>
      <button id="d3" role="tab" aria-selected="false" aria-controls="s3" aria-label="Slide 3"
              tabindex="-1" data-stimeo--carousel-target="picker"
              data-action="stimeo--carousel#goto keydown->stimeo--carousel#onPickerKeydown"></button>
    </div>
  </section>`;

describe("CarouselController", () => {
  let application: Application;

  const start = async (attrs = "") => {
    document.body.innerHTML = markup(attrs);
    application = Application.start();
    application.register("stimeo--carousel", CarouselController);
    await vi.advanceTimersByTimeAsync(0);
  };

  // axe and the virtual screen reader rely on real async, so the a11y/speech
  // tests run on the real clock rather than the mocked one.
  const startReal = async (attrs = "") => {
    vi.useRealTimers();
    document.body.innerHTML = markup(attrs);
    application = Application.start();
    application.register("stimeo--carousel", CarouselController);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--carousel']") as HTMLElement;
  const slides = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--carousel-target='slide']"));
  const pickers = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--carousel-target='picker']"));
  const playToggle = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--carousel-target='playToggle']",
    ) as HTMLElement;
  const states = () => slides().map((slide) => slide.getAttribute("data-state"));
  const selected = () => pickers().map((picker) => picker.getAttribute("aria-selected"));

  it("activates the first slide and hides the rest on connect", async () => {
    await start();
    expect(states()).toEqual(["active", "inactive", "inactive"]);
    expect(slides().map((slide) => slide.hidden)).toEqual([false, true, true]);
    expect(selected()).toEqual(["true", "false", "false"]);
  });

  it("advances to the next slide and syncs state hooks", async () => {
    await start();
    document
      .querySelector<HTMLElement>("[data-stimeo--carousel-target='next']")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(states()).toEqual(["inactive", "active", "inactive"]);
    expect(slides().map((slide) => slide.hidden)).toEqual([true, false, true]);
    expect(selected()).toEqual(["false", "true", "false"]);
  });

  it("wraps from the last slide to the first when loop is on (default)", async () => {
    await start();
    const next = document.querySelector<HTMLElement>("[data-stimeo--carousel-target='next']");
    next?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    next?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    next?.dispatchEvent(new MouseEvent("click", { bubbles: true })); // wraps
    expect(states()).toEqual(["active", "inactive", "inactive"]);
  });

  it("clamps at the ends when loop is false", async () => {
    await start('data-stimeo--carousel-loop-value="false"');
    document
      .querySelector<HTMLElement>("[data-stimeo--carousel-target='prev']")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(states()).toEqual(["active", "inactive", "inactive"]);
  });

  it("does not emit change when clamped at an end (loop off)", async () => {
    await start('data-stimeo--carousel-loop-value="false"');
    const detail: unknown[] = [];
    root().addEventListener("stimeo--carousel:change", (e) =>
      detail.push((e as CustomEvent).detail),
    );
    // Already on the first slide: prev clamps to the same index, so no change fires.
    document
      .querySelector<HTMLElement>("[data-stimeo--carousel-target='prev']")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(detail).toEqual([]);
  });

  it("jumps to a slide when its picker is activated", async () => {
    await start();
    pickers()[2]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(states()).toEqual(["inactive", "inactive", "active"]);
    expect(selected()).toEqual(["false", "false", "true"]);
  });

  it("emits change with the index and total", async () => {
    await start();
    const detail: Array<{ index: number; total: number }> = [];
    root().addEventListener("stimeo--carousel:change", (event) => {
      detail.push((event as CustomEvent<{ index: number; total: number }>).detail);
    });
    document
      .querySelector<HTMLElement>("[data-stimeo--carousel-target='next']")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(detail).toEqual([{ index: 1, total: 3 }]);
  });

  it("moves picker focus only with the arrow keys (manual activation)", async () => {
    await start();
    pickers()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(pickers()[1]);
    // The active slide and aria-selected are unchanged by mere focus movement.
    expect(states()).toEqual(["active", "inactive", "inactive"]);
    expect(selected()).toEqual(["true", "false", "false"]);
  });

  it("activates the last slide on End within the picker", async () => {
    await start();
    pickers()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(states()).toEqual(["inactive", "inactive", "active"]);
    expect(document.activeElement).toBe(pickers()[2]);
  });

  it("wraps picker focus backward with ArrowLeft (focus only, no activation)", async () => {
    await start();
    // ArrowLeft from the first picker wraps focus to the last; the slide is unchanged.
    pickers()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(document.activeElement).toBe(pickers()[2]);
    expect(states()).toEqual(["active", "inactive", "inactive"]);
    expect(selected()).toEqual(["true", "false", "false"]);
  });

  it("activates the first slide on Home within the picker", async () => {
    await start();
    // Move to the last slide first, then Home returns focus and activation to the first.
    pickers()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(states()).toEqual(["inactive", "inactive", "active"]);
    pickers()[2]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(states()).toEqual(["active", "inactive", "inactive"]);
    expect(document.activeElement).toBe(pickers()[0]);
  });

  it("toggles autoplay and reflects aria-pressed", async () => {
    await start('data-stimeo--carousel-interval-value="1000"');
    expect(playToggle().getAttribute("aria-pressed")).toBe("false");

    playToggle().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(playToggle().getAttribute("aria-pressed")).toBe("true");

    vi.advanceTimersByTime(1000);
    expect(states()).toEqual(["inactive", "active", "inactive"]);
  });

  it("starts autoplay on connect when autoplay is true", async () => {
    await start(
      'data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="500"',
    );
    expect(playToggle().getAttribute("aria-pressed")).toBe("true");
    vi.advanceTimersByTime(500);
    expect(states()).toEqual(["inactive", "active", "inactive"]);
  });

  it("suspends autoplay on hover and resumes on leave", async () => {
    await start(
      'data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="500"',
    );

    root().dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    vi.advanceTimersByTime(1000);
    expect(states()).toEqual(["active", "inactive", "inactive"]); // paused, no advance

    root().dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    vi.advanceTimersByTime(500);
    expect(states()).toEqual(["inactive", "active", "inactive"]); // resumed
  });

  it("hard-stops autoplay when focus enters and does not auto-resume on focus out", async () => {
    await start(
      'data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="500"',
    );

    root().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(playToggle().getAttribute("aria-pressed")).toBe("false");

    root().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    vi.advanceTimersByTime(1000);
    expect(states()).toEqual(["active", "inactive", "inactive"]); // stays stopped
    expect(playToggle().getAttribute("aria-pressed")).toBe("false");
  });

  it("hard-stops autoplay at the last slide when loop is off", async () => {
    await start(
      'data-stimeo--carousel-loop-value="false" data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="500"',
    );
    vi.advanceTimersByTime(500); // -> slide 2
    expect(states()).toEqual(["inactive", "active", "inactive"]);

    vi.advanceTimersByTime(500); // -> slide 3 (last): nothing left to advance to
    expect(states()).toEqual(["inactive", "inactive", "active"]);
    // Autoplay turned itself off, so the toggle reflects the stop…
    expect(playToggle().getAttribute("aria-pressed")).toBe("false");

    // …and the interval is gone — further time never wraps or re-advances.
    vi.advanceTimersByTime(2000);
    expect(states()).toEqual(["inactive", "inactive", "active"]);
  });

  it("clears the autoplay interval on disconnect", async () => {
    await start(
      'data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="500"',
    );
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--carousel",
    ) as CarouselController;
    controller.disconnect();
    vi.advanceTimersByTime(2000);
    expect(states()).toEqual(["active", "inactive", "inactive"]);
  });

  it("restores the stopped autoplay state from aria-pressed after a Turbo reconnect", async () => {
    // Simulates a Turbo cache restore / morph: the cached DOM carries the
    // runtime aria-pressed="false" a focus hard-stop left behind, while the
    // declarative autoplay value is still true. The DOM state must win, so
    // connect() does not silently resume autoplay the user had stopped.
    document.body.innerHTML = markup(
      'data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="500"',
    ).replace(
      'data-stimeo--carousel-target="playToggle"',
      'aria-pressed="false" data-stimeo--carousel-target="playToggle"',
    );
    application = Application.start();
    application.register("stimeo--carousel", CarouselController);
    await vi.advanceTimersByTimeAsync(0);

    expect(playToggle().getAttribute("aria-pressed")).toBe("false");
    vi.advanceTimersByTime(1000);
    expect(states()).toEqual(["active", "inactive", "inactive"]);
  });

  it("has no machine-detectable a11y violations", async () => {
    await startReal();
    await expectNoA11yViolations(root());
  });

  // Layer ③ — speech-order regression over the picker tablist: role, name, and
  // selected state are announced in order so a lost role/state surfaces as a diff.
  it("announces the tablist pickers with roles and selected state", async () => {
    await startReal();
    const tablist = document.querySelector<HTMLElement>("[role='tablist']") as HTMLElement;
    const phrases = await captureSpeech({ container: tablist, steps: 3 });
    expect(phrases).toEqual([
      "tablist, Slides, orientated horizontally",
      "tab, Slide 1, selected, position 1, set size 3",
      "tab, Slide 2, not selected, position 2, set size 3",
      "tab, Slide 3, not selected, position 3, set size 3",
    ]);
  });
});
