import { describe, expect, it, vi } from "vitest";
import { AttributeLease, leasedAuthorValue } from "../../src/utils/attribute_lease";

/** Contract tests for temporary, authored-value-preserving attribute control. */
describe("AttributeLease", () => {
  it("restores an authored value after temporary writes", () => {
    const element = document.createElement("div");
    element.setAttribute("aria-valuemin", "1");
    const lease = new AttributeLease("aria-valuemin", "stimeo--probe");

    lease.write(element, "2");
    lease.write(element, "3");
    lease.return(element);

    expect(element.getAttribute("aria-valuemin")).toBe("1");
  });

  it("restores authored empty attributes rather than treating them as absent", () => {
    const element = document.createElement("div");
    element.setAttribute("data-state", "");
    const lease = new AttributeLease("data-state", "stimeo--probe");

    lease.write(element, "active");
    lease.return(element);

    expect(element.hasAttribute("data-state")).toBe(true);
    expect(element.getAttribute("data-state")).toBe("");
  });

  it("removes a value that had no authored predecessor", () => {
    const element = document.createElement("div");
    const lease = new AttributeLease("aria-valuenow", "stimeo--probe");

    lease.write(element, "5");
    lease.return(element);

    expect(element.hasAttribute("aria-valuenow")).toBe(false);
  });

  it("can own absence and restore the authored value later", () => {
    const element = document.createElement("div");
    element.setAttribute("aria-valuemax", "10");
    const lease = new AttributeLease("aria-valuemax", "stimeo--probe");

    lease.write(element, null);
    expect(element.hasAttribute("aria-valuemax")).toBe(false);
    lease.return(element);

    expect(element.getAttribute("aria-valuemax")).toBe("10");
  });

  it("does not overwrite a value a consumer authored after the lease write", () => {
    const element = document.createElement("div");
    const lease = new AttributeLease("aria-valuenow", "stimeo--probe");

    lease.write(element, "5");
    element.setAttribute("aria-valuenow", "consumer");
    lease.return(element);

    expect(element.getAttribute("aria-valuenow")).toBe("consumer");
  });

  it("returns leases for every tracked element and is idempotent", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    second.setAttribute("role", "group");
    const lease = new AttributeLease<HTMLElement>("role", "stimeo--probe");

    lease.write(first, "region");
    lease.write(second, "region");
    lease.returnAll();
    lease.returnAll();

    expect(first.hasAttribute("role")).toBe(false);
    expect(second.getAttribute("role")).toBe("group");
  });

  it("skips DOM writes when the leased value is already reflected", () => {
    const element = document.createElement("div");
    const setAttribute = vi.spyOn(element, "setAttribute");
    const lease = new AttributeLease("data-state", "stimeo--probe");

    lease.write(element, "active");
    lease.write(element, "active");

    expect(setAttribute.mock.calls.filter(([name]) => name === "data-state")).toHaveLength(1);
    lease.returnAll();
  });

  it("returns without a DOM write when the value it last wrote is the author's", () => {
    for (const authored of ["false", null]) {
      const element = document.createElement("div");
      if (authored !== null) element.setAttribute("aria-expanded", authored);
      const lease = new AttributeLease<HTMLElement>("aria-expanded", "stimeo--probe");
      lease.write(element, "true");
      lease.write(element, authored);
      const setAttribute = vi.spyOn(element, "setAttribute");
      const removeAttribute = vi.spyOn(element, "removeAttribute");

      lease.return(element);

      expect(setAttribute).not.toHaveBeenCalled();
      expect(removeAttribute.mock.calls.filter(([name]) => name === "aria-expanded")).toEqual([]);
      expect(element.getAttribute("aria-expanded")).toBe(authored);
    }
  });

  it("returns every outstanding lease on demand", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    second.setAttribute("role", "group");
    const lease = new AttributeLease<HTMLElement>("role", "stimeo--probe");

    lease.write(first, "region");
    lease.write(second, "region");
    lease.returnAll();

    expect(first.hasAttribute("role")).toBe(false);
    expect(second.getAttribute("role")).toBe("group");
  });

  it("subscribes to no document event, so a dropped lease cannot outlive its consumer", () => {
    // A consumer that keeps its materialized output writes and then simply drops
    // the lease. Nothing may hold it afterwards: a document subscription would
    // root the lease — and through it the detached subtree — until it next fired.
    const add = vi.spyOn(document, "addEventListener");
    const host = document.createElement("div");
    const image = document.createElement("img");
    image.setAttribute("hidden", "");
    host.append(image);
    document.body.append(host);
    const lease = new AttributeLease<HTMLElement>("hidden", "stimeo--probe");

    lease.write(image, null);
    host.remove();
    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(add).not.toHaveBeenCalled();
    expect(image.hasAttribute("hidden")).toBe(false);
  });
});

/**
 * The record a lease leaves in the DOM. A page Turbo restores from its cache is a clone
 * of the elements a lease wrote; the instance that connects to it has no memory of the
 * earlier writes, so the author's value has to travel with the markup.
 */
