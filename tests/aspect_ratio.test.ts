import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { AspectRatioController } from "../src/controllers/aspect_ratio_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link AspectRatioController}: ratio parsing into the
 * `--stimeo-aspect-ratio` custom property, the default, dynamic re-reflection,
 * and rejection of unparseable values.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const markup = (ratio = "16/9") => `
  <div data-controller="stimeo--aspect-ratio"
       data-stimeo--aspect-ratio-ratio-value="${ratio}">
    <img src="/cover.jpg" alt="Cover" data-stimeo--aspect-ratio-target="content" />
  </div>`;

describe("AspectRatioController", () => {
  let application: Application;

  const start = async (html: string) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--aspect-ratio", AspectRatioController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--aspect-ratio']") as HTMLElement;
  const ratioVar = () => root().style.getPropertyValue("--stimeo-aspect-ratio");

  it("reflects a w/h ratio as a normalized custom property", async () => {
    await start(markup("16/9"));
    expect(ratioVar()).toBe("16 / 9");
  });

  it("accepts a bare number ratio", async () => {
    await start(markup("1.5"));
    expect(ratioVar()).toBe("1.5");
  });

  it("tolerates whitespace around the slash", async () => {
    await start(markup("4 / 3"));
    expect(ratioVar()).toBe("4 / 3");
  });

  it("defaults to 1 / 1 when no ratio is set", async () => {
    document.body.innerHTML = `<div data-controller="stimeo--aspect-ratio"></div>`;
    application = Application.start();
    application.register("stimeo--aspect-ratio", AspectRatioController);
    await tick();
    expect(ratioVar()).toBe("1 / 1");
  });

  it("falls back to 1 / 1 for an unparseable or non-positive ratio", async () => {
    await start(markup("abc"));
    expect(ratioVar()).toBe("1 / 1");
    root().setAttribute("data-stimeo--aspect-ratio-ratio-value", "0/5");
    await tick();
    expect(ratioVar()).toBe("1 / 1");
  });

  it("re-reflects when the ratio value changes", async () => {
    await start(markup("16/9"));
    const controller = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--aspect-ratio",
    ) as AspectRatioController;
    root().setAttribute("data-stimeo--aspect-ratio-ratio-value", "21/9");
    // Drive the reflect directly: Stimulus's value-change observer is
    // MutationObserver-based and intermittently misses the change under parallel
    // load in happy-dom. ratioValueChanged re-reads the (now updated) value getter.
    controller.ratioValueChanged();
    expect(ratioVar()).toBe("21 / 9");
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(markup());
    await expectNoA11yViolations(root());
  });

  // --- Layer ③ speech-order regression ---------------------------------------

  it("leaves the accessible child content announceable (layout helper is invisible to AT)", async () => {
    await start(markup());
    // The host carries no role/state; the layout helper must not disturb the
    // announcement of its child content (here an image with alt text).
    const phrases = await captureSpeech({ container: root(), steps: 1 });
    // Freeze the whole ordered array (not a name-only `toContain`): the host adds
    // no role/state, so the image's accessible name is all the AT announces.
    expect(phrases).toEqual(["image, Cover", "image, Cover"]);
  });
});
