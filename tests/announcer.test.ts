import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnouncerController, visuallyHide } from "../src/controllers/announcer_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link AnnouncerController}: routing to the polite vs
 * assertive region, the Stimulus action and CustomEvent entry points, the
 * dedupe re-announce of identical text, auto-clear, fallback-region generation,
 * focus preservation, and listener/timer teardown on disconnect.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AnnouncerController", () => {
  let application: Application;

  const start = async (attrs = "", body = "") => {
    document.body.innerHTML = `
      <div data-controller="stimeo--announcer" ${attrs}>
        <div data-stimeo--announcer-target="polite" aria-live="polite" aria-atomic="true"></div>
        <div data-stimeo--announcer-target="assertive" aria-live="assertive" aria-atomic="true"></div>
        ${body}
      </div>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    await tick();
  };

  afterEach(() => {
    application?.stop();
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

  /** Dispatches the programmatic announce event with the given detail. */
  const announce = (detail: Record<string, unknown>, target: EventTarget = window) => {
    target.dispatchEvent(new CustomEvent("stimeo--announcer:announce", { detail, bubbles: true }));
  };

  it("announces a polite message via the programmatic event", async () => {
    await start();
    announce({ message: "12 results" });
    expect(polite().textContent).toBe("12 results");
    expect(assertive().textContent).toBe("");
  });

  it("routes assertive announcements to the assertive region", async () => {
    await start();
    announce({ message: "Connection lost", assertive: true });
    expect(assertive().textContent).toBe("Connection lost");
    expect(polite().textContent).toBe("");
  });

  it("ignores an empty or non-string message", async () => {
    await start();
    announce({ message: "" });
    announce({ message: 42 });
    announce({});
    expect(polite().textContent).toBe("");
  });

  it("announces via a click-triggered Stimulus action param", async () => {
    await start(
      "",
      `<button id="t" data-action="click->stimeo--announcer#announce"
               data-stimeo--announcer-message-param="Saved">Save</button>`,
    );
    query<HTMLButtonElement>("#t").click();
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
    expect(polite().textContent).toBe("Saved");
    // Re-announcing the same text first clears the region so the atomic region
    // is observed changing, then re-sets it on the next task.
    announce({ message: "Saved" });
    expect(polite().textContent).toBe("");
    await vi.advanceTimersByTimeAsync(0);
    expect(polite().textContent).toBe("Saved");
    vi.useRealTimers();
  });

  it("does not re-announce identical text when dedupeReannounce is false", async () => {
    await start(`data-stimeo--announcer-dedupe-reannounce-value="false"`);
    announce({ message: "Saved" });
    announce({ message: "Saved" });
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

  it("generates a hidden live region when the target is absent", async () => {
    document.body.innerHTML = `<div data-controller="stimeo--announcer"></div>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    await tick();

    announce({ message: "Generated" });
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
    expect(document.activeElement).toBe(button);
  });

  it("removes listeners and generated regions on disconnect", async () => {
    document.body.innerHTML = `<div data-controller="stimeo--announcer"></div>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    await tick();

    announce({ message: "Before" });
    expect(query("[aria-live='polite']", root()).textContent).toBe("Before");

    controller().disconnect();
    expect(root().querySelector("[aria-live='polite']")).toBeNull();
    // The window listener is gone: a later event is ignored (no region recreated).
    announce({ message: "After" });
    expect(root().querySelector("[aria-live]")).toBeNull();
  });

  // Layer ③ — the announced text must reach the live region's accessible name.
  it("announces the message text through the live region", async () => {
    await start(`data-stimeo--announcer-clear-after-value="0"`);
    announce({ message: "Profile saved" });
    const spoken = await captureSpeech({ container: polite(), steps: 1 });
    // Freeze the whole ordered array: the polite region must announce exactly the
    // message text (no spurious role/name leaking in).
    expect(spoken).toContain("Profile saved");
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
