import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { AttributeLease } from "../utils/attribute_lease";
import { DetachGate } from "../utils/detach_gate";
import { ListenerSet } from "../utils/listener_set";
import { MinDurationFloor } from "../utils/min_duration_floor";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
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
 * `start`, `end`, and `reconcile` dispatch `{}`. The last of those reports that a
 * connection found the frame marked `data-frame-loading` with no load of its own behind
 * it — a page restored from the Turbo cache in the middle of a load, which can no
 * longer arrive. `end` would claim the frame arrived.
 *
 * @remarks
 * Behavior only — it ships no skeleton markup or styling (pair with Skeleton/CSS);
 * loading is held purely in `aria-busy` / `data-frame-loading` and the optional
 * targets' `hidden`. The `content` target is marked `inert` while loading to block
 * double-submits, and focus inside the frame is explicitly blurred then restored
 * (when `restoreFocus`) so it is testable without relying on emergent `inert`
 * focus behavior. Every one of those attributes is leased, so finishing a load gives
 * back what the author wrote — an authored `aria-busy="false"` stays — and leaves a
 * value the page wrote since alone, and the author's value is recorded on the element
 * for a copy of it to find: a connection with no load of its own gives the hooks a copy
 * of the page carries back to the author, before it reports `reconcile`. Listeners are
 * torn down on `disconnect()` (Turbo navigation included) along with the
 * `MinDurationFloor` holding the finish back, kept across an in-page move and a
 * `data-turbo-permanent` frame Turbo carries to the next page by `DetachGate`. A detach that keeps the element
 * returns the frame to its idle form; a frame render that swaps the targets mid-load
 * re-arms them. A load is never abandoned on `turbo:before-cache`, which Turbo also
 * dispatches on pages that stay — among them the promotion of this very frame's
 * navigation to a page visit, dispatched after `turbo:frame-load` — so a finish held
 * back by `minDuration` still ends the load, announces it and restores focus.
 */
