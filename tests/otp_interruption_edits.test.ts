/** Edits that meet a conversion whose end the tracker has not seen yet keep their own contract. */
import { Application } from "@hotwired/stimulus";
import { afterEach, expect, it } from "vitest";
import { OtpController } from "../src/controllers/otp_controller";
import { composeDraft } from "./helpers/ime";
import { typeKey } from "./helpers/keyboard";
import { disconnectAndStopApplication, reconnectKeepingFocus } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

let application: Application | undefined;
afterEach(() => {
  if (application) disconnectAndStopApplication(application);
  application = undefined;
  document.body.innerHTML = "";
});

const MARKER = "data-stimeo--otp-interrupted";

const mount = async (values: string[], pattern = "[0-9]") => {
  document.body.innerHTML = `<form id="otp-form"><div id="otp" data-controller="stimeo--otp" data-stimeo--otp-pattern-value="${pattern}" role="group" aria-label="Passcode">${values
    .map(
      (value, index) =>
        `<input id="digit-${index}" value="${value}" maxlength="1" data-stimeo--otp-target="field" aria-label="Digit ${index + 1}" data-action="input->stimeo--otp#onInput keydown->stimeo--otp#onKeydown paste->stimeo--otp#onPaste">`,
    )
    .join(
      "",
    )}<p id="otp-error" data-stimeo--otp-target="error" hidden>Digits only</p><input type="hidden" name="otp" data-stimeo--otp-target="value"></div></form>`;
  application = Application.start();
  application.register("stimeo--otp", OtpController);
  await tick();
  const root = document.getElementById("otp") as HTMLElement;
  const fields = Array.from(
    root.querySelectorAll<HTMLInputElement>('[data-stimeo--otp-target="field"]'),
  );
  const field = (index: number) => fields[index] as HTMLInputElement;
  const events: string[] = [];
  for (const name of ["change", "complete", "invalid", "reconcile"])
    root.addEventListener(`stimeo--otp:${name}`, (event) => {
      const detail = (event as CustomEvent<{ value?: string; pattern?: string }>).detail;
      events.push(`${name}:${detail.value ?? detail.pattern}`);
    });
  const hidden = () =>
    (root.querySelector<HTMLInputElement>('input[type="hidden"]') as HTMLInputElement).value;
  const texts = () => fields.map((each) => each.value);
  return { root, fields, field, events, hidden, texts };
};

/** A conversion the engine no longer runs, with its text in place and no end shown yet. */
const holdConversion = (field: HTMLInputElement, draft: string) => {
  field.focus();
  field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  composeDraft(field, draft);
};
const end = (field: HTMLInputElement, text: string) => {
  field.value = text;
  field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
};
const beforeEdit = (field: HTMLInputElement, inputType = "insertText") =>
  field.dispatchEvent(
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType,
      isComposing: false,
    }),
  );
const editInput = (field: HTMLInputElement, value: string, inputType = "insertText") => {
  field.value = value;
  field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, isComposing: false }));
};
const paste = (field: HTMLInputElement, text: string) => {
  field.focus();
  const data = new DataTransfer();
  data.setData("text", text);
  field.dispatchEvent(
    new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
  );
};

it("keeps the selection an ordinary edit replaces while the residual cleanup rewrites the field", async () => {
  const h = await mount(["1", "2", "3", "9"]);
  const last = h.field(3);
  holdConversion(last, "う");
  last.setSelectionRange(0, 1);
  beforeEdit(last);
  expect(last.value).toBe("9");
  expect([last.selectionStart, last.selectionEnd]).toEqual([0, 1]);
  editInput(last, "5");
  await tick();
  expect(h.hidden()).toBe("1235");
  expect(h.events).toEqual(["change:1235", "complete:1235"]);
});

it("fills a paste from the field still holding conversion text", async () => {
  const h = await mount(["", "", "", ""]);
  holdConversion(h.field(0), "う");
  paste(h.field(0), "1234");
  await tick();
  expect(h.texts()).toEqual(["1", "2", "3", "4"]);
  expect(h.hidden()).toBe("1234");
  expect(h.events).toEqual(["change:1234", "complete:1234"]);
});

