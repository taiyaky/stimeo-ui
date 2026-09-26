import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SwitchController } from "../src/controllers/switch_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureFieldCommits } from "./helpers/field_commits";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents, type StateEventCapture } from "./helpers/state_events";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link SwitchController}: host/default reconciliation,
 * click and keyboard activation, disabled semantics, Turbo retained-element
 * morphs, and the `change` / `reconcile` notifications.
 */
describe("SwitchController", () => {
  let application: Application;

  const mount = async (markup: string): Promise<void> => {
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--switch", SwitchController);
    await tick();
  };

  const genericMarkup = ({ wrapper = "", attrs = "" } = {}): string => `
    ${wrapper}
      <div data-controller="stimeo--switch"
           data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown"
           ${attrs}>Notifications</div>
    ${wrapper ? "</div>" : ""}`;

  beforeEach(async () => {
    await mount(genericMarkup({ attrs: 'role="switch" tabindex="0" aria-checked="false"' }));
  });

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const sw = (): HTMLElement => {
    const element = document.querySelector<HTMLElement>("[data-controller='stimeo--switch']");
    if (!element) throw new Error("switch not found");
    return element;
  };

  const instance = (): SwitchController =>
    application.getControllerForElementAndIdentifier(sw(), "stimeo--switch") as SwitchController;

  const key = (value: string, options: { repeat?: boolean } = {}): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", {
      key: value,
      repeat: options.repeat,
      bubbles: true,
      cancelable: true,
    });
    sw().dispatchEvent(event);
    return event;
  };

  const click = (): MouseEvent => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    sw().dispatchEvent(event);
    return event;
  };

  it("adds role, checked state, and a Tab stop to a bare generic host", async () => {
    await mount(genericMarkup());

    expect(sw().getAttribute("role")).toBe("switch");
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(sw().getAttribute("tabindex")).toBe("0");
  });

  it("preserves authored role, checked state, and tabindex", async () => {
    await mount(genericMarkup({ attrs: 'role="checkbox" aria-checked="true" tabindex="-1"' }));

    expect(sw().getAttribute("role")).toBe("checkbox");
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(sw().getAttribute("tabindex")).toBe("-1");
  });

  it("does not add tabindex to a native button host", async () => {
    await mount(`
      <button type="button" data-controller="stimeo--switch"
              data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown">
        Notifications
      </button>`);

    expect(sw().getAttribute("role")).toBe("switch");
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(sw().hasAttribute("tabindex")).toBe(false);
  });

  it("keeps the canonical button from submitting an enclosing form", async () => {
    await mount(
      '<form><button type="button" data-controller="stimeo--switch" ' +
        'data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown">' +
        "Notifications</button></form>",
    );
    let submits = 0;
    document.querySelector("form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      submits += 1;
    });

    sw().click();

    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(submits).toBe(0);
  });

  it("toggles aria-checked in both directions on click", () => {
    sw().click();
    expect(sw().getAttribute("aria-checked")).toBe("true");
    sw().click();
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("dispatches change with both checked states", () => {
    const received: boolean[] = [];
    sw().addEventListener("stimeo--switch:change", (event) => {
      received.push((event as CustomEvent<{ checked: boolean }>).detail.checked);
    });

    sw().click();
    sw().click();
    expect(received).toEqual([true, false]);
  });

  it.each([" ", "Enter"])("toggles on %s and prevents its native default", (value) => {
    const event = key(value);

    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(event.defaultPrevented).toBe(true);
  });

  it("prevents repeated Space without toggling", () => {
    const event = key(" ", { repeat: true });

    expect(event.defaultPrevented).toBe(true);
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("leaves an unrelated key untouched", () => {
    const event = key("ArrowRight");

    expect(event.defaultPrevented).toBe(false);
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("yields a key a descendant widget already consumed", () => {
    const inner = document.createElement("span");
    sw().append(inner);
    inner.addEventListener("keydown", (event) => event.preventDefault());

    const claimed = new KeyboardEvent("keydown", {
      key: " ",
      bubbles: true,
      cancelable: true,
    });
    const notCanceled = inner.dispatchEvent(claimed);

    expect(notCanceled).toBe(false);
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("leaves an initial native-button key to the browser and cancels repeats", async () => {
    await mount(`
      <button type="button" data-controller="stimeo--switch"
              data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown"
              role="switch" aria-checked="false">Notifications</button>`);

    const initial = key("Enter");
    const repeatedEnter = key("Enter", { repeat: true });
    const repeatedSpace = key(" ", { repeat: true });

    expect(initial.defaultPrevented).toBe(false);
    expect(repeatedEnter.defaultPrevented).toBe(true);
    expect(repeatedSpace.defaultPrevented).toBe(true);
    // dispatchEvent does not synthesize the browser-owned click in happy-dom.
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("blocks every activation path when the switch itself is aria-disabled", async () => {
    await mount(
      genericMarkup({
        attrs: 'role="switch" aria-checked="false" tabindex="0" aria-disabled="true"',
      }),
    );
    const received: boolean[] = [];
    let downstreamClicks = 0;
    let downstreamKeys = 0;
    sw().addEventListener("stimeo--switch:change", (event) => {
      received.push((event as CustomEvent<{ checked: boolean }>).detail.checked);
    });
    sw().addEventListener("click", () => {
      downstreamClicks += 1;
    });
    sw().addEventListener("keydown", () => {
      downstreamKeys += 1;
    });

    expect(click().defaultPrevented).toBe(true);
    expect(key(" ").defaultPrevented).toBe(true);
    expect(key("Enter").defaultPrevented).toBe(true);
    instance().toggle();

    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(received).toEqual([]);
    expect(downstreamClicks).toBe(0);
    expect(downstreamKeys).toBe(0);
    expect(sw().getAttribute("tabindex")).toBe("0");
  });

  it("inherits aria-disabled from an ancestor", async () => {
    await mount(
      genericMarkup({
        wrapper: '<div aria-disabled="true">',
        attrs: 'role="switch" aria-checked="false" tabindex="0"',
      }),
    );

    expect(click().defaultPrevented).toBe(true);
    expect(key(" ").defaultPrevented).toBe(true);
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("blocks a natively disabled button", async () => {
    await mount(`
      <button type="button" disabled data-controller="stimeo--switch"
              data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown"
              role="switch" aria-checked="false">Notifications</button>`);

    // A disabled native button does not dispatch click in a real browser; the
    // direct action call pins the controller's own defensive boundary as well.
    instance().toggle();
    expect(key("Enter").defaultPrevented).toBe(true);
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("blocks a button disabled by its fieldset", async () => {
    await mount(`
      <fieldset disabled>
        <button type="button" data-controller="stimeo--switch"
                data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown"
                role="switch" aria-checked="false">Notifications</button>
      </fieldset>`);

    expect(click().defaultPrevented).toBe(true);
    expect(key("Enter").defaultPrevented).toBe(true);
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("honors the first direct-child legend exception for a disabled fieldset", async () => {
    await mount(`
      <fieldset disabled>
        <legend>
          <button type="button" data-controller="stimeo--switch"
                  data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown"
                  role="switch" aria-checked="false">Notifications</button>
        </legend>
      </fieldset>`);

    expect(click().defaultPrevented).toBe(false);
    expect(sw().getAttribute("aria-checked")).toBe("true");
  });

  it("keeps walking after an inner legend exemption to find a disabled outer fieldset", async () => {
    await mount(`
      <fieldset disabled>
        <div>
          <fieldset disabled>
            <legend>
              <button type="button" data-controller="stimeo--switch"
                      data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown"
                      role="switch" aria-checked="false">Notifications</button>
            </legend>
          </fieldset>
        </div>
      </fieldset>`);

    expect(click().defaultPrevented).toBe(true);
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("does not apply fieldset disabledness to a generic host", async () => {
    await mount(`<fieldset disabled>${genericMarkup()}</fieldset>`);

    expect(click().defaultPrevented).toBe(false);
    expect(sw().getAttribute("aria-checked")).toBe("true");
  });

  it.each([
    `<a href="/account" data-controller="stimeo--switch"
        data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown"
        role="switch" aria-checked="false">Notifications</a>`,
    `<button data-controller="stimeo--switch"
             data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown"
             role="switch" aria-checked="false">Notifications</button>`,
    `<label for="notifications" data-controller="stimeo--switch"
            data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown"
            role="switch" aria-checked="false">Notifications</label>`,
  ])("stands down completely on an unsupported native interactive host", async (markup) => {
    await mount(markup);

    expect(click().defaultPrevented).toBe(false);
    expect(key("Enter").defaultPrevented).toBe(false);
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("does not seed switch attributes onto an unsupported input host", async () => {
    await mount(`
      <input type="checkbox" data-controller="stimeo--switch"
             data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown">`);

    expect(sw().hasAttribute("role")).toBe(false);
    expect(sw().hasAttribute("aria-checked")).toBe(false);
    expect(sw().hasAttribute("tabindex")).toBe(false);
  });

  it("stands down in an inherited editing host until a false boundary is authored", async () => {
    await mount(genericMarkup({ wrapper: '<div id="editing-host" contenteditable="true">' }));

    expect(sw().hasAttribute("role")).toBe(false);
    expect(click().defaultPrevented).toBe(false);

    document.querySelector("#editing-host")?.removeAttribute("contenteditable");
    await tick();

    expect(sw().getAttribute("role")).toBe("switch");
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(sw().getAttribute("tabindex")).toBe("0");

    document.querySelector("#editing-host")?.setAttribute("contenteditable", "true");
    await tick();
    sw().click();
    expect(sw().hasAttribute("role")).toBe(false);
    expect(sw().hasAttribute("aria-checked")).toBe(false);
    expect(sw().hasAttribute("tabindex")).toBe(false);

    sw().setAttribute("contenteditable", "false");
    await tick();

    sw().click();
    expect(sw().getAttribute("aria-checked")).toBe("true");
  });

  it("removes only controller-owned defaults when a retained host becomes interactive", async () => {
    await mount(`
      <a data-controller="stimeo--switch"
         data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown">
        Notifications
      </a>`);
    expect(sw().getAttribute("role")).toBe("switch");
    sw().click();
    await tick();
    expect(sw().getAttribute("aria-checked")).toBe("true");

    sw().setAttribute("href", "/settings");
    await tick();

    expect(sw().hasAttribute("role")).toBe(false);
    expect(sw().hasAttribute("aria-checked")).toBe(false);
    expect(sw().hasAttribute("tabindex")).toBe(false);
    expect(click().defaultPrevented).toBe(false);

    sw().removeAttribute("href");
    await tick();
    expect(sw().getAttribute("role")).toBe("switch");
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(sw().getAttribute("tabindex")).toBe("0");
  });

  it("preserves authored attributes when a retained host becomes interactive", async () => {
    await mount(`
      <a data-controller="stimeo--switch"
         data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown">
        Notifications
      </a>`);

    sw().setAttribute("role", "checkbox");
    sw().setAttribute("aria-checked", "true");
    sw().setAttribute("tabindex", "-1");
    await tick();

    sw().setAttribute("href", "/settings");
    await tick();

    expect(sw().getAttribute("role")).toBe("checkbox");
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(sw().getAttribute("tabindex")).toBe("-1");
  });

  it("reconciles defaults when a retained button becomes a supported host", async () => {
    await mount(
      '<button data-controller="stimeo--switch" ' +
        'data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown">' +
        "Notifications</button>",
    );
    expect(sw().hasAttribute("role")).toBe(false);

    sw().setAttribute("type", "button");
    await tick();

    expect(sw().getAttribute("role")).toBe("switch");
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(sw().hasAttribute("tabindex")).toBe(false);
  });

  it("reconciles missing defaults after a retained-element attribute morph", async () => {
    const events = captureStateEvents("stimeo--switch", ["change", "reconcile"]);

    sw().removeAttribute("role");
    sw().removeAttribute("aria-checked");
    sw().removeAttribute("tabindex");
    await tick();

    expect(sw().getAttribute("role")).toBe("switch");
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(sw().getAttribute("tabindex")).toBe("0");
    // The switch was off and the default puts it back off: nothing moved.
    expect(events.names()).toEqual([]);
    events.stop();

    // The observer must re-arm after writing the first batch of defaults.
    sw().removeAttribute("aria-checked");
    await tick();
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("preserves authored values introduced by a retained-element attribute morph", async () => {
    sw().setAttribute("role", "checkbox");
    sw().setAttribute("aria-checked", "mixed");
    sw().setAttribute("tabindex", "-1");
    await tick();

    expect(sw().getAttribute("role")).toBe("checkbox");
    expect(sw().getAttribute("aria-checked")).toBe("mixed");
    expect(sw().getAttribute("tabindex")).toBe("-1");
  });

  it("has no machine-detectable a11y violations in either state", async () => {
    await expectNoA11yViolations(sw());
    sw().click();
    await expectNoA11yViolations(sw());
  });

  it("announces role, name, and checked state before and after a toggle", async () => {
    const before = await captureSpeech({ container: sw(), steps: 0 });
    expect(before).toEqual(["switch, Notifications, not checked"]);

    sw().click();
    const after = await captureSpeech({ container: sw(), steps: 0 });
    expect(after).toEqual(["switch, Notifications, checked"]);
  });

  it("becomes inert and stops observing after disconnect", async () => {
    sw().click();
    expect(sw().getAttribute("aria-checked")).toBe("true");

    application.unload("stimeo--switch");
    sw().removeAttribute("role");
    sw().removeAttribute("tabindex");
    await tick();
    sw().setAttribute("aria-disabled", "true");
    let downstreamClicks = 0;
    sw().addEventListener("click", () => {
      downstreamClicks += 1;
    });
    const disconnectedClick = click();

    expect(sw().hasAttribute("role")).toBe(false);
    expect(sw().hasAttribute("tabindex")).toBe(false);
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(disconnectedClick.defaultPrevented).toBe(false);
    expect(downstreamClicks).toBe(1);
  });

  // --- Hidden form field ---

  describe("hidden form field", () => {
    let commits: ReturnType<typeof captureFieldCommits>;

    const withField = async (checked = "false") => {
      await mount(`
        <button type="button" data-controller="stimeo--switch"
                data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown"
                role="switch" aria-checked="${checked}">
          Notifications
          <input type="hidden" name="notify" data-stimeo--switch-target="field" />
        </button>`);
    };

    const field = () =>
      document.querySelector<HTMLInputElement>(
        "[data-stimeo--switch-target='field']",
      ) as HTMLInputElement;

    beforeEach(() => {
      commits = captureFieldCommits();
    });

    afterEach(() => {
      commits.stop();
    });

    it("seeds the field from aria-checked without reporting a commit", async () => {
      await withField("true");

      expect(field().value).toBe("true");
      expect(commits.seen).toEqual([]);
    });

    it("writes and reports once per toggle the user made", async () => {
      await withField();
      commits.clear();

      sw().click();

      expect(field().value).toBe("true");
      expect(commits.seen).toEqual([field()]);

      sw().click();
      expect(field().value).toBe("false");
      expect(commits.seen).toEqual([field(), field()]);
    });

    it("submits from inside the button host", async () => {
      await mount(`
        <form id="prefs">
          <button type="button" data-controller="stimeo--switch"
                  data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown"
                  role="switch" aria-checked="false">
            Notifications
            <input type="hidden" name="notify" data-stimeo--switch-target="field" />
          </button>
        </form>`);
      const form = document.getElementById("prefs") as HTMLFormElement;

      // The claim is that a hidden input inside a <button> is still a submitted
      // control — reading the attributes back would only restate the fixture.
      expect(new FormData(form).get("notify")).toBe("false");

      sw().click();

      expect(new FormData(form).get("notify")).toBe("true");
    });
  });

  // --- Page-driven moves ---

  /**
   * `change` is the user's toggle; a checked state the page moves — a morph that
   * writes or strips `aria-checked`, a host that stops supporting the switch —
   * is `reconcile`, once per batch and never on connect.
   */
  describe("page-driven moves", () => {
    let events: StateEventCapture;
    let commits: ReturnType<typeof captureFieldCommits>;

    /** A native button host; `state` is its authored `aria-checked`, if any. */
    const withField = async (state: string | null = "false") => {
      await mount(`
        <button type="button" data-controller="stimeo--switch"
                data-action="click->stimeo--switch#toggle keydown->stimeo--switch#onKeydown"
                ${state === null ? "" : `role="switch" aria-checked="${state}"`}>
          Notifications
          <input type="hidden" name="notify" data-stimeo--switch-target="field" />
        </button>`);
    };

    const field = () =>
      document.querySelector<HTMLInputElement>(
        "[data-stimeo--switch-target='field']",
      ) as HTMLInputElement;

    const heard = () => events.seen.map(({ name, detail }) => ({ name, detail }));

    /**
     * Wraps a listener that must act once. happy-dom removes a `once` listener
     * only after it returns, so a listener that makes the same event fire again
     * would be called a second time from inside the first call.
     */
    const firstCallOnly = (act: () => void) => {
      let spent = false;
      return (): void => {
        if (spent) return;
        spent = true;
        act();
      };
    };

    const detach: Array<() => void> = [];

    /** Adds a document listener this block removes after the test. */
    const listenOnDocument = (type: string, listener: () => void): void => {
      document.addEventListener(type, listener);
      detach.push(() => document.removeEventListener(type, listener));
    };

    beforeEach(() => {
      events = captureStateEvents("stimeo--switch", ["change", "reconcile"]);
      commits = captureFieldCommits();
    });

    afterEach(() => {
      events.stop();
      commits.stop();
      for (const off of detach.splice(0)) off();
    });

    it("reports a morph that writes a new checked state as reconcile, never as change", async () => {
      await withField("false");

      sw().setAttribute("aria-checked", "true");
      await tick();

      expect(heard()).toEqual([{ name: "reconcile", detail: { checked: true } }]);
      expect(field().value).toBe("true");
      // The field follows without the native change a form reads as an edit.
      expect(commits.seen).toEqual([]);
    });

    it("reports a stripped checked state that falls back to the off default", async () => {
      await withField("true");

      sw().removeAttribute("aria-checked");
      await tick();

      expect(sw().getAttribute("aria-checked")).toBe("false");
      expect(heard()).toEqual([{ name: "reconcile", detail: { checked: false } }]);
      expect(field().value).toBe("false");
      expect(commits.seen).toEqual([]);
    });

    it("reports a host that stops supporting the switch as reconcile to off", async () => {
      await withField(null);
      sw().click();
      await tick();
      commits.clear();

      // The controller supplied `aria-checked`, so a host it stands down on
      // takes that state away and the submitted value goes back to off.
      sw().setAttribute("type", "submit");
      await tick();

      expect(sw().hasAttribute("aria-checked")).toBe(false);
      expect(field().value).toBe("false");
      expect(heard()).toEqual([
        { name: "change", detail: { checked: true } },
        { name: "reconcile", detail: { checked: false } },
      ]);
      expect(commits.seen).toEqual([]);

      // Supported again, the off default describes the state it already reported.
      sw().setAttribute("type", "button");
      await tick();
      expect(sw().getAttribute("aria-checked")).toBe("false");
      expect(heard()).toHaveLength(2);
    });

    it("does not report a pass that leaves the checked state where it was", async () => {
      await withField("true");

      sw().removeAttribute("role");
      await tick();
      sw().setAttribute("aria-checked", "true");
      await tick();
      expect(heard()).toEqual([]);

      sw().setAttribute("aria-checked", "false");
      await tick();
      events.clear();
      // A token the switch does not read as on leaves it off.
      sw().setAttribute("aria-checked", "mixed");
      await tick();

      expect(heard()).toEqual([]);
      expect(field().value).toBe("false");
    });

    it("reports nothing on connect, or when it connects again to a state moved while away", async () => {
      await withField("true");
      expect(field().value).toBe("true");

      const host = sw();
      host.removeAttribute("data-controller");
      await tick();
      host.setAttribute("aria-checked", "false");
      host.setAttribute("data-controller", "stimeo--switch");
      await tick();

      expect(field().value).toBe("false");
      expect(heard()).toEqual([]);
      expect(commits.seen).toEqual([]);

      // The state read on connect is the one the next move is measured from.
      host.setAttribute("aria-checked", "true");
      await tick();
      expect(heard()).toEqual([{ name: "reconcile", detail: { checked: true } }]);
    });

    it("reports the user's toggle as change only", async () => {
      await withField("false");

      sw().click();
      await tick();

      expect(heard()).toEqual([{ name: "change", detail: { checked: true } }]);
      expect(commits.seen).toEqual([field()]);
    });

    it("seeds a field that replaces the old one without reporting", async () => {
      await withField("true");

      // Only the field changes, so the target callback alone brings the pass.
      const replacement = document.createElement("input");
      replacement.type = "hidden";
      replacement.name = "notify";
      replacement.setAttribute("data-stimeo--switch-target", "field");
      field().replaceWith(replacement);
      await tick();

      expect(replacement.value).toBe("true");
      expect(heard()).toEqual([]);
      expect(commits.seen).toEqual([]);
    });

    it("reports one batch of page changes once, with the state it settles on", async () => {
      await withField("false");

      sw().setAttribute("aria-checked", "true");
      sw().removeAttribute("aria-checked");
      sw().setAttribute("aria-checked", "true");
      const replacement = document.createElement("input");
      replacement.type = "hidden";
      replacement.name = "notify";
      replacement.setAttribute("data-stimeo--switch-target", "field");
      field().replaceWith(replacement);
      await tick();

      expect(heard()).toEqual([{ name: "reconcile", detail: { checked: true } }]);
      expect(replacement.value).toBe("true");
      expect(commits.seen).toEqual([]);
    });

    it("keeps a toggle made inside a reconcile listener a change, and reports nothing after it", async () => {
      await withField("false");
      // Registered after the capture, so the recording keeps dispatch order.
      listenOnDocument(
        "stimeo--switch:reconcile",
        firstCallOnly(() => instance().toggle()),
      );

      sw().setAttribute("aria-checked", "true");
      await tick();
      await tick();

      expect(heard()).toEqual([
        { name: "reconcile", detail: { checked: true } },
        { name: "change", detail: { checked: false } },
      ]);
      expect(sw().getAttribute("aria-checked")).toBe("false");
      expect(field().value).toBe("false");
      expect(commits.seen).toEqual([field()]);
    });

    it("reports a state a reconcile listener writes back with a second reconcile", async () => {
      await withField("false");
      // The listener writes the attribute the way a page script does, not through
      // toggle, so only observation can bring it to a pass.
      listenOnDocument(
        "stimeo--switch:reconcile",
        firstCallOnly(() => sw().setAttribute("aria-checked", "false")),
      );

      sw().setAttribute("aria-checked", "true");
      await tick();
      await tick();

      // Observation resumes before the report, so the listener's write is a page
      // change of its own: the next pass reports it and the field follows it.
      expect(heard()).toEqual([
        { name: "reconcile", detail: { checked: true } },
        { name: "reconcile", detail: { checked: false } },
      ]);
      expect(field().value).toBe("false");
      expect(commits.seen).toEqual([]);
    });

    it("reports a state a listener moves during the user's commit as reconcile", async () => {
      await withField("false");
      // The native change comes first; a page script that answers it by writing
      // the attribute back has moved the state after the user did.
      field().addEventListener(
        "change",
        firstCallOnly(() => sw().setAttribute("aria-checked", "false")),
      );

      sw().click();
      await tick();

      expect(heard()).toEqual([
        { name: "change", detail: { checked: true } },
        { name: "reconcile", detail: { checked: false } },
      ]);
      expect(field().value).toBe("false");
    });

    it("keeps a toggle made inside a native change listener from being reported again", async () => {
      await withField("false");
      field().addEventListener(
        "change",
        firstCallOnly(() => instance().toggle()),
      );

      sw().click();
      await tick();

      expect(events.names()).toEqual(["change", "change"]);
      expect(sw().getAttribute("aria-checked")).toBe("false");
    });

    it("drops a pass queued before disconnect", async () => {
      await withField("false");

      instance().fieldTargetConnected();
      sw().setAttribute("aria-checked", "true");
      instance().disconnect();
      await tick();

      expect(heard()).toEqual([]);
      expect(field().value).toBe("false");
    });

    it("treats a state the page writes before a queued pass runs as authored", async () => {
      await mount(genericMarkup());
      expect(sw().getAttribute("aria-checked")).toBe("false");

      // A pass is already queued when the page writes the attribute, so the pass
      // meets the page's record before the observer delivers it.
      instance().fieldTargetConnected();
      sw().setAttribute("aria-checked", "true");
      await tick();
      expect(heard()).toEqual([{ name: "reconcile", detail: { checked: true } }]);

      // A host the switch stands down on gives back only what the controller
      // supplied; the page's own state stays.
      sw().setAttribute("contenteditable", "true");
      await tick();
      expect(sw().hasAttribute("role")).toBe(false);
      expect(sw().getAttribute("aria-checked")).toBe("true");
    });
  });
});
