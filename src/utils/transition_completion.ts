import { SafeTimeout } from "./safe_timeout";

/** Computed transition fields needed to determine when an element has settled. */
export type TransitionStyle = Pick<
  CSSStyleDeclaration,
  "transitionProperty" | "transitionDuration" | "transitionDelay"
>;

/** Parsed transition property paired with its effective duration and delay. */
interface TransitionTiming {
  property: string;
  totalMs: number;
}

/** Parses a CSS `<time>` into milliseconds, returning `0` for malformed values. */
function timeMs(value: string): number {
  const trimmed = value.trim();
  const amount = Number.parseFloat(trimmed);
  if (!Number.isFinite(amount)) return 0;
  if (trimmed.endsWith("ms")) return amount;
  if (trimmed.endsWith("s")) return amount * 1000;
  return 0;
}

/** Splits a computed comma-separated CSS list into normalized, non-empty items. */
function cssList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Pairs transition properties, durations, and delays using CSS list repetition.
 *
 * The `transition-property` list determines the number of transitions. Shorter
 * duration/delay lists repeat, while extra values are ignored. A negative delay
 * shortens the remaining wall-clock time, and a non-positive total is settled.
 */
function transitionTimings(style: TransitionStyle): TransitionTiming[] {
  const properties = cssList(style.transitionProperty);
  const durations = cssList(style.transitionDuration).map(timeMs);
  const delays = cssList(style.transitionDelay).map(timeMs);
  const effectiveProperties =
    properties.length > 0
      ? properties
      : Array.from({ length: Math.max(durations.length, delays.length, 1) }, () => "all");
  const effectiveDurations = durations.length > 0 ? durations : [0];
  const effectiveDelays = delays.length > 0 ? delays : [0];

  return effectiveProperties
    .filter((property) => property !== "none")
    .map((property, index) => ({
      property,
      totalMs: Math.max(
        0,
        (effectiveDurations[index % effectiveDurations.length] ?? 0) +
          (effectiveDelays[index % effectiveDelays.length] ?? 0),
      ),
    }));
}

/** Maximum total over already-parsed timings (0 when the list is empty). */
function maxTotalMs(timings: TransitionTiming[]): number {
  return timings.reduce((max, { totalMs }) => Math.max(max, totalMs), 0);
}

/** Maximum effective transition duration plus delay, in milliseconds. */
export function maxTransitionTotalMs(style: TransitionStyle): number {
  return maxTotalMs(transitionTimings(style));
}

/** Optional tuning for a single {@link TransitionCompletion.wait} call. */
export interface TransitionWaitOptions {
  /**
   * Positive wall-clock override (ms) for the bounded fallback, replacing the
   * auto-computed `max + 50ms` timer verbatim. It also keeps the wait armed for
   * a computed 0ms transition (no synchronous completion): the consumer asserts
   * a transition budget that computed styles cannot see. Non-positive and
   * non-finite (`NaN` / `Infinity`) values are ignored.
   */
  timeoutMs?: number;
}

/**
 * Owns one cancellable wait for an element's CSS transitions to settle.
 *
 * When available, active CSS transitions provide their expanded property names.
 * Tracking those names lets shorthand declarations settle from their longhand
 * terminal events. A terminal event from an interrupted phase is ignored while a
 * replacement transition for the same property is still active. Because that set
 * is sampled when the wait is armed, a property whose transition only starts a
 * frame later would otherwise be settled over; the still-running set is therefore
 * re-read before completing and adopted when it is not yet empty. Without Web
 * Animations data, explicit transition properties retain the declared-property
 * behavior and the ambiguous `transition-property: all` form waits until the
 * computed maximum wall-clock time. A `max + 50ms` timeout is always armed
 * because browsers emit no terminal event when a property never transitions, an
 * ancestor disappears, or rendering is otherwise interrupted; a consumer with
 * better knowledge can replace that fallback via
 * {@link TransitionWaitOptions.timeoutMs}.
 */
export class TransitionCompletion {
  readonly #timers = new SafeTimeout();
  #element: HTMLElement | null = null;
  #complete: (() => void) | null = null;
  #pendingProperties: Set<string> | null = null;
  #deadline = 0;

