import { Controller } from "@hotwired/stimulus";

/** CSS custom property exposing the current color to consumer CSS. */
const COLOR_PROPERTY = "--stimeo-color";

/** A color channel slider, identified by its `data-channel` attribute. */
type Channel = "hue" | "saturation" | "lightness" | "alpha";

/** Default `[min, max]` per channel when the slider omits aria-valuemin/max. */
const CHANNEL_RANGE: Record<Channel, [number, number]> = {
  hue: [0, 360],
  saturation: [0, 100],
  lightness: [0, 100],
  alpha: [0, 100],
};

/** Internal color model: HSL plus an alpha percentage (0–100). */
interface Hsla {
  hue: number;
  saturation: number;
  lightness: number;
  alpha: number;
}

/**
 * Headless, accessible **Color Picker** behavior.
 *
 * Markup contract (identifier: `stimeo--color-picker`):
 *   <div data-controller="stimeo--color-picker"
 *        data-stimeo--color-picker-value-value="#3366cc">
 *     <div role="slider" aria-label="Hue" data-channel="hue" tabindex="0"
 *          aria-valuemin="0" aria-valuemax="360" aria-valuenow="210"
 *          data-stimeo--color-picker-target="slider"
 *          data-action="keydown->stimeo--color-picker#onKeydown
 *                       pointerdown->stimeo--color-picker#onPointerDown"></div>
 *     <!-- saturation / lightness / alpha sliders share the same contract -->
 *     <input type="text" aria-label="Hex color"
 *            data-stimeo--color-picker-target="hex"
 *            data-action="change->stimeo--color-picker#onHexInput" />
 *     <div data-stimeo--color-picker-target="preview" aria-hidden="true"></div>
 *     <input type="hidden" data-stimeo--color-picker-target="field" />
 *   </div>
 *
 * Decomposes color selection into independent APG **Slider** channels (hue,
 * saturation, lightness, optional alpha) instead of a 2-D palette, so every
 * adjustment is keyboard- and screen-reader-operable. Each slider exposes
 * `aria-valuenow` and a human-readable `aria-valuetext` (e.g. "Hue 210 degrees");
 * the hex input stays two-way synced; the current color is published on the
 * preview and root as the `--stimeo-color` custom property and mirrored into a
 * hidden form field.
 *
 * @remarks
 * Behavior only — the swatch/gradient visuals are the consumer's CSS/canvas, fed
 * by `--stimeo-color`. Pointer-drag listeners on `document` are bound to an
 * {@link AbortController} and released on drag end and on `disconnect()` (Turbo
 * navigation included). Color is fully reconstructable from the `value` (hex), so
 * there is no transient state to restore after a Turbo cache/morph.
 *
 * The internal model is integer HSL(A), so a hex → HSL → hex round-trip is not
 * exactly bijective: a typed hex can normalize to a near (not identical) value
 * once the HSL sliders are touched. This keeps the model small and zero-dep; use a
 * dedicated color library on the consumer side if exact hex preservation matters.
 */
export class ColorPickerController extends Controller<HTMLElement> {
  static override targets = ["slider", "hex", "preview", "field"];
  static override values = {
    value: { type: String, default: "#000000" },
    alpha: { type: Boolean, default: false },
  };
  static actions = ["onHexInput", "onKeydown", "onPointerDown"] as const;
  static events = ["change"] as const;

  declare readonly sliderTargets: HTMLElement[];
  declare readonly hexTarget: HTMLInputElement;
  declare readonly hasHexTarget: boolean;
  declare readonly previewTargets: HTMLElement[];
  declare readonly fieldTargets: HTMLInputElement[];
  declare valueValue: string;
  declare alphaValue: boolean;

  /** The current color in the editing model. */
  #color: Hsla = { hue: 0, saturation: 0, lightness: 0, alpha: 100 };
  /** Aborts in-progress pointer-drag listeners on drag end / teardown. */
  #dragAbort: AbortController | null = null;

  /** Seeds the model from the initial hex value and renders every surface. */
  override connect(): void {
    const parsed = hexToHsla(this.valueValue);
    // When alpha is disabled, drop any alpha carried by an `#RRGGBBAA` value so
    // the model stays opaque — otherwise `hexString()` would emit `#RRGGBB`
    // while `change` reported `rgba.a < 1`. Mirrors `onHexInput()`.
    if (parsed) this.#color = this.alphaValue ? parsed : { ...parsed, alpha: 100 };
    this.#render();
  }

  /** Cancels any active pointer drag so document listeners never leak. */
  override disconnect(): void {
    this.#dragAbort?.abort();
    this.#dragAbort = null;
  }

  /** Keyboard stepping on the focused channel slider (APG Slider model). */
  onKeydown(event: KeyboardEvent): void {
    const slider = event.currentTarget as HTMLElement;
    const channel = this.#channelOf(slider);
    if (!channel) return;

    const [min, max] = this.#rangeOf(slider, channel);
    const value = this.#color[channel];
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = value + 1;
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = value - 1;
        break;
      case "PageUp":
        next = value + 10;
        break;
      case "PageDown":
        next = value - 10;
        break;
      case "Home":
        next = min;
        break;
      case "End":
        next = max;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.#setChannel(channel, next, min, max);
  }

