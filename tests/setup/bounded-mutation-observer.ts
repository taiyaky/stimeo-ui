import { afterAll, afterEach, beforeEach } from "vitest";
import { createObserverBudget, OBSERVER_LIMITS } from "../helpers/observer_budget";

/**
 * Caps what every MutationObserver the suite creates — the controllers',
 * Stimulus's and the tests' own — may deliver in one test, at
 * {@link OBSERVER_LIMITS} in all.
 *
 * A callback that keeps re-triggering an observer would otherwise hold the test's
 * worker in microtasks, where no test timeout can fire. Past the cap each delivery
 * cuts its observer instead, and the test that set the loop off fails here,
 * naming what the cut observers watched.
 */
const budget = createObserverBudget(globalThis.MutationObserver, OBSERVER_LIMITS);
globalThis.MutationObserver = budget.Observer;

/** The environment's own `setTimeout`, taken before any test can fake timers. */
const realSetTimeout = globalThis.setTimeout;

/** Fails the hook it runs in when the cap cut an observer since the last check. */
const failOnRunaways = (): void => {
  const runaways = budget.takeRunaways();
  if (runaways.length > 0) {
    throw new Error(`${runaways.join("\n")}: its callback keeps re-triggering it.`);
  }
};

// An observer cut outside a test — in a file's `beforeAll`, or between two tests —
// fails the next test, before the count restarts; one cut after the last test fails
// the file.
beforeEach(() => {
  try {
    failOnRunaways();
  } finally {
    budget.reset();
  }
});

afterEach(failOnRunaways);

// A loop set off in a synchronous `afterEach` or `afterAll` is still delivering, in
// microtasks, when those hooks return. Waiting for one macrotask lets it run to the cap,
// since no macrotask starts before the microtasks drain.
afterAll(async () => {
  await new Promise((resolve) => realSetTimeout(resolve, 0));
  failOnRunaways();
});
