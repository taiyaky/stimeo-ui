import { describe, expect, it, vi } from "vitest";
import { recordListeners } from "../helpers/listeners";

/**
 * The setup shim gives happy-dom's `MediaQueryList` a browser's listener rules.
 * happy-dom computes `change` from a window `resize`, so each case resizes the
 * window and reads what the callback received, what the list still holds and
 * which `resize` listeners the window still holds.
 */
describe("MediaQueryList listeners under the setup shim", () => {
  const resize = (): void => {
    window.dispatchEvent(new Event("resize"));
  };

  it("reports a change on the first resize after the listener was added, and not again while the match holds", () => {
    const media = window.matchMedia("all");
    const handler = vi.fn();

    media.addEventListener("change", handler);
    resize();
    resize();

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ type: "change", matches: true });
    media.removeEventListener("change", handler);
  });

  it("adds nothing for a repeat of a live registration", () => {
    const media = window.matchMedia("all");
    const handler = vi.fn();

    media.addEventListener("change", handler);
    media.addEventListener("change", handler);
    resize();

    expect(handler).toHaveBeenCalledOnce();
    media.removeEventListener("change", handler);
  });

  it("releases the callback and its resize listener on removal", () => {
    const media = window.matchMedia("all");
    const handler = vi.fn();
    const ledger = recordListeners();

    media.addEventListener("change", handler);
    media.removeEventListener("change", handler);
    resize();
    media.dispatchEvent(new Event("change"));

    expect(handler).not.toHaveBeenCalled();
    expect(ledger.live(window, "resize")).toEqual([]);
  });

  it("releases the callback and its resize listener when its signal aborts", () => {
    const media = window.matchMedia("all");
    const handler = vi.fn();
    const abort = new AbortController();
    const ledger = recordListeners();

    media.addEventListener("change", handler, { signal: abort.signal });
    abort.abort();
    resize();
    media.dispatchEvent(new Event("change"));

    expect(handler).not.toHaveBeenCalled();
    expect(ledger.live(window, "resize")).toEqual([]);
  });

  it("registers nothing with an already aborted signal", () => {
    const media = window.matchMedia("all");
    const handler = vi.fn();
    const abort = new AbortController();
    abort.abort();

    media.addEventListener("change", handler, { signal: abort.signal });
    resize();
    media.dispatchEvent(new Event("change"));

    expect(handler).not.toHaveBeenCalled();
  });

  it("listens again once a removed callback is added back", () => {
    const media = window.matchMedia("all");
    const handler = vi.fn();

    media.addEventListener("change", handler);
    media.removeEventListener("change", handler);
    media.addEventListener("change", handler);
    resize();

    expect(handler).toHaveBeenCalledOnce();
    media.removeEventListener("change", handler);
  });

  it("keeps one callback's listener on a second list when the first releases it", () => {
    const first = window.matchMedia("all");
    const second = window.matchMedia("all");
    const handler = vi.fn();
    const ledger = recordListeners();

    first.addEventListener("change", handler);
    second.addEventListener("change", handler);
    first.removeEventListener("change", handler);
    resize();
    expect(handler).toHaveBeenCalledOnce();

    second.removeEventListener("change", handler);
    expect(ledger.live(window, "resize")).toEqual([]);
  });

  it("gives another type no resize listener, and leaves the same callback's change listener in place", () => {
    const media = window.matchMedia("all");
    const handler = vi.fn();
    const ledger = recordListeners();

    media.addEventListener("change", handler);
    media.addEventListener("other", handler);
    media.removeEventListener("other", handler);
    resize();
    expect(handler).toHaveBeenCalledOnce();

    media.removeEventListener("change", handler);
    expect(ledger.live(window, "resize")).toEqual([]);
  });
});
