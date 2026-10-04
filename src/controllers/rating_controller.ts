import { Controller } from "@hotwired/stimulus";
import { actionSource } from "../utils/action_source";
import { isReservedArrowChord } from "../utils/arrow_step";
import { AttributeLease } from "../utils/attribute_lease";
import { commitField, writeField } from "../utils/field_mirror";
import { isRtl } from "../utils/logical_scroll";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import { MoveCounter } from "../utils/move_counter";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { RovingTabindex } from "../utils/roving_tabindex";
import type { StateReason } from "../utils/state_reason";
import { TabindexLoan } from "../utils/tabindex_loan";
import { targetSelector } from "../utils/target_selector";

/**
 * Headless, accessible rating behavior over an ordinal symbol sequence.
 *
 * Markup contract (identifier: `stimeo--rating`):
 *   <div data-controller="stimeo--rating" role="radiogroup" aria-label="Rating"
 *        data-stimeo--rating-value-value="3">
 *     <span role="radio" aria-checked="false" aria-label="1 star" tabindex="-1"
 *           data-stimeo--rating-target="symbol"
 *           data-action="click->stimeo--rating#select
 *                        mouseenter->stimeo--rating#preview
 *                        mouseleave->stimeo--rating#endPreview
 *                        focus->stimeo--rating#preview
 *                        blur->stimeo--rating#endPreview
 *                        keydown->stimeo--rating#onKeydown">★</span>
 *     <!-- later symbols continue the 1..N scale in DOM order -->
 *     <input type="hidden" data-stimeo--rating-target="field" />
 *   </div>
 *
 * Implements the WAI-ARIA APG **Radio Group** pattern as an ordinal scale. The
 * live DOM order is the sole source of symbol values: the first symbol is 1 and
 * the last is N. Unlike a generic radio group, arrows deliberately clamp rather
 * than wrap because the values have an ordered lower and upper bound.
 *
 * `change` dispatches `{ value: number, reason: StateReason }`; `reconcile`
 * dispatches `{ value: number }`. A rating set through an action
 * also emits a native bubbling `change` from the hidden `field`, the way a form
 * control does, so `stimeo--auto-submit` and form-level validation hear it; a
 * repaint driven by the `value` Value, by a replacement field, or by the
 * controller's own normalization refreshes the mirror silently.
 *
 * All published state is settled before its reports. A synchronous listener
 * that confirms another value leaves that newer confirmation to report itself;
 * reports still pending for the replaced value are not sent. A read-only listener
 * or a confirmation that moves no published value leaves pending reports intact.
 * An event already being dispatched still reaches its remaining listeners.
 *
 * @remarks
 * Behavior only — consumers style `[aria-checked]` and `data-rating-hover`. In
 * `readonly` mode the group becomes `role="img"`; the consumer supplies the
 * human-readable accessible name (for example, "Rated 3 of 5"). Focus standing on
 * a symbol when that mode begins lands on the root and returns to the Tab stop
 * when it ends, so it is never left on a node outside the accessibility tree.
 * `turbo:before-cache`, which Turbo also dispatches on pages that stay, hands nothing
 * back; a page Turbo restores from its cache carries the authored values the readonly
 * leases recorded on the elements, so the restored rating stays readonly and turns back
 * into the authored radiogroup when readonly ends.
 *
 * The `value` Value is the page's request. The rating shown is that request
 * normalized to the live scale, and normalizing never writes the Value back: a
 * value clamped by a shorter scale or by `clearable` comes back once the scale
 * or `clearable` allows it again. A value the user sets is written into it.
 *
 * `stimeo--rating:change` is reserved for a user operation that changes the
 * committed value. Once connected, any other move of the rating shown — a
 * `value` written by application code or a morph, a symbol added or removed, a
 * `clearable` change — emits `stimeo--rating:reconcile` once per batch, measured
 * from the rating last shown. Initial reflection emits neither.
 */
