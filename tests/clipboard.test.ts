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
 * teardown while a copy is still in flight, and the labels a shown result follows.
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

  /** The detail of the next `copy`, captured before the attempt runs. */
  const copyDetail = (): { current: Record<string, unknown> | null } => {
    const seen: { current: Record<string, unknown> | null } = { current: null };
    controllerEl().addEventListener("stimeo--clipboard:copy", (event) => {
      seen.current = (event as CustomEvent<Record<string, unknown>>).detail;
    });
    return seen;
  };

  it("dispatches a copy event carrying success, the text, and the wording", async () => {
    await start();
    const detail = copyDetail();
    await instance().copy();
    expect(detail.current).toEqual({
      success: true,
      text: "https://example.com/abc",
      message: "Copied",
    });
  });

  it("dispatches a copy event carrying the failure, the text, and the wording", async () => {
    await start();
    const detail = copyDetail();
    writeText.mockRejectedValueOnce(new Error("denied"));
    await instance().copy();
    expect(detail.current).toEqual({
      success: false,
      text: "https://example.com/abc",
      message: "Copy failed",
    });
  });

  // The wording a consumer authored is what a listening part shows, so the
  // detail carries the authored value rather than the built-in default.
  it("carries the authored labels in the copy detail", async () => {
    await start(
      'data-stimeo--clipboard-copied-label-value="コピーしました" ' +
        'data-stimeo--clipboard-error-label-value="コピーできません"',
    );
    const detail = copyDetail();
    await instance().copy();
    expect(detail.current?.message).toBe("コピーしました");

    writeText.mockRejectedValueOnce(new Error("denied"));
    await instance().copy();
    expect(detail.current?.message).toBe("コピーできません");
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

  /** Runs one copy that succeeds or, with `fails`, one the Clipboard API rejects. */
  const copyOnce = async (fails: boolean): Promise<void> => {
    if (fails) writeText.mockRejectedValueOnce(new Error("denied"));
    await instance().copy();
  };

  /** Counts the `copy` events dispatched from now on. */
  const countCopies = (): { count: number } => {
    const seen = { count: 0 };
    controllerEl().addEventListener("stimeo--clipboard:copy", () => {
      seen.count += 1;
    });
    return seen;
  };

  describe.each([
    {
      state: "copied",
      attribute: "data-stimeo--clipboard-copied-label-value",
      label: "Copied",
      other: "data-stimeo--clipboard-error-label-value",
      fails: false,
    },
    {
      state: "error",
      attribute: "data-stimeo--clipboard-error-label-value",
      label: "Copy failed",
      other: "data-stimeo--clipboard-copied-label-value",
      fails: true,
    },
  ])(
    "a label swapped while the $state result is shown",
    ({ state, attribute, label, other, fails }) => {
      it("rewrites the slot without announcing or dispatching", async () => {
        await start(
          'data-stimeo--clipboard-feedback-duration-value="0" ' +
            'data-stimeo--clipboard-announce-copied-text-value="Copied to clipboard" ' +
            'data-stimeo--clipboard-announce-error-text-value="Copy failed"',
        );
        await copyOnce(fails);
        expect(feedback().textContent).toBe(label);
        const spoken = [...announcements];
        expect(spoken).toHaveLength(1);
        const copies = countCopies();

        // A morph keeps the element and swaps the attribute, so connect() does not run
        // again: with `feedbackDuration` 0 nothing else would ever replace the wording.
        controllerEl().setAttribute(attribute, "Swapped");
        await tick();
        expect(feedback().textContent).toBe("Swapped");
        expect(controllerEl().getAttribute("data-state")).toBe(state);
        // Following the label is a repaint: the result is neither read out nor reported again.
        expect(announcements).toEqual(spoken);
        expect(copies.count).toBe(0);

        // Without the attribute the default label is in force, and the slot follows it back.
        controllerEl().removeAttribute(attribute);
        await tick();
        expect(feedback().textContent).toBe(label);
      });

      it("keeps the return to idle on the deadline the copy set", async () => {
        await start('data-stimeo--clipboard-feedback-duration-value="200"');
        await copyOnce(fails);
        await delay(50);
        controllerEl().setAttribute(attribute, "Swapped");
        await tick();
        expect(feedback().textContent).toBe("Swapped");
        // 170ms after the swap is past the 200ms window the copy started, and short of a
        // window the swap would have restarted.
        await delay(170);
        expect(controllerEl().getAttribute("data-state")).toBe("idle");
        expect(feedback().textContent).toBe("");
      });

      it("leaves text someone else wrote into the slot alone", async () => {
        await start('data-stimeo--clipboard-feedback-duration-value="0"');
        await copyOnce(fails);
        feedback().textContent = "Shared with the team";
        controllerEl().setAttribute(attribute, "Swapped");
        await tick();
        expect(feedback().textContent).toBe("Shared with the team");
      });

      it("leaves the result alone when the other outcome's label changes", async () => {
        // Both outcomes share one wording, so the slot reads the previous label whichever
        // one is swapped; only the label of the outcome on screen is followed.
        await start(
          `data-stimeo--clipboard-feedback-duration-value="0" ${attribute}="Done" ${other}="Done"`,
        );
        await copyOnce(fails);
        expect(feedback().textContent).toBe("Done");
        controllerEl().setAttribute(other, "Swapped");
        await tick();
        expect(feedback().textContent).toBe("Done");
        controllerEl().setAttribute(attribute, "Swapped");
        await tick();
        expect(feedback().textContent).toBe("Swapped");
      });

      it("writes nothing from the label callback Stimulus runs before connect", async () => {
        let beforeConnect: string | null = null;
        class ProbedClipboard extends ClipboardController {
          override connect(): void {
            beforeConnect = feedback().textContent;
            super.connect();
          }
        }
        document.body.innerHTML = `
        <div data-controller="stimeo--clipboard" data-state="${state}" ${attribute}="Swapped">
          <button type="button" data-stimeo--clipboard-target="button"
                  data-action="stimeo--clipboard#copy">Copy</button>
          <span data-stimeo--clipboard-target="feedback">${label}</span>
        </div>${ANNOUNCER}`;
        application = Application.start();
        application.register("stimeo--clipboard", ProbedClipboard);
        application.register("stimeo--announcer", AnnouncerController);
        await tick();
        // Stimulus passes the default as the previous label, which the restored slot still
        // reads; connect() settles a restored result itself, by returning it to idle.
        expect(beforeConnect).toBe(label);
        expect(controllerEl().getAttribute("data-state")).toBe("idle");
        expect(feedback().textContent).toBe("");
      });
    },
  );

  it("leaves the slot alone once the result has returned to idle", async () => {
    await start('data-stimeo--clipboard-feedback-duration-value="20"');
    await instance().copy();
    await delay(40);
    expect(controllerEl().getAttribute("data-state")).toBe("idle");
    // The idle slot holds no result, so wording in it is not this controller's to
    // relabel, even wording that matches the label.
    feedback().textContent = "Copied";
    controllerEl().setAttribute("data-stimeo--clipboard-copied-label-value", "Link copied");
    await tick();
    expect(feedback().textContent).toBe("Copied");
    expect(controllerEl().getAttribute("data-state")).toBe("idle");
  });

  it("applies a feedbackDuration swapped while a result is shown from the next copy", async () => {
    await start('data-stimeo--clipboard-feedback-duration-value="200"');
    await instance().copy();
    controllerEl().setAttribute("data-stimeo--clipboard-feedback-duration-value", "20");
    await tick();
    // The result on screen keeps the window its copy armed.
    await delay(60);
    expect(controllerEl().getAttribute("data-state")).toBe("copied");
    // The next copy arms the new window.
    await instance().copy();
    await delay(60);
    expect(controllerEl().getAttribute("data-state")).toBe("idle");
  });

  it.each([
    {
      outcome: "success",
      attribute: "data-stimeo--clipboard-announce-copied-text-value",
      fails: false,
    },
    {
      outcome: "failure",
      attribute: "data-stimeo--clipboard-announce-error-text-value",
      fails: true,
    },
  ])(
    "applies the $outcome announcement text swapped while a result is shown from the next copy",
    async ({ attribute, fails }) => {
      await start(`data-stimeo--clipboard-feedback-duration-value="0" ${attribute}="Before"`);
      await copyOnce(fails);
      expect(announcements).toEqual(["Before"]);
      controllerEl().setAttribute(attribute, "After");
      await tick();
      // The result on screen is not read out again.
      expect(announcements).toEqual(["Before"]);
      await copyOnce(fails);
      expect(announcements).toEqual(["Before", "After"]);
    },
  );

  it("follows a label without a feedback target present", async () => {
    await mount(`
      <div data-controller="stimeo--clipboard" data-stimeo--clipboard-feedback-duration-value="0">
        <input data-stimeo--clipboard-target="source" value="x">
        <button data-stimeo--clipboard-target="button"
                data-action="stimeo--clipboard#copy">Copy</button>
      </div>`);
    await instance().copy();
    // `feedback` is optional, so a swapped label has nowhere to go and must not throw.
    expect(() => instance().copiedLabelValueChanged("Swapped", "Copied")).not.toThrow();
    expect(controllerEl().getAttribute("data-state")).toBe("copied");
  });
});
