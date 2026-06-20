import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FormFieldController } from "../src/controllers/form_field_controller";
import { FormValidationController } from "../src/controllers/form_validation_controller";
import { ListboxController } from "../src/controllers/listbox_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link FormValidationController}: the timing layer that
 * drives native constraint validation and routes each control's
 * `validationMessage` into its `stimeo--form-field` outlet. The per-field ARIA
 * wiring is owned by `stimeo--form-field`, so these tests assert that the
 * orchestration (when to check, blocking submit, focus, events, `novalidate`)
 * works and that the message ends up rendered *through* the field — never that
 * the wiring is re-implemented here.
 *
 * happy-dom note: its constraint engine evaluates validity correctly
 * (`checkValidity()` is honest), but it ships **no default message text** for
 * native failures — `validationMessage` is empty unless `setCustomValidity()` set
 * it. So native-required cases assert *state* (`aria-invalid`, `defaultPrevented`,
 * focus, events), and the *message rendering* path is exercised with
 * `setCustomValidity()`, whose text is engine-independent.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const OUTLET = "[data-controller~='stimeo--form-field']";

describe("FormValidationController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <form data-controller="stimeo--form-validation"
            data-stimeo--form-validation-stimeo--form-field-outlet="${OUTLET}">
        <div data-controller="stimeo--form-field">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" required
                 data-stimeo--form-field-target="control" />
          <p role="alert" hidden data-stimeo--form-field-target="error"></p>
        </div>
        <div data-controller="stimeo--form-field">
          <label for="name">Name</label>
          <input id="name" name="name" type="text" required
                 data-stimeo--form-field-target="control" />
          <p role="alert" hidden data-stimeo--form-field-target="error"></p>
        </div>
        <button type="submit">Save</button>
      </form>`;
    application = Application.start();
    application.register("stimeo--form-field", FormFieldController);
    application.register("stimeo--form-validation", FormValidationController);
    // Two ticks: the first lets the controllers connect, the second lets the
    // outlet observer wire the form-field outlets onto the form controller.
    await tick();
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const form = () => document.querySelector<HTMLFormElement>("form") as HTMLFormElement;
  const emailInput = () => document.querySelector<HTMLInputElement>("#email") as HTMLInputElement;
  const nameInput = () => document.querySelector<HTMLInputElement>("#name") as HTMLInputElement;
  const errorFor = (id: string) =>
    document
      .querySelector<HTMLElement>(`#${id}`)
      ?.closest(OUTLET)
      ?.querySelector<HTMLElement>("[data-stimeo--form-field-target='error']") as HTMLElement;

  const submit = () => {
    const event = new Event("submit", { bubbles: true, cancelable: true });
    form().dispatchEvent(event);
    return event;
  };

  const blur = (control: HTMLElement) =>
    control.dispatchEvent(new Event("focusout", { bubbles: true }));
  const input = (control: HTMLElement) =>
    control.dispatchEvent(new Event("input", { bubbles: true }));

  it("suppresses native bubbles by adding novalidate on connect", () => {
    expect(form().hasAttribute("novalidate")).toBe(true);
  });

  it("restores the form to its authored state (no novalidate) on disconnect", async () => {
    // Removing the element triggers Stimulus disconnect (application.stop() does
    // not run it synchronously); the form stays referenced so we can inspect it.
    const node = form();
    node.remove();
    await tick();
    expect(node.hasAttribute("novalidate")).toBe(false);
    expect(node.hasAttribute("data-stimeo--form-validation-novalidate")).toBe(false);
  });

  it("removes the document-level capture submit listener on disconnect", async () => {
    const node = form();
    node.remove();
    await tick();
    // Re-attach without the controller (so no fresh instance reconnects) and
    // submit the still-invalid form: a leaked capture listener would block it.
    node.removeAttribute("data-controller");
    document.body.appendChild(node);
    const event = new Event("submit", { bubbles: true, cancelable: true });
    node.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves an author-set novalidate untouched on disconnect", async () => {
    application.stop();
    document.body.innerHTML = `
      <form novalidate data-controller="stimeo--form-validation"
            data-stimeo--form-validation-stimeo--form-field-outlet="${OUTLET}">
        <div data-controller="stimeo--form-field">
          <input id="x" required data-stimeo--form-field-target="control" />
        </div>
      </form>`;
    application = Application.start();
    application.register("stimeo--form-field", FormFieldController);
    application.register("stimeo--form-validation", FormValidationController);
    await tick();
    const node = form();
    node.remove();
    await tick();
    // We never added it, so we must not remove the author's novalidate.
    expect(node.hasAttribute("novalidate")).toBe(true);
  });

  it("blocks submit, marks the field invalid, focuses the first invalid, and reports them", () => {
    const events: CustomEvent[] = [];
    form().addEventListener("stimeo--form-validation:invalid", (e) =>
      events.push(e as CustomEvent),
    );

    const event = submit();

    expect(event.defaultPrevented).toBe(true);
    // The invalid state is wired by stimeo--form-field (reuse, not re-implemented).
    expect(emailInput().getAttribute("aria-invalid")).toBe("true");
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    // First invalid control receives focus.
    expect(document.activeElement).toBe(emailInput());
    // The invalid event carries the offending controls, in document order.
    expect(events).toHaveLength(1);
    const invalid = events[0]?.detail.invalid as HTMLElement[];
    expect(invalid).toHaveLength(2);
    expect(invalid[0]).toBe(emailInput());
    expect(invalid[1]).toBe(nameInput());
  });

  it("renders the validationMessage through the field on an invalid submit", () => {
    emailInput().value = "person@example.com";
    nameInput().value = "Ada";
    // Engine-independent message: setCustomValidity drives validationMessage.
    emailInput().setCustomValidity("Already taken");

    const event = submit();

    expect(event.defaultPrevented).toBe(true);
    expect(errorFor("email").hidden).toBe(false);
    expect(errorFor("email").textContent).toBe("Already taken");
    expect(emailInput().getAttribute("aria-errormessage")).toBe(errorFor("email").id);
  });

  // Layer ③ — speech-order regression. form-validation does not own the announced
  // text (form-field carries the ARIA), so this freezes the *integration*: after an
  // invalid submit the control reads as invalid and its error region announces the
  // routed validationMessage, in order.
  it("announces the invalid control and its routed error message in order", async () => {
    emailInput().value = "person@example.com";
    nameInput().value = "Ada";
    emailInput().setCustomValidity("Already taken");
    submit();

    const fieldEl = emailInput().closest(OUTLET) as HTMLElement;
    expect(await captureSpeech({ container: fieldEl, steps: 4 })).toEqual([
      "Email",
      "textbox, Email, person@example.com, Already taken, 1 error message, invalid, required",
      "alert",
      "Already taken",
      "end of alert",
    ]);
  });

  it("allows submit and dispatches valid when every control is valid", () => {
    emailInput().value = "person@example.com";
    nameInput().value = "Ada";
    const valid: CustomEvent[] = [];
    form().addEventListener("stimeo--form-validation:valid", (e) => valid.push(e as CustomEvent));

    const event = submit();

    expect(event.defaultPrevented).toBe(false);
    expect(valid).toHaveLength(1);
    expect(emailInput().getAttribute("aria-invalid")).toBe("false");
  });

  it("does not move focus on an invalid submit when focusInvalid is false", () => {
    form().setAttribute("data-stimeo--form-validation-focus-invalid-value", "false");
    submit();
    expect(document.activeElement).not.toBe(emailInput());
  });

  it("validates a field on blur once it has been interacted with", () => {
    blur(emailInput());

    expect(emailInput().getAttribute("aria-invalid")).toBe("true");
    // A field the user has not visited yet is left pristine.
    expect(nameInput().getAttribute("aria-invalid")).toBe("false");
  });

  it("does not validate on blur when validateOnBlur is false", () => {
    form().setAttribute("data-stimeo--form-validation-validate-on-blur-value", "false");
    blur(emailInput());
    expect(emailInput().getAttribute("aria-invalid")).toBe("false");
  });

  it("clears a shown error on input as soon as the value becomes valid", () => {
    emailInput().value = "person@example.com";
    emailInput().setCustomValidity("Already taken");
    blur(emailInput());
    expect(errorFor("email").hidden).toBe(false);
    expect(emailInput().getAttribute("aria-invalid")).toBe("true");

    // The consumer resolves the custom error; the field is already touched, so the
    // next input re-validates and clears it.
    emailInput().setCustomValidity("");
    input(emailInput());

    expect(errorFor("email").hidden).toBe(true);
    expect(emailInput().getAttribute("aria-invalid")).toBe("false");
  });

  it("does not eagerly flag a pristine field on input before it is touched", () => {
    // No prior blur → the field is untouched, so input must not validate it.
    input(emailInput());
    expect(emailInput().getAttribute("aria-invalid")).toBe("false");
  });

  it("validates immediately on change (a committed interaction), even untouched", () => {
    // Unlike input, change marks completion — e.g. a <select> choice or a widget
    // writing its mirror — so it validates without a prior blur.
    emailInput().dispatchEvent(new Event("change", { bubbles: true }));
    expect(emailInput().getAttribute("aria-invalid")).toBe("true");
  });

  it("does not validate on change when validateOnChange is false", () => {
    form().setAttribute("data-stimeo--form-validation-validate-on-change-value", "false");
    emailInput().dispatchEvent(new Event("change", { bubbles: true }));
    expect(emailInput().getAttribute("aria-invalid")).toBe("false");
  });

  it("does not re-validate on input when revalidateOnInput is false", () => {
    form().setAttribute("data-stimeo--form-validation-revalidate-on-input-value", "false");
    blur(emailInput()); // touched + invalid (empty, required)
    expect(emailInput().getAttribute("aria-invalid")).toBe("true");

    emailInput().value = "person@example.com";
    input(emailInput());
    // revalidateOnInput is off, so the now-valid value is not re-checked.
    expect(emailInput().getAttribute("aria-invalid")).toBe("true");
  });

  it("validates every control when validate() is called directly", () => {
    const controller = application.getControllerForElementAndIdentifier(
      form(),
      "stimeo--form-validation",
    ) as FormValidationController;

    expect(controller.validate()).toBe(false);
    expect(emailInput().getAttribute("aria-invalid")).toBe("true");

    emailInput().value = "person@example.com";
    nameInput().value = "Ada";
    expect(controller.validate()).toBe(true);
    expect(emailInput().getAttribute("aria-invalid")).toBe("false");
  });

  it("has no machine-detectable a11y violations in pristine and invalid states", async () => {
    await expectNoA11yViolations(form());
    submit();
    await expectNoA11yViolations(form());
  });
});

