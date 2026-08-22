import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CarouselController } from "../src/controllers/carousel_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link CarouselController}: the APG Carousel — slide
 * navigation with `data-state`/`hidden`/`inert` sync, picker `aria-selected` +
 * roving tabindex, autoplay whose intent lives in the `autoplay` Value and whose
 * suspensions (hover, focus, hidden tab) each lift on their own, the leased ARIA
 * on the step controls and the slide container, and timer teardown on disconnect.
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

/** Builds a carousel with an arbitrary picker/slide split and no authored pre-selection. */
const skewedMarkup = (slides: number, pickers: number, attrs = "") => `
  <section data-controller="stimeo--carousel" aria-roledescription="carousel"
           aria-label="Featured" ${attrs}>
    <button type="button" aria-label="Slide autoplay"
            data-stimeo--carousel-target="playToggle"
            data-action="stimeo--carousel#togglePlay">Play</button>
    <div data-stimeo--carousel-target="viewport">
      ${Array.from(
        { length: slides },
        (_, i) =>
          `<div id="s${i + 1}" role="tabpanel" aria-label="${i + 1}" data-stimeo--carousel-target="slide"${
            i > 0 ? " hidden inert" : ""
          }>S${i + 1}</div>`,
      ).join("")}
    </div>
    <button type="button" aria-label="Previous" data-stimeo--carousel-target="prev"
            data-action="stimeo--carousel#prev">‹</button>
    <button type="button" aria-label="Next" data-stimeo--carousel-target="next"
            data-action="stimeo--carousel#next">›</button>
    <div role="tablist" aria-label="Slides">
      ${Array.from(
        { length: pickers },
        (_, i) =>
          `<button id="d${i + 1}" role="tab" aria-label="Slide ${i + 1}"
              data-stimeo--carousel-target="picker"
              data-action="stimeo--carousel#goto keydown->stimeo--carousel#onPickerKeydown"></button>`,
      ).join("")}
    </div>
  </section>`;

/** The same carousel with no `data-action` at all: the delegated path must carry it. */
const actionlessMarkup = () =>
  markup()
    .replace(/data-action="[^"]*"/g, "")
    .replace(/data-action="[\s\S]*?"/g, "");

