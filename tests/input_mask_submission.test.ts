import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { DirtyFormController } from "../src/controllers/dirty_form_controller";
import { InputMaskController } from "../src/controllers/input_mask_controller";
import { query } from "./helpers/dom";
import { dispatchFormData } from "./helpers/form_data";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/** Submission projections preserve other entries without committing a composing field. */
describe("input-mask submission eligibility", () => {
  let application: Application;
  const form = () => query<HTMLFormElement>("#f");
  const input = () => query<HTMLInputElement>("#i");
  const sink = () => query<HTMLInputElement>("#s");
  const entries = () => [...dispatchFormData(form())];
  const expected = [
    ["zip[]", "1234567"],
    ["middle", "before"],
    ["zip[]", "1234567"],
    ["middle", "after"],
    ["zip[]", "1234567"],
  ];
  async function start(permanent = false): Promise<void> {
    document.body.innerHTML = `<form id="f"><input name="zip[]" value="1234567"><input name="middle" value="before"><div id="box" ${permanent ? "data-turbo-permanent" : ""}><input id="i" value="1234567" data-controller="stimeo--input-mask" data-stimeo--input-mask-pattern-value="999-9999" data-action="input->stimeo--input-mask#format"></div><input id="s" name="zip[]" type="hidden" data-stimeo--input-mask-unmask="i"><input name="middle" value="after"><input name="zip[]" value="1234567"><div id="destination"></div></form><form id="other"></form>`;
    application = Application.start();
    application.register("stimeo--input-mask", InputMaskController);
    await tick();
  }
  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });
  for (const permanent of [false, true]) {
    it(`blanks only its own entry before detach delivery (permanent ${permanent})`, async () => {
      await start(permanent);
      expect(entries()).toEqual(expected);
      const events: string[] = [];
      for (const type of ["change", "reconcile"])
        input().addEventListener(`stimeo--input-mask:${type}`, () => events.push(type));
      query("#box").remove();
      const data = entries();
      expect(data).toEqual(expected.map((entry, index) => (index === 2 ? ["zip[]", ""] : entry)));
      expect(sink().value).toBe("1234567");
      expect(events).toEqual([]);
    });
  }
  it("projects repeated submissions without surrendering ownership during a temporary detach", async () => {
    await start();
    const field = input();
    field.remove();
    expect(entries()[2]).toEqual(["zip[]", ""]);
    expect(entries()[2]).toEqual(["zip[]", ""]);
    query("#box").append(field);
    expect(entries()).toEqual(expected);
  });
  it("blanks an entry when the controller token is removed before delivery", async () => {
    await start();
    input().removeAttribute("data-controller");
    expect(entries()[2]).toEqual(["zip[]", ""]);
  });
  it("blanks an entry when the source moves to another form before delivery", async () => {
    await start();
    query("#other").append(input());
    expect(entries()[2]).toEqual(["zip[]", ""]);
    form().append(input());
    expect(entries()).toEqual(expected);
  });
  it("preserves a page-written value and other consumers' entries", async () => {
    await start();
    sink().value = "page-owned";
    input().remove();
    form().addEventListener("formdata", (event) => event.formData.append("zip[]", "subscriber"));
    expect(entries()).toEqual([
      ...expected.map((entry, index) => (index === 2 ? ["zip[]", "page-owned"] : entry)),
      ["zip[]", "subscriber"],
    ]);
  });
  it("keeps the committed raw output while declarations wait for composition end", async () => {
    await start();
    const field = input();
    field.focus();
    field.setSelectionRange(3, 3);
    field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    field.value = "123う-4567";
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        isComposing: true,
        inputType: "insertCompositionText",
      }),
    );
    field.setAttribute("data-stimeo--input-mask-pattern-value", "");
    (
      application.getControllerForElementAndIdentifier(
        field,
        "stimeo--input-mask",
      ) as InputMaskController
    ).patternValueChanged();
    expect(entries()).toEqual(expected);
    expect(field.value).toBe("123う-4567");
    expect(sink().value).toBe("1234567");
  });
  it("distinguishes an original formless source from one that just lost its form", async () => {
    document.body.innerHTML =
      '<input id="i" value="1234567" data-controller="stimeo--input-mask" data-stimeo--input-mask-pattern-value="999-9999" data-action="input->stimeo--input-mask#format"><form id="f"><input id="s" name="zip" type="hidden" data-stimeo--input-mask-unmask="i"></form>';
    application = Application.start();
    application.register("stimeo--input-mask", InputMaskController);
    await tick();
    expect(input().form).toBe(null);
    expect([...dispatchFormData(form())]).toEqual([["zip", "1234567"]]);
    form().prepend(input());
    input().dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", isComposing: false }),
    );
    document.body.prepend(input());
    expect(input().form).toBe(null);
    expect([...dispatchFormData(form())]).toEqual([["zip", ""]]);
  });
  it("honors a synchronization stop before its Value callback", async () => {
    await start();
    input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    expect(entries()[2]).toEqual(["zip[]", ""]);
  });
  it("restores an ordinary name when synchronization releases the sink", async () => {
    await start();
    const controller = application.getControllerForElementAndIdentifier(
      input(),
      "stimeo--input-mask",
    ) as InputMaskController;
    expect(sink().name).not.toBe("zip[]");
    input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    controller.unmaskToHiddenValueChanged();
    expect(sink().name).toBe("zip[]");
    expect(entries()[2]).toEqual(["zip[]", ""]);
    sink().value = "page-owned";
    controller.disconnect();
    expect(entries()[2]).toEqual(["zip[]", "page-owned"]);
  });
  it("allows a normal same-form move without adopting another sink", async () => {
    await start();
    query("#destination").append(input());
    expect(entries()).toEqual(expected);
  });
  it("leaves readonly and disabled sources' committed output eligible", async () => {
    await start();
    input().readOnly = true;
    input().disabled = true;
    expect(entries()).toEqual(expected);
  });
  it("keeps dirty-form's logical-name baseline when only the transport name changes", async () => {
    document.body.innerHTML =
      '<form id="f" data-controller="stimeo--dirty-form"><input id="i" value="123-4567" data-controller="stimeo--input-mask" data-stimeo--input-mask-pattern-value="999-9999" data-action="input->stimeo--input-mask#format"><input id="s" type="hidden" name="zip" value="1234567" data-stimeo--input-mask-unmask="i"></form>';
    application = Application.start();
    application.register("stimeo--dirty-form", DirtyFormController);
    application.register("stimeo--input-mask", InputMaskController);
    await tick();
    input().dispatchEvent(new Event("input", { bubbles: true }));
    expect(form().hasAttribute("data-dirty")).toBe(false);
    expect(dispatchFormData(form()).get("zip")).toBe("1234567");
  });
  it("registers a detached form through its public entry before or after hidden arrival", async () => {
    await start();
    const single = await import("../src/controllers/input_mask_controller");
    expect(typeof single.prepareInputMaskForm).toBe("function");
    const fresh = document.createElement("form");
    fresh.innerHTML = '<input name="zip[]" value="before"><input name="zip[]" value="after">';
    const field = sink();
    const key = field.name;
    fresh.insertBefore(field, fresh.lastElementChild);
    single.prepareInputMaskForm(fresh);
    single.prepareInputMaskForm(fresh);
    const projected = [
      ["zip[]", "before"],
      ["zip[]", ""],
      ["zip[]", "after"],
    ];
    expect([...dispatchFormData(fresh)]).toEqual(projected);
    expect([...dispatchFormData(fresh)]).toEqual(projected);
    const next = document.createElement("form");
    single.prepareInputMaskForm(next);
    next.append(field);
    expect([...dispatchFormData(next)]).toEqual([["zip[]", ""]]);
    expect([...dispatchFormData(fresh)]).toEqual([
      ["zip[]", "before"],
      ["zip[]", "after"],
    ]);
    form().append(field);
    expect(dispatchFormData(form()).getAll("zip[]")).toEqual(["1234567", "1234567", "1234567"]);
    expect(field.name).toBe(key);
    expect(field.value).toBe("1234567");
  });
  it("applies held tokens to the next committed raw output without freezing submission", async () => {
    await start();
    const field = input();
    field.focus();
    field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    field.value = "123-4567A";
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        isComposing: true,
        inputType: "insertCompositionText",
      }),
    );
    field.setAttribute("data-stimeo--input-mask-tokens-value", JSON.stringify({ "9": "[A-Z]" }));
    const controller = application.getControllerForElementAndIdentifier(
      field,
      "stimeo--input-mask",
    ) as InputMaskController;
    controller.tokensValueChanged();
    expect(entries()).toEqual(expected);
    expect(field.value).toBe("123-4567A");
    field.dispatchEvent(new Event("compositionend", { bubbles: true }));
    expect(field.value).toBe("A");
    expect(entries()[2]).toEqual(["zip[]", "A"]);
  });
  it("restores its transport name when a morph writes the public name back", async () => {
    await start();
    const key = sink().name;
    sink().name = "zip[]";
    sink().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    expect(sink().name).toBe(key);
    query("#box").remove();
    expect(entries()[2]).toEqual(["zip[]", ""]);
  });
  it("leaves another name a morph writes to the page", async () => {
    await start();
    sink().name = "postal";
    sink().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    expect(sink().name).toBe("postal");
    expect(dispatchFormData(form()).getAll("postal")).toEqual(["1234567"]);
  });
  it("claims a new transport name at the next format after the page writes the public name", async () => {
    await start();
    const key = sink().name;
    sink().name = "zip[]";
    input().dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(sink().name).not.toBe(key);
    expect(sink().name.startsWith("__stimeo_raw_v1_")).toBe(true);
    query("#box").remove();
    expect(entries()[2]).toEqual(["zip[]", ""]);
  });
});

