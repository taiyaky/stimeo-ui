import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cssTimeToMs, ToastController } from "../src/controllers/toast_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link ToastController}: verifying notifications list limits,
 * live-region status roles, timing pause/resume on hover/focus (WCAG 2.2.1), and Escape closure.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ToastController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--toast"
           data-stimeo--toast-duration-value="200"
           data-stimeo--toast-max-value="2">
        <div role="region" aria-label="Notifications">
          <ol id="list" data-stimeo--toast-target="list"></ol>
          <template data-stimeo--toast-target="template">
            <li role="status" id="toast-item" data-stimeo--toast-target="item"
                data-action="mouseenter->stimeo--toast#pause mouseleave->stimeo--toast#resume focusin->stimeo--toast#pause focusout->stimeo--toast#resume keydown->stimeo--toast#onKeydown"
                tabindex="0">
              <span data-toast-slot="body"></span>
              <button id="dismiss-btn" type="button" data-action="stimeo--toast#dismiss">Dismiss</button>
            </li>
          </template>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--toast", ToastController);
    await tick();
  });

  afterEach(async () => {
    application.stop();
    document.body.innerHTML = "";
    await delay(50);
  });

  const list = () => document.getElementById("list") as HTMLElement;
  const controllerElement = () =>
    document.querySelector("[data-controller='stimeo--toast']") as HTMLElement;

  const triggerShow = (body: string, type: "status" | "alert" = "status") => {
    const controller = application.getControllerForElementAndIdentifier(
      controllerElement(),
      "stimeo--toast",
    ) as ToastController;
    const event = new CustomEvent("show", {
      detail: { body, type },
    });
    controller.show(event);
  };

  it("starts empty with no elements inside list", () => {
    expect(list().children.length).toBe(0);
  });

  it("clones template and appends to the list when show event is dispatched", async () => {
    triggerShow("Success notification");
    await delay(20);
    expect(list().children.length).toBe(1);
    const item = list().querySelector("[data-stimeo--toast-target='item']") as HTMLElement;
    expect(item).toBeDefined();
    expect(item.getAttribute("role")).toBe("status");
    expect(item.querySelector("[data-toast-slot='body']")?.textContent).toBe(
      "Success notification",
    );
  });

  it("applies status or alert roles based on show event details", async () => {
    triggerShow("Emergency Alert", "alert");
    await delay(20);
    const item = list().querySelector("[data-stimeo--toast-target='item']") as HTMLElement;
    expect(item.getAttribute("role")).toBe("alert");
  });

  it("reads body and type from a Stimulus action param (attribute-only trigger)", async () => {
    const controller = application.getControllerForElementAndIdentifier(
      controllerElement(),
      "stimeo--toast",
    ) as ToastController;
    // Disable the auto-dismiss timer so this assertion-only test leaves no real
    // timer pending that could race the action-binding later tests depend on.
    controller.durationValue = 0;
    // Stimulus attaches `params` to the action event from data-*-param attributes;
    // this mirrors a `click->stimeo--toast#show` trigger without a hand-written event.
    const actionEvent = Object.assign(new CustomEvent("show"), {
      params: { body: "Param triggered", type: "alert" },
    });
    controller.show(actionEvent);
    await tick();

    const item = list().querySelector("[data-stimeo--toast-target='item']") as HTMLElement;
    expect(item.querySelector("[data-toast-slot='body']")?.textContent).toBe("Param triggered");
    expect(item.getAttribute("role")).toBe("alert");
  });

  it("ignores a show invocation that carries neither a param nor a detail body", () => {
    const controller = application.getControllerForElementAndIdentifier(
      controllerElement(),
      "stimeo--toast",
    ) as ToastController;
    controller.show(new CustomEvent("show", { detail: {} }));
    expect(list().children.length).toBe(0);
  });

  it("limits visible items to max value by removing older items", async () => {
    triggerShow("First notification");
    await delay(20);
    triggerShow("Second notification");
    await delay(20);
    triggerShow("Third notification");

    const controller = application.getControllerForElementAndIdentifier(
      controllerElement(),
      "stimeo--toast",
    ) as ToastController;
    // enforceMaxLimit normally runs from itemTargetConnected (a MutationObserver-driven
    // Stimulus callback happy-dom does not reliably fire); call it directly for determinism.
    controller.enforceMaxLimit();
    await delay(20);

    // Max is 2, so the first one should be removed.
    expect(list().children.length).toBe(2);
    const firstText = list().firstElementChild?.querySelector(
      "[data-toast-slot='body']",
    )?.textContent;
    expect(firstText).toBe("Second notification");
  });

  it("dismisses an item automatically after duration", () => {
    vi.useFakeTimers();
    try {
      triggerShow("Auto dismiss toast"); // appends the item synchronously
      const item = list().querySelector("[data-stimeo--toast-target='item']") as HTMLElement;
      expect(list().children.length).toBe(1);

      const controller = application.getControllerForElementAndIdentifier(
        controllerElement(),
        "stimeo--toast",
      ) as ToastController;
      // Start the auto-dismiss timer directly, bypassing happy-dom's async
      // MutationObserver (the source of the flakiness). startTimer clears any prior
      // timer first, so this stays correct even if the observer also fires it.
      controller.itemTargetConnected(item);

      // Drive virtual time past the 200ms auto-dismiss; the zero-duration
      // transition makes finalize() remove the item synchronously. A synchronous
      // advance never flushes microtasks, so the observer cannot interfere.
      vi.advanceTimersByTime(400);
      expect(list().children.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses automatic dismiss on mouseenter and resumes on mouseleave", () => {
    vi.useFakeTimers();
    try {
      triggerShow("Hover pause toast");
      const item = list().querySelector("[data-stimeo--toast-target='item']") as HTMLElement;
      const controller = application.getControllerForElementAndIdentifier(
        controllerElement(),
        "stimeo--toast",
      ) as ToastController;
      // Arm the auto-dismiss timer directly, bypassing happy-dom's async observer.
      controller.itemTargetConnected(item);

      // Direct invoke only to bypass happy-dom event propagation delays.
      controller.pause({ currentTarget: item } as unknown as Event);
      expect(item.getAttribute("data-paused")).toBe("true");

      vi.advanceTimersByTime(150); // paused: the 200ms timer cannot fire
      expect(list().children.length).toBe(1); // Still visible

      controller.resume({ currentTarget: item } as unknown as Event);
      expect(item.hasAttribute("data-paused")).toBe(false);

      vi.advanceTimersByTime(300); // past the resumed 200ms remaining
      expect(list().children.length).toBe(0); // Dismissed
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses automatic dismiss on focusin and resumes on focusout", () => {
    vi.useFakeTimers();
    try {
      triggerShow("Focus pause toast");
      const item = list().querySelector("[data-stimeo--toast-target='item']") as HTMLElement;
      const controller = application.getControllerForElementAndIdentifier(
        controllerElement(),
        "stimeo--toast",
      ) as ToastController;
      // Arm the auto-dismiss timer directly, bypassing happy-dom's async observer.
      controller.itemTargetConnected(item);

      // Direct invoke only to bypass happy-dom event propagation delays.
      controller.pause({ currentTarget: item, type: "focusin" } as unknown as Event);
      expect(item.getAttribute("data-paused")).toBe("true");

      vi.advanceTimersByTime(150); // paused: the 200ms timer cannot fire
      expect(list().children.length).toBe(1);

      controller.resume({ currentTarget: item, type: "focusout" } as unknown as Event);
      expect(item.hasAttribute("data-paused")).toBe(false);

      vi.advanceTimersByTime(300); // past the resumed 200ms remaining
      expect(list().children.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dismisses focused item immediately when Escape is pressed", () => {
    triggerShow("Press Escape toast");
    const item = list().querySelector("[data-stimeo--toast-target='item']") as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(
      controllerElement(),
      "stimeo--toast",
    ) as ToastController;

    // Drive the keydown handler directly (bypasses happy-dom's async action binding).
    controller.onKeydown({
      key: "Escape",
      currentTarget: item,
      preventDefault() {},
    } as unknown as KeyboardEvent);
    expect(list().children.length).toBe(0);
  });

  it("dismisses the item immediately when clicking dismiss button", () => {
    triggerShow("Manual dismiss toast");
    const item = list().querySelector("[data-stimeo--toast-target='item']") as HTMLElement;
    const btn = item.querySelector("#dismiss-btn") as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(
      controllerElement(),
      "stimeo--toast",
    ) as ToastController;

    // Drive the dismiss action directly (bypasses happy-dom's async action binding).
    controller.dismiss({ currentTarget: btn } as unknown as Event);
    expect(list().children.length).toBe(0);
  });

  it("stays paused while focused after the mouse leaves, then resumes when focus leaves too", () => {
    vi.useFakeTimers();
    try {
      triggerShow("Combined pause toast");
      const item = list().querySelector("[data-stimeo--toast-target='item']") as HTMLElement;
      const controller = application.getControllerForElementAndIdentifier(
        controllerElement(),
        "stimeo--toast",
      ) as ToastController;
      // Arm the auto-dismiss timer directly, bypassing happy-dom's async observer.
      controller.itemTargetConnected(item);

      // Hover and focus are independent reasons; both active.
      controller.pause({ currentTarget: item, type: "mouseenter" } as unknown as Event);
      controller.pause({ currentTarget: item, type: "focusin" } as unknown as Event);
      expect(item.getAttribute("data-paused")).toBe("true");

      // Mouse leaves but focus remains: must stay paused.
      controller.resume({ currentTarget: item, type: "mouseleave" } as unknown as Event);
      expect(item.getAttribute("data-paused")).toBe("true");

      vi.advanceTimersByTime(300); // longer than 200ms, but still alive because paused
      expect(list().children.length).toBe(1);

      // Focus leaves too: now the timer resumes.
      controller.resume({ currentTarget: item, type: "focusout" } as unknown as Event);
      expect(item.hasAttribute("data-paused")).toBe(false);

      vi.advanceTimersByTime(300); // past the resumed 200ms remaining
      expect(list().children.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses CSS transition durations in both seconds and milliseconds", () => {
    expect(cssTimeToMs("0.2s")).toBe(200);
    expect(cssTimeToMs("150ms")).toBe(150);
    expect(cssTimeToMs("0.3s, 0.1s")).toBe(300); // only the first value matters
    expect(cssTimeToMs("")).toBe(0);
  });

  it("has no machine-detectable a11y violations with a live toast present", async () => {
    triggerShow("Saved successfully");
    await tick();
    // The toast markup contract places `role="status"` on `<li>` elements inside an `<ol>`.
    // Per ARIA-in-HTML, `<li>` has a restricted allowed-role set that excludes `status`,
    // which causes axe to flag `aria-allowed-role` and `list` (the <ol> child is no longer
    // seen as a listitem). These are intentional trade-offs in the existing markup contract;
    // disabling only these two rules here so we still catch any other violations.
    await expectNoA11yViolations(controllerElement(), {
      rules: {
        "aria-allowed-role": { enabled: false },
        list: { enabled: false },
      },
    });
  });

  it("announces the live-region status role and body in order after show", async () => {
    triggerShow("File saved");
    await tick();

    // Container is the <ol> list element; virtual reader traverses:
    //   "list" (ol), "status" (li role=status), "File saved" (body text),
    //   "button, Dismiss" (dismiss btn), "end of status", "end of list".
    // captureSpeech returns (steps + 1) phrases; pass steps: 5 to get 6 items.
    // captureSpeech renders button as "button, <name>" (role-first).
    const phrases = await captureSpeech({ container: list(), steps: 5 });
    expect(phrases).toEqual([
      "list",
      "status",
      "File saved",
      "button, Dismiss",
      "end of status",
      "end of list",
    ]);
  });

  it("clears auto-dismiss, finalize, and pending rAF callbacks on disconnect", () => {
    vi.useFakeTimers();
    try {
      triggerShow("Survives teardown"); // appends the item synchronously
      const item = list().querySelector("[data-stimeo--toast-target='item']") as HTMLElement;
      const controller = application.getControllerForElementAndIdentifier(
        controllerElement(),
        "stimeo--toast",
      ) as ToastController;
      // Arm the auto-dismiss timer and the entering→visible rAF directly (the
      // connect path), bypassing happy-dom's async MutationObserver.
      item.setAttribute("data-state", "entering");
      controller.itemTargetConnected(item);
      expect(item.getAttribute("data-state")).toBe("entering");

      const dismissSpy = vi.fn();
      controllerElement().addEventListener("stimeo--toast:dismiss", dismissSpy);

      // Disconnect synchronously — what Stimulus does when the element detaches —
      // before yielding to the event loop. This must cancel the pending timer and
      // rAF; a synchronous advance below never flushes microtasks, so the observer
      // cannot re-arm them.
      controller.disconnect();

      vi.advanceTimersByTime(500); // any uncancelled timer/rAF would fire here
      expect(dismissSpy).not.toHaveBeenCalled();
      // The cancelled rAF never flipped the state to "visible".
      expect(item.getAttribute("data-state")).toBe("entering");
    } finally {
      vi.useRealTimers();
    }
  });
});
