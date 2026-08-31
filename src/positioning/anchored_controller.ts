import { Controller } from "@hotwired/stimulus";
import { attachPositioning, type Placement, type PositioningOptions, type PositionResult } from ".";

/**
 * Every placement the engine accepts. A declaration outside the set has no
 * resolved side to publish, so it falls back to the Value's default rather than
 * reaching the state hook and the event detail as-is.
 */
const PLACEMENTS: ReadonlySet<string> = new Set([
  "top",
  "top-start",
  "top-end",
  "right",
  "right-start",
  "right-end",
  "bottom",
  "bottom-start",
  "bottom-end",
  "left",
  "left-start",
  "left-end",
]);

/**
 * Headless **anchored positioning**: keeps a `floating` element placed against an
 * `anchor`, flipping/shifting it away from viewport edges as the page scrolls or
 * resizes. It is the declarative surface of the opt-in {@link attachPositioning}
 * engine (`@floating-ui/dom`-based), exposing its `autoUpdate` behavior as a
 * controller. No dedicated APG pattern; it is the
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
 * re-apply live while tracking. A declaration the engine cannot use — a
 * `placement` outside its set, a non-finite `offset` or `padding` — falls back to
 * that Value's default, so a typo never reaches the coordinates or the hook. Only
 * `position`/`left`/`top` inline styles are written — never decoration — and the
 * resolved (post-flip) side is mirrored onto `data-anchored-placement` on the
 * floating element for CSS hooks (e.g. an arrow).
 *
 * Tracking follows the targets themselves, not just the Values: the engine holds
 * the two elements it was handed, so a target added, removed or swapped at
 * runtime re-attaches against whatever is there now.
 *
 * `position` dispatches `{ placement, x, y }`.
 *
 * @remarks
 * Behavior only. It does **not** open/close, manage focus, or render an overlay
 * (pair with Dialog / Popover and {@link "../controllers/focus_controller"}), and
 * it does **not** move DOM (pair with Portal). It lives in the opt-in
 * `stimeo-ui/positioning` subpath so the core `import "stimeo-ui"` stays
 * zero-dependency; only consumers who register it pull in `@floating-ui/dom`. The
 * `autoUpdate` cleanup is released on `disconnect()` (Turbo navigation included)
 * so no observer outlives the element, and `#sync` reconciles to a single live
 * observer (keyed on the applied options and elements) so reconnects never stack
 * observers. That cleanup stops future updates but cannot cancel one already
 * computing, so a pass that lands after its own attach was replaced stands down
 * instead of writing.
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
  /** Identity of the live attach; `null` when detached — see {@link #onComputed}. */
  #attachId: symbol | null = null;
  /** True between connect and disconnect (Stimulus may fire value callbacks before connect). */
  #connected = false;
  /**
   * Serialized options as of the last reconcile, empty only before the first one —
   * a value no serialization produces, so it can never match a real key.
   */
  #appliedKey = "";
  /** Elements the live observer holds, or `null` when detached — see {@link #sync}. */
  #appliedAnchor: Element | null = null;
  #appliedFloating: HTMLElement | null = null;

  override connect(): void {
    this.#connected = true;
    this.#sync();
  }

  override disconnect(): void {
    this.#connected = false;
    this.#sync();
  }

  // Every value change (active or an option) and every target arrival or
  // departure re-syncs. `#sync` is idempotent and order-independent, so no Value
  // has to be declared in a particular position.
  anchorTargetConnected(): void {
    this.#sync();
  }
  anchorTargetDisconnected(): void {
    this.#sync();
  }
  floatingTargetConnected(): void {
    this.#sync();
  }
  floatingTargetDisconnected(): void {
    this.#sync();
  }
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
      // Narrow every free-form Value to what the engine can use. A placement
      // outside the set would be published on the hook as a resolved side it is
      // not, and a non-finite distance poisons the coordinate it feeds until the
      // browser drops the whole declaration and leaves that axis unplaced.
      placement: PLACEMENTS.has(this.placementValue)
        ? (this.placementValue as Placement)
        : "bottom",
      offset: Number.isFinite(this.offsetValue) ? this.offsetValue : 0,
      flip: this.flipValue,
      shift: this.shiftValue,
      padding: Number.isFinite(this.paddingValue) ? this.paddingValue : 0,
      strategy: this.strategyValue === "fixed" ? "fixed" : "absolute",
    };
  }

  /**
   * Reconciles the live observer with the desired state — track iff connected,
   * `active`, and both targets exist — re-attaching only when that state, the
   * options, or the elements actually changed. Stimulus fires the value-changed
   * callbacks on connect in declaration order and may run them before or after
   * `connect()`; keying on what is applied collapses that whole burst (in any
   * order) to a single attach, while an option or target change at runtime
   * re-attaches exactly once. So correctness never depends on `active` being
   * declared last. The elements are part of the key because the engine holds the
   * pair it was handed: a swap leaves the same options behind and would otherwise
   * keep measuring the node that just left the document.
   */
  #sync(): void {
    const shouldTrack =
      this.#connected && this.activeValue && this.hasAnchorTarget && this.hasFloatingTarget;
    const anchor = shouldTrack ? this.anchorTarget : null;
    const floating = shouldTrack ? this.floatingTarget : null;
    // The elements already say whether anything is tracked, so the key only has
    // to say which options are on it.
    const key = JSON.stringify(this.#options);
    if (
      key === this.#appliedKey &&
      anchor === this.#appliedAnchor &&
      floating === this.#appliedFloating
    ) {
      return;
    }
    this.#detach();
    this.#appliedKey = key;
    this.#appliedAnchor = anchor;
    this.#appliedFloating = floating;
    if (anchor && floating) this.#attach(anchor, floating);
  }

  #attach(anchor: Element, floating: HTMLElement): void {
    const id = Symbol("anchored-attach");
    this.#attachId = id;
    this.#stop = attachPositioning(anchor, floating, this.#options, (result) =>
      this.#onComputed(id, floating, result),
    );
  }

  #detach(): void {
    this.#stop?.();
    this.#stop = null;
    this.#attachId = null;
  }

  /**
   * Reflects the resolved side onto the CSS hook and announces the placement.
   *
   * The pass carries the attach that started it and the element it positioned,
   * and lands only while that attach is still the live one: `autoUpdate`'s
   * cleanup stops further updates but cannot cancel one already computing, so a
   * pass superseded mid-flight would otherwise write and dispatch afterwards.
   * The element cannot stand in for that identity — an option change re-attaches
   * against the very same pair.
   */
  #onComputed(id: symbol, floating: HTMLElement, result: PositionResult): void {
    if (id !== this.#attachId) return;
    floating.setAttribute("data-anchored-placement", result.placement);
    this.dispatch("position", {
      detail: { placement: result.placement, x: result.x, y: result.y },
    });
  }
}