/** Eligibility follows the source's connection and the application that owns it. */
describe("input-mask submission eligibility within an application root", () => {
  let application: Application;
  const form = () => query<HTMLFormElement>("#f");
  const input = () => query<HTMLInputElement>("#i");
  async function start(): Promise<void> {
    document.body.innerHTML = `<div id="app"><form id="f"><input name="zip" value="1234567"><div id="box"><input id="i" value="1234567" data-controller="stimeo--input-mask" data-stimeo--input-mask-pattern-value="999-9999" data-action="input->stimeo--input-mask#format"></div><input id="s" name="zip" type="hidden" data-stimeo--input-mask-unmask="i"></form></div><div id="outside"></div>`;
    application = Application.start(query("#app"));
    application.register("stimeo--input-mask", InputMaskController);
    await tick();
  }
  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });
  it("blanks a source that leaves the application root while it stays in the form", async () => {
    await start();
    const field = input();
    field.setAttribute("form", "f");
    query("#outside").append(field);
    expect(field.form).toBe(form());
    expect([...dispatchFormData(form())]).toEqual([
      ["zip", "1234567"],
      ["zip", ""],
    ]);
  });
  it("blanks a source detached together with its application root", async () => {
    await start();
    const detached = form();
    const source = input();
    query("#app").remove();
    expect(source.isConnected).toBe(false);
    expect([...dispatchFormData(detached)]).toEqual([
      ["zip", "1234567"],
      ["zip", ""],
    ]);
  });
});
