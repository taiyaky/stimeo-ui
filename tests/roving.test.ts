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

  const mount = async (attrs = "", tabindexes: [string, string, string] = ["0", "-1", "-1"]) => {
    document.body.innerHTML = `
      <button id="outside">outside</button>
      <div id="group" data-controller="stimeo--roving" ${attrs}>
        <button id="a" data-stimeo--roving-target="item" tabindex="${tabindexes[0]}">A</button>
        <button id="b" data-stimeo--roving-target="item" tabindex="${tabindexes[1]}">B</button>
        <button id="c" data-stimeo--roving-target="item" tabindex="${tabindexes[2]}">C</button>
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
  const arrow = (from: string, key: string) =>
    query(from).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

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
    arrow("#a", "ArrowRight");
    expect(tabindexes()).toEqual([-1, 0, -1]);
    expect(document.activeElement).toBe(query("#b"));

    arrow("#b", "ArrowLeft");
    expect(tabindexes()).toEqual([0, -1, -1]);
    expect(document.activeElement).toBe(query("#a"));
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

    await mount('data-stimeo--roving-home-end-value="false"');
    arrow("#a", "End"); // ignored
    expect(tabindexes()).toEqual([0, -1, -1]);
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
    d.tabIndex = -1;
    d.textContent = "D";
    group().appendChild(d);
    await tick(); // let Stimulus pick up the new target

    arrow("#a", "End"); // last is now D
    expect(document.activeElement).toBe(query("#d"));
    expect(query("#d").tabIndex).toBe(0);
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
  });

  it("has no a11y violations", async () => {
    await mount();
    await expectNoA11yViolations(group());
  });
});
