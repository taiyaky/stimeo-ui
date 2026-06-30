import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RatingController } from "../src/controllers/rating_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link RatingController}: the APG Radio Group contract for
 * an ordinal star scale — `aria-checked`, roving `tabindex`, clamped (non-wrap)
 * arrow control, hover/focus preview, clearing, the readonly `role="img"` view,
 * and the hidden-field mirror.
 *
 * Symbols carry their accessible name via `aria-label`; the visible glyph is the
 * consumer's CSS, so the markup leaves them empty (no double announcement).
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const markup = (attrs = "") => `
  <div data-controller="stimeo--rating" role="radiogroup" aria-label="Rating"
       data-stimeo--rating-value-value="2" data-stimeo--rating-max-value="3" ${attrs}>
    <span role="radio" aria-checked="false" aria-label="1 star" tabindex="-1"
          data-rating-value="1" data-stimeo--rating-target="symbol"
          data-action="click->stimeo--rating#select
                       mouseenter->stimeo--rating#preview
                       mouseleave->stimeo--rating#endPreview
                       keydown->stimeo--rating#onKeydown"></span>
    <span role="radio" aria-checked="true" aria-label="2 stars" tabindex="0"
          data-rating-value="2" data-stimeo--rating-target="symbol"
          data-action="click->stimeo--rating#select
                       mouseenter->stimeo--rating#preview
                       mouseleave->stimeo--rating#endPreview
                       keydown->stimeo--rating#onKeydown"></span>
    <span role="radio" aria-checked="false" aria-label="3 stars" tabindex="-1"
          data-rating-value="3" data-stimeo--rating-target="symbol"
          data-action="click->stimeo--rating#select
                       mouseenter->stimeo--rating#preview
                       mouseleave->stimeo--rating#endPreview
                       keydown->stimeo--rating#onKeydown"></span>
    <input type="hidden" data-stimeo--rating-target="field" />
  </div>`;

