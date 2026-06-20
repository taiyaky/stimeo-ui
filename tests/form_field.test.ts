import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FormFieldController } from "../src/controllers/form_field_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link FormFieldController}: the accessible association
 * substrate — `aria-describedby` composition, `aria-invalid`/`aria-errormessage`
 * toggling, the server-rendered-error reflection, and the `validate` event.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("FormFieldController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--form-field">
        <label for="email">Email</label>
        <input id="email" type="email" aria-invalid="false"
               data-stimeo--form-field-target="control" />
        <p data-stimeo--form-field-target="description">We'll send a confirmation.</p>
        <p role="alert" hidden data-stimeo--form-field-target="error"></p>
        <button type="button"
                data-stimeo--form-field-message-param="Email is required"
                data-action="stimeo--form-field#setError">Fail</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--form-field", FormFieldController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--form-field']") as HTMLElement;
  const control = () => document.querySelector<HTMLInputElement>("#email") as HTMLInputElement;
  const description = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--form-field-target='description']",
    ) as HTMLElement;
  const error = () =>
    document.querySelector<HTMLElement>("[data-stimeo--form-field-target='error']") as HTMLElement;
  const failButton = () => document.querySelector<HTMLButtonElement>("button") as HTMLButtonElement;
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--form-field",
    ) as FormFieldController;

  it("announces the control name, description, and invalid state in order", async () => {
    // The description is wired via aria-describedby and the error via
    // aria-errormessage + aria-invalid; capturing the control's announcement pins
    // that both the composed description text and the invalid state reach the SR.
    const before = await captureSpeech({ container: control(), steps: 0 });
    expect(before).toEqual(["textbox, Email, We'll send a confirmation., not invalid"]);

    failButton().click();
    const after = await captureSpeech({ container: control(), steps: 0 });
    expect(after).toEqual([
      "textbox, Email, We'll send a confirmation. Email is required, invalid",
    ]);
  });

  it("links the description into aria-describedby and starts valid", () => {
    expect(description().id).toBeTruthy();
    expect(control().getAttribute("aria-describedby")).toBe(description().id);
    expect(control().getAttribute("aria-invalid")).toBe("false");
    expect(control().hasAttribute("aria-errormessage")).toBe(false);
    expect(root().hasAttribute("data-stimeo--form-field-invalid")).toBe(false);
  });

  it("shows an error and wires invalid state via an action param", () => {
    failButton().click();

    expect(error().hidden).toBe(false);
    expect(error().textContent).toBe("Email is required");
    expect(control().getAttribute("aria-invalid")).toBe("true");
    expect(control().getAttribute("aria-errormessage")).toBe(error().id);
    // The error id is also in describedby for AT that ignore aria-errormessage.
    expect(control().getAttribute("aria-describedby")?.split(" ")).toContain(error().id);
    expect(root().hasAttribute("data-stimeo--form-field-invalid")).toBe(true);
  });

  it("dispatches validate with the message on setError and clearError", () => {
    const events: Array<{ valid: boolean; message: string }> = [];
    root().addEventListener("stimeo--form-field:validate", (event) => {
      events.push((event as CustomEvent).detail);
    });

    controller().setError("Bad value");
    controller().clearError();

    expect(events).toEqual([
      { valid: false, message: "Bad value" },
      { valid: true, message: "" },
    ]);
  });

  it("clears the error and restores valid state", () => {
    controller().setError("Oops");
    controller().clearError();

    expect(error().hidden).toBe(true);
    expect(error().textContent).toBe("");
    expect(control().getAttribute("aria-invalid")).toBe("false");
    expect(control().hasAttribute("aria-errormessage")).toBe(false);
    expect(control().getAttribute("aria-describedby")).toBe(description().id);
    expect(root().hasAttribute("data-stimeo--form-field-invalid")).toBe(false);
  });

  it("focuses the control on error only when focusOnError is set", () => {
    controller().setError("nope");
    expect(document.activeElement).not.toBe(control());

    root().setAttribute("data-stimeo--form-field-focus-on-error-value", "true");
    controller().setError("again");
    expect(document.activeElement).toBe(control());
  });

  it("has no machine-detectable a11y violations in valid and error states", async () => {
    await expectNoA11yViolations(root());
    controller().setError("Email is required");
    await expectNoA11yViolations(root());
  });
});

