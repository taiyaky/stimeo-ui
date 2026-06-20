import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";

/**
 * Headless `<turbo-frame>` loading-state behavior: while the frame is fetching it
 * sets `aria-busy` + `data-frame-loading`, reveals an optional skeleton / overlay,
 * suppresses interaction with the stale content, and retreats focus, restoring it on
 * completion (no dedicated APG pattern; supports WCAG 2.2 **4.1.3 Status Messages**
 * via `aria-busy` and 2.4.3 focus order via the retreat/restore).
 *
 * Markup contract (identifier: `stimeo--frame-loading`):
 *   <turbo-frame id="panel" data-controller="stimeo--frame-loading">
 *     <div data-stimeo--frame-loading-target="skeleton" hidden>…</div>
 *     <div data-stimeo--frame-loading-target="content">…</div>
 *   </turbo-frame>
 *
 * It subscribes on the frame to Turbo's own fetch lifecycle: `turbo:before-fetch-request`
 * (which bubbles from the frame's links/forms or the frame itself) starts the loading
 * state, and `turbo:frame-load` ends it (with `turbo:fetch-request-error` as a safety
 * net so the state never sticks). `minDuration` keeps the skeleton up long enough to
 * avoid a flicker.
 *
 * @remarks
 * Behavior only — it ships no skeleton markup or styling (pair with Skeleton/CSS);
 * loading is held purely in `aria-busy` / `data-frame-loading` and the optional
 * targets' `hidden`. The `content` target is marked `inert` while loading to block
 * double-submits, and focus inside the frame is explicitly blurred then restored
 * (when `restoreFocus`) so it is testable without relying on emergent `inert`
 * focus behavior. Listeners and the min-duration timer are torn down on
 * `disconnect()` (Turbo navigation included), which also tidies the hooks so a
 * cached frame is never left busy.
 */
export class FrameLoadingController extends Controller<HTMLElement> {
  static override targets = ["content", "skeleton", "overlay"];
  static override values = {
    minDuration: { type: Number, default: 0 },
    restoreFocus: { type: Boolean, default: true },
  };
  static events = ["start", "end"] as const;

  declare readonly contentTarget: HTMLElement;
  declare readonly skeletonTarget: HTMLElement;
  declare readonly overlayTarget: HTMLElement;
  declare readonly hasContentTarget: boolean;
  declare readonly hasSkeletonTarget: boolean;
  declare readonly hasOverlayTarget: boolean;

  declare minDurationValue: number;
  declare restoreFocusValue: boolean;

  readonly #timeouts = new SafeTimeout();
  #loading = false;
  #startedAt = 0;
  #inertApplied = false;
  #previousFocus: HTMLElement | null = null;
  /** The id of the retreated element, used to re-find it if the load replaced it. */
  #previousFocusId = "";

  readonly #onStart = (): void => {
    // A (possibly new) fetch began: cancel any pending min-duration finish so the
    // loading state is not torn down mid-load, then begin if not already loading.
    this.#timeouts.clearAll();
    if (!this.#loading) this.#begin();
  };

  readonly #onEnd = (): void => {
    if (!this.#loading) return;
    const remaining = this.minDurationValue - (Date.now() - this.#startedAt);
    if (remaining > 0) {
      this.#timeouts.clearAll();
      this.#timeouts.set(() => this.#finish(), remaining);
    } else {
      this.#finish();
    }
  };

  override connect(): void {
    this.element.addEventListener("turbo:before-fetch-request", this.#onStart);
    this.element.addEventListener("turbo:frame-load", this.#onEnd);
    this.element.addEventListener("turbo:fetch-request-error", this.#onEnd);
  }

  override disconnect(): void {
    this.element.removeEventListener("turbo:before-fetch-request", this.#onStart);
    this.element.removeEventListener("turbo:frame-load", this.#onEnd);
    this.element.removeEventListener("turbo:fetch-request-error", this.#onEnd);
    this.#timeouts.clearAll();
    // Tidy the hooks so a cached frame is not restored mid-loading (no focus move —
    // the element is leaving the DOM).
    if (this.#loading) {
      this.element.removeAttribute("aria-busy");
      this.element.removeAttribute("data-frame-loading");
      this.#clearInert();
    }
    this.#loading = false;
    this.#previousFocus = null;
  }

  /** Enters the loading state: hooks, skeleton/overlay, inert content, focus retreat. */
  #begin(): void {
    this.#loading = true;
    this.#startedAt = Date.now();
    this.element.setAttribute("aria-busy", "true");
    this.element.setAttribute("data-frame-loading", "true");
    if (this.hasSkeletonTarget) this.skeletonTarget.hidden = false;
    if (this.hasOverlayTarget) this.overlayTarget.hidden = false;
    this.#applyInert();
    this.#retreatFocus();
    this.dispatch("start", { detail: {} });
  }

  /** Leaves the loading state: restore hooks, hide skeleton/overlay, restore focus. */
  #finish(): void {
    this.#loading = false;
    this.element.removeAttribute("aria-busy");
    this.element.removeAttribute("data-frame-loading");
    if (this.hasSkeletonTarget) this.skeletonTarget.hidden = true;
    if (this.hasOverlayTarget) this.overlayTarget.hidden = true;
    this.#clearInert();
    this.#restoreFocus();
    this.dispatch("end", { detail: {} });
  }

  /** Marks the content inert to block double-submits while stale (if we own it). */
  #applyInert(): void {
    if (!this.hasContentTarget || this.contentTarget.hasAttribute("inert")) return;
    this.contentTarget.setAttribute("inert", "");
    this.#inertApplied = true;
  }

  #clearInert(): void {
    if (!this.#inertApplied) return;
    this.#inertApplied = false;
    if (this.hasContentTarget) this.contentTarget.removeAttribute("inert");
  }

  /** Saves and blurs focus if it sits inside the frame about to go stale. */
  #retreatFocus(): void {
    this.#previousFocus = null;
    this.#previousFocusId = "";
    if (!this.restoreFocusValue) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== this.element && this.element.contains(active)) {
      this.#previousFocus = active;
      this.#previousFocusId = active.id;
      active.blur();
    }
  }

  /**
   * Restores focus after the load. The same node when it survived (e.g. a
   * non-replacing update), else the element re-rendered with the same id inside the
   * frame — Turbo frames typically re-emit the same controls. When neither is present
   * (an anonymous control was replaced) focus is left where the browser put it, to
   * avoid an unexpected jump (WCAG 3.2.x).
   */
  #restoreFocus(): void {
    const target = this.#previousFocus;
    const id = this.#previousFocusId;
    this.#previousFocus = null;
    this.#previousFocusId = "";
    if (!this.restoreFocusValue) return;
    if (target?.isConnected) {
      target.focus();
      return;
    }
    if (id) {
      const replacement = document.getElementById(id);
      if (replacement && this.element.contains(replacement)) replacement.focus();
    }
  }
}
