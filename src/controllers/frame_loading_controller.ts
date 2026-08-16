import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { DetachGate } from "../utils/detach_gate";
import { MinDurationFloor } from "../utils/min_duration_floor";
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
 * `start` and `end` dispatch `{}`.
 *
 * @remarks
 * Behavior only — it ships no skeleton markup or styling (pair with Skeleton/CSS);
 * loading is held purely in `aria-busy` / `data-frame-loading` and the optional
 * targets' `hidden`. The `content` target is marked `inert` while loading to block
 * double-submits, and focus inside the frame is explicitly blurred then restored
 * (when `restoreFocus`) so it is testable without relying on emergent `inert`
 * focus behavior. Listeners are torn down on `disconnect()` (Turbo navigation
 * included) along with the {@link MinDurationFloor} holding the finish back, kept
 * across an in-page move by {@link DetachGate}. A detach that keeps the element
 * returns the frame to its idle form, as does {@link BeforeCacheReset} for the
 * snapshot a cached page freezes; a frame render that swaps the targets mid-load
 * re-arms them.
 */
export class FrameLoadingController extends Controller<HTMLElement> {
  static override targets = ["content", "skeleton", "overlay"];
  static override values = {
    announceText: { type: String, default: "" },
    announceReadyText: { type: String, default: "" },
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
  declare announceTextValue: string;
  declare announceReadyTextValue: string;

  readonly #timeouts = new SafeTimeout();
  readonly #floor = new MinDurationFloor(this.#timeouts);
  readonly #gate = new DetachGate();
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindForCache());
  #loading = false;
  /**
   * The optional targets this controller revealed, and the content it marked inert.
   * Held as references rather than re-resolved on the way out: a detach that keeps
   * the element takes the identifier off `data-controller` first, and a scope
   * without its identifier stops resolving targets — the elements to tidy would be
   * unreachable exactly when the tidying matters. They double as the ownership
   * marker, so a `hidden` or an `inert` the consumer wrote is never taken over.
   */
  #revealedSkeleton: HTMLElement | null = null;
  #revealedOverlay: HTMLElement | null = null;
  #inertTarget: HTMLElement | null = null;
  #previousFocus: HTMLElement | null = null;
  /** The id of the retreated element, used to re-find it if the load replaced it. */
  #previousFocusId = "";

  readonly #onStart = (): void => {
    // A (possibly new) fetch began: drop a finish the floor is still holding so the
    // loading state is not torn down mid-load, then begin if not already loading.
    this.#floor.cancel();
    if (!this.#loading) this.#begin();
  };

  readonly #onEnd = (): void => {
    if (!this.#loading) return;
    // The newest end signal owns the finish: the floor replaces whatever it was
    // holding rather than letting a second wait stack behind the first.
    this.#floor.schedule(this.minDurationValue, () => this.#finish());
  };

