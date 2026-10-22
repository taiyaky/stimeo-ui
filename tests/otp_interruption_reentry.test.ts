/**
 * A held `pattern` drop applied ahead of a user's key, edit or paste reports `reconcile`
 * first; a listener that answers it synchronously with another operation supersedes the
 * user's gesture.
 */
import { Application } from "@hotwired/stimulus";
import { afterEach, expect, it } from "vitest";
import { OtpController } from "../src/controllers/otp_controller";
import { composeDraft } from "./helpers/ime";
import { typeKey } from "./helpers/keyboard";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

let application: Application | undefined;
afterEach(() => {
  if (application) disconnectAndStopApplication(application);
  application = undefined;
  document.body.innerHTML = "";
});

const MARKER = "data-stimeo--otp-interrupted";

/**
 * Mounts `a239` under `[0-9a]`, holds a drop to `[0-9]` behind a conversion in the last
 * field, and ends that conversion with a page write, so the next gesture applies the drop.
 */
const mountWithHeldDrop = async () => {
  document.body.innerHTML = `<div id="otp" data-controller="stimeo--otp" data-stimeo--otp-pattern-value="[0-9a]" role="group" aria-label="Passcode">${[
    "a",
    "2",
    "3",
    "9",
  ]
    .map(
      (value, index) =>
        `<input id="digit-${index}" value="${value}" data-stimeo--otp-target="field" aria-label="Digit ${index + 1}" data-action="input->stimeo--otp#onInput keydown->stimeo--otp#onKeydown paste->stimeo--otp#onPaste">`,
    )
    .join(
      "",
    )}<p data-stimeo--otp-target="error" hidden>Digits only</p><input type="hidden" data-stimeo--otp-target="value"></div>`;
  application = Application.start();
  application.register("stimeo--otp", OtpController);
  await tick();
  const root = document.getElementById("otp") as HTMLElement;
  const field = (index: number) => document.getElementById(`digit-${index}`) as HTMLInputElement;
  const events: string[] = [];
  for (const name of ["change", "complete", "invalid", "reconcile"])
    root.addEventListener(`stimeo--otp:${name}`, (event) => {
      const detail = (event as CustomEvent<{ value?: string; pattern?: string }>).detail;
      events.push(`${name}:${detail.value ?? detail.pattern}`);
    });
  const last = field(3);
  last.focus();
  last.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  composeDraft(last, "う");
  root.setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
  await tick();
  last.value = "4";
  const hidden = () =>
    (root.querySelector<HTMLInputElement>('input[type="hidden"]') as HTMLInputElement).value;
  /** Runs `operation` from the first `reconcile` listener call. */
  const onFirstReconcile = (operation: () => void) => {
    let done = false;
    root.addEventListener("stimeo--otp:reconcile", () => {
      if (done) return;
      done = true;
      operation();
    });
  };
  return { root, field, events, hidden, onFirstReconcile };
};

/** An ordinary edit that arrives with no key, as dictation or autofill does. */
const editWithoutKey = (field: HTMLInputElement, value: string) => {
  field.dispatchEvent(
    new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", isComposing: false }),
  );
  field.value = value;
  field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
};
const paste = (field: HTMLInputElement, text: string) => {
  const data = new DataTransfer();
  data.setData("text", text);
  field.dispatchEvent(
    new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
  );
};
/** Another edit a `reconcile` listener makes through the group's own wiring. */
const anotherEdit = (field: HTMLInputElement) => () => {
  field.value = "7";
  field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
};

it("drops a key whose held drop a listener answered with another edit", async () => {
  const h = await mountWithHeldDrop();
  h.onFirstReconcile(anotherEdit(h.field(1)));
  typeKey(h.field(2), "Backspace");
  await tick();
  expect(h.field(2).value).toBe("3");
  expect(h.hidden()).toBe("734");
  expect(h.events).toEqual(["reconcile:234", "change:734"]);
});

it("applies a held drop ahead of a key without marking the keyed field", async () => {
  const h = await mountWithHeldDrop();
  typeKey(h.field(2), "ArrowLeft");
  expect(document.activeElement).toBe(h.field(1));
  expect(h.field(2).hasAttribute(MARKER)).toBe(false);
  expect(h.events).toEqual(["reconcile:234"]);
});

it("drops an edit whose held drop a listener answered with another edit", async () => {
  const h = await mountWithHeldDrop();
  h.onFirstReconcile(anotherEdit(h.field(1)));
  editWithoutKey(h.field(2), "5");
  await tick();
  expect(h.hidden()).toBe("734");
  expect(h.events).toEqual(["reconcile:234", "change:734"]);
});

it("drops a paste whose held drop a listener answered with another edit", async () => {
  const h = await mountWithHeldDrop();
  h.onFirstReconcile(anotherEdit(h.field(1)));
  paste(h.field(2), "5");
  await tick();
  expect(h.field(2).value).toBe("3");
  expect(h.field(2).hasAttribute(MARKER)).toBe(false);
  expect(h.hidden()).toBe("734");
  expect(h.events).toEqual(["reconcile:234", "change:734"]);
});

it("drops an edit whose held drop a listener answered by disconnecting the group", async () => {
  const h = await mountWithHeldDrop();
  h.onFirstReconcile(() => application?.unload("stimeo--otp"));
  editWithoutKey(h.field(2), "5");
  await tick();
  expect(h.events).toEqual(["reconcile:234"]);
});

it("drops an edit whose held drop a listener answered by removing its field", async () => {
  const h = await mountWithHeldDrop();
  const keyed = h.field(2);
  h.onFirstReconcile(() => keyed.remove());
  editWithoutKey(keyed, "5");
  await tick();
  expect(h.events).toEqual(["reconcile:234", "reconcile:24"]);
  expect(h.field(0).getAttribute("aria-invalid")).toBeNull();
});

it("drops an edit whose held drop a listener answered by starting a conversion", async () => {
  const h = await mountWithHeldDrop();
  h.onFirstReconcile(() => {
    h.field(1).focus();
    h.field(1).dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  editWithoutKey(h.field(2), "5");
  await tick();
  expect(h.hidden()).toBe("234");
  expect(h.events).toEqual(["reconcile:234"]);
});
