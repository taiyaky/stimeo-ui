import { Controller } from "@hotwired/stimulus";
import { announce } from "../utils/announce";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { setDefaultAttribute } from "../utils/default_attribute";
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
 *             data-action="stimeo--clipboard#copy">Copy</button>
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
 * copy — a reconnect and the before-cache rewind still clear it), `copiedLabel` /
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
 * connection, so a fresh `connect()` that finds either — a restored snapshot, an
 * in-page move — returns to `idle`, and the state is rewound before Turbo caches
 * the page ({@link BeforeCacheReset}). The rewind is silent: it discards nothing a
 * reconnect does not derive again.
 */
export class ClipboardController extends Controller<HTMLElement> {
  static override targets = ["source", "button", "feedback"];
  static override values = {
    text: { type: String, default: "" },
    feedbackDuration: { type: Number, default: 2000 },
    copiedLabel: { type: String, default: "Copied" },
    errorLabel: { type: String, default: "Copy failed" },
    announceCopiedText: { type: String, default: "" },
    announceErrorText: { type: String, default: "" },
  };
  static actions = ["copy"] as const;
  static events = ["copy"] as const;

  declare readonly sourceTarget: HTMLElement;
  declare readonly buttonTarget: HTMLElement;
  declare readonly feedbackTarget: HTMLElement;
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

  /** Returns the completion state to idle for the snapshot Turbo takes. */
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewind());

  /**
   * Whether this connection is still live. `copy()` suspends on the Clipboard API,
   * and a teardown that lands while it is suspended must win: the continuation
   * would otherwise write to an element nobody owns and arm a timer past the
   * `clearAll()` that was supposed to be the last word.
   */
  #connected = false;

  override connect(): void {
    this.#connected = true;
    this.#adopt();
    this.#beforeCache.activate();
  }

  override disconnect(): void {
    this.#connected = false;
    this.#beforeCache.deactivate();
    this.#timers.clearAll();
  }

  /**
   * Copies the resolved text and reports the outcome. Bound via `data-action`
   * (click). Dispatches `stimeo--clipboard:copy` with `{ success, text }` once per
   * completed attempt — including on failure — so consumers can react either way.
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
    this.dispatch("copy", { detail: { success, text } });
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
      this.#reset();
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
   * Returns the completion state to idle for the snapshot Turbo is about to take,
   * so a page reached with the Back button does not report a copy that happened
   * before the navigation. Only a state this controller wrote is rewound — an
   * authored one is the consumer's and has to survive into the snapshot, exactly as
   * `connect()` leaves it alone. State only — no `copy` is dispatched, which would
   * claim a fresh copy ran.
   */
  #rewind(): void {
    if (!this.#inTransientState()) return;
    this.#timers.clearAll();
    this.#reset();
  }

  /** Reflects the result, announces it, and schedules the return to idle. */
  #reportResult(success: boolean): void {
    this.element.setAttribute("data-state", success ? "copied" : "error");
    if (this.hasFeedbackTarget) {
      this.feedbackTarget.textContent = success ? this.copiedLabelValue : this.errorLabelValue;
    }
    announce(success ? this.announceCopiedTextValue : this.announceErrorTextValue);

    // Drop any in-flight reset so consecutive copies restart the full window
    // rather than having the earlier timer clear the new result prematurely.
    this.#timers.clearAll();
    if (this.feedbackDurationValue > 0) {
      this.#timers.set(() => this.#reset(), this.feedbackDurationValue);
    }
  }

  /** Returns to the idle state and empties the completion slot. */
  #reset(): void {
    this.element.setAttribute("data-state", "idle");
    if (this.hasFeedbackTarget) {
      this.feedbackTarget.textContent = "";
    }
  }
}
