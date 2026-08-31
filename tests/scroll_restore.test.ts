import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollRestoreController } from "../src/controllers/scroll_restore_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ScrollRestoreController}: restore on connect,
 * rAF-coalesced save on scroll, `key`/`id` namespacing, per-axis tracking,
 * multi-instance isolation, and the synchronous flush + teardown on disconnect.
 *
 * `scroll` is dispatched to drive the rAF-coalesced save; happy-dom exposes
 * `sessionStorage`, element `scrollTop`/`scrollLeft`, and `requestAnimationFrame`.
 */

// The controller persists inside a requestAnimationFrame; waiting one frame is
// deterministic (the persist callback was queued first, so it runs before this one)
// and avoids a fixed timeout that could be slow or race the rAF.
const settle = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

describe("ScrollRestoreController", () => {
  let application: Application;

  /** Renders the markup without starting Stimulus, so the element can be patched. */
  const mount = (html: string) => {
    document.body.innerHTML = html;
  };

  const boot = async () => {
    application = Application.start();
    application.register("stimeo--scroll-restore", ScrollRestoreController);
    await tick();
  };

  const start = async (html: string) => {
    mount(html);
    await boot();
  };

  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    sessionStorage.clear();
  });

  const box = (id = "box") => document.getElementById(id) as HTMLElement;
  const stored = (key: string) => {
    const raw = sessionStorage.getItem(`stimeo--scroll-restore:${key}`);
    return raw === null ? null : JSON.parse(raw);
  };

  const markup = (key = "sidebar") => `
    <div id="box" data-controller="stimeo--scroll-restore"
         data-stimeo--scroll-restore-key-value="${key}">content</div>`;

  /**
   * Stands in for a real engine clamping a restore to the reachable range, which
   * happy-dom does not model: it stores whatever offset it is given.
   */
  const clampTo = (element: HTMLElement, axis: "scrollTop" | "scrollLeft", max: number) => {
    let position = 0;
    Object.defineProperty(element, axis, {
      configurable: true,
      get: () => position,
      set: (next: number) => {
        position = Math.min(next, max);
      },
    });
  };

  /** Stands in for a browser that throws on storage access (private mode, quota). */
  const blockStorage = () => {
    // An own descriptor is what the property has here, but the accessor can also
    // live on the prototype — then there is nothing to put back and the property
    // has to be deleted instead, or the restore itself throws.
    const descriptor = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("storage unavailable");
      },
    });
    return () => {
      if (descriptor) Object.defineProperty(window, "sessionStorage", descriptor);
      else Reflect.deleteProperty(window, "sessionStorage");
    };
  };

  it("restores the saved vertical position on connect", async () => {
    sessionStorage.setItem("stimeo--scroll-restore:sidebar", JSON.stringify({ top: 240 }));
    await start(markup());
    expect(box().scrollTop).toBe(240);
  });

  it("saves the position on scroll (coalesced through rAF)", async () => {
    await start(markup());
    box().scrollTop = 180;
    box().dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("sidebar")).toEqual({ top: 180 });
  });

  it("falls back to the element id when no key is set", async () => {
    await start(`<div id="list" data-controller="stimeo--scroll-restore">content</div>`);
    box("list").scrollTop = 90;
    box("list").dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("list")).toEqual({ top: 90 });
  });

  it("does nothing when there is neither a key nor an id", async () => {
    await start(`<div data-controller="stimeo--scroll-restore">content</div>`);
    const el = document.querySelector<HTMLElement>(
      "[data-controller='stimeo--scroll-restore']",
    ) as HTMLElement;
    el.scrollTop = 50;
    el.dispatchEvent(new Event("scroll"));
    await settle();
    expect(sessionStorage.length).toBe(0);

    // The teardown flush has to honour the same rule: an empty key would collect
    // every keyless instance on every page under one entry.
    const controller = application.getControllerForElementAndIdentifier(
      el,
      "stimeo--scroll-restore",
    );
    controller?.disconnect();
    expect(sessionStorage.length).toBe(0);
  });

  it("tracks only the horizontal axis when axis is 'horizontal'", async () => {
    await start(`
      <div id="box" data-controller="stimeo--scroll-restore"
           data-stimeo--scroll-restore-key-value="row"
           data-stimeo--scroll-restore-axis-value="horizontal">content</div>`);
    box().scrollLeft = 320;
    box().scrollTop = 99;
    box().dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("row")).toEqual({ left: 320 });
  });

  it("restores only the configured axis, ignoring a stale field from another axis", async () => {
    // axis defaults to vertical; a stored `left` (e.g. after switching axis) must
    // not be applied to scrollLeft.
    sessionStorage.setItem("stimeo--scroll-restore:sidebar", JSON.stringify({ top: 70, left: 90 }));
    await start(markup());
    expect(box().scrollTop).toBe(70);
    expect(box().scrollLeft).toBe(0);
  });

  it("tracks and restores both axes when axis is 'both'", async () => {
    sessionStorage.setItem("stimeo--scroll-restore:pane", JSON.stringify({ top: 12, left: 34 }));
    await start(`
      <div id="box" data-controller="stimeo--scroll-restore"
           data-stimeo--scroll-restore-key-value="pane"
           data-stimeo--scroll-restore-axis-value="both">content</div>`);
    expect(box().scrollTop).toBe(12);
    expect(box().scrollLeft).toBe(34);
  });

  it("keeps multiple instances isolated by key", async () => {
    await start(`
      <div id="a" data-controller="stimeo--scroll-restore"
           data-stimeo--scroll-restore-key-value="a">a</div>
      <div id="b" data-controller="stimeo--scroll-restore"
           data-stimeo--scroll-restore-key-value="b">b</div>`);
    box("a").scrollTop = 100;
    box("a").dispatchEvent(new Event("scroll"));
    box("b").scrollTop = 200;
    box("b").dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("a")).toEqual({ top: 100 });
    expect(stored("b")).toEqual({ top: 200 });
  });

  it("flushes the last captured position synchronously on disconnect", async () => {
    await start(markup());
    const controller = application.getControllerForElementAndIdentifier(
      box(),
      "stimeo--scroll-restore",
    );
    box().scrollTop = 410;
    box().dispatchEvent(new Event("scroll")); // captured into cache; rAF still pending
    controller?.disconnect(); // flush before the rAF fires
    expect(stored("sidebar")).toEqual({ top: 410 });
  });

  it("does not overwrite the saved position with 0 when the element reads 0 at teardown", async () => {
    // Turbo detaches the node before disconnect, so a fresh scrollTop read is 0.
    // The flush must persist the captured value.
    await start(markup());
    box().scrollTop = 260;
    box().dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("sidebar")).toEqual({ top: 260 });

    const controller = application.getControllerForElementAndIdentifier(
      box(),
      "stimeo--scroll-restore",
    );
    box().scrollTop = 0; // simulate the detached element reporting 0 (no scroll event)
    controller?.disconnect();
    expect(stored("sidebar")).toEqual({ top: 260 });
  });

  it("stops saving after disconnect", async () => {
    await start(markup());
    const controller = application.getControllerForElementAndIdentifier(
      box(),
      "stimeo--scroll-restore",
    );
    controller?.disconnect();
    sessionStorage.clear();
    box().scrollTop = 999;
    box().dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("sidebar")).toBeNull();
  });

  it("ignores malformed stored data without throwing", async () => {
    sessionStorage.setItem("stimeo--scroll-restore:sidebar", "not json");
    await start(markup());
    expect(box().scrollTop).toBe(0);
  });

  it("restores through an instant scroll so consumer CSS cannot animate it", async () => {
    sessionStorage.setItem("stimeo--scroll-restore:sidebar", JSON.stringify({ top: 240 }));
    mount(markup());
    const scrollTo = vi.spyOn(box(), "scrollTo");
    await boot();
    // A plain `scrollTop` assignment follows the element's computed
    // `scroll-behavior`, so a consumer asking for smooth scrolling would get an
    // animated restore that reports intermediate offsets as if they were the
    // reader's own scrolling.
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.calls[0]?.[0]).toMatchObject({ top: 240, behavior: "instant" });
    scrollTo.mockRestore();
  });

  it("keeps the saved position when the restore lands short of it", async () => {
    sessionStorage.setItem("stimeo--scroll-restore:sidebar", JSON.stringify({ top: 5000 }));
    mount(markup());
    clampTo(box(), "scrollTop", 50); // not tall enough yet (images, fonts, async rows)
    await boot();

    // The clamp moves the element, so the engine fires a scroll for the
    // controller's own write. Taking that as the reader's position would cut the
    // saved offset down to whatever the unfinished layout allowed.
    box().dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("sidebar")).toEqual({ top: 5000 });
  });

  it("keeps the saved position when a horizontal restore lands short of it", async () => {
    sessionStorage.setItem("stimeo--scroll-restore:row", JSON.stringify({ left: 5000 }));
    mount(`
      <div id="box" data-controller="stimeo--scroll-restore"
           data-stimeo--scroll-restore-key-value="row"
           data-stimeo--scroll-restore-axis-value="horizontal">content</div>`);
    clampTo(box(), "scrollLeft", 50);
    await boot();

    box().dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("row")).toEqual({ left: 5000 });
  });

  it("does not scroll when the stored entry holds nothing for the tracked axis", async () => {
    // Asking the element to scroll with neither offset set still moves nothing,
    // but it is a write the engine reports back as a scroll. Nothing was
    // restored, so there is nothing to report.
    sessionStorage.setItem("stimeo--scroll-restore:pane", JSON.stringify({ left: 900 }));
    mount(`
      <div id="box" data-controller="stimeo--scroll-restore"
           data-stimeo--scroll-restore-key-value="pane">content</div>`);
    const scrollTo = vi.spyOn(box(), "scrollTo");
    await boot();

    expect(scrollTo).not.toHaveBeenCalled();
    scrollTo.mockRestore();
  });

  it("keeps the other axis when only one of a both-axis pair is scrolled", async () => {
    // A scroll event names no axis. Consuming both echoes on the first one to
    // arrive would leave the untouched axis holding whatever the unfinished
    // layout clamped it to, and save that as the reader's own position.
    sessionStorage.setItem("stimeo--scroll-restore:pane", JSON.stringify({ top: 5000, left: 900 }));
    mount(`
      <div id="box" data-controller="stimeo--scroll-restore"
           data-stimeo--scroll-restore-key-value="pane"
           data-stimeo--scroll-restore-axis-value="both">content</div>`);
    clampTo(box(), "scrollTop", 50);
    clampTo(box(), "scrollLeft", 10);
    await boot();

    box().dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("pane")).toEqual({ top: 5000, left: 900 });

    // The reader moves vertically only. The horizontal offset they never touched
    // must survive, even though the element reads it back clamped.
    box().scrollTop = 30;
    box().dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("pane")).toEqual({ top: 30, left: 900 });
  });

  it("keeps the other axis when only the horizontal one is scrolled", async () => {
    sessionStorage.setItem("stimeo--scroll-restore:pane", JSON.stringify({ top: 5000, left: 900 }));
    mount(`
      <div id="box" data-controller="stimeo--scroll-restore"
           data-stimeo--scroll-restore-key-value="pane"
           data-stimeo--scroll-restore-axis-value="both">content</div>`);
    clampTo(box(), "scrollTop", 50);
    clampTo(box(), "scrollLeft", 10);
    await boot();

    box().dispatchEvent(new Event("scroll"));
    await settle();

    box().scrollLeft = 8;
    box().dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("pane")).toEqual({ top: 5000, left: 8 });
  });

  it("does not carry an offset from the previous key into the new namespace", async () => {
    // The cached offsets belong to the key that was in force when they were
    // taken. A restore under the new key only seeds the axes it has a value for,
    // so anything kept would be written as if the reader had left it there.
    sessionStorage.setItem("stimeo--scroll-restore:a", JSON.stringify({ top: 5000, left: 900 }));
    sessionStorage.setItem("stimeo--scroll-restore:b", JSON.stringify({ top: 100 }));
    mount(`
      <div id="box" data-controller="stimeo--scroll-restore"
           data-stimeo--scroll-restore-key-value="a"
           data-stimeo--scroll-restore-axis-value="both">content</div>`);
    clampTo(box(), "scrollTop", 50);
    clampTo(box(), "scrollLeft", 10);
    await boot();

    box().setAttribute("data-stimeo--scroll-restore-key-value", "b");
    await settle();
    application.getControllerForElementAndIdentifier(box(), "stimeo--scroll-restore")?.disconnect();

    expect(stored("b")).toEqual({ top: 100 });
  });

  it("writes nothing under a key the reader never scrolled under", async () => {
    sessionStorage.setItem("stimeo--scroll-restore:a", JSON.stringify({ top: 400 }));
    await start(`
      <div id="box" data-controller="stimeo--scroll-restore"
           data-stimeo--scroll-restore-key-value="a">content</div>`);

    box().setAttribute("data-stimeo--scroll-restore-key-value", "fresh");
    await settle();
    application.getControllerForElementAndIdentifier(box(), "stimeo--scroll-restore")?.disconnect();

    expect(sessionStorage.getItem("stimeo--scroll-restore:fresh")).toBeNull();
  });

  it("saves nothing from a stored entry that holds no offset for the tracked axis", async () => {
    sessionStorage.setItem("stimeo--scroll-restore:pane", JSON.stringify({ left: 900 }));
    await start(`
      <div id="box" data-controller="stimeo--scroll-restore"
           data-stimeo--scroll-restore-key-value="pane">content</div>`);
    const controller = application.getControllerForElementAndIdentifier(
      box(),
      "stimeo--scroll-restore",
    );
    controller?.disconnect();
    // Nothing was restored and nothing was scrolled, so the entry keeps the shape
    // it had rather than gaining a `top` the reader never produced.
    expect(stored("pane")).toEqual({ left: 900 });
  });

  it("drops a save queued before teardown", async () => {
    await start(markup());
    box().scrollTop = 410;
    box().dispatchEvent(new Event("scroll")); // queues the coalesced write
    const controller = application.getControllerForElementAndIdentifier(
      box(),
      "stimeo--scroll-restore",
    );
    controller?.disconnect(); // flushes, and the queued frame must not outlive it
    expect(stored("sidebar")).toEqual({ top: 410 });

    sessionStorage.clear();
    await settle();
    expect(sessionStorage.length).toBe(0);
  });

  it("survives a stored JSON literal null and keeps saving", async () => {
    sessionStorage.setItem("stimeo--scroll-restore:sidebar", "null");
    await start(markup());
    // `JSON.parse` returns `null` without throwing, so the parse guard does not
    // catch it; reading a field off it must not abort the rest of connect.
    box().scrollTop = 150;
    box().dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("sidebar")).toEqual({ top: 150 });
  });

  it("ignores a stored offset that is not a finite number", async () => {
    sessionStorage.setItem("stimeo--scroll-restore:sidebar", '{"top":1e999}');
    await start(markup());
    // JSON carries out-of-range literals as Infinity, which is not a position.
    expect(box().scrollTop).toBe(0);
  });

  it("switches namespace when the key changes at runtime", async () => {
    sessionStorage.setItem("stimeo--scroll-restore:new", JSON.stringify({ top: 555 }));
    await start(markup("old"));
    box().scrollTop = 100;
    box().dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("old")).toEqual({ top: 100 });

    // A Turbo morph rewrites the attribute in place, so connect never runs again.
    box().setAttribute("data-stimeo--scroll-restore-key-value", "new");
    await tick();
    expect(box().scrollTop).toBe(555);

    box().scrollTop = 600;
    box().dispatchEvent(new Event("scroll"));
    await settle();
    expect(stored("new")).toEqual({ top: 600 });
    expect(stored("old")).toEqual({ top: 100 }); // the old namespace is left alone
  });

  it("re-derives the tracked axes when axis changes at runtime", async () => {
    sessionStorage.setItem("stimeo--scroll-restore:pane", JSON.stringify({ top: 12, left: 34 }));
    await start(`
      <div id="box" data-controller="stimeo--scroll-restore"
           data-stimeo--scroll-restore-key-value="pane">content</div>`);
    expect(box().scrollLeft).toBe(0); // vertical by default

    box().setAttribute("data-stimeo--scroll-restore-axis-value", "both");
    await tick();
    expect(box().scrollLeft).toBe(34);
  });

  it("keeps the saved offset of an axis it no longer tracks", async () => {
    sessionStorage.setItem("stimeo--scroll-restore:pane", JSON.stringify({ top: 12, left: 900 }));
    await start(`
      <div id="box" data-controller="stimeo--scroll-restore"
           data-stimeo--scroll-restore-key-value="pane">content</div>`);
    box().scrollTop = 20;
    box().dispatchEvent(new Event("scroll"));
    await settle();
    // An offset for an untracked axis is not applied, which reads as "left where
    // it is" rather than "discarded on the next save".
    expect(stored("pane")).toEqual({ top: 20, left: 900 });
  });

  it("writes nothing for an element that was never restored or scrolled", async () => {
    await start(markup());
    const controller = application.getControllerForElementAndIdentifier(
      box(),
      "stimeo--scroll-restore",
    );
    controller?.disconnect();
    // Turning "no saved position" into "saved position 0" is a write nobody asked for.
    expect(sessionStorage.length).toBe(0);
  });

  it("coalesces a burst of scrolls into a single write", async () => {
    await start(markup());
    const serialize = vi.spyOn(JSON, "stringify");
    for (const top of [10, 20, 30, 40, 50]) {
      box().scrollTop = top;
      box().dispatchEvent(new Event("scroll"));
    }
    await settle();
    // `#persist` is the only caller of `JSON.stringify` on this path; happy-dom's
    // Storage is a Proxy, so `setItem` itself cannot be spied on.
    expect(serialize).toHaveBeenCalledTimes(1);
    serialize.mockRestore();
    expect(stored("sidebar")).toEqual({ top: 50 });
  });

  it("re-persists the restored position when torn down before any scroll", async () => {
    sessionStorage.setItem("stimeo--scroll-restore:sidebar", JSON.stringify({ top: 240 }));
    await start(markup());
    const controller = application.getControllerForElementAndIdentifier(
      box(),
      "stimeo--scroll-restore",
    );
    controller?.disconnect();
    expect(stored("sidebar")).toEqual({ top: 240 });
  });

  it("keeps working when storage cannot be read", async () => {
    const release = blockStorage();
    try {
      mount(markup());
      await boot();
      expect(box().scrollTop).toBe(0);
      box().scrollTop = 70;
      expect(() => box().dispatchEvent(new Event("scroll"))).not.toThrow();
      await settle();
    } finally {
      release();
    }
    expect(sessionStorage.length).toBe(0);
  });

  it("keeps working when storage cannot be written", async () => {
    await start(markup());
    const release = blockStorage();
    try {
      box().scrollTop = 70;
      box().dispatchEvent(new Event("scroll"));
      await settle();
    } finally {
      release();
    }
    expect(sessionStorage.length).toBe(0);
  });

  it("does not move focus while restoring", async () => {
    sessionStorage.setItem("stimeo--scroll-restore:sidebar", JSON.stringify({ top: 240 }));
    mount(`<button id="elsewhere">elsewhere</button>${markup()}`);
    const button = document.getElementById("elsewhere") as HTMLButtonElement;
    button.focus();
    await boot();
    // Restoring never moves focus, which is what keeps focus order intact.
    expect(document.activeElement).toBe(button);
    expect(box().scrollTop).toBe(240);
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(markup());
    await expectNoA11yViolations(box());
  });
});
