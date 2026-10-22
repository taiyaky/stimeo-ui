/** Observable effects of `stimeo--otp`'s interrupted-edit ownership and publication boundaries. */
import { Application } from "@hotwired/stimulus";
import { afterEach, expect, it } from "vitest";
import { OtpController } from "../src/controllers/otp_controller";
import { composeDraft } from "./helpers/ime";
import { typeKey } from "./helpers/keyboard";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

let application: Application | undefined;
afterEach(() => {
  if (application) disconnectAndStopApplication(application);
  application = undefined;
  document.body.innerHTML = "";
});

const mount = async (values = ["1", "2", "3", "9"]) => {
  document.body.innerHTML = `<form><div id="otp" data-controller="stimeo--otp" data-action="wipe->stimeo--otp#clear" role="group" aria-label="Passcode">${values.map((value, index) => `<input id="d${index}" value="${value}" data-stimeo--otp-target="field" data-action="input->stimeo--otp#onInput keydown->stimeo--otp#onKeydown" aria-label="Digit ${index + 1}">`).join("")}<input type="hidden" name="otp" data-stimeo--otp-target="value"></div></form>`;
  application = Application.start();
  application.register("stimeo--otp", OtpController);
  await tick();
  const root = document.getElementById("otp") as HTMLElement;
  const fields = Array.from(
    root.querySelectorAll<HTMLInputElement>('[data-stimeo--otp-target="field"]'),
  );
  const last = fields[3] as HTMLInputElement;
  const first = fields[0] as HTMLInputElement;
  const events: Array<[string, string]> = [];
  for (const name of ["change", "complete", "invalid", "reconcile"]) {
    root.addEventListener(`stimeo--otp:${name}`, (event) => {
      events.push([name, (event as CustomEvent<{ value?: string }>).detail.value ?? "invalid"]);
    });
  }
  const hidden = () =>
    (root.querySelector<HTMLInputElement>('input[type="hidden"]') as HTMLInputElement).value;
  const controller = application.getControllerForElementAndIdentifier(
    root,
    "stimeo--otp",
  ) as OtpController;
  return { root, fields, first, last, events, hidden, controller };
};

const start = (field: HTMLInputElement) => {
  field.focus();
  field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
};
const begin = (field: HTMLInputElement, draft: string) => {
  start(field);
  composeDraft(field, draft);
};
const before = (field: HTMLInputElement) =>
  field.dispatchEvent(
    new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", isComposing: false }),
  );
const input = (field: HTMLInputElement, value: string) => {
  field.value = value;
  field.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }),
  );
};
const end = (field: HTMLInputElement, value: string) => {
  field.value = value;
  const event = new Event("compositionend", { bubbles: true });
  Object.defineProperty(event, "data", { value });
  field.dispatchEvent(event);
};

it("a restart owns its confirmation even when no draft input preceded its end", async () => {
  const h = await mount();
  begin(h.last, "4");
  before(h.last);
  await tick();
  h.events.length = 0;
  start(h.last);
  end(h.last, "9");
  expect(h.hidden()).toBe("1239");
  expect(h.events).toEqual([
    ["change", "1239"],
    ["complete", "1239"],
  ]);
});

it("a later ordinary notice is not the comparison for a superseded formal end", async () => {
  const h = await mount();
  begin(h.last, "4");
  before(h.last);
  input(h.last, "4");
  h.events.length = 0;
  before(h.last);
  h.root.dispatchEvent(new Event("wipe"));
  end(h.last, "");
  expect(h.hidden()).toBe("");
  expect(h.events).toEqual([["change", ""]]);
});

it("a key removes the ordinary comparison as well as its pending timeout", async () => {
  const h = await mount();
  begin(h.last, "4");
  before(h.last);
  h.events.length = 0;
  typeKey(h.last, "PageDown");
  input(h.last, "4");
  expect(h.hidden()).toBe("1234");
  expect(h.events).toEqual([]);
});

it("disconnect releases a departed field's formal comparison before it reconnects", async () => {
  const h = await mount();
  begin(h.last, "4");
  before(h.last);
  await tick();
  h.events.length = 0;
  h.last.remove();
  h.controller.disconnect();
  h.root.append(h.last);
  h.controller.connect();
  end(h.last, "4");
  expect(h.hidden()).toBe("1234");
  expect(h.events).toEqual([]);
});

it("a copied projection restores a cancelled restart after its field becomes writable", async () => {
  const h = await mount(["1", "2", "3", ""]);
  begin(h.last, "う");
  h.last.readOnly = true;
  begin(h.first, "１");
  end(h.first, "1");
  if (!application) throw new Error("Missing application");
  application = await restoreFromCache(application, (restored) =>
    restored.register("stimeo--otp", OtpController),
  );
  const last = document.getElementById("d3") as HTMLInputElement;
  const root = document.getElementById("otp") as HTMLElement;
  expect(last.value).toBe("う");
  last.readOnly = false;
  begin(last, "に");
  end(last, "う");
  expect(last.value).toBe("");
  expect(last.hasAttribute("data-stimeo--otp-interrupted")).toBe(false);
  expect(root.querySelector<HTMLInputElement>('input[type="hidden"]')?.value).toBe("123");
});

it("clearing an already empty residual consumes its outstanding formal end", async () => {
  const h = await mount();
  begin(h.last, "");
  before(h.last);
  await tick();
  h.events.length = 0;
  h.root.dispatchEvent(new Event("wipe"));
  end(h.last, "");
  expect(h.hidden()).toBe("");
  expect(h.events).toEqual([["change", ""]]);
});

it("a nested reconciliation supersedes completion pending in an outer edit", async () => {
  const h = await mount(["1", "2", "", ""]);
  const third = h.fields[2] as HTMLInputElement;
  h.root.addEventListener(
    "stimeo--otp:change",
    () => {
      h.last.remove();
      input(third, "3");
    },
    { once: true },
  );
  input(third, "3");
  expect(h.hidden()).toBe("123");
  expect(h.root.getAttribute("data-state")).toBe("complete");
  expect(h.events).toEqual([
    ["change", "123"],
    ["reconcile", "123"],
  ]);
});
