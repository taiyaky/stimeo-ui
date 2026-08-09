import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MenubarController } from "../src/controllers/menubar_controller";
import { EscapeLayer } from "../src/utils/escape_layer";
import { auditA11y, expectNoA11yViolations } from "./helpers/a11y";
import { press, typeKey } from "./helpers/keyboard";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link MenubarController}: the APG menubar — roving across
 * top items, opening menus with the keyboard, in-menu navigation/typeahead,
 * jumping to adjacent menus, and Escape/Tab/outside-click/activation closing with
 * focus returned to the owning top item.
 */

/** One `role="menuitem"` command; `attributes` injects edge-case state (disabled, hidden). */
const item = (id: string, label: string, attributes = "") => `
  <li role="none">
    <button id="${id}" role="menuitem" tabindex="-1" ${attributes}
            data-stimeo--menubar-target="item"
            data-action="click->stimeo--menubar#activate
                         keydown->stimeo--menubar#onItemKeydown">${label}</button>
  </li>`;

/**
 * One top item. Passing `null` for `menuId` builds a **plain command** — a top
 * item with no popup at all, which the markup contract allows next to
 * popup-bearing tops. It therefore carries none of the popup ARIA
 * (`aria-haspopup` / `aria-expanded` / `aria-controls`): advertising a popup it
 * does not have is exactly what the contract forbids.
 */
const top = (id: string, label: string, menuId: string | null, attributes = "") => `
  <button id="${id}" role="menuitem" ${attributes}
          ${menuId ? `aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}"` : ""}
          data-stimeo--menubar-target="top"
          data-action="click->stimeo--menubar#toggle
                       keydown->stimeo--menubar#onTopKeydown">${label}</button>`;

/** A `role="menu"` popup holding `items`; `attributes` injects state (`aria-busy`). */
const menu = (id: string, label: string, items: string, attributes = "") => `
  <ul id="${id}" role="menu" aria-label="${label}" hidden ${attributes}
      data-stimeo--menubar-target="menu">
    ${items}
  </ul>`;

const markup = `
  <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
    ${top("file", "File", "m-file")}
    ${menu("m-file", "File", `${item("new", "New")}${item("open", "Open")}${item("save", "Save")}`)}
    ${top("edit", "Edit", "m-edit")}
    ${menu("m-edit", "Edit", `${item("cut", "Cut")}${item("copy", "Copy")}${item("paste", "Paste")}`)}
  </div>`;

/** Mounts `html` and starts a Stimulus application with the controller registered. */
const mount = async (html: string): Promise<Application> => {
  document.body.innerHTML = html;
  const application = Application.start();
  application.register("stimeo--menubar", MenubarController);
  await tick();
  return application;
};

const byId = (id: string) => document.getElementById(id) as HTMLElement;
const expanded = (id: string) => byId(id).getAttribute("aria-expanded");
const menuHidden = (id: string) => byId(id).hidden;
/** The top items currently in the Tab sequence — the roving contract allows 0 or 1. */
const tabStops = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--menubar-target='top']")).filter(
    (element) => element.tabIndex === 0,
  );
/**
 * Dispatches a bubbling, **cancelable** `keydown` on an element (top item or menu
 * item alike) and returns the event. Cancelable matters: `defaultPrevented` is the
 * only observable proof that the arrow keys suppress the browser's own scrolling,
 * and a non-cancelable event would report `false` no matter what the handler does.
 */
const key = (id: string, k: string): KeyboardEvent => typeKey(byId(id), k);
/**
 * Places real DOM focus on `id` before dispatching the key: the handler then reads
 * the same `document.activeElement` a browser would, and "where did focus land"
 * becomes a meaningful assertion.
 */
const pressOn = (id: string, k: string): KeyboardEvent => press(byId(id), k);

