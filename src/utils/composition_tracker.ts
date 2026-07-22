/** Minimal event shape carrying the platform's per-event composition signal. */
export interface CompositionSignal {
  readonly isComposing?: boolean;
}

/** Hooks that keep component-specific work outside {@link CompositionTracker}. */
export interface CompositionTrackerOptions {
  /** Runs after lifecycle state is set for a `compositionstart` event. */
  readonly onStart?: (event: Event) => void;
  /** Runs after lifecycle state is cleared for a `compositionend` event. */
  readonly onEnd?: (event: Event) => void;
}

/**
 * Owns IME composition listeners and transient state for one or more event targets.
 *
 * Some browsers omit `KeyboardEvent.isComposing` on the keydown that confirms a
 * conversion. Tracking `compositionstart` through `compositionend` supplies the
 * missing lifecycle signal without relying on deprecated numeric key codes.
 * Component policy stays with the consumer: filtering, validation, and submission
 * belong in the optional {@link CompositionTrackerOptions.onEnd} callback.
 *
 * @example
 * ```ts
 * #composition = new CompositionTracker({ onEnd: () => this.filter() });
 *
 * connect(): void {
 *   this.#composition.observe(this.inputTarget);
 * }
 *
 * disconnect(): void {
 *   this.#composition.disconnect();
 * }
 *
 * onKeydown(event: KeyboardEvent): void {
 *   if (this.#composition.isComposing(event)) return;
 * }
 * ```
 */
export class CompositionTracker {
  readonly #observedTargets = new Set<EventTarget>();
  readonly #activeTargets = new Set<EventTarget>();
  readonly #onStart: ((event: Event) => void) | undefined;
  readonly #onEnd: ((event: Event) => void) | undefined;

  constructor(options: CompositionTrackerOptions = {}) {
    this.#onStart = options.onStart;
    this.#onEnd = options.onEnd;
  }

  /** Starts lifecycle tracking for `target`; repeated calls are idempotent. */
  observe(target: EventTarget): void {
    if (this.#observedTargets.has(target)) return;
    target.addEventListener("compositionstart", this.#handleStart);
    target.addEventListener("compositionend", this.#handleEnd);
    this.#observedTargets.add(target);
  }

  /** Stops tracking one target and clears any active composition it owned. */
  unobserve(target: EventTarget): void {
    if (!this.#observedTargets.delete(target)) return;
    target.removeEventListener("compositionstart", this.#handleStart);
    target.removeEventListener("compositionend", this.#handleEnd);
    this.#activeTargets.delete(target);
  }

  /** Releases every listener and clears state so reconnect starts cleanly. */
  disconnect(): void {
    for (const target of this.#observedTargets) {
      target.removeEventListener("compositionstart", this.#handleStart);
      target.removeEventListener("compositionend", this.#handleEnd);
    }
    this.#observedTargets.clear();
    this.#activeTargets.clear();
  }

  /** True when lifecycle tracking or the current event reports composition. */
  isComposing(event?: CompositionSignal): boolean {
    return this.#activeTargets.size > 0 || event?.isComposing === true;
  }

  readonly #handleStart = (event: Event): void => {
    if (event.currentTarget) this.#activeTargets.add(event.currentTarget);
    this.#onStart?.(event);
  };

  readonly #handleEnd = (event: Event): void => {
    if (event.currentTarget) this.#activeTargets.delete(event.currentTarget);
    this.#onEnd?.(event);
  };
}
