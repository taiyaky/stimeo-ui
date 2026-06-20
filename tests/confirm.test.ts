import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmController } from "../src/controllers/confirm_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link ConfirmController}: the Turbo confirm-hook swap and
 * restore, Promise resolution on confirm/cancel/Escape, message + label injection,
 * the open/resolve events, the click-interception `request` mode, and the
 * no-dialog native fallback.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface TurboStub {
  config: { forms: { confirm?: (message: string, element?: HTMLElement) => unknown } };
}

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
    application?.stop();
    document.body.innerHTML = "";
    (window as unknown as { Turbo?: TurboStub }).Turbo = undefined;
  });

  const dialog = () => query("[data-stimeo--confirm-target='dialog']");
  const message = () => query("[data-stimeo--confirm-target='message']");
  const confirmBtn = () => query<HTMLButtonElement>("[data-stimeo--confirm-target='confirm']");
  const cancelBtn = () => query<HTMLButtonElement>("[data-stimeo--confirm-target='cancel']");
  const turboConfirm = () =>
    (window as unknown as { Turbo: TurboStub }).Turbo.config.forms.confirm as (
      m: string,
    ) => Promise<boolean>;

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

  it("opens the dialog with the message and resolves true on confirm", async () => {
    await start(DIALOG);
    const promise = turboConfirm()("Delete this item?");
    expect(dialog().hidden).toBe(false);
    expect(message().textContent).toBe("Delete this item?");
    confirmBtn().click();
    await expect(promise).resolves.toBe(true);
    expect(dialog().hidden).toBe(true);
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
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect(promise).resolves.toBe(false);
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

  // --- Layer ③ speech-order regression ---------------------------------------
  // The Turbo-hook bridge routes `data-turbo-confirm` through this accessible
  // alertdialog; freeze the announced role, name, and the injected message in
  // order so a regression in the bridge surfaces as a diff.
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
});
