import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogController } from "../src/controllers/dialog_controller";
import { SidebarController } from "../src/controllers/sidebar_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { typeKey } from "./helpers/keyboard";
import { expectUpperModalOnTop, openUpperModal, TARGET_SWAPS } from "./helpers/modal_stack";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents } from "./helpers/state_events";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
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

  // --- A Turbo morph ----------------------------------------------------------

  /** What a morph does: put the server's markup back and dispatch `turbo:morph-element`. */
  const morphToServerMarkup = async () => {
    panel().setAttribute("data-mode", "inline");
    panel().setAttribute("data-state", "expanded");
    panel().removeAttribute("hidden");
    backdrop().setAttribute("hidden", "");
    backdrop().removeAttribute("data-state");
    trigger().setAttribute("aria-expanded", "true");
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();
  };

  it("keeps an open overlay open through a morph that puts the server's markup back", async () => {
    viewportWidth = 375;
    await start();
    openAction().click();
    expect(panel().getAttribute("data-state")).toBe("open");

    await morphToServerMarkup();

    expect(panel().getAttribute("data-mode")).toBe("overlay");
    expect(panel().getAttribute("data-state")).toBe("open");
    expect(panel().hidden).toBe(false);
    expect(backdrop().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("keeps a closed overlay closed through a morph that puts the server's markup back", async () => {
    viewportWidth = 375;
    await start();

    await morphToServerMarkup();

    expect(panel().getAttribute("data-mode")).toBe("overlay");
    expect(panel().getAttribute("data-state")).toBe("closed");
    expect(panel().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps a collapsed inline rail collapsed through a morph that puts the server's markup back", async () => {
    await start();
    trigger().click();
    expect(panel().getAttribute("data-state")).toBe("collapsed");

    await morphToServerMarkup();

    expect(panel().getAttribute("data-state")).toBe("collapsed");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("writes nothing after a morph once disconnected, and takes a morph with no panel", async () => {
    viewportWidth = 375;
    await start();
    panel().removeAttribute("data-stimeo--sidebar-target");
    await tick();
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();

    panel().setAttribute("data-stimeo--sidebar-target", "panel");
    await tick();
    application.unload("stimeo--sidebar");
    await morphToServerMarkup();
    expect(panel().getAttribute("data-mode")).toBe("inline");
    expect(panel().hidden).toBe(false);
  });

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

  it("keeps a rendered expanded state over the declared collapsed value", async () => {
    await start(`
      <div data-controller="stimeo--sidebar" data-stimeo--sidebar-collapsed-value="true">
        <button id="trigger" data-stimeo--sidebar-target="trigger"
                data-action="click->stimeo--sidebar#toggle" aria-expanded="false">Menu</button>
        <aside id="app-sidebar" data-stimeo--sidebar-target="panel"
               aria-label="Main" data-state="expanded">x</aside>
      </div>`);
    expect(panel().getAttribute("data-state")).toBe("expanded");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("reads the collapsed Value at connect only and keeps the DOM state over a later declaration", async () => {
    await start(`
      <div data-controller="stimeo--sidebar" data-stimeo--sidebar-collapsed-value="true">
        <button id="trigger" data-stimeo--sidebar-target="trigger"
                data-action="click->stimeo--sidebar#toggle">Menu</button>
        <aside id="app-sidebar" data-stimeo--sidebar-target="panel" aria-label="Main">x</aside>
      </div>`);
    const host = root();
    const reconnect = async () => {
      host.remove();
      await tick();
      document.body.append(host);
      await tick();
    };
    const events = captureStateEvents("stimeo--sidebar", ["close", "open", "reconcile"]);
    expect(panel().getAttribute("data-state")).toBe("collapsed");

    // A declaration rewritten after connect does not move the state, and a reconnect
    // keeps what the DOM shows rather than the new declaration.
    host.setAttribute("data-stimeo--sidebar-collapsed-value", "false");
    await tick();
    expect(panel().getAttribute("data-state")).toBe("collapsed");
    await reconnect();
    expect(panel().getAttribute("data-state")).toBe("collapsed");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    trigger().click();
    host.setAttribute("data-stimeo--sidebar-collapsed-value", "true");
    await tick();
    expect(panel().getAttribute("data-state")).toBe("expanded");
    await reconnect();
    expect(panel().getAttribute("data-state")).toBe("expanded");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    // Only the user's expand moved the state.
    expect(events.names()).toEqual(["open"]);
    events.stop();
  });

  /** One sidebar without a `key` beside one with `key="main"`, both rendered expanded. */
  const keylessAndKeyed = `
    <div data-controller="stimeo--sidebar">
      <button id="keyless-trigger" data-stimeo--sidebar-target="trigger"
              data-action="click->stimeo--sidebar#toggle" aria-expanded="true">Menu</button>
      <aside id="keyless-panel" data-stimeo--sidebar-target="panel"
             aria-label="Keyless" data-state="expanded">x</aside>
    </div>
    <div data-controller="stimeo--sidebar" data-stimeo--sidebar-key-value="main">
      <button id="keyed-trigger" data-stimeo--sidebar-target="trigger"
              data-action="click->stimeo--sidebar#toggle" aria-expanded="true">Menu</button>
      <aside id="keyed-panel" data-stimeo--sidebar-target="panel"
             aria-label="Keyed" data-state="expanded">y</aside>
    </div>`;
  const byId = (id: string) => document.getElementById(id) as HTMLElement;

  it("reads no stored preference for an instance without a key", async () => {
    localStorage.setItem("stimeo--sidebar:", "1");
    localStorage.setItem("stimeo--sidebar:main", "1");
    await start(keylessAndKeyed);

    expect(byId("keyed-panel").getAttribute("data-state")).toBe("collapsed");
    expect(byId("keyless-panel").getAttribute("data-state")).toBe("expanded");
    expect(byId("keyless-trigger").getAttribute("aria-expanded")).toBe("true");
  });

  it("writes no stored preference for an instance without a key", async () => {
    await start(keylessAndKeyed);

    byId("keyless-trigger").click();
    byId("keyed-trigger").click();

    expect(byId("keyless-panel").getAttribute("data-state")).toBe("collapsed");
    expect(byId("keyed-panel").getAttribute("data-state")).toBe("collapsed");
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem("stimeo--sidebar:main")).toBe("1");
  });

  it("reads nothing stored under an empty name for an instance without a key", async () => {
    localStorage.setItem("", "1");
    await start(keylessAndKeyed);

    expect(byId("keyless-panel").getAttribute("data-state")).toBe("expanded");
    expect(byId("keyless-trigger").getAttribute("aria-expanded")).toBe("true");
  });

  it("reflects the collapsed state on the trigger without a panel target", async () => {
    await start(`
      <div data-controller="stimeo--sidebar" data-stimeo--sidebar-collapsed-value="true">
        <button id="trigger" data-stimeo--sidebar-target="trigger"
                data-action="click->stimeo--sidebar#toggle" aria-expanded="true">Menu</button>
      </div>`);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    trigger().click();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("stays inline and restores the preference when matchMedia is unavailable", async () => {
    localStorage.setItem("stimeo--sidebar:main", "1");
    vi.stubGlobal("matchMedia", undefined);
    await start();
    expect(panel().getAttribute("data-mode")).toBe("inline");
    expect(panel().getAttribute("data-state")).toBe("collapsed");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    trigger().click();
    expect(panel().getAttribute("data-state")).toBe("expanded");
  });

  it("renders a replacement panel with the live inline state", async () => {
    await start();
    const replaceWithClone = async (renderedState: string): Promise<HTMLElement> => {
      const current = panel();
      const replacement = current.cloneNode(true) as HTMLElement;
      replacement.setAttribute("data-state", renderedState);
      current.replaceWith(replacement);
      controller().panelTargetConnected(replacement);
      await tick();
      return replacement;
    };

    const whileExpanded = await replaceWithClone("collapsed");
    expect(whileExpanded.getAttribute("data-state")).toBe("expanded");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    trigger().click();
    const whileCollapsed = await replaceWithClone("expanded");
    expect(whileCollapsed.getAttribute("data-state")).toBe("collapsed");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves a second panel target alone while the adopted panel stays connected", async () => {
    await start();
    const first = panel();
    const second = document.createElement("aside");
    second.setAttribute("data-stimeo--sidebar-target", "panel");
    second.setAttribute("aria-label", "Second");
    second.setAttribute("data-state", "collapsed");
    second.hidden = true;
    first.after(second);
    controller().panelTargetConnected(second);

    expect(second.hasAttribute("data-mode")).toBe(false);
    expect(second.getAttribute("data-state")).toBe("collapsed");
    expect(second.hidden).toBe(true);

    // Once the adopted panel leaves, the remaining target takes its place.
    first.remove();
    controller().panelTargetDisconnected(first);

    expect(second.getAttribute("data-mode")).toBe("inline");
    expect(second.getAttribute("data-state")).toBe("expanded");
    expect(second.hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("hides a re-rendered backdrop when it adopts a replacement inline panel", async () => {
    await start();
    // A re-render replaces the backdrop and the panel, the backdrop without `hidden`.
    const rendered = backdrop().cloneNode(false) as HTMLElement;
    rendered.hidden = false;
    rendered.removeAttribute("data-state");
    backdrop().replaceWith(rendered);
    const current = panel();
    const replacement = current.cloneNode(true) as HTMLElement;
    current.replaceWith(replacement);

    controller().panelTargetConnected(replacement);

    expect(rendered.hidden).toBe(true);
    expect(rendered.getAttribute("data-state")).toBe("closed");
  });

  // --- Storage key rewritten after connect -------------------------------------

  describe("key rewritten after connect", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    beforeEach(() => {
      capture = captureStateEvents("stimeo--sidebar", ["close", "open", "reconcile"]);
    });

    afterEach(() => {
      capture.stop();
    });

    /**
     * Rewrites the `key` declaration on the live element — `null` drops it — then runs
     * the callback Stimulus delivers for that write.
     */
    const declareKey = (key: string | null) => {
      if (key === null) root().removeAttribute("data-stimeo--sidebar-key-value");
      else root().setAttribute("data-stimeo--sidebar-key-value", key);
      controller().keyValueChanged();
    };

    it("applies the preference saved under the new key and reports it as reconcile", async () => {
      localStorage.setItem("stimeo--sidebar:account", "1");
      await start();
      expect(panel().getAttribute("data-state")).toBe("expanded");
      capture.clear();
      const setItem = vi.spyOn(localStorage, "setItem");

      declareKey("account");

      expect(panel().getAttribute("data-state")).toBe("collapsed");
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(capture.names()).toEqual(["reconcile"]);
      expect(capture.seen[0]?.detail).toEqual({ mode: "inline", open: false });
      // Switching the namespace moves nothing between keys and saves nothing.
      expect(setItem).not.toHaveBeenCalled();
      expect(localStorage.getItem("stimeo--sidebar:main")).toBeNull();
    });

    it("keeps the current state when the new key holds no saved preference", async () => {
      localStorage.setItem("stimeo--sidebar:main", "1");
      await start();
      expect(panel().getAttribute("data-state")).toBe("collapsed");
      capture.clear();
      const setItem = vi.spyOn(localStorage, "setItem");

      declareKey("fresh");
      declareKey(null);

      expect(panel().getAttribute("data-state")).toBe("collapsed");
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(capture.seen).toEqual([]);
      expect(setItem).not.toHaveBeenCalled();
      expect(localStorage.getItem("stimeo--sidebar:fresh")).toBeNull();
    });

    it("stays silent when the preference under the new key is already on screen", async () => {
      localStorage.setItem("stimeo--sidebar:account", "0");
      await start();
      capture.clear();

      declareKey("account");

      expect(panel().getAttribute("data-state")).toBe("expanded");
      expect(capture.seen).toEqual([]);
    });

    it("saves the next toggle under the new key only", async () => {
      await start();

      declareKey("account");
      trigger().click();

      expect(localStorage.getItem("stimeo--sidebar:account")).toBe("1");
      expect(localStorage.getItem("stimeo--sidebar:main")).toBeNull();
    });

    it("keeps a closed overlay closed and renders the new preference on the next inline mode", async () => {
      viewportWidth = 600;
      localStorage.setItem("stimeo--sidebar:account", "1");
      await start();
      capture.clear();

      declareKey("account");

      expect(panel().getAttribute("data-mode")).toBe("overlay");
      expect(panel().getAttribute("data-state")).toBe("closed");
      expect(panel().hidden).toBe(true);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(capture.seen).toEqual([]);

      changeViewport(true);

      expect(panel().getAttribute("data-state")).toBe("collapsed");
      expect(capture.names()).toEqual(["reconcile"]);
      expect(capture.seen[0]?.detail).toEqual({ mode: "inline", open: false });
    });

    it("reads storage again only when the key itself changes", async () => {
      await start();
      // Another tab saves a preference under the key this instance already reads.
      localStorage.setItem("stimeo--sidebar:main", "1");
      capture.clear();

      controller().keyValueChanged();

      expect(panel().getAttribute("data-state")).toBe("expanded");
      expect(capture.seen).toEqual([]);
    });

    it("follows the key the page wrote while the controller was away", async () => {
      localStorage.setItem("stimeo--sidebar:account", "1");
      await start();
      const instance = controller();
      instance.disconnect();
      root().setAttribute("data-stimeo--sidebar-key-value", "account");
      instance.keyValueChanged();
      expect(panel().getAttribute("data-state")).toBe("expanded");
      capture.clear();

      instance.connect();

      expect(panel().getAttribute("data-state")).toBe("collapsed");
      expect(capture.seen).toEqual([]);
    });
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

  it("returns focus to the trigger when nothing was focused before the overlay opened", async () => {
    viewportWidth = 600;
    await start();
    expect(document.activeElement).toBe(document.body);
    openAction().click();
    expect(document.activeElement).toBe(document.getElementById("first"));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("opens and closes the overlay without a trigger target", async () => {
    viewportWidth = 600;
    await start(`
      <p id="background">Background</p>
      <div data-controller="stimeo--sidebar">
        <button id="open-action" data-action="click->stimeo--sidebar#open">Open</button>
        <aside id="app-sidebar" data-stimeo--sidebar-target="panel" aria-label="Main">
          <a id="first" href="#a">A</a>
        </aside>
      </div>`);
    openAction().click();
    expect(panel().getAttribute("data-state")).toBe("open");
    expect(document.body.style.overflow).toBe("hidden");

    expect(() => controller().close()).not.toThrow();

    expect(panel().getAttribute("data-state")).toBe("closed");
    expect(panel().hidden).toBe(true);
    expect(document.body.style.overflow).toBe("");
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

  it("takes a Tab that does not wrap within the open overlay panel and moves focus itself", async () => {
    viewportWidth = 600;
    await start();
    trigger().click();
    const first = document.getElementById("first") as HTMLElement;
    first.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    first.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.getElementById("close-action"));
  });

  it("does not persist the transient overlay open state", async () => {
    viewportWidth = 600;
    await start();
    trigger().click();
    expect(localStorage.getItem("stimeo--sidebar:main")).toBeNull();
  });

  it("keeps an open overlay and its modal side effects through turbo:before-cache", async () => {
    // Turbo also dispatches the event on a page that stays (a promoted frame
    // navigation, a popstate without Turbo state, a refresh of a cached URL).
    viewportWidth = 600;
    await start();
    const background = document.getElementById("background") as HTMLElement;
    trigger().focus();
    trigger().click();

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(panel().getAttribute("data-state")).toBe("open");
    expect(panel().hidden).toBe(false);
    expect(backdrop().getAttribute("data-state")).toBe("open");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
    expect(background.inert).toBe(true);
    expect(document.activeElement).toBe(document.getElementById("first"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel().getAttribute("data-state")).toBe("closed");
    expect(document.body.style.overflow).toBe("");
    expect(background.inert).toBe(false);
  });

  it("keeps a dialog open inside the open overlay working through turbo:before-cache", async () => {
    viewportWidth = 600;
    await start(
      markup().replace(
        '<a id="last" href="#b">B</a>',
        `<a id="last" href="#b">B</a>
         <div data-controller="stimeo--dialog">
           <button id="dlg-open" data-stimeo--dialog-target="trigger" data-action="click->stimeo--dialog#open">Settings</button>
           <div id="dlg" role="dialog" aria-modal="true" aria-label="Settings" data-stimeo--dialog-target="dialog" hidden>
             <button id="dlg-close" data-action="click->stimeo--dialog#close">Close</button>
           </div>
         </div>`,
      ),
    );
    application.register("stimeo--dialog", DialogController);
    await tick();
    const background = document.getElementById("background") as HTMLElement;
    const dialog = document.getElementById("dlg") as HTMLElement;
    trigger().focus();
    trigger().click();
    (document.getElementById("dlg-open") as HTMLElement).focus();
    (document.getElementById("dlg-open") as HTMLElement).click();
    expect(dialog.hidden).toBe(false);

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(panel().hidden).toBe(false);
    expect(dialog.hidden).toBe(false);
    expect(panel().inert).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dialog.hidden).toBe(true);
    expect(panel().hidden).toBe(false);
    expect(panel().inert).toBe(false);
    expect(background.inert).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel().getAttribute("data-state")).toBe("closed");
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    expect(document.body.style.overflow).toBe("");
  });

  it("lets a pending close finish through turbo:before-cache", async () => {
    viewportWidth = 600;
    await start();
    vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
    vi.useFakeTimers();
    trigger().click();
    backdrop().click();
    expect(panel().hidden).toBe(false);

    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(panel().hidden).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");
    dispatchPanelTransition(panel(), "transitionend");

    expect(panel().getAttribute("data-state")).toBe("closed");
    expect(panel().hidden).toBe(true);
    expect(backdrop().hidden).toBe(true);
    expect(document.body.style.overflow).toBe("");
  });

  it("shows an overlay that was open closed on a copy of the page Turbo restores, the inline preference kept", async () => {
    viewportWidth = 600;
    localStorage.setItem("stimeo--sidebar:main", "1");
    await start();
    trigger().click();
    expect(panel().getAttribute("data-state")).toBe("open");
    const events = captureStateEvents("stimeo--sidebar", ["close", "open", "reconcile"]);

    application = await restoreFromCache(application, (restored) =>
      restored.register("stimeo--sidebar", SidebarController),
    );

    expect(panel().getAttribute("data-state")).toBe("closed");
    expect(panel().hidden).toBe(true);
    expect(backdrop().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    expect(document.body.style.overflow).toBe("");
    expect(events.seen).toEqual([]);
    events.stop();
    changeViewport(true);
    expect(panel().getAttribute("data-state")).toBe("collapsed");
  });

  it("keeps an open overlay open, trap included, when its element moves within the page", async () => {
    viewportWidth = 600;
    await start();
    trigger().click();
    const instance = controller();

    instance.disconnect();
    expect(document.body.style.overflow).toBe("");
    instance.connect();

    expect(panel().getAttribute("data-state")).toBe("open");
    expect(panel().hidden).toBe(false);
    expect(backdrop().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
    expect((document.getElementById("background") as HTMLElement).inert).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel().getAttribute("data-state")).toBe("closed");
    expect(document.body.style.overflow).toBe("");
  });

  it("keeps the durable inline preference through turbo:before-cache", async () => {
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

  it("moves the backdrop data-state with the panel, ahead of the exit transition", async () => {
    viewportWidth = 600;
    await start();
    vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
    trigger().click();
    expect(backdrop().getAttribute("data-state")).toBe("open");
    expect(backdrop().hidden).toBe(false);

    closeAction().click();
    expect(panel().getAttribute("data-state")).toBe("closed");
    expect(backdrop().getAttribute("data-state")).toBe("closed");
    expect(backdrop().hidden).toBe(false);

    dispatchPanelTransition(panel(), "transitionend");
    expect(backdrop().hidden).toBe(true);
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

  it.each(TARGET_SWAPS)(
    "keeps a modal opened over the overlay on top when its open panel is replaced %s",
    async (_, swap) => {
      viewportWidth = 600;
      await start();
      trigger().focus();
      trigger().click();
      const upper = openUpperModal();
      const successor = panel().cloneNode(true) as HTMLElement;
      await swap(panel(), successor);

      expectUpperModalOnTop(upper, successor);
      expect(successor.getAttribute("data-state")).toBe("open");
      expect(backdrop().hidden).toBe(false);
      typeKey(document, "Escape");
      expect(successor.hidden).toBe(true);
      expect(document.activeElement).toBe(trigger());
    },
  );

  it("adopts an open replacement inserted before the old panel is removed", async () => {
    viewportWidth = 600;
    await start();
    const background = document.getElementById("background") as HTMLElement;
    trigger().focus();
    trigger().click();
    const oldPanel = panel();
    const replacement = oldPanel.cloneNode(true) as HTMLElement;

    // The old panel is still connected, so the newcomer is not adopted yet.
    oldPanel.after(replacement);
    controller().panelTargetConnected(replacement);
    await tick();
    expect(document.activeElement).toBe(oldPanel.querySelector("#first"));

    oldPanel.remove();
    controller().panelTargetDisconnected(oldPanel);

    expect(panel()).toBe(replacement);
    expect(replacement.getAttribute("data-state")).toBe("open");
    expect(replacement.hidden).toBe(false);
    expect(backdrop().getAttribute("data-state")).toBe("open");
    expect(backdrop().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
    expect(background.inert).toBe(true);
    expect(document.activeElement).toBe(replacement.querySelector("#first"));
  });

  it("keeps the open overlay untouched when a panel target it does not own is removed", async () => {
    viewportWidth = 600;
    await start();
    const second = document.createElement("aside");
    second.setAttribute("data-stimeo--sidebar-target", "panel");
    second.setAttribute("aria-label", "Second");
    panel().after(second);
    controller().panelTargetConnected(second);
    await tick();
    trigger().focus();
    trigger().click();
    const last = document.getElementById("last") as HTMLElement;
    last.focus();

    second.remove();
    controller().panelTargetDisconnected(second);

    expect(second.hasAttribute("data-state")).toBe(false);
    expect(panel().getAttribute("data-state")).toBe("open");
    expect(backdrop().hidden).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.activeElement).toBe(last);
  });

  it("adopts a panel added to a sidebar that had none, closed in overlay mode", async () => {
    viewportWidth = 600;
    await start(`
      <div data-controller="stimeo--sidebar">
        <button id="trigger" data-stimeo--sidebar-target="trigger"
                data-action="click->stimeo--sidebar#toggle" aria-expanded="true">Menu</button>
      </div>`);
    const added = document.createElement("aside");
    added.setAttribute("data-stimeo--sidebar-target", "panel");
    added.setAttribute("aria-label", "Main");
    added.setAttribute("data-state", "expanded");

    root().append(added);
    controller().panelTargetConnected(added);

    expect(added.getAttribute("data-mode")).toBe("overlay");
    expect(added.getAttribute("data-state")).toBe("closed");
    expect(added.hidden).toBe(true);
  });

  it("closes the overlay with a rendered replacement that arrives before the open panel leaves", async () => {
    viewportWidth = 600;
    await start();
    trigger().focus();
    trigger().click();
    const open = panel();
    const replacement = open.cloneNode(true) as HTMLElement;
    replacement.setAttribute("data-mode", "inline");
    replacement.setAttribute("data-state", "expanded");

    open.before(replacement);
    open.remove();
    controller().panelTargetConnected(replacement);

    expect(replacement.getAttribute("data-mode")).toBe("overlay");
    expect(replacement.getAttribute("data-state")).toBe("closed");
    expect(replacement.hidden).toBe(true);
    expect(backdrop().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(trigger());
  });

  it("releases the overlay when the open panel is removed", async () => {
    viewportWidth = 600;
    await start();
    const background = document.getElementById("background") as HTMLElement;
    trigger().focus();
    trigger().click();
    const removed = panel();

    removed.remove();
    controller().panelTargetDisconnected(removed);

    expect(backdrop().hidden).toBe(true);
    expect(backdrop().getAttribute("data-state")).toBe("closed");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.body.style.overflow).toBe("");
    expect(background.inert).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it("keeps a panel that left while open closed when it comes back", async () => {
    viewportWidth = 600;
    await start();
    trigger().click();
    const removed = panel();
    const parent = removed.parentElement as HTMLElement;
    removed.remove();
    controller().panelTargetDisconnected(removed);

    parent.append(removed);
    controller().panelTargetConnected(removed);

    expect(removed.getAttribute("data-state")).toBe("closed");
    expect(removed.hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.body.style.overflow).toBe("");
  });

  it("drops the close-transition wait when the closing panel is removed", async () => {
    viewportWidth = 600;
    await start();
    vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
    vi.useFakeTimers();
    trigger().click();
    backdrop().click(); // exit transition pending
    const closing = panel();
    const released = vi.spyOn(closing, "removeEventListener");

    closing.remove();
    controller().panelTargetDisconnected(closing);

    expect(released.mock.calls.map(([type]) => type)).toEqual(
      expect.arrayContaining(["transitionend", "transitioncancel"]),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an open replacement that arrives before the closing panel leaves on screen", async () => {
    viewportWidth = 600;
    await start();
    vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
    vi.useFakeTimers();
    const background = document.getElementById("background") as HTMLElement;
    trigger().focus();
    trigger().click();
    backdrop().click(); // exit transition pending
    const closing = panel();
    const replacement = closing.cloneNode(true) as HTMLElement;
    replacement.setAttribute("data-state", "open");

    closing.before(replacement);
    closing.remove();
    controller().panelTargetConnected(replacement);
    expect(backdrop().hidden).toBe(false);

    // The overtaken close would have settled by now.
    vi.advanceTimersByTime(250);

    expect(replacement.hidden).toBe(false);
    expect(backdrop().hidden).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");
    expect(background.inert).toBe(true);
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

  it("keeps the tabindex its trap kept on a text-only panel that held focus into the inline mode when the sidebar moves within the page", async () => {
    viewportWidth = 600;
    await start(
      markup().replace(/<a id="first"[\s\S]*?<a id="last" href="#b">B<\/a>/, "<p>Text only</p>"),
    );
    trigger().click();
    expect(document.activeElement).toBe(panel());
    expect(panel().getAttribute("tabindex")).toBe("-1");
    changeViewport(true);
    expect(document.activeElement).toBe(panel());
    expect(panel().getAttribute("tabindex")).toBe("-1");
    trigger().focus();
    const sidebar = controller();

    document.body.append(document.createElement("hr"), root());
    await tick();

    expect(controller()).toBe(sidebar);
    expect(panel().getAttribute("data-mode")).toBe("inline");
    expect(panel().getAttribute("tabindex")).toBe("-1");
  });

  it("hides the backdrop when growing from an open overlay to the inline breakpoint", async () => {
    viewportWidth = 600;
    await start();
    trigger().click();
    expect(backdrop().hidden).toBe(false);

    changeViewport(true);

    expect(backdrop().hidden).toBe(true);
    expect(backdrop().getAttribute("data-state")).toBe("closed");
  });

  it("keeps the inline panel shown when a close pending at the breakpoint crossing would settle", async () => {
    viewportWidth = 600;
    await start();
    vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
    vi.useFakeTimers();
    trigger().click();
    backdrop().click(); // exit transition pending

    changeViewport(true);
    dispatchPanelTransition(panel(), "transitionend");
    vi.advanceTimersByTime(250);

    expect(panel().getAttribute("data-mode")).toBe("inline");
    expect(panel().hidden).toBe(false);
  });

  it("reveals the panel when growing from a closed overlay to the inline breakpoint", async () => {
    viewportWidth = 600;
    await start();
    expect(panel().hidden).toBe(true);

    changeViewport(true);

    expect(panel().getAttribute("data-mode")).toBe("inline");
    expect(panel().getAttribute("data-state")).toBe("expanded");
    expect(panel().hidden).toBe(false);
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

  it("releases the open overlay when a breakpoint change moves the mode to inline, and the next toggle reads the new mode", async () => {
    viewportWidth = 600;
    await start();
    const background = document.getElementById("background") as HTMLElement;
    trigger().click(); // overlay open
    expect(document.body.style.overflow).toBe("hidden");
    expect(background.inert).toBe(true);

    root().setAttribute("data-stimeo--sidebar-breakpoint-value", "500");
    await tick();
    expect(panel().getAttribute("data-mode")).toBe("inline");
    expect(document.body.style.overflow).toBe("");
    expect(background.inert).toBe(false);

    trigger().click();
    expect(panel().getAttribute("data-state")).toBe("collapsed");
    expect(document.body.style.overflow).toBe("");
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

  it("subscribes to no turbo:before-cache, which Turbo also dispatches on pages that stay", async () => {
    const added = vi.spyOn(document, "addEventListener");

    await start();

    expect(added.mock.calls.map(([type]) => type)).not.toContain("turbo:before-cache");
  });

  describe("declared actions after disconnect", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    beforeEach(() => {
      capture = captureStateEvents("stimeo--sidebar", ["close", "open", "reconcile"]);
    });

    afterEach(() => {
      capture.stop();
    });

    /**
     * Whether the overlay's modal side effects are held: the scroll lock, the background
     * `inert`, the Tab trap (a Tab from outside the panel is pulled inside) and the
     * Escape layer (an Escape is consumed).
     */
    const modalEffects = () => {
      trigger().focus();
      const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      document.dispatchEvent(tab);
      const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      document.dispatchEvent(esc);
      return {
        scrollLocked: document.body.style.overflow === "hidden",
        backgroundInert: (document.getElementById("background") as HTMLElement).inert,
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

    it("acquires nothing from an open or toggle on a closed overlay, and acts once connected", async () => {
      viewportWidth = 600;
      await start();
      const instance = controller();
      const setItem = vi.spyOn(localStorage, "setItem");
      instance.disconnect();
      capture.clear();

      for (const call of [() => instance.open(), () => instance.toggle()]) {
        call();
        expect(panel().getAttribute("data-state")).toBe("closed");
        expect(panel().hidden).toBe(true);
        expect(backdrop().hidden).toBe(true);
        expect(trigger().getAttribute("aria-expanded")).toBe("false");
        expect(modalEffects()).toEqual(released);
      }
      expect(capture.seen).toEqual([]);
      expect(setItem).not.toHaveBeenCalled();

      // Positive control: the same call acts on the same instance once it is connected.
      instance.connect();
      instance.open();
      expect(panel().getAttribute("data-state")).toBe("open");
      expect(capture.names()).toEqual(["open"]);
      expect(document.body.style.overflow).toBe("hidden");
    });

    it("leaves an overlay that was open at disconnect as it is on a close or toggle", async () => {
      viewportWidth = 600;
      await start();
      trigger().click();
      const instance = controller();
      instance.disconnect();
      capture.clear();

      for (const call of [() => instance.close(), () => instance.toggle()]) {
        call();
        expect(panel().getAttribute("data-state")).toBe("open");
        expect(panel().hidden).toBe(false);
        expect(backdrop().getAttribute("data-state")).toBe("open");
        expect(trigger().getAttribute("aria-expanded")).toBe("true");
      }
      expect(modalEffects()).toEqual(released);
      expect(capture.seen).toEqual([]);

      // Positive control: once connected again (which keeps the open overlay), the same call acts.
      instance.connect();
      instance.toggle();
      expect(panel().getAttribute("data-state")).toBe("closed");
      expect(capture.names()).toEqual(["close"]);
    });

    it("writes and saves nothing for a close, toggle or open on the inline rail", async () => {
      await start();
      const instance = controller();
      const setItem = vi.spyOn(localStorage, "setItem");
      instance.disconnect();
      capture.clear();

      for (const call of [() => instance.close(), () => instance.toggle(), () => instance.open()]) {
        call();
        expect(panel().getAttribute("data-state")).toBe("expanded");
        expect(trigger().getAttribute("aria-expanded")).toBe("true");
      }
      expect(setItem).not.toHaveBeenCalled();
      expect(capture.seen).toEqual([]);

      // Positive control: the same call collapses and saves once connected.
      instance.connect();
      instance.close();
      expect(panel().getAttribute("data-state")).toBe("collapsed");
      expect(setItem).toHaveBeenLastCalledWith("stimeo--sidebar:main", "1");
      expect(capture.names()).toEqual(["close"]);
    });

    it("owns no panel after disconnect, so a leaving one releases and adopts nothing", async () => {
      viewportWidth = 600;
      await start();
      const instance = controller();
      instance.disconnect();
      instance.open();
      expect(document.body.style.overflow).toBe("");
      const leaving = panel();
      const remaining = document.createElement("aside");
      remaining.setAttribute("data-stimeo--sidebar-target", "panel");
      remaining.setAttribute("aria-label", "Remaining");
      remaining.setAttribute("data-state", "open");
      remaining.innerHTML = `<a id="remaining-link" href="#r">R</a>`;
      leaving.after(remaining);
      capture.clear();

      leaving.remove();
      instance.panelTargetDisconnected(leaving);

      expect(remaining.hasAttribute("data-mode")).toBe(false);
      expect(remaining.getAttribute("data-state")).toBe("open");
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(modalEffects()).toEqual(released);
      expect(capture.seen).toEqual([]);
    });
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

  // --- State events ---

  describe("state events", () => {
    let capture: ReturnType<typeof captureStateEvents>;

    beforeEach(() => {
      capture = captureStateEvents("stimeo--sidebar", ["close", "open", "reconcile"]);
    });

    afterEach(() => {
      capture.stop();
    });

    it("reports an inline collapse and expand, naming the mode", async () => {
      await start();
      const states: string[] = [];
      root().addEventListener("stimeo--sidebar:close", () => {
        states.push(
          `${panel().getAttribute("data-state")} ${trigger().getAttribute("aria-expanded")}`,
        );
      });

      trigger().click();

      expect(capture.names()).toEqual(["close"]);
      expect(capture.seen[0]?.detail).toEqual({ reason: "user", mode: "inline" });
      expect(states).toEqual(["collapsed false"]);
      expect(capture.seen[0]?.bubbles).toBe(true);
      expect(capture.seen[0]?.cancelable).toBe(false);

      trigger().click();
      expect(capture.names()).toEqual(["close", "open"]);
      expect(capture.seen[1]?.detail).toEqual({ reason: "user", mode: "inline" });
    });

    it("reports an overlay open and close, naming the mode", async () => {
      viewportWidth = 600;
      await start();
      capture.clear();

      trigger().click();
      expect(capture.seen[0]?.detail).toEqual({ reason: "user", mode: "overlay" });

      closeAction().click();
      expect(capture.names()).toEqual(["open", "close"]);
      expect(capture.seen[1]?.detail).toEqual({ reason: "user", mode: "overlay" });
    });

    it("reports an overlay close once data-state and aria-expanded read closed", async () => {
      viewportWidth = 600;
      await start();
      trigger().click();
      const states: string[] = [];
      root().addEventListener("stimeo--sidebar:close", () => {
        states.push(
          `${panel().getAttribute("data-state")} ${trigger().getAttribute("aria-expanded")}`,
        );
      });

      closeAction().click();

      expect(states).toEqual(["closed false"]);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
    });

    it("reports a backdrop click as outside", async () => {
      viewportWidth = 600;
      await start();
      trigger().click();
      capture.clear();

      backdrop().click();

      expect(capture.names()).toEqual(["close"]);
      expect(capture.seen[0]?.detail).toEqual({ reason: "outside", mode: "overlay" });
    });

    it("reports Escape from the overlay as escape", async () => {
      viewportWidth = 600;
      await start();
      trigger().click();
      capture.clear();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      expect(capture.names()).toEqual(["close"]);
      expect(capture.seen[0]?.detail).toEqual({ reason: "escape", mode: "overlay" });
    });

    it("reports the expanded rail when the mode change lands on inline", async () => {
      viewportWidth = 600;
      await start();
      capture.clear();

      changeViewport(true);

      expect(capture.names()).toEqual(["reconcile"]);
      expect(capture.seen[0]?.detail).toEqual({ mode: "inline", open: true });
    });

    it("closes an open overlay through toggle", async () => {
      viewportWidth = 600;
      await start();
      trigger().click();
      capture.clear();

      trigger().click();

      expect(panel().getAttribute("data-state")).toBe("closed");
      expect(capture.names()).toEqual(["close"]);
    });

    it("does nothing for a call made after disconnect", async () => {
      await start();
      const instance = controller();
      const setItem = vi.spyOn(localStorage, "setItem");
      instance.disconnect();
      capture.clear();

      instance.close();

      expect(capture.seen).toEqual([]);
      expect(panel().getAttribute("data-state")).toBe("expanded");
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(setItem).not.toHaveBeenCalled();
    });

    it("reports a viewport-driven mode change as reconcile, without a reason", async () => {
      await start();
      capture.clear();

      changeViewport(false);

      expect(capture.names()).toEqual(["reconcile"]);
      expect(capture.seen[0]?.detail).toEqual({ mode: "overlay", open: false });
      expect(capture.seen[0]?.cancelable).toBe(false);
    });

    it("stays silent while connect establishes the baseline", async () => {
      const fresh = captureStateEvents("stimeo--sidebar", ["close", "open", "reconcile"]);
      await start();

      expect(panel().getAttribute("data-mode")).toBe("inline");
      expect(fresh.seen).toEqual([]);
      fresh.stop();
    });

    it("stays silent for an idempotent call, and turbo:before-cache neither closes nor reports", async () => {
      viewportWidth = 600;
      await start();
      capture.clear();

      controller().close();
      expect(capture.seen).toEqual([]);

      trigger().click();
      capture.clear();
      document.dispatchEvent(new Event("turbo:before-cache"));

      expect(panel().getAttribute("data-state")).toBe("open");
      expect(capture.seen).toEqual([]);
    });

    it("stays silent when the open overlay is opened again", async () => {
      viewportWidth = 600;
      await start();
      trigger().click();
      const last = document.getElementById("last") as HTMLElement;
      last.focus();
      capture.clear();

      openAction().click();

      expect(capture.seen).toEqual([]);
      expect(panel().getAttribute("data-state")).toBe("open");
      expect(document.activeElement).toBe(last);
    });
  });

  // --- Re-entry from a subscriber ---

  describe("re-entry from a subscriber", () => {
    it("drops the modal side effects when the open handler closes it again", async () => {
      viewportWidth = 600;
      await start();
      root().addEventListener("stimeo--sidebar:open", () => controller().close());

      trigger().click();

      expect(panel().getAttribute("data-state")).toBe("closed");
      expect(document.body.style.overflow).toBe("");
    });

    it("keeps the panel on screen when the close handler reopens it", async () => {
      viewportWidth = 600;
      await start();
      trigger().click();
      root().addEventListener("stimeo--sidebar:close", () => controller().open());

      closeAction().click();

      expect(panel().getAttribute("data-state")).toBe("open");
      expect(panel().hidden).toBe(false);
    });

    it("hands no remaining panel the modal once the close handler has disconnected it", async () => {
      viewportWidth = 600;
      await start();
      const instance = controller();
      trigger().click();
      root().addEventListener("stimeo--sidebar:close", () => instance.disconnect());
      // The close goes on after its handler returns and keeps the closing panel for the
      // exit transition, so that panel leaving afterwards reaches the departure path.
      instance.close();
      const leaving = panel();
      const remaining = leaving.cloneNode(true) as HTMLElement;
      for (const node of [
        remaining,
        ...Array.from(remaining.querySelectorAll<HTMLElement>("[id]")),
      ]) {
        node.removeAttribute("id");
      }
      remaining.removeAttribute("data-mode");
      remaining.setAttribute("data-state", "open");
      remaining.hidden = false;
      leaving.after(remaining);

      leaving.remove();
      instance.panelTargetDisconnected(leaving);

      expect(remaining.hasAttribute("data-mode")).toBe(false);
      expect(document.body.style.overflow).toBe("");
      expect((document.getElementById("background") as HTMLElement).inert).toBe(false);
    });

    it("releases the modal the open handler's disconnect left once the closing panel leaves", async () => {
      viewportWidth = 600;
      await start();
      const instance = controller();
      root().addEventListener("stimeo--sidebar:open", () => instance.disconnect(), { once: true });
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
      for (const node of [
        remaining,
        ...Array.from(remaining.querySelectorAll<HTMLElement>("[id]")),
      ]) {
        node.removeAttribute("id");
      }
      remaining.removeAttribute("data-mode");
      remaining.setAttribute("data-state", "open");
      remaining.hidden = false;
      leaving.after(remaining);

      leaving.remove();
      instance.panelTargetDisconnected(leaving);

      expect(document.body.style.overflow).toBe("");
      expect((document.getElementById("background") as HTMLElement).inert).toBe(false);
      expect(remaining.hasAttribute("data-mode")).toBe(false);
      expect(remaining.getAttribute("data-state")).toBe("open");
    });
  });

  // --- A trigger or backdrop that replaces the current one ------------------------

  describe("a panel that moves or stops resolving", () => {
    const targetAttribute = "data-stimeo--sidebar-target";
    const background = () => document.getElementById("background") as HTMLElement;
    const stateOf = (element: HTMLElement) => [
      element.getAttribute("data-mode"),
      element.getAttribute("data-state"),
      element.hidden,
    ];
    /** Focuses a button outside the sidebar, so a close has an opener of its own to return to. */
    const focusElsewhere = (): HTMLElement => {
      const elsewhere = document.createElement("button");
      elsewhere.textContent = "Elsewhere";
      document.body.prepend(elsewhere);
      elsewhere.focus();
      return elsewhere;
    };
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

    it("keeps an open overlay panel that moves within the element open, opener included", async () => {
      viewportWidth = 600;
      await start();
      const elsewhere = focusElsewhere();
      controller().open();
      const moving = panel();
      root().append(moving);
      await tick();

      expect(stateOf(moving)).toEqual(["overlay", "open", false]);
      expect(backdrop().getAttribute("data-state")).toBe("open");
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(document.body.style.overflow).toBe("hidden");
      expect(background().inert).toBe(true);
      controller().close();
      expect(document.activeElement).toBe(elsewhere);
    });

    it("keeps the exit transition of an overlay panel that moves within the element", async () => {
      viewportWidth = 600;
      await start();
      vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
      controller().open();
      controller().close(); // exit transition pending
      const moving = panel();
      root().append(moving);
      await tick();

      expect(stateOf(moving)).toEqual(["overlay", "closed", false]);
      expect(document.body.style.overflow).toBe("hidden");

      dispatchPanelTransition(moving, "transitionend");

      expect(moving.hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
    });

    it("writes nothing on an inline panel that moves within the element", async () => {
      await start();
      trigger().click();
      const moving = panel();

      const writes = await attributeWrites(moving, ["data-mode", "data-state", "hidden"], () =>
        root().append(moving),
      );

      expect(stateOf(moving)).toEqual(["inline", "collapsed", false]);
      expect(writes).toEqual([]);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
    });

    it("reports nothing while an open overlay panel moves within the element", async () => {
      viewportWidth = 600;
      await start();
      controller().open();
      const capture = captureStateEvents("stimeo--sidebar", ["close", "open", "reconcile"]);
      root().append(panel());
      await tick();

      expect(capture.seen).toEqual([]);
      capture.stop();
    });

    it("closes a moved panel that another panel now precedes, and adopts that one", async () => {
      viewportWidth = 600;
      await start();
      controller().open();
      const moving = panel();
      const ahead = moving.cloneNode(true) as HTMLElement;
      for (const node of [ahead, ...Array.from(ahead.querySelectorAll<HTMLElement>("[id]"))]) {
        node.id = `ahead-${node.id}`;
      }
      moving.after(ahead);
      await tick();
      ahead.after(moving);
      await tick();

      expect(moving.getAttribute("data-state")).toBe("closed");
      expect(moving.hidden).toBe(true);
      expect(ahead.getAttribute("data-state")).toBe("open");
      expect(document.body.style.overflow).toBe("hidden");
      expect(document.activeElement?.id).toBe("ahead-first");
    });

    it("gives a panel left in the page without its target token its own values back, and closes", async () => {
      viewportWidth = 600;
      await start();
      trigger().focus();
      controller().open();
      const departed = panel();
      departed.removeAttribute(targetAttribute);
      await tick();

      expect(stateOf(departed)).toEqual(["inline", "expanded", false]);
      expect(backdrop().hidden).toBe(true);
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(document.body.style.overflow).toBe("");
      expect(document.activeElement).toBe(trigger());
    });

    it("gives a closed overlay panel that loses its target token the visibility it was authored with", async () => {
      viewportWidth = 600;
      await start();
      const departed = panel();
      expect(stateOf(departed)).toEqual(["overlay", "closed", true]);
      departed.removeAttribute(targetAttribute);
      await tick();

      expect(stateOf(departed)).toEqual(["inline", "expanded", false]);
    });

    it("reveals a replacement overlay panel that arrives open but hidden", async () => {
      viewportWidth = 600;
      await start();
      const replacement = panel().cloneNode(true) as HTMLElement;
      replacement.setAttribute("data-state", "open");
      replacement.hidden = true;
      panel().replaceWith(replacement);
      await tick();

      expect(replacement.hidden).toBe(false);
      expect(backdrop().getAttribute("data-state")).toBe("open");
      expect(document.body.style.overflow).toBe("hidden");
    });

    it("gives the panel back its own values when the sidebar loses its controller", async () => {
      viewportWidth = 600;
      await start();
      controller().open();
      const departed = panel();
      root().removeAttribute("data-controller");
      await tick();

      expect(stateOf(departed)).toEqual(["inline", "expanded", false]);
      expect(document.body.style.overflow).toBe("");
    });

    it("keeps a value the page wrote on the panel after the controller did", async () => {
      viewportWidth = 600;
      await start();
      controller().open();
      const departed = panel();
      departed.setAttribute("hidden", "until-found");
      departed.removeAttribute(targetAttribute);
      await tick();

      expect(departed.getAttribute("hidden")).toBe("until-found");
      expect(document.body.style.overflow).toBe("");
    });

    it("keeps what it wrote on a panel that leaves with the controller element", async () => {
      viewportWidth = 600;
      await start();
      controller().open();
      const departing = panel();
      root().remove();
      await tick();

      expect(stateOf(departing)).toEqual(["overlay", "open", false]);
      expect(document.body.style.overflow).toBe("");
    });
  });

  describe("a trigger that replaces the current one", () => {
    const targetAttribute = "data-stimeo--sidebar-target";
    const triggers = () =>
      Array.from(document.querySelectorAll<HTMLElement>(`[${targetAttribute}='trigger']`));
    /** A server-rendered trigger: no id, `aria-expanded` as `authored`. */
    const triggerCopy = (authored = "true"): HTMLElement => {
      const copy = trigger().cloneNode(true) as HTMLElement;
      copy.removeAttribute("id");
      copy.setAttribute("aria-expanded", authored);
      return copy;
    };
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

    it("reflects the collapsed rail onto a trigger that replaces the current one in one task", async () => {
      await start();
      trigger().click();
      const successor = triggerCopy("true");
      trigger().replaceWith(successor);
      await tick();

      expect(successor.getAttribute("aria-expanded")).toBe("false");
    });

    it("reflects a collapse made while two coexist onto the trigger that stays", async () => {
      await start();
      const original = trigger();
      const successor = triggerCopy("true");
      original.after(successor);
      await tick();
      controller().toggle();
      original.remove();
      await tick();

      expect(successor.getAttribute("aria-expanded")).toBe("false");
      expect(panel().getAttribute("data-state")).toBe("collapsed");
    });

    it("reflects the open overlay onto a trigger that replaces the current one", async () => {
      viewportWidth = 600;
      await start();
      trigger().click();
      const successor = triggerCopy("false");
      trigger().replaceWith(successor);
      await tick();

      expect(successor.getAttribute("aria-expanded")).toBe("true");
      controller().close();
      expect(successor.getAttribute("aria-expanded")).toBe("false");
    });

    it("reflects the state onto a trigger that arrives after the only one left", async () => {
      await start();
      trigger().click();
      const arrival = triggerCopy("true");
      trigger().remove();
      await tick();
      root().prepend(arrival);
      await tick();

      expect(arrival.getAttribute("aria-expanded")).toBe("false");
    });

    it("keeps working when the only trigger leaves", async () => {
      await start();
      const errors: unknown[] = [];
      application.handleError = (error) => {
        errors.push(error);
      };
      trigger().remove();
      await tick();
      controller().toggle();

      expect(errors).toEqual([]);
      expect(panel().getAttribute("data-state")).toBe("collapsed");
    });

    it("reports nothing while it syncs a replacing trigger", async () => {
      await start();
      trigger().click();
      const [first, second] = [triggerCopy("true"), triggerCopy("true")];
      const capture = captureStateEvents("stimeo--sidebar", ["close", "open", "reconcile"]);
      trigger().replaceWith(first);
      await tick();
      const original = triggers()[0] as HTMLElement;
      original.after(second);
      await tick();
      original.remove();
      await tick();

      expect(capture.seen).toEqual([]);
      capture.stop();
    });

    it("writes nothing once it has disconnected", async () => {
      await start();
      trigger().click();
      const original = trigger();
      const successor = triggerCopy("true");
      original.after(successor);
      await tick();
      controller().disconnect();
      original.remove();
      await tick();

      expect(successor.getAttribute("aria-expanded")).toBe("true");
    });

    it("gives a trigger left in the page without its target token its own aria-expanded back", async () => {
      await start();
      trigger().click();
      const original = trigger();
      const successor = triggerCopy("true");
      original.after(successor);
      await tick();
      original.removeAttribute(targetAttribute);
      await tick();

      expect(original.getAttribute("aria-expanded")).toBe("true");
      expect(successor.getAttribute("aria-expanded")).toBe("false");
    });

    it("gives the trigger back its own aria-expanded when the sidebar loses its controller", async () => {
      await start();
      trigger().click();
      expect(trigger().getAttribute("aria-expanded")).toBe("false");

      root().removeAttribute("data-controller");
      await tick();

      expect(trigger().getAttribute("aria-expanded")).toBe("true");
    });

    it("keeps an aria-expanded the page wrote after the controller did", async () => {
      await start();
      trigger().click();
      trigger().setAttribute("aria-expanded", "mixed");
      root().removeAttribute("data-controller");
      await tick();

      expect(trigger().getAttribute("aria-expanded")).toBe("mixed");
    });

    it("keeps what it wrote on a trigger that moves within the element", async () => {
      await start();
      trigger().click();
      const moving = trigger();

      const writes = await attributeWrites(moving, ["aria-expanded"], () => root().append(moving));

      expect(moving.getAttribute("aria-expanded")).toBe("false");
      expect(writes).toEqual([]);
    });
  });

  describe("a backdrop that replaces the current one", () => {
    const targetAttribute = "data-stimeo--sidebar-target";
    const backdrops = () =>
      Array.from(document.querySelectorAll<HTMLElement>(`[${targetAttribute}='backdrop']`));
    /** A server-rendered backdrop, `hidden` and without `data-state` as the markup authors it. */
    const backdropCopy = (): HTMLElement => {
      const copy = backdrop().cloneNode(true) as HTMLElement;
      copy.removeAttribute("id");
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

    it("shows a backdrop that replaces the current one in one task while the overlay is open", async () => {
      viewportWidth = 600;
      await start();
      controller().open();
      const successor = backdropCopy();
      backdrop().replaceWith(successor);
      await tick();

      expect(stateOf(successor)).toEqual(["open", false]);
    });

    it("shows the backdrop that stays when the overlay opened while two coexisted", async () => {
      viewportWidth = 600;
      await start();
      const original = backdrop();
      const successor = backdropCopy();
      original.after(successor);
      await tick();
      controller().open();
      original.remove();
      await tick();

      expect(stateOf(successor)).toEqual(["open", false]);
    });

    it("hides a backdrop that replaces the current one in inline mode", async () => {
      await start();
      const successor = backdropCopy();
      successor.setAttribute("data-state", "open");
      successor.hidden = false;
      backdrop().replaceWith(successor);
      await tick();

      expect(stateOf(successor)).toEqual(["closed", true]);
    });

    it("keeps a backdrop that replaces the current one shown until the close transition ends", async () => {
      viewportWidth = 600;
      await start();
      vi.spyOn(window, "getComputedStyle").mockReturnValue(transitionStyle());
      controller().open();
      controller().close(); // exit transition pending
      const successor = backdropCopy();
      backdrop().replaceWith(successor);
      await tick();

      expect(stateOf(successor)).toEqual(["closed", false]);

      dispatchPanelTransition(panel(), "transitionend");

      expect(stateOf(successor)).toEqual(["closed", true]);
    });

    it("shows a backdrop that arrives after the only one left while the overlay is open", async () => {
      viewportWidth = 600;
      await start();
      controller().open();
      const arrival = backdropCopy();
      backdrop().remove();
      await tick();
      root().append(arrival);
      await tick();

      expect(stateOf(arrival)).toEqual(["open", false]);
    });

    it("keeps working when the only backdrop leaves", async () => {
      viewportWidth = 600;
      await start();
      const errors: unknown[] = [];
      application.handleError = (error) => {
        errors.push(error);
      };
      controller().open();
      backdrop().remove();
      await tick();
      controller().close();

      expect(errors).toEqual([]);
      expect(panel().getAttribute("data-state")).toBe("closed");
      expect(document.body.style.overflow).toBe("");
    });

    it("reports nothing while it syncs a replacing backdrop", async () => {
      viewportWidth = 600;
      await start();
      controller().open();
      const [first, second] = [backdropCopy(), backdropCopy()];
      const capture = captureStateEvents("stimeo--sidebar", ["close", "open", "reconcile"]);
      backdrop().replaceWith(first);
      await tick();
      const original = backdrops()[0] as HTMLElement;
      original.after(second);
      await tick();
      original.remove();
      await tick();

      expect(capture.seen).toEqual([]);
      capture.stop();
    });

    it("syncs nothing once it has disconnected", async () => {
      viewportWidth = 600;
      await start();
      controller().open();
      const original = backdrop();
      const successor = backdropCopy();
      original.after(successor);
      await tick();
      controller().disconnect();
      original.remove();
      await tick();

      expect(stateOf(successor)).toEqual([null, true]);
    });

    it("gives a backdrop left in the page without its target token its own values back", async () => {
      viewportWidth = 600;
      await start();
      controller().open();
      const original = backdrop();
      const successor = backdropCopy();
      original.after(successor);
      await tick();
      original.removeAttribute(targetAttribute);
      await tick();

      expect(stateOf(original)).toEqual([null, true]);
      expect(stateOf(successor)).toEqual(["open", false]);
    });

    it("gives the backdrop back its own values when the sidebar loses its controller", async () => {
      viewportWidth = 600;
      await start();
      controller().open();
      const departed = backdrop();
      root().removeAttribute("data-controller");
      await tick();

      expect(stateOf(departed)).toEqual([null, true]);
      expect(document.body.style.overflow).toBe("");
    });

    it("keeps a value the page wrote on the backdrop after the controller did", async () => {
      viewportWidth = 600;
      await start();
      controller().open();
      const departed = backdrop();
      departed.setAttribute("data-state", "page");
      departed.setAttribute("hidden", "until-found");
      root().removeAttribute("data-controller");
      await tick();

      expect(departed.getAttribute("data-state")).toBe("page");
      expect(departed.getAttribute("hidden")).toBe("until-found");
    });

    it("keeps what it wrote on a backdrop that moves within the element", async () => {
      viewportWidth = 600;
      await start();
      controller().open();
      const moving = backdrop();

      const writes = await attributeWrites(moving, ["data-state", "hidden"], () =>
        root().append(moving),
      );

      expect(stateOf(moving)).toEqual(["open", false]);
      expect(writes).toEqual([]);
    });
  });
});
