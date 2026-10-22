import { describe, expect, it, vi } from "vitest";
import { FontEvents, withDocumentFonts } from "./font_events";

/** Verifies counted delivery without replacing native tuple and signal semantics. */
describe("FontEvents", () => {
  it("counts each consumer callback and keeps its receiver", () => {
    const source = new FontEvents();
    const handler = vi.fn(function (this: EventTarget) {
      expect(this).toBe(source);
    });
    source.addEventListener("loadingdone", handler);
    source.addEventListener("loadingerror", handler);
    source.dispatchEvent(new Event("loadingdone"));
    source.dispatchEvent(new Event("loadingerror"));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(source.deliveries).toBe(2);
  });

  it("deduplicates repeated tuples and removes the original listener", () => {
    const source = new FontEvents();
    const handler = vi.fn();
    source.addEventListener("loadingdone", handler);
    source.addEventListener("loadingdone", handler);
    source.dispatchEvent(new Event("loadingdone"));
    expect(handler).toHaveBeenCalledOnce();
    expect(source.deliveries).toBe(1);
    source.removeEventListener("loadingdone", handler);
    source.dispatchEvent(new Event("loadingdone"));
    expect(source.deliveries).toBe(1);
  });

  it("lets the original signal release both event registrations and then re-registers", () => {
    const source = new FontEvents();
    const abort = new AbortController();
    const handler = vi.fn();
    source.addEventListener("loadingdone", handler, { signal: abort.signal });
    source.addEventListener("loadingerror", handler, { signal: abort.signal });
    source.dispatchEvent(new Event("loadingdone"));
    source.dispatchEvent(new Event("loadingerror"));
    expect(source.deliveries).toBe(2);
    abort.abort();
    source.dispatchEvent(new Event("loadingdone"));
    source.dispatchEvent(new Event("loadingerror"));
    expect(source.deliveries).toBe(2);
    source.addEventListener("loadingdone", handler, { signal: new AbortController().signal });
    source.dispatchEvent(new Event("loadingdone"));
    expect(source.deliveries).toBe(3);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("keeps once and listener-object delivery native", () => {
    const source = new FontEvents();
    const listener = { handleEvent: vi.fn() };
    source.addEventListener("loadingerror", listener, { once: true });
    source.dispatchEvent(new Event("loadingerror"));
    source.dispatchEvent(new Event("loadingerror"));
    expect(listener.handleEvent).toHaveBeenCalledOnce();
    expect(source.deliveries).toBe(1);
  });

  it("restores document fonts when the run throws", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(document, "fonts");
    const failure = new Error("font fixture failed");
    await expect(
      withDocumentFonts(document, new FontEvents(), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(Object.getOwnPropertyDescriptor(document, "fonts")).toEqual(descriptor);
  });
});
