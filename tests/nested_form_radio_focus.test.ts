import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { NestedFormController } from "../src/controllers/nested_form_controller";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/** Added and surviving rows receive focus at their radio group's sequential stop. */
describe("NestedFormController radio focus", () => {
  let application: Application | undefined;

  /** Creates one independent row with its checked radio after an unchecked sibling. */
  const radioRow = (id: string, checked = true, unavailable = "", persisted = false) => `
    <fieldset id="${id}">
      <legend>Size</legend>
      <input type="radio" id="${id}-small" name="items[${id}][size]" value="s" aria-label="Small">
      <input type="radio" id="${id}-medium" name="items[${id}][size]" value="m" aria-label="Medium"
        ${checked ? "checked" : ""} ${unavailable}>
      ${persisted ? '<input type="hidden" value="0" data-stimeo--nested-form-target="destroyFlag">' : ""}
      <button type="button" data-stimeo--nested-form-target="remove">Remove</button>
    </fieldset>`;

  const mount = async (rows = "", template = radioRow("added")) => {
    document.body.innerHTML = `
      <div id="host" data-controller="stimeo--nested-form">
        <div data-stimeo--nested-form-target="list">${rows}</div>
        <template data-stimeo--nested-form-target="template">${template}</template>
        <button type="button" id="add" data-stimeo--nested-form-target="add"
          data-action="stimeo--nested-form#add">Add</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--nested-form", NestedFormController);
    await tick();
  };

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    document.body.innerHTML = "";
  });

  it("focuses the checked radio before reporting an added row", async () => {
    await mount();
    const focusedAtAdd: string[] = [];
    query("#host").addEventListener("stimeo--nested-form:add", () => {
      focusedAtAdd.push(document.activeElement?.id ?? "");
    });

    query<HTMLButtonElement>("#add").click();

    expect(document.activeElement).toBe(query("#added-medium"));
    expect(focusedAtAdd).toEqual(["added-medium"]);
    expect(query<HTMLInputElement>("#added-small").checked).toBe(false);
    expect(query<HTMLInputElement>("#added-medium").checked).toBe(true);
  });

  it.each([false, true])(
    "focuses the following row's checked radio after removal (persisted=%s)",
    async (persisted) => {
      await mount(radioRow("removed", true, "", persisted) + radioRow("survivor"));
      const focusedAtRemove: string[] = [];
      query("#host").addEventListener("stimeo--nested-form:remove", () => {
        focusedAtRemove.push(document.activeElement?.id ?? "");
      });

      query<HTMLButtonElement>("#removed button").click();

      expect(document.activeElement).toBe(query("#survivor-medium"));
      expect(focusedAtRemove).toEqual(["survivor-medium"]);
      expect(query<HTMLInputElement>("#survivor-small").checked).toBe(false);
      expect(query<HTMLInputElement>("#survivor-medium").checked).toBe(true);
      const removed = document.getElementById("removed");
      if (persisted) {
        expect(removed?.hidden).toBe(true);
        expect(query<HTMLInputElement>("#removed input[type='hidden']").value).toBe("1");
      } else expect(removed).toBeNull();
    },
  );

  it("uses the preceding row's checked radio when the final row is removed", async () => {
    await mount(radioRow("survivor") + radioRow("removed"));
    query<HTMLButtonElement>("#removed button").click();

    expect(document.activeElement).toBe(query("#survivor-medium"));
  });

  it("uses the first radio of a newly added unchecked group", async () => {
    await mount("", radioRow("added", false));
    query<HTMLButtonElement>("#add").click();

    expect(document.activeElement).toBe(query("#added-small"));
    expect(query<HTMLInputElement>("#added-medium").checked).toBe(false);
  });

  it.each(["disabled", "hidden", 'tabindex="-1"'])(
    "uses an available radio when the checked radio is %s",
    async (unavailable) => {
      await mount("", radioRow("added", true, unavailable));
      query<HTMLButtonElement>("#add").click();

      expect(document.activeElement).toBe(query("#added-small"));
      expect(query<HTMLInputElement>("#added-medium").checked).toBe(true);
    },
  );

  it("keeps an earlier text field ahead of the row's radio group", async () => {
    await mount(
      "",
      radioRow("added").replace("<legend>", '<input id="first" aria-label="Name"><legend>'),
    );
    query<HTMLButtonElement>("#add").click();

    expect(document.activeElement).toBe(query("#first"));
  });

  it("keeps different radio names as separate groups in a row", async () => {
    await mount("", radioRow("added").replace('name="items[added][size]"', 'name="independent"'));
    query<HTMLButtonElement>("#add").click();

    expect(document.activeElement).toBe(query("#added-small"));
  });
});
