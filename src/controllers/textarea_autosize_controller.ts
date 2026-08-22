import { Controller } from "@hotwired/stimulus";
import { LayoutObserver } from "../utils/layout_observer";

/** Parses a CSS pixel length, defaulting to 0 for `auto` / empty / `normal`. */
function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isNaN(n) ? 0 : n;
}

/** The event surface used by `document.fonts` without requiring it in older engines. */
interface FontEventSource {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

/**
 * Headless autosize behavior for a `<textarea>`: grows the element to fit its
 * content (and clamps to `minRows` / `maxRows`, scrolling past the max). No APG
 * pattern; supports WCAG 1.4.4 by following the text as it grows.
 *
 * Markup contract (identifier: `stimeo--textarea-autosize`):
 *   <textarea
 *     data-controller="stimeo--textarea-autosize"
 *     data-stimeo--textarea-autosize-max-rows-value="10"></textarea>
 *
 * Each re-measure collapses the element (`height:auto`), reads `scrollHeight`,
 * and sets an explicit pixel height clamped between `minRows` and `maxRows` (in
 * line-height units), toggling internal scrolling and the `data-at-max-rows`
 * hook at the cap. Height-only changes preserve focus and caret.
 *
 * Re-measure triggers: `connect()`; `input` and `change` on the element
 * (`change` covers programmatic writers that announce the write with a bubbling
 * event, the convention Stimeo's own field-writing controllers follow); element
 * size reports via the shared {@link LayoutObserver} — width changes
 * (re-wrapping) and the applied inline height being stripped (a Turbo morph
 * syncing attributes); font loading settling on `document.fonts`; runtime
 * `minRows` / `maxRows` changes; and the explicit `resize` action. A silent
 * `.value` assignment produces no DOM signal, so callers follow it with
 * `resize` or dispatch `input` / `change`.
 *
 * `resize` dispatches `{ height, rows }` only when the applied height differs
 * from the height this instance last applied. `connect()` adopts a height left
 * on the element by a previous connection (Turbo restore / morph), so restoring
 * an unchanged element stays silent.
 *
 * @remarks
 * Behavior only — the height is written to the element's own inline style, never
 * a CSS class. State lives on the element (no module-scope state), so `connect()`
 * re-measures after a Turbo navigation / morph. Every subscription (`input` /
 * `change` listeners, the layout observer, the font listeners) is released on
 * `disconnect()` (Turbo navigation included). Measurement is synchronous, so
 * there is no pending animation frame to tear down. The layout callback
 * re-measures only when the element's width changed or the applied inline
 * height vanished, so the controller's own height writes do not re-enter it.
 */
export class TextareaAutosizeController extends Controller<HTMLTextAreaElement> {
  static override values = {
    minRows: { type: Number, default: 1 },
    maxRows: { type: Number, default: 0 },
  };
  static actions = ["resize"] as const;
  static events = ["resize"] as const;

  declare minRowsValue: number;
  declare maxRowsValue: number;

  #lastHeight = -1;
  #lastWidth = -1;
  #started = false;
  #pending = false;
  #fonts: FontEventSource | null = null;

  /**
   * Content triggers arriving while the box is collapsed (`display: none`
   * ancestors) are deferred: `scrollHeight` is 0 there, so measuring would
   * clamp the kept height to the `minRows` floor and dispatch a bogus
   * `resize`. The next report from a rendered box flushes the deferral.
   */
  readonly #remeasure = (): void => {
    if (this.element.clientWidth === 0) {
      this.#pending = true;
      return;
    }
    this.resize();
  };

