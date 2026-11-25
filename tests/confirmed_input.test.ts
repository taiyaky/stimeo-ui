import { describe, expect, it } from "vitest";
import { type ConfirmedInputCase, observeConfirmedInput } from "./helpers/confirmed_input";
import {
  characterCounter,
  currencyInput,
  multiSelectQuery,
  otp,
} from "./helpers/confirmed_input_cases";

/** A page write after confirmation is accepted as the same write without a composition. */
const SCRIPT_INPUT = [
  ["right after the confirmation", false],
  ["after the field lost focus", true],
] as const;

/** Expected public state for the script edit and the confirmation before that edit. */
interface ControlledCase {
  readonly item: ConfirmedInputCase;
  readonly written: Record<string, unknown>;
  readonly confirmed: Record<string, unknown>;
}

const CASES: readonly (readonly [string, ControlledCase])[] = [
  [
    "stimeo--character-counter",
    { item: characterCounter, written: { output: "3" }, confirmed: { output: "7" } },
  ],
  [
    "stimeo--currency-input",
    {
      item: currencyInput,
      written: { display: "1,234,567", field: "1234567", formData: "1234567" },
      confirmed: { display: "1,234", field: "1234", formData: "1234" },
    },
  ],
  [
    "stimeo--multi-select",
    { item: multiSelectQuery, written: { shown: ["mikan"] }, confirmed: { shown: ["ringo"] } },
  ],
  [
    "stimeo--otp",
    {
      item: otp,
      written: { fields: ["1", "2", "3", "4"], value: "1234", formData: "1234" },
      confirmed: { fields: ["1", "", "", ""], value: "1", formData: "1" },
    },
  ],
];

/** A script's plain input changes the derived state after an IME confirmation. */
describe("the input that follows a confirmed composition", () => {
  describe.each(CASES)("%s", (_name, { item }) => {
    it.each(SCRIPT_INPUT)("handles a script's input %s", async (_when, blurred) => {
      const reference = await observeConfirmedInput(item, {
        composed: false,
        blurred,
        written: true,
      });
      const observed = await observeConfirmedInput(item, {
        composed: true,
        blurred,
        written: true,
      });
      expect(observed).toEqual(reference);
    });
  });
});

/** The reference edits and confirmations must each produce their expected public state. */
describe("confirmed-input controls", () => {
  describe.each(CASES)("%s", (_name, { item, written, confirmed }) => {
    it.each(SCRIPT_INPUT)(
      "handles a script's input %s without a composition before",
      async (_when, blurred) => {
        expect(
          await observeConfirmedInput(item, { composed: false, blurred, written: true }),
        ).toEqual(written);
      },
    );

    it("reflects the confirmed composition before the script writes", async () => {
      expect(
        await observeConfirmedInput(item, { composed: true, blurred: false, written: false }),
      ).toEqual(confirmed);
    });
  });
});
