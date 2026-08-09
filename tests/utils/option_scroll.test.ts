import { describe, expect, it, vi } from "vitest";
import { scrollOptionIntoView } from "../../src/utils/option_scroll";

/**
 * Unit tests for {@link scrollOptionIntoView}. happy-dom has no layout, so the
 * rect/size INPUTS are modeled per case — this pins the delta logic (the only
 * thing the helper owns); real geometry belongs to a real browser.
 */

/** A list/option pair with modeled scroll metrics and rects. */
function fixture(listRect: DOMRect, optionRect: DOMRect, scrollable = true) {
  const list = document.createElement("ul");
  const option = document.createElement("li");
  list.appendChild(option);
  Object.defineProperties(list, {
    scrollHeight: { value: scrollable ? 200 : 80, configurable: true },
    clientHeight: { value: 80, configurable: true },
  });
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue(listRect);
  vi.spyOn(option, "getBoundingClientRect").mockReturnValue(optionRect);
  return { list, option };
}

describe("scrollOptionIntoView", () => {
  it("scrolls down by the exact overflow when the option is below the view", () => {
    const { list, option } = fixture(new DOMRect(0, 0, 100, 80), new DOMRect(0, 100, 100, 40));
    scrollOptionIntoView(list, option);
    expect(list.scrollTop).toBe(60); // bottom 140 - list bottom 80
  });

  it("scrolls up by the exact overflow when the option is above the view", () => {
    const { list, option } = fixture(new DOMRect(0, 50, 100, 80), new DOMRect(0, 10, 100, 40));
    list.scrollTop = 100;
    scrollOptionIntoView(list, option);
    expect(list.scrollTop).toBe(60); // 100 - (list top 50 - option top 10)
  });

  it("leaves scrollTop alone when the option is already fully visible", () => {
    const { list, option } = fixture(new DOMRect(0, 0, 100, 80), new DOMRect(0, 20, 100, 40));
    list.scrollTop = 30;
    scrollOptionIntoView(list, option);
    expect(list.scrollTop).toBe(30);
  });

  it("no-ops entirely when the list does not scroll", () => {
    const { list, option } = fixture(
      new DOMRect(0, 0, 100, 80),
      new DOMRect(0, 100, 100, 40),
      false,
    );
    scrollOptionIntoView(list, option);
    expect(list.scrollTop).toBe(0);
  });
});
