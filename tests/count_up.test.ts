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
  /**
   * Manually driven rAF queue: `flush(now)` runs the pending frames, keyed by
   * handle so a cancel drops exactly the one it names.
   */
  let queue = new Map<number, FrameRequestCallback>();
  let nextHandle = 1;
  let reducedMotion = false;
  const frames = {
    get length() {
      return queue.size;
    },
  };

  beforeEach(() => {
    queue = new Map();
    nextHandle = 1;
    reducedMotion = false;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const handle = nextHandle;
      nextHandle += 1;
      queue.set(handle, cb);
      return handle;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      queue.delete(handle);
    });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion") && reducedMotion,
    }));
    vi.spyOn(performance, "now").mockReturnValue(0);
  });

  const flush = (now: number) => {
    const pending = [...queue.values()];
    queue.clear();
    for (const cb of pending) cb(now);
  };

  const mount = async (attrs = "", text = "1,200 users") => {
    document.body.innerHTML = `
      <main>
        <p><span id="n" data-controller="stimeo--count-up" ${attrs}>${text}</span></p>
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
    // AT keeps the truth, on the element that is allowed to carry a name.
    expect(el().querySelector("[role='img']")?.getAttribute("aria-label")).toBe("1,200 users");

    flush(0);
    expect(el().textContent).toBe("0");
    flush(600); // half the default 1200ms, ease-out cubic: 1 - 0.5^3 = 0.875
    expect(el().textContent).toBe("1050");
    flush(1200);
    expect(el().textContent).toBe("1,200 users"); // authored text restored
    expect(el().querySelector("[role='img']")).toBeNull();
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
    // ticking frame; the wrapper that outlived the run is the record connect()
    // restores from, and its aria-label carries the authored text.
    document.body.innerHTML = `
      <main>
        <p><span id="n" data-controller="stimeo--count-up"><span data-count-up-label="true"
                 role="img" aria-label="1,200 users">843</span></span></p>
      </main>`;
    application = Application.start();
    application.register("stimeo--count-up", CountUpController);
    await tick();
    expect(el().textContent).toBe("1,200 users");
    expect(el().querySelector("[role='img']")).toBeNull();
    expect(el().getAttribute("data-count-up-done")).toBe("true");
  });

  it("leaves an AUTHORED aria-label on the host untouched through a run", async () => {
    await mount('aria-label="Registered users"');
    // connect(): nothing this controller owns is present, so nothing is claimed.
    expect(el().textContent).toBe("1,200 users");
    expect(el().getAttribute("aria-label")).toBe("Registered users");

    controller()?.start();
    expect(el().getAttribute("aria-label")).toBe("Registered users"); // never borrowed
    flush(0);
    flush(1200);
    expect(el().getAttribute("aria-label")).toBe("Registered users");
    expect(el().querySelector("[role='img']")).toBeNull();
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

  // --- Guards the suite has to hold open ------------------------------------

  it("ignores a second start while a run is in flight", async () => {
    await mount();
    controller()?.start();
    controller()?.start();
    expect(frames.length).toBe(1); // one chain, not two
  });

  it("does nothing at all when the authored text holds no number", async () => {
    await mount("", "No users yet");
    controller()?.start();
    expect(frames.length).toBe(0);
    expect(el().textContent).toBe("No users yet");
    expect(el().hasAttribute("data-count-up-done")).toBe(false);
    expect(el().hasAttribute("aria-label")).toBe(false);
  });

  it("dispatches end once under reduced motion", async () => {
    reducedMotion = true;
    await mount();
    const values: number[] = [];
    el().addEventListener("stimeo--count-up:end", (event) => {
      values.push((event as CustomEvent<{ value: number }>).detail.value);
    });
    controller()?.start();
    expect(values).toEqual([1200]);
  });

  it("drops the pending frame when disconnected mid-run", async () => {
    await mount();
    controller()?.start();
    flush(0);
    expect(frames.length).toBe(1);
    controller()?.disconnect();
    expect(frames.length).toBe(0); // the frame it queued is gone, not just orphaned
    flush(900); // inside the run: a surviving frame would repaint an intermediate value
    expect(el().textContent).toBe("1,200 users");
  });

  it("leaves an authored host aria-label untouched when disconnected mid-run", async () => {
    await mount('aria-label="Registered users"');
    controller()?.start();
    flush(0);
    flush(600); // mid-animation: the named wrapper is live
    controller()?.disconnect();
    expect(el().getAttribute("aria-label")).toBe("Registered users"); // never borrowed
    expect(el().textContent).toBe("1,200 users");
    expect(el().querySelector("[role='img']")).toBeNull();
  });

  // --- Values that fall outside their domain --------------------------------

  it("reads a non-positive duration as the default", async () => {
    await mount('data-stimeo--count-up-duration-value="-1200"');
    controller()?.start();
    flush(0);
    expect(el().textContent).toBe("0");
    flush(600); // the default 1200ms curve, not a diverging one
    expect(el().textContent).toBe("1050");
    flush(1200);
    expect(el().textContent).toBe("1,200 users");
    expect(el().getAttribute("data-count-up-done")).toBe("true");
  });

  it("reads a non-finite duration as the default", async () => {
    await mount('data-stimeo--count-up-duration-value="Infinity"');
    controller()?.start();
    flush(0);
    flush(1200);
    expect(el().textContent).toBe("1,200 users");
    expect(el().getAttribute("data-count-up-done")).toBe("true");
  });

  it("honors a duration inside its domain", async () => {
    await mount('data-stimeo--count-up-duration-value="600"');
    controller()?.start();
    flush(0);
    flush(300); // half of 600, ease-out cubic
    expect(el().textContent).toBe("1050");
    flush(600);
    expect(el().textContent).toBe("1,200 users");
  });

  it("reads a non-numeric from as zero", async () => {
    await mount('data-stimeo--count-up-from-value="abc"');
    controller()?.start();
    flush(0);
    expect(el().textContent).toBe("0");
    flush(600);
    expect(el().textContent).toBe("1050");
  });

  it("counts up from a from inside its domain", async () => {
    await mount('data-stimeo--count-up-from-value="1000"');
    controller()?.start();
    flush(0);
    expect(el().textContent).toBe("1000");
  });

  // --- Reading the authored number ------------------------------------------

  it("reads a hyphen in the label as prose, not as a sign", async () => {
    await mount("", "Sign-ups: 1,200");
    const values: number[] = [];
    el().addEventListener("stimeo--count-up:end", (event) => {
      values.push((event as CustomEvent<{ value: number }>).detail.value);
    });
    controller()?.start();
    flush(0);
    expect(el().textContent).toBe("0"); // counts up, never down from a false sign
    flush(1200);
    expect(values).toEqual([1200]);
  });

  it("takes the first numeric token when the label carries a range", async () => {
    await mount("", "12-24 hours");
    const values: number[] = [];
    el().addEventListener("stimeo--count-up:end", (event) => {
      values.push((event as CustomEvent<{ value: number }>).detail.value);
    });
    controller()?.start();
    flush(0);
    flush(1200);
    expect(values).toEqual([12]);
  });

  // --- The host keeps its markup and its semantics ---------------------------

  it("animates the number without disturbing sibling markup", async () => {
    document.body.innerHTML = `
      <main>
        <p><span id="n" data-controller="stimeo--count-up">1,200 <small>users</small></span></p>
      </main>`;
    application = Application.start();
    application.register("stimeo--count-up", CountUpController);
    await tick();

    controller()?.start();
    flush(600);
    expect(el().querySelector("small")).not.toBeNull(); // still there mid-run
    expect(el().textContent).toContain("users");

    flush(1200);
    expect(el().innerHTML).toBe("1,200 <small>users</small>");
  });

  it("picks the numeric text node even when a non-numeric node comes first", async () => {
    document.body.innerHTML = `
      <main>
        <p><span id="n" data-controller="stimeo--count-up"><b>Users</b> 1,200</span></p>
      </main>`;
    application = Application.start();
    application.register("stimeo--count-up", CountUpController);
    await tick();

    controller()?.start();
    flush(0);
    expect(el().querySelector("b")?.textContent).toBe("Users");
    expect(el().textContent).toContain("0");
    flush(1200);
    expect(el().innerHTML).toBe("<b>Users</b> 1,200");
  });

  it("names the ticking number with a role that permits naming", async () => {
    await mount();
    controller()?.start();
    flush(0);
    const named = el().querySelector('[role="img"]') as HTMLElement;
    expect(named).not.toBeNull();
    expect(named.getAttribute("aria-label")).toBe("1,200 users");
    expect(el().hasAttribute("role")).toBe(false); // the host keeps its own semantics
    expect(el().hasAttribute("aria-label")).toBe(false);

    flush(1200);
    expect(el().querySelector('[role="img"]')).toBeNull();
    expect(el().innerHTML).toBe("1,200 users");
  });

  it("keeps a definition list valid while the number ticks", async () => {
    document.body.innerHTML = `
      <main><dl><div><dt>Users</dt>
        <dd id="n" data-controller="stimeo--count-up">1,200</dd>
      </div></dl></main>`;
    application = Application.start();
    application.register("stimeo--count-up", CountUpController);
    await tick();

    controller()?.start();
    flush(600);
    await expectNoA11yViolations(document.body); // a role on the dd would break the dl
  });

  it("restores nothing and claims nothing when the marker outlives its label", async () => {
    document.body.innerHTML = `
      <main>
        <p><span id="n" data-controller="stimeo--count-up"><span
             data-count-up-label="true" role="img">843</span></span></p>
      </main>`;
    application = Application.start();
    application.register("stimeo--count-up", CountUpController);
    await tick();
    // Nothing owned survives, so the run is not declared finished on a guess.
    expect(el().hasAttribute("data-count-up-label")).toBe(false);
    expect(el().hasAttribute("data-count-up-done")).toBe(false);
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount();
    await expectNoA11yViolations(document.body);
  });

  // --- Speech-order regression -----------------------------------------------

  it("names the ticking number with the authored text, on a host that keeps its role", async () => {
    await mount();
    const container = document.querySelector("main") as HTMLElement;
    const idle = await captureSpeech({ container, steps: 5 });
    // Freeze the whole ordered array: the stat reads as its authored text.
    expect(idle).toEqual([
      "main",
      "paragraph",
      "1,200 users",
      "end of paragraph",
      "end of main",
      "main",
    ]);

    controller()?.start();
    flush(0);
    flush(600); // mid-run: the visible text is an intermediate number…
    expect(el().textContent).toBe("1050");
    const midRun = await captureSpeech({ container, steps: 5 });
    // …and the name AT reads is the authored text, published on an element that
    // is allowed to carry one. The host keeps its own role, so the paragraph
    // structure around it is unchanged.
    expect(midRun).toEqual([
      "main",
      "paragraph",
      "image, 1,200 users",
      "1050",
      "end of image, 1,200 users",
      "end of paragraph",
    ]);

    flush(1200); // settled: the authored text is restored verbatim
    const settled = await captureSpeech({ container, steps: 5 });
    expect(settled).toEqual(idle);
  });
});
