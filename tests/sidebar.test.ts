import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarController } from "../src/controllers/sidebar_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link SidebarController}: the inline rail (toggle +
 * `localStorage` persistence), the responsive switch to an overlay off-canvas
 * panel (shared {@link import("../src/utils/focus_trap").FocusTrap}: focus move,
 * trap, `Escape`, scroll lock, background `inert`, restore), and teardown.
 *
 * `matchMedia` is mocked so the test drives the responsive mode: `matches` is the
 * `(min-width: breakpoint)` result (true = desktop/inline, false = mobile/overlay)
 * and {@link changeViewport} fires the `change` event the controller listens to.
 * happy-dom reports no transition duration, so the deferred overlay `hidden`
 * collapses to synchronous hiding here.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let mqMatches = true;
let mqListeners: Array<(event: MediaQueryListEvent) => void> = [];

const installMatchMedia = () => {
  mqListeners = [];
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() {
      return mqMatches;
    },
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      mqListeners.push(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      mqListeners = mqListeners.filter((l) => l !== listener);
    },
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
};

/** Flips the viewport and fires the media `change` the controller subscribed to. */
const changeViewport = (desktop: boolean) => {
  mqMatches = desktop;
  const event = { matches: desktop } as MediaQueryListEvent;
  for (const listener of [...mqListeners]) listener(event);
};

const markup = (key = "main") => `
  <p id="background">Background</p>
  <div data-controller="stimeo--sidebar"
       data-stimeo--sidebar-breakpoint-value="768"
       data-stimeo--sidebar-key-value="${key}">
    <button id="trigger" data-stimeo--sidebar-target="trigger"
            data-action="click->stimeo--sidebar#toggle"
            aria-expanded="true" aria-controls="app-sidebar">Menu</button>
    <div id="backdrop" data-stimeo--sidebar-target="backdrop"
         data-action="click->stimeo--sidebar#close" hidden></div>
    <aside id="app-sidebar" data-stimeo--sidebar-target="panel"
           aria-label="Main" data-mode="inline" data-state="expanded">
      <a id="first" href="#a">A</a>
      <a id="last" href="#b">B</a>
    </aside>
  </div>`;

