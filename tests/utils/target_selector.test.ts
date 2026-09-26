import { describe, expect, it } from "vitest";
import { targetSelector } from "../../src/utils/target_selector";

/**
 * Behavioral tests for {@link targetSelector}: that the selector it builds matches an
 * element declaring the name among several, and follows the registered identifier.
 */
describe("target selector", () => {
  const mount = (html: string): HTMLElement => {
    document.body.innerHTML = html;
    return document.body;
  };

  it("matches an element that declares the name alongside others", () => {
    const root = mount(`<li data-stimeo--calendar-target="day selected">3</li>`);

    expect(root.querySelector(targetSelector("stimeo--calendar", "day"))).not.toBeNull();
    expect(root.querySelector(targetSelector("stimeo--calendar", "selected"))).not.toBeNull();
  });

  it("matches an element that declares the name alone", () => {
    const root = mount(`<li data-stimeo--calendar-target="day">3</li>`);

    expect(root.querySelector(targetSelector("stimeo--calendar", "day"))).not.toBeNull();
  });

  it("does not match a name that is only part of a declared one", () => {
    const root = mount(`<li data-stimeo--calendar-target="dayLabel">3</li>`);

    expect(root.querySelector(targetSelector("stimeo--calendar", "day"))).toBeNull();
  });

  it("builds the selector in the namespace of the identifier it is given", () => {
    expect(targetSelector("widgets--planner", "day")).toBe('[data-widgets--planner-target~="day"]');
  });
});
