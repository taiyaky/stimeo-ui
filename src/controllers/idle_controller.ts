import { Controller } from "@hotwired/stimulus";
import { ListenerSet } from "../utils/listener_set";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { MAX_TIMER_DELAY_MS, SafeTimeout } from "../utils/safe_timeout";
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
 * `prompt` dispatches `{ remaining }`, the milliseconds left before `idle`: `promptBefore`
 * when the warning comes on schedule, and less when a declaration changed mid-cycle has
 * already put the cycle inside the warning window. `idle` and `active` dispatch `{}`.
 *
 * The three Values follow a change made while connected (a Turbo morph, a script).
 * `events` swaps the watched set: the old listeners go and the declared ones are added
 * once. `timeout` and `promptBefore` move the pending checks to the deadlines the new
 * declaration sets from the same last activity, so the time already spent inactive
 * counts; a deadline the elapsed time has already passed is acted on at once, and a
 * cycle past both deadlines goes idle without a warning for a window that is over. A
 * phase already reached stays: a raised warning goes only on activity or at the
 * timeout, and an idle detector schedules nothing until activity arms the next cycle
 * with the declaration in force.
 *
 * @remarks
 * Behavior only — it renders no warning UI (pair with Dialog/Confirm) and never
 * touches the server session. Timers are owned by `SafeTimeout` and the
 * listeners are removed on `disconnect()` (Turbo navigation included). Place one on
 * the root element. Every visit reconnects the controller and re-arms the timeout
 * from that moment — `data-turbo-permanent` keeps the element, not the elapsed count.
 */
