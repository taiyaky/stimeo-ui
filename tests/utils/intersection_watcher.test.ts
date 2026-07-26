import { afterEach, describe, expect, it, vi } from "vitest";
import { IntersectionWatcher, isBeforeRootStart } from "../../src/utils/intersection_watcher";

/**
 * Contract tests for {@link IntersectionWatcher}: support detection, root
 * resolution, restart/re-arm behavior, stale callback isolation, and
 * exception-safe observer ownership.
 */

interface ObserverRecord {
  callback: (entries: IntersectionObserverEntry[]) => void;
  options: IntersectionObserverInit | undefined;
  observed: Element[];
  unobserved: Element[];
  disconnectCount: number;
}

const entryFor = (target: Element): IntersectionObserverEntry => ({
  boundingClientRect: new DOMRect(),
  intersectionRatio: 1,
  intersectionRect: new DOMRect(),
  isIntersecting: true,
  rootBounds: new DOMRect(),
  target,
  time: 0,
});

const installObserver = ({
  constructorError,
  constructorErrorAt,
  observeErrorAt,
}: {
  constructorError?: Error;
  /** 1-based construction that fails; omitted = every construction fails. */
  constructorErrorAt?: number;
  observeErrorAt?: number;
} = {}): ObserverRecord[] => {
  const records: ObserverRecord[] = [];
  let constructions = 0;

  class IntersectionObserverMock {
    readonly #record: ObserverRecord;
    #observeCount = 0;

    constructor(
      callback: (entries: IntersectionObserverEntry[]) => void,
      options?: IntersectionObserverInit,
    ) {
      constructions += 1;
      if (
        constructorError &&
        (constructorErrorAt === undefined || constructions === constructorErrorAt)
      ) {
        throw constructorError;
      }
      this.#record = {
        callback,
        options,
        observed: [],
        unobserved: [],
        disconnectCount: 0,
      };
      records.push(this.#record);
    }

    observe(target: Element): void {
      this.#observeCount += 1;
      if (this.#observeCount === observeErrorAt) throw new Error("observe failed");
      this.#record.observed.push(target);
    }

    unobserve(target: Element): void {
      this.#record.unobserved.push(target);
    }

    disconnect(): void {
      this.#record.disconnectCount += 1;
    }
  }

  vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
  return records;
};

describe("IntersectionWatcher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("stays inert without platform support or observation targets", () => {
    const target = document.createElement("div");
    vi.stubGlobal("IntersectionObserver", undefined);
    const unsupported = new IntersectionWatcher(() => {});
    expect(unsupported.start(target)).toBe(false);
    expect(unsupported.active).toBe(false);

    const records = installObserver();
    const empty = new IntersectionWatcher(() => {});
    expect(empty.start([])).toBe(false);
    expect(empty.active).toBe(false);
    expect(records).toHaveLength(0);
  });

  it("resolves a selector root and forwards options while observing every target", () => {
    const records = installObserver();
    document.body.innerHTML = `<div id="root"></div>`;
    const first = document.createElement("div");
    const second = document.createElement("div");
    const watcher = new IntersectionWatcher(() => {});

    expect(
      watcher.start([first, second], {
        rootSelector: "#root",
        rootMargin: "10px",
        threshold: [0, 0.5],
      }),
    ).toBe(true);

    expect(records[0]?.observed).toEqual([first, second]);
    expect(records[0]?.options).toEqual({
      root: document.querySelector("#root"),
      rootMargin: "10px",
      threshold: [0, 0.5],
    });
    expect(watcher.active).toBe(true);
  });

  it("honors an explicit viewport root instead of resolving rootSelector", () => {
    const records = installObserver();
    document.body.innerHTML = `<div id="root"></div>`;
    const target = document.createElement("div");
    const watcher = new IntersectionWatcher(() => {});

    watcher.start(target, { root: null, rootSelector: "#root" });

    expect(records[0]?.options?.root).toBeNull();
  });

  it("disconnects the previous observer and rejects its queued batch on restart", () => {
    const records = installObserver();
    const first = document.createElement("div");
    const second = document.createElement("div");
    const received: Element[] = [];
    const watcher = new IntersectionWatcher((entries) => {
      received.push(...entries.map((entry) => entry.target));
    });

    watcher.start(first);
    watcher.start(second);
    records[0]?.callback([entryFor(first)]);
    records[1]?.callback([entryFor(second)]);

    expect(records[0]?.disconnectCount).toBe(1);
    expect(records[1]?.observed).toEqual([second]);
    expect(received).toEqual([second]);
  });

  it("rearms a live target by unobserving and observing it again", () => {
    const records = installObserver();
    const target = document.createElement("div");
    const watcher = new IntersectionWatcher(() => {});
    watcher.start(target);

    watcher.rearm(target);

    expect(records[0]?.unobserved).toEqual([target]);
    expect(records[0]?.observed).toEqual([target, target]);
  });

  it("ignores a callback delivered after stop", () => {
    const records = installObserver();
    const target = document.createElement("div");
    const onEntries = vi.fn();
    const watcher = new IntersectionWatcher(onEntries);
    watcher.start(target);

    watcher.stop();
    records[0]?.callback([entryFor(target)]);

    expect(records[0]?.disconnectCount).toBe(1);
    expect(watcher.active).toBe(false);
    expect(onEntries).not.toHaveBeenCalled();
  });

  it("remains inactive and rethrows an observer constructor failure", () => {
    const failure = new Error("constructor failed");
    installObserver({ constructorError: failure });
    const watcher = new IntersectionWatcher(() => {});

    expect(() => watcher.start(document.createElement("div"))).toThrow(failure);
    expect(watcher.active).toBe(false);
  });

  it("disconnects partial observation and rethrows an observe failure", () => {
    const records = installObserver({ observeErrorAt: 2 });
    const first = document.createElement("div");
    const second = document.createElement("div");
    const onEntries = vi.fn();
    const watcher = new IntersectionWatcher(onEntries);

    expect(() => watcher.start([first, second])).toThrow("observe failed");
    records[0]?.callback([entryFor(first)]);

    expect(records[0]?.observed).toEqual([first]);
    expect(records[0]?.disconnectCount).toBe(1);
    expect(watcher.active).toBe(false);
    expect(onEntries).not.toHaveBeenCalled();
  });

  it("releases the live observer when a restart fails to construct", () => {
    const records = installObserver({
      constructorError: new Error("constructor failed"),
      constructorErrorAt: 2,
    });
    const first = document.createElement("div");
    const second = document.createElement("div");
    const onEntries = vi.fn();
    const watcher = new IntersectionWatcher(onEntries);
    watcher.start(first);

    expect(() => watcher.start(second)).toThrow("constructor failed");

    // The observer that was live before the failed restart is released exactly
    // once and can no longer reach the consumer: a watcher that deferred its
    // cleanup to the catch block would leak the old observation instead.
    expect(records).toHaveLength(1);
    expect(records[0]?.disconnectCount).toBe(1);
    expect(watcher.active).toBe(false);
    records[0]?.callback([entryFor(first)]);
    expect(onEntries).not.toHaveBeenCalled();
  });

  it("ignores a rearm requested before start or after stop", () => {
    // A controller can re-arm from a callback that outlives its own teardown, so
    // an un-owned rearm must be a no-op rather than a throw on a null observer.
    const records = installObserver();
    const target = document.createElement("div");
    const watcher = new IntersectionWatcher(() => {});

    expect(() => watcher.rearm(target)).not.toThrow();
    expect(records).toHaveLength(0);

    watcher.start(target);
    watcher.stop();
    expect(() => watcher.rearm(target)).not.toThrow();
    expect(records[0]?.observed).toEqual([target]); // stop left it un-rearmed
  });

  it("stops the watcher if rearm observation fails", () => {
    const records = installObserver({ observeErrorAt: 2 });
    const target = document.createElement("div");
    const watcher = new IntersectionWatcher(() => {});
    watcher.start(target);

    expect(() => watcher.rearm(target)).toThrow("observe failed");

    expect(records[0]?.unobserved).toEqual([target]);
    expect(records[0]?.disconnectCount).toBe(1);
    expect(watcher.active).toBe(false);
  });
});

