import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";

/**
 * Headless inactivity / session-timeout detector: fires `idle` after `timeout` ms
 * with no user activity, an optional `prompt` `promptBefore` ms earlier, and
 * `active` when the user returns (no dedicated APG pattern; supports WCAG 2.2.1 by
 * giving the app a warning hook before a timeout).
 *
 * Markup contract (identifier: `stimeo--idle`):
 *   <body data-controller="stimeo--idle"
 *         data-stimeo--idle-timeout-value="900000"
 *         data-stimeo--idle-prompt-before-value="60000"
 *         data-action="stimeo--idle:prompt->session#warn
 *                      stimeo--idle:idle->session#logout"></body>
 *
 * Activity events (`events`, passive) are watched on `document` with capture so
 * non-bubbling ones like `scroll` are seen anywhere; returning to a hidden tab
 * (`visibilitychange` → visible) counts as activity too. While idle the controller
 * element carries `data-idle`.
 *
 * @remarks
 * Behavior only — it renders no warning UI (pair with Dialog/Confirm) and never
 * touches the server session. Timers are owned by {@link SafeTimeout} and the
 * listeners are removed on `disconnect()` (Turbo navigation included). Place one on
 * the root element; `data-turbo-permanent` keeps the count running across visits.
 */
export class IdleController extends Controller<HTMLElement> {
  static override values = {
    timeout: { type: Number, default: 900_000 },
    promptBefore: { type: Number, default: 0 },
    events: {
      type: Array,
      default: ["mousemove", "mousedown", "keydown", "wheel", "touchstart", "scroll"],
    },
  };
  static events = ["prompt", "idle", "active"] as const;

  declare timeoutValue: number;
  declare promptBeforeValue: number;
  declare eventsValue: string[];

  readonly #timeouts = new SafeTimeout();
  #idle = false;
  #prompted = false;
  /** Timestamp of the last activity; the timers self-reschedule against it. */
  #lastActivity = 0;

  readonly #onActivity = (): void => {
    // Hot path (fires on every mousemove/scroll/wheel): just record the time. The
    // prompt/idle timers re-check this when they fire and reschedule if needed, so we
    // never tear down and re-create timers on each event (no per-event timer churn).
    this.#lastActivity = Date.now();
    if (this.#idle || this.#prompted) {
      // We were already idle/prompted, so the timers have lapsed — wake and re-arm.
      this.#idle = false;
      this.#prompted = false;
      this.element.removeAttribute("data-idle");
      this.dispatch("active", { detail: {} });
      this.#arm();
    }
  };

  readonly #onVisibility = (): void => {
    // Returning to the tab is activity; leaving it keeps the clock running (being
    // away counts toward the timeout).
    if (document.visibilityState === "visible") this.#onActivity();
  };

  override connect(): void {
    for (const type of this.eventsValue) {
      document.addEventListener(type, this.#onActivity, { passive: true, capture: true });
    }
    document.addEventListener("visibilitychange", this.#onVisibility);
    this.#arm();
  }

  override disconnect(): void {
    for (const type of this.eventsValue) {
      document.removeEventListener(type, this.#onActivity, { capture: true });
    }
    document.removeEventListener("visibilitychange", this.#onVisibility);
    this.#timeouts.clearAll();
  }

  /** Schedules the prompt and idle checks from the current activity baseline. */
  #arm(): void {
    this.#timeouts.clearAll();
    this.#lastActivity = Date.now();
    const { promptBeforeValue: prompt, timeoutValue: timeout } = this;
    if (prompt > 0 && prompt < timeout) {
      this.#timeouts.set(() => this.#checkPrompt(), timeout - prompt);
    }
    this.#timeouts.set(() => this.#checkIdle(), timeout);
  }

  /**
   * Idle-timer callback: go idle only if there has genuinely been no activity for
   * `timeout`; otherwise reschedule for the remaining time. This lets activity events
   * stay O(1) (a timestamp write) while the deadline still tracks the last activity.
   */
  #checkIdle(): void {
    const remaining = this.timeoutValue - (Date.now() - this.#lastActivity);
    if (remaining > 0) {
      this.#timeouts.set(() => this.#checkIdle(), remaining);
      return;
    }
    this.#idle = true;
    this.#prompted = false;
    this.element.setAttribute("data-idle", "true");
    this.dispatch("idle", { detail: {} });
  }

  /** Prompt-timer callback: warn at `promptBefore` before the idle deadline. */
  #checkPrompt(): void {
    const remaining =
      this.timeoutValue - this.promptBeforeValue - (Date.now() - this.#lastActivity);
    if (remaining > 0) {
      this.#timeouts.set(() => this.#checkPrompt(), remaining);
      return;
    }
    this.#prompted = true;
    this.dispatch("prompt", { detail: { remaining: this.promptBeforeValue } });
  }
}
