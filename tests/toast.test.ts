import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastController } from "../src/controllers/toast_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ToastController}: list/live-region semantics,
 * delegated interaction, timer policy, public events, and Turbo-safe teardown.
 */

describe("ToastController", () => {
  let application: Application;

  const markup = ({
    suffix = "",
    duration = 200,
    max = 2,
    includeValues = true,
  }: {
    suffix?: string;
    duration?: number;
    max?: number;
    includeValues?: boolean;
  } = {}) => `
    <div id="toast-root${suffix}" data-controller="stimeo--toast"
         ${includeValues ? `data-stimeo--toast-duration-value="${duration}"` : ""}
         ${includeValues ? `data-stimeo--toast-max-value="${max}"` : ""}>
      <button id="show-trigger${suffix}" type="button"
              data-action="click->stimeo--toast#show"
              data-stimeo--toast-body-param="Param notification"
              data-stimeo--toast-type-param="alert">Show</button>
      <div role="region" aria-label="Notifications">
        <ol id="toast-list${suffix}" data-stimeo--toast-target="list"></ol>
        <template data-stimeo--toast-target="template">
          <li data-stimeo--toast-target="item" tabindex="0">
            <span role="status" data-toast-slot="body"></span>
            <button type="button" data-toast-dismiss>Dismiss</button>
          </li>
        </template>
      </div>
    </div>`;

  const requireElement = <T extends Element>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`Element not found: ${selector}`);
    return element;
  };

  const root = (suffix = "") => requireElement<HTMLElement>(`#toast-root${suffix}`);
  const list = (suffix = "") => requireElement<HTMLOListElement>(`#toast-list${suffix}`);
  const controller = (suffix = "") => {
    const instance = application.getControllerForElementAndIdentifier(
      root(suffix),
      "stimeo--toast",
    );
    if (!(instance instanceof ToastController)) throw new Error("Toast controller not connected");
    return instance;
  };
  const item = (suffix = "") =>
    requireElement<HTMLElement>(`#toast-list${suffix} [data-stimeo--toast-target='item']`);
  const body = (toast: HTMLElement) => toast.querySelector<HTMLElement>("[data-toast-slot='body']");
  const dismissButton = (toast: HTMLElement) =>
    toast.querySelector<HTMLButtonElement>("[data-toast-dismiss]");

  const triggerShow = (text: string, type: "status" | "alert" = "status", suffix = "") => {
    controller(suffix).show(new CustomEvent("show", { detail: { body: text, type } }));
  };

  beforeEach(async () => {
    document.body.innerHTML = markup();
    application = Application.start();
    application.register("stimeo--toast", ToastController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts empty with no elements inside the list", () => {
    expect(list().children.length).toBe(0);
  });

  it("clones a listitem with a nested status region when show is dispatched", () => {
    triggerShow("Success notification");

    const toast = item();
    expect(list().children.length).toBe(1);
    expect(toast.getAttribute("role")).toBeNull();
    expect(body(toast)?.getAttribute("role")).toBe("status");
    expect(body(toast)?.textContent).toBe("Success notification");
    expect(dismissButton(toast)).not.toBeNull();
  });

  it("applies status or alert to the nested live region", () => {
    triggerShow("Emergency alert", "alert");

    expect(body(item())?.getAttribute("role")).toBe("alert");
  });

  it("runs the attribute-only show action through Stimulus", () => {
    requireElement<HTMLButtonElement>("#show-trigger").click();

    expect(body(item())?.textContent).toBe("Param notification");
    expect(body(item())?.getAttribute("role")).toBe("alert");
  });

  it("prefers action params over event detail", () => {
    const event = Object.assign(
      new CustomEvent("show", { detail: { body: "Detail notification", type: "status" } }),
      { params: { body: "Param notification", type: "alert" } },
    );
    controller().show(event);

    expect(body(item())?.textContent).toBe("Param notification");
    expect(body(item())?.getAttribute("role")).toBe("alert");
  });

  it("rejects invalid bodies and normalizes an invalid type to status", () => {
    controller().show(new CustomEvent("show", { detail: {} }));
    controller().show(new CustomEvent("show", { detail: { body: 42 } }));
    expect(list().children.length).toBe(0);

    controller().show(
      new CustomEvent("show", { detail: { body: "Normalized notification", type: "urgent" } }),
    );
    expect(body(item())?.getAttribute("role")).toBe("status");
  });

  it("dispatches show with the appended item", () => {
    const listener = vi.fn();
    root().addEventListener("stimeo--toast:show", listener);

    triggerShow("Event notification");

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ detail: { item: item() } });
  });

  it("uses duration 0 and max 3 when Values are omitted", async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = markup({ includeValues: false });
    application = Application.start();
    application.register("stimeo--toast", ToastController);
    await tick();

    expect(controller().durationValue).toBe(0);
    expect(controller().maxValue).toBe(3);
    for (let index = 1; index <= 4; index++) triggerShow(`Notification ${index}`);
    controller().enforceMaxLimit();
    expect(list().children.length).toBe(3);
    expect(body(list().firstElementChild as HTMLElement)?.textContent).toBe("Notification 2");
  });

  it("limits items to max by removing the oldest first", () => {
    triggerShow("First notification");
    triggerShow("Second notification");
    triggerShow("Third notification");

    controller().enforceMaxLimit();

    expect(list().children.length).toBe(2);
    expect(body(list().firstElementChild as HTMLElement)?.textContent).toBe("Second notification");
  });

  it("keeps no item or delayed callback when max is zero", () => {
    vi.useFakeTimers();
    controller().maxValue = 0;
    controller().maxValueChanged();
    const dismissListener = vi.fn();
    root().addEventListener("stimeo--toast:dismiss", dismissListener);
    triggerShow("Rejected by max");
    const toast = item();

    controller().itemTargetConnected(toast);
    expect(list().children.length).toBe(0);
    expect(dismissListener).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1_000);
    expect(dismissListener).toHaveBeenCalledOnce();
  });

  it("auto-dismisses and reports the timeout event detail", () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    root().addEventListener("stimeo--toast:dismiss", listener);
    triggerShow("Auto dismiss notification");
    const toast = item();
    controller().itemTargetConnected(toast);

    vi.advanceTimersByTime(200);

    expect(list().children.length).toBe(0);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      detail: { item: toast, reason: "timeout" },
    });
  });

  it("pauses and resumes through delegated pointer events", () => {
    vi.useFakeTimers();
    triggerShow("Hover pause notification");
    const toast = item();
    controller().itemTargetConnected(toast);

    vi.advanceTimersByTime(50);
    toast.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }),
    );
    expect(toast.getAttribute("data-paused")).toBe("true");
    vi.advanceTimersByTime(300);
    expect(list().children.length).toBe(1);

    toast.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }),
    );
    expect(toast.hasAttribute("data-paused")).toBe(false);
    vi.advanceTimersByTime(149);
    expect(list().children.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(list().children.length).toBe(0);
  });

  it("pauses and resumes through delegated focus events", () => {
    vi.useFakeTimers();
    triggerShow("Focus pause notification");
    const toast = item();
    controller().itemTargetConnected(toast);

    toast.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: document.body }));
    expect(toast.getAttribute("data-paused")).toBe("true");
    vi.advanceTimersByTime(300);
    expect(list().children.length).toBe(1);

    toast.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }),
    );
    vi.advanceTimersByTime(200);
    expect(list().children.length).toBe(0);
  });

  it("stays paused until both pointer and focus have left", () => {
    vi.useFakeTimers();
    triggerShow("Combined pause notification");
    const toast = item();
    controller().itemTargetConnected(toast);

    toast.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }),
    );
    toast.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: document.body }));
    toast.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }),
    );
    vi.advanceTimersByTime(300);
    expect(toast.getAttribute("data-paused")).toBe("true");
    expect(list().children.length).toBe(1);

    toast.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }),
    );
    vi.advanceTimersByTime(200);
    expect(list().children.length).toBe(0);
  });

  it("clears existing timers when duration changes to zero", () => {
    vi.useFakeTimers();
    triggerShow("Persistent notification");
    const toast = item();
    controller().itemTargetConnected(toast);

    controller().durationValue = 0;
    controller().durationValueChanged();
    vi.advanceTimersByTime(1_000);

    expect(list().children.length).toBe(1);
    expect(toast.hasAttribute("data-paused")).toBe(false);
  });

  it("restarts active timers with a new positive duration", () => {
    vi.useFakeTimers();
    triggerShow("Reset duration notification");
    controller().itemTargetConnected(item());
    vi.advanceTimersByTime(100);

    controller().durationValue = 500;
    controller().durationValueChanged();
    vi.advanceTimersByTime(499);
    expect(list().children.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(list().children.length).toBe(0);
  });

  it("preserves pause while applying a new positive duration", () => {
    vi.useFakeTimers();
    triggerShow("Paused duration notification");
    const toast = item();
    controller().itemTargetConnected(toast);
    toast.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: document.body }));

    controller().durationValue = 500;
    controller().durationValueChanged();
    vi.advanceTimersByTime(1_000);
    expect(list().children.length).toBe(1);
    expect(toast.getAttribute("data-paused")).toBe("true");

    toast.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }),
    );
    vi.advanceTimersByTime(500);
    expect(list().children.length).toBe(0);
  });

  it("dismisses instead of stranding a pause whose remaining time reached zero", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    triggerShow("Expired pause notification");
    const toast = item();
    controller().itemTargetConnected(toast);
    vi.setSystemTime(new Date("2026-07-20T00:00:01Z"));

    toast.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: document.body }));

    expect(list().children.length).toBe(0);
    expect(toast.hasAttribute("data-paused")).toBe(false);
  });

  it("ignores non-Escape keys and prevents the delegated Escape action", () => {
    triggerShow("Keyboard notification");
    const toast = item();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    toast.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(list().children.length).toBe(1);

    const escapeEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    toast.dispatchEvent(escapeEvent);
    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(list().children.length).toBe(0);
  });

  it("keeps the toast when Escape cancels an IME composition", () => {
    triggerShow("Composing notification");
    const toast = item();
    // Widget-local half of the shared layered-Escape contract: a composing press
    // (e.g. in a text field inside the toast) steers the IME conversion,
    // never the toast.
    const composing = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    toast.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    expect(list().children.length).toBe(1);
  });

  it("dismisses immediately through the delegated button and reports user detail", () => {
    const listener = vi.fn();
    root().addEventListener("stimeo--toast:dismiss", listener);
    triggerShow("Manual notification");
    const toast = item();

    dismissButton(toast)?.click();

    expect(list().children.length).toBe(0);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      detail: { item: toast, reason: "user" },
    });
  });

  it("keeps the legacy per-item action markup working", async () => {
    const template = requireElement<HTMLTemplateElement>(
      "#toast-root template[data-stimeo--toast-target='template']",
    );
    const templateItem = template.content.querySelector<HTMLElement>(
      "[data-stimeo--toast-target='item']",
    );
    const templateButton = template.content.querySelector<HTMLButtonElement>("button");
    templateItem?.setAttribute(
      "data-action",
      "mouseenter->stimeo--toast#pause mouseleave->stimeo--toast#resume",
    );
    templateButton?.removeAttribute("data-toast-dismiss");
    templateButton?.setAttribute("data-action", "click->stimeo--toast#dismiss");

    triggerShow("Legacy action notification");
    await tick();
    const toast = item();
    const legacyButton = toast.querySelector<HTMLButtonElement>("button");
    toast.dispatchEvent(new MouseEvent("mouseenter"));
    expect(toast.getAttribute("data-paused")).toBe("true");

    legacyButton?.click();
    expect(list().children.length).toBe(0);
  });

  it("rebinds delegated interaction when the list target is replaced", async () => {
    const replacement = document.createElement("ol");
    replacement.id = "toast-list";
    replacement.setAttribute("data-stimeo--toast-target", "list");
    list().replaceWith(replacement);
    await tick();

    triggerShow("Replacement list notification");
    dismissButton(item())?.click();

    expect(list().children.length).toBe(0);
  });

  it("ignores direct item actions when the required list target is missing", async () => {
    triggerShow("Missing list notification");
    const toast = item();
    list().remove();
    await tick();

    expect(() => controller().dismiss({ currentTarget: toast } as unknown as Event)).not.toThrow();
    expect(() =>
      controller().onKeydown({
        key: "Escape",
        currentTarget: toast,
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent),
    ).not.toThrow();
  });

  it("finalizes one dismissal when a leaving item is dismissed repeatedly", () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    root().addEventListener("stimeo--toast:dismiss", listener);
    triggerShow("Single finalize notification");
    const toast = item();
    toast.style.transitionDuration = "100ms";

    dismissButton(toast)?.click();
    dismissButton(toast)?.click();
    controller().enforceMaxLimit();
    expect(toast.dataset.state).toBe("leaving");
    vi.advanceTimersByTime(100);

    expect(list().children.length).toBe(0);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("waits for the longest transition property including its delay before finalizing", () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    root().addEventListener("stimeo--toast:dismiss", listener);
    triggerShow("Longest transition notification");
    const toast = item();
    // The leave animation spans two properties; the longer one also carries a
    // delay, so removal must wait 100 + 60 = 160ms — not the first value (50ms).
    // Stubbed (not inline styles) so emulator normalization of computed
    // multi-value transition lists cannot skew the parsed timings.
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      transitionProperty: "opacity, transform",
      transitionDuration: "50ms, 100ms",
      transitionDelay: "0ms, 60ms",
    } as CSSStyleDeclaration);

    dismissButton(toast)?.click();
    expect(toast.dataset.state).toBe("leaving");
    vi.advanceTimersByTime(159);
    expect(list().children.length).toBe(1);
    expect(listener).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(list().children.length).toBe(0);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("has no machine-detectable a11y violations with a live toast present", async () => {
    triggerShow("Saved successfully");

    await expectNoA11yViolations(root());
  });

  it("announces listitem, status body, and dismiss button in order", async () => {
    triggerShow("File saved");

    const phrases = await captureSpeech({ container: list(), steps: 7 });
    expect(phrases).toEqual([
      "list",
      "listitem, level 1, position 1, set size 1",
      "status",
      "File saved",
      "end of status",
      "button, Dismiss",
      "end of listitem, level 1, position 1, set size 1",
      "end of list",
    ]);
  });

  it("removes delegated listeners on disconnect", () => {
    triggerShow("Disconnected interaction");
    const toast = item();
    const button = dismissButton(toast);
    controller().disconnect();

    button?.click();
    toast.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(list().children.length).toBe(1);
  });

  it("clears auto-dismiss and pending animation callbacks on disconnect", () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    root().addEventListener("stimeo--toast:dismiss", listener);
    triggerShow("Async teardown notification");
    const toast = item();
    controller().itemTargetConnected(toast);
    expect(toast.dataset.state).toBe("entering");

    controller().disconnect();
    vi.advanceTimersByTime(1_000);

    expect(list().children.length).toBe(1);
    expect(toast.dataset.state).toBe("entering");
    expect(listener).not.toHaveBeenCalled();
  });

  it("clears a real transition-finalize timer on disconnect", () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    root().addEventListener("stimeo--toast:dismiss", listener);
    triggerShow("Finalize teardown notification");
    const toast = item();
    toast.style.transitionDuration = "100ms";
    dismissButton(toast)?.click();
    expect(toast.dataset.state).toBe("leaving");

    controller().disconnect();
    vi.advanceTimersByTime(100);

    expect(list().children.length).toBe(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps multiple controller instances independent", async () => {
    document.body.insertAdjacentHTML("beforeend", markup({ suffix: "-second" }));
    await tick();

    triggerShow("First instance");
    triggerShow("Second instance", "alert", "-second");
    dismissButton(item())?.click();

    expect(list().children.length).toBe(0);
    expect(list("-second").children.length).toBe(1);
    expect(body(item("-second"))?.textContent).toBe("Second instance");
  });
});
