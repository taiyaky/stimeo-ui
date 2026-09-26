import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccordionController } from "../src/controllers/accordion_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents } from "./helpers/state_events";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link AccordionController}: per-header `aria-expanded`
 * toggling, independent (multiple-open) panels, and header focus navigation.
 */

describe("AccordionController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--accordion">
        <h3><button id="b1" data-stimeo--accordion-target="trigger"
                    data-action="stimeo--accordion#toggle keydown->stimeo--accordion#onKeydown"
                    aria-expanded="false" aria-controls="p1">One</button></h3>
        <h3><button id="b2" data-stimeo--accordion-target="trigger"
                    data-action="stimeo--accordion#toggle keydown->stimeo--accordion#onKeydown"
                    aria-expanded="false" aria-controls="p2">Two</button></h3>
        <div id="p2" data-stimeo--accordion-target="panel" role="region"
             aria-labelledby="b2" hidden>Panel two</div>
        <div id="p1" data-stimeo--accordion-target="panel" role="region"
             aria-labelledby="b1" hidden>Panel one</div>
        <button id="expand-all" data-action="stimeo--accordion#expandAll">Expand all</button>
        <button id="collapse-all" data-action="stimeo--accordion#collapseAll">Collapse all</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--accordion", AccordionController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const triggers = () =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-stimeo--accordion-target='trigger']"),
    );
  const panel = (id: string) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`panel ${id} not found`);
    return element;
  };

  it("yields a key a descendant widget already consumed", () => {
    // A composed widget that claims the key must not ALSO act on it —
    // composition depends on this yield.
    const first = triggers()[0] as HTMLElement;
    first.focus();
    const inner = document.createElement("span");
    first.append(inner);
    inner.addEventListener("keydown", (event) => event.preventDefault());

    inner.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );

    expect(document.activeElement).toBe(first);
  });

  it("expands the controlled panel on click", () => {
    triggers()[0]?.click();
    expect(triggers()[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(panel("p1").hidden).toBe(false);
    expect(panel("p2").hidden).toBe(true);
  });

  it("pairs triggers and panels by aria-controls rather than DOM position", () => {
    triggers()[1]?.click();
    expect(panel("p2").hidden).toBe(false);
    expect(panel("p1").hidden).toBe(true);
  });

  it("allows multiple panels open at once", () => {
    triggers()[0]?.click();
    triggers()[1]?.click();
    expect(panel("p1").hidden).toBe(false);
    expect(panel("p2").hidden).toBe(false);
  });

  it("collapses again on a second click", () => {
    triggers()[0]?.click();
    triggers()[0]?.click();
    expect(triggers()[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(panel("p1").hidden).toBe(true);
  });

  it("moves focus to the next header on ArrowDown", () => {
    triggers()[0]?.focus();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    triggers()[0]?.dispatchEvent(event);
    expect(document.activeElement).toBe(triggers()[1]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("wraps to the first header from the last on ArrowDown", () => {
    triggers()[1]?.focus();
    triggers()[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(triggers()[0]);
  });

  const root = () => {
    const element = document.querySelector<HTMLElement>("[data-controller='stimeo--accordion']");
    if (!element) throw new Error("accordion not found");
    return element;
  };

  // Machine-detectable a11y, asserted with a panel expanded so the visible
  // (non-hidden) region is part of the audited tree.
  it("has no machine-detectable a11y violations when a panel is open", async () => {
    triggers()[0]?.click();
    await expectNoA11yViolations(root());
  });

  // Speech-order regression: the header must announce its expanded state, and
  // that state must flip in the spoken phrase on toggle.
  it("announces the header's expanded state before and after a toggle", async () => {
    const collapsed = await captureSpeech({ container: root(), steps: 2 });
    expect(collapsed).toEqual([
      "heading, One, level 3",
      "button, One, 1 control, not expanded",
      "end of heading, One, level 3",
    ]);

    triggers()[0]?.click();
    const expanded = await captureSpeech({ container: root(), steps: 2 });
    expect(expanded).toEqual([
      "heading, One, level 3",
      "button, One, 1 control, expanded",
      "end of heading, One, level 3",
    ]);
  });

  // Context-teardown regression. The controller holds no timers, observers, or
  // document/window listeners (only Stimulus-managed data-action bindings), so
  // unloading its identifier must make the headers inert.
  it("becomes inert after disconnect (no lingering side effects)", () => {
    triggers()[0]?.click();
    expect(panel("p1").hidden).toBe(false);

    application.unload("stimeo--accordion");
    triggers()[0]?.click();
    // State is frozen at disconnect: a post-unload click neither collapses the panel
    // nor flips aria-expanded.
    expect(panel("p1").hidden).toBe(false);
    expect(triggers()[0]?.getAttribute("aria-expanded")).toBe("true");

    triggers()[1]?.focus();
    triggers()[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(triggers()[1]);
  });

  it("moves focus to the previous header on ArrowUp, wrapping at the first", () => {
    triggers()[0]?.focus();
    triggers()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(triggers()[1]); // wrapped to last

    triggers()[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(triggers()[0]); // regular previous step
  });

  it("jumps to the first header on Home and the last on End", () => {
    triggers()[1]?.focus();
    triggers()[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(triggers()[0]);

    triggers()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(triggers()[1]);
  });

  it("skips headers hidden in a collapsed subtree during arrow navigation", async () => {
    // A filter + accordion composition: each header sits in a section a filter can
    // hide. Arrow nav must jump over the hidden middle one rather than calling
    // .focus() on an unperceivable header (focus would stall).
    disconnectAndStopApplication(application);
    document.body.innerHTML = `
      <div data-controller="stimeo--accordion">
        <section><h3><button id="h1" data-stimeo--accordion-target="trigger"
          data-action="keydown->stimeo--accordion#onKeydown" aria-controls="q1">One</button></h3>
          <div id="q1" data-stimeo--accordion-target="panel" hidden></div></section>
        <section hidden><h3><button id="h2" data-stimeo--accordion-target="trigger"
          data-action="keydown->stimeo--accordion#onKeydown" aria-controls="q2">Two</button></h3>
          <div id="q2" data-stimeo--accordion-target="panel" hidden></div></section>
        <section><h3><button id="h3" data-stimeo--accordion-target="trigger"
          data-action="keydown->stimeo--accordion#onKeydown" aria-controls="q3">Three</button></h3>
          <div id="q3" data-stimeo--accordion-target="panel" hidden></div></section>
      </div>`;
    application = Application.start();
    application.register("stimeo--accordion", AccordionController);
    await tick();

    const h1 = document.getElementById("h1") as HTMLButtonElement;
    const h3 = document.getElementById("h3") as HTMLButtonElement;

    // ArrowDown from the first visible header skips the hidden section to the third.
    h1.focus();
    h1.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(h3);

    // ArrowUp from the first wraps to the last visible header, never the hidden one.
    h1.focus();
    h1.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(h3);

    // End lands on the last visible header (h3), not the hidden h2.
    h1.focus();
    h1.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(h3);
  });

  it("leaves a modified arrow to the browser", () => {
    // Alt+Arrow is a browser binding: the accordion neither moves the header
    // focus nor calls preventDefault().
    triggers()[0]?.focus();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    triggers()[0]?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(triggers()[0]);
  });

  it("ignores other keys (no focus move, not prevented)", () => {
    triggers()[0]?.focus();
    const event = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    triggers()[0]?.dispatchEvent(event);
    expect(document.activeElement).toBe(triggers()[0]);
    expect(event.defaultPrevented).toBe(false);
  });

  it("is a no-op when a header's aria-controls points at no panel", () => {
    const orphan = triggers()[0];
    orphan?.setAttribute("aria-controls", "missing");
    orphan?.click();
    // No matching panel → nothing toggles, aria-expanded stays put.
    expect(orphan?.getAttribute("aria-expanded")).toBe("false");
    expect(panel("p1").hidden).toBe(true);
  });

  it("expandAll opens every panel regardless of prior state", () => {
    triggers()[0]?.click(); // p1 open, p2 closed — a mixed starting point
    document.getElementById("expand-all")?.click();
    expect(panel("p1").hidden).toBe(false);
    expect(panel("p2").hidden).toBe(false);
    expect(triggers()[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(triggers()[1]?.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapseAll closes every panel regardless of prior state", () => {
    triggers()[0]?.click(); // p1 open, p2 closed — a mixed starting point
    document.getElementById("collapse-all")?.click();
    expect(panel("p1").hidden).toBe(true);
    expect(panel("p2").hidden).toBe(true);
    expect(triggers()[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(triggers()[1]?.getAttribute("aria-expanded")).toBe("false");
  });

  // --- Label pair ---

  describe("label pair", () => {
    /** Remounts the accordion so a case can author the markup its contract needs. */
    const mount = async (markup: string) => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = markup;
      application = Application.start();
      application.register("stimeo--accordion", AccordionController);
      await tick();
    };

    /** Resolves a fixture element by id, failing loudly when the markup drifted. */
    const byId = (id: string): HTMLElement => {
      const found = document.getElementById(id);
      if (!found) throw new Error(`element ${id} not found`);
      return found;
    };

    it("shows the half that belongs to the header's state, in both directions", async () => {
      await mount(`
        <div data-controller="stimeo--accordion">
          <h3><button id="b1" data-stimeo--accordion-target="trigger"
                      data-action="stimeo--accordion#toggle"
                      aria-expanded="false" aria-controls="p1">
            <span id="e1" data-stimeo--accordion-target="expandedLabel" hidden>Hide shipping</span>
            <span id="c1" data-stimeo--accordion-target="collapsedLabel">Show shipping</span>
          </button></h3>
          <div id="p1" data-stimeo--accordion-target="panel" role="region"
               aria-labelledby="b1" hidden>Ships within two business days.</div>
        </div>`);

      // Which half is shown is a pure function of the header's `aria-expanded`.
      byId("b1").click();
      expect(byId("e1").hidden).toBe(false);
      expect(byId("c1").hidden).toBe(true);

      byId("b1").click();
      expect(byId("e1").hidden).toBe(true);
      expect(byId("c1").hidden).toBe(false);
    });

    it("settles the authored halves from the header's state on the first connection", async () => {
      // An authored `hidden` is never read back: the expanded header's halves are
      // authored the wrong way round, and the collapsed one authors neither.
      await mount(`
        <div data-controller="stimeo--accordion">
          <h3><button id="b1" data-stimeo--accordion-target="trigger"
                      data-action="stimeo--accordion#toggle"
                      aria-expanded="true" aria-controls="p1">
            <span id="e1" data-stimeo--accordion-target="expandedLabel" hidden>Hide shipping</span>
            <span id="c1" data-stimeo--accordion-target="collapsedLabel">Show shipping</span>
          </button></h3>
          <div id="p1" data-stimeo--accordion-target="panel" role="region"
               aria-labelledby="b1">Ships within two business days.</div>
          <h3><button id="b2" data-stimeo--accordion-target="trigger"
                      data-action="stimeo--accordion#toggle"
                      aria-expanded="false" aria-controls="p2">
            <span id="e2" data-stimeo--accordion-target="expandedLabel">Hide returns</span>
            <span id="c2" data-stimeo--accordion-target="collapsedLabel">Show returns</span>
          </button></h3>
          <div id="p2" data-stimeo--accordion-target="panel" role="region"
               aria-labelledby="b2" hidden>Returns are free for 30 days.</div>
        </div>`);

      expect(byId("e1").hidden).toBe(false);
      expect(byId("c1").hidden).toBe(true);
      expect(byId("e2").hidden).toBe(true);
      expect(byId("c2").hidden).toBe(false);
    });

    it("leaves a header's lone half as authored while a complete pair still reflects", async () => {
      // A half whose counterpart is missing inside the same header is not a pair:
      // hiding it would take the header's only label with it, so nothing is written
      // there — whatever the state does. A pair elsewhere reflects regardless.
      await mount(`
        <div data-controller="stimeo--accordion">
          <h3><button id="b1" data-stimeo--accordion-target="trigger"
                      data-action="stimeo--accordion#toggle"
                      aria-expanded="false" aria-controls="p1">
            <span id="e1" data-stimeo--accordion-target="expandedLabel">Shipping</span>
          </button></h3>
          <div id="p1" data-stimeo--accordion-target="panel" role="region"
               aria-labelledby="b1" hidden>Ships within two business days.</div>
          <h3><button id="b2" data-stimeo--accordion-target="trigger"
                      data-action="stimeo--accordion#toggle"
                      aria-expanded="false" aria-controls="p2">
            <span id="e2" data-stimeo--accordion-target="expandedLabel" hidden>Hide returns</span>
            <span id="c2" data-stimeo--accordion-target="collapsedLabel">Show returns</span>
          </button></h3>
          <div id="p2" data-stimeo--accordion-target="panel" role="region"
               aria-labelledby="b2" hidden>Returns are free for 30 days.</div>
        </div>`);

      expect(byId("e1").hidden).toBe(false);

      byId("b1").click();
      expect(byId("e1").hidden).toBe(false);
      byId("b1").click();
      expect(byId("e1").hidden).toBe(false);

      byId("b2").click();
      expect(byId("e2").hidden).toBe(false);
      expect(byId("c2").hidden).toBe(true);
    });

    it("reflects each header's pair from that header's own state", async () => {
      // The pair is narrowed to the header it sits in, so an open and a closed
      // header each show their own half.
      await mount(`
        <div data-controller="stimeo--accordion">
          <h3><button id="b1" data-stimeo--accordion-target="trigger"
                      data-action="stimeo--accordion#toggle"
                      aria-expanded="true" aria-controls="p1">
            <span id="e1" data-stimeo--accordion-target="expandedLabel">Hide shipping</span>
            <span id="c1" data-stimeo--accordion-target="collapsedLabel">Show shipping</span>
          </button></h3>
          <div id="p1" data-stimeo--accordion-target="panel" role="region"
               aria-labelledby="b1">Ships within two business days.</div>
          <h3><button id="b2" data-stimeo--accordion-target="trigger"
                      data-action="stimeo--accordion#toggle"
                      aria-expanded="false" aria-controls="p2">
            <span id="e2" data-stimeo--accordion-target="expandedLabel">Hide returns</span>
            <span id="c2" data-stimeo--accordion-target="collapsedLabel">Show returns</span>
          </button></h3>
          <div id="p2" data-stimeo--accordion-target="panel" role="region"
               aria-labelledby="b2" hidden>Returns are free for 30 days.</div>
        </div>`);

      expect([byId("e1").hidden, byId("c1").hidden]).toEqual([false, true]);
      expect([byId("e2").hidden, byId("c2").hidden]).toEqual([true, false]);

      // Moving one header leaves the other header's halves where they are.
      byId("b2").click();
      expect([byId("e1").hidden, byId("c1").hidden]).toEqual([false, true]);
      expect([byId("e2").hidden, byId("c2").hidden]).toEqual([false, true]);
    });

    it("settles the pair when the expanded half arrives after the collapsed one", async () => {
      // A lone half is left as authored, so the pair is written only once the half
      // that completes it joins the header.
      await mount(`
        <div data-controller="stimeo--accordion">
          <h3><button id="b1" data-stimeo--accordion-target="trigger"
                      data-action="stimeo--accordion#toggle"
                      aria-expanded="true" aria-controls="p1">
            <span id="c1" data-stimeo--accordion-target="collapsedLabel">Show shipping</span>
          </button></h3>
          <div id="p1" data-stimeo--accordion-target="panel" role="region"
               aria-labelledby="b1">Ships within two business days.</div>
        </div>`);

      expect(byId("c1").hidden).toBe(false);

      byId("b1").insertAdjacentHTML(
        "afterbegin",
        `<span id="e1" data-stimeo--accordion-target="expandedLabel" hidden>Hide shipping</span>`,
      );
      await tick();

      expect([byId("e1").hidden, byId("c1").hidden]).toEqual([false, true]);
    });

    it("settles the pair when the collapsed half arrives after the expanded one", async () => {
      // The same arrival, from the other half and against a collapsed header.
      await mount(`
        <div data-controller="stimeo--accordion">
          <h3><button id="b1" data-stimeo--accordion-target="trigger"
                      data-action="stimeo--accordion#toggle"
                      aria-expanded="false" aria-controls="p1">
            <span id="e1" data-stimeo--accordion-target="expandedLabel">Hide returns</span>
          </button></h3>
          <div id="p1" data-stimeo--accordion-target="panel" role="region"
               aria-labelledby="b1" hidden>Returns are free for 30 days.</div>
        </div>`);

      expect(byId("e1").hidden).toBe(false);

      byId("b1").insertAdjacentHTML(
        "beforeend",
        `<span id="c1" data-stimeo--accordion-target="collapsedLabel" hidden>Show returns</span>`,
      );
      await tick();

      expect([byId("e1").hidden, byId("c1").hidden]).toEqual([true, false]);
    });

    it("settles a header's pair as the header joins the group", async () => {
      // A header reaches the group either as inserted markup or by taking the
      // target attribute on markup already in place. Until it is in the group its
      // halves belong to no header, so nothing is written for them.
      await mount(`
        <div data-controller="stimeo--accordion">
          <h3><button id="b1" data-stimeo--accordion-target="trigger"
                      data-action="stimeo--accordion#toggle"
                      aria-expanded="false" aria-controls="p1">Shipping</button></h3>
          <div id="p1" data-stimeo--accordion-target="panel" role="region"
               aria-labelledby="b1" hidden>Ships within two business days.</div>
          <h3><button id="b3" aria-expanded="true" aria-controls="p3">
            <span id="e3" data-stimeo--accordion-target="expandedLabel" hidden>Hide sizing</span>
            <span id="c3" data-stimeo--accordion-target="collapsedLabel">Show sizing</span>
          </button></h3>
          <div id="p3" data-stimeo--accordion-target="panel" role="region"
               aria-labelledby="b3">Sizes run small.</div>
        </div>`);

      expect([byId("e3").hidden, byId("c3").hidden]).toEqual([true, false]);

      root().insertAdjacentHTML(
        "beforeend",
        `<h3><button id="b2" data-stimeo--accordion-target="trigger"
                     data-action="stimeo--accordion#toggle"
                     aria-expanded="true" aria-controls="p2">
           <span id="e2" data-stimeo--accordion-target="expandedLabel" hidden>Hide returns</span>
           <span id="c2" data-stimeo--accordion-target="collapsedLabel">Show returns</span>
         </button></h3>
         <div id="p2" data-stimeo--accordion-target="panel" role="region"
              aria-labelledby="b2">Returns are free for 30 days.</div>`,
      );
      await tick();

      expect([byId("e2").hidden, byId("c2").hidden]).toEqual([false, true]);

      byId("b3").setAttribute("data-stimeo--accordion-target", "trigger");
      await tick();

      expect([byId("e3").hidden, byId("c3").hidden]).toEqual([false, true]);
    });

    it("settles the halves on connect, leaving the panel and reporting nothing", async () => {
      // Connection establishes no baseline: the halves alone are written, from the
      // header's own `aria-expanded`. The markup below contradicts itself twice over
      // — the halves are authored the wrong way round and the panel is hidden under
      // an expanded header — and only the halves are corrected. A settle that drove
      // the pair through the toggling path would move the panel or report a close.
      const capture = captureStateEvents("stimeo--accordion");
      try {
        await mount(`
          <div data-controller="stimeo--accordion">
            <h3><button id="b1" data-stimeo--accordion-target="trigger"
                        data-action="stimeo--accordion#toggle"
                        aria-expanded="true" aria-controls="p1">
              <span id="e1" data-stimeo--accordion-target="expandedLabel" hidden>Hide shipping</span>
              <span id="c1" data-stimeo--accordion-target="collapsedLabel">Show shipping</span>
            </button></h3>
            <div id="p1" data-stimeo--accordion-target="panel" role="region"
                 aria-labelledby="b1" hidden>Ships within two business days.</div>
          </div>`);

        expect(byId("e1").hidden).toBe(false);
        expect(byId("c1").hidden).toBe(true);
        expect(byId("b1").getAttribute("aria-expanded")).toBe("true");
        expect(byId("p1").hidden).toBe(true);
        expect(capture.names()).toEqual([]);
      } finally {
        capture.stop();
      }
    });
  });

  // --- State events ---

  describe("state events", () => {
    let capture: ReturnType<typeof captureStateEvents>;
    const panel = (id: string) => document.getElementById(id) as HTMLElement;

    beforeEach(() => {
      capture = captureStateEvents("stimeo--accordion");
    });

    afterEach(() => {
      capture.stop();
    });

    it("reports a header click with the pair that moved, after the attributes", () => {
      const states: string[] = [];
      const root = document.querySelector("[data-controller='stimeo--accordion']") as HTMLElement;
      root.addEventListener("stimeo--accordion:open", () => {
        states.push(`${triggers()[0]?.getAttribute("aria-expanded")} ${panel("p1").hidden}`);
      });

      triggers()[0]?.click();

      expect(capture.names()).toEqual(["open"]);
      expect(capture.seen[0]?.detail).toEqual({
        reason: "user",
        index: 0,
        trigger: triggers()[0],
        panel: panel("p1"),
      });
      expect(states).toEqual(["true false"]);
      expect(capture.seen[0]?.bubbles).toBe(true);
      expect(capture.seen[0]?.cancelable).toBe(false);

      triggers()[0]?.click();
      expect(capture.names()).toEqual(["open", "close"]);
    });

    it("reports expandAll once per pair that moved, and nothing the second time", () => {
      triggers()[0]?.click();
      capture.clear();

      (document.getElementById("expand-all") as HTMLButtonElement).click();

      expect(capture.names()).toEqual(["open"]);
      expect(capture.seen[0]?.detail).toMatchObject({ reason: "user", index: 1 });

      capture.clear();
      (document.getElementById("expand-all") as HTMLButtonElement).click();

      expect(capture.seen).toEqual([]);
    });

    it("reports collapseAll once per open pair", () => {
      (document.getElementById("expand-all") as HTMLButtonElement).click();
      capture.clear();

      (document.getElementById("collapse-all") as HTMLButtonElement).click();

      expect(capture.names()).toEqual(["close", "close"]);
      expect(capture.reasons()).toEqual(["user", "user"]);
    });

    it("reports a call with no DOM event as api", () => {
      const root = document.querySelector("[data-controller='stimeo--accordion']") as HTMLElement;
      const instance = application.getControllerForElementAndIdentifier(root, "stimeo--accordion");
      if (!(instance instanceof AccordionController)) throw new Error("controller not found");

      instance.expandAll();

      expect(capture.reasons()).toEqual(["api", "api"]);
    });
  });
});
