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

  it("decodes stimeo data-action descriptors into identifier + method + event", () => {
    expect(
      actionDescriptors("click->stimeo--menu#toggle keydown->stimeo--menu#onItemKeydown"),
    ).toEqual([
      { identifier: "stimeo--menu", method: "toggle", eventType: "click" },
      { identifier: "stimeo--menu", method: "onItemKeydown", eventType: "keydown" },
    ]);
    // Default-event form, non-stimeo controllers skipped, options stripped.
    expect(actionDescriptors("stimeo--otp#onInput resize@window->other#x")).toEqual([
      { identifier: "stimeo--otp", method: "onInput", eventType: "" },
    ]);
    expect(actionDescriptors("click->stimeo--dialog#close:prevent")).toEqual([
      { identifier: "stimeo--dialog", method: "close", eventType: "click" },
    ]);
    // A global scope names the same event type as its element-bound spelling.
    expect(actionDescriptors("keydown@window->stimeo--dialog#close")).toEqual([
      { identifier: "stimeo--dialog", method: "close", eventType: "keydown" },
    ]);
  });

  it("resolves an omitted event from the host element, as Stimulus does", () => {
    // Stimulus fills the event in from the element when the descriptor leaves it
    // out, so a reader that skips that step sees a different binding than the
    // browser does.
    const on = (tag: string, inputType?: string) =>
      actionDescriptors("stimeo--otp#onInput", { tag, inputType })[0]?.eventType;

    expect(on("a")).toBe("click");
    expect(on("button")).toBe("click");
    expect(on("form")).toBe("submit");
    expect(on("details")).toBe("toggle");
    expect(on("select")).toBe("change");
    expect(on("textarea")).toBe("input");
    expect(on("input")).toBe("input");
    expect(on("input", "submit")).toBe("click");
    // A `type` that is not `submit` keeps the ordinary input default.
    expect(on("input", "checkbox")).toBe("input");
  });

  it("leaves the event empty for an element with no default of its own", () => {
    // Stimulus refuses to bind these, so the reader must not invent an event.
    for (const tag of ["li", "div", "span", "td"]) {
      expect(actionDescriptors("stimeo--menu#activate", { tag })[0]?.eventType).toBe("");
    }
  });

  it("keeps an explicit event whatever the host element is", () => {
    expect(actionDescriptors("keydown->stimeo--menu#activate", { tag: "form" })[0]?.eventType).toBe(
      "keydown",
    );
  });

  it("leaves the event empty when no host element is given", () => {
    // The identifier-only reader has no element to ask.
    expect(actionDescriptors("stimeo--otp#onInput")[0]?.eventType).toBe("");
  });

  it("recognizes stimeo data attributes", () => {
    expect(isStimeoDataAttr("data-stimeo--menu-target")).toBe(true);
    expect(isStimeoDataAttr("data-controller")).toBe(false);
  });
});
