import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrollAreaController } from "../src/controllers/scroll_area_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ScrollAreaController}: overflow detection, the
 * conditional `tabindex`/`role` on the viewport, `data-scroll` position buckets,
 * the scroll-progress custom property, the `reach` event, and resize teardown.
 *
 * happy-dom has no layout engine, so `scrollHeight`/`clientHeight`/`scrollTop`
 * are stubbed to drive the overflow and position logic deterministically.
 */

const markup = (inner = "") => `
  <div data-controller="stimeo--scroll-area"
       data-stimeo--scroll-area-orientation-value="vertical">
    <div data-stimeo--scroll-area-target="viewport" aria-label="Log output">${inner}</div>
  </div>`;

/** Controllable ResizeObserver double: records what it observes and reports on demand. */
class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed = new Set<Element>();
  readonly #callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.add(element);
  }

  unobserve(element: Element): void {
    this.observed.delete(element);
  }

  disconnect(): void {
    this.observed.clear();
  }

  trigger(): void {
    this.#callback([], this);
  }
}

/** Installs an `EventTarget` as `document.fonts` for the duration of `run`. */
const withDocumentFonts = async (run: (fonts: EventTarget) => Promise<void>): Promise<void> => {
  const ownDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
  const fonts = new EventTarget();
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  try {
    await run(fonts);
  } finally {
    if (ownDescriptor) Object.defineProperty(document, "fonts", ownDescriptor);
    else Reflect.deleteProperty(document, "fonts");
  }
};