describe("AttributeLease records", () => {
  const OWNER = "stimeo--probe";
  const STIMULUS_SUFFIX = /-(value|target|outlet|class|param)$/;

  /** The attributes `element` carries whose name ends in `-lease`. */
  const records = (element: Element): string[] =>
    element.getAttributeNames().filter((name) => name.endsWith("-lease"));

  it("gives the author's value back from a restored clone of a written element", () => {
    const element = document.createElement("div");
    element.setAttribute("hidden", "");
    new AttributeLease<HTMLElement>("hidden", OWNER).write(element, null);
    const restored = element.cloneNode(true) as HTMLElement;
    const lease = new AttributeLease<HTMLElement>("hidden", OWNER);

    lease.write(restored, null);
    lease.return(restored);

    expect(restored.getAttribute("hidden")).toBe("");
    expect(records(restored)).toEqual([]);
  });

  it("tells an absent authored value from an empty one across a restore", () => {
    const absent = document.createElement("div");
    const empty = document.createElement("div");
    empty.setAttribute("aria-label", "");
    const first = new AttributeLease<HTMLElement>("aria-label", OWNER);
    first.write(absent, "Open");
    first.write(empty, "Open");
    const restoredAbsent = absent.cloneNode() as HTMLElement;
    const restoredEmpty = empty.cloneNode() as HTMLElement;
    const second = new AttributeLease<HTMLElement>("aria-label", OWNER);

    second.write(restoredAbsent, "Close");
    second.write(restoredEmpty, "Close");
    second.returnAll();

    expect(restoredAbsent.hasAttribute("aria-label")).toBe(false);
    expect(restoredEmpty.getAttribute("aria-label")).toBe("");
  });

  it("names the record after the owner and the attribute, never with a Stimulus suffix", () => {
    for (const attribute of ["hidden", "aria-expanded", "data-state", "data-open-value"]) {
      const element = document.createElement("div");
      new AttributeLease<HTMLElement>(attribute, OWNER).write(element, "x");

      expect(records(element)).toEqual([`data-${OWNER}-${attribute}-lease`]);
      expect(records(element)[0]).not.toMatch(STIMULUS_SUFFIX);
    }
  });

  it("places no record while the attribute still holds the author's value", () => {
    const element = document.createElement("div");
    element.setAttribute("data-state", "closed");
    const lease = new AttributeLease<HTMLElement>("data-state", OWNER);

    lease.write(element, "closed");
    expect(records(element)).toEqual([]);

    lease.write(element, "open");
    expect(element.getAttribute(`data-${OWNER}-data-state-lease`)).toBe('["closed","open"]');
  });

  it("removes the record on return, also when a consumer has taken the value over", () => {
    const element = document.createElement("div");
    const lease = new AttributeLease<HTMLElement>("aria-busy", OWNER);

    lease.write(element, "true");
    element.setAttribute("aria-busy", "consumer");
    lease.return(element);

    expect(element.getAttribute("aria-busy")).toBe("consumer");
    expect(records(element)).toEqual([]);
  });

  it("keeps two owners' records apart, so their leases still unwind last in, first out", () => {
    const element = document.createElement("div");
    element.setAttribute("data-state", "authored");
    new AttributeLease<HTMLElement>("data-state", "stimeo--outer").write(element, "outer");
    new AttributeLease<HTMLElement>("data-state", "stimeo--inner").write(element, "inner");
    const restored = element.cloneNode() as HTMLElement;
    const outer = new AttributeLease<HTMLElement>("data-state", "stimeo--outer");
    const inner = new AttributeLease<HTMLElement>("data-state", "stimeo--inner");

    outer.write(restored, "outer");
    inner.write(restored, "inner");
    inner.return(restored);
    expect(restored.getAttribute("data-state")).toBe("outer");
    outer.return(restored);

    expect(restored.getAttribute("data-state")).toBe("authored");
    expect(records(restored)).toEqual([]);
  });

  it("takes the current value as the author's when no record survived", () => {
    // Turbo's morph keeps only the server's attributes: the record goes and the server
    // value is what the author wrote. The copy is what a later connection meets.
    const original = document.createElement("div");
    new AttributeLease<HTMLElement>("data-state", OWNER).write(original, "open");
    const element = original.cloneNode() as HTMLElement;
    element.removeAttribute(`data-${OWNER}-data-state-lease`);
    element.setAttribute("data-state", "server");
    const lease = new AttributeLease<HTMLElement>("data-state", OWNER);

    lease.write(element, "open");
    lease.return(element);

    expect(element.getAttribute("data-state")).toBe("server");
  });

  it("takes the current value as the author's when the record is not one it could write", () => {
    for (const malformed of ["not json", "1", '{"a":1}']) {
      const element = document.createElement("div");
      element.setAttribute("data-state", "server");
      element.setAttribute(`data-${OWNER}-data-state-lease`, malformed);
      const lease = new AttributeLease<HTMLElement>("data-state", OWNER);

      lease.write(element, "open");
      lease.return(element);

      expect(element.getAttribute("data-state")).toBe("server");
      expect(records(element)).toEqual([]);
    }
  });

  it("records the author's value over a record it could not read, so a later copy still knows it", () => {
    for (const malformed of ["not json", "1", '{"a":1}']) {
      const element = document.createElement("div");
      element.setAttribute("data-state", "server");
      element.setAttribute(`data-${OWNER}-data-state-lease`, malformed);
      new AttributeLease<HTMLElement>("data-state", OWNER).write(element, "open");
      const restored = element.cloneNode() as HTMLElement;
      const lease = new AttributeLease<HTMLElement>("data-state", OWNER);

      lease.write(restored, "open");
      lease.return(restored);

      expect(restored.getAttribute("data-state")).toBe("server");
      expect(records(restored)).toEqual([]);
    }
  });

  describe("a copy it never wrote", () => {
    /** A copy of an element whose authored `data-state` an earlier lease replaced. */
    const restoredDefault = (authored: string | null): HTMLElement => {
      const element = document.createElement("div");
      if (authored !== null) element.setAttribute("data-state", authored);
      new AttributeLease<HTMLElement>("data-state", OWNER).write(element, "open");
      return element.cloneNode() as HTMLElement;
    };

    it("returns the author's value its record holds, while the copy carries the value written last", () => {
      for (const authored of [null, "", "closed"]) {
        const restored = restoredDefault(authored);
        const lease = new AttributeLease<HTMLElement>("data-state", OWNER);

        lease.return(restored);

        expect(restored.getAttribute("data-state")).toBe(authored);
        expect(records(restored)).toEqual([]);
      }
    });

    it("returns a copy carrying either of the values a lease wrote last", () => {
      for (const [authored, written] of [
        [null, ""],
        ["", null],
      ] as const) {
        const element = document.createElement("div");
        if (authored !== null) element.setAttribute("hidden", authored);
        new AttributeLease<HTMLElement>("hidden", OWNER).write(element, written);
        const restored = element.cloneNode() as HTMLElement;

        new AttributeLease<HTMLElement>("hidden", OWNER).return(restored);

        expect(restored.getAttribute("hidden")).toBe(authored);
        expect(records(restored)).toEqual([]);
      }
    });

    it("leaves a value that replaced the one written last, and drops the record", () => {
      const restored = restoredDefault(null);
      restored.setAttribute("data-state", "closing");

      new AttributeLease<HTMLElement>("data-state", OWNER).return(restored);

      expect(restored.getAttribute("data-state")).toBe("closing");
      expect(records(restored)).toEqual([]);
    });

    it("returns nothing without a record it can read, and leaves that record", () => {
      for (const malformed of [
        null,
        "not json",
        '"closed"',
        '["closed"]',
        '["closed", "open", 1]',
        '["closed", 1]',
        '[1, "open"]',
      ]) {
        const element = document.createElement("div");
        element.setAttribute("data-state", "open");
        if (malformed !== null) element.setAttribute(`data-${OWNER}-data-state-lease`, malformed);

        new AttributeLease<HTMLElement>("data-state", OWNER).return(element);

        expect(element.getAttribute("data-state")).toBe("open");
        expect(element.getAttribute(`data-${OWNER}-data-state-lease`)).toBe(malformed);
      }
    });

    it("takes the author's value from the record when it writes the copy, whatever value the copy carries", () => {
      // The lease that wrote the element would also return to the author's value once it
      // writes over a value the page put there.
      const restored = restoredDefault(null);
      restored.setAttribute("data-state", "settling");
      const lease = new AttributeLease<HTMLElement>("data-state", OWNER);

      lease.write(restored, "open");
      lease.return(restored);

      expect(restored.hasAttribute("data-state")).toBe(false);
      expect(records(restored)).toEqual([]);
    });

    it("reads nothing from a copy it neither holds nor carries a record on when it returns it", () => {
      const element = document.createElement("div");
      element.setAttribute("data-state", "authored");
      new AttributeLease<HTMLElement>("data-state", "stimeo--outer").write(element, "outer");
      const restored = element.cloneNode() as HTMLElement;
      new AttributeLease<HTMLElement>("data-state", OWNER).return(restored);
      // A morph then keeps only what the server sent.
      restored.removeAttribute("data-stimeo--outer-data-state-lease");
      restored.setAttribute("data-state", "server");
      const outer = new AttributeLease<HTMLElement>("data-state", "stimeo--outer");

      outer.write(restored, "open");
      outer.return(restored);

      expect(restored.getAttribute("data-state")).toBe("server");
    });

    it("leaves it alone on returnAll, which returns only what it holds", () => {
      const restored = restoredDefault(null);
      const lease = new AttributeLease<HTMLElement>("data-state", OWNER);

      lease.returnAll();

      expect(restored.getAttribute("data-state")).toBe("open");
      expect(records(restored)).toEqual([`data-${OWNER}-data-state-lease`]);
    });
  });

  describe("two leases of one owner on one element", () => {
    const RECORD = `data-${OWNER}-data-state-lease`;
    /** An element authored `data-state="authored"`, written by `first` and then `second`. */
    const shared = () => {
      const element = document.createElement("div");
      element.setAttribute("data-state", "authored");
      const first = new AttributeLease<HTMLElement>("data-state", OWNER);
      const second = new AttributeLease<HTMLElement>("data-state", OWNER);
      first.write(element, "first");
      second.write(element, "second");
      return { element, first, second };
    };

    it("gives the element back the live lease's value when the later one returns", () => {
      const { element, first, second } = shared();

      second.return(element);

      expect(element.getAttribute("data-state")).toBe("first");
      expect(element.getAttribute(RECORD)).toBe('["authored","first"]');
      first.return(element);
      expect(element.getAttribute("data-state")).toBe("authored");
      expect(records(element)).toEqual([]);
    });

    it("keeps the record and the live value when the earlier one returns, and the last one returns the author's", () => {
      const { element, first, second } = shared();

      first.return(element);

      expect(element.getAttribute("data-state")).toBe("second");
      expect(element.getAttribute(RECORD)).toBe('["authored","second"]');
      second.return(element);
      expect(element.getAttribute("data-state")).toBe("authored");
      expect(records(element)).toEqual([]);
    });

    it("keeps the record while any live lease holds the element, returning down the leases in turn", () => {
      const { element, first, second } = shared();
      const third = new AttributeLease<HTMLElement>("data-state", OWNER);
      third.write(element, "third");

      third.return(element);
      expect(element.getAttribute("data-state")).toBe("second");
      second.return(element);
      expect(element.getAttribute("data-state")).toBe("first");
      expect(element.getAttribute(RECORD)).toBe('["authored","first"]');
      first.return(element);

      expect(element.getAttribute("data-state")).toBe("authored");
      expect(records(element)).toEqual([]);
    });

    it("gives the element back the value the live lease wrote last", () => {
      const { element, first, second } = shared();
      first.write(element, "first again");
      second.write(element, "second again");

      second.return(element);

      expect(element.getAttribute("data-state")).toBe("first again");
    });

    it("gives the second of them its own hold on a copy the first took the recorded one of", () => {
      const element = document.createElement("div");
      element.setAttribute("data-state", "authored");
      new AttributeLease<HTMLElement>("data-state", OWNER).write(element, "open");
      const restored = element.cloneNode() as HTMLElement;
      const first = new AttributeLease<HTMLElement>("data-state", OWNER);
      const second = new AttributeLease<HTMLElement>("data-state", OWNER);

      first.write(restored, "one");
      second.write(restored, "two");
      second.return(restored);

      expect(restored.getAttribute("data-state")).toBe("one");
      first.return(restored);
      expect(restored.getAttribute("data-state")).toBe("authored");
    });

    it("returns its own value though a lease of another attribute holds the element", () => {
      const element = document.createElement("div");
      new AttributeLease<HTMLElement>("data-other", OWNER).write(element, "x");
      const lease = new AttributeLease<HTMLElement>("data-state", OWNER);
      lease.write(element, "open");

      lease.return(element);

      expect(element.hasAttribute("data-state")).toBe(false);
      expect(records(element)).toEqual([`data-${OWNER}-data-other-lease`]);
    });
  });

  describe("an element it holds", () => {
    it("keeps what it remembers over the record on the element", () => {
      const element = document.createElement("div");
      const lease = new AttributeLease<HTMLElement>("data-state", OWNER);
      lease.write(element, "open");
      element.setAttribute(`data-${OWNER}-data-state-lease`, '["elsewhere", "open"]');

      lease.return(element);

      expect(element.hasAttribute("data-state")).toBe(false);
    });

    it("keeps the record of a value the page replaced, until the return", () => {
      const element = document.createElement("div");
      const lease = new AttributeLease<HTMLElement>("data-state", OWNER);
      lease.write(element, "open");
      element.setAttribute("data-state", "settling");

      expect(records(element)).toEqual([`data-${OWNER}-data-state-lease`]);
      lease.return(element);
      expect(element.getAttribute("data-state")).toBe("settling");
      expect(records(element)).toEqual([]);
    });

    it("records the author's value with the value it wrote last, and no record once it writes the author's", () => {
      const element = document.createElement("div");
      element.setAttribute("data-state", "closed");
      const lease = new AttributeLease<HTMLElement>("data-state", OWNER);
      const record = () => element.getAttribute(`data-${OWNER}-data-state-lease`);

      lease.write(element, "open");
      expect(record()).toBe('["closed","open"]');
      lease.write(element, null);
      expect(record()).toBe('["closed",null]');
      lease.write(element, "closed");
      expect(record()).toBeNull();
    });
  });

  describe("what a return says", () => {
    /** A copy of an element whose authored `data-state` an earlier lease of the owner replaced. */
    const copied = (): HTMLElement => {
      const element = document.createElement("div");
      element.setAttribute("data-state", "closed");
      new AttributeLease<HTMLElement>("data-state", OWNER).write(element, "open");
      return element.cloneNode() as HTMLElement;
    };

    it("says it returned a lease it holds, and a copy's record, whatever value the element carries", () => {
      const element = document.createElement("div");
      const lease = new AttributeLease<HTMLElement>("data-state", OWNER);
      lease.write(element, "open");
      expect(lease.return(element)).toBe(true);

      expect(new AttributeLease<HTMLElement>("data-state", OWNER).return(copied())).toBe(true);
      const replaced = copied();
      replaced.setAttribute("data-state", "settling");
      expect(new AttributeLease<HTMLElement>("data-state", OWNER).return(replaced)).toBe(true);
      expect(replaced.getAttribute("data-state")).toBe("settling");
    });

    it("says there was nothing to return without a record, or once it returned", () => {
      const lease = new AttributeLease<HTMLElement>("data-state", OWNER);
      const element = document.createElement("div");
      element.setAttribute("data-state", "open");
      expect(lease.return(element)).toBe(false);

      element.setAttribute(`data-${OWNER}-data-state-lease`, '"closed"');
      expect(lease.return(element)).toBe(false);

      const restored = copied();
      lease.return(restored);
      expect(lease.return(restored)).toBe(false);
      expect(restored.getAttribute("data-state")).toBe("closed");
    });

    it("says there was nothing to return from an element another live lease of the owner holds", () => {
      const restored = copied();
      const peer = new AttributeLease<HTMLElement>("data-state", OWNER);
      peer.write(restored, "settling");

      expect(new AttributeLease<HTMLElement>("data-state", OWNER).return(restored)).toBe(false);
      expect(restored.getAttribute("data-state")).toBe("settling");
      expect(restored.getAttribute(`data-${OWNER}-data-state-lease`)).toBe('["closed","settling"]');
      peer.return(restored);
      expect(restored.getAttribute("data-state")).toBe("closed");
    });

    it("says it returned a copy's record of its own owner only", () => {
      expect(new AttributeLease<HTMLElement>("data-state", "stimeo--other").return(copied())).toBe(
        false,
      );
      expect(new AttributeLease<HTMLElement>("hidden", OWNER).return(copied())).toBe(false);
    });

    it("says it returned a hold beneath another owner's lease, which leaves the element as it shows", () => {
      const element = document.createElement("div");
      element.setAttribute("data-state", "closed");
      const lease = new AttributeLease<HTMLElement>("data-state", OWNER);
      const above = new AttributeLease<HTMLElement>("data-state", "stimeo--other");
      lease.write(element, "open");
      above.write(element, "settling");

      expect(lease.return(element)).toBe(true);
      expect(element.getAttribute("data-state")).toBe("settling");
      expect(lease.return(element)).toBe(false);
      above.return(element);
      expect(element.getAttribute("data-state")).toBe("closed");
    });

    it("says it returned the hold a copy's record lists beneath another owner's", () => {
      const element = document.createElement("div");
      element.setAttribute("data-state", "closed");
      new AttributeLease<HTMLElement>("data-state", OWNER).write(element, "open");
      new AttributeLease<HTMLElement>("data-state", "stimeo--other").write(element, "settling");
      const restored = element.cloneNode() as HTMLElement;

      expect(new AttributeLease<HTMLElement>("data-state", OWNER).return(restored)).toBe(true);
      expect(restored.getAttribute("data-state")).toBe("settling");
      expect(restored.hasAttribute(`data-${OWNER}-data-state-lease`)).toBe(false);
      new AttributeLease<HTMLElement>("data-state", "stimeo--other").return(restored);
      expect(restored.getAttribute("data-state")).toBe("closed");
    });
  });

  describe("leasedAuthorValue", () => {
    it("reads the author's value a lease of any owner records while it holds the attribute moved", () => {
      const field = document.createElement("input");
      field.type = "password";
      const lease = new AttributeLease<HTMLInputElement>("type", "stimeo--reveal");
      expect(leasedAuthorValue(field, "type")).toBeUndefined();

      lease.write(field, "text");
      expect(leasedAuthorValue(field, "type")).toBe("password");
      expect(leasedAuthorValue(field.cloneNode() as Element, "type")).toBe("password");
      lease.return(field);
      expect(leasedAuthorValue(field, "type")).toBeUndefined();
    });

    it("reads an absent author's value as null, and skips what is no record of the attribute", () => {
      const element = document.createElement("div");
      new AttributeLease<HTMLElement>("role", OWNER).write(element, "img");
      expect(leasedAuthorValue(element, "role")).toBeNull();

      const other = document.createElement("div");
      other.setAttribute("x-role-lease", '["region","img"]');
      other.setAttribute(`data-${OWNER}-role-lease`, '"region"');
      other.setAttribute("data-elsewhere-role-lease", '["status","img"]');
      expect(leasedAuthorValue(other, "role")).toBe("status");
    });
  });

  describe("leases of two owners on one element", () => {
    const outerRecord = "data-stimeo--outer-data-state-lease";
    const innerRecord = "data-stimeo--inner-data-state-lease";
    const outerLease = () => new AttributeLease<HTMLElement>("data-state", "stimeo--outer");
    const innerLease = () => new AttributeLease<HTMLElement>("data-state", "stimeo--inner");
    /** An element authored `data-state="authored"`, written by an outer and then an inner lease. */
    const stacked = () => {
      const element = document.createElement("div");
      element.setAttribute("data-state", "authored");
      const outer = outerLease();
      const inner = innerLease();
      outer.write(element, "outer-1");
      inner.write(element, "inner");
      return { element, outer, inner };
    };

    it("gives the element back what the outer lease wrote last, though it wrote again under the inner one", () => {
      const { element, outer, inner } = stacked();
      outer.write(element, "outer-2");
      inner.write(element, "inner");

      inner.return(element);
      expect(element.getAttribute("data-state")).toBe("outer-2");
      outer.return(element);

      expect(element.getAttribute("data-state")).toBe("authored");
      expect(records(element)).toEqual([]);
    });

    it("returns the author's value from the inner lease once the outer one returned first", () => {
      const { element, outer, inner } = stacked();

      outer.return(element);
      expect(element.getAttribute("data-state")).toBe("inner");
      inner.return(element);

      expect(element.getAttribute("data-state")).toBe("authored");
      expect(records(element)).toEqual([]);
    });

    it("gives a restored copy back what the outer lease wrote there, where it wrote before the inner one", () => {
      const { element } = stacked();
      const restored = element.cloneNode() as HTMLElement;
      const outer = outerLease();
      const inner = innerLease();

      outer.write(restored, "outer-2");
      inner.write(restored, "inner");
      inner.return(restored);
      expect(restored.getAttribute("data-state")).toBe("outer-2");
      outer.return(restored);

      expect(restored.getAttribute("data-state")).toBe("authored");
      expect(records(restored)).toEqual([]);
    });

    it("gives a restored copy neither lease wrote back what the outer one wrote, and then the author's value", () => {
      const { element } = stacked();
      const restored = element.cloneNode() as HTMLElement;

      innerLease().return(restored);
      expect(restored.getAttribute("data-state")).toBe("outer-1");
      outerLease().return(restored);

      expect(restored.getAttribute("data-state")).toBe("authored");
      expect(records(restored)).toEqual([]);
    });

    it("returns the author's value from a restored copy whose outer lease returned first", () => {
      const { element } = stacked();
      const restored = element.cloneNode() as HTMLElement;

      outerLease().return(restored);
      expect(restored.getAttribute(outerRecord)).toBeNull();
      innerLease().return(restored);

      expect(restored.getAttribute("data-state")).toBe("authored");
      expect(records(restored)).toEqual([]);
    });

    it("keeps the record of an inner lease that writes the author's value, so a copy still returns to the outer one", () => {
      const { element, inner } = stacked();
      inner.write(element, "authored");
      expect(element.getAttribute(innerRecord)).not.toBeNull();
      const restored = element.cloneNode() as HTMLElement;

      innerLease().return(restored);

      expect(restored.getAttribute("data-state")).toBe("outer-1");
    });

    it("gives the element back the absence the outer lease wrote", () => {
      const element = document.createElement("div");
      element.setAttribute("data-state", "authored");
      const outer = outerLease();
      const inner = innerLease();
      outer.write(element, null);
      inner.write(element, "inner");

      inner.return(element);
      expect(element.hasAttribute("data-state")).toBe(false);
      outer.return(element);

      expect(element.getAttribute("data-state")).toBe("authored");
      expect(records(element)).toEqual([]);
    });

    it("takes a value the page wrote over the outer lease as the author's", () => {
      const element = document.createElement("div");
      element.setAttribute("data-state", "authored");
      const outer = outerLease();
      const inner = innerLease();
      outer.write(element, "outer-1");
      element.setAttribute("data-state", "page");

      inner.write(element, "inner");
      expect(element.getAttribute(innerRecord)).toBe(`["page","inner",false,"${outerRecord}"]`);
      inner.return(element);

      expect(element.getAttribute("data-state")).toBe("page");
      expect(element.getAttribute(innerRecord)).toBeNull();
    });

    it("puts on top of a copy the lease written over a value the page put there, whichever was constructed first", () => {
      for (const [first, second] of [
        ["stimeo--column-a1", "stimeo--column-b1"],
        ["stimeo--column-b2", "stimeo--column-a2"],
      ] as const) {
        const lease = (owner: string) => new AttributeLease<HTMLElement>("data-state", owner);
        const shown = first.includes("-a") ? first : second;
        const beneath = shown === first ? second : first;
        // Construct both in registration order, so either one may be read first.
        lease(first);
        lease(second);
        const element = document.createElement("div");
        element.setAttribute("data-state", "authored");
        lease(beneath).write(element, "beneath");
        element.setAttribute("data-state", "page");
        lease(shown).write(element, "shown");
        const restored = element.cloneNode() as HTMLElement;

        lease(shown).return(restored);

        expect(restored.getAttribute("data-state")).toBe("page");
      }
    });

    it("hands back the page's value from the lease written over it once the lease it lay on returned first", () => {
      const element = document.createElement("div");
      element.setAttribute("data-state", "authored");
      new AttributeLease<HTMLElement>("data-state", "stimeo--lower").write(element, "lower");
      element.setAttribute("data-state", "page");
      const outer = outerLease();
      const inner = innerLease();
      outer.write(element, "outer");
      inner.write(element, "inner");

      outer.return(element);
      inner.return(element);

      expect(element.getAttribute("data-state")).toBe("page");
    });

    it("keeps the inner lease's value when the outer one, which wrote the same value, returns first", () => {
      const element = document.createElement("div");
      element.setAttribute("data-state", "authored");
      const outer = outerLease();
      const inner = innerLease();
      outer.write(element, "same");
      inner.write(element, "same");

      outer.return(element);
      expect(element.getAttribute("data-state")).toBe("same");
      inner.return(element);

      expect(element.getAttribute("data-state")).toBe("authored");
      expect(records(element)).toEqual([]);
    });

    it("keeps the inner lease's value when the outer one returns after writing that value beneath it", () => {
      const { element, outer, inner } = stacked();
      outer.write(element, "inner");

      outer.return(element);
      expect(element.getAttribute("data-state")).toBe("inner");
      inner.return(element);

      expect(element.getAttribute("data-state")).toBe("authored");
      expect(records(element)).toEqual([]);
    });

    it("shows nothing the outer lease writes beneath the inner one until the inner one returns", () => {
      const { element, outer, inner } = stacked();

      outer.write(element, "outer-2");
      expect(element.getAttribute("data-state")).toBe("inner");
      expect(element.getAttribute(outerRecord)).toBe('["authored","outer-2"]');
      inner.return(element);

      expect(element.getAttribute("data-state")).toBe("outer-2");
    });

    it("keeps the inner lease on top of a restored copy the outer lease writes first", () => {
      const { element } = stacked();
      const restored = element.cloneNode() as HTMLElement;
      const outer = outerLease();
      const inner = innerLease();

      outer.write(restored, "outer-2");
      expect(restored.getAttribute("data-state")).toBe("inner");
      inner.return(restored);
      expect(restored.getAttribute("data-state")).toBe("outer-2");
      outer.return(restored);

      expect(restored.getAttribute("data-state")).toBe("authored");
      expect(records(restored)).toEqual([]);
    });

    it("returns a restored copy to the author's value, though the inner lease writes it before the outer one returns it", () => {
      const element = document.createElement("div");
      element.setAttribute("data-state", "authored");
      outerLease().write(element, "outer-1");
      const restored = element.cloneNode() as HTMLElement;
      const outer = outerLease();
      const inner = innerLease();

      inner.write(restored, "inner");
      outer.return(restored);
      expect(restored.getAttribute("data-state")).toBe("inner");
      inner.return(restored);

      expect(restored.getAttribute("data-state")).toBe("authored");
      expect(records(restored)).toEqual([]);
    });

    it("records an outer lease that holds the author's value beneath the inner one, so a copy stacks them as the page did", () => {
      const element = document.createElement("div");
      element.setAttribute("data-state", "authored");
      outerLease().write(element, "authored");
      expect(element.getAttribute(outerRecord)).toBeNull();
      innerLease().write(element, "inner");
      expect(element.getAttribute(outerRecord)).toBe('["authored","authored"]');
      const restored = element.cloneNode() as HTMLElement;
      const outer = outerLease();
      const inner = innerLease();

      outer.write(restored, "outer-2");
      expect(restored.getAttribute("data-state")).toBe("inner");
      inner.return(restored);
      expect(restored.getAttribute("data-state")).toBe("outer-2");
      outer.return(restored);

      expect(restored.getAttribute("data-state")).toBe("authored");
      expect(records(restored)).toEqual([]);
    });
  });

  describe("a base lease", () => {
    const baseRecord = "data-stimeo--base-aria-invalid-lease";
    const otherRecord = "data-stimeo--other-aria-invalid-lease";
    const baseLease = () =>
      new AttributeLease<HTMLElement>("aria-invalid", "stimeo--base", { base: true });
    const otherLease = () => new AttributeLease<HTMLElement>("aria-invalid", "stimeo--other");
    const authored = () => {
      const element = document.createElement("div");
      element.setAttribute("aria-invalid", "false");
      return element;
    };

    it("writes beneath the lease of another owner that holds the element", () => {
      const element = authored();
      const other = otherLease();
      const base = baseLease();
      other.write(element, "true");

      base.write(element, "false");
      expect(element.getAttribute("aria-invalid")).toBe("true");
      expect(element.getAttribute(otherRecord)).toBe(`["false","true","${baseRecord}"]`);
      base.write(element, "spelling");
      expect(element.getAttribute("aria-invalid")).toBe("true");
      other.return(element);
      expect(element.getAttribute("aria-invalid")).toBe("spelling");
      base.return(element);

      expect(element.getAttribute("aria-invalid")).toBe("false");
      expect(records(element)).toEqual([]);
    });

    it("leaves the element to the other owner's lease when it returns first", () => {
      const element = authored();
      const other = otherLease();
      const base = baseLease();
      other.write(element, "true");
      base.write(element, "true");

      base.return(element);
      expect(element.getAttribute("aria-invalid")).toBe("true");
      other.return(element);

      expect(element.getAttribute("aria-invalid")).toBe("false");
      expect(records(element)).toEqual([]);
    });

    it("shows its write once the page wrote over the other owner's lease, and takes the author's value from the bottom of the stack", () => {
      const element = authored();
      const other = otherLease();
      const base = baseLease();
      other.write(element, "true");
      element.setAttribute("aria-invalid", "page");
      base.write(element, "spelling");
      expect(element.getAttribute("aria-invalid")).toBe("spelling");
      other.return(element);
      expect(element.getAttribute("aria-invalid")).toBe("spelling");

      base.write(element, "grammar");
      base.return(element);

      expect(element.getAttribute("aria-invalid")).toBe("false");
    });

    it("lies under another owner's lease written after it, as any lease does", () => {
      const element = authored();
      const base = baseLease();
      const other = otherLease();
      base.write(element, "false");
      other.write(element, "true");

      expect(element.getAttribute("aria-invalid")).toBe("true");
      other.return(element);

      expect(element.getAttribute("aria-invalid")).toBe("false");
    });

    it("keeps its place beneath the other owner's lease on a restored copy it writes first", () => {
      const element = authored();
      otherLease().write(element, "true");
      baseLease().write(element, "false");
      const restored = element.cloneNode() as HTMLElement;
      const base = baseLease();
      const other = otherLease();

      base.write(restored, "false");
      expect(restored.getAttribute("aria-invalid")).toBe("true");
      other.return(restored);

      expect(restored.getAttribute("aria-invalid")).toBe("false");
      expect(records(restored)).toEqual([]);
    });
  });

  describe("after the page replaced the value of the top lease", () => {
    const lowerLease = () => new AttributeLease<HTMLElement>("aria-invalid", "stimeo--lower");
    const upperLease = () => new AttributeLease<HTMLElement>("aria-invalid", "stimeo--upper");
    /**
     * An element authored `aria-invalid="false"`, held by a lower and then an upper lease, whose
     * value the page then replaces with `"page"`, as a Turbo morph puts the server's value back.
     */
    const replaced = () => {
      const element = document.createElement("div");
      element.setAttribute("aria-invalid", "false");
      const lower = lowerLease();
      const upper = upperLease();
      lower.write(element, "lower");
      upper.write(element, "upper");
      element.setAttribute("aria-invalid", "page");
      return { element, lower, upper };
    };

    it("shows the next write of a lease beneath the top", () => {
      const { element, lower, upper } = replaced();

      lower.write(element, "lower-2");
      expect(element.getAttribute("aria-invalid")).toBe("lower-2");
      upper.return(element);
      expect(element.getAttribute("aria-invalid")).toBe("lower-2");
      lower.return(element);

      expect(element.getAttribute("aria-invalid")).toBe("false");
      expect(records(element)).toEqual([]);
    });

    it("gives back, on the return of a lease beneath the top whose write the element shows, what that lease gives back on top", () => {
      const { element, lower, upper } = replaced();
      lower.write(element, "lower-2");

      lower.return(element);
      expect(element.getAttribute("aria-invalid")).toBe("false");
      upper.return(element);

      expect(element.getAttribute("aria-invalid")).toBe("false");
      expect(records(element)).toEqual([]);
    });

    it("leaves the page's value on every return while no lease has written since", () => {
      const { element, lower, upper } = replaced();

      lower.return(element);
      expect(element.getAttribute("aria-invalid")).toBe("page");
      upper.return(element);

      expect(element.getAttribute("aria-invalid")).toBe("page");
      expect(records(element)).toEqual([]);
    });

    it("shows the top lease again once it writes, and nothing beneath it until it returns", () => {
      const { element, lower, upper } = replaced();
      lower.write(element, "lower-2");

      upper.write(element, "upper-2");
      lower.write(element, "lower-3");
      expect(element.getAttribute("aria-invalid")).toBe("upper-2");
      upper.return(element);

      expect(element.getAttribute("aria-invalid")).toBe("lower-3");
    });

    it("decides a restored copy the same way", () => {
      const { element } = replaced();
      const restored = element.cloneNode() as HTMLElement;
      const lower = lowerLease();
      const upper = upperLease();

      lower.write(restored, "lower-2");
      expect(restored.getAttribute("aria-invalid")).toBe("lower-2");
      upper.return(restored);
      lower.return(restored);

      expect(restored.getAttribute("aria-invalid")).toBe("false");
      expect(records(restored)).toEqual([]);
    });
  });

  it("takes back the hold a copy's record described, though another lease's return removed that record", () => {
    const element = document.createElement("div");
    const belowLease = () => new AttributeLease<HTMLElement>("aria-describedby", "stimeo--below");
    const coverLease = () => new AttributeLease<HTMLElement>("aria-describedby", "stimeo--cover");
    belowLease().write(element, "below");
    coverLease().write(element, null);
    const restored = element.cloneNode() as HTMLElement;
    const below = belowLease();
    const cover = coverLease();

    below.return(restored);
    cover.return(restored);
    below.write(restored, "v");
    cover.write(restored, "x");

    expect(restored.getAttribute("aria-describedby")).toBe("x");
    cover.return(restored);
    expect(restored.getAttribute("aria-describedby")).toBe("v");
    below.return(restored);
    expect(restored.hasAttribute("aria-describedby")).toBe(false);
    expect(records(restored)).toEqual([]);
  });

  describe("a restored copy, decided as the live page", () => {
    /** Runs `then` on the live element and, with leases constructed afresh, on a copy taken after `before`. */
    const liveAndCopy = (
      owners: readonly string[],
      before: (leases: AttributeLease<HTMLElement>[], element: HTMLElement) => void,
      then: (leases: AttributeLease<HTMLElement>[], element: HTMLElement) => void,
    ) => {
      const make = () =>
        owners.map((owner) => new AttributeLease<HTMLElement>("data-state", owner));
      const element = document.createElement("div");
      element.setAttribute("data-state", "authored");
      const live = make();
      before(live, element);
      const restored = element.cloneNode() as HTMLElement;
      const fresh = make();
      then(live, element);
      then(fresh, restored);
      return { element, restored };
    };

    it("orders two leases, the later one written over a value the page put there, as the live page did", () => {
      const { element, restored } = liveAndCopy(
        ["stimeo--first", "stimeo--second"],
        ([first, second], target) => {
          first?.write(target, "first");
          target.setAttribute("data-state", "page-1");
          second?.write(target, "second");
          target.setAttribute("data-state", "page-2");
        },
        ([first, second], target) => {
          second?.write(target, "second-2");
          first?.write(target, "first-2");
        },
      );

      expect(element.getAttribute("data-state")).toBe("second-2");
      expect(restored.getAttribute("data-state")).toBe("second-2");
    });

    it("gives the author's value back and leaves no record once every lease returns, one owner holding beneath and above another", () => {
      const { element, restored } = liveAndCopy(
        ["stimeo--a", "stimeo--b", "stimeo--a"],
        ([first, other, second], target) => {
          first?.write(target, "x");
          other?.write(target, "y");
          second?.write(target, "z");
        },
        (leases, target) => {
          for (const lease of leases) lease.return(target);
        },
      );

      expect([element.getAttribute("data-state"), records(element)]).toEqual(["authored", []]);
      expect([restored.getAttribute("data-state"), records(restored)]).toEqual(["authored", []]);
    });

    it("takes a hold that showed the author's value alone, and so left no record, by its first write on a copy", () => {
      const { element, restored } = liveAndCopy(
        ["stimeo--first", "stimeo--second"],
        ([first], target) => first?.write(target, "authored"),
        ([first, second], target) => {
          second?.write(target, "second");
          first?.write(target, "first");
        },
      );

      expect(element.getAttribute("data-state")).toBe("second");
      expect(restored.getAttribute("data-state")).toBe("first");
    });

    it("gives the hold an owner's record describes to the first of the owner's two leases to write on a copy", () => {
      const { element, restored } = liveAndCopy(
        ["stimeo--twice", "stimeo--twice"],
        ([lower, upper], target) => {
          lower?.write(target, "lower");
          upper?.write(target, "upper");
        },
        ([lower], target) => lower?.write(target, "lower-2"),
      );

      expect(element.getAttribute("data-state")).toBe("upper");
      expect(restored.getAttribute("data-state")).toBe("lower-2");
    });
  });
});
