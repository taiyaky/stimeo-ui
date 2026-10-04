import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnouncerController, visuallyHide } from "../src/controllers/announcer_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { flushMicrotasks, installRecyclingTimers, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link AnnouncerController}: routing to the polite vs
 * assertive region, the Stimulus action and CustomEvent entry points, the
 * dedupe re-announce of identical text, auto-clear, fallback-region generation,
 * focus preservation, listener/timer teardown on disconnect, and the messages a page
 * restored from Turbo's cache carries.
 */

describe("AnnouncerController", () => {
  let application: Application;

  /**
   * Mounts the fixture without awaiting a microtask. Fake-timer cases cannot use
   * {@link start} because `tick()` never resolves while the clock is faked; they
   * pair this with `vi.advanceTimersByTimeAsync(0)` instead.
   */
  const mount = (attrs = "", body = "") => {
    document.body.innerHTML = `
      <div data-controller="stimeo--announcer" ${attrs}>
        <div data-stimeo--announcer-target="polite" aria-live="polite" aria-atomic="true"></div>
        <div data-stimeo--announcer-target="assertive" aria-live="assertive" aria-atomic="true"></div>
        ${body}
      </div>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
  };

  const start = async (attrs = "", body = "") => {
    mount(attrs, body);
    await tick();
  };

  afterEach(() => {
    // Restore the clock first: a fake-timer case that fails before its own
    // `useRealTimers()` would otherwise hang every later test on `tick()`.
    vi.useRealTimers();
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--announcer']");
  const polite = () => query("[data-stimeo--announcer-target='polite']");
  const assertive = () => query("[data-stimeo--announcer-target='assertive']");
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--announcer",
    ) as AnnouncerController;

  /** Mounts the controller with no authored targets, so both regions are generated. */
  const startWithoutTargets = async (attrs = "") => {
    document.body.innerHTML = `<div data-controller="stimeo--announcer" ${attrs}></div>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    await tick();
  };

  /** Every polite live region currently in the document. */
  const politeRegions = () => [...document.querySelectorAll<HTMLElement>('[aria-live="polite"]')];

  /** Dispatches the programmatic announce event with the given detail. */
  const announce = (detail: Record<string, unknown>, target: EventTarget = window) => {
    target.dispatchEvent(new CustomEvent("stimeo--announcer:announce", { detail, bubbles: true }));
  };

  it("announces a polite message via the programmatic event", async () => {
    await start();
    announce({ message: "12 results" });
    await tick();
    expect(polite().textContent).toBe("12 results");
    expect(assertive().textContent).toBe("");
  });

  it("routes assertive announcements to the assertive region", async () => {
    await start();
    announce({ message: "Connection lost", assertive: true });
    await tick();
    expect(assertive().textContent).toBe("Connection lost");
    expect(polite().textContent).toBe("");
  });

  it("ignores an empty or non-string message", async () => {
    await start();
    announce({ message: "" });
    await tick();
    announce({ message: 42 });
    await tick();
    announce({});
    await tick();
    expect(polite().textContent).toBe("");
  });

  it("announces via a click-triggered Stimulus action param", async () => {
    await start(
      "",
      `<button id="t" data-action="click->stimeo--announcer#announce"
               data-stimeo--announcer-message-param="Saved">Save</button>`,
    );
    query<HTMLButtonElement>("#t").click();
    await tick();
    expect(polite().textContent).toBe("Saved");
  });

  it("handles an event dispatched on the element exactly once (no double-announce)", async () => {
    await start();
    let writes = 0;
    // Observe how many times the region text is (re)written by spying on the node.
    const region = polite();
    const observer = new MutationObserver(() => {
      writes += 1;
    });
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    // Dispatch on the element with bubbles:true — reaches the element AND window
    // listener, but the WeakSet guard must keep it to a single announcement.
    announce({ message: "Once" }, root());
    await tick();
    observer.disconnect();
    expect(region.textContent).toBe("Once");
    expect(writes).toBe(1);
  });

  it("re-announces identical text by clearing then re-setting (dedupe)", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div data-controller="stimeo--announcer">
        <div data-stimeo--announcer-target="polite" aria-live="polite" aria-atomic="true"></div>
        <div data-stimeo--announcer-target="assertive" aria-live="assertive" aria-atomic="true"></div>
      </div>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    await vi.advanceTimersByTimeAsync(0);

    announce({ message: "Saved" });
    await vi.advanceTimersByTimeAsync(0);
    expect(polite().textContent).toBe("Saved");
    // Re-announcing the same text first clears the region so the atomic region
    // is observed changing, then re-sets it on the next task.
    announce({ message: "Saved" });
    await vi.advanceTimersByTimeAsync(0);
    expect(polite().textContent).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(polite().textContent).toBe("Saved");
    vi.useRealTimers();
  });

  it("does not re-announce identical text when dedupeReannounce is false", async () => {
    await start(`data-stimeo--announcer-dedupe-reannounce-value="false"`);
    announce({ message: "Saved" });
    await tick();
    announce({ message: "Saved" });
    await tick();
    // Region keeps the text without the clear-then-reset cycle.
    expect(polite().textContent).toBe("Saved");
  });

  it("auto-clears the region after clearAfter", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div data-controller="stimeo--announcer"
           data-stimeo--announcer-clear-after-value="1000">
        <div data-stimeo--announcer-target="polite" aria-live="polite" aria-atomic="true"></div>
        <div data-stimeo--announcer-target="assertive" aria-live="assertive" aria-atomic="true"></div>
      </div>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    await vi.advanceTimersByTimeAsync(0);

    announce({ message: "Saved" });
    await vi.advanceTimersByTimeAsync(0);
    expect(polite().textContent).toBe("Saved");
    await vi.advanceTimersByTimeAsync(1000);
    expect(polite().textContent).toBe("");
    vi.useRealTimers();
  });

  it("does not auto-clear when clearAfter is 0", async () => {
    await start(`data-stimeo--announcer-clear-after-value="0"`);
    announce({ message: "Persisted" });
    await tick();
    expect(polite().textContent).toBe("Persisted");
  });

  it("keeps the current announcement when a later event carries no message", async () => {
    await start(`data-stimeo--announcer-clear-after-value="0"`);
    announce({ message: "Saved" });
    await tick();
    // None of these carry an announceable message, so none may blank the region.
    announce({});
    await tick();
    announce({ message: 42 });
    await tick();
    announce({ message: "" });
    await tick();
    expect(polite().textContent).toBe("Saved");
  });

  it("keeps the current announcement when the action fires without a message", async () => {
    await start(
      `data-stimeo--announcer-clear-after-value="0"`,
      `<button id="t" data-action="click->stimeo--announcer#announce">Announce</button>`,
    );
    announce({ message: "Saved" });
    await tick();
    query<HTMLButtonElement>("#t").click();
    await tick();
    expect(polite().textContent).toBe("Saved");
  });

  it("falls back to the event detail when the action has no message param", async () => {
    await start(
      `data-stimeo--announcer-clear-after-value="0"`,
      `<button id="t" data-action="app:done->stimeo--announcer#announce"></button>`,
    );
    query<HTMLButtonElement>("#t").dispatchEvent(
      new CustomEvent("app:done", { detail: { message: "From detail", assertive: true } }),
    );
    await tick();
    expect(assertive().textContent).toBe("From detail");
    expect(polite().textContent).toBe("");
  });

  it("keeps a re-announced message for its own full clearAfter window", async () => {
    vi.useFakeTimers();
    mount(`data-stimeo--announcer-clear-after-value="1000"`);
    await vi.advanceTimersByTimeAsync(0);

    announce({ message: "Saved" });
    await vi.advanceTimersByTimeAsync(500);
    announce({ message: "Saved" }); // dedupe: clears on one pass, re-sets on the next
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(polite().textContent).toBe("Saved");
    // The first announcement's clear falls due here. It must not cut the
    // re-announcement's own clearAfter window short.
    await vi.advanceTimersByTimeAsync(500);
    expect(polite().textContent).toBe("Saved");
    await vi.advanceTimersByTimeAsync(500);
    expect(polite().textContent).toBe("");
    vi.useRealTimers();
  });

  it("queues a newer message behind a pending re-announce", async () => {
    vi.useFakeTimers();
    mount(`data-stimeo--announcer-clear-after-value="0"`);
    await vi.advanceTimersByTimeAsync(0);

    announce({ message: "Saved" });
    await vi.advanceTimersByTimeAsync(0);
    announce({ message: "Saved" }); // dedupe: the clear takes one pass
    announce({ message: "Deleted" }); // queued behind it, written on the pass after
    await vi.advanceTimersByTimeAsync(0);
    expect(polite().textContent).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(polite().textContent).toBe("Saved");
    await vi.advanceTimersByTimeAsync(1);
    expect(polite().textContent).toBe("Deleted");
    // The queued re-set of the older text must not overwrite the newer message.
    await vi.advanceTimersByTimeAsync(0);
    expect(polite().textContent).toBe("Deleted");
    vi.useRealTimers();
  });

  it("auto-clears after the default clearAfter", async () => {
    vi.useFakeTimers();
    mount();
    await vi.advanceTimersByTimeAsync(0);

    announce({ message: "Saved" });
    await vi.advanceTimersByTimeAsync(999);
    expect(polite().textContent).toBe("Saved");
    await vi.advanceTimersByTimeAsync(1);
    expect(polite().textContent).toBe("");
    vi.useRealTimers();
  });

  // --- `clearAfter` belongs to one written message ---------------------------------

  /**
   * Rewrites `clearAfter` and delivers its Value callback directly when the controller
   * defines one, since happy-dom does not reliably run it for an attribute write.
   */
  const declareClearAfter = (value: number) => {
    root().setAttribute("data-stimeo--announcer-clear-after-value", String(value));
    const owner = controller();
    const callback: unknown = Reflect.get(owner, "clearAfterValueChanged");
    if (typeof callback === "function") callback.call(owner);
  };

  it.each([
    { direction: "shrinks", next: 50 },
    { direction: "grows", next: 5000 },
  ])(
    "keeps a written message's clear deadline when clearAfter $direction, and times the next message anew",
    async ({ next }) => {
      vi.useFakeTimers();
      mount(`data-stimeo--announcer-clear-after-value="1000"`);
      await vi.advanceTimersByTimeAsync(0);

      announce({ message: "First" });
      await vi.advanceTimersByTimeAsync(100);
      declareClearAfter(next);
      await vi.advanceTimersByTimeAsync(899); // t=999
      expect(polite().textContent).toBe("First");
      await vi.advanceTimersByTimeAsync(1); // t=1000, the deadline "First" was written with
      expect(polite().textContent).toBe("");

      announce({ message: "Second" });
      await vi.advanceTimersByTimeAsync(next - 1);
      expect(polite().textContent).toBe("Second");
      await vi.advanceTimersByTimeAsync(1);
      expect(polite().textContent).toBe("");
      vi.useRealTimers();
    },
  );

  it("arms and writes nothing from a clearAfter change alone", async () => {
    vi.useFakeTimers();
    mount(`data-stimeo--announcer-clear-after-value="0"`);
    await vi.advanceTimersByTimeAsync(0);

    announce({ message: "Standing" }); // written with no clear promised
    await vi.advanceTimersByTimeAsync(0);
    declareClearAfter(20);
    await vi.advanceTimersByTimeAsync(1000);
    expect(polite().textContent).toBe("Standing");
    expect(assertive().textContent).toBe("");
    vi.useRealTimers();
  });

  it("keeps a repeat written with clearAfter 0 past the earlier write's deadline", async () => {
    vi.useFakeTimers();
    mount(
      `data-stimeo--announcer-clear-after-value="1000" data-stimeo--announcer-dedupe-reannounce-value="false"`,
    );
    await vi.advanceTimersByTimeAsync(0);

    announce({ message: "Saved" }); // clear due at t=1000
    await vi.advanceTimersByTimeAsync(100);
    declareClearAfter(0);
    announce({ message: "Saved" }); // written again, with no clear promised
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(polite().textContent).toBe("Saved");
    vi.useRealTimers();
  });

  it("clears each region on its own schedule", async () => {
    vi.useFakeTimers();
    mount(`data-stimeo--announcer-clear-after-value="1000"`);
    await vi.advanceTimersByTimeAsync(0);

    announce({ message: "Polite" });
    await vi.advanceTimersByTimeAsync(100);
    // The assertive announcement must not disturb the polite region's clear.
    announce({ message: "Assertive", assertive: true });
    await vi.advanceTimersByTimeAsync(900); // t=1000
    expect(polite().textContent).toBe("");
    expect(assertive().textContent).toBe("Assertive");
    await vi.advanceTimersByTimeAsync(100); // t=1100
    expect(assertive().textContent).toBe("");
    vi.useRealTimers();
  });

  it("clears the pending auto-clear timer on disconnect", async () => {
    vi.useFakeTimers();
    mount();
    await vi.advanceTimersByTimeAsync(0);

    announce({ message: "Saved" });
    await vi.advanceTimersByTimeAsync(0);
    controller().disconnect();
    await vi.advanceTimersByTimeAsync(5000);
    // A disconnected controller must not write to the DOM any more.
    expect(polite().textContent).toBe("Saved");
    vi.useRealTimers();
  });

  it("keeps the other region's clear timer when a recycled handle meets a released one", async () => {
    // A platform may give a handle released by `clearTimeout` to the next timer
    // it creates. A region's pending clear that outlives the timer it named would
    // then point at whatever now owns that handle — here, the other region's.
    vi.useFakeTimers();
    mount(`data-stimeo--announcer-clear-after-value="1000"`);
    await vi.advanceTimersByTimeAsync(0);
    const timers = installRecyclingTimers();
    try {
      announce({ message: "a" });
      await vi.advanceTimersByTimeAsync(0);
      expect(polite().textContent).toBe("a");

      controller().disconnect();
      controller().connect();
      await vi.advanceTimersByTimeAsync(0);

      announce({ message: "z", assertive: true });
      await vi.advanceTimersByTimeAsync(0);
      announce({ message: "b" });
      await vi.advanceTimersByTimeAsync(0);
      expect(assertive().textContent).toBe("z");
      expect(polite().textContent).toBe("b");
      // A released handle really did come back, so the collision above is one.
      expect(new Set(timers.handed).size).toBeLessThan(timers.handed.length);

      await vi.advanceTimersByTimeAsync(1000);
      expect(polite().textContent).toBe("");
      expect(assertive().textContent).toBe("");
    } finally {
      timers.restore();
      vi.useRealTimers();
    }
  });

  it("has both live regions in place before the first announcement", async () => {
    document.body.innerHTML = `<div data-controller="stimeo--announcer"></div>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    await tick();

    // Assistive tech reports a change to a live region it already knows about, so
    // the missing regions must exist before — not with — their first message.
    const regions = Array.from(root().querySelectorAll("[aria-live]"));
    expect(regions.map((node) => node.getAttribute("aria-live")).sort()).toEqual([
      "assertive",
      "polite",
    ]);
    expect(regions.map((node) => node.textContent)).toEqual(["", ""]);

    let addedElements = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) addedElements += 1;
        }
      }
    });
    observer.observe(root(), { childList: true, subtree: true });
    announce({ message: "First" });
    await tick();
    observer.disconnect();

    // Only the text node changed: no region was created in the same task.
    expect(addedElements).toBe(0);
    expect(query("[aria-live='polite']", root()).textContent).toBe("First");
  });

  it("reuses the generated region across announcements", async () => {
    document.body.innerHTML = `<div data-controller="stimeo--announcer"
                                    data-stimeo--announcer-clear-after-value="0"></div>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    await tick();

    announce({ message: "One" });
    await tick();
    announce({ message: "Two" });
    await tick();
    expect(root().querySelectorAll("[aria-live='polite']")).toHaveLength(1);
    expect(query("[aria-live='polite']", root()).textContent).toBe("Two");
  });

  it("generates a hidden live region when the target is absent", async () => {
    document.body.innerHTML = `<div data-controller="stimeo--announcer"></div>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    await tick();

    announce({ message: "Generated" });
    await tick();
    const generated = query("[aria-live='polite']", root());
    expect(generated.textContent).toBe("Generated");
    expect(generated.getAttribute("aria-atomic")).toBe("true");
    // Visually hidden so the announcement is heard but not seen.
    expect(generated.style.position).toBe("absolute");
  });

  it("does not move focus when announcing", async () => {
    await start("", `<button id="t">Focus me</button>`);
    const button = query<HTMLButtonElement>("#t");
    button.focus();
    announce({ message: "No steal" });
    await tick();
    expect(document.activeElement).toBe(button);
  });

  it("removes listeners and generated regions on disconnect", async () => {
    document.body.innerHTML = `<div data-controller="stimeo--announcer"></div>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    await tick();

    announce({ message: "Before" });
    await tick();
    expect(query("[aria-live='polite']", root()).textContent).toBe("Before");

    controller().disconnect();
    // No reconnection follows within the probe window: a real detach.
    await flushMicrotasks();
    expect(root().querySelector("[aria-live='polite']")).toBeNull();
    // The window listener is gone: a later event is ignored (no region recreated).
    announce({ message: "After" });
    await tick();
    expect(root().querySelector("[aria-live]")).toBeNull();
  });

  it.each([
    { clone: "inside the event", settle: async () => {} },
    { clone: "a task after the event", settle: tick },
  ])(
    "keeps one region per politeness on every snapshot restore, cloned $clone",
    async ({ settle }) => {
      await startWithoutTargets();

      const counts: number[] = [];
      for (let round = 0; round < 3; round += 1) {
        counts.push(root().querySelectorAll("[aria-live]").length);
        document.dispatchEvent(new Event("turbo:before-cache"));
        // Turbo clones the page a task after `turbo:before-cache`. A render that
        // waits — a paused `turbo:before-render`, a new stylesheet, a view
        // transition — swaps the body only after that clone, so the controller is
        // still connected when the clone is taken.
        await settle();
        const snapshot = document.body.innerHTML;
        disconnectAndStopApplication(application);
        // Back button: the cached markup returns and Stimulus connects again.
        document.body.innerHTML = snapshot;
        application = Application.start();
        application.register("stimeo--announcer", AnnouncerController);
        await tick();
      }
      counts.push(root().querySelectorAll("[aria-live]").length);
      expect(counts).toEqual([2, 2, 2, 2]);
    },
  );

  it("drops the stand-ins a host arrives with and keeps what the author wrote", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--announcer" data-stimeo--announcer-clear-after-value="0">
        <div data-stimeo--announcer-target="polite" aria-live="polite" aria-atomic="true"></div>
        <p id="note">Status</p>
        <div data-stimeo--announcer-stand-in aria-live="polite" aria-atomic="true"></div>
        <div data-stimeo--announcer-stand-in aria-live="assertive" aria-atomic="true"></div>
      </div>`;
    const inherited = [...document.querySelectorAll("[data-stimeo--announcer-stand-in]")];
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    await tick();

    // The authored target owns polite; assertive gets a stand-in of this connection's own.
    expect(inherited.filter((node) => node.isConnected)).toEqual([]);
    expect(politeRegions()).toHaveLength(1);
    expect(politeRegions()[0]).toBe(polite());
    const assertiveRegions = document.querySelectorAll<HTMLElement>('[aria-live="assertive"]');
    expect(assertiveRegions).toHaveLength(1);
    expect(query("#note").isConnected).toBe(true);
    announce({ message: "Saved" });
    announce({ message: "Lost", assertive: true });
    await tick();
    expect(polite().textContent).toBe("Saved");
    expect(assertiveRegions[0]?.textContent).toBe("Lost");
  });

  it("keeps announcing through turbo:before-cache", async () => {
    document.body.innerHTML = `<div data-controller="stimeo--announcer"
                                    data-stimeo--announcer-clear-after-value="0"></div>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    await tick();

    document.dispatchEvent(new Event("turbo:before-cache"));
    // Turbo dispatches it on pages that stay as well, which must still announce.
    announce({ message: "Still here" });
    await tick();
    expect(root().querySelectorAll("[aria-live='polite']")).toHaveLength(1);
    expect(query("[aria-live='polite']", root()).textContent).toBe("Still here");
  });

  it("stops responding to element-dispatched events after disconnect", async () => {
    await start(`data-stimeo--announcer-clear-after-value="0"`);
    announce({ message: "Before" }, root());
    await tick();
    expect(polite().textContent).toBe("Before");

    controller().disconnect();
    await flushMicrotasks();
    // The element listener is gone too, not just the window one.
    announce({ message: "After" }, root());
    await tick();
    expect(polite().textContent).toBe("Before");
  });

  it("announces a non-bubbling event dispatched on the element", async () => {
    await start();
    root().dispatchEvent(
      new CustomEvent("stimeo--announcer:announce", { detail: { message: "Direct" } }),
    );
    await tick();
    expect(polite().textContent).toBe("Direct");
  });

  it("leaves no stand-in behind when Stimulus tears the controller down", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--announcer">
        <div data-stimeo--announcer-target="polite" aria-live="polite" aria-atomic="true"></div>
      </div>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    await tick();
    expect(document.querySelectorAll('[aria-live="assertive"]')).toHaveLength(1);

    // Stimulus reports each target disconnected after `disconnect()` has returned.
    application.unload("stimeo--announcer");
    await tick();
    expect(document.querySelector('[aria-live="assertive"]')).toBeNull();
  });

  it("stops watching the host's children on disconnect", async () => {
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    const release = vi.spyOn(MutationObserver.prototype, "disconnect");
    try {
      await startWithoutTargets();
      const hostWatch = observe.mock.calls.findIndex(
        ([target, options]) =>
          target === root() && JSON.stringify(options) === JSON.stringify({ childList: true }),
      );
      expect(hostWatch).not.toBe(-1);
      const watcher = observe.mock.contexts[hostWatch];

      controller().disconnect();
      await flushMicrotasks();
      expect(release.mock.contexts).toContain(watcher);
    } finally {
      observe.mockRestore();
      release.mockRestore();
    }
  });

  it("leaves no stand-in once it disconnects", async () => {
    await startWithoutTargets();
    // Turbo's body swap can disconnect the controller before the next task starts.
    controller().disconnect();
    await tick();
    expect(root().querySelector("[aria-live]")).toBeNull();
  });

  it("keeps what was queued across an in-page move and reads it before what follows", async () => {
    vi.useFakeTimers();
    mount(`data-stimeo--announcer-clear-after-value="0"`);
    await vi.advanceTimersByTimeAsync(0);

    announce({ message: "Kept" });
    controller().disconnect();
    controller().connect();
    announce({ message: "A" });
    await vi.advanceTimersByTimeAsync(0);
    expect(polite().textContent).toBe("Kept");
    await vi.advanceTimersByTimeAsync(1);
    expect(polite().textContent).toBe("A");
    vi.useRealTimers();
  });

  it("drops what was queued when it is detached, and drains afresh once it connects again", async () => {
    vi.useFakeTimers();
    mount(`data-stimeo--announcer-clear-after-value="0"`);
    await vi.advanceTimersByTimeAsync(0);

    announce({ message: "Dropped" });
    controller().disconnect();
    await flushMicrotasks();
    controller().connect();
    announce({ message: "A" });
    announce({ message: "B" });
    await vi.advanceTimersByTimeAsync(0);
    expect(polite().textContent).toBe("A");
    await vi.advanceTimersByTimeAsync(1);
    expect(polite().textContent).toBe("B");
    vi.useRealTimers();
  });

  // The announced text must reach the live region's accessible name.
  it("announces the message text through the live region", async () => {
    await start(`data-stimeo--announcer-clear-after-value="0"`);
    announce({ message: "Profile saved" });
    await tick();
    const spoken = await captureSpeech({ container: polite(), steps: 1 });
    // The polite region must announce the message text.
    expect(spoken).toContain("Profile saved");
  });

  it("announces every message of a burst, in order", async () => {
    // Assistive tech announces the changes it observes, so several messages written
    // into one region within a single task would be one change and only the last
    // would be read. Each message gets its own pass.
    await start();
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(polite().textContent ?? ""));
    observer.observe(polite(), { characterData: true, childList: true, subtree: true });
    announce({ message: "M1" });
    announce({ message: "M2" });
    announce({ message: "M3" });
    await tick();
    await tick();
    await tick();
    observer.disconnect();
    expect(seen).toEqual(["M1", "M2", "M3"]);
  });

  it("keeps an assertive burst from waiting behind the polite queue", async () => {
    await start();
    announce({ message: "P1" });
    announce({ message: "A1", assertive: true });
    await tick();
    expect(polite().textContent).toBe("P1");
    expect(assertive().textContent).toBe("A1");
  });

  it("routes the assertive action param to the assertive region", async () => {
    await start(
      "",
      `<button type="button" data-action="click->stimeo--announcer#announce"
               data-stimeo--announcer-message-param="Connection lost"
               data-stimeo--announcer-assertive-param="true">Notify</button>`,
    );
    query("button").click();
    await tick();
    expect(assertive().textContent).toBe("Connection lost");
    expect(polite().textContent).toBe("");
  });

  it("retires the generated stand-in when a target appears at runtime", async () => {
    await startWithoutTargets();
    const added = document.createElement("p");
    added.setAttribute("data-stimeo--announcer-target", "polite");
    added.setAttribute("aria-live", "polite");
    root().appendChild(added);
    await tick();
    // Two regions for one politeness means an empty one nothing ever writes to.
    expect(politeRegions().length).toBe(1);
    announce({ message: "Saved" });
    await tick();
    expect(added.textContent).toBe("Saved");
  });

  it("materialises a stand-in when the target goes away at runtime", async () => {
    await start();
    polite().remove();
    await tick();
    expect(politeRegions().length).toBe(1);
    announce({ message: "Saved" });
    await tick();
    expect(politeRegions()[0]?.textContent).toBe("Saved");
  });

  it("puts back a generated region a morph removed", async () => {
    // A morph drops the generated region: the server's HTML never had it. Writing
    // into the detached node afterwards would announce nothing at all.
    await startWithoutTargets();
    politeRegions()[0]?.remove();
    await tick();
    expect(politeRegions().length).toBe(1);
    announce({ message: "Back" });
    await tick();
    expect(politeRegions()[0]?.textContent).toBe("Back");
    expect(politeRegions()[0]?.isConnected).toBe(true);
  });

  it("seats a region that left unobserved one pass before writing into it", async () => {
    await startWithoutTargets(`data-stimeo--announcer-clear-after-value="0"`);
    const generated = query("[aria-live='polite']", root());
    const wrap = document.createElement("div");
    root().append(wrap);
    wrap.append(generated);
    await tick();
    // Removed from below the host, the region leaves the host's own children unchanged.
    generated.remove();
    announce({ message: "Back" });
    await tick();
    expect(politeRegions()).toHaveLength(1);
    expect(politeRegions()[0]?.textContent).toBe("");
    await tick();
    expect(politeRegions()[0]?.textContent).toBe("Back");
  });

  describe.each(["polite", "assertive"] as const)(
    "the %s target nested below the host",
    (level) => {
      /** Every live region of this politeness in the document. */
      const regions = () => [...document.querySelectorAll<HTMLElement>(`[aria-live="${level}"]`)];

      /**
       * Delivers the target callback directly as well, since happy-dom does not
       * reliably run it for a nested insertion or removal.
       */
      const deliver = (change: "connected" | "disconnected") => {
        const owner = controller();
        if (level === "polite") {
          if (change === "connected") owner.politeTargetConnected();
          else owner.politeTargetDisconnected();
        } else if (change === "connected") owner.assertiveTargetConnected();
        else owner.assertiveTargetDisconnected();
      };

      it("retires the stand-in when it appears", async () => {
        await startWithoutTargets();
        const wrap = document.createElement("div");
        root().append(wrap);
        await tick();
        const added = document.createElement("div");
        added.setAttribute("data-stimeo--announcer-target", level);
        added.setAttribute("aria-live", level);
        wrap.append(added);
        deliver("connected");
        await tick();
        expect(regions()).toEqual([added]);
      });

      it("materialises a stand-in before any message when it goes away", async () => {
        document.body.innerHTML = `
        <div data-controller="stimeo--announcer">
          <div>
            <div data-stimeo--announcer-target="${level}" aria-live="${level}"></div>
          </div>
        </div>`;
        application = Application.start();
        application.register("stimeo--announcer", AnnouncerController);
        await tick();
        query(`[data-stimeo--announcer-target="${level}"]`).remove();
        deliver("disconnected");
        await tick();
        expect(regions()).toHaveLength(1);
        expect(regions()[0]?.parentElement).toBe(root());
      });
    },
  );

  it("keeps one generated region per politeness when the host's other children change", async () => {
    await startWithoutTargets();
    root().append(document.createElement("p"));
    await tick();
    expect(root().querySelectorAll("[aria-live]")).toHaveLength(2);
  });

  /** Puts a restored copy of the page in place, as Turbo renders one from its cache. */
  const restore = async () => {
    application = await restoreFromCache(application, (restored) =>
      restored.register("stimeo--announcer", AnnouncerController),
    );
  };

  it("marks a region while it holds a message it wrote", async () => {
    vi.useFakeTimers();
    mount(`data-stimeo--announcer-clear-after-value="1000"`);
    await vi.advanceTimersByTimeAsync(0);

    announce({ message: "Saved" });
    await vi.advanceTimersByTimeAsync(0);
    expect(polite().hasAttribute("data-stimeo--announcer-announced")).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(polite().textContent).toBe("");
    expect(polite().hasAttribute("data-stimeo--announcer-announced")).toBe(false);
    vi.useRealTimers();
  });

  it("keeps the message on screen through turbo:before-cache", async () => {
    await start(`data-stimeo--announcer-clear-after-value="5000"`);
    announce({ message: "Current" });
    announce({ message: "Urgent", assertive: true });
    await tick();

    // Turbo dispatches it on pages that stay as well, where the message is being read.
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(polite().textContent).toBe("Current");
    expect(assertive().textContent).toBe("Urgent");
  });

  it("empties the authored regions a restored page carries a message in", async () => {
    await start(`data-stimeo--announcer-clear-after-value="5000"`);
    announce({ message: "Stale" });
    announce({ message: "Urgent", assertive: true });
    await tick();
    expect(polite().textContent).toBe("Stale");

    await restore();

    // A restored page must not read out an announcement from the previous visit.
    expect(polite().textContent).toBe("");
    expect(assertive().textContent).toBe("");
    expect(polite().hasAttribute("data-stimeo--announcer-announced")).toBe(false);
  });

  it("leaves text the page wrote after a message alone when that message's clear comes due", async () => {
    vi.useFakeTimers();
    mount(`data-stimeo--announcer-clear-after-value="1000"`);
    await vi.advanceTimersByTimeAsync(0);

    announce({ message: "Saved" });
    await vi.advanceTimersByTimeAsync(0);
    polite().textContent = "Mine";
    await vi.advanceTimersByTimeAsync(1000);

    expect(polite().textContent).toBe("Mine");
    vi.useRealTimers();
  });

  it("keeps an authored region's own text on connect", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--announcer">
        <div data-stimeo--announcer-target="polite" aria-live="polite" aria-atomic="true">3 results</div>
      </div>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    await tick();

    expect(polite().textContent).toBe("3 results");
  });

  it("keeps a message on display and its clearing timer across an in-page move", async () => {
    vi.useFakeTimers();
    mount(`data-stimeo--announcer-clear-after-value="5000"`);
    await vi.advanceTimersByTimeAsync(0);
    announce({ message: "Moved" });
    await vi.advanceTimersByTimeAsync(0);

    controller().disconnect();
    controller().connect();

    expect(polite().textContent).toBe("Moved");
    await vi.advanceTimersByTimeAsync(5000);
    expect(polite().textContent).toBe("");
    vi.useRealTimers();
  });

  it("empties a message whose clearing timer died with a detach", async () => {
    await start(`data-stimeo--announcer-clear-after-value="5000"`);
    announce({ message: "Detached" });
    await tick();

    controller().disconnect();
    await flushMicrotasks();
    controller().connect();

    expect(polite().textContent).toBe("");
  });

  it("keeps the regions seated on a live page through turbo:before-cache", async () => {
    await startWithoutTargets(`data-stimeo--announcer-clear-after-value="5000"`);
    const seated = politeRegions();
    announce({ message: "Current" });
    await tick();
    document.dispatchEvent(new Event("turbo:before-cache"));
    await tick();
    expect(politeRegions()).toHaveLength(1);
    expect(politeRegions()[0]).toBe(seated[0]);
    const regionsAdded: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          const live = (node as HTMLElement).getAttribute?.("aria-live");
          if (live) regionsAdded.push(live);
        }
      }
    });
    observer.observe(root(), { childList: true, subtree: true });
    announce({ message: "After" });
    await tick();
    observer.disconnect();
    // The region is already seated: the message must not arrive with it.
    expect(regionsAdded).toEqual([]);
    expect(politeRegions()[0]?.textContent).toBe("After");
  });

  it("announces an element-dispatched event once, not twice", async () => {
    // A bubbling event reaches the element listener and the window one; handling it
    // twice would queue the message twice and read it out twice.
    await start();
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(polite().textContent ?? ""));
    observer.observe(polite(), { characterData: true, childList: true, subtree: true });
    announce({ message: "Once" }, root());
    await tick();
    await tick();
    observer.disconnect();
    expect(seen).toEqual(["Once"]);
  });

  it("generates only the region whose target is missing", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--announcer">
        <div data-stimeo--announcer-target="polite" aria-live="polite" aria-atomic="true"></div>
      </div>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    await tick();
    expect(politeRegions().length).toBe(1);
    expect(document.querySelectorAll('[aria-live="assertive"]').length).toBe(1);
  });

  it("speaks a message queued as turbo:before-cache arrives", async () => {
    await start();
    announce({ message: "Spoken" });
    // A path that keeps the page dispatches it while the message waits for its pass.
    document.dispatchEvent(new Event("turbo:before-cache"));
    await tick();
    expect(polite().textContent).toBe("Spoken");
  });

  it("drains a burst queued before turbo:before-cache one message per pass", async () => {
    vi.useFakeTimers();
    mount(`data-stimeo--announcer-clear-after-value="0"`);
    await vi.advanceTimersByTimeAsync(0);

    announce({ message: "A" });
    document.dispatchEvent(new Event("turbo:before-cache"));
    announce({ message: "B" });
    announce({ message: "C" });
    await vi.advanceTimersByTimeAsync(0);
    expect(polite().textContent).toBe("A");
    await vi.advanceTimersByTimeAsync(1);
    expect(polite().textContent).toBe("B");
    await vi.advanceTimersByTimeAsync(1);
    expect(polite().textContent).toBe("C");
    vi.useRealTimers();
  });

  it("has no machine-detectable a11y violations", async () => {
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--announcer">
          <div data-stimeo--announcer-target="polite" aria-live="polite" aria-atomic="true"></div>
          <div data-stimeo--announcer-target="assertive" aria-live="assertive" aria-atomic="true"></div>
        </div>
      </main>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    await tick();
    await expectNoA11yViolations(document.body);
  });

  it("visuallyHide applies the canonical sr-only inline style", () => {
    const node = document.createElement("div");
    visuallyHide(node);
    expect(node.style.position).toBe("absolute");
    expect(node.style.width).toBe("1px");
    expect(node.style.overflow).toBe("hidden");
    expect(node.style.whiteSpace).toBe("nowrap");
  });
});
