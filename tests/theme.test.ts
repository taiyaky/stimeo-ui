import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeController } from "../src/controllers/theme_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link ThemeController}: applying the resolved theme to the
 * root, the 3-value radiogroup (aria-checked + roving tabindex + arrow keys), the
 * 2-value toggle (aria-pressed), localStorage persistence/restore, live `system`
 * following via matchMedia, the change event, and listener teardown.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let mediaMatches = false;
let mediaListeners: Array<() => void> = [];

/** Installs a controllable matchMedia whose `matches` is a live getter. */
const installMatchMedia = () => {
  mediaMatches = false;
  mediaListeners = [];
  window.matchMedia = ((queryString: string) => ({
    media: queryString,
    get matches() {
      return mediaMatches;
    },
    addEventListener: (_: string, cb: () => void) => mediaListeners.push(cb),
    removeEventListener: (_: string, cb: () => void) => {
      mediaListeners = mediaListeners.filter((l) => l !== cb);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;
};

/** Flips the simulated OS preference and notifies listeners. */
const setSystemDark = (dark: boolean) => {
  mediaMatches = dark;
  for (const cb of [...mediaListeners]) cb();
};

const root = () => document.documentElement;

describe("ThemeController", () => {
  let application: Application;

  const RADIOGROUP = (attrs = `data-stimeo--theme-mode-value="system"`) => `
    <div data-controller="stimeo--theme" ${attrs} role="radiogroup" aria-label="Theme">
      <button data-stimeo--theme-target="option" role="radio"
              data-action="click->stimeo--theme#set"
              data-stimeo--theme-mode-param="light">Light</button>
      <button data-stimeo--theme-target="option" role="radio"
              data-action="click->stimeo--theme#set"
              data-stimeo--theme-mode-param="dark">Dark</button>
      <button data-stimeo--theme-target="option" role="radio"
              data-action="click->stimeo--theme#set"
              data-stimeo--theme-mode-param="system">System</button>
    </div>`;

  const TOGGLE = `
    <button data-controller="stimeo--theme" data-action="click->stimeo--theme#toggle"
            aria-pressed="false" aria-label="Toggle dark mode">Toggle</button>`;

  const start = async (markup: string) => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--theme", ThemeController);
    await tick();
  };

  beforeEach(() => {
    installMatchMedia();
  });

  afterEach(() => {
    application?.stop();
    document.body.innerHTML = "";
    root().removeAttribute("data-theme");
    root().style.removeProperty("color-scheme");
    window.localStorage.clear();
  });

  const options = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--theme-target='option']"));
  const optionByMode = (mode: string) =>
    query<HTMLElement>(`[data-stimeo--theme-mode-param='${mode}']`);

  it("applies the resolved theme to the root on connect (system → light)", async () => {
    await start(RADIOGROUP());
    expect(root().getAttribute("data-theme")).toBe("light");
    expect(root().style.getPropertyValue("color-scheme")).toBe("light");
  });

  it("resolves system to dark when the OS prefers dark", async () => {
    mediaMatches = true;
    await start(RADIOGROUP());
    expect(root().getAttribute("data-theme")).toBe("dark");
  });

  it("sets an explicit mode on click, syncing aria-checked and persisting", async () => {
    await start(RADIOGROUP());
    optionByMode("dark").click();
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(optionByMode("dark").getAttribute("aria-checked")).toBe("true");
    expect(optionByMode("light").getAttribute("aria-checked")).toBe("false");
    expect(window.localStorage.getItem("stimeo-theme")).toBe("dark");
  });

  it("keeps a roving tabindex on the radiogroup (only the selected option tabbable)", async () => {
    await start(RADIOGROUP());
    // system is selected by default.
    expect(optionByMode("system").tabIndex).toBe(0);
    expect(optionByMode("light").tabIndex).toBe(-1);
    optionByMode("light").click();
    expect(optionByMode("light").tabIndex).toBe(0);
    expect(optionByMode("system").tabIndex).toBe(-1);
  });

  it("navigates and selects with arrow keys (APG radio)", async () => {
    await start(RADIOGROUP(`data-stimeo--theme-mode-value="light"`));
    const light = optionByMode("light");
    light.focus();
    light.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(optionByMode("dark"));
    expect(optionByMode("dark").getAttribute("aria-checked")).toBe("true");
    expect(root().getAttribute("data-theme")).toBe("dark");
  });

  it("navigates with ArrowLeft/ArrowUp and wraps to the last option", async () => {
    await start(RADIOGROUP(`data-stimeo--theme-mode-value="light"`));
    const press = (mode: string, key: string) =>
      optionByMode(mode).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    optionByMode("light").focus();
    press("light", "ArrowLeft"); // wraps from first → last
    expect(document.activeElement).toBe(optionByMode("system"));
    expect(optionByMode("system").getAttribute("aria-checked")).toBe("true");
    press("system", "ArrowUp"); // → previous (dark)
    expect(document.activeElement).toBe(optionByMode("dark"));
  });

  it("wraps from the last option to the first with ArrowRight", async () => {
    await start(RADIOGROUP(`data-stimeo--theme-mode-value="system"`));
    optionByMode("system").focus();
    optionByMode("system").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(document.activeElement).toBe(optionByMode("light"));
  });

  it("jumps to the first/last option with Home/End", async () => {
    await start(RADIOGROUP(`data-stimeo--theme-mode-value="dark"`));
    const press = (mode: string, key: string) =>
      optionByMode(mode).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    optionByMode("dark").focus();
    press("dark", "End");
    expect(document.activeElement).toBe(optionByMode("system"));
    press("system", "Home");
    expect(document.activeElement).toBe(optionByMode("light"));
    expect(optionByMode("light").getAttribute("aria-checked")).toBe("true");
  });

  it("ignores non-navigation keys without selecting", async () => {
    await start(RADIOGROUP(`data-stimeo--theme-mode-value="light"`));
    optionByMode("light").focus();
    optionByMode("light").dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(optionByMode("light").getAttribute("aria-checked")).toBe("true");
  });

  it("applies the theme to a custom target element, not the document root", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--theme" data-stimeo--theme-target-value="#preview"
           data-stimeo--theme-mode-value="light" role="radiogroup" aria-label="Theme">
        <button data-stimeo--theme-target="option" role="radio"
                data-action="click->stimeo--theme#set"
                data-stimeo--theme-mode-param="dark">Dark</button>
      </div>
      <div id="preview"></div>`;
    application = Application.start();
    application.register("stimeo--theme", ThemeController);
    await tick();
    optionByMode("dark").click();
    expect(query("#preview").getAttribute("data-theme")).toBe("dark");
    // The document root is untouched when a custom target is configured.
    expect(root().hasAttribute("data-theme")).toBe(false);
  });

  it("ignores an invalid mode from the set action", async () => {
    await start(RADIOGROUP(`data-stimeo--theme-mode-value="light"`));
    const controller = application.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--theme']"),
      "stimeo--theme",
    ) as ThemeController;
    controller.set({ params: { mode: "bogus" } } as unknown as Event);
    expect(optionByMode("light").getAttribute("aria-checked")).toBe("true");
    expect(root().getAttribute("data-theme")).toBe("light");
  });

  it("dispatches change with mode and resolved", async () => {
    await start(RADIOGROUP());
    const log: Array<{ mode: string; resolved: string }> = [];
    query("[data-controller='stimeo--theme']").addEventListener("stimeo--theme:change", (e) => {
      log.push((e as CustomEvent<{ mode: string; resolved: string }>).detail);
    });
    optionByMode("dark").click();
    expect(log).toEqual([{ mode: "dark", resolved: "dark" }]);
  });

  it("follows the OS preference live while in system mode", async () => {
    await start(RADIOGROUP());
    expect(root().getAttribute("data-theme")).toBe("light");
    setSystemDark(true);
    expect(root().getAttribute("data-theme")).toBe("dark");
    setSystemDark(false);
    expect(root().getAttribute("data-theme")).toBe("light");
  });

  it("stops following the OS once an explicit mode is chosen", async () => {
    await start(RADIOGROUP());
    optionByMode("light").click();
    setSystemDark(true);
    // Explicit light wins; the system change is ignored.
    expect(root().getAttribute("data-theme")).toBe("light");
  });

  it("restores the persisted mode on connect", async () => {
    window.localStorage.setItem("stimeo-theme", "dark");
    await start(RADIOGROUP());
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(optionByMode("dark").getAttribute("aria-checked")).toBe("true");
  });

  it("toggles light↔dark on the 2-value button, syncing aria-pressed", async () => {
    await start(TOGGLE);
    const button = query<HTMLButtonElement>("[data-controller='stimeo--theme']");
    // system resolves to light initially; first toggle → dark.
    button.click();
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    button.click();
    expect(root().getAttribute("data-theme")).toBe("light");
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the 2-value toggle's aria-pressed in sync when the OS flips in system mode", async () => {
    await start(TOGGLE);
    const button = query<HTMLButtonElement>("[data-controller='stimeo--theme']");
    // Default mode is system; OS starts light → not pressed.
    expect(button.getAttribute("aria-pressed")).toBe("false");
    // OS flips to dark while still in system mode: data-theme AND aria-pressed follow.
    setSystemDark(true);
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("stops following the OS after disconnect", async () => {
    await start(RADIOGROUP());
    const controller = application.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--theme']"),
      "stimeo--theme",
    ) as ThemeController;
    controller.disconnect();
    setSystemDark(true);
    expect(root().getAttribute("data-theme")).toBe("light");
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(`<main>${RADIOGROUP()}</main>`);
    await expectNoA11yViolations(document.body);
    // touch options() so the helper is exercised and lint stays clean
    expect(options().length).toBe(3);
  });
});
