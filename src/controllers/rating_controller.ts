import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord } from "../utils/arrow_step";
import { AttributeLease } from "../utils/attribute_lease";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { isRtl } from "../utils/logical_scroll";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { RovingTabindex } from "../utils/roving_tabindex";
import { TabindexLoan } from "../utils/tabindex_loan";

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
 * `change` and `reconcile` dispatch `{ value: number }`.
 *
 * @remarks
 * Behavior only — consumers style `[aria-checked]` and `data-rating-hover`. In
 * `readonly` mode the group becomes `role="img"`; the consumer supplies the
 * human-readable accessible name (for example, "Rated 3 of 5"). Focus standing on
 * a symbol when that mode begins lands on the root and returns to the Tab stop
 * when it ends, so it is never left on a node outside the accessibility tree.
 *
 * `stimeo--rating:change` is reserved for a user operation that changes the
 * committed value. A DOM or configuration reconciliation that clamps the value
 * emits `stimeo--rating:reconcile` instead. Initial reflection emits neither.
 */
export class RatingController extends Controller<HTMLElement> {
  static override targets = ["symbol", "field"];
  static override values = {
    value: { type: Number, default: 0 },
    clearable: { type: Boolean, default: true },
    readonly: { type: Boolean, default: false },
  };
  static actions = ["endPreview", "onKeydown", "preview", "select"] as const;
  static events = ["change", "reconcile"] as const;

  declare readonly symbolTargets: HTMLElement[];
  declare readonly fieldTarget: HTMLInputElement;
  declare readonly hasFieldTarget: boolean;
  declare valueValue: number;
  declare clearableValue: boolean;
  declare readonlyValue: boolean;

  readonly #roving = new RovingTabindex(() => this.symbolTargets);
  readonly #rootRole = new AttributeLease<HTMLElement>("role");
  readonly #symbolRole = new AttributeLease<HTMLElement>("role");
  readonly #symbolAriaHidden = new AttributeLease<HTMLElement>("aria-hidden");
  readonly #rootTabindex = new TabindexLoan();
  readonly #repaint = new MicrotaskCoalescer(() => this.#reconcileScale());
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindForCache());
  #connected = false;
  #rescuedFocus = false;

  /** Reflects declarative state without announcing an initial user change. */
  override connect(): void {
    this.#repaint.activate();
    this.#beforeCache.activate();
    this.#apply(this.#normalize(this.valueValue), { focus: false });
    this.#connected = true;
  }

  /** Drops a queued reconciliation and hands every borrowed attribute back. */
  override disconnect(): void {
    this.#connected = false;
    this.#repaint.cancel();
    this.#beforeCache.deactivate();
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

  /** Selects or clears the clicked symbol. Bound via `data-action` (click). */
  select(event: Event): void {
    if (this.readonlyValue) return;
    const ordinal = this.#symbolOrdinal(event.currentTarget);
    if (ordinal === null) return;
    const current = this.#normalize(this.valueValue);
    this.#commit(this.clearableValue && ordinal === current ? 0 : ordinal, {
      focus: ordinal === current,
    });
  }

  /** Previews a fill range on hover or focus without committing it. */
  preview(event: Event): void {
    if (this.readonlyValue) return;
    const ordinal = this.#symbolOrdinal(event.currentTarget);
    if (ordinal !== null) this.#setFillRange(ordinal);
  }

  /** Restores the fill range after hover or focus leaves a symbol. */
  endPreview(): void {
    if (this.readonlyValue) return;
    this.#setFillRange(this.#normalize(this.valueValue));
  }

  /** Arrow/Home/End/Space/Delete keyboard control, clamped without wrapping. */
  onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || isReservedArrowChord(event) || this.readonlyValue) return;

    const current = this.#normalize(this.valueValue);
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
   * Repaints one settled target/Value mutation batch and reports only a value
   * this controller had to normalize.
   *
   * @stimeoRenderRoot
   */
  #reconcileScale(): void {
    const requested = this.valueValue;
    const value = this.#normalize(requested);
    this.#apply(value, { focus: false });
    if (!Object.is(value, requested)) {
      this.dispatch("reconcile", { detail: { value } });
    }
  }

  /** Applies one user operation and emits only when its committed value changes. */
  #commit(raw: number, { focus }: { focus: boolean }): void {
    const previous = this.#normalize(this.valueValue);
    const value = this.#normalize(raw);
    this.#apply(value, { focus });
    if (value !== previous) this.dispatch("change", { detail: { value } });
  }

  /** Synchronizes value, ARIA, roving focus, form state, and the visual fill hook. */
  #apply(value: number, { focus }: { focus: boolean }): void {
    if (!Object.is(this.valueValue, value)) this.valueValue = value;
    this.symbolTargets.forEach((symbol, index) => {
      symbol.setAttribute("aria-checked", value > 0 && index + 1 === value ? "true" : "false");
    });

    if (this.readonlyValue) {
      this.#applyReadonly();
    } else {
      const returning = this.#releaseReadonly();
      this.#roving.setActive(value > 0 ? value - 1 : 0, { focus: focus || returning });
    }

    if (this.hasFieldTarget) this.fieldTarget.value = String(value);
    this.#setFillRange(value);
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
   * wrote while readonly becomes the value the lease restores on release. The
   * return is a no-op on an attribute still holding this controller's own
   * write, which is the ordinary case.
   */
  #applyReadonly(): void {
    this.#rescueFocus();
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
   * Hands every readonly borrowing back before Turbo clones the page.
   *
   * The snapshot is taken while the controller is still connected, so an
   * element left as `role="img"` with hidden symbols is what a restored page
   * connects against — and that markup would be read as the authored one,
   * leaving no way back to the radiogroup. Rewinding first keeps the cached
   * copy identical to what the consumer wrote.
   */
  #rewindForCache(): void {
    this.#releaseReadonly();
    const value = this.#normalize(this.valueValue);
    this.#roving.setActive(value > 0 ? value - 1 : 0);
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
    this.element.focus();
    this.#rescuedFocus = true;
  }

  /**
   * Restores authored roles and visibility after leaving readonly mode.
   *
   * @returns whether focus is standing on the root because {@link #rescueFocus}
   *   put it there, and therefore belongs back on the Tab stop.
   */
  #releaseReadonly(): boolean {
    const returning = this.#rescuedFocus && document.activeElement === this.element;
    this.#rescuedFocus = false;
    this.#rootRole.return(this.element);
    this.#symbolRole.returnAll();
    this.#symbolAriaHidden.returnAll();
    this.#rootTabindex.returnAll();
    return returning;
  }

  /** Normalizes a raw value to an integer ordinal in the live DOM range. */
  #normalize(raw: number): number {
    const maximum = this.symbolTargets.length;
    const ordinal = Number.isFinite(raw) ? Math.round(raw) : this.#minValue;
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
}
