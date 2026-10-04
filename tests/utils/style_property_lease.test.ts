import { describe, expect, it, vi } from "vitest";
import { StylePropertyLease } from "../../src/utils/style_property_lease";

/** Contract tests for temporary, authored-value-preserving inline style control. */
describe("StylePropertyLease", () => {
  it("restores an authored value and priority", () => {
    const element = document.createElement("div");
    element.style.setProperty("--progress", "0.25", "important");
    const lease = new StylePropertyLease("--progress", "stimeo--probe");

    lease.write(element, "0.5");
    lease.write(element, "1", "important");
    expect(element.style.getPropertyPriority("--progress")).toBe("important");
    lease.return(element);

    expect(element.style.getPropertyValue("--progress")).toBe("0.25");
    expect(element.style.getPropertyPriority("--progress")).toBe("important");
  });

  it("removes a declaration with no authored predecessor", () => {
    const element = document.createElement("div");
    const lease = new StylePropertyLease("--progress", "stimeo--probe");

    lease.write(element, "0.5");
    lease.return(element);

    expect(element.style.getPropertyValue("--progress")).toBe("");
  });

  it("tracks ownership when a later write removes the declaration", () => {
    const element = document.createElement("div");
    element.style.setProperty("--progress", "0.25", "important");
    const lease = new StylePropertyLease("--progress", "stimeo--probe");

    lease.write(element, "0.5");
    lease.write(element, null, "important");
    expect(element.style.getPropertyValue("--progress")).toBe("");
    lease.return(element);

    expect(element.style.getPropertyValue("--progress")).toBe("0.25");
    expect(element.style.getPropertyPriority("--progress")).toBe("important");
  });

  it("tracks an initial leased removal independently of its ignored priority", () => {
    const element = document.createElement("div");
    element.style.setProperty("--progress", "0.25", "important");
    const lease = new StylePropertyLease("--progress", "stimeo--probe");

    lease.write(element, null, "important");
    lease.return(element);

    expect(element.style.getPropertyValue("--progress")).toBe("0.25");
    expect(element.style.getPropertyPriority("--progress")).toBe("important");
  });

  it("writes and returns a newly leased priority", () => {
    const element = document.createElement("div");
    const lease = new StylePropertyLease("--progress", "stimeo--probe");

    lease.write(element, "0.5", "important");
    expect(element.style.getPropertyPriority("--progress")).toBe("important");
    lease.return(element);

    expect(element.style.getPropertyValue("--progress")).toBe("");
  });

  it("reads the declaration afresh for a lease taken after the last one came back", () => {
    const element = document.createElement("div");
    element.style.setProperty("--progress", "0.25");
    const lease = new StylePropertyLease("--progress", "stimeo--probe");
    lease.write(element, "0.5");
    lease.return(element);

    element.style.setProperty("--progress", "0.75");
    lease.write(element, "1");
    lease.return(element);

    expect(element.style.getPropertyValue("--progress")).toBe("0.75");
  });

  it("ignores a return for an element with no lease", () => {
    const lease = new StylePropertyLease("--progress", "stimeo--probe");

    expect(() => lease.return(document.createElement("div"))).not.toThrow();
  });

  it("does not overwrite a later consumer declaration", () => {
    const element = document.createElement("div");
    const lease = new StylePropertyLease("--progress", "stimeo--probe");

    lease.write(element, "0.5");
    element.style.setProperty("--progress", "consumer", "important");
    lease.return(element);

    expect(element.style.getPropertyValue("--progress")).toBe("consumer");
    expect(element.style.getPropertyPriority("--progress")).toBe("important");
  });

  it("skips identical writes", () => {
    const element = document.createElement("div");
    const setProperty = vi.spyOn(element.style, "setProperty");
    const lease = new StylePropertyLease("--progress", "stimeo--probe");

    lease.write(element, "0.5");
    lease.write(element, "0.5");

    expect(setProperty).toHaveBeenCalledTimes(1);
    lease.returnAll();
  });

  it("skips identical priority writes", () => {
    const element = document.createElement("div");
    const setProperty = vi.spyOn(element.style, "setProperty");
    const lease = new StylePropertyLease("--progress", "stimeo--probe");

    lease.write(element, "0.5", "important");
    lease.write(element, "0.5", "important");

    expect(setProperty).toHaveBeenCalledTimes(1);
    lease.returnAll();
  });

  it("skips an already reflected removal even when a priority is supplied", () => {
    const element = document.createElement("div");
    const removeProperty = vi.spyOn(element.style, "removeProperty");
    const lease = new StylePropertyLease("--progress", "stimeo--probe");

    lease.write(element, null, "important");

    expect(removeProperty).not.toHaveBeenCalled();
    lease.returnAll();
  });

  it("returns every outstanding declaration on demand", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    second.style.setProperty("--progress", "0.25");
    const lease = new StylePropertyLease("--progress", "stimeo--probe");

    lease.write(first, "0.5");
    lease.write(second, "1");
    lease.returnAll();

    expect(first.style.getPropertyValue("--progress")).toBe("");
    expect(second.style.getPropertyValue("--progress")).toBe("0.25");
  });

  it("subscribes to no document event, so a dropped lease cannot outlive its consumer", () => {
    // Same contract as AttributeLease: the lease has no lifecycle, so rooting it
    // in a document listener would keep a detached subtree alive until that
    // listener next fired.
    const add = vi.spyOn(document, "addEventListener");
    const host = document.createElement("div");
    const element = document.createElement("div");
    host.append(element);
    document.body.append(host);
    const lease = new StylePropertyLease("--progress", "stimeo--probe");

    lease.write(element, "0.5");
    host.remove();
    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(add).not.toHaveBeenCalled();
    expect(element.style.getPropertyValue("--progress")).toBe("0.5");
  });
});