describe("ScrollAreaController", () => {
  let application: Application;

  const start = async (html: string) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--scroll-area", ScrollAreaController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--scroll-area']") as HTMLElement;
  const viewport = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--scroll-area-target='viewport']",
    ) as HTMLElement;
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--scroll-area",
    ) as ScrollAreaController | null;

  /** A detached viewport target carrying the given geometry. */
  const detachedViewport = (
    attributes: Record<string, string>,
    geometry: { scrollHeight: number; clientHeight: number; scrollTop: number },
  ) => {
    const element = document.createElement("div");
    element.setAttribute("data-stimeo--scroll-area-target", "viewport");
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    for (const [key, value] of Object.entries(geometry)) {
      Object.defineProperty(element, key, { configurable: true, value });
    }
    return element;
  };

  /** Stubs viewport geometry and notifies the controller via a viewport resize. */
  const layout = (geometry: { scrollHeight: number; clientHeight: number; scrollTop: number }) => {
    for (const [key, value] of Object.entries(geometry)) {
      Object.defineProperty(viewport(), key, { configurable: true, value });
    }
    window.dispatchEvent(new Event("resize"));
  };

  it.each(["root", "target"])(
    "keeps its state and its morph work through turbo:before-cache, from %s",
    async (origin) => {
      // Turbo also dispatches the event on a page that stays (a promoted frame
      // navigation, a popstate without Turbo state, a refresh of a cached URL).
      await start(markup());
      layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
      expect(root().getAttribute("data-overflow")).toBe("true");
      expect(viewport().getAttribute("role")).toBe("region");
      const source = origin === "root" ? root() : viewport();
      source.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      document.dispatchEvent(new Event("turbo:before-cache"));
      expect(root().getAttribute("data-overflow")).toBe("true");
      viewport().removeAttribute("role");
      source.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      await tick();
      expect(root().getAttribute("data-overflow")).toBe("true");
      expect(root().getAttribute("data-scroll")).toBe("start");
      expect(viewport().getAttribute("role")).toBe("region");
      expect(viewport().getAttribute("tabindex")).toBe("0");
    },
  );

  it("gives back the tab stop and the role a restored viewport carries once it does not overflow", async () => {
    await start(markup());
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    expect(viewport().getAttribute("tabindex")).toBe("0");

    application = await restoreFromCache(application, (restored) =>
      restored.register("stimeo--scroll-area", ScrollAreaController),
    );

    expect(viewport().hasAttribute("tabindex")).toBe(false);
    expect(viewport().hasAttribute("role")).toBe(false);
    expect(
      viewport()
        .getAttributeNames()
        .filter((name) => /-(lease|loan)$/.test(name)),
    ).toEqual([]);
  });

  it("takes over the tab stop and the role a restored viewport carries while it overflows", async () => {
    await start(markup());
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    application = await restoreFromCache(application, (restored) => {
      for (const [key, value] of Object.entries({
        scrollHeight: 800,
        clientHeight: 200,
        scrollTop: 0,
      })) {
        Object.defineProperty(viewport(), key, { configurable: true, value });
      }
      restored.register("stimeo--scroll-area", ScrollAreaController);
    });
    expect(viewport().getAttribute("tabindex")).toBe("0");
    expect(viewport().getAttribute("role")).toBe("region");

    layout({ scrollHeight: 150, clientHeight: 200, scrollTop: 0 });
    await tick();

    expect(viewport().hasAttribute("tabindex")).toBe(false);
    expect(viewport().hasAttribute("role")).toBe(false);
  });

  it("marks the viewport keyboard-scrollable when content overflows", async () => {
    await start(markup());
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    expect(root().getAttribute("data-overflow")).toBe("true");
    expect(viewport().getAttribute("tabindex")).toBe("0");
    expect(viewport().getAttribute("role")).toBe("region");
    expect(root().getAttribute("data-scroll")).toBe("start");
  });

  it("does not add tabindex when the content fits", async () => {
    await start(markup());
    layout({ scrollHeight: 150, clientHeight: 200, scrollTop: 0 });
    expect(root().getAttribute("data-overflow")).toBe("false");
    expect(viewport().hasAttribute("tabindex")).toBe(false);
    expect(viewport().hasAttribute("role")).toBe(false);
  });

  it("removes the tabindex it added once the content fits again", async () => {
    await start(markup());
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    expect(viewport().getAttribute("tabindex")).toBe("0");
    layout({ scrollHeight: 150, clientHeight: 200, scrollTop: 0 });
    expect(viewport().hasAttribute("tabindex")).toBe(false);
  });

  it("does not make the viewport a tab stop when it holds focusable content", async () => {
    await start(markup(`<a href="#deep">deep link</a>`));
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    expect(root().getAttribute("data-overflow")).toBe("true");
    expect(viewport().hasAttribute("tabindex")).toBe(false);
  });

  it.each([
    ["bare contenteditable", "<div contenteditable>Edit</div>"],
    ["plaintext-only contenteditable", '<div contenteditable="plaintext-only">Edit</div>'],
    ["summary", "<details><summary>Details</summary><p>Content</p></details>"],
    ["iframe", '<iframe title="Preview"></iframe>'],
    ["audio controls", '<audio controls style="display:block"></audio>'],
    ["video controls", "<video controls></video>"],
  ])("does not add a second tab stop for %s", async (_name, candidate) => {
    await start(markup(candidate));
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });

    expect(viewport().hasAttribute("tabindex")).toBe(false);
  });

  it.each([
    ["a hidden input", '<input type="hidden">'],
    ["a control disabled by its fieldset", "<fieldset disabled><button>Save</button></fieldset>"],
  ])("keeps the viewport reachable when its only candidate is %s", async (_name, candidate) => {
    await start(markup(candidate));
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });

    expect(viewport().getAttribute("tabindex")).toBe("0");
  });

  it.each([
    ["an empty aria-label", 'aria-label=""'],
    ["a whitespace-only aria-label", 'aria-label="   "'],
    ["an unresolved aria-labelledby", 'aria-labelledby="missing-label"'],
  ])("does not create a region for %s", async (_name, namingAttribute) => {
    await start(`
      <div data-controller="stimeo--scroll-area">
        <div data-stimeo--scroll-area-target="viewport" ${namingAttribute}></div>
      </div>
    `);
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });

    expect(viewport().getAttribute("tabindex")).toBe("0");
    expect(viewport().hasAttribute("role")).toBe(false);
  });

  it("follows the resolved aria-labelledby text while connected", async () => {
    await start(`
      <span id="log-label">Updates</span>
      <div data-controller="stimeo--scroll-area">
        <div data-stimeo--scroll-area-target="viewport" aria-labelledby="log-label"></div>
      </div>
    `);
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    expect(viewport().getAttribute("role")).toBe("region");
    await tick();

    const label = document.getElementById("log-label");
    if (!label) throw new Error("Expected the accessible-name source");
    label.textContent = "";
    await tick();

    expect(viewport().hasAttribute("role")).toBe(false);
  });

  it("follows aria-labelledby sources added and removed outside the viewport", async () => {
    await start(`
      <div id="labels"></div>
      <div data-controller="stimeo--scroll-area">
        <div data-stimeo--scroll-area-target="viewport" aria-labelledby="late-label"></div>
      </div>
    `);
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    expect(viewport().hasAttribute("role")).toBe(false);

    const label = document.createElement("span");
    label.id = "late-label";
    label.textContent = "Updates";
    document.getElementById("labels")?.append(label);
    await tick();
    expect(viewport().getAttribute("role")).toBe("region");

    label.remove();
    await tick();
    expect(viewport().hasAttribute("role")).toBe(false);
  });

  it("resolves an aria-labelledby reference when an existing element takes its id", async () => {
    await start(`
      <span id="placeholder">Updates</span>
      <div data-controller="stimeo--scroll-area">
        <div data-stimeo--scroll-area-target="viewport" aria-labelledby="late-label"></div>
      </div>
    `);
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    expect(viewport().hasAttribute("role")).toBe(false);
    await tick();

    document.getElementById("placeholder")?.setAttribute("id", "late-label");
    await tick();

    expect(viewport().getAttribute("role")).toBe("region");
  });

  it("retains name observers across unrelated refreshes and document id changes", async () => {
    await start(`
      <span id="log-label">Updates</span>
      <span id="unrelated">Other</span>
      <div data-controller="stimeo--scroll-area">
        <div data-stimeo--scroll-area-target="viewport" aria-labelledby="log-label"></div>
      </div>
    `);
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    const observes = vi.spyOn(MutationObserver.prototype, "observe");
    const queries = vi.spyOn(viewport(), "querySelectorAll");

    window.dispatchEvent(new Event("resize"));
    await tick();
    expect(observes).not.toHaveBeenCalled();
    queries.mockClear();

    document.getElementById("unrelated")?.setAttribute("id", "still-unrelated");
    await tick();
    expect(queries).not.toHaveBeenCalled();
  });

  it("stops following a label source the viewport no longer references", async () => {
    await start(`
      <span id="old-label">Old</span>
      <span id="new-label">New</span>
      <div data-controller="stimeo--scroll-area">
        <div data-stimeo--scroll-area-target="viewport" aria-labelledby="old-label"></div>
      </div>
    `);
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    await tick();
    viewport().setAttribute("aria-labelledby", "new-label");
    await tick();
    const queries = vi.spyOn(viewport(), "querySelectorAll");

    (document.getElementById("old-label") as HTMLElement).textContent = "Renamed";
    await tick();

    expect(queries).not.toHaveBeenCalled();
  });

  it("follows a late aria-labelledby source for a replacement viewport that references the same id", async () => {
    await start(`
      <div id="labels"></div>
      <div data-controller="stimeo--scroll-area">
        <div data-stimeo--scroll-area-target="viewport" aria-labelledby="late-label"></div>
      </div>
    `);
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    await tick();

    const replacement = detachedViewport(
      { "aria-labelledby": "late-label" },
      { scrollHeight: 800, clientHeight: 200, scrollTop: 0 },
    );
    viewport().replaceWith(replacement);
    controller()?.viewportTargetConnected();
    await tick();
    expect(replacement.getAttribute("tabindex")).toBe("0");
    expect(replacement.hasAttribute("role")).toBe(false);

    const label = document.createElement("span");
    label.id = "late-label";
    label.textContent = "Updates";
    document.getElementById("labels")?.append(label);
    await tick();

    expect(replacement.getAttribute("role")).toBe("region");
  });

  it("takes the tab stop when its only control is not rendered", async () => {
    // A button revealed on demand (a "jump to bottom" that appears only when there is
    // something to jump to) still matches the focusable selector while `display: none`.
    // Counting it would leave the viewport unreachable by keyboard for exactly as long
    // as it has nothing else to offer.
    await start(markup('<button type="button" id="jump" style="display:none">Jump</button>'));
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    expect(viewport().getAttribute("tabindex")).toBe("0");
  });

  it("ignores a control inside a hidden subtree", async () => {
    await start(markup('<div hidden><button type="button">Buried</button></div>'));
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    expect(viewport().getAttribute("tabindex")).toBe("0");
  });

  it("hands the tab stop back when a hidden control is revealed", async () => {
    await start(markup('<button type="button" id="jump" style="display:none">Jump</button>'));
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    expect(viewport().getAttribute("tabindex")).toBe("0");

    // Revealing it fires no resize and no scroll, so only the content observer can
    // notice: the viewport now has its own tab stop and must not add a second one.
    (document.getElementById("jump") as HTMLElement).style.display = "";
    await tick();

    expect(viewport().hasAttribute("tabindex")).toBe(false);
    expect(viewport().hasAttribute("role")).toBe(false);
  });

  it("follows a control revealed by a state hook on the viewport itself", async () => {
    // The real shape this exists for: `[data-has-new] .jump { display: block }`. The
    // button's own attributes never change — only an ancestor's do — so an attribute
    // filter scoped to the control could not see it.
    await start(
      `<div data-controller="stimeo--scroll-area">
         <div data-stimeo--scroll-area-target="viewport" aria-label="Log output">
           <style>.jump { display: none; } [data-has-new] .jump { display: block; }</style>
           <button type="button" class="jump">Jump</button>
         </div>
       </div>`,
    );
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    expect(viewport().getAttribute("tabindex")).toBe("0");

    viewport().setAttribute("data-has-new", "true");
    await tick();

    expect(viewport().hasAttribute("tabindex")).toBe(false);
  });

  it("re-measures a host viewport when another script rewrites a hook to the value it last wrote", async () => {
    await start(`
      <div data-controller="stimeo--scroll-area"
           data-stimeo--scroll-area-target="viewport" aria-label="Log output"></div>
    `);
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    await tick();
    expect(root().getAttribute("data-overflow")).toBe("true");

    Object.defineProperty(viewport(), "scrollHeight", { configurable: true, value: 150 });
    root().setAttribute("data-overflow", "true");
    await tick();

    expect(root().getAttribute("data-overflow")).toBe("false");
    expect(viewport().hasAttribute("tabindex")).toBe(false);
  });

  it.each([
    "data-expanded",
    "data-expanded-lease",
    "data-expanded-tabindex-loan",
    "data-expanded-hidden-region",
  ])("re-measures content whose geometry changes with %s", async (attribute) => {
    await start(markup('<div id="content">Content</div>'));
    layout({ scrollHeight: 100, clientHeight: 100, scrollTop: 0 });
    await tick();
    expect(root().getAttribute("data-overflow")).toBe("false");
    Object.defineProperty(viewport(), "scrollHeight", { configurable: true, value: 300 });
    document.getElementById("content")?.setAttribute(attribute, "true");
    await tick();

    expect(root().getAttribute("data-overflow")).toBe("true");
    expect(viewport().getAttribute("tabindex")).toBe("0");
  });

  it("re-measures on an outside hook write after the viewport moves off the host and back", async () => {
    await start(`
      <div data-controller="stimeo--scroll-area"
           data-stimeo--scroll-area-target="viewport" aria-label="Log output">
        <div id="inner" aria-label="Inner log"></div>
      </div>
    `);
    const inner = document.getElementById("inner") as HTMLElement;
    const target = "data-stimeo--scroll-area-target";
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    await tick();

    // The rebind is queued first, so it lets go of the host before the host's observer
    // has delivered the records of the measurement that follows.
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 300 });
    root().removeAttribute(target);
    for (const [key, value] of Object.entries({
      scrollHeight: 800,
      clientHeight: 200,
      scrollTop: 300,
    })) {
      Object.defineProperty(inner, key, { configurable: true, value });
    }
    inner.setAttribute(target, "viewport");
    await tick();

    inner.removeAttribute(target);
    root().setAttribute(target, "viewport");
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();
    expect(root().getAttribute("data-scroll")).toBe("middle");

    Object.defineProperty(root(), "scrollTop", { configurable: true, value: 600 });
    root().setAttribute("data-scroll", "middle");
    await tick();

    expect(root().getAttribute("data-scroll")).toBe("end");
  });

  it("takes the tab stop back when the control is removed again", async () => {
    await start(markup('<button type="button" id="jump">Jump</button>'));
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    expect(viewport().hasAttribute("tabindex")).toBe(false);

    (document.getElementById("jump") as HTMLElement).remove();
    await tick();

    expect(viewport().getAttribute("tabindex")).toBe("0");
  });

  it("re-measures overflow when a content change removes both the control and the scroll", async () => {
    // The hazard the content observer carries: it decides reachability, so it has
    // to decide it against the *current* geometry. A fixed-height viewport whose content
    // shrinks fires no resize and no scroll, so a cached overflow value stays stale — and
    // the tab stop would be handed to a box that no longer scrolls.
    await start(markup('<button type="button" id="jump">Jump</button>'));
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    expect(viewport().hasAttribute("tabindex")).toBe(false); // its own control holds the stop

    (document.getElementById("jump") as HTMLElement).remove();
    Object.defineProperty(viewport(), "scrollHeight", { configurable: true, value: 150 });
    await tick();

    expect(root().getAttribute("data-overflow")).toBe("false");
    expect(viewport().hasAttribute("tabindex")).toBe(false);
    expect(viewport().hasAttribute("role")).toBe(false);
  });

  it("takes the tab stop when a content change adds scroll and removes the control", async () => {
    // The mirror image, so the fix cannot be "never add on mutation".
    await start(markup('<button type="button" id="jump">Jump</button>'));
    layout({ scrollHeight: 150, clientHeight: 200, scrollTop: 0 });
    expect(viewport().hasAttribute("tabindex")).toBe(false);

    (document.getElementById("jump") as HTMLElement).remove();
    Object.defineProperty(viewport(), "scrollHeight", { configurable: true, value: 800 });
    await tick();

    expect(root().getAttribute("data-overflow")).toBe("true");
    expect(viewport().getAttribute("tabindex")).toBe("0");
  });

  it("rebinds scroll, resize, and content observation when the viewport is replaced", async () => {
    await start(markup());
    const oldViewport = viewport();
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    expect(oldViewport.getAttribute("tabindex")).toBe("0");

    const replacement = document.createElement("div");
    replacement.setAttribute("data-stimeo--scroll-area-target", "viewport");
    replacement.setAttribute("aria-label", "Replacement log");
    for (const [key, value] of Object.entries({
      scrollHeight: 800,
      clientHeight: 200,
      scrollTop: 600,
    })) {
      Object.defineProperty(replacement, key, { configurable: true, value });
    }
    oldViewport.replaceWith(replacement);
    await tick();

    expect(oldViewport.hasAttribute("tabindex")).toBe(false);
    expect(oldViewport.hasAttribute("role")).toBe(false);
    expect(replacement.getAttribute("tabindex")).toBe("0");
    expect(replacement.getAttribute("role")).toBe("region");
    expect(root().getAttribute("data-scroll")).toBe("end");

    Object.defineProperty(oldViewport, "scrollTop", { configurable: true, value: 300 });
    oldViewport.dispatchEvent(new Event("scroll"));
    expect(root().getAttribute("data-scroll")).toBe("end");

    replacement.appendChild(document.createElement("button"));
    await tick();
    expect(replacement.hasAttribute("tabindex")).toBe(false);
    expect(replacement.hasAttribute("role")).toBe(false);
  });

  it("removes host state when the viewport target disappears", async () => {
    await start(markup());
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 600 });
    expect(root().getAttribute("data-overflow")).toBe("true");
    expect(root().getAttribute("data-scroll")).toBe("end");
    expect(root().style.getPropertyValue("--stimeo--scroll-progress")).toBe("1");

    viewport().remove();
    await tick();

    expect(root().hasAttribute("data-overflow")).toBe(false);
    expect(root().hasAttribute("data-scroll")).toBe(false);
    expect(root().style.getPropertyValue("--stimeo--scroll-progress")).toBe("");
  });

  it("accepts markup without a viewport target", async () => {
    await start('<div data-controller="stimeo--scroll-area"></div>');

    expect(root().hasAttribute("data-overflow")).toBe(false);
    expect(root().hasAttribute("data-scroll")).toBe(false);
    expect(root().style.getPropertyValue("--stimeo--scroll-progress")).toBe("");
  });

  it("binds a viewport target added at runtime", async () => {
    await start('<div data-controller="stimeo--scroll-area"></div>');
    const added = detachedViewport(
      { "aria-label": "Log output" },
      { scrollHeight: 800, clientHeight: 200, scrollTop: 0 },
    );

    root().append(added);
    controller()?.viewportTargetConnected();
    await tick();

    expect(root().getAttribute("data-overflow")).toBe("true");
    expect(added.getAttribute("tabindex")).toBe("0");
    expect(added.getAttribute("role")).toBe("region");
  });

  it("releases the listeners and size observation of a viewport that leaves", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    try {
      await start(markup());
      layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
      await tick();
      const former = viewport();
      expect(FakeResizeObserver.instances.some((o) => o.observed.has(former))).toBe(true);
      const releases = vi.spyOn(former, "removeEventListener");

      former.remove();
      controller()?.viewportTargetDisconnected();
      await tick();
      expect(root().hasAttribute("data-scroll")).toBe(false);

      Object.defineProperty(former, "scrollTop", { configurable: true, value: 300 });
      former.dispatchEvent(new Event("scroll"));
      await tick();
      expect(root().hasAttribute("data-scroll")).toBe(false);
      expect(releases).toHaveBeenCalledWith("load", expect.any(Function), true);
      expect(FakeResizeObserver.instances.some((o) => o.observed.has(former))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      FakeResizeObserver.instances = [];
    }
  });

  it("drops a pending scroll frame when the viewport leaves", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextHandle = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      frames.delete(handle);
    });

    try {
      await start(markup());
      layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
      await tick();
      Object.defineProperty(viewport(), "scrollTop", { configurable: true, value: 300 });
      viewport().dispatchEvent(new Event("scroll"));
      expect(frames.size).toBe(1);

      viewport().remove();
      controller()?.viewportTargetDisconnected();
      await tick();
      for (const callback of [...frames.values()]) callback(0);

      expect(root().hasAttribute("data-scroll")).toBe(false);
      expect(root().style.getPropertyValue("--stimeo--scroll-progress")).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops re-checking the content once disconnected", async () => {
    // The control is visible to begin with, so the viewport holds no tab stop. Hiding it
    // *after* teardown is the mutation a live observer would answer by adding one — which
    // is what makes this case detect a missing `#content.disconnect()`. Doing it the other
    // way round (revealing a control) cannot: the correct answer there is "no tab stop"
    // either way, so a leaked observer would agree with a torn-down one.
    await start(markup('<button type="button" id="jump">Jump</button>'));
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    expect(viewport().hasAttribute("tabindex")).toBe(false);

    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--scroll-area",
    ) as { disconnect(): void } | null;
    controller?.disconnect();

    (document.getElementById("jump") as HTMLElement).style.display = "none";
    await tick();

    expect(viewport().hasAttribute("tabindex")).toBe(false);
    expect(viewport().hasAttribute("role")).toBe(false);
  });

  it("reports middle and end positions with progress", async () => {
    await start(markup());
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 300 });
    expect(root().getAttribute("data-scroll")).toBe("middle");
    expect(root().style.getPropertyValue("--stimeo--scroll-progress")).toBe("0.5");

    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 600 });
    expect(root().getAttribute("data-scroll")).toBe("end");
    expect(root().style.getPropertyValue("--stimeo--scroll-progress")).toBe("1");
  });

  it("coalesces a scroll burst without rescanning descendants", async () => {
    await start(`
      <div data-controller="stimeo--scroll-area"
           data-stimeo--scroll-area-target="viewport" aria-label="Log output">
        <button type="button">Action</button>
      </div>
    `);
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    await tick();
    const queries = vi.spyOn(viewport(), "querySelectorAll");
    const attributeWrites = vi.spyOn(root(), "setAttribute");
    const propertyWrites = vi.spyOn(root().style, "setProperty");
    const frames = vi.spyOn(globalThis, "requestAnimationFrame");

    Object.defineProperty(viewport(), "scrollTop", { configurable: true, value: 300 });
    viewport().dispatchEvent(new Event("scroll"));
    viewport().dispatchEvent(new Event("scroll"));
    viewport().dispatchEvent(new Event("scroll"));
    await tick();

    expect(root().getAttribute("data-scroll")).toBe("middle");
    expect(root().style.getPropertyValue("--stimeo--scroll-progress")).toBe("0.5");
    expect(queries).not.toHaveBeenCalled();
    expect(
      attributeWrites.mock.calls.filter(([attribute]) => attribute === "data-scroll"),
    ).toHaveLength(1);
    expect(propertyWrites).toHaveBeenCalledTimes(1);
    expect(frames).toHaveBeenCalledOnce();
  });

  it("cancels a pending scroll frame on disconnect", async () => {
    // Frames are held by handle so that a cancel really removes one, as an engine
    // does: a frame still held after disconnect would write the state hooks back
    // onto a host the teardown just returned to its authored markup.
    const frames = new Map<number, FrameRequestCallback>();
    let nextHandle = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      frames.delete(handle);
    });

    try {
      await start(markup());
      layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
      Object.defineProperty(viewport(), "scrollTop", { configurable: true, value: 300 });
      viewport().dispatchEvent(new Event("scroll"));
      const controller = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--scroll-area",
      );
      expect(frames.size).toBe(1);

      controller?.disconnect();
      for (const callback of [...frames.values()]) callback(0);

      expect(root().hasAttribute("data-scroll")).toBe(false);
      expect(root().style.getPropertyValue("--stimeo--scroll-progress")).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("drops a pending scroll frame when a full measurement pass supersedes it", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextHandle = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      frames.delete(handle);
    });

    try {
      await start(markup());
      layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
      Object.defineProperty(viewport(), "scrollTop", { configurable: true, value: 300 });
      viewport().dispatchEvent(new Event("scroll"));
      expect(frames.size).toBe(1);

      layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 600 });

      expect(root().getAttribute("data-scroll")).toBe("end");
      expect(frames.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("re-measures when descendant media finishes loading", async () => {
    await start(markup('<img id="delayed" alt="">'));
    layout({ scrollHeight: 150, clientHeight: 200, scrollTop: 0 });
    expect(root().getAttribute("data-overflow")).toBe("false");

    Object.defineProperty(viewport(), "scrollHeight", { configurable: true, value: 800 });
    document.getElementById("delayed")?.dispatchEvent(new Event("load"));

    expect(root().getAttribute("data-overflow")).toBe("true");
    expect(viewport().getAttribute("tabindex")).toBe("0");
  });

  it("re-measures when the viewport's own box resizes", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    try {
      await start(markup());
      expect(root().getAttribute("data-overflow")).toBe("false");

      for (const [key, value] of Object.entries({ scrollHeight: 800, clientHeight: 200 })) {
        Object.defineProperty(viewport(), key, { configurable: true, value });
      }
      for (const observer of FakeResizeObserver.instances) {
        if (observer.observed.has(viewport())) observer.trigger();
      }

      expect(root().getAttribute("data-overflow")).toBe("true");
    } finally {
      vi.unstubAllGlobals();
      FakeResizeObserver.instances = [];
    }
  });

  it("re-measures when document fonts fail to load", async () => {
    await withDocumentFonts(async (fonts) => {
      await start(markup());
      layout({ scrollHeight: 150, clientHeight: 200, scrollTop: 0 });
      Object.defineProperty(viewport(), "scrollHeight", { configurable: true, value: 800 });

      fonts.dispatchEvent(new Event("loadingerror"));

      expect(root().getAttribute("data-overflow")).toBe("true");
    });
  });

  it("re-measures when document fonts finish loading and releases the listener", async () => {
    const ownDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
    const fonts = new EventTarget();
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
    try {
      await start(markup());
      layout({ scrollHeight: 150, clientHeight: 200, scrollTop: 0 });
      Object.defineProperty(viewport(), "scrollHeight", { configurable: true, value: 800 });
      fonts.dispatchEvent(new Event("loadingdone"));
      expect(root().getAttribute("data-overflow")).toBe("true");

      const controller = application.getControllerForElementAndIdentifier(
        root(),
        "stimeo--scroll-area",
      );
      controller?.disconnect();
      const writes = vi.spyOn(root(), "setAttribute");
      fonts.dispatchEvent(new Event("loadingerror"));
      expect(writes).not.toHaveBeenCalled();
    } finally {
      if (ownDescriptor) Object.defineProperty(document, "fonts", ownDescriptor);
      else Reflect.deleteProperty(document, "fonts");
    }
  });

  it("re-measures a retained viewport when orientation changes", async () => {
    await start(markup());
    for (const [key, value] of Object.entries({
      scrollHeight: 200,
      clientHeight: 200,
      scrollTop: 0,
      scrollWidth: 800,
      clientWidth: 200,
      scrollLeft: 300,
    })) {
      Object.defineProperty(viewport(), key, { configurable: true, value });
    }
    window.dispatchEvent(new Event("resize"));
    expect(root().getAttribute("data-overflow")).toBe("false");

    root().setAttribute("data-stimeo--scroll-area-orientation-value", "horizontal");
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--scroll-area",
    ) as ScrollAreaController | null;
    controller?.orientationValueChanged();

    expect(root().getAttribute("data-overflow")).toBe("true");
    expect(root().getAttribute("data-scroll")).toBe("middle");
  });

  it("reports logical progress from start to end in a horizontal RTL viewport", async () => {
    await start(
      markup().replace(
        'data-stimeo--scroll-area-orientation-value="vertical"',
        'data-stimeo--scroll-area-orientation-value="horizontal"',
      ),
    );
    viewport().style.direction = "rtl";
    for (const [key, value] of Object.entries({
      scrollWidth: 800,
      clientWidth: 200,
      scrollLeft: -300,
    })) {
      Object.defineProperty(viewport(), key, { configurable: true, value });
    }
    window.dispatchEvent(new Event("resize"));

    expect(root().getAttribute("data-scroll")).toBe("middle");
    expect(root().style.getPropertyValue("--stimeo--scroll-progress")).toBe("0.5");

    Object.defineProperty(viewport(), "scrollLeft", { configurable: true, value: -600 });
    viewport().dispatchEvent(new Event("scroll"));
    await tick();
    expect(root().getAttribute("data-scroll")).toBe("end");
    expect(root().style.getPropertyValue("--stimeo--scroll-progress")).toBe("1");
  });

  it("dispatches reach once per edge arrival", async () => {
    await start(markup());
    const edges: string[] = [];
    root().addEventListener("stimeo--scroll-area:reach", (event) => {
      edges.push((event as CustomEvent<{ edge: string }>).detail.edge);
    });
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 }); // start
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 300 }); // middle (no edge)
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 600 }); // end
    expect(edges).toEqual(["start", "end"]);
  });

  it("dispatches reach again only after leaving and re-entering an edge", async () => {
    await start(markup());
    const edges: string[] = [];
    root().addEventListener("stimeo--scroll-area:reach", (event) => {
      edges.push((event as CustomEvent<{ edge: string }>).detail.edge);
    });

    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 300 });
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });

    expect(edges).toEqual(["start", "start"]);
  });

  it("publishes finite zero progress when there is no scroll range", async () => {
    await start(markup());
    layout({ scrollHeight: 200, clientHeight: 200, scrollTop: 0 });

    expect(root().getAttribute("data-scroll")).toBe("start");
    expect(root().style.getPropertyValue("--stimeo--scroll-progress")).toBe("0");
  });

  it.each([
    [
      "vertical overflow first",
      { scrollHeight: 800, clientHeight: 200, scrollTop: 600, scrollWidth: 300, clientWidth: 300 },
      "end",
      "1",
    ],
    [
      "horizontal overflow when the vertical axis fits",
      { scrollHeight: 200, clientHeight: 200, scrollTop: 0, scrollWidth: 800, clientWidth: 200 },
      "middle",
      "0.5",
    ],
  ])("uses %s for orientation=both", async (_name, geometry, position, progress) => {
    await start(
      markup().replace(
        'data-stimeo--scroll-area-orientation-value="vertical"',
        'data-stimeo--scroll-area-orientation-value="both"',
      ),
    );
    for (const [key, value] of Object.entries({ ...geometry, scrollLeft: 300 })) {
      Object.defineProperty(viewport(), key, { configurable: true, value });
    }
    window.dispatchEvent(new Event("resize"));

    expect(root().getAttribute("data-overflow")).toBe("true");
    expect(root().getAttribute("data-scroll")).toBe(position);
    expect(root().style.getPropertyValue("--stimeo--scroll-progress")).toBe(progress);
  });

  it("stops reacting to resizes after disconnect", async () => {
    await start(markup());
    layout({ scrollHeight: 150, clientHeight: 200, scrollTop: 0 }); // fits
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--scroll-area",
    );
    controller?.disconnect();
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 }); // would overflow
    expect(root().hasAttribute("data-overflow")).toBe(false);
    expect(viewport().hasAttribute("tabindex")).toBe(false);
  });

  it("releases its window and font subscriptions on disconnect", async () => {
    await withDocumentFonts(async (fonts) => {
      const fontSubscriptions = vi.spyOn(fonts, "addEventListener");
      const fontReleases = vi.spyOn(fonts, "removeEventListener");
      const windowReleases = vi.spyOn(window, "removeEventListener");
      try {
        await start(markup());
        const onFonts = fontSubscriptions.mock.calls[0]?.[1];
        expect(onFonts).toBeTypeOf("function");

        controller()?.disconnect();

        expect(windowReleases).toHaveBeenCalledWith("resize", expect.any(Function));
        expect(fontReleases).toHaveBeenCalledWith("loadingdone", onFonts);
        expect(fontReleases).toHaveBeenCalledWith("loadingerror", onFonts);
      } finally {
        windowReleases.mockRestore();
      }
    });
  });

  it("keeps its window and font subscriptions through turbo:before-cache", async () => {
    await withDocumentFonts(async (fonts) => {
      const fontReleases = vi.spyOn(fonts, "removeEventListener");
      const windowReleases = vi.spyOn(window, "removeEventListener");
      try {
        await start(markup());

        document.dispatchEvent(new Event("turbo:before-cache"));

        expect(windowReleases).not.toHaveBeenCalledWith("resize", expect.any(Function));
        expect(fontReleases).not.toHaveBeenCalled();
      } finally {
        windowReleases.mockRestore();
      }
    });
  });

  it("disconnects every mutation observer it opened when disconnected", async () => {
    const observes = vi.spyOn(MutationObserver.prototype, "observe");
    const disconnects = vi.spyOn(MutationObserver.prototype, "disconnect");
    observes.mockClear();
    try {
      await start(`
        <span id="log-label">Updates</span>
        <div data-controller="stimeo--scroll-area">
          <div data-stimeo--scroll-area-target="viewport" aria-labelledby="log-label"></div>
        </div>
      `);
      const label = document.getElementById("log-label");
      const opened = observes.mock.contexts.filter((_, index) => {
        const [target, options] = observes.mock.calls[index] ?? [];
        return (
          target === viewport() ||
          target === label ||
          (target === document.documentElement && options?.attributeFilter?.includes("id"))
        );
      });
      expect(opened).toHaveLength(3);

      controller()?.disconnect();

      for (const observer of opened) expect(disconnects.mock.contexts).toContain(observer);
    } finally {
      observes.mockRestore();
      disconnects.mockRestore();
    }
  });

  it("removes the tabindex/role it added when disconnected (no Turbo residue)", async () => {
    await start(markup());
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 }); // overflow → attrs added
    expect(viewport().getAttribute("tabindex")).toBe("0");
    expect(viewport().getAttribute("role")).toBe("region");
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--scroll-area",
    );
    controller?.disconnect();
    expect(viewport().hasAttribute("tabindex")).toBe(false);
    expect(viewport().hasAttribute("role")).toBe(false);
  });

  it("restores authored host hooks when disconnected", async () => {
    await start(`
      <div data-controller="stimeo--scroll-area"
           data-overflow="authored" data-scroll="authored"
           style="--stimeo--scroll-progress: 0.25">
        <div data-stimeo--scroll-area-target="viewport" aria-label="Log output"></div>
      </div>
    `);
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 600 });
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--scroll-area",
    );
    controller?.disconnect();

    expect(root().getAttribute("data-overflow")).toBe("authored");
    expect(root().getAttribute("data-scroll")).toBe("authored");
    expect(root().style.getPropertyValue("--stimeo--scroll-progress")).toBe("0.25");
  });

  it("keeps every borrowed hook through turbo:before-cache and keeps measuring", async () => {
    await start(markup());
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 600 });

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(viewport().getAttribute("tabindex")).toBe("0");
    expect(viewport().getAttribute("role")).toBe("region");
    expect(root().getAttribute("data-overflow")).toBe("true");
    expect(root().getAttribute("data-scroll")).toBe("end");
    expect(root().style.getPropertyValue("--stimeo--scroll-progress")).toBe("1");

    Object.defineProperty(viewport(), "scrollHeight", { configurable: true, value: 150 });
    viewport().append(document.createElement("button"));
    await tick();
    expect(root().getAttribute("data-overflow")).toBe("false");
    expect(viewport().hasAttribute("tabindex")).toBe(false);
  });

  it("preserves a consumer-provided role/tabindex it did not add", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--scroll-area">
        <div data-stimeo--scroll-area-target="viewport" role="log" tabindex="0"
             aria-label="Log output"></div>
      </div>`;
    application = Application.start();
    application.register("stimeo--scroll-area", ScrollAreaController);
    await tick();
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--scroll-area",
    );
    controller?.disconnect();
    // The controller never added these, so it must not strip them.
    expect(viewport().getAttribute("role")).toBe("log");
    expect(viewport().getAttribute("tabindex")).toBe("0");
  });

  it("keeps a role the page wrote over the region once the content fits", async () => {
    await start(markup());
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    expect(viewport().getAttribute("role")).toBe("region");
    viewport().setAttribute("role", "log");
    layout({ scrollHeight: 801, clientHeight: 200, scrollTop: 0 });

    layout({ scrollHeight: 150, clientHeight: 200, scrollTop: 0 });

    expect(viewport().getAttribute("role")).toBe("log");
  });

  it("keeps a role the page wrote over the region on disconnect", async () => {
    await start(markup());
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    viewport().setAttribute("role", "log");
    layout({ scrollHeight: 801, clientHeight: 200, scrollTop: 0 });

    controller()?.disconnect();

    expect(viewport().getAttribute("role")).toBe("log");
  });

  it("keeps a role the page wrote over the region on a restored viewport", async () => {
    await start(markup());
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    viewport().setAttribute("role", "log");
    application = await restoreFromCache(application, (restored) => {
      for (const [key, value] of Object.entries({
        scrollHeight: 800,
        clientHeight: 200,
        scrollTop: 0,
      })) {
        Object.defineProperty(viewport(), key, { configurable: true, value });
      }
      restored.register("stimeo--scroll-area", ScrollAreaController);
    });
    expect(viewport().getAttribute("role")).toBe("log");

    layout({ scrollHeight: 150, clientHeight: 200, scrollTop: 0 });

    expect(viewport().getAttribute("role")).toBe("log");
    expect(
      viewport()
        .getAttributeNames()
        .filter((name) => name.endsWith("-lease")),
    ).toEqual([]);
  });

  it.each(["the page that stays", "a restored page"])(
    "treats a region role the page writes back over its own as the one it wrote, on %s",
    async (where) => {
      // The role is the lease's while it holds the value the lease wrote, whoever wrote it
      // last; the restored page inherits that from the record, as the page that stays does.
      await start(markup());
      layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
      viewport().setAttribute("role", "log");
      if (where === "a restored page") {
        application = await restoreFromCache(application, (restored) => {
          for (const [key, value] of Object.entries({
            scrollHeight: 800,
            clientHeight: 200,
            scrollTop: 0,
          })) {
            Object.defineProperty(viewport(), key, { configurable: true, value });
          }
          restored.register("stimeo--scroll-area", ScrollAreaController);
        });
      }
      viewport().setAttribute("role", "region");

      layout({ scrollHeight: 150, clientHeight: 200, scrollTop: 0 });

      expect(viewport().hasAttribute("role")).toBe(false);
    },
  );

  it("has no machine-detectable a11y violations", async () => {
    await start(markup());
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    await expectNoA11yViolations(root());
  });

  // --- Speech-order regression ------------------------------------------------

  it("announces the scroll region by its name once it overflows", async () => {
    await start(markup("<p>only content</p>"));
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    // The named region the controller exposes for keyboard reach must announce.
    const phrases = await captureSpeech({ container: root(), steps: 1 });
    expect(phrases).toEqual(["region, Log output", "paragraph"]);
  });

  it("exposes no region role before it overflows", async () => {
    await start(markup("<p>only content</p>"));
    layout({ scrollHeight: 150, clientHeight: 200, scrollTop: 0 }); // fits → no region
    const phrases = await captureSpeech({ container: root(), steps: 1 });
    // Freeze the whole ordered array (not a name-only `not.toContain`): with no
    // overflow the controller exposes no `region` role, so only the content announces.
    expect(phrases).toEqual(["Log output", "paragraph"]);
  });
});
