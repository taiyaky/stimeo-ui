import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConditionalFieldsController } from "../src/controllers/conditional_fields_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ConditionalFieldsController}: initial sync, show/hide
 * on declarative input changes, owned-disabled syncing, dynamic DOM reconciliation,
 * reset handling, and safe focus retreat out of a hidden region.
 */

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
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const region = () => query<HTMLElement>("[data-stimeo--conditional-fields-target='region']");
  const regions = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>("[data-stimeo--conditional-fields-target='region']"),
    );
  const trigger = () =>
    query<HTMLInputElement>("[data-stimeo--conditional-fields-target='trigger']");
  const root = () => query<HTMLFormElement>("form[data-controller]");
  const controller = () => {
    const instance = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--conditional-fields",
    );
    if (!(instance instanceof ConditionalFieldsController)) {
      throw new Error("expected ConditionalFieldsController");
    }
    return instance;
  };
  const setChecked = (checked: boolean) => {
    trigger().checked = checked;
    trigger().dispatchEvent(new Event("change", { bubbles: true }));
  };

  const CHECKBOX = `<input type="checkbox" data-stimeo--conditional-fields-target="trigger">`;

  it("synchronizes on connect without reporting a user change or reconciliation", async () => {
    document.body.innerHTML = `
      <form data-controller="stimeo--conditional-fields">
        ${CHECKBOX}
        <fieldset data-stimeo--conditional-fields-target="region" data-when-checked></fieldset>
      </form>`;
    const events: string[] = [];
    const form = root();
    form.addEventListener("stimeo--conditional-fields:change", () => events.push("change"));
    form.addEventListener("stimeo--conditional-fields:reconcile", () => events.push("reconcile"));
    application = Application.start();
    application.register("stimeo--conditional-fields", ConditionalFieldsController);

    await tick();

    expect(region().hidden).toBe(true);
    expect(events).toEqual([]);
  });

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
    const changes: Array<{ region: HTMLElement; visible: boolean }> = [];
    region()
      .closest("form")
      ?.addEventListener("stimeo--conditional-fields:change", (e) => {
        changes.push((e as CustomEvent).detail);
      });

    setChecked(true);

    expect(region().hidden).toBe(false);
    expect(region().getAttribute("data-visible")).toBe("true");
    expect(region().hasAttribute("aria-hidden")).toBe(false);
    expect(query<HTMLInputElement>("[name='street']").disabled).toBe(false);
    expect(changes).toEqual([{ region: region(), visible: true }]);

    setChecked(false);
    expect(region().hidden).toBe(true);
    expect(changes).toEqual([
      { region: region(), visible: true },
      { region: region(), visible: false },
    ]);
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

  it("uses any-match semantics by default across several triggers", async () => {
    await mount(
      `<input type="checkbox" data-stimeo--conditional-fields-target="trigger" checked>
       <input type="checkbox" data-stimeo--conditional-fields-target="trigger">
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked hidden>
         <input name="x">
       </fieldset>`,
    );

    expect(region().hidden).toBe(false);
  });

  it("keeps a declared region hidden when there are no triggers", async () => {
    await mount(
      `<fieldset data-stimeo--conditional-fields-target="region" data-when-checked>
         <input name="x">
       </fieldset>`,
    );

    expect(region().hidden).toBe(true);
    expect(query<HTMLInputElement>("[name='x']").disabled).toBe(true);
  });

  it("does not treat an empty trigger set as all-matched", async () => {
    await mount(
      `<fieldset data-stimeo--conditional-fields-target="region" data-when-checked>
         <input name="x">
       </fieldset>`,
      'data-stimeo--conditional-fields-match-value="all"',
    );

    expect(region().hidden).toBe(true);
  });

  it("preserves each conditionless region's authored visibility", async () => {
    await mount(
      `<section id="visible" data-stimeo--conditional-fields-target="region">
         <input name="visible-field">
       </section>
       <section id="hidden" data-stimeo--conditional-fields-target="region" hidden>
         <input name="hidden-field">
       </section>`,
    );

    const [visible, hidden] = regions();
    expect(visible?.hidden).toBe(false);
    expect(visible?.getAttribute("data-visible")).toBe("true");
    expect(hidden?.hidden).toBe(true);
    expect(hidden?.getAttribute("aria-hidden")).toBe("true");
    expect(query<HTMLInputElement>("[name='hidden-field']").disabled).toBe(true);
  });

  it("matches only a checked radio's value", async () => {
    await mount(
      `<input type="radio" name="kind" value="business"
              data-stimeo--conditional-fields-target="trigger">
       <input type="radio" name="kind" value="personal" checked
              data-stimeo--conditional-fields-target="trigger">
       <fieldset data-stimeo--conditional-fields-target="region"
                 data-when-value="business">
         <input name="company">
       </fieldset>`,
    );
    expect(region().hidden).toBe(true);

    const business = query<HTMLInputElement>("[value='business']");
    business.checked = true;
    business.dispatchEvent(new Event("change", { bubbles: true }));
    expect(region().hidden).toBe(false);
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

  it("does not move focus that is already outside the region", async () => {
    document.body.innerHTML = '<button id="outside">Outside</button>';
    document.body.insertAdjacentHTML(
      "beforeend",
      `<form data-controller="stimeo--conditional-fields">
         ${CHECKBOX}
         <fieldset data-stimeo--conditional-fields-target="region" data-when-checked hidden>
           <input name="street">
         </fieldset>
       </form>`,
    );
    application = Application.start();
    application.register("stimeo--conditional-fields", ConditionalFieldsController);
    await tick();
    setChecked(true);
    const focusTrigger = vi.spyOn(trigger(), "focus");
    query<HTMLButtonElement>("#outside").focus();

    setChecked(false);

    expect(document.activeElement).toBe(query("#outside"));
    expect(focusTrigger).not.toHaveBeenCalled();
  });

  it("skips hidden, disabled, and fieldset-disabled focus destinations", async () => {
    await mount(
      `<input type="checkbox" hidden data-stimeo--conditional-fields-target="trigger">
       <input type="checkbox" disabled data-stimeo--conditional-fields-target="trigger">
       <fieldset disabled>
         <input type="checkbox" data-stimeo--conditional-fields-target="trigger">
       </fieldset>
       <input id="safe-trigger" type="checkbox"
              data-stimeo--conditional-fields-target="trigger">
       <fieldset data-stimeo--conditional-fields-target="region" data-when-unchecked>
         <input name="street">
       </fieldset>`,
    );
    query<HTMLInputElement>("[name='street']").focus();
    const triggers = document.querySelectorAll<HTMLInputElement>(
      "[data-stimeo--conditional-fields-target='trigger']",
    );
    for (const item of triggers) item.checked = true;
    triggers[3]?.dispatchEvent(new Event("change", { bubbles: true }));

    expect(document.activeElement).toBe(query("#safe-trigger"));
  });

  it("falls back to the controller landmark when no trigger can take focus", async () => {
    await mount(
      `<input type="checkbox" disabled checked
              data-stimeo--conditional-fields-target="trigger">
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked>
         <input name="street">
       </fieldset>`,
    );
    query<HTMLInputElement>("[name='street']").focus();
    trigger().checked = false;
    trigger().dispatchEvent(new Event("change", { bubbles: true }));

    expect(document.activeElement).toBe(root());
    expect(root().getAttribute("tabindex")).toBe("-1");

    application.unload("stimeo--conditional-fields");
    expect(root().hasAttribute("tabindex")).toBe(false);
  });

  it("does not retreat into a trigger whose region is also being hidden", async () => {
    await mount(
      `<fieldset data-stimeo--conditional-fields-target="region" data-when-checked>
         <input name="street">
       </fieldset>
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked>
         <input type="checkbox" checked
                data-stimeo--conditional-fields-target="trigger">
       </fieldset>`,
    );
    query<HTMLInputElement>("[name='street']").focus();
    trigger().checked = false;
    trigger().dispatchEvent(new Event("change", { bubbles: true }));

    expect(regions().every((item) => item.hidden)).toBe(true);
    expect(document.activeElement).toBe(root());
  });

  it("ignores input and change events from descendants that are not live triggers", async () => {
    await mount(
      `${CHECKBOX}
       <input name="unrelated">
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked></fieldset>`,
    );
    const changes: unknown[] = [];
    root().addEventListener("stimeo--conditional-fields:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    trigger().checked = true;

    query<HTMLInputElement>("[name='unrelated']").dispatchEvent(
      new Event("change", { bubbles: true }),
    );

    expect(region().hidden).toBe(true);
    expect(changes).toEqual([]);
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

  it("repairs externally overwritten visible state without emitting a logical change", async () => {
    await mount(
      `<input type="checkbox" checked data-stimeo--conditional-fields-target="trigger">
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked>
         <input name="street">
       </fieldset>`,
    );
    const changes: unknown[] = [];
    root().addEventListener("stimeo--conditional-fields:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    const field = query<HTMLInputElement>("[name='street']");
    region().hidden = true;
    region().setAttribute("aria-hidden", "true");
    region().removeAttribute("data-visible");
    field.disabled = true;
    field.setAttribute("data-conditional-disabled", "true");

    region().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();

    expect(region().hidden).toBe(false);
    expect(region().hasAttribute("aria-hidden")).toBe(false);
    expect(region().getAttribute("data-visible")).toBe("true");
    expect(field.disabled).toBe(false);
    expect(field.hasAttribute("data-conditional-disabled")).toBe(false);
    expect(changes).toEqual([]);
  });

  it("repairs externally overwritten hidden state without emitting a logical change", async () => {
    await mount(
      `${CHECKBOX}
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked>
         <input name="street">
       </fieldset>`,
    );
    const changes: unknown[] = [];
    root().addEventListener("stimeo--conditional-fields:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    const field = query<HTMLInputElement>("[name='street']");
    region().hidden = false;
    region().removeAttribute("aria-hidden");
    region().setAttribute("data-visible", "true");
    field.disabled = false;
    field.removeAttribute("data-conditional-disabled");

    region().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();

    expect(region().hidden).toBe(true);
    expect(region().getAttribute("aria-hidden")).toBe("true");
    expect(region().hasAttribute("data-visible")).toBe(false);
    expect(field.disabled).toBe(true);
    expect(field.getAttribute("data-conditional-disabled")).toBe("true");
    expect(changes).toEqual([]);
  });

  it("does not produce redundant attribute mutations during an idempotent evaluation", async () => {
    await mount(
      `<input type="checkbox" checked data-stimeo--conditional-fields-target="trigger">
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked>
         <input name="street">
       </fieldset>`,
    );
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(root(), { attributes: true, subtree: true });

    controller().evaluate();
    await flushMicrotasks();
    observer.disconnect();

    expect(records).toEqual([]);
  });

  it("rebuilds its DOM baseline when the same controller reconnects", async () => {
    await mount(
      `<input type="checkbox" checked data-stimeo--conditional-fields-target="trigger">
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked>
         <input name="street">
       </fieldset>`,
    );
    controller().disconnect();
    region().hidden = true;
    region().setAttribute("aria-hidden", "true");

    controller().connect();

    expect(region().hidden).toBe(false);
    expect(region().hasAttribute("aria-hidden")).toBe(false);
  });

  it("initializes a region target inserted after connect", async () => {
    await mount(CHECKBOX);
    root().insertAdjacentHTML(
      "beforeend",
      `<fieldset data-stimeo--conditional-fields-target="region" data-when-checked>
         <input name="dynamic">
       </fieldset>`,
    );

    await tick();

    expect(region().hidden).toBe(true);
    expect(query<HTMLInputElement>("[name='dynamic']").disabled).toBe(true);
  });

  it("disables a control inserted into an already-hidden region", async () => {
    await mount(
      `${CHECKBOX}
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked></fieldset>`,
    );
    region().insertAdjacentHTML("beforeend", '<input name="dynamic">');

    await tick();

    const field = query<HTMLInputElement>("[name='dynamic']");
    expect(field.disabled).toBe(true);
    expect(field.getAttribute("data-conditional-disabled")).toBe("true");
  });

  it("re-evaluates immediately when trigger targets are added and removed", async () => {
    await mount(
      `<fieldset data-stimeo--conditional-fields-target="region" data-when-checked></fieldset>`,
    );
    root().insertAdjacentHTML(
      "afterbegin",
      '<input type="checkbox" checked data-stimeo--conditional-fields-target="trigger">',
    );
    await tick();
    expect(region().hidden).toBe(false);

    trigger().remove();
    await tick();
    expect(region().hidden).toBe(true);
  });

  it("re-evaluates when a retained region's condition changes", async () => {
    await mount(
      `${CHECKBOX}
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked></fieldset>`,
    );
    expect(region().hidden).toBe(true);
    const reconciliations: Array<{ region: HTMLElement; visible: boolean }> = [];
    root().addEventListener("stimeo--conditional-fields:reconcile", (event) => {
      reconciliations.push(
        (event as CustomEvent<{ region: HTMLElement; visible: boolean }>).detail,
      );
    });

    region().removeAttribute("data-when-checked");
    region().setAttribute("data-when-unchecked", "");
    await tick();

    expect(region().hidden).toBe(false);
    expect(reconciliations).toEqual([{ region: region(), visible: true }]);
  });

  it("re-evaluates when a retained trigger's checked attribute changes", async () => {
    await mount(
      `${CHECKBOX}
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked></fieldset>`,
    );
    const reconciliations: Array<{ region: HTMLElement; visible: boolean }> = [];
    root().addEventListener("stimeo--conditional-fields:reconcile", (event) => {
      reconciliations.push(
        (event as CustomEvent<{ region: HTMLElement; visible: boolean }>).detail,
      );
    });

    trigger().setAttribute("checked", "");
    await tick();

    expect(trigger().checked).toBe(true);
    expect(region().hidden).toBe(false);
    expect(reconciliations).toEqual([{ region: region(), visible: true }]);
  });

  it("reports an explicit evaluate action as a user change", async () => {
    await mount(
      `${CHECKBOX}
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked></fieldset>`,
    );
    const changes: Array<{ region: HTMLElement; visible: boolean }> = [];
    root().addEventListener("stimeo--conditional-fields:change", (event) => {
      changes.push((event as CustomEvent<{ region: HTMLElement; visible: boolean }>).detail);
    });
    trigger().checked = true;

    controller().evaluate();

    expect(changes).toEqual([{ region: region(), visible: true }]);
  });

  it("re-evaluates a runtime match Value change within one microtask", async () => {
    await mount(
      `<input type="checkbox" checked data-stimeo--conditional-fields-target="trigger">
       <input type="checkbox" data-stimeo--conditional-fields-target="trigger">
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked></fieldset>`,
    );
    expect(region().hidden).toBe(false);
    root().setAttribute("data-stimeo--conditional-fields-match-value", "all");
    (
      controller() as ConditionalFieldsController & { matchValueChanged(): void }
    ).matchValueChanged();
    await flushMicrotasks();

    expect(region().hidden).toBe(true);
  });

  it("releases and reacquires owned disabled state when disableHidden changes", async () => {
    await mount(
      `${CHECKBOX}
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked>
         <input name="street">
       </fieldset>`,
    );
    const field = query<HTMLInputElement>("[name='street']");
    expect(field.disabled).toBe(true);
    root().setAttribute("data-stimeo--conditional-fields-disable-hidden-value", "false");
    (
      controller() as ConditionalFieldsController & { disableHiddenValueChanged(): void }
    ).disableHiddenValueChanged();
    await flushMicrotasks();
    expect(field.disabled).toBe(false);
    expect(field.hasAttribute("data-conditional-disabled")).toBe(false);

    root().setAttribute("data-stimeo--conditional-fields-disable-hidden-value", "true");
    (
      controller() as ConditionalFieldsController & { disableHiddenValueChanged(): void }
    ).disableHiddenValueChanged();
    await flushMicrotasks();
    expect(field.disabled).toBe(true);
    expect(field.getAttribute("data-conditional-disabled")).toBe("true");
  });

  it("dispatches several logical transitions in region DOM order", async () => {
    await mount(
      `${CHECKBOX}
       <fieldset id="first" data-stimeo--conditional-fields-target="region"
                 data-when-unchecked></fieldset>
       <fieldset id="second" data-stimeo--conditional-fields-target="region"
                 data-when-checked></fieldset>`,
    );
    const changes: Array<{ id: string; visible: boolean }> = [];
    root().addEventListener("stimeo--conditional-fields:change", (event) => {
      const detail = (event as CustomEvent<{ region: HTMLElement; visible: boolean }>).detail;
      changes.push({ id: detail.region.id, visible: detail.visible });
    });

    setChecked(true);

    expect(changes).toEqual([
      { id: "first", visible: false },
      { id: "second", visible: true },
    ]);
  });

  it("preserves a control authored disabled after connect", async () => {
    await mount(
      `<input type="checkbox" checked data-stimeo--conditional-fields-target="trigger">
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked>
         <input name="street">
       </fieldset>`,
    );
    const field = query<HTMLInputElement>("[name='street']");
    field.disabled = true;
    await tick();
    setChecked(false);
    setChecked(true);

    expect(field.disabled).toBe(true);
    expect(field.hasAttribute("data-conditional-disabled")).toBe(false);
  });

  it("reconciles a native form reset and ignores a cancelled reset", async () => {
    await mount(
      `${CHECKBOX}
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked>
         <input name="street">
       </fieldset>`,
    );
    const reconciliations: Array<{ region: HTMLElement; visible: boolean }> = [];
    root().addEventListener("stimeo--conditional-fields:reconcile", (event) => {
      reconciliations.push(
        (event as CustomEvent<{ region: HTMLElement; visible: boolean }>).detail,
      );
    });
    setChecked(true);
    expect(region().hidden).toBe(false);
    root().reset();
    await tick();
    expect(region().hidden).toBe(true);
    expect(reconciliations).toEqual([{ region: region(), visible: false }]);

    setChecked(true);
    root().addEventListener("reset", (event) => event.preventDefault(), { once: true });
    root().reset();
    await tick();
    expect(region().hidden).toBe(false);
    expect(reconciliations).toEqual([{ region: region(), visible: false }]);
  });

  it("reconciles reset for a trigger associated to an external form", async () => {
    document.body.innerHTML = `
      <form id="external-form"></form>
      <div data-controller="stimeo--conditional-fields">
        <input type="checkbox" form="external-form"
               data-stimeo--conditional-fields-target="trigger">
        <fieldset data-stimeo--conditional-fields-target="region" data-when-checked></fieldset>
      </div>`;
    application = Application.start();
    application.register("stimeo--conditional-fields", ConditionalFieldsController);
    await tick();
    const externalTrigger = query<HTMLInputElement>(
      "[data-stimeo--conditional-fields-target='trigger']",
    );
    externalTrigger.checked = true;
    externalTrigger.dispatchEvent(new Event("change", { bubbles: true }));
    expect(region().hidden).toBe(false);

    query<HTMLFormElement>("#external-form").reset();
    await tick();

    expect(region().hidden).toBe(true);
  });

  it("ignores reset events from forms that own no trigger", async () => {
    await mount(
      `${CHECKBOX}
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked></fieldset>`,
    );
    document.body.insertAdjacentHTML("beforeend", '<form id="unrelated-form"></form>');
    trigger().checked = true;

    query<HTMLFormElement>("#unrelated-form").reset();
    await tick();

    expect(region().hidden).toBe(true);
  });

  it("removes delegated, morph, reset, observer, and queued work on disconnect", async () => {
    await mount(
      `${CHECKBOX}
       <fieldset data-stimeo--conditional-fields-target="region" data-when-checked hidden>
         <input name="street">
       </fieldset>`,
    );
    const instance = controller() as ConditionalFieldsController & {
      regionTargetConnected(region: HTMLElement): void;
    };
    instance.regionTargetConnected(region());
    application.unload("stimeo--conditional-fields");
    region().setAttribute("data-sentinel", "preserved");
    region().hidden = false;
    trigger().checked = true;
    trigger().dispatchEvent(new Event("change", { bubbles: true }));
    region().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    root().reset();
    await tick();

    expect(region().hidden).toBe(false);
    expect(region().getAttribute("data-sentinel")).toBe("preserved");
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