  /**
   * Replaces any prior wait and invokes `complete` synchronously for a 0ms
   * transition (including when `getComputedStyle` is unavailable).
   *
   * With a positive `options.timeoutMs` the synchronous fast-path is skipped and
   * the override replaces the auto-computed fallback (see {@link TransitionWaitOptions}).
   */
  wait(element: HTMLElement, complete: () => void, options: TransitionWaitOptions = {}): void {
    this.cancel();

    const requested = options.timeoutMs ?? 0;
    const override = Number.isFinite(requested) && requested > 0 ? requested : 0;
    // A non-browser / partial-DOM environment cannot report a computable
    // transition, which is indistinguishable from a 0ms one.
    const timings =
      typeof window.getComputedStyle === "function"
        ? transitionTimings(window.getComputedStyle(element))
        : [];
    const maximum = maxTotalMs(timings);
    if (maximum <= 0 && override <= 0) {
      complete();
      return;
    }

    this.#element = element;
    this.#complete = complete;
    this.#deadline = Date.now() + maximum;
    const activeProperties = this.#activeTransitionProperties(element);
    this.#pendingProperties =
      activeProperties.size > 0 ? activeProperties : this.#explicitPendingProperties(timings);
    element.addEventListener("transitionend", this.#onTerminal);
    element.addEventListener("transitioncancel", this.#onTerminal);
    this.#timers.set(() => this.#finish(), override > 0 ? override : maximum + 50);
  }

  /** Cancels the pending wait without invoking its completion callback. */
  cancel(): void {
    this.#complete = null;
    this.#teardown();
  }

  /**
   * Handles terminal events from the observed element only.
   *
   * For explicit property lists, every declared positive-time property must
   * settle. For `all`, no reliable property set exists, so an event can finish
   * only after the computed maximum time; the safety timeout owns the usual path.
   */
  readonly #onTerminal = (event: Event): void => {
    if (event.target !== this.#element) return;
    const transitionEvent = event as TransitionEvent;
    // A pseudo-element's transition is reported with its originating element
    // as `target`; it must not settle the element's own transition.
    if (transitionEvent.pseudoElement) return;

    if (this.#pendingProperties) {
      const propertyName = transitionEvent.propertyName;
      const active = this.#activeTransitionProperties(this.#element);
      // An interrupted transition queues its cancel event before the replacement
      // phase starts, but dispatch can happen after the new wait is armed. The
      // replacement is then the active transition for this property, so the stale
      // terminal event must not settle the new phase.
      if (active.has(propertyName)) return;
      if (!this.#pendingProperties.delete(propertyName)) return;
      if (this.#pendingProperties.size > 0) return;
      // The tracked set is an arm-time snapshot, so a transition the phase starts
      // one frame later is absent from it. Re-reading the still-running set before
      // settling adopts those stragglers instead of completing over them; the
      // fallback timer stays armed, so this cannot extend the wait unboundedly.
      if (active.size > 0) {
        this.#pendingProperties = active;
        return;
      }
      this.#finish();
      return;
    }

    if (Date.now() >= this.#deadline) this.#finish();
  };

  /**
   * Returns active CSS transition properties expanded to the names reported by
   * terminal events. CSS animations and pseudo-element effects are excluded.
   */
  #activeTransitionProperties(element: HTMLElement | null): Set<string> {
    if (!element || typeof element.getAnimations !== "function") return new Set();

    try {
      const properties = element.getAnimations().flatMap((animation) => {
        if (animation.playState === "idle" || animation.playState === "finished") return [];
        const effect = animation.effect as KeyframeEffect | null;
        // A pseudo-element effect names the originating element as its target, so
        // `target` alone cannot separate it. Its terminal events are ignored, so
        // tracking its properties would only strand the wait on the fallback.
        if (effect?.pseudoElement) return [];
        const target = effect?.target;
        if (target && target !== element) return [];
        const property = (animation as Partial<CSSTransition>).transitionProperty;
        return typeof property === "string" && property.length > 0 ? [property] : [];
      });
      return new Set(properties);
    } catch {
      // Partial DOM implementations can expose getAnimations without supporting
      // it. The declared-property tracker and bounded timer remain safe fallbacks.
      return new Set();
    }
  }

  /** Returns explicit positive-time properties, or `null` for the ambiguous `all`. */
  #explicitPendingProperties(timings: TransitionTiming[]): Set<string> | null {
    if (timings.some(({ property }) => property === "all")) return null;
    const pending = new Set(
      timings.filter(({ totalMs }) => totalMs > 0).map(({ property }) => property),
    );
    // An empty set is only reachable through a timeout override (a 0ms transition
    // otherwise completes synchronously). With nothing to track, fall back to the
    // deadline rule so any terminal event can settle the wait, exactly like `all`.
    return pending.size > 0 ? pending : null;
  }

  /** Completes exactly once, releasing listeners and the fallback before the callback. */
  #finish(): void {
    const complete = this.#complete;
    if (!complete) return;
    this.#complete = null;
    this.#teardown();
    complete();
  }

  /** Releases the exact element listeners and timer owned by the current wait. */
  #teardown(): void {
    this.#timers.clearAll();
    this.#element?.removeEventListener("transitionend", this.#onTerminal);
    this.#element?.removeEventListener("transitioncancel", this.#onTerminal);
    this.#element = null;
    this.#pendingProperties = null;
    this.#deadline = 0;
  }
}
