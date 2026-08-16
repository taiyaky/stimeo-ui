import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FormFieldController } from "../src/controllers/form_field_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link FormFieldController}: the accessible association
 * substrate — `aria-describedby` composition, `aria-invalid`/`aria-errormessage`
 * toggling, the server-rendered-error reflection, and the `validate` event.
 */

describe("FormFieldController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--form-field">
        <label for="email">Email</label>
        <input id="email" type="email" aria-invalid="false"
               data-stimeo--form-field-target="control" />
        <p data-stimeo--form-field-target="description">We'll send a confirmation.</p>
        <p hidden data-stimeo--form-field-target="error"></p>
        <button type="button"
                data-stimeo--form-field-message-param="Email is required"
                data-action="stimeo--form-field#setError">Fail</button>
      </div>`;
    application = Application.start();
    application.register("stimeo--form-field", FormFieldController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
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

  it("re-shows an existing message when setError receives no resolvable message", () => {
    error().textContent = "Already invalid";
    error().hidden = true;

    controller().setError();

    expect(error().hidden).toBe(false);
    expect(error().textContent).toBe("Already invalid");
    expect(error().textContent).not.toContain("undefined");
    expect(control().getAttribute("aria-invalid")).toBe("true");
  });

  it("composes multiple descriptions in DOM order", async () => {
    const second = document.createElement("p");
    second.id = "second-description";
    second.textContent = "A second hint.";
    second.setAttribute("data-stimeo--form-field-target", "description");
    description().after(second);

    await tick();

    expect(control().getAttribute("aria-describedby")?.split(" ")).toEqual([
      description().id,
      "second-description",
    ]);
  });

  it("announces each explicit non-empty error exactly once and keeps other passes silent", async () => {
    const announcements: Array<{ message: string; assertive: boolean }> = [];
    const onAnnounce = (event: Event) => {
      announcements.push((event as CustomEvent).detail);
    };
    window.addEventListener("stimeo--announcer:announce", onAnnounce);

    try {
      // A server/Turbo reconciliation changes state, but it is not an explicit
      // validation action and must not synthesize speech.
      error().textContent = "Server error";
      error().hidden = false;
      await tick();
      expect(announcements).toEqual([]);

      controller().setError("Action error");
      expect(announcements).toEqual([{ message: "Action error", assertive: true }]);

      // The observer sees the DOM writes from setError in a later microtask. It
      // may reconcile, but must not announce the same error again.
      await tick();
      expect(announcements).toHaveLength(1);

      controller().clearError();
      expect(announcements).toHaveLength(1);
      controller().setError("");
      expect(announcements).toHaveLength(1);
    } finally {
      window.removeEventListener("stimeo--announcer:announce", onAnnounce);
    }
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

  it("allows a programmatic call to override focusOnError in either direction", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);

    controller().setError("focus now", { focus: true });
    expect(document.activeElement).toBe(control());

    root().setAttribute("data-stimeo--form-field-focus-on-error-value", "true");
    outside.focus();
    controller().setError("stay still", { focus: false });
    expect(document.activeElement).toBe(outside);
  });

  it("has no machine-detectable a11y violations in valid and error states", async () => {
    await expectNoA11yViolations(root());
    controller().setError("Email is required");
    await expectNoA11yViolations(root());
  });
});

/** Dynamic targets and retained morphs must converge on one owned ARIA graph. */
describe("FormFieldController dynamic reconciliation", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div id="destination"></div>
      <div id="dynamic-field" data-controller="stimeo--form-field">
        <label for="dynamic-email">Email</label>
        <input id="dynamic-email" type="email"
               aria-describedby="external-hint external-hint"
               aria-invalid="spelling"
               aria-errormessage="legacy-error"
               data-stimeo--form-field-target="control" />
        <span id="external-hint">External.</span>
        <p id="description-a" data-stimeo--form-field-target="description">First hint.</p>
        <p id="error-a" hidden data-stimeo--form-field-target="error"><span></span></p>
      </div>`;
    application = Application.start();
    application.register("stimeo--form-field", FormFieldController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () => document.querySelector<HTMLElement>("#dynamic-field") as HTMLElement;
  const control = (): HTMLInputElement | null =>
    root().querySelector<HTMLInputElement>("[data-stimeo--form-field-target~='control']");
  const description = () => document.querySelector<HTMLElement>("#description-a") as HTMLElement;
  const error = () =>
    root().querySelector<HTMLElement>("[data-stimeo--form-field-target~='error']") as HTMLElement;
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--form-field",
    ) as FormFieldController;

  it("deduplicates authored tokens and reconciles retained ids, visibility, and error text", async () => {
    expect(control()?.getAttribute("aria-describedby")?.split(" ")).toEqual([
      "external-hint",
      "description-a",
    ]);

    description().id = "description-b";
    const nested = error().querySelector("span") as HTMLSpanElement;
    nested.textContent = "Server says no.";
    error().hidden = false;
    await tick();

    expect(control()?.getAttribute("aria-invalid")).toBe("true");
    expect(control()?.getAttribute("aria-errormessage")).toBe("error-a");
    expect(control()?.getAttribute("aria-describedby")?.split(" ")).toEqual([
      "external-hint",
      "description-b",
      "error-a",
    ]);

    error().id = "error-b";
    await tick();
    expect(control()?.getAttribute("aria-errormessage")).toBe("error-b");
    expect(control()?.getAttribute("aria-describedby")?.split(" ")).toEqual([
      "external-hint",
      "description-b",
      "error-b",
    ]);

    error().hidden = true;
    await tick();
    expect(control()?.getAttribute("aria-invalid")).toBe("false");
    expect(control()?.hasAttribute("aria-errormessage")).toBe(false);
    expect(control()?.getAttribute("aria-describedby")?.split(" ")).toEqual([
      "external-hint",
      "description-b",
    ]);
  });

  it("does not recapture consumer ARIA edits while retaining the same control", async () => {
    control()?.setAttribute("aria-describedby", "late-token");
    error().textContent = "Trigger reconciliation.";
    error().hidden = false;
    await tick();

    expect(control()?.getAttribute("aria-describedby")?.split(" ")).toEqual([
      "external-hint",
      "description-a",
      "error-a",
    ]);
  });

  it("reconciles added and removed associations in their shared DOM order", async () => {
    const earlyError = document.createElement("p");
    earlyError.id = "early-error";
    earlyError.textContent = "First in DOM.";
    earlyError.setAttribute("data-stimeo--form-field-target", "error");

    const middleDescription = document.createElement("p");
    middleDescription.id = "middle-description";
    middleDescription.textContent = "Middle hint.";
    middleDescription.setAttribute("data-stimeo--form-field-target", "description");

    const currentDescription = description();
    currentDescription.before(earlyError, middleDescription);
    await tick();

    expect(control()?.getAttribute("aria-errormessage")).toBe("early-error");
    expect(control()?.getAttribute("aria-describedby")?.split(" ")).toEqual([
      "external-hint",
      "early-error",
      "middle-description",
      "description-a",
    ]);

    earlyError.remove();
    middleDescription.remove();
    await tick();

    expect(control()?.getAttribute("aria-invalid")).toBe("false");
    expect(control()?.hasAttribute("aria-errormessage")).toBe(false);
    expect(control()?.getAttribute("aria-describedby")?.split(" ")).toEqual([
      "external-hint",
      "description-a",
    ]);
  });

  it("restores the old control and captures authored ARIA from its replacement", async () => {
    const previous = control() as HTMLInputElement;
    const replacement = document.createElement("input");
    replacement.id = "replacement-control";
    replacement.setAttribute("aria-describedby", "replacement-hint replacement-hint");
    replacement.setAttribute("aria-invalid", "grammar");
    replacement.setAttribute("aria-errormessage", "replacement-error");
    replacement.setAttribute("data-stimeo--form-field-target", "control");

    previous.replaceWith(replacement);
    await tick();

    expect(previous.getAttribute("aria-describedby")).toBe("external-hint external-hint");
    expect(previous.getAttribute("aria-invalid")).toBe("spelling");
    expect(previous.getAttribute("aria-errormessage")).toBe("legacy-error");
    expect(replacement.getAttribute("aria-describedby")?.split(" ")).toEqual([
      "replacement-hint",
      "description-a",
    ]);
    expect(replacement.getAttribute("aria-invalid")).toBe("false");
    expect(replacement.hasAttribute("aria-errormessage")).toBe(false);

    replacement.removeAttribute("data-stimeo--form-field-target");
    await tick();
    expect(replacement.getAttribute("aria-describedby")).toBe("replacement-hint replacement-hint");
    expect(replacement.getAttribute("aria-invalid")).toBe("grammar");
    expect(replacement.getAttribute("aria-errormessage")).toBe("replacement-error");
  });

  it("keeps an explicit invalid request through error/control replacement and reconnect", async () => {
    controller().setError("Required.");
    error().remove();

    const replacement = document.createElement("input");
    replacement.id = "replacement-control";
    replacement.setAttribute("data-stimeo--form-field-target", "control");
    control()?.replaceWith(replacement);
    await tick();

    expect(replacement.getAttribute("aria-invalid")).toBe("true");
    expect(replacement.hasAttribute("aria-errormessage")).toBe(false);
    expect(root().hasAttribute("data-stimeo--form-field-invalid")).toBe(true);

    document.querySelector("#destination")?.append(root());
    await tick();
    expect(replacement.getAttribute("aria-invalid")).toBe("true");
    expect(root().hasAttribute("data-stimeo--form-field-invalid")).toBe(true);

    controller().clearError();
    expect(replacement.getAttribute("aria-invalid")).toBe("false");
    expect(root().hasAttribute("data-stimeo--form-field-invalid")).toBe(false);
  });

  it("returns borrowed control ARIA when the controller disconnects", async () => {
    const input = control() as HTMLInputElement;
    root().removeAttribute("data-controller");
    await tick();

    expect(input.getAttribute("aria-describedby")).toBe("external-hint external-hint");
    expect(input.getAttribute("aria-invalid")).toBe("spelling");
    expect(input.getAttribute("aria-errormessage")).toBe("legacy-error");
  });

  it("returns borrowed control ARIA before Turbo caches the page", () => {
    const input = control() as HTMLInputElement;

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(input.getAttribute("aria-describedby")).toBe("external-hint external-hint");
    expect(input.getAttribute("aria-invalid")).toBe("spelling");
    expect(input.getAttribute("aria-errormessage")).toBe("legacy-error");
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
    disconnectAndStopApplication(application);
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
        <p data-stimeo--form-field-target="error">Too short.</p>
        <p data-stimeo--form-field-target="error">Needs a number.</p>
      </div>`;
    application = Application.start();
    application.register("stimeo--form-field", FormFieldController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
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
    disconnectAndStopApplication(application);
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

    expect(control().hasAttribute("aria-describedby")).toBe(false);

    controller().setError("Required");
    expect(control().getAttribute("aria-invalid")).toBe("true");
    expect(control().hasAttribute("aria-describedby")).toBe(false);
    expect(root().hasAttribute("data-stimeo--form-field-invalid")).toBe(true);
    expect(events.at(-1)?.valid).toBe(false);

    controller().clearError();
    expect(control().getAttribute("aria-invalid")).toBe("false");
    expect(control().hasAttribute("aria-describedby")).toBe(false);
    expect(root().hasAttribute("data-stimeo--form-field-invalid")).toBe(false);
    expect(events.at(-1)?.valid).toBe(true);
  });
});
