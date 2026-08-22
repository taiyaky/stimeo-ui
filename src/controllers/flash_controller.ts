import { Controller } from "@hotwired/stimulus";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { SafeTimeout } from "../utils/safe_timeout";
import { maxTransitionTotalMs } from "../utils/transition_completion";

/** Flash types that map to an assertive `alert` (everything else is a polite `status`). */
const ASSERTIVE_TYPES = new Set(["alert", "error"]);

/** Selector for message targets, used by the MutationObserver to spot dynamic inserts. */
const MESSAGE_SELECTOR = '[data-stimeo--flash-target="message"]';

/** Per-message auto-dismiss timer bookkeeping (id 0 means paused). */
interface FlashTimer {
  id: number;
  startedAt: number;
  remaining: number;
  /** Active pause reasons; the timer resumes only once every one is released. */
  paused: Set<"focus" | "hover">;
}

/**
 * Headless **Rails flash bridge**: turns server-rendered (and Turbo Stream-inserted)
 * `flash` elements into live-region announcements with auto-dismiss and a stacking
 * cap (no dedicated APG pattern; follows the WAI-ARIA status/alert guidance and WCAG
 * 2.2 **4.1.3 Status Messages**). The general-purpose sibling is Toast; this one is
 * specialized to the Rails `flash` convention.
 *
 * Markup contract (identifier: `stimeo--flash`):
 *   <div data-controller="stimeo--flash" data-stimeo--flash-target="region">
 *     <!-- server-rendered or Turbo Stream-inserted -->
 *     <div data-stimeo--flash-target="message" data-flash-type="notice">Saved</div>
 *   </div>
 *
 * Each message is mapped by `data-flash-type` to `role="status"` (notice) or
 * `role="alert"` (alert/error), flagged `data-flash-state="visible"`, auto-dismissed
 * after `duration` (paused while hovered *or* focused when `pauseOnHover`, and
 * resumed only once both are released), and capped at `max` simultaneous messages.
 * A close button wired to the `dismiss` action removes one manually.
 *
 * `dismiss` dispatches `{ element, reason }`.
 *
 * `show` dispatches `{ type, message }`.
 * `reconcile` dispatches `{ removed: number }` — the messages the Turbo cache
 * rewind took out, which no `dismiss` will report because nobody dismissed them.
 *
 * @remarks
 * Reading is **delegated to the shared Announcer** — but only for the *initial*,
 * page-loaded messages: an in-place live region present at load is not announced by
 * assistive tech, so the controller bridges those via an `stimeo--announcer:announce`
 * event. Messages inserted *later* (Turbo Stream) are announced by their own freshly
 * inserted `role`, exactly like Toast, so they are not bridged again (no double
 * announcement). Behavior only — no styling; `data-flash-state="leaving"` lets CSS
 * animate removal. Focus is never moved (WCAG 2.2 4.1.3): pausing never removes a
 * message, so the control under the pointer or holding focus stays put. The
 * observation follows a `region` element replaced at runtime; the managed set is the
 * current region's subtree, and a message that leaves it gives up its stacking slot,
 * its pending auto-dismiss, and any removal already scheduled. The observer, timers,
 * and per-message listeners are torn down on `disconnect()` (Turbo navigation
 * included), and the managed flashes leave the page before Turbo caches it so a
 * restored snapshot does not replay a notification the visitor already received.
 */
export class FlashController extends Controller<HTMLElement> {
  static override targets = ["region", "message"];
  static override values = {
    duration: { type: Number, default: 5000 },
    pauseOnHover: { type: Boolean, default: true },
    max: { type: Number, default: 0 },
  };
  static actions = ["dismiss"] as const;
  static events = ["show", "dismiss", "reconcile"] as const;

  declare readonly regionTarget: HTMLElement;
  declare readonly messageTargets: HTMLElement[];
  declare readonly hasRegionTarget: boolean;

  declare durationValue: number;
  declare pauseOnHoverValue: boolean;
  declare maxValue: number;

