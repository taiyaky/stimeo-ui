import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComboboxController } from "../src/controllers/combobox_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link ComboboxController}: list-autocomplete filtering,
 * `aria-expanded`/`aria-activedescendant`, and arrow/Enter/Escape interaction.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ComboboxController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--combobox">
        <input type="text" role="combobox" aria-expanded="false"
               aria-autocomplete="list" aria-controls="listbox" aria-label="Fruit"
               data-stimeo--combobox-target="input"
               data-action="input->stimeo--combobox#filter keydown->stimeo--combobox#onKeydown focus->stimeo--combobox#open click->stimeo--combobox#open" />
        <ul id="listbox" role="listbox" data-stimeo--combobox-target="list" hidden>
          <li role="option" id="opt-apple" data-value="apple"
              data-stimeo--combobox-target="option"
              data-action="click->stimeo--combobox#selectByClick">Apple</li>
          <li role="option" id="opt-apricot" data-value="apricot"
              data-stimeo--combobox-target="option"
              data-action="click->stimeo--combobox#selectByClick">Apricot</li>
          <li role="option" id="opt-banana" data-value="banana"
              data-stimeo--combobox-target="option"
              data-action="click->stimeo--combobox#selectByClick">Banana</li>
        </ul>
      </div>`;
    application = Application.start();
    application.register("stimeo--combobox", ComboboxController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const input = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--combobox-target='input']",
    ) as HTMLInputElement;
  const list = () => document.getElementById("listbox") as HTMLElement;
  const option = (id: string) => document.getElementById(id) as HTMLElement;
  const type = (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const press = (key: string) =>
    input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  const clickInput = () => input().dispatchEvent(new MouseEvent("click", { bubbles: true }));

  it("starts closed", () => {
    expect(list().hidden).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens and filters options as the user types", () => {
    type("ap");
    expect(list().hidden).toBe(false);
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(option("opt-apple").hidden).toBe(false);
    expect(option("opt-apricot").hidden).toBe(false);
    expect(option("opt-banana").hidden).toBe(true);
  });

  it("tracks the active option via aria-activedescendant on ArrowDown", () => {
    type("ap");
    press("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe("opt-apple");
    expect(option("opt-apple").getAttribute("aria-selected")).toBe("true");
    press("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe("opt-apricot");
  });

  it("activates the last option on ArrowUp from the input (no active option)", () => {
    press("ArrowUp");
    expect(list().hidden).toBe(false);
    expect(input().getAttribute("aria-activedescendant")).toBe("opt-banana");
    expect(option("opt-banana").getAttribute("aria-selected")).toBe("true");
  });

  it("selects the active option on Enter and closes", () => {
    type("ap");
    press("ArrowDown");
    press("Enter");
    expect(input().value).toBe("apple");
    expect(list().hidden).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("ignores Enter fired during an IME composition", () => {
    type("ap");
    press("ArrowDown"); // active apple
    // The Enter confirming an IME candidate carries isComposing=true: it must
    // not commit the option or close the popup.
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    expect(input().value).toBe("ap");
    expect(list().hidden).toBe(false);
    // A real Enter then commits.
    press("Enter");
    expect(input().value).toBe("apple");
    expect(list().hidden).toBe(true);
  });

  it("ignores Enter with keyCode 229 (legacy IME signal)", () => {
    type("ap");
    press("ArrowDown"); // active apple
    // Browsers that omit isComposing on the confirming keydown report keyCode 229.
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }),
    );
    expect(input().value).toBe("ap");
    expect(list().hidden).toBe(false);
  });

  it("selects an option on click", () => {
    type("b");
    option("opt-banana").click();
    expect(input().value).toBe("banana");
    expect(list().hidden).toBe(true);
  });

  it("fires a native bubbling change on the input when a selection changes the value", () => {
    // form-level behaviors (validation, auto-submit) listen for native `change`;
    // it must bubble and fire only on an actual value change — but never `input`,
    // which is the filter trigger and would reopen the popup.
    const changes: Event[] = [];
    const inputs: Event[] = [];
    document.addEventListener("change", (e) => changes.push(e));
    input().addEventListener("input", (e) => inputs.push(e));

    type("b"); // one input event from typing (the filter trigger)
    expect(inputs).toHaveLength(1);

    option("opt-banana").click();
    expect(input().value).toBe("banana");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.bubbles).toBe(true);
    // Selecting did NOT synthesize an extra `input` (which would reopen/refilter).
    expect(inputs).toHaveLength(1);
  });

  it("does not fire change when the selection does not change the value", () => {
    const changes: Event[] = [];
    document.addEventListener("change", (e) => changes.push(e));

    type("apple"); // value already equals the option's value
    option("opt-apple").click();
    expect(input().value).toBe("apple");
    expect(changes).toHaveLength(0);
  });

  it("closes on Escape", () => {
    type("ap");
    press("Escape");
    expect(list().hidden).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes when Tab moves focus out", () => {
    type("ap");
    press("Tab");
    expect(list().hidden).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes when a click lands outside the combobox", () => {
    type("ap");
    expect(list().hidden).toBe(false);
    document.body.click();
    expect(list().hidden).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the popup open when clicking an option, then selects and closes", () => {
    type("ap");
    option("opt-apple").click();
    expect(input().value).toBe("apple");
    expect(list().hidden).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("re-opens on a click after a selection closed the listbox", () => {
    type("ap");
    option("opt-apple").click();
    expect(list().hidden).toBe(true);
    clickInput();
    expect(list().hidden).toBe(false);
    expect(input().getAttribute("aria-expanded")).toBe("true");
  });

  it("re-filters on open so a stale non-matching value keeps the empty state", () => {
    const root = () =>
      document.querySelector("[data-controller='stimeo--combobox']") as HTMLElement;
    input().value = "zz";
    clickInput();
    expect(list().hidden).toBe(false);
    expect(option("opt-apple").hidden).toBe(true);
    expect(root().hasAttribute("data-stimeo--combobox-empty")).toBe(true);
  });

  it("flags the empty state when no option matches the query", () => {
    const root = () =>
      document.querySelector("[data-controller='stimeo--combobox']") as HTMLElement;
    type("zz");
    expect(list().hidden).toBe(false);
    expect(root().hasAttribute("data-stimeo--combobox-empty")).toBe(true);
    type("ap");
    expect(root().hasAttribute("data-stimeo--combobox-empty")).toBe(false);
  });

  // Layer ① — machine-detectable a11y (asserted with the listbox expanded, the
  // interesting accessibility tree for this widget).
  it("has no machine-detectable a11y violations while expanded", async () => {
    const root = document.querySelector("[data-controller='stimeo--combobox']") as HTMLElement;
    type("ap");
    expect(list().hidden).toBe(false);
    // The `region` landmark rule is a page-author concern, not this headless
    // widget's; scope it out so the audit covers the combobox's own semantics.
    await expectNoA11yViolations(root, { rules: { region: { enabled: false } } });
  });

  // Layer ③ — speech-order regression. Captured before AND after moving the
  // active option: the whole ordered array pins aria-expanded, the option set,
  // and the aria-activedescendant / aria-selected flip on ArrowDown.
  it("announces the expanded listbox and the active option in order on ArrowDown", async () => {
    const root = document.querySelector("[data-controller='stimeo--combobox']") as HTMLElement;
    type("ap");

    const before = await captureSpeech({ container: root, steps: 4 });
    expect(before).toEqual([
      "combobox, Fruit, ap, has popup listbox, expanded, autocomplete in list, 1 control",
      "listbox, orientated vertically",
      "option, Apple, not selected, position 1, set size 2",
      "option, Apricot, not selected, position 2, set size 2",
      "end of listbox, orientated vertically",
    ]);

    press("ArrowDown");
    const after = await captureSpeech({ container: root, steps: 4 });
    expect(after).toEqual([
      "combobox, Fruit, ap, has popup listbox, expanded, active descendant Apple, autocomplete in list, 1 control",
      "listbox, orientated vertically",
      "option, Apple, selected, position 1, set size 2",
      "option, Apricot, not selected, position 2, set size 2",
      "end of listbox, orientated vertically",
    ]);
  });

  // Teardown regression: disconnect() must drop the document-level outside-click
  // listener. It leaves the listbox markup as-is, so a surviving listener would
  // still close the detached popup on an outside click — assert it stays open to
  // prove the listener was removed. Invoked directly to avoid happy-dom's flaky
  // async MutationObserver lifecycle (see scrollspy/resizable suites).
  it("releases the document outside-click listener on disconnect", () => {
    const root = document.querySelector("[data-controller='stimeo--combobox']") as HTMLElement;
    type("ap");
    expect(list().hidden).toBe(false);

    const controller = application.getControllerForElementAndIdentifier(root, "stimeo--combobox");
    if (!controller) throw new Error("combobox controller not found");
    controller.disconnect();

    document.body.click();
    expect(list().hidden).toBe(false);
  });

  it("jumps to the first option on Home and the last on End", () => {
    type("ap"); // Apple, Apricot visible
    press("End");
    expect(input().getAttribute("aria-activedescendant")).toBe("opt-apricot");
    press("Home");
    expect(input().getAttribute("aria-activedescendant")).toBe("opt-apple");
  });

  it("wraps the active option from last back to first on ArrowDown", () => {
    type("ap"); // Apple, Apricot
    press("ArrowDown"); // Apple
    press("ArrowDown"); // Apricot
    expect(input().getAttribute("aria-activedescendant")).toBe("opt-apricot");
    press("ArrowDown"); // wraps → Apple
    expect(input().getAttribute("aria-activedescendant")).toBe("opt-apple");
  });

  it("does not activate anything when no option matches on ArrowDown", () => {
    type("zz"); // nothing matches → empty state
    press("ArrowDown");
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("Home/End are inert while the listbox is closed", () => {
    press("Home"); // closed → no preventDefault, no activedescendant
    expect(list().hidden).toBe(true);
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("falls back to the option's text when it has no data-value", () => {
    const banana = option("opt-banana");
    banana.removeAttribute("data-value");
    type("ban");
    banana.click();
    expect(input().value).toBe("Banana"); // textContent, trimmed
  });
});
