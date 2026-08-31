import { Controller } from "@hotwired/stimulus";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { FocusTrap } from "../utils/focus_trap";

/**
 * Headless **focus scope**: exposes the shared {@link FocusTrap} as a standalone,
 * declarative focus boundary — `Tab` cycling, initial focus, and restore-on-release —
 * for any region, without building a full modal. No dedicated APG pattern; it is the
 * primitive the overlay patterns use, surfaced for direct use.
 *
 * Markup contract (identifier: `stimeo--focus`):
 *   <div data-controller="stimeo--focus" data-stimeo--focus-trap-value="true">
 *     <input data-stimeo--focus-target="initial" />
 *     …
 *   </div>
 *
 * While `trap` is on, `Tab` / `Shift+Tab` cycle within the element, focus moves to the
 * `initial` target (or the first focusable) when `auto`, `Escape` releases it, and on
 * release focus returns to the opener when `restore`. With `inert` the rest of the page
 * is made `inert` (a hard, modal-style isolation); left off it is a soft boundary —
 * `Tab` still cycles but the background stays reachable. The element carries
 * `data-focus-trapped` while active and emits `activate` / `deactivate`.
 *
 * Only `trap` is watched for changes. `auto` and `inert` are read when the trap turns
 * on and `restore` when it turns off, so rewriting one mid-trap describes the *next*
 * activation rather than the one in progress.
 *
 * `activate` and `deactivate` dispatch `{}`.
 *
 * @remarks
 * Behavior only — it does not open/close or render an overlay (pair with Dialog) and
 * does not move DOM (pair with Portal). It reuses the shared {@link FocusTrap}, so it never
 * scroll-locks the page (unlike the modal overlays) and tracks live focusable children
 * (dynamic additions are picked up on the next `Tab`). The opener is recorded on
 * activate and refocused on release if still present. Everything is torn down on
 * `disconnect()` (Turbo navigation included) without yanking focus.
 */
export class FocusController extends Controller<HTMLElement> {
  static override targets = ["initial"];
  static override values = {
    trap: { type: Boolean, default: false },
    auto: { type: Boolean, default: true },
    restore: { type: Boolean, default: true },
    inert: { type: Boolean, default: false },
  };
  static actions = ["activate", "deactivate"] as const;
  static events = ["activate", "deactivate"] as const;

  declare readonly initialTarget: HTMLElement;
  declare readonly hasInitialTarget: boolean;

  declare trapValue: boolean;
  declare autoValue: boolean;
  declare restoreValue: boolean;
  declare inertValue: boolean;

  readonly #trap = new FocusTrap(() => this.element, {
    // A focus scope is not a modal: never lock scroll, and only isolate the background
    // when `inert` is requested. `auto` gates the initial focus move; Escape releases.
    lockScroll: false,
    isolate: () => this.inertValue,
    autoFocus: () => this.autoValue,
    initialFocus: () => (this.hasInitialTarget ? this.initialTarget : null),
    onEscape: () => this.deactivate(),
  });

  /**
   * Whether this scope is currently trapping.
   *
   * Held here rather than read back from the trap: the trap releases itself
   * before Turbo caches the page, so its own flag stops answering for the state
   * this controller publishes on the element and in its events.
   */
  #active = false;

  /**
   * Returns the element to its untrapped form before Turbo copies the page. The
   * trap performs its own release on the same event, so what is left is the hook
   * this controller owns — carried into the snapshot it would describe a scope
   * that is no longer trapping.
   *
   * Silent, like `disconnect()`: the page is about to be frozen, and a release
   * nobody asked for is not a close to report.
   */
  readonly #beforeCache = new BeforeCacheReset(() => {
    this.#active = false;
    this.element.removeAttribute("data-focus-trapped");
  });

  /** Stimulus drives activation from the `trap` value (also fires on connect). */
  trapValueChanged(): void {
    if (this.trapValue) this.#activate();
    else this.#deactivate();
  }

  override connect(): void {
    this.#beforeCache.activate();
  }

  override disconnect(): void {
    // Release without restoring focus — the element is leaving the DOM. This is a
    // teardown, not a user-driven close, so it intentionally does NOT emit
    // `deactivate` or reset `trapValue` (which would resurrect on a Turbo cache
    // restore); the event travels with a release asked for through the public
    // `deactivate()` action or the `trap` value.
    this.#trap.deactivate({ restoreFocus: false });
    this.#beforeCache.deactivate();
    this.#active = false;
    this.element.removeAttribute("data-focus-trapped");
  }

  /** Turns the trap on. Acts synchronously and keeps the `trap` value in sync. */
  activate(): void {
    this.trapValue = true;
    this.#activate();
  }

  /** Turns the trap off (also wired to Escape). */
  deactivate(): void {
    this.trapValue = false;
    this.#deactivate();
  }

  #activate(): void {
    if (this.#active) return;
    this.#active = true;
    this.#trap.activate();
    this.element.setAttribute("data-focus-trapped", "true");
    this.dispatch("activate", { detail: {} });
  }

  #deactivate(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#trap.deactivate({ restoreFocus: this.restoreValue });
    this.element.removeAttribute("data-focus-trapped");
    this.dispatch("deactivate", { detail: {} });
  }
}
