import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";
import { StateRegions } from "../utils/state_regions";
import { parseStringList } from "../utils/string_list";

/** Activity signals watched unless the consumer declares its own list. */
const DEFAULT_ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "keydown",
  "wheel",
  "touchstart",
  "scroll",
];

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
 *                      stimeo--idle:idle->session#logout">
 *     <p data-stimeo--idle-target="prompt" hidden>Your session expires in a minute.</p>
 *     <p data-stimeo--idle-target="idle" hidden>You have been signed out.</p>
 *   </body>
 *
 * Activity events (`events`, passive) are watched on `document` with capture so
 * non-bubbling ones like `scroll` are seen anywhere; returning to a hidden tab
 * (`visibilitychange` → visible) counts as activity too. The controller element carries
 * `data-prompt` while the warning stands and `data-idle` once the timeout is reached,
 * and the optional `prompt` / `idle` targets are the regions those phases reveal:
 * declared where the page has something to show, shown while their phase holds and
 * hidden otherwise, whatever visibility the markup was authored with.
 *
 * `prompt` dispatches `{ remaining }`; `idle` and `active` dispatch `{}`.
 *
 * @remarks
 * Behavior only — it renders no warning UI (pair with Dialog/Confirm) and never
 * touches the server session. Timers are owned by `SafeTimeout` and the
 * listeners are removed on `disconnect()` (Turbo navigation included). Place one on
 * the root element. Every visit reconnects the controller and re-arms the timeout
 * from that moment — `data-turbo-permanent` keeps the element, not the elapsed count.
 */
export class IdleController extends Controller<HTMLElement> {
  static override values = {
    timeout: { type: Number, default: 900_000 },
    promptBefore: { type: Number, default: 0 },
    // A JSON list read through `parseStringList` rather than Stimulus's `Array`
    // type: that reader throws out of the value observer before any callback
    // runs, so one malformed attribute would stop the detector connecting.
    events: { type: String, default: "" },
  };
  static override targets = ["prompt", "idle"];
  static events = ["prompt", "idle", "active"] as const;

  declare timeoutValue: number;
  declare promptBeforeValue: number;
  declare eventsValue: string;
  declare readonly promptTargets: HTMLElement[];
  declare readonly idleTargets: HTMLElement[];

  /** The regions of the warning window, revealed alongside `data-prompt`. */
  readonly #promptRegions = new StateRegions({ whenTrue: () => this.promptTargets });
  /** The regions of the elapsed timeout, revealed alongside `data-idle`. */
  readonly #idleRegions = new StateRegions({ whenTrue: () => this.idleTargets });

  readonly #timeouts = new SafeTimeout();
  #idle = false;
  #prompted = false;
  /** Timestamp of the last activity; the timers self-reschedule against it. */
  #lastActivity = 0;
  /**
   * Activity types actually registered on `document`, so `disconnect()` unbinds the
   * same set even when `events` changed while connected (a Turbo morph can rewrite
   * the Value in place, and the removal must match the registration, not the Value).
   */
  #boundEvents: string[] = [];

  readonly #onActivity = (): void => {
    // Hot path (fires on every mousemove/scroll/wheel): just record the time. The
    // prompt/idle timers re-check this when they fire and reschedule if needed, so we
    // never tear down and re-create timers on each event (no per-event timer churn).
    this.#lastActivity = Date.now();
    if (this.#idle || this.#prompted) {
      // We were already idle/prompted, so the timers have lapsed — wake and re-arm.
      this.#idle = false;
      this.#prompted = false;
      this.#reflect();
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
    // Connecting always starts a fresh cycle (#arm() re-bases the clock), so the phase
    // that arrived with the DOM — a restored Turbo snapshot, a moved element — describes
    // a period this instance is not in. Reflecting the fresh cycle drops it; leaving it
    // would claim the user is idle for the whole next active window with no `active` to
    // correct it. Normalizing is not a transition, so nothing is dispatched here.
    this.#idle = false;
    this.#prompted = false;
    this.#reflect();
    this.#boundEvents = parseStringList(this.eventsValue, DEFAULT_ACTIVITY_EVENTS);
    for (const type of this.#boundEvents) {
      document.addEventListener(type, this.#onActivity, { passive: true, capture: true });
    }
    document.addEventListener("visibilitychange", this.#onVisibility);
    this.#arm();
  }

  override disconnect(): void {
    for (const type of this.#boundEvents) {
      document.removeEventListener(type, this.#onActivity, { capture: true });
    }
    this.#boundEvents = [];
    document.removeEventListener("visibilitychange", this.#onVisibility);
    this.#timeouts.clearAll();
  }

  /**
   * Schedules the prompt and idle checks from the current activity baseline.
   *
   * @stimeoRuntimeOnly `timeout` and `promptBefore` time the checks this call arms.
   */
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
   *
   * @stimeoRuntimeOnly `timeout` sets the deadline this one check compares against; the phase it
   *   shows follows the elapsed time.
   */
  #checkIdle(): void {
    const remaining = this.timeoutValue - (Date.now() - this.#lastActivity);
    if (remaining > 0) {
      this.#timeouts.set(() => this.#checkIdle(), remaining);
      return;
    }
    this.#idle = true;
    this.#prompted = false;
    this.#reflect();
    this.dispatch("idle", { detail: {} });
  }

  /**
   * Prompt-timer callback: warn at `promptBefore` before the idle deadline. A window
   * narrowed while the cycle runs can push the warning onto the deadline or past it,
   * and the phase it belongs to is the one before idle, so a lapsed cycle keeps the
   * phase it reached. The next window opens with the cycle that activity arms.
   *
   * @stimeoRuntimeOnly `timeout` and `promptBefore` set the deadlines this one check compares
   *   against; the phase it shows follows the elapsed time.
   */
  #checkPrompt(): void {
    if (this.#idle) return;
    const remaining =
      this.timeoutValue - this.promptBeforeValue - (Date.now() - this.#lastActivity);
    if (remaining > 0) {
      this.#timeouts.set(() => this.#checkPrompt(), remaining);
      return;
    }
    this.#prompted = true;
    this.#reflect();
    this.dispatch("prompt", { detail: { remaining: this.promptBeforeValue } });
  }

  /** Applies the current phase to a warning region inserted or replaced at runtime. */
  promptTargetConnected(): void {
    this.#promptRegions.reflect(this.element, this.#prompted);
  }

  /** Applies the current phase to an idle region inserted or replaced at runtime. */
  idleTargetConnected(): void {
    this.#idleRegions.reflect(this.element, this.#idle);
  }

  /**
   * Writes the phase to the element and to the declared regions. Both hooks and both
   * regions are a pure function of the two flags, so every place that moves a flag ends
   * here and the markup can never disagree with the phase the detector is in.
   */
  #reflect(): void {
    const { element } = this;
    if (this.#prompted) element.setAttribute("data-prompt", "true");
    else element.removeAttribute("data-prompt");
    if (this.#idle) element.setAttribute("data-idle", "true");
    else element.removeAttribute("data-idle");
    this.#promptRegions.reflect(element, this.#prompted);
    this.#idleRegions.reflect(element, this.#idle);
  }
}
