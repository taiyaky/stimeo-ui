import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComboboxController } from "../src/controllers/combobox_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureFieldCommits } from "./helpers/field_commits";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents } from "./helpers/state_events";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ComboboxController}: list-autocomplete filtering,
 * `aria-expanded`/`aria-activedescendant`, and arrow/Enter/Escape interaction.
 */

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
              data-action="click->stimeo--combobox#select">Apple</li>
          <li role="option" id="opt-apricot" data-value="apricot"
              data-stimeo--combobox-target="option"
              data-action="click->stimeo--combobox#select">Apricot</li>
          <li role="option" id="opt-banana" data-value="banana"
              data-stimeo--combobox-target="option"
              data-action="click->stimeo--combobox#select">Banana</li>
        </ul>
      </div>`;
    application = Application.start();
    application.register("stimeo--combobox", ComboboxController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const input = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--combobox-target='input']",
    ) as HTMLInputElement;
  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--combobox']") as HTMLElement;
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--combobox",
    ) as ComboboxController;
  const list = () => document.getElementById("listbox") as HTMLElement;
  const option = (id: string) => document.getElementById(id) as HTMLElement;
  const type = (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const press = (key: string) =>
    input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  const clickInput = () => input().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  /** Runs `act`, lets Stimulus deliver the callbacks, and returns the writes to `attributes`. */
  const attributeWrites = async (element: Element, attributes: string[], act: () => void) => {
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(element, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: attributes,
    });
    act();
    await tick();
    records.push(...observer.takeRecords());
    observer.disconnect();
    return records;
  };

  it("element API reentry reports the newest native-field commit with its own reason", () => {
    const element = document.querySelector<HTMLElement>("[data-controller='stimeo--combobox']");
    if (!element) throw new Error("Missing root");
    const instance = application.getControllerForElementAndIdentifier(
      element,
      "stimeo--combobox",
    ) as ComboboxController;
    const first = instance.optionTargets[0];
    const second = instance.optionTargets[1];
    if (!first || !second) throw new Error("Missing options");
    let replaced = false;
    input().addEventListener("change", () => {
      if (replaced) return;
      replaced = true;
      instance.select(second);
    });
    const reports: CustomEvent[] = [];
    element.addEventListener("stimeo--combobox:selected", (event) =>
      reports.push(event as CustomEvent),
    );
    instance.select(first);
    expect(input().value).toBe(second.dataset.value);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.detail).toMatchObject({ value: second.dataset.value, reason: "api" });
  });

  it("rejects nested-origin action events while accepting owned descendants", async () => {
    const element = document.querySelector<HTMLElement>("[data-controller='stimeo--combobox']");
    if (!element) throw new Error("Missing controller root");
    const instance = application.getControllerForElementAndIdentifier(
      element,
      "stimeo--combobox",
    ) as ComboboxController;
    const target = element.querySelectorAll<HTMLElement>(
      "[data-stimeo--combobox-target='option']",
    )[1];
    if (!target) throw new Error("Missing target");

    const nested = document.createElement("div");
    nested.setAttribute("data-controller", "stimeo--combobox");
    const inner = target.cloneNode(true) as HTMLElement;
    inner.removeAttribute("data-action");
    nested.append(inner);
    target.append(nested);
    const reports: CustomEvent[] = [];
    element.addEventListener("stimeo--combobox:selected", (event) =>
      reports.push(event as CustomEvent),
    );
    target.addEventListener("pointerup", (event) => instance.select(event));
    inner.dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(reports).toHaveLength(0);
    nested.remove();
    const owned = document.createElement("span");
    target.append(owned);
    owned.dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.detail.reason).toBe("user");
  });

  it.each([false, true])(
    "element API focus respects an inside caller and a subscriber's handoff (handoff=%s)",
    async (handoff) => {
      const element = document.querySelector<HTMLElement>("[data-controller='stimeo--combobox']");
      if (!element) throw new Error("Missing controller root");
      const instance = application.getControllerForElementAndIdentifier(
        element,
        "stimeo--combobox",
      ) as ComboboxController;
      instance.open();
      const inside = document.createElement("button");
      element.append(inside);
      inside.focus();
      const outside = document.createElement("button");
      document.body.append(outside);
      if (handoff)
        element.addEventListener("stimeo--combobox:selected", () => outside.focus(), {
          once: true,
        });
      const target = instance.optionTargets[1];
      if (!target) throw new Error("Missing option");
      instance.select(target);
      expect(document.activeElement).toBe(handoff ? outside : input());
    },
  );

  it.each([
    ["focusin", "focus"],
    ["pointerenter", "pointer"],
  ])("preserves action event modality %s", async (type, reason) => {
    const element = document.querySelector<HTMLElement>("[data-controller='stimeo--combobox']");
    if (!element) throw new Error("Missing controller root");
    const instance = application.getControllerForElementAndIdentifier(
      element,
      "stimeo--combobox",
    ) as ComboboxController;
    const target = element.querySelectorAll<HTMLElement>(
      "[data-stimeo--combobox-target='option']",
    )[1];
    if (!target) throw new Error("Missing action target");

    const reports: CustomEvent[] = [];
    element.addEventListener("stimeo--combobox:selected", (event) =>
      reports.push(event as CustomEvent),
    );
    target.addEventListener(type, (event) => instance.select(event), { once: true });
    target.dispatchEvent(new Event(type));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.detail.reason).toBe(reason);
  });

  it.each([false, true])(
    "accepts an owned element API source (descendant=%s) without stealing outside focus",
    async (descendant) => {
      const element = document.querySelector<HTMLElement>("[data-controller='stimeo--combobox']");
      if (!element) throw new Error("Missing controller root");
      const instance = application.getControllerForElementAndIdentifier(
        element,
        "stimeo--combobox",
      ) as ComboboxController;
      const target = element.querySelectorAll<HTMLElement>(
        "[data-stimeo--combobox-target='option']",
      )[1];
      if (!target) throw new Error("Missing action target");
      const outside = document.createElement("button");
      document.body.append(outside);
      outside.focus();
      const reports: CustomEvent[] = [];
      element.addEventListener("stimeo--combobox:selected", (event) =>
        reports.push(event as CustomEvent),
      );

      const child = document.createElement("span");
      target.append(child);
      const foreign = target.cloneNode(true) as HTMLElement;
      foreign.removeAttribute("data-action");
      const nested = document.createElement("div");
      nested.setAttribute("data-controller", "stimeo--combobox");
      const nestedTarget = foreign.cloneNode(true) as HTMLElement;
      nested.append(nestedTarget);
      element.append(nested);
      const before = element.innerHTML;
      instance.select(foreign);
      document.body.append(foreign);
      instance.select(foreign);
      instance.select(nestedTarget);
      expect(element.innerHTML).toBe(before);
      expect(reports).toHaveLength(0);
      instance.select(descendant ? child : target);
      expect(input().value).toBe("apricot");
      expect(reports).toHaveLength(1);
      expect(reports[0]?.detail.reason).toBe("api");
      expect(document.activeElement).toBe(outside);
    },
  );

  it("re-filters an open popup when its input target is replaced", async () => {
    controller().open();
    const replacement = input().cloneNode(true) as HTMLInputElement;
    replacement.value = "Ban";
    input().replaceWith(replacement);
    controller().inputTargetConnected(replacement);
    await tick();
    expect(option("opt-apple").hidden).toBe(true);
    expect(option("opt-banana").hidden).toBe(false);
  });

  it("re-filters an open popup against an input that arrives after the only one left", async () => {
    controller().open();
    const original = input();
    original.remove();
    await tick();
    const arrival = original.cloneNode(true) as HTMLInputElement;
    arrival.value = "Ban";
    root().prepend(arrival);
    controller().inputTargetConnected(arrival);
    await tick();

    expect(option("opt-apple").hidden).toBe(true);
    expect(option("opt-banana").hidden).toBe(false);
  });

  it("reconciles an option that arrives after the only ones left", async () => {
    type("Ban");
    for (const id of ["opt-apple", "opt-apricot", "opt-banana"]) option(id).remove();
    await tick();
    const arrival = document.createElement("li");
    arrival.id = "opt-avocado";
    arrival.setAttribute("role", "option");
    arrival.setAttribute("aria-selected", "true");
    arrival.setAttribute("data-stimeo--combobox-target", "option");
    arrival.textContent = "Avocado";
    list().append(arrival);
    await tick();

    expect(arrival.hidden).toBe(true);
    expect(arrival.getAttribute("aria-selected")).toBe("false");
  });

  it("filters a newly added option against the open input", async () => {
    type("Ban");
    const added = option("opt-apple").cloneNode(true) as HTMLElement;
    added.id = "opt-new";
    added.hidden = false;
    list().append(added);
    controller().optionTargetConnected(added);
    await tick();
    expect(added.hidden).toBe(true);
  });

  it("uses an authored active descendant as the starting option for navigation", () => {
    controller().open();
    input().setAttribute("aria-activedescendant", "opt-apricot");
    press("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe("opt-banana");
  });

  it("keeps navigation safe after the input leaves an open popup", () => {
    controller().open();
    input().remove();
    expect(() =>
      controller().onKeydown(new KeyboardEvent("keydown", { key: "ArrowDown" })),
    ).not.toThrow();
    expect(option("opt-apple").getAttribute("aria-selected")).toBe("true");
  });

  it("omits a selection superseded by a native change listener", () => {
    const values: string[] = [];
    root().addEventListener("stimeo--combobox:selected", (event) =>
      values.push((event as CustomEvent).detail.value),
    );
    let replaced = false;
    input().addEventListener(
      "change",
      () => {
        if (replaced) return;
        replaced = true;
        option("opt-banana").click();
      },
      { once: true },
    );
    option("opt-apple").click();
    expect(values).toEqual(["banana"]);
    expect(input().value).toBe("banana");
  });

  it.each(["", "apple"])("omits a selection superseded while returning focus (%s)", (initial) => {
    input().value = initial;
    const values: string[] = [];
    const native: string[] = [];
    input().addEventListener("change", () => native.push(input().value));
    root().addEventListener("stimeo--combobox:selected", (event) =>
      values.push((event as CustomEvent).detail.value),
    );
    input().addEventListener("focus", () => option("opt-banana").click(), { once: true });
    option("opt-apple").click();
    expect(values).toEqual(["banana"]);
    expect(native).toEqual(["banana"]);
    expect(input().value).toBe("banana");
  });

  it("keeps selection reports for readers and unchanged reentrant selections", () => {
    const values: string[] = [];
    root().addEventListener("stimeo--combobox:selected", (event) =>
      values.push((event as CustomEvent).detail.value),
    );
    input().addEventListener(
      "change",
      () => {
        expect(input().value).toBe("apple");
        option("opt-apple").click();
      },
      { once: true },
    );
    option("opt-apple").click();
    expect(values).toEqual(["apple", "apple"]);
  });

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

  it("follows the active option by scrolling the LIST only", () => {
    // happy-dom has no layout: the rect/size INPUTS of the scroll math are
    // modeled here (an 80px viewport over the options); real geometry needs a
    // real browser.
    type("a"); // all three options match and the list opens
    Object.defineProperties(list(), {
      scrollHeight: { value: 200, configurable: true },
      clientHeight: { value: 80, configurable: true },
    });
    vi.spyOn(list(), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 80));
    vi.spyOn(option("opt-banana"), "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 100, 100, 40),
    );
    press("ArrowDown"); // Apple (zero-rect mock -> visible, no scroll)
    press("ArrowDown"); // Apricot
    expect(list().scrollTop).toBe(0);
    press("ArrowDown"); // Banana: bottom 140 > list bottom 80 -> +60
    expect(list().scrollTop).toBe(60);
    vi.spyOn(option("opt-apple"), "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, -40, 100, 40),
    );
    press("ArrowDown"); // wraps to Apple: top -40 < 0 -> back up by 40
    expect(list().scrollTop).toBe(20);
  });

  it("tracks the active option via aria-activedescendant on ArrowDown", () => {
    type("ap");
    press("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe("opt-apple");
    expect(option("opt-apple").getAttribute("aria-selected")).toBe("true");
    press("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe("opt-apricot");
  });

  it("shows the popup on Alt+ArrowDown without moving into it", () => {
    // The one chord this pattern claims: the list appears but no option becomes
    // active, so the next bare ArrowDown starts from the top.
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    input().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(list().hidden).toBe(false);
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("closes the popup and keeps focus on Alt+ArrowUp", () => {
    input().focus();
    press("ArrowDown"); // open with an active option
    expect(list().hidden).toBe(false);

    const event = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    input().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(list().hidden).toBe(true);
    expect(document.activeElement).toBe(input());
  });

  it("leaves Alt+ArrowUp to the browser while the popup is closed", () => {
    // The pattern binds Alt+Up only while the popup is displayed. With it down
    // there is nothing to close, so the press is not the widget's to swallow.
    expect(list().hidden).toBe(true);
    const event = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    input().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(list().hidden).toBe(true);
  });

  it("leaves Alt+ArrowDown to the browser while the popup is open", () => {
    // Symmetrically, Alt+Down is bound only while the popup is not displayed.
    press("ArrowDown");
    expect(list().hidden).toBe(false);
    const active = input().getAttribute("aria-activedescendant");

    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    input().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(list().hidden).toBe(false);
    expect(input().getAttribute("aria-activedescendant")).toBe(active);
  });

  it("leaves a ctrl-modified arrow to the browser", () => {
    // A bare arrow belongs to the combobox; a chorded one does not. Alt is the
    // only modifier this pattern claims (Alt+Down/Up open and close the popup),
    // so Ctrl passes straight through: the popup stays down, no option becomes
    // active, and the press reaches the browser uncanceled.
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    input().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(list().hidden).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
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

  it("defers filtering until compositionend and ignores its unflagged Enter", () => {
    type("ap");
    press("ArrowDown"); // active apple

    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input().value = "b";
    input().dispatchEvent(new InputEvent("input", { bubbles: true }));

    // Some browsers omit isComposing on the confirming keydown. The controller's
    // lifecycle state must still protect Enter and defer intermediate filtering.
    press("Enter");
    expect(input().value).toBe("b");
    expect(list().hidden).toBe(false);
    expect(option("opt-apple").hidden).toBe(false);
    expect(option("opt-apricot").hidden).toBe(false);
    expect(option("opt-banana").hidden).toBe(true);

    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(option("opt-apple").hidden).toBe(true);
    expect(option("opt-apricot").hidden).toBe(true);
    expect(option("opt-banana").hidden).toBe(false);

    press("ArrowDown");
    press("Enter");
    expect(input().value).toBe("banana");
    expect(list().hidden).toBe(true);
  });

  it("clears composition state across disconnect and reconnect", () => {
    type("ap");
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));

    controller().disconnect();
    controller().connect();
    press("ArrowDown");

    expect(input().getAttribute("aria-activedescendant")).toBe("opt-apple");
    press("Enter");
    expect(input().value).toBe("apple");
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

  it("leaves Escape unconsumed while the list is closed", () => {
    // With nothing to close the widget owns no dismissable state, so the press
    // stays free for the shared Escape resolver (an enclosing dialog etc.).
    expect(list().hidden).toBe(true);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    input().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
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

  // Machine-detectable a11y, asserted with the listbox expanded — the
  // interesting accessibility tree for this widget.
  it("has no machine-detectable a11y violations while expanded", async () => {
    const root = document.querySelector("[data-controller='stimeo--combobox']") as HTMLElement;
    type("ap");
    expect(list().hidden).toBe(false);
    // The `region` landmark rule is a page-author concern, not this headless
    // widget's; scope it out so the audit covers the combobox's own semantics.
    await expectNoA11yViolations(root, { rules: { region: { enabled: false } } });
  });

  // Speech-order regression. Captured before AND after moving the active option:
  // the whole ordered array pins aria-expanded, the option set, and the
  // aria-activedescendant / aria-selected flip on ArrowDown.
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
  // async MutationObserver lifecycle.
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

  it("moves the active option backwards on ArrowUp from an active option", () => {
    // The wrapping *backwards* branch, distinct from the "from the input" case
    // above: ArrowUp on the first visible option loops to the last.
    type("ap"); // Apple, Apricot
    input().focus();
    press("ArrowDown"); // Apple
    press("ArrowDown"); // Apricot
    expect(input().getAttribute("aria-activedescendant")).toBe("opt-apricot");
    press("ArrowUp");
    expect(input().getAttribute("aria-activedescendant")).toBe("opt-apple");
    press("ArrowUp"); // wraps backwards to the last visible option
    expect(input().getAttribute("aria-activedescendant")).toBe("opt-apricot");
  });

  it("re-observes IME composition on the input after a disconnect/connect cycle", () => {
    // The sibling case above only proves composition state is *cleared*; this one
    // pins that connect() re-attaches the composition listeners. Without them a
    // browser that omits isComposing on the confirming keydown commits an option
    // mid-conversion.
    controller().disconnect();
    controller().connect();

    type("ap");
    input().focus();
    press("ArrowDown"); // active apple
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));

    press("Enter"); // no isComposing flag: only the lifecycle state can protect it
    expect(input().value).toBe("ap");
    expect(list().hidden).toBe(false);
  });

  it("ignores a keydown an outer handler already consumed", () => {
    // A composite widget yields a key a descendant or an enclosing widget
    // already claimed instead of ALSO acting on it.
    type("ap");
    const claim = (event: Event) => event.preventDefault();
    document.addEventListener("keydown", claim, true);
    try {
      input().focus();
      input().dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
    } finally {
      document.removeEventListener("keydown", claim, true);
    }
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("stays open when a click inside the combobox detaches its own target node", () => {
    // The outside-click listener runs in the capture phase. On bubble the clicked
    // node is already detached by the time the document listener runs, so
    // contains() reports an INSIDE click as outside and closes the popup.
    type("ap");
    const inner = document.createElement("button");
    inner.type = "button";
    inner.addEventListener("click", () => inner.remove());
    root().appendChild(inner);

    inner.click();
    expect(list().hidden).toBe(false);
  });

  it("closes the previous instance when another combobox's input is clicked", async () => {
    // The other side of that capture phase: the document listener runs before the
    // clicked trigger's own handler, so the hand-off must still work.
    type("ap");
    expect(list().hidden).toBe(false);

    const second = document.createElement("div");
    second.setAttribute("data-controller", "stimeo--combobox");
    second.innerHTML = `
      <input type="text" role="combobox" aria-expanded="false" aria-label="Second"
             data-stimeo--combobox-target="input"
             data-action="input->stimeo--combobox#filter click->stimeo--combobox#open" />
      <ul id="listbox-2" role="listbox" data-stimeo--combobox-target="list" hidden>
        <li role="option" id="opt-2-apple" data-value="apple"
            data-stimeo--combobox-target="option"
            data-action="click->stimeo--combobox#select">Apple</li>
      </ul>`;
    document.body.appendChild(second);
    await tick();

    const secondInput = second.querySelector("input") as HTMLInputElement;
    secondInput.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(list().hidden).toBe(true);
    expect((document.getElementById("listbox-2") as HTMLElement).hidden).toBe(false);
  });

  it("writes aria-selected only where it changes", () => {
    // `#setActive` runs on every keystroke and every arrow repeat, and at most
    // two options differ. Writing all of them costs one attribute mutation per
    // option per press, and the option count is authored (unbounded) — so the
    // write has to be conditional, and only a test that counts writes says so.
    type("a"); // all three options visible
    input().focus();
    press("ArrowDown"); // Apple active — every option now holds a value

    const writes: string[] = [];
    const realSet = HTMLElement.prototype.setAttribute;
    // Patching the prototype leaks into every later test in this file (vitest is
    // not configured with `restoreMocks`), so restore it in `finally`.
    const spy = vi.spyOn(HTMLElement.prototype, "setAttribute").mockImplementation(function (
      this: HTMLElement,
      name: string,
      value: string,
    ) {
      if (name === "aria-selected") writes.push(`${this.id}=${value}`);
      return realSet.call(this, name, value);
    });
    try {
      press("ArrowDown"); // Apple → Apricot: exactly two options change
    } finally {
      spy.mockRestore();
    }

    expect(HTMLElement.prototype.setAttribute).toBe(realSet);
    expect(writes).toEqual(["opt-apple=false", "opt-apricot=true"]);
    // …and the resulting state is still exhaustive across every option.
    expect(
      Array.from(document.querySelectorAll("[role='option']"), (o) =>
        o.getAttribute("aria-selected"),
      ),
    ).toEqual(["false", "true", "false"]);
  });

  it("dispatches stimeo--combobox:selected carrying the committed value", () => {
    // Committing an option is a public event carrying the committed value.
    const details: unknown[] = [];
    root().addEventListener("stimeo--combobox:selected", (event) => {
      details.push((event as CustomEvent).detail);
    });

    type("ap");
    input().focus();
    press("ArrowDown");
    press("Enter");

    expect(input().value).toBe("apple");
    expect(details).toEqual([{ value: "apple", reason: "user" }]);
  });

  it("no-ops instead of throwing when the list target is absent", () => {
    // The controller declares this tolerance in three places (open / close /
    // #isClosed), and each one has to hold on its own: an unguarded dereference
    // in any of them throws out of the caller. Here the missing target is the
    // list; the case below covers the missing input.
    type("ap");
    list().remove();

    expect(() => controller().close()).not.toThrow();
    expect(() => controller().open()).not.toThrow();
  });

  it("still closes the listbox on an outside click after the input target is removed", () => {
    // The missing-input guard covers only the ARIA half of `close()`: with the
    // input gone the widget cannot update ARIA, but the popup itself must still
    // come down — guarding the *whole* of `close()` would leave a detached
    // listbox floating over the page for the rest of the session.
    type("ap");
    expect(list().hidden).toBe(false);

    input().remove();
    document.body.click();

    expect(list().hidden).toBe(true);
    expect(root().hasAttribute("data-stimeo--combobox-empty")).toBe(false);
  });

  it("still commits a clicked option after the input target is removed", () => {
    // Selection is reachable in the same degraded state the close guard exists
    // for: the popup is open, the input is gone, and the options stay clickable.
    // The commit must come down and still report the choice instead of throwing.
    type("ap");
    expect(list().hidden).toBe(false);
    const selected: string[] = [];
    root().addEventListener("stimeo--combobox:selected", (event) => {
      selected.push((event as CustomEvent<{ value: string }>).detail.value);
    });

    input().remove();
    expect(() =>
      option("opt-apricot").dispatchEvent(new MouseEvent("click", { bubbles: true })),
    ).not.toThrow();

    expect(list().hidden).toBe(true);
    expect(selected).toEqual(["apricot"]);
  });

  it("registers the outside-click listener when the input arrives after connect", async () => {
    // `inputTargetConnected`'s TSDoc promises an input "added initially or after
    // connect", and connect() guards `hasInputTarget` for exactly that case. Any
    // unguarded `inputTarget` dereference on the connect path throws before
    // addEventListener runs, leaving the popup undismissable by an outside click.
    const late = document.createElement("div");
    late.setAttribute("data-controller", "stimeo--combobox");
    late.innerHTML = `
      <ul id="listbox-late" role="listbox" data-stimeo--combobox-target="list" hidden>
        <li role="option" id="opt-late-apple" data-value="apple"
            data-stimeo--combobox-target="option"
            data-action="click->stimeo--combobox#select">Apple</li>
      </ul>`;
    document.body.appendChild(late);
    await tick();

    const lateInput = document.createElement("input");
    lateInput.type = "text";
    lateInput.setAttribute("role", "combobox");
    lateInput.setAttribute("aria-expanded", "false");
    lateInput.setAttribute("aria-label", "Late");
    lateInput.setAttribute("data-stimeo--combobox-target", "input");
    lateInput.setAttribute("data-action", "input->stimeo--combobox#filter");
    late.insertBefore(lateInput, late.firstChild);
    await tick();

    const lateList = document.getElementById("listbox-late") as HTMLElement;
    lateInput.value = "ap";
    lateInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(lateList.hidden).toBe(false);

    document.body.click();
    expect(lateList.hidden).toBe(true);
  });

  it("closes a popup a restored snapshot left open when it connects", async () => {
    const restored = document.createElement("div");
    restored.setAttribute("data-controller", "stimeo--combobox");
    restored.innerHTML = `
      <input type="text" role="combobox" aria-expanded="true" aria-label="Restored"
             aria-autocomplete="list" aria-controls="listbox-restored"
             aria-activedescendant="opt-restored-kiwi"
             data-stimeo--combobox-target="input" />
      <ul id="listbox-restored" role="listbox" data-stimeo--combobox-target="list">
        <li role="option" id="opt-restored-kiwi" aria-selected="true" data-value="kiwi"
            data-stimeo--combobox-target="option">Kiwi</li>
      </ul>`;
    document.body.appendChild(restored);
    await tick();

    const restoredInput = restored.querySelector("input") as HTMLInputElement;
    expect((restored.querySelector("ul") as HTMLElement).hidden).toBe(true);
    expect(restoredInput.getAttribute("aria-expanded")).toBe("false");
    expect(restoredInput.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("runs no option reconciliation still pending when it disconnects", async () => {
    type("Ban");
    const added = option("opt-apple").cloneNode(true) as HTMLElement;
    added.id = "opt-new";
    added.hidden = false;
    list().append(added);
    controller().optionTargetConnected(added);

    controller().disconnect();
    await tick();

    expect(added.hidden).toBe(false);
  });

  it("tracks IME composition on an input that replaces the original after connect", () => {
    const replacement = input().cloneNode(true) as HTMLInputElement;
    input().replaceWith(replacement);
    controller().inputTargetConnected(replacement);
    replacement.value = "ap";
    controller().open();
    controller().onKeydown(new KeyboardEvent("keydown", { key: "ArrowDown" }));

    replacement.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    controller().onKeydown(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(replacement.value).toBe("ap");
    expect(list().hidden).toBe(false);
  });

  it("lets a replacement input commit after the original leaves mid-composition", () => {
    const original = input();
    original.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const replacement = original.cloneNode(true) as HTMLInputElement;
    original.replaceWith(replacement);
    controller().inputTargetDisconnected(original);
    controller().inputTargetConnected(replacement);

    replacement.value = "ap";
    controller().open();
    controller().onKeydown(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    controller().onKeydown(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(replacement.value).toBe("apple");
  });

  it("marks an option added to the open popup as not active", async () => {
    type("a");
    press("ArrowDown"); // Apple active
    const late = document.createElement("li");
    late.id = "opt-late";
    late.setAttribute("role", "option");
    late.dataset.value = "avocado";
    late.setAttribute("data-stimeo--combobox-target", "option");
    late.textContent = "Avocado";
    list().append(late);
    controller().optionTargetConnected(late);
    await tick();

    expect(
      Array.from(root().querySelectorAll('[role="option"]'), (candidate) =>
        candidate.getAttribute("aria-selected"),
      ),
    ).toEqual(["true", "false", "false", "false"]);
  });

  it("drops the active option when typing filters it out", () => {
    type("a");
    press("ArrowDown"); // Apple active
    type("b");

    expect(option("opt-apple").hidden).toBe(true);
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
    expect(option("opt-apple").getAttribute("aria-selected")).toBe("false");
  });

  it.each(["Escape", "Enter"])("leaves no active option behind when %s closes the popup", (key) => {
    type("a");
    press("ArrowDown"); // Apple active
    press(key);

    expect(list().hidden).toBe(true);
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
    expect(root().querySelectorAll('[role="option"][aria-selected="true"]')).toHaveLength(0);
  });

  it.each(["ArrowDown", "ArrowUp", "Home", "End", "Enter"])(
    "consumes %s when it acts on the open popup",
    (key) => {
      type("a");
      press("ArrowDown"); // Apple active
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      input().dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
    },
  );

  it("drops an active descendant a replacement input brings to the closed popup", async () => {
    const replacement = input().cloneNode(true) as HTMLInputElement;
    replacement.setAttribute("aria-activedescendant", "opt-apple");
    input().replaceWith(replacement);
    controller().inputTargetConnected(replacement);
    await tick();

    expect(list().hidden).toBe(true);
    expect(replacement.hasAttribute("aria-activedescendant")).toBe(false);
  });

  describe("an input that stays after an earlier one leaves", () => {
    /** Opens the popup with Apple active and inserts a stale copy of the input after it. */
    const insertSuccessor = async (): Promise<[HTMLInputElement, HTMLInputElement]> => {
      controller().open();
      press("ArrowDown"); // Apple active
      const original = input();
      const successor = original.cloneNode(true) as HTMLInputElement;
      successor.setAttribute("aria-expanded", "false");
      successor.removeAttribute("aria-activedescendant");
      original.after(successor);
      await tick();
      return [original, successor];
    };

    it("reflects the open popup into the input that stays", async () => {
      const [original, successor] = await insertSuccessor();
      original.remove();
      await tick();

      expect(input()).toBe(successor);
      expect(list().hidden).toBe(false);
      expect(successor.getAttribute("aria-expanded")).toBe("true");
    });

    it("reflects the open popup into a replacement delivered in one task", async () => {
      controller().open();
      const replacement = input().cloneNode(true) as HTMLInputElement;
      replacement.setAttribute("aria-expanded", "false");
      input().replaceWith(replacement);
      await tick();

      expect(input()).toBe(replacement);
      expect(replacement.getAttribute("aria-expanded")).toBe("true");
    });

    it.each([
      ["authors it", 'aria-expanded="true"'],
      ["omits it", ""],
    ])("writes aria-expanded once at connect when the markup %s", async (_label, attribute) => {
      const late = document.createElement("div");
      late.setAttribute("data-controller", "stimeo--combobox");
      late.innerHTML = `
        <input type="text" role="combobox" ${attribute} aria-label="Late"
               data-stimeo--combobox-target="input" />
        <ul role="listbox" data-stimeo--combobox-target="list">
          <li role="option" id="opt-late-kiwi" data-stimeo--combobox-target="option">Kiwi</li>
        </ul>`;
      const lateInput = late.querySelector("input") as HTMLInputElement;
      const writes: Array<string | null> = [];
      const observer = new MutationObserver((records) => {
        for (const _record of records) writes.push(lateInput.getAttribute("aria-expanded"));
      });
      observer.observe(lateInput, { attributes: true, attributeFilter: ["aria-expanded"] });
      document.body.appendChild(late);
      await tick();
      await tick();
      observer.disconnect();

      expect(writes).toEqual(["false"]);
    });

    it("points the input that stays at the active option", async () => {
      const [original, successor] = await insertSuccessor();
      original.remove();
      await tick();

      expect(input()).toBe(successor);
      expect(successor.getAttribute("aria-activedescendant")).toBe("opt-apple");
      expect(option("opt-apple").getAttribute("aria-selected")).toBe("true");
    });

    it("reports nothing while it synchronizes the input that stays", async () => {
      const [original] = await insertSuccessor();
      const events = captureStateEvents("stimeo--combobox", ["selected"]);
      const commits = captureFieldCommits();
      original.remove();
      await tick();

      expect(events.names()).toEqual([]);
      expect(commits.seen).toEqual([]);
      events.stop();
      commits.stop();
    });

    it("tolerates the removal of the only input", async () => {
      controller().open();
      const only = input();
      only.remove();

      // Drive the callback directly: happy-dom delivers target callbacks unreliably.
      expect(() => controller().inputTargetDisconnected(only)).not.toThrow();
      await tick();
      expect(list().hidden).toBe(false);
    });

    it("writes nothing into the input that stays once it has disconnected", async () => {
      const [original, successor] = await insertSuccessor();
      const instance = controller();
      instance.disconnect();
      original.remove();
      instance.inputTargetDisconnected(original);
      await tick();

      expect(successor.hasAttribute("aria-activedescendant")).toBe(false);
    });

    it("gives the authored ARIA back to an input that stops being the input", async () => {
      controller().open();
      press("ArrowDown");
      const former = input();
      expect(former.getAttribute("aria-activedescendant")).toBe("opt-apple");

      // The element stays; only the attribute naming it the input goes.
      former.removeAttribute("data-stimeo--combobox-target");
      await tick();

      expect(former.getAttribute("aria-expanded")).toBe("false");
      expect(former.hasAttribute("aria-activedescendant")).toBe(false);
    });

    it("gives the input back its own ARIA when the combobox loses its controller", async () => {
      controller().open();
      press("ArrowDown");
      const departed = input();

      root().removeAttribute("data-controller");
      await tick();

      expect(departed.getAttribute("aria-expanded")).toBe("false");
      expect(departed.hasAttribute("aria-activedescendant")).toBe(false);
    });

    it("keeps what it wrote on an input that moves within the combobox", async () => {
      controller().open();
      press("ArrowDown");
      const moving = input();

      const writes = await attributeWrites(moving, ["aria-expanded", "aria-activedescendant"], () =>
        root().append(moving),
      );

      expect(moving.getAttribute("aria-expanded")).toBe("true");
      expect(moving.getAttribute("aria-activedescendant")).toBe("opt-apple");
      // A write that replaced a value other than the final one means the input was
      // handed back on the way; a rewrite of the same value does not.
      const transient = writes.filter(
        (write) => write.oldValue !== moving.getAttribute(write.attributeName ?? ""),
      );
      expect(transient.map((write) => write.attributeName)).toEqual([]);
    });

    it("keeps what it wrote on the input and list when the whole combobox leaves the page", async () => {
      controller().open();
      press("ArrowDown");
      const keptInput = input();
      const keptList = list();

      root().remove();
      await tick();

      expect(keptInput.getAttribute("aria-expanded")).toBe("true");
      expect(keptInput.getAttribute("aria-activedescendant")).toBe("opt-apple");
      expect(keptList.hidden).toBe(false);
    });
  });

  describe("a list that replaces the current one", () => {
    /** A server-rendered copy of the list with `hidden` as given. */
    const listCopy = (hidden: boolean): HTMLElement => {
      const copy = list().cloneNode(true) as HTMLElement;
      copy.hidden = hidden;
      return copy;
    };

    it("keeps the popup open on a replacement delivered in one task", async () => {
      controller().open();
      const successor = listCopy(true);
      list().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(false);
      expect(input().getAttribute("aria-expanded")).toBe("true");
    });

    it("keeps the popup open on the list that stays after an earlier one leaves", async () => {
      controller().open();
      const original = list();
      const successor = listCopy(true);
      original.after(successor);
      await tick();
      original.remove();
      await tick();

      expect(successor.hidden).toBe(false);
      expect(input().getAttribute("aria-expanded")).toBe("true");
    });

    it("keeps the popup closed on a replacement authored open", async () => {
      const successor = listCopy(false);
      list().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(true);
      expect(input().getAttribute("aria-expanded")).toBe("false");
    });

    it("closes the popup when the only list leaves, and a later list arrives closed", async () => {
      controller().open();
      const arrival = listCopy(false);
      list().remove();
      await tick();
      expect(input().getAttribute("aria-expanded")).toBe("false");

      root().append(arrival);
      await tick();
      expect(arrival.hidden).toBe(true);
    });

    it("hides a list left in the page without its target token", async () => {
      controller().open();
      const original = list();
      const successor = listCopy(true);
      original.after(successor);
      await tick();
      original.removeAttribute("data-stimeo--combobox-target");
      await tick();

      expect(original.hidden).toBe(true);
      expect(successor.hidden).toBe(false);
    });

    it("closes the popup when the only list loses its target token", async () => {
      controller().open();
      list().removeAttribute("data-stimeo--combobox-target");
      await tick();

      expect(input().getAttribute("aria-expanded")).toBe("false");
      expect(list().hidden).toBe(true);
    });

    it("keeps a hidden value the page wrote on a list that stops being the target", async () => {
      controller().open();
      const original = list();
      original.setAttribute("hidden", "until-found");
      original.removeAttribute("data-stimeo--combobox-target");
      await tick();

      expect(original.getAttribute("hidden")).toBe("until-found");
    });

    it("gives the list back its own hidden when the combobox loses its controller", async () => {
      controller().open();
      const departed = list();

      root().removeAttribute("data-controller");
      await tick();

      expect(departed.hidden).toBe(true);
    });

    it("keeps the open state on a list that moves within the combobox", async () => {
      controller().open();
      const moving = list();

      const writes = await attributeWrites(moving, ["hidden"], () => root().prepend(moving));

      expect(moving.hidden).toBe(false);
      expect(writes.map((write) => write.attributeName)).toEqual([]);
    });

    it("writes nothing into the input when a list arrives behind the current one", async () => {
      controller().open();
      const writes: MutationRecord[] = [];
      const observer = new MutationObserver((records) => writes.push(...records));
      observer.observe(input(), { attributes: true });
      const behind = document.createElement("ul");
      behind.setAttribute("role", "listbox");
      behind.setAttribute("data-stimeo--combobox-target", "list");
      behind.hidden = true;
      list().after(behind);
      await tick();
      observer.disconnect();

      expect(writes).toEqual([]);
      expect(behind.hidden).toBe(true);
    });

    it("writes nothing into the widget when a list arrives behind the open one", async () => {
      // A filter is in force, so a pass that ran anyway would write the filtered
      // option's `hidden` again, which queues a record even when the value is the same.
      type("ap");
      expect(option("opt-banana").hidden).toBe(true);
      const behind = document.createElement("ul");
      behind.setAttribute("role", "listbox");
      behind.setAttribute("data-stimeo--combobox-target", "list");
      behind.hidden = true;
      const writes: MutationRecord[] = [];
      const observer = new MutationObserver((records) => writes.push(...records));
      observer.observe(root(), { attributes: true, subtree: true });

      list().after(behind);
      await tick();
      writes.push(...observer.takeRecords());
      observer.disconnect();

      expect(writes.map((write) => write.attributeName)).toEqual([]);
    });

    it("reports nothing while it moves the open state", async () => {
      controller().open();
      const events = captureStateEvents("stimeo--combobox", ["selected"]);
      const commits = captureFieldCommits();
      list().replaceWith(listCopy(true));
      await tick();

      expect(events.names()).toEqual([]);
      expect(commits.seen).toEqual([]);
      events.stop();
      commits.stop();
    });

    it("tolerates the removal of the only list", () => {
      controller().open();
      const only = list();
      only.remove();

      expect(() => controller().listTargetDisconnected(only)).not.toThrow();
    });

    it("moves nothing once it has disconnected", async () => {
      controller().open();
      const original = list();
      const successor = listCopy(true);
      original.after(successor);
      await tick();
      const instance = controller();
      instance.disconnect();
      original.remove();
      instance.listTargetDisconnected(original);

      expect(successor.hidden).toBe(true);
    });
  });

  describe("runtime option removal reconciliation", () => {
    const activeOptionIds = () =>
      Array.from(
        root().querySelectorAll<HTMLElement>('[role="option"][aria-selected="true"]'),
        (candidate) => candidate.id,
      );
    const activateApricot = () => {
      type("a");
      press("ArrowDown");
      press("ArrowDown");
      expect(input().getAttribute("aria-activedescendant")).toBe("opt-apricot");
    };

    it("keeps the same active option when a preceding option is removed", async () => {
      activateApricot();

      option("opt-apple").remove();
      await tick();

      expect(input().getAttribute("aria-activedescendant")).toBe("opt-apricot");
      expect(activeOptionIds()).toEqual(["opt-apricot"]);

      press("Enter");
      expect(input().value).toBe("apricot");
    });

    it("clears active state when the active target token is removed", async () => {
      activateApricot();
      const removedActive = option("opt-apricot");
      const selections: unknown[] = [];
      root().addEventListener("stimeo--combobox:selected", (event) => selections.push(event));

      removedActive.removeAttribute("data-stimeo--combobox-target");
      await tick();

      expect(input().hasAttribute("aria-activedescendant")).toBe(false);
      expect(activeOptionIds()).toEqual([]);
      expect(removedActive.getAttribute("aria-selected")).toBe("false");

      press("Enter");
      expect(selections).toEqual([]);
      expect(input().value).toBe("a");
      expect(list().hidden).toBe(false);
    });

    it("ignores a click from an option after its target token is removed", async () => {
      type("a");
      const removed = option("opt-apple");
      const selections: unknown[] = [];
      root().addEventListener("stimeo--combobox:selected", (event) => selections.push(event));

      removed.removeAttribute("data-stimeo--combobox-target");
      await tick();
      removed.click();

      expect(selections).toEqual([]);
      expect(input().value).toBe("a");
      expect(list().hidden).toBe(false);
    });

    it("transfers active identity and commit ownership to a same-id replacement", async () => {
      activateApricot();
      const original = option("opt-apricot");
      const replacement = document.createElement("li");
      replacement.id = original.id;
      replacement.setAttribute("role", "option");
      replacement.dataset.value = "apricot-next";
      replacement.setAttribute("data-stimeo--combobox-target", "option");
      replacement.setAttribute("data-action", "click->stimeo--combobox#select");
      replacement.textContent = "Apricot Next";

      original.replaceWith(replacement);
      await tick();

      expect(input().getAttribute("aria-activedescendant")).toBe("opt-apricot");
      expect(activeOptionIds()).toEqual(["opt-apricot"]);
      expect(replacement.getAttribute("aria-selected")).toBe("true");
      expect(original.getAttribute("aria-selected")).toBe("false");

      press("Enter");
      expect(input().value).toBe("apricot-next");
    });

    it("does not adopt active ARIA from a different-id replacement", () => {
      activateApricot();
      const original = option("opt-apricot");
      const replacement = document.createElement("li");
      replacement.id = "opt-replacement";
      replacement.setAttribute("role", "option");
      replacement.setAttribute("aria-selected", "true");
      replacement.dataset.value = "replacement";
      replacement.setAttribute("data-stimeo--combobox-target", "option");
      replacement.setAttribute("data-action", "click->stimeo--combobox#select");
      replacement.textContent = "Replacement";
      const selections: unknown[] = [];
      root().addEventListener("stimeo--combobox:selected", (event) => selections.push(event));

      original.replaceWith(replacement);
      press("Enter");

      expect(selections).toEqual([]);
      expect(input().value).toBe("a");
      expect(input().hasAttribute("aria-activedescendant")).toBe(false);
    });

    it("clears IDREF and exposes the empty state after the last option is removed", async () => {
      option("opt-apple").remove();
      option("opt-apricot").remove();
      await tick();
      type("ban");
      press("ArrowDown");
      const last = option("opt-banana");
      const selections: unknown[] = [];
      root().addEventListener("stimeo--combobox:selected", (event) => selections.push(event));
      expect(input().getAttribute("aria-activedescendant")).toBe("opt-banana");

      last.remove();
      await tick();

      expect(input().hasAttribute("aria-activedescendant")).toBe(false);
      expect(activeOptionIds()).toEqual([]);
      expect(last.getAttribute("aria-selected")).toBe("false");
      expect(root().hasAttribute("data-stimeo--combobox-empty")).toBe(true);

      press("Enter");
      expect(selections).toEqual([]);
      expect(input().value).toBe("ban");
      expect(list().hidden).toBe(false);
    });

    it("does not commit a shifted option synchronously before target callbacks run", () => {
      activateApricot();

      option("opt-apple").remove();
      press("Enter");

      expect(input().value).toBe("apricot");
    });
  });

  describe("an option added before the active one", () => {
    it("keeps the active identity, so Enter commits what AT announced", async () => {
      // The active option is tracked by id, not by position, so prepending an
      // option cannot shift it: `aria-activedescendant` and what Enter commits
      // stay the same element. This is the *addition* side of that contract.
      type("a");
      press("ArrowDown");
      press("ArrowDown");
      const active = input().getAttribute("aria-activedescendant");
      expect(active).toBe("opt-apricot");

      const late = document.createElement("li");
      late.id = "opt-late";
      late.setAttribute("role", "option");
      late.dataset.value = "avocado";
      late.setAttribute("data-stimeo--combobox-target", "option");
      late.setAttribute("data-action", "click->stimeo--combobox#select");
      late.textContent = "Avocado";
      list().prepend(late);
      await tick();

      expect(input().getAttribute("aria-activedescendant")).toBe(active);
      press("Enter");
      expect(input().value).toBe("apricot");
    });
  });

  describe("the declared empty-state region", () => {
    // The region is a declared target that sits OUTSIDE the listbox: it is what the
    // page shows in place of options, so `role="listbox"` never owns it.
    // Both recordings cover everything this controller can report — the events it
    // declares and the native commit it mirrors into the field — so a test can say
    // "nothing was announced" about the whole surface rather than one name of it.
    let events: ReturnType<typeof captureStateEvents>;
    let commits: ReturnType<typeof captureFieldCommits>;

    beforeEach(() => {
      events = captureStateEvents("stimeo--combobox", ComboboxController.events);
      commits = captureFieldCommits();
    });

    afterEach(() => {
      events.stop();
      commits.stop();
    });

    const mountWithRegion = async (regionMarkup: string): Promise<HTMLElement> => {
      const host = document.createElement("div");
      host.setAttribute("data-controller", "stimeo--combobox");
      host.innerHTML = `
        <input type="text" role="combobox" aria-expanded="false"
               aria-autocomplete="list" aria-controls="listbox-berry" aria-label="Berry"
               data-stimeo--combobox-target="input"
               data-action="input->stimeo--combobox#filter keydown->stimeo--combobox#onKeydown click->stimeo--combobox#open" />
        <ul id="listbox-berry" role="listbox" data-stimeo--combobox-target="list" hidden>
          <li role="option" id="opt-berry" data-value="berry"
              data-stimeo--combobox-target="option"
              data-action="click->stimeo--combobox#select">Berry</li>
        </ul>
        ${regionMarkup}`;
      document.body.appendChild(host);
      await tick();
      return host;
    };
    const field = (host: HTMLElement) => host.querySelector("input") as HTMLInputElement;
    const emptyRegion = (host: HTMLElement) =>
      host.querySelector("[data-stimeo--combobox-target='empty']") as HTMLElement;
    const berryList = (host: HTMLElement) => host.querySelector("#listbox-berry") as HTMLElement;
    const typeInto = (host: HTMLElement, value: string) => {
      field(host).value = value;
      field(host).dispatchEvent(new Event("input", { bubbles: true }));
    };

    it("shows the region while nothing matches and hides it once an option does", async () => {
      // Which side the region is on is a pure function of the empty state, so it
      // follows the state hook in both directions.
      const host = await mountWithRegion(
        `<p hidden data-stimeo--combobox-target="empty">No fruit matches.</p>`,
      );

      typeInto(host, "zz");
      expect(host.hasAttribute("data-stimeo--combobox-empty")).toBe(true);
      expect(emptyRegion(host).hidden).toBe(false);

      typeInto(host, "be");
      expect(host.hasAttribute("data-stimeo--combobox-empty")).toBe(false);
      expect(emptyRegion(host).hidden).toBe(true);
    });

    it("hides the region when the popup closes over an empty result", async () => {
      // Closing ends the empty state, so the region comes down with the popup
      // instead of surviving as a "no results" message over a closed listbox.
      const host = await mountWithRegion(
        `<p hidden data-stimeo--combobox-target="empty">No fruit matches.</p>`,
      );

      typeInto(host, "zz");
      expect(emptyRegion(host).hidden).toBe(false);

      field(host).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      expect(berryList(host).hidden).toBe(true);
      expect(host.hasAttribute("data-stimeo--combobox-empty")).toBe(false);
      expect(emptyRegion(host).hidden).toBe(true);
    });

    it("corrects a region authored on the wrong side at the first connection", async () => {
      // A restored snapshot can bring the region back visible while the widget
      // starts closed. The authored visibility is never read back: the first
      // reflection settles it. Normalizing a fresh connection is not a
      // transition, so nothing is announced and no commit is reported.
      const host = await mountWithRegion(
        `<p data-stimeo--combobox-target="empty">No fruit matches.</p>`,
      );

      expect(host.hasAttribute("data-stimeo--combobox-empty")).toBe(false);
      expect(emptyRegion(host).hidden).toBe(true);
      expect(events.seen).toEqual([]);
      expect(commits.seen).toEqual([]);
    });

    it("settles a region inserted after connect on the side the state is on", async () => {
      // A region delivered by a Turbo Stream lands on the current state the same
      // way one present at connect does.
      const host = await mountWithRegion("");
      typeInto(host, "zz");
      expect(host.hasAttribute("data-stimeo--combobox-empty")).toBe(true);

      const late = document.createElement("p");
      late.hidden = true;
      late.setAttribute("data-stimeo--combobox-target", "empty");
      late.textContent = "No fruit matches.";
      host.appendChild(late);
      await tick();

      expect(late.hidden).toBe(false);
    });

    it("settles a region that arrives after the only one left", async () => {
      const host = await mountWithRegion(
        `<p hidden data-stimeo--combobox-target="empty">No fruit matches.</p>`,
      );
      typeInto(host, "zz");
      emptyRegion(host).remove();
      await tick();
      const late = document.createElement("p");
      late.hidden = true;
      late.setAttribute("data-stimeo--combobox-target", "empty");
      host.appendChild(late);
      await tick();

      expect(late.hidden).toBe(false);
    });
  });
});
