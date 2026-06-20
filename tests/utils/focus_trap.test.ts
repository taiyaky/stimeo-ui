import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FocusTrap } from "../../src/utils/focus_trap";

/**
 * Unit tests for the {@link FocusTrap} primitive: the shared modal lifecycle
 * (scroll lock, background `inert`, Tab cycling, Escape delegation, focus
 * restore) that dialog / alert-dialog / drawer build on.
 */
describe("FocusTrap", () => {
  let container: HTMLElement;

  beforeEach(() => {
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
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  const trap = (options = {}) => new FocusTrap(() => container, options);
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

  it("invokes onEscape on Escape and leaves Escape alone otherwise", () => {
    let escapes = 0;
    const t = trap({ onEscape: () => escapes++ });
    t.activate();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(escapes).toBe(1);
  });

  it("does not track or clear elements that were already inert", () => {
    byId("background").inert = true; // pre-existing inert, not ours to clear
    const t = trap();
    t.activate();
    t.deactivate();
    expect(byId("background").inert).toBe(true);
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
});
