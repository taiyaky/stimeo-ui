import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SwitchController } from "../src/controllers/switch_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link SwitchController}: host/default reconciliation,
 * click and keyboard activation, disabled semantics, Turbo retained-element
 * morphs, and `changed` notification.
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

  it("dispatches changed with both checked states", () => {
    const received: boolean[] = [];
    sw().addEventListener("stimeo--switch:changed", (event) => {
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
    sw().addEventListener("stimeo--switch:changed", (event) => {
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
    const changed: boolean[] = [];
    sw().addEventListener("stimeo--switch:changed", (event) => {
      changed.push((event as CustomEvent<{ checked: boolean }>).detail.checked);
    });

    sw().removeAttribute("role");
    sw().removeAttribute("aria-checked");
    sw().removeAttribute("tabindex");
    await tick();

    expect(sw().getAttribute("role")).toBe("switch");
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(sw().getAttribute("tabindex")).toBe("0");
    expect(changed).toEqual([]);

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
});
