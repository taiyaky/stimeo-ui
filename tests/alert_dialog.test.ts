import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlertDialogController } from "../src/controllers/alert_dialog_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { typeKey } from "./helpers/keyboard";
import { expectUpperModalOnTop, openUpperModal, TARGET_SWAPS } from "./helpers/modal_stack";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link AlertDialogController}: the APG alert-dialog
 * contract — initial focus on the least-destructive action, focus trap, no
 * backdrop close, and confirm/cancel events (cancel tagged user vs. escape).
 */

describe("AlertDialogController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <p id="background">Background content</p>
      <div data-controller="stimeo--alert-dialog">
        <button id="trigger" data-stimeo--alert-dialog-target="trigger"
                data-action="stimeo--alert-dialog#open">Delete…</button>
        <div data-stimeo--alert-dialog-target="dialog" role="alertdialog"
             aria-modal="true" aria-labelledby="ad-title" aria-describedby="ad-desc"
             hidden>
          <h2 id="ad-title">Delete this item?</h2>
          <p id="ad-desc">This cannot be undone.</p>
          <button id="cancel" data-stimeo--alert-dialog-target="initialFocus"
                  data-action="stimeo--alert-dialog#cancel">Cancel</button>
          <button id="confirm" data-action="stimeo--alert-dialog#confirm">Delete</button>
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--alert-dialog", AlertDialogController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    document.body.style.overflow = "";
  });

  const trigger = () => document.getElementById("trigger") as HTMLButtonElement;
  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--alert-dialog']") as HTMLElement;
  const dialog = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--alert-dialog-target='dialog']",
    ) as HTMLElement;

  it("starts hidden", () => {
    expect(dialog().hidden).toBe(true);
  });

  it("keeps an open alert dialog open through a morph that puts the server's hidden back", async () => {
    trigger().click();
    dialog().setAttribute("hidden", "");
    dialog().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();

    expect(dialog().hidden).toBe(false);
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("keeps a closed alert dialog closed through a morph that drops its hidden", async () => {
    dialog().removeAttribute("hidden");
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();

    expect(dialog().hidden).toBe(true);
  });

  it("writes nothing after a morph once disconnected", async () => {
    application.unload("stimeo--alert-dialog");
    dialog().removeAttribute("hidden");
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();

    expect(dialog().hidden).toBe(false);
  });

  it("opens, focuses the initialFocus target, and locks body scroll", () => {
    trigger().focus();
    trigger().click();
    expect(dialog().hidden).toBe(false);
    expect(document.activeElement).toBe(document.getElementById("cancel"));
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("does NOT close when its own element (backdrop area) is clicked", () => {
    trigger().click();
    dialog().click();
    expect(dialog().hidden).toBe(false); // alert dialogs never dismiss on backdrop
  });

  it("confirm closes and dispatches the confirm event", () => {
    const events: Event[] = [];
    root().addEventListener("stimeo--alert-dialog:confirm", (e) => events.push(e));
    trigger().focus();
    trigger().click();
    document.getElementById("confirm")?.click();
    expect(events).toHaveLength(1);
    expect(dialog().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("cancel closes and dispatches cancel with reason 'user'", () => {
    const reasons: string[] = [];
    root().addEventListener("stimeo--alert-dialog:cancel", (e) => {
      reasons.push((e as CustomEvent).detail.reason);
    });
    trigger().focus();
    trigger().click();
    document.getElementById("cancel")?.click();
    expect(reasons).toEqual(["user"]);
    expect(dialog().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("Escape closes and dispatches cancel with reason 'escape'", () => {
    const reasons: string[] = [];
    root().addEventListener("stimeo--alert-dialog:cancel", (e) => {
      reasons.push((e as CustomEvent).detail.reason);
    });
    trigger().focus();
    trigger().click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(reasons).toEqual(["escape"]);
    expect(dialog().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it("traps Tab focus from the last focusable back to the first", () => {
    trigger().click();
    document.getElementById("confirm")?.focus(); // last
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(document.getElementById("cancel")); // first
  });

  it("takes a Tab that does not wrap and moves to the next focusable itself", () => {
    trigger().click();
    expect(document.activeElement).toBe(document.getElementById("cancel"));
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.getElementById("cancel")?.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.getElementById("confirm"));
  });

  it("marks background siblings inert while open and restores them on close", () => {
    const background = document.getElementById("background") as HTMLElement;
    trigger().click();
    expect(background.inert).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(background.inert).toBe(false);
  });

  it("restores scroll and background when disconnected while open", () => {
    const background = document.getElementById("background") as HTMLElement;
    const root = document.querySelector("[data-controller='stimeo--alert-dialog']") as HTMLElement;
    trigger().click();
    expect(document.body.style.overflow).toBe("hidden");
    const controller = application.getControllerForElementAndIdentifier(
      root,
      "stimeo--alert-dialog",
    );
    controller?.disconnect();
    expect(document.body.style.overflow).toBe("");
    expect(background.inert).toBe(false);
  });

  // Machine-detectable a11y, asserted in the open/modal state.
  it("has no machine-detectable a11y violations while open (modal)", async () => {
    trigger().click();
    await expectNoA11yViolations(document.body);
  });

  // Speech-order regression: role, name, modal state, and the describing
  // message must enter the accessibility tree in order when open.
  it("announces the alertdialog role, name, and message in order when open", async () => {
    trigger().click();
    const phrases = await captureSpeech({ container: dialog(), steps: 4 });
    expect(phrases).toEqual([
      "alertdialog, Delete this item?, This cannot be undone., modal",
      "alertdialog, Delete this item?, This cannot be undone., modal",
      "heading, Delete this item?, level 2",
      "paragraph",
      "This cannot be undone.",
      "end of paragraph",
    ]);
  });

  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--alert-dialog",
    ) as AlertDialogController;

  it("re-opening an already-open dialog is a no-op", () => {
    trigger().click();
    expect(dialog().hidden).toBe(false);
    // Second open() must short-circuit on the isOpen guard (no throw, stays open).
    controller().open();
    expect(dialog().hidden).toBe(false);
  });

  it("confirm and cancel are inert while the dialog is closed", () => {
    const events: string[] = [];
    root().addEventListener("stimeo--alert-dialog:confirm", () => events.push("confirm"));
    root().addEventListener("stimeo--alert-dialog:cancel", () => events.push("cancel"));
    // Never opened → both guard on isOpen and dispatch nothing.
    controller().confirm();
    controller().cancel();
    expect(events).toEqual([]);
  });

  it("releases the global keydown listener on disconnect (Escape becomes a no-op)", () => {
    const reasons: string[] = [];
    root().addEventListener("stimeo--alert-dialog:cancel", (e) => {
      reasons.push((e as CustomEvent).detail.reason);
    });
    trigger().click();
    controller().disconnect();
    // The document-level keydown listener must be gone after teardown: Escape now
    // dispatches nothing (directly detects a listener leak, complementing the
    // scroll/inert restoration asserted above).
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(reasons).toEqual([]);
  });

  it("confirm dispatches with an empty detail (no reason, unlike cancel)", () => {
    let detail: unknown = "unset";
    root().addEventListener("stimeo--alert-dialog:confirm", (e) => {
      detail = (e as CustomEvent).detail;
    });
    trigger().click();
    document.getElementById("confirm")?.click();
    // confirm carries no payload — pins the contract against cancel's { reason }.
    expect(detail).toEqual({});
  });

  it("returns focus to the trigger when nothing was focused before opening", () => {
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    controller().open();
    expect(document.activeElement).toBe(document.getElementById("cancel"));

    controller().cancel();

    expect(dialog().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  // --- Other markup shapes ---

  describe("other markup shapes", () => {
    /** Replaces the shared fixture with `markup` and connects a fresh application. */
    const remount = async (markup: string) => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = markup;
      application = Application.start();
      application.register("stimeo--alert-dialog", AlertDialogController);
      await tick();
    };

    it("starts closed when the markup leaves the dialog visible", async () => {
      await remount(`
        <div data-controller="stimeo--alert-dialog">
          <div data-stimeo--alert-dialog-target="dialog" role="alertdialog"
               aria-modal="true" aria-label="Delete this item?">
            <button data-action="stimeo--alert-dialog#cancel">Cancel</button>
          </div>
        </div>`);

      expect(dialog().hidden).toBe(true);
    });

    it("focuses the initialFocus target on open when it is not the first focusable", async () => {
      await remount(`
        <div data-controller="stimeo--alert-dialog">
          <div data-stimeo--alert-dialog-target="dialog" role="alertdialog"
               aria-modal="true" aria-label="Delete this item?" hidden>
            <button id="confirm" data-action="stimeo--alert-dialog#confirm">Delete</button>
            <button id="cancel" data-stimeo--alert-dialog-target="initialFocus"
                    data-action="stimeo--alert-dialog#cancel">Cancel</button>
          </div>
        </div>`);

      controller().open();

      expect(document.activeElement).toBe(document.getElementById("cancel"));
    });

    it("closes without a trigger when nothing was focused before opening", async () => {
      await remount(`
        <div data-controller="stimeo--alert-dialog">
          <div data-stimeo--alert-dialog-target="dialog" role="alertdialog"
               aria-modal="true" aria-label="Delete this item?" hidden>
            <button id="cancel" data-stimeo--alert-dialog-target="initialFocus"
                    data-action="stimeo--alert-dialog#cancel">Cancel</button>
          </div>
        </div>`);
      const reasons: string[] = [];
      root().addEventListener("stimeo--alert-dialog:cancel", (e) => {
        reasons.push((e as CustomEvent).detail.reason);
      });
      (document.activeElement as HTMLElement | null)?.blur();
      expect(document.activeElement).toBe(document.body);
      controller().open();

      expect(() => controller().cancel()).not.toThrow();
      expect(reasons).toEqual(["user"]);
      expect(dialog().hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
    });

    it("open does nothing without a dialog target", async () => {
      await remount(`
        <p id="background">Background content</p>
        <div data-controller="stimeo--alert-dialog">
          <button id="trigger" data-stimeo--alert-dialog-target="trigger">Delete…</button>
        </div>`);

      expect(() => controller().open()).not.toThrow();
      expect(document.body.style.overflow).toBe("");
      expect(document.getElementById("background")?.inert).toBe(false);
    });
  });

  describe("a dialog that replaces the current one", () => {
    const targetAttribute = "data-stimeo--alert-dialog-target";
    /** A server-rendered copy of the dialog, closed as the markup contract authors it. */
    const dialogCopy = (): HTMLElement => {
      const copy = dialog().cloneNode(true) as HTMLElement;
      for (const element of [copy, ...Array.from(copy.querySelectorAll<HTMLElement>("[id]"))]) {
        if (element.id) element.id = `copy-${element.id}`;
      }
      copy.hidden = true;
      return copy;
    };
    const cancelIn = (container: HTMLElement) =>
      container.querySelector<HTMLElement>(`[${targetAttribute}='initialFocus']`);
    const background = () => document.getElementById("background") as HTMLElement;
    /** Records the confirm and cancel events the root dispatches. */
    const recordDecisions = (): string[] => {
      const seen: string[] = [];
      root().addEventListener("stimeo--alert-dialog:confirm", () => seen.push("confirm"));
      root().addEventListener("stimeo--alert-dialog:cancel", () => seen.push("cancel"));
      return seen;
    };
    /** Collects the writes to `attributes` on `element` that `act` causes. */
    const attributeWrites = async (element: Element, attributes: string[], act: () => void) => {
      const records: MutationRecord[] = [];
      const observer = new MutationObserver((batch) => records.push(...batch));
      observer.observe(element, { attributes: true, attributeFilter: attributes });
      act();
      await tick();
      records.push(...observer.takeRecords());
      observer.disconnect();
      return records;
    };

    it("keeps the dialog open on a replacement delivered in one task", async () => {
      trigger().focus();
      controller().open();
      const successor = dialogCopy();
      dialog().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(false);
      expect(document.activeElement).toBe(cancelIn(successor));
      expect(document.body.style.overflow).toBe("hidden");
      expect(background().inert).toBe(true);
    });

    it("keeps the dialog open on the dialog that stays after an earlier one leaves", async () => {
      trigger().focus();
      controller().open();
      const original = dialog();
      const successor = dialogCopy();
      original.after(successor);
      await tick();
      original.remove();
      await tick();

      expect(successor.hidden).toBe(false);
      expect(document.activeElement).toBe(cancelIn(successor));
      expect(document.body.style.overflow).toBe("hidden");
      expect(background().inert).toBe(true);
    });

    it("still cancels and returns focus to the opener after the swap", async () => {
      const decisions = recordDecisions();
      trigger().focus();
      controller().open();
      const original = dialog();
      const successor = dialogCopy();
      original.after(successor);
      await tick();
      original.remove();
      await tick();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      expect(decisions).toEqual(["cancel"]);
      expect(successor.hidden).toBe(true);
      expect(document.activeElement).toBe(trigger());
      expect(background().inert).toBe(false);
      expect(document.body.style.overflow).toBe("");
    });

    it.each(TARGET_SWAPS)(
      "keeps a modal opened over it on top when its dialog is replaced %s",
      async (_, swap) => {
        const decisions = recordDecisions();
        trigger().focus();
        controller().open();
        const upper = openUpperModal();
        const successor = dialogCopy();
        await swap(dialog(), successor);

        expectUpperModalOnTop(upper, successor);
        expect(successor.hidden).toBe(false);
        expect(decisions).toEqual([]);
        typeKey(document, "Escape");
        expect(decisions).toEqual(["cancel"]);
        expect(successor.hidden).toBe(true);
        expect(document.activeElement).toBe(trigger());
      },
    );

    it("closes a dialog that replaces the current one while closed", async () => {
      const successor = dialogCopy();
      successor.hidden = false;
      dialog().replaceWith(successor);
      await tick();

      expect(successor.hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
    });

    it("releases the modal side effects, quietly, when the only dialog leaves while open", async () => {
      const decisions = recordDecisions();
      trigger().focus();
      controller().open();
      dialog().remove();
      await tick();

      expect(document.body.style.overflow).toBe("");
      expect(background().inert).toBe(false);
      expect(document.activeElement).toBe(trigger());
      expect(decisions).toEqual([]);
    });

    it("closes a dialog that arrives after the only one left", async () => {
      controller().open();
      const arrival = dialogCopy();
      arrival.hidden = false;
      dialog().remove();
      await tick();
      root().append(arrival);
      await tick();

      expect(arrival.hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
    });

    it("opens the next request on a dialog that arrived after the only one left", async () => {
      const arrival = dialogCopy();
      dialog().remove();
      await tick();
      root().append(arrival);
      await tick();
      controller().open();

      expect(arrival.hidden).toBe(false);
      expect(document.activeElement).toBe(cancelIn(arrival));
    });

    it("leaves focus where it is when a dialog arrives behind the current one", async () => {
      controller().open();
      const confirmButton = document.getElementById("confirm") as HTMLElement;
      confirmButton.focus();
      dialog().after(dialogCopy());
      await tick();

      expect(document.activeElement).toBe(confirmButton);
      expect(dialog().hidden).toBe(false);
    });

    it("leaves focus on the page when a dialog arrives behind the current one", async () => {
      controller().open();
      (document.activeElement as HTMLElement).blur();
      dialog().after(dialogCopy());
      await tick();

      expect(document.activeElement).toBe(document.body);
      expect(dialog().hidden).toBe(false);
    });

    it("reports nothing while it moves the open state", async () => {
      const decisions = recordDecisions();
      controller().open();
      dialog().replaceWith(dialogCopy());
      await tick();
      const original = dialog();
      original.after(dialogCopy());
      await tick();
      original.remove();
      await tick();

      expect(decisions).toEqual([]);
    });

    it("moves nothing once it has disconnected", async () => {
      controller().open();
      const original = dialog();
      const successor = dialogCopy();
      original.after(successor);
      await tick();
      controller().disconnect();
      // A write from here on would hide the successor the page just showed.
      successor.hidden = false;
      original.remove();
      await tick();

      expect(successor.hidden).toBe(false);
      expect(document.body.style.overflow).toBe("");
    });

    it("gives a dialog left in the page without its target token its own hidden back", async () => {
      controller().open();
      const original = dialog();
      const successor = dialogCopy();
      original.after(successor);
      await tick();
      original.removeAttribute(targetAttribute);
      await tick();

      expect(original.hidden).toBe(true);
      expect(successor.hidden).toBe(false);
      expect(document.body.style.overflow).toBe("hidden");
    });

    it("focuses the initialFocus of the dialog that stays when the earlier one loses its token", async () => {
      trigger().focus();
      controller().open();
      const original = dialog();
      const successor = dialogCopy();
      original.after(successor);
      await tick();
      original.removeAttribute(targetAttribute);
      await tick();

      expect(document.activeElement).toBe(cancelIn(successor));
    });

    it("focuses inside the dialog when the initialFocus target sits outside it", async () => {
      const outside = document.createElement("button");
      outside.setAttribute(targetAttribute, "initialFocus");
      outside.textContent = "Outside";
      root().prepend(outside);
      await tick();
      controller().open();

      expect(document.activeElement).toBe(cancelIn(dialog()));
    });

    it("closes when the only dialog loses its target token", async () => {
      trigger().focus();
      controller().open();
      const only = dialog();
      only.removeAttribute(targetAttribute);
      await tick();

      expect(only.hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
      expect(document.activeElement).toBe(trigger());
    });

    it("gives the dialog back its own hidden when the widget loses its controller", async () => {
      trigger().focus();
      controller().open();
      const departed = dialog();
      root().removeAttribute("data-controller");
      await tick();

      expect(departed.hidden).toBe(true);
      expect(document.body.style.overflow).toBe("");
      expect(background().inert).toBe(false);
    });

    it("gives an authored-visible dialog its visibility back when the controller goes", async () => {
      const fresh = dialogCopy();
      fresh.hidden = false;
      dialog().replaceWith(fresh);
      await tick();
      expect(fresh.hidden).toBe(true);

      root().removeAttribute("data-controller");
      await tick();

      expect(fresh.hidden).toBe(false);
    });

    it("keeps a hidden value the page wrote after the controller did", async () => {
      controller().open();
      const departed = dialog();
      departed.setAttribute("hidden", "until-found");
      root().removeAttribute("data-controller");
      await tick();

      expect(departed.getAttribute("hidden")).toBe("until-found");
    });

    it("keeps the open state on a dialog that moves within the element", async () => {
      controller().open();
      const moving = dialog();

      const writes = await attributeWrites(moving, ["hidden"], () => root().append(moving));

      expect(moving.hidden).toBe(false);
      expect(writes).toEqual([]);
      expect(document.body.style.overflow).toBe("hidden");
    });
  });
});
