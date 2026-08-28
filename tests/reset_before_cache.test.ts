import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { ResetBeforeCacheController } from "../src/controllers/reset_before_cache_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ResetBeforeCacheController}: the turbo:before-cache
 * sweep (attribute removal, form reset, restoring a field to its authored state,
 * re-hiding, node removal), the reset/request events, the dispatchReset toggle,
 * scope narrowing, idempotency, the manual reset action, and listener teardown.
 */

describe("ResetBeforeCacheController", () => {
  let application: Application;

  const start = async (markup: string, attrs = "") => {
    document.body.innerHTML = `<div data-controller="stimeo--reset-before-cache" ${attrs}>${markup}</div>`;
    application = Application.start();
    application.register("stimeo--reset-before-cache", ResetBeforeCacheController);
    await tick();
  };

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
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

  it("returns a standalone field to the value the author wrote", async () => {
    // A reset restores the initial state, and for a text field that state is the
    // authored value — discarding it would destroy markup the page shipped with.
    await start(`<input id="i" data-reset-value value="seed">`);
    const input = query<HTMLInputElement>("#i");
    input.value = "changed";
    fireBeforeCache();
    expect(input.value).toBe("seed");
  });

  it("returns a checkbox to its authored checkedness without touching its value", async () => {
    // The value of a checkbox is what it submits, not what the user changed; the
    // transient part is the checkedness.
    await start(`<input id="c" type="checkbox" data-reset-value value="agree" checked>`);
    const box = query<HTMLInputElement>("#c");
    box.checked = false;
    fireBeforeCache();
    expect(box.checked).toBe(true);
    expect(box.getAttribute("value")).toBe("agree");
  });

  it("returns a radio to its authored checkedness", async () => {
    await start(`
      <input id="r1" type="radio" name="g" data-reset-value value="a" checked>
      <input id="r2" type="radio" name="g" data-reset-value value="b">`);
    query<HTMLInputElement>("#r2").checked = true;
    fireBeforeCache();
    expect(query<HTMLInputElement>("#r1").checked).toBe(true);
    expect(query<HTMLInputElement>("#r2").checked).toBe(false);
  });

  it("returns a select to the option the author marked selected", async () => {
    // Without an option to fall back to, clearing a select leaves nothing
    // selected at all — a state the page never had.
    await start(`
      <select id="s" data-reset-value>
        <option value="a">A</option><option value="b" selected>B</option>
      </select>`);
    const select = query<HTMLSelectElement>("#s");
    select.value = "a";
    fireBeforeCache();
    expect(select.value).toBe("b");
  });

  it("returns a multi-select to every option the author marked selected", async () => {
    await start(`
      <select id="m" multiple data-reset-value>
        <option value="a" selected>A</option><option value="b" selected>B</option>
        <option value="c">C</option>
      </select>`);
    const select = query<HTMLSelectElement>("#m");
    for (const option of Array.from(select.options)) option.selected = option.value === "c";
    fireBeforeCache();
    expect(Array.from(select.selectedOptions).map((option) => option.value)).toEqual(["a", "b"]);
  });

  it("leaves a field that carries no user state alone", async () => {
    // A hidden field holds a value the page shipped, never one the user typed;
    // writing to it would rewrite the markup instead of restoring it. The second
    // field has no value at all, and writing its default back would give it one.
    await start(`
      <input id="h" type="hidden" data-reset-value value="token-1">
      <input id="n" type="hidden" data-reset-value>`);
    fireBeforeCache();
    expect(query<HTMLInputElement>("#h").getAttribute("value")).toBe("token-1");
    expect(query<HTMLInputElement>("#n").hasAttribute("value")).toBe(false);
  });

  it("restores textarea and select fields too", async () => {
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

  it("still sweeps and still reports when the request event is switched off", async () => {
    // The switch decides whether other controllers are asked to close, not
    // whether the sweep happens — reading it as a master switch would silently
    // disable the part.
    await start(
      `<button id="a" data-reset-attr="aria-expanded" aria-expanded="true"></button>`,
      `data-stimeo--reset-before-cache-dispatch-reset-value="false"`,
    );
    let resets = 0;
    root().addEventListener("stimeo--reset-before-cache:reset", () => {
      resets += 1;
    });

    fireBeforeCache();

    expect(query("#a").hasAttribute("aria-expanded")).toBe(false);
    expect(resets).toBe(1);
  });

  it("asks controllers to close before it sweeps", async () => {
    // The order is the contract: the declarative sweep is the last word, so a
    // controller that closes itself late still gets tidied up after.
    await start(`<button id="a" data-reset-attr="aria-expanded" aria-expanded="true"></button>`);
    let attributeWhenAsked: string | null = "unset";
    root().addEventListener("stimeo--reset-before-cache:request", () => {
      attributeWhenAsked = query("#a").getAttribute("aria-expanded");
    });

    fireBeforeCache();

    expect(attributeWhenAsked).toBe("true");
    expect(query("#a").hasAttribute("aria-expanded")).toBe(false);
  });

  it("carries an empty detail on both events", async () => {
    await start(`<div data-reset-attr="open"></div>`);
    const details: unknown[] = [];
    for (const name of ["request", "reset"]) {
      root().addEventListener(`stimeo--reset-before-cache:${name}`, (event) => {
        details.push((event as CustomEvent).detail);
      });
    }

    fireBeforeCache();

    expect(details).toEqual([{}, {}]);
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

  it("keeps sweeping when the scope declaration matches nothing", async () => {
    // A readable selector that finds no element is not an instruction to sweep
    // nothing: the root falls back to the controller element, exactly as an
    // unreadable declaration does.
    await start(
      `<button id="a" data-reset-attr="aria-expanded" aria-expanded="true"></button>`,
      `data-stimeo--reset-before-cache-scope-value=".does-not-exist"`,
    );
    fireBeforeCache();
    expect(query("#a").hasAttribute("aria-expanded")).toBe(false);
  });

  it("keeps sweeping when the scope declaration cannot be parsed", async () => {
    // A declaration the engine cannot read must not take the sweep down with it:
    // this part exists to keep a cached page from freezing mid-interaction, and a
    // typo in one attribute would otherwise disable that for the whole document.
    await start(
      `<button id="a" data-reset-attr="aria-expanded" aria-expanded="true"></button>`,
      `data-stimeo--reset-before-cache-scope-value="#panel["`,
    );
    fireBeforeCache();
    expect(query("#a").hasAttribute("aria-expanded")).toBe(false);
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
