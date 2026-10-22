import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NumberInputController } from "../src/controllers/number_input_controller";
import * as steppedValue from "../src/utils/stepped_value";
import { expectNoA11yViolations } from "./helpers/a11y";
import { composeDraft } from "./helpers/ime";
import { press as keyboardPress, keyEvent, typeKey } from "./helpers/keyboard";
import { recordListeners } from "./helpers/listeners";
import { captureSpeech } from "./helpers/speech";
import {
  disconnectAndStopApplication,
  reconnectKeepingFocus,
  restoreFromCache,
} from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link NumberInputController}: the APG Spinbutton contract
 * — step increment/decrement, range clamping and step snapping, PageUp/PageDown,
 * Home/End, bound-disabled buttons, focus retention, the `change` event, and the
 * `reconcile` event for a number the page moves.
 */

describe("NumberInputController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--number-input"
           data-stimeo--number-input-min-value="0"
           data-stimeo--number-input-max-value="100"
           data-stimeo--number-input-step-value="10">
        <button type="button" aria-label="Decrease" tabindex="-1"
                data-stimeo--number-input-target="decrement"
                data-action="click->stimeo--number-input#decrement">−</button>
        <input type="number" min="0" max="100" step="10" value="0" aria-label="Quantity"
               data-stimeo--number-input-target="input"
               data-action="change->stimeo--number-input#onInput
                            keydown->stimeo--number-input#onKeydown" />
        <button type="button" aria-label="Increase" tabindex="-1"
                data-stimeo--number-input-target="increment"
                data-action="click->stimeo--number-input#increment">+</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--number-input", NumberInputController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--number-input']") as HTMLElement;
  const input = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--number-input-target='input']",
    ) as HTMLInputElement;
  const incrementBtn = () =>
    document.querySelector<HTMLButtonElement>(
      "[data-stimeo--number-input-target='increment']",
    ) as HTMLButtonElement;
  const decrementBtn = () =>
    document.querySelector<HTMLButtonElement>(
      "[data-stimeo--number-input-target='decrement']",
    ) as HTMLButtonElement;
  const press = (k: string) => keyboardPress(input(), k);
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--number-input",
    ) as NumberInputController;

  /** Native form events seen on the input, in dispatch order. */
  const nativeEvents = (): string[] => {
    const seen: string[] = [];
    for (const type of ["input", "change"]) {
      input().addEventListener(type, () => seen.push(type));
    }
    return seen;
  };

  /** The controller's own `change` detail values, in dispatch order. */
  const customChanges = (): unknown[] => {
    const seen: unknown[] = [];
    root().addEventListener("stimeo--number-input:change", (event) => {
      seen.push((event as CustomEvent).detail.value);
    });
    return seen;
  };

  // A native `<input type="number">` reports arrow and spinner edits as `input`
  // then `change`. This widget owns that stepping, so it owes the same pair on
  // the same element — a form listening for either otherwise never hears the edit.

  it.each(
    ["Home", "End"].flatMap((key) =>
      (["altKey", "ctrlKey", "metaKey", "shiftKey"] as const).map((modifier) => ({
        key,
        modifier,
      })),
    ),
  )(
    "yields modified boundary key $modifier+$key without changing widget state",
    async ({ key, modifier }) => {
      press("ArrowUp");
      const native = nativeEvents();
      const custom = customChanges();
      const before = root().innerHTML;
      const event = keyboardPress(input(), key, { [modifier]: true });
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(input());
      expect(root().innerHTML).toBe(before);
      expect(input().value).toBe("10");
      expect(input().min).toBe("0");
      expect(input().max).toBe("100");
      expect(input().step).toBe("10");
      expect(native).toEqual([]);
      expect(custom).toEqual([]);
    },
  );

  it.each(["replace", "read", "repeat"])(
    "keeps native and widget reports current after an input listener: %s",
    (mode) => {
      const native = nativeEvents();
      const custom = customChanges();
      let handled = false;
      input().addEventListener(
        "input",
        () => {
          if (handled) return;
          handled = true;
          if (mode === "replace") press("Home");
          if (mode === "repeat") press("End");
        },
        { once: true },
      );
      press("End");
      expect(native).toEqual(
        mode === "replace" ? ["input", "input", "change"] : ["input", "change"],
      );
      expect(custom).toEqual([mode === "replace" ? 0 : 100]);
    },
  );

  it.each(["a", "b"])(
    "compares a pending field edit with the last confirmed number: %s",
    (mode) => {
      const custom = customChanges();
      const native = nativeEvents();
      input().value = mode === "a" ? "100" : "20";
      press(mode === "a" ? "End" : "Home");
      expect(custom).toEqual(mode === "a" ? [100] : []);
      expect(native).toEqual(mode === "a" ? [] : ["input", "change"]);
    },
  );

  it("withholds native reports for a value superseded during focus rescue", () => {
    const native = nativeEvents();
    const custom = customChanges();
    incrementBtn().focus();
    input().addEventListener("focus", () => press("ArrowDown"), { once: true });
    // Keep step-button focus while the bound handler rescues it during reconciliation.
    typeKey(input(), "End");
    expect(input().value).toBe("90");
    expect(native).toEqual(["input", "change"]);
    expect(custom).toEqual([90]);
  });

  it("withholds a widget report replaced by a native change listener", () => {
    const custom = customChanges();
    let handled = false;
    input().addEventListener("change", () => {
      if (handled) return;
      handled = true;
      press("Home");
    });
    press("End");
    expect(custom).toEqual([0]);
  });

  it("preserves both button directions when an increment focus rescue reenters", () => {
    incrementBtn().focus();
    input().addEventListener("focus", () => press("Home"), { once: true });
    // Keep step-button focus while the bound handler rescues it during reconciliation.
    typeKey(input(), "End");
    expect(incrementBtn().disabled).toBe(false);
    expect(decrementBtn().disabled).toBe(true);
  });

  it("preserves remaining decrement buttons after a decrement focus rescue reenters", async () => {
    const second = decrementBtn().cloneNode(true) as HTMLButtonElement;
    root().append(second);
    await tick();
    press("End");
    decrementBtn().focus();
    input().addEventListener(
      "focus",
      () => {
        press("End");
        second.focus();
      },
      { once: true },
    );
    // Keep step-button focus while the bound handler rescues it during reconciliation.
    typeKey(input(), "Home");
    expect(decrementBtn().disabled).toBe(false);
    expect(second.disabled).toBe(false);
    expect(document.activeElement).toBe(second);
    expect(incrementBtn().disabled).toBe(true);
  });

  it("does not reconcile a number already replaced by a focus listener", async () => {
    const seen: string[] = [];
    root().addEventListener("stimeo--number-input:reconcile", () => seen.push("reconcile"));
    root().addEventListener("stimeo--number-input:change", () => seen.push("change"));
    incrementBtn().focus();
    input().addEventListener(
      "focus",
      () => {
        root().setAttribute("data-stimeo--number-input-max-value", "100");
        press("End");
      },
      { once: true },
    );
    root().setAttribute("data-stimeo--number-input-max-value", "0");
    await tick();
    expect(input().value).toBe("100");
    expect(seen).toEqual(["change"]);
  });

  it("keeps a newer value and enabled button when focus reenters while reaching a bound", () => {
    const custom = customChanges();
    incrementBtn().focus();
    input().addEventListener("focus", () => press("Home"), { once: true });
    // Keep step-button focus while the bound handler rescues it during reconciliation.
    typeKey(input(), "End");
    expect(custom).toEqual([0]);
    expect(input().value).toBe("0");
    expect(incrementBtn().disabled).toBe(false);
  });

  it("reports a button step the way the browser reports its own", () => {
    const native = nativeEvents();
    const custom = customChanges();

    incrementBtn().click();

    expect(input().value).toBe("10");
    expect(native).toEqual(["input", "change"]);
    expect(custom).toEqual([10]);
  });

  it("reports an arrow-key step the same way", () => {
    const native = nativeEvents();

    press("ArrowUp");

    expect(input().value).toBe("10");
    expect(native).toEqual(["input", "change"]);
  });

  it("stays silent on a step the bounds refuse", () => {
    const native = nativeEvents();

    press("ArrowDown"); // already at the minimum

    expect(input().value).toBe("0");
    expect(native).toEqual([]);
  });

  // The synthesized `change` re-enters the widget through its own markup
  // contract; the committed value is settled before it is dispatched, so the
  // re-entry finds nothing to commit and stops there.
  it("does not commit twice when its own change re-enters", () => {
    const custom = customChanges();

    incrementBtn().click();

    expect(custom).toEqual([10]);
    expect(input().value).toBe("10");
  });

  // The browser reports what its control shows. Typing leaves an entry the widget
  // has not accepted yet, and a step from there still moves the control's value —
  // so the form has to hear it, even though the committed number did not move and
  // `change` (which means "the user settled on a number") stays quiet.
  it("reports a step that moves the field away from an unconfirmed entry", () => {
    press("ArrowUp"); // settle on 10 so the step below lands back on it
    const native = nativeEvents();
    const custom = customChanges();

    input().value = "15"; // typed, never confirmed: no native `change` yet
    press("ArrowDown"); // steps from 15 back down to 10

    expect(input().value).toBe("10");
    expect(native).toEqual(["input", "change"]);
    // The settled number never moved, so this is not a value the user chose.
    expect(custom).toEqual([]);
  });

  // Typing is bound to the native `change`, so the browser has already reported
  // this edit; adding another pair would double every keystroke a form sees.
  it("adds nothing to an edit the browser already reported", () => {
    const native = nativeEvents();

    input().value = "40";
    input().dispatchEvent(new Event("change", { bubbles: true }));

    expect(input().value).toBe("40");
    expect(native).toEqual(["change"]);
  });

  it("disables the decrement button at the minimum on connect", () => {
    expect(input().value).toBe("0");
    expect(decrementBtn().disabled).toBe(true);
    expect(incrementBtn().disabled).toBe(false);
  });

  it("stays inert without an input target across lifecycle and public actions", async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = `
      <div data-controller="stimeo--number-input"
           data-stimeo--number-input-min-value="0">
        <button type="button" data-stimeo--number-input-target="increment">+</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--number-input", NumberInputController);
    await tick();
    const orphanRoot = document.querySelector<HTMLElement>(
      "[data-controller='stimeo--number-input']",
    ) as HTMLElement;
    const orphanButton = orphanRoot.querySelector("button") as HTMLButtonElement;
    const orphanController = application.getControllerForElementAndIdentifier(
      orphanRoot,
      "stimeo--number-input",
    ) as NumberInputController;
    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    const keydown = keyEvent("ArrowUp");

    expect(() => orphanButton.dispatchEvent(down)).not.toThrow();
    expect(down.defaultPrevented).toBe(false);
    expect(() => {
      orphanController.increment();
      orphanController.decrement();
      orphanController.onInput();
      orphanController.onKeydown(keydown);
    }).not.toThrow();
    expect(keydown.defaultPrevented).toBe(false);
    orphanRoot.setAttribute("data-stimeo--number-input-min-value", "10");
    await flushMicrotasks();
  });

  it("never re-enables an author-disabled step button", async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = `
      <div data-controller="stimeo--number-input"
           data-stimeo--number-input-min-value="0"
           data-stimeo--number-input-max-value="100"
           data-stimeo--number-input-step-value="10">
        <button type="button" data-stimeo--number-input-target="decrement"
                data-action="click->stimeo--number-input#decrement">−</button>
        <input type="number" value="100" aria-label="Quantity"
               data-stimeo--number-input-target="input"
               data-action="keydown->stimeo--number-input#onKeydown" />
        <button type="button" disabled data-stimeo--number-input-target="increment"
                data-action="click->stimeo--number-input#increment">+</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--number-input", NumberInputController);
    await tick();
    // Step down off the max so the controller would normally re-enable increment;
    // because the author disabled it (no marker), it must stay disabled.
    decrementBtn().click();
    expect(input().value).toBe("90");
    expect(incrementBtn().disabled).toBe(true);

    controller().disconnect();
    expect(incrementBtn().disabled).toBe(true);
  });

  it("steps with the increment and decrement buttons", () => {
    incrementBtn().click();
    expect(input().value).toBe("10");
    expect(decrementBtn().disabled).toBe(false);
    decrementBtn().click();
    expect(input().value).toBe("0");
  });

  it("leaves a modified arrow to the browser", () => {
    // A chorded arrow belongs to the browser or the OS, so the spinbutton must
    // neither consume the press nor step its value.
    const chord = keyEvent("ArrowUp", { altKey: true });
    const changes = vi.fn();
    root().addEventListener("stimeo--number-input:change", changes);
    keyboardPress(input(), chord);

    expect(chord.defaultPrevented).toBe(false);
    // A real number input may now run its native step behavior; happy-dom does
    // not model that browser action. The controller contract is the two facts
    // above: it neither consumes the key nor publishes a controller commit.
    expect(changes).not.toHaveBeenCalled();
  });

  it("steps with ArrowUp and ArrowDown", () => {
    press("ArrowUp");
    expect(input().value).toBe("10");
    press("ArrowDown");
    expect(input().value).toBe("0");
  });

  it.each(
    (["PageUp", "PageDown"] as const).flatMap((key) =>
      (
        [
          ["Alt", { altKey: true }],
          ["Ctrl", { ctrlKey: true }],
          ["Meta", { metaKey: true }],
          ["Shift", { shiftKey: true }],
          ["Alt+Shift", { altKey: true, shiftKey: true }],
          ["Ctrl+Shift", { ctrlKey: true, shiftKey: true }],
          ["Meta+Shift", { metaKey: true, shiftKey: true }],
        ] as const
      ).map(([modifier, init]) => [key, modifier, init] as const),
    ),
  )("yields an unassigned Page chord (%s, %s)", async (key, _modifier, init) => {
    press("ArrowUp");
    const native = nativeEvents();
    const custom = customChanges();
    const reconciled: Event[] = [];
    root().addEventListener("stimeo--number-input:reconcile", (event) => reconciled.push(event));
    const before = root().outerHTML;
    const rejected = keyboardPress(input(), key, init);
    expect(rejected.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input());
    expect(root().outerHTML).toBe(before);
    expect(input().value).toBe("10");
    expect(native).toEqual([]);
    expect(custom).toEqual([]);
    expect(reconciled).toEqual([]);

    expect(keyboardPress(input(), key).defaultPrevented).toBe(true);
    const expected = key === "PageUp" ? 100 : 0;
    expect(input().value).toBe(String(expected));
    expect(document.activeElement).toBe(input());
    expect(native).toEqual(["input", "change"]);
    expect(custom).toEqual([expected]);
    expect(reconciled).toEqual([]);
  });

  it("moves by the page step with PageUp/PageDown", () => {
    press("PageUp"); // step*10 = 100, clamped to max
    expect(input().value).toBe("100");
    press("PageDown");
    expect(input().value).toBe("0");
  });

  it.each(["-2", "NaN", "Infinity"])(
    "uses ten fractional steps for invalid pageStep %s and publishes finite values",
    (raw) => {
      root().setAttribute("data-stimeo--number-input-step-value", "0.5");
      root().setAttribute("data-stimeo--number-input-page-step-value", raw);
      const seen: Array<[string, string, number]> = [];
      const read = (type: string) => seen.push([type, input().value, input().valueAsNumber]);
      input().addEventListener("input", () => read("input"));
      input().addEventListener("change", () => read("native"));
      root().addEventListener("stimeo--number-input:change", () => read("change"));

      press("PageUp");
      press("PageDown");

      expect(seen).toEqual([
        ["input", "5", 5],
        ["native", "5", 5],
        ["change", "5", 5],
        ["input", "0", 0],
        ["native", "0", 0],
        ["change", "0", 0],
      ]);
      expect(input().value).toBe("0");
      expect(decrementBtn().disabled).toBe(true);
      expect(incrementBtn().disabled).toBe(false);
      expect(root().getAttribute("data-stimeo--number-input-page-step-value")).toBe(raw);
    },
  );

  it("uses an authored page step in both directions", () => {
    root().setAttribute("data-stimeo--number-input-page-step-value", "25");
    input().value = "50";

    press("PageUp");
    expect(input().value).toBe("80");
    press("PageDown");
    expect(input().value).toBe("60");
  });

  it("jumps to min/max with Home/End", () => {
    press("End");
    expect(input().value).toBe("100");
    expect(incrementBtn().disabled).toBe(true);
    press("Home");
    expect(input().value).toBe("0");
  });

  it("reports a value pulled down by a runtime max as reconcile, not change", async () => {
    press("End");
    expect(input().value).toBe("100");
    const changes: unknown[] = [];
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--number-input:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    root().addEventListener("stimeo--number-input:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });

    // The page narrows the range; the committed number follows by this
    // controller's clamp, not by anything the user typed.
    root().setAttribute("data-stimeo--number-input-max-value", "40");
    controller().maxValueChanged();
    await flushMicrotasks();

    expect(input().value).toBe("40");
    expect(repairs).toEqual([{ value: 40 }]);
    expect(changes).toEqual([]);
  });

  it("leaves Home and End unhandled when their bounds are infinite", async () => {
    root().removeAttribute("data-stimeo--number-input-min-value");
    root().removeAttribute("data-stimeo--number-input-max-value");
    input().value = "50";
    controller().minValueChanged();
    controller().maxValueChanged();
    await flushMicrotasks();

    for (const key of ["Home", "End"]) {
      const event = keyEvent(key);
      keyboardPress(input(), event);
      expect(event.defaultPrevented).toBe(false);
      expect(input().value).toBe("50");
    }
  });

  it("reaches an off-grid maximum through keyboard and button stepping", async () => {
    root().setAttribute("data-stimeo--number-input-max-value", "94");
    input().value = "90";
    controller().maxValueChanged();
    await flushMicrotasks();

    press("End");
    expect(input().value).toBe("94");
    press("ArrowDown");
    expect(input().value).toBe("90");
    incrementBtn().click();
    expect(input().value).toBe("94");
    expect(incrementBtn().disabled).toBe(true);
  });

  it("uses step one when an invalid step is supplied", async () => {
    root().setAttribute("data-stimeo--number-input-step-value", "0");
    input().value = "2.6";
    controller().stepValueChanged();
    await flushMicrotasks();

    expect(input().value).toBe("3");
    incrementBtn().click();
    expect(input().value).toBe("4");
  });

  it("uses step one when no step Value is authored", async () => {
    root().removeAttribute("data-stimeo--number-input-step-value");
    input().value = "2";
    await flushMicrotasks();

    incrementBtn().click();

    expect(input().value).toBe("3");
  });

  it("disables a step button at its bound again when a morph enabled it mid-composition", async () => {
    expect(decrementBtn().disabled).toBe(true);
    input().focus();
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input(), "5");

    // A morph renders the server's markup: the button enabled, without the mark.
    decrementBtn().disabled = false;
    decrementBtn().removeAttribute("data-number-input-disabled");
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await flushMicrotasks();

    expect(input().value).toBe("5");
    expect(decrementBtn().disabled).toBe(true);
  });

  it("disables a step button at its bound again when a morph enabled it mid-composition in a blank field", async () => {
    input().value = "";
    input().dispatchEvent(new Event("change", { bubbles: true }));
    expect(decrementBtn().disabled).toBe(true);
    input().focus();
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input(), "5");

    // A morph renders the server's markup: the button enabled, without the mark.
    decrementBtn().disabled = false;
    decrementBtn().removeAttribute("data-number-input-disabled");
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await flushMicrotasks();

    expect(input().value).toBe("5");
    expect(decrementBtn().disabled).toBe(true);
  });

  it("keeps a step button as it showed it while a range change waits for the composition", async () => {
    // At the minimum, decrement is disabled; a lower minimum waits with the conversion.
    expect(decrementBtn().disabled).toBe(true);
    input().focus();
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input(), "5");
    root().setAttribute("data-stimeo--number-input-min-value", "-50");
    await tick();

    expect(decrementBtn().disabled).toBe(true);
  });

  it("keeps a step button enabled as it showed it while a lower maximum waits for the composition", async () => {
    input().value = "50";
    input().dispatchEvent(new Event("change", { bubbles: true }));
    expect(incrementBtn().disabled).toBe(false);
    input().focus();
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input(), "5");
    root().setAttribute("data-stimeo--number-input-max-value", "50");
    await tick();

    expect(incrementBtn().disabled).toBe(false);
  });

  it("gives a step button swapped in mid-composition the state it shows, and holds nothing", async () => {
    const changes: unknown[] = [];
    const reconciles: unknown[] = [];
    root().addEventListener("stimeo--number-input:change", (event) =>
      changes.push((event as CustomEvent).detail),
    );
    root().addEventListener("stimeo--number-input:reconcile", (event) =>
      reconciles.push((event as CustomEvent).detail),
    );
    input().focus();
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input(), "2");

    const swapped = decrementBtn().cloneNode(true) as HTMLButtonElement;
    swapped.disabled = false;
    swapped.removeAttribute("data-number-input-disabled");
    decrementBtn().replaceWith(swapped);
    await tick();
    expect(decrementBtn().disabled).toBe(true);

    input().value = "20";
    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await tick();
    input().dispatchEvent(new Event("change", { bubbles: true }));

    expect(reconciles).toEqual([]);
    expect(changes).toEqual([{ value: 20 }]);
  });

  it("uses a runtime step change without rewiring button listeners", async () => {
    root().setAttribute("data-stimeo--number-input-step-value", "5");
    controller().stepValueChanged();
    await flushMicrotasks();

    incrementBtn().click();
    expect(input().value).toBe("5");
  });

  it("reconciles a morphed range without dispatching change", async () => {
    const changes = vi.fn();
    root().addEventListener("stimeo--number-input:change", changes);
    input().value = "90";
    root().setAttribute("data-stimeo--number-input-max-value", "54");
    root().setAttribute("data-stimeo--number-input-step-value", "5");
    controller().maxValueChanged();
    controller().stepValueChanged();
    await flushMicrotasks();

    expect(input().value).toBe("54");
    expect(incrementBtn().disabled).toBe(true);
    expect(changes).not.toHaveBeenCalled();

    input().dispatchEvent(new Event("change", { bubbles: true }));
    expect(changes).not.toHaveBeenCalled();
  });

  it("clamps at the maximum and disables increment there", () => {
    press("End");
    press("ArrowUp"); // stays at max
    expect(input().value).toBe("100");
    expect(incrementBtn().disabled).toBe(true);
  });

  it("snaps a typed value to the step grid on change", () => {
    input().value = "23";
    input().dispatchEvent(new Event("change", { bubbles: true }));
    expect(input().value).toBe("20");
  });

  it("dispatches once when an on-grid typed value changes semantically", () => {
    const values: number[] = [];
    root().addEventListener("stimeo--number-input:change", (event) => {
      values.push((event as CustomEvent<{ value: number }>).detail.value);
    });

    input().value = "50";
    input().dispatchEvent(new Event("change", { bubbles: true }));
    input().dispatchEvent(new Event("change", { bubbles: true }));
    input().value = "53"; // snaps back to the already committed 50
    input().dispatchEvent(new Event("change", { bubbles: true }));

    expect(input().value).toBe("50");
    expect(values).toEqual([50]);
  });

  it("treats blank as a new baseline without inventing a numeric change event", () => {
    const values: number[] = [];
    root().addEventListener("stimeo--number-input:change", (event) => {
      values.push((event as CustomEvent<{ value: number }>).detail.value);
    });
    input().value = "50";
    input().dispatchEvent(new Event("change", { bubbles: true }));
    input().value = "";
    input().dispatchEvent(new Event("change", { bubbles: true }));
    input().value = "50";
    input().dispatchEvent(new Event("change", { bubbles: true }));

    expect(values).toEqual([50, 50]);
  });

  it("preserves a blank input on change", () => {
    const changes = vi.fn();
    root().addEventListener("stimeo--number-input:change", changes);
    input().value = "";

    input().dispatchEvent(new Event("change", { bubbles: true }));

    expect(input().value).toBe("");
    expect(changes).not.toHaveBeenCalled();
  });

  it("leaves a native number field's text to the engine, which never holds full-width digits", () => {
    const changes = vi.fn();
    root().addEventListener("stimeo--number-input:change", changes);
    input().value = "30";
    input().dispatchEvent(new Event("change", { bubbles: true }));
    expect(changes).toHaveBeenCalledOnce();

    // A number field's value is a valid floating-point number or empty, so the
    // engine drops full-width text before the controller reads anything.
    input().value = "３４";
    expect(input().value).toBe("");
    input().dispatchEvent(new Event("change", { bubbles: true }));
    expect(input().value).toBe("");
    expect(changes).toHaveBeenCalledOnce();
  });

  it("uses the finite minimum to derive button state for a blank input", async () => {
    root().setAttribute("data-stimeo--number-input-min-value", "-10");
    input().value = "";
    controller().minValueChanged();
    await flushMicrotasks();

    expect(decrementBtn().disabled).toBe(true);
    expect(incrementBtn().disabled).toBe(false);
  });

  it("uses zero to derive button state for a blank unbounded input", async () => {
    root().removeAttribute("data-stimeo--number-input-min-value");
    root().removeAttribute("data-stimeo--number-input-max-value");
    input().value = "";
    controller().minValueChanged();
    controller().maxValueChanged();
    await flushMicrotasks();

    expect(decrementBtn().disabled).toBe(false);
    expect(incrementBtn().disabled).toBe(false);
  });

  it("keeps focus on the input after using a step button", () => {
    incrementBtn().click();
    expect(document.activeElement).toBe(input());
  });

  it("returns focus to the input before disabling a focused button", () => {
    input().value = "90";
    input().dispatchEvent(new Event("change", { bubbles: true }));
    incrementBtn().focus();
    const disabledStatesAtFocus: boolean[] = [];
    input().addEventListener("focus", () => disabledStatesAtFocus.push(incrementBtn().disabled));
    incrementBtn().click(); // 90 -> 100, increment becomes disabled
    expect(incrementBtn().disabled).toBe(true);
    expect(document.activeElement).toBe(input());
    expect(disabledStatesAtFocus).toEqual([false]);
  });

  /** Every `change` and `reconcile` value the root dispatches, in order. */
  const reports = () => {
    const seen: string[] = [];
    for (const type of ["change", "reconcile"]) {
      root().addEventListener(`stimeo--number-input:${type}`, (event) => {
        seen.push(`${type}:${(event as CustomEvent<{ value: number }>).detail.value}`);
      });
    }
    return seen;
  };

  /** Swaps the input for a copy holding `value`, the way a morph replaces it. */
  const replaceInput = (value: string) => {
    const replacement = input().cloneNode(true) as HTMLInputElement;
    replacement.value = value;
    input().replaceWith(replacement);
    return replacement;
  };

  it("reports a replaced input whose value moved as reconcile, and seeds its event baseline", async () => {
    const seen = reports();
    const replacement = replaceInput("23");
    await tick();

    expect(input()).toBe(replacement);
    expect(input().value).toBe("20");
    expect(decrementBtn().disabled).toBe(false);
    expect(seen).toEqual(["reconcile:20"]);

    input().dispatchEvent(new Event("change", { bubbles: true }));
    expect(seen).toEqual(["reconcile:20"]);
    press("ArrowUp");
    expect(input().value).toBe("30");
    expect(seen).toEqual(["reconcile:20", "change:30"]);

    replaceInput("100");
    await tick();
    expect(incrementBtn().disabled).toBe(true);
    expect(seen).toEqual(["reconcile:20", "change:30", "reconcile:100"]);
  });

  it("stays silent when a replaced input shows the value already committed", async () => {
    const seen = reports();

    replaceInput("0");
    await tick();

    expect(input().value).toBe("0");
    expect(seen).toEqual([]);
  });

  it("reports a replaced input that brings a number into a blank field", async () => {
    input().value = "";
    input().dispatchEvent(new Event("change", { bubbles: true }));
    const seen = reports();

    replaceInput("40");
    await tick();

    expect(seen).toEqual(["reconcile:40"]);
  });

  it("reports nothing when the page empties the field, as a user emptying it does", async () => {
    press("ArrowUp");
    const seen = reports();

    replaceInput("");
    await tick();
    expect(input().value).toBe("");
    expect(seen).toEqual([]);

    // A user emptying the field reports nothing either.
    replaceInput("30");
    await tick();
    input().value = "";
    input().dispatchEvent(new Event("change", { bubbles: true }));
    expect(seen).toEqual(["reconcile:30"]);

    replaceInput("40");
    await tick();
    expect(seen).toEqual(["reconcile:30", "reconcile:40"]);
  });

  it("keeps the value shown as the baseline while no input is present", async () => {
    const seen = reports();
    const removed = input();
    const container = removed.parentElement as HTMLElement;

    removed.remove();
    await tick();
    const same = removed.cloneNode(true) as HTMLInputElement;
    same.value = "0";
    container.insertBefore(same, incrementBtn());
    await tick();
    expect(seen).toEqual([]);

    same.remove();
    await tick();
    const moved = removed.cloneNode(true) as HTMLInputElement;
    moved.value = "30";
    container.insertBefore(moved, incrementBtn());
    await tick();

    expect(seen).toEqual(["reconcile:30"]);
  });

  /** Takes the root out of the page and puts it back, which connects the same instance again. */
  const moveRoot = async () => {
    const el = root();
    el.remove();
    await tick();
    document.body.append(el);
    await tick();
  };

  it("reports nothing when the same instance connects again, even for a value it normalizes", async () => {
    const seen = reports();
    const instance = controller();
    input().value = "23";

    await moveRoot();

    expect(controller()).toBe(instance);
    expect(input().value).toBe("20");
    expect(seen).toEqual([]);
  });

  it("keeps the number shown as the baseline when the same instance connects again without an input", async () => {
    const seen = reports();
    const instance = controller();
    const removed = input();
    const container = removed.parentElement as HTMLElement;

    removed.remove();
    await tick();
    await moveRoot();
    const same = removed.cloneNode(true) as HTMLInputElement;
    same.value = "0";
    container.insertBefore(same, incrementBtn());
    await tick();

    expect(controller()).toBe(instance);
    expect(seen).toEqual([]);
  });

  it("reports another number that arrives after the same instance connected again without an input", async () => {
    const seen = reports();
    const removed = input();
    const container = removed.parentElement as HTMLElement;

    removed.remove();
    await tick();
    await moveRoot();
    const moved = removed.cloneNode(true) as HTMLInputElement;
    moved.value = "30";
    container.insertBefore(moved, incrementBtn());
    await tick();

    expect(seen).toEqual(["reconcile:30"]);
  });

  it("reports the first input's number when a new instance connected without one", async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = `
      <div data-controller="stimeo--number-input" data-stimeo--number-input-step-value="10"></div>`;
    application = Application.start();
    application.register("stimeo--number-input", NumberInputController);
    await tick();
    const seen = reports();

    root().insertAdjacentHTML(
      "beforeend",
      `<input type="number" value="20" aria-label="Quantity"
              data-stimeo--number-input-target="input" />`,
    );
    await tick();

    expect(seen).toEqual(["reconcile:20"]);
  });

  it("reports one batch of range and step changes once", async () => {
    const seen = reports();

    root().setAttribute("data-stimeo--number-input-max-value", "54");
    root().setAttribute("data-stimeo--number-input-min-value", "10");
    root().setAttribute("data-stimeo--number-input-step-value", "5");
    await tick();

    expect(input().value).toBe("10");
    expect(seen).toEqual(["reconcile:10"]);
  });

  it("reports nothing on connect, even for a value it normalizes", async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = `
      <div data-controller="stimeo--number-input" data-stimeo--number-input-step-value="10">
        <input type="number" value="23" aria-label="Quantity"
               data-stimeo--number-input-target="input" />
      </div>`;
    const seen: string[] = [];
    const listening = new AbortController();
    for (const type of ["change", "reconcile"]) {
      document.addEventListener(`stimeo--number-input:${type}`, () => seen.push(type), {
        signal: listening.signal,
      });
    }
    application = Application.start();
    application.register("stimeo--number-input", NumberInputController);
    await tick();
    listening.abort();

    expect(input().value).toBe("20");
    expect(seen).toEqual([]);
  });

  it("measures a step a reconcile listener takes from the value just reported", async () => {
    const seen = reports();
    let answered = false;
    root().addEventListener("stimeo--number-input:reconcile", () => {
      if (answered) return;
      answered = true;
      press("ArrowUp");
    });

    replaceInput("23");
    await tick();

    expect(input().value).toBe("30");
    expect(seen).toEqual(["reconcile:20", "change:30"]);
  });

  it("rebinds pointer focus guards when a step button is replaced", async () => {
    const oldButton = incrementBtn();
    const replacement = oldButton.cloneNode(true) as HTMLButtonElement;
    oldButton.replaceWith(replacement);
    await tick();

    const currentDown = new Event("pointerdown", { bubbles: true, cancelable: true });
    replacement.dispatchEvent(currentDown);
    expect(currentDown.defaultPrevented).toBe(true);
    window.dispatchEvent(new Event("pointerup"));

    const staleDown = new Event("pointerdown", { bubbles: true, cancelable: true });
    oldButton.dispatchEvent(staleDown);
    expect(staleDown.defaultPrevented).toBe(false);
  });

  it("returns controller-owned button disabled state on target removal and disconnect", async () => {
    expect(decrementBtn().disabled).toBe(true);
    expect(decrementBtn().hasAttribute("data-number-input-disabled")).toBe(true);
    const removed = decrementBtn();

    removed.remove();
    await tick();

    expect(removed.disabled).toBe(false);
    expect(removed.hasAttribute("data-number-input-disabled")).toBe(false);

    press("End");
    expect(incrementBtn().disabled).toBe(true);
    controller().disconnect();
    expect(incrementBtn().disabled).toBe(false);
    expect(incrementBtn().hasAttribute("data-number-input-disabled")).toBe(false);
  });

  it("dispatches change with the committed value", () => {
    const values: number[] = [];
    root().addEventListener("stimeo--number-input:change", (event) => {
      values.push((event as CustomEvent<{ value: number }>).detail.value);
    });
    press("ArrowUp");
    press("ArrowUp");
    expect(values).toEqual([10, 20]);
  });

  it("suppresses pointerdown on buttons and releases it on disconnect", () => {
    input().value = "50";
    input().dispatchEvent(new Event("change", { bubbles: true }));
    for (const button of [incrementBtn(), decrementBtn()]) {
      const down = new Event("pointerdown", { bubbles: true, cancelable: true });
      button.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
      window.dispatchEvent(new Event("pointerup"));
    }

    // The test stays synchronous, so it calls disconnect() directly instead of waiting for the
    // MutationObserver delivery.
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--number-input",
    ) as NumberInputController;
    controller.disconnect();

    const after = new Event("pointerdown", { bubbles: true, cancelable: true });
    incrementBtn().dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  /** Presses `button` and releases the pointer, returning whether the press was consumed. */
  const pressConsumed = (button: HTMLButtonElement): boolean => {
    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    button.dispatchEvent(down);
    window.dispatchEvent(new Event("pointerup"));
    return down.defaultPrevented;
  };

  it("wires both step buttons again when disconnect() and connect() run directly", () => {
    input().value = "50";
    input().dispatchEvent(new Event("change", { bubbles: true }));
    const instance = controller();

    instance.disconnect();
    instance.connect();

    expect([incrementBtn(), decrementBtn()].map(pressConsumed)).toEqual([true, true]);
  });

  it("aborts every window listener it added when it disconnects", () => {
    const instance = controller();
    const add = vi.spyOn(window, "addEventListener");
    instance.disconnect();
    instance.connect();
    const signals = add.mock.calls
      .filter(([type]) => ["pointerup", "pointercancel", "blur"].includes(type))
      .map(([, , options]) => (typeof options === "object" ? options.signal : undefined));
    add.mockRestore();
    expect(signals).toHaveLength(3);

    instance.disconnect();

    expect(signals.map((signal) => signal?.aborted)).toEqual([true, true, true]);
  });

  it("releases its window listeners after connecting twice without a disconnect", () => {
    const instance = controller();
    instance.disconnect();
    const ledger = recordListeners();
    const guards = () =>
      ledger
        .live(window)
        .filter(({ type }) => ["pointerup", "pointercancel", "blur"].includes(type));
    try {
      instance.connect();
      instance.connect();
      expect(guards().map(({ type }) => type)).toEqual(["pointerup", "pointercancel", "blur"]);

      instance.disconnect();

      expect(guards()).toEqual([]);
    } finally {
      ledger.restore();
    }
  });

  it("releases the composition listeners of an input that leaves", async () => {
    const ledger = recordListeners();
    try {
      const added = document.createElement("input");
      added.setAttribute("data-stimeo--number-input-target", "input");
      root().append(added);
      await tick();
      expect(ledger.live(added, "compositionstart")).toHaveLength(1);

      added.remove();
      await tick();

      expect(ledger.live(added).map(({ type }) => type)).toEqual([]);
    } finally {
      ledger.restore();
    }
  });

  it("wires a step button again when it leaves and comes back", async () => {
    const button = incrementBtn();
    const parent = button.parentElement as HTMLElement;

    button.remove();
    await tick();
    parent.append(button);
    await tick();

    expect(pressConsumed(button)).toBe(true);
  });

  it("disables an increment button added at runtime at the maximum", async () => {
    press("End");

    root().insertAdjacentHTML(
      "beforeend",
      `<button type="button" tabindex="-1" data-stimeo--number-input-target="increment">+</button>`,
    );
    const added = root().lastElementChild as HTMLButtonElement;
    await tick();

    expect(added.disabled).toBe(true);
  });

  it("wires a decrement button added at runtime and derives its bound state", async () => {
    root().insertAdjacentHTML(
      "beforeend",
      `<button type="button" tabindex="-1" data-stimeo--number-input-target="decrement">−</button>`,
    );
    const added = root().lastElementChild as HTMLButtonElement;
    await tick();
    expect(added.disabled).toBe(true); // the field sits at the minimum

    press("ArrowUp");

    expect(added.disabled).toBe(false);
    expect(pressConsumed(added)).toBe(true);
  });

  it("drops its marker when it enables a button again, so a later author disable stays", () => {
    expect(decrementBtn().hasAttribute("data-number-input-disabled")).toBe(true);

    press("ArrowUp");
    expect(decrementBtn().disabled).toBe(false);
    expect(decrementBtn().hasAttribute("data-number-input-disabled")).toBe(false);

    decrementBtn().disabled = true;
    controller().disconnect();
    expect(decrementBtn().disabled).toBe(true);
  });

  it("keeps focus on the input after using the decrement button", () => {
    press("End");
    // The button holds focus and no pointerdown precedes the click, so only the step refocuses.
    decrementBtn().focus();
    expect(document.activeElement).toBe(decrementBtn());

    decrementBtn().click();

    expect(input().value).toBe("90");
    expect(document.activeElement).toBe(input());
  });

  it("moves focus to the input when a step button is pressed", () => {
    expect(document.activeElement).not.toBe(input());

    pressConsumed(incrementBtn());

    expect(document.activeElement).toBe(input());
  });

  it("prevents the browser's own stepping for a key it handles", () => {
    const event = keyEvent("ArrowUp");

    keyboardPress(input(), event);

    expect(event.defaultPrevented).toBe(true);
    expect(input().value).toBe("10");
  });

  it("reconciles against a runtime minimum changed on its own", async () => {
    const seen = reports();

    root().setAttribute("data-stimeo--number-input-min-value", "30");
    controller().minValueChanged();
    await flushMicrotasks();

    expect(input().value).toBe("30");
    expect(seen).toEqual(["reconcile:30"]);
  });

  it("reports an input swapped in beside the old one once the old one leaves", async () => {
    const seen = reports();
    const old = input();
    const replacement = old.cloneNode(true) as HTMLInputElement;
    replacement.value = "23";

    old.after(replacement);
    await tick();
    expect(seen).toEqual([]);

    old.remove();
    await tick();

    expect(input()).toBe(replacement);
    expect(replacement.value).toBe("20");
    expect(seen).toEqual(["reconcile:20"]);
  });

  it("has no machine-detectable a11y violations", async () => {
    await expectNoA11yViolations(root());
  });
});

