import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { applyMask, InputMaskController } from "../src/controllers/input_mask_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link InputMaskController} and the pure {@link applyMask}:
 * sequential formatting, character rejection, the complete/empty flags, raw-value
 * sync to the hidden field (incl. nearest-container and by-id pairing for several
 * masks in one form), caret position, custom token merge, the change event, and
 * idempotent connect.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Builds a token map like the controller compiles internally. */
const tokenMap = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([k, v]) => [k, new RegExp(`^(?:${v})$`)]));

const NUMERIC = tokenMap({ "9": "\\d", a: "[A-Za-z]", "*": "[A-Za-z0-9]" });

describe("applyMask", () => {
  it("formats a fixed numeric pattern and reports complete", () => {
    const result = applyMask("1234567", "999-9999", NUMERIC);
    expect(result.masked).toBe("123-4567");
    expect(result.unmasked).toBe("1234567");
    expect(result.complete).toBe(true);
  });

  it("rejects characters that do not match the token", () => {
    const result = applyMask("1a2b3", "999", NUMERIC);
    expect(result.masked).toBe("123");
    expect(result.unmasked).toBe("123");
  });

  it("reports incomplete until every token slot is filled", () => {
    expect(applyMask("12", "999-9999", NUMERIC).complete).toBe(false);
  });

  it("is idempotent on an already-masked value", () => {
    const once = applyMask("1234567", "999-9999", NUMERIC).masked;
    expect(applyMask(once, "999-9999", NUMERIC).masked).toBe("123-4567");
  });
});

