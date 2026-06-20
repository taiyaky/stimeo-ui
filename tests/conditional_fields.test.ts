import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConditionalFieldsController } from "../src/controllers/conditional_fields_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link ConditionalFieldsController}: initial sync, show/hide
 * on trigger change, disabled syncing (preserving authored-disabled), data-when-value
 * and match="all", and focus retreat out of a hidden region.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ConditionalFieldsController", () => {
  let application: Application;

  const mount = async (inner: string, attrs = "") => {
    document.body.innerHTML = `
      <form data-controller="stimeo--conditional-fields" ${attrs}>${inner}</form>`;
    application = Application.start();
    application.register("stimeo--conditional-fields", ConditionalFieldsController);
    await tick();
  };

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const region = () => query<HTMLElement>("[data-stimeo--conditional-fields-target='region']");
  const trigger = () =>
    query<HTMLInputElement>("[data-stimeo--conditional-fields-target='trigger']");
  const setChecked = (checked: boolean) => {
    trigger().checked = checked;
    trigger().dispatchEvent(new Event("change", { bubbles: true }));
  };

  const CHECKBOX = `<input type="checkbox" data-stimeo--conditional-fields-target="trigger">`;

  it("hides an authored-visible region whose condition is false on connect", async () => {
    await mount(
      `${CHECKBOX}
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked>
         <input name="street">
       </fieldset>`,
    );
    expect(region().hidden).toBe(true);
    expect(region().getAttribute("aria-hidden")).toBe("true");
    expect(query<HTMLInputElement>("[name='street']").disabled).toBe(true);
    expect(region().hasAttribute("data-visible")).toBe(false);
  });

  it("shows the region and enables inputs when the condition becomes true", async () => {
    await mount(
      `${CHECKBOX}
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked hidden>
         <input name="street">
       </fieldset>`,
    );
    const changes: boolean[] = [];
    region()
      .closest("form")
      ?.addEventListener("stimeo--conditional-fields:change", (e) => {
        changes.push((e as CustomEvent).detail.visible);
      });

    setChecked(true);

    expect(region().hidden).toBe(false);
    expect(region().getAttribute("data-visible")).toBe("true");
    expect(region().hasAttribute("aria-hidden")).toBe(false);
    expect(query<HTMLInputElement>("[name='street']").disabled).toBe(false);
    expect(changes.at(-1)).toBe(true);

    setChecked(false);
    expect(region().hidden).toBe(true);
    expect(changes.at(-1)).toBe(false);
  });

  it("preserves an authored-disabled input when re-enabling", async () => {
    await mount(
      `${CHECKBOX}
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked hidden>
         <input name="a">
         <input name="b" disabled>
       </fieldset>`,
    );
    setChecked(true);
    expect(query<HTMLInputElement>("[name='a']").disabled).toBe(false);
    // Authored disabled stays disabled (we only re-enable what we disabled).
    expect(query<HTMLInputElement>("[name='b']").disabled).toBe(true);
  });

  it("does not disable inputs when disableHidden is false", async () => {
    await mount(
      `${CHECKBOX}
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked>
         <input name="street">
       </fieldset>`,
      'data-stimeo--conditional-fields-disable-hidden-value="false"',
    );
    expect(region().hidden).toBe(true);
    expect(query<HTMLInputElement>("[name='street']").disabled).toBe(false);
  });

  it("matches a select value with data-when-value", async () => {
    await mount(
      `<select data-stimeo--conditional-fields-target="trigger">
         <option value="self">Self</option>
         <option value="other">Other</option>
       </select>
       <fieldset data-stimeo--conditional-fields-target="region" data-when-value="other" hidden>
         <input name="recipient">
       </fieldset>`,
    );
    const select = query<HTMLSelectElement>("select");
    select.value = "other";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(region().hidden).toBe(false);

    select.value = "self";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(region().hidden).toBe(true);
  });

  it("requires all triggers with match=all", async () => {
    await mount(
      `<input type="checkbox" data-stimeo--conditional-fields-target="trigger">
       <input type="checkbox" data-stimeo--conditional-fields-target="trigger">
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked hidden>
         <input name="x">
       </fieldset>`,
      'data-stimeo--conditional-fields-match-value="all"',
    );
    const boxes = document.querySelectorAll<HTMLInputElement>(
      "[data-stimeo--conditional-fields-target='trigger']",
    );
    const [first, second] = boxes;
    if (!first || !second) throw new Error("expected two triggers");
    first.checked = true;
    first.dispatchEvent(new Event("change", { bubbles: true }));
    expect(region().hidden).toBe(true); // only one checked

    second.checked = true;
    second.dispatchEvent(new Event("change", { bubbles: true }));
    expect(region().hidden).toBe(false); // both checked
  });

  it("retreats focus out of a region being hidden", async () => {
    await mount(
      `${CHECKBOX}
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked hidden>
         <input name="street">
       </fieldset>`,
    );
    setChecked(true);
    query<HTMLInputElement>("[name='street']").focus();
    expect(document.activeElement).toBe(query("[name='street']"));

    setChecked(false);
    expect(document.activeElement).toBe(trigger());
  });

  it("shows a region when its trigger is unchecked (data-when-unchecked)", async () => {
    await mount(
      `${CHECKBOX}
       <fieldset data-stimeo--conditional-fields-target="region" data-when-unchecked>
         <input name="note">
       </fieldset>`,
    );
    expect(region().hidden).toBe(false); // unchecked → shown
    setChecked(true);
    expect(region().hidden).toBe(true); // checked → hidden
  });

  it("removes its listeners on disconnect", async () => {
    await mount(
      `${CHECKBOX}
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked hidden>
         <input name="street">
       </fieldset>`,
    );
    const root = query<HTMLFormElement>("form");
    root.remove();
    await tick();
    expect(() => root.dispatchEvent(new Event("change", { bubbles: true }))).not.toThrow();
  });

  it("has no a11y violations", async () => {
    await mount(
      `<label><input type="checkbox" data-stimeo--conditional-fields-target="trigger"> Ship elsewhere</label>
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked hidden>
         <label for="s">Street</label>
         <input id="s" name="street">
       </fieldset>`,
    );
    await expectNoA11yViolations(query("form"));
  });
});
