import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToggleGroupController } from "../src/controllers/toggle_group_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ToggleGroupController}: the APG toggle-button group
 * — `aria-pressed`, single/multiple selection, Toolbar-style roving where arrows
 * move focus only, and the `change` event.
 */

const markup = (mode?: string) => `
  <div data-controller="stimeo--toggle-group" role="group" aria-label="Text style"
       ${mode ? `data-stimeo--toggle-group-mode-value="${mode}"` : ""}>
    <button type="button" aria-pressed="true" tabindex="0" data-value="bold"
            data-stimeo--toggle-group-target="item"
            data-action="click->stimeo--toggle-group#toggle
                         keydown->stimeo--toggle-group#onKeydown">Bold</button>
    <button type="button" aria-pressed="false" tabindex="-1" data-value="italic"
            data-stimeo--toggle-group-target="item"
            data-action="click->stimeo--toggle-group#toggle
                         keydown->stimeo--toggle-group#onKeydown">Italic</button>
    <button type="button" aria-pressed="false" tabindex="-1" data-value="underline"
            data-stimeo--toggle-group-target="item"
            data-action="click->stimeo--toggle-group#toggle
                         keydown->stimeo--toggle-group#onKeydown">Underline</button>
  </div>`;

describe("ToggleGroupController", () => {
  let application: Application;

  const start = async (mode?: string) => {
    document.body.innerHTML = markup(mode);
    application = Application.start();
    application.register("stimeo--toggle-group", ToggleGroupController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--toggle-group']") as HTMLElement;
  const items = () =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-stimeo--toggle-group-target='item']"),
    );
  const pressed = () => items().map((item) => item.getAttribute("aria-pressed"));
  const tabindexes = () => items().map((item) => item.tabIndex);
  const key = (index: number, k: string) =>
    items()[index]?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  it("reverses the horizontal arrows under RTL without touching the vertical pair", async () => {
    // Logical direction: APG describes these as "next / previous", so the pair
    // reverses with the writing direction. `dir="rtl"` is the authoring contract,
    // but happy-dom does not resolve it into the computed style, so the direction
    // is set as an inline style instead.
    // Right/Down and Left/Up share a case body here, so a careless swap would
    // flip the vertical axis too. That is what this pins.
    await start();
    root().style.direction = "rtl";

    key(0, "ArrowLeft"); // "next" under RTL
    expect(tabindexes()).toEqual([-1, 0, -1]);

    key(1, "ArrowRight"); // "previous"
    expect(tabindexes()).toEqual([0, -1, -1]);

    key(0, "ArrowDown"); // unchanged: the vertical pair carries no direction
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("yields a key a descendant widget already consumed", async () => {
    // A composed widget that claims the key must not ALSO move the roving focus —
    // composition depends on this yield.
    await start();
    items()[0]?.focus();
    const inner = document.createElement("span");
    items()[0]?.append(inner);
    inner.addEventListener("keydown", (event) => event.preventDefault());

    const claimed = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    const notCanceled = inner.dispatchEvent(claimed);

    expect(notCanceled).toBe(false); // the claim really took (a non-cancelable event would not)
    expect(document.activeElement).toBe(items()[0]);
  });

  it("establishes roving from the first pressed item", async () => {
    await start();
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("toggles independently in multiple mode (the default)", async () => {
    await start();
    items()[1]?.click();
    expect(pressed()).toEqual(["true", "true", "false"]);
    items()[0]?.click();
    expect(pressed()).toEqual(["false", "true", "false"]);
  });

  it("keeps at most one pressed in single mode", async () => {
    await start("single");
    items()[1]?.click();
    expect(pressed()).toEqual(["false", "true", "false"]);
    items()[1]?.click(); // pressing the pressed one releases it
    expect(pressed()).toEqual(["false", "false", "false"]);
  });

  it("moves focus only with arrows (no toggle), wrapping", async () => {
    await start();
    key(0, "ArrowRight");
    expect(document.activeElement).toBe(items()[1]);
    expect(pressed()).toEqual(["true", "false", "false"]); // unchanged

    // Dispatch each arrow on the *currently focused* item, as a real user would,
    // so the move is driven by event.currentTarget rather than internal state.
    key(1, "ArrowLeft"); // focused item 1 -> back to 0
    expect(document.activeElement).toBe(items()[0]);

    key(0, "ArrowLeft"); // focused item 0 -> wrap to last
    expect(document.activeElement).toBe(items()[2]);
  });

  it("jumps to first/last with Home/End", async () => {
    await start();
    key(0, "End");
    expect(document.activeElement).toBe(items()[2]);
    key(2, "Home");
    expect(document.activeElement).toBe(items()[0]);
  });

  it("dispatches change with value, pressed, and the pressed values", async () => {
    await start();
    const details: Array<{ value: string; pressed: boolean; values: string[] }> = [];
    root().addEventListener("stimeo--toggle-group:change", (event) => {
      details.push((event as CustomEvent).detail);
    });
    items()[1]?.click();
    expect(details).toEqual([{ value: "italic", pressed: true, values: ["bold", "italic"] }]);
  });

  it("announces role, name, and pressed state in order", async () => {
    await start();
    const phrases = await captureSpeech({ container: root(), steps: 4 });
    expect(phrases).toEqual([
      "group, Text style",
      "button, Bold, pressed",
      "button, Italic, not pressed",
      "button, Underline, not pressed",
      "end of group, Text style",
    ]);
  });

  it("leaves a modified arrow to the browser (Alt+Left/Right is history navigation)", async () => {
    await start();
    items()[0]?.focus();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    items()[0]?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(items()[0]);
    expect(tabindexes()).toEqual([0, -1, -1]); // the roving tab stop stayed put
  });

  it("has no machine-detectable a11y violations", async () => {
    await start();
    await expectNoA11yViolations(root());
  });
});

/**
 * Space/Enter activation is verified on a non-native host (`div role="button"`):
 * a real `<button>` synthesizes a click (which #toggle handles), so the
 * controller deliberately drives keyboard toggling only for non-button hosts.
 */
describe("ToggleGroupController on non-button hosts", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--toggle-group" role="group" aria-label="View">
        <div role="button" aria-pressed="false" tabindex="0" data-value="grid"
             data-stimeo--toggle-group-target="item"
             data-action="click->stimeo--toggle-group#toggle
                          keydown->stimeo--toggle-group#onKeydown">Grid</div>
        <div role="button" aria-pressed="false" tabindex="-1" data-value="list"
             data-stimeo--toggle-group-target="item"
             data-action="click->stimeo--toggle-group#toggle
                          keydown->stimeo--toggle-group#onKeydown">List</div>
      </div>`;
    application = Application.start();
    application.register("stimeo--toggle-group", ToggleGroupController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("toggles on Space and Enter", () => {
    const items = Array.from(
      document.querySelectorAll<HTMLElement>("[data-stimeo--toggle-group-target='item']"),
    );
    items[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(items[0]?.getAttribute("aria-pressed")).toBe("true");
    items[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(items[0]?.getAttribute("aria-pressed")).toBe("false");
  });
});
