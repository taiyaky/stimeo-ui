import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { MultiSelectController } from "../src/controllers/multi_select_controller";
import { TagsInputController } from "../src/controllers/tags_input_controller";
import { query } from "./helpers/dom";
import { press } from "./helpers/keyboard";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

const cases = [
  { kind: "tags-input", controller: TagsInputController },
  { kind: "multi-select", controller: MultiSelectController },
] as const;

/** Declares one chip using the same slots as chips the component creates. */
const chip = (
  kind: string,
  value: string,
): string => `<li role="listitem" data-value="${value}" data-stimeo--${kind}-target="tag">
  <span data-stimeo--${kind}-target="label">${value}</span>
  <button type="button" tabindex="0" aria-label="Remove ${value}" data-stimeo--${kind}-target="remove">Remove</button>
</li>`;

/** A selected primary chip beside a row the component must leave out of its model. */
const markup = (
  kind: string,
  empty: boolean,
  authored: string | null,
): string => `<div id="widget" data-controller="stimeo--${kind}" data-stimeo--${kind}-max-value="2">
  <ul id="primary" aria-label="Selected" data-stimeo--${kind}-target="tags">${chip(kind, "apple")}</ul>
  <ul id="secondary" aria-label="Selected" data-stimeo--${kind}-target="tags"${authored === null ? "" : ` inert="${authored}"`}>${empty ? "" : chip(kind, "banana")}</ul>
  <input id="input" type="text" aria-label="Add fruit" ${kind === "multi-select" ? 'role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="options"' : ""}
    data-stimeo--${kind}-target="input" data-action="keydown->stimeo--${kind}#onKeydown">
  ${
    kind === "multi-select"
      ? `<ul id="options" role="listbox" aria-multiselectable="true" hidden data-stimeo--${kind}-target="list">
    ${["apple", "banana", "cherry"].map((value) => `<li id="option-${value}" role="option" aria-selected="${value === "apple"}" data-value="${value}" data-stimeo--${kind}-target="option" data-action="click->stimeo--${kind}#toggleOption">${value}</li>`).join("")}
  </ul>`
      : ""
  }
  <div id="fields" data-stimeo--${kind}-target="fields"></div>
  <template data-stimeo--${kind}-target="tagTemplate">
    <li role="listitem" data-stimeo--${kind}-target="tag"><span data-stimeo--${kind}-target="label"></span><button type="button" tabindex="-1" aria-label="Remove {label}" data-stimeo--${kind}-target="remove">Remove</button></li>
  </template>
</div>`;

