import { Controller } from "@hotwired/stimulus";
import { announce } from "../utils/announce";
import { setDefaultAttribute } from "../utils/default_attribute";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { SafeTimeout } from "../utils/safe_timeout";

/**
 * The `data-state` values this controller writes itself. Any other value on the
 * attribute was authored by the consumer and is left alone.
 */
const TRANSIENT_STATES = new Set(["copied", "error"]);

/**
 * Headless copy-to-clipboard behavior with a completion slot and a screen-reader
 * announcement.
 *
 * Markup contract (identifier: `stimeo--clipboard`):
 *   <div data-controller="stimeo--clipboard"
 *        data-stimeo--clipboard-feedback-duration-value="2000"
 *        data-stimeo--clipboard-announce-copied-text-value="Copied to clipboard"
 *        data-stimeo--clipboard-announce-error-text-value="Copy failed">
 *     <input type="text" value="https://example.com" readonly
 *            data-stimeo--clipboard-target="source">
 *     <button type="button" data-stimeo--clipboard-target="button"
 *             data-action="click->stimeo--clipboard#copy">Copy</button>
 *     <span data-stimeo--clipboard-target="feedback"></span>
 *   </div>
 *
 * No dedicated APG pattern; this follows the Button practice plus a status message
 * ({@link https://www.w3.org/WAI/WCAG22/Understanding/status-changes.html | WCAG 2.2 SC 4.1.3}).
 * The copy uses the standard `navigator.clipboard` API (no extra dependency); every
 * failure mode — an API the browser withholds outside a secure context as much as a
 * rejected permission — settles the same way, as `data-state="error"` plus the
 * `copy` event's `success: false`.
 *
 * Targets: `source` (the text to copy, when `text` is not set), `button` (the
 * control that triggers `copy`), `feedback` (the **visible** completion slot).
 *
 * Values: `text` (copy this instead of reading `source`), `feedbackDuration` (ms the
 * completion state is held; `0` or less arms no timer, so it stands until the next
 * copy — a reconnect still clears it), `copiedLabel` /
 * `errorLabel` (what the visible slot shows), `announceCopiedText` /
 * `announceErrorText` (what assistive tech hears; empty announces nothing).
 *
 * @remarks
 * Behavior only — icon swaps and styling are the consumer's, keyed off `data-state`
 * (`idle` / `copied` / `error`).
 *
 * **The `feedback` slot must not carry live-region semantics.** Announcing is the
 * page's shared `stimeo--announcer` job: it is seated before the change it reads,
 * which a slot filled on demand cannot be, and it already collapses a repeat of the
 * same wording so a second copy is still heard. A `role="status"` on the slot as
 * well would say everything twice.
 *
 * `copied` and `error` are transient: the timer that clears them belongs to one
 * connection, so a fresh `connect()` that finds either — a page Turbo restores from its
 * cache, an in-page move — returns to `idle`, silently. `turbo:before-cache` changes
 * nothing: Turbo also dispatches it on pages that stay (a promoted frame navigation, a
 * `popstate` without Turbo state, a refresh of a cached URL), where the result is still
 * on screen and its return to idle still due. Returning to `idle` empties only a slot that
 * still shows the wording a copy wrote there; a slot the page swapped in, rewrote, or put
 * an element into keeps what it holds.
 *
 * A `copiedLabel` / `errorLabel` changed on the live element while its result is
 * shown rewrites the slot — only while the slot still reads the label the copy wrote
 * — without announcing, dispatching or moving the return to idle. Stimulus reports no
 * change when a label attribute whose value was empty is removed, so the slot keeps
 * the empty label until the next copy. `feedbackDuration` and the announcement texts
 * belong to one copy, so a change to them applies from the next.
 */
