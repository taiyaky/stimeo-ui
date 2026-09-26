import { Controller } from "@hotwired/stimulus";
import { announce } from "../utils/announce";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { ownerOf } from "../utils/event_owner";
import { KeyedTimers } from "../utils/keyed_timers";
import { ListenerSet } from "../utils/listener_set";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { PausableTimers } from "../utils/pausable_timers";
import { SafeTimeout } from "../utils/safe_timeout";
import { targetSelector } from "../utils/target_selector";
import { maxTransitionTotalMs } from "../utils/transition_completion";

/** Flash types that map to an assertive `alert` (everything else is a polite `status`). */
const ASSERTIVE_TYPES = new Set(["alert", "error"]);

/**
 * The message target's name, from which the selector is built that spots dynamic
 * inserts, resolves a close control's message, and confirms a departed target was one.
 */
const MESSAGE_PART = "message";

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
 * `duration` and `pauseOnHover` are read as each message is taken on, so a change
 * reaches the messages that arrive after it. The cap is applied on every arrival, on
 * every change to `max`, whenever hover and focus have both left a message, and when a
 * message they held leaves: it dismisses the oldest messages with reason `limit`,
 * passing over every message the pointer is over or focus is inside (whatever
 * `pauseOnHover` says), the message just taken on, and the message the pointer or focus
 * is moving into. While nothing else can go, the stack stays over the cap until one of
 * those holds is released.
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
 * animate removal. Focus is never moved (WCAG 2.2 4.1.3): neither a pause nor the `max`
 * cap removes a message the pointer is over or focus is inside, so neither takes away
 * the control under the pointer or holding focus; with `pauseOnHover` off the
 * auto-dismiss still runs out under them. The observation follows a
 * `region` element replaced at runtime; the managed set is the current region's
 * subtree, and a message that leaves it gives up its stacking slot, its pending
 * auto-dismiss, and any removal already scheduled. The observer, timers,
 * and per-message listeners are torn down on `disconnect()` (Turbo navigation
 * included), and the managed flashes leave the page before Turbo caches it so a
 * restored snapshot does not replay a notification the visitor already received.
 */
