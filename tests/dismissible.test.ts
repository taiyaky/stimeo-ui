import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DismissibleController } from "../src/controllers/dismissible_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { byId, query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link DismissibleController}: removal vs. hide modes,
 * the `dismiss` event, Escape handling, and — its core a11y job — moving focus
 * to a safe place before the close button is removed (WCAG 2.4.3).
 */

describe("DismissibleController", () => {
  let application: Application;

  const start = async (markup: string) => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--dismissible", DismissibleController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const remove_markup = `
    <button id="before">Before</button>
    <div data-controller="stimeo--dismissible">
      <div data-stimeo--dismissible-target="root" role="status">
        <p>Saved.</p>
        <button id="close" type="button" aria-label="Close"
                data-action="stimeo--dismissible#dismiss">×</button>
      </div>
    </div>
    <button id="after">After</button>`;

  const host = () => query("[data-controller='stimeo--dismissible']");
  const controller = (element = host()): DismissibleController => {
    const instance = application.getControllerForElementAndIdentifier(
      element,
      "stimeo--dismissible",
    );
    if (!(instance instanceof DismissibleController)) {
      throw new Error("DismissibleController instance not found");
    }
    return instance;
  };
  /** Nullable — used to assert the root is removed in `remove` mode. */
  const maybeRoot = () =>
    document.querySelector<HTMLElement>("[data-stimeo--dismissible-target='root']");
  /** The root, asserted present (`hide` mode and pre-dismiss lookups). */
  const root = () => query("[data-stimeo--dismissible-target='root']");

  it("gives a restored root its own data-state back once it stops being the root", async () => {
    await start(remove_markup);
    expect(root().getAttribute("data-state")).toBe("open");
    application = await restoreFromCache(application, (restored) =>
      restored.register("stimeo--dismissible", DismissibleController),
    );
    const restoredRoot = root();

    restoredRoot.removeAttribute("data-stimeo--dismissible-target");
    controller().rootTargetDisconnected(restoredRoot);

    expect(restoredRoot.hasAttribute("data-state")).toBe(false);
    expect(restoredRoot.getAttributeNames().filter((name) => name.endsWith("-lease"))).toEqual([]);
  });

  it("removes the root from the DOM in remove mode", async () => {
    await start(remove_markup);
    expect(root().getAttribute("data-state")).toBe("open");
    byId("close").click();
    expect(maybeRoot()).toBeNull();
  });

  it("preserves an author-provided initial data-state", async () => {
    await start(`
      <div data-controller="stimeo--dismissible">
        <div data-stimeo--dismissible-target="root" data-state="custom">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
        </div>
      </div>`);

    expect(root().getAttribute("data-state")).toBe("custom");
  });

  it("removes the host when the root target is omitted", async () => {
    await start(`
      <div id="dismissible" data-controller="stimeo--dismissible">
        <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
      </div>`);

    byId("close").click();

    expect(document.getElementById("dismissible")).toBeNull();
  });

  it("hides (not removes) the root in hide mode", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide">
        <div data-stimeo--dismissible-target="root" role="status">
          <button id="close" type="button" data-action="stimeo--dismissible#dismiss">×</button>
        </div>
      </div>`);
    let mode: string | null = null;
    host().addEventListener("stimeo--dismissible:dismiss", (event) => {
      mode = (event as CustomEvent<{ mode: string }>).detail.mode;
    });

    byId("close").click();

    expect(maybeRoot()).not.toBeNull();
    expect(root().hidden).toBe(true);
    expect(root().getAttribute("data-state")).toBe("closing");
    expect(mode).toBe("hide");
  });

  it("dispatches the resolved mode before removing the root", async () => {
    await start(remove_markup);
    let mode: string | null = null;
    let connectedDuringEvent = false;
    host().addEventListener("stimeo--dismissible:dismiss", (event) => {
      mode = (event as CustomEvent<{ mode: string }>).detail.mode;
      connectedDuringEvent = root().isConnected;
    });
    byId("close").click();
    expect(mode).toBe("remove");
    expect(connectedDuringEvent).toBe(true);
  });

  it("moves focus to the next focusable element when focus was inside", async () => {
    await start(remove_markup);
    const close = byId("close");
    close.focus();
    close.click();
    expect(document.activeElement).toBe(byId("after"));
  });

  it("retreats to the fallback target when provided", async () => {
    await start(`
      <button id="far-away">Far</button>
      <div data-controller="stimeo--dismissible">
        <div data-stimeo--dismissible-target="root" role="status">
          <button id="close" type="button" data-action="stimeo--dismissible#dismiss">×</button>
        </div>
        <button id="near">Near</button>
        <button id="fallback" data-stimeo--dismissible-target="fallback">Undo</button>
      </div>`);
    const close = byId("close");
    close.focus();
    close.click();
    expect(document.activeElement).toBe(byId("fallback"));
  });

  it("skips an unfocusable fallback and unavailable following candidates", async () => {
    await start(`
      <div data-controller="stimeo--dismissible">
        <div data-stimeo--dismissible-target="root">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
        </div>
        <div id="fallback" data-stimeo--dismissible-target="fallback">Unavailable</div>
        <div hidden><button id="hidden-descendant">Hidden</button></div>
        <div inert><button id="inert-descendant">Inert</button></div>
        <input id="hidden-input" type="hidden">
        <button id="available">Available</button>
      </div>`);
    byId("close").focus();

    byId("close").click();

    expect(document.activeElement).toBe(byId("available"));
  });

  it("uses the shared Tab-stop rules when choosing the following destination", async () => {
    await start(`
      <div data-controller="stimeo--dismissible">
        <div data-stimeo--dismissible-target="root">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
        </div>
        <fieldset disabled><button id="blocked">Blocked</button></fieldset>
        <details><summary id="summary">More</summary></details>
      </div>`);
    byId("close").focus();

    byId("close").click();

    expect(document.activeElement).toBe(byId("summary"));
  });

  it("ignores a fallback target inside the root", async () => {
    await start(`
      <div data-controller="stimeo--dismissible">
        <div data-stimeo--dismissible-target="root">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
          <button id="fallback" data-stimeo--dismissible-target="fallback">Inside</button>
        </div>
      </div>
      <button id="after">After</button>`);
    byId("close").focus();

    byId("close").click();

    expect(document.activeElement).toBe(byId("after"));
  });

  it("moves focus to the previous focusable element when none follows", async () => {
    await start(`
      <button id="before">Before</button>
      <div data-controller="stimeo--dismissible">
        <div data-stimeo--dismissible-target="root">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
        </div>
      </div>`);
    byId("close").focus();

    byId("close").click();

    expect(document.activeElement).toBe(byId("before"));
  });

  it("falls back to document.body when no focusable element remains", async () => {
    await start(`
      <div data-controller="stimeo--dismissible">
        <div data-stimeo--dismissible-target="root">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
        </div>
      </div>`);
    byId("close").focus();

    byId("close").click();

    expect(document.activeElement).toBe(document.body);
  });

  it("falls back to document.body in hide mode too, off the control it hides", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide">
        <div data-stimeo--dismissible-target="root">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
        </div>
      </div>`);
    byId("close").focus();

    byId("close").click();

    expect(root().hidden).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });

  it("does not move focus when focus was outside the element", async () => {
    await start(remove_markup);
    const before = byId("before");
    before.focus();
    // Dismiss programmatically (not via the close button) so focus stays outside.
    controller().dismiss();
    expect(document.activeElement).toBe(before);
  });

  it("dismisses on Escape when closeOnEscape is set and focus is inside", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide"
           data-stimeo--dismissible-close-on-escape-value="true">
        <div data-stimeo--dismissible-target="root" role="status">
          <button id="close" type="button" data-action="stimeo--dismissible#dismiss">×</button>
        </div>
      </div>`);
    byId("close").focus();
    host().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root().hidden).toBe(true);
  });

  it("does not dismiss on an Escape that cancels an IME composition", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide"
           data-stimeo--dismissible-close-on-escape-value="true">
        <div data-stimeo--dismissible-target="root" role="status">
          <button id="close" type="button" data-action="stimeo--dismissible#dismiss">×</button>
        </div>
      </div>`);
    byId("close").focus();
    // Widget-local half of the shared layered-Escape contract: a composing press
    // steers the IME conversion (e.g. in a text field inside this element),
    // never the element itself.
    host().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true }),
    );
    expect(root().hidden).toBe(false);
  });

  it("does not dismiss on Escape when closeOnEscape has its false default", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide">
        <div data-stimeo--dismissible-target="root">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
        </div>
      </div>`);
    byId("close").focus();

    host().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(controller().closeOnEscapeValue).toBe(false);
    expect(root().hidden).toBe(false);
  });

  it("does not dismiss on Escape when focus is outside", async () => {
    await start(`
      <button id="outside">Outside</button>
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide"
           data-stimeo--dismissible-close-on-escape-value="true">
        <div data-stimeo--dismissible-target="root">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
        </div>
      </div>`);
    byId("outside").focus();

    host().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(root().hidden).toBe(false);
    expect(document.activeElement).toBe(byId("outside"));
  });

  it("ignores non-Escape keys and an already-handled Escape", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide"
           data-stimeo--dismissible-close-on-escape-value="true">
        <div data-stimeo--dismissible-target="root">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
        </div>
      </div>`);
    byId("close").focus();
    host().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const handledEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    handledEscape.preventDefault();

    host().dispatchEvent(handledEscape);

    expect(root().hidden).toBe(false);
  });

  it("starts handling Escape when closeOnEscape changes to true", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide">
        <div data-stimeo--dismissible-target="root">
          <button id="close">Close</button>
        </div>
      </div>`);
    host().setAttribute("data-stimeo--dismissible-close-on-escape-value", "true");
    controller().closeOnEscapeValueChanged();
    byId("close").focus();

    host().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(root().hidden).toBe(true);
  });

  it("stops handling Escape when closeOnEscape changes to false", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide"
           data-stimeo--dismissible-close-on-escape-value="true">
        <div data-stimeo--dismissible-target="root">
          <button id="close">Close</button>
        </div>
      </div>`);
    host().setAttribute("data-stimeo--dismissible-close-on-escape-value", "false");
    controller().closeOnEscapeValueChanged();
    byId("close").focus();

    host().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(root().hidden).toBe(false);
  });

  it("detaches its keydown listener when closeOnEscape changes to false", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide"
           data-stimeo--dismissible-close-on-escape-value="true">
        <div data-stimeo--dismissible-target="root">
          <button id="close">Close</button>
        </div>
      </div>`);
    const removed = vi.spyOn(host(), "removeEventListener");

    host().setAttribute("data-stimeo--dismissible-close-on-escape-value", "false");
    controller().closeOnEscapeValueChanged();

    expect(removed).toHaveBeenCalledWith("keydown", expect.any(Function));
  });

  it("keeps dismissing on Escape after the element moves within the page", async () => {
    await start(`
      <div id="first-slot">
        <div data-controller="stimeo--dismissible"
             data-stimeo--dismissible-mode-value="hide"
             data-stimeo--dismissible-close-on-escape-value="true">
          <div data-stimeo--dismissible-target="root">
            <button id="close">Close</button>
          </div>
        </div>
      </div>
      <div id="second-slot"></div>`);
    const element = host();

    // Stimulus reconnects the same controller and, the Value attribute being
    // unchanged, does not deliver its change callback again.
    element.remove();
    await tick();
    byId("second-slot").append(element);
    await tick();
    byId("close").focus();
    host().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(root().hidden).toBe(true);
  });

  it("reads closeOnEscape at the press, before its change callback has run", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide"
           data-stimeo--dismissible-close-on-escape-value="true">
        <div data-stimeo--dismissible-target="root">
          <button id="close">Close</button>
        </div>
      </div>`);
    byId("close").focus();
    // A handler earlier on the propagation path turns the Value off during the same
    // dispatch. The change callback runs only after the dispatch returns, so the
    // listener registered for `true` still receives this press.
    byId("close").addEventListener("keydown", () => {
      host().setAttribute("data-stimeo--dismissible-close-on-escape-value", "false");
    });

    byId("close").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(root().hidden).toBe(false);
  });

  it("normalizes an unknown mode to remove in behavior and event detail", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="unknown">
        <div data-stimeo--dismissible-target="root">
          <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
        </div>
      </div>`);
    let mode: string | null = null;
    host().addEventListener("stimeo--dismissible:dismiss", (event) => {
      mode = (event as CustomEvent<{ mode: string }>).detail.mode;
    });

    byId("close").click();

    expect(mode).toBe("remove");
    expect(maybeRoot()).toBeNull();
  });

  it("keeps Escape handling isolated between multiple instances", async () => {
    await start(`
      <div id="first-host" data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide"
           data-stimeo--dismissible-close-on-escape-value="true">
        <div id="first-root" data-stimeo--dismissible-target="root">
          <button id="first-close">First</button>
        </div>
      </div>
      <div id="second-host" data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide"
           data-stimeo--dismissible-close-on-escape-value="true">
        <div id="second-root" data-stimeo--dismissible-target="root">
          <button id="second-close">Second</button>
        </div>
      </div>`);
    byId("first-close").focus();

    byId("first-close").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    expect(byId("first-root").hidden).toBe(true);
    expect(byId("second-root").hidden).toBe(false);
  });

  describe("a root that takes over", () => {
    const hide_markup = `
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide">
        <div data-stimeo--dismissible-target="root" role="status">
          <p>Saved.</p>
          <button type="button" aria-label="Close"
                  data-action="stimeo--dismissible#dismiss">×</button>
        </div>
        <p id="elsewhere"></p>
      </div>`;

    /** A copy of `root`, as the server renders it: no `data-state`, not hidden. */
    const freshCopy = (element: HTMLElement): HTMLElement => {
      const copy = element.cloneNode(true) as HTMLElement;
      copy.removeAttribute("data-state");
      copy.hidden = false;
      return copy;
    };

    /** Records everything a takeover must not dispatch, on the host and the document. */
    const recordDispatches = () => {
      const seen: string[] = [];
      const names = ["stimeo--dismissible:dismiss", "change", "reconcile"];
      const listener = (event: Event): void => {
        seen.push(event.type);
      };
      for (const name of names) document.addEventListener(name, listener, true);
      return {
        seen,
        stop: () => {
          for (const name of names) document.removeEventListener(name, listener, true);
        },
      };
    };

    it("writes the open default onto a root that replaces the current one in one task", async () => {
      await start(remove_markup);
      const original = root();
      const successor = freshCopy(original);

      original.replaceWith(successor);
      await tick();

      expect(successor.getAttribute("data-state")).toBe("open");
    });

    it("writes the open default onto a root that stays after an earlier one leaves", async () => {
      await start(remove_markup);
      const original = root();
      const successor = freshCopy(original);
      original.after(successor);
      await tick();

      original.remove();
      await tick();

      expect(root()).toBe(successor);
      expect(successor.getAttribute("data-state")).toBe("open");
    });

    it("writes the open default onto a second root present at connect once the first leaves", async () => {
      await start(`
        <div data-controller="stimeo--dismissible">
          <div id="first-root" data-stimeo--dismissible-target="root">
            <button data-action="stimeo--dismissible#dismiss">Close</button>
          </div>
          <div id="second-root" data-stimeo--dismissible-target="root">
            <button data-action="stimeo--dismissible#dismiss">Close</button>
          </div>
        </div>`);
      const second = byId("second-root");
      expect(byId("first-root").getAttribute("data-state")).toBe("open");
      expect(second.hasAttribute("data-state")).toBe(false);

      query("button", byId("first-root")).click();
      await tick();

      expect(root()).toBe(second);
      expect(second.getAttribute("data-state")).toBe("open");
    });

    it("keeps a data-state the root that takes over was authored with", async () => {
      await start(remove_markup);
      const original = root();
      const successor = freshCopy(original);
      successor.setAttribute("data-state", "custom");

      original.replaceWith(successor);
      await tick();

      expect(successor.getAttribute("data-state")).toBe("custom");
    });

    it("takes over silently, without moving focus", async () => {
      await start(remove_markup);
      const original = root();
      const successor = freshCopy(original);
      byId("before").focus();
      const recording = recordDispatches();

      original.after(successor);
      await tick();
      original.remove();
      await tick();
      recording.stop();

      expect(successor.getAttribute("data-state")).toBe("open");
      expect(recording.seen).toEqual([]);
      expect(document.activeElement).toBe(byId("before"));
    });

    it("dismisses only the root present then: a root arriving after a dismissal is open", async () => {
      await start(hide_markup);
      const dismissed = root();
      query("button", dismissed).click();
      expect(dismissed.hidden).toBe(true);
      expect(dismissed.getAttribute("data-state")).toBe("closing");
      const arrival = freshCopy(dismissed);

      dismissed.replaceWith(arrival);
      await tick();

      expect(arrival.hidden).toBe(false);
      expect(arrival.getAttribute("data-state")).toBe("open");
      query("button", arrival).click();
      expect(arrival.hidden).toBe(true);
      expect(arrival.getAttribute("data-state")).toBe("closing");
    });

    it("writes nothing on the host once the sole root is dismissed and removed", async () => {
      await start(remove_markup);

      byId("close").click();
      await tick();

      expect(maybeRoot()).toBeNull();
      expect(host().hasAttribute("data-state")).toBe(false);
    });

    it("does not throw and writes nothing on the host when the sole root leaves", async () => {
      await start(remove_markup);
      const only = root();

      only.remove();
      // Drive the callback directly: happy-dom delivers target callbacks unreliably, and a
      // throw from one it delivers surfaces outside the test.
      expect(() => controller().rootTargetDisconnected(only)).not.toThrow();
      await tick();

      expect(maybeRoot()).toBeNull();
      expect(host().hasAttribute("data-state")).toBe(false);
    });

    it("writes the open default onto a root that arrives after the sole one left", async () => {
      await start(remove_markup);
      const original = root();
      original.remove();
      await tick();
      const arrival = freshCopy(original);

      host().append(arrival);
      await tick();

      expect(arrival.getAttribute("data-state")).toBe("open");
      expect(host().hasAttribute("data-state")).toBe(false);
    });

    it("writes nothing onto a root that takes over after disconnect()", async () => {
      await start(remove_markup);
      const original = root();
      const successor = freshCopy(original);
      const laterSuccessor = freshCopy(original);
      original.after(successor);
      await tick();

      controller().disconnect();
      original.remove();
      await tick();
      successor.replaceWith(laterSuccessor);
      await tick();

      expect(successor.hasAttribute("data-state")).toBe(false);
      expect(laterSuccessor.hasAttribute("data-state")).toBe(false);
    });

    /** Drops only the root token from `element`, which stays where it is. */
    const dropRootToken = async (element: HTMLElement) => {
      element.removeAttribute("data-stimeo--dismissible-target");
      await tick();
    };

    it("gives a root that stops being one back the data-state it was authored without", async () => {
      await start(remove_markup);
      const departed = root();
      expect(departed.getAttribute("data-state")).toBe("open");

      await dropRootToken(departed);

      expect(departed.hasAttribute("data-state")).toBe(false);
      expect(host().hasAttribute("data-state")).toBe(false);
    });

    it("keeps an authored data-state on a root that stops being one", async () => {
      await start(`
        <div data-controller="stimeo--dismissible">
          <div data-stimeo--dismissible-target="root" data-state="custom">
            <button id="close" data-action="stimeo--dismissible#dismiss">Close</button>
          </div>
        </div>`);
      const departed = root();

      await dropRootToken(departed);

      expect(departed.getAttribute("data-state")).toBe("custom");
    });

    it("keeps a data-state the page wrote on a root after the open default", async () => {
      await start(remove_markup);
      const departed = root();
      departed.setAttribute("data-state", "settling");

      await dropRootToken(departed);

      expect(departed.getAttribute("data-state")).toBe("settling");
    });

    it("leaves a dismissed root that stops being one as the dismissal left it", async () => {
      await start(hide_markup);
      const departed = root();
      query("button", departed).click();

      await dropRootToken(departed);

      expect(departed.hidden).toBe(true);
      expect(departed.getAttribute("data-state")).toBe("closing");
    });

    /**
     * What Stimulus does when the host moves within the page: the same instance
     * disconnects and connects again, its leases still held.
     */
    const moveWithinPage = () => {
      const instance = controller();
      instance.disconnect();
      instance.connect();
    };

    it("leaves the closing a dismissal wrote on a root that stops being one after the host moved", async () => {
      await start(hide_markup);
      const departed = root();
      query("button", departed).click();
      moveWithinPage();

      departed.removeAttribute("data-stimeo--dismissible-target");
      controller().rootTargetDisconnected(departed);

      expect(departed.hidden).toBe(true);
      expect(departed.getAttribute("data-state")).toBe("closing");
    });

    it("keeps a data-state the page wrote after the open default once the host moved", async () => {
      await start(remove_markup);
      const departed = root();
      departed.setAttribute("data-state", "settling");
      moveWithinPage();

      departed.removeAttribute("data-stimeo--dismissible-target");
      controller().rootTargetDisconnected(departed);

      expect(departed.getAttribute("data-state")).toBe("settling");
    });

    it("keeps the closing a dismissal wrote on a restored root that stops being one", async () => {
      await start(hide_markup);
      query("button", root()).click();
      application = await restoreFromCache(application, (restored) =>
        restored.register("stimeo--dismissible", DismissibleController),
      );
      const departed = root();

      departed.removeAttribute("data-stimeo--dismissible-target");
      controller().rootTargetDisconnected(departed);

      expect(departed.hidden).toBe(true);
      expect(departed.getAttribute("data-state")).toBe("closing");
      expect(departed.getAttributeNames().filter((name) => name.endsWith("-lease"))).toEqual([]);
    });

    it("gives a restored root that was no longer the first its own data-state back once it stops being one", async () => {
      await start(remove_markup);
      const ahead = document.createElement("div");
      ahead.id = "ahead";
      ahead.setAttribute("data-stimeo--dismissible-target", "root");
      root().before(ahead);
      await tick();
      controller().rootTargetConnected(ahead);
      application = await restoreFromCache(application, (restored) =>
        restored.register("stimeo--dismissible", DismissibleController),
      );
      const later = document.querySelectorAll<HTMLElement>(
        "[data-stimeo--dismissible-target='root']",
      )[1] as HTMLElement;
      expect(later.getAttribute("data-state")).toBe("open");

      await dropRootToken(later);
      controller().rootTargetDisconnected(later);

      expect(later.hasAttribute("data-state")).toBe(false);
      expect(later.getAttributeNames().filter((name) => name.endsWith("-lease"))).toEqual([]);
      expect(query("#ahead").getAttribute("data-state")).toBe("open");
    });

    it("writes the open default onto the root left once the earlier one stops being one", async () => {
      await start(remove_markup);
      const original = root();
      const successor = freshCopy(original);
      original.after(successor);
      await tick();

      await dropRootToken(original);

      expect(root()).toBe(successor);
      expect(original.hasAttribute("data-state")).toBe(false);
      expect(successor.getAttribute("data-state")).toBe("open");
    });

    it("gives the root back the data-state it was authored without when the host loses its controller", async () => {
      await start(remove_markup);
      const departed = root();

      host().removeAttribute("data-controller");
      await tick();

      expect(departed.hasAttribute("data-state")).toBe(false);
    });

    it("keeps the open default on a root that moves within the host", async () => {
      await start(hide_markup);
      const moving = root();

      byId("elsewhere").append(moving);
      await tick();

      expect(root()).toBe(moving);
      expect(moving.getAttribute("data-state")).toBe("open");
    });

    it("keeps the open default on the root when the whole host leaves the page", async () => {
      await start(remove_markup);
      const kept = root();

      host().remove();
      await tick();

      expect(kept.getAttribute("data-state")).toBe("open");
    });
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(remove_markup);
    await expectNoA11yViolations(document.body, { rules: { region: { enabled: false } } });
  });

  it("announces the notice content before dismissal", async () => {
    await start(remove_markup);
    const spoken = await captureSpeech({ container: root(), steps: 4 });
    expect(spoken).toEqual(["status", "paragraph", "Saved.", "end of paragraph", "button, Close"]);
  });

  // `disconnect()` must remove the manually-bound Escape listener (it is not a
  // Stimulus `data-action`). Driven directly because `application.stop()` leaves
  // controllers connected — only element detachment / disconnect tears them down.
  it("removes the Escape listener on disconnect", async () => {
    await start(`
      <div data-controller="stimeo--dismissible"
           data-stimeo--dismissible-mode-value="hide"
           data-stimeo--dismissible-close-on-escape-value="true">
        <div data-stimeo--dismissible-target="root" role="status">
          <button id="close" type="button" data-action="stimeo--dismissible#dismiss">×</button>
        </div>
      </div>`);
    controller().disconnect();

    byId("close").focus();
    host().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root().hidden).toBe(false);
  });
});
