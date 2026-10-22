/** Page writes supersede old edit comparisons, and morphs retain copied projections. */
import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { OtpController } from "../src/controllers/otp_controller";
import { composeDraft } from "./helpers/ime";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

describe("stimeo--otp page writes and retained projection boundaries", () => {
  let app: Application | undefined;
  afterEach(() => {
    if (app) disconnectAndStopApplication(app);
    app = undefined;
    document.body.innerHTML = "";
  });

  const mount = async (last = "9") => {
    document.body.innerHTML = `<form id="f"><div id="otp" data-controller="stimeo--otp" role="group" aria-label="OTP">${["1", "2", "3", last].map((value) => `<input value="${value}" data-stimeo--otp-target="field" data-action="input->stimeo--otp#onInput">`).join("")}<input name="otp" type="hidden" data-stimeo--otp-target="value"></div></form>`;
    app = Application.start();
    app.register("stimeo--otp", OtpController);
    await tick();
    const root = document.getElementById("otp") as HTMLElement;
    const fields = [
      ...root.querySelectorAll<HTMLInputElement>('[data-stimeo--otp-target="field"]'),
    ];
    const field = fields[3] as HTMLInputElement;
    const events: Array<[string, string]> = [];
    for (const name of ["change", "complete", "invalid", "reconcile"])
      root.addEventListener(`stimeo--otp:${name}`, (event) =>
        events.push([name, (event as CustomEvent).detail.value ?? "invalid"]),
      );
    const begin = (target: HTMLInputElement, text: string) => {
      target.focus();
      target.dispatchEvent(new Event("compositionstart", { bubbles: true }));
      composeDraft(target, text);
    };
    const end = (target: HTMLInputElement, text: string) => {
      target.value = text;
      const event = new Event("compositionend", { bubbles: true });
      Object.defineProperty(event, "data", { value: text });
      target.dispatchEvent(event);
    };
    const before = () =>
      field.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          inputType: "insertText",
          isComposing: false,
        }),
      );
    const hidden = () =>
      (root.querySelector<HTMLInputElement>('input[type="hidden"]') as HTMLInputElement).value;
    return { root, fields, field, events, begin, end, before, hidden };
  };

  it("same-task observed page write releases every comparison a later formal end can borrow", async () => {
    const h = await mount();
    h.begin(h.field, "4");
    h.before();
    expect(h.events).toEqual([["reconcile", "1234"]]);
    h.field.value = "8";
    h.root.dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(h.hidden()).toBe("1238");
    const pageEvents = [
      ["reconcile", "1234"],
      ["reconcile", "1238"],
    ];
    expect(h.events).toEqual(pageEvents);
    h.end(h.field, "8");
    expect(h.events).toEqual(pageEvents);
  });

  const copiedProjection = async (removeMarker: boolean) => {
    const h = await mount("");
    h.begin(h.field, "う");
    h.field.readOnly = true;
    h.begin(h.fields[0] as HTMLInputElement, "１");
    h.end(h.fields[0] as HTMLInputElement, "1");
    expect(h.hidden()).toBe("123");
    expect(h.field.hasAttribute("data-stimeo--otp-interrupted")).toBe(true);
    if (removeMarker) {
      h.field.removeAttribute("data-stimeo--otp-interrupted");
      h.root.dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
      await tick();
      expect(h.hidden()).toBe("123");
    }
    if (!app) throw new Error("Missing application");
    app = await restoreFromCache(app, (restored) =>
      restored.register("stimeo--otp", OtpController),
    );
    const root = document.getElementById("otp") as HTMLElement;
    const form = document.getElementById("f") as HTMLFormElement;
    const hidden = root.querySelector<HTMLInputElement>('input[type="hidden"]') as HTMLInputElement;
    const fields = [
      ...root.querySelectorAll<HTMLInputElement>('[data-stimeo--otp-target="field"]'),
    ];
    const restored = { hidden: hidden.value, submitted: new FormData(form).get("otp") };
    const completes: string[] = [];
    root.addEventListener("stimeo--otp:complete", (event) =>
      completes.push((event as CustomEvent<{ value: string }>).detail.value),
    );
    (fields[0] as HTMLInputElement).value = "2";
    (fields[0] as HTMLInputElement).dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: "2" }),
    );
    const actual = {
      restored,
      finalHidden: hidden.value,
      finalSubmitted: new FormData(form).get("otp"),
      state: root.getAttribute("data-state"),
      completes,
    };
    expect(actual).toEqual({
      restored: { hidden: "123", submitted: "123" },
      finalHidden: "223",
      finalSubmitted: "223",
      state: "partial",
      completes: [],
    });
  };

  it("a marker-removing morph repairs the retained projection before a copy becomes a new instance", async () => {
    await copiedProjection(true);
  });

  it("a different page value after the input deadline releases the end basis", async () => {
    const h = await mount();
    h.begin(h.field, "4");
    h.before();
    await tick();
    h.field.value = "8";
    h.root.dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    await tick();
    expect(h.hidden()).toBe("1238");
    h.events.length = 0;
    h.end(h.field, "8");
    expect(h.events).toEqual([]);
  });

  it("a direct copy retains the locked projection", async () => {
    await copiedProjection(false);
  });
});
