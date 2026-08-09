import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ListboxController } from "../src/controllers/listbox_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ListboxController}: the APG select-only listbox —
 * open/close, `aria-activedescendant` roving with focus on the trigger,
 * typeahead, single selection (`aria-selected` + trigger label + hidden field),
 * focus restoration, outside-click/Escape/Tab dismissal, and the `change` event.
 */

const markup = `
  <div data-controller="stimeo--listbox">
    <span id="lb-label">Favorite fruit</span>
    <button type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false"
            aria-controls="lb-list"
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
    disconnectAndStopApplication(application);
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

  it("toggles shut on a second real mouse click", () => {
    // `toggle` has to branch on the current state. A handler that only ever opens
    // still passes every other open-path case in this file.
    const click = () =>
      trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    click();
    click();
    expect(listEl().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("follows the active option by scrolling the LIST only", () => {
    // happy-dom has no layout: the rect/size INPUTS of the scroll math are
    // modeled here as an 80px viewport over the options.
    trigger().focus();
    triggerKey("ArrowDown"); // open, active opt-1
    Object.defineProperties(listEl(), {
      scrollHeight: { value: 200, configurable: true },
      clientHeight: { value: 80, configurable: true },
    });
    vi.spyOn(listEl(), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 80));
    const cherry = options()[2] as HTMLElement;
    vi.spyOn(cherry, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 100, 40));
    triggerKey("ArrowDown"); // opt-2 (zero-rect mock -> visible, no scroll)
    expect(listEl().scrollTop).toBe(0);
    triggerKey("ArrowDown"); // opt-3: bottom 140 > list bottom 80 -> +60
    expect(listEl().scrollTop).toBe(60);
  });

  it("opens with ArrowDown and activates the first option (focus stays on trigger)", () => {
    trigger().focus();
    triggerKey("ArrowDown");
    expect(listEl().hidden).toBe(false);
    expect(active()).toBe("opt-1");
    expect(document.activeElement).toBe(trigger());
  });

  it("opens on every closed-state activation key, claiming the press", () => {
    // Enter, Space and ArrowUp reach the same open path as ArrowDown. Exercising
    // one representative key leaves the other three branches free to be deleted.
    for (const key of ["Enter", " ", "ArrowUp", "ArrowDown"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      trigger().dispatchEvent(event);
      expect(listEl().hidden, `${key} should open the list`).toBe(false);
      expect(event.defaultPrevented, `${key} should be claimed`).toBe(true);
      triggerKey("Escape");
    }
  });

  it("leaves a modified arrow to the browser", () => {
    // This listbox is select-only — multi-select is out of scope — so no
    // modifier is claimed by any of its bindings and every chord goes to the
    // browser. The local `triggerKey` helper builds a non-cancelable event,
    // which could not report a claim either way, so the event is built here.
    trigger().focus();
    triggerKey("ArrowDown"); // open, active opt-1
    expect(active()).toBe("opt-1");

    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    trigger().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(active()).toBe("opt-1");
    expect(listEl().hidden).toBe(false);

    // Shift and Control are claimed by the APG multi-select models, which this
    // select-only listbox does not implement — so they are not claimed here.
    for (const modifier of ["shiftKey", "ctrlKey"] as const) {
      const chord = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        [modifier]: true,
        bubbles: true,
        cancelable: true,
      });
      trigger().dispatchEvent(chord);
      expect(chord.defaultPrevented).toBe(false);
      expect(active()).toBe("opt-1");
    }
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

  it("commits the active option with Space as well as Enter", () => {
    trigger().focus();
    triggerKey("ArrowDown"); // open, active opt-1
    triggerKey("ArrowDown"); // opt-2
    triggerKey(" ");
    expect(field().value).toBe("banana");
    expect(listEl().hidden).toBe(true);
  });

  it("selects an option on click", () => {
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    options()[2]?.click();
    expect(selected()).toEqual(["false", "false", "true"]);
    expect(field().value).toBe("cherry");
    expect(listEl().hidden).toBe(true);
  });

  it("returns focus to the trigger after a click selection", () => {
    // The list is being dismissed, so focus has to land somewhere deliberate:
    // left on an option that is now hidden, the keyboard user is stranded.
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    options()[2]?.click();
    expect(document.activeElement).toBe(trigger());
  });

  it("leaves exactly one option marked active as the active one moves", () => {
    trigger().focus();
    triggerKey("ArrowDown"); // opt-1
    triggerKey("ArrowDown"); // opt-2
    triggerKey("ArrowDown"); // opt-3
    triggerKey("ArrowDown"); // wraps back to opt-1
    expect(options().map((option) => option.hasAttribute("data-active"))).toEqual([
      true,
      false,
      false,
    ]);
    triggerKey("Escape");
    expect(options().some((option) => option.hasAttribute("data-active"))).toBe(false);
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

  it("stays open on an Escape that cancels an IME composition", () => {
    trigger().focus();
    triggerKey("ArrowDown");
    // A composing press steers the IME conversion and never dismisses the popup.
    trigger().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true }),
    );
    expect(listEl().hidden).toBe(false);
  });

  it("closes on Tab without forcing focus back", () => {
    trigger().focus();
    triggerKey("ArrowDown");
    const focusBack = vi.spyOn(trigger(), "focus");
    triggerKey("Tab");
    expect(listEl().hidden).toBe(true);
    // Tab is the user moving on; pulling focus back to the trigger traps them.
    expect(focusBack).not.toHaveBeenCalled();
    focusBack.mockRestore();
  });

  it("closes on an outside click", () => {
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(listEl().hidden).toBe(false);
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(listEl().hidden).toBe(true);
  });

  it("leaves focus on whatever the outside click landed on", () => {
    const outside = document.createElement("button");
    outside.type = "button";
    document.body.append(outside);
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    outside.focus();
    outside.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(listEl().hidden).toBe(true);
    // Dismissing is not a reason to steal the focus the click just placed.
    expect(document.activeElement).toBe(outside);
    outside.remove();
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

  it("bubbles the native change out of the field", () => {
    // Form-level behaviors listen on the <form>, not on the hidden input, so a
    // non-bubbling change reaches nobody. Listening on the field itself cannot
    // tell the two apart.
    const heard: string[] = [];
    root().addEventListener("change", (event) => {
      heard.push((event.target as HTMLInputElement).value);
    });
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    options()[1]?.click();
    expect(heard).toEqual(["banana"]);
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

  it("yields a keydown another handler already consumed", () => {
    const claim = (event: Event) => event.preventDefault();
    document.addEventListener("keydown", claim, true);
    try {
      trigger().focus();
      const event = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      });
      expect(trigger().dispatchEvent(event)).toBe(false);
    } finally {
      document.removeEventListener("keydown", claim, true);
    }

    expect(listEl().hidden).toBe(true);
    expect(active()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("stays open when an inside click removes its own target", () => {
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    const inner = document.createElement("button");
    inner.type = "button";
    inner.addEventListener("click", () => inner.remove());
    root().appendChild(inner);

    inner.click();

    expect(listEl().hidden).toBe(false);
  });

  it("closes the previous instance when another listbox trigger opens", async () => {
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(listEl().hidden).toBe(false);

    const second = document.createElement("div");
    second.setAttribute("data-controller", "stimeo--listbox");
    second.innerHTML = `
      <button type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false"
              aria-controls="lb-list-2" aria-label="Second"
              data-stimeo--listbox-target="trigger"
              data-action="click->stimeo--listbox#toggle
                           keydown->stimeo--listbox#onTriggerKeydown">Choose…</button>
      <ul id="lb-list-2" role="listbox" aria-label="Second options" hidden
          data-stimeo--listbox-target="list">
        <li id="opt-2-apple" role="option" aria-selected="false" data-value="apple"
            data-stimeo--listbox-target="option"
            data-action="click->stimeo--listbox#select">Apple</li>
      </ul>`;
    document.body.appendChild(second);
    await tick();

    const secondTrigger = second.querySelector<HTMLElement>("[role='combobox']") as HTMLElement;
    secondTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

    expect(listEl().hidden).toBe(true);
    expect((document.getElementById("lb-list-2") as HTMLElement).hidden).toBe(false);
  });

  describe("runtime option removal reconciliation", () => {
    const activeMarkerIds = () =>
      Array.from(root().querySelectorAll<HTMLElement>("[data-active]"), (option) => option.id);

    it("keeps the same active option when a preceding option is removed", async () => {
      triggerKey("ArrowDown");
      triggerKey("ArrowDown"); // Banana

      options()[0]?.remove();
      await tick();

      expect(active()).toBe("opt-2");
      expect(activeMarkerIds()).toEqual(["opt-2"]);

      triggerKey("Enter");
      expect(field().value).toBe("banana");
      expect(valueLabel().textContent).toBe("Banana");
    });

    it("falls forward when the active target token is removed", async () => {
      triggerKey("ArrowDown");
      triggerKey("ArrowDown"); // Banana
      const removedActive = options()[1] as HTMLElement;

      removedActive.removeAttribute("data-stimeo--listbox-target");
      await tick();

      expect(active()).toBe("opt-3");
      expect(activeMarkerIds()).toEqual(["opt-3"]);
      expect(removedActive.hasAttribute("data-active")).toBe(false);

      triggerKey(" ");
      expect(field().value).toBe("cherry");
      expect(valueLabel().textContent).toBe("Cherry");
    });

    it("ignores a click from an option after its target token is removed", async () => {
      const removed = options()[0] as HTMLElement;
      const initialLabel = valueLabel().textContent;
      const changes: unknown[] = [];
      root().addEventListener("stimeo--listbox:change", (event) => changes.push(event));

      removed.removeAttribute("data-stimeo--listbox-target");
      await tick();
      removed.click();

      expect(changes).toEqual([]);
      expect(field().value).toBe("");
      expect(valueLabel().textContent).toBe(initialLabel);
    });

    it("falls back to the previous survivor when the active option was last", async () => {
      triggerKey("ArrowDown");
      triggerKey("End"); // Cherry
      const removedActive = options()[2] as HTMLElement;

      removedActive.remove();
      await tick();

      expect(active()).toBe("opt-2");
      expect(activeMarkerIds()).toEqual(["opt-2"]);
      expect(removedActive.hasAttribute("data-active")).toBe(false);

      triggerKey("Enter");
      expect(field().value).toBe("banana");
    });

    it("transfers active identity and commit ownership to a same-id replacement", async () => {
      triggerKey("ArrowDown");
      triggerKey("ArrowDown"); // Banana
      const original = options()[1] as HTMLElement;
      const replacement = document.createElement("li");
      replacement.id = original.id;
      replacement.setAttribute("role", "option");
      replacement.setAttribute("aria-selected", "false");
      replacement.dataset.value = "plantain";
      replacement.setAttribute("data-stimeo--listbox-target", "option");
      replacement.setAttribute("data-action", "click->stimeo--listbox#select");
      replacement.textContent = "Plantain";

      original.replaceWith(replacement);
      await tick();

      expect(active()).toBe("opt-2");
      expect(activeMarkerIds()).toEqual(["opt-2"]);
      expect(replacement.hasAttribute("data-active")).toBe(true);
      expect(original.hasAttribute("data-active")).toBe(false);

      triggerKey("Enter");
      expect(field().value).toBe("plantain");
      expect(valueLabel().textContent).toBe("Plantain");
    });

    it("does not adopt a stale active marker from a different-id replacement", () => {
      triggerKey("ArrowDown");
      triggerKey("ArrowDown"); // Banana
      const original = options()[1] as HTMLElement;
      const replacement = document.createElement("li");
      replacement.id = "opt-replacement";
      replacement.setAttribute("role", "option");
      replacement.setAttribute("aria-selected", "false");
      replacement.setAttribute("data-active", "");
      replacement.dataset.value = "replacement";
      replacement.setAttribute("data-stimeo--listbox-target", "option");
      replacement.setAttribute("data-action", "click->stimeo--listbox#select");
      replacement.textContent = "Replacement";

      original.replaceWith(replacement);
      triggerKey("Enter");

      expect(field().value).toBe("cherry");
      expect(valueLabel().textContent).toBe("Cherry");
    });

    it("clears active state and makes commit keys inert after the last option is removed", async () => {
      for (const option of options().slice(1)) option.remove();
      await tick();
      triggerKey("ArrowDown"); // Apple is the only option.
      const last = options()[0] as HTMLElement;
      const changes: unknown[] = [];
      root().addEventListener("stimeo--listbox:change", (event) => changes.push(event));

      last.remove();
      await tick();

      expect(active()).toBeNull();
      expect(activeMarkerIds()).toEqual([]);
      expect(last.hasAttribute("data-active")).toBe(false);

      triggerKey("Enter");
      triggerKey(" ");
      expect(changes).toEqual([]);
      expect(field().value).toBe("");
      expect(listEl().hidden).toBe(false);
    });

    it.each(["Enter", " "])(
      "does not commit a shifted option on synchronous %s before target callbacks run",
      (key) => {
        triggerKey("ArrowDown");
        triggerKey("ArrowDown"); // Banana

        options()[0]?.remove();
        triggerKey(key);

        expect(field().value).toBe("banana");
        expect(valueLabel().textContent).toBe("Banana");
      },
    );
  });

  describe("the authored initial selection", () => {
    /**
     * Mounts a fresh listbox whose options carry `attrs[i]` instead of the
     * default `aria-selected="false"`, so each case can describe the exact DOM a
     * server might render.
     */
    const startWith = async (attrs: readonly string[]) => {
      disconnectAndStopApplication(application);
      const opts = ["apple", "banana", "cherry"]
        .map(
          (value, i) => `
          <li id="opt2-${i + 1}" role="option" ${attrs[i] ?? ""} data-value="${value}"
              data-stimeo--listbox-target="option"
              data-action="click->stimeo--listbox#select">${value[0]?.toUpperCase()}${value.slice(1)}</li>`,
        )
        .join("");
      document.body.innerHTML = `
        <div data-controller="stimeo--listbox">
          <button type="button" data-stimeo--listbox-target="trigger" aria-haspopup="listbox"
                  aria-expanded="false" aria-controls="lb-list2"
                  data-action="click->stimeo--listbox#toggle keydown->stimeo--listbox#onKeydown">
            <span data-stimeo--listbox-target="value">Choose…</span>
          </button>
          <ul id="lb-list2" role="listbox" aria-label="Options" hidden
              data-stimeo--listbox-target="list">${opts}</ul>
          <input type="hidden" data-stimeo--listbox-target="field" />
        </div>`;
      application = Application.start();
      application.register("stimeo--listbox", ListboxController);
      await tick();
    };

    it("derives the trigger label and the hidden field from it", async () => {
      // The failure this guards is silent data loss: the popup announces Banana
      // as selected, the trigger still reads "Choose…", and the form posts "".
      await startWith(["", 'aria-selected="true"', ""]);

      expect(valueLabel().textContent).toBe("Banana");
      expect(field().value).toBe("banana");
    });

    it("gives every option an explicit value", async () => {
      // An absent `aria-selected` means "not selectable" in ARIA, so a forgotten
      // attribute hides a selectable option from assistive technology.
      await startWith(["", "", ""]);

      expect(selected()).toEqual(["false", "false", "false"]);
    });

    it("keeps the first of several selected options and drops the rest", async () => {
      await startWith(['aria-selected="true"', 'aria-selected="true"', ""]);

      expect(selected()).toEqual(["true", "false", "false"]);
      expect(field().value).toBe("apple");
    });

    it("does not emit change while describing the initial state", async () => {
      const seen: unknown[] = [];
      document.addEventListener("change", (event) => seen.push(event));
      await startWith(["", 'aria-selected="true"', ""]);
      document.removeEventListener("change", (event) => seen.push(event));

      expect(seen).toEqual([]);
    });

    it("re-establishes the baseline for an option added after connect", async () => {
      await startWith(['aria-selected="true"', "", ""]);
      const late = document.createElement("li");
      late.id = "opt2-late";
      late.setAttribute("role", "option");
      late.dataset.value = "date";
      late.setAttribute("data-stimeo--listbox-target", "option");
      late.textContent = "Date";
      listEl().appendChild(late);
      await tick();

      expect(selected()).toEqual(["true", "false", "false", "false"]);
    });

    it("does not touch a role=option without the target", async () => {
      // The scan is the target set: an option outside the contract is neither
      // counted for uniqueness nor written to.
      await startWith(['aria-selected="true"', "", ""]);
      const stray = document.createElement("li");
      stray.setAttribute("role", "option");
      stray.setAttribute("aria-selected", "true");
      stray.textContent = "Stray";
      listEl().appendChild(stray);
      await tick();

      expect(stray.getAttribute("aria-selected")).toBe("true");
      expect(selected()).toEqual(["true", "false", "false"]);
    });
  });

  describe("an option added before the active one", () => {
    it("keeps the active identity, so Enter commits what AT announced", async () => {
      // The active option is a stable id, not a position index, so prepending an
      // option leaves `aria-activedescendant` and what Enter commits in agreement.
      // This pins the *addition* side of that identity.
      triggerKey("ArrowDown"); // opens and activates
      triggerKey("ArrowDown");
      const active = trigger().getAttribute("aria-activedescendant");
      expect(active).toBeTruthy();

      const late = document.createElement("li");
      late.id = "opt-late";
      late.setAttribute("role", "option");
      late.dataset.value = "late";
      late.setAttribute("data-stimeo--listbox-target", "option");
      late.setAttribute("data-action", "click->stimeo--listbox#select");
      late.textContent = "Late";
      listEl().prepend(late);
      await tick();

      expect(trigger().getAttribute("aria-activedescendant")).toBe(active);
      // Strict: assert against the option the active id names, so committing its
      // *neighbour* fails — a mere `!== "late"` check would not.
      const expected = document.getElementById(active as string) as HTMLElement;
      triggerKey("Enter");
      expect(field().value).toBe(expected.dataset.value);
    });
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
    disconnectAndStopApplication(application);
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

  it("navigates into options appended after an empty open", async () => {
    key("ArrowDown"); // opens with nothing to activate
    ["First", "Second"].forEach((label, index) => {
      const option = document.createElement("li");
      option.id = `late-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.dataset.value = label.toLowerCase();
      option.setAttribute("data-stimeo--listbox-target", "option");
      option.textContent = label;
      listEl().append(option);
    });
    await tick();

    // ArrowUp with nothing active enters at the END of the list; entering at the
    // top instead is indistinguishable while only one option exists.
    key("ArrowUp");
    expect(trigger().getAttribute("aria-activedescendant")).toBe("late-1");
  });
});

