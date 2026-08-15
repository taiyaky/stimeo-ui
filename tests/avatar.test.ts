import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { AvatarController } from "../src/controllers/avatar_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link AvatarController}: source precedence and morph
 * follow-through, target lifecycle, silent cached-state reconstruction, exact
 * native error events, the four visual phases, and one stable accessible name.
 *
 * happy-dom does not fetch images, so native `load`/`error` events are dispatched
 * deterministically. The global image-lifecycle setup makes each new source
 * pending until one of those events resolves it.
 */

interface MarkupOptions {
  readonly value?: string | null;
  readonly directSrc?: string;
  readonly image?: boolean;
  readonly fallback?: boolean;
  readonly imageHidden?: boolean;
  readonly fallbackHidden?: boolean;
}

const markup = ({
  value = "/u/123.jpg",
  directSrc,
  image = true,
  fallback = true,
  imageHidden = true,
  fallbackHidden = false,
}: MarkupOptions = {}): string => {
  const valueAttribute = value === null ? "" : ` data-stimeo--avatar-src-value="${value}"`;
  const srcAttribute = directSrc === undefined ? "" : ` src="${directSrc}"`;
  const imageMarkup = image
    ? `<img id="avatar-image" alt="" aria-hidden="true"${srcAttribute}${
        imageHidden ? " hidden" : ""
      }
         data-stimeo--avatar-target="image"
         data-action="load->stimeo--avatar#onLoad error->stimeo--avatar#onError" />`
    : "";
  const fallbackMarkup = fallback
    ? `<span id="avatar-fallback" aria-hidden="true"${fallbackHidden ? " hidden" : ""}
         data-stimeo--avatar-target="fallback">JD</span>`
    : "";
  return `<span id="avatar" data-controller="stimeo--avatar" role="img"
      aria-label="Jane Doe"${valueAttribute}>${imageMarkup}${fallbackMarkup}</span>`;
};

