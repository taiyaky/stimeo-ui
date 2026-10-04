import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabindexLoan } from "../../src/utils/tabindex_loan";

/**
 * Tests for {@link TabindexLoan}: the borrow guard (never overwrite an authored
 * value), the two-condition return that keeps a consumer's later edit, and the
 * teardown paths.
 *
 * The two-condition return is the reason this registry exists, so each half of
 * the condition gets its own case. Assertions read the DOM rather than the
 * registry: the API exposes no bookkeeping accessor to assert against.
 */
describe("TabindexLoan", () => {
  let loan: TabindexLoan;
  let element: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    element = document.querySelector<HTMLElement>("#host") as HTMLElement;
    loan = new TabindexLoan("-1", "stimeo--probe");
  });

  afterEach(() => {
    loan.returnAll();
    document.body.innerHTML = "";
  });

  describe("lending", () => {
    it("adds tabindex=-1 by default", () => {
      loan.lend(element);
      expect(element.getAttribute("tabindex")).toBe("-1");
    });

    it("lends the configured value", () => {
      // scroll-area needs a real Tab stop, not a programmatic-only one.
      const tabStop = new TabindexLoan("0", "stimeo--probe");
      tabStop.lend(element);
      expect(element.getAttribute("tabindex")).toBe("0");
    });

    it("never overwrites an authored tabindex", () => {
      // The value is the author's — overwriting it would change the Tab order
      // *and* leave the registry believing it may remove what it never added.
      element.setAttribute("tabindex", "0");

      loan.lend(element);

      expect(element.getAttribute("tabindex")).toBe("0");
      loan.returnAll();
      expect(element.getAttribute("tabindex")).toBe("0");
    });

    it("treats an authored value equal to its own as the author's too", () => {
      // Same value, different owner: nothing was lent, so nothing may be taken.
      element.setAttribute("tabindex", "-1");

      loan.lend(element);
      loan.returnAll();

      expect(element.getAttribute("tabindex")).toBe("-1");
    });
  });

  describe("returning", () => {
    it("removes the attribute it lent", () => {
      loan.lend(element);
      loan.returnAll();
      expect(element.hasAttribute("tabindex")).toBe(false);
    });

    it("keeps a value the consumer changed after the loan", () => {
      // The second half of the condition. A consumer that made the element its
      // own Tab stop owns the value now; removing it would discard their markup.
      loan.lend(element);
      element.setAttribute("tabindex", "0");

      loan.returnAll();

      expect(element.getAttribute("tabindex")).toBe("0");
    });

    it("drops the bookkeeping even when it leaves the value alone", () => {
      // The loan is over either way — otherwise a later return would remove a
      // value this instance never wrote.
      loan.lend(element);
      element.setAttribute("tabindex", "0");
      loan.returnAll();

      element.setAttribute("tabindex", "-1"); // consumer's own -1 this time
      loan.returnAll();

      expect(element.getAttribute("tabindex")).toBe("-1");
    });

    it("lends again once every loan is back", () => {
      loan.lend(element);
      loan.returnAll();

      loan.lend(element);

      expect(element.getAttribute("tabindex")).toBe("-1");
      loan.returnAll();
      expect(element.hasAttribute("tabindex")).toBe(false);
    });

    it("judges each element of a set on its own", () => {
      document.body.innerHTML = "<div id='a'></div><div id='b'></div><div id='c'></div>";
      const [a, b, c] = ["a", "b", "c"].map(
        (id) => document.querySelector<HTMLElement>(`#${id}`) as HTMLElement,
      ) as [HTMLElement, HTMLElement, HTMLElement];
      for (const el of [a, b, c]) loan.lend(el);
      b.setAttribute("tabindex", "0"); // consumer took ownership of this one

      loan.returnAll();

      expect(a.hasAttribute("tabindex")).toBe(false);
      expect(b.getAttribute("tabindex")).toBe("0");
      expect(c.hasAttribute("tabindex")).toBe(false);
    });

    it("survives a second returnAll", () => {
      loan.lend(element);
      loan.returnAll();
      expect(() => loan.returnAll()).not.toThrow();
      expect(element.hasAttribute("tabindex")).toBe(false);
    });

    it("gives back a loan its owner recorded on an element it does not hold", () => {
      loan.lend(element);
      const copy = element.cloneNode() as HTMLElement;

      new TabindexLoan("-1", "stimeo--probe").reclaim(copy);

      expect(copy.hasAttribute("tabindex")).toBe(false);
      expect(copy.hasAttribute("data-stimeo--probe-tabindex-loan")).toBe(false);
    });

    it("reclaims neither a loan it holds nor an authored tabindex", () => {
      const authored = document.createElement("div");
      authored.setAttribute("tabindex", "-1");
      loan.lend(element);

      loan.reclaim(element);
      loan.reclaim(authored);

      expect(element.getAttribute("tabindex")).toBe("-1");
      expect(authored.getAttribute("tabindex")).toBe("-1");
    });

    it("reclaims no loan from the element that holds focus", () => {
      // A restored copy that holds focus still uses its loan: removing it would drop
      // focus to <body>.
      loan.lend(element);
      const copy = element.cloneNode() as HTMLElement;
      element.replaceWith(copy);
      copy.focus();
      expect(document.activeElement).toBe(copy);

      new TabindexLoan("-1", "stimeo--probe").reclaim(copy);

      expect(copy.getAttribute("tabindex")).toBe("-1");
      expect(document.activeElement).toBe(copy);
    });

    it.each(["light", "own shadow", "nested shadow", "unassigned light"])(
      "reclaims a copied loan in %s while retaining live and authored values",
      (location) => {
        const root = document.createElement("div");
        document.body.append(root);
        let scope: ParentNode = root;
        if (location === "own shadow") scope = root.attachShadow({ mode: "open" });
        if (location === "nested shadow") {
          const outer = root.attachShadow({ mode: "open" });
          const inner = document.createElement("div");
          outer.append(inner);
          scope = inner.attachShadow({ mode: "open" });
        }
        if (location === "unassigned light") root.attachShadow({ mode: "open" });
        loan.lend(element);
        const copy = element.cloneNode() as HTMLElement;
        const authored = document.createElement("div");
        authored.setAttribute("tabindex", "-1");
        scope.append(copy, authored, element);

        new TabindexLoan("-1", "stimeo--probe").reclaimWithin(root);

        expect(copy.hasAttribute("tabindex")).toBe(false);
        expect(copy.hasAttribute("data-stimeo--probe-tabindex-loan")).toBe(false);
        expect(element.getAttribute("tabindex")).toBe("-1");
        expect(element.getAttribute("data-stimeo--probe-tabindex-loan")).toBe("-1");
        expect(authored.getAttribute("tabindex")).toBe("-1");
      },
    );

    it("reclaims only the record of a loan whose value a consumer has taken over", () => {
      loan.lend(element);
      const copy = element.cloneNode() as HTMLElement;
      copy.setAttribute("tabindex", "0");

      new TabindexLoan("-1", "stimeo--probe").reclaim(copy);

      expect(copy.getAttribute("tabindex")).toBe("0");
      expect(copy.hasAttribute("data-stimeo--probe-tabindex-loan")).toBe(false);
    });
  });
});