export class ClipboardController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override targets = ["source", "button", "feedback"];
  static override values = {
    text: { type: String, default: "" },
    feedbackDuration: { type: Number, default: 2000 },
    copiedLabel: { type: String, default: "Copied" },
    errorLabel: { type: String, default: "Copy failed" },
    announceCopiedText: { type: String, default: "" },
    announceErrorText: { type: String, default: "" },
  };

  static valueConstraints = {
    feedbackDuration: NUMBER_BOUNDS.timer,
  } satisfies NumberValueConstraints<typeof ClipboardController.values>;
  static actions = ["copy"] as const;
  static events = ["copy"] as const;

  declare readonly sourceTarget: HTMLElement;
  declare readonly buttonTarget: HTMLElement;
  declare readonly feedbackTarget: HTMLElement;
  declare readonly feedbackTargets: HTMLElement[];
  declare readonly hasSourceTarget: boolean;
  declare readonly hasButtonTarget: boolean;
  declare readonly hasFeedbackTarget: boolean;

  declare textValue: string;
  declare feedbackDurationValue: number;
  declare copiedLabelValue: string;
  declare errorLabelValue: string;
  declare announceCopiedTextValue: string;
  declare announceErrorTextValue: string;

  /**
   * The pending return to idle — the only timer this controller schedules, so
   * `clearAll()` is exactly "drop the auto-clear" and needs no id of its own.
   */
  readonly #timers = new SafeTimeout();

  /**
   * Whether this connection is still live. `copy()` suspends on the Clipboard API,
   * and a teardown that lands while it is suspended must win: the continuation
   * would otherwise write to an element nobody owns and arm a timer past the
   * `clearAll()` that was supposed to be the last word. Stimulus also runs the label
   * callbacks ahead of `connect()`, while this is still false: a result restored with
   * the markup is `connect()`'s to settle, not theirs.
   */
  #connected = false;
  #result: boolean | null = null;
  #feedback: { element: HTMLElement; original: string; text: string } | null = null;
  /**
   * Every feedback this controller wrote a result's wording into, with that wording. It
   * outlives a connection, so an in-page move still knows what it wrote.
   */
  readonly #written = new Map<HTMLElement, string>();
  readonly #morphRender = new MorphRenderWatcher(() => this.#renderResult());

  override connect(): void {
    this.#connected = true;
    this.#adopt();
    this.#result = null;
    this.#feedback = this.hasFeedbackTarget
      ? {
          element: this.feedbackTarget,
          original: this.feedbackTarget.textContent ?? "",
          text: this.feedbackTarget.textContent ?? "",
        }
      : null;
    this.#morphRender.observe(this.element);
  }

  override disconnect(): void {
    this.#connected = false;
    this.#morphRender.disconnect();
    this.#timers.clearAll();
  }

  /**
   * Follows a `copiedLabel` swapped in place while a successful copy is shown.
   *
   * Render only: nothing is announced or dispatched, and the return to idle keeps the
   * deadline the copy set. The slot changes only while `data-state` is `copied` and it
   * still reads the previous label — the one the copy wrote there — so text someone
   * else put in the slot stays. Stimulus also runs this ahead of `connect()`, which
   * settles a result restored with the markup itself, so nothing is written then.
   */
  copiedLabelValueChanged(label: string, previous: string | undefined): void {
    this.#followLabel("copied", label, previous);
  }

  /**
   * Follows an `errorLabel` swapped in place while a failed copy is shown, on the same
   * terms as {@link ClipboardController.copiedLabelValueChanged}: only while
   * `data-state` is `error` and the slot still reads the previous label.
   */
  errorLabelValueChanged(label: string, previous: string | undefined): void {
    this.#followLabel("error", label, previous);
  }

  /**
   * Copies the resolved text and reports the outcome. Bound via `data-action`
   * (click). Dispatches `stimeo--clipboard:copy` with `{ success, text, message }`
   * once per completed attempt — including on failure — so consumers can react
   * either way. `message` is the authored label for that outcome, so a part that
   * shows wording — `stimeo--clipboard:copy->stimeo--toast#show` — needs nothing
   * else; wiring both that and the announcer reads the same result twice.
   * An attempt whose connection ended while it was in flight reports nothing.
   */
  async copy(): Promise<void> {
    const text = this.#resolveText();
    let success = false;
    try {
      await navigator.clipboard.writeText(text);
      success = true;
    } catch {
      success = false;
    }
    if (!this.#connected) return;

    this.#reportResult(success);
    const message = success ? this.copiedLabelValue : this.errorLabelValue;
    this.dispatch("copy", { detail: { success, text, message } });
  }

  /**
   * The text to copy: the explicit `text` value when set, otherwise the source
   * target's current value (inputs/textareas) or text content.
   */
  #resolveText(): string {
    if (this.textValue.length > 0) return this.textValue;
    if (!this.hasSourceTarget) return "";
    const source = this.sourceTarget;
    if (source instanceof HTMLInputElement || source instanceof HTMLTextAreaElement) {
      return source.value;
    }
    return source.textContent ?? "";
  }

  /**
   * Reads the current state back from the DOM.
   *
   * A `copied` or `error` found at connect time is this controller's own output
   * from a connection that is gone, and so is the timer that would have cleared it
   * — nothing else would ever return the element to `idle`. Any other authored
   * value belongs to the consumer and only a missing attribute takes the default.
   */
  #adopt(): void {
    if (this.#inTransientState()) {
      const restored = this.#written.size === 0;
      this.#reset();
      // A fresh instance on restored markup has no write on record: the first feedback
      // holds the restored result's wording, which goes with the result.
      if (restored && this.hasFeedbackTarget) this.feedbackTarget.textContent = "";
      return;
    }
    setDefaultAttribute(this.element, "data-state", "idle");
  }

  /** Whether `data-state` currently holds one of the values this controller writes. */
  #inTransientState(): boolean {
    const state = this.element.getAttribute("data-state");
    return state !== null && TRANSIENT_STATES.has(state);
  }

  /**
   * Reflects the result, announces it, and schedules the return to idle.
   */
  #reportResult(success: boolean): void {
    this.#result = success;
    this.#renderResult(true);
    this.#announceResult(success);
    this.#scheduleReset();
  }

  /**
   * Repairs a held result without repeating its announcement or extending its deadline.
   * @stimeoRenderRoot
   */
  #renderResult(force = false): void {
    if (this.#result === null) {
      setDefaultAttribute(this.element, "data-state", "idle");
      return;
    }
    this.element.setAttribute("data-state", this.#result ? "copied" : "error");
    if (!this.hasFeedbackTarget) return;
    const element = this.feedbackTarget;
    const held = this.#feedback;
    if (
      !force &&
      (!held ||
        element !== held.element ||
        element.firstElementChild !== null ||
        (element.textContent !== held.text && element.textContent !== held.original))
    )
      return;
    const text = this.#result ? this.copiedLabelValue : this.errorLabelValue;
    this.#feedback = {
      element,
      original: held?.element === element ? held.original : (element.textContent ?? ""),
      text,
    };
    element.textContent = text;
    this.#written.set(element, text);
  }

  /**
   * Reads the result out through the shared announcer.
   *
   * @stimeoRuntimeOnly `announceCopiedText` / `announceErrorText` word the one announcement a copy
   *   makes.
   */
  #announceResult(success: boolean): void {
    announce(success ? this.announceCopiedTextValue : this.announceErrorTextValue);
  }

  /**
   * Arms the return to idle for the result just shown.
   *
   * @stimeoRuntimeOnly `feedbackDuration` is the delay of the one timer this call arms, and the
   *   reset that timer runs reads no Value.
   */
  #scheduleReset(): void {
    // Drop any in-flight reset so consecutive copies restart the full window
    // rather than having the earlier timer clear the new result prematurely.
    this.#timers.clearAll();
    if (this.#safeFeedbackDuration > 0) {
      this.#timers.set(() => this.#reset(), this.#safeFeedbackDuration);
    }
  }

  /**
   * Rewrites the slot to `label` while `state` is shown and the slot still reads
   * `previous`, the label this controller wrote for that result.
   */
  #followLabel(state: "copied" | "error", label: string, previous: string | undefined): void {
    if (!this.#connected) return;
    if (this.element.getAttribute("data-state") !== state || !this.hasFeedbackTarget) return;
    if (this.feedbackTarget.textContent !== previous) return;
    this.feedbackTarget.textContent = label;
    this.#written.set(this.feedbackTarget, label);
    if (this.#feedback?.element === this.feedbackTarget) this.#feedback.text = label;
  }

  /**
   * Returns to the idle state and empties each feedback this controller wrote into that is
   * still a feedback target showing the wording written there and nothing else. A slot the
   * page swapped in, rewrote, or put an element into keeps what it holds.
   */
  #reset(): void {
    this.#result = null;
    this.element.setAttribute("data-state", "idle");
    for (const [element, text] of this.#written) {
      if (!this.feedbackTargets.includes(element)) continue;
      if (element.firstElementChild === null && element.textContent === text) {
        element.textContent = "";
      }
    }
    this.#written.clear();
  }
  /** Current `feedbackDuration` declaration resolved against its numeric contract. */
  get #safeFeedbackDuration(): number {
    return this.#numbers.read(
      this,
      "feedbackDuration",
      this.feedbackDurationValue,
      ClipboardController.values.feedbackDuration.default,
      ClipboardController.valueConstraints.feedbackDuration,
    );
  }
}
