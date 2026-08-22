import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubmitOnceController } from "../src/controllers/submit_once_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/** Behavioral and lifecycle coverage for the form-scoped submit-once contract. */
describe("SubmitOnceController", () => {
  let application: Application;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const startApplication = async () => {
    application = Application.start();
    application.register("stimeo--submit-once", SubmitOnceController);
    await vi.advanceTimersByTimeAsync(0);
  };

  const mount = async (attributes = "", contents = '<button type="submit">Send</button>') => {
    document.body.innerHTML = `
      <button id="outside" type="button">Outside</button>
      <form id="form" action="#" data-controller="stimeo--submit-once" ${attributes}>
        ${contents}
      </form>`;
    await startApplication();
  };

  const form = () => query<HTMLFormElement>("#form");
  const control = (selector = "button[type=submit]") => query<SubmitControl>(selector);

  const controller = (element: Element = form()) => {
    const found = application.getControllerForElementAndIdentifier(element, "stimeo--submit-once");
    if (!(found instanceof SubmitOnceController)) throw new Error("submit-once did not connect");
    return found;
  };

  type SubmitControl = HTMLButtonElement | HTMLInputElement;

  const nativeSubmit = (submitter: SubmitControl, target = submitter.form ?? form()) => {
    const event = new SubmitEvent("submit", { submitter, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };

  const turboStart = (submitter: SubmitControl, target = submitter.form ?? form()) => {
    target.dispatchEvent(
      new CustomEvent("turbo:submit-start", {
        bubbles: true,
        detail: { formSubmission: { formElement: target, submitter } },
      }),
    );
  };

  const turboEnd = (target = form(), success = true) => {
    target.dispatchEvent(
      new CustomEvent("turbo:submit-end", { bubbles: true, detail: { success } }),
    );
  };

  it("starts from a native action with exact form/submitter detail and form hooks", async () => {
    await mount(
      'data-action="submit->stimeo--submit-once#start" data-stimeo--submit-once-busy-label-value="Working…"',
      `<button id="first" type="submit">First</button>
       <button id="second" type="submit">Second</button>`,
    );
    const second = control("#second");
    const starts: unknown[] = [];
    form().addEventListener("stimeo--submit-once:start", (event) => {
      starts.push((event as CustomEvent).detail);
    });

    nativeSubmit(second);

    expect(control("#first").disabled).toBe(true);
    expect(second.disabled).toBe(true);
    expect(second.textContent).toBe("Working…");
    expect(form().getAttribute("data-submitting")).toBe("true");
    expect(form().getAttribute("aria-busy")).toBe("true");
    expect(starts).toEqual([{ form: form(), submitter: second }]);
  });

  it("preserves structured button descendants by switching an idle/busy target pair", async () => {
    await mount(
      'data-stimeo--submit-once-busy-label-value="Destructive fallback"',
      `<button id="structured" type="submit" data-stimeo--submit-once-target="submit">
         <svg data-icon aria-hidden="true"><path></path></svg>
         <span data-stimeo--submit-once-target="idle">Send</span>
         <span data-stimeo--submit-once-target="busy" hidden>Sending…</span>
       </button>`,
    );
    const button = control("#structured");
    const icon = query<SVGElement>("[data-icon]");
    const idle = query<HTMLElement>('[data-stimeo--submit-once-target="idle"]');
    const busy = query<HTMLElement>('[data-stimeo--submit-once-target="busy"]');

    turboStart(button);
    expect(idle.hidden).toBe(true);
    expect(busy.hidden).toBe(false);
    expect(button.contains(icon)).toBe(true);
    expect(button.querySelectorAll("svg")).toHaveLength(1);

    turboEnd();
    expect(idle.hidden).toBe(false);
    expect(busy.hidden).toBe(true);
    expect(button.contains(icon)).toBe(true);
  });

  it("does not replace descendants when a structured button omits the explicit pair", async () => {
    await mount(
      'data-stimeo--submit-once-busy-label-value="Working…"',
      '<button id="structured" type="submit"><svg aria-hidden="true"></svg><span>Send</span></button>',
    );
    const button = control("#structured");
    const original = button.innerHTML;

    turboStart(button);

    expect(button.innerHTML).toBe(original);
  });

  it("uses the per-control label and restores a plain text button", async () => {
    await mount(
      'data-stimeo--submit-once-busy-label-value="Working…"',
      '<button id="send" type="submit" data-submit-once-busy-label="Saving draft…">Draft</button>',
    );
    const button = control("#send");

    turboStart(button);
    expect(button.textContent).toBe("Saving draft…");
    turboEnd();
    expect(button.textContent).toBe("Draft");
  });

  it("supports input values and aria-label without destroying button contents", async () => {
    await mount(
      'data-stimeo--submit-once-busy-label-value="Working…"',
      `<input id="input-submit" type="submit" value="Send">
       <button id="icon-submit" type="submit" aria-label="Save"><svg aria-hidden="true"></svg></button>`,
    );
    const input = control("#input-submit") as HTMLInputElement;
    const icon = control("#icon-submit") as HTMLButtonElement;

    turboStart(input);
    expect(input.value).toBe("Working…");
    turboEnd();
    expect(input.value).toBe("Send");

    turboStart(icon);
    expect(icon.getAttribute("aria-label")).toBe("Working…");
    expect(icon.querySelector("svg")).not.toBeNull();
    turboEnd();
    expect(icon.getAttribute("aria-label")).toBe("Save");
  });

  it("never rewrites an image submitter's submitted value as a label", async () => {
    await mount(
      'data-stimeo--submit-once-busy-label-value="Working…"',
      '<input id="image-submit" type="image" value="commit" alt="Send">',
    );
    const image = control("#image-submit") as HTMLInputElement;
    // Real browsers historically exclude image submitters from form.elements.
    // Shadow happy-dom's broader collection so this test fixes that engine gap.
    vi.spyOn(HTMLFormElement.prototype, "elements", "get").mockReturnValue(
      [] as unknown as HTMLFormControlsCollection,
    );

    turboStart(image);

    expect(image.disabled).toBe(true);
    expect(image.value).toBe("commit");
    turboEnd();
    expect(image.value).toBe("commit");
  });

  it("keeps the label unchanged when busyLabel is empty and ignores an idle end", async () => {
    await mount("", '<button id="send" type="submit">Send</button>');
    const button = control("#send");
    let ends = 0;
    form().addEventListener("stimeo--submit-once:end", () => {
      ends += 1;
    });

    turboEnd();
    expect(ends).toBe(0);
    turboStart(button);
    expect(button.textContent).toBe("Send");
  });

  it("supports a form with no submit control and no submitter", async () => {
    await mount("", '<input name="title">');

    expect(() =>
      form().dispatchEvent(
        new CustomEvent("turbo:submit-start", {
          bubbles: true,
          detail: { formSubmission: { formElement: form(), submitter: null } },
        }),
      ),
    ).not.toThrow();
    expect(form().getAttribute("data-submitting")).toBe("true");
    turboEnd();
    expect(form().hasAttribute("data-submitting")).toBe(false);
  });

  it("falls back to all native controls, including an implicit button", async () => {
    await mount(
      "",
      `<button id="implicit">Implicit</button>
       <input id="native-input" type="submit" value="Send">
       <button id="ordinary" type="button">Ordinary</button>`,
    );
    const implicit = control("#implicit");

    turboStart(implicit);

    expect(implicit.disabled).toBe(true);
    expect(control("#native-input").disabled).toBe(true);
    expect(control("#ordinary").disabled).toBe(false);
  });

  it("auto-subscribes to both Turbo events and reports exact completion detail", async () => {
    await mount("", '<button id="send" type="submit">Send</button>');
    const button = control("#send");
    const ends: unknown[] = [];
    form().addEventListener("stimeo--submit-once:end", (event) => {
      ends.push((event as CustomEvent).detail);
    });

    turboStart(button);
    turboEnd(form(), false);

    expect(button.disabled).toBe(false);
    expect(ends).toEqual([{ form: form(), submitter: button, reason: "turbo", success: false }]);
  });

  it("restores after timeout and identifies the timeout completion", async () => {
    await mount(
      'data-stimeo--submit-once-timeout-value="5000" data-stimeo--submit-once-busy-label-value="Working…"',
      '<button id="send" type="submit">Send</button>',
    );
    const button = control("#send");
    const ends: unknown[] = [];
    form().addEventListener("stimeo--submit-once:end", (event) => {
      ends.push((event as CustomEvent).detail);
    });

    turboStart(button);
    await vi.advanceTimersByTimeAsync(5000);

    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Send");
    expect(ends).toEqual([{ form: form(), submitter: button, reason: "timeout", success: false }]);
  });

  it("stays busy across a non-Turbo async round trip until finish", async () => {
    await mount(
      'data-action="submit->stimeo--submit-once#start custom:done->stimeo--submit-once#finish"',
      '<button id="send" type="submit">Send</button>',
    );
    const button = control("#send");
    const ends: unknown[] = [];
    form().addEventListener("stimeo--submit-once:end", (event) => {
      ends.push((event as CustomEvent).detail);
    });
    // Such a form has to cancel the native navigation to issue its own request,
    // which is why cancelling the default cannot mean the submission died.
    form().addEventListener("submit", (event) => {
      event.preventDefault();
      window.setTimeout(() => {
        form().dispatchEvent(new CustomEvent("custom:done", { detail: { success: true } }));
      }, 50);
    });

    nativeSubmit(button);
    await vi.advanceTimersByTimeAsync(10);

    expect(button.disabled).toBe(true);
    expect(form().getAttribute("data-submitting")).toBe("true");
    expect(ends).toEqual([]);

    await vi.advanceTimersByTimeAsync(50);

    expect(button.disabled).toBe(false);
    expect(form().hasAttribute("data-submitting")).toBe(false);
    expect(ends).toEqual([{ form: form(), submitter: button, reason: "manual", success: true }]);
  });

  it("lets a direct finish complete the sole active form without adding success", async () => {
    await mount("", '<button id="send" type="submit">Send</button>');
    const button = control("#send");
    let detail: unknown;
    form().addEventListener("stimeo--submit-once:end", (event) => {
      detail = (event as CustomEvent).detail;
    });
    turboStart(button);

    controller().finish();

    expect(button.disabled).toBe(false);
    expect(detail).toEqual({ form: form(), submitter: button, reason: "manual" });
  });

  it("uses the form controller element when start is called directly", async () => {
    await mount("", '<button id="send" type="submit">Send</button>');

    controller().start(new Event("manual:start"));

    expect(control("#send").disabled).toBe(true);
    controller().finish();
  });

  it("ignores a native submit already canceled by an earlier listener", async () => {
    document.body.innerHTML = `
      <form id="form" action="#" data-controller="stimeo--submit-once"
            data-action="submit->stimeo--submit-once#start">
        <button id="send" type="submit">Send</button>
      </form>`;
    form().addEventListener("submit", (event) => event.preventDefault());
    await startApplication();
    let starts = 0;
    form().addEventListener("stimeo--submit-once:start", () => {
      starts += 1;
    });

    nativeSubmit(control("#send"));

    expect(control("#send").disabled).toBe(false);
    expect(starts).toBe(0);
  });

  it("ends through cancel without announcing a completion that never ran", async () => {
    await mount(
      'data-action="submit->stimeo--submit-once#start save:aborted->stimeo--submit-once#cancel" data-stimeo--submit-once-announce-text-value="Submitting" data-stimeo--submit-once-announce-ready-text-value="Done"',
      '<button id="send" type="submit">Send</button>',
    );
    const button = control("#send");
    const announcements: string[] = [];
    const ends: unknown[] = [];
    window.addEventListener("stimeo--announcer:announce", (event) => {
      announcements.push((event as CustomEvent<{ message: string }>).detail.message);
    });
    form().addEventListener("stimeo--submit-once:end", (event) => {
      ends.push((event as CustomEvent).detail);
    });
    form().addEventListener("submit", (event) => event.preventDefault());

    nativeSubmit(button);
    expect(button.disabled).toBe(true);
    expect(announcements).toEqual(["Submitting"]);

    form().dispatchEvent(new CustomEvent("save:aborted"));

    expect(button.disabled).toBe(false);
    expect(form().hasAttribute("data-submitting")).toBe(false);
    expect(announcements).toEqual(["Submitting"]);
    expect(ends).toEqual([{ form: form(), submitter: button, reason: "canceled", success: false }]);
  });

  it("keeps a submit alive when a later listener only suppresses navigation", async () => {
    await mount(
      'data-action="submit->stimeo--submit-once#start"',
      '<button id="send" type="submit">Send</button>',
    );
    const button = control("#send");
    form().addEventListener("submit", (event) => event.preventDefault());

    nativeSubmit(button);
    await vi.advanceTimersByTimeAsync(0);

    expect(button.disabled).toBe(true);
    expect(form().getAttribute("data-submitting")).toBe("true");
    controller().finish();
  });

  it("lets a direct cancel abandon the sole active form", async () => {
    await mount("", '<button id="send" type="submit">Send</button>');
    const button = control("#send");
    let detail: unknown;
    form().addEventListener("stimeo--submit-once:end", (event) => {
      detail = (event as CustomEvent).detail;
    });
    turboStart(button);

    controller().cancel();

    expect(button.disabled).toBe(false);
    expect(detail).toEqual({ form: form(), submitter: button, reason: "canceled", success: false });
  });

  it("prevents a distinct native submit while busy and captures a new control", async () => {
    await mount(
      'data-action="submit->stimeo--submit-once#start"',
      '<button id="send" type="submit">Send</button>',
    );
    const button = control("#send");
    nativeSubmit(button);
    const late = document.createElement("button");
    late.id = "late";
    late.type = "submit";
    late.textContent = "Late";
    form().append(late);

    const duplicate = nativeSubmit(late);

    expect(duplicate.defaultPrevented).toBe(true);
    expect(late.disabled).toBe(true);
  });

  it("falls back from invalid native and Turbo submitters to a real submit control", async () => {
    await mount(
      'data-action="submit->stimeo--submit-once#start" data-stimeo--submit-once-busy-label-value="Working…"',
      `<button id="ordinary" type="button">Ordinary</button>
       <button id="send" type="submit">Send</button>`,
    );
    const ordinary = control("#ordinary");
    const send = control("#send");

    nativeSubmit(ordinary);
    expect(send.textContent).toBe("Working…");
    turboEnd();

    form().dispatchEvent(
      new CustomEvent("turbo:submit-start", {
        bubbles: true,
        detail: { formSubmission: { formElement: form(), submitter: ordinary } },
      }),
    );
    expect(send.textContent).toBe("Working…");
    turboEnd();
  });

  it("rejects malformed direct starts that do not identify an owned form", async () => {
    document.body.innerHTML = `
      <div id="root" data-controller="stimeo--submit-once">
        <form id="form">
          <button id="ordinary" type="button">Ordinary</button>
          <button id="send" type="submit">Send</button>
        </form>
      </div>`;
    await startApplication();
    const instance = controller(query("#root"));
    const ordinary = control("#ordinary");
    const send = control("#send");

    expect(() => instance.start(new Event("orphan"))).not.toThrow();
    expect(send.disabled).toBe(false);

    expect(() =>
      instance.start(new SubmitEvent("submit", { submitter: ordinary, cancelable: true })),
    ).not.toThrow();
    expect(send.disabled).toBe(false);

    expect(() =>
      instance.start(
        new CustomEvent("turbo:submit-start", {
          detail: { formSubmission: { submitter: ordinary } },
        }),
      ),
    ).not.toThrow();
    expect(send.disabled).toBe(false);
  });

  it("ignores a detached submit target connection", async () => {
    await mount();
    const detached = document.createElement("button");
    detached.type = "submit";

    expect(() => controller().submitTargetConnected(detached)).not.toThrow();
  });

  it("disables an explicit submit target connected during a session", async () => {
    await mount("", '<button id="send" type="submit">Send</button>');
    turboStart(control("#send"));
    const late = document.createElement("button");
    late.id = "late-target";
    late.type = "submit";
    late.setAttribute("data-stimeo--submit-once-target", "submit");
    form().append(late);

    await vi.advanceTimersByTimeAsync(0);

    expect(late.disabled).toBe(true);
    expect(late.getAttribute("aria-busy")).toBe("true");
  });

  it("never enables an authored-disabled submit control", async () => {
    await mount(
      "",
      `<button id="authored" type="submit" disabled>Unavailable</button>
       <button id="send" type="submit">Send</button>`,
    );
    turboStart(control("#send"));
    expect(control("#authored").hasAttribute("aria-busy")).toBe(false);
    turboEnd();

    expect(control("#authored").disabled).toBe(true);
    expect(control("#authored").hasAttribute("aria-busy")).toBe(false);
    expect(control("#send").disabled).toBe(false);
  });

  it("does not overwrite consumer mutations made while busy", async () => {
    await mount(
      'data-stimeo--submit-once-busy-label-value="Working…"',
      '<button id="send" type="submit">Send</button>',
    );
    const button = control("#send");
    turboStart(button);
    button.removeAttribute("disabled");
    button.setAttribute("aria-busy", "false");
    button.textContent = "Consumer label";
    form().setAttribute("data-submitting", "consumer");
    form().setAttribute("aria-busy", "false");

    turboEnd();

    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(button.textContent).toBe("Consumer label");
    expect(form().getAttribute("data-submitting")).toBe("consumer");
    expect(form().getAttribute("aria-busy")).toBe("false");
  });

  it("isolates simultaneous sessions when mounted above multiple forms", async () => {
    document.body.innerHTML = `
      <div id="root" data-controller="stimeo--submit-once">
        <form id="alpha"><button id="alpha-send" type="submit">Alpha</button></form>
        <form id="beta"><button id="beta-send" type="submit">Beta</button></form>
      </div>`;
    await startApplication();
    const alpha = query<HTMLFormElement>("#alpha");
    const beta = query<HTMLFormElement>("#beta");
    const alphaButton = control("#alpha-send");
    const betaButton = control("#beta-send");

    turboStart(alphaButton, alpha);
    expect(alphaButton.disabled).toBe(true);
    expect(betaButton.disabled).toBe(false);
    turboStart(betaButton, beta);
    expect(betaButton.disabled).toBe(true);

    turboEnd(alpha);
    expect(alphaButton.disabled).toBe(false);
    expect(betaButton.disabled).toBe(true);
    turboEnd(beta);
    expect(betaButton.disabled).toBe(false);
  });

  it("finishes the descendant form named by an action event, not its busy sibling", async () => {
    document.body.innerHTML = `
      <div id="root" data-controller="stimeo--submit-once">
        <form id="alpha">
          <button id="alpha-send" type="submit">Alpha</button>
          <button id="alpha-done" type="button"
                  data-action="save:done->stimeo--submit-once#finish">Done</button>
        </form>
        <form id="beta"><button id="beta-send" type="submit">Beta</button></form>
      </div>`;
    await startApplication();
    const root = query<HTMLElement>("#root");
    const alpha = query<HTMLFormElement>("#alpha");
    const beta = query<HTMLFormElement>("#beta");
    const alphaButton = control("#alpha-send");
    const betaButton = control("#beta-send");
    turboStart(alphaButton, alpha);
    turboStart(betaButton, beta);

    query<HTMLButtonElement>("#alpha-done").dispatchEvent(
      new CustomEvent("save:done", { bubbles: true, detail: { success: true } }),
    );

    expect(alphaButton.disabled).toBe(false);
    expect(betaButton.disabled).toBe(true);
    expect(() => controller(root).finish(new Event("orphan"))).not.toThrow();
    expect(betaButton.disabled).toBe(true);
    turboEnd(beta);
  });

  it("cancels the descendant form named by an action event, not its busy sibling", async () => {
    document.body.innerHTML = `
      <div id="root" data-controller="stimeo--submit-once">
        <form id="alpha">
          <button id="alpha-send" type="submit">Alpha</button>
          <button id="alpha-stop" type="button"
                  data-action="save:aborted->stimeo--submit-once#cancel">Stop</button>
        </form>
        <form id="beta"><button id="beta-send" type="submit">Beta</button></form>
      </div>`;
    await startApplication();
    const alpha = query<HTMLFormElement>("#alpha");
    const beta = query<HTMLFormElement>("#beta");
    const alphaButton = control("#alpha-send");
    const betaButton = control("#beta-send");
    turboStart(alphaButton, alpha);
    turboStart(betaButton, beta);

    query<HTMLButtonElement>("#alpha-stop").dispatchEvent(
      new CustomEvent("save:aborted", { bubbles: true }),
    );

    expect(alphaButton.disabled).toBe(false);
    expect(betaButton.disabled).toBe(true);
    turboEnd(beta);
  });

  it("directly finishes the sole descendant form of an ancestor controller", async () => {
    document.body.innerHTML = `
      <div id="root" data-controller="stimeo--submit-once">
        <form id="form"><button id="send" type="submit">Send</button></form>
      </div>`;
    await startApplication();
    const button = control("#send");
    turboStart(button);

    controller(query("#root")).finish();

    expect(button.disabled).toBe(false);
  });

  it("direct finish prefers the controller form when more than one owned session exists", async () => {
    await mount("", '<button id="send" type="submit">Send</button>');
    const outer = form();
    const inner = document.createElement("form");
    inner.id = "inner";
    inner.innerHTML = '<button id="inner-send" type="submit">Inner</button>';
    outer.append(inner);
    const outerButton = control("#send");
    const innerButton = control("#inner-send");

    turboStart(outerButton, outer);
    turboStart(innerButton, inner);
    controller().finish();

    expect(outer.hasAttribute("aria-busy")).toBe(false);
    expect(inner.getAttribute("aria-busy")).toBe("true");
    turboEnd(inner);
  });

  it("does not let an ancestor instance take over a nested instance's form", async () => {
    document.body.innerHTML = `
      <div id="outer" data-controller="stimeo--submit-once">
        <form id="form" data-controller="stimeo--submit-once">
          <button id="send" type="submit">Send</button>
        </form>
      </div>`;
    await startApplication();
    let starts = 0;
    document.body.addEventListener("stimeo--submit-once:start", () => {
      starts += 1;
    });

    turboStart(control("#send"));

    expect(starts).toBe(1);
  });

  it("restores focus only when the submitter had focus and focus became lost", async () => {
    await mount(
      'data-stimeo--submit-once-restore-focus-value="true"',
      '<button id="send" type="submit">Send</button>',
    );
    const button = control("#send");
    button.focus();

    turboStart(button);
    document.body.tabIndex = -1;
    document.body.focus();
    expect(document.activeElement).toBe(document.body);
    turboEnd();

    expect(document.activeElement).toBe(button);
  });

  it("does not focus a submitter that was not focused at start", async () => {
    await mount(
      'data-stimeo--submit-once-restore-focus-value="true"',
      '<button id="send" type="submit">Send</button>',
    );
    const outside = query<HTMLButtonElement>("#outside");
    const button = control("#send");
    outside.focus();

    turboStart(button);
    outside.blur();
    turboEnd();

    expect(document.activeElement).not.toBe(button);
  });

  it("does not steal focus when the user moved elsewhere while busy", async () => {
    await mount(
      'data-stimeo--submit-once-restore-focus-value="true"',
      '<button id="send" type="submit">Send</button>',
    );
    const outside = query<HTMLButtonElement>("#outside");
    const button = control("#send");
    button.focus();
    turboStart(button);
    outside.focus();

    turboEnd();

    expect(document.activeElement).toBe(outside);
  });

  it("preserves a live session and timeout across an in-page move", async () => {
    document.body.innerHTML = `
      <div id="from">
        <form id="form" data-controller="stimeo--submit-once"
              data-stimeo--submit-once-timeout-value="1000">
          <button id="send" type="submit">Send</button>
        </form>
      </div>
      <div id="to"></div>`;
    await startApplication();
    const button = control("#send");
    turboStart(button);

    query<HTMLElement>("#to").append(form());
    await vi.advanceTimersByTimeAsync(0);
    expect(button.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(button.disabled).toBe(false);
  });

  it("silently restores state and cancels the timeout on a true detach", async () => {
    await mount(
      'data-stimeo--submit-once-timeout-value="1000" data-stimeo--submit-once-busy-label-value="Working…"',
      '<button id="send" type="submit">Send</button>',
    );
    const root = form();
    const button = control("#send");
    let ends = 0;
    root.addEventListener("stimeo--submit-once:end", () => {
      ends += 1;
    });
    turboStart(button);

    root.remove();
    await vi.advanceTimersByTimeAsync(0);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Send");
    await vi.advanceTimersByTimeAsync(1000);
    expect(ends).toBe(0);

    root.dispatchEvent(new CustomEvent("turbo:submit-start", { bubbles: true }));
    expect(button.disabled).toBe(false);
  });

  it("reports the submission the cache rewind abandoned", async () => {
    await mount("", '<button id="send" type="submit">Send</button>');
    const button = control("#send");
    const reports: unknown[] = [];
    form().addEventListener("stimeo--submit-once:reconcile", (e) =>
      reports.push((e as CustomEvent).detail),
    );
    turboStart(button);

    document.dispatchEvent(new Event("turbo:before-cache"));
    // `end` would claim the submission resolved; the rewind only says it is gone.
    expect(reports).toEqual([{ forms: [form()] }]);

    // No session left, so a second snapshot has nothing to report.
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(reports).toEqual([{ forms: [form()] }]);
  });

  it("rewinds before Turbo cache without events, announcements, or focus", async () => {
    await mount(
      'data-stimeo--submit-once-restore-focus-value="true" data-stimeo--submit-once-announce-ready-text-value="Done"',
      '<button id="send" type="submit">Send</button>',
    );
    const outside = query<HTMLButtonElement>("#outside");
    const button = control("#send");
    const announcements: string[] = [];
    let ends = 0;
    window.addEventListener("stimeo--announcer:announce", (event) => {
      announcements.push((event as CustomEvent<{ message: string }>).detail.message);
    });
    form().addEventListener("stimeo--submit-once:end", () => {
      ends += 1;
    });
    button.focus();
    turboStart(button);
    outside.focus();

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(button.disabled).toBe(false);
    expect(form().hasAttribute("data-submitting")).toBe(false);
    expect(document.activeElement).toBe(outside);
    expect(ends).toBe(0);
    expect(announcements).toEqual([]);
  });

  it("announces only configured start and successful completion transitions", async () => {
    await mount(
      'data-stimeo--submit-once-announce-text-value="Submitting" data-stimeo--submit-once-announce-ready-text-value="Ready"',
      '<button id="send" type="submit">Send</button>',
    );
    const announcements: Array<{ message: string; assertive: boolean }> = [];
    window.addEventListener("stimeo--announcer:announce", (event) => {
      announcements.push((event as CustomEvent<{ message: string; assertive: boolean }>).detail);
    });

    turboStart(control("#send"));
    turboStart(control("#send"));
    turboEnd();

    expect(announcements).toEqual([
      { message: "Submitting", assertive: false },
      { message: "Ready", assertive: false },
    ]);
  });

  it("omits success when a completion event supplies a non-boolean value", async () => {
    await mount("", '<button id="send" type="submit">Send</button>');
    const button = control("#send");
    let detail: unknown;
    form().addEventListener("stimeo--submit-once:end", (event) => {
      detail = (event as CustomEvent).detail;
    });
    turboStart(button);

    form().dispatchEvent(
      new CustomEvent("turbo:submit-end", { bubbles: true, detail: { success: "yes" } }),
    );

    expect(detail).toStrictEqual({ form: form(), submitter: button, reason: "turbo" });
  });

  it("stays silent when announcement Values use their empty defaults", async () => {
    await mount("", '<button id="send" type="submit">Send</button>');
    let announcements = 0;
    window.addEventListener("stimeo--announcer:announce", () => {
      announcements += 1;
    });

    turboStart(control("#send"));
    turboEnd();

    expect(announcements).toBe(0);
  });

  it("has no a11y violations while busy", async () => {
    vi.useRealTimers();
    document.body.innerHTML = `
      <div data-controller="stimeo--announcer">
        <div data-stimeo--announcer-target="polite"></div>
      </div>
      <form id="form" action="#" data-controller="stimeo--submit-once"
            data-stimeo--submit-once-announce-text-value="Submitting">
        <button id="send" type="submit">Send</button>
      </form>`;
    application = Application.start();
    application.register("stimeo--submit-once", SubmitOnceController);
    await tick();
    turboStart(control("#send"));

    await expectNoA11yViolations(form());
  });
});
