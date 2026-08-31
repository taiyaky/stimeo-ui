import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeController } from "../src/controllers/theme_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ThemeController}: applying the resolved theme to the
 * root, the 3-value radiogroup (aria-checked + roving tabindex + arrow keys), the
 * 2-value toggle (aria-pressed), localStorage persistence/restore, live `system`
 * following via matchMedia, the change event, and listener teardown.
 */

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
              data-value="light">Light</button>
      <button data-stimeo--theme-target="option" role="radio"
              data-action="click->stimeo--theme#set"
              data-value="dark">Dark</button>
      <button data-stimeo--theme-target="option" role="radio"
              data-action="click->stimeo--theme#set"
              data-value="system">System</button>
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
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    root().removeAttribute("data-theme");
    root().style.removeProperty("color-scheme");
    window.localStorage.clear();
  });

  const options = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--theme-target='option']"));
  const optionByMode = (mode: string) => query<HTMLElement>(`[data-value='${mode}']`);

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

  it("yields a key a widget on the option already consumed", async () => {
    // A composed widget that claims the key must not ALSO act on it —
    // composition depends on this yield.
    //
    // The claim has to come from a handler on the OPTION, not from a node nested
    // inside it. This controller resolves the current index with
    // `optionTargets.indexOf(event.target)`, an identity check: an event sourced
    // from a nested child answers -1 and returns before any navigation, so the
    // guard is never what stopped it and removing the guard changes nothing.
    // Dispatching on the option itself is also the real composition — the
    // claiming widget (a grabbed drag handle) is bound to the same element that
    // is the option.
    await start(RADIOGROUP());
    const first = optionByMode("system");
    first.focus();
    // Registered on the option, so it runs before the controller's own keydown
    // listener on the container sees the same bubbling event.
    first.addEventListener("keydown", (event) => event.preventDefault());

    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    const notCanceled = first.dispatchEvent(event);

    // Without the guard this wraps from the last option to the first, focuses it
    // and commits the mode — so the yield has to hold both.
    expect(notCanceled).toBe(false); // the claim really took (a non-cancelable event would not)
    expect(document.activeElement).toBe(first);
    expect(optionByMode("light").getAttribute("aria-checked")).toBe("false");
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

  it("reverses the horizontal arrows under RTL, leaving Down/Up alone", async () => {
    // Logical direction: APG describes the horizontal pair as "next / previous",
    // so it reverses with the writing direction. `dir="rtl"` is the authoring
    // contract, but happy-dom does not resolve it into the computed style, so the
    // direction is set as an inline style instead.
    await start(RADIOGROUP(`data-stimeo--theme-mode-value="light"`));
    const group = optionByMode("light").closest("[role='radiogroup']") as HTMLElement;
    group.style.direction = "rtl";
    const press = (mode: string, key: string) =>
      optionByMode(mode).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    optionByMode("light").focus();

    press("light", "ArrowRight"); // "previous" under RTL: wraps to the last
    expect(document.activeElement).toBe(optionByMode("system"));

    press("system", "ArrowLeft"); // "next": back to the first
    expect(document.activeElement).toBe(optionByMode("light"));

    press("light", "ArrowDown"); // the vertical pair carries no direction
    expect(document.activeElement).toBe(optionByMode("dark"));
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

  it("leaves a modified arrow to the browser (Alt+Left/Right is history navigation)", async () => {
    // A modified arrow belongs to the browser, not the widget: no focus move and
    // no mode change.
    await start(RADIOGROUP(`data-stimeo--theme-mode-value="light"`));
    const light = optionByMode("light");
    light.focus();

    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    light.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(light);
    expect(optionByMode("dark").getAttribute("aria-checked")).toBe("false");
    expect(root().getAttribute("data-theme")).toBe("light");
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
                data-value="dark">Dark</button>
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

  // --- Firing condition ---------------------------------------------------------

  const changeLog = () => {
    const seen: Array<{ mode: string; resolved: string }> = [];
    document.addEventListener("stimeo--theme:change", (event) => {
      seen.push((event as CustomEvent).detail);
    });
    return seen;
  };

  it("stays silent when the option already chosen is chosen again", async () => {
    // The event means the selection or the effective theme moved; re-choosing what
    // is already chosen is neither.
    await start(RADIOGROUP(`data-stimeo--theme-mode-value="dark"`));
    const seen = changeLog();

    optionByMode("dark").click();
    optionByMode("dark").click();

    expect(seen).toEqual([]);
    expect(root().getAttribute("data-theme")).toBe("dark");
  });

  it("stays silent on Home when the first option is already the selection", async () => {
    await start(RADIOGROUP(`data-stimeo--theme-mode-value="light"`));
    const seen = changeLog();

    optionByMode("light").focus();
    optionByMode("light").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }),
    );

    expect(seen).toEqual([]);
  });

  it("announces when only the effective theme moves", async () => {
    await start(RADIOGROUP());
    const seen = changeLog();

    setSystemDark(true);
    setSystemDark(false);

    expect(seen).toEqual([
      { mode: "system", resolved: "dark" },
      { mode: "system", resolved: "light" },
    ]);
  });

  // --- Declarations that cannot be read ------------------------------------------

  it("falls back to the document root when the target selector cannot be parsed", async () => {
    await start(
      RADIOGROUP(`data-stimeo--theme-mode-value="dark" data-stimeo--theme-target-value="#panel["`),
    );

    // The widget survives the unreadable declaration: hooks, ARIA and the roving
    // Tab stop are all established.
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(optionByMode("dark").getAttribute("aria-checked")).toBe("true");
    expect(options().filter((option) => option.tabIndex === 0)).toHaveLength(1);
  });

  it("keeps answering clicks after a target selector falls back", async () => {
    await start(RADIOGROUP(`data-stimeo--theme-target-value="#panel["`));
    optionByMode("light").click();
    expect(root().getAttribute("data-theme")).toBe("light");
    expect(optionByMode("light").getAttribute("aria-checked")).toBe("true");
  });

  it("does nothing when the target selector matches no element", async () => {
    await start(
      RADIOGROUP(`data-stimeo--theme-mode-value="dark" data-stimeo--theme-target-value="#absent"`),
    );
    expect(root().hasAttribute("data-theme")).toBe(false);
    // The controls still describe the selection even with nowhere to paint it.
    expect(optionByMode("dark").getAttribute("aria-checked")).toBe("true");
  });

  it("falls back to system when the mode declaration is outside the three modes", async () => {
    await start(RADIOGROUP(`data-stimeo--theme-mode-value="auto"`));
    expect(optionByMode("system").getAttribute("aria-checked")).toBe("true");
    expect(root().getAttribute("data-theme")).toBe("light");
  });

  it("follows the OS after the mode declaration falls back", async () => {
    // Reading the declaration as `system` everywhere is what keeps it from
    // freezing halfway: resolved once at connect, then never again.
    await start(RADIOGROUP(`data-stimeo--theme-mode-value="auto"`));
    setSystemDark(true);
    expect(root().getAttribute("data-theme")).toBe("dark");
  });

  it("ignores a stored value outside the three modes", async () => {
    window.localStorage.setItem("stimeo-theme", "{}<script>");
    await start(RADIOGROUP(`data-stimeo--theme-mode-value="dark"`));
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(optionByMode("dark").getAttribute("aria-checked")).toBe("true");
  });

  it("resolves an explicit light while the OS prefers dark", async () => {
    mediaMatches = true;
    await start(RADIOGROUP(`data-stimeo--theme-mode-value="light"`));
    expect(root().getAttribute("data-theme")).toBe("light");
  });

  it("toggles from the OS-resolved theme when the mode is system and the OS is dark", async () => {
    mediaMatches = true;
    await start(TOGGLE);
    expect(document.querySelector("button")?.getAttribute("aria-pressed")).toBe("true");

    // `system` resolving dark, so the 2-value toggle goes to the opposite.
    (document.querySelector("button") as HTMLElement).click();
    expect(root().getAttribute("data-theme")).toBe("light");
    expect(document.querySelector("button")?.getAttribute("aria-pressed")).toBe("false");
  });

  // --- Options that appear, leave, or declare nothing -----------------------------

  const appendOption = (mode: string, label = mode) => {
    const group = query<HTMLElement>("[data-controller='stimeo--theme']");
    const button = document.createElement("button");
    button.setAttribute("role", "radio");
    button.setAttribute("data-stimeo--theme-target", "option");
    button.setAttribute("data-action", "click->stimeo--theme#set");
    button.setAttribute("data-value", mode);
    button.textContent = label;
    group.appendChild(button);
    return button;
  };

  const EMPTY_GROUP = `
    <div data-controller="stimeo--theme" data-stimeo--theme-mode-value="system"
         role="radiogroup" aria-label="Theme"></div>`;

  it("keeps a Tab stop when the selected option is removed", async () => {
    await start(RADIOGROUP(`data-stimeo--theme-mode-value="dark"`));
    expect(optionByMode("dark").tabIndex).toBe(0);

    optionByMode("dark").remove();
    await tick();

    // Nothing is selected any more, so APG puts the stop back on the first radio.
    expect(options().filter((option) => option.tabIndex === 0)).toHaveLength(1);
    expect(options()[0]?.tabIndex).toBe(0);
  });

  it("keeps a single Tab stop when options render after connect", async () => {
    await start(EMPTY_GROUP);
    appendOption("light");
    appendOption("dark");
    appendOption("system");
    await tick();

    expect(options().filter((option) => option.tabIndex === 0)).toHaveLength(1);
    expect(optionByMode("system").getAttribute("aria-checked")).toBe("true");
  });

  it("answers the arrow keys for options that rendered after connect", async () => {
    await start(EMPTY_GROUP);
    appendOption("light");
    appendOption("dark");
    appendOption("system");
    await tick();

    optionByMode("light").focus();
    optionByMode("light").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );

    expect(document.activeElement).toBe(optionByMode("dark"));
    expect(optionByMode("dark").getAttribute("aria-checked")).toBe("true");
  });

  it("does not call a radiogroup with no options a toggle", async () => {
    // `aria-pressed` belongs to the 2-value contract, and a group whose options
    // have not rendered is not that.
    await start(EMPTY_GROUP);
    expect(
      query<HTMLElement>("[data-controller='stimeo--theme']").hasAttribute("aria-pressed"),
    ).toBe(false);
  });

  it("keeps the first option tabbable when the mode matches none of them", async () => {
    await start(`
      <div data-controller="stimeo--theme" data-stimeo--theme-mode-value="system"
           role="radiogroup" aria-label="Theme">
        <button data-stimeo--theme-target="option" role="radio"
                data-action="click->stimeo--theme#set"
                data-value="light">Light</button>
        <button data-stimeo--theme-target="option" role="radio"
                data-action="click->stimeo--theme#set"
                data-value="dark">Dark</button>
      </div>`);

    expect(options().map((option) => option.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
    ]);
    expect(options().map((option) => option.tabIndex)).toEqual([0, -1]);
  });

  it("never lets an option outside the three modes become the selection", async () => {
    // The click path already refused it; the keyboard path has to agree, or the
    // group ends up with two checked radios.
    await start(`
      <div data-controller="stimeo--theme" data-stimeo--theme-mode-value="light"
           role="radiogroup" aria-label="Theme">
        <button data-stimeo--theme-target="option" role="radio"
                data-action="click->stimeo--theme#set"
                data-value="light">Light</button>
        <button data-stimeo--theme-target="option" role="radio"
                data-action="click->stimeo--theme#set"
                data-value="drak">Typo</button>
        <button data-stimeo--theme-target="option" role="radio"
                data-action="click->stimeo--theme#set"
                data-value="system">System</button>
      </div>`);

    const typo = query<HTMLElement>("[data-value='drak']");
    typo.click();
    expect(root().getAttribute("data-theme")).toBe("light");

    optionByMode("light").focus();
    optionByMode("light").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );

    expect(document.activeElement).toBe(typo);
    expect(
      options().filter((option) => option.getAttribute("aria-checked") === "true"),
    ).toHaveLength(1);
    expect(optionByMode("light").getAttribute("aria-checked")).toBe("true");
  });

  // --- Keys that belong to the browser --------------------------------------------

  it("ignores a key pressed on something that is not an option", async () => {
    await start(`
      <div data-controller="stimeo--theme" data-stimeo--theme-mode-value="system"
           role="radiogroup" aria-label="Theme">
        <a id="inside" href="#x">help</a>
        <button data-stimeo--theme-target="option" role="radio"
                data-action="click->stimeo--theme#set"
                data-value="light">Light</button>
        <button data-stimeo--theme-target="option" role="radio"
                data-action="click->stimeo--theme#set"
                data-value="dark">Dark</button>
      </div>`);
    const link = query<HTMLElement>("#inside");
    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(options().map((option) => option.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
    ]);
  });

  it("leaves a modified Home or End to the browser", async () => {
    // Control+Home jumps the document; a widget that swallows it makes the
    // shortcut depend on where focus happens to sit.
    await start(RADIOGROUP(`data-stimeo--theme-mode-value="dark"`));
    const seen = changeLog();

    for (const key of ["Home", "End"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      optionByMode("dark").focus();
      optionByMode("dark").dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }

    expect(seen).toEqual([]);
    expect(optionByMode("dark").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(optionByMode("dark"));
  });

  it("refuses a quoted value through the click path too", async () => {
    // The declaration is the raw attribute, so a quoted spelling is simply
    // outside the three modes. The click path reads the lane the checked test
    // reads, so neither can accept what the other refuses.
    await start(`
      <div data-controller="stimeo--theme" data-stimeo--theme-mode-value="light"
           role="radiogroup" aria-label="Theme">
        <button data-stimeo--theme-target="option" role="radio"
                data-action="click->stimeo--theme#set"
                data-value="light">Light</button>
        <button data-stimeo--theme-target="option" role="radio"
                data-action="click->stimeo--theme#set"
                data-value='"dark"'>Quoted</button>
      </div>`);

    const quoted = options()[1] as HTMLElement;
    quoted.click();

    expect(root().getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("stimeo-theme")).toBeNull();
    expect(
      options().filter((option) => option.getAttribute("aria-checked") === "true"),
    ).toHaveLength(1);
    expect(optionByMode("light").getAttribute("aria-checked")).toBe("true");
  });

  it("hands the change detail out as a copy", async () => {
    // The baseline that tells a move from a repeat is kept here; a listener that
    // writes to what it was handed must not be able to move it.
    await start(RADIOGROUP(`data-stimeo--theme-mode-value="dark"`));
    const seen: Array<{ mode: string; resolved: string }> = [];
    document.addEventListener("stimeo--theme:change", (event) => {
      const detail = (event as CustomEvent).detail as { mode: string; resolved: string };
      seen.push({ ...detail });
      detail.mode = "poisoned";
    });

    optionByMode("light").click();
    optionByMode("light").click();

    expect(seen).toEqual([{ mode: "light", resolved: "light" }]);
  });

  it("does not react to an OS change once an explicit mode is chosen", async () => {
    // Reacting is only visible when there is something to react to, so the hook
    // is taken away first: an explicit mode must leave it taken away.
    await start(RADIOGROUP(`data-stimeo--theme-mode-value="dark"`));
    expect(root().getAttribute("data-theme")).toBe("dark");

    root().removeAttribute("data-theme");
    setSystemDark(true);

    expect(root().hasAttribute("data-theme")).toBe(false);
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(`<main>${RADIOGROUP()}</main>`);
    await expectNoA11yViolations(document.body);
    // touch options() so the helper is exercised and lint stays clean
    expect(options().length).toBe(3);
  });

  // Speech-order regression: the radiogroup announces its label and the three
  // radios, with the resolved mode (light) checked.
  it("announces the radiogroup with the checked option", async () => {
    await start(RADIOGROUP(`data-stimeo--theme-mode-value="light"`));
    const speech = await captureSpeech({ container: query("[role='radiogroup']"), steps: 4 });
    expect(speech).toEqual([
      "radiogroup, Theme",
      "radio, Light, checked, position 1, set size 3",
      "radio, Dark, not checked, position 2, set size 3",
      "radio, System, not checked, position 3, set size 3",
      "end of radiogroup, Theme",
    ]);
  });
});
