import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrollAreaController } from "../src/controllers/scroll_area_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
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

  /** Stubs viewport geometry and notifies the controller via a viewport resize. */
  const layout = (geometry: { scrollHeight: number; clientHeight: number; scrollTop: number }) => {
    for (const [key, value] of Object.entries(geometry)) {
      Object.defineProperty(viewport(), key, { configurable: true, value });
    }
    window.dispatchEvent(new Event("resize"));
  };

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
    expect(() => document.dispatchEvent(new Event("turbo:before-cache"))).not.toThrow();
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
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame");
    await start(markup());
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    Object.defineProperty(viewport(), "scrollTop", { configurable: true, value: 300 });
    viewport().dispatchEvent(new Event("scroll"));
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--scroll-area",
    );

    controller?.disconnect();

    expect(cancel).toHaveBeenCalledOnce();
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

  it("returns every borrowed hook before Turbo caches the page", async () => {
    await start(markup());
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 600 });

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(viewport().hasAttribute("tabindex")).toBe(false);
    expect(viewport().hasAttribute("role")).toBe(false);
    expect(root().hasAttribute("data-overflow")).toBe(false);
    expect(root().hasAttribute("data-scroll")).toBe(false);
    expect(root().style.getPropertyValue("--stimeo--scroll-progress")).toBe("");

    Object.defineProperty(viewport(), "scrollHeight", { configurable: true, value: 150 });
    viewport().append(document.createElement("button"));
    await tick();
    expect(root().hasAttribute("data-overflow")).toBe(false);
    expect(root().hasAttribute("data-scroll")).toBe(false);
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
