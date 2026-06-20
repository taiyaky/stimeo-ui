import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoSubmitController } from "../src/controllers/auto_submit_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link AutoSubmitController}: debounced submission, rapid
 * coalescing, the `on` allowlist, the pending/busy state hooks, the submit/done
 * events, the optional Announcer bridge, the `form` target, and teardown.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    application?.stop();
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
