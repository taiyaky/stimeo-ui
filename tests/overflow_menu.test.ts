import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MenuController } from "../src/controllers/menu_controller";
import { OverflowMenuController } from "../src/controllers/overflow_menu_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link OverflowMenuController}. happy-dom has no layout, so item
 * widths and the container width are stubbed and `update()` drives the rebalance:
 * priority-ordered overflow into the menu, restore when space returns, the More toggle
 * and state hooks, the change event, debounced resize, the moreLabel fallback, focus
 * handling, the Turbo re-adoption / restore contract, and observer teardown.
 *
 * Two things happy-dom cannot model must not be asserted here: a re-insert dropping focus
 * to `<body>`, and real geometry. What *is* asserted here is the cause the controller
 * controls — that an unchanged pass moves no node at all.
 */

const MARKUP = (trigger = "More", prefix = "") => `
  <div id="${prefix}om" data-controller="stimeo--overflow-menu" role="toolbar" aria-label="Actions">
    <div data-stimeo--overflow-menu-target="items">
      <a id="${prefix}a" href="#" data-priority="1">A</a>
      <a id="${prefix}b" href="#" data-priority="2">B</a>
      <a id="${prefix}c" href="#">C</a>
    </div>
    <div data-stimeo--overflow-menu-target="more" hidden>
      <button id="${prefix}more-trigger" data-stimeo--menu-target="trigger">${trigger}</button>
      <div role="menu" aria-labelledby="${prefix}more-trigger"
           data-stimeo--menu-target="menu"></div>
    </div>
  </div>`;

/** The composition: the More wrapper is a real `stimeo--menu`. */
const COMPOSED_MARKUP = `
  <div id="om" data-controller="stimeo--overflow-menu" role="toolbar" aria-label="Actions">
    <div data-stimeo--overflow-menu-target="items">
      <button type="button" id="a" data-priority="1"
        data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">A</button>
      <button type="button" id="b" data-priority="2"
        data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">B</button>
      <button type="button" id="c"
        data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown">C</button>
    </div>
    <div data-controller="stimeo--menu" data-stimeo--overflow-menu-target="more" hidden>
      <button type="button" id="more-trigger" data-stimeo--menu-target="trigger"
        aria-haspopup="menu" aria-expanded="false"
        data-action="click->stimeo--menu#toggle keydown->stimeo--menu#onTriggerKeydown">More</button>
      <div role="menu" aria-labelledby="more-trigger" data-stimeo--menu-target="menu" hidden></div>
    </div>
  </div>`;

/** The composition without per-element item bindings — Menu delegates those. */
const DELEGATED_MARKUP = COMPOSED_MARKUP.replace(
  / data-action="click->stimeo--menu#activate keydown->stimeo--menu#onItemKeydown"/g,
  "",
);

/** Buttons rather than links, so `disabled` is a real property to test against. */
const BUTTON_MARKUP = `
  <div id="om" data-controller="stimeo--overflow-menu" role="toolbar" aria-label="Actions">
    <div data-stimeo--overflow-menu-target="items">
      <button type="button" id="a" data-priority="1">A</button>
      <button type="button" id="b" data-priority="2">B</button>
      <button type="button" id="c">C</button>
    </div>
    <div data-stimeo--overflow-menu-target="more" hidden>
      <button type="button" id="more-trigger" data-stimeo--menu-target="trigger">More</button>
      <div role="menu" aria-labelledby="more-trigger" data-stimeo--menu-target="menu"></div>
    </div>
  </div>`;

/** The items row is itself a disabled fieldset, so its buttons inherit disabledness. */
const FIELDSET_MARKUP = (tag: "button" | "a") => `
  <div id="om" data-controller="stimeo--overflow-menu" role="toolbar" aria-label="Actions">
    <fieldset disabled data-stimeo--overflow-menu-target="items">
      ${
        tag === "button"
          ? `<button type="button" id="a" data-priority="1">A</button>
             <button type="button" id="b" data-priority="2">B</button>
             <button type="button" id="c">C</button>`
          : `<a href="#" id="a" data-priority="1">A</a>
             <a href="#" id="b" data-priority="2">B</a>
             <a href="#" id="c">C</a>`
      }
    </fieldset>
    <div data-stimeo--overflow-menu-target="more" hidden>
      <button type="button" id="more-trigger" data-stimeo--menu-target="trigger">More</button>
      <div role="menu" aria-labelledby="more-trigger" data-stimeo--menu-target="menu"></div>
    </div>
  </div>`;

/** MARKUP with the More trigger's attributes and inner HTML both fully authored. */
const TRIGGER_MARKUP = (attrs: string, inner: string) => `
  <div id="om" data-controller="stimeo--overflow-menu" role="toolbar" aria-label="Actions">
    <div data-stimeo--overflow-menu-target="items">
      <a id="a" href="#" data-priority="1">A</a>
      <a id="b" href="#" data-priority="2">B</a>
      <a id="c" href="#">C</a>
    </div>
    <div data-stimeo--overflow-menu-target="more" hidden>
      <button id="more-trigger" data-stimeo--menu-target="trigger" ${attrs}>${inner}</button>
      <div role="menu" aria-labelledby="more-trigger" data-stimeo--menu-target="menu"></div>
    </div>
  </div>`;

