import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComboboxController } from "../src/controllers/combobox_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
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
            data-action="click->stimeo--combobox#selectByClick">Apple</li>
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
    // Committing an option is a public event with a `{ value }` detail; this is
    // the only case that observes the dispatch itself.
    const details: unknown[] = [];
    root().addEventListener("stimeo--combobox:selected", (event) => {
      details.push((event as CustomEvent).detail);
    });

    type("ap");
    input().focus();
    press("ArrowDown");
    press("Enter");

    expect(input().value).toBe("apple");
    expect(details).toEqual([{ value: "apple" }]);
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
            data-action="click->stimeo--combobox#selectByClick">Apple</li>
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
      replacement.setAttribute("data-action", "click->stimeo--combobox#selectByClick");
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
      replacement.setAttribute("data-action", "click->stimeo--combobox#selectByClick");
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
      late.setAttribute("data-action", "click->stimeo--combobox#selectByClick");
      late.textContent = "Avocado";
      list().prepend(late);
      await tick();

      expect(input().getAttribute("aria-activedescendant")).toBe(active);
      press("Enter");
      expect(input().value).toBe("apricot");
    });
  });
});
