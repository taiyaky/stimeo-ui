import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { OtpController } from "../src/controllers/otp_controller";
import { composeDraft } from "./helpers/ime";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

describe("OTP interrupted confirmation lifetime", () => {
  let app: Application | undefined;
  afterEach(() => {
    if (app) disconnectAndStopApplication(app);
    app = undefined;
    document.body.innerHTML = "";
  });
  const mount = async () => {
    document.body.innerHTML = `<form><div id="otp" data-controller="stimeo--otp" role="group" aria-label="Passcode">${["1", "2", "3", "9"].map((value) => `<input value="${value}" data-stimeo--otp-target="field" data-action="input->stimeo--otp#onInput keydown->stimeo--otp#onKeydown">`).join("")}<input type="hidden" name="otp" data-stimeo--otp-target="value"></div></form>`;
    app = Application.start();
    app.register("stimeo--otp", OtpController);
    await tick();
    const root = document.getElementById("otp") as HTMLElement;
    const field = root.querySelectorAll<HTMLInputElement>(
      '[data-stimeo--otp-target="field"]',
    )[3] as HTMLInputElement;
    const events: Array<[string, string]> = [];
    for (const name of ["change", "complete", "invalid", "reconcile"])
      root.addEventListener(`stimeo--otp:${name}`, (e) =>
        events.push([name, (e as CustomEvent).detail.value ?? "invalid"]),
      );
    field.focus();
    field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(field, "4");
    field.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", isComposing: false }),
    );
    expect(events).toEqual([["reconcile", "1234"]]);
    const end = (text = "4") => {
      field.value = text;
      const e = new Event("compositionend", { bubbles: true });
      Object.defineProperty(e, "data", { value: text });
      field.dispatchEvent(e);
    };
    const input = (text: string, inputType = "insertText") => {
      field.value = text;
      field.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType, isComposing: false, data: text }),
      );
    };
    const take = () => {
      const result = [...events];
      events.length = 0;
      return result;
    };
    return { root, field, events, end, input, take };
  };
  const own = [
    ["change", "1234"],
    ["complete", "1234"],
  ];
  it("same-task formal end notifies, then composition echo contributes zero", async () => {
    const h = await mount();
    h.take();
    h.end();
    expect(h.take()).toEqual(own);
    h.input("4", "insertFromComposition");
    expect(h.take()).toEqual([]);
    h.input("5");
    expect(h.take()).toEqual([
      ["change", "1235"],
      ["complete", "1235"],
    ]);
  });
  it("ordinary input-only immediately after formal end is not mistaken for composition echo", async () => {
    const h = await mount();
    h.take();
    h.end();
    expect(h.take()).toEqual(own);
    h.input("5");
    expect(h.take()).toEqual([
      ["change", "1235"],
      ["complete", "1235"],
    ]);
  });
  it("same ordinary overwrite after formal end contributes zero, then a different input contributes one", async () => {
    const h = await mount();
    h.take();
    h.end();
    expect(h.take()).toEqual(own);
    h.input("4");
    expect(h.take()).toEqual([]);
    h.input("5");
    expect(h.take()).toEqual([
      ["change", "1235"],
      ["complete", "1235"],
    ]);
  });
  it("formal end can arrive after ordinary beforeinput's task deadline without losing its edit", async () => {
    const h = await mount();
    h.take();
    await tick();
    h.end();
    expect(h.take()).toEqual(own);
  });
  it("expired beforeinput is not borrowed by a later equal ordinary input-only", async () => {
    const h = await mount();
    h.take();
    await tick();
    h.input("4");
    expect(h.take()).toEqual([]);
    h.input("5");
    expect(h.take()).toEqual([
      ["change", "1235"],
      ["complete", "1235"],
    ]);
  });
  it("an ordinary input that already consumed the interrupted edit is not reported again by formal end", async () => {
    const h = await mount();
    h.take();
    h.input("4");
    expect(h.take()).toEqual(own);
    h.end();
    expect(h.take()).toEqual([]);
    h.input("4", "insertFromComposition");
    expect(h.take()).toEqual([]);
  });
  it("after an expired comparison a different formal end still has the normal one-edit contract", async () => {
    const h = await mount();
    h.take();
    await tick();
    h.end("5");
    expect(h.take()).toEqual([
      ["change", "1235"],
      ["complete", "1235"],
    ]);
    h.input("5", "insertFromComposition");
    expect(h.take()).toEqual([]);
  });
  it("returning to the prior digit reports only the changed publication", async () => {
    const h = await mount();
    h.take();
    await tick();
    h.end("9");
    expect(h.take()).toEqual([["reconcile", "1239"]]);
    expect(h.root.querySelector<HTMLInputElement>('input[type="hidden"]')?.value).toBe("1239");
    h.input("9", "insertFromComposition");
    expect(h.take()).toEqual([]);
  });
  it("a new conversion on the same element owns its own cancellation basis", async () => {
    const h = await mount();
    h.take();
    await tick();
    h.field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(h.field, "5");
    h.end("4");
    expect(h.take()).toEqual([]);
    h.input("4", "insertFromComposition");
    expect(h.take()).toEqual([]);
    h.input("5");
    expect(h.take()).toEqual([
      ["change", "1235"],
      ["complete", "1235"],
    ]);
  });
  it("a different page value supersedes an interrupted confirmation basis", async () => {
    const h = await mount();
    h.take();
    await tick();
    h.field.value = "8";
    h.root.dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    await tick();
    expect(h.take()).toEqual([["reconcile", "1238"]]);
    h.end("8");
    expect(h.take()).toEqual([]);
  });
  for (const departure of ["target", "controller"] as const) {
    it(`releases an interrupted confirmation basis when the ${departure} leaves`, async () => {
      const h = await mount();
      h.take();
      await tick();
      const attribute = departure === "target" ? "data-stimeo--otp-target" : "data-controller";
      const element = departure === "target" ? h.field : h.root;
      const value = departure === "target" ? "field" : "stimeo--otp";
      element.removeAttribute(attribute);
      await tick();
      element.setAttribute(attribute, value);
      await tick();
      h.take();
      h.end();
      expect(h.take()).toEqual([]);
    });
  }
  it("an old field end leaves another field's active conversion untouched", async () => {
    const h = await mount();
    h.take();
    await tick();
    const first = h.root.querySelector<HTMLInputElement>(
      '[data-stimeo--otp-target="field"]',
    ) as HTMLInputElement;
    first.focus();
    first.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(first, "２");
    first.setSelectionRange(1, 1, "backward");
    const selection = [first.selectionStart, first.selectionEnd, first.selectionDirection];
    h.end();
    expect(first.value).toBe("２");
    expect(document.activeElement).toBe(first);
    expect([first.selectionStart, first.selectionEnd, first.selectionDirection]).toEqual(selection);
    expect(h.take()).toEqual(own);
    first.value = "2";
    const end = new Event("compositionend", { bubbles: true });
    Object.defineProperty(end, "data", { value: "2" });
    first.dispatchEvent(end);
    expect(h.take()).toEqual([
      ["change", "2234"],
      ["complete", "2234"],
    ]);
  });
});
