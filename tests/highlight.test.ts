import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HighlightController } from "../src/controllers/highlight_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link HighlightController}, driven by a mocked clock: the
 * self-highlight on connect, the timed removal, the start / end events, container
 * mode highlighting added children via a MutationObserver, reduced-motion
 * suppression, and observer / timer teardown.
 */

let originalMatchMedia: typeof window.matchMedia;

/** Installs a matchMedia whose reduce-motion result is `reduce`. */
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

describe("HighlightController", () => {
  let application: Application | undefined;

  const mount = async (html: string) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--highlight", HighlightController);
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    originalMatchMedia = window.matchMedia;
    setReducedMotion(false);
  });

  afterEach(() => {
    // A case that only reads a static declaration never mounts, so the teardown is
    // conditional; clearing the reference afterwards keeps each case from inheriting
    // an Application an earlier one started.
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    vi.useRealTimers();
    window.matchMedia = originalMatchMedia;
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--highlight']");
  const flush = () => vi.advanceTimersByTimeAsync(0);

  /**
   * Installs `setTimeout` / `clearTimeout` wrappers that hand out recycled timer
   * handles, the way a browser does — a handle freed by `clearTimeout` or by the
   * timeout firing is given to the next caller. Vitest's fake timers and happy-dom
   * both count up forever instead, so a ledger entry left behind for a released
   * timer can never collide with a live one under the plain fake clock.
   *
   * `handed` records the handles in the order they were given out, so a test can
   * state that the collision it relies on actually happened.
   */
  const installRecyclingTimers = () => {
    const realSet = window.setTimeout;
    const realClear = window.clearTimeout;
    const live = new Map<number, number>();
    const free: number[] = [];
    const handed: number[] = [];
    let next = 1;

    window.setTimeout = ((handler: () => void, delay?: number) => {
      const handle = free.pop() ?? next++;
      handed.push(handle);
      const real = (realSet as (h: () => void, d?: number) => number)(() => {
        live.delete(handle);
        free.push(handle);
        handler();
      }, delay);
      live.set(handle, real);
      return handle;
    }) as unknown as typeof window.setTimeout;

    window.clearTimeout = ((handle?: number) => {
      if (handle === undefined) return;
      const real = live.get(handle);
      if (real === undefined) return;
      (realClear as (h: number) => void)(real);
      live.delete(handle);
      free.push(handle);
    }) as unknown as typeof window.clearTimeout;

    return {
      handed,
      restore: () => {
        window.setTimeout = realSet;
        window.clearTimeout = realClear;
      },
    };
  };

  it("flags the element on connect and removes it after the default duration", async () => {
    await mount('<li data-controller="stimeo--highlight">New</li>');
    expect(root().getAttribute("data-highlight")).toBe("true");

    vi.advanceTimersByTime(1499);
    expect(root().hasAttribute("data-highlight")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(root().hasAttribute("data-highlight")).toBe(false);
  });

  it("honors a custom duration", async () => {
    await mount(
      '<li data-controller="stimeo--highlight" data-stimeo--highlight-duration-value="500">x</li>',
    );
    vi.advanceTimersByTime(499);
    expect(root().hasAttribute("data-highlight")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(root().hasAttribute("data-highlight")).toBe(false);
  });

  it("dispatches start then end carrying the highlighted element", async () => {
    // Container mode so a listener can be attached before the highlight begins.
    await mount(
      '<ul data-controller="stimeo--highlight" data-stimeo--highlight-observe-value="true"></ul>',
    );
    const events: Array<{ type: string; detail: unknown; target: EventTarget | null }> = [];
    for (const type of ["start", "end"] as const) {
      root().addEventListener(`stimeo--highlight:${type}`, (e) => {
        events.push({ type, detail: (e as CustomEvent).detail, target: e.target });
      });
    }
    const li = document.createElement("li");
    root().appendChild(li);
    await flush();
    // `detail` is compared whole, so an extra key would fail; `target` pins the
    // highlighted child as the dispatch origin rather than the container.
    expect(events).toEqual([{ type: "start", detail: { element: li }, target: li }]);

    vi.advanceTimersByTime(1500);
    expect(events).toEqual([
      { type: "start", detail: { element: li }, target: li },
      { type: "end", detail: { element: li }, target: li },
    ]);
  });

  it("highlights every child of a single multi-node mutation record", async () => {
    // happy-dom emits one record per inserted node, while browsers batch a multi-node
    // insert — `append(a, b)`, or the fragment a Turbo Stream append inserts — into one
    // record whose `addedNodes` holds them all. Drive the callback with that shape so
    // the loop over `addedNodes` is exercised.
    const nativeObserver = window.MutationObserver;
    let deliver: MutationCallback | undefined;
    class CapturingObserver {
      constructor(callback: MutationCallback) {
        deliver = callback;
      }
      observe(): void {}
      disconnect(): void {}
      takeRecords(): MutationRecord[] {
        return [];
      }
    }
    window.MutationObserver = CapturingObserver as unknown as typeof MutationObserver;
    try {
      await mount(
        '<ul data-controller="stimeo--highlight" data-stimeo--highlight-observe-value="true"></ul>',
      );
      const a = document.createElement("li");
      const b = document.createElement("li");
      deliver?.([{ addedNodes: [a, b] } as unknown as MutationRecord], {} as MutationObserver);
      expect(a.getAttribute("data-highlight")).toBe("true");
      expect(b.getAttribute("data-highlight")).toBe("true");
    } finally {
      window.MutationObserver = nativeObserver;
    }
  });

  it("highlights children added in container mode but not the container", async () => {
    await mount(
      '<ul data-controller="stimeo--highlight" data-stimeo--highlight-observe-value="true"></ul>',
    );
    expect(root().hasAttribute("data-highlight")).toBe(false);

    const li = document.createElement("li");
    root().appendChild(li);
    await flush();
    expect(li.getAttribute("data-highlight")).toBe("true");
    expect(root().hasAttribute("data-highlight")).toBe(false);

    vi.advanceTimersByTime(1500);
    expect(li.hasAttribute("data-highlight")).toBe(false);
  });

  it("highlights each of several children added at once", async () => {
    await mount(
      '<ul data-controller="stimeo--highlight" data-stimeo--highlight-observe-value="true"></ul>',
    );
    const a = document.createElement("li");
    const b = document.createElement("li");
    root().append(a, b);
    await flush();
    expect(a.getAttribute("data-highlight")).toBe("true");
    expect(b.getAttribute("data-highlight")).toBe("true");
  });

  it("watches only its direct children, not deeper descendants", async () => {
    await mount(
      '<ul data-controller="stimeo--highlight" data-stimeo--highlight-observe-value="true">' +
        '<li id="row">a</li></ul>',
    );
    // Content added *inside* an existing row is not a child of the container.
    const span = document.createElement("span");
    query("#row").appendChild(span);
    await flush();
    expect(span.hasAttribute("data-highlight")).toBe(false);

    // A direct child added right after still is one.
    const li = document.createElement("li");
    root().appendChild(li);
    await flush();
    expect(li.getAttribute("data-highlight")).toBe("true");
  });

  it("gives a re-inserted child the full duration again", async () => {
    await mount(
      '<ul data-controller="stimeo--highlight" data-stimeo--highlight-observe-value="true"></ul>',
    );
    const a = document.createElement("li");
    const b = document.createElement("li");
    root().append(a, b);
    await flush();

    // Reordering re-inserts the node, which the observer reports as an addition.
    vi.advanceTimersByTime(1000);
    root().appendChild(a);
    await flush();
    expect(a.getAttribute("data-highlight")).toBe("true");

    // Past the first highlight's deadline: only the second one owns the hook now.
    vi.advanceTimersByTime(1000);
    expect(a.getAttribute("data-highlight")).toBe("true");
    vi.advanceTimersByTime(500);
    expect(a.hasAttribute("data-highlight")).toBe(false);
  });

  it("emits end once per element when a child is re-inserted mid-highlight", async () => {
    await mount(
      '<ul data-controller="stimeo--highlight" data-stimeo--highlight-observe-value="true"></ul>',
    );
    const seen: string[] = [];
    for (const type of ["start", "end"] as const) {
      root().addEventListener(`stimeo--highlight:${type}`, (e) => {
        seen.push(`${type}:${(e as CustomEvent).detail.element.id}`);
      });
    }
    const a = document.createElement("li");
    a.id = "a";
    const b = document.createElement("li");
    b.id = "b";
    root().append(a, b);
    await flush();

    vi.advanceTimersByTime(1000);
    root().appendChild(a);
    await flush();
    vi.advanceTimersByTime(2000);

    // Two highlights of `a`, but its hook is removed once: starting the second
    // releases the first timer, so only the timer that owns the current emphasis
    // reports its `end`.
    expect(seen.filter((e) => e === "end:a")).toEqual(["end:a"]);
    expect(seen).toEqual(["start:a", "start:b", "start:a", "end:b", "end:a"]);
  });

  it("hands the hook over when a highlighted child moves to another watched container", async () => {
    await mount(
      '<ul id="from" data-controller="stimeo--highlight" ' +
        'data-stimeo--highlight-observe-value="true"></ul>' +
        '<ul id="to" data-controller="stimeo--highlight" ' +
        'data-stimeo--highlight-observe-value="true"></ul>',
    );
    const ends: string[] = [];
    const record = (e: Event) => ends.push(`end:${(e as CustomEvent).detail.element.id}`);
    document.addEventListener("stimeo--highlight:end", record);
    try {
      const li = document.createElement("li");
      li.id = "moved";
      query("#from").appendChild(li);
      await flush();
      expect(li.getAttribute("data-highlight")).toBe("true");

      vi.advanceTimersByTime(1000);
      query("#to").appendChild(li);
      await flush();
      expect(li.getAttribute("data-highlight")).toBe("true");

      // The container the row left holds no claim on the hook any more: its deadline
      // passes without cutting the emphasis the new container started.
      vi.advanceTimersByTime(500);
      expect(li.getAttribute("data-highlight")).toBe("true");
      expect(ends).toEqual([]);

      // The full duration is measured from the second highlight, and only the timer
      // that owns the hook reports its `end`.
      vi.advanceTimersByTime(1000);
      expect(li.hasAttribute("data-highlight")).toBe(false);
      expect(ends).toEqual(["end:moved"]);
    } finally {
      document.removeEventListener("stimeo--highlight:end", record);
    }
  });

  it("suppresses the highlight entirely under reduced motion", async () => {
    setReducedMotion(true);
    // `connect()` dispatches synchronously inside `mount()`, so the listener has to be
    // in place before the element exists — `document` catches the bubbled event.
    const events: string[] = [];
    const record = (e: Event) => events.push(e.type);
    for (const type of ["start", "end"] as const) {
      document.addEventListener(`stimeo--highlight:${type}`, record);
    }
    try {
      await mount('<li data-controller="stimeo--highlight">New</li>');
      expect(root().hasAttribute("data-highlight")).toBe(false);
      expect(events).toEqual([]);
      // Nothing is scheduled either, so no event arrives once the duration elapses.
      vi.advanceTimersByTime(2000);
      expect(root().hasAttribute("data-highlight")).toBe(false);
      expect(events).toEqual([]);
    } finally {
      for (const type of ["start", "end"] as const) {
        document.removeEventListener(`stimeo--highlight:${type}`, record);
      }
    }
  });

  it("stops observing and clears timers after disconnect", async () => {
    await mount(
      '<ul data-controller="stimeo--highlight" data-stimeo--highlight-observe-value="true"></ul>',
    );
    const list = root();
    list.remove();
    await flush();

    const li = document.createElement("li");
    list.appendChild(li);
    await flush();
    expect(li.hasAttribute("data-highlight")).toBe(false);
  });

  it("clears a stale hook a restored snapshot left on a child", async () => {
    // Listen on document, since connect() runs inside mount().
    const events: string[] = [];
    const record = (e: Event) => events.push(e.type);
    for (const type of ["start", "end"] as const) {
      document.addEventListener(`stimeo--highlight:${type}`, record);
    }
    try {
      await mount(
        '<ul data-controller="stimeo--highlight" data-stimeo--highlight-observe-value="true">' +
          '<li id="stale" data-highlight="true">restored</li></ul>',
      );
      // No timer of this connection would ever remove it, so the hook must not survive.
      expect(query("#stale").hasAttribute("data-highlight")).toBe(false);
      // Clearing a hook this connection never set is not the end of a highlight.
      expect(events).toEqual([]);

      // The container still watches for genuinely new children.
      const li = document.createElement("li");
      root().appendChild(li);
      await flush();
      expect(li.getAttribute("data-highlight")).toBe("true");
      vi.advanceTimersByTime(1500);
      expect(li.hasAttribute("data-highlight")).toBe(false);
      expect(events).toEqual(["stimeo--highlight:start", "stimeo--highlight:end"]);
    } finally {
      for (const type of ["start", "end"] as const) {
        document.removeEventListener(`stimeo--highlight:${type}`, record);
      }
    }
  });

  it("clears a stale hook the container itself arrived with in observe mode", async () => {
    await mount(
      '<ul data-controller="stimeo--highlight" data-stimeo--highlight-observe-value="true" ' +
        'data-highlight="true"><li id="row">a</li></ul>',
    );
    // A container is never the target of its own highlight, so no timer of this
    // connection would ever take the hook off.
    expect(root().hasAttribute("data-highlight")).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(root().hasAttribute("data-highlight")).toBe(false);
  });

  it("clears a child hook when the container is moved in-page mid-highlight", async () => {
    await mount(
      '<div id="from"><ul data-controller="stimeo--highlight" ' +
        'data-stimeo--highlight-observe-value="true"></ul></div><div id="to"></div>',
    );
    const list = root();
    const li = document.createElement("li");
    list.appendChild(li);
    await flush();
    expect(li.getAttribute("data-highlight")).toBe("true");

    // The move disconnects and reconnects the container, killing the removal timer.
    query("#to").appendChild(list);
    await flush();
    expect(li.hasAttribute("data-highlight")).toBe(false);
  });

  it("drops the whole ledger on disconnect so a recycled id cannot cancel another row", async () => {
    await mount(
      '<div id="from"><ul data-controller="stimeo--highlight" ' +
        'data-stimeo--highlight-observe-value="true"></ul></div><div id="to"></div>',
    );
    const timers = installRecyclingTimers();
    try {
      const list = root();
      const a = document.createElement("li");
      list.appendChild(a);
      await flush();
      const idA = timers.handed.at(-1);
      // A handle really was handed out, so the collision below is a collision.
      expect(idA).toBeTypeOf("number");

      // The in-page move disconnects the container, releasing `a`'s timer handle.
      query("#to").appendChild(list);
      await flush();

      const b = document.createElement("li");
      list.appendChild(b);
      await flush();
      expect(timers.handed.at(-1)).toBe(idA); // the released handle came back
      expect(b.hasAttribute("data-highlight")).toBe(true); // and `b` is emphasized by it

      // Re-inserting `a` releases the timer `a` has pending — which is none. A ledger
      // entry surviving the disconnect would name `b`'s live timer instead.
      list.appendChild(a);
      await flush();

      vi.advanceTimersByTime(1500);
      expect(b.hasAttribute("data-highlight")).toBe(false);
    } finally {
      timers.restore();
    }
  });

  it("drops a fired timer from the ledger so a recycled id cannot cancel another row", async () => {
    await mount(
      '<ul data-controller="stimeo--highlight" data-stimeo--highlight-observe-value="true"></ul>',
    );
    const timers = installRecyclingTimers();
    try {
      const list = root();
      const a = document.createElement("li");
      list.appendChild(a);
      await flush();
      const idA = timers.handed.at(-1);
      // A handle really was handed out, so the collision below is a collision.
      expect(idA).toBeTypeOf("number");

      // `a`'s highlight ends on its own, releasing the handle.
      vi.advanceTimersByTime(1500);
      expect(a.hasAttribute("data-highlight")).toBe(false);

      const b = document.createElement("li");
      list.appendChild(b);
      await flush();
      expect(timers.handed.at(-1)).toBe(idA); // the released handle came back
      expect(b.hasAttribute("data-highlight")).toBe(true); // and `b` is emphasized by it

      list.appendChild(a);
      await flush();

      vi.advanceTimersByTime(1500);
      expect(b.hasAttribute("data-highlight")).toBe(false);
    } finally {
      timers.restore();
    }
  });

  it("clears a stale self hook when motion is suppressed", async () => {
    setReducedMotion(true);
    await mount('<li data-controller="stimeo--highlight" data-highlight="true">restored</li>');
    // Reduced motion emits no hook at all, so a hook carried in has nothing to end it.
    expect(root().hasAttribute("data-highlight")).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(root().hasAttribute("data-highlight")).toBe(false);
  });

  it("clears a pending self-highlight timer on disconnect", async () => {
    await mount('<li data-controller="stimeo--highlight">New</li>');
    const li = root();
    expect(li.getAttribute("data-highlight")).toBe("true");
    li.remove();
    await flush();
    // Disconnect clears the removal timer, so the detached node keeps no stale work.
    vi.advanceTimersByTime(2000);
    expect(li.getAttribute("data-highlight")).toBe("true");
  });

  it("declares the two public events the Inspector manifest reflects", () => {
    // `static events` is a pure declaration, so no behavioral test can reach it: the
    // manifest reads it verbatim, and losing an entry silently drops that event from
    // the published contract.
    expect(HighlightController.events).toEqual(["start", "end"]);
  });

  it("has no a11y violations", async () => {
    vi.useRealTimers();
    document.body.innerHTML =
      '<ul data-controller="stimeo--highlight" data-stimeo--highlight-observe-value="true"><li>a</li></ul>';
    application = Application.start();
    application.register("stimeo--highlight", HighlightController);
    await tick();
    await expectNoA11yViolations(root());
  });
});
