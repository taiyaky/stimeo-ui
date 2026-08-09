import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TreeViewController } from "../src/controllers/tree_view_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link TreeViewController}: visible-item navigation,
 * expand/collapse and parent/child movement, Home/End, typeahead, single
 * selection, roving tabindex, the `select`/`toggle` events, plus the lifecycle
 * (disconnect teardown / reconnect) and edge contracts — boundaries, nested
 * interactive controls, disabled items, and items added or removed at runtime.
 */

const item = (label: string, attrs: string, children = "") => `
  <li role="treeitem" ${attrs}
      data-stimeo--tree-view-target="item"
      data-action="keydown->stimeo--tree-view#onKeydown click->stimeo--tree-view#onClick">
    <span>${label}</span>
    ${children}
  </li>`;

const tree = (children: string, attrs = "") => `
  <ul data-controller="stimeo--tree-view" role="tree" aria-label="Files" ${attrs}>
    ${children}
  </ul>`;

const markup = tree(`
    ${item(
      "src",
      'aria-expanded="false" aria-selected="false" tabindex="0"',
      `<ul role="group" data-stimeo--tree-view-target="group" hidden>
        ${item("index.ts", 'aria-selected="false" tabindex="-1"')}
        ${item("utils.ts", 'aria-selected="false" tabindex="-1"')}
      </ul>`,
    )}
    ${item("readme.md", 'aria-selected="false" tabindex="-1"')}
    ${item("package.json", 'aria-selected="false" tabindex="-1"')}`);

