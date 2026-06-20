import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransitionController } from "../src/controllers/transition_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link TransitionController}: the enter/leave class staging,
 * completion on transitionend and on the safety timeout, the hidden sync, the state
 * hook and events, reduced-motion fast-path, interruption, toggle, and teardown.
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
    application.stop();
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
  const endTransition = () => el().dispatchEvent(new Event("transitionend"));

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
    const events: string[] = [];
    el().addEventListener("stimeo--transition:entered", () => events.push("entered"));
    el().addEventListener("stimeo--transition:left", () => events.push("left"));

    instance().enter();
    vi.advanceTimersToNextFrame();
    instance().leave(); // interrupt mid-enter
    vi.advanceTimersToNextFrame();
    endTransition();

    expect(state()).toBe("left");
    expect(el().hidden).toBe(true);
    expect(events).toEqual(["left"]); // the interrupted enter never reports entered
  });

  it("toggles direction based on the current state", async () => {
    await mount();
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expectNoA11yViolations(el());
  });
});
