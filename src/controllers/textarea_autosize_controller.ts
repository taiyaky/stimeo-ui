import { Controller } from "@hotwired/stimulus";

/** Parses a CSS pixel length, defaulting to 0 for `auto` / empty / `normal`. */
function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isNaN(n) ? 0 : n;
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
 * On connect and on every input it collapses the element (`height:auto`), reads
 * `scrollHeight`, and sets an explicit pixel height clamped between `minRows` and
 * `maxRows` (in line-height units), toggling internal scrolling and the
 * `data-at-max-rows` hook at the cap. Height-only changes preserve focus and caret.
 *
 * @remarks
 * Behavior only — the height is written to the element's own inline style, never a
 * CSS class. State lives on the element (no module-scope state), so `connect()`
 * re-measures after a Turbo navigation / morph. The input listener is removed on
 * `disconnect()` (Turbo navigation included). Measurement is synchronous, so there
 * is no pending animation frame to tear down.
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

  readonly #onInput = (): void => {
    this.resize();
  };

  override connect(): void {
    this.element.addEventListener("input", this.#onInput);
    this.resize();
  }

  override disconnect(): void {
    this.element.removeEventListener("input", this.#onInput);
  }

  /** Re-measures the content and applies the clamped height. */
  resize(): void {
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
    el.style.setProperty("--stimeo-textarea-rows", String(rows));

    if (height !== this.#lastHeight) {
      this.#lastHeight = height;
      this.dispatch("resize", { detail: { height, rows } });
    }
  }

  /** Resolved line height, falling back to ~1.2× font-size when `normal`. */
  #lineHeight(style: CSSStyleDeclaration): number {
    const lh = px(style.lineHeight);
    if (lh > 0) return lh;
    const fontSize = px(style.fontSize);
    return fontSize > 0 ? fontSize * 1.2 : 16;
  }
}
