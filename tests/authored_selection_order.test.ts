import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { DataGridController } from "../src/controllers/data_grid_controller";
import { ListboxController } from "../src/controllers/listbox_controller";
import { TreeViewController } from "../src/controllers/tree_view_controller";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

describe("authored selection during synchronous repair", () => {
  let application: Application | undefined;

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    document.body.innerHTML = "";
  });

  it.each([
    ["listbox", "user"],
    ["listbox", "repair"],
    ["tree-view", "user"],
    ["tree-view", "repair"],
    ["data-grid", "repair"],
  ] as const)("settles %s %s reactions before a subscriber microtask", async (kind, origin) => {
    let armed = false;
    let reacted = false;
    const tag = `selection-reaction-${kind}-${origin}`;
    customElements.define(
      tag,
      class extends HTMLElement {
        static observedAttributes = ["aria-selected"];

        attributeChangedCallback(
          _name: string,
          _before: string | null,
          after: string | null,
        ): void {
          if (!armed || after !== "false") return;
          armed = false;
          reacted = true;
          document.getElementById("a")?.setAttribute("aria-selected", "true");
        }
      },
    );
    const identifier = `stimeo--${kind}`;
    const grid = kind === "data-grid";
    const target = kind === "listbox" ? "option" : grid ? "row" : "item";
    const role = kind === "listbox" ? "option" : grid ? "row" : "treeitem";
    const candidate = (name: string, selected: boolean, element = "div") =>
      `<${element} id="${name}" role="${role}" aria-selected="${selected}"
        tabindex="${name === "a" ? "0" : "-1"}" data-value="${name}"
        data-${identifier}-target="${target}"
        data-action="click->${identifier}#${grid ? "toggleSelect" : "select"}">
        ${grid ? `<div role="gridcell" data-${identifier}-target="cell">${name}</div>` : name}</${element}>`;
    const children = candidate("a", false) + candidate("b", false) + candidate("c", true, tag);
    document.body.innerHTML = `<div data-controller="${identifier}" role="${kind === "listbox" ? "group" : grid ? "grid" : "tree"}"
      ${grid ? `data-${identifier}-selection-value="single"` : ""}>
      ${
        kind === "listbox"
          ? `<button type="button" data-${identifier}-target="trigger"></button>
        <div data-${identifier}-target="list">${children}</div>`
          : children
      }
      ${grid ? `<div data-${identifier}-target="fields"></div>` : `<input type="hidden" data-${identifier}-target="field">`}</div>`;
    application = Application.start();
    application.register(
      identifier,
      kind === "listbox" ? ListboxController : grid ? DataGridController : TreeViewController,
    );
    await tick();
    const root = document.body.firstElementChild as HTMLElement;
    const states = () =>
      ["a", "b", "c"].map((name) => document.getElementById(name)?.getAttribute("aria-selected"));
    const samples: (string | null | undefined)[][] = [];
    const event = origin === "repair" ? "reconcile" : kind === "listbox" ? "change" : "select";
    root.addEventListener(
      `${identifier}:${event}`,
      () => {
        queueMicrotask(() => samples.push(states()));
      },
      { once: true },
    );
    armed = true;
    const selected = document.getElementById("b") as HTMLElement;
    if (origin === "user") selected.click();
    else selected.setAttribute("aria-selected", "true");
    await tick();
    expect(reacted).toBe(true);
    expect(samples).toEqual([["true", "false", "false"]]);
    expect(root.querySelector<HTMLInputElement>("input")?.value).toBe("a");
  });
});
