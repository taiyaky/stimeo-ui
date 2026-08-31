import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnnouncerController } from "../src/controllers/announcer_controller";
import { ClipboardController } from "../src/controllers/clipboard_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { delay, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ClipboardController}: copy execution against a
 * mocked Clipboard API, success/failure `data-state`, the visible completion slot
 * and its auto-clear, the shared-announcer messages, the `copy` event on both
 * paths, transient-state normalisation on connect and before the Turbo snapshot,
 * and teardown while a copy is still in flight.
 */

const ANNOUNCER = `
  <div data-controller="stimeo--announcer">
    <div id="cb-announcer" data-stimeo--announcer-target="polite"
         aria-live="polite" aria-atomic="true"></div>
  </div>`;

describe("ClipboardController", () => {
  let application: Application;
  let writeText: ReturnType<typeof vi.fn>;
  let announcements: string[] = [];

  const onAnnouncement = (event: Event): void => {
    announcements.push((event as CustomEvent<{ message: string }>).detail.message);
  };

  const mount = async (markup: string) => {
    document.body.innerHTML = `${markup}${ANNOUNCER}`;
    application = Application.start();
    application.register("stimeo--clipboard", ClipboardController);
    application.register("stimeo--announcer", AnnouncerController);
    await tick();
  };

  const start = async (extraAttrs = "") =>
    mount(`
      <div data-controller="stimeo--clipboard" ${extraAttrs}>
        <input type="text" aria-label="Share link" value="https://example.com/abc" readonly
               data-stimeo--clipboard-target="source">
        <button type="button" data-stimeo--clipboard-target="button"
                data-action="stimeo--clipboard#copy">Copy</button>
        <span data-stimeo--clipboard-target="feedback"></span>
      </div>`);

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    announcements = [];
    window.addEventListener("stimeo--announcer:announce", onAnnouncement);
  });

  afterEach(() => {
    window.removeEventListener("stimeo--announcer:announce", onAnnouncement);
    disconnectAndStopApplication(application);
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

  it("shows the authored labels instead of the defaults", async () => {
    await start(
      'data-stimeo--clipboard-copied-label-value="コピーしました" ' +
        'data-stimeo--clipboard-error-label-value="コピーできません"',
    );
    await instance().copy();
    expect(feedback().textContent).toBe("コピーしました");

    writeText.mockRejectedValueOnce(new Error("denied"));
    await instance().copy();
    expect(feedback().textContent).toBe("コピーできません");
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

  it("dispatches a copy event carrying the failure and the text", async () => {
    await start();
    let detail: { success: boolean; text: string } | null = null;
    controllerEl().addEventListener("stimeo--clipboard:copy", (event) => {
      detail = (event as CustomEvent<{ success: boolean; text: string }>).detail;
    });
    writeText.mockRejectedValueOnce(new Error("denied"));
    await instance().copy();
    expect(detail).toEqual({ success: false, text: "https://example.com/abc" });
  });

  it("auto-clears the completion slot after feedbackDuration", async () => {
    await start('data-stimeo--clipboard-feedback-duration-value="20"');
    await instance().copy();
    expect(controllerEl().getAttribute("data-state")).toBe("copied");
    await delay(40);
    expect(controllerEl().getAttribute("data-state")).toBe("idle");
    expect(feedback().textContent).toBe("");
  });

  it("auto-clears the failure state on the same window", async () => {
    await start('data-stimeo--clipboard-feedback-duration-value="20"');
    writeText.mockRejectedValueOnce(new Error("denied"));
    await instance().copy();
    expect(controllerEl().getAttribute("data-state")).toBe("error");
    await delay(40);
    expect(controllerEl().getAttribute("data-state")).toBe("idle");
    expect(feedback().textContent).toBe("");
  });

  it("defaults feedbackDuration to 2000ms", async () => {
    await start();
    expect(instance().feedbackDurationValue).toBe(2000);
  });

  it("has no machine-detectable a11y violations in either state", async () => {
    await start();
    await expectNoA11yViolations(document.body, { rules: { region: { enabled: false } } });
    await instance().copy();
    await expectNoA11yViolations(document.body, { rules: { region: { enabled: false } } });
  });

  it("announces the completion through the shared announcer", async () => {
    await start('data-stimeo--clipboard-announce-copied-text-value="Copied to clipboard"');
    await instance().copy();
    expect(announcements).toEqual(["Copied to clipboard"]);
    // The announcer drains one queued message per task; read the region after it lands.
    await delay(20);
    const spoken = await captureSpeech({ container: query("#cb-announcer"), steps: 0 });
    expect(spoken).toEqual(["Copied to clipboard"]);
  });

  it("announces the failure text when the copy fails", async () => {
    await start('data-stimeo--clipboard-announce-error-text-value="Copy failed"');
    writeText.mockRejectedValueOnce(new Error("denied"));
    await instance().copy();
    expect(announcements).toEqual(["Copy failed"]);
  });

  it("announces nothing when no announce text is authored", async () => {
    await start();
    await instance().copy();
    writeText.mockRejectedValueOnce(new Error("denied"));
    await instance().copy();
    expect(announcements).toEqual([]);
  });

  it("re-announces an identical notice on a repeat copy inside the window", async () => {
    await start('data-stimeo--clipboard-announce-copied-text-value="Copied"');
    const region = query("#cb-announcer");
    const written: string[] = [];
    const observer = new MutationObserver(() => written.push(region.textContent ?? ""));
    observer.observe(region, { childList: true, characterData: true, subtree: true });

    await instance().copy();
    await instance().copy();
    // The announcer empties the region between two identical messages, because an
    // unchanged node is not re-read. Landing, clearing and re-setting are three
    // dependent tasks, each armed only when the previous one runs, so the wait is
    // on the observable end state.
    await vi.waitFor(() => {
      expect(written).toContain("");
      expect(region.textContent).toBe("Copied");
    });
    observer.disconnect();

    // The controller reports both attempts.
    expect(announcements).toEqual(["Copied", "Copied"]);
  });

  it("normalises a restored transient state on connect", async () => {
    await mount(`
      <div data-controller="stimeo--clipboard" data-state="copied">
        <button data-stimeo--clipboard-target="button"
                data-action="stimeo--clipboard#copy">Copy</button>
        <span data-stimeo--clipboard-target="feedback">Copied</span>
      </div>`);
    expect(controllerEl().getAttribute("data-state")).toBe("idle");
    expect(feedback().textContent).toBe("");
  });

  it("normalises a restored error state on connect", async () => {
    await mount(`
      <div data-controller="stimeo--clipboard" data-state="error">
        <button data-stimeo--clipboard-target="button"
                data-action="stimeo--clipboard#copy">Copy</button>
        <span data-stimeo--clipboard-target="feedback">Copy failed</span>
      </div>`);
    expect(controllerEl().getAttribute("data-state")).toBe("idle");
    expect(feedback().textContent).toBe("");
  });

  it("preserves an authored data-state the controller does not own", async () => {
    await mount(`
      <div data-controller="stimeo--clipboard" data-state="disabled">
        <button data-stimeo--clipboard-target="button"
                data-action="stimeo--clipboard#copy">Copy</button>
        <span data-stimeo--clipboard-target="feedback">held</span>
      </div>`);
    expect(controllerEl().getAttribute("data-state")).toBe("disabled");
    expect(feedback().textContent).toBe("held");
  });

  it("rewinds the completion state before Turbo caches the page", async () => {
    await start();
    await instance().copy();
    expect(controllerEl().getAttribute("data-state")).toBe("copied");

    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(controllerEl().getAttribute("data-state")).toBe("idle");
    expect(feedback().textContent).toBe("");
  });

  it("leaves an authored data-state the controller does not own out of the rewind", async () => {
    await mount(`
      <div data-controller="stimeo--clipboard" data-state="disabled">
        <button data-stimeo--clipboard-target="button"
                data-action="stimeo--clipboard#copy">Copy</button>
        <span data-stimeo--clipboard-target="feedback">held</span>
      </div>`);
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(controllerEl().getAttribute("data-state")).toBe("disabled");
    expect(feedback().textContent).toBe("held");
  });

  it("does not dispatch copy from the before-cache rewind", async () => {
    await start();
    await instance().copy();
    let fired = 0;
    controllerEl().addEventListener("stimeo--clipboard:copy", () => {
      fired += 1;
    });
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(fired).toBe(0);
  });

  it("stops rewinding once disconnected", async () => {
    await start();
    await instance().copy();
    const element = controllerEl();
    instance().disconnect();
    element.setAttribute("data-state", "copied");
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(element.getAttribute("data-state")).toBe("copied");
  });

  it("copies a textarea's value", async () => {
    await mount(`
      <div data-controller="stimeo--clipboard">
        <textarea data-stimeo--clipboard-target="source">multi\nline</textarea>
        <button data-stimeo--clipboard-target="button"
                data-action="stimeo--clipboard#copy">Copy</button>
        <span data-stimeo--clipboard-target="feedback"></span>
      </div>`);
    await instance().copy();
    expect(writeText).toHaveBeenCalledWith("multi\nline");
  });

  it("copies a non-input source's text content", async () => {
    await mount(`
      <div data-controller="stimeo--clipboard">
        <code data-stimeo--clipboard-target="source">npm i stimeo-ui</code>
        <button data-stimeo--clipboard-target="button"
                data-action="stimeo--clipboard#copy">Copy</button>
        <span data-stimeo--clipboard-target="feedback"></span>
      </div>`);
    await instance().copy();
    expect(writeText).toHaveBeenCalledWith("npm i stimeo-ui");
  });

  it("copies an empty string when neither text value nor source is present", async () => {
    await mount(`
      <div data-controller="stimeo--clipboard">
        <button data-stimeo--clipboard-target="button"
                data-action="stimeo--clipboard#copy">Copy</button>
        <span data-stimeo--clipboard-target="feedback"></span>
      </div>`);
    await instance().copy();
    expect(writeText).toHaveBeenCalledWith("");
    expect(controllerEl().getAttribute("data-state")).toBe("copied");
  });

  it("still reflects state when no feedback target is present", async () => {
    await mount(`
      <div data-controller="stimeo--clipboard">
        <input data-stimeo--clipboard-target="source" value="x">
        <button data-stimeo--clipboard-target="button"
                data-action="stimeo--clipboard#copy">Copy</button>
      </div>`);
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

  it("reports nothing when the copy resolves after disconnect", async () => {
    let resolveWrite!: () => void;
    writeText.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    await start(
      'data-stimeo--clipboard-feedback-duration-value="20" ' +
        'data-stimeo--clipboard-announce-copied-text-value="Copied"',
    );
    const controller = instance();
    const element = controllerEl();
    const fb = feedback();
    let fired = 0;
    element.addEventListener("stimeo--clipboard:copy", () => {
      fired += 1;
    });

    const pending = controller.copy();
    controller.disconnect();
    resolveWrite();
    await pending;

    expect(element.getAttribute("data-state")).toBe("idle");
    expect(fired).toBe(0);
    expect(announcements).toEqual([]);

    // No timer may have been armed past the clearAll that disconnect ran.
    fb.textContent = "sentinel";
    await delay(40);
    expect(fb.textContent).toBe("sentinel");
  });
});