  override connect(): void {
    this.#gate.cancel();
    this.#beforeCache.activate();
    this.element.addEventListener("turbo:before-fetch-request", this.#onStart);
    this.element.addEventListener("turbo:frame-load", this.#onEnd);
    this.element.addEventListener("turbo:fetch-request-error", this.#onEnd);
  }

  override disconnect(): void {
    this.element.removeEventListener("turbo:before-fetch-request", this.#onStart);
    this.element.removeEventListener("turbo:frame-load", this.#onEnd);
    this.element.removeEventListener("turbo:fetch-request-error", this.#onEnd);
    this.#beforeCache.deactivate();
    this.#gate.disconnected(this, () => this.#teardown());
  }

  /**
   * Drops the held finish and the loading bookkeeping on a real detach, returning
   * the frame to its idle form. No reconnect is coming, so nothing is left that
   * could finish the load and clear the hooks — a detach that keeps the element
   * (a morph dropping the identifier, an exit from a scoped observed root) would
   * otherwise strand it busy and inert. Focus is left where it is: the element is
   * leaving this controller's care, and moving it now would be an unexplained jump.
   */
  #teardown(): void {
    this.#gate.cancel();
    this.#timeouts.clearAll();
    this.#floor.cancel();
    if (this.#loading) this.#rewindHooks();
    this.#loading = false;
    this.#previousFocus = null;
  }

  /**
   * Returns the frame to its idle form for the snapshot Turbo is about to take, so
   * a page reached with the Back button does not restore a frame that is busy and
   * inert with nothing left to finish it. State only — no `end` event and no focus
   * move, because the load did not actually complete.
   *
   * The load is abandoned rather than paused, so the flag and any finish the floor
   * still holds drop along with the hooks. A kept finish would surface after the
   * rewind as exactly the three things this pass exists to avoid — an `end`, a
   * completion announcement, and a focus move — and a kept flag would leave the
   * next fetch on a page that survives a cancelled visit skipping the loading
   * state, its idempotence guard already satisfied.
   */
  #rewindForCache(): void {
    if (!this.#loading) return;
    this.#loading = false;
    this.#floor.cancel();
    this.#rewindHooks();
  }

  /**
   * Clears every hook the loading state writes. Shared by the three ways a load can
   * stop — completion, detach, snapshot — so none of them can drift into tidying
   * only part of it.
   */
  #rewindHooks(): void {
    this.element.removeAttribute("aria-busy");
    this.element.removeAttribute("data-frame-loading");
    if (this.#revealedSkeleton) this.#revealedSkeleton.hidden = true;
    if (this.#revealedOverlay) this.#revealedOverlay.hidden = true;
    this.#revealedSkeleton = null;
    this.#revealedOverlay = null;
    this.#clearInert();
  }

  /**
   * Re-shows a `skeleton` that arrived mid-load. Turbo's frame renderer empties the
   * frame and re-inserts the response's children, so a response's authored (hidden)
   * skeleton can land while a later fetch is still running, and only the controller
   * knows the frame is still busy.
   */
  skeletonTargetConnected(): void {
    if (this.#loading) this.#revealSkeleton();
  }

  /** Re-shows an `overlay` that arrived mid-load — the same swap as the skeleton. */
  overlayTargetConnected(): void {
    if (this.#loading) this.#revealOverlay();
  }

  /**
   * Re-blocks a `content` that arrived mid-load, so the stale copy stays unusable.
   * The element that left is released first and ownership is then decided afresh, so
   * an `inert` the replacement authored stays the consumer's.
   */
  contentTargetConnected(): void {
    if (!this.#loading) return;
    this.#clearInert();
    this.#applyInert();
  }

  /** Reveals the optional `skeleton`, noting it as this controller's to hide again. */
  #revealSkeleton(): void {
    if (!this.hasSkeletonTarget) return;
    this.#revealedSkeleton = this.skeletonTarget;
    this.skeletonTarget.hidden = false;
  }

  /** Reveals the optional `overlay`, noting it as this controller's to hide again. */
  #revealOverlay(): void {
    if (!this.hasOverlayTarget) return;
    this.#revealedOverlay = this.overlayTarget;
    this.overlayTarget.hidden = false;
  }

  /** Enters the loading state: hooks, skeleton/overlay, inert content, focus retreat. */
  #begin(): void {
    this.#loading = true;
    this.#floor.begin();
    this.element.setAttribute("aria-busy", "true");
    this.element.setAttribute("data-frame-loading", "true");
    this.#revealSkeleton();
    this.#revealOverlay();
    this.#applyInert();
    this.#retreatFocus();
    this.dispatch("start", { detail: {} });
    announce(fillTemplate(this.announceTextValue, {}));
  }

  /** Leaves the loading state: restore hooks, hide skeleton/overlay, restore focus. */
  #finish(): void {
    this.#loading = false;
    this.#rewindHooks();
    this.#restoreFocus();
    this.dispatch("end", { detail: {} });
    announce(fillTemplate(this.announceReadyTextValue, {}));
  }

  /** Marks the content inert to block double-submits while stale (if we own it). */
  #applyInert(): void {
    if (!this.hasContentTarget || this.contentTarget.hasAttribute("inert")) return;
    this.contentTarget.setAttribute("inert", "");
    this.#inertTarget = this.contentTarget;
  }

  #clearInert(): void {
    this.#inertTarget?.removeAttribute("inert");
    this.#inertTarget = null;
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
