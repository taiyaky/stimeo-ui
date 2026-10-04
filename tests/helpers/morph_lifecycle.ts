import { Application, type ControllerConstructor } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClipboardController } from "../../src/controllers/clipboard_controller";
import { ToastController } from "../../src/controllers/toast_controller";
import { disconnectAndStopApplication } from "./stimulus";
import { tick } from "./timing";

export interface MorphFixture {
  id: string;
  controller: ControllerConstructor;
  attrs: string;
  html: string;
  selector: string;
  output: string;
}

/** Retained roots repair derived output without restarting their connected lifetime. */
export function defineMorphRecovery(fixtures: readonly MorphFixture[]): void {
  describe("morph display and lifecycle recovery", () => {
    let application: Application | undefined;
    afterEach(() => {
      if (application) disconnectAndStopApplication(application);
      application = undefined;
      document.documentElement.removeAttribute("data-turbo-preview");
      document.body.innerHTML = "";
      vi.restoreAllMocks();
    });

    for (const fixture of fixtures) {
      for (const origin of ["own", "descendant"] as const) {
        it(`${fixture.id} repairs ${origin} morph ${fixture.output} output silently`, async () => {
          if (fixture.id === "preview-guard")
            document.documentElement.setAttribute("data-turbo-preview", "");
          document.body.innerHTML = `<section id="section"></section><div id="root" data-controller="stimeo--${fixture.id}" ${fixture.attrs}>${fixture.html}</div>`;
          application = Application.start();
          application.register(`stimeo--${fixture.id}`, fixture.controller);
          await tick();
          const root = document.querySelector<HTMLElement>("#root");
          if (!root) throw new Error("Missing root");
          const controller = application.getControllerForElementAndIdentifier(
            root,
            `stimeo--${fixture.id}`,
          );
          if (!controller) throw new Error("Missing controller");
          if (controller instanceof ClipboardController) {
            vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
            await controller.copy();
          }
          if (controller instanceof ToastController) {
            const item = root.querySelector<HTMLElement>("#out");
            item?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
            await tick();
          }
          const descendant =
            root.firstElementChild ?? root.appendChild(document.createElement("span"));
          await tick();
          const output = fixture.selector
            ? root.querySelector<HTMLElement>(fixture.selector)
            : root;
          if (!output) throw new Error("Missing output");
          const read = () =>
            fixture.output === "text" ? output.textContent : output.getAttribute(fixture.output);
          const expected = read();
          expect(expected).not.toBeNull();
          const dispatch = vi.spyOn(controller, "dispatch");
          const connect = vi.spyOn(controller, "connect");
          if (fixture.output === "text") output.textContent = "server fallback";
          else output.removeAttribute(fixture.output);
          expect(read()).not.toBe(expected);
          if (origin === "descendant" && !root.contains(descendant)) root.append(descendant);
          (origin === "own" ? root : descendant).dispatchEvent(
            new Event("turbo:morph-element", { bubbles: true }),
          );
          await tick();
          expect(read()).toBe(expected);
          expect(dispatch).not.toHaveBeenCalled();
          expect(connect).not.toHaveBeenCalled();
          const subscriptions = vi.spyOn(root, "addEventListener");
          controller.disconnect();
          controller.connect();
          const morphSubscription = subscriptions.mock.calls.find(
            ([name]) => name === "turbo:morph-element",
          );
          const options = morphSubscription?.[2];
          const signal = typeof options === "object" ? options?.signal : undefined;
          expect(signal).toBeDefined();
          expect(signal?.aborted).toBe(false);
          controller.disconnect();
          expect(signal?.aborted).toBe(true);
          if (fixture.output === "text") output.textContent = "detached output";
          else output.setAttribute(fixture.output, "detached output");
          root.dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
          await tick();
          expect(read()).toBe("detached output");
        });
      }
    }
  });
}
