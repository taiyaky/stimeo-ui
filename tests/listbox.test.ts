import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ListboxController } from "../src/controllers/listbox_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link ListboxController}: the APG select-only listbox —
 * open/close, `aria-activedescendant` roving with focus on the trigger,
 * typeahead, single selection (`aria-selected` + trigger label + hidden field),
 * focus restoration, outside-click/Escape/Tab dismissal, and the `change` event.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const markup = `
  <div data-controller="stimeo--listbox">
    <span id="lb-label">Favorite fruit</span>
    <button type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false"
            aria-controls="lb-list" aria-activedescendant=""
            aria-labelledby="lb-label lb-value"
            data-stimeo--listbox-target="trigger"
            data-action="click->stimeo--listbox#toggle
                         keydown->stimeo--listbox#onTriggerKeydown">
      <span id="lb-value" data-stimeo--listbox-target="value">Choose…</span>
    </button>
    <ul id="lb-list" role="listbox" aria-label="Options" hidden
        data-stimeo--listbox-target="list">
      <li id="opt-1" role="option" aria-selected="false" data-value="apple"
          data-stimeo--listbox-target="option"
          data-action="click->stimeo--listbox#select">Apple</li>
      <li id="opt-2" role="option" aria-selected="false" data-value="banana"
          data-stimeo--listbox-target="option"
          data-action="click->stimeo--listbox#select">Banana</li>
      <li id="opt-3" role="option" aria-selected="false" data-value="cherry"
          data-stimeo--listbox-target="option"
          data-action="click->stimeo--listbox#select">Cherry</li>
    </ul>
    <input type="hidden" data-stimeo--listbox-target="field" />
  </div>`;

