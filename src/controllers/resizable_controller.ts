import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord } from "../utils/arrow_step";
import { ownerIndex } from "../utils/event_owner";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { TabindexLoan } from "../utils/tabindex_loan";
import { TransientHooks } from "../utils/transient_hooks";

/** The hook a connection may find written by an earlier, now-gone one. */
const TRANSIENT = new TransientHooks({ attributes: ["data-dragging"] });

/** Value defaults, reused when a declaration cannot be read as a percentage. */
const DEFAULT_MIN = 0;
const DEFAULT_MAX = 100;
const DEFAULT_VALUE = 50;
const DEFAULT_STEP = 1;

/**
 * Headless, highly accessible Window Splitter / Resizable panes logic.
 *
 * Markup contract (identifier: `stimeo--resizable`):
 *   <div data-controller="stimeo--resizable"
 *        data-stimeo--resizable-min-value="20"
 *        data-stimeo--resizable-max-value="80"
 *        data-stimeo--resizable-step-value="1"
 *        data-stimeo--resizable-value-value="50">
 *     <div data-stimeo--resizable-target="primary" id="pane-1">Pane A</div>
 *     <div role="separator" tabindex="0" aria-orientation="vertical"
 *          aria-controls="pane-1" aria-valuemin="20" aria-valuemax="80"
 *          aria-valuenow="50" aria-label="Resize splitter"
 *          data-stimeo--resizable-target="separator"
 *          data-action="pointerdown->stimeo--resizable#onPointerDown
 *                       keydown->stimeo--resizable#onKeydown"></div>
 *     <div data-stimeo--resizable-target="secondary">Pane B</div>
 *   </div>
 *
 * Implements the WAI-ARIA APG **Window Splitter** pattern:
 * - Robust dragging track using W3C `setPointerCapture` to ensure uninterrupted dragging
 *   even when pointers quickly stray outside the separator area.
 * - Arrow keys move the divider by `step` percent, along the axis
 *   `aria-orientation` names; `Home` / `End` jump to the ends of the range.
 * - `Enter` collapses the primary pane to the minimum and puts it back where it
 *   was, which is what the pattern means by restoring a previous position.
 * - Root-level CSS custom property `--stimeo--resizable-fraction` (0..1) driving
 *   presentation styles.
 * - `F6` cycles focus through the panes, which the pattern lists as optional.
 *
 * `change` and `reconcile` dispatch `{ value: number, fraction: number }`.
 *
 * @remarks
 * Behavior only. The controller adjusts the CSS custom property on the root element,
 * updates ARIA values on the separator, and emits `stimeo--resizable:change` events.
 *
 * Both the range and the position are percentages. A bound that is not a finite
 * number falls back to its Value default, a maximum below the minimum collapses
 * onto that minimum, and a step that is not a positive finite number falls back
 * to `1` — so an unreadable declaration narrows what the widget can do without
 * ever publishing `NaN` to CSS or to assistive tech.
 *
 * The Values are inputs. A declared `value` outside the range stays in its
 * attribute as the page wrote it; the separator's ARIA, the fraction and both
 * events carry the clamped position instead, and only a move the user makes
 * writes `value`. `change` reports a key press, drag or toggle that moved the
 * position from the one last confirmed — a drag once, when it ends — and
 * nothing for one that leaves it there: a key at an edge, a press released
 * without moving, a drag released where it started. When a Value the page
 * changes at runtime — a Turbo morph or application code — moves the position,
 * `reconcile` reports it once per batch with the same detail, so a consumer can
 * tell its user's move from the page's. Connecting reports neither. The
 * position last confirmed is the one connecting published, moved by each
 * `change` and `reconcile`; the positions a drag paints on the way do not move
 * it.
 *
 * `aria-orientation` is the author's, and its absence means `horizontal` — the
 * value ARIA gives a separator that does not say. Reading any other default here
 * would make the announced axis and the answering arrow keys disagree.
 */
