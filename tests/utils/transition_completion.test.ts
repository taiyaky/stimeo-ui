import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maxTransitionTotalMs, TransitionCompletion } from "../../src/utils/transition_completion";

const style = (
  transitionProperty: string,
  transitionDuration: string,
  transitionDelay = "0s",
): CSSStyleDeclaration =>
  ({
    transitionProperty,
    transitionDuration,
    transitionDelay,
  }) as CSSStyleDeclaration;

const dispatchTerminal = (
  element: HTMLElement,
  type: "transitionend" | "transitioncancel",
  propertyName: string,
  pseudoElement = "",
): void => {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "propertyName", { value: propertyName });
  Object.defineProperty(event, "pseudoElement", { value: pseudoElement });
  element.dispatchEvent(event);
};

/** Creates the minimal Web Animations view exposed by a running CSS transition. */
const runningTransition = (propertyName: string): CSSTransition =>
  ({
    playState: "running",
    transitionProperty: propertyName,
  }) as CSSTransition;

/** Unit tests for the shared, bounded CSS transition completion lifecycle. */
describe("TransitionCompletion", () => {
  let element: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    element = document.createElement("div");
    document.body.append(element);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("pairs duration and delay lists using CSS repetition and negative delays", () => {
    expect(
      maxTransitionTotalMs(style("opacity, transform, color", "100ms, 0.2s", "50ms, -25ms")),
    ).toBe(175);
  });

  it("ignores transition-property none even when a duration is declared", () => {
    expect(maxTransitionTotalMs(style("none", "2s"))).toBe(0);
  });

  it("treats unparsable and unit-less time values as 0", () => {
    expect(maxTransitionTotalMs(style("opacity, transform", "abc, 200"))).toBe(0);
    // A unit that parses but a number that does not: without the finite check the
    // NaN would survive into the total and disarm the bounded fallback.
    expect(maxTransitionTotalMs(style("opacity", "abcms"))).toBe(0);
  });

  it("completes synchronously when the effective transition is 0ms", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(style("opacity", "0s"));
    const complete = vi.fn();

    new TransitionCompletion().wait(element, complete);

    expect(complete).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a positive timeout override keeps a 0ms wait armed and completes on the terminal event", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(style("opacity", "0s"));
    const complete = vi.fn();

    new TransitionCompletion().wait(element, complete, { timeoutMs: 200 });
    expect(complete).not.toHaveBeenCalled(); // the override suppresses the synchronous path

    dispatchTerminal(element, "transitionend", "opacity");
    expect(complete).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a positive timeout override replaces the max + 50ms fallback verbatim", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(style("opacity", "300ms"));
    const complete = vi.fn();

    new TransitionCompletion().wait(element, complete, { timeoutMs: 100 });
    vi.advanceTimersByTime(99);
    expect(complete).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("ignores a non-positive timeout override and completes a 0ms transition synchronously", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(style("opacity", "0s"));
    const complete = vi.fn();

    new TransitionCompletion().wait(element, complete, { timeoutMs: 0 });

    expect(complete).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a non-finite timeout override instead of arming the wait", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(style("opacity", "0s"));

    for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const complete = vi.fn();
      new TransitionCompletion().wait(element, complete, { timeoutMs });
      expect(complete).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("treats a missing getComputedStyle like a 0ms transition", () => {
    const original = window.getComputedStyle;
    (window as { getComputedStyle?: typeof window.getComputedStyle }).getComputedStyle = undefined;
    try {
      const synchronous = vi.fn();
      new TransitionCompletion().wait(element, synchronous);
      expect(synchronous).toHaveBeenCalledOnce();

      // An explicit override still arms the wait and any terminal event settles it.
      const overridden = vi.fn();
      new TransitionCompletion().wait(element, overridden, { timeoutMs: 200 });
      expect(overridden).not.toHaveBeenCalled();
      dispatchTerminal(element, "transitionend", "opacity");
      expect(overridden).toHaveBeenCalledOnce();
    } finally {
      window.getComputedStyle = original;
    }
  });

  it("does not finish on a shorter property and safely accepts the remaining cancellation", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(
      style("opacity, transform", "100ms, 300ms"),
    );
    const transition = new TransitionCompletion();
    const complete = vi.fn();
    transition.wait(element, complete);

    dispatchTerminal(element, "transitionend", "opacity");
    expect(complete).not.toHaveBeenCalled();

    dispatchTerminal(element, "transitioncancel", "transform");
    expect(complete).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(350);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("completes a cancelled single-property transition immediately", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(style("height", "200ms"));
    const complete = vi.fn();

    new TransitionCompletion().wait(element, complete);
    dispatchTerminal(element, "transitioncancel", "height");

    expect(complete).toHaveBeenCalledOnce();
  });

  it("ignores descendant and pseudo-element events, then uses the bounded fallback", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(style("opacity", "200ms", "100ms"));
    const child = document.createElement("span");
    element.append(child);
    const complete = vi.fn();
    new TransitionCompletion().wait(element, complete);

    dispatchTerminal(child, "transitionend", "opacity");
    dispatchTerminal(element, "transitionend", "opacity", "::before");
    vi.advanceTimersByTime(349);
    expect(complete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("does not trust an early event for transition-property all", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(style("all", "300ms"));
    const complete = vi.fn();
    new TransitionCompletion().wait(element, complete);

    dispatchTerminal(element, "transitionend", "opacity");
    expect(complete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    dispatchTerminal(element, "transitionend", "transform");
    expect(complete).toHaveBeenCalledOnce();
  });

  it("tracks expanded longhand names reported for an active shorthand transition", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(style("margin", "200ms"));
    let animations: Animation[] = [runningTransition("margin-left")];
    Object.defineProperty(element, "getAnimations", {
      configurable: true,
      value: () => animations,
    });
    const complete = vi.fn();

    new TransitionCompletion().wait(element, complete);
    animations = [];
    dispatchTerminal(element, "transitionend", "margin-left");

    expect(complete).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a stale terminal event while a replacement transition is active", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(style("opacity", "200ms"));
    let animations: Animation[] = [runningTransition("opacity")];
    Object.defineProperty(element, "getAnimations", {
      configurable: true,
      value: () => animations,
    });
    const complete = vi.fn();

    new TransitionCompletion().wait(element, complete);
    dispatchTerminal(element, "transitioncancel", "opacity");
    expect(complete).not.toHaveBeenCalled();

    animations = [];
    dispatchTerminal(element, "transitionend", "opacity");
    expect(complete).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a property this phase still owes when a stale event retires it", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(
      style("opacity, transform", "200ms, 200ms"),
    );
    // Armed before either transition exists, so the seed is the declared pair.
    let animations: Animation[] = [];
    Object.defineProperty(element, "getAnimations", {
      configurable: true,
      value: () => animations,
    });
    const complete = vi.fn();
    new TransitionCompletion().wait(element, complete);

    // The replacement `opacity` transition starts, then the interrupted phase's
    // cancel for that same property is finally dispatched. Dropping `opacity` from
    // the tracked set here would let `transform` alone settle the whole wait.
    animations = [runningTransition("opacity")];
    dispatchTerminal(element, "transitioncancel", "opacity");

    animations = [];
    dispatchTerminal(element, "transitionend", "transform");
    expect(complete).not.toHaveBeenCalled();

    dispatchTerminal(element, "transitionend", "opacity");
    expect(complete).toHaveBeenCalledOnce();
  });

  it("adopts a transition that only starts after the wait was armed", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(
      style("opacity, transform", "120ms, 240ms"),
    );
    // Only `opacity` is running when the wait samples the active set; the phase's
    // `transform` transition is created a frame later.
    let animations: Animation[] = [runningTransition("opacity")];
    Object.defineProperty(element, "getAnimations", {
      configurable: true,
      value: () => animations,
    });
    const complete = vi.fn();

    new TransitionCompletion().wait(element, complete);
    animations = [runningTransition("transform")];

    dispatchTerminal(element, "transitionend", "opacity");
    expect(complete).not.toHaveBeenCalled(); // the straggler is adopted, not settled over

    animations = [];
    dispatchTerminal(element, "transitionend", "transform");
    expect(complete).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the bounded fallback while an adopted transition never settles", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(
      style("opacity, transform", "120ms, 240ms"),
    );
    let animations: Animation[] = [runningTransition("opacity")];
    Object.defineProperty(element, "getAnimations", {
      configurable: true,
      value: () => animations,
    });
    const complete = vi.fn();

    new TransitionCompletion().wait(element, complete);
    animations = [runningTransition("transform")];
    dispatchTerminal(element, "transitionend", "opacity");

    vi.advanceTimersByTime(289); // fallback = max(120, 240) + 50
    expect(complete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(complete).toHaveBeenCalledOnce();
  });

  // Every seeding guard below declares `opacity` but reports an animation for a
  // property the declaration never mentions. A guard that failed to exclude it
  // would seed that foreign property, leaving the element's own `opacity` event
  // unable to settle the wait — so completing on that event proves the exclusion.
  it("excludes animations that already finished or never started", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(style("opacity", "200ms"));
    const settled = [
      { playState: "finished", transitionProperty: "width" },
      { playState: "idle", transitionProperty: "height" },
    ] as CSSTransition[];
    Object.defineProperty(element, "getAnimations", { configurable: true, value: () => settled });
    const complete = vi.fn();

    new TransitionCompletion().wait(element, complete);
    dispatchTerminal(element, "transitionend", "opacity");

    expect(complete).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("excludes an effect that targets another element", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(style("opacity", "200ms"));
    const other = document.createElement("div");
    document.body.append(other);
    const foreign = [
      { playState: "running", transitionProperty: "width", effect: { target: other } },
    ] as unknown as CSSTransition[];
    Object.defineProperty(element, "getAnimations", { configurable: true, value: () => foreign });
    const complete = vi.fn();

    new TransitionCompletion().wait(element, complete);
    dispatchTerminal(element, "transitionend", "opacity");

    expect(complete).toHaveBeenCalledOnce();
  });

  it("excludes a pseudo-element effect reported on the originating element", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(style("opacity", "200ms"));
    const pseudo = [
      {
        playState: "running",
        transitionProperty: "width",
        effect: { target: element, pseudoElement: "::before" },
      },
    ] as unknown as CSSTransition[];
    Object.defineProperty(element, "getAnimations", { configurable: true, value: () => pseudo });
    const complete = vi.fn();

    new TransitionCompletion().wait(element, complete);
    dispatchTerminal(element, "transitionend", "opacity");

    expect(complete).toHaveBeenCalledOnce();
  });

  it("excludes a CSS animation, which reports no transition property", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(style("opacity", "200ms"));
    // CSSAnimation shares the Animation interface but carries no transitionProperty.
    const keyframes = [{ playState: "running" }] as unknown as CSSTransition[];
    Object.defineProperty(element, "getAnimations", { configurable: true, value: () => keyframes });
    const complete = vi.fn();

    new TransitionCompletion().wait(element, complete);
    dispatchTerminal(element, "transitionend", "opacity");

    expect(complete).toHaveBeenCalledOnce();
  });

  it("falls back to the declared properties when getAnimations throws", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(style("opacity", "200ms"));
    Object.defineProperty(element, "getAnimations", {
      configurable: true,
      value: () => {
        throw new Error("getAnimations is not supported");
      },
    });
    const complete = vi.fn();

    expect(() => new TransitionCompletion().wait(element, complete)).not.toThrow();
    dispatchTerminal(element, "transitionend", "opacity");

    expect(complete).toHaveBeenCalledOnce();
  });

  it("cancel removes listeners and the fallback without completing", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(style("height", "200ms"));
    const transition = new TransitionCompletion();
    const complete = vi.fn();
    transition.wait(element, complete);

    transition.cancel();
    dispatchTerminal(element, "transitionend", "height");
    vi.advanceTimersByTime(250);

    expect(complete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replacing a wait cancels the prior callback and completes the new one exactly once", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(style("height", "200ms"));
    const transition = new TransitionCompletion();
    const stale = vi.fn();
    const current = vi.fn();
    transition.wait(element, stale);
    transition.wait(element, current);

    dispatchTerminal(element, "transitionend", "height");
    dispatchTerminal(element, "transitioncancel", "height");
    vi.advanceTimersByTime(250);

    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
  });
});
