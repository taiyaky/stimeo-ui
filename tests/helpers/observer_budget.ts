/**
 * How much all MutationObservers together may deliver during one test: batches,
 * and the records in them. The busiest tests in the suite deliver a few hundred
 * batches and under ten thousand records; a callback that keeps re-triggering an
 * observer passes either cap within seconds — one or two records at a time, or
 * twice as many records on every turn — so both sit far above every real test
 * rather than just above one.
 */
export const OBSERVER_LIMITS = { batches: 10_000, records: 100_000 } as const;

/** The two caps {@link createObserverBudget} applies to one test. */
export interface ObserverLimits {
  readonly batches: number;
  readonly records: number;
}

/** A MutationObserver class whose deliveries are counted per test. */
export interface ObserverBudget {
  /** The class to install in place of the environment's `MutationObserver`. */
  readonly Observer: typeof MutationObserver;
  /** Starts a new test: the count restarts from zero. */
  reset(): void;
  /**
   * Describes the observers cut since the last call — none unless the test went
   * over the cap — and forgets them.
   */
  takeRunaways(): string[];
}

/** Names what an observer watched, for the report of a cut one. */
function describeTarget(target: Node | null): string {
  if (target === null) return "an unobserved target";
  if (!(target instanceof Element)) return target.nodeName.toLowerCase();
  const controller = target.getAttribute("data-controller");
  return controller === null
    ? `<${target.localName}>`
    : `<${target.localName} data-controller="${controller}">`;
}

/**
 * Wraps `Base` so that, once the observers of one test have delivered more
 * batches or more records in all than `limits` allows, every further delivery
 * disconnects its observer instead of reaching the callback, and the observer is
 * reported.
 *
 * A callback that writes what an observer watches queues another delivery, and
 * deliveries run as microtasks, so the chain never yields: timers never fire
 * again, the test timeout included, and the test holds its worker until
 * something outside stops it. The count is shared by every observer because such
 * a loop may create a fresh observer on each turn — a controller that reconnects
 * builds its observers anew — so no single observer need deliver more than once.
 * Records are counted besides batches because a loop in which each record sets
 * off two more doubles its work on every batch, and runs out of memory long
 * before it has delivered many batches. Disconnecting drops the queued delivery
 * and ends the chain, and the test runs on to its teardown, which fails it on the
 * report.
 */
export function createObserverBudget(
  Base: typeof MutationObserver,
  limits: ObserverLimits,
): ObserverBudget {
  let batches = 0;
  let records = 0;
  const runaways = new Set<string>();

  class BudgetedMutationObserver extends Base {
    #target: Node | null = null;

    constructor(callback: MutationCallback) {
      super((delivered, observer) => {
        batches += 1;
        records += delivered.length;
        if (batches <= limits.batches && records <= limits.records) {
          callback(delivered, observer);
          return;
        }
        observer.disconnect();
        runaways.add(describeTarget(this.#target));
      });
    }

    override observe(target: Node, options?: MutationObserverInit): void {
      this.#target ??= target;
      super.observe(target, options);
    }
  }

  return {
    Observer: BudgetedMutationObserver,
    reset() {
      batches = 0;
      records = 0;
      runaways.clear();
    },
    takeRunaways() {
      const cut = [...runaways].map(
        (target) =>
          `a MutationObserver on ${target} was cut after the test's observers delivered ` +
          `more than ${limits.batches} batches or ${limits.records} records`,
      );
      runaways.clear();
      return cut;
    },
  };
}
