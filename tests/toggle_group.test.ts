import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToggleGroupController } from "../src/controllers/toggle_group_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureFieldCommits } from "./helpers/field_commits";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents, type StateEventCapture } from "./helpers/state_events";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ToggleGroupController}: pressed-state ownership,
 * single/multiple selection, delegated activation, resilient roving focus,
 * retained-element reconciliation, and the `change` / `reconcile` notifications.
 */

const action = `data-action="click->stimeo--toggle-group#toggle
  keydown->stimeo--toggle-group#onKeydown"`;

const item = (
  value: string,
  pressed = "false",
  tabindex: number | null = -1,
  extra = "",
) => `<button type="button" aria-pressed="${pressed}"
  ${tabindex === null ? "" : `tabindex="${tabindex}"`} data-value="${value}"
  data-stimeo--toggle-group-target="item" ${action} ${extra}>${value}</button>`;

const group = (
  content = `${item("bold", "true", 0)}${item("italic")}${item("underline")}`,
  mode?: string,
) => `<div data-controller="stimeo--toggle-group" role="group" aria-label="Text style"
  ${mode ? `data-stimeo--toggle-group-mode-value="${mode}"` : ""}>${content}</div>`;

describe("ToggleGroupController", () => {
  let application: Application | null = null;

  const start = async (html = group(), beforeRegister?: () => void) => {
    document.body.innerHTML = html;
    beforeRegister?.();
    application = Application.start();
    application.register("stimeo--toggle-group", ToggleGroupController);
    await tick();
  };

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = null;
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  const roots = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-controller~="stimeo--toggle-group"]'));
  const root = (index = 0) => roots()[index] as HTMLElement;
  const controller = (scope = root()) =>
    application?.getControllerForElementAndIdentifier(
      scope,
      "stimeo--toggle-group",
    ) as ToggleGroupController;
  const items = (scope = root()) =>
    Array.from(
      scope.querySelectorAll<HTMLElement>('[data-stimeo--toggle-group-target~="item"]'),
    ).filter(
      (candidate) => candidate.closest('[data-controller~="stimeo--toggle-group"]') === scope,
    );
  const pressed = (scope = root()) =>
    items(scope).map((candidate) => candidate.getAttribute("aria-pressed"));
  const tabindexes = (scope = root()) => items(scope).map((candidate) => candidate.tabIndex);
  const key = (
    candidate: HTMLElement,
    value: string,
    init: KeyboardEventInit = {},
  ): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", {
      key: value,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    candidate.dispatchEvent(event);
    return event;
  };

  it("uses the first nonzero pressed item as the initial Tab stop", async () => {
    await start(group(`${item("bold", "false")}${item("italic", "true")}${item("underline")}`));
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("falls back to the first item when none is pressed", async () => {
    await start(group(`${item("bold")}${item("italic")}${item("underline")}`));
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("rejects ambiguous authored Tab stops and falls back to the pressed item", async () => {
    await start(
      group(`${item("first", "false", 0)}${item("second", "true")}${item("third", "false", 0)}`),
    );
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("preserves the sole runtime Tab stop across a reconnect", async () => {
    await start();
    key(items()[0] as HTMLElement, "End");
    expect(tabindexes()).toEqual([-1, -1, 0]);

    const retained = root();
    retained.removeAttribute("data-controller");
    await tick();
    retained.setAttribute("data-controller", "stimeo--toggle-group");
    await tick();

    expect(tabindexes()).toEqual([-1, -1, 0]);
  });

  it("releases an item removed while its retained group is disconnected", async () => {
    await start(
      group(`<button type="button" id="stale" tabindex="4"
        data-value="stale" data-stimeo--toggle-group-target="item">Stale</button>${item("kept")}`),
    );
    const retained = root();
    const stale = retained.querySelector("#stale") as HTMLButtonElement;
    expect(stale.tabIndex).toBe(0);
    expect(stale.getAttribute("aria-pressed")).toBe("false");

    retained.removeAttribute("data-controller");
    await tick();
    stale.remove();
    retained.setAttribute("data-controller", "stimeo--toggle-group");
    await tick();

    expect(stale.getAttribute("tabindex")).toBe("4");
    expect(stale.hasAttribute("aria-pressed")).toBe(false);
    expect(tabindexes()).toEqual([0]);
  });

  it("toggles independently in multiple mode and does not double-handle per-item actions", async () => {
    await start();
    items()[1]?.click();
    expect(pressed()).toEqual(["true", "true", "false"]);
    items()[0]?.click();
    expect(pressed()).toEqual(["false", "true", "false"]);
    items()[2]?.click();
    await tick();
    expect(pressed()).toEqual(["false", "true", "true"]);
  });

  it("keeps at most one pressed in single mode and permits zero pressed", async () => {
    await start(group(undefined, "single"));
    items()[1]?.click();
    expect(pressed()).toEqual(["false", "true", "false"]);
    items()[1]?.click();
    expect(pressed()).toEqual(["false", "false", "false"]);
  });

  it("moves focus with every LTR arrow without changing pressed state", async () => {
    await start();
    const candidates = items();
    candidates[0]?.focus();

    key(candidates[0] as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(candidates[1]);
    key(candidates[1] as HTMLElement, "ArrowUp");
    expect(document.activeElement).toBe(candidates[0]);
    key(candidates[0] as HTMLElement, "ArrowRight");
    expect(document.activeElement).toBe(candidates[1]);
    key(candidates[1] as HTMLElement, "ArrowLeft");
    expect(document.activeElement).toBe(candidates[0]);
    expect(pressed()).toEqual(["true", "false", "false"]);
  });

  it("wraps arrow navigation at both ends", async () => {
    await start();
    key(items()[0] as HTMLElement, "ArrowLeft");
    expect(document.activeElement).toBe(items()[2]);
    key(items()[2] as HTMLElement, "ArrowRight");
    expect(document.activeElement).toBe(items()[0]);
  });

  it("reverses horizontal arrows under RTL without reversing vertical arrows", async () => {
    await start();
    root().style.direction = "rtl";
    key(items()[0] as HTMLElement, "ArrowLeft");
    expect(document.activeElement).toBe(items()[1]);
    key(items()[1] as HTMLElement, "ArrowRight");
    expect(document.activeElement).toBe(items()[0]);
    key(items()[0] as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(items()[1]);
  });

  it("jumps to the first and last navigable items with unmodified Home and End", async () => {
    await start();
    key(items()[0] as HTMLElement, "End");
    expect(document.activeElement).toBe(items()[2]);
    key(items()[2] as HTMLElement, "Home");
    expect(document.activeElement).toBe(items()[0]);
  });

  it("leaves modified arrows and Home/End chords to the browser", async () => {
    await start();
    items()[0]?.focus();
    const arrow = key(items()[0] as HTMLElement, "ArrowRight", { altKey: true });
    const home = key(items()[0] as HTMLElement, "Home", { ctrlKey: true });
    const end = key(items()[0] as HTMLElement, "End", { metaKey: true });
    expect([arrow.defaultPrevented, home.defaultPrevented, end.defaultPrevented]).toEqual([
      false,
      false,
      false,
    ]);
    expect(document.activeElement).toBe(items()[0]);
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("yields a key already consumed by a descendant widget", async () => {
    await start();
    items()[0]?.focus();
    const inner = document.createElement("span");
    items()[0]?.append(inner);
    inner.addEventListener("keydown", (event) => event.preventDefault());

    const claimed = key(inner, "ArrowRight");
    expect(claimed.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items()[0]);
  });

  it("yields navigation and activation to a key the platform marks as composing", async () => {
    await start(
      group(`<div role="button" tabindex="0" aria-pressed="false" data-value="grid"
        data-stimeo--toggle-group-target="item">Grid</div>${item("list")}`),
    );
    const candidates = items();
    key(candidates[0] as HTMLElement, "ArrowRight", { isComposing: true });
    key(candidates[0] as HTMLElement, "Enter", { isComposing: true });
    expect(document.activeElement).not.toBe(candidates[1]);
    expect(pressed()).toEqual(["false", "false"]);

    key(candidates[0] as HTMLElement, "Enter");
    expect(pressed()).toEqual(["true", "false"]);
  });

  it("leaves initial native Space/Enter to the browser and suppresses repeats", async () => {
    await start();
    const first = items()[0] as HTMLButtonElement;
    for (const activationKey of [" ", "Enter"]) {
      first.setAttribute("aria-pressed", "false");
      await tick();
      const initial = key(first, activationKey);
      expect(initial.defaultPrevented).toBe(false);
      expect(first.getAttribute("aria-pressed")).toBe("false");
      const repeated = key(first, activationKey, { repeat: true });
      expect(repeated.defaultPrevented).toBe(true);
      expect(first.getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("syncs the roving entry point to pointer or programmatic focus", async () => {
    await start();
    items()[2]?.focus();
    expect(tabindexes()).toEqual([-1, -1, 0]);
  });

  it("dispatches the exact change detail only for user activation", async () => {
    await start();
    const details: Array<{ value: string; pressed: boolean; values: string[] }> = [];
    root().addEventListener("stimeo--toggle-group:change", (event) => {
      details.push((event as CustomEvent).detail);
    });
    items()[1]?.click();
    expect(details).toEqual([{ value: "italic", pressed: true, values: ["bold", "italic"] }]);
  });

  it("respects a consumer-canceled click", async () => {
    await start(
      group(`<button type="button" aria-pressed="false" data-value="safe"
        data-stimeo--toggle-group-target="item" ${action}>Safe</button>`),
      () =>
        items()
          .at(0)
          ?.addEventListener("click", (event) => event.preventDefault()),
    );
    items()[0]?.click();
    expect(pressed()).toEqual(["false"]);
  });

  it("handles duplicate per-item key actions and delegation exactly once", async () => {
    await start(
      group(`<div role="button" aria-pressed="false" tabindex="0" data-value="grid"
        data-stimeo--toggle-group-target="item"
        data-action="keydown->stimeo--toggle-group#onKeydown
                     keydown->stimeo--toggle-group#onKeydown">Grid</div>`),
    );
    key(items()[0] as HTMLElement, " ");
    expect(pressed()).toEqual(["true"]);
  });

  it("ignores declared public actions whose currentTarget is not an item", async () => {
    await start(
      group(`${item("bold", "true", 0)}<span data-action="click->stimeo--toggle-group#toggle
        keydown->stimeo--toggle-group#onKeydown">decoration</span>`),
    );
    const decoration = root().querySelector("span") as HTMLElement;
    decoration.click();
    const navigation = key(decoration, "ArrowRight");
    expect(pressed()).toEqual(["true"]);
    expect(tabindexes()).toEqual([0]);
    expect(navigation.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(items()[0]);
  });

  it("isolates public actions and delegated events from a nested Toggle Group", async () => {
    await start(
      group(`<div role="button" aria-pressed="false" tabindex="0" data-value="outer"
          data-stimeo--toggle-group-target="item" ${action}>
        Outer
        ${group(`<div role="button" aria-pressed="false" tabindex="0" data-value="inner"
          data-stimeo--toggle-group-target="item">Inner</div>`)}
      </div>`),
    );
    const [outerRoot, innerRoot] = roots();
    const inner = items(innerRoot)[0] as HTMLElement;
    inner.click();
    expect(pressed(outerRoot)).toEqual(["false"]);
    expect(pressed(innerRoot)).toEqual(["true"]);

    key(inner, "Enter");
    expect(pressed(outerRoot)).toEqual(["false"]);
    expect(pressed(innerRoot)).toEqual(["false"]);
  });

  it("normalizes missing and invalid pressed tokens without dispatching an event", async () => {
    const details: unknown[] = [];
    await start(
      group(`<button type="button" data-value="missing"
          data-stimeo--toggle-group-target="item">Missing</button>
        <button type="button" aria-pressed="mixed" data-value="invalid"
          data-stimeo--toggle-group-target="item">Invalid</button>`),
      () => {
        for (const type of ["change", "reconcile"]) {
          root().addEventListener(`stimeo--toggle-group:${type}`, (event) =>
            details.push((event as CustomEvent).detail),
          );
        }
      },
    );
    expect(pressed()).toEqual(["false", "false"]);
    expect(details).toEqual([]);
  });

  it("normalizes initial, changed-mode, dynamic, and morphed single selection, reporting each move as reconcile", async () => {
    const details: unknown[] = [];
    const repairs: unknown[] = [];
    await start(group(`${item("first", "true", 0)}${item("second", "true")}`, "single"), () => {
      root().addEventListener("stimeo--toggle-group:change", (event) =>
        details.push((event as CustomEvent).detail),
      );
      root().addEventListener("stimeo--toggle-group:reconcile", (event) =>
        repairs.push((event as CustomEvent).detail),
      );
    });
    expect(pressed()).toEqual(["true", "false"]);
    // Connect normalizes first-wins and takes the result as the published set.
    expect(repairs).toEqual([]);

    root().setAttribute("data-stimeo--toggle-group-mode-value", "multiple");
    await tick();
    items()[1]?.setAttribute("aria-pressed", "true");
    await tick();
    root().setAttribute("data-stimeo--toggle-group-mode-value", "single");
    await tick();
    expect(pressed()).toEqual(["true", "false"]);

    root().insertAdjacentHTML("afterbegin", item("inserted", "true", null));
    await tick();
    expect(pressed()).toEqual(["true", "false", "false"]);

    items()[0]?.setAttribute("aria-pressed", "false");
    items()[2]?.setAttribute("aria-pressed", "true");
    await tick();
    expect(pressed()).toEqual(["false", "false", "true"]);
    expect(details).toEqual([]);
    expect(repairs).toEqual([
      { values: ["first", "second"] },
      { values: ["first"] },
      { values: ["inserted"] },
      { values: ["second"] },
    ]);
  });

  it("adds an actionless runtime item without creating a second Tab stop", async () => {
    await start();
    root().insertAdjacentHTML(
      "beforeend",
      `<button type="button" data-value="strike"
        data-stimeo--toggle-group-target="item">Strike</button>`,
    );
    await tick();
    expect(tabindexes()).toEqual([0, -1, -1, -1]);
    expect(pressed()).toEqual(["true", "false", "false", "false"]);

    items()[3]?.click();
    expect(pressed()).toEqual(["true", "false", "false", "true"]);
    key(items()[3] as HTMLElement, "ArrowRight");
    expect(document.activeElement).toBe(items()[0]);
  });

  it("navigates from an actionless item immediately after synchronous insertion", async () => {
    await start();
    root().insertAdjacentHTML(
      "beforeend",
      `<button type="button" id="immediate-navigation" data-value="strike"
        data-stimeo--toggle-group-target="item">Strike</button>`,
    );
    const inserted = root().querySelector("#immediate-navigation") as HTMLButtonElement;
    inserted.focus();
    key(inserted, "ArrowLeft");
    expect(document.activeElement).toBe(items()[2]);
  });

  it("activates and adopts an actionless item immediately after synchronous insertion", async () => {
    await start();
    const changes: unknown[] = [];
    root().addEventListener("stimeo--toggle-group:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    root().insertAdjacentHTML(
      "beforeend",
      `<button type="button" id="immediate-activation" data-value="strike"
        data-stimeo--toggle-group-target="item">Strike</button>`,
    );
    const inserted = root().querySelector("#immediate-activation") as HTMLButtonElement;
    const activation = new Event("click");
    Object.defineProperty(activation, "currentTarget", { value: inserted });
    controller().toggle(activation);
    expect(inserted.getAttribute("aria-pressed")).toBe("true");
    expect(tabindexes()).toEqual([-1, -1, -1, 0]);
    expect(changes).toEqual([{ value: "strike", pressed: true, values: ["bold", "strike"] }]);
  });

  it("keeps the current runtime Tab stop when another item is added", async () => {
    await start();
    key(items()[0] as HTMLElement, "End");
    root().insertAdjacentHTML(
      "beforeend",
      `<button type="button" data-value="strike"
        data-stimeo--toggle-group-target="item">Strike</button>`,
    );
    await tick();
    expect(tabindexes()).toEqual([-1, -1, 0, -1]);
  });

  it("recovers the Tab stop when the active item is removed or replaced", async () => {
    await start();
    key(items()[0] as HTMLElement, "ArrowRight");
    const removed = items()[1] as HTMLElement;
    removed.remove();
    await tick();
    expect(tabindexes()).toEqual([0, -1]);
    expect(removed.getAttribute("tabindex")).toBe("-1");

    items()[0]?.replaceWith(
      Object.assign(document.createElement("button"), {
        type: "button",
        textContent: "replacement",
      }),
    );
    const replacement = root().querySelector("button:not([data-value])") as HTMLButtonElement;
    replacement.setAttribute("data-value", "replacement");
    replacement.setAttribute("data-stimeo--toggle-group-target", "item");
    await tick();
    expect(tabindexes()).toEqual([0, -1]);
    replacement.click();
    expect(replacement.getAttribute("aria-pressed")).toBe("true");
  });

  it("skips native-disabled and hidden items and reacts to retained-state changes", async () => {
    await start(
      group(
        `${item("first", "true", 0)}<span>${item("second")}</span><span>${item("third")}</span>`,
      ),
    );
    const candidates = items();
    (candidates[1] as HTMLButtonElement).disabled = true;
    await tick();
    candidates[1]?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(tabindexes()).toEqual([0, -1, -1]);
    key(candidates[0] as HTMLElement, "ArrowRight");
    expect(document.activeElement).toBe(candidates[2]);

    candidates[2]?.parentElement?.setAttribute("hidden", "");
    await tick();
    expect(tabindexes()).toEqual([0, -1, -1]);
    (candidates[1] as HTMLButtonElement).disabled = false;
    await tick();
    key(candidates[0] as HTMLElement, "ArrowRight");
    expect(document.activeElement).toBe(candidates[1]);
  });

  it("drops to zero Tab stops when all items are unavailable and recovers", async () => {
    await start();
    for (const candidate of items()) (candidate as HTMLButtonElement).disabled = true;
    await tick();
    expect(tabindexes()).toEqual([-1, -1, -1]);

    (items()[1] as HTMLButtonElement).disabled = false;
    await tick();
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("tracks disabled fieldsets outside the group, including recovery", async () => {
    await start(`<fieldset>${group()}</fieldset>`);
    const fieldset = document.querySelector("fieldset") as HTMLFieldSetElement;
    fieldset.disabled = true;
    await tick();
    expect(tabindexes()).toEqual([-1, -1, -1]);
    fieldset.disabled = false;
    await tick();
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("does not apply native fieldset disabledness to a generic button host", async () => {
    await start(
      `<fieldset disabled>${group(`<div role="button" aria-pressed="false" tabindex="0"
        data-value="generic" data-stimeo--toggle-group-target="item">Generic</div>`)}</fieldset>`,
    );
    expect(tabindexes()).toEqual([0]);
    items()[0]?.click();
    expect(pressed()).toEqual(["true"]);
  });

  it("blocks synthetic activation of native-disabled and hidden items", async () => {
    await start();
    const changes = vi.fn();
    root().addEventListener("stimeo--toggle-group:change", changes);
    const disabled = items()[1] as HTMLButtonElement;
    disabled.disabled = true;
    const hidden = items()[2] as HTMLButtonElement;
    hidden.hidden = true;
    await tick();

    disabled.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    hidden.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(pressed()).toEqual(["true", "false", "false"]);
    expect(changes).not.toHaveBeenCalled();
  });

  it("keeps aria-disabled items discoverable while blocking every activation path", async () => {
    await start(
      group(
        `${item("first", "true", 0)}${item("second", "false", -1, 'aria-disabled="true"')}${item("third")}`,
      ),
    );
    const second = items()[1] as HTMLElement;
    const consumer = vi.fn();
    const changes = vi.fn();
    second.addEventListener("click", consumer);
    root().addEventListener("stimeo--toggle-group:change", changes);

    key(items()[0] as HTMLElement, "ArrowRight");
    expect(document.activeElement).toBe(second);
    second.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const activation = key(second, " ");
    expect(activation.defaultPrevented).toBe(true);
    expect(pressed()).toEqual(["true", "false", "false"]);
    expect(consumer).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();

    key(second, "ArrowRight");
    expect(document.activeElement).toBe(items()[2]);
  });

  it("inherits aria-disabled activation suppression from the group", async () => {
    await start();
    root().setAttribute("aria-disabled", "true");
    items()[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(pressed()).toEqual(["true", "false", "false"]);
    key(items()[0] as HTMLElement, "ArrowRight");
    expect(document.activeElement).toBe(items()[1]);
  });

  it("supports generic button hosts with single-shot Space and Enter activation", async () => {
    await start(
      group(`<div role="button" aria-pressed="false" tabindex="0" data-value="grid"
          data-stimeo--toggle-group-target="item">Grid</div>
        <div role="button" aria-pressed="false" tabindex="-1" data-value="list"
          data-stimeo--toggle-group-target="item">List</div>`),
    );
    const first = items()[0] as HTMLElement;
    expect(key(first, " ").defaultPrevented).toBe(true);
    expect(pressed()).toEqual(["true", "false"]);
    key(first, " ", { repeat: true });
    expect(pressed()).toEqual(["true", "false"]);
    key(first, "Enter");
    expect(pressed()).toEqual(["false", "false"]);
  });

  it("stands down on conflicting native interactive hosts", async () => {
    await start(
      group(`<a href="/destination" role="button" tabindex="5" aria-pressed="false"
          data-value="link" data-stimeo--toggle-group-target="item">Link</a>
        <button aria-pressed="false" tabindex="4" data-value="submit"
          data-stimeo--toggle-group-target="item">Submit</button>
        ${item("safe", "false", -1)}`),
    );
    const [link, submit, safe] = items();
    expect(tabindexes()).toEqual([5, 4, 0]);

    const linkClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    link?.dispatchEvent(linkClick);
    const linkEnter = key(link as HTMLElement, "Enter");
    submit?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(linkClick.defaultPrevented).toBe(false);
    expect(linkEnter.defaultPrevented).toBe(false);
    expect(link?.getAttribute("aria-pressed")).toBe("false");
    expect(submit?.getAttribute("aria-pressed")).toBe("false");
    expect(safe?.getAttribute("aria-pressed")).toBe("false");
  });

  it("restores owned defaults when a retained host becomes unsupported and reclaims it later", async () => {
    await start(
      group(`<a role="button" tabindex="3" data-value="view"
        data-stimeo--toggle-group-target="item">View</a>`),
    );
    const link = items()[0] as HTMLAnchorElement;
    expect([link.tabIndex, link.getAttribute("aria-pressed")]).toEqual([0, "false"]);

    link.href = "/destination";
    await tick();
    expect([link.tabIndex, link.getAttribute("aria-pressed")]).toEqual([3, null]);
    link.click();
    expect(link.getAttribute("aria-pressed")).toBeNull();

    link.removeAttribute("href");
    await tick();
    expect([link.tabIndex, link.getAttribute("aria-pressed")]).toEqual([0, "false"]);

    // The default supplied on reclaim is still the group's to take back.
    link.href = "/again";
    await tick();
    expect(link.getAttribute("aria-pressed")).toBeNull();
  });

  it("treats a page write of the value it supplied as authored", async () => {
    await start(
      group(`<a role="button" tabindex="3" href="/destination" data-value="view"
        data-stimeo--toggle-group-target="item">View</a>`),
    );
    const link = items()[0] as HTMLAnchorElement;
    link.removeAttribute("href");
    await tick();
    expect(link.getAttribute("aria-pressed")).toBe("false");

    // Once the page writes the same token, it is the page's value, not the group's default.
    link.setAttribute("aria-pressed", "false");
    await tick();
    link.href = "/destination";
    await tick();
    expect(link.getAttribute("aria-pressed")).toBe("false");
  });

  it("preserves an aria-pressed value authored after the controller supplied its default", async () => {
    await start(
      group(`<a role="button" tabindex="3" data-value="view"
        data-stimeo--toggle-group-target="item">View</a>`),
    );
    const link = items()[0] as HTMLAnchorElement;
    link.setAttribute("aria-pressed", "true");
    await tick();
    link.href = "/destination";
    await tick();
    expect(link.getAttribute("aria-pressed")).toBe("true");
    expect(link.tabIndex).toBe(3);
  });

  it("reacts when inherited contenteditable changes host support", async () => {
    await start(
      group(`<div><span role="button" tabindex="2" data-value="view"
        data-stimeo--toggle-group-target="item">View</span></div>`),
    );
    const wrapper = items()[0]?.parentElement as HTMLElement;
    const candidate = items()[0] as HTMLElement;
    wrapper.contentEditable = "true";
    await tick();
    expect([candidate.tabIndex, candidate.getAttribute("aria-pressed")]).toEqual([2, null]);
    wrapper.contentEditable = "false";
    await tick();
    expect([candidate.tabIndex, candidate.getAttribute("aria-pressed")]).toEqual([0, "false"]);
  });

  it("isolates sibling and nested Toggle Group instances", async () => {
    await start(`${group(item("outer", "false", 0))}${group(item("sibling", "false", 0))}`);
    items(root(1))[0]?.click();
    expect(pressed(root(0))).toEqual(["false"]);
    expect(pressed(root(1))).toEqual(["true"]);

    document.body.innerHTML = group(
      `${item("outer", "false", 0)}${group(item("inner", "false", 0))}`,
    );
    await tick();
    const [outerRoot, innerRoot] = roots();
    items(innerRoot)[0]?.click();
    expect(pressed(outerRoot)).toEqual(["false"]);
    expect(pressed(innerRoot)).toEqual(["true"]);
  });

  it("handles empty and single-item groups without orphaning focus", async () => {
    await start(group(""));
    expect(items()).toEqual([]);

    document.body.innerHTML = group(item("only", "false", null));
    await tick();
    expect(tabindexes()).toEqual([0]);
    key(items()[0] as HTMLElement, "ArrowRight");
    expect(document.activeElement).toBe(items()[0]);
    items()[0]?.click();
    expect(pressed()).toEqual(["true"]);
  });

  it("becomes inert after Stimulus unload and stops observing retained DOM", async () => {
    await start();
    application?.unload("stimeo--toggle-group");
    await tick();

    items()[1]?.click();
    expect(pressed()).toEqual(["true", "false", "false"]);
    (items()[0] as HTMLButtonElement).disabled = true;
    await tick();
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("ignores lifecycle callbacks invoked after disconnect", async () => {
    await start();
    const instance = controller();
    instance.disconnect();
    items()[0]?.setAttribute("tabindex", "0");
    items()[1]?.setAttribute("tabindex", "0");

    instance.modeValueChanged();
    expect(tabindexes()).toEqual([0, 0, -1]);
  });

  it("announces the group, names, and pressed states in DOM order", async () => {
    await start();
    const phrases = await captureSpeech({ container: root(), steps: 4 });
    expect(phrases).toEqual([
      "group, Text style",
      "button, bold, pressed",
      "button, italic, not pressed",
      "button, underline, not pressed",
      "end of group, Text style",
    ]);
  });

  it("has no machine-detectable accessibility violations", async () => {
    await start();
    await expectNoA11yViolations(root());
  });

  it("declares both public events the Inspector manifest reflects", () => {
    // `static events` is a pure declaration, so no behavioral test can reach it: the
    // manifest reads it verbatim, and `stimeo check` rejects a `data-action` wired to
    // an event the emitting part does not declare.
    expect(ToggleGroupController.events).toEqual(["change", "reconcile"]);
  });

  // --- Hidden form fields ---

  describe("hidden form fields", () => {
    let commits: ReturnType<typeof captureFieldCommits>;

    const withFields = (content?: string, mode?: string, extra = "") =>
      `<div data-controller="stimeo--toggle-group" role="group" aria-label="Text style"
        ${mode ? `data-stimeo--toggle-group-mode-value="${mode}"` : ""} ${extra}>
        <div data-stimeo--toggle-group-target="fields"></div>
        ${content ?? `${item("bold", "true", 0)}${item("italic")}${item("underline")}`}
      </div>`;

    const fields = () =>
      document.querySelector<HTMLElement>(
        "[data-stimeo--toggle-group-target='fields']",
      ) as HTMLElement;
    const submitted = () =>
      [...fields().querySelectorAll("input")].map((input) => `${input.name}=${input.value}`);

    beforeEach(() => {
      commits = captureFieldCommits();
    });

    afterEach(() => {
      commits.stop();
    });

    it("seeds the pressed set under the default name without reporting a commit", async () => {
      await start(withFields());

      expect(submitted()).toEqual(["values[]=bold"]);
      expect(commits.seen).toEqual([]);
    });

    it("writes and reports once per toggle the user made", async () => {
      await start(withFields());
      commits.clear();

      items()[1]?.click();

      expect(submitted()).toEqual(["values[]=bold", "values[]=italic"]);
      expect(commits.seen).toEqual([fields()]);
    });

    it("submits at most one value in single mode", async () => {
      await start(withFields(undefined, "single"));
      commits.clear();

      items()[1]?.click();

      expect(submitted()).toEqual(["values[]=italic"]);
      expect(commits.seen).toEqual([fields()]);
    });

    it("reports an emptied set", async () => {
      await start(withFields());
      commits.clear();

      items()[0]?.click();

      expect(submitted()).toEqual([]);
      expect(commits.seen).toEqual([fields()]);
    });

    it("honors the name and form Values", async () => {
      await start(
        withFields(
          undefined,
          undefined,
          'data-stimeo--toggle-group-name-value="styles[]" data-stimeo--toggle-group-form-value="f"',
        ),
      );

      expect(submitted()).toEqual(["styles[]=bold"]);
      expect(fields().querySelector("input")?.getAttribute("form")).toBe("f");
      expect(commits.seen).toEqual([]);
    });

    it("rebuilds silently when the name changes at runtime", async () => {
      await start(withFields());
      commits.clear();

      root().setAttribute("data-stimeo--toggle-group-name-value", "styles[]");
      await tick();

      expect(submitted()).toEqual(["styles[]=bold"]);
      expect(commits.seen).toEqual([]);
    });

    it("repoints the inputs silently when the form changes at runtime", async () => {
      await start(withFields());
      commits.clear();

      root().setAttribute("data-stimeo--toggle-group-form-value", "filters");
      await tick();

      expect(fields().querySelector("input")?.getAttribute("form")).toBe("filters");
      expect(commits.seen).toEqual([]);
    });

    it("leaves an authored container alone until connect has read the pressed set", async () => {
      const records: number[] = [];
      let observer: MutationObserver | undefined;

      await start(
        `<div data-controller="stimeo--toggle-group" role="group" aria-label="Text style">
          <div data-stimeo--toggle-group-target="fields">
            <input type="hidden" name="values[]" value="bold" />
          </div>
          ${item("bold", "true", 0)}${item("italic")}
        </div>`,
        () => {
          observer = new MutationObserver((list) => records.push(list.length));
          observer.observe(fields(), { childList: true });
        },
      );
      await tick();
      observer?.disconnect();

      // Not one mutation: the authored inputs already submit the pressed set, so
      // nothing needs rewriting. A rebuild means the target callback wrote before
      // the controller knew which items it manages.
      expect(records).toEqual([]);
      expect(submitted()).toEqual(["values[]=bold"]);
    });

    it("seeds a container inserted after connect without reporting a commit", async () => {
      await start(withFields());
      fields().remove();
      commits.clear();

      const late = document.createElement("div");
      late.setAttribute("data-stimeo--toggle-group-target", "fields");
      root().append(late);
      await tick();

      expect([...late.querySelectorAll("input")].map((input) => input.value)).toEqual(["bold"]);
      expect(commits.seen).toEqual([]);
    });

    it("rebuilds without a native change when a pressed item is removed at runtime", async () => {
      await start(withFields());
      commits.clear();

      items()[0]?.remove();
      await tick();

      expect(submitted()).toEqual([]);
      expect(commits.seen).toEqual([]);
    });
  });

  // --- Page-driven moves ---

  /**
   * `change` describes one press; a pressed set the page moves — items arriving
   * or leaving, `mode`, an in-place `aria-pressed` or `data-value` write, a host
   * the group stands down on — is `reconcile` with the set it settles on, once
   * per batch and never on connect.
   */
  describe("page-driven moves", () => {
    let events: StateEventCapture;
    let commits: ReturnType<typeof captureFieldCommits>;
    const detach: Array<() => void> = [];

    const withFields = (content: string, mode?: string) =>
      `<div data-controller="stimeo--toggle-group" role="group" aria-label="Text style"
        ${mode ? `data-stimeo--toggle-group-mode-value="${mode}"` : ""}>
        <div data-stimeo--toggle-group-target="fields"></div>${content}</div>`;

    const fields = () =>
      root().querySelector<HTMLElement>(
        "[data-stimeo--toggle-group-target='fields']",
      ) as HTMLElement;
    const submitted = () =>
      [...fields().querySelectorAll("input")].map((input) => (input as HTMLInputElement).value);
    const heard = () => events.seen.map(({ name, detail }) => ({ name, detail }));

    /** Adds a document listener this block removes after the test. */
    const listenOnDocument = (type: string, listener: () => void): void => {
      document.addEventListener(type, listener);
      detach.push(() => document.removeEventListener(type, listener));
    };

    /**
     * Wraps a listener that must act once. happy-dom removes a `once` listener
     * only after it returns, so a listener that makes the same event fire again
     * would be called a second time from inside the first call.
     */
    const firstCallOnly = (act: () => void) => {
      let spent = false;
      return (): void => {
        if (spent) return;
        spent = true;
        act();
      };
    };

    beforeEach(() => {
      events = captureStateEvents("stimeo--toggle-group", ["change", "reconcile"]);
      commits = captureFieldCommits();
    });

    afterEach(() => {
      events.stop();
      commits.stop();
      for (const off of detach.splice(0)) off();
    });

    it("reports a pressed item inserted ahead in single mode as reconcile", async () => {
      await start(withFields(`${item("left", "true", 0)}${item("center")}`, "single"));

      fields().insertAdjacentHTML("afterend", item("justify", "true", null));
      await tick();

      expect(pressed()).toEqual(["true", "false", "false"]);
      expect(heard()).toEqual([{ name: "reconcile", detail: { values: ["justify"] } }]);
      expect(submitted()).toEqual(["justify"]);
      // The fields follow without the native change a form reads as an edit.
      expect(commits.seen).toEqual([]);
    });

    it("reports a pressed item leaving as reconcile", async () => {
      await start(
        withFields(`${item("bold", "true", 0)}${item("italic", "true")}${item("underline")}`),
      );

      items()[0]?.remove();
      await tick();

      expect(heard()).toEqual([{ name: "reconcile", detail: { values: ["italic"] } }]);
      expect(submitted()).toEqual(["italic"]);
      expect(commits.seen).toEqual([]);
    });

    it("reports a pressed item that stops being an item as reconcile", async () => {
      await start(withFields(`${item("bold", "true", 0)}${item("italic", "true")}`));

      // Only the target token changes, so the target callback alone sees it.
      items()[1]?.removeAttribute("data-stimeo--toggle-group-target");
      await tick();

      expect(heard()).toEqual([{ name: "reconcile", detail: { values: ["bold"] } }]);
      expect(submitted()).toEqual(["bold"]);
    });

    it("reports an element that becomes a pressed item as reconcile", async () => {
      await start(
        withFields(`${item("bold", "true", 0)}<button type="button" id="late"
          aria-pressed="true" data-value="italic">Italic</button>`),
      );

      root().querySelector("#late")?.setAttribute("data-stimeo--toggle-group-target", "item");
      await tick();

      expect(heard()).toEqual([{ name: "reconcile", detail: { values: ["bold", "italic"] } }]);
      expect(submitted()).toEqual(["bold", "italic"]);
    });

    it("reports a mode change that releases pressed items as reconcile", async () => {
      await start(
        withFields(
          `${item("bold", "true", 0)}${item("italic", "true")}${item("underline", "true")}`,
        ),
      );

      root().setAttribute("data-stimeo--toggle-group-mode-value", "single");
      await tick();

      expect(pressed()).toEqual(["true", "false", "false"]);
      expect(heard()).toEqual([{ name: "reconcile", detail: { values: ["bold"] } }]);
      expect(submitted()).toEqual(["bold"]);
    });

    it("reports an in-place press that wins first-wins, and nothing for one that loses", async () => {
      await start(
        withFields(
          `${item("left", "false", 0)}${item("center", "true")}${item("right")}`,
          "single",
        ),
      );

      // Behind the pressed item: first-wins puts it back, so the set did not move.
      items()[2]?.setAttribute("aria-pressed", "true");
      await tick();
      expect(pressed()).toEqual(["false", "true", "false"]);
      expect(heard()).toEqual([]);

      // Ahead of it: the write wins and the earlier pressed item is released.
      items()[0]?.setAttribute("aria-pressed", "true");
      await tick();
      expect(pressed()).toEqual(["true", "false", "false"]);
      expect(heard()).toEqual([{ name: "reconcile", detail: { values: ["left"] } }]);
      expect(submitted()).toEqual(["left"]);
    });

    it("reports an in-place press in multiple mode as reconcile", async () => {
      await start(withFields(`${item("bold", "true", 0)}${item("italic")}`));

      items()[1]?.setAttribute("aria-pressed", "true");
      await tick();

      expect(heard()).toEqual([{ name: "reconcile", detail: { values: ["bold", "italic"] } }]);
      expect(submitted()).toEqual(["bold", "italic"]);
    });

    it("reports a pressed item whose host the group stands down on as leaving the set", async () => {
      await start(withFields(`${item("bold", "true", 0)}${item("italic", "true")}`));

      items()[1]?.setAttribute("type", "submit");
      await tick();

      // Authored, so the group leaves the token where it is; it just stops counting it.
      expect(items()[1]?.getAttribute("aria-pressed")).toBe("true");
      expect(heard()).toEqual([{ name: "reconcile", detail: { values: ["bold"] } }]);
      expect(submitted()).toEqual(["bold"]);
    });

    it("reports a pressed item's new data-value as reconcile", async () => {
      await start(withFields(`${item("bold", "true", 0)}${item("italic")}`));

      items()[0]?.setAttribute("data-value", "strong");
      await tick();

      expect(heard()).toEqual([{ name: "reconcile", detail: { values: ["strong"] } }]);
      expect(submitted()).toEqual(["strong"]);
      expect(commits.seen).toEqual([]);
    });

    it("does not report a pass that leaves the pressed set where it was", async () => {
      await start(withFields(`${item("bold", "true", 0)}${item("italic")}${item("underline")}`));

      root().setAttribute("data-stimeo--toggle-group-name-value", "styles[]");
      root().setAttribute("data-stimeo--toggle-group-form-value", "prefs");
      await tick();
      items()[2]?.remove();
      await tick();
      items()[1]?.setAttribute("data-value", "emphasis");
      await tick();
      (items()[0] as HTMLButtonElement).disabled = true;
      await tick();

      expect(heard()).toEqual([]);
      expect(submitted()).toEqual(["bold"]);
      expect(fields().querySelector("input")?.name).toBe("styles[]");
    });

    it("reports nothing on connect, or when it connects again to a set moved while away", async () => {
      await start(withFields(`${item("left", "true", 0)}${item("center", "true")}`, "single"));
      expect(pressed()).toEqual(["true", "false"]);

      const host = root();
      const [left, center] = items(host);
      host.removeAttribute("data-controller");
      await tick();
      left?.setAttribute("aria-pressed", "false");
      center?.setAttribute("aria-pressed", "true");
      host.setAttribute("data-controller", "stimeo--toggle-group");
      await tick();

      expect(heard()).toEqual([]);
      expect(submitted()).toEqual(["center"]);
      expect(commits.seen).toEqual([]);

      // The set read on connect is the one the next move is measured from.
      left?.setAttribute("aria-pressed", "true");
      await tick();
      expect(heard()).toEqual([{ name: "reconcile", detail: { values: ["left"] } }]);
    });

    it("reports the user's press as change only", async () => {
      await start(withFields(`${item("bold", "true", 0)}${item("italic")}`));

      items()[1]?.click();
      await tick();

      expect(heard()).toEqual([
        { name: "change", detail: { value: "italic", pressed: true, values: ["bold", "italic"] } },
      ]);
      expect(commits.seen).toEqual([fields()]);
    });

    it("reports one batch of page changes once, with the set it settles on", async () => {
      await start(withFields(`${item("bold", "true", 0)}${item("italic", "true")}`));

      items()[0]?.remove();
      root().insertAdjacentHTML("beforeend", item("strike", "true", null));
      await tick();

      expect(heard()).toEqual([{ name: "reconcile", detail: { values: ["italic", "strike"] } }]);
    });

    it("reports nothing for a batch that ends on the set it started from", async () => {
      await start(withFields(`${item("bold", "true", 0)}${item("italic")}`));

      // A re-render that swaps a pressed item for an equal one moves nothing.
      items()[0]?.insertAdjacentHTML("afterend", item("bold", "true", null));
      items()[0]?.remove();
      await tick();

      expect(pressed()).toEqual(["true", "false"]);
      expect(heard()).toEqual([]);
    });

    it("keeps a press made inside a reconcile listener a change, and reports nothing after it", async () => {
      await start(withFields(`${item("bold", "true", 0)}${item("italic")}`));
      // Registered after the capture, so the recording keeps dispatch order.
      listenOnDocument(
        "stimeo--toggle-group:reconcile",
        firstCallOnly(() => items()[0]?.click()),
      );

      items()[1]?.setAttribute("aria-pressed", "true");
      await tick();
      await tick();

      expect(heard()).toEqual([
        { name: "reconcile", detail: { values: ["bold", "italic"] } },
        { name: "change", detail: { value: "bold", pressed: false, values: ["italic"] } },
      ]);
      expect(submitted()).toEqual(["italic"]);
      expect(commits.seen).toEqual([fields()]);
    });

    it("reports a press a reconcile listener writes with a second reconcile", async () => {
      await start(withFields(`${item("bold", "true", 0)}${item("italic")}${item("underline")}`));
      // The listener writes the attribute the way a page script does, not through a
      // press, so only observation can bring it to a pass.
      listenOnDocument(
        "stimeo--toggle-group:reconcile",
        firstCallOnly(() => items()[2]?.setAttribute("aria-pressed", "true")),
      );

      items()[1]?.setAttribute("aria-pressed", "true");
      await tick();
      await tick();

      // Observation resumes before the report, so the listener's write is a page
      // change of its own: the next pass reports it and the fields follow it.
      expect(heard()).toEqual([
        { name: "reconcile", detail: { values: ["bold", "italic"] } },
        { name: "reconcile", detail: { values: ["bold", "italic", "underline"] } },
      ]);
      expect(submitted()).toEqual(["bold", "italic", "underline"]);
      expect(commits.seen).toEqual([]);
    });

    it("reports a set a listener moves during the user's press as reconcile", async () => {
      await start(withFields(`${item("bold", "true", 0)}${item("italic")}${item("underline")}`));
      // The native change comes first; a page script that answers it by pressing
      // another item has moved the set after the user did.
      fields().addEventListener(
        "change",
        firstCallOnly(() => items()[2]?.setAttribute("aria-pressed", "true")),
      );

      items()[1]?.click();
      await tick();

      expect(heard()).toEqual([
        { name: "change", detail: { value: "italic", pressed: true, values: ["bold", "italic"] } },
        { name: "reconcile", detail: { values: ["bold", "italic", "underline"] } },
      ]);
      expect(submitted()).toEqual(["bold", "italic", "underline"]);
    });

    it("drops the change of a press a native change listener replaces with its own", async () => {
      await start(withFields(`${item("bold", "true", 0)}${item("italic")}`));
      fields().addEventListener(
        "change",
        firstCallOnly(() => items()[0]?.click()),
      );

      items()[1]?.click();
      await tick();
      await tick();

      // The listener's press is the newer commit and reports itself. The press it
      // replaced would describe a set that is no longer there, so it reports
      // nothing further, and no pass reports the listener's press again.
      expect(heard()).toEqual([
        { name: "change", detail: { value: "bold", pressed: false, values: ["italic"] } },
      ]);
      expect(submitted()).toEqual(["italic"]);
    });

    it("still reports a press whose native change listener only reads the fields", async () => {
      await start(withFields(`${item("bold", "true", 0)}${item("italic")}`));
      const read: string[][] = [];
      fields().addEventListener("change", () => read.push(submitted()));

      items()[1]?.click();
      await tick();

      expect(read).toEqual([["bold", "italic"]]);
      expect(heard()).toEqual([
        { name: "change", detail: { value: "italic", pressed: true, values: ["bold", "italic"] } },
      ]);
    });

    it("keeps both changes when a change listener presses again after the first went out", async () => {
      await start(withFields(`${item("bold", "true", 0)}${item("italic")}`));
      // Registered after the capture, so the recording keeps dispatch order.
      listenOnDocument(
        "stimeo--toggle-group:change",
        firstCallOnly(() => items()[0]?.click()),
      );

      items()[1]?.click();
      await tick();

      // Each change went out while the set it describes was the set on the page.
      expect(heard()).toEqual([
        { name: "change", detail: { value: "italic", pressed: true, values: ["bold", "italic"] } },
        { name: "change", detail: { value: "bold", pressed: false, values: ["italic"] } },
      ]);
      expect(submitted()).toEqual(["italic"]);
    });

    it("drops a pass queued before disconnect", async () => {
      await start(withFields(`${item("bold", "true", 0)}${item("italic", "true")}`));

      controller().modeValueChanged();
      root().setAttribute("data-stimeo--toggle-group-mode-value", "single");
      controller().disconnect();
      await tick();

      expect(pressed()).toEqual(["true", "true"]);
      expect(heard()).toEqual([]);
    });

    it("treats a pressed state the page writes before a queued pass runs as authored", async () => {
      await start(
        withFields(`<button type="button" data-value="view"
          data-stimeo--toggle-group-target="item">View</button>`),
      );
      const view = items()[0] as HTMLButtonElement;
      expect(view.getAttribute("aria-pressed")).toBe("false");

      // A pass is already queued when the page writes the attribute, so the pass
      // meets the page's record before the observer delivers it.
      controller().nameValueChanged();
      view.setAttribute("aria-pressed", "true");
      await tick();
      expect(heard()).toEqual([{ name: "reconcile", detail: { values: ["view"] } }]);

      // A host the group stands down on gives back only what the group supplied.
      view.setAttribute("type", "submit");
      await tick();
      expect(view.getAttribute("aria-pressed")).toBe("true");
      expect(heard()).toEqual([
        { name: "reconcile", detail: { values: ["view"] } },
        { name: "reconcile", detail: { values: [] } },
      ]);
    });
  });
});
