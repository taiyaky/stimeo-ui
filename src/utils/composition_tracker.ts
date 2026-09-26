/** Minimal event shape carrying the platform's per-event composition signal. */
export interface CompositionSignal {
  readonly isComposing?: boolean;
}

/** Minimal `input` shape needed to tell a composition echo from a fresh edit. */
export interface ConfirmedInputSignal {
  readonly target: EventTarget | null;
  readonly inputType?: string;
}

/**
 * The `inputType` values an engine reports on an `input` that belongs to a
 * composition rather than to an edit the user just made.
 */
const COMPOSITION_INPUT_TYPES = new Set([
  "insertCompositionText",
  "insertFromComposition",
  "deleteCompositionText",
  "deleteByComposition",
]);

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
 * The tracker also owns the other half of that lifecycle: **the `input` some
 * engines send after `compositionend` to echo the text just confirmed.** A
 * consumer that ran `onEnd` and then handled the echo would commit the same
 * confirmation twice, so {@link CompositionTracker.consumesConfirmedInput} tells
 * the echo apart and the consumer returns early on it.
 *
 * **What the echo is not, is the harder half.** Not every engine sends one —
 * Chromium ends a confirmation at `compositionend` with no `input` after it — so
 * a window that waits for the echo and only closes on the next key would swallow
 * the first edit that arrives without one: dictation, autofill, a drop,
 * `insertText`. Two things keep that from happening. The window closes on the
 * next anything — a key, a new composition, any `input`, losing the field — and
 * an `input` that reports an `inputType` outside {@link COMPOSITION_INPUT_TYPES}
 * is an edit, so it is never folded. Only an engine that reports no `inputType`
 * at all is left relying on the window alone.
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
 * onInput(event: InputEvent): void {
 *   if (this.#composition.consumesConfirmedInput(event)) return;
 *   if (this.#composition.isComposing(event)) return;
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
  /** The field whose confirming `input` is still owed, while the window is open. */
  #confirmedTarget: EventTarget | null = null;

  constructor(options: CompositionTrackerOptions = {}) {
    this.#onStart = options.onStart;
    this.#onEnd = options.onEnd;
  }

  /** Starts lifecycle tracking for `target`; repeated calls are idempotent. */
  observe(target: EventTarget): void {
    if (this.#observedTargets.has(target)) return;
    target.addEventListener("compositionstart", this.#handleStart);
    target.addEventListener("compositionend", this.#handleEnd);
    target.addEventListener("keydown", this.#handleKeydown);
    this.#observedTargets.add(target);
  }

  /** Stops tracking one target and clears any active composition it owned. */
  unobserve(target: EventTarget): void {
    if (!this.#observedTargets.delete(target)) return;
    target.removeEventListener("compositionstart", this.#handleStart);
    target.removeEventListener("compositionend", this.#handleEnd);
    target.removeEventListener("keydown", this.#handleKeydown);
    this.#activeTargets.delete(target);
    if (this.#confirmedTarget === target) this.#confirmedTarget = null;
  }

  /** Releases every listener and clears state so reconnect starts cleanly. */
  disconnect(): void {
    for (const target of this.#observedTargets) {
      target.removeEventListener("compositionstart", this.#handleStart);
      target.removeEventListener("compositionend", this.#handleEnd);
      target.removeEventListener("keydown", this.#handleKeydown);
    }
    this.#observedTargets.clear();
    this.#activeTargets.clear();
    this.#confirmedTarget = null;
  }

  /** True when lifecycle tracking or the current event reports composition. */
  isComposing(event?: CompositionSignal): boolean {
    return this.#activeTargets.size > 0 || event?.isComposing === true;
  }

  /**
   * Whether `event` is the `input` echoing the composition just confirmed.
   *
   * Asking closes the window either way, so one confirmation is folded at most
   * once and a consumer asks once per `input`.
   */
  consumesConfirmedInput(event: ConfirmedInputSignal): boolean {
    const confirmed = this.#confirmedTarget;
    this.#confirmedTarget = null;
    if (confirmed === null || confirmed !== event.target) return false;
    // An engine that reports no kind at all leaves `inputType` empty, and the
    // window is then the only signal there is.
    const inputType = event.inputType;
    return !inputType || COMPOSITION_INPUT_TYPES.has(inputType);
  }

  readonly #handleStart = (event: Event): void => {
    this.#confirmedTarget = null;
    if (event.currentTarget) this.#activeTargets.add(event.currentTarget);
    this.#onStart?.(event);
  };

  readonly #handleEnd = (event: Event): void => {
    if (event.currentTarget) this.#activeTargets.delete(event.currentTarget);
    this.#confirmedTarget = event.target;
    this.#onEnd?.(event);
  };

  /** A key on an observed field opens an edit of its own, so no echo is owed. */
  readonly #handleKeydown = (): void => {
    this.#confirmedTarget = null;
  };
}