describe("SidebarController", () => {
  let application: Application;

  const start = async (html: string = markup()) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--sidebar", SidebarController);
    await tick();
  };

  beforeEach(() => {
    mqMatches = true; // default to desktop/inline
    installMatchMedia();
    localStorage.clear();
  });

  afterEach(() => {
    application?.stop();
    document.body.innerHTML = "";
    document.body.style.overflow = "";
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  const trigger = () => document.getElementById("trigger") as HTMLButtonElement;
  const panel = () => document.getElementById("app-sidebar") as HTMLElement;
  const backdrop = () => document.getElementById("backdrop") as HTMLElement;
  const root = () => document.querySelector("[data-controller='stimeo--sidebar']") as HTMLElement;

  // --- Inline (desktop) ------------------------------------------------------

  it("renders the inline expanded rail by default", async () => {
    await start();
    expect(panel().getAttribute("data-mode")).toBe("inline");
    expect(panel().getAttribute("data-state")).toBe("expanded");
    expect(panel().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("toggle collapses the rail and persists the preference", async () => {
    await start();
    trigger().click();
    expect(panel().getAttribute("data-state")).toBe("collapsed");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem("stimeo--sidebar:main")).toBe("1");
    trigger().click();
    expect(panel().getAttribute("data-state")).toBe("expanded");
    expect(localStorage.getItem("stimeo--sidebar:main")).toBe("0");
  });

  it("restores the collapsed preference from localStorage on connect", async () => {
    localStorage.setItem("stimeo--sidebar:main", "1");
    await start();
    expect(panel().getAttribute("data-state")).toBe("collapsed");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("honors the collapsed value when nothing is persisted", async () => {
    await start(`
      <div data-controller="stimeo--sidebar"
           data-stimeo--sidebar-collapsed-value="true">
        <button id="trigger" data-stimeo--sidebar-target="trigger"
                data-action="click->stimeo--sidebar#toggle">Menu</button>
        <aside id="app-sidebar" data-stimeo--sidebar-target="panel" aria-label="Main">x</aside>
      </div>`);
    expect(panel().getAttribute("data-state")).toBe("collapsed");
  });

  it("keeps the inline collapsed state across a reconnect when no key is set (DOM is source of truth)", async () => {
    // No key → no localStorage. A Turbo cache restore / morph reconnects Stimulus
    // over already-rendered markup; connect() must recover the live data-state
    // instead of snapping back to the declared default.
    await start(`
      <div data-controller="stimeo--sidebar" data-stimeo--sidebar-breakpoint-value="768">
        <button id="trigger" data-stimeo--sidebar-target="trigger"
                data-action="click->stimeo--sidebar#toggle"
                aria-expanded="true" aria-controls="app-sidebar">Menu</button>
        <aside id="app-sidebar" data-stimeo--sidebar-target="panel"
               aria-label="Main" data-mode="inline" data-state="expanded">x</aside>
      </div>`);
    trigger().click(); // collapse (not persisted: no key)
    expect(panel().getAttribute("data-state")).toBe("collapsed");

    // Reconnect Stimulus over the same DOM (the collapsed data-state is preserved).
    application.stop();
    application = Application.start();
    application.register("stimeo--sidebar", SidebarController);
    await tick();

    expect(panel().getAttribute("data-state")).toBe("collapsed");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  // --- Overlay (mobile) ------------------------------------------------------

  it("renders the overlay closed state below the breakpoint", async () => {
    mqMatches = false;
    await start();
    expect(panel().getAttribute("data-mode")).toBe("overlay");
    expect(panel().getAttribute("data-state")).toBe("closed");
    expect(panel().hidden).toBe(true);
    expect(backdrop().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the overlay: reveals, locks scroll, traps focus, inerts background", async () => {
    mqMatches = false;
    await start();
    trigger().focus();
    trigger().click();
    expect(panel().getAttribute("data-state")).toBe("open");
    expect(panel().hidden).toBe(false);
    expect(backdrop().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.activeElement).toBe(document.getElementById("first"));
    expect((document.getElementById("background") as HTMLElement).inert).toBe(true);
  });

  it("closes the overlay on Escape and restores focus", async () => {
    mqMatches = false;
    await start();
    trigger().focus();
    trigger().click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(panel().getAttribute("data-state")).toBe("closed");
    expect(panel().hidden).toBe(true);
    expect(document.body.style.overflow).toBe("");
    expect((document.getElementById("background") as HTMLElement).inert).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it("closes the overlay when the backdrop is clicked", async () => {
    mqMatches = false;
    await start();
    trigger().click();
    backdrop().click();
    expect(panel().getAttribute("data-state")).toBe("closed");
  });

  it("traps Tab focus within the open overlay panel", async () => {
    mqMatches = false;
    await start();
    trigger().click();
    document.getElementById("last")?.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(document.getElementById("first"));
  });

  it("does not persist the transient overlay open state", async () => {
    mqMatches = false;
    await start();
    trigger().click();
    expect(localStorage.getItem("stimeo--sidebar:main")).toBeNull();
  });

  // --- Responsive mode switching --------------------------------------------

  it("tears down the overlay when growing to the inline breakpoint", async () => {
    mqMatches = false;
    await start();
    trigger().click(); // overlay open
    expect(document.body.style.overflow).toBe("hidden");
    changeViewport(true); // cross into desktop/inline
    expect(panel().getAttribute("data-mode")).toBe("inline");
    expect(panel().hidden).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect((document.getElementById("background") as HTMLElement).inert).toBe(false);
    expect(panel().getAttribute("data-state")).toBe("expanded");
  });

  it("starts the overlay closed (never auto-open) when shrinking below the breakpoint", async () => {
    await start(); // inline expanded
    changeViewport(false); // cross into mobile/overlay
    expect(panel().getAttribute("data-mode")).toBe("overlay");
    expect(panel().getAttribute("data-state")).toBe("closed");
    expect(panel().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  // --- Teardown --------------------------------------------------------------

  it("restores scroll and background when disconnected while the overlay is open", async () => {
    mqMatches = false;
    await start();
    trigger().click();
    const controller = application.getControllerForElementAndIdentifier(root(), "stimeo--sidebar");
    controller?.disconnect();
    expect(document.body.style.overflow).toBe("");
    expect((document.getElementById("background") as HTMLElement).inert).toBe(false);
  });

  // --- Accessibility ---------------------------------------------------------

  it("has no machine-detectable a11y violations (inline)", async () => {
    await start();
    await expectNoA11yViolations(root());
  });

  it("has no machine-detectable a11y violations (overlay open)", async () => {
    mqMatches = false;
    await start();
    trigger().click();
    await expectNoA11yViolations(document.body);
  });

  // Layer ③ — speech-order regression: the trigger announces its expanded state,
  // and toggling it flips the announcement to collapsed.
  it("announces the trigger's expanded/collapsed state (layer ③)", async () => {
    await start();
    const expanded = await captureSpeech({ container: trigger(), steps: 0 });
    expect(expanded).toEqual(["button, Menu, expanded"]);
    trigger().click();
    await tick();
    const collapsed = await captureSpeech({ container: trigger(), steps: 0 });
    expect(collapsed).toEqual(["button, Menu, not expanded"]);
  });
});
