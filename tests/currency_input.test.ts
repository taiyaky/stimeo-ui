import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CurrencyInputController } from "../src/controllers/currency_input_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link CurrencyInputController}: keystroke-level entry
 * (in-progress signs, decimal marks, and fraction digits survive every
 * reformat), digit grouping with caret preservation, fixed-precision rounding
 * on blur, locale-aware parsing that round-trips the controller's own output,
 * full-width normalization, IME composition holds, Value validation fallbacks,
 * runtime Value changes, formatter caching, the display ↔ hidden-field ↔
 * screen-reader-span sync (including late targets), and the `change` event
 * with its `null` clear transition.
 */

describe("CurrencyInputController", () => {
  let application: Application;

  const mount = async ({ locale = "en-US", precision = 2, currency = "", value = "" } = {}) => {
    document.body.innerHTML = `
      <div data-controller="stimeo--currency-input"
           data-stimeo--currency-input-locale-value="${locale}"
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

  /** Mounts without any Value attributes so the declared defaults are exercised. */
  const mountBare = async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--currency-input">
        <label for="amount">Amount</label>
        <input id="amount" type="text" aria-describedby="amount-sr"
               data-stimeo--currency-input-target="display"
               data-action="input->stimeo--currency-input#onInput
                            blur->stimeo--currency-input#format" />
        <span id="amount-sr" data-stimeo--currency-input-target="srValue"></span>
        <input type="hidden" data-stimeo--currency-input-target="field" />
      </div>`;
    application = Application.start();
    application.register("stimeo--currency-input", CurrencyInputController);
    await tick();
  };

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    vi.restoreAllMocks();
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

  /** Paste-style entry: the whole string arrives in one input event. */
  const type = (text: string) => {
    display().value = text;
    display().dispatchEvent(new Event("input", { bubbles: true }));
  };
  /** Inserts one character at the caret, like a real keystroke. */
  const press = (ch: string) => {
    const el = display();
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.value = el.value.slice(0, start) + ch + el.value.slice(end);
    el.setSelectionRange(start + ch.length, start + ch.length);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const typeKeys = (text: string) => {
    for (const ch of text) press(ch);
  };
  const blur = () => display().dispatchEvent(new Event("blur", { bubbles: true }));

  it("groups digits as the user types and keeps the field unformatted", async () => {
    await mount();
    typeKeys("1234567");
    expect(display().value).toBe("1,234,567");
    expect(field().value).toBe("1234567");
    // The caret rides along: right after the last typed digit.
    expect(display().selectionStart).toBe("1,234,567".length);
  });

  it("keeps an in-progress decimal entry intact keystroke by keystroke", async () => {
    await mount();
    typeKeys("12.50");
    expect(display().value).toBe("12.50");
    expect(field().value).toBe("12.5");
    blur();
    expect(display().value).toBe("12.50");
    expect(field().value).toBe("12.5");
  });

  it("keeps the caret behind a freshly typed decimal mark", async () => {
    await mount();
    typeKeys("1.");
    expect(display().value).toBe("1.");
    expect(display().selectionStart).toBe(2);
    press("5");
    expect(display().value).toBe("1.5");
    expect(field().value).toBe("1.5");
  });

  it("keeps a leading sign while a negative amount is typed", async () => {
    await mount();
    press("-");
    // The sign alone is an entry in progress, not a value yet.
    expect(display().value).toBe("-");
    expect(field().value).toBe("");
    expect(root().hasAttribute("data-stimeo--currency-input-empty")).toBe(true);
    typeKeys("50");
    expect(display().value).toBe("-50");
    expect(field().value).toBe("-50");
    blur();
    expect(display().value).toBe("-50.00");
    expect(field().value).toBe("-50");
  });

  it("preserves the caret when inserting into the middle of a grouped number", async () => {
    await mount();
    typeKeys("1234");
    expect(display().value).toBe("1,234");
    display().setSelectionRange(3, 3); // between the 2 and the 3
    press("9");
    expect(display().value).toBe("12,934");
    // Right after the typed 9: "12,9|34".
    expect(display().selectionStart).toBe(4);
  });

  it("keeps typed fraction digits verbatim and rounds only on blur", async () => {
    await mount();
    typeKeys("1.239");
    expect(display().value).toBe("1.239");
    expect(field().value).toBe("1.239");
    blur();
    expect(display().value).toBe("1.24");
    expect(field().value).toBe("1.24");
  });

  it("keeps a decimal entry intact at precision 0 and rounds it away on blur", async () => {
    await mount({ precision: 0 });
    typeKeys("1.5");
    // The mark must not vanish mid-entry (the digits would merge into 15).
    expect(display().value).toBe("1.5");
    expect(field().value).toBe("1.5");
    blur();
    expect(display().value).toBe("2");
    expect(field().value).toBe("2");
  });

  it("round-trips its own output in a locale whose grouping separator is a dot", async () => {
    await mount({ locale: "de-DE" });
    typeKeys("1234,56");
    expect(display().value).toBe("1.234,56");
    expect(field().value).toBe("1234.56");
    // Re-parsing the grouped output must not shrink the value.
    type(display().value);
    expect(field().value).toBe("1234.56");
    blur();
    expect(display().value).toBe("1.234,56");
  });

  it("reads U+2212 MINUS SIGN as a sign", async () => {
    await mount();
    type("−50");
    expect(field().value).toBe("-50");
    expect(display().value).toBe("-50");
  });

  it("normalizes full-width digits and marks instead of stripping them", async () => {
    await mount();
    type("１２３４．５");
    expect(display().value).toBe("1,234.5");
    expect(field().value).toBe("1234.5");
  });

  it("holds mid-composition input and formats the confirmed text once", async () => {
    await mount();
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    display().value = "1234ｋ";
    display().dispatchEvent(new Event("input", { bubbles: true }));
    // The IME still owns the text: nothing may rewrite it mid-composition.
    expect(display().value).toBe("1234ｋ");
    display().value = "１２３４";
    display().dispatchEvent(new Event("compositionend", { bubbles: true }));
    // The confirmed text is normalized and grouped in one pass.
    expect(display().value).toBe("1,234");
    expect(field().value).toBe("1234");
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

  it("clears an abandoned sign on blur", async () => {
    await mount();
    press("-");
    blur();
    expect(display().value).toBe("");
    expect(root().hasAttribute("data-stimeo--currency-input-empty")).toBe(true);
  });

  it("normalizes a pre-filled value on connect", async () => {
    await mount({ value: "9999.9" });
    expect(display().value).toBe("9,999.90");
    expect(field().value).toBe("9999.9");
    expect(srValue().textContent).toBe("9,999.90");
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
    const values: Array<number | null> = [];
    root().addEventListener("stimeo--currency-input:change", (e) => {
      values.push((e as CustomEvent).detail.value);
    });
    type("1234");
    type("1,234"); // same number, regrouped — no new event
    blur(); // 1234 → still 1234 after rounding — no new event
    expect(values).toEqual([1234]);
  });

  it("pins the change detail shape and reports a clear as null", async () => {
    await mount();
    const details: Array<{ value: number | null; formatted: string }> = [];
    root().addEventListener("stimeo--currency-input:change", (e) => {
      details.push((e as CustomEvent).detail);
    });
    typeKeys("12");
    type("");
    typeKeys("12"); // the same number fires again after a round trip through empty
    expect(details).toEqual([
      { value: 1, formatted: "1" },
      { value: 12, formatted: "12" },
      { value: null, formatted: "" },
      { value: 1, formatted: "1" },
      { value: 12, formatted: "12" },
    ]);
  });

  it("does not dispatch change on connect when the initial value rounds", async () => {
    const values: Array<number | null> = [];
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

  it("exercises the declared Value defaults when no attributes are authored", async () => {
    await mountBare();
    typeKeys("1234.5");
    expect(display().value).toBe("1,234.5"); // en-US grouping by default
    blur();
    expect(display().value).toBe("1,234.50"); // precision 2 by default
    expect(srValue().textContent).toBe("1,234.50"); // no currency by default
  });

  it("falls back to the Value defaults on malformed declarations and stays alive", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    document.body.innerHTML = `
      <div data-controller="stimeo--currency-input"
           data-stimeo--currency-input-locale-value="en_US"
           data-stimeo--currency-input-currency-value="US"
           data-stimeo--currency-input-precision-value="-1">
        <label for="amount">Amount</label>
        <input id="amount" type="text" value="1234.5"
               data-stimeo--currency-input-target="display"
               data-action="input->stimeo--currency-input#onInput
                            blur->stimeo--currency-input#format" />
        <span data-stimeo--currency-input-target="srValue"></span>
        <input type="hidden" data-stimeo--currency-input-target="field" />
      </div>`;
    application = Application.start();
    application.register("stimeo--currency-input", CurrencyInputController);
    await tick();
    // No RangeError reached Stimulus; the element is alive on the defaults.
    expect(error).not.toHaveBeenCalled();
    expect(display().value).toBe("1,234.50"); // en-US, precision 2
    expect(field().value).toBe("1234.5");
    expect(srValue().textContent).toBe("1,234.50"); // invalid currency → plain number
    type("1234.56");
    expect(field().value).toBe("1234.56"); // the input path stays alive
  });

  it("re-renders when locale, currency, or precision change at runtime", async () => {
    await mount({ value: "1234.5", currency: "USD" });
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    await tick();
    expect(display().value).toBe("1.234,50");
    expect(srValue().textContent).toContain("1.234,50"); // de-DE currency text
    root().setAttribute("data-stimeo--currency-input-precision-value", "0");
    await tick();
    expect(display().value).toBe("1.235");
    root().setAttribute("data-stimeo--currency-input-currency-value", "");
    await tick();
    expect(srValue().textContent).toBe("1.235");
  });

  it("builds no formatter on the typing hot path", async () => {
    await mount();
    const constructed = vi.spyOn(Intl, "NumberFormat");
    typeKeys("123456");
    blur();
    // Formatters are cached per Value set; keystrokes reuse them.
    expect(constructed).not.toHaveBeenCalled();
  });

  it("syncs a late-arriving field silently", async () => {
    await mount();
    typeKeys("1234");
    field().remove();
    srValue().remove();
    const events: unknown[] = [];
    root().addEventListener("stimeo--currency-input:change", (event) => events.push(event));
    const lateField = document.createElement("input");
    lateField.type = "hidden";
    lateField.setAttribute("data-stimeo--currency-input-target", "field");
    root().appendChild(lateField);
    await tick();
    expect(lateField.value).toBe("1234");
    expect(events).toHaveLength(0);
  });

  it("syncs a late-arriving screen-reader span silently", async () => {
    await mount();
    typeKeys("1234");
    srValue().remove();
    const events: unknown[] = [];
    root().addEventListener("stimeo--currency-input:change", (event) => events.push(event));
    const lateSr = document.createElement("span");
    lateSr.setAttribute("data-stimeo--currency-input-target", "srValue");
    root().appendChild(lateSr);
    await tick();
    expect(lateSr.textContent).toBe("1,234.00");
    expect(events).toHaveLength(0);
  });

  it("normalizes a swapped-in display and keeps working through it", async () => {
    await mount();
    typeKeys("1234");
    const replacement = document.createElement("input");
    replacement.type = "text";
    replacement.value = "5678.9";
    replacement.setAttribute("data-stimeo--currency-input-target", "display");
    replacement.setAttribute(
      "data-action",
      "input->stimeo--currency-input#onInput blur->stimeo--currency-input#format",
    );
    display().replaceWith(replacement);
    await tick();
    // The arriving display is normalized like a pre-filled value.
    expect(replacement.value).toBe("5,678.90");
    expect(field().value).toBe("5678.9");
  });

  it("keeps resyncing safe after the display itself is removed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await mount();
    typeKeys("1234");
    display().remove();
    const lateField = document.createElement("input");
    lateField.type = "hidden";
    lateField.setAttribute("data-stimeo--currency-input-target", "field");
    root().appendChild(lateField);
    await tick();
    expect(error).not.toHaveBeenCalled();
  });

  it("stays inert without a display target, even for late siblings", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    document.body.innerHTML = `
      <div data-controller="stimeo--currency-input">
        <input type="hidden" data-stimeo--currency-input-target="field" />
      </div>`;
    application = Application.start();
    application.register("stimeo--currency-input", CurrencyInputController);
    await tick();
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--currency-input",
    ) as CurrencyInputController;
    expect(() => controller.format()).not.toThrow();
    const lateSr = document.createElement("span");
    lateSr.setAttribute("data-stimeo--currency-input-target", "srValue");
    root().appendChild(lateSr);
    await tick();
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps target arrival and connect silent for a locale-authored value", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const values: Array<number | null> = [];
    const onChange = (e: Event) => values.push((e as CustomEvent).detail.value);
    document.addEventListener("stimeo--currency-input:change", onChange);
    try {
      // "1,5" is 1.5 only under de-DE separators; a premature sync reading it
      // under the defaults would surface a wrong 15 before connect seeds it.
      await mount({ locale: "de-DE", value: "1,5" });
      expect(display().value).toBe("1,50");
      expect(field().value).toBe("1.5");
      expect(values).toEqual([]);
      expect(error).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("stimeo--currency-input:change", onChange);
    }
  });

  it("dispatches the first zero typed into an empty input, and nothing at connect", async () => {
    const details: Array<{ value: number | null; formatted: string }> = [];
    const onChange = (e: Event) => details.push((e as CustomEvent).detail);
    document.addEventListener("stimeo--currency-input:change", onChange);
    try {
      await mount();
      expect(details).toEqual([]); // an empty mount announces nothing
      press("0");
      expect(details).toEqual([{ value: 0, formatted: "0" }]);
    } finally {
      document.removeEventListener("stimeo--currency-input:change", onChange);
    }
  });

  it("skips the caret restore when the host reports no selection", async () => {
    await mount();
    Object.defineProperty(display(), "selectionStart", { configurable: true, get: () => null });
    const restore = vi.spyOn(display(), "setSelectionRange");
    type("1234");
    expect(display().value).toBe("1,234");
    expect(restore).not.toHaveBeenCalled();
  });

  it("survives a host that rejects selection changes", async () => {
    await mount();
    vi.spyOn(display(), "setSelectionRange").mockImplementation(() => {
      throw new Error("selection not allowed");
    });
    expect(() => type("1234")).not.toThrow();
    expect(display().value).toBe("1,234");
    expect(field().value).toBe("1234");
  });

  it("anchors the caret after the sign when deletion regroups the number", async () => {
    await mount();
    typeKeys("-1999");
    expect(display().value).toBe("-1,999");
    // Backspace at position 2 deletes the leading digit: "-,999" with caret 1.
    display().value = "-,999";
    display().setSelectionRange(1, 1);
    display().dispatchEvent(new Event("input", { bubbles: true }));
    expect(display().value).toBe("-999");
    expect(display().selectionStart).toBe(1); // just after the sign, not before it
  });

  it("treats digit runs beyond Number's range as no value", async () => {
    await mount();
    type("9".repeat(320));
    expect(field().value).toBe("");
    expect(root().hasAttribute("data-stimeo--currency-input-empty")).toBe(true);
  });

  it("never leaves a negative zero after rounding", async () => {
    await mount({ precision: 0 });
    const values: Array<number | null> = [];
    root().addEventListener("stimeo--currency-input:change", (e) => {
      values.push((e as CustomEvent).detail.value);
    });
    type("-0.4");
    blur();
    expect(display().value).toBe("0");
    expect(field().value).toBe("0");
    expect(values.at(-1)).toBe(0); // Object.is: -0 would fail here
  });

  it("re-parses its own output in a locale with a non-Latin numbering system", async () => {
    await mount({ locale: "ar-EG", value: "1234" });
    // The display shows the locale's own digits; the machine value survives.
    expect(field().value).toBe("1234");
    const rendered = display().value;
    expect(rendered).not.toContain("1"); // arab digits, not ASCII
    // A Turbo restore re-connects over that very output without losing it.
    type(rendered);
    expect(field().value).toBe("1234");
    // An ASCII keystroke merges into the fraction like in any other locale.
    press("5");
    expect(field().value).toBe("1234.005");
  });

  it("pairs a null value with an empty formatted even while a sign is displayed", async () => {
    await mount();
    const details: Array<{ value: number | null; formatted: string }> = [];
    root().addEventListener("stimeo--currency-input:change", (e) => {
      details.push((e as CustomEvent).detail);
    });
    press("5");
    display().setSelectionRange(0, 1); // select all…
    press("-"); // …and overtype with a lone sign
    expect(display().value).toBe("-");
    expect(details).toEqual([
      { value: 5, formatted: "5" },
      { value: null, formatted: "" }, // never { null, "-" }
    ]);
  });

  it("adopts a late-arriving display after a display-less connect", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--currency-input">
        <input type="hidden" data-stimeo--currency-input-target="field" />
      </div>`;
    application = Application.start();
    application.register("stimeo--currency-input", CurrencyInputController);
    await tick();
    const late = document.createElement("input");
    late.type = "text";
    late.value = "1234.5";
    late.setAttribute("data-stimeo--currency-input-target", "display");
    late.setAttribute(
      "data-action",
      "input->stimeo--currency-input#onInput blur->stimeo--currency-input#format",
    );
    root().appendChild(late);
    await tick();
    expect(late.value).toBe("1,234.50");
    expect(field().value).toBe("1234.5");
  });

  it("keeps the caret in place when a keystroke is rejected", async () => {
    await mount();
    typeKeys("1234");
    expect(display().value).toBe("1,234");
    display().setSelectionRange(3, 3); // "1,2|34"
    press("-"); // a mid-string sign is not accepted
    expect(display().value).toBe("1,234");
    expect(display().selectionStart).toBe(3); // no jump past the rejection
    display().setSelectionRange(2, 2);
    press("."); // first decimal mark is accepted: "1,.234" → "1.234"? no — scan: 1 then dot…
    expect(field().value).toBe("1.234");
  });

  it("rejects a second decimal mark without moving the caret to the end", async () => {
    await mount();
    typeKeys("1.5");
    display().setSelectionRange(2, 2); // "1.|5"
    press(".");
    expect(display().value).toBe("1.5");
    expect(display().selectionStart).toBe(2); // stays mid-string
  });

  it("keeps blur finite when rounding would overflow", async () => {
    await mount();
    type("9".repeat(307)); // finite (~1e307), but value*100 would overflow
    blur();
    expect(display().value).not.toContain("∞");
    expect(field().value).not.toBe("Infinity");
    expect(Number.isFinite(Number(field().value))).toBe(true);
  });

  it("accepts a leading plus sign and drops it at the fixed format", async () => {
    await mount();
    typeKeys("+50");
    expect(display().value).toBe("+50");
    expect(field().value).toBe("50");
    blur();
    expect(display().value).toBe("50.00");
  });

  it("falls back when precision exceeds Intl's ceiling", async () => {
    await mount({ precision: 101, value: "1234.5" });
    // 101 is outside Intl's 0–100 range: the default (2) applies instead.
    expect(display().value).toBe("1,234.50");
  });

  it("preserves the typing state when a Value changes mid-entry", async () => {
    await mount();
    display().focus();
    typeKeys("1.");
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    await tick();
    // The in-progress entry survives; only the mark is re-localized.
    expect(display().value).toBe("1,");
    expect(field().value).toBe("1");
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount({ value: "1234" });
    await expectNoA11yViolations(root());
  });

  // Speech-order regression. The grouped display string is for sighted users;
  // assistive tech must hear the *normalized* value via the srValue span
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