/**
 * A radio group validates through native group semantics: a required group is
 * invalid until a choice is made. The group's accessible container
 * (`role="radiogroup"`) is the form-field `control`, so the invalid state lands
 * on the group, and the group collapses to a single entry in the invalid list.
 */
describe("FormValidationController with a radio group", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <form data-controller="stimeo--form-validation"
            data-stimeo--form-validation-stimeo--form-field-outlet="${OUTLET}">
        <div data-controller="stimeo--form-field">
          <div role="radiogroup" aria-labelledby="plan-label"
               data-stimeo--form-field-target="control">
            <span id="plan-label">Plan</span>
            <label><input id="plan-free" type="radio" name="plan" required /> Free</label>
            <label><input id="plan-pro" type="radio" name="plan" /> Pro</label>
          </div>
          <p role="alert" hidden data-stimeo--form-field-target="error"></p>
        </div>
        <button type="submit">Save</button>
      </form>`;
    application = Application.start();
    application.register("stimeo--form-field", FormFieldController);
    application.register("stimeo--form-validation", FormValidationController);
    await tick();
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const form = () => document.querySelector<HTMLFormElement>("form") as HTMLFormElement;
  const group = () => document.querySelector<HTMLElement>("[role='radiogroup']") as HTMLElement;
  const free = () => document.querySelector<HTMLInputElement>("#plan-free") as HTMLInputElement;
  const pro = () => document.querySelector<HTMLInputElement>("#plan-pro") as HTMLInputElement;
  const submit = () => {
    const event = new Event("submit", { bubbles: true, cancelable: true });
    form().dispatchEvent(event);
    return event;
  };

  it("blocks submit, marks the group invalid, and focuses the first radio", () => {
    const event = submit();

    expect(event.defaultPrevented).toBe(true);
    // aria-invalid lands on the radiogroup container (the form-field control).
    expect(group().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(free());
  });

  it("submits once the required choice is made", () => {
    free().checked = true;
    const event = submit();

    expect(event.defaultPrevented).toBe(false);
    expect(group().getAttribute("aria-invalid")).toBe("false");
  });

  it("skips blur validation while focus stays within the same field", () => {
    // Moving between radios of the same group is not leaving the field, so the
    // relatedTarget guard must defer validation (no premature invalid state).
    free().dispatchEvent(new FocusEvent("focusout", { relatedTarget: pro(), bubbles: true }));
    expect(group().getAttribute("aria-invalid")).toBe("false");
  });

  it("validates on blur once focus leaves the field", () => {
    const outside = form().querySelector("button[type='submit']") as HTMLElement;
    free().dispatchEvent(new FocusEvent("focusout", { relatedTarget: outside, bubbles: true }));
    expect(group().getAttribute("aria-invalid")).toBe("true");
  });

  it("collapses the group to a single entry in the invalid list", () => {
    // Force every radio invalid (engine-independent) to prove the de-duplication:
    // without it the list would carry one entry per radio.
    free().setCustomValidity("Pick a plan");
    pro().setCustomValidity("Pick a plan");
    const events: CustomEvent[] = [];
    form().addEventListener("stimeo--form-validation:invalid", (e) =>
      events.push(e as CustomEvent),
    );

    submit();

    const invalid = events[0]?.detail.invalid as HTMLElement[];
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toBe(free());
  });
});

/**
 * End-to-end: a rich widget (listbox) joins validation through a **validatable
 * mirror** — `<input type="text" hidden required>` instead of `type="hidden"`.
 * Native `required` governs the committed value with no extra JavaScript, focus
 * for the invalid mirror is delegated to the field's visible control target
 * (the listbox trigger), and the widget's native `change` dispatch re-validates
 * the moment a choice is made.
 */
describe("FormValidationController with a listbox via a validatable mirror", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <form data-controller="stimeo--form-validation"
            data-stimeo--form-validation-stimeo--form-field-outlet="${OUTLET}">
        <div data-controller="stimeo--form-field stimeo--listbox">
          <span id="lb-label">Plan</span>
          <button type="button" id="lb-trigger" role="combobox" aria-haspopup="listbox"
                  aria-expanded="false" aria-controls="lb-list"
                  aria-labelledby="lb-label lb-value"
                  data-stimeo--listbox-target="trigger"
                  data-stimeo--form-field-target="control"
                  data-action="click->stimeo--listbox#toggle
                               keydown->stimeo--listbox#onTriggerKeydown">
            <span id="lb-value" data-stimeo--listbox-target="value">Choose…</span>
          </button>
          <ul id="lb-list" role="listbox" aria-label="Plans" hidden
              data-stimeo--listbox-target="list">
            <li id="opt-free" role="option" aria-selected="false" data-value="free"
                data-stimeo--listbox-target="option"
                data-action="click->stimeo--listbox#select">Free</li>
          </ul>
          <input type="text" hidden required name="plan"
                 data-stimeo--listbox-target="field" />
          <p role="alert" hidden data-stimeo--form-field-target="error"></p>
        </div>
        <button type="submit">Save</button>
      </form>`;
    application = Application.start();
    application.register("stimeo--form-field", FormFieldController);
    application.register("stimeo--form-validation", FormValidationController);
    application.register("stimeo--listbox", ListboxController);
    await tick();
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const form = () => document.querySelector<HTMLFormElement>("form") as HTMLFormElement;
  const trigger = () =>
    document.querySelector<HTMLButtonElement>("#lb-trigger") as HTMLButtonElement;
  const mirror = () =>
    document.querySelector<HTMLInputElement>("input[name='plan']") as HTMLInputElement;
  const submit = () => {
    const event = new Event("submit", { bubbles: true, cancelable: true });
    form().dispatchEvent(event);
    return event;
  };

  it("the mirror participates in constraint validation (hidden attribute, not type)", () => {
    expect(mirror().willValidate).toBe(true);
    expect(mirror().checkValidity()).toBe(false);
  });

  it("blocks submit on an empty mirror and delegates focus to the visible trigger", () => {
    const event = submit();

    expect(event.defaultPrevented).toBe(true);
    // The invalid state lands on the visible control (form_field wiring, reused).
    expect(trigger().getAttribute("aria-invalid")).toBe("true");
    // The mirror cannot take focus — the field's control target does instead.
    expect(document.activeElement).toBe(trigger());
  });

  it("re-validates the moment an option is picked and then submits", () => {
    submit();
    expect(trigger().getAttribute("aria-invalid")).toBe("true");

    // Picking an option writes the mirror and fires its native change.
    (document.querySelector("#opt-free") as HTMLElement).click();

    expect(mirror().value).toBe("free");
    expect(trigger().getAttribute("aria-invalid")).toBe("false");
    expect(submit().defaultPrevented).toBe(false);
  });
});

