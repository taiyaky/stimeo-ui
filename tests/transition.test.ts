import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransitionController } from "../src/controllers/transition_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link TransitionController}: the enter/leave class staging,
 * completion through the shared TransitionCompletion (per-property terminal events,
 * transitioncancel, pseudo-element exclusion, bounded fallback, synchronous 0ms
 * settle), the timeout-Value override, the hidden sync, the state hook and events,
 * reduced-motion fast-path, interruption, toggle, teardown, and a transition across
 * Turbo's cache.
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
    expect(has("ease-out")).toBe(true); // enter base applied alongside enterFrom
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

  it("leaves a stage-token class it never applied", async () => {
    document.body.innerHTML = `<div data-controller="stimeo--transition" ${ATTRS} class="opacity-100 rounded">x</div>`;
    application = Application.start();
    application.register("stimeo--transition", TransitionController);
    await vi.advanceTimersByTimeAsync(0);
    // A class the consumer authored is theirs even when a stage Value names the
    // same token. Connecting a restored copy removes only recorded staged classes.
    expect(has("opacity-100")).toBe(true);
    expect(has("rounded")).toBe(true);
  });

  it("keeps an authored class a to-stage names when the transition completes", async () => {
    document.body.innerHTML = `<div data-controller="stimeo--transition" ${ATTRS} class="opacity-100 rounded" hidden>x</div>`;
    application = Application.start();
    application.register("stimeo--transition", TransitionController);
    await vi.advanceTimersByTimeAsync(0);
    stubTransition();

    instance().enter();
    vi.advanceTimersToNextFrame();
    endTransition();

    // `enterTo` names a token the element already carried, so applying it was a
    // no-op and clearing the stage must not take the consumer's class with it.
    expect(state()).toBe("entered");
    expect(has("opacity-100")).toBe(true);
    expect(has("rounded")).toBe(true);
  });

  it("keeps an authored class a from-stage names across the swap", async () => {
    document.body.innerHTML = `<div data-controller="stimeo--transition" ${ATTRS} class="opacity-100 rounded">x</div>`;
    application = Application.start();
    application.register("stimeo--transition", TransitionController);
    await vi.advanceTimersByTimeAsync(0);
    stubTransition();

    instance().leave();
    vi.advanceTimersToNextFrame();
    // The swap removes `leaveFrom`, but this token was on the element first, so
    // it is the consumer's to keep — the swap only drops what was staged.
    expect(has("opacity-100")).toBe(true);
    expect(has("opacity-0")).toBe(true); // leaveTo still staged normally

    endTransition();
    expect(state()).toBe("left");
    expect(el().className).toBe("opacity-100 rounded");
  });

  it("stages leave classes in order", async () => {
    await mount(ATTRS, ""); // start visible
    stubTransition();

    instance().leave();
    expect(has("ease-in")).toBe(true); // leave base applied alongside leaveFrom
    expect(has("opacity-100")).toBe(true);
    expect(has("opacity-0")).toBe(false);

    vi.advanceTimersToNextFrame();
    expect(has("opacity-100")).toBe(false);
    expect(has("opacity-0")).toBe(true); // leaveTo after the staging frame
  });

  it("dispatches entered and left with an empty detail", async () => {
    await mount(ATTRS, "");
    stubTransition();
    const details: unknown[] = [];
    el().addEventListener("stimeo--transition:left", (event) => {
      details.push((event as CustomEvent).detail);
    });
    el().addEventListener("stimeo--transition:entered", (event) => {
      details.push((event as CustomEvent).detail);
    });

    instance().leave();
    vi.advanceTimersToNextFrame();
    endTransition();
    instance().enter();
    vi.advanceTimersToNextFrame();
    endTransition();

    expect(details).toEqual([{}, {}]);
  });

  it("releases a staging frame still queued at disconnect", async () => {
    await mount(`${ATTRS} data-stimeo--transition-timeout-value="200"`);
    const entered: number[] = [];
    el().addEventListener("stimeo--transition:entered", () => entered.push(1));
    const node = el();

    instance().enter(); // the staging frame is queued and not yet run
    node.remove();
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersToNextFrame();
    vi.advanceTimersByTime(500);
    expect(entered).toEqual([]);
    expect(node.className).toBe(""); // the staged classes went with it
  });

  it("releases a staging timer still queued at disconnect where frames are unavailable", async () => {
    await mount(`${ATTRS} data-stimeo--transition-timeout-value="200"`);
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.stubGlobal("cancelAnimationFrame", undefined);
    try {
      const left: number[] = [];
      el().addEventListener("stimeo--transition:left", () => left.push(1));
      instance().enter();
      vi.advanceTimersByTime(0);
      expect(has("opacity-100")).toBe(true); // a timer stands in for the missing frame

      instance().leave(); // its staging timer is queued and not yet run
      instance().disconnect();
      await flushMicrotasks(); // no reconnection follows: a real detach
      vi.advanceTimersByTime(500);
      expect(has("opacity-0")).toBe(false);
      expect(left).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a running leave across an in-page move, so the element still hides and left fires", async () => {
    await mount(`${ATTRS} data-stimeo--transition-timeout-value="200"`, "");
    const left: number[] = [];
    el().addEventListener("stimeo--transition:left", () => left.push(1));
    instance().leave();
    vi.advanceTimersToNextFrame();
    expect(el().getAttribute("data-transition-state")).toBe("leaving");

    instance().disconnect();
    instance().connect();
    await flushMicrotasks();
    expect(el().getAttribute("data-transition-state")).toBe("leaving");
    expect(has("opacity-0")).toBe(true);
    vi.advanceTimersByTime(200);
    expect(el().hidden).toBe(true);
    expect(el().getAttribute("data-transition-state")).toBe("left");
    expect(left).toEqual([1]);
  });

  it("leaves a class the consumer adds after a transition alone on the next one", async () => {
    await mount();
    stubTransition();
    instance().enter();
    vi.advanceTimersToNextFrame();
    endTransition(); // entered: the stage classes are stripped
    el().classList.add("ease-out"); // the consumer's standing class from here on

    instance().leave();
    vi.advanceTimersToNextFrame();
    endTransition();
    expect(state()).toBe("left");
    expect(has("ease-out")).toBe(true);
  });

  it("releases a staging frame still queued when the direction reverses", async () => {
    await mount(ATTRS, "");
    stubTransition();

    instance().leave();
    instance().enter(); // reverse before the leave staging frame runs
    vi.advanceTimersToNextFrame();

    // Only the enter frame may run: a stale leave frame would swap in leaveTo.
    expect(has("ease-out")).toBe(true);
    expect(has("opacity-100")).toBe(true);
    expect(has("ease-in")).toBe(false);
  });

  it("reverses direction while a transition is still running", async () => {
    await mount(ATTRS, "");
    stubTransition();

    instance().toggle(); // entered → leave
    expect(state()).toBe("leaving");
    instance().toggle(); // leaving → enter
    expect(state()).toBe("entering");
    vi.advanceTimersToNextFrame();
    instance().toggle(); // entering → leave
    expect(state()).toBe("leaving");
  });

  it("keeps a running leave through turbo:before-cache, hides the element and says left", async () => {
    await mount(ATTRS, "");
    stubTransition();
    const seen: string[] = [];
    el().addEventListener("stimeo--transition:left", () => seen.push("left"));

    instance().leave();
    vi.advanceTimersToNextFrame();
    expect(has("opacity-0")).toBe(true);

    // Turbo dispatches it on pages that stay as well, where the leave is still running.
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(state()).toBe("leaving");
    expect(has("opacity-0")).toBe(true);

    endTransition();
    expect(el().hidden).toBe(true);
    expect(state()).toBe("left");
    expect(seen).toEqual(["left"]);
  });

  it("records the stage classes in place on the element", async () => {
    await mount(ATTRS, "");
    stubTransition();

    instance().leave();
    expect(JSON.parse(el().getAttribute("data-stimeo--transition-staged") ?? "[]")).toEqual([
      "ease-in",
      "opacity-100",
    ]);
    vi.advanceTimersToNextFrame();
    expect(JSON.parse(el().getAttribute("data-stimeo--transition-staged") ?? "[]")).toEqual([
      "ease-in",
      "opacity-0",
    ]);

    endTransition();
    expect(el().hasAttribute("data-stimeo--transition-staged")).toBe(false);
  });

  it("strips the stage a restored page was copied with and settles it, silently", async () => {
    await mount(ATTRS, "");
    stubTransition();
    el().classList.add("card");
    instance().leave();
    vi.advanceTimersToNextFrame();
    const seen: string[] = [];
    document.addEventListener("stimeo--transition:left", () => seen.push("left"));
    document.addEventListener("stimeo--transition:entered", () => seen.push("entered"));

    application = await restoreFromCache(
      application,
      (restored) => restored.register("stimeo--transition", TransitionController),
      () => vi.advanceTimersByTimeAsync(0),
    );

    // The copy was still visible, so it settles as entered; the consumer's own class stays.
    expect(el().className).toBe("card");
    expect(el().hasAttribute("data-stimeo--transition-staged")).toBe(false);
    expect(state()).toBe("entered");
    expect(seen).toEqual([]);
  });

  it("keeps an authored class a stage names on a restored page", async () => {
    await mount(`${ATTRS} class="opacity-100"`, "");
    stubTransition();
    instance().leave(); // opacity-100 is the consumer's: it is not staged
    vi.advanceTimersToNextFrame();

    application = await restoreFromCache(
      application,
      (restored) => restored.register("stimeo--transition", TransitionController),
      () => vi.advanceTimersByTimeAsync(0),
    );

    expect(el().className).toBe("opacity-100");
  });

  it("strips nothing for a record that is not a list of classes", async () => {
    await mount(`${ATTRS} class="a b" data-stimeo--transition-staged='"ab"'`, "");
    expect(el().className).toBe("a b");
    expect(el().hasAttribute("data-stimeo--transition-staged")).toBe(false);
  });

  it("strips nothing and settles for a record that is not JSON", async () => {
    await mount(`${ATTRS} class="a" data-stimeo--transition-staged="["`, "");
    expect(el().className).toBe("a");
    expect(el().hasAttribute("data-stimeo--transition-staged")).toBe(false);
    expect(state()).toBe("entered");
  });

  it("leaves a stage token the author wrote alone when no record says otherwise", async () => {
    await mount(`${ATTRS} class="ease-in opacity-0"`, "");
    expect(el().className).toBe("ease-in opacity-0");
  });

  it("removes the classes it applied even after the Values change", async () => {
    await mount();
    stubTransition();

    instance().enter();
    el().setAttribute("data-stimeo--transition-enter-value", "ease-in-out");
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersToNextFrame();
    endTransition();

    // Stripping by the current declaration would strand the token that was on
    // the element when the transition started.
    expect(el().className).toBe("");
  });

  // --- One transition runs on the declaration it started with -----------------

  it("keeps the timeout a transition started with when it changes before the staging frame", async () => {
    await mount(`${ATTRS} data-stimeo--transition-timeout-value="200"`);
    instance().enter();
    el().setAttribute("data-stimeo--transition-timeout-value", "50");
    vi.advanceTimersToNextFrame();

    vi.advanceTimersByTime(50);
    expect(state()).toBe("entering");
    vi.advanceTimersByTime(150);
    expect(state()).toBe("entered");
  });

  it("keeps the timeout a running transition waits on, and times the next one anew", async () => {
    await mount(`${ATTRS} data-stimeo--transition-timeout-value="200"`);
    instance().enter();
    vi.advanceTimersToNextFrame();
    el().setAttribute("data-stimeo--transition-timeout-value", "50");
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(199);
    expect(state()).toBe("entering");
    vi.advanceTimersByTime(1);
    expect(state()).toBe("entered");

    instance().leave();
    vi.advanceTimersToNextFrame();
    vi.advanceTimersByTime(49);
    expect(state()).toBe("leaving");
    vi.advanceTimersByTime(1);
    expect(state()).toBe("left");
  });

  it.each([
    { kind: "enter", hidden: "hidden", base: "ease-out", from: "opacity-0", to: "opacity-100" },
    { kind: "leave", hidden: "", base: "ease-in", from: "opacity-100", to: "opacity-0" },
  ] as const)(
    "stages the $kind classes it started with, and the next $kind the new ones",
    async ({ kind, hidden, base, from, to }) => {
      await mount(ATTRS, hidden);
      stubTransition();
      const run = () => (kind === "enter" ? instance().enter() : instance().leave());
      const settle = () => (kind === "enter" ? instance().leave() : instance().enter());

      run();
      el().setAttribute(`data-stimeo--transition-${kind}-value`, "next-base");
      el().setAttribute(`data-stimeo--transition-${kind}-from-value`, "next-from");
      el().setAttribute(`data-stimeo--transition-${kind}-to-value`, "next-to");
      await vi.advanceTimersByTimeAsync(0);
      expect([has(base), has(from), has("next-base"), has("next-from")]).toEqual([
        true,
        true,
        false,
        false,
      ]);

      vi.advanceTimersToNextFrame(); // the swap reads the lists the transition began with
      expect([has(from), has(to), has("next-to")]).toEqual([false, true, false]);
      endTransition();
      expect(el().className).toBe("");

      settle(); // the opposite direction, so the next run starts from its own side
      vi.advanceTimersToNextFrame();
      endTransition();
      run();
      expect([has("next-base"), has("next-from"), has(base)]).toEqual([true, true, false]);
      vi.advanceTimersToNextFrame();
      expect([has("next-from"), has("next-to")]).toEqual([false, true]);
    },
  );

  it("stages and reports nothing from a Value change alone", async () => {
    await mount(`${ATTRS} data-stimeo--transition-timeout-value="200"`, "");
    const seen: string[] = [];
    el().addEventListener("stimeo--transition:entered", () => seen.push("entered"));
    el().addEventListener("stimeo--transition:left", () => seen.push("left"));

    el().setAttribute("data-stimeo--transition-enter-value", "next-base");
    el().setAttribute("data-stimeo--transition-leave-to-value", "next-to");
    el().setAttribute("data-stimeo--transition-timeout-value", "50");
    await vi.advanceTimersByTimeAsync(500);
    expect(el().className).toBe("");
    expect(state()).toBe("entered");
    expect(el().hidden).toBe(false);
    expect(seen).toEqual([]);
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
