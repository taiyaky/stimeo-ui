import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";

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
 *         <li role="status" data-stimeo--toast-target="item"
 *             data-action="mouseenter->stimeo--toast#pause
 *                          mouseleave->stimeo--toast#resume
 *                          focusin->stimeo--toast#pause
 *                          focusout->stimeo--toast#resume
 *                          keydown->stimeo--toast#onKeydown"
 *             tabindex="0">
 *           <span data-toast-slot="body"></span>
 *           <button type="button" data-action="stimeo--toast#dismiss">Dismiss</button>
 *         </li>
 *       </template>
 *     </div>
 *   </div>
 *
 * Implements WAI-ARIA live region status/alert announcements, limits simultaneous
 * elements, and pauses dismiss timeouts on hover or focus to comply with WCAG 2.2.1.
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

  /**
   * Registry for every auto-dismiss and transition-finalize timer the controller
   * schedules. {@link SafeTimeout} owns *registration and teardown only*; the
   * pause/resume remaining-time accounting stays in `#activeTimeouts` so the
   * per-widget WCAG 2.2.1 semantics are not flattened into the helper.
   */
  #timers = new SafeTimeout();

  /**
   * Pending one-shot `requestAnimationFrame` handles (the entering→visible flip).
   * Tracked so {@link disconnect} can cancel any that have not fired, preventing a
   * detached element from being mutated after it leaves the DOM (Turbo).
   */
  #rafHandles = new Set<number>();

  /** Track active timeouts mapped by each toast element for safe cancellation. */
  #activeTimeouts = new Map<HTMLElement, { id: number; startedAt: number; remaining: number }>();

  /** Track active pause reasons (hover/focus) per toast for WCAG 2.2.1 pause/resume. */
  #pauseReasons = new Map<HTMLElement, Set<string>>();

  override connect(): void {
    this.enforceMaxLimit();
    for (const item of this.itemTargets) {
      if (!this.#activeTimeouts.has(item)) {
        this.#startTimer(item);
      }
    }
  }

  override disconnect(): void {
    // SafeTimeout owns every auto-dismiss + finalize timer; one call tears them
    // all down so none fires against the detached controller.
    this.#timers.clearAll();
    for (const handle of this.#rafHandles) {
      window.cancelAnimationFrame(handle);
    }
    this.#rafHandles.clear();
    this.#activeTimeouts.clear();
    this.#pauseReasons.clear();
  }

  durationValueChanged(): void {
    if (this.durationValue > 0) {
      for (const item of this.itemTargets) {
        if (!this.#activeTimeouts.has(item)) {
          this.#startTimer(item);
        }
      }
    }
  }

  maxValueChanged(): void {
    this.enforceMaxLimit();
  }

  /**
   * Stimulus lifecycle callback triggered automatically when a new item target
   * enters the DOM. Perfectly handles dynamic client-side injections and server-side
   * Turbo Stream appends alike.
   */
  itemTargetConnected(element: HTMLElement): void {
    this.enforceMaxLimit();
    this.#startTimer(element);
    element.setAttribute("data-state", "entering");
    const handle = window.requestAnimationFrame(() => {
      this.#rafHandles.delete(handle);
      element.setAttribute("data-state", "visible");
    });
    this.#rafHandles.add(handle);
  }

  /** Clears any active timer when a toast is removed from the DOM. */
  itemTargetDisconnected(element: HTMLElement): void {
    this.#clearTimer(element);
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

    const bodySlot = item.querySelector("[data-toast-slot='body']");
    if (bodySlot) {
      bodySlot.textContent = body;
    }

    // Validate the live-region role at runtime; untrusted params/detail could
    // otherwise write an invalid ARIA role. Anything but "alert" stays polite.
    item.setAttribute("role", this.#readField(event, "type") === "alert" ? "alert" : "status");

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
    const target = (event.currentTarget || event.target) as HTMLElement | null;
    if (!target) return;
    const item = target.closest("[data-stimeo--toast-target='item']") as HTMLElement | null;
    if (!item) return;

    this.#removeWithTransition(item, "user");
  }

  /** Dismisses the focused toast when Escape is pressed. */
  onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      const target = (event.currentTarget || event.target) as HTMLElement | null;
      if (!target) return;
      const item = target.closest("[data-stimeo--toast-target='item']") as HTMLElement | null;
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
    if (!item || this.durationValue <= 0) return;

    const timeout = this.#activeTimeouts.get(item);
    if (!timeout) return;

    const reasons = this.#pauseReasonsFor(item);
    const wasActive = reasons.size > 0;
    reasons.add(this.#pauseReason(event));

    // Only snapshot the remaining time on the first reason; subsequent reasons
    // must not recompute elapsed against the already-cleared timer.
    if (wasActive || timeout.id === 0) return;

    this.#timers.clear(timeout.id);
    const elapsed = Date.now() - timeout.startedAt;
    const remaining = Math.max(0, timeout.remaining - elapsed);

    this.#activeTimeouts.set(item, { id: 0, startedAt: 0, remaining });
    item.setAttribute("data-paused", "true");
  }

  /** Resumes the auto-dismiss timer once both hover and focus have been released. */
  resume(event: Event): void {
    const item = this.#itemFromEvent(event);
    if (!item || this.durationValue <= 0) return;

    const reasons = this.#pauseReasonsFor(item);
    reasons.delete(this.#pauseReason(event));
    // Still paused by the other reason (e.g. mouse left but focus remains).
    if (reasons.size > 0) return;

    const timeout = this.#activeTimeouts.get(item);
    if (!timeout || timeout.remaining <= 0) return;

    item.removeAttribute("data-paused");
    this.#startTimer(item, timeout.remaining);
  }

  /** Resolves the toast item element a pause/resume event targets. */
  #itemFromEvent(event: Event): HTMLElement | null {
    const target = (event.currentTarget || event.target) as HTMLElement | null;
    return target?.closest("[data-stimeo--toast-target='item']") ?? null;
  }

  /** Classifies a pause/resume event as a hover or focus reason. */
  #pauseReason(event: Event): "focus" | "hover" {
    return event.type === "focusin" || event.type === "focusout" ? "focus" : "hover";
  }

  /** Lazily creates and returns the active pause-reason set for an item. */
  #pauseReasonsFor(item: HTMLElement): Set<string> {
    let reasons = this.#pauseReasons.get(item);
    if (!reasons) {
      reasons = new Set<string>();
      this.#pauseReasons.set(item, reasons);
    }
    return reasons;
  }

  #startTimer(element: HTMLElement, duration = this.durationValue): void {
    if (duration <= 0) return;

    this.#clearTimer(element);
    const id = this.#timers.set(() => {
      this.#removeWithTransition(element, "timeout");
    }, duration);

    this.#activeTimeouts.set(element, { id, startedAt: Date.now(), remaining: duration });
  }

  #clearTimer(element: HTMLElement): void {
    const timeout = this.#activeTimeouts.get(element);
    if (timeout) {
      if (timeout.id) this.#timers.clear(timeout.id);
      this.#activeTimeouts.delete(element);
    }
    this.#pauseReasons.delete(element);
  }

  #removeWithTransition(element: HTMLElement, reason: "timeout" | "user"): void {
    this.#clearTimer(element);
    element.setAttribute("data-state", "leaving");

    const finalize = () => {
      if (element.parentNode === this.listTarget) {
        this.listTarget.removeChild(element);
      }
      this.dispatch("dismiss", { detail: { item: element, reason } });
    };

    const transitions = window.getComputedStyle(element).transitionDuration;
    const duration = cssTimeToMs(transitions);
    if (duration > 0) {
      this.#timers.set(finalize, duration);
    } else {
      finalize();
    }
  }

  /**
   * Removes the oldest toasts when the list exceeds `maxValue`.
   *
   * Public (not `#private`) as a deterministic test seam: enforcement normally
   * runs from `itemTargetConnected`, a Stimulus callback that fires via a
   * MutationObserver — which happy-dom does not reliably deliver — so the unit
   * tests invoke it directly. It is therefore listed in the contract guard's
   * NON_ACTION_ALLOWLIST (it is not a user-wired action).
   */
  enforceMaxLimit(): void {
    const currentItems = this.itemTargets;
    if (currentItems.length > this.maxValue) {
      const excessCount = currentItems.length - this.maxValue;
      for (let i = 0; i < excessCount; i++) {
        const oldest = currentItems[i];
        if (oldest) this.#removeWithTransition(oldest, "timeout");
      }
    }
  }
}

/**
 * Converts the first value of a CSS `transition-duration` string to milliseconds.
 * Browsers normalize computed `<time>` values to seconds (e.g. `0.2s`), but parse
 * `ms` defensively so a consumer's `ms` transition is not delayed 1000x.
 *
 * Pure (no `this`); exported so it can be unit-tested directly.
 */
export function cssTimeToMs(value: string): number {
  const first = value.split(",")[0]?.trim() ?? "";
  const amount = Number.parseFloat(first);
  if (Number.isNaN(amount)) return 0;
  return first.endsWith("ms") ? amount : amount * 1000;
}