/**
 * When the field's control target is itself not focusable (e.g. a group
 * container of roving-tabindex members), invalid-mirror focus falls back to the
 * first focusable descendant.
 */
describe("FormValidationController mirror focus fallback", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <form data-controller="stimeo--form-validation"
            data-stimeo--form-validation-stimeo--form-field-outlet="${OUTLET}">
        <div data-controller="stimeo--form-field">
          <div role="radiogroup" aria-label="Size" data-stimeo--form-field-target="control">
            <div id="first-member" role="radio" aria-checked="false" tabindex="0">S</div>
            <div role="radio" aria-checked="false" tabindex="-1">M</div>
          </div>
          <input type="text" hidden required name="size" />
        </div>
      </form>`;
    application = Application.start();
    application.register("stimeo--form-field", FormFieldController);
    application.register("stimeo--form-validation", FormValidationController);
    await tick();
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  it("focuses the first focusable member inside a non-focusable control target", () => {
    const form = document.querySelector<HTMLFormElement>("form") as HTMLFormElement;
    const event = new Event("submit", { bubbles: true, cancelable: true });

    form.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.querySelector("#first-member"));
  });
});

/**
 * Native radios sharing a name but not wrapped in a `stimeo--form-field` are
 * grouped by the `radio:<name>` key (the field-less branch of the grouping), so
 * the group still collapses to a single invalid entry.
 */
describe("FormValidationController with an unwired native radio group", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <form data-controller="stimeo--form-validation"
            data-stimeo--form-validation-stimeo--form-field-outlet="${OUTLET}">
        <fieldset>
          <legend>Size</legend>
          <label><input id="size-s" type="radio" name="size" required /> S</label>
          <label><input id="size-m" type="radio" name="size" required /> M</label>
        </fieldset>
        <button type="submit">Go</button>
      </form>`;
    application = Application.start();
    application.register("stimeo--form-field", FormFieldController);
    application.register("stimeo--form-validation", FormValidationController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  it("collapses the unwired group to one invalid entry and focuses the first", () => {
    const form = document.querySelector<HTMLFormElement>("form") as HTMLFormElement;
    const first = document.querySelector<HTMLInputElement>("#size-s") as HTMLInputElement;
    const events: CustomEvent[] = [];
    form.addEventListener("stimeo--form-validation:invalid", (e) => events.push(e as CustomEvent));

    const event = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    const invalid = events[0]?.detail.invalid as HTMLElement[];
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toBe(first);
    expect(document.activeElement).toBe(first);
  });
});

