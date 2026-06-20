import { Controller } from "@hotwired/stimulus";

/**
 * Headless, highly accessible Window Splitter / Resizable panes logic.
 *
 * Markup contract (identifier: `stimeo--resizable`):
 *   <div data-controller="stimeo--resizable"
 *        data-stimeo--resizable-min-value="20"
 *        data-stimeo--resizable-max-value="80"
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
 * - Auto-clamped flex-percentage updates with bounds safety.
 * - Smooth step keyboard adjustments for Arrow keys based on vertical/horizontal orientation.
 * - Root-level CSS custom property `--stimeo--resizable-fraction` (0..1) to drive presentation styles.
 *
 * @remarks
 * Behavior only. The controller adjusts the CSS custom property on the root element,
 * updates ARIA values on the separator, and emits `stimeo--resizable:change` events.
 */
export class ResizableController extends Controller<HTMLElement> {
  static override targets = ["primary", "secondary", "separator"];
  static override values = {
    min: { type: Number, default: 0 },
    max: { type: Number, default: 100 },
    step: { type: Number, default: 1 },
    value: { type: Number, default: 50 },
  };
  static actions = ["onKeydown", "onPointerDown", "toggle"] as const;
  static events = ["change"] as const;

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

  /** Track previously held value before collapse toggles. */
  #valueBeforeCollapse = 50;

  /** Aborts in-progress pointer-drag listeners when the drag ends or on teardown. */
  #dragAbort: AbortController | null = null;

  override connect(): void {
    this.#clampAndSync();
  }

  /** Cancels any active pointer drag so listeners never leak past disconnect. */
  override disconnect(): void {
    this.#dragAbort?.abort();
    this.#dragAbort = null;
  }

  /**
   * Stimulus lifecycle callback when the valueValue changes.
   * Keeps CSS fractions and ARIA status completely aligned.
   */
  valueValueChanged(): void {
    this.#clampAndSync();
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
    if (!this.hasSeparatorTarget) return;

    const orientation = this.separatorTarget.getAttribute("aria-orientation") || "vertical";
    const isVertical = orientation === "vertical";

    let handled = true;
    let nextValue = this.valueValue;

    switch (event.key) {
      case "ArrowLeft":
        if (isVertical) {
          nextValue -= this.stepValue;
        } else {
          handled = false;
        }
        break;
      case "ArrowRight":
        if (isVertical) {
          nextValue += this.stepValue;
        } else {
          handled = false;
        }
        break;
      case "ArrowUp":
        if (!isVertical) {
          nextValue -= this.stepValue;
        } else {
          handled = false;
        }
        break;
      case "ArrowDown":
        if (!isVertical) {
          nextValue += this.stepValue;
        } else {
          handled = false;
        }
        break;
      case "Home":
        nextValue = this.minValue;
        break;
      case "End":
        nextValue = this.maxValue;
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
      this.valueValue = Math.max(this.minValue, Math.min(nextValue, this.maxValue));
      this.#clampAndSync();
      this.#dispatchChange();
    }
  }

  /** Double-click or Enter to collapse/restore pane to min/max levels. */
  toggle(): void {
    const threshold = this.minValue + (this.maxValue - this.minValue) / 2;
    if (this.valueValue > this.minValue) {
      this.#valueBeforeCollapse = this.valueValue;
      this.valueValue = this.minValue;
    } else {
      this.valueValue =
        this.#valueBeforeCollapse >= threshold ? this.#valueBeforeCollapse : this.maxValue;
    }
    this.#clampAndSync();
    this.#dispatchChange();
  }

  readonly #onPointerMove = (event: PointerEvent): void => {
    if (!this.hasSeparatorTarget) return;

    const rect = this.element.getBoundingClientRect();
    const orientation = this.separatorTarget.getAttribute("aria-orientation") || "vertical";
    const isVertical = orientation === "vertical";

    let fraction = 0.5;

    if (isVertical) {
      fraction = (event.clientX - rect.left) / rect.width;
    } else {
      fraction = (event.clientY - rect.top) / rect.height;
    }

    // Restrict within absolute boundaries
    fraction = Math.max(0, Math.min(fraction, 1));
    const percent = Math.round(fraction * 100);

    this.valueValue = Math.max(this.minValue, Math.min(percent, this.maxValue));
    this.#clampAndSync();
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    if (!this.hasSeparatorTarget) return;

    const separator = this.separatorTarget;
    separator.releasePointerCapture(event.pointerId);

    this.element.removeAttribute("data-dragging");

    this.#dragAbort?.abort();
    this.#dragAbort = null;

    this.#dispatchChange();
  };

  #clampAndSync(): void {
    const clamped = Math.max(this.minValue, Math.min(this.valueValue, this.maxValue));

    // Keep the stored value in range so valueValue, ARIA, CSS, and dispatched
    // events never diverge (e.g. an initial value above max). Writing back
    // re-enters valueValueChanged once, but the value is already clamped there
    // so it does not recurse.
    if (this.valueValue !== clamped) {
      this.valueValue = clamped;
    }

    // Expose local fraction to consumer CSS custom property
    const fraction = clamped / 100;
    this.element.style.setProperty("--stimeo--resizable-fraction", String(fraction));

    if (this.hasSeparatorTarget) {
      this.separatorTarget.setAttribute("aria-valuenow", String(clamped));
      this.separatorTarget.setAttribute("aria-valuemin", String(this.minValue));
      this.separatorTarget.setAttribute("aria-valuemax", String(this.maxValue));
    }
  }

  #dispatchChange(): void {
    const fraction = this.valueValue / 100;
    this.dispatch("change", { detail: { value: this.valueValue, fraction } });
  }
}
