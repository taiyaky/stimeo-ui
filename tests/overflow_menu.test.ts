import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverflowMenuController } from "../src/controllers/overflow_menu_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link OverflowMenuController}. happy-dom has no layout, so item
 * widths and the container width are stubbed and `update()` drives the rebalance:
 * priority-ordered overflow into the menu, restore when space returns, the More toggle
 * and state hooks, the change event, debounced resize, the moreLabel fallback, and
 * observer teardown.
 */

const MARKUP = (trigger = "More") => `
  <div id="om" data-controller="stimeo--overflow-menu" role="toolbar">
    <div data-stimeo--overflow-menu-target="items">
      <a id="a" href="#" data-priority="1">A</a>
      <a id="b" href="#" data-priority="2">B</a>
      <a id="c" href="#">C</a>
    </div>
    <div data-stimeo--overflow-menu-target="more" hidden>
      <button data-stimeo--menu-target="trigger">${trigger}</button>
      <ul role="menu" data-stimeo--menu-target="menu"></ul>
    </div>
  </div>`;

describe("OverflowMenuController", () => {
  let application: Application;

  const setup = (html: string) => {
    document.body.innerHTML = html;
  };
  const start = async () => {
    application = Application.start();
    application.register("stimeo--overflow-menu", OverflowMenuController);
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    application.stop();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const root = () => query("#om");
  const items = () => query("[data-stimeo--overflow-menu-target='items']");
  const menu = () =>
    query("[data-stimeo--overflow-menu-target='more'] [data-stimeo--menu-target='menu']");
  const more = () => query("[data-stimeo--overflow-menu-target='more']");
  const instance = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--overflow-menu",
    ) as OverflowMenuController;

  /** Stubs the container width, each item's width (by id), and the More button width. */
  const setGeom = (container: number, itemW: Record<string, number>, moreW = 50) => {
    Object.defineProperty(root(), "clientWidth", { configurable: true, value: container });
    for (const [id, w] of Object.entries(itemW)) {
      Object.defineProperty(query(`#${id}`), "offsetWidth", { configurable: true, value: w });
    }
    Object.defineProperty(query("[data-stimeo--menu-target='trigger']"), "offsetWidth", {
      configurable: true,
      value: moreW,
    });
  };

  const ids = (el: Element) =>
    Array.from(el.children)
      .map((c) => c.id)
      .filter(Boolean);

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

  it("returns a banked middle item to its original slot, not the end", async () => {
    // y (no priority) sits between x and z and drops first; on restore it must land
    // back between them, not after z.
    setup(`
      <div id="om" data-controller="stimeo--overflow-menu" role="toolbar">
        <div data-stimeo--overflow-menu-target="items">
          <a id="x" href="#" data-priority="1">X</a>
          <a id="y" href="#">Y</a>
          <a id="z" href="#" data-priority="2">Z</a>
        </div>
        <div data-stimeo--overflow-menu-target="more" hidden>
          <button data-stimeo--menu-target="trigger">More</button>
          <ul role="menu" data-stimeo--menu-target="menu"></ul>
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

  it("accounts for the flex column-gap when measuring overflow", async () => {
    const real = window.getComputedStyle;
    window.getComputedStyle = ((el: Element) =>
      ({
        ...real(el),
        columnGap: "20px",
        gap: "20px",
      }) as CSSStyleDeclaration) as typeof getComputedStyle;
    try {
      setup(MARKUP());
      // 3×100 items fit in 320 on their own, but 2×20px gaps push the row to 340 > 320,
      // so the lowest-priority item must overflow once the gap is counted.
      setGeom(320, { a: 100, b: 100, c: 100 });
      await start();
      expect(root().getAttribute("data-overflow-count")).toBe("1");
      expect(ids(menu())).toEqual(["c"]);
    } finally {
      window.getComputedStyle = real;
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
    expect(events).toEqual([
      { visible: 3, hidden: 0 },
      { visible: 2, hidden: 1 },
    ]);
  });

  it("adopts items appended to the bar before a later update", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();

    // Consumer appends a 4th item, then calls the update action (the documented flow).
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
    expect(query("[data-stimeo--menu-target='trigger']").textContent).toBe("More");
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
    // redirects focus to the visible More trigger. The real-browser collapsed-menu case
    // is covered by the end-to-end browser suite.
    expect(c.parentElement).toBe(menu());
    expect(document.activeElement).toBe(query("[data-stimeo--menu-target='trigger']"));
  });

  it("releases observers and timers on disconnect", async () => {
    setup(MARKUP());
    setGeom(1000, { a: 100, b: 100, c: 100 });
    await start();
    root().remove();
    await vi.advanceTimersByTimeAsync(0);
    // A resize after teardown must not schedule or throw.
    expect(() => window.dispatchEvent(new Event("resize"))).not.toThrow();
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
  });

  it("has no a11y violations with items banked into the menu", async () => {
    vi.useRealTimers();
    document.body.innerHTML = MARKUP();
    application = Application.start();
    application.register("stimeo--overflow-menu", OverflowMenuController);
    await new Promise((resolve) => setTimeout(resolve, 0)); // 0 width → all items in menu
    await expectNoA11yViolations(root());
  });

  // Layer ③ — speech-order regression: items banked into the overflow menu are
  // announced as the menu's contents.
  it("announces the banked items inside the overflow menu (layer ③)", async () => {
    setup(MARKUP());
    setGeom(150, { a: 100, b: 100, c: 100 }); // budget 100 → only A stays in the bar
    await start();
    expect(ids(menu())).toEqual(["b", "c"]);
    // The virtual SR awaits real microtasks, so capture on the real clock.
    vi.useRealTimers();
    const speech = await captureSpeech({ container: menu(), steps: 2 });
    expect(speech).toEqual([
      "menu, orientated vertically",
      "menuitem, B, position 1, set size 2",
      "menuitem, C, position 2, set size 2",
    ]);
  });
});
