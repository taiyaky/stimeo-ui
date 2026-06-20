import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CharacterCounterController } from "../src/controllers/character_counter_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link CharacterCounterController}: count formatting per
 * mode, the near/over state hooks, `aria-invalid`, the immediate `change` event,
 * and the debounced live-region write (driven by a mocked clock).
 */

/** Must match the controller's private announce debounce. */
const ANNOUNCE_MS = 200;

describe("CharacterCounterController", () => {
  let application: Application;

  const start = async (rootAttrs: string, fieldAttrs = "") => {
    document.body.innerHTML = `
      <div data-controller="stimeo--character-counter" ${rootAttrs}>
        <textarea data-stimeo--character-counter-target="input"
                  aria-describedby="cc" ${fieldAttrs}></textarea>
        <span id="cc" data-stimeo--character-counter-target="output"
              aria-live="polite"></span>
      </div>`;
    application = Application.start();
    application.register("stimeo--character-counter", CharacterCounterController);
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    application.stop();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--character-counter']");
  const field = () => query<HTMLTextAreaElement>("textarea");
  const output = () => query("#cc");

  /** Sets the field value and fires the `input` event the controller listens for. */
  const type = (value: string) => {
    field().value = value;
    field().dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("renders the initial remaining count synchronously on connect", async () => {
    await start('data-stimeo--character-counter-max-value="10"');
    expect(output().textContent).toBe("10");
  });

  it("writes the count to the live region only after the debounce", async () => {
    await start('data-stimeo--character-counter-max-value="10"');
    type("hello");
    // Not yet written — the debounce throttles live-region updates.
    expect(output().textContent).toBe("10");
    vi.advanceTimersByTime(ANNOUNCE_MS);
    expect(output().textContent).toBe("5");
  });

  it("dispatches change immediately with length/remaining/over", async () => {
    await start('data-stimeo--character-counter-max-value="10"');
    const events: Array<{ length: number; remaining: number | null; over: boolean }> = [];
    root().addEventListener("stimeo--character-counter:change", (e) => {
      events.push((e as CustomEvent).detail);
    });
    type("hello");
    // Fires before any timer advance.
    expect(events.at(-1)).toEqual({ length: 5, remaining: 5, over: false });
  });

  it("defers the count and change event during IME composition", async () => {
    await start('data-stimeo--character-counter-max-value="10"');
    const lengths: number[] = [];
    root().addEventListener("stimeo--character-counter:change", (e) => {
      lengths.push((e as CustomEvent).detail.length);
    });
    const f = field();
    // Typing kana: the field holds unconverted text but nothing counts yet.
    f.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    f.value = "にほんご";
    f.dispatchEvent(new Event("input", { bubbles: true }));
    expect(lengths).toEqual([]);
    expect(output().textContent).toBe("10");
    // Confirming the conversion counts the settled characters exactly once.
    f.value = "日本語";
    f.dispatchEvent(new Event("compositionend", { bubbles: true }));
    expect(lengths).toEqual([3]);
    vi.advanceTimersByTime(ANNOUNCE_MS);
    expect(output().textContent).toBe("7");
  });

  it("resets the composing flag on disconnect so a reconnect counts input", async () => {
    await start('data-stimeo--character-counter-max-value="10"');
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--character-counter",
    ) as CharacterCounterController;
    // Disconnect mid-composition (e.g. a Turbo cache restore), then reconnect the
    // same instance — a stale composing flag must not keep input suppressed.
    field().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    controller.disconnect();
    controller.connect();
    type("hello");
    vi.advanceTimersByTime(ANNOUNCE_MS);
    expect(output().textContent).toBe("5");
  });

  it("flags over-limit with a data hook and aria-invalid", async () => {
    await start('data-stimeo--character-counter-max-value="3"');
    type("hello"); // length 5 > 3
    expect(root().hasAttribute("data-over-limit")).toBe(true);
    expect(field().getAttribute("aria-invalid")).toBe("true");
    vi.advanceTimersByTime(ANNOUNCE_MS);
    expect(output().textContent).toBe("-2"); // remaining mode: 3 - 5
  });

  it("clears over-limit and aria-invalid once back within the limit", async () => {
    await start('data-stimeo--character-counter-max-value="3"');
    type("hello");
    type("ok"); // length 2 <= 3
    expect(root().hasAttribute("data-over-limit")).toBe(false);
    expect(field().hasAttribute("aria-invalid")).toBe(false);
  });

  it("preserves an authored aria-invalid while within the limit", async () => {
    await start('data-stimeo--character-counter-max-value="10"', 'aria-invalid="true"');
    type("hi"); // under the limit — never over
    // A server/Form Field validity flag must not be clobbered by the counter.
    expect(field().getAttribute("aria-invalid")).toBe("true");
  });

  it("restores the authored aria-invalid after an over-limit excursion", async () => {
    await start('data-stimeo--character-counter-max-value="3"', 'aria-invalid="false"');
    type("hello"); // over → we flag invalid
    expect(field().getAttribute("aria-invalid")).toBe("true");
    type("ok"); // back under → restore the authored value, not just remove it
    expect(field().getAttribute("aria-invalid")).toBe("false");
  });

  it("flags near-limit within the warn band, but not when over", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" data-stimeo--character-counter-warn-at-value="3"',
    );
    type("12345678"); // remaining 2 <= 3
    expect(root().hasAttribute("data-near-limit")).toBe(true);
    expect(root().hasAttribute("data-over-limit")).toBe(false);
    type("12345678901"); // length 11 → over
    expect(root().hasAttribute("data-near-limit")).toBe(false);
    expect(root().hasAttribute("data-over-limit")).toBe(true);
  });

  it("supports used and both display modes", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" data-stimeo--character-counter-mode-value="used"',
    );
    type("hello");
    vi.advanceTimersByTime(ANNOUNCE_MS);
    expect(output().textContent).toBe("5");

    root().setAttribute("data-stimeo--character-counter-mode-value", "both");
    type("hello");
    vi.advanceTimersByTime(ANNOUNCE_MS);
    expect(output().textContent).toBe("5/10");
  });

  it("shows the used count and sets no hooks when there is no max", async () => {
    await start("");
    type("hello");
    vi.advanceTimersByTime(ANNOUNCE_MS);
    expect(output().textContent).toBe("5");
    expect(root().hasAttribute("data-over-limit")).toBe(false);
    expect(field().hasAttribute("aria-invalid")).toBe(false);
  });

  it("stops the pending debounce on disconnect", async () => {
    await start('data-stimeo--character-counter-max-value="10"');
    const out = output();
    type("hello");
    root().remove(); // disconnect before the debounce fires
    await vi.advanceTimersByTimeAsync(0); // let Stimulus process the removal
    expect(() => vi.advanceTimersByTime(ANNOUNCE_MS)).not.toThrow();
    expect(out.textContent).toBe("10"); // never written
  });

  it("has no a11y violations", async () => {
    // axe schedules real microtasks/timers, so run this case on the real clock.
    vi.useRealTimers();
    document.body.innerHTML = `
      <div data-controller="stimeo--character-counter"
           data-stimeo--character-counter-max-value="10">
        <label for="msg">Message</label>
        <textarea id="msg" data-stimeo--character-counter-target="input"
                  aria-describedby="cc"></textarea>
        <span id="cc" data-stimeo--character-counter-target="output"
              aria-live="polite"></span>
      </div>`;
    application = Application.start();
    application.register("stimeo--character-counter", CharacterCounterController);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expectNoA11yViolations(root());
  });
});