export class RatingController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  readonly #moves = new MoveCounter();
  #move = 0;

  static override targets = ["symbol", "field"];
  static override values = {
    value: { type: Number, default: 0 },
    clearable: { type: Boolean, default: true },
    readonly: { type: Boolean, default: false },
  };

  static valueConstraints = {
    value: NUMBER_BOUNDS.finite,
  } satisfies NumberValueConstraints<typeof RatingController.values>;
  static actions = ["endPreview", "onKeydown", "preview", "select"] as const;
  static events = ["change", "reconcile"] as const;

  declare readonly symbolTargets: HTMLElement[];
  declare readonly fieldTarget: HTMLInputElement;
  declare readonly hasFieldTarget: boolean;
  declare valueValue: number;
  declare clearableValue: boolean;
  declare readonlyValue: boolean;

  readonly #roving = new RovingTabindex(() => this.symbolTargets);
  readonly #rootRole = new AttributeLease<HTMLElement>("role", this.identifier);
  readonly #symbolRole = new AttributeLease<HTMLElement>("role", this.identifier);
  readonly #symbolAriaHidden = new AttributeLease<HTMLElement>("aria-hidden", this.identifier);
  readonly #rootTabindex = new TabindexLoan("-1", this.identifier);
  readonly #repaint = new MorphRenderWatcher(() => this.#reconcileScale());
  #connected = false;
  #rescuedFocus = false;

  /** The rating shown last, which the next move is measured from. */
  #shown = 0;

  /** Reflects declarative state without announcing an initial user change. */
  override connect(): void {
    this.#rootTabindex.reclaim(this.element);
    this.#repaint.observe(this.element);
    this.#shown = this.#normalize(this.#safeValue);
    this.#apply(this.#shown, { focus: false });
    this.#connected = true;
  }

  /** Drops a queued reconciliation and hands every borrowed attribute back. */
  override disconnect(): void {
    this.#connected = false;
    this.#repaint.disconnect();
    this.#releaseReadonly();
  }

  /** Removes a runtime-added symbol's authored Tab stop before the batch repaint. */
  symbolTargetConnected(symbol: HTMLElement): void {
    if (this.#connected === false) return;
    symbol.tabIndex = -1;
    this.#repaint.schedule();
  }

  /** Releases readonly ownership and reconciles the remaining DOM-ordered scale. */
  symbolTargetDisconnected(symbol: HTMLElement): void {
    this.#symbolRole.return(symbol);
    this.#symbolAriaHidden.return(symbol);
    this.#repaint.schedule();
  }

  /** Reflects into a hidden field added or replaced after connection. */
  fieldTargetConnected(): void {
    this.#repaint.schedule();
  }

  /** Reconciles after a hidden field is removed or replaced. */
  fieldTargetDisconnected(): void {
    this.#repaint.schedule();
  }

  /** Repaints when application code or a Turbo morph changes `value`. */
  valueValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Repaints when application code changes whether value 0 is permitted. */
  clearableValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Repaints when application code enters or leaves the readonly snapshot. */
  readonlyValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Selects or clears an owned symbol named by an action or explicit element. */
  select(source: Event | HTMLElement): void {
    if (this.readonlyValue) return;
    const { event, host, origin, reason } = actionSource(source);
    const symbol = host?.closest<HTMLElement>(targetSelector(this.identifier, "symbol"));
    if (!symbol || !this.symbolTargets.includes(symbol)) return;
    if (origin && origin.closest(`[data-controller~="${this.identifier}"]`) !== this.element)
      return;
    const moveFocus = event !== null || this.element.contains(document.activeElement);
    const ordinal = this.#symbolOrdinal(symbol);
    if (ordinal === null) return;
    const current = this.#normalize(this.#safeValue);
    this.#commit(
      this.clearableValue && ordinal === current ? 0 : ordinal,
      {
        focus: ordinal === current && moveFocus,
      },
      reason,
    );
  }

  /** Previews a fill range on hover or focus without committing it. */
  preview(source: Event | HTMLElement): void {
    if (this.readonlyValue) return;
    const { host, origin } = actionSource(source);
    const symbol = host?.closest<HTMLElement>(targetSelector(this.identifier, "symbol"));
    if (!symbol || !this.symbolTargets.includes(symbol)) return;
    if (origin && origin.closest(`[data-controller~="${this.identifier}"]`) !== this.element)
      return;
    const ordinal = this.#symbolOrdinal(symbol);
    if (ordinal !== null) this.#setFillRange(ordinal);
  }

  /** Restores the fill range after hover or focus leaves a symbol. */
  endPreview(): void {
    if (this.readonlyValue) return;
    this.#setFillRange(this.#normalize(this.#safeValue));
  }

  /** Arrow/Home/End/Space/Delete keyboard control, clamped without wrapping. */
  onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || isReservedArrowChord(event) || this.readonlyValue) return;

    const current = this.#normalize(this.#safeValue);
    let next: number | null = null;
    const rtl = isRtl(this.element);

    // Horizontal keys follow writing direction. Vertical keys express value:
    // ArrowUp is always more and ArrowDown is always less.
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = current + (event.key === "ArrowRight" && rtl ? -1 : 1);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = current - (event.key === "ArrowLeft" && rtl ? -1 : 1);
        break;
      case "Home":
        next = this.#minValue;
        break;
      case "End":
        next = this.symbolTargets.length;
        break;
      case " ":
      case "Enter":
        next = this.#symbolOrdinal(event.currentTarget);
        break;
      case "Delete":
      case "Backspace":
        // A pointer clears by pressing the committed symbol again. This is the
        // keyboard's way to the same state, kept off Space so that a symbol
        // announced as a radio still answers Space the way a radio does.
        if (!this.clearableValue) return;
        next = 0;
        break;
      default:
        return;
    }

    if (next === null) return;
    event.preventDefault();
    this.#commit(next, { focus: true });
  }

  /**
   * Repaints one settled target/Value mutation batch and reports a rating shown
   * that moved from the one shown before it.
   *
   * @stimeoRenderRoot
   */
  #reconcileScale(): void {
    const value = this.#normalize(this.#safeValue);
    const previous = this.#shown;
    // Settled before the report, so a listener that moves the rating on is
    // measured from the value it was just told about.
    this.#shown = value;
    const move = this.#move;
    this.#apply(value, { focus: false });
    if (!this.#moves.isLatest(move)) return;
    if (value !== previous) this.dispatch("reconcile", { detail: { value } });
  }

  /**
   * Applies one user operation and emits only when the rating shown changes.
   *
   * The user's value is written into `value` before anything reports it, so a
   * listener of the field's native `change` already reads it there, and the pass
   * that the write starts finds nothing left to report.
   */
  #commit(raw: number, { focus }: { focus: boolean }, reason: StateReason = "user"): void {
    const previous = this.#shown;
    const value = this.#normalize(raw);
    if (!Object.is(this.valueValue, value)) this.valueValue = value;
    this.#shown = value;
    if (value !== previous) this.#move = this.#moves.record();
    const move = this.#move;
    const field = this.#apply(value, { focus });
    if (!this.#moves.isLatest(move)) return;
    if (field) commitField(field);
    if (!this.#moves.isLatest(move)) return;
    if (value !== previous) this.dispatch("change", { detail: { value, reason } });
  }

  /** Synchronizes ARIA, roving focus, form state, and the visual fill hook. */
  #apply(value: number, { focus }: { focus: boolean }): HTMLInputElement | null {
    const move = this.#move;
    this.symbolTargets.forEach((symbol, index) => {
      symbol.setAttribute("aria-checked", value > 0 && index + 1 === value ? "true" : "false");
    });

    const field = this.hasFieldTarget ? this.fieldTarget : null;
    const moved = field && writeField(field, String(value));
    this.#setFillRange(value);
    if (this.readonlyValue) {
      this.#applyReadonly();
    } else {
      const returning = this.#releaseReadonly();
      this.#roving.setActive(value > 0 ? value - 1 : 0, { focus: focus || returning });
    }

    if (this.#moves.isLatest(move)) this.#setFillRange(value);
    return moved ? field : null;
  }

  /** Marks the first `range` symbols with the consumer-owned fill hook. */
  #setFillRange(range: number): void {
    this.symbolTargets.forEach((symbol, index) => {
      symbol.toggleAttribute("data-rating-hover", range > 0 && index < range);
    });
  }

  /**
   * Temporarily turns the radiogroup into a non-interactive image snapshot.
   *
   * Each lease is returned before it is taken again, so a value the consumer
   * wrote while readonly becomes the value the lease restores on release. A
   * return restores the authored value while the controller's write remains,
   * and preserves a different value the consumer wrote.
   */
  #applyReadonly(): void {
    const move = this.#move;
    this.#rescueFocus();
    if (!this.#moves.isLatest(move)) return;
    this.#rootRole.return(this.element);
    this.#rootRole.write(this.element, "img");
    for (const symbol of this.symbolTargets) {
      this.#symbolRole.return(symbol);
      this.#symbolRole.write(symbol, null);
      this.#symbolAriaHidden.return(symbol);
      this.#symbolAriaHidden.write(symbol, "true");
    }
    this.#roving.setActive(-1);
  }

  /**
   * Lands focus on the root before the symbols leave the accessibility tree.
   *
   * A symbol holding focus when readonly begins would keep it while losing its
   * role and gaining `aria-hidden`, stranding the user on a node no longer in
   * the tree. The root is the one element that survives the transition named:
   * it carries the consumer's accessible name under `role="img"`.
   */
  #rescueFocus(): void {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === this.element) return;
    if (!this.element.contains(active)) return;
    this.#rootTabindex.lend(this.element);
    this.#rescuedFocus = true;
    this.element.focus();
  }

  /**
   * Restores authored roles and visibility after leaving readonly mode, on the symbols a
   * copy of the page carries from an earlier instance's readonly mode as well.
   *
   * @returns whether focus is standing on the root because {@link #rescueFocus}
   *   put it there, and therefore belongs back on the Tab stop.
   */
  #releaseReadonly(): boolean {
    const returning = this.#rescuedFocus && document.activeElement === this.element;
    this.#rescuedFocus = false;
    this.#rootRole.return(this.element);
    for (const symbol of this.symbolTargets) {
      this.#symbolRole.return(symbol);
      this.#symbolAriaHidden.return(symbol);
    }
    this.#symbolRole.returnAll();
    this.#symbolAriaHidden.returnAll();
    this.#rootTabindex.returnAll();
    return returning;
  }

  /** Normalizes a finite value to an integer ordinal in the live DOM range. */
  #normalize(raw: number): number {
    const maximum = this.symbolTargets.length;
    const ordinal = Math.round(raw);
    return Math.min(maximum, Math.max(this.#minValue, ordinal));
  }

  /** Lowest selectable value: 0 when clearable, otherwise 1. */
  get #minValue(): number {
    return this.clearableValue ? 0 : 1;
  }

  /** Returns a target's 1-based position, or null when the action host is invalid. */
  #symbolOrdinal(target: EventTarget | null): number | null {
    const targets: readonly (EventTarget | null)[] = this.symbolTargets;
    const index = targets.indexOf(target);
    return index < 0 ? null : index + 1;
  }
  /** Current `value` declaration resolved against its numeric contract. */
  get #safeValue(): number {
    return this.#numbers.read(
      this,
      "value",
      this.valueValue,
      RatingController.values.value.default,
      RatingController.valueConstraints.value,
    );
  }
}