export class FlashController extends Controller<HTMLElement> {
  /** Selects the message parts, in the namespace this controller is registered under. */
  get #messageSelector(): string {
    return targetSelector(this.identifier, MESSAGE_PART);
  }

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

  /** Removal timers for the leaving transition; the auto-dismiss ones live below. */
  readonly #timers = new SafeTimeout();
  /**
   * Per-message auto-dismiss held open while the message is hovered or focused, and
   * the one record of which messages hover or focus holds, which the cap reads.
   */
  readonly #dismiss = new PausableTimers<HTMLElement>();
  /**
   * Auto-dismiss of the messages taken on while `pauseOnHover` is off. It runs on
   * whatever holds the message; the hold itself still keeps the cap away.
   */
  readonly #fixedDismiss = new KeyedTimers<HTMLElement>();
  /** Applies the cap again once the event that released a hold has run its course. */
  readonly #reapply = new MicrotaskCoalescer(() => this.#reapplyCap());
  /** Messages the pointer or focus moved into since the cap was last applied again. */
  #spared: HTMLElement[] = [];
  /** The next pointer movement, listened for while a hover hold waits on it. */
  readonly #pointer = new ListenerSet();
  /** Messages whose hover hold waits for the next pointer movement to be confirmed. */
  readonly #awaitingPointer = new Set<HTMLElement>();
  #observer: MutationObserver | null = null;
  /** Whether the controller is between `connect()` and `disconnect()`. */
  #connected = false;
  /**
   * The `max` the stack was last held to, or `null` before the first time. `connect()`
   * applies the cap only when `max` is not that one, so a reconnect of the same instance
   * leaves the stack as it was unless `max` changed while it was away.
   */
  #appliedMax: number | null = null;
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
  /**
   * Releases hover or focus on a message. Focus moving between two of the message's
   * own controls is no release, since `focusout` names a control still inside it; and
   * the message the pointer or focus is moving into is spared when the release
   * applies the cap again, because its own hold only arrives after this event.
   */
  readonly #onLeave = (event: MouseEvent | FocusEvent): void => {
    const message = event.currentTarget as HTMLElement;
    const next = ownerOf(this.#order, event.relatedTarget);
    if (next === message) return;
    this.#resume(message, event.type === "focusout" ? "focus" : "hover", next);
  };

  override connect(): void {
    this.#connected = true;
    this.#reapply.activate();
    // Initial, server-rendered flashes: bridge them to the Announcer because an
    // in-place live region present at page load is not announced on its own.
    for (const message of this.messageTargets) {
      if (this.#owns(message)) this.#process(message, true);
    }
    if (!Object.is(this.#appliedMax, this.maxValue)) {
      this.#appliedMax = this.maxValue;
      this.#enforceMax();
    }
    this.#syncObservation();
    this.#beforeCache.activate();
  }

  override disconnect(): void {
    this.#connected = false;
    this.#beforeCache.deactivate();
    this.#stopObserving();
    this.#timers.clearAll();
    this.#dismiss.clearAll();
    this.#fixedDismiss.clearAll();
    this.#reapply.cancel();
    this.#spared = [];
    this.#pointer.dispose();
    this.#awaitingPointer.clear();
    for (const message of this.#order) this.#unbindPause(message);
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
   * Holds the stack to a changed `max`: lowering it below the count dismisses the
   * oldest messages hover and focus do not hold, with reason `limit`, as an arrival
   * past the cap does, while raising it or setting `0` dismisses nothing. Stimulus can
   * also call this ahead of `connect()` — for an attribute that changed while the
   * controller was away, and on every connect for an undeclared `max`, with its default;
   * `connect()` decides then.
   */
  maxValueChanged(): void {
    if (!this.#connected) return;
    this.#appliedMax = this.maxValue;
    this.#enforceMax();
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
   * set belongs to the consumer, so nothing here may dismiss it. A move may still have
   * ended a hold, so those are read again.
   */
  messageTargetDisconnected(message: HTMLElement): void {
    if (!this.#connected) return;
    const moved = this.#owns(message) && message.matches(this.#messageSelector);
    if (moved) {
      this.#afterMove(message);
      return;
    }
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
   * Hover and focus listeners, bound and unbound as a pair so the two sides stay in
   * sync. Every message gets them, whatever `pauseOnHover` says, because the cap reads
   * the holds they record; unbinding is idempotent (a no-op when nothing was bound).
   */
  #bindPause(message: HTMLElement): void {
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
    const message = target?.closest<HTMLElement>(this.#messageSelector);
    if (message) this.#beginDismiss(message, "user");
  }

  /** Processes messages added after connect (Turbo Stream); their own role announces them. */
  #onMutations(mutations: MutationRecord[]): void {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(this.#messageSelector)) this.#process(node, false);
        for (const message of node.querySelectorAll<HTMLElement>(this.#messageSelector)) {
          this.#process(message, false);
        }
      }
    }
  }

  /**
   * Applies role/state, wires pause listeners, takes the holds the message already has,
   * and schedules auto-dismiss. A message `connect()` takes on (`atConnect`) is bridged
   * to the Announcer and meets no cap here, `connect()` holding the stack to it; a later
   * insert announces through its own role and meets the cap as it arrives. Idempotent
   * per message, and a node that has left the region by the time its insertion is
   * reported is not taken on.
   */
  #process(message: HTMLElement, atConnect: boolean): void {
    if (this.#order.includes(message) || this.#leaving.has(message) || !this.#owns(message)) {
      return;
    }

    const type = message.getAttribute("data-flash-type") ?? "";
    const assertive = ASSERTIVE_TYPES.has(type);
    // Don't clobber an authored role; otherwise map the flash type to a live role.
    if (!message.hasAttribute("role")) {
      message.setAttribute("role", assertive ? "alert" : "status");
    }
    message.setAttribute("data-flash-state", "visible");
    this.#order.push(message);

    this.#bindPause(message);
    this.#readHolds(message);

    const text = message.textContent?.trim() ?? "";
    this.dispatch("show", { target: message, detail: { type, message: text } });
    if (atConnect) announce(text, { assertive });

    this.#startTimer(message);
    if (!atConnect) this.#enforceMax([message]);
  }

  /**
   * Dismisses the oldest messages with reason `limit` while more than `max` are shown
   * (0 or less, or not a finite number, means no cap), passing over every message hover
   * or focus holds and those in `spared` — the message just taken on, or the ones the
   * pointer or focus moved into. Only messages still in the region count or go: one a
   * script has just taken out stays on the stack until its removal is reported. With
   * nothing else left to go the stack stays over the cap. The loop walks a copy and
   * re-reads the count on every step, because a `dismiss` listener may already have
   * changed both.
   *
   * @stimeoRenderRoot
   */
  #enforceMax(spared: readonly HTMLElement[] = []): void {
    if (!Number.isFinite(this.maxValue) || this.maxValue <= 0) return;
    for (const message of [...this.#order]) {
      if (this.#shownCount() <= this.maxValue) return;
      if (this.#owns(message) && !spared.includes(message) && !this.#dismiss.isHeld(message)) {
        this.#beginDismiss(message, "limit");
      }
    }
  }

  /** How many messages the stack shows: the ones taken on that are still in the region. */
  #shownCount(): number {
    return this.#order.filter((message) => this.#owns(message)).length;
  }

  /**
   * Arms a message's auto-dismiss; a non-positive `duration` means it never expires.
   * The timer waits out hover and focus when `pauseOnHover` is on, and runs on
   * regardless when it is off.
   *
   * @stimeoRuntimeOnly `duration` is the delay of the one dismissal timer this call arms,
   *   and `pauseOnHover` whether hover and focus hold that timer.
   */
  #startTimer(message: HTMLElement): void {
    if (this.durationValue <= 0) return;
    const dismiss = (): void => this.#beginDismiss(message, "timeout");
    if (this.pauseOnHoverValue) this.#dismiss.set(message, dismiss, this.durationValue);
    else this.#fixedDismiss.set(message, dismiss, this.durationValue);
  }

  /**
   * Records hover or focus on a message. Hover and focus are independent reasons:
   * the registry banks the time left on the first of them and waits for the last
   * (WCAG 2.2 2.2.1), and the cap passes over the message while either is held.
   */
  #pause(message: HTMLElement, reason: "focus" | "hover"): void {
    this.#dismiss.pause(message, reason);
  }

  /**
   * Releases one reason, resuming the banked time once no reason is left. Releasing
   * the last one applies the cap again, sparing `spare`.
   */
  #resume(message: HTMLElement, reason: "focus" | "hover", spare: HTMLElement | null): void {
    const held = this.#dismiss.isHeld(message);
    this.#dismiss.resume(message, reason);
    if (held && !this.#dismiss.isHeld(message)) this.#capLater(spare);
  }

  /**
   * Applies the cap again once the current event is over, sparing `spare`. A hold can
   * end in a `focusout` the engine fires while it is itself taking the node out for a
   * script's move or removal, and dismissing the message inside that event would pull
   * the node from under the caller's own call.
   */
  #capLater(spare: HTMLElement | null): void {
    if (spare) this.#spared.push(spare);
    this.#reapply.schedule();
  }

  /** Applies the cap again, sparing every message gathered since the last pass. */
  #reapplyCap(): void {
    const spared = this.#spared;
    this.#spared = [];
    this.#enforceMax(spared);
  }

  /**
   * Reads the holds of a message that moved within the region. Focus is read at once:
   * an ordinary move ends it with a `focusout` and `moveBefore` keeps it. Where the
   * pointer is, nothing says until it moves again: no `mouseleave` reaches a moved node,
   * and `:hover` can answer from before the move. A message still held waits for that
   * movement.
   */
  #afterMove(message: HTMLElement): void {
    if (!message.contains(document.activeElement)) this.#resume(message, "focus", null);
    if (this.#dismiss.isHeld(message)) this.#awaitPointer(message);
  }

  /**
   * Takes the holds a message already has as it is taken on: focus inside it, and the
   * pointer over it by `:hover`. That answer can date from before the message came here,
   * so a hover hold taken on it waits for the next pointer movement to be confirmed.
   */
  #readHolds(message: HTMLElement): void {
    if (message.contains(document.activeElement)) this.#pause(message, "focus");
    if (!message.matches(":hover")) return;
    this.#pause(message, "hover");
    this.#awaitPointer(message);
  }

  /** Leaves `message`'s hover hold to be confirmed or let go on the next pointer movement. */
  #awaitPointer(message: HTMLElement): void {
    this.#awaitingPointer.add(message);
    this.#pointer.add(document, "pointermove", this.#onPointerMove, {
      capture: true,
      passive: true,
    });
  }

  /**
   * Reads `:hover` once the pointer has moved, when the answer is current, and lets go of
   * the hover hold of every waiting message the pointer is not over. Listens once.
   */
  readonly #onPointerMove = (): void => {
    this.#pointer.dispose();
    const waiting = [...this.#awaitingPointer];
    this.#awaitingPointer.clear();
    for (const message of waiting) {
      if (!message.matches(":hover")) this.#resume(message, "hover", null);
    }
  };

  /**
   * Releases every per-message resource: timers, hold, stacking slot, pause listeners,
   * and the wait on the pointer. A message something still held counts as released: the
   * cap is applied again.
   */
  #forget(message: HTMLElement): void {
    if (this.#dismiss.isHeld(message)) this.#capLater(null);
    this.#dismiss.clear(message);
    this.#fixedDismiss.clear(message);
    const index = this.#order.indexOf(message);
    if (index !== -1) this.#order.splice(index, 1);
    this.#unbindPause(message);
    this.#awaitingPointer.delete(message);
    if (this.#awaitingPointer.size === 0) this.#pointer.dispose();
  }

  /** Marks a message leaving, then removes it after its CSS transition and emits dismiss. */
  #beginDismiss(message: HTMLElement, reason: "timeout" | "user" | "limit"): void {
    // One removal, one `dismiss`: a close control fired during the leaving
    // transition, or a repeated request, finds the message already released and
    // must not start a second finalize. Reading the bookkeeping rather than
    // `data-flash-state` also keeps `#enforceMax`'s count honest, since the release
    // below is what shrinks `#order`.
    if (!this.#order.includes(message)) return;
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
