import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OtpController } from "../src/controllers/otp_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

interface FixtureOptions {
  readonly count?: number;
  /** `null` omits the declaration so the Value's default is exercised. */
  readonly pattern?: string | null;
  readonly withError?: boolean;
  readonly withValue?: boolean;
  readonly inForm?: boolean;
  readonly fieldAttrs?: (index: number) => string;
}

function markup(options: FixtureOptions = {}): string {
  const {
    count = 4,
    pattern = "[0-9]",
    withError = true,
    withValue = true,
    inForm = false,
    fieldAttrs = () => "",
  } = options;

  const fields = Array.from(
    { length: count },
    (_, index) => `
        <input class="field" data-stimeo--otp-target="field" aria-label="Digit ${index + 1}"
               inputmode="numeric" maxlength="1" ${fieldAttrs(index)}
               data-action="input->stimeo--otp#onInput
                            keydown->stimeo--otp#onKeydown
                            paste->stimeo--otp#onPaste
                            pointerdown->stimeo--otp#onPointerDown" />`,
  ).join("");

  const group = `
      <div id="otp" data-controller="stimeo--otp"
           ${pattern === null ? "" : `data-stimeo--otp-pattern-value="${pattern}"`}
           role="group" aria-label="PIN passcode">
        ${fields}
        ${withError ? '<div id="error" data-stimeo--otp-target="error" hidden>Error</div>' : ""}
        ${
          withValue
            ? '<input type="hidden" id="otp-value" data-stimeo--otp-target="value" name="otp" />'
            : ""
        }
      </div>`;

  return inForm ? `<form id="form">${group}</form>` : group;
}

function fields(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>(".field"));
}

function root(): HTMLElement {
  return document.getElementById("otp") as HTMLElement;
}

function combined(): string {
  return (document.getElementById("otp-value") as HTMLInputElement).value;
}

/** Mimics a keystroke landing in a field: the browser writes, then reports. */
function type(field: HTMLInputElement, text: string): void {
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(field: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  field.dispatchEvent(event);
  return event;
}

function paste(field: HTMLElement, text: string): void {
  const dataTransfer = new DataTransfer();
  dataTransfer.setData("text", text);
  field.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: dataTransfer, bubbles: true, cancelable: true }),
  );
}

/** The events a handler from {@link listen} received, as `[name, detail]` in dispatch order. */
function order(handler: ReturnType<typeof vi.fn>): Array<[string, unknown]> {
  return handler.mock.calls.map(([event]) => {
    const { type, detail } = event as CustomEvent;
    return [type.replace("stimeo--otp:", ""), detail];
  });
}

/** Records every controller event so a test can count and inspect them. */
function listen(...names: readonly string[]): ReturnType<typeof vi.fn> {
  const handler = vi.fn();
  for (const name of names) root().addEventListener(`stimeo--otp:${name}`, handler);
  return handler;
}

/** A lease marker as this component records it, quoted for an HTML attribute. */
function lease(authored: string | null, written: string): string {
  return `'${JSON.stringify({ authored, written })}'`;
}

/** A snapshot taken while the error showed, restored into a fresh page. */
function restoredErrorMarkup(): string {
  const owned = (index: number, authored: string | null, describedBy: string) =>
    `<input class="field" data-stimeo--otp-target="field" aria-label="Digit ${index}"
            maxlength="1" aria-invalid="true" aria-errormessage="error"
            aria-describedby="${describedBy}"
            data-otp-invalid-lease=${lease(null, "true")}
            data-otp-errormessage-lease=${lease(null, "error")}
            data-otp-describedby-lease=${lease(authored, describedBy)}
            data-action="input->stimeo--otp#onInput" />`;
  // The third field carries no records, so nothing on it is this component's.
  const untouched = `<input class="field" data-stimeo--otp-target="field" aria-label="Digit 3"
            maxlength="1" aria-invalid="true" aria-describedby="hint  extra"
            data-action="input->stimeo--otp#onInput" />`;
  return `
    <div id="otp" data-controller="stimeo--otp" data-stimeo--otp-pattern-value="[0-9]"
         role="group" aria-label="PIN passcode">
      <p id="hint">Digits only</p>
      ${owned(1, null, "error")}
      ${owned(2, "hint", "hint error")}
      ${untouched}
      <div id="error" data-stimeo--otp-target="error">Error</div>
      <input type="hidden" id="otp-value" data-stimeo--otp-target="value" name="otp" />
    </div>`;
}

