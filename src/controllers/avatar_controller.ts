import { Controller } from "@hotwired/stimulus";
import { AttributeLease } from "../utils/attribute_lease";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";

/** Public rendering phases exposed through the root's `data-state`. */
type AvatarState = "empty" | "loading" | "loaded" | "error";

/**
 * Headless **Avatar** behavior with image-load fallback. No dedicated APG
 * pattern; it follows the non-text-content practice (WCAG 1.1.1).
 *
 * Markup contract (identifier: `stimeo--avatar`):
 *   <span data-controller="stimeo--avatar" role="img" aria-label="Jane Doe"
 *         data-stimeo--avatar-src-value="/u/123.jpg">
 *     <img alt="" aria-hidden="true"
 *          data-stimeo--avatar-target="image"
 *          data-action="load->stimeo--avatar#onLoad error->stimeo--avatar#onError" />
 *     <span aria-hidden="true" hidden data-stimeo--avatar-target="fallback">JD</span>
 *   </span>
 *
 * The `image` and `fallback` targets are optional. A present `src` Value owns the
 * current image's `src`, including an empty Value that explicitly clears it. When
 * the Value is absent, a directly authored `<img src>` is used instead. Runtime
 * Value changes, direct `src` changes, and target replacements all repaint.
 *
 * The accessible name lives on the container (`role="img"` + `aria-label`); the
 * inner image and fallback are `aria-hidden` so assistive technology reads the
 * name once in every visual state.
 *
 * @remarks
 * Behavior only — shape, size, and colour are the consumer's CSS. Initials or
 * colour generation are out of scope: fallback content comes from markup. The
 * `empty`, `loading`, `loaded`, and `error` phases are exposed on `data-state`.
 * A native error from the current image dispatches `stimeo--avatar:error` with
 * `{ src: string }`; reconnecting or reconciling an already-broken image is
 * silent because no new failure event occurred.
 */
export class AvatarController extends Controller<HTMLElement> {
  static override targets = ["image", "fallback"];
  static override values = { src: String };
  static actions = ["onError", "onLoad"] as const;
  static events = ["error"] as const;

  declare readonly imageTarget: HTMLImageElement;
  declare readonly fallbackTarget: HTMLElement;
  declare readonly hasImageTarget: boolean;
  declare readonly hasFallbackTarget: boolean;
  declare srcValue: string;

  /** Collapses one morph's Value, target, and direct-attribute signals into one pass. */
  readonly #reconcile = new MicrotaskCoalescer(() => this.#render());
  /** Preserves directly-authored source and visibility while targets are controlled. */
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindForCache());
  readonly #src = new AttributeLease<HTMLImageElement>("src");
  readonly #imageHidden = new AttributeLease<HTMLImageElement>("hidden");
  readonly #fallbackHidden = new AttributeLease<HTMLElement>("hidden");
  /** True only while target departure means ownership was actually relinquished. */
  #connected = false;
  /** Watches the non-Value render input used by the direct `<img src>` form. */
  readonly #srcObserver = new MutationObserver((records) => {
    if (records.some((record) => this.hasImageTarget && record.target === this.imageTarget)) {
      this.#reconcile.schedule();
    }
  });

  /** Starts retained-DOM observation and silently derives the current phase. */
  override connect(): void {
    this.#connected = true;
    this.#reconcile.activate();
    this.#beforeCache.activate();
    this.#srcObserver.observe(this.element, {
      attributes: true,
      attributeFilter: ["src"],
      subtree: true,
    });
    this.#render();
  }

  /** Cancels asynchronous work while retaining the last materialized visual state. */
  override disconnect(): void {
    this.#connected = false;
    this.#reconcile.cancel();
    this.#beforeCache.deactivate();
    this.#srcObserver.disconnect();
  }

  /** Repaints when application code or a Turbo morph changes the source Value. */
  srcValueChanged(): void {
    this.#reconcile.schedule();
  }

  /** Applies the current source and phase to an image inserted or replaced at runtime. */
  imageTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Returns attributes borrowed from an image that leaves this live avatar. */
  imageTargetDisconnected(image: HTMLImageElement): void {
    if (this.#connected) {
      this.#src.return(image);
      this.#imageHidden.return(image);
    }
    this.#reconcile.schedule();
  }

  /** Applies the current phase to a fallback inserted or replaced at runtime. */
  fallbackTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Returns authored visibility when a fallback leaves this live avatar. */
  fallbackTargetDisconnected(fallback: HTMLElement): void {
    if (this.#connected) this.#fallbackHidden.return(fallback);
    this.#reconcile.schedule();
  }

  /** Reveals the current image after its native `load` event. */
  onLoad(event: Event): void {
    const image = this.#eventImage(event);
    if (!image) return;
    if (!image.getAttribute("src")) {
      this.#render();
      return;
    }
    this.#reflect("loaded");
  }

  /**
   * Reveals the fallback after the current image's native `error` event.
   *
   * Dispatches `stimeo--avatar:error` with `{ src: string }`, where `src` is
   * the attempted attribute value. Empty/stale/detached image events are ignored.
   */
  onError(event: Event): void {
    const image = this.#eventImage(event);
    if (!image) return;
    const src = image.getAttribute("src");
    if (!src) {
      this.#render();
      return;
    }
    this.#reflect("error");
    this.dispatch("error", { detail: { src } });
  }

  /**
   * Materializes the phase from the final source/target DOM after one mutation batch.
   *
   * Cached success and failure are state reconstruction, not new load events, so
   * this pass never dispatches the public `error` event.
   *
   * @stimeoRenderRoot
   */
  #render(): void {
    if (!this.hasImageTarget) {
      this.#reflect("empty");
      return;
    }

    const image = this.imageTarget;
    const src = this.#applySource(image);
    if (!src) {
      this.#reflect("empty");
      return;
    }
    if (!image.complete) {
      this.#reflect("loading");
      return;
    }
    this.#reflect(image.naturalWidth > 0 ? "loaded" : "error");
  }

  /** Applies Value precedence and returns the effective raw `src` attribute. */
  #applySource(image: HTMLImageElement): string | null {
    if (!this.element.hasAttribute("data-stimeo--avatar-src-value")) {
      this.#src.return(image);
      return image.getAttribute("src");
    }

    const desired = this.srcValue.length > 0 ? this.srcValue : null;
    if (image.getAttribute("src") !== desired) this.#src.write(image, desired);
    return desired;
  }

  /** Accepts an action only from the singular image target currently controlled. */
  #eventImage(event: Event): HTMLImageElement | null {
    const candidate = event.currentTarget;
    if (!(candidate instanceof HTMLImageElement)) return null;
    if (!this.hasImageTarget || candidate !== this.imageTarget) return null;
    return candidate;
  }

  /** Writes the visibility pair and public root state as one controller-owned output. */
  #reflect(state: AvatarState): void {
    const showImage = state === "loading" || state === "loaded";
    if (this.hasImageTarget) {
      this.#imageHidden.write(this.imageTarget, showImage ? null : "");
    }
    if (this.hasFallbackTarget) {
      this.#fallbackHidden.write(this.fallbackTarget, showImage ? "" : null);
    }
    this.element.setAttribute("data-state", state);
  }
  /** Returns borrowed image and fallback semantics before Turbo snapshots the page. */
  #rewindForCache(): void {
    this.#src.returnAll();
    this.#imageHidden.returnAll();
    this.#fallbackHidden.returnAll();
  }
}
