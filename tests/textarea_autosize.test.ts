import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextareaAutosizeController } from "../src/controllers/textarea_autosize_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link TextareaAutosizeController}. happy-dom does not lay
 * out, so `scrollHeight` and `getComputedStyle` are mocked to deterministic line
 * metrics; the clamping math, hooks, and events are unit-tested here, and the real
 * geometry (actual growth on type) is covered by the browser e2e harness.
 */

const LINE = 20; // mocked line-height in px

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("TextareaAutosizeController", () => {
  let application: Application;

  const mockMetrics = (overrides: Record<string, string> = {}) => {
    const base = {
      lineHeight: `${LINE}px`,
      paddingTop: "0px",
      paddingBottom: "0px",
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

  const mount = async (attrs = "", metrics: Record<string, string> = {}, padding = 0) => {
    document.body.innerHTML = `<textarea data-controller="stimeo--textarea-autosize" ${attrs}></textarea>`;
    const el = query<HTMLTextAreaElement>("textarea");
    mockScrollHeight(el, padding);
    mockMetrics(metrics);
    application = Application.start();
    application.register("stimeo--textarea-autosize", TextareaAutosizeController);
    await tick();
    return el;
  };

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    application.stop();
    vi.restoreAllMocks();
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
    expect(el.style.getPropertyValue("--stimeo-textarea-rows")).toBe("3");
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

  it("stops resizing after disconnect", async () => {
    const el = await mount();
    el.remove();
    await tick();
    const before = el.style.height;
    type(el, "a\nb\nc\nd");
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
