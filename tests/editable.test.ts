import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { EditableController } from "../src/controllers/editable_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link EditableController}: the display ⇄ edit toggle —
 * entering edit mode (focus + select), `Enter` save / `Escape` cancel, blur
 * behavior under `submitOnBlur`, the `change`/`cancel` events, and `F2`.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const markup = (submitOnBlur = true) => `
  <div data-controller="stimeo--editable"
       data-stimeo--editable-submit-on-blur-value="${submitOnBlur}">
    <button type="button" aria-label="Edit title"
            data-stimeo--editable-target="display"
            data-action="click->stimeo--editable#edit
                         keydown->stimeo--editable#onDisplayKeydown">Original</button>
    <input type="text" aria-label="Title" hidden
           data-stimeo--editable-target="input"
           data-action="keydown->stimeo--editable#onKeydown
                        blur->stimeo--editable#onBlur" />
  </div>`;

describe("EditableController", () => {
  let application: Application;

  const mount = async (submitOnBlur = true) => {
    document.body.innerHTML = markup(submitOnBlur);
    application = Application.start();
    application.register("stimeo--editable", EditableController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--editable']") as HTMLElement;
  const display = () =>
    document.querySelector<HTMLElement>("[data-stimeo--editable-target='display']") as HTMLElement;
  const input = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--editable-target='input']",
    ) as HTMLInputElement;
  const key = (el: HTMLElement, init: KeyboardEventInit) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));

  it("starts in display mode with the input hidden", async () => {
    await mount();
    expect(root().dataset.mode).toBe("display");
    expect(display().hidden).toBe(false);
    expect(input().hidden).toBe(true);
  });

  it("enters edit mode on click, focusing and selecting the input", async () => {
    await mount();
    display().click();
    expect(root().dataset.mode).toBe("editing");
    expect(display().hidden).toBe(true);
    expect(input().hidden).toBe(false);
    expect(input().value).toBe("Original");
    expect(document.activeElement).toBe(input());
  });

  it("enters edit mode on F2 from the display element", async () => {
    await mount();
    key(display(), { key: "F2" });
    expect(root().dataset.mode).toBe("editing");
  });

  it("saves on Enter, updating display and dispatching change with previous", async () => {
    await mount();
    const changes: Array<{ value: string; previous: string }> = [];
    root().addEventListener("stimeo--editable:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    display().click();
    input().value = "Updated";
    key(input(), { key: "Enter" });
    expect(root().dataset.mode).toBe("display");
    expect(display().textContent).toBe("Updated");
    expect(changes).toEqual([{ value: "Updated", previous: "Original" }]);
    expect(document.activeElement).toBe(display());
  });

  it("does not dispatch change when the value is unchanged", async () => {
    await mount();
    let fired = false;
    root().addEventListener("stimeo--editable:change", () => {
      fired = true;
    });
    display().click();
    key(input(), { key: "Enter" });
    expect(fired).toBe(false);
    expect(root().dataset.mode).toBe("display");
  });

  it("cancels on Escape, discarding edits and dispatching cancel", async () => {
    await mount();
    let cancelled = false;
    root().addEventListener("stimeo--editable:cancel", () => {
      cancelled = true;
    });
    display().click();
    input().value = "Throwaway";
    key(input(), { key: "Escape" });
    expect(root().dataset.mode).toBe("display");
    expect(display().textContent).toBe("Original");
    expect(cancelled).toBe(true);
    expect(document.activeElement).toBe(display());
  });

  it("saves on blur when submitOnBlur is true", async () => {
    await mount(true);
    display().click();
    input().value = "Blurred";
    input().dispatchEvent(new FocusEvent("blur"));
    expect(root().dataset.mode).toBe("display");
    expect(display().textContent).toBe("Blurred");
  });

  it("keeps editing on blur when submitOnBlur is false", async () => {
    await mount(false);
    display().click();
    input().value = "Kept";
    input().dispatchEvent(new FocusEvent("blur"));
    expect(root().dataset.mode).toBe("editing");
  });

  // --- Multiline (<textarea>) variant -----------------------------------------

  const multilineMarkup = (submitOnBlur = true) => `
    <div data-controller="stimeo--editable"
         data-stimeo--editable-submit-on-blur-value="${submitOnBlur}">
      <button type="button" aria-label="Edit notes"
              data-stimeo--editable-target="display"
              data-action="click->stimeo--editable#edit
                           keydown->stimeo--editable#onDisplayKeydown">Original</button>
      <textarea aria-label="Notes" hidden
                data-stimeo--editable-target="input"
                data-action="keydown->stimeo--editable#onKeydown
                             blur->stimeo--editable#onBlur"></textarea>
    </div>`;

  const mountMultiline = async (submitOnBlur = true) => {
    document.body.innerHTML = multilineMarkup(submitOnBlur);
    application = Application.start();
    application.register("stimeo--editable", EditableController);
    await tick();
  };

  it("saves a multiline textarea on Ctrl+Enter, keeping line breaks", async () => {
    await mountMultiline();
    const changes: Array<{ value: string; previous: string }> = [];
    root().addEventListener("stimeo--editable:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    display().click();
    input().value = "Line 1\nLine 2";
    key(input(), { key: "Enter", ctrlKey: true });
    expect(root().dataset.mode).toBe("display");
    expect(display().textContent).toBe("Line 1\nLine 2");
    expect(changes).toEqual([{ value: "Line 1\nLine 2", previous: "Original" }]);
  });

  it("saves a multiline textarea on Cmd+Enter (macOS) too", async () => {
    await mountMultiline();
    display().click();
    input().value = "Done on mac";
    key(input(), { key: "Enter", metaKey: true });
    expect(root().dataset.mode).toBe("display");
    expect(display().textContent).toBe("Done on mac");
  });

  it("does not save a textarea on a bare Enter (lets the newline be inserted)", async () => {
    await mountMultiline();
    display().click();
    input().value = "Editing";
    key(input(), { key: "Enter" });
    expect(root().dataset.mode).toBe("editing");
  });

  it("announces the editable trigger by its accessible name", async () => {
    await mount();
    const phrases = await captureSpeech({ container: root(), steps: 1 });
    expect(phrases).toEqual(["button, Edit title", "Original"]);
  });

  it("has no machine-detectable a11y violations (display and editing)", async () => {
    await mount();
    await expectNoA11yViolations(root());
    display().click();
    await expectNoA11yViolations(root());
  });
});
