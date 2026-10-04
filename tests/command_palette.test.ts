import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPaletteController } from "../src/controllers/command_palette_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { typeKey } from "./helpers/keyboard";
import { expectUpperModalOnTop, openUpperModal, TARGET_SWAPS } from "./helpers/modal_stack";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

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
                data-action="click->stimeo--command-palette#select">New…</li>
            <li id="cmd-publish" role="option" data-value="publish"
                data-stimeo--command-palette-target="option"
                data-action="click->stimeo--command-palette#select">Publish</li>
            <li id="cmd-delete" role="option" data-value="delete"
                data-stimeo--command-palette-target="option"
                data-action="click->stimeo--command-palette#select">Delete</li>
            <li id="cmd-heading" role="option" data-disabled="true"
                data-stimeo--command-palette-target="option"
                data-action="click->stimeo--command-palette#select">Section heading</li>
          </ul>
          <p id="empty" data-stimeo--command-palette-target="empty" hidden>No commands</p>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--command-palette", CommandPaletteController);
    await tick();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  /** Runs `act`, lets Stimulus deliver the callbacks, and returns the writes to `attributes`. */
  const attributeWrites = async (element: Element, attributes: string[], act: () => void) => {
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(element, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: attributes,
    });
    act();
    await tick();
    records.push(...observer.takeRecords());
    observer.disconnect();
    return records;
  };

  // Dispatches a keydown from whatever element currently holds focus, so the
  // document-level Tab/Escape handlers see the right `document.activeElement`.
  const pressFrom = (key: string, options: { shift?: boolean } = {}) => {
    const el = (document.activeElement as HTMLElement | null) ?? document.body;
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key, shiftKey: options.shift ?? false, bubbles: true }),
    );
  };

  it.each(["filter", "open"] as const)(
    "does not activate an option appended synchronously by the empty target during %s",
    async (action) => {
      let armed = false;
      let deliveries = 0;
      const added = document.createElement("li");
      added.id = "cmd-synchronous";
      added.textContent = "New command";
      added.setAttribute("data-stimeo--command-palette-target", "option");
      const list = option("cmd-new").parentElement;
      if (!list) throw new Error("Missing option list");
      class AppendingEmptyState extends HTMLElement {
        static observedAttributes = ["hidden"];

        attributeChangedCallback(): void {
          if (!armed || this.hidden) return;
          armed = false;
          deliveries += 1;
          list?.append(added);
        }
      }
      const name = `command-empty-append-${action}`;
      customElements.define(name, AppendingEmptyState);
      const replacement = document.createElement(name);
      replacement.id = "empty";
      replacement.hidden = true;
      replacement.setAttribute("data-stimeo--command-palette-target", "empty");
      empty().replaceWith(replacement);
      await tick();
      if (action === "filter") controller().open();
      else {
        for (const target of controller().optionTargets) target.dataset.disabled = "true";
      }
      armed = true;
      if (action === "filter") type("no matching command");
      else controller().open();
      expect(deliveries).toBe(1);
      expect(controller().optionTargets).toContain(added);
      expect(input().hasAttribute("aria-activedescendant")).toBe(false);
      expect(added.hasAttribute("data-active")).toBe(false);
      await tick();
      expect(empty().hidden).toBe(true);
      expect(input().hasAttribute("aria-activedescendant")).toBe(false);
      press("ArrowDown");
      expect(input().getAttribute("aria-activedescendant")).toBe(added.id);
      expect(added.getAttribute("aria-selected")).toBe("true");
    },
  );

  it("prefers the search input over preceding focusable content", () => {
    const button = document.createElement("button");
    dialog().prepend(button);
    controller().open();
    expect(document.activeElement).toBe(input());
  });

  it("opens without an input and uses the first available focus target", async () => {
    input().remove();
    const button = document.createElement("button");
    dialog().prepend(button);
    await tick();
    expect(() => controller().open()).not.toThrow();
    expect(document.activeElement).toBe(button);
  });

  it("tracks composition again after reconnecting retained input targets", () => {
    const instance = controller();
    instance.disconnect();
    instance.connect();
    instance.open();
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    type("Publish");
    expect(option("cmd-new").hidden).toBe(false);
    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(option("cmd-new").hidden).toBe(true);
    expect(option("cmd-publish").hidden).toBe(false);
  });

  it("reconciles the empty result when a visible option target connects", async () => {
    controller().open();
    type("missing");
    expect(empty().hidden).toBe(false);
    const added = document.createElement("li");
    added.id = "cmd-added";
    added.setAttribute("data-stimeo--command-palette-target", "option");
    option("cmd-new").parentElement?.append(added);
    controller().optionTargetConnected(added);
    await flushMicrotasks();
    expect(empty().hidden).toBe(true);
  });

  const appendOption = (id: string, attributes: Record<string, string> = {}): HTMLElement => {
    const added = document.createElement("li");
    added.id = id;
    added.setAttribute("role", "option");
    for (const [name, value] of Object.entries(attributes)) added.setAttribute(name, value);
    added.setAttribute("data-stimeo--command-palette-target", "option");
    added.textContent = "Late command";
    (document.getElementById("cmdk-list") as HTMLElement).append(added);
    controller().optionTargetConnected(added);
    return added;
  };

  it("reflects the disabled marker of an option added while the active one stays", async () => {
    pressHotkey();
    const late = appendOption("cmd-late", { "data-disabled": "true" });
    await flushMicrotasks();
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-new");
    expect(late.getAttribute("aria-disabled")).toBe("true");
  });

  it.each(["aria-selected", "data-active"])(
    "does not let an authored %s make an added option active",
    async (marker) => {
      pressHotkey();
      type("zzz");
      expect(input().hasAttribute("aria-activedescendant")).toBe(false);
      const late = appendOption("cmd-late", { [marker]: "true" });
      await flushMicrotasks();
      expect(input().hasAttribute("aria-activedescendant")).toBe(false);
      expect(late.getAttribute("aria-selected")).toBe("false");
      expect(late.hasAttribute("data-active")).toBe(false);
    },
  );

  it("hides a re-rendered empty state when target churn keeps the active command", async () => {
    pressHotkey();
    const rerendered = document.createElement("p");
    rerendered.id = "empty";
    rerendered.setAttribute("data-stimeo--command-palette-target", "empty");
    rerendered.textContent = "No commands";
    empty().replaceWith(rerendered);
    appendOption("cmd-late");
    await flushMicrotasks();
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-new");
    expect(rerendered.hidden).toBe(true);
  });

  it("clears a stale activedescendant from an input connected while closed", async () => {
    const replacement = input().cloneNode(true) as HTMLInputElement;
    replacement.setAttribute("aria-activedescendant", "cmd-publish");
    controller().inputTargetDisconnected(input());
    input().replaceWith(replacement);
    controller().inputTargetConnected(replacement);
    await flushMicrotasks();
    expect(dialog().hidden).toBe(true);
    expect(replacement.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("shows the empty state when the last selectable command goes while closed", async () => {
    for (const id of ["cmd-new", "cmd-publish", "cmd-delete"]) {
      const removed = option(id);
      removed.remove();
      controller().optionTargetDisconnected(removed);
    }
    await flushMicrotasks();
    expect(dialog().hidden).toBe(true);
    expect(empty().hidden).toBe(false);
  });

  it("restores virtual focus when the input target is replaced", async () => {
    controller().open();
    press("ArrowDown");
    const replacement = input().cloneNode(true) as HTMLInputElement;
    replacement.removeAttribute("aria-activedescendant");
    controller().inputTargetDisconnected(input());
    input().replaceWith(replacement);
    controller().inputTargetConnected(replacement);
    await flushMicrotasks();
    expect(replacement.getAttribute("aria-activedescendant")).toBe("cmd-publish");
  });

  it("reconciles an option that arrives after the only ones left", async () => {
    controller().open();
    for (const id of ["cmd-new", "cmd-publish", "cmd-delete", "cmd-heading"]) option(id).remove();
    await tick();
    expect(empty().hidden).toBe(false);
    const arrival = document.createElement("li");
    arrival.id = "cmd-late";
    arrival.setAttribute("role", "option");
    arrival.setAttribute("aria-selected", "true");
    arrival.setAttribute("data-stimeo--command-palette-target", "option");
    arrival.textContent = "Late";
    document.getElementById("cmdk-list")?.append(arrival);
    await tick();

    expect(empty().hidden).toBe(true);
    expect(arrival.getAttribute("aria-selected")).toBe("false");
  });

  it("points an input that arrives after the only one left at the active option", async () => {
    controller().open();
    press("ArrowDown"); // Publish active
    const original = input();
    original.remove();
    await tick();
    const arrival = original.cloneNode(true) as HTMLInputElement;
    arrival.removeAttribute("aria-activedescendant");
    dialog().prepend(arrival);
    controller().inputTargetConnected(arrival);
    await flushMicrotasks();

    expect(arrival.getAttribute("aria-activedescendant")).toBe("cmd-publish");
  });

  describe("an input that stays after an earlier one leaves", () => {
    /** Opens the palette with Publish active and inserts a stale copy of the input after it. */
    const insertSuccessor = async (): Promise<[HTMLInputElement, HTMLInputElement]> => {
      controller().open();
      press("ArrowDown"); // Publish active
      const original = input();
      const successor = original.cloneNode(true) as HTMLInputElement;
      successor.setAttribute("aria-expanded", "false");
      successor.removeAttribute("aria-activedescendant");
      original.after(successor);
      await tick();
      return [original, successor];
    };

    it("reflects the open palette into the input that stays", async () => {
      const [original, successor] = await insertSuccessor();
      original.remove();
      await tick();

      expect(input()).toBe(successor);
      expect(dialog().hidden).toBe(false);
      expect(successor.getAttribute("aria-expanded")).toBe("true");
    });

    it("reflects the open palette into a replacement delivered in one task", async () => {
      controller().open();
      const replacement = input().cloneNode(true) as HTMLInputElement;
      replacement.setAttribute("aria-expanded", "false");
      input().replaceWith(replacement);
      await tick();

      expect(input()).toBe(replacement);
      expect(replacement.getAttribute("aria-expanded")).toBe("true");
    });

    it.each([
      ["authors it", 'aria-expanded="true"'],
      ["omits it", ""],
    ])("writes aria-expanded once at connect when the markup %s", async (_label, attribute) => {
      const late = document.createElement("div");
      late.setAttribute("data-controller", "stimeo--command-palette");
      late.setAttribute("data-stimeo--command-palette-hotkey-value", "mod+j");
      late.innerHTML = `
        <div role="dialog" aria-modal="true" aria-label="Late palette"
             data-stimeo--command-palette-target="dialog" hidden>
          <input role="combobox" ${attribute} aria-label="Late search"
                 data-stimeo--command-palette-target="input" />
          <ul role="listbox" data-stimeo--command-palette-target="list">
            <li id="cmd-late" role="option" data-stimeo--command-palette-target="option">Late</li>
          </ul>
        </div>`;
      const lateInput = late.querySelector("input") as HTMLInputElement;
      const writes: Array<string | null> = [];
      const observer = new MutationObserver((records) => {
        for (const _record of records) writes.push(lateInput.getAttribute("aria-expanded"));
      });
      observer.observe(lateInput, { attributes: true, attributeFilter: ["aria-expanded"] });
      document.body.appendChild(late);
      await tick();
      await tick();
      observer.disconnect();

      expect(writes).toEqual(["false"]);
    });

    it("points the input that stays at the active option", async () => {
      const [original, successor] = await insertSuccessor();
      original.remove();
      await tick();

      expect(input()).toBe(successor);
      expect(successor.getAttribute("aria-activedescendant")).toBe("cmd-publish");
      expect(option("cmd-publish").getAttribute("aria-selected")).toBe("true");
    });

    it("reports nothing while it synchronizes the input that stays", async () => {
      const [original] = await insertSuccessor();
      const selections: Event[] = [];
      const commits: Event[] = [];
      listenForSelection((event) => selections.push(event));
      document.addEventListener("change", (event) => commits.push(event), {
        signal: listenerAbort.signal,
      });
      original.remove();
      await tick();

      expect(selections).toEqual([]);
      expect(commits).toEqual([]);
    });

    it("tolerates the removal of the only input", async () => {
      controller().open();
      press("ArrowDown");
      const only = input();
      only.remove();

      // Drive the callback directly: happy-dom delivers target callbacks unreliably.
      expect(() => controller().inputTargetDisconnected(only)).not.toThrow();
      await tick();
      expect(dialog().hidden).toBe(false);
      expect(option("cmd-publish").getAttribute("aria-selected")).toBe("true");
    });

    it("writes nothing into the input that stays once it has disconnected", async () => {
      const [original, successor] = await insertSuccessor();
      const instance = controller();
      instance.disconnect();
      // The teardown cleared the active option; any pass from here on would say so.
      successor.setAttribute("aria-activedescendant", "cmd-publish");
      original.remove();
      instance.inputTargetDisconnected(original);
      await tick();

      expect(successor.getAttribute("aria-activedescendant")).toBe("cmd-publish");
    });

    it("gives the authored ARIA back to an input that stops being the input", async () => {
      controller().open();
      press("ArrowDown");
      const former = input();
      expect(former.getAttribute("aria-activedescendant")).toBe("cmd-publish");

      // The element stays; only the attribute naming it the input goes.
      former.removeAttribute("data-stimeo--command-palette-target");
      await tick();

      expect(former.getAttribute("aria-expanded")).toBe("false");
      expect(former.hasAttribute("aria-activedescendant")).toBe(false);
    });

    it("gives the input back its own ARIA when the palette loses its controller", async () => {
      controller().open();
      press("ArrowDown");
      const departed = input();

      controller().element.removeAttribute("data-controller");
      await tick();

      expect(departed.getAttribute("aria-expanded")).toBe("false");
      expect(departed.hasAttribute("aria-activedescendant")).toBe(false);
    });

    it("keeps what it wrote on an input that moves within the dialog", async () => {
      controller().open();
      press("ArrowDown");
      const moving = input();

      const writes = await attributeWrites(moving, ["aria-expanded", "aria-activedescendant"], () =>
        dialog().append(moving),
      );

      expect(moving.getAttribute("aria-expanded")).toBe("true");
      expect(moving.getAttribute("aria-activedescendant")).toBe("cmd-publish");
      // A write that replaced a value other than the final one means the input was
      // handed back on the way; a rewrite of the same value does not.
      const transient = writes.filter(
        (write) => write.oldValue !== moving.getAttribute(write.attributeName ?? ""),
      );
      expect(transient.map((write) => write.attributeName)).toEqual([]);
    });
  });

  it("leaves an absent open declaration untouched when closing an already closed palette", () => {
    const element = controller().element;
    element.removeAttribute("data-stimeo--command-palette-open-value");
    controller().close();
    expect(element.hasAttribute("data-stimeo--command-palette-open-value")).toBe(false);
    controller().open();
    expect(element.getAttribute("data-stimeo--command-palette-open-value")).toBe("true");
    controller().close();
    expect(element.getAttribute("data-stimeo--command-palette-open-value")).toBe("false");
    expect(dialog().hidden).toBe(true);
  });

  it("keeps the current search and active option when already open", () => {
    controller().open();
    type("Publish");
    controller().open();
    expect(input().value).toBe("Publish");
    expect(option("cmd-new").hidden).toBe(true);
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-publish");
  });

  it("reconciles disabled semantics only once for an arrow with no visible options", () => {
    controller().open();
    type("missing command");
    const observer = new MutationObserver(() => {});
    observer.observe(option("cmd-heading"), {
      attributes: true,
      attributeFilter: ["aria-disabled"],
    });
    try {
      for (const key of ["ArrowDown", "ArrowUp"]) {
        press(key);
        const records = observer.takeRecords();
        expect(records).toHaveLength(1);
        expect(records[0]?.target).toBe(option("cmd-heading"));
        expect(option("cmd-heading").getAttribute("aria-disabled")).toBe("true");
        expect(input().hasAttribute("aria-activedescendant")).toBe(false);
      }
    } finally {
      observer.disconnect();
    }
  });

  it("scrolls the newly active option into the nearest visible position", () => {
    const first = vi.spyOn(option("cmd-new"), "scrollIntoView");
    const next = vi.spyOn(option("cmd-publish"), "scrollIntoView");
    controller().open();
    expect(first).toHaveBeenCalledWith({ block: "nearest" });
    expect(next).not.toHaveBeenCalled();
    press("ArrowDown");
    expect(next).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("clears the previous query when reopening", () => {
    controller().open();
    type("Publish");
    controller().close();
    controller().open();
    expect(input().value).toBe("");
    expect(option("cmd-new").hidden).toBe(false);
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-new");
  });

  it("uses the input's current virtual focus when reconciling options", async () => {
    controller().open();
    input().setAttribute("aria-activedescendant", "cmd-publish");
    controller().inputTargetConnected(input());
    await flushMicrotasks();
    expect(option("cmd-publish").getAttribute("aria-selected")).toBe("true");
    expect(option("cmd-new").getAttribute("aria-selected")).toBe("false");
  });

  it("uses the removed input-selected option's successor instead of cached focus", async () => {
    controller().open();
    press("End");
    input().setAttribute("aria-activedescendant", "cmd-publish");
    const removed = option("cmd-publish");
    removed.remove();
    controller().optionTargetDisconnected(removed);
    await flushMicrotasks();
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-delete");
  });

  it("retains and reconciles virtual focus without an input target", async () => {
    controller().open();
    press("ArrowDown");
    input().remove();
    await tick();
    expect(() =>
      controller().onKeydown(new KeyboardEvent("keydown", { key: "ArrowDown" })),
    ).not.toThrow();
    expect(option("cmd-delete").getAttribute("aria-selected")).toBe("true");
    const removed = option("cmd-delete");
    removed.remove();
    controller().optionTargetDisconnected(removed);
    await flushMicrotasks();
    expect(option("cmd-publish").getAttribute("aria-selected")).toBe("true");
  });

  it("clears unknown virtual focus and does not retain a fallback order without an active option", async () => {
    controller().open();
    input().setAttribute("aria-activedescendant", "unknown-command");
    controller().inputTargetConnected(input());
    await flushMicrotasks();
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
    expect(controller().optionTargets.some((target) => target.hasAttribute("data-active"))).toBe(
      false,
    );
    input().setAttribute("aria-activedescendant", "cmd-new");
    const removed = option("cmd-new");
    removed.remove();
    controller().optionTargetDisconnected(removed);
    await flushMicrotasks();
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
    expect(option("cmd-publish").getAttribute("aria-selected")).toBe("false");
  });

  it("rejects nested-origin action events while accepting owned descendants", async () => {
    const element = document.querySelector<HTMLElement>(
      "[data-controller='stimeo--command-palette']",
    );
    if (!element) throw new Error("Missing controller root");
    const instance = application.getControllerForElementAndIdentifier(
      element,
      "stimeo--command-palette",
    ) as CommandPaletteController;
    const target = element.querySelectorAll<HTMLElement>(
      "[data-stimeo--command-palette-target='option']",
    )[1];
    if (!target) throw new Error("Missing target");

    const nested = document.createElement("div");
    nested.setAttribute("data-controller", "stimeo--command-palette");
    const inner = target.cloneNode(true) as HTMLElement;
    inner.removeAttribute("data-action");
    nested.append(inner);
    target.append(nested);
    const reports: CustomEvent[] = [];
    element.addEventListener("stimeo--command-palette:select", (event) =>
      reports.push(event as CustomEvent),
    );
    target.addEventListener("pointerup", (event) => instance.select(event));
    inner.dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(reports).toHaveLength(0);
    nested.remove();
    const owned = document.createElement("span");
    target.append(owned);
    owned.dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.detail.reason).toBe("user");
  });

  it.each([false, true])(
    "element API focus closes a live trap without stealing external focus (outside=%s)",
    (outside) => {
      trigger().focus();
      controller().open();
      expect(document.activeElement).toBe(input());
      const other = document.createElement("button");
      document.body.append(other);
      if (outside) other.focus();
      controller().select(option("cmd-publish"));
      expect(dialog().hidden).toBe(true);
      expect(document.activeElement).toBe(outside ? other : trigger());
    },
  );

  it.each([
    ["focusin", "focus"],
    ["pointerenter", "pointer"],
  ])("preserves action event modality %s", async (type, reason) => {
    const element = document.querySelector<HTMLElement>(
      "[data-controller='stimeo--command-palette']",
    );
    if (!element) throw new Error("Missing controller root");
    const instance = application.getControllerForElementAndIdentifier(
      element,
      "stimeo--command-palette",
    ) as CommandPaletteController;
    const target = element.querySelectorAll<HTMLElement>(
      "[data-stimeo--command-palette-target='option']",
    )[1];
    if (!target) throw new Error("Missing action target");

    const reports: CustomEvent[] = [];
    element.addEventListener("stimeo--command-palette:select", (event) =>
      reports.push(event as CustomEvent),
    );
    target.addEventListener(type, (event) => instance.select(event), { once: true });
    target.dispatchEvent(new Event(type));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.detail.reason).toBe(reason);
  });

  it.each([false, true])(
    "accepts an owned element API source (descendant=%s) without stealing outside focus",
    async (descendant) => {
      const element = document.querySelector<HTMLElement>(
        "[data-controller='stimeo--command-palette']",
      );
      if (!element) throw new Error("Missing controller root");
      const instance = application.getControllerForElementAndIdentifier(
        element,
        "stimeo--command-palette",
      ) as CommandPaletteController;
      const target = element.querySelectorAll<HTMLElement>(
        "[data-stimeo--command-palette-target='option']",
      )[1];
      if (!target) throw new Error("Missing action target");
      const outside = document.createElement("button");
      document.body.append(outside);
      outside.focus();
      const reports: CustomEvent[] = [];
      element.addEventListener("stimeo--command-palette:select", (event) =>
        reports.push(event as CustomEvent),
      );

      const child = document.createElement("span");
      target.append(child);
      const foreign = target.cloneNode(true) as HTMLElement;
      foreign.removeAttribute("data-action");
      const nested = document.createElement("div");
      nested.setAttribute("data-controller", "stimeo--command-palette");
      const nestedTarget = foreign.cloneNode(true) as HTMLElement;
      nested.append(nestedTarget);
      element.append(nested);
      const before = element.innerHTML;
      instance.select(foreign);
      document.body.append(foreign);
      instance.select(foreign);
      instance.select(nestedTarget);
      expect(element.innerHTML).toBe(before);
      expect(reports).toHaveLength(0);
      instance.select(descendant ? child : target);

      expect(reports).toHaveLength(1);
      expect(reports[0]?.detail.reason).toBe("api");
      expect(document.activeElement).toBe(outside);
    },
  );

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

  it.each(["ArrowDown", "ArrowUp", "Home", "End", "Enter"])(
    "consumes %s while open instead of leaving it to the browser",
    (key) => {
      pressHotkey();
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      input().dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    },
  );

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

  it("shows options again when the query widens", () => {
    pressHotkey();
    type("pu");
    expect(option("cmd-new").hidden).toBe(true);

    type("");
    expect(option("cmd-new").hidden).toBe(false);
    expect(option("cmd-delete").hidden).toBe(false);
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-new");
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

  it("removes the aria-disabled it wrote when the data-disabled marker is lifted", () => {
    pressHotkey();
    expect(option("cmd-heading").getAttribute("aria-disabled")).toBe("true");

    option("cmd-heading").removeAttribute("data-disabled");
    type("");

    expect(option("cmd-heading").hasAttribute("aria-disabled")).toBe(false);
  });

  it("keeps an aria-disabled authored after the data-disabled marker was lifted", () => {
    pressHotkey();
    option("cmd-heading").removeAttribute("data-disabled");
    type("");

    option("cmd-heading").setAttribute("aria-disabled", "true");
    type("");

    expect(option("cmd-heading").getAttribute("aria-disabled")).toBe("true");
  });

  it("runs a command whose data-disabled marker was lifted while open", () => {
    const values: string[] = [];
    listenForSelection((event) => {
      values.push((event as CustomEvent<{ value: string }>).detail.value);
    });
    pressHotkey();
    expect(option("cmd-heading").getAttribute("aria-disabled")).toBe("true");

    option("cmd-heading").removeAttribute("data-disabled");
    option("cmd-heading").click();

    expect(values).toEqual(["Section heading"]);
    expect(dialog().hidden).toBe(true);
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

  const replaceInput = async (): Promise<HTMLInputElement> => {
    const original = input();
    const replacement = original.cloneNode(true) as HTMLInputElement;
    controller().inputTargetDisconnected(original);
    original.replaceWith(replacement);
    controller().inputTargetConnected(replacement);
    await flushMicrotasks();
    return replacement;
  };

  it("applies the confirmed query from a replacement input's composition", async () => {
    controller().open();
    const replacement = await replaceInput();

    replacement.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    replacement.value = "Publish";
    replacement.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));

    expect(option("cmd-new").hidden).toBe(true);
    expect(option("cmd-publish").hidden).toBe(false);
  });

  it("stops deferring the query once an input replaced mid-composition is gone", async () => {
    controller().open();
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const replacement = await replaceInput();

    replacement.value = "Publish";
    controller().filter();

    expect(option("cmd-new").hidden).toBe(true);
    expect(option("cmd-publish").hidden).toBe(false);
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

  it("consumes the hotkey so the browser's own shortcut does not also run", () => {
    const event = new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    expect(dialog().hidden).toBe(false);
    expect(event.defaultPrevented).toBe(true);
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
    dynamic.setAttribute("data-action", "click->stimeo--command-palette#select");
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
      replacement.setAttribute("data-action", "click->stimeo--command-palette#select");
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
      expect(selections).toEqual([{ value: "publish-v2", option: replacement, reason: "user" }]);
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
      replacement.setAttribute("data-action", "click->stimeo--command-palette#select");
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

    // If focus has escaped the dialog, Tab pulls it back to the first focusable. The
    // background is inert while the palette is open, so the trigger is released first to
    // let it take focus at all.
    trigger().inert = false;
    trigger().focus();
    pressFrom("Tab");
    expect(document.activeElement).toBe(input());
  });

  it("takes a Tab that does not wrap and moves to the next focusable itself", async () => {
    dialog().insertAdjacentHTML(
      "beforeend",
      '<button id="help">Help</button><button id="close">Close</button>',
    );
    pressHotkey();
    await tick();
    expect(document.activeElement).toBe(input());

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    input().dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.getElementById("help"));
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

  it("runs no reconciliation queued before teardown", async () => {
    controller().inputTargetConnected(input());
    controller().disconnect();

    option("cmd-publish").dataset.disabled = "true";
    await flushMicrotasks();

    expect(option("cmd-publish").hasAttribute("aria-disabled")).toBe(false);
  });

  it("reflects a disabled marker changed while disconnected when it reconnects", () => {
    const instance = controller();
    instance.disconnect();
    option("cmd-publish").dataset.disabled = "true";

    instance.connect();

    expect(dialog().hidden).toBe(true);
    expect(option("cmd-publish").getAttribute("aria-disabled")).toBe("true");
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

  it("keeps an open palette open, query included, when its element moves within the page", async () => {
    pressHotkey();
    await tick();
    type("pub");
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-publish");
    const instance = controller();

    instance.disconnect();
    expect(document.body.style.overflow).toBe("");
    instance.connect();

    expect(dialog().hidden).toBe(false);
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(input().value).toBe("pub");
    expect(option("cmd-new").hidden).toBe(true);
    expect(input().getAttribute("aria-activedescendant")).toBe("cmd-publish");
    // The modal side effects are taken again, so the palette still closes the usual way.
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.activeElement).toBe(input());
    dialog().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dialog().hidden).toBe(true);
    expect(document.body.style.overflow).toBe("");
  });

  it("binds the hotkey again after a disconnect and reconnect of a closed palette", async () => {
    const instance = controller();
    instance.disconnect();
    instance.connect();

    pressHotkey();
    await tick();
    expect(dialog().hidden).toBe(false);
    dialog().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dialog().hidden).toBe(true);
  });

  it("keeps an open palette and its modal side effects through turbo:before-cache", async () => {
    pressHotkey();
    await tick();

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(dialog().hidden).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");
    expect(input().getAttribute("aria-expanded")).toBe("true");
  });

  describe("a Turbo morph", () => {
    /** What a morph does: put the server's markup back and dispatch `turbo:morph-element`. */
    const morphToServerMarkup = async () => {
      dialog().setAttribute("hidden", "");
      input().setAttribute("aria-expanded", "false");
      input().removeAttribute("aria-activedescendant");
      for (const id of ["cmd-new", "cmd-publish", "cmd-delete", "cmd-heading"]) {
        option(id).removeAttribute("hidden");
        option(id).removeAttribute("data-active");
        option(id).removeAttribute("aria-selected");
        option(id).removeAttribute("aria-disabled");
      }
      empty().setAttribute("hidden", "");
      dialog().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      await tick();
    };

    it("keeps an open palette open with its query, its matches and its active option", async () => {
      pressHotkey();
      await tick();
      type("e");
      press("ArrowDown");
      expect(option("cmd-delete").getAttribute("aria-selected")).toBe("true");
      expect(option("cmd-publish").hidden).toBe(true);

      await morphToServerMarkup();

      expect(dialog().hidden).toBe(false);
      expect(document.body.style.overflow).toBe("hidden");
      expect(input().getAttribute("aria-expanded")).toBe("true");
      expect(input().value).toBe("e");
      expect(option("cmd-publish").hidden).toBe(true);
      expect(option("cmd-delete").getAttribute("aria-selected")).toBe("true");
      expect(input().getAttribute("aria-activedescendant")).toBe("cmd-delete");
      expect(option("cmd-heading").getAttribute("aria-disabled")).toBe("true");
    });

    it("keeps a closed palette closed through a morph that drops its hidden", async () => {
      dialog().removeAttribute("hidden");
      dialog().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      await tick();

      expect(dialog().hidden).toBe(true);
      expect(input().getAttribute("aria-expanded")).toBe("false");
    });

    it("stops writing its mark back after a morph once disconnected, and keeps it", async () => {
      const root = document.querySelector(
        "[data-controller='stimeo--command-palette']",
      ) as HTMLElement;
      controller().disconnect();
      expect(root.hasAttribute("data-stimeo--command-palette-lived")).toBe(true);

      root.removeAttribute("data-stimeo--command-palette-lived");
      root.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      await flushMicrotasks();

      expect(root.hasAttribute("data-stimeo--command-palette-lived")).toBe(false);
    });

    it("writes nothing after a morph once disconnected, and takes a morph with no dialog", async () => {
      const root = document.querySelector(
        "[data-controller='stimeo--command-palette']",
      ) as HTMLElement;
      dialog().removeAttribute("data-stimeo--command-palette-target");
      await tick();
      root.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      await tick();
      expect(dialog().hidden).toBe(true);

      dialog().setAttribute("data-stimeo--command-palette-target", "dialog");
      await tick();
      application.unload("stimeo--command-palette");
      dialog().removeAttribute("hidden");
      root.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      await tick();
      expect(dialog().hidden).toBe(false);
    });
  });

  describe("a copy of the page Turbo restores", () => {
    const restore = async (): Promise<void> => {
      application = await restoreFromCache(application, (restored) =>
        restored.register("stimeo--command-palette", CommandPaletteController),
      );
    };

    it("shows a palette that was open closed, with the page operable", async () => {
      pressHotkey();
      await tick();
      type("pub");

      await restore();

      expect(dialog().hidden).toBe(true);
      expect(input().getAttribute("aria-expanded")).toBe("false");
      expect(input().hasAttribute("aria-activedescendant")).toBe(false);
      expect(option("cmd-publish").getAttribute("aria-selected")).toBe("false");
      expect(
        document
          .querySelector("[data-controller='stimeo--command-palette']")
          ?.getAttribute("data-stimeo--command-palette-open-value"),
      ).toBe("false");
      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
      expect(document.body.style.overflow).toBe("");

      pressHotkey();
      await tick();
      expect(dialog().hidden).toBe(false);
      expect(input().value).toBe("");
      expect(document.body.style.overflow).toBe("hidden");
    });

    it("keeps a closed palette closed", async () => {
      pressHotkey();
      await tick();
      controller().close();

      await restore();

      expect(dialog().hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
    });
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
      late.setAttribute("data-action", "click->stimeo--command-palette#select");
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
  describe("a dialog that replaces the current one", () => {
    /** A server-rendered copy of the dialog, closed as the markup contract authors it. */
    const dialogCopy = (): HTMLElement => {
      const copy = dialog().cloneNode(true) as HTMLElement;
      copy.hidden = true;
      return copy;
    };
    const successorInput = (successor: HTMLElement) =>
      successor.querySelector("[data-stimeo--command-palette-target='input']") as HTMLElement;

    it("keeps the palette open on a replacement delivered in one task", async () => {
      trigger().focus();
      controller().open();
      const successor = dialogCopy();
      dialog().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(false);
      expect(document.activeElement).toBe(successorInput(successor));
      expect(document.body.style.overflow).toBe("hidden");
      expect(trigger().inert).toBe(true);
    });

    it("keeps the palette open on the dialog that stays after an earlier one leaves", async () => {
      trigger().focus();
      controller().open();
      const original = dialog();
      const successor = dialogCopy();
      original.after(successor);
      await tick();
      original.remove();
      await tick();

      expect(successor.hidden).toBe(false);
      expect(document.activeElement).toBe(successorInput(successor));
      expect(successorInput(successor).getAttribute("aria-expanded")).toBe("true");
      expect(document.body.style.overflow).toBe("hidden");
    });

    it("still returns focus to the opener when the palette closes after the swap", async () => {
      trigger().focus();
      controller().open();
      const original = dialog();
      const successor = dialogCopy();
      original.after(successor);
      await tick();
      original.remove();
      await tick();
      controller().close();

      expect(successor.hidden).toBe(true);
      expect(document.activeElement).toBe(trigger());
      expect(trigger().inert).toBe(false);
      expect(document.body.style.overflow).toBe("");
    });

    it.each(TARGET_SWAPS)(
      "keeps a modal opened over it on top when its dialog is replaced %s",
      async (_, swap) => {
        trigger().focus();
        controller().open();
        const upper = openUpperModal();
        const successor = dialogCopy();
        await swap(dialog(), successor);

        expectUpperModalOnTop(upper, successor);
        expect(successor.hidden).toBe(false);
        typeKey(document, "Escape");
        expect(successor.hidden).toBe(true);
        expect(document.activeElement).toBe(trigger());
      },
    );

    it("closes a dialog that replaces the current one while the palette is closed", async () => {
      const successor = dialogCopy();
      successor.hidden = false;
      dialog().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
    });

    it("releases the modal side effects when the only dialog leaves while open", async () => {
      trigger().focus();
      controller().open();
      const only = dialog();
      only.remove();
      await tick();

      expect(document.body.style.overflow).toBe("");
      expect(trigger().inert).toBe(false);
      expect(document.activeElement).toBe(trigger());
      expect(controller().element.getAttribute("data-stimeo--command-palette-open-value")).toBe(
        "false",
      );
    });

    it("closes the palette when the only dialog loses its target token", async () => {
      controller().open();
      press("ArrowDown");
      const only = dialog();
      only.removeAttribute("data-stimeo--command-palette-target");
      await tick();

      expect(only.hidden).toBe(true);
      expect(input().getAttribute("aria-expanded")).toBe("false");
      expect(option("cmd-publish").getAttribute("aria-selected")).toBe("false");
      expect(document.body.style.overflow).toBe("");
      expect(controller().element.getAttribute("data-stimeo--command-palette-open-value")).toBe(
        "false",
      );
    });

    it("closes a dialog that arrives after the only one left", async () => {
      controller().open();
      const arrival = dialogCopy();
      arrival.hidden = false;
      dialog().remove();
      await tick();
      document.querySelector("[data-controller='stimeo--command-palette']")?.append(arrival);
      await tick();

      expect(arrival.hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
    });

    it("focuses the input of the dialog that stays when the earlier one loses its token", async () => {
      controller().open();
      const original = dialog();
      const successor = dialogCopy();
      original.after(successor);
      await tick();
      original.removeAttribute("data-stimeo--command-palette-target");
      await tick();

      expect(document.activeElement).toBe(successorInput(successor));
    });

    it("closes a dialog left in the page without its target token", async () => {
      controller().open();
      const original = dialog();
      const successor = dialogCopy();
      original.after(successor);
      await tick();
      original.removeAttribute("data-stimeo--command-palette-target");
      await tick();

      expect(original.hidden).toBe(true);
      expect(successor.hidden).toBe(false);
    });

    it("leaves focus where it is when a dialog arrives behind the current one", async () => {
      controller().open();
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Close";
      dialog().append(button);
      button.focus();
      dialog().after(dialogCopy());
      await tick();

      expect(document.activeElement).toBe(button);
    });

    it("leaves focus on the page when a dialog arrives behind the current one", async () => {
      controller().open();
      (document.activeElement as HTMLElement).blur();
      dialog().after(dialogCopy());
      await tick();

      expect(document.activeElement).toBe(document.body);
      expect(dialog().hidden).toBe(false);
    });

    it("keeps an open dialog that moves within the element open", () => {
      controller().open();
      const current = dialog();
      current.parentElement?.append(current);
      // Drive the callback directly: happy-dom delivers target callbacks unreliably.
      controller().dialogTargetDisconnected(current);

      expect(current.hidden).toBe(false);
      expect(document.body.style.overflow).toBe("hidden");
    });

    it("reports nothing while it moves the open state", async () => {
      controller().open();
      const selections: Event[] = [];
      listenForSelection((event) => selections.push(event));
      dialog().replaceWith(dialogCopy());
      await tick();

      expect(selections).toEqual([]);
    });

    it("moves nothing once it has disconnected", async () => {
      controller().open();
      const original = dialog();
      const successor = dialogCopy();
      original.after(successor);
      await tick();
      const instance = controller();
      instance.disconnect();
      // The teardown closed the palette; any write from here on would hide it again.
      successor.hidden = false;
      original.remove();
      instance.dialogTargetDisconnected(original);

      expect(successor.hidden).toBe(false);
      expect(document.body.style.overflow).toBe("");
    });

    it("gives the dialog back its own hidden when the palette loses its controller", async () => {
      trigger().focus();
      controller().open();
      const departed = dialog();

      controller().element.removeAttribute("data-controller");
      await tick();

      expect(departed.hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
      expect(trigger().inert).toBe(false);
    });

    it("keeps the open state on a dialog that moves within the element", async () => {
      controller().open();
      const moving = dialog();

      const writes = await attributeWrites(moving, ["hidden"], () =>
        moving.parentElement?.append(moving),
      );

      expect(moving.hidden).toBe(false);
      expect(writes.map((write) => write.attributeName)).toEqual([]);
    });
  });

  describe("an empty region that replaces the current one", () => {
    /** A copy of the empty region carrying `hidden` as authored. */
    const emptyCopy = (hidden: boolean): HTMLElement => {
      const copy = empty().cloneNode(true) as HTMLElement;
      copy.removeAttribute("id");
      copy.hidden = hidden;
      return copy;
    };

    it("shows a replacement delivered in one task while nothing matches", async () => {
      controller().open();
      type("zzz");
      const successor = emptyCopy(true);
      empty().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(false);
    });

    it("shows the region that stays after an earlier one leaves while nothing matches", async () => {
      controller().open();
      const original = empty();
      const successor = emptyCopy(true);
      original.after(successor);
      await tick();
      type("zzz"); // writes the earlier region only
      original.remove();
      await tick();

      expect(successor.hidden).toBe(false);
    });

    it("hides a region that arrives after the only one left while commands match", async () => {
      controller().open();
      const arrival = emptyCopy(false);
      empty().remove();
      await tick();
      dialog().append(arrival);
      await tick();

      expect(arrival.hidden).toBe(true);
    });

    it("reports nothing while it synchronizes the region", async () => {
      controller().open();
      type("zzz");
      const selections: Event[] = [];
      listenForSelection((event) => selections.push(event));
      empty().replaceWith(emptyCopy(true));
      await tick();

      expect(selections).toEqual([]);
    });

    it("hides a region left in the page without its target token", async () => {
      controller().open();
      type("zzz");
      const original = empty();
      original.removeAttribute("data-stimeo--command-palette-target");
      await tick();

      expect(original.hidden).toBe(true);
    });

    it("keeps a hidden value the page wrote on a region that stops being the target", async () => {
      controller().open();
      type("zzz");
      const original = empty();
      original.setAttribute("hidden", "until-found");
      original.removeAttribute("data-stimeo--command-palette-target");
      await tick();

      expect(original.getAttribute("hidden")).toBe("until-found");
    });

    it("gives the region back its own hidden when the palette loses its controller", async () => {
      controller().open();
      type("zzz");
      const departed = empty();
      expect(departed.hidden).toBe(false);

      controller().element.removeAttribute("data-controller");
      await tick();

      expect(departed.hidden).toBe(true);
    });

    it("keeps what it wrote on a region that moves within the dialog", async () => {
      controller().open();
      type("zzz");
      const moving = empty();

      const writes = await attributeWrites(moving, ["hidden"], () => dialog().prepend(moving));

      expect(moving.hidden).toBe(false);
      expect(writes.map((write) => write.attributeName)).toEqual([]);
    });

    it("tolerates the removal of the only region", async () => {
      controller().open();
      type("zzz");
      const only = empty();
      only.remove();

      expect(() => controller().emptyTargetDisconnected(only)).not.toThrow();
      await tick();
      expect(dialog().hidden).toBe(false);
    });

    it("writes nothing into the region that stays once it has disconnected", async () => {
      controller().open();
      const original = empty();
      const successor = emptyCopy(true);
      original.after(successor);
      await tick();
      type("zzz");
      const instance = controller();
      instance.disconnect();
      original.remove();
      instance.emptyTargetDisconnected(original);
      await tick();

      expect(successor.hidden).toBe(true);
    });
  });
});

describe("CommandPaletteController initial open state", () => {
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

  it("opens on a fresh render whose dialog the server wrote open (DOM wins over Value)", async () => {
    // The server renders the dialog open (no `hidden`) while the declarative open Value
    // says false. The dialog decides, and the FocusTrap is taken.
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

  it("reads the open Value at connect only and leaves the palette alone on a later declaration", async () => {
    await startWith(`data-stimeo--command-palette-open-value="false"`, "hidden");
    const host = document.querySelector<HTMLElement>(
      "[data-controller='stimeo--command-palette']",
    ) as HTMLElement;
    host.setAttribute("data-stimeo--command-palette-open-value", "true");
    await tick();
    expect(dialog().hidden).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(document.body.style.overflow).toBe("");

    // A palette the user opened stays open over a declaration that says closed.
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(dialog().hidden).toBe(false);
    host.setAttribute("data-stimeo--command-palette-open-value", "false");
    await tick();
    expect(dialog().hidden).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");
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

  describe("a dialog the server wrote open, in a copy of the page Turbo restores", () => {
    const restore = async (): Promise<void> => {
      application = await restoreFromCache(application, (restored) =>
        restored.register("stimeo--command-palette", CommandPaletteController),
      );
    };
    const root = () =>
      document.querySelector("[data-controller='stimeo--command-palette']") as HTMLElement;

    it("is shown closed, with the page operable", async () => {
      await startWith(`data-stimeo--command-palette-open-value="false"`, "");
      expect(dialog().hidden).toBe(false);
      expect(document.body.style.overflow).toBe("hidden");

      await restore();

      expect(dialog().hidden).toBe(true);
      expect(input().getAttribute("aria-expanded")).toBe("false");
      expect(root().getAttribute("data-stimeo--command-palette-open-value")).toBe("false");
      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
      expect(document.body.style.overflow).toBe("");

      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }),
      );
      expect(dialog().hidden).toBe(false);
      expect(document.body.style.overflow).toBe("hidden");
    });

    it("is shown closed in a copy taken after the controller disconnected", async () => {
      await startWith(`data-stimeo--command-palette-open-value="false"`, "");
      disconnectAndStopApplication(application);
      expect(dialog().hidden).toBe(false);

      await restore();

      expect(dialog().hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
    });

    it("is shown closed once restored after a morph dropped its mark", async () => {
      await startWith(`data-stimeo--command-palette-open-value="false"`, "");
      const mark = root()
        .getAttributeNames()
        .filter((name) => name.endsWith("-lived"));
      expect(mark).toEqual(["data-stimeo--command-palette-lived"]);
      // A Turbo morph keeps only the attributes the server sent.
      root().removeAttribute("data-stimeo--command-palette-lived");
      root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      await flushMicrotasks();
      expect(dialog().hidden).toBe(false);

      await restore();

      expect(dialog().hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
    });

    it("stays open when the element of a palette the server wrote open moves within the page", async () => {
      await startWith(`data-stimeo--command-palette-open-value="false"`, "");
      const instance = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--command-palette",
      ) as CommandPaletteController;

      instance.disconnect();
      instance.connect();

      expect(dialog().hidden).toBe(false);
      expect(input().getAttribute("aria-expanded")).toBe("true");
      expect(document.body.style.overflow).toBe("hidden");
    });
  });

  it("shows a palette the server rendered open closed once Turbo restores a copy of the page", async () => {
    await startWith(`data-stimeo--command-palette-open-value="true"`, "hidden");
    expect(dialog().hidden).toBe(false);

    application = await restoreFromCache(application, (restored) =>
      restored.register("stimeo--command-palette", CommandPaletteController),
    );

    expect(dialog().hidden).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(document.body.style.overflow).toBe("");
  });
});
