import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EscapeLayer } from "../../src/utils/escape_layer";
import { FocusTrap, type FocusTrapOptions } from "../../src/utils/focus_trap";

/**
 * Unit tests for the {@link FocusTrap} primitive: the shared modal lifecycle
 * (scroll lock, background `inert`, Tab cycling, Escape delegation, focus
 * restore) that dialog / alert-dialog / drawer build on.
 */
describe("FocusTrap", () => {
  let container: HTMLElement;
  let traps: FocusTrap[];

  beforeEach(() => {
    traps = [];
    document.body.innerHTML = `
      <p id="background">Background</p>
      <button id="opener">Open</button>
      <div id="box">
        <button id="first">First</button>
        <button id="last">Last</button>
      </div>`;
    container = document.getElementById("box") as HTMLElement;
  });

  afterEach(() => {
    for (const activeTrap of traps) activeTrap.deactivate({ restoreFocus: false });
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  const trap = (options: FocusTrapOptions = {}) => {
    const instance = new FocusTrap(() => container, options);
    traps.push(instance);
    return instance;
  };
  const byId = (id: string) => document.getElementById(id) as HTMLElement;

  it("locks body scroll and isolates background siblings on activate", () => {
    const t = trap();
    t.activate();
    expect(t.active).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    expect(byId("background").inert).toBe(true);
    expect(byId("opener").inert).toBe(true);
  });

  it("moves focus to the first focusable element on activate", () => {
    trap().activate();
    expect(document.activeElement).toBe(byId("first"));
  });

  it("uses the shared Tab-stop rules when choosing initial focus", () => {
    container.innerHTML = `
      <fieldset disabled><button id="blocked">Blocked</button></fieldset>
      <div id="editor" contenteditable>Edit</div>
      <details><summary id="summary">More</summary></details>`;

    trap().activate();

    expect(document.activeElement).toBe(byId("editor"));
  });

  it("prefers the initialFocus element when provided", () => {
    trap({ initialFocus: () => byId("last") }).activate();
    expect(document.activeElement).toBe(byId("last"));
  });

  it("falls back to the container itself when it has no focusable children", () => {
    container.innerHTML = "Just text";
    trap().activate();
    expect(document.activeElement).toBe(container);
    expect(container.tabIndex).toBe(-1);
  });

  it("restores scroll, background, and focus on deactivate", () => {
    byId("opener").focus();
    const t = trap();
    t.activate();
    t.deactivate();
    expect(t.active).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(byId("background").inert).toBe(false);
    expect(document.activeElement).toBe(byId("opener"));
  });

  it("uses fallbackFocus only when nothing was focused before activation", () => {
    // Nothing is focused before activate (body), so the fallback is used on close.
    const t = trap({ fallbackFocus: () => byId("opener") });
    t.activate();
    t.deactivate();
    expect(document.activeElement).toBe(byId("opener"));
  });

  it("does not restore focus when deactivated with restoreFocus: false", () => {
    byId("opener").focus();
    const t = trap();
    t.activate();
    t.deactivate({ restoreFocus: false });
    // Focus is left wherever it was (the first item), not yanked back to opener.
    expect(document.activeElement).not.toBe(byId("opener"));
  });

  it("cycles Tab from the last focusable back to the first", () => {
    const t = trap();
    t.activate();
    byId("last").focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(byId("first"));
  });

  it("cycles Shift+Tab from the first focusable to the last", () => {
    const t = trap();
    t.activate();
    byId("first").focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }));
    expect(document.activeElement).toBe(byId("last"));
  });

  it("pulls focus back inside when it has escaped the container", () => {
    const t = trap();
    t.activate();
    byId("opener").focus(); // escaped (opener is inert, but force focus for the test)
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(byId("first"));
  });

  it("invokes onEscape and prevents the handled Escape", () => {
    let escapes = 0;
    const t = trap({ onEscape: () => escapes++ });
    t.activate();
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    document.dispatchEvent(event);
    expect(escapes).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves Escape alone when no onEscape callback is provided", () => {
    const t = trap();
    t.activate();
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });

    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(t.active).toBe(true);
  });

  it("does not handle Escape already consumed by a nested component", () => {
    let escapes = 0;
    const t = trap({ onEscape: () => escapes++ });
    t.activate();
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    event.preventDefault();

    document.dispatchEvent(event);

    expect(escapes).toBe(0);
    expect(t.active).toBe(true);
  });

  it("lets the most recently activated trap own Escape", () => {
    let outerEscapes = 0;
    let innerEscapes = 0;
    const flags = { lockScroll: false, isolate: false, autoFocus: false };
    const outer = trap({ ...flags, onEscape: () => outerEscapes++ });
    const inner = trap({
      ...flags,
      onEscape: () => {
        innerEscapes++;
        inner.deactivate({ restoreFocus: false });
      },
    });
    outer.activate();
    inner.activate();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(innerEscapes).toBe(1);
    expect(outerEscapes).toBe(0);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(outerEscapes).toBe(1);
  });

  it("leaves Escape ownership to lower layers when it has no onEscape", () => {
    let escapes = 0;
    const flags = { lockScroll: false, isolate: false, autoFocus: false };
    const owner = trap({ ...flags, onEscape: () => escapes++ });
    const silent = trap(flags); // no onEscape — must never join the Escape stack
    owner.activate();
    silent.activate();

    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    document.dispatchEvent(event);

    // The silent trap neither consumes the press nor blocks the layer below it.
    expect(escapes).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps trapping Tab while a newer document layer owns Escape", () => {
    let escapes = 0;
    let aboveDismissed = 0;
    const t = trap({ onEscape: () => escapes++ });
    t.activate();
    const above = new EscapeLayer();
    above.activate(document, { onDismiss: () => aboveDismissed++ });

    // Escape belongs to the newer layer: the shared resolver consumes the press
    // and dismisses it, never the trap below …
    const escapePress = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    document.dispatchEvent(escapePress);
    expect(escapes).toBe(0);
    expect(aboveDismissed).toBe(1);
    expect(escapePress.defaultPrevented).toBe(true);

    // … but the Tab cycle is owned by trap activation, not Escape ownership.
    byId("last").focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId("first"));

    above.deactivate();
  });

  it("does not track or clear elements that were already inert", () => {
    byId("background").inert = true; // pre-existing inert, not ours to clear
    const t = trap();
    t.activate();
    t.deactivate();
    expect(byId("background").inert).toBe(true);
  });

  it("does not pull focus back when deactivate runs again after closing", () => {
    // Controllers call deactivate() defensively from both close() and disconnect().
    // The opener is still remembered after the first call, so a second one that
    // reached the restore path would yank focus away from wherever the user moved.
    byId("opener").focus();
    const t = trap();
    t.activate();
    t.deactivate();
    expect(document.activeElement).toBe(byId("opener"));

    byId("last").focus();
    t.deactivate();
    expect(document.activeElement).toBe(byId("last"));
  });

  it("leaves a non-HTML background sibling untouched", () => {
    // `inert` is an HTMLElement property; an SVG root at body level would only
    // collect a stray expando and get tracked for a release that means nothing.
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    document.body.append(svg);
    const t = trap();

    t.activate();

    expect(byId("background").inert).toBe(true);
    expect((svg as unknown as { inert?: boolean }).inert).toBeUndefined();
  });

  it("drops the keydown listener on deactivate", () => {
    let escapes = 0;
    const t = trap({ onEscape: () => escapes++ });
    t.activate();
    t.deactivate();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(escapes).toBe(0);
  });

  it("is idempotent: repeated activate / deactivate are no-ops", () => {
    const t = trap();
    t.activate();
    const overflowAfterFirst = document.body.style.overflow;
    t.activate(); // second activate must not re-snapshot the (now locked) overflow
    t.deactivate();
    t.deactivate();
    expect(overflowAfterFirst).toBe("hidden");
    expect(document.body.style.overflow).toBe("");
  });

  it("reverts the side effects on turbo:before-cache without restoring focus (snapshot hygiene)", () => {
    // Leaving the page with the trap active must not bake the scroll lock /
    // inert into the snapshot Turbo caches; focus is left alone mid-navigation.
    byId("opener").focus();
    let escapes = 0;
    const t = trap({ onEscape: () => escapes++ });
    t.activate();
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(t.active).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(byId("background").inert).toBe(false);
    expect(document.activeElement).not.toBe(byId("opener")); // no focus yank
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(escapes).toBe(0); // keydown listener dropped with the rest
  });

  it("re-activates against a clean baseline after a before-cache deactivation", () => {
    // The restore cycle hazard: without the before-cache hook the cached
    // body[style] feeds "hidden" back into activate() as the baseline, and
    // deactivate() then "restores" the lock forever.
    const t = trap();
    t.activate();
    document.dispatchEvent(new Event("turbo:before-cache")); // navigate away
    t.activate(); // reopened after a history restore
    t.deactivate();
    expect(document.body.style.overflow).toBe(""); // unlocked, not stuck
  });
});