  /**
   * Re-measures when the content width changed (re-wrapping, including a
   * horizontal padding change under `border-box`), the applied inline height
   * was stripped (a Turbo morph syncing attributes from server HTML that has no
   * `style`), or a content trigger was deferred while the box was collapsed.
   * This instance's own height writes match none of these signals, so they
   * cannot re-enter; an authored inline height (e.g. a user dragging the native
   * resize handle) is left alone until the next content trigger. Reports from a
   * still-collapsed box are skipped (nothing is measurable there).
   */
  readonly #layout = new LayoutObserver(() => {
    if (this.element.clientWidth === 0) return;
    const width = this.#contentWidth();
    const stripped = this.element.style.height === "";
    if (width === this.#lastWidth && !stripped && !this.#pending) return;
    this.#lastWidth = width;
    this.resize();
  });

  override connect(): void {
    // Adopt a height applied by a previous connection (kept by Turbo restore /
    // morph) so re-measuring an unchanged element does not re-dispatch `resize`.
    this.#lastHeight = Math.round(px(this.element.style.height));
    this.#lastWidth = this.#contentWidth();
    this.element.addEventListener("input", this.#remeasure);
    this.element.addEventListener("change", this.#remeasure);
    this.#layout.observe(this.element);
    this.#bindFonts();
    this.#started = true;
    this.resize();
  }

  override disconnect(): void {
    this.#started = false;
    this.element.removeEventListener("input", this.#remeasure);
    this.element.removeEventListener("change", this.#remeasure);
    this.#layout.disconnect();
    this.#unbindFonts();
  }

  /** Re-clamps when application code or a Turbo morph changes `minRows`. */
  minRowsValueChanged(): void {
    if (this.#started) this.#remeasure();
  }

  /** Re-clamps when application code or a Turbo morph changes `maxRows`. */
  maxRowsValueChanged(): void {
    if (this.#started) this.#remeasure();
  }

  /** Re-measures the content and applies the clamped height. */
  resize(): void {
    this.#pending = false;
    const el = this.element;
    const style = window.getComputedStyle(el);
    const lineHeight = this.#lineHeight(style);
    const paddingV = px(style.paddingTop) + px(style.paddingBottom);
    const borderV = px(style.borderTopWidth) + px(style.borderBottomWidth);
    const borderBox = style.boxSizing === "border-box";

    // Collapse first so scrollHeight reflects the content, not the prior height.
    el.style.height = "auto";
    const contentHeight = Math.max(0, el.scrollHeight - paddingV);
    const rows = Math.max(1, Math.round(contentHeight / lineHeight));

    let targetContent = Math.max(contentHeight, this.minRowsValue * lineHeight);
    let atMax = false;
    if (this.maxRowsValue > 0) {
      const maxContent = this.maxRowsValue * lineHeight;
      if (targetContent > maxContent) {
        targetContent = maxContent;
        atMax = true;
      }
    }

    const boxExtra = borderBox ? paddingV + borderV : 0;
    const height = Math.round(targetContent + boxExtra);
    el.style.height = `${height}px`;
    el.style.overflowY = atMax ? "auto" : "hidden";

    if (atMax) {
      el.setAttribute("data-at-max-rows", "true");
    } else {
      el.removeAttribute("data-at-max-rows");
    }
    el.style.setProperty("--stimeo--textarea-rows", String(rows));

    if (height !== this.#lastHeight) {
      this.#lastHeight = height;
      this.dispatch("resize", { detail: { height, rows } });
    }
  }

  /** Content-box width — the wrapping input, unaffected by this instance's height writes. */
  #contentWidth(): number {
    const style = window.getComputedStyle(this.element);
    return Math.max(0, this.element.clientWidth - px(style.paddingLeft) - px(style.paddingRight));
  }

  /** Resolved line height, falling back to ~1.2× font-size when `normal`. */
  #lineHeight(style: CSSStyleDeclaration): number {
    const lh = px(style.lineHeight);
    if (lh > 0) return lh;
    const fontSize = px(style.fontSize);
    return fontSize > 0 ? fontSize * 1.2 : 16;
  }

  /** Subscribes to font completion when the current engine exposes `document.fonts`. */
  #bindFonts(): void {
    const fonts = (this.element.ownerDocument as Document & { fonts?: FontEventSource }).fonts;
    if (!fonts) return;
    this.#fonts = fonts;
    fonts.addEventListener("loadingdone", this.#remeasure);
    fonts.addEventListener("loadingerror", this.#remeasure);
  }

  /** Removes the font completion subscriptions. */
  #unbindFonts(): void {
    this.#fonts?.removeEventListener("loadingdone", this.#remeasure);
    this.#fonts?.removeEventListener("loadingerror", this.#remeasure);
    this.#fonts = null;
  }
}
