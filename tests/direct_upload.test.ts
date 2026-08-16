import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnnouncerController } from "../src/controllers/announcer_controller";
import { DirectUploadController } from "../src/controllers/direct_upload_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link DirectUploadController}: row creation and naming
 * from every event path, progress clamping, terminal-state stickiness across the
 * real error-then-end ActiveStorage order, aggregate lifecycle, shared-announcer
 * messages, native-alert suppression, removeOnDone, scope (all four events plus
 * the broken-selector fallback), Turbo before-cache rewind, live-DOM self-heal,
 * and listener/timer teardown. The `direct-upload:*` events are fired on
 * document — where ActiveStorage's bubble to — as cancelable, like the real ones.
 */

const REMOVE_DELAY = 4000;

describe("DirectUploadController", () => {
  let application: Application;
  let announcements: string[] = [];

  const onAnnouncement = (event: Event) => {
    announcements.push((event as CustomEvent<{ message: string }>).detail.message);
  };

  const MARKUP = `
    <div id="harness">
      <div data-controller="stimeo--direct-upload"
           data-stimeo--direct-upload-announce-done-text-value="{name} uploaded"
           data-stimeo--direct-upload-announce-error-text-value="{name} failed"
           ATTRS>
        <div data-stimeo--direct-upload-target="list"></div>
        <template data-stimeo--direct-upload-target="row">
          <div role="progressbar" aria-valuemin="0" aria-valuemax="100">
            <span data-field="name"></span><span data-field="percent"></span>
          </div>
        </template>
      </div>
      <div data-controller="stimeo--announcer">
        <div id="du-announcer" data-stimeo--announcer-target="polite"
             aria-live="polite" aria-atomic="true"></div>
      </div>
    </div>`;

  const start = () => {
    application = Application.start();
    application.register("stimeo--direct-upload", DirectUploadController);
    application.register("stimeo--announcer", AnnouncerController);
  };

  const mount = async (attrs = "") => {
    document.body.innerHTML = MARKUP.replace("ATTRS", attrs);
    start();
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    announcements = [];
    window.addEventListener("stimeo--announcer:announce", onAnnouncement);
  });

  afterEach(() => {
    window.removeEventListener("stimeo--announcer:announce", onAnnouncement);
    disconnectAndStopApplication(application);
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  // Cancelable mirrors ActiveStorage's dispatch, so preventDefault is observable.
  const fire = (type: string, detail: Record<string, unknown>) => {
    const event = new CustomEvent(type, { detail, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event;
  };
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>("[role='progressbar']"));
  const firstRow = () => {
    const [row] = rows();
    if (!row) throw new Error("no progress row");
    return row;
  };
  const element = () => query("[data-controller='stimeo--direct-upload']");
  const list = () => query("[data-stimeo--direct-upload-target='list']");
  const capture = (name: string) => {
    const seen: unknown[] = [];
    element().addEventListener(`stimeo--direct-upload:${name}`, (e) => {
      seen.push((e as CustomEvent).detail);
    });
    return seen;
  };

  it("creates a fully initialized row and the aggregate on initialize", async () => {
    await mount();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });

    const row = firstRow();
    expect(row.querySelector("[data-field='name']")?.textContent).toBe("a.png");
    expect(row.getAttribute("aria-label")).toBe("a.png");
    expect(row.getAttribute("aria-valuenow")).toBe("0");
    expect(row.getAttribute("aria-valuetext")).toBe("0%");
    expect(row.querySelector("[data-field='percent']")?.textContent).toBe("0%");
    expect(row.getAttribute("data-upload-state")).toBe("uploading");
    expect(row.style.getPropertyValue("--stimeo--upload-progress")).toBe("0%");
    // Adding a row is an aggregate change on its own.
    expect(element().getAttribute("data-upload-progress")).toBe("0");
    expect(element().style.getPropertyValue("--stimeo--upload-progress")).toBe("0%");
  });

  it("keeps a template-authored aria-label but still names and announces the file", async () => {
    document.body.innerHTML = MARKUP.replace("ATTRS", "").replace(
      'role="progressbar"',
      'role="progressbar" aria-label="Upload"',
    );
    start();
    await vi.advanceTimersByTimeAsync(0);
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    expect(firstRow().getAttribute("aria-label")).toBe("Upload");
    // The visible name never depends on the label policy.
    expect(firstRow().querySelector("[data-field='name']")?.textContent).toBe("a.png");
    fire("direct-upload:end", { id: 1, file: { name: "a.png" } });
    // The event names the file; the authored label stays on the row only.
    expect(announcements).toEqual(["a.png uploaded"]);
  });

  it("treats a whitespace-only authored label as absent", async () => {
    document.body.innerHTML = MARKUP.replace("ATTRS", "").replace(
      'role="progressbar"',
      'role="progressbar" aria-label="  "',
    );
    start();
    await vi.advanceTimersByTimeAsync(0);
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    // Whitespace computes to no accessible name, so the file name takes over.
    expect(firstRow().getAttribute("aria-label")).toBe("a.png");
  });

  it("announces the displayed name over an authored label when the event carries none", async () => {
    document.body.innerHTML = MARKUP.replace("ATTRS", "").replace(
      'role="progressbar"',
      'role="progressbar" aria-label="Upload"',
    );
    start();
    await vi.advanceTimersByTimeAsync(0);
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:end", { id: 1 });
    // The row's stored name wins over the authored accessible name.
    expect(announcements).toEqual(["a.png uploaded"]);
  });

  it("announces the event name when the row shows no stored name", async () => {
    document.body.innerHTML = MARKUP.replace("ATTRS", "")
      .replace('<span data-field="name"></span>', "")
      .replace('role="progressbar"', 'role="progressbar" aria-label="Upload"');
    start();
    await vi.advanceTimersByTimeAsync(0);
    fire("direct-upload:end", { id: 7, file: { name: "late.png" } });
    expect(announcements).toEqual(["late.png uploaded"]);
  });

  it("re-arms removeOnDone across an in-page move and never removes failed rows", async () => {
    await mount('data-stimeo--direct-upload-remove-on-done-value="true"');
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:end", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:initialize", { id: 2, file: { name: "b.png" } });
    fire("direct-upload:error", { id: 2, file: { name: "b.png" }, error: "boom" });
    fire("direct-upload:end", { id: 2, file: { name: "b.png" } });

    // Moving the element disconnects and reconnects the same instance; the
    // teardown cancelled the pending removal, so connect() re-arms it.
    const shelter = document.createElement("div");
    document.body.append(shelter);
    shelter.append(element());
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(REMOVE_DELAY);
    expect(rows()).toHaveLength(1);
    expect(firstRow().getAttribute("data-upload-state")).toBe("error");
  });

  it("does not schedule removals on reconnect when removeOnDone is off", async () => {
    await mount();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:end", { id: 1, file: { name: "a.png" } });

    const shelter = document.createElement("div");
    document.body.append(shelter);
    shelter.append(element());
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(REMOVE_DELAY);
    expect(rows()).toHaveLength(1);
  });

  it("forgets rows left behind when the list target moves to a new element", async () => {
    await mount();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:progress", { id: 1, progress: 100 });

    // Re-point the target attribute; the old list and its row stay in the DOM.
    const oldList = list();
    const replacement = document.createElement("div");
    replacement.setAttribute("data-stimeo--direct-upload-target", "list");
    oldList.removeAttribute("data-stimeo--direct-upload-target");
    oldList.after(replacement);
    await vi.advanceTimersByTimeAsync(0);

    fire("direct-upload:progress", { id: 1, file: { name: "a.png" }, progress: 10 });
    // The stranded clone is retired and removed; only the live row remains.
    expect(rows()).toHaveLength(1);
    expect(replacement.children).toHaveLength(1);
    expect(element().getAttribute("data-upload-progress")).toBe("10");
  });

  it("leaves no generated row for the snapshot after a list swap", async () => {
    await mount();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    const oldList = list();
    const replacement = document.createElement("div");
    replacement.setAttribute("data-stimeo--direct-upload-target", "list");
    oldList.removeAttribute("data-stimeo--direct-upload-target");
    oldList.after(replacement);
    await vi.advanceTimersByTimeAsync(0);
    fire("direct-upload:progress", { id: 1, file: { name: "a.png" }, progress: 10 });

    document.dispatchEvent(new Event("turbo:before-cache"));
    // The rewind covers every generated row, including any the swap stranded.
    expect(rows()).toHaveLength(0);
  });

  it("keeps updating tracked rows when the list target is removed", async () => {
    await mount();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    list().removeAttribute("data-stimeo--direct-upload-target");
    await vi.advanceTimersByTimeAsync(0);
    fire("direct-upload:progress", { id: 1, progress: 40 });
    expect(firstRow().getAttribute("aria-valuenow")).toBe("40");
  });

  it("forgets a detached row even without a list target", async () => {
    await mount();
    const events = capture("progress");
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    list().removeAttribute("data-stimeo--direct-upload-target");
    await vi.advanceTimersByTimeAsync(0);
    firstRow().remove();
    // A detached row is never live UI; with no list to rebuild into, the event
    // has nowhere to render and must not report progress for an invisible row.
    fire("direct-upload:progress", { id: 1, progress: 40 });
    expect(events).toEqual([]);
  });

  it("announces the accessible name it applied when the row has no name field", async () => {
    document.body.innerHTML = MARKUP.replace("ATTRS", "").replace(
      '<span data-field="name"></span>',
      "",
    );
    start();
    await vi.advanceTimersByTimeAsync(0);
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:end", { id: 1 });
    expect(announcements).toEqual(["a.png uploaded"]);
  });

  it("announces with the row's stored name when the event carries none", async () => {
    await mount();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:end", { id: 1 });
    expect(announcements).toEqual(["a.png uploaded"]);
  });

  it("labels a row lazily created by progress or error", async () => {
    await mount();
    fire("direct-upload:progress", { id: 1, file: { name: "c.png" }, progress: 30 });
    fire("direct-upload:error", { id: 2, file: { name: "d.png" }, error: "boom" });

    const [progressRow, errorRow] = rows();
    expect(progressRow?.getAttribute("aria-label")).toBe("c.png");
    expect(progressRow?.querySelector("[data-field='name']")?.textContent).toBe("c.png");
    expect(errorRow?.getAttribute("aria-label")).toBe("d.png");
    expect(announcements).toEqual(["d.png failed"]);
  });

  it("backfills the name when a later event carries it", async () => {
    await mount();
    fire("direct-upload:initialize", { id: 1 });
    expect(firstRow().getAttribute("aria-label")).toBeNull();
    fire("direct-upload:progress", { id: 1, file: { name: "late.png" }, progress: 10 });
    expect(firstRow().getAttribute("aria-label")).toBe("late.png");
    expect(firstRow().querySelector("[data-field='name']")?.textContent).toBe("late.png");
  });

  it("updates progress and emits progress", async () => {
    await mount();
    const events = capture("progress");
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:progress", { id: 1, progress: 42 });

    const row = firstRow();
    expect(row.getAttribute("aria-valuenow")).toBe("42");
    expect(row.getAttribute("aria-valuetext")).toBe("42%");
    expect(row.querySelector("[data-field='percent']")?.textContent).toBe("42%");
    expect(row.style.getPropertyValue("--stimeo--upload-progress")).toBe("42%");
    expect(events.at(-1)).toEqual({ id: "1", percent: 42 });
  });

  it("rounds and clamps progress to 0–100", async () => {
    await mount();
    const events = capture("progress");
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });

    // Real XHR progress is fractional (loaded / total * 100).
    fire("direct-upload:progress", { id: 1, progress: 33.4 });
    expect(firstRow().getAttribute("aria-valuenow")).toBe("33");
    expect(firstRow().getAttribute("aria-valuetext")).toBe("33%");

    fire("direct-upload:progress", { id: 1, progress: 150 });
    expect(firstRow().getAttribute("aria-valuenow")).toBe("100");

    fire("direct-upload:progress", { id: 1, progress: -5 });
    expect(firstRow().getAttribute("aria-valuenow")).toBe("0");
    expect(events).toEqual([
      { id: "1", percent: 33 },
      { id: "1", percent: 100 },
      { id: "1", percent: 0 },
    ]);
  });

  it("reflects the aggregate on the element attribute and custom property", async () => {
    await mount();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:initialize", { id: 2, file: { name: "b.png" } });
    fire("direct-upload:progress", { id: 1, progress: 50 });
    fire("direct-upload:progress", { id: 2, progress: 100 });

    expect(element().getAttribute("data-upload-progress")).toBe("75");
    expect(element().style.getPropertyValue("--stimeo--upload-progress")).toBe("75%");
  });

  it("recomputes the aggregate when a row is added", async () => {
    await mount();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:progress", { id: 1, progress: 100 });
    expect(element().getAttribute("data-upload-progress")).toBe("100");

    fire("direct-upload:initialize", { id: 2, file: { name: "b.png" } });
    expect(element().getAttribute("data-upload-progress")).toBe("50");
  });

  it("marks done at 100, announces, and emits done", async () => {
    await mount();
    const done = capture("done");
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:progress", { id: 1, progress: 80 });
    fire("direct-upload:end", { id: 1, file: { name: "a.png" } });

    const row = firstRow();
    expect(row.getAttribute("data-upload-state")).toBe("done");
    // The upload finished, so the row reports 100 even if the last progress
    // event stopped short.
    expect(row.getAttribute("aria-valuenow")).toBe("100");
    expect(row.getAttribute("aria-valuetext")).toBe("100%");
    expect(element().getAttribute("data-upload-progress")).toBe("100");
    expect(done).toEqual([{ id: "1" }]);
    expect(announcements).toEqual(["a.png uploaded"]);
  });

  it("delivers the announcement through the shared announcer region", async () => {
    await mount();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:end", { id: 1, file: { name: "a.png" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(query("#du-announcer").textContent).toBe("a.png uploaded");
  });

  // Speech-order regression: completion is read from the polite region.
  it("announces upload completion as speech", async () => {
    await mount();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:end", { id: 1, file: { name: "a.png" } });
    await vi.advanceTimersByTimeAsync(0);
    // The virtual SR awaits real microtasks, so capture on the real clock.
    vi.useRealTimers();
    const speech = await captureSpeech({ container: query("#du-announcer"), steps: 0 });
    expect(speech).toEqual(["a.png uploaded"]);
  });

  it("records completion even when end arrives with no prior initialize/progress", async () => {
    await mount();
    fire("direct-upload:end", { id: 7, file: { name: "late.png" } });

    expect(firstRow().getAttribute("data-upload-state")).toBe("done");
    expect(firstRow().getAttribute("aria-label")).toBe("late.png");
    expect(announcements).toEqual(["late.png uploaded"]);
  });

  it("marks error, announces, emits error, and suppresses the native alert", async () => {
    await mount();
    const errors = capture("error");
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:progress", { id: 1, progress: 60 });
    const event = fire("direct-upload:error", { id: 1, file: { name: "a.png" }, error: "boom" });

    const row = firstRow();
    expect(row.getAttribute("data-upload-state")).toBe("error");
    // A failed row keeps its last measured progress.
    expect(row.getAttribute("aria-valuenow")).toBe("60");
    expect(errors).toEqual([{ id: "1", error: "boom" }]);
    expect(announcements).toEqual(["a.png failed"]);
    // ActiveStorage alert()s unless the event default is cancelled; a rendered
    // failure is handled here.
    expect(event.defaultPrevented).toBe(true);
  });

  // ActiveStorage fires `end` after `error` in the same callback; the failure
  // must survive it.
  it("keeps the error state when end arrives after error", async () => {
    await mount();
    const done = capture("done");
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:error", { id: 1, file: { name: "a.png" }, error: "boom" });
    fire("direct-upload:end", { id: 1, file: { name: "a.png" } });

    expect(firstRow().getAttribute("data-upload-state")).toBe("error");
    expect(done).toEqual([]);
    expect(announcements).toEqual(["a.png failed"]);
  });

  it("does not repeat a settled failure", async () => {
    await mount();
    const errors = capture("error");
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:error", { id: 1, file: { name: "a.png" }, error: "boom" });
    const second = fire("direct-upload:error", { id: 1, file: { name: "a.png" }, error: "again" });

    expect(errors).toEqual([{ id: "1", error: "boom" }]);
    expect(announcements).toEqual(["a.png failed"]);
    // The row still displays the failure, so the alert stays suppressed.
    expect(second.defaultPrevented).toBe(true);
  });

  it("leaves the alert alone when no row can be rendered", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--direct-upload">
        <div data-stimeo--direct-upload-target="list"></div>
      </div>`;
    start();
    await vi.advanceTimersByTimeAsync(0);
    const event = fire("direct-upload:error", { id: 1, file: { name: "a.png" }, error: "boom" });
    expect(rows()).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores progress for a settled row", async () => {
    await mount();
    const events = capture("progress");
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:end", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:progress", { id: 1, progress: 10 });

    expect(firstRow().getAttribute("aria-valuenow")).toBe("100");
    expect(events).toEqual([]);
  });

  it("stays silent when the announcement templates are empty", async () => {
    document.body.innerHTML = MARKUP.replace("ATTRS", "")
      .replace('data-stimeo--direct-upload-announce-done-text-value="{name} uploaded"', "")
      .replace('data-stimeo--direct-upload-announce-error-text-value="{name} failed"', "");
    start();
    await vi.advanceTimersByTimeAsync(0);
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:error", { id: 1, file: { name: "a.png" }, error: "boom" });
    fire("direct-upload:end", { id: 2, file: { name: "b.png" } });
    expect(announcements).toEqual([]);
  });

  it("removes a completed row after the delay and withdraws the aggregate", async () => {
    await mount('data-stimeo--direct-upload-remove-on-done-value="true"');
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:end", { id: 1, file: { name: "a.png" } });
    expect(rows()).toHaveLength(1);
    expect(element().getAttribute("data-upload-progress")).toBe("100");

    vi.advanceTimersByTime(REMOVE_DELAY);
    expect(rows()).toHaveLength(0);
    expect(element().hasAttribute("data-upload-progress")).toBe(false);
    expect(element().style.getPropertyValue("--stimeo--upload-progress")).toBe("");
  });

  it("keeps a failed row when removeOnDone is set", async () => {
    await mount('data-stimeo--direct-upload-remove-on-done-value="true"');
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:error", { id: 1, file: { name: "a.png" }, error: "boom" });
    fire("direct-upload:end", { id: 1, file: { name: "a.png" } });
    vi.advanceTimersByTime(REMOVE_DELAY);
    expect(rows()).toHaveLength(1);
    expect(firstRow().getAttribute("data-upload-state")).toBe("error");
  });

  it("tolerates a removal timer whose row already left the DOM", async () => {
    await mount('data-stimeo--direct-upload-remove-on-done-value="true"');
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:initialize", { id: 2, file: { name: "b.png" } });
    fire("direct-upload:end", { id: 1, file: { name: "a.png" } });
    firstRow().remove();
    // The next aggregate pass forgets the removed row before its timer fires.
    fire("direct-upload:progress", { id: 2, progress: 50 });
    expect(() => vi.advanceTimersByTime(REMOVE_DELAY)).not.toThrow();
    expect(rows()).toHaveLength(1);
  });

  it("stops handling events after disconnect", async () => {
    await mount();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    expect(list().children).toHaveLength(1);

    // The element stays in the DOM; only the controller is torn down, so a
    // leaked document listener would still append visibly.
    application.unload("stimeo--direct-upload");
    await vi.advanceTimersByTimeAsync(0);
    fire("direct-upload:initialize", { id: 2, file: { name: "b.png" } });
    expect(list().children).toHaveLength(1);
  });

  it("cancels a pending removal on disconnect", async () => {
    await mount('data-stimeo--direct-upload-remove-on-done-value="true"');
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:end", { id: 1, file: { name: "a.png" } });
    application.unload("stimeo--direct-upload");
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(REMOVE_DELAY);
    expect(rows()).toHaveLength(1);
  });

  it("rewinds rows, timers, and the aggregate before Turbo caches the page", async () => {
    await mount('data-stimeo--direct-upload-remove-on-done-value="true"');
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:end", { id: 1, file: { name: "a.png" } });
    expect(rows()).toHaveLength(1);

    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(rows()).toHaveLength(0);
    expect(element().hasAttribute("data-upload-progress")).toBe(false);
    expect(element().style.getPropertyValue("--stimeo--upload-progress")).toBe("");
    expect(() => vi.advanceTimersByTime(REMOVE_DELAY)).not.toThrow();

    // A restored page starts a fresh cycle: the same id builds one new row.
    fire("direct-upload:progress", { id: 1, file: { name: "a.png" }, progress: 10 });
    expect(rows()).toHaveLength(1);
    expect(firstRow().getAttribute("data-upload-state")).toBe("uploading");
  });

  it("rebuilds a row removed outside the controller", async () => {
    await mount();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:initialize", { id: 2, file: { name: "b.png" } });
    fire("direct-upload:progress", { id: 1, progress: 100 });
    firstRow().remove();

    // The aggregate only counts live rows.
    fire("direct-upload:progress", { id: 2, progress: 50 });
    expect(element().getAttribute("data-upload-progress")).toBe("50");

    // The forgotten id lazily rebuilds into the current list.
    fire("direct-upload:progress", { id: 1, file: { name: "a.png" }, progress: 10 });
    expect(rows()).toHaveLength(2);
    expect(rows().every((row) => row.isConnected)).toBe(true);
  });

  it("rebuilds rows into a replaced list target", async () => {
    await mount();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    const replacement = document.createElement("div");
    replacement.setAttribute("data-stimeo--direct-upload-target", "list");
    list().replaceWith(replacement);
    await vi.advanceTimersByTimeAsync(0);

    fire("direct-upload:progress", { id: 1, file: { name: "a.png" }, progress: 40 });
    expect(replacement.children).toHaveLength(1);
    expect(firstRow().getAttribute("aria-valuenow")).toBe("40");
  });

  it("only handles in-scope events when scope is set", async () => {
    document.body.innerHTML = `
      <form id="form-a"><input type="file" id="in-a"></form>
      <form id="form-b"><input type="file" id="in-b"></form>
      ${MARKUP.replace("ATTRS", 'data-stimeo--direct-upload-scope-value="#form-a"')}`;
    start();
    await vi.advanceTimersByTimeAsync(0);

    const from = (input: string, type: string, detail: Record<string, unknown>) => {
      query(input).dispatchEvent(
        new CustomEvent(type, { detail, bubbles: true, cancelable: true }),
      );
    };

    // Every event path honors the scope: none of these may lazily create a row.
    from("#in-b", "direct-upload:initialize", { id: "b", file: { name: "b.png" } });
    from("#in-b", "direct-upload:progress", { id: "b2", progress: 10 });
    from("#in-b", "direct-upload:error", { id: "b3", error: "boom" });
    from("#in-b", "direct-upload:end", { id: "b4", file: { name: "b.png" } });
    expect(rows()).toHaveLength(0);

    from("#in-a", "direct-upload:initialize", { id: "a", file: { name: "a.png" } });
    expect(rows()).toHaveLength(1);
  });

  it("falls back to the default scope when the selector is invalid", async () => {
    await mount('data-stimeo--direct-upload-scope-value="#form-a["');
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    expect(rows()).toHaveLength(1);
  });

  it("renders in both widgets when two instances share the page without scope", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--direct-upload">
        <div data-stimeo--direct-upload-target="list"></div>
        <template data-stimeo--direct-upload-target="row">
          <div role="progressbar" aria-valuemin="0" aria-valuemax="100"></div>
        </template>
      </div>
      <div data-controller="stimeo--direct-upload">
        <div data-stimeo--direct-upload-target="list"></div>
        <template data-stimeo--direct-upload-target="row">
          <div role="progressbar" aria-valuemin="0" aria-valuemax="100"></div>
        </template>
      </div>`;
    start();
    await vi.advanceTimersByTimeAsync(0);
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    // Without scope every widget handles every upload; scope exists to split them.
    expect(rows()).toHaveLength(2);
  });

  it("creates nothing without a row template or from an empty one", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--direct-upload">
        <div data-stimeo--direct-upload-target="list"></div>
      </div>`;
    start();
    await vi.advanceTimersByTimeAsync(0);
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:progress", { id: 1, progress: 10 });
    fire("direct-upload:end", { id: 1, file: { name: "a.png" } });
    expect(rows()).toHaveLength(0);

    document.body.innerHTML = `
      <div data-controller="stimeo--direct-upload">
        <div data-stimeo--direct-upload-target="list"></div>
        <template data-stimeo--direct-upload-target="row"></template>
      </div>`;
    await vi.advanceTimersByTimeAsync(0);
    fire("direct-upload:initialize", { id: 2, file: { name: "b.png" } });
    expect(rows()).toHaveLength(0);
  });

  it("has no a11y violations", async () => {
    vi.useRealTimers();
    document.body.innerHTML = MARKUP.replace("ATTRS", "");
    start();
    await tick();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:progress", { id: 1, progress: 60 });
    fire("direct-upload:error", { id: 2, file: { name: "b.png" }, error: "boom" });
    fire("direct-upload:end", { id: 2, file: { name: "b.png" } });
    await expectNoA11yViolations(query("#harness"));
  });
});
