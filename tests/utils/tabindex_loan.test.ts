import { beforeEach, describe, expect, it } from "vitest";
import { TabindexLoan } from "../../src/utils/tabindex_loan";

/**
 * Tests for {@link TabindexLoan}: the borrow guard (never overwrite an authored
 * value), the two-condition return that keeps a consumer's later edit, and the
 * teardown paths.
 *
 * The two-condition return is the reason this registry exists, so each half of
 * the condition gets its own case. Assertions read the DOM rather than the
 * registry: the API is two methods on purpose, so there is no bookkeeping
 * accessor to assert against.
 */
describe("TabindexLoan", () => {
  let loan: TabindexLoan;
  let element: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    element = document.querySelector<HTMLElement>("#host") as HTMLElement;
    loan = new TabindexLoan();
  });

  describe("lending", () => {
    it("adds tabindex=-1 by default", () => {
      loan.lend(element);
      expect(element.getAttribute("tabindex")).toBe("-1");
    });

    it("lends the configured value", () => {
      // scroll-area needs a real Tab stop, not a programmatic-only one.
      const tabStop = new TabindexLoan("0");
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
  });
});
