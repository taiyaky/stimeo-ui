/**
 * Modal focus-trap primitive shared by the modal-overlay controllers
 * (dialog / alert-dialog / drawer).
 *
 * The WAI-ARIA APG modal pattern is more than "cycle Tab inside a box": a modal
 * also locks background scroll, makes the rest of the page `inert` (so assistive
 * technology and pointer/Tab cannot reach it, honoring `aria-modal="true"`),
 * sends focus inside on open, and restores it to the opener on close — and every
 * one of those side effects must be reverted if the element is torn down while
 * open (a Turbo navigation mid-dialog). {@link FocusTrap} owns that whole modal
 * lifecycle so each controller only decides *when* to open/close and *what*
 * "close" means.
 *
 * It is intentionally **policy-free about closing**. Escape semantics differ per
 * widget (a plain dialog just closes; an alert-dialog closes *as a cancel* with a
 * reason; a drawer runs an exit transition), so the trap merely forwards Escape
 * to an {@link FocusTrapOptions.onEscape | onEscape} callback and never decides on
 * its own what closing entails.
 *
 * @remarks
 * The container is read through a getter so a controller can hand over a Stimulus
 * target without worrying about when the trap instance is constructed relative to
 * `connect()`.
 */

/**
 * Selector matching the elements considered focusable. Shared by the trap's Tab
 * cycling and by form-validation's invalid-focus delegation.
 */
export const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Behavior hooks a controller supplies when constructing a {@link FocusTrap}. */
export interface FocusTrapOptions {
  /**
   * Called when `Escape` is pressed while the trap is active. When omitted,
   * `Escape` is left alone (the trap never closes itself). The trap calls
   * `preventDefault()` before invoking it.
   */
  onEscape?: () => void;
  /**
   * Returns the element to focus when the trap activates. When it returns `null`
   * (or is omitted), the first focusable descendant is used, falling back to the
   * container itself (made programmatically focusable with `tabindex=-1`).
   */
  initialFocus?: () => HTMLElement | null;
  /**
   * Returns the element to focus on deactivation when nothing was focused before
   * the trap opened (e.g. the trigger). The element focused *before* opening
   * always takes precedence.
   */
  fallbackFocus?: () => HTMLElement | null;
  /**
   * Lock background scroll (`body` overflow) while active. Defaults to `true` for
   * the modal overlays; a lighter focus scope passes `false`. Read on `activate`.
   */
  lockScroll?: boolean | (() => boolean);
  /**
   * Make background siblings `inert` while active (the `aria-modal` isolation).
   * Defaults to `true` for the modal overlays; a soft focus scope can opt out so
   * the background stays reachable while `Tab` still cycles inside. Read on `activate`.
   */
  isolate?: boolean | (() => boolean);
  /**
   * Move focus inside on `activate`. Defaults to `true`; a focus scope that only
   * wants the `Tab` boundary (no focus move) passes `false`. Read on `activate`.
   */
  autoFocus?: boolean | (() => boolean);
}

/**
 * Owns the modal side effects (scroll lock, background `inert`, focus trap, focus
 * restore) for a single container, applied on {@link activate} and reverted on
 * {@link deactivate}.
 */
export class FocusTrap {
  /** The element focused before activation, restored on deactivation. */
  #previouslyFocused: HTMLElement | null = null;
  /** The body's inline `overflow` before locking, restored on deactivation. */
  #previousBodyOverflow = "";
  /** Whether scroll was locked this activation (so it is only restored if applied). */
  #scrollLocked = false;
  /** Background siblings made `inert` while active, restored on deactivation. */
  #inertedSiblings: HTMLElement[] = [];
  /** Whether the modal side effects are currently applied. */
  #activeState = false;

  /** Returns the trapped element; called on every operation for the live target. */
  readonly #getContainer: () => HTMLElement;
  /** Closing/focus hooks; see {@link FocusTrapOptions}. */
  readonly #options: FocusTrapOptions;

  /**
   * @param getContainer - Returns the trapped element. Called on every operation
   *   so the live target is always used.
   * @param options - Closing/focus hooks; see {@link FocusTrapOptions}.
   */
  constructor(getContainer: () => HTMLElement, options: FocusTrapOptions = {}) {
    this.#getContainer = getContainer;
    this.#options = options;
  }

