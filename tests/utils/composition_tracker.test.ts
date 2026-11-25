import { afterEach, describe, expect, it, vi } from "vitest";
import { CompositionTracker, isCompositionInputType } from "../../src/utils/composition_tracker";
import { composeDraft } from "../helpers/ime";
import { keyEvent, typeKey } from "../helpers/keyboard";
import { flushMicrotasks } from "../helpers/timing";

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

  /** Dispatches an input with the given trust and kind reported to the tracker. */
  const sendInput = (target: EventTarget, inputType?: string, isTrusted = true): InputEvent => {
    const event = new InputEvent("input", { bubbles: true, inputType });
    Object.defineProperty(event, "isTrusted", { value: isTrusted });
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
      expect(tracker.consumesConfirmedInput(sendInput(input, inputType, false))).toBe(true);
    }
  });

  it("keeps the window across blur and input the consumer has not asked about", () => {
    const first = document.createElement("input");
    const second = document.createElement("input");
    document.body.append(first, second);
    tracker = new CompositionTracker();
    tracker.observe(first);

    first.focus();
    expect(document.activeElement).toBe(first);
    first.dispatchEvent(new CompositionEvent("compositionend"));
    second.focus();
    expect(document.activeElement).toBe(second);
    sendInput(first, "insertText");
    expect(tracker.consumesConfirmedInput(sendInput(first))).toBe(true);
  });

  it.each([
    ["a plain event", () => new Event("input", { bubbles: true })],
    ["an input event with an empty kind", () => new InputEvent("input", { bubbles: true })],
  ] as const)("passes %s from a script through and closes the window", (_name, createEvent) => {
    const input = document.createElement("input");
    tracker = new CompositionTracker();
    tracker.observe(input);

    input.dispatchEvent(new CompositionEvent("compositionend"));
    const event = createEvent();
    input.dispatchEvent(event);
    expect(tracker.consumesConfirmedInput(event)).toBe(false);
    expect(tracker.consumesConfirmedInput(sendInput(input))).toBe(false);
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

  /**
   * Dispatches the cancelable notice Turbo sends before morphing an element and its
   * children. Turbo sends the same notice without a new element before removing one.
   */
  const beforeMorphElement = (target: EventTarget, removal = false): CustomEvent => {
    const event = new CustomEvent("turbo:before-morph-element", {
      bubbles: true,
      cancelable: true,
      detail: {
        currentElement: target,
        newElement: removal ? undefined : document.createElement("div"),
      },
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

  /** Writes an editable DOM draft and reports the composition that wrote it. */
  const composeEditableDraft = (editor: HTMLElement, html = "<strong>か</strong>"): void => {
    editor.innerHTML = html;
    editor.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertCompositionText",
        isComposing: true,
      }),
    );
  };

  it("keeps a native field's composition when its child nodes change without changing its live value", () => {
    const textarea = document.createElement("textarea");
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(textarea);
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    composeDraft(textarea, "か");

    textarea.textContent = "server default";

    expect(textarea.value).toBe("か");
    expect(tracker.composingElement()).toBe(textarea);
    expect(beforeMorph(textarea, "value").defaultPrevented).toBe(true);
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it("detects a page write into the same editable text node", async () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    editor.textContent = "か";
    const text = editor.firstChild as Text;
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(editor);
    editor.dispatchEvent(new CompositionEvent("compositionstart"));

    text.data = "server";

    expect(editor.firstChild).toBe(text);
    expect(tracker.isComposing()).toBe(false);
    await Promise.resolve();
    expect(onAbandon).toHaveBeenCalledExactlyOnceWith(editor, false);
  });

  it("does not interpret a non-element node's text as an editable field value", () => {
    const target = document.createTextNode("not an editing surface");
    tracker = new CompositionTracker();
    tracker.observe(target);
    target.dispatchEvent(new CompositionEvent("compositionstart"));

    target.data = "other text";

    expect(tracker.composingElement()).toBe(target);
  });

  it("tracks a target without an element or live value", () => {
    const target = new EventTarget();
    tracker = new CompositionTracker();
    tracker.observe(target);
    target.dispatchEvent(new CompositionEvent("compositionstart"));
    target.dispatchEvent(new InputEvent("input", { isComposing: true }));

    expect(tracker.composingElement()).toBe(target);

    target.dispatchEvent(new CompositionEvent("compositionend"));
    expect(tracker.isComposing()).toBe(false);
  });

  it.each(["<em>か</em>", "server", ""])(
    "ends a contenteditable composition after a page writes %j, preserving the DOM it wrote",
    async (html) => {
      const editor = document.createElement("div");
      editor.contentEditable = "true";
      const onAbandon = vi.fn();
      const onEnd = vi.fn();
      tracker = new CompositionTracker({ onAbandon, onEnd });
      tracker.observe(editor);
      editor.dispatchEvent(new CompositionEvent("compositionstart"));
      composeEditableDraft(editor);

      editor.innerHTML = html;

      expect(tracker.composingElement()).toBeNull();
      expect(editor.innerHTML).toBe(html);
      expect(onAbandon).not.toHaveBeenCalled();
      await flushMicrotasks();
      expect(onAbandon.mock.calls).toEqual([[editor, false]]);
      expect(onEnd).not.toHaveBeenCalled();
      expect(tracker.consumesConfirmedInput(sendInput(editor, "insertText"))).toBe(false);
    },
  );

  it.each(["keydown", "input"])(
    "settles a contenteditable DOM overwrite ahead of an earlier %s handler",
    (type) => {
      const editor = document.createElement("div");
      editor.contentEditable = "true";
      const seen: string[] = [];
      editor.addEventListener(type, () => seen.push(`page, composing: ${tracker?.isComposing()}`));
      tracker = new CompositionTracker({ onAbandon: () => seen.push("abandon") });
      tracker.observe(editor);
      editor.dispatchEvent(new CompositionEvent("compositionstart"));
      composeEditableDraft(editor);
      seen.length = 0;

      editor.innerHTML = "<em>か</em>";
      editor.dispatchEvent(type === "keydown" ? keyEvent("x") : new Event("input"));

      expect(seen).toEqual(["abandon", "page, composing: false"]);
    },
  );

  it.each([
    [
      "the same HTML",
      (editor: HTMLElement) => {
        const html = editor.innerHTML;
        editor.innerHTML = html;
      },
    ],
    [
      "a nested text node",
      (editor: HTMLElement) => {
        editor.querySelector("em")?.replaceChildren(document.createTextNode("か"));
      },
    ],
    [
      "the order of identical siblings",
      (editor: HTMLElement) => editor.prepend(editor.lastElementChild as HTMLElement),
    ],
    ["an empty trailing node", (editor: HTMLElement) => editor.lastChild?.remove()],
  ])(
    "ends a contenteditable composition with no caret in its text when a page replaces %s",
    async (_name, replace) => {
      const editor = document.createElement("div");
      editor.contentEditable = "true";
      const onAbandon = vi.fn();
      tracker = new CompositionTracker({ onAbandon });
      tracker.observe(editor);
      editor.dispatchEvent(new CompositionEvent("compositionstart"));
      composeEditableDraft(editor, "<span><em>か</em></span><span><em>か</em></span>");
      editor.append(document.createTextNode(""));
      editor.dispatchEvent(new InputEvent("input", { isComposing: true }));
      const html = editor.innerHTML;
      expect(tracker.isComposing()).toBe(true);

      replace(editor);

      expect(editor.innerHTML).toBe(html);
      expect(beforeMorphElement(editor).defaultPrevented).toBe(false);
      expect(tracker.isComposing()).toBe(false);
      expect(onAbandon).not.toHaveBeenCalled();
      await flushMicrotasks();
      expect(onAbandon.mock.calls).toEqual([[editor, false]]);
    },
  );

  /** Composes into the first of two identical spans, with the caret in its text as an engine leaves it. */
  const composeAtCaret = (editor: HTMLElement): Text => {
    editor.contentEditable = "true";
    editor.innerHTML = "<span><em>か</em></span><span><em>か</em></span>";
    editor.append(document.createTextNode(""));
    document.body.append(editor);
    const text = editor.querySelector("em")?.firstChild as Text;
    const caret = document.createRange();
    caret.setStart(text, text.data.length);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(caret);
    editor.dispatchEvent(new CompositionEvent("compositionstart"));
    text.appendData("に");
    caret.setStart(text, text.data.length);
    composedInput(editor, "に");
    return text;
  };

  /** The `input` an engine sends after a composition update, carrying the text it composed. */
  const composedInput = (editor: HTMLElement, data: string): void => {
    editor.dispatchEvent(
      new InputEvent("input", { inputType: "insertCompositionText", data, isComposing: true }),
    );
  };

  /** A composition `beforeinput` that reports the range it replaces, as Chromium does. */
  const replacing = (editor: HTMLElement, node: Text, offset: number): void => {
    const event = new InputEvent("beforeinput", {
      inputType: "insertCompositionText",
      isComposing: true,
    });
    const target = {
      startContainer: node,
      startOffset: offset,
      endContainer: node,
      endOffset: offset,
    };
    Object.defineProperty(event, "getTargetRanges", { value: () => [target] });
    editor.dispatchEvent(event);
  };

  /** The ranges `document.createRange()` hands out while `run` runs. */
  const rangesDuring = (run: () => void): Range[] => {
    const ranges: Range[] = [];
    const createRange = document.createRange.bind(document);
    const spy = vi.spyOn(document, "createRange").mockImplementation(() => {
      const range = createRange();
      ranges.push(range);
      return range;
    });
    try {
      run();
    } finally {
      spy.mockRestore();
    }
    return ranges;
  };

  /** Starts a composition in a new editor holding `data`, with the caret at `offset`. */
  const startAtCaret = (data: string, offset: number): [HTMLElement, Text, Range] => {
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.textContent = data;
    document.body.append(editor);
    const text = editor.firstChild as Text;
    const caret = document.createRange();
    caret.setStart(text, offset);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(caret);
    tracker = new CompositionTracker();
    tracker.observe(editor);
    editor.dispatchEvent(new CompositionEvent("compositionstart"));
    return [editor, text, caret];
  };

  /** The node and offsets a range spans. */
  const span = (range: Range | undefined): unknown[] => [
    range?.startContainer,
    range?.startOffset,
    range?.endContainer,
    range?.endOffset,
  ];

  it("keeps a contenteditable composition through an edit after its text in the same node", () => {
    const editor = document.createElement("div");
    tracker = new CompositionTracker();
    tracker.observe(editor);
    const text = composeAtCaret(editor);

    text.appendData("x");

    expect(tracker.composingElement()).toBe(editor);
  });

  it("lays the range over the text a composition input put where its beforeinput's range starts", () => {
    const [editor, text, caret] = startAtCaret("か", 0);
    replacing(editor, text, 0);
    text.insertData(0, "か");
    caret.setStart(text, 1);

    const ranges = rangesDuring(() => composedInput(editor, "か"));

    expect(span(ranges.at(-1))).toEqual([text, 0, text, 1]);
    expect(tracker?.composingElement()).toBe(editor);
  });

  it("lays the range over the composed text that reaches the caret when no range was reported", () => {
    const [editor, text, caret] = startAtCaret("か", 1);
    text.appendData("に");
    caret.setStart(text, 2);

    const ranges = rangesDuring(() => composedInput(editor, "に"));

    expect(span(ranges.at(-1))).toEqual([text, 1, text, 2]);
  });

  it("uses the caret for an input without its own beforeinput after a reported replacement", () => {
    const [editor, text, caret] = startAtCaret("a", 1);
    replacing(editor, text, 1);
    text.appendData("か");
    caret.setStart(text, 2);
    const first = rangesDuring(() => composedInput(editor, "か"));
    expect(span(first.at(-1))).toEqual([text, 1, text, 2]);

    text.appendData("か");
    caret.setStart(text, 3);
    const next = rangesDuring(() => composedInput(editor, "か"));

    expect(span(next.at(-1))).toEqual([text, 2, text, 3]);
    expect(tracker?.composingElement()).toBe(editor);
  });

  it.each([
    ["one at the end, from the range its beforeinput reported", true, "か\u00a0", "か "],
    ["one at the end, from the caret", false, "か\u00a0", "か "],
    ["two in a row", false, "か\u00a0\u00a0", "か  "],
    ["one the input reports too", false, "か\u00a0", "か\u00a0"],
  ])(
    "finds composed text an engine stored with no-break spaces: %s",
    (_name, reported, stored, data) => {
      const [editor, text, caret] = startAtCaret("x", 1);
      if (reported) replacing(editor, text, 1);
      text.appendData(stored);
      caret.setStart(text, 1 + stored.length);

      const ranges = rangesDuring(() => composedInput(editor, data));

      expect(span(ranges.at(-1))).toEqual([text, 1, text, 1 + stored.length]);
    },
  );

  it("looks around the caret when the start its beforeinput reported does not hold the composed text", () => {
    const [editor, text, caret] = startAtCaret("x", 1);
    replacing(editor, text, 0);
    text.appendData("か");
    caret.setStart(text, 2);

    const ranges = rangesDuring(() => composedInput(editor, "か"));

    expect(span(ranges.at(-1))).toEqual([text, 1, text, 2]);
  });

  it("looks around the caret when its beforeinput reported a range in another node", () => {
    const [editor, text] = startAtCaret("かか", 2);
    replacing(editor, document.createTextNode("か"), 0);

    const ranges = rangesDuring(() => composedInput(editor, "か"));

    expect(span(ranges.at(-1))).toEqual([text, 1, text, 2]);
  });

  it("takes the start its beforeinput reported over a later copy of the composed text", () => {
    const [editor, text, caret] = startAtCaret("xか\u00a0", 1);
    replacing(editor, text, 1);
    text.insertData(1, "か\u00a0");
    caret.setStart(text, 3);

    const ranges = rangesDuring(() => composedInput(editor, "か "));

    expect(span(ranges.at(-1))).toEqual([text, 1, text, 3]);
  });

  it.each([
    ["composed text that does not reach the caret", "かx", 2, "か"],
    ["no composed text", "か", 1, ""],
  ])("lays the range over the whole caret text node for %s", (_name, data, offset, composed) => {
    const [editor, text] = startAtCaret(data, offset);

    const ranges = rangesDuring(() => composedInput(editor, composed));

    expect(span(ranges.at(-1))).toEqual([text, 0, text, data.length]);
    beforeInput(editor, "insertCompositionText", true);
    expect(tracker?.composingElement()).toBe(editor);
  });

  it("keeps the range over the conversion's text through the user's own edit", () => {
    const editor = document.createElement("div");
    tracker = new CompositionTracker();
    tracker.observe(editor);
    composeAtCaret(editor);
    const edit = new InputEvent("input", { inputType: "insertText", data: "x", bubbles: true });
    Object.defineProperty(edit, "isTrusted", { value: true });

    expect(rangesDuring(() => editor.dispatchEvent(edit))).toEqual([]);
    expect(tracker.composingElement()).toBe(editor);
  });

  it.each([
    [
      "the same HTML",
      (editor: HTMLElement) => {
        const html = editor.innerHTML;
        editor.innerHTML = html;
      },
    ],
    [
      "the text node it runs in",
      (editor: HTMLElement) =>
        editor.querySelector("em")?.replaceChildren(document.createTextNode("かに")),
    ],
    ["the span it runs in", (editor: HTMLElement) => editor.firstElementChild?.remove()],
  ])(
    "ends a contenteditable composition when a page replaces or removes %s",
    async (_name, write) => {
      const editor = document.createElement("div");
      const onAbandon = vi.fn();
      tracker = new CompositionTracker({ onAbandon });
      tracker.observe(editor);
      composeAtCaret(editor);

      write(editor);

      expect(tracker.isComposing()).toBe(false);
      expect(beforeMorphElement(editor).defaultPrevented).toBe(false);
      await flushMicrotasks();
      expect(onAbandon.mock.calls).toEqual([[editor, false]]);
    },
  );

  it("ends a contenteditable composition once the live range over its text collapses", async () => {
    const editor = document.createElement("div");
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(editor);
    const ranges = rangesDuring(() => composeAtCaret(editor));
    expect(tracker.isComposing()).toBe(true);

    /** Simulates both range boundaries falling at the start of the replaced text. */
    ranges.at(-1)?.collapse(true);

    expect(tracker.isComposing()).toBe(false);
    await flushMicrotasks();
    expect(onAbandon.mock.calls).toEqual([[editor, false]]);
  });

  it("follows the conversion into the text node its next input leaves the caret in", () => {
    const editor = document.createElement("div");
    tracker = new CompositionTracker();
    tracker.observe(editor);
    const text = composeAtCaret(editor);
    const next = document.createTextNode("かにほ");
    text.replaceWith(next);
    const caret = document.getSelection()?.getRangeAt(0) as Range;
    caret.setStart(next, next.data.length);
    caret.collapse(true);
    composedInput(editor, "にほ");

    editor.querySelector("span:last-of-type em")?.replaceChildren(document.createTextNode("x"));
    expect(tracker.composingElement()).toBe(editor);
    next.remove();
    expect(tracker.composingElement()).toBeNull();
  });

  it.each([
    [
      "an empty text node of the element",
      (editor: HTMLElement) => editor.appendChild(document.createTextNode("")),
    ],
    [
      "a text node of another element",
      (editor: HTMLElement) => {
        const other = document.createElement("p");
        other.textContent = "elsewhere";
        editor.after(other);
        return other.firstChild as Text;
      },
    ],
  ])("keeps a composition that starts with the caret in %s, until its input", (_name, place) => {
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.textContent = "か";
    document.body.append(editor);
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(editor);
    const caret = document.createRange();
    caret.setStart(place(editor), 0);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(caret);

    editor.dispatchEvent(new CompositionEvent("compositionstart"));
    beforeInput(editor, "insertCompositionText", true);

    expect(tracker.composingElement()).toBe(editor);
  });

  it("reads a composition that has had no input yet by the caret's text node", () => {
    const [editor, text] = startAtCaret("か", 1);

    editor.append(document.createElement("p"));

    expect(tracker?.composingElement()).toBe(editor);
    text.remove();
    expect(tracker?.composingElement()).toBeNull();
  });

  it("holds a focused composition as it is while its target waits to be observed again", async () => {
    const editor = document.createElement("div");
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(editor);
    composeAtCaret(editor);
    editor.focus();

    tracker.disconnect();
    editor.innerHTML = "<em>server</em>";

    expect(tracker.composingElement()).toBe(editor);
    tracker.observe(editor);
    expect(tracker.composingElement()).toBeNull();
    await flushMicrotasks();
    expect(onAbandon.mock.calls).toEqual([[editor, false]]);
  });

  it("keeps a contenteditable composition across its own DOM drafts and trusted edits", () => {
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(editor);
    editor.dispatchEvent(new CompositionEvent("compositionstart"));
    composeEditableDraft(editor);
    composeEditableDraft(editor, "<em>かな</em>");
    editor.innerHTML = "<em>かなz</em>";
    const edit = new InputEvent("input", { inputType: "insertText", bubbles: true });
    Object.defineProperty(edit, "isTrusted", { value: true });
    editor.dispatchEvent(edit);

    expect(tracker.composingElement()).toBe(editor);
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it.each(["the surface itself", "an ancestor of the surface"])(
    "leaves every morph and removal notice of a composing contenteditable surface and its descendants to the page, observing %s",
    (observed) => {
      const form = document.createElement("form");
      const editor = document.createElement("div");
      editor.contentEditable = "true";
      form.append(editor);
      const onAbandon = vi.fn();
      tracker = new CompositionTracker({ onAbandon });
      tracker.observe(observed === "the surface itself" ? editor : form);
      editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeEditableDraft(editor);
      const child = editor.firstElementChild as HTMLElement;

      const notices = [
        beforeMorphElement(editor),
        beforeMorphElement(editor, true),
        beforeMorphElement(child),
        beforeMorphElement(child, true),
        beforeMorph(editor, "value"),
      ];

      expect(notices.map((notice) => notice.defaultPrevented)).toEqual([
        false,
        false,
        false,
        false,
        false,
      ]);
      // A notice writes nothing: the conversion goes on until a write reaches its text.
      expect(tracker.composingElement()).toBe(editor);
      expect(onAbandon).not.toHaveBeenCalled();
    },
  );

  it("still keeps a morph from writing the value of a field composing beside a contenteditable surface", () => {
    const form = document.createElement("form");
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    const otherEditor = document.createElement("div");
    otherEditor.contentEditable = "true";
    const input = document.createElement("input");
    form.append(editor, otherEditor, input);
    tracker = new CompositionTracker();
    tracker.observe(form);
    editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeEditableDraft(editor);
    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));

    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));

    expect(beforeMorph(input, "value").defaultPrevented).toBe(true);
    expect(beforeMorph(input, "aria-invalid").defaultPrevented).toBe(false);
    expect(beforeMorph(otherEditor, "value").defaultPrevented).toBe(false);
    expect(beforeMorphElement(input).defaultPrevented).toBe(false);
    expect(beforeMorphElement(otherEditor).defaultPrevented).toBe(false);
    expect(beforeMorphElement(form).defaultPrevented).toBe(false);
  });

  /**
   * Runs a Turbo morph of `element` the way Idiomorph does: it asks first, and writes only when
   * the notice was not cancelled.
   */
  const morphLetThrough = (element: HTMLElement, write: () => void): boolean => {
    if (beforeMorphElement(element).defaultPrevented) return false;
    write();
    return true;
  };

  it.each([
    [
      "the surface writes the conversion's text node in place",
      (editor: HTMLElement) => editor,
      (text: Text, range: Range | undefined) => {
        text.data = "server";
        // A browser collapses the live range over text a write replaces; happy-dom does not.
        range?.collapse(true);
      },
    ],
    [
      "the element holding the conversion's text replaces its text node",
      (editor: HTMLElement) => editor.querySelector("em") as HTMLElement,
      (text: Text) => text.replaceWith(document.createTextNode("server")),
    ],
  ])("reads the end of a conversion when a morph of %s", async (_name, morphed, write) => {
    const editor = document.createElement("div");
    const onAbandon = vi.fn();
    const onEnd = vi.fn();
    tracker = new CompositionTracker({ onAbandon, onEnd });
    tracker.observe(editor);
    const ranges = rangesDuring(() => composeAtCaret(editor));
    const text = editor.querySelector("em")?.firstChild as Text;
    expect(tracker.composingElement()).toBe(editor);

    const applied = morphLetThrough(morphed(editor), () => write(text, ranges.at(-1)));

    expect(applied).toBe(true);
    expect(tracker.composingElement()).toBeNull();
    await flushMicrotasks();
    expect(onAbandon.mock.calls).toEqual([[editor, false]]);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("keeps the conversion through a morph it let through that writes beside the conversion's text", () => {
    const editor = document.createElement("div");
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(editor);
    composeAtCaret(editor);
    const other = editor.querySelector("span:last-of-type em") as HTMLElement;

    const applied = morphLetThrough(editor, () => {
      other.replaceChildren(document.createTextNode("server"));
      editor.append(document.createElement("p"));
    });

    expect(applied).toBe(true);
    expect(tracker.composingElement()).toBe(editor);
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it("lets a contenteditable morph continue after a DOM overwrite and defers its abandon hook", async () => {
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(editor);
    editor.dispatchEvent(new CompositionEvent("compositionstart"));
    composeEditableDraft(editor);
    editor.innerHTML = "<em>か</em>";

    expect(beforeMorphElement(editor).defaultPrevented).toBe(false);
    expect(tracker.isComposing()).toBe(false);
    expect(onAbandon).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(onAbandon.mock.calls).toEqual([[editor, false]]);
  });

  it.each([
    ["released", (t: CompositionTracker, editor: HTMLElement) => t.unobserve(editor)],
    ["disconnected", (t: CompositionTracker) => t.disconnect()],
  ])(
    "keeps a focused contenteditable composition through being %s and observed again in the same turn, leaving its morphs to the page",
    async (_name, release) => {
      const editor = document.createElement("div");
      editor.contentEditable = "true";
      document.body.append(editor);
      const onEnd = vi.fn();
      const onAbandon = vi.fn();
      tracker = new CompositionTracker({ onEnd, onAbandon });
      tracker.observe(editor);
      editor.focus();
      editor.dispatchEvent(new CompositionEvent("compositionstart"));
      composeEditableDraft(editor);
      expect(beforeMorphElement(editor).defaultPrevented).toBe(false);

      release(tracker, editor);

      expect(tracker.composingElement()).toBe(editor);
      expect(beforeMorphElement(editor).defaultPrevented).toBe(false);
      tracker.observe(editor);
      await flushMicrotasks();
      expect(tracker.composingElement()).toBe(editor);
      expect(beforeMorphElement(editor).defaultPrevented).toBe(false);
      editor.dispatchEvent(new CompositionEvent("compositionend"));
      expect(onEnd).toHaveBeenCalledTimes(1);
      expect(onAbandon).not.toHaveBeenCalled();
    },
  );

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

    // Dispatch blur while the field remains the document's active element.
    one.dispatchEvent(new FocusEvent("blur"));
    two.dispatchEvent(new FocusEvent("blur"));
    expect(tracker.isComposing()).toBe(true);

    // Move focus to the other field without sending compositionend or overwriting
    // the composing text.
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

  it("reads the end of a contenteditable composition at a query after same-text node replacement", async () => {
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    const onAbandon = vi.fn();
    tracker = new CompositionTracker({ onAbandon });
    tracker.observe(editor);
    editor.textContent = "x";
    editor.dispatchEvent(new CompositionEvent("compositionstart"));

    editor.replaceChildren(document.createTextNode("x"));

    expect(tracker.isComposing()).toBe(false);
    expect(onAbandon).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(onAbandon.mock.calls).toEqual([[editor, false]]);
    beforeInput(editor, "insertText", false);
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

    // Starting a conversion on the second field abandons the first and calls onAbandon
    // before onStart.
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

    expect(tracker.consumesConfirmedInput(sendInput(field, "insertCompositionText", false))).toBe(
      true,
    );
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
