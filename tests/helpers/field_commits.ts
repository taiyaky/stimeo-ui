/**
 * Captures the native `change` events a widget emits from the form fields it
 * mirrors its own state into.
 *
 * The assertion these support is about *which* element reported and *how
 * often*, because that is the whole contract: a form-level listener has to hear
 * the user's commit exactly once and hear nothing at all when the widget is
 * only refreshing its mirror.
 */

/** A live recording that a test reads, resets, and finally detaches. */
export interface FieldCommitCapture {
  /** The elements that reported, in dispatch order. */
  readonly seen: EventTarget[];
  /** The reporting elements' submitted values, in dispatch order. */
  values(): string[];
  /** Drops everything seen so far, so the next assertion starts from zero. */
  clear(): void;
  /** Detaches the listener this capture added. */
  stop(): void;
}

/**
 * Records every bubbling native `change` reaching `target`.
 *
 * @param target - Where to listen. The document catches every widget on the
 *   page; pass a root element to scope the recording to one.
 */
export function captureFieldCommits(target: EventTarget = document): FieldCommitCapture {
  const seen: EventTarget[] = [];
  const listener = (event: Event): void => {
    if (event.target) seen.push(event.target);
  };
  target.addEventListener("change", listener);

  return {
    seen,
    values: () =>
      seen.map((element) => {
        if (element instanceof HTMLInputElement) return element.value;
        if (element instanceof HTMLElement) {
          return [...element.querySelectorAll("input")].map((input) => input.value).join(",");
        }
        return "";
      }),
    clear: () => {
      seen.length = 0;
    },
    stop: () => target.removeEventListener("change", listener),
  };
}