  /** Begins a pointer drag on a channel slider and tracks movement. */
  onPointerDown(event: PointerEvent): void {
    const slider = event.currentTarget as HTMLElement;
    const channel = this.#channelOf(slider);
    if (!channel) return;
    event.preventDefault();
    slider.focus();

    const [min, max] = this.#rangeOf(slider, channel);
    const update = (clientX: number): void => {
      const rect = slider.getBoundingClientRect();
      if (rect.width === 0) return;
      const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      this.#setChannel(channel, min + fraction * (max - min), min, max);
    };
    update(event.clientX);

    this.#dragAbort?.abort();
    const abort = new AbortController();
    this.#dragAbort = abort;
    const onMove = (move: PointerEvent): void => update(move.clientX);
    const onUp = (): void => {
      abort.abort();
      this.#dragAbort = null;
    };
    document.addEventListener("pointermove", onMove, { signal: abort.signal });
    document.addEventListener("pointerup", onUp, { signal: abort.signal });
    document.addEventListener("pointercancel", onUp, { signal: abort.signal });
  }

  /** Parses the hex input on confirm and syncs every channel + surface. */
  onHexInput(): void {
    if (!this.hasHexTarget) return;
    const parsed = hexToHsla(this.hexTarget.value);
    if (!parsed) {
      // Reject invalid input by restoring the last valid hex.
      this.hexTarget.value = this.#hexString();
      return;
    }
    this.#color = this.alphaValue ? parsed : { ...parsed, alpha: 100 };
    this.#render();
  }

  /** Clamps and snaps one channel to an integer, then re-renders + emits change. */
  #setChannel(channel: Channel, raw: number, min: number, max: number): void {
    this.#color[channel] = Math.round(Math.min(max, Math.max(min, raw)));
    this.#render();
  }

  /** Reflects the model onto sliders, the hex input, preview, and form field. */
  #render(): void {
    for (const slider of this.sliderTargets) {
      const channel = this.#channelOf(slider);
      if (!channel) continue;
      const value = this.#color[channel];
      slider.setAttribute("aria-valuenow", String(value));
      slider.setAttribute("aria-valuetext", valueText(channel, value));
    }

    const hex = this.#hexString();
    if (this.hasHexTarget) this.hexTarget.value = hex;
    for (const field of this.fieldTargets) field.value = hex;
    for (const preview of this.previewTargets) preview.style.setProperty(COLOR_PROPERTY, hex);
    this.element.style.setProperty(COLOR_PROPERTY, hex);

    const rgb = hslToRgb(this.#color.hue, this.#color.saturation, this.#color.lightness);
    this.dispatch("change", {
      detail: { value: hex, rgba: { ...rgb, a: this.#color.alpha / 100 } },
    });
  }

  /** The current color as `#RRGGBB`, or `#RRGGBBAA` when alpha is enabled. */
  #hexString(): string {
    const rgb = hslToRgb(this.#color.hue, this.#color.saturation, this.#color.lightness);
    const base = `#${hex2(rgb.r)}${hex2(rgb.g)}${hex2(rgb.b)}`;
    if (!this.alphaValue) return base;
    return `${base}${hex2(Math.round((this.#color.alpha / 100) * 255))}`;
  }

  /** Reads a slider's `data-channel`, if it is a known channel. */
  #channelOf(slider: HTMLElement): Channel | null {
    const channel = slider.getAttribute("data-channel");
    return channel && channel in CHANNEL_RANGE ? (channel as Channel) : null;
  }

  /** A slider's `[min, max]` from aria-valuemin/max, falling back per channel. */
  #rangeOf(slider: HTMLElement, channel: Channel): [number, number] {
    const [defMin, defMax] = CHANNEL_RANGE[channel];
    const min = Number(slider.getAttribute("aria-valuemin"));
    const max = Number(slider.getAttribute("aria-valuemax"));
    return [Number.isFinite(min) ? min : defMin, Number.isFinite(max) ? max : defMax];
  }
}

/** Capitalizes a channel name for `aria-valuetext` (e.g. "Hue"). */
function valueText(channel: Channel, value: number): string {
  const label = channel.charAt(0).toUpperCase() + channel.slice(1);
  const unit = channel === "hue" ? "degrees" : "percent";
  return `${label} ${value} ${unit}`;
}

/** Formats a 0–255 byte as a 2-digit lowercase hex pair. */
function hex2(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, "0");
}

/** Converts HSL (h:0–360, s/l:0–100) to RGB bytes (0–255). */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = light - c / 2;
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

/** Converts RGB bytes (0–255) to HSL (h:0–360, s/l:0–100). */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;

  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h = (h * 60 + 360) % 360;
  }
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/**
 * Parses `#RGB`, `#RGBA`, `#RRGGBB`, or `#RRGGBBAA` into the HSLA model, or
 * returns null when the string is not a valid hex color.
 */
function hexToHsla(input: string): Hsla | null {
  const hex = input.trim().replace(/^#/, "");
  if (!/^(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) return null;

  // Expand shorthand (#RGB / #RGBA) so every channel is a full byte pair.
  const full =
    hex.length <= 4
      ? hex
          .split("")
          .map((char) => char + char)
          .join("")
      : hex;

  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  const a = full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) : 255;

  const { h, s, l } = rgbToHsl(r, g, b);
  return { hue: h, saturation: s, lightness: l, alpha: Math.round((a / 255) * 100) };
}
