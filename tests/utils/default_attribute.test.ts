import { describe, expect, it } from "vitest";
import { setDefaultAttribute } from "../../src/utils/default_attribute";

/** Contract tests for authored-value-preserving attribute defaults. */
describe("setDefaultAttribute", () => {
  it("writes and reports a missing attribute", () => {
    const element = document.createElement("div");

    expect(setDefaultAttribute(element, "role", "switch")).toBe(true);
    expect(element.getAttribute("role")).toBe("switch");
  });

  it("preserves and reports an authored value", () => {
    const element = document.createElement("div");
    element.setAttribute("role", "checkbox");

    expect(setDefaultAttribute(element, "role", "switch")).toBe(false);
    expect(element.getAttribute("role")).toBe("checkbox");
  });

  it("treats an authored empty attribute as present", () => {
    const element = document.createElement("form");
    element.setAttribute("novalidate", "");

    expect(setDefaultAttribute(element, "novalidate", "generated")).toBe(false);
    expect(element.getAttribute("novalidate")).toBe("");
  });
});
