import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaginationController } from "../src/controllers/pagination_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

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
const PAGE_ATTR = "data-stimeo--pagination-page-value";
const TOTAL_ATTR = "data-stimeo--pagination-total-value";

/** A pagination that records every `page` / `total` callback delivery it receives. */
const countingPagination = (deliveries: string[]) =>
  class extends PaginationController {
    override pageValueChanged(): void {
      deliveries.push(`page:${this.pageValue}`);
      super.pageValueChanged();
    }

    override totalValueChanged(): void {
      deliveries.push(`total:${this.totalValue}`);
      super.totalValueChanged();
    }
  };

describe("PaginationController", () => {
  let application: Application;

  /** Mounts arbitrary markup and waits for Stimulus to connect. */
  const mount = async (html: string, controller = PaginationController) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--pagination", controller);
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
  const totalAttr = () => root().getAttribute(TOTAL_ATTR);
  const pageAttr = () => root().getAttribute(PAGE_ATTR);

  /** Records each write to the `page` / `total` attributes as `name:previous value`. */
  const recordValueWrites = () => {
    const writes: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const name = record.attributeName === PAGE_ATTR ? "page" : "total";
        writes.push(`${name}:${record.oldValue}`);
      }
    });
    observer.observe(root(), {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: [PAGE_ATTR, TOTAL_ATTR],
    });
    return { writes, stop: () => observer.disconnect() };
  };

  /** Records every `change` detail dispatched from the (first) controller root. */
  const recordChanges = () => {
    const details: Array<{ page: number; total: number; previous: number }> = [];
    root().addEventListener("stimeo--pagination:change", (event) => {
      details.push((event as CustomEvent).detail);
    });
    return details;
  };

  type Report = { type: string; page: number; total: number; previous: number };

  /** Records every `change` and `reconcile` the (first) root dispatches, in order. */
  const recordReports = () => {
    const reports: Report[] = [];
    for (const type of ["change", "reconcile"]) {
      root().addEventListener(`stimeo--pagination:${type}`, (event) => {
        const detail = (event as CustomEvent<Omit<Report, "type">>).detail;
        reports.push({ type, ...detail });
      });
    }
    return reports;
  };

  it("marks the active page with aria-current and disables prev at the start", async () => {
    await start(1, 3);
    expect(current()).toEqual(["page", null, null]);
    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(false);
  });

  it("clamps out-of-range initial page/total for display, leaving the declarations as written", async () => {
    await start(99, 0); // total <= 0 counts as 1; page clamps to [1, 1]
    expect(current()).toEqual(["page", null, null]);
    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(true);
    expect(pageAttr()).toBe("99");
    expect(totalAttr()).toBe("0");
  });

  it("counts a non-numeric total-value as one page without rewriting it", async () => {
    // `Math.trunc(NaN)` is NaN, so an unguarded clamp would leave the display (and
    // every later `change` detail) on NaN.
    await start(2, "abc");
    expect(current()).toEqual(["page", null, null]);
    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(true);
    expect(totalAttr()).toBe("abc");
    expect(pageAttr()).toBe("2");
  });

  it("counts an infinite total-value as one page without rewriting it", async () => {
    await start(1, "Infinity");
    expect(next().disabled).toBe(true);
    expect(totalAttr()).toBe("Infinity");
  });

  it("truncates a fractional total-value for display without rewriting it", async () => {
    await start(1, "2.7");
    expect(next().disabled).toBe(false);
    expect(totalAttr()).toBe("2.7");
  });

  it("writes nothing back for an out-of-range declaration, at connect or at runtime", async () => {
    // One callback per write the page makes, and no write in reply: the display
    // clamps the Values, the attributes keep what the page declared.
    const deliveries: string[] = [];
    document.body.innerHTML = markup(99, 3);
    const connectWrites = recordValueWrites();
    application = Application.start();
    application.register("stimeo--pagination", countingPagination(deliveries));
    await tick();
    connectWrites.stop();
    expect(connectWrites.writes).toEqual([]);
    expect(current()).toEqual([null, null, "page"]);

    const runtimeWrites = recordValueWrites();
    deliveries.length = 0;
    root().setAttribute(PAGE_ATTR, "-4");
    await tick();
    runtimeWrites.stop();

    expect(deliveries).toEqual(["page:-4"]);
    expect(runtimeWrites.writes).toEqual(["page:99"]);
    expect(pageAttr()).toBe("-4");
    expect(current()).toEqual(["page", null, null]);
  });

  it("shows the declared page once a later total makes it reachable", async () => {
    await start(5, 3);
    expect(current()).toEqual([null, null, "page"]); // clamped to the last of three

    root().setAttribute(TOTAL_ATTR, "6");
    await tick();
    const details = recordChanges();

    // Page 5 of 6: no button here carries it, and neither boundary is reached.
    expect(current()).toEqual([null, null, null]);
    expect(prev().disabled).toBe(false);
    expect(next().disabled).toBe(false);

    prev().click();
    expect(details).toEqual([{ page: 4, total: 6, previous: 5, reason: "user" }]);
    expect(pageAttr()).toBe("4");
  });

  it("reports the page on screen as previous when the declaration is out of range", async () => {
    // `detail.previous` is the clamped page the reader was looking at, so choosing
    // the page an out-of-range declaration already shows is no move at all.
    await start(99, 3);
    const details = recordChanges();

    pages()[2]?.click(); // page 3 is the one shown
    expect(details).toEqual([]);
    expect(pageAttr()).toBe("99");

    prev().click();
    expect(details).toEqual([{ page: 2, total: 3, previous: 3, reason: "user" }]);
    expect(pageAttr()).toBe("2");
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
    // The display reads the defaults; nothing is written to the Values.
    expect(root().hasAttribute(PAGE_ATTR)).toBe(false);
    expect(root().hasAttribute(TOTAL_ATTR)).toBe(false);
  });

  it("does not rewrite in-range Values on connect", async () => {
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
    expect(details).toEqual([{ page: 3, total: 3, previous: 2, reason: "user" }]);
    expect(next().disabled).toBe(true);
  });

  it("clamps a selection below 1 to the first page", async () => {
    await start(2, 3);
    const details = recordChanges();
    const button = pages()[2] as HTMLButtonElement;
    button.dataset.page = "0";
    button.click();
    expect(details).toEqual([{ page: 1, total: 3, previous: 2, reason: "user" }]);
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

  it("gives back the fallback tabindex a page restored from the cache carries", async () => {
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

    application = await restoreFromCache(application, (restored) =>
      restored.register("stimeo--pagination", PaginationController),
    );

    expect(root().hasAttribute("tabindex")).toBe(false);
    expect(
      root()
        .getAttributeNames()
        .filter((name) => name.endsWith("-loan")),
    ).toEqual([]);
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

  it("keeps a disabled the consumer sets after the boundary one was released", async () => {
    await start(1, 3);
    pages()[1]?.click(); // -> page 2: the controller releases its own Prev disabled
    prev().disabled = true; // consumer-owned from here on
    pages()[2]?.click(); // -> page 3, Prev still away from its boundary
    expect(prev().disabled).toBe(true);
    expect(prev().hasAttribute(BOUNDARY_ATTR)).toBe(false);
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

  it("reflects a bad Value written at runtime without rewriting it or dispatching change", async () => {
    await start(2, 3);
    const details = recordChanges();
    root().setAttribute(TOTAL_ATTR, "abc");
    await tick();
    expect(current()).toEqual(["page", null, null]);
    expect(totalAttr()).toBe("abc");
    expect(pageAttr()).toBe("2");
    expect(details).toEqual([]);
  });

  it("reports a total that pulls the current page down as reconcile", async () => {
    await start(3, 3);
    const reports = recordReports();

    root().setAttribute(TOTAL_ATTR, "2");
    await tick();

    expect(current()).toEqual([null, "page", null]);
    expect(next().disabled).toBe(true);
    expect(reports).toEqual([{ type: "reconcile", page: 2, total: 2, previous: 3 }]);
    expect(pageAttr()).toBe("3");
  });

  it("reports a page the page writes as reconcile, never as change", async () => {
    await start(1, 3);
    const reports = recordReports();

    root().setAttribute(PAGE_ATTR, "3");
    await tick();

    expect(reports).toEqual([{ type: "reconcile", page: 3, total: 3, previous: 1 }]);
  });

  it("measures each page-driven move from the page the one before it showed", async () => {
    await start(1, 3);
    const reports = recordReports();

    // Three batches: each move starts where the one before it left the pager,
    // and the last one returns to the page shown on connect.
    root().setAttribute(PAGE_ATTR, "3");
    await tick();
    root().setAttribute(PAGE_ATTR, "2");
    await tick();
    root().setAttribute(PAGE_ATTR, "1");
    await tick();

    expect(reports).toEqual([
      { type: "reconcile", page: 3, total: 3, previous: 1 },
      { type: "reconcile", page: 2, total: 3, previous: 3 },
      { type: "reconcile", page: 1, total: 3, previous: 2 },
    ]);
  });

  it("stays silent when a change leaves the current page where it is", async () => {
    await start(2, 3);
    const reports = recordReports();

    root().setAttribute(TOTAL_ATTR, "5");
    await tick();
    root().setAttribute(PAGE_ATTR, "2.9");
    await tick();

    expect(current()).toEqual([null, "page", null]);
    expect(reports).toEqual([]);
  });

  it("reports one batch that moves page and total together once", async () => {
    await start(1, 3);
    const reports = recordReports();

    root().setAttribute(PAGE_ATTR, "5");
    root().setAttribute(TOTAL_ATTR, "5");
    await tick();

    expect(prev().disabled).toBe(false);
    expect(next().disabled).toBe(true);
    expect(reports).toEqual([{ type: "reconcile", page: 5, total: 5, previous: 1 }]);
  });

  it("reports nothing on connect, whatever the declarations clamp to", async () => {
    document.body.innerHTML = markup(99, 3);
    const reports: string[] = [];
    const listening = new AbortController();
    for (const type of ["change", "reconcile"]) {
      document.addEventListener(`stimeo--pagination:${type}`, () => reports.push(type), {
        signal: listening.signal,
      });
    }
    application = Application.start();
    application.register("stimeo--pagination", PaginationController);
    await tick();
    listening.abort();

    expect(current()).toEqual([null, null, "page"]);
    expect(reports).toEqual([]);
  });

  it("reports a navigation as change alone, and nothing for its own Value write", async () => {
    await start(1, 3);
    const reports = recordReports();

    next().click();
    await tick();

    expect(reports).toEqual([{ type: "change", page: 2, total: 3, previous: 1, reason: "user" }]);
  });

  it("measures a navigation a reconcile listener makes from the reported page", async () => {
    await start(1, 3);
    const reports = recordReports();
    let answered = false;
    root().addEventListener("stimeo--pagination:reconcile", () => {
      if (answered) return;
      answered = true;
      next().click();
    });

    root().setAttribute(PAGE_ATTR, "2");
    await tick();

    expect(current()).toEqual([null, null, "page"]);
    expect(pageAttr()).toBe("3");
    expect(reports).toEqual([
      { type: "reconcile", page: 2, total: 3, previous: 1 },
      { type: "change", page: 3, total: 3, previous: 2, reason: "user" },
    ]);
  });

  it("drops a pass still pending when it disconnects", async () => {
    await start(1, 3);
    const reports = recordReports();
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--pagination",
    ) as PaginationController;

    root().setAttribute(PAGE_ATTR, "3");
    controller.pageValueChanged();
    controller.disconnect();
    await flushMicrotasks();

    expect(current()).toEqual(["page", null, null]);
    expect(reports).toEqual([]);
  });

  it("uses the normalized total in change.detail after a runtime total change", async () => {
    await start(1, 5);
    root().setAttribute("data-stimeo--pagination-total-value", "2.7");
    await tick();
    const details = recordChanges();
    next().click();
    expect(details).toEqual([{ page: 2, total: 2, previous: 1, reason: "user" }]);
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

  it.each([
    { target: "prev" as const, page: 1 },
    { target: "next" as const, page: 3 },
  ])("syncs a $target added after connect at its boundary", async ({ target, page }) => {
    await start(page, 3);
    (target === "prev" ? prev() : next()).remove();
    await tick();

    // Only the button arrives, so its own callback alone brings the repaint.
    const late = document.createElement("button");
    late.type = "button";
    late.setAttribute("data-stimeo--pagination-target", target);
    root().append(late);
    await tick();

    expect(late.disabled).toBe(true);
    expect(late.hasAttribute(BOUNDARY_ATTR)).toBe(true);
  });

  it.each([
    { target: "prev" as const, page: 1 },
    { target: "next" as const, page: 3 },
  ])(
    "disables a $target that stays at its boundary after an earlier one leaves",
    async ({ target, page }) => {
      await start(page, 3);
      const reports = recordReports();
      const original = target === "prev" ? prev() : next();
      const successor = original.cloneNode(true) as HTMLButtonElement;
      successor.disabled = false;
      successor.removeAttribute(BOUNDARY_ATTR);
      original.after(successor);
      await tick();
      original.remove();
      await tick();

      expect(target === "prev" ? prev() : next()).toBe(successor);
      expect(successor.disabled).toBe(true);
      expect(successor.hasAttribute(BOUNDARY_ATTR)).toBe(true);
      // The button that stays is brought to the boundary silently.
      expect(reports).toEqual([]);
    },
  );

  it.each([
    { target: "prev" as const, page: 3 },
    { target: "next" as const, page: 1 },
  ])(
    "releases a $target that stays away from its boundary after an earlier one leaves",
    async ({ target, page }) => {
      await start(page, 3);
      const original = target === "prev" ? prev() : next();
      const successor = original.cloneNode(true) as HTMLButtonElement;
      successor.disabled = true;
      successor.setAttribute(BOUNDARY_ATTR, "");
      original.after(successor);
      await tick();
      original.remove();
      await tick();

      expect(successor.disabled).toBe(false);
      expect(successor.hasAttribute(BOUNDARY_ATTR)).toBe(false);
    },
  );

  it.each([
    { target: "prev" as const, page: 1 },
    { target: "next" as const, page: 3 },
  ])(
    "gives the boundary disabled back to a $target that stops being the target",
    async ({ target, page }) => {
      await start(page, 3);
      const reports = recordReports();
      const leaving = target === "prev" ? prev() : next();
      expect(leaving.disabled).toBe(true);
      leaving.removeAttribute("data-stimeo--pagination-target");
      await tick();

      expect(leaving.isConnected).toBe(true);
      expect(leaving.disabled).toBe(false);
      expect(leaving.hasAttribute(BOUNDARY_ATTR)).toBe(false);
      expect(reports).toEqual([]);
    },
  );

  it.each([
    { target: "prev" as const, page: 1 },
    { target: "next" as const, page: 3 },
  ])(
    "keeps an authored disabled on a $target that stops being the target",
    async ({ target, page }) => {
      await mount(
        markup(page, 3).replace(
          `data-stimeo--pagination-target="${target}"`,
          `data-stimeo--pagination-target="${target}" disabled`,
        ),
      );
      const leaving = target === "prev" ? prev() : next();
      expect(leaving.hasAttribute(BOUNDARY_ATTR)).toBe(false);
      leaving.removeAttribute("data-stimeo--pagination-target");
      await tick();

      expect(leaving.disabled).toBe(true);
    },
  );

  it("gives the boundary disabled back when the element stops being a pagination", async () => {
    await start(1, 3);
    root().removeAttribute("data-controller");
    await tick();

    expect(prev().disabled).toBe(false);
    expect(prev().hasAttribute(BOUNDARY_ATTR)).toBe(false);
  });

  it("keeps the boundary disabled and its marker through a teardown, for the next connect", async () => {
    await start(1, 3);
    application.unload("stimeo--pagination");
    await tick();

    expect(prev().disabled).toBe(true);
    expect(prev().hasAttribute(BOUNDARY_ATTR)).toBe(true);
  });

  it("keeps navigating when the sole prev and next leave", async () => {
    await start(1, 3);
    const instance = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--pagination",
    ) as PaginationController;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const leavingPrev = prev();
      const leavingNext = next();
      leavingPrev.remove();
      leavingNext.remove();
      await tick();
      expect(() => instance.prevTargetDisconnected(leavingPrev)).not.toThrow();
      expect(() => instance.nextTargetDisconnected(leavingNext)).not.toThrow();
      await tick();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }

    instance.select(pages()[1] as HTMLButtonElement);
    expect(current()).toEqual([null, "page", null]);
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
    expect(details).toEqual([{ page: 3, total: 3, previous: 1, reason: "user" }]);
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

/** Verifies that user navigation is compared with the last published position. */
describe("PaginationController pending page writes", () => {
  let application: Application;
  const root = () =>
    document.querySelector<HTMLElement>('[data-controller="stimeo--pagination"]') as HTMLElement;
  const act = (index: number) =>
    root().querySelectorAll<HTMLButtonElement>("button")[index]?.click();
  const reports = () => {
    const seen: Array<{ name: string; current: number; previous: number }> = [];
    for (const name of ["change", "reconcile"])
      root().addEventListener(`stimeo--pagination:${name}`, (event) => {
        const detail = (event as CustomEvent<{ page: number; previous: number }>).detail;
        seen.push({ name, current: detail.page, previous: detail.previous });
      });
    return seen;
  };
  beforeEach(async () => {
    document.body.innerHTML = `<div data-controller="stimeo--pagination" data-stimeo--pagination-page-value="1" data-stimeo--pagination-total-value="3"><button data-stimeo--pagination-target="page" data-page="1" data-action="click->stimeo--pagination#select">1</button><button data-stimeo--pagination-target="page" data-page="2" data-action="click->stimeo--pagination#select">2</button><button data-stimeo--pagination-target="page" data-page="3" data-action="click->stimeo--pagination#select">3</button></div>`;
    application = Application.start();
    application.register("stimeo--pagination", PaginationController);
    await tick();
  });
  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });
  it("abandons both boundary writes when repair focus changes the range and page", async () => {
    root().insertAdjacentHTML(
      "beforeend",
      '<button data-stimeo--pagination-target="prev">Previous</button><button data-stimeo--pagination-target="next">Next</button>',
    );
    await tick();
    const instance = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--pagination",
    ) as PaginationController;
    const previous = root().querySelector<HTMLButtonElement>(
      '[data-stimeo--pagination-target="prev"]',
    ) as HTMLButtonElement;
    const next = root().querySelector<HTMLButtonElement>(
      '[data-stimeo--pagination-target="next"]',
    ) as HTMLButtonElement;
    act(1);
    previous.focus();
    const seen = reports();
    root()
      .querySelector("button")
      ?.addEventListener(
        "focusin",
        () => {
          instance.totalValue = 3;
          act(1);
        },
        { once: true },
      );
    const writes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => writes.push(...records));
    observer.observe(next, { attributes: true, attributeFilter: ["disabled"] });
    next.disabled = true;
    next.disabled = false;
    expect(observer.takeRecords()).toHaveLength(2);
    instance.totalValue = 1;
    await tick();
    observer.disconnect();
    expect(writes).toEqual([]);
    expect(seen).toEqual([{ name: "change", current: 2, previous: 1 }]);
    expect(instance.pageValue).toBe(2);
    expect(previous.disabled).toBe(false);
    expect(next.disabled).toBe(false);
  });
  it("normalizes an infinite pending page before advancing", () => {
    const instance = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--pagination",
    ) as PaginationController;
    instance.pageValue = Number.POSITIVE_INFINITY;
    instance.next();
    expect(instance.pageValue).toBe(2);
  });
  it("renders without a next button", () => {
    const instance = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--pagination",
    ) as PaginationController;
    expect(() => instance.next()).not.toThrow();
    expect(instance.pageValue).toBe(2);
  });
  it("never hands focus to a button scheduled to become disabled", async () => {
    root().insertAdjacentHTML(
      "beforeend",
      '<button data-stimeo--pagination-target="prev">Previous</button><button data-stimeo--pagination-target="next">Next</button>',
    );
    await tick();
    const instance = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--pagination",
    ) as PaginationController;
    const previous = root().querySelector<HTMLButtonElement>(
      '[data-stimeo--pagination-target="prev"]',
    ) as HTMLButtonElement;
    const next = root().querySelector<HTMLButtonElement>(
      '[data-stimeo--pagination-target="next"]',
    ) as HTMLButtonElement;
    previous.disabled = false;
    previous.focus();
    const focuses: string[] = [];
    next.addEventListener("focusin", () => focuses.push("next"));
    instance.totalValue = 1;
    await tick();
    expect(focuses).toEqual([]);
    expect(document.activeElement).toBe(root().querySelector("button"));
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(true);
  });
  it("leaves newer boundary state intact after a focus subscriber navigates", async () => {
    const element = root();
    element.insertAdjacentHTML(
      "beforeend",
      '<button type="button" data-stimeo--pagination-target="prev">Previous</button><button type="button" data-stimeo--pagination-target="next">Next</button>',
    );
    await tick();
    const previous = element.querySelector<HTMLButtonElement>(
      '[data-stimeo--pagination-target="prev"]',
    ) as HTMLButtonElement;
    const next = element.querySelector<HTMLButtonElement>(
      '[data-stimeo--pagination-target="next"]',
    ) as HTMLButtonElement;
    act(1);
    next.focus();
    const seen = reports();
    let spent = false;
    previous.addEventListener("focusin", () => {
      if (spent) return;
      spent = true;
      act(0);
    });
    act(2);
    await tick();
    expect(seen).toEqual([{ name: "change", current: 1, previous: 3 }]);
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    expect(element.getAttribute("data-stimeo--pagination-page-value")).toBe("1");
  });
  it("reports selecting the pending page as a user change", async () => {
    const seen = reports();
    root().setAttribute("data-stimeo--pagination-page-value", "2");
    act(1);
    await tick();
    expect(seen).toEqual([{ name: "change", current: 2, previous: 1 }]);
  });
  it("reports the last published position as previous", async () => {
    const seen = reports();
    root().setAttribute("data-stimeo--pagination-page-value", "2");
    act(2);
    await tick();
    expect(seen).toEqual([{ name: "change", current: 3, previous: 1 }]);
  });
  it("keeps a return to the last published position silent", async () => {
    const seen = reports();
    root().setAttribute("data-stimeo--pagination-page-value", "2");
    act(0);
    await tick();
    expect(seen).toEqual([]);
    expect(root().getAttribute("data-stimeo--pagination-page-value")).toBe("1");
  });
});