it("fills a paste through a later field still holding conversion text", async () => {
  const h = await mount(["", "2", "3", ""]);
  holdConversion(h.field(3), "う");
  paste(h.field(0), "1234");
  await tick();
  expect(h.texts()).toEqual(["1", "2", "3", "4"]);
  expect(h.hidden()).toBe("1234");
  expect(h.events).toEqual(["change:1234", "complete:1234"]);
});

it("does not report a valid one-digit paste into the field holding conversion text as invalid", async () => {
  const h = await mount(["1", "2", "3", ""]);
  holdConversion(h.field(3), "う");
  paste(h.field(3), "4");
  await tick();
  expect(h.texts()).toEqual(["1", "2", "3", "4"]);
  expect(h.hidden()).toBe("1234");
  expect(h.events).toEqual(["change:1234", "complete:1234"]);
  expect(h.field(3).getAttribute("aria-invalid")).toBeNull();
  expect(document.getElementById("otp-error")?.hidden).toBe(true);
});

it("advances focus past a paste that filled a field still holding conversion text", async () => {
  const h = await mount(["", "", "", ""]);
  holdConversion(h.field(1), "う");
  paste(h.field(0), "12");
  await tick();
  expect(h.texts()).toEqual(["1", "2", "", ""]);
  expect(document.activeElement).toBe(h.field(2));
});

it("reads a script's input on another field as an edit while a conversion's end is unseen", async () => {
  const h = await mount(["", "2", "3", "9"]);
  holdConversion(h.field(3), "う");
  h.field(0).value = "1";
  h.field(0).dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  expect(h.texts()).toEqual(["1", "2", "3", "う"]);
  expect(h.hidden()).toBe("1239");
  expect(h.events).toEqual(["change:1239", "complete:1239"]);
  expect(document.activeElement).toBe(h.field(3));
});

it("keeps the conversion's field out of a script's multi-digit input on another field", async () => {
  const h = await mount(["", "", "", ""]);
  holdConversion(h.field(1), "う");
  h.field(0).value = "123";
  h.field(0).dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  expect(h.texts()).toEqual(["1", "う", "2", "3"]);
  expect(h.hidden()).toBe("123");
  expect(h.events).toEqual(["change:123"]);
  expect(document.activeElement).toBe(h.field(1));
});

it("still holds back the conversion's own draft input", async () => {
  const h = await mount(["", "2", "3", "9"]);
  holdConversion(h.field(3), "う");
  composeDraft(h.field(3), "うえ");
  h.field(3).dispatchEvent(new InputEvent("input", { bubbles: true }));
  await tick();
  expect(h.hidden()).toBe("239");
  expect(h.events).toEqual([]);
});

it("handles a key in another field while a conversion's end is unseen", async () => {
  const h = await mount(["1", "2", "", "9"]);
  holdConversion(h.field(3), "う");
  h.field(2).focus();
  typeKey(h.field(2), "Backspace");
  await tick();
  expect(h.texts()).toEqual(["1", "", "", "う"]);
  expect(document.activeElement).toBe(h.field(1));
  expect(h.hidden()).toBe("19");
  expect(h.events).toEqual(["change:19"]);
});

it("still holds back keys in the field the conversion runs in", async () => {
  const h = await mount(["1", "2", "3", "9"]);
  holdConversion(h.field(3), "う");
  typeKey(h.field(3), "Home");
  expect(document.activeElement).toBe(h.field(3));
  expect(h.events).toEqual([]);
});

it("applies a drop a conversion held before a paste that follows a page write ending it", async () => {
  const h = await mount(["", "", "", ""], "[0-9a-f]");
  paste(h.field(0), "a12");
  await tick();
  h.events.length = 0;
  holdConversion(h.field(3), "ｂ");
  h.root.setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
  await tick();
  h.field(3).value = "";
  paste(h.field(3), "4");
  await tick();
  expect(h.texts()).toEqual(["", "1", "2", "4"]);
  expect(h.hidden()).toBe("124");
  expect(h.events).toEqual(["reconcile:12", "change:124"]);
});