describe("MenubarController", () => {
  let application: Application;

  beforeEach(async () => {
    application = await mount(markup);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("reverses the horizontal arrows under RTL, on the bar and inside a menu", async () => {
    // Logical direction: APG describes these as "next / previous", so the pair
    // reverses with the writing direction. `dir="rtl"` is the authoring contract,
    // but happy-dom does not resolve it into the computed style, so the direction
    // is set on the style directly.
    // Three top items, not the default two: with two, wrapping makes ArrowLeft and
    // ArrowRight land on the same item, and the case could not tell the directions
    // apart.
    disconnectAndStopApplication(application);
    application = await mount(`
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        ${top("file", "File", "m-file")}
        ${menu("m-file", "File", `${item("new", "New")}`)}
        ${top("edit", "Edit", "m-edit")}
        ${menu("m-edit", "Edit", `${item("cut", "Cut")}`)}
        ${top("view", "View", "m-view")}
        ${menu("m-view", "View", `${item("zoom", "Zoom")}`)}
      </div>`);
    (document.querySelector("[role='menubar']") as HTMLElement).style.direction = "rtl";

    pressOn("file", "ArrowLeft"); // "next" top item under RTL
    expect(document.activeElement).toBe(byId("edit"));

    pressOn("edit", "ArrowRight"); // "previous" — back, not on to "view"
    expect(document.activeElement).toBe(byId("file"));

    // Inside an open menu the pair moves to the adjacent menu; same reversal.
    byId("file").click();
    pressOn("new", "ArrowLeft");
    expect(expanded("edit")).toBe("true");
  });

  it("starts with one tab stop, menus closed", () => {
    expect(byId("file").tabIndex).toBe(0);
    expect(byId("edit").tabIndex).toBe(-1);
    expect(menuHidden("m-file")).toBe(true);
    expect(expanded("file")).toBe("false");
  });

  it("opens a menu on click and focuses the first item", () => {
    byId("file").click();
    expect(menuHidden("m-file")).toBe(false);
    expect(expanded("file")).toBe("true");
    expect(document.activeElement).toBe(byId("new"));
  });

  it("toggles the menu closed on a second click", () => {
    byId("file").click();
    byId("file").click();
    expect(menuHidden("m-file")).toBe(true);
    expect(expanded("file")).toBe("false");
  });

  it("opens with ArrowDown (first item) and ArrowUp (last item)", () => {
    key("file", "ArrowDown");
    expect(document.activeElement).toBe(byId("new"));
    byId("file").click(); // close
    key("file", "ArrowUp");
    expect(document.activeElement).toBe(byId("save"));
  });

  it("leaves Enter/Space on a top item to the native button click", () => {
    // happy-dom does not synthesize the click a browser fires for Enter/Space on a
    // <button>, so this asserts both halves: the controller consumes neither key,
    // and the click the browser would fire opens the menu at its first item.
    for (const pressed of ["Enter", " "]) {
      const event = new KeyboardEvent("keydown", { key: pressed, bubbles: true, cancelable: true });
      byId("file").dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(menuHidden("m-file")).toBe(true);

      byId("file").click();
      expect(menuHidden("m-file")).toBe(false);
      expect(document.activeElement).toBe(byId("new"));
      byId("file").click(); // back to the closed baseline for the next key
    }
  });

  it("leaves a modified arrow on a top item to the browser", () => {
    // Alt+arrow is the browser's history shortcut; the menubar must not swallow it,
    // so neither the claim nor the single Tab stop may move.
    const event = press(byId("file"), "ArrowRight", { altKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(byId("file"));
    expect(tabStops()).toEqual([byId("file")]);
    expect(menuHidden("m-edit")).toBe(true);
  });

  it("roves between top items with ArrowRight/ArrowLeft when closed", () => {
    key("file", "ArrowRight");
    expect(document.activeElement).toBe(byId("edit"));
    expect(byId("edit").tabIndex).toBe(0);
    expect(byId("file").tabIndex).toBe(-1);
    expect(menuHidden("m-edit")).toBe(true); // closed: just moves, does not open
    key("edit", "ArrowLeft");
    expect(document.activeElement).toBe(byId("file"));
  });

  it("roves to the first/last top item with Home/End when closed", () => {
    key("file", "ArrowRight"); // focus Edit
    key("edit", "Home");
    expect(document.activeElement).toBe(byId("file"));
    expect(byId("file").tabIndex).toBe(0);
    expect(menuHidden("m-file")).toBe(true); // closed: Home/End only move
    key("file", "End");
    expect(document.activeElement).toBe(byId("edit"));
    expect(byId("edit").tabIndex).toBe(0);
  });

  it("consumes the navigation keys it handles and leaves Tab to the browser", () => {
    // preventDefault is what stops the page from scrolling under the menubar. The
    // negative half matters just as much: Tab must stay uncancelled so the browser
    // performs its own move (the close is deferred to the next task instead).
    for (const pressed of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]) {
      expect(key("file", pressed).defaultPrevented).toBe(true);
      byId("file").focus(); // arrows may have moved focus/opened a menu
    }
    expect(key("file", "Tab").defaultPrevented).toBe(false);

    byId("file").click(); // focus the first item, then check the in-menu handler
    for (const pressed of ["ArrowDown", "ArrowUp", "Home", "End", "ArrowRight", "ArrowLeft"]) {
      const target = document.activeElement as HTMLElement;
      expect(key(target.id, pressed).defaultPrevented).toBe(true);
    }
    expect(key((document.activeElement as HTMLElement).id, "Tab").defaultPrevented).toBe(false);
  });

  it("closes every menu on Escape pressed on a top item, without moving focus", () => {
    byId("file").click(); // opens File, focus lands on New
    byId("file").focus(); // Shift+Tab back onto the top item, menu still open
    const press = key("file", "Escape");
    expect(menuHidden("m-file")).toBe(true);
    expect(expanded("file")).toBe("false");
    expect(document.activeElement).toBe(byId("file")); // focus stays where it was
    expect(press.defaultPrevented).toBe(true); // the layer owned and consumed it
  });

  it("closes every menu on Escape after focus fell to the body", () => {
    byId("file").click();
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);

    const press = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(press);
    expect(menuHidden("m-file")).toBe(true);
    expect(expanded("file")).toBe("false");
    expect(press.defaultPrevented).toBe(true);
  });

  it("opens the adjacent menu from a top item while a menu is open", () => {
    byId("file").click(); // open File
    byId("file").focus(); // Shift+Tab back onto the top item, menu still open
    key("file", "ArrowRight");
    expect(menuHidden("m-file")).toBe(true);
    expect(menuHidden("m-edit")).toBe(false);
    expect(document.activeElement).toBe(byId("cut"));
  });

  it("opens the first/last menu with Home/End while a menu is open", () => {
    byId("file").click();
    byId("file").focus();
    key("file", "End");
    expect(menuHidden("m-edit")).toBe(false);
    expect(document.activeElement).toBe(byId("cut"));
    byId("edit").focus();
    key("edit", "Home");
    expect(menuHidden("m-file")).toBe(false);
    expect(menuHidden("m-edit")).toBe(true);
    expect(document.activeElement).toBe(byId("new"));
  });

  it("leaves a modified arrow inside a menu to the browser", () => {
    // Same contract one level down: the open menu neither claims the chorded press
    // nor advances its roving focus.
    byId("file").click(); // open File, focus New
    const event = press(byId("new"), "ArrowDown", { altKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(byId("new"));
    expect(menuHidden("m-file")).toBe(false);
  });

  it("moves within a menu with arrows (wrapping) and Home/End", () => {
    byId("file").click(); // focus new
    key("new", "ArrowDown");
    expect(document.activeElement).toBe(byId("open"));
    key("open", "ArrowUp");
    expect(document.activeElement).toBe(byId("new"));
    key("new", "ArrowUp"); // wrap to last
    expect(document.activeElement).toBe(byId("save"));
    key("save", "ArrowDown"); // wrap to first
    expect(document.activeElement).toBe(byId("new"));
    key("new", "End");
    expect(document.activeElement).toBe(byId("save"));
    key("save", "Home");
    expect(document.activeElement).toBe(byId("new"));
  });

  it("jumps to the adjacent menu with ArrowRight/ArrowLeft inside a menu", () => {
    byId("file").click(); // open File, focus new
    key("new", "ArrowRight"); // -> open Edit, focus first
    expect(menuHidden("m-file")).toBe(true);
    expect(menuHidden("m-edit")).toBe(false);
    expect(document.activeElement).toBe(byId("cut"));
    key("cut", "ArrowLeft"); // -> wrap back to File
    expect(menuHidden("m-edit")).toBe(true);
    expect(menuHidden("m-file")).toBe(false);
    expect(document.activeElement).toBe(byId("new"));
  });

  it("activates an item: closes the menu and refocuses the top item", () => {
    byId("file").click();
    byId("new").click();
    expect(menuHidden("m-file")).toBe(true);
    expect(expanded("file")).toBe("false");
    expect(document.activeElement).toBe(byId("file"));
  });

  it("closes on Escape and returns focus to the top item", () => {
    byId("file").click();
    key("new", "Escape");
    expect(menuHidden("m-file")).toBe(true);
    expect(document.activeElement).toBe(byId("file"));
  });

  it("closes on Tab from a menu item on the next task, without pulling focus back", async () => {
    byId("file").click();
    key("new", "Tab");
    // Closing synchronously would remove the focused item before the browser's own
    // Tab move and restart traversal at the document head.
    expect(menuHidden("m-file")).toBe(false);
    await tick();
    expect(menuHidden("m-file")).toBe(true);
    // Tab closes where the user is heading; it never restores focus to the top item.
    expect(document.activeElement).not.toBe(byId("file"));
  });

  it("closes on Tab pressed on a top item while a menu is open", async () => {
    byId("file").click();
    byId("file").focus(); // Shift+Tab back onto the top item, menu still open
    key("file", "Tab");
    expect(menuHidden("m-file")).toBe(false);
    await tick();
    expect(menuHidden("m-file")).toBe(true);
  });

  it("discards a pending Tab close when a menu is reopened", async () => {
    byId("file").click();
    key("new", "Tab"); // schedules the close
    byId("edit").click(); // reopen before the task runs
    await tick();
    expect(menuHidden("m-edit")).toBe(false);
    expect(document.activeElement).toBe(byId("cut"));
  });

  it("closes on an outside click without taking focus from the clicked element", () => {
    document.body.insertAdjacentHTML("beforeend", '<button id="outside">Outside</button>');
    byId("file").click();
    const outside = byId("outside") as HTMLButtonElement;
    outside.focus();
    outside.click();
    expect(menuHidden("m-file")).toBe(true);
    expect(document.activeElement).toBe(outside);
  });

  it("stays open when a click lands inside the controller", () => {
    byId("file").click();
    byId("m-file").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menuHidden("m-file")).toBe(false);
    expect(expanded("file")).toBe("true");
  });

  it("supports typeahead within the open menu", () => {
    byId("file").click(); // focus new
    key("new", "o"); // -> Open
    expect(document.activeElement).toBe(byId("open"));
  });

  it("cycles through items sharing a first letter when the key is repeated", () => {
    byId("edit").click(); // focus Cut
    key("cut", "c"); // -> Copy
    expect(document.activeElement).toBe(byId("copy"));
    key("copy", "c"); // repeated key: cycle back to Cut, not a dead "cc" buffer
    expect(document.activeElement).toBe(byId("cut"));
  });

  it("narrows to a multi-character prefix while the buffer is fresh", () => {
    vi.useFakeTimers();
    try {
      byId("edit").click(); // focus Cut
      key("cut", "c"); // -> Copy
      expect(document.activeElement).toBe(byId("copy"));
      vi.advanceTimersByTime(400); // still under the 500ms reset
      key("copy", "u"); // buffer "cu" -> Cut (a single-char search would not move)
      expect(document.activeElement).toBe(byId("cut"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves focus alone when nothing matches the buffer", () => {
    byId("file").click(); // focus new
    key("new", "z");
    expect(document.activeElement).toBe(byId("new"));
  });

  it("does not consume Space for typeahead (leaves native button activation)", () => {
    byId("file").click(); // open File, focus New
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    byId("new").dispatchEvent(event);
    // Space must not be preventDefault-ed, so the button's native Enter/Space →
    // click activation still runs.
    expect(event.defaultPrevented).toBe(false);
  });

  it("resumes narrowing after a repeated key instead of stalling on a dead query", () => {
    vi.useFakeTimers();
    try {
      byId("edit").click(); // focus Cut
      key("cut", "c"); // -> Copy
      key("copy", "c"); // repeat: the query stays "c", cycling back to Cut
      expect(document.activeElement).toBe(byId("cut"));
      key("cut", "o"); // "co" -> Copy, not the dead "cco"
      expect(document.activeElement).toBe(byId("copy"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("matches the authored aria-label rather than the visible text", async () => {
    // The shared resolver reads the accessible name, so typeahead matches what a
    // screen reader announces.
    disconnectAndStopApplication(application);
    application = await mount(`
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        ${top("file", "File", "m-file")}
        ${menu(
          "m-file",
          "File",
          `${item("new", "New")}${item("labelled", "Open", 'aria-label="Zeta"')}${item("other", "Only")}`,
        )}
      </div>`);
    vi.useFakeTimers();
    try {
      byId("file").click(); // focus New
      key("new", "z");
      expect(document.activeElement).toBe(byId("labelled")); // "Zeta", not "Open"

      // The negative direction needs a fresh query: a second press inside the idle
      // window would search "zo", which misses under either naming rule.
      vi.advanceTimersByTime(600);
      key("labelled", "o"); // "Open" is named Zeta, so only "Only" starts with "o"
      expect(document.activeElement).toBe(byId("other"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the typeahead buffer after a pause", () => {
    vi.useFakeTimers();
    try {
      byId("file").click();
      key("new", "s"); // Save
      expect(document.activeElement).toBe(byId("save"));
      vi.advanceTimersByTime(600);
      key("save", "o"); // fresh buffer -> Open
      expect(document.activeElement).toBe(byId("open"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows items added to and removed from an open menu", async () => {
    byId("file").click();
    byId("m-file").insertAdjacentHTML("beforeend", item("archive", "Archive"));
    await tick();
    key("save", "ArrowDown"); // Save was last: the appended item is now next
    expect(document.activeElement).toBe(byId("archive"));

    byId("open").closest("li")?.remove();
    key("new", "ArrowDown"); // Open is gone: Save is next
    expect(document.activeElement).toBe(byId("save"));
    // Activation on a target that survived the mutation still closes and restores.
    byId("save").click();
    expect(menuHidden("m-file")).toBe(true);
    expect(document.activeElement).toBe(byId("file"));
  });

  it("releases the document listener, the Escape layer, and pending timers on disconnect", () => {
    vi.useFakeTimers();
    try {
      byId("file").click();
      key("new", "s"); // schedules the typeahead reset timer
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      disconnectAndStopApplication(application);

      expect(vi.getTimerCount()).toBe(0);
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(menuHidden("m-file")).toBe(false); // a surviving listener would have closed it

      const escapePress = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(escapePress);
      expect(escapePress.defaultPrevented).toBe(false); // the Escape layer is deregistered
      expect(menuHidden("m-file")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("has no machine-detectable a11y violations (closed and open)", async () => {
    const root = document.querySelector("[data-controller='stimeo--menubar']") as HTMLElement;
    await expectNoA11yViolations(root);
    byId("file").click();
    await expectNoA11yViolations(root);
  });

  it("announces the menubar and its first top item", async () => {
    const root = document.querySelector("[data-controller='stimeo--menubar']") as HTMLElement;
    const phrases = await captureSpeech({ container: root, steps: 1 });
    expect(phrases).toEqual([
      "menubar, Main, orientated horizontally",
      "menuitem, File, 1 control, not expanded, has popup menu, position 1, set size 2",
    ]);
  });

  it("announces the open menu and its items", async () => {
    byId("file").click();
    const phrases = await captureSpeech({ container: byId("m-file"), steps: 4 });
    expect(phrases).toEqual([
      "menu, File, orientated vertically",
      "menuitem, New, position 1, set size 3",
      "menuitem, Open, position 2, set size 3",
      "menuitem, Save, position 3, set size 3",
      "end of menu, File, orientated vertically",
    ]);
  });
});

describe("MenubarController with disabled and hidden entries", () => {
  let application: Application;

  beforeEach(async () => {
    // View is natively disabled and Help is aria-disabled. Under the APG rule
    // ("Disabled menu items are focusable but cannot be activated") the two are NOT
    // interchangeable: `disabled` leaves the Tab sequence and the arrow keys,
    // `aria-disabled` stays reachable and only its activation is blocked. Inside
    // File, Open (aria-disabled) is reachable while Print (disabled) and Hidden
    // (hidden) are skipped.
    application = await mount(`
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        ${top("dis-view", "View", "dis-m-view", "disabled")}
        ${menu("dis-m-view", "View", item("dis-zoom", "Zoom"))}
        ${top("dis-file", "File", "dis-m-file")}
        ${menu(
          "dis-m-file",
          "File",
          `${item("dis-new", "New")}
           ${item("dis-open", "Open", 'aria-disabled="true"')}
           ${item("dis-print", "Print", "disabled")}
           ${item("dis-hidden", "Hidden", "hidden")}
           ${item("dis-save", "Save")}`,
        )}
        ${top("dis-edit", "Edit", "dis-m-edit")}
        ${menu("dis-m-edit", "Edit", item("dis-cut", "Cut"))}
        ${top("dis-help", "Help", "dis-m-help", 'aria-disabled="true"')}
        ${menu("dis-m-help", "Help", item("dis-about", "About"))}
      </div>`);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("keeps the tab stop off a disabled top item", () => {
    // A tabindex="0" on an unfocusable button would drop the whole menubar out of
    // the Tab order. There is exactly one stop, and it is the first navigable top.
    expect(byId("dis-view").tabIndex).toBe(-1);
    expect(tabStops()).toEqual([byId("dis-file")]);
  });

  it("skips natively disabled top items when roving", () => {
    pressOn("dis-help", "ArrowRight"); // wraps past the natively disabled View
    expect(document.activeElement).toBe(byId("dis-file"));
    pressOn("dis-file", "ArrowLeft"); // backwards, also skipping View
    expect(document.activeElement).toBe(byId("dis-help"));
  });

  it("keeps aria-disabled top items reachable with the arrow keys and End", () => {
    pressOn("dis-file", "ArrowRight");
    expect(document.activeElement).toBe(byId("dis-edit"));
    pressOn("dis-edit", "ArrowRight"); // Help is aria-disabled: reachable, not skipped
    expect(document.activeElement).toBe(byId("dis-help"));
    expect(byId("dis-help").tabIndex).toBe(0);
    pressOn("dis-edit", "End");
    expect(document.activeElement).toBe(byId("dis-help")); // last navigable top
  });

  it("skips natively disabled and hidden items inside a menu", () => {
    byId("dis-file").click();
    expect(document.activeElement).toBe(byId("dis-new"));
    pressOn("dis-open", "ArrowDown"); // past Print (disabled) and Hidden (hidden)
    expect(document.activeElement).toBe(byId("dis-save"));
    pressOn("dis-save", "ArrowDown"); // wraps to the first navigable item
    expect(document.activeElement).toBe(byId("dis-new"));
  });

  it("keeps aria-disabled menu items reachable with the arrow keys", () => {
    byId("dis-file").click();
    pressOn("dis-new", "ArrowDown");
    expect(document.activeElement).toBe(byId("dis-open")); // aria-disabled, still reachable
    pressOn("dis-new", "ArrowUp"); // backwards from the first item wraps to the last
    expect(document.activeElement).toBe(byId("dis-save"));
  });

  it("blocks activation of an aria-disabled item before consumer handlers", () => {
    byId("dis-file").click();
    let consumerActivations = 0;
    byId("dis-open").addEventListener("click", () => consumerActivations++);

    byId("dis-open").click();

    expect(consumerActivations).toBe(0);
    expect(menuHidden("dis-m-file")).toBe(false); // activate() never ran either
    expect(expanded("dis-file")).toBe("true");
  });

  it("blocks activation of an aria-disabled top item", () => {
    let consumerActivations = 0;
    byId("dis-help").addEventListener("click", () => consumerActivations++);

    byId("dis-help").click();

    expect(consumerActivations).toBe(0);
    expect(menuHidden("dis-m-help")).toBe(true);
    expect(expanded("dis-help")).toBe("false");
  });

  it("never opens the menu of an aria-disabled top item with the keyboard", () => {
    // Reachable is not the same as activatable: opening the popup IS activation,
    // so the arrow keys that open a menu must do nothing here.
    expect(pressOn("dis-help", "ArrowDown").defaultPrevented).toBe(true);
    expect(menuHidden("dis-m-help")).toBe(true);
    expect(expanded("dis-help")).toBe("false");
    expect(document.activeElement).toBe(byId("dis-help"));

    expect(pressOn("dis-help", "ArrowUp").defaultPrevented).toBe(true);
    expect(menuHidden("dis-m-help")).toBe(true);
  });

  it("moves onto an aria-disabled top, closing the open menu without opening its own", () => {
    // The APG makes closing unconditional on a horizontal move ("closes the
    // submenu, moves focus to the next menubar item, and *optionally* opens that
    // item's submenu"), so only the opening half is skipped here. Leaving the old
    // menu open would strand a popup that no longer contains focus.
    byId("dis-edit").focus();
    byId("dis-edit").click(); // open Edit, focus Cut
    key("dis-cut", "ArrowRight"); // -> Help (aria-disabled)

    expect(document.activeElement).toBe(byId("dis-help"));
    expect(menuHidden("dis-m-help")).toBe(true); // never activated
    expect(menuHidden("dis-m-edit")).toBe(true);
    expect(expanded("dis-edit")).toBe("false");
    expect(tabStops()).toEqual([byId("dis-help")]);
  });

  it("removes the activation blocker on disconnect", () => {
    let consumerActivations = 0;
    byId("dis-open").addEventListener("click", () => consumerActivations++);

    disconnectAndStopApplication(application);
    byId("dis-open").click();

    expect(consumerActivations).toBe(1);
  });
});

describe("MenubarController with an existing tab stop", () => {
  let application: Application;

  beforeEach(async () => {
    // Turbo cache restore / morph: the markup comes back with the tab stop the
    // user left on the second top item.
    application = await mount(`
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        ${top("keep-file", "File", "keep-m-file", 'tabindex="-1"')}
        ${menu("keep-m-file", "File", item("keep-new", "New"))}
        ${top("keep-edit", "Edit", "keep-m-edit", 'tabindex="0"')}
        ${menu("keep-m-edit", "Edit", item("keep-cut", "Cut"))}
      </div>`);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("keeps a navigable tab stop instead of resetting it to the first top item", () => {
    expect(byId("keep-edit").tabIndex).toBe(0);
    expect(byId("keep-file").tabIndex).toBe(-1);
    expect(menuHidden("keep-m-edit")).toBe(true);
  });
});

describe("MenubarController with top items that resolve no menu", () => {
  let application: Application;

  beforeEach(async () => {
    // Gone points at an id that does not exist (broken markup); Help is a plain
    // command (a legitimate top item that simply has no popup).
    application = await mount(`
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        ${top("nm-file", "File", "nm-m-file")}
        ${menu("nm-m-file", "File", `${item("nm-new", "New")}${item("nm-save", "Save")}`)}
        ${top("nm-gone", "Gone", "nm-missing")}
        ${top("nm-help", "Help", null)}
      </div>`);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("leaves a plain command free of every popup attribute", () => {
    // Advertising a popup it does not have is the failure this contract prevents:
    // a screen reader would announce "has popup menu, collapsed" for a command.
    expect(byId("nm-help").hasAttribute("aria-expanded")).toBe(false);
    expect(byId("nm-help").hasAttribute("aria-haspopup")).toBe(false);
    expect(byId("nm-help").hasAttribute("aria-controls")).toBe(false);
  });

  it("moves to a plain command from an open menu, closing that menu", () => {
    byId("nm-file").focus();
    byId("nm-file").click(); // open File, focus New
    key("nm-new", "ArrowLeft"); // wraps to Help, the last top: a plain command

    expect(document.activeElement).toBe(byId("nm-help"));
    expect(menuHidden("nm-m-file")).toBe(true);
    expect(expanded("nm-file")).toBe("false");
    expect(tabStops()).toEqual([byId("nm-help")]);
  });

  it("moves to a plain command from a top item while closed", () => {
    pressOn("nm-file", "ArrowLeft"); // wraps to Help
    expect(document.activeElement).toBe(byId("nm-help"));
    expect(tabStops()).toEqual([byId("nm-help")]);
  });

  it("closes the open menu when a plain command is clicked", () => {
    byId("nm-file").focus();
    byId("nm-file").click();
    byId("nm-help").click();

    expect(menuHidden("nm-m-file")).toBe(true);
    expect(expanded("nm-file")).toBe("false");
    expect(document.activeElement).toBe(byId("nm-help"));
  });

  it("still roves onto a dangling top while nothing is open", () => {
    // The "leave everything untouched" contract is about the *open a menu* path.
    // With no menu open there is nothing to protect, and a top item that is a
    // target is an ordinary roving destination.
    pressOn("nm-file", "ArrowRight");
    expect(document.activeElement).toBe(byId("nm-gone"));
    expect(tabStops()).toEqual([byId("nm-gone")]);
    expect(expanded("nm-gone")).toBe("false");
  });

  it("keeps the open menu and focus when a sideways move resolves no menu", () => {
    // A *dangling* `aria-controls` is broken markup, not a plain command: the
    // contract is to leave the open/closed state and focus untouched.
    byId("nm-file").click();
    expect(document.activeElement).toBe(byId("nm-new"));

    key("nm-new", "ArrowRight"); // -> Gone, whose aria-controls resolves to nothing

    expect(menuHidden("nm-m-file")).toBe(false);
    expect(expanded("nm-file")).toBe("true");
    expect(document.activeElement).toBe(byId("nm-new"));
  });

  it("keeps the open menu when a dangling aria-controls top is activated", () => {
    byId("nm-file").click();
    byId("nm-gone").click();
    expect(menuHidden("nm-m-file")).toBe(false);
    expect(expanded("nm-gone")).toBe("false");
  });
});

describe("MenubarController with menus that hold no navigable item", () => {
  let application: Application;

  beforeEach(async () => {
    // Two shapes that look alike but are different contracts.
    //
    // Empty: a menu a consumer streams items into later. It still opens —
    // swallowing the click would leave it permanently unopenable — and while its
    // required owned `menuitem`s are absent the consumer MUST mark it
    // `aria-busy="true"` (WAI-ARIA "Required Owned Elements"). The controller
    // never infers that state; it cannot tell "still loading" from "nothing to
    // show".
    //
    // Inert: real menuitems exist, they are simply unavailable, so the menu is
    // NOT busy. Both leave focus on the top item because there is nothing to
    // move it to.
    application = await mount(`
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        ${top("ne-empty", "Empty", "ne-m-empty")}
        ${menu("ne-m-empty", "Empty", "", 'aria-busy="true"')}
        ${top("ne-inert", "Inert", "ne-m-inert")}
        ${menu(
          "ne-m-inert",
          "Inert",
          `${item("ne-off", "Off", "disabled")}
           ${item("ne-gone", "Gone", "hidden")}`,
        )}
      </div>`);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("opens an empty menu on click and keeps focus on its top item", () => {
    byId("ne-empty").focus();
    byId("ne-empty").click();
    expect(menuHidden("ne-m-empty")).toBe(false);
    expect(expanded("ne-empty")).toBe("true");
    expect(document.activeElement).toBe(byId("ne-empty"));
  });

  it("opens an empty menu with ArrowDown/ArrowUp without moving focus", () => {
    pressOn("ne-empty", "ArrowDown");
    expect(menuHidden("ne-m-empty")).toBe(false);
    expect(document.activeElement).toBe(byId("ne-empty"));

    byId("ne-empty").click(); // back to closed
    pressOn("ne-empty", "ArrowUp");
    expect(menuHidden("ne-m-empty")).toBe(false);
    expect(document.activeElement).toBe(byId("ne-empty"));
  });

  it("closes an open empty menu on Escape and on a second click", () => {
    byId("ne-empty").focus();
    byId("ne-empty").click();
    key("ne-empty", "Escape");
    expect(menuHidden("ne-m-empty")).toBe(true);
    expect(expanded("ne-empty")).toBe("false");
    expect(document.activeElement).toBe(byId("ne-empty"));

    byId("ne-empty").click();
    expect(menuHidden("ne-m-empty")).toBe(false);
    byId("ne-empty").click();
    expect(menuHidden("ne-m-empty")).toBe(true);
    expect(expanded("ne-empty")).toBe("false");
  });

  it("opens a menu whose every item is inert, leaving arrows inside it inert too", () => {
    byId("ne-inert").focus();
    byId("ne-inert").click();
    expect(menuHidden("ne-m-inert")).toBe(false);
    expect(expanded("ne-inert")).toBe("true");
    expect(document.activeElement).toBe(byId("ne-inert"));

    // The arrows are still consumed (the menubar owns them) but find no target.
    expect(key("ne-inert", "ArrowDown").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId("ne-inert"));
  });

  it("clears the required-children review on an open empty menu while it is busy", async () => {
    // `role="menu"` must own `menuitem`s. Opened empty and *not* marked busy, axe
    // holds `aria-required-children` back for human review; `aria-busy="true"` is
    // what says "they are on their way" and settles it. Scoped to that one rule
    // id because happy-dom leaves unrelated rules (colour contrast, url-valued
    // attributes) incomplete by construction, so a blanket assertion would be
    // asserting a happy-dom property rather than this contract.
    const root = document.querySelector("[data-controller='stimeo--menubar']") as HTMLElement;
    byId("ne-empty").focus();
    byId("ne-empty").click();

    expect(byId("ne-m-empty").getAttribute("aria-busy")).toBe("true");
    await expectNoA11yViolations(root);
    const results = await auditA11y(root);
    expect(results.incomplete.map((result) => result.id)).not.toContain("aria-required-children");
  });

  it("needs no aria-busy on a menu whose items exist but are all inert", async () => {
    const root = document.querySelector("[data-controller='stimeo--menubar']") as HTMLElement;
    byId("ne-inert").focus();
    byId("ne-inert").click();

    expect(byId("ne-m-inert").hasAttribute("aria-busy")).toBe(false);
    await expectNoA11yViolations(root);
    const results = await auditA11y(root);
    expect(results.incomplete.map((result) => result.id)).not.toContain("aria-required-children");
  });

  it("navigates the items a consumer streams into a busy menu", async () => {
    byId("ne-empty").focus();
    byId("ne-empty").click();

    byId("ne-m-empty").insertAdjacentHTML("beforeend", item("ne-late", "Late"));
    byId("ne-m-empty").removeAttribute("aria-busy"); // the consumer's other half
    await tick();

    pressOn("ne-empty", "ArrowDown"); // reopens at the first item, which now exists
    expect(document.activeElement).toBe(byId("ne-late"));
    expect(menuHidden("ne-m-empty")).toBe(false);
  });
});

describe("MenubarController under runtime DOM changes", () => {
  let application: Application;

  beforeEach(async () => {
    application = await mount(`
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        ${top("rt-file", "File", "rt-m-file")}
        ${menu("rt-m-file", "File", `${item("rt-new", "New")}${item("rt-save", "Save")}`)}
        ${top("rt-edit", "Edit", "rt-m-edit")}
        ${menu("rt-m-edit", "Edit", item("rt-cut", "Cut"))}
        ${top("rt-view", "View", "rt-m-view")}
        ${menu("rt-m-view", "View", item("rt-zoom", "Zoom"))}
      </div>`);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  /** Dispatches an Escape at the document and reports whether a layer owned it. */
  const escapeConsumed = (): boolean => {
    const press = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(press);
    return press.defaultPrevented;
  };

  it("hands the tab stop on when the top item holding it is disabled at runtime", async () => {
    expect(tabStops()).toEqual([byId("rt-file")]);

    (byId("rt-file") as HTMLButtonElement).disabled = true;
    await tick();

    // An unfocusable tabindex="0" would drop the whole menubar out of the Tab order.
    expect(tabStops()).toEqual([byId("rt-edit")]);
  });

  it("hands the tab stop on when the top item holding it is hidden at runtime", async () => {
    byId("rt-file").setAttribute("hidden", "");
    await tick();
    expect(tabStops()).toEqual([byId("rt-edit")]);
  });

  it("keeps no tab stop while every top is inert, and recovers when one comes back", async () => {
    for (const id of ["rt-file", "rt-edit", "rt-view"]) {
      (byId(id) as HTMLButtonElement).disabled = true;
    }
    await tick();
    expect(tabStops()).toEqual([]);

    (byId("rt-edit") as HTMLButtonElement).disabled = false;
    await tick();
    expect(tabStops()).toEqual([byId("rt-edit")]);
  });

  it("keeps exactly one tab stop when a top item is added at runtime", async () => {
    // A fresh <button> is tabbable by default, which would make the menubar two
    // Tab stops — and the authored one must not move.
    byId("rt-view").insertAdjacentHTML("afterend", top("rt-help", "Help", "rt-m-help"));
    byId("rt-view").insertAdjacentHTML(
      "afterend",
      menu("rt-m-help", "Help", item("rt-faq", "FAQ")),
    );
    await tick();

    expect(tabStops()).toEqual([byId("rt-file")]);
    expect(byId("rt-help").tabIndex).toBe(-1);
  });

  it("keeps the tab stop when a top item is prepended at runtime", async () => {
    // A top inserted *before* the current stop is the case a "is anything
    // tabbable?" check cannot see: the fresh <button> is tabbable by default and
    // comes first in DOM order, so it would silently become the entry point.
    key("rt-file", "ArrowRight"); // move the stop to Edit first
    expect(tabStops()).toEqual([byId("rt-edit")]);

    byId("rt-file").insertAdjacentHTML("beforebegin", top("rt-help", "Help", "rt-m-help"));
    byId("rt-file").insertAdjacentHTML(
      "beforebegin",
      menu("rt-m-help", "Help", item("rt-faq", "FAQ")),
    );
    await tick();

    expect(tabStops()).toEqual([byId("rt-edit")]);
    expect(byId("rt-help").tabIndex).toBe(-1);
  });

  it("hands the tab stop on when the top item holding it is removed", async () => {
    byId("rt-file").remove();
    await tick();
    expect(tabStops()).toEqual([byId("rt-edit")]);
  });

  it("collapses the owner when an open menu target is replaced by a fresh one", async () => {
    // A Turbo Stream `replace` removes the menu and inserts a new element with the
    // same id, carrying the contract's `hidden`. The replacement still *resolves*,
    // so "did the menu disappear?" is not enough to notice that the top is now
    // claiming a popup nobody can see — and that it still owns the Escape layer.
    byId("rt-file").focus();
    byId("rt-file").click();
    expect(expanded("rt-file")).toBe("true");

    byId("rt-m-file").outerHTML = menu("rt-m-file", "File", item("rt-fresh", "Fresh"));
    await tick();

    expect(expanded("rt-file")).toBe("false");
    expect(menuHidden("rt-m-file")).toBe(true);
    expect(escapeConsumed()).toBe(false);

    // And the menubar is still operable: the top reopens onto the new items.
    byId("rt-file").click();
    expect(menuHidden("rt-m-file")).toBe(false);
    expect(document.activeElement).toBe(byId("rt-fresh"));
  });

  it("cleans up a top item that leaves by losing only its target token", async () => {
    // A morph can drop `data-*-target` without removing the node. Stimulus reports
    // the disconnect, but the element stays in the page — still carrying this
    // controller's `tabindex="0"` (a second Tab stop) and an `aria-expanded="true"`
    // that nothing can collapse any more.
    byId("rt-file").focus();
    byId("rt-file").click();
    expect(expanded("rt-file")).toBe("true");

    byId("rt-file").removeAttribute("data-stimeo--menubar-target");
    await tick();

    expect(byId("rt-file").tabIndex).toBe(-1);
    expect(expanded("rt-file")).toBe("false");
    expect(menuHidden("rt-m-file")).toBe(true);
    expect(tabStops()).toEqual([byId("rt-edit")]); // exactly one, on a live target
    expect(escapeConsumed()).toBe(false);
  });

  it("closes a menu that leaves by losing only its target token", async () => {
    byId("rt-file").focus();
    byId("rt-file").click();

    byId("rt-m-file").removeAttribute("data-stimeo--menubar-target");
    await tick();

    // Left visible it would be a popup no key and no click can dismiss.
    expect(menuHidden("rt-m-file")).toBe(true);
    expect(expanded("rt-file")).toBe("false");
    expect(escapeConsumed()).toBe(false);
  });

  it.each([
    ["hidden", (top: HTMLElement) => top.setAttribute("hidden", "")],
    ["disabled", (top: HTMLElement) => ((top as HTMLButtonElement).disabled = true)],
  ])("collapses an expanded top item that becomes %s at runtime", async (_label, makeInert) => {
    // The owner going out of reach strands its popup: still on screen, with no
    // focusable element left that owns it.
    byId("rt-file").focus();
    byId("rt-file").click();
    expect(expanded("rt-file")).toBe("true");

    makeInert(byId("rt-file"));
    await tick();

    expect(expanded("rt-file")).toBe("false");
    expect(menuHidden("rt-m-file")).toBe(true);
    expect(escapeConsumed()).toBe(false);
    expect(tabStops()).toEqual([byId("rt-edit")]);
  });

  it("takes Escape ownership for a menu a morph opened in place", async () => {
    // The DOM is this controller's only source of truth, so a morph that patches
    // `aria-expanded` and `hidden` directly really has opened the menu — and the
    // menubar has to be on the Escape stack for it, or the popup cannot be closed
    // by keyboard at all.
    byId("rt-file").setAttribute("aria-expanded", "true");
    byId("rt-m-file").hidden = false;
    await tick();

    byId("rt-new").focus();
    expect(key("rt-new", "Escape").defaultPrevented).toBe(true);
    expect(menuHidden("rt-m-file")).toBe(true);
    expect(expanded("rt-file")).toBe("false");
    expect(document.activeElement).toBe(byId("rt-file"));
  });

  it("registers the Escape layer once across unrelated mutations", async () => {
    // Re-activating an active layer moves it to the top of the shared stack, so a
    // mutation that changes nothing about the open state must not re-register.
    byId("rt-file").focus();
    byId("rt-file").click();

    const outer = new EscapeLayer();
    try {
      outer.activate(document, { onDismiss: () => {} });
      byId("rt-m-file").insertAdjacentHTML("beforeend", item("rt-extra", "Extra"));
      await tick();

      // The menubar opened first, so the later layer still owns the press.
      expect(outer.ownsEscape).toBe(true);
    } finally {
      // The stack is per-document and outlives this test; a leak here would make
      // the *next* test's Escape assertions read another layer's decision.
      outer.deactivate();
    }
  });

  it("collapses the owner and releases Escape when an open menu target is removed", async () => {
    byId("rt-file").focus();
    byId("rt-file").click(); // open File, focus New
    expect(expanded("rt-file")).toBe("true");

    byId("rt-m-file").remove();
    await tick();

    expect(expanded("rt-file")).toBe("false"); // no popup left to be expanded
    expect(escapeConsumed()).toBe(false); // the Escape layer is no longer registered
  });

  it("hides an orphaned menu and releases Escape when its top item is removed", async () => {
    byId("rt-file").focus();
    byId("rt-file").click();

    byId("rt-file").remove();
    await tick();

    // Nothing can close a menu whose owner is gone, so it must not stay visible.
    expect(menuHidden("rt-m-file")).toBe(true);
    expect(escapeConsumed()).toBe(false);
    expect(tabStops()).toEqual([byId("rt-edit")]);
  });

  it("returns focus to the menubar when the focused top item is removed", async () => {
    byId("rt-file").focus();

    byId("rt-file").remove();
    await tick();

    // The tab stop moved on, and focus follows it rather than falling to <body>,
    // which would put the keyboard user back at the top of the document.
    expect(tabStops()).toEqual([byId("rt-edit")]);
    expect(document.activeElement).toBe(byId("rt-edit"));
  });

  it("returns focus to the owning top when the open menu holding focus is removed", async () => {
    byId("rt-file").focus();
    byId("rt-file").click(); // open File, focus New
    expect(document.activeElement).toBe(byId("rt-new"));

    byId("rt-m-file").remove();
    await tick();

    expect(expanded("rt-file")).toBe("false");
    expect(document.activeElement).toBe(byId("rt-file"));
  });

  it("returns focus to the menubar when the top item holding an open menu is hidden", async () => {
    byId("rt-file").focus();
    byId("rt-file").click(); // open File, focus New
    expect(document.activeElement).toBe(byId("rt-new"));

    byId("rt-file").setAttribute("hidden", "");
    await tick();

    // The menu comes down with its owner, and focus leaves before the element
    // that holds it becomes unreachable — a browser blurs a hidden element only
    // on its next style pass, which is too late to react to.
    expect(menuHidden("rt-m-file")).toBe(true);
    expect(document.activeElement).toBe(byId("rt-edit"));
  });

  it("does not pull focus back when it is already somewhere else", async () => {
    const outside = document.createElement("button");
    outside.id = "rt-outside";
    document.body.appendChild(outside);
    byId("rt-file").focus();
    outside.focus();

    byId("rt-file").remove();
    await tick();

    // The mutation made an element unreachable, but focus was never lost, so
    // moving it would be a steal rather than a rescue.
    expect(document.activeElement).toBe(outside);
  });

  it("leaves an open menu alone while unrelated items change", async () => {
    byId("rt-file").focus();
    byId("rt-file").click();

    byId("rt-m-file").insertAdjacentHTML("beforeend", item("rt-archive", "Archive"));
    await tick();

    expect(menuHidden("rt-m-file")).toBe(false);
    expect(expanded("rt-file")).toBe("true");
    expect(escapeConsumed()).toBe(true); // still owned while open
  });
});

describe("MenubarController yielding a key a descendant already consumed", () => {
  let application: Application;

  beforeEach(async () => {
    // A nested widget (an inline editor, a grabbed drag handle) inside a top item
    // or a menu item that already called preventDefault must not ALSO move the
    // menubar's roving focus.
    application = await mount(`
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        <button id="dp-file" role="menuitem" aria-haspopup="menu" aria-expanded="false"
                aria-controls="dp-m-file" data-stimeo--menubar-target="top"
                data-action="click->stimeo--menubar#toggle
                             keydown->stimeo--menubar#onTopKeydown">File <span id="dp-top-inner">*</span></button>
        <ul id="dp-m-file" role="menu" aria-label="File" hidden data-stimeo--menubar-target="menu">
          <li role="none">
            <button id="dp-new" role="menuitem" tabindex="-1" data-stimeo--menubar-target="item"
                    data-action="click->stimeo--menubar#activate
                                 keydown->stimeo--menubar#onItemKeydown">New <span id="dp-item-inner">*</span></button>
          </li>
          <li role="none">
            <button id="dp-open" role="menuitem" tabindex="-1" data-stimeo--menubar-target="item"
                    data-action="click->stimeo--menubar#activate
                                 keydown->stimeo--menubar#onItemKeydown">Open</button>
          </li>
        </ul>
        ${top("dp-edit", "Edit", "dp-m-edit")}
        ${menu("dp-m-edit", "Edit", item("dp-cut", "Cut"))}
      </div>`);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("does not rove the top items on a key the descendant consumed", () => {
    byId("dp-file").focus();
    byId("dp-top-inner").addEventListener("keydown", (event) => event.preventDefault());

    byId("dp-top-inner").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );

    expect(document.activeElement).toBe(byId("dp-file"));
    expect(tabStops()).toEqual([byId("dp-file")]);
    expect(menuHidden("dp-m-edit")).toBe(true);
  });

  it("does not move inside the menu on a key the descendant consumed", () => {
    byId("dp-file").focus();
    byId("dp-file").click(); // open, focus New
    byId("dp-item-inner").addEventListener("keydown", (event) => event.preventDefault());

    byId("dp-item-inner").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );

    expect(document.activeElement).toBe(byId("dp-new"));
  });
});

describe("MenubarController outside-click detection", () => {
  let application: Application;

  beforeEach(async () => {
    // The menu holds a non-item element a consumer handler can remove on click —
    // the case that makes the *bubble* phase wrong for outside-click detection,
    // so the listener runs in the capture phase.
    application = await mount(`
      <div data-controller="stimeo--menubar" role="menubar" aria-label="Main">
        ${top("ph-file", "File", "ph-m-file")}
        <ul id="ph-m-file" role="menu" aria-label="File" hidden data-stimeo--menubar-target="menu">
          ${item("ph-new", "New")}
          <li role="none"><span id="ph-volatile">Dismiss the banner</span></li>
        </ul>
      </div>`);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("keeps the menu open when an inside click handler removes its own target", () => {
    byId("ph-file").focus();
    byId("ph-file").click();
    const volatileNode = byId("ph-volatile");
    volatileNode.addEventListener("click", () => volatileNode.remove());

    volatileNode.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // In the bubble phase the document listener runs *after* the node left the
    // DOM, so `element.contains(event.target)` is false and an inside click
    // closes the menu. Capture observes the click before anything can move it.
    expect(menuHidden("ph-m-file")).toBe(false);
    expect(expanded("ph-file")).toBe("true");
  });
});

describe("Multiple menubars on one page", () => {
  let application: Application;

  /** A single-menu menubar whose ids are namespaced by `prefix`. */
  const instance = (prefix: string) => `
    <div data-controller="stimeo--menubar" role="menubar" aria-label="${prefix}">
      ${top(`${prefix}-file`, "File", `${prefix}-m-file`)}
      ${menu(
        `${prefix}-m-file`,
        "File",
        `${item(`${prefix}-new`, "New")}${item(`${prefix}-save`, "Save")}`,
      )}
    </div>`;

  beforeEach(async () => {
    application = await mount(`${instance("a")}${instance("b")}`);
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("opens only the menu of the instance that was operated", () => {
    byId("a-file").click();
    expect(menuHidden("a-m-file")).toBe(false);
    expect(menuHidden("b-m-file")).toBe(true);
    expect(expanded("b-file")).toBe("false");
    expect(byId("b-file").tabIndex).toBe(0); // its own tab stop is untouched
  });

  it("closes the open instance and opens the clicked one", () => {
    // The trade-off of capture-phase outside-click detection: the document listener
    // runs *before* the clicked trigger's own handler, so the close must not swallow
    // the open that follows it.
    byId("a-file").focus();
    byId("a-file").click();
    byId("b-file").focus();
    byId("b-file").click();

    expect(menuHidden("a-m-file")).toBe(true);
    expect(expanded("a-file")).toBe("false");
    expect(menuHidden("b-m-file")).toBe(false);
    expect(document.activeElement).toBe(byId("b-new"));
  });

  it("closes only the instance the Escape was pressed in", () => {
    byId("a-file").click();
    key("a-new", "Escape");
    expect(menuHidden("a-m-file")).toBe(true);
    expect(document.activeElement).toBe(byId("a-file"));

    byId("b-file").click(); // the other instance still works independently
    expect(menuHidden("b-m-file")).toBe(false);
    expect(menuHidden("a-m-file")).toBe(true);
    key("b-new", "Escape");
    expect(menuHidden("b-m-file")).toBe(true);
    expect(document.activeElement).toBe(byId("b-file"));
  });
});