describe("TreeViewController", () => {
  let application: Application | undefined;

  /** Renders `html`, starts Stimulus, and waits for the controller to connect. */
  const mount = async (html: string) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--tree-view", TreeViewController);
    await tick();
  };

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  const roots = () => Array.from(document.querySelectorAll<HTMLElement>("[role='tree']"));
  const root = () => roots()[0] as HTMLElement;
  const controller = () =>
    application?.getControllerForElementAndIdentifier(
      root(),
      "stimeo--tree-view",
    ) as TreeViewController;
  const items = (scope: HTMLElement = document.body) =>
    Array.from(scope.querySelectorAll<HTMLElement>("[role='treeitem']"));
  const byLabel = (label: string, scope: HTMLElement = document.body) =>
    items(scope).find((it) => it.querySelector("span")?.textContent === label) as HTMLElement;
  const key = (el: HTMLElement, k: string, init: KeyboardEventInit = {}) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
  const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const tabbable = (scope: HTMLElement = document.body) =>
    items(scope).filter((it) => it.tabIndex === 0);
  /** Collects the `detail` of every `stimeo--tree-view:<name>` event on the tree. */
  const listen = <T>(name: string, scope: HTMLElement = root()): T[] => {
    const seen: T[] = [];
    scope.addEventListener(`stimeo--tree-view:${name}`, (event) => {
      seen.push((event as CustomEvent).detail as T);
    });
    return seen;
  };
  /**
   * Removes `element` (with any nested items) and drives the Stimulus target
   * callbacks by hand, in the DOM order Stimulus reports them. happy-dom fires
   * the MutationObserver those callbacks ride on unreliably: an item inserted
   * into a live tree never reaches `itemTargetConnected`, so the real wiring is
   * asserted in a real browser instead, exactly as the runtime-addition case is.
   */
  const removeItem = (...elements: HTMLElement[]) => {
    const owner = elements[0]?.closest<HTMLElement>("[role='tree']") as HTMLElement;
    const instance = application?.getControllerForElementAndIdentifier(
      owner,
      "stimeo--tree-view",
    ) as TreeViewController;
    const removed = elements.flatMap((element) => [element, ...items(element)]);
    // Every element leaves before any callback runs — the shape a Turbo Stream
    // response or a morph produces when it drops several rows at once.
    for (const element of elements) element.remove();
    for (const gone of removed) instance.itemTargetDisconnected(gone);
  };

  describe("navigation and selection", () => {
    beforeEach(async () => {
      await mount(markup);
    });

    it("starts as a single tab stop on the first item", () => {
      expect(byLabel("src").tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });

    it("moves between visible items with ArrowDown/ArrowUp (skipping collapsed children)", () => {
      const src = byLabel("src");
      key(src, "ArrowDown"); // src -> readme (index.ts is hidden)
      expect(document.activeElement).toBe(byLabel("readme.md"));
      key(byLabel("readme.md"), "ArrowUp");
      expect(document.activeElement).toBe(src);
    });

    it("stays put at the first and last visible item", () => {
      const src = byLabel("src");
      src.focus();
      key(src, "ArrowUp");
      expect(document.activeElement).toBe(src);
      key(src, "End");
      expect(document.activeElement).toBe(byLabel("package.json"));
      key(byLabel("package.json"), "ArrowDown");
      expect(document.activeElement).toBe(byLabel("package.json"));
    });

    it("expands a collapsed parent with ArrowRight and dispatches toggle", () => {
      const toggles = listen<{ item: HTMLElement; expanded: boolean }>("toggle");
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
      const toggles = listen<{ item: HTMLElement; expanded: boolean }>("toggle");
      const src = byLabel("src");
      const group = src.querySelector<HTMLElement>("[role='group']") as HTMLElement;
      key(src, "ArrowRight"); // expand
      key(src, "ArrowRight"); // focus index.ts
      key(byLabel("index.ts"), "ArrowLeft"); // leaf -> parent
      expect(document.activeElement).toBe(src);
      key(src, "ArrowLeft"); // collapse
      expect(src.getAttribute("aria-expanded")).toBe("false");
      expect(group.hidden).toBe(true);
      expect(toggles).toEqual([
        { item: src, expanded: true },
        { item: src, expanded: false },
      ]);
    });

    it("does nothing on ArrowRight at a leaf or ArrowLeft at the root", () => {
      const readme = byLabel("readme.md");
      key(byLabel("src"), "ArrowDown");
      key(readme, "ArrowRight");
      expect(readme.hasAttribute("aria-expanded")).toBe(false);
      expect(document.activeElement).toBe(readme);
      key(readme, "ArrowLeft");
      expect(document.activeElement).toBe(readme);
    });

    it("jumps to the first/last visible item with Home/End", () => {
      const src = byLabel("src");
      key(src, "End");
      expect(document.activeElement).toBe(byLabel("package.json"));
      key(byLabel("package.json"), "Home");
      expect(document.activeElement).toBe(src);
    });

    it("keeps End on the last visible item once a subtree is expanded", () => {
      const src = byLabel("src");
      key(src, "ArrowRight"); // expand src: index.ts / utils.ts become visible
      key(src, "End");
      // package.json is still the last visible item; the expanded children are
      // in the middle of the visible set, which is what #visibleItems must model.
      expect(document.activeElement).toBe(byLabel("package.json"));
      key(byLabel("package.json"), "Home");
      expect(document.activeElement).toBe(src);
      key(src, "ArrowDown");
      expect(document.activeElement).toBe(byLabel("index.ts"));
    });

    it("selects an item with Enter (single selection)", () => {
      const selects = listen<{ item: HTMLElement }>("select");
      key(byLabel("src"), "Enter");
      expect(byLabel("src").getAttribute("aria-selected")).toBe("true");
      key(byLabel("src"), "ArrowDown");
      key(byLabel("readme.md"), "Enter");
      expect(byLabel("src").getAttribute("aria-selected")).toBe("false");
      expect(byLabel("readme.md").getAttribute("aria-selected")).toBe("true");
      expect(selects).toEqual([{ item: byLabel("src") }, { item: byLabel("readme.md") }]);
    });

    it("selects an item with Space", () => {
      const selects = listen<{ item: HTMLElement }>("select");
      key(byLabel("src"), "ArrowDown");
      key(byLabel("readme.md"), " ");
      expect(byLabel("readme.md").getAttribute("aria-selected")).toBe("true");
      expect(selects).toEqual([{ item: byLabel("readme.md") }]);
    });

    it("selects on click, focuses the item, and makes it the tab stop", () => {
      const selects = listen<{ item: HTMLElement }>("select");
      click(byLabel("readme.md"));
      expect(byLabel("readme.md").getAttribute("aria-selected")).toBe("true");
      expect(byLabel("readme.md").tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
      expect(document.activeElement).toBe(byLabel("readme.md"));
      expect(selects).toEqual([{ item: byLabel("readme.md") }]);
    });

    it("selects nothing when the click lands on a child group's own box", () => {
      const selects = listen<{ item: HTMLElement }>("select");
      const src = byLabel("src");
      key(src, "ArrowRight"); // expand so the group is visible
      const group = src.querySelector<HTMLElement>("[role='group']") as HTMLElement;
      click(group); // the indentation band belongs to the group, not to src
      expect(items().some((it) => it.getAttribute("aria-selected") === "true")).toBe(false);
      expect(selects).toEqual([]);
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

    it("does not move focus from an item a consumer hid directly", () => {
      const src = byLabel("src");
      key(src, "ArrowRight"); // expand
      key(src, "ArrowRight"); // focus index.ts
      const group = src.querySelector<HTMLElement>("[role='group']") as HTMLElement;
      group.hidden = true; // consumer collapses the group behind the controller's back
      key(byLabel("index.ts"), "ArrowDown");
      // Without the "not in the visible set" guard this warps to the tree's top.
      expect(document.activeElement).toBe(byLabel("index.ts"));
    });

    it("yields a key a descendant widget already consumed", () => {
      const src = byLabel("src");
      src.focus();
      const label = src.querySelector("span") as HTMLElement;
      // A composed widget inside the row that claims the key must not ALSO move
      // the tree's focus. The row's own handler sees the event after the
      // label's, with defaultPrevented already set.
      label.addEventListener("keydown", (event) => event.preventDefault());
      const handled = key(label, "ArrowDown", { cancelable: true });
      expect(handled).toBe(false); // the descendant really did claim the key
      expect(document.activeElement).toBe(src);
    });

    it("leaves a modified arrow to the browser (Alt+Left/Right is history navigation)", () => {
      const src = byLabel("src");
      src.focus();
      const event = new KeyboardEvent("keydown", {
        key: "ArrowRight",
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      src.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(src.getAttribute("aria-expanded")).toBe("false"); // still collapsed
      expect(document.activeElement).toBe(src);
    });

    it("announces the tree and its items", async () => {
      const phrases = await captureSpeech({ container: root(), steps: 2 });
      expect(phrases).toEqual([
        "tree, Files, orientated vertically",
        "treeitem, src, not expanded, level 1, position 1, not selected, set size 3",
        "src",
      ]);
    });

    it("announces the expanded and selected state after they change", async () => {
      const src = byLabel("src");
      key(src, "ArrowRight"); // expand
      key(src, "Enter"); // select
      const phrases = await captureSpeech({ container: root(), steps: 3 });
      // The expanded children are now part of src's computed name, which is what
      // an AT reads from the revealed subtree; the states are the assertion here.
      expect(phrases).toEqual([
        "tree, Files, orientated vertically",
        "treeitem, src index.ts utils.ts, expanded, level 1, position 1, selected, set size 3",
        "src",
        "group",
      ]);
    });

    it("has no machine-detectable a11y violations (collapsed and expanded)", async () => {
      await expectNoA11yViolations(root());
      key(byLabel("src"), "ArrowRight");
      await expectNoA11yViolations(root());
    });
  });

  describe("typeahead", () => {
    const typeaheadMarkup = tree(`
      ${item(
        "alpha",
        'aria-expanded="false" aria-selected="false" tabindex="0"',
        `<ul role="group" data-stimeo--tree-view-target="group" hidden>
          ${item("album", 'aria-selected="false" tabindex="-1"')}
        </ul>`,
      )}
      ${item("alpine", 'aria-selected="false" tabindex="-1"')}
      ${item("beta", 'aria-selected="false" tabindex="-1"')}
      ${item("bravo", 'aria-selected="false" tabindex="-1"')}
      ${item("misc", 'aria-label="zeta" aria-selected="false" tabindex="-1"')}`);

    beforeEach(async () => {
      await mount(typeaheadMarkup);
      vi.useFakeTimers();
    });

    it("moves to the next item whose label starts with the typed character", () => {
      key(byLabel("alpha"), "b");
      expect(document.activeElement).toBe(byLabel("beta"));
    });

    it("accumulates characters typed within the timeout into one prefix", () => {
      const alpha = byLabel("alpha");
      key(alpha, "a");
      expect(document.activeElement).toBe(byLabel("alpine"));
      key(byLabel("alpine"), "l");
      key(byLabel("alpine"), "p");
      key(byLabel("alpine"), "i");
      // "alpi" matches only alpine, so focus stays there rather than cycling.
      expect(document.activeElement).toBe(byLabel("alpine"));
      key(byLabel("alpine"), "n");
      expect(document.activeElement).toBe(byLabel("alpine"));
    });

    it("keeps concatenating just under the timeout and starts over past it", () => {
      key(byLabel("alpha"), "a"); // -> alpine
      vi.advanceTimersByTime(499);
      key(byLabel("alpine"), "l"); // buffer "al" -> wraps back to alpha
      expect(document.activeElement).toBe(byLabel("alpha"));
      vi.advanceTimersByTime(500); // buffer resets
      key(byLabel("alpha"), "b"); // a stale "alb" buffer would match nothing
      expect(document.activeElement).toBe(byLabel("beta"));
    });

    it("cycles through the matches when the same character repeats", () => {
      key(byLabel("alpha"), "b");
      expect(document.activeElement).toBe(byLabel("beta"));
      key(byLabel("beta"), "b");
      expect(document.activeElement).toBe(byLabel("bravo"));
      key(byLabel("bravo"), "b");
      expect(document.activeElement).toBe(byLabel("beta"));
    });

    it("resumes narrowing after a repeated key instead of stalling on a dead query", () => {
      // A repeated key collapses instead of growing the query, so the character
      // after a repeat narrows from a single character rather than matching nothing.
      key(byLabel("alpha"), "b");
      expect(document.activeElement).toBe(byLabel("beta"));
      key(byLabel("beta"), "b");
      expect(document.activeElement).toBe(byLabel("bravo"));
      key(byLabel("bravo"), "e");
      expect(document.activeElement).toBe(byLabel("beta")); // "be", not "bbe"
    });

    it("ignores printable keys pressed with a command modifier", () => {
      const alpha = byLabel("alpha");
      key(alpha, "b", { ctrlKey: true });
      key(alpha, "b", { metaKey: true });
      key(alpha, "b", { altKey: true });
      expect(document.activeElement).not.toBe(byLabel("beta"));
    });

    it("never matches an item inside a collapsed group", () => {
      const alpha = byLabel("alpha");
      key(alpha, "a"); // -> alpine
      key(byLabel("alpine"), "l"); // "al" -> wraps back to alpha
      key(byLabel("alpha"), "b"); // "alb" only matches the collapsed album
      expect(document.activeElement).toBe(byLabel("alpha"));
      expect(byLabel("album").tabIndex).toBe(-1);
    });

    it("matches aria-label before the item's own text", () => {
      key(byLabel("alpha"), "z"); // the item reads "misc" but is named "zeta"
      expect(document.activeElement).toBe(byLabel("misc"));
    });
  });

  describe("initial tab stop and expansion state", () => {
    it("keeps an existing tab stop that is not the first item", async () => {
      await mount(
        tree(`
          ${item("src", 'aria-selected="false" tabindex="-1"')}
          ${item("readme.md", 'aria-selected="false" tabindex="-1"')}
          ${item("package.json", 'aria-selected="false" tabindex="0"')}`),
      );
      expect(byLabel("package.json").tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });

    it("gives the tab stop to the first item when the markup has none", async () => {
      await mount(
        tree(`
          ${item("src", 'aria-selected="false"')}
          ${item("readme.md", 'aria-selected="false"')}`),
      );
      expect(byLabel("src").tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });

    it("gives the tab stop to the selected item when the markup has none", async () => {
      await mount(
        tree(`
          ${item("src", 'aria-selected="false"')}
          ${item("readme.md", 'aria-selected="true"')}
          ${item("package.json", 'aria-selected="false"')}`),
      );
      expect(byLabel("readme.md").tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });

    it("reveals a group whose parent is authored as expanded", async () => {
      await mount(
        tree(
          item(
            "src",
            'aria-expanded="true" aria-selected="false" tabindex="0"',
            `<ul role="group" data-stimeo--tree-view-target="group" hidden>
              ${item("index.ts", 'aria-selected="false" tabindex="-1"')}
            </ul>`,
          ),
        ),
      );
      const group = root().querySelector<HTMLElement>("[role='group']") as HTMLElement;
      expect(group.hidden).toBe(false);
      key(byLabel("src"), "ArrowRight"); // already expanded -> step into the child
      expect(document.activeElement).toBe(byLabel("index.ts"));
    });

    it("derives aria-expanded from the group when the parent has none", async () => {
      await mount(
        tree(
          item(
            "src",
            'aria-selected="false" tabindex="0"',
            `<ul role="group" data-stimeo--tree-view-target="group">
              ${item("index.ts", 'aria-selected="false" tabindex="-1"')}
            </ul>`,
          ),
        ),
      );
      expect(byLabel("src").getAttribute("aria-expanded")).toBe("true");
    });

    it("keeps a hidden item out of the move set and off the tab stop", async () => {
      await mount(
        tree(`
          ${item("src", 'aria-selected="false" tabindex="-1" hidden')}
          ${item("readme.md", 'aria-selected="false" tabindex="-1"')}
          ${item("package.json", 'aria-selected="false" tabindex="-1"')}`),
      );
      // A `hidden` row is out of the move set, so the only Tab stop can never
      // land on an invisible row.
      expect(byLabel("src").tabIndex).toBe(-1);
      expect(byLabel("readme.md").tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
      const readme = byLabel("readme.md");
      readme.focus();
      key(readme, "Home");
      expect(document.activeElement).toBe(readme);
      key(readme, "ArrowUp");
      expect(document.activeElement).toBe(readme);
    });

    it("keeps the tab stop out of a subtree whose parent row is hidden", async () => {
      await mount(
        tree(`
          ${item(
            "src",
            'aria-expanded="true" aria-selected="false" tabindex="-1" hidden',
            `<ul role="group" data-stimeo--tree-view-target="group">
              ${item("index.ts", 'aria-selected="false" tabindex="-1"')}
            </ul>`,
          )}
          ${item("readme.md", 'aria-selected="false" tabindex="-1"')}`),
      );
      // The child is not `hidden` itself, but nothing under a hidden row is
      // reachable, so the only Tab stop must not land there.
      expect(byLabel("index.ts").tabIndex).toBe(-1);
      expect(byLabel("readme.md").tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });

    it("skips a hidden first child when stepping in with ArrowRight", async () => {
      await mount(
        tree(
          item(
            "src",
            'aria-expanded="true" aria-selected="false" tabindex="0"',
            `<ul role="group" data-stimeo--tree-view-target="group">
              ${item("hidden.ts", 'aria-selected="false" tabindex="-1" hidden')}
              ${item("index.ts", 'aria-selected="false" tabindex="-1"')}
            </ul>`,
          ),
        ),
      );
      const src = byLabel("src");
      src.focus();
      key(src, "ArrowRight"); // already expanded -> step into the first child
      expect(document.activeElement).toBe(byLabel("index.ts"));
      expect(byLabel("hidden.ts").tabIndex).toBe(-1);
      expect(tabbable()).toHaveLength(1);
    });

    it("never leaves the only tab stop on an item inside a collapsed group", async () => {
      await mount(
        tree(
          item(
            "src",
            'aria-expanded="false" aria-selected="false" tabindex="-1"',
            `<ul role="group" data-stimeo--tree-view-target="group" hidden>
              ${item("index.ts", 'aria-selected="false" tabindex="0"')}
            </ul>`,
          ),
        ),
      );
      expect(byLabel("src").tabIndex).toBe(0);
      expect(byLabel("index.ts").tabIndex).toBe(-1);
    });
  });

  describe("nested interactive controls", () => {
    const nestedMarkup = tree(`
      ${item(
        "src",
        'aria-expanded="false" aria-selected="false" tabindex="0"',
        `<input aria-label="rename" />
         <a href="#src">details</a>
         <ul role="group" data-stimeo--tree-view-target="group" hidden>
           ${item("index.ts", 'aria-selected="false" tabindex="-1"')}
         </ul>`,
      )}
      ${item("readme.md", 'aria-selected="false" tabindex="-1"')}`);

    beforeEach(async () => {
      await mount(nestedMarkup);
    });

    const input = () => root().querySelector("input") as HTMLInputElement;

    it("leaves printable keys typed in a nested input to the input", () => {
      const src = byLabel("src");
      src.focus();
      const handled = key(input(), "r"); // "r" would typeahead to readme.md
      expect(handled).toBe(true); // not preventDefault()ed
      expect(document.activeElement).toBe(src);
    });

    it("does not select or expand from keys raised inside a nested input", () => {
      const selects = listen<{ item: HTMLElement }>("select");
      key(input(), " ");
      key(input(), "ArrowRight");
      key(input(), "ArrowDown");
      expect(selects).toEqual([]);
      expect(byLabel("src").getAttribute("aria-expanded")).toBe("false");
      expect(byLabel("src").getAttribute("aria-selected")).toBe("false");
    });

    it("does not select when a nested link is clicked", () => {
      const selects = listen<{ item: HTMLElement }>("select");
      click(root().querySelector("a") as HTMLElement);
      expect(selects).toEqual([]);
      expect(byLabel("src").getAttribute("aria-selected")).toBe("false");
    });

    it("ignores a keydown raised while an IME composition is active", () => {
      const src = byLabel("src");
      src.focus();
      key(src, "r", { isComposing: true });
      expect(document.activeElement).toBe(src);
    });
  });

  describe("interactive item host (out of contract)", () => {
    // APG's Navigation Treeview puts `role="treeitem"` on the link itself. This
    // controller's contract excludes that host: `Enter` is already spoken for by
    // selection, so a link host would have to arbitrate selection against the
    // native activation. The consequence is that the tree yields *entirely*
    // rather than half-working — pinned here so a future change cannot make it
    // partially responsive by accident.
    const linkMarkup = `
      <ul data-controller="stimeo--tree-view" role="tree" aria-label="Links">
        <li role="none">
          <a href="#one" role="treeitem" aria-selected="false" tabindex="0"
             data-stimeo--tree-view-target="item"
             data-action="keydown->stimeo--tree-view#onKeydown click->stimeo--tree-view#onClick">
            <span>one</span>
          </a>
        </li>
        <li role="none">
          <a href="#two" role="treeitem" aria-selected="false" tabindex="-1"
             data-stimeo--tree-view-target="item"
             data-action="keydown->stimeo--tree-view#onKeydown click->stimeo--tree-view#onClick">
            <span>two</span>
          </a>
        </li>
      </ul>`;

    it("neither navigates nor selects from an interactive item host", async () => {
      await mount(linkMarkup);
      const selects = listen<{ item: HTMLElement }>("select");
      const one = byLabel("one");
      one.focus();
      key(one, "ArrowDown");
      expect(document.activeElement).toBe(one);
      key(one, "Enter");
      click(one);
      expect(one.getAttribute("aria-selected")).toBe("false");
      expect(byLabel("two").getAttribute("aria-selected")).toBe("false");
      expect(selects).toEqual([]);
    });

    it("still establishes a single tab stop on such a tree", async () => {
      await mount(linkMarkup);
      // connect() only reads and writes `tabindex`, so the roving invariant
      // holds even where the key and pointer paths stand down.
      expect(byLabel("one").tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });
  });

  describe("toggle action (pointer expand/collapse)", () => {
    const chevron = `<button type="button" class="chevron" tabindex="-1" aria-hidden="true"
        data-action="click->stimeo--tree-view#toggle"></button>`;
    const chevronMarkup = tree(`
      ${item(
        "src",
        'aria-expanded="false" aria-selected="false" tabindex="0"',
        `${chevron}
         <ul role="group" data-stimeo--tree-view-target="group" hidden>
           ${item("index.ts", 'aria-selected="false" tabindex="-1"')}
         </ul>`,
      )}
      ${item("readme.md", 'aria-selected="false" tabindex="-1"', chevron)}`);

    beforeEach(async () => {
      await mount(chevronMarkup);
    });

    const chevronOf = (label: string) =>
      byLabel(label).querySelector<HTMLElement>(":scope > .chevron") as HTMLElement;

    it("expands and collapses the nearest item, dispatching toggle", () => {
      const toggles = listen<{ item: HTMLElement; expanded: boolean }>("toggle");
      const src = byLabel("src");
      const group = src.querySelector<HTMLElement>("[role='group']") as HTMLElement;
      click(chevronOf("src"));
      expect(src.getAttribute("aria-expanded")).toBe("true");
      expect(group.hidden).toBe(false);
      click(chevronOf("src"));
      expect(src.getAttribute("aria-expanded")).toBe("false");
      expect(group.hidden).toBe(true);
      expect(toggles).toEqual([
        { item: src, expanded: true },
        { item: src, expanded: false },
      ]);
    });

    it("does not select the item the chevron belongs to", () => {
      const selects = listen<{ item: HTMLElement }>("select");
      click(chevronOf("src"));
      expect(byLabel("src").getAttribute("aria-selected")).toBe("false");
      expect(selects).toEqual([]);
    });

    it("gives the toggled row focus and the tab stop", () => {
      const src = byLabel("src");
      const chevron = chevronOf("src");
      // A real browser focuses a clicked button on mousedown, so the chevron would
      // hold focus (and it is aria-hidden) unless toggle hands the row focus back.
      chevron.focus();
      click(chevron);
      expect(document.activeElement).toBe(src);
      expect(src.tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });

    it("does nothing when the toggled item is a leaf", () => {
      const toggles = listen<{ item: HTMLElement; expanded: boolean }>("toggle");
      const leaf = byLabel("readme.md");
      byLabel("src").focus();
      click(chevronOf("readme.md"));
      expect(toggles).toEqual([]);
      expect(leaf.hasAttribute("aria-expanded")).toBe(false);
      // Focus must not travel to the leaf either: the action was a no-op.
      expect(document.activeElement).toBe(byLabel("src"));
    });

    it("moves focus out of a collapsed subtree before toggle", () => {
      const src = byLabel("src");
      const child = byLabel("index.ts");
      const chevron = chevronOf("src");
      click(chevron); // expand
      key(src, "ArrowRight"); // the child owns focus and the tab stop
      expect(document.activeElement).toBe(child);

      let focusAtToggle: Element | null = null;
      let tabStopsAtToggle: HTMLElement[] = [];
      root().addEventListener(
        "stimeo--tree-view:toggle",
        () => {
          focusAtToggle = document.activeElement;
          tabStopsAtToggle = tabbable();
        },
        { once: true },
      );

      click(chevron); // programmatic activation leaves focus inside the group
      expect(focusAtToggle).toBe(src);
      expect(tabStopsAtToggle).toEqual([src]);
      expect(document.activeElement).toBe(src);
      expect(tabbable()).toEqual([src]);
    });

    it("repairs a stranded tab stop before toggle, then focuses the row", () => {
      const src = byLabel("src");
      const child = byLabel("index.ts");
      const chevron = chevronOf("src");
      const group = src.querySelector<HTMLElement>("[role='group']") as HTMLElement;
      click(chevron); // expand
      key(src, "ArrowRight"); // the child owns focus and the tab stop
      expect(document.activeElement).toBe(child);
      chevron.focus(); // mirror the native mousedown before click

      let focusAtToggle: Element | null = null;
      let tabStopsAtToggle: HTMLElement[] = [];
      let hiddenAtToggle = false;
      root().addEventListener(
        "stimeo--tree-view:toggle",
        () => {
          focusAtToggle = document.activeElement;
          tabStopsAtToggle = tabbable();
          hiddenAtToggle = group.hasAttribute("hidden");
        },
        { once: true },
      );

      click(chevron);
      expect(hiddenAtToggle).toBe(true);
      expect(focusAtToggle).toBe(chevron);
      expect(tabStopsAtToggle).toEqual([src]);
      expect(document.activeElement).toBe(src);
      expect(tabbable()).toEqual([src]);
    });

    it("has no machine-detectable a11y violations with a chevron", async () => {
      await expectNoA11yViolations(root());
      click(chevronOf("src"));
      await expectNoA11yViolations(root());
    });
  });

  describe("lifecycle", () => {
    beforeEach(async () => {
      await mount(markup);
    });

    it("drops the typeahead buffer and its timer on disconnect", () => {
      vi.useFakeTimers();
      key(byLabel("src"), "r"); // -> readme.md, arms the 500ms reset timer
      expect(document.activeElement).toBe(byLabel("readme.md"));
      expect(vi.getTimerCount()).toBe(1);

      const instance = controller();
      instance.disconnect();
      expect(vi.getTimerCount()).toBe(0); // the pending reset never outlives the element
      vi.advanceTimersByTime(600);
      expect(document.activeElement).toBe(byLabel("readme.md")); // nothing fired

      instance.connect();
      key(byLabel("readme.md"), "p"); // a stale "rp" buffer would match nothing
      expect(document.activeElement).toBe(byLabel("package.json"));
    });

    it("keeps the roving position across a reconnect", () => {
      key(byLabel("src"), "End");
      const instance = controller();
      instance.disconnect();
      instance.connect();
      expect(byLabel("package.json").tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });
  });

  describe("dynamic removal", () => {
    it("keeps the tab stop and DOM focus when a non-active item is removed", async () => {
      await mount(markup);
      const src = byLabel("src");
      src.focus();
      removeItem(byLabel("package.json"));
      expect(document.activeElement).toBe(src);
      expect(src.tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });

    it("hands the tab stop and focus to the next item when the active one goes", async () => {
      await mount(markup);
      const src = byLabel("src");
      src.focus();
      key(src, "ArrowDown"); // readme.md now holds focus and the tab stop
      expect(document.activeElement).toBe(byLabel("readme.md"));
      removeItem(byLabel("readme.md"));
      expect(document.activeElement).toBe(byLabel("package.json"));
      expect(byLabel("package.json").tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });

    it("falls back to the previous item when the removed one was last", async () => {
      await mount(markup);
      const src = byLabel("src");
      src.focus();
      key(src, "End");
      expect(document.activeElement).toBe(byLabel("package.json"));
      removeItem(byLabel("package.json"));
      expect(document.activeElement).toBe(byLabel("readme.md"));
      expect(byLabel("readme.md").tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });

    it("recovers when the first item and its collapsed subtree are removed", async () => {
      await mount(markup);
      const src = byLabel("src");
      src.focus();
      removeItem(src); // src carries index.ts / utils.ts with it
      expect(items()).toHaveLength(2);
      expect(document.activeElement).toBe(byLabel("readme.md"));
      expect(byLabel("readme.md").tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });

    it("moves focus out of an expanded subtree that held it", async () => {
      await mount(markup);
      const src = byLabel("src");
      src.focus();
      key(src, "ArrowRight"); // expand
      key(src, "ArrowRight"); // focus index.ts
      expect(document.activeElement).toBe(byLabel("index.ts"));
      removeItem(src); // the focused child is removed along with its parent
      expect(document.activeElement).toBe(byLabel("readme.md"));
      expect(byLabel("readme.md").tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });

    it("restores the tab stop without stealing focus the tree never had", async () => {
      await mount(markup);
      expect(byLabel("src").tabIndex).toBe(0); // the tab stop, but nothing is focused
      removeItem(byLabel("src"));
      expect(document.activeElement).toBe(document.body);
      expect(byLabel("readme.md").tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });

    it("leaves no tab stop once the last item is removed", async () => {
      await mount(tree(item("src", 'aria-selected="false" tabindex="0"')));
      const src = byLabel("src");
      src.focus();
      removeItem(src);
      expect(items()).toHaveLength(0);
      expect(tabbable()).toHaveLength(0);
    });

    it("ignores the removal of an item inside a collapsed group", async () => {
      await mount(markup);
      const src = byLabel("src");
      src.focus();
      removeItem(byLabel("index.ts")); // invisible: neither focused nor the tab stop
      expect(document.activeElement).toBe(src);
      expect(src.tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });

    it("keeps a removal in one tree out of another on the page", async () => {
      await mount(`${markup}${markup}`);
      const [first, second] = roots() as [HTMLElement, HTMLElement];
      byLabel("src", first).focus();
      removeItem(byLabel("src", first));
      expect(document.activeElement).toBe(byLabel("readme.md", first));
      expect(tabbable(first)).toHaveLength(1);
      expect(byLabel("src", second).tabIndex).toBe(0);
      expect(tabbable(second)).toHaveLength(1);
    });

    it("still normalizes a runtime addition after a removal", async () => {
      await mount(markup);
      byLabel("src").focus();
      removeItem(byLabel("src"));
      root().insertAdjacentHTML(
        "beforeend",
        item("added.txt", 'aria-selected="false" tabindex="0"'),
      );
      controller().itemTargetConnected();
      expect(byLabel("readme.md").tabIndex).toBe(0);
      expect(byLabel("added.txt").tabIndex).toBe(-1);
      expect(tabbable()).toHaveLength(1);
    });

    it("keeps the recovered tab stop across a Turbo reconnect", async () => {
      await mount(markup);
      const src = byLabel("src");
      src.focus();
      key(src, "ArrowDown"); // readme.md
      removeItem(byLabel("readme.md"));
      const instance = controller();
      instance.disconnect();
      instance.connect();
      expect(byLabel("package.json").tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });

    it("keeps each removed item's position when several leave in one batch", async () => {
      await mount(
        tree(`
          ${item("alpha", 'aria-selected="false" tabindex="0"')}
          ${item("bravo", 'aria-selected="false" tabindex="-1"')}
          ${item("charlie", 'aria-selected="false" tabindex="-1"')}
          ${item("delta", 'aria-selected="false" tabindex="-1"')}
          ${item("echo", 'aria-selected="false" tabindex="-1"')}`),
      );
      const alpha = byLabel("alpha");
      alpha.focus();
      key(alpha, "End");
      key(byLabel("echo"), "ArrowUp"); // delta holds focus and the tab stop
      const delta = byLabel("delta");
      expect(document.activeElement).toBe(delta);

      removeItem(byLabel("bravo"), delta);

      // delta's neighbour is echo. bravo's callback must not erase delta's
      // recorded position before delta's own callback runs.
      expect(document.activeElement).toBe(byLabel("echo"));
      expect(byLabel("echo").tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });

    it("keeps a pending removal's slot when the addition is reported first", async () => {
      // One morph batch arrives as several callbacks, and their order is not
      // guaranteed: the add can be reported while the removed row is still in the
      // recorded order. Folding the live list in wholesale there would forget the
      // gap's position, and the recovery would land on the first row instead of
      // the one that inherited the slot.
      await mount(
        tree(`
          ${item("alpha", 'aria-selected="false" tabindex="0"')}
          ${item("bravo", 'aria-selected="false" tabindex="-1"')}
          ${item("charlie", 'aria-selected="false" tabindex="-1"')}`),
      );
      const bravo = byLabel("bravo");
      bravo.focus();
      const instance = controller();

      bravo.remove();
      root().insertAdjacentHTML("beforeend", item("delta", 'aria-selected="false" tabindex="-1"'));
      instance.itemTargetConnected(); // the addition lands first
      instance.itemTargetDisconnected(bravo);

      expect(document.activeElement).toBe(byLabel("charlie"));
      expect(byLabel("charlie").tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });

    it("does not restore focus the tree had already lost before the removal", async () => {
      await mount(markup);
      const src = byLabel("src");
      src.focus();
      src.blur(); // focus genuinely left the tree while everything still existed
      await flushMicrotasks(); // the tree settles "blurred, not removed" here
      expect(document.activeElement).toBe(document.body);
      removeItem(src);
      expect(document.activeElement).toBe(document.body);
      expect(byLabel("readme.md").tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });

    it("restores focus for a row that was focused before the tree connected", async () => {
      await mount(markup);
      const instance = controller();
      instance.disconnect();
      const src = byLabel("src");
      src.focus(); // focused while no focusin listener is attached
      instance.connect();
      removeItem(src);
      expect(document.activeElement).toBe(byLabel("readme.md"));
      expect(byLabel("readme.md").tabIndex).toBe(0);
      expect(tabbable()).toHaveLength(1);
    });

    it("stands down while the whole tree is being torn down", async () => {
      await mount(markup);
      const treeRoot = root();
      const src = byLabel("src");
      const readme = byLabel("readme.md");
      const instance = controller();
      src.focus();
      treeRoot.remove(); // the controller element itself left the document
      instance.itemTargetDisconnected(src);
      // There is nothing to recover into: rewriting the tab stop (and focusing)
      // on a detached tree while Stimulus drains its target callbacks would
      // move the roving position for a widget that no longer exists.
      expect(src.tabIndex).toBe(0);
      expect(readme.tabIndex).toBe(-1);
    });
  });

  describe("edge cases", () => {
    it("connects to a tree with no items", async () => {
      await mount(tree(""));
      expect(tabbable()).toHaveLength(0);
      expect(root().querySelectorAll("[role='treeitem']")).toHaveLength(0);
    });

    it("keeps focus on the only item of a single-item tree", async () => {
      await mount(tree(item("src", 'aria-selected="false" tabindex="0"')));
      const src = byLabel("src");
      src.focus();
      for (const k of ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"]) {
        key(src, k);
        expect(document.activeElement).toBe(src);
      }
      expect(tabbable()).toHaveLength(1);
    });

    it("keeps selection independent between two trees on the page", async () => {
      await mount(`${markup}${markup}`);
      const [first, second] = roots() as [HTMLElement, HTMLElement];
      key(byLabel("src", first), "Enter");
      key(byLabel("readme.md", second), "Enter");
      expect(byLabel("src", first).getAttribute("aria-selected")).toBe("true");
      expect(byLabel("readme.md", first).getAttribute("aria-selected")).toBe("false");
      expect(byLabel("src", second).getAttribute("aria-selected")).toBe("false");
      expect(byLabel("readme.md", second).getAttribute("aria-selected")).toBe("true");
      expect(tabbable(first)).toHaveLength(1);
      expect(tabbable(second)).toHaveLength(1);
    });

    it("normalizes the tab stop when an item is added at runtime", async () => {
      await mount(markup);
      root().insertAdjacentHTML(
        "beforeend",
        item("added.txt", 'aria-selected="false" tabindex="0"'),
      );
      // Stimulus registers new targets through a MutationObserver that happy-dom
      // fires unreliably, so drive the callback directly.
      controller().itemTargetConnected();
      expect(tabbable()).toHaveLength(1);
      expect(byLabel("src").tabIndex).toBe(0);
      expect(byLabel("added.txt").tabIndex).toBe(-1);
    });

    it("focuses but never selects an aria-disabled item", async () => {
      await mount(
        tree(`
          ${item("src", 'aria-selected="false" tabindex="0"')}
          ${item("readme.md", 'aria-disabled="true" aria-selected="false" tabindex="-1"')}`),
      );
      const selects = listen<{ item: HTMLElement }>("select");
      key(byLabel("src"), "ArrowDown");
      expect(document.activeElement).toBe(byLabel("readme.md"));
      key(byLabel("readme.md"), "Enter");
      click(byLabel("readme.md"));
      expect(byLabel("readme.md").getAttribute("aria-selected")).toBe("false");
      expect(selects).toEqual([]);
    });

    it("reverses ArrowRight / ArrowLeft under dir=rtl", async () => {
      // APG describes these as "to the child level" / "to the parent level" — a
      // spatial move — so they follow the writing direction, the same reasoning
      // that made horizontal roving logical.
      await mount(
        tree(
          item(
            "src",
            'aria-expanded="false" aria-selected="false" tabindex="0"',
            `<ul role="group" data-stimeo--tree-view-target="group" hidden>
               ${item("child.ts", 'aria-selected="false" tabindex="-1"')}
             </ul>`,
          ),
        ),
      );
      // The authoring contract is `dir="rtl"` on an ancestor, but happy-dom does
      // not resolve that attribute into the computed style, so the direction is
      // set as an inline style instead. It goes on the tree, which is the element
      // the controller reads.
      root().style.direction = "rtl";

      // In RTL the *left* arrow is the one that moves toward the child level.
      key(byLabel("src"), "ArrowLeft");
      expect(byLabel("src").getAttribute("aria-expanded")).toBe("true");

      key(byLabel("src"), "ArrowRight");
      expect(byLabel("src").getAttribute("aria-expanded")).toBe("false");
    });

    it("reads the direction from the tree, not from the focused row", async () => {
      // The rule this pins: the tree lays the rows out, so a row carrying its own
      // `dir` must not change which arrow reaches the child level. An LTR path
      // inside an RTL browser is ordinary bidi authoring, and probing the focused
      // row instead would make one row's arrows mean the opposite of its
      // sibling's. It is also the only shape that tells `isRtl(this.element)`
      // apart from `isRtl(item)`: an inline `direction` on the tree otherwise
      // inherits to every row, so both answer the same and the decision goes
      // unpinned.
      await mount(
        tree(
          item(
            "src",
            'aria-expanded="false" aria-selected="false" tabindex="0"',
            `<ul role="group" data-stimeo--tree-view-target="group" hidden>
               ${item("child.ts", 'aria-selected="false" tabindex="-1"')}
             </ul>`,
          ),
        ),
      );
      root().style.direction = "rtl";
      byLabel("src").style.direction = "ltr"; // the row disagrees with its tree

      key(byLabel("src"), "ArrowLeft"); // still "to the child level": the tree decides
      expect(byLabel("src").getAttribute("aria-expanded")).toBe("true");
    });

    it("disables the descendants of an aria-disabled branch", async () => {
      // ARIA: "The state of being disabled applies to the current element and all
      // focusable descendant elements." A tree is the only pattern here whose
      // items nest, so it is the only place the inheritance is observable.
      await mount(
        tree(
          item(
            "src",
            'aria-disabled="true" aria-expanded="true" aria-selected="false" tabindex="0"',
            `<ul role="group" data-stimeo--tree-view-target="group">
               ${item("child.ts", 'aria-selected="false" tabindex="-1"')}
             </ul>`,
          ),
        ),
      );
      const selects = listen<{ item: HTMLElement }>("select");

      click(byLabel("child.ts"));
      key(byLabel("child.ts"), "Enter");

      expect(byLabel("child.ts").getAttribute("aria-selected")).toBe("false");
      expect(selects).toEqual([]);
    });

    it("still expands an aria-disabled branch", async () => {
      // The disabled state carries down, but *navigation* is a separate question:
      // ARIA leaves it to the application, and an `aria-disabled` item stays
      // reachable. Hiding a branch's contents would undo that discoverability.
      await mount(
        tree(
          item(
            "src",
            'aria-disabled="true" aria-expanded="false" aria-selected="false" tabindex="0"',
            `<ul role="group" data-stimeo--tree-view-target="group" hidden>
               ${item("child.ts", 'aria-selected="false" tabindex="-1"')}
             </ul>`,
          ),
        ),
      );

      key(byLabel("src"), "ArrowRight");

      expect(byLabel("src").getAttribute("aria-expanded")).toBe("true");
    });

    it("still focuses a treeitem that carries no item target", async () => {
      await mount(
        tree(
          item(
            "src",
            'aria-expanded="true" aria-selected="false" tabindex="0"',
            `<ul role="group" data-stimeo--tree-view-target="group">
               <li role="treeitem" aria-selected="false" tabindex="-1"><span>ghost.ts</span></li>
             </ul>`,
          ),
        ),
      );
      const ghost = root().querySelector<HTMLElement>(
        "[role='group'] > [role='treeitem']",
      ) as HTMLElement;
      key(byLabel("src"), "ArrowRight"); // expanded already -> step into the first child
      expect(document.activeElement).toBe(ghost);
      expect(ghost.tabIndex).toBe(-1); // the tree stays a single Tab stop
      expect(byLabel("src").tabIndex).toBe(0);
    });
  });

  describe("the authored initial selection", () => {
    const selectedLabels = () =>
      Array.from(document.querySelectorAll('[role="treeitem"][aria-selected="true"]')).map((el) =>
        (el.querySelector("span")?.textContent ?? "").trim(),
      );

    it("gives every item an explicit value", async () => {
      // An absent `aria-selected` means "not selectable" in ARIA, so a forgotten
      // attribute hides a selectable row from assistive technology. `connect()`
      // reconciles selection the same way it reconciles authored expansion.
      await mount(tree(`${item("a", 'tabindex="0"')}${item("b", "")}`));

      expect(
        Array.from(document.querySelectorAll('[role="treeitem"]')).map((el) =>
          el.getAttribute("aria-selected"),
        ),
      ).toEqual(["false", "false"]);
    });

    it("keeps the first of several selected items and drops the rest", async () => {
      await mount(
        tree(
          `${item("a", 'aria-selected="true" tabindex="0"')}${item("b", 'aria-selected="true"')}`,
        ),
      );

      expect(selectedLabels()).toEqual(["a"]);
    });

    it("re-establishes the baseline for an item added after connect", async () => {
      await mount(tree(`${item("a", 'aria-selected="true" tabindex="0"')}`));
      const root = document.querySelector('[role="tree"]') as HTMLElement;
      const late = document.createElement("li");
      late.setAttribute("role", "treeitem");
      late.setAttribute("aria-selected", "true");
      late.setAttribute("tabindex", "-1");
      late.setAttribute("data-stimeo--tree-view-target", "item");
      late.innerHTML = "<span>late</span>";
      root.appendChild(late);
      await tick();

      expect(selectedLabels()).toEqual(["a"]);
    });

    it("does not touch a role=treeitem without the item target", async () => {
      await mount(tree(`${item("a", 'aria-selected="true" tabindex="0"')}`));
      const root = document.querySelector('[role="tree"]') as HTMLElement;
      const stray = document.createElement("li");
      stray.setAttribute("role", "treeitem");
      stray.setAttribute("aria-selected", "true");
      stray.innerHTML = "<span>stray</span>";
      root.appendChild(stray);
      await tick();

      expect(stray.getAttribute("aria-selected")).toBe("true");
    });

    it("never lends a tab stop to an untargeted treeitem that refuses focus", async () => {
      // `#focusItem` has a fallback for a `role="treeitem"` outside roving
      // bookkeeping: it writes `tabindex="-1"` and focuses the element directly.
      // A destination that cannot take focus swallows the `focus()` silently, so
      // without the pre-check the tree is left advertising a tab stop on a row
      // the caret never reached.
      await mount(
        tree(
          item(
            "src",
            'aria-expanded="true" aria-selected="false" tabindex="0"',
            `<ul role="group" data-stimeo--tree-view-target="group">
               <button type="button" role="treeitem" id="ghost" disabled>ghost</button>
             </ul>`,
          ),
        ),
      );
      const parent = byLabel("src");
      parent.focus();

      key(parent, "ArrowRight"); // steps into the first child, which is the ghost

      const ghost = document.querySelector("#ghost") as HTMLElement;
      expect(ghost.hasAttribute("tabindex")).toBe(false);
      expect(document.activeElement).toBe(parent);
    });
  });
});

/**
 * The label of a row is the row's own text, never the branch under it. Folding an
 * expanded subtree in would let a child's text answer for its parent — and the
 * parent sits earlier in the visible order, so it would win the match.
 */
describe("TreeViewController typeahead naming", () => {
  let application: Application;

  beforeEach(async () => {
    // Visible order: the blank-labelled parent, its child "zeta", then "beta".
    // Typing from "beta" wraps onto the parent *before* the child, so a parent
    // that borrowed its child's name would answer first.
    document.body.innerHTML = tree(`
      ${item(
        " ",
        'aria-expanded="true" aria-selected="false" tabindex="-1"',
        `<ul role="group" data-stimeo--tree-view-target="group">
          ${item("zeta", 'aria-selected="false" tabindex="-1"')}
        </ul>`,
      )}
      ${item("beta", 'aria-selected="false" tabindex="0"')}`);
    application = Application.start();
    application.register("stimeo--tree-view", TreeViewController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const key = (el: HTMLElement, k: string) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  it("does not let an expanded child's text name its parent", () => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const [parent, child, sibling] = rows;
    if (!parent || !child || !sibling) throw new Error("fixture lost a row");

    key(sibling, "z");

    expect(document.activeElement).toBe(child);
    expect(document.activeElement).not.toBe(parent);
  });
});