/** Verifies singular chip-row ownership through real Stimulus target delivery. */
describe.each(cases)("$kind duplicate chip rows", ({ kind, controller }) => {
  let application: Application | undefined;
  const identifier = `stimeo--${kind}`;
  const marker = `data-${identifier}-inert-lease`;
  const values = () =>
    Array.from(
      document.querySelectorAll<HTMLInputElement>("#fields input"),
      (input) => input.value,
    );
  const mount = async (
    empty = false,
    authored: string | null = null,
    attributes: Readonly<Record<string, string>> = {},
  ): Promise<string> => {
    document.body.innerHTML = markup(kind, empty, authored);
    for (const [name, value] of Object.entries(attributes))
      query("#secondary").setAttribute(name, value);
    const original = query("#secondary").innerHTML;
    application = Application.start();
    application.register(identifier, controller);
    await tick();
    return original;
  };

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    document.body.innerHTML = "";
  });

  it("reads and appends only the first row without changing the later chips", async () => {
    const original = await mount();
    expect(values()).toEqual(["apple"]);
    expect(query("#secondary").innerHTML).toBe(original);
    if (kind === "tags-input") {
      query<HTMLInputElement>("#input").value = "cherry";
      press(query("#input"), "Enter");
    } else query<HTMLElement>("#option-cherry").click();
    await tick();
    expect(values()).toEqual(["apple", "cherry"]);
    expect(query("#primary").children).toHaveLength(2);
    expect(query("#secondary").innerHTML).toBe(original);
  });

  it("uses only the first row for empty-input Backspace", async () => {
    const original = await mount();
    press(query("#input"), "Backspace");
    await tick();
    expect(values()).toEqual([]);
    expect(query("#primary").children).toHaveLength(0);
    expect(query("#secondary").innerHTML).toBe(original);
    expect(document.activeElement).toBe(query("#input"));
  });

  it("delegates removal only to the first row", async () => {
    const original = await mount();
    query<HTMLButtonElement>("#primary button").click();
    await tick();
    expect(values()).toEqual([]);
    query<HTMLButtonElement>("#secondary button").click();
    await tick();
    expect(values()).toEqual([]);
    expect(query("#secondary").innerHTML).toBe(original);
  });

  it("leaves the later row's authored hidden and ARIA attributes intact", async () => {
    await mount(false, null, {
      hidden: "until-found",
      "aria-hidden": "false",
      "aria-label": "Later choices",
    });
    const successor = query("#secondary");
    expect(successor.getAttribute("inert")).toBe("");
    expect(successor.getAttribute("hidden")).toBe("until-found");
    expect(successor.getAttribute("aria-hidden")).toBe("false");
    expect(successor.getAttribute("aria-label")).toBe("Later choices");
  });

  it("makes an empty later row inert", async () => {
    await mount(true);
    expect(query("#primary").hasAttribute("inert")).toBe(false);
    expect(query("#secondary").getAttribute("inert")).toBe("");
    expect(query("#secondary").children).toHaveLength(0);
  });

  it.each([null, "authored"])(
    "returns the promoted row's authored inert value %s",
    async (authored) => {
      await mount(false, authored);
      const successor = query("#secondary");
      expect(successor.getAttribute("inert")).toBe("");
      query("#primary").remove();
      await tick();
      expect(successor.getAttribute("inert")).toBe(authored);
      expect(successor.hasAttribute(marker)).toBe(false);
      if (authored === null) {
        query<HTMLButtonElement>("#secondary button").click();
        await tick();
        expect(values()).toEqual([]);
      }
    },
  );

  it.each(["token", "identifier"])(
    "returns a later row's inert on %s departure",
    async (departure) => {
      await mount(false, "authored");
      const successor = query("#secondary");
      expect(successor.getAttribute("inert")).toBe("");
      if (departure === "token") successor.removeAttribute(`data-${identifier}-target`);
      else query("#widget").removeAttribute("data-controller");
      await tick();
      expect(successor.getAttribute("inert")).toBe("authored");
      expect(successor.hasAttribute(marker)).toBe(false);
    },
  );

  it("keeps a page-written inert value when the identifier leaves", async () => {
    await mount();
    const successor = query("#secondary");
    successor.setAttribute("inert", "page");
    query("#widget").removeAttribute("data-controller");
    await tick();
    expect(successor.getAttribute("inert")).toBe("page");
    expect(successor.hasAttribute(marker)).toBe(false);
  });

  it("returns authored inert on a page restored from the cache", async () => {
    await mount(false, "authored");
    if (!application) throw new Error("Expected a mounted application");
    application = await restoreFromCache(application, (restored) =>
      restored.register(identifier, controller),
    );
    const successor = query("#secondary");
    query("#widget").removeAttribute("data-controller");
    await tick();
    expect(successor.getAttribute("inert")).toBe("authored");
    expect(successor.hasAttribute(marker)).toBe(false);
  });

  it("preserves inert when the whole widget leaves the page", async () => {
    await mount(false, "authored");
    const widget = query("#widget");
    const successor = query("#secondary");
    const before = successor.outerHTML;
    widget.remove();
    await tick();
    expect(successor.outerHTML).toBe(before);
    document.body.append(widget);
    await tick();
    expect(successor.getAttribute("inert")).toBe("");
  });

  it("keeps the same inert hold when a later row moves within its scope", async () => {
    await mount(false, "authored");
    const successor = query("#secondary");
    expect(successor.getAttribute("inert")).toBe("");
    const before = successor.outerHTML;
    const writes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => writes.push(...records));
    observer.observe(successor, { attributes: true });
    try {
      query("#widget").append(successor);
      await tick();
      writes.push(...observer.takeRecords());
    } finally {
      observer.disconnect();
    }
    expect(successor.outerHTML).toBe(before);
    expect(writes).toEqual([]);
  });

  it("disconnects the old row when a morph repair precedes its target departure", async () => {
    await mount(true);
    const primary = query("#primary");
    const remove = query<HTMLButtonElement>("#primary button");
    const observed: string[][] = [];
    query("#widget").dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    // Probe the queued repair before Stimulus delivers the following target mutation.
    queueMicrotask(() => {
      remove.click();
      observed.push(values());
    });
    for (const row of document.querySelectorAll(`[data-${identifier}-target=tags]`)) {
      row.removeAttribute(`data-${identifier}-target`);
    }
    await flushMicrotasks();
    expect(observed).toEqual([["apple"]]);
    expect(values()).toEqual(["apple"]);
    primary.setAttribute(`data-${identifier}-target`, "tags");
    await tick();
    remove.click();
    await tick();
    expect(values()).toEqual([]);
  });

  it("rescues focus before a current row becomes a later inert row", async () => {
    await mount();
    const first = query("#primary");
    query<HTMLButtonElement>("#primary button").focus();
    const replacement = first.cloneNode(true) as HTMLElement;
    replacement.id = "replacement";
    first.before(replacement);
    await tick();
    expect(first.getAttribute("inert")).toBe("");
    expect(document.activeElement).toBe(query("#input"));
    expect(query("#replacement").hasAttribute("inert")).toBe(false);
  });
});
