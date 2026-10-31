import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { InputMaskController } from "../src/controllers/input_mask_controller";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

describe("InputMask selected typed replacements", () => {
  let application: Application | undefined;
  let changes: unknown[];
  const field = () => query<HTMLInputElement>("#field");
  const start = async (
    options: {
      attrs?: string;
      pattern?: string;
      tokens?: string;
      value?: string;
      fieldset?: boolean;
    } = {},
  ) => {
    document.body.innerHTML = `<form><fieldset ${options.fieldset ? "disabled" : ""}><label for="field">Code</label><input id="field" value="${options.value ?? "123-4567"}" data-controller="stimeo--input-mask" data-stimeo--input-mask-pattern-value="${options.pattern ?? "999-9999"}" ${options.attrs ?? ""} data-action="input->stimeo--input-mask#format"><input id="sink" type="hidden" name="raw" data-stimeo--input-mask-unmask="field"></fieldset></form>`;
    if (options.tokens)
      field().setAttribute("data-stimeo--input-mask-tokens-value", options.tokens);
    changes = [];
    field().addEventListener("stimeo--input-mask:change", (event) =>
      changes.push((event as CustomEvent).detail),
    );
    application = Application.start();
    application.register("stimeo--input-mask", InputMaskController);
    await tick();
    field().focus();
    field().setSelectionRange(1, 5);
  };
  const beforeInput = (data: string | null, inputType = "insertText", composing = false) => {
    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data,
      inputType,
      isComposing: composing,
    });
    field().dispatchEvent(event);
    return event;
  };
  /** Emulates the default insertion only when happy-dom's beforeinput remains unclaimed. */
  const insert = (data: string) => {
    const event = beforeInput(data);
    if (!event.defaultPrevented) {
      const start = field().selectionStart ?? 0;
      field().setRangeText(data, start, field().selectionEnd ?? 0, "end");
      field().setSelectionRange(start + data.length, start + data.length);
      field().dispatchEvent(
        new InputEvent("input", { bubbles: true, data, inputType: "insertText" }),
      );
    }
    return event;
  };
  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it.each(["x", "🙂"])(
    "rejects an invalid typed replacement %s without deleting its selected committed text",
    async (rejected) => {
      await start();
      expect(insert(rejected).defaultPrevented).toBe(true);
      expect(field().value).toBe("123-4567");
      expect([field().selectionStart, field().selectionEnd]).toEqual([1, 5]);
      expect(query<HTMLInputElement>("#sink").value).toBe("1234567");
      expect(changes).toEqual([]);
      expect(insert("9").defaultPrevented).toBe(false);
      expect(field().value).toBe("195-67");
      expect([field().selectionStart, field().selectionEnd]).toEqual([2, 2]);
      expect(changes).toEqual([{ masked: "195-67", unmasked: "19567", complete: false }]);
    },
  );

  it("preserves a rejected selection of the terminal literal and accepts that literal", async () => {
    await start({ pattern: "99-", value: "12-" });
    field().setSelectionRange(2, 3);
    insert("x");
    expect(field().value).toBe("12-");
    expect([field().selectionStart, field().selectionEnd]).toEqual([2, 3]);
    expect(query<HTMLInputElement>("#sink").value).toBe("12");
    expect(changes).toEqual([]);
    expect(insert("-").defaultPrevented).toBe(false);
    expect(field().value).toBe("12-");
    expect([field().selectionStart, field().selectionEnd]).toEqual([3, 3]);
    expect(changes).toEqual([]);
  });

  it("keeps selected edits singular across repeated connect and a new connected lifetime", async () => {
    await start();
    const instance = application?.getControllerForElementAndIdentifier(
      field(),
      "stimeo--input-mask",
    );
    expect(instance).toBeTruthy();
    if (!instance) throw new Error("Mask controller is not connected");
    instance.connect();
    instance.connect();
    expect(insert("x").defaultPrevented).toBe(true);
    expect([field().selectionStart, field().selectionEnd]).toEqual([1, 5]);
    expect(insert("9").defaultPrevented).toBe(false);
    expect(field().value).toBe("195-67");
    expect(changes).toEqual([{ masked: "195-67", unmasked: "19567", complete: false }]);
    instance.disconnect();
    field().setSelectionRange(1, 3);
    expect(beforeInput("x").defaultPrevented).toBe(false);
    expect(field().value).toBe("195-67");
    instance.connect();
    field().setSelectionRange(1, 3);
    expect(insert("x").defaultPrevented).toBe(true);
    expect([field().selectionStart, field().selectionEnd]).toEqual([1, 3]);
    expect(insert("8").defaultPrevented).toBe(false);
    expect(field().value).toBe("186-7");
    expect(query<HTMLInputElement>("#sink").value).toBe("1867");
    expect(changes).toEqual([
      { masked: "195-67", unmasked: "19567", complete: false },
      { masked: "186-7", unmasked: "1867", complete: false },
    ]);
  });

  it("lets a typed literal and its full-width form replace selected content", async () => {
    for (const literal of ["-", "－"]) {
      if (application) disconnectAndStopApplication(application);
      await start();
      field().setSelectionRange(3, 5);
      expect(insert(literal).defaultPrevented).toBe(false);
      expect(field().value).toBe("123-567");
      expect(changes).toEqual([{ masked: "123-567", unmasked: "123567", complete: false }]);
    }
  });

  it("uses the original token before a half-width alternative when replacing a character", async () => {
    await start({ pattern: "99", tokens: '{"9":"[０-９]"}', value: "１２" });
    field().setSelectionRange(0, 1);
    expect(insert("３").defaultPrevented).toBe(false);
    expect(field().value).toBe("３２");
    expect(changes).toEqual([{ masked: "３２", unmasked: "３２", complete: true }]);
  });

  it("leaves selection deletion and paste to the ordinary input pipeline", async () => {
    await start();
    expect(beforeInput("x", "insertFromPaste").defaultPrevented).toBe(false);
    expect(beforeInput(null, "deleteContentBackward").defaultPrevented).toBe(false);
    field().setRangeText("", 1, 5, "end");
    field().dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }),
    );
    expect(field().value).toBe("156-7");
    expect(changes).toEqual([{ masked: "156-7", unmasked: "1567", complete: false }]);
  });

  it.each(["readonly", "disabled", "fieldset"])(
    "does not claim a %s field's beforeinput",
    async (kind) => {
      await start({ attrs: kind === "fieldset" ? "" : kind, fieldset: kind === "fieldset" });
      expect(beforeInput("x").defaultPrevented).toBe(false);
      expect(field().value).toBe("123-4567");
      expect(changes).toEqual([]);
    },
  );

  it("does not claim an in-progress composition", async () => {
    await start();
    field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(beforeInput("x", "insertText", true).defaultPrevented).toBe(false);
    expect(field().value).toBe("123-4567");
    expect(changes).toEqual([]);
  });

  it("keeps an upstream consumed insertion owned by its consumer", async () => {
    await start();
    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: "x",
      inputType: "insertText",
    });
    event.preventDefault();
    field().dispatchEvent(event);
    expect(field().value).toBe("123-4567");
    expect([field().selectionStart, field().selectionEnd]).toEqual([1, 5]);
    expect(changes).toEqual([]);
  });

  it("does not claim page-written text or an unsettled declaration", async () => {
    await start();
    field().value = "999-9999";
    field().setSelectionRange(1, 5);
    expect(beforeInput("x").defaultPrevented).toBe(false);
    field().value = "123-4567";
    field().setAttribute("data-stimeo--input-mask-pattern-value", "aa-99");
    expect(beforeInput("x").defaultPrevented).toBe(false);
  });

  it("releases the field's listener when its controller disconnects", async () => {
    await start();
    field().removeAttribute("data-controller");
    await tick();
    expect(beforeInput("x").defaultPrevented).toBe(false);
    expect(field().value).toBe("123-4567");
    expect(changes).toEqual([]);
  });
});
