import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TreeViewController } from "../src/controllers/tree_view_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link TreeViewController}: visible-item navigation,
 * expand/collapse and parent/child movement, Home/End, typeahead, single
 * selection, roving tabindex, and the `select`/`toggle` events.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const item = (label: string, attrs: string, children = "") => `
  <li role="treeitem" ${attrs}
      data-stimeo--tree-view-target="item"
      data-action="keydown->stimeo--tree-view#onKeydown click->stimeo--tree-view#onClick">
    <span>${label}</span>
    ${children}
  </li>`;

const markup = `
  <ul data-controller="stimeo--tree-view" role="tree" aria-label="Files">
    ${item(
      "src",
      'aria-expanded="false" aria-selected="false" tabindex="0"',
      `<ul role="group" data-stimeo--tree-view-target="group" hidden>
        ${item("index.ts", 'aria-selected="false" tabindex="-1"')}
        ${item("utils.ts", 'aria-selected="false" tabindex="-1"')}
      </ul>`,
    )}
    ${item("readme.md", 'aria-selected="false" tabindex="-1"')}
    ${item("package.json", 'aria-selected="false" tabindex="-1"')}
  </ul>`;

describe("TreeViewController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--tree-view", TreeViewController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--tree-view']") as HTMLElement;
  const items = () => Array.from(document.querySelectorAll<HTMLElement>("[role='treeitem']"));
  const byLabel = (label: string) =>
    items().find((it) => it.querySelector("span")?.textContent === label) as HTMLElement;
  const key = (el: HTMLElement, k: string) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  it("starts as a single tab stop on the first item", () => {
    expect(byLabel("src").tabIndex).toBe(0);
    expect(items().filter((it) => it.tabIndex === 0)).toHaveLength(1);
  });

  it("moves between visible items with ArrowDown/ArrowUp (skipping collapsed children)", () => {
    const src = byLabel("src");
    key(src, "ArrowDown"); // src -> readme (index.ts is hidden)
    expect(document.activeElement).toBe(byLabel("readme.md"));
    key(byLabel("readme.md"), "ArrowUp");
    expect(document.activeElement).toBe(src);
  });

  it("expands a collapsed parent with ArrowRight and dispatches toggle", () => {
    const toggles: Array<{ item: HTMLElement; expanded: boolean }> = [];
    root().addEventListener("stimeo--tree-view:toggle", (event) => {
      toggles.push((event as CustomEvent).detail);
    });
    const src = byLabel("src");
    key(src, "ArrowRight"); // expand
    expect(src.getAttribute("aria-expanded")).toBe("true");
    expect(byLabel("index.ts").closest<HTMLElement>("[role='group']")?.hidden).toBe(false);
    expect(toggles).toEqual([{ item: src, expanded: true }]);
  });

  it("steps into the first child with ArrowRight when already expanded", () => {
    const src = byLabel("src");
    key(src, "ArrowRight"); // expand
    key(src, "ArrowRight"); // into first child
    expect(document.activeElement).toBe(byLabel("index.ts"));
  });

  it("collapses with ArrowLeft, then steps to the parent", () => {
    const src = byLabel("src");
    key(src, "ArrowRight"); // expand
    key(src, "ArrowRight"); // focus index.ts
    key(byLabel("index.ts"), "ArrowLeft"); // leaf -> parent
    expect(document.activeElement).toBe(src);
    key(src, "ArrowLeft"); // collapse
    expect(src.getAttribute("aria-expanded")).toBe("false");
  });

  it("jumps to the first/last visible item with Home/End", () => {
    const src = byLabel("src");
    key(src, "End");
    expect(document.activeElement).toBe(byLabel("package.json"));
    key(byLabel("package.json"), "Home");
    expect(document.activeElement).toBe(src);
  });

  it("selects an item with Enter (single selection)", () => {
    const selects: HTMLElement[] = [];
    root().addEventListener("stimeo--tree-view:select", (event) => {
      selects.push((event as CustomEvent).detail.item);
    });
    key(byLabel("src"), "Enter");
    expect(byLabel("src").getAttribute("aria-selected")).toBe("true");
    key(byLabel("src"), "ArrowDown");
    key(byLabel("readme.md"), " ");
    expect(byLabel("src").getAttribute("aria-selected")).toBe("false");
    expect(byLabel("readme.md").getAttribute("aria-selected")).toBe("true");
    expect(selects).toHaveLength(2);
  });

  it("selects on click and makes the item the tab stop", async () => {
    byLabel("readme.md").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(byLabel("readme.md").getAttribute("aria-selected")).toBe("true");
    expect(byLabel("readme.md").tabIndex).toBe(0);
  });

  it("moves to a matching visible item via typeahead", () => {
    vi.useFakeTimers();
    try {
      key(byLabel("src"), "r"); // readme.md
      expect(document.activeElement).toBe(byLabel("readme.md"));
      vi.advanceTimersByTime(600); // buffer resets
      key(byLabel("readme.md"), "p"); // package.json
      expect(document.activeElement).toBe(byLabel("package.json"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores keydown bubbling from a nested item to an ancestor handler", () => {
    const src = byLabel("src");
    key(src, "ArrowRight"); // expand so children are visible
    key(src, "ArrowRight"); // focus index.ts
    // A keydown dispatched on index.ts also bubbles to src's handler; only the
    // nearest item (index.ts) should act, moving to utils.ts (not double-moving).
    key(byLabel("index.ts"), "ArrowDown");
    expect(document.activeElement).toBe(byLabel("utils.ts"));
  });

  it("announces the tree and its items", async () => {
    const phrases = await captureSpeech({ container: root(), steps: 2 });
    expect(phrases).toEqual([
      "tree, Files, orientated vertically",
      "treeitem, src, not expanded, level 1, position 1, not selected, set size 3",
      "src",
    ]);
  });

  it("has no machine-detectable a11y violations (collapsed and expanded)", async () => {
    await expectNoA11yViolations(root());
    key(byLabel("src"), "ArrowRight");
    await expectNoA11yViolations(root());
  });
});
