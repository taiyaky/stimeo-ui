import { afterEach, describe, expect, it, vi } from "vitest";
import { FontLoadWatcher } from "../../src/utils/font_load_watcher";

/** Font subscriptions follow their actual source and release only their own lifetime. */
describe("FontLoadWatcher", () => {
  const watchers: FontLoadWatcher[] = [];

  afterEach(() => {
    for (const watcher of watchers) watcher.disconnect();
    watchers.length = 0;
    vi.restoreAllMocks();
  });

  /** A separate document makes global-document substitutions observable. */
  const elementWithFonts = (fonts: EventTarget | undefined): Element => {
    const owner = document.implementation.createHTMLDocument();
    Object.defineProperty(owner, "fonts", { configurable: true, value: fonts });
    return owner.createElement("div");
  };

  const watch = (run: () => void): FontLoadWatcher => {
    const watcher = new FontLoadWatcher(run);
    watchers.push(watcher);
    return watcher;
  };

  const settle = (fonts: EventTarget): void => {
    fonts.dispatchEvent(new Event("loadingdone"));
    fonts.dispatchEvent(new Event("loadingerror"));
  };

  it("delivers both terminal events synchronously from the element's document", () => {
    const fonts = new EventTarget();
    const run = vi.fn();
    const watcher = watch(run);
    watcher.observe(elementWithFonts(fonts));

    fonts.dispatchEvent(new Event("loadingdone"));
    expect(run).toHaveBeenCalledTimes(1);
    fonts.dispatchEvent(new Event("loadingerror"));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("preserves one registration when observing the same source repeatedly", () => {
    const fonts = new EventTarget();
    const add = vi.spyOn(fonts, "addEventListener");
    const run = vi.fn();
    const watcher = watch(run);
    const element = elementWithFonts(fonts);

    watcher.observe(element);
    watcher.observe(element);
    watcher.observe(elementWithFonts(fonts));
    expect(add).toHaveBeenCalledTimes(2);
    settle(fonts);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("releases the former source before following a replacement", () => {
    const former = new EventTarget();
    const current = new EventTarget();
    const element = elementWithFonts(former);
    const run = vi.fn();
    const watcher = watch(run);
    watcher.observe(element);
    settle(former);
    expect(run).toHaveBeenCalledTimes(2);

    Object.defineProperty(element.ownerDocument, "fonts", { value: current });
    watcher.observe(element);
    settle(former);
    expect(run).toHaveBeenCalledTimes(2);
    settle(current);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("releases the held source after the element moves to another document", () => {
    const former = new EventTarget();
    const current = new EventTarget();
    const element = elementWithFonts(former);
    const other = elementWithFonts(current).ownerDocument;
    const run = vi.fn();
    const watcher = watch(run);
    watcher.observe(element);
    settle(former);
    expect(run).toHaveBeenCalledTimes(2);

    other.adoptNode(element);
    watcher.disconnect();
    settle(former);
    settle(current);
    expect(run).toHaveBeenCalledTimes(2);

    watcher.observe(element);
    settle(former);
    expect(run).toHaveBeenCalledTimes(2);
    settle(current);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("releases the former source when the next document has no fonts API", () => {
    const fonts = new EventTarget();
    const run = vi.fn();
    const watcher = watch(run);
    watcher.observe(elementWithFonts(fonts));
    settle(fonts);
    expect(run).toHaveBeenCalledTimes(2);

    watcher.observe(elementWithFonts(undefined));
    settle(fonts);
    expect(run).toHaveBeenCalledTimes(2);
    watcher.observe(elementWithFonts(undefined));
  });

  it("accepts a missing fonts API before and between connected lifetimes", () => {
    const run = vi.fn();
    const watcher = watch(run);
    watcher.disconnect();
    watcher.observe(elementWithFonts(undefined));
    expect(run).not.toHaveBeenCalled();

    const fonts = new EventTarget();
    watcher.observe(elementWithFonts(fonts));
    settle(fonts);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stops delivery on repeated disconnects and resumes with one new generation", () => {
    const fonts = new EventTarget();
    const element = elementWithFonts(fonts);
    const run = vi.fn();
    const watcher = watch(run);
    watcher.observe(element);
    settle(fonts);
    expect(run).toHaveBeenCalledTimes(2);

    watcher.disconnect();
    watcher.disconnect();
    settle(fonts);
    expect(run).toHaveBeenCalledTimes(2);

    watcher.observe(element);
    watcher.observe(element);
    settle(fonts);
    expect(run).toHaveBeenCalledTimes(4);
    watcher.disconnect();
    settle(fonts);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("keeps independent lifetimes even when watchers receive the same callback", () => {
    const fonts = new EventTarget();
    const element = elementWithFonts(fonts);
    const run = vi.fn();
    const first = watch(run);
    const second = watch(run);
    first.observe(element);
    second.observe(element);
    settle(fonts);
    expect(run).toHaveBeenCalledTimes(4);

    first.disconnect();
    settle(fonts);
    expect(run).toHaveBeenCalledTimes(6);
    second.disconnect();
    settle(fonts);
    expect(run).toHaveBeenCalledTimes(6);
  });

  it("does not borrow or remove another owner's matching callback", () => {
    const fonts = new EventTarget();
    const run = vi.fn();
    fonts.addEventListener("loadingdone", run);
    const watcher = watch(run);
    watcher.observe(elementWithFonts(fonts));
    fonts.dispatchEvent(new Event("loadingdone"));
    expect(run).toHaveBeenCalledTimes(2);

    watcher.disconnect();
    fonts.dispatchEvent(new Event("loadingdone"));
    expect(run).toHaveBeenCalledTimes(3);
    fonts.removeEventListener("loadingdone", run);
  });
});
