import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { AttributeLease } from "../utils/attribute_lease";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { CompositionTracker } from "../utils/composition_tracker";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { SafeTimeout } from "../utils/safe_timeout";

type CharacterCounterField = HTMLInputElement | HTMLTextAreaElement;
type DisplayMode = "remaining" | "used" | "both";

interface CharacterCountReading {
  readonly length: number;
  readonly remaining: number | null;
  readonly over: boolean;
  readonly max: number;
  readonly text: string;
}

type CharacterCounterDetail = Pick<CharacterCountReading, "length" | "remaining" | "over">;

/**
 * Headless character-counter behavior for a text field (no dedicated APG
 * pattern; follows the WCAG 2.2 "status messages" practice, 4.1.3).
 *
 * Markup contract (identifier: `stimeo--character-counter`):
 *   <div data-controller="stimeo--character-counter"
 *        data-stimeo--character-counter-max-value="140"
 *        data-stimeo--character-counter-announce-text-value="{remaining} characters remaining">
 *     <textarea data-stimeo--character-counter-target="input"
 *               aria-describedby="cc"></textarea>
 *     <span id="cc" data-stimeo--character-counter-target="output"></span>
 *   </div>
 *
 * Watches the field's UTF-16 code-unit length, writes the remaining/used count
 * into `output`, and toggles the `data-near-limit` / `data-over-limit` state
 * hooks. While over the limit it temporarily leases `aria-invalid="true"` on
 * the field and returns the consumer's authored value on recovery or teardown.
 * The field is the first `input` target, or — when the controller is attached
 * straight onto an `<input>`/`<textarea>` — the controller element itself.
 *
 * `change` and `reconcile` dispatch
 * `{ length: number, remaining: number | null, over: boolean }`.
 *
 * @remarks
 * Behavior only — count text and state update synchronously, with no styling.
 * Confirmed user input dispatches `stimeo--character-counter:change` only when
 * the measured length actually changes. Its detail is `{ length, remaining,
 * over }`; `remaining` is `null` when `max` is disabled. IME intermediate input
 * is ignored, and `compositionend` commits the confirmed value exactly once.
 *
 * Assistive notification is opt-in and i18n-neutral. `announceText` accepts
 * `{count}`, `{length}`, `{remaining}`, `{max}`, and `{over}` placeholders and
 * sends the settled message to the page's shared `stimeo--announcer` after a
 * short debounce. The visible `output` is not itself required to be a live
 * region. Initial reflection and Turbo restoration never dispatch or announce.
 * Runtime target/Value reconciliation dispatches
 * `stimeo--character-counter:reconcile` only when the public derived state
 * changes, and never announces.
 */
export class CharacterCounterController extends Controller<HTMLElement> {
  static override targets = ["input", "output"];
  static override values = {
    max: { type: Number, default: 0 },
    warnAt: { type: Number, default: 0 },
    mode: { type: String, default: "remaining" },
    announceText: { type: String, default: "" },
  };
  static events = ["change", "reconcile"] as const;

  declare readonly inputTarget: CharacterCounterField;
  declare readonly outputTarget: HTMLElement;
  declare readonly hasInputTarget: boolean;
  declare readonly hasOutputTarget: boolean;

  declare maxValue: number;
  declare warnAtValue: number;
  declare modeValue: string;
  declare announceTextValue: string;

  /** Delay (ms) before one settled count is sent to the shared announcer. */
  static readonly #announceDelay = 200;