describe("RatingController", () => {
  let application: Application;

  const start = async (attrs = "") => {
    document.body.innerHTML = markup(attrs);
    application = Application.start();
    application.register("stimeo--rating", RatingController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--rating']") as HTMLElement;
  const symbols = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--rating-target='symbol']"));
  const field = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--rating-target='field']",
    ) as HTMLInputElement;
  const checked = () => symbols().map((symbol) => symbol.getAttribute("aria-checked"));
  const fill = () => symbols().map((symbol) => symbol.hasAttribute("data-rating-hover"));
  const tabindexes = () => symbols().map((symbol) => symbol.tabIndex);
  const key = (index: number, k: string) =>
    symbols()[index]?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  it("reflects the initial value, roving, fill range, and field", async () => {
    await start();
    expect(checked()).toEqual(["false", "true", "false"]);
    expect(tabindexes()).toEqual([-1, 0, -1]);
    expect(fill()).toEqual([true, true, false]);
    expect(field().value).toBe("2");
  });

  it("selects a symbol on click", async () => {
    await start();
    symbols()[2]?.click();
    expect(checked()).toEqual(["false", "false", "true"]);
    expect(tabindexes()).toEqual([-1, -1, 0]);
    expect(fill()).toEqual([true, true, true]);
    expect(field().value).toBe("3");
  });

  it("clears to 0 when clicking the selected symbol (clearable)", async () => {
    await start();
    symbols()[1]?.click(); // currently selected value is 2
    expect(checked()).toEqual(["false", "false", "false"]);
    expect(fill()).toEqual([false, false, false]);
    expect(field().value).toBe("0");
    // Focus returns to the first symbol, which becomes the Tab entry point.
    expect(tabindexes()).toEqual([0, -1, -1]);
    expect(document.activeElement).toBe(symbols()[0]);
  });

  it("increments/decrements with arrows and clamps at the bounds", async () => {
    await start();
    key(1, "ArrowRight");
    expect(field().value).toBe("3");
    key(2, "ArrowRight"); // clamp at max
    expect(field().value).toBe("3");

    key(2, "ArrowLeft");
    expect(field().value).toBe("2");
  });

  it("selects the focused symbol on Space / Enter (from unrated)", async () => {
    // Clear to 0 first so the first symbol becomes the focused roving tab stop and the
    // selection is observable. keydown is dispatched only on that focused symbol — as it
    // would be in real use, since non-tab-stop symbols are tabindex=-1 and never receive it.
    await start(); // value 2
    symbols()[1]?.click(); // clicking the selected symbol clears to 0
    expect(field().value).toBe("0");
    expect(tabindexes()).toEqual([0, -1, -1]);

    key(0, " "); // Space selects the focused (first) symbol
    expect(field().value).toBe("1");
    expect(checked()).toEqual(["true", "false", "false"]);

    symbols()[0]?.click(); // re-clear to 0 (symbol[0] is the selected one)
    expect(field().value).toBe("0");
    key(0, "Enter"); // Enter selects the focused symbol
    expect(field().value).toBe("1");
    expect(checked()).toEqual(["true", "false", "false"]);
  });

  it("can reach 0 with ArrowLeft and Home when clearable", async () => {
    await start();
    key(1, "ArrowLeft"); // 2 -> 1
    key(0, "ArrowLeft"); // 1 -> 0
    expect(field().value).toBe("0");

    key(0, "End");
    expect(field().value).toBe("3");
    key(2, "Home");
    expect(field().value).toBe("0");
  });

  it("previews a fill range on hover without changing the value", async () => {
    await start();
    symbols()[2]?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(fill()).toEqual([true, true, true]);
    expect(checked()).toEqual(["false", "true", "false"]); // value unchanged
    expect(field().value).toBe("2");

    symbols()[2]?.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    expect(fill()).toEqual([true, true, false]); // restored to selected value
  });

  it("dispatches change with the numeric value", async () => {
    await start();
    const values: number[] = [];
    root().addEventListener("stimeo--rating:change", (event) => {
      values.push((event as CustomEvent<{ value: number }>).detail.value);
    });
    symbols()[2]?.click();
    symbols()[0]?.click();
    expect(values).toEqual([3, 1]);
  });

  it("does not dispatch change on connect (initial reflection only)", async () => {
    // The event bubbles to document, so listen before connect runs.
    const values: number[] = [];
    const handler = (event: Event) =>
      values.push((event as CustomEvent<{ value: number }>).detail.value);
    document.addEventListener("stimeo--rating:change", handler);
    await start();
    document.removeEventListener("stimeo--rating:change", handler);
    expect(values).toEqual([]); // no init event for subscribers of form initial values
    expect(field().value).toBe("2"); // but the initial value is still reflected
    expect(checked()).toEqual(["false", "true", "false"]);
  });

  it("does not go below 1 when not clearable", async () => {
    await start('data-stimeo--rating-clearable-value="false"');
    key(1, "ArrowLeft"); // 2 -> 1
    key(0, "ArrowLeft"); // clamps at 1
    expect(field().value).toBe("1");
    key(0, "Home");
    expect(field().value).toBe("1");
  });

  it("renders a non-interactive image in readonly mode", async () => {
    await start('data-stimeo--rating-readonly-value="true"');
    expect(root().getAttribute("role")).toBe("img");
    expect(symbols().every((symbol) => symbol.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(tabindexes()).toEqual([-1, -1, -1]);
    expect(fill()).toEqual([true, true, false]);

    // Interactions are inert.
    symbols()[2]?.click();
    expect(field().value).toBe("2");
  });

  it("announces role, name, and state in order", async () => {
    await start();
    const before = await captureSpeech({ container: root(), steps: 4 });
    expect(before).toEqual([
      "radiogroup, Rating",
      "radio, 1 star, not checked, position 1, set size 3",
      "radio, 2 stars, checked, position 2, set size 3",
      "radio, 3 stars, not checked, position 3, set size 3",
      "end of radiogroup, Rating",
    ]);
  });

  it("has no machine-detectable a11y violations (interactive and readonly)", async () => {
    await start();
    await expectNoA11yViolations(root());
    application.stop();
    await start('data-stimeo--rating-readonly-value="true"');
    await expectNoA11yViolations(root());
  });
});

/**
 * Defensive clamping: when the consumer's `max` value (or an initial value)
 * exceeds the rendered symbol count, the value is capped at the symbol count so
 * the roving Tab stop (`value - 1`) always maps to a real symbol and is never lost.
 */
describe("RatingController with max above the symbol count", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--rating" role="radiogroup" aria-label="Rating"
           data-stimeo--rating-value-value="5" data-stimeo--rating-max-value="5">
        <span role="radio" aria-checked="false" aria-label="1 star" tabindex="-1"
              data-rating-value="1" data-stimeo--rating-target="symbol"
              data-action="click->stimeo--rating#select keydown->stimeo--rating#onKeydown"></span>
        <span role="radio" aria-checked="false" aria-label="2 stars" tabindex="-1"
              data-rating-value="2" data-stimeo--rating-target="symbol"
              data-action="click->stimeo--rating#select keydown->stimeo--rating#onKeydown"></span>
        <span role="radio" aria-checked="false" aria-label="3 stars" tabindex="-1"
              data-rating-value="3" data-stimeo--rating-target="symbol"
              data-action="click->stimeo--rating#select keydown->stimeo--rating#onKeydown"></span>
      </div>`;
    application = Application.start();
    application.register("stimeo--rating", RatingController);
    await tick();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  it("caps the value at the symbol count and keeps a valid Tab stop", () => {
    const symbols = Array.from(
      document.querySelectorAll<HTMLElement>("[data-stimeo--rating-target='symbol']"),
    );
    // value 5 requested, only 3 symbols → clamps to 3: the last symbol is the
    // checked, tabbable one (exactly one tabindex=0).
    expect(symbols.map((symbol) => symbol.tabIndex)).toEqual([-1, -1, 0]);
    expect(symbols.map((symbol) => symbol.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "true",
    ]);
  });
});