export class FrameLoadingController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override targets = ["content", "skeleton", "overlay"];
  static override values = {
    announceText: { type: String, default: "" },
    announceReadyText: { type: String, default: "" },
    minDuration: { type: Number, default: 0 },
    restoreFocus: { type: Boolean, default: true },
  };

  static valueConstraints = {
    minDuration: NUMBER_BOUNDS.timer,
  } satisfies NumberValueConstraints<typeof FrameLoadingController.values>;
  static events = ["start", "end", "reconcile"] as const;

  declare readonly contentTarget: HTMLElement;
  declare readonly skeletonTarget: HTMLElement;
  declare readonly overlayTarget: HTMLElement;
  declare readonly contentTargets: HTMLElement[];
  declare readonly skeletonTargets: HTMLElement[];
  declare readonly overlayTargets: HTMLElement[];
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
  readonly #listeners = new ListenerSet();
  /** Owns the frame's `aria-busy` for the length of a load. */
  readonly #busy = new AttributeLease<HTMLElement>("aria-busy", this.identifier);
  /** Owns the frame's `data-frame-loading` for the length of a load. */
  readonly #loadingHook = new AttributeLease<HTMLElement>("data-frame-loading", this.identifier);
  /** Owns the `hidden` of the skeleton and overlay a load reveals. */
  readonly #hidden = new AttributeLease<HTMLElement>("hidden", this.identifier);
  /** Owns the `inert` a load puts on the content. */
  readonly #inert = new AttributeLease<HTMLElement>("inert", this.identifier);
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

  /**
   * @stimeoRuntimeOnly `minDuration` holds the loading state at least this long for the one load
   *   that ended.
   */
  readonly #onEnd = (): void => {
    if (!this.#loading) return;
    // The newest end signal owns the finish: the floor replaces whatever it was
    // holding rather than letting a second wait stack behind the first.
    this.#floor.schedule(this.#safeMinDuration, () => this.#finish());
  };

  override connect(): void {
    this.#gate.cancel();
    this.#listeners.add(this.element, "turbo:before-fetch-request", this.#onStart);
    this.#listeners.add(this.element, "turbo:frame-load", this.#onEnd);
    this.#listeners.add(this.element, "turbo:fetch-request-error", this.#onEnd);
    if (this.#loading) return;
    // The hook says a load is running, and no load of this instance is: the markup
    // outlived the load that wrote it.
    const stale = this.element.hasAttribute("data-frame-loading");
    this.#returnCopied();
    if (stale) this.dispatch("reconcile", { detail: {} });
  }

  /** Gives back the hooks a copy of the page carries from a load of an earlier instance. */
  #returnCopied(): void {
    this.#busy.return(this.element);
    this.#loadingHook.return(this.element);
    for (const region of [...this.skeletonTargets, ...this.overlayTargets]) {
      this.#hidden.return(region);
    }
    for (const content of this.contentTargets) this.#inert.return(content);
  }

  override disconnect(): void {
    this.#listeners.dispose();
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
    this.#timeouts.clearAll();
    if (this.#loading) this.#rewindHooks();
    this.#loading = false;
    this.#previousFocus = null;
  }

  /**
   * Gives back every hook the loading state writes. Shared by the two ways a load can
   * stop — completion and detach — so neither can drift into tidying only part of it.
   */
  #rewindHooks(): void {
    this.#busy.return(this.element);
    this.#loadingHook.return(this.element);
    if (this.#revealedSkeleton) this.#hidden.return(this.#revealedSkeleton);
    if (this.#revealedOverlay) this.#hidden.return(this.#revealedOverlay);
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

  /**
   * Shows the `skeleton` that stays when an earlier one leaves mid-load, hiding the
   * departing one first when this controller revealed it. A departure that still
   * resolves as a target is an in-page move and changes nothing.
   */
  skeletonTargetDisconnected(skeleton: HTMLElement): void {
    if (this.#loading && !this.skeletonTargets.includes(skeleton)) this.#revealSkeleton();
  }

  /** Re-shows an `overlay` that arrived mid-load — the same swap as the skeleton. */
  overlayTargetConnected(): void {
    if (this.#loading) this.#revealOverlay();
  }

  /** Shows the `overlay` that stays when an earlier one leaves mid-load, as the skeleton does. */
  overlayTargetDisconnected(overlay: HTMLElement): void {
    if (this.#loading && !this.overlayTargets.includes(overlay)) this.#revealOverlay();
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

  /**
   * Blocks the `content` that stays when an earlier one leaves mid-load, releasing
   * the departing one first. A departure that still resolves as a target is an
   * in-page move and changes nothing.
   */
  contentTargetDisconnected(content: HTMLElement): void {
    if (!this.#loading || this.contentTargets.includes(content)) return;
    this.#clearInert();
    this.#applyInert();
  }

  /** Reveals the optional `skeleton`, noting it as this controller's to hide again. */
  #revealSkeleton(): void {
    const next = this.hasSkeletonTarget ? this.skeletonTarget : null;
    this.#revealedSkeleton = this.#reveal(this.#revealedSkeleton, next);
  }

  /** Reveals the optional `overlay`, noting it as this controller's to hide again. */
  #revealOverlay(): void {
    const next = this.hasOverlayTarget ? this.overlayTarget : null;
    this.#revealedOverlay = this.#reveal(this.#revealedOverlay, next);
  }

  /**
   * Shows `next` and returns it as the element revealed now, first giving back the one
   * revealed before when that is another element: the reveal follows the first target,
   * so one that an arrival ahead of it or a departure displaced is not left shown.
   */
  #reveal(revealed: HTMLElement | null, next: HTMLElement | null): HTMLElement | null {
    if (revealed && revealed !== next) this.#hidden.return(revealed);
    if (next) this.#hidden.write(next, null);
    return next;
  }

  /**
   * Enters the loading state: hooks, skeleton/overlay, inert content, focus retreat.
   *
   * @stimeoRuntimeOnly `announceText` words the one announcement of this load and `restoreFocus`
   *   decides whether focus leaves the frame it covers.
   */
  #begin(): void {
    this.#loading = true;
    this.#floor.begin();
    this.#busy.write(this.element, "true");
    this.#loadingHook.write(this.element, "true");
    this.#revealSkeleton();
    this.#revealOverlay();
    this.#applyInert();
    this.#retreatFocus();
    this.dispatch("start", { detail: {} });
    announce(fillTemplate(this.announceTextValue, {}));
  }

  /**
   * Leaves the loading state: restore hooks, hide skeleton/overlay, restore focus.
   *
   * @stimeoRuntimeOnly `announceReadyText` words the one announcement of this finished load and
   *   `restoreFocus` decides whether focus goes back.
   */
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
    this.#inert.write(this.contentTarget, "");
    this.#inertTarget = this.contentTarget;
  }

  #clearInert(): void {
    if (this.#inertTarget) this.#inert.return(this.#inertTarget);
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
  /** Current `minDuration` declaration resolved against its numeric contract. */
  get #safeMinDuration(): number {
    return this.#numbers.read(
      this,
      "minDuration",
      this.minDurationValue,
      FrameLoadingController.values.minDuration.default,
      FrameLoadingController.valueConstraints.minDuration,
    );
  }
}
