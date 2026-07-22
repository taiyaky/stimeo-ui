import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PopoverController } from "../src/controllers/popover_controller";
import { EscapeLayer } from "../src/utils/escape_layer";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link PopoverController}: the modeless dialog contract —
 * toggle + ARIA sync, focus-into-panel on open, Escape restoration, modeless
 * outside-click/Tab dismissal, indeterminate focusout handling, and teardown.
 */
describe("PopoverController", () => {
  let application: Application;

  const defaultPanelInner = `
    <label id="label" for="field">Name</label>
    <input id="field" type="text" />
    <span id="padding">Panel padding</span>
    <button id="done" data-action="click->stimeo--popover#close">Done</button>`;

  const start = async (panelInner = defaultPanelInner, closeOnScroll = false) => {
    const value = closeOnScroll ? ' data-stimeo--popover-close-on-scroll-value="true"' : "";
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--popover"${value}>
          <button id="open" data-action="click->stimeo--popover#open">Open directly</button>
          <button id="trigger" data-stimeo--popover-target="trigger"
                  aria-haspopup="dialog" aria-expanded="false" aria-controls="pop"
                  data-action="click->stimeo--popover#toggle">Edit profile</button>
          <div id="pop" data-stimeo--popover-target="panel" role="dialog"
               aria-label="Edit profile" hidden>${panelInner}</div>
        </div>
        <button id="outside">Outside</button>
      </main>`;
    application = Application.start();
    application.register("stimeo--popover", PopoverController);
    await tick();
  };

  beforeEach(() => start());

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const trigger = () => query<HTMLButtonElement>("#trigger");
  const panel = () => query("#pop");
  const controller = (): PopoverController => {
    const instance = application.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--popover']"),
      "stimeo--popover",
    );
    if (!(instance instanceof PopoverController)) throw new Error("Popover controller not found");
    return instance;
  };

  it("starts closed with the collapsed ARIA state", () => {
    expect(panel().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles open on trigger click and focuses the first focusable element", () => {
    trigger().click();
    expect(panel().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(query("#pop input"));
  });

  it("toggles closed on a second trigger click", () => {
    trigger().click();
    trigger().click();
    expect(panel().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("binds the public open and close actions", () => {
    query<HTMLButtonElement>("#open").click();
    expect(panel().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    query<HTMLButtonElement>("#done").click();
    expect(panel().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("focuses the panel itself when it has no focusable children", async () => {
    disconnectAndStopApplication(application);
    await start("<p>Just text</p>");
    trigger().click();
    expect(panel().getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(panel());
  });

  it("closes on Escape and restores focus to the trigger", () => {
    trigger().click();
    query<HTMLInputElement>("#field").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("consumes the Escape it owns", () => {
    trigger().click();
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    query<HTMLInputElement>("#field").dispatchEvent(event);
    // Owning the press marks it handled so outer layers skip the same Escape.
    expect(event.defaultPrevented).toBe(true);
    expect(panel().hidden).toBe(true);
  });

  it("ignores an Escape already handled by an inner layer", () => {
    trigger().click();
    const handled = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    query<HTMLInputElement>("#field").dispatchEvent(handled);
    expect(panel().hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("rescues Escape via the document fallback after focus fell to the body", () => {
    trigger().click();
    // A click on non-focusable panel content blurs the panel without a focusout
    // destination, so the popover stays open while focus sits on the body — the
    // press then starts outside the root and only the fallback can see it.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("yields the press to a newer document layer while focus sits on the body", () => {
    trigger().click();
    (document.activeElement as HTMLElement | null)?.blur();

    // A layer activated above the popover (e.g. a modal trap) owns the press;
    // this popover must stay transparent until that layer goes away.
    let aboveDismissed = 0;
    const above = new EscapeLayer();
    above.activate(document, { onDismiss: () => aboveDismissed++ });
    const first = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(aboveDismissed).toBe(1);
    expect(panel().hidden).toBe(false);

    above.deactivate();
    const second = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(true);
    expect(panel().hidden).toBe(true);
  });

  it("closes on an outside click without restoring focus", () => {
    trigger().click();
    query("#outside").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).not.toBe(trigger());
  });

  it("keeps open for label and non-focusable panel clicks after an indeterminate focusout", () => {
    trigger().click();
    const input = query<HTMLInputElement>("#field");

    for (const selector of ["#label", "#padding"]) {
      input.dispatchEvent(new FocusEvent("focusout", { relatedTarget: null, bubbles: true }));
      query(selector).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(panel().hidden).toBe(false);
    }
  });

  it("ignores focusout with no destination", () => {
    trigger().click();
    query<HTMLInputElement>("#field").dispatchEvent(
      new FocusEvent("focusout", { relatedTarget: null, bubbles: true }),
    );
    expect(panel().hidden).toBe(false);
  });

  it("closes when focus leaves the panel (Tab out) without restoring focus", () => {
    trigger().click();
    // focus moves to an element outside the controller → modeless close, no restore.
    const outside = query<HTMLButtonElement>("#outside");
    query<HTMLInputElement>("#field").dispatchEvent(
      new FocusEvent("focusout", { relatedTarget: outside, bubbles: true }),
    );
    expect(panel().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes after reverse focus traversal moves panel → trigger → outside", () => {
    trigger().click();
    query<HTMLInputElement>("#field").dispatchEvent(
      new FocusEvent("focusout", { relatedTarget: trigger(), bubbles: true }),
    );
    expect(panel().hidden).toBe(false);

    trigger().dispatchEvent(
      new FocusEvent("focusout", { relatedTarget: query("#outside"), bubbles: true }),
    );
    expect(panel().hidden).toBe(true);
  });

  it("removes the controller keydown listener on disconnect", () => {
    trigger().click();
    controller().disconnect();
    // An Escape after teardown must not throw or mutate anything further.
    query<HTMLInputElement>("#field").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(panel().hidden).toBe(false);
  });

  it("removes the document outside-click listener on disconnect", () => {
    trigger().click();
    controller().disconnect();
    query("#outside").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel().hidden).toBe(false);
  });

  it("removes the controller focusout listener when disconnected while open", () => {
    trigger().click();
    expect(panel().hidden).toBe(false);
    controller().disconnect();

    query<HTMLInputElement>("#field").dispatchEvent(
      new FocusEvent("focusout", { relatedTarget: query("#outside"), bubbles: true }),
    );
    // If the listener leaked it would have closed the (already detached) panel.
    expect(panel().hidden).toBe(false);
  });

  it("does not dismiss on scroll unless closeOnScroll is set", () => {
    trigger().click();
    expect(panel().hidden).toBe(false);
    window.dispatchEvent(new Event("scroll"));
    expect(panel().hidden).toBe(false);
  });

  it("dismisses on scroll when closeOnScroll is set (without restoring focus)", async () => {
    disconnectAndStopApplication(application);
    await start(defaultPanelInner, true);

    trigger().click();
    expect(panel().hidden).toBe(false);
    window.dispatchEvent(new Event("scroll"));
    expect(panel().hidden).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    // Closing on scroll must not yank focus back to the trigger (would fight scroll).
    expect(document.activeElement).not.toBe(trigger());
  });

  it("removes closeOnScroll listeners on disconnect", async () => {
    disconnectAndStopApplication(application);
    await start(defaultPanelInner, true);
    trigger().click();
    const instance = controller();
    const close = vi.spyOn(instance, "close");

    instance.disconnect();
    window.dispatchEvent(new Event("scroll"));

    expect(close).not.toHaveBeenCalled();
    expect(panel().hidden).toBe(false);
  });

  it("cleans up closeOnScroll before returning when the panel target was removed", async () => {
    disconnectAndStopApplication(application);
    await start(defaultPanelInner, true);
    trigger().click();
    const instance = controller();
    const close = vi.spyOn(instance, "close");

    panel().remove();
    await tick();
    expect(instance.hasPanelTarget).toBe(false);

    instance.close();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(close).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("scroll"));
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("PopoverController accessibility", () => {
  let application: Application;

  const startReal = async () => {
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--popover">
          <button data-stimeo--popover-target="trigger" aria-haspopup="dialog"
                  aria-expanded="false" aria-controls="pop2"
                  data-action="click->stimeo--popover#toggle">Edit profile</button>
          <div id="pop2" data-stimeo--popover-target="panel" role="dialog"
               aria-label="Edit profile" hidden>
            <label>Name <input type="text" /></label>
          </div>
        </div>
      </main>`;
    application = Application.start();
    application.register("stimeo--popover", PopoverController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("has no machine-detectable a11y violations when open", async () => {
    await startReal();
    query<HTMLButtonElement>("[data-stimeo--popover-target='trigger']").click();
    await expectNoA11yViolations(document.body);
  });

  it("announces the trigger as a popup button", async () => {
    await startReal();
    const spoken = await captureSpeech({ container: query("main"), steps: 1 });
    // Freeze the whole ordered array (not a name-only `toContain`): the trigger must
    // keep its button role, name, and the popup/collapsed state.
    expect(spoken).toEqual([
      "main",
      "button, Edit profile, 1 control, not expanded, has popup dialog",
    ]);
  });
});
