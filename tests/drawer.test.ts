import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrawerController } from "../src/controllers/drawer_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

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
    // load in happy-dom (same workaround as aspect_ratio's re-reflect test).
    controller.placementValueChanged();
    expect(panel().getAttribute("data-placement")).toBe("bottom");
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

  it("neutralizes the modal side effects on turbo:before-cache while keeping the drawer open", () => {
    // Snapshot hygiene (shared FocusTrap): navigating away with the drawer open
    // must not bake the scroll lock / inert into the Turbo cache. The open markup
    // is preserved on purpose — a restored snapshot reopens (DOM wins on
    // reconnect) and re-activates the trap against a clean baseline.
    const background = document.getElementById("background") as HTMLElement;
    trigger().click();
    expect(background.inert).toBe(true);
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(document.body.style.overflow).toBe("");
    expect(background.inert).toBe(false);
    expect(panel().getAttribute("data-state")).toBe("open"); // markup untouched
    expect(panel().hidden).toBe(false);
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

  it("keeps the drawer open on reconnect when the restored DOM shows it open (DOM wins over Value)", async () => {
    // Simulate a Turbo cache restore: the cached snapshot already shows the panel
    // open (data-state="open", no `hidden`) even though the declarative open Value
    // is false. The DOM must win — connect must not slam a user-opened drawer shut,
    // and the freshly-created FocusTrap must be (re)activated.
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
    // Pins the spec default (placement: "right") for markup that omits the value.
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
