import { Controller } from "@hotwired/stimulus";
import { PausableTimers } from "../utils/pausable_timers";
import { SafeTimeout } from "../utils/safe_timeout";
import { maxTransitionTotalMs } from "../utils/transition_completion";

const DELEGATED_EVENTS = ["click", "focusin", "focusout", "keydown", "mouseover", "mouseout"];

/**
 * Headless, highly accessible toast notification behavior.
 *
 * Markup contract (identifier: `stimeo--toast`):
 *   <div data-controller="stimeo--toast"
 *        data-stimeo--toast-duration-value="5000"
 *        data-stimeo--toast-max-value="3">
 *     <!-- Attribute-only trigger: no hand-written JS required. -->
 *     <button data-action="click->stimeo--toast#show"
 *             data-stimeo--toast-body-param="Saved"
 *             data-stimeo--toast-type-param="status">Show</button>
 *     <!-- The live region is a descendant; the controller element only needs
 *          to enclose both the trigger(s) and the list/template targets. -->
 *     <div role="region" aria-label="Notifications">
 *       <ol data-stimeo--toast-target="list"></ol>
 *       <template data-stimeo--toast-target="template">
 *         <li data-stimeo--toast-target="item" tabindex="0">
 *           <span role="status" data-toast-slot="body"></span>
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
 * `dismiss` dispatches `{ item: HTMLElement, reason: "timeout" | "user" }`.
 *
 * `show` dispatches `{ item: HTMLElement }`.
 *
 * @remarks
 * Behavior only. The controller handles state updates via `data-state` and lifecycle events
 * while leaving visual styling completely to the client's CSS transitions.
 */
export class ToastController extends Controller<HTMLElement> {
  static override targets = ["list", "template", "item"];
  static override values = {
    duration: { type: Number, default: 0 },
    max: { type: Number, default: 3 },
  };
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

  /**
   * Pending one-shot `requestAnimationFrame` handles (the entering→visible flip).
   * Tracked so {@link disconnect} can cancel any that have not fired, preventing a
   * detached element from being mutated after it leaves the DOM (Turbo).
   */
  #rafHandles = new Map<HTMLElement, number>();

  /** The stable list that owns delegated listeners for dynamically added items. */
  #delegatedList: HTMLElement | null = null;

  override connect(): void {
    this.#connectDelegatedEvents();
    this.enforceMaxLimit();
    for (const item of this.itemTargets) {
      if (!this.#dismiss.tracks(item) && item.dataset.state !== "leaving") {
        this.#startTimer(item);
      }
    }
  }

  override disconnect(): void {
    // Both registries own every timer the controller schedules, so a call each
    // leaves none to fire against the detached controller.
    this.#disconnectDelegatedEvents();
    this.#timers.clearAll();
    this.#dismiss.clearAll();
    for (const handle of this.#rafHandles.values()) {
      window.cancelAnimationFrame(handle);
    }
    this.#rafHandles.clear();
  }

