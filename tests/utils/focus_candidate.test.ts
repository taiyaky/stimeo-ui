import { beforeEach, describe, expect, it } from "vitest";
import {
  canTakeFocus,
  firstTabStop,
  hasTabStop,
  isTabStop,
  tabStopsWithin,
} from "../../src/utils/focus_candidate";

/**
 * Tests for {@link canTakeFocus}.
 *
 * The `fieldset` cases carry the most detail because HTML's rule is not
 * "anything inside a disabled fieldset": the contents of the **first direct-child
 * `<legend>`** stay enabled, and the exemption is per fieldset, so a control
 * legal in one legend can still be disabled by an outer one.
 *
 * `aria-disabled` gets its own case for the opposite reason — it must **not**
 * disqualify, because the roving contract keeps such items reachable and
 * the platform still focuses them.
 */
describe("canTakeFocus", () => {
  const el = (selector: string) => document.querySelector<HTMLElement>(selector) as HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("accepts a plain focusable control", () => {
    document.body.innerHTML = '<button id="a">A</button>';
    expect(canTakeFocus(el("#a"))).toBe(true);
  });

  it("accepts a non-form element, which has no disabled property", () => {
    // Landmarks and rows are legitimate rescue destinations once they carry a
    // borrowed tabindex; nothing about them refuses focus.
    document.body.innerHTML = '<div id="a" tabindex="-1"></div>';
    expect(canTakeFocus(el("#a"))).toBe(true);
  });

  describe("hidden", () => {
    it("rejects a hidden element", () => {
      document.body.innerHTML = '<button id="a" hidden>A</button>';
      expect(canTakeFocus(el("#a"))).toBe(false);
    });

    it("rejects an element inside a hidden ancestor", () => {
      // The common shape: the rescue destination is fine, the wrapper is what
      // just got hidden.
      document.body.innerHTML = '<div hidden><button id="a">A</button></div>';
      expect(canTakeFocus(el("#a"))).toBe(false);
    });

    it("rejects a type=hidden input without the hidden attribute", () => {
      document.body.innerHTML = '<input id="a" type="hidden">';
      expect(canTakeFocus(el("#a"))).toBe(false);
    });
  });

  describe("disabled", () => {
    it("rejects a natively disabled control", () => {
      document.body.innerHTML = '<button id="a" disabled>A</button>';
      expect(canTakeFocus(el("#a"))).toBe(false);
    });

    it("accepts an aria-disabled control", () => {
      // Not disqualifying: `aria-disabled` marks a control that must stay
      // discoverable, and the platform still focuses it.
      document.body.innerHTML = '<button id="a" aria-disabled="true">A</button>';
      expect(canTakeFocus(el("#a"))).toBe(true);
    });
  });

  describe("fieldset inheritance", () => {
    it("rejects a control inside a disabled fieldset", () => {
      document.body.innerHTML = '<fieldset disabled><button id="a">A</button></fieldset>';
      expect(canTakeFocus(el("#a"))).toBe(false);
    });

    it("accepts a control in the first direct-child legend", () => {
      // HTML exempts exactly that legend — the control really is operable.
      document.body.innerHTML =
        '<fieldset disabled><legend><button id="a">A</button></legend></fieldset>';
      expect(canTakeFocus(el("#a"))).toBe(true);
    });

    it("rejects a control in a second legend", () => {
      document.body.innerHTML =
        "<fieldset disabled><legend>First</legend>" +
        '<legend><button id="a">A</button></legend></fieldset>';
      expect(canTakeFocus(el("#a"))).toBe(false);
    });

    it("rejects a legend-exempt control that an outer fieldset still disables", () => {
      // The exemption is per fieldset: being legal in the inner legend says
      // nothing about the outer one.
      document.body.innerHTML =
        '<fieldset disabled><fieldset disabled><legend><button id="a">A</button></legend>' +
        "</fieldset></fieldset>";
      expect(canTakeFocus(el("#a"))).toBe(false);
    });

    it("accepts a control whose fieldset is not disabled", () => {
      document.body.innerHTML = '<fieldset><button id="a">A</button></fieldset>';
      expect(canTakeFocus(el("#a"))).toBe(true);
    });
  });
});

