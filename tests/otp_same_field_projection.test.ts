/** A copied restart keeps its validated publication before any new draft input. */
import { Application } from "@hotwired/stimulus";
import { afterEach, expect, it } from "vitest";
import { OtpController } from "../src/controllers/otp_controller";
import { composeDraft } from "./helpers/ime";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

let application: Application | undefined;
afterEach(() => {
  if (application) disconnectAndStopApplication(application);
  application = undefined;
  document.body.innerHTML = "";
});

it("a copied same-field restart submits its validated slot without another draft input", async () => {
  document.body.innerHTML = `<form id="projection-form"><div id="projection-otp" data-controller="stimeo--otp" role="group" aria-label="Passcode">${["1", "2", "3", "9"].map((value, index) => `<input id="projection-digit-${index}" value="${value}" data-stimeo--otp-target="field" data-action="input->stimeo--otp#onInput" aria-label="Digit ${index + 1}">`).join("")}<input type="hidden" name="otp" data-stimeo--otp-target="value"></div></form>`;
  application = Application.start();
  application.register("stimeo--otp", OtpController);
  await tick();
  const root = document.getElementById("projection-otp") as HTMLElement;
  const field = document.getElementById("projection-digit-3") as HTMLInputElement;
  const original = application.getControllerForElementAndIdentifier(root, "stimeo--otp");
  const events: string[] = [];
  for (const name of ["change", "complete", "invalid", "reconcile"])
    root.addEventListener(`stimeo--otp:${name}`, () => events.push(name));
  field.focus();
  field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
  composeDraft(field, "う");
  field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
  expect(field.value).toBe("う");
  expect(root.querySelector<HTMLInputElement>('input[type="hidden"]')?.value).toBe("1239");
  expect(
    new FormData(document.getElementById("projection-form") as HTMLFormElement).get("otp"),
  ).toBe("1239");
  expect(document.activeElement).toBe(field);
  expect(events).toEqual([]);

  application = await restoreFromCache(application, (restored) =>
    restored.register("stimeo--otp", OtpController),
  );
  const restoredRoot = document.getElementById("projection-otp") as HTMLElement;
  expect(application.getControllerForElementAndIdentifier(restoredRoot, "stimeo--otp")).not.toBe(
    original,
  );
  const actual = {
    raw: (document.getElementById("projection-digit-3") as HTMLInputElement).value,
    hidden: restoredRoot.querySelector<HTMLInputElement>('input[type="hidden"]')?.value,
    submitted: new FormData(document.getElementById("projection-form") as HTMLFormElement).get(
      "otp",
    ),
    state: restoredRoot.getAttribute("data-state"),
  };
  expect(actual).toEqual({ raw: "う", hidden: "1239", submitted: "1239", state: "complete" });
});