  readonly #timeouts = new SafeTimeout();
  readonly #ariaInvalid = new AttributeLease<CharacterCounterField>("aria-invalid");
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindForCache());
  readonly #repaint = new MicrotaskCoalescer(() => this.#reconcile(true));
  readonly #composition = new CompositionTracker({
    onEnd: (event) => this.#commitFrom(event.currentTarget),
  });
  #announceId: number | null = null;
  #boundField: CharacterCounterField | null = null;
  #lastLength: number | null = null;
  #lastDetail: CharacterCounterDetail | null = null;
  #reflectedOver: boolean | null = null;

  readonly #onInput = (event: Event): void => {
    const field = this.#boundField;
    if (!field || event.currentTarget !== field || this.#field !== field) return;
    if (this.#composition.isComposing(event as InputEvent)) return;
    this.#commit(field);
  };

  /** Reflects the current DOM state and opens the mutation-reconciliation window. */
  override connect(): void {
    this.#repaint.activate();
    this.#beforeCache.activate();
    this.#reconcile(false);
  }

  /** Releases listeners, timers, borrowed ARIA, and controller-owned state hooks. */
  override disconnect(): void {
    this.#repaint.cancel();
    this.#beforeCache.deactivate();
    this.#cancelAnnouncement();
    this.#bindField(null);
    this.#composition.disconnect();
    this.#clearStateHooks();
    this.#lastLength = null;
    this.#lastDetail = null;
  }

  /** Rebinds and repaints after an input target is added or replaced at runtime. */
  inputTargetConnected(): void {
    this.#repaint.schedule();
  }

  /** Releases and repaints after an input target is removed or replaced at runtime. */
  inputTargetDisconnected(): void {
    this.#repaint.schedule();
  }

  /** Initializes a display target inserted after the controller connected. */
  outputTargetConnected(): void {
    this.#repaint.schedule();
  }

  /** Reconciles the optional display target set after a removal or replacement. */
  outputTargetDisconnected(): void {
    this.#repaint.schedule();
  }

  /** Repaints when application code or a Turbo morph changes `max`. */
  maxValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Repaints when application code or a Turbo morph changes `warnAt`. */
  warnAtValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Repaints when application code or a Turbo morph changes `mode`. */
  modeValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Cancels a pending old message when its consumer-authored template changes. */
  announceTextValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Rebinds one mutation batch and reports a changed controller-derived state. */
  #reconcile(report: boolean): void {
    const previous = this.#lastDetail;
    // An edit inside the debounce window has already earned an announcement.
    // Reconciliation never originates one, but it must not swallow that one
    // either: the pending message is retargeted at the settled reading, so the
    // user hears the count that ends up displayed rather than nothing. A
    // replaced field is the exception — its pending message describes a field
    // the reader can no longer reach.
    const owedField = this.#announceId === null ? null : this.#boundField;
    this.#cancelAnnouncement();
    this.#bindField(this.#field);
    if (this.#composition.isComposing()) return;
    const field = this.#boundField;
    if (!field) {
      this.#renderEmpty();
      this.#lastLength = null;
      this.#lastDetail = null;
      return;
    }
    const reading = this.#render(field);
    const detail = this.#detail(reading);
    this.#lastLength = reading.length;
    this.#lastDetail = detail;
    if (owedField === field) this.#scheduleAnnouncement(reading);
    if (report && previous && this.#detailsDiffer(previous, detail)) {
      this.dispatch("reconcile", { detail });
    }
  }

  /** Commits a composition only when it came from the field still owned here. */
  #commitFrom(target: EventTarget | null): void {
    const field = this.#boundField;
    if (!field || target !== field || this.#field !== field) return;
    this.#commit(field);
  }

  /** Reflects one confirmed user input and reports only a real length transition. */
  #commit(field: CharacterCounterField): void {
    const reading = this.#render(field);
    const previousLength = this.#lastLength;
    const previousDetail = this.#lastDetail;
    const detail = this.#detail(reading);
    this.#lastLength = reading.length;
    this.#lastDetail = detail;
    if (previousLength === reading.length) {
      if (previousDetail && this.#detailsDiffer(previousDetail, detail)) {
        this.dispatch("reconcile", { detail });
      }
      return;
    }

    this.dispatch("change", { detail });
    this.#scheduleAnnouncement(reading);
  }

  /** Selects the public event state from the richer internal reading. */
  #detail(reading: CharacterCountReading): CharacterCounterDetail {
    return {
      length: reading.length,
      remaining: reading.remaining,
      over: reading.over,
    };
  }

  /** Compares exactly the state carried by `change` and `reconcile`. */
  #detailsDiffer(left: CharacterCounterDetail, right: CharacterCounterDetail): boolean {
    return (
      left.length !== right.length || left.remaining !== right.remaining || left.over !== right.over
    );
  }

  /**
   * Synchronizes visible count, state hooks, and temporary validation ARIA.
   *
   * @stimeoRenderRoot
   */
  #render(field: CharacterCounterField): CharacterCountReading {
    const length = field.value.length;
    const max = this.#normalizeCount(this.maxValue);
    const warnAt = this.#normalizeCount(this.warnAtValue);
    const remaining = max > 0 ? max - length : null;
    const over = remaining !== null && remaining < 0;
    const near = remaining !== null && warnAt > 0 && !over && remaining <= warnAt;

    this.#toggle("data-over-limit", over);
    this.#toggle("data-near-limit", near);
    this.#reflectInvalid(field, over);

    const text = this.#format(length, remaining, max);
    this.#writeOutput(text);
    return { length, remaining, over, max, text };
  }

  /** Clears derived output when the declarative input set has no usable field. */
  #renderEmpty(): void {
    this.#ariaInvalid.returnAll();
    this.#reflectedOver = null;
    this.#clearStateHooks();
    this.#writeOutput("");
  }

  /** Replaces the observed field symmetrically, returning state from the old one. */
  #bindField(field: CharacterCounterField | null): void {
    if (field === this.#boundField) return;

    const previous = this.#boundField;
    if (previous) {
      previous.removeEventListener("input", this.#onInput);
      this.#composition.unobserve(previous);
      this.#ariaInvalid.return(previous);
    }

    this.#boundField = field;
    this.#lastLength = null;
    this.#reflectedOver = null;
    if (!field) return;

    field.addEventListener("input", this.#onInput);
    this.#composition.observe(field);
  }

  /** Leases `aria-invalid` only on the edge into over-limit, then returns it. */
  #reflectInvalid(field: CharacterCounterField, over: boolean): void {
    if (this.#reflectedOver === over) return;
    this.#reflectedOver = over;
    if (over) this.#ariaInvalid.write(field, "true");
    else this.#ariaInvalid.return(field);
  }

  /** Builds the visible count for the normalized display mode. */
  #format(length: number, remaining: number | null, max: number): string {
    if (remaining === null) return String(length);
    switch (this.#mode) {
      case "used":
        return String(length);
      case "both":
        return `${length}/${max}`;
      default:
        return String(remaining);
    }
  }

  /** Debounces one i18n-neutral message into the shared polite announcer. */
  #scheduleAnnouncement(reading: CharacterCountReading): void {
    this.#cancelAnnouncement();
    const message = fillTemplate(this.announceTextValue, {
      count: reading.text,
      length: reading.length,
      remaining: reading.remaining ?? "",
      max: reading.max,
      over: String(reading.over),
    });
    if (message.trim().length === 0) return;

    this.#announceId = this.#timeouts.set(() => {
      announce(message);
      this.#announceId = null;
    }, CharacterCounterController.#announceDelay);
  }

  /** Cancels the one outstanding announcement without touching visible output. */
  #cancelAnnouncement(): void {
    if (this.#announceId !== null) this.#timeouts.clear(this.#announceId);
    this.#announceId = null;
  }

  /** Writes the optional display only when its text actually changed. */
  #writeOutput(text: string): void {
    if (!this.hasOutputTarget || this.outputTarget.textContent === text) return;
    this.outputTarget.textContent = text;
  }

  /** Reflects a presence-style state hook without redundant attribute writes. */
  #toggle(name: string, on: boolean): void {
    if (on) {
      if (this.element.getAttribute(name) !== "true") this.element.setAttribute(name, "true");
    } else if (this.element.hasAttribute(name)) {
      this.element.removeAttribute(name);
    }
  }

  /** Removes both state hooks owned by this controller. */
  #clearStateHooks(): void {
    this.#toggle("data-over-limit", false);
    this.#toggle("data-near-limit", false);
  }

  /** Returns borrowed ARIA and transient hooks before Turbo snapshots the page. */
  #rewindForCache(): void {
    this.#cancelAnnouncement();
    this.#ariaInvalid.returnAll();
    this.#reflectedOver = null;
    this.#clearStateHooks();
  }

  /** Converts a public count Value into a finite non-negative integer. */
  #normalizeCount(raw: number): number {
    if (!Number.isFinite(raw)) return 0;
    return Math.max(0, Math.trunc(raw));
  }

  /** Falls back to `remaining` when an authored display mode is unknown. */
  get #mode(): DisplayMode {
    if (this.modeValue === "used" || this.modeValue === "both") return this.modeValue;
    return "remaining";
  }

  /** The watched field: the first target, or a directly controlled form field. */
  get #field(): CharacterCounterField | null {
    if (this.hasInputTarget) return this.inputTarget;
    const element: HTMLElement = this.element;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
      return element;
    return null;
  }
}
