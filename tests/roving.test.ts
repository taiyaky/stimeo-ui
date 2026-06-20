import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RovingController } from "../src/controllers/roving_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link RovingController}: the single tab stop and its
 * idempotent connect (DOM is the source of truth), arrow-key movement per
 * orientation, wrap/clamp, Home/End, the `focusin` sync for click/programmatic
 * focus, the `change` event, dynamic items, and listener teardown.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    application?.stop();
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
