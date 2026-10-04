import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NumberInputController } from "../src/controllers/number_input_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
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
  const press = (k: string) =>
    input().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
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
    press("End");
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
    press("End");
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
    press("Home");
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
    press("End");
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
    const keydown = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      cancelable: true,
    });

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
    const chord = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    const changes = vi.fn();
    root().addEventListener("stimeo--number-input:change", changes);
    input().dispatchEvent(chord);

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
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      input().dispatchEvent(event);
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

    // Invoke disconnect directly instead of racing happy-dom's async MutationObserver.
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
    const event = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });

    input().dispatchEvent(event);

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

    input().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    const after = await captureSpeech({ container: input(), steps: 0 });
    expect(after).toEqual(["spinbutton, Level, max value 5, min value 1, 4"]);
  });

  it("syncs aria-valuenow/min/max on the spinbutton", () => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
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

    input().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));

    expect(input().value).toBe("4");
    expect(rangeAria(input())).toEqual(["99", "-99", "99"]);
  });

  it("starts from a clean composition state when it connects again", () => {
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const instance = controller();

    instance.disconnect();
    instance.connect();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));

    expect(input().value).toBe("4");
  });

  it("holds a range reconciliation while the field is composing, and runs it once the composition ends", async () => {
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--number-input:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input().value = "3４";
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
    input().value = "5";
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
    const perEvent = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(perEvent, "isComposing", { value: true });
    input().dispatchEvent(perEvent);
    expect(perEvent.defaultPrevented).toBe(false);
    expect(input().value).toBe("3");

    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const duringLifecycle = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });
    input().dispatchEvent(duringLifecycle);
    expect(duringLifecycle.defaultPrevented).toBe(false);
    expect(input().value).toBe("3");

    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
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
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(input().value).toBe("35");
  });

  it("reads a full-width value the markup brings when it connects", async () => {
    await mount("３４");
    expect(input().value).toBe("34");
    expect(input().getAttribute("aria-valuenow")).toBe("34");
  });

  it("reads full-width digits an IME confirmed when the held reconciliation runs", async () => {
    await mount("0");
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--number-input:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input().value = "３４";
    root().setAttribute("data-stimeo--number-input-max-value", "20");
    controller().maxValueChanged();
    await flushMicrotasks();
    expect(input().value).toBe("３４");

    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await flushMicrotasks();
    expect(input().value).toBe("20");
    expect(repairs).toEqual([{ value: 20 }]);
  });
});

/**
 * Press-and-hold auto-repeat (APG spinbutton convenience): holding a step button
 * starts repeated steps after a short delay until release / the bound /
 * disconnect. The `click` binding stays the single-step path, so a held press
 * must not also double-step via its trailing click. Driven with fake timers.
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
