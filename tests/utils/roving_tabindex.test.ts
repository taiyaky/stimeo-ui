import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RovingTabindex, rovingMove } from "../../src/utils/roving_tabindex";

/**
 * Unit tests for the {@link RovingTabindex} primitive and the pure
 * {@link rovingMove} index helper: the mechanical half of the APG
 * roving-tabindex pattern (one tabbable item, focus follows) with no per-widget
 * policy baked in.
 */
describe("RovingTabindex", () => {
  let items: HTMLElement[];

  beforeEach(() => {
    document.body.innerHTML = `
      <div role="radio" tabindex="0">A</div>
      <div role="radio" tabindex="-1">B</div>
      <div role="radio" tabindex="-1">C</div>`;
    items = Array.from(document.querySelectorAll<HTMLElement>("[role='radio']"));
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  const roving = () => new RovingTabindex(() => items);

  it("makes exactly one item tabbable and removes the rest", () => {
    roving().setActive(2);
    expect(items.map((item) => item.tabIndex)).toEqual([-1, -1, 0]);
  });

  it("reports the active index", () => {
    const r = roving();
    r.setActive(1);
    expect(r.activeIndex).toBe(1);
  });

  it("returns -1 as the active index when nothing is tabbable", () => {
    const r = roving();
    r.setActive(-1);
    expect(items.map((item) => item.tabIndex)).toEqual([-1, -1, -1]);
    expect(r.activeIndex).toBe(-1);
  });

  it("moves DOM focus only when requested", () => {
    const r = roving();
    r.setActive(1, { focus: false });
    expect(document.activeElement).not.toBe(items[1]);
    r.setActive(2, { focus: true });
    expect(document.activeElement).toBe(items[2]);
  });

  it("reads items lazily so a changed target list is honored", () => {
    const r = roving();
    items.push(document.createElement("div"));
    document.body.appendChild(items[3] as HTMLElement);
    r.setActive(3);
    expect(items[3]?.tabIndex).toBe(0);
    expect(r.activeIndex).toBe(3);
  });
});

describe("rovingMove", () => {
  it("steps forward and backward", () => {
    expect(rovingMove(0, 3, 1, "wrap")).toBe(1);
    expect(rovingMove(2, 3, -1, "wrap")).toBe(1);
  });

  it("wraps around both ends in wrap mode", () => {
    expect(rovingMove(2, 3, 1, "wrap")).toBe(0);
    expect(rovingMove(0, 3, -1, "wrap")).toBe(2);
  });

  it("stops at both ends in clamp mode", () => {
    expect(rovingMove(2, 3, 1, "clamp")).toBe(2);
    expect(rovingMove(0, 3, -1, "clamp")).toBe(0);
  });

  it("returns -1 for an empty set", () => {
    expect(rovingMove(0, 0, 1, "wrap")).toBe(-1);
    expect(rovingMove(0, 0, -1, "clamp")).toBe(-1);
  });
});
