import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { MultiSelectController } from "../src/controllers/multi_select_controller";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/** A selection whose submitted values differ from the names a person reads. */
const markup = `<div id="widget" data-controller="stimeo--multi-select"
  data-stimeo--multi-select-announce-text-value="{label} selected; {count} total"
  data-stimeo--multi-select-announce-removed-text-value="{label} removed; {count} total">
  <ul id="tags" aria-label="Selected" data-stimeo--multi-select-target="tags"></ul>
  <input type="text" role="combobox" aria-label="Fruits" aria-expanded="false"
    aria-autocomplete="list" aria-controls="options" data-stimeo--multi-select-target="input">
  <ul id="options" role="listbox" aria-multiselectable="true" aria-label="Fruits" hidden
    data-stimeo--multi-select-target="list">
    <li id="apple" role="option" aria-selected="true" data-value="apl"
      data-stimeo--multi-select-target="option" data-action="click->stimeo--multi-select#toggleOption">Apple</li>
    <li id="banana" role="option" aria-selected="true" data-value="ban"
      data-stimeo--multi-select-target="option" data-action="click->stimeo--multi-select#toggleOption">Banana</li>
  </ul>
  <div id="fields" data-stimeo--multi-select-target="fields"></div>
  <template data-stimeo--multi-select-target="tagTemplate">
    <li data-stimeo--multi-select-target="tag"><span data-stimeo--multi-select-target="label"></span><button type="button"
      tabindex="-1" aria-label="Remove {label}" data-stimeo--multi-select-target="remove">×</button></li>
  </template>
</div>`;

/** Changes one option without carrying its previous Stimulus action binding. */
function deselectApple(): void {
  const option = query("#apple");
  const replacement = option.cloneNode(true) as HTMLElement;
  replacement.setAttribute("aria-selected", "false");
  option.replaceWith(replacement);
}

/** Replaces the visible row without the chip the new selection omits. */
function replaceRow(keepOtherChips: boolean): void {
  const row = query("#tags");
  const next = row.cloneNode(keepOtherChips) as HTMLElement;
  for (const chip of next.querySelectorAll("[data-value=apl]")) chip.remove();
  row.replaceWith(next);
}

