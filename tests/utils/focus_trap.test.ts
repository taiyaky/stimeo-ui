import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EscapeLayer } from "../../src/utils/escape_layer";
import { FocusTrap, type FocusTrapOptions } from "../../src/utils/focus_trap";
import { withinTimeLimit } from "../helpers/time_limit";
import { flushMicrotasks } from "../helpers/timing";

/**
 * Unit tests for the {@link FocusTrap} primitive: the shared modal lifecycle
 * (scroll lock, background `inert`, Tab handling, Escape delegation, focus
 * restore) that dialog / alert-dialog / drawer build on.
 */
describe("FocusTrap", () => {
  let container: HTMLElement;
  let traps: FocusTrap[];

  beforeEach(() => {
    traps = [];
    document.body.innerHTML = `
      <p id="background">Background</p>
      <button id="opener">Open</button>
      <div id="box">
        <button id="first">First</button>
        <button id="last">Last</button>
      </div>`;
    container = document.getElementById("box") as HTMLElement;
  });

  afterEach(() => {
    for (const activeTrap of traps) activeTrap.deactivate({ restoreFocus: false });
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  const trap = (options: FocusTrapOptions = {}) => {
    const instance = new FocusTrap(() => container, options);
    traps.push(instance);
    return instance;
  };
  const byId = (id: string) => document.getElementById(id) as HTMLElement;

  it("locks body scroll and isolates background siblings on activate", () => {
    const t = trap();
    t.activate();
    expect(t.active).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    expect(byId("background").inert).toBe(true);
    expect(byId("opener").inert).toBe(true);
  });

  it("moves focus to the first focusable element on activate", () => {
    trap().activate();
    expect(document.activeElement).toBe(byId("first"));
  });

  it("uses the shared Tab-stop rules when choosing initial focus", () => {
    container.innerHTML = `
      <fieldset disabled><button id="blocked">Blocked</button></fieldset>
      <div id="editor" contenteditable>Edit</div>
      <details><summary id="summary">More</summary></details>`;

    trap().activate();

    expect(document.activeElement).toBe(byId("editor"));
  });

  it("prefers the initialFocus element when provided", () => {
    trap({ initialFocus: () => byId("last") }).activate();
    expect(document.activeElement).toBe(byId("last"));
  });

  it("falls back to the container itself when it has no focusable children", () => {
    container.innerHTML = "Just text";
    trap().activate();
    expect(document.activeElement).toBe(container);
    expect(container.getAttribute("tabindex")).toBe("-1");
  });

  it("restores scroll, background, and focus on deactivate", () => {
    byId("opener").focus();
    const t = trap();
    t.activate();
    t.deactivate();
    expect(t.active).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(byId("background").inert).toBe(false);
    expect(document.activeElement).toBe(byId("opener"));
  });

  it("uses fallbackFocus when nothing was focused before activation", () => {
    // Nothing is focused before activate (body), so the fallback is used on close.
    const t = trap({ fallbackFocus: () => byId("opener") });
    t.activate();
    t.deactivate();
    expect(document.activeElement).toBe(byId("opener"));
  });

  it("prefers the opener over fallbackFocus while the opener can take focus", () => {
    document.body.insertAdjacentHTML("beforeend", '<button id="fallback">Fallback</button>');
    byId("opener").focus();
    const t = trap({ fallbackFocus: () => byId("fallback") });
    t.activate();
    t.deactivate();
    expect(document.activeElement).toBe(byId("opener"));
  });

  it.each([
    ["hidden", (opener: HTMLElement) => opener.setAttribute("hidden", "")],
    ["removed", (opener: HTMLElement) => opener.remove()],
  ])("uses fallbackFocus when the opener is %s by the time the trap is released", (_, leave) => {
    document.body.insertAdjacentHTML("beforeend", '<button id="fallback">Fallback</button>');
    const opener = byId("opener");
    opener.focus();
    const t = trap({ fallbackFocus: () => byId("fallback") });
    t.activate();
    leave(opener);
    t.deactivate();
    expect(document.activeElement).toBe(byId("fallback"));
  });

  it("leaves focus on the opener when it already holds focus at release", () => {
    // A soft trap lets focus return to the opener before the release.
    document.body.insertAdjacentHTML("beforeend", '<button id="fallback">Fallback</button>');
    byId("opener").focus();
    const t = trap({ isolate: false, fallbackFocus: () => byId("fallback") });
    t.activate();
    byId("opener").focus();
    t.deactivate();
    expect(document.activeElement).toBe(byId("opener"));
  });

  it("moves on to fallbackFocus when focusing the opener leaves focus where it was", () => {
    document.body.insertAdjacentHTML("beforeend", '<button id="fallback">Fallback</button>');
    byId("opener").focus();
    const t = trap({ fallbackFocus: () => byId("fallback") });
    t.activate();
    vi.spyOn(byId("opener"), "focus").mockImplementation(() => {});
    t.deactivate();
    expect(document.activeElement).toBe(byId("fallback"));
  });

  it("keeps a restoring focus move a listener redirects", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<button id="fallback">Fallback</button><button id="elsewhere">Elsewhere</button>',
    );
    byId("opener").focus();
    const t = trap({ fallbackFocus: () => byId("fallback") });
    t.activate();
    byId("opener").addEventListener("focus", () => byId("elsewhere").focus(), { once: true });
    t.deactivate();
    expect(document.activeElement).toBe(byId("elsewhere"));
  });

  it("does not restore focus when deactivated with restoreFocus: false", () => {
    byId("opener").focus();
    const t = trap();
    t.activate();
    t.deactivate({ restoreFocus: false });
    // Focus is left wherever it was (the first item), not yanked back to opener.
    expect(document.activeElement).not.toBe(byId("opener"));
  });

  it("cycles Tab from the last focusable back to the first", () => {
    const t = trap();
    t.activate();
    byId("last").focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(byId("first"));
  });

  it("cycles Shift+Tab from the first focusable to the last", () => {
    const t = trap();
    t.activate();
    byId("first").focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }));
    expect(document.activeElement).toBe(byId("last"));
  });

  it("pulls focus back inside when it has escaped the container, at the end the press faces", () => {
    // A soft trap leaves the opener focusable; an isolated one would refuse the focus.
    const t = trap({ isolate: false });
    t.activate();
    byId("opener").focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(byId("first"));

    byId("opener").focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }));
    expect(document.activeElement).toBe(byId("last"));
  });

  it("invokes onEscape and prevents the handled Escape", () => {
    let escapes = 0;
    const t = trap({ onEscape: () => escapes++ });
    t.activate();
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    document.dispatchEvent(event);
    expect(escapes).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves Escape alone when no onEscape callback is provided", () => {
    const t = trap();
    t.activate();
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });

    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(t.active).toBe(true);
  });

  it("does not handle Escape already consumed by a nested component", () => {
    let escapes = 0;
    const t = trap({ onEscape: () => escapes++ });
    t.activate();
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    event.preventDefault();

    document.dispatchEvent(event);

    expect(escapes).toBe(0);
    expect(t.active).toBe(true);
  });

  it("lets the most recently activated trap own Escape", () => {
    let outerEscapes = 0;
    let innerEscapes = 0;
    const flags = { lockScroll: false, isolate: false, autoFocus: false };
    const outer = trap({ ...flags, onEscape: () => outerEscapes++ });
    const inner = trap({
      ...flags,
      onEscape: () => {
        innerEscapes++;
        inner.deactivate({ restoreFocus: false });
      },
    });
    outer.activate();
    inner.activate();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(innerEscapes).toBe(1);
    expect(outerEscapes).toBe(0);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(outerEscapes).toBe(1);
  });

  it("leaves Escape ownership to lower layers when it has no onEscape", () => {
    let escapes = 0;
    const flags = { lockScroll: false, isolate: false, autoFocus: false };
    const owner = trap({ ...flags, onEscape: () => escapes++ });
    const silent = trap(flags); // no onEscape — must never join the Escape stack
    owner.activate();
    silent.activate();

    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    document.dispatchEvent(event);

    // The silent trap neither consumes the press nor blocks the layer below it.
    expect(escapes).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps trapping Tab while a newer document layer owns Escape", () => {
    let escapes = 0;
    let aboveDismissed = 0;
    const t = trap({ onEscape: () => escapes++ });
    t.activate();
    const above = new EscapeLayer();
    above.activate(document, { onDismiss: () => aboveDismissed++ });

    // Escape belongs to the newer layer: the shared resolver consumes the press
    // and dismisses it, never the trap below …
    const escapePress = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    document.dispatchEvent(escapePress);
    expect(escapes).toBe(0);
    expect(aboveDismissed).toBe(1);
    expect(escapePress.defaultPrevented).toBe(true);

    // … but the Tab cycle is owned by trap activation, not Escape ownership.
    byId("last").focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId("first"));

    above.deactivate();
  });

  it("isolates the background beside a nested container too", () => {
    // The container is normally nested, and everything beside it inside that
    // branch is background just as much as a top-level sibling is. Scanning only
    // `body`'s children would skip the whole branch the container sits in.
    document.body.innerHTML = `
      <div id="far">far</div>
      <main id="main">
        <div id="near">near</div>
        <div id="box"><button id="first">First</button><button id="last">Last</button></div>
      </main>`;
    container = document.getElementById("box") as HTMLElement;

    const t = trap();
    t.activate();
    expect(byId("far").inert).toBe(true);
    expect(byId("near").inert).toBe(true);
    expect(byId("main").inert).toBe(false); // an ancestor holds the container
    expect(container.inert).toBe(false);

    t.deactivate({ restoreFocus: false });
    expect(byId("far").inert).toBe(false);
    expect(byId("near").inert).toBe(false);
  });

  it("stops the isolation walk at a container that is not in the document", () => {
    // The walk climbs until it reaches `body`. A container that was detached
    // never will, so the climb has to end at the root of whatever tree it is in
    // — otherwise it reads a parent off nothing.
    const orphan = document.createElement("div");
    orphan.innerHTML = '<button id="orphan-first">First</button>';
    container = orphan;

    const t = trap();
    expect(() => t.activate()).not.toThrow();
    expect(byId("background").inert).toBe(false);
    expect(byId("opener").inert).toBe(false);
  });

  it("does not track or clear elements that were already inert", () => {
    byId("background").inert = true; // pre-existing inert, not ours to clear
    const t = trap();
    t.activate();
    t.deactivate();
    expect(byId("background").inert).toBe(true);
  });

  it("does not pull focus back when deactivate runs again after closing", () => {
    // Repeated deactivation leaves focus where the user moved after closing.
    byId("opener").focus();
    const t = trap();
    t.activate();
    t.deactivate();
    expect(document.activeElement).toBe(byId("opener"));

    byId("last").focus();
    t.deactivate();
    expect(document.activeElement).toBe(byId("last"));
  });

  it("leaves the traps still active alone when deactivate runs again after closing", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div id="other"><button id="o1">O1</button><button id="o2">O2</button></div>',
    );
    const t = trap({ fallbackFocus: () => byId("opener") });
    t.activate();
    const other = new FocusTrap(() => byId("other"), { isolate: false });
    traps.push(other);
    other.activate();
    t.deactivate();

    t.deactivate();
    expect(other.active).toBe(true);
    expect(document.activeElement).toBe(byId("o1"));
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    byId("o1").dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId("o2"));
  });

  it("leaves a non-HTML background sibling untouched", () => {
    // `inert` is an HTMLElement property; an SVG root at body level would only
    // collect a stray expando and get tracked for a release that means nothing.
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    document.body.append(svg);
    const t = trap();

    t.activate();

    expect(byId("background").inert).toBe(true);
    expect((svg as unknown as { inert?: boolean }).inert).toBeUndefined();
  });

  it("drops the keydown listener on deactivate", () => {
    let escapes = 0;
    const t = trap({ onEscape: () => escapes++ });
    t.activate();
    t.deactivate();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(escapes).toBe(0);
  });

  it("is idempotent: repeated activate / deactivate are no-ops", () => {
    const t = trap();
    t.activate();
    const overflowAfterFirst = document.body.style.overflow;
    t.activate(); // second activate must not re-snapshot the (now locked) overflow
    t.deactivate();
    t.deactivate();
    expect(overflowAfterFirst).toBe("hidden");
    expect(document.body.style.overflow).toBe("");
  });

  /**
   * `refreshIsolation` re-reads `isolate` on a running trap and applies the difference in
   * place. Every guarantee activation gives the isolation holds on this path too, and
   * nothing else the trap owns — the opener, the Escape layer, the scroll lock — moves.
   */
  describe("refreshIsolation", () => {
    let isolate = false;
    const soft = (options: FocusTrapOptions = {}) =>
      trap({ isolate: () => isolate, lockScroll: false, ...options });

    beforeEach(() => {
      isolate = false;
    });

    it("isolates the background in place, leaving focus inside and the opener recorded", () => {
      byId("opener").focus();
      const t = soft();
      t.activate();
      byId("last").focus();

      isolate = true;
      t.refreshIsolation();
      expect(byId("background").inert).toBe(true);
      expect(byId("opener").inert).toBe(true);
      expect(container.inert).toBe(false);
      expect(document.activeElement).toBe(byId("last"));

      t.deactivate();
      expect(byId("background").inert).toBe(false);
      expect(byId("opener").inert).toBe(false);
      expect(document.activeElement).toBe(byId("opener"));
    });

    it("releases only what it made inert across on → off → on", () => {
      byId("background").inert = true; // someone else's
      const t = soft();
      t.activate();

      isolate = true;
      t.refreshIsolation();
      expect(byId("opener").inert).toBe(true);

      isolate = false;
      t.refreshIsolation();
      expect(byId("opener").inert).toBe(false);
      expect(byId("background").inert).toBe(true);
      expect(document.activeElement).toBe(byId("first")); // releasing moves no focus

      isolate = true;
      t.refreshIsolation();
      expect(byId("opener").inert).toBe(true);

      t.deactivate({ restoreFocus: false });
      expect(byId("opener").inert).toBe(false);
      expect(byId("background").inert).toBe(true);
    });

    it("inerts only the outer siblings of each ancestor level for a nested container", () => {
      document.body.innerHTML = `
        <div id="far">far</div>
        <main id="main">
          <div id="near">near</div>
          <div id="box"><button id="first">First</button><button id="last">Last</button></div>
        </main>`;
      container = document.getElementById("box") as HTMLElement;
      const t = soft();
      t.activate();

      isolate = true;
      t.refreshIsolation();
      expect(byId("far").inert).toBe(true);
      expect(byId("near").inert).toBe(true);
      expect(byId("main").inert).toBe(false);
      expect(container.inert).toBe(false);

      isolate = false;
      t.refreshIsolation();
      expect(byId("far").inert).toBe(false);
      expect(byId("near").inert).toBe(false);
    });

    it("tracks an isolation that inerted nothing, so turning it off again is a no-op", () => {
      byId("background").inert = true;
      byId("opener").inert = true;
      const t = soft();
      isolate = true;
      t.activate();

      isolate = false;
      t.refreshIsolation();
      isolate = true;
      t.refreshIsolation();
      t.refreshIsolation();
      isolate = false;
      t.refreshIsolation();
      expect(byId("background").inert).toBe(true);
      expect(byId("opener").inert).toBe(true);
    });

    it("does not walk again when the option reads as it did", () => {
      const t = soft();
      isolate = true;
      t.activate();
      byId("opener").inert = false; // an author takes it back mid-trap

      t.refreshIsolation();
      expect(byId("opener").inert).toBe(false);
    });

    it("leaves the background alone when the option reads as it did, after the page changed", () => {
      const t = soft();
      isolate = true;
      t.activate();
      const late = document.createElement("div");
      late.id = "late";
      document.body.append(late);

      t.refreshIsolation();
      expect(byId("late").inert).toBe(false);
    });

    it("does nothing before activation or after deactivation", () => {
      const t = soft();
      isolate = true;
      t.refreshIsolation();
      expect(byId("background").inert).toBe(false);

      isolate = false;
      t.activate();
      t.deactivate({ restoreFocus: false });
      byId("opener").focus();
      isolate = true;
      t.refreshIsolation();
      expect(byId("background").inert).toBe(false);
      expect(document.activeElement).toBe(byId("opener"));
    });

    it("keeps its place on the Escape stack", () => {
      const escapes: string[] = [];
      const t = soft({ onEscape: () => escapes.push("trap") });
      t.activate();
      const upper = new EscapeLayer();
      upper.activate(document, { onDismiss: () => escapes.push("upper") });

      isolate = true;
      t.refreshIsolation();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      expect(escapes).toEqual(["upper"]);
      upper.deactivate();
    });

    it("leaves the scroll lock and its saved overflow alone", () => {
      document.body.style.overflow = "scroll";
      const t = trap({ isolate: () => isolate });
      t.activate();
      expect(document.body.style.overflow).toBe("hidden");

      isolate = true;
      t.refreshIsolation();
      isolate = false;
      t.refreshIsolation();
      expect(document.body.style.overflow).toBe("hidden");

      t.deactivate({ restoreFocus: false });
      expect(document.body.style.overflow).toBe("scroll");
    });

    it("keeps a restoreFocus: false release where it is after a refresh", () => {
      byId("opener").focus();
      const t = soft();
      t.activate();
      isolate = true;
      t.refreshIsolation();

      t.deactivate({ restoreFocus: false });
      expect(document.activeElement).toBe(byId("first"));
    });

    it("moves focus inside when it sat in the background the isolation made inert", () => {
      const t = soft();
      t.activate();
      byId("opener").focus(); // a soft boundary lets focus reach the background

      isolate = true;
      t.refreshIsolation();
      expect(document.activeElement).toBe(byId("first"));
    });

    it("moves that focus to the initial target first", () => {
      const t = soft({ initialFocus: () => byId("last") });
      t.activate();
      byId("opener").focus();

      isolate = true;
      t.refreshIsolation();
      expect(document.activeElement).toBe(byId("last"));
    });

    it("moves that focus to the container when nothing inside can take it", () => {
      container.innerHTML = "<p>Text only</p>";
      const t = soft();
      t.activate();
      byId("opener").focus();

      isolate = true;
      t.refreshIsolation();
      expect(document.activeElement).toBe(container);
      expect(container.getAttribute("tabindex")).toBe("-1");
    });

    it("leaves focus alone when nothing held it", () => {
      (document.activeElement as HTMLElement | null)?.blur();
      const t = soft({ autoFocus: false });
      t.activate();
      expect(document.activeElement).toBe(document.body);

      isolate = true;
      t.refreshIsolation();
      expect(document.activeElement).toBe(document.body);
    });
  });

  /**
   * The container getter starts returning another element while the trap is active: a
   * replaced target. The trap moves onto it where it stands among the traps.
   */
  describe("refreshContainer", () => {
    let successor: HTMLElement;

    beforeEach(() => {
      document.body.innerHTML = `
        <header id="header"><button id="opener">Open</button></header>
        <section id="s1">
          <div id="box">
            <button id="first">First</button>
            <div id="inner"><button id="mid">Mid</button><button id="last">Last</button></div>
          </div>
        </section>
        <section id="s2">
          <div id="next"><button id="next-first">First</button><button id="next-last">Last</button></div>
        </section>
        <div id="upper"><button id="upper-first">Yes</button><button id="upper-last">No</button></div>`;
      container = byId("box");
      successor = byId("next");
    });

    const inertAt = (id: string): boolean => byId(id).closest("[inert]") !== null;
    const press = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
      (document.activeElement ?? document.body).dispatchEvent(event);
      return event;
    };
    /** A trap over `#upper`, activated after the one under test. */
    const upperTrap = (options: FocusTrapOptions = {}) => {
      const instance = new FocusTrap(() => byId("upper"), options);
      traps.push(instance);
      return instance;
    };

    it("moves the background onto the new container and focus inside it", () => {
      byId("opener").focus();
      const t = trap();
      t.activate();
      expect(inertAt("s2")).toBe(true);

      container = successor;
      t.refreshContainer();

      expect(t.active).toBe(true);
      expect(inertAt("next")).toBe(false);
      expect(inertAt("s1")).toBe(true);
      expect(inertAt("header")).toBe(true);
      expect(inertAt("upper")).toBe(true);
      expect(document.activeElement).toBe(byId("next-first"));
      press("Tab");
      expect(document.activeElement).toBe(byId("next-last"));
    });

    it("moves focus inside a new container that replaced the old one in the page", () => {
      const t = trap();
      t.activate();
      byId("box").replaceWith(successor);

      container = successor;
      t.refreshContainer();

      expect(inertAt("next")).toBe(false);
      expect(document.activeElement).toBe(byId("next-first"));
    });

    it("keeps the recorded opener and leaves focus already inside the new container", () => {
      byId("opener").focus();
      const t = trap();
      t.activate();
      byId("last").focus();

      container = byId("inner");
      t.refreshContainer();
      expect(inertAt("first")).toBe(true);
      expect(document.activeElement).toBe(byId("last"));

      t.deactivate();
      expect(document.activeElement).toBe(byId("opener"));
    });

    it("keeps its place in the stack: a trap activated after it keeps focus, Tab and the background", () => {
      byId("opener").focus();
      const t = trap();
      t.activate();
      const upper = upperTrap();
      upper.activate();
      expect(document.activeElement).toBe(byId("upper-first"));

      container = successor;
      t.refreshContainer();

      expect(inertAt("upper")).toBe(false);
      expect(inertAt("next")).toBe(true);
      expect(document.activeElement).toBe(byId("upper-first"));
      press("Tab");
      expect(document.activeElement).toBe(byId("upper-last"));

      upper.deactivate({ restoreFocus: false });
      expect(inertAt("next")).toBe(false);
      expect(inertAt("s1")).toBe(true);
      expect(inertAt("upper")).toBe(true);
      t.deactivate();
      expect(document.activeElement).toBe(byId("opener"));
    });

    it("leaves focus with a trap activated after it that takes Tab, with nothing made inert", () => {
      const t = trap();
      t.activate();
      const upper = upperTrap({ isolate: false });
      upper.activate();
      expect(document.activeElement).toBe(byId("upper-first"));

      container = successor;
      t.refreshContainer();

      expect(inertAt("next")).toBe(false);
      expect(inertAt("upper")).toBe(false);
      expect(document.activeElement).toBe(byId("upper-first"));
    });

    it("keeps its place on the Escape stack", () => {
      const escapes: string[] = [];
      const t = trap({ onEscape: () => escapes.push("lower") });
      t.activate();
      const upper = upperTrap({ onEscape: () => escapes.push("upper") });
      upper.activate();

      container = successor;
      t.refreshContainer();
      press("Escape");
      expect(escapes).toEqual(["upper"]);

      upper.deactivate({ restoreFocus: false });
      press("Escape");
      expect(escapes).toEqual(["upper", "lower"]);
    });

    it("keeps the scroll lock and its saved overflow", () => {
      document.body.style.overflow = "scroll";
      const t = trap();
      t.activate();

      container = successor;
      t.refreshContainer();
      expect(document.body.style.overflow).toBe("hidden");

      t.deactivate({ restoreFocus: false });
      expect(document.body.style.overflow).toBe("scroll");
    });

    it("moves focus to the initial target first", () => {
      const t = trap({ initialFocus: () => byId("next-last") });
      t.activate();

      container = successor;
      t.refreshContainer();
      expect(document.activeElement).toBe(byId("next-last"));
    });

    it("moves focus to the container when nothing inside can take it", () => {
      successor.innerHTML = "<p>Text only</p>";
      const t = trap();
      t.activate();

      container = successor;
      t.refreshContainer();
      expect(document.activeElement).toBe(successor);
      expect(successor.getAttribute("tabindex")).toBe("-1");
    });

    it("moves no focus when autoFocus is off", () => {
      byId("opener").focus();
      const t = trap({ autoFocus: false });
      t.activate();

      container = successor;
      t.refreshContainer();
      expect(inertAt("next")).toBe(false);
      expect(document.activeElement).toBe(byId("opener"));
    });

    it("moves no focus into a new container that cannot take Tab", () => {
      const t = trap();
      t.activate();
      successor.hidden = true;

      container = successor;
      t.refreshContainer();
      expect(document.activeElement).toBe(byId("first"));
    });

    it("takes back the tabindex it lent a container it moves off that does not hold focus", () => {
      container.innerHTML = "<p>Text only</p>";
      const t = trap({ isolate: false });
      t.activate();
      expect(container.getAttribute("tabindex")).toBe("-1");
      byId("opener").focus();

      container = successor;
      t.refreshContainer();
      expect(document.activeElement).toBe(byId("next-first"));
      expect(byId("box").getAttribute("tabindex")).toBeNull();
    });

    it("keeps the tabindex of a container it moves off that holds focus, until a release finds focus elsewhere", () => {
      container.innerHTML = "<p>Text only</p>";
      const t = trap();
      t.activate();
      expect(document.activeElement).toBe(byId("box"));

      container = successor;
      t.refreshContainer();
      expect(document.activeElement).toBe(byId("next-first"));
      expect(byId("box").getAttribute("tabindex")).toBe("-1");

      t.deactivate();
      expect(byId("box").getAttribute("tabindex")).toBeNull();
    });

    it("lends the new container its own tabindex beside the one the old container keeps", () => {
      container.innerHTML = "<p>Text only</p>";
      successor.innerHTML = "<p>Text only</p>";
      const t = trap();
      t.activate();
      expect(document.activeElement).toBe(byId("box"));

      container = successor;
      t.refreshContainer();
      expect(document.activeElement).toBe(successor);
      expect(successor.getAttribute("tabindex")).toBe("-1");
      expect(byId("box").getAttribute("tabindex")).toBe("-1");

      t.deactivate();
      expect(byId("box").getAttribute("tabindex")).toBeNull();
    });

    it("keeps the old container's tabindex after focus leaves it, until a release finds focus elsewhere", () => {
      container.innerHTML = "<p>Text only</p>";
      const t = trap({ isolate: false });
      t.activate();
      const upper = upperTrap({ isolate: false, autoFocus: false });
      upper.activate();
      expect(document.activeElement).toBe(byId("box"));

      container = successor;
      t.refreshContainer();
      expect(document.activeElement).toBe(byId("box"));
      expect(byId("box").getAttribute("tabindex")).toBe("-1");

      byId("upper-first").focus();
      expect(byId("box").getAttribute("tabindex")).toBe("-1");
      t.deactivate({ restoreFocus: false });
      expect(byId("box").getAttribute("tabindex")).toBeNull();
    });

    it("changes nothing while inactive, not even the background another trap has moved off", () => {
      byId("opener").focus();
      const t = trap();
      t.refreshContainer();
      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
      expect(document.activeElement).toBe(byId("opener"));

      let otherContainer = byId("upper");
      const other = new FocusTrap(() => otherContainer);
      traps.push(other);
      other.activate();
      t.activate();
      t.deactivate({ restoreFocus: false });
      byId("upper-last").focus();
      otherContainer = successor;

      t.refreshContainer();
      expect(inertAt("upper")).toBe(false);
      expect(inertAt("next")).toBe(true);
      expect(document.activeElement).toBe(byId("upper-last"));
    });
  });

  /**
   * While active, the trap takes every `Tab` / `Shift+Tab`: it cancels the default move
   * and focuses the next or previous stop in its own order, wrapping at the ends.
   * happy-dom performs no default move, so a press the trap leaves alone moves nothing
   * here; the cases read `defaultPrevented` and where focus is.
   */
  describe("Tab handling", () => {
    const soft = { lockScroll: false, isolate: false };

    /** Dispatches a Tab keydown from the focused element, the way a key press arrives. */
    const press = (init: KeyboardEventInit = {}): KeyboardEvent => {
      const event = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      (document.activeElement ?? document.body).dispatchEvent(event);
      return event;
    };
    const three = () => {
      container.innerHTML =
        '<button id="a">A</button><button id="b">B</button><button id="c">C</button>';
    };

    it("takes a Tab in the middle of the order and moves to the next stop", () => {
      three();
      trap(soft).activate();
      byId("a").focus();

      const event = press();

      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(byId("b"));
    });

    it("takes a Shift+Tab in the middle of the order and moves to the previous stop", () => {
      three();
      trap(soft).activate();
      byId("c").focus();

      const event = press({ shiftKey: true });

      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(byId("b"));
    });

    it("treats focus on the body as outside", () => {
      three();
      trap(soft).activate();

      (document.activeElement as HTMLElement).blur();
      press();
      expect(document.activeElement).toBe(byId("a"));

      (document.activeElement as HTMLElement).blur();
      press({ shiftKey: true });
      expect(document.activeElement).toBe(byId("c"));
    });

    it("consumes a Tab and moves nothing when the container has no stop", () => {
      container.innerHTML = "<p>Text only</p>";
      trap({ ...soft, autoFocus: false }).activate();
      byId("opener").focus();

      expect(press().defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(byId("opener"));
    });

    it("keeps focus on the only stop", () => {
      container.innerHTML = '<button id="only">Only</button>';
      trap(soft).activate();

      expect(press().defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(byId("only"));
    });

    it("leaves Ctrl+Tab and Meta+Tab to the browser", () => {
      three();
      trap(soft).activate();
      byId("c").focus();

      expect(press({ ctrlKey: true }).defaultPrevented).toBe(false);
      expect(press({ metaKey: true }).defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(byId("c"));
    });

    it("handles Alt+Tab like Tab", () => {
      three();
      trap(soft).activate();
      byId("a").focus();

      expect(press({ altKey: true }).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(byId("b"));
    });

    it("leaves a Tab that is part of an IME composition alone", () => {
      three();
      trap(soft).activate();
      byId("c").focus();

      expect(press({ isComposing: true }).defaultPrevented).toBe(false);
      expect(press({ keyCode: 229 }).defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(byId("c"));
    });

    it("yields to a Tab an inner handler already consumed", () => {
      three();
      trap(soft).activate();
      byId("c").addEventListener("keydown", (event) => event.preventDefault());
      byId("c").focus();

      press();

      expect(document.activeElement).toBe(byId("c"));
    });

    it("leaves keys other than Tab alone", () => {
      three();
      trap(soft).activate();
      byId("a").focus();

      expect(press({ key: "Enter" }).defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(byId("a"));
    });

    it("moves from the focused container to the first stop in tree order, or wraps back to the last", () => {
      container.innerHTML =
        '<button id="a">A</button><button id="b">B</button><button id="p" tabindex="1">P</button>';
      trap({ ...soft, autoFocus: false }).activate();
      container.tabIndex = -1;

      container.focus();
      press();
      expect(document.activeElement).toBe(byId("a"));

      container.focus();
      press({ shiftKey: true });
      expect(document.activeElement).toBe(byId("b"));
    });

    it("moves from an element outside the order to its neighbours in tree order", () => {
      container.innerHTML = `
        <button id="a">A</button>
        <div id="between" tabindex="-1">Heading</div>
        <button id="b">B</button>
        <button id="p" tabindex="1">P</button>
        <div id="wrap" tabindex="-1"><button id="inner">Inner</button></div>`;
      trap(soft).activate();

      byId("between").focus();
      press();
      expect(document.activeElement).toBe(byId("b"));

      byId("between").focus();
      press({ shiftKey: true });
      expect(document.activeElement).toBe(byId("a"));

      byId("wrap").focus();
      press();
      expect(document.activeElement).toBe(byId("inner"));
    });

    it("wraps from an element outside the order that no stop follows or precedes", () => {
      container.innerHTML = `
        <div id="head" tabindex="-1">Head</div>
        <button id="a">A</button>
        <button id="p" tabindex="1">P</button>
        <div id="tail" tabindex="-1">Tail</div>`;
      trap(soft).activate();

      byId("tail").focus();
      press();
      expect(document.activeElement).toBe(byId("p"));

      byId("head").focus();
      press({ shiftKey: true });
      expect(document.activeElement).toBe(byId("a"));
    });

    it("treats a focused element the order does not reach as outside", () => {
      container.innerHTML = `
        <button id="a">A</button>
        <div id="host"><button id="unslotted">Unslotted</button></div>
        <button id="b">B</button>`;
      byId("host").attachShadow({ mode: "open" }).innerHTML = '<button id="s">S</button>';
      trap(soft).activate();

      byId("unslotted").focus();
      press();
      expect(document.activeElement).toBe(byId("a"));

      byId("unslotted").focus();
      press({ shiftKey: true });
      expect(document.activeElement).toBe(byId("b"));
    });

    it("moves on to the next stop when focus does not land", () => {
      three();
      trap(soft).activate();
      vi.spyOn(byId("b"), "focus").mockImplementation(() => {});
      byId("a").focus();

      press();

      expect(document.activeElement).toBe(byId("c"));
    });

    it("leaves focus where it was when no stop takes it", () => {
      three();
      trap(soft).activate();
      vi.spyOn(byId("b"), "focus").mockImplementation(() => {});
      vi.spyOn(byId("c"), "focus").mockImplementation(() => {});
      byId("a").focus();

      expect(press().defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(byId("a"));
    });

    it("stops trying once a focus attempt releases the trap", () => {
      three();
      const t = trap(soft);
      t.activate();
      vi.spyOn(byId("b"), "focus").mockImplementation(() => t.deactivate({ restoreFocus: false }));
      const next = vi.spyOn(byId("c"), "focus");
      byId("a").focus();

      press();

      expect(next).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(byId("a"));
    });

    it("stops trying once a focus attempt activates a newer trap", () => {
      three();
      document.body.insertAdjacentHTML("beforeend", '<div id="other"><button>O</button></div>');
      const other = new FocusTrap(() => byId("other"), { ...soft, autoFocus: false });
      traps.push(other);
      trap(soft).activate();
      vi.spyOn(byId("b"), "focus").mockImplementation(() => other.activate());
      const next = vi.spyOn(byId("c"), "focus");
      byId("a").focus();

      press();

      expect(next).not.toHaveBeenCalled();
    });

    it("keeps a focus move a listener redirects", () => {
      three();
      trap(soft).activate();
      byId("b").addEventListener("focus", () => byId("opener").focus());
      byId("a").focus();

      press();

      expect(document.activeElement).toBe(byId("opener"));
    });

    it("selects the text of an input it moves into", () => {
      container.innerHTML = '<button id="a">A</button><input id="field" value="hello">';
      trap(soft).activate();
      byId("a").focus();

      press();

      const field = byId("field") as HTMLInputElement;
      expect(document.activeElement).toBe(field);
      expect([field.selectionStart, field.selectionEnd]).toEqual([0, 5]);
    });

    it.each([
      ["text", true],
      ["search", true],
      ["email", true],
      ["url", true],
      ["tel", true],
      ["password", true],
      ["number", true],
      ["checkbox", false],
      ["date", false],
      ["range", false],
      ["color", false],
    ])("selects the content of a %s input on entry: %s", (type, selects) => {
      container.innerHTML = `<button id="a">A</button><input id="field" type="${type}">`;
      trap(soft).activate();
      const select = vi.spyOn(byId("field") as HTMLInputElement, "select");
      byId("a").focus();

      press();

      expect(document.activeElement).toBe(byId("field"));
      expect(select).toHaveBeenCalledTimes(selects ? 1 : 0);
    });

    it("leaves the selection of a textarea alone", () => {
      container.innerHTML = '<button id="a">A</button><textarea id="field">hello</textarea>';
      trap(soft).activate();
      const select = vi.spyOn(byId("field") as HTMLTextAreaElement, "select");
      byId("a").focus();

      press();

      expect(document.activeElement).toBe(byId("field"));
      expect(select).not.toHaveBeenCalled();
    });

    it("does not select an input a listener moved focus away from", () => {
      container.innerHTML =
        '<button id="a">A</button><input id="field" value="hello"><button id="c">C</button>';
      trap(soft).activate();
      const field = byId("field") as HTMLInputElement;
      const select = vi.spyOn(field, "select");
      field.addEventListener("focus", () => byId("c").focus());
      byId("a").focus();

      press();

      expect(document.activeElement).toBe(byId("c"));
      expect(select).not.toHaveBeenCalled();
    });

    it("stops taking Tab once deactivated", () => {
      three();
      const t = trap(soft);
      t.activate();
      t.deactivate({ restoreFocus: false });
      byId("a").focus();

      expect(press().defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(byId("a"));
    });
  });

  /**
   * One resolver per document decides which active trap takes a Tab: the most recently
   * activated one whose container is connected and rendered. A trap that cannot take it
   * passes it to the one below.
   */
  describe("nested traps", () => {
    let outer: FocusTrap;
    let inner: FocusTrap;

    beforeEach(() => {
      document.body.innerHTML = `
        <div id="outer"><button id="o1">O1</button><button id="o2">O2</button><button id="o3">O3</button></div>
        <div id="inner"><button id="i1">I1</button><button id="i2">I2</button><button id="i3">I3</button></div>`;
      const outerContainer = byId("outer");
      outer = new FocusTrap(() => outerContainer, { lockScroll: false, isolate: false });
      traps.push(outer);
    });

    const press = (): KeyboardEvent => {
      const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      (document.activeElement ?? document.body).dispatchEvent(event);
      return event;
    };
    const makeInner = (options: FocusTrapOptions = {}) => {
      const innerContainer = byId("inner");
      inner = new FocusTrap(() => innerContainer, { lockScroll: false, ...options });
      traps.push(inner);
      return inner;
    };

    it("lets the most recently activated trap take Tab", () => {
      outer.activate();
      makeInner().activate();
      expect(byId("outer").inert).toBe(true);
      expect(document.activeElement).toBe(byId("i1"));

      expect(press().defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(byId("i2"));
    });

    it("hands Tab back to the trap below once the newer one is released", () => {
      outer.activate();
      makeInner().activate();
      inner.deactivate({ restoreFocus: false });
      byId("o1").focus();

      press();

      expect(document.activeElement).toBe(byId("o2"));
    });

    it("passes Tab to the trap below while the newer trap's container is disconnected", () => {
      outer.activate();
      makeInner({ isolate: false }).activate();
      byId("inner").remove();
      byId("o1").focus();

      press();

      expect(document.activeElement).toBe(byId("o2"));
    });

    it("passes Tab to the trap below while the newer trap's container is hidden", () => {
      outer.activate();
      makeInner({ isolate: false }).activate();
      byId("inner").hidden = true;
      byId("o1").focus();

      press();

      expect(document.activeElement).toBe(byId("o2"));
    });

    it("passes Tab to the trap below while the newer trap's container is not rendered", () => {
      outer.activate();
      makeInner({ isolate: false }).activate();
      byId("inner").style.display = "none";
      byId("o1").focus();

      press();

      expect(document.activeElement).toBe(byId("o2"));
    });

    it("passes Tab on from a disconnected container where rendering cannot be read", () => {
      outer.activate();
      makeInner({ isolate: false }).activate();
      const detached = byId("inner");
      detached.remove();
      Object.defineProperty(detached, "checkVisibility", { configurable: true, value: undefined });
      byId("o1").focus();

      press();

      expect(document.activeElement).toBe(byId("o2"));
    });

    it("leaves Tab to the browser when no active trap can take it", () => {
      outer.activate();
      byId("outer").remove();
      byId("i1").focus();

      expect(press().defaultPrevented).toBe(false);
    });

    it("installs one document listener while any trap is active and removes it with the last", () => {
      const added = vi.spyOn(document, "addEventListener");
      const removed = vi.spyOn(document, "removeEventListener");
      const keydown = (spy: typeof added) =>
        spy.mock.calls.filter(([type]) => type === "keydown").length;

      outer.activate();
      makeInner({ isolate: false }).activate();
      expect(keydown(added)).toBe(1);

      inner.deactivate({ restoreFocus: false });
      expect(keydown(removed)).toBe(0);
      outer.deactivate({ restoreFocus: false });
      expect(keydown(removed)).toBe(1);
    });
  });

  /**
   * The order the trap moves in: HTML's sequential navigation order within the container,
   * with the engine's radio-group rule, open shadow roots walked in flat-tree order, and
   * editable content's links left out.
   */
  describe("order", () => {
    const soft = { lockScroll: false, isolate: false };
    const press = (shiftKey = false): void => {
      const event = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      (document.activeElement ?? document.body).dispatchEvent(event);
    };
    /** The focused element's id, looking through open shadow roots. */
    const focused = (): string => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return active?.id ?? "";
    };
    /** Presses Tab (or Shift+Tab) `count` times and returns where focus went. */
    const walk = (count: number, shiftKey = false): string[] =>
      Array.from({ length: count }, () => {
        press(shiftKey);
        return focused();
      });
    const radio = (name: string, id: string, extra = "") =>
      `<input type="radio" name="${name}" id="${id}" aria-label="${id}" ${extra}>`;

    it("puts positive tabindex first, ascending, then the rest in tree order", () => {
      container.innerHTML = `
        <button id="z1">Z1</button>
        <button id="p2" tabindex="2">P2</button>
        <button id="z2">Z2</button>
        <button id="p1" tabindex="1">P1</button>`;
      trap(soft).activate();

      expect(focused()).toBe("p1");
      expect(walk(4)).toEqual(["p2", "z1", "z2", "p1"]);
      expect(walk(4, true)).toEqual(["z2", "z1", "p2", "p1"]);
    });

    it("stops once per radio group: on its checked radio, or on the first of an unchecked group", () => {
      container.innerHTML = `
        <button id="a">A</button>
        ${radio("g1", "g1-1")}${radio("g1", "g1-2", "checked")}${radio("g1", "g1-3")}
        <button id="b">B</button>
        ${radio("g2", "g2-1")}${radio("g2", "g2-2")}${radio("g2", "g2-3")}
        <button id="c">C</button>`;
      trap(soft).activate();

      expect(walk(5)).toEqual(["g1-2", "b", "g2-1", "c", "a"]);
      expect(walk(5, true)).toEqual(["c", "g2-1", "b", "g1-2", "a"]);
    });

    it("keeps a checked radio a stop from inside its group, and leaves an unchecked group's stop behind", () => {
      container.innerHTML = `
        <button id="a">A</button>
        ${radio("g1", "g1-1")}${radio("g1", "g1-2", "checked")}${radio("g1", "g1-3")}
        <button id="b">B</button>
        ${radio("g2", "g2-1")}${radio("g2", "g2-2")}${radio("g2", "g2-3")}
        <button id="c">C</button>`;
      trap(soft).activate();

      byId("g1-1").focus();
      expect(walk(1)).toEqual(["g1-2"]);
      byId("g1-3").focus();
      expect(walk(1, true)).toEqual(["g1-2"]);
      byId("g1-2").focus();
      expect(walk(1)).toEqual(["b"]);
      byId("g2-2").focus();
      expect(walk(1, true)).toEqual(["b"]);
      byId("g2-2").focus();
      expect(walk(1)).toEqual(["c"]);
    });

    it("gives the stop of a group whose checked radio cannot take focus to its first radio that can", () => {
      container.innerHTML = `
        <button id="a">A</button>
        ${radio("grp", "grp1", "disabled")}${radio("grp", "grp2", "checked disabled")}${radio("grp", "grp3")}${radio("grp", "grp4")}
        <button id="b">B</button>`;
      trap(soft).activate();

      expect(walk(3)).toEqual(["grp3", "b", "a"]);
    });

    it("treats radios without a name, and radios of different forms, as groups of their own", () => {
      container.innerHTML = `
        <button id="a">A</button>
        <input type="radio" id="bare-1" aria-label="bare one">
        <input type="radio" id="bare-2" aria-label="bare two">
        ${radio("owner", "owner-1")}${radio("owner", "owner-2", 'form="elsewhere"')}
        <form id="elsewhere"></form>`;
      trap(soft).activate();

      expect(walk(5)).toEqual(["bare-1", "bare-2", "owner-1", "owner-2", "a"]);
    });

    it("does not let a radio outside the container stand for a group inside it", () => {
      byId("opener").insertAdjacentHTML("afterend", radio("grp", "outside-radio"));
      container.innerHTML = `${radio("grp", "grp1")}${radio("grp", "grp2")}<button id="a">A</button>`;
      trap(soft).activate();

      byId("outside-radio").focus();
      expect(walk(1)).toEqual(["grp1"]);
    });

    it("moves initial focus to a group's checked radio", () => {
      container.innerHTML = `${radio("grp", "grp1")}${radio("grp", "grp2", "checked")}<button id="a">A</button>`;
      trap(soft).activate();

      expect(focused()).toBe("grp2");
    });

    it("sends focus the isolation strands to a group's checked radio", () => {
      let isolate = false;
      container.innerHTML = `${radio("grp", "grp1")}${radio("grp", "grp2", "checked")}<button id="a">A</button>`;
      const t = trap({ lockScroll: false, isolate: () => isolate });
      t.activate();
      byId("opener").focus();

      isolate = true;
      t.refreshIsolation();

      expect(focused()).toBe("grp2");
    });

    it("walks an open shadow root in flat-tree order and reads focus inside it", () => {
      container.innerHTML = `
        <button id="a">A</button>
        <div id="host"><button id="slotted">Slotted</button></div>`;
      byId("host").attachShadow({ mode: "open" }).innerHTML =
        '<button id="s1">S1</button><slot></slot><button id="s2">S2</button>';
      trap(soft).activate();

      expect(walk(4)).toEqual(["s1", "slotted", "s2", "a"]);
      expect(walk(4, true)).toEqual(["s2", "slotted", "s1", "a"]);
    });

    it("orders a positive tabindex within the shadow root that holds it", () => {
      container.innerHTML = `
        <button id="a">A</button>
        <div id="host"></div>
        <button id="p" tabindex="2">P</button>`;
      byId("host").attachShadow({ mode: "open" }).innerHTML =
        '<button id="sz">SZ</button><button id="sp" tabindex="1">SP</button>';
      trap(soft).activate();

      expect(focused()).toBe("p");
      expect(walk(4)).toEqual(["a", "sp", "sz", "p"]);
    });

    it("stops on a focusable shadow host before its content, and skips the content of a host with a negative tabindex", () => {
      container.innerHTML = `
        <div id="shown" tabindex="0"></div>
        <div id="removed" tabindex="-1"></div>
        <button id="a">A</button>`;
      byId("shown").attachShadow({ mode: "open" }).innerHTML = '<button id="in-shown">In</button>';
      byId("removed").attachShadow({ mode: "open" }).innerHTML =
        '<button id="in-removed">In</button>';
      trap(soft).activate();

      expect(focused()).toBe("shown");
      expect(walk(3)).toEqual(["in-shown", "a", "shown"]);
    });

    it("uses a slot's fallback content when nothing is assigned to it", () => {
      container.innerHTML = '<button id="a">A</button><div id="host"></div>';
      byId("host").attachShadow({ mode: "open" }).innerHTML =
        '<slot name="none"><button id="fallback">Fallback</button></slot>';
      trap(soft).activate();

      expect(walk(2)).toEqual(["fallback", "a"]);
    });

    it("looks at a closed shadow host only", () => {
      container.innerHTML =
        '<button id="a">A</button><div id="host"></div><button id="b">B</button>';
      byId("host").attachShadow({ mode: "closed" }).innerHTML = "<button>Hidden</button>";
      trap(soft).activate();

      expect(walk(2)).toEqual(["b", "a"]);
    });

    it("leaves out a link that is part of editable content and keeps the other controls there", () => {
      container.innerHTML = `
        <button id="a">A</button>
        <div id="host" contenteditable="true">
          Text <a id="link" href="#x">link</a>
          <button id="inner">Inner</button>
          <span contenteditable="false"><a id="island-link" href="#y">island</a></span>
          <span contenteditable="invalid"><a id="inherited-link" href="#z">inherited</a></span>
          <a id="own-tabindex" href="#w" tabindex="0">own</a>
        </div>
        <div id="plain" contenteditable="plaintext-only"><a id="plain-link" href="#v">plain</a></div>`;
      trap(soft).activate();

      expect(walk(6)).toEqual(["host", "inner", "island-link", "own-tabindex", "plain", "a"]);
    });

    it("stops on an SVG element with a tabindex", () => {
      container.innerHTML = `
        <button id="a">A</button>
        <svg id="chart" tabindex="0" aria-label="Chart"><rect width="10" height="10"></rect></svg>`;
      trap(soft).activate();

      expect(walk(2)).toEqual(["chart", "a"]);
    });
  });

  /**
   * The active traps of a document share one background: it takes the shape of the most
   * recently activated isolating trap, with the containers of that trap and of every trap
   * activated after it kept open. Releasing any trap, in any order, hands the background
   * to the traps still active, and only the `inert` the traps applied is ever released.
   */
  describe("background across traps", () => {
    let region1: HTMLElement;
    let region2: HTMLElement;

    beforeEach(() => {
      document.body.innerHTML = `
        <header id="header"><button id="h">H</button></header>
        <section id="s1">
          <p id="s1-text">Text</p>
          <div id="region1"><button id="r1-a">A</button><button id="r1-b">B</button>
            <div id="nested"><button id="n-a">NA</button><button id="n-b">NB</button></div>
          </div>
        </section>
        <section id="s2">
          <p id="s2-text">Text</p>
          <div id="region2"><button id="r2-a">A</button><button id="r2-b">B</button></div>
        </section>`;
      region1 = byId("region1");
      region2 = byId("region2");
    });

    const make = (element: HTMLElement, options: FocusTrapOptions = {}) => {
      const instance = new FocusTrap(() => element, { lockScroll: false, ...options });
      traps.push(instance);
      return instance;
    };
    const inertAt = (id: string): boolean => byId(id).closest("[inert]") !== null;
    const press = (): void => {
      const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      (document.activeElement ?? document.body).dispatchEvent(event);
    };

    it("keeps the container of a trap opened over a sibling trap out of the background", () => {
      make(region1).activate();
      expect(inertAt("region2")).toBe(true);

      make(region2).activate();

      expect(inertAt("region2")).toBe(false);
      expect(inertAt("region1")).toBe(true);
      expect(inertAt("s2-text")).toBe(true);
      expect(inertAt("header")).toBe(true);
      expect(document.activeElement).toBe(byId("r2-a"));
      press();
      expect(document.activeElement).toBe(byId("r2-b"));
    });

    it("gives the background back to the trap below when the upper one is released", () => {
      const lower = make(region1);
      lower.activate();
      const upper = make(region2);
      upper.activate();

      upper.deactivate();

      expect(inertAt("region1")).toBe(false);
      expect(inertAt("region2")).toBe(true);
      expect(inertAt("s1-text")).toBe(true);
      expect(inertAt("header")).toBe(true);
      expect(document.activeElement).toBe(byId("r1-a"));
      press();
      expect(document.activeElement).toBe(byId("r1-b"));

      lower.deactivate({ restoreFocus: false });
      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    });

    it("keeps the upper trap's background when the trap below is released first", () => {
      const lower = make(region1);
      lower.activate();
      const upper = make(region2);
      upper.activate();

      lower.deactivate({ restoreFocus: false });

      expect(inertAt("region1")).toBe(true);
      expect(inertAt("region2")).toBe(false);
      expect(inertAt("header")).toBe(true);
      upper.deactivate({ restoreFocus: false });
      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    });

    it("keeps the outer background of a nested trap when the outer trap is released first", () => {
      const outer = make(region1);
      outer.activate();
      const inner = make(byId("nested"));
      inner.activate();
      expect(inertAt("r1-a")).toBe(true);

      outer.deactivate({ restoreFocus: false });

      expect(inertAt("header")).toBe(true);
      expect(inertAt("s2")).toBe(true);
      expect(inertAt("s1-text")).toBe(true);
      expect(inertAt("r1-a")).toBe(true);
      expect(inertAt("nested")).toBe(false);
      inner.deactivate({ restoreFocus: false });
      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    });

    it("keeps a soft trap opened over an isolating one open, with the isolating trap's container", () => {
      make(region1).activate();
      make(region2, { isolate: false }).activate();

      expect(inertAt("region2")).toBe(false);
      expect(inertAt("region1")).toBe(false);
      expect(inertAt("s2-text")).toBe(true);
      expect(inertAt("s1-text")).toBe(true);
      expect(inertAt("header")).toBe(true);
    });

    it("makes no more of the page inert for a soft trap opened inside an isolating trap", () => {
      make(region1).activate();
      make(byId("nested"), { isolate: false }).activate();

      expect(inertAt("r1-a")).toBe(false);
      expect(inertAt("r1-b")).toBe(false);
      expect(inertAt("nested")).toBe(false);
      expect(inertAt("s1-text")).toBe(true);
    });

    it("applies no background while only soft traps are active", () => {
      make(region1, { isolate: false }).activate();
      make(region2, { isolate: false }).activate();

      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    });

    it("hands the background to the isolating trap below when the upper trap stops isolating, keeping the upper one open", () => {
      let isolate = true;
      make(region1).activate();
      const upper = make(region2, { isolate: () => isolate });
      upper.activate();

      isolate = false;
      upper.refreshIsolation();

      expect(inertAt("region2")).toBe(false);
      expect(inertAt("region1")).toBe(false);
      expect(inertAt("s2-text")).toBe(true);
      expect(inertAt("header")).toBe(true);
    });

    it("leaves the upper trap's background alone when the trap below stops isolating", () => {
      let isolate = true;
      const lower = make(region1, { isolate: () => isolate });
      lower.activate();
      const upper = make(region2);
      upper.activate();

      isolate = false;
      lower.refreshIsolation();
      expect(inertAt("region1")).toBe(true);
      expect(inertAt("header")).toBe(true);

      upper.deactivate({ restoreFocus: false });
      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    });

    it("leaves the shared background alone when an inactive trap refreshes its isolation", () => {
      make(region1).activate();
      const late = document.createElement("div");
      late.id = "late";
      document.body.append(late);
      let isolate = false;
      const idle = make(region2, { isolate: () => isolate });

      isolate = true;
      idle.refreshIsolation();

      expect(byId("late").inert).toBe(false);
    });

    it("never lifts or releases an inert the traps did not apply on a container's ancestors", () => {
      byId("s2").inert = true;
      make(region1).activate();
      const upper = make(region2, { autoFocus: false });
      upper.activate();
      expect(byId("s2").inert).toBe(true);

      upper.deactivate({ restoreFocus: false });
      expect(byId("s2").inert).toBe(true);
    });

    it("moves no focus when it sits in background that was inert before the refresh", () => {
      let isolate = false;
      byId("h").focus();
      make(region1, { autoFocus: false }).activate();
      expect(document.activeElement).toBe(byId("h"));
      const upper = make(region2, { autoFocus: false, isolate: () => isolate });
      upper.activate();

      isolate = true;
      upper.refreshIsolation();

      expect(inertAt("region1")).toBe(true);
      expect(document.activeElement).toBe(byId("h"));
    });

    /** A trap on `region2` whose container getter starts throwing once `readable` is off. */
    const brokenTrap = (options: FocusTrapOptions) => {
      const state = { readable: true };
      const instance = new FocusTrap(
        () => {
          if (!state.readable) throw new Error("target left the page");
          return region2;
        },
        { lockScroll: false, autoFocus: false, ...options },
      );
      traps.push(instance);
      return { instance, state };
    };

    it("passes Tab on from a trap whose container cannot be read", () => {
      make(region1, { isolate: false }).activate();
      const broken = brokenTrap({ isolate: false });
      broken.instance.activate();
      broken.state.readable = false;
      byId("r1-a").focus();

      press();

      expect(document.activeElement).toBe(byId("r1-b"));
    });

    it("keeps the background for the others when a trap's container cannot be read", () => {
      make(region1).activate();
      const broken = brokenTrap({ isolate: false });
      broken.instance.activate();
      expect(inertAt("region2")).toBe(false);
      broken.state.readable = false;

      make(byId("header"), { isolate: false, autoFocus: false }).activate();

      expect(inertAt("header")).toBe(false);
      expect(inertAt("region1")).toBe(false);
      expect(inertAt("region2")).toBe(true);
    });
  });

  /**
   * Where focus goes back to when traps opened one from inside another are released in any
   * order. A trap released while a trap opened from inside it is still active hands its
   * way back to that trap, behind the trap's own, so the last trap to close returns focus to
   * the first usable element on the way back: its opener, its `fallbackFocus`, then what it
   * was handed. A release leaves focus alone while a trap activated after it holds focus and
   * takes `Tab`; with no usable way back, focus goes to the initial target of the trap that
   * takes `Tab` now.
   */
  describe("restore across stacked traps", () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <button id="x">X</button>
        <div id="a"><button id="a1">A1</button><button id="y">Y</button></div>
        <div id="b"><button id="b1">B1</button><button id="z">Z</button></div>
        <div id="c"><button id="c1">C1</button><button id="c2">C2</button></div>`;
    });

    /** A trap on the container with `id`; scroll stays unlocked so the cases read focus only. */
    const layer = (id: string, options: FocusTrapOptions = {}): FocusTrap => {
      const element = byId(id);
      const instance = new FocusTrap(() => element, { lockScroll: false, ...options });
      traps.push(instance);
      return instance;
    };
    /** Hides the container with `id` and releases its trap, the way a dialog closes. */
    const close = (instance: FocusTrap, id: string): void => {
      byId(id).hidden = true;
      instance.deactivate();
    };
    /** The id of the focused element. */
    const focused = (): string => document.activeElement?.id ?? "";
    /** Opens A from X and B from Y inside A. */
    const openTwo = (): { a: FocusTrap; b: FocusTrap } => {
      byId("x").focus();
      const a = layer("a");
      a.activate();
      byId("y").focus();
      const b = layer("b");
      b.activate();
      expect(focused()).toBe("b1");
      return { a, b };
    };
    /** Opens A from X, B from Y inside A, and C from Z inside B. */
    const openThree = (): { a: FocusTrap; b: FocusTrap; c: FocusTrap } => {
      const opened = openTwo();
      byId("z").focus();
      const c = layer("c");
      c.activate();
      expect(focused()).toBe("c1");
      return { ...opened, c };
    };
    /** Closes the traps in `order` and returns where focus is after each close. */
    const closeInOrder = (
      opened: Record<string, FocusTrap | undefined>,
      order: string[],
    ): string[] =>
      order.map((id) => {
        const instance = opened[id];
        if (!instance) throw new Error(`no trap on #${id}`);
        close(instance, id);
        return focused();
      });

    it.each([
      ["the upper one first", ["b", "a"], ["y", "x"]],
      ["the lower one first", ["a", "b"], ["b1", "x"]],
    ])("returns focus along the way back when two traps close, %s", (_, order, after) => {
      expect(closeInOrder(openTwo(), order)).toEqual(after);
    });

    it.each([
      ["C, B, A", ["c", "b", "a"], ["z", "y", "x"]],
      ["C, A, B", ["c", "a", "b"], ["z", "z", "x"]],
      ["B, C, A", ["b", "c", "a"], ["c1", "y", "x"]],
      ["B, A, C", ["b", "a", "c"], ["c1", "c1", "x"]],
      ["A, B, C", ["a", "b", "c"], ["c1", "c1", "x"]],
      ["A, C, B", ["a", "c", "b"], ["c1", "z", "x"]],
    ])(
      "returns focus along the way back when three traps close in the order %s",
      (_, order, after) => {
        expect(closeInOrder(openThree(), order)).toEqual(after);
      },
    );

    it("hands its way back only to the trap opened from inside it, not to the traps above that one", () => {
      byId("x").focus();
      const a = layer("a", { isolate: false });
      a.activate();
      byId("y").focus();
      const b = layer("b");
      b.activate();
      byId("z").focus();
      const c = layer("c");
      c.activate();

      a.deactivate({ restoreFocus: false });
      close(b, "b");
      close(c, "c");
      expect(focused()).toBe("y");
    });

    it("hands its way back over when it is released without restoring focus", () => {
      const { a, b } = openTwo();
      byId("a").hidden = true;
      a.deactivate({ restoreFocus: false });
      expect(focused()).toBe("b1");

      close(b, "b");
      expect(focused()).toBe("x");
    });

    it("keeps nothing of a way back handed over to it for its next activation", () => {
      const { a, b } = openTwo();
      a.deactivate({ restoreFocus: false });
      b.deactivate({ restoreFocus: false });
      expect(focused()).toBe("b1");

      byId("a").hidden = true;
      const opener = document.createElement("button");
      byId("b").before(opener);
      opener.focus();
      b.activate();
      opener.remove();
      close(b, "b");
      expect(focused()).toBe("b1");
    });

    it.each([
      ["restoring focus", true],
      ["leaving focus alone", false],
    ])(
      "returns to its own opener while that is still usable, though the trap it was opened from left %s",
      (_, restoreFocus) => {
        byId("x").focus();
        const a = layer("a", { isolate: false });
        a.activate();
        byId("y").focus();
        const b = layer("b");
        b.activate();

        a.deactivate({ restoreFocus });
        expect(focused()).toBe("b1");
        close(b, "b");
        expect(focused()).toBe("y");
      },
    );

    it("leaves focus in a trap activated after it that takes Tab, though that trap does not isolate", () => {
      byId("x").focus();
      const a = layer("a");
      a.activate();
      byId("y").focus();
      const b = layer("b", { isolate: false });
      b.activate();

      close(a, "a");
      expect(focused()).toBe("b1");
      close(b, "b");
      expect(focused()).toBe("x");
    });

    it("restores when focus sits in a trap activated before it", () => {
      byId("x").focus();
      const a = layer("a");
      a.activate();
      byId("y").focus();
      const b = layer("b", { isolate: false });
      b.activate();
      byId("a1").focus();

      close(b, "b");
      expect(focused()).toBe("y");
    });

    it("restores when focus sits in its own container inside a trap activated after it", () => {
      document.body.innerHTML = `
        <section id="scope">
          <button id="trigger">Open</button>
          <div id="dialog"><button id="close">Close</button></div>
        </section>`;
      byId("trigger").focus();
      const dialog = layer("dialog");
      dialog.activate();
      const scope = layer("scope", { isolate: false, autoFocus: false });
      scope.activate();
      expect(focused()).toBe("close");

      close(dialog, "dialog");
      expect(focused()).toBe("trigger");
    });

    it("leaves focus in a trap nested inside it and activated after it", () => {
      byId("a").insertAdjacentHTML(
        "beforeend",
        '<div id="inner"><button id="i1">I1</button></div>',
      );
      byId("x").focus();
      const outer = layer("a", { isolate: false });
      outer.activate();
      layer("inner", { isolate: false }).activate();
      expect(focused()).toBe("i1");

      outer.deactivate();
      expect(focused()).toBe("i1");
    });

    it("tries the last trap's own fallbackFocus before the way back it was handed", () => {
      document.body.insertAdjacentHTML("beforeend", '<button id="f">F</button>');
      byId("x").focus();
      const a = layer("a");
      a.activate();
      byId("y").focus();
      const b = layer("b", { fallbackFocus: () => byId("f") });
      b.activate();

      close(a, "a");
      close(b, "b");
      expect(focused()).toBe("f");
    });

    it("restores when the trap activated after it holds focus but cannot take Tab", () => {
      byId("x").focus();
      const a = layer("a", { isolate: false });
      a.activate();
      byId("y").focus();
      const b = layer("b", { isolate: false });
      b.activate();
      byId("b").style.display = "none";

      close(a, "a");
      expect(focused()).toBe("x");
    });

    it("sends focus into the trap below when the upper trap's opener left with a replaced container, and to the first opener after it", () => {
      let lowerContainer = byId("a");
      const successor = document.createElement("div");
      successor.innerHTML = '<button id="next-1">N1</button><button id="next-2">N2</button>';
      byId("x").focus();
      const a = new FocusTrap(() => lowerContainer, { lockScroll: false });
      traps.push(a);
      a.activate();
      byId("y").focus();
      const b = layer("b");
      b.activate();

      byId("a").replaceWith(successor);
      lowerContainer = successor;
      a.refreshContainer();
      expect(focused()).toBe("b1");

      close(b, "b");
      expect(focused()).toBe("next-1");
      successor.hidden = true;
      a.deactivate();
      expect(focused()).toBe("x");
    });

    /**
     * Opens A from X and B from W, a button inside A that leaves the page while B is open, so
     * nothing on B's way back can take focus.
     */
    const openFromLeavingButton = (
      lower: FocusTrapOptions,
      upper: FocusTrapOptions = {},
    ): FocusTrap => {
      byId("x").focus();
      layer("a", lower).activate();
      const leaving = document.createElement("button");
      byId("a").append(leaving);
      leaving.focus();
      const b = layer("b", upper);
      b.activate();
      leaving.remove();
      return b;
    };

    it("sends focus to the initial target of the trap that takes Tab when nothing on the way back can take it", () => {
      const b = openFromLeavingButton({ initialFocus: () => byId("y") });
      close(b, "b");
      expect(focused()).toBe("y");
    });

    it("moves no focus into the trap that takes Tab when its autoFocus is off", () => {
      const b = openFromLeavingButton({ autoFocus: false });
      close(b, "b");
      expect(focused()).toBe("b1");
    });

    it("moves no focus when it already sits inside the trap that takes Tab", () => {
      const b = openFromLeavingButton({ initialFocus: () => byId("a1") }, { isolate: false });
      byId("y").focus();
      close(b, "b");
      expect(focused()).toBe("y");
    });

    it("moves no focus when nothing on the way back can take it and no trap is left", () => {
      const leaving = document.createElement("button");
      byId("a").before(leaving);
      leaving.focus();
      const a = layer("a");
      a.activate();
      leaving.remove();
      close(a, "a");
      expect(focused()).toBe("a1");
    });

    it("lets a trap opened while the trap below closes keep focus, and returns it to the first opener", () => {
      byId("x").focus();
      const a = layer("a");
      a.activate();
      byId("y").focus();
      // A closing dialog hides itself, then reports the close; a subscriber opens B.
      byId("a").hidden = true;
      const b = layer("b");
      b.activate();
      a.deactivate();
      expect(focused()).toBe("b1");

      close(b, "b");
      expect(focused()).toBe("x");
    });

    it("forms no cycle when the trap below is opened again from inside the upper one", () => {
      const { a, b } = openTwo();
      close(a, "a");
      expect(focused()).toBe("b1");

      byId("a").hidden = false;
      byId("z").focus();
      a.activate();
      expect(focused()).toBe("a1");
      close(b, "b");
      expect(focused()).toBe("a1");

      byId("a").hidden = true;
      withinTimeLimit(() => a.deactivate());
      expect(focused()).toBe("x");
    });

    it("keeps the state of an activation that a listener makes from inside the restoring focus()", () => {
      document.body.insertAdjacentHTML("beforeend", '<div id="text">Text only</div>');
      const textOnly = byId("text");
      byId("x").focus();
      const t = new FocusTrap(() => textOnly, {
        lockScroll: false,
        isolate: false,
        fallbackFocus: () => byId("a1"),
      });
      traps.push(t);
      t.activate();
      expect(focused()).toBe("text");
      byId("x").addEventListener("focus", () => t.activate(), { once: true });

      t.deactivate();
      expect(t.active).toBe(true);
      expect(focused()).toBe("text");
      expect(textOnly.getAttribute("tabindex")).toBe("-1");

      t.deactivate();
      expect(focused()).toBe("x");
      expect(textOnly.getAttribute("tabindex")).toBeNull();
    });
  });

  /**
   * A container with nothing to focus is lent `tabindex="-1"` so it can take focus itself.
   * The loan is taken back on release, after a restore has moved focus, and when the trap moves
   * onto another container, except from a container that holds focus at that moment: removing
   * the attribute from the focused element drops focus to `<body>` in a real engine, and a
   * container that keeps focus can be the element the next trap returns to. That loan stays
   * until a later release or move of the trap finds focus elsewhere.
   */
  describe("lent tabindex", () => {
    beforeEach(() => {
      container.innerHTML = "<p>Text only</p>";
    });

    it("lends the container tabindex=-1 and takes it back on release", () => {
      byId("opener").focus();
      const t = trap();
      t.activate();
      expect(document.activeElement).toBe(container);
      expect(container.getAttribute("tabindex")).toBe("-1");

      t.deactivate();
      expect(document.activeElement).toBe(byId("opener"));
      expect(container.getAttribute("tabindex")).toBeNull();
    });

    it("lends the tabindex again on the next activation", () => {
      byId("opener").focus();
      const t = trap();
      t.activate();
      t.deactivate();
      expect(container.getAttribute("tabindex")).toBeNull();

      t.activate();
      expect(document.activeElement).toBe(container);
      expect(container.getAttribute("tabindex")).toBe("-1");
    });

    it("takes back a loan kept on a focused container when a release while inactive finds focus elsewhere", () => {
      const t = trap();
      t.activate();
      t.deactivate({ restoreFocus: false });
      expect(document.activeElement).toBe(container);
      expect(container.getAttribute("tabindex")).toBe("-1");
      byId("opener").focus();

      t.deactivate({ restoreFocus: false });

      expect(container.getAttribute("tabindex")).toBeNull();
    });

    it("keeps the loan of a container in an open shadow root that holds focus", () => {
      const host = document.createElement("div");
      document.body.append(host);
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = "<div><p>Text only</p></div>";
      const inner = shadow.firstElementChild as HTMLElement;
      const t = new FocusTrap(() => inner);
      t.activate();
      expect(shadow.activeElement).toBe(inner);

      t.deactivate({ restoreFocus: false });

      expect(inner.getAttribute("tabindex")).toBe("-1");
      host.remove();
    });

    it("keeps a loan on a container that still holds focus through a release while inactive", () => {
      const t = trap();
      t.activate();
      t.deactivate({ restoreFocus: false });
      t.deactivate({ restoreFocus: false });
      expect(document.activeElement).toBe(container);
      expect(container.getAttribute("tabindex")).toBe("-1");
    });

    it("leaves a tabindex the author wrote on the container as it is", () => {
      container.setAttribute("tabindex", "0");
      byId("opener").focus();
      const t = trap();
      t.activate();
      expect(document.activeElement).toBe(container);

      t.deactivate();
      expect(container.getAttribute("tabindex")).toBe("0");
    });

    it("leaves a value the page wrote over the loan", () => {
      byId("opener").focus();
      const t = trap();
      t.activate();
      container.setAttribute("tabindex", "0");

      t.deactivate();
      expect(container.getAttribute("tabindex")).toBe("0");
    });

    it("keeps the loan on a container released while it holds focus after focus leaves it, until a release finds focus elsewhere", () => {
      const t = trap({ isolate: false });
      t.activate();

      t.deactivate({ restoreFocus: false });
      expect(document.activeElement).toBe(container);
      expect(container.getAttribute("tabindex")).toBe("-1");

      byId("opener").focus();
      expect(container.getAttribute("tabindex")).toBe("-1");

      t.activate();
      byId("opener").focus();
      t.deactivate({ restoreFocus: false });
      expect(container.getAttribute("tabindex")).toBeNull();
    });

    it("keeps one loan across an activation on the same container, and takes it back at a release that finds focus elsewhere", () => {
      byId("opener").focus();
      const t = trap({ isolate: false });
      t.activate();
      t.deactivate({ restoreFocus: false });
      t.activate();
      expect(document.activeElement).toBe(container);

      byId("opener").focus();
      expect(container.getAttribute("tabindex")).toBe("-1");

      t.deactivate({ restoreFocus: false });
      expect(container.getAttribute("tabindex")).toBeNull();
    });

    it("keeps the loan on a container it left while that held focus, until a release on another container finds focus elsewhere", () => {
      let current = container;
      document.body.insertAdjacentHTML(
        "beforeend",
        '<div id="other"><button id="o">O</button></div>',
      );
      const t = new FocusTrap(() => current, { isolate: false, lockScroll: false });
      traps.push(t);
      t.activate();
      t.deactivate({ restoreFocus: false });
      current = byId("other");
      t.activate();
      expect(document.activeElement).toBe(byId("o"));
      expect(container.getAttribute("tabindex")).toBe("-1");

      t.deactivate({ restoreFocus: false });
      expect(container.getAttribute("tabindex")).toBeNull();
    });

    it("keeps the loan of a container that holds focus through turbo:before-cache", () => {
      // The event also fires on a page that stays, where removing the loan would drop
      // focus to <body>.
      const t = trap();
      t.activate();
      expect(document.activeElement).toBe(container);

      document.dispatchEvent(new Event("turbo:before-cache"));

      expect(container.getAttribute("tabindex")).toBe("-1");
      expect(document.activeElement).toBe(container);
      t.deactivate();
    });
  });

  /**
   * A controller hands the trap its `connect()` and `disconnect()`. A disconnect releases an
   * active trap at once. A `tabindex` kept on a container that held focus at a release stays
   * lent across an in-page move (a reconnect in the same batch) and is taken back, once focus
   * is elsewhere, when the controller detaches: at once when its element left the document or
   * lost the identifier, and a microtask later when no reconnect came.
   */
  describe("connect and disconnect", () => {
    let element: HTMLElement;
    /** The controller as the trap sees it: an element and the identifier it registers under. */
    let host: { element: HTMLElement; identifier: string };

    beforeEach(() => {
      container.innerHTML = "<p>Text only</p>";
      container.setAttribute("data-controller", "scope");
      element = container;
      host = { element, identifier: "scope" };
    });

    /** Releases the trap without returning focus, so its container keeps focus and the loan. */
    const keepLoan = (): FocusTrap => {
      const t = trap({ isolate: false, lockScroll: false });
      t.activate();
      t.deactivate({ restoreFocus: false });
      expect(document.activeElement).toBe(container);
      expect(container.getAttribute("tabindex")).toBe("-1");
      return t;
    };

    it("keeps a kept loan when a connect follows the disconnect, an in-page move", async () => {
      const t = keepLoan();
      byId("opener").focus();

      t.disconnect(host);
      t.connect();
      await flushMicrotasks();

      expect(container.getAttribute("tabindex")).toBe("-1");
    });

    it("takes a kept loan back a microtask after a disconnect no connect follows", async () => {
      const t = keepLoan();
      byId("opener").focus();

      t.disconnect(host);
      expect(container.getAttribute("tabindex")).toBe("-1");
      await flushMicrotasks();

      expect(container.getAttribute("tabindex")).toBeNull();
    });

    it("takes a kept loan back at once when the controller's element left the document", () => {
      const t = keepLoan();
      element.remove();

      t.disconnect(host);

      expect(container.getAttribute("tabindex")).toBeNull();
    });

    it("takes a kept loan back at once when data-controller no longer lists the identifier", () => {
      const t = keepLoan();
      byId("opener").focus();
      element.setAttribute("data-controller", "other");

      t.disconnect(host);

      expect(container.getAttribute("tabindex")).toBeNull();
    });

    it("keeps the loan of a container that still holds focus when the controller detaches", async () => {
      const t = keepLoan();
      element.removeAttribute("data-controller");

      t.disconnect(host);
      await flushMicrotasks();

      expect(container.getAttribute("tabindex")).toBe("-1");
    });

    it("takes the loan back once when a detach follows a disconnect whose microtask is still pending", async () => {
      const t = keepLoan();
      byId("opener").focus();
      t.disconnect(host);
      element.setAttribute("data-controller", "other");
      t.disconnect(host);
      expect(container.getAttribute("tabindex")).toBeNull();
      element.setAttribute("data-controller", "scope");
      t.activate();
      expect(container.getAttribute("tabindex")).toBe("-1");
      byId("opener").focus();

      await flushMicrotasks();

      expect(container.getAttribute("tabindex")).toBe("-1");
    });

    /** Activates a trap whose container takes focus on its lent `tabindex`. */
    const activeWithLoan = (): FocusTrap => {
      byId("opener").focus();
      const t = trap({ isolate: false, lockScroll: false });
      t.activate();
      expect(document.activeElement).toBe(container);
      expect(container.getAttribute("tabindex")).toBe("-1");
      return t;
    };

    it("takes back a microtask later the loan an active trap's disconnect kept, once focus left the container", async () => {
      const t = activeWithLoan();

      t.disconnect(host);
      expect(t.active).toBe(false);
      expect(container.getAttribute("tabindex")).toBe("-1");
      byId("opener").focus();
      await flushMicrotasks();

      expect(container.getAttribute("tabindex")).toBeNull();
    });

    it("keeps the loan an active trap's disconnect kept when a connect follows, an in-page move", async () => {
      const t = activeWithLoan();

      t.disconnect(host);
      t.connect();
      byId("opener").focus();
      await flushMicrotasks();

      expect(container.getAttribute("tabindex")).toBe("-1");
    });

    it("releases an active trap at once, without moving focus, though a connect follows", () => {
      byId("opener").focus();
      const t = trap();
      t.activate();
      expect(document.activeElement).toBe(container);
      expect(document.body.style.overflow).toBe("hidden");

      t.disconnect(host);
      t.connect();

      expect(t.active).toBe(false);
      expect(document.body.style.overflow).toBe("");
      expect(document.querySelectorAll("[inert]").length).toBe(0);
      expect(document.activeElement).toBe(container);
    });
  });

  /**
   * The scroll lock is one per document: the first trap that locks scroll saves the
   * page's own `body` overflow, and the last one released gives it back, in whatever
   * order the traps are released.
   */
  describe("scroll lock across traps", () => {
    let other: HTMLElement;

    beforeEach(() => {
      document.body.insertAdjacentHTML("beforeend", '<div id="other"><button>O</button></div>');
      other = byId("other");
      document.body.style.overflow = "scroll";
    });

    const locking = (element: HTMLElement) => {
      const instance = new FocusTrap(() => element, { isolate: false, autoFocus: false });
      traps.push(instance);
      return instance;
    };

    it("keeps the page locked until the last locking trap is released, in any order", () => {
      const first = locking(container);
      const second = locking(other);
      first.activate();
      second.activate();

      first.deactivate({ restoreFocus: false });
      expect(document.body.style.overflow).toBe("hidden");

      second.deactivate({ restoreFocus: false });
      expect(document.body.style.overflow).toBe("scroll");
    });

    it("gives a restored copy that two locking traps left the page's overflow on connect", () => {
      const first = locking(container);
      const second = locking(other);
      first.activate();
      second.activate();
      const restored = document.body.cloneNode(true) as HTMLElement;
      document.body.replaceWith(restored);
      second.deactivate({ restoreFocus: false });
      first.deactivate({ restoreFocus: false });
      expect(restored.style.overflow).toBe("hidden");

      locking(restored.querySelector("#other") as HTMLElement).connect();

      expect(restored.style.overflow).toBe("scroll");
    });

    it("leaves the overflow alone when a trap that does not lock scroll is released", () => {
      const lock = locking(container);
      lock.activate();
      lock.deactivate({ restoreFocus: false });
      document.body.style.overflow = "auto";

      const free = new FocusTrap(() => other, { lockScroll: false, isolate: false });
      traps.push(free);
      free.activate();
      free.deactivate({ restoreFocus: false });

      expect(document.body.style.overflow).toBe("auto");
    });
  });

  /**
   * Focus inside an open shadow root, and a container that sits in one. The way back starts
   * at the element that held focus, followed by the open shadow hosts around it, innermost
   * first; every check of where focus is, and of which container holds it, looks through
   * open shadow roots along the flat tree.
   */
  describe("open shadow roots", () => {
    /** The focused element, looking through open shadow roots. */
    const deepFocus = (): Element | null => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return active;
    };
    /** Appends a host with the `id` to `parent` and gives it an open shadow root holding `html`. */
    const shadowHost = (
      id: string,
      html: string,
      parent: ParentNode = document.body,
    ): ShadowRoot => {
      const host = document.createElement("div");
      host.id = id;
      parent.append(host);
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = html;
      return shadow;
    };
    /** The element with `id` inside `shadow`. */
    const inShadow = (shadow: ShadowRoot, id: string): HTMLElement =>
      shadow.querySelector(`#${id}`) as HTMLElement;
    /** A trap on a container inside a shadow root; scroll stays unlocked. */
    const shadowTrap = (element: HTMLElement, options: FocusTrapOptions = {}): FocusTrap => {
      const instance = new FocusTrap(() => element, { lockScroll: false, ...options });
      traps.push(instance);
      return instance;
    };
    const tab = (): void => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );
    };

    it.each([
      [
        "moves past an opener the engine assigns to no slot, which it renders nowhere",
        false,
        "opener",
      ],
      ["returns focus to an opener the engine assigns to a slot", true, "light"],
    ])("%s", (_, assigned, expected) => {
      document.body.insertAdjacentHTML(
        "beforeend",
        '<div id="wc"><button id="light">Light</button></div>',
      );
      const shadow = byId("wc").attachShadow({ mode: "open" });
      shadow.innerHTML = assigned ? "<slot></slot>" : "<p>No slot</p>";
      // happy-dom does not implement `assignedSlot` or rendering; this is what the engine
      // reports, and happy-dom focuses the element either way.
      Object.defineProperty(byId("light"), "assignedSlot", {
        value: assigned ? shadow.querySelector("slot") : null,
        configurable: true,
      });
      byId("light").focus();
      const t = trap({ fallbackFocus: () => byId("opener") });
      t.activate();
      t.deactivate();
      expect(document.activeElement).toBe(byId(expected));
    });

    it("returns focus to the element inside an open shadow root that held it at activation", () => {
      const shadow = shadowHost(
        "host",
        '<button id="before">Before</button><button id="inner">Inner</button>',
      );
      inShadow(shadow, "inner").focus();
      const t = trap();
      t.activate();
      expect(document.activeElement).toBe(byId("first"));

      t.deactivate();

      expect(deepFocus()).toBe(inShadow(shadow, "inner"));
    });

    it("tries the nearest open host around it first when the element that held focus left with a re-render", () => {
      const outer = shadowHost("outer", "");
      const inner = shadowHost("inner", '<button id="deep">Deep</button>', outer);
      byId("outer").setAttribute("tabindex", "-1");
      inner.host.setAttribute("tabindex", "-1");
      // happy-dom throws reading the shadow root's active element of a focused host that
      // sits in another shadow root, so the inner host hands focus on as it takes it.
      const focusedHosts: string[] = [];
      inner.host.addEventListener("focus", () => {
        focusedHosts.push("inner");
        byId("opener").focus();
      });
      byId("outer").addEventListener("focus", () => focusedHosts.push("outer"));
      inShadow(inner, "deep").focus();
      expect(deepFocus()).toBe(inShadow(inner, "deep"));
      const t = trap();
      t.activate();

      inner.innerHTML = "<button>Rendered again</button>";
      t.deactivate();

      expect(focusedHosts).toEqual(["inner"]);
      expect(document.activeElement).toBe(byId("opener"));
    });

    it("is opened from the trap whose container in an open shadow root holds focus, and takes over its way back when that trap closes first", () => {
      document.body.insertAdjacentHTML("beforeend", '<div id="wrap"></div>');
      const shadow = shadowHost(
        "host",
        '<div id="a-box"><button id="a-btn">A</button></div>',
        byId("wrap"),
      );
      byId("opener").focus();
      const lower = shadowTrap(inShadow(shadow, "a-box"), { isolate: false });
      lower.activate();
      expect(deepFocus()).toBe(inShadow(shadow, "a-btn"));
      const upper = trap({ lockScroll: false, isolate: false });
      upper.activate();
      expect(document.activeElement).toBe(byId("first"));

      lower.deactivate({ restoreFocus: false });
      byId("wrap").hidden = true;
      upper.deactivate();

      expect(document.activeElement).toBe(byId("opener"));
    });

    it("leaves focus in a trap activated after it whose container in an open shadow root holds focus", () => {
      const shadow = shadowHost("host", '<div id="b-box"><button id="b-btn">B</button></div>');
      byId("opener").focus();
      const lower = trap({ lockScroll: false, isolate: false });
      lower.activate();
      const upper = shadowTrap(inShadow(shadow, "b-box"), { isolate: false });
      upper.activate();
      expect(deepFocus()).toBe(inShadow(shadow, "b-btn"));

      lower.deactivate();

      expect(deepFocus()).toBe(inShadow(shadow, "b-btn"));
    });

    it("leaves focus already inside a new container in an open shadow root when it moves onto it", () => {
      const shadow = shadowHost(
        "host",
        '<div id="s-box"><button id="s1">S1</button><button id="s2">S2</button></div>',
      );
      let current = container;
      const t = new FocusTrap(() => current, { lockScroll: false, isolate: false });
      traps.push(t);
      t.activate();
      current = inShadow(shadow, "s-box");
      inShadow(shadow, "s2").focus();

      t.refreshContainer();

      expect(deepFocus()).toBe(inShadow(shadow, "s2"));
    });

    it("moves focus inside when isolating strands it in the shadow tree around its container", () => {
      const shadow = shadowHost(
        "host",
        '<div id="wrap"><button id="aside">Aside</button><div id="s-box"><button id="s1">S1</button></div></div>',
      );
      let isolate = false;
      const t = shadowTrap(inShadow(shadow, "s-box"), { isolate: () => isolate, autoFocus: false });
      t.activate();
      inShadow(shadow, "aside").focus();

      isolate = true;
      t.refreshIsolation();

      expect(inShadow(shadow, "aside").inert).toBe(true);
      expect(deepFocus()).toBe(inShadow(shadow, "s1"));
    });

    it("makes the page around the host inert for a container inside an open shadow root, and releases it", () => {
      const shadow = shadowHost(
        "host",
        '<p id="s-aside">Aside</p><div id="s-box"><button id="s1">S1</button></div>',
      );
      const t = shadowTrap(inShadow(shadow, "s-box"));
      t.activate();

      expect(["background", "opener", "box"].map((id) => byId(id).inert)).toEqual([
        true,
        true,
        true,
      ]);
      expect(byId("host").inert).toBe(false);
      expect(inShadow(shadow, "s-aside").inert).toBe(true);
      expect(inShadow(shadow, "s-box").inert).toBe(false);

      t.deactivate({ restoreFocus: false });
      expect(document.querySelectorAll("[inert]").length).toBe(0);
      expect(inShadow(shadow, "s-aside").inert).toBe(false);
    });

    it("makes the rest of the shadow tree inert for a container slotted into it", () => {
      document.body.insertAdjacentHTML(
        "beforeend",
        '<div id="shell"><div id="slotted-box"><button id="in">In</button></div></div>',
      );
      const shadow = byId("shell").attachShadow({ mode: "open" });
      shadow.innerHTML = '<header id="chrome"><button>Menu</button></header><slot></slot>';
      // happy-dom does not implement `assignedSlot`; this is the slot the engine reports.
      Object.defineProperty(byId("slotted-box"), "assignedSlot", {
        value: shadow.querySelector("slot"),
        configurable: true,
      });
      const t = shadowTrap(byId("slotted-box"));
      t.activate();

      expect(inShadow(shadow, "chrome").inert).toBe(true);
      expect((shadow.querySelector("slot") as HTMLElement).inert).toBe(false);
      expect(["box", "shell", "slotted-box"].map((id) => byId(id).inert)).toEqual([
        true,
        false,
        false,
      ]);
    });

    it("passes Tab to the trap below while the host of the newer trap's container is hidden", () => {
      const shadow = shadowHost(
        "host",
        '<div id="s-box"><button id="s1">S1</button><button id="s2">S2</button></div>',
      );
      const lower = trap({ lockScroll: false, isolate: false });
      lower.activate();
      const upper = shadowTrap(inShadow(shadow, "s-box"), { isolate: false });
      upper.activate();
      byId("host").hidden = true;
      byId("first").focus();

      tab();

      expect(document.activeElement).toBe(byId("last"));
    });
  });
});