  /** Whether the trap is currently active. */
  get active(): boolean {
    return this.#activeState;
  }

  /**
   * Applies the trap: records the current focus, optionally locks background scroll
   * and makes background siblings `inert`, listens for `Tab`/`Escape`, and (unless
   * `autoFocus` is off) moves focus inside. No-ops if already active.
   */
  activate(): void {
    if (this.#activeState) return;
    this.#activeState = true;
    // Record the opener so it can be refocused on close. `<body>` (the default
    // active element when nothing is focused) is treated as "nothing", so the
    // fallback target — typically the trigger — wins in that case.
    const active = document.activeElement;
    this.#previouslyFocused =
      active instanceof HTMLElement && active !== document.body ? active : null;
    if (this.#flag(this.#options.lockScroll, true)) {
      this.#previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      this.#scrollLocked = true;
    }
    if (this.#flag(this.#options.isolate, true)) this.#isolateBackground();
    document.addEventListener("keydown", this.#onKeydown);
    if (this.#flag(this.#options.autoFocus, true)) this.#focusInitial();
  }

  /**
   * Reverts every side effect applied by {@link activate}. No-ops if inactive, so
   * a controller can call it defensively from both `close()` and `disconnect()`.
   *
   * @param restoreFocus - Move focus back to the opener (default `true`). Pass
   *   `false` on teardown (`disconnect`), where yanking focus is undesirable.
   */
  deactivate({ restoreFocus = true }: { restoreFocus?: boolean } = {}): void {
    if (!this.#activeState) return;
    this.#activeState = false;
    document.removeEventListener("keydown", this.#onKeydown);
    if (this.#scrollLocked) {
      document.body.style.overflow = this.#previousBodyOverflow;
      this.#scrollLocked = false;
    }
    this.#releaseBackground();
    if (restoreFocus) {
      const target = this.#previouslyFocused ?? this.#options.fallbackFocus?.() ?? null;
      target?.focus();
    }
  }

  /** Resolves a boolean-or-getter option, defaulting when it was not provided. */
  #flag(option: boolean | (() => boolean) | undefined, fallback: boolean): boolean {
    if (option === undefined) return fallback;
    return typeof option === "function" ? option() : option;
  }

  /** Handles `Escape` (delegated) and `Tab` (focus trap) while active. */
  readonly #onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      if (this.#options.onEscape) {
        event.preventDefault();
        this.#options.onEscape();
      }
      return;
    }
    if (event.key === "Tab") this.#trapTab(event);
  };

  /** Keeps `Tab` focus cycling within the container's focusable elements. */
  #trapTab(event: KeyboardEvent): void {
    const focusable = this.#focusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    // If focus has somehow escaped the container, pull it back to the first item.
    if (!(active instanceof Node) || !this.#getContainer().contains(active)) {
      event.preventDefault();
      first?.focus();
      return;
    }

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  /**
   * Marks every element outside the container's subtree as `inert` so background
   * content cannot be focused or reached by assistive technology, honoring the
   * `aria-modal="true"` contract. An element that was *already* `inert` is left
   * untracked so `#releaseBackground` does not wrongly clear it.
   */
  #isolateBackground(): void {
    const container = this.#getContainer();
    this.#inertedSiblings = [];
    for (const sibling of Array.from(document.body.children)) {
      if (!(sibling instanceof HTMLElement)) continue;
      if (sibling.contains(container) || sibling.inert) continue;
      sibling.inert = true;
      this.#inertedSiblings.push(sibling);
    }
  }

  /** Reverts the `inert` flags applied by `#isolateBackground`. */
  #releaseBackground(): void {
    for (const sibling of this.#inertedSiblings) {
      sibling.inert = false;
    }
    this.#inertedSiblings = [];
  }

  /** Moves focus to the initial target, the first focusable, or the container. */
  #focusInitial(): void {
    const preferred = this.#options.initialFocus?.();
    if (preferred) {
      preferred.focus();
      return;
    }
    const focusable = this.#focusableElements();
    if (focusable[0]) {
      focusable[0].focus();
      return;
    }
    const container = this.#getContainer();
    container.tabIndex = -1;
    container.focus();
  }

  /** Collects the container's currently focusable descendants in DOM order. */
  #focusableElements(): HTMLElement[] {
    return Array.from(this.#getContainer().querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => !el.hidden,
    );
  }
}
