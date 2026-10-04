import { Application } from "@hotwired/stimulus";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CharacterCounterController } from "../src/controllers/character_counter_controller";
import { FormFieldController } from "../src/controllers/form_field_controller";
import { separateCopy } from "./helpers/separate_copy";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * A form field and a character counter on one control, each with its own `aria-invalid`.
 *
 * The counter holds `"true"` while the text is over its limit; the field holds `"true"` while
 * it reports an error and `"false"` otherwise. The control is invalid while either says so,
 * whichever of the two elements wraps the other: on a live page, on a first load whose text is
 * already over the limit, on a page restored from the cache, and after the page puts the
 * server's value back. The two controllers are imported together, as the barrel brings them,
 * and from their own entries, each of which runs its own copy of the lease.
 */
interface Pair {
  readonly FormField: typeof FormFieldController;
  readonly Counter: typeof CharacterCounterController;
}

const SOURCES: ReadonlyArray<readonly [string, () => Promise<Pair>]> = [
  [
    "imported together",
    async () => ({ FormField: FormFieldController, Counter: CharacterCounterController }),
  ],
  [
    "imported from their own entries",
    async () => {
      const field = await separateCopy(() => import("../src/controllers/form_field_controller"));
      const counter = await separateCopy(
        () => import("../src/controllers/character_counter_controller"),
      );
      return { FormField: field.FormFieldController, Counter: counter.CharacterCounterController };
    },
  ],
];

describe.each(SOURCES)("a form field and a character counter on one control, %s", (_, load) => {
  let application: Application;
  let pair: Pair;

  beforeAll(async () => {
    pair = await load();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const SHOWN_ERROR = `<p id="ff-error" data-stimeo--form-field-target="error">Too long</p>`;
  const HIDDEN_ERROR = `<p id="ff-error" hidden data-stimeo--form-field-target="error"></p>`;
  const counter = (inner: string) =>
    `<div data-controller="stimeo--character-counter" data-stimeo--character-counter-max-value="5">${inner}<span data-stimeo--character-counter-target="output"></span></div>`;
  const field = (inner: string, error: string) =>
    `<div id="ff" data-controller="stimeo--form-field">${inner}${error}</div>`;
  const control = (text: string) =>
    `<textarea id="t" aria-invalid="false" data-stimeo--character-counter-target="input" data-stimeo--form-field-target="control">${text}</textarea>`;
  const NESTINGS: ReadonlyArray<readonly [string, (text: string, error: string) => string]> = [
    ["the field wrapping the counter", (text, error) => field(counter(control(text)), error)],
    ["the counter wrapping the field", (text, error) => counter(field(control(text), error))],
  ];

  const register = (app: Application) => {
    app.register("stimeo--form-field", pair.FormField);
    app.register("stimeo--character-counter", pair.Counter);
  };
  const textarea = () => document.getElementById("t") as HTMLTextAreaElement;
  const invalid = () => textarea().getAttribute("aria-invalid");
  const formField = () =>
    application.getControllerForElementAndIdentifier(
      document.getElementById("ff") as HTMLElement,
      "stimeo--form-field",
    ) as FormFieldController;
  /** Types `text` into the control; its default value follows, so a copy carries the text. */
  const type = async (text: string) => {
    textarea().textContent = text;
    textarea().value = text;
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
  };
  const mount = async (markup: string) => {
    document.body.innerHTML = markup;
    application = Application.start();
    register(application);
    await tick();
  };
  const restore = async () => {
    application = await restoreFromCache(application, register);
  };
  const giveUp = async () => {
    textarea().removeAttribute("data-stimeo--form-field-target");
    await tick();
  };
  /** Puts the server's `aria-invalid="false"` back and drops the records, as a Turbo morph does. */
  const putServerValueBack = async () => {
    for (const name of textarea().getAttributeNames()) {
      if (name.endsWith("-lease")) textarea().removeAttribute(name);
    }
    textarea().setAttribute("aria-invalid", "false");
    await tick();
  };

  for (const [nesting, markup] of NESTINGS) {
    describe(nesting, () => {
      it("stays invalid while the field reports an error, once the text is back under the limit", async () => {
        await mount(markup("", HIDDEN_ERROR));
        await type("too long");
        formField().setError("Too long");
        await tick();

        await type("ok");
        expect(invalid()).toBe("true");
        formField().clearError();
        await tick();

        expect(invalid()).toBe("false");
      });

      it("stays invalid while the text is over the limit, though the field reports and clears an error meanwhile", async () => {
        await mount(markup("", HIDDEN_ERROR));
        await type("too long");
        formField().setError("Too long");
        await tick();

        formField().clearError();
        await tick();
        expect(invalid()).toBe("true");
        await type("ok");

        expect(invalid()).toBe("false");
      });

      it("stays invalid while the text is over the limit, once the field gives the control up", async () => {
        await mount(markup("", HIDDEN_ERROR));
        await type("too long");
        formField().setError("Too long");
        await tick();

        await giveUp();
        expect(invalid()).toBe("true");
        await type("ok");

        expect(invalid()).toBe("false");
      });

      it("is invalid on a first load whose text is over the limit", async () => {
        await mount(markup("too long", HIDDEN_ERROR));

        expect(invalid()).toBe("true");
        await type("ok");

        expect(invalid()).toBe("false");
      });

      it("stays invalid on a first load with a shown error, once the text is back under the limit", async () => {
        await mount(markup("too long", SHOWN_ERROR));
        expect(invalid()).toBe("true");

        await type("ok");

        expect(invalid()).toBe("true");
      });

      it("is invalid on a page restored while the text was over the limit", async () => {
        await mount(markup("", HIDDEN_ERROR));
        await type("too long");

        await restore();
        expect(invalid()).toBe("true");
        await type("ok");

        expect(invalid()).toBe("false");
      });

      it("stays invalid on a restored page while the field reports an error, once the text is back under the limit", async () => {
        await mount(markup("", HIDDEN_ERROR));
        await type("too long");
        formField().setError("Too long");
        await tick();

        await restore();
        expect(invalid()).toBe("true");
        await type("ok");

        expect(invalid()).toBe("true");
      });

      it("stays invalid on a restored page while the text is over the limit, once the field gives the control up", async () => {
        await mount(markup("", HIDDEN_ERROR));
        await type("too long");
        formField().setError("Too long");
        await tick();

        await restore();
        await giveUp();

        expect(invalid()).toBe("true");
      });

      it("is invalid once the field reports an error after the page put the server's value back over the limit", async () => {
        await mount(markup("", HIDDEN_ERROR));
        await type("too long");
        await putServerValueBack();

        formField().setError("Too long");
        await tick();
        expect(invalid()).toBe("true");
        await type("ok");
        expect(invalid()).toBe("true");
        formField().clearError();
        await tick();

        expect(invalid()).toBe("false");
      });
    });
  }
});
