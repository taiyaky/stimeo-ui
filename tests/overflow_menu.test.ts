import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MenuController } from "../src/controllers/menu_controller";
import { OverflowMenuController } from "../src/controllers/overflow_menu_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
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

  it("keeps every item in the bar and hides More when they all fit", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    expect(ids(items())).toEqual(["a", "b", "c"]);
    expect(more().hidden).toBe(true);
    expect(root().hasAttribute("data-overflowing")).toBe(false);
    expect(root().getAttribute("data-overflow-count")).toBe("0");
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

  it("emits change only when the overflow count transitions", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    const events: Array<{ visible: number; hidden: number }> = [];
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
      { visible: 3, hidden: 0 },
      { visible: 2, hidden: 1 },
      { visible: 3, hidden: 0 },
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

  it("hands back a pristine DOM before Turbo caches the page", async () => {
    setup(MARKUP());
    setGeom(50, { a: 100, b: 100, c: 100 });
    await start();
    expect(ids(menu())).toEqual(["a", "b", "c"]);
    expect(items().querySelector("[data-stimeo--overflow-menu-boundary]")).not.toBeNull();

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(ids(items())).toEqual(["a", "b", "c"]);
    expect(more().hidden).toBe(true);
    expect(root().querySelector("[data-stimeo--overflow-menu-boundary]")).toBeNull();
    expect(bookkeeping(query("#b"))).toEqual([]);
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

    // The user is still arrowing through the menu — closing it here would be the bug.
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

  it("collapses an expanded menu before Turbo caches the page", async () => {
    setup(COMPOSED_MARKUP);
    setGeom(150, { a: 100, b: 100, c: 100 });
    await start(["stimeo--menu", MenuController]);
    trigger().focus();
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(menu().hidden).toBe(true);
    expect(ids(items())).toEqual(["a", "b", "c"]);
    expect(more().hidden).toBe(true);
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
    const seen: Array<{ visible: number; hidden: number }> = [];
    document.addEventListener("stimeo--overflow-menu:change", (event) => {
      seen.push((event as CustomEvent).detail);
    });
    setGeom(150, { a: 100, b: 100, c: 0 }); // the two rendered items overflow
    await start();

    expect(ids(menu())).toEqual(["b"]); // B only — C is not banked despite ranking lowest
    expect(ids(items())).toEqual(["a", "c"]);
    // `visible` is the non-banked count, which is what the bar owns — not a count of
    // what the user can see (an authored hidden item is in the bar but invisible).
    expect(seen.at(-1)).toEqual({ visible: 2, hidden: 1 });

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
});