  /** Rebinds delegated interaction when Turbo replaces the list target in place. */
  listTargetConnected(element: HTMLElement): void {
    if (this.#delegatedList !== element) this.#connectDelegatedEvents(element);
  }

  /** Releases delegation only when the removed target is its current owner. */
  listTargetDisconnected(element: HTMLElement): void {
    if (this.#delegatedList === element) this.#disconnectDelegatedEvents();
  }

  durationValueChanged(): void {
    for (const item of this.itemTargets) {
      if (item.dataset.state === "leaving") continue;

      if (this.durationValue <= 0) {
        this.#dismiss.clear(item);
        item.removeAttribute("data-paused");
      } else {
        // A toast held by hover or focus keeps its hold and banks the new
        // duration, so the change reaches it without dismissing it.
        this.#startTimer(item);
      }
    }
  }

  maxValueChanged(): void {
    this.enforceMaxLimit();
  }

  /**
   * Stimulus lifecycle callback triggered automatically when a new item target
   * enters the DOM, from a client-side injection or a Turbo Stream append alike. An
   * item already leaving, or parented outside `list`, is skipped.
   */
  itemTargetConnected(element: HTMLElement): void {
    this.enforceMaxLimit();
    if (element.dataset.state === "leaving" || element.parentNode !== this.listTarget) return;

    this.#startTimer(element);
    element.setAttribute("data-state", "entering");
    this.#cancelAnimation(element);
    const handle = window.requestAnimationFrame(() => {
      this.#rafHandles.delete(element);
      if (element.parentNode !== this.listTarget || element.dataset.state === "leaving") return;
      element.setAttribute("data-state", "visible");
    });
    this.#rafHandles.set(element, handle);
  }

  /** Clears any active timer when a toast is removed from the DOM. */
  itemTargetDisconnected(element: HTMLElement): void {
    this.#dismiss.clear(element);
    this.#cancelAnimation(element);
  }

  /**
   * Shows a new toast. Accepts its content from either a Stimulus action param
   * (attribute-only trigger) or a programmatic `show` CustomEvent `detail`
   * (remote / Turbo trigger); the action param wins when both are present.
   *
   *   <button data-action="click->stimeo--toast#show"
   *           data-stimeo--toast-body-param="Saved"
   *           data-stimeo--toast-type-param="status">Show</button>
   *
   *   element.dispatchEvent(new CustomEvent("show", { detail: { body, type } }))
   *
   * Clones the template slot, interpolates the body text, and appends to the list.
   */
  show(event: Event): void {
    if (!this.hasTemplateTarget || !this.hasListTarget) return;

    const body = this.#readField(event, "body");
    if (!body) return;

    const clone = this.templateTarget.content.cloneNode(true) as DocumentFragment;
    const item = clone.querySelector("[data-stimeo--toast-target='item']") as HTMLElement | null;
    if (!item) return;

    const bodySlot = item.querySelector<HTMLElement>("[data-toast-slot='body']");
    if (!bodySlot) return;
    bodySlot.textContent = body;

    // Validate the live-region role at runtime; untrusted params/detail could
    // otherwise write an invalid ARIA role. Anything but "alert" stays polite.
    bodySlot.setAttribute("role", this.#readField(event, "type") === "alert" ? "alert" : "status");

    this.listTarget.appendChild(item);
    this.dispatch("show", { detail: { item } });
  }

  /**
   * Reads a string field from a Stimulus action param or a CustomEvent `detail`,
   * preferring the action param. Returns null unless a non-empty string is found,
   * so untrusted runtime payloads cannot inject non-string values.
   */
  #readField(event: Event, key: "body" | "type"): string | null {
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

  /** Dismisses the toast that contained the trigger. */
  dismiss(event: Event): void {
    const item = this.#itemFromEvent(event);
    if (!item) return;

    this.#removeWithTransition(item, "user");
  }

  /** Dismisses the focused toast when Escape is pressed. */
  onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      // Leave a press an inner handler already owned.
      // A press during IME composition (a text field inside the toast) cancels
      // the conversion, never the toast.
      if (event.defaultPrevented || event.isComposing) return;
      const item = this.#itemFromEvent(event);
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
   * while it is still hovered *or* focused, per WCAG 2.2.1.
   */
  pause(event: Event): void {
    const item = this.#itemFromEvent(event);
    if (item && this.#dismiss.pause(item, this.#pauseReason(event))) {
      item.setAttribute("data-paused", "true");
    }
  }

  /** Resumes the auto-dismiss timer once both hover and focus have been released. */
  resume(event: Event): void {
    const item = this.#itemFromEvent(event);
    if (item && this.#dismiss.resume(item, this.#pauseReason(event))) {
      item.removeAttribute("data-paused");
    }
  }

  /** Resolves the toast item element a pause/resume event targets. */
  #itemFromEvent(event: Event): HTMLElement | null {
    const target = event.target instanceof Element ? event.target : event.currentTarget;
    if (!(target instanceof Element) || !this.hasListTarget) return null;
    const item = target.closest<HTMLElement>("[data-stimeo--toast-target='item']");
    return item && this.listTarget.contains(item) ? item : null;
  }

  /** Classifies a pause/resume event as a hover or focus reason. */
  #pauseReason(event: Event): "focus" | "hover" {
    return event.type === "focusin" || event.type === "focusout" ? "focus" : "hover";
  }

  /** Arms a toast's auto-dismiss; a non-positive `duration` means it never expires. */
  #startTimer(element: HTMLElement): void {
    if (
      this.durationValue <= 0 ||
      element.dataset.state === "leaving" ||
      element.parentNode !== this.listTarget
    ) {
      return;
    }

    this.#dismiss.set(
      element,
      () => this.#removeWithTransition(element, "timeout"),
      this.durationValue,
    );
  }

  #removeWithTransition(element: HTMLElement, reason: "timeout" | "user"): void {
    if (element.dataset.state === "leaving" || element.parentNode !== this.listTarget) return;

    this.#dismiss.clear(element);
    this.#cancelAnimation(element);
    element.setAttribute("data-state", "leaving");

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
   * Removes the oldest toasts when the list exceeds `maxValue`.
   *
   * Public (not `#private`) as a deterministic seam: enforcement normally runs
   * from `itemTargetConnected`, a Stimulus callback delivered through a
   * MutationObserver, which a DOM-only environment does not reliably fire — so
   * it can also be invoked directly. It is not a user-wired action.
   */
  enforceMaxLimit(): void {
    const currentItems = this.itemTargets;
    const max = Math.max(0, this.maxValue);
    if (currentItems.length > max) {
      const excessCount = currentItems.length - max;
      for (let i = 0; i < excessCount; i++) {
        const oldest = currentItems[i];
        if (oldest) this.#removeWithTransition(oldest, "timeout");
      }
    }
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
    const item = this.#itemFromEvent(event);
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
}
