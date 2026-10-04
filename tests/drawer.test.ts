import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrawerController } from "../src/controllers/drawer_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { typeKey } from "./helpers/keyboard";
import { expectUpperModalOnTop, openUpperModal, TARGET_SWAPS } from "./helpers/modal_stack";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents } from "./helpers/state_events";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link DrawerController}: the APG modal contract plus the
 * slide-over plumbing — `data-state` sync, `data-placement` reflection, deferred
 * `hidden`, focus trap, overlay-only backdrop close, and teardown reversal.
 *
 * happy-dom reports no transition duration, so ordinary close assertions hide
 * synchronously; dedicated cases stub the full transition tuple to exercise the
 * deferred path, terminal events, fallback, and target replacement.
 */

const markup = (placement = "right") => `
  <p id="background">Background</p>
  <div data-controller="stimeo--drawer" data-stimeo--drawer-placement-value="${placement}">
    <button id="trigger" data-stimeo--drawer-target="trigger"
            data-action="stimeo--drawer#open">Open</button>
    <div data-stimeo--drawer-target="overlay"
         data-action="click->stimeo--drawer#closeOnBackdrop">
      <div data-stimeo--drawer-target="panel" role="dialog" aria-modal="true"
             aria-labelledby="drawer-title" data-state="closed" hidden>
        <h2 id="drawer-title">Settings</h2>
        <button id="inside">Save</button>
        <button id="close" data-action="stimeo--drawer#close">Close</button>
      </div>
    </div>
  </div>`;

const transitionStyle = (
  property = "transform",
  duration = "0.2s",
  delay = "0s",
): CSSStyleDeclaration =>
  ({
    transitionProperty: property,
    transitionDuration: duration,
    transitionDelay: delay,
  }) as CSSStyleDeclaration;

/** Creates the minimal Web Animations view exposed by a running CSS transition. */
const runningTransition = (propertyName: string): CSSTransition =>
  ({
    playState: "running",
    transitionProperty: propertyName,
  }) as CSSTransition;

const dispatchPanelTransition = (
  panel: HTMLElement,
  type: "transitionend" | "transitioncancel",
  propertyName: string,
): void => {
  const event = new Event(type);
  Object.defineProperty(event, "propertyName", { value: propertyName });
  panel.dispatchEvent(event);
};

