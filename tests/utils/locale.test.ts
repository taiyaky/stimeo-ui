import { afterEach, describe, expect, it } from "vitest";
import { resolveLocale } from "../../src/utils/locale";

/**
 * Behavioral tests for {@link resolveLocale}: that a declaration outranks every
 * `lang`, that the nearest `lang` wins over a farther one, and that an empty
 * `lang` stops the inheritance instead of letting a farther one through.
 */
describe("resolveLocale", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("lang");
  });

  /** Renders `html` into the body and returns the element marked `id="target"`. */
  const target = (html: string): Element => {
    document.body.innerHTML = html;
    const found = document.getElementById("target");
    if (!found) throw new Error("Fixture has no #target");
    return found;
  };

  it("prefers the declaration over every lang, including the element's own", () => {
    const element = target('<div lang="en"><time id="target" lang="en"></time></div>');

    expect(resolveLocale(element, "ja")).toBe("ja");
  });

  it("takes the element's own lang when nothing is declared", () => {
    const element = target('<div lang="en"><time id="target" lang="ja"></time></div>');

    expect(resolveLocale(element)).toBe("ja");
  });

  it("walks up to the nearest ancestor that carries a lang", () => {
    const element = target('<div lang="ja"><section><time id="target"></time></section></div>');

    expect(resolveLocale(element)).toBe("ja");
  });

  it("lets a nearer ancestor win over a farther one", () => {
    document.documentElement.lang = "en";
    const element = target('<div lang="ja"><time id="target"></time></div>');

    expect(resolveLocale(element)).toBe("ja");
  });

  it("stops at an empty lang instead of reaching a farther one", () => {
    // An empty `lang` says the language is unknown, so the runtime default is
    // the answer — the enclosing Japanese does not apply to this subtree.
    document.documentElement.lang = "en";
    const element = target(
      '<div lang="ja"><section lang=""><time id="target"></time></section></div>',
    );

    expect(resolveLocale(element)).toBeUndefined();
  });

  it("resolves to the runtime default when no lang is in scope", () => {
    const element = target('<div><time id="target"></time></div>');

    expect(resolveLocale(element)).toBeUndefined();
    expect(resolveLocale(element, "")).toBeUndefined();
  });

  it("reads the lang of a detached subtree, and nothing from a bare element", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("lang", "fr");
    const inner = document.createElement("time");
    wrapper.append(inner);

    expect(resolveLocale(inner)).toBe("fr");
    expect(resolveLocale(document.createElement("time"))).toBeUndefined();
  });
});
