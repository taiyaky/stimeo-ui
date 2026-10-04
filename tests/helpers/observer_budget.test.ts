import { afterEach, describe, expect, it } from "vitest";
import { createObserverBudget } from "./observer_budget";
import { flushMicrotasks } from "./timing";

/**
 * Pins both sides of the per-test delivery cap: observers that settle are left
 * alone and deliver every batch, and once a test's observers go over the cap each
 * further delivery is dropped and its observer cut — which ends a chain of
 * microtasks whether one observer keeps re-triggering itself or every turn makes
 * a fresh one — and the cut observers are reported once, by what they watched.
 */
describe("createObserverBudget", () => {
  let host: HTMLElement | null = null;

  afterEach(() => {
    host?.remove();
    host = null;
  });

  const mountHost = (): HTMLElement => {
    host = document.createElement("div");
    host.setAttribute("data-controller", "probe");
    document.body.append(host);
    return host;
  };

  const report = (batches: number, records: number) => [
    `a MutationObserver on <div data-controller="probe"> was cut after the test's observers ` +
      `delivered more than ${batches} batches or ${records} records`,
  ];

  it("delivers every batch while the test's observers stay under the cap", async () => {
    const budget = createObserverBudget(MutationObserver, { batches: 6, records: 100 });
    const target = mountHost();
    let batches = 0;
    const first = new budget.Observer(() => {
      batches += 1;
    });
    const second = new budget.Observer(() => {
      batches += 1;
    });
    first.observe(target, { childList: true });
    second.observe(target, { childList: true });
    for (let i = 0; i < 3; i += 1) {
      target.append(document.createElement("span"));
      await flushMicrotasks();
    }
    first.disconnect();
    second.disconnect();
    expect(batches).toBe(6);
    expect(budget.takeRunaways()).toEqual([]);
  });

  it("cuts an observer whose callback keeps re-triggering it, and reports it once", async () => {
    const budget = createObserverBudget(MutationObserver, { batches: 5, records: 100 });
    const target = mountHost();
    let batches = 0;
    const observer = new budget.Observer(() => {
      batches += 1;
      target.append(document.createElement("span"));
    });
    observer.observe(target, { childList: true });
    target.append(document.createElement("span"));
    for (let i = 0; i < 20; i += 1) await flushMicrotasks();
    const runaways = budget.takeRunaways();
    observer.disconnect();
    expect(batches).toBe(5);
    expect(runaways).toEqual(report(5, 100));
    expect(budget.takeRunaways()).toEqual([]);
  });

  it("cuts a loop that makes a fresh observer on every turn", async () => {
    const budget = createObserverBudget(MutationObserver, { batches: 5, records: 100 });
    const target = mountHost();
    let batches = 0;
    const observeOnce = (): void => {
      const observer = new budget.Observer(() => {
        batches += 1;
        observer.disconnect();
        observeOnce();
        target.append(document.createElement("span"));
      });
      observer.observe(target, { childList: true });
    };
    observeOnce();
    target.append(document.createElement("span"));
    for (let i = 0; i < 20; i += 1) await flushMicrotasks();
    expect(batches).toBe(5);
    expect(budget.takeRunaways()).toEqual(report(5, 100));
  });

  it("cuts a loop whose every record sets off two more before it reaches the batch cap", async () => {
    const budget = createObserverBudget(MutationObserver, { batches: 100, records: 60 });
    const target = mountHost();
    const sizes: number[] = [];
    const observer = new budget.Observer((records) => {
      sizes.push(records.length);
      for (let i = 0; i < records.length * 2; i += 1) {
        target.append(document.createElement("span"));
      }
    });
    observer.observe(target, { childList: true });
    target.append(document.createElement("span"));
    for (let i = 0; i < 20; i += 1) await flushMicrotasks();
    expect(sizes).toEqual([1, 2, 4, 8, 16]);
    expect(budget.takeRunaways()).toEqual(report(100, 60));
  });

  it("counts each test apart once reset", async () => {
    const budget = createObserverBudget(MutationObserver, { batches: 3, records: 100 });
    const target = mountHost();
    const observer = new budget.Observer(() => {});
    observer.observe(target, { childList: true });
    for (let round = 0; round < 3; round += 1) {
      budget.reset();
      for (let i = 0; i < 3; i += 1) {
        target.append(document.createElement("span"));
        await flushMicrotasks();
      }
    }
    observer.disconnect();
    expect(budget.takeRunaways()).toEqual([]);
  });
});