/** Explicit target calls share the DOM action while retaining their own provenance. */
describe("PaginationController target API", () => {
  let application: Application;
  const element = (id: string): HTMLElement => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing API fixture ${id}`);
    return found;
  };
  const instance = (): PaginationController =>
    application.getControllerForElementAndIdentifier(
      element("api-root"),
      "stimeo--pagination",
    ) as PaginationController;
  beforeEach(async () => {
    document.body.innerHTML = `<button id="api-outside">Outside</button><div id="api-root" data-controller="stimeo--pagination" data-stimeo--pagination-total-value="2"><button id="api-a" data-stimeo--pagination-target="page" data-page="1" data-action="click->stimeo--pagination#select"><span>a</span></button><button id="api-b" data-stimeo--pagination-target="page" data-page="2" data-action="click->stimeo--pagination#select"><span>b</span></button></div>`;
    application = Application.start();
    application.register("stimeo--pagination", PaginationController);
    await tick();
  });
  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("retains the existing DOM Event success as a positive control", () => {
    const reports: Array<{ reason?: string }> = [];
    element("api-root").addEventListener("stimeo--pagination:change", (event) => {
      reports.push((event as CustomEvent<{ reason?: string }>).detail);
    });
    element("api-b").click();
    expect(element("api-b").getAttribute("aria-current")).toBe("page");
    expect(reports).toHaveLength(1);
  });

  it.each([false, true])(
    "accepts an owned target or its descendant (%s) after an Event positive control",
    (descendant) => {
      const reports: Array<{ reason?: string }> = [];
      element("api-root").addEventListener("stimeo--pagination:change", (event) => {
        reports.push((event as CustomEvent<{ reason?: string }>).detail);
      });
      element("api-b").click();
      expect(element("api-b").getAttribute("aria-current")).toBe("page");
      expect(reports).toHaveLength(1);
      element("api-outside").focus();
      const target = descendant ? element("api-a").querySelector("span") : element("api-a");
      if (!(target instanceof HTMLElement)) throw new Error("Missing API descendant");
      instance().select(target);
      expect(element("api-a").getAttribute("aria-current")).toBe("page");
      expect(document.activeElement).toBe(element("api-outside"));
      expect(reports.at(-1)?.reason).toBe("api");
      expect(reports[0]?.reason).toBe("user");
    },
  );
  it.each(["foreign", "undeclared", "detached", "nested"])(
    "rejects %s targets through element and Event entry points before accepting an owned target",
    (kind) => {
      const reports: unknown[] = [];
      element("api-root").addEventListener("stimeo--pagination:change", (event) => {
        reports.push((event as CustomEvent<unknown>).detail);
      });
      const invalid = element("api-b").cloneNode(true);
      if (!(invalid instanceof HTMLElement)) throw new Error("Missing cloned target");
      invalid.id = "api-invalid";
      invalid.removeAttribute("data-action");
      if (kind === "foreign") document.body.append(invalid);
      if (kind === "undeclared") {
        invalid.removeAttribute("data-stimeo--pagination-target");
        element("api-root").append(invalid);
      }
      if (kind === "nested") {
        const nested = document.createElement("div");
        nested.setAttribute("data-controller", "stimeo--pagination");
        nested.append(invalid);
        element("api-a").append(nested);
      }
      element("api-outside").focus();
      const before = element("api-root").innerHTML;
      instance().select(invalid);
      invalid.addEventListener("probe", (event) => instance().select(event));
      invalid.dispatchEvent(new Event("probe"));
      expect(element("api-root").innerHTML).toBe(before);
      expect(reports).toEqual([]);
      expect(document.activeElement).toBe(element("api-outside"));
      instance().select(element("api-b"));
      expect(element("api-b").getAttribute("aria-current")).toBe("page");
      expect(reports).toHaveLength(1);
    },
  );

  it.each([
    ["focusin", "focus"],
    ["pointerenter", "pointer"],
    ["click", "user"],
  ])("retains %s Event provenance for an action bound on a target descendant", (type, reason) => {
    const reports: Array<{ reason: string }> = [];
    element("api-root").addEventListener("stimeo--pagination:change", (event) => {
      reports.push((event as CustomEvent<{ reason: string }>).detail);
    });
    const child = element("api-b").querySelector("span");
    if (!(child instanceof HTMLElement)) throw new Error("Missing action descendant");
    child.addEventListener(type, (event) => instance().select(event));
    child.dispatchEvent(new Event(type));
    expect(element("api-b").getAttribute("aria-current")).toBe("page");
    expect(reports.map((detail) => detail.reason)).toEqual([reason]);
  });

  it("reports API navigation without an Event and preserves supplied Event provenance", () => {
    const reports: Array<{ page: number; total: number; previous: number; reason: string }> = [];
    element("api-root").addEventListener("stimeo--pagination:change", (event) => {
      reports.push(
        (event as CustomEvent<{ page: number; total: number; previous: number; reason: string }>)
          .detail,
      );
    });
    instance().next();
    instance().prev(new Event("click"));
    instance().next(new Event("focusin"));
    instance().prev(new Event("pointerenter"));
    expect(reports).toEqual([
      { page: 2, total: 2, previous: 1, reason: "api" },
      { page: 1, total: 2, previous: 2, reason: "user" },
      { page: 2, total: 2, previous: 1, reason: "focus" },
      { page: 1, total: 2, previous: 2, reason: "pointer" },
    ]);
  });

  it("rejects a nested origin even when the Event handler belongs to an owned outer target", () => {
    const nested = document.createElement("div");
    nested.setAttribute("data-controller", "stimeo--pagination");
    const child = document.createElement("span");
    child.setAttribute("data-stimeo--pagination-target", "page");
    nested.append(child);
    element("api-b").append(nested);
    const reports = vi.fn();
    element("api-root").addEventListener("stimeo--pagination:change", reports);
    const before = element("api-root").innerHTML;
    element("api-b").addEventListener("probe", (event) => instance().select(event));
    child.dispatchEvent(new Event("probe", { bubbles: true }));
    expect(element("api-root").innerHTML).toBe(before);
    expect(reports).not.toHaveBeenCalled();
    instance().select(element("api-b"));
    expect(reports).toHaveBeenCalledOnce();
  });
});
