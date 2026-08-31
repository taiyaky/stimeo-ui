import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord, logicalArrowKey } from "../utils/arrow_step";
import { toFiniteNumber } from "../utils/coerce";
import { isRtl } from "../utils/logical_scroll";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { OwnedPointerSession } from "../utils/owned_pointer_session";

/** CSS custom property exposing the current color to consumer CSS. */
const COLOR_PROPERTY = "--stimeo--color";

/** A slider's `aria-valuetext` template, where `{value}` is the channel value. */
const VALUE_TEXT_ATTRIBUTE = "data-value-text";

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
 *          data-value-text="Hue {value} degrees"
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
 * preview and root as the `--stimeo--color` custom property and mirrored into a
 * hidden form field.
 *
 * `change` and `reconcile` dispatch
 * `{ value: string, rgba: { r: number, g: number, b: number, a: number } }`.
 *
 * @remarks
 * Behavior only — the swatch/gradient visuals are the consumer's CSS/canvas, fed
 * by `--stimeo--color`. Only the consumer knows whether a channel track mirrors
 * under RTL: set `logicalTrack` to declare that it does, and the pointer mapping
 * and horizontal arrow pair follow the writing direction. Left unset, nothing
 * here reads `direction`. A gradient has no logical `to` keyword, so mirroring
 * one means swapping `to right`/`to left` under a `:dir(rtl)` selector.
 *
 * A channel slider announces its bounds from its own `aria-valuemin`/`aria-valuemax`,
 * falling back per channel when they are absent or blank; the resolved pair is
 * written back, so assistive tech never hears the `slider` role's 0–100 default
 * over a hue that reaches 360. `aria-valuetext` is filled from the slider's
 * `data-value-text` template — `{value}` is the channel value — which
 * keeps the announced wording i18n-neutral; without a template the text is English.
 *
 * A drag belongs to the pointer that started it: only a primary button opens one,
 * and {@link OwnedPointerSession} filters movement and termination by that
 * `pointerId`, so a second finger neither steers nor cuts the gesture. Its
 * listeners are released on drag end, when the slider leaves, and on `disconnect()`
 * (Turbo navigation included).
 *
 * The `value` Value carries the color in both directions: every settled color is
 * written back, so a Turbo cache restore and a form submission both carry the color
 * the user picked. An outside write — application code or a morph — re-seeds the
 * model and reports `reconcile`. The ARIA attributes, `--stimeo--color`, and the
 * mirrored input values are this controller's own output and stay in the DOM as
 * written, which is what makes the restored snapshot show the current color.
 *
 * The internal model is integer HSL(A), so a hex → HSL → hex round-trip is not
 * exactly bijective: a typed hex can normalize to a near (not identical) value
 * once the HSL sliders are touched. This keeps the model small and zero-dep; use a
 * dedicated color library on the consumer side if exact hex preservation matters.
 *
 * While `alpha` is disabled the model stays opaque and an alpha slider authored
 * anyway edits nothing, so the hex and `change`'s `rgba.a` never disagree.
 *
 * A color the user set through a slider or the hex input is reported as
 * `stimeo--color-picker:change`. Changing `alpha` or `value` at runtime can move the
 * committed color without a user edit, and that arrives as
 * `stimeo--color-picker:reconcile` with the same detail. Neither fires on connect.
 */
export class ColorPickerController extends Controller<HTMLElement> {
  static override targets = ["slider", "hex", "preview", "field"];
  static override values = {
    value: { type: String, default: "#000000" },
    alpha: { type: Boolean, default: false },
    logicalTrack: { type: Boolean, default: false },
  };
  static actions = ["onHexInput", "onKeydown", "onPointerDown"] as const;
  static events = ["change", "reconcile"] as const;

