import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MultiSelectController } from "../src/controllers/multi_select_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link MultiSelectController}: substring filtering with
 * activedescendant roving, multi toggle (`aria-selected` + chips), the `max`
 * cap, chip removal/Backspace, focus management, dismissal, and the
 * `change`/`filter` events.
 */

const option = (value: string, label: string) => `
  <li id="ms-${value}" role="option" aria-selected="false" data-value="${value}"
      data-stimeo--multi-select-target="option"
      data-action="click->stimeo--multi-select#toggleOption">${label}</li>`;

const markup = (attrs = "") => `
  <div data-controller="stimeo--multi-select" ${attrs}>
    <ul data-stimeo--multi-select-target="tags" aria-label="Selected"></ul>
    <input type="text" role="combobox" aria-expanded="false" aria-autocomplete="list"
           aria-controls="ms-list" aria-label="Fruits"
           data-stimeo--multi-select-target="input"
           data-action="input->stimeo--multi-select#filter
                        keydown->stimeo--multi-select#onKeydown
                        focus->stimeo--multi-select#open" />
    <ul id="ms-list" role="listbox" aria-multiselectable="true" aria-label="Options" hidden
        data-stimeo--multi-select-target="list">
      ${option("apple", "Apple")}
      ${option("banana", "Banana")}
      ${option("cherry", "Cherry")}
    </ul>
    <span role="status" aria-live="polite" class="visually-hidden"
          data-stimeo--multi-select-target="status"></span>
    <template data-stimeo--multi-select-target="tagTemplate">
      <li data-stimeo--multi-select-target="tag">
        <span data-multi-select-slot="label"></span>
        <button type="button" tabindex="-1">×</button>
      </li>
    </template>
  </div>`;

/** Markup variant with a `fields` target, for the hidden-input mirroring tests. */
const markupWithFields = (attrs = "", preselected = "") => `
  <div data-controller="stimeo--multi-select" ${attrs}>
    <ul data-stimeo--multi-select-target="tags" aria-label="Selected"></ul>
    <input type="text" role="combobox" aria-expanded="false" aria-autocomplete="list"
           aria-controls="ms-list2" aria-label="Fruits"
           data-stimeo--multi-select-target="input"
           data-action="input->stimeo--multi-select#filter
                        keydown->stimeo--multi-select#onKeydown
                        focus->stimeo--multi-select#open" />
    <ul id="ms-list2" role="listbox" aria-multiselectable="true" aria-label="Options" hidden
        data-stimeo--multi-select-target="list">
      <li id="ms2-apple" role="option" aria-selected="${preselected.includes("apple")}"
          data-value="apple" data-stimeo--multi-select-target="option"
          data-action="click->stimeo--multi-select#toggleOption">Apple</li>
      <li id="ms2-banana" role="option" aria-selected="${preselected.includes("banana")}"
          data-value="banana" data-stimeo--multi-select-target="option"
          data-action="click->stimeo--multi-select#toggleOption">Banana</li>
    </ul>
    <span role="status" aria-live="polite" class="visually-hidden"
          data-stimeo--multi-select-target="status"></span>
    <div data-stimeo--multi-select-target="fields"></div>
    <template data-stimeo--multi-select-target="tagTemplate">
      <li data-stimeo--multi-select-target="tag">
        <span data-multi-select-slot="label"></span>
        <button type="button" tabindex="-1">×</button>
      </li>
    </template>
  </div>`;