describe("sequential Tab stops", () => {
  const candidate = (html: string): HTMLElement => {
    document.body.innerHTML = html;
    const element = document.querySelector<HTMLElement>("#candidate");
    if (!element) throw new Error("Expected #candidate");
    return element;
  };

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it.each([
    ["link", '<a id="candidate" href="#target">Link</a>'],
    ["image-map area", '<map><area id="candidate" href="#target"></map>'],
    ["button", '<button id="candidate">Save</button>'],
    ["text input", '<input id="candidate">'],
    ["select", '<select id="candidate"><option>One</option></select>'],
    ["textarea", '<textarea id="candidate"></textarea>'],
    ["first summary", '<details><summary id="candidate">Details</summary></details>'],
    ["iframe", '<iframe id="candidate" title="Preview"></iframe>'],
    ["audio controls", '<audio id="candidate" controls style="display:block"></audio>'],
    ["video controls", '<video id="candidate" controls></video>'],
    ["authored tabindex", '<div id="candidate" tabindex="0"></div>'],
    ["bare contenteditable", '<div id="candidate" contenteditable></div>'],
    ["editable true", '<div id="candidate" contenteditable="TRUE"></div>'],
    ["plaintext editor", '<div id="candidate" contenteditable="plaintext-only"></div>'],
    ["aria-disabled button", '<button id="candidate" aria-disabled="true">Save</button>'],
  ])("accepts a %s", (_name, html) => {
    expect(isTabStop(candidate(html))).toBe(true);
  });

  it.each([
    ["hidden input", '<input id="candidate" type="hidden">'],
    ["disabled button", '<button id="candidate" disabled>Save</button>'],
    [
      "fieldset-disabled button",
      '<fieldset disabled><button id="candidate">Save</button></fieldset>',
    ],
    [
      "second summary",
      '<details><summary>First</summary><summary id="candidate">Second</summary></details>',
    ],
    ["orphan summary", '<summary id="candidate">Orphan</summary>'],
    ["negative tabindex", '<button id="candidate" tabindex="-1">Save</button>'],
    ["explicitly non-editable element", '<div id="candidate" contenteditable="false"></div>'],
    ["invalid editable value", '<div id="candidate" contenteditable="invalid"></div>'],
    ["hidden subtree", '<div hidden><button id="candidate">Save</button></div>'],
    ["inert subtree", '<div inert><button id="candidate">Save</button></div>'],
    ["CSS-hidden button", '<button id="candidate" style="display:none">Save</button>'],
  ])("rejects a %s", (_name, html) => {
    expect(isTabStop(candidate(html))).toBe(false);
  });

  it("keeps the disabled-fieldset first-legend exception", () => {
    expect(
      isTabStop(
        candidate(
          '<fieldset disabled><legend><button id="candidate">Save</button></legend></fieldset>',
        ),
      ),
    ).toBe(true);
  });

  it("falls back safely when checkVisibility is unavailable", () => {
    const element = candidate('<button id="candidate">Save</button>');
    Object.defineProperty(element, "checkVisibility", { configurable: true, value: undefined });

    expect(isTabStop(element)).toBe(true);
  });

  it("collects only usable descendants in DOM order", () => {
    document.body.innerHTML = `
      <div id="root">
        <button id="first">First</button>
        <input type="hidden">
        <a id="second" href="#target">Second</a>
      </div>
    `;
    const root = document.getElementById("root");
    if (!root) throw new Error("Expected #root");

    expect(tabStopsWithin(root).map((element) => element.id)).toEqual(["first", "second"]);
    expect(firstTabStop(root)?.id).toBe("first");
    expect(hasTabStop(root)).toBe(true);
  });

  it("reports an empty subtree", () => {
    const root = document.createElement("div");

    expect(tabStopsWithin(root)).toEqual([]);
    expect(firstTabStop(root)).toBeNull();
    expect(hasTabStop(root)).toBe(false);
  });
});
