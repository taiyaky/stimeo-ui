import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandPaletteController } from "../src/controllers/command_palette_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link CommandPaletteController}: modal key interception,
 * focus trapping, Combobox-style filtering, virtual focus tracking via
 * aria-activedescendant, and keyboard/mouse selection.
 */

describe("CommandPaletteController", () => {
  let application: Application;
  let listenerAbort: AbortController;

  beforeEach(async () => {
    listenerAbort = new AbortController();
    document.body.innerHTML = `
      <button id="trigger">Opener</button>
      <div data-controller="stimeo--command-palette">
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
    listenerAbort.abort();
    disconnectAndStopApplication(application);
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

  const press = (key: string, options: KeyboardEventInit = {}) =>
    input().dispatchEvent(new KeyboardEvent("keydown", { ...options, key, bubbles: true }));

  const pressGlobal = (key: string, ctrl = false, meta = false, shift = false, alt = false) => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        ctrlKey: ctrl,
        metaKey: meta,
        shiftKey: shift,
        altKey: alt,
        bubbles: true,
      }),
    );
  };

  const listenForSelection = (listener: EventListener): void => {
    document.addEventListener("stimeo--command-palette:select", listener, {
      signal: listenerAbort.signal,
    });
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

  it("yields a key an enclosing widget already consumed", () => {
    // A composed widget that claims the key must not ALSO act on it —
    // composition depends on this yield.
    //
    // The claim cannot come from a descendant here: the only binding is
    // `keydown->…#onKeydown` on the INPUT, and an `<input>` has no children. So
    // the real shape is an enclosing widget consuming the key in the capture
    // phase, which is what runs before a bubble-phase handler on the target. A
    // claiming node placed *beside* the input never reaches `onKeydown` at all
    // and would exercise nothing.
    pressHotkey();
    dialog().addEventListener("keydown", (event) => event.preventDefault(), { capture: true });
    const before = input().getAttribute("aria-activedescendant");

    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    const notCanceled = input().dispatchEvent(event);

    expect(notCanceled).toBe(false); // the claim really took (a non-cancelable event would not)
    expect(input().getAttribute("aria-activedescendant")).toBe(before);
  });

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

  it("writes aria-selected only where it changed on an arrow move", async () => {
    // Option counts are authored and unbounded, and this runs on every arrow
    // repeat, so an unconditional pass costs one attribute mutation per option
    // per keypress. At most two change: the old active and the new one.
    pressHotkey();
    const all = Array.from(
      document.querySelectorAll<HTMLElement>('[data-stimeo--command-palette-target="option"]'),
    );
    let seen = 0;
    const observer = new MutationObserver((records) => {
      seen += records.length;
    });
    for (const el of all) {
      observer.observe(el, { attributes: true, attributeFilter: ["aria-selected"] });
    }

    press("ArrowDown");
    await Promise.resolve();
    seen += observer.takeRecords().length;
    observer.disconnect();

    expect(seen).toBe(2);
  });

  it("leaves a modified arrow to the browser", () => {
    // A bare arrow belongs to the palette; a chorded one does not. The active
    // option stays where it is and the press reaches the browser uncanceled.
    pressHotkey();
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-new");

    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    input().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-new");
    expect(option("cmd-new").getAttribute("aria-selected")).toBe("true");
  });

  it("wraps ArrowUp from the first option and ArrowDown from the last", () => {
    pressHotkey();

    press("ArrowUp");
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-delete");

    press("ArrowDown");
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
    expect(option("cmd-new").getAttribute("aria-selected")).toBe("false");
    expect(option("cmd-new").hasAttribute("data-active")).toBe(false);
    expect(
      document.querySelectorAll(
        '[data-stimeo--command-palette-target="option"]' + '[aria-selected="true"]',
      ),
    ).toHaveLength(1);

    type("zzz");
    expect(empty().hidden).toBe(false);
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
    expect(
      document.querySelectorAll(
        '[data-stimeo--command-palette-target="option"]' + '[aria-selected="true"]',
      ),
    ).toHaveLength(0);
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

  it("uses data-search-value instead of visible text when filtering", () => {
    option("cmd-publish").dataset.searchValue = "ship production";
    pressHotkey();

    type("production");
    expect(option("cmd-publish").hidden).toBe(false);
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-publish");

    type("Publish");
    expect(option("cmd-publish").hidden).toBe(true);
    expect(empty().hidden).toBe(false);
  });

  it("removes activedescendant instead of authoring an empty reference when an id is missing", () => {
    option("cmd-new").removeAttribute("id");

    pressHotkey();

    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
    expect(
      document
        .querySelector('[data-stimeo--command-palette-target="option"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("dispatches select event and closes on Enter", () => {
    let firedEvent: CustomEvent | null = null;
    listenForSelection((e) => {
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
    listenForSelection((e) => {
      firedEvent = e as CustomEvent;
    });

    pressHotkey();
    option("cmd-delete").click();

    expect(firedEvent).not.toBeNull();
    expect((firedEvent as unknown as CustomEvent).detail.value).toBe("delete");
    expect((firedEvent as unknown as CustomEvent).detail.option).toBe(option("cmd-delete"));
    expect(dialog().hidden).toBe(true);
  });

  it("falls back to option text when data-value is absent", () => {
    let selectedValue = "";
    listenForSelection((event) => {
      selectedValue = (event as CustomEvent<{ value: string }>).detail.value;
    });
    option("cmd-new").removeAttribute("data-value");

    pressHotkey();
    option("cmd-new").click();

    expect(selectedValue).toBe("New…");
  });

  it("excludes disabled options from navigation, selection and the empty count", () => {
    pressHotkey();
    expect(option("cmd-heading").getAttribute("aria-disabled")).toBe("true");

    // Disabled heading is shown but never navigable.
    press("End");
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-delete");

    // Clicking a disabled option does not select or close.
    let fired = false;
    listenForSelection(() => {
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

  it("does not show the empty state when the only match is aria-disabled", () => {
    // The other side of the split: `aria-disabled` is *visible and reachable*, so
    // a query that matches only it has a result — announcing "no results" would
    // deny that the command exists. `data-disabled` keeps the opposite meaning
    // (the case just above still shows the empty state).
    option("cmd-delete").setAttribute("aria-disabled", "true");
    pressHotkey();

    type("Delete");

    expect(option("cmd-delete").hasAttribute("hidden")).toBe(false);
    expect(empty().hidden).toBe(true);
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-delete");
  });

  it("keeps an authored aria-disabled option reachable but never runs it", () => {
    // The author's attribute decides, not the widget type. `aria-disabled` marks
    // a command that must stay *discoverable* — virtual focus lands on it and
    // `aria-activedescendant` names it, so the reader hears it announced as
    // unavailable — while activation is suppressed. `data-disabled` is the marker
    // for "skip this entirely", which is what leaves both meanings expressible.
    option("cmd-delete").setAttribute("aria-disabled", "true");
    pressHotkey();

    press("End");
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-delete");

    option("cmd-delete").click();
    expect(dialog().hidden).toBe(false); // reachable, still not activated
  });

  it("does not run an aria-disabled option on Enter", () => {
    // The keyboard half of the same contract. Suppression has to sit on every
    // activation path, not only the one that happens to consult the predicate:
    // widening the navigable set is precisely what puts a disabled option within
    // Enter's reach.
    const selected: string[] = [];
    listenForSelection((event) => {
      selected.push((event as CustomEvent<{ value: string }>).detail.value);
    });
    option("cmd-delete").setAttribute("aria-disabled", "true");
    pressHotkey();

    press("End");
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-delete");
    press("Enter");

    expect(selected).toEqual([]);
    expect(dialog().hidden).toBe(false);
  });

  it("does not run an aria-disabled option that opens as the active one", () => {
    // No navigation at all: the reset seeds the active index at 0, so a disabled
    // first option is active the moment the palette opens.
    const selected: string[] = [];
    listenForSelection((event) => {
      selected.push((event as CustomEvent<{ value: string }>).detail.value);
    });
    option("cmd-new").setAttribute("aria-disabled", "true");
    pressHotkey();

    press("Enter");

    expect(selected).toEqual([]);
    expect(dialog().hidden).toBe(false);
  });

  it("still skips a data-disabled option entirely", () => {
    // The other half of the split: this attribute is the controller's own, so it
    // keeps meaning "not a destination at all".
    option("cmd-delete").setAttribute("data-disabled", "true");
    pressHotkey();

    press("End");
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-publish");
  });

  it("restores an authored aria-disabled value when the data-disabled override is removed", async () => {
    const dynamic = document.createElement("li");
    dynamic.id = "cmd-managed-disabled";
    dynamic.setAttribute("role", "option");
    dynamic.setAttribute("aria-disabled", "false");
    dynamic.setAttribute("data-disabled", "true");
    dynamic.setAttribute("data-stimeo--command-palette-target", "option");
    document.getElementById("cmdk-list")?.appendChild(dynamic);
    await tick();
    expect(dynamic.getAttribute("aria-disabled")).toBe("true");

    dynamic.removeAttribute("data-disabled");
    type("");

    expect(dynamic.getAttribute("aria-disabled")).toBe("false");
  });

  it("shows the empty state when every option is disabled", () => {
    for (const id of ["cmd-new", "cmd-publish", "cmd-delete"]) {
      option(id).setAttribute("data-disabled", "true");
    }

    pressHotkey();

    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
    expect(empty().hidden).toBe(false);
    expect(
      document.querySelectorAll(
        '[data-stimeo--command-palette-target="option"]' + '[aria-selected="true"]',
      ),
    ).toHaveLength(0);
  });

  it("defers filtering until compositionend and ignores its unflagged Enter", () => {
    const selectedValues: string[] = [];
    listenForSelection((event) => {
      selectedValues.push((event as CustomEvent).detail.value);
    });
    pressHotkey();

    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input().value = "publish";
    input().dispatchEvent(new InputEvent("input", { bubbles: true }));

    // The active browser event can omit isComposing. Controller-owned lifecycle state
    // still protects the Enter and keeps pre-conversion filtering idle.
    press("Enter");
    expect(selectedValues).toEqual([]);
    expect(dialog().hidden).toBe(false);
    expect(option("cmd-new").hidden).toBe(false);
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-new");

    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(option("cmd-new").hidden).toBe(true);
    expect(option("cmd-publish").hidden).toBe(false);
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-publish");

    press("Enter");
    expect(selectedValues).toEqual(["publish"]);
    expect(dialog().hidden).toBe(true);
  });

  it("also honors the standard per-event IME signal without lifecycle events", () => {
    let selections = 0;
    listenForSelection(() => selections++);
    pressHotkey();

    press("Enter", { isComposing: true });
    expect(selections).toBe(0);
    expect(dialog().hidden).toBe(false);

    press("Enter");
    expect(selections).toBe(1);
    expect(dialog().hidden).toBe(true);
  });

  it("clears composition state across disconnect and reconnect", () => {
    let selections = 0;
    listenForSelection(() => selections++);
    pressHotkey();
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));

    controller().disconnect();
    controller().connect();
    controller().open();
    press("Enter");

    expect(selections).toBe(1);
    expect(dialog().hidden).toBe(true);
  });

  it("opens via either Cmd+K or Ctrl+K regardless of platform", async () => {
    // The hotkey is "Cmd+K / Ctrl+K"; both must work everywhere (e.g. Ctrl+K on
    // macOS, not only Cmd+K).
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

  it("supports custom and bare hotkeys while rejecting extra modifiers", () => {
    controller().hotkeyValue = "mod+p";

    pressGlobal("p", true);
    expect(dialog().hidden).toBe(false);
    pressGlobal("p", true);
    expect(dialog().hidden).toBe(true);

    pressGlobal("p", true, false, true);
    pressGlobal("p", true, false, false, true);
    pressGlobal("p", true, true);
    expect(dialog().hidden).toBe(true);

    controller().hotkeyValue = "x";
    pressGlobal("x", true);
    pressGlobal("x", false, false, true);
    expect(dialog().hidden).toBe(true);
    pressGlobal("x");
    expect(dialog().hidden).toBe(false);

    controller().close();
    controller().hotkeyValue = "mod";
    pressGlobal("mod");
    expect(dialog().hidden).toBe(true);

    controller().hotkeyValue = "mod+shift+k";
    pressGlobal("k", true, false, true);
    expect(dialog().hidden).toBe(true);
  });

  it("keeps instances isolated when they use distinct hotkeys", async () => {
    const secondRoot = document.createElement("div");
    secondRoot.setAttribute("data-controller", "stimeo--command-palette");
    secondRoot.setAttribute("data-stimeo--command-palette-hotkey-value", "mod+p");
    secondRoot.innerHTML = `
      <div id="dialog-2" role="dialog" aria-modal="true" aria-label="Second palette"
           data-stimeo--command-palette-target="dialog" hidden>
        <input id="input-2" role="combobox" aria-expanded="false"
               aria-controls="list-2" aria-autocomplete="list" aria-label="Search"
               data-stimeo--command-palette-target="input"
               data-action="input->stimeo--command-palette#filter
                            keydown->stimeo--command-palette#onKeydown">
        <ul id="list-2" role="listbox" data-stimeo--command-palette-target="list">
          <li id="second-option" role="option"
              data-stimeo--command-palette-target="option">Second</li>
        </ul>
      </div>`;
    document.body.appendChild(secondRoot);
    await tick();
    const second = application.getControllerForElementAndIdentifier(
      secondRoot,
      "stimeo--command-palette",
    ) as CommandPaletteController;

    pressGlobal("p", true);
    expect(dialog().hidden).toBe(true);
    expect((document.getElementById("dialog-2") as HTMLElement).hidden).toBe(false);

    second.close();
    pressHotkey();
    expect(dialog().hidden).toBe(false);
    expect((document.getElementById("dialog-2") as HTMLElement).hidden).toBe(true);
  });

  it("includes dynamically added options in navigation and selection", async () => {
    const dynamic = document.createElement("li");
    dynamic.id = "cmd-dynamic";
    dynamic.setAttribute("role", "option");
    dynamic.setAttribute("data-value", "dynamic");
    dynamic.setAttribute("data-stimeo--command-palette-target", "option");
    dynamic.setAttribute("data-action", "click->stimeo--command-palette#selectByClick");
    dynamic.textContent = "Dynamic";
    document.getElementById("cmdk-list")?.appendChild(dynamic);
    await tick();

    pressHotkey();
    expect(dynamic.getAttribute("aria-selected")).toBe("false");
    press("End");
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-dynamic");

    let selectedValue = "";
    listenForSelection((event) => {
      selectedValue = (event as CustomEvent<{ value: string }>).detail.value;
    });
    dynamic.click();
    expect(selectedValue).toBe("dynamic");
    expect(dialog().hidden).toBe(true);
  });

  describe("runtime option removal reconciliation", () => {
    const activeOptionIds = () =>
      Array.from(
        dialog().querySelectorAll<HTMLElement>('[role="option"][aria-selected="true"]'),
        (candidate) => candidate.id,
      );
    const activeMarkerIds = () =>
      Array.from(
        dialog().querySelectorAll<HTMLElement>("[data-active]"),
        (candidate) => candidate.id,
      );
    const activatePublish = () => {
      pressHotkey();
      press("ArrowDown");
      expect(input().getAttribute("aria-activedescendant")).toBe("cmd-publish");
    };

    it("keeps the same active command when a preceding option is removed", async () => {
      activatePublish();
      const selections: string[] = [];
      listenForSelection((event) => {
        selections.push((event as CustomEvent<{ value: string }>).detail.value);
      });

      option("cmd-new").remove();
      await tick();

      expect(input().getAttribute("aria-activedescendant")).toBe("cmd-publish");
      expect(activeOptionIds()).toEqual(["cmd-publish"]);
      expect(activeMarkerIds()).toEqual(["cmd-publish"]);

      press("Enter");
      expect(selections).toEqual(["publish"]);
    });

    it("falls forward to the next selectable command when the active target token is removed", async () => {
      activatePublish();
      const removedActive = option("cmd-publish");
      const selections: string[] = [];
      listenForSelection((event) => {
        selections.push((event as CustomEvent<{ value: string }>).detail.value);
      });

      removedActive.removeAttribute("data-stimeo--command-palette-target");
      await tick();

      expect(input().getAttribute("aria-activedescendant")).toBe("cmd-delete");
      expect(activeOptionIds()).toEqual(["cmd-delete"]);
      expect(activeMarkerIds()).toEqual(["cmd-delete"]);
      expect(removedActive.getAttribute("aria-selected")).toBe("false");
      expect(removedActive.hasAttribute("data-active")).toBe(false);
      expect(option("cmd-heading").getAttribute("aria-selected")).toBe("false");

      press("Enter");
      expect(selections).toEqual(["delete"]);
    });

    it("ignores a click from a command after its target token is removed", async () => {
      activatePublish();
      const removed = option("cmd-publish");
      const selections: string[] = [];
      listenForSelection((event) => {
        selections.push((event as CustomEvent<{ value: string }>).detail.value);
      });

      removed.removeAttribute("data-stimeo--command-palette-target");
      await tick();
      removed.click();

      expect(selections).toEqual([]);
      expect(dialog().hidden).toBe(false);
    });

    it("falls back to the previous command when no later selectable survivor remains", async () => {
      pressHotkey();
      press("End"); // Delete; the following heading is disabled.
      const removedActive = option("cmd-delete");
      const selections: string[] = [];
      listenForSelection((event) => {
        selections.push((event as CustomEvent<{ value: string }>).detail.value);
      });

      removedActive.remove();
      await tick();

      expect(input().getAttribute("aria-activedescendant")).toBe("cmd-publish");
      expect(activeOptionIds()).toEqual(["cmd-publish"]);
      expect(activeMarkerIds()).toEqual(["cmd-publish"]);
      expect(removedActive.getAttribute("aria-selected")).toBe("false");
      expect(removedActive.hasAttribute("data-active")).toBe(false);
      expect(option("cmd-heading").getAttribute("aria-selected")).toBe("false");

      press("Enter");
      expect(selections).toEqual(["publish"]);
    });

    it("skips hidden and disabled commands while choosing a fallback", async () => {
      activatePublish();
      option("cmd-delete").hidden = true;
      const removedActive = option("cmd-publish");
      const selections: string[] = [];
      listenForSelection((event) => {
        selections.push((event as CustomEvent<{ value: string }>).detail.value);
      });

      removedActive.removeAttribute("data-stimeo--command-palette-target");
      await tick();

      expect(input().getAttribute("aria-activedescendant")).toBe("cmd-new");
      expect(activeOptionIds()).toEqual(["cmd-new"]);
      expect(activeMarkerIds()).toEqual(["cmd-new"]);
      expect(option("cmd-delete").getAttribute("aria-selected")).toBe("false");
      expect(option("cmd-heading").getAttribute("aria-selected")).toBe("false");

      press("Enter");
      expect(selections).toEqual(["new"]);
    });

    it("transfers active state and commit ownership to a same-id replacement", async () => {
      activatePublish();
      const original = option("cmd-publish");
      const replacement = document.createElement("li");
      replacement.id = original.id;
      replacement.setAttribute("role", "option");
      replacement.dataset.value = "publish-v2";
      replacement.setAttribute("data-stimeo--command-palette-target", "option");
      replacement.setAttribute("data-action", "click->stimeo--command-palette#selectByClick");
      replacement.textContent = "Publish version 2";
      const selections: Array<{ value: string; option: HTMLElement }> = [];
      listenForSelection((event) => {
        selections.push((event as CustomEvent<{ value: string; option: HTMLElement }>).detail);
      });

      original.replaceWith(replacement);
      await tick();

      expect(input().getAttribute("aria-activedescendant")).toBe("cmd-publish");
      expect(activeOptionIds()).toEqual(["cmd-publish"]);
      expect(activeMarkerIds()).toEqual(["cmd-publish"]);
      expect(replacement.getAttribute("aria-selected")).toBe("true");
      expect(replacement.getAttribute("data-active")).toBe("true");
      expect(original.getAttribute("aria-selected")).toBe("false");
      expect(original.hasAttribute("data-active")).toBe(false);

      press("Enter");
      expect(selections).toEqual([{ value: "publish-v2", option: replacement }]);
    });

    it("does not adopt stale active markers from a different-id replacement", () => {
      activatePublish();
      const original = option("cmd-publish");
      const replacement = document.createElement("li");
      replacement.id = "cmd-replacement";
      replacement.setAttribute("role", "option");
      replacement.setAttribute("aria-selected", "true");
      replacement.setAttribute("data-active", "true");
      replacement.dataset.value = "replacement";
      replacement.setAttribute("data-stimeo--command-palette-target", "option");
      replacement.setAttribute("data-action", "click->stimeo--command-palette#selectByClick");
      replacement.textContent = "Replacement";
      const selections: string[] = [];
      listenForSelection((event) => {
        selections.push((event as CustomEvent<{ value: string }>).detail.value);
      });

      original.replaceWith(replacement);
      press("Enter");

      expect(selections).toEqual(["delete"]);
    });

    it("clears all active state and exposes empty state after the last selectable command is removed", async () => {
      pressHotkey();
      type("delete");
      const lastSelectable = option("cmd-delete");
      const selections: unknown[] = [];
      listenForSelection((event) => selections.push(event));
      expect(input().getAttribute("aria-activedescendant")).toBe("cmd-delete");

      lastSelectable.remove();
      await tick();

      expect(input().hasAttribute("aria-activedescendant")).toBe(false);
      expect(activeOptionIds()).toEqual([]);
      expect(activeMarkerIds()).toEqual([]);
      expect(lastSelectable.getAttribute("aria-selected")).toBe("false");
      expect(lastSelectable.hasAttribute("data-active")).toBe(false);
      expect(empty().hidden).toBe(false);

      press("Enter");
      expect(selections).toEqual([]);
      expect(dialog().hidden).toBe(false);
    });

    it("does not commit a shifted command synchronously before target callbacks run", () => {
      activatePublish();
      const selections: string[] = [];
      listenForSelection((event) => {
        selections.push((event as CustomEvent<{ value: string }>).detail.value);
      });

      option("cmd-new").remove();
      press("Enter");

      expect(selections).toEqual(["publish"]);
    });
  });

  it("traps Tab focus within the dialog no matter which element has focus", async () => {
    // A focusable close button inside the dialog, alongside the input.
    const close = document.createElement("button");
    close.id = "close";
    close.textContent = "Close";
    dialog().appendChild(close);

    pressHotkey();
    await tick();
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

  // --- Machine-detectable a11y ------------------------------------------------

  it("has no machine-detectable a11y violations while closed", async () => {
    await expectNoA11yViolations(document.body);
  });

  it("has no machine-detectable a11y violations while open", async () => {
    pressHotkey();
    await tick();
    expect(dialog().hidden).toBe(false);
    await expectNoA11yViolations(document.body);
  });

  // --- Speech-order regression -----------------------------------------------

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
      "option, Section heading, not selected, disabled, position 4, set size 4",
      "end of listbox, orientated vertically",
    ]);

    // Moving the virtual focus flips which option announces as selected.
    press("ArrowDown");
    expect(await captureSpeech({ container: list, steps: 5 })).toEqual([
      "listbox, orientated vertically",
      "option, New…, not selected, position 1, set size 4",
      "option, Publish, selected, position 2, set size 4",
      "option, Delete, not selected, position 3, set size 4",
      "option, Section heading, not selected, disabled, position 4, set size 4",
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

  describe("the active option's baseline", () => {
    it("clears the active option's state when the palette closes", async () => {
      // `aria-selected` here marks the *active* option, not a committed choice.
      // Leaving it (and `data-active`) behind after close would make a closed
      // palette claim an active option for the rest of the session, and would
      // ride into Turbo's cache.
      pressHotkey();
      press("ArrowDown");
      const activeIds = () =>
        Array.from(document.querySelectorAll("[data-active]")).map((el) => el.id);
      const selectedIds = () =>
        Array.from(document.querySelectorAll('[role="option"][aria-selected="true"]')).map(
          (el) => el.id,
        );
      expect(activeIds().length).toBe(1);
      expect(selectedIds()).toEqual(activeIds());

      press("Escape");

      expect(activeIds()).toEqual([]);
      expect(selectedIds()).toEqual([]);
      expect(input().hasAttribute("aria-activedescendant")).toBe(false);
    });

    it("clears it on teardown too", async () => {
      pressHotkey();
      press("ArrowDown");
      expect(document.querySelectorAll("[data-active]").length).toBe(1);

      disconnectAndStopApplication(application);

      expect(document.querySelectorAll("[data-active]").length).toBe(0);
      expect(document.querySelectorAll('[role="option"][aria-selected="true"]').length).toBe(0);
    });

    it("overwrites an authored aria-selected on an option added while open", async () => {
      // An authored value cannot mean anything for an attribute that tracks the
      // active option. The close path is not involved here, so the baseline pass
      // is the only thing that can stop two options claiming to be active.
      pressHotkey();
      press("ArrowDown");
      const late = document.createElement("li");
      late.id = "cmd-late";
      late.setAttribute("role", "option");
      late.setAttribute("aria-selected", "true");
      late.dataset.value = "late";
      late.setAttribute("data-stimeo--command-palette-target", "option");
      late.textContent = "Late command";
      (document.getElementById("cmdk-list") as HTMLElement).appendChild(late);
      await tick();

      expect(late.getAttribute("aria-selected")).toBe("false");
      expect(document.querySelectorAll('[role="option"][aria-selected="true"]').length).toBe(1);
    });
  });

  describe("an option added before the active one", () => {
    it("keeps the active identity, so Enter runs what AT announced", async () => {
      pressHotkey();
      press("ArrowDown");
      const active = input().getAttribute("aria-activedescendant");
      expect(active).toBeTruthy();

      const late = document.createElement("li");
      late.id = "cmd-late";
      late.setAttribute("role", "option");
      late.dataset.value = "late";
      late.setAttribute("data-stimeo--command-palette-target", "option");
      late.setAttribute("data-action", "click->stimeo--command-palette#selectByClick");
      late.textContent = "Late command";
      (document.getElementById("cmdk-list") as HTMLElement).prepend(late);
      await tick();

      expect(input().getAttribute("aria-activedescendant")).toBe(active);

      // The name promises a commit, so actually commit: Enter must run the very
      // option `aria-activedescendant` names, not its neighbour.
      const expected = document.getElementById(active as string) as HTMLElement;
      const runs: string[] = [];
      listenForSelection((event) => {
        runs.push((event as CustomEvent<{ value: string }>).detail.value);
      });
      press("Enter");

      expect(runs).toEqual([expected.dataset.value]);
    });
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
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
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
    // connect must NOT break `open-value="true"` as an initial-open switch: the
    // Value is the fallback when the DOM does not already encode an open state.
    await startWith(`data-stimeo--command-palette-open-value="true"`, "hidden");
    expect(dialog().hidden).toBe(false);
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
  });
});
