import { afterEach, describe, expect, it } from "vitest";
import { separateCopy } from "../helpers/separate_copy";

/**
 * Two copies of a utility on one page — two separately built entries, or an entry beside the
 * barrel — coordinate as one copy does: the leases of an attribute share one stack whichever
 * copy constructed them, a restored copy's records are read under every lease's name, the
 * loans of a `tabindex` are counted together, one Escape press reaches one layer, and the
 * focus traps share one `Tab`, one background and one scroll lock.
 */
describe("two copies of a utility on one page", () => {
  const attributeLeases = () => separateCopy(() => import("../../src/utils/attribute_lease"));
  const styleLeases = () => separateCopy(() => import("../../src/utils/style_property_lease"));
  const stateRegions = () => separateCopy(() => import("../../src/utils/state_regions"));
  const tabindexLoans = () => separateCopy(() => import("../../src/utils/tabindex_loan"));
  const escapeLayers = () => separateCopy(() => import("../../src/utils/escape_layer"));
  const focusTraps = () => separateCopy(() => import("../../src/utils/focus_trap"));

  afterEach(() => {
    document.body.innerHTML = "";
    document.body.removeAttribute("style");
  });

  describe("ARIA ids before their elements enter the document", () => {
    for (const copied of [false, true]) {
      it(`keeps detached ids distinct with ${copied ? "separate copies" : "one copy"}`, async () => {
        const first = await separateCopy(() => import("../../src/utils/aria_ids"));
        const second = copied
          ? await separateCopy(() => import("../../src/utils/aria_ids"))
          : first;
        const one = document.createElement("p");
        const other = document.createElement("p");

        expect(first.ensureId(one, "detached-description")).not.toBe(
          second.ensureId(other, "detached-description"),
        );
        document.body.append(one, other);
        expect(document.getElementById(one.id)).toBe(one);
        expect(document.getElementById(other.id)).toBe(other);
      });
    }
  });

  describe("AttributeLease", () => {
    const textarea = () => {
      const element = document.createElement("textarea");
      element.setAttribute("aria-invalid", "false");
      return element;
    };

    it("keeps the other copy's lease on top when the lower one, which wrote the same value, returns first", async () => {
      const { AttributeLease: First } = await attributeLeases();
      const { AttributeLease: Second } = await attributeLeases();
      const element = textarea();
      const lower = new First<HTMLElement>("aria-invalid", "stimeo--lower");
      const upper = new Second<HTMLElement>("aria-invalid", "stimeo--upper");
      lower.write(element, "true");
      upper.write(element, "true");

      lower.return(element);
      expect(element.getAttribute("aria-invalid")).toBe("true");
      upper.return(element);

      expect(element.getAttribute("aria-invalid")).toBe("false");
    });

    it("writes a base lease of one copy beneath the other copy's lease", async () => {
      const { AttributeLease: First } = await attributeLeases();
      const { AttributeLease: Second } = await attributeLeases();
      const element = textarea();
      const counter = new First<HTMLElement>("aria-invalid", "stimeo--counter");
      const field = new Second<HTMLElement>("aria-invalid", "stimeo--field", { base: true });
      counter.write(element, "true");

      field.write(element, "false");
      expect(element.getAttribute("aria-invalid")).toBe("true");
      counter.return(element);

      expect(element.getAttribute("aria-invalid")).toBe("false");
    });

    it("reads a restored copy's records under the names the other copy's leases carry", async () => {
      const { AttributeLease: First } = await attributeLeases();
      const { AttributeLease: Second } = await attributeLeases();
      const element = textarea();
      new First<HTMLElement>("aria-invalid", "stimeo--outer").write(element, "outer");
      new First<HTMLElement>("aria-invalid", "stimeo--inner").write(element, "inner");
      const restored = element.cloneNode() as HTMLElement;
      const outer = new First<HTMLElement>("aria-invalid", "stimeo--outer");
      const inner = new Second<HTMLElement>("aria-invalid", "stimeo--inner");

      inner.return(restored);
      expect(restored.getAttribute("aria-invalid")).toBe("outer");
      outer.return(restored);

      expect(restored.getAttribute("aria-invalid")).toBe("false");
    });
  });

  it("StylePropertyLease keeps the other copy's lease on top when the lower one, which wrote the same declaration, returns first", async () => {
    const { StylePropertyLease: First } = await styleLeases();
    const { StylePropertyLease: Second } = await styleLeases();
    const element = document.createElement("div");
    element.style.setProperty("opacity", "1");
    const lower = new First("opacity", "stimeo--lower");
    const upper = new Second("opacity", "stimeo--upper");
    lower.write(element, "0.5");
    upper.write(element, "0.5");

    lower.return(element);
    expect(element.style.getPropertyValue("opacity")).toBe("0.5");
    upper.return(element);

    expect(element.style.getPropertyValue("opacity")).toBe("1");
  });

  it("StateRegions keeps the other copy's instance on top when the lower one, which hid the region too, releases first", async () => {
    const { StateRegions: First } = await stateRegions();
    const { StateRegions: Second } = await stateRegions();
    document.body.innerHTML = `<div id="host"><p id="region">Details</p></div>`;
    const host = document.getElementById("host") as HTMLElement;
    const region = document.getElementById("region") as HTMLElement;
    const lower = new First({ whenTrue: () => [region] }, "stimeo--lower");
    const upper = new Second({ whenTrue: () => [region] }, "stimeo--upper");
    lower.reflect(host, false);
    upper.reflect(host, false);

    lower.release(host);
    expect(region.hidden).toBe(true);
    upper.release(host);

    expect(region.hidden).toBe(false);
  });

  it("TabindexLoan keeps a tabindex two copies lend under one owner until the last of them returns", async () => {
    const { TabindexLoan: First } = await tabindexLoans();
    const { TabindexLoan: Second } = await tabindexLoans();
    const element = document.createElement("div");
    const one = new First("-1", "stimeo-focus-trap");
    const other = new Second("-1", "stimeo-focus-trap");
    one.lend(element);
    other.lend(element);

    one.returnAll();
    expect(element.getAttribute("tabindex")).toBe("-1");
    other.returnAll();

    expect(element.hasAttribute("tabindex")).toBe(false);
  });

  it("EscapeLayer hands one press to the layer activated last, whichever copy activated it", async () => {
    const { EscapeLayer: First } = await escapeLayers();
    const { EscapeLayer: Second } = await escapeLayers();
    const dismissed: string[] = [];
    const lower = new First();
    const upper = new Second();
    lower.activate(document, { onDismiss: () => dismissed.push("lower") });
    upper.activate(document, { onDismiss: () => dismissed.push("upper") });

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(dismissed).toEqual(["upper"]);
    expect(upper.ownsEscape).toBe(true);
    upper.deactivate();
    expect(lower.ownsEscape).toBe(true);
    lower.deactivate();
  });

  describe("FocusTrap", () => {
    const mount = () => {
      document.body.innerHTML = `
        <p id="page">Page</p>
        <div id="lower"><button id="lower-first">Lower first</button><button id="lower-last">Lower last</button></div>
        <div id="upper"><button id="upper-first">Upper first</button><button id="upper-last">Upper last</button></div>`;
      return (id: string) => document.getElementById(id) as HTMLElement;
    };
    const tab = () =>
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );

    it("hands Tab to the trap activated last and keeps the one below it background", async () => {
      const { FocusTrap: First } = await focusTraps();
      const { FocusTrap: Second } = await focusTraps();
      const byId = mount();
      const lower = new First(() => byId("lower"));
      const upper = new Second(() => byId("upper"));
      lower.activate();
      upper.activate();

      expect(document.activeElement?.id).toBe("upper-first");
      byId("upper-last").focus();
      tab();
      expect(document.activeElement?.id).toBe("upper-first");
      expect([byId("upper").closest("[inert]"), byId("lower").inert, byId("page").inert]).toEqual([
        null,
        true,
        true,
      ]);

      upper.deactivate();
      expect([byId("lower").closest("[inert]"), byId("page").inert]).toEqual([null, true]);
      lower.deactivate({ restoreFocus: false });
      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    });

    it("keeps the page locked until the last trap of either copy is released", async () => {
      const { FocusTrap: First } = await focusTraps();
      const { FocusTrap: Second } = await focusTraps();
      const byId = mount();
      document.body.style.overflow = "scroll";
      const lower = new First(() => byId("lower"));
      const upper = new Second(() => byId("upper"));
      lower.activate();
      upper.activate();

      lower.deactivate({ restoreFocus: false });
      expect(document.body.style.overflow).toBe("hidden");
      upper.deactivate({ restoreFocus: false });

      expect(document.body.style.overflow).toBe("scroll");
    });
  });
});
