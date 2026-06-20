import { Controller } from "@hotwired/stimulus";

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
 * Watches the `<img>` `load`/`error` events and swaps to the author-provided
 * fallback when the image fails or no `src` is given. The accessible name lives
 * on the container (`role="img"` + `aria-label`); the inner `<img>` and the
 * fallback are `aria-hidden` so assistive tech reads the name once, regardless of
 * which side is visible.
 *
 * @remarks
 * Behavior only — shape, size, and colour are the consumer's CSS. Initials or
 * colour generation are out of scope: the fallback content comes from markup. The
 * loading/loaded/error phase is exposed on `data-state` so CSS can style each.
 */
export class AvatarController extends Controller<HTMLElement> {
  static override targets = ["image", "fallback"];
  static override values = {
    src: { type: String, default: "" },
  };
  static actions = ["onError", "onLoad"] as const;
  static events = ["error"] as const;

  declare readonly imageTarget: HTMLImageElement;
  declare readonly fallbackTarget: HTMLElement;
  declare readonly hasImageTarget: boolean;
  declare readonly hasFallbackTarget: boolean;

  declare srcValue: string;

  override connect(): void {
    if (!this.hasImageTarget) {
      // Nothing to monitor: surface the fallback so the container is not empty.
      this.#showFallback();
      return;
    }

    // A `src` Value, when present, is the source of truth and is applied to the
    // image; otherwise the markup's own `src` attribute (if any) is honored.
    if (this.srcValue) {
      this.imageTarget.src = this.srcValue;
    }

    const src = this.imageTarget.getAttribute("src");
    if (!src) {
      // No image to load at all — go straight to the fallback without emitting an
      // error event (there was no failed load attempt).
      this.#showFallback();
      return;
    }

    // A cached image may already be complete by the time the controller connects,
    // in which case the `load` event has fired and won't fire again.
    if (this.imageTarget.complete && this.imageTarget.naturalWidth > 0) {
      this.#showImage();
      return;
    }
    if (this.imageTarget.complete && this.imageTarget.naturalWidth === 0 && src) {
      // Complete but with no intrinsic size means the load already failed.
      this.onError();
      return;
    }

    this.#enterLoading();
  }

  /** Reveals the image once it has loaded successfully. */
  onLoad(): void {
    this.#showImage();
  }

  /** Swaps to the fallback when the image fails and emits `error`. */
  onError(): void {
    const src = this.hasImageTarget ? (this.imageTarget.getAttribute("src") ?? "") : "";
    this.#showFallback();
    this.dispatch("error", { detail: { src } });
  }

  /** Loading phase: keep the image visible (per markup) while it fetches. */
  #enterLoading(): void {
    if (this.hasImageTarget) this.imageTarget.hidden = false;
    if (this.hasFallbackTarget) this.fallbackTarget.hidden = true;
    this.element.setAttribute("data-state", "loading");
  }

  /** Loaded phase: image visible, fallback hidden. */
  #showImage(): void {
    if (this.hasImageTarget) this.imageTarget.hidden = false;
    if (this.hasFallbackTarget) this.fallbackTarget.hidden = true;
    this.element.setAttribute("data-state", "loaded");
  }

  /** Error / no-src phase: fallback visible, image hidden. */
  #showFallback(): void {
    if (this.hasImageTarget) this.imageTarget.hidden = true;
    if (this.hasFallbackTarget) this.fallbackTarget.hidden = false;
    this.element.setAttribute("data-state", "error");
  }
}
