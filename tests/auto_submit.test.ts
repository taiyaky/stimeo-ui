import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoSubmitController } from "../src/controllers/auto_submit_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link AutoSubmitController}: debounced submission (and the
 * 300ms default), rapid coalescing, the `on` allowlist, the pending/busy state
 * hooks and their `turbo:before-cache` rewind, the submit/done events and the
 * `done` detail shape, the optional Announcer bridge (and its opt-in default),
 * the `form` target across runtime replacement/addition/removal, and teardown.
 */

describe("AutoSubmitController", () => {
  let application: Application;

  /** Starts the app with fake timers already active (debounce is timer-driven). */
  const start = async (markup: string) => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--auto-submit", AutoSubmitController);
    await vi.advanceTimersByTimeAsync(0);
  };

  const form = () => query<HTMLFormElement>("form");
  const input = () => query<HTMLInputElement>("input");

  /** Stubs requestSubmit so the test observes the call without real navigation. */
  const stubSubmit = () => {
    const spy = vi.fn();
    form().requestSubmit = spy;
    return spy;
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  const SEARCH = `
    <form data-controller="stimeo--auto-submit"
          data-stimeo--auto-submit-debounce-value="300"
          data-action="input->stimeo--auto-submit#submit
                       change->stimeo--auto-submit#submit">
      <input type="search" name="q">
    </form>`;

  it("submits the form after the debounce delay", async () => {
    await start(SEARCH);
    const submit = stubSubmit();
    input().dispatchEvent(new Event("input", { bubbles: true }));
    expect(submit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("submits after the default 300ms debounce when the value is unset", async () => {
    await start(`
      <form data-controller="stimeo--auto-submit"
            data-action="input->stimeo--auto-submit#submit">
        <input type="search" name="q">
      </form>`);
    const submit = stubSubmit();
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(299);
    expect(submit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("coalesces rapid inputs into a single submit", async () => {
    await start(SEARCH);
    const submit = stubSubmit();
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(100);
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(100);
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("toggles data-auto-submit-pending across the debounce window", async () => {
    await start(SEARCH);
    stubSubmit();
    input().dispatchEvent(new Event("input", { bubbles: true }));
    expect(form().getAttribute("data-auto-submit-pending")).toBe("true");
    await vi.advanceTimersByTimeAsync(300);
    expect(form().hasAttribute("data-auto-submit-pending")).toBe(false);
  });

  it("sets aria-busy on submit and clears it on turbo:submit-end", async () => {
    await start(SEARCH);
    stubSubmit();
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(form().getAttribute("aria-busy")).toBe("true");
    form().dispatchEvent(new Event("turbo:submit-end"));
    expect(form().hasAttribute("aria-busy")).toBe(false);
  });

  it("does not set aria-busy when the form is invalid (no submit ⇒ no turbo:submit-end)", async () => {
    // An invalid form blocks the actual submit, so turbo:submit-end never fires.
    // Setting aria-busy here would leave it stuck — gate it on checkValidity.
    await start(`
      <form data-controller="stimeo--auto-submit"
            data-stimeo--auto-submit-debounce-value="300"
            data-action="input->stimeo--auto-submit#submit">
        <input type="text" name="title" required>
      </form>`);
    const submit = stubSubmit();
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);

    // requestSubmit is still called so the validation surfaces to the user…
    expect(submit).toHaveBeenCalledTimes(1);
    // …but the form is never marked busy, so nothing is left to clear.
    expect(form().hasAttribute("aria-busy")).toBe(false);
  });

  it("sets aria-busy once the invalid field is filled in", async () => {
    await start(`
      <form data-controller="stimeo--auto-submit"
            data-stimeo--auto-submit-debounce-value="300"
            data-action="input->stimeo--auto-submit#submit">
        <input type="text" name="title" required>
      </form>`);
    stubSubmit();
    input().value = "Ada";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(form().getAttribute("aria-busy")).toBe("true");
  });

  it("dispatches submit (with trigger) before submitting", async () => {
    await start(SEARCH);
    stubSubmit();
    const triggers: Array<EventTarget | null> = [];
    form().addEventListener("stimeo--auto-submit:submit", (event) => {
      triggers.push((event as CustomEvent<{ trigger: EventTarget | null }>).detail.trigger);
    });
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(triggers).toEqual([input()]);
  });

  // `done`/`announce` react to Turbo completion (`turbo:submit-end`) independently
  // of a prior debounce cycle, so we drive that signal directly. (Running the full
  // submit cycle here would also trip a happy-dom MutationObserver quirk that
  // double-connects the controller on attribute mutation — not a real-browser bug.)
  it("dispatches done on turbo:submit-end", async () => {
    await start(SEARCH);
    let done = 0;
    form().addEventListener("stimeo--auto-submit:done", () => {
      done += 1;
    });
    form().dispatchEvent(new Event("turbo:submit-end"));
    expect(done).toBe(1);
  });

  it("dispatches done with detail { message: undefined } when message is unset", async () => {
    await start(SEARCH);
    const details: Array<{ message?: string }> = [];
    form().addEventListener("stimeo--auto-submit:done", (event) => {
      details.push((event as CustomEvent<{ message?: string }>).detail);
    });
    form().dispatchEvent(new Event("turbo:submit-end"));
    expect(details).toStrictEqual([{ message: undefined }]);
  });

  it("dispatches done with the configured message in detail", async () => {
    await start(`
      <form data-controller="stimeo--auto-submit"
            data-stimeo--auto-submit-message-value="Results updated">
        <input type="search" name="q">
      </form>`);
    const details: Array<{ message?: string }> = [];
    form().addEventListener("stimeo--auto-submit:done", (event) => {
      details.push((event as CustomEvent<{ message?: string }>).detail);
    });
    form().dispatchEvent(new Event("turbo:submit-end"));
    expect(details).toStrictEqual([{ message: "Results updated" }]);
  });

  it("does not bridge to the Announcer when announce is left at its default", async () => {
    // A message alone must not announce: the bridge is opt-in via `announce`.
    await start(`
      <form data-controller="stimeo--auto-submit"
            data-stimeo--auto-submit-message-value="Results updated">
        <input type="search" name="q">
      </form>`);
    const messages: string[] = [];
    const onAnnounce = (event: Event) => {
      messages.push((event as CustomEvent<{ message: string }>).detail.message);
    };
    window.addEventListener("stimeo--announcer:announce", onAnnounce);
    form().dispatchEvent(new Event("turbo:submit-end"));
    window.removeEventListener("stimeo--announcer:announce", onAnnounce);
    expect(messages).toEqual([]);
  });

  it("bridges to the Announcer on done when announce + message are set", async () => {
    await start(`
      <form data-controller="stimeo--auto-submit"
            data-stimeo--auto-submit-announce-value="true"
            data-stimeo--auto-submit-message-value="Results updated">
        <input type="search" name="q">
      </form>`);
    const messages: string[] = [];
    const onAnnounce = (event: Event) => {
      messages.push((event as CustomEvent<{ message: string }>).detail.message);
    };
    window.addEventListener("stimeo--announcer:announce", onAnnounce);
    form().dispatchEvent(new Event("turbo:submit-end"));
    window.removeEventListener("stimeo--announcer:announce", onAnnounce);
    expect(messages).toEqual(["Results updated"]);
  });

  it("honors the on allowlist (change-only ignores input)", async () => {
    await start(`
      <form data-controller="stimeo--auto-submit"
            data-stimeo--auto-submit-debounce-value="300"
            data-stimeo--auto-submit-on-value="change"
            data-action="input->stimeo--auto-submit#submit
                         change->stimeo--auto-submit#submit">
        <input type="search" name="q">
      </form>`);
    const submit = stubSubmit();
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(submit).not.toHaveBeenCalled();
    input().dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("skips input during IME composition and submits on compositionend", async () => {
    await start(SEARCH);
    const submit = stubSubmit();
    const field = input();
    // Typing kana before confirming the conversion: intermediate input must not submit.
    field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(submit).not.toHaveBeenCalled();
    // Confirming the conversion fires compositionend, which schedules one submit.
    field.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("resets the composing flag on disconnect so a reconnect is not stuck", async () => {
    await start(SEARCH);
    const controller = application.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--auto-submit']"),
      "stimeo--auto-submit",
    ) as AutoSubmitController;
    const submit = stubSubmit();
    // Disconnect mid-composition (e.g. a Turbo cache restore), then reconnect the
    // same instance — a stale composing flag must not suppress later submits.
    input().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    controller.disconnect();
    controller.connect();
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("submits the form target when nested under the controller element", async () => {
    await start(`
      <div data-controller="stimeo--auto-submit"
           data-stimeo--auto-submit-debounce-value="300">
        <form data-stimeo--auto-submit-target="form"
              data-action="input->stimeo--auto-submit#submit">
          <input type="search" name="q">
        </form>
      </div>`);
    const submit = stubSubmit();
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  const NESTED_FORM = `
    <form data-stimeo--auto-submit-target="form"
          data-action="input->stimeo--auto-submit#submit">
      <input type="search" name="q">
    </form>`;

  it("follows a form target replaced at runtime", async () => {
    await start(`
      <div data-controller="stimeo--auto-submit"
           data-stimeo--auto-submit-debounce-value="300">${NESTED_FORM}
      </div>`);
    const host = query<HTMLElement>("[data-controller='stimeo--auto-submit']");
    // A Turbo Stream replacing the form must move the subscriptions with it.
    form().remove();
    host.insertAdjacentHTML("beforeend", NESTED_FORM);
    await vi.advanceTimersByTimeAsync(0);

    const submit = stubSubmit();
    let done = 0;
    host.addEventListener("stimeo--auto-submit:done", () => {
      done += 1;
    });
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(form().getAttribute("aria-busy")).toBe("true");
    form().dispatchEvent(new Event("turbo:submit-end"));
    expect(form().hasAttribute("aria-busy")).toBe(false);
    expect(done).toBe(1);
  });

  it("binds a form target added after connect and releases it on disconnect", async () => {
    await start(`
      <div data-controller="stimeo--auto-submit"
           data-stimeo--auto-submit-debounce-value="300"></div>`);
    const host = query<HTMLElement>("[data-controller='stimeo--auto-submit']");
    host.insertAdjacentHTML("beforeend", NESTED_FORM);
    await vi.advanceTimersByTimeAsync(0);

    const submit = stubSubmit();
    let done = 0;
    host.addEventListener("stimeo--auto-submit:done", () => {
      done += 1;
    });
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(submit).toHaveBeenCalledTimes(1);
    form().dispatchEvent(new Event("turbo:submit-end"));
    expect(done).toBe(1);

    // After disconnect the released form must not produce completion events.
    const controller = application.getControllerForElementAndIdentifier(
      host,
      "stimeo--auto-submit",
    ) as AutoSubmitController;
    controller.disconnect();
    form().dispatchEvent(new Event("turbo:submit-end"));
    expect(done).toBe(1);
  });

  it("drops the pending submit when the form target is removed mid-debounce", async () => {
    await start(`
      <div data-controller="stimeo--auto-submit"
           data-stimeo--auto-submit-debounce-value="300">${NESTED_FORM}
      </div>`);
    const submit = stubSubmit();
    const removed = form();
    input().dispatchEvent(new Event("input", { bubbles: true }));
    expect(removed.getAttribute("data-auto-submit-pending")).toBe("true");
    removed.remove();
    await vi.advanceTimersByTimeAsync(0);
    // The pending submit described the removed form: dropped, hook returned.
    expect(removed.hasAttribute("data-auto-submit-pending")).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(submit).not.toHaveBeenCalled();
  });

  it("stays inert without a resolvable form (non-form root, no target)", async () => {
    await start(`
      <div data-controller="stimeo--auto-submit"
           data-stimeo--auto-submit-debounce-value="300">
        <input type="search" name="q">
      </div>`);
    const host = query<HTMLElement>("[data-controller='stimeo--auto-submit']");
    const controller = application.getControllerForElementAndIdentifier(
      host,
      "stimeo--auto-submit",
    ) as AutoSubmitController;
    // The public action must be a safe no-op: nothing to submit, nothing thrown.
    expect(() => controller.submit(new Event("input"))).not.toThrow();
    expect(host.hasAttribute("data-auto-submit-pending")).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(host.hasAttribute("aria-busy")).toBe(false);
  });

  it("rewinds data-auto-submit-pending on turbo:before-cache", async () => {
    await start(SEARCH);
    const submit = stubSubmit();
    input().dispatchEvent(new Event("input", { bubbles: true }));
    expect(form().getAttribute("data-auto-submit-pending")).toBe("true");
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(form().hasAttribute("data-auto-submit-pending")).toBe(false);
    // The page is about to be frozen: the pending submit must not fire into it.
    await vi.advanceTimersByTimeAsync(300);
    expect(submit).not.toHaveBeenCalled();
  });

  it("reports the submission the cache rewind dropped", async () => {
    await start(SEARCH);
    stubSubmit();
    const reports: unknown[] = [];
    form().addEventListener("stimeo--auto-submit:reconcile", (e) =>
      reports.push((e as CustomEvent).detail),
    );
    input().dispatchEvent(new Event("input", { bubbles: true }));

    document.dispatchEvent(new Event("turbo:before-cache"));
    // `done` would claim a response arrived; the rewind only says the pending
    // submission is gone.
    expect(reports).toEqual([{}]);

    // Nothing pending or busy now, so a second snapshot has nothing to report.
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(reports).toEqual([{}]);
  });

  it("rewinds aria-busy on turbo:before-cache while a submit is in flight", async () => {
    await start(SEARCH);
    stubSubmit();
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(form().getAttribute("aria-busy")).toBe("true");
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(form().hasAttribute("aria-busy")).toBe(false);
  });

  it("clears the debounce timer on disconnect", async () => {
    await start(SEARCH);
    const submit = stubSubmit();
    const controller = application.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--auto-submit']"),
      "stimeo--auto-submit",
    ) as AutoSubmitController;
    input().dispatchEvent(new Event("input", { bubbles: true }));
    controller.disconnect();
    await vi.advanceTimersByTimeAsync(300);
    expect(submit).not.toHaveBeenCalled();
  });

  it("stops listening for turbo:submit-end after disconnect", async () => {
    await start(SEARCH);
    const controller = application.getControllerForElementAndIdentifier(
      query("[data-controller='stimeo--auto-submit']"),
      "stimeo--auto-submit",
    ) as AutoSubmitController;
    let done = 0;
    form().addEventListener("stimeo--auto-submit:done", () => {
      done += 1;
    });
    controller.disconnect();
    form().dispatchEvent(new Event("turbo:submit-end"));
    expect(done).toBe(0);
  });

  it("has no machine-detectable a11y violations", async () => {
    vi.useRealTimers();
    document.body.innerHTML = `
      <main>
        <form data-controller="stimeo--auto-submit"
              data-action="input->stimeo--auto-submit#submit">
          <label for="q">Search</label>
          <input id="q" type="search" name="q">
        </form>
      </main>`;
    application = Application.start();
    application.register("stimeo--auto-submit", AutoSubmitController);
    await tick();
    await expectNoA11yViolations(document.body);
  });
});
