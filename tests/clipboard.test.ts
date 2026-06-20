import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipboardController } from "../src/controllers/clipboard_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link ClipboardController}: copy execution against a
 * mocked Clipboard API, success/failure `data-state`, the live-region notice,
 * its auto-clear, and the `copy` event.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ClipboardController", () => {
  let application: Application;
  let writeText: ReturnType<typeof vi.fn>;

  const start = async (extraAttrs = "") => {
    document.body.innerHTML = `
      <div data-controller="stimeo--clipboard" ${extraAttrs}>
        <input type="text" aria-label="Share link" value="https://example.com/abc" readonly
               data-stimeo--clipboard-target="source">
        <button type="button" data-stimeo--clipboard-target="button"
                data-action="stimeo--clipboard#copy">Copy</button>
        <span role="status" aria-live="polite"
              data-stimeo--clipboard-target="feedback"></span>
      </div>`;
    application = Application.start();
    application.register("stimeo--clipboard", ClipboardController);
    await tick();
  };

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const controllerEl = () => query("[data-controller='stimeo--clipboard']");
  const feedback = () => query("[data-stimeo--clipboard-target='feedback']");
  const instance = () =>
    application.getControllerForElementAndIdentifier(
      controllerEl(),
      "stimeo--clipboard",
    ) as ClipboardController;

  it("starts idle", async () => {
    await start();
    expect(controllerEl().getAttribute("data-state")).toBe("idle");
  });

  it("copies the source value and reports success", async () => {
    await start();
    await instance().copy();
    expect(writeText).toHaveBeenCalledWith("https://example.com/abc");
    expect(controllerEl().getAttribute("data-state")).toBe("copied");
    expect(feedback().textContent).toBe("Copied");
  });

  it("prefers the explicit text value over the source", async () => {
    await start('data-stimeo--clipboard-text-value="OVERRIDE"');
    await instance().copy();
    expect(writeText).toHaveBeenCalledWith("OVERRIDE");
  });

  it("reports failure when the Clipboard API rejects", async () => {
    await start();
    writeText.mockRejectedValueOnce(new Error("denied"));
    await instance().copy();
    expect(controllerEl().getAttribute("data-state")).toBe("error");
    expect(feedback().textContent).toBe("Copy failed");
  });

  it("dispatches a copy event carrying success and the text", async () => {
    await start();
    let detail: { success: boolean; text: string } | null = null;
    controllerEl().addEventListener("stimeo--clipboard:copy", (event) => {
      detail = (event as CustomEvent<{ success: boolean; text: string }>).detail;
    });
    await instance().copy();
    expect(detail).toEqual({ success: true, text: "https://example.com/abc" });
  });

  it("auto-clears the completion notice after feedbackDuration", async () => {
    await start('data-stimeo--clipboard-feedback-duration-value="20"');
    await instance().copy();
    expect(controllerEl().getAttribute("data-state")).toBe("copied");
    await delay(40);
    expect(controllerEl().getAttribute("data-state")).toBe("idle");
    expect(feedback().textContent).toBe("");
  });

  it("has no machine-detectable a11y violations in either state", async () => {
    await start();
    await expectNoA11yViolations(document.body, { rules: { region: { enabled: false } } });
    await instance().copy();
    await expectNoA11yViolations(document.body, { rules: { region: { enabled: false } } });
  });

  it("announces the completion notice through the live region", async () => {
    await start();
    await instance().copy();
    const spoken = await captureSpeech({ container: feedback(), steps: 1 });
    expect(spoken).toEqual(["status", "Copied"]);
  });

  it("preserves an existing data-state on connect", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--clipboard" data-state="copied">
        <button data-stimeo--clipboard-target="button"
                data-action="stimeo--clipboard#copy">Copy</button>
        <span role="status" data-stimeo--clipboard-target="feedback">Copied</span>
      </div>`;
    application = Application.start();
    application.register("stimeo--clipboard", ClipboardController);
    await tick();
    expect(controllerEl().getAttribute("data-state")).toBe("copied");
  });

  it("copies a textarea's value", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--clipboard">
        <textarea data-stimeo--clipboard-target="source">multi\nline</textarea>
        <button data-stimeo--clipboard-target="button"
                data-action="stimeo--clipboard#copy">Copy</button>
        <span role="status" data-stimeo--clipboard-target="feedback"></span>
      </div>`;
    application = Application.start();
    application.register("stimeo--clipboard", ClipboardController);
    await tick();
    await instance().copy();
    expect(writeText).toHaveBeenCalledWith("multi\nline");
  });

  it("copies a non-input source's text content", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--clipboard">
        <code data-stimeo--clipboard-target="source">npm i stimeo-ui</code>
        <button data-stimeo--clipboard-target="button"
                data-action="stimeo--clipboard#copy">Copy</button>
        <span role="status" data-stimeo--clipboard-target="feedback"></span>
      </div>`;
    application = Application.start();
    application.register("stimeo--clipboard", ClipboardController);
    await tick();
    await instance().copy();
    expect(writeText).toHaveBeenCalledWith("npm i stimeo-ui");
  });

  it("copies an empty string when neither text value nor source is present", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--clipboard">
        <button data-stimeo--clipboard-target="button"
                data-action="stimeo--clipboard#copy">Copy</button>
        <span role="status" data-stimeo--clipboard-target="feedback"></span>
      </div>`;
    application = Application.start();
    application.register("stimeo--clipboard", ClipboardController);
    await tick();
    await instance().copy();
    expect(writeText).toHaveBeenCalledWith("");
    expect(controllerEl().getAttribute("data-state")).toBe("copied");
  });

  it("still reflects state when no feedback target is present", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--clipboard">
        <input data-stimeo--clipboard-target="source" value="x">
        <button data-stimeo--clipboard-target="button"
                data-action="stimeo--clipboard#copy">Copy</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--clipboard", ClipboardController);
    await tick();
    await instance().copy();
    expect(controllerEl().getAttribute("data-state")).toBe("copied");
  });

  it("reports failure when the Clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    await start();
    await instance().copy();
    expect(controllerEl().getAttribute("data-state")).toBe("error");
  });

  it("does not auto-clear when feedbackDuration is 0", async () => {
    await start('data-stimeo--clipboard-feedback-duration-value="0"');
    await instance().copy();
    await delay(20);
    expect(controllerEl().getAttribute("data-state")).toBe("copied");
    expect(feedback().textContent).toBe("Copied");
  });

  it("restarts the auto-clear window on a second copy (cancels the stale timer)", async () => {
    await start('data-stimeo--clipboard-feedback-duration-value="50"');
    await instance().copy();
    await delay(30);
    // Second copy ~30ms in must restart the window, not let the first timer fire.
    await instance().copy();
    await delay(30); // 60ms since first copy, 30ms since second
    expect(controllerEl().getAttribute("data-state")).toBe("copied");
    await delay(40); // now past the second window
    expect(controllerEl().getAttribute("data-state")).toBe("idle");
  });

  // Detaching the element drives Stimulus `disconnect()`, where SafeTimeout's
  // clearAll cancels the pending reset (`application.stop()` alone would not
  // disconnect the controller).
  it("clears the auto-reset timer on disconnect (no mutation after teardown)", async () => {
    await start('data-stimeo--clipboard-feedback-duration-value="20"');
    await instance().copy();
    const fb = feedback();

    // Drive disconnect() directly rather than via element removal: relying on the
    // async MutationObserver that fires disconnect on remove() races the 20ms timer
    // under parallel load. disconnect() must cancel the pending auto-reset timer.
    instance().disconnect();
    fb.textContent = "sentinel";
    await delay(40);
    // The cancelled timer must not have reset the feedback back to "".
    expect(fb.textContent).toBe("sentinel");
  });
});
