import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { AvatarController } from "../src/controllers/avatar_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link AvatarController}: the load/error → image/fallback
 * swap, the no-`src` fallback, `data-state` phases, the `error` event, and the
 * single accessible name on the container.
 *
 * happy-dom does not actually fetch images, so `load`/`error` are dispatched on
 * the `<img>` to drive the state transitions deterministically.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const markup = (src = "/u/123.jpg") => `
  <span data-controller="stimeo--avatar" role="img" aria-label="Jane Doe"
        data-stimeo--avatar-src-value="${src}">
    <img alt="" aria-hidden="true"
         data-stimeo--avatar-target="image"
         data-action="load->stimeo--avatar#onLoad error->stimeo--avatar#onError" />
    <span aria-hidden="true" hidden data-stimeo--avatar-target="fallback">JD</span>
  </span>`;

describe("AvatarController", () => {
  let application: Application;

  const start = async (html: string) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--avatar", AvatarController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--avatar']") as HTMLElement;
  const image = () =>
    document.querySelector<HTMLImageElement>(
      "[data-stimeo--avatar-target='image']",
    ) as HTMLImageElement;
  const fallback = () =>
    document.querySelector<HTMLElement>("[data-stimeo--avatar-target='fallback']") as HTMLElement;

  it("applies the src value to the image and starts in the loading state", async () => {
    await start(markup());
    expect(image().getAttribute("src")).toBe("/u/123.jpg");
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(image().hidden).toBe(false);
    expect(fallback().hidden).toBe(true);
  });

  it("reveals the image and hides the fallback on load", async () => {
    await start(markup());
    image().dispatchEvent(new Event("load"));
    expect(root().getAttribute("data-state")).toBe("loaded");
    expect(image().hidden).toBe(false);
    expect(fallback().hidden).toBe(true);
  });

  it("swaps to the fallback and emits error on a failed load", async () => {
    await start(markup());
    const details: Array<{ src: string }> = [];
    root().addEventListener("stimeo--avatar:error", (event) => {
      details.push((event as CustomEvent).detail);
    });
    image().dispatchEvent(new Event("error"));
    expect(root().getAttribute("data-state")).toBe("error");
    expect(image().hidden).toBe(true);
    expect(fallback().hidden).toBe(false);
    expect(details).toEqual([{ src: "/u/123.jpg" }]);
  });

  it("shows the fallback immediately when no src is given, without emitting error", async () => {
    const errors: unknown[] = [];
    await start(markup(""));
    root().addEventListener("stimeo--avatar:error", (event) => errors.push(event));
    await tick();
    expect(root().getAttribute("data-state")).toBe("error");
    expect(image().hidden).toBe(true);
    expect(fallback().hidden).toBe(false);
    // No load was attempted, so no error event should have fired during connect.
    expect(errors).toEqual([]);
  });

  it("keeps a single accessible name on the container", async () => {
    await start(markup());
    // The img and fallback are aria-hidden; the name comes from the container.
    expect(image().getAttribute("aria-hidden")).toBe("true");
    expect(fallback().getAttribute("aria-hidden")).toBe("true");
    const phrases = await captureSpeech({ container: root(), steps: 1 });
    expect(phrases[0]).toBe("image, Jane Doe");
  });

  it("has no machine-detectable a11y violations", async () => {
    await start(markup());
    await expectNoA11yViolations(root());
  });

  it("shows the fallback when there is no image target at all", async () => {
    await start(`
      <span data-controller="stimeo--avatar" role="img" aria-label="Jane Doe">
        <span aria-hidden="true" data-stimeo--avatar-target="fallback">JD</span>
      </span>`);
    expect(root().getAttribute("data-state")).toBe("error");
    expect(fallback().hidden).toBe(false);
  });

  it("honors the markup's own src attribute when no src value is set", async () => {
    await start(`
      <span data-controller="stimeo--avatar" role="img" aria-label="Jane Doe">
        <img alt="" aria-hidden="true" src="/markup.jpg" data-stimeo--avatar-target="image"
             data-action="load->stimeo--avatar#onLoad error->stimeo--avatar#onError" />
        <span aria-hidden="true" hidden data-stimeo--avatar-target="fallback">JD</span>
      </span>`);
    expect(image().getAttribute("src")).toBe("/markup.jpg");
    expect(root().getAttribute("data-state")).toBe("loading");
  });

  it("renders a cached, already-complete image without waiting for load", async () => {
    document.body.innerHTML = `
      <span data-controller="stimeo--avatar" role="img" aria-label="Jane Doe"
            data-stimeo--avatar-src-value="/cached.jpg">
        <img alt="" aria-hidden="true" data-stimeo--avatar-target="image"
             data-action="load->stimeo--avatar#onLoad error->stimeo--avatar#onError" />
        <span aria-hidden="true" hidden data-stimeo--avatar-target="fallback">JD</span>
      </span>`;
    const img = image();
    Object.defineProperty(img, "complete", { value: true, configurable: true });
    Object.defineProperty(img, "naturalWidth", { value: 64, configurable: true });
    application = Application.start();
    application.register("stimeo--avatar", AvatarController);
    await tick();
    expect(root().getAttribute("data-state")).toBe("loaded");
  });

  it("treats a cached, complete image with no intrinsic size as a failed load", async () => {
    document.body.innerHTML = `
      <span data-controller="stimeo--avatar" role="img" aria-label="Jane Doe"
            data-stimeo--avatar-src-value="/broken.jpg">
        <img alt="" aria-hidden="true" data-stimeo--avatar-target="image"
             data-action="load->stimeo--avatar#onLoad error->stimeo--avatar#onError" />
        <span aria-hidden="true" hidden data-stimeo--avatar-target="fallback">JD</span>
      </span>`;
    const img = image();
    Object.defineProperty(img, "complete", { value: true, configurable: true });
    Object.defineProperty(img, "naturalWidth", { value: 0, configurable: true });
    application = Application.start();
    application.register("stimeo--avatar", AvatarController);
    await tick();
    expect(root().getAttribute("data-state")).toBe("error");
    expect(fallback().hidden).toBe(false);
  });
});
