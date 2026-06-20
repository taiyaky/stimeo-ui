import { Controller } from "@hotwired/stimulus";
import { attachPositioning, type Placement, type PositioningOptions, type PositionResult } from ".";

/**
 * Headless **anchored positioning**: keeps a `floating` element placed against an
 * `anchor`, flipping/shifting it away from viewport edges as the page scrolls or
 * resizes. It is the declarative surface of the opt-in {@link attachPositioning}
 * engine (`@floating-ui/dom`-based) — Radix's anchored popper / floating-ui's
 * `autoUpdate`, exposed as a controller. No dedicated APG pattern; it is the
 * placement primitive the popup patterns (Tooltip / Menu / Popover …) build on.
 *
 * Markup contract (identifier: `stimeo--anchored`):
 *   <div data-controller="stimeo--anchored"
 *        data-stimeo--anchored-placement-value="bottom-start"
 *        data-stimeo--anchored-offset-value="8">
 *     <button data-stimeo--anchored-target="anchor">Open</button>
 *     <div data-stimeo--anchored-target="floating" role="…">…</div>
 *   </div>
 *
 * `active` drives tracking (start/stop) and fires on connect, mirroring Focus
 * Scope's `trapValueChanged`; set it `false` while the floating element is hidden
 * so no measurement runs. The other Values map to {@link PositioningOptions} and
 * re-apply live while tracking. Only `position`/`left`/`top` inline styles are
 * written — never decoration — and the resolved (post-flip) side is mirrored onto
 * `data-anchored-placement` on the floating element for CSS hooks (e.g. an arrow).
 *
 * @remarks
 * Behavior only. It does **not** open/close, manage focus, or render an overlay
 * (pair with Dialog / Popover and {@link "../controllers/focus_controller"}), and
 * it does **not** move DOM (pair with Portal). It lives in the opt-in
 * `stimeo-ui/positioning` subpath so the core `import "stimeo-ui"` stays
 * zero-dependency; only consumers who register it pull in `@floating-ui/dom`. The
 * `autoUpdate` cleanup is released on `disconnect()` (Turbo navigation included)
 * so no observer outlives the element, and `#sync` reconciles to a single live
 * observer (keyed on the applied options) so reconnects never stack observers.
 */
export class AnchoredController extends Controller<HTMLElement> {
  static override targets = ["anchor", "floating"];
  static override values = {
    placement: { type: String, default: "bottom" },
    offset: { type: Number, default: 0 },
    flip: { type: Boolean, default: true },
    shift: { type: Boolean, default: true },
    padding: { type: Number, default: 0 },
    strategy: { type: String, default: "absolute" },
    active: { type: Boolean, default: true },
  };
  static events = ["position"] as const;

  declare readonly anchorTarget: HTMLElement;
  declare readonly floatingTarget: HTMLElement;
  declare readonly hasAnchorTarget: boolean;
  declare readonly hasFloatingTarget: boolean;

  declare placementValue: string;
  declare offsetValue: number;
  declare flipValue: boolean;
  declare shiftValue: boolean;
  declare paddingValue: number;
  declare strategyValue: string;
  declare activeValue: boolean;

  /** `autoUpdate` cleanup while tracking; `null` when detached. */
  #stop: (() => void) | null = null;
  /** True between connect and disconnect (Stimulus may fire value callbacks before connect). */
  #connected = false;
  /** Serialized options of the live observer, or `null` when detached — see {@link #sync}. */
  #appliedKey: string | null = null;

  override connect(): void {
    this.#connected = true;
    this.#sync();
  }

  override disconnect(): void {
    this.#connected = false;
    this.#sync();
  }

  // Every value change (active or an option) re-syncs. `#sync` is idempotent and
  // order-independent, so no Value has to be declared in a particular position.
  activeValueChanged(): void {
    this.#sync();
  }
  placementValueChanged(): void {
    this.#sync();
  }
  offsetValueChanged(): void {
    this.#sync();
  }
  flipValueChanged(): void {
    this.#sync();
  }
  shiftValueChanged(): void {
    this.#sync();
  }
  paddingValueChanged(): void {
    this.#sync();
  }
  strategyValueChanged(): void {
    this.#sync();
  }

  /** Current Values mapped to the positioning engine's options. */
  get #options(): PositioningOptions {
    return {
      placement: this.placementValue as Placement,
      offset: this.offsetValue,
      flip: this.flipValue,
      shift: this.shiftValue,
      padding: this.paddingValue,
      // Narrow the free-form Value to the engine's union; anything but "fixed"
      // falls back to the default "absolute".
      strategy: this.strategyValue === "fixed" ? "fixed" : "absolute",
    };
  }

  /**
   * Reconciles the live observer with the desired state — track iff connected,
   * `active`, and both targets exist — re-attaching only when that state or the
   * options actually changed. Stimulus fires the value-changed callbacks on
   * connect in declaration order and may run them before or after `connect()`;
   * keying on the applied options collapses that whole burst (in any order) to a
   * single attach, while an option change at runtime re-attaches exactly once. So
   * correctness never depends on `active` being declared last.
   */
  #sync(): void {
    const shouldTrack =
      this.#connected && this.activeValue && this.hasAnchorTarget && this.hasFloatingTarget;
    const key = shouldTrack ? JSON.stringify(this.#options) : null;
    if (key === this.#appliedKey) return;
    this.#detach();
    this.#appliedKey = key;
    if (shouldTrack) this.#attach();
  }

  #attach(): void {
    this.#stop = attachPositioning(
      this.anchorTarget,
      this.floatingTarget,
      this.#options,
      (result) => this.#onComputed(result),
    );
  }

  #detach(): void {
    this.#stop?.();
    this.#stop = null;
  }

  /** Reflects the resolved side onto the CSS hook and announces the placement. */
  #onComputed(result: PositionResult): void {
    this.floatingTarget.setAttribute("data-anchored-placement", result.placement);
    this.dispatch("position", {
      detail: { placement: result.placement, x: result.x, y: result.y },
    });
  }
}
