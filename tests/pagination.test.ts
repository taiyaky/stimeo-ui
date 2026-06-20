import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { PaginationController } from "../src/controllers/pagination_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link PaginationController}: current-page state,
 * `aria-current` sync, boundary disabling of prev/next (without stranding
 * focus), and the `change` event.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const markup = (page = 1, total = 3) => `
  <nav data-controller="stimeo--pagination" aria-label="Pagination"
       data-stimeo--pagination-page-value="${page}"
       data-stimeo--pagination-total-value="${total}">
    <button type="button" data-stimeo--pagination-target="prev"
            data-action="stimeo--pagination#prev">Prev</button>
    <button type="button" data-page="1" data-stimeo--pagination-target="page"
            data-action="stimeo--pagination#select">1</button>
    <button type="button" data-page="2" data-stimeo--pagination-target="page"
            data-action="stimeo--pagination#select">2</button>
    <button type="button" data-page="3" data-stimeo--pagination-target="page"
            data-action="stimeo--pagination#select">3</button>
    <button type="button" data-stimeo--pagination-target="next"
            data-action="stimeo--pagination#next">Next</button>
  </nav>`;

describe("PaginationController", () => {
  let application: Application;

  const start = async (page = 1, total = 3) => {
    document.body.innerHTML = markup(page, total);
    application = Application.start();
    application.register("stimeo--pagination", PaginationController);
    await tick();
  };

  afterEach(() => {
    application.stop();
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

  it("does not step past the boundaries", async () => {
    await start(1, 3);
    prev().click(); // already first
    expect(current()).toEqual(["page", null, null]);
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

  it("keeps focus in the landmark when a lone boundary button disables (no page buttons)", async () => {
    // Degenerate config: only a Next button, no prev and no page buttons. When it
    // disables at the last page there is no opposite/current button to receive
    // focus, so focus must land on the (now focusable) landmark, not <body>.
    document.body.innerHTML = `
      <nav data-controller="stimeo--pagination" aria-label="Pagination"
           data-stimeo--pagination-page-value="1"
           data-stimeo--pagination-total-value="2">
        <button type="button" data-stimeo--pagination-target="next"
                data-action="stimeo--pagination#next">Next</button>
      </nav>`;
    application = Application.start();
    application.register("stimeo--pagination", PaginationController);
    await tick();

    next().focus();
    next().click(); // -> page 2 (last), next becomes disabled
    expect(next().disabled).toBe(true);
    expect(document.activeElement).not.toBe(next());
    expect(document.activeElement).toBe(root());
    expect(root().getAttribute("tabindex")).toBe("-1");
  });

  it("dispatches change with page, total, and previous", async () => {
    await start(1, 3);
    const details: Array<{ page: number; total: number; previous: number }> = [];
    root().addEventListener("stimeo--pagination:change", (event) => {
      details.push((event as CustomEvent).detail);
    });
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
    const details: unknown[] = [];
    root().addEventListener("stimeo--pagination:change", (event) =>
      details.push((event as CustomEvent).detail),
    );
    pages()[1]?.click(); // page 2 is already current
    expect(details).toEqual([]);
    expect(current()).toEqual([null, "page", null]);
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
});