/**
 * The record a style lease leaves in the DOM, so the connection that adopts a restored
 * clone of the element knows the author's declaration.
 */
describe("StylePropertyLease records", () => {
  const OWNER = "stimeo--probe";
  const RECORD = `data-${OWNER}-style---progress-lease`;

  const records = (element: Element): string[] =>
    element.getAttributeNames().filter((name) => name.endsWith("-lease"));

  it("gives the author's declaration back from a restored clone", () => {
    const element = document.createElement("div");
    element.style.setProperty("--progress", "0.25", "important");
    new StylePropertyLease("--progress", OWNER).write(element, "0.5");
    const restored = element.cloneNode() as HTMLElement;
    const lease = new StylePropertyLease("--progress", OWNER);

    lease.write(restored, "0.75");
    lease.return(restored);

    expect(restored.style.getPropertyValue("--progress")).toBe("0.25");
    expect(restored.style.getPropertyPriority("--progress")).toBe("important");
    expect(records(restored)).toEqual([]);
  });

  it("removes a declaration the author never wrote from a restored clone", () => {
    const element = document.createElement("div");
    new StylePropertyLease("--progress", OWNER).write(element, "0.5");
    const restored = element.cloneNode() as HTMLElement;
    const lease = new StylePropertyLease("--progress", OWNER);

    lease.write(restored, "0.75");
    lease.return(restored);

    expect(restored.style.getPropertyValue("--progress")).toBe("");
    expect(records(restored)).toEqual([]);
  });

  it("names the record after the owner and the property", () => {
    const element = document.createElement("div");
    new StylePropertyLease("--progress", OWNER).write(element, "0.5");

    expect(records(element)).toEqual([RECORD]);
    expect(RECORD).not.toMatch(/-(value|target|outlet|class|param)$/);
  });

  it("returns without a write when the declaration it holds is the author's", () => {
    const element = document.createElement("div");
    element.style.setProperty("--progress", "0.5", "important");
    const lease = new StylePropertyLease("--progress", OWNER);
    lease.write(element, "0.5", "important");
    const setProperty = vi.spyOn(element.style, "setProperty");

    lease.return(element);

    expect(setProperty).not.toHaveBeenCalled();
    expect(element.style.getPropertyValue("--progress")).toBe("0.5");
  });

  it("places no record while the declaration is still the author's", () => {
    const element = document.createElement("div");
    element.style.setProperty("--progress", "0.5");
    const lease = new StylePropertyLease("--progress", OWNER);

    lease.write(element, "0.5");

    expect(records(element)).toEqual([]);
  });

  it("removes the record on return, also when a consumer has taken the declaration over", () => {
    const element = document.createElement("div");
    const lease = new StylePropertyLease("--progress", OWNER);

    lease.write(element, "0.5");
    element.style.setProperty("--progress", "consumer");
    lease.return(element);

    expect(element.style.getPropertyValue("--progress")).toBe("consumer");
    expect(records(element)).toEqual([]);
  });

  it("takes the current declaration as the author's when the record is not one it writes", () => {
    for (const malformed of [
      "nope",
      '["only one"]',
      '["a", "b", "c"]',
      '"ab"',
      '"abcd"',
      "[1, 2]",
      '[1, "", "", ""]',
      '["", 1, "", ""]',
      '["", "", 1, ""]',
      '["", "", "", 1]',
      '["", "", "0.5", "", 1]',
    ]) {
      const element = document.createElement("div");
      element.style.setProperty("--progress", "0.1");
      element.setAttribute(RECORD, malformed);
      const lease = new StylePropertyLease("--progress", OWNER);

      lease.write(element, "0.5");
      lease.return(element);

      expect(element.style.getPropertyValue("--progress")).toBe("0.1");
      expect(records(element)).toEqual([]);
    }
  });

  describe("a copy it never wrote", () => {
    /** A copy of an element whose authored `0.25 !important` an earlier lease replaced with `0.5`. */
    const restored = (): HTMLElement => {
      const element = document.createElement("div");
      element.style.setProperty("--progress", "0.25", "important");
      new StylePropertyLease("--progress", OWNER).write(element, "0.5");
      return element.cloneNode() as HTMLElement;
    };

    it("returns the author's declaration its record holds, while the copy carries the one written last", () => {
      const copy = restored();

      new StylePropertyLease("--progress", OWNER).return(copy);

      expect(copy.style.getPropertyValue("--progress")).toBe("0.25");
      expect(copy.style.getPropertyPriority("--progress")).toBe("important");
      expect(records(copy)).toEqual([]);
    });

    it("leaves a declaration that replaced the one written last, and drops the record", () => {
      const copy = restored();
      copy.style.setProperty("--progress", "consumer");

      new StylePropertyLease("--progress", OWNER).return(copy);

      expect(copy.style.getPropertyValue("--progress")).toBe("consumer");
      expect(records(copy)).toEqual([]);
    });

    it("takes the author's declaration from the record when it writes the copy, whatever the copy carries", () => {
      const copy = restored();
      copy.style.setProperty("--progress", "consumer");
      const lease = new StylePropertyLease("--progress", OWNER);

      lease.write(copy, "0.75");
      lease.return(copy);

      expect(copy.style.getPropertyValue("--progress")).toBe("0.25");
      expect(copy.style.getPropertyPriority("--progress")).toBe("important");
      expect(records(copy)).toEqual([]);
    });

    it("reads nothing from a copy it neither holds nor carries a record on when it returns it", () => {
      const element = document.createElement("div");
      element.style.setProperty("--progress", "0.25");
      new StylePropertyLease("--progress", "stimeo--outer").write(element, "0.5");
      const copy = element.cloneNode() as HTMLElement;
      new StylePropertyLease("--progress", OWNER).return(copy);
      // A morph then keeps only what the server sent.
      copy.removeAttribute("data-stimeo--outer-style---progress-lease");
      copy.style.setProperty("--progress", "0.9");
      const outer = new StylePropertyLease("--progress", "stimeo--outer");

      outer.write(copy, "0.75");
      outer.return(copy);

      expect(copy.style.getPropertyValue("--progress")).toBe("0.9");
    });

    it("leaves an element a live lease of its owner holds alone", () => {
      const element = document.createElement("div");
      const live = new StylePropertyLease("--progress", OWNER);
      live.write(element, "0.5");

      new StylePropertyLease("--progress", OWNER).return(element);

      expect(element.style.getPropertyValue("--progress")).toBe("0.5");
      expect(records(element)).toEqual([RECORD]);
    });
  });

  it("writes the record only when it changes", () => {
    const element = document.createElement("div");
    const lease = new StylePropertyLease("--progress", OWNER);
    const setAttribute = vi.spyOn(element, "setAttribute");

    lease.write(element, "0.5");
    lease.write(element, "0.5");

    expect(setAttribute.mock.calls.filter(([name]) => name === RECORD)).toHaveLength(1);
  });

  it("records the author's declaration with the one it wrote last, and no record once it writes the author's", () => {
    const element = document.createElement("div");
    element.style.setProperty("--progress", "0.25", "important");
    const lease = new StylePropertyLease("--progress", OWNER);

    lease.write(element, "0.5");
    expect(element.getAttribute(RECORD)).toBe('["0.25","important","0.5",""]');
    lease.write(element, null);
    expect(element.getAttribute(RECORD)).toBe('["0.25","important",null,""]');
    lease.write(element, "0.25", "important");
    expect(element.getAttribute(RECORD)).toBeNull();
  });

  describe("two leases of one owner on one element", () => {
    /** An element whose authored declaration is `0.1`, written by `first` and then `second`. */
    const shared = () => {
      const element = document.createElement("div");
      element.style.setProperty("--progress", "0.1");
      const first = new StylePropertyLease("--progress", OWNER);
      const second = new StylePropertyLease("--progress", OWNER);
      first.write(element, "0.3");
      second.write(element, "0.5");
      return { element, first, second };
    };
    const value = (element: HTMLElement) => element.style.getPropertyValue("--progress");

    it("gives the element back the live lease's declaration when the later one returns", () => {
      const { element, first, second } = shared();

      second.return(element);

      expect(value(element)).toBe("0.3");
      expect(records(element)).toEqual([RECORD]);
      first.return(element);
      expect(value(element)).toBe("0.1");
      expect(records(element)).toEqual([]);
    });

    it("keeps the record and the live declaration when the earlier one returns, and the last one returns the author's", () => {
      const { element, first, second } = shared();

      first.return(element);

      expect(value(element)).toBe("0.5");
      expect(records(element)).toEqual([RECORD]);
      second.return(element);
      expect(value(element)).toBe("0.1");
      expect(records(element)).toEqual([]);
    });

    it("gives the second of them its own hold on a copy the first took the recorded one of", () => {
      const element = document.createElement("div");
      element.style.setProperty("--progress", "0.1");
      new StylePropertyLease("--progress", OWNER).write(element, "0.2");
      const copy = element.cloneNode() as HTMLElement;
      const first = new StylePropertyLease("--progress", OWNER);
      const second = new StylePropertyLease("--progress", OWNER);

      first.write(copy, "0.3");
      second.write(copy, "0.5");
      second.return(copy);

      expect(value(copy)).toBe("0.3");
      first.return(copy);
      expect(value(copy)).toBe("0.1");
    });

    it("returns its own declaration though a lease of another property holds the element", () => {
      const element = document.createElement("div");
      const other = new StylePropertyLease("--other", OWNER);
      const lease = new StylePropertyLease("--progress", OWNER);
      other.write(element, "1");
      lease.write(element, "0.5");

      lease.return(element);

      expect(value(element)).toBe("");
      expect(records(element)).toEqual([`data-${OWNER}-style---other-lease`]);
    });

    it("keeps the record while any live lease holds the element, returning down the leases in turn", () => {
      const { element, first, second } = shared();
      const third = new StylePropertyLease("--progress", OWNER);
      third.write(element, "0.7");

      third.return(element);
      expect(value(element)).toBe("0.5");
      second.return(element);
      expect(value(element)).toBe("0.3");
      expect(element.getAttribute(RECORD)).toBe('["0.1","","0.3",""]');
      first.return(element);

      expect(value(element)).toBe("0.1");
      expect(records(element)).toEqual([]);
    });

    it("gives the element the priority the live lease wrote", () => {
      const element = document.createElement("div");
      const first = new StylePropertyLease("--progress", OWNER);
      const second = new StylePropertyLease("--progress", OWNER);
      first.write(element, "0.3", "important");
      second.write(element, "0.5");

      second.return(element);

      expect(value(element)).toBe("0.3");
      expect(element.style.getPropertyPriority("--progress")).toBe("important");
    });

    it("gives the element back the declaration the live lease wrote last", () => {
      const { element, first, second } = shared();
      first.write(element, "0.4");
      second.write(element, "0.6");

      second.return(element);

      expect(value(element)).toBe("0.4");
    });
  });

  it("records the author's declaration over a record it could not read, so a later copy still knows it", () => {
    for (const malformed of ["nope", '["only one"]', '"ab"', "[1, 2]"]) {
      const element = document.createElement("div");
      element.style.setProperty("--progress", "0.1", "important");
      element.setAttribute(RECORD, malformed);
      new StylePropertyLease("--progress", OWNER).write(element, "0.5");
      const restored = element.cloneNode() as HTMLElement;
      const lease = new StylePropertyLease("--progress", OWNER);

      lease.write(restored, "0.75");
      lease.return(restored);

      expect(restored.style.getPropertyValue("--progress")).toBe("0.1");
      expect(restored.style.getPropertyPriority("--progress")).toBe("important");
      expect(records(restored)).toEqual([]);
    }
  });

  describe("leases of two owners on one element", () => {
    const outerLease = () => new StylePropertyLease("--progress", "stimeo--outer");
    const innerLease = () => new StylePropertyLease("--progress", "stimeo--inner");
    const declaration = (element: HTMLElement) => [
      element.style.getPropertyValue("--progress"),
      element.style.getPropertyPriority("--progress"),
    ];
    /** An element authored `--progress: 0.1 !important`, written by an outer and then an inner lease. */
    const stacked = () => {
      const element = document.createElement("div");
      element.style.setProperty("--progress", "0.1", "important");
      const outer = outerLease();
      const inner = innerLease();
      outer.write(element, "0.3");
      inner.write(element, "0.5");
      return { element, outer, inner };
    };

    it("gives the element back what the outer lease wrote last, though it wrote again under the inner one", () => {
      const { element, outer, inner } = stacked();
      outer.write(element, "0.4", "important");
      inner.write(element, "0.5");

      inner.return(element);
      expect(declaration(element)).toEqual(["0.4", "important"]);
      outer.return(element);

      expect(declaration(element)).toEqual(["0.1", "important"]);
      expect(records(element)).toEqual([]);
    });

    it("returns the author's declaration from the inner lease once the outer one returned first", () => {
      const { element, outer, inner } = stacked();

      outer.return(element);
      expect(declaration(element)).toEqual(["0.5", ""]);
      inner.return(element);

      expect(declaration(element)).toEqual(["0.1", "important"]);
      expect(records(element)).toEqual([]);
    });

    it("gives a restored copy back what the outer lease wrote there, where it wrote before the inner one", () => {
      const { element } = stacked();
      const restored = element.cloneNode() as HTMLElement;
      const outer = outerLease();
      const inner = innerLease();

      outer.write(restored, "0.4");
      inner.write(restored, "0.5");
      inner.return(restored);
      expect(declaration(restored)).toEqual(["0.4", ""]);
      outer.return(restored);

      expect(declaration(restored)).toEqual(["0.1", "important"]);
      expect(records(restored)).toEqual([]);
    });

    it("gives a restored copy neither lease wrote back what the outer one wrote, and then the author's declaration", () => {
      const { element } = stacked();
      const restored = element.cloneNode() as HTMLElement;

      innerLease().return(restored);
      expect(declaration(restored)).toEqual(["0.3", ""]);
      outerLease().return(restored);

      expect(declaration(restored)).toEqual(["0.1", "important"]);
      expect(records(restored)).toEqual([]);
    });

    it("returns the author's declaration from a restored copy whose outer lease returned first", () => {
      const { element } = stacked();
      const restored = element.cloneNode() as HTMLElement;

      outerLease().return(restored);
      innerLease().return(restored);

      expect(declaration(restored)).toEqual(["0.1", "important"]);
      expect(records(restored)).toEqual([]);
    });

    it("takes a declaration the page wrote over the outer lease as the author's", () => {
      const element = document.createElement("div");
      element.style.setProperty("--progress", "0.1");
      const outer = outerLease();
      const inner = innerLease();
      outer.write(element, "0.3");
      element.style.setProperty("--progress", "0.2");

      inner.write(element, "0.5");
      expect(element.getAttribute("data-stimeo--inner-style---progress-lease")).toBe(
        '["0.2","","0.5","",false,"data-stimeo--outer-style---progress-lease"]',
      );
      inner.return(element);

      expect(declaration(element)).toEqual(["0.2", ""]);
      expect(records(element)).toEqual(["data-stimeo--outer-style---progress-lease"]);
    });

    it("takes for the top of a copy the lease whose declaration it carries, of two whose records list neither beneath the other", () => {
      for (const [first, second] of [
        ["stimeo--column-a1", "stimeo--column-b1"],
        ["stimeo--column-b2", "stimeo--column-a2"],
      ] as const) {
        const lease = (owner: string) => new StylePropertyLease("--progress", owner);
        const shown = first.includes("-a") ? first : second;
        const beneath = shown === first ? second : first;
        lease(first);
        lease(second);
        const element = document.createElement("div");
        element.style.setProperty("--progress", "0.1");
        lease(beneath).write(element, "0.2");
        element.style.setProperty("--progress", "0.3");
        lease(shown).write(element, "0.4");
        const restored = element.cloneNode() as HTMLElement;

        lease(shown).return(restored);

        expect(declaration(restored)).toEqual(["0.3", ""]);
      }
    });

    it("hands back the page's declaration from the lease written over it once the lease it lay on returned first", () => {
      const element = document.createElement("div");
      element.style.setProperty("--progress", "0.1");
      new StylePropertyLease("--progress", "stimeo--lower").write(element, "0.2");
      element.style.setProperty("--progress", "0.3");
      const outer = outerLease();
      const inner = innerLease();
      outer.write(element, "0.4");
      inner.write(element, "0.5");

      outer.return(element);
      inner.return(element);

      expect(declaration(element)).toEqual(["0.3", ""]);
    });

    it("keeps the inner lease's declaration when the outer one, which wrote the same declaration, returns first", () => {
      const element = document.createElement("div");
      element.style.setProperty("--progress", "0.1");
      const outer = outerLease();
      const inner = innerLease();
      outer.write(element, "0.5");
      inner.write(element, "0.5");

      outer.return(element);
      expect(declaration(element)).toEqual(["0.5", ""]);
      inner.return(element);

      expect(declaration(element)).toEqual(["0.1", ""]);
      expect(records(element)).toEqual([]);
    });

    it("shows nothing the outer lease writes beneath the inner one until the inner one returns", () => {
      const { element, outer, inner } = stacked();

      outer.write(element, "0.4", "important");
      expect(declaration(element)).toEqual(["0.5", ""]);
      inner.return(element);

      expect(declaration(element)).toEqual(["0.4", "important"]);
    });

    it("keeps the inner lease on top of a restored copy the outer lease writes first", () => {
      const { element } = stacked();
      const restored = element.cloneNode() as HTMLElement;
      const outer = outerLease();
      const inner = innerLease();

      outer.write(restored, "0.4");
      expect(declaration(restored)).toEqual(["0.5", ""]);
      inner.return(restored);
      expect(declaration(restored)).toEqual(["0.4", ""]);
      outer.return(restored);

      expect(declaration(restored)).toEqual(["0.1", "important"]);
      expect(records(restored)).toEqual([]);
    });

    it("returns a restored copy to the author's declaration, though the inner lease writes it before the outer one returns it", () => {
      const element = document.createElement("div");
      element.style.setProperty("--progress", "0.1", "important");
      outerLease().write(element, "0.3");
      const restored = element.cloneNode() as HTMLElement;
      const outer = outerLease();
      const inner = innerLease();

      inner.write(restored, "0.5");
      outer.return(restored);
      expect(declaration(restored)).toEqual(["0.5", ""]);
      inner.return(restored);

      expect(declaration(restored)).toEqual(["0.1", "important"]);
      expect(records(restored)).toEqual([]);
    });

    it("records an outer lease that holds the author's declaration beneath the inner one, so a copy stacks them as the page did", () => {
      const element = document.createElement("div");
      element.style.setProperty("--progress", "0.1");
      outerLease().write(element, "0.1");
      innerLease().write(element, "0.5");
      expect(element.getAttribute("data-stimeo--outer-style---progress-lease")).toBe(
        '["0.1","","0.1",""]',
      );
      const restored = element.cloneNode() as HTMLElement;
      const outer = outerLease();
      const inner = innerLease();

      outer.write(restored, "0.3");
      expect(declaration(restored)).toEqual(["0.5", ""]);
      inner.return(restored);
      expect(declaration(restored)).toEqual(["0.3", ""]);
      outer.return(restored);

      expect(declaration(restored)).toEqual(["0.1", ""]);
      expect(records(restored)).toEqual([]);
    });
  });

  describe("after the page replaced the declaration of the top lease", () => {
    const lowerLease = () => new StylePropertyLease("--progress", "stimeo--lower");
    const upperLease = () => new StylePropertyLease("--progress", "stimeo--upper");
    const value = (element: HTMLElement) => element.style.getPropertyValue("--progress");
    /** An element authored `--progress: 0.1`, held by a lower and an upper lease, then rewritten by the page. */
    const replaced = () => {
      const element = document.createElement("div");
      element.style.setProperty("--progress", "0.1");
      const lower = lowerLease();
      const upper = upperLease();
      lower.write(element, "0.2");
      upper.write(element, "0.3");
      element.style.setProperty("--progress", "0.9");
      return { element, lower, upper };
    };

    it("shows the next write of a lease beneath the top", () => {
      const { element, lower, upper } = replaced();

      lower.write(element, "0.4");
      expect(value(element)).toBe("0.4");
      upper.return(element);
      expect(value(element)).toBe("0.4");
      lower.return(element);

      expect(value(element)).toBe("0.1");
      expect(records(element)).toEqual([]);
    });

    it("gives back, on the return of a lease beneath the top whose write the element shows, what that lease gives back on top", () => {
      const { element, lower, upper } = replaced();
      lower.write(element, "0.4");

      lower.return(element);
      expect(value(element)).toBe("0.1");
      upper.return(element);

      expect(value(element)).toBe("0.1");
    });

    it("leaves the page's declaration on every return while no lease has written since", () => {
      const { element, lower, upper } = replaced();

      lower.return(element);
      upper.return(element);

      expect(value(element)).toBe("0.9");
      expect(records(element)).toEqual([]);
    });
  });

  it("takes back the hold a copy's record described, though another lease's return removed that record", () => {
    const element = document.createElement("div");
    const belowLease = () => new StylePropertyLease("--progress", "stimeo--below");
    const coverLease = () => new StylePropertyLease("--progress", "stimeo--cover");
    belowLease().write(element, "0.5");
    coverLease().write(element, null);
    const restored = element.cloneNode() as HTMLElement;
    const below = belowLease();
    const cover = coverLease();

    below.return(restored);
    cover.return(restored);
    below.write(restored, "0.25");
    cover.write(restored, "0.75");

    expect(restored.style.getPropertyValue("--progress")).toBe("0.75");
    cover.return(restored);
    expect(restored.style.getPropertyValue("--progress")).toBe("0.25");
    below.return(restored);
    expect(restored.style.getPropertyValue("--progress")).toBe("");
    expect(records(restored)).toEqual([]);
  });

  describe("a restored copy, decided as the live page", () => {
    /** Runs `then` on the live element and, with leases constructed afresh, on a copy taken after `before`. */
    const liveAndCopy = (
      owners: readonly string[],
      before: (leases: StylePropertyLease[], element: HTMLElement) => void,
      then: (leases: StylePropertyLease[], element: HTMLElement) => void,
    ) => {
      const make = () => owners.map((owner) => new StylePropertyLease("--progress", owner));
      const element = document.createElement("div");
      element.style.setProperty("--progress", "0.1");
      const live = make();
      before(live, element);
      const restored = element.cloneNode() as HTMLElement;
      const fresh = make();
      then(live, element);
      then(fresh, restored);
      return [element, restored].map((target) => target.style.getPropertyValue("--progress"));
    };

    it("orders two leases, the later one written over a declaration the page put there, as the live page did", () => {
      const [live, copy] = liveAndCopy(
        ["stimeo--first", "stimeo--second"],
        ([first, second], target) => {
          first?.write(target, "0.2");
          target.style.setProperty("--progress", "0.8");
          second?.write(target, "0.3");
          target.style.setProperty("--progress", "0.9");
        },
        ([first, second], target) => {
          second?.write(target, "0.4");
          first?.write(target, "0.5");
        },
      );

      expect([live, copy]).toEqual(["0.4", "0.4"]);
    });

    it("gives the author's declaration back and leaves no record once every lease returns, one owner holding beneath and above another", () => {
      const owners = ["stimeo--a", "stimeo--b", "stimeo--a"];
      const element = document.createElement("div");
      element.style.setProperty("--progress", "0.1");
      const [first, other, second] = owners.map((o) => new StylePropertyLease("--progress", o));
      first?.write(element, "0.2");
      other?.write(element, "0.3");
      second?.write(element, "0.4");
      const restored = element.cloneNode() as HTMLElement;

      for (const lease of owners.map((o) => new StylePropertyLease("--progress", o))) {
        lease.return(restored);
      }

      expect(restored.style.getPropertyValue("--progress")).toBe("0.1");
      expect(records(restored)).toEqual([]);
    });
  });
});
