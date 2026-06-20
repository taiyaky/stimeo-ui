import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandPaletteController } from "../src/controllers/command_palette_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link CommandPaletteController}: modal key interception,
 * focus trapping, Combobox-style filtering, virtual focus tracking via
 * aria-activedescendant, and keyboard/mouse selection.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CommandPaletteController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <button id="trigger">Opener</button>
      <div data-controller="stimeo--command-palette"
           data-stimeo--command-palette-hotkey-value="mod+k">
        <div id="dialog" data-stimeo--command-palette-target="dialog" role="dialog"
             aria-modal="true" aria-label="Command palette"
             data-action="click->stimeo--command-palette#closeOnBackdrop" hidden>
          <input id="input" data-stimeo--command-palette-target="input" role="combobox"
                 aria-expanded="false" aria-controls="cmdk-list"
                 aria-autocomplete="list" aria-label="Search commands"
                 data-action="input->stimeo--command-palette#filter
                              keydown->stimeo--command-palette#onKeydown" />
          <ul id="cmdk-list" data-stimeo--command-palette-target="list" role="listbox">
            <li id="cmd-new" role="option" data-value="new"
                data-stimeo--command-palette-target="option"
                data-action="click->stimeo--command-palette#selectByClick">New…</li>
            <li id="cmd-publish" role="option" data-value="publish"
                data-stimeo--command-palette-target="option"
                data-action="click->stimeo--command-palette#selectByClick">Publish</li>
            <li id="cmd-delete" role="option" data-value="delete"
                data-stimeo--command-palette-target="option"
                data-action="click->stimeo--command-palette#selectByClick">Delete</li>
            <li id="cmd-heading" role="option" data-disabled="true"
                data-stimeo--command-palette-target="option"
                data-action="click->stimeo--command-palette#selectByClick">Section heading</li>
          </ul>
          <p id="empty" data-stimeo--command-palette-target="empty" hidden>No commands</p>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--command-palette", CommandPaletteController);
    await tick();
  });

  afterEach(() => {
    // Disconnect first so the controller's global hotkey listener is removed and its
    // FocusTrap is torn down between tests. (application.stop() does not disconnect
    // controllers here, so without this a stale controller's trap would keep
    // manipulating shared state — scroll lock, background inert, focus — and corrupt
    // later tests.)
    controller()?.disconnect();
    application.stop();
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  const dialog = () => document.getElementById("dialog") as HTMLElement;
  const input = () => document.getElementById("input") as HTMLInputElement;
  const empty = () => document.getElementById("empty") as HTMLElement;
  const option = (id: string) => document.getElementById(id) as HTMLElement;
  const trigger = () => document.getElementById("trigger") as HTMLElement;

  const controller = () =>
    application.getControllerForElementAndIdentifier(
      document.querySelector("[data-controller='stimeo--command-palette']") as HTMLElement,
      "stimeo--command-palette",
    ) as CommandPaletteController;

  const isMac = /mac|iphone|ipad|ipod/i.test(navigator.userAgent || navigator.platform || "");

  const type = (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  };

  const press = (key: string) =>
    input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

  const pressGlobal = (key: string, ctrl = false, meta = false) => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        ctrlKey: ctrl,
        metaKey: meta,
        bubbles: true,
      }),
    );
  };

  const pressHotkey = () => {
    pressGlobal("k", !isMac, isMac);
  };

  // Dispatches a keydown from whatever element currently holds focus, so the
  // document-level Tab/Escape handlers see the right `document.activeElement`.
  const pressFrom = (key: string, options: { shift?: boolean } = {}) => {
    const el = (document.activeElement as HTMLElement | null) ?? document.body;
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key, shiftKey: options.shift ?? false, bubbles: true }),
    );
  };

  it("starts closed", () => {
    expect(dialog().hidden).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles open and closed via global mod+k hotkey", async () => {
    trigger().focus();
    pressHotkey();
    await tick();
    expect(dialog().hidden).toBe(false);
    expect(input().getAttribute("aria-expanded")).toBe("true");

    // Toggles closed
    pressHotkey();
    expect(dialog().hidden).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("focuses input on open and restores focus on close", async () => {
    trigger().focus();
    expect(document.activeElement).toBe(trigger());

    pressHotkey();
    await tick();
    // RequestAnimationFrame delay
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(input());

    press("Escape");
    expect(dialog().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("navigates active options using ArrowDown/ArrowUp and sets activedescendant", () => {
    pressHotkey();
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-new");
    expect(option("cmd-new").getAttribute("aria-selected")).toBe("true");

    press("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-publish");
    expect(option("cmd-publish").getAttribute("aria-selected")).toBe("true");

    press("ArrowUp");
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-new");
  });

  it("jumps to first/last options on Home/End keypress", () => {
    pressHotkey();
    press("End");
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-delete");

    press("Home");
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-new");
  });

  it("filters options and handles empty states correctly", () => {
    pressHotkey();
    type("pu");

    expect(option("cmd-new").hasAttribute("hidden")).toBe(true);
    expect(option("cmd-publish").hasAttribute("hidden")).toBe(false);
    expect(option("cmd-delete").hasAttribute("hidden")).toBe(true);
    expect(empty().hidden).toBe(true);

    // Activedescendant resets to first visible option
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-publish");

    type("zzz");
    expect(empty().hidden).toBe(false);
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("skips hidden options during keyboard navigation after filtering", () => {
    pressHotkey();
    type("e"); // Matches "New" and "Delete" but not "Publish"

    expect(option("cmd-new").hasAttribute("hidden")).toBe(false);
    expect(option("cmd-publish").hasAttribute("hidden")).toBe(true);
    expect(option("cmd-delete").hasAttribute("hidden")).toBe(false);

    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-new");

    press("ArrowDown"); // Should skip "Publish" and go straight to "Delete"
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-delete");
  });

  it("dispatches select event and closes on Enter", () => {
    let firedEvent: CustomEvent | null = null;
    document.addEventListener("stimeo--command-palette:select", (e) => {
      firedEvent = e as CustomEvent;
    });

    pressHotkey();
    press("ArrowDown"); // Actives "cmd-publish"
    press("Enter");

    expect(firedEvent).not.toBeNull();
    expect((firedEvent as unknown as CustomEvent).detail.value).toBe("publish");
    expect((firedEvent as unknown as CustomEvent).detail.option).toBe(option("cmd-publish"));
    expect(dialog().hidden).toBe(true);
  });

  it("dispatches select event and closes on option click", () => {
    let firedEvent: CustomEvent | null = null;
    document.addEventListener("stimeo--command-palette:select", (e) => {
      firedEvent = e as CustomEvent;
    });

    pressHotkey();
    option("cmd-delete").click();

    expect(firedEvent).not.toBeNull();
    expect((firedEvent as unknown as CustomEvent).detail.value).toBe("delete");
    expect((firedEvent as unknown as CustomEvent).detail.option).toBe(option("cmd-delete"));
    expect(dialog().hidden).toBe(true);
  });

  it("excludes disabled options from navigation, selection and the empty count", () => {
    pressHotkey();

    // Disabled heading is shown but never navigable.
    press("End");
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-delete");

    // Clicking a disabled option does not select or close.
    let fired = false;
    document.addEventListener("stimeo--command-palette:select", () => {
      fired = true;
    });
    option("cmd-heading").click();
    expect(fired).toBe(false);
    expect(dialog().hidden).toBe(false);

    // A query matching only the disabled heading still shows the empty state.
    type("Section heading");
    expect(option("cmd-heading").hasAttribute("hidden")).toBe(false);
    expect(empty().hidden).toBe(false);
  });

  it("opens via either Cmd+K or Ctrl+K regardless of platform", async () => {
    // The documented hotkey is "Cmd+K / Ctrl+K"; both must work everywhere
    // (e.g. Ctrl+K on macOS, not only Cmd+K).
    trigger().focus();

    pressGlobal("k", true, false); // Ctrl+K
    await tick();
    expect(dialog().hidden).toBe(false);

    pressGlobal("k", true, false); // Ctrl+K toggles closed
    expect(dialog().hidden).toBe(true);

    pressGlobal("k", false, true); // Cmd+K
    await tick();
    expect(dialog().hidden).toBe(false);
  });

  it("traps Tab focus within the dialog no matter which element has focus", async () => {
    // A focusable close button inside the dialog, as the real demo has.
    const close = document.createElement("button");
    close.id = "close";
    close.textContent = "Close";
    dialog().appendChild(close);

    pressHotkey();
    await tick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(input());

    // Shift+Tab from the first focusable (input) wraps to the last (close button).
    pressFrom("Tab", { shift: true });
    expect(document.activeElement).toBe(close);

    // Tab from the last focusable wraps back to the first (input) — the close
    // button has no per-element handler, so this only works because the trap lives
    // at the document level.
    pressFrom("Tab");
    expect(document.activeElement).toBe(input());

    // If focus has escaped the dialog, Tab pulls it back inside.
    trigger().focus();
    pressFrom("Tab");
    expect(document.activeElement).toBe(input());
  });

  it("closes on Escape even when focus is not on the input", async () => {
    const close = document.createElement("button");
    close.id = "close";
    close.textContent = "Close";
    dialog().appendChild(close);

    trigger().focus();
    pressHotkey();
    await tick();
    expect(dialog().hidden).toBe(false);

    close.focus();
    pressFrom("Escape");
    expect(dialog().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on backdrop click but not on clicks inside the panel", async () => {
    pressHotkey();
    await tick();
    expect(dialog().hidden).toBe(false);

    // Clicking the input (inside the dialog) must not close.
    input().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dialog().hidden).toBe(false);

    // Clicking the backdrop element itself closes.
    dialog().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dialog().hidden).toBe(true);
  });

  it("locks background scroll while open and restores it on close", async () => {
    expect(document.body.style.overflow).toBe("");

    pressHotkey();
    await tick();
    expect(document.body.style.overflow).toBe("hidden");

    pressHotkey(); // toggle closed
    expect(document.body.style.overflow).toBe("");
  });

  // --- Layer ① machine a11y ---------------------------------------------------

  it("has no machine-detectable a11y violations while closed", async () => {
    await expectNoA11yViolations(document.body);
  });

  it("has no machine-detectable a11y violations while open", async () => {
    pressHotkey();
    await tick();
    expect(dialog().hidden).toBe(false);
    await expectNoA11yViolations(document.body);
  });

  // --- Layer ③ speech-order regression ---------------------------------------

  it("announces the listbox options and reflects the active option in order", async () => {
    pressHotkey();
    await tick();
    const list = document.getElementById("cmdk-list") as HTMLElement;

    // The first visible option is active on open and announces as selected.
    expect(await captureSpeech({ container: list, steps: 5 })).toEqual([
      "listbox, orientated vertically",
      "option, New…, selected, position 1, set size 4",
      "option, Publish, not selected, position 2, set size 4",
      "option, Delete, not selected, position 3, set size 4",
      "option, Section heading, not selected, position 4, set size 4",
      "end of listbox, orientated vertically",
    ]);

    // Moving the virtual focus flips which option announces as selected.
    press("ArrowDown");
    expect(await captureSpeech({ container: list, steps: 5 })).toEqual([
      "listbox, orientated vertically",
      "option, New…, not selected, position 1, set size 4",
      "option, Publish, selected, position 2, set size 4",
      "option, Delete, not selected, position 3, set size 4",
      "option, Section heading, not selected, position 4, set size 4",
      "end of listbox, orientated vertically",
    ]);
  });

  // --- Disconnect teardown regression ----------------------------------------

  it("removes the global hotkey listener after the controller is torn down", async () => {
    controller().disconnect();

    // With the controller torn down, the global hotkey must no longer open it.
    pressHotkey();
    await tick();
    expect(dialog().hidden).toBe(true);
  });

  it("reverts the background scroll lock if torn down while open", async () => {
    pressHotkey();
    await tick();
    expect(dialog().hidden).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");

    // A Turbo navigation can disconnect the controller while open; the modal side
    // effects (scroll lock, background inert) must be reverted on teardown.
    controller().disconnect();
    expect(document.body.style.overflow).toBe("");
  });

  it("resets the open state on disconnect so a later reconnect can bind listeners again", async () => {
    pressHotkey();
    await tick();
    expect(dialog().hidden).toBe(false);
    expect(input().getAttribute("aria-expanded")).toBe("true");

    controller().disconnect();
    expect(dialog().hidden).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");

    controller().connect();
    pressHotkey();
    await tick();
    expect(dialog().hidden).toBe(false);

    // Backdrop click still dismisses after a reconnect.
    dialog().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dialog().hidden).toBe(true);
  });
});

describe("CommandPaletteController restore-on-reconnect", () => {
  let application: Application;

  const markup = (attrs: string, dialogAttrs: string) => `
    <button id="trigger">Opener</button>
    <div data-controller="stimeo--command-palette" ${attrs}>
      <div id="dialog" data-stimeo--command-palette-target="dialog" role="dialog"
           aria-modal="true" aria-label="Command palette"
           data-action="click->stimeo--command-palette#closeOnBackdrop" ${dialogAttrs}>
        <input id="input" data-stimeo--command-palette-target="input" role="combobox"
               aria-expanded="false" aria-controls="cmdk-list"
               aria-autocomplete="list" aria-label="Search commands"
               data-action="input->stimeo--command-palette#filter
                            keydown->stimeo--command-palette#onKeydown" />
        <ul id="cmdk-list" data-stimeo--command-palette-target="list" role="listbox">
          <li id="cmd-new" role="option" data-value="new"
              data-stimeo--command-palette-target="option">New…</li>
        </ul>
      </div>
    </div>`;

  const startWith = async (attrs: string, dialogAttrs: string) => {
    document.body.innerHTML = markup(attrs, dialogAttrs);
    application = Application.start();
    application.register("stimeo--command-palette", CommandPaletteController);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  afterEach(() => {
    const root = document.querySelector("[data-controller='stimeo--command-palette']");
    if (root) {
      (
        application.getControllerForElementAndIdentifier(
          root as HTMLElement,
          "stimeo--command-palette",
        ) as CommandPaletteController | null
      )?.disconnect();
    }
    application.stop();
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  const dialog = () => document.getElementById("dialog") as HTMLElement;
  const input = () => document.getElementById("input") as HTMLInputElement;

  it("keeps the palette open when the restored DOM shows it open (DOM wins over Value)", async () => {
    // Simulate a Turbo cache restore: the cached snapshot already shows the dialog
    // open (no `hidden`) even though the declarative open Value is false. The DOM
    // must win — connect must not slam a user-opened palette shut, and the
    // freshly-created FocusTrap must be (re)activated.
    await startWith(`data-stimeo--command-palette-open-value="false"`, "");
    expect(dialog().hidden).toBe(false);
    expect(input().getAttribute("aria-expanded")).toBe("true");
    // The trap is genuinely active: it locked background scroll.
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("stays closed when neither the DOM nor the Value says open", async () => {
    await startWith(`data-stimeo--command-palette-open-value="false"`, "hidden");
    expect(dialog().hidden).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(document.body.style.overflow).toBe("");
  });

  it("opens on connect from the declarative open Value on a fresh (hidden) render", async () => {
    // The markup contract hardcodes `hidden` on the dialog; the DOM-source-of-truth
    // connect must NOT break the documented `open-value="true"` initial-open: the
    // Value is the fallback when the DOM does not already encode an open state.
    await startWith(`data-stimeo--command-palette-open-value="true"`, "hidden");
    expect(dialog().hidden).toBe(false);
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
  });
});
