import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CountUpController } from "../src/controllers/count_up_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link CountUpController}: the DOM-authored target
 * value, the rAF animation (driven via a stubbed frame queue), the verbatim
 * restore + once guard, reduced-motion skip, and mid-run teardown.
 */

describe("CountUpController", () => {
  let application: Application;
  /** Manually driven rAF queue: each flush(now) runs the pending frame. */
  let frames: FrameRequestCallback[] = [];
  let reducedMotion = false;

  beforeEach(() => {
    frames = [];
    reducedMotion = false;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {
      frames = [];
    });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion") && reducedMotion,
    }));
    vi.spyOn(performance, "now").mockReturnValue(0);
  });

  const flush = (now: number) => {
    const pending = frames;
    frames = [];
    for (const cb of pending) cb(now);
  };

  const mount = async (attrs = "") => {
    document.body.innerHTML = `
      <main>
        <p><span id="n" data-controller="stimeo--count-up" ${attrs}>1,200 users</span></p>
      </main>`;
    application = Application.start();
    application.register("stimeo--count-up", CountUpController);
    await tick();
  };

  afterEach(async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await tick();
  });

  const el = () => document.querySelector("#n") as HTMLElement;
  const controller = () =>
    application?.getControllerForElementAndIdentifier(
      el(),
      "stimeo--count-up",
    ) as CountUpController | null;

  it("animates from `from` to the authored value, then restores it verbatim", async () => {
    await mount();
    controller()?.start();
    expect(el().getAttribute("aria-label")).toBe("1,200 users"); // AT keeps the truth

    flush(0);
    expect(el().textContent).toBe("0");
    flush(600); // half the default 1200ms, ease-out cubic: 1 - 0.5^3 = 0.875
    expect(el().textContent).toBe("1050");
    flush(1200);
    expect(el().textContent).toBe("1,200 users"); // authored text restored
    expect(el().hasAttribute("aria-label")).toBe(false);
    expect(el().getAttribute("data-count-up-done")).toBe("true");
  });

  it("dispatches end with the parsed value", async () => {
    await mount();
    const values: number[] = [];
    el().addEventListener("stimeo--count-up:end", (event) => {
      values.push((event as CustomEvent<{ value: number }>).detail.value);
    });
    controller()?.start();
    flush(0);
    flush(1200);
    expect(values).toEqual([1200]);
  });

  it("ignores repeat starts once done (once) and while running", async () => {
    await mount();
    controller()?.start();
    controller()?.start(); // running: no second frame chain
    flush(0);
    flush(1200);
    controller()?.start(); // done + once: ignored
    expect(frames).toHaveLength(0);
  });

  it("restores the authored value from a mid-animation cache snapshot", async () => {
    // Turbo snapshots BEFORE the body swap, so the cached page can hold a
    // ticking frame; the lingering aria-label is the interrupted-run marker
    // connect() restores from.
    document.body.innerHTML = `
      <main>
        <p><span id="n" data-controller="stimeo--count-up" data-count-up-label="true"
                 aria-label="1,200 users">843</span></p>
      </main>`;
    application = Application.start();
    application.register("stimeo--count-up", CountUpController);
    await tick();
    expect(el().textContent).toBe("1,200 users");
    expect(el().hasAttribute("aria-label")).toBe(false);
    expect(el().getAttribute("data-count-up-done")).toBe("true");
  });

  it("never treats an AUTHORED aria-label as an interrupted run, and restores it", async () => {
    await mount('aria-label="Registered users"');
    // connect(): no own marker → the authored label is not an interrupted run.
    expect(el().textContent).toBe("1,200 users");
    expect(el().getAttribute("aria-label")).toBe("Registered users");

    controller()?.start();
    expect(el().getAttribute("aria-label")).toBe("1,200 users"); // parked + overridden
    flush(0);
    flush(1200);
    // Settle restores the authored label (save-restore), not a bare removal.
    expect(el().getAttribute("aria-label")).toBe("Registered users");
    expect(el().hasAttribute("data-count-up-label")).toBe(false);
    expect(el().hasAttribute("data-count-up-original-label")).toBe(false);
  });

  it("honors a done marker restored from the Turbo cache", async () => {
    await mount('data-count-up-done="true"');
    controller()?.start();
    expect(frames).toHaveLength(0);
    expect(el().textContent).toBe("1,200 users");
  });

  it("re-runs when once is off", async () => {
    await mount('data-stimeo--count-up-once-value="false"');
    controller()?.start();
    flush(0);
    flush(1200);
    controller()?.start();
    expect(frames).toHaveLength(1);
  });

  it("skips the animation entirely under prefers-reduced-motion", async () => {
    reducedMotion = true;
    await mount();
    controller()?.start();
    expect(frames).toHaveLength(0);
    expect(el().textContent).toBe("1,200 users");
    expect(el().getAttribute("data-count-up-done")).toBe("true");
  });

  it("settles to the authored value when disconnected mid-run", async () => {
    await mount();
    controller()?.start();
    flush(0);
    flush(600); // mid-animation
    controller()?.disconnect();
    expect(el().textContent).toBe("1,200 users");
    expect(el().hasAttribute("aria-label")).toBe(false);
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount();
    await expectNoA11yViolations(document.body);
  });

  // --- Speech-order regression -----------------------------------------------

  it("announces the authored value mid-run (aria-label), never the intermediate numbers", async () => {
    await mount();
    const container = document.querySelector("main") as HTMLElement;
    const idle = await captureSpeech({ container, steps: 2 });
    // Freeze the whole ordered array: the stat reads as its authored text.
    expect(idle).toEqual(["main", "paragraph", "1,200 users"]);

    controller()?.start();
    flush(0);
    flush(600); // mid-run: the visible text is an intermediate number…
    expect(el().textContent).toBe("1050");
    const midRun = await captureSpeech({ container, steps: 2 });
    expect(midRun).toEqual(idle); // …but AT still hears the authored value (aria-label)

    flush(1200); // settled: the authored text is restored verbatim
    const settled = await captureSpeech({ container, steps: 2 });
    expect(settled).toEqual(idle);
  });
});
