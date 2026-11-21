import { afterEach, describe, expect, it, vi } from "vitest";
import { IntersectionWatcher, isBeforeRootStart } from "../../src/utils/intersection_watcher";

interface ObserverRecord {
  callback: (entries: IntersectionObserverEntry[]) => void;
  options: IntersectionObserverInit | undefined;
  observed: Element[];
  unobserved: Element[];
  disconnectCount: number;
  targets: Set<Element>;
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
  rejectInvalidOptions = false,
  onConstruct,
  onObserve,
  beforeObserve,
  onUnobserve,
  onDisconnect,
}: {
  constructorError?: Error;
  /** 1-based constructions that fail; omitted = every construction fails. */
  constructorErrorAt?: number | readonly number[];
  observeErrorAt?: number;
  rejectInvalidOptions?: boolean;
  onConstruct?: (options: IntersectionObserverInit | undefined) => void;
  onObserve?: (target: Element, record: ObserverRecord) => void;
  beforeObserve?: (target: Element, record: ObserverRecord) => void;
  onUnobserve?: (target: Element) => void;
  onDisconnect?: () => void;
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
      const construction = ++constructions;
      onConstruct?.(options);
      const failsAt = Array.isArray(constructorErrorAt)
        ? constructorErrorAt.includes(construction)
        : constructorErrorAt === undefined || construction === constructorErrorAt;
      if (constructorError && failsAt) {
        throw constructorError;
      }
      const thresholds = Array.isArray(options?.threshold)
        ? options.threshold
        : options?.threshold === undefined
          ? []
          : [options.threshold];
      if (
        rejectInvalidOptions &&
        (options?.rootMargin === "200" || thresholds.some((value) => value < 0 || value > 1))
      ) {
        throw new SyntaxError("invalid IntersectionObserver options");
      }
      this.#record = {
        callback,
        options,
        observed: [],
        unobserved: [],
        disconnectCount: 0,
        targets: new Set(),
      };
      records.push(this.#record);
    }

    observe(target: Element): void {
      this.#observeCount += 1;
      if (this.#observeCount === observeErrorAt) throw new Error("observe failed");
      beforeObserve?.(target, this.#record);
      this.#record.observed.push(target);
      this.#record.targets.add(target);
      onObserve?.(target, this.#record);
    }

    unobserve(target: Element): void {
      this.#record.unobserved.push(target);
      this.#record.targets.delete(target);
      onUnobserve?.(target);
    }

    disconnect(): void {
      this.#record.disconnectCount += 1;
      this.#record.targets.clear();
      onDisconnect?.();
    }
  }

  vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
  return records;
};

/**
 * Contract tests for {@link IntersectionWatcher}: support detection, root
 * resolution, restart/re-arm behavior, stale callback isolation, and
 * exception-safe observer ownership.
 */
describe("IntersectionWatcher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
    expect(watcher.usingPlatformDefaults).toBe(false);
  });

  it("observes the viewport when the selector matches nothing or cannot be parsed", () => {
    // A root selector is authored in a data attribute, so a typo is the normal
    // failure. Both readings of "no root" mean the viewport: leaving the caller
    // inert would take its state hooks down with it.
    const records = installObserver();
    const target = document.createElement("div");
    const watcher = new IntersectionWatcher(() => {});

    expect(watcher.start(target, { rootSelector: "#absent" })).toBe(true);
    expect(records[0]?.options?.root).toBeNull();

    expect(watcher.start(target, { rootSelector: "#:::not-a-selector" })).toBe(true);
    expect(records[1]?.options?.root).toBeNull();
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
    expect(watcher.usingPlatformDefaults).toBe(false);
    expect(onEntries).not.toHaveBeenCalled();
  });

  it("retries invalid options once with platform defaults while preserving the root", () => {
    const onConstruct = vi.fn();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const records = installObserver({ rejectInvalidOptions: true, onConstruct });
    const target = document.createElement("div");
    const root = document.createElement("div");
    const onEntries = vi.fn();
    const watcher = new IntersectionWatcher(onEntries);

    expect(watcher.start(target, { root, rootMargin: "200", threshold: [0, 0.5] })).toBe(true);

    expect(onConstruct).toHaveBeenCalledTimes(2);
    expect(onConstruct).toHaveBeenNthCalledWith(1, {
      root,
      rootMargin: "200",
      threshold: [0, 0.5],
    });
    expect(onConstruct).toHaveBeenNthCalledWith(2, { root });
    expect(records).toHaveLength(1);
    expect(records[0]?.options).toEqual({ root });
    expect(records[0]?.observed).toEqual([target]);
    expect(watcher.active).toBe(true);
    expect(watcher.usingPlatformDefaults).toBe(true);
    expect(warning).toHaveBeenCalledOnce();

    records[0]?.callback([entryFor(target)]);
    expect(onEntries).toHaveBeenCalledOnce();

    watcher.stop();
    expect(watcher.usingPlatformDefaults).toBe(false);
  });

  it("drops an invalid threshold when retrying with platform defaults", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const records = installObserver({ rejectInvalidOptions: true });
    const target = document.createElement("div");
    const watcher = new IntersectionWatcher(() => {});

    expect(watcher.start(target, { threshold: 2 })).toBe(true);

    expect(records).toHaveLength(1);
    expect(records[0]?.options).toEqual({ root: null });
    expect(records[0]?.observed).toEqual([target]);
    expect(watcher.active).toBe(true);
    expect(watcher.usingPlatformDefaults).toBe(true);
    expect(warning).toHaveBeenCalledOnce();
  });

  it("remains inactive and rethrows when the fallback constructor also fails", () => {
    const firstFailure = new Error("invalid options");
    const fallbackFailure = new Error("fallback failed");
    const onConstruct = vi.fn();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let constructions = 0;
    class IntersectionObserverMock {
      constructor() {
        constructions += 1;
        onConstruct();
        throw constructions === 1 ? firstFailure : fallbackFailure;
      }
    }
    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
    const watcher = new IntersectionWatcher(() => {});

    expect(() => watcher.start(document.createElement("div"))).toThrow(fallbackFailure);
    expect(onConstruct).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledOnce();
    expect(watcher.active).toBe(false);
    expect(watcher.usingPlatformDefaults).toBe(false);
  });

  it("disconnects partial observation and rethrows an observe failure", () => {
    const onConstruct = vi.fn();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const records = installObserver({ observeErrorAt: 2, onConstruct });
    const first = document.createElement("div");
    const second = document.createElement("div");
    const onEntries = vi.fn();
    const watcher = new IntersectionWatcher(onEntries);

    expect(() => watcher.start([first, second])).toThrow("observe failed");
    records[0]?.callback([entryFor(first)]);

    expect(records[0]?.observed).toEqual([first]);
    expect(records[0]?.disconnectCount).toBe(1);
    expect(onConstruct).toHaveBeenCalledOnce();
    expect(warning).not.toHaveBeenCalled();
    expect(watcher.active).toBe(false);
    expect(onEntries).not.toHaveBeenCalled();
  });

  it("clears platform-default status when fallback observation fails", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const records = installObserver({ rejectInvalidOptions: true, observeErrorAt: 2 });
    const first = document.createElement("div");
    const second = document.createElement("div");
    const watcher = new IntersectionWatcher(() => {});

    expect(() => watcher.start([first, second], { threshold: 2 })).toThrow("observe failed");

    expect(records).toHaveLength(1);
    expect(records[0]?.options).toEqual({ root: null });
    expect(records[0]?.observed).toEqual([first]);
    expect(records[0]?.disconnectCount).toBe(1);
    expect(watcher.active).toBe(false);
    expect(watcher.usingPlatformDefaults).toBe(false);
  });

  it("releases the live observer when a restart fails to construct", () => {
    const onConstruct = vi.fn();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const records = installObserver({
      constructorError: new Error("constructor failed"),
      constructorErrorAt: [2, 3],
      onConstruct,
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
    expect(onConstruct).toHaveBeenCalledTimes(3);
    expect(warning).toHaveBeenCalledOnce();
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

  it.each(["root", "rootMargin", "constructor", "warning", "observe"] as const)(
    "keeps a later start made during %s and retires the interrupted start",
    (phase) => {
      const first = document.createElement("div");
      const later = document.createElement("div");
      const onEntries = vi.fn();
      const watcher = new IntersectionWatcher(onEntries);
      let interrupted = false;
      const interrupt = () => {
        if (interrupted) return;
        interrupted = true;
        expect(watcher.start(later)).toBe(true);
      };
      const records = installObserver({
        rejectInvalidOptions: phase === "warning",
        onConstruct: () => {
          if (phase === "constructor") interrupt();
        },
        onObserve: () => {
          if (phase === "observe") interrupt();
        },
      });
      vi.spyOn(console, "warn").mockImplementation(() => {
        if (phase === "warning") interrupt();
      });

      expect(
        watcher.start(first, {
          get root() {
            if (phase === "root") interrupt();
            return null;
          },
          get rootMargin() {
            if (phase === "rootMargin") interrupt();
            return phase === "warning" ? "200" : "0px";
          },
        }),
      ).toBe(false);

      expect(watcher.active).toBe(true);
      expect(watcher.usingPlatformDefaults).toBe(false);
      for (const record of records) record.callback([entryFor(record.observed[0] ?? first)]);
      expect(onEntries).toHaveBeenCalledExactlyOnceWith([entryFor(later)]);
      expect(records.filter((record) => record.disconnectCount === 0)).toHaveLength(1);
      watcher.stop();
      expect(records.every((record) => record.disconnectCount > 0)).toBe(true);
    },
  );

  it.each(["root", "rootMargin", "constructor", "warning", "observe"] as const)(
    "honors a stop made during %s before publishing a started observer",
    (phase) => {
      const target = document.createElement("div");
      const onEntries = vi.fn();
      const watcher = new IntersectionWatcher(onEntries);
      let interrupted = false;
      const interrupt = () => {
        if (interrupted) return;
        interrupted = true;
        watcher.stop();
      };
      const records = installObserver({
        rejectInvalidOptions: phase === "warning",
        onConstruct: () => {
          if (phase === "constructor") interrupt();
        },
        onObserve: () => {
          if (phase === "observe") interrupt();
        },
      });
      vi.spyOn(console, "warn").mockImplementation(() => {
        if (phase === "warning") interrupt();
      });

      expect(
        watcher.start(target, {
          get root() {
            if (phase === "root") interrupt();
            return null;
          },
          get rootMargin() {
            if (phase === "rootMargin") interrupt();
            return phase === "warning" ? "200" : "0px";
          },
        }),
      ).toBe(false);

      expect(watcher.active).toBe(false);
      expect(watcher.usingPlatformDefaults).toBe(false);
      for (const record of records) record.callback([entryFor(target)]);
      expect(onEntries).not.toHaveBeenCalled();
      expect(records.every((record) => record.disconnectCount > 0)).toBe(true);
    },
  );

  it("reports inactive platform defaults until fallback targets are fully observed", () => {
    const target = document.createElement("div");
    const onEntries = vi.fn();
    const watcher = new IntersectionWatcher(onEntries);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    installObserver({
      rejectInvalidOptions: true,
      onObserve: (_, record) => {
        expect(watcher.active).toBe(false);
        expect(watcher.usingPlatformDefaults).toBe(false);
        record.callback([entryFor(target)]);
      },
    });

    expect(watcher.start(target, { threshold: 2 })).toBe(true);
    expect(watcher.active).toBe(true);
    expect(watcher.usingPlatformDefaults).toBe(true);
    expect(onEntries).not.toHaveBeenCalled();
    watcher.stop();
  });

  it("releases a failed partial start without stopping a later successful start", () => {
    const first = document.createElement("div");
    const later = document.createElement("div");
    const failure = new Error("observe failed after a later start");
    const onEntries = vi.fn();
    const watcher = new IntersectionWatcher(onEntries);
    const records = installObserver({
      onObserve: (target) => {
        if (target !== first) return;
        watcher.start(later);
        throw failure;
      },
    });

    let caught: unknown;
    try {
      watcher.start(first);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(watcher.active).toBe(true);
    expect(records[0]?.disconnectCount).toBeGreaterThan(0);
    expect(records[1]?.disconnectCount).toBe(0);
    records[0]?.callback([entryFor(first)]);
    records[1]?.callback([entryFor(later)]);
    expect(onEntries).toHaveBeenCalledExactlyOnceWith([entryFor(later)]);
    watcher.stop();
  });

  it.each(["unobserve", "observe"] as const)(
    "does not continue a retired rearm after a later start during %s",
    (phase) => {
      const first = document.createElement("div");
      const later = document.createElement("div");
      const watcher = new IntersectionWatcher(() => {});
      let armed = false;
      const interrupt = () => {
        if (!armed) return;
        armed = false;
        watcher.start(later);
      };
      const records = installObserver({
        onUnobserve: () => {
          if (phase === "unobserve") interrupt();
        },
        onObserve: () => {
          if (phase === "observe") interrupt();
        },
      });
      watcher.start(first);
      armed = true;

      expect(() => watcher.rearm(first)).not.toThrow();
      expect(watcher.active).toBe(true);
      expect(records[0]?.disconnectCount).toBeGreaterThan(0);
      expect(records[1]?.observed).toEqual([later]);
      watcher.stop();
    },
  );

  it("preserves a later start when a retired rearm throws the platform error", () => {
    const first = document.createElement("div");
    const later = document.createElement("div");
    const failure = new Error("unobserve failed after a later start");
    const watcher = new IntersectionWatcher(() => {});
    const records = installObserver({
      onUnobserve: () => {
        watcher.start(later);
        throw failure;
      },
    });
    watcher.start(first);

    let caught: unknown;
    try {
      watcher.rearm(first);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(watcher.active).toBe(true);
    expect(records[0]?.disconnectCount).toBeGreaterThan(0);
    expect(records[1]?.disconnectCount).toBe(0);
    watcher.stop();
  });

  it("preserves a later start made while a stopped observer is being disconnected", () => {
    const first = document.createElement("div");
    const later = document.createElement("div");
    const onEntries = vi.fn();
    const watcher = new IntersectionWatcher(onEntries);
    let armed = false;
    const records = installObserver({
      onDisconnect: () => {
        if (!armed) return;
        armed = false;
        watcher.start(later);
      },
    });
    watcher.start(first);
    armed = true;

    watcher.stop();
    expect(watcher.active).toBe(true);
    records[0]?.callback([entryFor(first)]);
    records[1]?.callback([entryFor(later)]);
    expect(onEntries).toHaveBeenCalledExactlyOnceWith([entryFor(later)]);
    watcher.stop();
    expect(records[1]?.disconnectCount).toBe(1);
  });

  it("retires a restart when disconnecting its predecessor starts a later observer", () => {
    const first = document.createElement("div");
    const interrupted = document.createElement("div");
    const later = document.createElement("div");
    const watcher = new IntersectionWatcher(() => {});
    let armed = false;
    const records = installObserver({
      onDisconnect: () => {
        if (!armed) return;
        armed = false;
        watcher.start(later);
      },
    });
    watcher.start(first);
    armed = true;

    expect(watcher.start(interrupted)).toBe(false);
    expect(watcher.active).toBe(true);
    expect(records.at(-1)?.observed).toEqual([later]);
    watcher.stop();
    expect(records.every((record) => record.disconnectCount > 0)).toBe(true);
  });
});

describe("IntersectionWatcher reentrant fallback and rearm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not read target length after releasing its predecessor retires the start", () => {
    const first = document.createElement("div");
    const later = document.createElement("div");
    const watcher = new IntersectionWatcher(() => {});
    let replacing = false;
    const records = installObserver({
      onDisconnect: () => {
        if (!replacing) return;
        replacing = false;
        watcher.start(later);
      },
    });
    watcher.start(first);
    const targets = new Proxy([first], {
      get: (array, key, receiver) => {
        if (key === "length") watcher.stop();
        return Reflect.get(array, key, receiver);
      },
    });
    replacing = true;

    expect(watcher.start(targets)).toBe(false);
    expect(watcher.active).toBe(true);
    expect(records[1]?.targets).toEqual(new Set([later]));
    watcher.stop();
  });

  it("does not resolve the root after reading target length retires the start", () => {
    const first = document.createElement("div");
    const later = document.createElement("div");
    const watcher = new IntersectionWatcher(() => {});
    const records = installObserver();
    const targets = new Proxy([first], {
      get: (array, key, receiver) => {
        if (key === "length") watcher.start(later);
        return Reflect.get(array, key, receiver);
      },
    });

    expect(
      watcher.start(targets, {
        get root() {
          watcher.stop();
          return null;
        },
      }),
    ).toBe(false);

    expect(watcher.active).toBe(true);
    expect(records[0]?.targets).toEqual(new Set([later]));
    watcher.stop();
  });

  it("does not run a fallback factory after its warning starts a later observer", () => {
    const first = document.createElement("div");
    const later = document.createElement("div");
    const watcher = new IntersectionWatcher(() => {});
    const records = installObserver({
      rejectInvalidOptions: true,
      onConstruct: (options) => {
        if (options && !("rootMargin" in options)) watcher.stop();
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => watcher.start(later));

    expect(watcher.start(first, { rootMargin: "200" })).toBe(false);
    expect(watcher.active).toBe(true);
    expect(records[0]?.targets).toEqual(new Set([later]));
    watcher.stop();
  });

  it("does not read configured options after resolving the root retires its start", () => {
    const first = document.createElement("div");
    const later = document.createElement("div");
    const onEntries = vi.fn();
    const watcher = new IntersectionWatcher(onEntries);
    const records = installObserver();

    expect(
      watcher.start(first, {
        get root() {
          watcher.start(later);
          return null;
        },
        get rootMargin() {
          watcher.stop();
          return "0px";
        },
      }),
    ).toBe(false);

    expect(watcher.active).toBe(true);
    expect(records[0]?.targets).toEqual(new Set([later]));
    records[0]?.callback([entryFor(later)]);
    expect(onEntries).toHaveBeenCalledExactlyOnceWith([entryFor(later)]);
    watcher.stop();
  });

  it("does not warn after an option getter starts a later observer and throws", () => {
    const first = document.createElement("div");
    const later = document.createElement("div");
    const onEntries = vi.fn();
    const watcher = new IntersectionWatcher(onEntries);
    const records = installObserver();
    vi.spyOn(console, "warn").mockImplementation(() => watcher.stop());

    expect(
      watcher.start(first, {
        get rootMargin(): string {
          watcher.start(later);
          throw new Error("retired configured options");
        },
      }),
    ).toBe(false);

    expect(watcher.active).toBe(true);
    expect(records[0]?.targets).toEqual(new Set([later]));
    records[0]?.callback([entryFor(later)]);
    expect(onEntries).toHaveBeenCalledExactlyOnceWith([entryFor(later)]);
    watcher.stop();
  });

  it("keeps a later start without converting options from a retired attempt", () => {
    const first = document.createElement("div");
    const later = document.createElement("div");
    const onEntries = vi.fn();
    const watcher = new IntersectionWatcher(onEntries);
    const thresholds = [0.5];
    Object.defineProperty(thresholds, "0", {
      get: () => {
        watcher.stop();
        return 0.5;
      },
    });
    const records = installObserver({
      onConstruct: (options) => {
        if (Array.isArray(options?.threshold)) Array.from(options.threshold);
      },
    });

    expect(
      watcher.start(first, {
        get rootMargin() {
          watcher.start(later);
          return "0px";
        },
        threshold: thresholds,
      }),
    ).toBe(false);

    expect(watcher.active).toBe(true);
    expect(records[0]?.targets).toEqual(new Set([later]));
    records[0]?.callback([entryFor(later)]);
    expect(onEntries).toHaveBeenCalledExactlyOnceWith([entryFor(later)]);
    watcher.stop();
  });

  it("does not enter a target iterator after construction retires its start", () => {
    const first = document.createElement("div");
    const later = document.createElement("div");
    const watcher = new IntersectionWatcher(() => {});
    const targets = [first];
    Object.defineProperty(targets, Symbol.iterator, {
      value: function* () {
        watcher.stop();
        yield first;
      },
    });
    let constructing = true;
    const records = installObserver({
      onConstruct: () => {
        if (!constructing) return;
        constructing = false;
        watcher.start(later);
      },
    });

    expect(watcher.start(targets)).toBe(false);
    expect(watcher.active).toBe(true);
    expect(records.find((record) => record.targets.has(later))?.targets).toEqual(new Set([later]));
    expect(records.every((record) => !record.targets.has(first))).toBe(true);
    watcher.stop();
  });

  it("does not resume a target iterator after observation retires its start", () => {
    const first = document.createElement("div");
    const later = document.createElement("div");
    const watcher = new IntersectionWatcher(() => {});
    const targets = [first];
    Object.defineProperty(targets, Symbol.iterator, {
      value: function* () {
        yield first;
        watcher.stop();
      },
    });
    const records = installObserver({
      onObserve: (target) => {
        if (target === first) watcher.start(later);
      },
    });

    expect(watcher.start(targets)).toBe(false);
    expect(watcher.active).toBe(true);
    expect(records[0]?.targets.size).toBe(0);
    expect(records[1]?.targets).toEqual(new Set([later]));
    watcher.stop();
  });

  it("does not observe a target yielded after its iterator retires the start", () => {
    const first = document.createElement("div");
    const later = document.createElement("div");
    const watcher = new IntersectionWatcher(() => {});
    const targets = [first];
    Object.defineProperty(targets, Symbol.iterator, {
      value: function* () {
        watcher.start(later);
        yield first;
      },
    });
    const records = installObserver({
      beforeObserve: (target) => {
        if (target === first) watcher.stop();
      },
    });

    expect(watcher.start(targets)).toBe(false);
    expect(watcher.active).toBe(true);
    expect(records[0]?.targets.size).toBe(0);
    expect(records[1]?.targets).toEqual(new Set([later]));
    watcher.stop();
  });

  it.each(["stop", "start"] as const)(
    "releases a start registration made after a delegate performs a later %s",
    (operation) => {
      const first = document.createElement("div");
      const later = document.createElement("div");
      const watcher = new IntersectionWatcher(() => {});
      const records = installObserver({
        beforeObserve: (target) => {
          if (target !== first) return;
          if (operation === "stop") watcher.stop();
          else watcher.start(later);
        },
      });

      expect(watcher.start(first)).toBe(false);
      expect(records[0]?.targets.size).toBe(0);
      expect(watcher.active).toBe(operation === "start");
      if (operation === "start") expect(records[1]?.targets).toEqual(new Set([later]));
      watcher.stop();
    },
  );

  it.each(["stop", "start"] as const)(
    "releases a rearm registration made after a delegate performs a later %s",
    (operation) => {
      const first = document.createElement("div");
      const later = document.createElement("div");
      const onEntries = vi.fn();
      const watcher = new IntersectionWatcher(onEntries);
      let rearming = false;
      const records = installObserver({
        beforeObserve: (target) => {
          if (!rearming || target !== first) return;
          rearming = false;
          if (operation === "stop") watcher.stop();
          else watcher.start(later);
        },
      });
      watcher.start(first);
      rearming = true;

      watcher.rearm(first);

      expect(records[0]?.targets.size).toBe(0);
      expect(watcher.active).toBe(operation === "start");
      records[0]?.callback([entryFor(first)]);
      if (operation === "start") {
        expect(records[1]?.targets).toEqual(new Set([later]));
        records[1]?.callback([entryFor(later)]);
        expect(onEntries).toHaveBeenCalledExactlyOnceWith([entryFor(later)]);
      } else expect(onEntries).not.toHaveBeenCalled();
      watcher.stop();
    },
  );

  it("keeps a later start made while converting the threshold sequence", () => {
    const first = document.createElement("div");
    const later = document.createElement("div");
    const watcher = new IntersectionWatcher(() => {});
    const thresholds = [0.5];
    Object.defineProperty(thresholds, Symbol.iterator, {
      value: function* () {
        watcher.start(later);
        yield 0.5;
      },
    });
    const records = installObserver({
      onConstruct: (options) => {
        if (Array.isArray(options?.threshold)) Array.from(options.threshold);
      },
    });

    expect(watcher.start(first, { threshold: thresholds })).toBe(false);
    expect(watcher.active).toBe(true);
    expect(records.filter((record) => record.disconnectCount === 0)).toHaveLength(1);
    expect(records.find((record) => record.disconnectCount === 0)?.observed).toEqual([later]);
    watcher.stop();
    expect(records.every((record) => record.disconnectCount > 0)).toBe(true);
  });

  it("does not publish a retired start when its target iterator finishes after a later start", () => {
    const first = document.createElement("div");
    const later = document.createElement("div");
    const watcher = new IntersectionWatcher(() => {});
    const targets = [first];
    Object.defineProperty(targets, Symbol.iterator, {
      value: function* () {
        yield first;
        watcher.start(later);
      },
    });
    const records = installObserver();

    expect(watcher.start(targets)).toBe(false);
    expect(watcher.active).toBe(true);
    expect(records[0]?.disconnectCount).toBeGreaterThan(0);
    expect(records[1]?.observed).toEqual([later]);
    watcher.stop();
  });

  it("preserves a later start and the exact fallback constructor error", () => {
    const first = document.createElement("div");
    const later = document.createElement("div");
    const failure = new Error("fallback failed after a later start");
    const watcher = new IntersectionWatcher(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const records = installObserver({
      rejectInvalidOptions: true,
      constructorError: failure,
      constructorErrorAt: 2,
      onConstruct: (options) => {
        if (options && !("rootMargin" in options)) watcher.start(later);
      },
    });

    let caught: unknown;
    try {
      watcher.start(first, { threshold: 2 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(watcher.active).toBe(true);
    expect(watcher.usingPlatformDefaults).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]?.observed).toEqual([later]);
    expect(records[0]?.disconnectCount).toBe(0);
    watcher.stop();
  });

  it.each(["unobserve", "observe"] as const)(
    "honors a stop made during rearm %s without observing a replacement",
    (phase) => {
      const target = document.createElement("div");
      const onEntries = vi.fn();
      const watcher = new IntersectionWatcher(onEntries);
      let armed = false;
      const interrupt = () => {
        if (!armed) return;
        armed = false;
        watcher.stop();
      };
      const records = installObserver({
        onUnobserve: () => {
          if (phase === "unobserve") interrupt();
        },
        onObserve: () => {
          if (phase === "observe") interrupt();
        },
      });
      watcher.start(target);
      armed = true;

      expect(() => watcher.rearm(target)).not.toThrow();
      expect(watcher.active).toBe(false);
      expect(records[0]?.observed).toHaveLength(phase === "unobserve" ? 1 : 2);
      expect(records[0]?.disconnectCount).toBeGreaterThan(0);
      records[0]?.callback([entryFor(target)]);
      expect(onEntries).not.toHaveBeenCalled();
    },
  );
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
