import { afterEach, describe, expect, it } from "vitest";
import { logicalScrollMetrics, physicalScrollDelta } from "../../src/utils/logical_scroll";

/**
 * Stubs one horizontal scroll box because happy-dom has no layout engine.
 *
 * `direction` is set as an inline style: happy-dom does not map the `dir`
 * attribute onto the computed `direction`, so an attribute-based fixture would
 * silently read as LTR. Inheritance *does* work, which the ancestor case below
 * relies on.
 */
function horizontalBox(
  direction: "ltr" | "rtl",
  scrollLeft: number,
  { scrollWidth = 1000, clientWidth = 300 } = {},
): HTMLElement {
  const element = document.createElement("div");
  element.style.direction = direction;
  Object.defineProperties(element, {
    scrollWidth: { configurable: true, value: scrollWidth },
    clientWidth: { configurable: true, value: clientWidth },
    scrollLeft: { configurable: true, value: scrollLeft },
  });
  document.body.append(element);
  return element;
}

describe("logical scroll geometry", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("measures LTR horizontal distance from the left start edge", () => {
    expect(logicalScrollMetrics(horizontalBox("ltr", 300), true)).toEqual({
      position: 300,
      max: 700,
    });
  });

  it("normalizes negative RTL offsets from the right start edge", () => {
    expect(logicalScrollMetrics(horizontalBox("rtl", -300), true)).toEqual({
      position: 300,
      max: 700,
    });
  });

  it("clamps elastic overscroll beyond either edge", () => {
    expect(logicalScrollMetrics(horizontalBox("rtl", 40), true).position).toBe(0);
    expect(logicalScrollMetrics(horizontalBox("rtl", -900), true).position).toBe(700);
  });

  it("reports no room and pins the position when the content fits", () => {
    // Non-overflowing boxes must not produce a negative max or a stray position:
    // both consumers treat `max === 0` as "no room on either side".
    expect(
      logicalScrollMetrics(horizontalBox("ltr", 0, { scrollWidth: 300, clientWidth: 300 }), true),
    ).toEqual({ position: 0, max: 0 });
    // Even a bogus offset on a non-scrollable box clamps back to the start.
    expect(
      logicalScrollMetrics(horizontalBox("ltr", 40, { scrollWidth: 100, clientWidth: 300 }), true),
    ).toEqual({ position: 0, max: 0 });
  });

  it("resolves an rtl direction inherited from an ancestor", () => {
    // The authoring contract is `dir="rtl"` / a stylesheet on an ancestor, so the
    // util must read the *computed* direction rather than the element's own
    // declaration — an implementation reading `element.style.direction` fails here.
    const wrapper = document.createElement("div");
    wrapper.style.direction = "rtl";
    document.body.append(wrapper);
    const element = document.createElement("div");
    Object.defineProperties(element, {
      scrollWidth: { configurable: true, value: 1000 },
      clientWidth: { configurable: true, value: 300 },
      scrollLeft: { configurable: true, value: -300 },
    });
    wrapper.append(element);

    expect(logicalScrollMetrics(element, true)).toEqual({ position: 300, max: 700 });
    expect(physicalScrollDelta(element, true, 300)).toBe(-300);
  });

  it("reverses only RTL horizontal physical deltas", () => {
    expect(physicalScrollDelta(horizontalBox("ltr", 0), true, 300)).toBe(300);
    expect(physicalScrollDelta(horizontalBox("rtl", 0), true, 300)).toBe(-300);
    expect(physicalScrollDelta(horizontalBox("rtl", 0), false, 300)).toBe(300);
  });
});