describe("isBeforeRootStart", () => {
  const entry = ({
    rect,
    rootTop,
  }: {
    rect: DOMRect;
    rootTop: number | null;
  }): IntersectionObserverEntry => ({
    boundingClientRect: rect,
    intersectionRatio: 0,
    intersectionRect: new DOMRect(),
    isIntersecting: false,
    rootBounds: rootTop === null ? null : new DOMRect(0, rootTop, 100, 100),
    target: document.createElement("div"),
    time: 0,
  });

  it("is true only once a rendered target has cleared the root's top edge", () => {
    // Fully above the edge (bottom 18 < 40), exactly on it (bottom 40 — the
    // equality boundary the sticky transition rides on), and still below it.
    expect(isBeforeRootStart(entry({ rect: new DOMRect(0, 8, 10, 10), rootTop: 40 }))).toBe(true);
    expect(isBeforeRootStart(entry({ rect: new DOMRect(0, 30, 10, 10), rootTop: 40 }))).toBe(true);
    expect(isBeforeRootStart(entry({ rect: new DOMRect(0, 130, 10, 10), rootTop: 40 }))).toBe(
      false,
    );
  });

  it("falls back to the viewport origin when rootBounds is unavailable", () => {
    expect(isBeforeRootStart(entry({ rect: new DOMRect(0, -10, 10, 10), rootTop: null }))).toBe(
      true,
    );
    expect(isBeforeRootStart(entry({ rect: new DOMRect(0, 10, 10, 10), rootTop: null }))).toBe(
      false,
    );
  });

  it("never reports an empty rect as before the edge", () => {
    // An unrendered target (display:none, hidden ancestor, collapsed details)
    // reports 0x0 at the origin: `bottom === 0 <= rootTop` would otherwise read
    // as "scrolled past" for a viewport root, inventing a passed/stuck state.
    expect(isBeforeRootStart(entry({ rect: new DOMRect(), rootTop: 0 }))).toBe(false);
    expect(isBeforeRootStart(entry({ rect: new DOMRect(), rootTop: null }))).toBe(false);
    expect(isBeforeRootStart(entry({ rect: new DOMRect(), rootTop: 40 }))).toBe(false);
    // A rendered target at the very same coordinates still resolves normally.
    expect(isBeforeRootStart(entry({ rect: new DOMRect(0, -1, 1, 1), rootTop: 0 }))).toBe(true);
  });
});
