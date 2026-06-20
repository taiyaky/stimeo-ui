import {
  autoUpdate,
  type ComputePositionConfig,
  computePosition,
  flip,
  type Middleware,
  offset,
  type Placement,
  shift,
} from "@floating-ui/dom";
import type { Application } from "@hotwired/stimulus";
import { AnchoredController } from "./anchored_controller";

export type { Placement };
export { AnchoredController };

/**
 * Opt-in shared positioning helper for Stimeo's floating components
 * (popover / tooltip / hover-card / context-menu).
 *
 * **Why this is a separate entry point.** The core library is zero-runtime-dep:
 * `import "stimeo-ui"` pulls in nothing but `@hotwired/stimulus`. Dynamic
 * placement — measuring the viewport / scroll parents to flip and shift a
 * floating element away from screen edges — genuinely needs a small, trustworthy
 * dependency (`@floating-ui/dom`). To keep that cost *opt-in*, this lives at
 * `stimeo-ui/positioning` and is loaded only when a consumer explicitly imports
 * it. The controllers themselves never import this module, so the core install
 * stays dependency-free.
 *
 * **What it does and does not own.** This helper writes **coordinates only** —
 * `position`, `left`, `top` inline
 * styles on the floating element. It never emits color, border, shadow, size, or
 * any other decoration: the consumer's CSS still owns the entire look. Static
 * placement (a fixed `top`/`left` in CSS) needs no JS at all; reach for this only
 * when you want edge-collision avoidance.
 */

/** Options accepted by {@link position} and {@link attachPositioning}. */
export interface PositioningOptions {
  /**
   * Preferred side of the anchor to place the floating element on. Mirrors
   * floating-ui's `Placement` (e.g. `"bottom"`, `"top-start"`). Default `"bottom"`.
   */
  placement?: Placement;
  /** Gap in pixels between the anchor and the floating element. Default `0`. */
  offset?: number;
  /**
   * Flip to the opposite side when the preferred side would overflow the
   * viewport. Default `true`.
   */
  flip?: boolean;
  /**
   * Shift the floating element along its axis to keep it in view. Default `true`.
   */
  shift?: boolean;
  /**
   * Padding (px) kept between the floating element and the viewport edge when
   * flipping/shifting. Default `0`.
   */
  padding?: number;
  /**
   * CSS positioning strategy written to the floating element. `"absolute"`
   * (default) positions against the nearest positioned ancestor; `"fixed"`
   * positions against the viewport (useful inside `overflow` containers).
   */
  strategy?: "absolute" | "fixed";
}

/**
 * The resolved outcome of one positioning pass: the coordinates written to the
 * floating element and the **final** placement after flip/shift. Returned by
 * {@link position} and surfaced per update through {@link attachPositioning}'s
 * `onComputed` callback so callers can react to the resolved side (e.g. flip an
 * arrow, mirror the placement onto a `data-*` hook) without re-measuring.
 */
export interface PositionResult {
  /** Final placement after flip/shift resolved it (e.g. `"top-start"`). */
  placement: Placement;
  /** X coordinate written as the floating element's inline `left`. */
  x: number;
  /** Y coordinate written as the floating element's inline `top`. */
  y: number;
}

/** Builds the floating-ui middleware stack from {@link PositioningOptions}. */
function buildMiddleware(options: PositioningOptions): Middleware[] {
  const padding = options.padding ?? 0;
  const middleware: Middleware[] = [];
  if (options.offset) middleware.push(offset(options.offset));
  // flip before shift so a side change is considered before nudging along-axis.
  if (options.flip !== false) middleware.push(flip({ padding }));
  if (options.shift !== false) middleware.push(shift({ padding }));
  return middleware;
}

/**
 * Computes a single placement for `floating` relative to `anchor` and writes the
 * resulting coordinates as inline styles on `floating`.
 *
 * This is the one-shot form: it positions once and returns. For a floating
 * element that must track scrolling/resizing while open, use
 * {@link attachPositioning} instead.
 *
 * Only `position`, `left`, and `top` are written — never any decoration. The
 * resolved {@link PositionResult} (final placement + coordinates) is returned so
 * callers can react to the side flip/shift chose.
 */
export async function position(
  anchor: Element,
  floating: HTMLElement,
  options: PositioningOptions = {},
): Promise<PositionResult> {
  const strategy = options.strategy ?? "absolute";
  const config: Partial<ComputePositionConfig> = {
    placement: options.placement ?? "bottom",
    middleware: buildMiddleware(options),
    strategy,
  };
  const { x, y, placement } = await computePosition(anchor, floating, config);
  Object.assign(floating.style, {
    position: strategy,
    left: `${x}px`,
    top: `${y}px`,
  });
  return { x, y, placement };
}

/**
 * Positions `floating` against `anchor` and keeps it positioned across scroll,
 * resize, and layout changes via floating-ui's `autoUpdate`.
 *
 * Returns a cleanup function that stops tracking; call it when the floating
 * element closes or the controller disconnects (Turbo navigation included) so no
 * observer outlives the element.
 *
 * Pass `onComputed` to receive the resolved {@link PositionResult} on every
 * update (initial placement and each scroll/resize re-computation) — used to
 * mirror the final placement onto a hook or emit an event without re-measuring.
 *
 * @example
 * ```ts
 * import { attachPositioning } from "stimeo-ui/positioning";
 *
 * // when a popover opens:
 * const stop = attachPositioning(trigger, panel, { placement: "bottom-start", offset: 8 });
 * // when it closes:
 * stop();
 * ```
 */
export function attachPositioning(
  anchor: Element,
  floating: HTMLElement,
  options: PositioningOptions = {},
  onComputed?: (result: PositionResult) => void,
): () => void {
  return autoUpdate(anchor, floating, () => {
    void position(anchor, floating, options).then((result) => onComputed?.(result));
  });
}

/**
 * Maps the opt-in positioning controller identifiers to their classes. Kept
 * separate from the core `stimeoControllers` (`src/index.ts`) so the core
 * install never imports `@floating-ui/dom`; the Inspector manifest reflects both
 * core and positioning controllers so `stimeo check` recognizes them.
 */
export const positioningControllers = {
  "stimeo--anchored": AnchoredController,
} as const;

/**
 * Registers the opt-in positioning controllers (e.g. `stimeo--anchored`) on a
 * Stimulus application. Call this **in addition to** `registerStimeo` only when
 * you want the declarative positioning primitives — importing this module is
 * what pulls in `@floating-ui/dom`, so the core stays zero-dependency for
 * consumers who never call it.
 *
 * @param application - The Stimulus application to register controllers on.
 *
 * @example
 * ```ts
 * import { Application } from "@hotwired/stimulus";
 * import { registerStimeo } from "stimeo-ui";
 * import { registerPositioning } from "stimeo-ui/positioning";
 *
 * const application = Application.start();
 * registerStimeo(application);
 * registerPositioning(application); // opt-in: adds stimeo--anchored
 * ```
 */
export function registerPositioning(application: Application): void {
  for (const [identifier, controller] of Object.entries(positioningControllers)) {
    application.register(identifier, controller);
  }
}
