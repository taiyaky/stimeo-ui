import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransitionController } from "../src/controllers/transition_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link TransitionController}: the enter/leave class staging,
 * completion through the shared TransitionCompletion (per-property terminal events,
 * transitioncancel, pseudo-element exclusion, bounded fallback, synchronous 0ms
 * settle), the timeout-Value override, the hidden sync, the state hook and events,
 * reduced-motion fast-path, interruption, toggle, and teardown.
 */

let originalMatchMedia: typeof window.matchMedia;
const setReducedMotion = (reduce: boolean) => {
  window.matchMedia = ((queryString: string) => ({
    media: queryString,
    matches: reduce && queryString.includes("prefers-reduced-motion"),
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;
};

const ATTRS =
  'data-stimeo--transition-enter-value="ease-out" data-stimeo--transition-enter-from-value="opacity-0" data-stimeo--transition-enter-to-value="opacity-100" data-stimeo--transition-leave-value="ease-in" data-stimeo--transition-leave-from-value="opacity-100" data-stimeo--transition-leave-to-value="opacity-0"';

/** Creates the minimal Web Animations view exposed by a running CSS transition. */
const runningTransition = (propertyName: string): CSSTransition =>
  ({
    playState: "running",
    transitionProperty: propertyName,
  }) as CSSTransition;

describe("TransitionController", () => {
  let application: Application;

  const mount = async (attrs = ATTRS, hidden = "hidden") => {
    document.body.innerHTML = `<div data-controller="stimeo--transition" ${attrs} ${hidden}>x</div>`;
    application = Application.start();
    application.register("stimeo--transition", TransitionController);
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    originalMatchMedia = window.matchMedia;
    setReducedMotion(false);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.matchMedia = originalMatchMedia;
    document.body.innerHTML = "";
  });

  const el = () => query("[data-controller='stimeo--transition']");
  const instance = () =>
    application.getControllerForElementAndIdentifier(
      el(),
      "stimeo--transition",
    ) as TransitionController;
  const state = () => el().getAttribute("data-transition-state");
  const has = (cls: string) => el().classList.contains(cls);
  /** Simulates the consumer CSS the completion wait reads from computed styles. */
  const stubTransition = (property = "opacity", duration = "200ms", delay = "0s") =>
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      transitionProperty: property,
      transitionDuration: duration,
      transitionDelay: delay,
    } as CSSStyleDeclaration);
  const endTransition = (
    propertyName = "opacity",
    type: "transitionend" | "transitioncancel" = "transitionend",
    pseudoElement = "",
  ) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, "propertyName", { value: propertyName });
    Object.defineProperty(event, "pseudoElement", { value: pseudoElement });
    el().dispatchEvent(event);
  };

  it("reconciles state to match visibility on connect", async () => {
    await mount();
    expect(state()).toBe("left"); // started hidden
    expect(el().hidden).toBe(true);
  });

  it("settles to entered without a hidden element on connect", async () => {
    await mount(ATTRS, ""); // not hidden
    expect(state()).toBe("entered");
  });

  it("stages enter classes and completes on transitionend", async () => {
    await mount();
    stubTransition();
    const entered: number[] = [];
    el().addEventListener("stimeo--transition:entered", () => entered.push(1));

    instance().enter();
    expect(el().hidden).toBe(false);
    expect(state()).toBe("entering");
    expect(has("opacity-0")).toBe(true); // enterFrom applied immediately
    expect(has("opacity-100")).toBe(false);

    vi.advanceTimersToNextFrame(); // next frame swaps from → to
    expect(has("opacity-0")).toBe(false);
    expect(has("opacity-100")).toBe(true);
    expect(state()).toBe("entering"); // not done until transitionend

    endTransition();
    expect(state()).toBe("entered");
    expect(has("opacity-100")).toBe(false); // stage classes stripped on completion
    expect(has("ease-out")).toBe(false);
    expect(entered).toEqual([1]);
  });

  it("re-hides the element and fires left when leaving completes", async () => {
    await mount(ATTRS, ""); // start visible
    stubTransition();
    const left: number[] = [];
    el().addEventListener("stimeo--transition:left", () => left.push(1));

    instance().leave();
    expect(state()).toBe("leaving");
    expect(el().hidden).toBe(false); // stays visible during the leave

    vi.advanceTimersToNextFrame();
    endTransition();
    expect(state()).toBe("left");
    expect(el().hidden).toBe(true);
    expect(left).toEqual([1]);
  });

  it("settles synchronously at the staging frame when no transition is declared", async () => {
    await mount();
    stubTransition("opacity", "0s"); // effective 0ms — nothing will ever animate
    const entered: number[] = [];
    el().addEventListener("stimeo--transition:entered", () => entered.push(1));

    instance().enter();
    expect(state()).toBe("entering"); // staged until the frame commits

    vi.advanceTimersToNextFrame();
    expect(state()).toBe("entered"); // no event, no timer — settled at the frame
    expect(entered).toEqual([1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for every declared transition property before settling", async () => {
    await mount();
    stubTransition("opacity, transform", "100ms, 300ms");
    instance().enter();
    vi.advanceTimersToNextFrame();

    endTransition("opacity"); // the shorter property alone must not settle
    expect(state()).toBe("entering");

    endTransition("transform");
    expect(state()).toBe("entered");
  });

  it("settles immediately when the transition is cancelled", async () => {
    await mount(ATTRS, ""); // start visible
    stubTransition("transform", "300ms");
    instance().leave();
    vi.advanceTimersToNextFrame();
    expect(state()).toBe("leaving");

    endTransition("transform", "transitioncancel");
    expect(state()).toBe("left"); // no wait for the fallback timer
    expect(el().hidden).toBe(true);
  });

  it("ignores pseudo-element events and falls back after duration plus delay", async () => {
    await mount();
    stubTransition("opacity", "200ms", "100ms");
    instance().enter();
    vi.advanceTimersToNextFrame();

    endTransition("opacity", "transitionend", "::before"); // a pseudo transition is not ours
    expect(state()).toBe("entering");

    vi.advanceTimersByTime(349); // bounded fallback = 200 + 100 + 50
    expect(state()).toBe("entering");
    vi.advanceTimersByTime(1);
    expect(state()).toBe("entered");
  });

  it("completes via the safety timeout when transitionend never fires", async () => {
    await mount(`${ATTRS} data-stimeo--transition-timeout-value="200"`);
    instance().enter();
    vi.advanceTimersToNextFrame();
    expect(state()).toBe("entering");

    vi.advanceTimersByTime(199);
    expect(state()).toBe("entering");
    vi.advanceTimersByTime(1);
    expect(state()).toBe("entered");
  });

  it("lets a positive timeout value replace the auto-computed fallback", async () => {
    await mount(`${ATTRS} data-stimeo--transition-timeout-value="100"`);
    stubTransition("opacity", "300ms"); // auto fallback would be 350ms
    instance().enter();
    vi.advanceTimersToNextFrame();
    expect(state()).toBe("entering");

    vi.advanceTimersByTime(100); // the author-declared budget wins
    expect(state()).toBe("entered");
  });

  it("switches instantly under reduced motion (no staging)", async () => {
    setReducedMotion(true);
    await mount();
    const entered: number[] = [];
    el().addEventListener("stimeo--transition:entered", () => entered.push(1));

    instance().enter();
    expect(state()).toBe("entered");
    expect(el().hidden).toBe(false);
    expect(has("opacity-0")).toBe(false); // no stage classes applied at all
    expect(entered).toEqual([1]);
  });

  it("cancels an in-flight enter when interrupted by leave", async () => {
    await mount();
    stubTransition();
    let animations: Animation[] = [runningTransition("opacity")];
    Object.defineProperty(el(), "getAnimations", {
      configurable: true,
      value: () => animations,
    });
    const events: string[] = [];
    el().addEventListener("stimeo--transition:entered", () => events.push("entered"));
    el().addEventListener("stimeo--transition:left", () => events.push("left"));

    instance().enter();
    vi.advanceTimersToNextFrame();
    instance().leave(); // interrupt mid-enter
    vi.advanceTimersToNextFrame();
    endTransition("opacity", "transitioncancel"); // queued cancellation from the old enter

    expect(state()).toBe("leaving");
    expect(el().hidden).toBe(false);
    expect(events).toEqual([]);

    animations = [];
    endTransition();
    expect(state()).toBe("left");
    expect(el().hidden).toBe(true);
    expect(events).toEqual(["left"]); // the interrupted enter never reports entered
  });

  it("toggles direction based on the current state", async () => {
    await mount();
    stubTransition();
    instance().toggle(); // hidden → enter
    expect(state()).toBe("entering");
    vi.advanceTimersToNextFrame();
    endTransition();
    expect(state()).toBe("entered");

    instance().toggle(); // entered → leave
    expect(state()).toBe("leaving");
    vi.advanceTimersToNextFrame();
    endTransition();
    expect(state()).toBe("left");
  });

  it("strips a half-applied stage class left in a cache on connect", async () => {
    document.body.innerHTML = `<div data-controller="stimeo--transition" ${ATTRS} class="opacity-0">x</div>`;
    application = Application.start();
    application.register("stimeo--transition", TransitionController);
    await vi.advanceTimersByTimeAsync(0);
    expect(has("opacity-0")).toBe(false); // stale stage class removed
  });

  it("cancels timers and listeners on disconnect", async () => {
    await mount(`${ATTRS} data-stimeo--transition-timeout-value="200"`);
    const entered: number[] = [];
    el().addEventListener("stimeo--transition:entered", () => entered.push(1));
    instance().enter();
    vi.advanceTimersToNextFrame();

    el().remove();
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(500); // the safety timeout must not fire post-teardown
    expect(entered).toEqual([]);
  });

  it("has no a11y violations", async () => {
    vi.useRealTimers();
    document.body.innerHTML = `<div data-controller="stimeo--transition" ${ATTRS}>content</div>`;
    application = Application.start();
    application.register("stimeo--transition", TransitionController);
    await tick();
    await expectNoA11yViolations(el());
  });
});
