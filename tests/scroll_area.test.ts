import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(root().style.getPropertyValue("--stimeo-scroll-progress")).toBe("0.5");

    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 600 });
    expect(root().getAttribute("data-scroll")).toBe("end");
    expect(root().style.getPropertyValue("--stimeo-scroll-progress")).toBe("1");
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
    expect(root().style.getPropertyValue("--stimeo-scroll-progress")).toBe("0.5");

    Object.defineProperty(viewport(), "scrollLeft", { configurable: true, value: -600 });
    viewport().dispatchEvent(new Event("scroll"));
    expect(root().getAttribute("data-scroll")).toBe("end");
    expect(root().style.getPropertyValue("--stimeo-scroll-progress")).toBe("1");
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

  it("stops reacting to resizes after disconnect", async () => {
    await start(markup());
    layout({ scrollHeight: 150, clientHeight: 200, scrollTop: 0 }); // fits
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--scroll-area",
    );
    controller?.disconnect();
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 0 }); // would overflow
    expect(root().getAttribute("data-overflow")).toBe("false");
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