export class ResizableController extends Controller<HTMLElement> {
  static override targets = ["primary", "secondary", "separator"];
  static override values = {
    min: { type: Number, default: DEFAULT_MIN },
    max: { type: Number, default: DEFAULT_MAX },
    step: { type: Number, default: DEFAULT_STEP },
    value: { type: Number, default: DEFAULT_VALUE },
  };
  static actions = ["onKeydown", "onPointerDown", "toggle"] as const;
  static events = ["change", "reconcile"] as const;

  declare readonly primaryTarget: HTMLElement;
  declare readonly secondaryTarget: HTMLElement;
  declare readonly separatorTarget: HTMLElement;
  declare readonly hasPrimaryTarget: boolean;
  declare readonly hasSecondaryTarget: boolean;
  declare readonly hasSeparatorTarget: boolean;

  declare minValue: number;
  declare maxValue: number;
  declare stepValue: number;
  declare valueValue: number;

  /** Where the divider sat before the current collapse; `null` when unknown. */
  #valueBeforeCollapse: number | null = null;

  /**
   * The position last painted: moved by each move the user makes — every step of
   * a drag included — and by each repaint that finds a page-driven move.
   */
  #painted = DEFAULT_VALUE;

  /**
   * The position last confirmed: the one connecting published, then moved by
   * each `change` and `reconcile`. A drag moves the painted position step by
   * step and this one only when it ends.
   */
  #confirmed = DEFAULT_VALUE;

  /** Aborts in-progress pointer-drag listeners when the drag ends or on teardown. */
  #dragAbort: AbortController | null = null;

  /** `tabindex` lent to a pane so `F6` can put focus on it; panes carry none. */
  readonly #paneTabindex = new TabindexLoan();

  /** Releases the pane cycle listener bound in {@link connect}. */
  #cycleAbort: AbortController | null = null;

  /** Folds the range and position inputs of one morph batch into a single paint. */
  readonly #repaint = new MicrotaskCoalescer(() => this.#render());

