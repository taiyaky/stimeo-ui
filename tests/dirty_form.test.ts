import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirtyFormController } from "../src/controllers/dirty_form_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link DirtyFormController}: dirty detection vs the connect
 * baseline, the data-dirty hook + dirty event, the cancelable guard / native
 * confirm on a Turbo visit, beforeunload wiring, and markClean.
 */

describe("DirtyFormController", () => {
  let application: Application;

  const startApplication = async () => {
    application = Application.start();
    application.register("stimeo--dirty-form", DirtyFormController);
    await tick();
  };

  const mount = async (inner: string, attrs = "") => {
    document.body.innerHTML = `
      <form data-controller="stimeo--dirty-form" ${attrs}>${inner}</form>`;
    await startApplication();
  };

  const mountSeveral = async (markup: string) => {
    document.body.innerHTML = markup;
    await startApplication();
  };

  const instance = () =>
    application.getControllerForElementAndIdentifier(
      form(),
      "stimeo--dirty-form",
    ) as DirtyFormController;

  const submit = () =>
    form().dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

  const submitStart = (formSubmission: object = {}) =>
    form().dispatchEvent(
      new CustomEvent("turbo:submit-start", {
        bubbles: true,
        detail: { formSubmission },
      }),
    );

  const submitEnd = (success: boolean, formSubmission?: object) =>
    form().dispatchEvent(
      new CustomEvent("turbo:submit-end", {
        bubbles: true,
        detail: formSubmission === undefined ? { success } : { success, formSubmission },
      }),
    );

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  const form = () => query<HTMLFormElement>("form");
  const field = () => query<HTMLInputElement>("input[name='title']");
  const forms = () => Array.from(document.querySelectorAll<HTMLFormElement>("form"));

  /** happy-dom has no window.confirm; install a mock and return it. */
  const setConfirm = (result: boolean) => {
    const mock = vi.fn(() => result);
    window.confirm = mock;
    return mock;
  };

  const edit = (value: string) => {
    field().value = value;
    field().dispatchEvent(new Event("input", { bubbles: true }));
  };

  const editField = (element: HTMLInputElement, value: string) => {
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const beforeVisit = () => {
    const event = new CustomEvent("turbo:before-visit", { cancelable: true });
    document.dispatchEvent(event);
    return event;
  };

  it("is not dirty on connect", async () => {
    await mount('<input name="title" value="a">');
    expect(form().hasAttribute("data-dirty")).toBe(false);
  });

  it("detects a change in one of several same-name fields", async () => {
    // The serialization is positional (one entry per control in DOM order), so a
    // repeated name like `tags[]` does not collide — a change in any one is seen.
    await mount('<input name="tags[]" value="a"><input name="tags[]" value="b">');
    expect(form().hasAttribute("data-dirty")).toBe(false);
    const [, second] = Array.from(document.querySelectorAll<HTMLInputElement>("[name='tags[]']"));
    if (!second) throw new Error("expected two tags[] inputs");
    second.value = "c";
    second.dispatchEvent(new Event("input", { bubbles: true }));
    expect(form().hasAttribute("data-dirty")).toBe(true);
  });

  it("keeps field values containing serialization delimiters distinct", async () => {
    await mount('<input name="a" value="x|b:y"><input name="b" value="z">');
    const [first, second] = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
    if (!first || !second) throw new Error("expected two inputs");

    // A delimiter-joined snapshot would confuse these two distinct form states.
    first.value = "x";
    second.value = "y|b:z";
    second.dispatchEvent(new Event("input", { bubbles: true }));

    expect(form().getAttribute("data-dirty")).toBe("true");
  });

  it("clears a stale data-dirty from a restored cache snapshot on connect", async () => {
    // A Turbo cache snapshot taken mid-edit carries data-dirty="true". connect()
    // re-baselines from the restored values (they ARE the clean state), so the
    // stale hook must be dropped and neither guard may fire.
    const confirmMock = setConfirm(false);
    await mount('<input name="title" value="b">', 'data-dirty="true"');

    expect(form().hasAttribute("data-dirty")).toBe(false);

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    expect(beforeVisit().defaultPrevented).toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("becomes dirty on change and emits the dirty event", async () => {
    await mount('<input name="title" value="a">');
    const events: boolean[] = [];
    form().addEventListener("stimeo--dirty-form:dirty", (e) => {
      events.push((e as CustomEvent).detail.dirty);
    });

    edit("b");

    expect(form().getAttribute("data-dirty")).toBe("true");
    expect(events.at(-1)).toBe(true);
  });

  it("clears dirty when the value returns to the baseline", async () => {
    await mount('<input name="title" value="a">');
    edit("b");
    edit("a");
    expect(form().hasAttribute("data-dirty")).toBe(false);
  });

  it("markClean re-baselines and clears the dirty state", async () => {
    await mount('<input name="title" value="a">');
    edit("b");
    instance().markClean();
    expect(form().hasAttribute("data-dirty")).toBe(false);
    // Re-baselined at "b": editing back to "a" is now the dirty one.
    edit("a");
    expect(form().getAttribute("data-dirty")).toBe("true");
  });

  it("suppresses the guard while a submit is in flight", async () => {
    const confirmMock = setConfirm(false);
    await mount('<input name="title" value="a">');
    const guard = vi.fn();
    form().addEventListener("stimeo--dirty-form:guard", guard);
    edit("b");
    submit(); // leaving on purpose — the guard must stand down
    submitStart();
    await tick();

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);

    expect(beforeVisit().defaultPrevented).toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
  });

  it("clears dirty after a successful submit", async () => {
    await mount('<input name="title" value="a">');
    edit("b");
    submit();
    const formSubmission = {};
    submitStart(formSubmission);
    submitEnd(true, formSubmission);
    expect(form().hasAttribute("data-dirty")).toBe(false);
  });

  it("re-arms the guard after a failed submit", async () => {
    setConfirm(false);
    await mount('<input name="title" value="a">');
    edit("b");
    submit();
    const formSubmission = {};
    submitStart(formSubmission);
    submitEnd(false, formSubmission); // validation failed → still dirty, guard back on

    expect(form().getAttribute("data-dirty")).toBe("true");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });

  it("guards after a consumer cancels submit without another edit", async () => {
    const confirmMock = setConfirm(false);
    await mount('<input name="title" value="a">');
    edit("b");
    form().addEventListener("submit", (event) => event.preventDefault());

    submit();
    await tick();
    const visit = beforeVisit();

    expect(visit.defaultPrevented).toBe(true);
    expect(confirmMock).toHaveBeenCalledOnce();
  });

  it("ignores formdata events outside a submit attempt", async () => {
    await mount('<input name="title" value="a">');

    expect(() => form().dispatchEvent(new Event("formdata"))).not.toThrow();
    expect(form().hasAttribute("data-dirty")).toBe(false);
  });

  it("ignores a tokened submit completion without a matching submit-start", async () => {
    await mount('<input name="title" value="a">');
    edit("b");

    submitEnd(true, {});

    expect(form().getAttribute("data-dirty")).toBe("true");
  });

  it("captures the revision Turbo turns into FormData after submit consumers run", async () => {
    await mount('<input name="title" value="a">');
    edit("before later submit consumer");
    form().addEventListener(
      "submit",
      () => {
        field().value = "revision actually submitted";
      },
      { once: true },
    );

    submit();
    // happy-dom does not synchronously synthesize the platform formdata event
    // from the constructor; the Chromium regression verifies that integration.
    form().dispatchEvent(new Event("formdata"));
    const formSubmission = {};
    submitStart(formSubmission);
    submitEnd(true, formSubmission);

    expect(form().hasAttribute("data-dirty")).toBe(false);
    edit("before later submit consumer");
    expect(form().getAttribute("data-dirty")).toBe("true");
  });

  it("keeps edits made after FormData capture but before submit-start dirty", async () => {
    const confirmMock = setConfirm(false);
    await mount('<input name="title" value="a">');
    edit("revision actually submitted");
    submit();
    form().dispatchEvent(new Event("formdata"));

    edit("new unsaved value");
    const formSubmission = {};
    submitStart(formSubmission);
    submitEnd(true, formSubmission);

    expect(form().getAttribute("data-dirty")).toBe("true");
    expect(beforeVisit().defaultPrevented).toBe(true);
    expect(confirmMock).toHaveBeenCalledOnce();
  });

  it("keeps edits made after submit dirty when that submission succeeds", async () => {
    const confirmMock = setConfirm(false);
    await mount('<input name="title" value="a">');
    edit("submitted value");
    submit();
    const formSubmission = {};
    submitStart(formSubmission);

    edit("new unsaved value");
    submitEnd(true, formSubmission);

    expect(form().getAttribute("data-dirty")).toBe("true");
    expect(beforeVisit().defaultPrevented).toBe(true);
    expect(confirmMock).toHaveBeenCalledOnce();
  });

  it("ignores the completion of a superseded Turbo submission", async () => {
    await mount('<input name="title" value="a">');
    edit("first submission");
    submit();
    const firstSubmission = {};
    submitStart(firstSubmission);

    edit("second submission");
    submit();
    const secondSubmission = {};
    submitStart(secondSubmission);

    submitEnd(true, firstSubmission);
    expect(form().getAttribute("data-dirty")).toBe("true");

    submitEnd(true, secondSubmission);
    expect(form().hasAttribute("data-dirty")).toBe(false);
  });

  it("preserves a pending snapshot when the previous submission finishes", async () => {
    await mount('<input name="title" value="a">');
    edit("first submission");
    submit();
    form().dispatchEvent(new Event("formdata"));
    const firstSubmission = {};
    submitStart(firstSubmission);

    edit("second submission");
    submit();
    form().dispatchEvent(new Event("formdata"));
    edit("new unsaved value");

    submitEnd(true, firstSubmission);
    const secondSubmission = {};
    submitStart(secondSubmission);
    submitEnd(true, secondSubmission);

    expect(form().getAttribute("data-dirty")).toBe("true");
    edit("second submission");
    expect(form().hasAttribute("data-dirty")).toBe(false);
  });

  it("re-arms the guard when editing resumes after an unresolved submit", async () => {
    await mount('<input name="title" value="a">');
    edit("b");
    submit(); // suppressed (e.g. cancelled client-side: no turbo:submit-end follows)

    const suppressed = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(suppressed);
    expect(suppressed.defaultPrevented).toBe(false);

    edit("c"); // user keeps editing → guard back on
    const rearmed = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(rearmed);
    expect(rearmed.defaultPrevented).toBe(true);
  });

  it("confirms a Turbo visit while dirty and blocks it when declined", async () => {
    const confirmMock = setConfirm(false);
    await mount('<input name="title" value="a">');
    edit("b");

    const event = beforeVisit();

    expect(confirmMock).toHaveBeenCalledOnce();
    expect(confirmMock).toHaveBeenCalledWith("You have unsaved changes that will be lost.");
    expect(event.defaultPrevented).toBe(true);
  });

  it("passes a custom message Value to the native confirm", async () => {
    const confirmMock = setConfirm(true);
    await mount(
      '<input name="title" value="a">',
      'data-stimeo--dirty-form-message-value="Keep this draft?"',
    );
    edit("b");

    beforeVisit();

    expect(confirmMock).toHaveBeenCalledOnce();
    expect(confirmMock).toHaveBeenCalledWith("Keep this draft?");
  });

  it("allows a Turbo visit when the confirm is accepted", async () => {
    setConfirm(true);
    await mount('<input name="title" value="a">');
    edit("b");

    expect(beforeVisit().defaultPrevented).toBe(false);
  });

  it("lets a consumer cancel the guard event instead of the native confirm", async () => {
    const confirmMock = setConfirm(true);
    await mount('<input name="title" value="a">');
    form().addEventListener("stimeo--dirty-form:guard", (e) => e.preventDefault());
    edit("b");

    const event = beforeVisit();

    expect(confirmMock).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not confirm after a guard consumer saves synchronously", async () => {
    const confirmMock = setConfirm(true);
    await mount('<input name="title" value="a">');
    form().addEventListener("stimeo--dirty-form:guard", () => instance().markClean());
    edit("b");

    const event = beforeVisit();

    expect(event.defaultPrevented).toBe(false);
    expect(form().hasAttribute("data-dirty")).toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("blocks the visit via confirmBridge without a native confirm", async () => {
    const confirmMock = setConfirm(true);
    await mount(
      '<input name="title" value="a">',
      'data-stimeo--dirty-form-confirm-bridge-value="true"',
    );
    edit("b");

    const event = beforeVisit();

    expect(confirmMock).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("does nothing on a Turbo visit while clean", async () => {
    const confirmMock = setConfirm(false);
    await mount('<input name="title" value="a">');
    const guard = vi.fn();
    form().addEventListener("stimeo--dirty-form:guard", guard);

    expect(beforeVisit().defaultPrevented).toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
  });

  it("guards beforeunload only while dirty", async () => {
    await mount('<input name="title" value="a">');

    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    edit("b");
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  it("clears dirty on a successful turbo:submit-end", async () => {
    await mount('<input name="title" value="a">');
    edit("b");
    form().dispatchEvent(new CustomEvent("turbo:submit-end", { detail: { success: true } }));
    expect(form().hasAttribute("data-dirty")).toBe(false);
  });

  it("removes the beforeunload guard on disconnect", async () => {
    await mount('<input name="title" value="a">');
    edit("b");
    form().remove(); // disconnect tears down the window listener
    await tick();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("starts a fresh dirty lifecycle after reconnect", async () => {
    await mount('<input name="title" value="a">');
    const states: boolean[] = [];
    form().addEventListener("stimeo--dirty-form:dirty", (event) => {
      states.push((event as CustomEvent<{ dirty: boolean }>).detail.dirty);
    });
    edit("b");
    const currentForm = form();
    const currentField = field();

    currentForm.remove();
    await tick();
    document.body.append(currentForm);
    await tick();

    expect(currentForm.hasAttribute("data-dirty")).toBe(false);
    expect(states).toEqual([true, false]);
    editField(currentField, "c");
    expect(currentForm.getAttribute("data-dirty")).toBe("true");
    expect(states.at(-1)).toBe(true);

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("detects changes to single and multi select controls", async () => {
    await mount(
      `<select name="plan"><option value="x" selected>X</option><option value="y">Y</option></select>
       <select name="tags" multiple>
         <option value="a" selected>A</option><option value="b" selected>B</option>
       </select>`,
    );
    // The multi-select (selected at parse time) exercises the selectedOptions path;
    // the dirty assertion changes the single select via `value` (happy-dom reflects it).
    const plan = query<HTMLSelectElement>("select[name='plan']");
    plan.value = "y";
    plan.dispatchEvent(new Event("change", { bubbles: true }));
    expect(form().getAttribute("data-dirty")).toBe("true");
  });

  it("toggling checkbox and radio controls marks dirty and clears on return", async () => {
    await mount(`
      <input type="checkbox" name="published">
      <input type="radio" name="visibility" value="public" checked>
      <input type="radio" name="visibility" value="private">
    `);
    const checkbox = query<HTMLInputElement>("input[type='checkbox']");
    const [publicRadio, privateRadio] = Array.from(
      document.querySelectorAll<HTMLInputElement>("input[type='radio']"),
    );
    if (!publicRadio || !privateRadio) throw new Error("expected both radio controls");

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(form().getAttribute("data-dirty")).toBe("true");
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(form().hasAttribute("data-dirty")).toBe(false);

    privateRadio.checked = true;
    privateRadio.dispatchEvent(new Event("change", { bubbles: true }));
    expect(form().getAttribute("data-dirty")).toBe("true");
    publicRadio.checked = true;
    publicRadio.dispatchEvent(new Event("change", { bubbles: true }));
    expect(form().hasAttribute("data-dirty")).toBe(false);
  });

  it("detects a checked checkbox's submitted value changing", async () => {
    await mount('<input type="checkbox" name="permission" value="read" checked>');
    const checkbox = query<HTMLInputElement>("input[type='checkbox']");

    checkbox.value = "write";
    checkbox.dispatchEvent(new Event("input", { bubbles: true }));
    expect(form().getAttribute("data-dirty")).toBe("true");

    checkbox.value = "read";
    checkbox.dispatchEvent(new Event("input", { bubbles: true }));
    expect(form().hasAttribute("data-dirty")).toBe(false);
  });

  it("changing a multi-select selection marks dirty and clears on return", async () => {
    await mount(`
      <select name="tags" multiple>
        <option value="a" selected>A</option>
        <option value="b">B</option>
      </select>
    `);
    const select = query<HTMLSelectElement>("select");
    const option = query<HTMLOptionElement>("option[value='b']");

    // happy-dom derives selectedOptions from the content attribute.
    option.setAttribute("selected", "");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(form().getAttribute("data-dirty")).toBe("true");

    option.removeAttribute("selected");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(form().hasAttribute("data-dirty")).toBe(false);
  });

  it("emits dirty only when the dirty state changes", async () => {
    await mount('<input name="title" value="a">');
    const states: boolean[] = [];
    form().addEventListener("stimeo--dirty-form:dirty", (event) => {
      states.push((event as CustomEvent<{ dirty: boolean }>).detail.dirty);
    });

    edit("b");
    edit("c");
    edit("d");
    expect(states).toEqual([true]);

    edit("a");
    edit("a");
    expect(states).toEqual([true, false]);
  });

  describe("with several forms on one page", () => {
    const markup = (firstAttrs = "", secondAttrs = "") => `
      <form id="first" data-controller="stimeo--dirty-form" ${firstAttrs}>
        <input name="first-title" value="a">
      </form>
      <form id="second" data-controller="stimeo--dirty-form" ${secondAttrs}>
        <input name="second-title" value="a">
      </form>
    `;

    const dirtyBoth = () => {
      const firstField = query<HTMLInputElement>("#first input");
      const secondField = query<HTMLInputElement>("#second input");
      editField(firstField, "b");
      editField(secondField, "b");
    };

    it("confirms once per visit no matter how many forms are dirty", async () => {
      const confirmMock = setConfirm(true);
      await mountSeveral(markup());
      dirtyBoth();

      const event = beforeVisit();

      expect(event.defaultPrevented).toBe(false);
      expect(confirmMock).toHaveBeenCalledOnce();
    });

    it("blocks the visit when the single confirmation is declined", async () => {
      const confirmMock = setConfirm(false);
      await mountSeveral(markup());
      dirtyBoth();

      const event = beforeVisit();

      expect(event.defaultPrevented).toBe(true);
      expect(confirmMock).toHaveBeenCalledOnce();
    });

    it("confirms again for the next visit", async () => {
      const confirmMock = setConfirm(true);
      await mountSeveral(markup());
      dirtyBoth();

      beforeVisit();
      beforeVisit();

      expect(confirmMock).toHaveBeenCalledTimes(2);
    });

    it("uses the first eligible form in live DOM order", async () => {
      const confirmMock = setConfirm(true);
      await mountSeveral(
        markup(
          'data-stimeo--dirty-form-message-value="first form"',
          'data-stimeo--dirty-form-message-value="second form"',
        ),
      );
      dirtyBoth();
      const [first, second] = forms();
      if (!first || !second) throw new Error("expected two forms");
      document.body.insertBefore(second, first);

      beforeVisit();

      expect(confirmMock).toHaveBeenCalledOnce();
      expect(confirmMock).toHaveBeenCalledWith("second form");
    });

    it("skips a submitting form without consuming the native confirmation", async () => {
      const confirmMock = setConfirm(true);
      await mountSeveral(
        markup(
          'data-stimeo--dirty-form-message-value="first form"',
          'data-stimeo--dirty-form-message-value="second form"',
        ),
      );
      dirtyBoth();
      query<HTMLFormElement>("#first").dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
      );

      beforeVisit();

      expect(confirmMock).toHaveBeenCalledOnce();
      expect(confirmMock).toHaveBeenCalledWith("second form");
    });

    it("dispatches every form guard before honoring any consumer cancellation", async () => {
      const confirmMock = setConfirm(true);
      await mountSeveral(markup());
      dirtyBoth();
      const seen: Array<{ form: string; event: Event }> = [];
      for (const current of forms()) {
        current.addEventListener("stimeo--dirty-form:guard", (event) => {
          const guard = event as CustomEvent<{ event: Event }>;
          seen.push({ form: current.id, event: guard.detail.event });
          if (current.id === "second") event.preventDefault();
        });
      }
      const visit = new CustomEvent("turbo:before-visit", { cancelable: true });

      document.dispatchEvent(visit);

      expect(seen).toEqual([
        { form: "first", event: visit },
        { form: "second", event: visit },
      ]);
      expect(visit.defaultPrevented).toBe(true);
      expect(confirmMock).not.toHaveBeenCalled();
    });

    it("suppresses native confirmation when any form delegates to a Confirm Bridge", async () => {
      const confirmMock = setConfirm(true);
      await mountSeveral(markup("", 'data-stimeo--dirty-form-confirm-bridge-value="true"'));
      dirtyBoth();
      const seen: string[] = [];
      for (const current of forms()) {
        current.addEventListener("stimeo--dirty-form:guard", () => seen.push(current.id));
      }

      const visit = beforeVisit();

      expect(seen).toEqual(["first", "second"]);
      expect(visit.defaultPrevented).toBe(true);
      expect(confirmMock).not.toHaveBeenCalled();
    });

    it("does not confirm an already-canceled Turbo visit", async () => {
      const confirmMock = setConfirm(true);
      const cancel = (event: Event) => event.preventDefault();
      document.addEventListener("turbo:before-visit", cancel);
      await mountSeveral(markup());
      dirtyBoth();
      const seen: string[] = [];
      for (const current of forms()) {
        current.addEventListener("stimeo--dirty-form:guard", () => seen.push(current.id));
      }

      const visit = beforeVisit();
      document.removeEventListener("turbo:before-visit", cancel);

      expect(seen).toEqual(["first", "second"]);
      expect(visit.defaultPrevented).toBe(true);
      expect(confirmMock).not.toHaveBeenCalled();
    });

    it("removes disconnected forms from visit coordination", async () => {
      const confirmMock = setConfirm(true);
      await mountSeveral(
        markup(
          'data-stimeo--dirty-form-message-value="first form"',
          'data-stimeo--dirty-form-message-value="second form"',
        ),
      );
      dirtyBoth();
      query<HTMLFormElement>("#first").remove();
      await tick();

      beforeVisit();
      expect(confirmMock).toHaveBeenCalledOnce();
      expect(confirmMock).toHaveBeenLastCalledWith("second form");

      query<HTMLFormElement>("#second").remove();
      await tick();
      beforeVisit();
      expect(confirmMock).toHaveBeenCalledOnce();
    });

    it("skips a later form removed by an earlier guard consumer", async () => {
      const confirmMock = setConfirm(true);
      await mountSeveral(
        markup(
          'data-stimeo--dirty-form-message-value="first form"',
          'data-stimeo--dirty-form-message-value="second form"',
        ),
      );
      dirtyBoth();
      const seen: string[] = [];
      query<HTMLFormElement>("#first").addEventListener("stimeo--dirty-form:guard", () => {
        seen.push("first");
        query<HTMLFormElement>("#second").remove();
      });
      query<HTMLFormElement>("#second").addEventListener("stimeo--dirty-form:guard", () => {
        seen.push("second");
      });

      beforeVisit();

      expect(seen).toEqual(["first"]);
      expect(confirmMock).toHaveBeenCalledOnce();
      expect(confirmMock).toHaveBeenCalledWith("first form");
    });

    it("skips a form removed by its own guard consumer", async () => {
      const confirmMock = setConfirm(true);
      await mountSeveral(
        markup(
          'data-stimeo--dirty-form-message-value="first form"',
          'data-stimeo--dirty-form-message-value="second form"',
        ),
      );
      dirtyBoth();
      const seen: string[] = [];
      query<HTMLFormElement>("#first").addEventListener("stimeo--dirty-form:guard", () => {
        seen.push("first");
        query<HTMLFormElement>("#first").remove();
      });
      query<HTMLFormElement>("#second").addEventListener("stimeo--dirty-form:guard", () => {
        seen.push("second");
      });

      beforeVisit();

      expect(seen).toEqual(["first", "second"]);
      expect(confirmMock).toHaveBeenCalledOnce();
      expect(confirmMock).toHaveBeenCalledWith("second form");
    });
  });

  it("has no a11y violations", async () => {
    await mount('<label for="t">Title</label><input id="t" name="title" value="a">');
    await expectNoA11yViolations(form());
  });
});
