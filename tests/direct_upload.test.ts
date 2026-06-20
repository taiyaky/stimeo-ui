import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectUploadController } from "../src/controllers/direct_upload_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link DirectUploadController}: row creation from the
 * template, progress / done / error syncing, aggregate progress, status
 * announcements, removeOnDone, and listener teardown. The `direct-upload:*` events
 * are fired on document, where ActiveStorage's bubble to.
 */

const REMOVE_DELAY = 4000;

describe("DirectUploadController", () => {
  let application: Application;

  const MARKUP = `
    <div data-controller="stimeo--direct-upload"
         data-stimeo--direct-upload-done-label-value="%{name} uploaded"
         data-stimeo--direct-upload-error-label-value="%{name} failed"
         ATTRS>
      <div data-stimeo--direct-upload-target="list"></div>
      <template data-stimeo--direct-upload-target="row">
        <div role="progressbar" aria-valuemin="0" aria-valuemax="100">
          <span data-field="name"></span><span data-field="percent"></span>
        </div>
      </template>
      <span data-stimeo--direct-upload-target="status" aria-live="polite"></span>
    </div>`;

  const mount = async (attrs = "") => {
    document.body.innerHTML = MARKUP.replace("ATTRS", attrs);
    application = Application.start();
    application.register("stimeo--direct-upload", DirectUploadController);
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    application.stop();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const fire = (type: string, detail: Record<string, unknown>) => {
    document.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  };
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>("[role='progressbar']"));
  const firstRow = () => {
    const [row] = rows();
    if (!row) throw new Error("no progress row");
    return row;
  };
  const status = () => query("[data-stimeo--direct-upload-target='status']");

  it("creates a row from the template on initialize", async () => {
    await mount();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });

    const row = firstRow();
    expect(row.querySelector("[data-field='name']")?.textContent).toBe("a.png");
    expect(row.getAttribute("aria-label")).toBe("a.png");
    expect(row.getAttribute("aria-valuenow")).toBe("0");
    expect(row.getAttribute("data-upload-state")).toBe("uploading");
    expect(row.style.getPropertyValue("--stimeo-upload-progress")).toBe("0%");
  });

  it("updates progress and emits progress", async () => {
    await mount();
    const events: Array<{ id: string; percent: number }> = [];
    query("[data-controller]").addEventListener("stimeo--direct-upload:progress", (e) => {
      events.push((e as CustomEvent).detail);
    });
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:progress", { id: 1, progress: 42 });

    const row = firstRow();
    expect(row.getAttribute("aria-valuenow")).toBe("42");
    expect(row.querySelector("[data-field='percent']")?.textContent).toBe("42%");
    expect(row.style.getPropertyValue("--stimeo-upload-progress")).toBe("42%");
    expect(events.at(-1)).toEqual({ id: "1", percent: 42 });
  });

  it("marks done and announces with the doneLabel", async () => {
    await mount();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:end", { id: 1 });

    expect(firstRow().getAttribute("data-upload-state")).toBe("done");
    expect(status().textContent).toBe("a.png uploaded");
  });

  it("records completion even when end arrives with no prior initialize/progress", async () => {
    // A theoretical gap: if `initialize`/`progress` never fired, the row does not
    // exist yet. `end` must lazily create it (like error/progress) rather than
    // silently dropping the completion.
    await mount();
    fire("direct-upload:end", { id: 7, file: { name: "late.png" } });

    expect(firstRow().getAttribute("data-upload-state")).toBe("done");
    expect(status().textContent).toBe("late.png uploaded");
  });

  it("marks error and announces with the errorLabel", async () => {
    await mount();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:error", { id: 1, error: "boom" });

    expect(firstRow().getAttribute("data-upload-state")).toBe("error");
    expect(status().textContent).toBe("a.png failed");
  });

  it("reflects the aggregate progress on the element", async () => {
    await mount();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:initialize", { id: 2, file: { name: "b.png" } });
    fire("direct-upload:progress", { id: 1, progress: 50 });
    fire("direct-upload:progress", { id: 2, progress: 100 });

    expect(query("[data-controller]").getAttribute("data-upload-progress")).toBe("75");
  });

  it("does not announce when announce is false", async () => {
    await mount('data-stimeo--direct-upload-announce-value="false"');
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:end", { id: 1 });
    expect(status().textContent).toBe("");
  });

  it("lazily creates a row for progress without an initialize", async () => {
    await mount();
    fire("direct-upload:progress", { id: 9, progress: 30 });
    expect(rows()).toHaveLength(1);
    expect(firstRow().getAttribute("aria-valuenow")).toBe("30");
  });

  it("removes a completed row after the delay when removeOnDone is set", async () => {
    await mount('data-stimeo--direct-upload-remove-on-done-value="true"');
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:end", { id: 1 });
    expect(rows()).toHaveLength(1);
    vi.advanceTimersByTime(REMOVE_DELAY);
    expect(rows()).toHaveLength(0);
  });

  it("stops handling events after disconnect", async () => {
    await mount();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    query("[data-controller]").remove();
    await vi.advanceTimersByTimeAsync(0);
    fire("direct-upload:initialize", { id: 2, file: { name: "b.png" } });
    expect(rows()).toHaveLength(0); // detached; no new row anywhere
  });

  it("only handles in-scope events when scope is set", async () => {
    document.body.innerHTML = `
      <form id="form-a"><input type="file" id="in-a"></form>
      <form id="form-b"><input type="file" id="in-b"></form>
      ${MARKUP.replace("ATTRS", 'data-stimeo--direct-upload-scope-value="#form-a"')}`;
    application = Application.start();
    application.register("stimeo--direct-upload", DirectUploadController);
    await vi.advanceTimersByTimeAsync(0);

    const init = (id: string) =>
      new CustomEvent("direct-upload:initialize", {
        detail: { id, file: { name: `${id}.png` } },
        bubbles: true,
      });

    query("#in-b").dispatchEvent(init("b")); // outside #form-a → ignored
    expect(rows()).toHaveLength(0);

    query("#in-a").dispatchEvent(init("a")); // inside #form-a → handled
    expect(rows()).toHaveLength(1);
  });

  it("has no a11y violations", async () => {
    vi.useRealTimers();
    await mountReal();
    fire("direct-upload:initialize", { id: 1, file: { name: "a.png" } });
    fire("direct-upload:progress", { id: 1, progress: 60 });
    await expectNoA11yViolations(query("[data-controller]"));
  });

  const mountReal = async () => {
    document.body.innerHTML = MARKUP.replace("ATTRS", "");
    application = Application.start();
    application.register("stimeo--direct-upload", DirectUploadController);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
});