/**
 * A server-rendered error (already visible and non-empty at connect) should put
 * the field straight into the invalid state — progressive enhancement.
 */
describe("FormFieldController with a server-rendered error", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--form-field">
        <label for="amount">Amount</label>
        <input id="amount" type="text" aria-describedby="hint"
               data-stimeo--form-field-target="control" />
        <span id="hint">External hint.</span>
        <p data-stimeo--form-field-target="error">Must be positive.</p>
      </div>`;
    application = Application.start();
    application.register("stimeo--form-field", FormFieldController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const control = () => document.querySelector<HTMLInputElement>("#amount") as HTMLInputElement;
  const error = () =>
    document.querySelector<HTMLElement>("[data-stimeo--form-field-target='error']") as HTMLElement;

  it("reflects the invalid state and preserves the consumer's describedby token", () => {
    expect(control().getAttribute("aria-invalid")).toBe("true");
    expect(control().getAttribute("aria-errormessage")).toBe(error().id);
    const describedBy = control().getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(describedBy).toContain("hint"); // consumer token preserved
    expect(describedBy).toContain(error().id);
  });
});

/**
 * With more than one shown error, aria-errormessage must reference a single error
 * element (the widely-supported IDREF form); every error still appears in
 * aria-describedby for AT that ignore aria-errormessage.
 */
describe("FormFieldController with multiple error targets", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--form-field">
        <label for="pw">Password</label>
        <input id="pw" type="password" data-stimeo--form-field-target="control" />
        <p role="alert" data-stimeo--form-field-target="error">Too short.</p>
        <p role="alert" data-stimeo--form-field-target="error">Needs a number.</p>
      </div>`;
    application = Application.start();
    application.register("stimeo--form-field", FormFieldController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  it("references only the first error in aria-errormessage but describes by all", () => {
    const control = document.querySelector<HTMLInputElement>("#pw") as HTMLInputElement;
    const errors = Array.from(
      document.querySelectorAll<HTMLElement>("[data-stimeo--form-field-target='error']"),
    );
    expect(control.getAttribute("aria-invalid")).toBe("true");
    // Single IDREF → first error only.
    expect(control.getAttribute("aria-errormessage")).toBe(errors[0]?.id);
    // describedby still covers every shown error.
    const describedBy = control.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(describedBy).toContain(errors[0]?.id);
    expect(describedBy).toContain(errors[1]?.id);
  });
});

/**
 * The structure rules require only `control`, so `setError()` can be called on a
 * field with no error region. The invalid state must still hold so the DOM never
 * disagrees with the dispatched `validate` (`valid: false`).
 */
describe("FormFieldController without an error region", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--form-field">
        <label for="city">City</label>
        <input id="city" type="text" data-stimeo--form-field-target="control" />
      </div>`;
    application = Application.start();
    application.register("stimeo--form-field", FormFieldController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--form-field']") as HTMLElement;
  const control = () => document.querySelector<HTMLInputElement>("#city") as HTMLInputElement;
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--form-field",
    ) as FormFieldController;

  it("forces the invalid state even with no error target", () => {
    const events: Array<{ valid: boolean }> = [];
    root().addEventListener("stimeo--form-field:validate", (event) => {
      events.push((event as CustomEvent).detail);
    });

    controller().setError("Required");
    expect(control().getAttribute("aria-invalid")).toBe("true");
    expect(root().hasAttribute("data-stimeo--form-field-invalid")).toBe(true);
    expect(events.at(-1)?.valid).toBe(false);

    controller().clearError();
    expect(control().getAttribute("aria-invalid")).toBe("false");
    expect(root().hasAttribute("data-stimeo--form-field-invalid")).toBe(false);
    expect(events.at(-1)?.valid).toBe(true);
  });
});
