import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubmitOnceController } from "../src/controllers/submit_once_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
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

  /**
   * Mounts on a wrapper around the form: happy-dom connects a second instance to a
   * `<form>` host when one of its attributes changes, under another identity of the same
   * element, and that instance takes the form's leased attributes for a restored copy's.
   */
  const mountAround = async (attributes: string, contents: string) => {
    document.body.innerHTML = `
      <div id="root" data-controller="stimeo--submit-once" ${attributes}>
        <form id="form" action="#">${contents}</form>
      </div>`;
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
    /** Browsers omit image submitters from the collection exposed by this form. */
    vi.spyOn(form(), "elements", "get").mockReturnValue(
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

  // --- `timeout` belongs to one submission session ---------------------------------

  /**
   * Rewrites `timeout` on `host` and delivers its Value callback directly when the
   * controller defines one, since happy-dom does not reliably run it for an attribute
   * write.
   */
  const declareTimeout = (value: number, host: Element = form()) => {
    host.setAttribute("data-stimeo--submit-once-timeout-value", String(value));
    const owner = controller(host);
    const callback: unknown = Reflect.get(owner, "timeoutValueChanged");
    if (typeof callback === "function") callback.call(owner);
  };

  it.each([
    { direction: "shrinks", next: 50 },
    { direction: "grows", next: 5000 },
  ])(
    "keeps a session's watchdog deadline when timeout $direction, and arms the next submission anew",
    async ({ next }) => {
      await mountAround(
        'data-stimeo--submit-once-timeout-value="1000"',
        '<button id="send" type="submit">Send</button>',
      );
      const button = control("#send");
      const reasons: string[] = [];
      query("#root").addEventListener("stimeo--submit-once:end", (event) => {
        reasons.push((event as CustomEvent<{ reason: string }>).detail.reason);
      });
      turboStart(button);
      await vi.advanceTimersByTimeAsync(100);

      declareTimeout(next, query("#root"));
      await vi.advanceTimersByTimeAsync(899);
      expect(button.disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(button.disabled).toBe(false);
      expect(reasons).toEqual(["timeout"]);

      turboStart(button);
      await vi.advanceTimersByTimeAsync(next - 1);
      expect(button.disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(button.disabled).toBe(false);
      expect(reasons).toEqual(["timeout", "timeout"]);
    },
  );

  it.each([{ ending: "a completion", end: () => turboEnd() }])(
    "disarms the watchdog of a submission ended by $ending before the next one starts",
    async ({ end }) => {
      await mount(
        'data-stimeo--submit-once-timeout-value="1000"',
        '<button id="send" type="submit">Send</button>',
      );
      const button = control("#send");
      const reasons: string[] = [];
      form().addEventListener("stimeo--submit-once:end", (event) => {
        reasons.push((event as CustomEvent<{ reason: string }>).detail.reason);
      });
      turboStart(button);
      await vi.advanceTimersByTimeAsync(500);
      end();
      const before = [...reasons];

      turboStart(button);
      await vi.advanceTimersByTimeAsync(500);
      expect(button.disabled).toBe(true);
      expect(reasons).toEqual(before);

      await vi.advanceTimersByTimeAsync(500);
      expect(button.disabled).toBe(false);
      expect(reasons).toEqual([...before, "timeout"]);
    },
  );

  it("keeps each form's session on the timeout it started with", async () => {
    document.body.innerHTML = `
      <div id="root" data-controller="stimeo--submit-once"
           data-stimeo--submit-once-timeout-value="1000">
        <form id="alpha"><button id="alpha-send" type="submit">Alpha</button></form>
        <form id="beta"><button id="beta-send" type="submit">Beta</button></form>
      </div>`;
    await startApplication();
    const root = query<HTMLElement>("#root");
    const alphaButton = control("#alpha-send");
    const betaButton = control("#beta-send");

    turboStart(alphaButton, query<HTMLFormElement>("#alpha"));
    await vi.advanceTimersByTimeAsync(100);
    declareTimeout(300, root);
    turboStart(betaButton, query<HTMLFormElement>("#beta")); // due at t=400

    await vi.advanceTimersByTimeAsync(299);
    expect([alphaButton.disabled, betaButton.disabled]).toEqual([true, true]);
    await vi.advanceTimersByTimeAsync(1);
    expect([alphaButton.disabled, betaButton.disabled]).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(599); // t=999
    expect(alphaButton.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(alphaButton.disabled).toBe(false);
  });

  it("ends and reports nothing from a timeout change alone", async () => {
    await mount("", '<button id="send" type="submit">Send</button>');
    const button = control("#send");
    const events: string[] = [];
    for (const type of ["start", "end", "reconcile"]) {
      form().addEventListener(`stimeo--submit-once:${type}`, () => events.push(type));
    }
    declareTimeout(20);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([]);

    // A session started with no watchdog is not given one by a later declaration.
    declareTimeout(0);
    turboStart(button);
    declareTimeout(20);
    await vi.advanceTimersByTimeAsync(1000);
    expect(button.disabled).toBe(true);
    expect(form().getAttribute("aria-busy")).toBe("true");
    expect(events).toEqual(["start"]);
  });

  it("stays busy across a non-Turbo async round trip until finish", async () => {
    await mountAround(
      'data-action="submit->stimeo--submit-once#start custom:done->stimeo--submit-once#finish"',
      '<button id="send" type="submit">Send</button>',
    );
    const button = control("#send");
    const ends: unknown[] = [];
    query("#root").addEventListener("stimeo--submit-once:end", (event) => {
      ends.push((event as CustomEvent).detail);
    });
    // Such a form has to cancel the native navigation to issue its own request,
    // which is why cancelling the default cannot mean the submission died.
    query("#root").addEventListener("submit", (event) => {
      event.preventDefault();
      window.setTimeout(() => {
        form().dispatchEvent(
          new CustomEvent("custom:done", { bubbles: true, detail: { success: true } }),
        );
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
    await mountAround(
      'data-action="submit->stimeo--submit-once#start"',
      '<button id="send" type="submit">Send</button>',
    );
    const button = control("#send");
    query("#root").addEventListener("submit", (event) => event.preventDefault());

    nativeSubmit(button);
    await vi.advanceTimersByTimeAsync(0);

    expect(button.disabled).toBe(true);
    expect(form().getAttribute("data-submitting")).toBe("true");
    controller(query("#root")).finish();
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

  it("returns each control's aria-busy when the submission ends", async () => {
    await mount(
      "",
      `<button id="send" type="submit">Send</button>
       <button id="other" type="submit">Other</button>`,
    );
    turboStart(control("#send"));
    expect(control("#send").getAttribute("aria-busy")).toBe("true");
    expect(control("#other").getAttribute("aria-busy")).toBe("true");

    turboEnd();

    expect(control("#send").hasAttribute("aria-busy")).toBe(false);
    expect(control("#other").hasAttribute("aria-busy")).toBe(false);
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
    // The host is a wrapper: happy-dom connects a second instance to a moved `<form>` host.
    document.body.innerHTML = `
      <div id="from">
        <div id="root" data-controller="stimeo--submit-once"
             data-stimeo--submit-once-timeout-value="1000">
          <form id="form"><button id="send" type="submit">Send</button></form>
        </div>
      </div>
      <div id="to"></div>`;
    await startApplication();
    const button = control("#send");
    turboStart(button);

    query<HTMLElement>("#to").append(query("#root"));
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

  it("drops detached sessions so the same instance can start the same form again", async () => {
    await mountAround("", '<button id="send" type="submit">Send</button>');
    const root = query<HTMLElement>("#root");
    const instance = controller(root);
    const button = control("#send");
    const starts = vi.fn();
    const ends = vi.fn();
    root.addEventListener("stimeo--submit-once:start", starts);
    root.addEventListener("stimeo--submit-once:end", ends);
    turboStart(button);
    expect(button.disabled).toBe(true);

    root.remove();
    instance.disconnect();
    expect(button.disabled).toBe(false);
    instance.finish();
    expect(ends).not.toHaveBeenCalled();

    document.body.append(root);
    instance.connect();
    turboStart(button);

    expect(starts).toHaveBeenCalledTimes(2);
    expect(button.disabled).toBe(true);
    expect(form().getAttribute("data-submitting")).toBe("true");
    turboEnd();
    expect(ends).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(false);
  });

  it("does not let a detached submission's deadline complete the next session of the same form", async () => {
    await mountAround(
      'data-stimeo--submit-once-timeout-value="1000"',
      '<button id="send" type="submit">Send</button>',
    );
    const root = query<HTMLElement>("#root");
    const instance = controller(root);
    const button = control("#send");
    const ends: unknown[] = [];
    root.addEventListener("stimeo--submit-once:end", (event) => {
      ends.push((event as CustomEvent).detail);
    });
    turboStart(button);
    expect(button.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(100);

    root.remove();
    instance.disconnect();
    expect(button.disabled).toBe(false);
    document.body.append(root);
    instance.connect();
    turboStart(button);
    expect(button.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(900);
    expect(button.disabled).toBe(true);
    expect(form().getAttribute("aria-busy")).toBe("true");
    expect(ends).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    expect(button.disabled).toBe(false);
    expect(form().hasAttribute("aria-busy")).toBe(false);
    expect(ends).toEqual([{ form: form(), submitter: button, reason: "timeout", success: false }]);
  });

  it("releases the capture submit listener on disconnect", async () => {
    // The listener runs in capture, so its release has to match that flag. The
    // release is synchronous, and the session it would read is still live on
    // the next line — a listener left behind would cancel this submit.
    await mount("", '<button id="send" type="submit">Send</button>');
    const button = control("#send");
    turboStart(button);
    expect(nativeSubmit(button).defaultPrevented).toBe(true);

    controller().disconnect();

    expect(nativeSubmit(button).defaultPrevented).toBe(false);
  });

  it("keeps the guard through turbo:before-cache until the submission ends", async () => {
    await mount(
      'data-stimeo--submit-once-announce-ready-text-value="Done" data-stimeo--submit-once-busy-label-value="Saving"',
      '<button id="send" type="submit">Send</button>',
    );
    const button = control("#send");
    const announcements: string[] = [];
    const events: string[] = [];
    window.addEventListener("stimeo--announcer:announce", (event) => {
      announcements.push((event as CustomEvent<{ message: string }>).detail.message);
    });
    for (const name of ["end", "reconcile"]) {
      form().addEventListener(`stimeo--submit-once:${name}`, () => events.push(name));
    }
    turboStart(button);

    // Turbo dispatches it on pages that stay as well, where the request is still
    // running and a second click must not submit again.
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Saving");
    expect(form().getAttribute("data-submitting")).toBe("true");
    expect(nativeSubmit(button).defaultPrevented).toBe(true);
    expect(events).toEqual([]);

    turboEnd();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Send");
    expect(events[0]).toBe("end");
    expect(events).not.toContain("reconcile");
    expect(announcements).toContain("Done");
  });

  it("records a label it swaps through text or value until the submission ends", async () => {
    await mount(
      'data-stimeo--submit-once-busy-label-value="Working"',
      `<button id="send" type="submit">Send</button>
       <input id="input-submit" type="submit" value="Go">`,
    );
    const button = control("#send");
    const input = control("#input-submit") as HTMLInputElement;

    turboStart(button);
    expect(button.getAttribute("data-stimeo--submit-once-label")).toBe('["Send","Working"]');
    turboEnd();
    expect(button.hasAttribute("data-stimeo--submit-once-label")).toBe(false);

    turboStart(input);
    expect(input.getAttribute("data-stimeo--submit-once-label")).toBe('["Go","Working"]');
    turboEnd();
    expect(input.hasAttribute("data-stimeo--submit-once-label")).toBe(false);
  });

  /** Mounts the controller on a wrapper, so each element has one controller instance. */
  const mountWrapped = async (attributes: string, contents: string) => {
    document.body.innerHTML = `
      <div id="root" data-controller="stimeo--submit-once" ${attributes}>
        <form id="form" action="#">${contents}</form>
      </div>`;
    await startApplication();
  };

  /** Puts a restored copy of the page in place, as Turbo renders one from its cache. */
  const restore = async () => {
    application = await restoreFromCache(
      application,
      (restored) => restored.register("stimeo--submit-once", SubmitOnceController),
      () => vi.advanceTimersByTimeAsync(0),
    );
  };

  it("puts back the labels a page restored mid-submission still shows", async () => {
    await mountWrapped(
      'data-stimeo--submit-once-busy-label-value="Working"',
      `<button id="send" type="submit">Send</button>
       <input id="input-submit" type="submit" value="Go">`,
    );
    turboStart(control("#send"));

    await restore();

    expect(control("#send").textContent).toBe("Send");
    expect(control("#send").hasAttribute("data-stimeo--submit-once-label")).toBe(false);
  });

  it("puts back an input's label on a page restored mid-submission", async () => {
    await mountWrapped(
      'data-stimeo--submit-once-busy-label-value="Working"',
      '<input id="input-submit" type="submit" value="Go">',
    );
    turboStart(control("#input-submit"));
    expect((control("#input-submit") as HTMLInputElement).value).toBe("Working");

    await restore();

    expect((control("#input-submit") as HTMLInputElement).value).toBe("Go");
  });

  it.each(["button", "input"])(
    "puts back an external %s submitter's label on a restored page",
    async (kind) => {
      await mountWrapped('data-stimeo--submit-once-busy-label-value="Working"', "");
      document.body.insertAdjacentHTML(
        "beforeend",
        kind === "button"
          ? '<button id="external-send" type="submit" form="form">Send outside</button>'
          : '<input id="external-send" type="submit" form="form" value="Send outside">',
      );
      const submitter = control("#external-send");
      turboStart(submitter);
      expect(submitter.disabled).toBe(true);
      expect(submitter instanceof HTMLInputElement ? submitter.value : submitter.textContent).toBe(
        "Working",
      );

      await restore();

      const copied = control("#external-send");
      expect(copied instanceof HTMLInputElement ? copied.value : copied.textContent).toBe(
        "Send outside",
      );
      expect(copied.hasAttribute("data-stimeo--submit-once-label")).toBe(false);
      expect(copied.disabled).toBe(false);
    },
  );

  it.each(["button", "input"])(
    "keeps a consumer's %s label on a restored page after a busy-label write",
    async (kind) => {
      await mountWrapped(
        'data-stimeo--submit-once-busy-label-value="Working"',
        kind === "button"
          ? '<button id="send" type="submit" data-submit-once-busy-label="Sending">Send</button>'
          : '<input id="send" type="submit" data-submit-once-busy-label="Sending" value="Send">',
      );
      const submitter = control("#send");
      turboStart(submitter);
      expect(submitter instanceof HTMLInputElement ? submitter.value : submitter.textContent).toBe(
        "Sending",
      );
      if (submitter instanceof HTMLInputElement) submitter.value = "Author revised";
      else submitter.textContent = "Author revised";

      await restore();

      const copied = control("#send");
      expect(copied instanceof HTMLInputElement ? copied.value : copied.textContent).toBe(
        "Author revised",
      );
      expect(copied.hasAttribute("data-stimeo--submit-once-label")).toBe(false);
    },
  );

  it("reports the forms a page restored mid-submission still marks submitting", async () => {
    await mountWrapped("", '<button id="send" type="submit">Send</button>');
    turboStart(control("#send"));
    const reports: Array<{ forms: HTMLFormElement[] }> = [];
    document.addEventListener("stimeo--submit-once:reconcile", (e) =>
      reports.push((e as CustomEvent).detail),
    );

    await restore();

    // `end` would claim the submission resolved; its request died with the page.
    expect(reports.map(({ forms }) => forms.map((f) => f.id))).toEqual([["form"]]);
    expect(reports[0]?.forms[0]).toBe(form());
  });

  it("stays silent on a restored page with no submission in flight", async () => {
    await mountWrapped("", '<button id="send" type="submit">Send</button>');
    turboStart(control("#send"));
    turboEnd();
    const reports: unknown[] = [];
    document.addEventListener("stimeo--submit-once:reconcile", (e) =>
      reports.push((e as CustomEvent).detail),
    );

    await restore();

    expect(reports).toEqual([]);
  });

  it("leaves the label record of a nested instance's form to that instance", async () => {
    document.body.innerHTML = `
      <div id="root" data-controller="stimeo--submit-once">
        <div data-controller="stimeo--submit-once">
          <form id="inner"><button id="inner-send" type="submit" data-stimeo--submit-once-label='["Kept","Busy"]'>Busy</button></form>
        </div>
      </div>`;
    await startApplication();

    // The inner instance owns the form and gives its own record back.
    expect(control("#inner-send").textContent).toBe("Kept");
  });

  it("leaves a nested instance's label alone while that instance is still submitting", async () => {
    document.body.innerHTML = `
      <div id="root">
        <div data-controller="stimeo--submit-once" data-stimeo--submit-once-busy-label-value="Working">
          <form id="inner"><button id="inner-send" type="submit">Send</button></form>
        </div>
      </div>`;
    await startApplication();
    turboStart(control("#inner-send"), query<HTMLFormElement>("#inner"));
    expect(control("#inner-send").textContent).toBe("Working");

    // An outer instance connects while the inner submission is still in flight.
    query<HTMLElement>("#root").setAttribute("data-controller", "stimeo--submit-once");
    await vi.advanceTimersByTimeAsync(0);

    expect(control("#inner-send").textContent).toBe("Working");
  });

  it.each(["{", "5", '"Send"', '["Send"]', '["Send",5]', '[5,"Busy"]'])(
    "keeps a control's label when its record is malformed: %s",
    async (record) => {
      await mountWrapped("", `<button id="malformed" type="submit">Busy</button>`);
      control("#malformed").setAttribute("data-stimeo--submit-once-label", record);
      await restore();
      expect(control("#malformed").textContent).toBe("Busy");
      expect(control("#malformed").hasAttribute("data-stimeo--submit-once-label")).toBe(false);
    },
  );

  it("reports a form it is mounted on that a restored page still marks submitting", async () => {
    await mount("", '<button id="send" type="submit">Send</button>');
    turboStart(control("#send"));
    const reports: Array<{ forms: HTMLFormElement[] }> = [];
    document.addEventListener("stimeo--submit-once:reconcile", (e) =>
      reports.push((e as CustomEvent).detail),
    );

    await restore();

    // happy-dom binds a form host twice, so only the forms named are asserted, not the count.
    expect(reports.length).toBeGreaterThan(0);
    for (const { forms } of reports) expect(forms).toEqual([form()]);
  });

  it("gives a page restored mid-submission the authored disabled, aria-busy, data-submitting, aria-label and hidden back", async () => {
    await mountWrapped(
      'data-stimeo--submit-once-busy-label-value="Working"',
      `<button id="send" type="submit" aria-label="Send now" aria-busy="false">
         <span id="idle" data-stimeo--submit-once-target="idle">Send</span>
         <span id="busy" data-stimeo--submit-once-target="busy" hidden>Sending</span>
       </button>
       <button id="other" type="submit">Other</button>`,
    );
    form().setAttribute("aria-busy", "false");
    turboStart(control("#send"));
    expect(control("#send").disabled).toBe(true);
    expect(control("#send").getAttribute("aria-label")).toBe("Working");
    expect(query("#busy").hidden).toBe(false);

    await restore();

    const records = [form(), control("#send"), control("#other"), query("#idle"), query("#busy")]
      .flatMap((element) => element.getAttributeNames())
      .filter((name) => name.endsWith("-lease"));
    expect(control("#send").hasAttribute("disabled")).toBe(false);
    expect(control("#other").hasAttribute("disabled")).toBe(false);
    expect(control("#send").getAttribute("aria-busy")).toBe("false");
    expect(control("#other").hasAttribute("aria-busy")).toBe(false);
    expect(control("#send").getAttribute("aria-label")).toBe("Send now");
    expect(form().getAttribute("aria-busy")).toBe("false");
    expect(form().hasAttribute("data-submitting")).toBe(false);
    expect(query("#idle").hidden).toBe(false);
    expect(query("#busy").hidden).toBe(true);
    expect(records).toEqual([]);

    // The next submission runs from the author's values.
    turboStart(control("#send"));
    expect(control("#send").disabled).toBe(true);
    turboEnd();
    expect(control("#send").disabled).toBe(false);
    expect(control("#send").getAttribute("aria-label")).toBe("Send now");
  });

  /** What Turbo does before `turbo:submit-start`: disable the submitter, mark the form busy. */
  const turboRequestStarted = (submitter: SubmitControl) => {
    submitter.disabled = true;
    submitter.form?.setAttribute("aria-busy", "true");
    turboStart(submitter);
  };

  it("enables the submitter Turbo disabled on a copy taken mid-submission, and clears the busy form", async () => {
    await mountWrapped("", '<button id="send" type="submit">Send</button>');
    turboRequestStarted(control("#send"));
    expect(control("#send").hasAttribute("data-stimeo--submit-once-submitter")).toBe(true);

    await restore();

    expect(control("#send").disabled).toBe(false);
    expect(control("#send").hasAttribute("data-stimeo--submit-once-submitter")).toBe(false);
    expect(form().hasAttribute("aria-busy")).toBe(false);
    expect(form().hasAttribute("data-submitting")).toBe(false);
  });

  it("enables it on a copy taken after the controller left the document too, and reports the form", async () => {
    await mountWrapped("", '<button id="send" type="submit">Send</button>');
    turboRequestStarted(control("#send"));
    const reports: Array<{ forms: HTMLFormElement[] }> = [];
    document.addEventListener("stimeo--submit-once:reconcile", (e) =>
      reports.push((e as CustomEvent).detail),
    );

    // A visit takes the page out of the document first and copies it afterwards.
    const left = query("#root");
    left.remove();
    disconnectAndStopApplication(application);
    document.body.replaceChildren(left.cloneNode(true));
    await startApplication();

    expect(control("#send").disabled).toBe(false);
    expect(form().hasAttribute("aria-busy")).toBe(false);
    expect(reports.map(({ forms }) => forms)).toEqual([[form()]]);
  });

  it("enables a submitter Turbo marked aria-disabled on a copy taken mid-submission", async () => {
    await mountWrapped("", '<button id="send" type="submit">Send</button>');
    const send = control("#send");
    send.setAttribute("aria-disabled", "true");
    turboStart(send);

    await restore();

    expect(control("#send").hasAttribute("aria-disabled")).toBe(false);
  });

  it("leaves an authored disabled control and aria-busy alone on a copy with no submission", async () => {
    await mountWrapped(
      "",
      '<button id="send" type="submit">Send</button><button id="off" type="submit" disabled>Off</button>',
    );
    form().setAttribute("aria-busy", "true");

    await restore();

    expect(control("#off").disabled).toBe(true);
    expect(form().getAttribute("aria-busy")).toBe("true");
  });

  it("reports the form it gives back once, after the attributes are back", async () => {
    await mountWrapped("", '<button id="send" type="submit">Send</button>');
    turboStart(control("#send"));
    const seen: Array<{ submitting: boolean; disabled: boolean }> = [];
    document.addEventListener("stimeo--submit-once:reconcile", () =>
      seen.push({
        submitting: form().hasAttribute("data-submitting"),
        disabled: control("#send").disabled,
      }),
    );

    await restore();

    expect(seen).toEqual([{ submitting: false, disabled: false }]);
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