describe("DrawerController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = markup();
    application = Application.start();
    application.register("stimeo--drawer", DrawerController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    document.body.style.overflow = "";
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const trigger = () => document.getElementById("trigger") as HTMLButtonElement;
  const panel = () =>
    document.querySelector<HTMLElement>("[data-stimeo--drawer-target='panel']") as HTMLElement;
  const overlay = () =>
    document.querySelector<HTMLElement>("[data-stimeo--drawer-target='overlay']") as HTMLElement;

  it("starts closed with data-state='closed' and hidden", () => {
    expect(panel().hidden).toBe(true);
    expect(panel().getAttribute("data-state")).toBe("closed");
    expect(overlay().hidden).toBe(true);
  });

  it("reflects the placement value as data-placement", () => {
    expect(panel().getAttribute("data-placement")).toBe("right");
  });

  it("re-reflects data-placement when the placement value changes at runtime", () => {
    const root = document.querySelector("[data-controller='stimeo--drawer']") as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(
      root,
      "stimeo--drawer",
    ) as DrawerController;
    root.setAttribute("data-stimeo--drawer-placement-value", "bottom");
    // Drive the reflect directly: Stimulus's value-change observer is
    // MutationObserver-based and intermittently misses the change under parallel
    // load in happy-dom. placementValueChanged re-reads the updated value getter.
    controller.placementValueChanged();
    expect(panel().getAttribute("data-placement")).toBe("bottom");
  });

  it("reflects data-placement again when it reconnects onto a panel without one", () => {
    const root = document.querySelector("[data-controller='stimeo--drawer']") as HTMLElement;
    const controller = application.getControllerForElementAndIdentifier(
      root,
      "stimeo--drawer",
    ) as DrawerController;
    controller.disconnect();
    panel().removeAttribute("data-placement");

    controller.connect();

    expect(panel().getAttribute("data-placement")).toBe("right");
  });

  it("opens: reveals the panel, syncs data-state, and locks scroll", () => {
    trigger().focus();
    trigger().click();
    expect(panel().hidden).toBe(false);
    expect(panel().getAttribute("data-state")).toBe("open");
    expect(overlay().getAttribute("data-state")).toBe("open");
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("moves focus to the first focusable element in the panel", () => {
    trigger().click();
    expect(document.activeElement).toBe(document.getElementById("inside"));
  });

  it("closes: syncs data-state and (transition done) applies hidden", () => {
    trigger().focus();
    trigger().click();
    document.getElementById("close")?.click();
    expect(panel().getAttribute("data-state")).toBe("closed");
    expect(panel().hidden).toBe(true);
    expect(overlay().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on Escape and restores focus", () => {
    trigger().focus();
    trigger().click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(panel().getAttribute("data-state")).toBe("closed");
    expect(document.activeElement).toBe(trigger());
  });

  it("closes when the overlay itself is clicked", () => {
    trigger().click();
    overlay().click();
    expect(panel().getAttribute("data-state")).toBe("closed");
  });

  it("does NOT close when the panel (inside the overlay) is clicked", () => {
    trigger().click();
    panel().click();
    expect(panel().getAttribute("data-state")).toBe("open");
  });

  it("traps Tab focus within the panel", () => {
    trigger().click();
    document.getElementById("close")?.focus(); // last focusable
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(document.getElementById("inside")); // first
  });

  it("takes a Tab that does not wrap and moves to the next focusable itself", () => {
    trigger().click();
    const inside = document.getElementById("inside") as HTMLElement;
    inside.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    inside.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.getElementById("close"));
  });

  it("marks background siblings inert while open and restores them on close", () => {
    const background = document.getElementById("background") as HTMLElement;
    trigger().click();
    expect(background.inert).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(background.inert).toBe(false);
  });

  it("restores scroll and background when disconnected while open", () => {
    const background = document.getElementById("background") as HTMLElement;
    const root = document.querySelector("[data-controller='stimeo--drawer']") as HTMLElement;
    trigger().click();
    expect(document.body.style.overflow).toBe("hidden");
    const controller = application.getControllerForElementAndIdentifier(root, "stimeo--drawer");
    controller?.disconnect();
    expect(document.body.style.overflow).toBe("");
    expect(background.inert).toBe(false);
  });

  it("releases the global keydown listener on disconnect (Escape no longer closes)", () => {
    // Direct probe that the document-level keydown goes away with the teardown:
    // a leaked trap listener would still run onEscape -> close() and flip
    // data-state to "closed" (disconnect leaves the open markup untouched).
    const root = document.querySelector("[data-controller='stimeo--drawer']") as HTMLElement;
    trigger().click();
    const controller = application.getControllerForElementAndIdentifier(root, "stimeo--drawer");
    controller?.disconnect();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(panel().getAttribute("data-state")).toBe("open");
  });

  it("keeps the background inert and scroll locked until the close transition ends", () => {
    // Force a non-zero transition so hidden + modal teardown defer to transitionend.
    const spy = vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
    try {
      const background = document.getElementById("background") as HTMLElement;
      trigger().focus();
      trigger().click();
      expect(background.inert).toBe(true);

      document.getElementById("close")?.click(); // start closing (transition pending)
      // Mid-transition: visually still on screen, so the modal contract must hold.
      expect(panel().getAttribute("data-state")).toBe("closed");
      expect(panel().hidden).toBe(false);
      expect(background.inert).toBe(true);
      expect(document.body.style.overflow).toBe("hidden");

      dispatchPanelTransition(panel(), "transitionend", "transform");
      expect(panel().hidden).toBe(true);
      expect(background.inert).toBe(false);
      expect(document.body.style.overflow).toBe("");
      expect(document.activeElement).toBe(trigger());
    } finally {
      spy.mockRestore();
    }
  });

  it("waits for every transition property and safely completes when the longest is cancelled", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(
      transitionStyle("opacity, transform", "100ms, 200ms", "0ms, 100ms"),
    );
    const background = document.getElementById("background") as HTMLElement;
    trigger().focus();
    trigger().click();
    document.getElementById("close")?.click();

    dispatchPanelTransition(panel(), "transitionend", "opacity");
    expect(panel().hidden).toBe(false);
    expect(background.inert).toBe(true);
    dispatchPanelTransition(panel(), "transitioncancel", "transform");
    expect(panel().hidden).toBe(true);
    expect(background.inert).toBe(false);
    expect(document.body.style.overflow).toBe("");
  });

  it("reopening during the close transition cancels the pending hide", () => {
    // open -> close (transition pending) -> reopen: the stale transitionend
    // listener must be dropped, or the old close would hide the freshly reopened
    // panel (and tear the modal down) when the exit transition finally ends.
    const spy = vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
    try {
      trigger().focus();
      trigger().click();
      document.getElementById("close")?.click(); // close -> pending hide
      expect(panel().hidden).toBe(false); // mid-transition
      trigger().click(); // reopen cancels the pending hide
      expect(panel().getAttribute("data-state")).toBe("open");
      dispatchPanelTransition(panel(), "transitionend", "transform");
      expect(panel().hidden).toBe(false); // still open, not hidden by the stale close
      expect(document.body.style.overflow).toBe("hidden"); // trap stayed active
    } finally {
      spy.mockRestore();
    }
  });

  it("ignores the previous phase's terminal event after reopening and closing again", () => {
    // open -> close -> reopen -> close. The first close's `transitioncancel` is
    // queued before the reopen but can be dispatched after the second close armed
    // its own wait; settling on it would tear the modal down while the panel is
    // still sliding out.
    const spy = vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
    let animations: Animation[] = [];
    Object.defineProperty(panel(), "getAnimations", {
      configurable: true,
      value: () => animations,
    });
    try {
      const background = document.getElementById("background") as HTMLElement;
      trigger().focus();
      trigger().click();
      document.getElementById("close")?.click(); // first close -> pending hide
      trigger().click(); // reopen drops it
      animations = [runningTransition("transform")];
      document.getElementById("close")?.click(); // second close arms its own wait

      dispatchPanelTransition(panel(), "transitioncancel", "transform"); // stale, first close
      expect(panel().hidden).toBe(false);
      expect(background.inert).toBe(true);
      expect(document.body.style.overflow).toBe("hidden");

      animations = [];
      dispatchPanelTransition(panel(), "transitionend", "transform");
      expect(panel().hidden).toBe(true);
      expect(background.inert).toBe(false);
      expect(document.body.style.overflow).toBe("");
      expect(document.activeElement).toBe(trigger());
    } finally {
      spy.mockRestore();
    }
  });

  it("disconnecting during the close transition drops the pending hide and reverts the side effects", () => {
    // Turbo can tear the controller down while the exit transition is running:
    // the side effects must revert immediately, and the pending transitionend
    // listener must go with it (markup is left to Turbo, so no late mutation).
    const spy = vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
    try {
      const background = document.getElementById("background") as HTMLElement;
      const root = document.querySelector("[data-controller='stimeo--drawer']") as HTMLElement;
      trigger().click();
      document.getElementById("close")?.click(); // close -> pending hide
      expect(background.inert).toBe(true); // modal contract still holds mid-transition
      const controller = application.getControllerForElementAndIdentifier(root, "stimeo--drawer");
      controller?.disconnect();
      expect(document.body.style.overflow).toBe("");
      expect(background.inert).toBe(false);
      dispatchPanelTransition(panel(), "transitionend", "transform");
      expect(panel().hidden).toBe(false); // no late hide after teardown
    } finally {
      spy.mockRestore();
    }
  });

  it("finishes modal cleanup when a closing panel target is replaced", async () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
    vi.useFakeTimers();
    const background = document.getElementById("background") as HTMLElement;
    trigger().focus();
    trigger().click();
    document.getElementById("close")?.click();
    const oldPanel = panel();
    const replacement = oldPanel.cloneNode(true) as HTMLElement;
    oldPanel.replaceWith(replacement);
    await vi.advanceTimersByTimeAsync(0);

    expect(panel()).toBe(replacement);
    expect(replacement.getAttribute("data-state")).toBe("closed");
    expect(replacement.hidden).toBe(true);
    expect(overlay().hidden).toBe(true);
    expect(document.body.style.overflow).toBe("");
    expect(background.inert).toBe(false);
    expect(document.activeElement).toBe(trigger());

    vi.advanceTimersByTime(250);
    expect(replacement.hidden).toBe(true);
    expect(document.body.style.overflow).toBe("");
  });

  it("rebinds the modal lifecycle to an open replacement panel", async () => {
    const background = document.getElementById("background") as HTMLElement;
    trigger().focus();
    trigger().click();
    const oldPanel = panel();
    const replacement = oldPanel.cloneNode(true) as HTMLElement;
    oldPanel.replaceWith(replacement);
    await tick();

    expect(panel()).toBe(replacement);
    expect(replacement.getAttribute("data-state")).toBe("open");
    expect(replacement.hidden).toBe(false);
    expect(overlay().hidden).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");
    expect(background.inert).toBe(true);
    expect(document.activeElement).toBe(replacement.querySelector("#inside"));
  });

  it("releases the modal side effects when the open panel is removed", async () => {
    const background = document.getElementById("background") as HTMLElement;
    trigger().focus();
    trigger().click();
    expect(document.body.style.overflow).toBe("hidden");

    panel().remove();
    await tick();

    expect(document.body.style.overflow).toBe("");
    expect(background.inert).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it("closes the overlay together with a panel removed while open", async () => {
    trigger().click();
    expect(overlay().getAttribute("data-state")).toBe("open");

    panel().remove();
    await tick();

    expect(overlay().getAttribute("data-state")).toBe("closed");
    expect(overlay().hidden).toBe(true);
  });

  it("keeps a panel that left while open closed when it comes back", async () => {
    trigger().click();
    const removed = panel();
    removed.remove();
    await tick();

    overlay().append(removed);
    await tick();

    expect(panel()).toBe(removed);
    expect(removed.getAttribute("data-state")).toBe("closed");
    expect(removed.hidden).toBe(true);
    expect(document.body.style.overflow).toBe("");
  });

  it("drops the close-transition wait when the closing panel is removed", async () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
    vi.useFakeTimers();
    trigger().click();
    document.getElementById("close")?.click(); // exit transition pending
    const closing = panel();
    const released = vi.spyOn(closing, "removeEventListener");

    closing.remove();
    await vi.advanceTimersByTimeAsync(0);

    expect(released.mock.calls.map(([type]) => type)).toEqual(
      expect.arrayContaining(["transitionend", "transitioncancel"]),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an open replacement that arrives before the closing panel leaves on screen", async () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
    vi.useFakeTimers();
    const background = document.getElementById("background") as HTMLElement;
    trigger().focus();
    trigger().click();
    document.getElementById("close")?.click(); // exit transition pending
    const closing = panel();
    const replacement = closing.cloneNode(true) as HTMLElement;
    replacement.setAttribute("data-state", "open");
    closing.before(replacement);
    closing.remove();
    await vi.advanceTimersByTimeAsync(0);
    expect(panel()).toBe(replacement);
    expect(overlay().hidden).toBe(false);

    // The overtaken close would have settled by now.
    vi.advanceTimersByTime(250);

    expect(overlay().hidden).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");
    expect(background.inert).toBe(true);
  });

  it("opens the overlay with a replacement panel that arrives open", async () => {
    expect(overlay().getAttribute("data-state")).toBe("closed");
    const replacement = panel().cloneNode(true) as HTMLElement;
    replacement.setAttribute("data-state", "open");
    replacement.hidden = false;

    panel().replaceWith(replacement);
    await tick();

    expect(panel()).toBe(replacement);
    expect(overlay().getAttribute("data-state")).toBe("open");
    expect(overlay().hidden).toBe(false);
  });

  it("closes the overlay with a closed replacement that arrives before the open panel leaves", async () => {
    trigger().click();
    const open = panel();
    const replacement = open.cloneNode(true) as HTMLElement;
    replacement.setAttribute("data-state", "closed");
    replacement.hidden = true;

    open.before(replacement);
    open.remove();
    await tick();

    expect(panel()).toBe(replacement);
    expect(overlay().getAttribute("data-state")).toBe("closed");
    expect(overlay().hidden).toBe(true);
  });

  it.each(TARGET_SWAPS)(
    "keeps a modal opened over it on top when its open panel is replaced %s",
    async (_, swap) => {
      trigger().focus();
      trigger().click();
      const upper = openUpperModal();
      const successor = panel().cloneNode(true) as HTMLElement;
      await swap(panel(), successor);

      expectUpperModalOnTop(upper, successor);
      expect(successor.getAttribute("data-state")).toBe("open");
      expect(overlay().hidden).toBe(false);
      typeKey(document, "Escape");
      expect(successor.hidden).toBe(true);
      expect(document.activeElement).toBe(trigger());
    },
  );

  it("keeps an open drawer and its modal side effects through turbo:before-cache", () => {
    // Turbo also dispatches the event on a page that stays (a promoted frame
    // navigation, a popstate without Turbo state, a refresh of a cached URL).
    const background = document.getElementById("background") as HTMLElement;
    trigger().click();
    expect(background.inert).toBe(true);

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(document.body.style.overflow).toBe("hidden");
    expect(background.inert).toBe(true);
    expect(panel().getAttribute("data-state")).toBe("open");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel().getAttribute("data-state")).not.toBe("open");
  });

  describe("a copy of the page Turbo restores", () => {
    const restore = async (): Promise<void> => {
      application = await restoreFromCache(application, (restored) =>
        restored.register("stimeo--drawer", DrawerController),
      );
    };
    const root = () =>
      document.querySelector<HTMLElement>("[data-controller='stimeo--drawer']") as HTMLElement;

    it("shows a drawer that was open closed, with the page operable and nothing reported", async () => {
      trigger().click();
      expect(panel().getAttribute("data-state")).toBe("open");
      const events = captureStateEvents("stimeo--drawer");

      await restore();

      expect(panel().getAttribute("data-state")).toBe("closed");
      expect(panel().hidden).toBe(true);
      expect(overlay().getAttribute("data-state")).toBe("closed");
      expect(overlay().hidden).toBe(true);
      expect(root().getAttribute("data-stimeo--drawer-open-value")).toBe("false");
      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
      expect(document.body.style.overflow).toBe("");
      expect(events.seen).toEqual([]);
      events.stop();

      trigger().click();
      expect(panel().getAttribute("data-state")).toBe("open");
      expect(document.body.style.overflow).toBe("hidden");
      typeKey(document, "Escape");
      expect(panel().getAttribute("data-state")).toBe("closed");
      expect(document.body.style.overflow).toBe("");
    });

    it("shows a drawer the server rendered open closed once restored", async () => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = markup().replace(
        'data-controller="stimeo--drawer"',
        'data-controller="stimeo--drawer" data-stimeo--drawer-open-value="true"',
      );
      application = Application.start();
      application.register("stimeo--drawer", DrawerController);
      await tick();
      expect(panel().getAttribute("data-state")).toBe("open");

      await restore();

      expect(panel().getAttribute("data-state")).toBe("closed");
      expect(document.body.style.overflow).toBe("");
    });

    /** Renders the drawer with its panel and overlay written open, as a server may. */
    const startAuthoredOpen = async (): Promise<void> => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = markup()
        .replace('data-state="closed" hidden', 'data-state="open"')
        .replace(
          'data-action="click->stimeo--drawer#closeOnBackdrop">',
          'data-action="click->stimeo--drawer#closeOnBackdrop" data-state="open">',
        );
      application = Application.start();
      application.register("stimeo--drawer", DrawerController);
      await tick();
    };

    it("shows a drawer whose panel the server wrote open closed once restored, silently", async () => {
      await startAuthoredOpen();
      expect(panel().getAttribute("data-state")).toBe("open");
      expect(document.body.style.overflow).toBe("hidden");
      const events = captureStateEvents("stimeo--drawer");

      await restore();

      expect(panel().getAttribute("data-state")).toBe("closed");
      expect(panel().hidden).toBe(true);
      expect(overlay().getAttribute("data-state")).toBe("closed");
      expect(overlay().hidden).toBe(true);
      expect(root().getAttribute("data-stimeo--drawer-open-value")).toBe("false");
      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
      expect(document.body.style.overflow).toBe("");
      expect(events.seen).toEqual([]);
      events.stop();

      trigger().click();
      expect(panel().getAttribute("data-state")).toBe("open");
      typeKey(document, "Escape");
      expect(panel().getAttribute("data-state")).toBe("closed");
    });

    it("shows a drawer the server wrote open closed in a copy taken after it disconnected", async () => {
      await startAuthoredOpen();
      disconnectAndStopApplication(application);
      expect(panel().getAttribute("data-state")).toBe("open");

      await restore();

      expect(panel().getAttribute("data-state")).toBe("closed");
      expect(document.body.style.overflow).toBe("");
    });

    it("shows a drawer the server wrote open closed once restored after a morph dropped its mark", async () => {
      await startAuthoredOpen();
      const mark = root()
        .getAttributeNames()
        .filter((name) => name.endsWith("-lived"));
      expect(mark).toEqual(["data-stimeo--drawer-lived"]);
      // A Turbo morph keeps only the attributes the server sent.
      root().removeAttribute("data-stimeo--drawer-lived");
      root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      await flushMicrotasks();
      expect(panel().getAttribute("data-state")).toBe("open");

      await restore();

      expect(panel().getAttribute("data-state")).toBe("closed");
      expect(document.body.style.overflow).toBe("");
    });

    it("stops writing its mark back after a morph once disconnected, and keeps it", async () => {
      const instance = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--drawer",
      ) as DrawerController;
      instance.disconnect();
      expect(root().hasAttribute("data-stimeo--drawer-lived")).toBe(true);

      root().removeAttribute("data-stimeo--drawer-lived");
      root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      await flushMicrotasks();

      expect(root().hasAttribute("data-stimeo--drawer-lived")).toBe(false);
    });

    it("keeps a drawer the server wrote open open when its element moves within the page", async () => {
      await startAuthoredOpen();
      const instance = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--drawer",
      ) as DrawerController;

      instance.disconnect();
      instance.connect();

      expect(panel().getAttribute("data-state")).toBe("open");
      expect(document.body.style.overflow).toBe("hidden");
      expect((document.getElementById("background") as HTMLElement).inert).toBe(true);
    });

    it("keeps a closed drawer closed", async () => {
      trigger().click();
      typeKey(document, "Escape");

      await restore();

      expect(panel().getAttribute("data-state")).toBe("closed");
      expect(panel().hidden).toBe(true);
    });
  });

  it("stays open, trap included, when its element moves within the page", () => {
    trigger().click();
    const instance = application.getControllerForElementAndIdentifier(
      document.querySelector("[data-controller='stimeo--drawer']") as HTMLElement,
      "stimeo--drawer",
    ) as DrawerController;

    instance.disconnect();
    instance.connect();

    expect(panel().getAttribute("data-state")).toBe("open");
    expect(document.body.style.overflow).toBe("hidden");
    expect((document.getElementById("background") as HTMLElement).inert).toBe(true);
  });

  it("has no machine-detectable a11y violations while open", async () => {
    trigger().click();
    await expectNoA11yViolations(document.body);
  });

  it("announces the dialog role, name, and modal state when open", async () => {
    trigger().click();
    const phrases = await captureSpeech({ container: panel(), steps: 1 });
    expect(phrases).toEqual([
      "dialog, Settings, modal",
      "dialog, Settings, modal",
      "heading, Settings, level 2",
    ]);
  });

  // --- State events ---

  describe("state events", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    const root = () => document.querySelector("[data-controller='stimeo--drawer']") as HTMLElement;
    const controller = () => {
      const instance = application.getControllerForElementAndIdentifier(root(), "stimeo--drawer");
      if (!(instance instanceof DrawerController)) throw new Error("drawer controller not found");
      return instance;
    };

    beforeEach(() => {
      capture = captureStateEvents("stimeo--drawer");
    });

    afterEach(() => {
      capture.stop();
    });

    it("reports a trigger click as user, as soon as data-state is written", () => {
      const states: string[] = [];
      root().addEventListener("stimeo--drawer:open", () => {
        states.push(`${panel().getAttribute("data-state")} ${panel().hidden}`);
      });

      trigger().click();

      expect(capture.names()).toEqual(["open"]);
      expect(capture.reasons()).toEqual(["user"]);
      expect(states).toEqual(["open false"]);
      expect(capture.seen[0]?.bubbles).toBe(true);
      expect(capture.seen[0]?.cancelable).toBe(false);
    });

    it("reports a backdrop click as outside and Escape as escape", () => {
      trigger().click();
      capture.clear();
      overlay().click();

      expect(capture.names()).toEqual(["close"]);
      expect(capture.reasons()).toEqual(["outside"]);

      trigger().click();
      capture.clear();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      expect(capture.reasons()).toEqual(["escape"]);
    });

    it("stays silent for an idempotent call in either direction", () => {
      controller().close();
      expect(capture.seen).toEqual([]);

      controller().open();
      capture.clear();
      controller().open();

      expect(capture.seen).toEqual([]);
    });

    it("stays silent while connect restores an authored-open drawer", async () => {
      disconnectAndStopApplication(application);
      const fresh = captureStateEvents("stimeo--drawer");
      document.body.innerHTML = markup().replace('data-state="closed" hidden', 'data-state="open"');
      application = Application.start();
      application.register("stimeo--drawer", DrawerController);
      await tick();

      expect(panel().getAttribute("data-state")).toBe("open");
      expect(fresh.seen).toEqual([]);
      fresh.stop();
    });

    it("stays silent while a removed panel target is reconciled away", async () => {
      trigger().click();
      capture.clear();

      panel().remove();
      await tick();

      expect(capture.seen).toEqual([]);
    });
  });

  // --- Re-entry from a subscriber ---

  describe("re-entry from a subscriber", () => {
    const root = () => document.querySelector("[data-controller='stimeo--drawer']") as HTMLElement;
    const controller = () => {
      const instance = application.getControllerForElementAndIdentifier(root(), "stimeo--drawer");
      if (!(instance instanceof DrawerController)) throw new Error("drawer controller not found");
      return instance;
    };

    it("drops the modal side effects when the open handler closes it again", () => {
      root().addEventListener("stimeo--drawer:open", () => controller().close());

      controller().open();

      expect(panel().getAttribute("data-state")).toBe("closed");
      expect(document.body.style.overflow).toBe("");
    });

    it("keeps the drawer on screen when the close handler reopens it", () => {
      controller().open();
      root().addEventListener("stimeo--drawer:close", () => controller().open());

      controller().close();

      expect(panel().getAttribute("data-state")).toBe("open");
      // The deferred hide belongs to the close that was overtaken; applying it
      // would hide a drawer whose state says it is open.
      expect(panel().hidden).toBe(false);
    });

    it("hands no remaining panel the modal once the close handler has disconnected it", () => {
      const instance = controller();
      instance.open();
      root().addEventListener("stimeo--drawer:close", () => instance.disconnect());
      // The close goes on after its handler returns and keeps the closing panel for the
      // exit transition, so that panel leaving afterwards reaches the departure path.
      instance.close();
      const leaving = panel();
      const remaining = leaving.cloneNode(true) as HTMLElement;
      for (const node of Array.from(remaining.querySelectorAll<HTMLElement>("[id]"))) {
        node.removeAttribute("id");
      }
      remaining.removeAttribute("data-placement");
      remaining.setAttribute("data-state", "open");
      remaining.hidden = false;
      leaving.after(remaining);

      leaving.remove();
      instance.panelTargetDisconnected(leaving);

      expect(remaining.hasAttribute("data-placement")).toBe(false);
      expect(document.body.style.overflow).toBe("");
      expect((document.getElementById("background") as HTMLElement).inert).toBe(false);
    });

    it("releases the modal the open handler's disconnect left once the closing panel leaves", () => {
      const instance = controller();
      root().addEventListener("stimeo--drawer:open", () => instance.disconnect(), { once: true });
      instance.open();
      vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      // The open went on after its handler disconnected the controller, so the modal is held
      // through the exit transition.
      expect(document.body.style.overflow).toBe("hidden");
      const leaving = panel();
      const remaining = leaving.cloneNode(true) as HTMLElement;
      for (const node of Array.from(remaining.querySelectorAll<HTMLElement>("[id]"))) {
        node.removeAttribute("id");
      }
      remaining.removeAttribute("data-placement");
      remaining.setAttribute("data-state", "open");
      remaining.hidden = false;
      leaving.after(remaining);

      leaving.remove();
      instance.panelTargetDisconnected(leaving);

      expect(document.body.style.overflow).toBe("");
      expect((document.getElementById("background") as HTMLElement).inert).toBe(false);
      expect(remaining.hasAttribute("data-placement")).toBe(false);
      expect(remaining.getAttribute("data-state")).toBe("open");
    });
  });

  // --- Declared actions after disconnect ---

  describe("declared actions after disconnect", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    const root = () => document.querySelector("[data-controller='stimeo--drawer']") as HTMLElement;
    const controller = () => {
      const instance = application.getControllerForElementAndIdentifier(root(), "stimeo--drawer");
      if (!(instance instanceof DrawerController)) throw new Error("drawer controller not found");
      return instance;
    };
    /** The open state as the panel and the overlay carry it, then the `open` Value. */
    const shown = (instance: DrawerController) => [
      panel().getAttribute("data-state"),
      panel().hidden,
      overlay().getAttribute("data-state"),
      overlay().hidden,
      instance.openValue,
    ];
    /**
     * Whether the modal side effects are held: the scroll lock and the background `inert`,
     * read first, then the Tab trap (a Tab from outside the panel is pulled inside) and the
     * Escape layer (an Escape is consumed).
     */
    const modalEffects = () => {
      const scrollLocked = document.body.style.overflow === "hidden";
      const backgroundInert = (document.getElementById("background") as HTMLElement).inert;
      trigger().focus();
      const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      document.dispatchEvent(tab);
      const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      document.dispatchEvent(esc);
      return {
        scrollLocked,
        backgroundInert,
        tabTrapped: tab.defaultPrevented,
        escapeClaimed: esc.defaultPrevented,
      };
    };
    const released = {
      scrollLocked: false,
      backgroundInert: false,
      tabTrapped: false,
      escapeClaimed: false,
    };

    beforeEach(() => {
      capture = captureStateEvents("stimeo--drawer");
    });

    afterEach(() => {
      capture.stop();
    });

    it("acquires nothing from an open on a closed drawer, and acts once connected", () => {
      const instance = controller();
      instance.disconnect();
      capture.clear();

      for (const call of [() => instance.open(), () => trigger().click()]) {
        call();
        expect(shown(instance)).toEqual(["closed", true, "closed", true, false]);
      }
      expect(modalEffects()).toEqual(released);
      expect(capture.seen).toEqual([]);

      // Positive control: the same call acts on the same instance once it is connected.
      instance.connect();
      instance.open();
      expect(shown(instance)).toEqual(["open", false, "open", false, true]);
      expect(capture.names()).toEqual(["open"]);
      expect(document.body.style.overflow).toBe("hidden");
    });

    it("leaves a drawer that was open at disconnect as it is on a close or a backdrop click", () => {
      trigger().click();
      const instance = controller();
      instance.disconnect();
      capture.clear();

      for (const call of [
        () => instance.close(),
        () => document.getElementById("close")?.click(),
        () => overlay().click(),
      ]) {
        call();
        expect(shown(instance)).toEqual(["open", false, "open", false, true]);
      }
      expect(modalEffects()).toEqual(released);
      expect(capture.seen).toEqual([]);

      // Positive control: once connected (which reopens the drawer its DOM shows open), the
      // same backdrop click closes it.
      instance.connect();
      overlay().click();
      expect(shown(instance)).toEqual(["closed", true, "closed", true, false]);
      expect(capture.names()).toEqual(["close"]);
    });

    it("owns no panel after disconnect, so a leaving one releases and adopts nothing", () => {
      const instance = controller();
      instance.disconnect();
      instance.open();
      const leaving = panel();
      const remaining = leaving.cloneNode(true) as HTMLElement;
      for (const node of Array.from(remaining.querySelectorAll<HTMLElement>("[id]"))) {
        node.removeAttribute("id");
      }
      remaining.removeAttribute("data-placement");
      remaining.setAttribute("data-state", "open");
      remaining.hidden = false;
      leaving.after(remaining);
      capture.clear();

      leaving.remove();
      instance.panelTargetDisconnected(leaving);

      expect(modalEffects()).toEqual(released);
      expect(remaining.hasAttribute("data-placement")).toBe(false);
      expect(remaining.getAttribute("data-state")).toBe("open");
      expect(overlay().getAttribute("data-state")).toBe("closed");
      expect(instance.openValue).toBe(false);
      expect(capture.seen).toEqual([]);
    });
  });

  // --- A panel that moves or stops resolving ---

  describe("a panel that moves or stops resolving", () => {
    const targetAttribute = "data-stimeo--drawer-target";
    const root = () => document.querySelector("[data-controller='stimeo--drawer']") as HTMLElement;
    const controller = () => {
      const instance = application.getControllerForElementAndIdentifier(root(), "stimeo--drawer");
      if (!(instance instanceof DrawerController)) throw new Error("drawer controller not found");
      return instance;
    };
    const background = () => document.getElementById("background") as HTMLElement;
    const stateOf = (element: HTMLElement) => [
      element.getAttribute("data-state"),
      element.hidden,
      element.getAttribute("data-placement"),
    ];
    /** Focuses a button outside the drawer, so a close has an opener of its own to return to. */
    const focusElsewhere = (): HTMLElement => {
      const elsewhere = document.createElement("button");
      elsewhere.textContent = "Elsewhere";
      document.body.prepend(elsewhere);
      elsewhere.focus();
      return elsewhere;
    };
    /** Moves the panel into a new wrapper inside the overlay, where it stays the panel target. */
    const moveWithinOverlay = (moving: HTMLElement): void => {
      const holder = document.createElement("div");
      overlay().append(holder);
      holder.append(moving);
    };
    /** A drawer whose panel and overlay are authored without the attributes it writes. */
    const BARE = `
      <p id="background">Background</p>
      <div data-controller="stimeo--drawer">
        <button id="trigger" data-stimeo--drawer-target="trigger"
                data-action="stimeo--drawer#open">Open</button>
        <div data-stimeo--drawer-target="overlay">
          <div data-stimeo--drawer-target="panel" role="dialog" aria-modal="true"
               aria-label="Settings">
            <button id="inside">Save</button>
          </div>
        </div>
      </div>`;
    const remount = async (markup: string) => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = markup;
      application = Application.start();
      application.register("stimeo--drawer", DrawerController);
      await tick();
    };

    it("keeps an open panel that moves within the element open, opener included", async () => {
      const elsewhere = focusElsewhere();
      controller().open();
      const moving = panel();
      moveWithinOverlay(moving);
      await tick();

      expect(stateOf(moving)).toEqual(["open", false, "right"]);
      expect(overlay().getAttribute("data-state")).toBe("open");
      expect(document.body.style.overflow).toBe("hidden");
      expect(background().inert).toBe(true);
      controller().close();
      expect(document.activeElement).toBe(elsewhere);
    });

    it("keeps the exit transition of a panel that moves within the element while it closes", async () => {
      vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
      vi.useFakeTimers();
      controller().open();
      controller().close(); // exit transition pending
      const moving = panel();
      moveWithinOverlay(moving);
      await vi.advanceTimersByTimeAsync(0);

      expect(stateOf(moving)).toEqual(["closed", false, "right"]);
      expect(document.body.style.overflow).toBe("hidden");

      vi.advanceTimersByTime(250);

      expect(moving.hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
    });

    it("reports nothing while an open panel moves within the element", async () => {
      controller().open();
      const capture = captureStateEvents("stimeo--drawer");
      moveWithinOverlay(panel());
      await tick();

      expect(capture.seen).toEqual([]);
      capture.stop();
    });

    it("closes a moved panel that another panel now precedes, and adopts that one", async () => {
      controller().open();
      const moving = panel();
      const ahead = moving.cloneNode(true) as HTMLElement;
      ahead.querySelector("#inside")?.setAttribute("id", "ahead-inside");
      ahead.querySelector("#close")?.removeAttribute("id");
      ahead.querySelector("#drawer-title")?.removeAttribute("id");
      moving.after(ahead);
      await tick();
      ahead.after(moving);
      await tick();

      expect(moving.getAttribute("data-state")).toBe("closed");
      expect(moving.hidden).toBe(true);
      expect(ahead.getAttribute("data-state")).toBe("open");
      expect(document.body.style.overflow).toBe("hidden");
      expect(document.activeElement?.id).toBe("ahead-inside");
    });

    it("gives a panel left in the page without its target token its own values back, and closes", async () => {
      await remount(BARE);
      trigger().focus();
      controller().open();
      const departed = panel();
      departed.removeAttribute(targetAttribute);
      await tick();

      expect(stateOf(departed)).toEqual([null, false, null]);
      expect(overlay().getAttribute("data-state")).toBe("closed");
      expect(overlay().hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
      expect(document.activeElement).toBe(trigger());
    });

    it("gives a closed panel that loses its target token the visibility it was authored with", async () => {
      await remount(BARE);
      const departed = panel();
      expect(stateOf(departed)).toEqual(["closed", true, "right"]);
      departed.removeAttribute(targetAttribute);
      await tick();

      expect(stateOf(departed)).toEqual([null, false, null]);
    });

    it("reveals a replacement panel that arrives open but hidden", async () => {
      const replacement = panel().cloneNode(true) as HTMLElement;
      replacement.setAttribute("data-state", "open");
      replacement.hidden = true;
      panel().replaceWith(replacement);
      await tick();

      expect(replacement.hidden).toBe(false);
      expect(overlay().getAttribute("data-state")).toBe("open");
      expect(document.body.style.overflow).toBe("hidden");
    });

    it("gives the panel back its own values when the drawer loses its controller", async () => {
      await remount(BARE);
      controller().open();
      const departed = panel();
      root().removeAttribute("data-controller");
      await tick();

      expect(stateOf(departed)).toEqual([null, false, null]);
      expect(document.body.style.overflow).toBe("");
    });

    it("keeps a value the page wrote on the panel after the controller did", async () => {
      controller().open();
      const departed = panel();
      departed.setAttribute("hidden", "until-found");
      departed.removeAttribute(targetAttribute);
      await tick();

      expect(departed.getAttribute("hidden")).toBe("until-found");
      expect(document.body.style.overflow).toBe("");
    });

    it("keeps what it wrote on a panel that leaves with the controller element", async () => {
      controller().open();
      const departing = panel();
      root().remove();
      await tick();

      expect(stateOf(departing)).toEqual(["open", false, "right"]);
      expect(document.body.style.overflow).toBe("");
    });
  });

  // --- An overlay that replaces the current one ---

  describe("an overlay that replaces the current one", () => {
    /** A backdrop overlay beside the panel rather than around it, so it can change alone. */
    const SIBLING_OVERLAY = `
      <p id="background">Background</p>
      <div data-controller="stimeo--drawer">
        <button id="trigger" data-stimeo--drawer-target="trigger"
                data-action="stimeo--drawer#open">Open</button>
        <div data-stimeo--drawer-target="overlay"
             data-action="click->stimeo--drawer#closeOnBackdrop" hidden></div>
        <div data-stimeo--drawer-target="panel" role="dialog" aria-modal="true"
             aria-label="Settings" data-state="closed" hidden>
          <button id="inside">Save</button>
          <button id="close" data-action="stimeo--drawer#close">Close</button>
        </div>
      </div>`;
    const targetAttribute = "data-stimeo--drawer-target";
    const root = () => document.querySelector("[data-controller='stimeo--drawer']") as HTMLElement;
    const controller = () => {
      const instance = application.getControllerForElementAndIdentifier(root(), "stimeo--drawer");
      if (!(instance instanceof DrawerController)) throw new Error("drawer controller not found");
      return instance;
    };
    /** A server-rendered overlay, `hidden` and without `data-state` as the markup authors it. */
    const overlayCopy = (): HTMLElement => {
      const copy = overlay().cloneNode(true) as HTMLElement;
      copy.removeAttribute("data-state");
      copy.hidden = true;
      return copy;
    };
    const stateOf = (element: HTMLElement) => [element.getAttribute("data-state"), element.hidden];
    /** Collects the writes to `attributes` on `element` that `act` causes. */
    const attributeWrites = async (element: Element, attributes: string[], act: () => void) => {
      const records: MutationRecord[] = [];
      const observer = new MutationObserver((batch) => records.push(...batch));
      observer.observe(element, { attributes: true, attributeFilter: attributes });
      act();
      await tick();
      records.push(...observer.takeRecords());
      observer.disconnect();
      return records;
    };

    beforeEach(async () => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = SIBLING_OVERLAY;
      application = Application.start();
      application.register("stimeo--drawer", DrawerController);
      await tick();
    });

    it("opens an overlay that replaces the current one in one task while the drawer is open", async () => {
      controller().open();
      const successor = overlayCopy();
      overlay().replaceWith(successor);
      await tick();

      expect(stateOf(successor)).toEqual(["open", false]);
    });

    it("opens the overlay that stays after an earlier one leaves while the drawer is open", async () => {
      controller().open();
      const original = overlay();
      const successor = overlayCopy();
      original.after(successor);
      await tick();
      original.remove();
      await tick();

      expect(stateOf(successor)).toEqual(["open", false]);
    });

    it("closes an overlay that replaces the current one while the drawer is closed", async () => {
      const successor = overlayCopy();
      successor.setAttribute("data-state", "open");
      successor.hidden = false;
      overlay().replaceWith(successor);
      await tick();

      expect(stateOf(successor)).toEqual(["closed", true]);
    });

    it("keeps an overlay that replaces the current one shown until the close transition ends", async () => {
      vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
      vi.useFakeTimers();
      controller().open();
      controller().close(); // exit transition pending
      const successor = overlayCopy();
      overlay().replaceWith(successor);
      await vi.advanceTimersByTimeAsync(0);

      expect(stateOf(successor)).toEqual(["closed", false]);

      vi.advanceTimersByTime(250);

      expect(stateOf(successor)).toEqual(["closed", true]);
      expect(document.body.style.overflow).toBe("");
    });

    it("syncs an overlay that arrives after the only one left", async () => {
      controller().open();
      const arrival = overlayCopy();
      overlay().remove();
      await tick();
      root().append(arrival);
      await tick();

      expect(stateOf(arrival)).toEqual(["open", false]);
    });

    it("keeps working when the only overlay leaves", async () => {
      const errors: unknown[] = [];
      application.handleError = (error) => {
        errors.push(error);
      };
      controller().open();
      overlay().remove();
      await tick();
      controller().close();

      expect(errors).toEqual([]);
      expect(panel().getAttribute("data-state")).toBe("closed");
      expect(document.body.style.overflow).toBe("");
    });

    it("reports nothing while it syncs a replacing overlay", async () => {
      controller().open();
      const capture = captureStateEvents("stimeo--drawer");
      overlay().replaceWith(overlayCopy());
      await tick();
      const original = overlay();
      original.after(overlayCopy());
      await tick();
      original.remove();
      await tick();

      expect(capture.seen).toEqual([]);
      capture.stop();
    });

    it("syncs nothing once it has disconnected", async () => {
      controller().open();
      const original = overlay();
      const successor = overlayCopy();
      original.after(successor);
      await tick();
      controller().disconnect();
      original.remove();
      await tick();

      expect(stateOf(successor)).toEqual([null, true]);
    });

    it("gives an overlay left in the page without its target token its own values back", async () => {
      controller().open();
      const original = overlay();
      const successor = overlayCopy();
      original.after(successor);
      await tick();
      original.removeAttribute(targetAttribute);
      await tick();

      expect(stateOf(original)).toEqual([null, true]);
      expect(stateOf(successor)).toEqual(["open", false]);
    });

    it("keeps the drawer open when the only overlay loses its target token", async () => {
      controller().open();
      const only = overlay();
      only.removeAttribute(targetAttribute);
      await tick();

      expect(stateOf(only)).toEqual([null, true]);
      expect(panel().getAttribute("data-state")).toBe("open");
      expect(document.body.style.overflow).toBe("hidden");
    });

    it("gives the overlay back its own values when the drawer loses its controller", async () => {
      controller().open();
      const departed = overlay();
      root().removeAttribute("data-controller");
      await tick();

      expect(stateOf(departed)).toEqual([null, true]);
      expect(document.body.style.overflow).toBe("");
    });

    it("gives an authored-visible overlay its visibility back when the controller goes", async () => {
      const fresh = overlayCopy();
      fresh.hidden = false;
      overlay().replaceWith(fresh);
      await tick();
      expect(stateOf(fresh)).toEqual(["closed", true]);

      root().removeAttribute("data-controller");
      await tick();

      expect(stateOf(fresh)).toEqual([null, false]);
    });

    it("keeps a value the page wrote on the overlay after the controller did", async () => {
      controller().open();
      const departed = overlay();
      departed.setAttribute("data-state", "page");
      departed.setAttribute("hidden", "until-found");
      root().removeAttribute("data-controller");
      await tick();

      expect(departed.getAttribute("data-state")).toBe("page");
      expect(departed.getAttribute("hidden")).toBe("until-found");
    });

    it("keeps what it wrote on an overlay that moves within the element", async () => {
      controller().open();
      const moving = overlay();

      const writes = await attributeWrites(moving, ["data-state", "hidden"], () =>
        root().append(moving),
      );

      expect(stateOf(moving)).toEqual(["open", false]);
      expect(writes).toEqual([]);
    });
  });
});

