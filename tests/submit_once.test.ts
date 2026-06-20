import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubmitOnceController } from "../src/controllers/submit_once_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link SubmitOnceController}: disabling + `aria-busy` on
 * submit, busy-label swapping (form default and per-button override), restore on
 * `turbo:submit-end` and on timeout, focus restore, and idempotent connect.
 */

describe("SubmitOnceController", () => {
  let application: Application;

  const mount = async (formAttrs: string, inner: string) => {
    document.body.innerHTML = `
      <form data-controller="stimeo--submit-once" action="#" ${formAttrs}
            data-action="submit->stimeo--submit-once#start">
        ${inner}
      </form>`;
    application = Application.start();
    application.register("stimeo--submit-once", SubmitOnceController);
    // Keep the test env from actually navigating on submit.
    form().addEventListener("submit", (event) => event.preventDefault());
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    application.stop();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const form = () => query<HTMLFormElement>("form");
  const button = (label: string) => query<HTMLButtonElement>(`button[data-label='${label}']`);

  const submit = (submitter: HTMLButtonElement) => {
    form().dispatchEvent(new SubmitEvent("submit", { submitter, bubbles: true, cancelable: true }));
  };

  it("disables the button, marks busy, swaps the label, and fires start", async () => {
    await mount(
      'data-stimeo--submit-once-busy-label-value="Submitting…"',
      '<button type="submit" data-label="send" data-stimeo--submit-once-target="submit">Send</button>',
    );
    let started = false;
    form().addEventListener("stimeo--submit-once:start", () => {
      started = true;
    });

    submit(button("send"));

    expect(button("send").disabled).toBe(true);
    expect(button("send").getAttribute("aria-busy")).toBe("true");
    expect(button("send").textContent).toBe("Submitting…");
    expect(button("send").getAttribute("data-submit-once-original-label")).toBe("Send");
    expect(form().getAttribute("data-submitting")).toBe("true");
    expect(form().getAttribute("aria-busy")).toBe("true");
    expect(started).toBe(true);
  });

  it("swaps only the triggering button's label and disables the rest", async () => {
    await mount(
      'data-stimeo--submit-once-busy-label-value="Working…"',
      `<button type="submit" data-label="send" data-stimeo--submit-once-target="submit">Send</button>
       <button type="submit" data-label="draft" data-stimeo--submit-once-target="submit">Draft</button>`,
    );

    submit(button("send"));

    expect(button("send").textContent).toBe("Working…");
    expect(button("draft").textContent).toBe("Draft"); // not the trigger → label kept
    expect(button("draft").disabled).toBe(true); // but still disabled
  });

  it("lets a per-button busy label override the form default", async () => {
    await mount(
      'data-stimeo--submit-once-busy-label-value="Submitting…"',
      `<button type="submit" data-label="draft" data-stimeo--submit-once-target="submit"
               data-submit-once-busy-label="Saving draft…">Draft</button>`,
    );

    submit(button("draft"));

    expect(button("draft").textContent).toBe("Saving draft…");
  });

  it("restores on turbo:submit-end and fires end with success", async () => {
    await mount(
      'data-stimeo--submit-once-busy-label-value="Submitting…"',
      '<button type="submit" data-label="send" data-stimeo--submit-once-target="submit">Send</button>',
    );
    const ends: Array<{ success?: boolean }> = [];
    form().addEventListener("stimeo--submit-once:end", (e) => {
      ends.push((e as CustomEvent).detail);
    });

    submit(button("send"));
    form().dispatchEvent(new CustomEvent("turbo:submit-end", { detail: { success: true } }));

    expect(button("send").disabled).toBe(false);
    expect(button("send").hasAttribute("aria-busy")).toBe(false);
    expect(button("send").textContent).toBe("Send");
    expect(form().hasAttribute("data-submitting")).toBe(false);
    expect(ends.at(-1)).toEqual({ success: true });
  });

  it("force-restores after the timeout", async () => {
    await mount(
      'data-stimeo--submit-once-timeout-value="5000"',
      '<button type="submit" data-label="send" data-stimeo--submit-once-target="submit">Send</button>',
    );

    submit(button("send"));
    expect(button("send").disabled).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(button("send").disabled).toBe(false);
  });

  it("restores focus to the submitter when restoreFocus is set", async () => {
    await mount(
      'data-stimeo--submit-once-restore-focus-value="true"',
      '<button type="submit" data-label="send" data-stimeo--submit-once-target="submit">Send</button>',
    );

    submit(button("send"));
    form().dispatchEvent(new CustomEvent("turbo:submit-end", { detail: { success: false } }));

    expect(document.activeElement).toBe(button("send"));
  });

  it("ignores a second submit while already busy", async () => {
    await mount(
      "",
      '<button type="submit" data-label="send" data-stimeo--submit-once-target="submit">Send</button>',
    );
    let starts = 0;
    form().addEventListener("stimeo--submit-once:start", () => {
      starts += 1;
    });

    submit(button("send"));
    submit(button("send"));

    expect(starts).toBe(1);
  });

  it("clears stale busy state left in a restored cache snapshot on connect", async () => {
    await mount(
      'data-submitting="true" aria-busy="true"',
      `<button type="submit" data-label="send" data-stimeo--submit-once-target="submit"
               disabled aria-busy="true" data-submit-once-disabled="true"
               data-submit-once-original-label="Send">Submitting…</button>`,
    );

    expect(button("send").disabled).toBe(false);
    expect(button("send").hasAttribute("aria-busy")).toBe(false);
    expect(button("send").textContent).toBe("Send");
    expect(button("send").hasAttribute("data-submit-once-original-label")).toBe(false);
    expect(button("send").hasAttribute("data-submit-once-disabled")).toBe(false);
    expect(form().hasAttribute("data-submitting")).toBe(false);
  });

  it("never enables an authored-disabled submit button", async () => {
    await mount(
      "",
      `<button type="submit" data-label="send" disabled
               data-stimeo--submit-once-target="submit">Send</button>
       <button type="submit" data-label="go" data-stimeo--submit-once-target="submit">Go</button>`,
    );
    // Authored-disabled on connect (clearStaleBusy must not enable it).
    expect(button("send").disabled).toBe(true);

    submit(button("go"));
    expect(button("send").disabled).toBe(true); // we did not disable it → no marker
    expect(button("send").hasAttribute("data-submit-once-disabled")).toBe(false);

    form().dispatchEvent(new CustomEvent("turbo:submit-end", { detail: { success: true } }));
    expect(button("send").disabled).toBe(true); // and we never re-enable it
    expect(button("go").disabled).toBe(false);
  });

  it("removes its listeners on disconnect", async () => {
    await mount(
      "",
      '<button type="submit" data-label="send" data-stimeo--submit-once-target="submit">Send</button>',
    );
    const root = form();
    root.remove();
    await vi.advanceTimersByTimeAsync(0);
    expect(() =>
      root.dispatchEvent(new CustomEvent("turbo:submit-end", { detail: { success: true } })),
    ).not.toThrow();
  });

  it("has no a11y violations while busy", async () => {
    vi.useRealTimers();
    document.body.innerHTML = `
      <form data-controller="stimeo--submit-once" action="#"
            data-stimeo--submit-once-busy-label-value="Submitting…"
            data-action="submit->stimeo--submit-once#start">
        <button type="submit" data-label="send"
                data-stimeo--submit-once-target="submit">Send</button>
      </form>`;
    application = Application.start();
    application.register("stimeo--submit-once", SubmitOnceController);
    form().addEventListener("submit", (event) => event.preventDefault());
    await new Promise((resolve) => setTimeout(resolve, 0));
    submit(button("send"));
    await expectNoA11yViolations(form());
  });
});
