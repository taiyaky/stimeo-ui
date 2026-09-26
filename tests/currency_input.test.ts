import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrencyInputController } from "../src/controllers/currency_input_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

// Grouping and decimal marks come from the resolved locale, so a case that
// declares no language would otherwise read the runner's. Pin one for the whole
// file and let the cases that care declare their own.
beforeEach(() => {
  document.documentElement.lang = "en-US";
});

afterEach(() => {
  document.documentElement.removeAttribute("lang");
});

/**
 * Behavioral tests for {@link CurrencyInputController}: keystroke-level entry
 * (in-progress signs, decimal marks, and fraction digits survive every
 * reformat), digit grouping with caret preservation, fixed-precision rounding
 * on blur, locale-aware parsing that round-trips the controller's own output,
 * full-width normalization, IME composition holds, Value validation fallbacks,
 * runtime Value changes, formatter caching, the display ↔ hidden-field ↔
 * screen-reader-span sync (including late targets), the `change` event with its
 * `null` clear transition, and `reconcile` for a value the page moved.
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
  const mountBare = async (wrapperLang = "") => {
    const open = wrapperLang === "" ? "" : `<div lang="${wrapperLang}">`;
    const close = wrapperLang === "" ? "" : "</div>";
    document.body.innerHTML = `
      ${open}
      <div data-controller="stimeo--currency-input">
        <label for="amount">Amount</label>
        <input id="amount" type="text" aria-describedby="amount-sr"
               data-stimeo--currency-input-target="display"
               data-action="input->stimeo--currency-input#onInput
                            blur->stimeo--currency-input#format" />
        <span id="amount-sr" data-stimeo--currency-input-target="srValue"></span>
        <input type="hidden" data-stimeo--currency-input-target="field" />
      </div>
      ${close}`;
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

  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--currency-input",
    ) as CurrencyInputController;

  /** Records every `change` and `reconcile`, in dispatch order. */
  const record = () => {
    const events: Array<{ type: string; detail: { value: number | null; formatted: string } }> = [];
    for (const type of ["change", "reconcile"]) {
      root().addEventListener(`stimeo--currency-input:${type}`, (event) => {
        events.push({ type, detail: (event as CustomEvent).detail });
      });
    }
    return events;
  };

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

  it("holds a declaration change while the display is composing, and applies it after the commit", async () => {
    await mount();
    display().focus();
    const events = record();
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    display().value = "1234ｋ";
    display().dispatchEvent(new Event("input", { bubbles: true }));
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller().localeValueChanged();
    // Stimulus delivers its own callback too; both land mid-composition.
    await tick();

    // The uncommitted text belongs to the IME, so the page's change waits for it.
    expect(display().value).toBe("1234ｋ");
    expect(events).toEqual([]);

    display().value = "１２３４５";
    display().dispatchEvent(new Event("compositionend", { bubbles: true }));

    // The commit is read with the separators the user was typing against, then
    // shown in the new locale; only the user's commit is an edit.
    expect(display().value).toBe("12.345");
    expect(field().value).toBe("12345");
    expect(events).toEqual([{ type: "change", detail: { value: 12345, formatted: "12,345" } }]);
  });

  it("applies a held declaration change once the composing display leaves", async () => {
    await mount();
    display().focus();
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller().localeValueChanged();
    const leaving = display();
    leaving.remove();
    controller().displayTargetDisconnected(leaving);

    const arriving = document.createElement("input");
    arriving.type = "text";
    arriving.value = "1234";
    arriving.setAttribute("data-stimeo--currency-input-target", "display");
    root().prepend(arriving);
    controller().displayTargetConnected(arriving);

    expect(arriving.value).toBe("1.234,00");
  });

  it("keeps the committed value when the locale changes while the controller is away", async () => {
    await mount({ value: "1234.56" });
    const instance = controller();
    const events = record();
    instance.disconnect();
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    instance.localeValueChanged();
    instance.connect();
    await tick();

    // Its own en-US text is not read back with de-DE separators.
    expect(display().value).toBe("1.234,56");
    expect(field().value).toBe("1234.56");
    expect(events).toEqual([]);
  });

  it("reports a precision change made while away as reconcile once it moves the value", async () => {
    await mount({ value: "1234.56" });
    const instance = controller();
    const events = record();
    instance.disconnect();
    root().setAttribute("data-stimeo--currency-input-precision-value", "0");
    instance.precisionValueChanged();
    instance.connect();
    await tick();

    expect(display().value).toBe("1,235");
    expect(field().value).toBe("1235");
    expect(events).toEqual([{ type: "reconcile", detail: { value: 1235, formatted: "1,235" } }]);
  });

  it("keeps a typed decimal entry across a detach and a locale change", async () => {
    await mount();
    typeKeys("1.5");
    const instance = controller();
    instance.disconnect();
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    instance.localeValueChanged();
    instance.connect();
    await tick();

    expect(display().value).toBe("1,50");
    expect(field().value).toBe("1.5");
  });

  it("reads text the page wrote while the controller was away with the declared locale", async () => {
    await mount({ value: "1234.56" });
    const instance = controller();
    const events = record();
    instance.disconnect();
    display().value = "9.876,5";
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    instance.localeValueChanged();
    instance.connect();
    await tick();

    // The text is the page's, written for the locale it declares.
    expect(display().value).toBe("9.876,50");
    expect(field().value).toBe("9876.5");
    expect(events).toEqual([]);
  });

  /** Starts a composition on the focused display and holds a de-DE locale change. */
  const holdLocaleChange = async () => {
    display().focus();
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller().localeValueChanged();
    await tick();
  };

  /** Replaces the display with one the page wrote in de-DE. */
  const swapInGermanDisplay = () => {
    const leaving = display();
    const arriving = document.createElement("input");
    arriving.type = "text";
    arriving.value = "9.876,5";
    arriving.setAttribute("data-stimeo--currency-input-target", "display");
    leaving.replaceWith(arriving);
    return { leaving, arriving };
  };

  it("reads a display swapped in during a held locale change with the new separators", async () => {
    await mount({ value: "1234.5" });
    const events = record();
    await holdLocaleChange();
    const { leaving, arriving } = swapInGermanDisplay();
    controller().displayTargetDisconnected(leaving);
    controller().displayTargetConnected(arriving);
    await tick();

    expect(arriving.value).toBe("9.876,50");
    expect(field().value).toBe("9876.5");
    expect(events).toEqual([
      { type: "reconcile", detail: { value: 9876.5, formatted: "9.876,50" } },
    ]);
  });

  it("reads the swapped-in display with the new separators when it arrives before the old one leaves", async () => {
    await mount({ value: "1234.5" });
    const events = record();
    await holdLocaleChange();
    const { leaving, arriving } = swapInGermanDisplay();
    controller().displayTargetConnected(arriving);
    controller().displayTargetDisconnected(leaving);
    await tick();

    expect(arriving.value).toBe("9.876,50");
    expect(field().value).toBe("9876.5");
    expect(events).toEqual([
      { type: "reconcile", detail: { value: 9876.5, formatted: "9.876,50" } },
    ]);
  });

  it("reads a display swapped in after a locale change with no composition running", async () => {
    await mount({ value: "1234.5" });
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller().localeValueChanged();
    await tick();
    const events = record();
    const { leaving, arriving } = swapInGermanDisplay();
    controller().displayTargetDisconnected(leaving);
    controller().displayTargetConnected(arriving);
    await tick();

    expect(arriving.value).toBe("9.876,50");
    expect(field().value).toBe("9876.5");
    expect(events).toEqual([
      { type: "reconcile", detail: { value: 9876.5, formatted: "9.876,50" } },
    ]);
  });

  it("reads a display swapped in after the language around it changed with that language", async () => {
    await mountBare("en-US");
    type("1234.5");
    blur();
    const events = record();
    // No Value declares the locale, so only the inherited `lang` moves.
    (root().parentElement as HTMLElement).setAttribute("lang", "de-DE");
    const { leaving, arriving } = swapInGermanDisplay();
    controller().displayTargetDisconnected(leaving);
    controller().displayTargetConnected(arriving);
    await tick();

    expect(arriving.value).toBe("9.876,50");
    expect(field().value).toBe("9876.5");
    expect(events).toEqual([
      { type: "reconcile", detail: { value: 9876.5, formatted: "9.876,50" } },
    ]);
  });

  it("reads text the page writes into the display with the locale it declares alongside", async () => {
    await mount({ value: "1234.5" });
    const events = record();
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    display().value = "9.876,5"; // the page's text, written for the locale it now declares
    controller().localeValueChanged();
    await tick();

    expect(display().value).toBe("9.876,50");
    expect(field().value).toBe("9876.5");
    expect(events).toEqual([
      { type: "reconcile", detail: { value: 9876.5, formatted: "9.876,50" } },
    ]);
  });

  it("reads a display swapped in with a locale change from the same batch with the new locale", async () => {
    await mount({ value: "1234.5" });
    const events = record();
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    const { leaving, arriving } = swapInGermanDisplay();
    controller().localeValueChanged();
    controller().displayTargetDisconnected(leaving);
    controller().displayTargetConnected(arriving);
    await tick();

    expect(arriving.value).toBe("9.876,50");
    expect(field().value).toBe("9876.5");
    expect(events).toEqual([
      { type: "reconcile", detail: { value: 9876.5, formatted: "9.876,50" } },
    ]);
  });

  it("rounds an entry left unrounded mid-typing when it connects again, as reconcile", async () => {
    await mount();
    typeKeys("1.555");
    const instance = controller();
    const events = record();
    instance.disconnect();
    instance.connect();
    await tick();

    // Re-rendering the committed value applies the fixed precision, and the
    // rounding is this controller's decision rather than the user's edit.
    expect(display().value).toBe("1.56");
    expect(field().value).toBe("1.56");
    expect(events).toEqual([{ type: "reconcile", detail: { value: 1.56, formatted: "1.56" } }]);
  });

  it("keeps the declarations a composition held when the controller disconnects", async () => {
    await mount();
    display().focus();
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller().localeValueChanged();
    const instance = controller();
    instance.disconnect();
    instance.connect();

    // `,` is the decimal mark only once the held de-DE declaration applies.
    type("1234,5");
    expect(field().value).toBe("1234.5");
  });

  /** Types 1,234, then composes ５ after it while a de-DE locale change is held. */
  const composeWhileHeld = async () => {
    display().focus();
    typeKeys("1234");
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    press("５");
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller().localeValueChanged();
    await tick();
  };

  it("reads a composition the controller stops hearing when it moves with the separators it was typed against, as reconcile", async () => {
    await mount();
    await composeWhileHeld();
    const events = record();
    const instance = controller();
    // The composition listeners leave with the controller: no compositionend follows.
    instance.disconnect();
    instance.connect();
    await tick();

    expect(display().value).toBe("12.345,00");
    expect(field().value).toBe("12345");
    expect(events).toEqual([{ type: "reconcile", detail: { value: 12345, formatted: "12,345" } }]);
  });

  it("reads a composing display that moves within the controller with the separators it was typed against, as reconcile", async () => {
    await mount();
    await composeWhileHeld();
    const events = record();
    const moving = display();
    root().append(moving);
    controller().displayTargetDisconnected(moving);
    controller().displayTargetConnected(moving);
    await tick();

    expect(moving.value).toBe("12.345,00");
    expect(field().value).toBe("12345");
    expect(events).toEqual([{ type: "reconcile", detail: { value: 12345, formatted: "12,345" } }]);
  });

  it("reads its own rendering on a display that moves within the controller before a held change applies", async () => {
    await mount();
    await composeWhileHeld();
    const events = record();
    // A blur formats the text under the declarations it was typed against.
    blur();
    const moving = display();
    root().append(moving);
    controller().displayTargetDisconnected(moving);
    controller().displayTargetConnected(moving);
    await tick();

    expect(moving.value).toBe("12.345,00");
    expect(field().value).toBe("12345");
    expect(events).toEqual([{ type: "change", detail: { value: 12345, formatted: "12,345.00" } }]);
  });

  it("re-renders in the language around it when it connects again with an empty locale", async () => {
    // An empty `locale` attribute is authored, so reconnecting fires no Value callback.
    await mount({ locale: "", value: "1234.5" });
    expect(display().value).toBe("1,234.50");
    const instance = controller();
    instance.disconnect();
    document.documentElement.lang = "de-DE";
    instance.connect();
    await tick();

    expect(display().value).toBe("1.234,50");
    expect(field().value).toBe("1234.5");
  });

  it("syncs a late field from the display when nothing is composing", async () => {
    await mount();
    typeKeys("12");
    // Written by the page, so no input event reports it; the display is still the truth.
    display().value = "34";
    field().remove();
    const lateField = document.createElement("input");
    lateField.type = "hidden";
    lateField.setAttribute("data-stimeo--currency-input-target", "field");
    root().appendChild(lateField);
    controller().fieldTargetConnected();

    expect(lateField.value).toBe("34");
  });

  it("syncs a late field to the committed value while the display is composing", async () => {
    await mount();
    typeKeys("12");
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    display().value = "12３";
    display().dispatchEvent(new Event("input", { bubbles: true }));
    field().remove();
    const lateField = document.createElement("input");
    lateField.type = "hidden";
    lateField.setAttribute("data-stimeo--currency-input-target", "field");
    root().appendChild(lateField);
    controller().fieldTargetConnected();

    expect(lateField.value).toBe("12");
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

  it("dispatches neither event on connect when the initial value rounds", async () => {
    const events: string[] = [];
    const onEvent = (e: Event) => events.push(e.type);
    // The controller dispatches on its root element, which doesn't exist until
    // mount; listen on document (and clean up) to catch any connect-time event.
    document.addEventListener("stimeo--currency-input:change", onEvent);
    document.addEventListener("stimeo--currency-input:reconcile", onEvent);
    try {
      // 1234.567 rounds to 1234.57 at connect. Connecting describes the value the
      // page rendered rather than moving it, so it reports nothing at all.
      await mount({ value: "1234.567" });
      expect(display().value).toBe("1,234.57");
      expect(events).toEqual([]);
    } finally {
      document.removeEventListener("stimeo--currency-input:change", onEvent);
      document.removeEventListener("stimeo--currency-input:reconcile", onEvent);
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

  it("formats in the language of the nearest ancestor when none is declared", async () => {
    // `lang` is inherited, so the language that applies to the field is the
    // nearest one above it. German groups with `.` and marks the decimal with
    // `,`, so that is what the typist enters and what the display shows.
    await mountBare("de");
    typeKeys("1234,5");
    blur();

    expect(display().value).toBe("1.234,50");
    expect(field().value).toBe("1234.5");
  });

  it("reads back its own output in the language of the nearest ancestor", async () => {
    await mountBare("de");
    type("1.234,56");
    blur();

    expect(field().value).toBe("1234.56");
  });

  it("asks for the runtime locale when nothing declares a language", async () => {
    // The runner's own locale is what an undeclared language resolves to, and it
    // may well be en-US — so the case states which locale the formatters are
    // asked for rather than comparing the rendered text.
    document.documentElement.removeAttribute("lang");
    const asked: unknown[] = [];
    const NativeNumberFormat = Intl.NumberFormat;
    const RecordingNumberFormat = new Proxy(NativeNumberFormat, {
      construct(target, argumentsList, newTarget) {
        asked.push(argumentsList[0]);
        return Reflect.construct(target, argumentsList, newTarget);
      },
    });
    Object.defineProperty(Intl, "NumberFormat", {
      configurable: true,
      writable: true,
      value: RecordingNumberFormat,
    });

    try {
      await mountBare();
    } finally {
      Object.defineProperty(Intl, "NumberFormat", {
        configurable: true,
        writable: true,
        value: NativeNumberFormat,
      });
    }

    expect(asked).toContain(undefined);
    expect(asked).not.toContain("en-US");
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

  it("keeps a valid currency when the locale declaration is malformed", async () => {
    // The locale is validated before the currency is checked against it, so a
    // tag `Intl` rejects must not make a good currency code look unusable too.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await mount({ locale: "en_US", currency: "USD", value: "1234.5" });

    expect(error).not.toHaveBeenCalled();
    expect(display().value).toBe("1,234.50");
    expect(srValue().textContent).toBe("$1,234.50");
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

  it("reports a precision change that moves the value as reconcile, never as change", async () => {
    await mount({ value: "1234.5" });
    const events = record();
    root().setAttribute("data-stimeo--currency-input-precision-value", "0");
    controller().precisionValueChanged();
    await tick();

    expect(display().value).toBe("1,235");
    expect(field().value).toBe("1235");
    expect(events).toEqual([{ type: "reconcile", detail: { value: 1235, formatted: "1,235" } }]);
  });

  it("stays silent when a locale or currency change leaves the value where it was", async () => {
    // The display is read under the separators that wrote it, so the amount
    // survives the switch and only its rendering moves.
    await mount({ value: "1234.5" });
    const events = record();
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller().localeValueChanged();
    root().setAttribute("data-stimeo--currency-input-currency-value", "USD");
    controller().currencyValueChanged();
    await tick();

    expect(display().value).toBe("1.234,50");
    expect(field().value).toBe("1234.5");
    expect(events).toEqual([]);
  });

  it("reports a display the page swaps in as reconcile, never as change", async () => {
    await mount();
    typeKeys("1234");
    const events = record();
    const replacement = document.createElement("input");
    replacement.type = "text";
    replacement.value = "5678.9";
    replacement.setAttribute("data-stimeo--currency-input-target", "display");
    display().replaceWith(replacement);
    controller().displayTargetConnected(replacement);
    await tick();

    expect(replacement.value).toBe("5,678.90");
    expect(events).toEqual([
      { type: "reconcile", detail: { value: 5678.9, formatted: "5,678.90" } },
    ]);
  });

  it("reports a declaration change over a display the page emptied as a move to empty", async () => {
    await mount({ value: "1234.5" });
    const events = record();
    display().value = ""; // written by the page, so no input event reports it
    root().setAttribute("data-stimeo--currency-input-precision-value", "0");
    controller().precisionValueChanged();
    await tick();

    expect(field().value).toBe("");
    expect(root().hasAttribute("data-stimeo--currency-input-empty")).toBe(true);
    expect(events).toEqual([{ type: "reconcile", detail: { value: null, formatted: "" } }]);
  });

  it("reports a display swapped in without digits as a move to empty", async () => {
    await mount();
    typeKeys("1234");
    const events = record();
    const replacement = document.createElement("input");
    replacement.type = "text";
    replacement.value = "-";
    replacement.setAttribute("data-stimeo--currency-input-target", "display");
    display().replaceWith(replacement);
    controller().displayTargetConnected(replacement);
    await tick();

    expect(replacement.value).toBe("");
    expect(field().value).toBe("");
    expect(events).toEqual([{ type: "reconcile", detail: { value: null, formatted: "" } }]);
  });

  it("re-renders the screen-reader text of an entry in progress without reporting it", async () => {
    await mount();
    display().focus();
    typeKeys("1.5");
    expect(srValue().textContent).toBe("1.50");
    const events = record();
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller().localeValueChanged();
    await tick();

    expect(display().value).toBe("1,5");
    expect(srValue().textContent).toBe("1,50");
    expect(events).toEqual([]);
  });

  it("clears a stale field and marks the root empty when it connects over an empty display", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--currency-input">
        <label for="amount">Amount</label>
        <input id="amount" type="text" value=""
               data-stimeo--currency-input-target="display" />
        <span data-stimeo--currency-input-target="srValue">99.00</span>
        <input type="hidden" value="99" data-stimeo--currency-input-target="field" />
      </div>`;
    const events: string[] = [];
    const onEvent = (e: Event) => events.push(e.type);
    document.addEventListener("stimeo--currency-input:change", onEvent);
    document.addEventListener("stimeo--currency-input:reconcile", onEvent);
    try {
      application = Application.start();
      application.register("stimeo--currency-input", CurrencyInputController);
      await tick();

      expect(field().value).toBe("");
      expect(srValue().textContent).toBe("");
      expect(root().hasAttribute("data-stimeo--currency-input-empty")).toBe(true);
      expect(events).toEqual([]);
    } finally {
      document.removeEventListener("stimeo--currency-input:change", onEvent);
      document.removeEventListener("stimeo--currency-input:reconcile", onEvent);
    }
  });

  it("compares the next edit with the value a reconcile moved it to", async () => {
    await mount({ value: "1234.5" });
    const events = record();
    root().setAttribute("data-stimeo--currency-input-precision-value", "0");
    controller().precisionValueChanged();
    await tick();
    type("1,235"); // the value the page already moved it to: no edit
    type("1,236");

    expect(events).toEqual([
      { type: "reconcile", detail: { value: 1235, formatted: "1,235" } },
      { type: "change", detail: { value: 1236, formatted: "1,236" } },
    ]);
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
    const onEvent = (e: Event) => values.push((e as CustomEvent).detail.value);
    document.addEventListener("stimeo--currency-input:change", onEvent);
    document.addEventListener("stimeo--currency-input:reconcile", onEvent);
    try {
      // "1,5" is 1.5 only under de-DE separators; a premature sync reading it
      // under the defaults would surface a wrong 15 before connect seeds it.
      await mount({ locale: "de-DE", value: "1,5" });
      expect(display().value).toBe("1,50");
      expect(field().value).toBe("1.5");
      expect(values).toEqual([]);
      expect(error).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("stimeo--currency-input:change", onEvent);
      document.removeEventListener("stimeo--currency-input:reconcile", onEvent);
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

  it("pairs a null value with an empty formatted when a declaration change reads a sign the page wrote", async () => {
    await mount({ value: "5" });
    display().focus();
    const events = record();
    display().value = "-"; // the page's in-progress text: no input event reports it
    expect(field().value).toBe("5");
    root().setAttribute("data-stimeo--currency-input-precision-value", "0");
    controller().precisionValueChanged();
    await tick();

    // The committed 5 moved to empty, and a move to empty rides with "".
    expect(display().value).toBe("-");
    expect(field().value).toBe("");
    expect(events).toEqual([{ type: "reconcile", detail: { value: null, formatted: "" } }]);
  });

  it("reports nothing when a declaration change reads a sign the page wrote over an empty value", async () => {
    await mount();
    display().focus();
    const events = record();
    display().value = "-";
    root().setAttribute("data-stimeo--currency-input-precision-value", "0");
    controller().precisionValueChanged();
    await tick();

    expect(display().value).toBe("-");
    expect(field().value).toBe("");
    expect(events).toEqual([]);
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
    press("."); // the first decimal mark is accepted: "1,.234" scans as 1, dot, 234
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
