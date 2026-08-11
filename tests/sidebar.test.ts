import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarController } from "../src/controllers/sidebar_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link SidebarController}: the inline rail (toggle +
 * `localStorage` persistence), the responsive switch to an overlay off-canvas
 * panel (shared {@link import("../src/utils/focus_trap").FocusTrap}: focus move,
 * trap, `Escape`, scroll lock, background `inert`, restore), and teardown.
 *
 * `matchMedia` is mocked so the test drives the responsive mode: `matches` is the
 * `(min-width: breakpoint)` result (true = desktop/inline, false = mobile/overlay)
 * and {@link changeViewport} fires the `change` event the controller listens to.
 * happy-dom reports no transition duration, so ordinary close assertions hide
 * synchronously; dedicated cases stub the full transition tuple to exercise the
 * deferred path, terminal events, fallback, and target replacement.
 */

interface MockMediaQuery {
  readonly media: string;
  readonly listeners: Set<(event: MediaQueryListEvent) => void>;
  readonly matches: boolean;
}

let viewportWidth = 1024;
let mediaQueries: MockMediaQuery[] = [];

const installMatchMedia = () => {
  mediaQueries = [];
  vi.stubGlobal("matchMedia", (query: string) => {
    const minimum = Number.parseFloat(query.match(/min-width:\s*([-\d.]+)px/)?.[1] ?? "0");
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const mediaQuery: MockMediaQuery = {
      media: query,
      listeners,
      get matches() {
        return viewportWidth >= minimum;
      },
    };
    mediaQueries.push(mediaQuery);
    return {
      media: query,
      get matches() {
        return mediaQuery.matches;
      },
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    };
  });
};

/** Changes viewport width and fires every active media-query listener. */
const changeViewport = (desktopOrWidth: boolean | number) => {
  viewportWidth =
    typeof desktopOrWidth === "boolean" ? (desktopOrWidth ? 1024 : 600) : desktopOrWidth;
  for (const mediaQuery of mediaQueries) {
    const event = {
      matches: mediaQuery.matches,
      media: mediaQuery.media,
    } as MediaQueryListEvent;
    for (const listener of mediaQuery.listeners) listener(event);
  }
};

const markup = (key = "main") => `
  <p id="background">Background</p>
  <div data-controller="stimeo--sidebar"
       data-stimeo--sidebar-breakpoint-value="768"
       data-stimeo--sidebar-key-value="${key}">
    <button id="trigger" data-stimeo--sidebar-target="trigger"
            data-action="click->stimeo--sidebar#toggle"
            aria-expanded="true" aria-controls="app-sidebar">Menu</button>
    <button id="open-action" data-action="click->stimeo--sidebar#open">Open</button>
    <div id="backdrop" data-stimeo--sidebar-target="backdrop"
         data-action="click->stimeo--sidebar#close" hidden></div>
    <aside id="app-sidebar" data-stimeo--sidebar-target="panel"
           aria-label="Main" data-mode="inline" data-state="expanded">
      <a id="first" href="#a">A</a>
      <button id="close-action" data-action="click->stimeo--sidebar#close">Close</button>
      <a id="last" href="#b">B</a>
    </aside>
  </div>`;

const transitionStyle = (
  property = "transform",
  duration = "200ms",
  delay = "0ms",
): CSSStyleDeclaration =>
  ({
    transitionProperty: property,
    transitionDuration: duration,
    transitionDelay: delay,
  }) as CSSStyleDeclaration;

const dispatchPanelTransition = (
  panel: HTMLElement,
  type: "transitionend" | "transitioncancel",
  propertyName = "transform",
): void => {
  const event = new Event(type);
  Object.defineProperty(event, "propertyName", { value: propertyName });
  panel.dispatchEvent(event);
};

