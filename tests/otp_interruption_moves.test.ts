/**
 * A formal end owed by an interrupted conversion survives a move that keeps its field
 * focused within one turn, and goes when the field is released or returns without
 * focus, or stays out past the turn.
 */
import { Application } from "@hotwired/stimulus";
import { afterEach, expect, it } from "vitest";
import { OtpController } from "../src/controllers/otp_controller";
import { composeDraft } from "./helpers/ime";
import { disconnectAndStopApplication, reconnectKeepingFocus } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

let application: Application | undefined;
afterEach(() => {
  if (application) disconnectAndStopApplication(application);
  application = undefined;
  document.body.innerHTML = "";
});

/** Mounts `1239` and interrupts a conversion of `4` in the last field without its end. */
const mountInterrupted = async () => {
  document.body.innerHTML = `<div id="otp" data-controller="stimeo--otp" role="group" aria-label="Passcode">${[
    "1",
    "2",
    "3",
    "9",
  ]
    .map(
      (value, index) =>
        `<input id="digit-${index}" value="${value}" data-stimeo--otp-target="field" aria-label="Digit ${index + 1}" data-action="input->stimeo--otp#onInput">`,
    )
    .join("")}<input type="hidden" data-stimeo--otp-target="value"></div>`;
  application = Application.start();
  application.register("stimeo--otp", OtpController);
  await tick();
  const root = document.getElementById("otp") as HTMLElement;
  const last = document.getElementById("digit-3") as HTMLInputElement;
  const events: string[] = [];
  for (const name of ["change", "complete", "invalid", "reconcile"])
    root.addEventListener(`stimeo--otp:${name}`, (event) =>
      events.push(`${name}:${(event as CustomEvent<{ value: string }>).detail.value}`),
    );
  last.focus();
  last.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  composeDraft(last, "4");
  last.dispatchEvent(
    new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", isComposing: false }),
  );
  await tick();
  const controller = application.getControllerForElementAndIdentifier(
    root,
    "stimeo--otp",
  ) as OtpController;
  return { root, last, events, controller };
};

const end = (field: HTMLInputElement, text: string) => {
  field.value = text;
  field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
};

it("reports a formal end that arrives after the group moved keeping focus", async () => {
  const h = await mountInterrupted();
  expect(h.events).toEqual(["reconcile:1234"]);
  reconnectKeepingFocus(h.controller);
  await tick();
  end(h.last, "4");
  expect(h.events).toEqual(["reconcile:1234", "change:1234", "complete:1234"]);
});

it("reports a formal end that arrives after its field moved within the group keeping focus", async () => {
  const h = await mountInterrupted();
  h.controller.fieldTargetDisconnected(h.last);
  h.controller.fieldTargetConnected(h.last);
  await tick();
  end(h.last, "4");
  expect(h.events).toEqual(["reconcile:1234", "change:1234", "complete:1234"]);
});

it("discards the comparison when the field loses focus while the group is away", async () => {
  const h = await mountInterrupted();
  reconnectKeepingFocus(h.controller, () => h.last.blur());
  h.last.focus();
  end(h.last, "4");
  expect(h.events).toEqual(["reconcile:1234"]);
});

it("discards the comparison when the group moves without its field's focus", async () => {
  const h = await mountInterrupted();
  h.last.blur();
  reconnectKeepingFocus(h.controller);
  h.last.focus();
  end(h.last, "4");
  expect(h.events).toEqual(["reconcile:1234"]);
});

it("discards the comparison when its field moves within the group without focus", async () => {
  const h = await mountInterrupted();
  h.last.blur();
  h.controller.fieldTargetDisconnected(h.last);
  h.controller.fieldTargetConnected(h.last);
  h.last.focus();
  end(h.last, "4");
  expect(h.events).toEqual(["reconcile:1234"]);
});

it("discards the comparison of a field that stays out of the group past the turn", async () => {
  const h = await mountInterrupted();
  h.controller.fieldTargetDisconnected(h.last);
  await tick();
  h.controller.fieldTargetConnected(h.last);
  end(h.last, "4");
  expect(h.events).toEqual(["reconcile:1234"]);
});

it("discards the comparison of a field that left before the group disconnected", async () => {
  const h = await mountInterrupted();
  const parent = h.last.parentElement as HTMLElement;
  const next = h.last.nextSibling;
  h.last.remove();
  h.controller.disconnect();
  parent.insertBefore(h.last, next);
  h.last.focus();
  h.controller.connect();
  end(h.last, "4");
  expect(h.events).toEqual(["reconcile:1234"]);
});