describe("OtpController", () => {
  let application: Application;

  it("leaves an association the consumer changed while the error showed", async () => {
    await remount({ fieldAttrs: (index) => (index === 0 ? 'aria-describedby="hint"' : "") });
    const digits = fields();
    const first = digits[0] as HTMLInputElement;

    type(first, "\u3042");
    await tick();
    // From here the value is the consumer's, not this component's.
    first.setAttribute("aria-describedby", "late-token");

    type(first, "7");
    await tick();
    expect(first.getAttribute("aria-describedby")).toBe("late-token");
  });

  it("takes back what it wrote after the error target changed its id", async () => {
    await remount({ fieldAttrs: (index) => (index === 0 ? 'aria-describedby="hint"' : "") });
    const first = fields()[0] as HTMLInputElement;
    type(first, "\u3042");
    await tick();
    expect(first.getAttribute("aria-describedby")).toBe("hint error");

    // A morph can rename the target while the error shows; the record still
    // knows which reference this component put on the field.
    (document.getElementById("error") as HTMLElement).id = "renamed";
    type(first, "7");
    await tick();
    expect(first.getAttribute("aria-describedby")).toBe("hint");
    expect(first.hasAttribute("aria-errormessage")).toBe(false);
  });

  it("takes back its last write after a consumer change and another rejection", async () => {
    await remount({ fieldAttrs: (index) => (index === 0 ? 'aria-describedby="hint"' : "") });
    const first = fields()[0] as HTMLInputElement;
    type(first, "\u3042");
    await tick();
    first.setAttribute("aria-describedby", "late-token");
    // The next rejection writes over the consumer's value, so the attribute is
    // this component's again and goes back to what was authored.
    type(first, "\u3044");
    await tick();
    expect(first.getAttribute("aria-describedby")).toBe("late-token error");

    type(first, "7");
    await tick();
    expect(first.getAttribute("aria-describedby")).toBe("hint");
  });

  it("ignores a lease marker it could not have written", async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = `
      <div id="otp" data-controller="stimeo--otp" data-stimeo--otp-pattern-value="[0-9]"
           role="group" aria-label="PIN passcode">
        <input class="field" data-stimeo--otp-target="field" aria-label="Digit 1" maxlength="1"
               aria-invalid="true" data-otp-invalid-lease="not json"
               data-action="input->stimeo--otp#onInput" />
        <input class="field" data-stimeo--otp-target="field" aria-label="Digit 2" maxlength="1"
               aria-invalid="true" data-otp-invalid-lease='{"x":1}'
               data-action="input->stimeo--otp#onInput" />
      </div>`;
    application = Application.start();
    application.register("stimeo--otp", OtpController);
    await tick();

    for (const field of fields()) {
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(field.hasAttribute("data-otp-invalid-lease")).toBe(true);
    }
  });

  it("keeps the first record when input is rejected twice in a row", async () => {
    await remount({ fieldAttrs: (index) => (index === 0 ? 'aria-describedby="hint"' : "") });
    const digits = fields();
    const first = digits[0] as HTMLInputElement;

    type(first, "\u3042");
    await tick();
    type(first, "\u3044");
    await tick();
    // The second rejection must not record the value the first one wrote, or the
    // consumer's description is lost when the error clears.
    type(first, "7");
    await tick();

    expect(first.getAttribute("aria-describedby")).toBe("hint");
    expect(first.hasAttribute("aria-invalid")).toBe(false);
  });

  it("takes back the error association a restored snapshot carries", async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = restoredErrorMarkup();
    application = Application.start();
    application.register("stimeo--otp", OtpController);
    await tick();

    const digits = fields();
    expect(document.getElementById("error")?.hasAttribute("hidden")).toBe(true);
    // Nothing has been rejected yet, so the recorded fields go back to what they
    // were authored with — absent here, and the consumer's own hint next door.
    expect(digits[0]?.hasAttribute("aria-invalid")).toBe(false);
    expect(digits[0]?.hasAttribute("aria-errormessage")).toBe(false);
    expect(digits[0]?.hasAttribute("aria-describedby")).toBe(false);
    expect(digits[1]?.getAttribute("aria-describedby")).toBe("hint");
    expect(digits[1]?.hasAttribute("aria-invalid")).toBe(false);
    // A field carrying no record holds nothing of this component's, so it comes
    // through exactly as authored, spacing included.
    expect(digits[2]?.getAttribute("aria-invalid")).toBe("true");
    expect(digits[2]?.getAttribute("aria-describedby")).toBe("hint  extra");
    // The records themselves are spent.
    expect(digits.some((field) => field.hasAttribute("data-otp-invalid-lease"))).toBe(false);
  });

  async function remount(options: FixtureOptions): Promise<void> {
    document.body.innerHTML = markup(options);
    await tick();
  }

  /**
   * The connected instance, for driving a lifecycle callback directly: happy-dom
   * does not deliver Value and target callbacks reliably, and each callback is
   * idempotent, so a second delivery from Stimulus changes nothing.
   */
  function controller(): OtpController {
    const found = application.getControllerForElementAndIdentifier(root(), "stimeo--otp");
    if (!(found instanceof OtpController)) throw new Error("stimeo--otp is not connected");
    return found;
  }

  beforeEach(async () => {
    document.body.innerHTML = markup();

    application = Application.start();
    application.register("stimeo--otp", OtpController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("reverses the horizontal arrows under RTL", async () => {
    // Logical direction. `dir="rtl"` is the authoring contract, but happy-dom does
    // not resolve it into the computed style, so the direction is set on the style
    // directly. The two branches guard different bounds (nothing before the first
    // field, nothing after the last), so this also pins each guard to its own
    // direction.
    const digits = fields();
    root().style.direction = "rtl";
    digits[0]?.focus();

    press(digits[0] as HTMLElement, "ArrowLeft");
    expect(document.activeElement).toBe(digits[1]); // "next field" under RTL

    press(digits[1] as HTMLElement, "ArrowRight");
    expect(document.activeElement).toBe(digits[0]); // "previous field"

    press(digits[0] as HTMLElement, "ArrowRight");
    expect(document.activeElement).toBe(digits[0]); // guarded at the first field
  });

  it("auto-advances focus upon valid numeric inputs and filters letters", async () => {
    const digits = fields();

    expect(digits).toHaveLength(4);
    digits[0]?.focus();
    expect(document.activeElement).toBe(digits[0]);

    type(digits[0] as HTMLInputElement, "5");
    await tick();

    expect(digits[0]?.getAttribute("data-filled")).toBe("true");
    expect(document.activeElement).toBe(digits[1]); // should auto-focus next field
    expect(combined()).toBe("5");

    // Input an invalid character "A" on the second, still empty field
    type(digits[1] as HTMLInputElement, "A");
    await tick();

    expect(digits[1]?.value).toBe(""); // rejected by the pattern
    expect(digits[1]?.getAttribute("data-filled")).toBeNull();
    expect(document.activeElement).toBe(digits[1]); // focus should remain
    expect(combined()).toBe("5");
  });

  it("rolls a rejected keystroke back to the digit the field committed", async () => {
    const digits = fields();
    type(digits[0] as HTMLInputElement, "7");
    await tick();
    expect(combined()).toBe("7");

    // Focus selects the digit, so typing kana replaces it in the DOM first
    type(digits[0] as HTMLInputElement, "あ");
    await tick();

    expect(digits[0]?.value).toBe("7"); // the committed digit survives
    expect(digits[0]?.getAttribute("data-filled")).toBe("true");
    expect(combined()).toBe("7");
    expect(document.getElementById("error")?.hasAttribute("hidden")).toBe(false);
  });

  it("auto-selects digit on focus for seamless overwrites", async () => {
    const input = fields()[0] as HTMLInputElement;
    input.value = "9";
    input.setAttribute("data-filled", "true");

    const selectSpy = vi.spyOn(input, "select");

    input.focus();
    await tick();

    expect(selectSpy).toHaveBeenCalledOnce();
  });

  it("handles Backspace retreating properly", async () => {
    const digits = fields();

    // Fill first field and move to second
    type(digits[0] as HTMLInputElement, "1");
    digits[1]?.focus();
    await tick();

    expect(document.activeElement).toBe(digits[1]);
    expect(digits[1]?.value).toBe("");

    // Press Backspace on empty second field. Focus should step back to the first field, and wipe it.
    press(digits[1] as HTMLElement, "Backspace");
    await tick();

    expect(document.activeElement).toBe(digits[0]);
    expect(digits[0]?.value).toBe("");
    expect(digits[0]?.getAttribute("data-filled")).toBeNull();
    expect(combined()).toBe("");
  });

  it("clears a filled field in place on Backspace without moving focus", async () => {
    const digits = fields();
    paste(digits[0] as HTMLElement, "1234");
    await tick();

    digits[2]?.focus();
    const event = press(digits[2] as HTMLElement, "Backspace");
    await tick();

    expect(event.defaultPrevented).toBe(true);
    expect(digits[2]?.value).toBe("");
    expect(digits[2]?.getAttribute("data-filled")).toBeNull();
    expect(document.activeElement).toBe(digits[2]); // stays put
    expect(digits[1]?.value).toBe("2"); // the previous digit is untouched
    expect(combined()).toBe("124");
  });

  it("leaves a modified arrow to the browser", async () => {
    // A chorded arrow belongs to the browser or the OS, so the fields must neither
    // consume the press nor move focus to the next digit.
    const digits = fields();
    digits[0]?.focus();

    const chord = press(digits[0] as HTMLElement, "ArrowRight", { altKey: true });
    await tick();

    expect(chord.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(digits[0]);
  });

  it("leaves chorded Home, End, and Backspace to the document", async () => {
    const digits = fields();
    type(digits[0] as HTMLInputElement, "1");
    digits[1]?.focus();
    await tick();

    const end = press(digits[1] as HTMLElement, "End", { ctrlKey: true });
    const home = press(digits[1] as HTMLElement, "Home", { ctrlKey: true });
    await tick();

    expect(end.defaultPrevented).toBe(false);
    expect(home.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(digits[1]);

    digits[0]?.focus();
    const backspace = press(digits[0] as HTMLElement, "Backspace", { ctrlKey: true });
    await tick();

    expect(backspace.defaultPrevented).toBe(false);
    expect(digits[0]?.value).toBe("1"); // the digit is the document's to delete
  });

  it("handles ArrowKeys and Home/End focus stepping", async () => {
    const digits = fields();

    digits[0]?.focus();

    press(digits[0] as HTMLElement, "ArrowRight");
    await tick();
    expect(document.activeElement).toBe(digits[1]);

    press(digits[1] as HTMLElement, "End");
    await tick();
    expect(document.activeElement).toBe(digits[3]);

    press(digits[3] as HTMLElement, "ArrowLeft");
    await tick();
    expect(document.activeElement).toBe(digits[2]);

    press(digits[2] as HTMLElement, "Home");
    await tick();
    expect(document.activeElement).toBe(digits[0]);
  });

  it("intercepts Paste, divides numeric characters, and triggers complete event", async () => {
    const digits = fields();
    const completeHandler = listen("complete");

    digits[0]?.focus();

    // Simulate paste with text containing digits and letters: "A-83d7" -> digits: "837"
    paste(digits[0] as HTMLElement, "A-83d7");
    await tick();

    expect(digits[0]?.value).toBe("8");
    expect(digits[1]?.value).toBe("3");
    expect(digits[2]?.value).toBe("7");
    expect(digits[3]?.value).toBe(""); // 4th is still empty since we only had 3 digits

    expect(document.activeElement).toBe(digits[3]); // the field after the last filled one
    expect(combined()).toBe("837");
    expect(completeHandler).not.toHaveBeenCalled();

    // Now fill the last digit to trigger complete
    type(digits[3] as HTMLInputElement, "2");
    await tick();

    expect(combined()).toBe("8372");
    expect(completeHandler).toHaveBeenCalledOnce();
    expect(completeHandler.mock.calls[0]?.[0]?.detail).toEqual({ value: "8372" });
  });

  it("keeps focus on the last field when a paste fills the whole passcode", async () => {
    const digits = fields();
    const completeHandler = listen("complete");

    digits[0]?.focus();
    paste(digits[0] as HTMLElement, "13579");
    await tick();

    expect(digits.map((field) => field.value)).toEqual(["1", "3", "5", "7"]); // clamped
    expect(document.activeElement).toBe(digits[3]); // nothing to advance to
    expect(combined()).toBe("1357");
    expect(completeHandler).toHaveBeenCalledOnce();
    expect(completeHandler.mock.calls[0]?.[0]?.detail).toEqual({ value: "1357" });
  });

  it("keeps a paste that only drops separators free of an error", async () => {
    const digits = fields();
    const invalidHandler = listen("invalid");

    digits[0]?.focus();
    paste(digits[0] as HTMLElement, "12-34");
    await tick();

    expect(digits.map((field) => field.value)).toEqual(["1", "2", "3", "4"]);
    expect(invalidHandler).not.toHaveBeenCalled();
    expect(document.getElementById("error")?.hasAttribute("hidden")).toBe(true);
  });

  it("spreads autofilled text across the following fields", async () => {
    // An OS one-time-code autofill or a password manager drops the whole passcode
    // into the field it focused, which arrives as one `input` event.
    const digits = fields();
    const completeHandler = listen("complete");
    digits[0]?.focus();

    type(digits[0] as HTMLInputElement, "246813");
    await tick();

    expect(digits.map((field) => field.value)).toEqual(["2", "4", "6", "8"]);
    expect(digits.every((field) => field.getAttribute("data-filled") === "true")).toBe(true);
    expect(document.activeElement).toBe(digits[3]);
    expect(combined()).toBe("2468");
    expect(completeHandler).toHaveBeenCalledOnce();
  });

  it("auto-normalizes full-width digits to half-width numbers", async () => {
    const digits = fields();

    digits[0]?.focus();
    type(digits[0] as HTMLInputElement, "３");
    await tick();

    expect(digits[0]?.value).toBe("3"); // auto-converted to "3"
    expect(digits[0]?.getAttribute("data-filled")).toBe("true");
    expect(document.activeElement).toBe(digits[1]); // stepped forward
    expect(combined()).toBe("3");
  });

  it("shows dynamic error validation message on invalid input", async () => {
    const digits = fields();
    const errorEl = document.getElementById("error") as HTMLElement;

    digits[0]?.focus();
    expect(errorEl.hasAttribute("hidden")).toBe(true);

    type(digits[0] as HTMLInputElement, "あ");
    await tick();

    expect(digits[0]?.value).toBe(""); // nothing to roll back to
    expect(errorEl.hasAttribute("hidden")).toBe(false); // warning visible
    expect(digits.every((field) => field.getAttribute("aria-invalid") === "true")).toBe(true);
    expect(digits[0]?.getAttribute("aria-errormessage")).toBe("error");
    expect(digits[0]?.getAttribute("aria-describedby")).toBe("error");

    // Correcting it to "7" should clear the error message and its ARIA
    type(digits[0] as HTMLInputElement, "7");
    await tick();

    expect(digits[0]?.value).toBe("7");
    expect(errorEl.hasAttribute("hidden")).toBe(true);
    expect(digits.some((field) => field.hasAttribute("aria-invalid"))).toBe(false);
    expect(digits.some((field) => field.hasAttribute("aria-errormessage"))).toBe(false);
    expect(digits.some((field) => field.hasAttribute("aria-describedby"))).toBe(false);
  });

  it("keeps an authored description while an error is shown", async () => {
    await remount({ fieldAttrs: (index) => (index === 0 ? 'aria-describedby="hint"' : "") });
    const digits = fields();

    type(digits[0] as HTMLInputElement, "あ");
    await tick();
    expect(digits[0]?.getAttribute("aria-describedby")).toBe("hint error");

    type(digits[0] as HTMLInputElement, "4");
    await tick();
    expect(digits[0]?.getAttribute("aria-describedby")).toBe("hint");
  });

  it("dispatches invalid with the pattern that rejected the input", async () => {
    const invalidHandler = listen("invalid");
    const digits = fields();

    type(digits[0] as HTMLInputElement, "z");
    await tick();

    expect(invalidHandler).toHaveBeenCalledOnce();
    expect(invalidHandler.mock.calls[0]?.[0]?.detail).toEqual({ pattern: "[0-9]" });
  });

  it("reports the effective pattern that rejected the input", async () => {
    await remount({ pattern: "[0-9a-f]" });
    const invalidHandler = listen("invalid");

    type(fields()[0] as HTMLInputElement, "z");
    await tick();

    expect(invalidHandler.mock.calls[0]?.[0]?.detail).toEqual({ pattern: "[0-9a-f]" });
  });

  it("reports rejected input even without an error target", async () => {
    await remount({ withError: false });
    const digits = fields();
    const invalidHandler = listen("invalid");

    type(digits[0] as HTMLInputElement, "z");
    await tick();

    expect(invalidHandler).toHaveBeenCalledOnce();
    expect(digits[0]?.getAttribute("aria-invalid")).toBe("true");
    expect(digits[0]?.hasAttribute("aria-errormessage")).toBe(false);
    expect(digits[0]?.hasAttribute("aria-describedby")).toBe(false);
  });

  it("dispatches change with the combined value on every real transition", async () => {
    const changeHandler = listen("change");
    const digits = fields();

    type(digits[0] as HTMLInputElement, "6");
    await tick();
    expect(changeHandler).toHaveBeenCalledOnce();
    expect(changeHandler.mock.calls[0]?.[0]?.detail).toEqual({ value: "6" });

    // Rejected input moves nothing, so it must stay silent
    type(digits[1] as HTMLInputElement, "q");
    await tick();
    expect(changeHandler).toHaveBeenCalledOnce();

    press(digits[1] as HTMLElement, "Backspace");
    await tick();
    expect(changeHandler).toHaveBeenCalledTimes(2);
    expect(changeHandler.mock.calls[1]?.[0]?.detail).toEqual({ value: "" });
  });

  it("re-completes only when the completed value actually changes", async () => {
    const completeHandler = listen("complete");
    const digits = fields();

    paste(digits[0] as HTMLElement, "1234");
    await tick();
    expect(completeHandler).toHaveBeenCalledOnce();

    // Overwriting the last digit with the same character keeps the value put
    digits[3]?.focus();
    type(digits[3] as HTMLInputElement, "4");
    await tick();
    expect(completeHandler).toHaveBeenCalledOnce();

    // A different digit is a different passcode, so it is reported again
    type(digits[3] as HTMLInputElement, "9");
    await tick();
    expect(completeHandler).toHaveBeenCalledTimes(2);
    expect(completeHandler.mock.calls[1]?.[0]?.detail).toEqual({ value: "1239" });
  });

  it("falls back to the default pattern when nothing is declared", async () => {
    await remount({ pattern: null });
    const digits = fields();

    type(digits[0] as HTMLInputElement, "8");
    await tick();
    expect(digits[0]?.value).toBe("8"); // the default [0-9] accepts a digit

    type(digits[1] as HTMLInputElement, "b");
    await tick();
    expect(digits[1]?.value).toBe(""); // and rejects a letter
    expect(combined()).toBe("8");
  });

  it("falls back to the default pattern when the declaration cannot compile", async () => {
    await remount({ pattern: "[" });
    const digits = fields();
    const invalidHandler = listen("invalid");

    type(digits[0] as HTMLInputElement, "5");
    await tick();

    expect(digits[0]?.value).toBe("5"); // the pipeline survives a broken declaration
    expect(digits[0]?.getAttribute("data-filled")).toBe("true");
    expect(document.activeElement).toBe(digits[1]);
    expect(combined()).toBe("5");

    type(digits[1] as HTMLInputElement, "x");
    await tick();
    expect(invalidHandler.mock.calls[0]?.[0]?.detail).toEqual({ pattern: "[0-9]" });
  });

  it("falls back when the declaration only compiles inside the anchors", async () => {
    // `0)|(1` is not a regular expression on its own, so it declares nothing and
    // the field keeps the default `[0-9]`.
    await remount({ pattern: "0)|(1" });
    const digits = fields();
    const invalidHandler = listen("invalid");

    type(digits[0] as HTMLInputElement, "2");
    await tick();

    expect(digits[0]?.value).toBe("2");
    expect(combined()).toBe("2");

    type(digits[1] as HTMLInputElement, "x");
    await tick();
    expect(invalidHandler.mock.calls[0]?.[0]?.detail).toEqual({ pattern: "[0-9]" });
  });

  it("drops digits a changed pattern no longer accepts, as a reconciliation", async () => {
    await remount({ pattern: "[0-9a-f]" });
    const digits = fields();

    paste(digits[0] as HTMLElement, "1a2b");
    await tick();
    expect(combined()).toBe("1a2b");

    // The page changed the declaration, so the digits it drops are its doing:
    // not an edit, and never a completion.
    const editHandler = listen("change", "complete");
    const reconcileHandler = listen("reconcile");
    root().setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
    controller().patternValueChanged();
    await tick();

    expect(digits.map((field) => field.value)).toEqual(["1", "", "2", ""]);
    expect(digits[1]?.getAttribute("data-filled")).toBeNull();
    expect(combined()).toBe("12");
    expect(root().getAttribute("data-state")).toBe("partial");
    expect(editHandler).not.toHaveBeenCalled();
    expect(reconcileHandler).toHaveBeenCalledOnce();
    expect(reconcileHandler.mock.calls[0]?.[0]?.detail).toEqual({ value: "12" });
  });

  it("stays silent when a changed pattern still accepts every entered digit", async () => {
    paste(fields()[0] as HTMLElement, "12");
    await tick();

    const handler = listen("change", "complete", "reconcile");
    root().setAttribute("data-stimeo--otp-pattern-value", "[0-9a-f]");
    controller().patternValueChanged();
    await tick();

    expect(combined()).toBe("12");
    expect(handler).not.toHaveBeenCalled();
  });

  it("reports a pattern change and a dropped field from one mutation as one reconciliation", async () => {
    await remount({ pattern: "[0-9a-f]" });
    const digits = fields();
    paste(digits[0] as HTMLElement, "1a2b");
    await tick();

    const editHandler = listen("change", "complete");
    const reconcileHandler = listen("reconcile");
    root().setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
    controller().patternValueChanged();
    const last = digits[3] as HTMLInputElement;
    last.remove();
    controller().fieldTargetDisconnected(last);
    await tick();

    expect(fields().map((field) => field.value)).toEqual(["1", "", "2"]);
    expect(combined()).toBe("12");
    expect(editHandler).not.toHaveBeenCalled();
    expect(reconcileHandler).toHaveBeenCalledOnce();
    expect(reconcileHandler.mock.calls[0]?.[0]?.detail).toEqual({ value: "12" });
  });

  it("holds a pattern change while a field is composing, and applies it before the commit", async () => {
    await remount({ pattern: "[0-9a-f]" });
    const digits = fields();
    paste(digits[0] as HTMLElement, "a");
    await tick();

    const handler = listen("change", "complete", "invalid", "reconcile");
    const second = digits[1] as HTMLInputElement;
    second.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    type(second, "う");
    root().setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
    controller().patternValueChanged();
    await tick();

    // The field being composed holds the IME's text, and the drop waits for it.
    expect(digits.map((field) => field.value)).toEqual(["a", "う", "", ""]);
    expect(handler).not.toHaveBeenCalled();

    second.value = "５";
    second.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await tick();

    // The drop was declared before the commit, so it is reported first; the
    // commit follows as the user's edit.
    expect(digits.map((field) => field.value)).toEqual(["", "5", "", ""]);
    expect(order(handler)).toEqual([
      ["reconcile", { value: "" }],
      ["change", { value: "5" }],
    ]);
  });

  it("applies a held drop before the commit, so the commit cannot complete what the pattern rejects", async () => {
    await remount({ pattern: "[0-9a-f]" });
    const digits = fields();
    paste(digits[0] as HTMLElement, "a12");
    await tick();

    const handler = listen("change", "complete", "invalid", "reconcile");
    const fourth = digits[3] as HTMLInputElement;
    fourth.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    type(fourth, "ご");
    root().setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
    controller().patternValueChanged();
    await tick();
    fourth.value = "５";
    fourth.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await tick();

    expect(digits.map((field) => field.value)).toEqual(["", "1", "2", "5"]);
    expect(order(handler)).toEqual([
      ["reconcile", { value: "12" }],
      ["change", { value: "125" }],
    ]);
  });

  it("keeps a commit the new pattern accepts out of the held drop's reconciliation", async () => {
    await remount({ pattern: "[0-9a-f]" });
    const digits = fields();
    paste(digits[0] as HTMLElement, "a");
    await tick();

    const handler = listen("change", "complete", "invalid", "reconcile");
    const second = digits[1] as HTMLInputElement;
    second.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    type(second, "ご");
    root().setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
    controller().patternValueChanged();
    await tick();
    second.value = "5";
    second.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await tick();

    // The drop is the page's and reports without the 5; the 5 is the user's.
    expect(order(handler)).toEqual([
      ["reconcile", { value: "" }],
      ["change", { value: "5" }],
    ]);
  });

  it("counts a field by the text it shows once nothing is composing", async () => {
    const handler = listen("reconcile");
    // Written by the page, so no input event reports it; the next reconciliation reads it.
    (fields()[0] as HTMLInputElement).value = "7";
    const arrived = document.createElement("input");
    arrived.className = "field";
    arrived.setAttribute("data-stimeo--otp-target", "field");
    arrived.setAttribute("aria-label", "Digit 5");
    root().insertBefore(arrived, document.getElementById("error"));
    controller().fieldTargetConnected(arrived);
    await tick();

    expect(combined()).toBe("7");
    expect(order(handler)).toEqual([["reconcile", { value: "7" }]]);
  });

  it("reports a held drop, then the rejection of a commit the new pattern refuses", async () => {
    await remount({ pattern: "[0-9a-f]" });
    const digits = fields();
    paste(digits[0] as HTMLElement, "a1");
    await tick();

    const handler = listen("change", "complete", "invalid", "reconcile");
    const third = digits[2] as HTMLInputElement;
    third.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    type(third, "ｂ");
    root().setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
    controller().patternValueChanged();
    await tick();
    third.value = "b";
    third.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await tick();

    expect(digits.map((field) => field.value)).toEqual(["", "1", "", ""]);
    expect(order(handler)).toEqual([
      ["reconcile", { value: "1" }],
      ["invalid", { pattern: "[0-9]" }],
    ]);
  });

  it("lets a held pattern change decide a field whose composition was cancelled", async () => {
    await remount({ pattern: "[0-9a-f]" });
    const digits = fields();
    paste(digits[0] as HTMLElement, "1a");
    await tick();

    const userHandler = listen("change", "complete", "invalid");
    const reconcileHandler = listen("reconcile");
    const second = digits[1] as HTMLInputElement;
    second.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    second.value = "あ";
    root().setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
    controller().patternValueChanged();

    // Cancelling the conversion puts back the character the field held: nothing
    // the user entered, so it is not reported as rejected input either.
    second.value = "a";
    second.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await tick();

    expect(digits.map((field) => field.value)).toEqual(["1", "", "", ""]);
    expect(userHandler).not.toHaveBeenCalled();
    expect(reconcileHandler.mock.calls.map((call) => call[0]?.detail)).toEqual([{ value: "1" }]);
    expect(document.getElementById("error")?.hidden).toBe(true);
  });

  it("keeps uncommitted text out of what a reconciliation publishes mid-composition", async () => {
    const digits = fields();
    type(digits[0] as HTMLInputElement, "1");
    await tick();

    const reconcileHandler = listen("reconcile");
    const second = digits[1] as HTMLInputElement;
    second.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    type(second, "う");
    const arrived = document.createElement("input");
    arrived.className = "field";
    arrived.setAttribute("data-stimeo--otp-target", "field");
    arrived.setAttribute("aria-label", "Digit 5");
    root().insertBefore(arrived, document.getElementById("error"));
    controller().fieldTargetConnected(arrived);
    await tick();

    expect(combined()).toBe("1");
    expect(reconcileHandler).not.toHaveBeenCalled();

    second.value = "２";
    second.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await tick();

    expect(combined()).toBe("12");
  });

  it("reports a filled field removed mid-composition as reconcile at once, apart from the commit", async () => {
    const digits = fields();
    type(digits[0] as HTMLInputElement, "1");
    await tick();

    const handler = listen("change", "complete", "invalid", "reconcile");
    const second = digits[1] as HTMLInputElement;
    second.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    type(second, "う");
    const first = digits[0] as HTMLInputElement;
    first.remove();
    controller().fieldTargetDisconnected(first);
    await tick();

    // The removal is already in the DOM; the field being composed counts by what
    // it had committed, so its uncommitted text stays out.
    expect(order(handler)).toEqual([["reconcile", { value: "" }]]);

    second.value = "２";
    second.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await tick();

    expect(order(handler)).toEqual([
      ["reconcile", { value: "" }],
      ["change", { value: "2" }],
    ]);
    expect(combined()).toBe("2");
  });

  it("reports a form reset mid-composition as reconcile at once, apart from the commit", async () => {
    await remount({ inForm: true });
    const digits = fields();
    type(digits[0] as HTMLInputElement, "1");
    await tick();

    const handler = listen("change", "complete", "invalid", "reconcile");
    const second = digits[1] as HTMLInputElement;
    second.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    type(second, "う");
    (document.getElementById("form") as HTMLFormElement).reset();
    await tick();

    expect(order(handler)).toEqual([["reconcile", { value: "" }]]);
    expect(combined()).toBe("");

    second.value = "５";
    second.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await tick();

    expect(order(handler)).toEqual([
      ["reconcile", { value: "" }],
      ["change", { value: "5" }],
    ]);
  });

  it("gives the error surface back when the form is reset mid-composition", async () => {
    await remount({
      inForm: true,
      fieldAttrs: (index) => (index === 0 ? 'aria-describedby="hint"' : ""),
    });
    const digits = fields();
    const first = digits[0] as HTMLInputElement;
    type(first, "あ");
    await tick();
    expect(first.getAttribute("aria-invalid")).toBe("true");

    const second = digits[1] as HTMLInputElement;
    second.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    type(second, "う");
    (document.getElementById("form") as HTMLFormElement).reset();
    await tick();

    expect(first.hasAttribute("aria-invalid")).toBe(false);
    expect(first.hasAttribute("aria-errormessage")).toBe(false);
    expect(first.getAttribute("aria-describedby")).toBe("hint");
    expect(document.getElementById("error")?.hidden).toBe(true);
  });

  it("reports a field added mid-composition as reconcile at once when it moves completeness", async () => {
    const digits = fields();
    paste(digits[0] as HTMLElement, "1234");
    await tick();

    const handler = listen("change", "complete", "invalid", "reconcile");
    const fourth = digits[3] as HTMLInputElement;
    fourth.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    type(fourth, "よ");
    const arrived = document.createElement("input");
    arrived.className = "field";
    arrived.setAttribute("data-stimeo--otp-target", "field");
    arrived.setAttribute("aria-label", "Digit 5");
    root().insertBefore(arrived, document.getElementById("error"));
    controller().fieldTargetConnected(arrived);
    await tick();

    // The composing field still counts by its committed 4, so only the empty
    // arrival moves the state: the passcode stops being complete.
    expect(order(handler)).toEqual([["reconcile", { value: "1234" }]]);
    expect(root().getAttribute("data-state")).toBe("partial");

    fourth.value = "９";
    fourth.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await tick();

    expect(order(handler)).toEqual([
      ["reconcile", { value: "1234" }],
      ["change", { value: "1239" }],
    ]);
  });

  it("reports a removal at once, then a held pattern drop, then the commit", async () => {
    await remount({ pattern: "[0-9a-f]" });
    const digits = fields();
    paste(digits[0] as HTMLElement, "a1");
    await tick();

    const handler = listen("change", "complete", "invalid", "reconcile");
    const third = digits[2] as HTMLInputElement;
    third.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    type(third, "う");
    root().setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
    controller().patternValueChanged();
    await tick();
    const second = digits[1] as HTMLInputElement;
    second.remove();
    controller().fieldTargetDisconnected(second);
    await tick();

    // The removal is in the DOM already; the drop of "a" waits for the commit.
    expect(order(handler)).toEqual([["reconcile", { value: "a" }]]);

    third.value = "５";
    third.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await tick();

    expect(order(handler)).toEqual([
      ["reconcile", { value: "a" }],
      ["reconcile", { value: "" }],
      ["change", { value: "5" }],
    ]);
    expect(fields().map((field) => field.value)).toEqual(["", "5", ""]);
  });

  it("applies a held pattern drop once the composing field itself is removed", async () => {
    await remount({ pattern: "[0-9a-f]" });
    const digits = fields();
    paste(digits[0] as HTMLElement, "a1");
    await tick();

    const handler = listen("change", "complete", "invalid", "reconcile");
    const third = digits[2] as HTMLInputElement;
    third.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    type(third, "ｂ");
    root().setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
    controller().patternValueChanged();
    await tick();
    third.remove();
    controller().fieldTargetDisconnected(third);
    await tick();

    // With the composition gone, nothing waits any more.
    expect(fields().map((field) => field.value)).toEqual(["", "1", ""]);
    expect(order(handler)).toEqual([["reconcile", { value: "1" }]]);
  });

  it("takes a cancelled composition as no edit: no event and no step forward", async () => {
    await remount({ pattern: "[0-9a-f]" });
    const digits = fields();
    paste(digits[0] as HTMLElement, "a1");
    await tick();

    const handler = listen("change", "complete", "invalid", "reconcile");
    const second = digits[1] as HTMLInputElement;
    second.focus();
    second.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    type(second, "あ");
    // Cancelling puts back the text the field had before the composition began.
    second.value = "1";
    second.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await tick();

    expect(document.activeElement).toBe(second);
    expect(digits.map((field) => field.value)).toEqual(["a", "1", "", ""]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("drops the page changes a composition held when the controller disconnects", async () => {
    await remount({ pattern: "[0-9a-f]" });
    const digits = fields();
    paste(digits[0] as HTMLElement, "a");
    await tick();

    const second = digits[1] as HTMLInputElement;
    second.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    root().setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
    controller().patternValueChanged();
    // Stimulus delivers its own callback too; both land mid-composition.
    await tick();
    expect(digits[0]?.value).toBe("a");

    const instance = controller();
    instance.disconnect();
    instance.connect();

    // A reconnection reads the fields as they are; a later reconciliation does
    // not bring back the drop the disconnection discarded.
    const arrived = document.createElement("input");
    arrived.className = "field";
    arrived.setAttribute("data-stimeo--otp-target", "field");
    arrived.setAttribute("aria-label", "Digit 5");
    root().insertBefore(arrived, document.getElementById("error"));
    instance.fieldTargetConnected(arrived);
    await tick();

    expect(digits[0]?.value).toBe("a");
  });

  it("keeps a server-rendered value the pattern rejects", async () => {
    // The controller reads the fields as the truth on connect; an authored value
    // is the server's, not something a declaration change may quietly drop.
    document.body.innerHTML = markup({ fieldAttrs: (index) => (index === 0 ? 'value="a"' : "") });
    const changeHandler = vi.fn();
    root().addEventListener("stimeo--otp:change", changeHandler);
    await tick();

    expect(fields()[0]?.value).toBe("a");
    expect(fields()[0]?.getAttribute("data-filled")).toBe("true");
    expect(combined()).toBe("a");
    expect(changeHandler).not.toHaveBeenCalled();
  });

  it("leaves a readonly field alone when the pattern changes", async () => {
    await remount({
      pattern: "[0-9a-f]",
      fieldAttrs: (index) => (index === 2 ? 'readonly value="a"' : ""),
    });
    const digits = fields();

    paste(digits[0] as HTMLElement, "12");
    await tick();
    expect(combined()).toBe("12a");

    root().setAttribute("data-stimeo--otp-pattern-value", "[0-9]");
    await tick();

    expect(digits[2]?.value).toBe("a"); // readonly: not the controller's to clear
    expect(combined()).toBe("12a");
  });

  it("distributes a confirmation that committed more characters than the field kept", async () => {
    const digits = fields();
    digits[0]?.focus();
    digits[0]?.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    await tick();

    // `maxlength="1"` leaves the field one character, but the commit itself
    // carries the whole confirmed string — the fields after it must still fill.
    // happy-dom aliases CompositionEvent to Event, so the committed text is
    // attached the way the platform interface exposes it.
    if (digits[0]) digits[0].value = "１";
    const confirmation = new Event("compositionend", { bubbles: true });
    Object.defineProperty(confirmation, "data", { value: "１２３４" });
    digits[0]?.dispatchEvent(confirmation);
    await tick();

    expect(digits.map((field) => field.value)).toEqual(["1", "2", "3", "4"]);
    expect(combined()).toBe("1234");
  });

  it("guards auto-advance processing during active IME composition and triggers on end", async () => {
    const digits = fields();
    const changeHandler = listen("change");
    const completeHandler = listen("complete");

    digits[0]?.focus();
    digits[0]?.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    await tick();

    // Simulate input while composing (e.g. typing hiragana "う")
    type(digits[0] as HTMLInputElement, "う");
    await tick();

    // Focus should remain and value should not be validated/cleared yet
    expect(document.activeElement).toBe(digits[0]);
    expect(digits[0]?.value).toBe("う");
    expect(changeHandler).not.toHaveBeenCalled();

    // Simulate compositionend with a full-width digit "９" (resolved from conversion)
    (digits[0] as HTMLInputElement).value = "９";
    digits[0]?.dispatchEvent(new Event("compositionend", { bubbles: true }));
    // The browser confirms the commit with one more `input` carrying the same text
    digits[0]?.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    expect(digits[0]?.value).toBe("9"); // normalized to half-width
    expect(document.activeElement).toBe(digits[1]); // stepped forward once
    expect(changeHandler).toHaveBeenCalledOnce(); // and reported once
    expect(completeHandler).not.toHaveBeenCalled();
  });

  it("emits one complete when the last digit is confirmed by an IME", async () => {
    const digits = fields();
    const completeHandler = listen("complete");

    paste(digits[0] as HTMLElement, "123");
    await tick();

    const last = digits[3] as HTMLInputElement;
    last.focus();
    last.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    last.value = "４";
    last.dispatchEvent(new Event("compositionend", { bubbles: true }));
    last.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    expect(combined()).toBe("1234");
    expect(completeHandler).toHaveBeenCalledOnce();
    expect(completeHandler.mock.calls[0]?.[0]?.detail).toEqual({ value: "1234" });
  });

  it("keeps typing responsive after a commit that sends no trailing input", async () => {
    // Not every engine follows `compositionend` with a confirming `input`; the
    // next keystroke must not be swallowed by the guard that absorbs one.
    const digits = fields();
    const first = digits[0] as HTMLInputElement;

    first.focus();
    first.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    first.value = "５";
    first.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await tick();
    expect(first.value).toBe("5");

    const next = digits[1] as HTMLInputElement;
    press(next, "6");
    type(next, "6");
    await tick();

    expect(next.value).toBe("6");
    expect(combined()).toBe("56");
  });

  it("accepts a keyless edit that lands on the field that just confirmed", async () => {
    // Dictation, autofill and a drop arrive with no key before them, so the
    // window that absorbs the browser's echo cannot tell them apart on timing
    // alone; the kind the engine reports on the event can.
    const digits = fields();
    const first = digits[0] as HTMLInputElement;

    first.focus();
    first.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    first.value = "１";
    first.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await tick();
    expect(combined()).toBe("1");

    first.value = "7";
    first.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await tick();

    expect(first.value).toBe("7");
    expect(combined()).toBe("7");
    expect(document.activeElement).toBe(digits[1]);
  });

  it("does not re-spread a commit the browser confirms with a trailing input", async () => {
    const digits = fields();
    const first = digits[0] as HTMLInputElement;

    first.focus();
    first.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    first.value = "１２３";
    first.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await tick();
    expect(digits.map((field) => field.value)).toEqual(["1", "2", "3", ""]);
    expect(document.activeElement).toBe(digits[3]);

    // Re-running the same text would spread it again and drag focus back
    first.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    expect(digits.map((field) => field.value)).toEqual(["1", "2", "3", ""]);
    expect(document.activeElement).toBe(digits[3]);
  });

  it("forgets a pending commit marker for a field that leaves the DOM", async () => {
    const digits = fields();
    const first = digits[0] as HTMLInputElement;

    first.focus();
    first.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    first.value = "５";
    first.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await tick();
    expect(first.value).toBe("5");

    // A morph or re-render takes the field away and puts it back before the
    // browser's confirming input ever arrives; the next keystroke is a real edit.
    const parent = first.parentElement as HTMLElement;
    const following = first.nextSibling;
    first.remove();
    await tick();
    parent.insertBefore(first, following);
    await tick();

    type(first, "7");
    await tick();

    expect(first.value).toBe("7");
    expect(first.getAttribute("data-filled")).toBe("true");
    expect(combined()).toBe("7");
  });

  it("ignores keydown handling while a composition is active", async () => {
    const digits = fields();
    type(digits[0] as HTMLInputElement, "1");
    await tick();

    const first = digits[0] as HTMLInputElement;
    first.focus();
    first.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    const event = press(first, "Backspace");
    await tick();

    expect(event.defaultPrevented).toBe(false); // the IME owns the key
    expect(first.value).toBe("1");
    expect(combined()).toBe("1");
  });

  it("wires fields added at runtime", async () => {
    const container = root();
    const added = document.createElement("input");
    added.className = "field";
    added.setAttribute("data-stimeo--otp-target", "field");
    added.setAttribute("aria-label", "Digit 5");
    added.setAttribute(
      "data-action",
      "input->stimeo--otp#onInput keydown->stimeo--otp#onKeydown paste->stimeo--otp#onPaste",
    );
    container.insertBefore(added, document.getElementById("error"));
    await tick();

    const selectSpy = vi.spyOn(added, "select");
    added.focus();
    expect(selectSpy).toHaveBeenCalledOnce(); // focus listener reached the new field

    type(added, "7");
    await tick();
    expect(added.getAttribute("data-filled")).toBe("true");
    expect(combined()).toBe("7"); // the digit count grew with the DOM
    expect(fields()).toHaveLength(5);
  });

  it("follows the digit count when a field is removed at runtime", async () => {
    const digits = fields();
    paste(digits[0] as HTMLElement, "1234");
    await tick();
    expect(root().getAttribute("data-state")).toBe("complete");

    // The page moved the value, so it is a reconciliation — not an edit, and not
    // a completion that would make a subscriber submit the shortened code.
    const editHandler = listen("change", "complete");
    const reconcileHandler = listen("reconcile");
    digits[3]?.remove();
    await tick();

    expect(combined()).toBe("123");
    expect(root().getAttribute("data-state")).toBe("complete"); // three of three
    expect(editHandler).not.toHaveBeenCalled();
    expect(reconcileHandler).toHaveBeenCalledOnce();
    expect(reconcileHandler.mock.calls[0]?.[0]?.detail).toEqual({ value: "123" });
  });

  it("reports completion reached by dropping a trailing empty field", async () => {
    const digits = fields();
    type(digits[0] as HTMLInputElement, "1");
    type(digits[1] as HTMLInputElement, "2");
    type(digits[2] as HTMLInputElement, "3");
    await tick();
    expect(combined()).toBe("123");
    expect(root().getAttribute("data-state")).toBe("partial");

    // The combined value does not move, but three of three digits is a complete
    // passcode where three of four was not.
    const editHandler = listen("change", "complete");
    const reconcileHandler = listen("reconcile");
    digits[3]?.remove();
    await tick();

    expect(combined()).toBe("123");
    expect(root().getAttribute("data-state")).toBe("complete");
    expect(editHandler).not.toHaveBeenCalled();
    expect(reconcileHandler).toHaveBeenCalledOnce();
    expect(reconcileHandler.mock.calls[0]?.[0]?.detail).toEqual({ value: "123" });
  });

  it("reports completion lost when an empty field arrives", async () => {
    paste(fields()[0] as HTMLElement, "1234");
    await tick();
    expect(root().getAttribute("data-state")).toBe("complete");

    const editHandler = listen("change", "complete");
    const reconcileHandler = listen("reconcile");
    const arrived = document.createElement("input");
    arrived.className = "field";
    arrived.setAttribute("data-stimeo--otp-target", "field");
    arrived.setAttribute("aria-label", "Digit 5");
    root().insertBefore(arrived, document.getElementById("error"));
    await tick();

    expect(combined()).toBe("1234"); // the string is untouched
    expect(root().getAttribute("data-state")).toBe("partial");
    expect(editHandler).not.toHaveBeenCalled();
    expect(reconcileHandler).toHaveBeenCalledOnce();
    expect(reconcileHandler.mock.calls[0]?.[0]?.detail).toEqual({ value: "1234" });
  });

  it("stays silent when a dropped empty field leaves the state where it was", async () => {
    const digits = fields();
    type(digits[0] as HTMLInputElement, "1");
    await tick();
    expect(root().getAttribute("data-state")).toBe("partial");

    // One of four and one of three are both partial, so nothing public moved.
    const handler = listen("reconcile", "change", "complete");
    digits[3]?.remove();
    await tick();

    expect(combined()).toBe("1");
    expect(root().getAttribute("data-state")).toBe("partial");
    expect(handler).not.toHaveBeenCalled();
  });

  it("stays silent when a field arrives without moving the value", async () => {
    const reconcileHandler = listen("reconcile", "change");
    const added = document.createElement("input");
    added.className = "field";
    added.setAttribute("data-stimeo--otp-target", "field");
    added.setAttribute("aria-label", "Digit 5");
    root().insertBefore(added, document.getElementById("error"));
    await tick();

    expect(fields()).toHaveLength(5);
    expect(reconcileHandler).not.toHaveBeenCalled();
  });

  it("publishes the entry state on the controller element", async () => {
    const digits = fields();
    expect(root().getAttribute("data-state")).toBe("empty");

    type(digits[0] as HTMLInputElement, "1");
    await tick();
    expect(root().getAttribute("data-state")).toBe("partial");

    paste(digits[0] as HTMLElement, "1234");
    await tick();
    expect(root().getAttribute("data-state")).toBe("complete");

    press(digits[3] as HTMLElement, "Backspace");
    await tick();
    expect(root().getAttribute("data-state")).toBe("partial");
  });

  it("empties every field and restarts entry on clear", async () => {
    const digits = fields();
    const changeHandler = listen("change");
    paste(digits[0] as HTMLElement, "1234");
    await tick();

    type(digits[0] as HTMLInputElement, "x"); // leave an error on screen
    await tick();
    expect(document.getElementById("error")?.hasAttribute("hidden")).toBe(false);

    const controller = application.getControllerForElementAndIdentifier(root(), "stimeo--otp");
    (controller as unknown as { clear(): void }).clear();
    await tick();

    expect(digits.map((field) => field.value)).toEqual(["", "", "", ""]);
    expect(digits.some((field) => field.hasAttribute("data-filled"))).toBe(false);
    expect(combined()).toBe("");
    expect(document.activeElement).toBe(digits[0]);
    expect(document.getElementById("error")?.hasAttribute("hidden")).toBe(true);
    expect(root().getAttribute("data-state")).toBe("empty");
    expect(changeHandler).toHaveBeenLastCalledWith(
      expect.objectContaining({ detail: { value: "" } }),
    );
  });

  it("redirects a pointer landing past the earliest empty field", async () => {
    const digits = fields();
    type(digits[0] as HTMLInputElement, "1");
    await tick();

    const event = new Event("pointerdown", { bubbles: true, cancelable: true });
    digits[3]?.dispatchEvent(event);
    await tick();

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(digits[1]); // the first empty field

    // A filled field stays directly reachable so a digit can be corrected
    const onFilled = new Event("pointerdown", { bubbles: true, cancelable: true });
    digits[0]?.dispatchEvent(onFilled);
    await tick();
    expect(onFilled.defaultPrevented).toBe(false);
  });

  it("leaves a pointer on the earliest empty field to the browser", async () => {
    const digits = fields();

    const event = new Event("pointerdown", { bubbles: true, cancelable: true });
    digits[0]?.dispatchEvent(event);
    await tick();

    expect(event.defaultPrevented).toBe(false); // already the right landing spot
  });

  it("never writes disabled or readonly fields", async () => {
    await remount({
      count: 4,
      fieldAttrs: (index) => (index === 2 ? "readonly" : ""),
    });
    const digits = fields();

    paste(digits[0] as HTMLElement, "5678");
    await tick();

    expect(digits.map((field) => field.value)).toEqual(["5", "6", "", "7"]);
    expect(document.activeElement).toBe(digits[3]);
    expect(combined()).toBe("567");

    // Auto-advance skips it as well
    digits[1]?.focus();
    type(digits[1] as HTMLInputElement, "9");
    await tick();
    expect(document.activeElement).toBe(digits[3]);
  });

  it("reads the fields back on connect", async () => {
    // A `type="password"` field returns from the Turbo cache emptied, and a
    // restored page keeps the hooks the previous entry wrote.
    document.body.innerHTML = markup();
    const stale = fields();
    (stale[0] as HTMLInputElement).setAttribute("data-filled", "true");
    (stale[1] as HTMLInputElement).value = "4";
    (document.getElementById("otp-value") as HTMLInputElement).value = "78";
    document.getElementById("error")?.removeAttribute("hidden");
    await tick();

    const digits = fields();
    expect(digits[0]?.hasAttribute("data-filled")).toBe(false); // empty field, no hook
    expect(digits[1]?.getAttribute("data-filled")).toBe("true"); // filled field, hook restored
    expect(combined()).toBe("4"); // hidden value re-derived from the DOM
    expect(document.getElementById("error")?.hasAttribute("hidden")).toBe(true);
    expect(root().getAttribute("data-state")).toBe("partial");
  });

  it("reconciles after a native form reset", async () => {
    await remount({ inForm: true });
    const digits = fields();

    paste(digits[0] as HTMLElement, "1234");
    await tick();
    expect(combined()).toBe("1234");

    // The reset restored the form's controls; nobody edited the passcode, so
    // the move is a reconciliation — not an edit.
    const editHandler = listen("change", "complete");
    const reconcileHandler = listen("reconcile");
    (document.getElementById("form") as HTMLFormElement).reset();
    await tick();

    expect(digits.every((field) => field.value === "")).toBe(true);
    expect(digits.some((field) => field.hasAttribute("data-filled"))).toBe(false);
    expect(combined()).toBe("");
    expect(root().getAttribute("data-state")).toBe("empty");
    expect(editHandler).not.toHaveBeenCalled();
    expect(reconcileHandler).toHaveBeenCalledOnce();
    expect(reconcileHandler.mock.calls[0]?.[0]?.detail).toEqual({ value: "" });
  });

  it("reports a reset that refills every field as a reconciliation, never a completion", async () => {
    // A completion is what makes a subscriber submit the code, and the page's
    // own defaults coming back are not a code the user entered.
    await remount({ inForm: true, fieldAttrs: (index) => `value="${index + 1}"` });
    const digits = fields();
    expect(root().getAttribute("data-state")).toBe("complete");
    press(digits[3] as HTMLElement, "Backspace");
    await tick();
    expect(combined()).toBe("123");

    const editHandler = listen("change", "complete");
    const reconcileHandler = listen("reconcile");
    (document.getElementById("form") as HTMLFormElement).reset();
    await tick();

    expect(combined()).toBe("1234");
    expect(root().getAttribute("data-state")).toBe("complete");
    expect(editHandler).not.toHaveBeenCalled();
    expect(reconcileHandler).toHaveBeenCalledOnce();
    expect(reconcileHandler.mock.calls[0]?.[0]?.detail).toEqual({ value: "1234" });
  });

  it("stays silent when a reset leaves the passcode where it was", async () => {
    await remount({ inForm: true });
    const handler = listen("change", "complete", "reconcile");
    (document.getElementById("form") as HTMLFormElement).reset();
    await tick();

    expect(combined()).toBe("");
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores a reset that another form owns", async () => {
    await remount({ inForm: true });
    document.body.insertAdjacentHTML("beforeend", '<form id="other"></form>');
    const digits = fields();

    paste(digits[0] as HTMLElement, "1234");
    type(digits[0] as HTMLInputElement, "z"); // leave an error on screen
    await tick();
    expect(document.getElementById("error")?.hasAttribute("hidden")).toBe(false);

    (document.getElementById("other") as HTMLFormElement).reset();
    await tick();

    expect(combined()).toBe("1234");
    expect(document.getElementById("error")?.hasAttribute("hidden")).toBe(false);
  });

  it("leaves the group alone when a reset is cancelled", async () => {
    await remount({ inForm: true });
    const form = document.getElementById("form") as HTMLFormElement;
    form.addEventListener("reset", (event) => event.preventDefault());
    const digits = fields();

    paste(digits[0] as HTMLElement, "1234");
    type(digits[0] as HTMLInputElement, "z");
    await tick();
    expect(document.getElementById("error")?.hasAttribute("hidden")).toBe(false);

    form.reset();
    await tick();

    expect(document.getElementById("error")?.hasAttribute("hidden")).toBe(false);
  });

  it("reconciles a reset for a group with no hidden value target", async () => {
    await remount({ inForm: true, withValue: false });
    const digits = fields();

    paste(digits[0] as HTMLElement, "1234");
    await tick();
    expect(digits[3]?.getAttribute("data-filled")).toBe("true");

    (document.getElementById("form") as HTMLFormElement).reset();
    await tick();

    expect(digits.some((field) => field.hasAttribute("data-filled"))).toBe(false);
    expect(root().getAttribute("data-state")).toBe("empty");
  });

  it("gives the error surface back when the form it belongs to is reset", async () => {
    await remount({
      inForm: true,
      fieldAttrs: (index) => (index === 0 ? 'aria-describedby="hint"' : ""),
    });
    const first = fields()[0] as HTMLInputElement;
    type(first, "あ");
    await tick();
    expect(first.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById("error")?.hidden).toBe(false);

    (document.getElementById("form") as HTMLFormElement).reset();
    await tick();

    // Nothing is rejected in a form that was just reset.
    expect(first.hasAttribute("aria-invalid")).toBe(false);
    expect(first.hasAttribute("aria-errormessage")).toBe(false);
    expect(first.getAttribute("aria-describedby")).toBe("hint");
    expect(document.getElementById("error")?.hidden).toBe(true);
  });

  it("drops a reset reconciliation the group disconnected before", async () => {
    await remount({ inForm: true });
    const digits = fields();

    paste(digits[0] as HTMLElement, "1234");
    await tick();

    const controller = application.getControllerForElementAndIdentifier(root(), "stimeo--otp");
    (document.getElementById("form") as HTMLFormElement).reset();
    (controller as unknown as { disconnect(): void }).disconnect();
    root().setAttribute("data-state", "sentinel");

    await tick();

    expect(root().getAttribute("data-state")).toBe("sentinel");
  });

  // --- Machine-detectable a11y ---

  it("has no machine-detectable a11y violations", async () => {
    await expectNoA11yViolations(root());
  });

  it("has no machine-detectable a11y violations while reporting an error", async () => {
    type(fields()[0] as HTMLInputElement, "あ");
    await tick();
    await expectNoA11yViolations(root());
  });

  // --- Speech order ---

  it("announces group and field roles/names in order", async () => {
    const phrases = await captureSpeech({ container: root(), steps: 5 });
    expect(phrases).toEqual([
      "group, PIN passcode",
      "textbox, Digit 1",
      "textbox, Digit 2",
      "textbox, Digit 3",
      "textbox, Digit 4",
      "end of group, PIN passcode",
    ]);
  });

  // --- Disconnect teardown ---

  it("properly disconnects all per-field listeners without errors", async () => {
    const digits = fields();
    for (const field of digits) {
      field.value = "1";
      field.setAttribute("data-filled", "true");
    }

    const controller = application.getControllerForElementAndIdentifier(root(), "stimeo--otp");
    if (!controller) throw new Error("otp controller not found");

    const firstField = digits[0] as HTMLInputElement;
    const selectSpy = vi.spyOn(firstField, "select");
    const changeHandler = listen("change");
    try {
      controller.disconnect();

      // After disconnect, focus should not trigger auto-select (listener removed)
      firstField.focus();
      expect(selectSpy).not.toHaveBeenCalled();

      // …and the composition listeners are gone with it
      firstField.dispatchEvent(new Event("compositionstart", { bubbles: true }));
      firstField.value = "９";
      firstField.dispatchEvent(new Event("compositionend", { bubbles: true }));
      expect(firstField.value).toBe("９"); // never normalized
      expect(changeHandler).not.toHaveBeenCalled();
    } finally {
      selectSpy.mockRestore();
    }
  });

  it("returns the error leases on disconnect", async () => {
    const digits = fields();
    type(digits[0] as HTMLInputElement, "あ");
    await tick();
    expect(document.getElementById("error")?.hasAttribute("hidden")).toBe(false);

    const controller = application.getControllerForElementAndIdentifier(root(), "stimeo--otp");
    controller?.disconnect();

    expect(document.getElementById("error")?.getAttribute("hidden")).toBe("");
    expect(digits.some((field) => field.hasAttribute("aria-invalid"))).toBe(false);
    expect(root().hasAttribute("data-state")).toBe(false);
  });

  it("returns the error leases before the page is cached", async () => {
    const digits = fields();
    type(digits[0] as HTMLInputElement, "あ");
    await tick();

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(document.getElementById("error")?.getAttribute("hidden")).toBe("");
    expect(digits.some((field) => field.hasAttribute("aria-errormessage"))).toBe(false);
  });

  it("returns the error leases of an input that stops being a field", async () => {
    await remount({ fieldAttrs: (index) => (index === 0 ? 'aria-describedby="hint"' : "") });
    const digits = fields();
    const first = digits[0] as HTMLInputElement;
    type(first, "あ");
    await tick();
    expect(first.getAttribute("aria-describedby")).toBe("hint error");

    // A morph can drop the target token and leave the input in the page.
    first.removeAttribute("data-stimeo--otp-target");
    await tick();

    expect(first.getAttribute("aria-describedby")).toBe("hint");
    expect(first.hasAttribute("aria-invalid")).toBe(false);
    expect(first.hasAttribute("aria-errormessage")).toBe(false);
    expect(first.hasAttribute("data-otp-describedby-lease")).toBe(false);
    // The error still stands on the fields that remain.
    expect(digits[1]?.getAttribute("aria-invalid")).toBe("true");
  });
});