describe("SidebarController", () => {
  let application: Application;

  const start = async (html: string = markup()) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--sidebar", SidebarController);
    await tick();
  };

  beforeEach(() => {
    viewportWidth = 1024; // default to desktop/inline
    installMatchMedia();
    localStorage.clear();
  });

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    document.body.style.overflow = "";
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const trigger = () => document.getElementById("trigger") as HTMLButtonElement;
  const openAction = () => document.getElementById("open-action") as HTMLButtonElement;
  const closeAction = () => document.getElementById("close-action") as HTMLButtonElement;
  const panel = () => document.getElementById("app-sidebar") as HTMLElement;
  const backdrop = () => document.getElementById("backdrop") as HTMLElement;
  const root = () => document.querySelector("[data-controller='stimeo--sidebar']") as HTMLElement;
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--sidebar",
    ) as SidebarController;

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

  it("runs the inline open and close actions idempotently", async () => {
    const setItem = vi.spyOn(localStorage, "setItem");
    await start();

    closeAction().click();
    closeAction().click();
    expect(panel().getAttribute("data-state")).toBe("collapsed");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenLastCalledWith("stimeo--sidebar:main", "1");

    openAction().click();
    openAction().click();
    expect(panel().getAttribute("data-state")).toBe("expanded");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(setItem).toHaveBeenLastCalledWith("stimeo--sidebar:main", "0");
    setItem.mockRestore();
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

  it("falls back to DOM and declared state when localStorage reads fail", async () => {
    const getItem = vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    await start(`
      <div data-controller="stimeo--sidebar"
           data-stimeo--sidebar-key-value="blocked"
           data-stimeo--sidebar-collapsed-value="true">
        <button id="trigger" data-stimeo--sidebar-target="trigger">Menu</button>
        <aside id="app-sidebar" data-stimeo--sidebar-target="panel" aria-label="Main">x</aside>
      </div>`);
    expect(panel().getAttribute("data-state")).toBe("collapsed");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    getItem.mockRestore();
  });

  it("keeps state usable when localStorage writes fail", async () => {
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    await start();
    trigger().click();
    expect(panel().getAttribute("data-state")).toBe("collapsed");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    setItem.mockRestore();
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
    disconnectAndStopApplication(application);
    application = Application.start();
    application.register("stimeo--sidebar", SidebarController);
    await tick();

    expect(panel().getAttribute("data-state")).toBe("collapsed");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  // --- Overlay (mobile) ------------------------------------------------------

  it("renders the overlay closed state below the breakpoint", async () => {
    viewportWidth = 600;
    await start();
    expect(panel().getAttribute("data-mode")).toBe("overlay");
    expect(panel().getAttribute("data-state")).toBe("closed");
    expect(panel().hidden).toBe(true);
    expect(backdrop().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the overlay: reveals, locks scroll, traps focus, inerts background", async () => {
    viewportWidth = 600;
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

  it("runs the overlay open and close actions idempotently", async () => {
    viewportWidth = 600;
    await start();

    openAction().click();
    openAction().click();
    expect(panel().getAttribute("data-state")).toBe("open");
    expect(panel().hidden).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");

    closeAction().click();
    closeAction().click();
    expect(panel().getAttribute("data-state")).toBe("closed");
    expect(panel().hidden).toBe(true);
    expect(document.body.style.overflow).toBe("");
  });

  it("closes the overlay on Escape and restores focus", async () => {
    viewportWidth = 600;
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
    viewportWidth = 600;
    await start();
    trigger().click();
    backdrop().click();
    expect(panel().getAttribute("data-state")).toBe("closed");
  });

  it("traps Tab focus within the open overlay panel", async () => {
    viewportWidth = 600;
    await start();
    trigger().click();
    document.getElementById("last")?.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(document.getElementById("first"));
  });

  it("does not persist the transient overlay open state", async () => {
    viewportWidth = 600;
    await start();
    trigger().click();
    expect(localStorage.getItem("stimeo--sidebar:main")).toBeNull();
  });

  it("sanitizes an open overlay before Turbo caches the snapshot", async () => {
    viewportWidth = 600;
    document.body.style.overflow = "clip";
    await start();
    const background = document.getElementById("background") as HTMLElement;
    background.inert = true;
    trigger().focus();
    trigger().click();

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(panel().getAttribute("data-state")).toBe("closed");
    expect(panel().hidden).toBe(true);
    expect(backdrop().getAttribute("data-state")).toBe("closed");
    expect(backdrop().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.body.style.overflow).toBe("clip");
    expect(background.inert).toBe(true);
    expect(document.activeElement).toBe(document.getElementById("first"));
  });

  it("cancels a pending close before Turbo caches the snapshot", async () => {
    viewportWidth = 600;
    await start();
    vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
    vi.useFakeTimers();
    trigger().click();
    backdrop().click();
    expect(panel().hidden).toBe(false);

    document.dispatchEvent(new Event("turbo:before-cache"));
    dispatchPanelTransition(panel(), "transitionend");
    vi.advanceTimersByTime(250);

    expect(panel().getAttribute("data-state")).toBe("closed");
    expect(panel().hidden).toBe(true);
    expect(backdrop().hidden).toBe(true);
    expect(document.body.style.overflow).toBe("");
  });

  it("preserves the durable inline preference before Turbo caches the snapshot", async () => {
    await start();
    trigger().click();
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(panel().getAttribute("data-state")).toBe("collapsed");
    expect(panel().hidden).toBe(false);
    expect(localStorage.getItem("stimeo--sidebar:main")).toBe("1");
  });

  it("releases modal side effects through the bounded fallback when no event fires", async () => {
    viewportWidth = 600;
    await start();
    vi.spyOn(window, "getComputedStyle").mockReturnValue(
      transitionStyle("transform", "200ms", "50ms"),
    );
    vi.useFakeTimers();
    trigger().focus();
    trigger().click();
    backdrop().click();

    vi.advanceTimersByTime(299);
    expect(panel().hidden).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");
    vi.advanceTimersByTime(1);
    expect(panel().hidden).toBe(true);
    expect(document.body.style.overflow).toBe("");
    expect((document.getElementById("background") as HTMLElement).inert).toBe(false);
  });

  it("settles a cancelled single-property close transition", async () => {
    viewportWidth = 600;
    await start();
    vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
    trigger().click();
    backdrop().click();
    expect(panel().hidden).toBe(false);

    dispatchPanelTransition(panel(), "transitioncancel");

    expect(panel().hidden).toBe(true);
    expect(document.body.style.overflow).toBe("");
  });

  it("reopening cancels a pending close completion", async () => {
    viewportWidth = 600;
    await start();
    vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
    vi.useFakeTimers();
    trigger().click();
    backdrop().click();
    trigger().click();

    dispatchPanelTransition(panel(), "transitionend");
    vi.advanceTimersByTime(250);
    expect(panel().getAttribute("data-state")).toBe("open");
    expect(panel().hidden).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("disconnecting cancels a pending close without a late DOM mutation", async () => {
    viewportWidth = 600;
    await start();
    vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
    vi.useFakeTimers();
    trigger().click();
    backdrop().click();
    const controller = application.getControllerForElementAndIdentifier(root(), "stimeo--sidebar");
    controller?.disconnect();

    vi.advanceTimersByTime(250);
    expect(panel().hidden).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect((document.getElementById("background") as HTMLElement).inert).toBe(false);
  });

  it("finishes modal cleanup when a closing panel target is replaced", async () => {
    viewportWidth = 600;
    await start();
    vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
    vi.useFakeTimers();
    const background = document.getElementById("background") as HTMLElement;
    trigger().focus();
    trigger().click();
    backdrop().click();
    const oldPanel = panel();
    const replacement = oldPanel.cloneNode(true) as HTMLElement;
    oldPanel.replaceWith(replacement);
    await vi.advanceTimersByTimeAsync(0);

    expect(panel()).toBe(replacement);
    expect(replacement.getAttribute("data-state")).toBe("closed");
    expect(replacement.hidden).toBe(true);
    expect(backdrop().hidden).toBe(true);
    expect(document.body.style.overflow).toBe("");
    expect(background.inert).toBe(false);
    expect(document.activeElement).toBe(trigger());

    vi.advanceTimersByTime(250);
    expect(replacement.hidden).toBe(true);
    expect(document.body.style.overflow).toBe("");
  });

  it("rebinds the modal lifecycle to an open replacement panel", async () => {
    viewportWidth = 600;
    await start();
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
    expect(backdrop().hidden).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");
    expect(background.inert).toBe(true);
    expect(document.activeElement).toBe(replacement.querySelector("#first"));
  });

  // --- Responsive mode switching --------------------------------------------

  it("tears down the overlay when growing to the inline breakpoint", async () => {
    viewportWidth = 600;
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

  it("rebinds matchMedia when the breakpoint value changes at runtime", async () => {
    await start();
    const original = mediaQueries[0];
    expect(original?.media).toBe("(min-width: 768px)");
    expect(original?.listeners.size).toBe(1);

    root().setAttribute("data-stimeo--sidebar-breakpoint-value", "1200");
    controller().breakpointValueChanged();

    const replacement = mediaQueries[1];
    expect(original?.listeners.size).toBe(0);
    expect(replacement?.media).toBe("(min-width: 1200px)");
    expect(replacement?.listeners.size).toBe(1);
    expect(panel().getAttribute("data-mode")).toBe("overlay");
    expect(panel().getAttribute("data-state")).toBe("closed");

    changeViewport(1300);
    expect(panel().getAttribute("data-mode")).toBe("inline");
    expect(panel().getAttribute("data-state")).toBe("expanded");
  });

  it("keeps one subscription for equivalent valid and invalid breakpoint values", async () => {
    await start();
    const initialCount = mediaQueries.length;
    expect(initialCount).toBe(1);
    controller().breakpointValueChanged();
    expect(mediaQueries).toHaveLength(initialCount);

    root().setAttribute("data-stimeo--sidebar-breakpoint-value", "-1");
    controller().breakpointValueChanged();
    expect(mediaQueries).toHaveLength(initialCount);
    expect(mediaQueries[0]?.listeners.size).toBe(1);

    root().setAttribute("data-stimeo--sidebar-breakpoint-value", "NaN");
    controller().breakpointValueChanged();
    expect(mediaQueries).toHaveLength(initialCount);
    expect(mediaQueries[0]?.listeners.size).toBe(1);
  });

  it("restores the saved inline preference after passing through overlay mode", async () => {
    localStorage.setItem("stimeo--sidebar:main", "1");
    await start();
    expect(panel().getAttribute("data-state")).toBe("collapsed");

    changeViewport(false);
    openAction().click();
    expect(panel().getAttribute("data-state")).toBe("open");
    changeViewport(true);

    expect(panel().getAttribute("data-mode")).toBe("inline");
    expect(panel().getAttribute("data-state")).toBe("collapsed");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem("stimeo--sidebar:main")).toBe("1");
  });

  // --- Teardown --------------------------------------------------------------

  it("restores scroll and background when disconnected while the overlay is open", async () => {
    viewportWidth = 600;
    await start();
    trigger().click();
    const controller = application.getControllerForElementAndIdentifier(root(), "stimeo--sidebar");
    controller?.disconnect();
    expect(document.body.style.overflow).toBe("");
    expect((document.getElementById("background") as HTMLElement).inert).toBe(false);
  });

  it("removes actions and responsive listeners when the application unloads the controller", async () => {
    viewportWidth = 600;
    await start();
    trigger().click();
    expect(panel().getAttribute("data-state")).toBe("open");

    application.unload("stimeo--sidebar");
    const state = panel().getAttribute("data-state");
    const mode = panel().getAttribute("data-mode");
    trigger().click();
    changeViewport(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(panel().getAttribute("data-state")).toBe(state);
    expect(panel().getAttribute("data-mode")).toBe(mode);
    expect(document.body.style.overflow).toBe("");
    expect((document.getElementById("background") as HTMLElement).inert).toBe(false);
    expect(mediaQueries.at(-1)?.listeners.size).toBe(0);
  });

  // --- Accessibility ---------------------------------------------------------

  it("has no machine-detectable a11y violations (inline)", async () => {
    await start();
    await expectNoA11yViolations(root());
  });

  it("has no machine-detectable a11y violations (overlay open)", async () => {
    viewportWidth = 600;
    await start();
    trigger().click();
    await expectNoA11yViolations(document.body);
  });

  // Speech-order regression: the trigger announces its expanded state, and
  // toggling it flips the announcement to collapsed.
  it("announces the trigger's expanded/collapsed state", async () => {
    await start();
    const expanded = await captureSpeech({ container: trigger(), steps: 0 });
    expect(expanded).toEqual(["button, Menu, expanded"]);
    trigger().click();
    await tick();
    const collapsed = await captureSpeech({ container: trigger(), steps: 0 });
    expect(collapsed).toEqual(["button, Menu, not expanded"]);
  });
});
