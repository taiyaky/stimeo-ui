import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AspectRatioController } from "../src/controllers/aspect_ratio_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link AspectRatioController}: ratio parsing into the
 * `--stimeo--aspect-ratio` custom property, the default, dynamic re-reflection,
 * and rejection of unparseable values.
 */

const markup = (ratio = "16/9") => `
  <div data-controller="stimeo--aspect-ratio"
       data-stimeo--aspect-ratio-ratio-value="${ratio}">
    <img src="/cover.jpg" alt="Cover" />
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
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--aspect-ratio']") as HTMLElement;
  const ratioVar = () => root().style.getPropertyValue("--stimeo--aspect-ratio");

  it.each([
    ["16/9", "16 / 9"],
    ["4 / 3", "4 / 3"],
    ["1.5", "1.5"],
    [".5", "0.5"],
    ["1e2/1e1", "100 / 10"],
  ])("normalizes the positive CSS ratio %s to %s", async (ratio, expected) => {
    await start(markup(ratio));
    expect(ratioVar()).toBe(expected);
  });

  it("defaults to 1 / 1 when no ratio is set", async () => {
    document.body.innerHTML = `<div data-controller="stimeo--aspect-ratio"></div>`;
    application = Application.start();
    application.register("stimeo--aspect-ratio", AspectRatioController);
    await tick();
    expect(ratioVar()).toBe("1 / 1");
  });

  it.each([
    "abc",
    "",
    "0/5",
    "5/0",
    "-1/2",
    "1.5rem",
    "16px/9px",
    "16/9/2",
    "Infinity",
    "0x10",
    "1.",
  ])("falls back to 1 / 1 for the invalid ratio %j", async (ratio) => {
    await start(markup(ratio));
    expect(ratioVar()).toBe("1 / 1");
  });

  it("re-reflects a valid ratio through Stimulus's Value observer", async () => {
    await start(markup("16/9"));
    root().setAttribute("data-stimeo--aspect-ratio-ratio-value", "21/9");
    await vi.waitFor(() => expect(ratioVar()).toBe("21 / 9"));
  });

  it("replaces a valid ratio with the fallback through Stimulus's Value observer", async () => {
    await start(markup("16/9"));
    expect(ratioVar()).toBe("16 / 9");

    root().setAttribute("data-stimeo--aspect-ratio-ratio-value", "16px/9px");
    await vi.waitFor(() => expect(ratioVar()).toBe("1 / 1"));
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(markup());
    await expectNoA11yViolations(root());
  });

  // --- Speech-order regression -----------------------------------------------

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