/**
 * A custom `role="spinbutton"` host gets its `aria-valuenow`/min/max synced
 * (a native `<input type="number">` exposes those itself, so they are not added).
 */
describe("NumberInputController on a custom spinbutton host", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--number-input"
           data-stimeo--number-input-min-value="1"
           data-stimeo--number-input-max-value="5"
           data-stimeo--number-input-step-value="1">
        <input type="text" role="spinbutton" inputmode="numeric" value="3" aria-label="Level"
               aria-valuenow="99" aria-valuemin="-99" aria-valuemax="99"
               data-stimeo--number-input-target="input"
               data-action="change->stimeo--number-input#onInput
                            keydown->stimeo--number-input#onKeydown" />
      </div>`;
    application = Application.start();
    application.register("stimeo--number-input", NumberInputController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--number-input']") as HTMLElement;
  const input = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--number-input-target='input']",
    ) as HTMLInputElement;
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--number-input",
    ) as NumberInputController;

  it("announces the spinbutton role, name, range, and value in order", async () => {
    const before = await captureSpeech({ container: input(), steps: 0 });
    expect(before).toEqual(["spinbutton, Level, max value 5, min value 1, 3"]);

    keyboardPress(input(), "ArrowUp");
    const after = await captureSpeech({ container: input(), steps: 0 });
    expect(after).toEqual(["spinbutton, Level, max value 5, min value 1, 4"]);
  });

  it("syncs aria-valuenow/min/max on the spinbutton", () => {
    keyboardPress(input(), "ArrowUp");
    expect(input().value).toBe("4");
    expect(input().getAttribute("aria-valuenow")).toBe("4");
    expect(input().getAttribute("aria-valuemin")).toBe("1");
    expect(input().getAttribute("aria-valuemax")).toBe("5");
  });

  it("removes stale finite ARIA boundaries when Values become unbounded", async () => {
    root().removeAttribute("data-stimeo--number-input-min-value");
    root().removeAttribute("data-stimeo--number-input-max-value");
    await tick();

    expect(input().hasAttribute("aria-valuemin")).toBe(false);
    expect(input().hasAttribute("aria-valuemax")).toBe(false);
    expect(input().getAttribute("aria-valuenow")).toBe("3");
  });

  it("removes aria-valuenow while blank and restores it on the next numeric commit", () => {
    input().value = "";
    input().dispatchEvent(new Event("change", { bubbles: true }));
    expect(input().hasAttribute("aria-valuenow")).toBe(false);
    expect(input().getAttribute("aria-valuemin")).toBe("1");
    expect(input().getAttribute("aria-valuemax")).toBe("5");

    input().value = "4";
    input().dispatchEvent(new Event("change", { bubbles: true }));
    expect(input().getAttribute("aria-valuenow")).toBe("4");
  });

  it("restores authored ARIA when the controller disconnects", () => {
    expect(input().getAttribute("aria-valuenow")).toBe("3");
    controller().disconnect();

    expect(input().getAttribute("aria-valuenow")).toBe("99");
    expect(input().getAttribute("aria-valuemin")).toBe("-99");
    expect(input().getAttribute("aria-valuemax")).toBe("99");
  });

  it("keeps its ARIA through turbo:before-cache, which also fires on a page that stays", () => {
    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(input().getAttribute("aria-valuenow")).toBe("3");
    expect(input().getAttribute("aria-valuemin")).toBe("1");
    expect(input().getAttribute("aria-valuemax")).toBe("5");
  });

  it("gives the author's ARIA back on a page restored from the cache", async () => {
    application = await restoreFromCache(application, (restored) =>
      restored.register("stimeo--number-input", NumberInputController),
    );
    expect(input().getAttribute("aria-valuenow")).toBe("3");

    controller().disconnect();

    expect(input().getAttribute("aria-valuenow")).toBe("99");
    expect(input().getAttribute("aria-valuemin")).toBe("-99");
    expect(input().getAttribute("aria-valuemax")).toBe("99");
    expect(
      input()
        .getAttributeNames()
        .filter((name) => name.endsWith("-lease")),
    ).toEqual([]);
  });

  /** The range ARIA `element` carries, as `[valuenow, valuemin, valuemax]`. */
  const rangeAria = (element: HTMLElement) =>
    ["aria-valuenow", "aria-valuemin", "aria-valuemax"].map((name) => element.getAttribute(name));

  it("restores authored ARIA on an input that leaves the controller", async () => {
    const removed = input();
    expect(rangeAria(removed)).toEqual(["3", "1", "5"]);

    removed.remove();
    await tick();

    expect(rangeAria(removed)).toEqual(["99", "-99", "99"]);
  });

  it("returns its ARIA when the host stops being a spinbutton", () => {
    input().removeAttribute("role");

    keyboardPress(input(), "ArrowUp");

    expect(input().value).toBe("4");
    expect(rangeAria(input())).toEqual(["99", "-99", "99"]);
  });

  it("starts from a clean composition state when it connects again", () => {
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const instance = controller();

    instance.disconnect();
    instance.connect();
    keyboardPress(input(), "ArrowUp");

    expect(input().value).toBe("4");
  });

  it("holds a range reconciliation while the field is composing, and runs it once the composition ends", async () => {
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--number-input:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input(), "3４");
    root().setAttribute("data-stimeo--number-input-max-value", "2");
    controller().maxValueChanged();
    await flushMicrotasks();

    // The uncommitted text is the IME's, so the clamp waits for it.
    expect(input().value).toBe("3４");
    expect(repairs).toEqual([]);

    // A cancelled conversion leaves the field with the text it started from.
    input().value = "3";
    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await flushMicrotasks();

    expect(input().value).toBe("2");
    expect(repairs).toEqual([{ value: 2 }]);
  });

  it.each([
    [
      "the input",
      (instance: NumberInputController, moving: HTMLInputElement) => {
        instance.inputTargetDisconnected(moving);
        instance.inputTargetConnected(moving);
      },
    ],
    [
      "the controller element",
      // Stimulus disconnects a controller before its targets, and connects it after them.
      (instance: NumberInputController, moving: HTMLInputElement) => {
        instance.disconnect();
        instance.inputTargetDisconnected(moving);
        instance.inputTargetConnected(moving);
        instance.connect();
      },
    ],
  ])(
    "keeps its ARIA while %s moves keeping focus mid-composition, and takes the commit as the user's",
    async (_name, move) => {
      const events: Array<[string, unknown]> = [];
      for (const type of ["change", "reconcile"]) {
        root().addEventListener(`stimeo--number-input:${type}`, (event) => {
          events.push([type, (event as CustomEvent).detail.value]);
        });
      }
      input().focus();
      input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(input(), "４");

      // A move that keeps focus and the conversion still lets Stimulus release the target and
      // take it back.
      move(controller(), input());
      await flushMicrotasks();
      expect(input().value).toBe("４");
      expect(input().getAttribute("aria-valuenow")).toBe("3");
      expect(input().getAttribute("aria-valuemin")).toBe("1");
      expect(input().getAttribute("aria-valuemax")).toBe("5");

      input().value = "4";
      input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      await flushMicrotasks();
      input().dispatchEvent(new Event("change", { bubbles: true }));

      expect(input().getAttribute("aria-valuenow")).toBe("4");
      expect(events).toEqual([["change", 4]]);
    },
  );

  it.each([
    ["min", "data-stimeo--number-input-min-value", "2", 5],
    ["max", "data-stimeo--number-input-max-value", "4", 4],
    ["step", "data-stimeo--number-input-step-value", "2", 5],
  ])(
    "holds a pass for a %s that changed with a move keeping focus, as it does with no move",
    async (_name, attribute, value, settled) => {
      const events: Array<[string, unknown]> = [];
      for (const type of ["change", "reconcile"]) {
        root().addEventListener(`stimeo--number-input:${type}`, (event) => {
          events.push([type, (event as CustomEvent).detail.value]);
        });
      }
      input().focus();
      input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(input(), "５");

      // The morph that moves the controller element also changes its range.
      reconnectKeepingFocus(controller(), () => root().setAttribute(attribute, value));
      await flushMicrotasks();
      expect(input().value).toBe("５");
      expect(rangeAria(input())).toEqual(["3", "1", "5"]);

      // A script writes the field and tells listeners, which ends the conversion.
      input().value = "5";
      input().dispatchEvent(new Event("input", { bubbles: true }));
      await flushMicrotasks();
      input().dispatchEvent(new Event("change", { bubbles: true }));

      expect(events).toEqual([["reconcile", settled]]);
    },
  );

  it("holds nothing for a morph that changes nothing mid-composition, and takes the commit as the user's", async () => {
    const events: Array<[string, unknown]> = [];
    for (const type of ["change", "reconcile"]) {
      root().addEventListener(`stimeo--number-input:${type}`, (event) => {
        events.push([type, (event as CustomEvent).detail.value]);
      });
    }
    input().focus();
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input(), "４");

    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await flushMicrotasks();
    input().value = "4";
    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await flushMicrotasks();
    input().dispatchEvent(new Event("change", { bubbles: true }));

    expect(events).toEqual([["change", 4]]);
  });

  it("holds nothing for a range changed and changed back mid-composition, and takes the commit as the user's", async () => {
    const events: Array<[string, unknown]> = [];
    for (const type of ["change", "reconcile"]) {
      root().addEventListener(`stimeo--number-input:${type}`, (event) => {
        events.push([type, (event as CustomEvent).detail.value]);
      });
    }
    input().focus();
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input(), "４");
    root().setAttribute("data-stimeo--number-input-max-value", "2");
    await tick();
    root().setAttribute("data-stimeo--number-input-max-value", "5");
    await tick();

    input().value = "4";
    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await tick();
    input().dispatchEvent(new Event("change", { bubbles: true }));

    expect(events).toEqual([["change", 4]]);
  });

  it("shows the range it showed while a range change waits for the confirmation of what a composition left", async () => {
    input().focus();
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input(), "４");
    root().setAttribute("data-stimeo--number-input-max-value", "2");
    await tick();
    expect(rangeAria(input())).toEqual(["3", "1", "5"]);

    // A morph renders the server's markup, which carries none of it.
    input().removeAttribute("aria-valuenow");
    input().removeAttribute("aria-valuemin");
    input().removeAttribute("aria-valuemax");
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await flushMicrotasks();
    expect(rangeAria(input())).toEqual(["3", "1", "5"]);

    input().value = "4";
    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await flushMicrotasks();

    // The text the composition left is the user's draft: the range waits for its confirmation.
    expect(input().value).toBe("4");
    expect(rangeAria(input())).toEqual(["3", "1", "5"]);

    input().dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks();

    expect(input().value).toBe("2");
    expect(rangeAria(input())).toEqual(["2", "1", "2"]);
  });

  it("keeps its ARIA through the move itself, before any pass runs, when the input moves keeping focus mid-composition", () => {
    input().focus();
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input(), "４");

    // A move that keeps focus and the conversion still lets Stimulus release the input and
    // take it back.
    const instance = controller();
    instance.inputTargetDisconnected(input());
    expect(rangeAria(input())).toEqual(["3", "1", "5"]);
    instance.inputTargetConnected(input());
    expect(rangeAria(input())).toEqual(["3", "1", "5"]);
  });

  it.each([
    [
      "inserted ahead of it",
      (composing: HTMLInputElement, swapped: HTMLInputElement) => {
        composing.before(swapped);
      },
    ],
    [
      "swapped in as it leaves keeping focus",
      (composing: HTMLInputElement, swapped: HTMLInputElement) => {
        composing.before(swapped);
        composing.removeAttribute("data-stimeo--number-input-target");
      },
    ],
  ])(
    "reconciles an input %s at once, while the composing input goes on composing",
    async (_name, swap) => {
      const events: Array<[string, unknown]> = [];
      for (const type of ["change", "reconcile"]) {
        root().addEventListener(`stimeo--number-input:${type}`, (event) => {
          events.push([type, (event as CustomEvent).detail.value]);
        });
      }
      const composing = input();
      composing.focus();
      composing.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(composing, "４");
      const swapped = document.createElement("input");
      swapped.type = "text";
      swapped.value = "5";
      swapped.setAttribute("role", "spinbutton");
      swapped.setAttribute("aria-label", "Level");
      swapped.setAttribute("data-stimeo--number-input-target", "input");

      swap(composing, swapped);
      await tick();

      expect(swapped.getAttribute("aria-valuenow")).toBe("5");
      expect(events).toEqual([["reconcile", 5]]);
    },
  );

  describe("when the composing input becomes its input again", () => {
    const record = () => {
      const events: Array<[string, unknown]> = [];
      for (const type of ["change", "reconcile"]) {
        root().addEventListener(`stimeo--number-input:${type}`, (event) => {
          events.push([type, (event as CustomEvent).detail.value]);
        });
      }
      return events;
    };
    const spinbutton = (value: string) => {
      const element = document.createElement("input");
      element.type = "text";
      element.value = value;
      element.setAttribute("role", "spinbutton");
      element.setAttribute("aria-label", "Level");
      element.setAttribute("data-stimeo--number-input-target", "input");
      return element;
    };
    const commit = async (composing: HTMLInputElement, text: string) => {
      composing.value = text;
      composing.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      await tick();
      composing.dispatchEvent(new Event("change", { bubbles: true }));
    };

    it("keeps the returned input pending through a morph and button replacement without reading its draft", async () => {
      root().insertAdjacentHTML(
        "beforeend",
        `<button type="button" data-stimeo--number-input-target="increment">+</button>
         <button type="button" data-stimeo--number-input-target="decrement">−</button>`,
      );
      await tick();
      const increment = root().querySelector<HTMLButtonElement>(
        "[data-stimeo--number-input-target='increment']",
      ) as HTMLButtonElement;
      const decrement = root().querySelector<HTMLButtonElement>(
        "[data-stimeo--number-input-target='decrement']",
      ) as HTMLButtonElement;
      const events = record();
      const composing = input();
      composing.focus();
      composing.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(composing, "４");
      const ahead = spinbutton("5");
      composing.before(ahead);
      await tick();
      expect(increment.disabled).toBe(true);
      expect(decrement.disabled).toBe(false);

      ahead.remove();
      await tick();
      root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      await flushMicrotasks();

      expect(rangeAria(composing)).toEqual(["3", "1", "5"]);
      expect(increment.disabled).toBe(true);
      expect(decrement.disabled).toBe(false);
      expect(composing.value).toBe("４");
      expect(events).toEqual([["reconcile", 5]]);

      const replacement = document.createElement("button");
      replacement.type = "button";
      replacement.setAttribute("data-stimeo--number-input-target", "increment");
      increment.replaceWith(replacement);
      await tick();

      expect(replacement.disabled).toBe(false);
      expect(replacement.hasAttribute("data-number-input-disabled")).toBe(false);
      expect(rangeAria(composing)).toEqual(["3", "1", "5"]);
      expect(events).toEqual([["reconcile", 5]]);

      await commit(composing, "4");

      expect(rangeAria(composing)).toEqual(["4", "1", "5"]);
      expect(replacement.disabled).toBe(false);
      expect(events).toEqual([
        ["reconcile", 5],
        ["reconcile", 4],
      ]);
    });

    it("leaves authored ARIA and released buttons until confirmation when it reconnects with a returned input pending", async () => {
      root().insertAdjacentHTML(
        "beforeend",
        `<button type="button" data-stimeo--number-input-target="increment">+</button>`,
      );
      await tick();
      const increment = root().querySelector<HTMLButtonElement>(
        "[data-stimeo--number-input-target='increment']",
      ) as HTMLButtonElement;
      const events = record();
      const composing = input();
      composing.focus();
      composing.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(composing, "４");
      const ahead = spinbutton("5");
      composing.before(ahead);
      await tick();
      ahead.remove();
      await tick();
      expect(increment.disabled).toBe(true);

      const instance = controller();
      instance.disconnect();
      instance.inputTargetDisconnected(composing);
      instance.inputTargetConnected(composing);
      instance.connect();
      await flushMicrotasks();

      expect(composing.value).toBe("４");
      expect(rangeAria(composing)).toEqual(["99", "-99", "99"]);
      expect(increment.disabled).toBe(false);
      expect(increment.hasAttribute("data-number-input-disabled")).toBe(false);
      expect(events).toEqual([["reconcile", 5]]);

      await commit(composing, "4");

      expect(rangeAria(composing)).toEqual(["4", "1", "5"]);
      expect(increment.disabled).toBe(false);
      expect(events).toEqual([
        ["reconcile", 5],
        ["reconcile", 4],
      ]);
    });

    it("shows none of the number another input showed on it, and reconciles it once the composition ends", async () => {
      const events = record();
      const composing = input();
      composing.focus();
      composing.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(composing, "４");
      const ahead = spinbutton("5");
      composing.before(ahead);
      await tick();
      ahead.remove();
      await tick();

      expect(rangeAria(composing)).toEqual(["3", "1", "5"]);
      expect(events).toEqual([["reconcile", 5]]);

      await commit(composing, "4");

      expect(rangeAria(composing)).toEqual(["4", "1", "5"]);
      expect(events).toEqual([
        ["reconcile", 5],
        ["reconcile", 4],
      ]);
    });

    it("applies a range change it held once the composition ends, after another input came first meanwhile", async () => {
      const events = record();
      const composing = input();
      composing.focus();
      composing.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(composing, "４");
      root().setAttribute("data-stimeo--number-input-max-value", "2");
      await tick();
      const ahead = spinbutton("1");
      composing.before(ahead);
      await tick();
      ahead.remove();
      await tick();

      await commit(composing, "4");

      expect(composing.value).toBe("2");
      expect(rangeAria(composing)).toEqual(["2", "1", "2"]);
      expect(events).toEqual([
        ["reconcile", 1],
        ["reconcile", 2],
      ]);
    });

    it("waits for the conversion of an input behind the first once the first leaves", async () => {
      const behind = spinbutton("2");
      input().after(behind);
      await tick();
      const events = record();
      behind.focus();
      behind.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(behind, "４");
      input().remove();
      await tick();

      expect(behind.hasAttribute("aria-valuenow")).toBe(false);
      expect(events).toEqual([]);

      await commit(behind, "4");

      expect(rangeAria(behind)).toEqual(["4", "1", "5"]);
      expect(events).toEqual([["reconcile", 4]]);
    });
  });

  it("gives its ARIA back when the composing input stops being its input while keeping focus", async () => {
    const leaving = input();
    leaving.focus();
    leaving.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(leaving, "４");

    leaving.removeAttribute("data-stimeo--number-input-target");
    controller().inputTargetDisconnected(leaving);

    expect(leaving.getAttribute("aria-valuenow")).toBe("99");
    expect(leaving.getAttribute("aria-valuemin")).toBe("-99");
    expect(leaving.getAttribute("aria-valuemax")).toBe("99");
  });

  it("puts back the ARIA a morph wiped mid-composition, without reading the draft", async () => {
    input().focus();
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input(), "４");

    // A morph renders the server's markup, which carries none of it.
    input().removeAttribute("aria-valuenow");
    input().removeAttribute("aria-valuemin");
    input().removeAttribute("aria-valuemax");
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await flushMicrotasks();

    expect(input().value).toBe("４");
    expect(input().getAttribute("aria-valuenow")).toBe("3");
    expect(input().getAttribute("aria-valuemin")).toBe("1");
    expect(input().getAttribute("aria-valuemax")).toBe("5");
  });

  it("runs a held reconciliation once a script ends the composition without compositionend", async () => {
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--number-input:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input(), "3４");
    root().setAttribute("data-stimeo--number-input-max-value", "2");
    controller().maxValueChanged();
    await flushMicrotasks();
    expect(repairs).toEqual([]);

    // A script writes the field, and the engine drops the conversion without compositionend.
    input().value = "3";
    input().dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: "1",
      }),
    );
    await flushMicrotasks();

    expect(input().value).toBe("2");
    expect(repairs).toEqual([{ value: 2 }]);
  });

  it("leaves the text to the user's own change when a composition that held nothing ends without compositionend", async () => {
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--number-input:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input(), "3４");

    // The engine no longer composes: its next edit says so, and the text stays.
    input().dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: "1",
      }),
    );
    await flushMicrotasks();

    expect(input().value).toBe("3４");
    expect(repairs).toEqual([]);
  });

  it("runs a held reconciliation before the key that follows a script's write", async () => {
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--number-input:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });
    input().focus();
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input(), "3４");
    root().setAttribute("data-stimeo--number-input-max-value", "2");
    controller().maxValueChanged();
    await flushMicrotasks();

    // A script writes the field, and the engine drops the conversion without compositionend.
    input().value = "4";
    keyboardPress(input(), "ArrowDown");

    // The step reads the range the page now declares, not the text it wrote.
    expect(input().value).toBe("1");
    expect(repairs).toEqual([{ value: 2 }]);
  });

  it("runs a held reconciliation once, not again at the next composition's end", async () => {
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--number-input:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    root().setAttribute("data-stimeo--number-input-max-value", "2");
    controller().maxValueChanged();
    await flushMicrotasks();
    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await flushMicrotasks();
    expect(repairs).toEqual([{ value: 2 }]);

    // Typed text waits for the user's own `change`; only a held pass reads it early.
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input(), "5");
    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await flushMicrotasks();

    expect(input().value).toBe("5");
    expect(repairs).toEqual([{ value: 2 }]);
  });

  it("reconciles a replacement at once when the composing input itself is replaced", async () => {
    const old = input();
    old.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    root().setAttribute("data-stimeo--number-input-max-value", "2");
    controller().maxValueChanged();
    await flushMicrotasks();
    expect(old.value).toBe("3");

    const replacement = old.cloneNode(true) as HTMLInputElement;
    replacement.value = "3";
    old.replaceWith(replacement);
    await tick();

    // The composition was the old field's and left with it, so nothing holds the
    // replacement back; the old field's text is neither read nor rewritten.
    expect(input()).toBe(replacement);
    expect(replacement.value).toBe("2");
    expect(old.value).toBe("3");

    // The old field's composition ending reaches nothing: text typed into the
    // replacement since then still waits for the user's own commit.
    replacement.value = "5";
    old.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await flushMicrotasks();
    expect(replacement.value).toBe("5");
  });

  it("yields arrow keys throughout IME composition", () => {
    const perEvent = keyEvent("ArrowUp");
    Object.defineProperty(perEvent, "isComposing", { value: true });
    keyboardPress(input(), perEvent);
    expect(perEvent.defaultPrevented).toBe(false);
    expect(input().value).toBe("3");

    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const duringLifecycle = keyEvent("ArrowUp");
    keyboardPress(input(), duringLifecycle);
    expect(duringLifecycle.defaultPrevented).toBe(false);
    expect(input().value).toBe("3");

    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    keyboardPress(input(), "ArrowUp");
    expect(input().value).toBe("4");
  });
});

/**
 * A text-type spinbutton shows the text an IME confirms, full-width digits and
 * signs included, and the controller reads that text on every path: a commit, a
 * step, a connection, and a reconciliation the composition held back.
 */
describe("NumberInputController with full-width input on a text field", () => {
  let application: Application;

  const mount = async (value: string) => {
    document.body.innerHTML = `
      <div data-controller="stimeo--number-input"
           data-stimeo--number-input-min-value="-100"
           data-stimeo--number-input-max-value="100"
           data-stimeo--number-input-step-value="1">
        <input type="text" role="spinbutton" inputmode="numeric" value="${value}"
               aria-label="Offset" data-stimeo--number-input-target="input"
               data-action="change->stimeo--number-input#onInput
                            keydown->stimeo--number-input#onKeydown" />
      </div>`;
    application = Application.start();
    application.register("stimeo--number-input", NumberInputController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--number-input']") as HTMLElement;
  const input = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--number-input-target='input']",
    ) as HTMLInputElement;
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--number-input",
    ) as NumberInputController;
  const commit = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event("change", { bubbles: true }));
  };

  it("keeps the caret where the user put it when a held reconciliation runs right before their edit", async () => {
    await mount("50");
    input().focus();
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    root().setAttribute("data-stimeo--number-input-max-value", "20");
    controller().maxValueChanged();
    await tick();
    // A script writes the field, and the engine drops the conversion without compositionend.
    input().value = "35";
    input().setSelectionRange(1, 1);

    input().dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: "1",
      }),
    );
    await tick();

    expect(input().value).toBe("20");
    expect(input().selectionStart).toBe(1);
  });

  it("leaves the caret to the browser when the page reconciles a field the user is not in", async () => {
    await mount("35");
    input().setSelectionRange(1, 1);

    root().setAttribute("data-stimeo--number-input-max-value", "20");
    controller().maxValueChanged();
    await tick();

    expect(input().value).toBe("20");
    expect(input().selectionStart).toBe(2);
  });

  it("commits full-width digits and a full-width minus as the number they show", async () => {
    await mount("0");
    const changes: unknown[] = [];
    root().addEventListener("stimeo--number-input:change", (event) => {
      changes.push((event as CustomEvent).detail.value);
    });

    commit("３４");
    expect(input().value).toBe("34");
    expect(input().getAttribute("aria-valuenow")).toBe("34");
    commit("－５");
    expect(input().value).toBe("-5");
    expect(changes).toEqual([34, -5]);
  });

  it("steps from full-width text the field holds", async () => {
    await mount("0");
    input().value = "３４";
    keyboardPress(input(), "ArrowUp");
    expect(input().value).toBe("35");
  });

  it("reads a full-width value the markup brings when it connects", async () => {
    await mount("３４");
    expect(input().value).toBe("34");
    expect(input().getAttribute("aria-valuenow")).toBe("34");
  });

  it("reads full-width digits an IME confirmed when the user confirms them under a held range", async () => {
    await mount("0");
    const repairs: unknown[] = [];
    const commits: unknown[] = [];
    root().addEventListener("stimeo--number-input:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });
    root().addEventListener("stimeo--number-input:change", (event) => {
      commits.push((event as CustomEvent).detail);
    });
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input(), "３４");
    root().setAttribute("data-stimeo--number-input-max-value", "20");
    controller().maxValueChanged();
    await flushMicrotasks();
    expect(input().value).toBe("３４");

    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await flushMicrotasks();
    expect(input().value).toBe("３４");
    expect(repairs).toEqual([]);

    input().dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks();
    expect(input().value).toBe("20");
    expect(repairs).toEqual([]);
    expect(commits).toEqual([{ value: 20 }]);
  });
});

/**
 * Press-and-hold auto-repeat: holding a step button starts repeated steps after a
 * short delay until release / the bound / disconnect. The `click` binding stays the
 * single-step path, so a held press must not also double-step via its trailing click.
 * Driven with fake timers.
 */
describe("NumberInputController press-and-hold", () => {
  let application: Application;

  beforeEach(async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div data-controller="stimeo--number-input"
           data-stimeo--number-input-min-value="0"
           data-stimeo--number-input-max-value="100"
           data-stimeo--number-input-step-value="10">
        <button type="button" aria-label="Decrease" tabindex="-1"
                data-stimeo--number-input-target="decrement"
                data-action="click->stimeo--number-input#decrement">−</button>
        <input type="number" min="0" max="100" step="10" value="0" aria-label="Quantity"
               data-stimeo--number-input-target="input"
               data-action="change->stimeo--number-input#onInput
                            keydown->stimeo--number-input#onKeydown" />
        <button type="button" aria-label="Increase" tabindex="-1"
                data-stimeo--number-input-target="increment"
                data-action="click->stimeo--number-input#increment">+</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--number-input", NumberInputController);
    // Flush Stimulus' async (MutationObserver) connection under fake timers.
    await vi.advanceTimersByTimeAsync(0);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--number-input']") as HTMLElement;
  const input = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--number-input-target='input']",
    ) as HTMLInputElement;
  const incrementBtn = () =>
    document.querySelector<HTMLButtonElement>(
      "[data-stimeo--number-input-target='increment']",
    ) as HTMLButtonElement;
  const decrementBtn = () =>
    document.querySelector<HTMLButtonElement>(
      "[data-stimeo--number-input-target='decrement']",
    ) as HTMLButtonElement;
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--number-input",
    ) as NumberInputController;
  const pointerdown = (button: HTMLButtonElement) =>
    button.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
  const ownedPointerEvent = (type: string, pointerId: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    return event;
  };
  const secondaryPointerdown = (button: HTMLButtonElement) => {
    const event = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "button", { value: 2 }); // right button
    button.dispatchEvent(event);
    return event;
  };
  const releaseOutside = () => window.dispatchEvent(new Event("pointerup"));

  it("steps once on a quick click without repeating before the hold delay", () => {
    pointerdown(incrementBtn());
    expect(input().value).toBe("0"); // pointerdown alone does not step
    vi.advanceTimersByTime(399);
    expect(input().value).toBe("0"); // still under the hold threshold
    releaseOutside();
    incrementBtn().click(); // the trailing single click does the one step
    expect(input().value).toBe("10");
  });

  it("auto-repeats while held and swallows the trailing click", () => {
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(400); // first repeat -> 10
    vi.advanceTimersByTime(80 * 3); // -> 20, 30, 40
    expect(input().value).toBe("40");
    releaseOutside();
    incrementBtn().click(); // trailing click after a hold is ignored
    expect(input().value).toBe("40");
  });

  it("stops auto-repeat when a change listener ends the hold on its first repeat", () => {
    root().addEventListener(
      "stimeo--number-input:change",
      () => window.dispatchEvent(new Event("blur")),
      { once: true },
    );
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(400);
    vi.advanceTimersByTime(80 * 3);

    expect(input().value).toBe("10");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("auto-repeats decrement and swallows its trailing click", () => {
    input().value = "50";
    input().dispatchEvent(new Event("change", { bubbles: true }));
    pointerdown(decrementBtn());
    vi.advanceTimersByTime(400 + 80); // 40, 30
    releaseOutside();
    decrementBtn().click();

    expect(input().value).toBe("30");
  });

  it("does not poison the next legitimate click after a hold", () => {
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(400 + 80); // -> 10, 20
    expect(input().value).toBe("20");
    releaseOutside(); // trailing click never arrives (released off the button)
    vi.advanceTimersByTime(250); // the suppression safety net clears
    incrementBtn().click(); // a fresh, legitimate click must step
    expect(input().value).toBe("30");
  });

  it("stops repeating once the bound is reached without re-dispatching change", () => {
    const values: number[] = [];
    root().addEventListener("stimeo--number-input:change", (event) => {
      values.push((event as CustomEvent<{ value: number }>).detail.value);
    });
    input().value = "80";
    input().dispatchEvent(new Event("change", { bubbles: true }));
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(400 + 80 * 5); // 90, 100, then bound stops the repeat
    expect(input().value).toBe("100");
    expect(incrementBtn().disabled).toBe(true);
    // The typed 80 is a real commit, followed by 90 and 100; no-op repeats at
    // the bound add nothing.
    expect(values).toEqual([80, 90, 100]);
  });

  it("reads the range and step at each repeat of a hold", async () => {
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(400 + 80); // -> 10, 20
    expect(input().value).toBe("20");

    root().setAttribute("data-stimeo--number-input-step-value", "5");
    root().setAttribute("data-stimeo--number-input-max-value", "30");
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(80); // the next repeat steps on the new grid
    expect(input().value).toBe("25");
    vi.advanceTimersByTime(80 * 3); // 30, then the new bound stops the repeat
    expect(input().value).toBe("30");
    expect(incrementBtn().disabled).toBe(true);
    releaseOutside();
  });

  it("keeps each simultaneous hold owned by its initiating pointer", async () => {
    const secondRoot = root().cloneNode(true) as HTMLElement;
    document.body.appendChild(secondRoot);
    await vi.advanceTimersByTimeAsync(0);
    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement>("[data-stimeo--number-input-target='input']"),
    );
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "[data-stimeo--number-input-target='increment']",
      ),
    );

    buttons[0]?.dispatchEvent(ownedPointerEvent("pointerdown", 1));
    buttons[1]?.dispatchEvent(ownedPointerEvent("pointerdown", 2));
    vi.advanceTimersByTime(200);
    window.dispatchEvent(ownedPointerEvent("pointerup", 2));
    vi.advanceTimersByTime(200);

    expect(inputs.map((candidate) => candidate.value)).toEqual(["10", "0"]);
    window.dispatchEvent(ownedPointerEvent("pointerup", 1));
  });

  it("rebinds long-press behavior to a replacement button", async () => {
    const oldButton = incrementBtn();
    const replacement = oldButton.cloneNode(true) as HTMLButtonElement;
    oldButton.replaceWith(replacement);
    await vi.advanceTimersByTimeAsync(0);

    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    replacement.dispatchEvent(down);
    vi.advanceTimersByTime(400);

    expect(down.defaultPrevented).toBe(true);
    expect(input().value).toBe("10");
    window.dispatchEvent(new Event("pointerup"));
  });

  it("stops a hold immediately when its button target disconnects", async () => {
    const button = incrementBtn();
    pointerdown(button);
    vi.advanceTimersByTime(200);

    button.remove();
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(1000);

    expect(input().value).toBe("0");
  });

  it("stops a hold when its pointer leaves the owning button", () => {
    const button = incrementBtn();
    button.dispatchEvent(ownedPointerEvent("pointerdown", 7));
    vi.advanceTimersByTime(400); // first repeat -> 10

    button.dispatchEvent(ownedPointerEvent("pointerleave", 7));
    vi.advanceTimersByTime(1000);

    expect(input().value).toBe("10");
  });

  it("stays safe when the input disappears before an armed hold fires", () => {
    const removedInput = input();
    pointerdown(incrementBtn());
    removedInput.remove();

    expect(() => vi.advanceTimersByTime(400)).not.toThrow();
    expect(removedInput.value).toBe("0");
  });

  it("ignores secondary (non-primary) pointer buttons", () => {
    const event = secondaryPointerdown(incrementBtn());
    expect(event.defaultPrevented).toBe(false); // hold was not armed
    vi.advanceTimersByTime(2000);
    expect(input().value).toBe("0"); // no step from a right-click hold
  });

  it("does not arm a hold from a disabled bound button", () => {
    const event = new Event("pointerdown", { bubbles: true, cancelable: true });

    decrementBtn().dispatchEvent(event);
    vi.advanceTimersByTime(2000);

    expect(event.defaultPrevented).toBe(false);
    expect(input().value).toBe("0");
  });

  it("ignores an extra release after the trailing click was consumed", () => {
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(400); // -> 10
    releaseOutside();
    incrementBtn().click(); // consume the trailing-click suppression
    expect(input().value).toBe("10");

    releaseOutside(); // no hold is active, so this must be a no-op
    incrementBtn().click();
    expect(input().value).toBe("20");
  });

  it("does not re-arm trailing-click suppression when an inactive window blurs", () => {
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(400); // -> 10
    releaseOutside();
    incrementBtn().click(); // consume the trailing-click suppression

    window.dispatchEvent(new Event("blur"));
    incrementBtn().click();

    expect(input().value).toBe("20");
  });

  it("does not swallow the first click after a disconnect during a suppressed window", () => {
    // Hold + repeat arms the trailing-click suppression, then disconnect mid-window.
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(400 + 80); // -> 10, 20 (suppression now pending)
    releaseOutside();
    controller().disconnect();
    // Re-connect the same element (Turbo cache / detach→reattach).
    controller().connect();
    incrementBtn().click(); // the first click after reconnect must step
    expect(input().value).toBe("30");
  });

  it("reports every repeat step the way the browser reports its own", () => {
    const seen: string[] = [];
    for (const type of ["input", "change"]) {
      input().addEventListener(type, () => seen.push(type));
    }

    pointerdown(incrementBtn());
    vi.advanceTimersByTime(400); // first repeat -> 10
    vi.advanceTimersByTime(80 * 3); // -> 20, 30, 40
    releaseOutside();

    expect(input().value).toBe("40");
    expect(seen).toEqual([
      "input",
      "change",
      "input",
      "change",
      "input",
      "change",
      "input",
      "change",
    ]);
  });

  it("dispatches change once per committed repeat step", () => {
    const values: number[] = [];
    root().addEventListener("stimeo--number-input:change", (event) => {
      values.push((event as CustomEvent<{ value: number }>).detail.value);
    });
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(400 + 80 * 2); // 10, 20, 30
    releaseOutside();
    incrementBtn().click(); // swallowed -> no extra event
    expect(values).toEqual([10, 20, 30]);
  });

  it("tears down hold timers on disconnect so none fire afterward", () => {
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(200); // arm, but before the first repeat
    controller().disconnect();
    vi.advanceTimersByTime(2000); // advancing past every timer must do nothing
    expect(input().value).toBe("0");
  });

  it("stops a hold that is already repeating when it disconnects", () => {
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(400); // first repeat -> 10
    controller().disconnect();
    vi.advanceTimersByTime(1000);
    expect(input().value).toBe("10");
  });

  it.each(["pointercancel", "blur"])("stops a running hold on a window %s", (type) => {
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(400); // first repeat -> 10

    window.dispatchEvent(new Event(type));
    vi.advanceTimersByTime(1000);

    expect(input().value).toBe("10");
  });

  it("stops a hold immediately when its input target disconnects", async () => {
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(200);

    const replacement = input().cloneNode(true) as HTMLInputElement;
    input().replaceWith(replacement);
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(1000);

    expect(replacement.value).toBe("0");
  });

  it("lets a press on the other button replace the running hold", () => {
    input().value = "50";
    input().dispatchEvent(new Event("change", { bubbles: true }));

    pointerdown(incrementBtn());
    vi.advanceTimersByTime(200);
    pointerdown(decrementBtn());
    vi.advanceTimersByTime(400); // the decrement hold's first repeat -> 40

    expect(input().value).toBe("40");
    releaseOutside();
  });

  it("leaves no hold timer pending after a disconnect during a suppressed window", () => {
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(400 + 80); // -> 10, 20
    releaseOutside(); // the trailing-click suppression and its safety net are pending
    expect(vi.getTimerCount()).toBe(1);

    controller().disconnect();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires the safety-net timer once the trailing click is swallowed", () => {
    pointerdown(incrementBtn());
    vi.advanceTimersByTime(400); // -> 10
    releaseOutside();
    expect(vi.getTimerCount()).toBe(1);

    incrementBtn().click(); // the trailing click, swallowed

    expect(input().value).toBe("10");
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** Unconfirmed typing survives page reconciliation until a native change or widget step. */
describe("NumberInputController with an unconfirmed draft", () => {
  let application: Application;
  let root: HTMLElement;
  let field: HTMLInputElement;
  let instance: NumberInputController;
  let custom: string[];
  let native: string[];

  beforeEach(async () => {
    document.body.innerHTML = `<form><div data-controller="stimeo--number-input"
      data-stimeo--number-input-min-value="0" data-stimeo--number-input-max-value="1000"
      data-stimeo--number-input-step-value="1">
      <input type="text" role="spinbutton" name="quantity" value="12" aria-label="Quantity"
        data-stimeo--number-input-target="input"
        data-action="change->stimeo--number-input#onInput keydown->stimeo--number-input#onKeydown">
      <button type="button" aria-label="Increase" data-stimeo--number-input-target="increment"
        data-action="click->stimeo--number-input#increment">+</button>
      <button type="button" aria-label="Decrease" data-stimeo--number-input-target="decrement"
        data-action="click->stimeo--number-input#decrement">−</button>
      </div></form>`;
    root = document.querySelector("div") as HTMLElement;
    field = document.querySelector("input") as HTMLInputElement;
    application = Application.start();
    application.register("stimeo--number-input", NumberInputController);
    await tick();
    instance = application.getControllerForElementAndIdentifier(
      root,
      "stimeo--number-input",
    ) as NumberInputController;
    custom = [];
    native = [];
    for (const kind of ["change", "reconcile"]) {
      root.addEventListener(`stimeo--number-input:${kind}`, (event) => {
        custom.push(`${kind}:${(event as CustomEvent).detail.value}`);
      });
    }
    for (const kind of ["input", "change"]) {
      field.addEventListener(kind, () => native.push(kind), { capture: true });
    }
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  /** A typing input carries its live text but does not confirm it. */
  const typeDraft = (text: string): void => {
    field.focus();
    field.value = text;
    field.setSelectionRange(Math.min(1, text.length), Math.min(2, text.length));
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }),
    );
  };

  /** The browser's confirmation report, without an extra widget-generated native pair. */
  const confirm = (): void => {
    field.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const range = (key: "min" | "max" | "step", value: string): void => {
    root.setAttribute(`data-stimeo--number-input-${key}-value`, value);
    instance[`${key}ValueChanged`]();
  };

  const render = async (route: string): Promise<void> => {
    if (route === "morph") {
      field.removeAttribute("aria-valuenow");
      root.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    }
    if (route === "reconnect") reconnectKeepingFocus(instance);
    await tick();
  };

  it.each(["control", "morph", "reconnect"])(
    "confirms one numeric delta after %s without adopting the draft",
    async (route) => {
      typeDraft("123");
      await render(route);
      expect(field.value).toBe("123");
      expect([field.selectionStart, field.selectionEnd]).toEqual([1, 2]);
      expect(document.activeElement).toBe(field);
      expect(field.getAttribute("aria-valuenow")).toBe("12");
      expect(custom).toEqual([]);
      expect(native).toEqual(["input"]);
      expect(new FormData(document.querySelector("form") as HTMLFormElement).get("quantity")).toBe(
        "123",
      );
      confirm();
      await tick();
      expect(custom).toEqual(["change:123"]);
      expect(native).toEqual(["input", "change"]);
      confirm();
      expect(custom).toEqual(["change:123"]);
    },
  );

  it.each(
    ["control", "morph", "reconnect"].flatMap((route) =>
      [12, 100].map((accepted) => ({ route, accepted })),
    ),
  )(
    "applies max 100 once at confirmation from $accepted after $route",
    async ({ route, accepted }) => {
      if (accepted !== 12) {
        field.value = String(accepted);
        confirm();
        custom.length = 0;
        native.length = 0;
      }
      typeDraft("123");
      range("max", "100");
      await render(route);
      expect(field.value).toBe("123");
      expect([field.selectionStart, field.selectionEnd]).toEqual([1, 2]);
      expect(field.getAttribute("aria-valuenow")).toBe(String(accepted));
      expect(field.getAttribute("aria-valuemax")).toBe("1000");
      expect(custom).toEqual([]);
      const normalize = vi.spyOn(steppedValue, "snapSteppedValue");
      confirm();
      await tick();
      expect(normalize).toHaveBeenCalledTimes(1);
      expect(field.value).toBe("100");
      expect(field.getAttribute("aria-valuemax")).toBe("100");
      expect(custom).toEqual(accepted === 100 ? [] : ["change:100"]);
      expect(native).toEqual(["input", "change"]);
      expect(new FormData(document.querySelector("form") as HTMLFormElement).get("quantity")).toBe(
        "100",
      );
    },
  );

  it("uses the last of successive declarations without normalizing the draft", async () => {
    typeDraft("123");
    range("max", "100");
    await render("morph");
    range("min", "5");
    range("step", "20");
    range("max", "200");
    await render("reconnect");
    range("step", "25");
    await render("morph");
    expect(field.value).toBe("123");
    expect([field.selectionStart, field.selectionEnd]).toEqual([1, 2]);
    expect(custom).toEqual([]);
    confirm();
    await tick();
    expect(field.value).toBe("130");
    expect(custom).toEqual(["change:130"]);
  });

  it.each([
    { text: "17", min: "12", max: "1000", step: "10", expected: "22" },
    { text: "93", min: "0", max: "94", step: "10", expected: "94" },
    { text: "1.25", min: "0.1", max: "10", step: "0.2", expected: "1.3" },
  ])(
    "snaps $text to the endpoint and step grid when it is confirmed",
    async ({ text, min, max, step, expected }) => {
      typeDraft(text);
      range("min", min);
      range("max", max);
      range("step", step);
      await render("morph");
      expect(field.value).toBe(text);
      expect(custom).toEqual([]);
      confirm();
      await tick();
      expect(field.value).toBe(expected);
      expect(custom).toEqual([`change:${expected}`]);
    },
  );

  it("drops no user confirmation when declarations change and then return", async () => {
    typeDraft("123");
    range("max", "100");
    range("step", "10");
    await render("morph");
    range("max", "1000");
    range("step", "1");
    await render("reconnect");
    expect(custom).toEqual([]);
    expect(field.value).toBe("123");
    confirm();
    await tick();
    expect(custom).toEqual(["change:123"]);
  });

  it.each([
    { text: "", value: "", reports: [] },
    { text: "-", value: "0", reports: ["change:0"] },
    { text: "012", value: "12", reports: [] },
    { text: "12.0", value: "12", reports: [] },
    { text: "１２３", value: "123", reports: ["change:123"] },
  ])(
    "keeps an unconfirmed spelling $text until its confirmation",
    async ({ text, value, reports }) => {
      typeDraft(text);
      await render("morph");
      await render("reconnect");
      expect(field.value).toBe(text);
      expect(field.getAttribute("aria-valuenow")).toBe("12");
      expect(custom).toEqual([]);
      confirm();
      await tick();
      expect(field.value).toBe(value);
      expect(custom).toEqual(reports);
      if (text === "") {
        typeDraft("12");
        confirm();
        expect(custom).toEqual(["change:12"]);
      }
    },
  );

  it.each([false, true])(
    "reconciles a distinct page write on a focused field after draft=%s",
    async (edited) => {
      field.focus();
      if (edited) typeDraft("123");
      field.value = "777";
      await render("morph");
      expect(field.value).toBe("777");
      expect(custom).toEqual(["reconcile:777"]);
      confirm();
      expect(custom).toEqual(["reconcile:777"]);
    },
  );

  it("retains page-caused range reconciliation on a focused field with no draft", async () => {
    field.focus();
    range("max", "10");
    await tick();
    expect(field.value).toBe("10");
    expect(custom).toEqual(["reconcile:10"]);
    expect(native).toEqual([]);
  });

  it("resumes a held range when ordinary typing returns to the accepted text", async () => {
    field.value = "100";
    confirm();
    custom.length = 0;
    native.length = 0;
    typeDraft("123");
    range("max", "50");
    await tick();
    expect(field.value).toBe("123");
    expect(field.getAttribute("aria-valuemax")).toBe("1000");
    typeDraft("100");
    await tick();
    expect(field.value).toBe("50");
    expect(field.getAttribute("aria-valuenow")).toBe("50");
    expect(field.getAttribute("aria-valuemax")).toBe("50");
    expect(custom).toEqual(["reconcile:50"]);
    expect(native).toEqual(["input", "input"]);
  });

  it.each(["before composition", "during composition"])(
    "keeps the draft an IME cancel returns to and applies a range held %s at its confirmation",
    async (timing) => {
      typeDraft("123");
      if (timing === "before composition") {
        range("max", "100");
        await tick();
      }
      field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      field.value = "1239";
      field.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          isComposing: true,
          inputType: "insertCompositionText",
          data: "9",
        }),
      );
      if (timing === "during composition") range("max", "100");
      await tick();
      expect(field.value).toBe("1239");
      expect(custom).toEqual([]);
      field.value = "123";
      field.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          isComposing: true,
          inputType: "deleteCompositionText",
          data: "",
        }),
      );
      field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
      await tick();
      expect(field.value).toBe("123");
      expect(field.getAttribute("aria-valuenow")).toBe("12");
      expect(field.getAttribute("aria-valuemax")).toBe("1000");
      expect(custom).toEqual([]);
      confirm();
      await tick();
      expect(field.value).toBe("100");
      expect(field.getAttribute("aria-valuenow")).toBe("100");
      expect(field.getAttribute("aria-valuemax")).toBe("100");
      expect(custom).toEqual(["change:100"]);
    },
  );

  it("normalizes only once when a queued range pass follows confirmation", async () => {
    typeDraft("123");
    range("max", "100");
    const normalize = vi.spyOn(steppedValue, "snapSteppedValue");
    confirm();
    await tick();
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(custom).toEqual(["change:100"]);
    expect(native).toEqual(["input", "change"]);
  });

  it("keeps the new confirmation when a change subscriber confirms another value", async () => {
    typeDraft("123");
    range("max", "100");
    await tick();
    root.addEventListener(
      "stimeo--number-input:change",
      () => {
        field.value = "50";
        confirm();
      },
      { once: true },
    );
    confirm();
    await render("morph");
    expect(field.value).toBe("50");
    expect(field.getAttribute("aria-valuenow")).toBe("50");
    expect(custom).toEqual(["change:100", "change:50"]);
  });

  it("confirms a draft with a step using the latest range and one native input/change pair", async () => {
    typeDraft("123");
    range("max", "100");
    await tick();
    instance.increment();
    await tick();
    expect(field.value).toBe("100");
    expect(custom).toEqual(["change:100"]);
    expect(native).toEqual(["input", "input", "change"]);
  });

  it("does not transfer the old draft to a replacement input", async () => {
    typeDraft("123");
    const replacement = field.cloneNode(true) as HTMLInputElement;
    replacement.value = "20";
    field.replaceWith(replacement);
    instance.inputTargetDisconnected(field);
    instance.inputTargetConnected(replacement);
    await tick();
    expect(replacement.value).toBe("20");
    expect(custom).toEqual(["reconcile:20"]);
  });

  it("protects only the editing field's value during a morph", async () => {
    typeDraft("123");
    const valueWrite = new CustomEvent("turbo:before-morph-attribute", {
      bubbles: true,
      cancelable: true,
      detail: { attributeName: "value", mutationType: "update" },
    });
    field.dispatchEvent(valueWrite);
    expect(valueWrite.defaultPrevented).toBe(true);
    const minWrite = new CustomEvent("turbo:before-morph-attribute", {
      bubbles: true,
      cancelable: true,
      detail: { attributeName: "min", mutationType: "update" },
    });
    field.dispatchEvent(minWrite);
    expect(minWrite.defaultPrevented).toBe(false);
    confirm();
    const settledWrite = new CustomEvent("turbo:before-morph-attribute", {
      bubbles: true,
      cancelable: true,
      detail: { attributeName: "value", mutationType: "update" },
    });
    field.dispatchEvent(settledWrite);
    expect(settledWrite.defaultPrevented).toBe(false);
  });

  it("releases the typing and morph-value listeners when disconnected", () => {
    instance.disconnect();
    typeDraft("123");
    const event = new CustomEvent("turbo:before-morph-attribute", {
      bubbles: true,
      cancelable: true,
      detail: { attributeName: "value", mutationType: "update" },
    });
    field.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    instance.connect();
    confirm();
    expect(custom).toEqual([]);
  });

  it.each([null, "", "insertCompositionText", "insertFromComposition"])(
    "holds the IME range through its confirmation echo %s until the user confirms",
    async (inputType) => {
      field.focus();
      field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(field, "１２３");
      range("max", "100");
      await tick();
      expect(field.value).toBe("１２３");
      expect(field.getAttribute("aria-valuenow")).toBe("12");
      expect(custom).toEqual([]);
      field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      if (inputType !== null) {
        field.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType, isComposing: false }),
        );
      }
      await tick();
      expect(field.value).toBe("１２３");
      expect(field.getAttribute("aria-valuenow")).toBe("12");
      expect(custom).toEqual([]);
      confirm();
      await tick();
      expect(field.value).toBe("100");
      expect(field.getAttribute("aria-valuenow")).toBe("100");
      expect(custom).toEqual(["change:100"]);
      confirm();
      expect(custom).toEqual(["change:100"]);
    },
  );

  it("does not report a focus-listener confirmation again from the restoring pass", async () => {
    range("max", "12");
    await tick();
    const increment = root.querySelector("button") as HTMLButtonElement;
    increment.disabled = false;
    increment.focus();
    expect(document.activeElement).toBe(increment);
    field.addEventListener(
      "focus",
      () => {
        field.value = "5";
        confirm();
      },
      { once: true },
    );
    await render("morph");
    expect(field.value).toBe("5");
    expect(field.getAttribute("aria-valuenow")).toBe("5");
    expect(custom).toEqual(["change:5"]);
    expect(native).toEqual(["change"]);
  });

  it("adopts a detached field as page state after it lost focus before reconnecting", async () => {
    typeDraft("123");
    field.remove();
    expect(document.activeElement).not.toBe(field);
    instance.disconnect();
    root.append(field);
    field.focus();
    instance.connect();
    await tick();
    expect(field.value).toBe("123");
    expect(field.getAttribute("aria-valuenow")).toBe("123");
    expect(custom).toEqual([]);
    confirm();
    expect(custom).toEqual([]);
  });

  it("keeps the same focused draft when its input target leaves and returns before a pass", async () => {
    typeDraft("123");
    field.removeAttribute("data-stimeo--number-input-target");
    instance.inputTargetDisconnected(field);
    field.setAttribute("data-stimeo--number-input-target", "input");
    instance.inputTargetConnected(field);
    await tick();
    expect(field.value).toBe("123");
    expect(field.getAttribute("aria-valuenow")).toBe("12");
    expect(custom).toEqual([]);
    confirm();
    expect(custom).toEqual(["change:123"]);
  });

  it("ignores a nested input event when its own input is absent", async () => {
    field.remove();
    await tick();
    const other = document.createElement("input");
    root.append(other);
    const errors: string[] = [];
    const onError = (event: ErrorEvent): void => {
      errors.push(event.message);
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    try {
      other.focus();
      other.dispatchEvent(new InputEvent("input", { bubbles: true }));
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener("error", onError);
    }
    expect(custom).toEqual([]);
    field.value = "20";
    root.prepend(field);
    await tick();
    expect(custom).toEqual(["reconcile:20"]);
  });

  it.each(["other target", "unfocused field"])(
    "does not turn a page write into a draft after an input on %s",
    async (origin) => {
      const other = document.createElement("input");
      root.append(other);
      if (origin === "other target") field.focus();
      else other.focus();
      field.value = "123";
      const target = origin === "other target" ? other : field;
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      field.focus();
      range("max", "100");
      await render("morph");
      expect(field.value).toBe("100");
      expect(field.getAttribute("aria-valuenow")).toBe("100");
      expect(custom).toEqual(["reconcile:100"]);
    },
  );

  it("leaves a value morph on another input uncancelled while its own draft is focused", () => {
    typeDraft("123");
    const other = document.createElement("input");
    root.append(other);
    const event = new CustomEvent("turbo:before-morph-attribute", {
      bubbles: true,
      cancelable: true,
      detail: { attributeName: "value", mutationType: "update" },
    });
    other.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(field.value).toBe("123");
    expect(custom).toEqual([]);
  });

  /** Starts a composition in the field and leaves `draft` as its text. */
  const compose = (draft: string): void => {
    field.focus();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    composeDraft(field, draft);
  };

  /** Ends the composition with `compositionend`, as a confirmation or a cancel does. */
  const endComposition = (): void => {
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
  };

  const submitted = () =>
    new FormData(document.querySelector("form") as HTMLFormElement).get("quantity");

  it.each([
    { held: false, kind: "typed" },
    { held: true, kind: "typed" },
    { held: true, kind: "blank" },
  ])(
    "reports a later IME confirmation as change after a $kind confirmation (range held: $held)",
    async ({ held, kind }) => {
      typeDraft(kind === "typed" ? "123" : "");
      if (held) range("max", "100");
      await tick();
      confirm();
      await tick();
      custom.length = 0;

      compose("５０");
      endComposition();
      await tick();
      expect(field.value).toBe("５０");
      expect(custom).toEqual([]);

      confirm();
      await tick();
      expect(field.value).toBe("50");
      expect(custom).toEqual(["change:50"]);
    },
  );

  it.each(["typed", "blank"])(
    "owes nothing after a %s confirmation applied the held range, when a write later ends a composition",
    async (kind) => {
      typeDraft(kind === "typed" ? "123" : "");
      range("max", "100");
      await tick();
      confirm();
      await tick();
      custom.length = 0;

      compose("５０");
      // A script writes the field, and the engine drops the conversion without compositionend.
      field.value = "40";
      keyboardPress(field, "ArrowUp");
      await tick();

      // Nothing was held, so the written text waits for the user, who steps from it.
      expect(field.value).toBe("41");
      expect(custom).toEqual(["change:41"]);
    },
  );

  it("reports a later confirmation as change after an engine stopped composing, once a confirmation applied the held range", async () => {
    typeDraft("123");
    range("max", "100");
    await tick();
    confirm();
    await tick();
    custom.length = 0;

    compose("５０");
    // The engine stops composing; the next key is ordinary typing.
    field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        isComposing: false,
        data: "0",
      }),
    );
    await tick();
    expect(field.value).toBe("５０");
    expect(custom).toEqual([]);

    confirm();
    await tick();
    expect(custom).toEqual(["change:50"]);
  });

  it.each([false, true])(
    "keeps the text an IME confirmed as a draft through a morph (range changed: %s)",
    async (changed) => {
      typeDraft("1");
      compose("1２３");
      if (changed) range("max", "100");
      endComposition();
      await render("morph");
      expect(field.value).toBe("1２３");
      expect(field.getAttribute("aria-valuenow")).toBe("12");
      expect(field.getAttribute("aria-valuemax")).toBe("1000");
      expect(custom).toEqual([]);
      expect(submitted()).toBe("1２３");

      confirm();
      await tick();
      expect(field.value).toBe(changed ? "100" : "123");
      expect(field.getAttribute("aria-valuemax")).toBe(changed ? "100" : "1000");
      expect(custom).toEqual([changed ? "change:100" : "change:123"]);
      expect(submitted()).toBe(changed ? "100" : "123");
    },
  );

  it("keeps the text a composition left when the engine stopped composing as a draft under a held range", async () => {
    compose("１２３");
    range("max", "100");
    await tick();
    // The engine stops composing; the next key is ordinary typing.
    field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        isComposing: false,
        data: "4",
      }),
    );
    await tick();
    expect(field.value).toBe("１２３");
    expect(field.getAttribute("aria-valuemax")).toBe("1000");
    expect(custom).toEqual([]);

    confirm();
    await tick();
    expect(field.value).toBe("100");
    expect(custom).toEqual(["change:100"]);
  });

  it("reconciles the range a composition held once a cancel returns to the accepted text", async () => {
    compose("１２３");
    range("max", "10");
    await tick();
    field.value = "12";
    endComposition();
    await tick();
    expect(field.value).toBe("10");
    expect(custom).toEqual(["reconcile:10"]);
  });

  it("keeps a composition's text across a reconnection over a turn that loses track of it", async () => {
    compose("１２３");
    root.setAttribute("data-controller", "");
    await tick();
    root.setAttribute("data-controller", "stimeo--number-input");
    await tick();
    // The controller has lost track of the conversion, but its text is still the user's draft.
    expect(field.value).toBe("１２３");
    expect(field.getAttribute("aria-valuenow")).toBe("12");
    expect(custom).toEqual([]);

    endComposition();
    confirm();
    await tick();
    expect(field.value).toBe("123");
    expect(custom).toEqual(["change:123"]);
  });

  it.each([true, false])(
    "treats the same input leaving the targets and coming back as the same field while it keeps focus (%s)",
    async (focused) => {
      typeDraft("123");
      field.removeAttribute("data-stimeo--number-input-target");
      await tick();
      // Focus that leaves while the input is out, and comes back, ends the draft all the same.
      if (!focused) {
        field.blur();
        field.focus();
      }
      field.setAttribute("data-stimeo--number-input-target", "input");
      await tick();
      if (focused) {
        expect(field.value).toBe("123");
        expect(field.getAttribute("aria-valuenow")).toBe("12");
        expect(custom).toEqual([]);
        field.focus();
        confirm();
        await tick();
        expect(custom).toEqual(["change:123"]);
      } else {
        expect(custom).toEqual(["reconcile:123"]);
      }
    },
  );

  it("ends a draft out of the targets only when its input loses focus, not when the window does", async () => {
    typeDraft("123");
    field.removeAttribute("data-stimeo--number-input-target");
    await tick();
    // The window loses focus: the field blurs, yet stays the document's active element.
    field.dispatchEvent(new FocusEvent("blur"));
    field.setAttribute("data-stimeo--number-input-target", "input");
    await tick();
    expect(field.value).toBe("123");
    expect(custom).toEqual([]);
    confirm();
    await tick();
    expect(custom).toEqual(["change:123"]);
  });

  it("goes on watching a draft out of the targets after the window lost focus", async () => {
    typeDraft("123");
    field.removeAttribute("data-stimeo--number-input-target");
    await tick();
    field.dispatchEvent(new FocusEvent("blur"));
    // Back in the window, the user leaves the field and comes back to it.
    field.blur();
    field.focus();
    field.setAttribute("data-stimeo--number-input-target", "input");
    await tick();
    expect(custom).toEqual(["reconcile:123"]);
  });

  it("ends a draft out of the targets whose input had no focus when the controller last looked", async () => {
    typeDraft("123");
    field.blur();
    field.removeAttribute("data-stimeo--number-input-target");
    await tick();
    field.focus();
    field.setAttribute("data-stimeo--number-input-target", "input");
    await tick();
    expect(custom).toEqual(["reconcile:123"]);
  });

  it.each([true, false])(
    "keeps a draft across a disconnection only while its input keeps focus (%s)",
    async (focused) => {
      typeDraft("123");
      root.setAttribute("data-controller", "");
      await tick();
      if (!focused) {
        field.blur();
        field.focus();
      }
      root.setAttribute("data-controller", "stimeo--number-input");
      await tick();
      expect(field.value).toBe("123");
      if (focused) {
        expect(field.getAttribute("aria-valuenow")).toBe("12");
        confirm();
        await tick();
        expect(custom).toEqual(["change:123"]);
      } else {
        // Editing ended while the controller was disconnected: connecting takes the field's number
        // silently.
        expect(field.getAttribute("aria-valuenow")).toBe("123");
        confirm();
        await tick();
        expect(custom).toEqual([]);
      }
    },
  );

  it("takes no draft from a composition that ends in an input other than the first", async () => {
    const second = field.cloneNode() as HTMLInputElement;
    second.value = "7";
    field.after(second);
    await tick();
    custom.length = 0;
    typeDraft("123");
    // The page writes the first input with no input event.
    field.value = "50";
    second.focus();
    second.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(second, "８");
    second.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    field.focus();
    await render("morph");
    expect(field.value).toBe("50");
    expect(custom).toEqual(["reconcile:50"]);
  });

  it.each(["nothing", "a reconnection", "a return to the targets"])(
    "follows focus for a draft in sight after %s",
    async (route) => {
      typeDraft("123");
      if (route === "a reconnection") {
        reconnectKeepingFocus(instance);
        await tick();
      }
      if (route === "a return to the targets") {
        field.removeAttribute("data-stimeo--number-input-target");
        await tick();
        field.setAttribute("data-stimeo--number-input-target", "input");
        await tick();
      }
      // In sight, a blur with no change and focus coming back leave the draft being edited.
      field.blur();
      field.focus();
      range("max", "100");
      await tick();
      expect(field.value).toBe("123");
      expect(custom).toEqual([]);
    },
  );

  it("takes an unfocused field's leftover draft as the page's in a range pass", async () => {
    typeDraft("123");
    field.blur();
    expect(document.activeElement).not.toBe(field);
    range("max", "100");
    await tick();
    expect(field.value).toBe("100");
    expect(custom).toEqual(["reconcile:100"]);
  });

  it("protects a draft in a replacement input holding the same text as the one it replaced", async () => {
    const replacement = field.cloneNode(true) as HTMLInputElement;
    replacement.value = "12";
    field.replaceWith(replacement);
    await tick();
    field = replacement;
    expect(custom).toEqual([]);
    typeDraft("123");
    range("max", "100");
    await tick();
    expect(field.value).toBe("123");
    expect(custom).toEqual([]);
    confirm();
    await tick();
    expect(custom).toEqual(["change:100"]);
  });

  it("holds a range through a draft typed after a blank confirmation", async () => {
    typeDraft("");
    confirm();
    await tick();
    typeDraft("12");
    range("max", "500");
    await tick();
    expect(custom).toEqual([]);
    confirm();
    await tick();
    expect(custom).toEqual(["change:12"]);
  });

  it("takes a page write of the text a clamped confirmation replaced as the page's", async () => {
    typeDraft("1234");
    confirm();
    await tick();
    expect(field.value).toBe("1000");
    expect(custom).toEqual(["change:1000"]);
    field.value = "1234";
    await render("morph");
    expect(field.value).toBe("1000");
    expect(submitted()).toBe("1000");
    expect(custom).toEqual(["change:1000"]);
  });

  it("takes a page write of a draft's text as the page's once the page put the accepted text back", async () => {
    typeDraft("123");
    field.value = "12";
    await render("morph");
    expect(custom).toEqual([]);
    field.value = "123";
    await render("morph");
    expect(custom).toEqual(["reconcile:123"]);
    confirm();
    await tick();
    expect(custom).toEqual(["reconcile:123"]);
  });
});
