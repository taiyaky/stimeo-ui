import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { OtpController } from "../src/controllers/otp_controller";
import { composeDraft } from "./helpers/ime";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { delay, tick } from "./helpers/timing";

/** Interrupted conversions validate only their own residual slot without confirming an edit. */
describe("OTP interrupted composition publication", () => {
  let application: Application | undefined;
  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    document.body.innerHTML = "";
  });

  const mount = async (previous = "", pattern = "[0-9]") => {
    document.body.innerHTML = `<form id="otp-form"><div id="otp" data-controller="stimeo--otp" data-stimeo--otp-pattern-value="${pattern}" role="group" aria-label="Passcode">
    ${["", "2", "3", previous].map((value, index) => `<input id="digit-${index}" value="${value}" data-stimeo--otp-target="field" maxlength="1" aria-label="Digit ${index + 1}" data-action="input->stimeo--otp#onInput keydown->stimeo--otp#onKeydown">`).join("")}
    <input type="hidden" name="otp" data-stimeo--otp-target="value"><p id="error" data-stimeo--otp-target="error" hidden>Digits only</p></div></form>`;
    application = Application.start();
    application.register("stimeo--otp", OtpController);
    await tick();
    const root = document.getElementById("otp") as HTMLElement;
    const form = document.getElementById("otp-form") as HTMLFormElement;
    const digits = Array.from(
      root.querySelectorAll<HTMLInputElement>('[data-stimeo--otp-target="field"]'),
    );
    const first = digits[0] as HTMLInputElement;
    const last = digits[3] as HTMLInputElement;
    const hidden = root.querySelector<HTMLInputElement>('input[type="hidden"]') as HTMLInputElement;
    const events: Array<[string, Record<string, string>]> = [];
    for (const name of ["change", "complete", "invalid", "reconcile"]) {
      root.addEventListener(`stimeo--otp:${name}`, (event) => {
        events.push([name, (event as CustomEvent<Record<string, string>>).detail]);
      });
    }
    const snapshot = () => ({
      fields: digits.map((field) => field.value),
      value: hidden.value,
      submitted: new FormData(form).get("otp"),
      state: root.getAttribute("data-state"),
      filled: digits.map((field) => field.getAttribute("data-filled")),
      invalid: digits.map((field) => field.getAttribute("aria-invalid")),
      described: digits.map((field) => field.getAttribute("aria-describedby")),
      errorHidden: document.getElementById("error")?.hasAttribute("hidden"),
    });
    const patternTo = async (value: string) => {
      root.setAttribute("data-stimeo--otp-pattern-value", value);
      await tick();
    };
    return { root, form, digits, first, last, hidden, events, snapshot, patternTo };
  };

  const begin = (field: HTMLInputElement, draft: string) => {
    field.focus();
    field.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(field, draft);
  };
  const end = (field: HTMLInputElement, text: string) => {
    field.value = text;
    const event = new Event("compositionend", { bubbles: true });
    Object.defineProperty(event, "data", { value: text });
    field.dispatchEvent(event);
  };
  const edit = (field: HTMLInputElement, text: string, before = false) => {
    if (before)
      field.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          inputType: "insertText",
          isComposing: false,
          data: text,
        }),
      );
    field.value = text;
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: text,
      }),
    );
  };

  for (const previous of ["", "9"]) {
    for (const [draft, accepted] of [
      ["4", "4"],
      ["４", "4"],
      ["", ""],
      ["う", previous],
      ["45", previous],
      ["４５", previous],
      ["4う", previous],
    ] as const) {
      it(`settles residual ${JSON.stringify(draft)} over ${JSON.stringify(previous)} in its own slot`, async () => {
        const h = await mount(previous);
        begin(h.last, draft);
        expect(h.hidden.value).toBe(`23${previous}`);
        begin(h.first, "１");
        const during = h.snapshot();
        expect(during.fields).toEqual(["１", "2", "3", accepted]);
        expect(during.value).toBe(`23${accepted}`);
        expect(during.submitted).toBe(`23${accepted}`);
        expect(during.state).toBe("partial");
        expect(during.filled[3]).toBe(accepted ? "true" : null);
        expect(during.invalid).toEqual([null, null, null, null]);
        expect(during.errorHidden).toBe(true);
        expect(document.activeElement).toBe(h.first);
        expect([h.first.selectionStart, h.first.selectionEnd]).toEqual([1, 1]);
        expect(h.events).toEqual(
          accepted === previous ? [] : [["reconcile", { value: `23${accepted}` }]],
        );
        h.events.length = 0;
        end(h.first, "1");
        await tick();
        expect(h.snapshot().value).toBe(`123${accepted}`);
        expect(h.snapshot().submitted).toBe(`123${accepted}`);
        expect(h.snapshot().state).toBe(accepted ? "complete" : "partial");
        expect(h.events).toEqual([
          ["change", { value: `123${accepted}` }],
          ...(accepted ? [["complete", { value: `123${accepted}` }]] : []),
        ]);
      });
    }
  }

  it("uses the latest pattern for the residual and rollback, then drops other old digits before confirmation", async () => {
    const h = await mount("9");
    begin(h.last, "う");
    await h.patternTo("[1-4]");
    await h.patternTo("[1-3]");
    begin(h.first, "１");
    expect(h.snapshot().fields).toEqual(["１", "2", "3", ""]);
    expect(h.snapshot().value).toBe("23");
    expect(h.events).toEqual([["reconcile", { value: "23" }]]);
    h.events.length = 0;
    end(h.first, "1");
    await tick();
    expect(h.events).toEqual([["change", { value: "123" }]]);
  });

  for (const locked of ["disabled", "readOnly"] as const) {
    it(`validates an interrupted ${locked} slot without rewriting its DOM`, async () => {
      const h = await mount();
      begin(h.last, "う");
      h.last[locked] = true;
      begin(h.first, "１");
      expect(h.last.value).toBe("う");
      expect(h.snapshot().value).toBe("23");
      expect(h.snapshot().filled[3]).toBeNull();
      expect(h.events).toEqual([]);
      end(h.first, "1");
      await tick();
      expect(h.last.value).toBe("う");
      expect(h.snapshot().value).toBe("123");
      expect(h.snapshot().submitted).toBe("123");
      expect(h.snapshot().state).toBe("partial");
      expect(h.events).toEqual([["change", { value: "123" }]]);
      h.last.value = "8";
      h.root.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      await tick();
      expect(h.last.value).toBe("8");
      expect(h.snapshot().value).toBe("1238");
      expect(h.events.at(-1)).toEqual(["reconcile", { value: "1238" }]);
    });
  }

  for (const draft of ["う", "４"]) {
    it(`protects a new conversion in the same element after residual ${draft}`, async () => {
      const h = await mount();
      begin(h.last, draft);
      h.last.setSelectionRange(1, 1);
      h.last.dispatchEvent(new Event("compositionstart", { bubbles: true }));
      expect(h.last.value).toBe(draft);
      expect(document.activeElement).toBe(h.last);
      expect([h.last.selectionStart, h.last.selectionEnd]).toEqual([1, 1]);
      expect(h.snapshot().value).toBe(draft === "４" ? "234" : "23");
      composeDraft(h.last, "５");
      h.events.length = 0;
      end(h.last, "5");
      await tick();
      expect(h.snapshot().fields).toEqual(["", "2", "3", "5"]);
      expect(h.events).toEqual([["change", { value: "235" }]]);
    });
  }

  it("cancels a restarted conversion to its validated prior slot without reporting an edit", async () => {
    const h = await mount();
    begin(h.last, "う");
    h.last.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    composeDraft(h.last, "に");
    h.events.length = 0;
    end(h.last, "う");
    await tick();
    expect(h.last.value).toBe("");
    expect(h.snapshot().value).toBe("23");
    expect(h.events).toEqual([]);
  });

  for (const how of ["script", "reset", "morph"] as const) {
    it(`adopts ${how}'s new value without restoring an older committed digit`, async () => {
      const h = await mount("9");
      begin(h.last, "う");
      if (how === "reset") {
        h.last.defaultValue = "8";
        h.form.reset();
      } else {
        h.last.value = "8";
        if (how === "morph")
          h.root.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      }
      begin(h.first, "１");
      await tick();
      expect(h.last.value).toBe("8");
      expect(h.snapshot().value).toBe(how === "script" ? "239" : "238");
      expect(h.events).toEqual(how === "script" ? [] : [["reconcile", { value: "238" }]]);
      h.events.length = 0;
      end(h.first, "1");
      await tick();
      expect(h.snapshot().value).toBe("1238");
      expect(h.events).toEqual([
        ["change", { value: "1238" }],
        ["complete", { value: "1238" }],
      ]);
    });
  }

  for (const before of [false, true]) {
    it(`keeps ordinary input's own edit notification, beforeinput=${before}`, async () => {
      const h = await mount("9");
      begin(h.last, "う");
      edit(h.last, "4", before);
      await tick();
      expect(h.last.value).toBe("4");
      expect(h.snapshot().value).toBe("234");
      expect(h.events).toEqual([["change", { value: "234" }]]);
    });
    it(`applies a held pattern before ordinary input without swallowing the edit, beforeinput=${before}`, async () => {
      const h = await mount("a", "[0-9a-f]");
      begin(h.last, "う");
      await h.patternTo("[0-9]");
      edit(h.last, "4", before);
      await tick();
      expect(h.snapshot().fields).toEqual(["", "2", "3", "4"]);
      expect(h.snapshot().value).toBe("234");
      expect(h.events).toEqual([
        ["reconcile", { value: "23" }],
        ["change", { value: "234" }],
      ]);
    });
  }

  it("does not consume a later real compositionend or its following ordinary edit", async () => {
    const h = await mount();
    begin(h.last, "う");
    h.last.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", isComposing: false }),
    );
    expect(h.last.value).toBe("");
    expect(h.events).toEqual([]);
    end(h.last, "４");
    expect(h.events).toEqual([["change", { value: "234" }]]);
    edit(h.last, "5");
    expect(h.events).toEqual([
      ["change", { value: "234" }],
      ["change", { value: "235" }],
    ]);
  });

  for (const text of ["9", "う", "４５"]) {
    it(`preserves normal confirmation or cancellation for ${text}`, async () => {
      const h = await mount("9");
      begin(h.last, "に");
      end(h.last, text);
      await tick();
      expect(h.last.value).toBe(text === "４５" ? "4" : "9");
      expect(h.events).toEqual(
        text === "9"
          ? []
          : text === "う"
            ? [["invalid", { pattern: "[0-9]" }]]
            : [["change", { value: "234" }]],
      );
    });
  }

  it("does not resume an obsolete conversion after a reconcile listener clears the group", async () => {
    const h = await mount();
    h.root.setAttribute("data-action", "clear->stimeo--otp#clear");
    await tick();
    h.root.addEventListener(
      "stimeo--otp:reconcile",
      () => h.root.dispatchEvent(new Event("clear")),
      { once: true },
    );
    begin(h.last, "４");
    h.first.focus();
    h.first.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    await tick();
    expect(h.snapshot().fields).toEqual(["", "", "", ""]);
    expect(h.snapshot().value).toBe("");
    expect(h.events).toEqual([
      ["reconcile", { value: "234" }],
      ["change", { value: "" }],
    ]);
  });

  it("keeps the input's confirmation distinct from an equal valid residual reconciliation", async () => {
    const h = await mount("9");
    begin(h.last, "4");
    edit(h.last, "4", true);
    await tick();
    expect(h.snapshot().value).toBe("234");
    expect(h.events).toEqual([
      ["reconcile", { value: "234" }],
      ["change", { value: "234" }],
    ]);
    h.events.length = 0;
    edit(h.last, "4", true);
    expect(h.events).toEqual([]);
  });

  it("does not carry a prevented input's comparison into a later input-only edit", async () => {
    const h = await mount("9");
    begin(h.last, "4");
    const notice = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      isComposing: false,
    });
    h.last.addEventListener("beforeinput", (event) => event.preventDefault(), { once: true });
    h.last.dispatchEvent(notice);
    await delay(5);
    expect(h.events).toEqual([["reconcile", { value: "234" }]]);
    h.events.length = 0;
    edit(h.last, "4");
    expect(h.events).toEqual([]);
  });

  it("reports a later rejected input once while interruption itself stays non-invalid", async () => {
    const h = await mount("9");
    begin(h.last, "う");
    edit(h.last, "に", true);
    await tick();
    expect(h.last.value).toBe("9");
    expect(h.snapshot().value).toBe("239");
    expect(h.events).toEqual([["invalid", { pattern: "[0-9]" }]]);
  });

  it("counts one accepted Unicode code point as one residual slot", async () => {
    const h = await mount("", "[0-9]|😀");
    begin(h.last, "😀");
    begin(h.first, "１");
    expect(h.snapshot().value).toBe("23😀");
    expect(h.last.value).toBe("😀");
    expect(h.events).toEqual([["reconcile", { value: "23😀" }]]);
  });

  it("releases a pending input comparison on disconnect and does not restore it on reconnect", async () => {
    const h = await mount("9");
    begin(h.last, "4");
    h.last.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", isComposing: false }),
    );
    h.root.removeAttribute("data-controller");
    await tick();
    h.root.setAttribute("data-controller", "stimeo--otp");
    await tick();
    h.events.length = 0;
    edit(h.last, "4");
    expect(h.snapshot().value).toBe("234");
    expect(h.events).toEqual([]);
  });

  it("ends a composition quietly when the controller unloads while its field keeps focus", async () => {
    const h = await mount("9");
    begin(h.last, "う");
    const before = h.snapshot();
    h.events.length = 0;
    application?.unload("stimeo--otp");
    await tick();
    expect(document.activeElement).toBe(h.last);
    expect(h.snapshot()).toEqual({ ...before, state: null });
    expect(h.last.value).toBe("う");
    expect(h.events).toEqual([]);
  });

  it("keeps an interrupted beforeinput's basis when reconciliation synchronously edits another field", async () => {
    const h = await mount("9");
    begin(h.last, "4");
    h.root.addEventListener("stimeo--otp:reconcile", () => edit(h.first, "1", true), {
      once: true,
    });
    edit(h.last, "4", true);
    expect(h.snapshot().value).toBe("1234");
    expect(h.events).toEqual([
      ["reconcile", { value: "234" }],
      ["change", { value: "1234" }],
      ["complete", { value: "1234" }],
      ["change", { value: "1234" }],
      ["complete", { value: "1234" }],
    ]);
  });

  for (const confirmed of ["4", "４"]) {
    it(`keeps a formal end's edit after equal valid residual publication: ${confirmed}`, async () => {
      const h = await mount("9");
      edit(h.first, "1");
      h.events.length = 0;
      begin(h.last, "4");
      h.last.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          inputType: "insertText",
          isComposing: false,
        }),
      );
      expect(h.events).toEqual([["reconcile", { value: "1234" }]]);
      end(h.last, confirmed);
      expect(h.snapshot().value).toBe("1234");
      expect(h.snapshot().submitted).toBe("1234");
      expect(h.events).toEqual([
        ["reconcile", { value: "1234" }],
        ["change", { value: "1234" }],
        ["complete", { value: "1234" }],
      ]);
      h.last.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertFromComposition" }),
      );
      expect(h.events).toHaveLength(3);
      h.events.length = 0;
      edit(h.last, "4", true);
      expect(h.events).toEqual([]);
    });
  }

  for (const locked of ["readOnly", "disabled"] as const) {
    it(`keeps an interrupted ${locked} projection across a copied-page connection`, async () => {
      const h = await mount();
      edit(h.first, "1");
      begin(h.last, "う");
      h.last[locked] = true;
      begin(h.first, "１");
      end(h.first, "1");
      expect(h.snapshot().value).toBe("123");
      if (!application) throw new Error("Missing application");
      application = await restoreFromCache(application, (restored) =>
        restored.register("stimeo--otp", OtpController),
      );
      const root = document.getElementById("otp") as HTMLElement;
      const form = document.getElementById("otp-form") as HTMLFormElement;
      const first = document.getElementById("digit-0") as HTMLInputElement;
      const last = document.getElementById("digit-3") as HTMLInputElement;
      const hidden = root.querySelector<HTMLInputElement>(
        'input[type="hidden"]',
      ) as HTMLInputElement;
      expect(last.value).toBe("う");
      expect(hidden.value).toBe("123");
      expect(new FormData(form).get("otp")).toBe("123");
      const events: string[] = [];
      for (const name of ["change", "complete", "reconcile", "invalid"])
        root.addEventListener(`stimeo--otp:${name}`, () => events.push(name));
      edit(first, "2");
      expect(hidden.value).toBe("223");
      expect(new FormData(form).get("otp")).toBe("223");
      expect(root.getAttribute("data-state")).toBe("partial");
      expect(events).toEqual(["change"]);
      last.value = "8";
      root.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      await tick();
      expect(last.value).toBe("8");
      expect(hidden.value).toBe("2238");
      expect(events).toEqual(["change", "reconcile"]);
    });
  }

  it("keeps an authored readonly page value on a copied page without classifying it as old residual", async () => {
    const h = await mount();
    edit(h.first, "1");
    h.last.readOnly = true;
    h.last.value = "う";
    if (!application) throw new Error("Missing application");
    application = await restoreFromCache(application, (restored) =>
      restored.register("stimeo--otp", OtpController),
    );
    const root = document.getElementById("otp") as HTMLElement;
    expect(root.querySelector<HTMLInputElement>('input[type="hidden"]')?.value).toBe("123う");
    expect((document.getElementById("digit-3") as HTMLInputElement).value).toBe("う");
  });

  for (const marker of [
    "not-json",
    "null",
    "[]",
    '{"text":4,"value":""}',
    '{"text":"う","value":4}',
  ]) {
    it(`does not classify malformed projection metadata as accepted residual: ${marker}`, async () => {
      const h = await mount();
      edit(h.first, "1");
      h.last.readOnly = true;
      h.last.value = "う";
      h.last.setAttribute("data-stimeo--otp-interrupted", marker);
      if (!application) throw new Error("Missing application");
      application = await restoreFromCache(application, (restored) =>
        restored.register("stimeo--otp", OtpController),
      );
      const root = document.getElementById("otp") as HTMLElement;
      expect(root.querySelector<HTMLInputElement>('input[type="hidden"]')?.value).toBe("123う");
      expect((document.getElementById("digit-3") as HTMLInputElement).value).toBe("う");
    });
  }
});
