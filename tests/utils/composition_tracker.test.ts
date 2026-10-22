import { afterEach, describe, expect, it, vi } from "vitest";
import { CompositionTracker, isCompositionInputType } from "../../src/utils/composition_tracker";
import { composeDraft } from "../helpers/ime";
import { keyEvent, typeKey } from "../helpers/keyboard";

/** Detached observed fields isolate composition delivery without DOM focus side effects. */
describe("CompositionTracker", () => {
  let tracker: CompositionTracker | null = null;

  afterEach(() => {
    tracker?.disconnect();
    tracker = null;
    document.body.innerHTML = "";
  });

  it("combines lifecycle state with the standard per-event signal", () => {
    const input = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(input);

    expect(tracker.isComposing()).toBe(false);
    expect(tracker.isComposing(keyEvent("", { isComposing: true }))).toBe(true);

    input.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(tracker.isComposing()).toBe(true);
    expect(tracker.isComposing(keyEvent(""))).toBe(true);

    input.dispatchEvent(new CompositionEvent("compositionend"));
    expect(tracker.isComposing()).toBe(false);
  });

  it("clears lifecycle state before running component-specific end work", () => {
    const input = document.createElement("input");
    const states: boolean[] = [];
    tracker = new CompositionTracker({
      onStart: () => states.push(tracker?.isComposing() ?? false),
      onEnd: () => states.push(tracker?.isComposing() ?? true),
    });
    tracker.observe(input);

    input.dispatchEvent(new CompositionEvent("compositionstart"));
    input.dispatchEvent(new CompositionEvent("compositionend"));

    expect(states).toEqual([true, false]);
  });

  it("observes idempotently and unobserves without leaving active state", () => {
    const input = document.createElement("input");
    const onEnd = vi.fn();
    tracker = new CompositionTracker({ onEnd });
    tracker.observe(input);
    tracker.observe(input);

    input.dispatchEvent(new CompositionEvent("compositionstart"));
    tracker.unobserve(input);
    expect(tracker.isComposing()).toBe(false);

    input.dispatchEvent(new CompositionEvent("compositionend"));
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("tracks multiple targets and disconnect removes all listeners", () => {
    const first = document.createElement("input");
    const second = document.createElement("input");
    const onEnd = vi.fn();
    tracker = new CompositionTracker({ onEnd });
    tracker.observe(first);
    tracker.observe(second);

    first.dispatchEvent(new CompositionEvent("compositionstart"));
    second.dispatchEvent(new CompositionEvent("compositionstart"));
    first.dispatchEvent(new CompositionEvent("compositionend"));
    expect(tracker.isComposing()).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);

    tracker.disconnect();
    expect(tracker.isComposing()).toBe(false);
    second.dispatchEvent(new CompositionEvent("compositionend"));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  /** Dispatches the `input` an engine sends, with the kind it reports (if any). */
  const sendInput = (target: EventTarget, inputType?: string): InputEvent => {
    const event = new InputEvent("input", { bubbles: true, ...(inputType ? { inputType } : {}) });
    target.dispatchEvent(event);
    return event;
  };

  it("folds the confirming input once, and only from the field that confirmed", () => {
    const input = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(input);

    input.dispatchEvent(new CompositionEvent("compositionend"));
    expect(tracker.consumesConfirmedInput(sendInput(input))).toBe(true);
    expect(tracker.consumesConfirmedInput(sendInput(input))).toBe(false);
  });

  it("closes the window on an input from another field", () => {
    const first = document.createElement("input");
    const second = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(first);
    tracker.observe(second);

    first.dispatchEvent(new CompositionEvent("compositionend"));
    expect(tracker.consumesConfirmedInput(sendInput(second))).toBe(false);
    expect(tracker.consumesConfirmedInput(sendInput(first))).toBe(false);
  });

  it("closes the window on a key and on a new composition", () => {
    const input = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(input);

    input.dispatchEvent(new CompositionEvent("compositionend"));
    typeKey(input, "a");
    expect(tracker.consumesConfirmedInput(sendInput(input))).toBe(false);

    input.dispatchEvent(new CompositionEvent("compositionend"));
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(tracker.consumesConfirmedInput(sendInput(input))).toBe(false);
  });

  it("folds an input the engine reports as part of the composition", () => {
    const input = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(input);

    for (const inputType of ["insertCompositionText", "insertFromComposition"]) {
      input.dispatchEvent(new CompositionEvent("compositionend"));
      expect(tracker.consumesConfirmedInput(sendInput(input, inputType))).toBe(true);
    }
  });

  it("passes an edit through even when it lands right after a confirmation", () => {
    // Dictation, autofill and a drop all arrive without a key, so the window
    // alone cannot tell them from an echo; the kind the engine reports can.
    const input = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(input);

    for (const inputType of ["insertText", "insertFromPaste", "insertFromDrop"]) {
      input.dispatchEvent(new CompositionEvent("compositionend"));
      expect(tracker.consumesConfirmedInput(sendInput(input, inputType))).toBe(false);
      expect(tracker.consumesConfirmedInput(sendInput(input))).toBe(false);
    }
  });

  it("drops the pending window when the field leaves or the tracker stops", () => {
    const input = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(input);

    input.dispatchEvent(new CompositionEvent("compositionend"));
    tracker.unobserve(input);
    expect(tracker.consumesConfirmedInput(sendInput(input))).toBe(false);

    tracker.observe(input);
    input.dispatchEvent(new CompositionEvent("compositionend"));
    tracker.disconnect();
    expect(tracker.consumesConfirmedInput(sendInput(input))).toBe(false);
  });

  it("stops listening for keys on a field it no longer observes", () => {
    const first = document.createElement("input");
    const second = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(first);
    tracker.observe(second);

    first.dispatchEvent(new CompositionEvent("compositionend"));
    tracker.unobserve(second);
    typeKey(second, "a");

    expect(tracker.consumesConfirmedInput(sendInput(first))).toBe(true);
  });

  it("stops tracking compositions on a field it released", () => {
    const input = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(input);
    tracker.unobserve(input);
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(tracker.isComposing()).toBe(false);

    tracker.observe(input);
    tracker.disconnect();
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(tracker.isComposing()).toBe(false);
  });

  it("stops listening for keys on every field once disconnected", () => {
    const first = document.createElement("input");
    const second = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(first);
    tracker.disconnect();
    tracker.observe(second);

    second.dispatchEvent(new CompositionEvent("compositionend"));
    typeKey(first, "a");

    expect(tracker.consumesConfirmedInput(sendInput(second))).toBe(true);
  });

  it("marks the field that confirmed, not the ancestor being observed", () => {
    document.body.innerHTML = `<form><input id="one"><input id="two"></form>`;
    const form = document.querySelector("form") as HTMLFormElement;
    const one = document.getElementById("one") as HTMLInputElement;
    const two = document.getElementById("two") as HTMLInputElement;
    tracker = new CompositionTracker();
    tracker.observe(form);

    one.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(tracker.consumesConfirmedInput(sendInput(two))).toBe(false);

    one.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(tracker.consumesConfirmedInput(sendInput(one))).toBe(true);
  });

  /** Dispatches the cancelable notice Turbo sends before a morph writes one attribute. */
  const beforeMorph = (target: EventTarget, attributeName: string): CustomEvent => {
    const event = new CustomEvent("turbo:before-morph-attribute", {
      bubbles: true,
      cancelable: true,
      detail: { attributeName, mutationType: "update" },
    });
    target.dispatchEvent(event);
    return event;
  };

  it("keeps a Turbo morph from rewriting the value of a field mid-composition", () => {
    const input = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(input);

    expect(beforeMorph(input, "value").defaultPrevented).toBe(false);
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(beforeMorph(input, "value").defaultPrevented).toBe(true);
    expect(beforeMorph(input, "aria-invalid").defaultPrevented).toBe(false);

    input.dispatchEvent(new CompositionEvent("compositionend"));
    expect(beforeMorph(input, "value").defaultPrevented).toBe(false);
  });

  it("guards only the field composing under an observed ancestor", () => {
    document.body.innerHTML = `<form><input id="one"><input id="two"></form>`;
    const form = document.querySelector("form") as HTMLFormElement;
    const one = document.getElementById("one") as HTMLInputElement;
    const two = document.getElementById("two") as HTMLInputElement;
    tracker = new CompositionTracker();
    tracker.observe(form);

    one.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));

    expect(beforeMorph(one, "value").defaultPrevented).toBe(true);
    expect(beforeMorph(two, "value").defaultPrevented).toBe(false);
    expect(beforeMorph(form, "value").defaultPrevented).toBe(false);
  });

  it("stops guarding a field it released, and every field once disconnected", () => {
    const first = document.createElement("input");
    const second = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(first);
    tracker.observe(second);
    first.dispatchEvent(new CompositionEvent("compositionstart"));
    second.dispatchEvent(new CompositionEvent("compositionstart"));

    tracker.unobserve(first);
    expect(beforeMorph(first, "value").defaultPrevented).toBe(false);
    expect(beforeMorph(second, "value").defaultPrevented).toBe(true);

    tracker.disconnect();
    expect(beforeMorph(second, "value").defaultPrevented).toBe(false);
  });

  /** Applies an edit the engine itself dispatches the `input` for: a user's key, `execCommand`. */
  const engineEdit = (field: EventTarget & { value: string }, text: string, inputType: string) => {
    field.value = text;
    const event = new InputEvent("input", { bubbles: true, inputType, isComposing: false });
    Object.defineProperty(event, "isTrusted", { value: true });
    field.dispatchEvent(event);
  };

  /** Dispatches the `beforeinput` an engine sends ahead of an edit. */
  const beforeInput = (target: EventTarget, inputType: string, isComposing: boolean): void => {
    target.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType, isComposing }));
  };

  /** Starts a composition on `field` and writes its first draft, as an IME does. */
  const startComposing = (field: HTMLInputElement, draft = "か"): void => {
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(field, draft);
  };

  it("keeps composing while the field holds what the composition and the user's own edits left", () => {
    const input = document.createElement("input");
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(input);
    startComposing(input, "あい");

    // A key the IME lets through, and `execCommand`, edit the field mid-conversion.
    input.dispatchEvent(keyEvent("Backspace", { isComposing: true }));
    beforeInput(input, "deleteContentBackward", false);
    engineEdit(input, "あ", "deleteContentBackward");
    engineEdit(input, "あz", "insertText");
    composeDraft(input, "愛z");
    // Writing the same text leaves the conversion in place.
    input.value = "愛z";
    input.dispatchEvent(keyEvent("Enter", { isComposing: true }));

    expect(tracker.isComposing()).toBe(true);
    expect(beforeMorph(input, "value").defaultPrevented).toBe(true);
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it.each([
    ["the next key", (input: HTMLInputElement) => input.dispatchEvent(keyEvent("x"))],
    ["the next edit", (input: HTMLInputElement) => beforeInput(input, "insertText", false)],
    [
      "the input a script sends after its write",
      (input: HTMLInputElement) => input.dispatchEvent(new Event("input", { bubbles: true })),
    ],
  ])("ends a composition whose field a write changed, at %s", (_name, next) => {
    const input = document.createElement("input");
    const onEnd = vi.fn();
    const onAbandon = vi.fn(() => expect(tracker?.isComposing()).toBe(false));
    tracker = new CompositionTracker({ onEnd, onAbandon });
    tracker.observe(input);
    startComposing(input);
    input.value = "";
    expect(onAbandon).not.toHaveBeenCalled();

    next(input);

    expect(onAbandon).toHaveBeenCalledTimes(1);
    expect(tracker.isComposing()).toBe(false);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("ends a composition a write changed at a question, and runs onAbandon after the question", async () => {
    const input = document.createElement("input");
    const states: boolean[] = [];
    const onAbandon = vi.fn(() => states.push(tracker?.isComposing() ?? true));
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(input);
    startComposing(input);
    input.value = "";

    expect(tracker.isComposing()).toBe(false);
    expect(onAbandon).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(onAbandon).toHaveBeenCalledTimes(1);
    expect(states).toEqual([false]);
  });

  it("lets a Turbo morph write the field once a write ended its composition, then runs onAbandon", async () => {
    const input = document.createElement("input");
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(input);
    startComposing(input);

    input.value = "";

    expect(beforeMorph(input, "value").defaultPrevented).toBe(false);
    // Never inside a half-applied morph.
    expect(onAbandon).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(onAbandon).toHaveBeenCalledTimes(1);
  });

  it("runs an owed onAbandon in the next event it hears, ahead of that event's handlers, once", async () => {
    const input = document.createElement("input");
    const seen: string[] = [];
    input.addEventListener("input", () => seen.push("input handler"));
    tracker = new CompositionTracker({ onAbandon: () => seen.push("abandon") });
    tracker.observe(input);
    startComposing(input);
    seen.length = 0;
    input.value = "x";
    tracker.isComposing();

    // A script's own input arrives before the microtask the question queued.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();

    expect(seen).toEqual(["abandon", "input handler"]);
  });

  it("runs an owed onAbandon ahead of the confirmation an engine still sends, which onEnd takes as is", async () => {
    const input = document.createElement("input");
    const seen: string[] = [];
    tracker = new CompositionTracker({
      onEnd: () => seen.push(`end, composing: ${tracker?.isComposing()}`),
      onAbandon: () => seen.push("abandon"),
    });
    tracker.observe(input);
    startComposing(input);
    input.value = "x";
    tracker.isComposing();

    // An engine that keeps composing across a write confirms before the microtask runs.
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await Promise.resolve();

    expect(seen).toEqual(["abandon", "end, composing: false"]);
    expect(tracker.consumesConfirmedInput(sendInput(input, "insertCompositionText"))).toBe(true);
  });

  it.each([
    ["reports the composition", "insertText", true],
    ["names a composition's own kind", "deleteCompositionText", false],
    ["names no kind of edit", "", false],
  ])(
    "keeps a composition at a beforeinput that %s, with no key before it",
    (_name, inputType, isComposing) => {
      const input = document.createElement("input");
      const onAbandon = vi.fn();
      tracker = new CompositionTracker({ onAbandon });
      tracker.observe(input);
      startComposing(input);

      beforeInput(input, inputType, isComposing);

      expect(tracker.isComposing()).toBe(true);
      expect(onAbandon).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "a write, at the next key",
      false,
      (input: HTMLInputElement) => {
        input.value = "";
        input.dispatchEvent(keyEvent("x"));
      },
    ],
    [
      "the engine's next plain edit",
      true,
      (input: HTMLInputElement) => beforeInput(input, "insertText", false),
    ],
    [
      "a composition starting on the same field",
      true,
      (input: HTMLInputElement) =>
        input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })),
    ],
    [
      "a write, at a composition starting on the same field",
      false,
      (input: HTMLInputElement) => {
        input.value = "";
        input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      },
    ],
  ])(
    "tells onAbandon the element and whether its text is the composition's, after %s",
    (_name, inPlace, end) => {
      const input = document.createElement("input");
      const onAbandon = vi.fn();
      tracker = new CompositionTracker({ onAbandon });
      tracker.observe(input);
      startComposing(input);

      end(input);

      expect(onAbandon.mock.calls).toEqual([[input, inPlace]]);
    },
  );

  it("tells onAbandon the element that composed, not the one whose edit showed the end", () => {
    const first = document.createElement("input");
    const second = document.createElement("input");
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(first);
    tracker.observe(second);
    startComposing(first);

    beforeInput(second, "insertText", false);

    expect(onAbandon.mock.calls).toEqual([[first, true]]);
  });

  it("tells onAbandon the field that composed under an observed ancestor", () => {
    document.body.innerHTML = `<form><input id="one"></form>`;
    const form = document.querySelector("form") as HTMLFormElement;
    const one = document.getElementById("one") as HTMLInputElement;
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(form);
    one.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(one, "か");

    one.value = "";
    one.dispatchEvent(keyEvent("x", { bubbles: true }));

    expect(onAbandon.mock.calls).toEqual([[one, false]]);
  });

  it("drops an owed onAbandon when it disconnects", async () => {
    const input = document.createElement("input");
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(input);
    startComposing(input);
    input.value = "";
    tracker.isComposing();

    tracker.disconnect();
    await Promise.resolve();

    expect(onAbandon).not.toHaveBeenCalled();
  });

  it("ends a composition the engine stopped with its text in place, at the next plain edit", () => {
    const input = document.createElement("input");
    const onAbandon = vi.fn(() => expect(tracker?.isComposing()).toBe(false));
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(input);
    startComposing(input, "か");
    expect(tracker.isComposing()).toBe(true);

    // The engine no longer composes: its next key and edit say so, and the text stays.
    input.dispatchEvent(keyEvent("y", { isComposing: false }));
    expect(onAbandon).not.toHaveBeenCalled();
    beforeInput(input, "insertText", false);

    expect(onAbandon).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("か");
  });

  it("ends a composition held on one field at a plain edit with no key on another field it observes", () => {
    const first = document.createElement("input");
    const second = document.createElement("input");
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(first);
    tracker.observe(second);
    startComposing(first);

    // Dictation and autofill edit with no key in front of them.
    beforeInput(second, "insertCompositionText", true);
    expect(tracker.isComposing()).toBe(true);
    beforeInput(second, "insertText", false);

    expect(tracker.isComposing()).toBe(false);
    expect(onAbandon).toHaveBeenCalledTimes(1);
  });

  it("tells an event in the element composing from one in another element, keeping the composition", () => {
    const first = document.createElement("input");
    const second = document.createElement("input");
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(first);
    tracker.observe(second);
    const elsewhere = new Event("input", { bubbles: true });
    second.dispatchEvent(elsewhere);
    expect(tracker.owns(elsewhere)).toBe(false);
    startComposing(first);

    // A script writes another field and reports it with a bare `input`, no `beforeinput`.
    second.value = "1";
    const scripted = new Event("input", { bubbles: true });
    second.dispatchEvent(scripted);
    expect(tracker.owns(scripted)).toBe(false);
    expect(tracker.isComposing()).toBe(true);
    expect(tracker.composingElement()).toBe(first);

    const key = keyEvent("Enter");
    first.dispatchEvent(key);
    expect(tracker.owns(key)).toBe(true);
    expect(tracker.owns(keyEvent("a", { isComposing: true }))).toBe(true);
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it("ends a composition a write ended before telling whether an event in its element is its own", () => {
    const input = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(input);
    startComposing(input);

    input.value = "x";
    const scripted = new Event("input");
    Object.defineProperty(scripted, "target", { value: input });
    expect(tracker.owns(scripted)).toBe(false);
    expect(tracker.composingElement()).toBeNull();
  });

  it("keeps a composition when the key behind a plain edit reported composing", () => {
    const input = document.createElement("input");
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(input);
    startComposing(input);

    // A key the IME lets through still reports the composition it landed in.
    input.dispatchEvent(keyEvent("Backspace", { isComposing: true }));
    beforeInput(input, "deleteContentBackward", false);
    expect(tracker.isComposing()).toBe(true);
    expect(onAbandon).not.toHaveBeenCalled();

    input.dispatchEvent(keyEvent("x", { isComposing: false }));
    beforeInput(input, "insertText", false);
    expect(tracker.isComposing()).toBe(false);
    expect(onAbandon).toHaveBeenCalledTimes(1);
  });

  it("reads the key's composition flag for the next beforeinput only", () => {
    const input = document.createElement("input");
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(input);
    startComposing(input);
    input.dispatchEvent(keyEvent("a", { isComposing: true }));
    beforeInput(input, "insertCompositionText", true);

    beforeInput(input, "insertText", false);

    expect(tracker.isComposing()).toBe(false);
    expect(onAbandon).toHaveBeenCalledTimes(1);
  });

  it("forgets the last key's composition flag when it disconnects", () => {
    const input = document.createElement("input");
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(input);
    input.dispatchEvent(keyEvent("a", { isComposing: true }));

    tracker.disconnect();
    tracker.observe(input);
    startComposing(input);
    beforeInput(input, "insertText", false);

    expect(onAbandon).toHaveBeenCalledTimes(1);
  });

  it("checks at a blur, ahead of a blur handler bound before it", () => {
    document.body.innerHTML = `<input id="one"><input id="two">`;
    const one = document.getElementById("one") as HTMLInputElement;
    const two = document.getElementById("two") as HTMLInputElement;
    const seen: string[] = [];
    one.addEventListener("blur", () =>
      seen.push(`blur handler, composing: ${tracker?.isComposing()}`),
    );
    tracker = new CompositionTracker({ onAbandon: () => seen.push("abandon") });
    tracker.observe(one);
    one.focus();
    startComposing(one);
    one.value = "";

    two.focus();

    expect(seen).toEqual(["abandon", "blur handler, composing: false"]);
  });

  it("runs onAbandon ahead of the handler a consumer bound to the event that shows the end", () => {
    const input = document.createElement("input");
    const seen: string[] = [];
    // Stimulus binds a controller's actions before the controller observes anything.
    input.addEventListener("keydown", () => seen.push("keydown handler"));
    input.addEventListener("input", (event) =>
      seen.push(`input handler, composing: ${tracker?.isComposing(event as InputEvent)}`),
    );
    tracker = new CompositionTracker({ onAbandon: () => seen.push("abandon") });
    tracker.observe(input);
    startComposing(input);
    composeDraft(input, "かな");
    input.value = "x";

    input.dispatchEvent(keyEvent("y"));

    expect(seen).toEqual([
      "input handler, composing: true",
      "input handler, composing: true",
      "abandon",
      "keydown handler",
    ]);
  });

  it("ends a composition under an observed ancestor whose field a write changed, at an edit elsewhere inside it", () => {
    document.body.innerHTML = `<form><input id="one"><input id="two"></form>`;
    const form = document.querySelector("form") as HTMLFormElement;
    const one = document.getElementById("one") as HTMLInputElement;
    const two = document.getElementById("two") as HTMLInputElement;
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(form);
    startComposing(one);
    one.value = "";

    // An edit the engine dispatched elsewhere says nothing about the composing field's text.
    engineEdit(two, "x", "insertText");

    expect(onAbandon).toHaveBeenCalledTimes(1);
    expect(beforeMorph(one, "value").defaultPrevented).toBe(false);
  });

  it("ends quietly a composition whose field loses focus inside an observed ancestor, not one whose window does", () => {
    document.body.innerHTML = `<form><input id="one"><input id="two"></form>`;
    const form = document.querySelector("form") as HTMLFormElement;
    const one = document.getElementById("one") as HTMLInputElement;
    const two = document.getElementById("two") as HTMLInputElement;
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(form);
    one.focus();
    startComposing(one);

    // The window lost focus: the field is still the document's active element.
    one.dispatchEvent(new FocusEvent("blur"));
    two.dispatchEvent(new FocusEvent("blur"));
    expect(tracker.isComposing()).toBe(true);

    // Moving or removing the field takes focus with no compositionend before it, and
    // leaves the composition's text in place: nothing was overwritten.
    two.focus();

    expect(tracker.isComposing()).toBe(false);
    expect(beforeMorph(one, "value").defaultPrevented).toBe(false);
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it("ends with onAbandon a composition a write ended, when its field then loses focus", () => {
    document.body.innerHTML = `<form><input id="one"><input id="two"></form>`;
    const form = document.querySelector("form") as HTMLFormElement;
    const one = document.getElementById("one") as HTMLInputElement;
    const two = document.getElementById("two") as HTMLInputElement;
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(form);
    one.focus();
    startComposing(one);
    one.value = "";

    two.focus();

    // The write ended it first: the field holds what the write left, not the composition.
    expect(onAbandon).toHaveBeenCalledTimes(1);
    expect(tracker.isComposing()).toBe(false);
  });

  it("reads only the composing field's own focus change, not one elsewhere in the ancestor", () => {
    document.body.innerHTML = `<form><input id="one"><input id="two"></form>`;
    const form = document.querySelector("form") as HTMLFormElement;
    const one = document.getElementById("one") as HTMLInputElement;
    const two = document.getElementById("two") as HTMLInputElement;
    tracker = new CompositionTracker();
    tracker.observe(form);
    startComposing(one);

    two.focus();
    two.blur();

    expect(tracker.composingElement()).toBe(one);
  });

  it("leaves a field it observes itself to the consumer when that field loses focus", () => {
    document.body.innerHTML = `<input id="one"><input id="two">`;
    const one = document.getElementById("one") as HTMLInputElement;
    const two = document.getElementById("two") as HTMLInputElement;
    tracker = new CompositionTracker();
    tracker.observe(one);
    one.focus();
    startComposing(one);

    // The consumer's release of a field that moves or leaves reads what it holds.
    two.focus();

    expect(tracker.composingElement()).toBe(one);
    tracker.unobserve(one);
    expect(tracker.composingElement()).toBeNull();
  });

  it("names the element composing, once a composition a write ended is over", async () => {
    const input = document.createElement("input");
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(input);
    expect(tracker.composingElement()).toBeNull();
    startComposing(input);
    expect(tracker.composingElement()).toBe(input);

    input.value = "";

    expect(tracker.composingElement()).toBeNull();
    await Promise.resolve();
    expect(onAbandon).toHaveBeenCalledTimes(1);
  });

  it("reads the end of a composition in an element with no value from the engine's next plain edit", () => {
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(editor);
    editor.dispatchEvent(new CompositionEvent("compositionstart"));

    // There is no value to compare, so a write alone does not show the end.
    editor.textContent = "x";
    editor.dispatchEvent(keyEvent("x", { isComposing: false }));
    expect(tracker.isComposing()).toBe(true);

    beforeInput(editor, "insertText", false);

    expect(tracker.isComposing()).toBe(false);
    expect(onAbandon).toHaveBeenCalledTimes(1);
  });

  it("ends a held composition when another starts, before the new one's onStart runs", () => {
    const first = document.createElement("input");
    const second = document.createElement("input");
    const calls: Array<[string, boolean]> = [];
    tracker = new CompositionTracker({
      onStart: () => calls.push(["start", tracker?.isComposing() ?? false]),
      onAbandon: () => calls.push(["abandon", tracker?.isComposing() ?? false]),
    });
    tracker.observe(first);
    tracker.observe(second);
    first.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(calls).toEqual([["start", true]]);
    calls.length = 0;

    // The first conversion was dropped silently; the next one starts on another field.
    second.dispatchEvent(new CompositionEvent("compositionstart"));

    expect(calls).toEqual([
      ["abandon", true],
      ["start", true],
    ]);
    expect(beforeMorph(first, "value").defaultPrevented).toBe(false);
    expect(beforeMorph(second, "value").defaultPrevented).toBe(true);

    second.dispatchEvent(new CompositionEvent("compositionend"));
    expect(tracker.isComposing()).toBe(false);
  });

  it("keeps the confirmation window of a field under an observed ancestor when that field is unobserved", () => {
    const form = document.createElement("form");
    const field = document.createElement("input");
    form.append(field);
    tracker = new CompositionTracker();
    tracker.observe(form);
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));

    // The field itself was never observed, so releasing it releases nothing.
    tracker.unobserve(field);

    expect(
      tracker.consumesConfirmedInput({ target: field, inputType: "insertCompositionText" }),
    ).toBe(true);
  });

  it("owes no confirming input for a composition that ended without one", () => {
    const input = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(input);
    startComposing(input);
    input.value = "";

    beforeInput(input, "insertText", false);

    expect(tracker.consumesConfirmedInput(sendInput(input))).toBe(false);
  });

  it("stops counting a composition whose field left the observed ancestor", () => {
    document.body.innerHTML = `<form><div id="wrap"><input id="one"></div><input id="two"></form>`;
    const form = document.querySelector("form") as HTMLFormElement;
    const one = document.getElementById("one") as HTMLInputElement;
    const two = document.getElementById("two") as HTMLInputElement;
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(form);
    one.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));

    form.append(one);
    expect(tracker.isComposing()).toBe(true);

    one.remove();
    expect(tracker.isComposing()).toBe(false);
    expect(onAbandon).not.toHaveBeenCalled();
    expect(tracker.isComposing(keyEvent("", { isComposing: true }))).toBe(true);

    two.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(tracker.isComposing()).toBe(true);
  });

  it("ends quietly, at the next compositionstart, a composition whose field left the observed ancestor", () => {
    document.body.innerHTML = `<form><input id="one"><input id="two"></form>`;
    const form = document.querySelector("form") as HTMLFormElement;
    const one = document.getElementById("one") as HTMLInputElement;
    const two = document.getElementById("two") as HTMLInputElement;
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(form);
    one.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));

    one.remove();
    two.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));

    expect(onAbandon).not.toHaveBeenCalled();
    expect(tracker.composingElement()).toBe(two);
  });

  it.each([
    ["released", (t: CompositionTracker, field: HTMLInputElement) => t.unobserve(field)],
    ["disconnected", (t: CompositionTracker) => t.disconnect()],
  ])(
    "keeps composing a field that keeps focus while it is %s and observed again in the same turn",
    async (_name, release) => {
      document.body.innerHTML = `<input id="one">`;
      const one = document.getElementById("one") as HTMLInputElement;
      const onEnd = vi.fn();
      const onAbandon = vi.fn();
      tracker = new CompositionTracker({ onEnd, onAbandon });
      tracker.observe(one);
      one.focus();
      startComposing(one);

      // A move with moveBefore keeps focus and the conversion; Stimulus lets the
      // target go and observes it again within the one mutation batch.
      release(tracker, one);
      expect(tracker.composingElement()).toBe(one);
      expect(beforeMorph(one, "value").defaultPrevented).toBe(false);
      tracker.observe(one);
      await Promise.resolve();

      expect(tracker.composingElement()).toBe(one);
      expect(beforeMorph(one, "value").defaultPrevented).toBe(true);
      one.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(tracker.isComposing()).toBe(false);
      expect(onAbandon).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "with onAbandon for a consumer that let only that field go",
      (t: CompositionTracker, field: HTMLInputElement) => t.unobserve(field),
      true,
    ],
    ["quietly for a consumer that disconnected", (t: CompositionTracker) => t.disconnect(), false],
  ])(
    "ends, when the turn ends, a composition whose field keeps focus but is not observed again, %s",
    async (_name, release, told) => {
      document.body.innerHTML = `<input id="one">`;
      const one = document.getElementById("one") as HTMLInputElement;
      const onAbandon = vi.fn();
      tracker = new CompositionTracker({ onAbandon });
      tracker.observe(one);
      one.focus();
      startComposing(one);

      release(tracker, one);
      expect(tracker.isComposing()).toBe(true);
      await Promise.resolve();

      expect(tracker.isComposing()).toBe(false);
      expect(onAbandon.mock.calls).toEqual(told ? [[one, true]] : []);
      tracker.observe(one);
      expect(tracker.isComposing()).toBe(false);
    },
  );

  it("ends a composition at the engine's plain edit ahead of a page's own beforeinput handler", () => {
    const input = document.createElement("input");
    const seen: string[] = [];
    input.addEventListener("beforeinput", () =>
      seen.push(`page, composing: ${tracker?.isComposing()}`),
    );
    tracker = new CompositionTracker({ onAbandon: () => seen.push("abandon") });
    tracker.observe(input);
    startComposing(input);

    beforeInput(input, "insertText", false);

    expect(seen).toEqual(["abandon", "page, composing: false"]);
  });

  it("reads focus inside a shadow root from that root", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<form><input id="one"></form>`;
    const form = shadow.querySelector("form") as HTMLFormElement;
    const one = shadow.getElementById("one") as HTMLInputElement;
    tracker = new CompositionTracker();
    tracker.observe(form);
    one.focus();
    one.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, composed: true }));

    // The window lost focus: the field is still its shadow root's active element.
    one.dispatchEvent(new FocusEvent("blur"));
    expect(tracker.composingElement()).toBe(one);

    // A move that keeps focus keeps the conversion across a release.
    tracker.unobserve(form);
    expect(tracker.composingElement()).toBe(one);
    tracker.observe(form);
    await Promise.resolve();
    expect(tracker.composingElement()).toBe(one);
  });

  it("leaves a composition that started on another field before the turn ends to that field", async () => {
    document.body.innerHTML = `<input id="one"><input id="two">`;
    const one = document.getElementById("one") as HTMLInputElement;
    const two = document.getElementById("two") as HTMLInputElement;
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(one);
    tracker.observe(two);
    one.focus();
    startComposing(one);

    tracker.unobserve(one);
    two.focus();
    startComposing(two);
    await Promise.resolve();

    expect(tracker.composingElement()).toBe(two);
    expect(onAbandon.mock.calls).toEqual([[one, true]]);
  });

  it("keeps the composition held on one field when another field is released", () => {
    const one = document.createElement("input");
    const two = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(one);
    tracker.observe(two);
    startComposing(one);

    tracker.unobserve(two);

    expect(tracker.composingElement()).toBe(one);
  });

  it.each([
    ["released", (t: CompositionTracker, field: HTMLInputElement) => t.unobserve(field)],
    ["disconnected", (t: CompositionTracker) => t.disconnect()],
  ])("ends at once the composition of a field that lost focus when it is %s", (_name, release) => {
    document.body.innerHTML = `<div id="part"><input id="one"></div>`;
    const part = document.getElementById("part") as HTMLElement;
    const one = document.getElementById("one") as HTMLInputElement;
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(one);
    one.focus();
    startComposing(one);

    // A move without moveBefore takes focus from the field.
    document.body.append(part);
    release(tracker, one);
    tracker.observe(one);

    expect(tracker.isComposing()).toBe(false);
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it("takes no end for a composition it is not tracking", () => {
    const input = document.createElement("input");
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(input);

    input.value = "x";
    beforeInput(input, "insertText", false);
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    input.dispatchEvent(new CompositionEvent("compositionend"));
    input.value = "y";
    input.dispatchEvent(keyEvent("z"));

    expect(onAbandon).not.toHaveBeenCalled();
  });

  it("stops ending compositions on a field it released, and on every field once disconnected", () => {
    document.body.innerHTML = `<input id="one"><input id="two">`;
    const first = document.getElementById("one") as HTMLInputElement;
    const second = document.getElementById("two") as HTMLInputElement;
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(first);
    tracker.observe(second);

    first.focus();
    startComposing(first);
    second.focus();
    tracker.unobserve(first);
    first.value = "";
    beforeInput(second, "insertText", false);
    expect(onAbandon).not.toHaveBeenCalled();

    startComposing(second);
    first.focus();
    tracker.disconnect();
    second.value = "";
    second.dispatchEvent(new CompositionEvent("compositionstart"));
    beforeInput(second, "insertText", false);
    expect(onAbandon).not.toHaveBeenCalled();
  });
});

/** Composition kinds remain unsafe as ordinary-edit evidence even when the event flag is false. */
describe("isCompositionInputType", () => {
  it.each([
    "insertCompositionText",
    "insertFromComposition",
    "deleteCompositionText",
    "deleteByComposition",
  ])("recognizes %s", (kind) => expect(isCompositionInputType(kind)).toBe(true));
  it.each([undefined, "", "insertText", "deleteContentBackward"])(
    "does not call %s a composition kind",
    (kind) => expect(isCompositionInputType(kind)).toBe(false),
  );
});
