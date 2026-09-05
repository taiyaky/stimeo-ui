import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RovingController } from "../src/controllers/roving_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link RovingController}: the single tab stop and its
 * idempotent connect (DOM is the source of truth), arrow-key movement per
 * orientation, wrap/clamp, Home/End, the `focusin` sync for click/programmatic
 * focus, the `change` event, dynamic items, and listener teardown.
 */

describe("RovingController", () => {
  let application: Application;

  const mount = async (
    attrs = "",
    tabindexes: [string, string, string] = ["0", "-1", "-1"],
    itemAttrs: [string, string, string] = ["", "", ""],
  ) => {
    document.body.innerHTML = `
      <button id="outside">outside</button>
      <div id="group" data-controller="stimeo--roving" ${attrs}>
        <button id="a" data-stimeo--roving-target="item" tabindex="${tabindexes[0]}" ${itemAttrs[0]}>A</button>
        <button id="b" data-stimeo--roving-target="item" tabindex="${tabindexes[1]}" ${itemAttrs[1]}>B</button>
        <button id="c" data-stimeo--roving-target="item" tabindex="${tabindexes[2]}" ${itemAttrs[2]}>C</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--roving", RovingController);
    await tick();
  };

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const group = () => query("#group");
  const tabindexes = () => ["#a", "#b", "#c"].map((id) => query(id).tabIndex);
  /** Dispatches a keydown and reports whether the widget consumed it. */
  const arrow = (from: string, key: string) =>
    query(from).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );

  it("makes exactly one item tabbable, keeping an existing tab stop on connect", async () => {
    // The middle item is the authored tab stop — connect must preserve it (DOM is
    // the source of truth), not reset to the first.
    await mount("", ["-1", "0", "-1"]);
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("reverses the horizontal arrows under RTL, leaving Home/End alone", async () => {
    // Logical direction: APG describes these as "next / previous", so the pair
    // reverses with the writing direction. `dir="rtl"` is the authoring contract,
    // but happy-dom does not resolve it into the computed style, so the direction
    // is set as an inline style instead.
    await mount("", ["0", "-1", "-1"]);
    group().style.direction = "rtl";

    arrow("#a", "ArrowLeft"); // "next" under RTL
    expect(tabindexes()).toEqual([-1, 0, -1]);

    arrow("#b", "ArrowRight"); // and back to "previous"
    expect(tabindexes()).toEqual([0, -1, -1]);

    arrow("#a", "End"); // logical already; unchanged by direction
    expect(tabindexes()).toEqual([-1, -1, 0]);
  });

  it("reads the direction from the container, not the focused item", async () => {
    // The rule this pins: the container is what lays the items out,
    // so a child carrying its own `dir` must not change which way "next" goes.
    // An LTR field inside an RTL form is ordinary authoring, and probing the
    // focused element instead would make two handlers on the same widget
    // disagree at the boundary between them.
    //
    // Without a case shaped like this, `isRtl(this.element)` and
    // `isRtl(event.currentTarget)` are indistinguishable: an inline `direction`
    // set on the container inherits to every child, so both answer the same.
    await mount("", ["0", "-1", "-1"]);
    group().style.direction = "rtl";
    query("#a").style.direction = "ltr"; // the child disagrees with its container

    arrow("#a", "ArrowLeft"); // still "next": the container decides
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("defaults the tab stop to the first item when none is set", async () => {
    await mount("", ["-1", "-1", "-1"]);
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("moves focus and the tab stop with horizontal arrows", async () => {
    await mount();
    // dispatchEvent reports false once the handler consumed the key.
    expect(arrow("#a", "ArrowRight")).toBe(false);
    expect(tabindexes()).toEqual([-1, 0, -1]);
    expect(document.activeElement).toBe(query("#b"));

    expect(arrow("#b", "ArrowLeft")).toBe(false);
    expect(tabindexes()).toEqual([0, -1, -1]);
    expect(document.activeElement).toBe(query("#a"));

    // The default orientation is horizontal, so the vertical pair is not ours.
    expect(arrow("#a", "ArrowDown")).toBe(true);
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("uses vertical arrows when orientation is vertical (ignoring horizontal)", async () => {
    await mount('data-stimeo--roving-orientation-value="vertical"');
    arrow("#a", "ArrowRight"); // ignored on the vertical axis
    expect(tabindexes()).toEqual([0, -1, -1]);
    arrow("#a", "ArrowDown");
    expect(document.activeElement).toBe(query("#b"));
  });

  it("accepts both axes when orientation is both", async () => {
    await mount('data-stimeo--roving-orientation-value="both"');
    arrow("#a", "ArrowDown");
    expect(document.activeElement).toBe(query("#b"));
    arrow("#b", "ArrowRight");
    expect(document.activeElement).toBe(query("#c"));
  });

  it("wraps past the ends by default and clamps when wrap is false", async () => {
    await mount();
    arrow("#a", "ArrowLeft"); // first → wraps to last
    expect(document.activeElement).toBe(query("#c"));

    await mount('data-stimeo--roving-wrap-value="false"');
    arrow("#a", "ArrowLeft"); // first → clamps, stays
    expect(document.activeElement).toBe(query("#a"));
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("jumps to the first/last with Home/End, disabled when homeEnd is false", async () => {
    await mount();
    arrow("#a", "End");
    expect(document.activeElement).toBe(query("#c"));
    arrow("#c", "Home");
    expect(document.activeElement).toBe(query("#a"));

    await mount('data-stimeo--roving-home-end-value="false"', ["-1", "-1", "0"]);
    expect(arrow("#c", "End")).toBe(true); // ignored, and not consumed
    expect(tabindexes()).toEqual([-1, -1, 0]);
    expect(arrow("#c", "Home")).toBe(true); // the Home side is governed by the same value
    expect(tabindexes()).toEqual([-1, -1, 0]);
  });

  it("syncs the tab stop to an item focused by click/programmatically", async () => {
    await mount();
    // focusin (what a click or .focus() raises) on a non-tabbable item moves the
    // single tab stop to it without the arrow keys.
    query("#c").dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(tabindexes()).toEqual([-1, -1, 0]);
  });

  it("emits change with the new index and item only when it changes", async () => {
    await mount();
    const changes: Array<{ index: number; id: string }> = [];
    group().addEventListener("stimeo--roving:change", (event) => {
      const detail = (event as CustomEvent<{ index: number; item: HTMLElement }>).detail;
      changes.push({ index: detail.index, id: detail.item.id });
    });

    arrow("#a", "ArrowRight"); // → b
    arrow("#b", "Home"); // → a
    arrow("#a", "ArrowLeft"); // wraps → c
    // Re-focusing the already-active item must not emit a duplicate change.
    query("#c").dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(changes).toEqual([
      { index: 1, id: "b" },
      { index: 0, id: "a" },
      { index: 2, id: "c" },
    ]);
  });

  it("follows items added at runtime", async () => {
    await mount();
    const d = document.createElement("button");
    d.id = "d";
    d.setAttribute("data-stimeo--roving-target", "item");
    d.tabIndex = 0;
    d.textContent = "D";
    group().appendChild(d);
    await tick(); // let Stimulus pick up the new target

    expect([query("#a").tabIndex, query("#b").tabIndex, query("#c").tabIndex, d.tabIndex]).toEqual([
      0, -1, -1, -1,
    ]);

    arrow("#a", "End"); // last is now D
    expect(document.activeElement).toBe(query("#d"));
    expect(query("#d").tabIndex).toBe(0);
  });

  it("re-establishes a Tab stop when the active item is removed", async () => {
    await mount("", ["-1", "0", "-1"]);
    query("#b").remove();
    await tick();

    expect([query("#a").tabIndex, query("#c").tabIndex]).toEqual([0, -1]);
  });

  it("yields arrows a descendant widget already claimed (defaultPrevented)", async () => {
    // Composition contract: a grabbed stimeo--pointer-drag handle consumes the
    // arrows (preventDefault) to move an item; roving must not also move focus.
    await mount();
    const claimed = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    claimed.preventDefault();
    query("#a").dispatchEvent(claimed);
    expect(tabindexes()).toEqual([0, -1, -1]); // tab stop did not move
  });

  it("leaves a modified arrow to the browser", async () => {
    // A chorded arrow is the browser's (history back/forward and the like), so
    // the delegated handler neither consumes the key nor moves the tab stop.
    await mount();
    const chord = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    query("#a").dispatchEvent(chord);

    expect(chord.defaultPrevented).toBe(false);
    expect(tabindexes()).toEqual([0, -1, -1]);
    expect(document.activeElement).not.toBe(query("#b"));
  });

  it("removes its listeners on disconnect", async () => {
    await mount();
    const a = query("#a");
    const b = query("#b");
    group().remove(); // detaches → Stimulus disconnect() runs on the next tick
    await tick();
    // The delegated keydown listener is gone: a stray key must not move the tab stop.
    expect(() =>
      a.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    ).not.toThrow();
    expect(a.tabIndex).toBe(0); // unchanged
    expect(b.tabIndex).toBe(-1);
    // The delegated focusin listener is gone as well.
    b.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(a.tabIndex).toBe(0);
    expect(b.tabIndex).toBe(-1);
  });

  it("skips a native-disabled item when moving", async () => {
    // The lone Tab stop must never land on something that cannot take focus: the
    // group would keep tabindex="0" on it while focus stayed put, taking the whole
    // set out of the Tab sequence.
    await mount("", ["0", "-1", "-1"], ["", "disabled", ""]);
    arrow("#a", "ArrowRight");
    expect(tabindexes()).toEqual([-1, -1, 0]);
  });

  it("skips a hidden item when moving", async () => {
    await mount("", ["0", "-1", "-1"], ["", "hidden", ""]);
    arrow("#a", "ArrowRight");
    expect(tabindexes()).toEqual([-1, -1, 0]);
  });

  it("keeps an aria-disabled item as a move target", async () => {
    // aria-disabled stays reachable — only activation is suppressed, and that is
    // the consuming pattern's business.
    await mount("", ["0", "-1", "-1"], ["", 'aria-disabled="true"', ""]);
    arrow("#a", "ArrowRight");
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("sends End to the last reachable item", async () => {
    await mount("", ["0", "-1", "-1"], ["", "", "disabled"]);
    arrow("#a", "End");
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("sends Home to the first reachable item", async () => {
    await mount("", ["-1", "-1", "0"], ["disabled", "", ""]);
    arrow("#c", "Home");
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("ignores focusin on an unreachable item", async () => {
    await mount("", ["0", "-1", "-1"], ["", "", "disabled"]);
    query("#c").dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("does not put the tab stop on an unreachable item on connect", async () => {
    await mount("", ["-1", "-1", "-1"], ["disabled", "", ""]);
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("re-establishes the tab stop when the active item is disabled at runtime", async () => {
    await mount();
    query("#a").setAttribute("disabled", "");
    await tick();
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("yields a keydown raised during IME composition", async () => {
    await mount();
    query("#a").dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    );
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("leaves a modified Home/End to the browser", async () => {
    // Chorded Home/End belong to the browser and the OS; APG assigns the widget
    // no modifier combination for them.
    await mount("", ["-1", "-1", "0"]);
    const home = new KeyboardEvent("keydown", {
      key: "Home",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    query("#c").dispatchEvent(home);
    expect(home.defaultPrevented).toBe(false);
    expect(tabindexes()).toEqual([-1, -1, 0]);

    const end = new KeyboardEvent("keydown", {
      key: "End",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    query("#c").dispatchEvent(end);
    expect(end.defaultPrevented).toBe(false);
    expect(tabindexes()).toEqual([-1, -1, 0]);
  });

  it("keeps the tab stop on an item added and focused in the same task", async () => {
    await mount();
    const d = document.createElement("button");
    d.id = "d";
    d.setAttribute("data-stimeo--roving-target", "item");
    d.textContent = "D";
    group().appendChild(d);
    d.focus(); // the focusin sync claims the tab stop before Stimulus reports the target
    await tick();
    expect(d.tabIndex).toBe(0);
    expect(query("#a").tabIndex).toBe(-1);
  });

  it("keeps the authored tab stop on connect when focus sits on another item", async () => {
    // Focus continuity belongs to reconciliation, not to the initial establishment:
    // connect() reads the authored DOM back, so it must not follow focus instead.
    document.body.innerHTML = `
      <div id="group" data-controller="stimeo--roving">
        <button id="a" data-stimeo--roving-target="item" tabindex="-1">A</button>
        <button id="b" data-stimeo--roving-target="item" tabindex="0">B</button>
        <button id="c" data-stimeo--roving-target="item" tabindex="-1">C</button>
      </div>`;
    query("#a").focus();
    application = Application.start();
    application.register("stimeo--roving", RovingController);
    await tick();
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("normalises several authored tab stops to the first one", async () => {
    await mount("", ["0", "0", "-1"]);
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("ignores a keydown from a non-item child of the container", async () => {
    await mount("", ["-1", "0", "-1"]);
    const note = document.createElement("span");
    note.id = "note";
    group().appendChild(note);
    expect(
      note.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      ),
    ).toBe(true);
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("resolves an event raised inside an item to that item", async () => {
    await mount();
    const icon = document.createElement("span");
    query("#c").appendChild(icon);
    icon.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(tabindexes()).toEqual([-1, -1, 0]);
    expect(
      icon.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
      ),
    ).toBe(false);
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("drops a runtime-added item's own tab stop before reconciling", async () => {
    await mount("", ["-1", "0", "-1"]);
    const d = document.createElement("button");
    d.id = "d";
    d.setAttribute("data-stimeo--roving-target", "item");
    d.tabIndex = 0;
    d.textContent = "D";
    // Inserted BEFORE the current stop: without the immediate demotion the batch
    // would read the newcomer back as the existing stop.
    group().insertBefore(d, query("#a"));
    await tick();
    expect([query("#d").tabIndex, query("#a").tabIndex, query("#b").tabIndex]).toEqual([-1, -1, 0]);
  });

  it("keeps the tab stop across an in-page move", async () => {
    await mount("", ["-1", "-1", "0"]);
    const g = group();
    g.remove();
    await tick();
    document.body.appendChild(g);
    await tick();
    expect(tabindexes()).toEqual([-1, -1, 0]);
  });

  it("drops a pending reconciliation when it disconnects", async () => {
    await mount("", ["-1", "0", "-1"]);
    const g = group();
    const a = query("#a");
    const b = query("#b");
    query("#c").remove(); // queues a reconciliation
    g.remove(); // disconnect() must drop it
    a.tabIndex = 0; // an outside write the cancelled pass would normalise away
    await tick();
    expect([a.tabIndex, b.tabIndex]).toEqual([0, 0]);
  });

  it("establishes and re-establishes the tab stop without emitting change", async () => {
    const changes: Event[] = [];
    const listener = (event: Event) => changes.push(event);
    document.addEventListener("stimeo--roving:change", listener);
    try {
      await mount("", ["-1", "-1", "-1"]); // connect establishes the stop
      expect(tabindexes()).toEqual([0, -1, -1]);
      expect(changes).toEqual([]);

      query("#a").remove(); // reconciliation moves it
      await tick();
      expect(query("#b").tabIndex).toBe(0);
      expect(changes).toEqual([]);
    } finally {
      document.removeEventListener("stimeo--roving:change", listener);
    }
  });

  it("stays put when the only item past the end is unreachable", async () => {
    await mount('data-stimeo--roving-wrap-value="false"', ["-1", "0", "-1"], ["", "", "disabled"]);
    expect(arrow("#b", "ArrowRight")).toBe(false); // consumed: the axis is ours
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("stays on the only reachable item when wrapping", async () => {
    await mount("", ["-1", "0", "-1"], ["disabled", "", "disabled"]);
    expect(arrow("#b", "ArrowRight")).toBe(false);
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("keeps a tab stop when the group connects inside a hidden region", async () => {
    // The reachability walk stops at the container: a group inside a hidden
    // ancestor is already out of the Tab order, and calling every item
    // unreachable would leave nothing to restore the stop when it reopens.
    document.body.innerHTML = `
      <div id="panel" hidden>
        <div id="group" data-controller="stimeo--roving">
          <button id="a" data-stimeo--roving-target="item" tabindex="-1">A</button>
          <button id="b" data-stimeo--roving-target="item" tabindex="-1">B</button>
          <button id="c" data-stimeo--roving-target="item" tabindex="-1">C</button>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--roving", RovingController);
    await tick();
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("leaves the key and the DOM alone when no item is reachable", async () => {
    // Nothing to move to, and nothing to establish: the authored attributes stay
    // as they are so the stop comes back when an item becomes reachable again.
    await mount("", ["-1", "0", "-1"], ["disabled", "disabled", "disabled"]);
    expect(tabindexes()).toEqual([-1, 0, -1]);
    expect(arrow("#b", "ArrowRight")).toBe(true);
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("ignores focusin raised outside the item set", async () => {
    await mount();
    group().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("escapes when the key comes from an item that cannot hold the stop", async () => {
    await mount(
      'data-stimeo--roving-wrap-value="false"',
      ["0", "-1", "-1"],
      ["", "disabled", "disabled"],
    );
    arrow("#c", "ArrowRight"); // unreachable origin with nothing reachable past it
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("keeps a non-form item reachable inside a disabled fieldset", async () => {
    // `disabled` on a fieldset disables the form controls it contains, not every
    // element, so a span item stays in the roving set.
    document.body.innerHTML = `
      <fieldset disabled>
        <div id="group" data-controller="stimeo--roving">
          <span id="a" data-stimeo--roving-target="item" tabindex="-1">A</span>
          <span id="b" data-stimeo--roving-target="item" tabindex="-1">B</span>
          <span id="c" data-stimeo--roving-target="item" tabindex="-1">C</span>
        </div>
      </fieldset>`;
    application = Application.start();
    application.register("stimeo--roving", RovingController);
    await tick();
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("has no a11y violations", async () => {
    await mount();
    await expectNoA11yViolations(group());
  });
});
