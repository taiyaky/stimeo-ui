import { virtual } from "@guidepup/virtual-screen-reader";

/**
 * Layer ③ speech-order regression helper, built on
 * `@guidepup/virtual-screen-reader`.
 *
 * The virtual screen reader walks the **accessibility tree** and simulates what
 * a screen reader would announce — role, accessible name, and state — entirely
 * inside Vitest + happy-dom (no browser, no OS). Capturing that ordered phrase
 * sequence and asserting it locks the *semantics* of a widget: a lost role, a
 * dropped name, or a flipped state shows up as a diff on every commit.
 *
 * Limits (be honest): this is a **simulation**. It does not reproduce real
 * VoiceOver/NVDA quirks, reading naturalness, or JAWS (unsupported). Real-speech
 * verification is the job of a real screen reader and human spot-checks.
 */

/** Options for {@link captureSpeech}. */
export interface CaptureSpeechOptions {
  /** Subtree the reader is scoped to. Defaults to `document.body`. */
  container?: Element;
  /**
   * Number of forward (`next()`) movements to perform after the reader starts.
   * **Prefer this for regression tests.** When omitted, the reader advances until
   * the spoken phrase stops changing (see auto-traverse note on
   * {@link captureSpeech}), which is convenient but lossy when adjacent elements
   * announce identically.
   */
  steps?: number;
  /** Safety bound for the auto-traverse mode. Defaults to 50. */
  maxSteps?: number;
}

/**
 * Starts the virtual screen reader, moves forward through `container`, and
 * resolves the ordered list of spoken phrases.
 *
 * The first entry is the container announcement the reader emits on `start()`
 * (e.g. `"document"`); each subsequent entry is one `next()` movement. Assert
 * the whole array to pin the announcement sequence.
 *
 * The reader is always stopped, even if `start()`, a movement, or an assertion
 * throws, so a failed test never leaks a running reader into the next one.
 *
 * Auto-traverse caveat: with no {@link CaptureSpeechOptions.steps} the walk ends
 * as soon as a movement repeats the previous phrase. Adjacent elements that
 * announce identically (e.g. two `<button>Delete</button>`) therefore look like
 * the end and truncate the capture — pass an explicit `steps` count for those.
 */
export async function captureSpeech(options: CaptureSpeechOptions = {}): Promise<string[]> {
  const container = options.container ?? document.body;
  let started = false;
  try {
    await virtual.start({ container });
    started = true;
    if (typeof options.steps === "number") {
      for (let i = 0; i < options.steps; i++) {
        await virtual.next();
      }
    } else {
      await traverseToEnd(options.maxSteps ?? 50);
    }
    return await virtual.spokenPhraseLog();
  } finally {
    if (started) {
      await virtual.stop();
    }
  }
}

/**
 * Advances the reader until the spoken phrase repeats (end reached) or `maxSteps`
 * movements have run, whichever comes first. The bound guards against readers
 * that wrap around instead of stopping at the end.
 */
async function traverseToEnd(maxSteps: number): Promise<void> {
  let previous = await virtual.lastSpokenPhrase();
  for (let i = 0; i < maxSteps; i++) {
    await virtual.next();
    const current = await virtual.lastSpokenPhrase();
    if (current === previous) return;
    previous = current;
  }
}
