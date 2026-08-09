import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { PaginationController } from "../src/controllers/pagination_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link PaginationController}: current-page state,
 * `aria-current` sync, boundary disabling of prev/next (without stranding
 * focus), runtime Value/target changes, and the `change` event.
 */

const markup = (page: number | string = 1, total: number | string = 3) => `
  <nav data-controller="stimeo--pagination" aria-label="Pagination"
       data-stimeo--pagination-page-value="${page}"
       data-stimeo--pagination-total-value="${total}">
    <button type="button" data-stimeo--pagination-target="prev"
            data-action="click->stimeo--pagination#prev">Prev</button>
    <button type="button" data-page="1" data-stimeo--pagination-target="page"
            data-action="click->stimeo--pagination#select">1</button>
    <button type="button" data-page="2" data-stimeo--pagination-target="page"
            data-action="click->stimeo--pagination#select">2</button>
    <button type="button" data-page="3" data-stimeo--pagination-target="page"
            data-action="click->stimeo--pagination#select">3</button>
    <button type="button" data-stimeo--pagination-target="next"
            data-action="click->stimeo--pagination#next">Next</button>
  </nav>`;

/** `data-page` inputs and the page they must resolve to (`null` = ignored). */
const SELECT_CASES: ReadonlyArray<{ raw: string; expected: number | null }> = [
  { raw: "", expected: null },
  { raw: "   ", expected: null },
  { raw: "abc", expected: null },
  { raw: "3.7", expected: null },
  { raw: "NaN", expected: null },
  { raw: "Infinity", expected: null },
  { raw: "-1", expected: 1 },
  { raw: "0", expected: 1 },
  { raw: "3.0", expected: 3 },
  { raw: "1e0", expected: 1 },
  { raw: "99", expected: 3 },
];

const BOUNDARY_ATTR = "data-stimeo--pagination-boundary-disabled";