const requireElement = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Avatar fixture is missing ${selector}`);
  return element;
};

/** Builds the action-shaped event Stimulus would deliver from `currentTarget`. */
const actionEvent = (type: string, currentTarget: EventTarget): Event => {
  const event = new Event(type);
  Object.defineProperty(event, "currentTarget", { configurable: true, value: currentTarget });
  return event;
};

describe("AvatarController", () => {
  let application: Application | undefined;

  const startMounted = async (): Promise<void> => {
    application = Application.start();
    application.register("stimeo--avatar", AvatarController);
    await tick();
  };

  const start = async (html: string): Promise<void> => {
    document.body.innerHTML = html;
    await startMounted();
  };

  const root = (): HTMLElement => requireElement<HTMLElement>("#avatar");
  const image = (): HTMLImageElement => requireElement<HTMLImageElement>("#avatar-image");
  const fallback = (): HTMLElement => requireElement<HTMLElement>("#avatar-fallback");
  const controller = (): AvatarController => {
    const instance = application?.getControllerForElementAndIdentifier(root(), "stimeo--avatar");
    if (!(instance instanceof AvatarController)) throw new Error("Avatar controller missing");
    return instance;
  };

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    document.body.innerHTML = "";
  });

  it("applies a present src Value and reverses authored visibility for loading", async () => {
    await start(markup());

    expect(image().getAttribute("src")).toBe("/u/123.jpg");
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(image().hidden).toBe(false);
    expect(fallback().hidden).toBe(true);
  });

  it("uses a directly authored image src when the Value is absent", async () => {
    await start(markup({ value: null, directSrc: "/authored.jpg" }));

    expect(image().getAttribute("src")).toBe("/authored.jpg");
    expect(root().getAttribute("data-state")).toBe("loading");
  });

  it("treats an explicit empty Value as empty and restores authored src when removed", async () => {
    await start(markup({ value: "", directSrc: "/authored.jpg", imageHidden: false }));

    expect(image().hasAttribute("src")).toBe(false);
    expect(root().getAttribute("data-state")).toBe("empty");
    expect(image().hidden).toBe(true);
    expect(fallback().hidden).toBe(false);

    root().removeAttribute("data-stimeo--avatar-src-value");
    controller().srcValueChanged();
    await flushMicrotasks();

    expect(image().getAttribute("src")).toBe("/authored.jpg");
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(image().hidden).toBe(false);
    expect(fallback().hidden).toBe(true);
  });

  it("coalesces runtime Value changes and starts only the final source loading", async () => {
    await start(markup());
    image().dispatchEvent(new Event("load"));
    const srcMutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => srcMutations.push(...records));
    observer.observe(image(), { attributes: true, attributeFilter: ["src"] });

    root().setAttribute("data-stimeo--avatar-src-value", "/u/456.jpg");
    controller().srcValueChanged();
    root().setAttribute("data-stimeo--avatar-src-value", "/u/789.jpg");
    controller().srcValueChanged();
    await flushMicrotasks();
    await flushMicrotasks();
    observer.disconnect();

    expect(image().getAttribute("src")).toBe("/u/789.jpg");
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(srcMutations).toHaveLength(1);
  });

  it("reconciles a directly authored src mutation on a retained image", async () => {
    await start(markup({ value: null, directSrc: "/one.jpg" }));
    image().dispatchEvent(new Event("load"));
    expect(root().getAttribute("data-state")).toBe("loaded");

    image().setAttribute("src", "/two.jpg");
    await tick();

    expect(root().getAttribute("data-state")).toBe("loading");
    expect(image().hidden).toBe(false);
    expect(fallback().hidden).toBe(true);
  });

  it("reasserts a present Value after a direct src mutation", async () => {
    await start(markup());

    image().setAttribute("src", "/consumer.jpg");
    await tick();

    expect(image().getAttribute("src")).toBe("/u/123.jpg");
    expect(root().getAttribute("data-state")).toBe("loading");
  });

  it("moves from error to loaded and reverses both visibility outputs on load", async () => {
    await start(markup());
    image().dispatchEvent(new Event("error"));
    expect(image().hidden).toBe(true);
    expect(fallback().hidden).toBe(false);

    image().dispatchEvent(new Event("load"));

    expect(root().getAttribute("data-state")).toBe("loaded");
    expect(image().hidden).toBe(false);
    expect(fallback().hidden).toBe(true);
  });

  it("emits one error detail for a native failure on the current image", async () => {
    await start(markup());
    const details: Array<{ src: string }> = [];
    root().addEventListener("stimeo--avatar:error", (event) => {
      details.push((event as CustomEvent<{ src: string }>).detail);
    });

    image().dispatchEvent(new Event("error"));

    expect(root().getAttribute("data-state")).toBe("error");
    expect(image().hidden).toBe(true);
    expect(fallback().hidden).toBe(false);
    expect(details).toEqual([{ src: "/u/123.jpg" }]);
  });

  it("does not emit error while connecting without a source", async () => {
    document.body.innerHTML = markup({ value: "" });
    const details: unknown[] = [];
    const listener = (event: Event): void => {
      details.push(event);
    };
    document.addEventListener("stimeo--avatar:error", listener);
    try {
      await startMounted();
      expect(root().getAttribute("data-state")).toBe("empty");
      expect(image().hidden).toBe(true);
      expect(fallback().hidden).toBe(false);
      expect(details).toEqual([]);
    } finally {
      document.removeEventListener("stimeo--avatar:error", listener);
    }
  });

  it("ignores load and error actions when the current image has no source", async () => {
    await start(markup({ value: "" }));
    const details: unknown[] = [];
    root().addEventListener("stimeo--avatar:error", (event) => details.push(event));

    image().dispatchEvent(new Event("load"));
    image().dispatchEvent(new Event("error"));

    expect(root().getAttribute("data-state")).toBe("empty");
    expect(details).toEqual([]);
  });

  it("shows the fallback-only form as empty without requiring an image target", async () => {
    await start(markup({ value: null, image: false }));

    expect(root().getAttribute("data-state")).toBe("empty");
    expect(fallback().hidden).toBe(false);
  });

  it("supports an image-only form without requiring a fallback target", async () => {
    await start(markup({ fallback: false }));

    expect(root().getAttribute("data-state")).toBe("loading");
    image().dispatchEvent(new Event("error"));
    expect(root().getAttribute("data-state")).toBe("error");
    expect(image().hidden).toBe(true);
  });

  it("applies the Value when an image target is inserted at runtime", async () => {
    await start(markup({ image: false }));
    const inserted = document.createElement("img");
    inserted.id = "avatar-image";
    inserted.alt = "";
    inserted.setAttribute("aria-hidden", "true");
    inserted.setAttribute("data-stimeo--avatar-target", "image");
    inserted.setAttribute(
      "data-action",
      "load->stimeo--avatar#onLoad error->stimeo--avatar#onError",
    );
    root().prepend(inserted);
    controller().imageTargetConnected();
    await flushMicrotasks();

    expect(inserted.getAttribute("src")).toBe("/u/123.jpg");
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(inserted.hidden).toBe(false);
    expect(fallback().hidden).toBe(true);
  });

  it("returns authored image attributes and controls its runtime replacement", async () => {
    await start(markup({ directSrc: "/authored.jpg" }));
    const departed = image();
    departed.removeAttribute("data-stimeo--avatar-target");
    controller().imageTargetDisconnected(departed);

    const replacement = document.createElement("img");
    replacement.id = "avatar-image";
    replacement.alt = "";
    replacement.hidden = true;
    replacement.setAttribute("aria-hidden", "true");
    replacement.setAttribute("data-stimeo--avatar-target", "image");
    replacement.setAttribute(
      "data-action",
      "load->stimeo--avatar#onLoad error->stimeo--avatar#onError",
    );
    root().prepend(replacement);
    controller().imageTargetConnected();
    await flushMicrotasks();

    expect(departed.getAttribute("src")).toBe("/authored.jpg");
    expect(departed.hidden).toBe(true);
    expect(replacement.getAttribute("src")).toBe("/u/123.jpg");
    expect(replacement.hidden).toBe(false);
    expect(root().getAttribute("data-state")).toBe("loading");
  });

  it("returns authored fallback visibility and controls its runtime replacement", async () => {
    await start(markup({ fallbackHidden: true }));
    image().dispatchEvent(new Event("error"));
    const departed = fallback();
    expect(departed.hidden).toBe(false);
    departed.removeAttribute("data-stimeo--avatar-target");
    controller().fallbackTargetDisconnected(departed);

    const replacement = document.createElement("span");
    replacement.id = "avatar-fallback";
    replacement.hidden = true;
    replacement.setAttribute("aria-hidden", "true");
    replacement.setAttribute("data-stimeo--avatar-target", "fallback");
    replacement.textContent = "JD";
    root().append(replacement);
    controller().fallbackTargetConnected();
    await flushMicrotasks();

    expect(departed.hidden).toBe(true);
    expect(replacement.hidden).toBe(false);
    expect(root().getAttribute("data-state")).toBe("error");
  });

  it("ignores an error action from an image that is no longer the target", async () => {
    await start(markup({ directSrc: "/authored.jpg" }));
    const departed = image();
    departed.removeAttribute("data-stimeo--avatar-target");
    controller().imageTargetDisconnected(departed);
    await flushMicrotasks();
    const details: unknown[] = [];
    root().addEventListener("stimeo--avatar:error", (event) => details.push(event));

    controller().onError(actionEvent("error", departed));

    expect(root().getAttribute("data-state")).toBe("empty");
    expect(details).toEqual([]);
  });

  it("ignores programmatic load and error actions with no image action host", async () => {
    await start(markup({ image: false }));
    const details: unknown[] = [];
    root().addEventListener("stimeo--avatar:error", (event) => details.push(event));

    controller().onLoad(new Event("load"));
    controller().onError(new Event("error"));

    expect(root().getAttribute("data-state")).toBe("empty");
    expect(details).toEqual([]);
  });

  it("ignores an action hosted by a non-image element marked as the image target", async () => {
    await start(`
      <span id="avatar" data-controller="stimeo--avatar" role="img" aria-label="Jane Doe"
            data-stimeo--avatar-src-value="/u/123.jpg">
        <span id="avatar-image" data-stimeo--avatar-target="image"></span>
        <span id="avatar-fallback" aria-hidden="true"
              data-stimeo--avatar-target="fallback">JD</span>
      </span>`);
    const malformed = requireElement<HTMLElement>("#avatar-image");
    const details: unknown[] = [];
    root().addEventListener("stimeo--avatar:error", (event) => details.push(event));

    controller().onError(actionEvent("error", malformed));

    expect(root().getAttribute("data-state")).toBe("loading");
    expect(details).toEqual([]);
  });

  it("reconstructs a cached successful image without waiting for load", async () => {
    document.body.innerHTML = markup({ value: "/cached.jpg" });
    Object.defineProperty(image(), "complete", { value: true, configurable: true });
    Object.defineProperty(image(), "naturalWidth", { value: 64, configurable: true });
    await startMounted();

    expect(root().getAttribute("data-state")).toBe("loaded");
    expect(image().hidden).toBe(false);
    expect(fallback().hidden).toBe(true);
  });

  it("reconstructs cached failure silently across reconnects", async () => {
    document.body.innerHTML = markup({ value: "/broken.jpg", imageHidden: false });
    Object.defineProperty(image(), "complete", { value: true, configurable: true });
    Object.defineProperty(image(), "naturalWidth", { value: 0, configurable: true });
    const details: unknown[] = [];
    const listener = (event: Event): void => {
      details.push(event);
    };
    document.addEventListener("stimeo--avatar:error", listener);
    try {
      await startMounted();
      expect(root().getAttribute("data-state")).toBe("error");
      expect(details).toEqual([]);

      controller().disconnect();
      controller().connect();

      expect(root().getAttribute("data-state")).toBe("error");
      expect(image().getAttribute("src")).toBe("/broken.jpg");
      expect(details).toEqual([]);
    } finally {
      document.removeEventListener("stimeo--avatar:error", listener);
    }
  });

  it("cancels pending reconciliation while retaining materialized output on disconnect", async () => {
    await start(markup());
    const retainedRoot = root();
    const retainedImage = image();
    const retainedFallback = fallback();
    retainedImage.dispatchEvent(new Event("error"));
    retainedRoot.setAttribute("data-stimeo--avatar-src-value", "/next.jpg");
    controller().srcValueChanged();

    retainedRoot.remove();
    await tick();

    expect(retainedRoot.getAttribute("data-state")).toBe("error");
    expect(retainedImage.getAttribute("src")).toBe("/u/123.jpg");
    expect(retainedImage.hidden).toBe(true);
    expect(retainedFallback.hidden).toBe(false);
  });

  it("keeps one complete spoken image name in loading, loaded, error, and empty", async () => {
    await start(markup());
    const expected = ["image, Jane Doe", "image, Jane Doe"];

    expect(await captureSpeech({ container: root(), steps: 1 })).toEqual(expected);
    image().dispatchEvent(new Event("load"));
    expect(await captureSpeech({ container: root(), steps: 1 })).toEqual(expected);
    image().dispatchEvent(new Event("error"));
    expect(await captureSpeech({ container: root(), steps: 1 })).toEqual(expected);

    root().setAttribute("data-stimeo--avatar-src-value", "");
    controller().srcValueChanged();
    await flushMicrotasks();
    expect(root().getAttribute("data-state")).toBe("empty");
    expect(await captureSpeech({ container: root(), steps: 1 })).toEqual(expected);
    expect(image().getAttribute("aria-hidden")).toBe("true");
    expect(fallback().getAttribute("aria-hidden")).toBe("true");
  });

  it("has no machine-detectable a11y violations in image and fallback states", async () => {
    await start(markup());
    await expectNoA11yViolations(root());

    image().dispatchEvent(new Event("error"));
    await expectNoA11yViolations(root());

    root().setAttribute("data-stimeo--avatar-src-value", "");
    controller().srcValueChanged();
    await flushMicrotasks();
    await expectNoA11yViolations(root());
  });
});
