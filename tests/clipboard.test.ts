import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnnouncerController } from "../src/controllers/announcer_controller";
import { ClipboardController } from "../src/controllers/clipboard_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { delay, tick } from "./helpers/timing";
import { writeValueAttribute } from "./helpers/value_delivery";

/**
 * Behavioral tests for {@link ClipboardController}: copy execution against a
 * mocked Clipboard API, success/failure `data-state`, the visible completion slot
 * and its auto-clear, the shared-announcer messages, the `copy` event on both
 * paths, transient-state normalisation on connect, retained state through turbo:before-cache,
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

  it.each([false, true])(
    "follows a result label only while its plain text is owned (child=%s)",
    async (child) => {
      await start('data-stimeo--clipboard-feedback-duration-value="0"');
      await instance().copy();
      const slot = feedback();
      const authored = document.createElement("span");
      if (child) {
        authored.textContent = slot.textContent;
        slot.replaceChildren(authored);
      }
      controllerEl().setAttribute("data-stimeo--clipboard-copied-label-value", "Done");
      await tick();
      expect(slot.textContent).toBe(child ? "Copied" : "Done");
      if (child) expect(slot.firstElementChild).toBe(authored);
    },
  );

  it.each([false, true])(
    "leaves a replacement feedback that happens to show the previous label (recorded=%s)",
    async (recorded) => {
      await start('data-stimeo--clipboard-feedback-duration-value="0"');
      await instance().copy();
      const replacement = recorded
        ? (feedback().cloneNode(true) as HTMLElement)
        : document.createElement("span");
      if (!recorded) {
        replacement.setAttribute("data-stimeo--clipboard-target", "feedback");
        replacement.textContent = "Copied";
      }
      feedback().replaceWith(replacement);
      await tick();
      controllerEl().setAttribute("data-stimeo--clipboard-copied-label-value", "Done");
      await tick();
      expect(replacement.textContent).toBe("Copied");
    },
  );

  it("leaves a recorded replacement a morph finds when the result ends", async () => {
    await start('data-stimeo--clipboard-feedback-duration-value="20"');
    vi.useFakeTimers();
    try {
      await instance().copy();
      const replacement = feedback().cloneNode(true) as HTMLElement;
      feedback().replaceWith(replacement);
      await vi.advanceTimersByTimeAsync(0);
      controllerEl().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(20);
      expect(controllerEl().getAttribute("data-state")).toBe("idle");
      expect(replacement.textContent).toBe("Copied");
    } finally {
      vi.useRealTimers();
    }
  });

  it("empties every recorded feedback when a restored copy connects", async () => {
    await start('data-stimeo--clipboard-feedback-duration-value="0"');
    await instance().copy();
    const later = feedback();
    const first = document.createElement("span");
    first.setAttribute("data-stimeo--clipboard-target", "feedback");
    later.before(first);
    await tick();
    await instance().copy();
    expect([first.textContent, later.textContent]).toEqual(["Copied", "Copied"]);
    const restored = controllerEl().cloneNode(true) as HTMLElement;
    disconnectAndStopApplication(application);
    await mount(restored.outerHTML);
    const slots = [...document.querySelectorAll("[data-stimeo--clipboard-target='feedback']")].map(
      (slot) => slot.textContent,
    );
    expect(controllerEl().getAttribute("data-state")).toBe("idle");
    expect(slots).toEqual(["", ""]);
  });

  it("acquires a same-text child on a new explicit copy", async () => {
    await start('data-stimeo--clipboard-feedback-duration-value="0"');
    await instance().copy();
    feedback().innerHTML = "<span>Copied</span>";
    await instance().copy();
    expect(feedback().textContent).toBe("Copied");
    expect(feedback().firstElementChild).toBeNull();
  });

  it("forgets a DOM-supplied result after its followed slot leaves the targets", async () => {
    await start('data-stimeo--clipboard-feedback-duration-value="0"');
    const slot = feedback();
    slot.textContent = "Copied";
    slot.setAttribute("data-stimeo--clipboard-feedback-text", '["text","","Copied"]');
    controllerEl().setAttribute("data-state", "copied");
    controllerEl().setAttribute("data-stimeo--clipboard-copied-label-value", "Updated");
    await tick();
    expect(slot.textContent).toBe("Updated");
    expect(JSON.parse(slot.getAttribute("data-stimeo--clipboard-feedback-text") ?? "null")).toEqual(
      ["text", "", "Updated"],
    );
    slot.removeAttribute("data-stimeo--clipboard-target");
    instance().disconnect();
    instance().connect();
    expect(controllerEl().getAttribute("data-state")).toBe("idle");
    expect(slot.textContent).toBe("Updated");
    expect(slot.hasAttribute("data-stimeo--clipboard-feedback-text")).toBe(false);
  });

  it.each(["owned", "authored", "child", "departed"] as const)(
    "forgets a finished result's %s record while respecting its text",
    async (scenario) => {
      await start('data-stimeo--clipboard-feedback-duration-value="20"');
      vi.useFakeTimers();
      try {
        await instance().copy();
        const slot = feedback();
        if (scenario === "authored") slot.textContent = "Author revised";
        if (scenario === "child") slot.innerHTML = "<span>Copied</span>";
        if (scenario === "departed") slot.removeAttribute("data-stimeo--clipboard-target");
        await vi.advanceTimersByTimeAsync(20);
        expect(slot.hasAttribute("data-stimeo--clipboard-feedback-text")).toBe(false);
        expect(slot.textContent).toBe(
          scenario === "owned" ? "" : scenario === "authored" ? "Author revised" : "Copied",
        );
        if (scenario === "child") expect(slot.firstElementChild?.tagName).toBe("SPAN");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["missing", "current", "invalid"] as const)(
    "releases a live result using its %s DOM record",
    async (record) => {
      await start('data-stimeo--clipboard-feedback-duration-value="20"');
      vi.useFakeTimers();
      try {
        await instance().copy();
        const slot = feedback();
        if (record === "missing") slot.removeAttribute("data-stimeo--clipboard-feedback-text");
        if (record === "current") {
          slot.textContent = "Reconciled";
          slot.setAttribute("data-stimeo--clipboard-feedback-text", '["text","","Reconciled"]');
        }
        if (record === "invalid")
          slot.setAttribute("data-stimeo--clipboard-feedback-text", "invalid");
        await vi.advanceTimersByTimeAsync(20);
        expect(slot.textContent).toBe(record === "invalid" ? "Copied" : "");
        expect(slot.hasAttribute("data-stimeo--clipboard-feedback-text")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    "repairs its original slot only when a morph omits the record (omitted=%s)",
    async (omitted) => {
      await mount(
        '<div data-controller="stimeo--clipboard" data-stimeo--clipboard-feedback-duration-value="0"><span data-stimeo--clipboard-target="feedback">Ready</span></div>',
      );
      await instance().copy();
      feedback().textContent = "Ready";
      if (omitted) feedback().removeAttribute("data-stimeo--clipboard-feedback-text");
      controllerEl().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
      await tick();
      expect(feedback().textContent).toBe(omitted ? "Copied" : "Ready");
    },
  );

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
        <span data-stimeo--clipboard-target="feedback" data-stimeo--clipboard-feedback-text='["text","","Copied"]'>Copied</span>
      </div>`);
    expect(controllerEl().getAttribute("data-state")).toBe("idle");
    expect(feedback().textContent).toBe("");
  });

  it("normalises a restored error state on connect", async () => {
    await mount(`
      <div data-controller="stimeo--clipboard" data-state="error">
        <button data-stimeo--clipboard-target="button"
                data-action="stimeo--clipboard#copy">Copy</button>
        <span data-stimeo--clipboard-target="feedback" data-stimeo--clipboard-feedback-text='["text","","Copy failed"]'>Copy failed</span>
      </div>`);
    expect(controllerEl().getAttribute("data-state")).toBe("idle");
    expect(feedback().textContent).toBe("");
  });

  it.each(["owned", "authored", "child", "missing", "invalid"] as const)(
    "normalises a real result clone without erasing %s feedback",
    async (scenario) => {
      await start('data-stimeo--clipboard-feedback-duration-value="0"');
      await instance().copy();
      const clone = controllerEl().cloneNode(true) as HTMLElement;
      const slot = clone.querySelector<HTMLElement>("[data-stimeo--clipboard-target='feedback']");
      if (!slot) throw new Error("missing feedback");
      if (scenario === "authored") slot.textContent = "Author revised";
      if (scenario === "child") slot.innerHTML = "<span>Copied</span>";
      if (scenario === "missing") slot.removeAttribute("data-stimeo--clipboard-feedback-text");
      if (scenario === "invalid")
        slot.setAttribute("data-stimeo--clipboard-feedback-text", "broken");
      disconnectAndStopApplication(application);
      await mount(clone.outerHTML);
      expect(controllerEl().getAttribute("data-state")).toBe("idle");
      expect(feedback().textContent).toBe(
        scenario === "owned" ? "" : scenario === "authored" ? "Author revised" : "Copied",
      );
      if (scenario === "child") expect(feedback().firstElementChild?.tagName).toBe("SPAN");
    },
  );

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

  it("keeps the completion state through turbo:before-cache, which Turbo also dispatches on pages that stay", async () => {
    await start('data-stimeo--clipboard-feedback-duration-value="0"');
    await instance().copy();
    expect(controllerEl().getAttribute("data-state")).toBe("copied");

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(controllerEl().getAttribute("data-state")).toBe("copied");
    expect(feedback().textContent).toBe("Copied");
  });

  it("still returns to idle on time after turbo:before-cache", async () => {
    await start('data-stimeo--clipboard-feedback-duration-value="20"');
    await instance().copy();

    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(controllerEl().getAttribute("data-state")).toBe("copied");
    await delay(40);

    expect(controllerEl().getAttribute("data-state")).toBe("idle");
    expect(feedback().textContent).toBe("");
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
    vi.useFakeTimers();
    try {
      await instance().copy();
      vi.advanceTimersByTime(30);
      // Second copy 30ms in must restart the window, not let the first timer fire.
      await instance().copy();
      vi.advanceTimersByTime(49); // 79ms since the first copy, 49ms since the second
      expect(controllerEl().getAttribute("data-state")).toBe("copied");
      vi.advanceTimersByTime(1); // the end of the second window
      expect(controllerEl().getAttribute("data-state")).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  // disconnect() cancels the pending return to idle through SafeTimeout's clearAll.
  it("clears the auto-reset timer on disconnect (no mutation after teardown)", async () => {
    await start('data-stimeo--clipboard-feedback-duration-value="20"');
    await instance().copy();
    const fb = feedback();

    // The case calls disconnect() directly, so it checks the controller's own teardown
    // rather than the removal Stimulus observes: disconnect() must cancel the pending
    // auto-reset timer.
    instance().disconnect();
    fb.textContent = "sentinel";
    await delay(40);
    // The cancelled timer must not have returned the result to idle, nor touched the slot.
    expect(controllerEl().getAttribute("data-state")).toBe("copied");
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
        vi.useFakeTimers();
        try {
          await copyOnce(fails);
          vi.advanceTimersByTime(50);
          controllerEl().setAttribute(attribute, "Swapped");
          await vi.advanceTimersByTimeAsync(0);
          expect(feedback().textContent).toBe("Swapped");
          // The window the copy started ends 150ms after the swap, short of a window the
          // swap would have restarted.
          vi.advanceTimersByTime(149);
          expect(controllerEl().getAttribute("data-state")).toBe(state);
          vi.advanceTimersByTime(1);
          expect(controllerEl().getAttribute("data-state")).toBe("idle");
          expect(feedback().textContent).toBe("");
        } finally {
          vi.useRealTimers();
        }
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

      it("leaves its held slot unchanged when a label callback arrives after disconnect", async () => {
        await start(
          'data-stimeo--clipboard-feedback-duration-value="0" ' +
            'data-stimeo--clipboard-announce-copied-text-value="Copied to clipboard" ' +
            'data-stimeo--clipboard-announce-error-text-value="Copy failed"',
        );
        await copyOnce(fails);
        const controller = instance();
        const slot = feedback();
        const record = slot.getAttribute("data-stimeo--clipboard-feedback-text");
        const spoken = [...announcements];
        const copies = countCopies();
        controller.disconnect();
        controllerEl().setAttribute(attribute, "Swapped");
        // A delivered Value callback retains the same slot and matching owned label.
        if (fails) controller.errorLabelValueChanged("Swapped", label);
        else controller.copiedLabelValueChanged("Swapped", label);
        expect(slot.textContent).toBe(label);
        expect(slot.getAttribute("data-stimeo--clipboard-feedback-text")).toBe(record);
        expect(controllerEl().getAttribute("data-state")).toBe(state);
        expect(announcements).toEqual(spoken);
        expect(copies.count).toBe(0);

        controller.connect();
        expect(controllerEl().getAttribute("data-state")).toBe("idle");
        expect(slot.textContent).toBe("");
        expect(slot.hasAttribute("data-stimeo--clipboard-feedback-text")).toBe(false);
        await copyOnce(fails);
        expect(slot.textContent).toBe("Swapped");
        controllerEl().setAttribute(attribute, "Live");
        if (fails) controller.errorLabelValueChanged("Live", "Swapped");
        else controller.copiedLabelValueChanged("Live", "Swapped");
        expect(slot.textContent).toBe("Live");
        expect(copies.count).toBe(1);
        expect(announcements).toEqual([...spoken, ...spoken]);
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
          <span data-stimeo--clipboard-target="feedback" data-stimeo--clipboard-feedback-text='["text","","${label}"]'>${label}</span>
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
    vi.useFakeTimers();
    try {
      await instance().copy();
      controllerEl().setAttribute("data-stimeo--clipboard-feedback-duration-value", "20");
      await vi.advanceTimersByTimeAsync(0);
      // The result on screen keeps the window its copy armed.
      vi.advanceTimersByTime(60);
      expect(controllerEl().getAttribute("data-state")).toBe("copied");
      // The next copy arms the new window.
      await instance().copy();
      vi.advanceTimersByTime(19);
      expect(controllerEl().getAttribute("data-state")).toBe("copied");
      vi.advanceTimersByTime(1);
      expect(controllerEl().getAttribute("data-state")).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Rewrites the `feedbackDuration` declaration and waits for Stimulus to deliver it, so
   * the assertions that follow see whatever the controller does with the change.
   */
  const declareFeedbackDuration = (value: number) =>
    writeValueAttribute(
      controllerEl(),
      "data-stimeo--clipboard-feedback-duration-value",
      String(value),
    );

  it.each([
    { direction: "shrinks", next: 20 },
    { direction: "grows", next: 5000 },
  ])(
    "keeps a shown result's return to idle when feedbackDuration $direction, and times the next copy anew",
    async ({ next }) => {
      await start('data-stimeo--clipboard-feedback-duration-value="200"');
      vi.useFakeTimers();
      try {
        await instance().copy();
        vi.advanceTimersByTime(50);

        await declareFeedbackDuration(next);
        vi.advanceTimersByTime(149);
        expect(controllerEl().getAttribute("data-state")).toBe("copied");
        vi.advanceTimersByTime(1);
        expect(controllerEl().getAttribute("data-state")).toBe("idle");

        await instance().copy();
        vi.advanceTimersByTime(next - 1);
        expect(controllerEl().getAttribute("data-state")).toBe("copied");
        vi.advanceTimersByTime(1);
        expect(controllerEl().getAttribute("data-state")).toBe("idle");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("arms nothing and reports nothing from a feedbackDuration change alone", async () => {
    await start(
      'data-stimeo--clipboard-feedback-duration-value="0" ' +
        'data-stimeo--clipboard-announce-copied-text-value="Copied"',
    );
    const copies: unknown[] = [];
    controllerEl().addEventListener("stimeo--clipboard:copy", (event) =>
      copies.push((event as CustomEvent).detail),
    );
    vi.useFakeTimers();
    try {
      await instance().copy();
      expect(copies).toHaveLength(1);

      // The result on screen was promised no return to idle, and a later duration keeps it.
      await declareFeedbackDuration(20);
      vi.advanceTimersByTime(1000);
      expect(controllerEl().getAttribute("data-state")).toBe("copied");
      expect(feedback().textContent).toBe("Copied");
      expect(copies).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
    await tick();
    expect(announcements).toEqual(["Copied"]);
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

  it("adopts a slot that stays after an earlier one leaves only on its next copy", async () => {
    // A slot that is not the one the copy wrote belongs to the page until a copy
    // writes it, the same as a slot swapped in by a morph.
    await start('data-stimeo--clipboard-feedback-duration-value="0"');
    const original = feedback();
    const successor = original.cloneNode(true) as HTMLElement;
    successor.textContent = "Ready";
    original.after(successor);
    await tick();
    await instance().copy();
    expect(original.textContent).toBe("Copied");

    original.remove();
    await tick();
    expect(feedback()).toBe(successor);
    expect(successor.textContent).toBe("Ready");

    await instance().copy();
    expect(successor.textContent).toBe("Copied");
  });

  describe("the return to idle", () => {
    const TARGET = "data-stimeo--clipboard-target";
    const SHORT = 'data-stimeo--clipboard-feedback-duration-value="20"';

    it("keeps the text the page put into a feedback that replaced the one the copy wrote", async () => {
      await start(SHORT);
      await instance().copy();
      const replacement = feedback().cloneNode(false) as HTMLElement;
      replacement.textContent = "Replacement";
      feedback().replaceWith(replacement);
      await tick();

      await delay(40);

      expect(controllerEl().getAttribute("data-state")).toBe("idle");
      expect(replacement.textContent).toBe("Replacement");
    });

    it("empties the feedback the copy wrote, not one the page put ahead of it", async () => {
      await start(SHORT);
      await instance().copy();
      const written = feedback();
      const ahead = written.cloneNode(false) as HTMLElement;
      ahead.textContent = "Ready";
      written.before(ahead);
      await tick();

      await delay(40);

      expect(controllerEl().getAttribute("data-state")).toBe("idle");
      expect(ahead.textContent).toBe("Ready");
      expect(written.textContent).toBe("");
    });

    it("leaves wording the page wrote into the feedback after the copy", async () => {
      await start(SHORT);
      await instance().copy();
      feedback().textContent = "Saved by the page";

      await delay(40);

      expect(controllerEl().getAttribute("data-state")).toBe("idle");
      expect(feedback().textContent).toBe("Saved by the page");
    });

    it("leaves a feedback the page put an element into", async () => {
      await start(SHORT);
      await instance().copy();
      feedback().insertAdjacentHTML("beforeend", '<svg aria-hidden="true"></svg>');
      expect(feedback().textContent).toBe("Copied");

      await delay(40);

      expect(controllerEl().getAttribute("data-state")).toBe("idle");
      expect(feedback().textContent).toBe("Copied");
      expect(feedback().querySelector("svg")).not.toBeNull();
    });

    it("leaves a slot that stopped being the feedback as it is", async () => {
      await start(SHORT);
      await instance().copy();
      const departed = feedback();
      departed.removeAttribute(TARGET);
      await tick();

      await delay(40);

      expect(controllerEl().getAttribute("data-state")).toBe("idle");
      expect(departed.textContent).toBe("Copied");
    });

    it("empties the relabelled wording the result shows when it ends", async () => {
      await start(SHORT);
      vi.useFakeTimers();
      try {
        await instance().copy();
        controllerEl().setAttribute("data-stimeo--clipboard-copied-label-value", "Link copied");
        await vi.advanceTimersByTimeAsync(0);
        expect(feedback().textContent).toBe("Link copied");

        vi.advanceTimersByTime(20);

        expect(feedback().textContent).toBe("");
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the page's wording when an in-page move returns the result to idle", async () => {
      await start('data-stimeo--clipboard-feedback-duration-value="0"');
      await instance().copy();
      feedback().textContent = "Saved by the page";

      instance().disconnect();
      instance().connect();

      expect(controllerEl().getAttribute("data-state")).toBe("idle");
      expect(feedback().textContent).toBe("Saved by the page");
    });

    it.each(["timer", "reconnect"] as const)(
      "keeps a completed slot's later DOM evidence out of the next reset (end=%s)",
      async (end) => {
        await start(SHORT);
        vi.useFakeTimers();
        try {
          await instance().copy();
          const earlier = feedback();
          const recordName = "data-stimeo--clipboard-feedback-text";
          const recorded = earlier.getAttribute(recordName);
          expect(recorded).not.toBeNull();
          if (end === "timer") await vi.advanceTimersByTimeAsync(20);
          else {
            instance().disconnect();
            instance().connect();
          }
          expect(earlier.textContent).toBe("");
          expect(earlier.hasAttribute(recordName)).toBe(false);

          const ahead = document.createElement("span");
          ahead.setAttribute(TARGET, "feedback");
          earlier.before(ahead);
          // The page restores recorded markup to a slot whose result has already ended.
          earlier.textContent = "Copied";
          earlier.setAttribute(recordName, recorded ?? "");
          await vi.advanceTimersByTimeAsync(0);
          await instance().copy();
          expect(ahead.textContent).toBe("Copied");
          await vi.advanceTimersByTimeAsync(20);
          expect(controllerEl().getAttribute("data-state")).toBe("idle");
          expect(ahead.textContent).toBe("");
          expect(ahead.hasAttribute(recordName)).toBe(false);
          expect(earlier.textContent).toBe("Copied");
          expect(earlier.getAttribute(recordName)).toBe(recorded);
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it("forgets the slot a result was written into once that result ends", async () => {
      await start(SHORT);
      await instance().copy();
      const earlier = feedback();
      await delay(40);
      expect(earlier.textContent).toBe("");
      const ahead = earlier.cloneNode(false) as HTMLElement;
      earlier.before(ahead);
      await tick();
      // The page's own wording, which happens to match the label.
      earlier.textContent = "Copied";
      await instance().copy();
      expect(ahead.textContent).toBe("Copied");

      await delay(40);

      expect(ahead.textContent).toBe("");
      expect(earlier.textContent).toBe("Copied");
    });

    it("empties its own wording when an in-page move returns the result to idle", async () => {
      await start('data-stimeo--clipboard-feedback-duration-value="0"');
      await instance().copy();

      instance().disconnect();
      instance().connect();

      expect(controllerEl().getAttribute("data-state")).toBe("idle");
      expect(feedback().textContent).toBe("");
    });
  });
});