/**
 * Two markup shapes the contract allows but the default fixture does not carry:
 * a list the author left open, and a listbox with no hidden field to mirror into.
 */
describe("ListboxController markup variants", () => {
  let application: Application;

  const start = async (html: string) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--listbox", ListboxController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const trigger = () =>
    document.querySelector<HTMLElement>("[data-stimeo--listbox-target='trigger']") as HTMLElement;
  const listEl = () =>
    document.querySelector<HTMLElement>("[data-stimeo--listbox-target='list']") as HTMLElement;

  it("closes a list the markup left open", async () => {
    // Everything downstream reads the closed baseline, so connect owns it rather
    // than trusting whatever state the server rendered.
    await start(`
      <div data-controller="stimeo--listbox">
        <span id="open-label">Fruit</span>
        <button type="button" role="combobox" aria-haspopup="listbox" aria-expanded="true"
                aria-controls="open-list" aria-labelledby="open-label"
                data-stimeo--listbox-target="trigger"
                data-action="keydown->stimeo--listbox#onTriggerKeydown">Pick</button>
        <ul id="open-list" role="listbox" aria-label="Fruit"
            data-stimeo--listbox-target="list">
          <li id="open-1" role="option" aria-selected="false" data-value="apple"
              data-stimeo--listbox-target="option">Apple</li>
        </ul>
      </div>`);

    expect(listEl().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("selects without a hidden field to mirror into", async () => {
    await start(`
      <div data-controller="stimeo--listbox">
        <span id="bare-label">Fruit</span>
        <button type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false"
                aria-controls="bare-list" aria-labelledby="bare-label bare-value"
                data-stimeo--listbox-target="trigger"
                data-action="click->stimeo--listbox#toggle
                             keydown->stimeo--listbox#onTriggerKeydown">
          <span id="bare-value" data-stimeo--listbox-target="value">Choose…</span>
        </button>
        <ul id="bare-list" role="listbox" aria-label="Fruit" hidden
            data-stimeo--listbox-target="list">
          <li id="bare-1" role="option" aria-selected="false" data-value="apple"
              data-stimeo--listbox-target="option"
              data-action="click->stimeo--listbox#select">Apple</li>
        </ul>
      </div>`);

    const changes: string[] = [];
    const root = document.querySelector("[data-controller='stimeo--listbox']") as HTMLElement;
    root.addEventListener("stimeo--listbox:change", (event) => {
      changes.push((event as CustomEvent).detail.value);
    });

    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    document.getElementById("bare-1")?.click();

    // The field is optional: reaching for it anyway throws mid-selection, so the
    // event and the close that follow it are what prove the guard is still there.
    expect(changes).toEqual(["apple"]);
    expect(document.getElementById("bare-value")?.textContent).toBe("Apple");
    expect(listEl().hidden).toBe(true);
  });
});

/**
 * The active marker moves on every arrow press, so its cost has to stay
 * independent of how many options the consumer supplies.
 */
describe("ListboxController active-marker writes", () => {
  let application: Application;

  beforeEach(async () => {
    const items = Array.from(
      { length: 20 },
      (_, index) =>
        `<li id="big-${index}" role="option" aria-selected="false" data-value="v${index}"
             data-stimeo--listbox-target="option">Item ${index}</li>`,
    ).join("");
    document.body.innerHTML = `
      <div data-controller="stimeo--listbox">
        <span id="big-label">Many</span>
        <button type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false"
                aria-controls="big-list" aria-labelledby="big-label"
                data-stimeo--listbox-target="trigger"
                data-action="keydown->stimeo--listbox#onTriggerKeydown">Pick</button>
        <ul id="big-list" role="listbox" aria-label="Many" hidden
            data-stimeo--listbox-target="list">${items}</ul>
      </div>`;
    application = Application.start();
    application.register("stimeo--listbox", ListboxController);
    await tick();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("writes the marker only where it changes, whatever the option count", () => {
    const trigger = document.querySelector<HTMLElement>(
      "[data-stimeo--listbox-target='trigger']",
    ) as HTMLElement;
    const items = Array.from(
      document.querySelectorAll<HTMLElement>("[data-stimeo--listbox-target='option']"),
    );
    const arrowDown = () =>
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    trigger.focus();
    arrowDown(); // opens on the first option

    let writes = 0;
    for (const item of items) {
      const setAttribute = item.setAttribute.bind(item);
      const removeAttribute = item.removeAttribute.bind(item);
      vi.spyOn(item, "setAttribute").mockImplementation((name, value) => {
        if (name === "data-active") writes += 1;
        setAttribute(name, value);
      });
      vi.spyOn(item, "removeAttribute").mockImplementation((name) => {
        if (name === "data-active") writes += 1;
        removeAttribute(name);
      });
    }

    arrowDown(); // moves the marker one option along

    // One marker off, one marker on — never one call per option.
    expect(writes).toBe(2);
    expect(items.filter((item) => item.hasAttribute("data-active"))).toHaveLength(1);
    expect(items[1]?.hasAttribute("data-active")).toBe(true);
  });
});

/**
 * Typeahead runs on the shared {@link Typeahead} primitive. The fixture carries
 * repeated first letters and an `aria-label` that disagrees with the visible
 * text, the two contracts under test: a repeated key cycles through the matches
 * instead of growing the query, and matching reads the accessible name.
 */
describe("ListboxController typeahead", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--listbox">
        <span id="ta-label">Command</span>
        <button type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false"
                aria-controls="ta-list" aria-labelledby="ta-label"
                data-stimeo--listbox-target="trigger"
                data-action="click->stimeo--listbox#toggle
                             keydown->stimeo--listbox#onTriggerKeydown">Choose…</button>
        <ul id="ta-list" role="listbox" aria-label="Commands" hidden
            data-stimeo--listbox-target="list">
          <li id="ta-1" role="option" aria-selected="false" data-value="save"
              data-stimeo--listbox-target="option">Save</li>
          <li id="ta-2" role="option" aria-selected="false" data-value="save-as"
              data-stimeo--listbox-target="option">Save as…</li>
          <li id="ta-3" role="option" aria-selected="false" data-value="send"
              data-stimeo--listbox-target="option">Send</li>
          <li id="ta-4" role="option" aria-selected="false" data-value="misc"
              aria-label="Zeta" data-stimeo--listbox-target="option">Archive</li>
        </ul>
      </div>`;
    application = Application.start();
    application.register("stimeo--listbox", ListboxController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const trigger = () =>
    document.querySelector<HTMLElement>("[data-stimeo--listbox-target='trigger']") as HTMLElement;
  const active = () => trigger().getAttribute("aria-activedescendant");
  const key = (k: string, init: KeyboardEventInit = {}) =>
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));

  it("cycles through the options sharing a first letter when the key repeats", () => {
    key("ArrowDown"); // open, activates ta-1
    key("s");
    expect(active()).toBe("ta-2"); // search resumes after the active option
    key("s");
    expect(active()).toBe("ta-3");
    key("s");
    expect(active()).toBe("ta-1"); // wraps
  });

  it("resumes narrowing after a repeat instead of stalling on a dead query", () => {
    vi.useFakeTimers();
    try {
      key("ArrowDown"); // open, activates ta-1
      key("s");
      expect(active()).toBe("ta-2");
      key("s");
      expect(active()).toBe("ta-3"); // repeat: the query stays "s"
      key("e");
      expect(active()).toBe("ta-3"); // "se" -> Send, the only match
    } finally {
      vi.useRealTimers();
    }
  });

  it("narrows to a multi-character prefix while the query is fresh", () => {
    vi.useFakeTimers();
    try {
      key("ArrowDown"); // open, activates ta-1
      key("s");
      expect(active()).toBe("ta-2"); // Save as…
      vi.advanceTimersByTime(400); // still inside the idle window
      key("e");
      expect(active()).toBe("ta-3"); // "se" -> Send
    } finally {
      vi.useRealTimers();
    }
  });

  it("matches the authored aria-label rather than the visible text", () => {
    key("ArrowDown"); // open, activates ta-1
    key("z");
    expect(active()).toBe("ta-4");

    key("Escape");
    key("ArrowDown"); // re-open with a fresh query
    key("a");
    expect(active()).toBe("ta-1"); // "Archive" is named Zeta, so nothing matches "a"
  });

  it("reaches an option whose aria-label is blank by its visible text", () => {
    // accname skips a whitespace-only aria-label, so a screen reader announces
    // "Send" here — type-ahead must agree.
    document.querySelector("#ta-3")?.setAttribute("aria-label", "  ");

    key("ArrowDown"); // open, activates ta-1
    key("s");
    expect(active()).toBe("ta-2");
    key("s");
    expect(active()).toBe("ta-3"); // still reachable by its own text
  });

  it("leaves the active option alone when nothing matches", () => {
    key("ArrowDown"); // open, activates ta-1
    key("q");
    expect(active()).toBe("ta-1");
  });

  it("ignores printable keys pressed with a command modifier", () => {
    key("ArrowDown"); // open, activates ta-1
    key("s", { ctrlKey: true });
    expect(active()).toBe("ta-1");
  });

  it("drops the pending idle reset on disconnect", () => {
    vi.useFakeTimers();
    try {
      key("ArrowDown"); // open
      key("s"); // arms the idle reset
      expect(vi.getTimerCount()).toBe(1);

      disconnectAndStopApplication(application);
      // The typeahead owns its own registry, so `#timers.clearAll()` alone would
      // leave this timer to fire against a detached controller.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
