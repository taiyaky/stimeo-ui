import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextareaAutosizeController } from "../src/controllers/textarea_autosize_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link TextareaAutosizeController}. happy-dom does not lay
 * out, so `scrollHeight` and `getComputedStyle` are mocked to deterministic line
 * metrics; the clamping math, hooks, events, and the re-measure triggers
 * (input / change, width changes, font settling, runtime Value changes) are
 * unit-tested here. The real geometry (actual growth on type) needs a real
 * browser and is not asserted here.
 */

const LINE = 20; // mocked line-height in px

/** Controllable ResizeObserver double for width-follow coverage. */
class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.add(element);
  }

  unobserve(element: Element): void {
    this.observed.delete(element);
  }

  disconnect(): void {
    this.observed.clear();
  }

  /** Reports a resize; a disconnected observer (no observations) stays silent. */
  trigger(): void {
    if (this.observed.size > 0) this.callback([], this);
  }
}

describe("TextareaAutosizeController", () => {
  let application: Application;

  const mockMetrics = (overrides: Record<string, string> = {}) => {
    const base = {
      lineHeight: `${LINE}px`,
      paddingTop: "0px",
      paddingBottom: "0px",
      paddingLeft: "0px",
      paddingRight: "0px",
      borderTopWidth: "0px",
      borderBottomWidth: "0px",
      fontSize: "16px",
      boxSizing: "content-box",
      ...overrides,
    };
    vi.spyOn(window, "getComputedStyle").mockReturnValue(base as unknown as CSSStyleDeclaration);
  };

  /** Makes scrollHeight reflect the value's line count (plus any padding). */
  const mockScrollHeight = (el: HTMLTextAreaElement, padding = 0) => {
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      get() {
        const lines = el.value === "" ? 1 : el.value.split("\n").length;
        return lines * LINE + padding;
      },
    });
  };

  const mount = async (
    attrs = "",
    metrics: Record<string, string> = {},
    padding = 0,
    beforeStart?: (el: HTMLTextAreaElement) => void,
  ) => {
    document.body.innerHTML = `<textarea data-controller="stimeo--textarea-autosize" ${attrs}></textarea>`;
    const el = query<HTMLTextAreaElement>("textarea");
    mockScrollHeight(el, padding);
    mockMetrics(metrics);
    // happy-dom lays nothing out, so a rendered box must be simulated: content
    // triggers are deferred while clientWidth is 0 (a collapsed box).
    Object.defineProperty(el, "clientWidth", { configurable: true, get: () => 100 });
    beforeStart?.(el);
    application = Application.start();
    application.register("stimeo--textarea-autosize", TextareaAutosizeController);
    await tick();
    return el;
  };

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeResizeObserver.instances = [];
    document.body.innerHTML = "";
  });

  const type = (el: HTMLTextAreaElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("sets an explicit pixel height on connect", async () => {
    const el = await mount();
    expect(el.style.height).toBe(`${LINE}px`); // one line
    expect(el.style.overflowY).toBe("hidden");
    expect(el.hasAttribute("data-at-max-rows")).toBe(false);
  });

  it("grows to fit the content as lines are added", async () => {
    const el = await mount();
    type(el, "a\nb\nc");
    expect(el.style.height).toBe(`${LINE * 3}px`);
    expect(el.style.getPropertyValue("--stimeo--textarea-rows")).toBe("3");
  });

  it("never shrinks below minRows", async () => {
    const el = await mount('data-stimeo--textarea-autosize-min-rows-value="2"');
    expect(el.style.height).toBe(`${LINE * 2}px`); // clamped up from 1 line
  });

  it("clamps at maxRows, enabling internal scroll and the hook", async () => {
    const el = await mount('data-stimeo--textarea-autosize-max-rows-value="3"');
    type(el, "a\nb\nc\nd\ne"); // 5 lines, capped at 3
    expect(el.style.height).toBe(`${LINE * 3}px`);
    expect(el.style.overflowY).toBe("auto");
    expect(el.getAttribute("data-at-max-rows")).toBe("true");
  });

  it("clears the max hook when back under the cap", async () => {
    const el = await mount('data-stimeo--textarea-autosize-max-rows-value="3"');
    type(el, "a\nb\nc\nd\ne");
    type(el, "a\nb");
    expect(el.hasAttribute("data-at-max-rows")).toBe(false);
    expect(el.style.overflowY).toBe("hidden");
  });

  it("dispatches resize with the new height and rows when it changes", async () => {
    const el = await mount();
    const events: Array<{ height: number; rows: number }> = [];
    el.addEventListener("stimeo--textarea-autosize:resize", (e) => {
      events.push((e as CustomEvent).detail);
    });
    type(el, "a\nb");
    expect(events.at(-1)).toEqual({ height: LINE * 2, rows: 2 });
  });

  it("dispatches resize on the first connect when it applies a height", async () => {
    document.body.innerHTML = `<textarea data-controller="stimeo--textarea-autosize"></textarea>`;
    const el = query<HTMLTextAreaElement>("textarea");
    mockScrollHeight(el);
    mockMetrics();
    const events: Array<{ height: number; rows: number }> = [];
    el.addEventListener("stimeo--textarea-autosize:resize", (e) => {
      events.push((e as CustomEvent).detail);
    });
    application = Application.start();
    application.register("stimeo--textarea-autosize", TextareaAutosizeController);
    await tick();
    expect(events).toEqual([{ height: LINE, rows: 1 }]);
  });

  it("stays silent when connecting over an unchanged height", async () => {
    // Turbo restore / morph keeps the inline height a previous connection wrote;
    // re-measuring to the same height must not re-notify the consumer.
    document.body.innerHTML = `<textarea style="height: 20px" data-controller="stimeo--textarea-autosize" data-stimeo--textarea-autosize-min-rows-value="1"></textarea>`;
    const el = query<HTMLTextAreaElement>("textarea");
    mockScrollHeight(el);
    mockMetrics();
    const events: unknown[] = [];
    el.addEventListener("stimeo--textarea-autosize:resize", () => events.push(true));
    application = Application.start();
    application.register("stimeo--textarea-autosize", TextareaAutosizeController);
    await tick();
    expect(el.style.height).toBe(`${LINE}px`);
    expect(events).toHaveLength(0);
  });

  it("re-measures on reconnect after the content changed while disconnected", async () => {
    const el = await mount();
    el.remove();
    await tick();
    el.value = "a\nb\nc\nd"; // no event fires while detached
    document.body.appendChild(el);
    await tick();
    expect(el.style.height).toBe(`${LINE * 4}px`);
  });

  it("re-measures when a change event announces a programmatic write", async () => {
    const el = await mount();
    el.value = "a\nb";
    el.dispatchEvent(new Event("change", { bubbles: true }));
    expect(el.style.height).toBe(`${LINE * 2}px`);
  });

  it("re-measures when the element width changes, ignoring same-width reports", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    let width = 100;
    const el = await mount("", {}, 0, (node) => {
      Object.defineProperty(node, "clientWidth", { configurable: true, get: () => width });
    });
    expect(el.style.height).toBe(`${LINE}px`);
    el.value = "a\nb\nc"; // silent assignment: only a width change may pick it up
    FakeResizeObserver.instances[0]?.trigger();
    expect(el.style.height).toBe(`${LINE}px`); // same width: own height writes stay ignored
    width = 60;
    FakeResizeObserver.instances[0]?.trigger();
    expect(el.style.height).toBe(`${LINE * 3}px`);
    el.remove();
    await tick();
    el.value = "a\nb\nc\nd\ne"; // a leaked observer would resize to five lines
    width = 200;
    FakeResizeObserver.instances[0]?.trigger();
    expect(el.style.height).toBe(`${LINE * 3}px`); // released on disconnect
  });

  it("re-measures when document fonts settle and releases the listeners", async () => {
    const own = Object.getOwnPropertyDescriptor(document, "fonts");
    const fonts = new EventTarget();
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
    try {
      const el = await mount();
      el.value = "a\nb"; // silent assignment: font settling must re-measure it
      fonts.dispatchEvent(new Event("loadingdone"));
      expect(el.style.height).toBe(`${LINE * 2}px`);
      el.value = "a\nb\nc"; // failed font loads settle layout too
      fonts.dispatchEvent(new Event("loadingerror"));
      expect(el.style.height).toBe(`${LINE * 3}px`);
      el.remove();
      await tick();
      el.value = "a\nb\nc\nd\ne";
      fonts.dispatchEvent(new Event("loadingdone"));
      fonts.dispatchEvent(new Event("loadingerror"));
      expect(el.style.height).toBe(`${LINE * 3}px`); // both released on disconnect
    } finally {
      if (own) Object.defineProperty(document, "fonts", own);
      else Reflect.deleteProperty(document, "fonts");
    }
  });

  it("defers re-measuring while the element's box is collapsed", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    let width = 100;
    document.body.innerHTML = `<textarea data-controller="stimeo--textarea-autosize"></textarea>`;
    const el = query<HTMLTextAreaElement>("textarea");
    // Hidden boxes report scrollHeight 0, like a display:none subtree does.
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      get: () => (width === 0 ? 0 : (el.value === "" ? 1 : el.value.split("\n").length) * LINE),
    });
    mockMetrics();
    Object.defineProperty(el, "clientWidth", { configurable: true, get: () => width });
    const events: unknown[] = [];
    el.addEventListener("stimeo--textarea-autosize:resize", () => events.push(true));
    application = Application.start();
    application.register("stimeo--textarea-autosize", TextareaAutosizeController);
    await tick();
    type(el, "a\nb\nc");
    expect(el.style.height).toBe(`${LINE * 3}px`);
    const dispatched = events.length;
    width = 0; // an ancestor went display:none
    FakeResizeObserver.instances[0]?.trigger();
    expect(el.style.height).toBe(`${LINE * 3}px`); // kept, not clamped to the minRows floor
    expect(events).toHaveLength(dispatched); // no bogus notification
    width = 100; // revealed again at the same width: the kept height is still right
    FakeResizeObserver.instances[0]?.trigger();
    expect(el.style.height).toBe(`${LINE * 3}px`);
    expect(events).toHaveLength(dispatched);
    width = 0; // hidden again, and the content changes while collapsed
    FakeResizeObserver.instances[0]?.trigger();
    el.value = "a\nb\nc\nd\ne";
    el.dispatchEvent(new Event("change", { bubbles: true }));
    expect(el.style.height).toBe(`${LINE * 3}px`); // deferred, not measured at 0 width
    expect(events).toHaveLength(dispatched);
    width = 100; // the reveal report flushes the deferred re-measure at the same width
    FakeResizeObserver.instances[0]?.trigger();
    expect(el.style.height).toBe(`${LINE * 5}px`);
    expect(events).toHaveLength(dispatched + 1);
  });

  it("re-measures when horizontal padding changes the content width", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const width = 100;
    const el = await mount("", {}, 0, (node) => {
      Object.defineProperty(node, "clientWidth", { configurable: true, get: () => width });
    });
    el.value = "a\nb\nc"; // silent: only the content-width change may pick it up
    mockMetrics({ paddingLeft: "20px" }); // border-box padding shift: clientWidth stays 100
    FakeResizeObserver.instances[0]?.trigger();
    expect(el.style.height).toBe(`${LINE * 3}px`);
  });

  it("re-measures when a morph strips the controller-written height", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const width = 100;
    const el = await mount("", {}, 0, (node) => {
      Object.defineProperty(node, "clientWidth", { configurable: true, get: () => width });
    });
    type(el, "a\nb\nc");
    expect(el.style.height).toBe(`${LINE * 3}px`);
    el.removeAttribute("style"); // idiomorph syncs attributes; server HTML has no style
    FakeResizeObserver.instances[0]?.trigger(); // the collapse reports a resize, same width
    expect(el.style.height).toBe(`${LINE * 3}px`);
    expect(el.style.getPropertyValue("--stimeo--textarea-rows")).toBe("3");
  });

  it("re-clamps when minRows or maxRows change at runtime", async () => {
    const el = await mount('data-stimeo--textarea-autosize-max-rows-value="3"');
    type(el, "a\nb\nc\nd\ne");
    expect(el.style.height).toBe(`${LINE * 3}px`);
    el.setAttribute("data-stimeo--textarea-autosize-max-rows-value", "2");
    await tick();
    expect(el.style.height).toBe(`${LINE * 2}px`);
    expect(el.getAttribute("data-at-max-rows")).toBe("true");
    el.setAttribute("data-stimeo--textarea-autosize-max-rows-value", "0");
    await tick();
    expect(el.style.height).toBe(`${LINE * 5}px`); // cap lifted: content height
    el.setAttribute("data-stimeo--textarea-autosize-min-rows-value", "7");
    await tick();
    expect(el.style.height).toBe(`${LINE * 7}px`); // only minRows changed in this batch
    expect(el.hasAttribute("data-at-max-rows")).toBe(false);
  });

  it("falls back to ~1.2x font-size when line-height is normal", async () => {
    const el = await mount('data-stimeo--textarea-autosize-min-rows-value="3"', {
      lineHeight: "normal",
      fontSize: "10px",
    });
    expect(el.style.height).toBe("36px"); // 3 rows x 12px fallback line
    expect(el.style.getPropertyValue("--stimeo--textarea-rows")).toBe("2"); // 20px content / 12px
  });

  it("falls back to a 16px line when neither line-height nor font-size resolve", async () => {
    const el = await mount('data-stimeo--textarea-autosize-min-rows-value="2"', {
      lineHeight: "normal",
      fontSize: "0px",
    });
    expect(el.style.height).toBe("32px"); // 2 rows x 16px constant fallback
    expect(el.style.getPropertyValue("--stimeo--textarea-rows")).toBe("1");
  });

  it("treats non-numeric computed lengths as zero", async () => {
    const el = await mount("", { paddingTop: "auto" });
    expect(el.style.height).toBe(`${LINE}px`); // not NaNpx
    expect(el.style.getPropertyValue("--stimeo--textarea-rows")).toBe("1");
  });

  it("accounts for padding and border under border-box", async () => {
    const el = await mount(
      "",
      {
        boxSizing: "border-box",
        paddingTop: "5px",
        paddingBottom: "5px",
        borderTopWidth: "1px",
        borderBottomWidth: "1px",
      },
      10, // scrollHeight includes the 10px vertical padding
    );
    type(el, "a\nb"); // content 40 + padding 10 + border 2
    expect(el.style.height).toBe("52px");
  });

  it("adds no box extra under content-box with padding and border", async () => {
    const el = await mount(
      "",
      {
        boxSizing: "content-box",
        paddingTop: "5px",
        paddingBottom: "5px",
        borderTopWidth: "1px",
        borderBottomWidth: "1px",
      },
      10, // scrollHeight includes the 10px vertical padding
    );
    type(el, "a\nb"); // content only: padding and border live outside the height
    expect(el.style.height).toBe("40px");
  });

  it("stops resizing after disconnect", async () => {
    const el = await mount();
    el.remove();
    await tick();
    const before = el.style.height;
    type(el, "a\nb\nc\nd");
    el.dispatchEvent(new Event("change", { bubbles: true }));
    expect(el.style.height).toBe(before);
  });

  it("has no a11y violations", async () => {
    vi.restoreAllMocks(); // use the real (no-op) layout for the audit
    document.body.innerHTML = `
      <label for="ta">Comment</label>
      <textarea id="ta" data-controller="stimeo--textarea-autosize"></textarea>`;
    application = Application.start();
    application.register("stimeo--textarea-autosize", TextareaAutosizeController);
    await tick();
    await expectNoA11yViolations(query("textarea"));
  });
});