  override connect(): void {
    // A drag cannot outlive a navigation, so a hook captured mid-drag is stale on
    // arrival. Clearing is unconditional here because disconnect() aborts the
    // drag, leaving no session that an in-page move could carry over.
    TRANSIENT.reset(this.element);
    this.#repaint.activate();
    // Stimulus fires the value callbacks before connect, where the coalescer
    // ignores them, so the first paint has to be asked for directly. The
    // position it publishes is taken as reported first, so connecting reports
    // nothing.
    this.#confirmed = this.#position;
    this.#render();
    // Bound on the root rather than the panes so the cycle continues once focus
    // has left the separator — the panes hold consumer markup and the next F6
    // arrives from inside one of them.
    this.#cycleAbort = new AbortController();
    this.element.addEventListener("keydown", this.#onCycleKeydown, {
      signal: this.#cycleAbort.signal,
    });
  }

  /** Cancels any active pointer drag so listeners never leak past disconnect. */
  override disconnect(): void {
    this.#dragAbort?.abort();
    this.#dragAbort = null;
    this.#cycleAbort?.abort();
    this.#cycleAbort = null;
    this.#repaint.cancel();
    this.#paneTabindex.returnAll();
    this.element.removeAttribute("data-dragging");
  }

  /** Moves focus to the next pane on `F6`, wrapping; entering at the first one. */
  readonly #onCycleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "F6") return;
    // Japanese input methods bind F6 to a conversion, so a press that belongs to
    // a composition steers that conversion and must not move focus away from it.
    if (event.isComposing) return;
    // A descendant widget that already claimed the key must not ALSO cycle the
    // panes; this listener sees consumer markup, so composition depends on it.
    if (event.defaultPrevented) return;
    // The pattern binds a bare F6 only. A chorded one is the browser's or the
    // OS's (Ctrl+F6 cycles frames in several browsers).
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

    const panes: HTMLElement[] = [];
    if (this.hasPrimaryTarget) panes.push(this.primaryTarget);
    if (this.hasSecondaryTarget) panes.push(this.secondaryTarget);

    const current = ownerIndex(panes, event.target);
    // With no panes the modulo is NaN and the read is undefined, which is the
    // same "nowhere to go" this guard answers for a cycle that has ends.
    const next = panes[(current + 1) % panes.length];
    if (!next) return;

    event.preventDefault();
    this.#paneTabindex.lend(next);
    next.focus();
  };

  /** Re-renders when application code (or a Turbo morph) changes `value` at runtime. */
  valueValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Re-renders when application code (or a Turbo morph) changes `min` at runtime. */
  minValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Re-renders when application code (or a Turbo morph) changes `max` at runtime. */
  maxValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Re-publishes range and position onto a separator swapped in after connect. */
  separatorTargetConnected(): void {
    this.#repaint.schedule();
  }

  /** Starts active pointer drag tracking and locks capture. */
  onPointerDown(event: PointerEvent): void {
    if (!this.hasSeparatorTarget || event.button !== 0) return;

    event.preventDefault();

    const separator = this.separatorTarget;
    separator.setPointerCapture(event.pointerId);
    // preventDefault() above suppresses the implicit focus, so move focus
    // explicitly — otherwise keyboard (arrow) adjustments never reach the
    // separator after a pointer interaction (WCAG 2.1.1).
    separator.focus();

    this.element.setAttribute("data-dragging", "true");

    this.#dragAbort?.abort();
    const abort = new AbortController();
    this.#dragAbort = abort;
    separator.addEventListener("pointermove", this.#onPointerMove, { signal: abort.signal });
    separator.addEventListener("pointerup", this.#onPointerUp, { signal: abort.signal });
    separator.addEventListener("pointercancel", this.#onPointerUp, { signal: abort.signal });
  }

  /** Keydown adjustments for ArrowUp/Down/Left/Right and Home/End. */
  onKeydown(event: KeyboardEvent): void {
    if (isReservedArrowChord(event)) return;
    if (!this.hasSeparatorTarget) return;

    const { min, max } = this.#range;
    const isVertical = this.#isVertical;

    let handled = true;
    let nextValue = this.#position;

    switch (event.key) {
      case "ArrowLeft":
        if (isVertical) {
          nextValue -= this.#step;
        } else {
          handled = false;
        }
        break;
      case "ArrowRight":
        if (isVertical) {
          nextValue += this.#step;
        } else {
          handled = false;
        }
        break;
      case "ArrowUp":
        if (!isVertical) {
          nextValue -= this.#step;
        } else {
          handled = false;
        }
        break;
      case "ArrowDown":
        if (!isVertical) {
          nextValue += this.#step;
        } else {
          handled = false;
        }
        break;
      case "Home":
        nextValue = min;
        break;
      case "End":
        nextValue = max;
        break;
      case "Enter":
        event.preventDefault();
        this.toggle();
        return;
      default:
        handled = false;
        break;
    }

    if (handled) {
      event.preventDefault();
      this.#commit(nextValue);
    }
  }

  /** Collapses the primary pane to its minimum, or returns it to the last position. */
  toggle(): void {
    const { min, max } = this.#range;
    if (this.#position > min) {
      this.#valueBeforeCollapse = this.#position;
      this.#commit(min);
    } else {
      // With nothing remembered — a controller that connected to an already
      // collapsed pane — there is no previous position, so open the pane fully.
      const restored = this.#valueBeforeCollapse ?? max;
      this.#valueBeforeCollapse = null;
      this.#commit(restored);
    }
  }

  readonly #onPointerMove = (event: PointerEvent): void => {
    if (!this.hasSeparatorTarget) return;

    const rect = this.element.getBoundingClientRect();
    const raw = this.#isVertical
      ? (event.clientX - rect.left) / rect.width
      : (event.clientY - rect.top) / rect.height;

    // A container with no extent divides by zero; treat that as the near end
    // rather than letting it reach the published fraction.
    const fraction = Number.isFinite(raw) ? Math.max(0, Math.min(raw, 1)) : 0;
    this.#move(Math.round(fraction * 100));
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    // Ending the drag must not depend on the separator still being there: a
    // target removed mid-drag would otherwise strand the hook and the listeners.
    this.element.removeAttribute("data-dragging");
    this.#dragAbort?.abort();
    this.#dragAbort = null;

    if (this.hasSeparatorTarget) {
      this.separatorTarget.releasePointerCapture(event.pointerId);
    }

    this.#confirm();
  };

  /** Moves to a position the user chose and reports it if it moved. */
  #commit(raw: number): void {
    this.#move(raw);
    this.#confirm();
  }

  /**
   * Stores the clamped position the user moved to and paints it. The painted
   * position moves with it before anything is reported, so the repaint the Value
   * write schedules — and any move a subscriber makes while `change` is
   * dispatched — is measured from this position.
   */
  #move(raw: number): void {
    const { min, max } = this.#range;
    const position = Math.max(min, Math.min(raw, max));
    this.valueValue = position;
    this.#painted = position;
    this.#paint();
  }

  /**
   * Publishes the position the Values declare without writing it back. A
   * position the user did not paint is the page's move, reported once as
   * `reconcile` unless it lands on the position last confirmed — a drag the page
   * puts back where it started has nothing new to report.
   *
   * @stimeoRenderRoot
   */
  #render(): void {
    this.#paint();
    const position = this.#position;
    if (position === this.#painted) return;
    this.#painted = position;
    if (position === this.#confirmed) return;
    this.#confirmed = position;
    this.dispatch("reconcile", { detail: this.#detail(position) });
  }

  /**
   * Publishes the position: the fraction consumer CSS multiplies a pane by, and
   * the range assistive tech reads off the separator.
   */
  #paint(): void {
    const { min, max } = this.#range;
    const position = this.#position;

    this.element.style.setProperty("--stimeo--resizable-fraction", String(position / 100));

    if (this.hasSeparatorTarget) {
      this.separatorTarget.setAttribute("aria-valuenow", String(position));
      this.separatorTarget.setAttribute("aria-valuemin", String(min));
      this.separatorTarget.setAttribute("aria-valuemax", String(max));
    }
  }

  /**
   * Reports the published position as `change` when the user's operation moved
   * it from the position last confirmed. A key at an edge, a press released
   * without moving and a drag released where it started report nothing.
   */
  #confirm(): void {
    const position = this.#position;
    if (position === this.#confirmed) return;
    this.#confirmed = position;
    this.dispatch("change", { detail: this.#detail(position) });
  }

  /** The detail both events carry for `position`. */
  #detail(position: number): { value: number; fraction: number } {
    return { value: position, fraction: position / 100 };
  }

  /** The declared range after validation; an unreadable bound uses its default. */
  get #range(): { readonly min: number; readonly max: number } {
    const min = Number.isFinite(this.minValue) ? this.minValue : DEFAULT_MIN;
    const max = Number.isFinite(this.maxValue) ? this.maxValue : DEFAULT_MAX;
    // A maximum below the minimum describes no range at all; collapsing it onto
    // the minimum keeps the position inside something that can be announced.
    return { min, max: Math.max(min, max) };
  }

  /** The declared position, clamped into the validated range. */
  get #position(): number {
    const { min, max } = this.#range;
    const value = Number.isFinite(this.valueValue) ? this.valueValue : DEFAULT_VALUE;
    return Math.max(min, Math.min(value, max));
  }

  /** The keyboard increment; a non-positive or unreadable one uses the default. */
  get #step(): number {
    return Number.isFinite(this.stepValue) && this.stepValue > 0 ? this.stepValue : DEFAULT_STEP;
  }

  /** Whether the divider runs vertically; a separator that does not say is horizontal. */
  get #isVertical(): boolean {
    return (
      this.hasSeparatorTarget &&
      this.separatorTarget.getAttribute("aria-orientation") === "vertical"
    );
  }
}
