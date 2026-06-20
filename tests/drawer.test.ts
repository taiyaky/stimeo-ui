import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrawerController } from "../src/controllers/drawer_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link DrawerController}: the APG modal contract plus the
 * slide-over plumbing — `data-state` sync, `data-placement` reflection, deferred
 * `hidden`, focus trap, overlay-only backdrop close, and teardown reversal.
 *
 * happy-dom reports no transition duration, so the deferred `hidden` collapses to
 * synchronous hiding here; the real exit transition is exercised by the e2e layer.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

describe("DrawerController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = markup();
    application = Application.start();
    application.register("stimeo--drawer", DrawerController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
    document.body.style.overflow = "";
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

  it("keeps the background inert and scroll locked until the close transition ends", () => {
    // Force a non-zero transition so hidden + modal teardown defer to transitionend.
    const spy = vi
      .spyOn(window, "getComputedStyle")
      .mockReturnValue({ transitionDuration: "0.2s" } as CSSStyleDeclaration);
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

      panel().dispatchEvent(new Event("transitionend")); // transition finishes
      expect(panel().hidden).toBe(true);
      expect(background.inert).toBe(false);
      expect(document.body.style.overflow).toBe("");
      expect(document.activeElement).toBe(trigger());
    } finally {
      spy.mockRestore();
    }
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
    application.stop();
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
});
