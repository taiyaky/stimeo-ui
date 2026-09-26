import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoSubmitController } from "../src/controllers/auto_submit_controller";
import { ClipboardController } from "../src/controllers/clipboard_controller";
import { NumberInputController } from "../src/controllers/number_input_controller";
import { StepIndicatorController } from "../src/controllers/step_indicator_controller";
import { StepperController } from "../src/controllers/stepper_controller";
import { ToastController } from "../src/controllers/toast_controller";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Wiring tests: two controllers registered together, connected only by the
 * `data-action` a consumer writes.
 *
 * Each case is the markup a consumer writes to join the two parts, so what one
 * part dispatches and what the other reads are checked as one wire. Testing one
 * part alone can show that it dispatches a shape, and testing the other that it
 * reads one; only running both at once shows the two shapes actually meet.
 */
describe("composing parts through data-action", () => {
  let application: Application;

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  const start = async (html: string, parts: Array<[string, unknown]>) => {
    document.body.innerHTML = html;
    application = Application.start();
    for (const [identifier, ctor] of parts) {
      application.register(identifier, ctor as typeof ToastController);
    }
    await tick();
  };

  describe("clipboard → toast", () => {
    const markup = (wiring: string) => `
      <div data-controller="stimeo--toast" data-action="${wiring}">
        <div data-controller="stimeo--clipboard"
             data-stimeo--clipboard-text-value="https://example.com"
             data-stimeo--clipboard-copied-label-value="Copied"
             data-stimeo--clipboard-error-label-value="Copy failed">
          <button type="button" data-stimeo--clipboard-target="button"
                  data-action="click->stimeo--clipboard#copy">Copy</button>
        </div>
        <ol data-stimeo--toast-target="list"></ol>
        <template data-stimeo--toast-target="template">
          <li data-stimeo--toast-target="item"><span data-toast-slot="message"></span></li>
        </template>
      </div>`;

    const toasts = () =>
      Array.from(document.querySelectorAll("[data-stimeo--toast-target='list'] li")).map(
        (item) => item.querySelector("[data-toast-slot='message']")?.textContent,
      );

    const copy = async () => {
      document.querySelector<HTMLButtonElement>("button")?.click();
      await tick();
      await tick();
    };

    it("shows the copied wording with no glue code", async () => {
      vi.stubGlobal("navigator", {
        clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
      });
      await start(markup("stimeo--clipboard:copy->stimeo--toast#show"), [
        ["stimeo--toast", ToastController],
        ["stimeo--clipboard", ClipboardController],
      ]);

      await copy();

      expect(toasts()).toEqual(["Copied"]);
    });

    it("shows the failure wording from the same wire", async () => {
      vi.stubGlobal("navigator", {
        clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      });
      await start(markup("stimeo--clipboard:copy->stimeo--toast#show"), [
        ["stimeo--toast", ToastController],
        ["stimeo--clipboard", ClipboardController],
      ]);

      await copy();

      expect(toasts()).toEqual(["Copy failed"]);
    });

    // The event leaves the part that dispatched it, so a receiver beside it is
    // never on the path; `@window` is what reaches one.
    it("never reaches a receiver that is not an ancestor", async () => {
      vi.stubGlobal("navigator", {
        clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
      });
      await start(
        `<div>
          <div data-controller="stimeo--clipboard"
               data-stimeo--clipboard-text-value="https://example.com">
            <button type="button" data-stimeo--clipboard-target="button"
                    data-action="click->stimeo--clipboard#copy">Copy</button>
          </div>
          <div data-controller="stimeo--toast"
               data-action="stimeo--clipboard:copy->stimeo--toast#show">
            <ol data-stimeo--toast-target="list"></ol>
            <template data-stimeo--toast-target="template">
              <li data-stimeo--toast-target="item"><span data-toast-slot="message"></span></li>
            </template>
          </div>
        </div>`,
        [
          ["stimeo--toast", ToastController],
          ["stimeo--clipboard", ClipboardController],
        ],
      );

      await copy();
      expect(toasts()).toEqual([]);

      document
        .querySelector("[data-controller='stimeo--toast']")
        ?.setAttribute("data-action", "stimeo--clipboard:copy@window->stimeo--toast#show");
      await tick();
      await copy();

      expect(toasts()).toEqual(["Copied"]);
    });
  });

  describe("stepper → step-indicator", () => {
    it("moves the indicator with one data-action and no glue code", async () => {
      await start(
        `<div data-controller="stimeo--stepper" data-stimeo--stepper-index-value="0">
          <ol data-controller="stimeo--step-indicator"
              data-stimeo--step-indicator-index-value="0"
              data-action="stimeo--stepper:change@window->stimeo--step-indicator#setIndex">
            <li data-stimeo--step-indicator-target="step">Cart</li>
            <li data-stimeo--step-indicator-target="step">Shipping</li>
            <li data-stimeo--step-indicator-target="step">Payment</li>
          </ol>
          <ol>
            <li data-stimeo--stepper-target="step">
              <button type="button" data-action="click->stimeo--stepper#goto"
                      data-stimeo--stepper-index-param="0">1</button>
            </li>
            <li data-stimeo--stepper-target="step">
              <button type="button" data-action="click->stimeo--stepper#goto"
                      data-stimeo--stepper-index-param="1">2</button>
            </li>
            <li data-stimeo--stepper-target="step">
              <button type="button" data-action="click->stimeo--stepper#goto"
                      data-stimeo--stepper-index-param="2">3</button>
            </li>
          </ol>
        </div>`,
        [
          ["stimeo--stepper", StepperController],
          ["stimeo--step-indicator", StepIndicatorController],
        ],
      );
      const indicatorSteps = () =>
        Array.from(
          document.querySelectorAll<HTMLElement>("[data-stimeo--step-indicator-target='step']"),
        ).map((step) => step.dataset.state);

      expect(indicatorSteps()).toEqual(["current", "upcoming", "upcoming"]);

      document
        .querySelectorAll<HTMLButtonElement>("[data-stimeo--stepper-index-param]")[2]
        ?.click();
      await tick();

      expect(indicatorSteps()).toEqual(["complete", "complete", "current"]);
      expect(
        document
          .querySelectorAll("[data-stimeo--step-indicator-target='step']")[2]
          ?.getAttribute("aria-current"),
      ).toBe("step");
    });
  });

  describe("number-input → auto-submit", () => {
    it("submits on a stepped value, through the native events the widget reports", async () => {
      await start(
        `<form data-controller="stimeo--auto-submit"
               data-stimeo--auto-submit-debounce-value="0"
               data-action="change->stimeo--auto-submit#submit">
          <div data-controller="stimeo--number-input"
               data-stimeo--number-input-min-value="0"
               data-stimeo--number-input-max-value="10"
               data-stimeo--number-input-step-value="1">
            <input type="number" name="quantity" value="1" aria-label="Quantity"
                   data-stimeo--number-input-target="input"
                   data-action="change->stimeo--number-input#onInput
                                keydown->stimeo--number-input#onKeydown" />
            <button type="button" aria-label="Increase" tabindex="-1"
                    data-stimeo--number-input-target="increment"
                    data-action="click->stimeo--number-input#increment">+</button>
          </div>
        </form>`,
        [
          ["stimeo--auto-submit", AutoSubmitController],
          ["stimeo--number-input", NumberInputController],
        ],
      );
      const form = document.querySelector("form") as HTMLFormElement;
      form.requestSubmit = vi.fn();
      const submits: unknown[] = [];
      form.addEventListener("stimeo--auto-submit:submit", (event) => {
        submits.push((event as CustomEvent).detail.trigger);
      });

      document
        .querySelector<HTMLButtonElement>("[data-stimeo--number-input-target='increment']")
        ?.click();
      await tick();

      expect(document.querySelector<HTMLInputElement>("[name='quantity']")?.value).toBe("2");
      expect(submits).toHaveLength(1);
    });
  });
});
