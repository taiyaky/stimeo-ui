import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlertDialogController } from "../src/controllers/alert_dialog_controller";
import { DialogController } from "../src/controllers/dialog_controller";
import { query } from "./helpers/dom";
import { keyEvent, typeKey } from "./helpers/keyboard";
import { expectUpperModalOnTop, openUpperModal } from "./helpers/modal_stack";
import { captureStateEvents } from "./helpers/state_events";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/** Modal state and its opener survive replacement and absence of the current dialog target. */
for (const kind of ["dialog", "alert-dialog"] as const) {
  describe(`${kind} target handoff`, () => {
    let application: Application;
    let events: ReturnType<typeof captureStateEvents>;
    const identifier = `stimeo--${kind}`;
    const host = () => query("#host");
    const surface = () => query("#surface");
    const opener = () => query("#opener");
    const instance = () => {
      const controller = application.getControllerForElementAndIdentifier(host(), identifier);
      if (
        !(controller instanceof DialogController) &&
        !(controller instanceof AlertDialogController)
      ) {
        throw new Error("Missing modal controller");
      }
      return controller;
    };
    const replacement = () => {
      const next = document.createElement("div");
      next.id = "surface";
      next.hidden = true;
      next.setAttribute(`data-${identifier}-target`, "dialog");
      next.setAttribute("role", kind === "dialog" ? "dialog" : "alertdialog");
      next.setAttribute("aria-modal", "true");
      next.setAttribute("aria-label", "Decision");
      next.innerHTML = `<button id="first">First</button><button id="least" data-${identifier}-target="initialFocus">Cancel</button>`;
      return next;
    };
    const mount = async (includeSurface = true, authoredHidden = true) => {
      document.body.innerHTML = `<button id="opener">Original opener</button>
        <div id="host" data-controller="${identifier}">
          <button id="trigger" data-${identifier}-target="trigger">Fallback</button>
        </div><p id="background">Background</p>`;
      if (includeSurface) {
        const initial = replacement();
        if (!authoredHidden) initial.removeAttribute("hidden");
        host().append(initial);
      }
      application = Application.start();
      application.register(
        identifier,
        kind === "dialog" ? DialogController : AlertDialogController,
      );
      await tick();
    };
    const invoke = (action: string) => {
      const controller = instance();
      if (action === "Escape") {
        const key = keyEvent("Escape");
        // A missing container leaves document-level Escape ownership with the active trap.
        typeKey(document, key);
        return key.defaultPrevented;
      }
      if (action === "open") controller.open();
      else if (action === "close" && controller instanceof DialogController) controller.close();
      else if (action === "confirm" && controller instanceof AlertDialogController)
        controller.confirm();
      else if (action === "cancel" && controller instanceof AlertDialogController)
        controller.cancel();
      return undefined;
    };
    const close = () => invoke(kind === "dialog" ? "close" : "cancel");
    const preferred = () => query(kind === "dialog" ? "#first" : "#least");

    beforeEach(async () => {
      await mount();
      events = captureStateEvents(
        identifier,
        kind === "dialog" ? ["open", "close"] : ["confirm", "cancel"],
      );
    });
    afterEach(() => {
      events.stop();
      disconnectAndStopApplication(application);
      document.body.innerHTML = "";
      document.body.style.overflow = "";
    });

    const actions =
      kind === "dialog"
        ? ["none", "open", "close", "Escape"]
        : ["none", "open", "confirm", "cancel", "Escape"];
    for (const form of ["settled", "same task", "absent"]) {
      for (const action of actions) {
        it(`preserves state for ${action} during ${form} replacement`, async () => {
          opener().focus();
          instance().open();
          const old = surface();
          const next = replacement();
          events.clear();
          if (form === "absent") {
            old.remove();
            await tick();
          } else {
            old.replaceWith(next);
            if (form === "settled") await tick();
          }
          const consumed = invoke(action);
          if (form === "same task" && action !== "none") {
            expect(next.hidden).toBe(action !== "open");
          }
          if (form === "absent") host().append(next);
          await tick();

          const open = action === "none" || action === "open";
          expect(next.hidden).toBe(!open);
          expect(document.body.style.overflow).toBe(open ? "hidden" : "");
          expect(query("#background").inert).toBe(open);
          expect(document.activeElement).toBe(open ? preferred() : opener());
          expect(events.names()).toEqual(
            open ? [] : [kind === "dialog" ? "close" : action === "confirm" ? "confirm" : "cancel"],
          );
          if (action === "Escape") expect(consumed).toBe(true);
          if (open) close();
        });
      }
    }

    if (kind === "dialog") {
      it("returns the departed dialog before a same-task close is reported", () => {
        instance().open();
        const departed = surface();
        const returned: boolean[] = [];
        host().addEventListener(`${identifier}:close`, () =>
          returned.push(departed.hasAttribute("hidden")),
        );
        departed.replaceWith(replacement());

        close();

        expect(returned).toEqual([true]);
      });
    } else {
      for (const decision of ["confirm", "cancel"]) {
        it(`shows the current dialog before reporting ${decision} during same-task handoff`, () => {
          instance().open();
          const next = replacement();
          const visibility: boolean[] = [];
          host().addEventListener(`${identifier}:${decision}`, () =>
            visibility.push(next.hasAttribute("hidden")),
          );
          surface().replaceWith(next);

          invoke(decision);

          expect(visibility).toEqual([false]);
        });
      }
      it("returns a dialog replaced inside its confirm subscriber before the action returns", () => {
        instance().open();
        const departed = surface();
        const next = replacement();
        host().addEventListener(`${identifier}:confirm`, () => departed.replaceWith(next), {
          once: true,
        });

        invoke("confirm");

        expect(departed.hidden).toBe(true);
        expect(next.hidden).toBe(true);
        expect(document.body.style.overflow).toBe("");
      });
    }

    it("hides a former first dialog that stays a target when an earlier one arrives", async () => {
      opener().focus();
      instance().open();
      const former = surface();
      former.id = "former";
      const next = replacement();
      events.clear();

      former.before(next);
      await tick();

      expect(former.hidden).toBe(true);
      expect(next.hidden).toBe(false);
      expect(document.activeElement).toBe(preferred());
      expect(events.seen).toEqual([]);
      close();
      expect(document.activeElement).toBe(opener());
    });

    it("conceals an authored-visible former first dialog while it remains a target", async () => {
      disconnectAndStopApplication(application);
      await mount(true, false);
      instance().open();
      const former = surface();
      former.id = "former";
      const next = replacement();

      former.before(next);
      await tick();

      expect(former.hasAttribute("hidden")).toBe(true);
      expect(next.hidden).toBe(false);
      close();
      former.removeAttribute(`data-${identifier}-target`);
      await tick();
      expect(former.hasAttribute("hidden")).toBe(false);
    });

    it("keeps the lock through absence and transfers focus on arrival without changing the opener", async () => {
      opener().focus();
      instance().open();
      const next = replacement();
      events.clear();

      surface().remove();
      await tick();
      expect(document.body.style.overflow).toBe("hidden");
      expect(document.activeElement).not.toBe(opener());
      host().append(next);
      await tick();

      expect(next.hidden).toBe(false);
      expect(document.activeElement).toBe(preferred());
      expect(events.seen).toEqual([]);
      close();
      expect(document.activeElement).toBe(opener());
    });

    it("retains a fresh open requested during a temporary gap", async () => {
      opener().focus();
      surface().remove();
      await tick();

      instance().open();

      expect(document.body.style.overflow).toBe("hidden");
      host().append(replacement());
      await tick();
      expect(surface().hidden).toBe(false);
      expect(document.activeElement).toBe(preferred());
      close();
      expect(document.activeElement).toBe(opener());
    });

    it("can close and request another open before its dialog returns", async () => {
      opener().focus();
      instance().open();
      surface().remove();
      await tick();
      close();
      expect(document.body.style.overflow).toBe("");

      instance().open();
      host().append(replacement());
      await tick();

      expect(surface().hidden).toBe(false);
      expect(document.activeElement).toBe(preferred());
      expect(document.body.style.overflow).toBe("hidden");
      close();
      expect(document.activeElement).toBe(opener());
    });

    it("keeps an initial missing-target declaration inert rather than opening a modal", async () => {
      disconnectAndStopApplication(application);
      await mount(false);

      instance().open();
      host().append(replacement());
      await tick();

      expect(surface().hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
      expect(events.seen).toEqual([]);
    });

    if (kind === "dialog") {
      it("takes no modal resources after an open subscriber unloads its controller", () => {
        const controller = instance();
        host().addEventListener(`${identifier}:open`, () => application.unload(identifier), {
          once: true,
        });

        controller.open();

        expect(document.body.style.overflow).toBe("");
        expect(query("#background").inert).toBe(false);
      });

      it("takes no modal resources when an open subscriber hides the dialog", () => {
        host().addEventListener(
          `${identifier}:open`,
          () => {
            surface().hidden = true;
          },
          { once: true },
        );

        instance().open();

        expect(surface().hidden).toBe(true);
        expect(document.body.style.overflow).toBe("");
        expect(query("#background").inert).toBe(false);
      });

      it("continues an open on the dialog its subscriber replaces", () => {
        const next = replacement();
        host().addEventListener(`${identifier}:open`, () => surface().replaceWith(next), {
          once: true,
        });

        instance().open();

        expect(next.hidden).toBe(false);
        expect(document.activeElement).toBe(preferred());
        expect(document.body.style.overflow).toBe("hidden");
      });
    }

    it("keeps a newer modal on top across an absent lower container", async () => {
      opener().focus();
      instance().open();
      const upper = openUpperModal();
      surface().remove();
      await tick();
      expect(upper.operable()).toBe(true);
      expect(document.activeElement).toBe(upper.first);
      expect(document.body.style.overflow).toBe("hidden");
      const next = replacement();

      host().append(next);
      await tick();

      expectUpperModalOnTop(upper, next);
      close();
      expect(document.activeElement).toBe(opener());
    });

    it("closes the lower modal during absence without releasing or refocusing the upper one", async () => {
      opener().focus();
      instance().open();
      const upper = openUpperModal();
      surface().remove();
      await tick();
      events.clear();

      close();
      host().append(replacement());
      await tick();

      expect(surface().hidden).toBe(true);
      expect(events.names()).toEqual([kind === "dialog" ? "close" : "cancel"]);
      expect(document.activeElement).toBe(upper.first);
      expect(upper.operable()).toBe(true);
      expect(document.body.style.overflow).toBe("hidden");
      invoke("Escape");
      expect(upper.escapes()).toBe(1);
      expect(document.activeElement).toBe(opener());
      expect(document.body.style.overflow).toBe("");
    });
  });
}
