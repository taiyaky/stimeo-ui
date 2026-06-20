import { describe, expect, it } from "vitest";
import {
  actionDescriptors,
  actionIdentifiers,
  controllerIdentifiers,
  dasherize,
  isStimeoDataAttr,
  parseTargetAttr,
  parseValueAttr,
} from "../../src/inspector/extract";

/** Tests for the namespace-scoped attribute decoders. */
describe("extract helpers", () => {
  it("dasherizes camelCase value names like Stimulus", () => {
    expect(dasherize("rootMargin")).toBe("root-margin");
    expect(dasherize("selectionFollowsFocus")).toBe("selection-follows-focus");
    expect(dasherize("length")).toBe("length");
  });

  it("extracts only stimeo-- controller identifiers", () => {
    expect(controllerIdentifiers("stimeo--menu other--thing stimeo--otp")).toEqual([
      "stimeo--menu",
      "stimeo--otp",
    ]);
    expect(controllerIdentifiers("my-own-controller")).toEqual([]);
  });

  it("collapses duplicate identifiers, preserving first-seen order", () => {
    expect(controllerIdentifiers("stimeo--tabs stimeo--tabs stimeo--menu")).toEqual([
      "stimeo--tabs",
      "stimeo--menu",
    ]);
  });

  it("parses target attribute identifiers, including hyphenated ones", () => {
    expect(parseTargetAttr("data-stimeo--menu-target")).toBe("stimeo--menu");
    expect(parseTargetAttr("data-stimeo--command-palette-target")).toBe("stimeo--command-palette");
    expect(parseTargetAttr("data-other-target")).toBeNull();
    expect(parseTargetAttr("data-stimeo--menu-length-value")).toBeNull();
  });

  it("resolves value attributes against known identifiers (longest match)", () => {
    const known = ["stimeo--otp", "stimeo--command-palette", "stimeo--scrollspy"];
    expect(parseValueAttr("data-stimeo--otp-length-value", known)).toEqual({
      identifier: "stimeo--otp",
      valueToken: "length",
    });
    expect(parseValueAttr("data-stimeo--scrollspy-root-margin-value", known)).toEqual({
      identifier: "stimeo--scrollspy",
      valueToken: "root-margin",
    });
    expect(parseValueAttr("data-stimeo--command-palette-hotkey-value", known)).toEqual({
      identifier: "stimeo--command-palette",
      valueToken: "hotkey",
    });
  });

  it("returns a null identifier for unknown value-attribute controllers", () => {
    const parsed = parseValueAttr("data-stimeo--menoo-length-value", ["stimeo--menu"]);
    expect(parsed?.identifier).toBeNull();
  });

  it("returns null for non-value attributes", () => {
    expect(parseValueAttr("data-stimeo--menu-target", ["stimeo--menu"])).toBeNull();
  });

  it("extracts stimeo identifiers from data-action descriptors", () => {
    expect(
      actionIdentifiers("click->stimeo--menu#toggle keydown->stimeo--menu#onItemKeydown"),
    ).toEqual(["stimeo--menu", "stimeo--menu"]);
    // Default-event form and non-stimeo controllers.
    expect(actionIdentifiers("stimeo--otp#onInput resize@window->other#x")).toEqual([
      "stimeo--otp",
    ]);
  });

  it("decodes stimeo data-action descriptors into identifier + method", () => {
    expect(
      actionDescriptors("click->stimeo--menu#toggle keydown->stimeo--menu#onItemKeydown"),
    ).toEqual([
      { identifier: "stimeo--menu", method: "toggle" },
      { identifier: "stimeo--menu", method: "onItemKeydown" },
    ]);
    // Default-event form, non-stimeo controllers skipped, options stripped.
    expect(actionDescriptors("stimeo--otp#onInput resize@window->other#x")).toEqual([
      { identifier: "stimeo--otp", method: "onInput" },
    ]);
    expect(actionDescriptors("click->stimeo--dialog#close:prevent")).toEqual([
      { identifier: "stimeo--dialog", method: "close" },
    ]);
  });

  it("recognizes stimeo data attributes", () => {
    expect(isStimeoDataAttr("data-stimeo--menu-target")).toBe(true);
    expect(isStimeoDataAttr("data-controller")).toBe(false);
  });
});
