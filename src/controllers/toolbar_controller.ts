import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord } from "../utils/arrow_step";
import { CompositionTracker } from "../utils/composition_tracker";
import { inheritsFieldsetDisabled } from "../utils/focus_candidate";
import { isRtl } from "../utils/logical_scroll";
import { RovingTabindex, type RovingWrap, rovingMove } from "../utils/roving_tabindex";

/**
 * Attributes that flip a control between navigable and not. Watched on the whole
 * subtree because a *sibling* controller (an editor toggling `disabled` on its
 * command buttons, a form enabling a fieldset) is what usually changes them.
 * Watched together with `childList`, which covers controls added or removed at
 * runtime without depending on Stimulus's asynchronous target callbacks.
 * `tabindex` is deliberately absent: the controller writes it itself, so
 * observing it would feed back into the observer.
 */
const STATE_ATTRIBUTES = ["disabled", "hidden"];

/**
 * Headless, accessible toolbar behavior.
 *
 * Markup contract (identifier: `stimeo--toolbar`):
 *   <div data-controller="stimeo--toolbar" role="toolbar" aria-label="Text formatting"
 *        data-stimeo--toolbar-orientation-value="horizontal">
 *     <button type="button" data-stimeo--toolbar-target="control">Bold</button>
 *     <!-- more controls -->
 *   </div>
 *
 * Implements the WAI-ARIA APG **Toolbar** pattern: the group is a single Tab
 * stop (roving tabindex) and the arrow keys move focus between controls. Each
 * control's own function (press, toggle, open a menu) stays with that element or
 * its own controller — the toolbar only owns navigation.
 *
 * @remarks
 * Behavior only. The roving mechanics are delegated to {@link RovingTabindex};
 * orientation and wrap policy stay here per the APG (they differ per widget).
 * ARIA (`role="toolbar"`, the accessible name, and `aria-orientation="vertical"`
 * when the axis is vertical) is the author's, exactly as with `role`.
 *
 * Behavior provided:
 * - Exactly one *navigable* control is tabbable (`tabindex="0"`); the rest are
 *   `-1`. The invariant is re-established on connect, on control add/remove,
 *   whenever `disabled` / `hidden` changes under the toolbar, and whenever an
 *   enclosing `<fieldset>` is disabled or re-enabled — disabling the control that
 *   held the Tab stop must never make the whole group unreachable by Tab, and
 *   unlocking the surrounding form must bring it back.
 * - `ArrowRight`/`ArrowLeft` (horizontal) or `ArrowDown`/`ArrowUp` (vertical)
 *   move focus to the next/previous navigable control; `Home`/`End` to the
 *   first/last. `aria-disabled="true"` controls remain in that roving order and
 *   can be both origins and destinations; only their activation is suppressed
 *   by the control itself or its owning behavior. Native `disabled` and `hidden`
 *   controls are excluded.
 * - With `wrap=true` movement cycles past the ends; with `wrap=false` it stops.
 * - `orientation` accepts `horizontal` (default) and `vertical`; any other value
 *   degrades to `horizontal`. There is no `both` — for two-axis navigation use
 *   `stimeo--roving`, whose same-named Value does accept it.
 * - Returning focus from outside lands on the most recently *active* control —
 *   the last one moved to by key, click, or programmatic `focus()`, because that
 *   is the one left tabbable (`focusin` keeps the Tab stop in sync).
 *
 * Keydown is **delegated on the container**, so controls added at runtime need
 * no per-element `data-action` (Stimulus binds those asynchronously, which is
 * unreliable for appended nodes). A `data-action="keydown->stimeo--toolbar#onKeydown"`
 * on each control stays supported; it does not double-move, because the second
 * pass sees `defaultPrevented`.
 *
 * Initial Tab stop: to choose it, write `tabindex` on **every** control (exactly
 * one `0`, the rest `-1`). Natively focusable elements are `tabindex="0"`
 * effectively when the attribute is absent, so annotating only the intended
 * entry point makes the *first* control win instead.
 *
 * Known constraint: a toolbar that contains a text input competes with it for
 * the arrow keys — the APG expects the toolbar to own them. Keep free-text
 * fields outside the toolbar (IME composition is yielded to, but caret movement
 * is not).
 */
export class ToolbarController extends Controller<HTMLElement> {
  static override targets = ["control"];
  static override values = {
    orientation: { type: String, default: "horizontal" },
    wrap: { type: Boolean, default: true },
  };
  static actions = ["onKeydown"] as const;

