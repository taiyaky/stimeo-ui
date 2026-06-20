import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToggleGroupController } from "../src/controllers/toggle_group_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link ToggleGroupController}: the APG toggle-button group
 * — `aria-pressed`, single/multiple selection, Toolbar-style roving where arrows
 * move focus only, and the `change` event.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    application.stop();
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
    application.stop();
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
