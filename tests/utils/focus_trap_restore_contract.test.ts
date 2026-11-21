import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FocusTrap } from "../../src/utils/focus_trap";

/** Focus restoration depends on the container that held focus when a trap opened. */
describe("FocusTrap restore ownership", () => {
  let traps: FocusTrap[];

  beforeEach(() => {
    traps = [];
    document.body.innerHTML = `
      <button id="x">X</button>
      <div id="a"><button id="a1">A1</button></div>
      <div id="b"><button id="b1">B1</button></div>`;
  });

  afterEach(() => {
    for (const trap of traps) trap.deactivate({ restoreFocus: false });
    document.body.innerHTML = "";
  });

  /** The fixture element with `id`. */
  const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

  /** Opens a soft focus scope, keeping the page's buttons available for restoration. */
  const layer = (id: string): FocusTrap => {
    const element = byId(id);
    const trap = new FocusTrap(() => element, { lockScroll: false, isolate: false });
    traps.push(trap);
    return trap;
  };

  it.each([
    ["inside the earlier trap", false, "x"],
    ["body outside the earlier trap", true, ""],
  ])("restores the way back owned by an origin at %s", (_, blurBeforeOpening, expectedId) => {
    byId("x").focus();
    const a = layer("a");
    a.activate();
    expect(document.activeElement).toBe(byId("a1"));

    if (blurBeforeOpening) byId("a1").blur();
    expect(document.activeElement).toBe(blurBeforeOpening ? document.body : byId("a1"));
    const b = layer("b");
    b.activate();
    expect(document.activeElement).toBe(byId("b1"));

    byId("a").hidden = true;
    a.deactivate({ restoreFocus: false });
    expect(a.active).toBe(false);
    expect(b.active).toBe(true);
    expect(document.activeElement).toBe(byId("b1"));

    // A closing scope drops focus before restoration; happy-dom needs an explicit blur.
    byId("b1").blur();
    byId("b").hidden = true;
    expect(document.activeElement).toBe(document.body);
    b.deactivate();

    expect(b.active).toBe(false);
    expect(document.activeElement).toBe(expectedId ? byId(expectedId) : document.body);
  });
});