/**
 * The traps' side effects and Turbo's cache. `turbo:before-cache` also fires on pages
 * that stay, so an active trap keeps every side effect through it. A page Turbo restores
 * is a clone that may carry the `inert` and the scroll lock of a trap that was active when
 * it was copied; the traps mark what they change, so the next trap that connects or
 * activates can tell those leftovers from what the author wrote and release them.
 */
describe("FocusTrap and the Turbo cache", () => {
  const INERT_MARK = "data-stimeo-focus-trap-inert";
  const OVERFLOW_MARK = "data-stimeo-focus-trap-overflow";
  const LOAN_MARK = "data-stimeo-focus-trap-tabindex-loan";
  let traps: FocusTrap[];

  beforeEach(() => {
    traps = [];
    document.body.setAttribute("style", "overflow: scroll");
    document.body.innerHTML = `
      <p id="background">Background</p>
      <div id="box"><button id="first">First</button></div>
      <div id="other"><button id="other-first">Other</button></div>`;
  });

  afterEach(() => {
    for (const activeTrap of traps) activeTrap.deactivate({ restoreFocus: false });
    document.body.innerHTML = "";
    document.body.removeAttribute("style");
    document.body.removeAttribute(OVERFLOW_MARK);
  });

  const trapOn = (id: string, options: FocusTrapOptions = {}): FocusTrap => {
    const instance = new FocusTrap(() => document.getElementById(id) as HTMLElement, options);
    traps.push(instance);
    return instance;
  };
  const byId = (id: string) => document.getElementById(id) as HTMLElement;

  /** Puts a deep clone of the live `<body>` in its place, as Turbo renders a cached page. */
  const restore = (): HTMLElement => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    document.body.replaceWith(clone);
    return clone;
  };

  it("keeps an active trap's background, scroll lock, Escape and Tab through turbo:before-cache", () => {
    let escapes = 0;
    const t = trapOn("box", { onEscape: () => escapes++ });
    t.activate();

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(t.active).toBe(true);
    expect(byId("background").inert).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(escapes).toBe(1);
    byId("first").focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    byId("first").dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
  });

  it("subscribes to no turbo:before-cache", () => {
    const add = vi.spyOn(document, "addEventListener");
    trapOn("box").activate();

    expect(add.mock.calls.filter(([type]) => type === "turbo:before-cache")).toHaveLength(0);
    add.mockRestore();
  });

  it("marks the inert it applies and the overflow it saves, and removes both on release", () => {
    const t = trapOn("box");
    t.activate();
    expect(byId("background").getAttribute(INERT_MARK)).toBe("");
    expect(document.body.getAttribute(OVERFLOW_MARK)).toBe("scroll");

    t.deactivate({ restoreFocus: false });

    expect(byId("background").hasAttribute(INERT_MARK)).toBe(false);
    expect(document.body.hasAttribute(OVERFLOW_MARK)).toBe(false);
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("releases on connect the inert and the scroll lock a restored copy carries", () => {
    const left = trapOn("box");
    left.activate();
    const restored = restore();
    left.deactivate({ restoreFocus: false });
    expect(byId("background").inert).toBe(true);
    expect(restored.style.overflow).toBe("hidden");

    trapOn("box").connect();

    expect(byId("background").inert).toBe(false);
    expect(byId("background").hasAttribute(INERT_MARK)).toBe(false);
    expect(restored.style.overflow).toBe("scroll");
    expect(restored.hasAttribute(OVERFLOW_MARK)).toBe(false);
  });

  it("takes the inert and the scroll lock a restored copy carries as no one's when it activates", () => {
    const left = trapOn("box");
    left.activate();
    const restored = restore();
    left.deactivate({ restoreFocus: false });
    const next = trapOn("box");

    next.activate();
    expect(byId("background").inert).toBe(true);
    expect(restored.style.overflow).toBe("hidden");
    next.deactivate({ restoreFocus: false });

    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    expect(restored.style.overflow).toBe("scroll");
    expect(restored.hasAttribute(OVERFLOW_MARK)).toBe(false);
  });

  it.each(["light", "open shadow", "nested open shadow"])(
    "releases copied inert marks in %s while retaining active and authored inert",
    (location) => {
      const shell = document.createElement("div");
      document.body.append(shell);
      let scope: ParentNode = shell;
      if (location !== "light") scope = shell.attachShadow({ mode: "open" });
      if (location === "nested open shadow") {
        const inner = document.createElement("div");
        scope.append(inner);
        scope = inner.attachShadow({ mode: "open" });
      }
      const active = trapOn("box");
      active.activate();
      const copied = document.createElement("p");
      copied.inert = true;
      copied.setAttribute(INERT_MARK, "");
      const authored = document.createElement("p");
      authored.inert = true;
      scope.append(copied, authored);
      expect(copied.inert).toBe(true);
      expect(copied.hasAttribute(INERT_MARK)).toBe(true);

      trapOn("other").connect();

      expect(copied.inert).toBe(false);
      expect(copied.hasAttribute(INERT_MARK)).toBe(false);
      expect(authored.inert).toBe(true);
      expect(authored.hasAttribute(INERT_MARK)).toBe(false);
      expect(byId("background").inert).toBe(true);
      expect(byId("background").hasAttribute(INERT_MARK)).toBe(true);
    },
  );

  it.each(["the later one", "the earlier one"])(
    "gives the page its overflow back once a morph reset the body under a held lock, %s released first",
    (first) => {
      const earlier = trapOn("box", { isolate: false, autoFocus: false });
      const later = trapOn("other", { isolate: false, autoFocus: false });
      earlier.activate();
      // Turbo's morph keeps only the attributes the server sent: the mark goes with the style.
      document.body.setAttribute("style", "overflow: auto");
      document.body.removeAttribute(OVERFLOW_MARK);
      later.activate();
      const [releasedFirst, releasedLast] =
        first === "the later one" ? [later, earlier] : [earlier, later];

      releasedFirst.deactivate({ restoreFocus: false });
      expect(document.body.style.overflow).toBe("hidden");
      releasedLast.deactivate({ restoreFocus: false });

      expect(document.body.style.overflow).toBe("auto");
      expect(document.body.hasAttribute(OVERFLOW_MARK)).toBe(false);
    },
  );

  it("makes the background inert again once a morph took the inert a trap applied, when the next trap activates", () => {
    const earlier = trapOn("box", { autoFocus: false });
    earlier.activate();
    // Turbo's morph keeps only the attributes the server sent: the mark goes with the inert.
    for (const id of ["background", "other"]) {
      byId(id).removeAttribute("inert");
      byId(id).removeAttribute(INERT_MARK);
    }

    trapOn("other", { autoFocus: false }).activate();

    expect([byId("background").inert, byId("box").inert]).toEqual([true, true]);
    expect([
      byId("background").hasAttribute(INERT_MARK),
      byId("box").hasAttribute(INERT_MARK),
    ]).toEqual([true, true]);
    for (const activeTrap of [...traps].reverse()) activeTrap.deactivate({ restoreFocus: false });
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    expect(document.querySelectorAll(`[${INERT_MARK}]`)).toHaveLength(0);
  });

  it.each(["released alone", "released after the next trap activated"])(
    "leaves an inert the morph kept from the server's markup on an element a trap had made inert, %s",
    (path) => {
      const earlier = trapOn("box", { autoFocus: false });
      earlier.activate();
      // The server's markup makes the element inert, so the morph keeps `inert` and drops the mark.
      byId("background").removeAttribute(INERT_MARK);
      if (path !== "released alone") {
        trapOn("other", { autoFocus: false }).activate();
        expect(byId("background").hasAttribute(INERT_MARK)).toBe(false);
      }

      for (const activeTrap of [...traps].reverse()) activeTrap.deactivate({ restoreFocus: false });

      expect(byId("background").inert).toBe(true);
      expect([byId("box").inert, byId("other").inert]).toEqual([false, false]);
    },
  );

  describe("a Turbo morph while a trap is active", () => {
    /** What Turbo's morph does to the side effects: it keeps only the attributes the server sent. */
    const morphAway = (overflow = "auto"): void => {
      for (const id of ["background", "other"]) {
        byId(id).removeAttribute("inert");
        byId(id).removeAttribute(INERT_MARK);
      }
      document.body.setAttribute("style", `overflow: ${overflow}`);
      document.body.removeAttribute(OVERFLOW_MARK);
    };
    const morphed = async (target: Element = document.documentElement): Promise<void> => {
      target.dispatchEvent(new CustomEvent("turbo:morph", { bubbles: true }));
      await Promise.resolve();
    };

    it.each([
      ["turbo:morph", () => document.documentElement],
      ["turbo:morph-element", () => document.body],
    ] as const)(
      "makes the background inert and locks the scroll again after %s",
      async (type, target) => {
        const t = trapOn("box", { autoFocus: false });
        t.activate();
        morphAway();

        target().dispatchEvent(new CustomEvent(type, { bubbles: true }));
        await Promise.resolve();

        expect([byId("background").inert, byId("other").inert]).toEqual([true, true]);
        expect(byId("background").hasAttribute(INERT_MARK)).toBe(true);
        expect(document.body.style.overflow).toBe("hidden");
        expect(document.body.getAttribute(OVERFLOW_MARK)).toBe("auto");

        t.deactivate({ restoreFocus: false });
        expect(document.querySelectorAll("[inert]")).toHaveLength(0);
        expect(document.body.style.overflow).toBe("auto");
        expect(document.body.hasAttribute(OVERFLOW_MARK)).toBe(false);
      },
    );

    it("keeps the background and the lock of a nested trap stack, and releases them in turn", async () => {
      const earlier = trapOn("box", { autoFocus: false });
      earlier.activate();
      const later = trapOn("other", { autoFocus: false });
      later.activate();
      morphAway();
      byId("box").removeAttribute("inert");
      byId("box").removeAttribute(INERT_MARK);

      await morphed();

      expect([byId("background").inert, byId("box").inert]).toEqual([true, true]);
      expect(document.body.style.overflow).toBe("hidden");
      later.deactivate({ restoreFocus: false });
      expect([byId("background").inert, byId("box").inert]).toEqual([true, false]);
      expect(document.body.style.overflow).toBe("hidden");
      earlier.deactivate({ restoreFocus: false });
      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
      expect(document.body.style.overflow).toBe("auto");
    });

    it("leaves an inert the server sends with the morph untracked, so the release leaves it too", async () => {
      const t = trapOn("box", { autoFocus: false });
      t.activate();
      // The server's markup makes the element inert: the morph keeps it and drops the mark.
      byId("background").removeAttribute(INERT_MARK);

      await morphed();

      expect(byId("background").inert).toBe(true);
      expect(byId("background").hasAttribute(INERT_MARK)).toBe(false);
      t.deactivate({ restoreFocus: false });
      expect(byId("background").inert).toBe(true);
    });

    it("leaves the page alone on a morph once no trap is active", async () => {
      const t = trapOn("box", { autoFocus: false });
      t.activate();
      t.deactivate({ restoreFocus: false });
      document.body.setAttribute("style", "overflow: auto");

      await morphed();

      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
      expect(document.body.style.overflow).toBe("auto");
      expect(document.body.hasAttribute(OVERFLOW_MARK)).toBe(false);
    });

    it("removes the morph listener with the last trap", () => {
      const removed = vi.spyOn(document, "removeEventListener");
      const earlier = trapOn("box", { autoFocus: false });
      const later = trapOn("other", { autoFocus: false });
      earlier.activate();
      later.activate();
      later.deactivate({ restoreFocus: false });
      expect(removed.mock.calls.map(([type]) => type)).not.toContain("turbo:morph");

      earlier.deactivate({ restoreFocus: false });

      const types = removed.mock.calls.map(([type]) => type);
      expect(types).toContain("turbo:morph");
      expect(types).toContain("turbo:morph-element");
      removed.mockRestore();
    });

    it("locks nothing again after a morph for a trap that does not lock the scroll", async () => {
      const t = trapOn("box", { autoFocus: false, lockScroll: false });
      t.activate();
      morphAway();

      await morphed();

      expect(byId("background").inert).toBe(true);
      expect(document.body.style.overflow).toBe("auto");
      expect(document.body.hasAttribute(OVERFLOW_MARK)).toBe(false);
      t.deactivate({ restoreFocus: false });
    });

    it("re-applies once per burst of morph events", async () => {
      const t = trapOn("box", { autoFocus: false });
      t.activate();
      morphAway();
      const setAttribute = vi.spyOn(byId("background"), "setAttribute");

      for (const element of [document.body, byId("background"), document.documentElement]) {
        element.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      }
      await Promise.resolve();

      expect(setAttribute.mock.calls.filter(([name]) => name === INERT_MARK)).toHaveLength(1);
      t.deactivate({ restoreFocus: false });
    });
  });

  it("gives the overflow back to the body it locked, though another body has taken its place", () => {
    const t = trapOn("box");
    t.activate();
    const locked = document.body;
    const replacement = document.createElement("body");
    replacement.setAttribute("style", "overflow: auto");
    locked.replaceWith(replacement);

    t.deactivate({ restoreFocus: false });

    expect(locked.style.overflow).toBe("scroll");
    expect(locked.hasAttribute(OVERFLOW_MARK)).toBe(false);
    expect(replacement.style.overflow).toBe("auto");
  });

  it("leaves the marks of a trap that is still active alone when another one connects", () => {
    const active = trapOn("box");
    active.activate();

    trapOn("other").connect();

    expect(byId("background").inert).toBe(true);
    expect(byId("background").getAttribute(INERT_MARK)).toBe("");
    expect(document.body.style.overflow).toBe("hidden");
    active.deactivate({ restoreFocus: false });
    expect(byId("background").inert).toBe(false);
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("keeps on connect the tabindex lent to a restored container that holds focus", () => {
    byId("box").innerHTML = "Text only";
    const left = trapOn("box");
    left.activate();
    restore();
    left.deactivate({ restoreFocus: false });
    byId("box").focus();
    expect(document.activeElement).toBe(byId("box"));

    trapOn("box").connect();

    expect(byId("box").getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(byId("box"));
  });

  it("gives back on connect the tabindex a restored copy carries on a container the trap moved off", () => {
    byId("box").innerHTML = "Text only";
    byId("other").innerHTML = "Text only too";
    let container = "box";
    const moving = new FocusTrap(() => byId(container), { lockScroll: false });
    traps.push(moving);
    moving.activate();
    expect(byId("box").getAttribute(LOAN_MARK)).toBe("-1");
    expect(document.activeElement).toBe(byId("box"));
    container = "other";
    moving.refreshContainer();
    // The loan on the container that held focus at the move stays for now.
    expect(byId("box").getAttribute("tabindex")).toBe("-1");
    restore();
    moving.deactivate({ restoreFocus: false });

    trapOn("other").connect();

    expect(byId("box").hasAttribute("tabindex")).toBe(false);
    expect(byId("box").hasAttribute(LOAN_MARK)).toBe(false);
  });

  it("gives back on connect the tabindex lent to a restored container", () => {
    byId("box").innerHTML = "Text only";
    const left = trapOn("box");
    left.activate();
    expect(byId("box").getAttribute(LOAN_MARK)).toBe("-1");
    restore();
    left.deactivate({ restoreFocus: false });
    expect(byId("box").getAttribute("tabindex")).toBe("-1");

    trapOn("box").connect();

    expect(byId("box").hasAttribute("tabindex")).toBe(false);
    expect(byId("box").hasAttribute(LOAN_MARK)).toBe(false);
  });
});
