import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { AttributeLease } from "../utils/attribute_lease";
import { setAttributeIfChanged } from "../utils/attribute_write";
import { CompositionTracker } from "../utils/composition_tracker";
import { ListenerSet } from "../utils/listener_set";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
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
 * the field and, on recovery or teardown, gives the field back the value beneath
 * it: the consumer's authored value, or the latest value of a `stimeo--form-field`
 * whose control is the same field. The lease records the authored value on the
 * field, so the connection that adopts a copy of the page Turbo restores from its
 * cache gives it back once the field is within the limit — a password field comes
 * back empty. Nothing is undone on `turbo:before-cache`, which Turbo also
 * dispatches on pages that stay: an over-limit field stays invalid there.
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
 * All input targets keep composition tracking even while another one is first,
 * and only the first field's own conversion holds back its `input`.
 * A composing field that returns first restores its own accepted count silently;
 * its confirmation is compared with that field's accepted length, never another's,
 * and a confirmation or cancellation at that length dispatches `reconcile` once when
 * the state reported last differs from it. A conversion there that ends without
 * `compositionend` reconciles that accepted count the same way, without reading the
 * field; the next edit counts what the field holds.
 */
export class CharacterCounterController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override targets = ["input", "output"];
  static override values = {
    max: { type: Number, default: 0 },
    warnAt: { type: Number, default: 0 },
    mode: { type: String, default: "remaining" },
    announceText: { type: String, default: "" },
  };

  static valueConstraints = {
    max: NUMBER_BOUNDS.nonNegative,
    warnAt: NUMBER_BOUNDS.nonNegative,
  } satisfies NumberValueConstraints<typeof CharacterCounterController.values>;
  static events = ["change", "reconcile"] as const;

  declare readonly inputTarget: CharacterCounterField;
  declare readonly inputTargets: CharacterCounterField[];
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
  readonly #ariaInvalid = new AttributeLease<CharacterCounterField>(
    "aria-invalid",
    this.identifier,
  );
  readonly #repaint = new MorphRenderWatcher(() => this.#reconcile(true));
  /**
   * Commits a confirmed composition. One that ends without `compositionend`
   * confirmed nothing: a reconciliation it held reads what the field holds; with none
   * held the field's text waits for the next edit, and the state reported last is
   * reconciled with the field's accepted count. With a resync pass queued, or another
   * field first meanwhile, that is left to the pass, which counts the field it binds; the
   * end queues one, as it does for a reconciliation held, since a field put first and
   * taken away within one task is never reported. A field still bound that composes again
   * is not counted, so its accepted count is reconciled by a new conversion starting in it
   * while it is first, or else by the pass that finds it composing.
   */
  readonly #composition = new CompositionTracker({
    onStart: (event) => {
      if (event.target === this.#acceptedOwed && this.#field === this.#boundField) {
        this.#reconcileAccepted();
      }
    },
    onEnd: (event) => this.#commitFrom(event.currentTarget),
    onAbandon: () => {
      const first = this.#field === this.#boundField;
      if (this.#reconcileHeld && first) this.#recount(true, this.#owedField);
      else if (first && !this.#repaint.pending) this.#reconcileAccepted();
      else {
        if (!this.#reconcileHeld) this.#acceptedOwed = this.#boundField;
        // A field put first and taken away within the task is never reported: queue a pass.
        this.#repaint.schedule();
      }
    },
  });
  /** The field bound when its accepted-count reconciliation was left to a pass, until one runs. */
  #acceptedOwed: CharacterCounterField | null = null;
  /** A reconciliation owed once the composition ends: the declarations changed while it ran. */
  #reconcileHeld = false;
  /** Each field's accepted count and rendering, independent of the field in charge. */
  readonly #accepted = new WeakMap<
    CharacterCounterField,
    {
      readonly text: string;
      readonly over: boolean;
      readonly near: boolean;
      readonly length: number;
      readonly detail: CharacterCounterDetail;
      readonly declared: string;
    }
  >();
  #announceId: number | null = null;
  #boundField: CharacterCounterField | null = null;
  /** The input listener on the bound field; binding another field releases it first. */
  readonly #fieldListeners = new ListenerSet();
  #lastDetail: CharacterCounterDetail | null = null;
  #reflectedOver: boolean | null = null;

  readonly #onInput = (event: Event): void => {
    const field = this.#boundField;
    if (!field || event.currentTarget !== field || this.#field !== field) return;
    // An engine may echo a confirmed composition with one more `input`;
    // committing it again would re-run the reading the commit already took.
    if (this.#composition.consumesConfirmedInput(event)) return;
    // Only the field's own conversion holds its edit back, never one in another target.
    const composing = this.#composition.composingElement() === field;
    if (composing || (event as InputEvent).isComposing === true) return;
    this.#commit(field);
  };

  /**
   * Reflects the current DOM state and opens the mutation-reconciliation window. A
   * field that moved here with its conversion has nothing new to read; the pass waits
   * for the conversion only if the declarations changed with the move.
   */
  override connect(): void {
    this.#observeFields();
    this.#repaint.observe(this.element);
    this.#reconcile(false);
  }

  /** Releases listeners, timers, borrowed ARIA, and controller-owned state hooks. */
  override disconnect(): void {
    this.#repaint.disconnect();
    this.#bindField(null);
    this.#composition.disconnect();
    this.#clearStateHooks();
    this.#lastDetail = null;
  }

  /**
   * Rebinds and repaints after an input target is added or replaced at runtime. A
   * field that moved here keeping its conversion is the same field: the pass shows what
   * it showed and holds nothing.
   */
  inputTargetConnected(): void {
    this.#observeFields();
    this.#repaint.schedule();
  }

  /**
   * Releases and repaints after an input target is removed or replaced at runtime.
   * A field that moves or leaves mid-composition hears no `compositionend`, so its
   * composition ends here — unless it kept focus through the move, which keeps the
   * conversion; a field that stays bound is observed again at once. The pass counts
   * the field that is first now, and waits only for a conversion in that field.
   */
  inputTargetDisconnected(element: CharacterCounterField): void {
    this.#composition.unobserve(element);
    if (element === this.#boundField) this.#composition.observe(element);
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

  /** Rebinds one mutation batch, then counts the field bound now. */
  #reconcile(report: boolean): void {
    const owedField = this.#owedField;
    this.#bindField(this.#field);
    this.#recount(report, owedField);
  }

  /**
   * The field a pending announcement was earned for, if any. An edit inside the
   * debounce window has already earned an announcement. Reconciliation never
   * originates one, but it must not swallow that one either: a pass that counts again
   * retargets the pending message at the settled reading, so the user hears the count
   * that ends up displayed rather than nothing; a pass that only shows the count again
   * leaves it on the count shown, and the commit that applies a pass the composition
   * held retargets it. A replaced field is the exception — its pending message
   * describes a field the reader can no longer reach.
   */
  get #owedField(): CharacterCounterField | null {
    return this.#announceId === null ? null : this.#boundField;
  }

  /**
   * Counts the bound field and reports a changed controller-derived state. While the
   * field is composing, the pass shows what it showed and is owed when the composition
   * ends only if the declarations it counts against changed; a pass with nothing new
   * to count against — a morph that changes nothing, a target swapped — holds
   * nothing. A conversion going on in a field the counter no longer watches holds
   * nothing either.
   */
  #recount(report: boolean, owedField: CharacterCounterField | null): void {
    const owed = this.#acceptedOwed;
    this.#acceptedOwed = null;
    const previous = this.#lastDetail;
    const field = this.#boundField;
    if (field !== null && this.#composition.composingElement() === field) {
      this.#reconcileHeld = this.#accepted.get(field)?.declared !== this.#declared;
      // The IME owns the text: a morph that wiped the count gets back what it showed.
      this.#showAgain(field);
      // Composing again, the field is not counted for the reconciliation it was left.
      if (owed === field) this.#reconcileAccepted();
      return;
    }
    this.#reconcileHeld = false;
    if (!field) {
      this.#renderEmpty();
      this.#lastDetail = null;
      return;
    }
    const reading = this.#render(field);
    const detail = this.#detail(reading);
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
    const held = this.#reconcileHeld;
    this.#reconcileHeld = false;
    const previousLength = this.#accepted.get(field)?.length ?? null;
    const reading = this.#render(field);
    const previousDetail = this.#lastDetail;
    const detail = this.#detail(reading);
    this.#lastDetail = detail;
    if (previousLength === reading.length) {
      if (previousDetail && this.#detailsDiffer(previousDetail, detail)) {
        this.dispatch("reconcile", { detail });
      }
      // The pass the composition held counts again here, and takes the message along.
      if (held && this.#owedField === field) this.#scheduleAnnouncement(reading);
      return;
    }

    this.dispatch("change", { detail });
    if (this.#boundField === field && this.#field === field) this.#scheduleAnnouncement(reading);
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
    const max = this.#normalizeCount(this.#safeMax);
    const warnAt = this.#normalizeCount(this.#safeWarnAt);
    const remaining = max > 0 ? max - length : null;
    const over = remaining !== null && remaining < 0;
    const near = remaining !== null && warnAt > 0 && !over && remaining <= warnAt;

    this.#toggle("data-over-limit", over);
    this.#toggle("data-near-limit", near);
    this.#reflectInvalid(field, over);

    const text = this.#format(length, remaining, max);
    this.#writeOutput(text);
    this.#accepted.set(field, {
      text,
      over,
      near,
      length,
      detail: { length, remaining, over },
      declared: this.#declared,
    });
    return { length, remaining, over, max, text };
  }

  /**
   * Restores this field's accepted rendering without reading its composition draft.
   * Its accepted count remains the baseline even while another field is counted.
   * Nothing is reported here: the state reported last stays the one the commit that
   * ends the conversion compares with, so a commit at the accepted length reconciles
   * a state another field published meanwhile.
   */
  #showAgain(field: CharacterCounterField): void {
    const shown = this.#accepted.get(field);
    if (shown === undefined) return;
    this.#lastDetail ??= shown.detail;
    this.#toggle("data-over-limit", shown.over);
    this.#toggle("data-near-limit", shown.near);
    this.#reflectInvalid(field, shown.over);
    this.#writeOutput(shown.text);
  }

  /**
   * Reports the bound field's accepted count as `reconcile` when the state reported
   * last differs from it, without reading the field or announcing. Only that field's
   * own conversion, shown again silently, leaves the two apart.
   */
  #reconcileAccepted(): void {
    const previous = this.#lastDetail;
    const field = this.#boundField;
    const accepted = field && this.#accepted.get(field)?.detail;
    if (!previous || !accepted || !this.#detailsDiffer(previous, accepted)) return;
    this.#lastDetail = accepted;
    this.dispatch("reconcile", { detail: accepted });
  }

  /** Clears derived output when the declarative input set has no usable field. */
  #renderEmpty(): void {
    this.#reflectedOver = null;
    this.#clearStateHooks();
    this.#writeOutput("");
  }

  /** Tracks every target while only the field in charge supplies accepted input. */
  #observeFields(): void {
    for (const input of this.inputTargets) this.#composition.observe(input);
  }

  /** Replaces the input listener symmetrically, returning state from the old field. */
  #bindField(field: CharacterCounterField | null): void {
    if (field === this.#boundField) return;

    const previous = this.#boundField;
    if (previous) {
      this.#fieldListeners.dispose();
      if (previous !== this.element && !this.inputTargets.includes(previous)) {
        this.#composition.unobserve(previous);
      }
      this.#ariaInvalid.return(previous);
    }

    this.#cancelAnnouncement();
    this.#boundField = field;
    this.#reflectedOver = null;
    if (!field) return;

    this.#fieldListeners.add(field, "input", this.#onInput);
    this.#composition.observe(field);
  }

  /** Leases invalid state on an over-limit edge or missing output, preserving authored values. */
  #reflectInvalid(field: CharacterCounterField, over: boolean): void {
    if (this.#reflectedOver === over && (!over || field.hasAttribute("aria-invalid"))) return;
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

  /**
   * Debounces one i18n-neutral message into the shared polite announcer. The message
   * is worded when it is spoken, so a template the consumer changes meanwhile rewords
   * it; a template empty now schedules nothing.
   *
   * @stimeoRuntimeOnly `announceText` words the one announcement this call schedules;
   *   the count is painted by the marked renderer.
   */
  #scheduleAnnouncement(reading: CharacterCountReading): void {
    this.#cancelAnnouncement();
    const message = (): string =>
      fillTemplate(this.announceTextValue, {
        count: reading.text,
        length: reading.length,
        remaining: reading.remaining ?? "",
        max: reading.max,
        over: String(reading.over),
      });
    if (message().trim().length === 0) return;

    this.#announceId = this.#timeouts.set(() => {
      announce(message());
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
    setAttributeIfChanged(this.element, name, on ? "true" : null);
  }

  /** Removes both state hooks owned by this controller. */
  #clearStateHooks(): void {
    this.#toggle("data-over-limit", false);
    this.#toggle("data-near-limit", false);
  }

  /** Normalizes a finite count into a non-negative integer. */
  #normalizeCount(raw: number): number {
    return Math.max(0, Math.trunc(raw));
  }

  /** Falls back to `remaining` when an authored display mode is unknown. */
  get #mode(): DisplayMode {
    if (this.modeValue === "used" || this.modeValue === "both") return this.modeValue;
    return "remaining";
  }

  /** The declarations a rendering counts against, as it reads them. */
  get #declared(): string {
    return [
      this.#normalizeCount(this.#safeMax),
      this.#normalizeCount(this.#safeWarnAt),
      this.#mode,
    ].join();
  }

  /** The watched field: the first target, or a directly controlled form field. */
  get #field(): CharacterCounterField | null {
    if (this.hasInputTarget) return this.inputTarget;
    const element: HTMLElement = this.element;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
      return element;
    return null;
  }
  /** Current `max` declaration resolved against its numeric contract. */
  get #safeMax(): number {
    return this.#numbers.read(
      this,
      "max",
      this.maxValue,
      CharacterCounterController.values.max.default,
      CharacterCounterController.valueConstraints.max,
    );
  }

  /** Current `warnAt` declaration resolved against its numeric contract. */
  get #safeWarnAt(): number {
    return this.#numbers.read(
      this,
      "warnAt",
      this.warnAtValue,
      CharacterCounterController.values.warnAt.default,
      CharacterCounterController.valueConstraints.warnAt,
    );
  }
}
