/**
 * Restores a real-browser image-loading lifecycle for happy-dom so image-driven
 * controllers can be tested deterministically.
 *
 * happy-dom never fetches images, and as of 20.10 it reports every `<img>` — even
 * one whose `src` was just assigned — as `complete = true` with
 * `naturalWidth = 0`. In a real browser, assigning `src` starts an asynchronous
 * load, so `complete` stays `false` until the `load`/`error` event resolves it.
 * The avatar controller depends on that window: a connected-but-pending image is
 * "loading", while a `complete` image with zero intrinsic size is a load that
 * already failed. With happy-dom's always-complete images the controller reports
 * `error` the instant a `src` is applied, so the "loading" assertions fail.
 *
 * This shim makes the lifecycle deterministic and real-browser-accurate: an
 * `<img>` with a `src` is `complete = false` (loading) until a `load` or `error`
 * event is dispatched on it — which is exactly how the tests drive the
 * transitions — after which it reports `complete = true`. Resolution is tracked
 * per *source value*, so assigning a new `src` starts a fresh load and reverts
 * the image to pending (matching browsers, e.g. when swapping to a fallback
 * image). An `<img>` with no `src` stays `complete = true` (nothing to load).
 *
 * Tests that need a specific cached state still set `complete`/`naturalWidth`
 * directly on the instance; an own property shadows this prototype getter, so
 * those overrides keep winning untouched.
 */
const imageProto = HTMLImageElement.prototype;
const nativeComplete = Object.getOwnPropertyDescriptor(imageProto, "complete");

// The `src` each <img> was last resolved at, via a dispatched `load`/`error`.
// Those events do not bubble, but the capture phase still reaches a
// document-level listener for any connected node — which the tests guarantee
// (markup is mounted on the body). Keying on the value, not just the element,
// means a later `src` reassignment no longer matches and reverts to pending.
const resolvedSrc = new WeakMap<HTMLImageElement, string>();
const markResolved = (event: Event): void => {
  const img = event.target;
  if (img instanceof HTMLImageElement) resolvedSrc.set(img, img.getAttribute("src") ?? "");
};
document.addEventListener("load", markResolved, true);
document.addEventListener("error", markResolved, true);

Object.defineProperty(imageProto, "complete", {
  configurable: true,
  enumerable: nativeComplete?.enumerable ?? false,
  get(this: HTMLImageElement): boolean {
    const src = this.getAttribute("src");
    // Nothing to load → complete (per browsers). Otherwise it is complete only
    // once a load/error has resolved *this* src; a newly assigned src reverts to
    // pending (loading).
    return !src || resolvedSrc.get(this) === src;
  },
});

// Side-effect-only setup: keep declarations file-scoped under isolatedModules.
export {};
