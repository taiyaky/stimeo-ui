import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { ToolbarController } from "../src/controllers/toolbar_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link ToolbarController}: the APG Toolbar — single Tab
 * stop (roving tabindex), arrow/Home/End navigation honoring orientation and
 * wrap, and focus restoration to the most recently active control.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const markup = (attrs = "", tabindexes: [string, string, string] = ["0", "-1", "-1"]) => `
  <div data-controller="stimeo--toolbar" role="toolbar" aria-label="Text formatting" ${attrs}>
    <button type="button" tabindex="${tabindexes[0]}" data-stimeo--toolbar-target="control"
            data-action="keydown->stimeo--toolbar#onKeydown">Bold</button>
    <button type="button" tabindex="${tabindexes[1]}" data-stimeo--toolbar-target="control"
            data-action="keydown->stimeo--toolbar#onKeydown">Italic</button>
    <button type="button" tabindex="${tabindexes[2]}" data-stimeo--toolbar-target="control"
            data-action="keydown->stimeo--toolbar#onKeydown">Underline</button>
  </div>`;

describe("ToolbarController", () => {
  let application: Application;

  const start = async (attrs = "") => {
    document.body.innerHTML = markup(attrs);
    application = Application.start();
    application.register("stimeo--toolbar", ToolbarController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--toolbar']") as HTMLElement;
  const controls = () =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-stimeo--toolbar-target='control']"),
    );
  const tabindexes = () => controls().map((control) => control.tabIndex);
  const key = (index: number, k: string) =>
    controls()[index]?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  it("makes only the first control a tab stop", async () => {
    await start();
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("keeps a pre-existing tab stop as the entry point", async () => {
    document.body.innerHTML = markup("", ["-1", "0", "-1"]);
    application = Application.start();
    application.register("stimeo--toolbar", ToolbarController);
    await tick();
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("moves focus and the tab stop with horizontal arrows, wrapping", async () => {
    await start();
    key(0, "ArrowRight");
    expect(document.activeElement).toBe(controls()[1]);
    expect(tabindexes()).toEqual([-1, 0, -1]);

    key(1, "ArrowRight"); // -> last
    key(2, "ArrowRight"); // wrap -> first
    expect(document.activeElement).toBe(controls()[0]);

    key(0, "ArrowLeft"); // wrap back -> last
    expect(document.activeElement).toBe(controls()[2]);
  });

  it("jumps to first/last with Home/End", async () => {
    await start();
    key(0, "End");
    expect(document.activeElement).toBe(controls()[2]);
    key(2, "Home");
    expect(document.activeElement).toBe(controls()[0]);
  });

  it("uses vertical arrows when orientation is vertical", async () => {
    await start('data-stimeo--toolbar-orientation-value="vertical"');
    key(0, "ArrowDown");
    expect(document.activeElement).toBe(controls()[1]);
    // Horizontal arrows do nothing in vertical orientation.
    key(1, "ArrowRight");
    expect(document.activeElement).toBe(controls()[1]);
  });

  it("clamps at the ends when wrap is false", async () => {
    await start('data-stimeo--toolbar-wrap-value="false"');
    key(0, "ArrowLeft"); // already first -> stays
    expect(document.activeElement).toBe(controls()[0]);
    key(0, "End");
    key(2, "ArrowRight"); // already last -> stays
    expect(document.activeElement).toBe(controls()[2]);
  });

  // Markup with a per-control extra attribute (e.g. `disabled`) on one control.
  const markupWith = (extras: [string, string, string]) => `
    <div data-controller="stimeo--toolbar" role="toolbar" aria-label="Text formatting">
      <button type="button" tabindex="0" ${extras[0]} data-stimeo--toolbar-target="control"
              data-action="keydown->stimeo--toolbar#onKeydown">Bold</button>
      <button type="button" tabindex="-1" ${extras[1]} data-stimeo--toolbar-target="control"
              data-action="keydown->stimeo--toolbar#onKeydown">Italic</button>
      <button type="button" tabindex="-1" ${extras[2]} data-stimeo--toolbar-target="control"
              data-action="keydown->stimeo--toolbar#onKeydown">Underline</button>
    </div>`;

  const startWith = async (extras: [string, string, string]) => {
    document.body.innerHTML = markupWith(extras);
    application = Application.start();
    application.register("stimeo--toolbar", ToolbarController);
    await tick();
  };

  it("skips a disabled control when navigating", async () => {
    await startWith(["", "disabled", ""]);
    // ArrowRight from Bold must hop over the disabled Italic to Underline.
    key(0, "ArrowRight");
    expect(document.activeElement).toBe(controls()[2]);
    expect(tabindexes()).toEqual([-1, -1, 0]);
  });

  it("moves the lone tab stop off a disabled first control", async () => {
    await startWith(["disabled", "", ""]);
    // The disabled first control cannot be the tab stop; it moves to the next.
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("announces role, name, and orientation in order", async () => {
    await start();
    const phrases = await captureSpeech({ container: root(), steps: 4 });
    expect(phrases).toEqual([
      "toolbar, Text formatting, orientated horizontally",
      "button, Bold",
      "button, Italic",
      "button, Underline",
      "end of toolbar, Text formatting, orientated horizontally",
    ]);
  });

  it("has no machine-detectable a11y violations", async () => {
    await start();
    await expectNoA11yViolations(root());
  });
});
