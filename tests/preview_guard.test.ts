import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PreviewGuardController } from "../src/controllers/preview_guard_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link PreviewGuardController}: hide/show driven by the
 * `html[data-turbo-preview]` attribute (watched with a MutationObserver), the two guard
 * forms `placeholder` selects, the leased inline `visibility`, the snapshot rewind, and
 * the focus hand-back bookkeeping.
 *
 * happy-dom has no CSS cascade, so it neither drops focus out of a `visibility: hidden`
 * subtree nor models `!important`. Those halves need a real engine; what is asserted here
 * is the bookkeeping the controller owns either way — which element the guard recorded,
 * and whether it hands it back.
 */

const startPreview = () => document.documentElement.setAttribute("data-turbo-preview", "");
const endPreview = () => document.documentElement.removeAttribute("data-turbo-preview");
const PLACEHOLDER = 'data-stimeo--preview-guard-placeholder-value="—"';

describe("PreviewGuardController", () => {
  let application: Application;

  const mount = async (attrs = "", html = "¥123,456") => {
    document.body.innerHTML = `<span id="g" data-controller="stimeo--preview-guard" ${attrs}>${html}</span>`;
    application = Application.start();
    application.register("stimeo--preview-guard", PreviewGuardController);
    await tick();
  };

  beforeEach(() => {
    document.body.innerHTML = "";
    endPreview();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    endPreview();
  });

  const el = () => query("#g");
  const record = (name: "hide" | "show") => {
    const details: unknown[] = [];
    el().addEventListener(`stimeo--preview-guard:${name}`, (e) =>
      details.push((e as CustomEvent).detail),
    );
    return details;
  };
  /**
   * Takes the element out and puts it back — Stimulus disconnects and reconnects the same
   * instance. `between` runs on the detached node, where value callbacks cannot reach it.
   */
  const moveInPage = async (between?: (node: HTMLElement) => void) => {
    const node = el();
    node.remove();
    await tick();
    between?.(node);
    document.body.append(node);
    await tick();
  };

  it("hides the element while a Turbo preview is on screen", async () => {
    await mount();
    const hides = record("hide");
    expect(el().hasAttribute("data-preview-hidden")).toBe(false);

    startPreview();
    await tick();
    expect(el().getAttribute("data-preview-hidden")).toBe("true");
    expect(el().style.visibility).toBe("hidden");
    expect(hides).toEqual([{}]);
  });

  it("restores the element when the preview clears", async () => {
    await mount();
    const shows = record("show");
    startPreview();
    await tick();

    endPreview();
    await tick();
    expect(el().hasAttribute("data-preview-hidden")).toBe(false);
    expect(el().style.visibility).toBe("");
    expect(shows).toEqual([{}]);
  });

  it("takes the placeholder's place in the element when one is declared", async () => {
    await mount(PLACEHOLDER);
    startPreview();
    await tick();
    expect(el().textContent).toBe("—");
    expect(el().style.visibility).toBe(""); // content swap, not visibility

    endPreview();
    await tick();
    expect(el().textContent).toBe("¥123,456"); // original restored
  });

  it("puts the displaced child markup back intact", async () => {
    await mount(PLACEHOLDER, "<strong>¥</strong>123,456");
    startPreview();
    await tick();
    expect(el().textContent).toBe("—");

    endPreview();
    await tick();
    expect(el().innerHTML).toBe("<strong>¥</strong>123,456");
  });

  it("hides immediately when connected during a preview", async () => {
    startPreview();
    await mount();
    expect(el().getAttribute("data-preview-hidden")).toBe("true");
    expect(el().style.visibility).toBe("hidden");
  });

  it("clears a guarded hook it finds already on the element", async () => {
    // A snapshot frozen mid-guard carries the flag, and nothing in the DOM says what was
    // underneath it — so the connection that finds it starts from unguarded.
    await mount('data-preview-hidden="true"');
    expect(el().hasAttribute("data-preview-hidden")).toBe(false);
  });

  it("gives an authored visibility back, not the empty string", async () => {
    await mount('style="visibility: collapse"');
    startPreview();
    await tick();
    expect(el().style.visibility).toBe("hidden");

    endPreview();
    await tick();
    expect(el().style.visibility).toBe("collapse");
  });

  it("leaves a visibility the consumer wrote while guarded alone", async () => {
    await mount('style="visibility: visible"');
    startPreview();
    await tick();
    el().style.visibility = "collapse"; // the consumer takes the declaration over

    endPreview();
    await tick();
    expect(el().style.visibility).toBe("collapse");
  });

  it("follows a placeholder changed while the guard is up", async () => {
    await mount(PLACEHOLDER);
    startPreview();
    await tick();
    expect(el().textContent).toBe("—");

    el().setAttribute("data-stimeo--preview-guard-placeholder-value", "···");
    await tick();
    expect(el().textContent).toBe("···");

    endPreview();
    await tick();
    expect(el().textContent).toBe("¥123,456"); // still the original underneath
  });

  it("switches guard form when the placeholder is emptied while the guard is up", async () => {
    await mount(PLACEHOLDER);
    startPreview();
    await tick();

    el().setAttribute("data-stimeo--preview-guard-placeholder-value", "");
    await tick();
    expect(el().textContent).toBe("¥123,456"); // content back
    expect(el().style.visibility).toBe("hidden"); // …and hidden instead

    endPreview();
    await tick();
    expect(el().style.visibility).toBe("");
  });

  it("does not re-announce the guard when the placeholder changes", async () => {
    // `hide` reports that the guard went up, and re-forming it does not put it back up.
    await mount(PLACEHOLDER);
    startPreview();
    await tick();
    const hides = record("hide");
    const shows = record("show");

    el().setAttribute("data-stimeo--preview-guard-placeholder-value", "···");
    await tick();
    el().setAttribute("data-stimeo--preview-guard-placeholder-value", "");
    await tick();

    expect(hides).toEqual([]);
    expect(shows).toEqual([]);
  });

  it("does not put the held content back for a stand-in text change", async () => {
    await mount(PLACEHOLDER, "<strong>¥</strong>123,456");
    startPreview();
    await tick();

    const added: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) for (const node of r.addedNodes) added.push(node.textContent ?? "");
    });
    observer.observe(el(), { childList: true });

    el().setAttribute("data-stimeo--preview-guard-placeholder-value", "···");
    await tick();
    observer.disconnect();

    expect(added).toEqual(["···"]); // only the new stand-in, never the held subtree
  });

  it("ignores a placeholder changed while no guard is up", async () => {
    await mount(PLACEHOLDER);
    el().setAttribute("data-stimeo--preview-guard-placeholder-value", "···");
    await tick();
    expect(el().textContent).toBe("¥123,456");
    expect(el().hasAttribute("data-preview-hidden")).toBe(false);
  });

  it("rewinds before the page is cached", async () => {
    await mount(PLACEHOLDER);
    startPreview();
    await tick();
    expect(el().textContent).toBe("—");

    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(el().textContent).toBe("¥123,456");
    expect(el().hasAttribute("data-preview-hidden")).toBe(false);
  });

  it("does not touch an element it never guarded when the page is cached", async () => {
    await mount('style="visibility: collapse"');

    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(el().style.visibility).toBe("collapse");
  });

  it("keeps the guard across an in-page move, so no stale value flashes", async () => {
    await mount(PLACEHOLDER);
    startPreview();
    await tick();
    const node = el();

    node.remove(); // Stimulus disconnects; the rewind is the snapshot's job, not teardown's
    await tick();
    expect(node.textContent).toBe("—");
  });

  it("still reports the guard after an in-page move puts the element back", async () => {
    // The same instance comes back still guarding, so the hook has to keep describing it —
    // a consumer stylesheet reading it would otherwise drop the guarded look mid-preview.
    await mount(PLACEHOLDER);
    startPreview();
    await tick();
    const hides = record("hide");

    await moveInPage();
    expect(el().textContent).toBe("—");
    expect(el().getAttribute("data-preview-hidden")).toBe("true");
    expect(hides).toEqual([]); // the guard never came down, so nothing to announce
  });

  it("still reports the guard after an in-page move in the visibility form", async () => {
    await mount();
    startPreview();
    await tick();

    await moveInPage();
    expect(el().style.visibility).toBe("hidden");
    expect(el().getAttribute("data-preview-hidden")).toBe("true");
  });

  it("follows a placeholder changed while the element was detached", async () => {
    // The value callback runs before `connect()` and has no connection to act on, so the
    // reconnect is what has to read the current declaration.
    await mount(PLACEHOLDER);
    startPreview();
    await tick();

    await moveInPage((node) => {
      node.setAttribute("data-stimeo--preview-guard-placeholder-value", "···");
    });
    expect(el().textContent).toBe("···");
    expect(el().getAttribute("data-preview-hidden")).toBe("true");
  });

  it("comes down on reconnect when the preview ended while the element was detached", async () => {
    await mount(PLACEHOLDER);
    startPreview();
    await tick();
    const shows = record("show");

    await moveInPage(endPreview);
    expect(el().textContent).toBe("¥123,456");
    expect(el().hasAttribute("data-preview-hidden")).toBe(false);
    expect(shows).toEqual([{}]);
  });

  it("leaves an unguarded element alone across an in-page move", async () => {
    await mount();
    await moveInPage();
    expect(el().hasAttribute("data-preview-hidden")).toBe(false);
    expect(el().style.visibility).toBe("");
  });

  it("stops observing on disconnect", async () => {
    await mount();
    const node = el();
    node.remove();
    await tick();

    startPreview();
    await tick();
    expect(node.hasAttribute("data-preview-hidden")).toBe(false); // observer severed
  });

  it("hands focus back to the descendant the guard took it from", async () => {
    await mount(PLACEHOLDER, '<button id="b">¥123,456</button>');
    query("#b").focus();
    startPreview();
    await tick();
    // happy-dom keeps no CSS cascade, so stand in for the drop a real engine performs.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    endPreview();
    await tick();
    expect(document.activeElement).toBe(query("#b"));
  });

  it("hands focus back to the element itself when it held it", async () => {
    await mount('tabindex="0"');
    el().focus();
    startPreview();
    await tick();
    (document.activeElement as HTMLElement | null)?.blur();

    endPreview();
    await tick();
    expect(document.activeElement).toBe(el());
  });

  it("does not chase focus that was never inside the element", async () => {
    await mount();
    document.body.insertAdjacentHTML("beforeend", '<button id="outside">x</button>');
    query("#outside").focus();
    startPreview();
    await tick();
    (document.activeElement as HTMLElement | null)?.blur(); // something else drops focus

    endPreview();
    await tick();
    expect(document.activeElement).toBe(document.body); // not ours to hand back
  });

  it("leaves focus resting outside the element alone", async () => {
    await mount();
    document.body.insertAdjacentHTML("beforeend", '<button id="outside">x</button>');
    const outside = query("#outside");
    outside.focus();

    startPreview();
    await tick();
    endPreview();
    await tick();
    expect(document.activeElement).toBe(outside);
  });

  it("has no a11y violations", async () => {
    await mount();
    await expectNoA11yViolations(el());
  });
});
