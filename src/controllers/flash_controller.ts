import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";

/** Flash types that map to an assertive `alert` (everything else is a polite `status`). */
const ASSERTIVE_TYPES = new Set(["alert", "error"]);

/** Selector for message targets, used by the MutationObserver to spot dynamic inserts. */
const MESSAGE_SELECTOR = '[data-stimeo--flash-target="message"]';

/** Per-message auto-dismiss timer bookkeeping (id 0 means paused). */
interface FlashTimer {
  id: number;
  startedAt: number;
  remaining: number;
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
 * after `duration` (paused while hovered/focused when `pauseOnHover`), and capped at
 * `max` simultaneous messages. A close button wired to the `dismiss` action removes
 * one manually.
 *
 * @remarks
 * Reading is **delegated to the shared Announcer** — but only for the *initial*,
 * page-loaded messages: an in-place live region present at load is not announced by
 * assistive tech, so the controller bridges those via an `stimeo--announcer:announce`
 * event. Messages inserted *later* (Turbo Stream) are announced by their own freshly
 * inserted `role`, exactly like Toast, so they are not bridged again (no double
 * announcement). Behavior only — no styling; `data-flash-state="leaving"` lets CSS
 * animate removal. Focus is never moved (WCAG 2.2 4.1.3). The observer, timers, and
 * per-message listeners are torn down on `disconnect()` (Turbo navigation included).
 */
export class FlashController extends Controller<HTMLElement> {
  static override targets = ["region", "message"];
  static override values = {
    duration: { type: Number, default: 5000 },
    pauseOnHover: { type: Boolean, default: true },
    max: { type: Number, default: 0 },
  };
  static actions = ["dismiss"] as const;
  static events = ["show", "dismiss"] as const;

  declare readonly regionTarget: HTMLElement;
  declare readonly messageTargets: HTMLElement[];
  declare readonly hasRegionTarget: boolean;

  declare durationValue: number;
  declare pauseOnHoverValue: boolean;
  declare maxValue: number;

  readonly #timers = new SafeTimeout();
  #observer: MutationObserver | null = null;
  /** Auto-dismiss timer state keyed by message element. */
  readonly #state = new Map<HTMLElement, FlashTimer>();
  /** Messages already processed, in insertion order, to enforce `max` and avoid double work. */
  readonly #order: HTMLElement[] = [];

  readonly #onEnter = (event: Event): void => this.#pause(event.currentTarget as HTMLElement);
  readonly #onLeave = (event: Event): void => this.#resume(event.currentTarget as HTMLElement);

  override connect(): void {
    if (!this.hasRegionTarget) return;
    // Initial, server-rendered flashes: bridge them to the Announcer because an
    // in-place live region present at page load is not announced on its own.
    for (const message of this.messageTargets) {
      this.#process(message, true);
    }
    if (typeof MutationObserver !== "undefined") {
      this.#observer = new MutationObserver((mutations) => this.#onMutations(mutations));
      this.#observer.observe(this.regionTarget, { childList: true, subtree: true });
    }
  }

  override disconnect(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    this.#timers.clearAll();
    for (const message of this.#order) this.#unbindPause(message);
    this.#state.clear();
    this.#order.length = 0;
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
    this.#state.set(message, { id, startedAt: Date.now(), remaining: duration });
  }

  /** Pauses a message's auto-dismiss, banking the time left (hover/focus, WCAG 2.2.1). */
  #pause(message: HTMLElement): void {
    const timer = this.#state.get(message);
    if (!timer || timer.id === 0) return;
    this.#timers.clear(timer.id);
    const remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt));
    this.#state.set(message, { id: 0, startedAt: 0, remaining });
  }

  /** Resumes a paused message's auto-dismiss with the banked time. */
  #resume(message: HTMLElement): void {
    const timer = this.#state.get(message);
    if (!timer) return;
    // Only resume a genuinely paused timer (id 0) that still has time banked.
    if (timer.id !== 0 || timer.remaining <= 0) return;
    this.#startTimer(message, timer.remaining);
  }

  /** Marks a message leaving, then removes it after its CSS transition and emits dismiss. */
  #beginDismiss(message: HTMLElement, reason: "timeout" | "user" | "limit"): void {
    const timer = this.#state.get(message);
    if (timer?.id) this.#timers.clear(timer.id);
    this.#state.delete(message);
    const index = this.#order.indexOf(message);
    if (index !== -1) this.#order.splice(index, 1);

    message.setAttribute("data-flash-state", "leaving");

    const finalize = (): void => {
      this.#unbindPause(message);
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

  /** First `transition-duration` of `el` in ms (0 when none / unsupported). */
  #transitionMs(el: HTMLElement): number {
    if (typeof window.getComputedStyle !== "function") return 0;
    const first = window.getComputedStyle(el).transitionDuration.split(",")[0]?.trim() ?? "";
    const amount = Number.parseFloat(first);
    if (Number.isNaN(amount)) return 0;
    return first.endsWith("ms") ? amount : amount * 1000;
  }
}
