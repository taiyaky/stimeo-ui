import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { ResetOnRestoreController } from "../src/controllers/reset_on_restore_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ResetOnRestoreController}: the sweep (attribute removal,
 * class removal, form reset, restoring a field to its authored state, re-hiding, node
 * removal) run on a copy of the page Turbo restores and by the manual reset action, the
 * mark that tells such a copy from server markup, the reset event, scope narrowing and
 * idempotency, and a live page that a reconnect, turbo:before-cache or a morph leaves alone.
 */

describe("ResetOnRestoreController", () => {
  let application: Application;

  const start = async (markup: string, attrs = "") => {
    document.body.innerHTML = `<div data-controller="stimeo--reset-on-restore" ${attrs}>${markup}</div>`;
    application = Application.start();
    application.register("stimeo--reset-on-restore", ResetOnRestoreController);
    await tick();
  };

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--reset-on-restore']");
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--reset-on-restore",
    ) as ResetOnRestoreController;
  const sweep = () => controller().reset();
  const restore = async (): Promise<void> => {
    application = await restoreFromCache(application, (restored) =>
      restored.register("stimeo--reset-on-restore", ResetOnRestoreController),
    );
  };
  const countResets = (): { count: number } => {
    const seen = { count: 0 };
    document.addEventListener("stimeo--reset-on-restore:reset", () => {
      seen.count += 1;
    });
    return seen;
  };

  describe("a copy of the page Turbo restores", () => {
    it("is reset once, with the reset reported where document listeners hear it", async () => {
      await start(`
        <details id="d" data-reset-attr="open"><summary>More</summary></details>
        <div id="overlay" data-reset-hidden hidden>Overlay</div>
        <div id="flash" data-reset-remove>Flash</div>`);
      query("details").setAttribute("open", "");
      query("#overlay").hidden = false;
      const seen = countResets();

      await restore();

      expect(query("#d").hasAttribute("open")).toBe(false);
      expect(query("#overlay").hidden).toBe(true);
      expect(document.getElementById("flash")).toBeNull();
      expect(seen.count).toBe(1);
    });

    it("is reset when the copy was taken after the controller disconnected", async () => {
      await start(`<details id="d" data-reset-attr="open"><summary>More</summary></details>`);
      query("details").setAttribute("open", "");
      disconnectAndStopApplication(application);

      await restore();

      expect(query("#d").hasAttribute("open")).toBe(false);
    });

    it("is reset again once the morph that refreshed the live page dropped the mark", async () => {
      await start(`<details id="d" data-reset-attr="open"><summary>More</summary></details>`);
      const mark = root()
        .getAttributeNames()
        .filter((name) => name.endsWith("-lived"));
      expect(mark).toEqual(["data-stimeo--reset-on-restore-lived"]);
      // A Turbo morph keeps only the attributes the server sent.
      root().removeAttribute("data-stimeo--reset-on-restore-lived");
      root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      await flushMicrotasks();
      query("details").setAttribute("open", "");

      await restore();

      expect(query("#d").hasAttribute("open")).toBe(false);
    });
  });

  describe("a live page", () => {
    it("is not reset on a fresh render, an authored open state included", async () => {
      const seen = countResets();
      await start(`<details id="d" data-reset-attr="open" open><summary>More</summary></details>`);
      expect(query("#d").hasAttribute("open")).toBe(true);
      expect(seen.count).toBe(0);
    });

    it("is not reset by turbo:before-cache, which Turbo also dispatches on pages that stay", async () => {
      await start(`<input id="i" data-reset-value value="seed">`);
      const input = query<HTMLInputElement>("#i");
      input.value = "typed";
      const seen = countResets();

      document.dispatchEvent(new Event("turbo:before-cache"));

      expect(input.value).toBe("typed");
      expect(seen.count).toBe(0);
    });

    it("is not reset when its element moves within the page or is carried to the next one", async () => {
      await start(`<input id="i" data-reset-value value="seed">`);
      const input = query<HTMLInputElement>("#i");
      input.value = "typed";
      const seen = countResets();
      const instance = controller();

      instance.disconnect();
      instance.connect();

      expect(input.value).toBe("typed");
      expect(seen.count).toBe(0);
    });

    it("stops writing the mark back after a morph once disconnected", async () => {
      await start(`<div></div>`);
      controller().disconnect();
      root().removeAttribute("data-stimeo--reset-on-restore-lived");
      root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      await flushMicrotasks();
      expect(root().hasAttribute("data-stimeo--reset-on-restore-lived")).toBe(false);
    });

    it("keeps the mark after the controller disconnects", async () => {
      await start(`<div></div>`);
      controller().disconnect();
      expect(root().hasAttribute("data-stimeo--reset-on-restore-lived")).toBe(true);
    });
  });

  it("removes the listed attributes", async () => {
    await start(`
      <details data-reset-attr="open"><summary>More</summary></details>
      <button data-reset-attr="aria-expanded" aria-expanded="true">Menu</button>`);
    query("details").setAttribute("open", "");
    sweep();
    expect(query("details").hasAttribute("open")).toBe(false);
    expect(query("button").hasAttribute("aria-expanded")).toBe(false);
  });

  it("removes the listed classes, keeping the others", async () => {
    await start(`
      <div data-reset-class="is-open is-loading" class="card is-open is-loading"></div>`);
    sweep();
    const el = query("div[data-reset-class]");
    expect(el.classList.contains("is-open")).toBe(false);
    expect(el.classList.contains("is-loading")).toBe(false);
    // Author classes outside the reset list are preserved.
    expect(el.classList.contains("card")).toBe(true);
  });

  it("is a no-op for a reset class that is not present", async () => {
    await start(`<div data-reset-class="is-open" class="card"></div>`);
    sweep();
    expect(query("div[data-reset-class]").getAttribute("class")).toBe("card");
  });

  it("resets forms back to their initial values", async () => {
    await start(`<form data-reset-form><input id="i" name="q" value=""></form>`);
    const input = query<HTMLInputElement>("#i");
    input.value = "typed";
    sweep();
    expect(input.value).toBe("");
  });

  it("returns a standalone field to the value the author wrote", async () => {
    // A reset restores the initial state, and for a text field that state is the
    // authored value — discarding it would destroy markup the page shipped with.
    await start(`<input id="i" data-reset-value value="seed">`);
    const input = query<HTMLInputElement>("#i");
    input.value = "changed";
    sweep();
    expect(input.value).toBe("seed");
  });

  it("returns a checkbox to its authored checkedness without touching its value", async () => {
    // The value of a checkbox is what it submits, not what the user changed; the
    // transient part is the checkedness.
    await start(`<input id="c" type="checkbox" data-reset-value value="agree" checked>`);
    const box = query<HTMLInputElement>("#c");
    box.checked = false;
    sweep();
    expect(box.checked).toBe(true);
    expect(box.getAttribute("value")).toBe("agree");
  });

  it("returns a radio to its authored checkedness", async () => {
    await start(`
      <input id="r1" type="radio" name="g" data-reset-value value="a" checked>
      <input id="r2" type="radio" name="g" data-reset-value value="b">`);
    query<HTMLInputElement>("#r2").checked = true;
    sweep();
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
    sweep();
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
    sweep();
    expect(Array.from(select.selectedOptions).map((option) => option.value)).toEqual(["a", "b"]);
  });

  it("leaves a field that carries no user state alone", async () => {
    // A hidden field holds a value the page shipped, never one the user typed;
    // writing to it would rewrite the markup instead of restoring it. The second
    // field has no value at all, and writing its default back would give it one.
    await start(`
      <input id="h" type="hidden" data-reset-value value="token-1">
      <input id="n" type="hidden" data-reset-value>`);
    sweep();
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
    sweep();
    expect(textarea.value).toBe("");
    expect(select.value).toBe("");
  });

  it("re-hides elements marked data-reset-hidden", async () => {
    await start(`<div id="overlay" data-reset-hidden>overlay</div>`);
    const overlay = query("#overlay");
    overlay.hidden = false;
    sweep();
    expect(overlay.hidden).toBe(true);
  });

  it("removes elements marked data-reset-remove", async () => {
    await start(`<div id="flash" data-reset-remove>flash</div>`);
    sweep();
    expect(document.getElementById("flash")).toBeNull();
  });

  it("reports reset once the sweep is done", async () => {
    await start(`<button id="a" data-reset-attr="aria-expanded" aria-expanded="true"></button>`);
    const seen: (string | null)[] = [];
    root().addEventListener("stimeo--reset-on-restore:reset", () => {
      seen.push(query("#a").getAttribute("aria-expanded"));
    });
    sweep();
    expect(seen).toEqual([null]);
  });

  it("carries an empty detail on the reset event", async () => {
    await start(`<div data-reset-attr="open"></div>`);
    const details: unknown[] = [];
    root().addEventListener("stimeo--reset-on-restore:reset", (event) => {
      details.push((event as CustomEvent).detail);
    });

    sweep();

    expect(details).toEqual([{}]);
  });

  it("only resets within the configured scope", async () => {
    await start(
      `
      <div class="inside"><button id="a" data-reset-attr="aria-expanded" aria-expanded="true"></button></div>
      <div class="outside"><button id="b" data-reset-attr="aria-expanded" aria-expanded="true"></button></div>`,
      `data-stimeo--reset-on-restore-scope-value=".inside"`,
    );
    sweep();
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
      `data-stimeo--reset-on-restore-scope-value=".does-not-exist"`,
    );
    sweep();
    expect(query("#a").hasAttribute("aria-expanded")).toBe(false);
  });

  it("keeps sweeping when the scope declaration cannot be parsed", async () => {
    // A declaration the engine cannot read must not take the sweep down with it:
    // this part exists to keep a restored page from showing a stale interaction, and a
    // typo in one attribute would otherwise disable that for the whole document.
    await start(
      `<button id="a" data-reset-attr="aria-expanded" aria-expanded="true"></button>`,
      `data-stimeo--reset-on-restore-scope-value="#panel["`,
    );
    sweep();
    expect(query("#a").hasAttribute("aria-expanded")).toBe(false);
  });

  it("is idempotent across repeated runs", async () => {
    await start(`<details data-reset-attr="open" open><summary>x</summary></details>`);
    sweep();
    sweep();
    expect(query("details").hasAttribute("open")).toBe(false);
  });

  it("can be triggered manually via the reset action", async () => {
    await start(`<button id="m" data-reset-attr="aria-expanded" aria-expanded="true"></button>`);
    controller().reset();
    expect(query("#m").hasAttribute("aria-expanded")).toBe(false);
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(`<details data-reset-attr="open"><summary>More</summary><p>Body</p></details>`);
    await expectNoA11yViolations(document.body);
  });
});
