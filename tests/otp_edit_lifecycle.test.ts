/** `stimeo--otp` edit lifetimes release their timers and keep the comparison state they need. */
import { Application } from "@hotwired/stimulus";
import { afterEach, expect, it, vi } from "vitest";
import { OtpController } from "../src/controllers/otp_controller";
import { composeDraft } from "./helpers/ime";
import { typeKey } from "./helpers/keyboard";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

let app: Application;
afterEach(() => {
  if (app) disconnectAndStopApplication(app);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});
const mount = async (first = "1", last = "9", pattern = "[0-9]") => {
  document.body.innerHTML = `<form><div id="otp" data-controller="stimeo--otp" data-stimeo--otp-pattern-value="${pattern}" data-action="wipe->stimeo--otp#clear" role="group" aria-label="OTP">${[first, "2", "3", last].map((value, index) => `<input id="d${index}" value="${value}" data-stimeo--otp-target="field" data-action="input->stimeo--otp#onInput keydown->stimeo--otp#onKeydown" aria-label="Digit ${index + 1}">`).join("")}<input type="hidden" name="otp" data-stimeo--otp-target="value"></div></form>`;
  app = Application.start();
  app.register("stimeo--otp", OtpController);
  await tick();
  const root = document.getElementById("otp") as HTMLElement;
  const field = (index: number) => document.getElementById(`d${index}`) as HTMLInputElement;
  const events: Array<[string, string]> = [];
  for (const name of ["reconcile", "change", "complete", "invalid"])
    root.addEventListener(`stimeo--otp:${name}`, (event) =>
      events.push([name, (event as CustomEvent<{ value?: string }>).detail.value ?? "invalid"]),
    );
  const hidden = () =>
    (root.querySelector<HTMLInputElement>('input[type="hidden"]') as HTMLInputElement).value;
  const controller = app.getControllerForElementAndIdentifier(root, "stimeo--otp") as OtpController;
  return { root, first: field(0), last: field(3), field, events, hidden, controller };
};
const begin = (field: HTMLInputElement, text: string) => {
  field.focus();
  field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
  composeDraft(field, text);
};
const end = (field: HTMLInputElement, text: string) => {
  field.value = text;
  const event = new Event("compositionend", { bubbles: true });
  Object.defineProperty(event, "data", { value: text });
  field.dispatchEvent(event);
};
const before = (field: HTMLInputElement, inputType = "insertText", isComposing = false) =>
  field.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType, isComposing }));
const input = (field: HTMLInputElement, value: string) => {
  field.value = value;
  field.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }),
  );
};

it("new composition releases the preceding input timer", async () => {
  const h = await mount();
  vi.useFakeTimers();
  begin(h.last, "4");
  before(h.last);
  expect(vi.getTimerCount()).toBe(1);
  begin(h.first, "1");
  expect(vi.getTimerCount()).toBe(0);
});
it("formal end releases its timer and cannot leave a basis for a later same input", async () => {
  const h = await mount();
  vi.useFakeTimers();
  begin(h.last, "う");
  before(h.last);
  end(h.last, "4");
  expect(vi.getTimerCount()).toBe(0);
  const previous = [...h.events];
  input(h.last, "4");
  expect(h.events).toEqual(previous);
});
it("disconnect clears an entry whose field left before its target callback", async () => {
  const h = await mount();
  vi.useFakeTimers();
  begin(h.last, "4");
  before(h.last);
  h.last.remove();
  h.controller.disconnect();
  expect(vi.getTimerCount()).toBe(0);
});
it("input consumes the pending timer and comparison", async () => {
  const h = await mount();
  vi.useFakeTimers();
  begin(h.last, "4");
  before(h.last);
  input(h.last, "4");
  expect(vi.getTimerCount()).toBe(0);
  const previous = [...h.events];
  input(h.last, "4");
  expect(h.events).toEqual(previous);
});
it("keydown supersedes the pending input timer", async () => {
  const h = await mount();
  vi.useFakeTimers();
  begin(h.last, "4");
  before(h.last);
  typeKey(h.last, "PageDown");
  expect(vi.getTimerCount()).toBe(0);
});
it("another composition beforeinput supersedes the pending timer", async () => {
  const h = await mount();
  vi.useFakeTimers();
  begin(h.last, "4");
  before(h.last);
  before(h.last, "insertCompositionText", true);
  expect(vi.getTimerCount()).toBe(0);
});
it("composition notices create no ordinary-edit timer", async () => {
  const h = await mount();
  vi.useFakeTimers();
  begin(h.last, "4");
  before(h.last, "insertCompositionText", true);
  expect(vi.getTimerCount()).toBe(0);
});
it("field departure releases its pending timer without disconnecting the group", async () => {
  const h = await mount();
  vi.useFakeTimers();
  begin(h.last, "4");
  before(h.last);
  h.last.remove();
  h.controller.fieldTargetDisconnected(h.last);
  expect(vi.getTimerCount()).toBe(0);
});
it("new composition plus cancellation cannot revive an older interrupted basis", async () => {
  const h = await mount();
  vi.useFakeTimers();
  begin(h.last, "4");
  before(h.last);
  begin(h.last, "5");
  end(h.last, "4");
  const previous = [...h.events];
  input(h.last, "4");
  expect(h.events).toEqual(previous);
});
it("a noninterrupted beforeinput cannot replace the basis that clear() just reset", async () => {
  const h = await mount();
  before(h.last);
  h.root.dispatchEvent(new Event("wipe"));
  const previous = [...h.events];
  input(h.last, "");
  expect(h.events).toEqual(previous);
});
it("a same-digit residual and ordinary overwrite remain silent", async () => {
  const h = await mount();
  begin(h.last, "9");
  before(h.last);
  input(h.last, "9");
  expect(h.hidden()).toBe("1239");
  expect(h.events).toEqual([]);
});
it("a rejected prior digit is not an edit baseline after a held drop", async () => {
  const h = await mount();
  begin(h.last, "");
  h.root.setAttribute("data-stimeo--otp-pattern-value", "[0-8]");
  await tick();
  before(h.last);
  input(h.last, "");
  expect(h.hidden()).toBe("123");
  expect(h.events).toEqual([["reconcile", "123"]]);
});
it("a key sees held page drops before it navigates", async () => {
  const h = await mount("a", "9", "[0-9a]");
  begin(h.last, "う");
  h.root.setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
  await tick();
  h.last.value = "4";
  typeKey(h.last, "ArrowLeft");
  expect(h.hidden()).toBe("234");
  expect(h.events).toEqual([["reconcile", "234"]]);
});
it("an old raw value written again by the page cannot resurrect a discarded projection", async () => {
  const h = await mount("1", "");
  begin(h.last, "う");
  h.last.readOnly = true;
  begin(h.first, "１");
  end(h.first, "1");
  h.last.value = "8";
  h.root.dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
  await tick();
  expect(h.hidden()).toBe("1238");
  h.last.value = "う";
  h.root.dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
  await tick();
  expect(h.hidden()).toBe("123う");
});
it("reflects the retained digit as filled before publishing it", async () => {
  const h = await mount("1", "");
  begin(h.last, "4");
  h.last.readOnly = true;
  begin(h.first, "１");
  expect(h.last.getAttribute("data-filled")).toBe("true");
  expect(h.hidden()).toBe("1234");
});
