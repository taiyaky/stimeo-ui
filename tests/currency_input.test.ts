import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { CurrencyInputController } from "../src/controllers/currency_input_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link CurrencyInputController}: digit grouping on input,
 * fixed-precision rounding on blur, stripping of invalid characters, the
 * display ↔ hidden-field ↔ screen-reader-span sync, and the `change` event.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CurrencyInputController", () => {
  let application: Application;

  const mount = async ({ precision = 2, currency = "", value = "" } = {}) => {
    document.body.innerHTML = `
      <div data-controller="stimeo--currency-input"
           data-stimeo--currency-input-locale-value="en-US"
           data-stimeo--currency-input-currency-value="${currency}"
           data-stimeo--currency-input-precision-value="${precision}">
        <label for="amount">Amount</label>
        <input id="amount" type="text" inputmode="decimal"
               aria-describedby="amount-sr"
               value="${value}"
               data-stimeo--currency-input-target="display"
               data-action="input->stimeo--currency-input#onInput
                            blur->stimeo--currency-input#format" />
        <span id="amount-sr" class="visually-hidden"
              data-stimeo--currency-input-target="srValue"></span>
        <input type="hidden" data-stimeo--currency-input-target="field" />
      </div>`;
    application = Application.start();
    application.register("stimeo--currency-input", CurrencyInputController);
    await tick();
  };

  afterEach(() => {
    application?.stop();
    document.body.innerHTML = "";
  });

  const display = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--currency-input-target='display']",
    ) as HTMLInputElement;
  const field = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--currency-input-target='field']",
    ) as HTMLInputElement;
  const srValue = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--currency-input-target='srValue']",
    ) as HTMLElement;
  const root = () =>
    document.querySelector<HTMLElement>(
      "[data-controller='stimeo--currency-input']",
    ) as HTMLElement;

  const type = (text: string) => {
    display().value = text;
    display().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const blur = () => display().dispatchEvent(new Event("blur", { bubbles: true }));

  it("groups digits as the user types and keeps the field unformatted", async () => {
    await mount();
    type("1234567");
    expect(display().value).toBe("1,234,567");
    expect(field().value).toBe("1234567");
  });

  it("strips invalid characters before parsing", async () => {
    await mount();
    type("ab1,2c3,4d.5x");
    expect(field().value).toBe("1234.5");
    expect(display().value).toBe("1,234.5");
  });

  it("applies fixed precision on blur", async () => {
    await mount();
    type("1234.5");
    blur();
    expect(display().value).toBe("1,234.50");
    expect(field().value).toBe("1234.5");
  });

  it("rounds to the configured precision on blur", async () => {
    await mount({ precision: 0 });
    type("1234.6");
    blur();
    expect(display().value).toBe("1,235");
    expect(field().value).toBe("1235");
  });

  it("normalizes a pre-filled value on connect", async () => {
    await mount({ value: "9999.9" });
    expect(display().value).toBe("9,999.90");
    expect(field().value).toBe("9999.9");
  });

  it("clears the field and sets the empty hook when emptied", async () => {
    await mount();
    type("12");
    expect(root().hasAttribute("data-stimeo--currency-input-empty")).toBe(false);
    type("");
    expect(field().value).toBe("");
    expect(srValue().textContent).toBe("");
    expect(root().hasAttribute("data-stimeo--currency-input-empty")).toBe(true);
  });

  it("mirrors a currency-formatted value to the screen-reader span", async () => {
    await mount({ currency: "USD" });
    type("1234");
    expect(srValue().textContent).toBe("$1,234.00");
  });

  it("dispatches change only when the numeric value changes", async () => {
    await mount();
    const values: number[] = [];
    root().addEventListener("stimeo--currency-input:change", (e) => {
      values.push((e as CustomEvent).detail.value);
    });
    type("1234");
    type("1,234"); // same number, regrouped — no new event
    blur(); // 1234 → still 1234 after rounding — no new event
    expect(values).toEqual([1234]);
  });

  it("does not dispatch change on connect when the initial value rounds", async () => {
    const values: number[] = [];
    const onChange = (e: Event) => values.push((e as CustomEvent).detail.value);
    // The controller dispatches on its root element, which doesn't exist until
    // mount; listen on document (and clean up) to catch any connect-time event.
    document.addEventListener("stimeo--currency-input:change", onChange);
    try {
      // 1234.567 rounds to 1234.57 at connect; that re-format is idempotent and
      // must not surface as a user-driven change event.
      await mount({ value: "1234.567" });
      expect(display().value).toBe("1,234.57");
      expect(values).toEqual([]);
    } finally {
      document.removeEventListener("stimeo--currency-input:change", onChange);
    }
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount({ value: "1234" });
    await expectNoA11yViolations(root());
  });

  // Layer ③ — speech-order regression. The grouped display string is for sighted
  // users; assistive tech must hear the *normalized* value via the srValue span
  // referenced by aria-describedby. Capturing the field's announcement pins the
  // textbox role, its accessible name, and that the described value rides along.
  it("announces the textbox role, name, and the normalized described value", async () => {
    await mount({ currency: "USD", value: "1234" });
    const spoken = await captureSpeech({ container: display(), steps: 0 });
    // role "textbox", accessible name "Amount", the grouped display value, then
    // the described value ("$1,234.00") sourced from the srValue span.
    expect(spoken).toEqual(["textbox, Amount, 1,234.00, $1,234.00"]);
  });
});