it("compares a late formal end with the other fields as published, not as drafted", async () => {
  const h = await mount(["", "2", "3", "9"]);
  holdConversion(h.field(3), "う");
  holdConversion(h.field(0), "1");
  await tick();
  expect(h.hidden()).toBe("239");
  h.events.length = 0;
  end(h.field(3), "9");
  await tick();
  expect(h.field(0).value).toBe("1");
  expect(document.activeElement).toBe(h.field(0));
  expect(h.hidden()).toBe("239");
  expect(h.events).toEqual([]);
});

it("reports emptying a kept residual back to its empty slot as reconciliation only", async () => {
  const h = await mount(["", "2", "3", ""]);
  const last = h.field(3);
  holdConversion(last, "4");
  beforeEdit(last, "deleteContentBackward");
  editInput(last, "", "deleteContentBackward");
  await tick();
  expect(h.hidden()).toBe("23");
  expect(h.events).toEqual(["reconcile:234", "reconcile:23"]);
});

it("leaves a field that became readonly unwritten when a same-field restart is cancelled", async () => {
  const h = await mount(["", "2", "3", "9"]);
  const last = h.field(3);
  holdConversion(last, "う");
  last.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  await tick();
  expect(h.hidden()).toBe("239");
  h.events.length = 0;
  last.readOnly = true;
  end(last, "う");
  await tick();
  expect(last.value).toBe("う");
  expect(last.getAttribute(MARKER)).not.toBeNull();
  expect(h.hidden()).toBe("239");
  expect(h.events).toEqual([]);
});

it("advances focus after a paste that stops short of a later field still holding conversion text", async () => {
  const h = await mount(["", "", "", ""]);
  holdConversion(h.field(3), "う");
  paste(h.field(0), "12");
  await tick();
  expect(document.activeElement).toBe(h.field(2));
});

it("advances focus after a paste behind an earlier field still holding conversion text", async () => {
  const h = await mount(["", "", "", ""]);
  holdConversion(h.field(0), "う");
  paste(h.field(1), "23");
  await tick();
  expect(document.activeElement).toBe(h.field(3));
});

it("applies a held drop to the other fields before a script's input elsewhere", async () => {
  const h = await mount(["", "", "", ""], "[0-9a-f]");
  paste(h.field(0), "a1");
  paste(h.field(3), "9");
  await tick();
  h.events.length = 0;
  holdConversion(h.field(3), "ｂ");
  h.root.setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
  await tick();
  h.field(2).value = "2";
  h.field(2).dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  expect(h.texts()).toEqual(["", "1", "2", "ｂ"]);
  expect(h.hidden()).toBe("129");
  expect(h.events).toEqual(["reconcile:19", "change:129"]);
});

it("counts the conversion's committed character only while the current pattern accepts it", async () => {
  const h = await mount(["", "2", "3", "a"], "[0-9a-f]");
  holdConversion(h.field(3), "ｂ");
  h.root.setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
  await tick();
  h.field(0).value = "1";
  h.field(0).dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  expect(h.field(3).value).toBe("ｂ");
  expect(h.hidden()).toBe("123");
  expect(h.events).toEqual(["reconcile:23", "change:123"]);
  end(h.field(3), "4");
  await tick();
  expect(h.hidden()).toBe("1234");
  expect(h.events).toEqual(["reconcile:23", "change:123", "change:1234", "complete:1234"]);
});

it("applies a held drop to the other fields before a paste into the field composing", async () => {
  const h = await mount(["", "", "", ""], "[0-9a-f]");
  paste(h.field(0), "a1");
  await tick();
  h.events.length = 0;
  holdConversion(h.field(2), "ｂ");
  h.root.setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
  await tick();
  paste(h.field(2), "34");
  await tick();
  expect(h.texts()).toEqual(["", "1", "3", "4"]);
  expect(h.hidden()).toBe("134");
  expect(h.events).toEqual(["reconcile:1", "change:134"]);
});

it("applies a held drop to the other fields before a key elsewhere", async () => {
  const h = await mount(["a", "2", "3", "9"], "[0-9a]");
  holdConversion(h.field(3), "う");
  h.root.setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
  await tick();
  h.field(2).focus();
  typeKey(h.field(2), "ArrowLeft");
  expect(document.activeElement).toBe(h.field(1));
  expect(h.field(0).value).toBe("");
  expect(h.events).toEqual(["reconcile:239"]);
});

