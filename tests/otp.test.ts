import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OtpController } from "../src/controllers/otp_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("OtpController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div id="otp" data-controller="stimeo--otp"
           data-stimeo--otp-length-value="4"
           data-stimeo--otp-pattern-value="[0-9]"
           role="group" aria-label="PIN passcode">
        <input class="field" data-stimeo--otp-target="field" aria-label="Digit 1"
               inputmode="numeric" maxlength="1"
               data-action="input->stimeo--otp#onInput
                            keydown->stimeo--otp#onKeydown
                            paste->stimeo--otp#onPaste" />
        <input class="field" data-stimeo--otp-target="field" aria-label="Digit 2"
               inputmode="numeric" maxlength="1"
               data-action="input->stimeo--otp#onInput
                            keydown->stimeo--otp#onKeydown
                            paste->stimeo--otp#onPaste" />
        <input class="field" data-stimeo--otp-target="field" aria-label="Digit 3"
               inputmode="numeric" maxlength="1"
               data-action="input->stimeo--otp#onInput
                            keydown->stimeo--otp#onKeydown
                            paste->stimeo--otp#onPaste" />
        <input class="field" data-stimeo--otp-target="field" aria-label="Digit 4"
               inputmode="numeric" maxlength="1"
               data-action="input->stimeo--otp#onInput
                            keydown->stimeo--otp#onKeydown
                            paste->stimeo--otp#onPaste" />
        <div id="error" data-stimeo--otp-target="error" hidden>Error</div>
        <input type="hidden" id="otp-value" data-stimeo--otp-target="value" name="otp" />
      </div>
    `;

    application = Application.start();
    application.register("stimeo--otp", OtpController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  it("auto-advances focus upon valid numeric inputs and filters letters", async () => {
    const fields = document.querySelectorAll(".field") as NodeListOf<HTMLInputElement>;
    const valueEl = document.getElementById("otp-value") as HTMLInputElement;

    expect(fields).toHaveLength(4);
    fields[0]?.focus();
    expect(document.activeElement).toBe(fields[0]);

    // Input a valid digit "5"
    (fields[0] as HTMLInputElement).value = "5";
    fields[0]?.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    expect(fields[0]?.getAttribute("data-filled")).toBe("true");
    expect(document.activeElement).toBe(fields[1]); // should auto-focus next field
    expect(valueEl.value).toBe("5");

    // Input an invalid character "A" on the second field
    (fields[1] as HTMLInputElement).value = "A";
    fields[1]?.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    expect(fields[1]?.value).toBe(""); // should be cleared by the filter pattern
    expect(fields[1]?.getAttribute("data-filled")).toBeNull();
    expect(document.activeElement).toBe(fields[1]); // focus should remain
    expect(valueEl.value).toBe("5");
  });

  it("auto-selects digit on focus for seamless overwrites", async () => {
    const fields = document.querySelectorAll(".field") as NodeListOf<HTMLInputElement>;
    const input = fields[0] as HTMLInputElement;
    input.value = "9";
    input.setAttribute("data-filled", "true");

    const selectSpy = vi.spyOn(input, "select");

    input.focus();
    await tick();

    expect(selectSpy).toHaveBeenCalledOnce();
  });

  it("handles Backspace retreating properly", async () => {
    const fields = document.querySelectorAll(".field") as NodeListOf<HTMLInputElement>;
    const valueEl = document.getElementById("otp-value") as HTMLInputElement;

    // Fill first field and move to second
    (fields[0] as HTMLInputElement).value = "1";
    (fields[0] as HTMLInputElement).setAttribute("data-filled", "true");
    (fields[1] as HTMLInputElement).focus();
    await tick();

    expect(document.activeElement).toBe(fields[1]);
    expect(fields[1]?.value).toBe("");

    // Press Backspace on empty second field. Focus should step back to the first field, and wipe it.
    const backspace = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true });
    fields[1]?.dispatchEvent(backspace);
    await tick();

    expect(document.activeElement).toBe(fields[0]);
    expect(fields[0]?.value).toBe("");
    expect(fields[0]?.getAttribute("data-filled")).toBeNull();
    expect(valueEl.value).toBe("");
  });

  it("handles ArrowKeys and Home/End focus stepping", async () => {
    const fields = document.querySelectorAll(".field") as NodeListOf<HTMLInputElement>;

    fields[0]?.focus();

    // ArrowRight to index 1
    const right = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true });
    fields[0]?.dispatchEvent(right);
    await tick();
    expect(document.activeElement).toBe(fields[1]);

    // End to index 3
    const end = new KeyboardEvent("keydown", { key: "End", bubbles: true });
    fields[1]?.dispatchEvent(end);
    await tick();
    expect(document.activeElement).toBe(fields[3]);

    // ArrowLeft to index 2
    const left = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true });
    fields[3]?.dispatchEvent(left);
    await tick();
    expect(document.activeElement).toBe(fields[2]);

    // Home to index 0
    const home = new KeyboardEvent("keydown", { key: "Home", bubbles: true });
    fields[2]?.dispatchEvent(home);
    await tick();
    expect(document.activeElement).toBe(fields[0]);
  });

  it("intercepts Paste, divides numeric characters, and triggers complete event", async () => {
    const fields = document.querySelectorAll(".field") as NodeListOf<HTMLInputElement>;
    const valueEl = document.getElementById("otp-value") as HTMLInputElement;
    const otpContainer = document.getElementById("otp");

    const completeHandler = vi.fn();
    otpContainer?.addEventListener("stimeo--otp:complete", completeHandler);

    fields[0]?.focus();

    // Simulate paste with text containing digits and letters: "A-83d7" -> digits: "837"
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text", "A-83d7");
    const pasteEvent = new ClipboardEvent("paste", {
      clipboardData: dataTransfer,
      bubbles: true,
      cancelable: true,
    });

    fields[0]?.dispatchEvent(pasteEvent);
    await tick();

    // Shard check:
    expect(fields[0]?.value).toBe("8");
    expect(fields[1]?.value).toBe("3");
    expect(fields[2]?.value).toBe("7");
    expect(fields[3]?.value).toBe(""); // 4th is still empty since we only had 3 digits

    expect(document.activeElement).toBe(fields[3]); // focus target index = last filled + 1 = 3
    expect(valueEl.value).toBe("837");
    expect(completeHandler).not.toHaveBeenCalled();

    // Now fill the last digit to trigger complete
    (fields[3] as HTMLInputElement).value = "2";
    fields[3]?.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    expect(valueEl.value).toBe("8372");
    expect(completeHandler).toHaveBeenCalledOnce();
    expect(completeHandler.mock.calls[0]?.[0]?.detail).toEqual({ value: "8372" });
  });

  it("auto-normalizes full-width digits to half-width numbers", async () => {
    const fields = document.querySelectorAll(".field") as NodeListOf<HTMLInputElement>;
    const valueEl = document.getElementById("otp-value") as HTMLInputElement;

    fields[0]?.focus();

    // Input full-width digit "３"
    (fields[0] as HTMLInputElement).value = "３";
    fields[0]?.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    expect(fields[0]?.value).toBe("3"); // auto-converted to "3"
    expect(fields[0]?.getAttribute("data-filled")).toBe("true");
    expect(document.activeElement).toBe(fields[1]); // stepped forward
    expect(valueEl.value).toBe("3");
  });

  it("shows dynamic error validation message on invalid input", async () => {
    const fields = document.querySelectorAll(".field") as NodeListOf<HTMLInputElement>;
    const errorEl = document.getElementById("error") as HTMLElement;

    fields[0]?.focus();
    expect(errorEl.hasAttribute("hidden")).toBe(true);

    // Input invalid kana "あ"
    (fields[0] as HTMLInputElement).value = "あ";
    fields[0]?.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    expect(fields[0]?.value).toBe(""); // cleared
    expect(errorEl.hasAttribute("hidden")).toBe(false); // warning visible
    expect(errorEl.getAttribute("hidden")).toBeNull();

    // Correcting it to "7" should clear the error message
    (fields[0] as HTMLInputElement).value = "7";
    fields[0]?.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    expect(fields[0]?.value).toBe("7");
    expect(errorEl.hasAttribute("hidden")).toBe(true);
  });

  it("guards auto-advance processing during active IME composition and triggers on end", async () => {
    const fields = document.querySelectorAll(".field") as NodeListOf<HTMLInputElement>;

    fields[0]?.focus();

    // Simulate compositionstart
    fields[0]?.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    await tick();

    // Simulate input while composing (e.g. typing hiragana "う")
    (fields[0] as HTMLInputElement).value = "う";
    fields[0]?.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    // Focus should remain and value should not be validated/cleared yet
    expect(document.activeElement).toBe(fields[0]);
    expect((fields[0] as HTMLInputElement).value).toBe("う");

    // Simulate compositionend with a full-width digit "９" (resolved from conversion)
    (fields[0] as HTMLInputElement).value = "９";
    fields[0]?.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await tick();

    // Focus should step to index 1, and value should be normalized to half-width "9"
    expect(fields[0]?.value).toBe("9");
    expect(document.activeElement).toBe(fields[1]);
  });

  // --- Layer ① machine a11y ---

  it("has no machine-detectable a11y violations", async () => {
    const root = document.getElementById("otp") as HTMLElement;
    await expectNoA11yViolations(root);
  });

  // --- Layer ③ speech-order regression ---

  it("announces group and field roles/names in order", async () => {
    const root = document.getElementById("otp") as HTMLElement;
    const phrases = await captureSpeech({ container: root, steps: 5 });
    expect(phrases).toEqual([
      "group, PIN passcode",
      "textbox, Digit 1",
      "textbox, Digit 2",
      "textbox, Digit 3",
      "textbox, Digit 4",
      "end of group, PIN passcode",
    ]);
  });

  // --- Disconnect teardown regression ---

  it("properly disconnects all per-field listeners without errors", async () => {
    const fields = document.querySelectorAll(".field") as NodeListOf<HTMLInputElement>;
    for (const field of fields) {
      field.value = "1";
      field.setAttribute("data-filled", "true");
    }

    const root = document.querySelector("[data-controller='stimeo--otp']") as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(root, "stimeo--otp");
    if (!controller) throw new Error("otp controller not found");

    const firstField = document.querySelector("input");
    if (!firstField) throw new Error("First field not found");

    // Spy on select() to verify focus listener does not call it after disconnect
    const selectSpy = vi.spyOn(firstField, "select");
    try {
      controller.disconnect();

      // After disconnect, focus should not trigger auto-select (listener removed)
      firstField.focus();
      expect(selectSpy).not.toHaveBeenCalled();
    } finally {
      selectSpy.mockRestore();
    }
  });
});
