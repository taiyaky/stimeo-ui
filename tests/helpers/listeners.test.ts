import { Controller } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertListenersReleased, type ListenerLedger, recordListeners } from "./listeners";

/** The registration methods before any ledger patched them. */
const pristine = {
  documentAdd: document.addEventListener,
  documentRemove: document.removeEventListener,
  windowAdd: window.addEventListener,
  windowRemove: window.removeEventListener,
};

const expectPristine = (): void => {
  expect(document.addEventListener).toBe(pristine.documentAdd);
  expect(document.removeEventListener).toBe(pristine.documentRemove);
  expect(window.addEventListener).toBe(pristine.windowAdd);
  expect(window.removeEventListener).toBe(pristine.windowRemove);
};

/**
 * The ledger is trusted to say what the DOM still holds, so every verdict here
 * is checked against delivery in the same environment: a listener the ledger
 * calls live receives the next event, and one it calls released does not.
 */
describe("recordListeners", () => {
  let ledger: ListenerLedger | null = null;
  const nodes: Element[] = [];

  afterEach(() => {
    ledger?.restore();
    ledger = null;
    for (const node of nodes) node.remove();
    nodes.length = 0;
  });

  const start = (): ListenerLedger => {
    ledger = recordListeners();
    return ledger;
  };

  const element = (): HTMLElement => {
    const node = document.createElement("div");
    document.body.append(node);
    nodes.push(node);
    return node;
  };

  const fire = (target: EventTarget, type = "ping"): void => {
    target.dispatchEvent(new Event(type));
  };

  it("holds a registration until the matching removal", () => {
    const records = start();
    const target = element();
    const handler = vi.fn();

    target.addEventListener("ping", handler, true);
    fire(target);
    expect(records.live(target, "ping")).toHaveLength(1);
    expect(handler).toHaveBeenCalledOnce();

    target.removeEventListener("ping", handler, { capture: true });
    fire(target);
    expect(records.live(target, "ping")).toHaveLength(0);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("keeps a registration a removal with another capture flag misses", () => {
    // A browser matches the capture flag on removal; happy-dom removes the
    // listener from either phase, so delivery is not compared in this case.
    const records = start();
    const target = element();
    const handler = vi.fn();

    target.addEventListener("ping", handler, { capture: true });
    target.removeEventListener("ping", handler);

    expect(records.live(target, "ping")).toHaveLength(1);
  });

  it("releases a registration when its signal aborts", () => {
    const records = start();
    const target = element();
    const handler = vi.fn();
    const abort = new AbortController();

    target.addEventListener("ping", handler, { signal: abort.signal });
    abort.abort();
    fire(target);

    expect(records.live(target)).toHaveLength(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores a repeated registration and the signal it carried", () => {
    // Two lifetimes that each add the same handler with their own signal: the
    // first registration stays, bound to the first signal, so aborting the
    // second leaves it delivering.
    const records = start();
    const handler = vi.fn();
    const first = new AbortController();
    const second = new AbortController();

    window.addEventListener("ping", handler, { signal: first.signal });
    window.addEventListener("ping", handler, { signal: second.signal });
    second.abort();
    fire(window);
    expect(records.live(window, "ping")).toHaveLength(1);
    expect(handler).toHaveBeenCalledOnce();

    first.abort();
    fire(window);
    expect(records.live(window, "ping")).toHaveLength(0);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("records the document and window as well as elements", () => {
    const records = start();
    const handler = vi.fn();

    document.addEventListener("ping", handler);
    window.addEventListener("pong", handler);
    expect(records.live(document, "ping")).toHaveLength(1);
    expect(records.live(window, "pong")).toHaveLength(1);

    document.removeEventListener("ping", handler);
    window.removeEventListener("pong", handler);
    expect(records.live()).toHaveLength(0);
  });

  it("does not record the bookkeeping on an abort signal", () => {
    const records = start();
    const target = element();
    const abort = new AbortController();

    target.addEventListener("ping", () => {}, { signal: abort.signal });

    expect(records.live().map((record) => record.target)).toEqual([target]);
  });

  it("never counts a registration made with an aborted signal", () => {
    // A browser registers nothing here; happy-dom does, so delivery is not
    // compared in this one case.
    const records = start();
    const target = element();
    const abort = new AbortController();
    abort.abort();

    target.addEventListener("ping", () => {}, { signal: abort.signal });

    expect(records.live(target)).toHaveLength(0);
  });

  it("records nothing made before it starts, and stops recording once restored", () => {
    const target = element();
    const before = vi.fn();
    const after = vi.fn();
    target.addEventListener("ping", before);

    const records = start();
    records.restore();
    target.addEventListener("ping", after);

    expect(records.live()).toHaveLength(0);
    target.removeEventListener("ping", before);
    target.removeEventListener("ping", after);
  });
});

describe("restoring a ledger", () => {
  it("puts the original methods back", () => {
    recordListeners().restore();

    expectPristine();
  });

  it("restores once, so a second call leaves a newer ledger recording", () => {
    const first = recordListeners();
    first.restore();
    const second = recordListeners();
    first.restore();
    const handler = (): void => {};

    window.addEventListener("ping", handler);
    expect(second.live(window, "ping")).toHaveLength(1);
    window.removeEventListener("ping", handler);
  });

  // These two run in order: the first leaves its ledger recording, and the second
  // finds the methods put back by the restore that runs after each test.
  it("leaves a ledger recording until the test ends", () => {
    recordListeners();

    expect(window.addEventListener).not.toBe(pristine.windowAdd);
  });

  it("starts the next test with the original methods", () => {
    expectPristine();
  });
});

describe("assertListenersReleased", () => {
  class Releasing extends Controller {
    readonly #onResize = (): void => {};

    override connect(): void {
      window.addEventListener("resize", this.#onResize);
    }

    override disconnect(): void {
      window.removeEventListener("resize", this.#onResize);
    }
  }

  class Leaking extends Controller {
    override connect(): void {
      window.addEventListener("resize", () => {});
    }
  }

  /** Makes a new handler on each connect, so a second connect strands the first one. */
  class LeakingOnReconnect extends Controller {
    #onResize = (): void => {};

    override connect(): void {
      this.#onResize = () => {};
      window.addEventListener("resize", this.#onResize);
    }

    override disconnect(): void {
      window.removeEventListener("resize", this.#onResize);
    }
  }

  class Failing extends Controller {
    override connect(): void {
      throw new Error("connect failed");
    }
  }

  it.each([1, 2] as const)(
    "passes a controller that releases what it added (%i connections)",
    async (connections) => {
      await assertListenersReleased("releasing", Releasing, connections);
    },
  );

  it("fails a controller that leaves a listener registered", async () => {
    await expect(assertListenersReleased("leaking", Leaking, 1)).rejects.toThrow(
      "resize (capture false)",
    );
  });

  it("fails a controller whose second connect strands the first registration", async () => {
    await assertListenersReleased("reconnecting", LeakingOnReconnect, 1);
    await expect(assertListenersReleased("reconnecting", LeakingOnReconnect, 2)).rejects.toThrow(
      "resize (capture false)",
    );
  });

  it("fails a controller whose connect reports an error", async () => {
    await expect(assertListenersReleased("failing", Failing, 1)).rejects.toThrow();
  });

  it("fails when the markup gives the controller no host to connect on", async () => {
    const markup = { releasing: (id: string) => `<div data-controller="${id}"></div>` };

    await expect(assertListenersReleased("releasing", Releasing, 1, { markup })).rejects.toThrow(
      "releasing connected",
    );
  });

  it("leaves out a registration declared for the document's life", async () => {
    const documentLifetime = { leaking: [{ target: () => window, type: "resize" }] };

    await assertListenersReleased("leaking", Leaking, 1, { documentLifetime });
  });
});
