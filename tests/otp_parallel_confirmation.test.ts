/** A field's delayed confirmation preserves another field's active conversion. */
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

const mount = async () => {
  document.body.innerHTML = `<form><div id="otp" data-controller="stimeo--otp" role="group" aria-label="Passcode">${["1", "2", "3", "9"].map((value, index) => `<input id="d${index}" value="${value}" data-stimeo--otp-target="field" data-action="input->stimeo--otp#onInput" aria-label="Digit ${index + 1}">`).join("")}<input type="hidden" name="otp" data-stimeo--otp-target="value"></div></form>`;
  application = Application.start();
  application.register("stimeo--otp", OtpController);
  await tick();
  const root = document.getElementById("otp") as HTMLElement;
  const fields = Array.from(
    root.querySelectorAll<HTMLInputElement>('[data-stimeo--otp-target="field"]'),
  );
  const first = fields[0] as HTMLInputElement;
  const last = fields[3] as HTMLInputElement;
  const hidden = root.querySelector<HTMLInputElement>('input[type="hidden"]') as HTMLInputElement;
  const form = document.querySelector("form") as HTMLFormElement;
  const events: Array<[string, string]> = [];
  for (const name of ["change", "complete", "invalid", "reconcile"]) {
    root.addEventListener(`stimeo--otp:${name}`, (event) => {
      events.push([name, (event as CustomEvent<{ value?: string }>).detail.value ?? "invalid"]);
    });
  }
  return { root, fields, first, last, hidden, form, events };
};

const begin = (field: HTMLInputElement, value: string) => {
  field.focus();
  field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
  composeDraft(field, value);
};
const interrupt = async (field: HTMLInputElement) => {
  field.dispatchEvent(
    new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", isComposing: false }),
  );
  await tick();
};
const end = (field: HTMLInputElement, value: string) => {
  field.value = value;
  const event = new Event("compositionend", { bubbles: true });
  Object.defineProperty(event, "data", { value });
  field.dispatchEvent(event);
};

for (const [confirmed, expectedLast] of [
  ["4", "4"],
  ["5", "5"],
  ["う", "4"],
  ["４", "4"],
  ["45", "4"],
] as const) {
  it(`receives an old confirmation ${confirmed} once while another field owns a draft`, async () => {
    const h = await mount();
    begin(h.last, "4");
    await interrupt(h.last);
    begin(h.first, "２");
    h.first.setSelectionRange(0, 1, "backward");
    end(h.last, confirmed);
    const oldEvents: Array<[string, string]> =
      confirmed === "う"
        ? [
            ["reconcile", "1234"],
            ["invalid", "invalid"],
          ]
        : [
            ["reconcile", "1234"],
            ["change", `123${expectedLast}`],
            ["complete", `123${expectedLast}`],
          ];
    expect.soft(h.first.value).toBe("２");
    expect.soft(document.activeElement).toBe(h.first);
    expect
      .soft([h.first.selectionStart, h.first.selectionEnd, h.first.selectionDirection])
      .toEqual([0, 1, "backward"]);
    expect.soft(h.last.value).toBe(expectedLast);
    expect.soft(h.hidden.value).toBe(`123${expectedLast}`);
    expect.soft(new FormData(h.form).get("otp")).toBe(`123${expectedLast}`);
    expect.soft(h.events).toEqual(oldEvents);
    end(h.first, "2");
    expect.soft(h.hidden.value).toBe(`223${expectedLast}`);
    expect.soft(new FormData(h.form).get("otp")).toBe(`223${expectedLast}`);
    expect
      .soft(h.events)
      .toEqual([
        ...oldEvents,
        ["change", `223${expectedLast}`],
        ["complete", `223${expectedLast}`],
      ]);
  });
}

it("distributes an earlier confirmation around the later field owning a draft", async () => {
  const h = await mount();
  begin(h.first, "4");
  await interrupt(h.first);
  begin(h.last, "２");
  h.last.setSelectionRange(0, 1, "backward");
  end(h.first, "4567");
  const oldEvents = [
    ["reconcile", "4239"],
    ["change", "4569"],
    ["complete", "4569"],
  ];
  expect.soft(h.fields.map((field) => field.value)).toEqual(["4", "5", "6", "２"]);
  expect.soft(document.activeElement).toBe(h.last);
  expect
    .soft([h.last.selectionStart, h.last.selectionEnd, h.last.selectionDirection])
    .toEqual([0, 1, "backward"]);
  expect.soft(h.hidden.value).toBe("4569");
  expect.soft(new FormData(h.form).get("otp")).toBe("4569");
  expect.soft(h.events).toEqual(oldEvents);
  end(h.last, "2");
  expect.soft(h.fields.map((field) => field.value)).toEqual(["4", "5", "6", "2"]);
  expect.soft(h.hidden.value).toBe("4562");
  expect.soft(new FormData(h.form).get("otp")).toBe("4562");
  expect.soft(h.events).toEqual([...oldEvents, ["change", "4562"], ["complete", "4562"]]);
});

it("a delayed end preserves the active field's cancellation basis and focus", async () => {
  const h = await mount();
  begin(h.last, "4");
  await interrupt(h.last);
  begin(h.first, "２");
  end(h.last, "4");
  end(h.first, "1");
  expect(h.first.value).toBe("1");
  expect(document.activeElement).toBe(h.first);
  expect(h.hidden.value).toBe("1234");
  expect(new FormData(h.form).get("otp")).toBe("1234");
  expect(h.events).toEqual([
    ["reconcile", "1234"],
    ["change", "1234"],
    ["complete", "1234"],
  ]);
});
