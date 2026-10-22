import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { CurrencyInputController } from "../src/controllers/currency_input_controller";
import { query } from "./helpers/dom";
import { composeDraft } from "./helpers/ime";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/** Focused arrivals need positive editing evidence before their text can be accepted. */
describe("CurrencyInputController with an unsettled focused display", () => {
  let application: Application | null = null;
  const modes = ["fresh", "reconnect", "arrival"] as const;
  type Mode = (typeof modes)[number];
  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = null;
    document.body.innerHTML = "";
  });

  const boot = async (
    mode: Mode,
    composing = false,
    server = "server-amount",
    initial = "1234",
    locale = "en-US",
  ) => {
    document.body.innerHTML = `<form id="late-form"><div id="late-root"
      ${mode === "fresh" ? "" : 'data-controller="stimeo--currency-input"'}
      data-stimeo--currency-input-locale-value="${locale}">
      <input id="late-amount" aria-label="Amount" value="${initial}"
        ${mode === "arrival" ? "" : 'data-stimeo--currency-input-target="display"'}
        data-action="input->stimeo--currency-input#onInput blur->stimeo--currency-input#format">
      ${mode === "arrival" ? '<input value="1234" data-stimeo--currency-input-target="display" aria-label="Previous amount">' : ""}
      <input id="late-hidden" type="hidden" name="amount" value="${server}"
        data-stimeo--currency-input-target="field">
      <span id="late-spoken" data-stimeo--currency-input-target="srValue">server text</span>
      </div></form><button id="late-outside">Outside</button>`;
    const root = query<HTMLElement>("#late-root");
    const input = query<HTMLInputElement>("#late-amount");
    const events: string[] = [];
    for (const kind of ["change", "reconcile"]) {
      root.addEventListener(`stimeo--currency-input:${kind}`, (event) => {
        events.push(`${kind}:${(event as CustomEvent<{ value: number | null }>).detail.value}`);
      });
    }
    application = Application.start();
    application.register("stimeo--currency-input", CurrencyInputController);
    await tick();
    input.focus();
    if (composing) {
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(input, "1,234.00５");
    }
    if (mode === "reconnect") {
      root.removeAttribute("data-controller");
      await tick();
    }
    if (!composing) {
      input.value = "1234.005";
      input.setSelectionRange(3, 6);
    }
    if (mode === "arrival") input.setAttribute("data-stimeo--currency-input-target", "display");
    else root.setAttribute("data-controller", "stimeo--currency-input");
    await tick();
    const controller = application.getControllerForElementAndIdentifier(
      root,
      "stimeo--currency-input",
    ) as CurrencyInputController;
    return { root, input, events, controller };
  };

  const hidden = () => query<HTMLInputElement>("#late-hidden");
  const spoken = () => query<HTMLElement>("#late-spoken");
  const submitted = () => new FormData(query<HTMLFormElement>("#late-form")).get("amount");
  const edit = (
    input: HTMLInputElement,
    text: string,
    inputType = "insertText",
    isComposing = false,
  ) => {
    input.value = text;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, isComposing }));
  };

  it.each(modes)(
    "does not adopt or format an unknown focused %s, even for submission",
    async (mode) => {
      const { input, events, root, controller } = await boot(mode);
      expect(input.value).toBe("1234.005");
      expect([input.selectionStart, input.selectionEnd]).toEqual([3, 6]);
      expect(hidden().value).toBe(mode === "fresh" ? "server-amount" : "1234");
      expect(submitted()).toBe(hidden().value);
      expect(spoken().textContent).toBe(mode === "fresh" ? "server text" : "1,234.00");
      controller.fieldTargetConnected();
      controller.srValueTargetConnected();
      root.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      await tick();
      expect(input.value).toBe("1234.005");
      expect(hidden().value).toBe(mode === "fresh" ? "server-amount" : "1234");
      expect(events).toEqual([]);
    },
  );

  it.each(modes)("accepts a positive ordinary edit after %s without rounding it", async (mode) => {
    const { input, events } = await boot(mode);
    edit(input, "1234.0056");
    expect(input.value).toBe("1,234.0056");
    expect(hidden().value).toBe("1234.0056");
    expect(submitted()).toBe("1234.0056");
    expect(events).toEqual(["change:1234.0056"]);
  });

  it.each(modes)("protects a composition whose start preceded %s until its end", async (mode) => {
    const { input, events } = await boot(mode, true);
    expect(input.value).toBe("1,234.00５");
    expect(hidden().value).toBe(mode === "fresh" ? "server-amount" : "1234");
    edit(input, "1,234.00５６", "insertCompositionText", false);
    expect(input.value).toBe("1,234.00５６");
    expect(hidden().value).toBe(mode === "fresh" ? "server-amount" : "1234");
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(input.value).toBe("1,234.0056");
    expect(submitted()).toBe("1234.0056");
    expect(events).toEqual(["change:1234.0056"]);
  });

  it("does not turn a fresh page's empty hidden into a committed baseline", async () => {
    const { input, events } = await boot("fresh", false, "");
    expect(submitted()).toBe("");
    edit(input, "1234.0056");
    expect(events).toEqual(["change:1234.0056"]);
    expect(submitted()).toBe("1234.0056");
  });

  it("does not take even a numeric server hidden as a fresh comparison baseline", async () => {
    const { input, events } = await boot("fresh", false, "1234");
    edit(input, "1234");
    expect(submitted()).toBe("1234");
    expect(events).toEqual(["change:1234"]);
  });

  it("retains an accepted empty amount rather than treating it as a fresh connection", async () => {
    const { input, events, controller } = await boot("reconnect", false, "server-amount", "");
    hidden().value = "page replacement";
    controller.fieldTargetConnected();
    expect(submitted()).toBe("");
    edit(input, "-");
    expect(submitted()).toBe("");
    expect(events).toEqual([]);
    edit(input, "0");
    expect(events).toEqual(["change:0"]);
  });

  it("requires positive input evidence rather than a bare input or an explicit regrouping request", async () => {
    const { input, controller, events } = await boot("reconnect");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    controller.onInput();
    controller.onInput(new InputEvent("input", { inputType: "insertText", isComposing: false }));
    input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }));
    expect(input.value).toBe("1234.005");
    expect(submitted()).toBe("1234");
    expect(events).toEqual([]);
    edit(input, "1234.0056");
    expect(events).toEqual(["change:1234.0056"]);
  });

  it("keeps submission and the draft unchanged when blur arrives without an end", async () => {
    const { input, events, root } = await boot("reconnect", true);
    input.blur();
    await tick();
    root.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();
    expect(input.value).toBe("1,234.00５");
    expect(submitted()).toBe("1234");
    expect(events).toEqual([]);
  });

  it("keeps the same unknown field pending through target removal and return", async () => {
    const { input, events, controller } = await boot("reconnect");
    input.removeAttribute("data-stimeo--currency-input-target");
    await tick();
    expect(() => controller.onInput()).not.toThrow();
    expect(() => controller.format()).not.toThrow();
    expect(input.value).toBe("1234.005");
    expect(submitted()).toBe("1234");
    expect(events).toEqual([]);
    input.setAttribute("data-stimeo--currency-input-target", "display");
    await tick();
    controller.fieldTargetConnected();
    expect(input.value).toBe("1234.005");
    expect(submitted()).toBe("1234");
    expect(events).toEqual([]);
    edit(input, "1234.0056");
    expect(input.value).toBe("1,234.0056");
    expect(submitted()).toBe("1234.0056");
    expect(events).toEqual(["change:1234.0056"]);
  });

  /**
   * Mounts the display unfocused, so the controller accepts and renders `1,234.00` before the
   * display takes focus.
   */
  const bootAccepted = async () => {
    document.body.innerHTML = `<form id="late-form"><div id="late-root"
      data-controller="stimeo--currency-input" data-stimeo--currency-input-locale-value="en-US">
      <input id="late-amount" aria-label="Amount" value="1234"
        data-stimeo--currency-input-target="display"
        data-action="input->stimeo--currency-input#onInput blur->stimeo--currency-input#format">
      <input id="late-hidden" type="hidden" name="amount" value="server-amount"
        data-stimeo--currency-input-target="field">
      <span id="late-spoken" data-stimeo--currency-input-target="srValue">server text</span>
      </div></form>`;
    application = Application.start();
    application.register("stimeo--currency-input", CurrencyInputController);
    await tick();
    const root = query<HTMLElement>("#late-root");
    const input = query<HTMLInputElement>("#late-amount");
    const events: string[] = [];
    for (const kind of ["change", "reconcile"]) {
      root.addEventListener(`stimeo--currency-input:${kind}`, (event) => {
        events.push(`${kind}:${(event as CustomEvent<{ value: number | null }>).detail.value}`);
      });
    }
    const controller = application.getControllerForElementAndIdentifier(
      root,
      "stimeo--currency-input",
    ) as CurrencyInputController;
    input.focus();
    return { root, input, events, controller };
  };

  /**
   * Takes the display target off the focused field for a whole turn, then puts it back.
   * `meanwhile` runs just before the target returns, and `returning` just after it, before
   * the target callback that notices the return.
   */
  const awayForATurn = async (
    input: HTMLInputElement,
    meanwhile = () => {},
    returning = () => {},
  ) => {
    input.removeAttribute("data-stimeo--currency-input-target");
    await tick();
    meanwhile();
    input.setAttribute("data-stimeo--currency-input-target", "display");
    returning();
    await tick();
  };

  /** Starts a composition in `input` and writes its first draft. */
  const startDraft = (input: HTMLInputElement) => {
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input, "1,234.00５");
  };

  it.each([
    [
      "the controller reconnects",
      async (root: HTMLElement, input: HTMLInputElement) => {
        startDraft(input);
        root.removeAttribute("data-controller");
        await tick();
        root.setAttribute("data-controller", "stimeo--currency-input");
        await tick();
      },
    ],
    [
      "the display returns as the target after the start was heard",
      async (_root: HTMLElement, input: HTMLInputElement) => {
        startDraft(input);
        await awayForATurn(input);
      },
    ],
    [
      "the display returns as the target after a start it never heard",
      async (_root: HTMLElement, input: HTMLInputElement) => {
        await awayForATurn(input, () => startDraft(input));
      },
    ],
  ])(
    "does not adopt a focused accepted display's draft when %s a turn later",
    async (_name, away) => {
      const { root, input, events } = await bootAccepted();
      await away(root, input);
      expect(input.value).toBe("1,234.00５");
      expect(submitted()).toBe("1234");
      expect(spoken().textContent).toBe("1,234.00");
      expect(events).toEqual([]);
      composeDraft(input, "1,234.00５６");
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      expect(input.value).toBe("1,234.0056");
      expect(submitted()).toBe("1234.0056");
      expect(events).toEqual(["change:1234.0056"]);
    },
  );

  it("does not hold a focused display that returns as the target still showing this controller's rendering", async () => {
    const { root, input, events, controller } = await bootAccepted();
    await awayForATurn(input);
    expect(document.activeElement).toBe(input);
    root.setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller.localeValueChanged();
    expect(input.value).toBe("1.234,00");
    expect(submitted()).toBe("1234");
    expect(spoken().textContent).toBe("1.234,00");
    expect(events).toEqual([]);
  });

  // The root's Value is written before the display's target, as a morph that updates a
  // parent's attributes before its children's does, and its change callback runs before
  // the target callback.
  it.each([
    ["locale", "en-GB", (controller: CurrencyInputController) => controller.localeValueChanged()],
    ["precision", "3", (controller: CurrencyInputController) => controller.precisionValueChanged()],
  ])(
    "does not adopt a returning display's draft when a %s change is read before its target callback",
    async (name, value, changed) => {
      const { root, input, events, controller } = await bootAccepted();
      startDraft(input);
      input.setSelectionRange(8, 9);
      await awayForATurn(
        input,
        () => root.setAttribute(`data-stimeo--currency-input-${name}-value`, value),
        () => changed(controller),
      );
      expect(input.value).toBe("1,234.00５");
      expect([input.selectionStart, input.selectionEnd]).toEqual([8, 9]);
      expect(submitted()).toBe("1234");
      expect(spoken().textContent).toBe("1,234.00");
      expect(events).toEqual([]);
      composeDraft(input, "1,234.00５６");
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      expect(input.value).toBe("1,234.0056");
      expect(submitted()).toBe("1234.0056");
      expect(events).toEqual(["change:1234.0056"]);
    },
  );

  it.each([
    [
      "format() is called",
      (_input: HTMLInputElement, controller: CurrencyInputController) => controller.format(),
    ],
    [
      "the display blurs",
      (input: HTMLInputElement, _controller: CurrencyInputController) => input.blur(),
    ],
  ])(
    "holds a returning display's draft and rounding when %s before its target callback",
    async (_name, request) => {
      const { input, events, controller } = await bootAccepted();
      startDraft(input);
      await awayForATurn(
        input,
        () => {},
        () => request(input, controller),
      );
      expect(input.value).toBe("1,234.00５");
      expect(submitted()).toBe("1234");
      expect(spoken().textContent).toBe("1,234.00");
      expect(events).toEqual([]);
      composeDraft(input, "1,234.00５６");
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      expect(input.value).toBe("1,234.01");
      expect(submitted()).toBe("1234.01");
      expect(events).toEqual(["change:1234.01"]);
    },
  );

  it("rounds a display that came back showing this controller's rendering when it blurs before its target callback", async () => {
    const { input, events } = await bootAccepted();
    edit(input, "1234.0056");
    await awayForATurn(
      input,
      () => {},
      () => input.blur(),
    );
    expect(input.value).toBe("1,234.01");
    expect(submitted()).toBe("1234.01");
    expect(events).toEqual(["change:1234.0056", "change:1234.01"]);
  });

  it("reads a display the page wrote while its target was away once it returns unfocused", async () => {
    const { input, events } = await bootAccepted();
    input.blur();
    await awayForATurn(input, () => {
      input.value = "2.5";
    });
    expect(input.value).toBe("2.50");
    expect(submitted()).toBe("2.5");
    expect(events).toEqual(["reconcile:2.5"]);
  });

  it("reads a later page write into a display that came back showing this controller's rendering", async () => {
    const { root, input, events, controller } = await bootAccepted();
    await awayForATurn(input);
    input.value = "2.3456";
    root.setAttribute("data-stimeo--currency-input-precision-value", "3");
    controller.precisionValueChanged();
    expect(input.value).toBe("2.3456");
    expect(submitted()).toBe("2.3456");
    expect(events).toEqual(["reconcile:2.3456"]);
  });

  it("holds the display rendered last when it returns after a display behind it left with it", async () => {
    const { root, input, events } = await bootAccepted();
    const behind = document.createElement("input");
    behind.value = "2";
    behind.setAttribute("data-stimeo--currency-input-target", "display");
    root.append(behind);
    await tick();
    input.removeAttribute("data-stimeo--currency-input-target");
    behind.removeAttribute("data-stimeo--currency-input-target");
    await tick();
    startDraft(input);
    input.setAttribute("data-stimeo--currency-input-target", "display");
    await tick();
    expect(input.value).toBe("1,234.00５");
    expect(submitted()).toBe("1234");
    expect(events).toEqual([]);
  });

  // The display rendered last leaves while a focused display behind it is in charge and
  // held, so nothing renders it meanwhile; it then returns focused, first again, showing
  // text the controller did not render.
  it.each([
    ["an unheard draft", (input: HTMLInputElement) => startDraft(input), "1,234.00５"],
    [
      "text a script wrote",
      (input: HTMLInputElement) => {
        input.value = "2.5";
      },
      "2.5",
    ],
  ])(
    "holds the display rendered last when it returns showing %s after a held display stood in for it",
    async (_name, meanwhile, shown) => {
      const { root, input, events } = await bootAccepted();
      const behind = document.createElement("input");
      behind.value = "2";
      behind.setAttribute("data-stimeo--currency-input-target", "display");
      root.append(behind);
      await tick();
      behind.focus();
      input.removeAttribute("data-stimeo--currency-input-target");
      await tick();
      expect(submitted()).toBe("1234");
      input.focus();
      meanwhile(input);
      input.setAttribute("data-stimeo--currency-input-target", "display");
      await tick();
      expect(input.value).toBe(shown);
      expect(hidden().value).toBe("1234");
      expect(spoken().textContent).toBe("1,234.00");
      expect(events).toEqual([]);
    },
  );

  // The controller element leaves the document with its display, so Stimulus disconnects the
  // controller and then lets the display target go while the display is still in the
  // controller element's subtree. The target is taken off while the controller element is
  // away, and the same instance comes back with no display. Re-inserting drops focus, so the
  // field is focused again before the draft starts, unheard, and the target returns.
  it("holds the display rendered last when it gets its target back after leaving the document with the controller element", async () => {
    const { root, input, events, controller } = await bootAccepted();
    const form = query<HTMLFormElement>("#late-form");
    root.remove();
    await tick();
    input.removeAttribute("data-stimeo--currency-input-target");
    await tick();
    form.append(root);
    await tick();
    expect(application?.getControllerForElementAndIdentifier(root, "stimeo--currency-input")).toBe(
      controller,
    );
    input.focus();
    startDraft(input);
    input.setAttribute("data-stimeo--currency-input-target", "display");
    await tick();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("1,234.00５");
    expect(submitted()).toBe("1234");
    expect(spoken().textContent).toBe("1,234.00");
    expect(events).toEqual([]);
    composeDraft(input, "1,234.00５６");
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(input.value).toBe("1,234.0056");
    expect(submitted()).toBe("1234.0056");
    expect(events).toEqual(["change:1234.0056"]);
  });

  /**
   * A Turbo 8 morph of the focused display. When `moved`, Idiomorph first moves it with
   * `moveBefore`, which keeps focus; Stimulus delivers that move in the mutation batch
   * queued at the move, as the display target leaving and returning while the element is
   * already back in place. happy-dom has no `moveBefore`, so the batch is the two target
   * callbacks in a microtask queued first. The morph then announces the server's `value`,
   * writes it unless the announcement is cancelled, and dispatches `turbo:morph-element`.
   */
  const morphFocusedDisplay = (
    input: HTMLInputElement,
    controller: CurrencyInputController,
    server: string,
    moved: boolean,
  ) => {
    if (moved) {
      queueMicrotask(() => {
        controller.displayTargetDisconnected(input);
        controller.displayTargetConnected(input);
      });
    }
    const notice = new CustomEvent("turbo:before-morph-attribute", {
      bubbles: true,
      cancelable: true,
      detail: { attributeName: "value", mutationType: "update" },
    });
    if (input.dispatchEvent(notice)) {
      input.setAttribute("value", server);
      input.value = server;
    }
    input.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
  };

  it.each([
    ["moved with moveBefore", true],
    ["not moved", false],
  ])(
    "reads the amount a morph writes to a focused display showing this controller's rendering, %s",
    async (_name, moved) => {
      const { input, events, controller } = await bootAccepted();
      expect(input.value).toBe("1,234.00");
      morphFocusedDisplay(input, controller, "2.5", moved);
      await tick();
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe("2.5");
      expect(hidden().value).toBe("2.5");
      expect(submitted()).toBe("2.5");
      expect(spoken().textContent).toBe("2.50");
      expect(events).toEqual(["reconcile:2.5"]);
      input.blur();
      expect(input.value).toBe("2.50");
      expect(submitted()).toBe("2.5");
      expect(events).toEqual(["reconcile:2.5"]);
    },
  );

  it("does not adopt an unknown draft when an input that names no inputType reports it", async () => {
    const { input, events } = await boot("reconnect");
    edit(input, "1234.0056", "", false);
    expect(input.value).toBe("1234.0056");
    expect(submitted()).toBe("1234");
    expect(events).toEqual([]);
    edit(input, "1234.0056");
    expect(input.value).toBe("1,234.0056");
    expect(events).toEqual(["change:1234.0056"]);
  });

  it("does not round a focused arrival when the previous display ends with held rounding", async () => {
    const { input, events, controller, root } = await boot("reconnect");
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input, "1,234.00５");
    controller.format();
    const successor = document.createElement("input");
    successor.value = "2.3456";
    successor.setAttribute("data-stimeo--currency-input-target", "display");
    successor.setAttribute("data-action", input.getAttribute("data-action") ?? "");
    root.prepend(successor);
    successor.focus();
    await tick();
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(successor.value).toBe("2.3456");
    expect(submitted()).toBe("1234");
    expect(events).toEqual([]);
    edit(successor, "2.34567");
    expect(submitted()).toBe("2.34567");
    expect(events).toEqual(["change:2.34567"]);
  });

  it("holds a blur before the end and rounds the confirmed text in one reading", async () => {
    const { input, events } = await boot("reconnect", true);
    input.blur();
    await tick();
    input.value = "1,234.00５６";
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(input.value).toBe("1,234.01");
    expect(submitted()).toBe("1234.01");
    expect(events).toEqual(["change:1234.01"]);
  });

  it("keeps an end followed by blur as a confirmation and then a distinct rounding", async () => {
    const { input, events } = await boot("reconnect", true);
    input.value = "1,234.00５６";
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(events).toEqual(["change:1234.0056"]);
    input.blur();
    expect(submitted()).toBe("1234.01");
    expect(events).toEqual(["change:1234.0056", "change:1234.01"]);
  });

  it.each(["ordinary input", "new composition"])(
    "does not carry an unheard blur into the next %s",
    async (next) => {
      const { input, events } = await boot("reconnect", true);
      input.blur();
      await tick();
      input.focus();
      if (next === "new composition") {
        input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        composeDraft(input, "1,234.00５６７");
        input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      } else edit(input, "1234.00567");
      expect(input.value).toBe("1,234.00567");
      expect(submitted()).toBe("1234.00567");
      expect(events).toEqual(["change:1234.00567"]);
    },
  );

  it("does not mistake a confirmation echo for a new unsettled entry", async () => {
    const { input, events, root, controller } = await boot("reconnect", true);
    input.value = "1,234.00５６";
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertFromComposition" }),
    );
    root.setAttribute("data-stimeo--currency-input-precision-value", "0");
    controller.precisionValueChanged();
    expect(spoken().textContent).toBe("1,234");
    expect(events).toEqual(["change:1234.0056"]);
  });

  it("restores only an existing confirmed base and keeps value morphs out of a pending display", async () => {
    const { input, controller, events } = await boot("reconnect", true);
    hidden().value = "";
    spoken().textContent = "";
    controller.fieldTargetConnected();
    controller.srValueTargetConnected();
    expect(submitted()).toBe("1234");
    expect(spoken().textContent).toBe("1,234.00");
    const morph = new CustomEvent("turbo:before-morph-attribute", {
      bubbles: true,
      cancelable: true,
      detail: { attributeName: "value" },
    });
    expect(input.dispatchEvent(morph)).toBe(false);
    expect(input.value).toBe("1,234.00５");
    expect(events).toEqual([]);
  });

  it("compares a cancelled unknown composition to the last accepted amount", async () => {
    const { input, events } = await boot("reconnect", true);
    input.value = "1,234.00";
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(input.value).toBe("1,234.00");
    expect(submitted()).toBe("1234");
    expect(events).toEqual([]);
  });

  it("keeps the old separators until the unknown entry confirms before taking new declarations", async () => {
    const { input, events, root, controller } = await boot("reconnect", true);
    root.setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller.localeValueChanged();
    expect(input.value).toBe("1,234.00５");
    expect(submitted()).toBe("1234");
    input.value = "1,234.00５６";
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(input.value).toBe("1.234,0056");
    expect(submitted()).toBe("1234.0056");
    expect(events).toEqual(["change:1234.0056"]);
  });

  it("does not give a successor the pending text or rounding of the previous display", async () => {
    const { input, events, root } = await boot("reconnect", true);
    input.blur();
    const successor = document.createElement("input");
    successor.setAttribute("data-stimeo--currency-input-target", "display");
    successor.setAttribute("data-action", input.getAttribute("data-action") ?? "");
    successor.value = "2.3456";
    root.append(successor);
    await tick();
    root.prepend(successor);
    successor.focus();
    edit(successor, "2.34567");
    await tick();
    expect(successor.value).toBe("2.34567");
    expect(submitted()).toBe("2.34567");
    expect(events).toEqual(["change:2.34567"]);
    successor.blur();
    expect(submitted()).toBe("2.35");
    expect(events).toEqual(["change:2.34567", "change:2.35"]);
  });

  it("protects a newly selected target even when blur beats its connection callback", async () => {
    const { input, events, root, controller } = await boot("reconnect", true);
    const successor = document.createElement("input");
    successor.setAttribute("data-stimeo--currency-input-target", "display");
    successor.value = "2.345６";
    root.prepend(successor);
    successor.focus();
    successor.blur();
    successor.addEventListener("blur", (event) => controller.format(event));
    successor.dispatchEvent(new FocusEvent("blur"));
    await tick();
    expect(successor.value).toBe("2.345６");
    expect(input.value).toBe("1,234.00５");
    expect(submitted()).toBe("1234");
    expect(events).toEqual([]);
  });

  it("protects a focused target before its connection callback hears a value morph", async () => {
    const { root, events } = await boot("reconnect");
    const arriving = document.createElement("input");
    arriving.value = "2.345６";
    root.prepend(arriving);
    arriving.focus();
    arriving.setAttribute("data-stimeo--currency-input-target", "display");
    const morph = new CustomEvent("turbo:before-morph-attribute", {
      bubbles: true,
      cancelable: true,
      detail: { attributeName: "value" },
    });
    expect(arriving.dispatchEvent(morph)).toBe(false);
    expect(arriving.value).toBe("2.345６");
    expect(submitted()).toBe("1234");
    expect(events).toEqual([]);
    await tick();
  });

  it("keeps a sink callback from reading a focused arrival before its display callback", async () => {
    const { root, input, events, controller } = await boot("reconnect");
    edit(input, "1234");
    const arriving = document.createElement("input");
    arriving.value = "2.345６";
    arriving.setAttribute("data-stimeo--currency-input-target", "display");
    root.prepend(arriving);
    arriving.focus();
    controller.fieldTargetConnected();
    controller.srValueTargetConnected();
    expect(arriving.value).toBe("2.345６");
    expect(submitted()).toBe("1234");
    expect(spoken().textContent).toBe("1,234.00");
    expect(events).toEqual([]);
    await tick();
  });
  it("keeps a missed-start input on an accepted display pending when formatting is requested", async () => {
    const { input, events, controller } = await boot("reconnect");
    edit(input, "1234");
    edit(input, "1,234.00５", "insertCompositionText", true);
    input.setSelectionRange(3, 6);
    controller.format();
    expect(input.value).toBe("1,234.00５");
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 6]);
    expect(submitted()).toBe("1234");
    expect(events).toEqual([]);
    input.value = "1,234.00５６";
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(input.value).toBe("1,234.01");
    expect(submitted()).toBe("1234.01");
    expect(events).toEqual(["change:1234.01"]);
  });

  it("applies held declarations after an ordinary input releases the pending entry", async () => {
    const { input, events, root, controller } = await boot("reconnect");
    root.setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    controller.localeValueChanged();
    edit(input, "1,234.0056");
    expect(input.value).toBe("1.234,0056");
    expect(submitted()).toBe("1234.0056");
    expect(spoken().textContent).toBe("1.234,01");
    expect(events).toEqual(["change:1234.0056"]);
  });

  it("repairs accepted output during a pending formatting request without adopting the draft", async () => {
    const { input, events, controller } = await boot("reconnect");
    hidden().value = "";
    spoken().textContent = "";
    controller.format();
    expect(input.value).toBe("1234.005");
    expect(submitted()).toBe("1234");
    expect(spoken().textContent).toBe("1,234.00");
    expect(events).toEqual([]);
  });

  it("allows another field's value morph while protecting the pending owner's value", async () => {
    const { input, root, events } = await boot("reconnect");
    const other = document.createElement("input");
    other.value = "7";
    root.append(other);
    const makeMorph = () =>
      new CustomEvent("turbo:before-morph-attribute", {
        bubbles: true,
        cancelable: true,
        detail: { attributeName: "value" },
      });
    const allowed = other.dispatchEvent(makeMorph());
    if (allowed) other.value = "777";
    expect(allowed).toBe(true);
    expect(other.value).toBe("777");
    expect(input.dispatchEvent(makeMorph())).toBe(false);
    expect(input.value).toBe("1234.005");
    expect(submitted()).toBe("1234");
    expect(events).toEqual([]);
  });

  it("lets a morph change the pending display's other attributes", async () => {
    const { input, events } = await boot("reconnect");
    const morph = (attributeName: string) =>
      new CustomEvent("turbo:before-morph-attribute", {
        bubbles: true,
        cancelable: true,
        detail: { attributeName },
      });
    const allowed = input.dispatchEvent(morph("aria-invalid"));
    if (allowed) input.setAttribute("aria-invalid", "true");
    expect(allowed).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.dispatchEvent(morph("value"))).toBe(false);
    expect(input.value).toBe("1234.005");
    expect(submitted()).toBe("1234");
    expect(events).toEqual([]);
  });

  it("holds a focused arrival when format is called directly before its target callback", async () => {
    const { input, events, root, controller } = await boot("reconnect");
    edit(input, "1234");
    const arriving = document.createElement("input");
    arriving.value = "2.345６";
    arriving.setAttribute("data-stimeo--currency-input-target", "display");
    root.prepend(arriving);
    arriving.focus();
    controller.format();
    expect(arriving.value).toBe("2.345６");
    expect(submitted()).toBe("1234");
    expect(spoken().textContent).toBe("1,234.00");
    expect(events).toEqual([]);
    await tick();
  });

  it("resumes known-composition reconciliation after an unknown entry starts a new conversion", async () => {
    const { input, events, root } = await boot("reconnect");
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input, "1,234.00５");
    input.blur();
    input.value = "2.3456";
    root.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();
    expect(input.value).toBe("2.35");
    expect(submitted()).toBe("2.35");
    expect(events).toEqual(["reconcile:2.35"]);
  });

  it("drops an unknown owner's rounding before an unfocused successor is accepted", async () => {
    const { input, events, root } = await boot("reconnect");
    input.blur();
    const successor = document.createElement("input");
    successor.value = "2.3456";
    successor.setAttribute("data-stimeo--currency-input-target", "display");
    successor.setAttribute("data-action", input.getAttribute("data-action") ?? "");
    root.prepend(successor);
    await tick();
    expect(submitted()).toBe("2.35");
    successor.focus();
    edit(successor, "2.3456");
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(successor.value).toBe("2.3456");
    expect(submitted()).toBe("2.3456");
    expect(events).toEqual(["reconcile:2.35", "change:2.3456"]);
  });

  it("prepares the initial locale before a fresh focused entry confirms", async () => {
    const { input, events } = await boot("fresh", false, "server-amount", "1234", "de-DE");
    edit(input, "1.234,00５６", "insertCompositionText", false);
    expect(submitted()).toBe("server-amount");
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(input.value).toBe("1.234,0056");
    expect(submitted()).toBe("1234.0056");
    expect(events).toEqual(["change:1234.0056"]);
  });

  it("keeps a known composing display unchanged when another display ends", async () => {
    const { input, events, root, controller } = await boot("reconnect");
    edit(input, "1234");
    const behind = document.createElement("input");
    behind.value = "2";
    behind.setAttribute("data-stimeo--currency-input-target", "display");
    root.append(behind);
    await tick();
    input.focus();
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input, "1,234.0056");
    controller.format();
    behind.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(input.value).toBe("1,234.0056");
    expect(submitted()).toBe("1234");
    expect(events).toEqual([]);
  });

  it.each(["compositionend", "ordinary input"])(
    "reads the first focused arrival with declarations changed while no display existed (%s)",
    async (confirmation) => {
      document.body.innerHTML = `<form id="late-form"><div id="late-root"
        data-controller="stimeo--currency-input" data-stimeo--currency-input-locale-value="en-US">
        <input id="late-hidden" type="hidden" name="amount" value="server-amount"
          data-stimeo--currency-input-target="field">
        <span id="late-spoken" data-stimeo--currency-input-target="srValue">server text</span>
        </div></form>`;
      application = Application.start();
      application.register("stimeo--currency-input", CurrencyInputController);
      await tick();
      const root = query<HTMLElement>("#late-root");
      root.setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
      await tick();
      const events: string[] = [];
      for (const kind of ["change", "reconcile"]) {
        root.addEventListener(`stimeo--currency-input:${kind}`, (event) => {
          events.push(`${kind}:${(event as CustomEvent<{ value: number | null }>).detail.value}`);
        });
      }
      const input = document.createElement("input");
      input.setAttribute("data-action", "input->stimeo--currency-input#onInput");
      root.prepend(input);
      input.focus();
      input.value = "1.234,00５";
      input.setSelectionRange(3, 6);
      input.setAttribute("data-stimeo--currency-input-target", "display");
      await tick();
      expect(input.value).toBe("1.234,00５");
      expect([input.selectionStart, input.selectionEnd]).toEqual([3, 6]);
      expect(submitted()).toBe("server-amount");
      expect(spoken().textContent).toBe("server text");
      expect(events).toEqual([]);
      if (confirmation === "compositionend") {
        input.value = "1.234,0056";
        input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      } else edit(input, "1.234,0056");
      expect(input.value).toBe("1.234,0056");
      expect(submitted()).toBe("1234.0056");
      expect(spoken().textContent).toBe("1.234,01");
      expect(events).toEqual(["change:1234.0056"]);
    },
  );

  it.each(["fresh", "accepted value", "accepted empty"] as const)(
    "keeps the right separators when blur precedes a locale-changed target callback (%s)",
    async (mode) => {
      document.body.innerHTML = `<form id="late-form"><div id="late-root"
        data-controller="stimeo--currency-input" data-stimeo--currency-input-locale-value="en-US">
        <input id="late-amount" aria-label="Amount" value="${mode === "accepted empty" ? "" : "1234"}"
          ${mode === "fresh" ? "" : 'data-stimeo--currency-input-target="display"'}
          data-action="input->stimeo--currency-input#onInput blur->stimeo--currency-input#format">
        <input id="late-hidden" type="hidden" name="amount" value="server-amount"
          data-stimeo--currency-input-target="field">
        <span id="late-spoken" data-stimeo--currency-input-target="srValue">server text</span>
        </div></form>`;
      application = Application.start();
      application.register("stimeo--currency-input", CurrencyInputController);
      await tick();
      const root = query<HTMLElement>("#late-root");
      const input = query<HTMLInputElement>("#late-amount");
      const controller = application.getControllerForElementAndIdentifier(
        root,
        "stimeo--currency-input",
      ) as CurrencyInputController;
      input.removeAttribute("data-stimeo--currency-input-target");
      await tick();
      root.setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
      await tick();
      const events: string[] = [];
      for (const kind of ["change", "reconcile"]) {
        root.addEventListener(`stimeo--currency-input:${kind}`, (event) => {
          events.push(`${kind}:${(event as CustomEvent<{ value: number | null }>).detail.value}`);
        });
      }
      const held = { hidden: hidden().value, spoken: spoken().textContent };
      const order: string[] = [];
      const connected = controller.displayTargetConnected.bind(controller);
      controller.displayTargetConnected = (target) => {
        order.push("target");
        connected(target);
      };
      const format = controller.format.bind(controller);
      controller.format = (event) => {
        order.push("format");
        format(event);
      };
      input.value = mode === "fresh" ? "1.234,005" : "1,234.005";
      input.focus();
      input.setSelectionRange(3, 6);
      const draft = input.value;
      input.setAttribute("data-stimeo--currency-input-target", "display");
      input.blur();
      expect(order).toEqual(["format"]);
      expect(input.value).toBe(draft);
      await tick();
      expect(order).toEqual(["format", "target"]);
      expect(input.value).toBe(draft);
      expect([input.selectionStart, input.selectionEnd]).toEqual([3, 6]);
      expect(hidden().value).toBe(held.hidden);
      expect(submitted()).toBe(held.hidden);
      expect(spoken().textContent).toBe(held.spoken);
      expect(events).toEqual([]);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      edit(input, `${input.value}6`, "insertText", false);
      expect.soft(input.value).toBe("1.234,0056");
      expect.soft(hidden().value).toBe("1234.0056");
      expect.soft(submitted()).toBe("1234.0056");
      expect.soft(spoken().textContent).toBe("1.234,01");
      expect.soft(events).toEqual(["change:1234.0056"]);
    },
  );

  it("keeps the first pending separators when declarations change again before confirmation", async () => {
    const { input, root, events } = await boot("fresh", false, "server-amount", "1234", "de-DE");
    input.value = "1.234,005";
    root.setAttribute("data-stimeo--currency-input-locale-value", "en-US");
    await tick();
    input.blur();
    await tick();
    expect(input.value).toBe("1.234,005");
    expect(submitted()).toBe("server-amount");
    expect(spoken().textContent).toBe("server text");
    expect(events).toEqual([]);
    input.focus();
    edit(input, "1.234,0056");
    expect(input.value).toBe("1,234.0056");
    expect(submitted()).toBe("1234.0056");
    expect(events).toEqual(["change:1234.0056"]);
  });

  it("prepares formatters for a fresh focused entry using the runtime locale", async () => {
    const { input, events } = await boot("fresh", false, "server-amount", "1234", "");
    expect(submitted()).toBe("server-amount");
    edit(input, "12");
    expect(input.value).toBe(new Intl.NumberFormat().format(12));
    expect(submitted()).toBe("12");
    expect(events).toEqual(["change:12"]);
  });

  it("keeps accepted separators through a focused reconnect with changed declarations", async () => {
    const { input, events, root } = await boot("reconnect");
    edit(input, "1234.0056");
    events.length = 0;
    root.removeAttribute("data-controller");
    await tick();
    root.setAttribute("data-stimeo--currency-input-locale-value", "de-DE");
    root.setAttribute("data-controller", "stimeo--currency-input");
    await tick();
    expect(input.value).toBe("1,234.0056");
    expect(submitted()).toBe("1234.0056");
    expect(spoken().textContent).toBe("1,234.01");
    expect(events).toEqual([]);
    edit(input, "1,234.00567");
    expect(input.value).toBe("1.234,00567");
    expect(submitted()).toBe("1234.00567");
    expect(events).toEqual(["change:1234.00567"]);
  });
});
