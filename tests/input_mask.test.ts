import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { applyMask, InputMaskController } from "../src/controllers/input_mask_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link InputMaskController} and the pure {@link applyMask}:
 * sequential formatting, character rejection, the complete/empty flags, raw-value
 * sync to the hidden field (incl. nearest-container, by-id and `form`-attribute
 * pairing for several masks in one form), the caret under insertion, rejection and
 * deletion, custom and malformed token declarations, the change/reconcile events,
 * runtime Value changes, non-editable fields, and teardown.
 */

/** Builds a token map like the controller compiles internally. */
const tokenMap = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([k, v]) => [k, new RegExp(`^(?:${v})$`)]));

const NUMERIC = tokenMap({ "9": "\\d", a: "[A-Za-z]", "*": "[A-Za-z0-9]" });

interface ChangeDetail {
  masked: string;
  unmasked: string;
  complete: boolean;
}

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

  it("leaves a token slot empty when only rejected characters remain", () => {
    // The trailing "x" is skipped and the input runs out mid-slot: the slot has to
    // stay unfilled rather than absorb the exhausted read.
    const result = applyMask("12x", "999", NUMERIC);
    expect(result.masked).toBe("12");
    expect(result.unmasked).toBe("12");
    expect(result.complete).toBe(false);
  });

  it("consumes a literal the value already carries", () => {
    // "1" is a literal here, so the value's own "1" fills it instead of the first
    // token slot — the digits after it must not shift left by one.
    const result = applyMask("12", "+81-99", NUMERIC);
    expect(result.masked).toBe("+81-2");
    expect(result.unmasked).toBe("2");
  });

  it("truncates input past the pattern's capacity", () => {
    expect(applyMask("123456789", "999-9999", NUMERIC).masked).toBe("123-4567");
  });

  it("reads full-width characters as the half-width form the token asked for", () => {
    // What an IME confirms in full-width mode is the digits the field wanted,
    // so the mask takes them — and the output carries the ASCII form.
    const result = applyMask("１２３４５６７", "999-9999", NUMERIC);
    expect(result.masked).toBe("123-4567");
    expect(result.unmasked).toBe("1234567");
    expect(applyMask("ＡＢｃ", "aaa", NUMERIC).masked).toBe("ABc");
  });

  it("keeps a character a token accepts as typed", () => {
    // A token written for full-width text stays authoritative: the character is
    // tried as typed before its half-width form is considered.
    const wide = tokenMap({ "9": "[０-９]" });
    expect(applyMask("１２３", "9-99", wide).masked).toBe("１-２３");
    // A character neither form satisfies is still rejected.
    expect(applyMask("あ1い2", "99", NUMERIC).masked).toBe("12");
  });

  it("consumes a literal typed in either width", () => {
    // "+81-" is all literals here, and two of them ("8", "1") a digit token
    // would also accept — so a full-width prefix must not shift into the slots.
    expect(applyMask("＋８１－１２", "+81-99", NUMERIC).masked).toBe("+81-12");
    expect(applyMask("+81-12", "+81-99", NUMERIC).masked).toBe("+81-12");
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
    if (application) disconnectAndStopApplication(application);
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

  /** Simulates the platform having left `value` and `caret` behind for `inputType`. */
  const edit = (value: string, caret: number, inputType: string) => {
    const field = input();
    field.value = value;
    field.setSelectionRange(caret, caret);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
  };

  /** Collects every mask event on the document, in dispatch order. */
  const record = () => {
    const log: Array<{ event: string; detail: ChangeDetail }> = [];
    for (const event of ["change", "reconcile"]) {
      document.addEventListener(`stimeo--input-mask:${event}`, (e) => {
        log.push({ event, detail: (e as CustomEvent<ChangeDetail>).detail });
      });
    }
    return log;
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

  it("leaves the sink alone when the raw value is not synced", async () => {
    await start(`
      <input id="i" type="text" data-controller="stimeo--input-mask"
             data-stimeo--input-mask-pattern-value="999-9999"
             data-stimeo--input-mask-unmask-to-hidden-value="false"
             data-action="input->stimeo--input-mask#format">
      <input id="hidden" type="hidden" data-stimeo--input-mask-unmask>`);
    type("1234567");
    expect(input().value).toBe("123-4567");
    expect(hidden().value).toBe("");
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

  it("never claims a sink outside the form the input belongs to", async () => {
    // The input is associated by the `form` attribute, so the form is not one of
    // its ancestors: walking up must not reach the stray sink next to it.
    await start(`
      <form id="f1"></form>
      <div>
        <input id="i" type="text" form="f1" data-controller="stimeo--input-mask"
               data-stimeo--input-mask-pattern-value="999-9999"
               data-action="input->stimeo--input-mask#format">
        <input id="stray" type="hidden" data-stimeo--input-mask-unmask>
      </div>`);
    expect(input().form?.id).toBe("f1");
    type("1234567");

    expect(input().value).toBe("123-4567");
    expect(query<HTMLInputElement>("#stray").value).toBe("");
  });

  it("claims a sink its own form owns through the form attribute", async () => {
    await start(`
      <form id="f1"></form>
      <div>
        <input id="i" type="text" form="f1" data-controller="stimeo--input-mask"
               data-stimeo--input-mask-pattern-value="999-9999"
               data-action="input->stimeo--input-mask#format">
        <input id="hidden" type="hidden" form="f1" data-stimeo--input-mask-unmask>
      </div>`);
    type("1234567");

    expect(hidden().value).toBe("1234567");
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

  it("keeps the value and the caret still when a rejected character is typed mid-string", async () => {
    await start(ZIP);
    type("1234567");
    const log = record();

    // Three rejected keystrokes right after the separator: the caret anchors on
    // the token slots the prefix fills, so it can never drift right.
    for (const rejected of ["x", "y", "z"]) {
      edit(`123-${rejected}4567`, 5, "insertText");
      expect(input().value).toBe("123-4567");
      expect(input().selectionStart).toBe(4);
    }
    expect(log).toEqual([]);
  });

  it("keeps the caret after the inserted digit when a literal also matches a token", async () => {
    await start(`
      <input id="i" type="text" value="03-1234" data-controller="stimeo--input-mask"
             data-stimeo--input-mask-pattern-value="03-9999"
             data-action="input->stimeo--input-mask#format">`);
    // The pattern's own "0" and "3" are literals that the digit token would also
    // accept; counting them as filled slots would push the caret past "23".
    edit("03-19234", 5, "insertText");

    expect(input().value).toBe("03-1923");
    expect(input().selectionStart).toBe(5);
  });

  it("deletes through a separator instead of standing still", async () => {
    await start(ZIP);
    type("1234567");
    // Backspace right after the separator removes only the separator, which the
    // mask re-inserts: the digit before it goes instead, so deletion progresses.
    edit("1234567", 3, "deleteContentBackward");

    expect(input().value).toBe("124-567");
    expect(input().selectionStart).toBe(2);
    expect(hidden().value).toBe("124567");
  });

  it("deletes forward through a separator instead of standing still", async () => {
    await start(ZIP);
    type("1234567");
    edit("1234567", 3, "deleteContentForward");

    expect(input().value).toBe("123-567");
    expect(input().selectionStart).toBe(4);
  });

  it("deletes a significant character without reaching past it", async () => {
    await start(ZIP);
    type("1234567");
    // A deletion that already removed a digit is not a fixed point, so the mask
    // must not take a second character with it.
    edit("123-456", 7, "deleteContentBackward");

    expect(input().value).toBe("123-456");
    expect(input().selectionStart).toBe(7);
  });

  it("dispatches change with masked, unmasked, and complete", async () => {
    await start(ZIP);
    const log: ChangeDetail[] = [];
    input().addEventListener("stimeo--input-mask:change", (e) => {
      log.push((e as CustomEvent<ChangeDetail>).detail);
    });
    type("1234567");
    expect(log).toEqual([{ masked: "123-4567", unmasked: "1234567", complete: true }]);
  });

  it("dispatches change once per keystroke that moves the value", async () => {
    await start(ZIP);
    const log = record();

    for (const typed of ["1", "12", "123", "1234", "12345", "123456", "1234567"]) type(typed);

    expect(log.map((entry) => entry.event)).toEqual(Array(7).fill("change"));
    expect(log.map((entry) => entry.detail.unmasked)).toEqual([
      "1",
      "12",
      "123",
      "1234",
      "12345",
      "123456",
      "1234567",
    ]);
    // Formatting that changes nothing on a keystroke must not hide the move: the
    // completed value is reported exactly once, on the keystroke that filled it.
    expect(log.filter((entry) => entry.detail.complete)).toHaveLength(1);
  });

  it("stays silent on a keystroke that cannot move the value", async () => {
    await start(ZIP);
    type("1234567");
    const log = record();

    // Past the pattern's capacity and rejected characters both leave the
    // committed value exactly as it was.
    type("12345679");
    type("1234567a");
    type("1234567");

    expect(log).toEqual([]);
    expect(input().value).toBe("123-4567");
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

  it("applies the default letter and alphanumeric tokens with no declaration", async () => {
    await start(`
      <input id="i" type="text" data-controller="stimeo--input-mask"
             data-stimeo--input-mask-pattern-value="aaa-***"
             data-action="input->stimeo--input-mask#format">`);
    type("ab1cd2");
    // "a" takes letters only (the "1" is rejected), "*" takes letters or digits.
    expect(input().value).toBe("abc-d2");
  });

  it("falls back to the default tokens when the declaration is not readable", async () => {
    await start(`
      <input id="i" type="text" data-controller="stimeo--input-mask"
             data-stimeo--input-mask-pattern-value="999-9999"
             data-stimeo--input-mask-tokens-value="{broken"
             data-action="input->stimeo--input-mask#format">
      <input id="hidden" type="hidden" data-stimeo--input-mask-unmask>`);
    expect(() => type("12ab34567")).not.toThrow();

    expect(input().value).toBe("123-4567");
    expect(hidden().value).toBe("1234567");
    expect(input().getAttribute("data-mask-complete")).toBe("true");
  });

  it("falls back to the default tokens when the declaration is not a token map", async () => {
    await start(`
      <input id="i" type="text" data-controller="stimeo--input-mask"
             data-stimeo--input-mask-pattern-value="999-9999"
             data-stimeo--input-mask-tokens-value="null"
             data-action="input->stimeo--input-mask#format">`);
    // Readable JSON that is not a map of sources is no more usable than broken
    // JSON, and must not reach the merge.
    expect(() => type("1234567")).not.toThrow();

    expect(input().value).toBe("123-4567");
  });

  it("skips a token whose regex cannot compile", async () => {
    await start(`
      <input id="i" type="text" data-controller="stimeo--input-mask"
             data-stimeo--input-mask-pattern-value="HH:HH"
             data-stimeo--input-mask-tokens-value='{"H":"["}'
             data-action="input->stimeo--input-mask#format">`);
    // Only that token is lost: "H" degrades to a literal instead of the whole
    // mask (and the field) breaking.
    expect(() => type("1234")).not.toThrow();
    expect(input().value).toBe("HH:HH");
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

  it("re-formats a server-rendered value on connect and reports it as reconciled", async () => {
    const log = record();
    await start(`
      <input id="i" type="text" value="1234567" data-controller="stimeo--input-mask"
             data-stimeo--input-mask-pattern-value="999-9999"
             data-action="input->stimeo--input-mask#format">
      <input id="hidden" type="hidden" data-stimeo--input-mask-unmask>`);

    expect(input().value).toBe("123-4567");
    expect(hidden().value).toBe("1234567");
    // The user confirmed nothing, so the normalization is a reconcile, not a change.
    expect(log).toEqual([
      { event: "reconcile", detail: { masked: "123-4567", unmasked: "1234567", complete: true } },
    ]);
  });

  it("stays silent and stable when connecting to an already-masked value", async () => {
    const log = record();
    await start(`
      <input id="i" type="text" value="123-4567" data-controller="stimeo--input-mask"
             data-stimeo--input-mask-pattern-value="999-9999"
             data-action="input->stimeo--input-mask#format">`);
    expect(input().value).toBe("123-4567");

    // Reconnecting (a Turbo restore, a morph that re-adds the controller) has to
    // land on the same value and stay silent again.
    input().removeAttribute("data-controller");
    await tick();
    input().setAttribute("data-controller", "stimeo--input-mask");
    await tick();

    expect(input().value).toBe("123-4567");
    expect(log).toEqual([]);
  });

  it("keeps the uncommitted IME text until the composition ends", async () => {
    await start(ZIP);
    const field = input();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "１２３４５６７";
    field.setSelectionRange(7, 7);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));

    // Mid-composition the buffer belongs to the IME: rewriting it here would
    // discard the conversion in progress.
    expect(field.value).toBe("１２３４５６７");

    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    // The confirmation is formatted once, reading the full-width digits as the
    // ASCII ones the pattern asked for.
    expect(field.value).toBe("123-4567");
    expect(hidden().value).toBe("1234567");
  });

  it("rejects confirmed text no width of the token accepts", async () => {
    await start(ZIP);
    const field = input();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "あいう";
    field.setSelectionRange(3, 3);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));

    // Kana has no half-width form the digit token would take, so it is dropped
    // silently like any other disallowed character.
    expect(field.value).toBe("");
  });

  it("formats the confirmed IME text exactly once", async () => {
    await start(ZIP);
    const log = record();
    const field = input();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "1234567";
    field.setSelectionRange(7, 7);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    // Platforms also fire a trailing `input` for the confirmation itself.
    field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: false }));

    expect(field.value).toBe("123-4567");
    expect(log).toEqual([
      { event: "change", detail: { masked: "123-4567", unmasked: "1234567", complete: true } },
    ]);
  });

  it("re-formats and reconciles when the pattern changes at runtime", async () => {
    await start(ZIP);
    type("1234567");
    const log = record();

    input().setAttribute("data-stimeo--input-mask-pattern-value", "999-99-99");
    await tick();

    expect(input().value).toBe("123-45-67");
    expect(hidden().value).toBe("1234567");
    expect(log).toEqual([
      { event: "reconcile", detail: { masked: "123-45-67", unmasked: "1234567", complete: true } },
    ]);
  });

  it("clears the state hooks when the pattern is removed at runtime", async () => {
    await start(ZIP);
    type("1234567");
    expect(input().getAttribute("data-mask-complete")).toBe("true");

    input().removeAttribute("data-stimeo--input-mask-pattern-value");
    await tick();

    // Without a pattern nothing can be complete, and the field keeps its text.
    expect(input().hasAttribute("data-mask-complete")).toBe(false);
    expect(input().value).toBe("123-4567");
  });

  it("re-formats when the token declaration changes at runtime", async () => {
    await start(`
      <input id="i" type="text" value="1a2" data-controller="stimeo--input-mask"
             data-stimeo--input-mask-pattern-value="***"
             data-action="input->stimeo--input-mask#format">`);
    expect(input().value).toBe("1a2");

    input().setAttribute("data-stimeo--input-mask-tokens-value", '{"*":"\\\\d"}');
    await tick();

    // The letter no longer matches the narrowed token, so it is rejected.
    expect(input().value).toBe("12");
  });

  it("clears the sink it stops maintaining", async () => {
    await start(ZIP);
    type("1234567");
    expect(hidden().value).toBe("1234567");

    input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    await tick();

    // A stale raw value in a hidden field would still be submitted.
    expect(hidden().value).toBe("");
    type("7654321");
    expect(hidden().value).toBe("");
  });

  it("leaves a read-only field's value to the page", async () => {
    await start(`
      <input id="i" type="text" value="1234567" readonly
             data-controller="stimeo--input-mask"
             data-stimeo--input-mask-pattern-value="999-9999"
             data-action="input->stimeo--input-mask#format">
      <input id="hidden" type="hidden" data-stimeo--input-mask-unmask>`);

    expect(input().value).toBe("1234567");
    // The derived outputs still follow the field the page authored.
    expect(hidden().value).toBe("1234567");
    expect(input().getAttribute("data-mask-complete")).toBe("true");
  });

  it("leaves a disabled field's value to the page", async () => {
    await start(`
      <input id="i" type="text" value="1234567" disabled
             data-controller="stimeo--input-mask"
             data-stimeo--input-mask-pattern-value="999-9999"
             data-action="input->stimeo--input-mask#format">`);

    expect(input().value).toBe("1234567");
  });

  it("leaves a field disabled by an ancestor fieldset to the page", async () => {
    await start(`
      <form>
        <fieldset disabled>
          <input id="i" type="text" value="1234567"
                 data-controller="stimeo--input-mask"
                 data-stimeo--input-mask-pattern-value="999-9999"
                 data-action="input->stimeo--input-mask#format">
        </fieldset>
      </form>`);

    // The disabled attribute sits on the fieldset, so the input's own property
    // reads false while HTML still counts it as disabled.
    expect(input().disabled).toBe(false);
    expect(input().value).toBe("1234567");
  });

  it("formats the value even when the caret cannot be placed", async () => {
    await start(ZIP);
    const field = input();
    // Some hosts refuse selection for the input's type; the value is already
    // correct by then, so a refused caret restore must not escape.
    Object.defineProperty(field, "setSelectionRange", {
      configurable: true,
      value: () => {
        throw new DOMException("unsupported", "InvalidStateError");
      },
    });

    expect(() => field.dispatchEvent(new Event("input", { bubbles: true }))).not.toThrow();
    expect(field.value).toBe("");

    field.value = "1234567";
    expect(() => field.dispatchEvent(new Event("input", { bubbles: true }))).not.toThrow();
    expect(field.value).toBe("123-4567");
  });

  it("stops formatting once the controller is unloaded", async () => {
    await start(ZIP);
    application.unload("stimeo--input-mask");
    await tick();

    type("1234567");

    expect(input().value).toBe("1234567");
    expect(hidden().value).toBe("");
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
