import { describe, expect, it } from "vitest";
import { matchingPart, readLabel, writeLabel } from "../../src/utils/element_part";

/**
 * Behavioral tests for {@link matchingPart}: that the root answers for a part it
 * carries itself, that a descendant answers otherwise, and that a tag name written
 * into the selector still narrows which element may answer.
 */
describe("matching part", () => {
  const mount = (html: string): HTMLElement => {
    document.body.innerHTML = html;
    return document.body.firstElementChild as HTMLElement;
  };

  it("returns the root when the root itself carries the part", () => {
    const root = mount(`<button data-part="remove">Remove Rails</button>`);

    expect(matchingPart(root, "[data-part~='remove']")).toBe(root);
  });

  it("returns the descendant when the root does not carry the part", () => {
    const root = mount(`<li><button data-part="remove">×</button></li>`);

    expect(matchingPart(root, "[data-part~='remove']")).toBe(root.firstElementChild);
  });

  it("prefers the root over a descendant that also carries the part", () => {
    const root = mount(`<button data-part="remove"><span data-part="remove"></span></button>`);

    expect(matchingPart(root, "[data-part~='remove']")).toBe(root);
  });

  it("holds the root to the tag the selector names", () => {
    // The composed selector carries a tag, so a row of the wrong element kind is not
    // its own button even though it carries the name.
    const root = mount(`<li data-part="remove"><button data-part="remove">×</button></li>`);

    expect(matchingPart(root, "button[data-part~='remove']")).toBe(root.firstElementChild);
  });

  it("resolves nothing when neither the root nor a descendant carries the part", () => {
    const root = mount(`<li><span>Rails</span></li>`);

    expect(matchingPart(root, "[data-part~='remove']")).toBeNull();
  });
});

describe("label slot", () => {
  const mount = (html: string): HTMLElement => {
    document.body.innerHTML = html;
    return document.body.firstElementChild as HTMLElement;
  };

  it("reads an ordinary slot whole", () => {
    const root = mount(`<span data-part="label">  Apple  </span>`);

    expect(readLabel(root)).toBe("Apple");
  });

  it("reads only the slot's own text when the slot holds the rest of the row", () => {
    // A row that is its own label keeps the remove button inside it, and the
    // button's glyph is not part of the label.
    const root = mount(`<li data-part="label">Apple<button>×</button></li>`);

    expect(root.textContent).toBe("Apple×");
    expect(readLabel(root)).toBe("Apple");
  });

  it("reads nothing from a missing slot", () => {
    expect(readLabel(null)).toBe("");
  });

  it("writes the label of such a row without taking the nested elements with it", () => {
    const root = mount(`<li data-part="label">Apple<button>×</button></li>`);

    writeLabel(root, "Green Apple");

    expect(readLabel(root)).toBe("Green Apple");
    expect(root.querySelector("button")).not.toBeNull();
  });

  it("round-trips a row whose text has not been written yet", () => {
    const root = mount(`<li data-part="label"><button>×</button></li>`);

    expect(readLabel(root)).toBe("");
    writeLabel(root, "Apple");

    expect(readLabel(root)).toBe("Apple");
    expect(root.querySelector("button")).not.toBeNull();
  });
});
