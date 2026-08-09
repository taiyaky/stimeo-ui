import { beforeEach, describe, expect, it } from "vitest";
import { canTakeFocus } from "../../src/utils/focus_candidate";

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
