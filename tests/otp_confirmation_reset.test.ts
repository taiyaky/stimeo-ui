/** An observed confirmation cannot reuse a completed conversion's cancellation basis. */
import { Application } from "@hotwired/stimulus";
import { afterEach, expect, it } from "vitest";
import { OtpController } from "../src/controllers/otp_controller";
import { composeDraft } from "./helpers/ime";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

let application: Application | undefined;
afterEach(() => {
  if (application) disconnectAndStopApplication(application);
  application = undefined;
  document.body.innerHTML = "";
});

const end = (field: HTMLInputElement, value: string) => {
  field.value = value;
  const event = new Event("compositionend", { bubbles: true });
  Object.defineProperty(event, "data", { value });
  field.dispatchEvent(event);
};

it("receives a confirmation whose start happened while the field was not a target", async () => {
  document.body.innerHTML = `<form><div id="otp" data-controller="stimeo--otp" role="group" aria-label="Passcode">${["1", "2", "3", "9"].map((value, index) => `<input id="d${index}" value="${value}" data-stimeo--otp-target="field" data-action="input->stimeo--otp#onInput" aria-label="Digit ${index + 1}">`).join("")}<input type="hidden" name="otp" data-stimeo--otp-target="value"></div></form>`;
  application = Application.start();
  application.register("stimeo--otp", OtpController);
  await tick();
  const root = document.getElementById("otp") as HTMLElement;
  const field = document.getElementById("d3") as HTMLInputElement;
  const hidden = root.querySelector<HTMLInputElement>('input[type="hidden"]') as HTMLInputElement;
  const form = document.querySelector("form") as HTMLFormElement;
  const events: Array<[string, string]> = [];
  const signals: string[] = [];
  for (const type of ["compositionstart", "input", "compositionend"]) {
    field.addEventListener(type, () => signals.push(type));
  }
  for (const name of ["change", "complete", "invalid", "reconcile"]) {
    root.addEventListener(`stimeo--otp:${name}`, (event) => {
      events.push([name, (event as CustomEvent<{ value?: string }>).detail.value ?? "invalid"]);
    });
  }
  field.focus();
  field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
  composeDraft(field, "4");
  end(field, "4");
  expect(hidden.value).toBe("1234");
  expect(events).toEqual([
    ["change", "1234"],
    ["complete", "1234"],
  ]);

  field.removeAttribute("data-stimeo--otp-target");
  await tick();
  field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
  field.setAttribute("data-stimeo--otp-target", "field");
  await tick();
  expect(hidden.value).toBe("1234");
  events.length = 0;
  composeDraft(field, "9");
  end(field, "9");
  expect(signals).toEqual([
    "compositionstart",
    "input",
    "compositionend",
    "compositionstart",
    "input",
    "compositionend",
  ]);
  expect(field.value).toBe("9");
  expect(hidden.value).toBe("1239");
  expect(new FormData(form).get("otp")).toBe("1239");
  expect(events).toEqual([
    ["change", "1239"],
    ["complete", "1239"],
  ]);
});