  declare readonly controlTargets: HTMLElement[];
  declare orientationValue: string;
  declare wrapValue: boolean;

  readonly #roving = new RovingTabindex(() => this.controlTargets);
  readonly #composition = new CompositionTracker();
  #observer: MutationObserver | null = null;
  /**
   * Live between `connect()` and `disconnect()`. Stimulus reports the *initial*
   * targets before `connect()` and re-reports them as disconnected after
   * `disconnect()`; gating on this keeps the target callbacks from clobbering
   * the authored Tab stop on mount and from resurrecting one after teardown.
   */
  #connected = false;

  override connect(): void {
    this.#ensureTabStop();
    this.element.addEventListener("keydown", this.#onKeydown);
    this.element.addEventListener("focusin", this.#onFocusin);
    this.#composition.observe(this.element);
    if (typeof MutationObserver !== "undefined") {
      const observer = new MutationObserver(() => this.#ensureTabStop());
      observer.observe(this.element, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: STATE_ATTRIBUTES,
      });
      // A `<fieldset disabled>` above the root disables the toolbar's form
      // controls from outside the observed subtree, so each enclosing fieldset's
      // own `disabled` is watched too. The walk starts at the parent: re-observing
      // the root would replace its options and lose the subtree registration.
      for (
        let fieldset = this.element.parentElement?.closest("fieldset") ?? null;
        fieldset;
        fieldset = fieldset.parentElement?.closest("fieldset") ?? null
      ) {
        observer.observe(fieldset, { attributes: true, attributeFilter: ["disabled"] });
      }
      this.#observer = observer;
    }
    this.#connected = true;
  }

  override disconnect(): void {
    this.#connected = false;
    this.element.removeEventListener("keydown", this.#onKeydown);
    this.element.removeEventListener("focusin", this.#onFocusin);
    this.#composition.disconnect();
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /**
   * A control added at runtime is dropped out of the Tab sequence first — a
   * fresh `<button>` is tabbable by default, which would make the group two Tab
   * stops — and then the lone stop is re-established.
   */
  controlTargetConnected(control: HTMLElement): void {
    if (!this.#connected) return;
    control.tabIndex = -1;
    this.#ensureTabStop();
  }

  /** Removing the control that held the Tab stop must not orphan the group. */
  controlTargetDisconnected(): void {
    if (!this.#connected) return;
    this.#ensureTabStop();
  }

  /**
   * Arrow/Home/End move focus and the single tab stop.
   *
   * Binding this per control with `data-action` is **optional** — the same
   * handling runs from the container's delegated listener. It stays a declared
   * action so per-control wiring keeps working; wiring both does not
   * double-move, because the delegated pass then yields on `defaultPrevented`.
   */
  onKeydown(event: KeyboardEvent): void {
    this.#handleKeydown(event);
  }

  /** Delegated counterpart of {@link onKeydown}; bound on the container. */
  readonly #onKeydown = (event: KeyboardEvent): void => {
    this.#handleKeydown(event);
  };

  /**
   * Syncs the Tab stop to a control focused by other means (click, programmatic
   * `focus()`) so Tab re-entry returns there. A non-navigable control is ignored:
   * the lone Tab stop must never sit on something the user cannot operate.
   */
  readonly #onFocusin = (event: FocusEvent): void => {
    const index = this.#indexOf(event.target);
    const control = index === -1 ? undefined : this.controlTargets[index];
    if (!control || !this.#isNavigable(control)) return;
    this.#roving.setActive(index);
  };

  #handleKeydown(event: KeyboardEvent): void {
    // A descendant widget that already claimed the key (a grabbed drag handle, a
    // nested menu) must not ALSO move the roving focus. This is what makes the
    // per-control `data-action` and the delegated listener idempotent.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    // Arrow/Home/End belong to the IME while a composition is in flight.
    if (this.#composition.isComposing(event)) return;
    // Re-assert the invariant before acting: the attribute observer runs async
    // (and may be absent), so a Tab stop invalidated moments ago can still be in
    // place here.
    this.#ensureTabStop();

    const from = this.#indexOf(event.target);
    if (from === -1) return;

    const vertical = this.orientationValue === "vertical";
    // Logical, not physical. APG defines these as "next / previous control", and
    // says a vertical arrangement swaps in Down/Up for the same meaning — so the
    // pair is one axis's spelling of an order, and the order reverses with the
    // writing direction. Read from the controller element: the container is what
    // lays the items out, and a child may carry its own `dir` (an LTR input
    // inside an RTL form is ordinary authoring).
    const rtl = !vertical && isRtl(this.element);
    const forwardKey = vertical ? "ArrowDown" : rtl ? "ArrowLeft" : "ArrowRight";
    const backwardKey = vertical ? "ArrowUp" : rtl ? "ArrowRight" : "ArrowLeft";

    let target: HTMLElement | undefined;
    if (event.key === forwardKey) {
      target = this.#nextNavigable(from, 1);
    } else if (event.key === backwardKey) {
      target = this.#nextNavigable(from, -1);
    } else if (event.key === "Home") {
      target = this.#navigableControls[0];
    } else if (event.key === "End") {
      const navigable = this.#navigableControls;
      target = navigable[navigable.length - 1];
    } else {
      return;
    }

    event.preventDefault();
    if (target) this.#roving.setActive(this.controlTargets.indexOf(target), { focus: true });
  }

  /**
   * Re-establishes the single Tab stop: keep the current one while it is still
   * navigable, else hand it to the first navigable control. `-1` (no Tab stop at
   * all) is reached only when every control is unavailable, and is recovered
   * from as soon as one becomes navigable again. Idempotent by construction, so
   * connect, the target callbacks, the observer, and keydown can all call it.
   */
  #ensureTabStop(): void {
    const active = this.#roving.activeIndex;
    const activeEl = active === -1 ? null : this.controlTargets[active];
    if (activeEl && this.#isNavigable(activeEl)) {
      this.#roving.setActive(active);
      return;
    }
    const first = this.#navigableControls[0];
    this.#roving.setActive(first ? this.controlTargets.indexOf(first) : -1);
  }

  /**
   * First navigable control strictly in the `delta` direction from `fromIndex`,
   * scanning the **full** control list rather than the navigable subset so a
   * non-navigable origin is never a dead end. When the direction yields nothing
   * the origin keeps focus; when the origin itself is not navigable the first
   * navigable control is used instead, so an arrow key always escapes.
   */
  #nextNavigable(fromIndex: number, delta: number): HTMLElement | undefined {
    const controls = this.controlTargets;
    const length = controls.length;
    const wrap: RovingWrap = this.wrapValue ? "wrap" : "clamp";
    let index = fromIndex;
    for (let step = 0; step < length; step++) {
      const next = rovingMove(index, length, delta, wrap);
      if (next === index) break; // clamped at an end (or a single control)
      index = next;
      const candidate = controls[index];
      if (candidate && this.#isNavigable(candidate)) return candidate;
    }
    const origin = controls[fromIndex];
    return origin && this.#isNavigable(origin) ? origin : this.#navigableControls[0];
  }

  /** Index in `controlTargets` of the control owning `target` (it or a descendant). */
  #indexOf(target: EventTarget | null): number {
    const node = target as Node | null;
    if (!node) return -1;
    return this.controlTargets.findIndex((control) => control === node || control.contains(node));
  }

  /** Controls eligible for the roving tab stop (excludes native disabled / hidden). */
  get #navigableControls(): HTMLElement[] {
    return this.controlTargets.filter((control) => this.#isNavigable(control));
  }

  /**
   * A control can hold the tab stop unless it is `hidden` or a disabled form
   * control. `aria-disabled` remains navigable per the APG; activation suppression
   * belongs to the control itself or its owning behavior. Native disabledness is
   * read from the `disabled` property, narrowed by an `in` check rather than
   * asserted since `<a>` and `<div role="button">` are legitimate controls that
   * are unaffected by a disabled fieldset. CSS-only visibility cannot be detected
   * headlessly and stays the consumer's responsibility.
   */
  #isNavigable(control: HTMLElement): boolean {
    if (this.#isHidden(control)) return false;
    if (!("disabled" in control)) return true;
    if (control.disabled === true) return false;
    return !inheritsFieldsetDisabled(control);
  }

  /**
   * Whether `control`, or anything between it and the toolbar root, is `hidden`.
   *
   * Reading only the control's own attribute lets an invisible control hold the
   * single Tab stop, which takes the *whole* toolbar out of the Tab sequence — an
   * ordinary `hidden` wrapper is enough. The walk stops at the root: a toolbar
   * inside a `hidden` region is already out of the page's Tab order.
   */
  #isHidden(control: HTMLElement): boolean {
    let node: HTMLElement | null = control;
    while (node && node !== this.element) {
      if (node.hasAttribute("hidden")) return true;
      node = node.parentElement;
    }
    return false;
  }
}
