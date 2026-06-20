import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { ScrollAreaController } from "../src/controllers/scroll_area_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link ScrollAreaController}: overflow detection, the
 * conditional `tabindex`/`role` on the viewport, `data-scroll` position buckets,
 * the scroll-progress custom property, the `reach` event, and resize teardown.
 *
 * happy-dom has no layout engine, so `scrollHeight`/`clientHeight`/`scrollTop`
 * are stubbed to drive the overflow and position logic deterministically.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    application.stop();
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

  it("reports middle and end positions with progress", async () => {
    await start(markup());
    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 300 });
    expect(root().getAttribute("data-scroll")).toBe("middle");
    expect(root().style.getPropertyValue("--stimeo-scroll-progress")).toBe("0.5");

    layout({ scrollHeight: 800, clientHeight: 200, scrollTop: 600 });
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

  // --- Layer ③ speech-order regression ---------------------------------------

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
