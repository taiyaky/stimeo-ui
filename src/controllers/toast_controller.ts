import { Controller } from "@hotwired/stimulus";
import { type ActionSource, actionSource } from "../utils/action_source";
import { ownerOf } from "../utils/event_owner";
import { ListenerSet } from "../utils/listener_set";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { PausableTimers } from "../utils/pausable_timers";
import { SafeTimeout } from "../utils/safe_timeout";
import type { StateReason } from "../utils/state_reason";
import { targetSelector } from "../utils/target_selector";
import { cloneTemplateRoot } from "../utils/template_row";
import { maxTransitionTotalMs } from "../utils/transition_completion";

const DELEGATED_EVENTS = ["click", "focusin", "focusout", "keydown", "mouseover", "mouseout"];

/**
 * Headless, highly accessible toast notification behavior.
 *
 * Capacity evicts by arrival order, independent of DOM order. The same controller
 * instance preserves that order across reconnects; a new instance uses DOM order.
 *
 * Markup contract (identifier: `stimeo--toast`):
 *   <div data-controller="stimeo--toast"
 *        data-stimeo--toast-duration-value="5000"
 *        data-stimeo--toast-max-value="3">
 *     <!-- Attribute-only trigger: no hand-written JS required. -->
 *     <button data-action="click->stimeo--toast#show"
 *             data-stimeo--toast-message-param="Saved"
 *             data-stimeo--toast-type-param="status">Show</button>
 *     <!-- The live region is a descendant; the controller element only needs
 *          to enclose both the trigger(s) and the list/template targets. -->
 *     <div role="region" aria-label="Notifications">
 *       <ol data-stimeo--toast-target="list"></ol>
 *       <template data-stimeo--toast-target="template">
 *         <li data-stimeo--toast-target="item" tabindex="0">
 *           <span role="status" data-toast-slot="message"></span>
 *           <button type="button" data-toast-dismiss>Dismiss</button>
 *         </li>
 *       </template>
 *     </div>
 *   </div>
 *
 * Implements WAI-ARIA live region status/alert announcements, limits simultaneous
 * elements, and pauses dismiss timeouts on hover or focus to comply with WCAG 2.2.1.
 * Pausing never dismisses: a deadline that lapsed while the timer sat queued settles
 * once the last of hover and focus is released, so the pointer's target and the
 * focused control stay where they are.
 *
 * `duration` is read as each toast is taken on. While the controller stays connected
 * a toast already shown keeps the deadline it was given — a change neither shortens,
 * stretches nor restarts it, and the time a hover or focus hold banked stays banked —
 * and the next toast takes the new value. A change on its own arms, dismisses and
 * reports nothing. A connection that finds toasts already in the list arms each of
 * them from the current `duration`.
 *
 * The `max` limit (`0` or less, or not a finite number, means none) keeps them there too.
 * Past it the oldest toasts go with reason `limit`, passing over every toast the pointer
 * is over or focus is inside — whether or not a timer runs — the toast just taken on, and
 * the one the pointer or focus is moving into. While nothing else can go the list stays
 * over the limit, and the limit is applied again once hover and focus have both left a
 * toast, or a toast they held leaves the list.
 *
 * `dismiss` dispatches `{ item: HTMLElement, reason: StateReason }`.
 *
 * `show` dispatches `{ item: HTMLElement }`.
 *
 * @remarks
 * Behavior only. The controller handles state updates via `data-state` and lifecycle events
 * while leaving visual styling completely to the client's CSS transitions.
 */
