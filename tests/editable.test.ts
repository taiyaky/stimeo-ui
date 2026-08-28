import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { EditableController } from "../src/controllers/editable_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link EditableController}: the display ⇄ edit toggle —
 * entering edit mode (focus + select), `Enter` save / `Escape` cancel, blur
 * behavior under `submitOnBlur`, the `change`/`cancel` events, and `F2`.
 */

const markup = (submitOnBlur = true) => `
  <div data-controller="stimeo--editable"
       data-stimeo--editable-submit-on-blur-value="${submitOnBlur}">
    <button type="button" aria-label="Edit title"
            data-stimeo--editable-target="display"
            data-action="click->stimeo--editable#edit
                         keydown->stimeo--editable#onDisplayKeydown">Original</button>
    <input type="text" aria-label="Title" hidden
           data-stimeo--editable-target="input"
           data-action="keydown->stimeo--editable#onKeydown" />
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
    disconnectAndStopApplication(application);
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

  it("keeps editing when hiding the display reports its own departure", async () => {
    // A real click focuses the display first, so hiding it to enter edit mode
    // reports a focusout with nowhere to go. Reading that as "the user left"
    // would commit and close the editor the moment it opened.
    await mount();
    display().focus();
    display().click();
    display().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

    expect(root().dataset.mode).toBe("editing");
    expect(input().hidden).toBe(false);
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

  it("yields an Enter a descendant widget already consumed", async () => {
    // The Enter commit path yields to a descendant that already claimed the key,
    // so a completion popup confirming its candidate does not also end the edit.
    // The claim comes from a capture-phase handler because the binding is on the
    // INPUT, which has no children.
    await mount();
    display().click();
    input().value = "Still editing";
    root().addEventListener("keydown", (event) => event.preventDefault(), { capture: true });

    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    const notCanceled = input().dispatchEvent(event);

    expect(notCanceled).toBe(false); // the claim really took (a non-cancelable event would not)
    expect(root().dataset.mode).toBe("editing");
    expect(display().textContent).toBe("Original");
  });

  it("leaves an Escape an inner handler already owned", async () => {
    // The deepest handler that claims the press owns it, and this controller
    // yields in its Escape branch. Without that yield a nested overlay — a
    // combobox popup inside the edit row closing on its own Escape — would also
    // cancel the whole edit.
    //
    // The claim comes from a capture-phase handler because the only binding is
    // `keydown->…#onKeydown` on the INPUT, which has no children.
    await mount();
    display().click();
    input().value = "Kept";
    root().addEventListener("keydown", (event) => event.preventDefault(), { capture: true });

    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const notCanceled = input().dispatchEvent(event);

    expect(notCanceled).toBe(false); // the claim really took (a non-cancelable event would not)
    expect(root().dataset.mode).toBe("editing");
    expect(input().value).toBe("Kept");
  });

  it("keeps editing when Escape cancels an IME conversion", async () => {
    await mount();
    display().click();
    input().value = "にほん";

    // Cancelling a conversion (isComposing keydown) must not discard the edit.
    key(input(), { key: "Escape", isComposing: true });
    expect(root().dataset.mode).toBe("editing");
    expect(input().value).toBe("にほん");

    // A composition tracked via lifecycle events must also shield keys that
    // omit the per-event signal (the Safari-shaped confirm quirk).
    input().dispatchEvent(new CompositionEvent("compositionstart"));
    key(input(), { key: "Escape" });
    expect(root().dataset.mode).toBe("editing");
    input().dispatchEvent(new CompositionEvent("compositionend"));

    // With the composition over, Escape cancels the edit as usual.
    key(input(), { key: "Escape" });
    expect(root().dataset.mode).toBe("display");
  });

  it("does not save when Enter confirms an IME candidate", async () => {
    await mount();
    display().click();
    input().value = "日本";

    key(input(), { key: "Enter", isComposing: true });
    expect(root().dataset.mode).toBe("editing");
    expect(display().textContent).toBe("Original");

    key(input(), { key: "Enter" });
    expect(root().dataset.mode).toBe("display");
    expect(display().textContent).toBe("日本");
  });

  it("saves on blur when submitOnBlur is true", async () => {
    await mount(true);
    display().click();
    input().value = "Blurred";
    input().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(root().dataset.mode).toBe("display");
    expect(display().textContent).toBe("Blurred");
  });

  it("keeps editing on blur when submitOnBlur is false", async () => {
    await mount(false);
    display().click();
    input().value = "Kept";
    input().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
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
                data-action="keydown->stimeo--editable#onKeydown"></textarea>
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

  // --- Declared value (`data-value`) ------------------------------------------

  const declaredMarkup = () => `
    <div data-controller="stimeo--editable">
      <button type="button" aria-label="Edit date"
              data-value="2026-08-23"
              data-stimeo--editable-target="display"
              data-action="click->stimeo--editable#edit"><span class="icon" aria-hidden="true">*</span>August 23, 2026</button>
      <input type="text" aria-label="Date" hidden
             data-stimeo--editable-target="input"
             data-action="keydown->stimeo--editable#onKeydown" />
    </div>`;

  it("edits the value a display declares, leaving its rendered text alone", async () => {
    // A display whose text renders the value (a formatted date, an icon beside a
    // label) declares the value itself. Seeding from the text would hand the
    // input `*August 23, 2026`, which `type="date"` sanitizes away entirely.
    document.body.innerHTML = declaredMarkup();
    application = Application.start();
    application.register("stimeo--editable", EditableController);
    await tick();

    const changes: Array<{ value: string; previous: string }> = [];
    root().addEventListener("stimeo--editable:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });

    display().click();
    expect(input().value).toBe("2026-08-23");

    input().value = "2026-09-01";
    key(input(), { key: "Enter" });

    expect(display().dataset.value).toBe("2026-09-01");
    expect(display().querySelector(".icon")).not.toBeNull();
    expect(display().textContent).toBe("*August 23, 2026");
    expect(changes).toEqual([{ value: "2026-09-01", previous: "2026-08-23" }]);
  });

  // --- Save / cancel / revert actions ------------------------------------------

  const withControlsMarkup = () => `
    <div data-controller="stimeo--editable">
      <button type="button" aria-label="Edit title"
              data-stimeo--editable-target="display"
              data-action="click->stimeo--editable#edit">Original</button>
      <input type="text" aria-label="Title" hidden
             data-stimeo--editable-target="input"
             data-action="keydown->stimeo--editable#onKeydown" />
      <button type="button" id="save" data-action="click->stimeo--editable#save">Save</button>
      <button type="button" id="cancel" data-action="click->stimeo--editable#cancel">Cancel</button>
      <button type="button" id="revert" data-action="click->stimeo--editable#revert">Revert</button>
    </div>`;

  const mountWithControls = async () => {
    document.body.innerHTML = withControlsMarkup();
    application = Application.start();
    application.register("stimeo--editable", EditableController);
    await tick();
  };
  const control = (id: string) => document.getElementById(id) as HTMLButtonElement;

  it("commits through the save action", async () => {
    await mountWithControls();
    display().click();
    input().value = "Updated";
    control("save").click();
    expect(root().dataset.mode).toBe("display");
    expect(display().textContent).toBe("Updated");
    expect(document.activeElement).toBe(display());
  });

  it("discards through the cancel action", async () => {
    await mountWithControls();
    let cancelled = false;
    root().addEventListener("stimeo--editable:cancel", () => {
      cancelled = true;
    });
    display().click();
    input().value = "Throwaway";
    control("cancel").click();
    expect(root().dataset.mode).toBe("display");
    expect(display().textContent).toBe("Original");
    expect(cancelled).toBe(true);
  });

  it("keeps editing while focus moves to a control beside the input", async () => {
    // The blur fires before the button's own click. Without the containment
    // check the commit would beat it, so Cancel would save what it discards.
    await mountWithControls();
    display().click();
    input().value = "Throwaway";
    input().dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: control("cancel") }),
    );
    expect(root().dataset.mode).toBe("editing");
    expect(display().textContent).toBe("Original");
  });

  it("saves when focus leaves the editor entirely", async () => {
    await mountWithControls();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    display().click();
    input().value = "Blurred";
    input().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));
    expect(root().dataset.mode).toBe("display");
    expect(display().textContent).toBe("Blurred");
  });

  it("saves when focus leaves from a control beside the input", async () => {
    // Tabbing input → Cancel → out of the editor passes straight through the
    // button without activating it. The departure is watched on the controller
    // element, so it is seen from there too — binding the input alone would
    // strand the editor open with the edit neither saved nor discarded.
    await mountWithControls();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    display().click();
    input().value = "Tabbed past";
    input().dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: control("cancel") }),
    );
    expect(root().dataset.mode).toBe("editing");

    control("cancel").dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }),
    );

    expect(root().dataset.mode).toBe("display");
    expect(display().textContent).toBe("Tabbed past");
  });

  it("puts back the value the last save replaced, and only once", async () => {
    await mountWithControls();
    display().click();
    input().value = "Rejected by the server";
    key(input(), { key: "Enter" });
    expect(display().textContent).toBe("Rejected by the server");

    control("revert").click();
    expect(display().textContent).toBe("Original");

    // A second undo has nothing left to undo.
    display().textContent = "Something else";
    control("revert").click();
    expect(display().textContent).toBe("Something else");
  });

  it("stays silent when it reverts", async () => {
    // A `change` here would re-enter the handler that asked for the undo.
    await mountWithControls();
    display().click();
    input().value = "Rejected";
    key(input(), { key: "Enter" });

    let events = 0;
    root().addEventListener("stimeo--editable:change", () => {
      events += 1;
    });
    root().addEventListener("stimeo--editable:cancel", () => {
      events += 1;
    });
    control("revert").click();
    expect(display().textContent).toBe("Original");
    expect(events).toBe(0);
  });

  it("has nothing to revert when no save changed anything", async () => {
    await mountWithControls();
    display().click();
    key(input(), { key: "Enter" });
    control("revert").click();
    expect(display().textContent).toBe("Original");
  });

  // --- Runtime target changes ---------------------------------------------------

  it("hides an editing control that renders after connect", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--editable">
        <button type="button" aria-label="Edit title"
                data-stimeo--editable-target="display"
                data-action="click->stimeo--editable#edit">Original</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--editable", EditableController);
    await tick();

    const late = document.createElement("input");
    late.type = "text";
    late.setAttribute("data-stimeo--editable-target", "input");
    root().appendChild(late);
    await tick();

    expect(display().hidden).toBe(false);
    expect(input().hidden).toBe(true);
  });

  it("shows an editing control that replaces the live one mid-edit", async () => {
    // A server-rendered replacement arrives in its resting form, `hidden`. With
    // `submitOnBlur` off nothing else re-derives it, so both elements would be
    // hidden and no pointer or key could reach the widget again.
    await mount(false);
    display().click();
    input().value = "half typed";

    const fresh = document.createElement("input");
    fresh.type = "text";
    fresh.hidden = true;
    fresh.setAttribute("data-stimeo--editable-target", "input");
    fresh.setAttribute("data-action", "keydown->stimeo--editable#onKeydown");
    input().replaceWith(fresh);
    await tick();

    expect(root().dataset.mode).toBe("editing");
    expect(input().hidden).toBe(false);
    expect(display().hidden).toBe(true);
  });

  it("hides a display element that replaces the live one mid-edit", async () => {
    await mount(false);
    display().click();

    const fresh = document.createElement("button");
    fresh.type = "button";
    fresh.setAttribute("aria-label", "Edit title");
    fresh.setAttribute("data-stimeo--editable-target", "display");
    fresh.setAttribute("data-action", "click->stimeo--editable#edit");
    fresh.textContent = "Original";
    display().replaceWith(fresh);
    await tick();

    expect(display().hidden).toBe(true);
    expect(input().hidden).toBe(false);
  });

  it("still reports the outcome when the display element is gone", async () => {
    await mount();
    display().click();
    input().value = "typed";
    display().remove();
    await tick();

    const changes: Array<{ value: string; previous: string }> = [];
    root().addEventListener("stimeo--editable:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    key(input(), { key: "Enter" });
    expect(changes).toEqual([{ value: "typed", previous: "Original" }]);
    expect(root().dataset.mode).toBe("display");
  });

  it("still announces a cancel when the display element is gone", async () => {
    await mount();
    display().click();
    display().remove();
    await tick();

    let cancelled = false;
    root().addEventListener("stimeo--editable:cancel", () => {
      cancelled = true;
    });
    key(input(), { key: "Escape" });
    expect(cancelled).toBe(true);
    expect(root().dataset.mode).toBe("display");
  });

  // --- Guards outside edit mode --------------------------------------------------

  it("does nothing when the editing control has not rendered yet", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--editable">
        <button type="button" aria-label="Edit title"
                data-stimeo--editable-target="display"
                data-action="click->stimeo--editable#edit">Original</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--editable", EditableController);
    await tick();

    expect(() => display().click()).not.toThrow();
    expect(root().dataset.mode).toBe("display");
    expect(display().hidden).toBe(false);
  });

  it("ignores an Enter that reaches the input outside edit mode", async () => {
    await mount();
    let fired = false;
    root().addEventListener("stimeo--editable:change", () => {
      fired = true;
    });
    input().hidden = false;
    input().value = "never typed";
    key(input(), { key: "Enter" });
    expect(fired).toBe(false);
    expect(display().textContent).toBe("Original");
  });

  it("ignores an Escape that reaches the input outside edit mode", async () => {
    await mount();
    let cancelled = false;
    root().addEventListener("stimeo--editable:cancel", () => {
      cancelled = true;
    });
    input().hidden = false;
    key(input(), { key: "Escape" });
    expect(cancelled).toBe(false);
  });

  // --- Contract details ----------------------------------------------------------

  it("saves on blur with no attribute written, taking the declared default", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--editable">
        <button type="button" aria-label="Edit title"
                data-stimeo--editable-target="display"
                data-action="click->stimeo--editable#edit">Original</button>
        <input type="text" aria-label="Title" hidden
               data-stimeo--editable-target="input"
               data-action="keydown->stimeo--editable#onKeydown" />
      </div>`;
    application = Application.start();
    application.register("stimeo--editable", EditableController);
    await tick();

    display().click();
    input().value = "Blurred";
    input().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(root().dataset.mode).toBe("display");
    expect(display().textContent).toBe("Blurred");
  });

  it("carries an empty detail on cancel", async () => {
    await mount();
    const details: unknown[] = [];
    root().addEventListener("stimeo--editable:cancel", (event) => {
      details.push((event as CustomEvent).detail);
    });
    display().click();
    key(input(), { key: "Escape" });
    expect(details).toEqual([{}]);
  });

  it("selects the seeded text so typing replaces it", async () => {
    await mount();
    display().click();
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe("Original".length);
  });

  it("leaves focus where the user moved it when blur saves", async () => {
    await mount(true);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    display().click();
    input().value = "Blurred";
    outside.focus();
    input().dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));
    expect(root().dataset.mode).toBe("display");
    expect(document.activeElement).not.toBe(display());
  });

  it("stores what it shows, so re-committing an untouched value changes nothing", async () => {
    // The seed, the stored value, and the detail all pass through the same
    // normalization; otherwise a padded value silently rewrites the display
    // while reporting that nothing changed.
    await mount();
    const changes: Array<{ value: string; previous: string }> = [];
    root().addEventListener("stimeo--editable:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });

    display().click();
    input().value = "  Padded  ";
    key(input(), { key: "Enter" });
    expect(display().textContent).toBe("Padded");
    expect(changes).toEqual([{ value: "Padded", previous: "Original" }]);

    display().click();
    expect(input().value).toBe("Padded");
    key(input(), { key: "Enter" });
    expect(display().textContent).toBe("Padded");
    expect(changes).toHaveLength(1);
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
