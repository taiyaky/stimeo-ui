import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMask, InputMaskController } from "../src/controllers/input_mask_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { dispatchFormData } from "./helpers/form_data";
import { composeDraft } from "./helpers/ime";
import { captureSpeech } from "./helpers/speech";
import {
  disconnectAndStopApplication,
  reconnectKeepingFocus,
  restoreFromCache,
} from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

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

  it("keeps a default token when the declaration overrides it with a broken source", async () => {
    await start(`
      <input id="i" type="text" data-controller="stimeo--input-mask"
             data-stimeo--input-mask-pattern-value="999-9999"
             data-stimeo--input-mask-tokens-value='{"9":"[0-9"}'
             data-action="input->stimeo--input-mask#format">
      <input id="hidden" type="hidden" data-stimeo--input-mask-unmask>`);
    // The override declares nothing usable, so "9" keeps the token it had. The
    // alternative — dropping the key with its default — turns every "9" in the
    // pattern into a literal and leaves a field no digit can fill.
    type("1234567");

    expect(input().value).toBe("123-4567");
    expect(hidden().value).toBe("1234567");
  });

  it("keeps the other default tokens when one of them is overridden with a broken source", async () => {
    await start(`
      <input id="i" type="text" data-controller="stimeo--input-mask"
             data-stimeo--input-mask-pattern-value="aa-99"
             data-stimeo--input-mask-tokens-value='{"a":"[A-Z"}'
             data-action="input->stimeo--input-mask#format">`);
    // "a" falls back to its default (letters), and "9" was never declared.
    type("ab12");

    expect(input().value).toBe("ab-12");
  });

  it("applies a declared override that does compile over the default", async () => {
    await start(`
      <input id="i" type="text" data-controller="stimeo--input-mask"
             data-stimeo--input-mask-pattern-value="99"
             data-stimeo--input-mask-tokens-value='{"9":"[0-4]"}'
             data-action="input->stimeo--input-mask#format">`);
    // The narrower source replaces the default outright rather than widening it.
    type("1590");

    expect(input().value).toBe("10");
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

  it("keeps data-mask-empty in step with a field that has no pattern", async () => {
    await start(`
      <input id="i" type="text" data-controller="stimeo--input-mask"
             data-action="input->stimeo--input-mask#format">`);
    expect(input().getAttribute("data-mask-empty")).toBe("true");

    type("abc");
    expect(input().hasAttribute("data-mask-empty")).toBe(false);

    type("");
    expect(input().getAttribute("data-mask-empty")).toBe("true");
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

  it("honors an input event's composition flag without a preceding compositionstart", async () => {
    await start(ZIP);
    const log = record();
    const field = input();
    field.value = "１２３４５６７";
    field.setSelectionRange(3, 3);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    expect(field.value).toBe("１２３４５６７");
    expect(field.selectionStart).toBe(3);
    expect(hidden().value).toBe("");
    expect(log).toEqual([]);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: false }));
    expect(field.value).toBe("123-4567");
    expect(hidden().value).toBe("1234567");
    expect(log).toHaveLength(1);
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

  const controller = () =>
    application.getControllerForElementAndIdentifier(
      input(),
      "stimeo--input-mask",
    ) as InputMaskController;

  it("holds a pattern change while the field is composing, then formats the commit under it", async () => {
    await start(ZIP);
    const log = record();
    const field = input();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "12３";
    field.setSelectionRange(3, 3);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    field.setAttribute("data-stimeo--input-mask-pattern-value", "99/99");
    controller().patternValueChanged();

    // The page's re-format would discard the conversion in progress.
    expect(field.value).toBe("12３");
    expect(log).toEqual([]);

    field.value = "１２３４";
    field.setSelectionRange(4, 4);
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await tick();

    // The user committed text, so the one format that follows is their edit.
    expect(field.value).toBe("12/34");
    expect(log).toEqual([
      { event: "change", detail: { masked: "12/34", unmasked: "1234", complete: true } },
    ]);
  });

  it("formats under a pattern change the composition held once a script ends it without compositionend", async () => {
    await start(ZIP);
    const log = record();
    const field = input();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "12３";
    field.setSelectionRange(3, 3);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    field.setAttribute("data-stimeo--input-mask-pattern-value", "99/99");
    controller().patternValueChanged();
    // Stimulus delivers its own callback too; both land mid-composition.
    await tick();
    expect(field.value).toBe("12３");

    // A script writes the field, and the engine drops the conversion without compositionend.
    field.value = "1234";
    field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: "5",
      }),
    );
    await tick();

    // The page wrote the text, so the format it gets is a reconciliation.
    expect(field.value).toBe("12/34");
    expect(log.map((entry) => entry.event)).toEqual(["reconcile"]);
  });

  it.each([
    ["as an edit, with nothing held", false, "123-4567", ["change"]],
    [
      "after the pattern change the composition held, as reconciled",
      true,
      "123-45-67",
      ["reconcile"],
    ],
  ])(
    "formats a write that ended the composition, with the input a script sends after it, %s",
    async (_name, held, shown, events) => {
      await start(ZIP);
      const log = record();
      const field = input();
      field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      field.value = "１２";
      field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
      if (held) {
        field.setAttribute("data-stimeo--input-mask-pattern-value", "999-99-99");
        controller().patternValueChanged();
        await tick();
      }

      // A script writes the field and tells listeners; the engine drops the conversion.
      type("1234567");

      expect(field.value).toBe(shown);
      expect(log.map((entry) => entry.event)).toEqual(events);
    },
  );

  it("holds nothing for a composition after one whose commit took the re-format it held", async () => {
    await start(ZIP);
    const field = input();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "１２";
    field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    field.setAttribute("data-stimeo--input-mask-pattern-value", "999-99-99");
    controller().patternValueChanged();
    await tick();
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    const log = record();

    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "12-３";
    field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    // A script writes the field and tells listeners; the engine drops the conversion.
    type("1234567");

    expect(field.value).toBe("123-45-67");
    expect(log.map((entry) => entry.event)).toEqual(["change"]);
  });

  it.each([
    ["a cancelled conversion", "123", "123", []],
    ["a confirmation the mask rejects a character of", "123あ", "123-", ["change"]],
  ])(
    "reports %s after the field moved keeping focus as with no move",
    async (_name, confirmed, shown, events) => {
      await start(ZIP);
      type("123");
      const log = record();
      const field = input();
      field.focus();
      field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      field.value = "123４";
      field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));

      // moveBefore keeps focus and the conversion; the controller reconnects around it.
      const instance = controller();
      instance.disconnect();
      instance.connect();
      await tick();
      expect(field.value).toBe("123４");

      field.value = confirmed;
      field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      await tick();

      expect(field.value).toBe(shown);
      expect(log.map((entry) => entry.event)).toEqual(events);
    },
  );

  it.each([
    ["pattern", "data-stimeo--input-mask-pattern-value", "99-99"],
    ["tokens", "data-stimeo--input-mask-tokens-value", '{"9":"[0-4]"}'],
    ["unmaskToHidden", "data-stimeo--input-mask-unmask-to-hidden-value", "false"],
  ])(
    "holds a re-format for a %s that changed with a move keeping focus, as it does with no move",
    async (_name, attribute, value) => {
      await start(ZIP);
      type("123");
      const log = record();
      const field = input();
      field.focus();
      field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      field.value = "123４";
      field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));

      // The morph that moves the field also changes its mask.
      reconnectKeepingFocus(controller(), () => field.setAttribute(attribute, value));
      await tick();
      expect(field.value).toBe("123４");

      // A script writes the field and tells listeners, which ends the conversion.
      type("1234");

      expect(log.map((entry) => entry.event)).toEqual(["reconcile"]);
    },
  );

  it("holds nothing for a pattern changed and changed back mid-composition", async () => {
    await start(ZIP);
    type("123");
    const log = record();
    const field = input();
    field.focus();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "123４";
    field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    field.setAttribute("data-stimeo--input-mask-pattern-value", "99-99");
    await tick();
    field.setAttribute("data-stimeo--input-mask-pattern-value", "999-9999");
    await tick();

    type("1234");

    expect(log.map((entry) => entry.event)).toEqual(["change"]);
  });

  it("restores the authored nonempty snapshot after readonly is released before composition", async () => {
    await start(ZIP.replace('id="i"', 'id="i" value="xyz" readonly'));
    expect(input().value).toBe("xyz");
    expect(hidden().value).toBe("");
    expect(input().hasAttribute("data-mask-empty")).toBe(false);
    input().readOnly = false;
    input().focus();
    input().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(input(), "xyz５");
    input().setSelectionRange(1, 2, "backward");
    const events: string[] = [];
    for (const type of [
      "stimeo--input-mask:change",
      "stimeo--input-mask:reconcile",
      "input",
      "change",
    ]) {
      input().addEventListener(type, () => events.push(type));
    }
    input().setAttribute("data-mask-empty", "true");
    input().setAttribute("data-mask-complete", "true");
    hidden().value = "page";
    input().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    await tick();

    expect(input().hasAttribute("data-mask-empty")).toBe(false);
    expect(input().hasAttribute("data-mask-complete")).toBe(false);
    expect(hidden().value).toBe("");
    expect(input().value).toBe("xyz５");
    expect([input().selectionStart, input().selectionEnd, input().selectionDirection]).toEqual([
      1,
      2,
      "backward",
    ]);
    expect(events).toEqual([]);
  });

  for (const pass of ["morph", "reconnect"] as const) {
    it.each([
      ["1234567", "123-4567", true],
      ["12", "12", false],
      ["", "", false],
    ] as const)(
      `restores committed derived output for %s in the declarations in force while a composing ${pass} holds a change`,
      async (raw, formatted, complete) => {
        await start(ZIP);
        type(raw);
        input().focus();
        const events = record();
        input().dispatchEvent(new Event("compositionstart", { bubbles: true }));
        composeDraft(input(), `${formatted}５`);
        input().setSelectionRange(1, 1);
        input().setAttribute("data-stimeo--input-mask-pattern-value", "99-99");
        controller().patternValueChanged();
        hidden().value = "";
        input().toggleAttribute("data-mask-complete", !complete);
        input().toggleAttribute("data-mask-empty", raw !== "");

        if (pass === "morph") {
          input().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
        } else reconnectKeepingFocus(controller());
        await tick();

        expect(hidden().value).toBe(raw);
        expect(input().hasAttribute("data-mask-complete")).toBe(complete);
        expect(input().hasAttribute("data-mask-empty")).toBe(raw === "");
        expect(input().value).toBe(`${formatted}５`);
        expect([input().selectionStart, input().selectionEnd]).toEqual([1, 1]);
        expect(events).toEqual([]);

        input().value = "1234";
        input().dispatchEvent(new Event("compositionend", { bubbles: true }));
        expect(hidden().value).toBe("1234");
        expect(input().value).toBe("12-34");
        expect(events).toEqual([
          { event: "change", detail: { masked: "12-34", unmasked: "1234", complete: true } },
        ]);
      },
    );
  }

  it("restores the hooks but keeps a withdrawn sink empty while a composing pass holds synchronization off", async () => {
    await start(ZIP);
    type("1234567");
    input().focus();
    input().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(input(), "123-4567５");
    input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    controller().unmaskToHiddenValueChanged();
    expect(hidden().value).toBe("");
    input().removeAttribute("data-mask-complete");
    input().setAttribute("data-mask-empty", "true");
    input().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    await tick();

    expect(hidden().value).toBe("");
    expect(input().hasAttribute("data-mask-complete")).toBe(true);
    expect(input().hasAttribute("data-mask-empty")).toBe(false);
    expect(input().value).toBe("123-4567５");
    input().value = "5";
    input().dispatchEvent(new Event("compositionend", { bubbles: true }));
    expect(hidden().value).toBe("");
    expect(input().value).toBe("5");
  });

  it("does not reclaim a sink another mask wrote while a composing pass holds a change", async () => {
    await start(`<div>${ZIP}${maskField("other")}</div>`);
    type("1234567");
    input().focus();
    input().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(input(), "123-4567５");
    fill("#other", "7654321");
    input().setAttribute("data-stimeo--input-mask-pattern-value", "99-99");
    controller().patternValueChanged();
    input().removeAttribute("data-mask-complete");
    input().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    await tick();

    expect(hidden().value).toBe("7654321");
    expect(input().hasAttribute("data-mask-complete")).toBe(true);
    expect(input().value).toBe("123-4567５");
  });

  it("writes a sink withdrawn and resumed mid-composition once a script ends the composition without compositionend", async () => {
    await start(ZIP);
    type("1234567");
    const log = record();
    const field = input();
    field.focus();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(field, "123-4567５");
    field.setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    controller().unmaskToHiddenValueChanged();
    field.setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "true");
    controller().unmaskToHiddenValueChanged();
    await tick();
    expect(hidden().value).toBe("");

    // A script writes the field, and the engine drops the conversion without compositionend.
    field.value = "7654321";
    field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: "9",
      }),
    );
    await tick();

    expect(field.value).toBe("765-4321");
    expect(hidden().value).toBe("7654321");
    expect(log).toEqual([
      { event: "reconcile", detail: { masked: "765-4321", unmasked: "7654321", complete: true } },
    ]);
  });

  it("writes a sink a composing reconnect withdrew once a script ends the composition without compositionend", async () => {
    await start(ZIP);
    type("1234567");
    const log = record();
    const field = input();
    field.focus();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(field, "123-4567５");
    reconnectKeepingFocus(controller(), () =>
      field.setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false"),
    );
    await tick();
    expect(hidden().value).toBe("");
    field.setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "true");
    controller().unmaskToHiddenValueChanged();
    await tick();
    expect(hidden().value).toBe("");

    // A script writes the field, and the engine drops the conversion without compositionend.
    field.value = "7654321";
    field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: "9",
      }),
    );
    await tick();

    expect(field.value).toBe("765-4321");
    expect(hidden().value).toBe("7654321");
    expect(log).toEqual([
      { event: "reconcile", detail: { masked: "765-4321", unmasked: "7654321", complete: true } },
    ]);
  });

  it("owes no format after a mid-composition synchronization toggle that withdrew no sink", async () => {
    await start(`
      <input id="i" type="text" data-controller="stimeo--input-mask"
             data-stimeo--input-mask-pattern-value="999-9999"
             data-action="input->stimeo--input-mask#format">`);
    type("1234567");
    const log = record();
    const field = input();
    field.focus();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(field, "123-4567５");
    field.setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    controller().unmaskToHiddenValueChanged();
    field.setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "true");
    controller().unmaskToHiddenValueChanged();
    await tick();

    // A script writes the field, and the engine drops the conversion without compositionend.
    field.value = "7654321";
    field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: "9",
      }),
    );
    await tick();

    expect(field.value).toBe("7654321");
    expect(log).toEqual([]);
  });

  it("keeps the raw value of the pattern in force while a composing pass holds the pattern's removal", async () => {
    await start(ZIP);
    type("1234567");
    const events = record();
    input().focus();
    input().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(input(), "123-4567５");
    input().setAttribute("data-stimeo--input-mask-pattern-value", "");
    controller().patternValueChanged();
    expect(hidden().value).toBe("1234567");
    hidden().value = "";
    input().removeAttribute("data-mask-complete");
    input().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    await tick();

    expect(hidden().value).toBe("1234567");
    expect(input().hasAttribute("data-mask-complete")).toBe(true);
    expect(input().value).toBe("123-4567５");
    expect(events).toEqual([]);

    // The removal applies at the commit: the field passes through and the sink is taken back.
    input().value = "1234567５";
    input().dispatchEvent(new Event("compositionend", { bubbles: true }));
    expect(input().value).toBe("1234567５");
    expect(hidden().value).toBe("");
    expect(input().hasAttribute("data-mask-complete")).toBe(false);
  });

  it("does not reclaim a sink another mask wrote while its own field composes", async () => {
    await start(`<div>${ZIP}${maskField("other")}</div>`);
    type("1234567");
    input().focus();
    input().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(input(), "123-4567５");
    fill("#other", "7654321");
    expect(hidden().value).toBe("7654321");
    input().removeAttribute("data-mask-complete");
    input().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    await tick();

    expect(hidden().value).toBe("7654321");
    expect(input().hasAttribute("data-mask-complete")).toBe(true);
    expect(input().value).toBe("123-4567５");
  });

  it("does not restore the previous or new sink after pairing changes during composition", async () => {
    await start(ZIP);
    type("1234567");
    input().focus();
    input().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(input(), "123-4567５");
    hidden().setAttribute("data-stimeo--input-mask-unmask", "other");
    hidden().value = "";
    document.body.insertAdjacentHTML(
      "beforeend",
      '<input id="new-sink" type="hidden" value="page" data-stimeo--input-mask-unmask="i">',
    );
    input().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    await tick();

    expect(hidden().value).toBe("");
    expect(query<HTMLInputElement>("#new-sink").value).toBe("page");
    input().value = "5";
    input().dispatchEvent(new Event("compositionend", { bubbles: true }));
    expect(hidden().value).toBe("");
    expect(query<HTMLInputElement>("#new-sink").value).toBe("5");
  });

  it("does not revive a retracted sink when synchronization changes away and back during composition", async () => {
    await start(ZIP);
    type("1234567");
    input().focus();
    input().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(input(), "123-4567５");
    const owner = controller();
    input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    owner.unmaskToHiddenValueChanged();
    expect(hidden().value).toBe("");
    input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "true");
    owner.unmaskToHiddenValueChanged();
    input().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    await tick();

    expect(hidden().value).toBe("");
    expect(input().value).toBe("123-4567５");
    input().value = "5";
    input().dispatchEvent(new Event("compositionend", { bubbles: true }));
    expect(hidden().value).toBe("5");
  });

  it.each(["", "123"])(
    "restores pass-through hooks for %s without reviving a patterned raw output",
    async (value) => {
      await start(ZIP);
      type("1234567");
      input().setAttribute("data-stimeo--input-mask-pattern-value", "");
      controller().patternValueChanged();
      type(value);
      expect(hidden().value).toBe("");
      input().focus();
      input().dispatchEvent(new Event("compositionstart", { bubbles: true }));
      composeDraft(input(), `${value}５`);
      input().setAttribute("data-mask-complete", "true");
      input().toggleAttribute("data-mask-empty", value !== "");
      input().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
      await tick();

      expect(input().hasAttribute("data-mask-complete")).toBe(false);
      expect(input().hasAttribute("data-mask-empty")).toBe(value === "");
      expect(hidden().value).toBe("");
      expect(input().value).toBe(`${value}５`);
    },
  );

  for (const pass of ["morph", "reconnect"] as const) {
    it.each([
      ["1234567", "123-4567", true],
      ["12", "12", false],
      ["", "", false],
    ] as const)(
      `restores committed derived output for %s during an unchanged composing ${pass}`,
      async (raw, formatted, complete) => {
        await start(ZIP);
        type(raw);
        input().focus();
        const events = record();
        input().dispatchEvent(new Event("compositionstart", { bubbles: true }));
        composeDraft(input(), `${formatted}５`);
        input().setSelectionRange(1, 1);
        hidden().value = "";
        input().removeAttribute("data-mask-complete");
        input().toggleAttribute("data-mask-empty", raw !== "");

        if (pass === "morph") {
          input().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
        } else reconnectKeepingFocus(controller());
        await tick();

        expect(hidden().value).toBe(raw);
        expect(input().hasAttribute("data-mask-complete")).toBe(complete);
        expect(input().hasAttribute("data-mask-empty")).toBe(raw === "");
        expect(input().value).toBe(`${formatted}５`);
        expect([input().selectionStart, input().selectionEnd]).toEqual([1, 1]);
        expect(events).toEqual([]);

        input().value = "5";
        input().dispatchEvent(new Event("compositionend", { bubbles: true }));
        expect(hidden().value).toBe("5");
        expect(events).toEqual([
          { event: "change", detail: { masked: "5", unmasked: "5", complete: false } },
        ]);
      },
    );
  }

  it("holds nothing for a morph that changes nothing mid-composition, so a script's write reports as an edit", async () => {
    await start(ZIP);
    type("123");
    const log = record();
    const field = input();
    field.focus();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "123４";
    field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));

    field.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();
    // A script writes the field and tells listeners, which ends the conversion.
    type("1234");

    expect(log.map((entry) => entry.event)).toEqual(["change"]);
  });

  it("holds nothing when a move keeping focus changes nothing, with Values left at their defaults", async () => {
    await start(ZIP);
    type("123");
    const log = record();
    const field = input();
    field.focus();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "123４";
    field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));

    reconnectKeepingFocus(controller());
    await tick();
    type("1234");

    expect(log.map((entry) => entry.event)).toEqual(["change"]);
  });

  it("keeps the caret where the user put it when a held re-format applies once a write ended the composition", async () => {
    await start(ZIP);
    const field = input();
    field.focus();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "12３";
    field.setSelectionRange(3, 3);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    field.setAttribute("data-stimeo--input-mask-pattern-value", "999-999");
    controller().patternValueChanged();

    // A script writes the field, and the engine drops the conversion without compositionend.
    field.value = "123456";
    field.setSelectionRange(2, 2); // after the 2, where a click put it
    field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: "9",
      }),
    );
    await tick();

    expect(field.value).toBe("123-456");
    expect(field.selectionStart).toBe(2);
  });

  it("reports a pattern change that waited out a cancelled composition as reconciled", async () => {
    await start(ZIP);
    type("1234567");
    const log = record();
    const field = input();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "123-4567あ";
    field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    field.setAttribute("data-stimeo--input-mask-pattern-value", "999-99-99");
    controller().patternValueChanged();
    expect(field.value).toBe("123-4567あ");
    expect(log).toEqual([]);

    // Cancelling the conversion puts back the text it started from, so the
    // re-format that follows is the page's alone.
    field.value = "123-4567";
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await tick();

    expect(field.value).toBe("123-45-67");
    expect(log).toEqual([
      { event: "reconcile", detail: { masked: "123-45-67", unmasked: "1234567", complete: true } },
    ]);
  });

  it("holds a tokens change while the field is composing, then formats the commit under it", async () => {
    await start(ZIP);
    const log = record();
    const field = input();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "12３";
    field.setSelectionRange(3, 3);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    // From here on a digit slot takes 0 to 5 only.
    field.setAttribute("data-stimeo--input-mask-tokens-value", JSON.stringify({ "9": "[0-5]" }));
    controller().tokensValueChanged();

    expect(field.value).toBe("12３");
    expect(log).toEqual([]);

    field.value = "１２３４５６７";
    field.setSelectionRange(7, 7);
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));

    // The one format the composition's end runs already uses the new tokens.
    expect(field.value).toBe("123-45");
    expect(hidden().value).toBe("12345");
    await tick();
    expect(log).toEqual([
      { event: "change", detail: { masked: "123-45", unmasked: "12345", complete: false } },
    ]);
  });

  it("empties the sink at once when unmaskToHidden turns off mid-composition, and formats the commit without it", async () => {
    await start(ZIP);
    type("123");
    expect(hidden().value).toBe("123");
    const log = record();
    const field = input();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "123４";
    field.setSelectionRange(4, 4);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    field.setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    controller().unmaskToHiddenValueChanged();

    // The sink stops carrying a raw value nothing maintains any more, while the
    // text the IME owns and the events wait for the composition to end.
    expect(hidden().value).toBe("");
    expect(field.value).toBe("123４");
    expect(log).toEqual([]);

    field.value = "123４５";
    field.setSelectionRange(5, 5);
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));

    expect(field.value).toBe("123-45");
    expect(hidden().value).toBe("");
    await tick();
    expect(log).toEqual([
      { event: "change", detail: { masked: "123-45", unmasked: "12345", complete: false } },
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

  it("clears a sink disabled between connections and resumes it when enabled again", async () => {
    await start(`<form id="zip">${ZIP}</form>`);
    hidden().name = "zip";
    type("1234567");
    const instance = controller();
    const log = record();
    const form = query<HTMLFormElement>("#zip");
    expect(dispatchFormData(form).get("zip")).toBe("1234567");

    reconnectKeepingFocus(instance, () => {
      input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    });
    await tick();

    expect(controller()).toBe(instance);
    expect(input().value).toBe("123-4567");
    expect(hidden().value).toBe("");
    expect(dispatchFormData(form).get("zip")).toBe("");
    expect(log).toEqual([]);

    reconnectKeepingFocus(instance, () => {
      input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "true");
    });
    expect(hidden().value).toBe("1234567");
    reconnectKeepingFocus(instance, () => {
      input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    });
    expect(hidden().value).toBe("");
    expect(log).toEqual([]);
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "keeps a moving composition when sink synchronization is %s and the conversion commits %s",
    async (enabled, committed) => {
      await start(`<form id="zip">${ZIP}</form>`);
      hidden().name = "zip";
      type("123");
      const field = input();
      field.focus();
      field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
      composeDraft(field, "123４");
      field.setSelectionRange(4, 4);
      const instance = controller();
      const log = record();

      reconnectKeepingFocus(instance, () => {
        field.setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", String(enabled));
      });
      await tick();

      expect(controller()).toBe(instance);
      expect(document.activeElement).toBe(field);
      expect(field.value).toBe("123４");
      expect(field.selectionStart).toBe(4);
      expect(hidden().value).toBe(enabled ? "123" : "");
      expect(dispatchFormData(query<HTMLFormElement>("#zip")).get("zip")).toBe(
        enabled ? "123" : "",
      );
      expect(log).toEqual([]);

      field.value = committed ? "123４５" : "123";
      const end = new Event("compositionend", { bubbles: true });
      Object.defineProperty(end, "data", { value: committed ? "４５" : "" });
      field.dispatchEvent(end);
      await tick();

      expect(field.value).toBe(committed ? "123-45" : "123");
      expect(hidden().value).toBe(enabled ? (committed ? "12345" : "123") : "");
      expect(log).toEqual(
        committed
          ? [
              {
                event: "change",
                detail: { masked: "123-45", unmasked: "12345", complete: false },
              },
            ]
          : [],
      );
    },
  );

  it("clears a sink synchronized before the enabled Value callback arrives", async () => {
    await start(
      ZIP.replace(
        'data-controller="stimeo--input-mask"',
        'data-controller="stimeo--input-mask" data-stimeo--input-mask-unmask-to-hidden-value="false"',
      ),
    );
    input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "true");
    type("9876543");
    expect(hidden().value).toBe("9876543");
    const instance = controller();
    const log = record();

    reconnectKeepingFocus(instance, () => {
      input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    });
    await tick();

    expect(controller()).toBe(instance);
    expect(input().value).toBe("987-6543");
    expect(hidden().value).toBe("");
    expect(log).toEqual([]);
  });

  it("leaves a fresh disabled instance's authored sink value intact", async () => {
    await start(
      ZIP.replace(
        'data-controller="stimeo--input-mask"',
        'data-controller="stimeo--input-mask" data-stimeo--input-mask-unmask-to-hidden-value="false"',
      ).replace('id="hidden"', 'id="hidden" value="page-owned"'),
    );
    type("1234567");
    expect(input().value).toBe("123-4567");
    expect(hidden().value).toBe("page-owned");
  });

  it("leaves the authored sink of a disabled cache copy intact", async () => {
    await start(ZIP);
    type("1234567");
    input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    controller().unmaskToHiddenValueChanged();
    hidden().value = "page-owned";
    const previous = controller();

    application = await restoreFromCache(application, (restored) => {
      restored.register("stimeo--input-mask", InputMaskController);
    });

    expect(controller()).not.toBe(previous);
    expect(input().value).toBe("123-4567");
    expect(hidden().value).toBe("page-owned");
  });

  it("does not clear a sink twice after disabling synchronization during a composition", async () => {
    await start(ZIP);
    type("123");
    const field = input();
    field.focus();
    field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(field, "123４");
    field.setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    controller().unmaskToHiddenValueChanged();
    expect(hidden().value).toBe("");
    hidden().value = "page-owned";

    reconnectKeepingFocus(controller());
    await tick();

    expect(field.value).toBe("123４");
    expect(hidden().value).toBe("page-owned");
  });

  it("keeps a page-written sink when a later reconnect leaves synchronization off", async () => {
    await start(ZIP);
    type("1234567");
    const instance = controller();
    reconnectKeepingFocus(instance, () => {
      input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    });
    await tick();
    expect(hidden().value).toBe("");
    hidden().value = "page-owned";

    reconnectKeepingFocus(instance);
    await tick();

    expect(controller()).toBe(instance);
    expect(hidden().value).toBe("page-owned");
  });

  const TWO_SINKS = `
    <form id="f">
      <div id="a">
        <input id="i" type="text" data-controller="stimeo--input-mask"
               data-stimeo--input-mask-pattern-value="999-9999"
               data-action="input->stimeo--input-mask#format">
        <input id="sink-a" type="hidden" name="a" data-stimeo--input-mask-unmask>
      </div>
      <div id="b">
        <input id="sink-b" type="hidden" name="b" value="page-b" data-stimeo--input-mask-unmask>
      </div>
    </form>`;
  const sinkA = () => query<HTMLInputElement>("#sink-a");
  const sinkB = () => query<HTMLInputElement>("#sink-b");

  it("empties the sink it wrote, not the one a moved field resolves to", async () => {
    await start(TWO_SINKS);
    type("1234567");
    const instance = controller();
    expect(sinkA().value).toBe("1234567");

    query("#b").prepend(input());
    input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    await tick();

    expect(controller()).toBe(instance);
    expect(sinkA().value).toBe("");
    expect(sinkB().value).toBe("page-b");
    expect([...dispatchFormData(query<HTMLFormElement>("#f")).entries()]).toEqual([
      ["a", ""],
      ["b", "page-b"],
    ]);
  });

  it("moves its raw value to the sink a synchronizing field resolves to after a move", async () => {
    await start(TWO_SINKS);
    type("1234567");
    const instance = controller();

    query("#b").prepend(input());
    await tick();

    expect(controller()).toBe(instance);
    expect(sinkA().value).toBe("");
    expect(sinkB().value).toBe("1234567");
  });

  const maskField = (id: string) => `
    <input id="${id}" type="text" data-controller="stimeo--input-mask"
           data-stimeo--input-mask-pattern-value="999-9999"
           data-action="input->stimeo--input-mask#format">`;
  const PAIRS = `
    <form id="f">
      <div id="c1">${maskField("a")}<input id="s1" type="hidden" name="s1" data-stimeo--input-mask-unmask></div>
      <div id="c2">${maskField("b")}<input id="s2" type="hidden" name="s2" data-stimeo--input-mask-unmask></div>
    </form>`;

  it.each([false, true])(
    "keeps the raw value another field wrote into the sink it left (same value: %s)",
    async (same) => {
      await start(PAIRS);
      fill("#a", "1112222");
      fill("#b", same ? "1112222" : "3334444");

      query("#c2").prepend(query("#a"));
      query("#c1").prepend(query("#b"));
      await tick();

      expect([...dispatchFormData(query<HTMLFormElement>("#f")).entries()]).toEqual([
        ["s1", same ? "1112222" : "3334444"],
        ["s2", "1112222"],
      ]);
    },
  );

  it("empties its own sink though another field keeps the same raw value elsewhere", async () => {
    await start(PAIRS);
    fill("#a", "1112222");
    fill("#b", "1112222");

    query("#a").setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    await tick();

    expect(query<HTMLInputElement>("#s1").value).toBe("");
    expect(query<HTMLInputElement>("#s2").value).toBe("1112222");
  });

  it("lets the field that wrote a shared sink last take its value back", async () => {
    await start(`
      <div>${maskField("a")}${maskField("b")}
        <input id="hidden" type="hidden" data-stimeo--input-mask-unmask>
      </div>`);
    fill("#a", "1112222");
    fill("#b", "3334444");
    fill("#a", "5556666");
    expect(hidden().value).toBe("5556666");

    query("#a").setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    await tick();

    expect(hidden().value).toBe("");
  });

  it("empties a shared sink when the field whose value it holds stops", async () => {
    await start(`
      <div>
        <input id="a" type="text" data-controller="stimeo--input-mask"
               data-stimeo--input-mask-pattern-value="999-9999"
               data-action="input->stimeo--input-mask#format">
        <input id="b" type="text" data-controller="stimeo--input-mask"
               data-stimeo--input-mask-pattern-value="999-9999"
               data-action="input->stimeo--input-mask#format">
        <input id="hidden" type="hidden" data-stimeo--input-mask-unmask>
      </div>`);
    fill("#a", "1112222");
    fill("#b", "3334444");
    expect(hidden().value).toBe("3334444");

    query("#b").setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    await tick();

    expect(hidden().value).toBe("");
  });

  it("takes back its raw value when the field leaves the page", async () => {
    await start(ZIP);
    type("1234567");
    expect(hidden().value).toBe("1234567");

    input().remove();
    await tick();

    expect(hidden().value).toBe("");
    const writers = (globalThis as unknown as Record<symbol, WeakMap<Element, object>>)[
      Symbol.for("stimeo-ui.input-mask-raw-writer.registry.v1")
    ];
    expect(writers?.has(hidden())).toBe(false);
  });

  it("keeps the raw value a mask of another application wrote into the sink it left", async () => {
    document.body.innerHTML = `
      <div id="root-1">${maskField("i")}</div>
      <div id="root-2"></div>
      <input id="hidden" type="hidden" data-stimeo--input-mask-unmask="i">`;
    application = Application.start(query("#root-1"));
    const other = Application.start(query("#root-2"));
    for (const app of [application, other]) app.register("stimeo--input-mask", InputMaskController);
    try {
      await tick();
      type("1234567");
      expect(hidden().value).toBe("1234567");

      query("#root-2").append(input());
      await tick();

      expect(
        other.getControllerForElementAndIdentifier(input(), "stimeo--input-mask"),
      ).not.toBeNull();
      expect(input().value).toBe("123-4567");
      expect(hidden().value).toBe("1234567");
    } finally {
      disconnectAndStopApplication(other);
    }
  });

  it("keeps the raw value a mask from another copy of the library wrote into the sink it left", async () => {
    document.body.innerHTML = `
      <div id="root-1">${maskField("i")}</div>
      <div id="root-2"></div>
      <input id="hidden" type="hidden" data-stimeo--input-mask-unmask="i">`;
    application = Application.start(query("#root-1"));
    application.register("stimeo--input-mask", InputMaskController);
    vi.resetModules();
    const copy = await import("../src/controllers/input_mask_controller");
    expect(copy.InputMaskController).not.toBe(InputMaskController);
    const other = Application.start(query("#root-2"));
    other.register("stimeo--input-mask", copy.InputMaskController);
    try {
      await tick();
      type("1234567");
      expect(hidden().value).toBe("1234567");

      query("#root-2").append(input());
      await tick();

      expect(
        other.getControllerForElementAndIdentifier(input(), "stimeo--input-mask"),
      ).toBeInstanceOf(copy.InputMaskController);
      expect(hidden().value).toBe("1234567");
    } finally {
      disconnectAndStopApplication(other);
    }
  });

  it("writes a sink that arrives after the field connected, on the next task", async () => {
    await start(
      ZIP.replace(/<input id="hidden"[^>]*>/, "").replace('id="i"', 'id="i" value="1234567"'),
    );
    expect(input().value).toBe("123-4567");
    document.body.insertAdjacentHTML(
      "beforeend",
      '<input id="hidden" type="hidden" data-stimeo--input-mask-unmask>',
    );
    expect(hidden().value).toBe("");

    await tick();

    expect(hidden().value).toBe("1234567");
  });

  it("does not write a sink that arrives after the field has left the page", async () => {
    document.body.innerHTML = ZIP.replace(/<input id="hidden"[^>]*>/, "").replace(
      'id="i"',
      'id="i" value="1234567"',
    );
    application = Application.start();
    application.register("stimeo--input-mask", InputMaskController);
    await flushMicrotasks();
    await flushMicrotasks();
    const field = input();
    expect(field.value).toBe("123-4567");
    field.remove();
    await flushMicrotasks();
    document.body.insertAdjacentHTML(
      "beforeend",
      '<input id="hidden" type="hidden" data-stimeo--input-mask-unmask="i">',
    );

    await tick();

    expect(hidden().value).toBe("");
  });

  it("keeps its raw value while Turbo carries a permanent field to the next page", async () => {
    await start(`
      <div id="carried" data-turbo-permanent>${maskField("i")}</div>
      <input id="hidden" type="hidden" data-stimeo--input-mask-unmask="i">`);
    type("1234567");
    const instance = controller();
    const carried = query("#carried");

    carried.remove();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(hidden().value).toBe("1234567");
    document.body.prepend(carried);
    await tick();

    expect(controller()).toBe(instance);
    expect(hidden().value).toBe("1234567");
  });

  const AWAY = `
    <form id="origin">
      <div id="home">
        <input id="i" type="text" data-controller="stimeo--input-mask"
               data-stimeo--input-mask-pattern-value="999-9999"
               data-action="input->stimeo--input-mask#format">
      </div>
      <input id="hidden" type="hidden" name="raw" data-stimeo--input-mask-unmask>
    </form>
    <form id="away"></form>`;

  it.each([false, true])(
    "leaves no raw value behind while away in a form without a sink (synchronizing: %s)",
    async (synchronizing) => {
      await start(AWAY);
      type("1234567");
      const instance = controller();
      expect(hidden().value).toBe("1234567");

      query("#away").append(input());
      if (!synchronizing) {
        input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
      }
      await tick();
      expect(controller()).toBe(instance);
      expect(hidden().value).toBe("");

      query("#home").append(input());
      await tick();

      expect(controller()).toBe(instance);
      expect(hidden().value).toBe(synchronizing ? "1234567" : "");
      expect(dispatchFormData(query<HTMLFormElement>("#origin")).get("raw")).toBe(
        synchronizing ? "1234567" : "",
      );
    },
  );

  it("empties the sink it wrote, not one the page paired with it later", async () => {
    await start(ZIP);
    type("1234567");
    document.body.insertAdjacentHTML(
      "beforeend",
      '<input id="paired" type="hidden" value="page-owned" data-stimeo--input-mask-unmask="i">',
    );

    input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    await tick();

    expect(hidden().value).toBe("");
    expect(query<HTMLInputElement>("#paired").value).toBe("page-owned");
  });

  it.each([false, true])(
    "leaves a value the page wrote over its raw value when it stops (reconnecting: %s)",
    async (reconnecting) => {
      await start(ZIP);
      type("1234567");
      const instance = controller();
      hidden().value = "page-owned";

      const disable = () => {
        input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
      };
      if (reconnecting) reconnectKeepingFocus(instance, disable);
      else disable();
      await tick();

      expect(controller()).toBe(instance);
      expect(hidden().value).toBe("page-owned");
    },
  );

  it("does not take back a matching value the page wrote after it took its own back", async () => {
    await start(ZIP);
    type("1234567");
    const instance = controller();
    input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    await tick();
    expect(hidden().value).toBe("");
    hidden().value = "1234567";

    reconnectKeepingFocus(instance);
    await tick();

    expect(controller()).toBe(instance);
    expect(hidden().value).toBe("1234567");
  });

  const PASS_THROUGH = ZIP.replace('data-stimeo--input-mask-pattern-value="999-9999"', "").replace(
    'id="hidden"',
    'id="hidden" value="page-owned"',
  );

  it.each([false, true])(
    "leaves the page's sink to a pass-through field that stops synchronizing (reconnecting: %s)",
    async (reconnecting) => {
      await start(PASS_THROUGH);
      type("1234567");
      const instance = controller();
      expect(hidden().value).toBe("page-owned");

      const disable = () => {
        input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
      };
      if (reconnecting) reconnectKeepingFocus(instance, disable);
      else disable();
      await tick();

      expect(controller()).toBe(instance);
      expect(input().value).toBe("1234567");
      expect(hidden().value).toBe("page-owned");
    },
  );

  it.each([false, true])(
    "takes back the raw value it wrote while it has no pattern (reconnecting: %s)",
    async (reconnecting) => {
      await start(ZIP);
      type("1234567");
      const instance = controller();
      expect(hidden().value).toBe("1234567");

      const unmask = () => input().removeAttribute("data-stimeo--input-mask-pattern-value");
      if (reconnecting) reconnectKeepingFocus(instance, unmask);
      else unmask();
      await tick();

      expect(controller()).toBe(instance);
      expect(input().value).toBe("123-4567");
      expect(hidden().value).toBe("");

      input().setAttribute("data-stimeo--input-mask-pattern-value", "999-9999");
      await tick();

      expect(hidden().value).toBe("1234567");
    },
  );

  it("leaves a sink the page added alone when the field has written none", async () => {
    await start(ZIP.replace(/<input id="hidden"[^>]*>/, ""));
    type("1234567");
    document.body.insertAdjacentHTML(
      "beforeend",
      '<input id="hidden" type="hidden" value="page-owned" data-stimeo--input-mask-unmask>',
    );

    input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    await tick();

    expect(hidden().value).toBe("page-owned");
  });

  it("keeps a sink the page adds once its own sink left and it stopped", async () => {
    await start(ZIP);
    type("1234567");
    expect(hidden().value).toBe("1234567");
    const instance = controller();
    hidden().remove();
    input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "false");
    await tick();
    document.body.insertAdjacentHTML(
      "beforeend",
      '<input id="hidden" type="hidden" value="page-owned" data-stimeo--input-mask-unmask>',
    );

    reconnectKeepingFocus(instance);
    await tick();

    expect(controller()).toBe(instance);
    expect(hidden().value).toBe("page-owned");
  });

  it("refills the sink with the current raw value when unmaskToHidden turns back on", async () => {
    await start(`
      <input id="i" type="text" data-controller="stimeo--input-mask"
             data-stimeo--input-mask-pattern-value="999-9999"
             data-stimeo--input-mask-unmask-to-hidden-value="false"
             data-action="input->stimeo--input-mask#format">
      <input id="hidden" type="hidden" data-stimeo--input-mask-unmask>`);
    type("1234567");
    expect(hidden().value).toBe("");

    input().setAttribute("data-stimeo--input-mask-unmask-to-hidden-value", "true");
    controller().unmaskToHiddenValueChanged();

    expect(hidden().value).toBe("1234567");
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

  it("releases the composition listeners on disconnect", async () => {
    await start(ZIP);
    const log = record();
    controller().disconnect();

    const field = input();
    field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field.value = "1234567";
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));

    expect(field.value).toBe("1234567");
    expect(hidden().value).toBe("");
    expect(log).toEqual([]);
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

  it("reports a pending page format once when the user confirms the text", async () => {
    await start(ZIP);
    type("1234567");
    const changes: unknown[] = [];
    const repairs: unknown[] = [];
    input().addEventListener("stimeo--input-mask:change", (event) =>
      changes.push((event as CustomEvent).detail),
    );
    input().addEventListener("stimeo--input-mask:reconcile", (event) =>
      repairs.push((event as CustomEvent).detail),
    );
    input().setAttribute("data-stimeo--input-mask-pattern-value", "99-99999");
    type("1234567");
    await tick();
    expect(changes).toEqual([{ masked: "12-34567", unmasked: "1234567", complete: true }]);
    expect(repairs).toEqual([]);
  });

  it("stays quiet when the user returns pending text to the last published masked value", async () => {
    await start(ZIP);
    type("1234567");
    const changes: unknown[] = [];
    input().addEventListener("stimeo--input-mask:change", (event) =>
      changes.push((event as CustomEvent).detail),
    );
    input().value = "7654321";
    type("1234567");
    expect(input().value).toBe("123-4567");
    expect(changes).toEqual([]);
  });

  it("reads the controller-formatted value with its authored field name", async () => {
    await start(`<label for="i">Postal code</label><input id="i" type="text"
      data-controller="stimeo--input-mask" data-stimeo--input-mask-pattern-value="999-9999"
      data-action="input->stimeo--input-mask#format">`);
    type("1234567");
    expect(input().value).toBe("123-4567");
    expect(await captureSpeech({ container: input(), steps: 0 })).toEqual([
      "textbox, Postal code, 123-4567",
    ]);
  });
});
