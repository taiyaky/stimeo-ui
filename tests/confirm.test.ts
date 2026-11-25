import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmController } from "../src/controllers/confirm_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { press as pressKey, typeKey } from "./helpers/keyboard";
import { recordListeners } from "./helpers/listeners";
import { expectUpperModalOnTop, openUpperModal, TARGET_SWAPS } from "./helpers/modal_stack";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/** Turbo's confirm method: the message, the form being submitted and its submitter. */
type TurboConfirm = (
  message: string,
  form?: HTMLFormElement,
  submitter?: HTMLElement,
) => Promise<boolean>;

interface TurboStub {
  config: { forms: { confirm?: TurboConfirm | (() => boolean) } };
}

/**
 * Behavioral tests for {@link ConfirmController}: the Turbo confirm-hook swap and
 * restore, Promise resolution on confirm/cancel/Escape, message + label injection,
 * the open/resolve events, the click-interception `request` mode, the single-dialog
 * re-prompt rule, and the no-dialog native fallback.
 */
describe("ConfirmController", () => {
  let application: Application;

  const DIALOG = `
    <div data-controller="stimeo--confirm">
      <div data-stimeo--confirm-target="dialog" role="alertdialog" aria-modal="true"
           aria-labelledby="ct" aria-describedby="cm" hidden>
        <h2 id="ct" data-stimeo--confirm-target="title">Are you sure?</h2>
        <p id="cm" data-stimeo--confirm-target="message"></p>
        <button data-stimeo--confirm-target="cancel"
                data-action="click->stimeo--confirm#cancel">Cancel</button>
        <button data-stimeo--confirm-target="confirm"
                data-action="click->stimeo--confirm#confirm">OK</button>
      </div>
    </div>`;

  const start = async (markup: string) => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--confirm", ConfirmController);
    await tick();
  };

  /** Installs a Turbo stub so the controller has a confirm method to swap. */
  const stubTurbo = (): TurboStub => {
    const turbo: TurboStub = { config: { forms: { confirm: undefined } } };
    (window as unknown as { Turbo: TurboStub }).Turbo = turbo;
    return turbo;
  };

  beforeEach(() => {
    stubTurbo();
  });

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    (window as unknown as { Turbo?: TurboStub }).Turbo = undefined;
  });

  const dialog = () => query("[data-stimeo--confirm-target='dialog']");
  const message = () => query("[data-stimeo--confirm-target='message']");
  const confirmBtn = () => query<HTMLButtonElement>("[data-stimeo--confirm-target='confirm']");
  const cancelBtn = () => query<HTMLButtonElement>("[data-stimeo--confirm-target='cancel']");
  const turboConfirm = () =>
    (window as unknown as { Turbo: TurboStub }).Turbo.config.forms.confirm as TurboConfirm;

  it("swaps the Turbo confirm method on connect and restores it on disconnect", async () => {
    const original = () => true;
    const turbo = (window as unknown as { Turbo: TurboStub }).Turbo;
    turbo.config.forms.confirm = original;
    await start(DIALOG);
    expect(turbo.config.forms.confirm).not.toBe(original);

    const controller = application.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--confirm']"),
      "stimeo--confirm",
    ) as ConfirmController;
    controller.disconnect();
    expect(turbo.config.forms.confirm).toBe(original);
  });

  it("settles a pending confirmation as false on disconnect without restoring focus", async () => {
    await start(DIALOG);
    document.body.insertAdjacentHTML("afterbegin", `<button id="opener">Open</button>`);
    const opener = query<HTMLButtonElement>("#opener");
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const promise = turboConfirm()("Delete?");
    // The trap moved focus off the opener into the dialog.
    expect(document.activeElement).not.toBe(opener);

    const controller = application.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--confirm']"),
      "stimeo--confirm",
    ) as ConfirmController;
    controller.disconnect();

    // The awaited Promise is settled (cancelled) so Turbo never hangs…
    await expect(promise).resolves.toBe(false);
    // …and teardown did NOT restore focus to the opener.
    expect(document.activeElement).not.toBe(opener);
  });

  it("releases the document keydown listeners on disconnect", async () => {
    await start(DIALOG);
    document.body.insertAdjacentHTML("afterbegin", `<button id="opener">Open</button>`);
    const opener = query<HTMLButtonElement>("#opener");
    const ledger = recordListeners();
    turboConfirm()("Delete?");
    // The first active trap registers the document's Tab and Escape handlers.
    expect(ledger.live(document, "keydown")).toHaveLength(2);

    controller().disconnect();

    expect(ledger.live(document, "keydown")).toHaveLength(0);
    pressKey(opener, "Tab");
    expect(document.activeElement).toBe(opener);
  });

  it("opens the dialog with the message and resolves true on confirm", async () => {
    await start(DIALOG);
    const promise = turboConfirm()("Delete this item?");
    expect(dialog().hidden).toBe(false);
    expect(message().textContent).toBe("Delete this item?");
    confirmBtn().click();
    await expect(promise).resolves.toBe(true);
    expect(dialog().hidden).toBe(true);
  });

  it("keeps a pending prompt open, with its text, through a morph that puts the server's markup back", async () => {
    await start(DIALOG);
    const promise = turboConfirm()("Delete this item?");
    dialog().setAttribute("hidden", "");
    message().textContent = "";
    dialog().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();

    expect(dialog().hidden).toBe(false);
    expect(message().textContent).toBe("Delete this item?");
    confirmBtn().click();
    await expect(promise).resolves.toBe(true);
    expect(dialog().hidden).toBe(true);
  });

  it("keeps a closed confirm dialog closed through a morph that drops its hidden", async () => {
    await start(DIALOG);
    dialog().removeAttribute("hidden");
    dialog().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();

    expect(dialog().hidden).toBe(true);
  });

  it("writes nothing after a morph once disconnected, and takes a morph with no dialog", async () => {
    await start(DIALOG);
    const root = query("[data-controller='stimeo--confirm']");
    const box = dialog();
    box.removeAttribute("data-stimeo--confirm-target");
    await tick();
    root.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();
    expect(box.hidden).toBe(true);

    box.setAttribute("data-stimeo--confirm-target", "dialog");
    await tick();
    application?.unload("stimeo--confirm");
    box.removeAttribute("hidden");
    root.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();
    expect(box.hidden).toBe(false);
  });

  it("resolves false on cancel", async () => {
    await start(DIALOG);
    const promise = turboConfirm()("Delete?");
    cancelBtn().click();
    await expect(promise).resolves.toBe(false);
    expect(dialog().hidden).toBe(true);
  });

  it("resolves false on Escape", async () => {
    await start(DIALOG);
    const promise = turboConfirm()("Delete?");
    typeKey(document, "Escape");
    await expect(promise).resolves.toBe(false);
  });

  it("places initial focus on the cancel button by default (least destructive)", async () => {
    await start(DIALOG);
    turboConfirm()("Sure?");
    expect(document.activeElement).toBe(cancelBtn());
  });

  it("places initial focus on the confirm button when initialFocus is confirm", async () => {
    await start(`
      <div data-controller="stimeo--confirm" data-stimeo--confirm-initial-focus-value="confirm">
        <div data-stimeo--confirm-target="dialog" role="alertdialog" hidden>
          <p data-stimeo--confirm-target="message"></p>
          <button data-stimeo--confirm-target="cancel"
                  data-action="click->stimeo--confirm#cancel">Cancel</button>
          <button data-stimeo--confirm-target="confirm"
                  data-action="click->stimeo--confirm#confirm">OK</button>
        </div>
      </div>`);
    turboConfirm()("Sure?");
    expect(document.activeElement).toBe(confirmBtn());
  });

  it("traps Tab focus from the last focusable back to the first", async () => {
    await start(DIALOG);
    turboConfirm()("Sure?");
    confirmBtn().focus();
    typeKey(document, "Tab");
    expect(document.activeElement).toBe(cancelBtn());
  });

  it("takes a Tab that does not wrap and moves to the next focusable itself", async () => {
    await start(DIALOG);
    turboConfirm()("Sure?");
    expect(document.activeElement).toBe(cancelBtn());
    const tab = pressKey(cancelBtn(), "Tab");
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(confirmBtn());
  });

  it("injects the configured confirm/cancel labels", async () => {
    await start(`
      <div data-controller="stimeo--confirm"
           data-stimeo--confirm-confirm-label-value="Delete"
           data-stimeo--confirm-cancel-label-value="Keep">
        <div data-stimeo--confirm-target="dialog" role="alertdialog" hidden>
          <p data-stimeo--confirm-target="message"></p>
          <button data-stimeo--confirm-target="cancel"
                  data-action="click->stimeo--confirm#cancel"></button>
          <button data-stimeo--confirm-target="confirm"
                  data-action="click->stimeo--confirm#confirm"></button>
        </div>
      </div>`);
    turboConfirm()("Sure?");
    expect(confirmBtn().textContent).toBe("Delete");
    expect(cancelBtn().textContent).toBe("Keep");
  });

  it("dispatches open and resolve events", async () => {
    await start(DIALOG);
    const events: string[] = [];
    const root = query("[data-controller='stimeo--confirm']");
    root.addEventListener("stimeo--confirm:open", (e) => {
      events.push(`open:${(e as CustomEvent<{ message: string }>).detail.message}`);
    });
    root.addEventListener("stimeo--confirm:resolve", (e) => {
      events.push(`resolve:${(e as CustomEvent<{ confirmed: boolean }>).detail.confirmed}`);
    });
    turboConfirm()("Hi");
    confirmBtn().click();
    expect(events).toEqual(["open:Hi", "resolve:true"]);
  });

  it("dispatches resolve with confirmed:false on cancel and on Escape", async () => {
    await start(DIALOG);
    const outcomes: boolean[] = [];
    const root = query("[data-controller='stimeo--confirm']");
    root.addEventListener("stimeo--confirm:resolve", (e) => {
      outcomes.push((e as CustomEvent<{ confirmed: boolean }>).detail.confirmed);
    });
    turboConfirm()("First?");
    cancelBtn().click();
    turboConfirm()("Second?");
    typeKey(document, "Escape");
    expect(outcomes).toEqual([false, false]);
  });

  it("a second prompt cancels the first and keeps a single dialog", async () => {
    await start(DIALOG);
    const first = turboConfirm()("First?");
    const second = turboConfirm()("Second?");
    // The first confirmation settles as cancelled; the dialog stays open on the second.
    await expect(first).resolves.toBe(false);
    expect(dialog().hidden).toBe(false);
    expect(message().textContent).toBe("Second?");
    confirmBtn().click();
    await expect(second).resolves.toBe(true);
  });

  it("intercepts a form submit via request and continues only when confirmed", async () => {
    await start(`
      <div data-controller="stimeo--confirm">
        <form id="f" action="/x" method="post">
          <button type="submit" data-action="click->stimeo--confirm#request"
                  data-stimeo--confirm-message-param="Delete?">Delete</button>
        </form>
        <div data-stimeo--confirm-target="dialog" role="alertdialog" hidden>
          <p data-stimeo--confirm-target="message"></p>
          <button data-stimeo--confirm-target="cancel"
                  data-action="click->stimeo--confirm#cancel">Cancel</button>
          <button data-stimeo--confirm-target="confirm"
                  data-action="click->stimeo--confirm#confirm">OK</button>
        </div>
      </div>`);
    const submit = vi.fn();
    query<HTMLFormElement>("#f").requestSubmit = submit;
    query<HTMLButtonElement>("[data-action*='request']").click();
    expect(dialog().hidden).toBe(false);
    expect(message().textContent).toBe("Delete?");
    confirmBtn().click();
    await tick();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("does not continue the intercepted action when cancelled", async () => {
    await start(`
      <div data-controller="stimeo--confirm">
        <form id="f" action="/x" method="post">
          <button type="submit" data-action="click->stimeo--confirm#request"
                  data-stimeo--confirm-message-param="Delete?">Delete</button>
        </form>
        <div data-stimeo--confirm-target="dialog" role="alertdialog" hidden>
          <p data-stimeo--confirm-target="message"></p>
          <button data-stimeo--confirm-target="cancel"
                  data-action="click->stimeo--confirm#cancel">Cancel</button>
          <button data-stimeo--confirm-target="confirm"
                  data-action="click->stimeo--confirm#confirm">OK</button>
        </div>
      </div>`);
    const submit = vi.fn();
    query<HTMLFormElement>("#f").requestSubmit = submit;
    query<HTMLButtonElement>("[data-action*='request']").click();
    cancelBtn().click();
    await tick();
    expect(submit).not.toHaveBeenCalled();
  });

  it("works without Turbo present (request still opens the dialog)", async () => {
    (window as unknown as { Turbo?: unknown }).Turbo = undefined;
    await start(`
      <div data-controller="stimeo--confirm">
        <button id="b" data-action="click->stimeo--confirm#request"
                data-stimeo--confirm-message-param="Sure?">Go</button>
        <div data-stimeo--confirm-target="dialog" role="alertdialog" hidden>
          <p data-stimeo--confirm-target="message"></p>
          <button data-stimeo--confirm-target="cancel"
                  data-action="click->stimeo--confirm#cancel">Cancel</button>
          <button data-stimeo--confirm-target="confirm"
                  data-action="click->stimeo--confirm#confirm">OK</button>
        </div>
      </div>`);
    // connect() found no Turbo config to swap — and request still drives the dialog.
    query<HTMLButtonElement>("#b").click();
    expect(dialog().hidden).toBe(false);
    expect(message().textContent).toBe("Sure?");
  });

  it("falls back to native confirm when no dialog target is present", async () => {
    // happy-dom does not implement window.confirm, so install a stub to observe it.
    const native = vi.fn().mockReturnValue(true);
    const previous = window.confirm;
    window.confirm = native;
    await start(`<div data-controller="stimeo--confirm"></div>`);
    const result = await turboConfirm()("No dialog here");
    expect(native).toHaveBeenCalledWith("No dialog here");
    expect(result).toBe(true);
    window.confirm = previous;
  });

  it("has no machine-detectable a11y violations while open", async () => {
    await start(`<main>${DIALOG}</main>`);
    turboConfirm()("Delete this item?");
    await expectNoA11yViolations(document.body);
  });

  // --- Speech-order check ----------------------------------------------------
  // Capture the role, name, and injected message of the alertdialog opened by the confirm hook.
  it("announces the alertdialog role, name, and injected message in order", async () => {
    await start(DIALOG);
    turboConfirm()("Delete this item?");
    expect(dialog().hidden).toBe(false);

    const phrases = await captureSpeech({ container: dialog(), steps: 4 });
    expect(phrases).toEqual([
      "alertdialog, Are you sure?, Delete this item?, modal",
      "alertdialog, Are you sure?, Delete this item?, modal",
      "heading, Are you sure?, level 2",
      "paragraph",
      "Delete this item?",
      "end of paragraph",
    ]);
  });

  const controller = () =>
    application.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--confirm']"),
      "stimeo--confirm",
    ) as ConfirmController;

  /** The dialog target with cancel before confirm, for the `request` fixtures. */
  const REQUEST_DIALOG = `
    <div data-stimeo--confirm-target="dialog" role="alertdialog" aria-label="Confirm" hidden>
      <p data-stimeo--confirm-target="message"></p>
      <button data-stimeo--confirm-target="cancel"
              data-action="click->stimeo--confirm#cancel">Cancel</button>
      <button data-stimeo--confirm-target="confirm"
              data-action="click->stimeo--confirm#confirm">OK</button>
    </div>`;

  it("starts with the dialog hidden when the markup leaves it visible", async () => {
    await start(`
      <div data-controller="stimeo--confirm">
        <div data-stimeo--confirm-target="dialog" role="alertdialog" aria-label="Confirm">
          <p data-stimeo--confirm-target="message"></p>
          <button data-stimeo--confirm-target="cancel"
                  data-action="click->stimeo--confirm#cancel">Cancel</button>
        </div>
      </div>`);

    expect(dialog().hidden).toBe(true);
  });

  it("focuses the cancel button by default when it follows the confirm button", async () => {
    await start(`
      <div data-controller="stimeo--confirm">
        <div data-stimeo--confirm-target="dialog" role="alertdialog" aria-label="Confirm" hidden>
          <p data-stimeo--confirm-target="message"></p>
          <button data-stimeo--confirm-target="confirm"
                  data-action="click->stimeo--confirm#confirm">OK</button>
          <button data-stimeo--confirm-target="cancel"
                  data-action="click->stimeo--confirm#cancel">Cancel</button>
        </div>
      </div>`);

    turboConfirm()("Sure?");

    expect(document.activeElement).toBe(cancelBtn());
  });

  it("focuses the first focusable button when the dialog has no cancel button", async () => {
    await start(`
      <div data-controller="stimeo--confirm">
        <div data-stimeo--confirm-target="dialog" role="alertdialog" aria-label="Confirm" hidden>
          <p data-stimeo--confirm-target="message"></p>
          <button data-stimeo--confirm-target="confirm"
                  data-action="click->stimeo--confirm#confirm">OK</button>
        </div>
      </div>`);

    const promise = turboConfirm()("Sure?");

    expect(document.activeElement).toBe(confirmBtn());
    confirmBtn().click();
    await expect(promise).resolves.toBe(true);
  });

  it("focuses the cancel button when initialFocus asks for a confirm button the dialog lacks", async () => {
    await start(`
      <div data-controller="stimeo--confirm" data-stimeo--confirm-initial-focus-value="confirm">
        <div data-stimeo--confirm-target="dialog" role="alertdialog" aria-label="Confirm" hidden>
          <p data-stimeo--confirm-target="message"></p>
          <button type="button">Details</button>
          <button data-stimeo--confirm-target="cancel"
                  data-action="click->stimeo--confirm#cancel">Cancel</button>
        </div>
      </div>`);

    turboConfirm()("Sure?");

    expect(document.activeElement).toBe(cancelBtn());
  });

  it("ignores a request whose event reached no element", async () => {
    await start(DIALOG);
    // An event that was never dispatched has neither a target nor a current target.
    const event = new Event("click", { cancelable: true });

    expect(() => controller().request(event)).not.toThrow();
    expect(event.defaultPrevented).toBe(false);
    expect(dialog().hidden).toBe(true);
  });

  // Stimulus parses an action param as JSON: "42" arrives as a number, '"Sure?"' without
  // its quotes. The message is the text the author wrote.
  it.each(["42", "1.50", "true", "null", '"Sure?"', '["a","b"]'])(
    "shows and reports the message param %s as written",
    async (written) => {
      await start(`
      <div data-controller="stimeo--confirm">
        <button id="b" data-action="click->stimeo--confirm#request"
                data-turbo-confirm="Delete this item?">Delete</button>
        ${REQUEST_DIALOG}
      </div>`);
      query("#b").setAttribute("data-stimeo--confirm-message-param", written);
      const reported: unknown[] = [];
      query("[data-controller='stimeo--confirm']").addEventListener("stimeo--confirm:open", (e) => {
        reported.push((e as CustomEvent<{ message: unknown }>).detail.message);
      });

      query<HTMLButtonElement>("#b").click();

      expect(message().textContent).toBe(written);
      expect(reported).toEqual([written]);
    },
  );

  it("falls back to data-turbo-confirm when the message param is empty", async () => {
    await start(`
      <div data-controller="stimeo--confirm">
        <button id="b" data-action="click->stimeo--confirm#request"
                data-stimeo--confirm-message-param=""
                data-turbo-confirm="Delete this item?">Delete</button>
        ${REQUEST_DIALOG}
      </div>`);

    query<HTMLButtonElement>("#b").click();

    expect(message().textContent).toBe("Delete this item?");
  });

  it("follows an intercepted link only after approval", async () => {
    await start(`
      <div data-controller="stimeo--confirm">
        <a id="link" href="#confirmed-destination"
           data-action="click->stimeo--confirm#request">Continue</a>
        ${REQUEST_DIALOG}
        <p id="confirmed-destination">Destination</p>
      </div>`);
    const originalUrl = window.location.href;
    const originalHash = window.location.hash;
    const link = query<HTMLAnchorElement>("#link");

    try {
      link.click();
      expect(dialog().hidden).toBe(false);
      expect(window.location.hash).toBe(originalHash);

      cancelBtn().click();
      await tick();
      expect(dialog().hidden).toBe(true);
      expect(window.location.hash).toBe(originalHash);

      link.click();
      confirmBtn().click();
      await tick();
      expect(window.location.hash).toBe("#confirmed-destination");
    } finally {
      window.history.replaceState(window.history.state, "", originalUrl);
    }
  });

  it("submits the form with the intercepted button as its submitter", async () => {
    await start(`
      <div data-controller="stimeo--confirm">
        <form id="f" action="/x" method="post">
          <button id="delete" type="submit" name="intent" value="delete"
                  data-action="click->stimeo--confirm#request"
                  data-stimeo--confirm-message-param="Delete?">Delete</button>
        </form>
        ${REQUEST_DIALOG}
      </div>`);
    const submitters: (HTMLElement | null)[] = [];
    query<HTMLFormElement>("#f").addEventListener("submit", (event) => {
      submitters.push((event as SubmitEvent).submitter);
      event.preventDefault();
    });

    query<HTMLButtonElement>("#delete").click();
    confirmBtn().click();
    await tick();

    expect(submitters).toEqual([query("#delete")]);
  });

  it.each([
    ["an input submit button", `<input id="act" type="submit" name="intent" value="publish"`],
    ["an image button", `<input id="act" type="image" name="go" alt="Go"`],
  ])("submits the form with %s as its submitter", async (_name, opening) => {
    await start(`
      <div data-controller="stimeo--confirm">
        <form id="f" action="/x" method="post">
          ${opening} data-action="click->stimeo--confirm#request"
                     data-stimeo--confirm-message-param="Publish?">
        </form>
        ${REQUEST_DIALOG}
      </div>`);
    const submitters: (HTMLElement | null)[] = [];
    query<HTMLFormElement>("#f").addEventListener("submit", (event) => {
      submitters.push((event as SubmitEvent).submitter);
      event.preventDefault();
    });

    query("#act").click();
    confirmBtn().click();
    await tick();

    expect(submitters).toEqual([query("#act")]);
  });

  it("submits the form a submit button names with its form attribute", async () => {
    await start(`
      <div data-controller="stimeo--confirm">
        <form id="f" action="/x" method="post"></form>
        <button id="delete" type="submit" form="f"
                data-action="click->stimeo--confirm#request"
                data-stimeo--confirm-message-param="Delete?">Delete</button>
        ${REQUEST_DIALOG}
      </div>`);
    const submitters: (HTMLElement | null)[] = [];
    query<HTMLFormElement>("#f").addEventListener("submit", (event) => {
      submitters.push((event as SubmitEvent).submitter);
      event.preventDefault();
    });

    query<HTMLButtonElement>("#delete").click();
    confirmBtn().click();
    await tick();

    expect(submitters).toEqual([query("#delete")]);
  });

  // A confirmed request continues the element's own action. These elements do not submit
  // a form of their own accord, so there is no submission to continue.
  it.each([
    ["a type=button button", `<button id="act" type="button"`, "</button>"],
    ["a reset button", `<button id="act" type="reset"`, "</button>"],
    ["a span", `<span id="act" role="button" tabindex="0"`, "</span>"],
  ])("leaves the form unsubmitted when %s is confirmed", async (_name, opening, closing) => {
    await start(`
      <div data-controller="stimeo--confirm">
        <form id="f" action="/x" method="post">
          ${opening} data-action="click->stimeo--confirm#request"
                     data-stimeo--confirm-message-param="Delete?">Delete${closing}
        </form>
        ${REQUEST_DIALOG}
      </div>`);
    const submit = vi.fn();
    query<HTMLFormElement>("#f").requestSubmit = submit;
    const outcomes: boolean[] = [];
    query("[data-controller='stimeo--confirm']").addEventListener("stimeo--confirm:resolve", (e) =>
      outcomes.push((e as CustomEvent<{ confirmed: boolean }>).detail.confirmed),
    );

    query("#act").click();
    confirmBtn().click();
    await tick();

    expect(outcomes).toEqual([true]);
    expect(dialog().hidden).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  describe("bound to a form's submit event", () => {
    const FORM = `
      <div data-controller="stimeo--confirm">
        <form id="f" action="/x" method="post"
              data-action="submit->stimeo--confirm#request"
              data-stimeo--confirm-message-param="Send?">
          <input id="title" name="title" value="Draft" required>
          <button id="send" type="submit" name="intent" value="send">Send</button>
        </form>
        ${REQUEST_DIALOG}
      </div>`;

    /** The submitters of the submissions no listener cancelled, recorded on `document`. */
    let passed: (HTMLElement | null)[];
    const recordPassed = (event: Event) => {
      if (!event.defaultPrevented) passed.push((event as SubmitEvent).submitter);
      event.preventDefault();
    };

    beforeEach(() => {
      passed = [];
      document.addEventListener("submit", recordPassed);
    });

    afterEach(() => {
      document.removeEventListener("submit", recordPassed);
    });

    const form = () => query<HTMLFormElement>("#f");
    const send = () => query<HTMLButtonElement>("#send");

    it("submits once when confirmed, with the submitter that started the submission", async () => {
      await start(FORM);

      form().requestSubmit(send());
      expect(dialog().hidden).toBe(false);
      expect(passed).toEqual([]);
      confirmBtn().click();
      await tick();

      expect(passed).toEqual([send()]);
      expect(dialog().hidden).toBe(true);
    });

    it("confirms the next submission again after one is cancelled", async () => {
      await start(FORM);

      form().requestSubmit(send());
      cancelBtn().click();
      await tick();
      expect(passed).toEqual([]);

      form().requestSubmit(send());
      expect(dialog().hidden).toBe(false);
      confirmBtn().click();
      await tick();

      expect(passed).toEqual([send()]);
    });

    it("confirms the next submission again after validation stops a confirmed one", async () => {
      await start(FORM);
      const title = query<HTMLInputElement>("#title");

      form().requestSubmit(send());
      title.value = "";
      confirmBtn().click();
      await tick();
      expect(passed).toEqual([]);

      title.value = "Final";
      form().requestSubmit(send());
      expect(dialog().hidden).toBe(false);
      expect(passed).toEqual([]);
      confirmBtn().click();
      await tick();

      expect(passed).toEqual([send()]);
    });

    it("passes no submitter when the submit event names one that is not a submit button", async () => {
      await start(FORM);
      const submit = vi.fn();
      form().requestSubmit = submit;

      form().dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: query("#title") }),
      );
      confirmBtn().click();
      await tick();

      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledWith(undefined);
    });
  });

  describe("a continued submission that Turbo confirms", () => {
    const FORM = `
      <div data-controller="stimeo--confirm">
        <form id="f" action="/x" method="post" data-turbo-confirm="Delete this item?">
          <button id="delete" type="submit" name="intent" value="delete"
                  data-action="click->stimeo--confirm#request">Delete</button>
        </form>
        ${REQUEST_DIALOG}
      </div>`;

    /** The answers Turbo's confirm method gave, asked the way Turbo asks it. */
    let answers: Promise<boolean>[];
    /**
     * Stands in for Turbo's submit handling: for each submission no listener cancelled,
     * it cancels the native one and asks the confirm method with the message, the form
     * and the submitter, synchronously inside the `submit` dispatch.
     */
    const submitLikeTurbo = (event: Event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      const submitter = (event as SubmitEvent).submitter ?? undefined;
      const message =
        submitter?.getAttribute("data-turbo-confirm") ?? form.getAttribute("data-turbo-confirm");
      if (message !== null) answers.push(turboConfirm()(message, form, submitter));
    };

    beforeEach(() => {
      answers = [];
      document.addEventListener("submit", submitLikeTurbo);
    });

    afterEach(() => {
      document.removeEventListener("submit", submitLikeTurbo);
    });

    const opens = () => {
      const seen: string[] = [];
      query("[data-controller='stimeo--confirm']").addEventListener("stimeo--confirm:open", (e) =>
        seen.push((e as CustomEvent<{ message: string }>).detail.message),
      );
      return seen;
    };

    it("asks once: Turbo's confirm method passes the submission it continues", async () => {
      await start(FORM);
      const opened = opens();

      query<HTMLButtonElement>("#delete").click();
      confirmBtn().click();
      await tick();

      expect(opened).toEqual(["Delete this item?"]);
      expect(answers).toHaveLength(1);
      await expect(answers[0]).resolves.toBe(true);
      expect(dialog().hidden).toBe(true);
    });

    it("asks with the submitter's data-turbo-confirm for a request bound to the form's submit", async () => {
      await start(`
        <div data-controller="stimeo--confirm">
          <form id="f" action="/x" method="post" data-action="submit->stimeo--confirm#request"
                data-turbo-confirm="Save this form?">
            <button id="delete" type="submit" data-turbo-confirm="Delete this item?">Delete</button>
          </form>
          ${REQUEST_DIALOG}
        </div>`);

      query<HTMLFormElement>("#f").requestSubmit(query("#delete"));
      expect(message().textContent).toBe("Delete this item?");
      confirmBtn().click();
      await tick();

      expect(answers).toHaveLength(1);
      await expect(answers[0]).resolves.toBe(true);
      expect(dialog().hidden).toBe(true);
    });

    it("asks with nothing from the form for a button that does not submit it", async () => {
      await start(`
        <div data-controller="stimeo--confirm">
          <form id="f" action="/x" method="post" data-turbo-confirm="Delete this item?">
            <button id="act" type="button" data-action="click->stimeo--confirm#request">Act</button>
          </form>
          ${REQUEST_DIALOG}
        </div>`);

      query<HTMLButtonElement>("#act").click();

      expect(dialog().hidden).toBe(false);
      expect(message().textContent).toBe("");
    });

    it("asks again through Turbo's confirm method for the same form outside a continuation", async () => {
      await start(FORM);
      query<HTMLButtonElement>("#delete").click();
      confirmBtn().click();
      await tick();
      const opened = opens();

      const answer = turboConfirm()(
        "Delete this item?",
        query<HTMLFormElement>("#f"),
        query("#delete"),
      );

      expect(opened).toEqual(["Delete this item?"]);
      expect(dialog().hidden).toBe(false);
      cancelBtn().click();
      await expect(answer).resolves.toBe(false);
    });
  });

  describe("re-entry from a subscriber", () => {
    const PAGE = `<main><button id="opener">Open</button></main>${DIALOG}`;
    const root = () => query("[data-controller='stimeo--confirm']");
    /**
     * Runs `handler` on the first `type` event only. A flag rather than `once`: happy-dom
     * calls a `once` listener again when the handler dispatches the same event inside it.
     */
    const onFirst = (type: string, handler: (event: Event) => void) => {
      let done = false;
      root().addEventListener(type, (event) => {
        if (done) return;
        done = true;
        handler(event);
      });
    };

    it.each([
      ["confirm", true],
      ["cancel", false],
    ] as const)(
      "leaves no modal side effects when an open subscriber calls %s",
      async (action, confirmed) => {
        await start(PAGE);
        const opener = query<HTMLButtonElement>("#opener");
        opener.focus();
        onFirst("stimeo--confirm:open", () => controller()[action]());

        const answer = turboConfirm()("Delete?");

        await expect(answer).resolves.toBe(confirmed);
        expect(dialog().hidden).toBe(true);
        expect(document.body.style.overflow).toBe("");
        expect(query("main").inert).toBe(false);
        expect(document.activeElement).toBe(opener);
      },
    );

    it("lets the prompt a resolve subscriber asks while a newer one cancels it own the dialog", async () => {
      await start(PAGE);
      const first = turboConfirm()("First?");
      let third: Promise<boolean> | undefined;
      onFirst("stimeo--confirm:resolve", () => {
        third = turboConfirm()("Third?");
      });

      const second = turboConfirm()("Second?");

      expect(message().textContent).toBe("Third?");
      expect(dialog().hidden).toBe(false);
      await expect(first).resolves.toBe(false);
      await expect(second).resolves.toBe(false);
      controller().confirm();
      await expect(third).resolves.toBe(true);
      expect(dialog().hidden).toBe(true);
    });

    it("keeps the second prompt modal when an open subscriber opens another", async () => {
      await start(PAGE);
      onFirst("stimeo--confirm:open", () => void turboConfirm()("Second?"));

      const first = turboConfirm()("First?");

      await expect(first).resolves.toBe(false);
      expect(dialog().hidden).toBe(false);
      expect(message().textContent).toBe("Second?");
      expect(document.body.style.overflow).toBe("hidden");
      expect(query("main").inert).toBe(true);
      expect(document.activeElement).toBe(cancelBtn());
    });

    it("keeps the next prompt modal when a resolve subscriber opens it", async () => {
      await start(PAGE);
      const first = turboConfirm()("First?");
      onFirst("stimeo--confirm:resolve", () => void turboConfirm()("Next?"));

      confirmBtn().click();

      await expect(first).resolves.toBe(true);
      expect(dialog().hidden).toBe(false);
      expect(message().textContent).toBe("Next?");
      expect(document.body.style.overflow).toBe("hidden");
      expect(query("main").inert).toBe(true);
    });

    it("settles a prompt a resolve subscriber asks during disconnect as false, opening nothing", async () => {
      await start(PAGE);
      const ask = turboConfirm();
      const first = ask("First?");
      let next: Promise<boolean> | undefined;
      onFirst("stimeo--confirm:resolve", () => {
        next = ask("Next?");
      });

      controller().disconnect();

      await expect(first).resolves.toBe(false);
      expect(dialog().hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
      expect(query("main").inert).toBe(false);
      await expect(next).resolves.toBe(false);
    });

    it("keeps a pending replacement prompt when a stale hook asks during a reconnect", async () => {
      await start(PAGE);
      const instance = controller();
      const ask = turboConfirm();
      const first = ask("First?");
      let stale: Promise<boolean> | undefined;
      onFirst("stimeo--confirm:resolve", () => {
        instance.disconnect();
        stale = ask("Stale?");
        instance.connect();
      });

      const second = ask("Second?");

      await expect(first).resolves.toBe(false);
      await expect(stale).resolves.toBe(false);
      expect(dialog().hidden).toBe(false);
      expect(message().textContent).toBe("Second?");
      cancelBtn().click();
      await expect(second).resolves.toBe(false);
    });

    it("asks nothing once disconnected: the prompt settles false with no dialog and no events", async () => {
      await start(PAGE);
      const ask = turboConfirm();
      const events: string[] = [];
      for (const type of ["stimeo--confirm:open", "stimeo--confirm:resolve"]) {
        root().addEventListener(type, () => events.push(type));
      }
      controller().disconnect();

      const answer = ask("Delete?");

      expect(dialog().hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
      expect(query("main").inert).toBe(false);
      expect(events).toEqual([]);
      await expect(answer).resolves.toBe(false);
    });

    it("changes nothing when a resolve subscriber calls cancel", async () => {
      await start(PAGE);
      const opener = query<HTMLButtonElement>("#opener");
      opener.focus();
      const first = turboConfirm()("First?");
      const outcomes: boolean[] = [];
      root().addEventListener("stimeo--confirm:resolve", (e) => {
        outcomes.push((e as CustomEvent<{ confirmed: boolean }>).detail.confirmed);
        controller().cancel();
      });

      confirmBtn().click();

      await expect(first).resolves.toBe(true);
      expect(outcomes).toEqual([true]);
      expect(dialog().hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
      expect(query("main").inert).toBe(false);
      expect(document.activeElement).toBe(opener);
    });
  });

  describe("a dialog, message or button that replaces the current one", () => {
    const WORDED = `
      <main><button id="opener">Open</button></main>
      <div data-controller="stimeo--confirm"
           data-stimeo--confirm-confirm-label-value="Delete"
           data-stimeo--confirm-cancel-label-value="Keep">
        <div data-stimeo--confirm-target="dialog" role="alertdialog" aria-modal="true"
             aria-labelledby="ct" aria-describedby="cm" hidden>
          <h2 id="ct" data-stimeo--confirm-target="title">Are you sure?</h2>
          <p id="cm" data-stimeo--confirm-target="message"></p>
          <button data-stimeo--confirm-target="cancel"
                  data-action="click->stimeo--confirm#cancel"></button>
          <button data-stimeo--confirm-target="confirm"
                  data-action="click->stimeo--confirm#confirm"></button>
        </div>
      </div>`;
    const targetAttribute = "data-stimeo--confirm-target";
    const root = () => query("[data-controller='stimeo--confirm']");
    const opener = () => query<HTMLButtonElement>("#opener");
    const inside = (container: HTMLElement, name: string) =>
      container.querySelector<HTMLElement>(`[${targetAttribute}='${name}']`) as HTMLElement;
    /** A server-rendered copy of `element`: no ids, and the text the server writes is empty. */
    const blank = (element: HTMLElement): HTMLElement => {
      const copy = element.cloneNode(true) as HTMLElement;
      for (const node of [copy, ...Array.from(copy.querySelectorAll<HTMLElement>("[id]"))]) {
        node.removeAttribute("id");
      }
      for (const name of ["message", "cancel", "confirm"]) {
        const slot = copy.matches(`[${targetAttribute}='${name}']`) ? copy : inside(copy, name);
        if (slot) slot.textContent = "";
      }
      return copy;
    };
    /** A server-rendered copy of the dialog, closed as the markup contract authors it. */
    const dialogCopy = (): HTMLElement => {
      const copy = blank(dialog());
      copy.hidden = true;
      return copy;
    };
    /** Records the open and resolve events. */
    const record = () => {
      const seen: string[] = [];
      for (const type of ["stimeo--confirm:open", "stimeo--confirm:resolve"]) {
        root().addEventListener(type, () => seen.push(type));
      }
      return seen;
    };
    /** Collects the writes to `attributes` on `element` that `act` causes. */
    const attributeWrites = async (element: Element, attributes: string[], act: () => void) => {
      const records: MutationRecord[] = [];
      const observer = new MutationObserver((batch) => records.push(...batch));
      observer.observe(element, { attributes: true, attributeFilter: attributes });
      act();
      await tick();
      records.push(...observer.takeRecords());
      observer.disconnect();
      return records;
    };
    /** What `answer` has settled to so far: `undefined` while it is still pending. */
    const settlement = (answer: Promise<boolean>) => {
      const state: { value?: boolean } = {};
      void answer.then((value) => {
        state.value = value;
      });
      return state;
    };
    const wording = (container: HTMLElement) =>
      ["message", "cancel", "confirm"].map((name) => inside(container, name).textContent);

    beforeEach(async () => {
      await start(WORDED);
    });

    it("keeps the prompt open on a dialog that replaces the current one in one task", async () => {
      opener().focus();
      const answer = turboConfirm()("Delete this item?");
      const successor = dialogCopy();
      dialog().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(false);
      expect(wording(successor)).toEqual(["Delete this item?", "Keep", "Delete"]);
      expect(document.activeElement).toBe(inside(successor, "cancel"));
      expect(document.body.style.overflow).toBe("hidden");
      expect(query("main").inert).toBe(true);
      inside(successor, "confirm").click();
      await expect(answer).resolves.toBe(true);
      expect(successor.hidden).toBe(true);
      expect(document.activeElement).toBe(opener());
    });

    it("keeps the prompt open on the dialog that stays after an earlier one leaves", async () => {
      opener().focus();
      const answer = turboConfirm()("Delete this item?");
      const original = dialog();
      const successor = dialogCopy();
      original.after(successor);
      await tick();
      original.remove();
      await tick();

      expect(successor.hidden).toBe(false);
      expect(wording(successor)).toEqual(["Delete this item?", "Keep", "Delete"]);
      expect(document.activeElement).toBe(inside(successor, "cancel"));
      expect(document.body.style.overflow).toBe("hidden");
      expect(query("main").inert).toBe(true);
      typeKey(document, "Escape");
      await expect(answer).resolves.toBe(false);
      expect(document.activeElement).toBe(opener());
    });

    it.each(TARGET_SWAPS)(
      "keeps a modal opened over the prompt on top when its dialog is replaced %s",
      async (_, swap) => {
        opener().focus();
        const answer = turboConfirm()("Delete this item?");
        const state = settlement(answer);
        const upper = openUpperModal();
        const successor = dialogCopy();
        await swap(dialog(), successor);

        expectUpperModalOnTop(upper, successor);
        expect(successor.hidden).toBe(false);
        expect(state.value).toBeUndefined();
        typeKey(document, "Escape");
        await expect(answer).resolves.toBe(false);
        expect(successor.hidden).toBe(true);
        expect(document.activeElement).toBe(opener());
      },
    );

    it.each(["confirm", "cancel", "Escape"] as const)(
      "settles the pending prompt with %s while no dialog is present",
      async (action) => {
        opener().focus();
        const outcomes: boolean[] = [];
        root().addEventListener("stimeo--confirm:resolve", (e) => {
          outcomes.push((e as CustomEvent<{ confirmed: boolean }>).detail.confirmed);
        });
        const answer = settlement(turboConfirm()("Delete?"));
        dialog().remove();
        await tick();

        expect(answer.value).toBeUndefined();
        expect(outcomes).toEqual([]);
        if (action === "Escape") typeKey(document, "Escape");
        else controller()[action]();
        await tick();
        const confirmed = action === "confirm";
        expect(answer.value).toBe(confirmed);
        expect(outcomes).toEqual([confirmed]);
        expect(document.body.style.overflow).toBe("");
        expect(query("main").inert).toBe(false);
        expect(document.activeElement).toBe(opener());
      },
    );

    it("closes a dialog that replaces the current one while no prompt is open", async () => {
      const successor = dialogCopy();
      successor.hidden = false;
      dialog().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(true);
    });

    it("shows the pending prompt on a dialog that arrives after the only one left", async () => {
      opener().focus();
      const answer = turboConfirm()("Delete?");
      const arrival = dialogCopy();
      dialog().remove();
      await tick();
      root().append(arrival);
      await tick();

      expect(arrival.hidden).toBe(false);
      expect(wording(arrival)).toEqual(["Delete?", "Keep", "Delete"]);
      expect(document.activeElement).toBe(inside(arrival, "cancel"));
      expect(query("main").inert).toBe(true);
      expect(document.body.style.overflow).toBe("hidden");
      inside(arrival, "confirm").click();
      await expect(answer).resolves.toBe(true);
      expect(document.activeElement).toBe(opener());
    });

    it("keeps the prompt when an open subscriber removes its dialog before activation", async () => {
      opener().focus();
      const arrival = dialogCopy();
      root().addEventListener("stimeo--confirm:open", () => dialog().remove(), { once: true });
      const answer = turboConfirm()("Keep waiting?");
      await tick();
      root().append(arrival);
      await tick();

      expect(arrival.hidden).toBe(false);
      expect(wording(arrival)).toEqual(["Keep waiting?", "Keep", "Delete"]);
      expect(document.activeElement).toBe(inside(arrival, "cancel"));
      typeKey(document, "Escape");
      await expect(answer).resolves.toBe(false);
      expect(document.activeElement).toBe(opener());
    });

    it("opens the next prompt on a dialog that arrived after the only one left", async () => {
      const arrival = dialogCopy();
      dialog().remove();
      await tick();
      root().append(arrival);
      await tick();
      const answer = turboConfirm()("Next?");

      expect(arrival.hidden).toBe(false);
      expect(wording(arrival)).toEqual(["Next?", "Keep", "Delete"]);
      controller().confirm();
      await expect(answer).resolves.toBe(true);
    });

    it("leaves focus where it is when a dialog arrives behind the current one", async () => {
      turboConfirm()("Delete?");
      confirmBtn().focus();
      dialog().after(dialogCopy());
      await tick();

      expect(document.activeElement).toBe(confirmBtn());
      expect(dialog().hidden).toBe(false);
    });

    it("leaves focus on the page when a dialog arrives behind the current one", async () => {
      turboConfirm()("Delete?");
      (document.activeElement as HTMLElement).blur();
      dialog().after(dialogCopy());
      await tick();

      expect(document.activeElement).toBe(document.body);
      expect(dialog().hidden).toBe(false);
    });

    it("reports nothing while it moves the prompt and its wording", async () => {
      turboConfirm()("Delete?");
      const seen = record();
      dialog().replaceWith(dialogCopy());
      await tick();
      const original = dialog();
      original.after(dialogCopy());
      await tick();
      original.remove();
      await tick();
      message().replaceWith(blank(message()));
      await tick();

      expect(seen).toEqual([]);
      expect(message().textContent).toBe("Delete?");
    });

    it("moves nothing once it has disconnected", async () => {
      turboConfirm()("Delete?");
      const original = dialog();
      const successor = dialogCopy();
      original.after(successor);
      await tick();
      controller().disconnect();
      // A write from here on would hide the successor the page just showed.
      successor.hidden = false;
      original.remove();
      await tick();

      expect(successor.hidden).toBe(false);
      expect(wording(successor)).toEqual(["", "", ""]);
      expect(document.body.style.overflow).toBe("");
    });

    it("gives a dialog left in the page without its target token its own hidden back", async () => {
      const answer = turboConfirm()("Delete?");
      const original = dialog();
      const successor = dialogCopy();
      original.after(successor);
      await tick();
      original.removeAttribute(targetAttribute);
      await tick();

      expect(original.hidden).toBe(true);
      expect(successor.hidden).toBe(false);
      expect(document.body.style.overflow).toBe("hidden");
      controller().confirm();
      await expect(answer).resolves.toBe(true);
    });

    it("words and focuses the dialog that stays when the earlier one loses its target token", async () => {
      turboConfirm()("Delete?");
      const original = dialog();
      const successor = dialogCopy();
      original.after(successor);
      await tick();
      original.removeAttribute(targetAttribute);
      await tick();

      expect(wording(successor)).toEqual(["Delete?", "Keep", "Delete"]);
      expect(document.activeElement).toBe(inside(successor, "cancel"));
    });

    it("focuses the confirm button of the dialog that stays when initialFocus asks for it", async () => {
      root().setAttribute("data-stimeo--confirm-initial-focus-value", "confirm");
      turboConfirm()("Delete?");
      const original = dialog();
      const successor = dialogCopy();
      original.after(successor);
      await tick();
      original.removeAttribute(targetAttribute);
      await tick();

      expect(document.activeElement).toBe(inside(successor, "confirm"));
    });

    it("words and focuses inside the dialog when slots also sit outside it", async () => {
      const outside = blank(message());
      outside.textContent = "Outside";
      root().prepend(outside);
      const outsideCancel = blank(cancelBtn());
      outsideCancel.textContent = "Outside";
      root().prepend(outsideCancel);
      await tick();
      turboConfirm()("Delete?");

      expect(outside.textContent).toBe("Outside");
      expect(outsideCancel.textContent).toBe("Outside");
      expect(wording(dialog())).toEqual(["Delete?", "Keep", "Delete"]);
      expect(document.activeElement).toBe(inside(dialog(), "cancel"));
    });

    it("holds the pending prompt when its message and dialog leave together", async () => {
      const answer = settlement(turboConfirm()("Delete?"));
      message().remove();
      dialog().remove();
      await tick();

      expect(answer.value).toBeUndefined();
    });

    it("returns authored hidden while the only dialog loses its target token", async () => {
      opener().focus();
      const answer = settlement(turboConfirm()("Delete?"));
      const only = dialog();
      only.removeAttribute(targetAttribute);
      await tick();

      expect(answer.value).toBeUndefined();
      expect(only.hidden).toBe(true);
      controller().cancel();
      await tick();
      expect(answer.value).toBe(false);
      expect(document.body.style.overflow).toBe("");
      expect(document.activeElement).toBe(opener());
    });

    it("gives the dialog back its own hidden when the bridge loses its controller", async () => {
      const answer = turboConfirm()("Delete?");
      const departed = dialog();
      root().removeAttribute("data-controller");
      await tick();

      await expect(answer).resolves.toBe(false);
      expect(departed.hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
      expect(query("main").inert).toBe(false);
    });

    it("gives an authored-visible dialog its visibility back when the controller goes", async () => {
      const fresh = dialogCopy();
      fresh.hidden = false;
      dialog().replaceWith(fresh);
      await tick();
      expect(fresh.hidden).toBe(true);

      root().removeAttribute("data-controller");
      await tick();

      expect(fresh.hidden).toBe(false);
    });

    it("keeps a hidden value the page wrote after the controller did", async () => {
      turboConfirm()("Delete?");
      const departed = dialog();
      departed.setAttribute("hidden", "until-found");
      root().removeAttribute("data-controller");
      await tick();

      expect(departed.getAttribute("hidden")).toBe("until-found");
    });

    it("keeps the prompt on a dialog that moves within the element", async () => {
      const answer = turboConfirm()("Delete?");
      const moving = dialog();

      const writes = await attributeWrites(moving, ["hidden"], () => root().append(moving));

      expect(moving.hidden).toBe(false);
      expect(writes).toEqual([]);
      expect(document.body.style.overflow).toBe("hidden");
      controller().confirm();
      await expect(answer).resolves.toBe(true);
    });

    /** Each slot a prompt words, with the text the open prompt gives it. */
    const slots = [
      ["message", "Delete this item?"],
      ["cancel", "Keep"],
      ["confirm", "Delete"],
    ] as const;

    it.each(slots)(
      "words a %s slot that replaces the current one in one task",
      async (name, text) => {
        turboConfirm()("Delete this item?");
        const original = inside(dialog(), name);
        const successor = blank(original);
        original.replaceWith(successor);
        await tick();

        expect(successor.textContent).toBe(text);
      },
    );

    it.each(slots)(
      "words the %s slot that stays after an earlier one leaves",
      async (name, text) => {
        turboConfirm()("Delete this item?");
        const original = inside(dialog(), name);
        const successor = blank(original);
        original.after(successor);
        await tick();
        original.remove();
        await tick();

        expect(successor.textContent).toBe(text);
      },
    );

    it("words a replaced button with the label it had when the prompt opened", async () => {
      turboConfirm()("Delete this item?");
      root().setAttribute("data-stimeo--confirm-confirm-label-value", "Remove");
      root().setAttribute("data-stimeo--confirm-cancel-label-value", "Back");
      await tick();
      const successors = (["cancel", "confirm"] as const).map((name) => {
        const original = inside(dialog(), name);
        const successor = blank(original);
        original.replaceWith(successor);
        return successor;
      });
      await tick();

      expect(successors.map((successor) => successor.textContent)).toEqual(["Keep", "Delete"]);
    });

    it.each(slots)("words a %s slot that arrives after the only one left", async (name, text) => {
      turboConfirm()("Delete this item?");
      const original = inside(dialog(), name);
      const arrival = blank(original);
      const seen = record();
      original.remove();
      await tick();
      dialog().append(arrival);
      await tick();

      expect(arrival.textContent).toBe(text);
      expect(seen).toEqual([]);
    });

    it("leaves a message and buttons that arrive between prompts as the page wrote them", async () => {
      const seen = record();
      const arrivals = [message(), cancelBtn(), confirmBtn()].map((element) => {
        const arrival = blank(element);
        arrival.textContent = "Server copy";
        element.replaceWith(arrival);
        return arrival;
      });
      await tick();

      expect(arrivals.map((element) => element.textContent)).toEqual([
        "Server copy",
        "Server copy",
        "Server copy",
      ]);
      expect(seen).toEqual([]);
    });

    it("words nothing once it has disconnected", async () => {
      turboConfirm()("Delete?");
      const original = message();
      const successor = blank(original);
      original.after(successor);
      await tick();
      controller().disconnect();
      original.remove();
      await tick();

      expect(successor.textContent).toBe("");
    });

    it("keeps the text on a message left in the page without its target token", async () => {
      turboConfirm()("Delete?");
      const original = message();
      const successor = blank(original);
      original.after(successor);
      await tick();
      original.removeAttribute(targetAttribute);
      await tick();

      expect(original.textContent).toBe("Delete?");
      expect(successor.textContent).toBe("Delete?");
    });
  });
});
