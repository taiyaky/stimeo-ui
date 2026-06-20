import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PreviewGuardController } from "../src/controllers/preview_guard_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link PreviewGuardController}: hide/show driven by the
 * `html[data-turbo-preview]` attribute (watched with a MutationObserver), placeholder
 * mode, connecting mid-preview, and observer/restore teardown.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const startPreview = () => document.documentElement.setAttribute("data-turbo-preview", "");
const endPreview = () => document.documentElement.removeAttribute("data-turbo-preview");

describe("PreviewGuardController", () => {
  let application: Application;

  const mount = async (attrs = "", text = "¥123,456") => {
    document.body.innerHTML = `<span id="g" data-controller="stimeo--preview-guard" ${attrs}>${text}</span>`;
    application = Application.start();
    application.register("stimeo--preview-guard", PreviewGuardController);
    await tick();
  };

  beforeEach(() => {
    document.body.innerHTML = "";
    endPreview();
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
    endPreview();
  });

  const el = () => query("#g");

  it("hides the element while a Turbo preview is on screen", async () => {
    await mount();
    const events: string[] = [];
    el().addEventListener("stimeo--preview-guard:hide", () => events.push("hide"));
    expect(el().hasAttribute("data-preview-hidden")).toBe(false);

    startPreview();
    await tick();
    expect(el().getAttribute("data-preview-hidden")).toBe("true");
    expect(el().style.visibility).toBe("hidden");
    expect(events).toEqual(["hide"]);
  });

  it("restores the element when the preview clears", async () => {
    await mount();
    const events: string[] = [];
    el().addEventListener("stimeo--preview-guard:show", () => events.push("show"));
    startPreview();
    await tick();

    endPreview();
    await tick();
    expect(el().hasAttribute("data-preview-hidden")).toBe(false);
    expect(el().style.visibility).toBe("");
    expect(events).toEqual(["show"]);
  });

  it("swaps text for the placeholder in placeholder mode", async () => {
    await mount(
      'data-stimeo--preview-guard-mode-value="placeholder" data-stimeo--preview-guard-placeholder-value="—"',
    );
    startPreview();
    await tick();
    expect(el().textContent).toBe("—");
    expect(el().style.visibility).toBe(""); // text swap, not visibility

    endPreview();
    await tick();
    expect(el().textContent).toBe("¥123,456"); // original restored
  });

  it("hides immediately when connected during a preview", async () => {
    startPreview();
    await mount();
    expect(el().getAttribute("data-preview-hidden")).toBe("true");
    expect(el().style.visibility).toBe("hidden");
  });

  it("restores the element and stops observing on disconnect", async () => {
    await mount();
    startPreview();
    await tick();
    const node = el();
    expect(node.style.visibility).toBe("hidden");

    node.remove(); // triggers disconnect
    await tick();
    expect(node.style.visibility).toBe(""); // restored, not left guarded
    expect(node.hasAttribute("data-preview-hidden")).toBe(false);

    // Observer severed: a later preview toggle does not re-guard the detached node.
    startPreview();
    await tick();
    expect(node.hasAttribute("data-preview-hidden")).toBe(false);
  });

  it("has no a11y violations", async () => {
    await mount();
    await expectNoA11yViolations(el());
  });
});
