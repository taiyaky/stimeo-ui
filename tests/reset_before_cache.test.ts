import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { ResetBeforeCacheController } from "../src/controllers/reset_before_cache_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link ResetBeforeCacheController}: the turbo:before-cache
 * sweep (attribute removal, form/value clearing, re-hiding, node removal), the
 * reset/request events, the dispatchReset toggle, scope narrowing, idempotency,
 * the manual reset action, and listener teardown.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ResetBeforeCacheController", () => {
  let application: Application;

  const start = async (markup: string, attrs = "") => {
    document.body.innerHTML = `<div data-controller="stimeo--reset-before-cache" ${attrs}>${markup}</div>`;
    application = Application.start();
    application.register("stimeo--reset-before-cache", ResetBeforeCacheController);
    await tick();
  };

  afterEach(() => {
    application?.stop();
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--reset-before-cache']");
  const fireBeforeCache = () => document.dispatchEvent(new Event("turbo:before-cache"));

  it("removes the listed attributes on before-cache", async () => {
    await start(`
      <details data-reset-attr="open"><summary>More</summary></details>
      <button data-reset-attr="aria-expanded" aria-expanded="true">Menu</button>`);
    query("details").setAttribute("open", "");
    fireBeforeCache();
    expect(query("details").hasAttribute("open")).toBe(false);
    expect(query("button").hasAttribute("aria-expanded")).toBe(false);
  });

  it("removes the listed classes on before-cache, keeping the others", async () => {
    await start(`
      <div data-reset-class="is-open is-loading" class="card is-open is-loading"></div>`);
    fireBeforeCache();
    const el = query("div[data-reset-class]");
    expect(el.classList.contains("is-open")).toBe(false);
    expect(el.classList.contains("is-loading")).toBe(false);
    // Author classes outside the reset list are preserved.
    expect(el.classList.contains("card")).toBe(true);
  });

  it("is a no-op for a reset class that is not present", async () => {
    await start(`<div data-reset-class="is-open" class="card"></div>`);
    fireBeforeCache();
    expect(query("div[data-reset-class]").getAttribute("class")).toBe("card");
  });

  it("resets forms back to their initial values", async () => {
    await start(`<form data-reset-form><input id="i" name="q" value=""></form>`);
    const input = query<HTMLInputElement>("#i");
    input.value = "typed";
    fireBeforeCache();
    expect(input.value).toBe("");
  });

  it("clears the value of a standalone field", async () => {
    await start(`<input id="i" data-reset-value value="seed">`);
    const input = query<HTMLInputElement>("#i");
    input.value = "changed";
    fireBeforeCache();
    expect(input.value).toBe("");
  });

  it("clears textarea and select values too", async () => {
    await start(`
      <textarea id="ta" data-reset-value></textarea>
      <select id="sel" data-reset-value>
        <option value="">—</option><option value="a">A</option>
      </select>`);
    const textarea = query<HTMLTextAreaElement>("#ta");
    const select = query<HTMLSelectElement>("#sel");
    textarea.value = "typed";
    select.value = "a";
    fireBeforeCache();
    expect(textarea.value).toBe("");
    expect(select.value).toBe("");
  });

  it("re-hides elements marked data-reset-hidden", async () => {
    await start(`<div id="overlay" data-reset-hidden>overlay</div>`);
    const overlay = query("#overlay");
    overlay.hidden = false;
    fireBeforeCache();
    expect(overlay.hidden).toBe(true);
  });

  it("removes elements marked data-reset-remove", async () => {
    await start(`<div id="flash" data-reset-remove>flash</div>`);
    fireBeforeCache();
    expect(document.getElementById("flash")).toBeNull();
  });

  it("dispatches request then reset events", async () => {
    await start(`<div data-reset-attr="open"></div>`);
    const events: string[] = [];
    root().addEventListener("stimeo--reset-before-cache:request", () => events.push("request"));
    root().addEventListener("stimeo--reset-before-cache:reset", () => events.push("reset"));
    fireBeforeCache();
    expect(events).toEqual(["request", "reset"]);
  });

  it("suppresses the request event when dispatchReset is false", async () => {
    await start(
      `<div data-reset-attr="open"></div>`,
      `data-stimeo--reset-before-cache-dispatch-reset-value="false"`,
    );
    let requests = 0;
    root().addEventListener("stimeo--reset-before-cache:request", () => {
      requests += 1;
    });
    fireBeforeCache();
    expect(requests).toBe(0);
  });

  it("only resets within the configured scope", async () => {
    await start(
      `
      <div class="inside"><button id="a" data-reset-attr="aria-expanded" aria-expanded="true"></button></div>
      <div class="outside"><button id="b" data-reset-attr="aria-expanded" aria-expanded="true"></button></div>`,
      `data-stimeo--reset-before-cache-scope-value=".inside"`,
    );
    fireBeforeCache();
    expect(query("#a").hasAttribute("aria-expanded")).toBe(false);
    // Outside the scope, the attribute is left untouched.
    expect(query("#b").getAttribute("aria-expanded")).toBe("true");
  });

  it("is idempotent across repeated runs", async () => {
    await start(`<details data-reset-attr="open" open><summary>x</summary></details>`);
    fireBeforeCache();
    fireBeforeCache();
    expect(query("details").hasAttribute("open")).toBe(false);
  });

  it("can be triggered manually via the reset action", async () => {
    await start(`<button id="m" data-reset-attr="aria-expanded" aria-expanded="true"></button>`);
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--reset-before-cache",
    ) as ResetBeforeCacheController;
    controller.reset();
    expect(query("#m").hasAttribute("aria-expanded")).toBe(false);
  });

  it("stops resetting after disconnect", async () => {
    await start(`<button id="d" data-reset-attr="aria-expanded" aria-expanded="true"></button>`);
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--reset-before-cache",
    ) as ResetBeforeCacheController;
    controller.disconnect();
    fireBeforeCache();
    // The listener was removed: the attribute is left untouched.
    expect(query("#d").getAttribute("aria-expanded")).toBe("true");
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(`<details data-reset-attr="open"><summary>More</summary><p>Body</p></details>`);
    await expectNoA11yViolations(document.body);
  });
});