  declare readonly sliderTargets: HTMLElement[];
  declare readonly hexTarget: HTMLInputElement;
  declare readonly hasHexTarget: boolean;
  declare readonly previewTargets: HTMLElement[];
  declare readonly fieldTargets: HTMLInputElement[];
  declare valueValue: string;
  declare alphaValue: boolean;
  declare logicalTrackValue: boolean;

  /** Whether the consumer declared a mirroring track and the direction mirrors it. */
  get #mirrored(): boolean {
    return this.logicalTrackValue && isRtl(this.element);
  }

  /** The current color in the editing model; its alpha is 100 while `alpha` is off. */
  #color: Hsla = { hue: 0, saturation: 0, lightness: 0, alpha: 100 };
  /** The pointer that owns the live drag, with the slider whose geometry maps it. */
  #drag: ColorDrag | null = null;
  /** Color the last repaint settled on, so a configuration-driven move is reported once. */
  #committedHex: string | null = null;

  /**
   * Collapses a morph that swaps render inputs into one repaint, and refuses the
   * pass Stimulus delivers before `connect()`.
   */
  readonly #repaint = new MicrotaskCoalescer(() => this.#reconcileColor());

  /** Seeds the model from the initial hex value and renders every surface. */
  override connect(): void {
    this.#repaint.activate();
    this.#adoptValue();
    this.#render();
  }

  /** Cancels any active pointer drag so document listeners never leak. */
  override disconnect(): void {
    this.#repaint.cancel();
    this.#endDrag();
  }

  /** Repaints when application code (or a Turbo morph) changes `alpha` at runtime. */
  alphaValueChanged(): void {
    this.#repaint.schedule();
  }

  /** Adopts a color application code (or a Turbo morph) put in `value` at runtime. */
  valueValueChanged(): void {
    // The write-back from a render lands here too, and it already matches the DOM.
    if (this.valueValue === this.#committedHex) return;
    this.#repaint.schedule();
  }

  /** Hydrates a channel slider inserted or replaced at runtime. */
  sliderTargetConnected(slider: HTMLElement): void {
    this.#renderSlider(slider);
  }

  /** Ends a gesture whose geometry target disappeared or ceased being a target. */
  sliderTargetDisconnected(slider: HTMLElement): void {
    if (this.#drag?.slider === slider) this.#endDrag();
  }

  /** Fills a hex input inserted or replaced at runtime with the current color. */
  hexTargetConnected(hex: HTMLInputElement): void {
    this.#mirrorColor(hex, this.#hexString());
  }

  /** Fills a form field inserted or replaced at runtime with the current color. */
  fieldTargetConnected(field: HTMLInputElement): void {
    this.#mirrorColor(field, this.#hexString());
  }

  /** Publishes the current color on a preview inserted or replaced at runtime. */
  previewTargetConnected(preview: HTMLElement): void {
    this.#publishColor(preview, this.#hexString());
  }

  /** Keyboard stepping on the focused channel slider (APG Slider model). */
  onKeydown(event: KeyboardEvent): void {
    if (isReservedArrowChord(event)) return;
    const slider = event.currentTarget as HTMLElement;
    const channel = this.#editableChannel(slider);
    if (!channel) return;

    const [min, max] = this.#rangeOf(slider, channel);
    const value = this.#color[channel];
    let next: number | null = null;
    // On a mirrored track the greater value sits at the visual left, so the
    // horizontal pair trades places; the vertical pair passes through.
    switch (this.#mirrored ? logicalArrowKey(event.key, this.element) : event.key) {
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

  /** Begins a primary-button drag on a channel slider, owned by its own pointer. */
  onPointerDown(event: PointerEvent): void {
    // A secondary button opens the context menu instead, and a live drag keeps its
    // slider: another press must not silently take the gesture over.
    if (event.button !== 0 || this.#drag) return;
    const slider = event.currentTarget as HTMLElement;
    const channel = this.#editableChannel(slider);
    if (!channel) return;

    const [min, max] = this.#rangeOf(slider, channel);
    // Resolve the direction once for the whole gesture: reading it per move
    // would query computed style on every frame, and a drag that flipped
    // mid-gesture would be incoherent anyway.
    const mirrored = this.#mirrored;
    const update = (clientX: number): boolean => {
      const rect = slider.getBoundingClientRect();
      if (rect.width === 0) return false;
      const offset = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const fraction = mirrored ? 1 - offset : offset;
      this.#setChannel(channel, min + fraction * (max - min), min, max);
      return true;
    };
    // A track with no width maps no coordinate, so the press is left to the page.
    if (!update(event.clientX)) return;
    event.preventDefault();
    slider.focus();

    const drag: ColorDrag = { pointer: null, slider };
    drag.pointer = new OwnedPointerSession(event, slider, {
      move: (move) => {
        // A slider detached mid-drag would map against a stale rectangle.
        if (slider.isConnected) update(move.clientX);
        else this.#endDrag();
      },
      end: () => {
        if (this.#drag === drag) this.#drag = null;
      },
    });
    this.#drag = drag;
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
    this.#color = this.#opaqueUnlessEnabled(parsed);
    this.#commitColor();
  }

  /** Replaces the model with the color `value` names, leaving an unparsable one alone. */
  #adoptValue(): void {
    const parsed = hexToHsla(this.valueValue);
    if (parsed) this.#color = this.#opaqueUnlessEnabled(parsed);
  }

  /**
   * The model a parsed color implies: alpha only survives while its channel is
   * enabled, because `hexString()` would otherwise emit `#RRGGBB` while `change`
   * reported `rgba.a < 1`.
   */
  #opaqueUnlessEnabled(parsed: Hsla): Hsla {
    return this.alphaValue ? parsed : { ...parsed, alpha: 100 };
  }

  /** Clamps and snaps one channel to an integer, then re-renders + emits change. */
  #setChannel(channel: Channel, raw: number, min: number, max: number): void {
    this.#color[channel] = Math.round(Math.min(max, Math.max(min, raw)));
    this.#commitColor();
  }

  /**
   * Renders the model and reports a color the user actually moved. A key pressed
   * at a bound, a pointer that lands on the step already showing, and a re-confirmed
   * hex all leave the committed color where it was, so no `change` describes them.
   */
  #commitColor(): void {
    const previous = this.#committedHex;
    this.#render();
    if (this.#committedHex !== previous) {
      this.dispatch("change", { detail: this.#settledDetail() });
    }
  }

  /**
   * Reflects the model onto sliders, the hex input, preview, form field, and the
   * `value` Value it serializes into.
   *
   * @stimeoRenderRoot
   */
  #render(): void {
    for (const slider of this.sliderTargets) this.#renderSlider(slider);

    const hex = this.#hexString();
    this.#committedHex = hex;
    // The Value carries the color, so a Turbo snapshot and a morph read the same
    // truth the surfaces show.
    if (this.valueValue !== hex) this.valueValue = hex;
    if (this.hasHexTarget) this.#mirrorColor(this.hexTarget, hex);
    for (const field of this.fieldTargets) this.#mirrorColor(field, hex);
    for (const preview of this.previewTargets) this.#publishColor(preview, hex);
    this.#publishColor(this.element, hex);
  }

  /** Writes one slider's announced range, value, and value text, skipping equal ones. */
  #renderSlider(slider: HTMLElement): void {
    const channel = this.#channelOf(slider);
    if (!channel) return;
    const [min, max] = this.#rangeOf(slider, channel);
    const value = this.#color[channel];
    const attributes = {
      "aria-valuemin": String(min),
      "aria-valuemax": String(max),
      "aria-valuenow": String(value),
      "aria-valuetext": this.#valueText(slider, channel, value),
    };
    for (const [name, next] of Object.entries(attributes)) {
      if (slider.getAttribute(name) !== next) slider.setAttribute(name, next);
    }
  }

  /** Mirrors the color into an input, leaving an already-equal value untouched. */
  #mirrorColor(input: HTMLInputElement, hex: string): void {
    if (input.value !== hex) input.value = hex;
  }

  /** Publishes the color as the consumer's CSS hook, skipping an equal value. */
  #publishColor(element: HTMLElement, hex: string): void {
    if (element.style.getPropertyValue(COLOR_PROPERTY) !== hex) {
      element.style.setProperty(COLOR_PROPERTY, hex);
    }
  }

  /**
   * Repaints after a declarative input changed at runtime and reports a color this
   * controller settled on. Disabling alpha drops it from the model and an outside
   * `value` names another color, so the committed color can move without a user
   * edit; `change` stays reserved for the picker's own actions.
   */
  #reconcileColor(): void {
    // Compared against the last rendered color, not against the model: the Value
    // callback that scheduled this pass has already moved the Values, so
    // re-deriving the "before" state here would always match the "after" one.
    const previous = this.#committedHex;
    // Only a `value` that differs from the rendered color comes from outside.
    // Re-seeding from the controller's own write-back would round-trip the model
    // through hex and drop the hue and saturation a gray cannot carry.
    if (previous !== null && this.valueValue !== previous) this.#adoptValue();
    if (!this.alphaValue) this.#color.alpha = 100;
    this.#render();
    if (previous !== null && this.#committedHex !== previous) {
      this.dispatch("reconcile", { detail: this.#settledDetail() });
    }
  }

  /** The settled color as event detail, shared by both report paths. */
  #settledDetail(): { value: string; rgba: { r: number; g: number; b: number; a: number } } {
    const rgb = hslToRgb(this.#color.hue, this.#color.saturation, this.#color.lightness);
    return { value: this.#hexString(), rgba: { ...rgb, a: this.#color.alpha / 100 } };
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
    // Own keys only: an inherited name such as `toString` would otherwise index the
    // model with a function and be announced as one.
    return channel && Object.hasOwn(CHANNEL_RANGE, channel) ? (channel as Channel) : null;
  }

  /**
   * The channel a slider edits, or null when this picker edits none through it. An
   * alpha slider authored while `alpha` is off edits nothing: moving it would leave
   * the model translucent behind an opaque `#RRGGBB`.
   */
  #editableChannel(slider: HTMLElement): Channel | null {
    const channel = this.#channelOf(slider);
    return channel === "alpha" && !this.alphaValue ? null : channel;
  }

  /** The channel's announced text: the slider's template, or the built-in English. */
  #valueText(slider: HTMLElement, channel: Channel, value: number): string {
    const template = slider.getAttribute(VALUE_TEXT_ATTRIBUTE);
    // A placeholder with no substitution stays as authored, so a typo is visible
    // instead of being read as a blank.
    return template
      ? template.replaceAll("{value}", String(value))
      : defaultValueText(channel, value);
  }

  /** Ends the live drag so no further movement of that pointer reaches the model. */
  #endDrag(): void {
    const drag = this.#drag;
    this.#drag = null;
    drag?.pointer?.end();
  }

  /**
   * A slider's `[min, max]` from aria-valuemin/max, falling back per channel.
   * An absent or blank attribute means "not authored", not zero — coercing it to
   * a number would pin the channel at `0` and make the per-channel default
   * unreachable.
   */
  #rangeOf(slider: HTMLElement, channel: Channel): [number, number] {
    const [defMin, defMax] = CHANNEL_RANGE[channel];
    return [
      toFiniteNumber(slider.getAttribute("aria-valuemin")) ?? defMin,
      toFiniteNumber(slider.getAttribute("aria-valuemax")) ?? defMax,
    ];
  }
}

/** Stable gesture state owned for the duration of one pointer drag. */
interface ColorDrag {
  pointer: OwnedPointerSession | null;
  readonly slider: HTMLElement;
}

/** Capitalizes a channel name for `aria-valuetext` (e.g. "Hue"). */
function defaultValueText(channel: Channel, value: number): string {
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