describe("DrawerController initial open and placement value", () => {
  let application: Application;

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  it("opens on connect when the open value is true", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--drawer" data-stimeo--drawer-open-value="true"
           data-stimeo--drawer-placement-value="left">
        <div data-stimeo--drawer-target="overlay">
          <div data-stimeo--drawer-target="panel" role="dialog" aria-modal="true"
                 aria-label="Menu" data-state="closed" hidden>
            <button id="x">Item</button>
          </div>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--drawer", DrawerController);
    await tick();

    const panel = document.querySelector<HTMLElement>(
      "[data-stimeo--drawer-target='panel']",
    ) as HTMLElement;
    expect(panel.getAttribute("data-state")).toBe("open");
    expect(panel.hidden).toBe(false);
    expect(panel.getAttribute("data-placement")).toBe("left");
  });

  it("reads the open Value at connect only and leaves the drawer alone on a later declaration", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--drawer" data-stimeo--drawer-open-value="false">
        <button id="opener" data-action="stimeo--drawer#open">Open</button>
        <div data-stimeo--drawer-target="overlay">
          <div data-stimeo--drawer-target="panel" role="dialog" aria-modal="true"
                 aria-label="Menu" data-state="closed" hidden>
            <button id="inside">Save</button>
          </div>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--drawer", DrawerController);
    await tick();
    const host = document.querySelector<HTMLElement>(
      "[data-controller='stimeo--drawer']",
    ) as HTMLElement;
    const panel = document.querySelector<HTMLElement>(
      "[data-stimeo--drawer-target='panel']",
    ) as HTMLElement;

    host.setAttribute("data-stimeo--drawer-open-value", "true");
    await tick();
    expect(panel.getAttribute("data-state")).toBe("closed");
    expect(panel.hidden).toBe(true);
    expect(document.body.style.overflow).toBe("");

    // A drawer the user opened stays open over a declaration that says closed.
    (document.getElementById("opener") as HTMLElement).click();
    expect(panel.getAttribute("data-state")).toBe("open");
    host.setAttribute("data-stimeo--drawer-open-value", "false");
    await tick();
    expect(panel.getAttribute("data-state")).toBe("open");
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("opens on a fresh render whose panel the server wrote open (DOM wins over Value)", async () => {
    // The server renders the panel open (data-state="open", no `hidden`) while the
    // declarative open Value says false. The panel decides, and the FocusTrap is taken.
    document.body.innerHTML = `
      <p id="background">Background</p>
      <div data-controller="stimeo--drawer" data-stimeo--drawer-open-value="false">
        <div data-stimeo--drawer-target="overlay">
          <div data-stimeo--drawer-target="panel" role="dialog" aria-modal="true"
                 aria-label="Menu" data-state="open">
            <button id="inside">Save</button>
          </div>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--drawer", DrawerController);
    await tick();

    const panel = document.querySelector<HTMLElement>(
      "[data-stimeo--drawer-target='panel']",
    ) as HTMLElement;
    expect(panel.getAttribute("data-state")).toBe("open");
    expect(panel.hidden).toBe(false);
    // The trap is genuinely active: it locked background scroll.
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("stays closed on connect when neither the DOM nor the Value says open", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--drawer" data-stimeo--drawer-open-value="false">
        <div data-stimeo--drawer-target="overlay">
          <div data-stimeo--drawer-target="panel" role="dialog" aria-modal="true"
                 aria-label="Menu" data-state="closed" hidden>
            <button id="inside">Save</button>
          </div>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--drawer", DrawerController);
    await tick();

    const panel = document.querySelector<HTMLElement>(
      "[data-stimeo--drawer-target='panel']",
    ) as HTMLElement;
    expect(panel.getAttribute("data-state")).toBe("closed");
    expect(panel.hidden).toBe(true);
    expect(document.body.style.overflow).toBe("");
  });

  it("defaults data-placement to right when no placement value is set", async () => {
    // Markup that omits the value gets placement "right".
    document.body.innerHTML = `
      <div data-controller="stimeo--drawer">
        <div data-stimeo--drawer-target="overlay">
          <div data-stimeo--drawer-target="panel" role="dialog" aria-modal="true"
               aria-label="Menu" data-state="closed" hidden>
            <button id="x">Item</button>
          </div>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--drawer", DrawerController);
    await tick();

    const panel = document.querySelector<HTMLElement>(
      "[data-stimeo--drawer-target='panel']",
    ) as HTMLElement;
    expect(panel.getAttribute("data-placement")).toBe("right");
  });

  it("falls back to right when the placement value is not a known edge", async () => {
    // The reflected hook only ever carries left/right/top/bottom; anything else
    // (a typo like "diagonal") normalizes to the default so consumer CSS keyed
    // on data-placement always has a valid edge to match.
    document.body.innerHTML = `
      <div data-controller="stimeo--drawer" data-stimeo--drawer-placement-value="diagonal">
        <div data-stimeo--drawer-target="overlay">
          <div data-stimeo--drawer-target="panel" role="dialog" aria-modal="true"
               aria-label="Menu" data-state="closed" hidden>
            <button id="x">Item</button>
          </div>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--drawer", DrawerController);
    await tick();

    const panel = document.querySelector<HTMLElement>(
      "[data-stimeo--drawer-target='panel']",
    ) as HTMLElement;
    expect(panel.getAttribute("data-placement")).toBe("right");
  });
});
