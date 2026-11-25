import { CharacterCounterController } from "../../src/controllers/character_counter_controller";
import { CurrencyInputController } from "../../src/controllers/currency_input_controller";
import { MultiSelectController } from "../../src/controllers/multi_select_controller";
import { OtpController } from "../../src/controllers/otp_controller";
import type { ConfirmedInputCase } from "./confirmed_input";

/** The element with `id`, which the case's markup is expected to hold. */
const required = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} not found`);
  return element as T;
};

export const characterCounter: ConfirmedInputCase = {
  identifier: "stimeo--character-counter",
  controller: CharacterCounterController,
  markup: `
    <div data-controller="stimeo--character-counter" data-stimeo--character-counter-max-value="10">
      <textarea id="cc-field" aria-label="Message" aria-describedby="cc-output"
                data-stimeo--character-counter-target="input"></textarea>
      <span id="cc-output" data-stimeo--character-counter-target="output"></span>
    </div>`,
  field: () => required<HTMLTextAreaElement>("cc-field"),
  draft: "にほんご",
  committed: "日本語",
  written: "日本語ですよね",
  facts: () => ({ output: required("cc-output").textContent }),
};

export const currencyInput: ConfirmedInputCase = {
  identifier: "stimeo--currency-input",
  controller: CurrencyInputController,
  markup: `
    <form id="ci-form">
    <div data-controller="stimeo--currency-input" data-stimeo--currency-input-locale-value="en-US"
         data-stimeo--currency-input-currency-value="USD"
         data-stimeo--currency-input-precision-value="2">
      <input id="ci-display" type="text" inputmode="decimal" aria-label="Amount"
             data-stimeo--currency-input-target="display"
             data-action="input->stimeo--currency-input#onInput blur->stimeo--currency-input#format">
      <input id="ci-field" name="amount" type="hidden" data-stimeo--currency-input-target="field">
    </div>
    </form>`,
  field: () => required<HTMLInputElement>("ci-display"),
  draft: "1234",
  committed: "1234",
  written: "1234567",
  facts: () => ({
    display: required<HTMLInputElement>("ci-display").value,
    field: required<HTMLInputElement>("ci-field").value,
    formData: new FormData(required<HTMLFormElement>("ci-form")).get("amount"),
  }),
};

export const multiSelectQuery: ConfirmedInputCase = {
  identifier: "stimeo--multi-select",
  controller: MultiSelectController,
  markup: `
    <div data-controller="stimeo--multi-select">
      <ul data-stimeo--multi-select-target="tags" aria-label="Selected"></ul>
      <input id="ms-query" type="text" role="combobox" aria-expanded="false"
             aria-autocomplete="list" aria-controls="ms-options" aria-label="Fruits"
             data-stimeo--multi-select-target="input"
             data-action="input->stimeo--multi-select#filter
                          keydown->stimeo--multi-select#onKeydown">
      <ul id="ms-options" role="listbox" aria-multiselectable="true" aria-label="Fruits" hidden
          data-stimeo--multi-select-target="list">
        <li role="option" aria-selected="false" data-value="ringo"
            data-stimeo--multi-select-target="option">りんご</li>
        <li role="option" aria-selected="false" data-value="mikan"
            data-stimeo--multi-select-target="option">みかん</li>
      </ul>
      <template data-stimeo--multi-select-target="tagTemplate">
        <li data-stimeo--multi-select-target="tag">
          <span data-stimeo--multi-select-target="label"></span>
          <button type="button" tabindex="-1" aria-label="Remove {label}"
                  data-stimeo--multi-select-target="remove">×</button>
        </li>
      </template>
    </div>`,
  field: () => required<HTMLInputElement>("ms-query"),
  draft: "りんご",
  committed: "りんご",
  written: "みかん",
  facts: () => ({
    shown: Array.from(
      document.querySelectorAll<HTMLElement>("#ms-options [role='option']"),
      (option) => (option.hidden ? null : option.dataset.value),
    ).filter((value) => value !== null),
  }),
};

export const otp: ConfirmedInputCase = {
  identifier: "stimeo--otp",
  controller: OtpController,
  markup: `
    <form id="otp-form">
    <div data-controller="stimeo--otp" data-stimeo--otp-pattern-value="[0-9]" role="group"
         aria-label="One-time passcode">
      ${[1, 2, 3, 4]
        .map(
          (n) => `<input id="otp-${n}" data-stimeo--otp-target="field" inputmode="numeric"
                  maxlength="1" aria-label="Digit ${n}"
                  data-action="input->stimeo--otp#onInput keydown->stimeo--otp#onKeydown">`,
        )
        .join("")}
      <input id="otp-value" name="code" type="hidden" data-stimeo--otp-target="value">
    </div>
    </form>`,
  field: () => required<HTMLInputElement>("otp-1"),
  draft: "1",
  committed: "1",
  written: "1234",
  facts: () => ({
    fields: [1, 2, 3, 4].map((n) => required<HTMLInputElement>(`otp-${n}`).value),
    value: required<HTMLInputElement>("otp-value").value,
    formData: new FormData(required<HTMLFormElement>("otp-form")).get("code"),
  }),
};