describe("InputMaskController", () => {
  let application: Application;

  const start = async (markup: string) => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--input-mask", InputMaskController);
    await tick();
  };

  afterEach(() => {
    application?.stop();
    document.body.innerHTML = "";
  });

  const ZIP = `
    <input id="i" type="text" data-controller="stimeo--input-mask"
           data-stimeo--input-mask-pattern-value="999-9999"
           data-action="input->stimeo--input-mask#format">
    <input id="hidden" type="hidden" data-stimeo--input-mask-unmask>`;

  const input = () => query<HTMLInputElement>("#i");
  const hidden = () => query<HTMLInputElement>("#hidden");

  /** Simulates the user having typed `value`, firing the input event. */
  const type = (value: string) => {
    const field = input();
    field.value = value;
    field.setSelectionRange(value.length, value.length);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("formats the value against the pattern on input", async () => {
    await start(ZIP);
    type("1234567");
    expect(input().value).toBe("123-4567");
  });

  it("inserts the separator as the user types past it", async () => {
    await start(ZIP);
    type("1234");
    expect(input().value).toBe("123-4");
  });

  it("rejects characters the token does not allow", async () => {
    await start(ZIP);
    type("12ab3");
    expect(input().value).toBe("123");
  });

  it("syncs the raw value to the hidden unmask field", async () => {
    await start(ZIP);
    type("1234567");
    expect(hidden().value).toBe("1234567");
  });

  /** Simulates typing `value` into the field matching `selector`. */
  const fill = (selector: string, value: string) => {
    const field = query<HTMLInputElement>(selector);
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("pairs each masked input with the sink in its own container", async () => {
    await start(`
      <form>
        <div>
          <input id="zip" type="text" data-controller="stimeo--input-mask"
                 data-stimeo--input-mask-pattern-value="999-9999"
                 data-action="input->stimeo--input-mask#format">
          <input id="zip-raw" type="hidden" data-stimeo--input-mask-unmask>
        </div>
        <div>
          <input id="tel" type="text" data-controller="stimeo--input-mask"
                 data-stimeo--input-mask-pattern-value="99-99"
                 data-action="input->stimeo--input-mask#format">
          <input id="tel-raw" type="hidden" data-stimeo--input-mask-unmask>
        </div>
      </form>`);
    fill("#zip", "1234567");
    fill("#tel", "1234");

    // Each mask writes its own wrapper's sink — no cross-write to the first match.
    expect(query<HTMLInputElement>("#zip-raw").value).toBe("1234567");
    expect(query<HTMLInputElement>("#tel-raw").value).toBe("1234");
  });

  it("pairs a flat form's sinks by naming the input's id", async () => {
    await start(`
      <form>
        <input id="zip" type="text" data-controller="stimeo--input-mask"
               data-stimeo--input-mask-pattern-value="999-9999"
               data-action="input->stimeo--input-mask#format">
        <input id="zip-raw" type="hidden" data-stimeo--input-mask-unmask="zip">
        <input id="tel" type="text" data-controller="stimeo--input-mask"
               data-stimeo--input-mask-pattern-value="99-99"
               data-action="input->stimeo--input-mask#format">
        <input id="tel-raw" type="hidden" data-stimeo--input-mask-unmask="tel">
      </form>`);
    // tel resolves its own sink even though zip's sink comes first in the form.
    fill("#tel", "1234");

    expect(query<HTMLInputElement>("#tel-raw").value).toBe("1234");
    expect(query<HTMLInputElement>("#zip-raw").value).toBe("");
  });

  it("never claims a sink paired to a different input", async () => {
    await start(`
      <form>
        <input id="tel" type="text" data-controller="stimeo--input-mask"
               data-stimeo--input-mask-pattern-value="99-99"
               data-action="input->stimeo--input-mask#format">
        <input id="zip-raw" type="hidden" data-stimeo--input-mask-unmask="zip">
      </form>`);
    fill("#tel", "1234");

    expect(query<HTMLInputElement>("#zip-raw").value).toBe("");
  });

  it("reflects data-mask-complete and data-mask-empty", async () => {
    await start(ZIP);
    type("");
    expect(input().getAttribute("data-mask-empty")).toBe("true");
    type("1234567");
    expect(input().getAttribute("data-mask-complete")).toBe("true");
    expect(input().hasAttribute("data-mask-empty")).toBe(false);
  });

  it("keeps the caret at the end while typing sequentially", async () => {
    await start(ZIP);
    type("1234");
    // "123-4": caret sits after the 4th digit (index 5).
    expect(input().selectionStart).toBe(5);
  });

  it("dispatches change with masked, unmasked, and complete", async () => {
    await start(ZIP);
    const log: Array<{ masked: string; unmasked: string; complete: boolean }> = [];
    input().addEventListener("stimeo--input-mask:change", (e) => {
      log.push((e as CustomEvent<{ masked: string; unmasked: string; complete: boolean }>).detail);
    });
    type("1234567");
    expect(log).toEqual([{ masked: "123-4567", unmasked: "1234567", complete: true }]);
  });

  it("merges custom tokens over the defaults", async () => {
    await start(`
      <input id="i" type="text" data-controller="stimeo--input-mask"
             data-stimeo--input-mask-pattern-value="HH:HH"
             data-stimeo--input-mask-tokens-value='{"H":"[0-9A-Fa-f]"}'
             data-action="input->stimeo--input-mask#format">`);
    type("1a2g3");
    // 'g' is not a hex digit → rejected; the colon literal is auto-inserted.
    expect(input().value).toBe("1a:23");
  });

  it("leaves the value untouched when no pattern is configured", async () => {
    await start(`
      <input id="i" type="text" value="anything goes 123"
             data-controller="stimeo--input-mask"
             data-action="input->stimeo--input-mask#format">`);
    // A missing pattern must not blank the field on connect…
    expect(input().value).toBe("anything goes 123");
    type("more text 456");
    // …nor on input.
    expect(input().value).toBe("more text 456");
  });

  it("re-formats an existing value idempotently on connect", async () => {
    await start(`
      <input id="i" type="text" value="123-4567" data-controller="stimeo--input-mask"
             data-stimeo--input-mask-pattern-value="999-9999"
             data-action="input->stimeo--input-mask#format">`);
    expect(input().value).toBe("123-4567");
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(`
      <main>
        <label for="zip">Zip</label>
        <input id="zip" type="text" data-controller="stimeo--input-mask"
               data-stimeo--input-mask-pattern-value="999-9999"
               data-action="input->stimeo--input-mask#format">
      </main>`);
    await expectNoA11yViolations(document.body);
  });
});
