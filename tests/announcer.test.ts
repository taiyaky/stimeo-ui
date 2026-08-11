import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnouncerController, visuallyHide } from "../src/controllers/announcer_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link AnnouncerController}: routing to the polite vs
 * assertive region, the Stimulus action and CustomEvent entry points, the
 * dedupe re-announce of identical text, auto-clear, fallback-region generation,
 * focus preservation, and listener/timer teardown on disconnect.
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
    expect(root().querySelector("[aria-live='polite']")).toBeNull();
    // The window listener is gone: a later event is ignored (no region recreated).
    announce({ message: "After" });
    await tick();
    expect(root().querySelector("[aria-live]")).toBeNull();
  });

  it("leaves no generated region in the Turbo snapshot", async () => {
    document.body.innerHTML = `<div data-controller="stimeo--announcer"></div>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    await tick();

    const counts: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      counts.push(root().querySelectorAll("[aria-live]").length);
      // Turbo clones the snapshot at `turbo:before-cache` and only then tears the
      // page down, so a region removed in `disconnect()` is already in the clone.
      document.dispatchEvent(new Event("turbo:before-cache"));
      const snapshot = document.body.innerHTML;
      disconnectAndStopApplication(application);
      // Back button: the cached markup returns and Stimulus connects again. A
      // restored region carries no target attribute, so it cannot be reused —
      // every visit would add another pair.
      document.body.innerHTML = snapshot;
      application = Application.start();
      application.register("stimeo--announcer", AnnouncerController);
      await tick();
    }
    counts.push(root().querySelectorAll("[aria-live]").length);
    expect(counts).toEqual([2, 2, 2, 2]);
  });

  it("keeps announcing on the live page after the snapshot rewind", async () => {
    document.body.innerHTML = `<div data-controller="stimeo--announcer"
                                    data-stimeo--announcer-clear-after-value="0"></div>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    await tick();

    document.dispatchEvent(new Event("turbo:before-cache"));
    // A cached page is not a torn-down one: a navigation that never completes
    // must still be able to announce.
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
    // The element listener is gone too, not just the window one.
    announce({ message: "After" }, root());
    await tick();
    expect(polite().textContent).toBe("Before");
  });

  // The announced text must reach the live region's accessible name.
  it("announces the message text through the live region", async () => {
    await start(`data-stimeo--announcer-clear-after-value="0"`);
    announce({ message: "Profile saved" });
    await tick();
    const spoken = await captureSpeech({ container: polite(), steps: 1 });
    // Freeze the whole ordered array: the polite region must announce exactly the
    // message text (no spurious role/name leaking in).
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

  it("empties an authored region before the snapshot is taken", async () => {
    await start(`data-stimeo--announcer-clear-after-value="5000"`);
    announce({ message: "Stale" });
    await tick();
    expect(polite().textContent).toBe("Stale");
    document.dispatchEvent(new Event("turbo:before-cache"));
    // A restored page must not read out an announcement from the previous visit.
    expect(polite().textContent).toBe("");
  });

  it("re-seats the regions on a live page after the snapshot rewind", async () => {
    await startWithoutTargets();
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(politeRegions().length).toBe(0);
    // The visit was aborted, so this page keeps running: the regions have to come
    // back on their own, or the next message is written into a region assistive
    // tech has never seen.
    await tick();
    expect(politeRegions().length).toBe(1);
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

  it("drops a queued message when the snapshot rewind overtakes it", async () => {
    await start();
    announce({ message: "Never" });
    // The rewind empties the queue while its pass is already armed; that pass has
    // to find nothing rather than write a message into the cached page.
    document.dispatchEvent(new Event("turbo:before-cache"));
    await tick();
    expect(polite().textContent).toBe("");
  });

  it("empties the assertive region too before the snapshot is taken", async () => {
    await start(`data-stimeo--announcer-clear-after-value="5000"`);
    announce({ message: "Urgent", assertive: true });
    await tick();
    expect(assertive().textContent).toBe("Urgent");
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(assertive().textContent).toBe("");
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
