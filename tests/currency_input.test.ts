import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrencyInputController } from "../src/controllers/currency_input_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { composeDraft } from "./helpers/ime";
import { keyEvent } from "./helpers/keyboard";
import { captureSpeech } from "./helpers/speech";
import {
  disconnectAndStopApplication,
  reconnectKeepingFocus,
  restoreFromCache,
} from "./helpers/stimulus";
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

  it("parses an identical replacement display under its newly authored locale", async () => {
    await mount();
    type("1.23");
    blur();
    const owner = controller();
    owner.disconnect();
    const replacement = display().cloneNode(true) as HTMLInputElement;
    display().replaceWith(replacement);
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    owner.connect();
    await tick();
    expect(field().value).toBe("123");
    expect(replacement.value).toBe("123,00");
  });

  it("parses a cloned display under its current locale rather than an unknown held number", async () => {
    await mount({ value: "1.23" });
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    application = await restoreFromCache(application, (restored) =>
      restored.register("stimeo--currency-input", CurrencyInputController),
    );
    expect(field().value).toBe("123");
    expect(display().value).toBe("123,00");
  });

  it("reads an earlier display when it returns after another display was committed", async () => {
    await mount({ value: "1.23" });
    const owner = controller();
    const first = display();
    owner.disconnect();
    const second = first.cloneNode(true) as HTMLInputElement;
    second.value = "4.56";
    first.replaceWith(second);
    await tick();
    owner.connect();
    await tick();
    expect(field().value).toBe("4.56");
    owner.disconnect();
    second.replaceWith(first);
    await tick();
    owner.connect();
    await tick();
    expect(first.value).toBe("1.23");
    expect(field().value).toBe("1.23");
    expect(srValue().textContent).toBe("1.23");
  });

  it("reads a returning display with its newly authored locale", async () => {
    await mount({ value: "1.23" });
    const first = display();
    const second = first.cloneNode(true) as HTMLInputElement;
    second.value = "4,56";
    first.replaceWith(second);
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller().displayTargetConnected(second);
    await tick();
    expect(field().value).toBe("4.56");
    second.replaceWith(first);
    root().setAttribute("data-stimeo--currency-input-locale-value", "en-US");
    controller().displayTargetConnected(first);
    await tick();
    expect(first.value).toBe("1.23");
    expect(field().value).toBe("1.23");
    expect(srValue().textContent).toBe("1.23");
  });

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

  it("cancels a queued morph before reconnecting into an uncommitted display", async () => {
    await mount({ value: "12" });
    root().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    controller().disconnect();
    controller().connect();
    display().value = "34";
    await tick();
    expect(display().value).toBe("34");
    expect(field().value).toBe("12");
    root().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    await tick();
    expect(field().value).toBe("34");
  });

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
    composeDraft(display(), "1234ｋ");
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
    composeDraft(display(), "1234ｋ");
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

  it("applies a held declaration change once a script ends the composition without compositionend", async () => {
    await mount({ value: "1234" });
    display().focus();
    const events = record();
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(display(), "1234ｋ");
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller().localeValueChanged();
    await tick();
    expect(events).toEqual([]);

    // A script writes the display for the declarations the page now carries, and the
    // engine drops the conversion without compositionend.
    display().value = "1,5";
    display().dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: "5",
      }),
    );
    await tick();

    // The text is the page's, so the held change reads it with those declarations.
    expect(field().value).toBe("1.5");
    expect(events.map((event) => [event.type, event.detail.value])).toEqual([["reconcile", 1.5]]);

    display().value = "1,55";
    display().dispatchEvent(new Event("input", { bubbles: true }));

    expect(field().value).toBe("1.55");
    expect(events.map((event) => [event.type, event.detail.value])).toEqual([
      ["reconcile", 1.5],
      ["change", 1.55],
    ]);
  });

  it("applies a held declaration change before the input a script sends after its write", async () => {
    await mount({ value: "1234" });
    display().focus();
    const events = record();
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(display(), "1234ｋ");
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller().localeValueChanged();
    await tick();

    // A script writes the display for the declarations the page now carries and tells
    // listeners; the engine drops the conversion without compositionend.
    display().value = "1,5";
    display().dispatchEvent(new Event("input", { bubbles: true }));

    expect(field().value).toBe("1.5");
    expect(events.map((event) => [event.type, event.detail.value])).toEqual([["reconcile", 1.5]]);
  });

  it("applies a held declaration change before the blur after a write is formatted", async () => {
    await mount({ value: "1234" });
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    display().focus();
    const events = record();
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(display(), "1234ｋ");
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller().localeValueChanged();
    await tick();

    // A script writes the display, and the engine drops the conversion without compositionend.
    display().value = "1,5";
    elsewhere.focus();

    expect(field().value).toBe("1.5");
    expect(display().value).toBe("1,50");
    expect(events.map((event) => [event.type, event.detail.value])).toEqual([["reconcile", 1.5]]);
  });

  it("reads text a composition left in place with the separators it was typed against, then applies a held change", async () => {
    await mount();
    display().focus();
    typeKeys("1234");
    const events = record();
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(display(), "1,2345");
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller().localeValueChanged();
    await tick();

    // The engine stops composing with the text in place: its next key and edit say so.
    display().dispatchEvent(keyEvent("6", { isComposing: false }));
    display().dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: "6",
      }),
    );

    expect(field().value).toBe("12345");
    expect(display().value).toBe("12.345");
    expect(events.map((event) => [event.type, event.detail.value])).toEqual([["reconcile", 12345]]);
  });

  it("leaves text a composition left in place to the user's next edit when nothing was held", async () => {
    await mount();
    display().focus();
    typeKeys("1234");
    const events = record();
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(display(), "1,2345");

    // The engine stops composing with its text in place: its next key and edit say so.
    display().dispatchEvent(keyEvent("6", { isComposing: false }));
    display().dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: "6",
      }),
    );
    expect(display().value).toBe("1,2345");
    expect(events).toEqual([]);

    display().value = "1,23456";
    display().dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    expect(display().value).toBe("123,456");
    expect(events.map((event) => [event.type, event.detail.value])).toEqual([["change", 123456]]);
  });

  it("keeps a held change, and the text a composition left in place, for the composition that starts on it", async () => {
    await mount();
    display().focus();
    typeKeys("1234");
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(display(), "1,2345");
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller().localeValueChanged();
    await tick();

    // A new conversion starts on the same display: its text is the IME's again.
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    expect(display().value).toBe("1,2345");

    composeDraft(display(), "1,23456");
    display().dispatchEvent(new Event("compositionend", { bubbles: true }));
    // Read with the separators it was typed against, then shown under the held change.
    expect(field().value).toBe("123456");
    expect(display().value).toBe("123.456");
  });

  it("keeps the caret where the user put it when a held change applies right before their edit", async () => {
    await mount({ value: "1234" });
    display().focus();
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller().localeValueChanged();
    await tick();
    display().value = "1234,5";
    display().setSelectionRange(3, 3); // after the 3

    display().dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: "9",
      }),
    );
    await tick();

    expect(display().value).toBe("1.234,5");
    // Still after the 3: "1.23|4,5".
    expect(display().selectionStart).toBe(4);
  });

  it("keeps the caret by significant characters when a declaration change re-renders the focused display", async () => {
    await mount();
    display().focus();
    typeKeys("1234.5");
    expect(display().value).toBe("1,234.5");
    display().setSelectionRange(4, 4); // after the 3, read with the separators it was typed in

    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller().localeValueChanged();

    expect(display().value).toBe("1.234,5");
    expect(display().selectionStart).toBe(4);
  });

  it("leaves the page's text to the next edit when a write ends a composition that held nothing", async () => {
    await mount({ value: "1234" });
    display().focus();
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(display(), "1234ｋ");
    const events = record();

    // A script writes the display, and the engine drops the conversion without compositionend.
    display().value = "5";
    display().dispatchEvent(keyEvent("ArrowLeft"));
    await tick();

    expect(display().value).toBe("5");
    expect(events).toEqual([]);
  });

  it("stops hearing compositions on the display once it disconnects", async () => {
    await mount({ value: "1234" });
    const instance = controller();
    instance.disconnect();
    const events = record();

    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    display().value = "56";
    display().dispatchEvent(new Event("compositionend", { bubbles: true }));
    await tick();

    expect(display().value).toBe("56");
    expect(events).toEqual([]);
    instance.connect();
  });

  it("leaves no composition for a later disconnect to end once one ended without compositionend", async () => {
    await mount({ value: "1234" });
    display().focus();
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(display(), "1234ｋ");
    display().value = "5";
    display().dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: "6",
      }),
    );
    display().value = "56";
    display().dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    const events = record();

    display().value = "777";
    controller().disconnect();

    expect(display().value).toBe("777");
    expect(events).toEqual([]);
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

  it("hears typing on a display that replaces one which left mid-composition", async () => {
    await mount({ value: "1234" });
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    const leaving = display();
    const arriving = document.createElement("input");
    arriving.type = "text";
    arriving.setAttribute("data-stimeo--currency-input-target", "display");
    leaving.replaceWith(arriving);
    controller().displayTargetDisconnected(leaving);
    controller().displayTargetConnected(arriving);
    await tick();

    arriving.value = "5678";
    controller().onInput(new Event("input"));

    expect(arriving.value).toBe("5,678");
    expect(field().value).toBe("5678");
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

  describe("a display that stays after a composing one leaves", () => {
    /** Starts a composition on the focused display and holds a change to one declaration. */
    const holdChange = async (name: string, value: string) => {
      display().focus();
      display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
      root().setAttribute(`data-stimeo--currency-input-${name}-value`, value);
      if (name === "locale") controller().localeValueChanged();
      else if (name === "currency") controller().currencyValueChanged();
      else controller().precisionValueChanged();
      await tick();
    };
    /** A display the page wrote for the declarations it carries now. */
    const pageDisplay = (text: string) => {
      const successor = document.createElement("input");
      successor.type = "text";
      successor.value = text;
      successor.setAttribute("data-stimeo--currency-input-target", "display");
      return successor;
    };

    it.each([
      ["locale", "de-DE", "9.876,5", "9.876,50", "9876.5", "de-DE", "USD", 9876.5],
      ["precision", "0", "9876.5", "9,877", "9877", "en-US", "USD", 9877],
      ["currency", "EUR", "9876.5", "9,876.50", "9876.5", "en-US", "EUR", 9876.5],
    ])(
      "reads the successor with the %s change a composition held, and reports it once",
      async (name, declared, text, shown, submitted, locale, currency, value) => {
        const spoken = new Intl.NumberFormat(locale, { style: "currency", currency }).format(value);
        await mount({ value: "1234.5", currency: "USD" });
        const events = record();
        await holdChange(name, declared);
        const composing = display();
        const successor = pageDisplay(text);
        composing.after(successor);
        await tick();
        composing.remove();
        await tick();

        expect(display()).toBe(successor);
        expect(successor.value).toBe(shown);
        expect(field().value).toBe(submitted);
        expect(srValue().textContent).toBe(spoken);
        expect(events).toEqual([{ type: "reconcile", detail: { value, formatted: shown } }]);

        // The held change was taken in with that read: a later composition on the
        // successor applies nothing a second time.
        successor.dispatchEvent(new Event("compositionstart", { bubbles: true }));
        successor.dispatchEvent(new Event("compositionend", { bubbles: true }));
        expect(successor.value).toBe(shown);
        expect(events).toHaveLength(1);
      },
    );

    it("reads the successor once the turn ends after the composing display drops its target and keeps focus", async () => {
      await mount({ value: "1234.5" });
      const events = record();
      const composing = display();
      composing.focus();
      composing.dispatchEvent(new Event("compositionstart", { bubbles: true }));
      composeDraft(composing, "1,234.5６");
      const successor = pageDisplay("9876.5");
      composing.after(successor);
      await tick();

      // The page drops the target; the field keeps focus and goes on composing.
      composing.removeAttribute("data-stimeo--currency-input-target");
      controller().displayTargetDisconnected(composing);
      await tick();

      expect(display()).toBe(successor);
      expect(composing.value).toBe("1,234.5６");
      expect(successor.value).toBe("9,876.50");
      expect(events).toEqual([
        { type: "reconcile", detail: { value: 9876.5, formatted: "9,876.50" } },
      ]);
    });

    it("leaves the composing display's text alone while a successor waits behind it", async () => {
      await mount({ value: "1234.5" });
      const events = record();
      await holdChange("locale", "de-DE");
      const composing = display();
      composeDraft(composing, "1,234.5６");
      composing.after(pageDisplay("9.876,5"));
      await tick();

      expect(composing.value).toBe("1,234.5６");
      expect(field().value).toBe("1234.5");
      expect(events).toEqual([]);
    });

    it("leaves the composing display's text alone when a display behind it leaves, and reads the commit", async () => {
      await mount({ value: "1234.5" });
      const events = record();
      const composing = display();
      composing.focus();
      composing.dispatchEvent(new Event("compositionstart", { bubbles: true }));
      composeDraft(composing, "1,234.5６");
      const behind = pageDisplay("9876.5");
      composing.after(behind);
      await tick();
      behind.remove();
      await tick();

      expect(display()).toBe(composing);
      expect(composing.value).toBe("1,234.5６");
      expect(field().value).toBe("1234.5");
      expect(events).toEqual([]);

      composing.dispatchEvent(new Event("compositionend", { bubbles: true }));

      expect(composing.value).toBe("1,234.56");
      expect(field().value).toBe("1234.56");
      expect(events).toEqual([
        { type: "change", detail: { value: 1234.56, formatted: "1,234.56" } },
      ]);
    });

    it("keeps a held change for the commit when a display behind the composing one leaves", async () => {
      await mount({ value: "1234.5" });
      const events = record();
      await holdChange("locale", "de-DE");
      const composing = display();
      composeDraft(composing, "1,234.5６");
      const behind = pageDisplay("9.876,5");
      composing.after(behind);
      await tick();
      behind.remove();
      await tick();

      expect(composing.value).toBe("1,234.5６");
      expect(field().value).toBe("1234.5");
      expect(events).toEqual([]);

      composing.dispatchEvent(new Event("compositionend", { bubbles: true }));

      expect(field().value).toBe("1234.56");
      expect(composing.value).toBe("1.234,56");
    });

    it("reads a commit on the composing display with the separators it was typed against while a successor waits", async () => {
      await mount({ value: "1234.5" });
      const events = record();
      await holdChange("locale", "de-DE");
      const composing = display();
      const successor = pageDisplay("9.876,5");
      composing.after(successor);
      await tick();
      composing.value = "1,234.56";
      composing.dispatchEvent(new Event("compositionend", { bubbles: true }));

      expect(field().value).toBe("1234.56");
      expect(composing.value).toBe("1.234,56");

      composing.remove();
      await tick();

      expect(successor.value).toBe("9.876,50");
      expect(field().value).toBe("9876.5");
      expect(events).toEqual([
        { type: "change", detail: { value: 1234.56, formatted: "1,234.56" } },
        { type: "reconcile", detail: { value: 9876.5, formatted: "9.876,50" } },
      ]);
    });
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
    // Moving the controller element without moveBefore takes focus from the field; in
    // Chromium the move ends the conversion with no compositionend. The controller disconnects
    // and connects again.
    root().parentElement?.append(root());
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
    composeDraft(display(), "1,234５");
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller().localeValueChanged();
    await tick();
  };

  it("reads a composition the controller stops hearing when it moves with the separators it was typed against, as reconcile", async () => {
    await mount();
    await composeWhileHeld();
    const events = record();
    const instance = controller();
    // Moving the controller element without moveBefore takes focus from the field; in
    // Chromium the move ends the conversion with no compositionend. The controller disconnects
    // and connects again.
    root().parentElement?.append(root());
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

  it.each([
    [
      "the display",
      (instance: CurrencyInputController, moving: HTMLInputElement) => {
        instance.displayTargetDisconnected(moving);
        instance.displayTargetConnected(moving);
      },
    ],
    [
      "the controller element",
      // Stimulus disconnects a controller before its targets, and connects it after them.
      (instance: CurrencyInputController, moving: HTMLInputElement) => {
        instance.disconnect();
        instance.displayTargetDisconnected(moving);
        instance.displayTargetConnected(moving);
        instance.connect();
      },
    ],
  ])(
    "leaves the conversion alone when %s moves keeping focus, and reads its commit",
    async (_name, move) => {
      await mount();
      await composeWhileHeld();
      const events = record();

      // A move that keeps focus and the conversion still lets Stimulus release the targets
      // and take them back.
      move(controller(), display());
      await tick();
      expect(display().value).toBe("1,234５");
      expect(events).toEqual([]);

      display().value = "1,2345";
      display().dispatchEvent(new Event("compositionend", { bubbles: true }));

      expect(field().value).toBe("12345");
      expect(display().value).toBe("12.345");
      expect(events).toEqual([{ type: "change", detail: { value: 12345, formatted: "12,345" } }]);
    },
  );

  it.each([
    [
      "the display",
      (instance: CurrencyInputController, moving: HTMLInputElement) => {
        instance.displayTargetDisconnected(moving);
        instance.displayTargetConnected(moving);
      },
    ],
    [
      "the controller element",
      (instance: CurrencyInputController, moving: HTMLInputElement) => {
        instance.disconnect();
        instance.displayTargetDisconnected(moving);
        instance.displayTargetConnected(moving);
        instance.connect();
      },
    ],
  ])(
    "holds nothing when %s moves keeping focus, so later edits report as with no move",
    async (_name, move) => {
      await mount();
      display().focus();
      typeKeys("1234");
      const events = record();
      display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
      composeDraft(display(), "1,2345");
      move(controller(), display());
      await tick();

      // The engine stops composing with its text in place: nothing was held to apply.
      display().dispatchEvent(keyEvent("6", { isComposing: false }));
      display().dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          inputType: "insertText",
          isComposing: false,
          data: "6",
        }),
      );
      expect(events).toEqual([]);
      // A script writes the display and tells listeners: an edit, as with no move.
      display().value = "5";
      display().dispatchEvent(new Event("input", { bubbles: true }));

      expect(events.map((event) => [event.type, event.detail.value])).toEqual([["change", 5]]);
    },
  );

  it("holds nothing for a locale changed and changed back mid-composition", async () => {
    await mount();
    display().focus();
    typeKeys("1234");
    const events = record();
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(display(), "1,234５");
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    await tick();
    root().setAttribute("data-stimeo--currency-input-locale-value", "en-US");
    await tick();

    type("5");

    expect(events.map((event) => [event.type, event.detail.value])).toEqual([["change", 5]]);
  });

  for (const pass of ["morph", "reconnect"] as const) {
    it.each(["1234", ""])(
      `restores committed derived output for %s in the declarations in force while a composing ${pass} holds a change`,
      async (value) => {
        await mount({ currency: "USD", value });
        display().focus();
        const committed = display().value;
        const spoken = srValue().textContent;
        const events = record();
        display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
        composeDraft(display(), `${committed}５`);
        display().setSelectionRange(1, 1);
        root().setAttribute("data-stimeo--currency-input-currency-value", "EUR");
        controller().currencyValueChanged();
        field().value = "";
        srValue().textContent = "";
        root().toggleAttribute("data-stimeo--currency-input-empty", value !== "");

        if (pass === "morph") {
          root().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
        } else reconnectKeepingFocus(controller());
        await tick();

        expect(field().value).toBe(value);
        expect(srValue().textContent).toBe(spoken);
        expect(root().hasAttribute("data-stimeo--currency-input-empty")).toBe(value === "");
        expect(display().value).toBe(`${committed}５`);
        expect([display().selectionStart, display().selectionEnd]).toEqual([1, 1]);
        expect(events).toEqual([]);

        display().value = "5";
        display().dispatchEvent(new Event("compositionend", { bubbles: true }));
        expect(field().value).toBe("5");
        expect(srValue().textContent).toBe("€5.00");
        expect(events.map((event) => [event.type, event.detail.value])).toEqual([["change", 5]]);
      },
    );
  }

  it("reads a display that arrives ahead of the composing one as the page's once that composition ends", async () => {
    await mount({ currency: "USD", value: "1234" });
    const composing = display();
    composing.focus();
    const events = record();
    composing.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(composing, "1,234.00５");
    const ahead = document.createElement("input");
    ahead.value = "42";
    ahead.setAttribute("data-stimeo--currency-input-target", "display");
    composing.before(ahead);
    await tick();

    expect(display()).toBe(ahead);
    expect(ahead.value).toBe("42");
    expect(field().value).toBe("1234");
    expect(srValue().textContent).toBe("$1,234.00");
    expect(composing.value).toBe("1,234.00５");
    expect(events).toEqual([]);

    // The composition ended on a display no longer in charge, so it confirmed nothing.
    composing.value = "1,234.005";
    composing.dispatchEvent(new Event("compositionend", { bubbles: true }));
    expect(ahead.value).toBe("42.00");
    expect(field().value).toBe("42");
    expect(srValue().textContent).toBe("$42.00");
    expect(events.map((event) => [event.type, event.detail.value])).toEqual([["reconcile", 42]]);
  });

  for (const end of ["in place", "by a write"] as const) {
    it(`reads a display that arrived ahead of a composition the engine ends ${end} as the page's`, async () => {
      await mount({ currency: "USD", value: "1234" });
      const composing = display();
      composing.focus();
      const events = record();
      composing.dispatchEvent(new Event("compositionstart", { bubbles: true }));
      composeDraft(composing, "1,234.00５");
      const ahead = document.createElement("input");
      ahead.value = "42";
      ahead.setAttribute("data-stimeo--currency-input-target", "display");
      composing.before(ahead);
      await tick();
      expect(events).toEqual([]);

      // The engine stops composing without compositionend: its next key and edit say so.
      if (end === "by a write") composing.value = "999";
      composing.dispatchEvent(keyEvent("6", { isComposing: false }));
      composing.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          inputType: "insertText",
          isComposing: false,
          data: "6",
        }),
      );
      await tick();

      expect(ahead.value).toBe("42.00");
      expect(field().value).toBe("42");
      expect(srValue().textContent).toBe("$42.00");
      expect(events.map((event) => [event.type, event.detail.value])).toEqual([["reconcile", 42]]);
    });
  }

  it("keeps the change a display leaving held when it comes back ahead of a composition the engine ends", async () => {
    await mount({ currency: "USD", value: "1234" });
    const charge = display();
    const behind = document.createElement("input");
    behind.setAttribute("data-stimeo--currency-input-target", "display");
    charge.after(behind);
    await tick();
    const events = record();
    behind.focus();
    behind.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(behind, "５");
    charge.remove();
    await tick();
    charge.value = "77";
    behind.before(charge);
    await tick();

    // The engine stops composing without compositionend: its next key and edit say so.
    behind.dispatchEvent(keyEvent("6", { isComposing: false }));
    behind.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: "6",
      }),
    );
    await tick();

    expect(charge.value).toBe("77.00");
    expect(field().value).toBe("77");
    expect(events.map((event) => [event.type, event.detail.value])).toEqual([["reconcile", 77]]);
  });

  it("reads the display in charge as the page's when a display behind it ends a composition", async () => {
    await mount({ currency: "USD", value: "1234" });
    const behind = document.createElement("input");
    behind.setAttribute("data-stimeo--currency-input-target", "display");
    display().after(behind);
    await tick();
    const events = record();
    behind.focus();
    behind.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(behind, "５");
    display().value = "77";
    behind.value = "5";
    behind.dispatchEvent(new Event("compositionend", { bubbles: true }));

    expect(display().value).toBe("77.00");
    expect(field().value).toBe("77");
    expect(events.map((event) => [event.type, event.detail.value])).toEqual([["reconcile", 77]]);
  });

  it("reads the commit with the separators in force after a display ahead came and went mid-composition", async () => {
    await mount({ locale: "en-US" });
    const composing = display();
    composing.focus();
    const events = record();
    composing.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(composing, "1,234.5");
    root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller().localeValueChanged();
    const ahead = document.createElement("input");
    ahead.setAttribute("data-stimeo--currency-input-target", "display");
    composing.before(ahead);
    await tick();
    ahead.remove();
    await tick();

    composing.dispatchEvent(new Event("compositionend", { bubbles: true }));
    expect(events.map((event) => [event.type, event.detail.value])).toEqual([["change", 1234.5]]);
  });

  for (const pass of ["morph", "reconnect"] as const) {
    it.each(["1234", ""])(
      `restores committed derived output for %s during an unchanged composing ${pass}`,
      async (value) => {
        await mount({ currency: "USD", value });
        display().focus();
        const committed = display().value;
        const spoken = srValue().textContent;
        const events = record();
        display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
        composeDraft(display(), `${committed}５`);
        display().setSelectionRange(1, 1);
        field().value = "";
        srValue().textContent = "";
        root().toggleAttribute("data-stimeo--currency-input-empty", value !== "");

        if (pass === "morph") {
          root().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
        } else reconnectKeepingFocus(controller());
        await tick();

        expect(field().value).toBe(value);
        expect(srValue().textContent).toBe(spoken);
        expect(root().hasAttribute("data-stimeo--currency-input-empty")).toBe(value === "");
        expect(display().value).toBe(`${committed}５`);
        expect([display().selectionStart, display().selectionEnd]).toEqual([1, 1]);
        expect(events).toEqual([]);

        display().value = "5";
        display().dispatchEvent(new Event("compositionend", { bubbles: true }));
        expect(field().value).toBe("5");
        expect(events.map((event) => [event.type, event.detail.value])).toEqual([["change", 5]]);
      },
    );
  }

  it("holds nothing for a morph that changes nothing mid-composition, so a script's write reports as an edit", async () => {
    await mount();
    display().focus();
    typeKeys("1234");
    const events = record();
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(display(), "1,234５");

    root().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    await tick();
    expect(display().value).toBe("1,234５");
    // A script writes the display and tells listeners: an edit, as with no composition.
    type("5");

    expect(events.map((event) => [event.type, event.detail.value])).toEqual([["change", 5]]);
  });

  it("holds nothing for Values left at their defaults when the controller element moves keeping focus", async () => {
    await mountBare();
    display().focus();
    typeKeys("1234");
    const events = record();
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(display(), "1,234５");

    // Stimulus calls the callback of every Value left at its default as the controller reconnects.
    reconnectKeepingFocus(controller());
    await tick();
    expect(display().value).toBe("1,234５");

    // A script writes the display and tells listeners: an edit, as with no move.
    type("5");

    expect(events.map((event) => [event.type, event.detail.value])).toEqual([["change", 5]]);
  });

  it.each([
    ["locale", "data-stimeo--currency-input-locale-value", "de-DE"],
    ["currency", "data-stimeo--currency-input-currency-value", "EUR"],
    ["precision", "data-stimeo--currency-input-precision-value", "0"],
  ])(
    "holds a %s that changed with a move keeping focus, as it does with no move",
    async (_name, attribute, value) => {
      await mount();
      display().focus();
      typeKeys("1234");
      const events = record();
      display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
      composeDraft(display(), "1,234５");

      // The morph that moves the controller element also changes its declarations.
      reconnectKeepingFocus(controller(), () => root().setAttribute(attribute, value));
      await tick();
      expect(display().value).toBe("1,234５");

      type("5");

      expect(events.map((event) => [event.type, event.detail.value])).toEqual([["reconcile", 5]]);
    },
  );

  it("takes in the language around a controller element that moved keeping focus once the composition ends", async () => {
    await mount({ locale: "" });
    const section = document.createElement("section");
    section.lang = "en-US";
    document.body.append(section);
    section.append(root());
    await tick();
    display().focus();
    typeKeys("1234");
    const events = record();
    display().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(display(), "1,2345");

    // The controller element moves into a German section; an empty locale follows the
    // language around it.
    reconnectKeepingFocus(controller(), () => {
      section.lang = "de-DE";
    });
    await tick();
    display().dispatchEvent(new Event("compositionend", { bubbles: true }));

    expect(display().value).toBe("12.345");
    expect(field().value).toBe("12345");
    expect(events.map((event) => [event.type, event.detail.value])).toEqual([["change", 12345]]);
  });

  it("holds a blur during the composition and rounds what a move within the controller leaves before a held change applies", async () => {
    await mount();
    await composeWhileHeld();
    const events = record();
    // The blur is held: the draft is the IME's until the composition ends.
    blur();
    expect(display().value).toBe("1,234５");
    expect(events).toEqual([]);
    const moving = display();
    root().append(moving);
    controller().displayTargetDisconnected(moving);
    controller().displayTargetConnected(moving);
    await tick();

    // The move ends the composition: its text is read and rounded once under the
    // declarations it was typed against, as the page's, and the held change applies.
    expect(moving.value).toBe("12.345,00");
    expect(field().value).toBe("12345");
    expect(events).toEqual([
      { type: "reconcile", detail: { value: 12345, formatted: "12,345.00" } },
    ]);
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
    composeDraft(display(), "12３");
    field().remove();
    const lateField = document.createElement("input");
    lateField.type = "hidden";
    lateField.setAttribute("data-stimeo--currency-input-target", "field");
    root().appendChild(lateField);
    controller().fieldTargetConnected();

    expect(lateField.value).toBe("12");
  });

  it("syncs a field that stays after an earlier one leaves", async () => {
    await mount({ value: "1234.5" });
    const original = field();
    const successor = original.cloneNode() as HTMLInputElement;
    successor.value = "";
    original.after(successor);
    await tick();
    original.remove();
    await tick();

    expect(field()).toBe(successor);
    expect(successor.value).toBe("1234.5");
  });

  it("syncs a screen-reader span that stays after an earlier one leaves", async () => {
    await mount({ value: "1234.5" });
    const original = srValue();
    const successor = original.cloneNode() as HTMLElement;
    original.after(successor);
    await tick();
    original.remove();
    await tick();

    expect(srValue()).toBe(successor);
    expect(successor.textContent).toBe("1,234.50");
  });

  it("says nothing when it syncs a field and a span left behind", async () => {
    await mount({ value: "1234.5" });
    const events = record();
    const native: Event[] = [];
    root().addEventListener("change", (event) => native.push(event));
    const fieldSuccessor = field().cloneNode() as HTMLInputElement;
    fieldSuccessor.value = "";
    const spanSuccessor = srValue().cloneNode() as HTMLElement;
    const originals = [field(), srValue()];
    field().after(fieldSuccessor);
    srValue().after(spanSuccessor);
    await tick();
    for (const original of originals) original.remove();
    await tick();

    expect(fieldSuccessor.value).toBe("1234.5");
    expect(spanSuccessor.textContent).toBe("1,234.50");
    expect(events).toEqual([]);
    expect(native).toEqual([]);
  });

  it("keeps the display when its only field and span leave", async () => {
    await mount({ value: "1234.5" });
    field().remove();
    srValue().remove();
    await tick();

    expect(() => controller().fieldTargetDisconnected()).not.toThrow();
    expect(() => controller().srValueTargetDisconnected()).not.toThrow();
    expect(display().value).toBe("1,234.50");
  });

  it("writes nothing to the field or span from a departure delivered after disconnect", async () => {
    await mount({ value: "1234.5" });
    const instance = controller();
    instance.disconnect();
    // The page rewrites the display once the controller is gone; the departures
    // Stimulus delivers after `disconnect()` must not mirror it.
    display().value = "99";

    instance.fieldTargetDisconnected();
    instance.srValueTargetDisconnected();

    expect(field().value).toBe("1234.5");
    expect(srValue().textContent).toBe("1,234.50");
  });

  it("reads a display holding another amount that stays after an earlier one leaves, as reconcile", async () => {
    await mount({ value: "1234.5" });
    const events = record();
    const original = display();
    const successor = original.cloneNode() as HTMLInputElement;
    successor.value = "99";
    original.after(successor);
    await tick();
    original.remove();
    await tick();

    expect(display()).toBe(successor);
    expect(successor.value).toBe("99.00");
    expect(field().value).toBe("99");
    expect(events).toEqual([{ type: "reconcile", detail: { value: 99, formatted: "99.00" } }]);
  });

  it("normalizes a display holding the same amount that stays after an earlier one leaves, silently", async () => {
    await mount({ value: "1234.5" });
    const events = record();
    const original = display();
    const successor = original.cloneNode() as HTMLInputElement;
    successor.value = "1234.5";
    original.after(successor);
    await tick();
    original.remove();
    await tick();

    expect(successor.value).toBe("1,234.50");
    expect(field().value).toBe("1234.5");
    expect(events).toEqual([]);
  });

  it("keeps the confirmed amount until a focused successor supplies an ordinary input", async () => {
    await mount({ value: "1234.5" });
    const events = record();
    const original = display();
    const successor = original.cloneNode() as HTMLInputElement;
    successor.value = "12.3";
    original.after(successor);
    await tick();
    successor.focus();
    original.remove();
    await tick();

    expect(successor.value).toBe("12.3");
    expect(field().value).toBe("1234.5");
    expect(events).toEqual([]);
    successor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    expect(field().value).toBe("12.3");
    expect(events).toEqual([{ type: "change", detail: { value: 12.3, formatted: "12.3" } }]);
  });

  it("reads nothing for an arrival delivered once no display is left", async () => {
    await mount({ value: "1234.5" });
    const arrived = display();
    arrived.remove();
    await tick();

    expect(() => controller().displayTargetConnected(arrived)).not.toThrow();
    expect(field().value).toBe("1234.5");
  });

  it("keeps the field when its only display leaves", async () => {
    await mount({ value: "1234.5" });
    const leaving = display();
    leaving.remove();
    await tick();

    expect(() => controller().displayTargetDisconnected(leaving)).not.toThrow();
    expect(field().value).toBe("1234.5");
  });

  it("reads no display from a departure delivered after disconnect", async () => {
    await mount({ value: "1234.5" });
    const events = record();
    const instance = controller();
    instance.disconnect();
    display().value = "99";

    instance.displayTargetDisconnected(display());

    expect(display().value).toBe("99");
    expect(field().value).toBe("1234.5");
    expect(events).toEqual([]);
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

  it("syncs a screen-reader span that arrives after the last one already left", async () => {
    await mount();
    typeKeys("1234");
    srValue().remove();
    await tick();
    // Nothing departs in this batch, so the arrival is the only callback that can sync it.
    const lateSr = document.createElement("span");
    lateSr.setAttribute("data-stimeo--currency-input-target", "srValue");
    root().appendChild(lateSr);
    await tick();

    expect(lateSr.textContent).toBe("1,234.00");
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

  it("stops reading the previous locale's digits once the locale changes", async () => {
    await mount({ locale: "ar-EG", value: "1234" });
    root().setAttribute("data-stimeo--currency-input-locale-value", "en-US");
    controller().localeValueChanged();
    await tick();
    expect(display().value).toBe("1,234.00");

    // An Arabic-Indic digit is not one of en-US's digits, so it is dropped like a symbol.
    type("5٦");

    expect(field().value).toBe("5");
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

  // Speech-order check. The grouped display string is for sighted users;
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

  it("reports a pending display write once when the user confirms it", async () => {
    await mount({ value: "10" });
    const changes: unknown[] = [];
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--currency-input:change", (event) =>
      changes.push((event as CustomEvent).detail),
    );
    root().addEventListener("stimeo--currency-input:reconcile", (event) =>
      repairs.push((event as CustomEvent).detail),
    );
    display().value = "20";
    blur();
    await tick();
    expect(changes).toEqual([{ value: 20, formatted: "20.00" }]);
    expect(repairs).toEqual([]);
  });

  it("stays quiet when a pending display write is returned to the last published amount", async () => {
    await mount({ value: "10" });
    const changes: unknown[] = [];
    root().addEventListener("stimeo--currency-input:change", (event) =>
      changes.push((event as CustomEvent).detail),
    );
    display().value = "20";
    type("10");
    expect(field().value).toBe("10");
    expect(changes).toEqual([]);
  });
});

describe("CurrencyInputController — the display in charge", () => {
  let application: Application;

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const ACTION = "input->stimeo--currency-input#onInput blur->stimeo--currency-input#format";

  /** Mounts a form whose currency-input has display `#a` and, unless `second` is null, `#b` behind it. */
  const mountForm = async ({
    value = "1234",
    second = "" as string | null,
    locale = "en-US",
    lang = "",
    actionOnRoot = false,
  } = {}) => {
    const action = actionOnRoot ? "" : ACTION;
    const behind =
      second === null
        ? ""
        : `<input id="b" type="text" value="${second}" data-stimeo--currency-input-target="display" data-action="${action}">`;
    document.body.innerHTML = `
      <form id="f" lang="${lang}">
        <div data-controller="stimeo--currency-input"
             data-action="${actionOnRoot ? "input->stimeo--currency-input#onInput focusout->stimeo--currency-input#format" : ""}"
             data-stimeo--currency-input-locale-value="${locale}"
             data-stimeo--currency-input-currency-value="USD">
          <input id="a" type="text" aria-describedby="sr" value="${value}"
                 data-stimeo--currency-input-target="display" data-action="${action}">
          ${behind}
          <span id="sr" data-stimeo--currency-input-target="srValue"></span>
          <input type="hidden" name="amount" data-stimeo--currency-input-target="field">
        </div>
      </form>`;
    application = Application.start();
    application.register("stimeo--currency-input", CurrencyInputController);
    await tick();
  };

  const input = (id: string) => document.getElementById(id) as HTMLInputElement;
  const root = () => document.querySelector<HTMLElement>("[data-controller]") as HTMLElement;
  const field = () =>
    document.querySelector<HTMLInputElement>("input[name='amount']") as HTMLInputElement;
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--currency-input",
    ) as CurrencyInputController;

  /** The outputs a form submission and a screen reader read, apart from what the display shows. */
  const outputs = () => ({
    field: field().value,
    submitted: new FormData(document.getElementById("f") as HTMLFormElement).get("amount"),
    spoken: document.getElementById("sr")?.textContent,
    empty: root().hasAttribute("data-stimeo--currency-input-empty"),
  });

  /** Records the native `input` and `change` the hidden field hears. */
  const nativeOnField = () => {
    const heard: string[] = [];
    for (const type of ["input", "change"]) field().addEventListener(type, () => heard.push(type));
    return heard;
  };

  /** Records every `change` and `reconcile` as `[type, value]`, in dispatch order. */
  const record = () => {
    const events: Array<[string, number | null]> = [];
    for (const type of ["change", "reconcile"]) {
      root().addEventListener(`stimeo--currency-input:${type}`, (event) => {
        events.push([type, (event as CustomEvent).detail.value]);
      });
    }
    return events;
  };

  const startComposing = (element: HTMLInputElement, draft: string) => {
    element.focus();
    element.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(element, draft);
  };

  /** The engine stops composing without compositionend; its next key and edit say so. */
  const endWithoutCompositionend = (element: HTMLInputElement, written?: string) => {
    if (written !== undefined) element.value = written;
    element.dispatchEvent(keyEvent("6", { isComposing: false }));
    element.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: "6",
      }),
    );
  };

  const commit = (element: HTMLInputElement, text: string) => {
    element.value = text;
    element.dispatchEvent(new Event("compositionend", { bubbles: true }));
  };

  /** Detaches `element`, lets the page write `text` into it, and puts it back before `before`. */
  const writeWhileAway = async (element: HTMLInputElement, text: string, before: HTMLElement) => {
    element.remove();
    await tick();
    element.value = text;
    before.before(element);
    await tick();
  };

  const morphUnchanged = async () => {
    root().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    await tick();
  };

  describe("a single display", () => {
    it("reads its own input, blur and commit as the user's", async () => {
      await mountForm({ second: null });
      const events = record();
      input("a").focus();
      input("a").value = "56";
      input("a").dispatchEvent(new Event("input", { bubbles: true }));
      input("a").dispatchEvent(new Event("blur"));
      startComposing(input("a"), "56.00５");
      commit(input("a"), "56.005");

      expect(events).toEqual([
        ["change", 56],
        ["change", 56.005],
      ]);
      expect(outputs()).toEqual({
        field: "56.005",
        submitted: "56.005",
        spoken: "$56.01",
        empty: false,
      });
    });

    it("rounds the display in charge on a call without an event", async () => {
      await mountForm({ second: null });
      const events = record();
      input("a").value = "5.555";
      controller().format();

      expect(input("a").value).toBe("5.56");
      expect(events).toEqual([["change", 5.56]]);
      expect(outputs().submitted).toBe("5.56");
    });

    it("re-groups the display in charge on an onInput call without an event", async () => {
      await mountForm({ second: null });
      const events = record();
      input("a").value = "56789";
      controller().onInput();

      expect(input("a").value).toBe("56,789");
      expect(events).toEqual([["change", 56789]]);
      expect(outputs().submitted).toBe("56789");
    });
  });

  describe("a display behind the one in charge", () => {
    it("leaves a page write in charge unread when another display arrives behind it", async () => {
      await mountForm({ second: null });
      const events = record();
      const native = nativeOnField();
      input("a").value = "77";
      const arriving = document.createElement("input");
      arriving.value = "999";
      arriving.setAttribute("data-stimeo--currency-input-target", "display");
      root().append(arriving);
      controller().displayTargetConnected(arriving);
      await tick();

      expect(input("a").value).toBe("77");
      expect(arriving.value).toBe("999");
      expect(outputs()).toEqual({
        field: "1234",
        submitted: "1234",
        spoken: "$1,234.00",
        empty: false,
      });
      expect(events).toEqual([]);
      expect(native).toEqual([]);

      root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      await tick();
      expect(input("a").value).toBe("77.00");
      expect(outputs()).toEqual({
        field: "77",
        submitted: "77",
        spoken: "$77.00",
        empty: false,
      });
      expect(events).toEqual([["reconcile", 77]]);
      expect(native).toEqual([]);
    });

    it("does not read the display in charge as the user's edit on an input in the display behind it", async () => {
      await mountForm();
      const events = record();
      input("a").value = "77";
      input("b").focus();
      input("b").value = "34567";
      input("b").setSelectionRange(2, 2);
      input("b").dispatchEvent(new Event("input", { bubbles: true }));

      expect(events).toEqual([]);
      expect(outputs()).toEqual({
        field: "1234",
        submitted: "1234",
        spoken: "$1,234.00",
        empty: false,
      });
      expect([input("a").value, input("b").value]).toEqual(["77", "34567"]);
      expect(document.activeElement).toBe(input("b"));
      expect([input("b").selectionStart, input("b").selectionEnd]).toEqual([2, 2]);
    });

    it("does not read the display in charge as the user's edit on a blur of the display behind it", async () => {
      await mountForm();
      const events = record();
      input("a").value = "77";
      input("b").dispatchEvent(new Event("blur"));

      expect(events).toEqual([]);
      expect(outputs().submitted).toBe("1234");
      expect(input("a").value).toBe("77");
    });

    it("leaves the display in charge alone when a composition in the display behind it commits", async () => {
      await mountForm();
      const events = record();
      startComposing(input("b"), "５");
      commit(input("b"), "5");

      expect(events).toEqual([]);
      expect(outputs()).toEqual({
        field: "1234",
        submitted: "1234",
        spoken: "$1,234.00",
        empty: false,
      });
      expect([input("a").value, input("b").value]).toEqual(["1,234.00", "5"]);
    });

    for (const written of [undefined, "999"] as const) {
      it(`reads a page write into the display in charge once a composition behind it ends without compositionend (${written === undefined ? "in place" : "by a write"})`, async () => {
        await mountForm();
        const events = record();
        startComposing(input("b"), "５");
        input("b").setSelectionRange(1, 1);
        input("a").value = "77";
        endWithoutCompositionend(input("b"), written);
        await tick();

        expect(events).toEqual([["reconcile", 77]]);
        expect(outputs()).toEqual({
          field: "77",
          submitted: "77",
          spoken: "$77.00",
          empty: false,
        });
        expect(input("a").value).toBe("77.00");
        expect(document.activeElement).toBe(input("b"));
      });

      it(`stays quiet when a composition behind an untouched display in charge ends without compositionend (${written === undefined ? "in place" : "by a write"})`, async () => {
        await mountForm();
        const events = record();
        startComposing(input("b"), "５");
        endWithoutCompositionend(input("b"), written);
        await tick();
        input("b").dispatchEvent(new Event("input", { bubbles: true }));
        input("b").dispatchEvent(new Event("blur"));

        expect(events).toEqual([]);
        expect(outputs().submitted).toBe("1234");
        expect(input("a").value).toBe("1,234.00");
      });
    }

    it("reads a display in charge rewritten while away once a composition behind it ends, after a morph that changes nothing", async () => {
      await mountForm();
      const events = record();
      startComposing(input("b"), "５");
      await writeWhileAway(input("a"), "77", input("b"));
      await morphUnchanged();
      expect(events).toEqual([]);
      expect(outputs().submitted).toBe("1234");

      endWithoutCompositionend(input("b"));
      await tick();
      input("b").dispatchEvent(new Event("input", { bubbles: true }));

      expect(events).toEqual([["reconcile", 77]]);
      expect(outputs()).toEqual({
        field: "77",
        submitted: "77",
        spoken: "$77.00",
        empty: false,
      });
    });
  });

  describe("a display that comes ahead of a composing one and goes", () => {
    for (const end of ["compositionend", "without compositionend"] as const) {
      it(`reports the user's commit once after a morph that changes nothing (${end})`, async () => {
        await mountForm({ second: null });
        const events = record();
        startComposing(input("a"), "1,234.00５");
        input("a").setSelectionRange(9, 9);
        const ahead = document.createElement("input");
        ahead.value = "42";
        ahead.setAttribute("data-stimeo--currency-input-target", "display");
        input("a").before(ahead);
        await tick();
        ahead.remove();
        await tick();
        await morphUnchanged();

        expect(events).toEqual([]);
        expect(outputs().submitted).toBe("1234");
        expect(document.activeElement).toBe(input("a"));
        expect([input("a").selectionStart, input("a").selectionEnd]).toEqual([9, 9]);

        if (end === "compositionend") {
          commit(input("a"), "1,234.005");
        } else {
          endWithoutCompositionend(input("a"));
          await tick();
          expect(events).toEqual([]);
          input("a").value = "1,234.005";
          input("a").dispatchEvent(new Event("input", { bubbles: true }));
        }

        expect(events).toEqual([["change", 1234.005]]);
        expect(outputs()).toEqual({
          field: "1234.005",
          submitted: "1234.005",
          spoken: "$1,234.01",
          empty: false,
        });
      });
    }

    it("reads the commit with the separators in force while a locale change waits and a display came and went", async () => {
      await mountForm({ second: null });
      const events = record();
      startComposing(input("a"), "1,234.5");
      root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
      controller().localeValueChanged();
      const ahead = document.createElement("input");
      ahead.setAttribute("data-stimeo--currency-input-target", "display");
      input("a").before(ahead);
      await tick();
      ahead.remove();
      await tick();
      await morphUnchanged();
      commit(input("a"), "1,234.5");

      expect(events).toEqual([["change", 1234.5]]);
      expect(outputs().submitted).toBe("1234.5");
      expect(input("a").value).toBe("1.234,5");
    });

    it("applies nothing after a locale change that was taken back mid-composition", async () => {
      await mountForm({ second: null });
      const events = record();
      startComposing(input("a"), "1,234.00５");
      root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
      controller().localeValueChanged();
      root().setAttribute("data-stimeo--currency-input-locale-value", "en-US");
      controller().localeValueChanged();
      await morphUnchanged();
      endWithoutCompositionend(input("a"));
      await tick();

      expect(events).toEqual([]);
      expect(input("a").value).toBe("1,234.00５");
      expect(outputs().submitted).toBe("1234");
    });
  });
  describe("reads of the display in charge as displays, compositions and declarations change", () => {
    it("reads a morph's write into the display in charge once a composition behind it ends without compositionend", async () => {
      await mountForm();
      const events = record();
      const native = nativeOnField();
      startComposing(input("b"), "５");
      input("a").value = "77";
      await morphUnchanged();
      expect(events).toEqual([]);
      expect(outputs().submitted).toBe("1234");

      endWithoutCompositionend(input("b"));
      await tick();

      expect(events).toEqual([["reconcile", 77]]);
      expect(outputs()).toEqual({
        field: "77",
        submitted: "77",
        spoken: "$77.00",
        empty: false,
      });
      expect(native).toEqual([]);
    });

    it("does not read the display in charge as the user's edit on an input in a display that left its target", async () => {
      await mountForm();
      const events = record();
      input("b").removeAttribute("data-stimeo--currency-input-target");
      await tick();
      input("a").value = "77";
      input("b").value = "5";
      input("b").dispatchEvent(new Event("input", { bubbles: true }));

      expect(events).toEqual([]);
      expect(outputs().submitted).toBe("1234");
      expect(input("a").value).toBe("77");
    });

    it("keeps what a rewritten display in charge owes through a reconnect that keeps the composition", async () => {
      await mountForm();
      const events = record();
      startComposing(input("b"), "５");
      await writeWhileAway(input("a"), "77", input("b"));
      reconnectKeepingFocus(controller());
      await tick();
      await morphUnchanged();
      expect(events).toEqual([]);

      endWithoutCompositionend(input("b"));
      await tick();

      expect(events).toEqual([["reconcile", 77]]);
      expect(outputs().submitted).toBe("77");
      expect(document.activeElement).toBe(input("b"));
    });

    it("reads the display in charge through actions bound on the controller element", async () => {
      await mountForm({ actionOnRoot: true });
      const events = record();
      input("a").focus();
      input("a").value = "5678";
      input("a").dispatchEvent(new Event("input", { bubbles: true }));
      input("b").value = "9";
      input("b").dispatchEvent(new Event("input", { bubbles: true }));
      input("b").dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

      expect(input("a").value).toBe("5,678");
      expect(events).toEqual([["change", 5678]]);
      expect(outputs().submitted).toBe("5678");
    });

    it("reads an unfocused display behind as the page's once the display in charge leaves", async () => {
      await mountForm();
      const events = record();
      input("b").value = "42";
      input("b").dispatchEvent(new Event("input", { bubbles: true }));
      expect(events).toEqual([]);

      input("a").remove();
      await tick();

      expect(events).toEqual([["reconcile", 42]]);
      expect(outputs().submitted).toBe("42");
    });

    for (const written of [undefined, "999"] as const) {
      it(`reads a commit left ${written === undefined ? "in place" : "overwritten"} with the right separators after a locale change waited and a display came and went`, async () => {
        await mountForm({ second: null });
        const events = record();
        startComposing(input("a"), "1,234.5");
        root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
        controller().localeValueChanged();
        const ahead = document.createElement("input");
        ahead.setAttribute("data-stimeo--currency-input-target", "display");
        input("a").before(ahead);
        await tick();
        ahead.remove();
        await tick();
        await morphUnchanged();
        endWithoutCompositionend(input("a"), written);
        await tick();

        // Text the composition left was typed in en-US; text a write left is the page's.
        const value = written === undefined ? 1234.5 : 999;
        expect(events).toEqual([["reconcile", value]]);
        expect(outputs().submitted).toBe(String(value));
        expect(input("a").value).toBe(written === undefined ? "1.234,5" : "999");
      });
    }

    it("leaves no change behind once a display came and went, so a script's write reports as an edit", async () => {
      await mountForm({ second: null });
      const events = record();
      startComposing(input("a"), "1,234.00５");
      const ahead = document.createElement("input");
      ahead.setAttribute("data-stimeo--currency-input-target", "display");
      input("a").before(ahead);
      await tick();
      ahead.remove();
      await tick();
      await morphUnchanged();

      endWithoutCompositionend(input("a"), "5");
      await tick();
      expect(events).toEqual([]);
      input("a").dispatchEvent(new Event("input", { bubbles: true }));

      expect(events).toEqual([["change", 5]]);
      expect(outputs().submitted).toBe("5");
    });

    it("applies a declaration change once after a display came and went and a morph changed nothing", async () => {
      await mountForm({ second: null });
      const events = record();
      startComposing(input("a"), "1,234.00５");
      root().setAttribute("data-stimeo--currency-input-currency-value", "EUR");
      await morphUnchanged();
      const ahead = document.createElement("input");
      ahead.setAttribute("data-stimeo--currency-input-target", "display");
      input("a").before(ahead);
      await tick();
      ahead.remove();
      await tick();
      await morphUnchanged();
      expect(outputs().spoken).toBe("$1,234.00");

      endWithoutCompositionend(input("a"));
      await tick();

      expect(events).toEqual([["reconcile", 1234.005]]);
      expect(outputs().spoken).toBe("€1,234.01");
    });

    it("does not re-read the display at the end of a composition when only the language around an empty locale changed", async () => {
      await mountForm({ second: null, locale: "", lang: "en-US" });
      const events = record();
      startComposing(input("a"), "1,234.00５");
      document.getElementById("f")?.setAttribute("lang", "de-DE");
      commit(input("a"), "1,234.005");

      expect(events).toEqual([["change", 1234.005]]);
      expect(input("a").value).toBe("1,234.005");
      expect(outputs().spoken).toBe("$1,234.01");
    });

    it("reads a composition the engine ends in place once the display ahead of it left", async () => {
      await mountForm();
      const events = record();
      startComposing(input("b"), "５");
      input("a").remove();
      await tick();
      expect(events).toEqual([]);

      endWithoutCompositionend(input("b"));
      await tick();

      expect(events).toEqual([["reconcile", 5]]);
      expect(outputs()).toEqual({
        field: "5",
        submitted: "5",
        spoken: "$5.00",
        empty: false,
      });
      expect(document.activeElement).toBe(input("b"));
    });

    it("owes a later composition nothing once a held change was applied", async () => {
      await mountForm({ second: null });
      const events = record();
      startComposing(input("a"), "1,234.00５");
      root().setAttribute("data-stimeo--currency-input-precision-value", "3");
      await tick();
      commit(input("a"), "1,234.005");
      expect(events).toEqual([["change", 1234.005]]);

      startComposing(input("a"), "1,234.0057");
      endWithoutCompositionend(input("a"));
      await tick();

      expect(events).toEqual([["change", 1234.005]]);
      expect(input("a").value).toBe("1,234.0057");
      expect(outputs().submitted).toBe("1234.005");
    });

    it("restores the outputs a morph cleared as soon as it brings a display ahead of a composing one", async () => {
      await mountForm({ second: null });
      const events = record();
      const native = nativeOnField();
      startComposing(input("a"), "1,234.00５");
      input("a").setSelectionRange(9, 9);
      field().value = "";
      const sr = document.getElementById("sr") as HTMLElement;
      sr.textContent = "";
      const ahead = document.createElement("input");
      ahead.value = "42";
      ahead.setAttribute("data-stimeo--currency-input-target", "display");
      input("a").before(ahead);
      await tick();

      expect(outputs()).toEqual({
        field: "1234",
        submitted: "1234",
        spoken: "$1,234.00",
        empty: false,
      });
      expect(events).toEqual([]);
      expect(native).toEqual([]);
      expect(ahead.value).toBe("42");
      expect(input("a").value).toBe("1,234.00５");
      expect(document.activeElement).toBe(input("a"));
      expect([input("a").selectionStart, input("a").selectionEnd]).toEqual([9, 9]);
    });

    it("lets its only display leave the target mid-composition without an error, and keeps the committed outputs", async () => {
      await mountForm({ second: null });
      const events = record();
      // Collects what the deferred end of the composition throws; an error thrown
      // from a microtask would otherwise reach no assertion.
      const thrown: unknown[] = [];
      const native = globalThis.queueMicrotask;
      const queue = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
        native(() => {
          try {
            callback();
          } catch (error) {
            thrown.push(error);
          }
        });
      });
      try {
        startComposing(input("a"), "1,234.00５");
        input("a").removeAttribute("data-stimeo--currency-input-target");
        await tick();
      } finally {
        queue.mockRestore();
      }

      expect(thrown).toEqual([]);
      expect(events).toEqual([]);
      expect(outputs()).toEqual({
        field: "1234",
        submitted: "1234",
        spoken: "$1,234.00",
        empty: false,
      });
    });
  });

  describe("a request made while a composition runs", () => {
    /** Types `text` into `#a` as the user's own edit, outside any composition. */
    const typeInto = (text: string) => {
      input("a").focus();
      input("a").value = text;
      input("a").dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    };

    /** Starts a composition that appends `draft` to the text `#a` shows, caret after it. */
    const composeAtEnd = (draft: string) => {
      const text = input("a").value + draft;
      startComposing(input("a"), text);
      input("a").setSelectionRange(text.length, text.length);
      return text;
    };

    const caret = () => [input("a").selectionStart, input("a").selectionEnd];

    for (const call of ["format()", "blur"] as const) {
      it(`leaves the draft, caret and committed outputs alone on ${call} and rounds once with the commit`, async () => {
        await mountForm({ second: null });
        const events = record();
        typeInto("5.555");
        expect(events).toEqual([["change", 5.555]]);
        const draft = composeAtEnd("５");

        if (call === "format()") controller().format();
        else input("a").dispatchEvent(new FocusEvent("blur"));

        expect(input("a").value).toBe(draft);
        expect(caret()).toEqual([draft.length, draft.length]);
        expect(events).toEqual([["change", 5.555]]);
        expect(outputs()).toEqual({
          field: "5.555",
          submitted: "5.555",
          spoken: "$5.56",
          empty: false,
        });

        commit(input("a"), "5.5555");

        expect(events).toEqual([
          ["change", 5.555],
          ["change", 5.56],
        ]);
        expect(input("a").value).toBe("5.56");
        expect(outputs().submitted).toBe("5.56");

        // The next conversion's commit is not rounded: nothing stays held.
        startComposing(input("a"), "5.56５");
        commit(input("a"), "5.565");
        expect(events.at(-1)).toEqual(["change", 5.565]);
        expect(input("a").value).toBe("5.565");
      });
    }

    it("rounds the commit with the precision it was typed against before a held change applies", async () => {
      await mountForm({ second: null });
      const events = record();
      typeInto("5.555");
      composeAtEnd("５");
      root().setAttribute("data-stimeo--currency-input-precision-value", "0");
      controller().precisionValueChanged();
      controller().format();

      commit(input("a"), "5.5555");

      // The focused display is re-rendered under the new precision without rounding again.
      expect(events).toEqual([
        ["change", 5.555],
        ["change", 5.56],
      ]);
      expect(input("a").value).toBe("5.56");
    });

    it("rounds once when a composition a format() call waited on is cancelled", async () => {
      await mountForm({ second: null });
      const events = record();
      typeInto("5.555");
      composeAtEnd("５");
      controller().format();
      commit(input("a"), "5.555");

      expect(events).toEqual([
        ["change", 5.555],
        ["change", 5.56],
      ]);
      expect(input("a").value).toBe("5.56");
    });

    it("holds a format call with an event that has no target as it holds one with none", async () => {
      await mountForm({ second: null });
      const events = record();
      typeInto("5.555");
      const draft = composeAtEnd("５");
      controller().format(new Event("blur"));
      expect(input("a").value).toBe(draft);

      commit(input("a"), "5.5555");

      expect(events).toEqual([
        ["change", 5.555],
        ["change", 5.56],
      ]);
    });

    for (const isComposing of [true, false]) {
      it(`${isComposing ? "holds" : "applies at once"} a format bound to a key that ${isComposing ? "reports" : "does not report"} a composition the tracker never heard start`, async () => {
        await mountForm({ second: null });
        const events = record();
        typeInto("5.555");
        input("a").value = "5.555５";
        input("a").setSelectionRange(6, 6);
        input("a").addEventListener("keydown", (event) => controller().format(event), {
          once: true,
        });
        input("a").dispatchEvent(keyEvent("Enter", { isComposing }));

        if (isComposing) {
          expect(input("a").value).toBe("5.555５");
          expect(caret()).toEqual([6, 6]);
          expect(events).toEqual([["change", 5.555]]);
          commit(input("a"), "5.5555");
        }

        expect(events).toEqual([
          ["change", 5.555],
          ["change", 5.56],
        ]);
        expect(input("a").value).toBe("5.56");
      });
    }

    describe("a rounding asked for during a composition the tracker never heard start", () => {
      const KEY_ACTION = `${ACTION} keydown->stimeo--currency-input#format`;

      /**
       * Types `5.555` and asks for the rounding through the declared `keydown` action with
       * a key that reports a composition no `compositionstart` announced.
       */
      const hold = async () => {
        await mountForm({ second: null });
        root().setAttribute("data-stimeo--currency-input-precision-value", "2");
        input("a").setAttribute("data-action", KEY_ACTION);
        await tick();
        const events = record();
        typeInto("5.555");
        input("a").dispatchEvent(keyEvent("Enter", { isComposing: true }));
        expect(input("a").value).toBe("5.555");
        expect(events).toEqual([["change", 5.555]]);
        return events;
      };

      /** An ordinary edit settles an unheard conversion before the following blur rounds. */
      const holdThenEditAndBlur = async () => {
        const events = await hold();

        input("a").dispatchEvent(new FocusEvent("blur"));
        expect(input("a").value).toBe("5.555");
        expect(events).toEqual([["change", 5.555]]);
        input("a").dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertText" }),
        );
        input("a").dispatchEvent(new FocusEvent("blur"));
        expect(input("a").value).toBe("5.56");
        expect(outputs()).toEqual({
          field: "5.56",
          submitted: "5.56",
          spoken: "$5.56",
          empty: false,
        });
        expect(events).toEqual([
          ["change", 5.555],
          ["change", 5.56],
        ]);
        return events;
      };

      type Recorded = Array<[string, number | null]>;

      /**
       * After the commit of `1.234`, following the events `before`, the next blur is the first
       * to round it.
       */
      const expectUnroundedUntilBlur = (events: Recorded, before: Recorded) => {
        expect(input("a").value).toBe("1.234");
        expect([input("a").selectionStart, input("a").selectionEnd]).toEqual([5, 5]);
        expect(outputs()).toEqual({
          field: "1.234",
          submitted: "1.234",
          spoken: "$1.23",
          empty: false,
        });
        expect(events).toEqual([...before, ["change", 1.234]]);

        input("a").dispatchEvent(new FocusEvent("blur"));

        expect(input("a").value).toBe("1.23");
        expect(outputs()).toEqual({
          field: "1.23",
          submitted: "1.23",
          spoken: "$1.23",
          empty: false,
        });
        expect(events).toEqual([...before, ["change", 1.234], ["change", 1.23]]);
      };

      const roundedByBlur: Recorded = [
        ["change", 5.555],
        ["change", 5.56],
      ];

      it("does not round the next composition the user confirms after an ordinary edit and blur rounded the entry", async () => {
        const events = await holdThenEditAndBlur();

        startComposing(input("a"), "1.234");
        input("a").setSelectionRange(5, 5);
        commit(input("a"), "1.234");

        expectUnroundedUntilBlur(events, roundedByBlur);
      });

      it("does not round a later commit whose start it never heard either, once an ordinary edit and blur rounded the entry", async () => {
        const events = await holdThenEditAndBlur();

        input("a").focus();
        composeDraft(input("a"), "1.234");
        input("a").setSelectionRange(5, 5);
        commit(input("a"), "1.234");

        expectUnroundedUntilBlur(events, roundedByBlur);
      });

      it("does not round the next composition the user confirms when it starts with no blur in between", async () => {
        const events = await hold();

        // The start the tracker hears shows the composition the key reported is over.
        startComposing(input("a"), "1.234");
        expect(input("a").value).toBe("1.234");
        expect(events).toEqual([["change", 5.555]]);
        input("a").setSelectionRange(5, 5);
        commit(input("a"), "1.234");

        expectUnroundedUntilBlur(events, [["change", 5.555]]);
      });

      it("rounds once when the composition the key reported ends, with no blur and no start in between", async () => {
        const events = await hold();

        // Only that composition's own end arrives: the rounding asked of it applies once.
        input("a").setSelectionRange(5, 5);
        commit(input("a"), "5.5555");

        expect(input("a").value).toBe("5.56");
        expect(outputs()).toEqual({
          field: "5.56",
          submitted: "5.56",
          spoken: "$5.56",
          empty: false,
        });
        expect(events).toEqual([
          ["change", 5.555],
          ["change", 5.56],
        ]);

        input("a").dispatchEvent(new FocusEvent("blur"));
        expect(events).toHaveLength(2);
      });

      it("holds a rounding asked through an event with no target for the display in charge", async () => {
        await mountForm({ second: null });
        root().setAttribute("data-stimeo--currency-input-precision-value", "2");
        await tick();
        const events = record();
        typeInto("5.555");

        // A script asks with an event it built: it reports a composition and has no target.
        controller().format(keyEvent("Enter", { isComposing: true }));
        expect(input("a").value).toBe("5.555");
        expect(events).toEqual([["change", 5.555]]);

        input("a").setSelectionRange(5, 5);
        commit(input("a"), "5.5555");

        expect(input("a").value).toBe("5.56");
        expect(outputs()).toEqual({
          field: "5.56",
          submitted: "5.56",
          spoken: "$5.56",
          empty: false,
        });
        expect(events).toEqual([
          ["change", 5.555],
          ["change", 5.56],
        ]);
      });

      it("holds nothing for such a request while no display is connected", async () => {
        await mountForm({ second: null });
        input("a").remove();
        await tick();
        const events = record();

        expect(() => controller().format(keyEvent("Enter", { isComposing: true }))).not.toThrow();
        expect(events).toEqual([]);
      });

      /** A display `#b` as the page renders one, showing `value`, with the same actions. */
      const pageDisplay = (value: string) => {
        const display = document.createElement("input");
        display.id = "b";
        display.type = "text";
        display.setAttribute("aria-describedby", "sr");
        display.setAttribute("value", value);
        display.setAttribute("data-stimeo--currency-input-target", "display");
        display.setAttribute("data-action", KEY_ACTION);
        return display;
      };

      /** Confirms `1.234` in `#b` through a composition the tracker never heard start. */
      const commitUnheardInB = () => {
        input("b").focus();
        composeDraft(input("b"), "1.234");
        input("b").setSelectionRange(5, 5);
        commit(input("b"), "1.234");
      };

      /** The commit of `1.234` in `#b` stays as confirmed, after `before`, until `#b` blurs. */
      const expectBUnroundedUntilBlur = (events: Recorded, before: Recorded) => {
        expect(input("b").value).toBe("1.234");
        expect([input("b").selectionStart, input("b").selectionEnd]).toEqual([5, 5]);
        expect(outputs()).toEqual({
          field: "1.234",
          submitted: "1.234",
          spoken: "$1.23",
          empty: false,
        });
        expect(events).toEqual([...before, ["change", 1.234]]);

        input("b").dispatchEvent(new FocusEvent("blur"));

        expect(input("b").value).toBe("1.23");
        expect(outputs().submitted).toBe("1.23");
        expect(events).toEqual([...before, ["change", 1.234], ["change", 1.23]]);
      };

      it("does not round a commit in a display that replaced the one it was held for", async () => {
        const events = await hold();

        // The page swaps the display for another element, as a Turbo render does.
        input("a").replaceWith(pageDisplay("5.555"));
        await tick();
        expect(input("b").value).toBe("5.56");
        expect(events).toEqual([
          ["change", 5.555],
          ["reconcile", 5.56],
        ]);

        commitUnheardInB();

        expectBUnroundedUntilBlur(events, [
          ["change", 5.555],
          ["reconcile", 5.56],
        ]);
      });

      it("does not round a commit in a display that was behind the one it was held for once that one leaves", async () => {
        const events = await hold();
        input("a").after(pageDisplay("5.555"));
        await tick();

        // The display it was held for leaves; the one behind it comes in charge.
        input("a").remove();
        await tick();
        expect(input("b").value).toBe("5.56");
        expect(events).toEqual([
          ["change", 5.555],
          ["reconcile", 5.56],
        ]);

        commitUnheardInB();

        expectBUnroundedUntilBlur(events, [
          ["change", 5.555],
          ["reconcile", 5.56],
        ]);
      });

      it("keeps an unknown entry pending after its display returns without carrying its old rounding", async () => {
        const events = await hold();
        const display = input("a");
        const sr = document.getElementById("sr") as HTMLElement;

        // The display leaves with its composition, and the page puts the same element back.
        display.remove();
        await tick();
        sr.before(display);
        await tick();
        expect(display.value).toBe("5.555");
        expect(events).toEqual([["change", 5.555]]);

        display.focus();
        composeDraft(display, "1.234");
        display.setSelectionRange(5, 5);
        commit(display, "1.234");

        expectUnroundedUntilBlur(events, [["change", 5.555]]);
      });

      it("does not round the display in charge when a composition ends in a display behind it", async () => {
        const events = await hold();
        // The page binds the rounding to the key alone, so leaving the display does not round.
        input("a").setAttribute(
          "data-action",
          "input->stimeo--currency-input#onInput keydown->stimeo--currency-input#format",
        );
        input("a").after(pageDisplay("9"));
        await tick();

        // Another composition ends in the display behind: the one the key reported is over.
        input("b").focus();
        composeDraft(input("b"), "9５");
        commit(input("b"), "95");

        expect(input("a").value).toBe("5.555");
        expect(outputs()).toEqual({
          field: "5.555",
          submitted: "5.555",
          spoken: "$5.56",
          empty: false,
        });
        expect(events).toEqual([["change", 5.555]]);

        // The rounding lapsed with that end: a later commit in the display it was held for,
        // whose start the tracker never heard either, stays as confirmed.
        input("a").focus();
        composeDraft(input("a"), "1.234");
        input("a").setSelectionRange(5, 5);
        commit(input("a"), "1.234");

        expect(input("a").value).toBe("1.234");
        expect([input("a").selectionStart, input("a").selectionEnd]).toEqual([5, 5]);
        expect(outputs()).toEqual({
          field: "1.234",
          submitted: "1.234",
          spoken: "$1.23",
          empty: false,
        });
        expect(events).toEqual([
          ["change", 5.555],
          ["change", 1.234],
        ]);
      });

      it("keeps the rounding for the display it was held for when another display leaves", async () => {
        const events = await hold();
        input("a").after(pageDisplay("9"));
        await tick();

        // A display behind leaves; the display the rounding was held for stays in charge.
        input("b").remove();
        await tick();
        expect(input("a").value).toBe("5.555");
        expect(events).toEqual([["change", 5.555]]);

        composeDraft(input("a"), "5.555５");
        input("a").setSelectionRange(6, 6);
        commit(input("a"), "5.5555");

        expect(input("a").value).toBe("5.56");
        expect(outputs()).toEqual({
          field: "5.56",
          submitted: "5.56",
          spoken: "$5.56",
          empty: false,
        });
        expect(events).toEqual([
          ["change", 5.555],
          ["change", 5.56],
        ]);
      });
    });

    for (const between of ["a blur", "an edit", "nothing"] as const) {
      it(`drops a rounding held for a composition the tracker never heard when the next one starts, after ${between}`, async () => {
        await mountForm({ second: null });
        const events = record();
        typeInto("5.555");
        input("a").addEventListener("keydown", (event) => controller().format(event), {
          once: true,
        });
        input("a").dispatchEvent(keyEvent("Enter", { isComposing: true }));
        expect(input("a").value).toBe("5.555");
        if (between === "a blur") input("a").dispatchEvent(new FocusEvent("blur"));
        if (between === "an edit") typeInto("7.123");

        const confirmed = `${input("a").value}55`;
        startComposing(input("a"), `${input("a").value}５５`);
        commit(input("a"), confirmed);

        expect(events.at(-1)).toEqual(["change", Number(confirmed)]);
        expect(input("a").value).toBe(confirmed);
      });
    }

    it("reads what a composition left in place without the held rounding before a held change applies", async () => {
      await mountForm({ second: null });
      const events = record();
      typeInto("5.555");
      composeAtEnd("５");
      root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
      controller().localeValueChanged();
      controller().format();

      endWithoutCompositionend(input("a"));
      await tick();

      // The user may go on typing in place: the text is read as typed, not rounded.
      expect(events).toEqual([
        ["change", 5.555],
        ["reconcile", 5.5555],
      ]);
      expect(input("a").value).toBe("5,5555");
    });

    it("drops a held rounding when the composition ends in place, so the next keys land on the text as typed", async () => {
      await mountForm({ second: null });
      const events = record();
      typeInto("5.555");
      composeAtEnd("５");
      controller().format();

      endWithoutCompositionend(input("a"));
      await tick();
      expect(events).toEqual([["change", 5.555]]);
      expect(input("a").value).toBe("5.555５");

      // The user goes on composing in place; that conversion's commit is not rounded.
      startComposing(input("a"), "5.555５６");
      commit(input("a"), "5.55556");
      expect(events).toEqual([
        ["change", 5.555],
        ["change", 5.55556],
      ]);
      expect(input("a").value).toBe("5.55556");

      input("a").dispatchEvent(new FocusEvent("blur"));
      expect(events.at(-1)).toEqual(["change", 5.56]);
    });

    it("drops a held rounding when a write ends the composition, and the next blur reads the page's text once", async () => {
      await mountForm({ second: null });
      const events = record();
      typeInto("5.555");
      composeAtEnd("５");
      controller().format();

      endWithoutCompositionend(input("a"), "7.777");
      await tick();
      expect(events).toEqual([["change", 5.555]]);
      expect(input("a").value).toBe("7.777");

      input("a").dispatchEvent(new FocusEvent("blur"));
      expect(events).toEqual([
        ["change", 5.555],
        ["change", 7.78],
      ]);
      expect(input("a").value).toBe("7.78");
    });

    it("drops a held rounding when a composition starts before the first one ends", async () => {
      await mountForm({ second: null });
      const events = record();
      typeInto("5.555");
      composeAtEnd("５");
      controller().format();
      // The engine starts a new conversion without ending the first one.
      input("a").dispatchEvent(new Event("compositionstart", { bubbles: true }));
      composeDraft(input("a"), "5.555５６");
      expect(events).toEqual([["change", 5.555]]);
      expect(input("a").value).toBe("5.555５６");

      commit(input("a"), "5.55556");

      expect(events).toEqual([
        ["change", 5.555],
        ["change", 5.55556],
      ]);
      expect(input("a").value).toBe("5.55556");
    });

    it("keeps a held rounding for a composition that goes on through a move", async () => {
      await mountForm({ second: null });
      const events = record();
      typeInto("5.555");
      composeAtEnd("５");
      controller().format();
      reconnectKeepingFocus(controller());
      await tick();
      expect(events).toEqual([["change", 5.555]]);
      expect(input("a").value).toBe("5.555５");

      commit(input("a"), "5.5555");

      expect(events).toEqual([
        ["change", 5.555],
        ["change", 5.56],
      ]);
    });

    it("keeps a held rounding when the composing display moves keeping focus", async () => {
      await mountForm({ second: null });
      const events = record();
      typeInto("5.555");
      composeAtEnd("５");
      controller().format();
      // A move that keeps focus, as `moveBefore` does (happy-dom has none): the display
      // leaves the targets and comes back as the same element, still composing.
      controller().displayTargetDisconnected(input("a"));
      controller().displayTargetConnected(input("a"));
      await tick();
      expect(events).toEqual([["change", 5.555]]);
      expect(input("a").value).toBe("5.555５");

      commit(input("a"), "5.5555");

      expect(events).toEqual([
        ["change", 5.555],
        ["change", 5.56],
      ]);
      expect(input("a").value).toBe("5.56");
    });

    it("keeps a held rounding when a display behind the composing one leaves", async () => {
      await mountForm();
      const events = record();
      typeInto("5.555");
      composeAtEnd("５");
      controller().format();

      // Another display leaves; the composition the rounding was held for goes on.
      input("b").remove();
      await tick();
      expect(events).toEqual([["change", 5.555]]);
      expect(input("a").value).toBe("5.555５");

      commit(input("a"), "5.5555");

      expect(input("a").value).toBe("5.56");
      expect(outputs()).toEqual({
        field: "5.56",
        submitted: "5.56",
        spoken: "$5.56",
        empty: false,
      });
      expect(events).toEqual([
        ["change", 5.555],
        ["change", 5.56],
      ]);
    });

    it("keeps a held rounding through an onInput() call during the composition", async () => {
      await mountForm({ second: null });
      const events = record();
      typeInto("5.555");
      composeAtEnd("５");
      controller().format();
      controller().onInput();

      commit(input("a"), "5.555");

      expect(events).toEqual([
        ["change", 5.555],
        ["change", 5.56],
      ]);
      expect(input("a").value).toBe("5.56");
    });

    it("leaves the draft alone on an onInput() call and reads the commit once", async () => {
      await mountForm({ second: null });
      const events = record();
      typeInto("5678");
      const draft = composeAtEnd("９");
      controller().onInput();

      expect(input("a").value).toBe(draft);
      expect(caret()).toEqual([draft.length, draft.length]);
      expect(events).toEqual([["change", 5678]]);

      commit(input("a"), "56789");

      expect(events).toEqual([
        ["change", 5678],
        ["change", 56789],
      ]);
      expect(input("a").value).toBe("56,789");
    });

    for (const called of [false, true]) {
      it(`leaves text a composition left in place to the next edit${called ? " after an onInput() call" : ""}`, async () => {
        await mountForm({ second: null });
        const events = record();
        typeInto("5678");
        composeAtEnd("９");
        if (called) controller().onInput();

        endWithoutCompositionend(input("a"));
        await tick();

        expect(events).toEqual([["change", 5678]]);
        expect(input("a").value).toBe("5,678９");
      });
    }

    for (const request of ["format()", "a script's blur"] as const) {
      it(`rounds the display in charge after what a composition behind owes, asked through ${request}`, async () => {
        await mountForm();
        const events = record();
        startComposing(input("b"), "５");
        input("a").value = "42.555";
        await morphUnchanged();
        input("a").focus();
        // The rounding belongs to the composition running behind, wherever the request came from.
        if (request === "format()") controller().format();
        else input("a").dispatchEvent(new FocusEvent("blur"));
        expect(events).toEqual([]);

        commit(input("b"), "５");

        expect(events).toEqual([
          ["reconcile", 42.555],
          ["change", 42.56],
        ]);
        expect(input("a").value).toBe("42.56");
      });
    }

    it("holds nothing for a blur in a display behind while it composes", async () => {
      await mountForm();
      const events = record();
      typeInto("5.555");
      input("b").dispatchEvent(new Event("compositionstart", { bubbles: true }));
      input("b").dispatchEvent(new FocusEvent("blur"));

      commit(input("b"), "５");

      expect(events).toEqual([["change", 5.555]]);
      expect(input("a").value).toBe("5.555");
    });

    it("drops a held rounding when the composing display leaves", async () => {
      await mountForm({ second: "1,234.00" });
      const events = record();
      composeAtEnd("５");
      controller().format();
      input("a").remove();
      await tick();
      expect(events).toEqual([]);

      // Nothing is left held for the next composition.
      startComposing(input("b"), `${input("b").value}５`);
      commit(input("b"), "1,234.005");

      expect(events).toEqual([["change", 1234.005]]);
      expect(input("b").value).toBe("1,234.005");
    });

    it("drops a held rounding across an unknown focused reconnect without adopting its draft", async () => {
      await mountForm({ second: null });
      const events = record();
      typeInto("5.555");
      composeAtEnd("５");
      controller().format();
      const instance = controller();
      // A focused reconnect cannot infer that an unheard conversion ended.
      instance.context.disconnect();
      await tick();
      instance.context.connect();
      await tick();
      expect(input("a").value).toBe("5.555５");
      expect(outputs().submitted).toBe("5.555");

      startComposing(input("a"), "5.56５");
      commit(input("a"), "5.565");

      expect(events.at(-1)).toEqual(["change", 5.565]);
      expect(input("a").value).toBe("5.565");
    });

    it("rounds what a composition left once, as the page's, when the controller element leaves", async () => {
      await mountForm({ second: null });
      const events = record();
      typeInto("5.555");
      composeAtEnd("５");
      controller().format();
      const part = root();
      const parent = part.parentElement as HTMLElement;
      part.remove();
      await tick();
      // Leaving ends the composition: its text is read and rounded once, as the page's.
      expect(events).toEqual([
        ["change", 5.555],
        ["reconcile", 5.56],
      ]);

      parent.append(part);
      await tick();
      expect(input("a").value).toBe("5.56");
      expect(events).toHaveLength(2);

      startComposing(input("a"), "5.56５");
      commit(input("a"), "5.565");

      expect(events.at(-1)).toEqual(["change", 5.565]);
      expect(input("a").value).toBe("5.565");
    });
  });

  describe("an input that reports a composition", () => {
    for (const isComposing of [true, false]) {
      it(`${isComposing ? "is not read" : "is read"} when it ${isComposing ? "says" : "does not say"} it is composing, with no compositionstart heard`, async () => {
        await mountForm({ second: null });
        const events = record();
        input("a").focus();
        input("a").value = "56789";
        input("a").setSelectionRange(5, 5);
        input("a").dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            isComposing,
            inputType: isComposing ? "insertCompositionText" : "insertText",
          }),
        );

        if (isComposing) {
          expect(input("a").value).toBe("56789");
          expect([input("a").selectionStart, input("a").selectionEnd]).toEqual([5, 5]);
          expect(events).toEqual([]);
          expect(outputs()).toEqual({
            field: "1234",
            submitted: "1234",
            spoken: "$1,234.00",
            empty: false,
          });
        } else {
          expect(input("a").value).toBe("56,789");
          expect(events).toEqual([["change", 56789]]);
          expect(outputs().submitted).toBe("56789");
        }
      });
    }
  });

  describe("a composition that starts before the one it ends was heard ending", () => {
    it("keeps a rounding the page asks for from the reconcile a new composition's start reports", async () => {
      await mountForm({ second: null });
      const events = record();
      startComposing(input("a"), "1,234.00５");
      const ahead = document.createElement("input");
      ahead.value = "42.555";
      ahead.setAttribute("data-stimeo--currency-input-target", "display");
      input("a").before(ahead);
      await tick();
      root().addEventListener("stimeo--currency-input:reconcile", () => controller().format(), {
        once: true,
      });

      ahead.focus();
      ahead.setSelectionRange(6, 6);
      ahead.dispatchEvent(new Event("compositionstart", { bubbles: true }));
      expect(events).toEqual([["reconcile", 42.555]]);
      expect(ahead.value).toBe("42.555");

      composeDraft(ahead, "42.555５");
      ahead.value = "42.5555";
      ahead.dispatchEvent(new Event("compositionend", { bubbles: true }));

      expect(events).toEqual([
        ["reconcile", 42.555],
        ["change", 42.56],
      ]);
      expect(ahead.value).toBe("42.56");
    });

    it("reports the page's value in a display that came ahead before the user's commit in it", async () => {
      await mountForm({ second: null });
      const events = record();
      startComposing(input("a"), "1,234.00５");
      const ahead = document.createElement("input");
      ahead.value = "42";
      ahead.setAttribute("data-stimeo--currency-input-target", "display");
      input("a").before(ahead);
      await tick();
      expect(events).toEqual([]);

      // The user moves on to the display ahead and composes there; the first
      // composition's end was never heard.
      ahead.focus();
      ahead.setSelectionRange(2, 2);
      ahead.dispatchEvent(new Event("compositionstart", { bubbles: true }));

      expect(events).toEqual([["reconcile", 42]]);
      expect(ahead.value).toBe("42");
      expect([ahead.selectionStart, ahead.selectionEnd]).toEqual([2, 2]);
      expect(outputs()).toEqual({
        field: "42",
        submitted: "42",
        spoken: "$42.00",
        empty: false,
      });

      composeDraft(ahead, "42５");
      expect(events).toEqual([["reconcile", 42]]);
      ahead.value = "425";
      ahead.dispatchEvent(new Event("compositionend", { bubbles: true }));

      expect(events).toEqual([
        ["reconcile", 42],
        ["change", 425],
      ]);
      expect(ahead.value).toBe("425");
      expect(outputs().submitted).toBe("425");
    });

    it("leaves what a composition left in place to the next edit once the page's text it started on was read", async () => {
      await mountForm({ second: null });
      const events = record();
      startComposing(input("a"), "1,234.00５");
      const ahead = document.createElement("input");
      ahead.value = "42";
      ahead.setAttribute("data-stimeo--currency-input-target", "display");
      ahead.setAttribute("data-action", ACTION);
      input("a").before(ahead);
      await tick();
      ahead.focus();
      ahead.setSelectionRange(2, 2);
      ahead.dispatchEvent(new Event("compositionstart", { bubbles: true }));
      composeDraft(ahead, "42５");

      endWithoutCompositionend(ahead);
      await tick();
      expect(events).toEqual([["reconcile", 42]]);
      expect(ahead.value).toBe("42５");

      ahead.value = "42５6";
      ahead.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

      expect(events).toEqual([
        ["reconcile", 42],
        ["change", 4256],
      ]);
    });

    it("reports the page's write into the display in charge before the user's commit in it", async () => {
      await mountForm();
      const events = record();
      startComposing(input("b"), "５");
      input("a").value = "42";
      await morphUnchanged();
      expect(events).toEqual([]);

      input("a").focus();
      input("a").setSelectionRange(2, 2);
      input("a").dispatchEvent(new Event("compositionstart", { bubbles: true }));

      expect(events).toEqual([["reconcile", 42]]);
      expect(input("a").value).toBe("42");

      composeDraft(input("a"), "42５");
      commit(input("a"), "425");

      expect(events).toEqual([
        ["reconcile", 42],
        ["change", 425],
      ]);
      expect(outputs().submitted).toBe("425");
    });

    /** Composes in `#a`, holds a switch to de-DE, and lets the page write `text` into `#a`. */
    const writeWhileHeld = async (text: string) => {
      startComposing(input("a"), "1,234.00５");
      root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
      controller().localeValueChanged();
      await tick();
      input("a").value = text;
      input("a").setSelectionRange(text.length, text.length);
    };

    it("reads a page's write with the declarations it carries when the user composes again in the same display", async () => {
      await mountForm({ second: null });
      const events = record();
      await writeWhileHeld("1.234,5");

      input("a").dispatchEvent(new Event("compositionstart", { bubbles: true }));

      expect(events).toEqual([["reconcile", 1234.5]]);
      expect(input("a").value).toBe("1.234,5");
      expect(outputs().submitted).toBe("1234.5");

      composeDraft(input("a"), "1.234,5６");
      commit(input("a"), "1.234,56");

      expect(events).toEqual([
        ["reconcile", 1234.5],
        ["change", 1234.56],
      ]);
      expect(input("a").value).toBe("1.234,56");
    });

    it("reads the page's text it read at the start with those declarations after that composition ends in place", async () => {
      await mountForm({ second: null });
      const events = record();
      await writeWhileHeld("1.234,5");
      input("a").dispatchEvent(new Event("compositionstart", { bubbles: true }));
      endWithoutCompositionend(input("a"));
      await tick();

      root().setAttribute("data-stimeo--currency-input-locale-value", "en-US");
      controller().localeValueChanged();

      expect(events).toEqual([["reconcile", 1234.5]]);
      expect(input("a").value).toBe("1,234.5");
    });

    it("leaves a page's write into the display it composed in to the commit when nothing is owed", async () => {
      await mountForm({ second: null });
      const events = record();
      startComposing(input("a"), "1,234.00５");
      input("a").value = "42";
      input("a").setSelectionRange(2, 2);

      input("a").dispatchEvent(new Event("compositionstart", { bubbles: true }));
      expect(events).toEqual([]);

      commit(input("a"), "425");
      expect(events).toEqual([["change", 425]]);
    });

    it("reads what a composition left in the display in charge with the separators it was typed against when one starts behind it", async () => {
      await mountForm();
      const events = record();
      startComposing(input("a"), "1,234.5");
      root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
      controller().localeValueChanged();
      await tick();

      input("b").dispatchEvent(new Event("compositionstart", { bubbles: true }));
      expect(events).toEqual([["reconcile", 1234.5]]);
      expect(input("a").value).toBe("1,234.5");

      commit(input("b"), "５");

      expect(events).toEqual([["reconcile", 1234.5]]);
      expect(input("a").value).toBe("1.234,5");
    });

    it("leaves a page's write into the display in charge to the end of a composition that starts behind it", async () => {
      await mountForm();
      const events = record();
      startComposing(input("a"), "1,234.00５");
      root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
      controller().localeValueChanged();
      await tick();
      input("a").value = "42";

      input("b").dispatchEvent(new Event("compositionstart", { bubbles: true }));
      expect(events).toEqual([]);

      commit(input("b"), "５");

      expect(events).toEqual([["reconcile", 42]]);
      expect(input("a").value).toBe("42");
    });

    it("keeps a rounding the page asks for from the reconcile of what a composition left when one starts behind it", async () => {
      await mountForm();
      const events = record();
      startComposing(input("a"), "1,234.00５");
      root().addEventListener("stimeo--currency-input:reconcile", () => controller().format(), {
        once: true,
      });

      input("b").dispatchEvent(new Event("compositionstart", { bubbles: true }));
      expect(events).toEqual([["reconcile", 1234.005]]);

      commit(input("b"), "５");

      expect(events).toEqual([
        ["reconcile", 1234.005],
        ["change", 1234.01],
      ]);
      expect(input("a").value).toBe("1,234.01");
    });

    it("reads the text a composition left in the display in charge when one starts behind it", async () => {
      await mountForm();
      const events = record();
      startComposing(input("a"), "1,234.00５");
      input("b").dispatchEvent(new Event("compositionstart", { bubbles: true }));
      expect(events).toEqual([["reconcile", 1234.005]]);
      expect(input("a").value).toBe("1,234.005");

      commit(input("b"), "５");

      expect(events).toEqual([["reconcile", 1234.005]]);
    });

    for (const blurFormats of [true, false]) {
      it(`reads what the user left in the display in charge with its own separators when the locale changes during a composition behind it${blurFormats ? ", rounding as its blur asked" : ""}`, async () => {
        await mountForm();
        if (!blurFormats) {
          input("a").setAttribute("data-action", "input->stimeo--currency-input#onInput");
          await tick();
        }
        const events = record();
        startComposing(input("a"), "1,234.00５");
        // The user moves to the display behind; the first conversion's end goes unheard.
        startComposing(input("b"), "５");
        root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
        controller().localeValueChanged();
        await tick();

        commit(input("b"), "５");

        expect(input("a").value).toBe("1.234,01");
        expect(outputs().submitted).toBe("1234.01");
        expect(events).toEqual(
          blurFormats
            ? [["reconcile", 1234.01]]
            : [
                ["reconcile", 1234.005],
                ["reconcile", 1234.01],
              ],
        );
      });
    }

    it("keeps a held locale change for a composition that starts again in the same display", async () => {
      await mountForm({ second: null });
      const events = record();
      startComposing(input("a"), "1,234.5");
      root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
      controller().localeValueChanged();
      // A new conversion starts in the same display without the first one ending.
      input("a").dispatchEvent(new Event("compositionstart", { bubbles: true }));
      composeDraft(input("a"), "1,234.56");
      expect(events).toEqual([]);

      commit(input("a"), "1,234.56");

      expect(events).toEqual([["change", 1234.56]]);
      expect(input("a").value).toBe("1.234,56");
    });

    it("keeps a held locale change for a composition in the display in charge that still shows its own rendering", async () => {
      await mountForm();
      const events = record();
      startComposing(input("b"), "５");
      root().setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
      controller().localeValueChanged();

      input("a").focus();
      input("a").dispatchEvent(new Event("compositionstart", { bubbles: true }));
      expect(events).toEqual([]);
      expect(input("a").value).toBe("1,234.00");

      composeDraft(input("a"), "1,234.005");
      commit(input("a"), "1,234.005");

      expect(events).toEqual([["change", 1234.005]]);
      expect(input("a").value).toBe("1.234,005");
    });
  });
});
