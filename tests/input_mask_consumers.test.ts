import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputMaskController } from "../src/controllers/input_mask_controller";
import { PersistController } from "../src/controllers/persist_controller";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";

/** Persist keeps authored field keys and exclusions while raw names are managed. */
describe("input-mask storage consumers", () => {
  let app: Application | null = null;
  const storageKey = "stimeo--persist:mask-consumer";
  async function mount(managed: boolean, excluded: boolean, value = "1234567"): Promise<void> {
    if (app) disconnectAndStopApplication(app);
    vi.useFakeTimers();
    document.body.innerHTML = `<form data-controller="stimeo--persist" data-stimeo--persist-key-value="mask-consumer" data-stimeo--persist-debounce-value="0" data-stimeo--persist-exclude-value='${excluded ? '["secretRaw"]' : "[]"}'><input id="trigger" name="title" value="safe" data-stimeo--persist-target="field"><input id="source" value="${value}" data-controller="${managed ? "stimeo--input-mask" : ""}" data-stimeo--input-mask-pattern-value="999-9999" data-action="input->stimeo--input-mask#format"><input id="sink" name="secretRaw" value="${value}" type="hidden" data-stimeo--persist-target="field" data-stimeo--input-mask-unmask="source"></form>`;
    app = new Application(document.body);
    app.register("stimeo--input-mask", InputMaskController);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    app.register("stimeo--persist", PersistController);
    await vi.advanceTimersByTimeAsync(0);
  }
  function save(): Array<{ key: string; value: string }> {
    query("#trigger").dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(0);
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) throw new Error("Missing saved payload");
    return JSON.parse(stored).fields;
  }
  afterEach(() => {
    if (app) disconnectAndStopApplication(app);
    app = null;
    vi.useRealTimers();
    window.localStorage.clear();
    document.body.innerHTML = "";
  });
  it.each([false, true])("excludes an authored raw name (managed %s)", async (managed) => {
    await mount(managed, true);
    expect(save()).toEqual([{ key: "title", value: "safe" }]);
  });
  it("saves a stable public name for a managed raw field", async () => {
    await mount(true, false);
    expect(save()).toEqual([
      { key: "title", value: "safe" },
      { key: "secretRaw", value: "1234567" },
    ]);
  });
  it("restores the same public slot after a fresh transport identity is installed", async () => {
    await mount(true, false);
    save();
    const previous = query<HTMLInputElement>("#sink").name;
    await mount(true, false, "7654321");
    const sink = query<HTMLInputElement>("#sink");
    expect(sink.name).not.toBe(previous);
    expect(sink.value).toBe("1234567");
  });
});