/**
 * The record a loan leaves on the element it lent to, so a connection that adopts a
 * restored clone of the element can tell its owner's loan from an authored `tabindex`.
 */
describe("TabindexLoan records", () => {
  const OWNER = "stimeo--probe";
  const RECORD = `data-${OWNER}-tabindex-loan`;

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("adopts its owner's loan on a restored clone, and gives it back", () => {
    const element = document.createElement("div");
    new TabindexLoan("-1", OWNER).lend(element);
    const restored = element.cloneNode() as HTMLElement;
    const loan = new TabindexLoan("-1", OWNER);

    loan.lend(restored);
    expect(restored.getAttribute("tabindex")).toBe("-1");
    loan.returnAll();

    expect(restored.hasAttribute("tabindex")).toBe(false);
    expect(restored.hasAttribute(RECORD)).toBe(false);
  });

  it("names the record after the owner", () => {
    const element = document.createElement("div");
    new TabindexLoan("0", OWNER).lend(element);

    expect(element.getAttribute(RECORD)).toBe("0");
    expect(RECORD).not.toMatch(/-(value|target|outlet|class|param)$/);
  });

  it("treats a tabindex carrying another owner's record, or another value, as not its own", () => {
    const other = document.createElement("div");
    new TabindexLoan("-1", "stimeo--other").lend(other);
    const changed = document.createElement("div");
    new TabindexLoan("-1", OWNER).lend(changed);
    changed.setAttribute("tabindex", "0");
    const loan = new TabindexLoan("-1", OWNER);

    loan.lend(other);
    loan.lend(changed);
    loan.returnAll();

    expect(other.getAttribute("tabindex")).toBe("-1");
    expect(changed.getAttribute("tabindex")).toBe("0");
  });

  it("reclaims nothing on the strength of a record that holds no loan of its value", () => {
    for (const malformed of ["", "not json", "0"]) {
      const element = document.createElement("div");
      element.setAttribute("tabindex", "-1");
      element.setAttribute(RECORD, malformed);

      new TabindexLoan("-1", OWNER).reclaim(element);

      expect(element.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("drops the record when the loan ends, also when a consumer has taken the value over", () => {
    const element = document.createElement("div");
    const loan = new TabindexLoan("-1", OWNER);
    loan.lend(element);
    element.setAttribute("tabindex", "0");

    loan.returnAll();

    expect(element.getAttribute("tabindex")).toBe("0");
    expect(element.hasAttribute(RECORD)).toBe(false);
  });

  describe("two loans of one owner on one element", () => {
    it.each(["the earlier", "the later"])(
      "keeps the loan while the other one lends it, when %s one returns first",
      (first) => {
        const element = document.createElement("div");
        const earlier = new TabindexLoan("-1", OWNER);
        const later = new TabindexLoan("-1", OWNER);
        earlier.lend(element);
        later.lend(element);
        const [returnedFirst, returnedLast] =
          first === "the earlier" ? [earlier, later] : [later, earlier];

        returnedFirst.returnAll();

        expect(element.getAttribute("tabindex")).toBe("-1");
        expect(element.getAttribute(RECORD)).toBe("-1");
        returnedLast.returnAll();
        expect(element.hasAttribute("tabindex")).toBe(false);
        expect(element.hasAttribute(RECORD)).toBe(false);
      },
    );

    it("returns its own loan though a loan of another owner holds the element", () => {
      const element = document.createElement("div");
      const other = new TabindexLoan("-1", "stimeo--other");
      other.lend(element);
      // The page took the other owner's tabindex away, so the element is free to lend.
      element.removeAttribute("tabindex");
      const loan = new TabindexLoan("-1", OWNER);
      loan.lend(element);

      loan.returnAll();

      expect(element.hasAttribute("tabindex")).toBe(false);
      expect(element.hasAttribute(RECORD)).toBe(false);
    });

    it("reclaims no loan another live loan of its owner holds", () => {
      const element = document.createElement("div");
      document.body.append(element);
      const live = new TabindexLoan("-1", OWNER);
      live.lend(element);

      new TabindexLoan("-1", OWNER).reclaim(element);

      expect(element.getAttribute("tabindex")).toBe("-1");
      expect(element.getAttribute(RECORD)).toBe("-1");
      live.returnAll();
      expect(element.hasAttribute("tabindex")).toBe(false);
    });
  });

  it("lends again where the page removed the tabindex and the record, and gives it back", () => {
    const element = document.createElement("div");
    const loan = new TabindexLoan("-1", OWNER);
    loan.lend(element);
    element.removeAttribute("tabindex");
    element.removeAttribute(RECORD);

    loan.lend(element);
    expect([element.getAttribute("tabindex"), element.getAttribute(RECORD)]).toEqual(["-1", "-1"]);
    loan.returnAll();

    expect(element.hasAttribute("tabindex")).toBe(false);
    expect(element.hasAttribute(RECORD)).toBe(false);
  });

  it("leaves a value the page wrote over its loan when it lends again", () => {
    const element = document.createElement("div");
    const loan = new TabindexLoan("-1", OWNER);
    loan.lend(element);
    element.setAttribute("tabindex", "0");

    loan.lend(element);
    loan.returnAll();

    expect(element.getAttribute("tabindex")).toBe("0");
  });

  describe("loans of two owners on one element", () => {
    const OTHER = "stimeo--other";
    const OTHER_RECORD = `data-${OTHER}-tabindex-loan`;

    it("keeps the other owner's loan, lent once the page removed the tabindex, when the first loan returns", () => {
      const element = document.createElement("div");
      const first = new TabindexLoan("-1", OWNER);
      const other = new TabindexLoan("-1", OTHER);
      first.lend(element);
      element.removeAttribute("tabindex");
      other.lend(element);

      first.returnAll();
      expect(element.getAttribute("tabindex")).toBe("-1");
      expect([element.hasAttribute(RECORD), element.getAttribute(OTHER_RECORD)]).toEqual([
        false,
        "-1",
      ]);
      other.returnAll();

      expect(element.hasAttribute("tabindex")).toBe(false);
      expect(element.hasAttribute(OTHER_RECORD)).toBe(false);
    });

    it.each(["the earlier", "the later"])(
      "shares a loan of the same value the other owner holds until the last of them returns, when %s one returns first",
      (first) => {
        const element = document.createElement("div");
        const earlier = new TabindexLoan("-1", OWNER);
        const later = new TabindexLoan("-1", OTHER);
        earlier.lend(element);
        later.lend(element);
        const [returnedFirst, returnedLast] =
          first === "the earlier" ? [earlier, later] : [later, earlier];

        returnedFirst.returnAll();
        expect(element.getAttribute("tabindex")).toBe("-1");
        returnedLast.returnAll();

        expect(element.hasAttribute("tabindex")).toBe(false);
        expect(element.getAttributeNames().filter((name) => name.endsWith("-loan"))).toEqual([]);
      },
    );

    it("lends its own value over the other owner's loan and gives that loan's value back", () => {
      const element = document.createElement("div");
      const focusable = new TabindexLoan("-1", OWNER);
      const stop = new TabindexLoan("0", OTHER);
      focusable.lend(element);

      stop.lend(element);
      expect(element.getAttribute("tabindex")).toBe("0");
      stop.returnAll();
      expect(element.getAttribute("tabindex")).toBe("-1");
      focusable.returnAll();

      expect(element.hasAttribute("tabindex")).toBe(false);
    });

    it("keeps the tabindex on a restored copy until the last owner's recorded loan is reclaimed", () => {
      const element = document.createElement("div");
      new TabindexLoan("-1", OWNER).lend(element);
      new TabindexLoan("-1", OTHER).lend(element);
      const restored = element.cloneNode() as HTMLElement;
      document.body.append(restored);

      new TabindexLoan("-1", OWNER).reclaim(restored);
      expect(restored.getAttribute("tabindex")).toBe("-1");
      expect(restored.getAttribute(OTHER_RECORD)).toBe("-1");
      new TabindexLoan("-1", OTHER).reclaim(restored);

      expect(restored.hasAttribute("tabindex")).toBe(false);
      expect(restored.getAttributeNames().filter((name) => name.endsWith("-loan"))).toEqual([]);
    });

    it("gives the copy's tabindex to the recorded loan beneath once the loan of the value it carries is reclaimed", () => {
      const element = document.createElement("div");
      // Owners no other test names, the covering one constructed first.
      const cover = () => new TabindexLoan("0", "stimeo--copy-cover");
      const beneath = () => new TabindexLoan("-1", "stimeo--copy-beneath");
      cover();
      beneath().lend(element);
      cover().lend(element);
      const restored = element.cloneNode() as HTMLElement;
      document.body.append(restored);

      cover().reclaim(restored);
      expect(restored.getAttribute("tabindex")).toBe("-1");
      beneath().reclaim(restored);

      expect(restored.hasAttribute("tabindex")).toBe(false);
    });

    it("gives back the page's removal from a loan lent over one lent after it, once that one returned first", () => {
      const element = document.createElement("div");
      const first = new TabindexLoan("-1", OWNER);
      const middle = new TabindexLoan("-1", OTHER);
      const top = new TabindexLoan("0", "stimeo--third");
      first.lend(element);
      element.removeAttribute("tabindex");
      middle.lend(element);
      top.lend(element);

      middle.returnAll();
      expect(element.getAttribute("tabindex")).toBe("0");
      top.returnAll();

      expect(element.hasAttribute("tabindex")).toBe(false);
      first.returnAll();
      expect(element.hasAttribute("tabindex")).toBe(false);
    });
  });

  it("writes the record only where it changes", async () => {
    const element = document.createElement("div");
    document.body.append(element);
    const first = new TabindexLoan("-1", OWNER);
    const second = new TabindexLoan("-1", OWNER);
    first.lend(element);
    const seen: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) seen.push(record.attributeName ?? "");
    });
    observer.observe(element, { attributes: true });

    second.lend(element);
    first.returnAll();
    await Promise.resolve();
    observer.disconnect();

    expect(seen).toEqual([]);
    second.returnAll();
  });

  it("reclaims no loan of another value its owner recorded", () => {
    const element = document.createElement("div");
    element.setAttribute("tabindex", "0");
    element.setAttribute(RECORD, "0");

    new TabindexLoan("-1", OWNER).reclaim(element);

    expect(element.getAttribute("tabindex")).toBe("0");
    expect(element.getAttribute(RECORD)).toBe("0");
  });

  it("keeps a live loan through turbo:before-cache, which also fires on a page that stays", () => {
    const add = vi.spyOn(document, "addEventListener");
    const element = document.createElement("div");
    document.body.append(element);
    const loan = new TabindexLoan("0", OWNER);

    loan.lend(element);
    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(element.getAttribute("tabindex")).toBe("0");
    expect(add).not.toHaveBeenCalled();
    add.mockRestore();
    loan.returnAll();
  });
});