/**
 * A field whose only validatable control is a hidden mirror with no `control`
 * target still blocks submit, and the missing control target resolves focus to
 * `null` (no crash, focus is not moved to the invisible mirror).
 */
describe("FormValidationController with a mirror field lacking a control target", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <form data-controller="stimeo--form-validation"
            data-stimeo--form-validation-stimeo--form-field-outlet="${OUTLET}">
        <div data-controller="stimeo--form-field">
          <input type="text" hidden required name="token" />
        </div>
        <button type="submit">Go</button>
      </form>`;
    application = Application.start();
    application.register("stimeo--form-field", FormFieldController);
    application.register("stimeo--form-validation", FormValidationController);
    await tick();
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  it("blocks submit without crashing or focusing the hidden mirror", () => {
    const form = document.querySelector<HTMLFormElement>("form") as HTMLFormElement;
    const mirror = document.querySelector<HTMLInputElement>(
      "input[name='token']",
    ) as HTMLInputElement;
    const event = new Event("submit", { bubbles: true, cancelable: true });

    form.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(mirror);
  });
});

/**
 * A control with no owning `stimeo--form-field` outlet must still gate the form:
 * it blocks submit and can receive focus, but renders no message.
 */
describe("FormValidationController with an unwired control", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <form data-controller="stimeo--form-validation"
            data-stimeo--form-validation-stimeo--form-field-outlet="${OUTLET}">
        <label for="token">Token</label>
        <input id="token" name="token" required />
        <button type="submit">Go</button>
      </form>`;
    application = Application.start();
    application.register("stimeo--form-field", FormFieldController);
    application.register("stimeo--form-validation", FormValidationController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  it("blocks submit and focuses the unwired invalid control", () => {
    const form = document.querySelector<HTMLFormElement>("form") as HTMLFormElement;
    const token = document.querySelector<HTMLInputElement>("#token") as HTMLInputElement;
    const event = new Event("submit", { bubbles: true, cancelable: true });

    form.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(token);
  });
});
