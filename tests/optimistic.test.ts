import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { OptimisticController } from "../src/controllers/optimistic_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link OptimisticController}: the submit-start
 * optimistic toggle (marker-tracked), commit on success, exact rollback on
 * failure, authored-state respect, cache-restore revert, and teardown.
 */

describe("OptimisticController", () => {
  let application: Application;

  const fixture = `
    <main>
      <form data-controller="stimeo--optimistic" action="/likes" method="post">
        <button type="submit" aria-label="Like">
          <span id="off" data-stimeo--optimistic-target="hide">♡</span>
          <span id="on" hidden data-stimeo--optimistic-target="show">♥</span>
        </button>
      </form>
    </main>`;

  const mount = async (html = fixture) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--optimistic", OptimisticController);
    await tick();
  };

  afterEach(async () => {
    controller()?.disconnect();
    application.stop();
    document.body.innerHTML = "";
    await tick();
  });

  const form = () => document.querySelector("form") as HTMLFormElement;
  const on = () => document.querySelector("#on") as HTMLElement;
  const off = () => document.querySelector("#off") as HTMLElement;
  const controller = () =>
    form()
      ? (application?.getControllerForElementAndIdentifier(
          form(),
          "stimeo--optimistic",
        ) as OptimisticController | null)
      : null;
  const submitStart = () =>
    form().dispatchEvent(new CustomEvent("turbo:submit-start", { bubbles: true }));
  const submitEnd = (success: boolean) =>
    form().dispatchEvent(
      new CustomEvent("turbo:submit-end", { bubbles: true, detail: { success } }),
    );

  it("applies the optimistic state on submit-start", async () => {
    await mount();
    submitStart();
    expect(on().hidden).toBe(false);
    expect(off().hidden).toBe(true);
    expect(form().getAttribute("data-optimistic")).toBe("true");
    expect(form().getAttribute("aria-busy")).toBe("true");
  });

  it("keeps the state and dispatches commit on success", async () => {
    await mount();
    const events: string[] = [];
    form().addEventListener("stimeo--optimistic:commit", () => events.push("commit"));
    submitStart();
    submitEnd(true);
    expect(on().hidden).toBe(false);
    expect(form().hasAttribute("data-optimistic")).toBe(false);
    expect(form().hasAttribute("aria-busy")).toBe(false);
    expect(events).toEqual(["commit"]);
  });

  it("rolls back exactly the toggled state and dispatches rollback on failure", async () => {
    await mount();
    const events: string[] = [];
    form().addEventListener("stimeo--optimistic:rollback", () => events.push("rollback"));
    submitStart();
    submitEnd(false);
    expect(on().hidden).toBe(true);
    expect(off().hidden).toBe(false);
    expect(form().hasAttribute("data-optimistic")).toBe(false);
    expect(events).toEqual(["rollback"]);
  });

  it("never reverts a target it did not toggle (authored state wins)", async () => {
    // The show target is already visible: the controller must not mark it, so a
    // failure leaves it exactly as authored.
    await mount(`
      <main>
        <form data-controller="stimeo--optimistic" action="/likes" method="post">
          <span id="on" data-stimeo--optimistic-target="show">♥</span>
          <button type="submit">Like</button>
        </form>
      </main>`);
    submitStart();
    submitEnd(false);
    expect(on().hidden).toBe(false);
  });

  it("reverts a cache snapshot taken mid-submit on connect", async () => {
    await mount(`
      <main>
        <form data-controller="stimeo--optimistic" data-optimistic="true" aria-busy="true"
              action="/likes" method="post">
          <span id="off" hidden data-optimistic-toggled="true"
                data-stimeo--optimistic-target="hide">♡</span>
          <span id="on" data-optimistic-toggled="true"
                data-stimeo--optimistic-target="show">♥</span>
          <button type="submit">Like</button>
        </form>
      </main>`);
    expect(form().hasAttribute("data-optimistic")).toBe(false);
    expect(form().hasAttribute("aria-busy")).toBe(false);
    expect(off().hidden).toBe(false);
    expect(on().hidden).toBe(true);
  });

  it("stops reacting after disconnect", async () => {
    await mount();
    controller()?.disconnect();
    submitStart();
    expect(form().hasAttribute("data-optimistic")).toBe(false);
    expect(on().hidden).toBe(true);
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount();
    await expectNoA11yViolations(document.body);
  });

  // --- Layer ③ speech-order regression ---------------------------------------

  it("flips the announced face with the optimistic toggle and restores it on rollback", async () => {
    // Demo-shaped faces: the button is named by its VISIBLE face (no aria-label),
    // so the optimistic `hidden` flip is exactly what a screen reader hears.
    await mount(`
      <main>
        <form data-controller="stimeo--optimistic" action="/likes" method="post">
          <button type="submit">
            <span data-stimeo--optimistic-target="hide">Like</span>
            <span hidden data-stimeo--optimistic-target="show">Liked</span>
          </button>
        </form>
      </main>`);
    const container = document.querySelector("main") as HTMLElement;
    const idle = await captureSpeech({ container, steps: 2 });
    // Freeze the whole ordered array: only the authored (visible) face names the
    // button — the hidden face is out of the accessibility tree.
    expect(idle).toEqual(["main", "form", "button, Like"]);

    // Optimistic state: the faces flip, so the announced name flips with them
    // (`aria-busy` is set on the form; the virtual reader does not voice it).
    submitStart();
    const optimistic = await captureSpeech({ container, steps: 2 });
    expect(optimistic).toEqual(["main", "form", "button, Liked"]);

    // Rollback restores exactly the authored faces — and the idle announcement.
    submitEnd(false);
    const rolledBack = await captureSpeech({ container, steps: 2 });
    expect(rolledBack).toEqual(idle);
  });
});
