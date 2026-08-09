import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccordionController } from "../src/controllers/accordion_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
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
});
