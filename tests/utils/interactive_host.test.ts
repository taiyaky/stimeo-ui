import { afterEach, describe, expect, it } from "vitest";
import { isInteractiveHost } from "../../src/utils/interactive_host";

/** Behavioral tests for native activation and inherited editing-host detection. */
describe("isInteractiveHost", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const element = (id: string): HTMLElement => {
    const found = document.querySelector<HTMLElement>(`#${id}`);
    if (!found) throw new Error(`missing #${id}`);
    return found;
  };

  it("distinguishes native activation hosts from generic focusable elements", () => {
    document.body.innerHTML = `
      <button id="button" type="button">Button</button>
      <label id="label" for="field">Label</label>
      <input id="field">
      <a id="link" href="/settings">Link</a>
      <a id="anchor">Anchor</a>
      <div id="focusable" tabindex="0">Focusable</div>`;

    expect(isInteractiveHost(element("button"))).toBe(true);
    expect(isInteractiveHost(element("label"))).toBe(true);
    expect(isInteractiveHost(element("field"))).toBe(true);
    expect(isInteractiveHost(element("link"))).toBe(true);
    expect(isInteractiveHost(element("anchor"))).toBe(false);
    expect(isInteractiveHost(element("focusable"))).toBe(false);
  });

  it("resolves contenteditable inheritance, keywords, and false boundaries", () => {
    document.body.innerHTML = `
      <div contenteditable="TRUE">
        <div id="inherited"></div>
        <div id="boundary" contenteditable="FALSE">
          <div id="below-boundary"></div>
        </div>
      </div>
      <div id="plaintext" contenteditable="plaintext-only"></div>
      <div id="invalid" contenteditable="not-a-keyword"></div>`;

    expect(isInteractiveHost(element("inherited"))).toBe(true);
    expect(isInteractiveHost(element("boundary"))).toBe(false);
    expect(isInteractiveHost(element("below-boundary"))).toBe(false);
    expect(isInteractiveHost(element("plaintext"))).toBe(true);
    expect(isInteractiveHost(element("invalid"))).toBe(false);
  });
});
