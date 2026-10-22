import { afterEach, describe, expect, it } from "vitest";
import { isAriaDisabled } from "../../src/utils/aria_disabled";

/**
 * Tests for {@link isAriaDisabled}: `aria-disabled="true"` on the element or on any
 * ancestor disables it, since ARIA defines the state for an element and every focusable
 * descendant. Only the element's own ancestry counts — not its descendants, not its
 * siblings.
 */
describe("isAriaDisabled", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("aria-disabled");
    document.body.innerHTML = "";
  });

  const fixture = (attributes: { outer?: string; middle?: string; leaf?: string } = {}) => {
    const attribute = (value: string | undefined) =>
      value === undefined ? "" : `aria-disabled="${value}"`;
    document.body.innerHTML = `
      <div id="outer" ${attribute(attributes.outer)}>
        <div id="middle" ${attribute(attributes.middle)}>
          <button id="leaf" ${attribute(attributes.leaf)}><span id="child">Run</span></button>
        </div>
        <button id="sibling">Other</button>
      </div>`;
    const at = (id: string) => document.getElementById(id) as HTMLElement;
    return { outer: at("outer"), middle: at("middle"), leaf: at("leaf"), child: at("child") };
  };

  it("answers false when nothing in the ancestry carries the state", () => {
    const { leaf } = fixture();
    expect(isAriaDisabled(leaf)).toBe(false);
  });

  it("answers true for the element's own aria-disabled", () => {
    const { leaf } = fixture({ leaf: "true" });
    expect(isAriaDisabled(leaf)).toBe(true);
  });

  it("answers true for the parent's aria-disabled", () => {
    const { leaf } = fixture({ middle: "true" });
    expect(isAriaDisabled(leaf)).toBe(true);
  });

  it("answers true for an aria-disabled more than one level up", () => {
    const { leaf } = fixture({ outer: "true" });
    expect(isAriaDisabled(leaf)).toBe(true);
  });

  it("walks to the document element", () => {
    const { leaf } = fixture();
    document.documentElement.setAttribute("aria-disabled", "true");
    expect(isAriaDisabled(leaf)).toBe(true);
  });

  it("keeps walking past an ancestor that says false", () => {
    const { leaf } = fixture({ outer: "true", middle: "false" });
    expect(isAriaDisabled(leaf)).toBe(true);
  });

  it("answers true under a disabled ancestor even when the element says false", () => {
    const { leaf } = fixture({ middle: "true", leaf: "false" });
    expect(isAriaDisabled(leaf)).toBe(true);
  });

  it.each(["false", "", "disabled"])("treats aria-disabled=%j as not disabled", (value) => {
    const { leaf } = fixture({ outer: value, middle: value, leaf: value });
    expect(isAriaDisabled(leaf)).toBe(false);
  });

  it("does not read the state from a descendant", () => {
    const { leaf, child } = fixture();
    child.setAttribute("aria-disabled", "true");
    expect(isAriaDisabled(leaf)).toBe(false);
  });

  it("does not read the state from a sibling", () => {
    const { leaf } = fixture();
    (document.getElementById("sibling") as HTMLElement).setAttribute("aria-disabled", "true");
    expect(isAriaDisabled(leaf)).toBe(false);
  });

  it("walks a detached tree to its own root", () => {
    const root = document.createElement("div");
    root.setAttribute("aria-disabled", "true");
    const leaf = document.createElement("button");
    root.append(document.createElement("div"));
    (root.firstElementChild as HTMLElement).append(leaf);

    expect(isAriaDisabled(leaf)).toBe(true);
    expect(isAriaDisabled(document.createElement("button"))).toBe(false);
  });
});
