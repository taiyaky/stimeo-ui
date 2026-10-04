import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { BulkSelectController } from "../src/controllers/bulk_select_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link BulkSelectController}: item/select-all linkage,
 * indeterminate state, bar visibility + count, clear, the change and reconcile
 * events, all-pages mode, delegation for dynamically-added rows, runtime target and
 * Value changes, Turbo-idempotent connect, the announcement hook, focus handling,
 * and teardown.
 */

describe("BulkSelectController", () => {
  let application: Application;

  const MARKUP = (attrs = "", rows = 3) => `
    <div data-controller="stimeo--bulk-select" ${attrs}>
      <input type="checkbox" data-stimeo--bulk-select-target="all">
      <ul data-list>
        ${Array.from({ length: rows })
          .map(() => `<li><input type="checkbox" data-stimeo--bulk-select-target="item"></li>`)
          .join("")}
      </ul>
      <div data-stimeo--bulk-select-target="bar" hidden role="toolbar">
        <span data-stimeo--bulk-select-target="count"></span>
        <button data-stimeo--bulk-select-target="selectAllPages"
                data-action="click->stimeo--bulk-select#selectAllPages">All pages</button>
        <button data-action="click->stimeo--bulk-select#clear">Clear</button>
      </div>
    </div>`;

  const start = async (markup: string, controller = BulkSelectController) => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--bulk-select", controller);
    await tick();
  };

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--bulk-select']");
  const all = () => query<HTMLInputElement>("[data-stimeo--bulk-select-target='all']");
  const items = () =>
    Array.from(
      document.querySelectorAll<HTMLInputElement>("[data-stimeo--bulk-select-target='item']"),
    );
  /** Definite row accessor (the lint bans `!`, and indexing is `| undefined`). */
  const itemAt = (index: number): HTMLInputElement => {
    const box = items()[index];
    if (!box) throw new Error(`No item at index ${index}`);
    return box;
  };
  const bar = () => query("[data-stimeo--bulk-select-target='bar']");
  const count = () => query("[data-stimeo--bulk-select-target='count']");

  /** Checks (or unchecks) a checkbox and fires a bubbling change, as a click would. */
  const setChecked = (box: HTMLInputElement, checked: boolean) => {
    box.checked = checked;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  };

  /** Records every event of `name` dispatched on the controller element. */
  const recordEvents = (name: "change" | "reconcile") => {
    const log: Array<{ count: number; allPages: boolean }> = [];
    root().addEventListener(`stimeo--bulk-select:${name}`, (event) => {
      log.push((event as CustomEvent<{ count: number; allPages: boolean }>).detail);
    });
    return log;
  };

  /** Collects the messages handed to the shared announcer while `run` executes. */
  const collectAnnouncements = async (run: () => void | Promise<void>): Promise<string[]> => {
    const messages: string[] = [];
    const onAnnounce = (event: Event) => {
      messages.push((event as CustomEvent<{ message: string }>).detail.message);
    };
    window.addEventListener("stimeo--announcer:announce", onAnnounce);
    await run();
    await tick();
    window.removeEventListener("stimeo--announcer:announce", onAnnounce);
    return messages;
  };

  it("hides the bar with nothing selected and reveals it on first selection", async () => {
    await start(MARKUP());
    expect(bar().hidden).toBe(true);
    setChecked(itemAt(0), true);
    expect(bar().hidden).toBe(false);
    expect(count().textContent).toBe("1");
  });

  it("reflects the selected count and hides the bar when cleared back to zero", async () => {
    await start(MARKUP());
    setChecked(itemAt(0), true);
    setChecked(itemAt(1), true);
    expect(count().textContent).toBe("2");
    setChecked(itemAt(0), false);
    setChecked(itemAt(1), false);
    expect(bar().hidden).toBe(true);
  });

  it("select-all checks every row and sets count to the total", async () => {
    await start(MARKUP());
    setChecked(all(), true);
    expect(items().every((i) => i.checked)).toBe(true);
    expect(count().textContent).toBe("3");
  });

  it("sets the select-all box indeterminate on a partial selection", async () => {
    await start(MARKUP());
    setChecked(itemAt(0), true);
    expect(all().indeterminate).toBe(true);
    expect(all().checked).toBe(false);
  });

  it("checks the select-all box (not indeterminate) when every row is selected", async () => {
    await start(MARKUP());
    for (const item of items()) setChecked(item, true);
    expect(all().indeterminate).toBe(false);
    expect(all().checked).toBe(true);
  });

  it("clear unchecks everything and hides the bar", async () => {
    await start(MARKUP());
    setChecked(all(), true);
    query<HTMLButtonElement>("[data-action*='clear']").click();
    expect(items().some((i) => i.checked)).toBe(false);
    expect(all().checked).toBe(false);
    expect(bar().hidden).toBe(true);
    expect(root().getAttribute("data-selected-count")).toBe("0");
  });

  it("dispatches change with count and allPages on each selection change", async () => {
    await start(MARKUP());
    const log = recordEvents("change");
    setChecked(itemAt(0), true);
    setChecked(itemAt(1), true);
    setChecked(itemAt(0), false);
    expect(log).toEqual([
      { count: 1, allPages: false },
      { count: 2, allPages: false },
      { count: 1, allPages: false },
    ]);
  });

  it("does not dispatch change when a recompute leaves the figures unmoved", async () => {
    await start(MARKUP());
    const log = recordEvents("change");
    setChecked(itemAt(0), true);
    // Re-checking an already checked row recomputes to the same count.
    setChecked(itemAt(0), true);
    setChecked(itemAt(0), true);
    expect(log).toEqual([{ count: 1, allPages: false }]);
  });

  it("enters all-pages mode showing the total count", async () => {
    await start(MARKUP(`data-stimeo--bulk-select-total-count-value="128"`));
    setChecked(all(), true);
    query<HTMLButtonElement>("[data-action*='selectAllPages']").click();
    expect(root().getAttribute("data-all-pages")).toBe("true");
    expect(count().textContent).toBe("128");
  });

  it("carries allPages true in the change detail while the mode is on", async () => {
    await start(MARKUP(`data-stimeo--bulk-select-total-count-value="128"`));
    setChecked(itemAt(0), true);
    const log = recordEvents("change");
    query<HTMLButtonElement>("[data-action*='selectAllPages']").click();
    expect(log).toEqual([{ count: 128, allPages: true }]);
  });

  it("checks every row on the page when the whole set is selected", async () => {
    // The mode claims the whole set, so a visible row left unchecked would put the
    // page and the count in open disagreement.
    await start(MARKUP(`data-stimeo--bulk-select-total-count-value="128"`));
    setChecked(itemAt(0), true);
    query<HTMLButtonElement>("[data-action*='selectAllPages']").click();

    expect(items().every((item) => item.checked)).toBe(true);
    expect(all().checked).toBe(true);
    expect(all().indeterminate).toBe(false);
  });

  it("keeps data-selected-count on the page's checked rows while in all-pages mode", async () => {
    await start(MARKUP(`data-stimeo--bulk-select-total-count-value="128"`));
    setChecked(itemAt(0), true);
    query<HTMLButtonElement>("[data-action*='selectAllPages']").click();
    // The bar shows the whole set; the hook stays the page's own figure.
    expect(count().textContent).toBe("128");
    expect(root().getAttribute("data-selected-count")).toBe("3");
  });

  it("checks a row that arrives while the whole set is selected", async () => {
    await start(MARKUP(`data-stimeo--bulk-select-total-count-value="128"`));
    setChecked(itemAt(0), true);
    query<HTMLButtonElement>("[data-action*='selectAllPages']").click();

    const list = query("[data-list]");
    const row = document.createElement("li");
    row.innerHTML = `<input type="checkbox" data-stimeo--bulk-select-target="item">`;
    list.append(row);
    await tick();

    expect(items()).toHaveLength(4);
    expect(items().every((item) => item.checked)).toBe(true);
    expect(root().getAttribute("data-all-pages")).toBe("true");
  });

  it("exits all-pages mode when a row is unchecked", async () => {
    await start(MARKUP(`data-stimeo--bulk-select-total-count-value="128"`));
    setChecked(itemAt(0), true);
    query<HTMLButtonElement>("[data-action*='selectAllPages']").click();
    expect(root().getAttribute("data-all-pages")).toBe("true");

    setChecked(itemAt(1), false);

    expect(root().getAttribute("data-all-pages")).toBe(null);
    expect(count().textContent).toBe("2");
  });

  it("exits all-pages mode when the select-all box is unchecked", async () => {
    await start(MARKUP(`data-stimeo--bulk-select-total-count-value="128"`));
    setChecked(itemAt(0), true);
    query<HTMLButtonElement>("[data-action*='selectAllPages']").click();
    expect(root().getAttribute("data-all-pages")).toBe("true");

    setChecked(all(), false);

    expect(root().getAttribute("data-all-pages")).toBe(null);
    expect(count().textContent).toBe("0");
    expect(bar().hidden).toBe(true);
  });

  it("exits all-pages mode when the selection is cleared", async () => {
    await start(MARKUP(`data-stimeo--bulk-select-total-count-value="128"`));
    setChecked(itemAt(0), true);
    query<HTMLButtonElement>("[data-action*='selectAllPages']").click();
    const log = recordEvents("change");

    query<HTMLButtonElement>("[data-action*='clear']").click();

    expect(root().getAttribute("data-all-pages")).toBe(null);
    expect(count().textContent).toBe("0");
    expect(bar().hidden).toBe(true);
    expect(log).toEqual([{ count: 0, allPages: false }]);
  });

  it("defaults totalCount to 0, so all-pages without a total shows nothing selected", async () => {
    await start(MARKUP());
    setChecked(itemAt(0), true);
    query<HTMLButtonElement>("[data-action*='selectAllPages']").click();
    expect(count().textContent).toBe("0");
  });

  it("counts a non-finite totalCount as the default without rewriting it", async () => {
    await start(MARKUP(`data-stimeo--bulk-select-total-count-value="abc"`));
    setChecked(itemAt(0), true);
    query<HTMLButtonElement>("[data-action*='selectAllPages']").click();
    expect(count().textContent).toBe("0");
    expect(root().getAttribute("data-stimeo--bulk-select-total-count-value")).toBe("abc");
  });

  it("repaints once for a non-finite totalCount written at runtime, writing nothing back", async () => {
    // The page's write delivers one callback and one repair; the attribute keeps
    // what the page wrote, and the count shows the default in its place.
    const deliveries: string[] = [];
    const Counting = class extends BulkSelectController {
      override totalCountValueChanged(): void {
        deliveries.push(String(this.totalCountValue));
        super.totalCountValueChanged();
      }
    };
    await start(MARKUP(`data-stimeo--bulk-select-total-count-value="128"`), Counting);
    setChecked(itemAt(0), true);
    query<HTMLButtonElement>("[data-action*='selectAllPages']").click();
    expect(count().textContent).toBe("128");
    const log = recordEvents("reconcile");
    const previousValues: Array<string | null> = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) previousValues.push(record.oldValue);
    });
    observer.observe(root(), {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["data-stimeo--bulk-select-total-count-value"],
    });
    deliveries.length = 0;

    root().setAttribute("data-stimeo--bulk-select-total-count-value", "abc");
    await tick();
    observer.disconnect();

    expect(count().textContent).toBe("0");
    expect(log).toEqual([{ count: 0, allPages: true }]);
    expect(deliveries).toEqual(["NaN"]);
    expect(previousValues).toEqual(["128"]);
    expect(root().getAttribute("data-stimeo--bulk-select-total-count-value")).toBe("abc");
  });

  it("handles dynamically-added rows via delegation", async () => {
    await start(MARKUP());
    const list = query("[data-list]");
    const li = document.createElement("li");
    li.innerHTML = `<input type="checkbox" data-stimeo--bulk-select-target="item">`;
    list.appendChild(li);
    const added = li.querySelector("input") as HTMLInputElement;
    // No per-row data-action was bound; the delegated container listener handles it.
    setChecked(added, true);
    expect(count().textContent).toBe("1");
    expect(root().getAttribute("data-selected-count")).toBe("1");
  });

  it("reconciles when a row arrives already checked", async () => {
    await start(MARKUP());
    const log = recordEvents("reconcile");
    const li = document.createElement("li");
    li.innerHTML = `<input type="checkbox" data-stimeo--bulk-select-target="item" checked>`;
    query("[data-list]").appendChild(li);
    await tick();
    expect(count().textContent).toBe("1");
    expect(root().getAttribute("data-selected-count")).toBe("1");
    expect(log).toEqual([{ count: 1, allPages: false }]);
  });

  it("reconciles when a selected row is removed from the DOM", async () => {
    await start(MARKUP());
    setChecked(itemAt(0), true);
    setChecked(itemAt(1), true);
    expect(count().textContent).toBe("2");
    const log = recordEvents("reconcile");
    itemAt(0).closest("li")?.remove();
    await tick();
    expect(count().textContent).toBe("1");
    expect(root().getAttribute("data-selected-count")).toBe("1");
    expect(log).toEqual([{ count: 1, allPages: false }]);
  });

  it("hides the bar when the last selected row is removed", async () => {
    await start(MARKUP());
    setChecked(itemAt(0), true);
    expect(bar().hidden).toBe(false);
    itemAt(0).closest("li")?.remove();
    await tick();
    expect(bar().hidden).toBe(true);
    expect(root().getAttribute("data-selected-count")).toBe("0");
  });

  it("coalesces a batch of row mutations into one reconcile", async () => {
    await start(MARKUP());
    setChecked(itemAt(0), true);
    setChecked(itemAt(1), true);
    setChecked(itemAt(2), true);
    const log = recordEvents("reconcile");
    const list = query("[data-list]");
    for (const li of Array.from(list.querySelectorAll("li")).slice(0, 2)) li.remove();
    await tick();
    expect(log).toEqual([{ count: 1, allPages: false }]);
  });

  it("repaints the count when totalCount changes at runtime in all-pages mode", async () => {
    await start(MARKUP(`data-stimeo--bulk-select-total-count-value="128"`));
    setChecked(itemAt(0), true);
    query<HTMLButtonElement>("[data-action*='selectAllPages']").click();
    expect(count().textContent).toBe("128");
    const log = recordEvents("reconcile");
    root().setAttribute("data-stimeo--bulk-select-total-count-value", "64");
    await tick();
    expect(count().textContent).toBe("64");
    expect(log).toEqual([{ count: 64, allPages: true }]);
  });

  it("reflects the selection onto a select-all box added at runtime", async () => {
    await start(`
      <div data-controller="stimeo--bulk-select">
        <input type="checkbox" data-stimeo--bulk-select-target="item">
        <input type="checkbox" data-stimeo--bulk-select-target="item">
      </div>`);
    setChecked(itemAt(0), true);
    setChecked(itemAt(1), true);

    const box = document.createElement("input");
    box.type = "checkbox";
    box.setAttribute("data-stimeo--bulk-select-target", "all");
    root().prepend(box);
    await tick();

    expect(box.checked).toBe(true);
    expect(box.indeterminate).toBe(false);
  });

  it("hands the selection to the next select-all box when the first one leaves", async () => {
    // A table can repeat the box in its header and footer; the one left behind
    // reflects the selection once the other leaves.
    await start(`
      <div data-controller="stimeo--bulk-select">
        <input id="head" type="checkbox" data-stimeo--bulk-select-target="all">
        <input type="checkbox" data-stimeo--bulk-select-target="item">
        <input type="checkbox" data-stimeo--bulk-select-target="item">
        <input id="foot" type="checkbox" data-stimeo--bulk-select-target="all">
      </div>`);
    setChecked(itemAt(0), true);
    const foot = query<HTMLInputElement>("#foot");

    query("#head").remove();
    await tick();

    expect(foot.indeterminate).toBe(true);
    expect(foot.checked).toBe(false);
  });

  it("repairs the figures when the announcement wording changes at runtime", async () => {
    // A row written without a change event is picked up by the repair the new
    // wording schedules, and announced in that wording.
    await start(MARKUP(`data-stimeo--bulk-select-announce-text-value="{count} selected"`));
    const log = recordEvents("reconcile");
    const messages = await collectAnnouncements(async () => {
      itemAt(0).checked = true;
      root().setAttribute("data-stimeo--bulk-select-announce-text-value", "{count} chosen");
      await tick();
    });

    expect(count().textContent).toBe("1");
    expect(log).toEqual([{ count: 1, allPages: false }]);
    expect(messages).toEqual(["1 chosen"]);
  });

  it("does not count rows owned by a nested bulk-select", async () => {
    await start(`
      <div id="outer" data-controller="stimeo--bulk-select">
        <input type="checkbox" data-stimeo--bulk-select-target="item">
        <div id="inner" data-controller="stimeo--bulk-select">
          <input type="checkbox" data-stimeo--bulk-select-target="item">
          <input type="checkbox" data-stimeo--bulk-select-target="item">
        </div>
      </div>`);
    const inner = query("#inner");
    const innerBox = inner.querySelector("input") as HTMLInputElement;
    setChecked(innerBox, true);
    await tick();
    expect(query("#outer").getAttribute("data-selected-count")).toBe("0");
    expect(inner.getAttribute("data-selected-count")).toBe("1");
  });

  it("recomputes idempotently from pre-checked rows on connect (Turbo swap)", async () => {
    await start(`
      <div data-controller="stimeo--bulk-select">
        <input type="checkbox" data-stimeo--bulk-select-target="all">
        <input type="checkbox" data-stimeo--bulk-select-target="item" checked>
        <input type="checkbox" data-stimeo--bulk-select-target="item" checked>
        <input type="checkbox" data-stimeo--bulk-select-target="item">
        <div data-stimeo--bulk-select-target="bar" hidden role="toolbar">
          <span data-stimeo--bulk-select-target="count"></span>
        </div>
      </div>`);
    expect(bar().hidden).toBe(false);
    expect(count().textContent).toBe("2");
    expect(all().indeterminate).toBe(true);
  });

  it("rehydrates all-pages mode from data-all-pages on connect", async () => {
    await start(MARKUP(`data-all-pages="true" data-stimeo--bulk-select-total-count-value="99"`));
    expect(bar().hidden).toBe(false);
    expect(count().textContent).toBe("99");
    expect(root().getAttribute("data-all-pages")).toBe("true");
  });

  it("reports nothing on connect, so a Turbo restore does not replay a selection", async () => {
    document.body.innerHTML = MARKUP(
      `data-stimeo--bulk-select-announce-text-value="{count} selected"`,
    );
    const el = query("[data-controller='stimeo--bulk-select']");
    const changes: unknown[] = [];
    const reconciles: unknown[] = [];
    el.addEventListener("stimeo--bulk-select:change", (e) =>
      changes.push((e as CustomEvent).detail),
    );
    el.addEventListener("stimeo--bulk-select:reconcile", (e) =>
      reconciles.push((e as CustomEvent).detail),
    );
    const messages = await collectAnnouncements(async () => {
      application = Application.start();
      application.register("stimeo--bulk-select", BulkSelectController);
      await tick();
    });
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([]);
    expect(messages).toEqual([]);
  });

  it("announces the count through the shared announcer, worded by the consumer", async () => {
    await start(MARKUP(`data-stimeo--bulk-select-announce-text-value="{count} selected"`));
    const messages = await collectAnnouncements(() => {
      setChecked(itemAt(0), true);
      setChecked(itemAt(1), true);
    });
    expect(messages).toEqual(["1 selected", "2 selected"]);
  });

  it("stays silent when no announcement wording is authored", async () => {
    await start(MARKUP());
    const messages = await collectAnnouncements(() => {
      setChecked(itemAt(0), true);
    });
    expect(messages).toEqual([]);
  });

  it("announces a repair the controller decided, not just user changes", async () => {
    await start(MARKUP(`data-stimeo--bulk-select-announce-text-value="{count} selected"`));
    setChecked(itemAt(0), true);
    setChecked(itemAt(1), true);
    const messages = await collectAnnouncements(async () => {
      itemAt(0).closest("li")?.remove();
      await tick();
    });
    expect(messages).toEqual(["1 selected"]);
  });

  it("does not move focus when the bar appears", async () => {
    await start(MARKUP());
    const box = itemAt(0);
    box.focus();
    setChecked(box, true);
    expect(document.activeElement).toBe(box);
  });

  it("hands focus to the select-all box when the bar it holds is hidden", async () => {
    await start(MARKUP());
    setChecked(itemAt(0), true);
    const clearButton = query<HTMLButtonElement>("[data-action*='clear']");
    clearButton.focus();
    expect(document.activeElement).toBe(clearButton);
    clearButton.click();
    expect(bar().hidden).toBe(true);
    expect(document.activeElement).toBe(all());
    expect(bar().contains(document.activeElement)).toBe(false);
  });

  it("leaves focus alone when the bar is hidden without holding it", async () => {
    await start(MARKUP());
    const box = itemAt(0);
    setChecked(box, true);
    box.focus();
    setChecked(box, false);
    expect(bar().hidden).toBe(true);
    expect(document.activeElement).toBe(box);
  });

  it("stops handling changes after disconnect", async () => {
    await start(MARKUP());
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--bulk-select",
    ) as BulkSelectController;
    controller.disconnect();
    setChecked(itemAt(0), true);
    expect(bar().hidden).toBe(true);
  });

  it("drops a repair queued before disconnect", async () => {
    await start(MARKUP());
    setChecked(itemAt(0), true);
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--bulk-select",
    ) as BulkSelectController;
    const log = recordEvents("reconcile");
    itemAt(0).closest("li")?.remove();
    controller.disconnect();
    await tick();
    expect(log).toEqual([]);
  });

  it("degrades gracefully with only item checkboxes (no all/bar/count targets)", async () => {
    await start(`
      <div data-controller="stimeo--bulk-select">
        <input type="checkbox" data-stimeo--bulk-select-target="item">
        <input type="checkbox" data-stimeo--bulk-select-target="item">
      </div>`);
    setChecked(itemAt(0), true);
    // No throw despite the missing optional targets; the count hook still updates.
    expect(root().getAttribute("data-selected-count")).toBe("1");
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(`
      <main>
        <div data-controller="stimeo--bulk-select">
          <label><input type="checkbox" data-stimeo--bulk-select-target="all"> Select all</label>
          <label><input type="checkbox" data-stimeo--bulk-select-target="item"> Row 1</label>
          <label><input type="checkbox" data-stimeo--bulk-select-target="item"> Row 2</label>
          <div data-stimeo--bulk-select-target="bar" hidden role="toolbar" aria-label="Bulk actions">
            <span data-stimeo--bulk-select-target="count"></span> selected
            <button data-action="click->stimeo--bulk-select#clear">Clear</button>
          </div>
        </div>
      </main>`);
    await expectNoA11yViolations(document.body);
  });

  // The revealed bar must read as a toolbar carrying the count: freeze the role,
  // its name, and the count in spoken order.
  it("exposes the revealed bar as a named toolbar carrying the count", async () => {
    await start(MARKUP());
    setChecked(itemAt(0), true);
    setChecked(itemAt(1), true);
    expect(count().textContent).toBe("2");
    expect(await captureSpeech({ container: bar(), steps: 1 })).toEqual([
      "toolbar, orientated horizontally",
      "2",
    ]);
  });

  it("includes an unreported row write in the user's published selection count", async () => {
    await start(MARKUP());
    const changes = recordEvents("change");
    const repairs = recordEvents("reconcile");
    itemAt(0).checked = true;
    setChecked(itemAt(1), true);
    await tick();
    expect(changes).toEqual([{ count: 2, allPages: false }]);
    expect(repairs).toEqual([]);
  });

  it("does not report a clear that returns pending row writes to the last published count", async () => {
    await start(MARKUP());
    const changes = recordEvents("change");
    const repairs = recordEvents("reconcile");
    itemAt(0).checked = true;
    query<HTMLButtonElement>('[data-action="click->stimeo--bulk-select#clear"]').click();
    await tick();
    expect(count().textContent).toBe("0");
    expect(changes).toEqual([]);
    expect(repairs).toEqual([]);
  });

  describe("bar and count that arrive or stay", () => {
    /** A bar like the current one, still reading as hidden with a stale count. */
    const staleBar = () => {
      const fresh = bar().cloneNode(true) as HTMLElement;
      fresh.hidden = true;
      const figure = fresh.querySelector<HTMLElement>("[data-stimeo--bulk-select-target='count']");
      if (figure) figure.textContent = "0";
      return fresh;
    };
    /** A count like the current one, showing a stale figure. */
    const staleCount = (figure = "9") => {
      const fresh = count().cloneNode(true) as HTMLElement;
      fresh.textContent = figure;
      return fresh;
    };

    it("reveals a bar that replaces the current one while rows are selected", async () => {
      await start(MARKUP());
      setChecked(itemAt(0), true);
      setChecked(itemAt(1), true);
      const successor = staleBar();

      bar().replaceWith(successor);
      await tick();

      expect(bar()).toBe(successor);
      expect(successor.hidden).toBe(false);
      expect(count().textContent).toBe("2");
    });

    it("reveals a bar that stays after an earlier one leaves once a row is selected", async () => {
      await start(MARKUP());
      const original = bar();
      const successor = staleBar();
      original.after(successor);
      await tick();
      setChecked(itemAt(0), true);
      original.remove();
      await tick();

      expect(bar()).toBe(successor);
      expect(successor.hidden).toBe(false);
    });

    it("hides a bar that stays after an earlier one leaves once the selection clears", async () => {
      await start(MARKUP());
      setChecked(itemAt(0), true);
      const original = bar();
      const successor = original.cloneNode(true) as HTMLElement;
      original.after(successor);
      await tick();
      setChecked(itemAt(0), false);
      original.remove();
      await tick();

      expect(bar()).toBe(successor);
      expect(successor.hidden).toBe(true);
    });

    it("writes the selected count into a count that replaces the current one", async () => {
      await start(MARKUP());
      setChecked(itemAt(0), true);
      setChecked(itemAt(2), true);
      const successor = staleCount();

      count().replaceWith(successor);
      await tick();

      expect(count()).toBe(successor);
      expect(successor.textContent).toBe("2");
    });

    it("writes the selected count into a count that stays after an earlier one leaves", async () => {
      await start(MARKUP());
      setChecked(itemAt(0), true);
      const original = count();
      const successor = staleCount("1");
      original.after(successor);
      await tick();
      setChecked(itemAt(1), true);
      original.remove();
      await tick();

      expect(count()).toBe(successor);
      expect(successor.textContent).toBe("2");
    });

    it("brings a bar and its count up to date without an event or an announcement", async () => {
      await start(MARKUP('data-stimeo--bulk-select-announce-text-value="{count} selected"'));
      setChecked(itemAt(0), true);
      const changes = recordEvents("change");
      const repairs = recordEvents("reconcile");
      const native: Event[] = [];
      root().addEventListener("change", (event) => native.push(event));
      const successor = staleBar();

      const spoken = await collectAnnouncements(async () => {
        bar().replaceWith(successor);
        await tick();
      });

      expect(successor.hidden).toBe(false);
      expect(count().textContent).toBe("1");
      expect(changes).toEqual([]);
      expect(repairs).toEqual([]);
      expect(native).toEqual([]);
      expect(spoken).toEqual([]);
    });

    it("keeps working when its only bar leaves", async () => {
      await start(MARKUP());
      const errors: unknown[] = [];
      application.handleError = (error) => {
        errors.push(error);
      };
      bar().remove();
      await tick();
      setChecked(itemAt(0), true);
      await tick();

      expect(errors).toEqual([]);
      expect(root().getAttribute("data-selected-count")).toBe("1");
    });

    it("keeps working when its only count leaves", async () => {
      await start(MARKUP());
      const errors: unknown[] = [];
      application.handleError = (error) => {
        errors.push(error);
      };
      count().remove();
      await tick();
      setChecked(itemAt(0), true);
      await tick();

      expect(errors).toEqual([]);
      expect(bar().hidden).toBe(false);
    });

    it("reveals a bar that arrives after the only one left", async () => {
      await start(MARKUP());
      setChecked(itemAt(0), true);
      const template = staleBar();
      bar().remove();
      await tick();

      root().append(template);
      await tick();

      expect(template.hidden).toBe(false);
      expect(count().textContent).toBe("1");
    });

    describe("with the count outside the bar", () => {
      /** The bar holds no count, so only the bar's own callbacks answer its moves. */
      const SPLIT = `
        <div data-controller="stimeo--bulk-select">
          <input type="checkbox" data-stimeo--bulk-select-target="item">
          <input type="checkbox" data-stimeo--bulk-select-target="item">
          <span data-stimeo--bulk-select-target="count"></span>
          <div data-stimeo--bulk-select-target="bar" hidden role="toolbar" aria-label="Bulk actions">
            <button type="button">Delete</button>
          </div>
        </div>`;

      it("reveals a bar that stays after an earlier one leaves", async () => {
        await start(SPLIT);
        const original = bar();
        const successor = original.cloneNode(true) as HTMLElement;
        original.after(successor);
        await tick();
        setChecked(itemAt(0), true);
        expect(original.hidden).toBe(false);
        original.remove();
        await tick();

        expect(bar()).toBe(successor);
        expect(successor.hidden).toBe(false);
      });

      it("reveals a bar that arrives after the only one left", async () => {
        await start(SPLIT);
        setChecked(itemAt(0), true);
        const template = bar().cloneNode(true) as HTMLElement;
        template.hidden = true;
        bar().remove();
        await tick();

        root().append(template);
        await tick();

        expect(template.hidden).toBe(false);
      });
    });

    it("writes the count into a count that arrives after the only one left", async () => {
      await start(MARKUP());
      setChecked(itemAt(0), true);
      setChecked(itemAt(1), true);
      const template = staleCount();
      count().remove();
      await tick();

      bar().prepend(template);
      await tick();

      expect(template.textContent).toBe("2");
    });

    it("gives a bar that stops being one back the hidden it was authored with", async () => {
      await start(MARKUP());
      setChecked(itemAt(0), true);
      const departed = bar();
      expect(departed.hidden).toBe(false);

      departed.removeAttribute("data-stimeo--bulk-select-target");
      await tick();

      expect(departed.hidden).toBe(true);
    });

    it("removes the hidden it wrote on a departed bar that was authored without one", async () => {
      await start(MARKUP().replace('target="bar" hidden', 'target="bar"'));
      const departed = bar();
      expect(departed.hidden).toBe(true);

      departed.removeAttribute("data-stimeo--bulk-select-target");
      await tick();

      expect(departed.hasAttribute("hidden")).toBe(false);
    });

    it("keeps a hidden the page wrote on the bar after the last write", async () => {
      await start(MARKUP());
      setChecked(itemAt(0), true);
      const departed = bar();
      departed.hidden = true;

      departed.removeAttribute("data-stimeo--bulk-select-target");
      await tick();

      expect(departed.hidden).toBe(true);
      departed.hidden = false;
      setChecked(itemAt(1), true);
      await tick();
      expect(departed.hidden).toBe(false);
    });

    it("gives the bar back its own hidden when the widget loses its controller", async () => {
      await start(MARKUP());
      setChecked(itemAt(0), true);
      const departed = bar();

      root().removeAttribute("data-controller");
      await tick();

      expect(departed.hidden).toBe(true);
    });

    it("keeps a bar that moves within the widget shown without touching it", async () => {
      await start(MARKUP());
      setChecked(itemAt(0), true);
      const moving = bar();
      const writes: string[] = [];
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.attributeName === "hidden") writes.push(String(record.oldValue));
        }
      }).observe(moving, { attributes: true, attributeOldValue: true });

      root().prepend(moving);
      await tick();

      expect(bar()).toBe(moving);
      expect(moving.hidden).toBe(false);
      expect(writes).toEqual([]);
    });

    it("keeps what it wrote on the bar when the whole widget leaves the page", async () => {
      await start(MARKUP());
      setChecked(itemAt(0), true);
      const kept = bar();

      root().remove();
      await tick();

      expect(kept.hidden).toBe(false);
    });

    it("writes nothing onto the bar or the count while Stimulus tears the controller down", async () => {
      await start(MARKUP());
      setChecked(itemAt(0), true);
      // Values the page wrote after the last write stay where they were left.
      bar().hidden = true;
      count().textContent = "7";

      application.unload("stimeo--bulk-select");
      await tick();

      expect(bar().hidden).toBe(true);
      expect(count().textContent).toBe("7");
    });
  });
});