describe("ListboxController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--listbox", ListboxController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--listbox']") as HTMLElement;
  const trigger = () =>
    document.querySelector<HTMLElement>("[data-stimeo--listbox-target='trigger']") as HTMLElement;
  const valueLabel = () =>
    document.querySelector<HTMLElement>("[data-stimeo--listbox-target='value']") as HTMLElement;
  const listEl = () =>
    document.querySelector<HTMLElement>("[data-stimeo--listbox-target='list']") as HTMLElement;
  const field = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--listbox-target='field']",
    ) as HTMLInputElement;
  const options = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--listbox-target='option']"));
  const selected = () => options().map((option) => option.getAttribute("aria-selected"));
  const active = () => trigger().getAttribute("aria-activedescendant");
  const triggerKey = (key: string) =>
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

  it("starts closed", () => {
    expect(listEl().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens on a real mouse click and ignores keyboard-synthesized clicks", () => {
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    expect(listEl().hidden).toBe(true); // detail 0 == keyboard activation, ignored
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(listEl().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("opens with ArrowDown and activates the first option (focus stays on trigger)", () => {
    trigger().focus();
    triggerKey("ArrowDown");
    expect(listEl().hidden).toBe(false);
    expect(active()).toBe("opt-1");
    expect(document.activeElement).toBe(trigger());
  });

  it("moves the active option with arrows, wrapping, and Home/End", () => {
    triggerKey("ArrowDown"); // open, active opt-1
    triggerKey("ArrowDown");
    expect(active()).toBe("opt-2");
    triggerKey("ArrowUp");
    expect(active()).toBe("opt-1");
    triggerKey("ArrowUp"); // wrap to last
    expect(active()).toBe("opt-3");
    triggerKey("End");
    expect(active()).toBe("opt-3");
    triggerKey("Home");
    expect(active()).toBe("opt-1");
  });

  it("activates by typeahead and resets the buffer after a pause", () => {
    vi.useFakeTimers();
    try {
      triggerKey("ArrowDown"); // open
      triggerKey("c");
      expect(active()).toBe("opt-3"); // Cherry
      vi.advanceTimersByTime(600); // buffer resets after the typeahead timeout
      triggerKey("b");
      expect(active()).toBe("opt-2"); // a fresh "b" now matches Banana
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the typeahead buffer when closed", () => {
    triggerKey("ArrowDown"); // open
    triggerKey("c"); // buffer "c" -> Cherry
    expect(active()).toBe("opt-3");
    triggerKey("Escape"); // close resets the buffer
    triggerKey("ArrowDown"); // re-open
    triggerKey("b"); // a stale "cb" would not match; a fresh "b" reaches Banana
    expect(active()).toBe("opt-2");
  });

  it("selects the active option with Enter, syncing label, field, and aria-selected", () => {
    trigger().focus();
    triggerKey("ArrowDown"); // active opt-1
    triggerKey("ArrowDown"); // active opt-2
    triggerKey("Enter");
    expect(selected()).toEqual(["false", "true", "false"]);
    expect(valueLabel().textContent).toBe("Banana");
    expect(field().value).toBe("banana");
    expect(listEl().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("selects an option on click", () => {
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    options()[2]?.click();
    expect(selected()).toEqual(["false", "false", "true"]);
    expect(field().value).toBe("cherry");
    expect(listEl().hidden).toBe(true);
  });

  it("re-opens with the selected option active", () => {
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    options()[1]?.click(); // select Banana, closes
    triggerKey("ArrowDown"); // re-open
    expect(active()).toBe("opt-2");
  });

  it("closes on Escape and returns focus to the trigger", () => {
    trigger().focus();
    triggerKey("ArrowDown");
    triggerKey("Escape");
    expect(listEl().hidden).toBe(true);
    expect(active()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on Tab without forcing focus back", () => {
    triggerKey("ArrowDown");
    triggerKey("Tab");
    expect(listEl().hidden).toBe(true);
  });

  it("closes on an outside click", () => {
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(listEl().hidden).toBe(false);
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(listEl().hidden).toBe(true);
  });

  it("dispatches change with the value and option", () => {
    const details: Array<{ value: string }> = [];
    root().addEventListener("stimeo--listbox:change", (event) => {
      const detail = (event as CustomEvent).detail;
      details.push({ value: detail.value });
      expect(detail.option).toBe(options()[0]);
    });
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    options()[0]?.click();
    expect(details).toEqual([{ value: "apple" }]);
  });

  it("fires a native change on the field only when the value actually changes", () => {
    const changes: string[] = [];
    field().addEventListener("change", () => changes.push(field().value));

    // First selection writes the field and fires one native change.
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    options()[0]?.click();
    // Re-selecting the same option leaves the value unchanged → no extra change
    // (matching <select> semantics).
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    options()[0]?.click();

    expect(changes).toEqual(["apple"]);
  });

  it("removes aria-activedescendant when closed (never empty string)", () => {
    triggerKey("ArrowDown");
    expect(trigger().hasAttribute("aria-activedescendant")).toBe(true);
    triggerKey("Escape");
    expect(trigger().hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("releases the document outside-click listener on disconnect", () => {
    // Invoke disconnect() directly to avoid happy-dom's flaky async teardown.
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(listEl().hidden).toBe(false);
    const controller = application.getControllerForElementAndIdentifier(root(), "stimeo--listbox");
    controller?.disconnect();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(listEl().hidden).toBe(false); // a surviving listener would have closed it
  });

  it("announces the labelled combobox and its value", async () => {
    const phrases = await captureSpeech({ container: root(), steps: 2 });
    expect(phrases).toEqual([
      "Favorite fruit",
      "combobox, Favorite fruit Choose…, has popup listbox, not expanded, 1 control",
      "Choose…",
    ]);
  });

  it("has no machine-detectable a11y violations (closed and open)", async () => {
    await expectNoA11yViolations(root());
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await expectNoA11yViolations(root());
  });
});

/**
 * An empty listbox (no `option` targets) must stay inert under navigation keys:
 * opening leaves no active option and arrow/Enter never corrupt the active index
 * into NaN (`% 0`).
 */
describe("ListboxController with no options", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--listbox">
        <span id="empty-label">No options</span>
        <button type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false"
                aria-controls="empty-list" aria-labelledby="empty-label"
                data-stimeo--listbox-target="trigger"
                data-action="click->stimeo--listbox#toggle
                             keydown->stimeo--listbox#onTriggerKeydown">None</button>
        <ul id="empty-list" role="listbox" aria-label="No options" hidden
            data-stimeo--listbox-target="list"></ul>
      </div>`;
    application = Application.start();
    application.register("stimeo--listbox", ListboxController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const trigger = () =>
    document.querySelector<HTMLElement>("[data-stimeo--listbox-target='trigger']") as HTMLElement;
  const listEl = () =>
    document.querySelector<HTMLElement>("[data-stimeo--listbox-target='list']") as HTMLElement;
  const key = (k: string) =>
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  it("opens but activates nothing, and navigation keys are inert", () => {
    key("ArrowDown"); // open
    expect(listEl().hidden).toBe(false);
    expect(trigger().hasAttribute("aria-activedescendant")).toBe(false);

    key("ArrowDown"); // no options -> no-op (no NaN)
    key("End");
    key("Enter"); // nothing to commit
    expect(trigger().hasAttribute("aria-activedescendant")).toBe(false);
    expect(listEl().hidden).toBe(false);

    key("Escape"); // still closes cleanly
    expect(listEl().hidden).toBe(true);
  });
});