it("applies a held drop to the other fields before an old field's late end", async () => {
  const h = await mount(["1", "a", "3", "9"], "[0-9a]");
  holdConversion(h.field(3), "4");
  beforeEdit(h.field(3));
  await tick();
  expect(h.events).toEqual(["reconcile:1a34"]);
  holdConversion(h.field(0), "２");
  h.root.setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
  await tick();
  end(h.field(3), "4");
  await tick();
  expect(h.field(0).value).toBe("２");
  expect(h.hidden()).toBe("134");
  expect(h.events).toEqual(["reconcile:1a34", "reconcile:134", "change:134"]);
});

it("compares a late formal end with a value another field's edit already published", async () => {
  const h = await mount(["1", "2", "3", "9"]);
  holdConversion(h.field(3), "4");
  beforeEdit(h.field(3));
  await tick();
  h.field(0).focus();
  beforeEdit(h.field(0));
  editInput(h.field(0), "5");
  await tick();
  expect(h.events).toEqual(["reconcile:1234", "change:5234", "complete:5234"]);
  end(h.field(3), "4");
  await tick();
  expect(h.events).toEqual(["reconcile:1234", "change:5234", "complete:5234"]);
});

it("reports a late formal end that confirms another character than the published one", async () => {
  const h = await mount(["1", "2", "3", "9"]);
  holdConversion(h.field(3), "4");
  beforeEdit(h.field(3));
  await tick();
  h.field(0).focus();
  beforeEdit(h.field(0));
  editInput(h.field(0), "5");
  await tick();
  h.events.length = 0;
  end(h.field(3), "6");
  await tick();
  expect(h.events).toEqual(["change:5236", "complete:5236"]);
});

it("discards a late end's comparison once a rejected paste restores its field", async () => {
  const h = await mount(["1", "2", "3", "9"]);
  holdConversion(h.field(3), "4");
  beforeEdit(h.field(3));
  await tick();
  paste(h.field(3), "x");
  await tick();
  expect(h.field(3).value).toBe("4");
  end(h.field(3), "4");
  await tick();
  expect(h.events).toEqual(["reconcile:1234", "invalid:[0-9]"]);
});

it("does not judge a page value again on reconnecting once a drop judged the digits", async () => {
  const h = await mount(["a", "2", "3", "9"], "[0-9a]");
  h.root.setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
  await tick();
  h.field(0).value = "a";
  h.root.dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
  await tick();
  const controller = application?.getControllerForElementAndIdentifier(h.root, "stimeo--otp");
  if (controller) reconnectKeepingFocus(controller);
  await tick();
  expect(h.field(0).value).toBe("a");
  expect(h.hidden()).toBe("a239");
  expect(h.events).toEqual(["reconcile:239", "reconcile:a239"]);
});

it("leaves the digits unjudged after a drop that spared a conversion, across a focus-keeping reconnect", async () => {
  const h = await mount(["", "1", "2", "b"], "[0-9a-f]");
  holdConversion(h.field(3), "ｃ");
  h.root.setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
  await tick();
  h.field(0).value = "5";
  h.field(0).dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  const controller = application?.getControllerForElementAndIdentifier(h.root, "stimeo--otp");
  if (controller) reconnectKeepingFocus(controller);
  await tick();
  end(h.field(3), "b");
  await tick();
  expect(h.field(3).value).toBe("");
  h.field(1).value = "7";
  h.field(1).dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  expect(h.hidden()).toBe("572");
  expect(h.events.filter((event) => event.startsWith("complete:"))).toEqual([]);
});

it("keeps counting a locked conversion's committed character as any locked field keeps its own", async () => {
  const h = await mount(["1", "2", "3", "a"], "[0-9a]");
  holdConversion(h.field(3), "ｂ");
  h.field(3).readOnly = true;
  h.root.setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
  await tick();
  h.field(0).value = "5";
  h.field(0).dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  expect(h.hidden()).toBe("523a");
  end(h.field(3), "a");
  await tick();
  expect(h.field(3).value).toBe("a");
  expect(h.hidden()).toBe("523a");
  expect(h.events).toEqual(["change:523a", "complete:523a"]);
});
