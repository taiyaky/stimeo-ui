import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastController } from "../src/controllers/toast_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ToastController}: list/live-region semantics,
 * delegated interaction, timer policy, the `max` limit and the toasts hover or focus
 * keeps out of its reach, public events, and Turbo-safe teardown.
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
              data-stimeo--toast-message-param="Param notification"
              data-stimeo--toast-type-param="alert">Show</button>
      <div role="region" aria-label="Notifications">
        <ol id="toast-list${suffix}" data-stimeo--toast-target="list"></ol>
        <template data-stimeo--toast-target="template">
          <li data-stimeo--toast-target="item" tabindex="0">
            <span role="status" data-toast-slot="message"></span>
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
  const message = (toast: HTMLElement) =>
    toast.querySelector<HTMLElement>("[data-toast-slot='message']");
  const dismissButton = (toast: HTMLElement) =>
    toast.querySelector<HTMLButtonElement>("[data-toast-dismiss]");

  const triggerShow = (text: string, type: "status" | "alert" = "status", suffix = "") => {
    controller(suffix).show(new CustomEvent("show", { detail: { message: text, type } }));
  };

  /**
   * Disarms auto-dismiss for the fixture. Required by every assertion that runs
   * on the real clock (axe, the virtual screen reader): those walk the DOM over
   * many awaited steps, and a toast removed by the fixture's duration timer
   * mid-walk changes what is being audited. `durationValueChanged` also releases
   * the timer of any toast already on screen.
   */
  const disableAutoDismiss = (suffix = "") => {
    const instance = controller(suffix);
    instance.durationValue = 0;
    instance.durationValueChanged();
  };

  /** Mounts the fixture again with other Values, for a case the default ones do not cover. */
  const remount = async (options: { duration?: number; max?: number }) => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = markup(options);
    application = Application.start();
    application.register("stimeo--toast", ToastController);
    await tick();
  };

  /**
   * Shows a toast and hands it to `itemTargetConnected` directly, the callback a
   * DOM-only environment does not reliably deliver, so the arrival is taken on
   * exactly as the browser would take it on.
   */
  const showArmed = (text: string): HTMLElement => {
    triggerShow(text);
    const toast = list().lastElementChild;
    if (!(toast instanceof HTMLElement)) throw new Error(`Toast ${text} not appended`);
    controller().itemTargetConnected(toast);
    return toast;
  };

  /** The wording of every toast the list holds, in order. */
  const shownNames = () =>
    Array.from(list().children).map((toast) => message(toast as HTMLElement)?.textContent);

  /** Collects every later `dismiss` as `"<reason> <wording>"`, in the order reported. */
  const recordDismissals = (): string[] => {
    const log: string[] = [];
    root().addEventListener("stimeo--toast:dismiss", (event) => {
      const { item: toast, reason } = (event as CustomEvent<{ item: HTMLElement; reason: string }>)
        .detail;
      log.push(`${reason} ${message(toast)?.textContent}`);
    });
    return log;
  };

  const dismissButtonOf = (toast: HTMLElement): HTMLButtonElement => {
    const button = dismissButton(toast);
    if (!button) throw new Error("Dismiss button not found");
    return button;
  };

  /** Moves focus into `into` from outside the list, the way a browser reports it. */
  const focusIn = (into: HTMLElement) =>
    into.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: document.body }));

  /** Moves focus out of `from`, reporting `to` as where it went. */
  const focusOut = (from: HTMLElement, to: Element | null) =>
    from.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: to }));

  /**
   * Lets Stimulus deliver what the setup queued — a Value written through its setter is
   * reported again from a MutationObserver — so a later assertion sees only the pass the
   * test is about, as in a browser where those callbacks ran in an earlier task.
   */
  const settle = () => vi.advanceTimersByTimeAsync(0);

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
    vi.unstubAllGlobals();
  });

  it("starts empty with no elements inside the list", () => {
    expect(list().children.length).toBe(0);
  });

  it("clones a listitem with a nested status region when show is dispatched", () => {
    triggerShow("Success notification");

    const toast = item();
    expect(list().children.length).toBe(1);
    expect(toast.getAttribute("role")).toBeNull();
    expect(message(toast)?.getAttribute("role")).toBe("status");
    expect(message(toast)?.textContent).toBe("Success notification");
    expect(dismissButton(toast)).not.toBeNull();
  });

  // The toast is the template's one element, carrying "item" itself: a wrapper
  // around it would be what the list holds and what a dismissal takes back, so
  // it is refused rather than shown under the wrong node.
  it("shows nothing when the template's one element is not the item", () => {
    const template = requireElement<HTMLTemplateElement>(
      "template[data-stimeo--toast-target='template']",
    );
    const wrapper = document.createElement("div");
    wrapper.append(...template.content.childNodes);
    template.content.append(wrapper);

    triggerShow("Success notification");

    expect(list().children.length).toBe(0);
  });

  it("shows nothing when a second element stands beside the item", () => {
    const template = requireElement<HTMLTemplateElement>(
      "template[data-stimeo--toast-target='template']",
    );
    template.content.append(document.createElement("hr"));

    triggerShow("Success notification");

    expect(list().children.length).toBe(0);
  });

  // The message slot is where the wording goes; a template without one would
  // otherwise append a toast that says nothing at all.
  it("shows nothing when the template's item has no message slot", () => {
    const template = requireElement<HTMLTemplateElement>(
      "template[data-stimeo--toast-target='template']",
    );
    template.content
      .querySelector<HTMLElement>("[data-toast-slot='message']")
      ?.removeAttribute("data-toast-slot");

    triggerShow("Success notification");

    expect(list().children.length).toBe(0);
  });

  it("applies status or alert to the nested live region", () => {
    triggerShow("Emergency alert", "alert");

    expect(message(item())?.getAttribute("role")).toBe("alert");
  });

  it("runs the attribute-only show action through Stimulus", () => {
    requireElement<HTMLButtonElement>("#show-trigger").click();

    expect(message(item())?.textContent).toBe("Param notification");
    expect(message(item())?.getAttribute("role")).toBe("alert");
  });

  it("prefers action params over event detail", () => {
    const event = Object.assign(
      new CustomEvent("show", { detail: { message: "Detail notification", type: "status" } }),
      { params: { message: "Param notification", type: "alert" } },
    );
    controller().show(event);

    expect(message(item())?.textContent).toBe("Param notification");
    expect(message(item())?.getAttribute("role")).toBe("alert");
  });

  it("rejects a missing or non-string message and normalizes an invalid type to status", () => {
    controller().show(new CustomEvent("show", { detail: {} }));
    controller().show(new CustomEvent("show", { detail: { message: 42 } }));
    expect(list().children.length).toBe(0);

    controller().show(
      new CustomEvent("show", { detail: { message: "Normalized notification", type: "urgent" } }),
    );
    expect(message(item())?.getAttribute("role")).toBe("status");
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
    for (let index = 1; index <= 4; index++) showArmed(`Notification ${index}`);
    expect(list().children.length).toBe(3);
    expect(message(list().firstElementChild as HTMLElement)?.textContent).toBe("Notification 2");
  });

  it("limits items to max by removing the oldest first", () => {
    showArmed("First notification");
    showArmed("Second notification");
    showArmed("Third notification");

    expect(list().children.length).toBe(2);
    expect(message(list().firstElementChild as HTMLElement)?.textContent).toBe(
      "Second notification",
    );
  });

  it.each([0, -1])("treats a max of %i as no limit", (max) => {
    controller().maxValue = max;
    controller().maxValueChanged();
    const dismissListener = vi.fn();
    root().addEventListener("stimeo--toast:dismiss", dismissListener);

    for (const text of ["A", "B", "C", "D"]) showArmed(text);

    expect(shownNames()).toEqual(["A", "B", "C", "D"]);
    expect(dismissListener).not.toHaveBeenCalled();
  });

  it("treats a max that is not a number as no limit", async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = markup().replace(
      'data-stimeo--toast-max-value="2"',
      'data-stimeo--toast-max-value="abc"',
    );
    application = Application.start();
    application.register("stimeo--toast", ToastController);
    await tick();
    const dismissed = recordDismissals();

    for (const text of ["A", "B", "C", "D"]) showArmed(text);

    expect(shownNames()).toEqual(["A", "B", "C", "D"]);
    expect(dismissed).toEqual([]);
  });

  // --- the cap and a held toast ----------------------------------------------

  it("reports a toast the cap removes with reason 'limit'", () => {
    const dismissed = recordDismissals();
    showArmed("A");
    showArmed("B");
    showArmed("C");

    expect(dismissed).toEqual(["limit A"]);
    expect(shownNames()).toEqual(["B", "C"]);
  });

  it.each([
    ["a toast arrives past the cap", () => showArmed("C")],
    [
      "max is lowered below the count",
      () => {
        controller().maxValue = 1;
        controller().maxValueChanged();
      },
    ],
  ])("passes over the oldest toast while focus holds it when %s", (_label, overflow) => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    showArmed("B");
    focusIn(a);

    // Taking the held toast away would take the focused control with it, so the cap
    // falls on the oldest toast nothing holds, on either path.
    overflow();

    expect(dismissed).toEqual(["limit B"]);
    expect(a.isConnected).toBe(true);
  });

  it("passes over a toast the pointer is over", () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    showArmed("B");
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));

    showArmed("C");

    expect(dismissed).toEqual(["limit B"]);
    expect(shownNames()).toEqual(["A", "C"]);
  });

  it("holds a toast that never auto-dismisses against the cap, without marking it paused", async () => {
    await remount({ duration: 0 });
    const dismissed = recordDismissals();
    const a = showArmed("A");
    showArmed("B");
    focusIn(a);

    // No timer runs, so none is paused: the hook stays off while the hold still counts.
    expect(a.hasAttribute("data-paused")).toBe(false);
    showArmed("C");

    expect(dismissed).toEqual(["limit B"]);
    expect(shownNames()).toEqual(["A", "C"]);
  });

  it("keeps the arrival past the cap while every other toast is held", () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    const b = showArmed("B");
    focusIn(a);
    b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));

    showArmed("C");

    expect(dismissed).toEqual([]);
    expect(shownNames()).toEqual(["A", "B", "C"]);
  });

  it("applies the cap again with reason 'limit' once the last hold on a toast is released", async () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    const b = showArmed("B");
    focusIn(a);
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    showArmed("C");
    await settle();

    // Focus still holds A after the pointer leaves it, so the list stays over the cap.
    a.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    await flushMicrotasks();
    expect(dismissed).toEqual([]);

    focusOut(a, document.body);
    await flushMicrotasks();
    expect(dismissed).toEqual(["limit A"]);
    expect(shownNames()).toEqual(["B", "C"]);
  });

  it("applies nothing again for a release on a toast nothing held", async () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    const b = showArmed("B");
    focusIn(a);
    b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    const c = showArmed("C");
    await settle();

    // A pointer that never entered the arrival cannot release it, so the arrival keeps
    // the place it was shown in.
    c.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    await flushMicrotasks();

    expect(dismissed).toEqual([]);
    expect(shownNames()).toEqual(["A", "B", "C"]);
  });

  it("spares the toast focus moves into when the cap is applied again", async () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    const b = showArmed("B");
    focusIn(a);
    b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    controller().maxValue = 1;
    controller().maxValueChanged();
    await settle();
    const c = showArmed("C");
    await settle();
    expect(shownNames()).toEqual(["A", "B", "C"]);

    // Focus goes from A straight to C's button. The release of A arrives before C's own
    // focusin, so C is passed over by name rather than by a hold it has yet to get.
    focusOut(dismissButtonOf(a), dismissButtonOf(c));
    await flushMicrotasks();

    expect(dismissed).toEqual(["limit A"]);
    expect(shownNames()).toEqual(["B", "C"]);
  });

  it.each([
    ["moves", (toast: HTMLElement) => list().appendChild(toast), ["limit A"]],
    ["removes", (toast: HTMLElement) => toast.remove(), []],
  ] as const)(
    "applies the cap only after the release, so a caller that %s the focused toast finishes first",
    async (_label, operate, afterwards) => {
      vi.useFakeTimers();
      const dismissed = recordDismissals();
      const a = showArmed("A");
      const b = showArmed("B");
      focusIn(a);
      b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
      controller().maxValue = 1;
      controller().maxValueChanged();
      await settle();

      // An engine takes a focused node out with a `focusout` while the node is still in
      // place, and carries on with the caller's operation only after that event returns.
      focusOut(dismissButtonOf(a), null);
      expect(a.parentNode).toBe(list());
      operate(a);
      expect(dismissed).toEqual([]);

      await flushMicrotasks();
      expect(dismissed).toEqual([...afterwards]);
      expect(a.parentNode).toBeNull();
      expect(shownNames()).toEqual(["B"]);
    },
  );

  it("spares a toast only in the pass that follows the move into it", async () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    const b = showArmed("B");
    focusIn(a);
    b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    controller().maxValue = 1;
    controller().maxValueChanged();
    await settle();
    const c = showArmed("C");
    await settle();
    focusOut(dismissButtonOf(a), dismissButtonOf(c));
    await flushMicrotasks();
    expect(dismissed).toEqual(["limit A"]);

    // The pointer then comes and goes over C: the pass that release starts spares nothing.
    c.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    c.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    await flushMicrotasks();

    expect(dismissed).toEqual(["limit A", "limit C"]);
  });

  it("drops the pending pass of the limit when the controller disconnects", async () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    const b = showArmed("B");
    focusIn(a);
    b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    showArmed("C");
    await settle();

    focusOut(a, document.body);
    controller().disconnect();
    await flushMicrotasks();

    expect(dismissed).toEqual([]);
  });

  it("runs no pass of the limit queued before a reconnect on the next connection", async () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    const b = showArmed("B");
    const button = dismissButtonOf(a);
    button.focus();
    b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    const c = showArmed("C");
    await settle();
    expect(shownNames()).toEqual(["A", "B", "C"]);

    // The pointer leaves B, which queues a pass of the limit, and in the same task the
    // same instance disconnects and connects again. That connection applies no limit of
    // its own, and the pass queued before it does not run on it.
    b.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    controller().disconnect();
    for (const toast of Array.from(list().children)) {
      controller().itemTargetConnected(toast as HTMLElement);
    }
    controller().connect();
    await flushMicrotasks();

    expect(dismissed).toEqual([]);
    expect([a.isConnected, b.isConnected, c.isConnected]).toEqual([true, true, true]);
    expect(document.activeElement).toBe(button);
  });

  it("applies the limit again when a toast something holds is dismissed", async () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    const b = showArmed("B");
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    focusIn(b);
    controller().maxValue = 1;
    controller().maxValueChanged();
    await settle();
    showArmed("C");
    await settle();
    expect(shownNames()).toEqual(["A", "B", "C"]);

    // B's holds leave with it, so the list is held over the limit by A alone.
    dismissButtonOf(b).click();
    await flushMicrotasks();

    expect(dismissed).toEqual(["user B", "limit C"]);
    expect(shownNames()).toEqual(["A"]);
  });

  it("applies the limit again when a script takes out a toast something holds", async () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    const b = showArmed("B");
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    controller().maxValue = 1;
    controller().maxValueChanged();
    await settle();
    showArmed("C");
    await settle();
    expect(shownNames()).toEqual(["A", "B", "C"]);

    b.remove();
    controller().itemTargetDisconnected(b);
    await flushMicrotasks();

    expect(dismissed).toEqual(["limit C"]);
    expect(shownNames()).toEqual(["A"]);
  });

  it("keeps the hold across a duration switched off and on, and marks the timer paused again", () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    focusIn(a);
    expect(a.getAttribute("data-paused")).toBe("true");

    controller().durationValue = 0;
    controller().durationValueChanged();
    expect(a.hasAttribute("data-paused")).toBe(false);

    // A timer set while focus still holds the toast waits for the release.
    controller().durationValue = 500;
    controller().durationValueChanged();
    expect(a.getAttribute("data-paused")).toBe("true");
    vi.advanceTimersByTime(5_000);
    expect(a.isConnected).toBe(true);

    focusOut(a, document.body);
    expect(a.hasAttribute("data-paused")).toBe(false);
    vi.advanceTimersByTime(500);
    expect(dismissed).toEqual(["timeout A"]);
  });

  it("marks the timer paused when it is set on a toast the pointer reached first", () => {
    vi.useFakeTimers();
    triggerShow("A");
    const a = item();
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    expect(a.hasAttribute("data-paused")).toBe(false);

    controller().itemTargetConnected(a);
    expect(a.getAttribute("data-paused")).toBe("true");
    vi.advanceTimersByTime(5_000);
    expect(a.isConnected).toBe(true);

    a.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    expect(a.hasAttribute("data-paused")).toBe(false);
    vi.advanceTimersByTime(200);
    expect(a.isConnected).toBe(false);
  });

  /** Puts a toast in the list the way a restored snapshot brings one back, marks included. */
  const restoreToast = (text: string, marks: string): HTMLElement => {
    list().insertAdjacentHTML(
      "beforeend",
      `<li data-stimeo--toast-target="item" tabindex="0" ${marks}>
         <span role="status" data-toast-slot="message">${text}</span>
         <button type="button" data-toast-dismiss>Dismiss</button>
       </li>`,
    );
    return list().lastElementChild as HTMLElement;
  };

  it("drops a paused mark a restored toast carries when nothing holds it", () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = restoreToast("A", 'data-state="visible" data-paused="true"');

    controller().itemTargetConnected(a);

    expect(a.hasAttribute("data-paused")).toBe(false);
    vi.advanceTimersByTime(200);
    expect(dismissed).toEqual(["timeout A"]);
  });

  it("marks a restored toast paused when focus is inside it as it is taken on", () => {
    vi.useFakeTimers();
    // Focus arrives while no controller listens, as it can before a restored page connects.
    controller().disconnect();
    const a = restoreToast("A", 'data-state="visible"');
    const button = dismissButtonOf(a);
    button.focus();

    controller().itemTargetConnected(a);
    controller().connect();

    expect(a.getAttribute("data-paused")).toBe("true");
    vi.advanceTimersByTime(5_000);
    expect(a.isConnected).toBe(true);
  });

  it("counts only the toasts still shown against the cap", () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    showArmed("B");
    a.style.transitionDuration = "100ms";
    dismissButtonOf(a).click();
    expect(a.dataset.state).toBe("leaving");

    // A is on its way out, so B and the arrival are the two the list shows.
    showArmed("C");

    expect(dismissed).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(dismissed).toEqual(["user A"]);
    expect(shownNames()).toEqual(["B", "C"]);
  });

  // --- a toast that moves within the list -----------------------------------

  /**
   * Replays what Stimulus reports for a move within the list: the item's target
   * disconnects and connects again in one batch, once the node already sits where it
   * went. Called directly, because a DOM-only environment does not reliably deliver
   * target callbacks; the node stays where it is, as a `moveBefore` in place leaves it.
   */
  const reportMove = (toast: HTMLElement) => {
    controller().itemTargetDisconnected(toast);
    controller().itemTargetConnected(toast);
  };

  it("keeps the hold of a focused toast that moves within the list", () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    showArmed("B");
    const button = dismissButtonOf(a);
    button.focus();
    expect(a.getAttribute("data-paused")).toBe("true");

    reportMove(a);
    showArmed("C");

    expect(dismissed).toEqual(["limit B"]);
    expect(a.isConnected).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(a.getAttribute("data-paused")).toBe("true");
  });

  it("keeps the deadline and the shown state of a toast that moves within the list", () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    // The entering frame has run by the time a person could move the toast.
    a.setAttribute("data-state", "visible");
    vi.advanceTimersByTime(150);

    reportMove(a);

    expect(a.dataset.state).toBe("visible");
    vi.advanceTimersByTime(50);
    expect(dismissed).toEqual(["timeout A"]);
  });

  /**
   * Holds every requested animation frame until a test paints, the way an engine runs
   * them once per frame; cancelling one drops it.
   */
  const stubFrames = () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextHandle = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => frames.delete(handle));
    return {
      pending: () => frames.size,
      paint: () => {
        const due = [...frames.values()];
        frames.clear();
        for (const callback of due) callback(0);
      },
    };
  };

  /**
   * Answers `:hover` for `toast` from `hovered`. This DOM-only environment has no pointer,
   * so the engine's answer is modelled. After a move an engine can go on answering from
   * before the move until the pointer moves again.
   */
  const stubHover = (toast: HTMLElement, hovered: () => boolean) => {
    const matches = toast.matches.bind(toast);
    vi.spyOn(toast, "matches").mockImplementation((selector: string) =>
      selector === ":hover" ? hovered() : matches(selector),
    );
  };

  /** Moves the pointer somewhere on the page, the way a person does. */
  const movePointer = () =>
    document.body.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));

  /**
   * Reports whether the controller is listening for the pointer to move: every
   * `pointermove` registration it makes on the document from here on, and whether one of
   * them is still live.
   */
  const watchPointerListener = () => {
    const signals: AbortSignal[] = [];
    const add = document.addEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
      if (type === "pointermove" && typeof options === "object" && options.signal) {
        signals.push(options.signal);
      }
      add(type, listener, options);
    });
    return { listening: () => signals.some((signal) => !signal.aborted) };
  };

  const pointerOver = (toast: HTMLElement) =>
    toast.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }),
    );

  it("keeps a hover hold a move leaves until the pointer moves, however many frames run", () => {
    vi.useFakeTimers();
    const frames = stubFrames();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    frames.paint(); // the entering frame
    pointerOver(a);
    stubHover(a, () => false);

    // A move fires no `mouseout`, and `:hover` may still answer from before it: the
    // reading says nothing about where the pointer is now.
    reportMove(a);
    frames.paint();
    frames.paint();
    frames.paint();
    vi.advanceTimersByTime(5_000);

    expect(a.getAttribute("data-paused")).toBe("true");
    expect(dismissed).toEqual([]);
  });

  it("lets a hover hold go once the pointer moves and the moved toast is not under it", async () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    const b = showArmed("B");
    pointerOver(a);
    pointerOver(b);
    showArmed("C");
    await settle();
    let hovered = true;
    stubHover(a, () => hovered);

    reportMove(a);
    hovered = false;
    movePointer();

    expect(a.hasAttribute("data-paused")).toBe(false);
    await flushMicrotasks();
    // The release applies the limit again, and A is the oldest toast nothing holds.
    expect(dismissed).toEqual(["limit A"]);
  });

  it("keeps the hover hold once the pointer moves over the moved toast", () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    pointerOver(a);
    stubHover(a, () => true);

    reportMove(a);
    movePointer();
    vi.advanceTimersByTime(5_000);

    expect(a.getAttribute("data-paused")).toBe("true");
    expect(dismissed).toEqual([]);
  });

  it("reads hover on the first pointer movement for every toast moved before it", () => {
    vi.useFakeTimers();
    const a = showArmed("A");
    const b = showArmed("B");
    pointerOver(a);
    pointerOver(b);
    stubHover(a, () => false);
    stubHover(b, () => false);

    reportMove(a);
    reportMove(b);
    movePointer();

    expect(a.hasAttribute("data-paused")).toBe(false);
    expect(b.hasAttribute("data-paused")).toBe(false);
  });

  it("reads a moved toast's hover on the first pointer movement only", () => {
    vi.useFakeTimers();
    const watch = watchPointerListener();
    const a = showArmed("A");
    pointerOver(a);
    let hovered = true;
    stubHover(a, () => hovered);

    reportMove(a);
    expect(watch.listening()).toBe(true);
    movePointer();
    expect(watch.listening()).toBe(false);

    // Past the first movement the toast's own `mouseout` says when the pointer leaves.
    hovered = false;
    movePointer();
    expect(a.getAttribute("data-paused")).toBe("true");
  });

  it("reads a moved toast's hover on the first pointer movement after its move only", () => {
    vi.useFakeTimers();
    const a = showArmed("A");
    const b = showArmed("B");
    pointerOver(a);
    pointerOver(b);
    let aHovered = true;
    stubHover(a, () => aHovered);
    stubHover(b, () => true);
    reportMove(a);
    movePointer();

    // B moves later. The movement after that reads B; A is left to its own `mouseout`.
    aHovered = false;
    reportMove(b);
    movePointer();

    expect(a.getAttribute("data-paused")).toBe("true");
  });

  it("stops listening for the pointer when the controller disconnects", () => {
    vi.useFakeTimers();
    const watch = watchPointerListener();
    const a = showArmed("A");
    pointerOver(a);

    reportMove(a);
    expect(watch.listening()).toBe(true);
    controller().disconnect();

    expect(watch.listening()).toBe(false);
  });

  it("stops listening for the pointer once no moved toast is left to read", () => {
    vi.useFakeTimers();
    const watch = watchPointerListener();
    const a = showArmed("A");
    const b = showArmed("B");
    pointerOver(a);
    pointerOver(b);
    reportMove(a);
    reportMove(b);

    dismissButtonOf(a).click();
    expect(watch.listening()).toBe(true);
    dismissButtonOf(b).click();

    expect(watch.listening()).toBe(false);
  });

  it("forgets moves from before a reconnect", () => {
    vi.useFakeTimers();
    const a = showArmed("A");
    pointerOver(a);
    reportMove(a);
    controller().disconnect();
    controller().itemTargetConnected(a);
    controller().connect();
    pointerOver(a);
    stubHover(a, () => false);

    // Only B moves on this connection, so the pointer movement reads A's hover no more.
    const b = showArmed("B");
    pointerOver(b);
    reportMove(b);
    movePointer();

    expect(a.getAttribute("data-paused")).toBe("true");
  });

  it("lets go of a focus hold once focus is no longer in a moved toast", () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    showArmed("B");
    // Held by a focusin while focus itself rests elsewhere: an engine that ends focus
    // on removal without a focusout leaves exactly this behind.
    focusIn(a);
    expect(document.activeElement).not.toBe(dismissButtonOf(a));

    reportMove(a);
    showArmed("C");

    expect(dismissed).toEqual(["limit A"]);
  });

  it("forgets a toast that leaves the list, and takes it on anew when it comes back", () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    vi.advanceTimersByTime(150);
    focusIn(a);
    expect(a.getAttribute("data-paused")).toBe("true");

    a.remove();
    controller().itemTargetDisconnected(a);
    expect(a.hasAttribute("data-paused")).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(dismissed).toEqual([]);

    // Back in the list it is a new arrival: a full deadline, and no hold carried over.
    list().appendChild(a);
    controller().itemTargetConnected(a);
    vi.advanceTimersByTime(199);
    expect(dismissed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(dismissed).toEqual(["timeout A"]);
  });

  it("takes every toast on anew after the controller reconnects", () => {
    vi.useFakeTimers();
    const a = showArmed("A");
    a.setAttribute("data-state", "visible");

    controller().disconnect();
    controller().itemTargetConnected(a);
    controller().connect();

    expect(a.dataset.state).toBe("entering");
  });

  it("evicts nothing when the same instance connects again over the limit", () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    const b = showArmed("B");
    stubHover(a, () => true);
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    const button = dismissButtonOf(b);
    button.focus();
    const c = showArmed("C");
    expect(shownNames()).toEqual(["A", "B", "C"]);

    // Stimulus reports the toasts the list already holds one by one, before `connect()`.
    // Each is taken on with its holds and only the ones taken on count, so the toast kept
    // past the limit as it arrived stays, as it did before the reconnect.
    controller().disconnect();
    for (const toast of Array.from(list().children)) {
      controller().itemTargetConnected(toast as HTMLElement);
    }
    controller().connect();

    expect(dismissed).toEqual([]);
    expect([a.isConnected, b.isConnected, c.isConnected]).toEqual([true, true, true]);
    expect(document.activeElement).toBe(button);
  });

  it.each([
    [
      "prepended",
      (a: HTMLElement): HTMLElement => {
        list().insertAdjacentHTML(
          "afterbegin",
          `<li data-stimeo--toast-target="item" tabindex="0">
             <span role="status" data-toast-slot="message">C</span>
             <button type="button" data-toast-dismiss>Dismiss</button>
           </li>`,
        );
        const c = list().firstElementChild as HTMLElement;
        controller().itemTargetConnected(c);
        expect(list().firstElementChild).not.toBe(a);
        return c;
      },
    ],
    [
      "moved to the front",
      (a: HTMLElement): HTMLElement => {
        const c = showArmed("C");
        list().insertBefore(c, a);
        reportMove(c);
        return c;
      },
    ],
  ] as const)(
    "evicts nothing when the same instance connects again with the spared toast %s",
    (_label, spare) => {
      vi.useFakeTimers();
      const dismissed = recordDismissals();
      const a = showArmed("A");
      const b = showArmed("B");
      stubHover(a, () => true);
      a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
      const button = dismissButtonOf(b);
      button.focus();
      const c = spare(a);
      expect(shownNames()).toEqual(["C", "A", "B"]);

      // Stimulus reports the toasts again in DOM order, the spared one first. A reconnect
      // of the same instance applies no limit, so nothing the list showed goes.
      controller().disconnect();
      for (const toast of Array.from(list().children)) {
        controller().itemTargetConnected(toast as HTMLElement);
      }
      controller().connect();

      expect(dismissed).toEqual([]);
      expect(c.isConnected).toBe(true);
      expect(document.activeElement).toBe(button);
    },
  );

  it("counts only the toasts taken on when two arrive in one batch", () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    for (const text of ["A", "B"]) {
      const toast = showArmed(text);
      stubHover(toast, () => true);
      toast.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }),
      );
    }
    // C and D enter the list in one batch, and Stimulus reports them one after the other.
    triggerShow("C");
    triggerShow("D");
    const [c, d] = Array.from(list().children).slice(2) as HTMLElement[];

    // When C is taken on the list is over the limit and D has not been reported yet: it is
    // neither counted nor taken away, and in its own turn it is the arrival C gives way to.
    controller().itemTargetConnected(c as HTMLElement);
    expect(dismissed).toEqual([]);
    controller().itemTargetConnected(d as HTMLElement);

    expect(dismissed).toEqual(["limit C"]);
    expect(d?.isConnected).toBe(true);
  });

  it("takes the toasts on one by one when the controller first connects, passing over the held one", async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = markup();
    const a = restoreToast("A", 'data-state="visible"');
    restoreToast("B", 'data-state="visible"');
    restoreToast("C", 'data-state="visible"');
    const button = dismissButtonOf(a);
    button.focus();
    const dismissed = recordDismissals();

    // Stimulus reports `max`, then each toast, before `connect()` runs.
    application = Application.start();
    application.register("stimeo--toast", ToastController);
    await tick();

    expect(dismissed).toEqual(["limit B"]);
    expect(a.isConnected).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it("holds a fresh list to the limit once connect() has taken every toast on", async () => {
    const log: string[] = [];
    class Probe extends ToastController {
      override itemTargetConnected(element: HTMLElement): void {
        log.push(`take ${message(element)?.textContent}`);
        super.itemTargetConnected(element);
      }

      override connect(): void {
        log.push("connect");
        super.connect();
      }
    }
    disconnectAndStopApplication(application);
    document.body.innerHTML = markup();
    for (const text of ["A", "B", "C"]) restoreToast(text, 'data-state="visible"');
    root().addEventListener("stimeo--toast:dismiss", (event) => {
      const { item: toast, reason } = (event as CustomEvent<{ item: HTMLElement; reason: string }>)
        .detail;
      log.push(`${reason} ${message(toast)?.textContent}`);
    });

    application = Application.start();
    application.register("stimeo--toast", Probe);
    await tick();

    expect(log).toEqual(["take A", "take B", "take C", "connect", "limit A"]);
  });

  it.each(["appended", "prepended"] as const)(
    "evicts nothing when Stimulus connects the same instance again with max left to its default, the arrival %s",
    async (order) => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = markup({ includeValues: false });
      application = Application.start();
      application.register("stimeo--toast", ToastController);
      await tick();
      const dismissed = recordDismissals();
      const instance = controller();
      const take = (text: string, where: "beforeend" | "afterbegin" = "beforeend") => {
        list().insertAdjacentHTML(
          where,
          `<li data-stimeo--toast-target="item" tabindex="0">
             <span role="status" data-toast-slot="message">${text}</span>
             <button type="button" data-toast-dismiss>Dismiss</button>
           </li>`,
        );
        const toast = (
          where === "afterbegin" ? list().firstElementChild : list().lastElementChild
        ) as HTMLElement;
        instance.itemTargetConnected(toast);
        return toast;
      };
      const a = take("A");
      const b = take("B");
      const c = take("C");
      // Focus holds A, the pointer rests on B, and the page holds C through the public
      // `pause` action. D arrives past the default max and stays.
      const button = dismissButtonOf(a);
      button.focus();
      stubHover(b, () => true);
      b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
      c.addEventListener("app:hold", (event) => instance.pause(event));
      c.dispatchEvent(new CustomEvent("app:hold", { bubbles: true }));
      take("D", order === "appended" ? "beforeend" : "afterbegin");
      expect(list().children).toHaveLength(4);
      expect(dismissed).toEqual([]);

      // Taking the identifier off and putting it back reconnects the same instance, and
      // Stimulus reports the default of every Value the markup leaves out before connect().
      root().removeAttribute("data-controller");
      await tick();
      root().setAttribute("data-controller", "stimeo--toast");
      await tick();

      expect(controller()).toBe(instance);
      expect(dismissed).toEqual([]);
      expect(list().children).toHaveLength(4);
      expect(document.activeElement).toBe(button);
    },
  );

  it("keeps the list as it was on a same-instance reconnect after max changed while connected", async () => {
    await remount({ max: 3 });
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    const b = showArmed("B");
    const button = dismissButtonOf(a);
    button.focus();
    stubHover(b, () => true);
    b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    controller().maxValue = 1;
    controller().maxValueChanged();
    await settle();
    const c = showArmed("C");
    expect(shownNames()).toEqual(["A", "B", "C"]);

    // The list was held to this max while connected, so connecting again holds it to
    // nothing new.
    controller().disconnect();
    for (const toast of Array.from(list().children)) {
      controller().itemTargetConnected(toast as HTMLElement);
    }
    controller().connect();

    expect(dismissed).toEqual([]);
    expect(c.isConnected).toBe(true);
  });

  it("holds the list to nothing new when max is written again as the same number while the same instance is away", async () => {
    await remount({ duration: 0, max: 2 });
    const dismissed = recordDismissals();
    const instance = controller();
    showArmed("A");
    showArmed("B");

    // Away, a toast comes in and `max` is written again in another spelling of the same
    // number; the reconnect finds the list held to that max already.
    root().removeAttribute("data-controller");
    await tick();
    list().insertAdjacentHTML(
      "beforeend",
      `<li data-stimeo--toast-target="item" tabindex="0">
         <span role="status" data-toast-slot="message">C</span>
         <button type="button" data-toast-dismiss>Dismiss</button>
       </li>`,
    );
    root().setAttribute("data-stimeo--toast-max-value", "02");
    await tick();
    root().setAttribute("data-controller", "stimeo--toast");
    await tick();

    expect(controller()).toBe(instance);
    expect(dismissed).toEqual([]);
    expect(shownNames()).toEqual(["A", "B", "C"]);
  });

  it("holds the list to a max that changed while the controller was away, on its next connect", async () => {
    await remount({ max: 3 });
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    for (const text of ["A", "B", "C"]) showArmed(text);

    controller().disconnect();
    root().setAttribute("data-stimeo--toast-max-value", "1");
    controller().maxValueChanged();
    for (const toast of Array.from(list().children)) {
      controller().itemTargetConnected(toast as HTMLElement);
    }
    controller().connect();

    expect(dismissed).toEqual(["limit A", "limit B"]);
    expect(shownNames()).toEqual(["C"]);
  });

  it("ends within the limit when the controller first connects to more toasts than it allows", async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = markup();
    for (const text of ["A", "B", "C"]) restoreToast(text, 'data-state="visible"');
    const dismissed = recordDismissals();

    application = Application.start();
    application.register("stimeo--toast", ToastController);
    await tick();

    expect(dismissed).toEqual(["limit A"]);
    expect(shownNames()).toEqual(["B", "C"]);
  });

  it("holds a toast that focus is inside when the controller takes it on again", () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    const b = showArmed("B");
    const button = dismissButtonOf(a);
    button.focus();

    // A reconnect drops every hold; taking the toasts on again reads focus back.
    controller().disconnect();
    controller().itemTargetConnected(a);
    controller().itemTargetConnected(b);
    controller().connect();
    showArmed("C");

    expect(dismissed).toEqual(["limit B"]);
    expect(document.activeElement).toBe(button);
    expect(a.getAttribute("data-paused")).toBe("true");
  });

  it("holds a toast that reads as hovered as it is taken on, until the pointer moves off it", () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    triggerShow("A");
    const a = item();
    let hovered = true;
    stubHover(a, () => hovered);

    controller().itemTargetConnected(a);
    expect(a.getAttribute("data-paused")).toBe("true");
    vi.advanceTimersByTime(5_000);
    expect(dismissed).toEqual([]);

    // The reading may date from before the toast came here, so the pointer confirms it.
    hovered = false;
    movePointer();
    expect(a.hasAttribute("data-paused")).toBe(false);
    vi.advanceTimersByTime(200);
    expect(dismissed).toEqual(["timeout A"]);
  });

  it("lets go of a toast whose item token is taken off in place", () => {
    vi.useFakeTimers();
    const dismissed = recordDismissals();
    const a = showArmed("A");
    a.setAttribute("data-state", "visible");

    // A morph that rewrites the target attribute leaves the node where it was, but it is
    // no longer a toast, so nothing here may dismiss it or count it.
    a.removeAttribute("data-stimeo--toast-target");
    controller().itemTargetDisconnected(a);
    vi.advanceTimersByTime(5_000);

    expect(dismissed).toEqual([]);
    expect(a.parentNode).toBe(list());
    showArmed("B");
    showArmed("C");
    expect(shownNames()).toEqual(["A", "B", "C"]);
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

  it("leaves an event that resolves to no toast alone", () => {
    vi.useFakeTimers();
    triggerShow("Outside pause notification");
    const toast = item();
    controller().itemTargetConnected(toast);

    // `pause` / `resume` are declared actions, so a consumer may wire them to a
    // container: an event from outside any item names no toast to hold.
    const outside = root();
    controller().pause(new FocusEvent("focusin", { bubbles: true, relatedTarget: outside }));
    controller().resume(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));

    expect(toast.hasAttribute("data-paused")).toBe(false);
    vi.advanceTimersByTime(200);
    expect(list().children.length).toBe(0);
  });

  it("leaves an item target outside the list alone when the controller arms its toasts", async () => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = markup().replace(
      "<template",
      `<div id="stray" data-stimeo--toast-target="item" data-paused="true">Not a toast</div>
       <template`,
    );
    application = Application.start();
    application.register("stimeo--toast", ToastController);
    await tick();
    const stray = requireElement<HTMLElement>("#stray");

    controller().connect();
    controller().durationValue = 500;
    controller().durationValueChanged();

    expect(stray.getAttribute("data-paused")).toBe("true");
  });

  it("arms a toast the list already holds when the controller connects", () => {
    // The target callback that normally arms a toast is delivered through a
    // MutationObserver, which a DOM-only environment does not reliably fire, so
    // `connect()` re-scans the list for toasts nothing is counting down yet.
    vi.useFakeTimers();
    triggerShow("Restored notification");
    const toast = item();

    controller().connect();
    vi.advanceTimersByTime(200);

    expect(toast.isConnected).toBe(false);
  });

  it("keeps a running deadline when the controller connects again", () => {
    // Stimulus may run `connect()` for an element it is already driving; the
    // toasts it is already counting down must not restart from the full duration.
    vi.useFakeTimers();
    triggerShow("Reconnect notification");
    const toast = item();
    controller().itemTargetConnected(toast);
    vi.advanceTimersByTime(150);

    controller().connect();
    vi.advanceTimersByTime(50);

    expect(toast.isConnected).toBe(false);
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

  it("keeps a toast whose deadline lapsed while it is held, and dismisses it once released", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    const dismissed: string[] = [];
    root().addEventListener("stimeo--toast:dismiss", (e) =>
      dismissed.push((e as CustomEvent).detail.reason),
    );
    triggerShow("Expired pause notification");
    const toast = item();
    controller().itemTargetConnected(toast);
    // The deadline passed while the timer sat queued (a throttled tab, a long task).
    vi.setSystemTime(new Date("2026-07-20T00:00:01Z"));

    toast.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: document.body }));

    // Holding is never what takes a toast away.
    expect(toast.getAttribute("data-paused")).toBe("true");
    vi.advanceTimersByTime(5000);
    expect(list().children.length).toBe(1);
    expect(dismissed).toEqual([]);

    toast.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }),
    );
    expect(toast.hasAttribute("data-paused")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(list().children.length).toBe(0);
    expect(dismissed).toEqual(["timeout"]);
  });

  it("keeps focus inside a toast whose deadline lapsed before focus entered it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    triggerShow("Expired pause notification");
    const toast = item();
    controller().itemTargetConnected(toast);
    const button = dismissButton(toast);
    if (!button) throw new Error("Dismiss button not found");

    // Same lapsed-deadline window, entered by focus instead of the pointer.
    // Removing the toast here would take the focused control with it (WCAG 2.2 4.1.3).
    vi.setSystemTime(new Date("2026-07-20T00:00:01Z"));
    button.focus();
    button.dispatchEvent(
      new FocusEvent("focusin", { bubbles: true, relatedTarget: document.body }),
    );

    expect(document.activeElement).toBe(button);
    expect(list().children.length).toBe(1);
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

  // `data-<identifier>-target` is a space-separated token list, so one element
  // declares the name beside other tokens or padded by whitespace. The element
  // the template carries and the toast a dismissal takes back both resolve from it.
  it.each([
    { label: "surrounding whitespace", attribute: " item " },
    { label: "a second token", attribute: "item toast-pinned" },
  ])("resolves an item target declared with $label", ({ attribute }) => {
    const templateItem = requireElement<HTMLTemplateElement>(
      "template[data-stimeo--toast-target='template']",
    ).content.querySelector<HTMLElement>("[data-stimeo--toast-target='item']");
    if (!templateItem) throw new Error("Template item not found");
    templateItem.setAttribute("data-stimeo--toast-target", attribute);

    triggerShow("Token list notification");

    expect(list().children.length).toBe(1);
    const toast = list().firstElementChild;
    if (!(toast instanceof HTMLElement)) throw new Error("Toast not appended");
    expect(message(toast)?.textContent).toBe("Token list notification");

    dismissButton(toast)?.click();

    expect(list().children.length).toBe(0);
  });

  it("keeps per-item pause, resume and dismiss actions on the item markup working", async () => {
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

    triggerShow("Per-item action notification");
    await tick();
    const toast = item();
    const itemButton = toast.querySelector<HTMLButtonElement>("button");
    toast.dispatchEvent(new MouseEvent("mouseenter"));
    expect(toast.getAttribute("data-paused")).toBe("true");

    itemButton?.click();
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
    disableAutoDismiss();
    triggerShow("Saved successfully");

    await expectNoA11yViolations(root());
  });

  it("announces listitem, status message, and dismiss button in order", async () => {
    disableAutoDismiss();
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
    expect(message(item("-second"))?.textContent).toBe("Second instance");
  });
});