/** Verifies removal names at the same publication boundaries as the selection. */
describe("MultiSelectController reconciled removal labels", () => {
  let application: Application | undefined;
  const heard: string[] = [];
  const changes: string[][] = [];
  const repairs: string[][] = [];
  const onAnnounce = (event: Event) =>
    heard.push((event as CustomEvent<{ message: string }>).detail.message);
  const mount = async (transform: (source: string) => string = (source) => source) => {
    document.body.innerHTML = transform(markup);
    application = Application.start();
    application.register("stimeo--multi-select", MultiSelectController);
    await tick();
    window.addEventListener("stimeo--announcer:announce", onAnnounce);
    query("#widget").addEventListener("stimeo--multi-select:change", (event) => {
      changes.push((event as CustomEvent<{ values: string[] }>).detail.values);
    });
    query("#widget").addEventListener("stimeo--multi-select:reconcile", (event) => {
      repairs.push((event as CustomEvent<{ values: string[] }>).detail.values);
    });
  };
  const removeAndReplace = () => {
    query("#apple").remove();
    replaceRow(true);
  };

  afterEach(() => {
    window.removeEventListener("stimeo--announcer:announce", onAnnounce);
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    document.body.innerHTML = "";
    heard.length = 0;
    changes.length = 0;
    repairs.length = 0;
  });

  it.each([
    [
      "option replaced deselected and chip removed",
      () => {
        deselectApple();
        replaceRow(true);
      },
    ],
    ["option removed and chip removed", removeAndReplace],
    [
      "option replaced deselected and row emptied",
      () => {
        deselectApple();
        replaceRow(false);
      },
    ],
  ] as const)("names the removed value when %s", async (_name, change) => {
    await mount();
    change();
    await tick();
    expect(heard).toEqual(["Apple removed; 1 total"]);
    expect(changes).toEqual([]);
    expect(repairs).toEqual([["ban"]]);
    expect(
      Array.from(
        document.querySelectorAll<HTMLInputElement>("#fields input"),
        (field) => field.value,
      ),
    ).toEqual(["ban"]);
  });

  it("takes its remembered label only from the first row when later chips share its value", async () => {
    await mount((source) =>
      source.replace(
        "</ul>",
        `</ul><ul aria-label="Selected" data-stimeo--multi-select-target="tags"><li data-value="apl" data-stimeo--multi-select-target="tag"><span data-stimeo--multi-select-target="label">Later Apple</span><button type="button" aria-label="Remove Later Apple" data-stimeo--multi-select-target="remove">×</button></li></ul>`,
      ),
    );
    removeAndReplace();
    await tick();
    expect(heard).toEqual(["Apple removed; 1 total"]);
  });

  it("keeps the existing removal name while its chip remains in the row", async () => {
    await mount();
    deselectApple();
    await tick();
    expect(heard).toEqual(["Apple removed; 1 total"]);
  });

  it("reads a page-written label from the departing chip while its value still matches", async () => {
    await mount();
    query("#tags [data-value=apl] [data-stimeo--multi-select-target=label]").textContent =
      "Green Apple";
    removeAndReplace();
    await tick();
    expect(heard).toEqual(["Green Apple removed; 1 total"]);
  });

  it("uses the published label when a retained chip is morphed into another value", async () => {
    await mount();
    const chip = query("#tags [data-value=apl]");
    chip.dataset.value = "other";
    query("#tags [data-value=other] [data-stimeo--multi-select-target=label]").textContent =
      "Other fruit";
    query("#apple").remove();
    await tick();
    expect(heard).toEqual(["Apple removed; 1 total"]);
  });

  it("falls back to the submitted value when the departing chip has no label", async () => {
    await mount();
    query("#tags [data-value=apl] [data-stimeo--multi-select-target=label]").remove();
    removeAndReplace();
    await tick();
    expect(heard).toEqual(["apl removed; 1 total"]);
  });

  it("refreshes its chip record after a repair whose selection stays the same", async () => {
    await mount();
    query("#apple").textContent = "Green Apple";
    const row = query("#tags");
    row.replaceWith(row.cloneNode(true));
    await tick();
    expect(heard).toEqual([]);
    removeAndReplace();
    await tick();
    expect(heard).toEqual(["Green Apple removed; 1 total"]);
  });

  it("records the chip a user selection publishes before target delivery", async () => {
    await mount((source) =>
      source.replace(
        'id="apple" role="option" aria-selected="true"',
        'id="apple" role="option" aria-selected="false"',
      ),
    );
    query<HTMLLIElement>("#apple").click();
    heard.length = 0;
    removeAndReplace();
    await tick();
    expect(heard).toEqual(["Apple removed; 1 total"]);
  });

  it("refreshes its chip record when a user operation leaves the published selection unchanged", async () => {
    await mount();
    const apple = query("#apple");
    apple.setAttribute("aria-selected", "false");
    apple.textContent = "Green Apple";
    query("#tags [data-value=apl]").remove();
    apple.click();
    expect(heard).toEqual([]);
    removeAndReplace();
    await tick();
    expect(heard).toEqual(["Green Apple removed; 1 total"]);
  });

  it("seeds labels from the DOM on cache restore", async () => {
    await mount();
    query("#apple").textContent = "Green Apple";
    query("#widget").dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    await tick();
    if (!application) throw new Error("Expected a mounted application");
    application = await restoreFromCache(application, (restored) =>
      restored.register("stimeo--multi-select", MultiSelectController),
    );
    expect(heard).toEqual([]);
    removeAndReplace();
    await tick();
    expect(heard).toEqual(["Green Apple removed; 1 total"]);
  });

  it("keeps value fallback when no chip template is authored", async () => {
    await mount((source) => source.replace(/<template[\s\S]*?<\/template>/, ""));
    removeAndReplace();
    await tick();
    expect(heard).toEqual(["apl removed; 1 total"]);
  });
});