export class IdleController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override values = {
    timeout: { type: Number, default: 900_000 },
    promptBefore: { type: Number, default: 0 },
    // A JSON list read through `parseStringList` rather than Stimulus's `Array`
    // type: that reader throws out of the value observer before any callback
    // runs, so one malformed attribute would stop the detector connecting.
    events: { type: String, default: "" },
  };

  static valueConstraints = {
    timeout: NUMBER_BOUNDS.positiveTimer,
    promptBefore: NUMBER_BOUNDS.nonNegative,
  } satisfies NumberValueConstraints<typeof IdleController.values>;
  static override targets = ["prompt", "idle"];
  static events = ["prompt", "idle", "active"] as const;

  declare timeoutValue: number;
  declare promptBeforeValue: number;
  declare eventsValue: string;
  declare readonly promptTargets: HTMLElement[];
  declare readonly idleTargets: HTMLElement[];

  /** The regions of the warning window, revealed alongside `data-prompt`. */
  readonly #promptRegions = new StateRegions(
    { whenTrue: () => this.promptTargets },
    this.identifier,
  );
  /** The regions of the elapsed timeout, revealed alongside `data-idle`. */
  readonly #idleRegions = new StateRegions({ whenTrue: () => this.idleTargets }, this.identifier);

  readonly #timeouts = new SafeTimeout();
  #idle = false;
  #prompted = false;
  /** Timestamp of the last activity; the timers self-reschedule against it. */
  #lastActivity = 0;
  /** Whether the controller is between `connect()` and `disconnect()`. */
  #connected = false;
  /**
   * The activity listeners on `document`. Releasing them goes through the signal they
   * were registered with, so the removal always matches the registration — capture flag
   * included — whatever `events` says by then.
   */
  readonly #activityListeners = new ListenerSet();
  /** The `visibilitychange` listener, held for the whole connection. */
  readonly #visibilityListeners = new ListenerSet();
  /** Activity types the listeners were last registered for, which a new `events` is compared with. */
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
    this.#connected = true;
    this.#idle = false;
    this.#prompted = false;
    this.#reflect();
    this.#bindActivity(parseStringList(this.eventsValue, DEFAULT_ACTIVITY_EVENTS));
    this.#visibilityListeners.add(document, "visibilitychange", this.#onVisibility);
    this.#arm();
  }

  override disconnect(): void {
    this.#connected = false;
    this.#activityListeners.dispose();
    this.#visibilityListeners.dispose();
    this.#timeouts.clearAll();
  }

  /**
   * Swaps the watched activity set for the one a runtime change declares. A declaration
   * that parses to the list already registered changes nothing. Stimulus also calls this
   * ahead of `connect()`, which registers the list itself.
   */
  eventsValueChanged(): void {
    if (!this.#connected) return;
    const types = parseStringList(this.eventsValue, DEFAULT_ACTIVITY_EVENTS);
    if (
      types.length === this.#boundEvents.length &&
      types.every((type, index) => type === this.#boundEvents[index])
    )
      return;
    this.#bindActivity(types);
  }

  /**
   * Moves the pending checks to the deadlines a runtime change of `timeout` sets, from the
   * same last activity. Stimulus also calls this ahead of `connect()`, which arms the cycle
   * itself.
   */
  timeoutValueChanged(): void {
    if (this.#connected) this.#schedule();
  }

  /**
   * Moves the pending warning to the deadline a runtime change of `promptBefore` sets, from
   * the same last activity. Stimulus also calls this ahead of `connect()`, which arms the
   * cycle itself.
   */
  promptBeforeValueChanged(): void {
    if (this.#connected) this.#schedule();
  }

  /** Replaces the registered activity listeners with one passive capture listener per type. */
  #bindActivity(types: string[]): void {
    this.#activityListeners.dispose();
    for (const type of types) {
      this.#activityListeners.add(document, type, this.#onActivity, {
        passive: true,
        capture: true,
      });
    }
    this.#boundEvents = types;
  }

  /** Starts a cycle: the activity baseline is now, and the checks are scheduled from it. */
  #arm(): void {
    this.#lastActivity = Date.now();
    this.#schedule();
  }

  /**
   * Schedules the pending checks from the last activity and the current declarations,
   * replacing whatever was pending. A deadline already behind the elapsed time is checked
   * at once. The idle check is scheduled first, so when both deadlines have passed it runs
   * first and the warning check finds the cycle over. A warning that comes due at once
   * reports the time left from now rather than the whole window. A raised warning is not
   * scheduled again, and an idle detector schedules nothing.
   *
   * @stimeoRuntimeOnly `timeout` and `promptBefore` time the checks this call schedules.
   */
  #schedule(): void {
    this.#timeouts.clearAll();
    if (this.#idle) return;
    const elapsed = Date.now() - this.#lastActivity;
    const timeout = this.#safeTimeout;
    const prompt = this.#safePromptBefore;
    this.#timeouts.set(() => this.#checkIdle(), this.#delayFor(timeout - elapsed));
    if (this.#prompted || prompt <= 0 || prompt >= timeout) return;
    const left = Math.min(prompt, timeout - elapsed);
    this.#timeouts.set(() => this.#checkPrompt(left), this.#delayFor(timeout - prompt - elapsed));
  }

  /** The platform delay for a deadline `remaining` ms away: at once when past, capped when far. */
  #delayFor(remaining: number): number {
    return Math.min(Math.max(remaining, 0), MAX_TIMER_DELAY_MS);
  }

  /**
   * Idle-timer callback: go idle only if there has genuinely been no activity for
   * `timeout`; otherwise reschedule for the remaining time. This lets activity events
   * stay O(1) (a timestamp write) while the deadline still tracks the last activity.
   * A clock rewind can put that deadline beyond one platform timer; capped waits
   * recheck the same baseline without advancing the idle transition.
   *
   * @stimeoRuntimeOnly `timeout` sets the deadline this one check compares against; the phase it
   *   shows follows the elapsed time.
   */
  #checkIdle(): void {
    const remaining = this.#safeTimeout - (Date.now() - this.#lastActivity);
    if (remaining > 0) {
      this.#timeouts.set(() => this.#checkIdle(), Math.min(remaining, MAX_TIMER_DELAY_MS));
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
   * Clock rewinds use capped waits while retaining the same warning deadline.
   *
   * @param left - the time before idle that the warning reports; a check that has to wait
   *   again reports the whole window when it comes due.
   * @stimeoRuntimeOnly `timeout` and `promptBefore` set the deadlines this one check compares
   *   against; the phase it shows follows the elapsed time.
   */
  #checkPrompt(left = this.#safePromptBefore): void {
    if (this.#idle) return;
    const remaining =
      this.#safeTimeout - this.#safePromptBefore - (Date.now() - this.#lastActivity);
    if (remaining > 0) {
      this.#timeouts.set(() => this.#checkPrompt(), Math.min(remaining, MAX_TIMER_DELAY_MS));
      return;
    }
    this.#prompted = true;
    this.#reflect();
    this.dispatch("prompt", { detail: { remaining: left } });
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
  /** Current `timeout` declaration resolved against its numeric contract. */
  get #safeTimeout(): number {
    return this.#numbers.read(
      this,
      "timeout",
      this.timeoutValue,
      IdleController.values.timeout.default,
      IdleController.valueConstraints.timeout,
    );
  }

  /** Current `promptBefore` declaration resolved against its numeric contract. */
  get #safePromptBefore(): number {
    return this.#numbers.read(
      this,
      "promptBefore",
      this.promptBeforeValue,
      IdleController.values.promptBefore.default,
      IdleController.valueConstraints.promptBefore,
    );
  }
}
