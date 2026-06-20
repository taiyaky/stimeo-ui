import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirtyFormController } from "../src/controllers/dirty_form_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link DirtyFormController}: dirty detection vs the connect
 * baseline, the data-dirty hook + dirty event, the cancelable guard / native
 * confirm on a Turbo visit, beforeunload wiring, and markClean.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("DirtyFormController", () => {
  let application: Application;

  const mount = async (inner: string, attrs = "") => {
    document.body.innerHTML = `
      <form data-controller="stimeo--dirty-form" ${attrs}>${inner}</form>`;
    application = Application.start();
    application.register("stimeo--dirty-form", DirtyFormController);
    await tick();
  };

  const instance = () =>
    application.getControllerForElementAndIdentifier(
      form(),
      "stimeo--dirty-form",
    ) as DirtyFormController;

  const submit = () =>
    form().dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

  const submitEnd = (success: boolean) =>
    form().dispatchEvent(new CustomEvent("turbo:submit-end", { detail: { success } }));

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(async () => {
    // Remove the element first so controllers disconnect (and drop their window
    // listeners); application.stop() alone does not disconnect them.
    document.body.innerHTML = "";
    await tick();
    application.stop();
    vi.restoreAllMocks();
  });

  const form = () => query<HTMLFormElement>("form");
  const field = () => query<HTMLInputElement>("input[name='title']");

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
    edit("b");
    submit(); // leaving on purpose — the guard must stand down

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);

    expect(beforeVisit().defaultPrevented).toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("clears dirty after a successful submit", async () => {
    await mount('<input name="title" value="a">');
    edit("b");
    submit();
    submitEnd(true);
    expect(form().hasAttribute("data-dirty")).toBe(false);
  });

  it("re-arms the guard after a failed submit", async () => {
    setConfirm(false);
    await mount('<input name="title" value="a">');
    edit("b");
    submit();
    submitEnd(false); // validation failed → still dirty, guard back on

    expect(form().getAttribute("data-dirty")).toBe("true");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
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
    expect(event.defaultPrevented).toBe(true);
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

    expect(beforeVisit().defaultPrevented).toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
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

  it("has no a11y violations", async () => {
    await mount('<label for="t">Title</label><input id="t" name="title" value="a">');
    await expectNoA11yViolations(form());
  });
});