describe("CarouselController", () => {
  let application: Application;

  const boot = async () => {
    application = Application.start();
    application.register("stimeo--carousel", CarouselController);
    await vi.advanceTimersByTimeAsync(0);
  };

  const start = async (attrs = "") => {
    document.body.innerHTML = markup(attrs);
    await boot();
  };

  const startWith = async (html: string) => {
    document.body.innerHTML = html;
    await boot();
  };

  // axe and the virtual screen reader rely on real async, so the a11y/speech
  // tests run on the real clock rather than the mocked one.
  const startReal = async (attrs = "") => {
    vi.useRealTimers();
    document.body.innerHTML = markup(attrs);
    application = Application.start();
    application.register("stimeo--carousel", CarouselController);
    await tick();
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
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
  const viewport = () =>
    document.querySelector<HTMLElement>("[data-stimeo--carousel-target='viewport']") as HTMLElement;
  const stepControl = (name: "prev" | "next") =>
    document.querySelector<HTMLElement>(`[data-stimeo--carousel-target='${name}']`) as HTMLElement;
  const states = () => slides().map((slide) => slide.getAttribute("data-state"));
  const selected = () => pickers().map((picker) => picker.getAttribute("aria-selected"));
  const click = (element: HTMLElement | undefined) =>
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const press = (element: HTMLElement | undefined, key: string) =>
    element?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  /** Mirrors a real focus move: `focusout` names where focus is going. */
  const moveFocus = (from: HTMLElement | null, to: HTMLElement | null) => {
    from?.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: to }));
    to?.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: from }));
  };

  it("reverses the horizontal arrows under RTL, leaving Down/Up alone", async () => {
    // Logical direction: APG describes the horizontal pair as "next / previous",
    // so it reverses with the writing direction. `dir="rtl"` is the authoring
    // contract, but happy-dom does not resolve it into the computed style, so the
    // direction is set inline instead.
    await start();
    root().style.direction = "rtl";

    press(pickers()[0], "ArrowLeft"); // "next" under RTL
    expect(document.activeElement).toBe(pickers()[1]);

    press(pickers()[1], "ArrowRight"); // "previous"
    expect(document.activeElement).toBe(pickers()[0]);

    press(pickers()[0], "ArrowDown"); // the vertical pair carries no direction
    expect(document.activeElement).toBe(pickers()[1]);
  });

  it("yields a picker key a descendant widget already consumed", async () => {
    // A composed widget that claims the key must not ALSO move the picker focus
    // or change the slide — composition depends on this yield.
    await start();
    pickers()[0]?.focus();
    const inner = document.createElement("span");
    pickers()[0]?.append(inner);
    inner.addEventListener("keydown", (event) => event.preventDefault());

    const claimed = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    const notCanceled = inner.dispatchEvent(claimed);

    expect(notCanceled).toBe(false); // the claim really took (a non-cancelable event would not)
    expect(document.activeElement).toBe(pickers()[0]);
    expect(selected()[0]).toBe("true");
  });

  it("ignores a picker key delivered from outside the picker set", async () => {
    // The action is authored, so it can be wired to a button that is not a
    // picker; the handler has no position to move from and must do nothing.
    await start();
    const stray = document.createElement("button");
    stray.setAttribute("data-action", "keydown->stimeo--carousel#onPickerKeydown");
    root().append(stray);
    await vi.advanceTimersByTimeAsync(0);
    pickers()[0]?.focus();

    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    stray.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(pickers()[0]);
  });

  it("activates the first slide and hides the rest on connect", async () => {
    await start();
    expect(states()).toEqual(["active", "inactive", "inactive"]);
    expect(slides().map((slide) => slide.hidden)).toEqual([false, true, true]);
    expect(selected()).toEqual(["true", "false", "false"]);
  });

  it("keeps inactive slides out of the focus order with inert as well as hidden", async () => {
    // Consumer CSS lays the slides out as a track, which overrides `hidden`;
    // `inert` is the half of the contract that survives that.
    await start();
    expect(slides().map((slide) => slide.hasAttribute("inert"))).toEqual([false, true, true]);

    click(stepControl("next"));
    expect(slides().map((slide) => slide.hasAttribute("inert"))).toEqual([true, false, true]);
  });

  it("advances to the next slide and syncs state hooks", async () => {
    await start();
    click(stepControl("next"));
    expect(states()).toEqual(["inactive", "active", "inactive"]);
    expect(slides().map((slide) => slide.hidden)).toEqual([true, false, true]);
    expect(selected()).toEqual(["false", "true", "false"]);
  });

  it("wraps from the last slide to the first when loop is on (default)", async () => {
    await start();
    click(stepControl("next"));
    click(stepControl("next"));
    click(stepControl("next")); // wraps
    expect(states()).toEqual(["active", "inactive", "inactive"]);
  });

  it("clamps at the ends when loop is false", async () => {
    await start('data-stimeo--carousel-loop-value="false"');
    click(stepControl("prev"));
    expect(states()).toEqual(["active", "inactive", "inactive"]);
  });

  it("does not emit change when clamped at an end (loop off)", async () => {
    await start('data-stimeo--carousel-loop-value="false"');
    const detail: unknown[] = [];
    root().addEventListener("stimeo--carousel:change", (e) =>
      detail.push((e as CustomEvent).detail),
    );
    // Already on the first slide: prev clamps to the same index, so no change fires.
    click(stepControl("prev"));
    expect(detail).toEqual([]);
  });

  it("jumps to a slide when its picker is activated", async () => {
    await start();
    click(pickers()[2]);
    expect(states()).toEqual(["inactive", "inactive", "active"]);
    expect(selected()).toEqual(["false", "false", "true"]);
  });

  it("emits change with the index and total", async () => {
    await start();
    const detail: Array<{ index: number; total: number }> = [];
    root().addEventListener("stimeo--carousel:change", (event) => {
      detail.push((event as CustomEvent<{ index: number; total: number }>).detail);
    });
    click(stepControl("next"));
    expect(detail).toEqual([{ index: 1, total: 3 }]);
  });

  it("moves picker focus only with the arrow keys (manual activation)", async () => {
    await start();
    press(pickers()[0], "ArrowRight");
    expect(document.activeElement).toBe(pickers()[1]);
    // The active slide and aria-selected are unchanged by mere focus movement.
    expect(states()).toEqual(["active", "inactive", "inactive"]);
    expect(selected()).toEqual(["true", "false", "false"]);
  });

  it("leaves a modified arrow to the browser", async () => {
    // Alt+Arrow is a browser binding: the picker neither moves focus nor calls
    // preventDefault().
    await start();
    pickers()[0]?.focus();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    pickers()[0]?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(pickers()[0]);
    expect(selected()).toEqual(["true", "false", "false"]);
  });

  it("leaves a modified Home or End to the browser", async () => {
    // `Control+Home` scrolls the document. A widget that swallows it makes the
    // shortcut work or not depending on where focus happens to sit.
    await start();
    pickers()[0]?.focus();

    for (const key of ["Home", "End"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      pickers()[0]?.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(pickers()[0]);
    }
    expect(states()).toEqual(["active", "inactive", "inactive"]);
  });

  it("moves picker focus only with Home and End (manual activation)", async () => {
    // Same contract as the arrows: within a manually-activated tablist every key
    // moves focus, and Enter/Space/click is what commits.
    await start();
    press(pickers()[0], "End");
    expect(document.activeElement).toBe(pickers()[2]);
    expect(states()).toEqual(["active", "inactive", "inactive"]);
    expect(selected()).toEqual(["true", "false", "false"]);

    press(pickers()[2], "Home");
    expect(document.activeElement).toBe(pickers()[0]);
    expect(states()).toEqual(["active", "inactive", "inactive"]);
  });

  it("lands End on the last picker even when the sets are not paired one to one", async () => {
    await startWith(skewedMarkup(4, 2));
    press(pickers()[0], "End");
    expect(document.activeElement).toBe(pickers()[1]);
    expect(states()).toEqual(["active", "inactive", "inactive", "inactive"]);
  });

  it("wraps picker focus backward with ArrowLeft (focus only, no activation)", async () => {
    await start();
    // ArrowLeft from the first picker wraps focus to the last; the slide is unchanged.
    press(pickers()[0], "ArrowLeft");
    expect(document.activeElement).toBe(pickers()[2]);
    expect(states()).toEqual(["active", "inactive", "inactive"]);
    expect(selected()).toEqual(["true", "false", "false"]);
  });

  it("keeps exactly one slide visible when more pickers than slides exist", async () => {
    // The picker set can outrun the slide set. An index taken straight from the
    // picker would fall outside the slides and hide every one of them.
    await startWith(skewedMarkup(2, 4));
    click(pickers()[3]);

    expect(slides().filter((slide) => !slide.hidden)).toHaveLength(1);
    expect(states()).toEqual(["inactive", "active"]);
  });

  it("survives next and prev with no slides at all", async () => {
    await startWith(skewedMarkup(0, 2));
    const changes: unknown[] = [];
    root().addEventListener("stimeo--carousel:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });

    click(stepControl("next"));
    click(stepControl("prev"));

    expect(changes).toEqual([]);
    expect(pickers().filter((picker) => picker.tabIndex === 0)).toHaveLength(1);
  });

  describe("initial slide resolution", () => {
    it("honors an authored pre-selection on a picker other than the first", async () => {
      await startWith(
        skewedMarkup(3, 3).replace('id="d3" role="tab"', 'id="d3" role="tab" aria-selected="true"'),
      );
      expect(states()).toEqual(["inactive", "inactive", "active"]);
      expect(pickers().map((picker) => picker.tabIndex)).toEqual([-1, -1, 0]);
    });

    it("falls back to the first slide when no picker is pre-selected", async () => {
      await startWith(skewedMarkup(3, 3));
      expect(states()).toEqual(["active", "inactive", "inactive"]);
      expect(selected()).toEqual(["true", "false", "false"]);
    });

    it("keeps the first of several authored pre-selections", async () => {
      await startWith(
        skewedMarkup(3, 3)
          .replace('id="d2" role="tab"', 'id="d2" role="tab" aria-selected="true"')
          .replace('id="d3" role="tab"', 'id="d3" role="tab" aria-selected="true"'),
      );
      expect(states()).toEqual(["inactive", "active", "inactive"]);
      expect(selected()).toEqual(["false", "true", "false"]);
    });

    it("restores the visible slide from data-state with no pickers present", async () => {
      // A Turbo cache restore hands back the slides the controller last painted.
      // Nothing else carries the position when the carousel has no tablist.
      const html = skewedMarkup(3, 0)
        .replace('id="s1"', 'id="s1" data-state="inactive" hidden inert')
        .replace('id="s2" role="tabpanel" aria-label="2"', 'id="s2" data-state="active"')
        .replace('id="s3"', 'id="s3" data-state="inactive"');
      await startWith(html);

      expect(states()).toEqual(["inactive", "active", "inactive"]);
      expect(slides().map((slide) => slide.hidden)).toEqual([true, false, true]);
    });
  });

  describe("autoplay", () => {
    it("toggles autoplay, writes the intent back to the Value, and reflects aria-pressed", async () => {
      await start('data-stimeo--carousel-interval-value="1000"');
      expect(playToggle().getAttribute("aria-pressed")).toBe("false");
      // A carousel with somewhere to rotate to keeps its toggle available.
      expect(playToggle().hasAttribute("aria-disabled")).toBe(false);

      click(playToggle());
      expect(playToggle().getAttribute("aria-pressed")).toBe("true");
      // The Value is the single source of truth, so it carries the intent through
      // a Turbo cache restore without a second, competing signal.
      expect(root().getAttribute("data-stimeo--carousel-autoplay-value")).toBe("true");

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

    it("starts autoplay even when the toggle carries an authored aria-pressed", async () => {
      // The Value alone decides whether the carousel rotates, so an aria-pressed
      // left on the toggle cannot silence one the author asked to rotate.
      await start(
        'data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="500"',
      );
      playToggle().setAttribute("aria-pressed", "false");
      document.body.innerHTML = markup(
        'data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="500"',
      ).replace(
        'data-stimeo--carousel-target="playToggle"',
        'aria-pressed="false" data-stimeo--carousel-target="playToggle"',
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(playToggle().getAttribute("aria-pressed")).toBe("true");
      vi.advanceTimersByTime(500);
      expect(states()).toEqual(["inactive", "active", "inactive"]);
    });

    it("emits play and pause as the rotation starts and stops", async () => {
      await start('data-stimeo--carousel-interval-value="500"');
      const log: string[] = [];
      root().addEventListener("stimeo--carousel:play", () => log.push("play"));
      root().addEventListener("stimeo--carousel:pause", () => log.push("pause"));

      click(playToggle());
      expect(log).toEqual(["play"]);

      click(playToggle());
      expect(log).toEqual(["play", "pause"]);
    });

    it("publishes whether it is rotating as a state hook on the root", async () => {
      // The events are edges. A consumer that subscribes after connect — every
      // consumer, after a Turbo restore — reads the level from here instead.
      await start('data-stimeo--carousel-interval-value="500"');
      expect(root().dataset.state).toBe("paused");

      click(playToggle());
      expect(root().dataset.state).toBe("playing");

      // A suspension is not the intent: the toggle still reads pressed, but the
      // hook says what is actually happening.
      root().dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      expect(root().dataset.state).toBe("paused");
      expect(playToggle().getAttribute("aria-pressed")).toBe("true");

      root().dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
      expect(root().dataset.state).toBe("playing");
    });

    it("recomputes the run state on connect instead of trusting the cached hook", async () => {
      // A Turbo snapshot carries whatever was on screen. Connecting under a
      // pointer that is no longer there must not leave a stale "playing".
      document.body.innerHTML = markup(
        'data-state="playing" data-stimeo--carousel-interval-value="500"',
      );
      await boot();

      expect(root().dataset.state).toBe("paused");
      expect(playToggle().getAttribute("aria-pressed")).toBe("false");
    });

    it("carries an empty detail on play and pause", async () => {
      // Both are pure notifications: the run state is already readable from the
      // toggle, so an empty detail is the shape consumers can rely on.
      await start('data-stimeo--carousel-interval-value="500"');
      const details: unknown[] = [];
      const record = (event: Event) => details.push((event as CustomEvent).detail);
      root().addEventListener("stimeo--carousel:play", record);
      root().addEventListener("stimeo--carousel:pause", record);

      click(playToggle());
      click(playToggle());

      expect(details).toEqual([{}, {}]);
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

    it("suspends autoplay while focus is inside and resumes when it leaves", async () => {
      await start(
        'data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="500"',
      );
      const outside = document.createElement("button");
      document.body.append(outside);

      moveFocus(null, pickers()[0] ?? null);
      vi.advanceTimersByTime(1000);
      expect(states()).toEqual(["active", "inactive", "inactive"]);
      // The intent is untouched: the suspension is not a stop.
      expect(playToggle().getAttribute("aria-pressed")).toBe("true");

      moveFocus(pickers()[0] ?? null, outside);
      vi.advanceTimersByTime(500);
      expect(states()).toEqual(["inactive", "active", "inactive"]);
    });

    it("holds the focus suspension while focus moves between its own controls", async () => {
      // focusout fires before focusin, so a released suspension would stop and
      // restart the interval — and report it — on every Tab press.
      await start(
        'data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="500"',
      );
      const log: string[] = [];
      root().addEventListener("stimeo--carousel:play", () => log.push("play"));
      root().addEventListener("stimeo--carousel:pause", () => log.push("pause"));

      moveFocus(null, pickers()[0] ?? null);
      expect(log).toEqual(["pause"]);

      moveFocus(pickers()[0] ?? null, pickers()[1] ?? null);
      moveFocus(pickers()[1] ?? null, stepControl("next"));

      expect(log).toEqual(["pause"]);
      vi.advanceTimersByTime(2000);
      expect(states()).toEqual(["active", "inactive", "inactive"]);
    });

    it("stops for good when the toggle is pressed with the pointer over the carousel", async () => {
      // Reaching the toggle means hovering it and focusing it first. Neither may
      // flip the intent, or the press that follows would restart the rotation the
      // user just asked to stop (WCAG 2.2.2).
      await start(
        'data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="500"',
      );

      root().dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      moveFocus(null, playToggle());
      click(playToggle());
      expect(playToggle().getAttribute("aria-pressed")).toBe("false");

      moveFocus(playToggle(), null);
      root().dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
      vi.advanceTimersByTime(2000);

      expect(states()).toEqual(["active", "inactive", "inactive"]);
      expect(playToggle().getAttribute("aria-pressed")).toBe("false");
    });

    it("keeps the intent through a focus move that follows an explicit play", async () => {
      await start('data-stimeo--carousel-interval-value="500"');
      click(playToggle());
      expect(playToggle().getAttribute("aria-pressed")).toBe("true");

      moveFocus(playToggle(), pickers()[0] ?? null);

      expect(playToggle().getAttribute("aria-pressed")).toBe("true");
      expect(root().getAttribute("data-stimeo--carousel-autoplay-value")).toBe("true");
    });

    it("suspends autoplay while the tab is hidden", async () => {
      await start(
        'data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="500"',
      );
      const visibility = vi.spyOn(document, "visibilityState", "get");

      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(2000);
      expect(states()).toEqual(["active", "inactive", "inactive"]);

      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(500);
      expect(states()).toEqual(["inactive", "active", "inactive"]);

      visibility.mockRestore();
    });

    it("does not autostart when the user asked for reduced motion", async () => {
      const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
        (query: string) =>
          ({
            matches: query.includes("prefers-reduced-motion"),
            media: query,
          }) as MediaQueryList,
      );

      await start(
        'data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="500"',
      );
      expect(playToggle().getAttribute("aria-pressed")).toBe("false");
      vi.advanceTimersByTime(2000);
      expect(states()).toEqual(["active", "inactive", "inactive"]);

      // An explicit press still rotates: the preference suppresses the autostart,
      // not the control.
      click(playToggle());
      vi.advanceTimersByTime(500);
      expect(states()).toEqual(["inactive", "active", "inactive"]);

      matchMedia.mockRestore();
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
      expect(playToggle().getAttribute("aria-disabled")).toBe("true");

      // …and the interval is gone — further time never wraps or re-advances.
      vi.advanceTimersByTime(2000);
      expect(states()).toEqual(["inactive", "inactive", "active"]);
    });

    it("marks the toggle unavailable when there is nothing to rotate", async () => {
      await startWith(skewedMarkup(1, 1));
      const log: string[] = [];
      root().addEventListener("stimeo--carousel:play", () => log.push("play"));
      expect(playToggle().getAttribute("aria-disabled")).toBe("true");

      click(playToggle());

      // A toggle that publishes itself as unavailable does not touch the intent
      // at all — the Value is never written, not written and normalized back.
      expect(playToggle().getAttribute("aria-pressed")).toBe("false");
      expect(root().hasAttribute("data-stimeo--carousel-autoplay-value")).toBe(false);
      expect(log).toEqual([]);
    });

    it("follows an interval changed while the rotation is running", async () => {
      await start(
        'data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="1000"',
      );
      const log: string[] = [];
      root().addEventListener("stimeo--carousel:play", () => log.push("play"));
      root().addEventListener("stimeo--carousel:pause", () => log.push("pause"));

      root().setAttribute("data-stimeo--carousel-interval-value", "100");
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(100);

      expect(states()).toEqual(["inactive", "active", "inactive"]);
      // Re-arming is the same state, so it is not reported as a transition.
      expect(log).toEqual([]);
    });

    it("falls back to the default interval for a declaration it cannot read", async () => {
      await start(
        'data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="oops"',
      );
      vi.advanceTimersByTime(100);
      expect(states()).toEqual(["active", "inactive", "inactive"]);

      vi.advanceTimersByTime(4900); // the 5000ms default
      expect(states()).toEqual(["inactive", "active", "inactive"]);
    });

    it("follows an autoplay Value the page changes at runtime", async () => {
      await start('data-stimeo--carousel-interval-value="500"');
      root().setAttribute("data-stimeo--carousel-autoplay-value", "true");
      await vi.advanceTimersByTimeAsync(0);

      expect(playToggle().getAttribute("aria-pressed")).toBe("true");
      vi.advanceTimersByTime(500);
      expect(states()).toEqual(["inactive", "active", "inactive"]);
    });

    it("re-evaluates the non-looping end when loop is turned off at runtime", async () => {
      await start(
        'data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="500"',
      );
      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(500); // -> last slide, still looping

      root().setAttribute("data-stimeo--carousel-loop-value", "false");
      await vi.advanceTimersByTimeAsync(0);

      expect(playToggle().getAttribute("aria-pressed")).toBe("false");
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

    it("keeps rotating after an in-page move that started under the pointer", async () => {
      // Stimulus hands an in-page move to the same controller instance, and the
      // element leaves the pointer without ever firing mouseleave. A suspension
      // carried across that move would never lift.
      document.body.innerHTML = `<div id="from"></div><div id="to"></div>`;
      const from = document.getElementById("from") as HTMLElement;
      from.innerHTML = markup(
        'data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="500"',
      );
      await boot();

      root().dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      (document.getElementById("to") as HTMLElement).appendChild(root());
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(500);

      expect(states()).toEqual(["inactive", "active", "inactive"]);
      expect(playToggle().getAttribute("aria-pressed")).toBe("true");
    });
  });

  describe("published state", () => {
    it("marks the step control a non-looping carousel cannot reach", async () => {
      await start('data-stimeo--carousel-loop-value="false"');
      expect(stepControl("prev").getAttribute("aria-disabled")).toBe("true");
      expect(stepControl("next").hasAttribute("aria-disabled")).toBe(false);

      click(stepControl("next"));
      expect(stepControl("prev").hasAttribute("aria-disabled")).toBe(false);
      expect(stepControl("next").hasAttribute("aria-disabled")).toBe(false);

      click(stepControl("next"));
      expect(stepControl("next").getAttribute("aria-disabled")).toBe("true");
    });

    it("leaves both step controls reachable while the carousel loops", async () => {
      await start();
      expect(stepControl("prev").hasAttribute("aria-disabled")).toBe(false);
      expect(stepControl("next").hasAttribute("aria-disabled")).toBe(false);
    });

    it("switches the slide container's live region with the rotation", async () => {
      await start(
        'data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="500"',
      );
      expect(viewport().getAttribute("aria-live")).toBe("off");
      expect(viewport().getAttribute("aria-atomic")).toBe("false");

      click(playToggle());
      expect(viewport().getAttribute("aria-live")).toBe("polite");
    });

    it("returns every leased attribute on disconnect", async () => {
      await start('data-stimeo--carousel-loop-value="false"');
      expect(stepControl("prev").getAttribute("aria-disabled")).toBe("true");

      const controller = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--carousel",
      ) as CarouselController;
      controller.disconnect();

      expect(stepControl("prev").hasAttribute("aria-disabled")).toBe(false);
      expect(viewport().hasAttribute("aria-live")).toBe(false);
      expect(viewport().hasAttribute("aria-atomic")).toBe(false);
    });
  });

  it("has no machine-detectable a11y violations", async () => {
    await startReal();
    await expectNoA11yViolations(root());
  });

  // Speech-order regression over the picker tablist: role, name, and selected
  // state are announced in order so a lost role/state surfaces as a diff.
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

  describe("wiring", () => {
    it("drives every control with no data-action in the markup", async () => {
      await startWith(actionlessMarkup());
      expect(root().hasAttribute("data-action")).toBe(false);

      click(stepControl("next"));
      expect(states()).toEqual(["inactive", "active", "inactive"]);

      click(stepControl("prev"));
      expect(states()).toEqual(["active", "inactive", "inactive"]);

      click(pickers()[2]);
      expect(states()).toEqual(["inactive", "inactive", "active"]);

      press(pickers()[2], "ArrowLeft");
      expect(document.activeElement).toBe(pickers()[1]);

      click(playToggle());
      expect(playToggle().getAttribute("aria-pressed")).toBe("true");
    });

    it("suspends and resumes from delegated hover with no data-action", async () => {
      await startWith(
        actionlessMarkup().replace(
          'aria-label="Featured"',
          'aria-label="Featured" data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="500"',
        ),
      );

      root().dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      vi.advanceTimersByTime(1000);
      expect(states()).toEqual(["active", "inactive", "inactive"]);

      root().dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
      vi.advanceTimersByTime(500);
      expect(states()).toEqual(["inactive", "active", "inactive"]);
    });

    it("handles one interaction once when an authored action and the delegation overlap", async () => {
      // The default fixture wires every control with data-action, so both paths
      // see each event; a second handling would step two slides, not one.
      await start();
      const detail: unknown[] = [];
      root().addEventListener("stimeo--carousel:change", (event) => {
        detail.push((event as CustomEvent).detail);
      });

      click(stepControl("next"));
      expect(states()).toEqual(["inactive", "active", "inactive"]);

      click(stepControl("prev"));
      expect(states()).toEqual(["active", "inactive", "inactive"]);

      expect(detail).toEqual([
        { index: 1, total: 3 },
        { index: 0, total: 3 },
      ]);
    });

    it("yields a control a descendant already consumed", async () => {
      // Composition: an icon inside the control that claims the click owns it,
      // and neither the authored action nor the delegated path may act.
      await start();
      const consume = (host: HTMLElement) => {
        const icon = document.createElement("span");
        host.append(icon);
        icon.addEventListener("click", (event) => event.preventDefault());
        icon.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      };

      consume(stepControl("next"));
      consume(stepControl("prev"));
      consume(pickers()[2] as HTMLElement);
      consume(playToggle());

      expect(states()).toEqual(["active", "inactive", "inactive"]);
      expect(selected()).toEqual(["true", "false", "false"]);
      expect(playToggle().getAttribute("aria-pressed")).toBe("false");
    });

    it("ignores a picker key pressed on a control that is not a picker", async () => {
      // The delegated keydown sees every key in the carousel; only a picker's
      // may move the roving position.
      await startWith(actionlessMarkup());
      stepControl("next").focus();

      press(stepControl("next"), "ArrowRight");

      expect(document.activeElement).toBe(stepControl("next"));
      expect(pickers().map((picker) => picker.tabIndex)).toEqual([0, -1, -1]);
    });

    it("holds the delegated focus suspension while focus moves between own controls", async () => {
      // Without data-action the delegated focusout is the only path, so this is
      // where the relatedTarget check has to hold.
      await startWith(
        actionlessMarkup().replace(
          'aria-label="Featured"',
          'aria-label="Featured" data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="500"',
        ),
      );
      const log: string[] = [];
      root().addEventListener("stimeo--carousel:play", () => log.push("play"));
      root().addEventListener("stimeo--carousel:pause", () => log.push("pause"));

      moveFocus(null, pickers()[0] ?? null);
      expect(log).toEqual(["pause"]);

      moveFocus(pickers()[0] ?? null, pickers()[1] ?? null);
      moveFocus(pickers()[1] ?? null, stepControl("next"));

      expect(log).toEqual(["pause"]);
      vi.advanceTimersByTime(2000);
      expect(states()).toEqual(["active", "inactive", "inactive"]);
    });

    it("drives a pair added at runtime with no action of its own", async () => {
      // Delegation is what makes this work: a per-element binding would have to
      // be authored onto the new picker before it could be operated.
      await start();
      const slide = document.createElement("div");
      slide.setAttribute("role", "tabpanel");
      slide.setAttribute("aria-label", "4 of 4");
      slide.setAttribute("data-stimeo--carousel-target", "slide");
      viewport().appendChild(slide);
      const tablist = document.querySelector('[role="tablist"]') as HTMLElement;
      const late = document.createElement("button");
      late.type = "button";
      late.setAttribute("role", "tab");
      late.setAttribute("aria-label", "Slide 4");
      late.setAttribute("data-stimeo--carousel-target", "picker");
      tablist.appendChild(late);
      await vi.advanceTimersByTimeAsync(0);

      press(late, "ArrowLeft");
      expect(document.activeElement).toBe(pickers()[2]);

      click(late);
      expect(selected()).toEqual(["false", "false", "false", "true"]);
      expect(states()).toEqual(["inactive", "inactive", "inactive", "active"]);
    });
  });

  describe("a changing target set", () => {
    it("reconciles a retained element whose state attributes are rewritten in place", async () => {
      // A Turbo morph that keeps the elements swaps only their attributes, so no
      // target connects or disconnects and only the observer can see the change.
      await start();
      const repairs: unknown[] = [];
      root().addEventListener("stimeo--carousel:reconcile", (event) => {
        repairs.push((event as CustomEvent).detail);
      });

      for (const slide of slides()) slide.removeAttribute("data-state");
      pickers()[0]?.setAttribute("aria-selected", "false");
      pickers()[2]?.setAttribute("aria-selected", "true");
      await vi.advanceTimersByTimeAsync(0);

      expect(states()).toEqual(["inactive", "inactive", "active"]);
      expect(repairs).toEqual([{ index: 2, total: 3 }]);
    });

    it("does not feed its own repaint back into the observer", async () => {
      // The controller writes the very attributes it watches; an unconditional
      // rewrite would schedule a pass for every pass.
      await start();
      const repairs: unknown[] = [];
      root().addEventListener("stimeo--carousel:reconcile", (event) => {
        repairs.push((event as CustomEvent).detail);
      });

      click(stepControl("next"));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(states()).toEqual(["inactive", "active", "inactive"]);
      expect(repairs).toEqual([]);
    });

    it("re-establishes the single selected picker", async () => {
      // The authored pre-selection is only read on connect, so an appended picker
      // that arrives `aria-selected="true"` has to be resolved as it connects or
      // two pickers stay marked at once.
      await start();
      expect(selected()).toEqual(["true", "false", "false"]);

      const tablist = document.querySelector('[role="tablist"]') as HTMLElement;
      const slide = document.createElement("div");
      slide.id = "s4";
      slide.setAttribute("role", "tabpanel");
      slide.setAttribute("aria-labelledby", "d4");
      slide.setAttribute("data-stimeo--carousel-target", "slide");
      slide.textContent = "Four";
      viewport().appendChild(slide);
      const late = document.createElement("button");
      late.id = "d4";
      late.type = "button";
      late.setAttribute("role", "tab");
      late.setAttribute("aria-selected", "true");
      late.setAttribute("aria-controls", "s4");
      late.setAttribute("aria-label", "Slide 4");
      late.setAttribute("data-stimeo--carousel-target", "picker");
      tablist.appendChild(late);
      await vi.advanceTimersByTimeAsync(0);

      // The current slide is kept: a late arrival never steals the selection.
      expect(selected()).toEqual(["true", "false", "false", "false"]);
      expect(pickers().map((picker) => picker.tabIndex)).toEqual([0, -1, -1, -1]);
    });

    it("re-establishes selection and the Tab stop when the active pair is removed", async () => {
      await start();
      click(pickers()[2]);
      expect(states()).toEqual(["inactive", "inactive", "active"]);

      slides()[2]?.remove();
      pickers()[2]?.remove();
      await vi.advanceTimersByTimeAsync(0);

      expect(states()).toEqual(["inactive", "active"]);
      expect(selected()).toEqual(["false", "true"]);
      expect(pickers().map((picker) => picker.tabIndex)).toEqual([-1, 0]);
    });

    it("reports a slide clamped by removal as reconcile, not change", async () => {
      await start();
      click(pickers()[2]);
      const changes: unknown[] = [];
      const repairs: unknown[] = [];
      root().addEventListener("stimeo--carousel:change", (event) => {
        changes.push((event as CustomEvent).detail);
      });
      root().addEventListener("stimeo--carousel:reconcile", (event) => {
        repairs.push((event as CustomEvent).detail);
      });

      slides()[2]?.remove();
      pickers()[2]?.remove();
      await vi.advanceTimersByTimeAsync(0);

      // The clamp onto the nearest surviving slide is the controller's decision.
      expect(repairs).toEqual([{ index: 1, total: 2 }]);
      expect(changes).toEqual([]);
    });

    it("reports a changed total even when the visible slide stays put", async () => {
      // Consumers render "n of m" from the detail, so a set that grew or shrank
      // behind an unmoved index still has to reach them.
      await start();
      const repairs: unknown[] = [];
      root().addEventListener("stimeo--carousel:reconcile", (event) => {
        repairs.push((event as CustomEvent).detail);
      });

      slides()[2]?.remove();
      await vi.advanceTimersByTimeAsync(0);

      expect(repairs).toEqual([{ index: 0, total: 2 }]);
    });

    /** Appends a bare slide so a reconciliation runs against a changed target set. */
    const appendSlide = () => {
      const slide = document.createElement("div");
      slide.setAttribute("role", "tabpanel");
      slide.setAttribute("data-stimeo--carousel-target", "slide");
      viewport().appendChild(slide);
    };

    it("keeps the live active slide when a picker claims a different one", async () => {
      await start();
      click(pickers()[2]);
      expect(states()).toEqual(["inactive", "inactive", "active"]);

      // The page marks a second picker selected. What the reader is actually
      // looking at is the live slide, so it outranks the picker's claim.
      pickers()[0]?.setAttribute("aria-selected", "true");
      appendSlide();
      await vi.advanceTimersByTimeAsync(0);

      expect(states()).toEqual(["inactive", "inactive", "active", "inactive"]);
    });

    it("keeps the live active slide when an inserted slide claims to be active", async () => {
      // Two slides claiming `active` is a conflict only the element the last
      // render actually showed can settle.
      await start();
      click(pickers()[1]);
      expect(states()).toEqual(["inactive", "active", "inactive"]);

      const intruder = document.createElement("div");
      intruder.setAttribute("role", "tabpanel");
      intruder.setAttribute("data-stimeo--carousel-target", "slide");
      intruder.setAttribute("data-state", "active");
      viewport().insertBefore(intruder, viewport().firstChild);
      await vi.advanceTimersByTimeAsync(0);

      expect(states()).toEqual(["inactive", "inactive", "active", "inactive"]);
      expect(slides()[2]?.id).toBe("s2");
    });

    it("falls back to the selected picker when no slide is marked active", async () => {
      await start();
      // A render can arrive with the picker marked and no slide state yet.
      for (const slide of slides()) slide.removeAttribute("data-state");
      pickers()[0]?.setAttribute("aria-selected", "false");
      pickers()[2]?.setAttribute("aria-selected", "true");
      appendSlide();
      await vi.advanceTimersByTimeAsync(0);

      expect(states()).toEqual(["inactive", "inactive", "active", "inactive"]);
    });

    it("falls back to the first position when every slide is removed", async () => {
      await start();
      for (const slide of slides()) slide.remove();
      await vi.advanceTimersByTimeAsync(0);

      // No slide survives, but the tablist still needs exactly one Tab stop.
      expect(pickers().filter((picker) => picker.tabIndex === 0)).toHaveLength(1);
      expect(selected()).toEqual(["true", "false", "false"]);
    });

    it("keeps one Tab stop when only the active picker leaves", async () => {
      await start();
      click(pickers()[2]);
      expect(states()).toEqual(["inactive", "inactive", "active"]);

      // The slide stays and only its picker leaves, so the picker set is shorter
      // than the slide set and the active index falls outside it.
      pickers()[2]?.remove();
      await vi.advanceTimersByTimeAsync(0);

      expect(pickers().filter((picker) => picker.tabIndex === 0)).toHaveLength(1);
      expect(selected().filter((state) => state === "true")).toHaveLength(1);
    });
  });
});