  readonly #timers = new SafeTimeout();
  #observer: MutationObserver | null = null;
  /** Whether the controller is between `connect()` and `disconnect()`. */
  #connected = false;
  /** Auto-dismiss timer state keyed by message element. */
  readonly #state = new Map<HTMLElement, FlashTimer>();
  /** Messages already processed, in insertion order, to enforce `max` and avoid double work. */
  readonly #order: HTMLElement[] = [];
  /**
   * Messages between `leaving` and their removal. {@link FlashController.#beginDismiss}
   * releases the bookkeeping above *before* the transition wait, so for that window the
   * element is in the DOM but in neither collection — without this set a re-scan would
   * read it as a brand-new flash and show it a second time.
   */
  readonly #leaving = new Set<HTMLElement>();

  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindForCache());

  readonly #onEnter = (event: Event): void =>
    this.#pause(event.currentTarget as HTMLElement, event.type === "focusin" ? "focus" : "hover");
  readonly #onLeave = (event: Event): void =>
    this.#resume(event.currentTarget as HTMLElement, event.type === "focusout" ? "focus" : "hover");

  override connect(): void {
    this.#connected = true;
    // Initial, server-rendered flashes: bridge them to the Announcer because an
    // in-place live region present at page load is not announced on its own.
    for (const message of this.messageTargets) {
      if (this.#owns(message)) this.#process(message, true);
    }
    this.#syncObservation();
    this.#beforeCache.activate();
  }

  override disconnect(): void {
    this.#connected = false;
    this.#beforeCache.deactivate();
    this.#stopObserving();
    this.#timers.clearAll();
    for (const message of this.#order) this.#unbindPause(message);
    this.#state.clear();
    this.#order.length = 0;
    // The pending finalizes died with the timers above, so a message still marked
    // `leaving` is free to be shown again by the next connect (a snapshot restore).
    this.#leaving.clear();
  }

  /**
   * Takes the managed flashes out of the page just before Turbo freezes it, so a
   * restored snapshot carries no notification the visitor has already received: the
   * fresh `connect()` there reads a leftover flash as a brand-new one and announces it
   * a second time. A message that never auto-dismisses (`duration: 0`) is one of these
   * too — that value governs the timer, not what belongs in a cached page. Removal
   * only: `dismiss` reports a dismissal, and freezing the page is not one.
   */
  #rewindForCache(): void {
    const removed = this.#order.length;
    for (const message of [...this.#order]) {
      message.remove();
      this.#forget(message);
    }
    for (const message of this.#leaving) message.remove();
    this.#leaving.clear();
    if (removed > 0) this.dispatch("reconcile", { detail: { removed } });
  }

  /** Follows a `region` element swapped in — or arriving — at runtime (Turbo Stream). */
  regionTargetConnected(): void {
    this.#resync();
  }

  /** Releases the observation when the `region` element leaves the target set. */
  regionTargetDisconnected(): void {
    this.#resync();
  }

  /**
   * Whether this controller owns `message`. Ownership is the current `region`'s
   * subtree: a message target anywhere else in the controller's scope is the
   * consumer's, and so is one in a region that has gone away. The initial scan, a
   * re-scan after a `region` swap, and a departure from the target set all resolve
   * ownership through this one test; the observation gets it structurally, by watching
   * that subtree and nothing else.
   */
  #owns(message: HTMLElement): boolean {
    return this.hasRegionTarget && this.regionTarget.contains(message);
  }

  /**
   * Releases a message that left the target set (a Turbo Stream `remove`, the consumer
   * detaching the node, or a morph that rewrote the target attribute in place): it
   * stops occupying a `max` slot, and both its pending auto-dismiss and an already
   * scheduled removal are cancelled. A move *within* the region keeps all of them —
   * which is why the element must still be a message to be treated as one: ownership
   * alone reads an in-place attribute rewrite as a move, and a node outside the target
   * set belongs to the consumer, so nothing here may dismiss it.
   */
  messageTargetDisconnected(message: HTMLElement): void {
    if (!this.#connected) return;
    const moved = this.#owns(message) && message.matches(MESSAGE_SELECTOR);
    if (moved) return;
    this.#forget(message);
    // Ownership is re-checked at both ends of the leaving transition: dropping the
    // claim here is what the pending finalize reads to leave the node alone.
    this.#leaving.delete(message);
  }

  /**
   * Re-points the observation after a `region` swap and picks up the messages the
   * new element brought with it (dynamic inserts, so their own `role` announces
   * them). The `#connected` guard is load-bearing: Stimulus runs target callbacks
   * for the initial markup *before* `connect()` and again during teardown *after*
   * `disconnect()`, and re-observing there would outlive the controller.
   */
  #resync(): void {
    if (!this.#connected) return;
    this.#syncObservation();
    for (const message of this.messageTargets) {
      if (this.#owns(message)) this.#process(message, false);
    }
  }

  /**
   * Points the mutation observation at the current `region` target, re-resolved on
   * every sync rather than captured at connect, so an element swapped in at runtime
   * is observed instead of the detached original.
   */
  #syncObservation(): void {
    this.#stopObserving();
    if (!this.hasRegionTarget || typeof MutationObserver === "undefined") return;
    this.#observer = new MutationObserver((mutations) => this.#onMutations(mutations));
    this.#observer.observe(this.regionTarget, { childList: true, subtree: true });
  }

  #stopObserving(): void {
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /**
   * Pause-on-hover/focus listeners, bound and unbound as a pair so the two sides
   * stay in sync. Binding is gated by `pauseOnHover`; unbinding is unconditional
   * and idempotent (a no-op when nothing was bound), which keeps teardown correct
   * even if `pauseOnHover` were ever toggled during a message's life.
   */
  #bindPause(message: HTMLElement): void {
    if (!this.pauseOnHoverValue) return;
    message.addEventListener("mouseenter", this.#onEnter);
    message.addEventListener("mouseleave", this.#onLeave);
    message.addEventListener("focusin", this.#onEnter);
    message.addEventListener("focusout", this.#onLeave);
  }

  #unbindPause(message: HTMLElement): void {
    message.removeEventListener("mouseenter", this.#onEnter);
    message.removeEventListener("mouseleave", this.#onLeave);
    message.removeEventListener("focusin", this.#onEnter);
    message.removeEventListener("focusout", this.#onLeave);
  }

  /** Dismisses the flash whose close control fired the event. */
  dismiss(event: Event): void {
    const target = (event.currentTarget || event.target) as HTMLElement | null;
    const message = target?.closest<HTMLElement>(MESSAGE_SELECTOR);
    if (message) this.#beginDismiss(message, "user");
  }

  /** Processes messages added after connect (Turbo Stream); their own role announces them. */
  #onMutations(mutations: MutationRecord[]): void {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(MESSAGE_SELECTOR)) this.#process(node, false);
        for (const message of node.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR)) {
          this.#process(message, false);
        }
      }
    }
  }

  /**
   * Applies role/state, wires pause listeners, schedules auto-dismiss, and either
   * bridges to the Announcer (`bridge`, for initial flashes) or leaves the message's
   * own role to do the announcing (dynamic inserts). Idempotent per message.
   */
  #process(message: HTMLElement, bridge: boolean): void {
    if (this.#state.has(message) || this.#order.includes(message)) return;
    if (this.#leaving.has(message)) return;

    const type = message.getAttribute("data-flash-type") ?? "";
    const assertive = ASSERTIVE_TYPES.has(type);
    // Don't clobber an authored role; otherwise map the flash type to a live role.
    if (!message.hasAttribute("role")) {
      message.setAttribute("role", assertive ? "alert" : "status");
    }
    message.setAttribute("data-flash-state", "visible");
    this.#order.push(message);

    this.#bindPause(message);

    const text = message.textContent?.trim() ?? "";
    this.dispatch("show", { target: message, detail: { type, message: text } });
    if (bridge && text) {
      window.dispatchEvent(
        new CustomEvent("stimeo--announcer:announce", { detail: { message: text, assertive } }),
      );
    }

    this.#startTimer(message);
    this.#enforceMax();
  }

  /** Removes the oldest visible flashes once the count exceeds `max` (0 = unlimited). */
  #enforceMax(): void {
    if (this.maxValue <= 0) return;
    while (this.#order.length > this.maxValue) {
      const oldest = this.#order[0];
      if (!oldest) break;
      this.#beginDismiss(oldest, "limit");
    }
  }

  #startTimer(message: HTMLElement, duration = this.durationValue): void {
    if (duration <= 0) return;
    const existing = this.#state.get(message);
    if (existing?.id) this.#timers.clear(existing.id);
    const id = this.#timers.set(() => this.#beginDismiss(message, "timeout"), duration);
    this.#state.set(message, {
      id,
      startedAt: Date.now(),
      remaining: duration,
      paused: existing?.paused ?? new Set(),
    });
  }

  /**
   * Pauses a message's auto-dismiss, banking the time left (hover/focus, WCAG 2.2.1).
   * Hover and focus are independent reasons: the remaining time is banked on the
   * first of them, and {@link FlashController.#resume} waits for the last one.
   */
  #pause(message: HTMLElement, reason: "focus" | "hover"): void {
    const timer = this.#state.get(message);
    if (!timer) return;
    timer.paused.add(reason);
    if (timer.id === 0) return;

    this.#timers.clear(timer.id);
    // The bank has a floor of 1ms, so a deadline already spent when the pause arrives
    // (the timer sat queued in a throttled tab or behind a long task) settles right
    // after the last reason is released rather than during the event that paused it.
    // Pausing therefore never removes a message — which is what keeps the pointer's
    // target under the pointer and the focused control focused (WCAG 2.2 4.1.3).
    // Banking zero instead would strand the message: nothing resumes a spent window.
    const remaining = Math.max(1, timer.remaining - (Date.now() - timer.startedAt));
    this.#state.set(message, { id: 0, startedAt: 0, remaining, paused: timer.paused });
  }

  /** Resumes a paused message's auto-dismiss with the banked time. */
  #resume(message: HTMLElement, reason: "focus" | "hover"): void {
    const timer = this.#state.get(message);
    if (!timer) return;
    timer.paused.delete(reason);
    // Still held by the other reason (the pointer left, focus stayed, or vice versa).
    if (timer.paused.size > 0) return;
    // Only resume a genuinely paused timer; a running one keeps its own deadline.
    if (timer.id !== 0) return;
    this.#startTimer(message, timer.remaining);
  }

  /** Releases every per-message resource: timer, stacking slot, pause listeners. */
  #forget(message: HTMLElement): void {
    const timer = this.#state.get(message);
    if (timer?.id) this.#timers.clear(timer.id);
    this.#state.delete(message);
    const index = this.#order.indexOf(message);
    if (index !== -1) this.#order.splice(index, 1);
    this.#unbindPause(message);
  }

  /** Marks a message leaving, then removes it after its CSS transition and emits dismiss. */
  #beginDismiss(message: HTMLElement, reason: "timeout" | "user" | "limit"): void {
    // One removal, one `dismiss`: a close control fired during the leaving
    // transition, or a repeated request, finds the message already released and
    // must not start a second finalize. Reading the bookkeeping rather than
    // `data-flash-state` also keeps `#enforceMax`'s loop terminating, since the
    // release below is what shrinks `#order`.
    if (!this.#state.has(message) && !this.#order.includes(message)) return;
    this.#forget(message);
    this.#leaving.add(message);

    message.setAttribute("data-flash-state", "leaving");

    const finalize = (): void => {
      // The claim taken above is the license to remove: a message that lost the target
      // attribute during the transition belongs to the consumer by the time this runs.
      if (!this.#leaving.delete(message)) return;
      message.remove();
      this.dispatch("dismiss", { detail: { element: message, reason } });
    };

    const transition = this.#transitionMs(message);
    if (transition > 0) {
      this.#timers.set(finalize, transition);
    } else {
      finalize();
    }
  }

  /** Maximum transition total (duration + delay) of `el` in ms (0 when none / unsupported). */
  #transitionMs(el: HTMLElement): number {
    if (typeof window.getComputedStyle !== "function") return 0;
    return maxTransitionTotalMs(window.getComputedStyle(el));
  }
}