export class ToastController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override targets = ["list", "template", "item"];
  static override values = {
    duration: { type: Number, default: 0 },
    max: { type: Number, default: 3 },
  };

  static valueConstraints = {
    duration: NUMBER_BOUNDS.timer,
    max: NUMBER_BOUNDS.finite,
  } satisfies NumberValueConstraints<typeof ToastController.values>;
  static actions = ["dismiss", "onKeydown", "pause", "resume", "show"] as const;
  static events = ["dismiss", "show"] as const;

  declare readonly listTarget: HTMLElement;
  declare readonly templateTarget: HTMLTemplateElement;
  declare readonly itemTargets: HTMLElement[];
  declare readonly hasListTarget: boolean;
  declare readonly hasTemplateTarget: boolean;

  declare durationValue: number;
  declare maxValue: number;

  /** Removal timers for the leaving transition; the auto-dismiss ones live below. */
  #timers = new SafeTimeout();

  /** Per-toast auto-dismiss, held open while the toast is hovered or focused. */
  readonly #dismiss = new PausableTimers<HTMLElement>();

  /** Toasts taken on and not let go; a move within the list keeps a toast here. */
  readonly #taken = new Set<HTMLElement>();

  /** Toasts reported while they sat outside the first list, left for the list that stays. */
  readonly #outside = new WeakSet<HTMLElement>();

  /** The phase of each retained toast, independent of its rendered state hook. */
  readonly #phases = new WeakMap<HTMLElement, "entering" | "visible" | "leaving">();

  /** Applies the `max` limit again once the event that released a hold has run its course. */
  readonly #reapply = new MorphRenderWatcher(() => this.#reapplyLimit());

  /** Toasts the pointer or focus moved into since the limit was last applied again. */
  #spared: HTMLElement[] = [];

  /** The next pointer movement, listened for while a hover hold waits on it. */
  readonly #pointer = new ListenerSet();

  /** Toasts whose hover hold waits for the next pointer movement to be confirmed. */
  readonly #awaitingPointer = new Set<HTMLElement>();

  /**
   * Pending one-shot `requestAnimationFrame` handles (the entering→visible flip).
   * Tracked so {@link disconnect} can cancel any that have not fired, preventing a
   * detached element from being mutated after it leaves the DOM (Turbo).
   */
  #rafHandles = new Map<HTMLElement, number>();

  /** The stable list that owns delegated listeners for dynamically added items. */
  #delegatedList: HTMLElement | null = null;

  /** Whether the controller is between `connect()` and `disconnect()`. */
  #connected = false;
  /** Intake order retained while the same instance reconnects. */
  readonly #arrivals = new Set<HTMLElement>();

  /**
   * The `max` the list was last held to, or `null` before the first time. `connect()`
   * applies the limit only when `max` is not that one, so a reconnect of the same instance
   * leaves the list as it was unless `max` changed while it was away.
   */
  #appliedMax: number | null = null;

  /**
   * Stimulus reports every toast the list already holds before this runs, and each is
   * taken on then with its holds, meeting no limit. The limit is applied here once, over
   * all of them, unless the list was already held to the current `max`.
   */
  override connect(): void {
    this.#connected = true;
    const current = this.itemTargets;
    for (const item of this.#arrivals) {
      if (!current.includes(item)) this.#arrivals.delete(item);
    }
    this.#reapply.observe(this.element);
    this.#connectDelegatedEvents();
    for (const item of this.itemTargets) {
      if (!this.#dismiss.tracks(item) && item.dataset.state !== "leaving") {
        this.#startTimer(item);
      }
    }
    if (!Object.is(this.#appliedMax, this.#safeMax)) {
      this.#appliedMax = this.#safeMax;
      this.#enforceMax();
    }
  }

  override disconnect(): void {
    this.#connected = false;
    // Both registries own every timer the controller schedules, so a call each
    // leaves none to fire against the detached controller.
    this.#disconnectDelegatedEvents();
    this.#timers.clearAll();
    this.#dismiss.clearAll();
    this.#taken.clear();
    this.#reapply.disconnect();
    this.#spared = [];
    this.#pointer.dispose();
    this.#awaitingPointer.clear();
    for (const handle of this.#rafHandles.values()) {
      window.cancelAnimationFrame(handle);
    }
    this.#rafHandles.clear();
  }

  /** Keeps delegated interaction on the first list when a list arrives. */
  listTargetConnected(): void {
    if (this.#delegatedList !== this.listTarget) this.#connectDelegatedEvents();
  }

  /**
   * Moves delegation to the list that stays and takes in the toasts it held while an earlier
   * list was first. A toast that arrives with the list in the same task is left to
   * `itemTargetConnected`, which applies the limit.
   */
  listTargetDisconnected(element: HTMLElement): void {
    if (this.#delegatedList === element) this.#disconnectDelegatedEvents();
    if (!this.#connected || !this.hasListTarget || this.listTarget === element) return;
    if (this.#delegatedList !== this.listTarget) this.#connectDelegatedEvents();
    for (const item of this.itemTargets) {
      if (this.#outside.has(item)) this.#takeIn(item);
    }
  }

  /**
   * Holds the list to a changed `max`. Stimulus can also call this ahead of `connect()` —
   * for an attribute that changed while the controller was away, and on every connect
   * for an undeclared `max`, with its default; `connect()` decides then.
   */
  maxValueChanged(): void {
    if (!this.#connected) return;
    this.#appliedMax = this.#safeMax;
    this.enforceMaxLimit();
  }

  /**
   * Stimulus lifecycle callback triggered automatically when a new item target
   * enters the DOM, from a client-side injection or a Turbo Stream append alike, and for
   * every toast the list already holds ahead of `connect()`. An item already leaving,
   * parented outside `list`, or already taken on (a move within the list) is skipped; any
   * other is taken on with the holds it already has. On a connected controller the `max`
   * limit is then applied, never to the arrival itself; the toasts reported ahead of
   * `connect()` are left to it.
   */
  itemTargetConnected(element: HTMLElement): void {
    if (this.#takeIn(element) && this.#connected) this.#enforceMax([element]);
  }

  /**
   * Takes on a toast of the list with the holds it already has, arms its timer and starts its
   * entering phase, and reports whether it did. A toast already taken on, already leaving or
   * parented outside `list` is skipped; one outside `list` is remembered for the list that stays.
   */
  #takeIn(element: HTMLElement): boolean {
    if (this.#taken.has(element) || element.dataset.state === "leaving") return false;
    if (element.parentNode !== this.listTarget) {
      this.#outside.add(element);
      return false;
    }

    this.#taken.add(element);
    this.#arrivals.add(element);
    this.#readHolds(element);
    this.#startTimer(element);
    this.#setPhase(element, "entering");
    const handle = window.requestAnimationFrame(() => {
      this.#rafHandles.delete(element);
      if (element.parentNode !== this.listTarget || element.dataset.state === "leaving") return;
      this.#setPhase(element, "visible");
    });
    this.#rafHandles.set(element, handle);
    return true;
  }

  /**
   * Lets go of a toast that left the list or stopped being an item: its timer, holds,
   * `data-paused` and pending frame. After a move within the list the node is already
   * back, still an item, when Stimulus reports it, so it keeps all of those, and only the
   * holds the move may have ended are read again.
   */
  itemTargetDisconnected(element: HTMLElement): void {
    const moved =
      this.#isShown(element) && element.matches(targetSelector(this.identifier, "item"));
    if (moved) {
      this.#afterMove(element);
      return;
    }
    this.#taken.delete(element);
    this.#phases.delete(element);
    if (this.#connected) this.#arrivals.delete(element);
    element.removeAttribute("data-paused");
    this.#letGo(element);
    this.#cancelAnimation(element);
  }

  /**
   * Shows a new toast. Accepts its content from either a Stimulus action param
   * (attribute-only trigger) or a programmatic `show` CustomEvent `detail`
   * (remote / Turbo trigger); the action param wins when both are present.
   *
   *   <button data-action="click->stimeo--toast#show"
   *           data-stimeo--toast-message-param="Saved"
   *           data-stimeo--toast-type-param="status">Show</button>
   *
   *   element.dispatchEvent(new CustomEvent("show", { detail: { message, type } }))
   *
   * Clones the template slot, interpolates the message, and appends to the list.
   * `message` is the wording key the rest of the library dispatches under, so a
   * part that already carries its own wording — `stimeo--clipboard:copy`,
   * `stimeo--auto-submit:done` — wires straight into this action.
   */
  show(event: Event): void {
    if (!this.hasTemplateTarget || !this.hasListTarget) return;

    const message = this.#readField(event, "message");
    if (!message) return;

    // The toast is the template's only element, cloned on its own, so the node
    // appended here is exactly the one a later dismissal takes back and the list
    // holds nothing but toasts. Anything standing beside it would never be shown.
    const template = this.templateTarget;
    const item = cloneTemplateRoot(template);
    if (template.content.children.length !== 1) return;
    if (!item?.matches(targetSelector(this.identifier, "item"))) return;

    const messageSlot = item.querySelector<HTMLElement>("[data-toast-slot='message']");
    if (!messageSlot) return;
    messageSlot.textContent = message;

    // Validate the live-region role at runtime; untrusted params/detail could
    // otherwise write an invalid ARIA role. Anything but "alert" stays polite.
    messageSlot.setAttribute(
      "role",
      this.#readField(event, "type") === "alert" ? "alert" : "status",
    );

    this.listTarget.appendChild(item);
    this.dispatch("show", { detail: { item } });
  }

  /**
   * Reads a string field from a Stimulus action param or a CustomEvent `detail`,
   * preferring the action param. Returns null unless a non-empty string is found,
   * so untrusted runtime payloads cannot inject non-string values.
   */
  #readField(event: Event, key: "message" | "type"): string | null {
    const params = (event as { params?: Record<string, unknown> }).params;
    const fromParams = params?.[key];
    if (typeof fromParams === "string" && fromParams.length > 0) return fromParams;

    const detail = (event as CustomEvent<unknown>).detail;
    if (detail && typeof detail === "object" && key in detail) {
      const value = (detail as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return null;
  }

  /** Dismisses an owned item or descendant, or the item a DOM action operated. */
  dismiss(input: Event | HTMLElement): void {
    const source = actionSource(input);
    const item = this.#itemFromSource(source);
    if (!item) return;

    this.#removeWithTransition(item, source.reason);
  }

  /** Dismisses the focused toast when Escape is pressed. */
  onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      // Leave a press an inner handler already owned.
      // A press during IME composition (a text field inside the toast) cancels
      // the conversion, never the toast.
      if (event.defaultPrevented || event.isComposing) return;
      const item = this.#itemFromSource(actionSource(event));
      if (!item) return;

      event.preventDefault();
      this.#removeWithTransition(item, "user");
    }
  }

  /**
   * Pauses the auto-dismiss timer on mouse entry or keyboard focus.
   *
   * Hover and focus are tracked as independent reasons: the timer is only
   * snapshotted on the first active reason, and only resumed once *every*
   * reason has been released (see {@link resume}). This keeps a toast paused
   * while it is still hovered *or* focused, per WCAG 2.2.1. The hold is recorded
   * whether or not a timer runs, so the `max` limit passes over the toast either
   * way; `data-paused` marks a timer that stopped, and only that. An explicit
   * item or descendant holds the hover reason, shared with pointer entry.
   */
  pause(input: Event | HTMLElement): void {
    const source = actionSource(input);
    const item = this.#itemFromSource(source);
    if (item && this.#dismiss.pause(item, this.#pauseReason(source.event))) {
      item.setAttribute("data-paused", "true");
    }
  }

  /**
   * Resumes the auto-dismiss timer once both hover and focus have been released,
   * and then applies the `max` limit again, sparing the toast the pointer or focus is
   * moving into: its own hold only arrives after this event. An explicit item
   * or descendant releases the hover reason without releasing a focus hold.
   */
  resume(input: Event | HTMLElement): void {
    const source = actionSource(input);
    const item = this.#itemFromSource(source);
    if (item) {
      this.#release(
        item,
        this.#pauseReason(source.event),
        ownerOf(this.itemTargets, (source.event as Partial<FocusEvent> | null)?.relatedTarget),
      );
    }
  }

  /** Releases one reason on `item`; releasing the last one applies the limit again. */
  #release(item: HTMLElement, reason: "focus" | "hover", spare: HTMLElement | null): void {
    const held = this.#dismiss.isHeld(item);
    if (this.#dismiss.resume(item, reason)) item.removeAttribute("data-paused");
    if (held && !this.#dismiss.isHeld(item)) this.#limitLater(spare);
  }

  /**
   * Applies the limit again once the current event is over, sparing `spare`. A hold can
   * end in a `focusout` the engine fires while it is itself taking the node out for a
   * script's move or removal, and taking the toast away inside that event would pull
   * the node from under the caller's own call.
   */
  #limitLater(spare: HTMLElement | null): void {
    if (spare) this.#spared.push(spare);
    this.#reapply.schedule();
  }

  /** Records a phase and publishes its state hook without changing any deadline. */
  #setPhase(item: HTMLElement, phase: "entering" | "visible" | "leaving"): void {
    this.#phases.set(item, phase);
    item.setAttribute("data-state", phase);
  }

  /** Applies the limit again, sparing every toast gathered since the last pass. */
  #reapplyLimit(): void {
    for (const item of this.itemTargets) {
      if (!this.#taken.has(item) || !this.hasListTarget || item.parentNode !== this.listTarget)
        continue;
      const phase = this.#phases.get(item);
      if (item.dataset.state === "leaving") this.#phases.set(item, "leaving");
      else if (phase) item.setAttribute("data-state", phase);
      if (this.#dismiss.isHeld(item) && this.#dismiss.tracks(item))
        item.setAttribute("data-paused", "true");
      else item.removeAttribute("data-paused");
    }
    const spared = this.#spared;
    this.#spared = [];
    this.#enforceMax(spared);
  }

  /**
   * Reads the holds of a toast that moved within the list. Focus is read at once: an
   * ordinary move ends it with a `focusout` and `moveBefore` keeps it. Where the pointer
   * is, nothing says until it moves again: no `mouseout` reaches a moved node, and
   * `:hover` can answer from before the move. A toast still held waits for that movement.
   */
  #afterMove(item: HTMLElement): void {
    if (!item.contains(document.activeElement)) this.#release(item, "focus", null);
    if (this.#dismiss.isHeld(item)) this.#awaitPointer(item);
  }

  /**
   * Takes the holds a toast already has as it is taken on: focus inside it, and the pointer
   * over it by `:hover`. That answer can date from before the toast came here, so a hover
   * hold taken on it waits for the next pointer movement to be confirmed.
   */
  #readHolds(item: HTMLElement): void {
    if (item.contains(document.activeElement)) this.#dismiss.pause(item, "focus");
    if (!item.matches(":hover")) return;
    this.#dismiss.pause(item, "hover");
    this.#awaitPointer(item);
  }

  /** Leaves `item`'s hover hold to be confirmed or let go on the next pointer movement. */
  #awaitPointer(item: HTMLElement): void {
    this.#awaitingPointer.add(item);
    this.#pointer.add(document, "pointermove", this.#onPointerMove, {
      capture: true,
      passive: true,
    });
  }

  /**
   * Reads `:hover` once the pointer has moved, when the answer is current, and lets go of
   * the hover hold of every waiting toast the pointer is not over. Listens once.
   */
  readonly #onPointerMove = (): void => {
    this.#pointer.dispose();
    const waiting = [...this.#awaitingPointer];
    this.#awaitingPointer.clear();
    for (const item of waiting) {
      if (!item.matches(":hover")) this.#release(item, "hover", null);
    }
  };

  /**
   * Drops a toast's timer and holds as it leaves, and stops waiting on the pointer for it.
   * A toast something still held counts as released: the limit is applied again.
   */
  #letGo(item: HTMLElement): void {
    if (this.#dismiss.isHeld(item)) this.#limitLater(null);
    this.#dismiss.clear(item);
    this.#awaitingPointer.delete(item);
    if (this.#awaitingPointer.size === 0) this.#pointer.dispose();
  }

  /** Resolves a current owned item from an action's origin or binding host. */
  #itemFromSource(source: ActionSource): HTMLElement | null {
    const target = source.origin ?? source.host;
    if (!target || !this.hasListTarget) return null;
    if (target.closest(`[data-controller~="${this.identifier}"]`) !== this.element) return null;
    const item = target.closest<HTMLElement>(targetSelector(this.identifier, "item"));
    return item && this.itemTargets.includes(item) && this.listTarget.contains(item) ? item : null;
  }

  /** Classifies a pause/resume event as a hover or focus reason. */
  #pauseReason(event?: Event | null): "focus" | "hover" {
    return event?.type === "focusin" || event?.type === "focusout" ? "focus" : "hover";
  }

  /**
   * Arms a toast's auto-dismiss as it is taken on; a non-positive `duration` means it
   * never expires. The toast keeps this deadline when `duration` changes later.
   * On a toast hover or focus already holds, the timer waits for the release.
   * `data-paused` is written from that state, so a mark the toast carried in with it,
   * from a restored page, does not outlive it.
   *
   * @stimeoRuntimeOnly `duration` is the delay of the one dismissal timer this call arms.
   */
  #startTimer(element: HTMLElement): void {
    if (element.dataset.state === "leaving" || element.parentNode !== this.listTarget) return;

    const armed = this.#safeDuration > 0;
    if (armed) {
      this.#dismiss.set(
        element,
        () => this.#removeWithTransition(element, "timeout"),
        this.#safeDuration,
      );
    }
    if (armed && this.#dismiss.isHeld(element)) element.setAttribute("data-paused", "true");
    else element.removeAttribute("data-paused");
  }

  #removeWithTransition(element: HTMLElement, reason: StateReason): void {
    if (element.dataset.state === "leaving" || element.parentNode !== this.listTarget) return;

    this.#letGo(element);
    this.#cancelAnimation(element);
    this.#setPhase(element, "leaving");

    const finalize = () => {
      if (element.parentNode !== this.listTarget) return;
      this.listTarget.removeChild(element);
      this.dispatch("dismiss", { detail: { item: element, reason } });
    };

    const duration = maxTransitionTotalMs(window.getComputedStyle(element));
    if (duration > 0) {
      this.#timers.set(finalize, duration);
    } else {
      finalize();
    }
  }

  /**
   * Removes the oldest toasts while the list shows more than `maxValue`, passing
   * over every toast hover or focus holds.
   *
   * Public (not `#private`) as a deterministic seam: enforcement normally runs
   * as each toast is taken on in `itemTargetConnected`, a Stimulus callback delivered
   * through a MutationObserver, which a DOM-only environment does not reliably fire —
   * so it can also be invoked directly. It counts only the toasts taken on. It is not a
   * user-wired action.
   */
  enforceMaxLimit(): void {
    this.#enforceMax();
  }

  /**
   * Removes the oldest toasts with reason `limit` while the list shows more than `max`
   * (`0` or less, or not a finite number, means no limit), passing over every toast hover
   * or focus holds and those in `spared` — the toast just taken on, or the ones the
   * pointer or focus moved into. Only toasts taken on count or go, so one Stimulus has
   * yet to report is neither; a toast already leaving does not count. With nothing else
   * left to go the list stays over the limit. The count is read again on every step,
   * because a `dismiss` listener may already have changed it.
   *
   * @stimeoRenderRoot
   */
  #enforceMax(spared: readonly HTMLElement[] = []): void {
    if (this.#safeMax <= 0) return;
    for (const item of [...this.#arrivals]) {
      if (this.#shownCount() <= this.#safeMax) return;
      if (this.#isShown(item) && !spared.includes(item) && !this.#dismiss.isHeld(item)) {
        this.#removeWithTransition(item, "limit");
      }
    }
  }

  /** How many toasts the list shows: the ones taken on that are still shown. */
  #shownCount(): number {
    return this.itemTargets.filter((item) => this.#isShown(item)).length;
  }

  /** Whether the list shows `item`: a toast taken on, a child of `list`, not leaving. */
  #isShown(item: HTMLElement): boolean {
    return (
      this.#taken.has(item) &&
      this.hasListTarget &&
      item.parentNode === this.listTarget &&
      item.dataset.state !== "leaving"
    );
  }

  /** Wires stable-container delegation so newly appended items work immediately. */
  #connectDelegatedEvents(list = this.hasListTarget ? this.listTarget : null): void {
    this.#disconnectDelegatedEvents();
    if (!list) return;

    this.#delegatedList = list;
    for (const type of DELEGATED_EVENTS) {
      this.#delegatedList.addEventListener(type, this.#onListEvent);
    }
  }

  /** Releases every delegated listener from the exact list that owns it. */
  #disconnectDelegatedEvents(): void {
    if (!this.#delegatedList) return;

    for (const type of DELEGATED_EVENTS) {
      this.#delegatedList.removeEventListener(type, this.#onListEvent);
    }
    this.#delegatedList = null;
  }

  /** Routes every delegated item interaction from the stable list. */
  readonly #onListEvent = (event: Event): void => {
    if (event.type === "click") {
      const target = event.target instanceof Element ? event.target : null;
      const trigger = target?.closest<HTMLElement>("[data-toast-dismiss]");
      if (trigger && this.#delegatedList?.contains(trigger)) this.dismiss(event);
    } else if (event.type === "keydown") {
      this.onKeydown(event as KeyboardEvent);
    } else if (this.#crossesItemBoundary(event)) {
      if (event.type === "focusin" || event.type === "mouseover") this.pause(event);
      else this.resume(event);
    }
  };

  /** Whether a bubbling focus/pointer event enters or leaves a toast boundary. */
  #crossesItemBoundary(event: Event): boolean {
    const item = this.#itemFromSource(actionSource(event));
    if (!item) return false;
    const related = "relatedTarget" in event ? event.relatedTarget : null;
    return !(related instanceof Node && item.contains(related));
  }

  /** Cancels the pending entering-to-visible frame owned by one item. */
  #cancelAnimation(element: HTMLElement): void {
    const handle = this.#rafHandles.get(element);
    if (handle === undefined) return;
    window.cancelAnimationFrame(handle);
    this.#rafHandles.delete(element);
  }
  /** Current `duration` declaration resolved against its numeric contract. */
  get #safeDuration(): number {
    return this.#numbers.read(
      this,
      "duration",
      this.durationValue,
      ToastController.values.duration.default,
      ToastController.valueConstraints.duration,
    );
  }

  /** Current `max` declaration resolved against its numeric contract. */
  get #safeMax(): number {
    return this.#numbers.read(this, "max", this.maxValue, 0, ToastController.valueConstraints.max);
  }
}
