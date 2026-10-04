import { afterEach, describe, expect, it, vi } from "vitest";
import { NUMBER_BOUNDS } from "../../src/utils/number_bounds";
import { NumberValueReader } from "../../src/utils/number_value";

afterEach(() => vi.restoreAllMocks());

/** Invalid declarations warn once per consecutive raw literal and Value. */
describe("NumberValueReader", () => {
  const owner = () => {
    const element = document.createElement("div");
    return { identifier: "stimeo--sample", element };
  };

  it("does not warn for an absent declaration or a valid authored value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reader = new NumberValueReader();
    const controller = owner();
    expect(reader.read(controller, "delay", Number.NaN, 7, NUMBER_BOUNDS.positive)).toBe(7);
    controller.element.setAttribute("data-stimeo--sample-delay-value", "2");
    expect(reader.read(controller, "delay", 2, 7, NUMBER_BOUNDS.positive)).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns with identifier, Value and raw declaration, then suppresses a consecutive repeat", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reader = new NumberValueReader();
    const controller = owner();
    controller.element.setAttribute("data-stimeo--sample-delay-value", "-1");
    expect(reader.read(controller, "delay", -1, 7, NUMBER_BOUNDS.positive)).toBe(7);
    expect(reader.read(controller, "delay", -1, 7, NUMBER_BOUNDS.positive)).toBe(7);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("stimeo--sample");
    expect(warn.mock.calls[0]?.[0]).toContain("delay");
    expect(warn.mock.calls[0]?.[0]).toContain("-1");
  });

  it("warns for each changed bad literal and again after an accepted or absent declaration", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reader = new NumberValueReader();
    const controller = owner();
    const attribute = "data-stimeo--sample-delay-value";
    controller.element.setAttribute(attribute, "-1");
    reader.read(controller, "delay", -1, 7, NUMBER_BOUNDS.positive);
    controller.element.setAttribute(attribute, "-01");
    reader.read(controller, "delay", -1, 7, NUMBER_BOUNDS.positive);
    controller.element.setAttribute(attribute, "2");
    reader.read(controller, "delay", 2, 7, NUMBER_BOUNDS.positive);
    controller.element.setAttribute(attribute, "-01");
    reader.read(controller, "delay", -1, 7, NUMBER_BOUNDS.positive);
    controller.element.removeAttribute(attribute);
    reader.read(controller, "delay", Number.NaN, 7, NUMBER_BOUNDS.positive);
    controller.element.setAttribute(attribute, "-01");
    reader.read(controller, "delay", -1, 7, NUMBER_BOUNDS.positive);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("keeps a bounded history by Value and preserves it across a same-instance reconnect", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reader = new NumberValueReader();
    const controller = owner();
    controller.element.setAttribute("data-stimeo--sample-first-value", "bad");
    controller.element.setAttribute("data-stimeo--sample-second-value", "bad");
    reader.read(controller, "first", Number.NaN, 0, NUMBER_BOUNDS.finite);
    reader.read(controller, "second", Number.NaN, 0, NUMBER_BOUNDS.finite);
    controller.element.remove();
    document.body.append(controller.element);
    reader.read(controller, "first", Number.NaN, 0, NUMBER_BOUNDS.finite);
    expect(warn).toHaveBeenCalledTimes(2);
    const nextInstance = new NumberValueReader();
    nextInstance.read(controller, "first", Number.NaN, 0, NUMBER_BOUNDS.finite);
    expect(warn).toHaveBeenCalledTimes(3);
    controller.element.remove();
  });

  it("looks up a camelCase Value under its Stimulus kebab-case attribute", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reader = new NumberValueReader();
    const controller = owner();
    controller.element.setAttribute("data-stimeo--sample-min-score-value", "-1");
    expect(reader.read(controller, "minScore", -1, 0, NUMBER_BOUNDS.nonNegative)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