describe("PaginationController", () => {
  let application: Application;

  /** Mounts arbitrary markup and waits for Stimulus to connect. */
  const mount = async (html: string) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--pagination", PaginationController);
    await tick();
  };

  const start = (page: number | string = 1, total: number | string = 3) =>
    mount(markup(page, total));

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--pagination']") as HTMLElement;
  const pages = () =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-stimeo--pagination-target='page']"),
    );
  const prev = () =>
    document.querySelector<HTMLButtonElement>(
      "[data-stimeo--pagination-target='prev']",
    ) as HTMLButtonElement;
  const next = () =>
    document.querySelector<HTMLButtonElement>(
      "[data-stimeo--pagination-target='next']",
    ) as HTMLButtonElement;
  const current = () => pages().map((p) => p.getAttribute("aria-current"));
  const totalAttr = () => root().getAttribute("data-stimeo--pagination-total-value");
  const pageAttr = () => root().getAttribute("data-stimeo--pagination-page-value");

  /** Records every `change` detail dispatched from the (first) controller root. */
  const recordChanges = () => {
    const details: Array<{ page: number; total: number; previous: number }> = [];
    root().addEventListener("stimeo--pagination:change", (event) => {
      details.push((event as CustomEvent).detail);
    });
    return details;
  };

  it("marks the active page with aria-current and disables prev at the start", async () => {
    await start(1, 3);
    expect(current()).toEqual(["page", null, null]);
    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(false);
  });

  it("normalizes out-of-range initial page/total on connect", async () => {
    await start(99, 0); // total <= 0 normalizes to 1; page clamps to [1, 1]
    expect(current()).toEqual(["page", null, null]);
    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(true);
  });

  it("normalizes a non-numeric total-value on connect", async () => {
    // `Math.trunc(NaN)` is NaN, so an unguarded normalization would leave the
    // whole controller (and every later `change` detail) on NaN.
    await start(2, "abc");
    expect(totalAttr()).toBe("1");
    expect(pageAttr()).toBe("1");
    expect(current()).toEqual(["page", null, null]);
    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(true);
  });

  it("normalizes an infinite total-value on connect", async () => {
    await start(1, "Infinity");
    expect(totalAttr()).toBe("1");
    expect(next().disabled).toBe(true);
  });

  it("normalizes a fractional total-value on connect", async () => {
    await start(1, "2.7");
    expect(totalAttr()).toBe("2");
    expect(next().disabled).toBe(false);
  });

  it("uses the page=1 / total=1 defaults when no Value attributes are present", async () => {
    await mount(`
      <nav data-controller="stimeo--pagination" aria-label="Pagination">
        <button type="button" data-stimeo--pagination-target="prev"
                data-action="click->stimeo--pagination#prev">Prev</button>
        <button type="button" data-page="1" data-stimeo--pagination-target="page"
                data-action="click->stimeo--pagination#select">1</button>
        <button type="button" data-stimeo--pagination-target="next"
                data-action="click->stimeo--pagination#next">Next</button>
      </nav>`);
    expect(current()).toEqual(["page"]);
    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(true);
    // The Number defaults already satisfy the contract, so nothing is written back.
    expect(root().hasAttribute("data-stimeo--pagination-page-value")).toBe(false);
    expect(root().hasAttribute("data-stimeo--pagination-total-value")).toBe(false);
  });

  it("does not rewrite already-normalized Values on connect", async () => {
    document.body.innerHTML = markup(2, 3);
    const rewrites: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName) rewrites.push(record.attributeName);
      }
    });
    observer.observe(root(), {
      attributes: true,
      attributeFilter: [
        "data-stimeo--pagination-page-value",
        "data-stimeo--pagination-total-value",
      ],
    });

    application = Application.start();
    application.register("stimeo--pagination", PaginationController);
    await tick();
    observer.disconnect();

    expect(rewrites).toEqual([]);
  });

  it("moves aria-current when a page button is selected", async () => {
    await start(1, 3);
    pages()[1]?.click();
    expect(current()).toEqual([null, "page", null]);
    expect(prev().disabled).toBe(false);
    expect(next().disabled).toBe(false);
  });

  it("steps with next/prev and disables next at the last page", async () => {
    await start(2, 3);
    next().click();
    expect(current()).toEqual([null, null, "page"]);
    expect(next().disabled).toBe(true);
    prev().click();
    expect(current()).toEqual([null, "page", null]);
    expect(next().disabled).toBe(false);
  });

  it("clamps a selection above total to the last page", async () => {
    // A disabled boundary button never dispatches its action, so the clamp has to
    // be exercised through a page button carrying an out-of-range `data-page`.
    await start(2, 3);
    const details = recordChanges();
    const button = pages()[0] as HTMLButtonElement;
    button.dataset.page = "99";
    button.click();
    expect(details).toEqual([{ page: 3, total: 3, previous: 2 }]);
    expect(next().disabled).toBe(true);
  });

  it("clamps a selection below 1 to the first page", async () => {
    await start(2, 3);
    const details = recordChanges();
    const button = pages()[2] as HTMLButtonElement;
    button.dataset.page = "0";
    button.click();
    expect(details).toEqual([{ page: 1, total: 3, previous: 2 }]);
    expect(prev().disabled).toBe(true);
  });

  it.each(SELECT_CASES)('resolves data-page="$raw" to $expected', async ({ raw, expected }) => {
    await start(2, 3);
    const details = recordChanges();
    const button = pages()[2] as HTMLButtonElement;
    button.dataset.page = raw;
    button.click();
    expect(details.map((detail) => detail.page)).toEqual(expected === null ? [] : [expected]);
  });

  it("moves focus off prev before disabling it at the boundary", async () => {
    await start(2, 3);
    prev().focus();
    prev().click(); // -> page 1, prev becomes disabled
    expect(prev().disabled).toBe(true);
    expect(document.activeElement).not.toBe(prev());
    // Focus is moved to the opposite (next) control so it is not stranded.
    expect(document.activeElement).toBe(next());
  });

  it("moves focus off next before disabling it at the last page", async () => {
    await start(2, 3);
    next().focus();
    next().click(); // -> page 3, next becomes disabled
    expect(next().disabled).toBe(true);
    expect(document.activeElement).not.toBe(next());
    // Hands off to the opposite (prev) control rather than stranding focus.
    expect(document.activeElement).toBe(prev());
  });

  it("hands focus to an opposite button the same render re-enables", async () => {
    // total=2 moves straight from one boundary to the other: `next` is still
    // `disabled` when `prev` disables, so the hand-off must look at the state this
    // render produces, not the one it started from.
    await mount(`
      <nav data-controller="stimeo--pagination" aria-label="Pagination"
           data-stimeo--pagination-page-value="2"
           data-stimeo--pagination-total-value="2">
        <button type="button" data-stimeo--pagination-target="prev"
                data-action="click->stimeo--pagination#prev">Prev</button>
        <button type="button" data-page="1" data-stimeo--pagination-target="page"
                data-action="click->stimeo--pagination#select">1</button>
        <button type="button" data-page="2" data-stimeo--pagination-target="page"
                data-action="click->stimeo--pagination#select">2</button>
        <button type="button" data-stimeo--pagination-target="next"
                data-action="click->stimeo--pagination#next">Next</button>
      </nav>`);
    expect(next().disabled).toBe(true);

    prev().focus();
    prev().click(); // -> page 1: prev disables while next is re-enabled in the same pass
    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(false);
    expect(document.activeElement).toBe(next());
    expect(root().hasAttribute("tabindex")).toBe(false);
  });

  it("keeps focus in the landmark when a lone boundary button disables (no page buttons)", async () => {
    // Degenerate config: only a Next button, no prev and no page buttons. When it
    // disables at the last page there is no opposite/current button to receive
    // focus, so focus must land on the (now focusable) landmark, not <body>.
    await mount(`
      <nav data-controller="stimeo--pagination" aria-label="Pagination"
           data-stimeo--pagination-page-value="1"
           data-stimeo--pagination-total-value="2">
        <button type="button" data-stimeo--pagination-target="next"
                data-action="click->stimeo--pagination#next">Next</button>
      </nav>`);

    next().focus();
    next().click(); // -> page 2 (last), next becomes disabled
    expect(next().disabled).toBe(true);
    expect(document.activeElement).not.toBe(next());
    expect(document.activeElement).toBe(root());
    expect(root().getAttribute("tabindex")).toBe("-1");
  });

  it("removes the fallback tabindex it added when the controller disconnects", async () => {
    await mount(`
      <nav data-controller="stimeo--pagination" aria-label="Pagination"
           data-stimeo--pagination-page-value="1"
           data-stimeo--pagination-total-value="2">
        <button type="button" data-stimeo--pagination-target="next"
                data-action="click->stimeo--pagination#next">Next</button>
      </nav>`);
    next().focus();
    next().click();
    expect(root().getAttribute("tabindex")).toBe("-1");

    application.unload("stimeo--pagination");
    expect(root().hasAttribute("tabindex")).toBe(false);
  });

  it("preserves an authored root tabindex when the controller disconnects", async () => {
    await mount(`
      <nav data-controller="stimeo--pagination" aria-label="Pagination" tabindex="-1"
           data-stimeo--pagination-page-value="1"
           data-stimeo--pagination-total-value="2">
        <button type="button" data-stimeo--pagination-target="next"
                data-action="click->stimeo--pagination#next">Next</button>
      </nav>`);
    next().focus();
    next().click();
    expect(document.activeElement).toBe(root());

    application.unload("stimeo--pagination");
    expect(root().getAttribute("tabindex")).toBe("-1");
  });

  it("falls back to the landmark when every focus destination is disabled", async () => {
    // `focus()` on a disabled button is swallowed, so an unchecked destination
    // leaves the caret in the subtree that is about to disable and drops it to
    // <body> a frame later.
    //
    // Both page buttons are present on purpose. The rescue resolves the page the
    // click just *landed on*, so a fixture without `data-page="2"` resolves no
    // candidate at all and passes without ever reaching the check it is meant to
    // exercise.
    await mount(`
      <nav data-controller="stimeo--pagination" aria-label="Pagination"
           data-stimeo--pagination-page-value="1"
           data-stimeo--pagination-total-value="2">
        <button type="button" data-page="1" disabled data-stimeo--pagination-target="page"
                data-action="click->stimeo--pagination#select">1</button>
        <button type="button" data-page="2" disabled data-stimeo--pagination-target="page"
                data-action="click->stimeo--pagination#select">2</button>
        <button type="button" data-stimeo--pagination-target="next"
                data-action="click->stimeo--pagination#next">Next</button>
      </nav>`);
    next().focus();

    next().click(); // -> page 2, Next disables and hands focus off

    // Page 2's button is disabled, so the pre-check rejects it and the landmark
    // path runs. Without the pre-check the caret stays on the button that is
    // about to disable, and neither assertion holds.
    expect(root().getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(root());
  });

  it("keeps a root tabindex the consumer changed after the loan", async () => {
    // Owning the borrow is not enough to take it back: a consumer that made the
    // root its own Tab stop afterwards owns the value now, and removing it would
    // discard their markup.
    await mount(`
      <nav data-controller="stimeo--pagination" aria-label="Pagination"
           data-stimeo--pagination-page-value="1"
           data-stimeo--pagination-total-value="2">
        <button type="button" data-stimeo--pagination-target="next"
                data-action="click->stimeo--pagination#next">Next</button>
      </nav>`);
    next().focus();
    next().click();
    expect(root().getAttribute("tabindex")).toBe("-1"); // lent

    root().setAttribute("tabindex", "0"); // consumer takes ownership
    application.unload("stimeo--pagination");

    expect(root().getAttribute("tabindex")).toBe("0");
  });

  it("keeps a disabled the consumer set away from a boundary", async () => {
    await start(1, 3);
    next().disabled = true; // consumer-owned (loading / permissions), not a boundary
    pages()[1]?.click(); // -> page 2, neither boundary
    expect(current()).toEqual([null, "page", null]);
    expect(next().disabled).toBe(true); // consumer's disabled survives
    expect(prev().disabled).toBe(false); // the controller's own boundary one is released
  });

  it("does not claim a consumer-owned disabled when it overlaps a boundary", async () => {
    await start(2, 3);
    next().disabled = true;
    expect(next().hasAttribute(BOUNDARY_ATTR)).toBe(false);

    pages()[2]?.click(); // -> page 3, where Next is also a boundary control
    expect(next().disabled).toBe(true);
    expect(next().hasAttribute(BOUNDARY_ATTR)).toBe(false);

    pages()[1]?.click(); // -> page 2, away from the boundary again
    expect(next().disabled).toBe(true);
    expect(next().hasAttribute(BOUNDARY_ATTR)).toBe(false);
  });

  it("re-renders when the page Value changes at runtime", async () => {
    await start(1, 3);
    const details = recordChanges();
    root().setAttribute("data-stimeo--pagination-page-value", "3");
    await tick();
    expect(current()).toEqual([null, null, "page"]);
    expect(prev().disabled).toBe(false);
    expect(next().disabled).toBe(true);
    expect(details).toEqual([]); // normalization/reflection is not a navigation
  });

  it("re-renders when the total Value changes at runtime", async () => {
    await start(2, 3);
    expect(next().disabled).toBe(false);
    root().setAttribute("data-stimeo--pagination-total-value", "2");
    await tick();
    expect(next().disabled).toBe(true);
    expect(current()).toEqual([null, "page", null]);
  });

  it("normalizes a bad Value written at runtime without dispatching change", async () => {
    await start(2, 3);
    const details = recordChanges();
    root().setAttribute("data-stimeo--pagination-total-value", "abc");
    await tick();
    await tick(); // the write-back re-enters the value callback once
    expect(totalAttr()).toBe("1");
    expect(pageAttr()).toBe("1");
    expect(current()).toEqual(["page", null, null]);
    expect(details).toEqual([]);
  });

  it("uses the normalized total in change.detail after a runtime total change", async () => {
    await start(1, 5);
    root().setAttribute("data-stimeo--pagination-total-value", "2.7");
    await tick();
    const details = recordChanges();
    next().click();
    expect(details).toEqual([{ page: 2, total: 2, previous: 1 }]);
    expect(next().disabled).toBe(true);
  });

  it("gives a page button added at runtime the current-page marker", async () => {
    await start(4, 4); // no button carries data-page="4" yet
    expect(current()).toEqual([null, null, null]);

    const button = document.createElement("button");
    button.type = "button";
    button.dataset.page = "4";
    button.setAttribute("data-stimeo--pagination-target", "page");
    button.setAttribute("data-action", "click->stimeo--pagination#select");
    button.textContent = "4";
    next().before(button);
    await tick();

    expect(current()).toEqual([null, null, null, "page"]);
  });

  it.each([
    { target: "prev" as const, page: 1 },
    { target: "next" as const, page: 3 },
  ])("syncs a replaced $target target at its boundary", async ({ target, page }) => {
    await start(page, 3);
    const original = target === "prev" ? prev() : next();
    const replacement = document.createElement("button");
    replacement.type = "button";
    replacement.textContent = target === "prev" ? "Previous replacement" : "Next replacement";
    replacement.setAttribute("data-stimeo--pagination-target", target);
    original.replaceWith(replacement);
    await tick();

    expect(replacement.disabled).toBe(true);
    expect(replacement.hasAttribute(BOUNDARY_ATTR)).toBe(true);
  });

  it("re-renders on reconnect after a Turbo-style snapshot restore", async () => {
    await start(2, 3);
    application.unload("stimeo--pagination");
    // A restored snapshot can disagree with the controller-owned attributes.
    for (const page of pages()) page.removeAttribute("aria-current");
    root().setAttribute("data-stimeo--pagination-page-value", "3");

    application.register("stimeo--pagination", PaginationController);
    await tick();

    expect(current()).toEqual([null, null, "page"]);
    expect(next().disabled).toBe(true);
    expect(prev().disabled).toBe(false);
  });

  it("stops responding once the controller is unloaded", async () => {
    await start(2, 3);
    const details = recordChanges();
    application.unload("stimeo--pagination");

    next().click();
    expect(details).toEqual([]);
    expect(current()).toEqual([null, "page", null]);
    expect(root().hasAttribute("tabindex")).toBe(false);
  });

  it("keeps two pagination instances independent", async () => {
    await mount(`${markup(1, 3)}${markup(2, 3)}`);
    const navs = Array.from(document.querySelectorAll<HTMLElement>("nav"));
    const [first, second] = [navs[0] as HTMLElement, navs[1] as HTMLElement];
    const currentIn = (nav: HTMLElement) =>
      Array.from(nav.querySelectorAll("[data-stimeo--pagination-target='page']")).map((page) =>
        page.getAttribute("aria-current"),
      );
    const nextIn = (nav: HTMLElement) =>
      nav.querySelector<HTMLButtonElement>(
        "[data-stimeo--pagination-target='next']",
      ) as HTMLButtonElement;

    expect(currentIn(first)).toEqual(["page", null, null]);
    expect(currentIn(second)).toEqual([null, "page", null]);

    nextIn(second).click(); // -> page 3 in the second instance only
    expect(currentIn(second)).toEqual([null, null, "page"]);
    expect(nextIn(second).disabled).toBe(true);
    expect(currentIn(first)).toEqual(["page", null, null]);
    expect(nextIn(first).disabled).toBe(false);
  });

  it("dispatches change with page, total, and previous", async () => {
    await start(1, 3);
    const details = recordChanges();
    pages()[2]?.click();
    expect(details).toEqual([{ page: 3, total: 3, previous: 1 }]);
  });

  it("announces role, name, and current page in order", async () => {
    await start(1, 3);
    const phrases = await captureSpeech({ container: root(), steps: 6 });
    expect(phrases).toEqual([
      "navigation, Pagination",
      "button, Prev, disabled",
      "button, 1, current page",
      "button, 2",
      "button, 3",
      "button, Next",
      "end of navigation, Pagination",
    ]);
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(1, 3);
    await expectNoA11yViolations(root());
  });

  it("has no machine-detectable a11y violations after moving to either boundary", async () => {
    await start(2, 3);
    pages()[2]?.click(); // last page: next disabled
    await expectNoA11yViolations(root());
    pages()[0]?.click(); // first page: prev disabled
    await expectNoA11yViolations(root());
  });

  it("ignores a page button with a non-numeric data-page", async () => {
    await start(1, 3);
    const button = pages()[1] as HTMLButtonElement;
    button.dataset.page = "not-a-number";
    button.click();
    // Invalid target → no navigation; the first page stays current.
    expect(current()).toEqual(["page", null, null]);
  });

  it("is a no-op (no change event) when the current page is reselected", async () => {
    await start(2, 3);
    const details = recordChanges();
    pages()[1]?.click(); // page 2 is already current
    expect(details).toEqual([]);
    expect(current()).toEqual([null, "page", null]);
  });
});