describe("OverflowMenuController", () => {
  let application: Application;

  const setup = (html: string) => {
    document.body.innerHTML = html;
  };
  const start = async (...extra: Array<[string, typeof MenuController]>) => {
    application = Application.start();
    application.register("stimeo--overflow-menu", OverflowMenuController);
    for (const [identifier, controller] of extra) application.register(identifier, controller);
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const root = () => query("#om");
  const items = () => query("[data-stimeo--overflow-menu-target='items']");
  const menu = () =>
    query("[data-stimeo--overflow-menu-target='more'] [data-stimeo--menu-target='menu']");
  const more = () => query("[data-stimeo--overflow-menu-target='more']");
  const trigger = () => query("[data-stimeo--menu-target='trigger']");
  const instance = (el: HTMLElement = root()) =>
    application.getControllerForElementAndIdentifier(
      el,
      "stimeo--overflow-menu",
    ) as OverflowMenuController;

  /** Stubs an element's layout-only property (happy-dom reports 0 for every box). */
  const stub = (el: Element, property: "clientWidth" | "offsetWidth", value: number) => {
    Object.defineProperty(el, property, { configurable: true, value });
  };

  /** Stubs the container width, each item's width (by id), and the More button width. */
  const setGeomIn = (
    scope: HTMLElement,
    container: number,
    itemW: Record<string, number>,
    moreW = 50,
  ) => {
    stub(scope, "clientWidth", container);
    for (const [id, w] of Object.entries(itemW)) stub(query(`#${id}`), "offsetWidth", w);
    stub(query("[data-stimeo--menu-target='trigger']", scope), "offsetWidth", moreW);
  };
  const setGeom = (container: number, itemW: Record<string, number>, moreW = 50) =>
    setGeomIn(root(), container, itemW, moreW);

  const ids = (el: Element) =>
    Array.from(el.children)
      .map((c) => c.id)
      .filter(Boolean);

  /** Attribute names this controller writes on an item for its own bookkeeping. */
  const bookkeeping = (el: Element) =>
    el.getAttributeNames().filter((name) => name.startsWith("data-stimeo--overflow-menu-"));

  it("preserves the fully banked boundary across an unchanged update", async () => {
    setup(MARKUP());
    setGeom(40, { a: 100, b: 100, c: 100 });
    await start();
    expect(ids(items())).toEqual([]);
    expect(ids(menu())).toEqual(["a", "b", "c"]);
    const boundary = items().querySelector("template");
    expect(boundary).not.toBeNull();
    instance().update();
    expect(items().querySelector("template")).toBe(boundary);
    expect(items().querySelectorAll("template")).toHaveLength(1);
    expect(ids(menu())).toEqual(["a", "b", "c"]);
  });

  it("treats a nonfinite saved bar index as unassigned during adoption", async () => {
    setup(MARKUP());
    query("#a").setAttribute("data-stimeo--overflow-menu-index", "not-a-number");
    const banked = query("#c");
    banked.setAttribute("data-stimeo--overflow-menu-banked", "true");
    banked.setAttribute("data-stimeo--overflow-menu-index", "0");
    menu().append(banked);
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    expect(ids(items())).toEqual(["c", "a", "b"]);
    expect(ids(menu())).toEqual([]);
  });

  it("leaves unexpanded More semantics unclaimed when every item fits", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    expect(trigger().hasAttribute("aria-expanded")).toBe(false);
    expect(menu().hidden).toBe(false);
    trigger().setAttribute("aria-expanded", "true");
    instance().update();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(menu().hidden).toBe(true);
  });

  it("falls back to insertion when moveBefore refuses a managed item", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    const move = vi.fn(() => {
      throw new DOMException("Cannot move this node", "HierarchyRequestError");
    });
    Object.defineProperty(menu(), "moveBefore", { configurable: true, value: move });
    setGeom(250, { a: 100, b: 100, c: 100 });
    expect(() => instance().update()).not.toThrow();
    expect(move).toHaveBeenCalled();
    expect(ids(items())).toEqual(["a", "b"]);
    expect(ids(menu())).toEqual(["c"]);
  });

  it("banks an earlier nonnumeric priority before later finite priorities", async () => {
    setup(MARKUP());
    query("#a").setAttribute("data-priority", "high");
    query("#b").setAttribute("data-priority", "2");
    query("#c").setAttribute("data-priority", "1");
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    expect(ids(items())).toEqual(["b", "c"]);
    expect(ids(menu())).toEqual(["a"]);
  });

  it("rescues a retreating HTML focus owner without claiming non-HTML focus", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    query("#c").append(svg);
    const active = vi.spyOn(document, "activeElement", "get");
    const focus = vi.spyOn(trigger(), "focus");
    try {
      active.mockReturnValue(svg);
      setGeom(250, { a: 100, b: 100, c: 100 });
      instance().update();
      expect(ids(menu())).toEqual(["c"]);
      expect(focus).not.toHaveBeenCalled();
      setGeom(1000, { a: 100, b: 100, c: 100 });
      instance().update();
      active.mockReturnValue(query("#c"));
      setGeom(250, { a: 100, b: 100, c: 100 });
      instance().update();
      expect(focus).toHaveBeenCalledTimes(1);
    } finally {
      active.mockRestore();
      focus.mockRestore();
    }
  });

  it.each(["items", "more"])(
    "acquires no resize lifetime while the %s target is missing",
    async (missing) => {
      setup(MARKUP());
      setGeom(1000, { a: 100, b: 100, c: 100 });
      const absent = missing === "items" ? items() : more();
      absent.remove();
      const subscriptions = vi.spyOn(window, "addEventListener");
      try {
        await start();
        expect(subscriptions.mock.calls.filter(([name]) => name === "resize")).toHaveLength(0);
        window.dispatchEvent(new Event("resize"));
        expect(vi.getTimerCount()).toBe(0);
        root().append(absent);
        instance().disconnect();
        instance().connect();
        expect(subscriptions.mock.calls.filter(([name]) => name === "resize")).toHaveLength(1);
        expect(root().getAttribute("data-overflow-count")).toBe("0");
      } finally {
        subscriptions.mockRestore();
      }
    },
  );

  it("removes an obsolete boundary before reordering a retained bar item", async () => {
    setup(MARKUP());
    setGeom(40, { a: 100, b: 100, c: 100 });
    await start();
    expect(ids(menu())).toEqual(["a", "b", "c"]);
    const boundary = items().querySelector("template");
    if (!boundary) throw new Error("Expected the fully banked boundary");
    const retained = document.createElement("a");
    retained.id = "d";
    retained.href = "#";
    retained.setAttribute("data-priority", "0");
    retained.textContent = "D";
    boundary.before(retained);
    stub(retained, "offsetWidth", 100);
    stub(root(), "clientWidth", 150);
    retained.focus();
    const insert = vi.spyOn(items(), "insertBefore");
    try {
      instance().update();
      expect(ids(items())).toEqual(["d"]);
      expect(ids(menu())).toEqual(["a", "b", "c"]);
      expect(items().querySelector("template")).toBeNull();
      expect(insert).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(retained);
    } finally {
      insert.mockRestore();
    }
  });

  it("keeps every item in the bar and hides More when they all fit", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    expect(ids(items())).toEqual(["a", "b", "c"]);
    expect(more().hidden).toBe(true);
    expect(root().hasAttribute("data-overflowing")).toBe(false);
    expect(root().getAttribute("data-overflow-count")).toBe("0");
  });

  // Every pass walks all items and un-banks the ones that stay in the bar, so the
  // restore has to refuse an item it never banked: the saved values it would read
  // are absent, and writing them back would take the authored ones away.
  it("leaves the authored attributes of an item that never banked alone", async () => {
    setup(
      MARKUP().replace(
        '<a id="a" href="#" data-priority="1">A</a>',
        '<a id="a" href="#" data-priority="1" role="link" tabindex="3">A</a>',
      ),
    );
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();

    const a = query("#a");
    expect(ids(items())).toEqual(["a", "b", "c"]);
    expect(a.getAttribute("role")).toBe("link");
    expect(a.getAttribute("tabindex")).toBe("3");
    expect(bookkeeping(a)).toEqual([]);
  });

  it("banks the lowest-priority item into the menu when items overflow", async () => {
    setup(MARKUP());
    setGeom(250, { a: 100, b: 100, c: 100 }); // budget 200 after the 50px More button
    await start();
    expect(ids(items())).toEqual(["a", "b"]);
    expect(ids(menu())).toEqual(["c"]); // C has no priority → drops first
    expect(more().hidden).toBe(false);
    expect(root().getAttribute("data-overflowing")).toBe("true");
    expect(root().getAttribute("data-overflow-count")).toBe("1");
  });

  it("drops by priority: no-priority first, then highest number, keeping priority 1", async () => {
    setup(MARKUP());
    setGeom(150, { a: 100, b: 100, c: 100 }); // budget 100 → must keep only A
    await start();
    expect(ids(items())).toEqual(["a"]);
    expect(ids(menu())).toEqual(["b", "c"]); // canonical order preserved in the menu
    expect(root().getAttribute("data-overflow-count")).toBe("2");
  });

  it("treats an empty or non-numeric data-priority as no priority", async () => {
    // `Number("")` is 0, which would read as the *highest* retention — the opposite of
    // the intent behind an ERB-blanked attribute. Both must rank with the unmarked items.
    setup(`
      <div id="om" data-controller="stimeo--overflow-menu" role="toolbar" aria-label="Actions">
        <div data-stimeo--overflow-menu-target="items">
          <a id="a" href="#" data-priority="1">A</a>
          <a id="b" href="#" data-priority=" ">B</a>
          <a id="c" href="#" data-priority="high">C</a>
        </div>
        <div data-stimeo--overflow-menu-target="more" hidden>
          <button id="more-trigger" data-stimeo--menu-target="trigger">More</button>
          <div role="menu" aria-labelledby="more-trigger" data-stimeo--menu-target="menu"></div>
        </div>
      </div>`);
    setGeom(150, { a: 100, b: 100, c: 100 }); // budget 100 → only one survives
    await start();
    expect(ids(items())).toEqual(["a"]); // the only real priority is kept
    expect(ids(menu())).toEqual(["b", "c"]);
  });

  it("returns a banked middle item to its original slot, not the end", async () => {
    // y (no priority) sits between x and z and drops first; on restore it must land
    // back between them, not after z.
    setup(`
      <div id="om" data-controller="stimeo--overflow-menu" role="toolbar" aria-label="Actions">
        <div data-stimeo--overflow-menu-target="items">
          <a id="x" href="#" data-priority="1">X</a>
          <a id="y" href="#">Y</a>
          <a id="z" href="#" data-priority="2">Z</a>
        </div>
        <div data-stimeo--overflow-menu-target="more" hidden>
          <button id="more-trigger" data-stimeo--menu-target="trigger">More</button>
          <div role="menu" aria-labelledby="more-trigger" data-stimeo--menu-target="menu"></div>
        </div>
      </div>`);
    setGeom(250, { x: 100, y: 100, z: 100 }); // banks only y (the middle, lowest priority)
    await start();
    expect(ids(items())).toEqual(["x", "z"]);
    expect(ids(menu())).toEqual(["y"]);

    setGeom(1000, { x: 100, y: 100, z: 100 });
    instance().update();
    expect(ids(items())).toEqual(["x", "y", "z"]); // y restored to the middle
  });

  it("keeps an item inserted at the head of the bar at the head", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();

    const z = document.createElement("a");
    z.id = "z";
    z.href = "#";
    z.textContent = "Z";
    z.setAttribute("data-priority", "1");
    items().insertBefore(z, items().firstElementChild);

    setGeom(1000, { a: 100, b: 100, c: 100, z: 100 });
    instance().update();
    // Canonical order comes from the DOM, so a leading insert is not silently appended.
    expect(ids(items())).toEqual(["z", "a", "b", "c"]);
  });

  /** Inserts `<a id>` at `position` inside the bar and returns it. */
  const insertLink = (id: string, position: "head" | "tail" | Element) => {
    const el = document.createElement("a");
    el.id = id;
    el.href = "#";
    el.textContent = id.toUpperCase();
    el.setAttribute("data-priority", "1"); // kept longest, so it never re-banks
    if (position === "head") items().insertBefore(el, items().firstElementChild);
    else if (position === "tail") items().appendChild(el);
    else items().insertBefore(el, position);
    return el;
  };

  it("keeps a head insert at the head while other items are banked", async () => {
    setup(MARKUP());
    setGeom(150, { a: 100, b: 100, c: 100 }); // budget 100 → B and C are banked
    await start();
    expect(ids(menu())).toEqual(["b", "c"]);

    insertLink("z", "head");
    setGeom(1000, { a: 100, b: 100, c: 100, z: 100 });
    instance().update();

    // The saved index is the position an item had in the *canonical* order, not an
    // offset into the current bar — using it as one shuffles A behind the banked pair.
    expect(ids(items())).toEqual(["z", "a", "b", "c"]);
  });

  it("keeps a head insert at the head when the banked item held the first slot", async () => {
    // A (no priority) drops first, so the banked item owns canonical index 0 — the
    // case where an item inserted at the head must still come back at the head.
    setup(`
      <div id="om" data-controller="stimeo--overflow-menu" role="toolbar" aria-label="Actions">
        <div data-stimeo--overflow-menu-target="items">
          <a id="a" href="#">A</a>
          <a id="b" href="#" data-priority="1">B</a>
        </div>
        <div data-stimeo--overflow-menu-target="more" hidden>
          <button id="more-trigger" data-stimeo--menu-target="trigger">More</button>
          <div role="menu" aria-labelledby="more-trigger" data-stimeo--menu-target="menu"></div>
        </div>
      </div>`);
    setGeom(150, { a: 100, b: 100 }); // budget 100 → only B survives
    await start();
    expect(ids(menu())).toEqual(["a"]);

    insertLink("z", "head");
    setGeom(1000, { a: 100, b: 100, z: 100 });
    instance().update();

    expect(ids(items())).toEqual(["z", "a", "b"]);
  });

  it("keeps the corruption from being written back into the saved index", async () => {
    setup(MARKUP());
    setGeom(150, { a: 100, b: 100, c: 100 });
    await start();

    insertLink("z", "head");
    setGeom(1000, { a: 100, b: 100, c: 100, z: 100 });
    instance().update(); // all fit — canonical order is re-derived here

    // Re-bank, then restore again: #bank() burns the index into the item's attribute,
    // so a scrambled one would persist and widening alone would never heal it.
    setGeom(150, { a: 100, b: 100, c: 100, z: 100 });
    instance().update();
    setGeom(1000, { a: 100, b: 100, c: 100, z: 100 });
    instance().update();

    expect(ids(items())).toEqual(["z", "a", "b", "c"]);
  });

  it("appends a trailing insert after the banked items", async () => {
    setup(MARKUP());
    setGeom(150, { a: 100, b: 100, c: 100 });
    await start();

    insertLink("z", "tail"); // appended to the *bar*, which currently holds only A
    setGeom(1000, { a: 100, b: 100, c: 100, z: 100 });
    instance().update();

    // Appending to the bar means appending to the toolbar, so Z lands last; pinned
    // explicitly so the restore ordering cannot drift it.
    expect(ids(items())).toEqual(["a", "b", "c", "z"]);
  });

  it("accounts for the flex column-gap when measuring overflow", async () => {
    setup(MARKUP());
    // 3×100 items fit in 320 on their own, but 2×20px gaps push the row to 340 > 320,
    // so the lowest-priority item must overflow once the gap is counted. The gap is
    // authored inline rather than by replacing window.getComputedStyle, so the test
    // does not depend on happy-dom's CSSStyleDeclaration internals.
    items().style.columnGap = "20px";
    setGeom(320, { a: 100, b: 100, c: 100 });
    await start();
    expect(root().getAttribute("data-overflow-count")).toBe("1");
    expect(ids(menu())).toEqual(["c"]);
  });

  it("measures against the content box and reserves the bar's own gap", async () => {
    setup(MARKUP());
    root().style.paddingLeft = "20px";
    root().style.paddingRight = "20px";
    root().style.columnGap = "10px";
    // clientWidth counts the padding, so only 320 − 40 = 280 can hold items: the 300px
    // row overflows, and the budget also has to give up the bar's own 10px gap.
    setGeom(320, { a: 100, b: 100, c: 100 });
    await start();
    expect(root().getAttribute("data-overflow-count")).toBe("1");
    expect(ids(menu())).toEqual(["c"]);
  });

  it("falls back to a zero gap when getComputedStyle is unavailable", async () => {
    const real = window.getComputedStyle;
    Object.defineProperty(window, "getComputedStyle", { configurable: true, value: undefined });
    try {
      setup(MARKUP());
      setGeom(250, { a: 100, b: 100, c: 100 });
      await start();
      expect(root().getAttribute("data-overflow-count")).toBe("1");
    } finally {
      Object.defineProperty(window, "getComputedStyle", { configurable: true, value: real });
    }
  });

  it("gives banked items menuitem semantics and restores them on the way back", async () => {
    setup(MARKUP());
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    const c = query("#c");
    expect(c.getAttribute("role")).toBe("menuitem");
    expect(c.getAttribute("tabindex")).toBe("-1");
    expect(c.getAttribute("data-stimeo--menu-target")).toBe("item");

    setGeom(1000, { a: 100, b: 100, c: 100 }); // now everything fits again
    instance().update();
    expect(ids(items())).toEqual(["a", "b", "c"]);
    expect(c.hasAttribute("role")).toBe(false); // had no authored role → removed
    expect(c.hasAttribute("tabindex")).toBe(false);
    expect(c.hasAttribute("data-stimeo--menu-target")).toBe(false);
    expect(more().hidden).toBe(true);
  });

  it("drops the overflow marker and every item's bookkeeping once everything fits again", async () => {
    setup(MARKUP());
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    expect(root().getAttribute("data-overflowing")).toBe("true");
    expect(bookkeeping(query("#a"))).toEqual(["data-stimeo--overflow-menu-index"]);

    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();

    expect(root().hasAttribute("data-overflowing")).toBe(false);
    for (const id of ["a", "b", "c"]) expect(bookkeeping(query(`#${id}`)), id).toEqual([]);
  });

  it("preserves an item's authored role and tabindex across a round trip", async () => {
    setup(MARKUP());
    const c = query("#c");
    c.setAttribute("role", "button");
    c.setAttribute("tabindex", "0");
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    expect(c.getAttribute("role")).toBe("menuitem"); // overridden while banked

    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();
    expect(c.getAttribute("role")).toBe("button"); // authored value restored
    expect(c.getAttribute("tabindex")).toBe("0");
  });

  it("namespaces its bookkeeping and restores an authored menu target", async () => {
    setup(MARKUP());
    const c = query("#c");
    c.setAttribute("data-stimeo--menu-target", "spotlight"); // an authored token
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    expect(c.getAttribute("data-stimeo--menu-target")).toBe("item");
    expect(c.getAttribute("data-stimeo--overflow-menu-banked")).toBe("true");
    // Bookkeeping must not squat on the consumer's own `data-overflow-*` namespace.
    expect(c.getAttributeNames().some((name) => name.startsWith("data-overflow-"))).toBe(false);

    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();
    expect(c.getAttribute("data-stimeo--menu-target")).toBe("spotlight"); // authored restored
    expect(bookkeeping(c)).toEqual([]);
  });

  it("strips menu semantics from an item re-homed outside the controller", async () => {
    setup(MARKUP());
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    const c = query("#c");
    expect(c.getAttribute("role")).toBe("menuitem");

    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);
    elsewhere.appendChild(c); // the consumer moves a banked item away
    setGeom(1000, { a: 100, b: 100 });
    instance().update();

    expect(root().getAttribute("data-overflow-count")).toBe("0");
    expect(c.hasAttribute("role")).toBe(false);
    expect(c.hasAttribute("tabindex")).toBe(false);
    expect(bookkeeping(c)).toEqual([]);
  });

  it("strips the canonical index from a bar item re-homed outside the controller", async () => {
    setup(MARKUP());
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    const a = query("#a");
    expect(bookkeeping(a)).toEqual(["data-stimeo--overflow-menu-index"]);

    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);
    elsewhere.appendChild(a); // an item that was never banked, carrying its index
    setGeom(1000, { b: 100, c: 100 });
    instance().update();

    expect(bookkeeping(a)).toEqual([]);
  });

  it("emits change only when the overflow count transitions", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    const events: Array<{ overflowCount: number; total: number }> = [];
    root().addEventListener("stimeo--overflow-menu:change", (e) =>
      events.push((e as CustomEvent).detail),
    );
    await start(); // initial: 0 hidden → fires once
    setGeom(250, { a: 100, b: 100, c: 100 });
    instance().update(); // → 1 hidden
    instance().update(); // same geometry → no new event
    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update(); // → back to 0 hidden, which is a transition too
    expect(events).toEqual([
      { overflowCount: 0, total: 3 },
      { overflowCount: 1, total: 3 },
      { overflowCount: 0, total: 3 },
    ]);
  });

  it("adopts items appended to the bar before a later update", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();

    // Consumer appends a 4th item, then calls the update action.
    const d = document.createElement("a");
    d.id = "d";
    d.href = "#";
    d.textContent = "D";
    items().appendChild(d);

    setGeom(250, { a: 100, b: 100, c: 100, d: 100 }); // budget 200
    instance().update();
    expect(ids(items())).toEqual(["a", "b"]); // priority 1 & 2 kept
    expect(ids(menu())).toEqual(["c", "d"]); // both no-priority items banked, in order
    expect(root().getAttribute("data-overflow-count")).toBe("2");
  });

  it("drops items removed from the DOM from the managed set", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    query("#c").remove(); // consumer removes an item entirely
    setGeom(1000, { a: 100, b: 100 });
    instance().update();
    expect(root().getAttribute("data-overflow-count")).toBe("0");
    expect(ids(items())).toEqual(["a", "b"]); // c is gone, no stale reference
  });

  it("survives an emptied bar and a single remaining item", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();

    items().replaceChildren();
    instance().update();
    expect(root().getAttribute("data-overflow-count")).toBe("0");
    expect(more().hidden).toBe(true);

    const solo = document.createElement("a");
    solo.id = "solo";
    solo.href = "#";
    solo.textContent = "S";
    items().appendChild(solo);
    stub(solo, "offsetWidth", 100);
    instance().update();
    expect(ids(items())).toEqual(["solo"]);
    expect(root().getAttribute("data-overflow-count")).toBe("0");

    stub(root(), "clientWidth", 20); // not even one item fits
    instance().update();
    expect(ids(menu())).toEqual(["solo"]);
    expect(root().getAttribute("data-overflow-count")).toBe("1");
  });

  it("does nothing when a required target is missing", async () => {
    setup(`
      <div id="om" data-controller="stimeo--overflow-menu" role="toolbar" aria-label="Actions">
        <div data-stimeo--overflow-menu-target="items"><a id="a" href="#">A</a></div>
      </div>`);
    await start();
    expect(root().hasAttribute("data-overflow-count")).toBe(false);
    expect(() => instance().update()).not.toThrow();
    expect(() => instance().disconnect()).not.toThrow();
    expect(root().hasAttribute("data-overflow-count")).toBe(false);
  });

  it("keeps two instances on the page independent", async () => {
    setup(`${MARKUP()}${MARKUP("More", "s")}`);
    const second = query("#som");
    setGeom(1000, { a: 100, b: 100, c: 100 });
    setGeomIn(second, 250, { sa: 100, sb: 100, sc: 100 });
    await start();

    expect(root().getAttribute("data-overflow-count")).toBe("0");
    expect(second.getAttribute("data-overflow-count")).toBe("1");
    expect(ids(query("[data-stimeo--menu-target='menu']", second))).toEqual(["sc"]);
  });

  it("re-measures on a debounced viewport resize", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    expect(root().getAttribute("data-overflow-count")).toBe("0");

    setGeom(250, { a: 100, b: 100, c: 100 });
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(99);
    expect(root().getAttribute("data-overflow-count")).toBe("0"); // still debouncing
    vi.advanceTimersByTime(1);
    expect(root().getAttribute("data-overflow-count")).toBe("1");
  });

  it("restarts the debounce on every resize of a burst", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();

    setGeom(250, { a: 100, b: 100, c: 100 });
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(60);
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(60);
    expect(root().getAttribute("data-overflow-count")).toBe("0"); // 60 ms after the last one
    vi.advanceTimersByTime(40);
    expect(root().getAttribute("data-overflow-count")).toBe("1");
  });

  it("re-measures on a debounced resize of its own box", async () => {
    const observed: Array<{ target: Element; notify: () => void }> = [];
    class RecordingResizeObserver implements ResizeObserver {
      readonly #callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.#callback = callback;
      }
      observe(target: Element): void {
        observed.push({ target, notify: () => this.#callback([], this) });
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", RecordingResizeObserver);
    try {
      setup(MARKUP());
      setGeom(1000, { a: 100, b: 100, c: 100 });
      await start();

      setGeom(250, { a: 100, b: 100, c: 100 });
      for (const entry of observed) if (entry.target === root()) entry.notify();
      vi.advanceTimersByTime(99);
      expect(root().getAttribute("data-overflow-count")).toBe("0");
      vi.advanceTimersByTime(1);
      expect(root().getAttribute("data-overflow-count")).toBe("1");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a scheduled re-measure's deadline and reads a changed debounce at the next resize", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    const changes: number[] = [];
    root().addEventListener("stimeo--overflow-menu:change", (event) => {
      changes.push((event as CustomEvent<{ overflowCount: number }>).detail.overflowCount);
    });

    setGeom(250, { a: 100, b: 100, c: 100 });
    window.dispatchEvent(new Event("resize"));
    root().setAttribute("data-stimeo--overflow-menu-debounce-value", "500");
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(99);
    expect(root().getAttribute("data-overflow-count")).toBe("0");
    vi.advanceTimersByTime(1);
    expect(root().getAttribute("data-overflow-count")).toBe("1");

    // The next resize reads the declaration as it is now.
    setGeom(1000, { a: 100, b: 100, c: 100 });
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(499);
    expect(root().getAttribute("data-overflow-count")).toBe("1");
    vi.advanceTimersByTime(1);
    expect(root().getAttribute("data-overflow-count")).toBe("0");
    expect(changes).toEqual([1, 0]);
  });

  it("measures and schedules nothing when only the debounce changes", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    const changes: number[] = [];
    root().addEventListener("stimeo--overflow-menu:change", (event) => {
      changes.push((event as CustomEvent<{ overflowCount: number }>).detail.overflowCount);
    });

    setGeom(250, { a: 100, b: 100, c: 100 });
    root().setAttribute("data-stimeo--overflow-menu-debounce-value", "10");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(root().getAttribute("data-overflow-count")).toBe("0");
    expect(changes).toEqual([]);
  });

  it("fills an empty More trigger with the moreLabel value", async () => {
    setup(MARKUP("")); // empty trigger text
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    expect(trigger().textContent).toBe("More");
  });

  it("never overwrites an authored More trigger label", async () => {
    setup(MARKUP("Actions"));
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    expect(trigger().textContent).toBe("Actions");
  });

  it("honors authored moreLabel and debounce values", async () => {
    setup(
      MARKUP("").replace(
        'data-controller="stimeo--overflow-menu"',
        'data-controller="stimeo--overflow-menu"' +
          ' data-stimeo--overflow-menu-more-label-value="Mehr"' +
          ' data-stimeo--overflow-menu-debounce-value="250"',
      ),
    );
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    expect(trigger().textContent).toBe("Mehr");

    setGeom(250, { a: 100, b: 100, c: 100 });
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(249);
    expect(root().getAttribute("data-overflow-count")).toBe("0"); // the default 100 passed
    vi.advanceTimersByTime(1);
    expect(root().getAttribute("data-overflow-count")).toBe("1");
  });

  it("moves focus to the More trigger when the focused item retreats", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    const c = query("#c") as HTMLAnchorElement;
    c.focus();
    expect(document.activeElement).toBe(c);

    setGeom(250, { a: 100, b: 100, c: 100 });
    instance().update();
    // C (the same node) retreats into the menu; were it left there, focus would be
    // dropped (it is hidden in a collapsed menu in a real browser), so the controller
    // redirects focus to the visible More trigger.
    expect(c.parentElement).toBe(menu());
    expect(document.activeElement).toBe(trigger());
  });

  it("rescues focus from a descendant of the retreating item", async () => {
    setup(`
      <div id="om" data-controller="stimeo--overflow-menu" role="toolbar" aria-label="Actions">
        <div data-stimeo--overflow-menu-target="items">
          <a id="a" href="#" data-priority="1">A</a>
          <a id="b" href="#" data-priority="2">B</a>
          <span id="c"><button type="button" id="c-inner">C</button></span>
        </div>
        <div data-stimeo--overflow-menu-target="more" hidden>
          <button id="more-trigger" data-stimeo--menu-target="trigger">More</button>
          <div role="menu" aria-labelledby="more-trigger" data-stimeo--menu-target="menu"></div>
        </div>
      </div>`);
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    query("#c-inner").focus();

    setGeom(250, { a: 100, b: 100, c: 100 });
    instance().update();
    // The focus holder is inside the item that retreats, so it goes down with it.
    expect(document.activeElement).toBe(trigger());
  });

  it("keeps the canonical order when a focus handler re-measures during a retreat", async () => {
    // y sits between x and z and drops first. It holds focus, so the pass moves focus
    // to the trigger, and a consumer that re-measures on focusin re-enters the pass
    // after y was banked but before the pass finished.
    setup(`
      <div id="om" data-controller="stimeo--overflow-menu" role="toolbar" aria-label="Actions">
        <div data-stimeo--overflow-menu-target="items">
          <a id="x" href="#" data-priority="1">X</a>
          <a id="y" href="#">Y</a>
          <a id="z" href="#" data-priority="2">Z</a>
        </div>
        <div data-stimeo--overflow-menu-target="more" hidden>
          <button id="more-trigger" data-stimeo--menu-target="trigger">More</button>
          <div role="menu" aria-labelledby="more-trigger" data-stimeo--menu-target="menu"></div>
        </div>
      </div>`);
    setGeom(1000, { x: 100, y: 100, z: 100 });
    await start();
    query("#y").focus();
    let reentered = false;
    root().addEventListener("focusin", () => {
      if (reentered) return;
      reentered = true;
      instance().update();
    });

    setGeom(250, { x: 100, y: 100, z: 100 });
    instance().update();
    expect(reentered).toBe(true);
    expect(ids(menu())).toEqual(["y"]);

    setGeom(1000, { x: 100, y: 100, z: 100 });
    instance().update();
    expect(ids(items())).toEqual(["x", "y", "z"]);
  });

  it("publishes the pass a focus handler starts during a retreat", async () => {
    // y drops first and holds focus, so the pass moves focus to the trigger before it
    // publishes. The focusin handler narrows the bar and re-measures: that pass banks
    // every item and publishes, and the interrupted pass has nothing left to write.
    setup(`
      <div id="om" data-controller="stimeo--overflow-menu" role="toolbar" aria-label="Actions">
        <div data-stimeo--overflow-menu-target="items">
          <a id="x" href="#" data-priority="1">X</a>
          <a id="y" href="#">Y</a>
          <a id="z" href="#" data-priority="2">Z</a>
        </div>
        <div data-stimeo--overflow-menu-target="more" hidden>
          <button id="more-trigger" data-stimeo--menu-target="trigger">More</button>
          <div role="menu" aria-labelledby="more-trigger" data-stimeo--menu-target="menu"></div>
        </div>
      </div>`);
    setGeom(1000, { x: 100, y: 100, z: 100 });
    await start();
    query("#y").focus();
    const events: Array<{ overflowCount: number; total: number }> = [];
    root().addEventListener("stimeo--overflow-menu:change", (e) =>
      events.push((e as CustomEvent).detail),
    );
    let reentered = false;
    root().addEventListener("focusin", () => {
      if (reentered) return;
      reentered = true;
      setGeom(40, { x: 100, y: 100, z: 100 });
      instance().update();
    });

    setGeom(250, { x: 100, y: 100, z: 100 });
    instance().update();

    expect(reentered).toBe(true);
    expect(ids(items())).toEqual([]);
    expect(ids(menu())).toEqual(["x", "y", "z"]);
    expect(root().getAttribute("data-overflow-count")).toBe("3");
    expect(events).toEqual([{ overflowCount: 3, total: 3 }]);
    expect(items().querySelectorAll("template")).toHaveLength(1);
  });

  it("keeps More revealed when a focus handler re-banks an item during the rescue", async () => {
    // The last banked item returns while focus is on the trigger, so the pass hands
    // focus to the last item before it hides More. The focusin handler narrows the
    // bar and re-measures: that pass banks c again, and More has to stay reachable.
    setup(MARKUP());
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    trigger().focus();
    const events: Array<{ overflowCount: number; total: number }> = [];
    root().addEventListener("stimeo--overflow-menu:change", (e) =>
      events.push((e as CustomEvent).detail),
    );
    let reentered = false;
    query("#c").addEventListener("focusin", () => {
      if (reentered) return;
      reentered = true;
      setGeom(250, { a: 100, b: 100, c: 100 });
      instance().update();
    });

    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();

    expect(reentered).toBe(true);
    expect(ids(menu())).toEqual(["c"]);
    expect(more().hidden).toBe(false);
    expect(document.activeElement).toBe(trigger());
    expect(root().getAttribute("data-overflow-count")).toBe("1");
    expect(events).toEqual([]);
  });

  it("leaves focus and More alone when a Menu close handler re-banks an item", async () => {
    // Every item fits again, so the pass closes the expanded Menu before it rescues
    // focus from the trigger and hides More. A close handler narrows the bar and
    // re-measures: that pass banks c again, so the trigger keeps focus and More stays.
    setup(COMPOSED_MARKUP);
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start(["stimeo--menu", MenuController]);
    trigger().focus();
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    trigger().focus();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const events: Array<{ overflowCount: number; total: number }> = [];
    root().addEventListener("stimeo--overflow-menu:change", (e) =>
      events.push((e as CustomEvent).detail),
    );
    let reentered = false;
    more().addEventListener("stimeo--menu:close", () => {
      if (reentered) return;
      reentered = true;
      setGeom(250, { a: 100, b: 100, c: 100 });
      instance().update();
    });

    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();

    expect(reentered).toBe(true);
    expect(ids(menu())).toEqual(["c"]);
    expect(more().hidden).toBe(false);
    expect(document.activeElement).toBe(trigger());
    expect(root().getAttribute("data-overflow-count")).toBe("1");
    expect(events).toEqual([]);
  });

  it("returns every item to the bar when a Menu close handler re-measures during disconnect", async () => {
    setup(COMPOSED_MARKUP);
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start(["stimeo--menu", MenuController]);
    trigger().focus();
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    trigger().focus();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const controller = instance();
    let reentered = false;
    more().addEventListener("stimeo--menu:close", () => {
      if (reentered) return;
      reentered = true;
      controller.update();
    });

    controller.disconnect();

    expect(reentered).toBe(true);
    expect(ids(items())).toEqual(["a", "b", "c"]);
    expect(ids(menu())).toEqual([]);
    expect(more().hidden).toBe(true);
  });

  it("runs no pass until the outer restore ends when a close handler restores again", async () => {
    setup(COMPOSED_MARKUP);
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start(["stimeo--menu", MenuController]);
    trigger().focus();
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const controller = instance();
    let closes = 0;
    more().addEventListener("stimeo--menu:close", () => {
      closes += 1;
      if (closes > 1) return;
      controller.disconnect();
      controller.update();
    });

    controller.disconnect();

    expect(closes).toBe(1);
    expect(ids(items())).toEqual(["a", "b", "c"]);
    expect(ids(menu())).toEqual([]);
    expect(more().hidden).toBe(true);
  });

  it("writes nothing more when a focus handler disconnects it during a retreat", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    const controller = instance();
    query("#c").focus();
    const events: Array<{ overflowCount: number; total: number }> = [];
    root().addEventListener("stimeo--overflow-menu:change", (e) =>
      events.push((e as CustomEvent).detail),
    );
    let reentered = false;
    root().addEventListener("focusin", () => {
      if (reentered) return;
      reentered = true;
      controller.disconnect();
    });

    setGeom(250, { a: 100, b: 100, c: 100 });
    controller.update();

    expect(reentered).toBe(true);
    expect(ids(items())).toEqual(["a", "b", "c"]);
    for (const id of ["a", "b", "c"]) expect(bookkeeping(query(`#${id}`))).toEqual([]);
    expect(more().hidden).toBe(true);
    expect(root().hasAttribute("data-overflowing")).toBe(false);
    expect(root().hasAttribute("data-overflow-count")).toBe(false);
    expect(events).toEqual([]);
  });

  it("moves no node when a re-measure changes nothing", async () => {
    setup(MARKUP());
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    const barInsert = vi.spyOn(items(), "insertBefore");
    const barAppend = vi.spyOn(items(), "appendChild");
    const menuInsert = vi.spyOn(menu(), "insertBefore");
    const menuAppend = vi.spyOn(menu(), "appendChild");

    instance().update(); // identical geometry → the DOM is already correct

    // Re-homing an already-correct node removes it first, which blurs it in a real
    // browser and would drop focus to `<body>` on any resize.
    expect(barInsert).not.toHaveBeenCalled();
    expect(barAppend).not.toHaveBeenCalled();
    expect(menuInsert).not.toHaveBeenCalled();
    expect(menuAppend).not.toHaveBeenCalled();
  });

  it("leaves focus alone while the More menu is expanded", async () => {
    setup(MARKUP());
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    trigger().setAttribute("aria-expanded", "true"); // Menu opened it
    const c = query("#c");
    c.focus();

    instance().update(); // a resize that changes nothing about the overflow
    expect(document.activeElement).toBe(c); // still on the item the user is arrowing over
  });

  it("does not pull focus out of an expanded menu when another item retreats", async () => {
    setup(MARKUP());
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    trigger().setAttribute("aria-expanded", "true");
    const b = query("#b");
    b.focus();

    setGeom(150, { a: 100, b: 100, c: 100 }); // B retreats too, but stays visible
    instance().update();
    expect(b.parentElement).toBe(menu());
    expect(document.activeElement).toBe(b);
  });

  it("collapses the menu and rescues focus when the last banked item returns", async () => {
    setup(MARKUP());
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    trigger().setAttribute("aria-expanded", "true");
    trigger().focus();

    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();

    expect(more().hidden).toBe(true);
    // Without the collapse, the next overflow would re-reveal an already-open menu.
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(query("#c")); // not stranded in a hidden wrapper
  });

  it("skips items under a hidden ancestor when rescuing focus", async () => {
    // The mirror of the disabled-fieldset case: the row itself is hidden, so every
    // item is unfocusable while its own `hidden` attribute stays absent. Reading
    // only the item's own attribute hands focus into an invisible subtree — the
    // failure this rescue exists to prevent — and the rule `#lostFocus` applies on
    // the re-insert path.
    setup(MARKUP().replace('target="items"', 'target="items" hidden'));
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    expect(ids(menu())).toEqual(["c"]);
    trigger().focus();

    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();

    expect(ids(items())).toEqual(["a", "b", "c"]);
    expect(root().getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(root()); // not #c, which is invisible
  });

  it("re-adopts banked items when a fresh controller connects to overflowed markup", async () => {
    setup(MARKUP());
    setGeom(150, { a: 100, b: 100, c: 100 });
    await start();
    expect(ids(menu())).toEqual(["b", "c"]);

    // A morph, a clone, or server-rendered overflow hands a *new* controller a DOM that
    // already holds banked items. Snapshot the live DOM (no teardown, which would undo
    // the banking) and connect a fresh instance to it.
    const snapshot = root().outerHTML;
    disconnectAndStopApplication(application); // tears the old instance down for real
    document.body.innerHTML = snapshot;
    setGeom(150, { a: 100, b: 100, c: 100 });
    await start();

    expect(ids(items())).toEqual(["a"]);
    expect(ids(menu())).toEqual(["b", "c"]); // re-adopted, not orphaned
    expect(more().hidden).toBe(false); // and still reachable
    expect(root().getAttribute("data-overflow-count")).toBe("2");

    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();
    expect(ids(items())).toEqual(["a", "b", "c"]); // canonical order survived the trip
    expect(more().hidden).toBe(true);
  });

  it("restores the canonical order when adopted banked items are listed out of order", async () => {
    setup(MARKUP());
    setGeom(150, { a: 100, b: 100, c: 100 });
    await start();
    expect(ids(menu())).toEqual(["b", "c"]);

    const snapshot = root().outerHTML;
    disconnectAndStopApplication(application);
    document.body.innerHTML = snapshot;
    menu().append(query("#b")); // markup that lists the banked items as C, B
    expect(ids(menu())).toEqual(["c", "b"]);
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();

    expect(ids(items())).toEqual(["a", "b", "c"]);
  });

  it("measures adopted banked items without the menu semantics they carry", async () => {
    // Consumer styling can size a menu row unlike a bar item, so a banked item is
    // measured only once it is back in the bar as the item it was authored as.
    setup(MARKUP());
    setGeom(150, { a: 100, b: 100, c: 100 });
    await start();
    expect(ids(menu())).toEqual(["b", "c"]);

    const snapshot = root().outerHTML;
    disconnectAndStopApplication(application);
    document.body.innerHTML = snapshot;
    stub(root(), "clientWidth", 250);
    for (const id of ["a", "b", "c"]) {
      const el = query(`#${id}`);
      Object.defineProperty(el, "offsetWidth", {
        configurable: true,
        get: () => (el.getAttribute("role") === "menuitem" ? 300 : 100),
      });
    }
    stub(trigger(), "offsetWidth", 50);
    await start();

    expect(ids(items())).toEqual(["a", "b"]);
    expect(ids(menu())).toEqual(["c"]);
  });

  it("measures adopted banked items in the bar, not inside the closed menu", async () => {
    // The constant width stub the other cases use is location-independent, which
    // is exactly what a real engine is not: a banked item sits in the closed menu
    // and has no box at all. Measured there it reads as zero, the budget says
    // everything fits, and the whole bar un-overflows on first paint.
    const laidOutWidth = (el: HTMLElement, value: number) =>
      Object.defineProperty(el, "offsetWidth", {
        configurable: true,
        get: () => (el.closest("[hidden]") === null ? value : 0),
      });

    setup(COMPOSED_MARKUP);
    setGeom(150, { a: 100, b: 100, c: 100 });
    await start(["stimeo--menu", MenuController]);
    expect(ids(menu())).toEqual(["b", "c"]);

    const snapshot = root().outerHTML;
    disconnectAndStopApplication(application);
    document.body.innerHTML = snapshot;
    stub(root(), "clientWidth", 150);
    for (const id of ["a", "b", "c"]) laidOutWidth(query(`#${id}`), 100);
    laidOutWidth(trigger(), 50);
    await start(["stimeo--menu", MenuController]);

    expect(ids(items())).toEqual(["a"]);
    expect(ids(menu())).toEqual(["b", "c"]);
    expect(more().hidden).toBe(false);
    expect(root().getAttribute("data-overflow-count")).toBe("2");
  });

  it("keeps a head insert first when a fresh controller adopts banked items", async () => {
    setup(MARKUP());
    setGeom(150, { a: 100, b: 100, c: 100 });
    await start();
    expect(ids(menu())).toEqual(["b", "c"]);

    const snapshot = root().outerHTML;
    disconnectAndStopApplication(application);
    document.body.innerHTML = snapshot;
    const z = document.createElement("a");
    z.id = "z";
    z.href = "#";
    z.textContent = "Z";
    z.setAttribute("data-priority", "1");
    items().insertBefore(z, items().firstElementChild);
    setGeom(1000, { a: 100, b: 100, c: 100, z: 100 });

    await start();

    expect(ids(items())).toEqual(["z", "a", "b", "c"]);
  });

  it("keeps a head insert first when a fresh controller adopts a fully banked bar", async () => {
    setup(MARKUP());
    setGeom(50, { a: 100, b: 100, c: 100 });
    await start();
    expect(ids(items())).toEqual([]);
    expect(ids(menu())).toEqual(["a", "b", "c"]);
    expect(items().querySelector("[data-stimeo--overflow-menu-boundary]")).not.toBeNull();

    const snapshot = root().outerHTML;
    disconnectAndStopApplication(application);
    document.body.innerHTML = snapshot;
    const z = document.createElement("a");
    z.id = "z";
    z.href = "#";
    z.textContent = "Z";
    z.setAttribute("data-priority", "1");
    items().prepend(z);
    setGeom(1000, { a: 100, b: 100, c: 100, z: 100 });

    await start();

    expect(ids(items())).toEqual(["z", "a", "b", "c"]);
  });

  it("moves no bar item already in place when a fresh controller adopts a fully banked bar", async () => {
    setup(MARKUP());
    setGeom(50, { a: 100, b: 100, c: 100 });
    await start();
    expect(ids(menu())).toEqual(["a", "b", "c"]);

    const snapshot = root().outerHTML;
    disconnectAndStopApplication(application);
    document.body.innerHTML = snapshot;
    const z = insertLink("z", "head");
    setGeom(1000, { a: 100, b: 100, c: 100, z: 100 });
    const insert = vi.spyOn(items(), "insertBefore");
    try {
      await start();

      expect(ids(items())).toEqual(["z", "a", "b", "c"]);
      // Z already leads the bar; re-inserting it would blur it in a real browser.
      expect(insert.mock.calls.filter(([node]) => node === z)).toEqual([]);
    } finally {
      insert.mockRestore();
    }
  });

  it("keeps a trailing append last when a fresh controller adopts a fully banked bar", async () => {
    setup(MARKUP());
    setGeom(50, { a: 100, b: 100, c: 100 });
    await start();
    expect(ids(items())).toEqual([]);
    expect(ids(menu())).toEqual(["a", "b", "c"]);

    const snapshot = root().outerHTML;
    disconnectAndStopApplication(application);
    document.body.innerHTML = snapshot;
    const z = document.createElement("a");
    z.id = "z";
    z.href = "#";
    z.textContent = "Z";
    z.setAttribute("data-priority", "1");
    items().append(z);
    setGeom(1000, { a: 100, b: 100, c: 100, z: 100 });

    await start();

    expect(ids(items())).toEqual(["a", "b", "c", "z"]);
  });

  it("hands back a pristine DOM on disconnect", async () => {
    setup(MARKUP());
    setGeom(50, { a: 100, b: 100, c: 100 });
    await start();
    expect(ids(menu())).toEqual(["a", "b", "c"]);
    expect(items().querySelector("[data-stimeo--overflow-menu-boundary]")).not.toBeNull();

    instance().disconnect();

    expect(ids(items())).toEqual(["a", "b", "c"]);
    expect(ids(menu())).toEqual([]);
    expect(more().hidden).toBe(true);
    expect(root().hasAttribute("data-overflowing")).toBe(false);
    expect(root().hasAttribute("data-overflow-count")).toBe(false);
    expect(root().querySelector("[data-stimeo--overflow-menu-boundary]")).toBeNull();
    expect(query("#c").hasAttribute("role")).toBe(false);
    expect(bookkeeping(query("#c"))).toEqual([]);
  });

  it("strips the canonical index from the items that stayed in the bar on disconnect", async () => {
    setup(MARKUP());
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    expect(bookkeeping(query("#a"))).toEqual(["data-stimeo--overflow-menu-index"]);

    instance().disconnect();

    for (const id of ["a", "b", "c"]) expect(bookkeeping(query(`#${id}`)), id).toEqual([]);
  });

  it("leaves a banked item the consumer moved elsewhere in place on disconnect", async () => {
    setup(MARKUP());
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    const c = query("#c");
    expect(c.parentElement).toBe(menu());

    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);
    elsewhere.appendChild(c);
    instance().disconnect();

    expect(c.parentElement).toBe(elsewhere);
    expect(ids(items())).toEqual(["a", "b"]);
    expect(c.hasAttribute("role")).toBe(false);
    expect(bookkeeping(c)).toEqual([]);
  });

  it("keeps the bar balanced through turbo:before-cache, which Turbo also dispatches on pages that stay", async () => {
    setup(MARKUP());
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    expect(ids(menu())).toEqual(["c"]);
    const observer = new MutationObserver(() => {});
    observer.observe(root(), { attributes: true, childList: true, subtree: true });

    document.dispatchEvent(new Event("turbo:before-cache"));
    const records = observer.takeRecords();
    observer.disconnect();

    expect(records).toEqual([]);
    expect(ids(menu())).toEqual(["c"]);
    expect(more().hidden).toBe(false);
    expect(root().getAttribute("data-overflow-count")).toBe("1");
  });

  it("stops re-measuring after disconnect", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    const controller = instance();
    const update = vi.spyOn(controller, "update");

    controller.disconnect();
    update.mockClear();
    const settled = root().getAttribute("data-overflow-count");

    setGeom(150, { a: 100, b: 100, c: 100 }); // a geometry that *would* bank two items
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(500);

    expect(update).not.toHaveBeenCalled();
    expect(root().getAttribute("data-overflow-count")).toBe(settled);
    expect(ids(menu())).toEqual([]);
  });

  it("cancels a pending re-measure on disconnect", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();

    setGeom(150, { a: 100, b: 100, c: 100 }); // a geometry that *would* bank two items
    window.dispatchEvent(new Event("resize")); // schedules the debounced pass
    instance().disconnect();
    vi.advanceTimersByTime(500);

    expect(ids(menu())).toEqual([]);
    expect(root().hasAttribute("data-overflow-count")).toBe(false);
  });

  it("lets the keyboard reach banked items through the composed Menu", async () => {
    setup(COMPOSED_MARKUP);
    setGeom(150, { a: 100, b: 100, c: 100 }); // budget 100 → B and C are banked
    await start(["stimeo--menu", MenuController]);
    expect(ids(menu())).toEqual(["b", "c"]);

    // The central contract: this controller adds no keyboard behavior of its own — the
    // banked items must be operable purely because Menu now owns them.
    trigger().focus();
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(menu().hidden).toBe(false);
    expect(document.activeElement).toBe(query("#b")); // first banked item

    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(query("#c")); // last banked item
  });

  it("has no a11y violations with items banked into the menu", async () => {
    vi.useRealTimers();
    document.body.innerHTML = MARKUP();
    setGeom(150, { a: 100, b: 100, c: 100 }); // budget 100 → B and C are banked
    application = Application.start();
    application.register("stimeo--overflow-menu", OverflowMenuController);
    await tick();
    expect(ids(menu())).toEqual(["b", "c"]); // the state under test really exists
    await expectNoA11yViolations(root());
  });

  it("has no a11y violations with nothing banked and More hidden", async () => {
    vi.useRealTimers();
    document.body.innerHTML = MARKUP();
    setGeom(1000, { a: 100, b: 100, c: 100 });
    application = Application.start();
    application.register("stimeo--overflow-menu", OverflowMenuController);
    await tick();
    expect(more().hidden).toBe(true);
    await expectNoA11yViolations(root());
  });

  // Items banked into the overflow menu are announced as the menu's contents.
  it("announces the banked items inside the overflow menu", async () => {
    setup(MARKUP());
    setGeom(150, { a: 100, b: 100, c: 100 }); // budget 100 → only A stays in the bar
    await start();
    expect(ids(menu())).toEqual(["b", "c"]);
    // The virtual SR awaits real microtasks, so capture on the real clock.
    vi.useRealTimers();
    const speech = await captureSpeech({ container: menu(), steps: 2 });
    expect(speech).toEqual([
      "menu, More, orientated vertically",
      "menuitem, B, position 1, set size 2",
      "menuitem, C, position 2, set size 2",
    ]);
  });

  // ---- A partial restore must not strand an expanded menu ----

  it("collapses the menu when the focused item returns to the bar mid-overflow", async () => {
    setup(COMPOSED_MARKUP);
    setGeom(150, { a: 100, b: 100, c: 100 }); // budget 100 → B and C are banked
    await start(["stimeo--menu", MenuController]);
    trigger().focus();
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const b = query("#b");
    expect(document.activeElement).toBe(b);

    setGeom(250, { a: 100, b: 100, c: 100 }); // budget 200 → only C stays banked
    instance().update();

    expect(b.parentElement).toBe(items()); // B is back in the bar…
    expect(document.activeElement).toBe(b); // …still holding focus, not the trigger
    // Outside the wrapper nothing owns the open menu: it must not be left open.
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(menu().hidden).toBe(true);
    expect(more().hidden).toBe(false); // C is still banked, so More stays available
    expect(ids(menu())).toEqual(["c"]);
  });

  it("keeps the menu open when the focused item was already in the bar", async () => {
    setup(COMPOSED_MARKUP);
    setGeom(250, { a: 100, b: 100, c: 100 }); // budget 200 → only C is banked
    await start(["stimeo--menu", MenuController]);
    trigger().focus();
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const a = query("#a");
    a.focus(); // the user tabbed back out to a bar item, leaving the menu open

    instance().update(); // a pass that moves nothing

    // Only an item *leaving* the menu takes its owner away; one that never was in it
    // must not close anything.
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(menu().hidden).toBe(false);
    expect(document.activeElement).toBe(a);
  });

  it("keeps the menu open when a partial restore does not move the focused item", async () => {
    setup(COMPOSED_MARKUP);
    setGeom(150, { a: 100, b: 100, c: 100 });
    await start(["stimeo--menu", MenuController]);
    trigger().focus();
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    const c = query("#c");
    expect(document.activeElement).toBe(c); // focus is on the item that *stays* banked

    setGeom(250, { a: 100, b: 100, c: 100 }); // B returns, C does not
    instance().update();

    // The user is still arrowing through the menu, so the rebalance leaves it open.
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(menu().hidden).toBe(false);
    expect(document.activeElement).toBe(c);
  });

  // ---- The rescue target has to be able to take focus ----

  it("rescues focus past a trailing item that cannot take it", async () => {
    setup(BUTTON_MARKUP);
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    expect(ids(menu())).toEqual(["c"]);
    (query("#c") as HTMLButtonElement).disabled = true;
    trigger().focus();

    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();

    expect(more().hidden).toBe(true);
    expect(document.activeElement).toBe(query("#b")); // not the disabled last item
  });

  it("skips a trailing hidden item when rescuing focus", async () => {
    setup(BUTTON_MARKUP);
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    query("#c").hidden = true;
    trigger().focus();

    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();

    expect(document.activeElement).toBe(query("#b"));
  });

  it("hands the rescue to an aria-disabled trailing item", async () => {
    setup(BUTTON_MARKUP);
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    // aria-disabled stays discoverable, so it is still a valid place to leave
    // focus — only `hidden` and native `disabled` are skipped.
    query("#c").setAttribute("aria-disabled", "true");
    trigger().focus();

    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();

    expect(document.activeElement).toBe(query("#c"));
  });

  it("skips controls disabled by an ancestor fieldset when rescuing focus", async () => {
    setup(FIELDSET_MARKUP("button"));
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    trigger().focus();

    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();

    // Every button inherits the fieldset's disabled state, so none can hold focus even
    // though each one's own `disabled` property is false. The root takes it instead.
    expect(root().getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(root());
  });

  it("keeps items inside a disabled fieldset's first legend eligible for the rescue", async () => {
    // The reachable shape: the widget itself sits in the legend. (An item cannot be a
    // legend's child — managed items are direct children of the items target — so the
    // exemption only ever arrives through an ancestor.) HTML exempts a first legend's
    // descendants from the fieldset's disabledness, so these buttons really can hold
    // focus and skipping them would send the rescue past a usable target to the root.
    setup(`
      <fieldset disabled>
        <legend>${BUTTON_MARKUP}</legend>
      </fieldset>`);
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    trigger().focus();

    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();

    expect(document.activeElement).toBe(query("#c"));
    expect(root().hasAttribute("tabindex")).toBe(false);
  });

  it("still excludes items an outer fieldset disables through the legend", async () => {
    // Escaping the nearest fieldset is not escaping all of them.
    setup(`
      <fieldset disabled>
        <fieldset disabled>
          <legend>${BUTTON_MARKUP}</legend>
        </fieldset>
      </fieldset>`);
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    trigger().focus();

    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();

    expect(root().getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(root());
  });

  it("keeps links inside a disabled fieldset eligible for the rescue", async () => {
    setup(FIELDSET_MARKUP("a"));
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    trigger().focus();

    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();

    // HTML's inherited disabled state reaches form controls only, so a link inside
    // a disabled fieldset is still focusable and still a valid rescue target.
    expect(document.activeElement).toBe(query("#c"));
    expect(root().hasAttribute("tabindex")).toBe(false);
  });

  it("keeps focus inside the root when no item can take it, and gives the tab stop back", async () => {
    setup(BUTTON_MARKUP);
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    for (const id of ["a", "b", "c"]) (query(`#${id}`) as HTMLButtonElement).disabled = true;
    trigger().focus();

    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();

    expect(root().getAttribute("tabindex")).toBe("-1"); // borrowed just-in-time
    expect(document.activeElement).toBe(root()); // not dropped to <body>

    instance().disconnect();
    expect(root().hasAttribute("tabindex")).toBe(false);
  });

  it("gives back the tab stop a page restored from the cache carries", async () => {
    setup(BUTTON_MARKUP);
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    for (const id of ["a", "b", "c"]) (query(`#${id}`) as HTMLButtonElement).disabled = true;
    trigger().focus();
    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();
    expect(root().getAttribute("tabindex")).toBe("-1");

    application = await restoreFromCache(
      application,
      (restored) => restored.register("stimeo--overflow-menu", OverflowMenuController),
      () => vi.advanceTimersByTimeAsync(0),
    );

    expect(root().hasAttribute("tabindex")).toBe(false);
    expect(
      root()
        .getAttributeNames()
        .filter((name) => name.endsWith("-loan")),
    ).toEqual([]);
  });

  it("keeps a root tabindex the consumer changed after the loan", async () => {
    // The other half of the ownership rule: the borrow flag alone must not
    // authorize the removal. A consumer that made the bar its own Tab stop after
    // the loan owns the value.
    setup(BUTTON_MARKUP);
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    for (const id of ["a", "b", "c"]) (query(`#${id}`) as HTMLButtonElement).disabled = true;
    trigger().focus();

    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();
    expect(root().getAttribute("tabindex")).toBe("-1"); // lent

    root().setAttribute("tabindex", "0"); // consumer takes ownership
    instance().disconnect();

    expect(root().getAttribute("tabindex")).toBe("0");
  });

  it("never removes a tabindex the author wrote on the root", async () => {
    setup(BUTTON_MARKUP.replace('role="toolbar"', 'role="toolbar" tabindex="0"'));
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    for (const id of ["a", "b", "c"]) (query(`#${id}`) as HTMLButtonElement).disabled = true;
    trigger().focus();

    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();
    instance().disconnect();

    expect(root().getAttribute("tabindex")).toBe("0");
  });

  // ---- The restore path owns the composed menu's state too ----

  it("keeps an expanded menu open through turbo:before-cache", async () => {
    setup(COMPOSED_MARKUP);
    setGeom(150, { a: 100, b: 100, c: 100 });
    await start(["stimeo--menu", MenuController]);
    trigger().focus();
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(menu().hidden).toBe(false);
    expect(ids(menu())).toEqual(["b", "c"]);
    expect(more().hidden).toBe(false);
  });

  it("collapses an expanded menu when only this controller disconnects", async () => {
    setup(COMPOSED_MARKUP);
    setGeom(150, { a: 100, b: 100, c: 100 });
    await start(["stimeo--menu", MenuController]);
    trigger().focus();
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    instance().disconnect(); // Menu stays mounted; Overflow alone goes away

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(menu().hidden).toBe(true);
  });

  // ---- An authored `hidden` item is not part of the layout budget ----

  it("does not charge a gap for an authored hidden item", async () => {
    setup(MARKUP());
    items().style.columnGap = "20px";
    query("#c").hidden = true;
    // Two rendered items plus one gap is 220, which fits in 230. Counting the hidden
    // third one adds a phantom 20px gap and would push the row over.
    setGeom(230, { a: 100, b: 100, c: 0 });
    await start();

    expect(root().getAttribute("data-overflow-count")).toBe("0");
    expect(more().hidden).toBe(true);
    expect(ids(items())).toEqual(["a", "b", "c"]);
  });

  it("never banks an authored hidden item, and keeps its canonical slot", async () => {
    setup(MARKUP());
    query("#c").hidden = true;
    const seen: Array<{ overflowCount: number; total: number }> = [];
    document.addEventListener("stimeo--overflow-menu:change", (event) => {
      seen.push((event as CustomEvent).detail);
    });
    setGeom(150, { a: 100, b: 100, c: 0 }); // the two rendered items overflow
    await start();

    expect(ids(menu())).toEqual(["b"]); // B only — C is not banked despite ranking lowest
    expect(ids(items())).toEqual(["a", "c"]);
    // `overflowCount` counts only the banked items and `total` counts every item — an
    // authored hidden item stays in the bar, invisible, so it counts toward `total`
    // but never toward `overflowCount`.
    expect(seen.at(-1)).toEqual({ overflowCount: 1, total: 3 });

    query("#c").hidden = false;
    setGeom(1000, { a: 100, b: 100, c: 100 });
    instance().update();
    expect(ids(items())).toEqual(["a", "b", "c"]); // rejoins in its authored slot
  });

  // ---- The More label must not destroy authored trigger content ----

  it("keeps an icon-only More trigger's authored children", async () => {
    setup(
      TRIGGER_MARKUP('aria-label="More"', '<svg aria-hidden="true"><circle r="1"></circle></svg>'),
    );
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();

    expect(trigger().querySelector("svg")).not.toBeNull();
    expect((trigger().textContent ?? "").trim()).toBe("");
    expect(trigger().getAttribute("aria-label")).toBe("More");
  });

  it("leaves an unnamed trigger's authored children alone rather than naming it", async () => {
    setup(TRIGGER_MARKUP("", '<svg aria-hidden="true"><circle r="1"></circle></svg>'));
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();

    // Authored children win even with no name to protect: fabricating one would
    // destroy the icon and invent a label the author never wrote. An icon-only
    // trigger has to carry its own `aria-label` — axe reports the bare case.
    expect(trigger().querySelector("svg")).not.toBeNull();
    expect((trigger().textContent ?? "").trim()).toBe("");
  });

  it("leaves a trigger named by aria-label alone", async () => {
    setup(TRIGGER_MARKUP('aria-label="More actions"', ""));
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    // Injecting visible text under a different name would break WCAG 2.5.3.
    expect((trigger().textContent ?? "").trim()).toBe("");
  });

  it("leaves a trigger named by aria-labelledby alone", async () => {
    setup(TRIGGER_MARKUP('aria-labelledby="a"', ""));
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    expect((trigger().textContent ?? "").trim()).toBe("");
  });

  it("still fills a trigger that is bare in every respect", async () => {
    setup(TRIGGER_MARKUP('title="More"', "")); // `title` is not a name source we honor
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    expect(trigger().textContent).toBe("More");
  });

  // ---- The label it writes stays its own, and follows `moreLabel` ----

  /** The attribute on the trigger recording the label this controller wrote there. */
  const OWNS_LABEL = "data-stimeo--overflow-menu-owns-label";
  const MORE_LABEL = "data-stimeo--overflow-menu-more-label-value";

  it("marks the label it writes into a bare trigger as its own", async () => {
    setup(MARKUP(""));
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    expect(trigger().textContent).toBe("More");
    // The marker holds the label itself: the text is this controller's only while
    // the two still agree.
    expect(trigger().getAttribute(OWNS_LABEL)).toBe("More");
  });

  it("writes its label back on the next pass after a morph empties the trigger", async () => {
    setup(MARKUP(""));
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    // A morph onto the server's bare trigger empties it and drops the marker, while
    // the element and every Value stay, so connect() does not run again.
    trigger().textContent = "";
    trigger().removeAttribute(OWNS_LABEL);
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(100);
    expect(trigger().textContent).toBe("More");
    expect(trigger().getAttribute(OWNS_LABEL)).toBe("More");
  });

  it("measures the More trigger with the label it writes back", async () => {
    setup(MARKUP(""));
    stub(root(), "clientWidth", 240);
    for (const id of ["a", "b", "c"]) stub(query(`#${id}`), "offsetWidth", 100);
    // A bare trigger has no width of its own; the label is what gives it one.
    Object.defineProperty(trigger(), "offsetWidth", {
      configurable: true,
      get: () => (trigger().textContent === "" ? 0 : 50),
    });
    await start();
    expect(root().getAttribute("data-overflow-count")).toBe("2");

    trigger().textContent = "";
    trigger().removeAttribute(OWNS_LABEL);
    instance().update();
    // Measured bare, the button would free 50px and let B back into the bar beside it.
    expect(trigger().textContent).toBe("More");
    expect(root().getAttribute("data-overflow-count")).toBe("2");
  });

  it("follows a More label swapped in place onto the label it wrote", async () => {
    setup(MARKUP(""));
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    root().setAttribute(MORE_LABEL, "Mehr");
    await vi.advanceTimersByTimeAsync(0);
    expect(trigger().textContent).toBe("Mehr");
    expect(trigger().getAttribute(OWNS_LABEL)).toBe("Mehr");
  });

  it("follows a More label swap without measuring the bar or dispatching change", async () => {
    setup(MARKUP(""));
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    // Let any pass the connection scheduled run before counting.
    await vi.advanceTimersByTimeAsync(1000);
    // Every pass reads the container's width once, so the reads count the passes.
    let width = 1000;
    let passes = 0;
    Object.defineProperty(root(), "clientWidth", {
      configurable: true,
      get: () => {
        passes++;
        return width;
      },
    });
    const events: unknown[] = [];
    root().addEventListener("stimeo--overflow-menu:change", (e) =>
      events.push((e as CustomEvent).detail),
    );

    root().setAttribute(MORE_LABEL, "Mehr");
    // Past the debounce as well, so a pass scheduled from the swap would show here.
    await vi.advanceTimersByTimeAsync(1000);
    expect(trigger().textContent).toBe("Mehr");
    expect(passes).toBe(0);
    expect(events).toEqual([]);

    // The same probes see a pass and a transition when one happens.
    width = 250;
    instance().update();
    expect(passes).toBe(1);
    expect(events).toEqual([{ overflowCount: 1, total: 3 }]);
  });

  it("leaves an authored label alone when the More label changes", async () => {
    setup(MARKUP("Actions"));
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    root().setAttribute(MORE_LABEL, "Mehr");
    await vi.advanceTimersByTimeAsync(0);
    expect(trigger().textContent).toBe("Actions");
    expect(trigger().hasAttribute(OWNS_LABEL)).toBe(false);
  });

  it("leaves a label the consumer rewrote alone when the More label changes", async () => {
    setup(MARKUP(""));
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    trigger().textContent = "Plus"; // e.g. the page's own locale switch
    root().setAttribute(MORE_LABEL, "Mehr");
    await vi.advanceTimersByTimeAsync(0);
    expect(trigger().textContent).toBe("Plus");
    instance().update();
    expect(trigger().textContent).toBe("Plus");
  });

  it("hands a trigger it labelled back bare when the More label empties", async () => {
    setup(MARKUP(""));
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    root().setAttribute(MORE_LABEL, "");
    await vi.advanceTimersByTimeAsync(0);
    expect(trigger().textContent).toBe("");
    expect(trigger().hasAttribute(OWNS_LABEL)).toBe(false);
    // Bare again, so the next label reaches it.
    root().setAttribute(MORE_LABEL, "Mehr");
    await vi.advanceTimersByTimeAsync(0);
    expect(trigger().textContent).toBe("Mehr");
  });

  it("writes nothing to the trigger when its label is already in place", async () => {
    setup(MARKUP(""));
    setGeom(250, { a: 100, b: 100, c: 100 });
    await start();
    const observer = new MutationObserver(() => {});
    observer.observe(trigger(), {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    instance().update(); // identical geometry and label
    const records = observer.takeRecords();
    observer.disconnect();
    expect(records).toEqual([]);
  });

  it("hands a trigger it labelled back bare on disconnect", async () => {
    setup(MARKUP(""));
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    instance().disconnect();
    expect(trigger().textContent).toBe("");
    expect(bookkeeping(trigger())).toEqual([]);
  });

  it("keeps an authored More label on disconnect", async () => {
    setup(MARKUP());
    setGeom(50, { a: 100, b: 100, c: 100 });
    await start();
    instance().disconnect();
    expect(trigger().textContent).toBe("More");
  });

  it("stays inert without its items target, even when the More label changes", async () => {
    setup(`
      <div id="om" data-controller="stimeo--overflow-menu" role="toolbar" aria-label="Actions">
        <div data-stimeo--overflow-menu-target="more" hidden>
          <button id="more-trigger" data-stimeo--menu-target="trigger"></button>
          <div role="menu" aria-labelledby="more-trigger" data-stimeo--menu-target="menu"></div>
        </div>
      </div>`);
    await start();
    expect(trigger().textContent).toBe("");
    root().setAttribute(MORE_LABEL, "Mehr");
    await vi.advanceTimersByTimeAsync(0);
    expect(trigger().textContent).toBe("");
  });

  it("measures the More wrapper itself when the markup has no trigger", async () => {
    setup(`
      <div id="om" data-controller="stimeo--overflow-menu" role="toolbar" aria-label="Actions">
        <div data-stimeo--overflow-menu-target="items">
          <a id="a" href="#" data-priority="1">A</a>
          <a id="b" href="#" data-priority="2">B</a>
          <a id="c" href="#">C</a>
        </div>
        <div data-stimeo--overflow-menu-target="more" hidden>
          <div role="menu" aria-label="More" data-stimeo--menu-target="menu"></div>
        </div>
      </div>`);
    stub(root(), "clientWidth", 240);
    for (const id of ["a", "b", "c"]) stub(query(`#${id}`), "offsetWidth", 100);
    stub(more(), "offsetWidth", 50);
    await start();
    expect(root().getAttribute("data-overflow-count")).toBe("2");
    root().setAttribute(MORE_LABEL, "Mehr");
    await vi.advanceTimersByTimeAsync(0);
    expect(root().getAttribute("data-overflow-count")).toBe("2");
  });

  it("marks the label under the identifier it is registered with", async () => {
    const alias = "nav--overflow";
    document.body.innerHTML = `
      <nav id="om" data-controller="${alias}" aria-label="Actions">
        <div data-${alias}-target="items"><a id="a" href="#">A</a></div>
        <div data-${alias}-target="more" hidden>
          <button id="more-trigger" data-stimeo--menu-target="trigger"></button>
          <div role="menu" aria-labelledby="more-trigger" data-stimeo--menu-target="menu"></div>
        </div>
      </nav>`;
    application = Application.start();
    application.register(alias, OverflowMenuController);
    await vi.advanceTimersByTimeAsync(0);
    expect(trigger().textContent).toBe("More");
    expect(trigger().getAttribute(`data-${alias}-owns-label`)).toBe("More");
    expect(trigger().hasAttribute(OWNS_LABEL)).toBe(false);
  });

  // ---- A trigger the consumer adds to is theirs, even with the label unchanged ----

  /**
   * What a consumer may add to a trigger this controller labelled, each with the
   * step that takes it back out. None of them changes the trigger's text, so the
   * marker still matches it.
   */
  const ADDITIONS: ReadonlyArray<
    readonly [string, (el: HTMLElement) => void, (el: HTMLElement) => void]
  > = [
    [
      "an icon",
      (el) =>
        el.insertAdjacentHTML("beforeend", '<svg aria-hidden="true"><circle r="1"></circle></svg>'),
      (el) => el.querySelector("svg")?.remove(),
    ],
    [
      "an aria-label",
      (el) => el.setAttribute("aria-label", "More actions"),
      (el) => el.removeAttribute("aria-label"),
    ],
    [
      "an aria-labelledby",
      (el) => el.setAttribute("aria-labelledby", "a"),
      (el) => el.removeAttribute("aria-labelledby"),
    ],
  ];

  /**
   * Starts on a bare trigger, lets the controller label it, applies `add`, and
   * returns the trigger's outer markup (attributes, marker and children) as it
   * stands after that.
   */
  const labelThenAdd = async (add: (el: HTMLElement) => void): Promise<string> => {
    setup(MARKUP(""));
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    expect(trigger().textContent).toBe("More");
    add(trigger());
    expect(trigger().getAttribute(OWNS_LABEL)).toBe(trigger().textContent);
    return trigger().outerHTML;
  };

  it.each(ADDITIONS)(
    "never rewrites a trigger it labelled once the consumer adds %s",
    async (_, add) => {
      const authored = await labelThenAdd(add);
      root().setAttribute(MORE_LABEL, "Mehr");
      await vi.advanceTimersByTimeAsync(0);
      expect(trigger().outerHTML).toBe(authored);
      // The measurement pass writes the label ahead of measuring it, by the same rule.
      instance().update();
      expect(trigger().outerHTML).toBe(authored);
    },
  );

  it.each(ADDITIONS)(
    "never empties a trigger it labelled once the consumer adds %s, when the More label empties",
    async (_, add) => {
      const authored = await labelThenAdd(add);
      root().setAttribute(MORE_LABEL, "");
      await vi.advanceTimersByTimeAsync(0);
      expect(trigger().outerHTML).toBe(authored);
    },
  );

  it.each(ADDITIONS)(
    "leaves a trigger it labelled alone on disconnect once the consumer adds %s",
    async (_, add) => {
      const authored = await labelThenAdd(add);
      instance().disconnect();
      expect(trigger().outerHTML).toBe(authored);
    },
  );

  it.each(ADDITIONS)(
    "takes its label back once %s the consumer added is gone again",
    async (_, add, takeOut) => {
      setup(MARKUP(""));
      setGeom(1000, { a: 100, b: 100, c: 100 });
      await start();
      // A trigger holding the label alone follows `moreLabel`.
      root().setAttribute(MORE_LABEL, "Mehr");
      await vi.advanceTimersByTimeAsync(0);
      expect(trigger().textContent).toBe("Mehr");
      add(trigger());
      root().setAttribute(MORE_LABEL, "Plus");
      await vi.advanceTimersByTimeAsync(0);
      expect(trigger().textContent).toBe("Mehr");
      // With the addition gone the trigger holds the label alone again, so the label
      // and the hand-back on disconnect reach it.
      takeOut(trigger());
      root().setAttribute(MORE_LABEL, "Encore");
      await vi.advanceTimersByTimeAsync(0);
      expect(trigger().textContent).toBe("Encore");
      expect(trigger().getAttribute(OWNS_LABEL)).toBe("Encore");
      instance().disconnect();
      expect(trigger().textContent).toBe("");
      expect(bookkeeping(trigger())).toEqual([]);
    },
  );

  // ---- Banked items are operable with no per-element bindings ----

  it("lets the keyboard reach banked items that carry no per-element action", async () => {
    setup(DELEGATED_MARKUP);
    setGeom(150, { a: 100, b: 100, c: 100 });
    await start(["stimeo--menu", MenuController]);
    expect(ids(menu())).toEqual(["b", "c"]);
    expect(query("#b").hasAttribute("data-action")).toBe(false);

    trigger().focus();
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(query("#b"));

    // Roving between banked items works without any per-element `data-action`.
    query("#b").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(query("#c"));

    (query("#c") as HTMLButtonElement).click();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  // ---- An items row or a More wrapper that takes over ----

  /**
   * The overflow lives in where the items sit: the ones that fit in the items row, the
   * rest banked in the More wrapper's menu, with the wrapper shown. A row or a wrapper
   * that takes over — in one task, or after an earlier one leaves in a later task — is
   * balanced the same way, silently, and the items banked from a row that leaves go back
   * to it.
   */
  describe("an items row or a More wrapper that takes over", () => {
    /** Lets Stimulus deliver the target callbacks, and the pass they schedule, under the mocked clock. */
    const settle = () => vi.advanceTimersByTimeAsync(0);
    const menuOf = (wrapper: HTMLElement) => query("[data-stimeo--menu-target='menu']", wrapper);
    /** A server-rendered More wrapper: hidden, with an empty menu. */
    const freshMore = (): HTMLElement => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-stimeo--overflow-menu-target", "more");
      wrapper.hidden = true;
      wrapper.innerHTML = `
        <button id="fresh-trigger" data-stimeo--menu-target="trigger">More</button>
        <div role="menu" aria-labelledby="fresh-trigger" data-stimeo--menu-target="menu"></div>`;
      stub(query("[data-stimeo--menu-target='trigger']", wrapper), "offsetWidth", 50);
      return wrapper;
    };
    /** A server-rendered items row holding fresh copies of the three items. */
    const freshItems = (): HTMLElement => {
      const row = document.createElement("div");
      row.setAttribute("data-stimeo--overflow-menu-target", "items");
      row.innerHTML = `
        <a id="na" href="#" data-priority="1">A</a>
        <a id="nb" href="#" data-priority="2">B</a>
        <a id="nc" href="#">C</a>`;
      for (const item of Array.from(row.children)) stub(item, "offsetWidth", 100);
      return row;
    };
    /** Mounts the bar with C banked: 250px holds A and B beside the More button. */
    const mountOverflowing = async (html = MARKUP()) => {
      setup(html);
      setGeom(250, { a: 100, b: 100, c: 100 });
      await start();
      expect(ids(items())).toEqual(["a", "b"]);
      expect(ids(menu())).toEqual(["c"]);
    };

    it("banks the overflow into a More wrapper replaced in one task", async () => {
      await mountOverflowing();
      const successor = freshMore();
      more().replaceWith(successor);
      await settle();

      expect(more()).toBe(successor);
      expect(successor.hidden).toBe(false);
      expect(ids(menuOf(successor))).toEqual(["c"]);
      expect(ids(items())).toEqual(["a", "b"]);
      expect(root().getAttribute("data-overflow-count")).toBe("1");
    });

    it("banks the overflow into the More wrapper that stays after an earlier one leaves", async () => {
      await mountOverflowing();
      const original = more();
      const successor = freshMore();
      original.after(successor);
      await settle();
      original.remove();
      await settle();

      expect(more()).toBe(successor);
      expect(successor.hidden).toBe(false);
      expect(ids(menuOf(successor))).toEqual(["c"]);
      expect(ids(items())).toEqual(["a", "b"]);
      expect(root().getAttribute("data-overflow-count")).toBe("1");
    });

    it("balances an items row replaced in one task, and the old row takes its banked item along", async () => {
      await mountOverflowing();
      const banked = query("#c");
      const successor = freshItems();
      items().replaceWith(successor);
      await settle();

      expect(items()).toBe(successor);
      expect(ids(successor)).toEqual(["na", "nb"]);
      expect(ids(menu())).toEqual(["nc"]);
      expect(banked.isConnected).toBe(false);
      expect(root().getAttribute("data-overflow-count")).toBe("1");
    });

    it("balances the items row that stays after an earlier one leaves", async () => {
      await mountOverflowing();
      const original = items();
      const banked = query("#c");
      const successor = freshItems();
      original.after(successor);
      await settle();
      original.remove();
      await settle();

      expect(items()).toBe(successor);
      expect(ids(successor)).toEqual(["na", "nb"]);
      expect(ids(menu())).toEqual(["nc"]);
      expect(banked.isConnected).toBe(false);
      expect(root().getAttribute("data-overflow-count")).toBe("1");
    });

    it("banks the overflow into a More wrapper inserted in front, and keeps it once the old one leaves", async () => {
      await mountOverflowing();
      const original = more();
      const successor = freshMore();
      original.before(successor);
      await settle();

      expect(more()).toBe(successor);
      expect(ids(menuOf(successor))).toEqual(["c"]);
      expect(ids(menuOf(original))).toEqual([]);
      expect(original.hidden).toBe(true);

      original.remove();
      await settle();

      expect(successor.hidden).toBe(false);
      expect(ids(menuOf(successor))).toEqual(["c"]);
      expect(ids(items())).toEqual(["a", "b"]);
      expect(root().getAttribute("data-overflow-count")).toBe("1");
    });

    it("balances an items row inserted in front, and the old row takes its banked item along once it leaves", async () => {
      await mountOverflowing();
      const original = items();
      const banked = query("#c");
      const successor = freshItems();
      original.before(successor);
      await settle();

      expect(items()).toBe(successor);
      expect(ids(successor)).toEqual(["na", "nb"]);
      expect(ids(menu())).toEqual(["nc"]);
      expect(ids(original)).toEqual(["a", "b", "c"]);
      expect(bookkeeping(banked)).toEqual([]);

      original.remove();
      await settle();

      expect(ids(successor)).toEqual(["na", "nb"]);
      expect(ids(menu())).toEqual(["nc"]);
      expect(banked.isConnected).toBe(false);
      expect(root().getAttribute("data-overflow-count")).toBe("1");
    });

    /** Records every event the bar reports while `act` runs and its callbacks settle. */
    const reported = async (act: () => void | Promise<void>): Promise<string[]> => {
      const seen: string[] = [];
      const names = ["stimeo--overflow-menu:change", "stimeo--overflow-menu:reconcile", "change"];
      const listener = (event: Event): void => {
        seen.push(`${event.type} ${JSON.stringify((event as CustomEvent).detail ?? null)}`);
      };
      for (const name of names) document.addEventListener(name, listener);
      await act();
      await settle();
      for (const name of names) document.removeEventListener(name, listener);
      return seen;
    };

    /** The records `act` leaves on the bar's subtree, besides the node it adds or removes. */
    const writesBesides = async (node: Node, act: () => void): Promise<MutationRecord[]> => {
      const records: MutationRecord[] = [];
      const observer = new MutationObserver((batch) => records.push(...batch));
      observer.observe(root(), { attributes: true, childList: true, subtree: true });
      act();
      await settle();
      records.push(...observer.takeRecords());
      observer.disconnect();
      return records.filter(
        (record) =>
          !Array.from(record.addedNodes).includes(node) &&
          !Array.from(record.removedNodes).includes(node),
      );
    };

    it("reports nothing while it balances a wrapper or a row that takes over at the same count", async () => {
      await mountOverflowing();
      const seen = await reported(async () => {
        const original = more();
        original.after(freshMore());
        await settle();
        original.remove();
        await settle();
        items().replaceWith(freshItems());
      });

      expect(seen).toEqual([]);
      expect(root().getAttribute("data-overflow-count")).toBe("1");
    });

    it("reports nothing while it balances a wrapper or a row inserted in front at the same count", async () => {
      await mountOverflowing();
      const seen = await reported(async () => {
        const wrapper = more();
        wrapper.before(freshMore());
        await settle();
        wrapper.remove();
        await settle();
        const row = items();
        row.before(freshItems());
        await settle();
        row.remove();
      });

      expect(seen).toEqual([]);
      expect(root().getAttribute("data-overflow-count")).toBe("1");
    });

    it("reports a count that moved with a row that takes over as reconcile", async () => {
      await mountOverflowing();
      const successor = freshItems();
      const extra = document.createElement("a");
      extra.id = "nd";
      extra.href = "#";
      extra.textContent = "D";
      stub(extra, "offsetWidth", 100);
      successor.append(extra);

      const seen = await reported(() => items().replaceWith(successor));

      expect(ids(menu())).toEqual(["nc", "nd"]);
      expect(seen).toEqual(['stimeo--overflow-menu:reconcile {"overflowCount":2,"total":4}']);
    });

    it("balances a More wrapper that arrives after the only one left", async () => {
      await mountOverflowing();
      more().remove();
      await settle();
      // With no wrapper left, the banked item is handed back to the row.
      expect(ids(items())).toEqual(["a", "b", "c"]);
      expect(bookkeeping(query("#c"))).toEqual([]);
      expect(root().hasAttribute("data-overflow-count")).toBe(false);

      const late = freshMore();
      const seen = await reported(() => root().append(late));

      expect(late.hidden).toBe(false);
      expect(ids(menuOf(late))).toEqual(["c"]);
      expect(root().getAttribute("data-overflow-count")).toBe("1");
      expect(seen).toEqual([]);
    });

    it("balances an items row that arrives after the only one left", async () => {
      await mountOverflowing();
      const banked = query("#c");
      items().remove();
      await settle();
      expect(banked.isConnected).toBe(false);

      const late = freshItems();
      more().before(late);
      await settle();

      expect(ids(late)).toEqual(["na", "nb"]);
      expect(ids(menu())).toEqual(["nc"]);
      expect(root().getAttribute("data-overflow-count")).toBe("1");
    });

    it("writes nothing when a wrapper or a row arrives behind the current one", async () => {
      await mountOverflowing();
      const behindMore = freshMore();
      expect(await writesBesides(behindMore, () => more().after(behindMore))).toEqual([]);
      const behindRow = freshItems();
      expect(await writesBesides(behindRow, () => items().after(behindRow))).toEqual([]);

      expect(ids(menu())).toEqual(["c"]);
      expect(behindMore.hidden).toBe(true);
    });

    it("writes nothing when a wrapper or a row behind the current one leaves", async () => {
      await mountOverflowing();
      const behindMore = freshMore();
      const behindRow = freshItems();
      more().after(behindMore);
      items().after(behindRow);
      await settle();

      expect(await writesBesides(behindMore, () => behindMore.remove())).toEqual([]);
      expect(await writesBesides(behindRow, () => behindRow.remove())).toEqual([]);
      expect(ids(menu())).toEqual(["c"]);
    });

    it("tolerates the removal of the only row and the only wrapper", async () => {
      await mountOverflowing();
      const onlyRow = items();
      const onlyMore = more();
      onlyRow.remove();
      onlyMore.remove();

      // Drive the callbacks directly: happy-dom delivers target callbacks unreliably.
      expect(() => instance().itemsTargetDisconnected(onlyRow)).not.toThrow();
      expect(() => instance().moreTargetDisconnected(onlyMore)).not.toThrow();
      await settle();
    });

    it("balances nothing into the wrapper that stays once it has disconnected", async () => {
      await mountOverflowing();
      const original = more();
      const successor = freshMore();
      original.after(successor);
      await settle();
      const controller = instance();
      controller.disconnect();
      original.remove();
      controller.moreTargetDisconnected(original);
      controller.moreTargetConnected();
      controller.itemsTargetConnected();
      await settle();

      // `disconnect()` handed the bar back, and nothing banks it again afterwards.
      expect(successor.hidden).toBe(true);
      expect(ids(menuOf(successor))).toEqual([]);
      expect(ids(items())).toEqual(["a", "b", "c"]);
      expect(root().hasAttribute("data-overflow-count")).toBe(false);
    });

    it("stays inert when a required target missing since connect arrives later", async () => {
      setup(`
        <div id="om" data-controller="stimeo--overflow-menu" role="toolbar" aria-label="Actions">
          <div data-stimeo--overflow-menu-target="items">
            <a id="a" href="#" data-priority="1">A</a>
            <a id="b" href="#" data-priority="2">B</a>
            <a id="c" href="#">C</a>
          </div>
        </div>`);
      stub(root(), "clientWidth", 250);
      for (const id of ["a", "b", "c"]) stub(query(`#${id}`), "offsetWidth", 100);
      await start();

      const late = freshMore();
      root().append(late);
      await settle();

      expect(root().hasAttribute("data-overflow-count")).toBe(false);
      expect(late.hidden).toBe(true);
      expect(ids(items())).toEqual(["a", "b", "c"]);
    });

    it("balances nothing when a target callback arrives during a restore", async () => {
      setup(COMPOSED_MARKUP);
      setGeom(250, { a: 100, b: 100, c: 100 });
      await start(["stimeo--menu", MenuController]);
      expect(ids(menu())).toEqual(["c"]);
      trigger().focus();
      trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      const controller = instance();
      more().addEventListener(
        "stimeo--menu:close",
        () => {
          controller.moreTargetConnected();
          controller.itemsTargetDisconnected(items());
        },
        { once: true },
      );

      controller.disconnect();
      await settle();

      expect(ids(items())).toEqual(["a", "b", "c"]);
      expect(ids(menu())).toEqual([]);
      expect(more().hidden).toBe(true);
    });

    it("hands a wrapper that stops being the wrapper its banked items back, and hides it", async () => {
      await mountOverflowing();
      const former = more();
      const successor = freshMore();
      former.after(successor);
      await settle();

      // The element stays; only the attribute naming it the wrapper goes.
      former.removeAttribute("data-stimeo--overflow-menu-target");
      await settle();

      expect(former.isConnected).toBe(true);
      expect(former.hidden).toBe(true);
      expect(ids(menuOf(former))).toEqual([]);
      expect(successor.hidden).toBe(false);
      expect(ids(menuOf(successor))).toEqual(["c"]);
    });

    it("takes the label it wrote back from a wrapper that stops being the wrapper", async () => {
      setup(MARKUP(""));
      setGeom(250, { a: 100, b: 100, c: 100 });
      await start();
      const former = more();
      expect(trigger().textContent).toBe("More");
      const successor = freshMore();
      former.after(successor);
      await settle();

      former.removeAttribute("data-stimeo--overflow-menu-target");
      await settle();

      const formerTrigger = query("[data-stimeo--menu-target='trigger']", former);
      expect(formerTrigger.textContent).toBe("");
      expect(bookkeeping(formerTrigger)).toEqual([]);
    });

    it("hands a row that stops being the row its banked items back", async () => {
      await mountOverflowing();
      const former = items();
      const successor = freshItems();
      former.after(successor);
      await settle();

      former.removeAttribute("data-stimeo--overflow-menu-target");
      await settle();

      expect(ids(former)).toEqual(["a", "b", "c"]);
      for (const id of ["a", "b", "c"]) expect(bookkeeping(query(`#${id}`)), id).toEqual([]);
      expect(query("#c").hasAttribute("role")).toBe(false);
      expect(ids(successor)).toEqual(["na", "nb"]);
      expect(ids(menu())).toEqual(["nc"]);
    });

    it("hands a row that stops being the row its banked items back once it has disconnected", async () => {
      await mountOverflowing();
      const former = items();
      const controller = instance();
      former.removeAttribute("data-stimeo--overflow-menu-target");
      controller.disconnect();
      // The wrapper still resolves, so only the row's own callback hands the bar back.
      controller.itemsTargetDisconnected(former);
      await settle();

      expect(ids(former)).toEqual(["a", "b", "c"]);
      for (const id of ["a", "b", "c"]) expect(bookkeeping(query(`#${id}`)), id).toEqual([]);
      expect(ids(menu())).toEqual([]);
      expect(more().hidden).toBe(true);
    });

    it("hands a wrapper that stops being the wrapper its banked items back once it has disconnected", async () => {
      await mountOverflowing();
      const former = more();
      const controller = instance();
      former.removeAttribute("data-stimeo--overflow-menu-target");
      controller.disconnect();
      // The row still resolves, so only the wrapper's own callback hands the bar back.
      controller.moreTargetDisconnected(former);
      await settle();

      expect(ids(items())).toEqual(["a", "b", "c"]);
      expect(bookkeeping(query("#c"))).toEqual([]);
      expect(ids(menuOf(former))).toEqual([]);
      expect(former.hidden).toBe(true);
    });

    it("hands back a pristine bar when the root loses its controller", async () => {
      await mountOverflowing();

      root().removeAttribute("data-controller");
      await settle();

      expect(ids(items())).toEqual(["a", "b", "c"]);
      expect(ids(menu())).toEqual([]);
      expect(more().hidden).toBe(true);
      expect(root().hasAttribute("data-overflowing")).toBe(false);
      expect(root().hasAttribute("data-overflow-count")).toBe(false);
      for (const id of ["a", "b", "c"]) expect(bookkeeping(query(`#${id}`)), id).toEqual([]);
      expect(query("#c").hasAttribute("role")).toBe(false);
    });

    it("keeps the balance on a wrapper and a row that move within the bar", async () => {
      await mountOverflowing();
      const moving = more();
      expect(await writesBesides(moving, () => items().before(moving))).toEqual([]);
      const row = items();
      expect(await writesBesides(row, () => root().append(row))).toEqual([]);

      expect(moving.hidden).toBe(false);
      expect(ids(menu())).toEqual(["c"]);
      expect(ids(items())).toEqual(["a", "b"]);
    });
  });
});