describe("MultiSelectController", () => {
  let application: Application;

  const mount = async (attrs = "") => {
    document.body.innerHTML = markup(attrs);
    application = Application.start();
    application.register("stimeo--multi-select", MultiSelectController);
    await tick();
  };

  const mountFields = async (attrs = "", preselected = "") => {
    document.body.innerHTML = markupWithFields(attrs, preselected);
    application = Application.start();
    application.register("stimeo--multi-select", MultiSelectController);
    await tick();
  };

  const fields = () =>
    Array.from(
      document.querySelectorAll<HTMLInputElement>(
        "[data-stimeo--multi-select-target='fields'] input",
      ),
    );

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--multi-select']") as HTMLElement;
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--multi-select",
    ) as MultiSelectController;
  const input = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--multi-select-target='input']",
    ) as HTMLInputElement;
  const list = () =>
    document.querySelector<HTMLElement>("[data-stimeo--multi-select-target='list']") as HTMLElement;
  const options = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>("[data-stimeo--multi-select-target='option']"),
    );
  const tags = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--multi-select-target='tag']"));
  const buttons = () =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "[data-stimeo--multi-select-target='tags'] button",
      ),
    );
  const selected = () => options().map((o) => o.getAttribute("aria-selected"));
  const active = () => input().getAttribute("aria-activedescendant");
  const key = (k: string) =>
    input().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  const filterTo = (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("reverses the horizontal arrows under RTL, in the input and across the chips", async () => {
    // Logical direction: the chips are an ordered row, so which one is "next"
    // follows the writing direction — and the input sits at the row's logical end,
    // so the key that reaches back into the chips reverses too. `dir="rtl"` is the
    // authoring contract, but happy-dom does not resolve it into the computed
    // style, so the direction is set on the style directly. Both handlers read the
    // same element on purpose: probing the focused child would let the input and
    // the chips disagree at the boundary between them.
    await mount();
    const root = document.querySelector("[data-controller='stimeo--multi-select']") as HTMLElement;
    root.style.direction = "rtl";
    filterTo("");
    key("ArrowDown");
    options()[0]?.click();
    options()[1]?.click();
    input().value = "";
    expect(buttons().length).toBe(2);

    key("ArrowRight"); // reaches back into the chips under RTL
    expect(document.activeElement).toBe(buttons()[1]);

    buttons()[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(buttons()[0]); // "previous chip"

    buttons()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(buttons()[0]); // guarded at the first chip
  });

  it("reads the direction from the widget, not from the focused input", async () => {
    // The rule this pins: both handlers read the same element, so an input carrying
    // its own `dir` cannot make the two disagree. That shape is ordinary authoring —
    // an LTR field inside an RTL form — and it is the only one that tells
    // `isRtl(this.element)` apart from `isRtl(event.target)`: an inline `direction`
    // on the root otherwise inherits to every child, so both answer the same and the
    // rule goes unpinned.
    await mount();
    const root = document.querySelector("[data-controller='stimeo--multi-select']") as HTMLElement;
    root.style.direction = "rtl";
    input().style.direction = "ltr"; // the input disagrees with its container
    filterTo("");
    key("ArrowDown");
    options()[0]?.click();
    input().value = "";
    expect(buttons().length).toBe(1);

    key("ArrowRight"); // still reaches the chips: the widget decides, not the input
    expect(document.activeElement).toBe(buttons()[0]);
  });

  it("follows the active option by scrolling the LIST only", async () => {
    await mount();
    key("ArrowDown"); // open + first option active
    // happy-dom has no layout: the rect/size INPUTS of the scroll math are
    // modeled here as an 80px viewport over the options.
    Object.defineProperties(list(), {
      scrollHeight: { value: 200, configurable: true },
      clientHeight: { value: 80, configurable: true },
    });
    vi.spyOn(list(), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 80));
    const third = options()[2] as HTMLElement;
    vi.spyOn(third, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 100, 40));
    key("ArrowDown"); // second (zero-rect mock -> visible, no scroll)
    expect(list().scrollTop).toBe(0);
    key("ArrowDown"); // third: bottom 140 > list bottom 80 -> +60
    expect(list().scrollTop).toBe(60);
  });

  it("starts closed", async () => {
    await mount();
    expect(list().hidden).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("filters options by substring and dispatches filter", async () => {
    await mount();
    const queries: string[] = [];
    root().addEventListener("stimeo--multi-select:filter", (event) => {
      queries.push((event as CustomEvent).detail.query);
    });
    filterTo("an"); // matches Banana only
    expect(list().hidden).toBe(false);
    expect(options().map((o) => o.hidden)).toEqual([true, false, true]);
    expect(active()).toBe("ms-banana");
    expect(queries).toEqual(["an"]);
  });

  it("flags an empty result set", async () => {
    await mount();
    filterTo("zzz");
    expect(root().hasAttribute("data-stimeo--multi-select-empty")).toBe(true);
    expect(active()).toBeNull();
  });

  it("opens and moves the active option with arrows (wrapping)", async () => {
    await mount();
    key("ArrowDown"); // open, active apple
    expect(active()).toBe("ms-apple");
    key("ArrowDown");
    expect(active()).toBe("ms-banana");
    key("ArrowUp");
    expect(active()).toBe("ms-apple");
    key("ArrowUp"); // wrap to last
    expect(active()).toBe("ms-cherry");
    key("Home");
    expect(active()).toBe("ms-apple");
    key("End");
    expect(active()).toBe("ms-cherry");
  });

  it("toggles selection with Enter and keeps the list open, adding a chip", async () => {
    await mount();
    const changes: string[][] = [];
    root().addEventListener("stimeo--multi-select:change", (event) => {
      changes.push((event as CustomEvent).detail.values);
    });
    key("ArrowDown"); // active apple
    key("Enter"); // select apple
    expect(selected()).toEqual(["true", "false", "false"]);
    expect(list().hidden).toBe(false);
    expect(tags().map((t) => t.dataset.value)).toEqual(["apple"]);
    expect(buttons()[0]?.getAttribute("aria-label")).toBe("Remove Apple");
    key("Enter"); // toggle apple off
    expect(selected()).toEqual(["false", "false", "false"]);
    expect(tags()).toHaveLength(0);
    expect(changes).toEqual([["apple"], []]);
  });

  it("honors the standard per-event IME signal", async () => {
    await mount();
    key("ArrowDown"); // open, active apple
    // The Enter confirming an IME candidate carries isComposing=true: it must
    // not toggle the active option.
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    expect(selected()).toEqual(["false", "false", "false"]);
    expect(tags()).toHaveLength(0);
    // A real Enter still selects.
    key("Enter");
    expect(selected()).toEqual(["true", "false", "false"]);
  });

  it("defers filtering until compositionend and ignores its unflagged Enter", async () => {
    await mount();
    filterTo("a"); // Apple and Banana are visible; Apple is active.
    const queries: string[] = [];
    root().addEventListener("stimeo--multi-select:filter", (event) => {
      queries.push((event as CustomEvent).detail.query);
    });

    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input().value = "ch";
    input().dispatchEvent(new InputEvent("input", { bubbles: true }));
    key("Enter");

    expect(selected()).toEqual(["false", "false", "false"]);
    expect(options().map((option) => option.hidden)).toEqual([false, false, true]);

    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    // The usual post-composition input must not duplicate the confirmed query event.
    input().dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(options().map((option) => option.hidden)).toEqual([true, true, false]);
    expect(active()).toBe("ms-cherry");
    expect(queries).toEqual(["ch"]);

    key("Enter");
    expect(selected()).toEqual(["false", "false", "true"]);
  });

  it("clears composition state across disconnect and reconnect", async () => {
    await mount();
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));

    controller().disconnect();
    controller().connect();
    key("ArrowDown");

    expect(active()).toBe("ms-apple");
    key("Enter");
    expect(selected()).toEqual(["true", "false", "false"]);
  });

  it("selects options by click", async () => {
    await mount();
    input().dispatchEvent(new FocusEvent("focus"));
    options()[1]?.click(); // Banana
    options()[2]?.click(); // Cherry
    expect(selected()).toEqual(["false", "true", "true"]);
    expect(tags().map((t) => t.dataset.value)).toEqual(["banana", "cherry"]);
  });

  it("re-homes focus to the input after selecting an option by click", async () => {
    await mount();
    input().focus();
    options()[0]?.click(); // the non-focusable option blurs the input to body
    expect(list().hidden).toBe(false); // the list deliberately stays open…
    expect(document.activeElement).toBe(input()); // …so the keyboard must stay live
  });

  it("mirrors the selection into named hidden fields", async () => {
    await mountFields('data-stimeo--multi-select-name-value="fruits[]"');
    expect(fields()).toHaveLength(0); // nothing selected yet
    options()[0]?.click(); // Apple
    options()[1]?.click(); // Banana
    expect(fields().map((f) => f.value)).toEqual(["apple", "banana"]);
    expect(fields().every((f) => f.name === "fruits[]")).toBe(true);
    expect(fields().every((f) => f.type === "hidden")).toBe(true);
  });

  it("defaults the hidden-field name to options[]", async () => {
    await mountFields();
    options()[0]?.click();
    expect(fields().map((f) => f.name)).toEqual(["options[]"]);
  });

  it("removes a hidden field when its option is deselected", async () => {
    await mountFields();
    options()[0]?.click(); // select Apple
    options()[1]?.click(); // select Banana
    options()[0]?.click(); // deselect Apple
    expect(fields().map((f) => f.value)).toEqual(["banana"]);
  });

  it("leaves a modified arrow to the browser in the chip row", async () => {
    // The chip row is delegated on the tags container, so a chorded arrow reaches
    // it as well; it must neither consume the press nor move the chip focus.
    await mount();
    input().dispatchEvent(new FocusEvent("focus"));
    options()[0]?.click();
    options()[1]?.click();
    expect(buttons().length).toBe(2);
    buttons()[0]?.focus();

    const chord = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    buttons()[0]?.dispatchEvent(chord);

    expect(chord.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(buttons()[0]);
  });

  it("yields a chip key a descendant widget already consumed", async () => {
    // Chips render from the consumer's template, so an arbitrary widget can live
    // inside one. A key it claimed must not ALSO move the chip focus.
    await mount();
    key("ArrowDown"); // open + active first
    key("Enter");
    key("ArrowDown");
    key("Enter");
    input().value = "";
    expect(buttons().length).toBe(2);
    const inner = document.createElement("span");
    buttons()[0]?.append(inner);
    inner.addEventListener("keydown", (event) => event.preventDefault());
    buttons()[0]?.focus();

    const claimed = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    const notCanceled = inner.dispatchEvent(claimed);

    expect(notCanceled).toBe(false); // the claim really took (a non-cancelable event would not)
    expect(document.activeElement).toBe(buttons()[0]);
  });

  it("leaves a modified arrow to the browser at the input", async () => {
    // A chorded arrow belongs to the browser or the OS (Alt+Down is not this
    // widget's binding), so the press must be left alone: the list must not open
    // and no option may become active.
    await mount();

    const chord = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    input().dispatchEvent(chord);

    expect(chord.defaultPrevented).toBe(false);
    expect(list().hidden).toBe(true);
    expect(active()).toBe(null);
  });

  it("yields an input key an enclosing widget already consumed", async () => {
    // The claim comes from a capture-phase handler because the binding is on the
    // INPUT, which has no children.
    await mount();
    const root = document.querySelector("[data-controller='stimeo--multi-select']") as HTMLElement;
    root.addEventListener("keydown", (event) => event.preventDefault(), { capture: true });

    const claimed = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    const notCanceled = input().dispatchEvent(claimed);

    expect(notCanceled).toBe(false); // the claim really took (a non-cancelable event would not)
    expect(list().hidden).toBe(true);
    expect(active()).toBe(null);
  });

  it("removes a hidden field via the chip remove button (#removeTagAt path)", async () => {
    await mountFields();
    options()[0]?.click(); // select Apple
    options()[1]?.click(); // select Banana
    expect(fields().map((f) => f.value)).toEqual(["apple", "banana"]);
    // Remove via the chip's remove button — a different code path than option click.
    buttons()[0]?.click(); // remove the Apple chip
    expect(fields().map((f) => f.value)).toEqual(["banana"]);
    expect(selected()).toEqual(["false", "true"]);
  });

  it("seeds hidden fields from pre-selected options on connect", async () => {
    await mountFields("", "apple banana");
    expect(fields().map((f) => f.value)).toEqual(["apple", "banana"]);
  });

  it("sets the form attribute on hidden fields when the form value is given", async () => {
    await mountFields('data-stimeo--multi-select-form-value="composer"');
    options()[0]?.click();
    expect(fields()[0]?.getAttribute("form")).toBe("composer");
  });

  it("enforces the max selection cap", async () => {
    await mount('data-stimeo--multi-select-max-value="1"');
    input().dispatchEvent(new FocusEvent("focus"));
    options()[0]?.click();
    options()[1]?.click(); // blocked by max=1
    expect(selected()).toEqual(["true", "false", "false"]);
    expect(tags()).toHaveLength(1);
  });

  it("removes the last chip on Backspace when the input is empty", async () => {
    await mount();
    input().dispatchEvent(new FocusEvent("focus"));
    options()[0]?.click();
    options()[1]?.click();
    input().value = "";
    key("Backspace");
    expect(selected()).toEqual(["true", "false", "false"]);
    expect(tags().map((t) => t.dataset.value)).toEqual(["apple"]);
  });

  it("removes a chip by its button, deselecting the option and re-homing focus", async () => {
    await mount();
    input().dispatchEvent(new FocusEvent("focus"));
    options()[0]?.click();
    options()[1]?.click();
    buttons()[0]?.click(); // remove apple
    expect(selected()).toEqual(["false", "true", "false"]);
    expect(tags().map((t) => t.dataset.value)).toEqual(["banana"]);
    expect(document.activeElement).toBe(buttons()[0]);
  });

  it("navigates chips and returns to the input past the end", async () => {
    await mount();
    input().dispatchEvent(new FocusEvent("focus"));
    options()[0]?.click();
    options()[1]?.click();
    input().value = "";
    key("ArrowLeft"); // focus last chip
    expect(document.activeElement).toBe(buttons()[1]);
    buttons()[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(input());
  });

  it("closes on Escape and on outside click", async () => {
    await mount();
    key("ArrowDown");
    expect(list().hidden).toBe(false);
    key("Escape");
    expect(list().hidden).toBe(true);
    key("ArrowDown");
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(list().hidden).toBe(true);
  });

  it("hands off between two instances when the second input is clicked", async () => {
    // The trade-off capture buys: `document` sees the click before the trigger's
    // own handler, so the open instance must let go *and* the new one must still
    // open. "The second list never opens" is the failure this pins.
    await mount();
    const second = document.createElement("div");
    second.innerHTML = markup().replace(/ms-list/g, "ms-list2");
    document.body.append(second);
    await tick();
    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement>("input[role='combobox']"),
    );
    const lists = Array.from(
      document.querySelectorAll<HTMLElement>("[data-stimeo--multi-select-target='list']"),
    );
    inputs[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(lists[0]?.hidden).toBe(false);

    inputs[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    inputs[1]?.dispatchEvent(new FocusEvent("focus"));

    expect(lists[0]?.hidden).toBe(true); // the first one let go
    expect(lists[1]?.hidden).toBe(false); // and the second still opened
  });

  it("stays open when an inside click removes the clicked node first", async () => {
    // The failure mode that decides the listener phase. On bubble, the inner handler
    // runs first and detaches the node, so by the time the document listener runs
    // `event.target` is outside the tree and `contains()` says "outside" — closing on
    // what was an *inside* click. On capture the document observes it first, against
    // the tree the user actually clicked.
    await mount();
    key("ArrowDown");
    expect(list().hidden).toBe(false);
    const item = document.createElement("button");
    list().append(item);
    item.addEventListener("click", () => item.remove());

    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(list().hidden).toBe(false);
  });

  it("leaves Escape unconsumed while the list is closed", async () => {
    await mount();
    // With nothing to close the widget owns no dismissable state, so the press
    // stays free for the shared Escape resolver (an enclosing dialog etc.).
    expect(list().hidden).toBe(true);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    input().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("removes aria-activedescendant when closed", async () => {
    await mount();
    key("ArrowDown");
    expect(input().hasAttribute("aria-activedescendant")).toBe(true);
    key("Escape");
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("releases the outside-click listener on disconnect", async () => {
    await mount();
    key("ArrowDown");
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--multi-select",
    );
    controller?.disconnect();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(list().hidden).toBe(false); // a surviving listener would have closed it
  });

  it("has no machine-detectable a11y violations (closed, open, selected)", async () => {
    await mount();
    await expectNoA11yViolations(root());
    key("ArrowDown");
    key("Enter");
    await expectNoA11yViolations(root());
  });

  it("announces the combobox by its accessible name", async () => {
    await mount();
    const phrases = await captureSpeech({ container: root(), steps: 2 });
    expect(phrases).toEqual([
      "list, Selected",
      "combobox, Fruits, has popup listbox, not expanded, autocomplete in list, 1 control",
      "status",
    ]);
  });

  it("rebuilds chips from pre-selected options without duplicating on re-connect", async () => {
    // Banana starts selected (aria-selected="true") with no chip rendered yet.
    document.body.innerHTML = markup().replace(
      'id="ms-banana" role="option" aria-selected="false"',
      'id="ms-banana" role="option" aria-selected="true"',
    );
    application = Application.start();
    application.register("stimeo--multi-select", MultiSelectController);
    await tick();
    expect(tags().map((t) => t.dataset.value)).toEqual(["banana"]);

    // A Turbo cache restore / morph re-connects with the chip already present;
    // connect() must rebuild idempotently rather than append a duplicate.
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--multi-select",
    );
    controller?.disconnect();
    controller?.connect();
    expect(tags().map((t) => t.dataset.value)).toEqual(["banana"]);
  });

  it("supports options without data-value, keying chips and announce by label", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--multi-select">
        <ul data-stimeo--multi-select-target="tags" aria-label="Selected"></ul>
        <input type="text" role="combobox" aria-expanded="false" aria-autocomplete="list"
               aria-controls="ms-list2" aria-label="Fruits"
               data-stimeo--multi-select-target="input"
               data-action="input->stimeo--multi-select#filter
                            keydown->stimeo--multi-select#onKeydown
                            focus->stimeo--multi-select#open" />
        <ul id="ms-list2" role="listbox" aria-multiselectable="true" aria-label="Options" hidden
            data-stimeo--multi-select-target="list">
          <li id="ms-x" role="option" aria-selected="false"
              data-stimeo--multi-select-target="option"
              data-action="click->stimeo--multi-select#toggleOption">Apple</li>
        </ul>
        <span role="status" aria-live="polite" class="visually-hidden"
              data-stimeo--multi-select-target="status"></span>
        <template data-stimeo--multi-select-target="tagTemplate">
          <li data-stimeo--multi-select-target="tag">
            <span data-multi-select-slot="label"></span>
            <button type="button" tabindex="-1">×</button>
          </li>
        </template>
      </div>`;
    application = Application.start();
    application.register("stimeo--multi-select", MultiSelectController);
    await tick();

    input().dispatchEvent(new FocusEvent("focus"));
    options()[0]?.click(); // select Apple (no data-value)
    expect(tags().map((t) => t.dataset.value)).toEqual(["Apple"]); // chip keyed by label
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");

    const status = document.querySelector<HTMLElement>(
      "[data-stimeo--multi-select-target='status']",
    );
    buttons()[0]?.click(); // remove the chip
    expect(options()[0]?.getAttribute("aria-selected")).toBe("false"); // option found by label
    expect(status?.textContent).toBe("Apple"); // announce uses the display label
  });

  it("jumps the active option to the first on Home and the last on End", async () => {
    await mount();
    input().focus();
    key("ArrowDown"); // open, active first
    key("End");
    expect(active()).toBe("ms-cherry");
    key("Home");
    expect(active()).toBe("ms-apple");
  });

  it("closes the list on Tab", async () => {
    await mount();
    input().focus();
    key("ArrowDown");
    expect(list().hidden).toBe(false);
    key("Tab");
    expect(list().hidden).toBe(true);
  });

  it("removes a focused chip with the Delete key", async () => {
    await mount();
    options()[0]?.click(); // chip: Apple
    options()[1]?.click(); // chip: Banana
    expect(tags().length).toBe(2);

    const lastButton = buttons()[buttons().length - 1];
    lastButton?.focus();
    // Delete on the focused chip button bubbles to the tags-container listener.
    lastButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(tags().length).toBe(1);
  });

  it("removes a focused chip with the Backspace key", async () => {
    await mount();
    options()[0]?.click();
    options()[1]?.click();
    expect(tags().length).toBe(2);
    const lastButton = buttons()[buttons().length - 1];
    lastButton?.focus();
    lastButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    expect(tags().length).toBe(1);
  });

  it("still deselects an already-selected option when the max cap is reached", async () => {
    await mount('data-stimeo--multi-select-max-value="2"');
    options()[0]?.click(); // Apple
    options()[1]?.click(); // Banana → at cap (2)
    expect(tags().length).toBe(2);
    // The cap only blocks *new* selections; toggling a selected one off still works.
    options()[0]?.click();
    expect(options()[0]?.getAttribute("aria-selected")).toBe("false");
    expect(tags().length).toBe(1);
  });

  it("clears the active option when Escape closes the list", async () => {
    await mount();
    input().focus();
    key("ArrowDown"); // open + move active onto an option
    expect(active()).toBeTruthy();
    key("Escape");
    expect(list().hidden).toBe(true);
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  });

  describe("an input that is absent at connect", () => {
    /**
     * The input may arrive after `connect()`, so nothing `connect()` reaches for
     * may dereference `inputTarget` unguarded: Stimulus throws on a missing
     * target, and a throw inside `connect()` skips everything after it — the chip
     * rebuild, the roving seed, the tag listeners, the hidden-field seed, the
     * outside-click listener — with no second chance to run them. These cases pin
     * each of those against a fixture whose input is inserted later.
     */
    const lateMarkup = `
      <div data-controller="stimeo--multi-select">
        <ul data-stimeo--multi-select-target="tags" aria-label="Selected"></ul>
        <ul id="ms-late-list" role="listbox" aria-multiselectable="true" aria-label="Options"
            hidden data-stimeo--multi-select-target="list">
          <li id="ms-late-apple" role="option" aria-selected="true" data-value="apple"
              data-stimeo--multi-select-target="option"
              data-action="click->stimeo--multi-select#toggleOption">Apple</li>
          <li id="ms-late-banana" role="option" aria-selected="false" data-value="banana"
              data-stimeo--multi-select-target="option"
              data-action="click->stimeo--multi-select#toggleOption">Banana</li>
        </ul>
        <span role="status" aria-live="polite" class="visually-hidden"
              data-stimeo--multi-select-target="status"></span>
        <div data-stimeo--multi-select-target="fields"></div>
        <template data-stimeo--multi-select-target="tagTemplate">
          <li data-stimeo--multi-select-target="tag">
            <span data-multi-select-slot="label"></span>
            <button type="button" tabindex="-1">×</button>
          </li>
        </template>
      </div>`;

    const mountLate = async () => {
      document.body.innerHTML = lateMarkup;
      application = Application.start();
      application.register("stimeo--multi-select", MultiSelectController);
      await tick();
    };

    /** Inserts the input the consumer renders after connect. */
    const addInput = async () => {
      const late = document.createElement("input");
      late.type = "text";
      late.setAttribute("role", "combobox");
      late.setAttribute("aria-expanded", "false");
      late.setAttribute("aria-autocomplete", "list");
      late.setAttribute("aria-controls", "ms-late-list");
      late.setAttribute("aria-label", "Fruits");
      late.setAttribute("data-stimeo--multi-select-target", "input");
      late.setAttribute(
        "data-action",
        `input->stimeo--multi-select#filter
         keydown->stimeo--multi-select#onKeydown
         focus->stimeo--multi-select#open`,
      );
      root().insertBefore(late, root().firstChild);
      await tick();
      return late;
    };

    it("seeds the hidden fields from the pre-selected options", async () => {
      // A half-initialised widget looks fine on screen (the options carry their
      // own `aria-selected`) but submits nothing.
      await mountLate();

      expect(fields().map((f) => f.value)).toEqual(["apple"]);
    });

    it("builds the chips and seeds the roving tab stop", async () => {
      await mountLate();

      expect(tags().length).toBe(1);
      expect(buttons().map((b) => b.tabIndex)).toEqual([0]);
    });

    it("wires the chip listeners, so a chip can still be removed", async () => {
      await mountLate();
      const button = buttons()[0];
      button?.focus();

      button?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));

      expect(tags().length).toBe(0);
      expect(options()[0]?.getAttribute("aria-selected")).toBe("false");
      expect(fields()).toEqual([]);
    });

    it("keeps focus inside the widget when the last chip is removed", async () => {
      // The chip that had focus is gone and there is no input to hand it back to,
      // so the browser drops focus to `<body>` — the keyboard user loses their
      // place on the page. The widget borrows a programmatic tab stop instead,
      // the same rescue `overflow-menu` and `pagination` already use.
      await mountLate();
      const button = buttons()[0];
      button?.focus();

      button?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));

      expect(tags().length).toBe(0);
      expect(document.activeElement).toBe(root());
      expect(root().getAttribute("tabindex")).toBe("-1");
    });

    it("does not steal focus when the last chip is removed from elsewhere", async () => {
      // The rescue must only fire when focus went down with the chip. A chip
      // removed programmatically while the user is somewhere else on the page
      // must not yank them back into the widget.
      await mountLate();
      const outside = document.createElement("button");
      outside.type = "button";
      outside.textContent = "Elsewhere";
      document.body.appendChild(outside);
      outside.focus();

      buttons()[0]?.click(); // the chip's own remove button, activated out of band

      expect(tags().length).toBe(0);
      expect(document.activeElement).toBe(outside);
      expect(root().hasAttribute("tabindex")).toBe(false);
    });

    it("hands the borrowed tab stop back on disconnect", async () => {
      await mountLate();
      const button = buttons()[0];
      button?.focus();
      button?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      expect(root().getAttribute("tabindex")).toBe("-1");

      disconnectAndStopApplication(application);

      expect(root().hasAttribute("tabindex")).toBe(false);
    });

    it("keeps a consumer-authored tabindex of -1 on the root", async () => {
      // Both layers of the ownership check earn their keep. The value alone is
      // ambiguous — `-1` is exactly what a borrow looks like — so the flag has to
      // say whether this instance lent anything at all. A root the consumer
      // already made programmatically focusable is never borrowed from.
      await mountLate();
      root().setAttribute("tabindex", "-1");
      const button = buttons()[0];
      button?.focus();

      button?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      expect(document.activeElement).toBe(root());

      disconnectAndStopApplication(application);

      expect(root().getAttribute("tabindex")).toBe("-1");
    });

    it("leaves a borrowed tab stop the consumer has since taken over", async () => {
      // Owning the borrow is not enough: the value has to still be the one this
      // instance wrote. A consumer that made the root a real Tab stop after the
      // rescue owns it now, and teardown must not undo that.
      await mountLate();
      const button = buttons()[0];
      button?.focus();
      button?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      expect(root().getAttribute("tabindex")).toBe("-1");

      root().setAttribute("tabindex", "0");
      disconnectAndStopApplication(application);

      expect(root().getAttribute("tabindex")).toBe("0");
    });

    it("never takes a consumer-authored tabindex on the root", async () => {
      // Only the value this instance borrowed may be handed back. A root the
      // consumer made focusable itself keeps both its value and its presence —
      // the same ownership rule `pagination` and `scroll-visibility` follow.
      await mountLate();
      root().setAttribute("tabindex", "0");
      const button = buttons()[0];
      button?.focus();

      button?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));

      expect(document.activeElement).toBe(root());
      expect(root().getAttribute("tabindex")).toBe("0");

      disconnectAndStopApplication(application);

      expect(root().getAttribute("tabindex")).toBe("0");
    });

    it("registers the outside-click listener, so the list closes once the input arrives", async () => {
      await mountLate();
      const late = await addInput();

      late.value = "ap";
      late.dispatchEvent(new Event("input", { bubbles: true }));
      expect(list().hidden).toBe(false);

      document.body.click();

      expect(list().hidden).toBe(true);
    });

    it("still selects an option by click", async () => {
      // Options carry their own `data-action`, so the primary selection path does
      // not go through the input at all. It re-homes focus to the input
      // afterwards — which must degrade to leaving focus alone, not throwing
      // after the selection already changed.
      await mountLate();

      options()[1]?.click();

      expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
      expect(tags().length).toBe(2);
      expect(fields().map((f) => f.value)).toEqual(["apple", "banana"]);
    });

    it("stops at the last chip on ArrowRight instead of throwing", async () => {
      // The chip list hands focus back to the input past its last button; with no
      // input the roving tab stop must simply stay where it is.
      await mountLate();
      options()[1]?.click();
      const last = buttons()[buttons().length - 1];
      last?.focus();

      last?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

      expect(document.activeElement).toBe(last);
      expect(tags().length).toBe(2);
    });

    it("does not throw from the public open / close actions", async () => {
      // Both are declared actions, so a consumer can wire them to any element —
      // not only to the input that may not exist yet.
      await mountLate();

      expect(() => controller().open()).not.toThrow();
      expect(() => controller().close()).not.toThrow();
    });
  });

  it("no-ops instead of throwing when the list target is absent", async () => {
    // The other half of the same tolerance open() / close() declare. Guarding
    // only the input would leave `listTarget.hidden` to throw from the very same
    // two methods, one target over.
    await mount();
    input().focus();
    key("ArrowDown");
    list().remove();

    expect(() => controller().close()).not.toThrow();
    expect(() => controller().open()).not.toThrow();
  });

  it("still closes the list on an outside click after the input is removed", async () => {
    // The tolerance above must not trade one broken contract for another: with the
    // input gone the widget cannot update ARIA, but the popup itself must still
    // come down — otherwise a detached listbox floats over the page for the rest
    // of the session. Only close()'s ARIA half may be guarded; guarding the
    // *whole* of it would stop the popup closing once the input is removed.
    await mount();
    input().focus();
    key("ArrowDown");
    expect(list().hidden).toBe(false);

    input().remove();
    document.body.click();

    expect(list().hidden).toBe(true);
  });

  it("clears the active option when it closes without an input", async () => {
    // Guarding the ARIA half must not take the *state* half with it. A closed list
    // whose option still reads `data-active` is lying about itself, and the stale
    // `#activeOption` is what breaks the re-open below.
    await mount();
    input().focus();
    key("ArrowDown");
    expect(options().filter((o) => o.hasAttribute("data-active")).length).toBe(1);

    input().remove();
    document.body.click();

    expect(options().some((o) => o.hasAttribute("data-active"))).toBe(false);
  });

  it("restores aria-activedescendant when a replacement input opens the list", async () => {
    // The failure this guards: `open()` only seeds an active option when there is
    // none, so a stale `#activeOption` left behind by a close without an input
    // makes the *next* open skip the seeding entirely. The list would come up with
    // no `aria-activedescendant` at all — visible to sighted users through
    // `data-active`, invisible to assistive technology.
    await mount();
    input().focus();
    key("ArrowDown");
    input().remove();
    document.body.click();

    const replacement = document.createElement("input");
    replacement.type = "text";
    replacement.setAttribute("role", "combobox");
    replacement.setAttribute("aria-expanded", "false");
    replacement.setAttribute("aria-controls", "ms-list");
    replacement.setAttribute("aria-label", "Fruits");
    replacement.setAttribute("data-stimeo--multi-select-target", "input");
    root().insertBefore(replacement, root().firstChild);
    await tick();

    controller().open();

    expect(list().hidden).toBe(false);
    expect(replacement.getAttribute("aria-expanded")).toBe("true");
    expect(replacement.getAttribute("aria-activedescendant")).toBe("ms-apple");
    expect(options()[0]?.hasAttribute("data-active")).toBe(true);
  });

  it("re-describes the widget on an input swapped in while the list is open", async () => {
    // A Turbo Stream (or any `replaceWith`) can hand the widget a fresh input
    // without the popup ever closing. The new node carries only its authored
    // ARIA, while the controller still holds the open list and the active
    // option — so nothing tells assistive technology what is on screen unless
    // the target callback re-describes it. Closing first is not required, which
    // is why the close-then-reopen case above does not cover this.
    await mount();
    input().focus();
    key("ArrowDown");
    const activeId = active();
    expect(list().hidden).toBe(false);
    expect(activeId).toBeTruthy();

    const replacement = document.createElement("input");
    replacement.type = "text";
    replacement.setAttribute("role", "combobox");
    replacement.setAttribute("aria-expanded", "false");
    replacement.setAttribute("aria-controls", "ms-list");
    replacement.setAttribute("aria-label", "Fruits");
    replacement.setAttribute("data-stimeo--multi-select-target", "input");
    input().replaceWith(replacement);
    await tick();

    expect(replacement.getAttribute("aria-expanded")).toBe("true");
    expect(replacement.getAttribute("aria-activedescendant")).toBe(activeId);
  });

  it("re-describes a closed widget on an input swapped in", async () => {
    // The mirror case: a swap while the list is closed must not leave the fresh
    // node claiming an active option the widget does not have.
    await mount();
    input().focus();
    key("ArrowDown");
    key("Escape");
    expect(list().hidden).toBe(true);

    const replacement = document.createElement("input");
    replacement.type = "text";
    replacement.setAttribute("role", "combobox");
    replacement.setAttribute("aria-expanded", "true");
    replacement.setAttribute("aria-activedescendant", "ms-apple");
    replacement.setAttribute("aria-controls", "ms-list");
    replacement.setAttribute("aria-label", "Fruits");
    replacement.setAttribute("data-stimeo--multi-select-target", "input");
    input().replaceWith(replacement);
    await tick();

    expect(replacement.getAttribute("aria-expanded")).toBe("false");
    expect(replacement.hasAttribute("aria-activedescendant")).toBe(false);
  });

  describe("runtime option removal", () => {
    it("keeps the surviving active option when an earlier option is removed", async () => {
      await mount();
      key("ArrowDown"); // Apple
      key("ArrowDown"); // Banana
      const apple = options()[0] as HTMLElement;
      const banana = options()[1] as HTMLElement;

      apple.remove();
      await tick();

      expect(active()).toBe(banana.id);
      expect(document.getElementById(active() ?? "")).toBe(banana);
      expect(options().filter((candidate) => candidate.hasAttribute("data-active"))).toEqual([
        banana,
      ]);

      key("Enter");
      expect(tags().map((tag) => tag.dataset.value)).toEqual(["banana"]);
    });

    it("does not commit a detached active option and falls back to the first visible target", async () => {
      await mount();
      key("ArrowDown"); // Apple
      key("ArrowDown"); // Banana
      const banana = options()[1] as HTMLElement;

      banana.removeAttribute("data-stimeo--multi-select-target");
      // Target callbacks run from MutationObserver. Even before that callback, a
      // synchronously dispatched Enter must not commit the no-longer-current node.
      key("Enter");
      expect(tags()).toEqual([]);

      await tick();

      const apple = options()[0] as HTMLElement;
      expect(active()).toBe(apple.id);
      expect(document.getElementById(active() ?? "")).toBe(apple);
      expect(banana.hasAttribute("data-active")).toBe(false);
      expect(banana.getAttribute("aria-selected")).toBe("false");
      expect(options().filter((candidate) => candidate.hasAttribute("data-active"))).toEqual([
        apple,
      ]);

      key("Enter");
      expect(tags().map((tag) => tag.dataset.value)).toEqual(["apple"]);
    });

    it("ignores a click from an option after its target token is removed", async () => {
      await mount();
      key("ArrowDown");
      const removed = options()[0] as HTMLElement;

      removed.removeAttribute("data-stimeo--multi-select-target");
      await tick();
      removed.click();

      expect(tags()).toEqual([]);
      expect(removed.getAttribute("aria-selected")).toBe("false");
    });

    it("transfers active state and commit ownership to a same-id replacement", async () => {
      await mount();
      key("ArrowDown"); // Apple
      key("ArrowDown"); // Banana
      const previous = options()[1] as HTMLElement;
      const replacement = document.createElement("li");
      replacement.id = previous.id;
      replacement.setAttribute("role", "option");
      replacement.setAttribute("aria-selected", "false");
      replacement.dataset.value = "blueberry";
      replacement.setAttribute("data-stimeo--multi-select-target", "option");
      replacement.textContent = "Blueberry";

      previous.replaceWith(replacement);
      await tick();

      expect(previous.hasAttribute("data-active")).toBe(false);
      expect(active()).toBe(replacement.id);
      expect(document.getElementById(active() ?? "")).toBe(replacement);
      expect(replacement.hasAttribute("data-active")).toBe(true);

      key("Enter");
      expect(tags().map((tag) => tag.dataset.value)).toEqual(["blueberry"]);
      expect(replacement.getAttribute("aria-selected")).toBe("true");
    });

    it("does not synchronously commit a hidden same-id replacement", async () => {
      await mount();
      key("ArrowDown"); // Apple
      const previous = options()[0] as HTMLElement;
      const replacement = document.createElement("li");
      replacement.id = previous.id;
      replacement.hidden = true;
      replacement.setAttribute("role", "option");
      replacement.setAttribute("aria-selected", "false");
      replacement.dataset.value = "hidden-apple";
      replacement.setAttribute("data-stimeo--multi-select-target", "option");
      replacement.textContent = "Hidden Apple";

      previous.replaceWith(replacement);
      key("Enter");

      expect(tags()).toEqual([]);
      await tick();
      const firstVisible = options().find((option) => !option.hidden) as HTMLElement;
      expect(firstVisible.dataset.value).toBe("banana");
      expect(active()).toBe(firstVisible.id);
      expect(firstVisible.hasAttribute("data-active")).toBe(true);
      expect(replacement.hasAttribute("data-active")).toBe(false);
    });

    it("never commits a removed node before its target-disconnected callback runs", async () => {
      await mount();
      key("ArrowDown"); // Apple
      key("ArrowDown"); // Banana
      const banana = options()[1] as HTMLElement;

      banana.remove();
      // Stimulus observes this removal asynchronously. The key path still has to
      // resolve against the current DOM rather than the detached stored node.
      key("Enter");

      expect(tags()).toEqual([]);
      await tick();
      const apple = options()[0] as HTMLElement;
      expect(banana.hasAttribute("data-active")).toBe(false);
      expect(active()).toBe(apple.id);
      expect(document.getElementById(active() ?? "")).toBe(apple);
    });

    it("clears virtual focus when the last option is removed", async () => {
      await mount();
      for (const candidate of options().slice(1)) candidate.remove();
      await tick();
      key("ArrowDown");
      const last = options()[0] as HTMLElement;
      expect(active()).toBe(last.id);

      last.remove();
      await tick();

      expect(active()).toBeNull();
      expect(last.hasAttribute("data-active")).toBe(false);
      expect(options().some((candidate) => candidate.hasAttribute("data-active"))).toBe(false);
      const enter = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      input().dispatchEvent(enter);
      expect(enter.defaultPrevented).toBe(false);
      expect(tags()).toEqual([]);
    });
  });

  describe("the authored option baseline", () => {
    it("gives every option an explicit value without dropping any selection", async () => {
      // Absent means "not selectable" in ARIA. Several `true` is normal here, so
      // only the missing ones are filled.
      document.body.innerHTML = `
        <div data-controller="stimeo--multi-select">
          <ul data-stimeo--multi-select-target="tags" aria-label="Selected"></ul>
          <input type="text" role="combobox" aria-expanded="false" aria-label="Fruits"
                 data-stimeo--multi-select-target="input" />
          <ul id="ms-list3" role="listbox" aria-multiselectable="true" aria-label="Options" hidden
              data-stimeo--multi-select-target="list">
            <li id="ms3-a" role="option" aria-selected="true" data-value="a"
                data-stimeo--multi-select-target="option">A</li>
            <li id="ms3-b" role="option" data-value="b"
                data-stimeo--multi-select-target="option">B</li>
            <li id="ms3-c" role="option" aria-selected="true" data-value="c"
                data-stimeo--multi-select-target="option">C</li>
          </ul>
          <div data-stimeo--multi-select-target="fields"></div>
          <template data-stimeo--multi-select-target="tagTemplate">
            <li data-stimeo--multi-select-target="tag">
              <span data-multi-select-slot="label"></span>
              <button type="button" tabindex="-1">×</button>
            </li>
          </template>
        </div>`;
      application = Application.start();
      application.register("stimeo--multi-select", MultiSelectController);
      await tick();

      expect(selected()).toEqual(["true", "false", "true"]);
      expect(fields().map((f) => f.value)).toEqual(["a", "c"]);
    });

    it("re-derives chips and fields when the candidate list is emptied", async () => {
      // Replacing the list with an empty one never fires a *connected* callback,
      // so only the disconnected side can stop the chips and hidden fields from
      // advertising a selection whose option is gone.
      await mountFields("", "apple");
      expect(tags().length).toBe(1);
      expect(fields().map((f) => f.value)).toEqual(["apple"]);

      (document.getElementById("ms-list2") as HTMLElement).innerHTML = "";
      await tick();

      expect(tags().length).toBe(0);
      expect(fields()).toEqual([]);
    });

    it("re-reads the chip label when the option keeps its value but changes its label", async () => {
      // The value order alone does not say the chips are still correct: a server
      // can re-render the same candidate with a new label, and both the chip text
      // and its `Remove {label}` name are derived from the option.
      await mountFields("", "apple");
      const chipText = () =>
        (document.querySelector("[data-multi-select-slot='label']") as HTMLElement)?.textContent;
      const chipName = () => buttons()[0]?.getAttribute("aria-label");
      expect(chipText()).toBe("Apple");

      (document.getElementById("ms-list2") as HTMLElement).innerHTML = `
        <li id="ms2-apple" role="option" aria-selected="true" data-value="apple"
            data-stimeo--multi-select-target="option">Green Apple</li>`;
      await tick();

      expect(chipText()).toBe("Green Apple");
      expect(chipName()).toBe("Remove Green Apple");
    });

    it("keeps chip focus when an unrelated option is added", async () => {
      // The rebuild removes and recreates every chip, so running it for an option
      // that does not change the selection would drop the keyboard user out of
      // the chip they were on.
      await mountFields("", "apple");
      const button = buttons()[0] as HTMLButtonElement;
      button.focus();
      expect(document.activeElement).toBe(button);

      const late = document.createElement("li");
      late.id = "ms2-cherry";
      late.setAttribute("role", "option");
      late.setAttribute("aria-selected", "false");
      late.dataset.value = "cherry";
      late.setAttribute("data-stimeo--multi-select-target", "option");
      late.textContent = "Cherry";
      (document.getElementById("ms-list2") as HTMLElement).appendChild(late);
      await tick();

      expect(document.activeElement).toBe(button);
      expect(tags().length).toBe(1);
    });

    it("keeps chip focus when an unrelated option is added after selecting out of DOM order", async () => {
      // The chips are in selection order and the options in DOM order, so the two
      // lists hold the same values in different places. Comparing them position by
      // position would read every such selection as a changed set and rebuild the
      // chips on any unrelated option change, dropping focus to the body.
      await mount();
      options()[1]?.click(); // Banana
      options()[0]?.click(); // Apple
      expect(tags().map((tag) => tag.dataset.value)).toEqual(["banana", "apple"]);
      const button = buttons()[0] as HTMLButtonElement;
      button.focus();

      const late = document.createElement("li");
      late.setAttribute("role", "option");
      late.setAttribute("aria-selected", "false");
      late.dataset.value = "date";
      late.setAttribute("data-stimeo--multi-select-target", "option");
      late.textContent = "Date";
      (document.getElementById("ms-list") as HTMLElement).appendChild(late);
      await tick();

      expect(document.activeElement).toBe(button);
      expect(tags().map((tag) => tag.dataset.value)).toEqual(["banana", "apple"]);
    });

    it("relabels the chip that owns the value when the selection is out of DOM order", async () => {
      // Pairing the two lists by position would push the renamed option's label
      // onto whichever chip happens to sit at the same index.
      await mount();
      options()[1]?.click(); // Banana
      options()[0]?.click(); // Apple
      const chipTexts = () =>
        tags().map(
          (tag) => tag.querySelector<HTMLElement>("[data-multi-select-slot='label']")?.textContent,
        );
      expect(chipTexts()).toEqual(["Banana", "Apple"]);

      // A server re-render of the same two candidates, one of them renamed.
      (document.getElementById("ms-list") as HTMLElement).innerHTML = `
        <li id="ms-apple" role="option" aria-selected="true" data-value="apple"
            data-stimeo--multi-select-target="option">Green Apple</li>
        <li id="ms-banana" role="option" aria-selected="true" data-value="banana"
            data-stimeo--multi-select-target="option">Banana</li>`;
      await tick();

      expect(chipTexts()).toEqual(["Banana", "Green Apple"]);
      expect(buttons().map((b) => b.getAttribute("aria-label"))).toEqual([
        "Remove Banana",
        "Remove Green Apple",
      ]);
    });

    it("re-derives chips and fields for an option added already selected", async () => {
      // The candidate list can be swapped at runtime. Without a target callback
      // the chips and the form disagree with what AT reads.
      await mountFields("", "apple");
      expect(tags().length).toBe(1);

      const late = document.createElement("li");
      late.id = "ms2-cherry";
      late.setAttribute("role", "option");
      late.setAttribute("aria-selected", "true");
      late.dataset.value = "cherry";
      late.setAttribute("data-stimeo--multi-select-target", "option");
      late.textContent = "Cherry";
      (document.getElementById("ms-list2") as HTMLElement).appendChild(late);
      await tick();

      expect(tags().length).toBe(2);
      expect(fields().map((f) => f.value)).toEqual(["apple", "cherry"]);
    });
  });
});
